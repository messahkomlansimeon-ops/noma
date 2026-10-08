import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { MISSION_SELLERS_MAX } from "../../lib/missions-rules";
import { runMissionsStep } from "../../lib/server/missions/step";
import { makeMarket } from "./social-fixtures";
import {
  TOTAL_BUDGET, UNIT_BUDGET, actMissionCall, addCandidate, ageClosedMission, count, createMissionCall, errorCode, login, makeHandlers, missionOf, openTestSchema, orderOf, proposalCall, proposalOf,
  readMissionCall, reply, request, resetSocial, startMission, type Candidate, type Handlers, type Login, type LiveMission, type TestSchema,
} from "./missions-fixtures";

/**
 * Missions d'achat en volume (lot MV1) : proposition de répartition (budgets, stocks, 10 vendeurs, vendeurs anonymes, lecture seule), achats rattachés à la mission
 * (quantité, limites, quantité SÉCURISÉE = commandes confirmées, achèvement), concurrence, annulation.
 */

let env: TestSchema;
let h: Handlers;
let buyer: Login;

before(async () => {
  env = await openTestSchema(12);
  h = makeHandlers(env.pool);
});

after(async () => {
  await env.close();
});

beforeEach(async () => {
  await resetSocial(env.pool);
  buyer = await login(env.pool);
});

type Json = Record<string, unknown>;
const linesOf = (answer: { json: unknown }): Json[] => (proposalOf(answer as never).lines as Json[]);
const person = (seller: Login) => ({ id: seller.userId, phone: seller.phone });

const declareCall = async (live: LiveMission, candidate: Candidate, body: Json, cookie: string | null = buyer.cookie, origin?: string | null) =>
  reply(await h.social.orders.declare(request("POST", `/api/demands/${live.demandId}/offers/${candidate.offer.id}/orders`, { cookie, body, origin }), live.demandId, candidate.offer.id));
const actOrder = async (orderId: string, action: string, cookie: string | null) =>
  reply(await h.social.orders.act(request("POST", `/api/orders/${orderId}/${action}`, { cookie, body: {} }), orderId, action));
const mission = async (live: LiveMission): Promise<Json> => missionOf(await readMissionCall(h, buyer.cookie, live.id));

async function sellerWith(live: LiveMission, options: Parameters<typeof addCandidate>[2] = {}): Promise<{ seller: Login; candidate: Candidate }> {
  const seller = await login(env.pool);
  const candidate = await addCandidate(env.pool, live, { ...options, seller: person(seller) });
  return { seller, candidate };
}

