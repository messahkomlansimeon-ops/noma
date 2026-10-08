import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ApiError } from "../../lib/client/api";
import { cleanMarketParameter, createMarketClient, describeMarketError } from "../../lib/client/market-api";

/**
 * Client des prix demandés dans les annonces (lots H1, H1-bis et H1-ter) : requête exacte, paramètres contrôlés AVANT l'envoi, réponse relue champ par champ en LISTE BLANCHE STRICTE (un champ
 * en trop : un prix de vente, un identifiant… : la réponse est refusée), messages d'erreur fixes.
 */

interface Seen { url: string; method: string; credentials: string | undefined; cache: string | undefined }

function client(respond: (seen: Seen) => { status: number; body: unknown }) {
  const calls: Seen[] = [];
  const fetchStub = (async (input: string, init: RequestInit) => {
    const seen: Seen = { url: input, method: String(init.method), credentials: init.credentials, cache: init.cache };
    calls.push(seen);
    const answer = respond(seen);
    return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { api: createMarketClient({ fetch: fetchStub }), calls };
}

const listings = (overrides: Record<string, unknown> = {}) => ({
  status: "published",
  comparedTo: { scope: "exact", text: "Comparé à : iPhone 12 128 Go, Occasion" },
  count: { kind: "approx", value: 15 },
  sellers: { kind: "approx", value: 10 },
  excluded: { kind: "below", bound: 5 },
  median: 160_000,
  range: { q1: 152_000, q3: 176_000 },
  trend: [{ from: "2026-09-10", median: null }, { from: "2026-09-17", median: 160_000 }],
  ...overrides,
});
const body = (overrides: Record<string, unknown> = {}) => ({
  contractVersion: "market/v3", currency: "XOF", roundingXof: 500,
  period: { days: 90, from: "2026-07-10", to: "2026-10-07" },
  listings: listings(),
  ...overrides,
});

describe("requête", () => {
  test("GET /api/market avec les seuls paramètres utiles (texte réduit), même origine, sans cache ; variante, état et période facultatifs", async () => {
    const { api, calls } = client(() => ({ status: 200, body: body() }));
    await api.stats({ category: "Téléphones", brand: " Apple ", model: "iPhone  12", variant: "128 Go", condition: "Occasion", periodDays: 30 });
    await api.stats({ category: "Téléphones", brand: "Apple", model: "iPhone 12", variant: "  ", condition: null });
    assert.deepEqual(calls.map((call) => call.url), [
      "/api/market?category=T%C3%A9l%C3%A9phones&brand=Apple&model=iPhone+12&variant=128+Go&condition=Occasion&period=30",
      "/api/market?category=T%C3%A9l%C3%A9phones&brand=Apple&model=iPhone+12",
    ]);
    assert.ok(calls.every((call) => call.method === "GET" && call.credentials === "same-origin" && call.cache === "no-store"));
  });

  test("paramètre refusé AVANT l'envoi (`invalid_argument`, aucune requête) : catégorie, marque ou modèle absent ou trop long, période hors liste", async () => {
    const { api, calls } = client(() => ({ status: 200, body: body() }));
    const ok = { category: "Téléphones", brand: "Apple", model: "iPhone 12" };
    for (const query of [{ ...ok, category: "" }, { ...ok, brand: "   " }, { ...ok, model: "x".repeat(81) }, { ...ok, variant: "y".repeat(81) }, { ...ok, periodDays: 45 as never }]) {
      await assert.rejects(() => api.stats(query), (error: ApiError) => error.code === "invalid_argument" && error.status === 0);
    }
    assert.equal(calls.length, 0);
    assert.equal(cleanMarketParameter("  a   b "), "a b");
    assert.equal(cleanMarketParameter("x".repeat(80))?.length, 80);
    assert.equal(cleanMarketParameter(null), null);
  });
});

describe("réponse relue champ par champ", () => {
  const ok = { category: "Téléphones", brand: "Apple", model: "iPhone 12" };

  test("réponse valide : annonces seulement, champs exacts ; la fourchette est facultative", async () => {
    const { api } = client(() => ({ status: 200, body: body() }));
    const stats = await api.stats(ok);
    assert.deepEqual(Object.keys(stats).sort(), ["listings", "period"]);
    assert.deepEqual(Object.keys(stats.listings).sort(), ["comparedTo", "count", "excluded", "median", "range", "sellers", "status", "trend"]);
    assert.equal(stats.listings.status === "published" ? stats.listings.median : 0, 160_000);
    const noRange = client(() => ({ status: 200, body: body({ listings: listings({ range: null, excluded: null }) }) }));
    const parsed = await noRange.api.stats(ok);
    assert.equal(parsed.listings.status === "published" ? parsed.listings.range : "x", null);
    assert.deepEqual((await client(() => ({ status: 200, body: body({ listings: { status: "insufficient" } }) })).api.stats(ok)).listings, { status: "insufficient" });
  });

  const invalid: Array<[string, Record<string, unknown>]> = [
    ["autre version du contrat (la v1 publiait des ventes, la v2 comptait par annonce)", { contractVersion: "market/v1" }],
    ["version précédente du contrat (v2 : une valeur par annonce)", { contractVersion: "market/v2" }],
    ["autre devise", { currency: "EUR" }],
    ["autre arrondi", { roundingXof: 100 }],
    ["des statistiques de VENTES en tête de la réponse", { sales: { status: "published", median: 160_000 } }],
    ["un champ inconnu en tête", { leaked: true }],
    ["période inconnue", { period: { days: 45, from: "2026-07-10", to: "2026-10-07" } }],
    ["jour illisible", { period: { days: 90, from: "hier", to: "2026-10-07" } }],
    ["médiane non arrondie à 500", { listings: listings({ median: 160_001 }) }],
    ["médiane décimale", { listings: listings({ median: 160_000.5 }) }],
    ["fourchette qui n'est pas un multiple de 5 % de la médiane (quartile exact)", { listings: listings({ range: { q1: 151_250, q3: 176_000 } }) }],
    ["fourchette dans le désordre", { listings: listings({ range: { q1: 176_000, q3: 152_000 } }) }],
    ["fourchette qui ne contient pas la médiane", { listings: listings({ range: { q1: 168_000, q3: 176_000 } }) }],
    ["fourchette avec champ en trop", { listings: listings({ range: { q1: 152_000, q3: 176_000, min: 100_000 } }) }],
    ["médiane nulle avec fourchette", { listings: listings({ median: 0, range: { q1: 0, q3: 0 } }) }],
    ["borne de fourchette à 0 (jamais publiée)", { listings: listings({ range: { q1: 0, q3: 176_000 } }) }],
    ["effectif exact", { listings: listings({ count: { kind: "approx", value: 17 } }) }],
    ["effectif « moins de » faux", { listings: listings({ count: { kind: "below", bound: 3 } }) }],
    ["effectif avec champ en trop", { listings: listings({ count: { kind: "approx", value: 15, exact: 17 } }) }],
    ["nombre de vendeurs exact", { listings: listings({ sellers: { kind: "approx", value: 7 } }) }],
    ["nombre de vendeurs « moins de » faux", { listings: listings({ sellers: { kind: "below", bound: 3 } }) }],
    ["nombre de vendeurs absent", { listings: Object.fromEntries(Object.entries(listings()).filter(([key]) => key !== "sellers")) }],
    ["nombre de vendeurs sous forme de liste d'identifiants", { listings: listings({ sellers: ["a", "b"] }) }],
    ["annonces écartées exactes", { listings: listings({ excluded: { kind: "approx", value: 7 } }) }],
    ["portée inconnue", { listings: listings({ comparedTo: { scope: "everything", text: "x" } }) }],
    ["phrase vide", { listings: listings({ comparedTo: { scope: "exact", text: "" } }) }],
    ["tendance trop longue", { listings: listings({ trend: Array.from({ length: 61 }, () => ({ from: "2026-09-10", median: 1000 })) }) }],
    ["point de tendance non arrondi", { listings: listings({ trend: [{ from: "2026-09-10", median: 1001 }] }) }],
    ["point de tendance avec champ en trop", { listings: listings({ trend: [{ from: "2026-09-10", median: 1000, count: 3 }] }) }],
    ["annonces avec champ en trop (identifiants de vendeurs)", { listings: listings({ sellerIds: ["a", "b"] }) }],
    ["annonces avec un minimum", { listings: listings({ minimum: 100_000 }) }],
    ["annonces avec des ventes", { listings: listings({ sales: { median: 160_000 } }) }],
    ["source inconnue", { listings: { status: "maybe" } }],
    ["source « insuffisante » qui porte un chiffre", { listings: { status: "insufficient", median: 160_000 } }],
    ["annonces absentes", { listings: null }],
  ];
  for (const [name, overrides] of invalid) {
    test(`refusée (réponse inattendue) : ${name}`, async () => {
      const { api } = client(() => ({ status: 200, body: body(overrides) }));
      await assert.rejects(() => api.stats(ok), (error: ApiError) => error.code === "invalid_response");
    });
  }

  test("erreurs du serveur : statut et code conservés ; corps illisible : réponse inattendue ; réseau : code fixe", async () => {
    const { api } = client(() => ({ status: 429, body: { error: { code: "rate_limited", message: "Trop de demandes." } } }));
    await assert.rejects(() => api.stats(ok), (error: ApiError) => error.status === 429 && error.code === "rate_limited");
    const broken = client(() => ({ status: 500, body: "pas du json attendu" }));
    await assert.rejects(() => broken.api.stats(ok), (error: ApiError) => error.status === 500 && error.code === "invalid_response");
    const down = createMarketClient({ fetch: (async () => { throw new Error("secret: host=10.0.0.1"); }) as unknown as typeof fetch });
    await assert.rejects(() => down.stats(ok), (error: ApiError) => error.status === 0 && !error.message.includes("10.0.0.1"));
  });
});

describe("administration", () => {
  const adminBody = (rows: unknown[], extra: Record<string, unknown> = {}) => ({
    contractVersion: "market-admin/v3", currency: "XOF", roundingXof: 500, period: { days: 90, from: "2026-07-10", to: "2026-10-07" }, rows, ...extra,
  });
  const row = (label: string, extra: Record<string, unknown> = {}) => ({ label, listings: listings(), confirmedSales: { kind: "approx", value: 5 }, ...extra });

  test("tableau relu (20 lignes au plus) : prix demandés et NOMBRE arrondi de ventes confirmées ; libellé obligatoire", async () => {
    const { api, calls } = client(() => ({ status: 200, body: adminBody([row("Apple iPhone 12 · 128 Go · Occasion")]) }));
    const result = await api.admin();
    assert.equal(result.rows[0].label, "Apple iPhone 12 · 128 Go · Occasion");
    assert.deepEqual(result.rows[0].confirmedSales, { kind: "approx", value: 5 });
    assert.equal(calls[0].url, "/api/admin/market");
    await assert.rejects(() => client(() => ({ status: 200, body: adminBody([row("")]) })).api.admin());
    await assert.rejects(() => client(() => ({ status: 200, body: adminBody(Array.from({ length: 21 }, () => row("x"))) })).api.admin());
  });

  test("jamais un prix de vente : un prix, un nombre exact ou un champ en trop dans une ligne fait refuser la réponse", async () => {
    for (const extra of [{ salePrice: 777_000 }, { sales: { median: 777_000 } }, { confirmedSales: { kind: "approx", value: 7 } }, { confirmedSales: 7 }, { confirmedSales: { kind: "approx", value: 5, median: 777_000 } }]) {
      await assert.rejects(() => client(() => ({ status: 200, body: adminBody([row("x", extra)]) })).api.admin(), (error: ApiError) => error.code === "invalid_response", JSON.stringify(extra));
    }
    await assert.rejects(() => client(() => ({ status: 200, body: adminBody([row("x")], { sales: [] }) })).api.admin(), (error: ApiError) => error.code === "invalid_response");
    await assert.rejects(() => client(() => ({ status: 200, body: { ...adminBody([row("x")]), contractVersion: "market-admin/v1" } })).api.admin(), (error: ApiError) => error.code === "invalid_response");
  });

  test("404 conservé (un compte ordinaire ne devine pas la route)", async () => {
    const { api } = client(() => ({ status: 404, body: { error: { code: "resource_not_found", message: "Ressource introuvable." } } }));
    await assert.rejects(() => api.admin(), (error: ApiError) => error.status === 404);
  });
});

describe("messages d'erreur fixes", () => {
  test("429, 401 et tout le reste : un texte fixe, jamais celui de l'exception ni du serveur", () => {
    assert.match(describeMarketError(new ApiError(429, "rate_limited", "secret")), /Réessayez dans une minute/);
    assert.match(describeMarketError(new ApiError(401, "authentication_required", "secret")), /session a expiré/);
    for (const error of [new ApiError(503, "market_unavailable", "secret"), new Error("secret"), "secret", null]) {
      const text = describeMarketError(error);
      assert.equal(text, "Les prix demandés ne sont pas disponibles pour le moment.");
      assert.ok(!text.includes("secret"));
    }
  });
});
