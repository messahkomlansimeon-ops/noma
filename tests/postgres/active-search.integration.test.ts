import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import type { Pool, PoolClient } from "pg";
import { activateDemand, archiveDemand, createDemand, satisfyDemand } from "../../lib/server/catalog";
import { listNotifications } from "../../lib/server/notifications/inbox";
import { CatalogNotFoundError } from "../../lib/server/catalog/errors";
import { ACTIVE_SEARCH_PRICE_XOF } from "../../lib/server/active-search/config";
import { ActiveSearchError } from "../../lib/server/active-search/errors";
import { runActiveSearchMaintenance } from "../../lib/server/active-search/maintenance";
import { purchaseActiveSearch } from "../../lib/server/active-search/purchase";
import { refundActiveSearchPurchase } from "../../lib/server/active-search/refund";
import { readActiveSearchState, trackingMaxDaysFor } from "../../lib/server/active-search/state";
import { withPostgresTransaction } from "../../lib/server/postgres/client";
import { applyTrackingAction, readDemandTracking } from "../../lib/server/notifications/tracking";
import { runWalletCheck } from "../../lib/server/wallet/check";
import { WalletError } from "../../lib/server/wallet/errors";
import { postWalletTransaction } from "../../lib/server/wallet/ledger";
import { assertWalletGreen, balanceOf, fund, makePro, promoLedgerBalance, scalar, systemBalance } from "./pro-fixtures";
import { FAKE_ENV, makeDemand } from "./external-fixtures";
import { openTestSchema, type TestSchema } from "./social-fixtures";

/**
 * Recherche active payante (lot RA1) : achat atomique et idempotent par le grand livre, crédits payés seulement, périodes contiguës, horizon de 180 jours, arrêt à l'échéance, besoin
 * satisfait ou archivé, avis d'échéance, suivi jusqu'à 180 jours, remboursement intégral par l'administration, `wallet:check`, gardes de la base. Argent SIMULÉ.
 */

let env: TestSchema;
let pool: Pool;
let wide: Pool;
const DAY = 86_400_000;
const PRICE = ACTIVE_SEARCH_PRICE_XOF;

before(async () => {
  env = await openTestSchema(10);
  pool = env.pool;
  wide = env.extraPool(30);
});

after(async () => {
  await env?.close();
});

const at = (base: Date, days: number): Date => new Date(base.getTime() + days * DAY);
const key = (): string => randomUUID();

interface World { userId: string; demandId: string; t0: Date }

/** Un acheteur crédité de `credit` XOF avec un besoin actif. */
async function world(credit = 10_000, options: { status?: "active" | "draft" } = {}): Promise<World> {
  const demand = await makeDemand(pool, { status: options.status ?? "active" });
  if (credit > 0) await fund(pool, demand.ownerId, credit);
  return { userId: demand.ownerId, demandId: demand.id, t0: new Date() };
}

const buy = (w: World, extra: { key?: string; now?: Date; pool?: Pool } = {}) =>
  purchaseActiveSearch({ expectedPriceXof: ACTIVE_SEARCH_PRICE_XOF, env: FAKE_ENV, pool: extra.pool ?? pool, userId: w.userId, demandId: w.demandId, idempotencyKey: extra.key ?? key(), now: extra.now ?? w.t0 });

async function code(promise: Promise<unknown>): Promise<string> {
  try { await promise; return "ok"; } catch (error) {
    if (error instanceof ActiveSearchError || error instanceof WalletError) return error.code;
    if (error instanceof CatalogNotFoundError) return "not_found";
    return `${(error as Error).name}: ${(error as Error).message}`;
  }
}

const purchasesOf = async (demandId: string) => (await pool.query(
  `SELECT id, number, kind, price_xof::text AS price, duration_days, starts_at, ends_at, status, stop_reason, refunded_at, transaction_id, refund_transaction_id, notice_sent_at, created_at
     FROM active_search_purchases WHERE demand_id = $1 ORDER BY number`, [demandId])).rows;

/** Tout ce qu'un refus ne doit pas toucher. */
async function snapshot(): Promise<Record<string, string>> {
  return (await pool.query<Record<string, string>>(
    `SELECT (SELECT count(*) FROM wallet_transactions)::text AS transactions, (SELECT count(*) FROM wallet_entries)::text AS entries,
            (SELECT COALESCE(sum(abs(balance)), 0) FROM wallet_accounts)::text AS balances, (SELECT count(*) FROM wallet_accounts)::text AS accounts,
            (SELECT count(*) FROM active_search_purchases)::text AS purchases, (SELECT count(*) FROM active_search_state)::text AS states,
            (SELECT count(*) FROM active_search_seen)::text AS seen, (SELECT count(*) FROM notifications)::text AS notifications,
            (SELECT COALESCE(sum(extract(epoch FROM notify_until)), 0) FROM demands)::text AS tracking`)).rows[0];
}

interface Failure { code?: string; constraint?: string; message?: string; name?: string }
const ROLLBACK = Symbol("rollback");
/** Exécute `operation` dans une transaction de l'application (le grand livre l'exige), ANNULÉE par défaut ; renvoie l'échec SQL ou métier, ou null. */
async function failureOf(operation: (client: PoolClient) => Promise<unknown>, commit = false): Promise<Failure | null> {
  try {
    await withPostgresTransaction(async (client) => {
      await operation(client);
      if (!commit) throw ROLLBACK;
    }, pool);
    return null;
  } catch (error) {
    if (error === ROLLBACK) return null;
    const details = error as Failure;
    return { code: details.code, constraint: details.constraint, message: details.message, name: details.name };
  }
}

// ═════════════ 1. Migration 0028 ═════════════

test("migration 0028 : le compte système, les tables, les déclencheurs et les contraintes nommées sont là ; la relance n'applique rien", async () => {
  const { runMigrations } = await import("../../lib/server/postgres/migrations");
  const rerun = await runMigrations(pool);
  assert.deepEqual(rerun.applied, []);
  assert.equal(rerun.skipped.at(-1), "0029_active_search_places");
  assert.ok(rerun.skipped.includes("0028_active_search"));
  assert.equal(await scalar(pool, "SELECT count(*)::int AS n FROM wallet_accounts WHERE kind = 'active_search_revenue'"), 1);
  for (const table of ["active_search_purchases", "active_search_state", "active_search_seen", "active_search_places"]) {
    assert.equal(await scalar(pool, "SELECT to_regclass($1) IS NOT NULL AS n", [table]), true, table);
  }
  const triggers = (await pool.query<{ tgname: string }>(
    `SELECT t.tgname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE NOT t.tgisinternal AND n.nspname = current_schema() AND t.tgname LIKE '%active_search%' ORDER BY t.tgname`)).rows.map((row) => row.tgname);
  assert.deepEqual(triggers, [
    "trg_active_search_no_overlap", "trg_active_search_purchases_guard", "trg_active_search_purchases_insert_guard", "trg_active_search_transactions_linked",
  ]);
  const checks = (await pool.query<{ conname: string }>(
    "SELECT c.conname FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace WHERE n.nspname = current_schema() AND c.conname IN ('chk_wallet_transactions_active_search', 'chk_notifications_shape', 'chk_notification_deliveries_target', 'chk_active_search_purchases_period', 'chk_active_search_purchases_stop', 'chk_active_search_purchases_refund', 'uq_active_search_purchases_idempotency', 'uq_active_search_purchases_number', 'uq_active_search_purchases_transaction') ORDER BY c.conname")).rows.map((row) => row.conname);
  assert.equal(checks.length, 9);
  assert.equal(await scalar(pool, "SELECT is_nullable = 'YES' AS n FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'notification_deliveries' AND column_name = 'offer_id'"), true);
});

// ═════════════ 2. Achat ═════════════

test("achat (activation) : UNE transaction du grand livre (acheteur −2 000, revenus de la recherche active +2 000), période de 30 jours, suivi prolongé, relevé de l'existant, grand livre vert", async () => {
  const w = await world(5_000);
  const revenueBefore = await systemBalance(pool, "active_search_revenue");
  const result = await buy(w);
  assert.equal(result.kind, "activation");
  assert.equal(result.reused, false);
  assert.equal(result.priceXof, BigInt(PRICE));
  assert.equal(result.balance, BigInt(3_000));
  assert.equal(result.startsAt.getTime(), w.t0.getTime());
  assert.equal(result.endsAt.getTime(), at(w.t0, 30).getTime());
  assert.equal(await balanceOf(pool, w.userId), BigInt(3_000));
  assert.equal(await systemBalance(pool, "active_search_revenue"), revenueBefore + BigInt(PRICE));
  const rows = await purchasesOf(w.demandId);
  assert.equal(rows.length, 1);
  assert.deepEqual({ number: rows[0].number, kind: rows[0].kind, price: rows[0].price, days: rows[0].duration_days, status: rows[0].status, stop: rows[0].stop_reason, refunded: rows[0].refunded_at, notice: rows[0].notice_sent_at },
    { number: 1, kind: "activation", price: "2000", days: 30, status: "active", stop: null, refunded: null, notice: null });
  // La transaction du grand livre : deux écritures exactes, référence et métadonnées dérivées de l'achat.
  const tx = (await pool.query<{ kind: string; reference: string; metadata: Record<string, string> }>("SELECT kind, reference, metadata FROM wallet_transactions WHERE id = $1", [rows[0].transaction_id])).rows[0];
  assert.equal(tx.kind, "search_purchase");
  assert.equal(tx.reference, `search_purchase:${rows[0].id}`);
  assert.deepEqual(tx.metadata, { activeSearchId: rows[0].id });
  const entries = (await pool.query<{ kind: string; owner_id: string | null; amount: string }>(
    "SELECT a.kind, a.owner_id, e.amount::text AS amount FROM wallet_entries e JOIN wallet_accounts a ON a.id = e.account_id WHERE e.transaction_id = $1 ORDER BY e.amount", [rows[0].transaction_id])).rows;
  assert.deepEqual(entries, [{ kind: "user", owner_id: w.userId, amount: "-2000" }, { kind: "active_search_revenue", owner_id: null, amount: "2000" }]);
  // Le suivi des notifications couvre au moins l'option.
  const until = await scalar<Date>(pool, "SELECT notify_until AS n FROM demands WHERE id = $1", [w.demandId]);
  assert.ok(until.getTime() >= at(w.t0, 30).getTime());
  // L'état : en vigueur, 30 jours, prolongation possible.
  const state = await readActiveSearchState({ env: FAKE_ENV, executor: pool, ownerId: w.userId, demandId: w.demandId, now: w.t0 });
  assert.equal(state.active, true);
  assert.equal(state.remainingDays, 30);
  assert.equal(state.canPurchase, true);
  assert.equal(state.nextEndsAt?.getTime(), at(w.t0, 60).getTime());
  assert.equal(state.balanceXof, 3_000);
  assert.equal(state.priceXof, 2_000);
  assert.equal(state.purchasedPeriods, 1);
  // Relevé de l'existant : l'état du besoin existe (pas de surveillance collectée : relevé en attente).
  assert.equal(await scalar(pool, "SELECT baseline_pending AS n FROM active_search_state WHERE demand_id = $1", [w.demandId]), true);
  await assertWalletGreen(pool, "après un achat");
});

