import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { Pool, type PoolClient, type PoolConfig } from "pg";
import { BoostError } from "../../lib/server/boost/boosts";
import { purchaseOfferBoost, refundBoostPurchase, listOfferBoostPurchases } from "../../lib/server/boost/purchase";
import { runMigrations } from "../../lib/server/postgres/migrations";
import { runSubscriptionStep, setSubscriptionAutoRenew } from "../../lib/server/subscriptions/lifecycle";
import { readPromoSummary, splitBoostPrice } from "../../lib/server/subscriptions/promo";
import { runWalletCheck } from "../../lib/server/wallet/check";
import { WalletError } from "../../lib/server/wallet/errors";
import { readWalletOverview } from "../../lib/server/wallet/ledger";
import {
  HOUR, MINUTE, addMs, assertWalletGreen, balanceOf, big, buyWorld, countRows, fund, insertQuote, ledgerSnapshot, makeOffer, makePro, makeScope, makeUser, periodOf,
  promoLedgerBalance, scalar, subscribePro, systemBalance,
} from "./pro-fixtures";
import {
  createTemporarySchemaName, openVerifiedIsolatedPool, openVerifiedTestDatabase, quoteTemporarySchema, type DedicatedTestDatabase,
} from "./test-database";

const schema = createTemporarySchemaName();
const quoted = quoteTemporarySchema(schema);
let admin: Pool;
let target: DedicatedTestDatabase;
let pool: Pool;
let widePool: Pool;
let txPool: Pool;
const RUN_ID = `pbo_${process.pid}_${randomBytes(4).toString("hex")}`;
const named = (label: string, max: number) => (config: PoolConfig): Pool => new Pool({ ...config, max, application_name: `${RUN_ID}_${label}` });

