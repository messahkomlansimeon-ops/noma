import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { createSocialHttpHandlers, type SocialHttpHandlers } from "../../lib/server/social/http";
import { FAVORITES_LIMIT } from "../../lib/server/social/config";
import { makeOffer } from "./metrics-fixtures";
import { NOT_FOUND, addMatchingOffer, count, login, makeMarket, openTestSchema, reply, request, resetSocial, type Login, type Market, type TestSchema } from "./social-fixtures";

/**
 * Favoris (lot D2) : accès identique à la fiche (une annonce qu'on n'a pas le droit de voir ne se met pas en favori), liste avec titre, prix et statut,
 * « n'est plus disponible », retrait, limite de 200, origine vérifiée, 404 indiscernable.
 */

let env: TestSchema;
let handlers: SocialHttpHandlers;
let market: Market;
let stranger: Login;

before(async () => {
  env = await openTestSchema();
  handlers = createSocialHttpHandlers({ pool: env.pool, env: { NOMA_AUTH_ORIGIN: "https://noma.test" }, log: () => {} });
  stranger = await login(env.pool);
});

after(async () => {
  await env.close();
});

beforeEach(async () => {
  await resetSocial(env.pool);
  market = await makeMarket(env.pool);
});

const add = (m: Market, call: { cookie?: string | null; origin?: string | null } = {}, offerId = m.offer.id) =>
  handlers.favorites.add(request("POST", `/api/demands/${m.demand.id}/offers/${offerId}/favorite`, { cookie: call.cookie === undefined ? m.buyer.cookie : call.cookie, origin: call.origin }), m.demand.id, offerId);
const list = (cookie: string | null) => handlers.favorites.list(request("GET", "/api/favorites", { cookie }));
const remove = (offerId: string, cookie: string | null, origin?: string | null) => handlers.favorites.remove(request("DELETE", `/api/favorites/${offerId}`, { cookie, origin }), offerId);

test("garder une annonce de ses correspondances : 201 puis 200 (idempotent), liste avec titre, prix et statut", async () => {
  const first = await reply(await add(market));
  assert.equal(first.status, 201);
  assert.deepEqual(first.json, { contractVersion: "favorites/v1", favorite: { offerId: market.offer.id, demandId: market.demand.id } });
  assert.equal((await reply(await add(market))).status, 200);
  assert.equal(await count(env.pool, "favorites"), 1);
  const listed = await reply(await list(market.buyer.cookie));
  assert.equal(listed.status, 200);
  const items = (listed.json as { items: Array<Record<string, unknown>> }).items;
  assert.equal(items.length, 1);
  assert.equal(items[0].offerId, market.offer.id);
  assert.equal(items[0].demandId, market.demand.id);
  assert.equal(items[0].title, "Apple iPhone 13 128 Go");
  assert.deepEqual(items[0].price, { amount: 250_000, currency: "XOF" });
  assert.equal(items[0].available, true);
  assert.equal(items[0].openable, true);
  // Liste blanche : ni vendeur, ni texte brut.
  assert.deepEqual(Object.keys(items[0]).sort(), ["available", "createdAt", "demandId", "offerId", "openable", "price", "title"]);
  assert.ok(!listed.text.includes("RAW_SECRET_TEXT"));
  assert.ok(!listed.text.includes(market.seller.userId));
});

test("retrait : le favori disparaît de la liste ; retirer deux fois est sans erreur ; le favori d'un autre n'est jamais touché", async () => {
  await add(market);
  assert.deepEqual((await reply(await remove(market.offer.id, stranger.cookie))).json, { contractVersion: "favorites/v1", removed: false });
  assert.equal(await count(env.pool, "favorites"), 1, "un autre compte ne retire rien");
  assert.deepEqual((await reply(await remove(market.offer.id, market.buyer.cookie))).json, { contractVersion: "favorites/v1", removed: true });
  assert.deepEqual((await reply(await remove(market.offer.id, market.buyer.cookie))).json, { contractVersion: "favorites/v1", removed: false });
  assert.deepEqual(((await reply(await list(market.buyer.cookie))).json as { items: unknown[] }).items, []);
});

test("accès de la fiche : un tiers, le vendeur, un besoin inconnu, une annonce hors correspondance ou en pause reçoivent le même 404 et rien n'est écrit", async () => {
  const other = await makeOffer(env.pool, market.seller.userId); // publiée mais SANS correspondance avec le besoin
  const refused = [
    await reply(await add(market, { cookie: stranger.cookie })),
    await reply(await add(market, { cookie: market.seller.cookie })),
    await reply(await add(market, {}, other.id)),
    await reply(await handlers.favorites.add(request("POST", `/api/demands/${stranger.userId}/offers/${market.offer.id}/favorite`, { cookie: market.buyer.cookie }), stranger.userId, market.offer.id)),
  ];
  for (const answer of refused) {
    assert.equal(answer.status, 404);
    assert.deepEqual(answer.json, NOT_FOUND);
  }
  await env.pool.query("UPDATE offers SET status = 'paused' WHERE id = $1", [market.offer.id]);
  assert.equal((await reply(await add(market))).status, 404, "une annonce en pause n'est plus visible");
  assert.equal(await count(env.pool, "favorites"), 0);
});

