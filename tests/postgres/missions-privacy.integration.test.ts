import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { missionDraftMessage } from "../../lib/client/missions-view";
import type { OfferRecord } from "../../lib/server/catalog";
import { createHomeHttpHandlers } from "../../lib/server/home/http";
import { createMatchingHttpHandlers } from "../../lib/server/matching/http";
import { createMetricsHttpHandlers } from "../../lib/server/metrics/http";
import { computeBoostReach } from "../../lib/server/boost/reach";
import { readQuoteCounts } from "../../lib/server/boost/quotes";
import { readVendorHome } from "../../lib/server/home/reads";
import { readActiveDemandKeys } from "../../lib/server/external/watches";
import { roundCount } from "../../lib/server/metrics/privacy";
import { readOfferStatsRaw } from "../../lib/server/metrics/stats";
import { runMissionsStep } from "../../lib/server/missions/step";
import { createNotificationsHttpHandlers } from "../../lib/server/notifications/http";
import { insertEvaluation } from "./boost-fixtures";
import {
  ENV, TOTAL_BUDGET, UNIT_BUDGET, actMissionCall, addCandidate, ageClosedMission, listMissionsCall, login, makeHandlers, missionOf, openTestSchema, orderOf, proposalCall,
  proposalOf, readMissionCall, reply, request, resetSocial, startMission, type Handlers, type LiveMission, type Login, type TestSchema,
} from "./missions-fixtures";
import { NOT_FOUND } from "./social-fixtures";

/**
 * Confidentialité des missions (lot MV1) : le vendeur ne voit NI le budget de l'acheteur, NI la mission, NI les autres vendeurs. Il ne voit que le message et la commande qui le
 * concernent (avec la quantité demandée). Les budgets de l'essai ont des chiffres distinctifs, cherchés dans TOUTE réponse que le vendeur peut lire.
 */

let env: TestSchema;
let h: Handlers;
let buyer: Login;

before(async () => {
  env = await openTestSchema();
  h = makeHandlers(env.pool);
});

after(async () => {
  await env.close();
});

beforeEach(async () => {
  await resetSocial(env.pool);
  buyer = await login(env.pool);
});

const MISSION_QUANTITY = 37;

