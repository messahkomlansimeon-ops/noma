import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { Pool, type PoolClient, type PoolConfig } from "pg";
import { archiveOffer, pauseOffer, publishOffer } from "../../lib/server/catalog";
import { OfferLimitError } from "../../lib/server/catalog/errors";
import { runMatchingCycle } from "../../lib/server/matching/runner";
import { runMigrations } from "../../lib/server/postgres/migrations";
import { hasEntitlement, readProBadges, readUserEntitlements } from "../../lib/server/subscriptions/entitlements";
import { SubscriptionError } from "../../lib/server/subscriptions/errors";
import {
  expirePromoGrant, processDueSubscription, refundSubscriptionPeriod, runSubscriptionStep, setSubscriptionAutoRenew, subscribeToPlan,
} from "../../lib/server/subscriptions/lifecycle";
import { listSubscriptionNotices } from "../../lib/server/subscriptions/notices";
import { createPlanVersion } from "../../lib/server/subscriptions/plans";
import { readPromoSummary } from "../../lib/server/subscriptions/promo";
import { readSubscriptionState } from "../../lib/server/subscriptions/state";
import { runWalletCheck } from "../../lib/server/wallet/check";
import { WalletError } from "../../lib/server/wallet/errors";
import { readWalletOverview, recordWalletTransaction } from "../../lib/server/wallet/ledger";
import {
  HOUR, MINUTE, addMs, assertWalletGreen, balanceOf, big, countRows, fund, ledgerSnapshot, makeOffer, makePro, makeUser, periodOf, promoLedgerBalance, scalar,
  subscribePro, systemBalance,
} from "./pro-fixtures";
import {
  createTemporarySchemaName, openVerifiedIsolatedPool, openVerifiedTestDatabase, quoteTemporarySchema, type DedicatedTestDatabase,
} from "./test-database";

// ───────────── infrastructure ─────────────

const schema = createTemporarySchemaName();
const quoted = quoteTemporarySchema(schema);
let admin: Pool;
let target: DedicatedTestDatabase;
let pool: Pool;
/** Pool large : les rejeux simultanés (verrou de l'utilisateur) et les publications concurrentes. */
let widePool: Pool;
/** Pool des transactions de test annulées (injections de corruption : le schéma propre n'est jamais corrompu). */
let txPool: Pool;
const RUN_ID = `sub_${process.pid}_${randomBytes(4).toString("hex")}`;
const named = (label: string, max: number) => (config: PoolConfig): Pool => new Pool({ ...config, max, application_name: `${RUN_ID}_${label}` });

before(async () => {
  const opened = await openVerifiedTestDatabase(process.env.TEST_DATABASE_URL);
  admin = opened.pool;
  target = opened.target;
  await admin.query(`CREATE SCHEMA ${quoted}`);
  pool = await openVerifiedIsolatedPool(target, schema, named("main", 4));
  widePool = await openVerifiedIsolatedPool(target, schema, named("wide", 24));
  txPool = await openVerifiedIsolatedPool(target, schema, named("tx", 1));
  await runMigrations(pool);
});

after(async () => {
  for (const each of [pool, widePool, txPool]) if (each) await each.end().catch(() => {});
  if (admin) {
    await admin.query(`DROP SCHEMA IF EXISTS ${quoted} CASCADE`);
    await admin.end();
  }
});

/** Code de domaine d'une promesse. */
async function outcome(promise: Promise<unknown>): Promise<string> {
  try { await promise; return "ok"; } catch (error) {
    if (error instanceof SubscriptionError || error instanceof WalletError) return error.code;
    if (error instanceof OfferLimitError) return "offer_limit";
    return `${(error as Error).name}: ${(error as Error).message}`;
  }
}

interface Failure { code?: string; constraint?: string }
/** Exécute `operation` dans une transaction ANNULÉE (ou validée) ; renvoie l'échec SQL (code, contrainte) ou null. */
async function failureOf(operation: (client: PoolClient) => Promise<unknown>, commit = false): Promise<Failure | null> {
  const client = await txPool.connect();
  try {
    await client.query("BEGIN");
    await operation(client);
    await client.query(commit ? "COMMIT" : "ROLLBACK");
    return null;
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* conserver l'erreur utile */ }
    const details = error as Failure;
    return { code: details.code, constraint: details.constraint };
  } finally {
    client.release();
  }
}

const PRO_PRICE = 10_000;
const PRO_PROMO = 5_000;

// ═════════════ 1. Migration 0021 : plans versionnés ═════════════

test("plans de départ : Gratuit (0 XOF, 10 annonces, aucun droit) et Pro (10 000 XOF, 5 000 XOF promotionnels, 100 annonces, badge_pro et catalog_import) ; la relance ne refait rien", async () => {
  const rows = (await pool.query(
    `SELECT p.code, v.version, v.name, v.monthly_price_xof::text AS price, v.promo_credits_xof::text AS promo, v.max_online_offers, v.entitlements
       FROM plans p JOIN plan_versions v ON v.plan_id = p.id ORDER BY p.code, v.version`)).rows;
  assert.deepEqual(rows, [
    { code: "free", version: 1, name: "Gratuit", price: "0", promo: "0", max_online_offers: 10, entitlements: [] },
    { code: "pro", version: 1, name: "Pro", price: "10000", promo: "5000", max_online_offers: 100, entitlements: ["badge_pro", "catalog_import"] },
  ]);
  const rerun = await runMigrations(pool);
  assert.deepEqual(rerun.applied, []);
  assert.equal(await countRows(pool, "plans"), 2);
  assert.equal(await countRows(pool, "plan_versions"), 2);
  assert.equal(await countRows(pool, "wallet_accounts", "kind IN ('subscription_revenue', 'promo_issuance', 'promo_consumed', 'promo_expired')"), 4);
});

test("une version publiée est IMMUABLE : ni modification ni suppression, numéro sans trou, droits de la liste blanche seulement, bornes des CHECK", async () => {
  const proVersion = await scalar(pool, "SELECT v.id::text AS n FROM plan_versions v JOIN plans p ON p.id = v.plan_id WHERE p.code = 'pro'");
  assert.equal((await failureOf((client) => client.query("UPDATE plan_versions SET monthly_price_xof = 1 WHERE id = $1", [proVersion])))?.code, "23001");
  assert.equal((await failureOf((client) => client.query("UPDATE plan_versions SET name = 'Autre' WHERE id = $1", [proVersion])))?.code, "23001");
  assert.equal((await failureOf((client) => client.query("DELETE FROM plan_versions WHERE id = $1", [proVersion])))?.code, "23001");
  assert.equal((await failureOf((client) => client.query("UPDATE plans SET code = 'autre' WHERE code = 'pro'")))?.code, "23001");
  assert.equal((await failureOf((client) => client.query("DELETE FROM plans WHERE code = 'pro'")))?.code, "23001");
  const insert = (version: number, extra = "") => (client: PoolClient) => client.query(
    `INSERT INTO plan_versions (id, plan_id, version, name, monthly_price_xof, promo_credits_xof, max_online_offers, entitlements)
     SELECT gen_random_uuid(), id, ${version}, 'V', ${extra || "1000, 0, 5, '{}'"} FROM plans WHERE code = 'pro'`);
  assert.deepEqual(await failureOf(insert(3)), { code: "23514", constraint: "trg_plan_versions_sequence" }, "numéro avec un trou");
  assert.deepEqual(await failureOf(insert(1)), { code: "23514", constraint: "trg_plan_versions_sequence" }, "numéro déjà pris");
  assert.equal(await failureOf(insert(2)), null, "la version suivante est acceptée (et annulée ici)");
  assert.equal((await failureOf(insert(2, "1000, 0, 5, ARRAY['inconnu']::text[]")))?.constraint, "chk_plan_versions_entitlements");
  assert.equal((await failureOf(insert(2, "1000, 0, 5, ARRAY['badge_pro','badge_pro']::text[]")))?.constraint, "chk_plan_versions_entitlements");
  assert.equal((await failureOf(insert(2, "-1, 0, 5, '{}'")))?.constraint, "chk_plan_versions_price");
  assert.equal((await failureOf(insert(2, "1000, -1, 5, '{}'")))?.constraint, "chk_plan_versions_promo");
  assert.equal((await failureOf(insert(2, "1000, 0, 0, '{}'")))?.constraint, "chk_plan_versions_max_offers");
  assert.equal(await countRows(pool, "plan_versions"), 2, "rien n'a été écrit");
});

// ═════════════ 2. Souscription ═════════════

