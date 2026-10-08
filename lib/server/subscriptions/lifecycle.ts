import "server-only";

import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { CatalogValidationError } from "../catalog/errors";
import { lockPlanLimitPausedOffers, pauseOfferInTransaction, republishPlanLimitOfferInTransaction } from "../catalog/offers";
import { requireTransactionPool, requireUuid } from "../catalog/validation";
import { withPostgresTransaction } from "../postgres/client";
import { WalletError } from "../wallet/errors";
import { postWalletTransaction, type LedgerEntryInput } from "../wallet/ledger";
import { SUBSCRIPTION_GRACE_HOURS, SUBSCRIPTION_LOCK_TIMEOUT_MS, SUBSCRIPTION_STEP_DEFAULT_LIMIT, SUBSCRIPTION_STEP_MAX_LIMIT } from "./config";
import { countOnlineOffers, lockUserEntitlements, readUserEntitlements } from "./entitlements";
import { SubscriptionError } from "./errors";
import { insertSubscriptionNotice } from "./notices";
import { addHours, addOneMonth, currentInstant, INSTANT_TEXT_SQL, renewalStart } from "./time";

/**
 * Cycle de vie d'un abonnement payé avec les crédits du portefeuille (lot PRO1). Voir OFFRE-PRO.md.
 *
 *  - SOUSCRIPTION (`subscribeToPlan`) : UNE transaction, sous le verrou de l'utilisateur : abonnement, débit (`subscription_charge` : vendeur −prix, `subscription_revenue` +prix,
 *    et, s'il y a des crédits promotionnels, `user_promo` +crédits, `promo_issuance` −crédits), période d'un mois, émission promotionnelle. Idempotente par clé (un double clic ne
 *    donne jamais deux débits). Solde insuffisant : rien n'est écrit. Les crédits promotionnels ne paient JAMAIS un abonnement. La souscription utilise la DERNIÈRE version du plan ;
 *    elle remet en ligne, dans la limite du plan, les annonces que la fin d'un abonnement précédent avait mises en pause (`paused_reason = 'plan_limit'`, les plus récentes d'abord ;
 *    jamais celles que le vendeur avait mises en pause lui-même) et en avertit le vendeur.
 *  - RENOUVELLEMENT, GRÂCE, FIN (`runSubscriptionStep`, étape « subscriptions » du worker) : à l'échéance, renouvellement automatique si l'option est activée (périodes contiguës).
 *    Un abonnement est renouvelé au prix de SA version : une nouvelle version d'un plan ne s'applique qu'aux NOUVELLES souscriptions (migrer les abonnés existants sera un lot futur,
 *    avec avis préalable et acceptation). Solde insuffisant : délai de GRÂCE de 72 h à partir de la fin de la période (les droits restent actifs sans paiement), nouvelle tentative à
 *    chaque passage, puis fin avec retour au plan Gratuit : les annonces au-delà de la limite passent en pause (raison `plan_limit`), les plus anciennes d'abord, et le vendeur en est
 *    averti. Idempotent par période (numéro unique par abonnement).
 *  - ANNULATION (`setSubscriptionAutoRenew`) : renouvellement désactivé, effective à la fin de la période, sans remboursement.
 *  - EXPIRATION des crédits promotionnels (`expirePromoGrants`) : à la fin de la période, le reste est RETIRÉ du sous-compte par une transaction `promo_expiry` (écrite, jamais effacée).
 *  - REMBOURSEMENT d'une période (`refundSubscriptionPeriod`, administration, intégral) : même mécanisme que le remboursement d'un boost.
 *
 * Ordre des verrous (jamais à l'envers) : verrou de l'utilisateur → ligne de l'abonnement → lignes des annonces → émissions promotionnelles → comptes du grand livre.
 */

const ZERO = BigInt(0);

export interface SubscribeResult {
  subscriptionId: string;
  periodId: string;
  /** Vrai si cet appel a renvoyé la souscription déjà enregistrée pour la même clé d'idempotence : aucun nouveau débit. */
  reused: boolean;
  /** Annonces remises en ligne par cette souscription (mises en pause par la fin d'un abonnement précédent) ; 0 pour un rejeu. */
  restoredOffers: number;
}

export interface SubscribeTestHooks {
  /** Réservé aux tests : appelé après tous les contrôles, juste avant le débit. */
  beforeDebit?: () => void | Promise<void>;
  /** Réservé aux tests : appelé juste après le débit, avant l'écriture de la période. */
  afterDebit?: () => void | Promise<void>;
}

interface PlanChoice {
  planId: string;
  versionId: string;
  price: bigint;
  promo: bigint;
  maxOnlineOffers: number;
}

interface PlanChoiceRow {
  plan_id: string;
  id: string;
  price: string;
  promo: string;
  max_online_offers: number;
}