test("rejeu de la même clé d'idempotence : l'achat déjà enregistré est renvoyé (reused), AUCUN nouveau débit ; la même clé pour un AUTRE besoin est refusée", async () => {
  const w = await world(5_000);
  const idempotency = key();
  const first = await buy(w, { key: idempotency });
  const other = await makeDemand(pool, { ownerId: w.userId });
  const before = await snapshot();
  const second = await buy(w, { key: idempotency, now: at(w.t0, 3) });
  assert.equal(second.reused, true);
  assert.equal(second.purchaseId, first.purchaseId);
  assert.equal(second.endsAt.getTime(), first.endsAt.getTime());
  assert.equal(second.balance, BigInt(3_000));
  assert.deepEqual(await snapshot(), before, "rien n'a changé");
  assert.equal(await code(purchaseActiveSearch({ expectedPriceXof: ACTIVE_SEARCH_PRICE_XOF, env: FAKE_ENV, pool, userId: w.userId, demandId: other.id, idempotencyKey: idempotency, now: w.t0 })), "idempotency_conflict");
  assert.deepEqual(await snapshot(), before, "le conflit n'écrit rien");
});

test("solde insuffisant : refus, RIEN n'est écrit (ni transaction, ni achat, ni suivi) ; avec exactement le prix, l'achat passe et le solde tombe à zéro", async () => {
  const w = await world(1_999);
  const before = await snapshot();
  assert.equal(await code(buy(w)), "insufficient_balance");
  assert.deepEqual(await snapshot(), before);
  assert.equal(await balanceOf(pool, w.userId), BigInt(1_999));
  await fund(pool, w.userId, 1);
  const bought = await buy(w);
  assert.equal(bought.balance, BigInt(0));
  assert.equal(await balanceOf(pool, w.userId), BigInt(0));
  // Sans aucun compte (utilisateur jamais crédité) : même refus.
  const poor = await world(0);
  assert.equal(await code(buy(poor)), "insufficient_balance");
  await assertWalletGreen(pool, "après les refus");
});

test("crédits promotionnels : JAMAIS dépensés pour cette option (seuls les crédits payés), ni par le service, ni par la base", async () => {
  // Abonné Pro sans crédits payés : 5 000 XOF promotionnels, mais l'achat est refusé.
  const pro = await makePro(pool, 10_000);
  assert.equal(await promoLedgerBalance(pool, pro.userId), BigInt(5_000));
  const demand = await makeDemand(pool, { ownerId: pro.userId });
  const proWorld: World = { userId: pro.userId, demandId: demand.id, t0: new Date() };
  assert.equal(await balanceOf(pool, pro.userId), BigInt(0));
  const before = await snapshot();
  assert.equal(await code(buy(proWorld)), "insufficient_balance", "5 000 XOF promotionnels ne paient pas l'option");
  assert.deepEqual(await snapshot(), before);
  // Avec 2 000 XOF payés en plus : seuls les crédits payés sont débités, le sous-compte promotionnel est intact.
  await fund(pool, pro.userId, 2_000);
  const promoBefore = await promoLedgerBalance(pool, pro.userId);
  const bought = await buy(proWorld);
  assert.equal(bought.balance, BigInt(0));
  assert.equal(await promoLedgerBalance(pool, pro.userId), promoBefore);
  assert.equal(await scalar(pool, "SELECT count(*)::int AS n FROM wallet_entries e JOIN wallet_accounts a ON a.id = e.account_id WHERE e.transaction_id = $1 AND a.kind <> 'user' AND a.kind <> 'active_search_revenue'", [(await purchasesOf(demand.id))[0].transaction_id]), 0);
  // Le service refuse d'écrire un achat sur le sous-compte promotionnel…
  const phantom = randomUUID();
  const viaLedger = await failureOf((client) => postWalletTransaction(client, {
    kind: "search_purchase", reference: `search_purchase:${phantom}`, metadata: { activeSearchId: phantom },
    entries: [{ account: { kind: "user_promo", ownerId: pro.userId }, amount: BigInt(-2_000) }, { account: { kind: "active_search_revenue" }, amount: BigInt(2_000) }],
  }));
  assert.equal(viaLedger?.name, "CatalogValidationError", "refusé par le service du grand livre");
  assert.match(viaLedger?.message ?? "", /ne peut pas écrire sur ce compte/);
  // … et la base le refuse aussi (écriture directe sous le service).
  const viaSql = await failureOf(async (client) => {
    const tx = randomUUID();
    const fake = randomUUID();
    await client.query("INSERT INTO wallet_transactions (id, kind, reference, metadata) VALUES ($1, 'search_purchase', $2, $3::jsonb)", [tx, `search_purchase:${fake}`, JSON.stringify({ activeSearchId: fake })]);
    await client.query(
      "INSERT INTO wallet_entries (id, transaction_id, account_id, amount) SELECT gen_random_uuid(), $1, id, -2000 FROM wallet_accounts WHERE kind = 'user_promo' AND owner_id = $2", [tx, pro.userId]);
  });
  assert.equal(viaSql?.code, "23001", `restrict_violation : un type de transaction ne touche pas un compte hors de son rôle (${viaSql?.constraint} ${viaSql?.message})`);
  await assertWalletGreen(pool, "après les crédits promotionnels");
});

// ═════════════ 3. Concurrence ═════════════

test("double clic : 12 achats SIMULTANÉS avec la même clé → UN seul débit, UN seul achat, tous reçoivent le même achat", async () => {
  const w = await world(10_000);
  const idempotency = key();
  const results = await Promise.all(Array.from({ length: 12 }, () => buy(w, { key: idempotency, pool: wide })));
  assert.equal(new Set(results.map((result) => result.purchaseId)).size, 1);
  assert.equal(results.filter((result) => !result.reused).length, 1, "un seul appel a débité");
  assert.equal(await balanceOf(pool, w.userId), BigInt(8_000));
  assert.equal((await purchasesOf(w.demandId)).length, 1);
  assert.equal(await scalar(pool, "SELECT count(*)::int AS n FROM wallet_transactions WHERE kind = 'search_purchase' AND metadata ->> 'activeSearchId' IN (SELECT id::text FROM active_search_purchases WHERE demand_id = $1)", [w.demandId]), 1);
  await assertWalletGreen(pool, "après le double clic");
});

test("8 achats simultanés de clés DIFFÉRENTES pour un même besoin : 6 passent (périodes contiguës, jamais de chevauchement, 180 jours au plus), 2 sont refusés (max_horizon) ; débit exact", async () => {
  const w = await world(100_000);
  const outcomes = await Promise.all(Array.from({ length: 8 }, () => code(buy(w, { pool: wide }))));
  assert.equal(outcomes.filter((entry) => entry === "ok").length, 6, outcomes.join(","));
  assert.equal(outcomes.filter((entry) => entry === "max_horizon").length, 2, outcomes.join(","));
  const rows = await purchasesOf(w.demandId);
  assert.equal(rows.length, 6);
  assert.deepEqual(rows.map((row) => row.kind), ["activation", "extension", "extension", "extension", "extension", "extension"]);
  for (let index = 1; index < rows.length; index += 1) assert.equal(rows[index].starts_at.getTime(), rows[index - 1].ends_at.getTime(), `période ${index + 1} contiguë`);
  assert.equal(rows[5].ends_at.getTime(), at(w.t0, 180).getTime());
  assert.equal(await balanceOf(pool, w.userId), BigInt(100_000 - 6 * PRICE));
  await assertWalletGreen(pool, "après les achats simultanés");
});

test("crédits PAYÉS seulement sous concurrence (DEUX pools) : un abonné Pro (3 000 FCFA payés, 5 000 promotionnels), deux besoins, 8 achats simultanés → UN seul passe, les crédits promotionnels ne sont jamais touchés", async () => {
  const pro = await makePro(pool, 13_000);
  assert.equal(await balanceOf(pool, pro.userId), BigInt(3_000), "3 000 FCFA payés après l'abonnement");
  assert.equal(await promoLedgerBalance(pool, pro.userId), BigInt(5_000));
  const first = await makeDemand(pool, { ownerId: pro.userId });
  const second = await makeDemand(pool, { ownerId: pro.userId, rawText: "Un autre iPhone 12" });
  const otherPool = env.extraPool(20);
  const worlds: World[] = [
    { userId: pro.userId, demandId: first.id, t0: new Date() },
    { userId: pro.userId, demandId: second.id, t0: new Date() },
  ];
  const outcomes = await Promise.all(Array.from({ length: 8 }, (_, index) => code(buy(worlds[index % 2], { pool: index % 4 < 2 ? wide : otherPool }))));
  assert.equal(outcomes.filter((entry) => entry === "ok").length, 1, outcomes.join(","));
  assert.equal(outcomes.filter((entry) => entry === "insufficient_balance").length, 7, outcomes.join(","));
  assert.equal(await balanceOf(pool, pro.userId), BigInt(1_000), "un seul débit de 2 000 FCFA, sur les crédits payés");
  assert.equal(await promoLedgerBalance(pool, pro.userId), BigInt(5_000), "les crédits promotionnels ne paient jamais l'option, même quand le solde payé manque");
  assert.equal((await purchasesOf(first.id)).length + (await purchasesOf(second.id)).length, 1);
  await assertWalletGreen(pool, "après les achats concurrents d'un abonné Pro");
});

test("achats simultanés de DEUX acheteurs pour leurs besoins : aucune interférence, chacun débité une fois", async () => {
  const [first, second] = await Promise.all([world(5_000), world(5_000)]);
  await Promise.all([buy(first, { pool: wide }), buy(second, { pool: wide })]);
  assert.equal(await balanceOf(pool, first.userId), BigInt(3_000));
  assert.equal(await balanceOf(pool, second.userId), BigInt(3_000));
});

// ═════════════ 4. Accès et état du besoin ═════════════

