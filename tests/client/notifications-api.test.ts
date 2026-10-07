import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  API_INVALID_ARGUMENT,
  API_INVALID_ID,
  API_INVALID_RESPONSE,
  ApiError,
  DEMAND_TRACKING_CONTRACT_VERSION,
  NOTIFICATIONS_CONTRACT_VERSION,
  NOTIFICATION_PREFERENCES_CONTRACT_VERSION,
  createApiClient,
  describeApiError,
} from "../../lib/client/api";

interface Captured { url: string; init: RequestInit }

function harness(responder: (request: Captured, index: number) => Response | Promise<Response>) {
  const calls: Captured[] = [];
  const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const captured = { url: String(input), init: init ?? {} };
    calls.push(captured);
    return responder(captured, calls.length - 1);
  }) as typeof fetch;
  return { client: createApiClient({ fetch: fakeFetch }), calls };
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const DEMAND_ID = "22222222-2222-4222-8222-222222222222";
const OFFER_ID = "6f1d4f5c-9d2e-4d8e-8f56-0a8b9f0a1b2c";
const NOTIF_ID = "0f1e2d3c-4b5a-4968-8776-a5b4c3d2e1f0";
const NOTICE = "Les envois par SMS ne sont pas encore disponibles : ils sont simulés en développement.";

function matchDto(overrides: Record<string, unknown> = {}) {
  return {
    id: NOTIF_ID, kind: "new_match", title: "Apple iPhone 12 128 Go", price: { amount: 150_000, currency: "XOF" }, count: null,
    demandId: DEMAND_ID, offerId: OFFER_ID, link: `/besoins/${DEMAND_ID}/offres/${OFFER_ID}`, createdAt: "2031-01-01T10:00:00.000Z", readAt: null, ...overrides,
  };
}

function digestDto(overrides: Record<string, unknown> = {}) {
  return {
    id: "1a1a1a1a-2b2b-4c3c-8d4d-5e5e5e5e5e5e", kind: "new_matches_digest", title: null, price: null, count: 8, demandId: DEMAND_ID, offerId: null,
    link: `/besoins/${DEMAND_ID}`, createdAt: "2031-01-01T11:00:00.000Z", readAt: null, ...overrides,
  };
}

const page = (items: unknown[], overrides: Record<string, unknown> = {}) => ({ contractVersion: NOTIFICATIONS_CONTRACT_VERSION, unreadCount: 3, items, nextCursor: null, ...overrides });
const trackingDto = (overrides: Record<string, unknown> = {}) => ({
  contractVersion: DEMAND_TRACKING_CONTRACT_VERSION,
  tracking: {
    demandId: DEMAND_ID, demandStatus: "active", until: "2031-02-01T10:00:00.000Z", paused: false, active: true, maxUntil: "2031-04-01T10:00:00.000Z", readAt: "2031-01-02T10:00:00.000Z",
    ...overrides,
  },
});
const preferencesDto = (overrides: Record<string, unknown> = {}) => ({
  contractVersion: NOTIFICATION_PREFERENCES_CONTRACT_VERSION, preferences: { externalEnabled: false }, external: { available: true, notice: NOTICE }, ...overrides,
});

async function rejection(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof ApiError, `ApiError attendue, reçu ${String(error)}`);
    return error;
  }
  throw new Error("la requête aurait dû être refusée");
}

