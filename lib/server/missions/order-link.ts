import "server-only";

import type { PoolClient } from "pg";
import { checkOrderQuantity } from "../../missions-rules";
import { MissionError } from "./errors";
import { closeOpenMission } from "./missions";

/**
 * Lien entre les commandes (ventes déclarées, lot D2) et les missions d'achat en volume (lot MV1). Appelé DANS les transactions des commandes :
 *  - `requireOrderQuantity` : la quantité d'une commande (entier de 1 à 10 000, 1 par défaut) ;
 *  - `linkOrderToMission` : si le besoin de la déclaration est le besoin PORTEUR d'une mission du même acheteur, la commande lui est rattachée. La mission doit être ACTIVE et son échéance non passée ;
 *    le prix convenu ne dépasse pas le budget par unité ; ce qui est déjà proposé ou confirmé (quantité et montant) plus cette commande ne dépasse ni la quantité totale ni le budget
 *    total. La ligne de la mission est verrouillée (`FOR UPDATE`) : deux déclarations simultanées s'attendent et la limite est exacte ;
 *  - `lockMissionOfOrder` + `settleMissionAfterConfirmation` : à la CONFIRMATION d'une commande rattachée, la mission est verrouillée (avant la commande : même ordre de verrous
 *    partout), la quantité sécurisée (somme des commandes CONFIRMÉES) est recomptée, et la mission passe à « terminée » quand elle atteint la quantité totale.
 * Rien n'est automatique : aucune commande ni aucun message n'est créé par une mission.
 */

/** Quantité de la commande : absente = 1 ; sinon un entier de 1 à 10 000. */
export function requireOrderQuantity(value: unknown): number {
  if (value === undefined) return 1;
  const quantity = checkOrderQuantity(value);
  if (quantity === null) throw new MissionError("invalid_quantity");
  return quantity;
}

interface LockedMission {
  id: string;
  status: string;
  /** L'échéance n'est pas passée (horloge de la base). */
  open: boolean;
  quantity_total: number;
  unit_budget_xof: string;
  total_budget_xof: string;
}

export async function linkOrderToMission(
  client: PoolClient,
  input: { buyerId: string; demandId: string; quantity: number; priceXof: number },
): Promise<{ missionId: string | null }> {
  const found = await client.query<LockedMission>(
    `SELECT id, status, (deadline_at IS NOT NULL AND deadline_at > clock_timestamp()) AS open, quantity_total, unit_budget_xof::text AS unit_budget_xof, total_budget_xof::text AS total_budget_xof
       FROM missions WHERE demand_id = $1::uuid AND owner_id = $2::uuid FOR UPDATE`,
    [input.demandId, input.buyerId],
  );
  const mission = found.rows[0];
  if (!mission) return { missionId: null };
  // Active ET échéance non passée : après l'échéance plus aucun achat n'est ajouté, même si l'étape du runner ne l'a pas encore marquée échue.
  if (mission.status !== "active" || !mission.open) throw new MissionError("mission_not_active");
  if (input.priceXof > Number(mission.unit_budget_xof)) throw new MissionError("mission_price_over_budget");
  const engaged = await client.query<{ quantity: number; amount: string }>(
    `SELECT coalesce(sum(quantity), 0)::int AS quantity, coalesce(sum(quantity * price_amount), 0)::text AS amount
       FROM orders WHERE mission_id = $1::uuid AND status IN ('proposed', 'confirmed')`,
    [mission.id],
  );
  if (engaged.rows[0].quantity + input.quantity > mission.quantity_total) throw new MissionError("mission_quantity_exceeded");
  if (Number(engaged.rows[0].amount) + input.priceXof * input.quantity > Number(mission.total_budget_xof)) throw new MissionError("mission_budget_exceeded");
  return { missionId: mission.id };
}

/**
 * Verrouille la mission de la commande AVANT la commande elle-même (ordre des verrous : mission, puis commande ; l'annulation d'une mission verrouille de même la mission
 * d'abord). Renvoie l'identifiant de la mission, ou null si la commande n'est pas rattachée.
 */
export async function lockMissionOfOrder(client: PoolClient, orderId: string, userId: string): Promise<string | null> {
  // Un tiers (ni acheteur ni vendeur de la commande) ne verrouille jamais rien : il recevra le même 404 que pour une commande inconnue.
  const link = await client.query<{ mission_id: string | null }>(
    "SELECT mission_id FROM orders WHERE id = $1::uuid AND (buyer_id = $2::uuid OR seller_id = $2::uuid)",
    [orderId, userId],
  );
  const missionId = link.rows[0]?.mission_id ?? null;
  if (missionId === null) return null;
  await client.query("SELECT 1 FROM missions WHERE id = $1::uuid FOR UPDATE", [missionId]);
  return missionId;
}

/** Après la confirmation d'une commande rattachée (mission déjà verrouillée) : recompte et achèvement. Renvoie la quantité sécurisée et si la mission vient d'être terminée. */
export async function settleMissionAfterConfirmation(client: PoolClient, missionId: string): Promise<{ securedQuantity: number; completed: boolean }> {
  const mission = await client.query<{ id: string; owner_id: string; demand_id: string | null; status: string; quantity_total: number }>(
    "SELECT id, owner_id, demand_id, status, quantity_total FROM missions WHERE id = $1::uuid FOR UPDATE",
    [missionId],
  );
  const row = mission.rows[0];
  if (!row) return { securedQuantity: 0, completed: false };
  const secured = await client.query<{ quantity: number }>("SELECT coalesce(sum(quantity), 0)::int AS quantity FROM orders WHERE mission_id = $1::uuid AND status = 'confirmed'", [missionId]);
  const securedQuantity = secured.rows[0].quantity;
  if ((row.status === "active" || row.status === "paused") && securedQuantity >= row.quantity_total) {
    const completed = await closeOpenMission(client, { id: row.id, ownerId: row.owner_id, demandId: row.demand_id }, "completed");
    return { securedQuantity, completed };
  }
  return { securedQuantity, completed: false };
}