test("accès : le besoin d'un AUTRE ou inconnu → la même erreur « introuvable » (rien n'est écrit) ; brouillon, satisfait, archivé → demand_not_active", async () => {
  const owner = await world(5_000);
  const stranger = await world(5_000);
  const before = await snapshot();
  const foreign = await code(purchaseActiveSearch({ expectedPriceXof: ACTIVE_SEARCH_PRICE_XOF, env: FAKE_ENV, pool, userId: stranger.userId, demandId: owner.demandId, idempotencyKey: key(), now: owner.t0 }));
  const unknown = await code(purchaseActiveSearch({ expectedPriceXof: ACTIVE_SEARCH_PRICE_XOF, env: FAKE_ENV, pool, userId: stranger.userId, demandId: randomUUID(), idempotencyKey: key(), now: owner.t0 }));
  assert.equal(foreign, "not_found");
  assert.equal(unknown, "not_found");
  assert.deepEqual(await snapshot(), before);
  await assert.rejects(readActiveSearchState({ env: FAKE_ENV, executor: pool, ownerId: stranger.userId, demandId: owner.demandId }), CatalogNotFoundError);
  const draft = await world(5_000, { status: "draft" });
  assert.equal(await code(buy(draft)), "demand_not_active");
  const satisfied = await world(5_000);
  const record = await makeDemand(pool, { ownerId: satisfied.userId });
  await satisfyDemand(satisfied.userId, record.id, record.contentVersion, pool);
  assert.equal(await code(buy({ ...satisfied, demandId: record.id })), "demand_not_active");
  const archived = await makeDemand(pool, { ownerId: satisfied.userId });
  await archiveDemand(satisfied.userId, archived.id, archived.contentVersion, pool);
  assert.equal(await code(buy({ ...satisfied, demandId: archived.id })), "demand_not_active");
  assert.equal(await balanceOf(pool, satisfied.userId), BigInt(5_000), "rien n'a été débité");
  const state = await readActiveSearchState({ env: FAKE_ENV, executor: pool, ownerId: satisfied.userId, demandId: record.id });
  assert.equal(state.canPurchase, false);
  assert.equal(state.blockedReason, "demand_not_active");
  assert.equal(state.nextEndsAt, null);
});

test("accès d'autrui : un AUTRE acheteur ne peut ni activer ni PROLONGER l'option d'un besoin qui n'est pas le sien (la prolongation ne relit pas le besoin) ; rien n'est débité ni écrit", async () => {
  const owner = await world(5_000);
  const stranger = await world(5_000);
  await buy(owner);
  const before = await snapshot();
  assert.equal(await code(purchaseActiveSearch({ expectedPriceXof: ACTIVE_SEARCH_PRICE_XOF, env: FAKE_ENV, pool, userId: stranger.userId, demandId: owner.demandId, idempotencyKey: key(), now: owner.t0 })), "not_found", "même erreur qu'un besoin inconnu");
  assert.deepEqual(await snapshot(), before, "aucune écriture");
  assert.equal(await balanceOf(pool, stranger.userId), BigInt(5_000), "l'étranger n'est pas débité");
  assert.equal((await purchasesOf(owner.demandId)).length, 1, "la chaîne du propriétaire n'a pas été prolongée par un autre");
});

// ═════════════ 5. Prolongation, horizon, échéance ═════════════

test("prolongation : une période qui COMMENCE exactement à la fin de la précédente (contiguë) ; l'état montre la fin de la chaîne ; l'avis et le suivi suivent", async () => {
  const w = await world(10_000);
  const first = await buy(w);
  const second = await buy(w, { now: at(w.t0, 10) });
  assert.equal(second.kind, "extension");
  assert.equal(second.startsAt.getTime(), first.endsAt.getTime(), "contiguë, à la microseconde");
  assert.equal(second.endsAt.getTime(), at(w.t0, 60).getTime());
  assert.equal(second.balance, BigInt(6_000));
  const state = await readActiveSearchState({ env: FAKE_ENV, executor: pool, ownerId: w.userId, demandId: w.demandId, now: at(w.t0, 10) });
  assert.equal(state.active, true);
  assert.equal(state.endsAt?.getTime(), at(w.t0, 60).getTime());
  assert.equal(state.remainingDays, 50);
  assert.equal(state.purchasedPeriods, 2);
  const until = await scalar<Date>(pool, "SELECT notify_until AS n FROM demands WHERE id = $1", [w.demandId]);
  assert.ok(until.getTime() >= at(w.t0, 60).getTime());
  await assertWalletGreen(pool, "après une prolongation");
});

test("horizon : 6 périodes (180 jours) passent, la 7e est refusée (max_horizon) sans rien écrire ; 31 jours plus tard, une période de plus passe", async () => {
  const w = await world(40_000);
  for (let index = 0; index < 6; index += 1) await buy(w);
  const before = await snapshot();
  assert.equal(await code(buy(w)), "max_horizon");
  assert.deepEqual(await snapshot(), before, "le refus n'écrit rien");
  const blocked = await readActiveSearchState({ env: FAKE_ENV, executor: pool, ownerId: w.userId, demandId: w.demandId, now: w.t0 });
  assert.equal(blocked.canPurchase, false);
  assert.equal(blocked.blockedReason, "max_horizon");
  assert.equal(blocked.endsAt?.getTime(), at(w.t0, 180).getTime());
  const later = at(w.t0, 31);
  const next = await buy(w, { now: later });
  assert.equal(next.kind, "extension");
  assert.equal(next.endsAt.getTime(), at(w.t0, 210).getTime());
  assert.equal((await readActiveSearchState({ env: FAKE_ENV, executor: pool, ownerId: w.userId, demandId: w.demandId, now: later })).blockedReason, "max_horizon");
});

test("échéance : aucun renouvellement automatique (aucun achat, aucun mouvement du grand livre), la période prend fin ; la maintenance est idempotente ; un nouvel achat est une activation", async () => {
  const w = await world(10_000);
  const first = await buy(w);
  const afterEnd = at(w.t0, 31);
  const before = await snapshot();
  const run = await runActiveSearchMaintenance(pool, afterEnd);
  assert.ok(run.ended >= 1, "la période de cet acheteur prend fin (le compteur compte aussi les autres essais du schéma)");
  const rerun = await runActiveSearchMaintenance(pool, afterEnd);
  assert.deepEqual([rerun.ended, rerun.stopped, rerun.notices], [0, 0, 0], "idempotente");
  const after = await snapshot();
  assert.equal(after.transactions, before.transactions, "aucun mouvement du grand livre à l'échéance");
  assert.equal(after.purchases, before.purchases, "aucun renouvellement automatique");
  assert.equal(await balanceOf(pool, w.userId), BigInt(8_000));
  const rows = await purchasesOf(w.demandId);
  assert.equal(rows[0].status, "ended");
  const state = await readActiveSearchState({ env: FAKE_ENV, executor: pool, ownerId: w.userId, demandId: w.demandId, now: afterEnd });
  assert.equal(state.active, false);
  assert.equal(state.endsAt, null);
  const again = await buy(w, { now: afterEnd });
  assert.equal(again.kind, "activation", "après l'échéance, un nouvel achat est une activation (pas de période contiguë)");
  assert.equal(again.startsAt.getTime(), afterEnd.getTime());
  assert.equal((await purchasesOf(w.demandId)).length, 2);
  assert.equal(first.kind, "activation");
});

test("même sans passage du worker, une période échue n'est plus « en vigueur » (la couverture compare les dates, pas seulement le statut)", async () => {
  const w = await world(10_000);
  await buy(w);
  assert.equal((await readActiveSearchState({ env: FAKE_ENV, executor: pool, ownerId: w.userId, demandId: w.demandId, now: at(w.t0, 29) })).active, true);
  assert.equal((await readActiveSearchState({ env: FAKE_ENV, executor: pool, ownerId: w.userId, demandId: w.demandId, now: at(w.t0, 30) })).active, false, "la fin est exclusive");
  assert.equal(await trackingMaxDaysFor(pool, w.demandId, at(w.t0, 29)), 180);
  assert.equal(await trackingMaxDaysFor(pool, w.demandId, at(w.t0, 31)), 90);
});

// ═════════════ 6. Besoin satisfait ou archivé ═════════════

test("A4 : besoin SATISFAIT = option SUSPENDUE (ni notification ni accélération, la période court, aucune raison d'arrêt, aucun remboursement) ; seul l'ARCHIVAGE l'arrête, sans remboursement", async () => {
  const satisfiedWorld = await world(10_000);
  await buy(satisfiedWorld);
  const record = await scalar<number>(pool, "SELECT content_version AS n FROM demands WHERE id = $1", [satisfiedWorld.demandId]);
  await satisfyDemand(satisfiedWorld.userId, satisfiedWorld.demandId, record, pool);
  const state = await readActiveSearchState({ env: FAKE_ENV, executor: pool, ownerId: satisfiedWorld.userId, demandId: satisfiedWorld.demandId, now: at(satisfiedWorld.t0, 1) });
  assert.equal(state.active, false, "plus d'option en vigueur tant que le besoin est satisfait, avant même le worker");
  assert.equal(state.suspended, true, "l'option est SUSPENDUE");
  assert.equal(state.endsAt?.getTime(), at(satisfiedWorld.t0, 30).getTime(), "la fin de la période est connue");
  assert.equal(state.canPurchase, false, "pas de prolongation pendant la suspension");
  assert.equal(await trackingMaxDaysFor(pool, satisfiedWorld.demandId, at(satisfiedWorld.t0, 1)), 90);
  const before = await snapshot();
  const run = await runActiveSearchMaintenance(pool, at(satisfiedWorld.t0, 1));
  assert.equal(run.stopped, 0, "la maintenance n'arrête RIEN pour un besoin satisfait");
  const rows = await purchasesOf(satisfiedWorld.demandId);
  assert.deepEqual([rows[0].status, rows[0].stop_reason, rows[0].refunded_at], ["active", null, null]);
  assert.equal((await snapshot()).transactions, before.transactions, "aucun remboursement automatique");
  assert.equal(await balanceOf(pool, satisfiedWorld.userId), BigInt(8_000));
  // La période continue de COURIR pendant la suspension : échue, elle prend fin (aucune prolongation, aucun remboursement).
  await runActiveSearchMaintenance(pool, at(satisfiedWorld.t0, 31));
  assert.equal((await purchasesOf(satisfiedWorld.demandId))[0].status, "ended");
  const ended = await readActiveSearchState({ env: FAKE_ENV, executor: pool, ownerId: satisfiedWorld.userId, demandId: satisfiedWorld.demandId, now: at(satisfiedWorld.t0, 31) });
  assert.deepEqual([ended.active, ended.suspended, ended.endsAt], [false, false, null]);
  assert.equal(await balanceOf(pool, satisfiedWorld.userId), BigInt(8_000));

  const archivedWorld = await world(10_000);
  await buy(archivedWorld);
  const version = await scalar<number>(pool, "SELECT content_version AS n FROM demands WHERE id = $1", [archivedWorld.demandId]);
  await archiveDemand(archivedWorld.userId, archivedWorld.demandId, version, pool);
  const archivedState = await readActiveSearchState({ env: FAKE_ENV, executor: pool, ownerId: archivedWorld.userId, demandId: archivedWorld.demandId, now: at(archivedWorld.t0, 1) });
  assert.deepEqual([archivedState.active, archivedState.suspended], [false, false], "archivé : arrêté, jamais suspendu");
  await runActiveSearchMaintenance(pool, at(archivedWorld.t0, 1));
  assert.deepEqual((await purchasesOf(archivedWorld.demandId)).map((row) => [row.status, row.stop_reason]), [["stopped", "demand_archived"]]);
  assert.equal(await balanceOf(pool, archivedWorld.userId), BigInt(8_000), "archivé : arrêt sans remboursement");
  await assertWalletGreen(pool, "après les arrêts");
});