describe("api.notifications.list", () => {
  test("GET /api/notifications, no-store, liste blanche, compteur total et curseur", async () => {
    const { client, calls } = harness(() => json(200, page([matchDto(), digestDto()], { nextCursor: "abc-DEF_123" })));
    const result = await client.notifications.list();
    assert.equal(calls[0].url, "/api/notifications");
    assert.equal(calls[0].init.method, "GET");
    assert.equal(calls[0].init.cache, "no-store");
    assert.equal(calls[0].init.credentials, "same-origin");
    assert.equal(calls[0].init.body, undefined);
    assert.equal(result.unreadCount, 3);
    assert.equal(result.nextCursor, "abc-DEF_123");
    assert.equal(result.items.length, 2);
    assert.deepEqual(result.items[0], { ...matchDto(), count: null });
    assert.deepEqual(result.items[1], digestDto());
  });

  test("limit et cursor sont vérifiés AVANT la requête", async () => {
    const { client, calls } = harness(() => json(200, page([])));
    await client.notifications.list({ limit: 1 });
    await client.notifications.list({ limit: 50, cursor: "x".repeat(512) });
    assert.equal(calls[0].url, "/api/notifications?limit=1");
    assert.equal(calls[1].url, `/api/notifications?limit=50&cursor=${"x".repeat(512)}`);
    for (const query of [{ limit: 0 }, { limit: 51 }, { limit: 1.5 }, { limit: Number.NaN }, { cursor: "" }, { cursor: "x".repeat(513) }, { cursor: 5 as unknown as string }]) {
      const error = await rejection(client.notifications.list(query));
      assert.equal(error.code, API_INVALID_ARGUMENT);
      assert.equal(error.status, 0);
    }
    assert.equal(calls.length, 2, "aucune requête pour un argument refusé");
  });

  test("une réponse hors contrat est refusée : version, forme, identifiants, lien externe, champs du mauvais genre", async () => {
    const bad: unknown[] = [
      null, "texte", [], {},
      { ...page([]), contractVersion: "notifications/v2" },
      page([], { unreadCount: -1 }), page([], { unreadCount: 1.5 }), page([], { unreadCount: "3" }), page([], { nextCursor: "" }), page([], { nextCursor: 5 }), page("x" as never),
      page([matchDto({ id: "pas-un-uuid" })]),
      page([matchDto({ demandId: "pas-un-uuid" })]),
      page([matchDto({ offerId: null })]),
      page([matchDto({ kind: "autre" })]),
      page([matchDto({ title: null })]),
      page([matchDto({ title: "" })]),
      page([matchDto({ title: "x".repeat(161) })]),
      page([matchDto({ title: "Apple‮iphone" })]),
      page([matchDto({ count: 3 })]),
      page([matchDto({ link: "https://evil.example/x" })]),
      page([matchDto({ link: "//evil.example" })]),
      page([matchDto({ link: `/besoins/${DEMAND_ID}` })]),
      page([matchDto({ link: `/besoins/${DEMAND_ID}/offres/${NOTIF_ID}` })]),
      page([matchDto({ link: "javascript:alert(1)" })]),
      page([matchDto({ price: { amount: -1, currency: "XOF" } })]),
      page([matchDto({ price: { amount: 1.5, currency: "XOF" } })]),
      page([matchDto({ price: { amount: 5, currency: "xof" } })]),
      page([matchDto({ price: "cher" })]),
      page([matchDto({ createdAt: "hier" })]),
      page([matchDto({ readAt: 12 })]),
      page([digestDto({ count: 0 })]),
      page([digestDto({ count: null })]),
      page([digestDto({ title: "8 annonces" })]),
      page([digestDto({ offerId: OFFER_ID })]),
      page([digestDto({ price: { amount: 1, currency: "XOF" } })]),
      page([digestDto({ link: `/besoins/${DEMAND_ID}/offres/${OFFER_ID}` })]),
      page([null]),
    ];
    for (const body of bad) {
      const { client } = harness(() => json(200, body));
      const error = await rejection(client.notifications.list());
      assert.equal(error.code, API_INVALID_RESPONSE, JSON.stringify(body)?.slice(0, 100));
    }
  });

  test("un champ ajouté par le serveur n'atteint jamais l'écran (liste blanche, champ par champ)", async () => {
    const { client } = harness(() => json(200, page([matchDto({ userId: "SECRET", sellerPhone: "+2250700000042", rawText: "texte libre" })])));
    const result = await client.notifications.list();
    assert.equal(JSON.stringify(result).includes("SECRET"), false);
    assert.equal(JSON.stringify(result).includes("+2250700000042"), false);
    assert.equal(JSON.stringify(result).includes("texte libre"), false);
    assert.deepEqual(Object.keys(result.items[0]).sort(), ["count", "createdAt", "demandId", "id", "kind", "link", "offerId", "price", "readAt", "title"]);
  });

  test("erreurs : code et statut du serveur, jamais le texte brut ; messages fixes", async () => {
    const { client } = harness(() => json(503, { error: { code: "notifications_unavailable", message: "Le service est temporairement indisponible." } }));
    const error = await rejection(client.notifications.list());
    assert.equal(error.status, 503);
    assert.equal(error.code, "notifications_unavailable");
    assert.equal(describeApiError(error, "notifications"), "Les notifications sont temporairement indisponibles. Réessayez dans un instant.");
    assert.equal(describeApiError(new ApiError(404, "resource_not_found", "x"), "notifications"), "Cette notification est introuvable. La liste va être actualisée.");
    assert.equal(describeApiError(new ApiError(400, "invalid_request", "x"), "notifications"), "Cette demande n'est pas valide. Rechargez la page.");
    assert.equal(describeApiError(new ApiError(401, "authentication_required", "x"), "notifications"), "Votre session a expiré. Reconnectez-vous pour continuer.");
  });
});

