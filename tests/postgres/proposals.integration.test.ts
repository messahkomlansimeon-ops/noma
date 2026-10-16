import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { createProposalsHttpHandlers, type ProposalsHttpHandlers } from "../../lib/server/proposals/http";
import { PROPOSALS_DAILY_LIMIT, PROPOSALS_NEED_OPEN_LIMIT, PROPOSAL_PRICE_MAX, PROPOSAL_PRICE_MIN } from "../../lib/proposals-rules";
import { ORDER_MAX_PRICE, ORDER_MIN_PRICE } from "../../lib/server/social/config";
import { makeDemand, makeMatch, makeOffer } from "./metrics-fixtures";
import { NOT_FOUND, count, login, makeMarket, openTestSchema, reply, request, resetSocial, type Login, type Market, type TestSchema } from "./social-fixtures";

/**
 * Propositions de vendeur et devis (lot FIN3-C3) : accès du vendeur (404 indiscernable), un seul envoi par couple, expiration lue puis écrite sous verrou, acceptation = commande créée dans la
 * MÊME transaction (rejouable, concurrente sans double commande, refusée sans effet quand une commande est déjà active), refus définitif, retrait, limites, garde de la base.
 */

let env: TestSchema;
let handlers: ProposalsHttpHandlers;
let market: Market;
let stranger: Login;

before(async () => {
  env = await openTestSchema(10);
  handlers = createProposalsHttpHandlers({ pool: env.pool, env: { NOMA_AUTH_ORIGIN: "https://noma.test" }, log: () => {} });
  stranger = await login(env.pool);
});

after(async () => {
  await env.close();
});