test("A4 / P2-f / P2-g : satisfait puis réactivé → MÊME résultat avec ou sans passage du worker entre les deux (l'option reprend, la période n'a pas été perdue), grand livre vert, nouvel achat = prolongation sans faux chevauchement", async () => {
  const outcomes: Array<{ active: boolean; suspended: boolean; remainingDays: number | null; periods: unknown[]; balance: bigint }> = [];
  for (const workerBetween of [false, true]) {
    const w = await world(10_000);
    await buy(w);
    await buy(w, { now: at(w.t0, 1) });
    let version = await scalar<number>(pool, "SELECT content_version AS n FROM demands WHERE id = $1", [w.demandId]);
    await satisfyDemand(w.userId, w.demandId, version, pool);
    if (workerBetween) await runActiveSearchMaintenance(pool, at(w.t0, 2));
    version = await scalar<number>(pool, "SELECT content_version AS n FROM demands WHERE id = $1", [w.demandId]);
    await activateDemand(w.userId, w.demandId, version, pool);
    await runActiveSearchMaintenance(pool, at(w.t0, 3));
    const state = await readActiveSearchState({ env: FAKE_ENV, executor: pool, ownerId: w.userId, demandId: w.demandId, now: at(w.t0, 3) });
    outcomes.push({
      active: state.active, suspended: state.suspended, remainingDays: state.remainingDays,
      periods: (await purchasesOf(w.demandId)).map((row) => [row.number, row.status, row.stop_reason]), balance: await balanceOf(pool, w.userId),
    });
    // Un nouvel achat après la réactivation prolonge la chaîne (aucun chevauchement, aucune alerte de wallet:check).
    const extension = await buy(w, { now: at(w.t0, 3) });
    assert.equal(extension.kind, "extension");
    assert.deepEqual((await runWalletCheck(pool)).violations, []);
  }
  assert.deepEqual(outcomes[0], outcomes[1], "même scénario, même issue : le passage du worker ne change rien");
  assert.equal(outcomes[0].active, true);
  assert.equal(outcomes[0].suspended, false);
  assert.equal(outcomes[0].remainingDays, 57);
  assert.deepEqual(outcomes[0].periods, [[1, "active", null], [2, "active", null]]);
  assert.equal(outcomes[0].balance, BigInt(6_000), "aucun remboursement, aucun second débit");
});

// ═════════════ 7. Avis d'échéance ═════════════

test("avis d'échéance : une notification 3 jours avant la fin de la DERNIÈRE période, une seule par période, aucune si une période suit, aucune si le besoin est clos", async () => {
  const w = await world(10_000);
  const first = await buy(w);
  const noticeRows = () => pool.query<{ kind: string; active_search_id: string; demand_id: string }>(
    "SELECT kind, active_search_id, demand_id FROM notifications WHERE user_id = $1 AND kind = 'active_search_expiring'", [w.userId]);
  await runActiveSearchMaintenance(pool, at(w.t0, 26));
  assert.equal((await noticeRows()).rowCount, 0, "4 jours avant la fin : trop tôt");
  await runActiveSearchMaintenance(pool, at(w.t0, 27));
  assert.equal((await noticeRows()).rowCount, 1, "3 jours avant la fin");
  const notice = (await noticeRows()).rows;
  assert.equal(notice.length, 1);
  assert.deepEqual([notice[0].active_search_id, notice[0].demand_id], [first.purchaseId, w.demandId]);
  const second28 = await runActiveSearchMaintenance(pool, at(w.t0, 28));
  assert.equal(second28.notices, 0, "un seul avis par période : rien de nouveau, pour personne");
  assert.equal((await noticeRows()).rowCount, 1);
  assert.equal(await scalar(pool, "SELECT notice_sent_at IS NOT NULL AS n FROM active_search_purchases WHERE id = $1", [first.purchaseId]), true);

  // Avec une prolongation payée derrière, la première période n'avertit pas ; la dernière avertit 3 jours avant SA fin.
  const chained = await world(10_000);
  await buy(chained);
  const second = await buy(chained, { now: at(chained.t0, 5) });
  await runActiveSearchMaintenance(pool, at(chained.t0, 28));
  assert.equal((await pool.query("SELECT 1 FROM notifications WHERE user_id = $1 AND kind = 'active_search_expiring'", [chained.userId])).rowCount, 0, "une période suit : pas d'avis");
  await runActiveSearchMaintenance(pool, at(chained.t0, 57));
  assert.equal((await pool.query("SELECT 1 FROM notifications WHERE user_id = $1 AND kind = 'active_search_expiring' AND active_search_id = $2", [chained.userId, second.purchaseId])).rowCount, 1);

  // Besoin clos : aucun avis.
  const closed = await world(10_000);
  await buy(closed);
  const version = await scalar<number>(pool, "SELECT content_version AS n FROM demands WHERE id = $1", [closed.demandId]);
  await archiveDemand(closed.userId, closed.demandId, version, pool);
  await runActiveSearchMaintenance(pool, at(closed.t0, 28));
  assert.equal((await pool.query("SELECT 1 FROM notifications WHERE user_id = $1 AND kind = 'active_search_expiring'", [closed.userId])).rowCount, 0);
});

// ═════════════ 8. Suivi jusqu'à 180 jours ═════════════

test("suivi : prolongeable jusqu'à 180 jours PENDANT l'option (90 sans) ; à la fin de l'option le suivi revient au plafond de 90 jours", async () => {
  const w = await world(10_000);
  const plain = await makeDemand(pool, { ownerId: w.userId });
  const extend = (demandId: string, now: Date) => applyTrackingAction({ pool, ownerId: w.userId, demandId, action: "extend", now });
  // Sans option : plafond de 90 jours.
  let tracking = await readDemandTracking({ pool, ownerId: w.userId, demandId: plain.id, now: w.t0 });
  assert.equal(Math.round(((tracking?.maxUntil.getTime() ?? 0) - w.t0.getTime()) / DAY), 90);
  for (let index = 0; index < 6; index += 1) tracking = await extend(plain.id, w.t0);
  assert.equal(tracking?.until.getTime(), at(w.t0, 90).getTime());
  // Avec option : plafond de 180 jours.
  await buy(w);
  tracking = await readDemandTracking({ pool, ownerId: w.userId, demandId: w.demandId, now: w.t0 });
  assert.equal(Math.round(((tracking?.maxUntil.getTime() ?? 0) - w.t0.getTime()) / DAY), 180);
  for (let index = 0; index < 8; index += 1) tracking = await extend(w.demandId, w.t0);
  assert.equal(tracking?.until.getTime(), at(w.t0, 180).getTime(), "jamais au-delà de 180 jours");
  // Fin de l'option : retour au plafond de 90 jours (à partir de la date de l'entretien).
  const end = at(w.t0, 31);
  await runActiveSearchMaintenance(pool, end);
  const clamped = await scalar<Date>(pool, "SELECT notify_until AS n FROM demands WHERE id = $1", [w.demandId]);
  assert.equal(clamped.getTime(), at(end, 90).getTime());
  tracking = await readDemandTracking({ pool, ownerId: w.userId, demandId: w.demandId, now: end });
  assert.equal(Math.round(((tracking?.maxUntil.getTime() ?? 0) - end.getTime()) / DAY), 90);
  // Un suivi déjà sous 90 jours n'est jamais rallongé par le retour au plafond.
  const short = await world(10_000);
  await buy(short);
  await runActiveSearchMaintenance(pool, at(short.t0, 31));
  const kept = await scalar<Date>(pool, "SELECT notify_until AS n FROM demands WHERE id = $1", [short.demandId]);
  assert.ok(kept.getTime() <= at(short.t0, 31 + 90).getTime());
});

// ═════════════ 9. Remboursement (administration) ═════════════

test("remboursement INTÉGRAL : crédits PAYÉS recrédités, revenus −prix, achat arrêté (refunded), suivi et option disparaissent ; un second remboursement est refusé ; grand livre vert", async () => {
  const w = await world(5_000);
  const bought = await buy(w);
  const revenue = await systemBalance(pool, "active_search_revenue");
  const refunded = await refundActiveSearchPurchase({ pool, purchaseId: bought.purchaseId, reasonCode: "geste_commercial", now: at(w.t0, 2) });
  assert.equal(refunded.refundedAmount, BigInt(PRICE));
  assert.equal(refunded.stopped, true);
  assert.equal(refunded.balance, BigInt(5_000));
  assert.equal(await balanceOf(pool, w.userId), BigInt(5_000));
  assert.equal(await systemBalance(pool, "active_search_revenue"), revenue - BigInt(PRICE));
  const row = (await purchasesOf(w.demandId))[0];
  assert.deepEqual([row.status, row.stop_reason, row.refunded_at !== null, row.refund_transaction_id !== null], ["stopped", "refunded", true, true]);
  const tx = (await pool.query<{ kind: string; reference: string; metadata: Record<string, string> }>("SELECT kind, reference, metadata FROM wallet_transactions WHERE id = $1", [row.refund_transaction_id])).rows[0];
  assert.deepEqual([tx.kind, tx.reference, tx.metadata], ["search_refund", `search_refund:${bought.purchaseId}`, { activeSearchId: bought.purchaseId, reasonCode: "geste_commercial" }]);
  assert.equal((await readActiveSearchState({ env: FAKE_ENV, executor: pool, ownerId: w.userId, demandId: w.demandId, now: at(w.t0, 2) })).active, false);
  assert.equal(await trackingMaxDaysFor(pool, w.demandId, at(w.t0, 2)), 90);
  const before = await snapshot();
  assert.equal(await code(refundActiveSearchPurchase({ pool, purchaseId: bought.purchaseId, reasonCode: "encore" })), "already_refunded");
  assert.deepEqual(await snapshot(), before);
  await assertWalletGreen(pool, "après un remboursement");
  // Après le remboursement, l'acheteur peut racheter (nouvelle activation, aucun chevauchement avec la période remboursée).
  const again = await buy(w, { now: at(w.t0, 2) });
  assert.equal(again.kind, "activation");
});

