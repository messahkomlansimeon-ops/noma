import "server-only";

import type { PoolClient } from "pg";
import { evaluateExternalForDemand } from "../external/matching";
import { productKeyOf, productKeyString } from "../external/product-key";
import { loadSourceDemand } from "../matching/service";

/**
 * Relevé de l'EXISTANT d'un besoin (lots RA1 et RA1-bis) : les annonces d'autres sites DÉJÀ visibles et compatibles avec le besoin sont marquées « vues » (`baseline`), SANS notification.
 * Appelé à l'activation de l'option (si la surveillance du besoin a une collecte RÉUSSIE de moins de 48 h), par le balayage quand la première collecte récente a eu lieu, et quand le besoin
 * est modifié (comme N1 : modifier un besoin ne notifie pas l'existant).
 *
 * `cutoff` : l'instant avant lequel une annonce est « existante » (`active_search_state.baseline_cutoff_at`) ; défaut : `now` (tout ce qui est visible maintenant est de l'existant). Seules les
 * annonces dont `first_seen_at` ne dépasse pas `cutoff` sont marquées : après la modification d'un besoin dont la clé produit ne change pas, `cutoff` est le dernier horizon de balayage, de sorte
 * que les annonces vues pour la première fois DEPUIS (arrivées pendant une pause, par exemple) restent nouvelles. Renvoie le nombre d'annonces marquées.
 */
export async function takeBaseline(client: PoolClient, demandOwnerId: string, demandId: string, now: Date, cutoff: Date = now): Promise<number> {
  const demand = await loadSourceDemand(demandOwnerId, demandId, client);
  const evaluation = await evaluateExternalForDemand(client, demand, now);
  const ids = [...new Set(evaluation.candidates.filter((candidate) => candidate.row.first_seen_at.getTime() <= cutoff.getTime()).map((candidate) => candidate.row.id))];
  if (ids.length > 0) {
    await client.query(
      "INSERT INTO active_search_seen (demand_id, listing_id, reason) SELECT $1::uuid, unnest($2::uuid[]), 'baseline' ON CONFLICT (demand_id, listing_id) DO NOTHING",
      [demandId, ids],
    );
  }
  // Filigrane du balayage : la dernière collecte de la surveillance lue AVANT les annonces (jamais l'horloge du processus) ; une collecte plus récente rend le besoin à balayer.
  const watermark = evaluation.watch?.last_run_at ?? null;
  const key = productKeyOf({ category: demand.category, brand: demand.brand, model: demand.model, variant: demand.variant, location: demand.location });
  await client.query(
    `INSERT INTO active_search_state (demand_id, baseline_pending, baseline_taken_at, baseline_cutoff_at, product_key, content_version, scanned_at, scan_horizon_at, updated_at)
     VALUES ($1::uuid, FALSE, $2::timestamptz, $5::timestamptz, $6, $3::int, $4::timestamptz, $2::timestamptz, $2::timestamptz)
     ON CONFLICT (demand_id) DO UPDATE
       SET baseline_pending = FALSE, baseline_taken_at = $2::timestamptz, baseline_cutoff_at = $5::timestamptz, product_key = $6, content_version = $3::int, scanned_at = $4::timestamptz,
           scan_horizon_at = $2::timestamptz, updated_at = $2::timestamptz`,
    [demandId, now, demand.contentVersion, watermark, cutoff, key === null ? null : productKeyString(key)],
  );
  return ids.length;
}

/**
 * Relevé EN ATTENTE (lot RA1-bis) : le besoin vient de changer de clé produit (ou d'être activé) et la surveillance de sa clé n'a pas de collecte réussie récente : une liste d'annonces
 * vide serait faussement « complète ». Le relevé attend la première collecte réussie ; rien n'est marqué, rien ne notifie d'ici là.
 */
export async function markBaselinePending(client: PoolClient, demandId: string, keyText: string | null, contentVersion: number, now: Date | string): Promise<void> {
  await client.query(
    `INSERT INTO active_search_state (demand_id, baseline_pending, baseline_taken_at, baseline_cutoff_at, product_key, content_version, updated_at)
     VALUES ($1::uuid, TRUE, NULL, NULL, $2, $3::int, $4::timestamptz)
     ON CONFLICT (demand_id) DO UPDATE
       SET baseline_pending = TRUE, baseline_taken_at = NULL, baseline_cutoff_at = NULL, product_key = $2, content_version = $3::int, scanned_at = NULL, updated_at = $4::timestamptz`,
    [demandId, keyText, contentVersion, now],
  );
}