const toChoice = (row: PlanChoiceRow): PlanChoice => ({ planId: row.plan_id, versionId: row.id, price: BigInt(row.price), promo: BigInt(row.promo), maxOnlineOffers: row.max_online_offers });

/** DERNIÈRE version d'un plan : celle d'une NOUVELLE souscription. */
async function readLatestVersion(client: PoolClient, planCode: string): Promise<PlanChoice | null> {
  const result = await client.query<PlanChoiceRow>(
    `SELECT p.id AS plan_id, v.id, v.monthly_price_xof::text AS price, v.promo_credits_xof::text AS promo, v.max_online_offers
       FROM plans p JOIN plan_versions v ON v.plan_id = p.id
      WHERE p.code = $1 ORDER BY v.version DESC LIMIT 1`,
    [planCode],
  );
  return result.rows[0] ? toChoice(result.rows[0]) : null;
}

/** Version d'un abonnement (celle de sa souscription) : un renouvellement est TOUJOURS à son prix, jamais à celui d'une version créée depuis. */
async function readVersionById(client: PoolClient, versionId: string): Promise<PlanChoice | null> {
  const result = await client.query<PlanChoiceRow>(
    `SELECT v.plan_id, v.id, v.monthly_price_xof::text AS price, v.promo_credits_xof::text AS promo, v.max_online_offers
       FROM plan_versions v WHERE v.id = $1::uuid`,
    [versionId],
  );
  return result.rows[0] ? toChoice(result.rows[0]) : null;
}

/** Écritures d'une période : débit du prix (vendeur → revenus d'abonnement) et, s'il y a des crédits promotionnels, leur émission (promo_issuance → sous-compte du vendeur). */
function chargeEntries(userId: string, price: bigint, promo: bigint): LedgerEntryInput[] {
  const entries: LedgerEntryInput[] = [
    { account: { kind: "user", ownerId: userId }, amount: -price },
    { account: { kind: "subscription_revenue" }, amount: price },
  ];
  if (promo > ZERO) {
    entries.push({ account: { kind: "user_promo", ownerId: userId }, amount: promo }, { account: { kind: "promo_issuance" }, amount: -promo });
  }
  return entries;
}

