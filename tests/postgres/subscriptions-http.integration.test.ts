import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { grantAdmin } from "../../lib/server/admin/grant";
import { createAdminPlansHttpHandlers, type AdminPlansHttpHandlers } from "../../lib/server/admin/plans-http";
import { createCatalogHttpHandlers } from "../../lib/server/catalog/http";
import { createSubscriptionHttpHandlers, type SubscriptionHttpHandlers } from "../../lib/server/subscriptions/http";
import { runSubscriptionStep } from "../../lib/server/subscriptions/lifecycle";
import { createPlanVersion } from "../../lib/server/subscriptions/plans";
import { createWalletHttpHandlers } from "../../lib/server/wallet/http";
import { checkWalletIntegrity } from "../../lib/server/wallet/check";
import * as subscriptionRoute from "../../app/api/subscription/route";
import * as autoRenewRoute from "../../app/api/subscription/auto-renew/route";
import * as noticesRoute from "../../app/api/subscription/notices/read/route";
import * as importRoute from "../../app/api/offers/import/route";
import * as plansRoute from "../../app/api/admin/plans/route";
import * as versionsRoute from "../../app/api/admin/plans/[code]/versions/route";
import { fund, makeOffer } from "./pro-fixtures";
import { NOT_FOUND, ORIGIN, count, login, openTestSchema, reply, request, type Login, type Reply, type TestSchema } from "./social-fixtures";

let env: TestSchema;
let subscription: SubscriptionHttpHandlers;
let adminPlans: AdminPlansHttpHandlers;
let boss: Login;
const logs: string[] = [];

before(async () => {
  env = await openTestSchema(12);
  const common = { pool: env.pool, env: { NOMA_AUTH_ORIGIN: ORIGIN }, log: (code: string) => { logs.push(code); } };
  subscription = createSubscriptionHttpHandlers(common);
  adminPlans = createAdminPlansHttpHandlers(common);
  boss = await login(env.pool);
  assert.equal((await grantAdmin({ pool: env.pool, phone: boss.phone })).granted, true);
});

after(async () => {
  await env.close();
});

type Json = Record<string, unknown>;
const obj = (value: unknown): Json => value as Json;
const errorOf = (answer: Reply): { code: string; message: string } => obj(answer.json).error as { code: string; message: string };

const state = (cookie: string | null) => subscription.state(request("GET", "/api/subscription", { cookie })).then(reply);
const subscribe = (cookie: string | null, body: unknown, origin?: string | null) =>
  subscription.subscribe(request("POST", "/api/subscription", { cookie, body, origin })).then(reply);
const autoRenew = (cookie: string | null, body: unknown) => subscription.autoRenew(request("POST", "/api/subscription/auto-renew", { cookie, body })).then(reply);
const noticesRead = (cookie: string | null, body: unknown) => subscription.noticesRead(request("POST", "/api/subscription/notices/read", { cookie, body })).then(reply);
const importCatalog = (cookie: string | null, body: unknown, origin?: string | null) =>
  subscription.importCatalog(request("POST", "/api/offers/import", { cookie, body, origin })).then(reply);

/** Prix mensuel de la dernière version du plan Pro, tel que l'écran l'afficherait (change quand une nouvelle version est créée). */
let proPrice = 10_000;
const SUBSCRIBE_BODY = () => ({ planCode: "pro", idempotencyKey: randomUUID(), expectedPriceXof: proPrice });

// ═════════════ 1. Abonnement ═════════════