describe("ce que voit un vendeur", () => {
  test("ni budget, ni mission, ni quantité totale, ni autre vendeur dans aucune réponse lisible par le vendeur ; la commande dit la quantité demandée", async () => {
    const live = await startMission(env.pool, h, buyer, { quantity: MISSION_QUANTITY, deadlineDays: 17 });
    const sellerA = await login(env.pool);
    const sellerB = await login(env.pool);
    const a = await addCandidate(env.pool, live, { price: 150_000, quantity: 50, seller: { id: sellerA.userId, phone: sellerA.phone } });
    const b = await addCandidate(env.pool, live, { price: 140_000, quantity: 50, seller: { id: sellerB.userId, phone: sellerB.phone } });
    // L'acheteur écrit à A (le message est celui que l'écran pré-remplit), puis déclare l'achat ; il écrit aussi à B.
    for (const entry of [a, b]) {
      const opened = await reply(await h.social.conversations.open(request("POST", `/api/demands/${live.demandId}/offers/${entry.offer.id}/conversation`, { cookie: buyer.cookie, body: {} }), live.demandId, entry.offer.id));
      assert.equal(opened.status, 201);
      const conversationId = (opened.json as { conversation: { id: string } }).conversation.id;
      const body = missionDraftMessage({ title: "Apple iPhone 13 128 Go", quantity: 3, unitPriceXof: 150_000 });
      const sent = await reply(await h.social.conversations.send(request("POST", `/api/conversations/${conversationId}/messages`, { cookie: buyer.cookie, body: { body } }), conversationId));
      assert.equal(sent.status, 201, sent.text);
    }
    const order = orderOf(await reply(await h.social.orders.declare(request("POST", `/api/demands/${live.demandId}/offers/${a.offer.id}/orders`, { cookie: buyer.cookie, body: { priceXof: 150_000, quantity: 3 } }), live.demandId, a.offer.id)));

    const matching = createMatchingHttpHandlers({ pool: env.pool });
    const metrics = createMetricsHttpHandlers({ pool: env.pool, env: ENV, log: () => {} });
    const notifications = createNotificationsHttpHandlers({ pool: env.pool, env: ENV, log: () => {} });
    const home = createHomeHttpHandlers({ pool: env.pool });
    const as = (cookie: string) => ({ cookie });
    const conversations = await reply(await h.social.conversations.list(request("GET", "/api/conversations", as(sellerA.cookie))));
    const conversationId = (conversations.json as { items: Array<{ id: string }> }).items[0].id;
    const reads: Array<[string, { text: string; status: number }]> = [
      ["commandes", await reply(await h.social.orders.list(request("GET", "/api/orders", { cookie: sellerA.cookie, query: "?as=seller" })))],
      ["commande", await reply(await h.social.orders.get(request("GET", `/api/orders/${order.id}`, as(sellerA.cookie)), order.id as string))],
      ["conversations", conversations],
      ["conversation", await reply(await h.social.conversations.detail(request("GET", `/api/conversations/${conversationId}`, as(sellerA.cookie)), conversationId))],
      ["messages", await reply(await h.social.conversations.messages(request("GET", `/api/conversations/${conversationId}/messages`, as(sellerA.cookie)), conversationId))],
      ["correspondances enregistrées", await reply(await matching.offers.storedMatches(request("GET", `/api/offers/${a.offer.id}/stored-matches`, as(sellerA.cookie)), a.offer.id))],
      ["correspondances en direct", await reply(await matching.offers.matches(request("GET", `/api/offers/${a.offer.id}/matches`, as(sellerA.cookie)), a.offer.id))],
      ["statistiques", await reply(await metrics.offers.stats(request("GET", `/api/offers/${a.offer.id}/stats`, as(sellerA.cookie)), a.offer.id))],
      ["ventes", await reply(await h.social.orders.sales(request("GET", `/api/offers/${a.offer.id}/sales`, as(sellerA.cookie)), a.offer.id))],
      ["notifications", await reply(await notifications.notifications.list(request("GET", "/api/notifications", as(sellerA.cookie))))],
      ["accueil vendeur", await reply(await home.vendor(request("GET", "/api/home/vendor", as(sellerA.cookie))))],
      ["messages du vendeur B", await reply(await h.social.conversations.list(request("GET", "/api/conversations", as(sellerB.cookie))))],
    ];
    const forbidden: Array<[string, RegExp]> = [
      ["budget par unité", new RegExp(String(UNIT_BUDGET))],
      ["budget total", new RegExp(String(TOTAL_BUDGET))],
      ["mot « mission »", /mission/i],
      ["identifiant de la mission", new RegExp(live.id)],
      ["quantité totale voulue", new RegExp(`"quantity":${MISSION_QUANTITY}\\b`)],
      ["identifiant d'un autre vendeur", new RegExp(`${sellerB.userId}|${sellerB.phone.replace("+", "\\+")}`)],
      ["identifiant de l'acheteur", new RegExp(`${buyer.userId}|${buyer.phone.replace("+", "\\+")}`)],
    ];
    for (const [name, answer] of reads) {
      assert.ok(answer.status === 200 || answer.status === 404, `${name} : ${answer.status} ${answer.text}`);
      for (const [what, pattern] of forbidden) assert.ok(!pattern.test(answer.text), `${name} : ${what} dans la réponse du vendeur : ${answer.text.slice(0, 300)}`);
    }
    // Ce que le vendeur voit : sa commande, avec la quantité demandée et le prix par unité.
    const sellerOrder = orderOf(reads[1][1] as never);
    assert.equal(sellerOrder.quantity, 3);
    assert.deepEqual(sellerOrder.price, { amount: 150_000, currency: "XOF" });
    assert.equal(sellerOrder.role, "seller");
    // Le vendeur voit le besoin porteur comme un besoin ordinaire : sans budget, sans quantité, sans échéance.
    const stored = JSON.parse(reads[5][1].text) as { items: Array<{ candidate: Record<string, unknown> }> };
    assert.equal(stored.items.length, 1);
    assert.equal(stored.items[0].candidate.budget, null);
    assert.equal(stored.items[0].candidate.quantity, null);
    assert.equal(stored.items[0].candidate.deadlineAt, null);
    assert.equal(stored.items[0].candidate.unit, null);
    // Le message ne dit ni le budget ni la quantité totale.
    const messages = JSON.parse(reads[4][1].text) as { messages: Array<{ body: string }> };
    assert.equal(messages.messages.length, 1);
    assert.match(messages.messages[0].body, /3 unités/);
  });

  test("un vendeur ne peut ni lire, ni modifier, ni lancer, ni annuler une mission, ni voir sa proposition ; sa liste est vide", async () => {
    const live = await startMission(env.pool, h, buyer, { quantity: MISSION_QUANTITY });
    const seller = await login(env.pool);
    await addCandidate(env.pool, live, { quantity: 5, seller: { id: seller.userId, phone: seller.phone } });
    for (const answer of [
      await readMissionCall(h, seller.cookie, live.id),
      await proposalCall(h, seller.cookie, live.id),
      await actMissionCall(h, seller.cookie, live.id, "cancel"),
      await actMissionCall(h, seller.cookie, live.id, "pause"),
      await reply(await h.missions.update(request("PUT", `/api/missions/${live.id}`, { cookie: seller.cookie, body: { quantity: 3 } }), live.id)),
    ]) {
      assert.equal(answer.status, 404);
      assert.deepEqual(answer.json, NOT_FOUND);
    }
    assert.deepEqual(((await listMissionsCall(h, seller.cookie)).json as { missions: unknown[] }).missions, []);
    assert.equal(missionOf(await readMissionCall(h, buyer.cookie, live.id)).status, "active");
  });

  test("l'acheteur voit sa mission ; les vendeurs de la proposition y sont anonymes (« Vendeur 1 »…) sans identifiant ni numéro, et sans pseudonyme stable : les MÊMES vendeurs n'ont pas la même étiquette d'une mission à l'autre", async () => {
    const x = await login(env.pool);
    const y = await login(env.pool);
    /** Une mission avec les deux mêmes vendeurs, dans l'ordre de pertinence donné : l'étiquette que l'acheteur lit pour chacun d'eux. */
    const labelsOf = async (order: Array<{ seller: Login; score: number }>): Promise<{ labels: Map<string, string>; text: string }> => {
      const live = await startMission(env.pool, h, buyer, { quantity: 4 });
      const owners = new Map<string, string>();
      for (const { seller, score } of order) {
        const entry = await addCandidate(env.pool, live, { quantity: 2, score, seller: { id: seller.userId, phone: seller.phone } });
        owners.set(entry.offer.id, seller.userId);
      }
      const answer = await proposalCall(h, buyer.cookie, live.id);
      for (const seller of [x, y]) {
        assert.ok(!answer.text.includes(seller.userId), "aucun identifiant de vendeur");
        assert.ok(!answer.text.includes(seller.phone), "aucun numéro de vendeur");
      }
      const lines = proposalOf(answer).lines as Array<{ offerId: string; vendor: string }>;
      assert.equal(lines.length, 2);
      return { labels: new Map(lines.map((line) => [owners.get(line.offerId) as string, line.vendor])), text: answer.text };
    };
    const first = await labelsOf([{ seller: x, score: 99 }, { seller: y, score: 90 }]);
    const second = await labelsOf([{ seller: x, score: 80 }, { seller: y, score: 95 }]);
    assert.match(first.text, /Vendeur 1/);
    assert.match(first.text, /Vendeur 2/);
    assert.deepEqual([first.labels.get(x.userId), first.labels.get(y.userId)], ["Vendeur 1", "Vendeur 2"]);
    assert.deepEqual([second.labels.get(x.userId), second.labels.get(y.userId)], ["Vendeur 2", "Vendeur 1"]);
    assert.notEqual(first.labels.get(x.userId), second.labels.get(x.userId), "le vendeur X n'a pas la même étiquette dans les deux missions");
    assert.notEqual(first.labels.get(y.userId), second.labels.get(y.userId), "le vendeur Y non plus");
  });
});