test("souscription : débit des crédits payés, revenus d'abonnement, crédits promotionnels émis dans un sous-compte distinct, période d'un mois, droits Pro, grand livre vert", async () => {
  const userId = await makeUser(pool);
  await fund(pool, userId, 12_000);
  const before = await readUserEntitlements(pool, userId);
  assert.equal(before.source, "free");
  assert.equal(before.maxOnlineOffers, 10);
  assert.deepEqual(before.entitlements, []);
  const revenueBefore = await systemBalance(pool, "subscription_revenue");

  const result = await subscribePro(pool, userId);
  assert.equal(result.reused, false);
  assert.equal(await balanceOf(pool, userId), big(12_000 - PRO_PRICE), "crédits payés débités du prix");
  assert.equal(await promoLedgerBalance(pool, userId), big(PRO_PROMO), "crédits promotionnels émis dans le sous-compte");
  assert.equal((await readPromoSummary(pool, userId)).balance, big(PRO_PROMO));
  assert.equal(await systemBalance(pool, "subscription_revenue") - revenueBefore, big(PRO_PRICE));
  assert.equal(await systemBalance(pool, "promo_issuance"), -big(PRO_PROMO), "promo_issuance devient négatif de l'émission");

  // La transaction : quatre écritures exactement, UNE seule transaction `subscription_charge`.
  const tx = (await pool.query<{ id: string; reference: string; metadata: Record<string, string> }>(
    "SELECT id, reference, metadata FROM wallet_transactions WHERE kind = 'subscription_charge'")).rows;
  assert.equal(tx.length, 1);
  assert.equal(tx[0].reference, `subscription_charge:${result.periodId}`);
  assert.deepEqual(tx[0].metadata, { subscriptionPeriodId: result.periodId });
  const entries = (await pool.query<{ kind: string; amount: string }>(
    "SELECT a.kind, e.amount::text AS amount FROM wallet_entries e JOIN wallet_accounts a ON a.id = e.account_id WHERE e.transaction_id = $1 ORDER BY a.kind", [tx[0].id])).rows;
  assert.deepEqual(entries, [
    { kind: "promo_issuance", amount: "-5000" }, { kind: "subscription_revenue", amount: "10000" }, { kind: "user", amount: "-10000" }, { kind: "user_promo", amount: "5000" },
  ]);

  // La période : un mois civil UTC, version du plan figée, émission liée à la période et à la même transaction.
  const period = (await pool.query<{ ok: boolean; kind: string; number: number; price: string; promo: string; transaction_id: string }>(
    `SELECT ends_at = ((starts_at AT TIME ZONE 'UTC' + INTERVAL '1 month') AT TIME ZONE 'UTC') AS ok, kind, number, price_xof::text AS price, promo_credits_xof::text AS promo, transaction_id
       FROM subscription_periods WHERE id = $1`, [result.periodId])).rows[0];
  assert.deepEqual({ ok: period.ok, kind: period.kind, number: period.number, price: period.price, promo: period.promo }, { ok: true, kind: "initial", number: 1, price: "10000", promo: "5000" });
  assert.equal(period.transaction_id, tx[0].id);
  const grant = (await pool.query<{ amount: string; same_tx: boolean; ends: boolean }>(
    `SELECT g.amount_xof::text AS amount, g.grant_transaction_id = $2::uuid AS same_tx, g.expires_at = p.ends_at AS ends
       FROM promo_grants g JOIN subscription_periods p ON p.id = g.period_id WHERE g.period_id = $1`, [result.periodId, tx[0].id])).rows[0];
  assert.deepEqual(grant, { amount: "5000", same_tx: true, ends: true });

  // Droits en vigueur.
  const after = await readUserEntitlements(pool, userId);
  assert.equal(after.source, "subscription");
  assert.equal(after.planCode, "pro");
  assert.equal(after.maxOnlineOffers, 100);
  assert.ok(hasEntitlement(after, "badge_pro") && hasEntitlement(after, "catalog_import"));
  assert.equal(hasEntitlement(after, "priority_support_label"), false);

  // Historique : une ligne, crédits payés −10 000 et crédits promotionnels +5 000 ; le porte-monnaie distingue les deux soldes.
  const overview = await readWalletOverview({ pool, ownerId: userId });
  assert.equal(overview.balance, big(2_000));
  assert.equal(overview.promoBalance, big(PRO_PROMO));
  assert.ok(overview.promoExpiresAt instanceof Date);
  const charge = overview.items.find((item) => item.kind === "subscription_charge");
  assert.ok(charge);
  assert.equal(charge.amount, -big(PRO_PRICE));
  assert.equal(charge.promoAmount, big(PRO_PROMO));
  await assertWalletGreen(pool, "après une souscription");
});

test("solde insuffisant : 409, RIEN n'est écrit (ni débit, ni abonnement, ni période, ni émission, pas même un compte)", async () => {
  const poor = await makeUser(pool);
  await fund(pool, poor, PRO_PRICE - 1);
  const unfunded = await makeUser(pool);
  const snapshot = await ledgerSnapshot(pool);
  assert.equal(await outcome(subscribePro(pool, poor)), "insufficient_balance");
  assert.equal(await outcome(subscribePro(pool, unfunded)), "insufficient_balance");
  assert.deepEqual(await ledgerSnapshot(pool), snapshot, "aucune trace d'une souscription refusée");
  assert.equal(await countRows(pool, "wallet_accounts", "owner_id = $1", [unfunded]), 0, "pas même un compte");
  assert.equal(await balanceOf(pool, poor), big(PRO_PRICE - 1));
  // Le prix EXACT passe (solde = prix) : le solde tombe à zéro, jamais négatif.
  const exact = await makeUser(pool);
  await fund(pool, exact, PRO_PRICE);
  await subscribePro(pool, exact);
  assert.equal(await balanceOf(pool, exact), big(0));
  await assertWalletGreen(pool, "après des souscriptions refusées et exacte");
});

test("A6 : le prix AFFICHÉ (expectedPriceXof) est comparé au prix de la dernière version : un autre prix → price_changed, RIEN n'est écrit même avec un solde suffisant ; le bon prix passe ; le rejeu avec un autre prix est refusé ; un prix invalide est refusé avant tout SQL", async () => {
  const userId = await makeUser(pool);
  await fund(pool, userId, 25_000);
  const snapshot = await ledgerSnapshot(pool);
  for (const expectedPriceXof of [PRO_PRICE - 1, PRO_PRICE + 1, 1, 100_000]) {
    assert.equal(await outcome(subscribeToPlan({ pool, userId, planCode: "pro", idempotencyKey: randomUUID(), expectedPriceXof })), "price_changed", String(expectedPriceXof));
  }
  for (const expectedPriceXof of [0, -PRO_PRICE, PRO_PRICE + 0.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2, "10000" as unknown as number]) {
    assert.match(await outcome(subscribeToPlan({ pool, userId, planCode: "pro", idempotencyKey: randomUUID(), expectedPriceXof })), /CatalogValidationError/, String(expectedPriceXof));
  }
  assert.deepEqual(await ledgerSnapshot(pool), snapshot, "aucun refus n'écrit ni ne débite");
  assert.equal(await balanceOf(pool, userId), big(25_000));
  const key = randomUUID();
  const created = await subscribeToPlan({ pool, userId, planCode: "pro", idempotencyKey: key, expectedPriceXof: PRO_PRICE });
  assert.equal(created.reused, false);
  assert.equal(await balanceOf(pool, userId), big(25_000 - PRO_PRICE));
  assert.equal(await outcome(subscribeToPlan({ pool, userId, planCode: "pro", idempotencyKey: key, expectedPriceXof: PRO_PRICE + 1 })), "price_changed", "rejeu avec un autre prix affiché");
  assert.equal((await subscribeToPlan({ pool, userId, planCode: "pro", idempotencyKey: key, expectedPriceXof: PRO_PRICE })).reused, true, "rejeu au prix payé");
  assert.equal(await balanceOf(pool, userId), big(25_000 - PRO_PRICE), "un seul débit");
  await assertWalletGreen(pool, "après les refus de prix");
});

test("double clic : 12 souscriptions simultanées avec la même clé → UN débit, une période, une seule `reused: false` ; une autre clé ou un autre plan est refusé", async () => {
  const userId = await makeUser(pool);
  await fund(pool, userId, 25_000);
  const key = randomUUID();
  const results = await Promise.all(Array.from({ length: 12 }, () => subscribeToPlan({ pool: widePool, userId, planCode: "pro", idempotencyKey: key })));
  assert.equal(results.filter((result) => !result.reused).length, 1, "une seule création");
  assert.equal(new Set(results.map((result) => result.periodId)).size, 1, "toutes les réponses désignent la même période");
  assert.equal(await balanceOf(pool, userId), big(15_000), "UN seul débit");
  assert.equal(await countRows(pool, "subscription_periods", "user_id = $1", [userId]), 1);
  assert.equal(await countRows(pool, "wallet_transactions", "kind = 'subscription_charge' AND reference = $1", [`subscription_charge:${results[0].periodId}`]), 1);
  assert.equal(await promoLedgerBalance(pool, userId), big(PRO_PROMO), "une seule émission promotionnelle");
  // Rejeu séquentiel : toujours la même période.
  assert.equal((await subscribeToPlan({ pool, userId, planCode: "pro", idempotencyKey: key.toUpperCase() })).reused, true, "casse de la clé tolérée");
  // Autre clé alors que l'abonnement est en vigueur : refusé, aucun débit.
  assert.equal(await outcome(subscribePro(pool, userId)), "already_subscribed");
  assert.equal(await balanceOf(pool, userId), big(15_000));
  // Même clé pour un autre plan : conflit.
  await pool.query(
    `WITH p AS (INSERT INTO plans (id, code) VALUES (gen_random_uuid(), 'equipe') RETURNING id)
     INSERT INTO plan_versions (id, plan_id, version, name, monthly_price_xof, promo_credits_xof, max_online_offers, entitlements)
     SELECT gen_random_uuid(), id, 1, 'Équipe', 20000, 0, 300, ARRAY['badge_pro']::text[] FROM p`);
  assert.equal(await outcome(subscribeToPlan({ pool, userId, planCode: "equipe", idempotencyKey: key })), "idempotency_conflict");
  // Plans inconnus ou gratuits.
  assert.equal(await outcome(subscribePro(pool, await makeUser(pool), { plan: "inconnu" })), "plan_not_found");
  assert.equal(await outcome(subscribePro(pool, await makeUser(pool), { plan: "free" })), "plan_not_subscribable");
  await assertWalletGreen(pool, "après le double clic");
});

test("six souscriptions simultanées avec des clés DIFFÉRENTES pour un même utilisateur → exactement UNE réussit, les autres `already_subscribed`, un seul débit", async () => {
  const userId = await makeUser(pool);
  await fund(pool, userId, 60_000);
  const outcomes = await Promise.all(Array.from({ length: 6 }, () => outcome(subscribeToPlan({ pool: widePool, userId, planCode: "pro", idempotencyKey: randomUUID() }))));
  assert.equal(outcomes.filter((code) => code === "ok").length, 1);
  assert.equal(outcomes.filter((code) => code === "already_subscribed").length, 5);
  assert.equal(await balanceOf(pool, userId), big(50_000));
  assert.equal(await countRows(pool, "subscriptions", "user_id = $1", [userId]), 1);
  await assertWalletGreen(pool, "après les souscriptions simultanées");
});