describe("proposition de répartition", () => {
  test("lignes (annonce, vendeur anonyme, quantité, prix, sous-total), couverture, budget utilisé ; annonces sans prix ou au-dessus du budget par unité écartées", async () => {
    const live = await startMission(env.pool, h, buyer, { quantity: 6 });
    const a = await addCandidate(env.pool, live, { price: 160_000, quantity: 2, score: 95 });
    const b = await addCandidate(env.pool, live, { price: 150_000, quantity: 1, score: 90 });
    const c = await addCandidate(env.pool, live, { price: 140_000, quantity: null, score: 85 });
    const d = await addCandidate(env.pool, live, { price: 170_000, quantity: 2, score: 80 });
    await addCandidate(env.pool, live, { price: 200_000, quantity: 5, score: 99 });
    await addCandidate(env.pool, live, { price: null, quantity: 5, score: 99 });
    const answer = await proposalCall(h, buyer.cookie, live.id);
    assert.equal(answer.status, 200, answer.text);
    assert.equal((answer.json as Json).contractVersion, "missions/v1");
    const proposal = proposalOf(answer);
    assert.equal(proposal.state, "ready");
    const lines = linesOf(answer);
    const byOffer = new Map(lines.map((line) => [line.offerId as string, line]));
    assert.deepEqual([...byOffer.keys()].sort(), [a, b, c, d].map((entry) => entry.offer.id).sort(), "les annonces à 200 000 (au-dessus du budget par unité) et sans prix sont écartées");
    assert.deepEqual([byOffer.get(a.offer.id)?.quantity, byOffer.get(b.offer.id)?.quantity, byOffer.get(c.offer.id)?.quantity, byOffer.get(d.offer.id)?.quantity], [2, 1, 1, 2]);
    assert.equal(byOffer.get(c.offer.id)?.stock, 1, "quantité non renseignée : 1");
    for (const line of lines) assert.equal(line.subtotalXof, (line.quantity as number) * (line.unitPriceXof as number));
    assert.equal(proposal.coveredQuantity, 6);
    assert.equal(proposal.requestedQuantity, 6);
    assert.equal(proposal.coveragePercent, 100);
    assert.equal(proposal.budgetUsedXof, 2 * 160_000 + 150_000 + 140_000 + 2 * 170_000);
    assert.equal(proposal.budgetRemainingXof, TOTAL_BUDGET - (proposal.budgetUsedXof as number));
    assert.equal(proposal.totalBudgetXof, TOTAL_BUDGET);
    assert.equal(proposal.unitBudgetXof, UNIT_BUDGET);
    assert.equal(proposal.sellerCount, 4);
    assert.deepEqual(proposal.reasons, []);
    // Vendeurs anonymes : « Vendeur 1 » à « Vendeur 4 », aucun identifiant ni numéro.
    assert.deepEqual(lines.map((line) => line.vendor), ["Vendeur 1", "Vendeur 2", "Vendeur 3", "Vendeur 4"]);
    for (const entry of [a, b, c, d]) {
      assert.ok(!answer.text.includes(entry.seller.id), "aucun identifiant de vendeur");
      assert.ok(!answer.text.includes(entry.seller.phone ?? "???"), "aucun numéro de vendeur");
    }
    assert.deepEqual(Object.keys(lines[0]).sort(), ["location", "offerId", "quantity", "stock", "subtotalXof", "title", "unitPriceXof", "vendor"]);
    assert.ok(!/ownerId|owner_id|sellerId|userId|phone_e164|\+225/.test(answer.text));
  });

  test("ordre de remplissage : la plus grande pertinence d'abord", async () => {
    const live = await startMission(env.pool, h, buyer, { quantity: 2 });
    const best = await addCandidate(env.pool, live, { price: 160_000, quantity: 1, score: 99 });
    await addCandidate(env.pool, live, { price: 150_000, quantity: 1, score: 30 });
    const lines = linesOf(await proposalCall(h, buyer.cookie, live.id));
    assert.equal(lines[0].offerId, best.offer.id);
    assert.equal(lines[0].vendor, "Vendeur 1");
    assert.equal(lines.length, 2);
  });

  test("quantité plus grande que le stock : couverture partielle et raisons (pas assez d'annonces, budget par unité trop bas)", async () => {
    const live = await startMission(env.pool, h, buyer, { quantity: 10 });
    await addCandidate(env.pool, live, { price: 150_000, quantity: 3 });
    await addCandidate(env.pool, live, { price: 160_000, quantity: 1 });
    await addCandidate(env.pool, live, { price: 190_000, quantity: 9 });
    const proposal = proposalOf(await proposalCall(h, buyer.cookie, live.id));
    assert.equal(proposal.coveredQuantity, 4);
    assert.equal(proposal.coveragePercent, 40);
    assert.deepEqual((proposal.reasons as Json[]).map((reason) => reason.code), ["not_enough_offers", "unit_budget_too_low"]);
    for (const reason of proposal.reasons as Json[]) assert.ok(typeof reason.text === "string" && (reason.text as string).length > 10);
  });

  test("budget total : la répartition s'arrête à ce que le budget permet et le dit", async () => {
    const live = await startMission(env.pool, h, buyer, { quantity: 6, unitBudgetXof: 160_000, totalBudgetXof: 400_000 });
    await addCandidate(env.pool, live, { price: 150_000, quantity: 6 });
    const proposal = proposalOf(await proposalCall(h, buyer.cookie, live.id));
    assert.equal(proposal.coveredQuantity, 2);
    assert.equal(proposal.budgetUsedXof, 300_000);
    assert.equal(proposal.budgetRemainingXof, 100_000);
    assert.deepEqual((proposal.reasons as Json[]).map((reason) => reason.code), ["total_budget_too_low"]);
  });

  test("au plus 10 vendeurs par proposition, même avec douze vendeurs prêts", async () => {
    const live = await startMission(env.pool, h, buyer, { quantity: 24, totalBudgetXof: 50_000_000 });
    for (let index = 0; index < MISSION_SELLERS_MAX + 2; index += 1) await addCandidate(env.pool, live, { price: 100_000, quantity: 2, score: 90 - index });
    const answer = await proposalCall(h, buyer.cookie, live.id);
    const proposal = proposalOf(answer);
    assert.equal(proposal.sellerCount, MISSION_SELLERS_MAX);
    assert.equal(linesOf(answer).length, MISSION_SELLERS_MAX);
    assert.equal(proposal.coveredQuantity, 20);
    assert.deepEqual((proposal.reasons as Json[]).map((reason) => reason.code), ["seller_limit"]);
    assert.equal(proposal.candidateCount, 12);
  });

  test("deux annonces d'un même vendeur comptent pour un seul vendeur (même étiquette)", async () => {
    const live = await startMission(env.pool, h, buyer, { quantity: 3 });
    const first = await addCandidate(env.pool, live, { price: 150_000, quantity: 1, score: 95 });
    await addCandidate(env.pool, live, { price: 151_000, quantity: 2, score: 90, seller: first.seller });
    const answer = await proposalCall(h, buyer.cookie, live.id);
    assert.deepEqual(linesOf(answer).map((line) => line.vendor), ["Vendeur 1", "Vendeur 1"]);
    assert.equal(proposalOf(answer).sellerCount, 1);
  });

  test("une annonce retirée, en pause ou d'un vendeur suspendu n'est plus proposée", async () => {
    const live = await startMission(env.pool, h, buyer, { quantity: 4 });
    const paused = await addCandidate(env.pool, live, { quantity: 1 });
    const unavailable = await addCandidate(env.pool, live, { quantity: 1 });
    const suspended = await addCandidate(env.pool, live, { quantity: 1 });
    const kept = await addCandidate(env.pool, live, { quantity: 1 });
    await env.pool.query("UPDATE offers SET status = 'paused' WHERE id = $1", [paused.offer.id]);
    await env.pool.query("UPDATE offers SET availability_status = 'unavailable' WHERE id = $1", [unavailable.offer.id]);
    await env.pool.query("UPDATE users SET status = 'suspended' WHERE id = $1", [suspended.seller.id]);
    assert.deepEqual(linesOf(await proposalCall(h, buyer.cookie, live.id)).map((line) => line.offerId), [kept.offer.id]);
  });

  test("mission en pause : proposition encore lisible ; brouillon, terminée, annulée : état « inactive », aucune ligne", async () => {
    const live = await startMission(env.pool, h, buyer, { quantity: 2 });
    await addCandidate(env.pool, live, { quantity: 2 });
    await actMissionCall(h, buyer.cookie, live.id, "pause");
    assert.equal(proposalOf(await proposalCall(h, buyer.cookie, live.id)).state, "ready");
    assert.equal(linesOf(await proposalCall(h, buyer.cookie, live.id)).length, 1);
    await actMissionCall(h, buyer.cookie, live.id, "cancel");
    const cancelled = proposalOf(await proposalCall(h, buyer.cookie, live.id));
    assert.deepEqual([cancelled.state, (cancelled.lines as unknown[]).length, cancelled.coveredQuantity], ["inactive", 0, 0]);
    const draft = missionOf(await createMissionCall(h, buyer.cookie)).id as string;
    assert.equal(proposalOf(await proposalCall(h, buyer.cookie, draft)).state, "inactive");
  });

  test("LECTURE SEULE : ni message, ni conversation, ni commande, ni notification, ni événement du matching n'est jamais créé par une mission (lancement, proposition, relecture, conversation ouverte)", async () => {
    const tables = ["messages", "conversations", "orders", "notifications", "favorites", "offer_contacts"];
    const snapshot = async () => Promise.all(tables.map((table) => count(env.pool, table)));
    const live = await startMission(env.pool, h, buyer, { quantity: 4 });
    const { candidate } = await sellerWith(live, { quantity: 4 });
    const before = await snapshot();
    const events = await count(env.pool, "matching_outbox_events");
    for (let index = 0; index < 3; index += 1) await proposalCall(h, buyer.cookie, live.id);
    await readMissionCall(h, buyer.cookie, live.id);
    assert.deepEqual(await snapshot(), before);
    assert.equal(await count(env.pool, "matching_outbox_events"), events);
    // « Écrire » ouvre la conversation (le vendeur ne la voit pas encore) : toujours aucun message, aucune commande.
    const opened = await reply(await h.social.conversations.open(request("POST", `/api/demands/${live.demandId}/offers/${candidate.offer.id}/conversation`, { cookie: buyer.cookie, body: {} }), live.demandId, candidate.offer.id));
    assert.equal(opened.status, 201, opened.text);
    assert.equal(await count(env.pool, "conversations"), 1);
    assert.equal(await count(env.pool, "messages"), 0, "aucun message n'est envoyé sans l'action de l'acheteur");
    assert.equal(await count(env.pool, "orders"), 0, "aucune commande n'est créée sans l'action de l'acheteur");
    assert.equal(await count(env.pool, "notifications"), 0);
  });

  test("un achat déjà en cours est affiché à part (déclaré, puis confirmé) et n'est plus une ligne de la proposition", async () => {
    const live = await startMission(env.pool, h, buyer, { quantity: 4 });
    const { seller, candidate } = await sellerWith(live, { quantity: 4 });
    const order = orderOf(await declareCall(live, candidate, { priceXof: 150_000, quantity: 2 }));
    const engagedOf = async (): Promise<Json[]> => proposalOf(await proposalCall(h, buyer.cookie, live.id)).engaged as Json[];
    let engaged = await engagedOf();
    assert.deepEqual(engaged.map((entry) => [entry.orderId, entry.status, entry.quantity, entry.vendor, entry.offerId]), [[order.id, "proposed", 2, "Vendeur 1", candidate.offer.id]]);
    assert.deepEqual(linesOf(await proposalCall(h, buyer.cookie, live.id)), [], "l'annonce déjà commandée n'est pas proposée une seconde fois");
    await actOrder(order.id as string, "confirm", seller.cookie);
    engaged = await engagedOf();
    assert.deepEqual(engaged.map((entry) => [entry.orderId, entry.status, entry.quantity]), [[order.id, "confirmed", 2]]);
  });

  test("paramètre de requête inattendu : 400 ; mission d'autrui : 404", async () => {
    const live = await startMission(env.pool, h, buyer);
    assert.equal((await reply(await h.missions.proposal(request("GET", `/api/missions/${live.id}/proposal`, { cookie: buyer.cookie, query: "?limit=3" }), live.id))).status, 400);
    const other = await login(env.pool);
    assert.equal((await proposalCall(h, other.cookie, live.id)).status, 404);
  });
});