test("une annonce gardée puis retirée de la vente : « n'est plus disponible » (available faux, fiche non ouvrable), le favori reste listé et retirable", async () => {
  await add(market);
  const before = ((await reply(await list(market.buyer.cookie))).json as { items: Array<{ price: { amount: number } | null }> }).items;
  assert.equal(before[0].price?.amount, 250_000, "annonce en ligne : le prix est servi");
  await env.pool.query("UPDATE offers SET status = 'paused' WHERE id = $1", [market.offer.id]);
  const items = ((await reply(await list(market.buyer.cookie))).json as { items: Array<{ available: boolean; openable: boolean; title: string; price: unknown }> }).items;
  assert.equal(items.length, 1);
  assert.equal(items[0].available, false);
  assert.equal(items[0].price, null, "lot D3 : une annonce qui n'est plus disponible n'affiche plus de prix");
  assert.equal(items[0].openable, false);
  assert.equal(items[0].title, "Apple iPhone 13 128 Go");
  assert.equal(((await reply(await remove(market.offer.id, market.buyer.cookie))).json as { removed: boolean }).removed, true);
});

test("les favoris d'un compte ne sont visibles que de lui", async () => {
  await add(market);
  assert.deepEqual(((await reply(await list(stranger.cookie))).json as { items: unknown[] }).items, []);
  assert.deepEqual(((await reply(await list(market.seller.cookie))).json as { items: unknown[] }).items, []);
});

test("limite de 200 favoris par utilisateur : le 201e est refusé (409), un favori déjà gardé reste idempotent, retirer en libère un", async () => {
  // 199 favoris insérés directement (annonces brutes du vendeur), puis deux annonces à correspondance réelle passent par l'API.
  await env.pool.query(
    `INSERT INTO offers (id, owner_id, status, raw_text)
     SELECT gen_random_uuid(), $1::uuid, 'published', 'filler ' || g FROM generate_series(1, $2::int) g`,
    [market.seller.userId, FAVORITES_LIMIT - 1],
  );
  await env.pool.query(
    `INSERT INTO favorites (user_id, offer_id, demand_id)
     SELECT $1::uuid, o.id, $2::uuid FROM offers o WHERE o.raw_text LIKE 'filler %'`,
    [market.buyer.userId, market.demand.id],
  );
  assert.equal(await count(env.pool, "favorites"), FAVORITES_LIMIT - 1);
  const second = await addMatchingOffer(env.pool, market);
  assert.equal((await reply(await add(market))).status, 201, "le 200e passe");
  assert.equal(await count(env.pool, "favorites"), FAVORITES_LIMIT);
  const refused = await reply(await add(market, {}, second.id));
  assert.equal(refused.status, 409);
  assert.deepEqual(refused.json, { error: { code: "favorites_limit", message: "Vous avez atteint la limite de 200 favoris." } });
  assert.equal(await count(env.pool, "favorites"), FAVORITES_LIMIT);
  assert.equal((await reply(await add(market))).status, 200, "un favori déjà gardé n'est pas refusé à la limite");
  await remove(market.offer.id, market.buyer.cookie);
  assert.equal((await reply(await add(market, {}, second.id))).status, 201);
});

test("origine vérifiée sur les écritures, session exigée, aucune requête invalide n'écrit", async () => {
  assert.equal((await reply(await add(market, { origin: null }))).status, 403);
  assert.equal((await reply(await add(market, { origin: "https://evil.example" }))).status, 403);
  assert.equal((await reply(await remove(market.offer.id, market.buyer.cookie, "https://evil.example"))).status, 403);
  assert.equal((await reply(await add(market, { cookie: null }))).status, 401);
  assert.equal((await reply(await list(null))).status, 401);
  assert.equal((await reply(await handlers.favorites.add(request("POST", "/api/demands/pas-un-uuid/offers/x/favorite", { cookie: market.buyer.cookie }), "pas-un-uuid", "x"))).status, 400);
  assert.equal(
    (await reply(await handlers.favorites.add(request("POST", `/api/demands/${market.demand.id}/offers/${market.offer.id}/favorite`, { cookie: market.buyer.cookie, body: { x: 1 } }), market.demand.id, market.offer.id))).status,
    400,
  );
  assert.equal(await count(env.pool, "favorites"), 0);
});