test("prix conservé sur CHAQUE achat : un achat fait à un autre prix (1 500 FCFA) se rembourse à CE prix, jamais au prix courant ; le grand livre reste vert", async () => {
  const w = await world(5_000);
  const purchaseId = randomUUID();
  await withPostgresTransaction(async (client) => {
    const posted = await postWalletTransaction(client, {
      kind: "search_purchase", reference: `search_purchase:${purchaseId}`, metadata: { activeSearchId: purchaseId },
      entries: [{ account: { kind: "user", ownerId: w.userId }, amount: BigInt(-1_500) }, { account: { kind: "active_search_revenue" }, amount: BigInt(1_500) }],
    });
    await client.query(
      `INSERT INTO active_search_purchases (id, user_id, demand_id, number, kind, price_xof, duration_days, starts_at, ends_at, transaction_id, idempotency_key, created_at)
       VALUES ($1, $2, $3, 1, 'activation', 1500, 30, $4, $5, $6, $7, $4)`,
      [purchaseId, w.userId, w.demandId, w.t0.toISOString(), at(w.t0, 30).toISOString(), posted.id, randomUUID()]);
  }, pool);
  assert.equal(await balanceOf(pool, w.userId), BigInt(3_500));
  assert.equal((await failureOf((client) => client.query("UPDATE active_search_purchases SET price_xof = 2000 WHERE id = $1", [purchaseId])))?.code, "23001", "le prix payé ne se modifie pas");
  const refunded = await refundActiveSearchPurchase({ pool, purchaseId, reasonCode: "ancien_prix", now: at(w.t0, 1) });
  assert.equal(refunded.refundedAmount, BigInt(1_500), "remboursé au prix PAYÉ, pas au prix courant de 2 000");
  assert.equal(await balanceOf(pool, w.userId), BigInt(5_000));
  await assertWalletGreen(pool, "après le remboursement d'un achat à un autre prix");
});

test("wallet:check : une période REMBOURSÉE qui chevauche la période en vigueur n'est jamais un chevauchement, quel que soit l'ordre des identifiants (une période remboursée puis un nouvel achat sur les mêmes dates est légitime)", async () => {
  // Les identifiants sont aléatoires : la requête compare `a.id < b.id`. On répète jusqu'à avoir vu LES DEUX ordres (la période remboursée a le plus petit, puis le plus grand identifiant).
  const orders = new Set<string>();
  for (let index = 0; index < 60 && orders.size < 2; index += 1) {
    const w = await world(10_000);
    const first = await buy(w);
    await refundActiveSearchPurchase({ pool, purchaseId: first.purchaseId, reasonCode: "essai", now: at(w.t0, 1) });
    const second = await buy(w, { now: at(w.t0, 2) });
    const [from, to] = [(await purchasesOf(w.demandId))[0], (await purchasesOf(w.demandId))[1]];
    assert.deepEqual([from.status, to.status], ["stopped", "active"], "la période remboursée est arrêtée, la nouvelle est en vigueur");
    assert.ok(to.starts_at.getTime() < from.ends_at.getTime(), "les deux périodes se chevauchent");
    orders.add(second.purchaseId < first.purchaseId ? "refunded-has-larger-id" : "refunded-has-smaller-id");
  }
  assert.equal(orders.size, 2, `les deux ordres d'identifiants ont été essayés (${[...orders].join(", ")})`);
  const report = await assertWalletGreen(pool, "périodes remboursées chevauchant la période en vigueur");
  assert.equal(report.violations.some((violation) => violation.code === "active_search_overlap"), false);
});

test("remboursement : le plus RÉCENT achat d'abord (later_period_exists), un achat inconnu, un motif invalide ; une période déjà terminée se rembourse aussi (elle garde son statut) ; deux remboursements simultanés → un seul passe", async () => {
  const w = await world(10_000);
  const first = await buy(w);
  const second = await buy(w, { now: at(w.t0, 1) });
  const before = await snapshot();
  assert.equal(await code(refundActiveSearchPurchase({ pool, purchaseId: first.purchaseId, reasonCode: "erreur" })), "later_period_exists");
  assert.equal(await code(refundActiveSearchPurchase({ pool, purchaseId: randomUUID(), reasonCode: "erreur" })), "purchase_not_found");
  assert.match(await code(refundActiveSearchPurchase({ pool, purchaseId: second.purchaseId, reasonCode: "Pas Valide" })), /CatalogValidationError/);
  assert.deepEqual(await snapshot(), before, "les refus n'écrivent rien");
  // Deux remboursements simultanés de la dernière période : un seul passe, une seule écriture.
  const outcomes = await Promise.all(Array.from({ length: 6 }, () => code(refundActiveSearchPurchase({ pool: wide, purchaseId: second.purchaseId, reasonCode: "double" }))));
  assert.equal(outcomes.filter((entry) => entry === "ok").length, 1, outcomes.join(","));
  assert.ok(outcomes.every((entry) => entry === "ok" || entry === "already_refunded"), outcomes.join(","));
  assert.equal(await balanceOf(pool, w.userId), BigInt(10_000 - PRICE));
  // Puis la première (plus rien derrière) ; la période terminée garde son statut `ended`.
  await runActiveSearchMaintenance(pool, at(w.t0, 40));
  const refundedEnded = await refundActiveSearchPurchase({ pool, purchaseId: first.purchaseId, reasonCode: "ancienne" });
  assert.equal(refundedEnded.stopped, false, "elle n'était plus en vigueur");
  const rows = await purchasesOf(w.demandId);
  assert.deepEqual([rows[0].status, rows[0].refunded_at !== null], ["ended", true]);
  assert.equal(await balanceOf(pool, w.userId), BigInt(10_000));
  await assertWalletGreen(pool, "après les remboursements");
});

test("outil d'administration active-search:refund : usage clair, refus sans trace brute, remboursement effectif, code de sortie", async () => {
  const { runScript } = await import("./run-script");
  const w = await world(5_000);
  const bought = await buy(w);
  const none = await runScript("scripts/active-search-refund.ts", [], env.schema);
  assert.equal(none.code, 1);
  assert.match(none.output, /Usage : npm run active-search:refund -- --purchase <uuid> --reason <code>/);
  const bad = await runScript("scripts/active-search-refund.ts", ["--purchase", "pas-un-uuid", "--reason", "x"], env.schema);
  assert.equal(bad.code, 1);
  const unknown = await runScript("scripts/active-search-refund.ts", ["--purchase", randomUUID(), "--reason", "test"], env.schema);
  assert.equal(unknown.code, 1);
  assert.match(unknown.output, /refus purchase_not_found/);
  assert.equal(await balanceOf(pool, w.userId), BigInt(3_000), "les refus ne remboursent rien");
  const ok = await runScript("scripts/active-search-refund.ts", ["--purchase", bought.purchaseId, "--reason", "essai_outil"], env.schema);
  assert.equal(ok.code, 0, ok.output);
  assert.match(ok.output, /remboursée : achat .* 2000 XOF recrédités/);
  assert.equal(await balanceOf(pool, w.userId), BigInt(5_000));
  const again = await runScript("scripts/active-search-refund.ts", ["--purchase", bought.purchaseId, "--reason", "essai_outil"], env.schema);
  assert.equal(again.code, 1);
  assert.match(again.output, /refus already_refunded/);
});

// ═════════════ 10. wallet:check ═════════════

test("wallet:check : vert sur une base saine ; chaque corruption injectée (transaction annulée) est détectée par SON contrôle", async () => {
  const w = await world(10_000);
  const bought = await buy(w);
  const refundedWorld = await world(10_000);
  const refundedPurchase = await buy(refundedWorld);
  await refundActiveSearchPurchase({ pool, purchaseId: refundedPurchase.purchaseId, reasonCode: "preparation" });
  assert.deepEqual((await runWalletCheck(pool)).violations, []);
  const codesIn = async (corrupt: (client: PoolClient) => Promise<void>): Promise<string[]> => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await corrupt(client);
      const report = await runWalletCheck(client);
      await client.query("ROLLBACK");
      return report.violations.map((violation) => violation.code);
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { /* garder l'erreur utile */ }
      throw error;
    } finally {
      client.release();
    }
  };
  const triggersOff = async (client: PoolClient, table: string): Promise<void> => {
    await client.query(`ALTER TABLE ${table} DISABLE TRIGGER USER`);
  };
  // Prix falsifié : l'écriture du grand livre ne correspond plus à l'achat.
  const price = await codesIn(async (client) => {
    await triggersOff(client, "active_search_purchases");
    await client.query("UPDATE active_search_purchases SET price_xof = 1999 WHERE id = $1", [bought.purchaseId]);
  });
  assert.ok(price.includes("active_search_purchase_mismatch") && price.includes("active_search_revenue_mismatch"), price.join(","));
  // Revenus de la recherche active falsifiés.
  assert.ok((await codesIn(async (client) => {
    await client.query("ALTER TABLE wallet_accounts DISABLE TRIGGER trg_wallet_accounts_guard");
    await client.query("UPDATE wallet_accounts SET balance = balance + 1 WHERE kind = 'active_search_revenue'");
  })).includes("active_search_revenue_mismatch"));
  // Écriture du débit falsifiée.
  assert.ok((await codesIn(async (client) => {
    await client.query("ALTER TABLE wallet_entries DISABLE TRIGGER trg_wallet_entries_immutable");
    await client.query("UPDATE wallet_entries SET amount = amount - 1 WHERE transaction_id = $1 AND amount = -2000", [(await purchasesOf(w.demandId))[0].transaction_id]);
  })).includes("active_search_purchase_mismatch"));
  // Transaction de débit orpheline (sans achat), puis de remboursement orpheline.
  assert.ok((await codesIn(async (client) => {
    await client.query("SET LOCAL session_replication_role = replica");
    const id = randomUUID();
    await client.query("INSERT INTO wallet_transactions (id, kind, reference, metadata) VALUES ($1, 'search_purchase', $2, $3::jsonb)", [id, `search_purchase:${id}`, JSON.stringify({ activeSearchId: id })]);
  })).includes("active_search_purchase_transaction_orphan"));
  assert.ok((await codesIn(async (client) => {
    await client.query("SET LOCAL session_replication_role = replica");
    const id = randomUUID();
    await client.query("INSERT INTO wallet_transactions (id, kind, reference, metadata) VALUES ($1, 'search_refund', $2, $3::jsonb)", [id, `search_refund:${id}`, JSON.stringify({ activeSearchId: id, reasonCode: "faux" })]);
  })).includes("active_search_refund_transaction_orphan"));
  // Remboursement qui ne correspond pas : date sans transaction valide, puis écriture du remboursement falsifiée.
  assert.ok((await codesIn(async (client) => {
    await triggersOff(client, "active_search_purchases");
    await client.query("UPDATE active_search_purchases SET refunded_at = clock_timestamp(), refund_transaction_id = transaction_id WHERE id = $1", [bought.purchaseId]);
  })).includes("active_search_refund_mismatch"));
  assert.ok((await codesIn(async (client) => {
    await client.query("ALTER TABLE wallet_entries DISABLE TRIGGER trg_wallet_entries_immutable");
    const refundTx = (await purchasesOf(refundedWorld.demandId))[0].refund_transaction_id;
    await client.query("UPDATE wallet_entries SET amount = amount + 1 WHERE transaction_id = $1 AND amount > 0", [refundTx]);
  })).includes("active_search_refund_mismatch"));
  // Horizon dépassé et chevauchement.
  assert.ok((await codesIn(async (client) => {
    await triggersOff(client, "active_search_purchases");
    await client.query("UPDATE active_search_purchases SET ends_at = created_at + interval '181 days' WHERE id = $1", [bought.purchaseId]);
  })).includes("active_search_horizon_exceeded"));
  assert.ok((await codesIn(async (client) => {
    await triggersOff(client, "active_search_purchases");
    await client.query("SET LOCAL session_replication_role = replica");
    const id = randomUUID();
    const tx = randomUUID();
    await client.query("INSERT INTO wallet_transactions (id, kind, reference, metadata) VALUES ($1, 'search_purchase', $2, $3::jsonb)", [tx, `search_purchase:${id}`, JSON.stringify({ activeSearchId: id })]);
    await client.query(
      `INSERT INTO active_search_purchases (id, user_id, demand_id, number, kind, price_xof, duration_days, starts_at, ends_at, transaction_id, idempotency_key)
       SELECT $1, user_id, demand_id, 2, 'extension', price_xof, 30, starts_at + interval '1 day', ends_at + interval '1 day', $2, gen_random_uuid() FROM active_search_purchases WHERE id = $3`,
      [id, tx, bought.purchaseId]);
  })).includes("active_search_overlap"));
  // Un compte système de revenus touché hors de son rôle.
  assert.ok((await codesIn(async (client) => {
    await client.query("ALTER TABLE wallet_entries DISABLE TRIGGER trg_wallet_entries_account_usage");
    const tx = randomUUID();
    await client.query("INSERT INTO wallet_transactions (id, kind, reference, metadata) VALUES ($1, 'adjustment', $2, '{\"reasonCode\":\"fraude\"}'::jsonb)", [tx, `adjustment:${tx}`]);
    await client.query("INSERT INTO wallet_entries (id, transaction_id, account_id, amount) SELECT gen_random_uuid(), $1, id, -100 FROM wallet_accounts WHERE kind = 'active_search_revenue'", [tx]);
    await client.query("INSERT INTO wallet_entries (id, transaction_id, account_id, amount) SELECT gen_random_uuid(), $1, id, 100 FROM wallet_accounts WHERE kind = 'boost_revenue'", [tx]);
  })).includes("promo_account_misuse"));
  // Le compte promotionnel touché par un achat de recherche active.
  const pro = await makePro(pool, 10_000);
  assert.ok((await codesIn(async (client) => {
    await client.query("ALTER TABLE wallet_entries DISABLE TRIGGER trg_wallet_entries_account_usage");
    const id = randomUUID();
    await client.query("INSERT INTO wallet_transactions (id, kind, reference, metadata) VALUES ($1, 'search_purchase', $2, $3::jsonb)", [id, `search_purchase:${id}`, JSON.stringify({ activeSearchId: id })]);
    await client.query("INSERT INTO wallet_entries (id, transaction_id, account_id, amount) SELECT gen_random_uuid(), $1, id, -2000 FROM wallet_accounts WHERE kind = 'user_promo' AND owner_id = $2", [id, pro.userId]);
    await client.query("INSERT INTO wallet_entries (id, transaction_id, account_id, amount) SELECT gen_random_uuid(), $1, id, 2000 FROM wallet_accounts WHERE kind = 'active_search_revenue'", [id]);
  })).includes("promo_account_misuse"));
  // Doublon du compte système.
  assert.ok((await codesIn(async (client) => {
    await client.query("DROP INDEX uq_wallet_accounts_system_kind");
    await client.query("INSERT INTO wallet_accounts (id, kind, owner_id, balance) VALUES (gen_random_uuid(), 'active_search_revenue', NULL, 0)");
  })).includes("system_account_invalid"));
  await assertWalletGreen(pool, "le schéma propre n'a jamais été corrompu");
});

