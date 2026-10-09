import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { grantAdmin } from "../../lib/server/admin/grant";
import { activateDemand, archiveDemand, createDemand, satisfyDemand } from "../../lib/server/catalog";
import { runCollectStep } from "../../lib/server/external/collect";
import { createFakeConnectors } from "../../lib/server/external/fake-connectors";
import { createActiveSearchHttpHandlers, type ActiveSearchHttpHandlers } from "../../lib/server/active-search/http";
import { createAdminActiveSearchHttpHandlers, type AdminActiveSearchHttpHandlers } from "../../lib/server/active-search/admin-http";
import { readAdminActiveSearchOverview } from "../../lib/server/active-search/admin";
import { acceleratedCapacity } from "../../lib/server/active-search/availability";
import { purchaseActiveSearch } from "../../lib/server/active-search/purchase";
import { runActiveSearchStep } from "../../lib/server/active-search/step";
import { createHomeHttpHandlers, type HomeHttpHandlers } from "../../lib/server/home/http";
import { createNotificationsHttpHandlers, type NotificationsHttpHandlers } from "../../lib/server/notifications/http";
import { checkWalletIntegrity } from "../../lib/server/wallet/check";
import * as demandRoute from "../../app/api/demands/[id]/active-search/route";
import * as adminRoute from "../../app/api/admin/active-search/route";
import { FAKE_ENV, TEST_PSEUDONYM_KEY } from "./external-fixtures";
import { ACTIVE_SEARCH_PRICE_XOF } from "../../lib/server/active-search/config";
import { refundActiveSearchPurchase } from "../../lib/server/active-search/refund";
import { balanceOf, fund, promoLedgerBalance, subscribePro } from "./pro-fixtures";
import { NOT_FOUND, ORIGIN, count, login, openTestSchema, reply, request, type Login, type Reply, type TestSchema } from "./social-fixtures";

/**
 * Routes HTTP de la recherche active (lot RA1) : session, origine AVANT la session, JSON strict, 404 INDISCERNABLE pour un besoin d'autrui ou inconnu, DTO en liste blanche, achat
 * idempotent, crédits payés seulement, administration (404 pour tout non-administrateur, nombres arrondis à 5, revenus nets lus dans le grand livre), notifications et accueil des
 * nouveaux genres. Argent SIMULÉ.
 */

let env: TestSchema;
let search: ActiveSearchHttpHandlers;
let admin: AdminActiveSearchHttpHandlers;
let notifications: NotificationsHttpHandlers;
let home: HomeHttpHandlers;
let boss: Login;
const logs: string[] = [];

before(async () => {
  env = await openTestSchema(12);
  const common = { pool: env.pool, env: { NOMA_AUTH_ORIGIN: ORIGIN, ...FAKE_ENV }, log: (code: string) => { logs.push(code); } };
  search = createActiveSearchHttpHandlers(common);
  admin = createAdminActiveSearchHttpHandlers(common);
  notifications = createNotificationsHttpHandlers({ ...common, transportAvailable: () => false });
  home = createHomeHttpHandlers(common);
  boss = await login(env.pool);
  assert.equal((await grantAdmin({ pool: env.pool, phone: boss.phone })).granted, true);
});

after(async () => {
  await env.close();
});

type Json = Record<string, unknown>;
const obj = (value: unknown): Json => value as Json;
const errorOf = (answer: Reply): { code: string; message: string } => obj(answer.json).error as { code: string; message: string };

const state = (cookie: string | null, demandId: string, query = "") => search.get(request("GET", `/api/demands/${demandId}/active-search`, { cookie, query }), demandId).then(reply);
const purchase = (cookie: string | null, demandId: string, body: unknown, origin?: string | null) =>
  search.purchase(request("POST", `/api/demands/${demandId}/active-search`, { cookie, body, origin }), demandId).then(reply);
const overview = (cookie: string | null) => admin.overview(request("GET", "/api/admin/active-search", { cookie })).then(reply);

async function buyerWithDemand(credit = 0): Promise<{ buyer: Login; demandId: string }> {
  const buyer = await login(env.pool);
  if (credit > 0) await fund(env.pool, buyer.userId, credit);
  const demand = await createDemand({ ownerId: buyer.userId, rawText: "Je cherche un iPhone 12", category: "Téléphones", brand: "Apple", model: "iPhone 12", location: "Abidjan", budget: { amount: 200_000, currency: "XOF" }, status: "active" }, env.pool);
  return { buyer, demandId: demand.id };
}