// ═════════════ MV1-bis : étiquettes, fin de mission invisible du vendeur, besoins porteurs en pause ═════════════

describe("étiquettes « Vendeur N » : une étiquette PAR vendeur dans une mission (information assumée)", () => {
  test("information assumée : deux annonces d'un MÊME vendeur portent la même étiquette dans une mission (pour lui écrire une seule fois) ; deux vendeurs, deux étiquettes", async () => {
    const live = await startMission(env.pool, h, buyer, { quantity: 6 });
    const same = await login(env.pool);
    const other = await login(env.pool);
    const owners = new Map<string, string>();
    for (const [seller, score] of [[same, 99], [other, 95], [same, 90]] as const) {
      const entry = await addCandidate(env.pool, live, { quantity: 1, score, seller: { id: seller.userId, phone: seller.phone } });
      owners.set(entry.offer.id, seller.userId);
    }
    const lines = proposalOf(await proposalCall(h, buyer.cookie, live.id)).lines as Array<{ offerId: string; vendor: string }>;
    assert.deepEqual(lines.map((line) => [owners.get(line.offerId) === same.userId, line.vendor]), [[true, "Vendeur 1"], [false, "Vendeur 2"], [true, "Vendeur 1"]]);
  });
});

describe("la fin d'une mission ne se voit pas côté vendeur", () => {
  test("à l'instant où SA confirmation termine la mission, le besoin porteur reste dans les correspondances du vendeur (même liste qu'avant) ; il n'en part que 24 h plus tard", async () => {
    const matching = createMatchingHttpHandlers({ pool: env.pool });
    for (const [total, first] of [[5, 2], [2, 2]] as const) {
      const live = await startMission(env.pool, h, buyer, { quantity: total });
      const seller = await login(env.pool);
      const entry = await addCandidate(env.pool, live, { price: 100_000, quantity: 5, seller: { id: seller.userId, phone: seller.phone } });
      const visible = async (): Promise<string[]> =>
        ((await reply(await matching.offers.storedMatches(request("GET", `/api/offers/${entry.offer.id}/stored-matches`, { cookie: seller.cookie }), entry.offer.id))).json as { items: Array<{ candidateId: string }> }).items.map((item) => item.candidateId);
      const before = await visible();
      assert.deepEqual(before, [live.demandId]);
      const order = orderOf(await reply(await h.social.orders.declare(request("POST", `/api/demands/${live.demandId}/offers/${entry.offer.id}/orders`, { cookie: buyer.cookie, body: { priceXof: 100_000, quantity: first } }), live.demandId, entry.offer.id)));
      const confirmed = await reply(await h.social.orders.act(request("POST", `/api/orders/${order.id}/confirm`, { cookie: seller.cookie, body: {} }), order.id as string, "confirm"));
      assert.equal(confirmed.status, 200);
      assert.equal(missionOf(await readMissionCall(h, buyer.cookie, live.id)).status, total === first ? "completed" : "active");
      assert.deepEqual(await visible(), before, `mission de ${total}, achat de ${first} : le vendeur voit exactement la même liste après sa confirmation`);
    }
  });

  test("24 h après la fin, l'étape archive le besoin porteur : il quitte alors les correspondances du vendeur", async () => {
    const matching = createMatchingHttpHandlers({ pool: env.pool });
    const live = await startMission(env.pool, h, buyer, { quantity: 2 });
    const seller = await login(env.pool);
    const entry = await addCandidate(env.pool, live, { price: 100_000, quantity: 5, seller: { id: seller.userId, phone: seller.phone } });
    const order = orderOf(await reply(await h.social.orders.declare(request("POST", `/api/demands/${live.demandId}/offers/${entry.offer.id}/orders`, { cookie: buyer.cookie, body: { priceXof: 100_000, quantity: 2 } }), live.demandId, entry.offer.id)));
    assert.equal((await reply(await h.social.orders.act(request("POST", `/api/orders/${order.id}/confirm`, { cookie: seller.cookie, body: {} }), order.id as string, "confirm"))).status, 200);
    const ids = async (): Promise<string[]> =>
      ((await reply(await matching.offers.storedMatches(request("GET", `/api/offers/${entry.offer.id}/stored-matches`, { cookie: seller.cookie }), entry.offer.id))).json as { items: Array<{ candidateId: string }> }).items.map((item) => item.candidateId);
    assert.deepEqual(await ids(), [live.demandId]);
    await ageClosedMission(env.pool, live.id, 25);
    assert.equal((await runMissionsStep({ pool: env.pool })).released, 1);
    assert.deepEqual(await ids(), []);
  });
});

