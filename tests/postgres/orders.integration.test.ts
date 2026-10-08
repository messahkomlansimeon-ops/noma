import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { createSocialHttpHandlers, type SocialHttpHandlers } from "../../lib/server/social/http";
import { makeBoost, makeDemand, makeMatch, makeOffer, insertExposure } from "./metrics-fixtures";
import { NOT_FOUND, count, login, makeMarket, openTestSchema, reply, request, resetSocial, type Login, type Market, type TestSchema } from "./social-fixtures";

/**
 * Commandes (lot D2) : déclaration (prix de 1 à 100 000 000), une seule commande active par (besoin, annonce), transitions contrôlées (rôle, état, base), accès réservé
 * aux deux parties (404 indiscernable), attribution au boost figée à la déclaration, ventes confirmées arrondies dans les statistiques du vendeur.
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

type Json = Record<string, unknown>;
const declare = async (m: Market, price: unknown, cookie: string | null = m.buyer.cookie, offerId = m.offer.id, demandId = m.demand.id) =>
  reply(await handlers.orders.declare(request("POST", `/api/demands/${demandId}/offers/${offerId}/orders`, { cookie, body: { priceXof: price } }), demandId, offerId));
const act = async (orderId: string, action: string, cookie: string | null, origin?: string | null) =>
  reply(await handlers.orders.act(request("POST", `/api/orders/${orderId}/${action}`, { cookie, origin, body: {} }), orderId, action));
const get = async (orderId: string, cookie: string | null) => reply(await handlers.orders.get(request("GET", `/api/orders/${orderId}`, { cookie }), orderId));
const list = async (cookie: string | null, as: string) => reply(await handlers.orders.list(request("GET", "/api/orders", { cookie, query: `?as=${as}` })));
const sales = async (offerId: string, cookie: string | null) => reply(await handlers.orders.sales(request("GET", `/api/offers/${offerId}/sales`, { cookie }), offerId));
const orderOf = (answer: { json: unknown }): Json => (answer.json as { order: Json }).order;
const statusOf = async (id: string): Promise<string> => (await env.pool.query<{ status: string }>("SELECT status FROM orders WHERE id = $1", [id])).rows[0].status;

async function addBuyer(m: Market): Promise<{ buyer: Login; demandId: string }> {
  const buyer = await login(env.pool);
  const demand = await makeDemand(env.pool, buyer.userId);
  await makeMatch(env.pool, m.offer, demand);
  return { buyer, demandId: demand.id };
}

test("déclarer une vente : commande « proposée », forme en liste blanche, aucune identité de l'autre partie", async () => {
  const answer = await declare(market, 230_000);
  assert.equal(answer.status, 201);
  const order = orderOf(answer);
  assert.equal(order.status, "proposed");
  assert.deepEqual(order.price, { amount: 230_000, currency: "XOF" });
  assert.equal(order.role, "buyer");
  assert.equal(order.demandId, market.demand.id);
  assert.equal(order.offerId, market.offer.id);
  assert.equal(order.title, "Apple iPhone 13 128 Go");
  assert.equal(order.canCancel, true);
  assert.equal(order.canConfirm, false);
  assert.equal(order.canMarkDemandSatisfied, false);
  assert.equal(order.decidedAt, null);
  assert.deepEqual(Object.keys(order).sort(), ["canCancel", "canConfirm", "canDecline", "canMarkDemandSatisfied", "conversationId", "createdAt", "decidedAt", "demandId", "id", "missionId", "offerId", "price", "quantity", "role", "status", "title"]);
  assert.ok(!answer.text.includes(market.seller.userId) && !answer.text.includes(market.seller.phone));
  // Vue du vendeur : le besoin de l'acheteur reste inconnu, les actions sont les siennes.
  const seller = orderOf(await get(order.id as string, market.seller.cookie));
  assert.equal(seller.role, "seller");
  assert.equal(seller.demandId, null);
  assert.equal(seller.canConfirm, true);
  assert.equal(seller.canDecline, true);
  assert.equal(seller.canCancel, false);
  const sellerText = (await get(order.id as string, market.seller.cookie)).text;
  assert.ok(!sellerText.includes(market.buyer.userId) && !sellerText.includes(market.buyer.phone) && !sellerText.includes(market.demand.id));
});

test("prix refusé : 0, négatif, décimal, trop grand, texte, absent ; les bornes 1 et 100 000 000 passent ; rien n'est écrit en cas de refus", async () => {
  for (const price of [0, -5, 1.5, 100_000_001, "5000", null, undefined, Number.MAX_SAFE_INTEGER + 1, true, [1]]) {
    const answer = await declare(market, price);
    assert.equal(answer.status, 400, JSON.stringify(price));
    assert.deepEqual(answer.json, { error: { code: "invalid_price", message: "Le prix convenu doit être un entier de 1 à 100 000 000 FCFA." } });
  }
  assert.equal(await count(env.pool, "orders"), 0);
  assert.equal((await declare(market, 1)).status, 201);
  const second = await addBuyer(market);
  const high = await declare(market, 100_000_000, second.buyer.cookie, market.offer.id, second.demandId);
  assert.equal(high.status, 201);
  assert.equal(await count(env.pool, "orders"), 2);
});

test("une seule commande active par (besoin, annonce) : la deuxième déclaration est refusée (409), même simultanée ; refusée ou annulée, une nouvelle est permise", async () => {
  const [a, b] = await Promise.all([declare(market, 200_000), declare(market, 210_000)]);
  assert.deepEqual([a.status, b.status].sort(), [201, 409]);
  const loser = a.status === 409 ? a : b;
  assert.deepEqual(loser.json, { error: { code: "order_active_exists", message: "Une commande est déjà en cours pour cette annonce." } });
  assert.equal(await count(env.pool, "orders"), 1);
  const winner = orderOf(a.status === 201 ? a : b);
  // Refusée par le vendeur : une nouvelle déclaration est permise.
  assert.equal(orderOf(await act(winner.id as string, "decline", market.seller.cookie)).status, "declined");
  const retry = await declare(market, 190_000);
  assert.equal(retry.status, 201);
  // Annulée par l'acheteur : idem.
  assert.equal(orderOf(await act(orderOf(retry).id as string, "cancel", market.buyer.cookie)).status, "cancelled");
  const third = await declare(market, 180_000);
  assert.equal(third.status, 201);
  // Confirmée : plus aucune autre commande active possible.
  assert.equal(orderOf(await act(orderOf(third).id as string, "confirm", market.seller.cookie)).status, "confirmed");
  assert.equal((await declare(market, 170_000)).status, 409);
  assert.equal(await count(env.pool, "orders"), 3);
  assert.equal(await count(env.pool, "orders", "status IN ('proposed', 'confirmed')"), 1);
});

test("accès à la déclaration : vendeur, tiers, besoin inconnu, annonce hors correspondance → le même 404 ; annonce retirée → 409 ; sans session 401 ; origine 403", async () => {
  const unmatched = await makeOffer(env.pool, market.seller.userId);
  for (const answer of [
    await declare(market, 100_000, market.seller.cookie),
    await declare(market, 100_000, stranger.cookie),
    await declare(market, 100_000, market.buyer.cookie, unmatched.id),
    await declare(market, 100_000, market.buyer.cookie, market.offer.id, stranger.userId),
  ]) {
    assert.equal(answer.status, 404);
    assert.deepEqual(answer.json, NOT_FOUND);
  }
  assert.equal((await declare(market, 100_000, null)).status, 401);
  assert.equal((await reply(await handlers.orders.declare(request("POST", `/api/demands/${market.demand.id}/offers/${market.offer.id}/orders`, { cookie: market.buyer.cookie, origin: "https://evil.example", body: { priceXof: 1000 } }), market.demand.id, market.offer.id))).status, 403);
  assert.equal((await reply(await handlers.orders.declare(request("POST", `/api/demands/${market.demand.id}/offers/${market.offer.id}/orders`, { cookie: market.buyer.cookie, origin: null, body: { priceXof: 1000 } }), market.demand.id, market.offer.id))).status, 403);
  assert.equal((await reply(await handlers.orders.declare(request("POST", `/api/demands/${market.demand.id}/offers/${market.offer.id}/orders`, { cookie: market.buyer.cookie, body: { priceXof: 1000, x: 1 } }), market.demand.id, market.offer.id))).status, 400);
  await env.pool.query("UPDATE offers SET status = 'paused' WHERE id = $1", [market.offer.id]);
  const gone = await declare(market, 100_000);
  assert.equal(gone.status, 409);
  assert.deepEqual(gone.json, { error: { code: "offer_not_available", message: "Cette annonce n'est plus disponible." } });
  assert.equal(await count(env.pool, "orders"), 0);
});

test("transitions : le vendeur confirme ou refuse, l'acheteur annule tant que ce n'est pas confirmé ; un rôle ou un état interdit est refusé et rien ne change", async () => {
  const order = orderOf(await declare(market, 230_000));
  const id = order.id as string;
  // Mauvais rôle : l'acheteur ne confirme ni ne refuse ; le vendeur n'annule pas.
  for (const [action, cookie] of [["confirm", market.buyer.cookie], ["decline", market.buyer.cookie], ["cancel", market.seller.cookie]] as const) {
    const answer = await act(id, action, cookie);
    assert.equal(answer.status, 403, action);
    assert.deepEqual(answer.json, { error: { code: "action_not_allowed", message: "Cette action n'est pas permise pour votre rôle." } });
  }
  assert.equal(await statusOf(id), "proposed");
  // Tiers et action inconnue : 404 indiscernable.
  for (const answer of [await act(id, "confirm", stranger.cookie), await act(id, "cancel", stranger.cookie), await act(id, "supprimer", market.seller.cookie), await act("0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b", "confirm", market.seller.cookie)]) {
    assert.equal(answer.status, 404);
    assert.deepEqual(answer.json, NOT_FOUND);
  }
  assert.equal((await get(id, stranger.cookie)).status, 404);
  const confirmed = orderOf(await act(id, "confirm", market.seller.cookie));
  assert.equal(confirmed.status, "confirmed");
  assert.notEqual(confirmed.decidedAt, null);
  assert.equal(confirmed.canConfirm, false);
  // Définitif : ni annulation, ni refus, ni nouvelle confirmation.
  for (const [action, cookie] of [["cancel", market.buyer.cookie], ["decline", market.seller.cookie], ["confirm", market.seller.cookie]] as const) {
    const answer = await act(id, action, cookie);
    assert.equal(answer.status, 409, action);
    assert.deepEqual(answer.json, { error: { code: "order_state_conflict", message: "Cette commande ne peut plus changer d'état." } });
  }
  assert.equal(await statusOf(id), "confirmed");
  // Annulation avant confirmation.
  const second = await addBuyer(market);
  const other = orderOf(await declare(market, 210_000, second.buyer.cookie, market.offer.id, second.demandId));
  assert.equal(orderOf(await act(other.id as string, "cancel", second.buyer.cookie)).status, "cancelled");
  assert.equal((await act(other.id as string, "confirm", market.seller.cookie)).status, 409, "une commande annulée ne se confirme plus");
  // Origine et session.
  const third = await addBuyer(market);
  const fresh = orderOf(await declare(market, 205_000, third.buyer.cookie, market.offer.id, third.demandId));
  assert.equal((await act(fresh.id as string, "confirm", market.seller.cookie, "https://evil.example")).status, 403);
  assert.equal((await act(fresh.id as string, "confirm", null)).status, 401);
  assert.equal(await statusOf(fresh.id as string), "proposed");
});

test("garde-fous de la base : seule « proposée » évolue, les états finaux sont définitifs, rien d'autre que le statut ne change, deux commandes actives impossibles, parties et prix contrôlés", async () => {
  const order = orderOf(await declare(market, 230_000));
  const id = order.id as string;
  const rejected = (sql: string, params: unknown[], pattern: RegExp) =>
    assert.rejects(() => env.pool.query(sql, params), (error: { message?: string; code?: string }) => pattern.test(`${error.code} ${error.message}`), sql);
  await rejected("UPDATE orders SET price_amount = 1 WHERE id = $1", [id], /order_immutable/);
  await rejected("UPDATE orders SET buyer_id = seller_id WHERE id = $1", [id], /order_immutable|23514/);
  await rejected("UPDATE orders SET status = 'bidon' WHERE id = $1", [id], /order_transition_forbidden/);
  await rejected("UPDATE orders SET status = 'confirmed' WHERE id = $1", [id], /23514/); // decided_at manquant : CHECK
  await env.pool.query("UPDATE orders SET status = 'confirmed', decided_at = clock_timestamp() WHERE id = $1", [id]);
  for (const target of ["proposed", "declined", "cancelled"]) {
    await rejected(`UPDATE orders SET status = '${target}', decided_at = ${target === "proposed" ? "NULL" : "clock_timestamp()"} WHERE id = $1`, [id], /order_final/);
  }
  assert.equal(await statusOf(id), "confirmed");
  // Deux commandes actives pour le même couple : refusé par l'index partiel.
  await rejected(
    "INSERT INTO orders (demand_id, offer_id, buyer_id, seller_id, price_amount) VALUES ($1, $2, $3, $4, 1000)",
    [market.demand.id, market.offer.id, market.buyer.userId, market.seller.userId],
    /23505/,
  );
  // Parties qui ne sont pas celles du besoin et de l'annonce, même personne des deux côtés, prix hors bornes.
  await rejected("INSERT INTO orders (demand_id, offer_id, buyer_id, seller_id, price_amount, status, decided_at) VALUES ($1, $2, $3, $4, 1000, 'declined', now())", [market.demand.id, market.offer.id, stranger.userId, market.seller.userId], /social_parties_mismatch/);
  await rejected("INSERT INTO orders (demand_id, offer_id, buyer_id, seller_id, price_amount, status, decided_at) VALUES ($1, $2, $3, $3, 1000, 'declined', now())", [market.demand.id, market.offer.id, market.buyer.userId], /23514/);
  for (const price of [0, 100_000_001]) {
    await rejected("INSERT INTO orders (demand_id, offer_id, buyer_id, seller_id, price_amount, status, decided_at) VALUES ($1, $2, $3, $4, $5, 'declined', now())", [market.demand.id, market.offer.id, market.buyer.userId, market.seller.userId, price], /23514/);
  }
});

test("effets d'une confirmation : le besoin PEUT être marqué satisfait (proposé à l'acheteur, jamais automatique), seulement par l'acheteur et tant que le besoin est actif", async () => {
  const id = orderOf(await declare(market, 230_000)).id as string;
  const before = orderOf(await get(id, market.buyer.cookie));
  assert.equal(before.canMarkDemandSatisfied, false, "pas avant la confirmation");
  const confirmed = orderOf(await act(id, "confirm", market.seller.cookie));
  assert.equal(confirmed.canMarkDemandSatisfied, false, "la vue du vendeur ne propose rien");
  const buyerView = orderOf(await get(id, market.buyer.cookie));
  assert.equal(buyerView.canMarkDemandSatisfied, true);
  assert.equal((await env.pool.query<{ status: string }>("SELECT status FROM demands WHERE id = $1", [market.demand.id])).rows[0].status, "active", "le besoin n'est jamais marqué automatiquement");
  await env.pool.query("UPDATE demands SET status = 'satisfied' WHERE id = $1", [market.demand.id]);
  assert.equal(orderOf(await get(id, market.buyer.cookie)).canMarkDemandSatisfied, false, "déjà satisfait");
});

test("listes : chacun ne voit que ses commandes dans le rôle demandé ; paramètre as obligatoire", async () => {
  const id = orderOf(await declare(market, 230_000)).id as string;
  const buyerList = ((await list(market.buyer.cookie, "buyer")).json as { orders: Array<Json> }).orders;
  assert.deepEqual(buyerList.map((order) => order.id), [id]);
  assert.deepEqual(((await list(market.seller.cookie, "seller")).json as { orders: Array<Json> }).orders.map((order) => order.id), [id]);
  assert.deepEqual(((await list(market.buyer.cookie, "seller")).json as { orders: unknown[] }).orders, [], "l'acheteur n'est pas vendeur de cette commande");
  assert.deepEqual(((await list(market.seller.cookie, "buyer")).json as { orders: unknown[] }).orders, []);
  assert.deepEqual(((await list(stranger.cookie, "buyer")).json as { orders: unknown[] }).orders, []);
  assert.equal((await list(market.buyer.cookie, "autre")).status, 400);
  assert.equal((await reply(await handlers.orders.list(request("GET", "/api/orders", { cookie: market.buyer.cookie })))).status, 400);
  assert.equal((await list(null, "buyer")).status, 401);
});

test("depuis une conversation : l'acheteur peut déclarer (canDeclareOrder), la commande apparaît dans la conversation, le lien existe des deux côtés", async () => {
  const opened = await reply(await handlers.conversations.open(request("POST", `/api/demands/${market.demand.id}/offers/${market.offer.id}/conversation`, { cookie: market.buyer.cookie }), market.demand.id, market.offer.id));
  const conversationId = (opened.json as { conversation: { id: string } }).conversation.id;
  const detail = async (cookie: string) => ((await reply(await handlers.conversations.detail(request("GET", `/api/conversations/${conversationId}`, { cookie }), conversationId))).json as { conversation: Json }).conversation;
  assert.equal((await detail(market.buyer.cookie)).canDeclareOrder, true);
  assert.equal((await detail(market.seller.cookie)).canDeclareOrder, false);
  assert.equal((await detail(market.buyer.cookie)).order, null);
  const order = orderOf(await declare(market, 225_000));
  assert.equal(order.conversationId, conversationId);
  assert.deepEqual((await detail(market.buyer.cookie)).order, { id: order.id, status: "proposed" });
  assert.equal((await detail(market.buyer.cookie)).canDeclareOrder, false, "une commande est déjà en cours");
  await act(order.id as string, "decline", market.seller.cookie);
  assert.equal((await detail(market.buyer.cookie)).canDeclareOrder, true, "refusée : une nouvelle déclaration est possible");
});

test("attribution au boost : MÊME règle que les contacts (annonce servie sponsorisée à CE besoin dans les 7 jours), figée à la déclaration ; sinon organique", async () => {
  const boostId = await makeBoost(env.pool, market.offer);
  // Aucune exposition sponsorisée : organique.
  const organic = orderOf(await declare(market, 230_000));
  assert.equal((await env.pool.query("SELECT boost_id FROM orders WHERE id = $1", [organic.id])).rows[0].boost_id, null);
  await act(organic.id as string, "cancel", market.buyer.cookie);
  // Servie sponsorisée il y a 1 heure à ce besoin : attribuée.
  await insertExposure(env.pool, { boostId, offerId: market.offer.id, demandId: market.demand.id, viewerId: market.buyer.userId, firstServedAgo: "1 hour" });
  const attributed = orderOf(await declare(market, 231_000));
  assert.equal((await env.pool.query("SELECT boost_id FROM orders WHERE id = $1", [attributed.id])).rows[0].boost_id, boostId);
  await act(attributed.id as string, "cancel", market.buyer.cookie);
  // Une exposition de plus de 7 jours n'attribue plus.
  await env.pool.query("TRUNCATE boost_exposures");
  await insertExposure(env.pool, { boostId, offerId: market.offer.id, demandId: market.demand.id, viewerId: market.buyer.userId, firstServedAgo: "8 days" });
  const old = orderOf(await declare(market, 232_000));
  assert.equal((await env.pool.query("SELECT boost_id FROM orders WHERE id = $1", [old.id])).rows[0].boost_id, null);
  // Servie à un AUTRE besoin : pas attribuée à celui-ci.
  await act(old.id as string, "cancel", market.buyer.cookie);
  await env.pool.query("TRUNCATE boost_exposures");
  const second = await addBuyer(market);
  await insertExposure(env.pool, { boostId, offerId: market.offer.id, demandId: second.demandId, viewerId: second.buyer.userId, firstServedAgo: "1 hour" });
  const elsewhere = orderOf(await declare(market, 233_000));
  assert.equal((await env.pool.query("SELECT boost_id FROM orders WHERE id = $1", [elsewhere.id])).rows[0].boost_id, null);
});

test("statistiques du vendeur : seules les ventes CONFIRMÉES comptent, arrondies (« moins de 5 », « environ N »), répartition boost / organique seulement si l'annonce a eu un boost ; jamais pour l'annonce d'un autre", async () => {
  const first = orderOf(await declare(market, 230_000));
  // Proposée : pas comptée.
  let answer = await sales(market.offer.id, market.seller.cookie);
  assert.equal(answer.status, 200);
  assert.deepEqual(answer.json, { contractVersion: "offer-sales/v1", sales: { confirmed: { kind: "below", bound: 5 }, attributedToBoost: null, organic: null } });
  await act(first.id as string, "confirm", market.seller.cookie);
  answer = await sales(market.offer.id, market.seller.cookie);
  assert.deepEqual((answer.json as { sales: Json }).sales.confirmed, { kind: "below", bound: 5 }, "une vente confirmée : jamais le compte exact");
  assert.ok(!answer.text.includes('"count"'));
  // Boost + 4 ventes attribuées (la première, antérieure au boost, est organique) : 5 ventes confirmées au total.
  const boostId = await makeBoost(env.pool, market.offer);
  for (let index = 0; index < 4; index += 1) {
    const buyer = await addBuyer(market);
    await insertExposure(env.pool, { boostId, offerId: market.offer.id, demandId: buyer.demandId, viewerId: buyer.buyer.userId, firstServedAgo: "1 hour" });
    const created = orderOf(await declare(market, 200_000 + index, buyer.buyer.cookie, market.offer.id, buyer.demandId));
    await act(created.id as string, "confirm", market.seller.cookie);
  }
  assert.equal(await count(env.pool, "orders", "status = 'confirmed'"), 5);
  answer = await sales(market.offer.id, market.seller.cookie);
  assert.deepEqual((answer.json as { sales: Json }).sales, {
    confirmed: { kind: "approx", value: 5 },
    attributedToBoost: { kind: "below", bound: 5 },
    organic: { kind: "below", bound: 5 },
  });
  // Pas la vente d'un autre vendeur ni d'une annonce inconnue : même 404.
  for (const result of [await sales(market.offer.id, stranger.cookie), await sales(market.offer.id, market.buyer.cookie), await sales("0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b", market.seller.cookie)]) {
    assert.equal(result.status, 404);
    assert.deepEqual(result.json, NOT_FOUND);
  }
  assert.equal((await sales(market.offer.id, null)).status, 401);
});