// ═════════════ 11. Gardes de la base ═════════════

test("la base refuse : un achat sans débit correspondant, un achat déjà remboursé ou avancé, un chevauchement, une modification du prix ou de la période, un état final qui bouge, une suppression, un remboursement qui ne correspond pas", async () => {
  const w = await world(10_000);
  const bought = await buy(w);
  const row = (await purchasesOf(w.demandId))[0];
  // INSERT : transaction du grand livre qui n'est pas le débit de CE prix par CET acheteur.
  const insertPurchase = (overrides: Record<string, string | number | null> = {}) => async (client: PoolClient) => {
    const id = randomUUID();
    const values: Record<string, string | number | null> = {
      id, user_id: w.userId, demand_id: w.demandId, number: 2, kind: "extension", price_xof: PRICE, duration_days: 30,
      starts_at: row.ends_at.toISOString(), ends_at: at(row.ends_at, 30).toISOString(), transaction_id: null, idempotency_key: randomUUID(), ...overrides,
    };
    if (values.transaction_id === null) {
      const posted = await postWalletTransaction(client, {
        kind: "search_purchase", reference: `search_purchase:${id}`, metadata: { activeSearchId: id },
        entries: [{ account: { kind: "user", ownerId: w.userId }, amount: BigInt(-PRICE) }, { account: { kind: "active_search_revenue" }, amount: BigInt(PRICE) }],
      });
      values.transaction_id = posted.id;
    }
    const columns = Object.keys(values);
    await client.query(`INSERT INTO active_search_purchases (${columns.join(", ")}) VALUES (${columns.map((_, index) => `$${index + 1}`).join(", ")})`, columns.map((name) => values[name]));
  };
  assert.equal(await failureOf(insertPurchase(), true), null, "un achat régulier est accepté (et validé ici : numéro 2)");
  // Le prix de l'achat ne correspond pas à son débit.
  assert.equal((await failureOf(insertPurchase({ number: 3, price_xof: 2001, starts_at: at(row.ends_at, 30).toISOString(), ends_at: at(row.ends_at, 60).toISOString() })))?.constraint, "trg_active_search_purchases_insert_guard");
  // Une transaction du grand livre d'un AUTRE achat : débit sans correspondance de référence.
  assert.equal((await failureOf(insertPurchase({ number: 3, transaction_id: row.transaction_id, starts_at: at(row.ends_at, 30).toISOString(), ends_at: at(row.ends_at, 60).toISOString() })))?.constraint,
    "trg_active_search_purchases_insert_guard", "la transaction d'un AUTRE achat n'est pas le débit de celui-ci");
  // Déjà remboursé ou avancé à la naissance.
  const refundedBirth = await failureOf(insertPurchase({ number: 3, status: "ended", starts_at: at(row.ends_at, 30).toISOString(), ends_at: at(row.ends_at, 60).toISOString() }));
  assert.equal(refundedBirth?.constraint, "trg_active_search_purchases_insert_guard");
  // Chevauchement avec la période existante.
  const overlap = await failureOf(insertPurchase({ number: 3, starts_at: at(row.starts_at, 5).toISOString(), ends_at: at(row.starts_at, 35).toISOString() }));
  assert.equal(overlap?.code, "23001");
  // Contraintes de forme.
  // M6 : la fin DOIT être début + durée ; le garde d'insertion la refuse AVANT la contrainte de forme (qui reste, derrière lui, quand les déclencheurs sont désactivés).
  const emptyPeriod = await failureOf(insertPurchase({ number: 3, starts_at: at(row.ends_at, 30).toISOString(), ends_at: at(row.ends_at, 30).toISOString() }));
  assert.equal(emptyPeriod?.constraint, "trg_active_search_purchases_insert_guard");
  assert.match(emptyPeriod?.message ?? "", /active_search_purchase_period_mismatch/);
  const behindGuard = await failureOf(async (client) => {
    await client.query("ALTER TABLE active_search_purchases DISABLE TRIGGER USER");
    await insertPurchase({ number: 3, starts_at: at(row.ends_at, 30).toISOString(), ends_at: at(row.ends_at, 30).toISOString() })(client);
  });
  assert.equal(behindGuard?.constraint, "chk_active_search_purchases_period", "la contrainte de forme reste derrière le garde");
  assert.equal((await failureOf(insertPurchase({ number: 2, starts_at: at(row.ends_at, 100).toISOString(), ends_at: at(row.ends_at, 130).toISOString() })))?.constraint, "uq_active_search_purchases_number");
  // Immuabilité : prix, période, propriétaire, besoin, numéro ; suppression ; état final.
  for (const set of ["price_xof = 1999", "ends_at = ends_at + interval '1 day'", "starts_at = starts_at + interval '1 day'", "number = 9", "kind = 'extension'", "duration_days = 31", "created_at = created_at + interval '1 day'"]) {
    assert.equal((await failureOf((client) => client.query(`UPDATE active_search_purchases SET ${set} WHERE id = $1`, [bought.purchaseId])))?.code, "23001", set);
  }
  assert.equal((await failureOf((client) => client.query("DELETE FROM active_search_purchases WHERE id = $1", [bought.purchaseId])))?.code, "23001");
  await runActiveSearchMaintenance(pool, at(w.t0, 100));
  assert.equal((await failureOf((client) => client.query("UPDATE active_search_purchases SET status = 'active' WHERE id = $1", [bought.purchaseId])))?.code, "23001", "un état final reste final");
  // Remboursement dont la transaction n'est pas le remboursement intégral de CET achat.
  const bogus = await failureOf((client) => client.query("UPDATE active_search_purchases SET refunded_at = clock_timestamp(), refund_transaction_id = transaction_id WHERE id = $1", [bought.purchaseId]));
  assert.equal(bogus?.constraint, "trg_active_search_purchases_guard");
  // Une transaction de débit sans achat n'est jamais validée.
  const unlinked = await failureOf(async (client) => {
    const id = randomUUID();
    await postWalletTransaction(client, {
      kind: "search_purchase", reference: `search_purchase:${id}`, metadata: { activeSearchId: id },
      entries: [{ account: { kind: "user", ownerId: w.userId }, amount: BigInt(-PRICE) }, { account: { kind: "active_search_revenue" }, amount: BigInt(PRICE) }],
    });
  }, true);
  assert.equal(unlinked?.constraint, "trg_active_search_transactions_linked");
  await assertWalletGreen(pool, "après les refus de la base");
});

// ═════════════ 11 bis. Lot RA1-bis : éligibilité, prix affiché, capacité, gardes ═════════════

/** Retire puis remet les connecteurs fictifs : le temps de `run`, les sources fictives sont désactivées (aucune collecte possible). */
async function withSources<T>(update: string, restore: string, run: () => Promise<T>): Promise<T> {
  await pool.query(update);
  try { return await run(); } finally { await pool.query(restore); }
}

