import "server-only";

import { requireUuid } from "../catalog/validation";
import { OfferLimitError } from "../catalog/errors";
import type { SqlExecutor } from "../postgres/client";
import { ENTITLEMENTS, PLAN_FREE_CODE, SUBSCRIPTION_USER_LOCK_NAMESPACE, type Entitlement } from "./config";
import { SubscriptionError } from "./errors";

/**
 * Droits en vigueur (lot PRO1) : UNE règle serveur, la fonction SQL `subscription_effective_version` (migration 0021), partagée par la limite d'annonces en ligne, le badge Pro et
 * l'import de catalogue. Un utilisateur sans abonnement en vigueur a la version courante du plan Gratuit. Rien ne vient jamais du client. Voir OFFRE-PRO.md.
 */

export interface UserEntitlements {
  /** `free` : aucun abonnement en vigueur ; `subscription` : un plan payant est en vigueur (période payée, ou délai de grâce). */
  source: "free" | "subscription";
  planCode: string;
  planName: string;
  planVersionId: string;
  planVersion: number;
  maxOnlineOffers: number;
  entitlements: readonly Entitlement[];
}

interface EntitlementRow {
  version_id: string;
  version: number;
  name: string;
  max_online_offers: number;
  entitlements: string[];
  code: string;
}

function knownEntitlements(values: readonly string[]): Entitlement[] {
  return values.filter((value): value is Entitlement => (ENTITLEMENTS as readonly string[]).includes(value));
}

/** Verrou consultatif de l'utilisateur (transactionnel) : il sérialise ses opérations d'abonnement, le décompte de ses annonces en ligne et l'import de son catalogue. */
export async function lockUserEntitlements(executor: SqlExecutor, userId: string): Promise<void> {
  const user = requireUuid(userId, "userId").toLowerCase();
  await executor.query("SELECT pg_advisory_xact_lock($1::int, hashtext($2::text))", [SUBSCRIPTION_USER_LOCK_NAMESPACE, user]);
}

/** Droits en vigueur de l'utilisateur à l'instant de la base. */
export async function readUserEntitlements(executor: SqlExecutor, userId: string): Promise<UserEntitlements> {
  const user = requireUuid(userId, "userId").toLowerCase();
  const result = await executor.query<EntitlementRow>(
    `SELECT v.id AS version_id, v.version, v.name, v.max_online_offers, v.entitlements, p.code
       FROM plan_versions v JOIN plans p ON p.id = v.plan_id
      WHERE v.id = COALESCE(
              subscription_effective_version($1::uuid),
              (SELECT fv.id FROM plan_versions fv JOIN plans fp ON fp.id = fv.plan_id WHERE fp.code = $2 ORDER BY fv.version DESC LIMIT 1))`,
    [user, PLAN_FREE_CODE],
  );
  const row = result.rows[0];
  if (!row) throw new SubscriptionError("plans_unavailable");
  return {
    source: row.code === PLAN_FREE_CODE ? "free" : "subscription",
    planCode: row.code,
    planName: row.name,
    planVersionId: row.version_id,
    planVersion: row.version,
    maxOnlineOffers: row.max_online_offers,
    entitlements: knownEntitlements(row.entitlements),
  };
}

export function hasEntitlement(entitlements: UserEntitlements, entitlement: Entitlement): boolean {
  return entitlements.entitlements.includes(entitlement);
}

/** Annonces EN LIGNE de l'utilisateur : publiées et non archivées. */
export async function countOnlineOffers(executor: SqlExecutor, userId: string): Promise<number> {
  const user = requireUuid(userId, "userId").toLowerCase();
  const result = await executor.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM offers WHERE owner_id = $1::uuid AND status = 'published' AND archived_at IS NULL",
    [user],
  );
  return result.rows[0].n;
}

/**
 * Refuse (`OfferLimitError`, 409 `offer_limit_reached`) la mise en ligne d'UNE annonce de plus si le plan en vigueur de l'utilisateur est déjà plein. À appeler DANS la
 * transaction qui écrit le changement de statut : le verrou de l'utilisateur est pris ici (et doit l'être AVANT la ligne de l'annonce par les appelants qui la verrouillent :
 * voir `offers.ts`) et tenu jusqu'à la fin de la transaction, donc deux publications simultanées ne dépassent jamais la limite.
 */
export async function assertCanPublishOffer(executor: SqlExecutor, userId: string): Promise<void> {
  await lockUserEntitlements(executor, userId);
  const entitlements = await readUserEntitlements(executor, userId);
  const online = await countOnlineOffers(executor, userId);
  if (online >= entitlements.maxOnlineOffers) throw new OfferLimitError(entitlements.maxOnlineOffers);
}

/** Badge « Vendeur Pro » de chacun de ces utilisateurs : vrai ssi la version en vigueur de son plan porte le droit `badge_pro` (abonnement en vigueur, jamais sinon). */
export async function readProBadges(executor: SqlExecutor, userIds: readonly string[]): Promise<Map<string, boolean>> {
  const unique = [...new Set(userIds.map((id) => requireUuid(id, "userId").toLowerCase()))];
  const badges = new Map<string, boolean>(unique.map((id) => [id, false]));
  if (unique.length === 0) return badges;
  const result = await executor.query<{ id: string; badge: boolean }>(
    `SELECT u.id, COALESCE(('badge_pro' = ANY(v.entitlements)), FALSE) AS badge
       FROM users u LEFT JOIN plan_versions v ON v.id = subscription_effective_version(u.id)
      WHERE u.id = ANY($1::uuid[])`,
    [unique],
  );
  for (const row of result.rows) badges.set(row.id, row.badge === true);
  return badges;
}
