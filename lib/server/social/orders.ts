import "server-only";

import type { Pool } from "pg";
import { requireTransactionPool, requireUuid } from "../catalog/validation";
import { readOfferAccess } from "../metrics/contacts";
import { readAttributedBoostId } from "../metrics/attribution";
import { roundCount, type StatCount } from "../metrics/privacy";
import { buildNotificationTitle } from "../notifications/content";
import { withPostgresTransaction } from "../postgres/client";
import { ORDERS_LIST_LIMIT, ORDER_MAX_PRICE, ORDER_MIN_PRICE, SOCIAL_TRANSACTION_TIMEOUT } from "./config";
import { SocialError } from "./errors";
import type { ParticipantRole } from "./conversations";

/**
 * Commandes (lot D2), ou ventes DÉCLARÉES : l'acheteur déclare « je l'ai acheté » avec un prix convenu (XOF, entier de 1 à 100 000 000) ; la commande est « proposée » ; le
 * vendeur la confirme ou la refuse ; l'acheteur peut l'annuler tant qu'elle n'est pas confirmée. Aucun paiement de l'objet ne passe par noma.
 *  - déclaration : mêmes conditions que le contact (`readOfferAccess`) ; UNE seule commande active (proposée ou confirmée) par (besoin, annonce) : index unique PARTIEL en base ;
 *  - transitions : seule « proposée » évolue ; elle est lue sous verrou (`FOR UPDATE`) puis écrite ; le déclencheur de la migration 0020 refuse toute autre transition ;
 *  - accès : les deux parties seulement, 404 indiscernable pour tout autre ;
 *  - attribution au boost : MÊME règle que les contacts (l'annonce a été servie sponsorisée à CE besoin dans les 7 jours précédents), figée à la déclaration ; seule une
 *    vente CONFIRMÉE compte dans les statistiques du vendeur (`readOfferSales`, comptes arrondis comme les autres mesures).
 */

export type OrderStatus = "proposed" | "confirmed" | "declined" | "cancelled";
export type OrderAction = "confirm" | "decline" | "cancel";
export const ORDER_ACTIONS: readonly OrderAction[] = Object.freeze(["confirm", "decline", "cancel"]);

const NEXT_STATUS: Readonly<Record<OrderAction, OrderStatus>> = Object.freeze({ confirm: "confirmed", decline: "declined", cancel: "cancelled" });
/** Qui peut quoi : le vendeur confirme ou refuse, l'acheteur annule. */
const ALLOWED_ROLE: Readonly<Record<OrderAction, ParticipantRole>> = Object.freeze({ confirm: "seller", decline: "seller", cancel: "buyer" });

export interface OrderView {
  id: string;
  role: ParticipantRole;
  status: OrderStatus;
  price: { amount: number; currency: "XOF" };
  title: string;
  offerId: string;
  /** Besoin d'origine : connu de l'acheteur seulement. */
  demandId: string | null;
  /** Conversation du couple (besoin, annonce), si elle existe. */
  conversationId: string | null;
  createdAt: Date;
  decidedAt: Date | null;
  canConfirm: boolean;
  canDecline: boolean;
  canCancel: boolean;
  /** L'acheteur peut marquer son besoin comme satisfait (proposé, jamais automatique) : commande confirmée et besoin encore actif. */
  canMarkDemandSatisfied: boolean;
}

export function requireOrderPrice(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < ORDER_MIN_PRICE || value > ORDER_MAX_PRICE) throw new SocialError("invalid_price");
  return value;
}

interface OrderRow {
  id: string;
  demand_id: string;
  offer_id: string;
  buyer_id: string;
  seller_id: string;
  price_amount: string;
  status: OrderStatus;
  created_at: Date;
  decided_at: Date | null;
  brand: string | null;
  model: string | null;
  variant: string | null;
  demand_status: string;
  conversation_id: string | null;
}

const ORDER_SELECT = `SELECT r.id, r.demand_id, r.offer_id, r.buyer_id, r.seller_id, r.price_amount::text AS price_amount, r.status, r.created_at, r.decided_at,
        o.brand, o.model, o.variant, d.status AS demand_status,
        (SELECT c.id FROM conversations c WHERE c.demand_id = r.demand_id AND c.offer_id = r.offer_id) AS conversation_id
   FROM orders r JOIN offers o ON o.id = r.offer_id JOIN demands d ON d.id = r.demand_id`;