test("crédits promotionnels : jamais pour payer un abonnement ; la souscription ne lit que les crédits payés", async () => {
  // Un utilisateur dont le solde payé est insuffisant mais qui a des crédits promotionnels : refusé.
  const { userId } = await makePro(pool, PRO_PRICE);
  assert.equal(await balanceOf(pool, userId), big(0));
  assert.equal((await readPromoSummary(pool, userId)).balance, big(PRO_PROMO));
  // Il ne peut pas se réabonner (en vigueur) ; un autre utilisateur à 5 000 payés refusé alors que le promotionnel couvrirait.
  const other = await makeUser(pool);
  await fund(pool, other, 5_000);
  assert.equal(await outcome(subscribePro(pool, other)), "insufficient_balance");
});

// ═════════════ 3. Renouvellement (horloge injectable) ═════════════

test("renouvellement : à l'échéance, période suivante contiguë, nouveaux crédits promotionnels, l'ancienne émission expire (écrite) ; idempotent par période", async () => {
  const { userId } = await makePro(pool, 30_000);
  const first = await periodOf(pool, userId);
  assert.equal((await runSubscriptionStep({ pool, userId, now: addMs(first.end, -MINUTE) })).renewed, 0, "avant l'échéance : rien");
  const at = addMs(first.end, MINUTE);
  const step = await runSubscriptionStep({ pool, userId, now: at });
  assert.equal(step.renewed, 1);
  assert.equal(step.promoExpired, 1, "l'émission de la première période expire");
  assert.equal(step.promoExpiredXof, PRO_PROMO);
  assert.deepEqual(step.errors, []);

  const periods = (await pool.query<{ number: number; kind: string; contiguous: boolean }>(
    `SELECT p.number, p.kind, p.starts_at = COALESCE(lag(p.ends_at) OVER (ORDER BY p.number), p.starts_at) AS contiguous
       FROM subscription_periods p WHERE p.user_id = $1 ORDER BY p.number`, [userId])).rows;
  assert.deepEqual(periods, [{ number: 1, kind: "initial", contiguous: true }, { number: 2, kind: "renewal", contiguous: true }]);
  assert.equal(await balanceOf(pool, userId), big(30_000 - 2 * PRO_PRICE));
  assert.equal(await promoLedgerBalance(pool, userId), big(PRO_PROMO), "ancien reste retiré, nouvelle émission de 5 000");
  assert.equal((await readPromoSummary(pool, userId)).balance, big(PRO_PROMO));
  const grants = (await pool.query<{ expired_xof: string | null; reason: string | null }>(
    "SELECT expired_xof::text, expiry_reason AS reason FROM promo_grants WHERE user_id = $1 ORDER BY granted_at", [userId])).rows;
  assert.deepEqual(grants, [{ expired_xof: "5000", reason: "period_end" }, { expired_xof: null, reason: null }]);
  // L'expiration est ÉCRITE au grand livre : une transaction `promo_expiry` (user_promo −5 000, promo_expired +5 000), jamais un effacement.
  const expiry = (await pool.query<{ kind: string; amount: string }>(
    `SELECT a.kind, e.amount::text AS amount FROM wallet_transactions t JOIN wallet_entries e ON e.transaction_id = t.id JOIN wallet_accounts a ON a.id = e.account_id
      WHERE t.kind = 'promo_expiry' AND t.metadata ->> 'promoGrantId' = (SELECT id::text FROM promo_grants WHERE user_id = $1 ORDER BY granted_at LIMIT 1) ORDER BY a.kind`, [userId])).rows;
  assert.deepEqual(expiry, [{ kind: "promo_expired", amount: "5000" }, { kind: "user_promo", amount: "-5000" }]);

  // Idempotent : un second passage au même instant ne refait rien.
  const again = await runSubscriptionStep({ pool, userId, now: at });
  assert.deepEqual({ renewed: again.renewed, pastDue: again.pastDue, ended: again.ended, promoExpired: again.promoExpired }, { renewed: 0, pastDue: 0, ended: 0, promoExpired: 0 });
  assert.equal(await countRows(pool, "subscription_periods", "user_id = $1", [userId]), 2);
  await assertWalletGreen(pool, "après un renouvellement");
});

test("renouvellement en double : deux traitements simultanés de la même échéance → UNE seule période de plus, UN seul débit", async () => {
  const { userId, subscriptionId } = await makePro(pool, 30_000);
  const { end } = await periodOf(pool, userId);
  const now = addMs(end, 2 * MINUTE);
  const outcomes = await Promise.all(Array.from({ length: 6 }, () => processDueSubscription({ pool: widePool, subscriptionId, now })));
  assert.equal(outcomes.filter((result) => result.outcome === "renewed").length, 1);
  assert.equal(outcomes.filter((result) => result.outcome === "skipped").length, 5);
  assert.equal(await countRows(pool, "subscription_periods", "user_id = $1", [userId]), 2);
  assert.equal(await balanceOf(pool, userId), big(30_000 - 2 * PRO_PRICE));
  await assertWalletGreen(pool, "après des renouvellements simultanés");
});

test("worker en retard : un abonné qui a le solde est renouvelé même après plus de 72 h ; si la période suivante serait déjà entièrement passée, elle commence maintenant", async () => {
  const { userId } = await makePro(pool, 30_000);
  const { end } = await periodOf(pool, userId);
  const late = addMs(end, 5 * 24 * HOUR);
  const step = await runSubscriptionStep({ pool, userId, now: late });
  assert.equal(step.renewed, 1);
  assert.equal((await periodOf(pool, userId)).status, "active");
  // Période 2 : contiguë (début = fin de la précédente).
  const contiguous = await scalar<boolean>(pool,
    `SELECT (SELECT starts_at FROM subscription_periods WHERE user_id = $1 AND number = 2) = (SELECT ends_at FROM subscription_periods WHERE user_id = $1 AND number = 1) AS n`, [userId]);
  assert.equal(contiguous, true);
  // Arrêt de plus d'un mois : la période suivante ne démarre pas dans le passé.
  const stale = await makePro(pool, 30_000);
  const staleEnd = (await periodOf(pool, stale.userId)).end;
  const veryLate = addMs(staleEnd, 45 * 24 * HOUR);
  assert.equal((await runSubscriptionStep({ pool, userId: stale.userId, now: veryLate })).renewed >= 1, true);
  const secondStart = await scalar<Date>(pool, "SELECT starts_at AS n FROM subscription_periods WHERE user_id = $1 AND number = 2", [stale.userId]);
  assert.equal(secondStart.getTime() >= veryLate.getTime() - 1000, true, "la période facturée commence à l'instant du traitement, pas dans le passé");
  await assertWalletGreen(pool, "après un worker en retard");
});

// ═════════════ 4. Délai de grâce, fin, pause des annonces ═════════════

test("grâce : solde insuffisant au renouvellement → 3 jours de grâce (droits conservés, avis), nouvelle tentative au plus tous les quarts d'heure, renouvellement réussi après une recharge", async () => {
  const { userId } = await makePro(pool, PRO_PRICE);
  const { end } = await periodOf(pool, userId);
  const first = await runSubscriptionStep({ pool, userId, now: addMs(end, HOUR) });
  assert.equal(first.pastDue, 1);
  assert.equal(first.renewed, 0);
  const state = await periodOf(pool, userId);
  assert.equal(state.status, "past_due");
  assert.equal(state.graceEnds!.getTime(), end.getTime() + 72 * HOUR, "grâce = fin de période + 72 h");
  assert.equal(await countRows(pool, "subscription_periods", "user_id = $1", [userId]), 1, "aucune période de plus");
  assert.equal(await balanceOf(pool, userId), big(0), "aucun débit tenté qui aurait réussi");
  // Pendant la grâce, les droits Pro restent (limite de 100, badge).
  const entitlements = await readUserEntitlements(pool, userId);
  assert.equal(entitlements.source, "subscription");
  assert.equal(entitlements.maxOnlineOffers, 100);
  const notices = await listSubscriptionNotices(pool, userId);
  assert.deepEqual(notices.notices.map((notice) => notice.code), ["renewal_failed"]);
  assert.equal(notices.unreadCount, 1);

  // Moins d'un quart d'heure plus tard : aucune nouvelle tentative ; au-delà, elle a lieu mais échoue (« unchanged »), sans second avis.
  assert.equal((await runSubscriptionStep({ pool, userId, now: addMs(end, HOUR + 5 * MINUTE) })).unchanged, 0);
  assert.equal((await runSubscriptionStep({ pool, userId, now: addMs(end, HOUR + 20 * MINUTE) })).unchanged, 1);
  assert.equal((await listSubscriptionNotices(pool, userId)).notices.length, 1, "un seul avis par événement");

  // Recharge : la tentative suivante réussit ; la période suivante est contiguë et l'abonnement redevient actif.
  await fund(pool, userId, PRO_PRICE);
  const renewed = await runSubscriptionStep({ pool, userId, now: addMs(end, 3 * HOUR) });
  assert.equal(renewed.renewed, 1);
  const after = await periodOf(pool, userId);
  assert.equal(after.status, "active");
  assert.equal(after.graceEnds, null);
  assert.equal(after.start.getTime(), end.getTime(), "période contiguë malgré la grâce");
  assert.equal(await balanceOf(pool, userId), big(0));
  await assertWalletGreen(pool, "après une grâce suivie d'un renouvellement");
});