/** Écrit la période payée et, s'il y a lieu, l'émission promotionnelle (APRÈS la transaction du grand livre : les gardes de la base la relisent). */
async function insertPeriod(
  client: PoolClient,
  input: {
    periodId: string; subscriptionId: string; userId: string; number: number; kind: "initial" | "renewal"; versionId: string; startsAt: string; endsAt: string;
    price: bigint; promo: bigint; transactionId: string; idempotencyKey: string | null;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO subscription_periods (id, subscription_id, user_id, number, kind, plan_version_id, starts_at, ends_at, price_xof, promo_credits_xof, transaction_id, idempotency_key)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4::int, $5, $6::uuid, $7::timestamptz, $8::timestamptz, $9::bigint, $10::bigint, $11::uuid, $12::uuid)`,
    [input.periodId, input.subscriptionId, input.userId, input.number, input.kind, input.versionId, input.startsAt, input.endsAt, input.price.toString(), input.promo.toString(), input.transactionId, input.idempotencyKey],
  );
  if (input.promo > ZERO) {
    await client.query(
      `INSERT INTO promo_grants (id, user_id, period_id, amount_xof, granted_at, expires_at, grant_transaction_id)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::bigint, $5::timestamptz, $6::timestamptz, $7::uuid)`,
      [randomUUID(), input.userId, input.periodId, input.promo.toString(), input.startsAt, input.endsAt, input.transactionId],
    );
  }
}

// ───────────── souscription ─────────────

/**
 * Souscrit à un plan payant (aujourd'hui `pro`) avec les crédits payés de l'utilisateur. Ordre : validation avant SQL ; verrou de l'utilisateur ; rejeu de la clé d'idempotence
 * (même plan : renvoyé sans nouveau débit ; autre plan : `idempotency_conflict`) ; plan (`plan_not_found`, `plan_not_subscribable` s'il est gratuit) ; pas d'abonnement en vigueur
 * (`already_subscribed`) ; abonnement, débit (`insufficient_balance` : tout est annulé, pas même un compte), période, émission promotionnelle.
 */
export async function subscribeToPlan(input: {
  pool: Pool;
  userId: string;
  planCode: string;
  idempotencyKey: string;
  /** Horloge injectable (essais, outils) : défaut, l'horloge de la base. */
  now?: Date;
  hooks?: SubscribeTestHooks;
}): Promise<SubscribeResult> {
  const pool = requireTransactionPool(input.pool);
  const userId = requireUuid(input.userId, "userId").toLowerCase();
  const idempotencyKey = requireUuid(input.idempotencyKey, "idempotencyKey").toLowerCase();
  if (typeof input.planCode !== "string" || !/^[a-z][a-z0-9_]{1,29}$/.test(input.planCode)) throw new CatalogValidationError("planCode invalide.");
  const planCode = input.planCode;

  return withPostgresTransaction(async (client) => {
    await client.query(`SET LOCAL lock_timeout = '${SUBSCRIPTION_LOCK_TIMEOUT_MS}ms'`);
    await lockUserEntitlements(client, userId);

    const replay = await client.query<{ id: string; subscription_id: string; code: string }>(
      `SELECT p.id, p.subscription_id, pl.code
         FROM subscription_periods p JOIN plan_versions v ON v.id = p.plan_version_id JOIN plans pl ON pl.id = v.plan_id
        WHERE p.user_id = $1::uuid AND p.idempotency_key = $2::uuid`,
      [userId, idempotencyKey],
    );
    if (replay.rows[0]) {
      if (replay.rows[0].code !== planCode) throw new SubscriptionError("idempotency_conflict");
      return { subscriptionId: replay.rows[0].subscription_id, periodId: replay.rows[0].id, reused: true, restoredOffers: 0 };
    }

    const choice = await readLatestVersion(client, planCode);
    if (!choice) throw new SubscriptionError("plan_not_found");
    if (choice.price <= ZERO) throw new SubscriptionError("plan_not_subscribable");
    const live = await client.query("SELECT 1 FROM subscriptions WHERE user_id = $1::uuid AND status IN ('active', 'past_due')", [userId]);
    if (live.rowCount) throw new SubscriptionError("already_subscribed");

    const startsAt = await currentInstant(client, input.now);
    const endsAt = await addOneMonth(client, startsAt);
    const subscriptionId = randomUUID();
    const periodId = randomUUID();
    await client.query(
      `INSERT INTO subscriptions (id, user_id, plan_id, status, plan_version_id, current_period_start, current_period_end, auto_renew, started_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'active', $4::uuid, $5::timestamptz, $6::timestamptz, TRUE, $5::timestamptz)`,
      [subscriptionId, userId, choice.planId, choice.versionId, startsAt, endsAt],
    );
    // Les annonces mises en pause par la fin d'un abonnement précédent sont verrouillées ICI (après l'abonnement, AVANT les comptes du grand livre : ordre des verrous).
    const pausedByPlanLimit = await lockPlanLimitPausedOffers(client, userId);
    if (input.hooks?.beforeDebit) await input.hooks.beforeDebit();
    const posted = await postWalletTransaction(client, {
      kind: "subscription_charge",
      reference: `subscription_charge:${periodId}`,
      metadata: { subscriptionPeriodId: periodId },
      entries: chargeEntries(userId, choice.price, choice.promo),
    });
    if (input.hooks?.afterDebit) await input.hooks.afterDebit();
    await insertPeriod(client, {
      periodId, subscriptionId, userId, number: 1, kind: "initial", versionId: choice.versionId, startsAt, endsAt,
      price: choice.price, promo: choice.promo, transactionId: posted.id, idempotencyKey,
    });
    const restoredOffers = await restorePlanLimitOffers(client, { userId, candidateIds: pausedByPlanLimit, maxOnlineOffers: choice.maxOnlineOffers, periodId });
    return { subscriptionId, periodId, reused: false, restoredOffers };
  }, pool);
}

/**
 * Remet en ligne, dans la limite du plan (`maxOnlineOffers` moins les annonces déjà en ligne), les annonces mises en pause par la fin d'un abonnement précédent, les plus RÉCENTES
 * d'abord (`candidateIds` est déjà verrouillé et trié). Même chemin que la publication ; une annonce qui ne passe plus la règle des numéros reste en pause. Un avis dit combien ont été
 * remises en ligne. Dans la transaction de la souscription : tout ou rien.
 */
async function restorePlanLimitOffers(client: PoolClient, input: { userId: string; candidateIds: readonly string[]; maxOnlineOffers: number; periodId: string }): Promise<number> {
  if (input.candidateIds.length === 0) return 0;
  let room = input.maxOnlineOffers - (await countOnlineOffers(client, input.userId));
  let restored = 0;
  for (const offerId of input.candidateIds) {
    if (room <= 0) break;
    if ((await republishPlanLimitOfferInTransaction(client, offerId)) !== null) {
      restored += 1;
      room -= 1;
    }
  }
  if (restored > 0) await insertSubscriptionNotice(client, { userId: input.userId, code: "listings_restored", dedupeKey: `restored:${input.periodId}`, listingCount: restored });
  return restored;
}

// ───────────── annulation / renouvellement automatique ─────────────

/**
 * Active ou désactive le renouvellement automatique de l'abonnement en vigueur. Désactiver = ANNULER : l'abonnement et ses droits restent jusqu'à la fin de la période déjà payée,
 * aucun remboursement. Réactiver n'est possible que pendant la période (ou pendant le délai de grâce) : après, il faut souscrire de nouveau (`period_ended`). Idempotent.
 */
export async function setSubscriptionAutoRenew(input: { pool: Pool; userId: string; autoRenew: boolean; now?: Date }): Promise<{ autoRenew: boolean; changed: boolean }> {
  const pool = requireTransactionPool(input.pool);
  const userId = requireUuid(input.userId, "userId").toLowerCase();
  if (typeof input.autoRenew !== "boolean") throw new CatalogValidationError("autoRenew doit être un booléen.");
  const autoRenew = input.autoRenew;
  return withPostgresTransaction(async (client) => {
    await client.query(`SET LOCAL lock_timeout = '${SUBSCRIPTION_LOCK_TIMEOUT_MS}ms'`);
    await lockUserEntitlements(client, userId);
    const now = await currentInstant(client, input.now);
    const found = await client.query<{ id: string; status: string; auto_renew: boolean; period_over: boolean }>(
      `SELECT id, status, auto_renew, (current_period_end <= $2::timestamptz) AS period_over
         FROM subscriptions WHERE user_id = $1::uuid AND status IN ('active', 'past_due') FOR UPDATE`,
      [userId, now],
    );
    const subscription = found.rows[0];
    if (!subscription) throw new SubscriptionError("no_subscription");
    if (subscription.auto_renew === autoRenew) return { autoRenew, changed: false };
    // Réactiver après la fin de la période (hors délai de grâce) : le worker va conclure l'abonnement, il faut souscrire de nouveau.
    if (autoRenew && subscription.period_over && subscription.status !== "past_due") throw new SubscriptionError("period_ended");
    await client.query(
      "UPDATE subscriptions SET auto_renew = $2::boolean, canceled_at = CASE WHEN $2::boolean THEN NULL ELSE $3::timestamptz END, updated_at = $3::timestamptz WHERE id = $1::uuid",
      [subscription.id, autoRenew, now],
    );
    return { autoRenew, changed: true };
  }, pool);
}

// ───────────── fin d'un abonnement ─────────────

interface DueSubscription {
  id: string;
  user_id: string;
  plan_id: string;
  plan_version_id: string;
  status: "active" | "past_due";
  period_number: number;
  period_start: string;
  period_end: string;
  grace_ends: string | null;
  auto_renew: boolean;
}

/**
 * Termine l'abonnement (statut `ended`, motif) et applique le plan Gratuit : les annonces EN LIGNE au-delà de sa limite passent en pause, les plus ANCIENNES d'abord (même chemin
 * que la pause d'une annonce : correspondances invalidées, événement de l'outbox) ; l'utilisateur en est averti dans l'application. Dans la transaction de l'appelant.
 */
async function endSubscription(
  client: PoolClient,
  input: { subscriptionId: string; userId: string; reason: "canceled" | "payment_failed" | "refunded"; now: string },
): Promise<{ pausedCount: number }> {
  await client.query(
    `UPDATE subscriptions SET status = 'ended', ended_at = $2::timestamptz, ended_reason = $3, grace_ends_at = NULL, updated_at = $2::timestamptz WHERE id = $1::uuid`,
    [input.subscriptionId, input.now, input.reason],
  );
  // Après la mise à jour, les droits en vigueur sont ceux du plan Gratuit.
  const entitlements = await readUserEntitlements(client, input.userId);
  const online = await client.query<{ id: string }>(
    `SELECT id FROM offers WHERE owner_id = $1::uuid AND status = 'published' AND archived_at IS NULL ORDER BY created_at ASC, id ASC FOR UPDATE`,
    [input.userId],
  );
  const excess = Math.max(0, online.rows.length - entitlements.maxOnlineOffers);
  let pausedCount = 0;
  for (const row of online.rows.slice(0, excess)) {
    if ((await pauseOfferInTransaction(client, row.id, "plan_limit")) !== null) pausedCount += 1;
  }
  await insertSubscriptionNotice(client, { userId: input.userId, code: "subscription_ended", dedupeKey: `ended:${input.subscriptionId}` });
  if (pausedCount > 0) {
    await insertSubscriptionNotice(client, { userId: input.userId, code: "listings_paused", dedupeKey: `paused:${input.subscriptionId}`, listingCount: pausedCount });
  }
  return { pausedCount };
}

// ───────────── renouvellement ─────────────

type ChargeOutcome = "charged" | "insufficient";

/** Tente le débit de la période suivante dans un SAVEPOINT : un solde insuffisant n'écrit rien (et ne casse pas la transaction) ; toute autre erreur est relancée. */
async function chargeRenewal(client: PoolClient, subscription: DueSubscription, now: string): Promise<ChargeOutcome> {
  // Le prix de SA version (jamais celui d'une version créée depuis : les abonnés actuels gardent leur prix).
  const choice = await readVersionById(client, subscription.plan_version_id);
  if (!choice) throw new SubscriptionError("plan_not_found");
  const startsAt = await renewalStart(client, subscription.period_end, now);
  const endsAt = await addOneMonth(client, startsAt);
  const periodId = randomUUID();
  await client.query("SAVEPOINT subscription_renewal");
  try {
    const posted = await postWalletTransaction(client, {
      kind: "subscription_charge",
      reference: `subscription_charge:${periodId}`,
      metadata: { subscriptionPeriodId: periodId },
      entries: chargeEntries(subscription.user_id, choice.price, choice.promo),
    });
    await insertPeriod(client, {
      periodId, subscriptionId: subscription.id, userId: subscription.user_id, number: subscription.period_number + 1, kind: "renewal", versionId: choice.versionId,
      startsAt, endsAt, price: choice.price, promo: choice.promo, transactionId: posted.id, idempotencyKey: null,
    });
    await client.query(
      `UPDATE subscriptions SET status = 'active', plan_version_id = $2::uuid, current_period_start = $3::timestamptz, current_period_end = $4::timestamptz,
              grace_ends_at = NULL, last_attempt_at = $5::timestamptz, updated_at = $5::timestamptz WHERE id = $1::uuid`,
      [subscription.id, choice.versionId, startsAt, endsAt, now],
    );
    await client.query("RELEASE SAVEPOINT subscription_renewal");
    return "charged";
  } catch (error) {
    await client.query("ROLLBACK TO SAVEPOINT subscription_renewal");
    if (error instanceof WalletError && error.code === "insufficient_balance") return "insufficient";
    throw error;
  }
}

export type SubscriptionStepOutcome = "renewed" | "past_due" | "ended" | "unchanged" | "skipped";

export interface ProcessedSubscription {
  outcome: SubscriptionStepOutcome;
  pausedOffers: number;
}

/**
 * Traite UN abonnement échu, dans une transaction, sous le verrou de l'utilisateur et le verrou de sa ligne ; la décision est relue sous ces verrous (un autre passage a pu s'en
 * charger : `skipped`). Décision à l'échéance :
 *   - `active`, renouvellement désactivé → fin (`canceled`) ;
 *   - `active`, renouvellement activé → débit de la période suivante ; solde insuffisant → délai de grâce (`past_due`, fin de la période + 72 h) et avis, ou, si ces 72 h sont déjà
 *     écoulées (worker arrêté), fin (`payment_failed`) ;
 *   - `past_due`, renouvellement désactivé → fin (`canceled`) ; grâce écoulée → fin (`payment_failed`) ; sinon nouvelle tentative (réussie : `active` ; sinon `unchanged`).
 */
export async function processDueSubscription(input: { pool: Pool; subscriptionId: string; now?: Date }): Promise<ProcessedSubscription> {
  const pool = requireTransactionPool(input.pool);
  const subscriptionId = requireUuid(input.subscriptionId, "subscriptionId").toLowerCase();
  return withPostgresTransaction(async (client) => {
    await client.query(`SET LOCAL lock_timeout = '${SUBSCRIPTION_LOCK_TIMEOUT_MS}ms'`);
    const owner = await client.query<{ user_id: string }>("SELECT user_id FROM subscriptions WHERE id = $1::uuid", [subscriptionId]);
    if (!owner.rows[0]) return { outcome: "skipped", pausedOffers: 0 };
    await lockUserEntitlements(client, owner.rows[0].user_id);
    const now = await currentInstant(client, input.now);
    const found = await client.query<DueSubscription>(
      `SELECT s.id, s.user_id, s.plan_id, s.plan_version_id, s.status, s.auto_renew,
              (SELECT max(p.number) FROM subscription_periods p WHERE p.subscription_id = s.id) AS period_number,
              ${INSTANT_TEXT_SQL("s.current_period_start")} AS period_start, ${INSTANT_TEXT_SQL("s.current_period_end")} AS period_end,
              ${INSTANT_TEXT_SQL("s.grace_ends_at")} AS grace_ends
         FROM subscriptions s
        WHERE s.id = $1::uuid AND s.status IN ('active', 'past_due') AND s.current_period_end <= $2::timestamptz
        FOR UPDATE OF s`,
      [subscriptionId, now],
    );
    const subscription = found.rows[0];
    if (!subscription) return { outcome: "skipped", pausedOffers: 0 };

    const end = async (reason: "canceled" | "payment_failed"): Promise<ProcessedSubscription> => {
      const result = await endSubscription(client, { subscriptionId, userId: subscription.user_id, reason, now });
      return { outcome: "ended", pausedOffers: result.pausedCount };
    };

    if (!subscription.auto_renew) return end("canceled");
    if (subscription.status === "past_due") {
      const over = await client.query<{ over: boolean }>("SELECT $1::timestamptz <= $2::timestamptz AS over", [subscription.grace_ends as string, now]);
      if (over.rows[0].over) return end("payment_failed");
      if ((await chargeRenewal(client, subscription, now)) === "charged") return { outcome: "renewed", pausedOffers: 0 };
      await client.query("UPDATE subscriptions SET last_attempt_at = $2::timestamptz WHERE id = $1::uuid", [subscriptionId, now]);
      return { outcome: "unchanged", pausedOffers: 0 };
    }
    if ((await chargeRenewal(client, subscription, now)) === "charged") return { outcome: "renewed", pausedOffers: 0 };

    // Solde insuffisant au renouvellement : délai de grâce, ou fin si la grâce est déjà écoulée (worker arrêté plus de 72 h).
    const graceEnds = await addHours(client, subscription.period_end, SUBSCRIPTION_GRACE_HOURS);
    const over = await client.query<{ over: boolean }>("SELECT $1::timestamptz <= $2::timestamptz AS over", [graceEnds, now]);
    if (over.rows[0].over) return end("payment_failed");
    await client.query(
      "UPDATE subscriptions SET status = 'past_due', grace_ends_at = $2::timestamptz, last_attempt_at = $3::timestamptz, updated_at = $3::timestamptz WHERE id = $1::uuid",
      [subscriptionId, graceEnds, now],
    );
    await insertSubscriptionNotice(client, {
      userId: subscription.user_id, code: "renewal_failed", dedupeKey: `renewal_failed:${subscriptionId}:${subscription.period_number}`,
    });
    return { outcome: "past_due", pausedOffers: 0 };
  }, pool);
}

// ───────────── expiration des crédits promotionnels ─────────────

/**
 * Fait expirer UNE émission échue : le reste est retiré du sous-compte par une transaction `promo_expiry` (user_promo −reste, promo_expired +reste) ; l'émission est close
 * (`expired_xof`, `expired_at`, transaction liée). Sans reste, elle est close sans transaction. Verrou de l'émission SKIP LOCKED (un achat en cours la tient : au prochain passage).
 * Renvoie le montant retiré, ou null si rien n'a été fait.
 */
export async function expirePromoGrant(input: { pool: Pool; grantId: string; now?: Date }): Promise<{ expiredXof: bigint } | null> {
  const pool = requireTransactionPool(input.pool);
  const grantId = requireUuid(input.grantId, "grantId").toLowerCase();
  return withPostgresTransaction(async (client) => {
    await client.query(`SET LOCAL lock_timeout = '${SUBSCRIPTION_LOCK_TIMEOUT_MS}ms'`);
    const now = await currentInstant(client, input.now);
    const locked = await client.query<{ user_id: string }>(
      `SELECT user_id FROM promo_grants WHERE id = $1::uuid AND expired_at IS NULL AND expires_at <= $2::timestamptz FOR UPDATE SKIP LOCKED`,
      [grantId, now],
    );
    if (!locked.rows[0]) return null;
    const userId = locked.rows[0].user_id;
    const remaining = BigInt((await client.query<{ remaining: string }>("SELECT promo_grant_remaining($1::uuid)::text AS remaining", [grantId])).rows[0].remaining);
    let transactionId: string | null = null;
    if (remaining > ZERO) {
      const posted = await postWalletTransaction(client, {
        kind: "promo_expiry",
        reference: `promo_expiry:${grantId}`,
        metadata: { promoGrantId: grantId },
        entries: [
          { account: { kind: "user_promo", ownerId: userId }, amount: -remaining },
          { account: { kind: "promo_expired" }, amount: remaining },
        ],
      });
      transactionId = posted.id;
    }
    await client.query(
      `UPDATE promo_grants SET expired_xof = $2::bigint, expired_at = $3::timestamptz, expiry_transaction_id = $4::uuid, expiry_reason = 'period_end' WHERE id = $1::uuid`,
      [grantId, remaining.toString(), now, transactionId],
    );
    return { expiredXof: remaining };
  }, pool);
}

// ───────────── étape « subscriptions » du worker ─────────────

export interface SubscriptionStepResult {
  /** Migration 0021 absente : étape ignorée sans erreur. */
  skipped: boolean;
  renewed: number;
  pastDue: number;
  ended: number;
  unchanged: number;
  pausedOffers: number;
  promoExpired: number;
  /** Crédits promotionnels retirés (XOF). */
  promoExpiredXof: number;
  /** Codes stables des échecs (`subscription_error_<code>`, `promo_error_<code>`) : jamais un message. */
  errors: string[];
}

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[A-Za-z0-9_]{1,40}$/.test(code) ? code.toLowerCase() : "unknown";
}

async function isProMigrationRegistered(pool: Pool): Promise<boolean> {
  const table = await pool.query<{ present: boolean }>("SELECT to_regclass('noma_schema_migrations') IS NOT NULL AS present");
  if (table.rows[0]?.present !== true) return false;
  const result = await pool.query("SELECT 1 FROM noma_schema_migrations WHERE version = '0021_pro_subscriptions'");
  return result.rowCount === 1;
}

/**
 * Étape « subscriptions » (lot PRO1), appelée par le worker à chaque cycle : abonnements échus (renouvellement, grâce, fin) puis crédits promotionnels échus (expiration écrite au
 * grand livre). Chaque abonnement et chaque émission est traité dans SA transaction : l'échec de l'un n'empêche pas les autres. Idempotente : un second passage ne refait rien.
 */
export async function runSubscriptionStep(input: {
  pool: Pool;
  now?: Date;
  limit?: number;
  /** Limite le passage aux abonnements et aux émissions de CET utilisateur (outils, essais) ; absent : tous. */
  userId?: string;
}): Promise<SubscriptionStepResult> {
  const pool = requireTransactionPool(input.pool);
  const userId = input.userId === undefined ? null : requireUuid(input.userId, "userId").toLowerCase();
  const limit = input.limit ?? SUBSCRIPTION_STEP_DEFAULT_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > SUBSCRIPTION_STEP_MAX_LIMIT) {
    throw new CatalogValidationError(`limit doit être un entier compris entre 1 et ${SUBSCRIPTION_STEP_MAX_LIMIT}.`);
  }
  const result: SubscriptionStepResult = { skipped: false, renewed: 0, pastDue: 0, ended: 0, unchanged: 0, pausedOffers: 0, promoExpired: 0, promoExpiredXof: 0, errors: [] };
  if (!(await isProMigrationRegistered(pool))) return { ...result, skipped: true };
  const nowText = input.now === undefined ? null : input.now.toISOString();

  const due = await pool.query<{ id: string }>(
    // Pendant la grâce, une tentative de renouvellement au plus par quart d'heure ; la fin (grâce écoulée, annulation) se traite sans attendre.
    `SELECT id FROM subscriptions
      WHERE status IN ('active', 'past_due') AND current_period_end <= COALESCE($1::timestamptz, clock_timestamp())
        AND (status = 'active' OR NOT auto_renew OR last_attempt_at IS NULL
             OR last_attempt_at <= COALESCE($1::timestamptz, clock_timestamp()) - interval '15 minutes'
             OR grace_ends_at <= COALESCE($1::timestamptz, clock_timestamp()))
        AND ($3::uuid IS NULL OR user_id = $3::uuid)
      ORDER BY current_period_end, id LIMIT $2::int`,
    [nowText, limit, userId],
  );
  for (const row of due.rows) {
    try {
      const processed = await processDueSubscription({ pool, subscriptionId: row.id, now: input.now });
      result.pausedOffers += processed.pausedOffers;
      if (processed.outcome === "renewed") result.renewed += 1;
      else if (processed.outcome === "past_due") result.pastDue += 1;
      else if (processed.outcome === "ended") result.ended += 1;
      else if (processed.outcome === "unchanged") result.unchanged += 1;
    } catch (error) {
      result.errors.push(`subscription_error_${errorCode(error)}`);
    }
  }

  const grants = await pool.query<{ id: string }>(
    `SELECT id FROM promo_grants
      WHERE expired_at IS NULL AND expires_at <= COALESCE($1::timestamptz, clock_timestamp()) AND ($3::uuid IS NULL OR user_id = $3::uuid)
      ORDER BY expires_at, id LIMIT $2::int`,
    [nowText, limit, userId],
  );
  for (const row of grants.rows) {
    try {
      const expired = await expirePromoGrant({ pool, grantId: row.id, now: input.now });
      if (expired !== null) {
        result.promoExpired += 1;
        result.promoExpiredXof += Number(expired.expiredXof);
      }
    } catch (error) {
      result.errors.push(`promo_error_${errorCode(error)}`);
    }
  }
  return result;
}

// ───────────── remboursement d'une période (administration) ─────────────

export interface SubscriptionRefundResult {
  periodId: string;
  /** Montant intégral rendu en crédits payés. */
  refundedAmount: bigint;
  /** Reste promotionnel inutilisé de l'émission de la période, retiré (expiré) par ce remboursement. */
  promoCancelled: bigint;
  subscriptionEnded: boolean;
  pausedOffers: number;
  /** Crédits payés de l'utilisateur après le remboursement. */
  balance: bigint;
}

const REASON_CODE = /^[a-z_]{1,40}$/;

/**
 * Rembourse INTÉGRALEMENT une période d'abonnement (administration, aucune route HTTP) : même mécanisme que le remboursement d'un boost. Une transaction : verrous (utilisateur, période,
 * abonnement, émission), fin de l'abonnement si cette période est sa période COURANTE (droits retirés, annonces au-delà de la limite Gratuit en pause), transaction
 * `subscription_refund` du prix intégral (`subscription_revenue` −prix, vendeur +prix) qui annule aussi le reste promotionnel INUTILISÉ de la période (`user_promo` −reste,
 * `promo_expired` +reste) ; les crédits promotionnels DÉJÀ dépensés ne sont pas repris. Deux remboursements simultanés : un seul passe.
 */
export async function refundSubscriptionPeriod(input: { pool: Pool; periodId: string; reasonCode: string; now?: Date }): Promise<SubscriptionRefundResult> {
  const pool = requireTransactionPool(input.pool);
  const periodId = requireUuid(input.periodId, "periodId").toLowerCase();
  if (typeof input.reasonCode !== "string" || !REASON_CODE.test(input.reasonCode)) {
    throw new CatalogValidationError("reasonCode doit être un code en minuscules et tirets bas (1 à 40 caractères).");
  }
  const reasonCode = input.reasonCode;
  return withPostgresTransaction(async (client) => {
    await client.query(`SET LOCAL lock_timeout = '${SUBSCRIPTION_LOCK_TIMEOUT_MS}ms'`);
    const owner = await client.query<{ user_id: string }>("SELECT user_id FROM subscription_periods WHERE id = $1::uuid", [periodId]);
    if (!owner.rows[0]) throw new SubscriptionError("period_not_found");
    const userId = owner.rows[0].user_id;
    await lockUserEntitlements(client, userId);
    const now = await currentInstant(client, input.now);
    const found = await client.query<{ id: string; subscription_id: string; number: number; price: string; refunded: boolean }>(
      `SELECT id, subscription_id, number, price_xof::text AS price, (refunded_at IS NOT NULL) AS refunded
         FROM subscription_periods WHERE id = $1::uuid FOR UPDATE`,
      [periodId],
    );
    const period = found.rows[0];
    if (!period) throw new SubscriptionError("period_not_found");
    if (period.refunded) throw new SubscriptionError("already_refunded");
    const price = BigInt(period.price);

    // L'abonnement : si cette période est sa période courante et qu'il est en vigueur, il prend fin (les droits payés par ce paiement disparaissent).
    const subscription = await client.query<{ live: boolean; latest: boolean }>(
      `SELECT (s.status IN ('active', 'past_due')) AS live,
              ($2::int = (SELECT max(p.number) FROM subscription_periods p WHERE p.subscription_id = s.id)) AS latest
         FROM subscriptions s WHERE s.id = $1::uuid FOR UPDATE`,
      [period.subscription_id, period.number],
    );
    let subscriptionEnded = false;
    let pausedOffers = 0;
    if (subscription.rows[0]?.live && subscription.rows[0].latest) {
      const ended = await endSubscription(client, { subscriptionId: period.subscription_id, userId, reason: "refunded", now });
      subscriptionEnded = true;
      pausedOffers = ended.pausedCount;
    }

    // Le reste promotionnel INUTILISÉ de la période est annulé par ce remboursement (une émission déjà close n'a plus de reste).
    const grant = await client.query<{ id: string; open: boolean }>(
      "SELECT id, (expired_at IS NULL) AS open FROM promo_grants WHERE period_id = $1::uuid FOR UPDATE",
      [periodId],
    );
    let promoCancelled = ZERO;
    const openGrant = grant.rows[0]?.open === true ? grant.rows[0] : null;
    if (openGrant) {
      promoCancelled = BigInt((await client.query<{ remaining: string }>("SELECT promo_grant_remaining($1::uuid)::text AS remaining", [openGrant.id])).rows[0].remaining);
    }
    const entries: LedgerEntryInput[] = [
      { account: { kind: "subscription_revenue" }, amount: -price },
      { account: { kind: "user", ownerId: userId }, amount: price },
    ];
    if (promoCancelled > ZERO) {
      entries.push({ account: { kind: "user_promo", ownerId: userId }, amount: -promoCancelled }, { account: { kind: "promo_expired" }, amount: promoCancelled });
    }
    const posted = await postWalletTransaction(client, {
      kind: "subscription_refund",
      reference: `subscription_refund:${periodId}`,
      metadata: { subscriptionPeriodId: periodId, reasonCode },
      entries,
    });
    if (openGrant) {
      await client.query(
        `UPDATE promo_grants SET expired_xof = $2::bigint, expired_at = $3::timestamptz, expiry_transaction_id = $4::uuid, expiry_reason = 'refund' WHERE id = $1::uuid`,
        [openGrant.id, promoCancelled.toString(), now, promoCancelled > ZERO ? posted.id : null],
      );
    }
    const updated = await client.query(
      "UPDATE subscription_periods SET refunded_at = $2::timestamptz, refund_transaction_id = $3::uuid WHERE id = $1::uuid AND refunded_at IS NULL",
      [periodId, now, posted.id],
    );
    if (!updated.rowCount) throw new SubscriptionError("already_refunded");
    const balance = await client.query<{ balance: string }>("SELECT balance::text AS balance FROM wallet_accounts WHERE kind = 'user' AND owner_id = $1::uuid", [userId]);
    return { periodId, refundedAmount: price, promoCancelled, subscriptionEnded, pausedOffers, balance: BigInt(balance.rows[0]?.balance ?? "0") };
  }, pool);
}
