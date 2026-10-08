import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ApiError } from "../../lib/client/api";
import { createExternalClient, describeExternalError, isSafeExternalUrl, parseAdminCollection, parseListingsPage } from "../../lib/client/external-api";

/** Client de la collecte d'annonces externes (lot EXT1) : requêtes exactes, réponses relues champ par champ (liste blanche), liens sortants sûrs, messages d'erreur fixes. */

const DEMAND = "1a1a1a1a-2b2b-4c3c-8d4d-5e5e5e5e5e5e";
const LISTING = "2a2a2a2a-2b2b-4c3c-8d4d-5e5e5e5e5e5e";
const NOW = "2026-10-07T10:00:00.000Z";

interface Seen { url: string; method: string; credentials: string | undefined; cache: string | undefined }

function client(respond: (seen: Seen) => { status: number; body: unknown }) {
  const calls: Seen[] = [];
  const fetchStub = (async (input: string, init: RequestInit) => {
    const seen: Seen = { url: input, method: String(init.method), credentials: init.credentials, cache: init.cache };
    calls.push(seen);
    const answer = respond(seen);
    return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { api: createExternalClient({ fetch: fetchStub }), calls };
}

const item = (over: Record<string, unknown> = {}) => ({
  id: LISTING, title: "iPhone 12 128 Go noir", price: { amount: 150_000, currency: "XOF" }, location: "Cocody", listedAt: NOW, source: { code: "demo_a", name: "Annonces Démo A" },
  alsoOn: [{ code: "demo_b", name: "Annonces Démo B" }], url: "https://annonces-demo-a.example/annonce/demo_a-1", score: 100, seenAt: NOW, confirmedAt: NOW, ...over,
});
const page = (over: Record<string, unknown> = {}) => ({ contractVersion: "external-listings/v1", hasMore: false, nextCursor: null, items: [item()], ...over });

describe("requêtes", () => {
  test("annonces d'un besoin : adresse exacte, page et curseur, même origine, sans cache", async () => {
    const { api, calls } = client(() => ({ status: 200, body: page() }));
    const first = await api.listings(DEMAND);
    assert.equal(first.items.length, 1);
    await api.listings(DEMAND, { limit: 6 });
    await api.listings(DEMAND, { limit: 6, cursor: "abc_DEF-123" });
    assert.deepEqual(calls.map((call) => `${call.method} ${call.url}`), [
      `GET /api/demands/${DEMAND}/external-listings`, `GET /api/demands/${DEMAND}/external-listings?limit=6`, `GET /api/demands/${DEMAND}/external-listings?limit=6&cursor=abc_DEF-123`,
    ]);
    assert.ok(calls.every((call) => call.credentials === "same-origin" && call.cache === "no-store"));
  });

  test("paramètres refusés AVANT toute requête : identifiant, limite, curseur", async () => {
    const { api, calls } = client(() => ({ status: 200, body: page() }));
    await assert.rejects(() => api.listings("pas-un-uuid"), (error: ApiError) => error.code === "invalid_id");
    for (const limit of [0, 31, 1.5, Number.NaN]) await assert.rejects(() => api.listings(DEMAND, { limit }), (error: ApiError) => error.code === "invalid_argument");
    for (const cursor of ["", "a b", "a/b", "x".repeat(301)]) await assert.rejects(() => api.listings(DEMAND, { cursor }), (error: ApiError) => error.code === "invalid_argument");
    assert.deepEqual(calls, []);
  });

  test("administration : GET /api/admin/collection", async () => {
    const { api, calls } = client(() => ({
      status: 200,
      body: {
        contractVersion: "admin-collection/v1", schemaReady: true, readAt: NOW,
        sources: [{ code: "demo_a", name: "Annonces Démo A", type: "fake", enabled: true, state: "closed", consecutiveFailures: 0, breakerOpenUntil: null, usedToday: 2, dailyQuota: 200, minIntervalMs: 250, lastSuccessAt: NOW, lastFailureAt: null, lastErrorCode: null }],
        watches: { total: 2, active: 1, paused: 1, due: 0 }, listings: { available: 5, gone: 1, unknown: 0, groups: 1 }, errors: [{ at: NOW, sourceCode: "demo_a", sourceName: "Annonces Démo A", code: "timeout" }],
      },
    }));
    const collection = await api.adminCollection();
    assert.equal(collection.sources[0].state, "closed");
    assert.deepEqual(collection.watches, { total: 2, active: 1, paused: 1, due: 0 });
    assert.equal(calls[0].url, "/api/admin/collection");
  });
});

describe("relecture des réponses", () => {
  test("liste blanche : un champ ajouté par le serveur n'atteint jamais l'écran", () => {
    const parsed = parseListingsPage(200, page({ items: [item({ phone: "0708091011", externalId: "secret", sponsored: true })], extra: 1, watching: true, lastCollectedAt: NOW }));
    const text = JSON.stringify(parsed);
    assert.ok(!text.includes("0708091011") && !text.includes("secret") && !text.includes("sponsored"));
    // La surveillance partagée n'est jamais exposée à l'acheteur : ni son existence (`watching`), ni sa dernière collecte (`lastCollectedAt`), même si un serveur les envoyait.
    assert.deepEqual(Object.keys(parsed).sort(), ["hasMore", "items", "nextCursor"]);
    assert.ok(!("watching" in parsed) && !("lastCollectedAt" in parsed));
    assert.ok(!text.includes("lastCollectedAt") && !text.includes("watching"));
    assert.deepEqual(Object.keys(parsed.items[0]).sort(), ["alsoOn", "confirmedAt", "id", "listedAt", "location", "price", "score", "seenAt", "source", "title", "url"]);
  });

  test("un lien qui n'est pas http(s) rend toute la réponse invalide (javascript:, data:, identifiants dans l'URL)", () => {
    for (const url of ["javascript:alert(1)", "data:text/html,x", "ftp://a.example/x", "https://user:pw@a.example/x", "", "x", "https://", 5, null]) {
      assert.throws(() => parseListingsPage(200, page({ items: [item({ url })] })), (error: ApiError) => error.code === "invalid_response", String(url));
    }
    assert.equal(isSafeExternalUrl("https://a.example/x"), true);
    assert.equal(isSafeExternalUrl("http://a.example/x"), true);
    assert.equal(isSafeExternalUrl("https://a.example/" + "x".repeat(1_100)), false);
  });

  test("formes invalides refusées : version, score, titre, source, identifiant, curseur, trop d'éléments", () => {
    const invalid = (value: unknown) => assert.throws(() => parseListingsPage(200, value), (error: ApiError) => error.code === "invalid_response");
    invalid(null);
    invalid({ ...page(), contractVersion: "external-listings/v2" });
    invalid(page({ items: "x" }));
    invalid(page({ items: Array.from({ length: 51 }, () => item()) }));
    invalid(page({ hasMore: "oui" }));
    invalid(page({ nextCursor: "a b" }));
    invalid(page({ nextCursor: 5 }));
    for (const over of [{ score: 101 }, { score: -1 }, { score: "100" }, { title: "" }, { title: 5 }, { id: "x" }, { source: { code: "Demo A", name: "x" } }, { source: { code: "demo_a", name: "" } }, { price: { amount: -1, currency: "XOF" } }, { price: { amount: 1, currency: "xof" } }, { seenAt: "x" }, { alsoOn: [{ code: "?", name: "x" }] }]) {
      invalid(page({ items: [item(over)] }));
    }
  });

  test("administration : formes invalides refusées", () => {
    const valid = { contractVersion: "admin-collection/v1", schemaReady: true, readAt: NOW, sources: [], watches: { total: 0, active: 0, paused: 0, due: 0 }, listings: { available: 0, gone: 0, unknown: 0, groups: 0 }, errors: [] };
    assert.doesNotThrow(() => parseAdminCollection(200, valid));
    for (const bad of [{ ...valid, contractVersion: "x" }, { ...valid, watches: { total: -1, active: 0, paused: 0, due: 0 } }, { ...valid, sources: [{ code: "demo_a" }] }, { ...valid, errors: [{ at: "x" }] }, { ...valid, schemaReady: 1 }]) {
      assert.throws(() => parseAdminCollection(200, bad), (error: ApiError) => error.code === "invalid_response");
    }
  });
});

describe("erreurs", () => {
  test("le corps d'erreur du serveur est conservé ; un corps inattendu donne un code fixe ; une panne réseau aussi", async () => {
    const { api } = client(() => ({ status: 404, body: { error: { code: "resource_not_found", message: "Ressource introuvable." } } }));
    await assert.rejects(() => api.listings(DEMAND), (error: ApiError) => error.status === 404 && error.code === "resource_not_found");
    const odd = client(() => ({ status: 500, body: { oops: true } }));
    await assert.rejects(() => odd.api.listings(DEMAND), (error: ApiError) => error.status === 500 && error.code === "invalid_response");
    const offline = createExternalClient({ fetch: (async () => { throw new TypeError("secret réseau"); }) as unknown as typeof fetch });
    await assert.rejects(() => offline.listings(DEMAND), (error: ApiError) => error.code === "network_error" && !/secret/.test(error.message));
  });

  test("messages fixes en français, jamais le texte d'une exception ni du serveur", () => {
    assert.equal(describeExternalError(new ApiError(503, "external_unavailable", "interne"), "listings"), "Les annonces d'autres sites sont momentanément indisponibles.");
    assert.equal(describeExternalError(new ApiError(404, "resource_not_found", "x"), "listings"), "Ce besoin n'est plus disponible.");
    assert.equal(describeExternalError(new ApiError(404, "resource_not_found", "x"), "admin"), "Page introuvable.");
    assert.equal(describeExternalError(new ApiError(401, "authentication_required", "x"), "listings"), "Votre session a expiré. Reconnectez-vous pour continuer.");
    assert.equal(describeExternalError(new Error("stack secret"), "listings"), "Une erreur est survenue. Réessayez dans un instant.");
  });
});