const body = () => ({ idempotencyKey: randomUUID(), expectedPriceXof: ACTIVE_SEARCH_PRICE_XOF });

// ═════════════ 1. État et achat ═════════════

test("GET /api/demands/{id}/active-search : session obligatoire, UUID valide, aucun paramètre ; l'état d'un besoin sans option (prix PROVISOIRE, crédits payés, aucun renouvellement) ; DTO en liste blanche", async () => {
  const { buyer, demandId } = await buyerWithDemand(5_000);
  assert.equal((await state(null, demandId)).status, 401);
  assert.equal((await state(buyer.cookie, "pas-un-uuid")).status, 400);
  assert.equal((await state(buyer.cookie, demandId, "?x=1")).status, 400);
  const answer = await state(buyer.cookie, demandId);
  assert.equal(answer.status, 200);
  const dto = obj(answer.json);
  assert.deepEqual(Object.keys(dto).sort(), [
    "active", "autoRenew", "balanceXof", "blockedReason", "canPurchase", "contractVersion", "demandId", "demandStatus", "durationDays", "endsAt", "expiringSoon", "maxEndsAt", "nextEndsAt",
    "paidCreditsOnly", "priceProvisional", "priceXof", "purchasedPeriods", "readAt", "remainingDays", "startsAt", "suspended",
  ]);
  assert.deepEqual([dto.contractVersion, dto.priceProvisional, dto.paidCreditsOnly, dto.autoRenew], ["active-search/v1", true, true, false]);
  assert.deepEqual([dto.priceXof, dto.durationDays, dto.balanceXof, dto.active, dto.canPurchase, dto.blockedReason, dto.endsAt, dto.purchasedPeriods], [2_000, 30, 5_000, false, true, null, null, 0]);
  assert.equal(answer.text.includes(buyer.userId), false, "jamais l'identifiant de l'utilisateur");
});

test("accès d'autrui : le besoin d'un AUTRE et un besoin inconnu donnent la MÊME réponse 404 (statut, corps, en-têtes), en lecture comme en achat ; rien n'est écrit", async () => {
  const owner = await buyerWithDemand(5_000);
  const stranger = await buyerWithDemand(5_000);
  const unknownId = randomUUID();
  // Le besoin du propriétaire a DÉJÀ une option en vigueur : un autre acheteur ne peut pas non plus la prolonger (404 identique, aucun débit).
  assert.equal((await purchase(owner.buyer.cookie, owner.demandId, body())).status, 201);
  const before = await count(env.pool, "wallet_transactions");
  const foreignGet = await state(stranger.buyer.cookie, owner.demandId);
  const unknownGet = await state(stranger.buyer.cookie, unknownId);
  assert.deepEqual([foreignGet.status, foreignGet.json], [404, NOT_FOUND]);
  assert.deepEqual([unknownGet.status, unknownGet.json], [404, NOT_FOUND]);
  assert.equal(foreignGet.text, unknownGet.text, "corps identique à l'octet près");
  const foreignBuy = await purchase(stranger.buyer.cookie, owner.demandId, body());
  const unknownBuy = await purchase(stranger.buyer.cookie, unknownId, body());
  assert.deepEqual([foreignBuy.status, foreignBuy.json], [404, NOT_FOUND]);
  assert.equal(foreignBuy.text, unknownBuy.text);
  assert.equal(await count(env.pool, "wallet_transactions"), before, "aucun débit");
  assert.equal(await count(env.pool, "active_search_purchases", `demand_id = '${owner.demandId}'`), 1, "la chaîne du propriétaire n'a pas été prolongée par un autre");
  assert.equal(await balanceOf(env.pool, stranger.buyer.userId), BigInt(5_000), "l'étranger n'est pas débité");
});