describe("achats rattachés à la mission", () => {
  test("une déclaration sur le besoin porteur est rattachée à la mission, avec sa quantité (1 par défaut) ; le vendeur ne voit jamais la mission", async () => {
    const live = await startMission(env.pool, h, buyer, { quantity: 6 });
    const first = await sellerWith(live, { quantity: 3 });
    const second = await sellerWith(live, { quantity: 3 });
    const withQuantity = await declareCall(live, first.candidate, { priceXof: 150_000, quantity: 3 });
    assert.equal(withQuantity.status, 201, withQuantity.text);
    const order = orderOf(withQuantity);
    assert.equal(order.quantity, 3);
    assert.equal(order.missionId, live.id);
    assert.deepEqual(order.price, { amount: 150_000, currency: "XOF" });
    const byDefault = orderOf(await declareCall(live, second.candidate, { priceXof: 140_000 }));
    assert.equal(byDefault.quantity, 1);
    assert.equal(byDefault.missionId, live.id);
    const rows = await env.pool.query<{ quantity: number; mission_id: string; status: string }>("SELECT quantity, mission_id, status FROM orders ORDER BY quantity DESC");
    assert.deepEqual(rows.rows.map((row) => [row.quantity, row.mission_id, row.status]), [[3, live.id, "proposed"], [1, live.id, "proposed"]]);
    // Vue du vendeur : la quantité demandée, jamais la mission.
    const sellerView = orderOf(await reply(await h.social.orders.get(request("GET", `/api/orders/${order.id}`, { cookie: first.seller.cookie }), order.id as string)));
    assert.equal(sellerView.quantity, 3);
    assert.equal(Object.hasOwn(sellerView, "missionId"), false, "le vendeur ne reçoit même pas le champ");
    assert.equal(sellerView.demandId, null);
    const detail = await mission(live);
    assert.deepEqual([detail.securedQuantity, detail.pendingQuantity, detail.committedXof], [0, 4, 3 * 150_000 + 140_000]);
  });

  test("quantité refusée : 0, négative, décimale, texte, trop grande, nulle, tableau ; rien n'est écrit", async () => {
    const live = await startMission(env.pool, h, buyer, { quantity: 6 });
    const { candidate } = await sellerWith(live, { quantity: 6 });
    for (const quantity of [0, -1, -3, 1.5, "3", 10_001, null, true, [2], Number.MAX_SAFE_INTEGER + 1]) {
      const answer = await declareCall(live, candidate, { priceXof: 150_000, quantity });
      assert.equal(answer.status, 400, JSON.stringify(quantity));
      assert.equal(errorCode(answer), "invalid_quantity");
    }
    assert.equal(await count(env.pool, "orders"), 0);
    // La base refuse aussi une quantité négative ou nulle posée à la main.
    await assert.rejects(
      () => env.pool.query("INSERT INTO orders (demand_id, offer_id, buyer_id, seller_id, price_amount, quantity) VALUES ($1, $2, $3, $4, 100, -2)", [live.demandId, candidate.offer.id, buyer.userId, candidate.seller.id]),
      /orders_quantity_check/,
    );
    await assert.rejects(
      () => env.pool.query("INSERT INTO orders (demand_id, offer_id, buyer_id, seller_id, price_amount, quantity) VALUES ($1, $2, $3, $4, 100, 0)", [live.demandId, candidate.offer.id, buyer.userId, candidate.seller.id]),
      /orders_quantity_check/,
    );
  });

  test("limites de la mission : prix au-dessus du budget par unité, quantité au-delà de ce qu'il reste, budget total, mission non active", async () => {
    const live = await startMission(env.pool, h, buyer, { quantity: 6, unitBudgetXof: 160_000, totalBudgetXof: 700_000 });
    const a = await sellerWith(live, { quantity: 6 });
    const b = await sellerWith(live, { quantity: 6 });
    const c = await sellerWith(live, { quantity: 6 });
    const over = await declareCall(live, a.candidate, { priceXof: 160_001, quantity: 1 });
    assert.equal(over.status, 409);
    assert.equal(errorCode(over), "mission_price_over_budget");
    assert.equal(await count(env.pool, "orders"), 0);
    assert.equal((await declareCall(live, a.candidate, { priceXof: 160_000, quantity: 4 })).status, 201);
    const tooMany = await declareCall(live, b.candidate, { priceXof: 100_000, quantity: 3 });
    assert.equal(tooMany.status, 409, "4 + 3 > 6");
    assert.equal(errorCode(tooMany), "mission_quantity_exceeded");
    const tooExpensive = await declareCall(live, b.candidate, { priceXof: 160_000, quantity: 2 });
    assert.equal(tooExpensive.status, 409, "640 000 + 320 000 > 700 000");
    assert.equal(errorCode(tooExpensive), "mission_budget_exceeded");
    assert.equal((await declareCall(live, b.candidate, { priceXof: 30_000, quantity: 2 })).status, 201);
    assert.equal(await count(env.pool, "orders"), 2);
    // Mission en pause ou annulée : plus d'achat.
    await actMissionCall(h, buyer.cookie, live.id, "pause");
    const paused = await declareCall(live, c.candidate, { priceXof: 100, quantity: 1 });
    assert.equal(paused.status, 409);
    assert.equal(errorCode(paused), "mission_not_active");
    await actMissionCall(h, buyer.cookie, live.id, "cancel");
    // Annulée : plus d'achat. Le besoin porteur reste actif 24 h (aucune différence visible côté vendeur) : le refus vient de la mission.
    const cancelled = await declareCall(live, c.candidate, { priceXof: 100, quantity: 1 });
    assert.equal(cancelled.status, 409);
    assert.equal(errorCode(cancelled), "mission_not_active");
    // 24 h plus tard le besoin porteur est archivé : l'annonce n'est plus une correspondance de ce besoin (404 indiscernable, comme pour tout besoin clos).
    await ageClosedMission(env.pool, live.id, 25);
    await runMissionsStep({ pool: env.pool });
    assert.equal((await declareCall(live, c.candidate, { priceXof: 100, quantity: 1 })).status, 404);
    assert.equal(await count(env.pool, "orders", "status = 'proposed'"), 0, "annuler la mission a annulé les achats proposés");
  });

  test("hors mission, une quantité est possible (1 à 10 000) et rien n'est rattaché ; le prix reste celui de la commande", async () => {
    const market = await makeMarket(env.pool);
    const answer = await reply(await h.social.orders.declare(request("POST", `/api/demands/${market.demand.id}/offers/${market.offer.id}/orders`, { cookie: market.buyer.cookie, body: { priceXof: 230_000, quantity: 3 } }), market.demand.id, market.offer.id));
    assert.equal(answer.status, 201, answer.text);
    assert.equal(orderOf(answer).quantity, 3);
    assert.equal(orderOf(answer).missionId, null);
    assert.equal(await count(env.pool, "orders", "mission_id IS NOT NULL"), 0);
  });

  test("quantité sécurisée = somme des commandes CONFIRMÉES seulement ; proposées, refusées et annulées ne comptent pas ; rien n'est compté deux fois", async () => {
    const live = await startMission(env.pool, h, buyer, { quantity: 20, totalBudgetXof: 20_000_000 });
    const sellers = [await sellerWith(live, { quantity: 10 }), await sellerWith(live, { quantity: 10 }), await sellerWith(live, { quantity: 10 }), await sellerWith(live, { quantity: 10 })];
    const orders: string[] = [];
    for (const [index, quantity] of [3, 4, 5, 2].entries()) orders.push(orderOf(await declareCall(live, sellers[index].candidate, { priceXof: 100_000, quantity })).id as string);
    let detail = await mission(live);
    assert.deepEqual([detail.securedQuantity, detail.pendingQuantity], [0, 14], "des commandes proposées ne sont pas sécurisées");
    await actOrder(orders[0], "confirm", sellers[0].seller.cookie);
    detail = await mission(live);
    assert.deepEqual([detail.securedQuantity, detail.pendingQuantity], [3, 11]);
    await actOrder(orders[1], "decline", sellers[1].seller.cookie);
    await actOrder(orders[2], "cancel", buyer.cookie);
    detail = await mission(live);
    assert.deepEqual([detail.securedQuantity, detail.pendingQuantity, detail.committedXof], [3, 2, 5 * 100_000]);
    await actOrder(orders[3], "confirm", sellers[3].seller.cookie);
    detail = await mission(live);
    assert.deepEqual([detail.securedQuantity, detail.pendingQuantity, detail.status], [5, 0, "active"]);
    const list = (await readMissionCall(h, buyer.cookie, live.id)).json as { orders: Json[] };
    assert.deepEqual(list.orders.map((order) => [order.quantity, order.status]).sort(), [[2, "confirmed"], [3, "confirmed"], [4, "declined"], [5, "cancelled"]]);
    // La liste « Mes missions » donne la même quantité sécurisée.
    const summary = ((await reply(await h.missions.list(request("GET", "/api/missions", { cookie: buyer.cookie })))).json as { missions: Json[] }).missions[0];
    assert.equal(summary.securedQuantity, 5);
  });

  test("à la quantité totale confirmée, la mission passe à « terminée » : besoin porteur archivé 24 h plus tard, plus d'achat possible, aucun besoin à clore à la main", async () => {
    const live = await startMission(env.pool, h, buyer, { quantity: 6 });
    const a = await sellerWith(live, { quantity: 4 });
    const b = await sellerWith(live, { quantity: 4 });
    const first = orderOf(await declareCall(live, a.candidate, { priceXof: 150_000, quantity: 4 }));
    const second = orderOf(await declareCall(live, b.candidate, { priceXof: 150_000, quantity: 2 }));
    assert.equal(first.canMarkDemandSatisfied, false);
    await actOrder(first.id as string, "confirm", a.seller.cookie);
    assert.equal((await mission(live)).status, "active", "4 sur 6 : pas encore");
    const confirmed = await actOrder(second.id as string, "confirm", b.seller.cookie);
    assert.equal(confirmed.status, 200);
    assert.equal(orderOf(confirmed).canMarkDemandSatisfied, false, "le seul besoin ne se clôt pas à la main : la mission se termine d'elle-même");
    const done = await mission(live);
    assert.deepEqual([done.status, done.securedQuantity, done.pendingQuantity], ["completed", 6, 0]);
    assert.notEqual(done.closedAt, null);
    const demand = await env.pool.query<{ status: string }>("SELECT status FROM demands WHERE id = $1", [live.demandId]);
    assert.equal(demand.rows[0].status, "active", "le besoin porteur n'est pas archivé à l'instant de la fin : le vendeur ne le devine pas");
    const c = await sellerWith(live, { quantity: 4 });
    const late = await declareCall(live, c.candidate, { priceXof: 100_000, quantity: 1 });
    assert.equal(late.status, 409, "mission terminée : plus d'achat");
    assert.equal(errorCode(late), "mission_not_active");
    await ageClosedMission(env.pool, live.id, 25);
    await runMissionsStep({ pool: env.pool });
    assert.equal((await env.pool.query<{ status: string }>("SELECT status FROM demands WHERE id = $1", [live.demandId])).rows[0].status, "archived", "24 h après la fin, l'étape archive le besoin porteur");
    assert.equal((await declareCall(live, c.candidate, { priceXof: 100_000, quantity: 1 })).status, 404, "besoin porteur clos : 404 indiscernable");
    assert.equal(errorCode(await actMissionCall(h, buyer.cookie, live.id, "cancel")), "mission_state_conflict");
  });

  test("annuler la mission annule les achats proposés et garde les achats confirmés", async () => {
    const live = await startMission(env.pool, h, buyer, { quantity: 6 });
    const a = await sellerWith(live, { quantity: 3 });
    const b = await sellerWith(live, { quantity: 3 });
    const confirmedOrder = orderOf(await declareCall(live, a.candidate, { priceXof: 150_000, quantity: 2 }));
    const proposedOrder = orderOf(await declareCall(live, b.candidate, { priceXof: 150_000, quantity: 3 }));
    await actOrder(confirmedOrder.id as string, "confirm", a.seller.cookie);
    assert.equal((await actMissionCall(h, buyer.cookie, live.id, "cancel")).status, 200);
    const rows = await env.pool.query<{ id: string; status: string }>("SELECT id, status FROM orders");
    const statusOf = (id: unknown) => rows.rows.find((row) => row.id === id)?.status;
    assert.equal(statusOf(confirmedOrder.id), "confirmed");
    assert.equal(statusOf(proposedOrder.id), "cancelled");
    const late = await actOrder(proposedOrder.id as string, "confirm", b.seller.cookie);
    assert.equal(late.status, 409, "le vendeur ne peut plus confirmer un achat annulé");
    assert.deepEqual([(await mission(live)).status, (await mission(live)).securedQuantity], ["cancelled", 2]);
  });

  test("règles de transition des commandes inchangées : acheteur ne confirme pas, vendeur n'annule pas, décision définitive, quantité et mission immuables en base", async () => {
    const live = await startMission(env.pool, h, buyer, { quantity: 6 });
    const a = await sellerWith(live, { quantity: 6 });
    const order = orderOf(await declareCall(live, a.candidate, { priceXof: 150_000, quantity: 2 }));
    assert.equal((await actOrder(order.id as string, "confirm", buyer.cookie)).status, 403);
    assert.equal((await actOrder(order.id as string, "cancel", a.seller.cookie)).status, 403);
    assert.equal((await declareCall(live, a.candidate, { priceXof: 140_000, quantity: 1 })).status, 409, "une seule commande active par (besoin, annonce)");
    await assert.rejects(() => env.pool.query("UPDATE orders SET quantity = 5 WHERE id = $1", [order.id]), /order_immutable/);
    await assert.rejects(() => env.pool.query("UPDATE orders SET mission_id = NULL WHERE id = $1", [order.id]), /order_immutable/);
    assert.equal((await actOrder(order.id as string, "confirm", a.seller.cookie)).status, 200);
    assert.equal((await actOrder(order.id as string, "decline", a.seller.cookie)).status, 409);
    await assert.rejects(() => env.pool.query("UPDATE orders SET status = 'declined' WHERE id = $1", [order.id]), /order_final/);
    // Une commande ne peut se rattacher qu'à la mission de son acheteur, sur le besoin porteur de cette mission.
    const other = await startMission(env.pool, h, buyer, { quantity: 4 });
    const b = await sellerWith(other, { quantity: 4 });
    await assert.rejects(
      () => env.pool.query("INSERT INTO orders (demand_id, offer_id, buyer_id, seller_id, price_amount, mission_id) VALUES ($1, $2, $3, $4, 100, $5)", [other.demandId, b.candidate.offer.id, buyer.userId, b.seller.userId, live.id]),
      /order_mission_mismatch/,
    );
  });
});