describe("le besoin porteur d'une mission EN PAUSE n'est pas un besoin vivant", () => {
  test("il ne compte ni dans les besoins du vendeur (statistiques et liste des acheteurs intéressés), ni dans la portée du boost, ni dans la collecte externe ; actif ou fini depuis moins de 24 h, il compte", async () => {
    const other = await login(env.pool);
    const seller = await login(env.pool);
    const active = await startMission(env.pool, h, buyer, { quantity: 4 });
    const toPause = await startMission(env.pool, h, other, { quantity: 4, brand: "Samsung", model: "Galaxy S21", variant: null });
    const entry = await addCandidate(env.pool, active, { quantity: 4, seller: { id: seller.userId, phone: seller.phone } });
    await insertEvaluation(env.pool, { offer: entry.offer, demand: toPause.carrier, score: 80 });
    const matching = createMatchingHttpHandlers({ pool: env.pool });
    const view = async () => {
      const stats = (await readOfferStatsRaw({ pool: env.pool, ownerId: seller.userId, offerId: entry.offer.id })).needs;
      const listed = ((await reply(await matching.offers.storedMatches(request("GET", `/api/offers/${entry.offer.id}/stored-matches`, { cookie: seller.cookie }), entry.offer.id))).json as { items: unknown[] }).items.length;
      const client = await env.pool.connect();
      let reached: number;
      try {
        await client.query("BEGIN");
        reached = (await computeBoostReach(client, { offerId: entry.offer.id, mode: "count", budgetMs: 2_000 })).evaluatedDemands;
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
      const keys = (await readActiveDemandKeys(env.pool)).length;
      return { stats, listed, reached, keys };
    };
    assert.deepEqual(await view(), { stats: 2, listed: 2, reached: 2, keys: 2 }, "deux missions actives : deux besoins");
    assert.equal((await actMissionCall(h, other.cookie, toPause.id, "pause")).status, 200);
    assert.deepEqual(await view(), { stats: 1, listed: 1, reached: 1, keys: 1 }, "la mission en pause ne compte plus nulle part");
    // Le propriétaire, lui, relit toujours sa proposition (la pause ne la ferme pas).
    assert.equal(proposalOf(await proposalCall(h, other.cookie, toPause.id)).state, "ready");
    assert.equal((await actMissionCall(h, other.cookie, toPause.id, "resume")).status, 200);
    assert.deepEqual(await view(), { stats: 2, listed: 2, reached: 2, keys: 2 }, "reprise : le besoin compte de nouveau");
    // Une mission annulée garde son besoin porteur 24 h : il compte encore (rien ne dit au vendeur que la mission est finie).
    assert.equal((await actMissionCall(h, other.cookie, toPause.id, "pause")).status, 200);
    assert.equal((await actMissionCall(h, other.cookie, toPause.id, "cancel")).status, 200);
    assert.deepEqual(await view(), { stats: 2, listed: 2, reached: 2, keys: 2 }, "annulée depuis moins de 24 h : encore compté");
    await ageClosedMission(env.pool, toPause.id, 25);
    await runMissionsStep({ pool: env.pool });
    assert.deepEqual(await view(), { stats: 1, listed: 1, reached: 1, keys: 1 }, "archivé 24 h après la fin");
  });
});

describe("comptes arrondis du vendeur et devis du boost : les besoins porteurs en pause ne comptent pas, au-delà de l'arrondi", () => {
  test("accueil du vendeur (« environ N besoins ») et acheteurs compatibles d'un devis de boost : 6 missions actives comptent (environ 5) ; 3 mises en pause ne comptent plus (moins de 5)", async () => {
    const seller = await login(env.pool);
    const owners: Login[] = [];
    const lives: LiveMission[] = [];
    let offer: OfferRecord | null = null;
    for (let index = 0; index < 6; index += 1) {
      const other = await login(env.pool);
      const live = await startMission(env.pool, h, other, { quantity: 3 });
      owners.push(other);
      lives.push(live);
      if (offer === null) offer = (await addCandidate(env.pool, live, { quantity: 3, seller: { id: seller.userId, phone: seller.phone } })).offer;
      else await insertEvaluation(env.pool, { offer, demand: live.carrier, score: 80 });
    }
    const offerId = (offer as OfferRecord).id;
    const shown = async () => {
      const home = await readVendorHome({ pool: env.pool, userId: seller.userId });
      const compatible = (await readQuoteCounts(env.pool, offerId, seller.userId, { category: "smartphones", brand: "apple", model: "iphone 13" })).compatible_buyers;
      return { total: home.needs, byOffer: home.offers.find((entry) => entry.id === offerId)?.needs, compatible };
    };
    assert.deepEqual(await shown(), { total: roundCount(6), byOffer: roundCount(6), compatible: 6 });
    assert.deepEqual(roundCount(6), { kind: "approx", value: 5 });
    for (const index of [0, 1, 2]) assert.equal((await actMissionCall(h, owners[index].cookie, lives[index].id, "pause")).status, 200);
    assert.deepEqual(await shown(), { total: roundCount(3), byOffer: roundCount(3), compatible: 3 });
    assert.deepEqual(roundCount(3), { kind: "below", bound: 5 });
    for (const index of [0, 1, 2]) assert.equal((await actMissionCall(h, owners[index].cookie, lives[index].id, "resume")).status, 200);
    assert.deepEqual(await shown(), { total: roundCount(6), byOffer: roundCount(6), compatible: 6 });
  });
});