test("POST : origine AVANT la session, JSON strict (clé exacte, UUID), solde insuffisant 409 sans rien écrire, succès 201, rejeu 200, autre besoin avec la même clé 409", async () => {
  const { buyer, demandId } = await buyerWithDemand();
  const valid = body();
  assert.equal((await purchase(buyer.cookie, demandId, valid, null)).status, 403, "origine absente");
  assert.equal((await purchase(buyer.cookie, demandId, valid, "https://evil.test")).status, 403, "origine étrangère");
  assert.equal((await purchase(null, demandId, valid, "https://evil.test")).status, 403, "l'origine est vérifiée avant la session");
  assert.equal((await purchase(null, demandId, valid)).status, 401);
  for (const bad of [
    {}, { ...valid, extra: 1 }, { ...valid, idempotencyKey: 5 }, { ...valid, idempotencyKey: "pas-un-uuid" }, [valid], "texte", { ...valid, demandId },
    // A6 : le prix AFFICHÉ est obligatoire, entier, positif.
    { idempotencyKey: valid.idempotencyKey }, { ...valid, expectedPriceXof: "2000" }, { ...valid, expectedPriceXof: 2_000.5 }, { ...valid, expectedPriceXof: 0 }, { ...valid, expectedPriceXof: -2_000 },
    { ...valid, expectedPriceXof: null }, { ...valid, expectedPriceXof: true }, { ...valid, expectedPriceXof: Number.MAX_SAFE_INTEGER + 2 },
  ]) {
    assert.equal((await purchase(buyer.cookie, demandId, bad)).status, 400, JSON.stringify(bad));
  }
  const doubleKey = await search.purchase(new Request(`${ORIGIN}/api/demands/${demandId}/active-search`, {
    method: "POST", headers: { cookie: buyer.cookie, origin: ORIGIN, "content-type": "application/json" }, body: `{"idempotencyKey":"${valid.idempotencyKey}","idempotencyKey":"${randomUUID()}","expectedPriceXof":2000}`,
  }), demandId).then(reply);
  assert.equal(doubleKey.status, 400, "clé en double refusée par le lecteur strict");
  const before = await count(env.pool, "wallet_transactions");
  const poor = await purchase(buyer.cookie, demandId, valid);
  assert.equal(poor.status, 409);
  assert.deepEqual(errorOf(poor), { code: "insufficient_balance", message: "Solde insuffisant : rechargez votre porte-monnaie." });
  assert.equal(await count(env.pool, "wallet_transactions"), before);
  assert.equal(await count(env.pool, "active_search_purchases", `demand_id = '${demandId}'`), 0);

  await fund(env.pool, buyer.userId, 5_000);
  const created = await purchase(buyer.cookie, demandId, valid);
  assert.equal(created.status, 201);
  const dto = obj(created.json);
  assert.deepEqual(Object.keys(dto).sort(), [
    "active", "autoRenew", "balanceXof", "blockedReason", "canPurchase", "contractVersion", "demandId", "demandStatus", "durationDays", "endsAt", "expiringSoon", "maxEndsAt", "nextEndsAt",
    "paidCreditsOnly", "priceProvisional", "priceXof", "purchase", "purchasedPeriods", "readAt", "remainingDays", "startsAt", "suspended",
  ]);
  assert.deepEqual(Object.keys(obj(dto.purchase)).sort(), ["endsAt", "kind", "priceXof", "reused", "startsAt"], "ni identifiant d'achat ni de transaction");
  assert.deepEqual([obj(dto.purchase).kind, obj(dto.purchase).reused, obj(dto.purchase).priceXof, dto.active, dto.balanceXof, dto.remainingDays, dto.purchasedPeriods], ["activation", false, 2_000, true, 3_000, 30, 1]);
  assert.equal(created.text.includes(buyer.userId), false);
  // Rejeu de la même clé : 200 `reused`, aucun second débit.
  const replay = await purchase(buyer.cookie, demandId, valid);
  assert.equal(replay.status, 200);
  assert.equal(obj(obj(replay.json).purchase).reused, true);
  assert.equal(obj(replay.json).balanceXof, 3_000);
  assert.equal(await count(env.pool, "active_search_purchases", `demand_id = '${demandId}'`), 1);
  // La même clé pour un AUTRE besoin : 409 sans effet.
  const other = await createDemand({ ownerId: buyer.userId, rawText: "Un autre besoin", category: "Téléphones", brand: "Apple", model: "iPhone 12", status: "active" }, env.pool);
  const conflict = await purchase(buyer.cookie, other.id, valid);
  assert.equal(conflict.status, 409);
  assert.equal(errorOf(conflict).code, "idempotency_conflict");
  assert.equal(await count(env.pool, "active_search_purchases", `demand_id = '${other.id}'`), 0);
  // Prolongation : une extension, contiguë.
  const extended = await purchase(buyer.cookie, demandId, body());
  assert.equal(extended.status, 201);
  assert.equal(obj(obj(extended.json).purchase).kind, "extension");
  assert.equal(obj(extended.json).remainingDays, 60);
  assert.equal(obj(extended.json).balanceXof, 1_000);
  assert.deepEqual((await checkWalletIntegrity(env.pool)).violations, []);
});