test("GET /api/subscription : session obligatoire ; l'état d'un compte gratuit (plans à prix PROVISOIRES, droits Gratuit, aucun abonnement, aucun crédit promotionnel) ; DTO en liste blanche", async () => {
  assert.equal((await state(null)).status, 401);
  const user = await login(env.pool);
  const answer = await state(user.cookie);
  assert.equal(answer.status, 200);
  const body = obj(answer.json);
  assert.deepEqual(Object.keys(body).sort(), ["contractVersion", "current", "notices", "onlineOffers", "plans", "pricesProvisional", "promo", "readAt", "subscription", "unreadNotices"]);
  assert.equal(body.contractVersion, "subscription/v1");
  assert.equal(body.pricesProvisional, true, "les prix sont provisoires : le serveur le dit");
  assert.deepEqual(body.plans, [
    { code: "free", name: "Gratuit", version: 1, monthlyPriceXof: 0, promoCreditsXof: 0, maxOnlineOffers: 10, entitlements: [] },
    { code: "pro", name: "Pro", version: 1, monthlyPriceXof: 10_000, promoCreditsXof: 5_000, maxOnlineOffers: 100, entitlements: ["badge_pro", "catalog_import"] },
  ]);
  assert.deepEqual(body.current, { source: "free", planCode: "free", planName: "Gratuit", maxOnlineOffers: 10, entitlements: [] });
  assert.equal(body.subscription, null);
  assert.deepEqual(body.promo, { balanceXof: 0, expiresAt: null });
  assert.equal(body.onlineOffers, 0);
  assert.equal((await state(user.cookie)).text.includes(user.userId), false, "jamais l'identifiant de l'utilisateur");
  // Paramètre de requête inattendu : refusé.
  const withQuery = await subscription.state(request("GET", "/api/subscription", { cookie: user.cookie, query: "?x=1" })).then(reply);
  assert.equal(withQuery.status, 400);
});