function toView(row: OrderRow, userId: string): OrderView {
  const role: ParticipantRole = row.buyer_id === userId ? "buyer" : "seller";
  const proposed = row.status === "proposed";
  return {
    id: row.id,
    role,
    status: row.status,
    price: { amount: Number(row.price_amount), currency: "XOF" },
    title: buildNotificationTitle(row),
    offerId: row.offer_id,
    demandId: role === "buyer" ? row.demand_id : null,
    conversationId: row.conversation_id,
    createdAt: row.created_at,
    decidedAt: row.decided_at,
    canConfirm: proposed && role === "seller",
    canDecline: proposed && role === "seller",
    canCancel: proposed && role === "buyer",
    canMarkDemandSatisfied: role === "buyer" && row.status === "confirmed" && row.demand_status === "active",
  };
}

// ───────────── déclaration ─────────────

export async function declareOrder(input: { pool: Pool; buyerId: string; demandId: string; offerId: string; price: unknown }): Promise<OrderView> {
  const pool = requireTransactionPool(input.pool);
  const buyerId = requireUuid(input.buyerId, "buyerId").toLowerCase();
  const demandId = requireUuid(input.demandId, "demandId").toLowerCase();
  const offerId = requireUuid(input.offerId, "offerId").toLowerCase();
  const price = requireOrderPrice(input.price);
  const orderId = await withPostgresTransaction(async (client) => {
    await client.query(`SET LOCAL statement_timeout = '${SOCIAL_TRANSACTION_TIMEOUT}'`);
    // Un verrou par couple (besoin, annonce) : deux déclarations simultanées s'attendent (l'index unique partiel reste le dernier garde-fou).
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1::text), hashtext($2::text))", [`order:${demandId}`, offerId]);
    const access = await readOfferAccess(client, { viewerId: buyerId, demandId, offerId });
    if (!access.ok) throw new SocialError(access.reason === "offer_not_available" ? "offer_not_available" : "resource_not_found");
    const active = await client.query("SELECT 1 FROM orders WHERE demand_id = $1::uuid AND offer_id = $2::uuid AND status IN ('proposed', 'confirmed')", [demandId, offerId]);
    if (active.rowCount) throw new SocialError("order_active_exists");
    const boostId = await readAttributedBoostId(client, { offerId, demandId });
    try {
      const created = await client.query<{ id: string }>(
        `INSERT INTO orders (demand_id, offer_id, buyer_id, seller_id, price_amount, boost_id)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::bigint, $6::uuid) RETURNING id`,
        [demandId, offerId, buyerId, access.sellerId, price, boostId],
      );
      return created.rows[0].id;
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code === "23505") throw new SocialError("order_active_exists");
      throw error;
    }
  }, pool);
  return readOrder({ pool, userId: buyerId, orderId });
}

// ───────────── lecture ─────────────

export async function readOrder(input: { pool: Pool; userId: string; orderId: string }): Promise<OrderView> {
  const pool = requireTransactionPool(input.pool);
  const userId = requireUuid(input.userId, "userId").toLowerCase();
  const orderId = requireUuid(input.orderId, "orderId").toLowerCase();
  const rows = await pool.query<OrderRow>(`${ORDER_SELECT} WHERE r.id = $1::uuid AND (r.buyer_id = $2::uuid OR r.seller_id = $2::uuid)`, [orderId, userId]);
  if (!rows.rows[0]) throw new SocialError("resource_not_found");
  return toView(rows.rows[0], userId);
}

/** Les commandes de l'utilisateur dans le rôle demandé (les plus récentes d'abord, 50 au plus). */
export async function listOrders(input: { pool: Pool; userId: string; as: ParticipantRole }): Promise<OrderView[]> {
  const pool = requireTransactionPool(input.pool);
  const userId = requireUuid(input.userId, "userId").toLowerCase();
  const column = input.as === "buyer" ? "r.buyer_id" : "r.seller_id";
  const rows = await pool.query<OrderRow>(`${ORDER_SELECT} WHERE ${column} = $1::uuid ORDER BY r.created_at DESC, r.id DESC LIMIT $2::int`, [userId, ORDERS_LIST_LIMIT]);
  return rows.rows.map((row) => toView(row, userId));
}