describe("concurrence", () => {
  test("deux confirmations simultanées qui atteignent la quantité totale : la mission est terminée UNE seule fois, la quantité sécurisée est exacte", async () => {
    for (let round = 0; round < 6; round += 1) {
      await resetSocial(env.pool);
      buyer = await login(env.pool);
      const live = await startMission(env.pool, h, buyer, { quantity: 4 });
      const a = await sellerWith(live, { quantity: 2 });
      const b = await sellerWith(live, { quantity: 2 });
      const first = orderOf(await declareCall(live, a.candidate, { priceXof: 150_000, quantity: 2 }));
      const second = orderOf(await declareCall(live, b.candidate, { priceXof: 150_000, quantity: 2 }));
      const results = await Promise.all([actOrder(first.id as string, "confirm", a.seller.cookie), actOrder(second.id as string, "confirm", b.seller.cookie)]);
      assert.deepEqual(results.map((answer) => answer.status), [200, 200], `tour ${round}`);
      const done = await mission(live);
      assert.deepEqual([done.status, done.securedQuantity, done.pendingQuantity], ["completed", 4, 0], `tour ${round}`);
      assert.equal(await count(env.pool, "matching_outbox_events", `aggregate_id = '${live.demandId}' AND event_type = 'demand.archived'`), 0, "pas d'archivage à l'instant de la fin");
      await ageClosedMission(env.pool, live.id, 25);
      assert.equal((await Promise.all([runMissionsStep({ pool: env.pool }), runMissionsStep({ pool: env.pool })])).reduce((sum, result) => sum + result.released, 0), 1, "libéré une seule fois par deux processus");
      assert.equal(await count(env.pool, "matching_outbox_events", `aggregate_id = '${live.demandId}' AND event_type = 'demand.archived'`), 1, "le besoin porteur n'est archivé qu'une fois");
      assert.equal(await count(env.pool, "orders", "status = 'confirmed' AND mission_id IS NOT NULL"), 2);
    }
  });

  test("deux déclarations simultanées qui dépasseraient la quantité totale : une seule passe (8 tours)", async () => {
    for (let round = 0; round < 8; round += 1) {
      await resetSocial(env.pool);
      buyer = await login(env.pool);
      const live = await startMission(env.pool, h, buyer, { quantity: 4 });
      const a = await sellerWith(live, { quantity: 4 });
      const b = await sellerWith(live, { quantity: 4 });
      const results = await Promise.all([declareCall(live, a.candidate, { priceXof: 100_000, quantity: 3 }), declareCall(live, b.candidate, { priceXof: 100_000, quantity: 3 })]);
      assert.deepEqual(results.map((answer) => answer.status).sort(), [201, 409], `tour ${round}`);
      const refused = results.find((answer) => answer.status === 409) as { json: unknown };
      assert.equal(errorCode(refused as never), "mission_quantity_exceeded");
      const total = await env.pool.query<{ n: number }>("SELECT coalesce(sum(quantity), 0)::int AS n FROM orders WHERE mission_id = $1 AND status IN ('proposed', 'confirmed')", [live.id]);
      assert.equal(total.rows[0].n, 3, `tour ${round}`);
    }
  });

  test("une confirmation et l'annulation de la mission en même temps : un résultat cohérent, jamais d'interblocage ni d'achat à moitié annulé", async () => {
    for (let round = 0; round < 8; round += 1) {
      await resetSocial(env.pool);
      buyer = await login(env.pool);
      const live = await startMission(env.pool, h, buyer, { quantity: 4 });
      const a = await sellerWith(live, { quantity: 2 });
      const order = orderOf(await declareCall(live, a.candidate, { priceXof: 150_000, quantity: 2 }));
      const [confirm, cancel] = await Promise.all([actOrder(order.id as string, "confirm", a.seller.cookie), actMissionCall(h, buyer.cookie, live.id, "cancel")]);
      assert.equal(cancel.status, 200, `tour ${round} : ${cancel.text}`);
      assert.ok(confirm.status === 200 || confirm.status === 409, `tour ${round} : confirmation ${confirm.status}`);
      const status = (await env.pool.query<{ status: string }>("SELECT status FROM orders WHERE id = $1", [order.id])).rows[0].status;
      assert.equal(status, confirm.status === 200 ? "confirmed" : "cancelled", `tour ${round}`);
      assert.equal((await mission(live)).status, "cancelled");
    }
  });
});

