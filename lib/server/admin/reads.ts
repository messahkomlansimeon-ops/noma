import "server-only";

import { Pool } from "pg";
import { requireTransactionPool } from "../catalog/validation";
import {
  MATCHING_CURRENT_CLOCK_CTE,
  MATCHING_FRESHNESS_FROM,
  buildMatchingFreshnessPredicate,
  resolveMatchingFreshnessParams,
} from "../matching/persistence";
import { readMatchingStatus } from "../matching/status";

/**
 * Lectures de l'administration (lot D2) : tableau de bord (chiffres réels), liste paginée des vendeurs (numéros MASQUÉS sauf les deux derniers chiffres, masqués DANS la requête :
 * le numéro complet ne quitte jamais la base pour cette lecture), journal d'administration, réglages du boost par catégorie (lecture seule).
 */

export const ADMIN_CONTRACT_VERSION = "admin/v1" as const;
export const ADMIN_VENDORS_PAGE_DEFAULT = 20;
export const ADMIN_VENDORS_PAGE_MAX = 50;
export const ADMIN_ACTIONS_LIMIT = 20;

/** Masque SQL d'un numéro E.164 : « + », des points, puis les DEUX derniers chiffres. */
export const MASKED_PHONE_SQL = (column: string): string => `(left(${column}, 1) || repeat('•', greatest(length(${column}) - 3, 0)) || right(${column}, 2))`;

export interface AdminSummary {
  accounts: { total: number; active: number; suspended: number };
  offers: { total: number; byStatus: Record<string, number> };
  activeDemands: number;
  confirmedMatches: number;
  activeBoosts: number;
  credits: { circulationXof: number; topupsTodayCount: number; topupsTodayXof: number };
  conversations: { total: number; messagesToday: number };
  orders: { confirmed: number; proposed: number };
  worker: {
    schemaReady: boolean;
    healthy: boolean;
    pendingEvents: number;
    pendingJobs: number;
    runningJobs: number;
    deadLetter: number;
    warnings: Array<{ code: string; message: string }>;
    lastCompletedAt: string | null;
  };
  readAt: string;
}

function safeNumber(value: string | number | bigint | null): number {
  const parsed = Number(value ?? 0);
  return Number.isSafeInteger(parsed) ? parsed : 0;
}

export async function readAdminSummary(input: { pool: Pool }): Promise<AdminSummary> {
  const pool = requireTransactionPool(input.pool);
  const freshness = buildMatchingFreshnessPredicate(resolveMatchingFreshnessParams(), 1);
  const counts = await pool.query<Record<string, string | number | null>>(
    `WITH ${MATCHING_CURRENT_CLOCK_CTE}
     SELECT
       (SELECT count(*) FROM users) AS accounts_total,
       (SELECT count(*) FROM users WHERE status = 'active') AS accounts_active,
       (SELECT count(*) FROM users WHERE status = 'suspended') AS accounts_suspended,
       (SELECT count(*) FROM demands WHERE status = 'active' AND archived_at IS NULL) AS active_demands,
       (SELECT count(*) FROM ${MATCHING_FRESHNESS_FROM} WHERE e.is_confirmed_match = TRUE AND ${freshness.conditions.join(" AND ")}) AS confirmed_matches,
       (SELECT count(*) FROM offer_boosts WHERE status = 'active' AND starts_at <= clock_timestamp() AND ends_at > clock_timestamp()) AS active_boosts,
       (SELECT COALESCE(sum(balance), 0) FROM wallet_accounts WHERE kind = 'user') AS credits_circulation,
       (SELECT count(*) FROM payment_intents WHERE status = 'succeeded' AND completed_at >= (date_trunc('day', clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')) AS topups_count,
       (SELECT COALESCE(sum(amount_xof), 0) FROM payment_intents WHERE status = 'succeeded' AND completed_at >= (date_trunc('day', clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')) AS topups_xof,
       (SELECT count(*) FROM conversations) AS conversations_total,
       (SELECT count(*) FROM messages WHERE created_at >= (date_trunc('day', clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')) AS messages_today,
       (SELECT count(*) FROM orders WHERE status = 'confirmed') AS orders_confirmed,
       (SELECT count(*) FROM orders WHERE status = 'proposed') AS orders_proposed,
       clock_timestamp() AS read_at`,
    freshness.values,
  );
  const row = counts.rows[0];
  const offers = await pool.query<{ status: string; n: number }>("SELECT status, count(*)::int AS n FROM offers GROUP BY status ORDER BY status");
  const byStatus: Record<string, number> = {};
  for (const entry of offers.rows) byStatus[entry.status] = entry.n;
  const status = await readMatchingStatus({ pool });
  const jobs = (name: string): number => status.jobs.byTypeAndStatus.filter((entry) => entry.status === name).reduce((sum, entry) => sum + entry.count, 0);
  const pendingEvents = Object.values(status.outbox.pendingByType).reduce((sum, value) => sum + value, 0);
  return {
    accounts: { total: safeNumber(row.accounts_total), active: safeNumber(row.accounts_active), suspended: safeNumber(row.accounts_suspended) },
    offers: { total: Object.values(byStatus).reduce((sum, value) => sum + value, 0), byStatus },
    activeDemands: safeNumber(row.active_demands),
    confirmedMatches: safeNumber(row.confirmed_matches),
    activeBoosts: safeNumber(row.active_boosts),
    credits: { circulationXof: safeNumber(row.credits_circulation), topupsTodayCount: safeNumber(row.topups_count), topupsTodayXof: safeNumber(row.topups_xof) },
    conversations: { total: safeNumber(row.conversations_total), messagesToday: safeNumber(row.messages_today) },
    orders: { confirmed: safeNumber(row.orders_confirmed), proposed: safeNumber(row.orders_proposed) },
    worker: {
      schemaReady: status.schemaReady,
      healthy: status.schemaReady && status.warnings.length === 0,
      pendingEvents,
      pendingJobs: jobs("pending"),
      runningJobs: jobs("running"),
      deadLetter: status.jobs.deadLetter.count,
      warnings: status.warnings.map((warning) => ({ code: warning.code, message: warning.message })),
      lastCompletedAt: status.jobs.lastCompletedAt,
    },
    readAt: (row.read_at as unknown as Date).toISOString(),
  };
}