const UP_TO = "2031-01-01T12:00:00.123Z";

describe("api.notifications.markRead / markAllRead", () => {
  test("POST /api/notifications/read avec { ids } puis { all: true } ; réponse en liste blanche", async () => {
    const { client, calls } = harness(() => json(200, { contractVersion: NOTIFICATIONS_CONTRACT_VERSION, marked: 2, unreadCount: 1, extra: "ignoré" }));
    assert.deepEqual(await client.notifications.markRead([NOTIF_ID, OFFER_ID]), { marked: 2, unreadCount: 1 });
    assert.deepEqual(await client.notifications.markAllRead(UP_TO), { marked: 2, unreadCount: 1 });
    assert.equal(calls[0].url, "/api/notifications/read");
    assert.equal(calls[0].init.method, "POST");
    assert.deepEqual(JSON.parse(String(calls[0].init.body)), { ids: [NOTIF_ID, OFFER_ID] });
    assert.deepEqual(JSON.parse(String(calls[1].init.body)), { all: true, upTo: UP_TO }, "« tout » porte la date de la plus récente notification affichée");
    assert.equal((calls[0].init.headers as Record<string, string>)["Content-Type"], "application/json");
  });

  test("`upTo` est un instant UTC à la milliseconde (`YYYY-MM-DDTHH:MM:SS.mmmZ`), vérifié AVANT la requête", async () => {
    const { client, calls } = harness(() => json(200, { contractVersion: NOTIFICATIONS_CONTRACT_VERSION, marked: 0, unreadCount: 0 }));
    for (const bad of ["", "2031-01-01", "2031-01-01T10:00:00Z", "2031-01-01T10:00:00.000+01:00", "2031-01-01T10:00:00.000000Z", "2031-13-45T10:00:00.000Z", undefined, null, 5, {}]) {
      const error = await rejection(client.notifications.markAllRead(bad as unknown as string));
      assert.equal(error.code, API_INVALID_ARGUMENT, String(bad));
    }
    assert.equal(calls.length, 0, "aucune requête n'est partie");
    await client.notifications.markAllRead(UP_TO);
    assert.equal(calls.length, 1);
  });

  test("les identifiants sont des UUID (1 à 100), vérifiés AVANT la requête", async () => {
    const { client, calls } = harness(() => json(200, { contractVersion: NOTIFICATIONS_CONTRACT_VERSION, marked: 0, unreadCount: 0 }));
    for (const ids of [[], ["x"], [NOTIF_ID, "x"], Array.from({ length: 101 }, () => NOTIF_ID), "oups" as unknown as string[], [5 as unknown as string]]) {
      const error = await rejection(client.notifications.markRead(ids));
      assert.equal(error.code, API_INVALID_ARGUMENT);
    }
    assert.equal(calls.length, 0);
    await client.notifications.markRead(Array.from({ length: 100 }, () => NOTIF_ID));
    assert.equal(calls.length, 1);
  });

  test("404 (notification d'autrui ou inconnue) et réponse hors contrat", async () => {
    const { client } = harness(() => json(404, { error: { code: "resource_not_found", message: "Ressource introuvable." } }));
    const error = await rejection(client.notifications.markRead([NOTIF_ID]));
    assert.equal(error.status, 404);
    for (const body of [{}, { contractVersion: NOTIFICATIONS_CONTRACT_VERSION }, { contractVersion: NOTIFICATIONS_CONTRACT_VERSION, marked: -1, unreadCount: 0 }, { contractVersion: NOTIFICATIONS_CONTRACT_VERSION, marked: 1, unreadCount: 0.5 }, { contractVersion: "x", marked: 1, unreadCount: 0 }]) {
      const bad = harness(() => json(200, body));
      assert.equal((await rejection(bad.client.notifications.markAllRead(UP_TO))).code, API_INVALID_RESPONSE);
    }
  });
});