test("grâce écoulée : l'abonnement prend fin, retour au plan Gratuit, les annonces au-delà de la limite passent en pause (les plus anciennes d'abord), le vendeur est averti ; la publication est ensuite limitée", async () => {
  const { userId } = await makePro(pool, PRO_PRICE);
  const offers = [];
  for (let index = 0; index < 15; index += 1) offers.push(await makeOffer(pool, userId));
  const { end } = await periodOf(pool, userId);
  await runSubscriptionStep({ pool, userId, now: addMs(end, HOUR) });
  assert.equal(await countRows(pool, "offers", "owner_id = $1 AND status = 'published'", [userId]), 15, "pendant la grâce, aucune annonce n'est mise en pause");

  const outboxBefore = await countRows(pool, "matching_outbox_events");
  const step = await runSubscriptionStep({ pool, userId, now: addMs(end, 73 * HOUR) });
  assert.equal(step.ended, 1);
  assert.equal(step.pausedOffers, 5);
  const finalState = await scalar<string>(pool, "SELECT status AS n FROM subscriptions WHERE user_id = $1", [userId]);
  assert.equal(finalState, "ended");
  assert.equal(await scalar(pool, "SELECT ended_reason AS n FROM subscriptions WHERE user_id = $1", [userId]), "payment_failed");
  // Les 5 plus ANCIENNES sont en pause, les 10 plus récentes restent en ligne.
  const paused = (await pool.query<{ id: string }>("SELECT id FROM offers WHERE owner_id = $1 AND status = 'paused' ORDER BY created_at", [userId])).rows.map((row) => row.id);
  assert.deepEqual(paused, offers.slice(0, 5).map((offer) => offer.id));
  const online = (await pool.query<{ id: string }>("SELECT id FROM offers WHERE owner_id = $1 AND status = 'published' ORDER BY created_at", [userId])).rows.map((row) => row.id);
  assert.deepEqual(online, offers.slice(5).map((offer) => offer.id));
  assert.ok(await countRows(pool, "matching_outbox_events") >= outboxBefore + 5, "chaque pause émet son événement (correspondances invalidées par le même chemin que pauseOffer)");
  // Avis : renouvellement refusé, abonnement terminé, annonces mises en pause (avec leur nombre).
  const notices = (await listSubscriptionNotices(pool, userId)).notices;
  assert.deepEqual(notices.map((notice) => notice.code).sort(), ["listings_paused", "renewal_failed", "subscription_ended"]);
  assert.equal(notices.find((notice) => notice.code === "listings_paused")!.listingCount, 5);
  // Plan Gratuit : limite de 10, plus de badge ; remettre une annonce en ligne est refusé (limite), une annonce en pause libère une place.
  const free = await readUserEntitlements(pool, userId);
  assert.equal(free.source, "free");
  assert.equal(free.maxOnlineOffers, 10);
  const extraDraft = await makeOffer(pool, userId, { status: "draft" });
  assert.equal(await outcome(publishOffer(userId, extraDraft.id, extraDraft.contentVersion, pool)), "offer_limit", "publier une onzième annonce est refusé");
  const oldest = (await pool.query<{ id: string; content_version: number }>("SELECT id, content_version FROM offers WHERE id = $1", [paused[0]])).rows[0];
  assert.equal(await outcome(publishOffer(userId, oldest.id, oldest.content_version, pool)), "offer_limit");
  // Le solde, lui, n'a pas bougé (aucun remboursement automatique) et les crédits promotionnels de la période sont expirés.
  assert.equal(await balanceOf(pool, userId), big(0));
  assert.equal((await readPromoSummary(pool, userId)).balance, big(0));
  assert.equal(await promoLedgerBalance(pool, userId), big(0));
  // Une seconde exécution ne refait rien.
  assert.equal((await runSubscriptionStep({ pool, userId, now: addMs(end, 74 * HOUR) })).ended, 0);
  await assertWalletGreen(pool, "après la fin d'un abonnement");
});

test("worker arrêté plus de 72 h et solde insuffisant : la grâce est déjà écoulée, l'abonnement prend fin directement (aucune période de plus, aucun débit)", async () => {
  const { userId } = await makePro(pool, PRO_PRICE);
  const { end } = await periodOf(pool, userId);
  const step = await runSubscriptionStep({ pool, userId, now: addMs(end, 100 * HOUR) });
  assert.equal(step.ended, 1);
  assert.equal(step.pastDue, 0);
  assert.equal(await scalar(pool, "SELECT ended_reason AS n FROM subscriptions WHERE user_id = $1", [userId]), "payment_failed");
  assert.equal(await countRows(pool, "subscription_periods", "user_id = $1", [userId]), 1);
  await assertWalletGreen(pool, "après une fin directe");
});

test("l'étape « subscriptions » du worker (runMatchingCycle) renouvelle, expire et rend son résultat ; un cycle sans échéance n'a rien à faire", async () => {
  const { userId } = await makePro(pool, 30_000);
  const quiet = await runMatchingCycle({ pool, workerId: "sub-test-quiet", notificationTransport: null });
  assert.equal(quiet.subscriptions.skipped, false);
  assert.equal(quiet.subscriptions.renewed, 0);
  assert.deepEqual(quiet.errors, []);
  // Période échue (on rapproche l'échéance : la fenêtre de la période est figée par la garde, on injecte l'horloge via l'étape directe).
  const { end } = await periodOf(pool, userId);
  const step = await runSubscriptionStep({ pool, userId, now: addMs(end, MINUTE) });
  assert.equal(step.renewed, 1);
  assert.equal(typeof quiet.subscriptions.promoExpired, "number");
});

// ═════════════ 5. Annulation ═════════════

test("annulation : le renouvellement est désactivé, les droits restent jusqu'à la fin de la période, aucun remboursement, fin à l'échéance sans débit ; réactivation possible pendant la période", async () => {
  const { userId } = await makePro(pool, 15_000);
  const { end } = await periodOf(pool, userId);
  assert.deepEqual(await setSubscriptionAutoRenew({ pool, userId, autoRenew: false }), { autoRenew: false, changed: true });
  assert.deepEqual(await setSubscriptionAutoRenew({ pool, userId, autoRenew: false }), { autoRenew: false, changed: false }, "idempotent");
  assert.equal((await readUserEntitlements(pool, userId)).planCode, "pro", "les droits restent jusqu'à la fin de la période");
  assert.equal(await balanceOf(pool, userId), big(5_000), "aucun remboursement");
  const state = await readSubscriptionState({ pool, userId });
  assert.equal(state.subscription!.autoRenew, false);
  assert.ok(state.subscription!.canceledAt instanceof Date);
  // Réactiver pendant la période, puis annuler de nouveau.
  assert.equal((await setSubscriptionAutoRenew({ pool, userId, autoRenew: true })).changed, true);
  assert.equal((await readSubscriptionState({ pool, userId })).subscription!.canceledAt, null);
  await setSubscriptionAutoRenew({ pool, userId, autoRenew: false });
  // Après la fin de la période (horloge injectée) : plus de réactivation possible.
  assert.equal(await outcome(setSubscriptionAutoRenew({ pool, userId, autoRenew: true, now: addMs(end, MINUTE) })), "period_ended");
  // À l'échéance : fin (motif « canceled »), aucun débit, aucune période de plus, crédits promotionnels expirés.
  const step = await runSubscriptionStep({ pool, userId, now: addMs(end, MINUTE) });
  assert.equal(step.ended, 1);
  assert.equal(step.renewed, 0);
  assert.equal(await scalar(pool, "SELECT ended_reason AS n FROM subscriptions WHERE user_id = $1", [userId]), "canceled");
  assert.equal(await balanceOf(pool, userId), big(5_000));
  assert.equal(await countRows(pool, "subscription_periods", "user_id = $1", [userId]), 1);
  assert.equal(await promoLedgerBalance(pool, userId), big(0));
  assert.equal((await readUserEntitlements(pool, userId)).source, "free");
  assert.equal(await outcome(setSubscriptionAutoRenew({ pool, userId, autoRenew: true })), "no_subscription");
  assert.equal(await outcome(setSubscriptionAutoRenew({ pool, userId: await makeUser(pool), autoRenew: false })), "no_subscription");
  await assertWalletGreen(pool, "après une annulation");
});

test("une annulation perd ses droits à la seconde où la période se termine, même si le worker n'a pas encore tourné ; un renouvellement automatique les garde jusqu'à la décision du worker", async () => {
  const longAgo = new Date(Date.now() - 40 * 24 * HOUR);
  const canceled = await makePro(pool, 10_000, longAgo);
  const renewing = await makePro(pool, 10_000, longAgo);
  await setSubscriptionAutoRenew({ pool, userId: canceled.userId, autoRenew: false, now: longAgo });
  assert.equal((await readUserEntitlements(pool, canceled.userId)).source, "free", "période terminée, renouvellement désactivé : plus de droits");
  assert.equal((await readUserEntitlements(pool, renewing.userId)).source, "subscription", "renouvellement activé : droits gardés jusqu'à la décision du worker");
  // Les crédits promotionnels de ces périodes terminées ne sont plus dépensables (échéance dépassée à l'heure de la base), même avant leur expiration écrite.
  assert.equal((await readPromoSummary(pool, canceled.userId)).balance, big(0));
  assert.equal(await promoLedgerBalance(pool, canceled.userId), big(PRO_PROMO), "le grand livre porte encore les crédits échus jusqu'au passage du worker");
  const report = await runWalletCheck(pool);
  assert.ok(report.warnings.some((warning) => warning.code === "promo_expiry_overdue"), "avertissement : expiration en retard");
  assert.ok(report.warnings.some((warning) => warning.code === "subscription_overdue"), "avertissement : abonnement échu non traité");
  assert.deepEqual(report.violations, []);
  // Le worker conclut : l'expiration est écrite et les avertissements disparaissent pour ces utilisateurs.
  for (const user of [canceled.userId, renewing.userId]) await runSubscriptionStep({ pool, userId: user, now: new Date() });
  assert.equal(await promoLedgerBalance(pool, canceled.userId), big(0));
  assert.equal(await countRows(pool, "promo_grants", "user_id = $1 AND expired_at IS NOT NULL", [canceled.userId]), 1);
});