test("horizon de 180 jours : la 7e période est refusée (409 max_horizon, texte fixe) sans rien écrire ; un besoin satisfait ou archivé : 409 demand_not_active", async () => {
  const { buyer, demandId } = await buyerWithDemand(30_000);
  for (let index = 0; index < 6; index += 1) assert.equal((await purchase(buyer.cookie, demandId, body())).status, 201, `période ${index + 1}`);
  const before = await count(env.pool, "wallet_transactions");
  const seventh = await purchase(buyer.cookie, demandId, body());
  assert.equal(seventh.status, 409);
  assert.deepEqual(errorOf(seventh), { code: "max_horizon", message: "La recherche active ne peut pas dépasser 180 jours à partir d'aujourd'hui." });
  assert.equal(await count(env.pool, "wallet_transactions"), before);
  const blocked = obj((await state(buyer.cookie, demandId)).json);
  assert.deepEqual([blocked.canPurchase, blocked.blockedReason, blocked.nextEndsAt, (blocked.remainingDays as number) >= 179 && (blocked.remainingDays as number) <= 180], [false, "max_horizon", null, true]);

  const satisfied = await createDemand({ ownerId: buyer.userId, rawText: "iPhone 12", category: "Téléphones", brand: "Apple", model: "iPhone 12", status: "active" }, env.pool);
  await satisfyDemand(buyer.userId, satisfied.id, satisfied.contentVersion, env.pool);
  const archived = await createDemand({ ownerId: buyer.userId, rawText: "iPhone 12", category: "Téléphones", brand: "Apple", model: "iPhone 12", status: "active" }, env.pool);
  await archiveDemand(buyer.userId, archived.id, archived.contentVersion, env.pool);
  for (const id of [satisfied.id, archived.id]) {
    const refused = await purchase(buyer.cookie, id, body());
    assert.equal(refused.status, 409, id);
    assert.deepEqual(errorOf(refused), { code: "demand_not_active", message: "La recherche active n'est disponible que pour un besoin actif." });
    const read = obj((await state(buyer.cookie, id)).json);
    assert.deepEqual([read.canPurchase, read.blockedReason], [false, "demand_not_active"]);
  }
});

test("crédits PROMOTIONNELS : 5 000 FCFA de crédits promotionnels ne paient jamais l'option (409 insufficient_balance par HTTP) ; avec 2 000 FCFA payés, seuls les crédits payés sont débités", async () => {
  const buyer = await login(env.pool);
  await fund(env.pool, buyer.userId, 10_000);
  await subscribePro(env.pool, buyer.userId);
  assert.equal(await promoLedgerBalance(env.pool, buyer.userId), BigInt(5_000), "l'abonné Pro a des crédits promotionnels");
  const demand = await createDemand({ ownerId: buyer.userId, rawText: "iPhone 12", category: "Téléphones", brand: "Apple", model: "iPhone 12", status: "active" }, env.pool);
  const read = obj((await state(buyer.cookie, demand.id)).json);
  assert.equal(read.balanceXof, 0, "le solde annoncé ne compte QUE les crédits payés");
  const before = await count(env.pool, "wallet_transactions");
  const refused = await purchase(buyer.cookie, demand.id, body());
  assert.equal(refused.status, 409);
  assert.equal(errorOf(refused).code, "insufficient_balance");
  assert.equal(await count(env.pool, "wallet_transactions"), before);
  assert.equal(await promoLedgerBalance(env.pool, buyer.userId), BigInt(5_000), "crédits promotionnels intacts");
  await fund(env.pool, buyer.userId, 2_000);
  const paid = await purchase(buyer.cookie, demand.id, body());
  assert.equal(paid.status, 201);
  assert.equal(obj(paid.json).balanceXof, 0);
  assert.equal(await promoLedgerBalance(env.pool, buyer.userId), BigInt(5_000), "toujours intacts après l'achat");
  assert.equal(await count(env.pool, "wallet_entries e JOIN wallet_accounts a ON a.id = e.account_id JOIN wallet_transactions t ON t.id = e.transaction_id", `t.kind = 'search_purchase' AND a.kind NOT IN ('user', 'active_search_revenue')`), 0);
  assert.deepEqual((await checkWalletIntegrity(env.pool)).violations, []);
});

// ═════════════ 2. Administration ═════════════