before(async () => {
  const opened = await openVerifiedTestDatabase(process.env.TEST_DATABASE_URL);
  admin = opened.pool;
  target = opened.target;
  await admin.query(`CREATE SCHEMA ${quoted}`);
  pool = await openVerifiedIsolatedPool(target, schema, named("main", 4));
  widePool = await openVerifiedIsolatedPool(target, schema, named("wide", 16));
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

async function outcome(promise: Promise<unknown>): Promise<string> {
  try { await promise; return "ok"; } catch (error) {
    if (error instanceof BoostError || error instanceof WalletError) return error.code;
    return `${(error as Error).name}: ${(error as Error).message}`;
  }
}

interface Failure { code?: string; constraint?: string }
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

const setCategorySettings = (category: string, values: Partial<Record<string, number>>) => {
  const merged = { slot_ratio: 0.15, min_slots: 1, max_slots: 50, max_active_per_seller: 2, max_seller_slot_share: 0.34, max_promoted_share: 0.15, min_relevance: 60, ...values };
  return pool.query(
    `INSERT INTO boost_settings (key, slot_ratio, min_slots, max_slots, max_active_per_seller, max_seller_slot_share, max_promoted_share, min_relevance)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (key) DO UPDATE SET slot_ratio = $2, min_slots = $3, max_slots = $4, max_active_per_seller = $5,
       max_seller_slot_share = $6, max_promoted_share = $7, min_relevance = $8`,
    [category, merged.slot_ratio, merged.min_slots, merged.max_slots, merged.max_active_per_seller, merged.max_seller_slot_share, merged.max_promoted_share, merged.min_relevance]);
};

/** Un vendeur abonné Pro (5 000 XOF de crédits promotionnels) avec `paid` XOF de crédits payés restants. */
async function proSeller(paid: number): Promise<string> {
  const { userId } = await makePro(pool, 10_000 + paid);
  assert.equal(await balanceOf(pool, userId), big(paid));
  return userId;
}

const buy = (world: { sellerId: string; offer: { id: string }; quoteId: string }, db: Pool = pool, key = randomUUID()) =>
  purchaseOfferBoost({ pool: db, sellerId: world.sellerId, offerId: world.offer.id, quoteId: world.quoteId, idempotencyKey: key });

// ═════════════ 1. Répartition pure ═════════════

test("répartition pure : les crédits promotionnels d'abord (émission qui expire la première), les crédits payés pour le reste, jamais de part négative ni de dépassement", () => {
  const grant = (id: string, remaining: number) => ({ id, expiresAt: new Date(), remaining: big(remaining) });
  assert.deepEqual(splitBoostPrice(big(2300), [grant("a", 5000)]), { paid: big(0), promo: big(2300), allocations: [{ grantId: "a", amount: big(2300) }] });
  assert.deepEqual(splitBoostPrice(big(7000), [grant("a", 5000)]), { paid: big(2000), promo: big(5000), allocations: [{ grantId: "a", amount: big(5000) }] });
  assert.deepEqual(splitBoostPrice(big(5000), [grant("a", 5000)]), { paid: big(0), promo: big(5000), allocations: [{ grantId: "a", amount: big(5000) }] });
  assert.deepEqual(splitBoostPrice(big(100), []), { paid: big(100), promo: big(0), allocations: [] });
  assert.deepEqual(splitBoostPrice(big(100), [grant("a", 0)]), { paid: big(100), promo: big(0), allocations: [] }, "une émission vide n'est jamais utilisée");
  // Plusieurs émissions : dans l'ordre donné (celle qui expire la première), jusqu'à concurrence du prix.
  const split = splitBoostPrice(big(800), [grant("a", 300), grant("b", 400), grant("c", 900)]);
  assert.deepEqual(split.allocations, [{ grantId: "a", amount: big(300) }, { grantId: "b", amount: big(400) }, { grantId: "c", amount: big(100) }]);
  assert.equal(split.promo + split.paid, big(800));
  for (const price of [1, 2, 99, 1000, 99999]) {
    const result = splitBoostPrice(big(price), [grant("a", 50), grant("b", 70)]);
    assert.equal(result.promo + result.paid, big(price));
    assert.ok(result.paid >= big(0) && result.promo >= big(0) && result.promo <= big(120));
  }
  assert.throws(() => splitBoostPrice(big(0), []), RangeError);
  assert.throws(() => splitBoostPrice(-big(5), []), RangeError);
  assert.throws(() => splitBoostPrice(5 as never, []), RangeError);
});

// ═════════════ 2. Achat avec crédits promotionnels ═════════════

test("achat : les crédits promotionnels sont dépensés EN PREMIER, les crédits payés ne sont pas touchés tant qu'il en reste ; mêmes écritures, même historique, grand livre vert", async () => {
  const sellerId = await proSeller(20_000);
  const world = await buyWorld(pool, { sellerId, amount: 2300 });
  const revenueBefore = await systemBalance(pool, "boost_revenue");
  const consumedBefore = await systemBalance(pool, "promo_consumed");
  const result = await buy(world);
  assert.equal(result.reused, false);
  assert.equal(result.purchase.amount, big(2300));
  assert.equal(result.purchase.promoAmount, big(2300));
  assert.equal(result.balance, big(20_000), "crédits payés intacts");
  assert.equal((await readPromoSummary(pool, sellerId)).balance, big(5000 - 2300));
  assert.equal(await promoLedgerBalance(pool, sellerId), big(2700));
  assert.equal(await systemBalance(pool, "boost_revenue"), revenueBefore, "aucun revenu de boost en crédits payés");
  assert.equal(await systemBalance(pool, "promo_consumed") - consumedBefore, big(2300));
  // La transaction d'achat : DEUX écritures (user_promo −2 300, promo_consumed +2 300), aucune sur le compte payé.
  const entries = (await pool.query<{ kind: string; amount: string }>(
    `SELECT a.kind, e.amount::text AS amount FROM wallet_entries e JOIN wallet_accounts a ON a.id = e.account_id
      WHERE e.transaction_id = $1 ORDER BY a.kind`, [result.purchase.transactionId])).rows;
  assert.deepEqual(entries, [{ kind: "promo_consumed", amount: "2300" }, { kind: "user_promo", amount: "-2300" }]);
  const row = (await pool.query<{ promo: string; paid: string }>("SELECT promo_xof::text AS promo, paid_xof::text AS paid FROM boost_purchases WHERE id = $1", [result.purchase.id])).rows[0];
  assert.deepEqual(row, { promo: "2300", paid: "0" });
  assert.equal(await scalar(pool, "SELECT sum(amount_xof)::text AS n FROM promo_movements WHERE purchase_id = $1 AND kind = 'spend'", [result.purchase.id]), "2300");
  assert.equal(result.boost.source, "purchase");
  // Historique du vendeur : une ligne par transaction, la part promotionnelle séparée de la part payée.
  const overview = await readWalletOverview({ pool, ownerId: sellerId });
  const line = overview.items.find((item) => item.kind === "boost_purchase");
  assert.ok(line);
  assert.equal(line.amount, big(0));
  assert.equal(line.promoAmount, -big(2300));
  assert.equal(overview.promoBalance, big(2700));
  assert.equal((await listOfferBoostPurchases({ pool, sellerId, offerId: world.offer.id, limit: 5 }))[0].promoAmount, big(2300));
  await assertWalletGreen(pool, "après un achat payé en crédits promotionnels");
});

test("achat à cheval : 7 000 XOF = 5 000 de crédits promotionnels (tout le reste) + 2 000 de crédits payés ; quatre écritures, rien de négatif", async () => {
  const sellerId = await proSeller(20_000);
  const world = await buyWorld(pool, { sellerId, amount: 7000 });
  const result = await buy(world);
  assert.equal(result.purchase.promoAmount, big(5000));
  assert.equal(result.balance, big(18_000));
  assert.equal((await readPromoSummary(pool, sellerId)).balance, big(0));
  assert.equal(await promoLedgerBalance(pool, sellerId), big(0));
  const entries = (await pool.query<{ kind: string; amount: string }>(
    `SELECT a.kind, e.amount::text AS amount FROM wallet_entries e JOIN wallet_accounts a ON a.id = e.account_id WHERE e.transaction_id = $1 ORDER BY a.kind`, [result.purchase.transactionId])).rows;
  assert.deepEqual(entries, [
    { kind: "boost_revenue", amount: "2000" }, { kind: "promo_consumed", amount: "5000" }, { kind: "user", amount: "-2000" }, { kind: "user_promo", amount: "-5000" },
  ]);
  await assertWalletGreen(pool, "après un achat à cheval");
});

test("achat entièrement en crédits promotionnels avec un solde payé NUL ; puis l'achat suivant, sans crédits promotionnels restants, retombe sur les crédits payés", async () => {
  const sellerId = await proSeller(0);
  const first = await buyWorld(pool, { sellerId, amount: 5000 });
  assert.equal((await buy(first)).balance, big(0));
  assert.equal((await readPromoSummary(pool, sellerId)).balance, big(0));
  // Plus de crédits promotionnels, plus de crédits payés : refus, rien d'écrit.
  const second = await buyWorld(pool, { sellerId, amount: 100 });
  const snapshot = await ledgerSnapshot(pool);
  assert.equal(await outcome(buy(second)), "insufficient_balance");
  assert.deepEqual(await ledgerSnapshot(pool), snapshot);
  // Avec un crédit payé, il passe en crédits payés seulement.
  await fund(pool, sellerId, 100);
  const third = await buy(second);
  assert.equal(third.purchase.promoAmount, big(0));
  assert.equal(third.balance, big(0));
  await assertWalletGreen(pool, "après un retour aux crédits payés");
});

test("solde insuffisant au total (promotionnel + payé) : 409, ni débit, ni crédits promotionnels dépensés, ni boost, ni achat ; le devis reste utilisable", async () => {
  const sellerId = await proSeller(1000);
  const world = await buyWorld(pool, { sellerId, amount: 7000 });   // 5 000 promo + 1 000 payés < 7 000
  const snapshot = await ledgerSnapshot(pool);
  assert.equal(await outcome(buy(world)), "insufficient_balance");
  assert.deepEqual(await ledgerSnapshot(pool), snapshot, "aucune trace");
  assert.equal((await readPromoSummary(pool, sellerId)).balance, big(5000), "les crédits promotionnels sont intacts");
  assert.equal(await balanceOf(pool, sellerId), big(1000));
  await fund(pool, sellerId, 1000);
  assert.equal((await buy(world)).purchase.amount, big(7000), "le même devis passe après une recharge");
  await assertWalletGreen(pool, "après un refus pour solde insuffisant");
});

test("crédits promotionnels expirés : jamais dépensés (échéance à l'heure de la base) même avant leur expiration écrite ; l'achat se fait en crédits payés ; l'expiration est écrite ensuite", async () => {
  const longAgo = new Date(Date.now() - 40 * 24 * HOUR);
  const { userId: sellerId } = await makePro(pool, 30_000, longAgo);      // payés restants : 20 000 ; promotionnel de 5 000 échu depuis 10 jours
  assert.equal(await promoLedgerBalance(pool, sellerId), big(5000), "le grand livre porte encore les crédits échus");
  assert.equal((await readPromoSummary(pool, sellerId)).balance, big(0), "mais ils ne sont plus dépensables");
  const world = await buyWorld(pool, { sellerId, amount: 2300 });
  const result = await buy(world);
  assert.equal(result.purchase.promoAmount, big(0));
  assert.equal(result.balance, big(20_000 - 2300), "payé en crédits payés");
  assert.equal(await promoLedgerBalance(pool, sellerId), big(5000), "rien n'a été retiré du sous-compte");
  const report = await runWalletCheck(pool);
  assert.deepEqual(report.violations, []);
  // L'abonnement est annulé (pas de renouvellement qui émettrait de nouveaux crédits) : le passage du worker conclut et écrit l'expiration.
  await setSubscriptionAutoRenew({ pool, userId: sellerId, autoRenew: false, now: longAgo });
  const step = await runSubscriptionStep({ pool, userId: sellerId });
  assert.equal(step.promoExpired, 1);
  assert.equal(step.ended, 1);
  assert.equal(await promoLedgerBalance(pool, sellerId), big(0), "l'expiration est écrite");
  await assertWalletGreen(pool, "après l'expiration de crédits jamais dépensés");
});

// ═════════════ 3. Mêmes places, même plafond vendeur ═════════════

test("dernière place disputée par deux vendeurs Pro avec crédits promotionnels → un seul achat, le perdant n'est PAS débité (ni payé, ni promotionnel)", async () => {
  const scope = makeScope();
  const aliceId = await proSeller(0);
  const bobId = await proSeller(0);
  const alice = await makeOffer(pool, aliceId, scope);
  const bob = await makeOffer(pool, bobId, scope);                 // 2 offres → 1 place
  const quotes = [await insertQuote(pool, alice, { amount: 2500 }), await insertQuote(pool, bob, { amount: 2700 })];
  const results = await Promise.all([
    outcome(buy({ sellerId: aliceId, offer: alice, quoteId: quotes[0] }, widePool)),
    outcome(buy({ sellerId: bobId, offer: bob, quoteId: quotes[1] }, widePool)),
  ]);
  assert.deepEqual([...results].sort(), ["no_slot_available", "ok"]);
  assert.equal(await countRows(pool, "offer_boosts", "scope_category = $1 AND status = 'active'", [scope.category]), 1, "pas de survente");
  const spentByWinner = await countRows(pool, "promo_movements", "kind = 'spend' AND purchase_id IN (SELECT id FROM boost_purchases WHERE offer_id IN ($1, $2))", [alice.id, bob.id]);
  assert.equal(spentByWinner, 1);
  const loser = results[0] === "ok" ? bobId : aliceId;
  const winner = results[0] === "ok" ? aliceId : bobId;
  assert.equal((await readPromoSummary(pool, loser)).balance, big(5000), "le perdant garde tous ses crédits promotionnels");
  assert.equal(await promoLedgerBalance(pool, loser), big(5000));
  assert.ok((await readPromoSummary(pool, winner)).balance < big(5000));
  await assertWalletGreen(pool, "après la dernière place disputée");
});

test("plafond vendeur : même avec des crédits promotionnels, le second achat du même vendeur dans le périmètre est refusé (`seller_boost_limit_reached`), sans rien dépenser", async () => {
  const sellerId = await proSeller(0);
  const scope = makeScope();
  await setCategorySettings(scope.category, { slot_ratio: 0.5, min_slots: 8, max_slots: 20, max_active_per_seller: 1, max_seller_slot_share: 1 });
  const first = await makeOffer(pool, sellerId, scope);
  const twin = await makeOffer(pool, sellerId, scope);
  const firstQuote = await insertQuote(pool, first, { amount: 1000 });
  const twinQuote = await insertQuote(pool, twin, { amount: 1000 });
  assert.equal((await buy({ sellerId, offer: first, quoteId: firstQuote })).purchase.promoAmount, big(1000));
  const snapshot = await ledgerSnapshot(pool);
  assert.equal(await outcome(buy({ sellerId, offer: twin, quoteId: twinQuote })), "seller_boost_limit_reached");
  assert.deepEqual(await ledgerSnapshot(pool), snapshot, "aucun crédit promotionnel dépensé par le refus");
  assert.equal((await readPromoSummary(pool, sellerId)).balance, big(4000));
  await assertWalletGreen(pool, "après le plafond vendeur");
});

test("deux achats simultanés du MÊME vendeur (deux annonces) : les crédits promotionnels ne sont jamais dépensés deux fois (3 000 + 3 000 sur 5 000 → 5 000 promotionnels + 1 000 payés)", async () => {
  const sellerId = await proSeller(5000);
  const worlds = [await buyWorld(pool, { sellerId, amount: 3000 }), await buyWorld(pool, { sellerId, amount: 3000 })];
  const results = await Promise.all(worlds.map((world) => buy(world, widePool)));
  const promoSpent = results.reduce((sum, result) => sum + result.purchase.promoAmount, big(0));
  assert.equal(promoSpent, big(5000), "exactement le solde promotionnel, jamais plus");
  assert.equal(await balanceOf(pool, sellerId), big(5000 - 1000));
  assert.equal((await readPromoSummary(pool, sellerId)).balance, big(0));
  assert.equal(await promoLedgerBalance(pool, sellerId), big(0));
  const remaining = await scalar(pool, "SELECT promo_grant_remaining(id)::text AS n FROM promo_grants WHERE user_id = $1", [sellerId]);
  assert.equal(remaining, "0");
  await assertWalletGreen(pool, "après deux achats simultanés");
});

test("rejeu d'une clé d'idempotence : un seul achat, une seule dépense promotionnelle ; 12 clics simultanés → un débit", async () => {
  const sellerId = await proSeller(0);
  const world = await buyWorld(pool, { sellerId, amount: 2000 });
  const key = randomUUID();
  const results = await Promise.all(Array.from({ length: 12 }, () => buy(world, widePool, key)));
  assert.equal(results.filter((result) => !result.reused).length, 1);
  assert.equal(await countRows(pool, "boost_purchases", "seller_id = $1", [sellerId]), 1);
  assert.equal((await readPromoSummary(pool, sellerId)).balance, big(3000), "une seule dépense de 2 000");
  assert.equal(await countRows(pool, "promo_movements", "kind = 'spend' AND grant_id IN (SELECT id FROM promo_grants WHERE user_id = $1)", [sellerId]), 1);
  await assertWalletGreen(pool, "après le double clic d'un achat");
});

// ═════════════ 4. Remboursement d'un achat payé en crédits promotionnels ═════════════

test("remboursement : la part promotionnelle retourne au sous-compte (émission encore valable), la part payée aux crédits ; intégral, une seule fois", async () => {
  const sellerId = await proSeller(5000);
  const world = await buyWorld(pool, { sellerId, amount: 7000 });   // 5 000 promo + 2 000 payés
  const purchase = (await buy(world)).purchase;
  const refund = await refundBoostPurchase({ pool, purchaseId: purchase.id, reasonCode: "incident" });
  assert.equal(refund.refundedAmount, big(7000));
  assert.equal(refund.promoAmount, big(5000));
  assert.equal(refund.promoRestoredAmount, big(5000));
  assert.equal(refund.balance, big(5000), "crédits payés rendus");
  assert.equal((await readPromoSummary(pool, sellerId)).balance, big(5000), "crédits promotionnels rendus à leur émission");
  assert.equal(await promoLedgerBalance(pool, sellerId), big(5000));
  assert.equal(await scalar(pool, "SELECT count(*)::int AS n FROM promo_movements WHERE purchase_id = $1 AND kind = 'restore'", [purchase.id]), 1);
  assert.equal(await outcome(refundBoostPurchase({ pool, purchaseId: purchase.id, reasonCode: "encore" })), "already_refunded");
  assert.equal((await readPromoSummary(pool, sellerId)).balance, big(5000), "pas de second crédit");
  await assertWalletGreen(pool, "après le remboursement d'un achat à cheval");
});

test("remboursement d'un achat 100 % promotionnel : seuls les crédits promotionnels reviennent (aucun crédit payé créé) ; si l'émission a expiré entre-temps, la part est PERDUE (écrite promo_expired), jamais rendue en crédits", async () => {
  // a) émission valable : restitution.
  const kept = await proSeller(0);
  const keptWorld = await buyWorld(pool, { sellerId: kept, amount: 2300 });
  const keptPurchase = (await buy(keptWorld)).purchase;
  const refunded = await refundBoostPurchase({ pool, purchaseId: keptPurchase.id, reasonCode: "incident" });
  assert.equal(refunded.promoRestoredAmount, big(2300));
  assert.equal(refunded.balance, big(0), "aucun crédit payé n'apparaît");
  assert.equal((await readPromoSummary(pool, kept)).balance, big(5000));
  // b) émission expirée avant le remboursement : perte écrite.
  const lost = await proSeller(0);
  const lostWorld = await buyWorld(pool, { sellerId: lost, amount: 2300 });
  const lostPurchase = (await buy(lostWorld)).purchase;
  const { end } = await periodOf(pool, lost);
  await runSubscriptionStep({ pool, userId: lost, now: addMs(end, MINUTE) });      // renouvelé ? non : 0 payé ; la grâce démarre, l'émission expire quand même
  assert.equal(await promoLedgerBalance(pool, lost), big(0), "le reste (2 700) a expiré");
  const expiredBefore = await systemBalance(pool, "promo_expired");
  const result = await refundBoostPurchase({ pool, purchaseId: lostPurchase.id, reasonCode: "incident" });
  assert.equal(result.promoAmount, big(2300));
  assert.equal(result.promoRestoredAmount, big(0), "rien n'est rendu : l'émission est close");
  assert.equal(await balanceOf(pool, lost), big(0), "jamais rendue en crédits payés");
  assert.equal(await promoLedgerBalance(pool, lost), big(0));
  assert.equal(await systemBalance(pool, "promo_expired") - expiredBefore, big(2300), "la perte est ÉCRITE (promo_expired)");
  assert.equal(await scalar(pool, "SELECT count(*)::int AS n FROM promo_movements WHERE purchase_id = $1 AND kind = 'lapse'", [lostPurchase.id]), 1);
  await assertWalletGreen(pool, "après des remboursements promotionnels");
});

// ═════════════ 5. Gardes de la base ═════════════

test("la base refuse un dépassement promotionnel, la dépense d'une émission close, une dépense non couverte au COMMIT, la modification ou la suppression d'un mouvement", async () => {
  // Un vendeur qui achète un boost AVANT son abonnement (achat payé en crédits, aucun mouvement promotionnel), puis s'abonne : il a une émission et un achat sans dépense.
  const sellerId = await makeUser(pool);
  await fund(pool, sellerId, 20_000);
  const world = await buyWorld(pool, { sellerId, amount: 2000 });
  const purchase = (await buy(world)).purchase;
  assert.equal(purchase.promoAmount, big(0));
  await subscribePro(pool, sellerId);
  const grant = (await pool.query<{ id: string }>("SELECT id FROM promo_grants WHERE user_id = $1", [sellerId])).rows[0].id;
  const insertSpend = (amount: number) => (client: PoolClient) => client.query(
    `INSERT INTO promo_movements (id, grant_id, kind, amount_xof, purchase_id, transaction_id) VALUES (gen_random_uuid(), $1, 'spend', $2::bigint, $3, $4)`,
    [grant, amount, purchase.id, purchase.transactionId]);
  // Dépassement : plus que le reste de l'émission (5 000).
  assert.deepEqual(await failureOf(insertSpend(5001)), { code: "23514", constraint: "trg_promo_movements_guard" });
  // Une dépense dans la limite passe la garde immédiate mais n'est pas couverte par la part promotionnelle (0) de l'achat : refusée au COMMIT.
  assert.equal(await failureOf(insertSpend(100)), null, "la garde immédiate l'accepte (annulée ici)");
  assert.deepEqual(await failureOf(insertSpend(100), true), { code: "23514", constraint: "trg_boost_purchases_promo_movements" });
  assert.equal(await countRows(pool, "promo_movements", "purchase_id = $1", [purchase.id]), 0, "rien n'a été écrit");
  // Émission close (expirée) : plus de dépense possible.
  const { end } = await periodOf(pool, sellerId);
  await runSubscriptionStep({ pool, userId: sellerId, now: addMs(end, MINUTE) });
  assert.deepEqual(await failureOf(insertSpend(100)), { code: "23514", constraint: "trg_promo_movements_guard" });
  // Un mouvement existant ne se modifie pas et ne se supprime pas : on en crée un vrai par un achat promotionnel d'un autre vendeur.
  const other = await proSeller(0);
  const otherPurchase = (await buy(await buyWorld(pool, { sellerId: other, amount: 1000 }))).purchase;
  assert.equal((await failureOf((client) => client.query("UPDATE promo_movements SET amount_xof = 1 WHERE purchase_id = $1", [otherPurchase.id])))?.code, "23001");
  assert.equal((await failureOf((client) => client.query("DELETE FROM promo_movements WHERE purchase_id = $1", [otherPurchase.id])))?.code, "23001");
  // Une seconde dépense de la même émission pour le même achat viole l'unicité.
  const otherGrant = (await pool.query<{ id: string }>("SELECT id FROM promo_grants WHERE user_id = $1", [other])).rows[0].id;
  const duplicate = await failureOf((client) => client.query(
    `INSERT INTO promo_movements (id, grant_id, kind, amount_xof, purchase_id, transaction_id) VALUES (gen_random_uuid(), $1, 'spend', 1, $2, $3)`,
    [otherGrant, otherPurchase.id, otherPurchase.transactionId]));
  assert.equal(duplicate?.constraint, "uq_promo_movements_grant_purchase_kind");
  await assertWalletGreen(pool, "le schéma propre est resté sain");
});

test("écritures d'un achat : la fonction de garde de la base n'accepte que les écritures EXACTES de la part payée et de la part promotionnelle ; un achat enregistré ne change plus de part", async () => {
  const sellerId = await proSeller(5000);
  const split = (await buy(await buyWorld(pool, { sellerId, amount: 7000 }))).purchase;            // 5 000 promotionnels + 2 000 payés
  const matches = async (purchase: { id: string; transactionId: string }, paid: number, promo: number, kind = "boost_purchase", seller = sellerId): Promise<boolean> =>
    Boolean(await scalar(pool, "SELECT boost_purchase_ledger_matches_v2($1, $2, $3, $4, $5::bigint, $6::bigint) AS n", [purchase.transactionId, kind, purchase.id, seller, paid, promo]));
  assert.equal(await matches(split, 2000, 5000), true);
  assert.equal(await matches(split, 7000, 0), false, "tout en crédits payés : faux");
  assert.equal(await matches(split, 0, 7000), false, "tout en promotionnel : faux");
  assert.equal(await matches(split, 2500, 4500), false, "autre répartition : faux");
  assert.equal(await matches(split, 2000, 4999), false);
  assert.equal(await matches(split, 2000, 5000, "boost_refund"), false, "le type de transaction compte");
  assert.equal(await matches(split, 2000, 5000, "boost_purchase", randomUUID()), false, "le vendeur compte");
  // Un achat enregistré ne change jamais de part promotionnelle.
  assert.equal((await failureOf((client) => client.query("UPDATE boost_purchases SET promo_xof = 0 WHERE id = $1", [split.id])))?.code, "23001");
  assert.equal((await failureOf((client) => client.query("UPDATE boost_purchases SET amount_xof = amount_xof + 1 WHERE id = $1", [split.id])))?.code, "23001");
  await assertWalletGreen(pool, "après les contrôles de la garde");
});

test("wallet:check détecte les corruptions promotionnelles d'un achat : part promotionnelle sans mouvement, dépense après l'expiration, écritures de l'achat falsifiées, soldes des comptes système", async () => {
  const sellerId = await proSeller(5000);
  const world = await buyWorld(pool, { sellerId, amount: 3000 });
  const purchase = (await buy(world)).purchase;
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
  const dropTriggers = async (client: PoolClient) => {
    await client.query("ALTER TABLE promo_movements DISABLE TRIGGER USER");
  };
  // Mouvement de dépense effacé : la part promotionnelle n'est plus couverte.
  const withoutMovement = await codesIn(async (client) => {
    await dropTriggers(client);
    await client.query("DELETE FROM promo_movements WHERE purchase_id = $1", [purchase.id]);
  });
  assert.ok(withoutMovement.includes("promo_purchase_mismatch"), withoutMovement.join(","));
  assert.ok(withoutMovement.includes("promo_consumed_mismatch"));
  // Dépense après l'expiration de l'émission.
  assert.ok((await codesIn(async (client) => {
    await dropTriggers(client);
    await client.query("UPDATE promo_movements SET created_at = (SELECT expires_at FROM promo_grants WHERE id = promo_movements.grant_id) + interval '1 hour' WHERE purchase_id = $1", [purchase.id]);
  })).includes("promo_spent_after_expiry"));
  // Mouvement rattaché à une autre transaction.
  assert.ok((await codesIn(async (client) => {
    await dropTriggers(client);
    await client.query("UPDATE promo_movements SET transaction_id = (SELECT id FROM wallet_transactions WHERE kind = 'subscription_charge' LIMIT 1) WHERE purchase_id = $1", [purchase.id]);
  })).includes("promo_movement_mismatch"));
  // Écriture promotionnelle de l'achat falsifiée (montant) : le grand livre ne correspond plus à la part promotionnelle.
  const altered = await codesIn(async (client) => {
    await client.query("ALTER TABLE wallet_entries DISABLE TRIGGER trg_wallet_entries_immutable");
    await client.query(
      "UPDATE wallet_entries SET amount = amount + 1 WHERE transaction_id = $1 AND amount = 3000", [purchase.transactionId]);
  });
  assert.ok(altered.includes("boost_purchase_mismatch"), altered.join(","));
  // Soldes des comptes système falsifiés.
  for (const [kind, code] of [["promo_consumed", "promo_consumed_mismatch"], ["promo_expired", "promo_expired_mismatch"], ["promo_issuance", "promo_issuance_mismatch"]] as const) {
    assert.ok((await codesIn(async (client) => {
      await client.query("ALTER TABLE wallet_accounts DISABLE TRIGGER trg_wallet_accounts_guard");
      await client.query("UPDATE wallet_accounts SET balance = balance + 1 WHERE kind = $1", [kind]);
    })).includes(code), code);
  }
  // Part promotionnelle d'un achat remboursé non couverte par des restitutions : promo_purchase_mismatch.
  await refundBoostPurchase({ pool, purchaseId: purchase.id, reasonCode: "controle" });
  assert.ok((await codesIn(async (client) => {
    await dropTriggers(client);
    await client.query("DELETE FROM promo_movements WHERE purchase_id = $1 AND kind <> 'spend'", [purchase.id]);
  })).includes("promo_purchase_mismatch"));
  await assertWalletGreen(pool, "après les corruptions annulées");
});

test("l'achat de boost sans crédits promotionnels est inchangé : deux écritures, aucune émission, aucun mouvement ; wallet:check sans écart ni avertissement promotionnel", async () => {
  const sellerId = await makeUser(pool);
  await fund(pool, sellerId, 10_000);
  const world = await buyWorld(pool, { sellerId, amount: 2300 });
  const result = await buy(world);
  assert.equal(result.purchase.promoAmount, big(0));
  assert.equal(result.balance, big(7700));
  assert.equal(await countRows(pool, "promo_movements", "purchase_id = $1", [result.purchase.id]), 0);
  assert.equal(await scalar(pool, "SELECT count(*)::int AS n FROM wallet_entries WHERE transaction_id = $1", [result.purchase.transactionId]), 2);
  const refund = await refundBoostPurchase({ pool, purchaseId: result.purchase.id, reasonCode: "controle" });
  assert.equal(refund.promoAmount, big(0));
  assert.equal(refund.balance, big(10_000));
  await assertWalletGreen(pool, "achat et remboursement sans promotionnel");
});