test("POST /api/subscription : origine AVANT la session, JSON strict (clés exactes, UUID), solde insuffisant 409 sans rien écrire, succès 201, rejeu 200, autre clé 409", async () => {
  const user = await login(env.pool);
  const valid = SUBSCRIBE_BODY();
  assert.equal((await subscribe(user.cookie, valid, null)).status, 403, "origine absente");
  assert.equal((await subscribe(user.cookie, valid, "https://evil.test")).status, 403, "origine étrangère");
  assert.equal((await subscribe(null, valid, "https://evil.test")).status, 403, "l'origine est vérifiée avant la session");
  assert.equal((await subscribe(null, valid)).status, 401);
  for (const body of [
    {}, { planCode: "pro" }, { ...valid, extra: 1 }, { ...valid, planCode: 5 }, { ...valid, idempotencyKey: "pas-un-uuid" }, [valid], "texte",
    // A6 : le prix AFFICHÉ est obligatoire, entier, positif.
    { planCode: "pro", idempotencyKey: valid.idempotencyKey }, { ...valid, expectedPriceXof: "10000" }, { ...valid, expectedPriceXof: 10_000.5 }, { ...valid, expectedPriceXof: 0 },
    { ...valid, expectedPriceXof: -10_000 }, { ...valid, expectedPriceXof: null }, { ...valid, expectedPriceXof: true }, { ...valid, expectedPriceXof: Number.MAX_SAFE_INTEGER + 2 },
  ]) {
    assert.equal((await subscribe(user.cookie, body)).status, 400, JSON.stringify(body));
  }
  // Content-Type et JSON piégé.
  const wrongType = await subscription.subscribe(new Request(`${ORIGIN}/api/subscription`, {
    method: "POST", headers: { cookie: user.cookie, origin: ORIGIN, "content-type": "text/plain" }, body: JSON.stringify(valid),
  })).then(reply);
  assert.equal(wrongType.status, 400);
  const doubleKey = await subscription.subscribe(new Request(`${ORIGIN}/api/subscription`, {
    method: "POST", headers: { cookie: user.cookie, origin: ORIGIN, "content-type": "application/json" }, body: `{"planCode":"pro","planCode":"free","idempotencyKey":"${valid.idempotencyKey}","expectedPriceXof":10000}`,
  })).then(reply);
  assert.equal(doubleKey.status, 400, "clé en double refusée par le lecteur strict");
  // A6 : un prix affiché qui n'est pas le prix courant → 409 price_changed, texte fixe, rien d'écrit (même avec un solde suffisant plus bas).
  const beforeGuard = await count(env.pool, "wallet_transactions");
  for (const expectedPriceXof of [9_999, 10_001, 1, 12_000]) {
    const stale = await subscribe(user.cookie, { ...valid, expectedPriceXof });
    assert.equal(stale.status, 409, String(expectedPriceXof));
    assert.deepEqual(errorOf(stale), { code: "price_changed", message: "Le prix de l'abonnement a changé : rechargez la page, puis réessayez." });
  }
  assert.equal(await count(env.pool, "wallet_transactions"), beforeGuard);
  assert.equal(await count(env.pool, "subscriptions", `user_id = '${user.userId}'`), 0);
  // Solde insuffisant : 409, texte fixe, rien d'écrit.
  const before = await count(env.pool, "wallet_transactions");
  const poor = await subscribe(user.cookie, valid);
  assert.equal(poor.status, 409);
  assert.deepEqual(errorOf(poor), { code: "insufficient_balance", message: "Solde insuffisant : rechargez votre porte-monnaie." });
  assert.equal(await count(env.pool, "wallet_transactions"), before);
  assert.equal(await count(env.pool, "subscriptions", `user_id = '${user.userId}'`), 0);
  // Recharge puis succès.
  await fund(env.pool, user.userId, 12_000);
  const created = await subscribe(user.cookie, valid);
  assert.equal(created.status, 201);
  const body = obj(created.json);
  assert.equal(body.reused, false);
  assert.equal(obj(body.subscription).planCode, "pro");
  assert.equal(obj(body.subscription).status, "active");
  assert.equal(obj(body.subscription).autoRenew, true);
  assert.equal(obj(body.subscription).entitled, true);
  assert.equal(obj(body.subscription).currentPriceXof, 10_000);
  assert.deepEqual(body.promo && Object.keys(obj(body.promo)).sort(), ["balanceXof", "expiresAt"]);
  assert.equal(obj(body.promo).balanceXof, 5_000);
  assert.equal(obj(body.current).planCode, "pro");
  assert.equal(created.text.includes(user.userId), false);
  // Rejeu de la même clé : 200 `reused`, aucun second débit.
  const replay = await subscribe(user.cookie, valid);
  assert.equal(replay.status, 200);
  assert.equal(obj(replay.json).reused, true);
  assert.equal(await count(env.pool, "subscription_periods", `user_id = '${user.userId}'`), 1);
  // Le rejeu avec un autre prix affiché que celui payé : price_changed, jamais « déjà enregistré ».
  assert.equal(errorOf(await subscribe(user.cookie, { ...valid, expectedPriceXof: 12_000 })).code, "price_changed");
  assert.equal(await count(env.pool, "subscription_periods", `user_id = '${user.userId}'`), 1);
  // Autre clé : 409 already_subscribed ; plan gratuit ou inconnu.
  assert.equal(errorOf(await subscribe(user.cookie, SUBSCRIBE_BODY())).code, "already_subscribed");
  const other = await login(env.pool);
  assert.equal(errorOf(await subscribe(other.cookie, { planCode: "free", idempotencyKey: randomUUID(), expectedPriceXof: 10_000 })).code, "plan_not_subscribable");
  const unknown = await subscribe(other.cookie, { planCode: "inconnu", idempotencyKey: randomUUID(), expectedPriceXof: 10_000 });
  assert.deepEqual([unknown.status, unknown.json], [404, NOT_FOUND]);
  // Le porte-monnaie distingue crédits et crédits promotionnels (GET /api/wallet).
  const wallet = createWalletHttpHandlers({ pool: env.pool, env: { NOMA_AUTH_ORIGIN: ORIGIN } });
  const overview = obj((await reply(await wallet.wallet.get(request("GET", "/api/wallet", { cookie: user.cookie })))).json);
  assert.equal(overview.balanceXof, 2_000);
  assert.equal(overview.promoBalanceXof, 5_000);
  assert.equal(typeof overview.promoExpiresAt, "string");
  const line = (overview.transactions as Json[]).find((entry) => entry.kind === "subscription_charge");
  assert.deepEqual(line && { amountXof: line.amountXof, promoAmountXof: line.promoAmountXof }, { amountXof: -10_000, promoAmountXof: 5_000 });
  assert.equal((await checkWalletIntegrity(env.pool)).ok, true);
});