test("badge « Vendeur Pro » (lecture serveur) : vrai SEULEMENT pour un abonnement en vigueur ; faux pour un compte gratuit, un compte inconnu, un abonnement terminé, une période terminée sans renouvellement", async () => {
  const free = await makeUser(pool);
  const pro = await makePro(pool, PRO_PRICE);
  const unknown = randomUUID();
  const badges = await readProBadges(pool, [free, pro.userId, unknown, free]);
  assert.deepEqual([badges.get(free), badges.get(pro.userId), badges.get(unknown)], [false, true, false]);
  assert.equal(badges.size, 3, "un utilisateur répété n'est compté qu'une fois");
  assert.equal((await readProBadges(pool, [])).size, 0);
  // Annulation : le badge reste jusqu'à la fin de la période, puis disparaît (fin de l'abonnement par le worker).
  const { end } = await periodOf(pool, pro.userId);
  await setSubscriptionAutoRenew({ pool, userId: pro.userId, autoRenew: false });
  assert.equal((await readProBadges(pool, [pro.userId])).get(pro.userId), true, "période payée : le badge reste");
  await runSubscriptionStep({ pool, userId: pro.userId, now: addMs(end, MINUTE) });
  assert.equal((await readProBadges(pool, [pro.userId])).get(pro.userId), false, "abonnement terminé : plus de badge");
  // Période terminée sans renouvellement automatique : plus de badge même si le worker n'a pas tourné.
  const longAgo = new Date(Date.now() - 40 * 24 * HOUR);
  const lapsed = await makePro(pool, 10_000, longAgo);
  await setSubscriptionAutoRenew({ pool, userId: lapsed.userId, autoRenew: false, now: longAgo });
  assert.equal((await readProBadges(pool, [lapsed.userId])).get(lapsed.userId), false);
});

// ═════════════ 6. Expiration des crédits promotionnels ═════════════

test("expiration : jamais avant l'échéance, ÉCRITE au grand livre pour le reste exact (jamais un effacement), une seule fois ; l'émission close ne se dépense plus", async () => {
  const { userId } = await makePro(pool, 10_000);
  const grantId = await scalar<string>(pool, "SELECT id AS n FROM promo_grants WHERE user_id = $1", [userId]);
  const { end } = await periodOf(pool, userId);
  const transactionsBefore = await countRows(pool, "wallet_transactions");
  // Avant l'échéance : rien.
  assert.equal(await expirePromoGrant({ pool, grantId, now: addMs(end, -MINUTE) }), null);
  assert.equal(await promoLedgerBalance(pool, userId), big(PRO_PROMO));
  assert.equal(await countRows(pool, "wallet_transactions"), transactionsBefore, "aucune écriture avant l'échéance");
  // À l'échéance : une transaction `promo_expiry` du reste exact.
  const expired = await expirePromoGrant({ pool, grantId, now: addMs(end, MINUTE) });
  assert.deepEqual(expired, { expiredXof: big(PRO_PROMO) });
  assert.equal(await countRows(pool, "wallet_transactions"), transactionsBefore + 1, "l'expiration est une ÉCRITURE de plus, jamais un effacement");
  assert.equal(await countRows(pool, "wallet_transactions", "kind = 'promo_expiry'"), await countRows(pool, "promo_grants", "expired_xof > 0"));
  assert.equal(await promoLedgerBalance(pool, userId), big(0));
  const row = (await pool.query<{ expired_xof: string; reason: string; tx: string | null }>(
    "SELECT expired_xof::text, expiry_reason AS reason, expiry_transaction_id::text AS tx FROM promo_grants WHERE id = $1", [grantId])).rows[0];
  assert.equal(row.expired_xof, "5000");
  assert.equal(row.reason, "period_end");
  assert.ok(row.tx);
  // Une seule fois.
  assert.equal(await expirePromoGrant({ pool, grantId, now: addMs(end, 2 * MINUTE) }), null);
  assert.equal(await countRows(pool, "wallet_transactions", "kind = 'promo_expiry' AND metadata ->> 'promoGrantId' = $1", [grantId]), 1);
  // L'expiration anticipée est refusée par la base (jamais écrite avant l'échéance) : tentative directe sur une autre émission.
  const other = await makePro(pool, 10_000);
  const otherGrant = await scalar<string>(pool, "SELECT id AS n FROM promo_grants WHERE user_id = $1", [other.userId]);
  const early = await failureOf((client) => client.query(
    "UPDATE promo_grants SET expired_xof = 5000, expired_at = clock_timestamp(), expiry_reason = 'period_end', expiry_transaction_id = NULL WHERE id = $1", [otherGrant]));
  assert.equal(early?.constraint, "trg_promo_grants_guard", "expiration de fin de période avant l'échéance refusée");
  await assertWalletGreen(pool, "après une expiration");
});

// ═════════════ 7. Limite d'annonces en ligne ═════════════

test("limite d'annonces en ligne du plan Gratuit : la onzième est refusée (publication, remise en ligne), brouillons et archives ne comptent pas, une pause libère une place", async () => {
  const userId = await makeUser(pool);
  const created = [];
  for (let index = 0; index < 10; index += 1) created.push(await makeOffer(pool, userId));
  const draft = await makeOffer(pool, userId, { status: "draft" });
  assert.equal(draft.status, "draft", "un brouillon ne compte pas");
  assert.equal(await outcome(publishOffer(userId, draft.id, draft.contentVersion, pool)), "offer_limit", "la publication d'un brouillon au-delà de la limite est refusée");
  assert.equal(await countRows(pool, "offers", "owner_id = $1 AND status = 'published'", [userId]), 10, "rien n'a été publié de trop");
  // Une pause libère une place.
  await pauseOffer(userId, created[0].id, created[0].contentVersion, pool);
  const published = await publishOffer(userId, draft.id, draft.contentVersion, pool);
  assert.equal(published.status, "published");
  // La remise en ligne de l'annonce mise en pause est maintenant refusée (plan plein).
  const paused = (await pool.query<{ content_version: number }>("SELECT content_version FROM offers WHERE id = $1", [created[0].id])).rows[0];
  assert.equal(await outcome(publishOffer(userId, created[0].id, paused.content_version, pool)), "offer_limit");
  // Les annonces archivées ne comptent pas.
  const current = (await pool.query<{ content_version: number }>("SELECT content_version FROM offers WHERE id = $1", [created[1].id])).rows[0];
  await archiveOffer(userId, created[1].id, current.content_version, pool);
  assert.equal((await publishOffer(userId, created[0].id, paused.content_version, pool)).status, "published");
  // La limite est PAR utilisateur : un autre publie sans gêne.
  const other = await makeUser(pool);
  const otherDraft = await makeOffer(pool, other, { status: "draft" });
  assert.equal((await publishOffer(other, otherDraft.id, otherDraft.contentVersion, pool)).status, "published");
});

test("publications concurrentes : 5 brouillons publiés en même temps avec 8 annonces déjà en ligne (limite 10) → exactement 2 réussissent, jamais 11", async () => {
  const userId = await makeUser(pool);
  for (let index = 0; index < 8; index += 1) await makeOffer(pool, userId);
  const drafts = [];
  for (let index = 0; index < 5; index += 1) drafts.push(await makeOffer(pool, userId, { status: "draft" }));
  const outcomes = await Promise.all(drafts.map((draft) => outcome(publishOffer(userId, draft.id, draft.contentVersion, widePool))));
  assert.equal(outcomes.filter((code) => code === "ok").length, 2, outcomes.join(","));
  assert.equal(outcomes.filter((code) => code === "offer_limit").length, 3);
  assert.equal(await countRows(pool, "offers", "owner_id = $1 AND status = 'published'", [userId]), 10);
});

test("limite du plan Pro (100) et d'un plan sur mesure : la limite vient de la version en vigueur, lue côté serveur", async () => {
  await pool.query(
    `WITH p AS (INSERT INTO plans (id, code) VALUES (gen_random_uuid(), 'mini') RETURNING id)
     INSERT INTO plan_versions (id, plan_id, version, name, monthly_price_xof, promo_credits_xof, max_online_offers, entitlements)
     SELECT gen_random_uuid(), id, 1, 'Mini', 1000, 0, 3, ARRAY['badge_pro']::text[] FROM p`);
  const userId = await makeUser(pool);
  await fund(pool, userId, 1_000);
  await subscribeToPlan({ pool, userId, planCode: "mini", idempotencyKey: randomUUID() });
  assert.equal((await readUserEntitlements(pool, userId)).maxOnlineOffers, 3);
  for (let index = 0; index < 3; index += 1) await makeOffer(pool, userId);
  const fourth = await makeOffer(pool, userId, { status: "draft" });
  assert.equal(await outcome(publishOffer(userId, fourth.id, fourth.contentVersion, pool)), "offer_limit", "limite du plan sur mesure : 3, pas 10 ni 100");
  const pro = await makePro(pool, PRO_PRICE);
  for (let index = 0; index < 12; index += 1) {
    const draft = await makeOffer(pool, pro.userId, { status: "draft" });
    await publishOffer(pro.userId, draft.id, draft.contentVersion, pool);
  }
  assert.equal(await countRows(pool, "offers", "owner_id = $1 AND status = 'published'", [pro.userId]), 12, "Pro : plus de 10 annonces en ligne");
});

// ═════════════ 8. Remboursement d'une période (administration) ═════════════