// ───────────── vendeurs ─────────────

export interface AdminVendor {
  id: string;
  /** Numéro masqué : seuls les deux derniers chiffres restent visibles. */
  maskedPhone: string | null;
  offerCount: number;
  publishedCount: number;
  createdAt: Date;
  status: "active" | "suspended" | "archived";
  isAdmin: boolean;
}

/** Les vendeurs (comptes qui ont au moins une annonce), les plus récents d'abord. */
export async function listAdminVendors(input: { pool: Pool; limit?: number; offset?: number }): Promise<{ vendors: AdminVendor[]; total: number }> {
  const pool = requireTransactionPool(input.pool);
  const limit = input.limit ?? ADMIN_VENDORS_PAGE_DEFAULT;
  const offset = input.offset ?? 0;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > ADMIN_VENDORS_PAGE_MAX) throw new RangeError("limit hors bornes.");
  if (!Number.isSafeInteger(offset) || offset < 0) throw new RangeError("offset hors bornes.");
  const rows = await pool.query<{
    id: string;
    masked_phone: string | null;
    offer_count: number;
    published_count: number;
    created_at: Date;
    status: "active" | "suspended" | "archived";
    is_admin: boolean;
    total: number;
  }>(
    `SELECT u.id, ${MASKED_PHONE_SQL("p.phone_e164")} AS masked_phone,
            (SELECT count(*)::int FROM offers o WHERE o.owner_id = u.id AND o.status <> 'archived') AS offer_count,
            (SELECT count(*)::int FROM offers o WHERE o.owner_id = u.id AND o.status = 'published') AS published_count,
            u.created_at, u.status, u.is_admin, count(*) OVER ()::int AS total
       FROM users u LEFT JOIN phone_identities p ON p.user_id = u.id AND p.verified_at IS NOT NULL
      WHERE EXISTS (SELECT 1 FROM offers o WHERE o.owner_id = u.id)
      ORDER BY u.created_at DESC, u.id DESC
      LIMIT $1::int OFFSET $2::int`,
    [limit, offset],
  );
  let total = rows.rows[0]?.total ?? 0;
  if (rows.rows.length === 0 && offset > 0) {
    total = (await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM users u WHERE EXISTS (SELECT 1 FROM offers o WHERE o.owner_id = u.id)")).rows[0].n;
  }
  return {
    vendors: rows.rows.map((row) => ({
      id: row.id,
      maskedPhone: row.masked_phone,
      offerCount: row.offer_count,
      publishedCount: row.published_count,
      createdAt: row.created_at,
      status: row.status,
      isAdmin: row.is_admin,
    })),
    total,
  };
}

