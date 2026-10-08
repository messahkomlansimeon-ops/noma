import "server-only";

import type { Pool } from "pg";
import { requireTransactionPool } from "../catalog/validation";
import { withReadOnlySnapshot } from "../boost/boosts";
import { roundToBase } from "../metrics/privacy";
import { readAllPlanVersions, type PlanVersionView } from "./plans";

/**
 * Lectures d'administration de l'offre Pro (lot PRO1) : versions des plans (lecture seule), nombre d'abonnés ARRONDI À 5 PRÈS (jamais un compte exact : même règle d'arrondi que les
 * statistiques du vendeur, `roundToBase`), revenus d'abonnement du mois (net : débits − remboursements, lus dans le GRAND LIVRE) et mouvement des crédits promotionnels du mois.
 * Le mois est le mois civil UTC courant. PRIX PROVISOIRES : les plans de départ attendent une décision du fondateur. Voir OFFRE-PRO.md.
 */

export const SUBSCRIBER_ROUNDING_BASE = 5;

export interface AdminPlansOverview {
  plans: Array<{ code: string; versions: PlanVersionView[] }>;
  /** Abonnés en vigueur (actifs ou en délai de grâce) par plan, arrondis à 5 près. */
  subscribers: Array<{ planCode: string; approximateCount: number }>;
  totalSubscribersApproximate: number;
  month: { startsAt: Date; endsAt: Date };
  /** Revenus d'abonnement NETS du mois (débits − remboursements), XOF. */
  subscriptionRevenueXof: bigint;
  /** Crédits promotionnels du mois, XOF : émis, dépensés (nets des restitutions), expirés ou perdus. */
  promoIssuedXof: bigint;
  promoSpentXof: bigint;
  promoExpiredXof: bigint;
  readAt: Date;
}

export async function readAdminPlansOverview(input: { pool: Pool }): Promise<AdminPlansOverview> {
  const pool = requireTransactionPool(input.pool);
  return withReadOnlySnapshot(pool, async (client) => {
    const versions = await readAllPlanVersions(client);
    const grouped = new Map<string, PlanVersionView[]>();
    for (const version of versions) grouped.set(version.planCode, [...(grouped.get(version.planCode) ?? []), version]);
    const counts = await client.query<{ code: string; n: number }>(
      `SELECT p.code, count(s.id)::int AS n
         FROM plans p LEFT JOIN subscriptions s ON s.plan_id = p.id AND s.status IN ('active', 'past_due')
        GROUP BY p.code ORDER BY p.code`,
    );
    const month = await client.query<{ starts: Date; ends: Date; at: Date }>(
      `SELECT date_trunc('month', clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS starts,
              (date_trunc('month', clock_timestamp() AT TIME ZONE 'UTC') + INTERVAL '1 month') AT TIME ZONE 'UTC' AS ends,
              clock_timestamp() AS at`,
    );
    const { starts, ends } = month.rows[0];
    const ledger = await client.query<{ kind: string; total: string }>(
      `SELECT a.kind, COALESCE(sum(e.amount), 0)::text AS total
         FROM wallet_entries e JOIN wallet_accounts a ON a.id = e.account_id
        WHERE a.kind IN ('subscription_revenue', 'promo_issuance', 'promo_consumed', 'promo_expired')
          AND e.created_at >= $1::timestamptz AND e.created_at < $2::timestamptz
        GROUP BY a.kind`,
      [starts, ends],
    );
    const total = (kind: string): bigint => BigInt(ledger.rows.find((row) => row.kind === kind)?.total ?? "0");
    const subscribers = counts.rows.map((row) => ({ planCode: row.code, approximateCount: roundToBase(row.n, SUBSCRIBER_ROUNDING_BASE) }));
    const paid = counts.rows.filter((row) => row.code !== "free").reduce((sum, row) => sum + row.n, 0);
    return {
      plans: [...grouped.entries()].map(([code, list]) => ({ code, versions: list })),
      subscribers: subscribers.filter((entry) => entry.planCode !== "free"),
      totalSubscribersApproximate: roundToBase(paid, SUBSCRIBER_ROUNDING_BASE),
      month: { startsAt: starts, endsAt: ends },
      subscriptionRevenueXof: total("subscription_revenue"),
      promoIssuedXof: -total("promo_issuance"),
      promoSpentXof: total("promo_consumed"),
      promoExpiredXof: total("promo_expired"),
      readAt: month.rows[0].at,
    };
  });
}