test("remboursement d'une période : prix intégral recrédité, reste promotionnel inutilisé annulé (écrit), abonnement terminé, annonces au-delà de la limite en pause ; un seul remboursement", async () => {
  const { userId, periodId } = await makePro(pool, 10_000);
  const offers = [];
  for (let index = 0; index < 13; index += 1) offers.push(await makeOffer(pool, userId));
  const snapshotBefore = await systemBalance(pool, "subscription_revenue");
  const result = await refundSubscriptionPeriod({ pool, periodId, reasonCode: "geste_commercial" });
  assert.equal(result.refundedAmount, big(PRO_PRICE));
  assert.equal(result.promoCancelled, big(PRO_PROMO));
  assert.equal(result.subscriptionEnded, true);
  assert.equal(result.pausedOffers, 3);
  assert.equal(result.balance, big(PRO_PRICE));
  assert.equal(await balanceOf(pool, userId), big(PRO_PRICE), "intégral, aucun prorata");
  assert.equal(await promoLedgerBalance(pool, userId), big(0));
  assert.equal(await systemBalance(pool, "subscription_revenue"), snapshotBefore - big(PRO_PRICE));
  assert.equal(await scalar(pool, "SELECT ended_reason AS n FROM subscriptions WHERE user_id = $1", [userId]), "refunded");
  assert.equal(await countRows(pool, "offers", "owner_id = $1 AND status = 'paused'", [userId]), 3);
  // Transaction du remboursement : référence dérivée de la période, motif conservé, deux écritures de prix et deux de reste promotionnel.
  const tx = (await pool.query<{ reference: string; metadata: Record<string, string>; entries: number }>(
    `SELECT t.reference, t.metadata, (SELECT count(*)::int FROM wallet_entries e WHERE e.transaction_id = t.id) AS entries
       FROM wallet_transactions t WHERE t.kind = 'subscription_refund'`)).rows;
  assert.deepEqual(tx.map((row) => row.entries), [4]);
  assert.equal(tx[0].reference, `subscription_refund:${periodId}`);
  assert.deepEqual(tx[0].metadata, { subscriptionPeriodId: periodId, reasonCode: "geste_commercial" });
  assert.equal(await outcome(refundSubscriptionPeriod({ pool, periodId, reasonCode: "encore" })), "already_refunded");
  assert.equal(await outcome(refundSubscriptionPeriod({ pool, periodId: randomUUID(), reasonCode: "inconnu" })), "period_not_found");
  assert.equal(await balanceOf(pool, userId), big(PRO_PRICE));
  await assertWalletGreen(pool, "après le remboursement d'une période");

  // Deux remboursements simultanés : un seul passe.
  const other = await makePro(pool, 10_000);
  const outcomes = await Promise.all(Array.from({ length: 5 }, () => outcome(refundSubscriptionPeriod({ pool: widePool, periodId: other.periodId, reasonCode: "double" }))));
  assert.equal(outcomes.filter((code) => code === "ok").length, 1, outcomes.join(","));
  assert.equal(outcomes.filter((code) => code === "already_refunded").length, 4);
  assert.equal(await balanceOf(pool, other.userId), big(PRO_PRICE));
  await assertWalletGreen(pool, "après des remboursements simultanés");
});

test("le remboursement d'une ancienne période ne termine pas l'abonnement renouvelé ; les crédits promotionnels déjà expirés ne sont pas repris", async () => {
  const { userId, periodId } = await makePro(pool, 30_000);
  const { end } = await periodOf(pool, userId);
  await runSubscriptionStep({ pool, userId, now: addMs(end, MINUTE) });
  const result = await refundSubscriptionPeriod({ pool, periodId, reasonCode: "ancienne_periode" });
  assert.equal(result.subscriptionEnded, false, "la période courante est la deuxième");
  assert.equal(result.promoCancelled, big(0), "l'émission de la première période était déjà expirée");
  assert.equal((await periodOf(pool, userId)).status, "active");
  assert.equal(await balanceOf(pool, userId), big(30_000 - 2 * PRO_PRICE + PRO_PRICE));
  await assertWalletGreen(pool, "après le remboursement d'une ancienne période");
});

// ═════════════ 9. wallet:check sur l'offre Pro ═════════════

test("wallet:check : vert sur une base saine ; chaque corruption injectée (transaction annulée) est détectée par SON contrôle", async () => {
  const { userId, periodId } = await makePro(pool, 10_000);
  const green = await runWalletCheck(pool);
  assert.deepEqual(green.violations, []);
  const grant = (await pool.query<{ id: string; tx: string }>("SELECT id, grant_transaction_id AS tx FROM promo_grants WHERE period_id = $1", [periodId])).rows[0];
  const codesIn = async (corrupt: (client: PoolClient) => Promise<void>): Promise<string[]> => {
    const client = await txPool.connect();
    try {
      await client.query("BEGIN");
      await corrupt(client);
      const report = await runWalletCheck(client);
      await client.query("ROLLBACK");
      return report.violations.map((violation) => violation.code);
    } finally {
      client.release();
    }
  };
  // Solde promotionnel falsifié.
  assert.ok((await codesIn(async (client) => {
    await client.query("ALTER TABLE wallet_accounts DISABLE TRIGGER trg_wallet_accounts_guard");
    await client.query("UPDATE wallet_accounts SET balance = balance + 7 WHERE kind = 'user_promo' AND owner_id = $1", [userId]);
  })).includes("promo_balance_mismatch"));
  // Émission falsifiée (montant) : écriture ≠ émission.
  assert.ok((await codesIn(async (client) => {
    await client.query("ALTER TABLE promo_grants DISABLE TRIGGER trg_promo_grants_guard");
    await client.query("ALTER TABLE promo_grants DISABLE TRIGGER USER");
    await client.query("UPDATE promo_grants SET amount_xof = amount_xof + 1 WHERE id = $1", [grant.id]);
  })).includes("promo_grant_mismatch"));
  // Expiration écrite AVANT l'échéance.
  assert.ok((await codesIn(async (client) => {
    await client.query("ALTER TABLE promo_grants DISABLE TRIGGER trg_promo_grants_guard");
    await client.query(
      "UPDATE promo_grants SET expired_xof = 0, expired_at = expires_at - interval '1 day', expiry_reason = 'period_end', expiry_transaction_id = NULL WHERE id = $1", [grant.id]);
  })).includes("promo_expired_early"));
  // Reste négatif (dépense au-delà de l'émission).
  assert.ok((await codesIn(async (client) => {
    await client.query("ALTER TABLE promo_movements DISABLE TRIGGER trg_promo_movements_guard");
    await client.query("ALTER TABLE promo_movements DISABLE TRIGGER trg_promo_movements_covered");
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query(
      `INSERT INTO promo_movements (id, grant_id, kind, amount_xof, purchase_id, transaction_id)
       VALUES (gen_random_uuid(), $1, 'spend', 9000, gen_random_uuid(), $2)`, [grant.id, grant.tx]);
  })).includes("promo_remaining_negative"));
  // Compte promotionnel touché par un ajustement (ni recharge, ni ajustement, ni retrait).
  assert.ok((await codesIn(async (client) => {
    await client.query("ALTER TABLE wallet_entries DISABLE TRIGGER trg_wallet_entries_account_usage");
    const tx = randomUUID();
    await client.query("INSERT INTO wallet_transactions (id, kind, reference, metadata) VALUES ($1, 'adjustment', $2, '{\"reasonCode\":\"fraude\"}'::jsonb)", [tx, `adjustment:${tx}`]);
    await client.query(
      `INSERT INTO wallet_entries (id, transaction_id, account_id, amount)
       SELECT gen_random_uuid(), $1, id, 100 FROM wallet_accounts WHERE kind = 'user_promo' AND owner_id = $2`, [tx, userId]);
    await client.query("INSERT INTO wallet_entries (id, transaction_id, account_id, amount) SELECT gen_random_uuid(), $1, id, -100 FROM wallet_accounts WHERE kind = 'boost_revenue'", [tx]);
  })).includes("promo_account_misuse"));
  // Écriture de la période falsifiée.
  assert.ok((await codesIn(async (client) => {
    await client.query("ALTER TABLE wallet_entries DISABLE TRIGGER trg_wallet_entries_immutable");
    await client.query("UPDATE wallet_entries SET amount = amount - 1 WHERE transaction_id = $1 AND amount = -10000", [grant.tx]);
  })).includes("subscription_period_mismatch"));
  // État de l'abonnement ≠ dernière période.
  assert.ok((await codesIn(async (client) => {
    await client.query("UPDATE subscriptions SET current_period_end = current_period_end + interval '1 day' WHERE user_id = $1", [userId]);
  })).includes("subscription_state_mismatch"));
  // Revenus d'abonnement falsifiés.
  assert.ok((await codesIn(async (client) => {
    await client.query("ALTER TABLE wallet_accounts DISABLE TRIGGER trg_wallet_accounts_guard");
    await client.query("UPDATE wallet_accounts SET balance = balance + 1 WHERE kind = 'subscription_revenue'");
  })).includes("subscription_revenue_mismatch"));
  // Émissions effacées : la période n'a plus son émission, et promo_issuance ne correspond plus.
  const missing = await codesIn(async (client) => {
    await client.query("ALTER TABLE promo_grants DISABLE TRIGGER trg_promo_grants_guard");
    await client.query("DELETE FROM promo_grants WHERE id = $1", [grant.id]);
  });
  assert.ok(missing.includes("promo_grant_missing") && missing.includes("promo_issuance_mismatch"), missing.join(","));
  // Transaction d'abonnement orpheline (sans période).
  assert.ok((await codesIn(async (client) => {
    await client.query("SET LOCAL session_replication_role = replica");
    const tx = randomUUID();
    await client.query("INSERT INTO wallet_transactions (id, kind, reference, metadata) VALUES ($1, 'subscription_charge', $2, $3::jsonb)", [tx, `subscription_charge:${tx}`, JSON.stringify({ subscriptionPeriodId: tx })]);
  })).includes("subscription_charge_transaction_orphan"));
  // Après tout cela, le schéma propre est resté sain.
  await assertWalletGreen(pool, "le schéma propre n'a jamais été corrompu");
});