// ───────────── transitions ─────────────

/**
 * Confirme, refuse (vendeur) ou annule (acheteur) une commande PROPOSÉE. Sous le verrou de la ligne : un participant seul la voit (404 sinon) ; un rôle qui n'a pas le droit
 * de l'action reçoit `action_not_allowed` ; une commande déjà décidée `order_state_conflict`.
 */
export async function transitionOrder(input: { pool: Pool; userId: string; orderId: string; action: OrderAction }): Promise<OrderView> {
  const pool = requireTransactionPool(input.pool);
  const userId = requireUuid(input.userId, "userId").toLowerCase();
  const orderId = requireUuid(input.orderId, "orderId").toLowerCase();
  if (!ORDER_ACTIONS.includes(input.action)) throw new SocialError("action_not_allowed");
  await withPostgresTransaction(async (client) => {
    await client.query(`SET LOCAL statement_timeout = '${SOCIAL_TRANSACTION_TIMEOUT}'`);
    const locked = await client.query<{ buyer_id: string; seller_id: string; status: OrderStatus }>(
      "SELECT buyer_id, seller_id, status FROM orders WHERE id = $1::uuid AND (buyer_id = $2::uuid OR seller_id = $2::uuid) FOR UPDATE",
      [orderId, userId],
    );
    const order = locked.rows[0];
    if (!order) throw new SocialError("resource_not_found");
    const role: ParticipantRole = order.buyer_id === userId ? "buyer" : "seller";
    if (ALLOWED_ROLE[input.action] !== role) throw new SocialError("action_not_allowed");
    if (order.status !== "proposed") throw new SocialError("order_state_conflict");
    await client.query(
      "UPDATE orders SET status = $2::text, decided_at = clock_timestamp(), updated_at = clock_timestamp() WHERE id = $1::uuid",
      [orderId, NEXT_STATUS[input.action]],
    );
  }, pool);
  return readOrder({ pool, userId, orderId });
}

// ───────────── statistiques du vendeur ─────────────

export interface OfferSales {
  /** Ventes déclarées ET confirmées de l'annonce, depuis l'origine : arrondies comme toutes les mesures (« moins de 5 », « environ N »). */
  confirmed: StatCount;
  /** Répartition boost / organique : seulement si l'annonce a eu un boost (sinon tout est organique et la répartition n'apprend rien). */
  attributedToBoost: StatCount | null;
  organic: StatCount | null;
}

/** Ventes confirmées de l'annonce du vendeur (404 indiscernable si l'annonce n'est pas à lui). Comptes arrondis AVANT toute sortie. */
export async function readOfferSales(input: { pool: Pool; ownerId: string; offerId: string }): Promise<OfferSales> {
  const pool = requireTransactionPool(input.pool);
  const ownerId = requireUuid(input.ownerId, "ownerId").toLowerCase();
  const offerId = requireUuid(input.offerId, "offerId").toLowerCase();
  const offer = await pool.query("SELECT 1 FROM offers WHERE id = $1::uuid AND owner_id = $2::uuid", [offerId, ownerId]);
  if (!offer.rowCount) throw new SocialError("resource_not_found");
  const counts = await pool.query<{ confirmed: number; attributed: number; boosted: boolean }>(
    `SELECT (SELECT count(*)::int FROM orders WHERE offer_id = $1::uuid AND seller_id = $2::uuid AND status = 'confirmed') AS confirmed,
            (SELECT count(*)::int FROM orders WHERE offer_id = $1::uuid AND seller_id = $2::uuid AND status = 'confirmed' AND boost_id IS NOT NULL) AS attributed,
            EXISTS (SELECT 1 FROM offer_boosts WHERE offer_id = $1::uuid) AS boosted`,
    [offerId, ownerId],
  );
  const row = counts.rows[0];
  return {
    confirmed: roundCount(row.confirmed),
    attributedToBoost: row.boosted ? roundCount(row.attributed) : null,
    organic: row.boosted ? roundCount(row.confirmed - row.attributed) : null,
  };
}