test("double clic HTTP : 8 POST simultanés avec la même clé → un seul débit (un 201, sept 200)", async () => {
  const user = await login(env.pool);
  await fund(env.pool, user.userId, 25_000);
  const valid = SUBSCRIBE_BODY();
  const answers = await Promise.all(Array.from({ length: 8 }, () => subscribe(user.cookie, valid)));
  assert.equal(answers.filter((answer) => answer.status === 201).length, 1);
  assert.equal(answers.filter((answer) => answer.status === 200).length, 7);
  const wallet = (await env.pool.query<{ balance: string }>("SELECT balance::text FROM wallet_accounts WHERE kind = 'user' AND owner_id = $1", [user.userId])).rows[0];
  assert.equal(wallet.balance, "15000");
  assert.equal((await checkWalletIntegrity(env.pool)).ok, true);
});

test("annulation : POST /api/subscription/auto-renew (origine, session, corps strict) ; sans abonnement 409 ; renouvellement désactivé puis réactivé", async () => {
  const user = await login(env.pool);
  assert.equal((await autoRenew(null, { autoRenew: false })).status, 401);
  assert.equal(errorOf(await autoRenew(user.cookie, { autoRenew: false })).code, "no_subscription");
  await fund(env.pool, user.userId, 10_000);
  await subscribe(user.cookie, SUBSCRIBE_BODY());
  for (const body of [{}, { autoRenew: "non" }, { autoRenew: false, extra: 1 }, [false]]) assert.equal((await autoRenew(user.cookie, body)).status, 400, JSON.stringify(body));
  const off = await autoRenew(user.cookie, { autoRenew: false });
  assert.equal(off.status, 200);
  assert.equal(obj(obj(off.json).subscription).autoRenew, false);
  assert.equal(typeof obj(obj(off.json).subscription).canceledAt, "string");
  assert.equal(obj(obj(off.json).subscription).entitled, true, "droits conservés jusqu'à la fin de la période");
  const on = await autoRenew(user.cookie, { autoRenew: true });
  assert.equal(obj(obj(on.json).subscription).autoRenew, true);
  assert.equal(obj(obj(on.json).subscription).canceledAt, null);
  const noOrigin = await subscription.autoRenew(request("POST", "/api/subscription/auto-renew", { cookie: user.cookie, body: { autoRenew: false }, origin: null })).then(reply);
  assert.equal(noOrigin.status, 403);
});

test("avis : un renouvellement refusé puis la fin de l'abonnement créent des avis lisibles ; marqués lus par `all` ou par `ids` ; l'avis d'autrui ou inconnu est introuvable (404 identique)", async () => {
  const user = await login(env.pool);
  await fund(env.pool, user.userId, 10_000);
  await subscribe(user.cookie, SUBSCRIBE_BODY());
  const end = new Date((await env.pool.query<{ e: Date }>("SELECT current_period_end AS e FROM subscriptions WHERE user_id = $1", [user.userId])).rows[0].e);
  // Seize annonces en ligne, puis le solde manque au renouvellement et la grâce s'écoule.
  for (let index = 0; index < 13; index += 1) await makeOffer(env.pool, user.userId);
  await runSubscriptionStep({ pool: env.pool, userId: user.userId, now: new Date(end.getTime() + 3_600_000) });
  await runSubscriptionStep({ pool: env.pool, userId: user.userId, now: new Date(end.getTime() + 80 * 3_600_000) });
  const answer = obj((await state(user.cookie)).json);
  const codes = (answer.notices as Json[]).map((notice) => notice.code).sort();
  assert.deepEqual(codes, ["listings_paused", "renewal_failed", "subscription_ended"]);
  assert.equal(answer.unreadNotices, 3);
  assert.equal(obj(answer.current).planCode, "free");
  assert.equal(answer.subscription, null);
  const paused = (answer.notices as Json[]).find((notice) => notice.code === "listings_paused");
  assert.equal(paused?.listingCount, 3);
  assert.deepEqual(Object.keys(paused as Json).sort(), ["code", "createdAt", "id", "listingCount", "readAt"]);
  // Marquer lus par identifiant : celui d'un autre utilisateur ou inconnu → 404 identique.
  const ids = (answer.notices as Json[]).map((notice) => notice.id as string);
  const other = await login(env.pool);
  const foreign = await noticesRead(other.cookie, { ids: [ids[0]] });
  const unknown = await noticesRead(user.cookie, { ids: [randomUUID()] });
  assert.deepEqual([foreign.status, foreign.json], [404, NOT_FOUND]);
  assert.deepEqual([unknown.status, unknown.json], [404, NOT_FOUND]);
  assert.equal((await noticesRead(user.cookie, { ids: [ids[0]] })).status, 200);
  assert.equal(obj((await noticesRead(user.cookie, { all: true })).json).unreadNotices, 0);
  for (const body of [{}, { all: false }, { all: true, ids: ids }, { ids: [] }, { ids: ["x"] }]) assert.equal((await noticesRead(user.cookie, body)).status, 400, JSON.stringify(body));
});