test("le solde promotionnel ne peut jamais être négatif : une écriture qui le rendrait négatif échoue (insufficient_balance), rien n'est écrit", async () => {
  const { userId } = await makePro(pool, 10_000);
  const snapshot = await ledgerSnapshot(pool);
  const phantomGrant = randomUUID();
  const outcomeOf = await outcome(recordWalletTransaction(pool, {
    kind: "promo_expiry",
    reference: `promo_expiry:${phantomGrant}`,
    metadata: { promoGrantId: phantomGrant },
    entries: [
      { account: { kind: "user_promo", ownerId: userId }, amount: -big(PRO_PROMO + 1) },
      { account: { kind: "promo_expired" }, amount: big(PRO_PROMO + 1) },
    ],
  }));
  assert.equal(outcomeOf, "insufficient_balance");
  assert.deepEqual(await ledgerSnapshot(pool), snapshot);
});

test("aucun type de transaction ne touche un compte promotionnel hors de son rôle : ajustement, recharge, retrait refusés par le code ET par la base", async () => {
  const { userId } = await makePro(pool, 10_000);
  const attempt = (kind: "adjustment" | "topup", amount: bigint, account: "user_promo" | "promo_expired") => outcome(recordWalletTransaction(pool, {
    kind,
    reference: kind === "adjustment" ? `adjustment:${randomUUID()}` : `topup:${randomUUID()}`,
    metadata: kind === "adjustment" ? { reasonCode: "fraude" } : { paymentIntentId: randomUUID() },
    entries: [
      { account: account === "user_promo" ? { kind: "user_promo", ownerId: userId } : { kind: "promo_expired" }, amount },
      { account: { kind: "boost_revenue" }, amount: -amount },
    ],
  } as never));
  // Le code refuse avant tout SQL (CatalogValidationError) : crédit ou retrait.
  assert.match(await attempt("adjustment", big(100), "user_promo"), /CatalogValidationError/);
  assert.match(await attempt("adjustment", -big(100), "user_promo"), /CatalogValidationError/);
  assert.match(await attempt("adjustment", big(100), "promo_expired"), /CatalogValidationError/);
  // La base refuse aussi (déclencheur d'usage des comptes) quand le code est contourné.
  const failure = await failureOf(async (client) => {
    const tx = randomUUID();
    await client.query("INSERT INTO wallet_transactions (id, kind, reference, metadata) VALUES ($1, 'adjustment', $2, '{\"reasonCode\":\"fraude\"}'::jsonb)", [tx, `adjustment:${tx}`]);
    await client.query("INSERT INTO wallet_entries (id, transaction_id, account_id, amount) SELECT gen_random_uuid(), $1, id, 100 FROM wallet_accounts WHERE kind = 'user_promo' AND owner_id = $2", [tx, userId]);
  });
  assert.equal(failure?.code, "23001");
  await assertWalletGreen(pool, "après les tentatives de détournement");
});

// ═════════════ 10. Prix de la version de l'abonné, annonces mises en pause par la limite du plan ═════════════

/** Un plan payant supplémentaire (version 1) : codes distincts de 'pro', 'mini' et 'equipe' des autres essais. */
async function addPaidPlan(code: string, price: number, promo: number, maxOffers: number): Promise<void> {
  await pool.query(
    `WITH p AS (INSERT INTO plans (id, code) VALUES (gen_random_uuid(), $1) RETURNING id)
     INSERT INTO plan_versions (id, plan_id, version, name, monthly_price_xof, promo_credits_xof, max_online_offers, entitlements)
     SELECT gen_random_uuid(), id, 1, $1, $2::bigint, $3::bigint, $4::int, ARRAY['badge_pro']::text[] FROM p`,
    [code, price, promo, maxOffers],
  );
}

const pausedReason = async (offerId: string): Promise<string | null> => (await pool.query<{ reason: string | null }>("SELECT paused_reason AS reason FROM offers WHERE id = $1", [offerId])).rows[0].reason;
const statusOf = async (offerId: string): Promise<string> => (await pool.query<{ status: string }>("SELECT status FROM offers WHERE id = $1", [offerId])).rows[0].status;

/** Un vendeur Pro qui a 15 annonces en ligne (la plus ancienne d'abord dans le tableau), puis dont l'abonnement est annulé et conclu : les 5 plus anciennes passent en pause (`plan_limit`). */
async function endedProSeller(credit: number, offerCount: number): Promise<{ userId: string; offers: Awaited<ReturnType<typeof makeOffer>>[]; endedAt: Date }> {
  const userId = await makeUser(pool);
  await fund(pool, userId, credit);
  await subscribePro(pool, userId);
  const offers: Awaited<ReturnType<typeof makeOffer>>[] = [];
  for (let index = 0; index < offerCount; index += 1) offers.push(await makeOffer(pool, userId));
  const { end } = await periodOf(pool, userId);
  await setSubscriptionAutoRenew({ pool, userId, autoRenew: false });
  const endedAt = addMs(end, MINUTE);
  const step = await runSubscriptionStep({ pool, userId, now: endedAt });
  assert.equal(step.ended, 1);
  return { userId, offers, endedAt };
}

test("une nouvelle version d'un plan ne s'applique qu'aux NOUVELLES souscriptions : un abonné à 10 000 XOF est renouvelé à 10 000 (jamais au prix de la version 2), avec les crédits promotionnels de SA version ; l'écran lit ce prix exact", async () => {
  await addPaidPlan("atelier", 10_000, 2_000, 50);
  const userId = await makeUser(pool);
  await fund(pool, userId, 30_000);
  await subscribePro(pool, userId, { plan: "atelier" });
  const version2 = await createPlanVersion({
    pool, planCode: "atelier", name: "atelier", monthlyPriceXof: 25_000, promoCreditsXof: 9_000, maxOnlineOffers: 80, entitlements: ["badge_pro"], createdBy: await makeUser(pool),
  });
  assert.equal(version2.version, 2);
  const before = (await readSubscriptionState({ pool, userId })).subscription!;
  assert.deepEqual([before.currentPriceXof, before.renewalPriceXof], [big(10_000), big(10_000)], "l'écran affiche le prix exact du prochain renouvellement : celui de sa version");

  const first = await periodOf(pool, userId);
  const step = await runSubscriptionStep({ pool, userId, now: addMs(first.end, MINUTE) });
  assert.deepEqual([step.renewed, step.pastDue, step.errors], [1, 0, []]);
  assert.equal(await balanceOf(pool, userId), big(10_000), "30 000 − 10 000 − 10 000 : jamais un débit de 25 000");
  const periods = () => pool.query<{ number: number; price: string; promo: string; version: number }>(
    `SELECT p.number, p.price_xof::text AS price, p.promo_credits_xof::text AS promo, v.version FROM subscription_periods p JOIN plan_versions v ON v.id = p.plan_version_id
      WHERE p.user_id = $1 ORDER BY p.number`, [userId]).then((result) => result.rows);
  assert.deepEqual(await periods(), [{ number: 1, price: "10000", promo: "2000", version: 1 }, { number: 2, price: "10000", promo: "2000", version: 1 }]);

  // Le solde restant (10 000) ne suffirait pas à la version 2 : l'abonné est tout de même renouvelé, à SON prix.
  const second = await periodOf(pool, userId);
  const step2 = await runSubscriptionStep({ pool, userId, now: addMs(second.end, MINUTE) });
  assert.deepEqual([step2.renewed, step2.pastDue], [1, 0]);
  assert.equal(await balanceOf(pool, userId), big(0));
  assert.equal(await scalar(pool, "SELECT v.version AS n FROM subscriptions s JOIN plan_versions v ON v.id = s.plan_version_id WHERE s.user_id = $1", [userId]), 1);
  assert.equal(await promoLedgerBalance(pool, userId), big(2_000), "les crédits promotionnels émis sont ceux de la version 1");
  await assertWalletGreen(pool, "après des renouvellements au prix de la version de l'abonné");

  // Une NOUVELLE souscription (un autre vendeur, ou le même après la fin de son abonnement) paie la version 2.
  const fresh = await makeUser(pool);
  await fund(pool, fresh, 30_000);
  await subscribePro(pool, fresh, { plan: "atelier" });
  assert.equal(await balanceOf(pool, fresh), big(5_000), "une nouvelle souscription est au prix de la version courante (25 000)");
  assert.equal(await scalar(pool, "SELECT v.version AS n FROM subscriptions s JOIN plan_versions v ON v.id = s.plan_version_id WHERE s.user_id = $1", [fresh]), 2);
  await assertWalletGreen(pool, "après une souscription à la version 2");
});

