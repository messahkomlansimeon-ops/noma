import "server-only";

import type { Pool } from "pg";
import { CatalogNotFoundError, CatalogValidationError } from "../catalog/errors";
import { requireTransactionPool, requireUuid } from "../catalog/validation";
import { withPostgresTransaction, type SqlExecutor } from "../postgres/client";

/**
 * Avis DANS l'application sur l'abonnement (lot PRO1) : renouvellement refusé (délai de grâce), abonnement terminé, annonces mises en pause, annonces remises en ligne. Écrits dans la MÊME transaction que le
 * changement qu'ils annoncent (un seul avis par événement : clé `dedupe_key` unique). Le texte est construit à la lecture par l'écran à partir du code et du nombre : aucun texte libre.
 */

export const SUBSCRIPTION_NOTICE_CODES = ["renewal_failed", "subscription_ended", "listings_paused", "listings_restored"] as const;
export type SubscriptionNoticeCode = (typeof SUBSCRIPTION_NOTICE_CODES)[number];

export interface SubscriptionNotice {
  id: string;
  code: SubscriptionNoticeCode;
  /** `listings_paused` et `listings_restored` seulement : nombre d'annonces mises en pause, ou remises en ligne. */
  listingCount: number | null;
  /**
   * `listings_restored` seulement (lot T3) : ce qui est TOUJOURS en pause À LA LECTURE (annonces non archivées) : `planLimit` = mises en pause par la fin d'un abonnement et pas (ou pas encore) remises en ligne,
   * faute de place dans la limite du plan ou parce qu'elles ne passent plus la règle de publication ; `byOwner` = mises en pause par le vendeur lui-même (jamais remises en ligne par le système). `null` pour les autres avis.
   */
  stillPaused: { planLimit: number; byOwner: number } | null;
  createdAt: Date;
  readAt: Date | null;
}

export const SUBSCRIPTION_NOTICES_LIMIT = 20;

/** Écrit l'avis (une seule fois par `dedupeKey`). */
export async function insertSubscriptionNotice(
  executor: SqlExecutor,
  input: { userId: string; code: SubscriptionNoticeCode; dedupeKey: string; listingCount?: number },
): Promise<void> {
  await executor.query(
    `INSERT INTO subscription_notices (user_id, code, listing_count, dedupe_key)
     VALUES ($1::uuid, $2, $3::int, $4)
     ON CONFLICT (user_id, dedupe_key) DO NOTHING`,
    [input.userId, input.code, input.listingCount ?? null, input.dedupeKey],
  );
}

interface NoticeRow {
  id: string;
  code: SubscriptionNoticeCode;
  listing_count: number | null;
  created_at: Date;
  read_at: Date | null;
}

/** Les avis les plus récents de l'utilisateur (20 au plus) et le nombre de non lus. */
export async function listSubscriptionNotices(executor: SqlExecutor, userId: string): Promise<{ notices: SubscriptionNotice[]; unreadCount: number }> {
  const user = requireUuid(userId, "userId").toLowerCase();
  const rows = await executor.query<NoticeRow>(
    `SELECT id, code, listing_count, created_at, read_at FROM subscription_notices
      WHERE user_id = $1::uuid ORDER BY created_at DESC, id DESC LIMIT $2::int`,
    [user, SUBSCRIPTION_NOTICES_LIMIT],
  );
  const unread = await executor.query<{ n: number }>("SELECT count(*)::int AS n FROM subscription_notices WHERE user_id = $1::uuid AND read_at IS NULL", [user]);
  // Lot T3 : l'avis « annonces remises en ligne » dit aussi combien d'annonces restent en pause et pourquoi (lecture unique, seulement si un tel avis est affiché).
  let stillPaused: { planLimit: number; byOwner: number } | null = null;
  if (rows.rows.some((row) => row.code === "listings_restored")) {
    const paused = await executor.query<{ plan_limit: number; by_owner: number }>(
      `SELECT count(*) FILTER (WHERE paused_reason = 'plan_limit')::int AS plan_limit, count(*) FILTER (WHERE paused_reason IS NULL)::int AS by_owner
         FROM offers WHERE owner_id = $1::uuid AND status = 'paused' AND archived_at IS NULL`,
      [user],
    );
    stillPaused = { planLimit: paused.rows[0].plan_limit, byOwner: paused.rows[0].by_owner };
  }
  return {
    notices: rows.rows.map((row) => ({
      id: row.id, code: row.code, listingCount: row.listing_count, stillPaused: row.code === "listings_restored" ? stillPaused : null, createdAt: row.created_at, readAt: row.read_at,
    })),
    unreadCount: unread.rows[0].n,
  };
}

/** Marque comme lus des avis DE L'UTILISATEUR : `ids` (tous à lui, sinon aucun n'est touché et l'erreur est « introuvable ») ou `all`. Idempotent. Renvoie les non lus restants. */
export async function markSubscriptionNoticesRead(input: { pool: Pool; userId: string; target: { all: true } | { ids: readonly string[] } }): Promise<{ unreadCount: number }> {
  const pool = requireTransactionPool(input.pool);
  const userId = requireUuid(input.userId, "userId").toLowerCase();
  let ids: string[] | null = null;
  if (!("all" in input.target)) {
    if (!Array.isArray(input.target.ids) || input.target.ids.length < 1 || input.target.ids.length > 50) throw new CatalogValidationError("ids doit contenir de 1 à 50 identifiants.");
    ids = [...new Set(input.target.ids.map((id) => requireUuid(id, "id").toLowerCase()))];
  }
  return withPostgresTransaction(async (client) => {
    if (ids === null) {
      await client.query("UPDATE subscription_notices SET read_at = clock_timestamp() WHERE user_id = $1::uuid AND read_at IS NULL", [userId]);
    } else {
      const owned = await client.query<{ n: number }>("SELECT count(*)::int AS n FROM subscription_notices WHERE user_id = $1::uuid AND id = ANY($2::uuid[])", [userId, ids]);
      if (owned.rows[0].n !== ids.length) throw new CatalogNotFoundError("avis");
      await client.query("UPDATE subscription_notices SET read_at = clock_timestamp() WHERE user_id = $1::uuid AND id = ANY($2::uuid[]) AND read_at IS NULL", [userId, ids]);
    }
    const unread = await client.query<{ n: number }>("SELECT count(*)::int AS n FROM subscription_notices WHERE user_id = $1::uuid AND read_at IS NULL", [userId]);
    return { unreadCount: unread.rows[0].n };
  }, pool);
}