test("B1 / P5-a : un besoin ACTIF sans catégorie, marque ni modèle ne se vend pas (no_product_key) : rien n'est écrit ni débité, l'état le dit, aucune clé accélérée", async () => {
  const user = (await makeDemand(pool, {})).ownerId;
  await fund(pool, user, 5_000);
  const bare = await createDemand({ ownerId: user, rawText: "Je cherche quelque chose de bien pour mon salon", status: "active" }, pool);
  assert.deepEqual([bare.category, bare.brand, bare.model], [null, null, null]);
  const missingModel = await createDemand({ ownerId: user, rawText: "Je cherche un téléphone Apple", category: "Téléphones", brand: "Apple", status: "active" }, pool);
  const before = await snapshot();
  for (const demandId of [bare.id, missingModel.id]) {
    assert.equal(await code(buy({ userId: user, demandId, t0: new Date() })), "no_product_key", demandId);
    const state = await readActiveSearchState({ env: FAKE_ENV, executor: pool, ownerId: user, demandId });
    assert.deepEqual([state.canPurchase, state.blockedReason, state.nextEndsAt], [false, "no_product_key", null]);
  }
  assert.deepEqual(await snapshot(), before, "aucune écriture, aucun débit");
  assert.equal(await balanceOf(pool, user), BigInt(5_000));
});

test("B1 : « pas encore disponible » (unavailable) quand la collecte externe ne peut rien fournir — aucun connecteur (environnement sans NOMA_EXTERNAL_FAKE), production, ou aucune source active — achat refusé SANS écriture, état identique ; disponible dès qu'un connecteur ET une source existent", async () => {
  const w = await world(5_000);
  const before = await snapshot();
  const attempt = (env: Record<string, string>) => code(purchaseActiveSearch({ expectedPriceXof: PRICE, env, pool, userId: w.userId, demandId: w.demandId, idempotencyKey: key(), now: w.t0 }));
  const stateWith = (env: Record<string, string>) => readActiveSearchState({ env, executor: pool, ownerId: w.userId, demandId: w.demandId, now: w.t0 });
  const unavailableEnvironments: Array<Record<string, string>> = [{}, { NOMA_EXTERNAL_FAKE: "0" }, { NOMA_EXTERNAL_FAKE: "true" }, { NODE_ENV: "production", NOMA_EXTERNAL_FAKE: "1" }];
  for (const env of unavailableEnvironments) {
    assert.equal(await attempt(env), "unavailable", JSON.stringify(env));
    const state = await stateWith(env);
    assert.deepEqual([state.canPurchase, state.blockedReason, state.nextEndsAt], [false, "unavailable", null], JSON.stringify(env));
  }
  assert.deepEqual(await snapshot(), before, "aucune écriture, aucun débit");
  // Connecteurs présents mais AUCUNE source active : toujours indisponible.
  await withSources("UPDATE external_sources SET enabled = FALSE", "UPDATE external_sources SET enabled = TRUE", async () => {
    assert.equal(await attempt({ NOMA_EXTERNAL_FAKE: "1" }), "unavailable", "aucune source active");
    assert.equal((await stateWith({ NOMA_EXTERNAL_FAKE: "1" })).blockedReason, "unavailable");
  });
  assert.deepEqual(await snapshot(), before);
  assert.equal((await stateWith({ NOMA_EXTERNAL_FAKE: "1" })).canPurchase, true, "connecteurs ET sources : disponible");
  assert.equal(await attempt({ NOMA_EXTERNAL_FAKE: "1" }), "ok");
  // Une option déjà en vigueur reste lisible et en vigueur quand la collecte devient indisponible ; seul un nouvel achat est refusé.
  const live = await stateWith({});
  assert.deepEqual([live.active, live.canPurchase, live.blockedReason], [true, false, "unavailable"]);
});

test("B1 : l'éligibilité (statut, clé produit, disponibilité) est décidée à UN endroit : l'achat refuse exactement ce que l'état annonce comme impossible", async () => {
  const w = await world(5_000);
  const draft = await world(5_000, { status: "draft" });
  const cases: Array<[string, World, Record<string, string>, string]> = [
    ["actif, disponible", w, { NOMA_EXTERNAL_FAKE: "1" }, "ok"],
    ["brouillon", draft, { NOMA_EXTERNAL_FAKE: "1" }, "demand_not_active"],
    ["indisponible", await world(5_000), {}, "unavailable"],
  ];
  for (const [label, target, env, expected] of cases) {
    const state = await readActiveSearchState({ env, executor: pool, ownerId: target.userId, demandId: target.demandId, now: target.t0 });
    const outcome = await code(purchaseActiveSearch({ expectedPriceXof: PRICE, env, pool, userId: target.userId, demandId: target.demandId, idempotencyKey: key(), now: target.t0 }));
    assert.equal(outcome, expected, label);
    assert.equal(state.canPurchase, expected === "ok", label);
    assert.equal(state.blockedReason, expected === "ok" ? null : expected, label);
  }
});

test("A6 : le prix AFFICHÉ est exigé et comparé au prix courant (price_changed) : un prix différent (1 999, 2 001) ne débite rien ; le bon prix passe ; un prix invalide est refusé avant tout SQL", async () => {
  const w = await world(5_000);
  const before = await snapshot();
  for (const expectedPriceXof of [1_999, 2_001, 1, 100_000]) {
    assert.equal(await code(purchaseActiveSearch({ expectedPriceXof, env: FAKE_ENV, pool, userId: w.userId, demandId: w.demandId, idempotencyKey: key(), now: w.t0 })), "price_changed", String(expectedPriceXof));
  }
  for (const expectedPriceXof of [0, -2_000, 2_000.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2, "2000" as unknown as number, undefined as unknown as number]) {
    assert.match(await code(purchaseActiveSearch({ expectedPriceXof, env: FAKE_ENV, pool, userId: w.userId, demandId: w.demandId, idempotencyKey: key(), now: w.t0 })), /CatalogValidationError/, String(expectedPriceXof));
  }
  assert.deepEqual(await snapshot(), before, "aucun refus n'écrit ni ne débite");
  assert.equal(await balanceOf(pool, w.userId), BigInt(5_000));
  assert.equal(await code(buy(w)), "ok", "le prix affiché exact passe");
  // Le rejeu de la clé d'un achat réel avec un prix affiché qui n'est pas celui payé : price_changed, jamais « déjà enregistré » ; avec le prix payé : rejeu normal.
  const idempotency = key();
  const second = await buy(w, { key: idempotency, now: at(w.t0, 1) });
  assert.equal(await code(purchaseActiveSearch({ expectedPriceXof: 1_500, env: FAKE_ENV, pool, userId: w.userId, demandId: w.demandId, idempotencyKey: idempotency, now: at(w.t0, 2) })), "price_changed");
  const replay = await buy(w, { key: idempotency, now: at(w.t0, 2) });
  assert.equal(replay.reused, true);
  assert.equal(replay.purchaseId, second.purchaseId);
});

test("M4 / P2-e : rejeu de la clé d'un achat REMBOURSÉ → « option remboursée » (purchase_refunded), jamais « déjà enregistré » : aucune période, aucun débit ; une NOUVELLE clé rachète normalement", async () => {
  const w = await world(5_000);
  const idempotency = key();
  const bought = await buy(w, { key: idempotency });
  await refundActiveSearchPurchase({ pool, purchaseId: bought.purchaseId, reasonCode: "audit", now: at(w.t0, 1) });
  const before = await snapshot();
  assert.equal(await code(buy(w, { key: idempotency, now: at(w.t0, 2) })), "purchase_refunded");
  assert.deepEqual(await snapshot(), before, "le rejeu refusé n'écrit rien");
  assert.equal((await readActiveSearchState({ env: FAKE_ENV, executor: pool, ownerId: w.userId, demandId: w.demandId, now: at(w.t0, 2) })).active, false);
  const again = await buy(w, { now: at(w.t0, 2) });
  assert.equal(again.reused, false);
  assert.equal(again.kind, "activation");
  await assertWalletGreen(pool, "après le rachat suivant un remboursement");
});

test("A5 : ADMISSION — au quota par défaut (200 par jour et par source) au plus 4 produits accélérés à la fois ; une clé déjà engagée (autre acheteur, prolongation) n'ajoute rien ; refus sans écriture ; sous concurrence, jamais plus que la capacité", async () => {
  const t0 = at(new Date(), 400);
  // Plafond par utilisateur (RA1-ter) : deux produits distincts au plus par acheteur, donc quatre produits = deux acheteurs.
  const buyer = await makeDemand(pool, {});
  const second = await makeDemand(pool, {});
  const third = await makeDemand(pool, {});
  for (const owner of [buyer.ownerId, second.ownerId, third.ownerId]) await fund(pool, owner, 100_000);
  const make = async (model: string, owner = buyer.ownerId): Promise<World> => {
    const demand = await makeDemand(pool, { ownerId: owner, brand: "Google", model });
    return { userId: owner, demandId: demand.id, t0 };
  };
  const options = [await make("Pixel 1"), await make("Pixel 2"), await make("Pixel 3", second.ownerId), await make("Pixel 4", second.ownerId), await make("Pixel 5", third.ownerId), await make("Pixel 6", third.ownerId)];
  for (const target of options.slice(0, 4)) assert.equal(await code(buy(target)), "ok");
  const before = await snapshot();
  assert.equal(await code(buy(options[4])), "capacity", "5e produit distinct : capacité atteinte");
  assert.equal(await code(buy(options[5])), "capacity");
  assert.deepEqual(await snapshot(), before, "le refus n'écrit rien et ne débite rien");
  const state = await readActiveSearchState({ env: FAKE_ENV, executor: pool, ownerId: third.ownerId, demandId: options[4].demandId, now: t0 });
  assert.deepEqual([state.canPurchase, state.blockedReason], [false, "capacity"]);
  // Prolonger une option déjà engagée : toujours possible.
  assert.equal((await buy(options[0], { now: at(t0, 5) })).kind, "extension");
  // Une autre personne qui cherche le MÊME produit (surveillance partagée) n'ajoute aucune surveillance : admise.
  const other = await makeDemand(pool, { brand: "Google", model: "Pixel 1" });
  await fund(pool, other.ownerId, 5_000);
  assert.equal(await code(buy({ userId: other.ownerId, demandId: other.id, t0 })), "ok", "clé déjà engagée par un autre acheteur");
  // Quota d'une source plus petit : la capacité suit le plus petit quota des sources actives (100 → 2 surveillances), sans rien casser de l'existant.
  await withSources("UPDATE external_sources SET daily_quota = 100 WHERE code = 'demo_a'", "UPDATE external_sources SET daily_quota = 200", async () => {
    const late = at(new Date(), 800);
    const lateOptions = [await make("Galaxy A1"), await make("Galaxy A2", second.ownerId), await make("Galaxy A3", third.ownerId)];
    const outcomes: string[] = [];
    for (const target of lateOptions) outcomes.push(await code(buy({ ...target, t0: late })));
    assert.deepEqual(outcomes, ["ok", "ok", "capacity"], "quota 100 → 50 requêtes accélérées → 2 surveillances de 24");
  });
  // Concurrence (verrou global d'admission) : 6 activations simultanées de produits distincts (six acheteurs) ne dépassent jamais 4.
  const crowd = at(new Date(), 1_200);
  const racers: World[] = [];
  for (let index = 1; index <= 6; index += 1) {
    const racer = await makeDemand(pool, {});
    await fund(pool, racer.ownerId, 10_000);
    racers.push({ ...(await make(`Redmi ${index}`, racer.ownerId)), t0: crowd });
  }
  const raced = await Promise.all(racers.map((target) => code(buy(target, { pool: wide }))));
  assert.equal(raced.filter((entry) => entry === "ok").length, 4, raced.join(","));
  assert.equal(raced.filter((entry) => entry === "capacity").length, 2, raced.join(","));
  assert.equal(await scalar(pool, "SELECT count(*)::int AS n FROM active_search_places"), 4, "jamais plus de places que la capacité");
  await assertWalletGreen(pool, "après les refus de capacité");
});