test("annonces mises en pause par la fin de l'abonnement : raison « plan_limit » écrite ; une annonce mise en pause par le vendeur n'a aucune raison ; la raison disparaît dès que le statut change (la base l'impose)", async () => {
  const userId = await makeUser(pool);
  await fund(pool, userId, 10_000);
  await subscribePro(pool, userId);
  const offers: Awaited<ReturnType<typeof makeOffer>>[] = [];
  for (let index = 0; index < 14; index += 1) offers.push(await makeOffer(pool, userId));
  // Le vendeur met lui-même en pause la plus récente.
  const own = offers[13];
  await pauseOffer(userId, own.id, own.contentVersion, pool);
  assert.equal(await statusOf(own.id), "paused");
  assert.equal(await pausedReason(own.id), null, "pause du vendeur : aucune raison");
  const { end } = await periodOf(pool, userId);
  await setSubscriptionAutoRenew({ pool, userId, autoRenew: false });
  const step = await runSubscriptionStep({ pool, userId, now: addMs(end, MINUTE) });
  assert.equal(step.pausedOffers, 3, "13 en ligne, limite Gratuit 10 : les 3 plus anciennes passent en pause");
  for (const offer of offers.slice(0, 3)) assert.deepEqual([await statusOf(offer.id), await pausedReason(offer.id)], ["paused", "plan_limit"]);
  for (const offer of offers.slice(3, 13)) assert.deepEqual([await statusOf(offer.id), await pausedReason(offer.id)], ["published", null]);
  assert.equal(await pausedReason(own.id), null, "la pause du vendeur ne devient jamais une pause « plan_limit »");

  // La base refuse une raison sur une annonce qui n'est pas en pause, et l'efface quand le statut change quel que soit le chemin.
  const published = offers[5];
  await pool.query("UPDATE offers SET paused_reason = 'plan_limit' WHERE id = $1", [published.id]);
  assert.equal(await pausedReason(published.id), null, "une annonce en ligne ne porte jamais de raison de pause (la base l'efface)");
  assert.equal((await failureOf((client) => client.query("UPDATE offers SET paused_reason = 'autre' WHERE id = $1", [offers[0].id])))?.code, "23514", "seule la raison « plan_limit » existe");
  // Le vendeur libère une place puis remet en ligne une annonce « plan_limit » : la raison est effacée.
  const room = offers[12];
  const roomFresh = (await pool.query<{ content_version: number }>("SELECT content_version FROM offers WHERE id = $1", [room.id])).rows[0];
  await pauseOffer(userId, room.id, roomFresh.content_version, pool);
  assert.equal(await pausedReason(room.id), null, "pause du vendeur après la fin de l'abonnement : aucune raison");
  const oldest = (await pool.query<{ content_version: number }>("SELECT content_version FROM offers WHERE id = $1", [offers[0].id])).rows[0];
  assert.equal((await publishOffer(userId, offers[0].id, oldest.content_version, pool)).status, "published");
  assert.equal(await pausedReason(offers[0].id), null, "remise en ligne par le vendeur : la raison est effacée");
  // Archivage d'une annonce « plan_limit » : raison effacée aussi.
  const toArchive = (await pool.query<{ content_version: number }>("SELECT content_version FROM offers WHERE id = $1", [offers[1].id])).rows[0];
  await archiveOffer(userId, offers[1].id, toArchive.content_version, pool);
  assert.deepEqual([await statusOf(offers[1].id), await pausedReason(offers[1].id)], ["archived", null]);
  // Un statut changé par n'importe quel chemin SQL efface la raison (déclencheur de la base).
  await pool.query("UPDATE offers SET status = 'draft' WHERE id = $1", [offers[2].id]);
  assert.equal(await pausedReason(offers[2].id), null);
  // Une pause écrite sans raison explicite n'en reçoit pas.
  await pool.query("UPDATE offers SET status = 'paused' WHERE id = $1", [offers[2].id]);
  assert.equal(await pausedReason(offers[2].id), null);
});

test("re-souscription Pro : les annonces mises en pause par la fin de l'abonnement sont remises en ligne (par le même chemin que la publication), jamais celle que le vendeur avait mise en pause ; un avis le dit ; le double clic ne le fait qu'une fois", async () => {
  const userId = await makeUser(pool);
  await fund(pool, userId, 40_000);
  await subscribePro(pool, userId);
  const offers: Awaited<ReturnType<typeof makeOffer>>[] = [];
  for (let index = 0; index < 14; index += 1) offers.push(await makeOffer(pool, userId));
  const own = offers[13];
  await pauseOffer(userId, own.id, own.contentVersion, pool);
  const { end } = await periodOf(pool, userId);
  await setSubscriptionAutoRenew({ pool, userId, autoRenew: false });
  assert.equal((await runSubscriptionStep({ pool, userId, now: addMs(end, MINUTE) })).pausedOffers, 3);
  assert.equal(await countRows(pool, "offers", "owner_id = $1 AND status = 'published'", [userId]), 10);
  const outboxBefore = await countRows(pool, "matching_outbox_events");
  const versionsBefore = new Map((await pool.query<{ id: string; content_version: number }>("SELECT id, content_version FROM offers WHERE owner_id = $1", [userId])).rows.map((row) => [row.id, row.content_version]));

  const key = randomUUID();
  const results = await Promise.all(Array.from({ length: 6 }, () => subscribeToPlan({ pool: widePool, userId, planCode: "pro", idempotencyKey: key })));
  assert.equal(results.filter((result) => !result.reused).length, 1, "double clic : une seule souscription");
  assert.deepEqual(results.map((result) => result.restoredOffers).sort((a, b) => b - a), [3, 0, 0, 0, 0, 0]);
  for (const offer of offers.slice(0, 3)) assert.deepEqual([await statusOf(offer.id), await pausedReason(offer.id)], ["published", null], "les annonces de la fin d'abonnement sont de nouveau en ligne");
  assert.deepEqual([await statusOf(own.id), await pausedReason(own.id)], ["paused", null], "l'annonce mise en pause par le vendeur reste en pause");
  assert.equal(await countRows(pool, "offers", "owner_id = $1 AND status = 'published'", [userId]), 13);
  for (const offer of offers.slice(0, 3)) {
    const now = (await pool.query<{ content_version: number }>("SELECT content_version FROM offers WHERE id = $1", [offer.id])).rows[0].content_version;
    assert.equal(now, versionsBefore.get(offer.id)! + 1, "même chemin que la publication : version de contenu incrémentée");
  }
  assert.ok(await countRows(pool, "matching_outbox_events") >= outboxBefore + 3, "chaque remise en ligne émet son événement (correspondances réévaluées)");
  const notices = (await listSubscriptionNotices(pool, userId)).notices;
  const restored = notices.filter((notice) => notice.code === "listings_restored");
  assert.equal(restored.length, 1);
  assert.equal(restored[0].listingCount, 3);
  assert.deepEqual(restored[0].stillPaused, { planLimit: 0, byOwner: 1 }, "T3 : plus rien en pause par la limite ; l'annonce mise en pause par le vendeur reste en pause");
  assert.ok(notices.filter((notice) => notice.code !== "listings_restored").every((notice) => notice.stillPaused === null), "T3 : seulement l'avis « remises en ligne »");
  assert.equal(await balanceOf(pool, userId), big(20_000), "un seul débit (deux souscriptions de 10 000 sur 40 000)");
  await assertWalletGreen(pool, "après une re-souscription");
  // Une seconde souscription (après une nouvelle fin) ne touche jamais l'annonce du vendeur : elle n'a pas de raison.
  assert.equal(await pausedReason(own.id), null);
});

test("re-souscription : la remise en ligne s'arrête à la limite du nouveau plan, en commençant par les annonces les plus RÉCENTES ; une souscription sans annonce en pause n'écrit aucun avis", async () => {
  await addPaidPlan("moyen", 5_000, 0, 12);
  const { userId, offers } = await endedProSeller(30_000, 15);
  assert.equal(await countRows(pool, "offers", "owner_id = $1 AND status = 'paused' AND paused_reason = 'plan_limit'", [userId]), 5);
  assert.equal(await countRows(pool, "offers", "owner_id = $1 AND status = 'published'", [userId]), 10);
  const result = await subscribePro(pool, userId, { plan: "moyen" });
  assert.equal(result.restoredOffers, 2, "limite 12, 10 déjà en ligne : deux places");
  assert.equal(await countRows(pool, "offers", "owner_id = $1 AND status = 'published'", [userId]), 12, "jamais au-delà de la limite du nouveau plan");
  // Les deux plus RÉCENTES des cinq (indices 4 et 3) reviennent ; les trois plus anciennes (0, 1, 2) restent en pause avec leur raison.
  for (const offer of [offers[4], offers[3]]) assert.deepEqual([await statusOf(offer.id), await pausedReason(offer.id)], ["published", null]);
  for (const offer of offers.slice(0, 3)) assert.deepEqual([await statusOf(offer.id), await pausedReason(offer.id)], ["paused", "plan_limit"]);
  const notice = (await listSubscriptionNotices(pool, userId)).notices.find((entry) => entry.code === "listings_restored");
  assert.equal(notice?.listingCount, 2);
  assert.deepEqual(notice?.stillPaused, { planLimit: 3, byOwner: 0 }, "T3 : trois annonces restent en pause faute de place dans la limite du plan");
  // Un vendeur dont aucune annonce n'avait été mise en pause par la limite : aucun avis « remises en ligne ».
  const plain = await makePro(pool, 10_000);
  assert.equal((await listSubscriptionNotices(pool, plain.userId)).notices.filter((entry) => entry.code === "listings_restored").length, 0);
  await assertWalletGreen(pool, "après une remise en ligne partielle");
});

test("re-souscription : une annonce archivée entre-temps, ou une annonce dont la raison n'est pas « plan_limit », n'est jamais remise en ligne", async () => {
  const { userId, offers } = await endedProSeller(30_000, 12);
  const paused = offers.slice(0, 2);
  assert.deepEqual(await Promise.all(paused.map((offer) => pausedReason(offer.id))), ["plan_limit", "plan_limit"]);
  const archivedVersion = (await pool.query<{ content_version: number }>("SELECT content_version FROM offers WHERE id = $1", [paused[0].id])).rows[0].content_version;
  await archiveOffer(userId, paused[0].id, archivedVersion, pool);
  const result = await subscribePro(pool, userId);
  assert.equal(result.restoredOffers, 1, "seule l'annonce encore en pause pour la limite revient");
  assert.equal(await statusOf(paused[0].id), "archived");
  assert.equal(await statusOf(paused[1].id), "published");
  // Un vendeur dont une annonce a un numéro caché (règle D3) : elle reste en pause, les autres reviennent.
  const sneaky = await endedProSeller(30_000, 12);
  await pool.query("UPDATE offers SET brand = '07 O8 09 10 11' WHERE id = $1", [sneaky.offers[0].id]);
  const again = await subscribePro(pool, sneaky.userId);
  assert.equal(again.restoredOffers, 1);
  assert.deepEqual([await statusOf(sneaky.offers[0].id), await pausedReason(sneaky.offers[0].id)], ["paused", "plan_limit"], "une annonce qui ne passe plus la règle des numéros reste en pause");
  assert.equal(await statusOf(sneaky.offers[1].id), "published");
});
