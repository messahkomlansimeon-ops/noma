import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ApiError } from "../../lib/client/api";
import { createSocialClient, describeSocialError } from "../../lib/client/social-api";

/** Client des favoris, de la messagerie, des commandes et de l'administration (lot D2) : requêtes exactes, réponses relues champ par champ, messages d'erreur fixes. */

const UUID_A = "1a1a1a1a-2b2b-4c3c-8d4d-5e5e5e5e5e5e";
const UUID_B = "2a2a2a2a-2b2b-4c3c-8d4d-5e5e5e5e5e5e";
const UUID_C = "3a3a3a3a-2b2b-4c3c-8d4d-5e5e5e5e5e5e";
const NOW = "2026-10-06T10:00:00.000Z";

interface Seen { url: string; method: string; body: unknown; credentials: string | undefined; cache: string | undefined }

function client(respond: (seen: Seen) => { status: number; body: unknown }) {
  const calls: Seen[] = [];
  const fetchStub = (async (input: string, init: RequestInit) => {
    const seen: Seen = { url: input, method: String(init.method), body: init.body === undefined ? undefined : JSON.parse(String(init.body)), credentials: init.credentials, cache: init.cache };
    calls.push(seen);
    const answer = respond(seen);
    return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { api: createSocialClient({ fetch: fetchStub }), calls };
}

const order = (overrides: Record<string, unknown> = {}) => ({
  id: UUID_A, role: "buyer", status: "proposed", price: { amount: 150_000, currency: "XOF" }, title: "Apple iPhone 12", offerId: UUID_B, demandId: UUID_C, conversationId: null,
  createdAt: NOW, decidedAt: null, canConfirm: false, canDecline: false, canCancel: true, canMarkDemandSatisfied: false, ...overrides,
});

describe("requêtes", () => {
  test("favoris : liste, ajout dans le contexte du besoin, retrait ; même origine, sans cache", async () => {
    const { api, calls } = client((seen) => {
      if (seen.method === "GET") return { status: 200, body: { contractVersion: "favorites/v1", items: [{ offerId: UUID_B, demandId: UUID_C, title: "Apple iPhone 12", price: { amount: 150_000, currency: "XOF" }, available: true, openable: true, createdAt: NOW }] } };
      if (seen.method === "DELETE") return { status: 200, body: { contractVersion: "favorites/v1", removed: true } };
      return { status: 201, body: { contractVersion: "favorites/v1", favorite: { offerId: UUID_B, demandId: UUID_C } } };
    });
    assert.equal((await api.favorites.list())[0].title, "Apple iPhone 12");
    assert.deepEqual(await api.favorites.add(UUID_C, UUID_B), { created: true });
    assert.deepEqual(await api.favorites.remove(UUID_B), { removed: true });
    assert.deepEqual(calls.map((call) => `${call.method} ${call.url}`), ["GET /api/favorites", `POST /api/demands/${UUID_C}/offers/${UUID_B}/favorite`, `DELETE /api/favorites/${UUID_B}`]);
    assert.ok(calls.every((call) => call.credentials === "same-origin" && call.cache === "no-store"));
  });

  test("conversations : ouverture, liste, détail, messages (avec rattrapage), envoi contrôlé AVANT la requête, lecture, adresse du flux", async () => {
    const { api, calls } = client((seen) => {
      if (seen.url.endsWith("/conversation")) return { status: 201, body: { contractVersion: "conversations/v1", conversation: { id: UUID_A }, created: true } };
      if (seen.url === "/api/conversations") return { status: 200, body: { contractVersion: "conversations/v1", items: [], unreadCount: 0 } };
      if (seen.url === "/api/conversations/unread") return { status: 200, body: { contractVersion: "conversations/v1", unreadCount: 3 } };
      if (seen.url.endsWith("/read")) return { status: 200, body: { contractVersion: "conversations/v1", unreadCount: 1 } };
      if (seen.method === "POST") return { status: 201, body: { contractVersion: "conversations/v1", message: { id: 9, mine: true, body: "Bonjour", createdAt: NOW } } };
      return { status: 200, body: { contractVersion: "conversations/v1", messages: [{ id: 8, mine: false, body: "Salut", createdAt: NOW }], hasMore: false } };
    });
    assert.deepEqual(await api.conversations.open(UUID_C, UUID_B), { conversationId: UUID_A, created: true });
    assert.deepEqual(await api.conversations.list(), { items: [], unreadCount: 0 });
    assert.equal(await api.conversations.unreadCount(), 3);
    assert.deepEqual((await api.conversations.messages(UUID_A, { afterId: 7, limit: 20 })).messages.map((m) => m.id), [8]);
    assert.equal((await api.conversations.send(UUID_A, "  Bonjour \n")).id, 9);
    assert.deepEqual(await api.conversations.markRead(UUID_A, 9), { unreadCount: 1 });
    assert.equal(api.conversations.streamUrl(UUID_A), `/api/conversations/${UUID_A}/stream`);
    assert.deepEqual(calls.map((call) => call.url), [
      `/api/demands/${UUID_C}/offers/${UUID_B}/conversation`, "/api/conversations", "/api/conversations/unread", `/api/conversations/${UUID_A}/messages?after=7&limit=20`,
      `/api/conversations/${UUID_A}/messages`, `/api/conversations/${UUID_A}/read`,
    ]);
    assert.deepEqual(calls[4].body, { body: "Bonjour" }, "le texte est normalisé avant l'envoi");
    assert.deepEqual(calls[5].body, { upToId: 9 });
    const before = calls.length;
    for (const text of ["", "   ", "x".repeat(1001), "a‮b"]) await assert.rejects(() => api.conversations.send(UUID_A, text), (error: ApiError) => error.code === "invalid_argument" && error.status === 0);
    assert.equal(calls.length, before, "un texte refusé n'envoie aucune requête");
  });

  test("commandes : déclaration (prix entier borné), liste, détail, actions, ventes arrondies", async () => {
    const { api, calls } = client((seen) => {
      if (seen.url.includes("/sales")) return { status: 200, body: { contractVersion: "offer-sales/v1", sales: { confirmed: { kind: "approx", value: 5 }, attributedToBoost: { kind: "below", bound: 5 }, organic: null } } };
      if (seen.url.startsWith("/api/orders?")) return { status: 200, body: { contractVersion: "orders/v1", orders: [order()] } };
      return { status: seen.method === "POST" && seen.url.endsWith("/orders") ? 201 : 200, body: { contractVersion: "orders/v1", order: order() } };
    });
    assert.equal((await api.orders.declare(UUID_C, UUID_B, 150_000)).status, "proposed");
    assert.equal((await api.orders.list("seller")).length, 1);
    assert.equal((await api.orders.get(UUID_A)).price.amount, 150_000);
    assert.equal((await api.orders.act(UUID_A, "confirm")).id, UUID_A);
    assert.deepEqual(await api.orders.sales(UUID_B), { confirmed: { kind: "approx", value: 5 }, attributedToBoost: { kind: "below", bound: 5 }, organic: null });
    assert.deepEqual(calls.map((call) => `${call.method} ${call.url}`), [
      `POST /api/demands/${UUID_C}/offers/${UUID_B}/orders`, "GET /api/orders?as=seller", `GET /api/orders/${UUID_A}`, `POST /api/orders/${UUID_A}/confirm`, `GET /api/offers/${UUID_B}/sales`,
    ]);
    assert.deepEqual(calls[0].body, { priceXof: 150_000 });
    const before = calls.length;
    for (const price of [0, -1, 1.5, 100_000_001, Number.NaN]) await assert.rejects(() => api.orders.declare(UUID_C, UUID_B, price), (error: ApiError) => error.code === "invalid_argument");
    await assert.rejects(() => api.orders.act(UUID_A, "supprimer" as never), (error: ApiError) => error.code === "invalid_argument");
    await assert.rejects(() => api.orders.list("autre" as never), (error: ApiError) => error.code === "invalid_argument");
    assert.equal(calls.length, before);
  });

  test("identifiant qui n'est pas un UUID : invalid_id, aucune requête", async () => {
    const { api, calls } = client(() => ({ status: 200, body: {} }));
    await assert.rejects(() => api.conversations.detail("../admin"), (error: ApiError) => error.code === "invalid_id" && error.status === 0);
    await assert.rejects(() => api.favorites.remove("x"), (error: ApiError) => error.code === "invalid_id");
    await assert.rejects(() => api.orders.get("1; DROP"), (error: ApiError) => error.code === "invalid_id");
    await assert.rejects(() => api.admin.setStatus("pas-un-uuid", "suspend"), (error: ApiError) => error.code === "invalid_id");
    assert.equal(calls.length, 0);
  });
});

describe("réponses relues champ par champ", () => {
  test("une réponse qui n'a pas la forme du contrat est refusée (invalid_response) ; un champ en trop n'atteint jamais l'écran", async () => {
    const wrongVersion = client(() => ({ status: 200, body: { contractVersion: "autre/v9", items: [] } }));
    await assert.rejects(() => wrongVersion.api.favorites.list(), (error: ApiError) => error.code === "invalid_response");
    const brokenItem = client(() => ({ status: 200, body: { contractVersion: "favorites/v1", items: [{ offerId: "x" }] } }));
    await assert.rejects(() => brokenItem.api.favorites.list(), (error: ApiError) => error.code === "invalid_response");
    const badOrder = client(() => ({ status: 200, body: { contractVersion: "orders/v1", order: order({ status: "inconnu" }) } }));
    await assert.rejects(() => badOrder.api.orders.get(UUID_A), (error: ApiError) => error.code === "invalid_response");
    const badPrice = client(() => ({ status: 200, body: { contractVersion: "orders/v1", order: order({ price: { amount: 1.5, currency: "XOF" } }) } }));
    await assert.rejects(() => badPrice.api.orders.get(UUID_A), (error: ApiError) => error.code === "invalid_response");
    const extra = client(() => ({ status: 200, body: { contractVersion: "orders/v1", order: order({ buyerPhone: "+2250700000101", sellerId: UUID_C }) } }));
    const parsed = await extra.api.orders.get(UUID_A);
    assert.ok(!JSON.stringify(parsed).includes("+2250700000101") && !JSON.stringify(parsed).includes("sellerId"));
    const badMessage = client(() => ({ status: 200, body: { contractVersion: "conversations/v1", messages: [{ id: 0, mine: true, body: "x", createdAt: NOW }], hasMore: false } }));
    await assert.rejects(() => badMessage.api.conversations.messages(UUID_A), (error: ApiError) => error.code === "invalid_response");
  });

  test("un refus du serveur devient une ApiError avec son code ; un corps illisible, un code fixe ; une panne réseau, network_error", async () => {
    const refused = client(() => ({ status: 429, body: { error: { code: "rate_limited", message: "Trop de demandes : réessayez plus tard." } } }));
    await assert.rejects(() => refused.api.conversations.list(), (error: ApiError) => error.status === 429 && error.code === "rate_limited");
    const garbage = client(() => ({ status: 500, body: "<html>erreur</html>" }));
    await assert.rejects(() => garbage.api.conversations.list(), (error: ApiError) => error.status === 500 && error.code === "invalid_response" && !/html/.test(error.message));
    const down = createSocialClient({ fetch: (async () => { throw new TypeError("connect ECONNREFUSED 127.0.0.1:3211"); }) as unknown as typeof fetch });
    await assert.rejects(() => down.conversations.list(), (error: ApiError) => error.code === "network_error" && !/127\.0\.0\.1/.test(error.message));
  });

  test("administration : le numéro masqué est relu strictement (jamais un numéro complet)", async () => {
    const vendors = (maskedPhone: string) => client(() => ({ status: 200, body: { contractVersion: "admin/v1", total: 1, limit: 20, offset: 0, vendors: [{ id: UUID_A, maskedPhone, offerCount: 2, publishedCount: 1, createdAt: NOW, status: "active", isAdmin: false }] } }));
    const ok = await vendors("+•••••••••••03").api.admin.vendors();
    assert.equal(ok.vendors[0].maskedPhone, "+•••••••••••03");
    await assert.rejects(() => vendors("+2250700000303").api.admin.vendors(), (error: ApiError) => error.code === "invalid_response", "un numéro complet n'est jamais accepté à l'écran");
    await assert.rejects(() => vendors("+•••••••0303").api.admin.vendors(), (error: ApiError) => error.code === "invalid_response", "quatre chiffres visibles : refusé");
  });
});

describe("messages d'erreur fixes en français", () => {
  const error = (status: number, code: string) => new ApiError(status, code, "texte du serveur à ne jamais afficher");
  test("jamais le texte du serveur ni celui d'une exception ; un message adapté au contexte", () => {
    assert.equal(describeSocialError(new Error("boom"), "message"), "Une erreur est survenue. Réessayez dans un instant.");
    assert.match(describeSocialError(error(429, "rate_limited"), "message"), /Trop de messages envoyés/);
    assert.match(describeSocialError(error(429, "rate_limited"), "conversation"), /20 conversations/);
    assert.match(describeSocialError(error(409, "favorites_limit"), "favorites"), /limite de 200 favoris/);
    assert.match(describeSocialError(error(409, "order_active_exists"), "order"), /déjà en cours/);
    assert.match(describeSocialError(error(400, "invalid_price"), "order"), /1 à 100 000 000/);
    assert.match(describeSocialError(error(409, "offer_not_available"), "conversation"), /n'est plus disponible/);
    assert.equal(describeSocialError(error(404, "resource_not_found"), "admin"), "Page introuvable.");
    assert.match(describeSocialError(error(401, "authentication_required"), "order"), /session a expiré/);
    for (const context of ["favorites", "conversation", "message", "order", "admin"] as const) {
      for (const status of [400, 403, 404, 409, 429, 503, 500]) assert.ok(!describeSocialError(error(status, "code_inconnu"), context).includes("texte du serveur"), `${context} ${status}`);
    }
  });
});
