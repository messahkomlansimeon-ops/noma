import "server-only";

import type { Pool } from "pg";
import { withReadOnlySnapshot } from "../boost/boosts";
import { requireTransactionPool } from "../catalog/validation";
import { roundToBase } from "../metrics/privacy";

/**
 * Lecture d'administration de la RECHERCHE ACTIVE (lot RA1) : nombre d'options en vigueur ARRONDI À 5 PRÈS (jamais un compte exact : même règle que les abonnés et les statistiques du
 * vendeur, `roundToBase`) et revenus du mois (NETS : achats − remboursements, lus dans le GRAND LIVRE, compte `active_search_revenue`). Le mois est le mois civil UTC courant.
 * Une option est « en vigueur » si sa période couvre maintenant, qu'elle n'est ni remboursée ni arrêtée et que son besoin est actif. Voir RECHERCHE-ACTIVE.md.
 */

export const ACTIVE_SEARCH_ROUNDING_BASE = 5;

export interface AdminActiveSearchOverview {
  /** Besoins avec une option en vigueur, arrondis à 5 près. */
  activeApproximate: number;
  month: { startsAt: Date; endsAt: Date };
  /** Revenus NETS du mois (achats − remboursements), XOF. */
  revenueXof: bigint;
  readAt: Date;
}

export async function readAdminActiveSearchOverview(input: { pool: Pool }): Promise<AdminActiveSearchOverview> {
  const pool = requireTransactionPool(input.pool);
  return withReadOnlySnapshot(pool, async (client) => {
    const month = await client.query<{ starts: Date; ends: Date; at: Date }>(
      `SELECT date_trunc('month', clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS starts,
              (date_trunc('month', clock_timestamp() AT TIME ZONE 'UTC') + INTERVAL '1 month') AT TIME ZONE 'UTC' AS ends,
              clock_timestamp() AS at`,
    );
    const { starts, ends, at } = month.rows[0];
    const live = await client.query<{ n: number }>(
      `SELECT count(DISTINCT p.demand_id)::int AS n
         FROM active_search_purchases p JOIN demands d ON d.id = p.demand_id
        WHERE p.status = 'active' AND p.refunded_at IS NULL AND p.starts_at <= $1::timestamptz AND p.ends_at > $1::timestamptz
          AND d.status = 'active' AND d.archived_at IS NULL`,
      [at],
    );
    const ledger = await client.query<{ total: string }>(
      `SELECT COALESCE(sum(e.amount), 0)::text AS total
         FROM wallet_entries e JOIN wallet_accounts a ON a.id = e.account_id
        WHERE a.kind = 'active_search_revenue' AND e.created_at >= $1::timestamptz AND e.created_at < $2::timestamptz`,
      [starts, ends],
    );
    return {
      activeApproximate: roundToBase(live.rows[0].n, ACTIVE_SEARCH_ROUNDING_BASE),
      month: { startsAt: starts, endsAt: ends },
      revenueXof: BigInt(ledger.rows[0].total),
      readAt: at,
    };
  });
}