// ═════════════ MV1-bis : la proposition répartit seulement le RESTE ═════════════

describe("la proposition répartit seulement le RESTE (quantité et budget engagés soustraits, achats affichés à part)", () => {
  type Engaged = { orderId: string; status: string; vendor: string; offerId: string; quantity: number; unitPriceXof: number; subtotalXof: number };
  const engagedOf = (answer: { json: unknown }): Engaged[] => proposalOf(answer as never).engaged as unknown as Engaged[];

  test("cas de l'audit (A2) : 4 voulus, 3 vendeurs de 2 ; après un achat confirmé de 2, la proposition couvre 2 achetés + 2 proposés (jamais 4 + 2), sans reproposer l'annonce achetée", async () => {
    const live = await startMission(env.pool, h, buyer, { quantity: 4, unitBudgetXof: 100_000, totalBudgetXof: 400_000 });
    const a = await sellerWith(live, { price: 100_000, quantity: 2, score: 99 });
    const b = await sellerWith(live, { price: 100_000, quantity: 2, score: 95 });
    const c = await sellerWith(live, { price: 100_000, quantity: 2, score: 90 });
    const before = proposalOf(await proposalCall(h, buyer.cookie, live.id));
    assert.deepEqual((before.lines as Json[]).map((line) => [line.offerId, line.quantity]), [[a.candidate.offer.id, 2], [b.candidate.offer.id, 2]]);
    assert.deepEqual([before.coveredQuantity, before.committedQuantity, before.remainingQuantity], [4, 0, 4]);
    const declared = await declareCall(live, a.candidate, { priceXof: 100_000, quantity: 2 });
    assert.equal(declared.status, 201, declared.text);
    assert.equal((await actOrder(orderOf(declared).id as string, "confirm", a.seller.cookie)).status, 200);
    // Le vendeur A marque son annonce vendue : sans la soustraction de l'engagé, la proposition « couvrirait 4 » avec B et C en plus des 2 déjà achetés.
    await env.pool.query("UPDATE offers SET availability_status = 'unavailable' WHERE id = $1", [a.candidate.offer.id]);
    const answer = await proposalCall(h, buyer.cookie, live.id);
    const proposal = proposalOf(answer);
    const m = await mission(live);
    assert.deepEqual([m.securedQuantity, m.pendingQuantity, m.committedXof], [2, 0, 200_000]);
    assert.deepEqual([proposal.requestedQuantity, proposal.committedQuantity, proposal.committedXof, proposal.remainingQuantity], [4, 2, 200_000, 2]);
    assert.deepEqual((proposal.lines as Json[]).map((line) => [line.offerId, line.quantity]), [[b.candidate.offer.id, 2]], "le reste (2) vient de B seulement : C n'est pas proposé en plus");
    assert.deepEqual([proposal.coveredQuantity, proposal.coveragePercent, proposal.budgetUsedXof, proposal.budgetRemainingXof], [4, 100, 400_000, 0]);
    assert.deepEqual(engagedOf(answer).map((order) => [order.orderId, order.status, order.quantity, order.unitPriceXof, order.subtotalXof]), [[orderOf(declared).id, "confirmed", 2, 100_000, 200_000]]);
    // Suivre la proposition : B est accepté ; C n'est plus proposé (et serait refusé : quantité dépassée).
    assert.equal((await declareCall(live, b.candidate, { priceXof: 100_000, quantity: 2 })).status, 201);
    const refused = await declareCall(live, c.candidate, { priceXof: 100_000, quantity: 2 });
    assert.equal(refused.status, 409);
    assert.equal(errorCode(refused), "mission_quantity_exceeded");
    const full = proposalOf(await proposalCall(h, buyer.cookie, live.id));
    assert.deepEqual([full.lines, full.committedQuantity, full.remainingQuantity, full.coveredQuantity, full.coveragePercent], [[], 4, 0, 4, 100]);
    assert.deepEqual((full.engaged as Json[]).map((order) => [order.status, order.quantity]), [["confirmed", 2], ["proposed", 2]]);
    assert.deepEqual((full.engaged as Json[]).map((order) => order.vendor), ["Vendeur 1", "Vendeur 2"], "chaque vendeur engagé garde son rang : le premier engagé d'abord");
  });

  test("le budget engagé est soustrait : le reste est réparti sous le budget total RESTANT, la raison est dite", async () => {
    const live = await startMission(env.pool, h, buyer, { quantity: 6, unitBudgetXof: 150_000, totalBudgetXof: 600_000 });
    const a = await sellerWith(live, { price: 150_000, quantity: 3, score: 99 });
    const b = await sellerWith(live, { price: 150_000, quantity: 3, score: 95 });
    await sellerWith(live, { price: 150_000, quantity: 3, score: 90 });
    assert.equal((await declareCall(live, a.candidate, { priceXof: 150_000, quantity: 2 })).status, 201, "300 000 FCFA engagés (en attente du vendeur)");
    const proposal = proposalOf(await proposalCall(h, buyer.cookie, live.id));
    assert.deepEqual([proposal.committedQuantity, proposal.committedXof, proposal.remainingQuantity], [2, 300_000, 4]);
    assert.deepEqual((proposal.lines as Json[]).map((line) => [line.offerId, line.quantity, line.subtotalXof]), [[b.candidate.offer.id, 2, 300_000]], "300 000 restent : 2 unités à 150 000, pas 3 + 1");
    assert.deepEqual([proposal.coveredQuantity, proposal.coveragePercent, proposal.budgetUsedXof, proposal.budgetRemainingXof, proposal.totalBudgetXof], [4, 66, 600_000, 0, 600_000]);
    assert.deepEqual((proposal.reasons as Json[]).map((reason) => reason.code), ["total_budget_too_low"]);
  });

  test("capture « 37-progression » de la démonstration : 8 voulus, sept annonces d'une unité ; 2 achetés à 165 000 sur l'annonce d'une unité, confirmés : 2 sur 8 achetés, la proposition répartit les 6 restants (8 sur 8), budget restant 162 000", async () => {
    const live = await startMission(env.pool, h, buyer, { quantity: 8, unitBudgetXof: 170_000, totalBudgetXof: 1_400_000 });
    const prices = [128_000, 142_000, 150_000, 158_000, 162_000, 165_000, 168_000];
    const sellers: Array<{ seller: Login; candidate: Candidate }> = [];
    for (const [index, price] of prices.entries()) sellers.push(await sellerWith(live, { price, quantity: 1, score: 99 - index }));
    const before = proposalOf(await proposalCall(h, buyer.cookie, live.id));
    assert.deepEqual([(before.lines as Json[]).length, before.coveredQuantity, before.coveragePercent, before.committedQuantity, before.remainingQuantity], [7, 7, 87, 0, 8], "avant achat : 7 lignes, 7 sur 8 (87 %)");
    const demoLine = sellers[5];
    const order = orderOf(await declareCall(live, demoLine.candidate, { priceXof: 165_000, quantity: 2 }));
    let proposal = proposalOf(await proposalCall(h, buyer.cookie, live.id));
    assert.deepEqual([proposal.committedQuantity, proposal.remainingQuantity, (proposal.lines as Json[]).length, proposal.coveredQuantity], [2, 6, 6, 8], "achat en attente : 2 engagés + 6 lignes");
    assert.equal((await mission(live)).securedQuantity, 0, "en attente : rien n'est sécurisé");
    assert.equal((await actOrder(order.id as string, "confirm", demoLine.seller.cookie)).status, 200);
    const answer = await proposalCall(h, buyer.cookie, live.id);
    proposal = proposalOf(answer);
    const m = await mission(live);
    assert.deepEqual([m.securedQuantity, m.pendingQuantity, m.committedXof], [2, 0, 330_000], "2 sur 8 achetés");
    assert.deepEqual((proposal.lines as Json[]).map((line) => line.unitPriceXof), [128_000, 142_000, 150_000, 158_000, 162_000, 168_000], "l'annonce achetée (165 000) n'est plus proposée");
    assert.deepEqual([proposal.committedQuantity, proposal.committedXof, proposal.remainingQuantity, proposal.coveredQuantity, proposal.coveragePercent], [2, 330_000, 6, 8, 100]);
    assert.deepEqual([proposal.budgetUsedXof, proposal.budgetRemainingXof], [330_000 + 908_000, 162_000]);
    assert.deepEqual(engagedOf(answer).map((entry) => [entry.status, entry.quantity, entry.unitPriceXof, entry.vendor]), [["confirmed", 2, 165_000, "Vendeur 1"]]);
    assert.deepEqual((proposal.lines as Json[]).map((line) => line.vendor), ["Vendeur 2", "Vendeur 3", "Vendeur 4", "Vendeur 5", "Vendeur 6", "Vendeur 7"]);
  });

  test("une commande déclinée ou annulée ne compte plus : l'annonce redevient proposée, la quantité à nouveau à acheter", async () => {
    const live = await startMission(env.pool, h, buyer, { quantity: 4 });
    const a = await sellerWith(live, { price: 100_000, quantity: 4, score: 99 });
    const declared = await declareCall(live, a.candidate, { priceXof: 100_000, quantity: 3 });
    assert.equal(declared.status, 201);
    let proposal = proposalOf(await proposalCall(h, buyer.cookie, live.id));
    assert.deepEqual([proposal.committedQuantity, proposal.remainingQuantity, (proposal.lines as Json[]).length], [3, 1, 0], "la seule annonce est déjà commandée : rien à proposer en plus");
    assert.equal((await actOrder(orderOf(declared).id as string, "decline", a.seller.cookie)).status, 200);
    proposal = proposalOf(await proposalCall(h, buyer.cookie, live.id));
    assert.deepEqual([proposal.committedQuantity, proposal.remainingQuantity, proposal.engaged], [0, 4, []]);
    assert.deepEqual((proposal.lines as Json[]).map((line) => [line.offerId, line.quantity]), [[a.candidate.offer.id, 4]]);
  });

  test("les vendeurs déjà engagés comptent dans les 10 vendeurs et gardent leur étiquette ; une autre annonce du même vendeur est proposée sous la même étiquette", async () => {
    const live = await startMission(env.pool, h, buyer, { quantity: 30, unitBudgetXof: 200_000, totalBudgetXof: 50_000_000 });
    const engagedSeller = await login(env.pool);
    const first = await addCandidate(env.pool, live, { price: 100_000, quantity: 1, score: 50, seller: person(engagedSeller) });
    for (let index = 0; index < 12; index += 1) await addCandidate(env.pool, live, { price: 100_000, quantity: 1, score: 99 - index });
    const second = await addCandidate(env.pool, live, { price: 100_000, quantity: 1, score: 40, seller: person(engagedSeller) });
    assert.equal((await declareCall(live, first, { priceXof: 100_000, quantity: 1 })).status, 201);
    const answer = await proposalCall(h, buyer.cookie, live.id);
    const proposal = proposalOf(answer);
    assert.equal(engagedOf(answer)[0].vendor, "Vendeur 1", "le vendeur engagé porte le premier rang");
    const lines = proposal.lines as Json[];
    assert.equal(proposal.sellerCount, MISSION_SELLERS_MAX, "1 vendeur engagé + 9 nouveaux = 10");
    assert.equal(lines.filter((line) => line.vendor !== "Vendeur 1").length, 9);
    assert.deepEqual(lines.find((line) => line.offerId === second.offer.id)?.vendor, "Vendeur 1", "même vendeur, même étiquette");
    assert.deepEqual((proposal.reasons as Json[]).map((reason) => reason.code), ["not_enough_offers", "seller_limit"]);
  });

  test("un achat de mission rattaché à une mission dont la proposition est lue : lecture seule, aucune commande ni message créé par la lecture (engagé compris)", async () => {
    const live = await startMission(env.pool, h, buyer, { quantity: 4 });
    const a = await sellerWith(live, { price: 100_000, quantity: 2, score: 99 });
    await declareCall(live, a.candidate, { priceXof: 100_000, quantity: 2 });
    const orders = await count(env.pool, "orders");
    for (let index = 0; index < 3; index += 1) assert.equal((await proposalCall(h, buyer.cookie, live.id)).status, 200);
    assert.equal(await count(env.pool, "orders"), orders);
    assert.equal(await count(env.pool, "messages"), 0);
    assert.equal(await count(env.pool, "conversations"), 0);
  });
});