describe("api.notifications.preferences / setPreferences", () => {
  test("GET puis PUT { externalEnabled } (méthode PUT, corps JSON)", async () => {
    const { client, calls } = harness((request) => json(200, preferencesDto({ preferences: { externalEnabled: request.init.method === "PUT" } })));
    const initial = await client.notifications.preferences();
    assert.deepEqual(initial, { externalEnabled: false, externalAvailable: true, notice: NOTICE });
    assert.equal(calls[0].url, "/api/notifications/preferences");
    assert.equal(calls[0].init.method, "GET");
    const enabled = await client.notifications.setPreferences(true);
    assert.equal(enabled.externalEnabled, true);
    assert.equal(calls[1].init.method, "PUT");
    assert.deepEqual(JSON.parse(String(calls[1].init.body)), { externalEnabled: true });
  });

  test("argument non booléen refusé avant la requête ; réponse hors contrat refusée", async () => {
    const { client, calls } = harness(() => json(200, preferencesDto()));
    for (const value of ["true", 1, null, undefined]) {
      assert.equal((await rejection(client.notifications.setPreferences(value as never))).code, API_INVALID_ARGUMENT);
    }
    assert.equal(calls.length, 0);
    for (const body of [
      {}, preferencesDto({ contractVersion: "x" }), preferencesDto({ preferences: { externalEnabled: "oui" } }), preferencesDto({ preferences: null }),
      preferencesDto({ external: { available: "oui", notice: NOTICE } }), preferencesDto({ external: { available: true, notice: "" } }), preferencesDto({ external: { available: true, notice: "x".repeat(301) } }),
      preferencesDto({ external: null }),
    ]) {
      const bad = harness(() => json(200, body));
      assert.equal((await rejection(bad.client.notifications.preferences())).code, API_INVALID_RESPONSE, JSON.stringify(body).slice(0, 80));
    }
  });
});

describe("api.demands.tracking / trackingAction", () => {
  test("GET /api/demands/{id}/tracking, puis POST { action } pour chaque action", async () => {
    const { client, calls } = harness(() => json(200, trackingDto()));
    const tracking = await client.demands.tracking(DEMAND_ID);
    assert.deepEqual(tracking, {
      demandId: DEMAND_ID, demandStatus: "active", until: "2031-02-01T10:00:00.000Z", paused: false, active: true, maxUntil: "2031-04-01T10:00:00.000Z", readAt: "2031-01-02T10:00:00.000Z",
    });
    assert.equal(calls[0].url, `/api/demands/${DEMAND_ID}/tracking`);
    assert.equal(calls[0].init.method, "GET");
    for (const action of ["extend", "pause", "resume"] as const) {
      await client.demands.trackingAction(DEMAND_ID, action);
      const call = calls[calls.length - 1];
      assert.equal(call.url, `/api/demands/${DEMAND_ID}/tracking`);
      assert.equal(call.init.method, "POST");
      assert.deepEqual(JSON.parse(String(call.init.body)), { action });
    }
  });

  test("identifiant non UUID : invalid_id sans requête ; action inconnue : invalid_argument sans requête", async () => {
    const { client, calls } = harness(() => json(200, trackingDto()));
    assert.equal((await rejection(client.demands.tracking("../x"))).code, API_INVALID_ID);
    assert.equal((await rejection(client.demands.trackingAction("x", "pause"))).code, API_INVALID_ID);
    assert.equal((await rejection(client.demands.trackingAction(DEMAND_ID, "stop" as never))).code, API_INVALID_ARGUMENT);
    assert.equal(calls.length, 0);
  });

  test("réponse hors contrat refusée ; 404 et 409 avec des messages fixes", async () => {
    for (const body of [
      {}, trackingDto({ demandId: "x" }), trackingDto({ demandStatus: "paused" }), trackingDto({ until: "bientôt" }), trackingDto({ paused: "non" }), trackingDto({ active: 1 }),
      trackingDto({ maxUntil: null }), trackingDto({ readAt: undefined }), { contractVersion: "x", tracking: trackingDto().tracking }, { contractVersion: DEMAND_TRACKING_CONTRACT_VERSION, tracking: null },
    ]) {
      const bad = harness(() => json(200, body));
      assert.equal((await rejection(bad.client.demands.tracking(DEMAND_ID))).code, API_INVALID_RESPONSE, JSON.stringify(body).slice(0, 80));
    }
    const refused = harness(() => json(409, { error: { code: "demand_not_active", message: "Le suivi n'est disponible que pour un besoin actif." } }));
    const conflict = await rejection(refused.client.demands.trackingAction(DEMAND_ID, "extend"));
    assert.equal(describeApiError(conflict, "tracking"), "Le suivi n'est disponible que pour un besoin actif.");
    assert.equal(describeApiError(new ApiError(404, "resource_not_found", "x"), "tracking"), "Besoin introuvable : il a peut-être été archivé ou n'existe plus.");
    assert.equal(describeApiError(new ApiError(503, "notifications_unavailable", "x"), "tracking"), "Le suivi est temporairement indisponible. Réessayez dans un instant.");
  });
});
