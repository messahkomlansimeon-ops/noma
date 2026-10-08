import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ApiError, NOTIFICATIONS_CONTRACT_VERSION, createApiClient } from "../../lib/client/api";
import { createMissionsClient, describeMissionError } from "../../lib/client/missions-api";
import { notificationRow } from "../../lib/client/notifications-view";
import { notificationView } from "../../lib/client/home-view";
import type { MissionInput } from "../../lib/missions-rules";

/** Client des missions (lot MV1) : requêtes exactes, réponses relues champ par champ, refus avant la requête, messages d'erreur fixes ; notification « couverture » relue strictement. */

const ID = "11111111-1111-4111-8111-111111111111";
const OFFER = "22222222-2222-4222-8222-222222222222";
const ORDER = "33333333-3333-4333-8333-333333333333";
const NOW = "2031-01-02T10:00:00.000Z";
const CURSOR = "MHwyMDMxLTAxLTAyVDEwOjAwOjAwLjAwMDAwMFp8MTExMTExMTEtMTExMS00MTExLTgxMTEtMTExMTExMTExMTEx";

interface Seen { url: string; method: string; body: unknown; credentials: string | undefined; cache: string | undefined; signal: AbortSignal | undefined }

function harness(respond: (seen: Seen) => { status: number; body: unknown }) {
  const calls: Seen[] = [];
  const fetchStub = (async (input: string, init: RequestInit) => {
    const seen: Seen = { url: input, method: String(init.method), body: init.body === undefined ? undefined : JSON.parse(String(init.body)), credentials: init.credentials, cache: init.cache, signal: init.signal ?? undefined };
    calls.push(seen);
    const answer = respond(seen);
    return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { api: createMissionsClient({ fetch: fetchStub }), calls };
}

const dto = (overrides: Record<string, unknown> = {}) => ({
  id: ID, status: "active", title: "20 × Apple iPhone 12", category: "Téléphones", brand: "Apple", model: "iPhone 12", variant: null, condition: "Occasion", quantity: 20, unit: "pièce",
  securedQuantity: 5, pendingQuantity: 2, unitBudgetXof: 170_000, totalBudgetXof: 3_200_000, committedXof: 700_000, location: "Abidjan", deadlineDays: 30, deadlineAt: NOW, demandId: OFFER,
  coveredQuantity: 7, evaluatedAt: NOW, activatedAt: NOW, closedAt: null, createdAt: NOW, updatedAt: NOW, canEdit: false, canActivate: false, canPause: true, canResume: false, canCancel: true, ...overrides,
});
const envelope = (body: Record<string, unknown>) => ({ contractVersion: "missions/v1", ...body });
const proposalDto = (overrides: Record<string, unknown> = {}) => ({
  state: "ready",
  lines: [{ offerId: OFFER, vendor: "Vendeur 1", title: "Apple iPhone 12 128 Go", location: null, quantity: 2, unitPriceXof: 158_000, subtotalXof: 316_000, stock: 2 }],
  engaged: [{ orderId: ORDER, status: "confirmed", vendor: "Vendeur 2", offerId: OFFER, title: "Apple iPhone 12", location: "Cocody", quantity: 3, unitPriceXof: 150_000, subtotalXof: 450_000 }],
  requestedQuantity: 20, committedQuantity: 3, committedXof: 450_000, remainingQuantity: 17, coveredQuantity: 5, coveragePercent: 25, budgetUsedXof: 766_000, budgetRemainingXof: 2_434_000, totalBudgetXof: 3_200_000,
  unitBudgetXof: 170_000, sellerCount: 2, candidateCount: 1,
  reasons: [{ code: "not_enough_offers", text: "texte du serveur" }], readAt: NOW, ...overrides,
});
const input: MissionInput = {
  category: "Téléphones", brand: "Apple", model: "iPhone 12", variant: "128 Go", condition: "Occasion", quantity: 20, unit: "pièce", unitBudgetXof: 170_000, totalBudgetXof: 3_200_000, location: "Abidjan", deadlineDays: 30,
};

describe("requêtes", () => {
  test("liste, création (brouillon ou lancée), lecture, modification, actions, proposition : méthode, chemin, corps, même origine, sans cache", async () => {
    const { api, calls } = harness((seen) => {
      if (seen.url === "/api/missions" && seen.method === "GET") return { status: 200, body: envelope({ missions: [dto()], nextCursor: CURSOR }) };
      if (seen.url === `/api/missions?cursor=${CURSOR}`) return { status: 200, body: envelope({ missions: [dto({ status: "completed", canPause: false, canCancel: false })], nextCursor: null }) };
      if (seen.url === "/api/missions" && seen.method === "POST") return { status: 201, body: envelope({ mission: dto({ status: "draft" }) }) };
      if (seen.url === `/api/missions/${ID}` && seen.method === "GET") return { status: 200, body: envelope({ mission: dto(), orders: [{ id: ORDER, status: "confirmed", quantity: 2, unitPriceXof: 150_000, offerId: OFFER, title: "Apple iPhone 12", createdAt: NOW }] }) };
      if (seen.url.endsWith("/proposal")) return { status: 200, body: envelope({ missionId: ID, proposal: proposalDto() }) };
      return { status: 200, body: envelope({ mission: dto() }) };
    });
    const firstPage = await api.list();
    assert.equal(firstPage.missions[0].title, "20 × Apple iPhone 12");
    assert.equal(firstPage.nextCursor, CURSOR);
    const secondPage = await api.list(firstPage.nextCursor);
    assert.deepEqual([secondPage.missions[0].status, secondPage.nextCursor], ["completed", null]);
    assert.equal((await api.create(input)).status, "draft");
    await api.create(input, true);
    const detail = await api.get(ID);
    assert.equal(detail.orders[0].quantity, 2);
    await api.update(ID, input);
    await api.act(ID, "pause");
    const proposal = await api.proposal(ID);
    assert.deepEqual(calls.map((call) => [call.method, call.url]), [
      ["GET", "/api/missions"], ["GET", `/api/missions?cursor=${CURSOR}`], ["POST", "/api/missions"], ["POST", "/api/missions"], ["GET", `/api/missions/${ID}`], ["PUT", `/api/missions/${ID}`],
      ["POST", `/api/missions/${ID}`], ["GET", `/api/missions/${ID}/proposal`],
    ]);
    assert.equal((calls[2].body as Record<string, unknown>).activate, undefined);
    assert.equal((calls[3].body as Record<string, unknown>).activate, true);
    assert.deepEqual(calls[6].body, { action: "pause" });
    for (const call of calls) assert.deepEqual([call.credentials, call.cache], ["same-origin", "no-store"]);
    // Le texte d'une raison vient d'une table FIXE du client, jamais du serveur.
    assert.deepEqual(proposal.reasons, ["not_enough_offers"]);
    assert.equal(proposal.lines[0].vendor, "Vendeur 1");
    // Les achats déjà engagés sont servis à part, avec le reste à acheter.
    assert.deepEqual([proposal.committedQuantity, proposal.remainingQuantity, proposal.coveredQuantity, proposal.engaged.length], [3, 17, 5, 1]);
    assert.deepEqual([proposal.engaged[0].orderId, proposal.engaged[0].status, proposal.engaged[0].vendor, proposal.engaged[0].subtotalXof], [ORDER, "confirmed", "Vendeur 2", 450_000]);
  });

  test("un curseur mal formé n'est jamais envoyé ; une page suivante illisible est refusée", async () => {
    const { api, calls } = harness(() => ({ status: 200, body: envelope({ missions: [], nextCursor: "pas un curseur !" }) }));
    await assert.rejects(() => api.list("../x"), (error: ApiError) => error.code === "invalid_argument");
    await assert.rejects(() => api.list(""), (error: ApiError) => error.code === "invalid_argument");
    assert.equal(calls.length, 0);
    await assert.rejects(() => api.list(), (error: ApiError) => error.code === "invalid_response", "un curseur de réponse qui n'est pas opaque");
    const { api: missing } = harness(() => ({ status: 200, body: envelope({ missions: [] }) }));
    await assert.rejects(() => missing.list(), (error: ApiError) => error.code === "invalid_response", "nextCursor absent");
  });

  test("avant toute requête : mission invalide, action inconnue, identifiant mal formé sont refusés", async () => {
    const { api, calls } = harness(() => ({ status: 200, body: envelope({ mission: dto() }) }));
    await assert.rejects(() => api.create({ ...input, quantity: 1 }), (error: ApiError) => error.code === "invalid_argument");
    await assert.rejects(() => api.create({ ...input, model: "0708091011" }), (error: ApiError) => error.code === "invalid_argument");
    await assert.rejects(() => api.update(ID, { ...input, totalBudgetXof: 5 }), (error: ApiError) => error.code === "invalid_argument");
    await assert.rejects(() => api.act(ID, "delete" as never), (error: ApiError) => error.code === "invalid_argument");
    await assert.rejects(() => api.get("pas-un-uuid"), (error: ApiError) => error.code === "invalid_id");
    await assert.rejects(() => api.proposal("../x"), (error: ApiError) => error.code === "invalid_id");
    assert.equal(calls.length, 0);
  });
});

describe("réponses", () => {
  test("un champ de plus n'atteint jamais l'écran ; un champ manquant ou faux, une version de contrat étrangère : réponse inattendue", async () => {
    const { api } = harness(() => ({ status: 200, body: envelope({ missions: [{ ...dto(), ownerId: "secret", extra: 1 }], nextCursor: null }) }));
    const list = (await api.list()).missions;
    assert.ok(!("ownerId" in list[0]) && !("extra" in list[0]));
    for (const broken of [
      dto({ quantity: 1 }), dto({ status: "weird" }), dto({ unitBudgetXof: -1 }), dto({ demandId: "x" }), dto({ title: "" }), dto({ canEdit: "yes" }), { ...dto(), id: undefined },
    ]) {
      const { api: bad } = harness(() => ({ status: 200, body: envelope({ missions: [broken], nextCursor: null }) }));
      await assert.rejects(() => bad.list(), (error: ApiError) => error.code === "invalid_response", JSON.stringify(broken).slice(0, 60));
    }
    const { api: foreign } = harness(() => ({ status: 200, body: { contractVersion: "missions/v2", missions: [], nextCursor: null } }));
    await assert.rejects(() => foreign.list(), (error: ApiError) => error.code === "invalid_response");
    const { api: badProposal } = harness(() => ({ status: 200, body: envelope({ missionId: ID, proposal: proposalDto({ lines: [{ ...proposalDto().lines[0], vendor: ID }] }) }) }));
    await assert.rejects(() => badProposal.proposal(ID), (error: ApiError) => error.code === "invalid_response", "un vendeur n'est jamais désigné par un identifiant");
    const { api: badEngaged } = harness(() => ({ status: 200, body: envelope({ missionId: ID, proposal: proposalDto({ engaged: [{ ...proposalDto().engaged[0], vendor: ID }] }) }) }));
    await assert.rejects(() => badEngaged.proposal(ID), (error: ApiError) => error.code === "invalid_response", "un vendeur engagé n'est jamais désigné par un identifiant non plus");
    const { api: badEngagedStatus } = harness(() => ({ status: 200, body: envelope({ missionId: ID, proposal: proposalDto({ engaged: [{ ...proposalDto().engaged[0], status: "declined" }] }) }) }));
    await assert.rejects(() => badEngagedStatus.proposal(ID), (error: ApiError) => error.code === "invalid_response");
    const { api: oldShape } = harness(() => ({ status: 200, body: envelope({ missionId: ID, proposal: { ...proposalDto(), engaged: undefined } }) }));
    await assert.rejects(() => oldShape.proposal(ID), (error: ApiError) => error.code === "invalid_response");
    const { api: badReason } = harness(() => ({ status: 200, body: envelope({ missionId: ID, proposal: proposalDto({ reasons: [{ code: "<script>", text: "x" }] }) }) }));
    await assert.rejects(() => badReason.proposal(ID), (error: ApiError) => error.code === "invalid_response");
  });

  test("erreurs du serveur : code et statut conservés, jamais le texte brut ; réseau coupé : code fixe", async () => {
    const { api } = harness(() => ({ status: 409, body: { error: { code: "mission_active_limit", message: "texte" } } }));
    await assert.rejects(() => api.act(ID, "activate"), (error: ApiError) => error.status === 409 && error.code === "mission_active_limit");
    const broken = createMissionsClient({ fetch: (async () => { throw new TypeError("boom host=10.0.0.1"); }) as unknown as typeof fetch });
    await assert.rejects(() => broken.list(), (error: ApiError) => error.code === "network_error" && !/10\.0\.0\.1/.test(error.message));
    const { api: noBody } = harness(() => ({ status: 500, body: "oups" }));
    await assert.rejects(() => noBody.list(), (error: ApiError) => error.code === "invalid_response");
  });

  test("messages d'erreur fixes en français", () => {
    const error = (status: number, code: string) => new ApiError(status, code, "ignoré");
    assert.match(describeMissionError(error(409, "mission_active_limit"), "action"), /déjà 5 missions actives/);
    assert.match(describeMissionError(error(429, "mission_daily_limit"), "form"), /20 missions aujourd'hui/);
    assert.match(describeMissionError(error(400, "phone_number_in_mission"), "form"), /Pas de numéro de téléphone/);
    assert.match(describeMissionError(error(409, "mission_not_draft"), "form"), /Seul un brouillon/);
    assert.match(describeMissionError(error(404, "resource_not_found"), "mission"), /Mission introuvable/);
    assert.match(describeMissionError(error(404, "resource_not_found"), "line"), /plus disponible/);
    assert.match(describeMissionError(error(401, "authentication_required"), "list"), /session a expiré/);
    assert.match(describeMissionError(error(503, "missions_unavailable"), "list"), /temporairement indisponible/);
    assert.equal(describeMissionError(new Error("secret"), "list"), "Une erreur est survenue. Réessayez dans un instant.");
  });
});

describe("notification « couverture d'une mission »", () => {
  const coverage = (overrides: Record<string, unknown> = {}) => ({
    id: ORDER, kind: "mission_coverage", title: "Apple iPhone 12 : 7 sur 20", price: null, count: 7, demandId: OFFER, offerId: null, link: `/missions/${ID}`, createdAt: NOW, readAt: null, ...overrides,
  });
  const listed = async (items: unknown[]) => {
    const api = createApiClient({ fetch: (async () => new Response(JSON.stringify({ contractVersion: NOTIFICATIONS_CONTRACT_VERSION, unreadCount: 1, items, nextCursor: null }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch });
    return api.notifications.list();
  };

  test("relue strictement : titre, quantité couverte, lien interne exact vers la mission", async () => {
    const page = await listed([coverage()]);
    assert.equal(page.items[0].kind, "mission_coverage");
    assert.equal(page.items[0].link, `/missions/${ID}`);
    const row = notificationRow(page.items[0]);
    assert.equal(row.title, "Mission : Apple iPhone 12 : 7 sur 20");
    assert.equal(row.href, `/missions/${ID}`);
    assert.equal(row.linkLabel, "Voir la mission");
    assert.equal(row.unread, true);
  });

  test("un lien forgé, un prix, une annonce, une quantité nulle ou un titre dangereux sont refusés", async () => {
    for (const forged of [
      coverage({ link: "https://evil.example/missions/x" }), coverage({ link: `/missions/${ID}/../x` }), coverage({ link: `/besoins/${OFFER}` }), coverage({ price: { amount: 1, currency: "XOF" } }),
      coverage({ offerId: OFFER }), coverage({ count: 0 }), coverage({ count: null }), coverage({ title: "" }), coverage({ title: "a‮b" }),
    ]) {
      await assert.rejects(() => listed([forged]), (error: ApiError) => error.code === "invalid_response", JSON.stringify(forged).slice(0, 80));
    }
  });

  test("accueil : la notification de mission a son titre", () => {
    const view = notificationView({ id: ORDER, kind: "mission_coverage", title: "Apple iPhone 12 : 7 sur 20", price: null, count: 7, link: `/missions/${ID}`, createdAt: NOW, unread: true });
    assert.equal(view.title, "Mission : Apple iPhone 12 : 7 sur 20");
    assert.equal(view.subtitle, null);
    assert.equal(view.href, `/missions/${ID}`);
  });
});
