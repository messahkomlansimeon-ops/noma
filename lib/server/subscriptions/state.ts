import "server-only";

import type { Pool } from "pg";
import { requireTransactionPool, requireUuid } from "../catalog/validation";
import { withReadOnlySnapshot } from "../boost/boosts";
import { countOnlineOffers, readUserEntitlements, type UserEntitlements } from "./entitlements";
import { listSubscriptionNotices, type SubscriptionNotice } from "./notices";
import { readCurrentPlanVersions, type PlanVersionView } from "./plans";
import { readPromoSummary, type PromoSummary } from "./promo";

/**
 * Lecture de l'état de l'offre Pro d'un utilisateur (écran « Offre Pro », lot PRO1) : plans courants, droits en vigueur, abonnement (période, renouvellement, grâce), crédits
 * promotionnels restants et leur échéance, annonces en ligne, avis. Un instantané cohérent (lecture seule). Rien n'en sort qui concerne un autre utilisateur.
 */

export interface SubscriptionView {
  id: string;
  planCode: string;
  status: "active" | "past_due";
  periodStart: Date;
  periodEnd: Date;
  autoRenew: boolean;
  canceledAt: Date | null;
  graceEndsAt: Date | null;
  /** Prix de la période en cours (XOF) et prix EXACT du PROCHAIN renouvellement : un abonnement est renouvelé au prix de SA version, jamais à celui d'une version créée depuis. */
  currentPriceXof: bigint;
  renewalPriceXof: bigint;
  /** Les droits sont en vigueur à cet instant (une période terminée sans renouvellement possible n'en donne plus). */
  entitled: boolean;
}

export interface SubscriptionState {
  plans: PlanVersionView[];
  entitlements: UserEntitlements;
  subscription: SubscriptionView | null;
  promo: PromoSummary;
  onlineOffers: number;
  notices: SubscriptionNotice[];
  unreadNotices: number;
  readAt: Date;
}

export async function readSubscriptionState(input: { pool: Pool; userId: string }): Promise<SubscriptionState> {
  const pool = requireTransactionPool(input.pool);
  const userId = requireUuid(input.userId, "userId").toLowerCase();
  return withReadOnlySnapshot(pool, async (client) => {
    const plans = await readCurrentPlanVersions(client);
    const entitlements = await readUserEntitlements(client, userId);
    const promo = await readPromoSummary(client, userId);
    const onlineOffers = await countOnlineOffers(client, userId);
    const { notices, unreadCount } = await listSubscriptionNotices(client, userId);
    const row = await client.query<{
      id: string; code: string; status: "active" | "past_due"; period_start: Date; period_end: Date; auto_renew: boolean; canceled_at: Date | null; grace_ends_at: Date | null;
      current_price: string; renewal_price: string; entitled: boolean; read_at: Date;
    }>(
      `SELECT s.id, p.code, s.status, s.current_period_start AS period_start, s.current_period_end AS period_end, s.auto_renew, s.canceled_at, s.grace_ends_at,
              cv.monthly_price_xof::text AS current_price,
              cv.monthly_price_xof::text AS renewal_price,
              (subscription_effective_version(s.user_id) IS NOT NULL) AS entitled, clock_timestamp() AS read_at
         FROM subscriptions s JOIN plans p ON p.id = s.plan_id JOIN plan_versions cv ON cv.id = s.plan_version_id
        WHERE s.user_id = $1::uuid AND s.status IN ('active', 'past_due')`,
      [userId],
    );
    const subscription = row.rows[0]
      ? {
          id: row.rows[0].id,
          planCode: row.rows[0].code,
          status: row.rows[0].status,
          periodStart: row.rows[0].period_start,
          periodEnd: row.rows[0].period_end,
          autoRenew: row.rows[0].auto_renew,
          canceledAt: row.rows[0].canceled_at,
          graceEndsAt: row.rows[0].grace_ends_at,
          currentPriceXof: BigInt(row.rows[0].current_price),
          renewalPriceXof: BigInt(row.rows[0].renewal_price),
          entitled: row.rows[0].entitled,
        }
      : null;
    const clock = await client.query<{ at: Date }>("SELECT clock_timestamp() AS at");
    return { plans, entitlements, subscription, promo, onlineOffers, notices, unreadNotices: unreadCount, readAt: clock.rows[0].at };
  });
}