test("la publication au-delà de la limite d'annonces en ligne répond 409 `offer_limit_reached` (texte fixe) par la route du catalogue", async () => {
  const user = await login(env.pool);
  const catalog = createCatalogHttpHandlers({ pool: env.pool, env: { NOMA_AUTH_ORIGIN: ORIGIN } });
  for (let index = 0; index < 10; index += 1) await makeOffer(env.pool, user.userId);
  const draft = await makeOffer(env.pool, user.userId, { status: "draft" });
  const answer = await catalog.offers.publish(request("POST", `/api/offers/${draft.id}/publish`, { cookie: user.cookie, body: { expectedContentVersion: draft.contentVersion } }), draft.id).then(reply);
  assert.equal(answer.status, 409);
  assert.deepEqual(errorOf(answer), { code: "offer_limit_reached", message: "Vous avez atteint le nombre maximal d'annonces en ligne de votre offre. Mettez une annonce en pause ou passez à l'offre Pro." });
  assert.equal(await count(env.pool, "offers", `owner_id = '${user.userId}' AND status = 'published'`), 10);
});

// ═════════════ 2. Import de catalogue ═════════════

test("POST /api/offers/import : origine, session, JSON strict ; droit catalog_import requis (403) ; aperçu 200, application 201, rejeu 200 ; fichier trop long 400 ; aucune donnée du fichier dans la réponse", async () => {
  const csv = "titre,description,prix\niPhone 12,Très bon état,150000\nTable,,abc";
  const free = await login(env.pool);
  const body = { csv, dryRun: true };
  assert.equal((await importCatalog(free.cookie, body, null)).status, 403, "origine absente");
  assert.equal((await importCatalog(null, body)).status, 401);
  for (const invalid of [{}, { csv }, { csv, dryRun: "oui" }, { csv, dryRun: true, extra: 1 }, { csv: 5, dryRun: true }]) assert.equal((await importCatalog(free.cookie, invalid)).status, 400, JSON.stringify(invalid));
  const refused = await importCatalog(free.cookie, body);
  assert.equal(refused.status, 403);
  assert.equal(errorOf(refused).code, "entitlement_required");

  const pro = await login(env.pool);
  await fund(env.pool, pro.userId, 10_000);
  await subscribe(pro.cookie, SUBSCRIBE_BODY());
  const preview = await importCatalog(pro.cookie, body);
  assert.equal(preview.status, 200);
  assert.deepEqual(Object.keys(obj(preview.json)).sort(), ["acceptedCount", "alreadyApplied", "contractVersion", "mode", "rejectedCount", "rowCount", "rows"]);
  assert.deepEqual(obj(preview.json).rows, [
    { line: 2, outcome: "would_create", code: null, field: null, offerId: null },
    { line: 3, outcome: "rejected", code: "invalid_field", field: "price", offerId: null },
  ]);
  assert.equal(await count(env.pool, "offers", `owner_id = '${pro.userId}'`), 0);
  const applied = await importCatalog(pro.cookie, { csv, dryRun: false });
  assert.equal(applied.status, 201);
  assert.equal(obj(applied.json).acceptedCount, 1);
  assert.match((obj(applied.json).rows as Json[])[0].offerId as string, /^[0-9a-f-]{36}$/);
  for (const secret of ["iPhone", "150000", "Très bon état", "Table"]) assert.equal(applied.text.includes(secret), false, `la réponse ne reprend pas « ${secret} »`);
  const replay = await importCatalog(pro.cookie, { csv, dryRun: false });
  assert.equal(replay.status, 200);
  assert.equal(obj(replay.json).alreadyApplied, true);
  assert.equal(await count(env.pool, "offers", `owner_id = '${pro.userId}'`), 1);
  // 201 lignes : 400 `too_many_rows` ; fichier illisible : 400 `invalid_file` ; messages fixes.
  const many = `titre\n${Array.from({ length: 201 }, (_, index) => `A${index}`).join("\n")}`;
  const tooMany = await importCatalog(pro.cookie, { csv: many, dryRun: false });
  assert.equal(tooMany.status, 400);
  assert.deepEqual(errorOf(tooMany), { code: "too_many_rows", message: "Le fichier compte plus de 200 lignes : découpez-le en plusieurs fichiers." });
  const unreadable = await importCatalog(pro.cookie, { csv: "couleur\nrouge", dryRun: false });
  assert.deepEqual(errorOf(unreadable), { code: "invalid_file", message: "Le fichier est illisible : vérifiez l'en-tête et le format CSV." });
  assert.equal(await count(env.pool, "offers", `owner_id = '${pro.userId}'`), 1, "rien n'a été créé par les fichiers refusés");
});