test("administration : le MÊME 404 pour un visiteur, un compte ordinaire ou un administrateur suspendu ; paramètre inattendu refusé ; aucun remboursement ni écriture par HTTP", async () => {
  const user = await login(env.pool);
  for (const cookie of [null, user.cookie]) {
    const answer = await overview(cookie);
    assert.deepEqual([answer.status, answer.json], [404, NOT_FOUND]);
  }
  const post = await admin.overview(request("POST", "/api/admin/active-search", { cookie: boss.cookie, body: {} })).then(reply);
  assert.equal(post.status === 200 || post.status === 404 || post.status === 405 || post.status === 400, true);
  const suspended = await login(env.pool);
  await grantAdmin({ pool: env.pool, phone: suspended.phone });
  assert.equal((await overview(suspended.cookie)).status, 200);
  await env.pool.query("UPDATE users SET status = 'suspended' WHERE id = $1", [suspended.userId]);
  assert.deepEqual([(await overview(suspended.cookie)).status, (await overview(suspended.cookie)).json], [404, NOT_FOUND]);
  await env.pool.query("UPDATE users SET status = 'active' WHERE id = $1", [suspended.userId]);
  const withQuery = await admin.overview(request("GET", "/api/admin/active-search", { cookie: boss.cookie, query: "?x=1" })).then(reply);
  assert.equal(withQuery.status, 400);
  assert.deepEqual(Object.keys(demandRoute).sort(), ["GET", "POST", "dynamic", "runtime"]);
  assert.deepEqual(Object.keys(adminRoute).sort(), ["GET", "dynamic", "runtime"], "la route d'administration ne fait que lire");
});

test("administration : options en vigueur ARRONDIES à 5 près (jamais un compte exact), revenus du mois NETS des remboursements lus dans le grand livre", async () => {
  const before = obj((await overview(boss.cookie)).json);
  assert.equal(before.contractVersion, "active-search/v1");
  assert.equal(before.priceProvisional, true);
  // 7 acheteurs achètent : 7 options en vigueur → arrondi à 5 ; un remboursement : revenu net.
  const baseRevenue = before.revenueXof as number;
  const baseActive = before.activeApproximate as number;
  const purchases: string[] = [];
  for (let index = 0; index < 7; index += 1) {
    const { buyer, demandId } = await buyerWithDemand(2_000);
    const answer = await purchase(buyer.cookie, demandId, body());
    assert.equal(answer.status, 201);
    purchases.push(demandId);
  }
  // Le nombre EXACT d'options en vigueur ne doit pas être un multiple de 5 (sinon l'arrondi ne se verrait pas) : on achète au besoin quelques options de plus.
  const liveCount = async (): Promise<number> => (await env.pool.query<{ n: number }>(
    `SELECT count(DISTINCT p.demand_id)::int AS n FROM active_search_purchases p JOIN demands d ON d.id = p.demand_id
      WHERE p.status = 'active' AND p.refunded_at IS NULL AND p.starts_at <= clock_timestamp() AND p.ends_at > clock_timestamp() AND d.status = 'active' AND d.archived_at IS NULL`)).rows[0].n;
  let extra = 0;
  while ((await liveCount()) % 5 === 0) {
    const { buyer, demandId } = await buyerWithDemand(2_000);
    assert.equal((await purchase(buyer.cookie, demandId, body())).status, 201);
    purchases.push(demandId);
    extra += 1;
  }
  const exactCount = await liveCount();
  assert.notEqual(exactCount % 5, 0, "le compte exact n'est pas un multiple de 5");
  const after = await overview(boss.cookie);
  const dto = obj(after.json);
  assert.deepEqual(Object.keys(dto).sort(), ["activeApproximate", "contractVersion", "month", "priceProvisional", "readAt", "revenueXof"]);
  assert.equal((dto.activeApproximate as number) % 5, 0, "arrondi à 5 près");
  assert.notEqual(dto.activeApproximate, exactCount, "jamais le compte exact");
  assert.ok(Math.abs((dto.activeApproximate as number) - exactCount) <= 2, "le multiple de 5 le plus proche");
  const exact = (await readAdminActiveSearchOverview({ pool: env.pool })).activeApproximate;
  assert.equal(dto.activeApproximate, exact);
  assert.equal(exact >= baseActive, true);
  assert.equal((dto.revenueXof as number) - baseRevenue, 14_000 + 2_000 * extra, "7 achats de 2 000 FCFA (et les éventuels achats de plus), lus dans le grand livre (compte de revenus)");
  // Les chiffres exacts n'apparaissent nulle part dans la réponse.
  assert.equal(/"(?:count|total|exact|options)"/.test(after.text), false);
  const month = obj(dto.month);
  assert.ok(Date.parse(month.startsAt as string) <= Date.now() && Date.now() < Date.parse(month.endsAt as string));
  // Frontière du mois : les écritures d'un achat de l'AVANT-DERNIER mois ne comptent pas dans les revenus du mois (lues dans le grand livre par la date de l'écriture).
  const shiftEntries = async (demandId: string, interval: string): Promise<void> => {
    const client = await env.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("ALTER TABLE wallet_entries DISABLE TRIGGER trg_wallet_entries_immutable");
      await client.query(
        `UPDATE wallet_entries SET created_at = created_at ${interval}
          WHERE transaction_id = (SELECT transaction_id FROM active_search_purchases WHERE demand_id = $1)`, [demandId]);
      await client.query("ALTER TABLE wallet_entries ENABLE TRIGGER trg_wallet_entries_immutable");
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  };
  await shiftEntries(purchases[6], "- interval '70 days'");
  assert.equal((obj((await overview(boss.cookie)).json).revenueXof as number) - baseRevenue, 12_000 + 2_000 * extra, "un achat daté d'il y a 70 jours n'est pas un revenu de ce mois");
  await shiftEntries(purchases[6], "+ interval '70 days'");
  assert.equal((obj((await overview(boss.cookie)).json).revenueXof as number) - baseRevenue, 14_000 + 2_000 * extra, "remis à sa date, il compte de nouveau");
  // Un remboursement intégral fait baisser le revenu NET.
  const refundedPurchase = (await env.pool.query<{ id: string }>("SELECT id FROM active_search_purchases WHERE demand_id = $1", [purchases[0]])).rows[0].id;
  await refundActiveSearchPurchase({ pool: env.pool, purchaseId: refundedPurchase, reasonCode: "essai" });
  const net = obj((await overview(boss.cookie)).json);
  assert.equal((net.revenueXof as number) - baseRevenue, 12_000 + 2_000 * extra, "revenu net : achats − 2 000 remboursés");
  assert.deepEqual((await checkWalletIntegrity(env.pool)).violations, []);
});