// ───────────── journal ─────────────

export interface AdminActionEntry {
  id: string;
  action: "suspend_user" | "reactivate_user" | "grant_admin";
  source: "admin_ui" | "command";
  /** Administrateur (numéro masqué) ; null pour la commande `admin:grant`. */
  byMaskedPhone: string | null;
  targetMaskedPhone: string | null;
  createdAt: Date;
}

export async function listAdminActions(input: { pool: Pool; limit?: number }): Promise<AdminActionEntry[]> {
  const pool = requireTransactionPool(input.pool);
  const limit = input.limit ?? ADMIN_ACTIONS_LIMIT;
  const rows = await pool.query<{ id: string; action: AdminActionEntry["action"]; source: AdminActionEntry["source"]; by_phone: string | null; target_phone: string | null; created_at: Date }>(
    `SELECT a.id, a.action, a.source, ${MASKED_PHONE_SQL("pa.phone_e164")} AS by_phone, ${MASKED_PHONE_SQL("pt.phone_e164")} AS target_phone, a.created_at
       FROM admin_actions a
       LEFT JOIN phone_identities pa ON pa.user_id = a.admin_id AND pa.verified_at IS NOT NULL
       LEFT JOIN phone_identities pt ON pt.user_id = a.target_user_id AND pt.verified_at IS NOT NULL
      ORDER BY a.created_at DESC, a.id DESC
      LIMIT $1::int`,
    [limit],
  );
  return rows.rows.map((row) => ({ id: row.id, action: row.action, source: row.source, byMaskedPhone: row.by_phone, targetMaskedPhone: row.target_phone, createdAt: row.created_at }));
}

// ───────────── réglages du boost ─────────────

export interface AdminBoostSettings {
  /** « default » ou une catégorie (minuscules). */
  key: string;
  slotRatio: number | null;
  minSlots: number | null;
  maxSlots: number | null;
  maxActivePerSeller: number | null;
  maxSellerSlotShare: number | null;
  maxPromotedShare: number | null;
  minRelevance: number | null;
  pricingVersion: number | null;
  baseAmountXof: number | null;
  minAmountXof: number | null;
  maxAmountXof: number | null;
  quoteValiditySeconds: number | null;
}

const toNumber = (value: string | number | null): number | null => (value === null ? null : Number(value));

/** Réglages du boost (places et prix) par catégorie, lecture seule : la ligne « default » d'abord, puis les catégories qui la surchargent. */
export async function readAdminBoostSettings(input: { pool: Pool }): Promise<AdminBoostSettings[]> {
  const pool = requireTransactionPool(input.pool);
  const rows = await pool.query<Record<string, string | number | null>>(
    `WITH latest AS (SELECT DISTINCT ON (key) * FROM boost_pricing_settings ORDER BY key, version DESC)
     SELECT COALESCE(s.key, p.key) AS key, s.slot_ratio::text AS slot_ratio, s.min_slots, s.max_slots, s.max_active_per_seller,
            s.max_seller_slot_share::text AS max_seller_slot_share, s.max_promoted_share::text AS max_promoted_share, s.min_relevance::text AS min_relevance,
            p.version AS pricing_version, p.base_amount, p.min_amount, p.max_amount, p.quote_validity_seconds
       FROM boost_settings s FULL OUTER JOIN latest p ON p.key = s.key
      ORDER BY (COALESCE(s.key, p.key) = 'default') DESC, COALESCE(s.key, p.key)`,
  );
  return rows.rows.map((row) => ({
    key: String(row.key),
    slotRatio: toNumber(row.slot_ratio),
    minSlots: toNumber(row.min_slots),
    maxSlots: toNumber(row.max_slots),
    maxActivePerSeller: toNumber(row.max_active_per_seller),
    maxSellerSlotShare: toNumber(row.max_seller_slot_share),
    maxPromotedShare: toNumber(row.max_promoted_share),
    minRelevance: toNumber(row.min_relevance),
    pricingVersion: toNumber(row.pricing_version),
    baseAmountXof: toNumber(row.base_amount),
    minAmountXof: toNumber(row.min_amount),
    maxAmountXof: toNumber(row.max_amount),
    quoteValiditySeconds: toNumber(row.quote_validity_seconds),
  }));
}