async function reset(): Promise<void> {
  for (const table of ["seller_proposal_lines", "seller_proposals"]) {
    const trigger = table === "seller_proposals" ? "trg_seller_proposals_guard" : "trg_seller_proposal_lines_immutable";
    await env.pool.query(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`);
    await env.pool.query(`DELETE FROM ${table}`);
    await env.pool.query(`ALTER TABLE ${table} ENABLE TRIGGER ${trigger}`);
  }
  await resetSocial(env.pool);
}

beforeEach(async () => {
  await reset();
  market = await makeMarket(env.pool);
});

type Json = Record<string, unknown>;
const body = (m: Market, extra: Json = {}) => ({ offerId: m.offer.id, priceXof: 240_000, slot: "Samedi matin", warranty: "3 mois", note: "Livraison possible à Cocody.", validDays: 7, ...extra });
const propose = (m: Market, payload: unknown, cookie: string | null = m.seller.cookie, origin?: string | null, demandId: string = m.demand.id) =>
  handlers.create(request("POST", `/api/requests/${demandId}/proposals`, { cookie, origin, body: payload }), demandId).then(reply);
const listAs = (as: string, cookie: string | null) => handlers.list(request("GET", "/api/proposals", { cookie, query: `?as=${as}` })).then(reply);
const act = (id: string, action: string, cookie: string | null, origin?: string | null) => handlers.act(request("POST", `/api/proposals/${id}/${action}`, { cookie, origin, body: {} }), id, action).then(reply);
const requests = (cookie: string | null) => handlers.requests(request("GET", "/api/requests", { cookie })).then(reply);
const proposalId = async (): Promise<string> => (await env.pool.query<{ id: string }>("SELECT id FROM seller_proposals ORDER BY created_at DESC LIMIT 1")).rows[0].id;

async function expire(id: string): Promise<void> {
  await env.pool.query("ALTER TABLE seller_proposals DISABLE TRIGGER trg_seller_proposals_guard");
  await env.pool.query("UPDATE seller_proposals SET created_at = clock_timestamp() - interval '3 days', valid_until = clock_timestamp() - interval '1 minute' WHERE id = $1", [id]);
  await env.pool.query("ALTER TABLE seller_proposals ENABLE TRIGGER trg_seller_proposals_guard");
}

test("bornes de prix : celles des commandes (l'acceptation ne peut jamais échouer sur le prix)", () => {
  assert.equal(PROPOSAL_PRICE_MIN, ORDER_MIN_PRICE);
  assert.equal(PROPOSAL_PRICE_MAX, ORDER_MAX_PRICE);
});

test("le vendeur voit les besoins qui correspondent à ses annonces (DTO sans identité), regroupés par besoin ; un autre compte n'en voit aucun", async () => {
  const listed = await requests(market.seller.cookie);
  assert.equal(listed.status, 200);
  const result = listed.json as { requests: Array<{ need: Json; offers: Json[] }>; offersTruncated: boolean };
  assert.equal(result.requests.length, 1);
  assert.equal(result.requests[0].need.candidateId, market.demand.id);
  assert.deepEqual(result.requests[0].offers, [{ offerId: market.offer.id, title: "Apple iPhone 13 128 Go", proposal: null, declined: false }]);
  assert.equal(result.offersTruncated, false);
  assert.ok(!listed.text.includes(market.buyer.userId) && !listed.text.includes(market.buyer.phone), "jamais l'identité de l'acheteur");
  assert.deepEqual(((await requests(stranger.cookie)).json as { requests: unknown[] }).requests, []);
  assert.equal((await requests(null)).status, 401);
  const one = await handlers.request(request("GET", `/api/requests/${market.demand.id}`, { cookie: market.seller.cookie }), market.demand.id).then(reply);
  assert.equal(one.status, 200);
  const none = await handlers.request(request("GET", `/api/requests/${market.demand.id}`, { cookie: stranger.cookie }), market.demand.id).then(reply);
  assert.equal(none.status, 404);
  assert.deepEqual(none.json, NOT_FOUND);
});

test("envoyer une proposition : 201 ; l'acheteur la reçoit (compteur en attente), le vendeur la voit ; ni l'un ni l'autre ne voit l'identifiant ou le numéro de l'autre", async () => {
  const sent = await propose(market, body(market));
  assert.equal(sent.status, 201);
  const proposal = (sent.json as { proposal: Json }).proposal;
  assert.deepEqual(Object.keys(proposal).sort(), ["createdAt", "decidedAt", "demandId", "id", "lines", "needTitle", "note", "offerId", "offerTitle", "orderId", "priceXof", "slot", "status", "validUntil", "warranty"]);
  assert.equal(proposal.status, "sent");
  assert.equal(proposal.priceXof, 240_000);
  const buyerView = await listAs("buyer", market.buyer.cookie);
  assert.equal((buyerView.json as { pendingCount: number }).pendingCount, 1);
  assert.equal(((buyerView.json as { proposals: Json[] }).proposals)[0].id, proposal.id);
  assert.ok(!buyerView.text.includes(market.seller.userId) && !buyerView.text.includes(market.seller.phone));
  const sellerView = await listAs("seller", market.seller.cookie);
  assert.equal(((sellerView.json as { proposals: Json[] }).proposals).length, 1);
  assert.ok(!sellerView.text.includes(market.buyer.userId) && !sellerView.text.includes(market.buyer.phone));
  assert.deepEqual(((await listAs("seller", market.buyer.cookie)).json as { proposals: unknown[] }).proposals, [], "chacun ne voit que les siennes");
  const flagged = (await requests(market.seller.cookie)).json as { requests: Array<{ offers: Array<{ proposal: Json | null }> }> };
  assert.equal(flagged.requests[0].offers[0].proposal?.status, "sent");
  assert.equal((await listAs("autre", market.buyer.cookie)).status, 400);
});

test("accès du vendeur : annonce d'un autre, annonce en pause, besoin inconnu ou clos, acheteur lui-même, compte suspendu, origine fausse, sans session : refus, rien n'est écrit", async () => {
  const other = await makeOffer(env.pool, market.seller.userId); // en ligne mais SANS correspondance avec le besoin
  const strangerOffer = await makeOffer(env.pool, stranger.userId);
  await makeMatch(env.pool, strangerOffer, market.demand);
  for (const [payload, cookie] of [
    [body(market), stranger.cookie],
    [body(market), market.buyer.cookie],
    [body(market, { offerId: other.id }), market.seller.cookie],
    [body(market, { offerId: strangerOffer.id }), market.seller.cookie],
    [body(market, { offerId: "00000000-0000-4000-8000-000000000000" }), market.seller.cookie],
  ] as const) {
    const refused = await propose(market, payload, cookie);
    assert.equal(refused.status, 404, JSON.stringify(payload));
    assert.deepEqual(refused.json, NOT_FOUND);
  }
  assert.equal((await propose(market, body(market), market.seller.cookie, undefined, "00000000-0000-4000-8000-000000000000")).status, 404);
  assert.equal((await propose(market, body(market), market.seller.cookie, "https://autre.test")).status, 403);
  assert.equal((await propose(market, body(market), null)).status, 401);
  await env.pool.query("UPDATE offers SET status = 'paused' WHERE id = $1", [market.offer.id]);
  assert.equal((await propose(market, body(market))).status, 404, "annonce hors ligne");
  await env.pool.query("UPDATE offers SET status = 'published' WHERE id = $1", [market.offer.id]);
  await env.pool.query("UPDATE demands SET status = 'satisfied' WHERE id = $1", [market.demand.id]);
  assert.equal((await propose(market, body(market))).status, 404, "besoin clos");
  await env.pool.query("UPDATE demands SET status = 'active' WHERE id = $1", [market.demand.id]);
  await env.pool.query("UPDATE users SET status = 'suspended' WHERE id = $1", [market.seller.userId]);
  assert.equal((await propose(market, body(market))).status, 401, "la session d'un vendeur suspendu est refusée");
  await env.pool.query("UPDATE users SET status = 'active' WHERE id = $1", [market.seller.userId]);
  assert.equal(await count(env.pool, "seller_proposals"), 0);
});

test("contenu : prix borné, aucune clé inconnue, aucun numéro (même coupé entre deux champs), devis : prix = somme des lignes ; rien n'est écrit", async () => {
  for (const extra of [{ priceXof: 0 }, { priceXof: 100_000_001 }, { priceXof: 1.5 }, { priceXof: "240000" }, { validDays: 0 }, { validDays: 15 }, { extra: 1 }, { slot: "x".repeat(121) }, { note: "x".repeat(301) }, { warranty: 5 }, { note: "a‮b" }]) {
    assert.equal((await propose(market, body(market, extra))).status, 400, JSON.stringify(extra));
  }
  for (const extra of [{ note: "appelez le 07 00 00 00 42" }, { slot: "07 00 00", warranty: "00 42 11", note: "22" }, { lines: [{ label: "0700000042", amountXof: 1000 }] }]) {
    const refused = await propose(market, body(market, extra));
    assert.equal(refused.status, 400, JSON.stringify(extra));
  }
  const phone = await propose(market, body(market, { note: "appelez le 07 00 00 00 42" }));
  assert.equal((phone.json as { error: { code: string } }).error.code, "phone_number_in_proposal");
  const lines = Array.from({ length: 21 }, (_, index) => ({ label: `Ligne ${index}`, amountXof: 10 }));
  for (const payload of [body(market, { lines }), { offerId: market.offer.id, lines: [{ label: "x", amountXof: 0 }] }, { offerId: market.offer.id, lines: [{ label: "", amountXof: 5 }] }, { offerId: market.offer.id, lines: [{ label: "x", amountXof: 5, extra: 1 }] }, body(market, { lines: [{ label: "Main d'oeuvre", amountXof: 30_000 }], priceXof: 29_999 })]) {
    assert.equal((await propose(market, payload)).status, 400, JSON.stringify(payload).slice(0, 80));
  }
  assert.equal(await count(env.pool, "seller_proposals"), 0);
  const quote = await propose(market, { offerId: market.offer.id, lines: [{ label: "Main d'oeuvre", amountXof: 30_000 }, { label: "Pièces", amountXof: 45_000 }], validDays: 3 });
  assert.equal(quote.status, 201);
  const proposal = (quote.json as { proposal: Json }).proposal;
  assert.equal(proposal.priceXof, 75_000, "le prix est la somme des lignes");
  assert.deepEqual(proposal.lines, [{ label: "Main d'oeuvre", amountXof: 30_000 }, { label: "Pièces", amountXof: 45_000 }]);
});

test("un seul envoi par couple (409) ; une proposition échue est lue « expirée », refusée à l'acceptation, et remplacée par un nouvel envoi", async () => {
  assert.equal((await propose(market, body(market))).status, 201);
  const again = await propose(market, body(market, { priceXof: 230_000 }));
  assert.equal(again.status, 409);
  assert.equal((again.json as { error: { code: string } }).error.code, "proposal_active_exists");
  const first = await proposalId();
  await expire(first);
  const read = ((await listAs("buyer", market.buyer.cookie)).json as { proposals: Json[]; pendingCount: number });
  assert.equal(read.proposals[0].status, "expired", "échue : lue « expirée » sans balayage");
  assert.equal(read.pendingCount, 0);
  const refusedAccept = await act(first, "accept", market.buyer.cookie);
  assert.equal(refusedAccept.status, 409);
  assert.equal((refusedAccept.json as { error: { code: string } }).error.code, "proposal_expired");
  assert.equal(await count(env.pool, "orders"), 0);
  assert.equal((await propose(market, body(market, { priceXof: 230_000 }))).status, 201, "l'échue est remplacée");
  assert.equal((await env.pool.query("SELECT status FROM seller_proposals WHERE id = $1", [first])).rows[0].status, "expired", "l'échue est écrite « expirée » sous verrou");
});

test("accepter : la commande est créée dans la même transaction (prix figé, quantité 1, « proposée »), rejouable (même commande), refus ensuite impossible", async () => {
  const sent = (await propose(market, body(market))).json as { proposal: Json };
  const id = String(sent.proposal.id);
  assert.equal((await act(id, "accept", market.seller.cookie)).status, 404, "le vendeur n'accepte pas sa propre proposition");
  assert.equal((await act(id, "accept", stranger.cookie)).status, 404);
  assert.equal((await act(id, "accept", market.buyer.cookie, "https://autre.test")).status, 403);
  assert.equal(await count(env.pool, "orders"), 0);
  const accepted = await act(id, "accept", market.buyer.cookie);
  assert.equal(accepted.status, 200);
  const result = accepted.json as { proposal: Json; orderId: string; replayed: boolean };
  assert.equal(result.replayed, false);
  assert.equal(result.proposal.status, "accepted");
  assert.equal(result.proposal.orderId, result.orderId);
  const order = (await env.pool.query("SELECT buyer_id, seller_id, price_amount::int AS price, quantity, status, demand_id, offer_id FROM orders")).rows;
  assert.equal(order.length, 1);
  assert.deepEqual([order[0].buyer_id, order[0].seller_id, order[0].price, order[0].quantity, order[0].status], [market.buyer.userId, market.seller.userId, 240_000, 1, "proposed"]);
  const replay = await act(id, "accept", market.buyer.cookie);
  assert.equal(replay.status, 200);
  assert.deepEqual([(replay.json as { orderId: string }).orderId, (replay.json as { replayed: boolean }).replayed], [result.orderId, true]);
  assert.equal(await count(env.pool, "orders"), 1);
  for (const action of ["decline", "withdraw"]) {
    const refused = await act(id, action, action === "decline" ? market.buyer.cookie : market.seller.cookie);
    assert.equal(refused.status, 409, action);
    assert.equal((refused.json as { error: { code: string } }).error.code, "proposal_not_open");
  }
});

test("acceptation refusée quand une commande est déjà active pour le couple : le code de la commande passe tel quel, la proposition reste « envoyée », rien n'est écrit", async () => {
  const sent = (await propose(market, body(market))).json as { proposal: Json };
  await env.pool.query("INSERT INTO orders (demand_id, offer_id, buyer_id, seller_id, price_amount) VALUES ($1, $2, $3, $4, 200000)", [market.demand.id, market.offer.id, market.buyer.userId, market.seller.userId]);
  const refused = await act(String(sent.proposal.id), "accept", market.buyer.cookie);
  assert.equal(refused.status, 409);
  assert.equal((refused.json as { error: { code: string } }).error.code, "order_active_exists");
  assert.equal((await env.pool.query("SELECT status, order_id FROM seller_proposals")).rows[0].status, "sent");
  assert.equal(await count(env.pool, "orders"), 1);
});

test("acceptation concurrente (double clic ×6) : UNE seule commande, toutes les réponses 200 avec la même commande ; retrait contre acceptation : un seul gagne, état cohérent", async () => {
  const sent = (await propose(market, body(market))).json as { proposal: Json };
  const id = String(sent.proposal.id);
  const results = await Promise.all(Array.from({ length: 6 }, () => act(id, "accept", market.buyer.cookie)));
  assert.deepEqual(results.map((result) => result.status), [200, 200, 200, 200, 200, 200]);
  assert.equal(new Set(results.map((result) => (result.json as { orderId: string }).orderId)).size, 1);
  assert.equal(results.filter((result) => (result.json as { replayed: boolean }).replayed === false).length, 1);
  assert.equal(await count(env.pool, "orders"), 1);

  await reset();
  market = await makeMarket(env.pool);
  const second = (await propose(market, body(market))).json as { proposal: Json };
  const secondId = String(second.proposal.id);
  const [accepted, withdrawn] = await Promise.all([act(secondId, "accept", market.buyer.cookie), act(secondId, "withdraw", market.seller.cookie)]);
  const final = (await env.pool.query("SELECT status FROM seller_proposals WHERE id = $1", [secondId])).rows[0].status;
  const orders = await count(env.pool, "orders");
  if (final === "accepted") {
    assert.equal(accepted.status, 200);
    assert.equal(withdrawn.status, 409);
    assert.equal(orders, 1);
  } else {
    assert.equal(final, "withdrawn");
    assert.equal(withdrawn.status, 200);
    assert.equal(accepted.status, 409);
    assert.equal(orders, 0, "jamais de commande pour une proposition retirée");
  }
});

test("refus : définitif pour cette annonce et ce besoin (409 proposal_declined), rejouable ; une autre annonce du vendeur peut encore proposer ; le retrait libère le couple", async () => {
  const sent = (await propose(market, body(market))).json as { proposal: Json };
  const id = String(sent.proposal.id);
  assert.equal((await act(id, "decline", market.seller.cookie)).status, 404, "le vendeur ne refuse pas sa propre proposition");
  assert.equal((await act(id, "decline", market.buyer.cookie)).status, 200);
  assert.equal((await act(id, "decline", market.buyer.cookie)).status, 200, "rejoué : sans effet");
  const again = await propose(market, body(market, { priceXof: 100_000 }));
  assert.equal(again.status, 409);
  assert.equal((again.json as { error: { code: string } }).error.code, "proposal_declined");
  const flagged = (await requests(market.seller.cookie)).json as { requests: Array<{ offers: Array<{ declined: boolean }> }> };
  assert.equal(flagged.requests[0].offers[0].declined, true);
  const other = await makeOffer(env.pool, market.seller.userId);
  await makeMatch(env.pool, other, market.demand);
  assert.equal((await propose(market, body(market, { offerId: other.id }))).status, 201, "une AUTRE annonce du vendeur peut encore proposer");
  const withdrawnId = await proposalId();
  assert.equal((await act(withdrawnId, "withdraw", market.buyer.cookie)).status, 404, "l'acheteur ne retire pas");
  assert.equal((await act(withdrawnId, "withdraw", market.seller.cookie)).status, 200);
  assert.equal((await propose(market, body(market, { offerId: other.id }))).status, 201, "après un retrait, le couple est libre");
});

test(`limites : ${PROPOSALS_NEED_OPEN_LIMIT} propositions en attente par besoin, ${PROPOSALS_DAILY_LIMIT} par vendeur et par jour (429), exactes`, async () => {
  const offers = [];
  for (let index = 0; index < PROPOSALS_NEED_OPEN_LIMIT; index += 1) offers.push(await makeOffer(env.pool, market.seller.userId));
  for (const offer of offers) {
    await env.pool.query(
      "INSERT INTO seller_proposals (demand_id, offer_id, seller_id, buyer_id, price_amount, valid_until) VALUES ($1, $2, $3, $4, 1000, clock_timestamp() + interval '7 days')",
      [market.demand.id, offer.id, market.seller.userId, market.buyer.userId],
    );
  }
  const refused = await propose(market, body(market));
  assert.equal(refused.status, 409);
  assert.equal((refused.json as { error: { code: string } }).error.code, "proposals_need_limit");
  await reset();
  market = await makeMarket(env.pool);
  const demands = [];
  for (let index = 0; index < PROPOSALS_DAILY_LIMIT; index += 1) {
    const demand = await makeDemand(env.pool, market.buyer.userId);
    await makeMatch(env.pool, market.offer, demand);
    demands.push(demand);
    await env.pool.query(
      "INSERT INTO seller_proposals (demand_id, offer_id, seller_id, buyer_id, price_amount, valid_until) VALUES ($1, $2, $3, $4, 1000, clock_timestamp() + interval '7 days')",
      [demand.id, market.offer.id, market.seller.userId, market.buyer.userId],
    );
  }
  const limited = await propose(market, body(market));
  assert.equal(limited.status, 429);
  assert.equal((limited.json as { error: { code: string } }).error.code, "proposals_daily_limit");
});

test("base : les éléments d'une proposition et ses lignes ne changent jamais, une proposition décidée ne bouge plus, aucune suppression ; « acceptée » exige non échue, « expirée » exige échue", async () => {
  const sent = (await propose(market, { offerId: market.offer.id, lines: [{ label: "Pièces", amountXof: 5_000 }] })).json as { proposal: Json };
  const id = String(sent.proposal.id);
  for (const sql of ["UPDATE seller_proposals SET price_amount = 1", "UPDATE seller_proposals SET note_text = 'x'", "UPDATE seller_proposals SET valid_until = valid_until + interval '1 day'", "UPDATE seller_proposals SET buyer_id = seller_id"]) {
    await assert.rejects(() => env.pool.query(sql), /seller_proposals_immutable|chk_seller_proposals_parties/, sql);
  }
  await assert.rejects(() => env.pool.query("DELETE FROM seller_proposals"), /seller_proposals_immutable/);
  await assert.rejects(() => env.pool.query("UPDATE seller_proposal_lines SET amount_xof = 1"), /seller_proposals_immutable/);
  await assert.rejects(() => env.pool.query("DELETE FROM seller_proposal_lines"), /seller_proposals_immutable/);
  await assert.rejects(() => env.pool.query("UPDATE seller_proposals SET status = 'expired', decided_at = clock_timestamp() WHERE id = $1", [id]), /seller_proposals_not_expired/);
  await assert.rejects(() => env.pool.query("UPDATE seller_proposals SET status = 'declined'"), /chk_seller_proposals_decided/, "une décision écrit sa date");
  await expire(id);
  await assert.rejects(
    () => env.pool.query("INSERT INTO orders (demand_id, offer_id, buyer_id, seller_id, price_amount) VALUES ($1, $2, $3, $4, 5000)", [market.demand.id, market.offer.id, market.buyer.userId, market.seller.userId]).then(async (r) => {
      const order = await env.pool.query<{ id: string }>("SELECT id FROM orders LIMIT 1");
      return env.pool.query("UPDATE seller_proposals SET status = 'accepted', order_id = $2, decided_at = clock_timestamp() WHERE id = $1", [id, order.rows[0].id]).then(() => r);
    }),
    /seller_proposals_expired/,
  );
  await env.pool.query("UPDATE seller_proposals SET status = 'expired', decided_at = clock_timestamp() WHERE id = $1", [id]);
  await assert.rejects(() => env.pool.query("UPDATE seller_proposals SET status = 'withdrawn' WHERE id = $1", [id]), /seller_proposals_decided/);
});