// ═════════════ 3. Notifications et accueil ═════════════

test("notifications et accueil : une annonce d'un autre site et l'avis d'échéance passent par les routes /api/notifications et /api/home/buyer en liste blanche (titre, prix, source ou fin, lien du besoin), jamais l'adresse externe", async () => {
  const { buyer, demandId } = await buyerWithDemand(5_000);
  const connectors = createFakeConnectors();
  const now = new Date();
  const collect = (at: Date) => runCollectStep({ pool: env.pool, connectors, now: () => at, sleep: async () => undefined, pseudonymKey: TEST_PSEUDONYM_KEY });
  await collect(new Date(now.getTime() + 60_000));
  const bought = await purchaseActiveSearch({ expectedPriceXof: ACTIVE_SEARCH_PRICE_XOF, env: FAKE_ENV, pool: env.pool, userId: buyer.userId, demandId, idempotencyKey: randomUUID(), now: new Date(now.getTime() + 120_000) });
  connectors[0].controls.extra = [{
    externalId: "demo_a-http-1", title: "iPhone 12 128 Go violet scellé", price: 139_000, currency: "XOF", url: "https://annonces-demo-a.example/annonce/demo_a-http-1", location: "Cocody",
    listedAt: new Date(now.getTime() - 3_600_000), availability: "available",
  }];
  // Deux heures plus tard : la surveillance (accélérée à 1 h par les options des essais précédents) est due.
  const collectedAt = new Date(now.getTime() + 2 * 3_600_000);
  await collect(collectedAt);
  const found = await runActiveSearchStep({ pool: env.pool, now: () => collectedAt });
  assert.equal(found.notified, 1);
  const late = new Date(bought.startsAt.getTime() + 28 * 86_400_000);
  assert.ok((await runActiveSearchStep({ pool: env.pool, now: () => late })).notices >= 1);

  const list = await notifications.notifications.list(request("GET", "/api/notifications", { cookie: buyer.cookie })).then(reply);
  assert.equal(list.status, 200);
  const items = obj(list.json).items as Json[];
  const external = items.find((item) => item.kind === "new_external_match");
  const expiring = items.find((item) => item.kind === "active_search_expiring");
  assert.ok(external && expiring);
  assert.deepEqual(Object.keys(external).sort(), ["count", "createdAt", "demandId", "id", "kind", "link", "offerId", "price", "readAt", "sourceName", "title"]);
  assert.deepEqual([external.title, external.sourceName, external.offerId, external.link, external.price], ["iPhone 12 128 Go violet scellé", "Annonces Démo A", null, `/besoins/${demandId}`, { amount: 139_000, currency: "XOF" }]);
  assert.deepEqual(Object.keys(expiring).sort(), ["count", "createdAt", "demandId", "endsAt", "id", "kind", "link", "offerId", "price", "readAt", "title"]);
  assert.deepEqual([expiring.title, expiring.price, expiring.link, expiring.endsAt], [null, null, `/besoins/${demandId}`, bought.endsAt.toISOString()]);
  assert.equal(list.text.includes("annonces-demo-a.example"), false);
  assert.equal(list.text.includes("demo_a-http-1"), false, "ni l'identifiant de l'annonce chez la source");

  const homeAnswer = await home.buyer(request("GET", "/api/home/buyer", { cookie: buyer.cookie })).then(reply);
  assert.equal(homeAnswer.status, 200);
  const homeItems = obj(homeAnswer.json).notifications as Json[];
  const kinds = homeItems.map((item) => item.kind).sort();
  assert.ok(kinds.includes("new_external_match") && kinds.includes("active_search_expiring"), kinds.join(","));
  assert.equal(homeAnswer.text.includes("annonces-demo-a.example"), false);
  for (const item of homeItems) assert.equal(item.link, `/besoins/${demandId}`);
});