// ═════════════ 3. Administration des offres ═════════════

test("administration : le MÊME 404 pour un visiteur, un compte ordinaire ou un administrateur suspendu ; origine vérifiée sur l'écriture ; aucune route de modification d'une version", async () => {
  const ordinary = await login(env.pool);
  const get = (cookie: string | null) => adminPlans.overview(request("GET", "/api/admin/plans", { cookie })).then(reply);
  const create = (cookie: string | null, code: string, body: unknown, origin?: string | null) =>
    adminPlans.createVersion(request("POST", `/api/admin/plans/${code}/versions`, { cookie, body, origin }), code).then(reply);
  const goodBody = { name: "Pro", monthlyPriceXof: 12_000, promoCreditsXof: 6_000, maxOnlineOffers: 150, entitlements: ["badge_pro", "catalog_import"] };
  for (const cookie of [null, ordinary.cookie]) {
    const overview = await get(cookie);
    assert.deepEqual([overview.status, overview.json], [404, NOT_FOUND]);
    const written = await create(cookie, "pro", goodBody);
    assert.deepEqual([written.status, written.json], [404, NOT_FOUND]);
    assert.equal(written.text, overview.text, "indiscernable");
  }
  assert.equal(await count(env.pool, "plan_versions"), 2, "aucune version créée par un non-administrateur");
  assert.equal((await create(boss.cookie, "pro", goodBody, null)).status, 403, "origine absente");
  const suspended = await login(env.pool);
  await grantAdmin({ pool: env.pool, phone: suspended.phone });
  assert.equal((await get(suspended.cookie)).status, 200);
  await env.pool.query("UPDATE users SET status = 'suspended' WHERE id = $1", [suspended.userId]);
  assert.equal((await get(suspended.cookie)).status, 404);
  await env.pool.query("UPDATE users SET status = 'active' WHERE id = $1", [suspended.userId]);
  // Les routes n'exposent que GET (liste) et POST (nouvelle version) : aucune modification ni suppression d'une version publiée.
  assert.deepEqual(Object.keys(plansRoute).filter((key) => ["GET", "POST", "PUT", "PATCH", "DELETE"].includes(key)).sort(), ["GET"]);
  assert.deepEqual(Object.keys(versionsRoute).filter((key) => ["GET", "POST", "PUT", "PATCH", "DELETE"].includes(key)).sort(), ["POST"]);
});

