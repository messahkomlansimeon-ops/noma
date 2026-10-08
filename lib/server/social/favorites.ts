import "server-only";

import type { Pool } from "pg";
import { requireTransactionPool, requireUuid } from "../catalog/validation";
import { readCoverPhotoIdsSafely } from "../media/read";
import { readOfferAccess } from "../metrics/contacts";
import {
  MATCHING_CURRENT_CLOCK_CTE,
  MATCHING_FRESHNESS_FROM,
  buildMatchingFreshnessPredicate,
  resolveMatchingFreshnessParams,
} from "../matching/persistence";
import { buildNotificationPrice, buildNotificationTitle, type NotificationPrice } from "../notifications/content";
import { withPostgresTransaction } from "../postgres/client";
import { FAVORITES_LIMIT, FAVORITES_LOCK_NAMESPACE, SOCIAL_TRANSACTION_TIMEOUT } from "./config";
import { SocialError } from "./errors";

/**
 * Favoris (lot D2) : une annonce gardée de côté par l'acheteur, avec le besoin d'origine (le lien rouvre la fiche DANS ce contexte). On ne met en favori qu'une annonce qu'on a
 * le droit de voir : MÊME contrôle d'accès que la fiche et le contact (`readOfferAccess` : correspondance confirmée et fraîche du besoin de l'acheteur, annonce en ligne), sinon
 * `resource_not_found` (404 indiscernable). Au plus `FAVORITES_LIMIT` par utilisateur, compté sous un verrou consultatif par utilisateur (la limite est exacte).
 */

export interface FavoriteItem {
  offerId: string;
  demandId: string;
  title: string;
  price: NotificationPrice | null;
  /** Annonce en ligne (publiée et pas indisponible) : sinon l'écran dit « n'est plus disponible ». */
  available: boolean;
  /** La fiche peut s'ouvrir dans le contexte du besoin d'origine (correspondance encore confirmée et fraîche). */
  openable: boolean;
  createdAt: Date;
  /** Lot PH1 : photo de couverture, seulement pour une annonce en ligne dont la fiche s'ouvre (le fichier n'est servi qu'à qui a accès à l'annonce) ; absente sinon. */
  coverPhotoId?: string;
}

export async function addFavorite(input: { pool: Pool; userId: string; demandId: string; offerId: string }): Promise<{ created: boolean }> {
  const pool = requireTransactionPool(input.pool);
  const userId = requireUuid(input.userId, "userId").toLowerCase();
  const demandId = requireUuid(input.demandId, "demandId").toLowerCase();
  const offerId = requireUuid(input.offerId, "offerId").toLowerCase();
  return withPostgresTransaction(async (client) => {
    await client.query(`SET LOCAL statement_timeout = '${SOCIAL_TRANSACTION_TIMEOUT}'`);
    await client.query("SELECT pg_advisory_xact_lock($1::int, hashtext($2::text))", [FAVORITES_LOCK_NAMESPACE, userId]);
    const access = await readOfferAccess(client, { viewerId: userId, demandId, offerId });
    if (!access.ok) throw new SocialError("resource_not_found");
    const existing = await client.query("SELECT 1 FROM favorites WHERE user_id = $1::uuid AND offer_id = $2::uuid", [userId, offerId]);
    if (existing.rowCount) return { created: false };
    const total = await client.query<{ n: number }>("SELECT count(*)::int AS n FROM favorites WHERE user_id = $1::uuid", [userId]);
    if (total.rows[0].n >= FAVORITES_LIMIT) throw new SocialError("favorites_limit");
    await client.query("INSERT INTO favorites (user_id, offer_id, demand_id) VALUES ($1::uuid, $2::uuid, $3::uuid)", [userId, offerId, demandId]);
    return { created: true };
  }, pool);
}

/** Retire le favori de l'utilisateur (idempotent : un favori absent n'est pas une erreur). */
export async function removeFavorite(input: { pool: Pool; userId: string; offerId: string }): Promise<{ removed: boolean }> {
  const pool = requireTransactionPool(input.pool);
  const userId = requireUuid(input.userId, "userId").toLowerCase();
  const offerId = requireUuid(input.offerId, "offerId").toLowerCase();
  const result = await pool.query("DELETE FROM favorites WHERE user_id = $1::uuid AND offer_id = $2::uuid", [userId, offerId]);
  return { removed: (result.rowCount ?? 0) > 0 };
}

interface FavoriteRow {
  offer_id: string;
  demand_id: string;
  brand: string | null;
  model: string | null;
  variant: string | null;
  price_amount: string | null;
  price_currency: string | null;
  available: boolean;
  created_at: Date;
}

/** Favoris de l'utilisateur, les plus récents d'abord (200 au plus). Le titre et le prix sont ceux de la liste blanche des notifications (jamais de texte libre ni de numéro). */
export async function listFavorites(input: { pool: Pool; userId: string }): Promise<FavoriteItem[]> {
  const pool = requireTransactionPool(input.pool);
  const userId = requireUuid(input.userId, "userId").toLowerCase();
  const rows = await pool.query<FavoriteRow>(
    `SELECT f.offer_id, f.demand_id, o.brand, o.model, o.variant, o.price_amount::text AS price_amount, o.price_currency,
            (o.status = 'published' AND o.availability_status IS DISTINCT FROM 'unavailable') AS available, f.created_at
       FROM favorites f JOIN offers o ON o.id = f.offer_id
      WHERE f.user_id = $1::uuid
      ORDER BY f.created_at DESC, f.offer_id DESC
      LIMIT $2::int`,
    [userId, FAVORITES_LIMIT],
  );
  if (rows.rows.length === 0) return [];
  const freshness = buildMatchingFreshnessPredicate(resolveMatchingFreshnessParams(), 3);
  const open = await pool.query<{ demand_id: string; offer_id: string }>(
    `WITH ${MATCHING_CURRENT_CLOCK_CTE}
     SELECT DISTINCT e.demand_id, e.offer_id
       FROM ${MATCHING_FRESHNESS_FROM}
       JOIN unnest($1::uuid[], $2::uuid[]) AS pair(demand_id, offer_id) ON pair.demand_id = e.demand_id AND pair.offer_id = e.offer_id
      WHERE d.owner_id = $${freshness.values.length + 3}::uuid AND e.is_confirmed_match = TRUE
        AND ${freshness.conditions.join("\n        AND ")}`,
    [rows.rows.map((row) => row.demand_id), rows.rows.map((row) => row.offer_id), ...freshness.values, userId],
  );
  const openable = new Set(open.rows.map((row) => `${row.demand_id}:${row.offer_id}`));
  const covers = await readCoverPhotoIdsSafely(pool, rows.rows.filter((row) => row.available && openable.has(`${row.demand_id}:${row.offer_id}`)).map((row) => row.offer_id));
  return rows.rows.map((row) => ({
    offerId: row.offer_id,
    demandId: row.demand_id,
    title: buildNotificationTitle(row),
    // Lot D3 : une annonce qui n'est plus disponible n'affiche plus de prix (il ne serait plus celui d'une annonce qu'on peut acheter).
    price: !row.available || row.price_amount === null ? null : buildNotificationPrice(Number(row.price_amount), row.price_currency),
    available: row.available,
    openable: openable.has(`${row.demand_id}:${row.offer_id}`),
    createdAt: row.created_at,
    ...(covers.has(row.offer_id) ? { coverPhotoId: covers.get(row.offer_id) as string } : {}),
  }));
}