test("M3 / P5-b : l'avis d'échéance lit la FIN DE LA CHAÎNE au moment de la lecture : après une prolongation payée, la notification n'affiche plus l'ancienne fin", async () => {
  const w = await world(10_000);
  const first = await buy(w);
  await runActiveSearchMaintenance(pool, at(w.t0, 28));
  const page = () => listNotifications({ pool, userId: w.userId });
  const notice = (await page()).items.find((item) => item.kind === "active_search_expiring");
  assert.equal(new Date(notice?.endsAt ?? "").getTime(), first.endsAt.getTime(), "avant la prolongation : fin de la période");
  const second = await buy(w, { now: at(w.t0, 28) });
  const after = (await page()).items.find((item) => item.kind === "active_search_expiring");
  assert.equal(new Date(after?.endsAt ?? "").getTime(), second.endsAt.getTime(), "après la prolongation : fin de la chaîne");
  assert.equal(second.endsAt.getTime(), at(w.t0, 60).getTime());
  // Un achat remboursé ne prolonge rien : la fin redevient celle de la période restante.
  await refundActiveSearchPurchase({ pool, purchaseId: second.purchaseId, reasonCode: "audit", now: at(w.t0, 29) });
  const refunded = (await page()).items.find((item) => item.kind === "active_search_expiring");
  assert.equal(new Date(refunded?.endsAt ?? "").getTime(), first.endsAt.getTime());
});

test("M1 / P6-a : un achat arrêté ne change plus (raison, date d'arrêt) ; l'avis envoyé non plus (NULL → valeur seulement) ; l'état actif garde ses transitions", async () => {
  const w = await world(5_000);
  const bought = await buy(w);
  const version = await scalar<number>(pool, "SELECT content_version AS n FROM demands WHERE id = $1", [w.demandId]);
  await archiveDemand(w.userId, w.demandId, version, pool);
  await runActiveSearchMaintenance(pool, at(w.t0, 1));
  const row = (await purchasesOf(w.demandId))[0];
  assert.deepEqual([row.status, row.stop_reason], ["stopped", "demand_archived"]);
  for (const set of ["stop_reason = 'refunded'", "stopped_at = '2000-01-01'", "stop_reason = NULL"]) {
    const failure = await failureOf((client) => client.query(`UPDATE active_search_purchases SET ${set} WHERE id = $1`, [bought.purchaseId]));
    assert.equal(failure?.code, "23001", set);
    assert.match(failure?.message ?? "", /active_search_stop_final/, set);
  }
  // L'avis : NULL → valeur autorisé une fois (même arrêté), ensuite figé.
  assert.equal(await failureOf((client) => client.query("UPDATE active_search_purchases SET notice_sent_at = $2 WHERE id = $1", [bought.purchaseId, at(w.t0, 2).toISOString()]), true), null, "NULL → valeur : autorisé");
  for (const set of ["notice_sent_at = now()", "notice_sent_at = NULL"]) {
    const failure = await failureOf((client) => client.query(`UPDATE active_search_purchases SET ${set} WHERE id = $1`, [bought.purchaseId]));
    assert.match(failure?.message ?? "", /active_search_notice_final/, set);
  }
  // Un achat encore actif garde ses transitions normales (fin de période, arrêt).
  const live = await world(5_000);
  const liveBought = await buy(live);
  assert.equal(await failureOf((client) => client.query("UPDATE active_search_purchases SET status = 'ended' WHERE id = $1", [liveBought.purchaseId])), null);
});

test("M6 : la base refuse un achat dont la fin n'est pas début + durée, ou dont l'acheteur n'est pas le propriétaire du besoin ; wallet:check les détecte aussi quand les gardes sont contournés", async () => {
  const w = await world(10_000);
  const stranger = await world(10_000);
  const insert = (overrides: Record<string, string | number>) => async (client: PoolClient) => {
    const id = randomUUID();
    const values: Record<string, string | number> = {
      id, user_id: w.userId, demand_id: w.demandId, number: 1, kind: "activation", price_xof: PRICE, duration_days: 30,
      starts_at: w.t0.toISOString(), ends_at: at(w.t0, 30).toISOString(), idempotency_key: randomUUID(), ...overrides,
    };
    const payer = String(values.user_id);
    const posted = await postWalletTransaction(client, {
      kind: "search_purchase", reference: `search_purchase:${id}`, metadata: { activeSearchId: id },
      entries: [{ account: { kind: "user", ownerId: payer }, amount: BigInt(-PRICE) }, { account: { kind: "active_search_revenue" }, amount: BigInt(PRICE) }],
    });
    values.transaction_id = posted.id;
    const columns = Object.keys(values);
    await client.query(`INSERT INTO active_search_purchases (${columns.join(", ")}) VALUES (${columns.map((_, index) => `$${index + 1}`).join(", ")})`, columns.map((name) => values[name]));
  };
  const shortEnd = await failureOf(insert({ ends_at: at(w.t0, 29).toISOString() }));
  assert.match(shortEnd?.message ?? "", /active_search_purchase_period_mismatch/);
  const longEnd = await failureOf(insert({ ends_at: at(w.t0, 31).toISOString() }));
  assert.match(longEnd?.message ?? "", /active_search_purchase_period_mismatch/);
  const wrongDuration = await failureOf(insert({ duration_days: 7 }));
  assert.match(wrongDuration?.message ?? "", /active_search_purchase_period_mismatch/, "30 jours de période pour une durée déclarée de 7");
  const notOwner = await failureOf(insert({ user_id: stranger.userId }));
  assert.match(notOwner?.message ?? "", /active_search_purchase_owner_mismatch/, "l'acheteur est le propriétaire du besoin");
  assert.equal(await failureOf(insert({}), false), null, "un achat régulier passe (annulé ici)");
  // wallet:check : mêmes contrôles quand les déclencheurs sont contournés (écriture directe sous le service).
  const codesOf = async (corrupt: (client: PoolClient) => Promise<void>): Promise<string[]> => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await corrupt(client);
      const report = await runWalletCheck(client);
      await client.query("ROLLBACK");
      return report.violations.map((violation) => violation.code);
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { /* garder l'erreur utile */ }
      throw error;
    } finally {
      client.release();
    }
  };
  const regular = await buy(w);
  assert.ok((await codesOf(async (client) => {
    await client.query("ALTER TABLE active_search_purchases DISABLE TRIGGER USER");
    await client.query("UPDATE active_search_purchases SET ends_at = ends_at - interval '1 day' WHERE id = $1", [regular.purchaseId]);
  })).includes("active_search_period_mismatch"));
  assert.ok((await codesOf(async (client) => {
    await client.query("ALTER TABLE active_search_purchases DISABLE TRIGGER USER");
    await client.query("UPDATE active_search_purchases SET duration_days = 7 WHERE id = $1", [regular.purchaseId]);
  })).includes("active_search_period_mismatch"), "durée déclarée différente de la période");
  assert.ok((await codesOf(async (client) => {
    await client.query("ALTER TABLE active_search_purchases DISABLE TRIGGER USER");
    await client.query("UPDATE active_search_purchases SET user_id = $2 WHERE id = $1", [regular.purchaseId, stranger.userId]);
  })).includes("active_search_owner_mismatch"));
  await assertWalletGreen(pool, "les corruptions étaient annulées");
});

test("A3 : wallet:check ne signale un chevauchement QUE pour des périodes en vigueur : une période remboursée ou arrêtée qui recouvre un nouvel achat n'est pas une anomalie", async () => {
  const w = await world(10_000);
  const first = await buy(w);
  await refundActiveSearchPurchase({ pool, purchaseId: first.purchaseId, reasonCode: "chevauchement", now: at(w.t0, 1) });
  const second = await buy(w, { now: at(w.t0, 2) });
  assert.equal(second.kind, "activation");
  const periods = (await purchasesOf(w.demandId)).map((row) => [row.status, row.starts_at.getTime(), row.ends_at.getTime()]);
  assert.ok((periods[0][2] as number) > (periods[1][1] as number), "la période remboursée recouvre bien la nouvelle");
  assert.deepEqual((await runWalletCheck(pool)).violations, [], "aucun faux positif");
  // Un vrai chevauchement de deux périodes EN VIGUEUR reste détecté (déjà couvert par la corruption injectée de la section wallet:check).
  const clean = await world(10_000);
  const one = await buy(clean);
  await runActiveSearchMaintenance(pool, at(clean.t0, 40));
  assert.equal((await purchasesOf(clean.demandId))[0].status, "ended");
  assert.equal(one.kind, "activation");
  assert.deepEqual((await runWalletCheck(pool)).violations, []);
});

// ═════════════ 12. Sans la migration 0028 ═════════════

test("sans les tables de la recherche active : lecture de l'état sans erreur (rien en vigueur), entretien ignoré (skipped), plafond du suivi à 90 jours", async () => {
  const second = await openTestSchema(2);
  const bare = second.pool;
  const { scanActiveSearchDemands } = await import("../../lib/server/active-search/notify");
  const { runActiveSearchStep } = await import("../../lib/server/active-search/step");
  const w = await makeDemand(bare, {});
  await bare.query("DROP TABLE active_search_seen, active_search_state, active_search_purchases CASCADE");
  const state = await readActiveSearchState({ env: FAKE_ENV, executor: bare, ownerId: w.ownerId, demandId: w.id });
  assert.equal(state.active, false);
  assert.equal(state.canPurchase, false);
  assert.equal(state.blockedReason, "unavailable", "sans les tables, la recherche active n'est pas disponible (jamais une erreur)");
  assert.equal((await runActiveSearchMaintenance(bare, new Date())).skipped, true);
  assert.equal(await trackingMaxDaysFor(bare, w.id, new Date()), 90);
  assert.equal((await scanActiveSearchDemands({ pool: bare, now: new Date() })).skipped, true);
  const step = await runActiveSearchStep({ pool: bare });
  assert.deepEqual([step.skipped, step.errors], [true, []], "l'étape du worker est ignorée sans erreur");
  await second.close();
});
