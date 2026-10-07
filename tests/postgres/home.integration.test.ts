import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import { Pool } from "pg";
import { requestOtp, verifyOtp, type SendOtpInput } from "../../lib/server/auth";
import { archiveOffer, createDemand } from "../../lib/server/catalog";
import { createHomeHttpHandlers, type HomeHttpHandlers } from "../../lib/server/home/http";
import { BUYER_HOME_DEMAND_LIMIT, ownTitle, readBuyerHome, readVendorHome } from "../../lib/server/home/reads";
import { runMigrations } from "../../lib/server/postgres/migrations";
import { recordWalletTransaction } from "../../lib/server/wallet/ledger";
import * as buyerRoute from "../../app/api/home/buyer/route";
import * as vendorRoute from "../../app/api/home/vendor/route";
import { makeBoost, makeBuyerMatch, makeDemand, makeMatch, makeOffer, makePerson } from "./metrics-fixtures";
import { createTemporarySchemaName, openVerifiedIsolatedPool, openVerifiedTestDatabase, quoteTemporarySchema } from "./test-database";

/**
 * Lot D1, P2 et P3 : les lectures des deux accueils (acheteur : besoins actifs, correspondances, notifications ; vendeur : annonces par statut, besoins correspondants
 * ARRONDIS, solde, boosts actifs) et leurs routes HTTP. Toujours limitées à l'utilisateur de la session ; aucune annonce d'autrui n'est listée.
 */

const SECRET = randomBytes(32);
const ORIGIN = "https://noma.test";
const schema = createTemporarySchemaName();
const quoted = quoteTemporarySchema(schema);
let admin: Pool, pool: Pool;
let handlers: HomeHttpHandlers;
let ipSequence = 0;
let phoneSequence = 0;

async function login(): Promise<{ userId: string; cookie: string }> {
  phoneSequence += 1;
  ipSequence += 1;
  const phone = `+22507${String(900 + phoneSequence).padStart(8, "0")}`;
  let delivery: SendOtpInput | undefined;
  const requested = await requestOtp(phone, { pool, authSecret: SECRET, requestIp: `198.51.100.${ipSequence}`, sendOtp: async (input) => { delivery = input; } });
  assert.ok(delivery);
  const verified = await verifyOtp(requested.challengeId, delivery.code, { pool, authSecret: SECRET });
  return { userId: verified.userId, cookie: `noma_auth=${verified.sessionToken}` };
}

before(async () => {
  const opened = await openVerifiedTestDatabase(process.env.TEST_DATABASE_URL);
  admin = opened.pool;
  await admin.query(`CREATE SCHEMA ${quoted}`);
  pool = await openVerifiedIsolatedPool(opened.target, schema, (config) => new Pool({ ...config, max: 4 }));
  await runMigrations(pool);
  handlers = createHomeHttpHandlers({ pool, log: () => {} });
});