// ═════════════ RA1-bis : prix affiché, disponibilité, suspension, remboursement ═════════════

test("A6 : un prix affiché qui n'est pas le prix courant → 409 price_changed, texte fixe, RIEN n'est écrit ni débité ; le bon prix passe ; le rejeu d'une clé avec un autre prix affiché est refusé aussi", async () => {
  const { buyer, demandId } = await buyerWithDemand(5_000);
  const before = await count(env.pool, "wallet_transactions");
  for (const expectedPriceXof of [1_999, 2_001, 1, 50_000]) {
    const answer = await purchase(buyer.cookie, demandId, { idempotencyKey: randomUUID(), expectedPriceXof });
    assert.equal(answer.status, 409, String(expectedPriceXof));
    assert.deepEqual(errorOf(answer), { code: "price_changed", message: "Le prix de la recherche active a changé : rechargez la page, puis réessayez." });
  }
  assert.equal(await count(env.pool, "wallet_transactions"), before);
  assert.equal(await count(env.pool, "active_search_purchases", `demand_id = '${demandId}'`), 0);
  assert.equal(await balanceOf(env.pool, buyer.userId), BigInt(5_000));
  const valid = body();
  assert.equal((await purchase(buyer.cookie, demandId, valid)).status, 201);
  const replayOtherPrice = await purchase(buyer.cookie, demandId, { ...valid, expectedPriceXof: 1_500 });
  assert.equal(replayOtherPrice.status, 409);
  assert.equal(errorOf(replayOtherPrice).code, "price_changed");
  const replay = await purchase(buyer.cookie, demandId, valid);
  assert.equal(replay.status, 200);
  assert.equal(await balanceOf(env.pool, buyer.userId), BigInt(3_000), "un seul débit");
});

test("B1 : collecte indisponible (environnement sans connecteurs fictifs, comme la production) → GET dit « pas encore disponible » (canPurchase faux), POST 409 unavailable avec texte fixe, rien n'est écrit ; sans clé produit : no_product_key", async () => {
  const bare = createActiveSearchHttpHandlers({ pool: env.pool, env: { NOMA_AUTH_ORIGIN: ORIGIN }, log: () => undefined });
  const { buyer, demandId } = await buyerWithDemand(5_000);
  const noKey = await createDemand({ ownerId: buyer.userId, rawText: "Je cherche quelque chose", status: "active" }, env.pool);
  const get = (handlers: ActiveSearchHttpHandlers, id: string) => handlers.get(request("GET", `/api/demands/${id}/active-search`, { cookie: buyer.cookie }), id).then(reply);
  const post = (handlers: ActiveSearchHttpHandlers, id: string) => handlers.purchase(request("POST", `/api/demands/${id}/active-search`, { cookie: buyer.cookie, body: body() }), id).then(reply);
  const before = await count(env.pool, "wallet_transactions");
  const read = await get(bare, demandId);
  assert.equal(read.status, 200);
  assert.deepEqual([obj(read.json).canPurchase, obj(read.json).blockedReason, obj(read.json).nextEndsAt], [false, "unavailable", null]);
  const refused = await post(bare, demandId);
  assert.equal(refused.status, 409);
  assert.deepEqual(errorOf(refused), { code: "unavailable", message: "La recherche active n'est pas encore disponible : aucune annonce d'un autre site n'est collectée pour le moment." });
  const keyless = await post(search, noKey.id);
  assert.equal(keyless.status, 409);
  assert.deepEqual(errorOf(keyless), { code: "no_product_key", message: "Option indisponible pour ce besoin : il faut au moins une catégorie, une marque et un modèle." });
  assert.deepEqual([obj((await get(search, noKey.id)).json).blockedReason, obj((await get(search, demandId)).json).canPurchase], ["no_product_key", true]);
  assert.equal(await count(env.pool, "wallet_transactions"), before, "aucun débit");
  assert.equal(await count(env.pool, "active_search_purchases", `demand_id IN ('${demandId}', '${noKey.id}')`), 0);
});