test("administration : versions en lecture, abonnés ARRONDIS À 5 PRÈS, revenus du mois, nouvelle version (validation stricte) appliquée aux NOUVELLES souscriptions seulement : les abonnés actuels gardent leur prix, renouvellements compris", async () => {
  const get = () => adminPlans.overview(request("GET", "/api/admin/plans", { cookie: boss.cookie })).then(reply);
  const create = (body: unknown, code = "pro") => adminPlans.createVersion(request("POST", `/api/admin/plans/${code}/versions`, { cookie: boss.cookie, body }), code).then(reply);

  // Quatre abonnés Pro : « environ 5 » (jamais « 4 »).
  const subscribers: Login[] = [];
  for (let index = 0; index < 4; index += 1) {
    const user = await login(env.pool);
    await fund(env.pool, user.userId, 30_000);
    await subscribe(user.cookie, SUBSCRIBE_BODY());
    subscribers.push(user);
  }
  const first = obj((await get()).json);
  assert.equal(first.pricesProvisional, true);
  assert.equal(first.contractVersion, "admin-plans/v1");
  const approximate = (first.subscribers as Json[]).find((entry) => entry.planCode === "pro");
  // Arrondi au multiple de 5 le plus proche (la moitié vers le haut) : jamais le nombre exact quand il n'est pas un multiple de 5.
  const exact = await count(env.pool, "subscriptions", "status IN ('active', 'past_due')");
  assert.ok(exact >= 4);
  assert.equal(approximate?.approximateCount, Math.floor((2 * exact + 5) / 10) * 5);
  assert.equal(Number(approximate?.approximateCount) % 5, 0);
  assert.equal(first.totalSubscribersApproximate, approximate?.approximateCount);
  assert.ok(!(first.subscribers as Json[]).some((entry) => entry.planCode === "free"));
  assert.equal(Number(first.subscriptionRevenueXof) >= 40_000, true, "les revenus d'abonnement du mois (lus dans le grand livre) comptent au moins ces quatre débits");
  assert.equal(Number(obj(first.promo).issuedXof) >= 20_000, true);
  const plans = first.plans as Json[];
  assert.deepEqual(plans.map((plan) => plan.code), ["free", "pro"]);
  assert.equal(((plans[1].versions as Json[])[0]).version, 1);
  assert.equal(JSON.stringify(first).includes(subscribers[0].userId), false, "aucune identité d'abonné");

  // Nouvelle version : validation stricte (clés exactes, bornes, droits de la liste blanche).
  const valid = { name: "Pro", monthlyPriceXof: 12_000, promoCreditsXof: 6_000, maxOnlineOffers: 150, entitlements: ["badge_pro", "catalog_import", "priority_support_label"] };
  for (const invalid of [
    {}, { ...valid, extra: 1 }, { ...valid, name: "" }, { ...valid, name: "x".repeat(61) }, { ...valid, monthlyPriceXof: 0 }, { ...valid, monthlyPriceXof: -1 }, { ...valid, monthlyPriceXof: 1.5 },
    { ...valid, promoCreditsXof: -1 }, { ...valid, maxOnlineOffers: 0 }, { ...valid, maxOnlineOffers: 100_001 }, { ...valid, entitlements: ["inconnu"] }, { ...valid, entitlements: ["badge_pro", "badge_pro"] }, { ...valid, entitlements: "badge_pro" },
  ]) assert.equal((await create(invalid)).status, 400, JSON.stringify(invalid));
  assert.equal((await create(valid, "inconnu")).status, 404);
  assert.equal((await create({ ...valid, monthlyPriceXof: 5 }, "free")).status, 400, "le plan Gratuit ne coûte rien ni ne donne de droit");
  assert.equal(await count(env.pool, "plan_versions"), 2);
  const created = await create(valid);
  assert.equal(created.status, 201);
  assert.equal(obj(obj(created.json).version).version, 2);
  assert.equal(await count(env.pool, "plan_versions"), 3);
  // La version 1 est INCHANGÉE (immuable) ; la 2 est la version courante.
  const rows = (await env.pool.query<{ version: number; price: string; promo: string }>(
    "SELECT v.version, v.monthly_price_xof::text AS price, v.promo_credits_xof::text AS promo FROM plan_versions v JOIN plans p ON p.id = v.plan_id WHERE p.code = 'pro' ORDER BY v.version")).rows;
  assert.deepEqual(rows, [{ version: 1, price: "10000", promo: "5000" }, { version: 2, price: "12000", promo: "6000" }]);
  assert.equal(obj((await state(subscribers[0].cookie)).json).plans && ((obj((await state(subscribers[0].cookie)).json).plans as Json[])[1]).version, 2);

  // Un abonné existant garde sa période payée ET ses renouvellements au prix de la version 1 ; un NOUVEL abonné paie la version 2.
  const existing = subscribers[0];
  const current = obj(obj((await state(existing.cookie)).json).subscription);
  assert.equal(current.currentPriceXof, 10_000, "la période déjà payée garde son prix");
  assert.equal(current.renewalPriceXof, 10_000, "le prochain renouvellement est au prix EXACT de sa version (jamais celui de la version 2)");
  const end = new Date(current.periodEnd as string);
  await runSubscriptionStep({ pool: env.pool, userId: existing.userId, now: new Date(end.getTime() + 60_000) });
  const second = (await env.pool.query<{ price: string; promo: string; version: number }>(
    `SELECT p.price_xof::text AS price, p.promo_credits_xof::text AS promo, v.version FROM subscription_periods p JOIN plan_versions v ON v.id = p.plan_version_id
      WHERE p.user_id = $1 AND p.number = 2`, [existing.userId])).rows[0];
  assert.deepEqual(second, { price: "10000", promo: "5000", version: 1 }, "renouvelé au prix et aux crédits promotionnels de SA version");
  assert.equal((await env.pool.query<{ balance: string }>("SELECT balance::text FROM wallet_accounts WHERE kind = 'user' AND owner_id = $1", [existing.userId])).rows[0].balance, "10000", "30 000 − 10 000 − 10 000 : jamais 12 000 au renouvellement");
  const renewed = obj(obj((await state(existing.cookie)).json).subscription);
  assert.deepEqual([renewed.currentPriceXof, renewed.renewalPriceXof], [10_000, 10_000]);
  const fresh = await login(env.pool);
  await fund(env.pool, fresh.userId, 20_000);
  // A6 : l'écran affichait encore 10 000 (version 1) : le nouveau prix de 12 000 est refusé tant qu'il n'est pas relu, sans débit.
  const beforeStale = await count(env.pool, "wallet_transactions");
  const staleScreen = await subscribe(fresh.cookie, SUBSCRIBE_BODY());
  assert.equal(staleScreen.status, 409);
  assert.equal(errorOf(staleScreen).code, "price_changed");
  assert.equal(await count(env.pool, "wallet_transactions"), beforeStale, "aucun débit au prix périmé");
  proPrice = 12_000;
  const subscribed = obj(obj((await subscribe(fresh.cookie, SUBSCRIBE_BODY())).json).subscription);
  assert.equal(subscribed.currentPriceXof, 12_000);
  assert.equal((await env.pool.query<{ balance: string }>("SELECT balance::text FROM wallet_accounts WHERE kind = 'user' AND owner_id = $1", [fresh.userId])).rows[0].balance, "8000");
  assert.equal((await checkWalletIntegrity(env.pool)).ok, true);
  // Le plan 'free' : sa nouvelle version change la limite des comptes gratuits (version courante), sans prix.
  const freeVersion = await createPlanVersion({
    pool: env.pool, planCode: "free", name: "Gratuit", monthlyPriceXof: 0, promoCreditsXof: 0, maxOnlineOffers: 12, entitlements: [], createdBy: boss.userId,
  });
  assert.equal(freeVersion.version, 2);
  assert.equal(obj(obj((await state((await login(env.pool)).cookie)).json).current).maxOnlineOffers, 12);
});

test("les routes de l'offre Pro n'exposent que les méthodes prévues", () => {
  const methods = (routeModule: object) => Object.keys(routeModule).filter((key) => ["GET", "POST", "PUT", "PATCH", "DELETE"].includes(key)).sort();
  assert.deepEqual(methods(subscriptionRoute), ["GET", "POST"]);
  assert.deepEqual(methods(autoRenewRoute), ["POST"]);
  assert.deepEqual(methods(noticesRoute), ["POST"]);
  assert.deepEqual(methods(importRoute), ["POST"]);
  for (const routeModule of [subscriptionRoute, autoRenewRoute, noticesRoute, importRoute, plansRoute, versionsRoute]) {
    assert.equal((routeModule as { runtime?: string }).runtime, "nodejs");
    assert.equal((routeModule as { dynamic?: string }).dynamic, "force-dynamic");
  }
});