after(async () => {
  if (pool) await pool.end();
  if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${quoted} CASCADE`); await admin.end(); }
});

const getReply = (route: "buyer" | "vendor", options: { cookie?: string; query?: string } = {}): Promise<Response> =>
  handlers[route](new Request(`${ORIGIN}/api/home/${route}${options.query ?? ""}`, { headers: options.cookie ? { cookie: options.cookie } : {} }));

test("accueil de l'acheteur : seulement SES besoins actifs, avec leur nombre de correspondances ; aucune annonce d'autrui, aucun besoin clos", async () => {
  const buyer = await makePerson(pool);
  const seller = await makePerson(pool);
  const empty = await readBuyerHome({ pool, userId: buyer.id });
  assert.deepEqual({ ...empty, readAt: "x" }, { contractVersion: "home-buyer/v1", activeDemandCount: 0, demands: [], unreadNotifications: 0, notifications: [], readAt: "x" });

  const withThree = await makeDemand(pool, buyer.id);
  const withNone = await makeDemand(pool, buyer.id);
  const satisfied = await makeDemand(pool, buyer.id, "satisfied");
  const draft = await makeDemand(pool, buyer.id, "draft");
  for (let index = 0; index < 3; index += 1) await makeMatch(pool, await makeOffer(pool, seller.id, { price: 200_000 + index }), withThree);
  const stranger = await makePerson(pool);
  const strangerDemand = await makeDemand(pool, stranger.id);
  await makeMatch(pool, await makeOffer(pool, seller.id), strangerDemand);

  const home = await readBuyerHome({ pool, userId: buyer.id });
  assert.equal(home.activeDemandCount, 2);
  assert.deepEqual(new Set(home.demands.map((demand) => demand.id)), new Set([withThree.id, withNone.id]));
  assert.equal(home.demands.find((demand) => demand.id === withThree.id)?.matchCount, 3);
  assert.equal(home.demands.find((demand) => demand.id === withNone.id)?.matchCount, 0);
  assert.ok(![satisfied.id, draft.id, strangerDemand.id].some((id) => home.demands.some((demand) => demand.id === id)));
  const text = JSON.stringify(home);
  for (const forbidden of ["rawText", "raw_text", "ownerId", "owner_id", "offerId", "sellerId", "phone_e164", "+225"]) assert.equal(text.includes(forbidden), false, forbidden);
  assert.deepEqual(Object.keys(home).sort(), ["activeDemandCount", "contractVersion", "demands", "notifications", "readAt", "unreadNotifications"], "aucune liste d'annonces");
});

test("accueil de l'acheteur : au plus 6 besoins montrés (le total réel est indiqué), notifications non lues comptées, trois plus récentes", async () => {
  const buyer = await makePerson(pool);
  const seller = await makePerson(pool);
  for (let index = 0; index < BUYER_HOME_DEMAND_LIMIT + 2; index += 1) await makeDemand(pool, buyer.id);
  const demand = await makeDemand(pool, buyer.id);
  for (let index = 0; index < 5; index += 1) {
    const offer = await makeOffer(pool, seller.id, { price: 100_000 + index });
    await pool.query(
      "INSERT INTO notifications (user_id, kind, demand_id, offer_id, title, price_amount, price_currency, created_at) VALUES ($1, 'new_match', $2, $3, $4, $5, 'XOF', clock_timestamp() - make_interval(secs => 100 - $6::int))",
      [buyer.id, demand.id, offer.id, `Apple iPhone 13 n° ${index}`, offer.price?.amount, index],
    );
  }
  await pool.query("UPDATE notifications SET read_at = clock_timestamp() WHERE user_id = $1 AND title = 'Apple iPhone 13 n° 4'", [buyer.id]);
  const home = await readBuyerHome({ pool, userId: buyer.id });
  assert.equal(home.activeDemandCount, BUYER_HOME_DEMAND_LIMIT + 3);
  assert.equal(home.demands.length, BUYER_HOME_DEMAND_LIMIT);
  assert.equal(home.unreadNotifications, 4);
  assert.deepEqual(home.notifications.map((item) => [item.title, item.unread]), [["Apple iPhone 13 n° 4", false], ["Apple iPhone 13 n° 3", true], ["Apple iPhone 13 n° 2", true]]);
  assert.match(home.notifications[1].link, /^\/besoins\/[0-9a-f-]{36}\/offres\/[0-9a-f-]{36}$/);
});

test("tableau de bord du vendeur (lot D3) : « besoins » compte les besoins DISTINCTS, jamais la somme des couples (annonce, besoin) ; plusieurs annonces semblables ne gonflent pas le total", async () => {
  const seller = await makePerson(pool);
  const buyerA = await makePerson(pool);
  const buyerB = await makePerson(pool);
  const demandA = await makeDemand(pool, buyerA.id);
  const demandB = await makeDemand(pool, buyerB.id);
  const offers = [];
  for (let index = 0; index < 5; index += 1) offers.push(await makeOffer(pool, seller.id, { price: 300_000 + index }));
  // 5 annonces semblables × 2 besoins = 10 couples, mais 2 besoins distincts.
  for (const offer of offers) {
    await makeMatch(pool, offer, demandA);
    await makeMatch(pool, offer, demandB);
  }
  const pairs = await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM matching_evaluations WHERE offer_id = ANY($1::uuid[]) AND is_confirmed_match = TRUE", [offers.map((offer) => offer.id)]);
  assert.equal(pairs.rows[0].n, 10, "10 couples (annonce, besoin) confirmés");
  const home = await readVendorHome({ pool, userId: seller.id });
  assert.deepEqual(home.needs, { kind: "below", bound: 5 }, "2 besoins distincts : « moins de 5 », pas « environ 10 »");
  for (const offer of offers) assert.deepEqual(home.offers.find((row) => row.id === offer.id)?.needs, { kind: "below", bound: 5 }, "par annonce : 2 besoins");
  // 7 besoins distincts de plus, chacun sur une seule des annonces : 9 distincts (« environ 10 ») alors que les couples sont 17.
  for (let index = 0; index < 7; index += 1) await makeMatch(pool, offers[index % offers.length], (await makeDemand(pool, (await makePerson(pool)).id)));
  const more = await readVendorHome({ pool, userId: seller.id });
  assert.deepEqual(more.needs, { kind: "approx", value: 10 }, "9 besoins distincts : « environ 10 »");
  // Un besoin qui correspond à toutes les annonces ne compte toujours qu'une fois : 5 couples de plus pour le même besoin ne changent rien.
  const demandC = await makeDemand(pool, (await makePerson(pool)).id);
  for (const offer of offers) await makeMatch(pool, offer, demandC);
  assert.deepEqual((await readVendorHome({ pool, userId: seller.id })).needs, { kind: "approx", value: 10 }, "10 besoins distincts : « environ 10 » (et non la somme des couples)");
  const sum = await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM matching_evaluations WHERE offer_id = ANY($1::uuid[]) AND is_confirmed_match = TRUE", [offers.map((offer) => offer.id)]);
  assert.equal(sum.rows[0].n, 22, "22 couples : la somme aurait publié « environ 20 »");
  assert.equal(JSON.stringify(more).includes('"needs":10'), false, "aucun compte exact");
});

test("tableau de bord du vendeur : annonces par statut (archivées exclues), besoins correspondants ARRONDIS, solde, boosts actifs ; rien des autres vendeurs", async () => {
  const seller = await makePerson(pool);
  const other = await makePerson(pool);
  const published = await makeOffer(pool, seller.id, { price: 250_000 });
  const second = await makeOffer(pool, seller.id, { price: 260_000 });
  await makeOffer(pool, seller.id, { status: "paused" });
  await makeOffer(pool, seller.id, { status: "draft" });
  const archived = await makeOffer(pool, seller.id);
  await archiveOffer(seller.id, archived.id, archived.contentVersion, pool);
  const foreign = await makeOffer(pool, other.id);
  for (let index = 0; index < 9; index += 1) await makeBuyerMatch(pool, published);
  for (let index = 0; index < 3; index += 1) await makeBuyerMatch(pool, second);
  await makeBuyerMatch(pool, foreign);
  await recordWalletTransaction(pool, {
    kind: "adjustment", reference: `adjustment:home-${seller.id}`, metadata: { reasonCode: "test_fixture" },
    entries: [{ account: { kind: "boost_revenue" }, amount: BigInt(-12_000) }, { account: { kind: "user", ownerId: seller.id }, amount: BigInt(12_000) }],
  });
  await makeBoost(pool, published, { endsIn: "2 days" });
  await makeBoost(pool, second, { status: "expired", startsAgo: "3 days", endsIn: "-1 day" });

  const home = await readVendorHome({ pool, userId: seller.id });
  assert.deepEqual(home.counts, { published: 2, paused: 1, draft: 1 });
  assert.deepEqual(home.needs, { kind: "approx", value: 10 }, "12 besoins publiés « environ 10 »");
  assert.equal(home.balance, 12_000);
  assert.equal(home.offers.length, 4, "l'annonce archivée n'est pas listée");
  assert.deepEqual(home.offers.find((offer) => offer.id === published.id)?.needs, { kind: "approx", value: 10 }, "9 besoins : « environ 10 »");
  assert.deepEqual(home.offers.find((offer) => offer.id === second.id)?.needs, { kind: "below", bound: 5 }, "3 besoins : « moins de 5 »");
  assert.equal(home.activeBoosts.length, 1);
  assert.equal(home.activeBoosts[0].offerId, published.id);
  assert.notEqual(home.offers.find((offer) => offer.id === published.id)?.boostEndsAt, null);
  assert.equal(home.offers.find((offer) => offer.id === second.id)?.boostEndsAt, null, "un boost expiré n'est pas actif");
  assert.equal(home.offers.some((offer) => offer.id === foreign.id), false);
  const text = JSON.stringify(home);
  assert.equal(/"(needs|count)":\s*\d/.test(text), false, "aucun compte exact de besoins");
  for (const forbidden of ["rawText", "raw_text", "ownerId", "demandId", "buyer", "phone_e164", "+225"]) assert.equal(text.includes(forbidden), false, forbidden);
  const blank = await readVendorHome({ pool, userId: (await makePerson(pool)).id });
  assert.deepEqual({ counts: blank.counts, needs: blank.needs, balance: blank.balance, offers: blank.offers, boosts: blank.activeBoosts }, {
    counts: { published: 0, paused: 0, draft: 0 }, needs: { kind: "below", bound: 5 }, balance: 0, offers: [], boosts: [],
  });
});

test("titres : première ligne du texte de l'utilisateur, sans caractère invisible ; à défaut marque, modèle, variante", () => {
  assert.equal(ownTitle({ rawText: "\n  iPhone 12 128 Go  \nsuite", brand: null, model: null, variant: null }), "iPhone 12 128 Go");
  assert.equal(ownTitle({ rawText: "iPhone‮ 12", brand: null, model: null, variant: null }), "iPhone 12");
  assert.equal(ownTitle({ rawText: "   ", brand: "Apple", model: "iPhone 12", variant: null }), "Apple iPhone 12");
  assert.equal(ownTitle({ rawText: "", brand: null, model: null, variant: null }), "Sans titre");
  assert.equal(ownTitle({ rawText: "x".repeat(200), brand: null, model: null, variant: null }).length, 80);
});

test("routes HTTP : 401 sans session, 400 avec un paramètre, no-store, DTO de la session seulement ; les fichiers de route exposent GET", async () => {
  const buyer = await login();
  const seller = await login();
  const demand = await createDemand({ ownerId: buyer.userId, rawText: "iPhone 12", category: "Téléphones", brand: "Apple", model: "iPhone 12", status: "active" }, pool);
  const offer = await makeOffer(pool, seller.userId);
  await makeMatch(pool, offer, demand);

  for (const route of ["buyer", "vendor"] as const) {
    const anonymous = await getReply(route);
    assert.equal(anonymous.status, 401);
    assert.deepEqual(await anonymous.json(), { error: { code: "authentication_required", message: "Authentification requise." } });
    const forged = await getReply(route, { cookie: "noma_auth=faux" });
    assert.equal(forged.status, 401);
  }
  const withQuery = await getReply("buyer", { cookie: buyer.cookie, query: "?userId=x" });
  assert.equal(withQuery.status, 400);

  const buyerReply = await getReply("buyer", { cookie: buyer.cookie });
  assert.equal(buyerReply.status, 200);
  assert.equal(buyerReply.headers.get("cache-control"), "no-store");
  const buyerHome = await buyerReply.json();
  assert.equal(buyerHome.contractVersion, "home-buyer/v1");
  assert.equal(buyerHome.demands.length, 1);
  assert.equal(buyerHome.demands[0].matchCount, 1);

  const sellerHome = await (await getReply("vendor", { cookie: seller.cookie })).json();
  assert.equal(sellerHome.contractVersion, "home-vendor/v1");
  assert.deepEqual(sellerHome.counts, { published: 1, paused: 0, draft: 0 });
  assert.deepEqual(sellerHome.needs, { kind: "below", bound: 5 });
  const buyerAsVendor = await (await getReply("vendor", { cookie: buyer.cookie })).json();
  assert.deepEqual(buyerAsVendor.offers, [], "l'acheteur ne voit aucune annonce d'autrui sur le tableau de bord vendeur");
  assert.equal(typeof buyerRoute.GET, "function");
  assert.equal(typeof vendorRoute.GET, "function");
  assert.equal(buyerRoute.dynamic, "force-dynamic");
});

test("panne de la base : 503 avec un texte fixe, un code seulement dans le journal", async () => {
  const buyer = await login();
  const logs: string[] = [];
  const broken = createHomeHttpHandlers({
    pool: new Proxy(pool, { get: (target, property, receiver) => (property === "query" ? () => Promise.reject(Object.assign(new Error("SECRET_DB_DETAIL postgres://x"), { code: "ECONNRESET" })) : Reflect.get(target, property, receiver)) }) as Pool,
    resolveSession: async () => ({ userId: buyer.userId } as never),
    log: (code) => logs.push(code),
  });
  const response = await broken.buyer(new Request(`${ORIGIN}/api/home/buyer`, { headers: { cookie: buyer.cookie } }));
  assert.equal(response.status, 503);
  const text = await response.text();
  assert.equal(text.includes("SECRET_DB_DETAIL"), false);
  assert.deepEqual(JSON.parse(text), { error: { code: "home_unavailable", message: "Le service est temporairement indisponible." } });
  assert.deepEqual(logs, ["ECONNRESET"]);
});