test("A4 : besoin satisfait → le GET montre l'option SUSPENDUE (suspended vrai, active faux, fin connue, aucun achat possible) ; M4 : le rejeu de la clé d'un achat remboursé → 409 purchase_refunded", async () => {
  const { buyer, demandId } = await buyerWithDemand(5_000);
  const valid = body();
  const bought = await purchase(buyer.cookie, demandId, valid);
  assert.equal(bought.status, 201);
  const version = (await env.pool.query<{ v: number }>("SELECT content_version AS v FROM demands WHERE id = $1", [demandId])).rows[0].v;
  await satisfyDemand(buyer.userId, demandId, version, env.pool);
  const dto = obj((await state(buyer.cookie, demandId)).json);
  assert.deepEqual([dto.suspended, dto.active, dto.canPurchase, dto.blockedReason, dto.demandStatus], [true, false, false, "demand_not_active", "satisfied"]);
  assert.notEqual(dto.endsAt, null);
  const purchaseId = (await env.pool.query<{ id: string }>("SELECT id FROM active_search_purchases WHERE demand_id = $1", [demandId])).rows[0].id;
  await refundActiveSearchPurchase({ pool: env.pool, purchaseId, reasonCode: "essai_http" });
  const version2 = (await env.pool.query<{ v: number }>("SELECT content_version AS v FROM demands WHERE id = $1", [demandId])).rows[0].v;
  await activateDemand(buyer.userId, demandId, version2, env.pool);
  const before = await count(env.pool, "wallet_transactions");
  const replay = await purchase(buyer.cookie, demandId, valid);
  assert.equal(replay.status, 409);
  assert.deepEqual(errorOf(replay), { code: "purchase_refunded", message: "Cette option a été remboursée : démarrez une nouvelle option si vous la souhaitez." });
  assert.equal(await count(env.pool, "wallet_transactions"), before);
  assert.equal((await purchase(buyer.cookie, demandId, body())).status, 201, "une nouvelle clé rachète");
});

test("A5 : l'admission de capacité par HTTP — au-delà de 4 produits accélérés distincts, 409 capacity avec texte fixe, sans écriture", async () => {
  const buyer = await login(env.pool);
  await fund(env.pool, buyer.userId, 40_000);
  const engaged = (await acceleratedCapacity(env.pool, FAKE_ENV, new Date())).keys.length;
  const room = Math.max(0, 4 - engaged);
  const statuses: number[] = [];
  let refusal: Reply | null = null;
  for (let index = 1; index <= 6; index += 1) {
    const demand = await createDemand({ ownerId: buyer.userId, rawText: `Je cherche un Redmi ${index}`, category: "Téléphones", brand: "Xiaomi", model: `Redmi ${index}`, location: "Abidjan", budget: { amount: 200_000, currency: "XOF" }, status: "active" }, env.pool);
    const before = await count(env.pool, "wallet_transactions");
    const answer = await purchase(buyer.cookie, demand.id, body());
    statuses.push(answer.status);
    if (answer.status === 409) {
      refusal = refusal ?? answer;
      assert.equal(await count(env.pool, "wallet_transactions"), before, "un refus de capacité n'écrit rien");
      assert.equal(await count(env.pool, "active_search_purchases", `demand_id = '${demand.id}'`), 0);
    }
  }
  assert.equal(statuses.filter((status) => status === 201).length, room, `${statuses.join(",")} (clés déjà engagées dans le schéma : ${engaged})`);
  assert.equal(statuses.filter((status) => status === 409).length, 6 - room);
  assert.ok(refusal);
  assert.deepEqual(errorOf(refusal), { code: "capacity", message: "La collecte accélérée est complète pour le moment : réessayez plus tard." });
});
