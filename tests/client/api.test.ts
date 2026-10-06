import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  API_ABORTED,
  API_INVALID_ARGUMENT,
  API_INVALID_ID,
  API_INVALID_RESPONSE,
  API_NETWORK_ERROR,
  ApiError,
  GENERIC_ERROR_MESSAGE,
  LIST_ALL_MAX_PAGES,
  PAGE_LIMIT,
  createApiClient,
  describeApiError,
  isUnauthorized,
  type ApiErrorContext,
} from "../../lib/client/api";

interface Captured {
  url: string;
  init: RequestInit;
}

type Responder = (request: Captured, index: number) => Response | Promise<Response>;

function harness(responder: Responder) {
  const calls: Captured[] = [];
  const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const captured = { url: String(input), init: init ?? {} };
    calls.push(captured);
    return responder(captured, calls.length - 1);
  }) as typeof fetch;
  return { client: createApiClient({ fetch: fakeFetch }), calls };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function offerFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: "6f1d4f5c-9d2e-4d8e-8f56-0a8b9f0a1b2c",
    status: "draft",
    rawText: "iPhone 12 128 Go",
    category: "Téléphones",
    brand: "Apple",
    model: "iPhone 12",
    variant: "128 Go",
    attributes: null,
    condition: "Occasion",
    quantity: null,
    unit: null,
    location: "Abidjan",
    deadlineAt: null,
    contentVersion: 1,
    createdAt: "2031-01-01T10:00:00.000Z",
    updatedAt: "2031-01-01T10:00:00.000Z",
    archivedAt: null,
    price: { amount: 150000, currency: "XOF" },
    availabilityStatus: "available",
    ...overrides,
  };
}

function demandFixture(overrides: Record<string, unknown> = {}) {
  const { price: _price, availabilityStatus: _availability, ...common } = offerFixture();
  void _price;
  void _availability;
  return {
    ...common,
    status: "draft",
    budget: { amount: 200000, currency: "XOF" },
    requirements: null,
    preferences: null,
    ...overrides,
  };
}

function headerOf(call: Captured, name: string): string | undefined {
  const headers = call.init.headers as Record<string, string> | undefined;
  return headers?.[name];
}

const ID = "6f1d4f5c-9d2e-4d8e-8f56-0a8b9f0a1b2c";

describe("couche cliente : requêtes (même origine, JSON, cookies)", () => {
  test("toutes les requêtes sont envoyées en même origine, sans cache, avec Accept JSON", async () => {
    const { client, calls } = harness(() => json(200, { userId: ID }));
    await client.auth.session();
    assert.equal(calls[0].url, "/api/auth/session");
    assert.equal(calls[0].init.method, "GET");
    assert.equal(calls[0].init.credentials, "same-origin");
    assert.equal(calls[0].init.cache, "no-store");
    assert.equal(headerOf(calls[0], "Accept"), "application/json");
    assert.equal(calls[0].init.body, undefined);
    assert.equal(headerOf(calls[0], "Content-Type"), undefined);
  });

  test("requestOtp : POST /api/auth/otp/request avec { phone } et Content-Type JSON", async () => {
    const { client, calls } = harness(() =>
      json(202, { challengeId: ID, expiresAt: "2031-01-01T10:05:00.000Z", resendAvailableAt: "2031-01-01T10:01:00.000Z" }),
    );
    const challenge = await client.auth.requestOtp("+2250700000042");
    assert.deepEqual(challenge, {
      challengeId: ID,
      expiresAt: "2031-01-01T10:05:00.000Z",
      resendAvailableAt: "2031-01-01T10:01:00.000Z",
    });
    assert.equal(calls[0].url, "/api/auth/otp/request");
    assert.equal(calls[0].init.method, "POST");
    assert.equal(calls[0].init.credentials, "same-origin");
    assert.equal(headerOf(calls[0], "Content-Type"), "application/json");
    assert.equal(calls[0].init.body, JSON.stringify({ phone: "+2250700000042" }));
  });

  test("verifyOtp : POST /api/auth/otp/verify avec exactement { challengeId, code }", async () => {
    const { client, calls } = harness(() => json(200, { userId: ID }));
    assert.deepEqual(await client.auth.verifyOtp(ID, "123456"), { userId: ID });
    assert.equal(calls[0].url, "/api/auth/otp/verify");
    assert.equal(calls[0].init.body, JSON.stringify({ challengeId: ID, code: "123456" }));
  });

  test("logout : POST sans corps ni Content-Type, 204 accepté", async () => {
    const { client, calls } = harness(() => new Response(null, { status: 204 }));
    await client.auth.logout();
    assert.equal(calls[0].url, "/api/auth/logout");
    assert.equal(calls[0].init.method, "POST");
    assert.equal(calls[0].init.body, undefined);
    assert.equal(headerOf(calls[0], "Content-Type"), undefined);
  });

  test("sessionOutcome : 200 connecté, 401 anonyme, 503/réseau/réponse inattendue indisponible", async () => {
    const outcome = async (responder: Responder) => harness(responder).client.auth.sessionOutcome();
    assert.deepEqual(await outcome(() => json(200, { userId: ID })), { kind: "authenticated", userId: ID });
    assert.deepEqual(
      await outcome(() => json(401, { error: { code: "authentication_refused", message: "Authentification refusée." } })),
      { kind: "anonymous" },
    );
    assert.deepEqual(
      await outcome(() => json(503, { error: { code: "auth_unavailable", message: "Indisponible." } })),
      { kind: "unavailable" },
    );
    assert.deepEqual(await outcome(() => { throw new TypeError("fetch failed"); }), { kind: "unavailable" });
    assert.deepEqual(await outcome(() => new Response("<html>502</html>", { status: 502 })), { kind: "unavailable" });
    assert.deepEqual(await outcome(() => json(200, { nope: true })), { kind: "unavailable" });
  });

  test("sessionOutcome : une requête interrompue est propagée, jamais prise pour une panne", async () => {
    const controller = new AbortController();
    const { client } = harness(() => {
      controller.abort();
      throw new DOMException("The operation was aborted.", "AbortError");
    });
    await assert.rejects(
      client.auth.sessionOutcome({ signal: controller.signal }),
      (error: unknown) => error instanceof ApiError && error.code === API_ABORTED,
    );
  });
});

describe("couche cliente : offres", () => {
  test("list : GET /api/offers avec limit et offset seulement", async () => {
    const { client, calls } = harness(() => json(200, { offers: [offerFixture()], pagination: { limit: 20, offset: 0 } }));
    const result = await client.offers.list({ limit: 20, offset: 40 });
    assert.equal(calls[0].url, "/api/offers?limit=20&offset=40");
    assert.equal(result.offers.length, 1);
    assert.deepEqual(result.pagination, { limit: 20, offset: 0 });
    await client.offers.list();
    assert.equal(calls[1].url, "/api/offers");
  });

  test("listAll : pages de 100, s'arrête à la première page incomplète", async () => {
    const full = Array.from({ length: PAGE_LIMIT }, (_, index) =>
      offerFixture({ id: `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}` }),
    );
    const { client, calls } = harness((request, index) =>
      json(200, { offers: index === 0 ? full : [offerFixture()], pagination: { limit: PAGE_LIMIT, offset: index * PAGE_LIMIT } }),
    );
    const all = await client.offers.listAll();
    assert.equal(all.items.length, PAGE_LIMIT + 1);
    assert.equal(all.truncated, false);
    assert.deepEqual(calls.map((call) => call.url), [
      `/api/offers?limit=${PAGE_LIMIT}&offset=0`,
      `/api/offers?limit=${PAGE_LIMIT}&offset=${PAGE_LIMIT}`,
    ]);
  });

  test("listAll : au-delà du plafond de pages, la troncature est signalée (jamais silencieuse)", async () => {
    const { client, calls } = harness((request, index) => {
      const limit = Number(new URL(request.url, "http://x").searchParams.get("limit"));
      const offers =
        index < LIST_ALL_MAX_PAGES
          ? Array.from({ length: PAGE_LIMIT }, (_, row) =>
              offerFixture({ id: `00000000-0000-4000-8000-${(index * PAGE_LIMIT + row).toString().padStart(12, "0")}` }),
            )
          : [offerFixture({ id: "ffffffff-ffff-4fff-8fff-ffffffffffff" })];
      return json(200, { offers, pagination: { limit, offset: 0 } });
    });
    const all = await client.offers.listAll();
    assert.equal(all.truncated, true);
    assert.equal(all.items.length, LIST_ALL_MAX_PAGES * PAGE_LIMIT);
    assert.equal(calls.length, LIST_ALL_MAX_PAGES + 1);
  });

  test("listAll : exactement le plafond de pages et rien après → liste complète, non tronquée", async () => {
    const { client } = harness((request, index) => {
      const limit = Number(new URL(request.url, "http://x").searchParams.get("limit"));
      const offers =
        index < LIST_ALL_MAX_PAGES
          ? Array.from({ length: PAGE_LIMIT }, (_, row) =>
              offerFixture({ id: `00000000-0000-4000-8000-${(index * PAGE_LIMIT + row).toString().padStart(12, "0")}` }),
            )
          : [];
      return json(200, { offers, pagination: { limit, offset: 0 } });
    });
    const all = await client.offers.listAll();
    assert.equal(all.truncated, false);
    assert.equal(all.items.length, LIST_ALL_MAX_PAGES * PAGE_LIMIT);
  });

  test("create : POST /api/offers avec le contenu tel quel, réponse 201 { offer }", async () => {
    const input = {
      rawText: "iPhone 12",
      category: "Téléphones",
      brand: "Apple",
      model: "iPhone 12",
      price: { amount: 150000, currency: "XOF" },
      availabilityStatus: "available" as const,
    };
    const { client, calls } = harness(() => json(201, { offer: offerFixture() }));
    const offer = await client.offers.create(input);
    assert.equal(offer.status, "draft");
    assert.equal(offer.contentVersion, 1);
    assert.equal(calls[0].url, "/api/offers");
    assert.equal(calls[0].init.method, "POST");
    assert.equal(calls[0].init.body, JSON.stringify(input));
  });

  test("get : GET /api/offers/{id} avec un identifiant UUID", async () => {
    const { client, calls } = harness(() => json(200, { offer: offerFixture() }));
    await client.offers.get(ID);
    await client.offers.get(ID.toUpperCase());
    assert.equal(calls[0].url, `/api/offers/${ID}`);
    assert.equal(calls[1].url, `/api/offers/${ID.toUpperCase()}`);
    assert.equal(calls[0].init.method, "GET");
  });

  test("update : PATCH avec expectedContentVersion puis les champs modifiés", async () => {
    const { client, calls } = harness(() => json(200, { offer: offerFixture({ contentVersion: 4 }) }));
    const offer = await client.offers.update(ID, 3, { price: { amount: 140000, currency: "XOF" }, location: null });
    assert.equal(offer.contentVersion, 4);
    assert.equal(calls[0].url, `/api/offers/${ID}`);
    assert.equal(calls[0].init.method, "PATCH");
    assert.equal(
      calls[0].init.body,
      JSON.stringify({ expectedContentVersion: 3, price: { amount: 140000, currency: "XOF" }, location: null }),
    );
  });

  test("publish, pause, archive : POST sur la sous-route avec exactement { expectedContentVersion }", async () => {
    const { client, calls } = harness(() => json(200, { offer: offerFixture({ status: "published", contentVersion: 2 }) }));
    await client.offers.publish(ID, 1);
    await client.offers.pause(ID, 2);
    await client.offers.archive(ID, 3);
    assert.deepEqual(calls.map((call) => [call.init.method, call.url, call.init.body]), [
      ["POST", `/api/offers/${ID}/publish`, JSON.stringify({ expectedContentVersion: 1 })],
      ["POST", `/api/offers/${ID}/pause`, JSON.stringify({ expectedContentVersion: 2 })],
      ["POST", `/api/offers/${ID}/archive`, JSON.stringify({ expectedContentVersion: 3 })],
    ]);
  });
});

describe("couche cliente : besoins", () => {
  test("list, create, get", async () => {
    const { client, calls } = harness((request) => {
      if (request.init.method === "POST") return json(201, { demand: demandFixture() });
      if (request.url.startsWith("/api/demands/")) return json(200, { demand: demandFixture() });
      return json(200, { demands: [demandFixture()], pagination: { limit: 20, offset: 0 } });
    });
    assert.equal((await client.demands.list({ limit: 20 })).demands.length, 1);
    const input = { rawText: "iPhone 12", budget: { amount: 200000, currency: "XOF" } };
    const created = await client.demands.create(input);
    assert.equal(created.status, "draft");
    assert.equal(created.budget?.amount, 200000);
    await client.demands.get(ID);
    assert.deepEqual(calls.map((call) => [call.init.method, call.url]), [
      ["GET", "/api/demands?limit=20"],
      ["POST", "/api/demands"],
      ["GET", `/api/demands/${ID}`],
    ]);
    assert.equal(calls[1].init.body, JSON.stringify(input));
  });

  test("activate, satisfy, archive : POST avec exactement { expectedContentVersion }", async () => {
    const { client, calls } = harness(() => json(200, { demand: demandFixture({ status: "active", contentVersion: 2 }) }));
    await client.demands.activate(ID, 1);
    await client.demands.satisfy(ID, 2);
    await client.demands.archive(ID, 3);
    assert.deepEqual(calls.map((call) => [call.init.method, call.url, call.init.body]), [
      ["POST", `/api/demands/${ID}/activate`, JSON.stringify({ expectedContentVersion: 1 })],
      ["POST", `/api/demands/${ID}/satisfy`, JSON.stringify({ expectedContentVersion: 2 })],
      ["POST", `/api/demands/${ID}/archive`, JSON.stringify({ expectedContentVersion: 3 })],
    ]);
  });

  test("listAll s'arrête à la première page incomplète", async () => {
    const { client, calls } = harness(() => json(200, { demands: [demandFixture()], pagination: { limit: 100, offset: 0 } }));
    const all = await client.demands.listAll();
    assert.equal(all.items.length, 1);
    assert.equal(all.truncated, false);
    assert.equal(calls.length, 1);
  });

  test("listAll : au-delà du plafond de pages, la troncature est signalée (jamais silencieuse)", async () => {
    const page = (index: number) =>
      Array.from({ length: PAGE_LIMIT }, (_, row) =>
        demandFixture({ id: `00000000-0000-4000-8000-${(index * PAGE_LIMIT + row).toString().padStart(12, "0")}` }),
      );
    const { client, calls } = harness((request, index) => {
      const limit = Number(new URL(request.url, "http://x").searchParams.get("limit"));
      return json(200, {
        demands: index < LIST_ALL_MAX_PAGES ? page(index) : [demandFixture({ id: "ffffffff-ffff-4fff-8fff-ffffffffffff" })],
        pagination: { limit, offset: 0 },
      });
    });
    const all = await client.demands.listAll();
    assert.equal(all.truncated, true);
    assert.equal(all.items.length, LIST_ALL_MAX_PAGES * PAGE_LIMIT);
    assert.equal(calls.length, LIST_ALL_MAX_PAGES + 1);
  });

  test("listAll : exactement le plafond de pages et rien après → liste complète, non tronquée", async () => {
    const { client } = harness((request, index) => {
      const limit = Number(new URL(request.url, "http://x").searchParams.get("limit"));
      const demands =
        index < LIST_ALL_MAX_PAGES
          ? Array.from({ length: PAGE_LIMIT }, (_, row) =>
              demandFixture({ id: `00000000-0000-4000-8000-${(index * PAGE_LIMIT + row).toString().padStart(12, "0")}` }),
            )
          : [];
      return json(200, { demands, pagination: { limit, offset: 0 } });
    });
    const all = await client.demands.listAll();
    assert.equal(all.truncated, false);
    assert.equal(all.items.length, LIST_ALL_MAX_PAGES * PAGE_LIMIT);
  });
});

describe("couche cliente : identifiants validés au format UUID avant toute requête", () => {
  const BAD_IDS = ["a/b?c", "../x", "", "123", `${ID}/x`, `${ID}?a=1`, "%2e%2e", "not-a-uuid", `${ID} `, "6f1d4f5c-9d2e-0d8e-8f56-0a8b9f0a1b2c"];

  async function refuses(call: (client: ReturnType<typeof createApiClient>, id: string) => Promise<unknown>) {
    for (const bad of BAD_IDS) {
      const { client, calls } = harness(() => json(200, { offer: offerFixture(), demand: demandFixture() }));
      await assert.rejects(
        call(client, bad),
        (error: unknown) => error instanceof ApiError && error.code === "invalid_id" && error.status === 0,
        JSON.stringify(bad),
      );
      assert.equal(calls.length, 0, `aucune requête pour ${JSON.stringify(bad)}`);
    }
  }

  test("offres : get, update, publish, pause, archive refusent un identifiant invalide sans requête", async () => {
    await refuses((client, id) => client.offers.get(id));
    await refuses((client, id) => client.offers.update(id, 1, { location: null }));
    await refuses((client, id) => client.offers.publish(id, 1));
    await refuses((client, id) => client.offers.pause(id, 1));
    await refuses((client, id) => client.offers.archive(id, 1));
  });

  test("besoins : get, activate, satisfy, archive refusent un identifiant invalide sans requête", async () => {
    await refuses((client, id) => client.demands.get(id));
    await refuses((client, id) => client.demands.activate(id, 1));
    await refuses((client, id) => client.demands.satisfy(id, 1));
    await refuses((client, id) => client.demands.archive(id, 1));
  });

  test("un UUID valide (casse quelconque) passe ; l'erreur invalid_id a un message fixe en français", async () => {
    const { client, calls } = harness(() => json(200, { demand: demandFixture() }));
    await client.demands.get(ID);
    await client.demands.get(ID.toUpperCase());
    assert.equal(calls.length, 2);
    const error = new ApiError(0, "invalid_id", "x");
    assert.equal(describeApiError(error), "Identifiant invalide. Rechargez la page.");
    assert.equal(isUnauthorized(error), false);
  });
});

describe("couche cliente : ApiError construite uniquement depuis le corps du serveur", () => {
  test("corps { error: { code, message } } : status, code et message viennent du serveur", async () => {
    const { client } = harness(() =>
      json(409, { error: { code: "content_version_conflict", message: "Version de contenu obsolète." } }),
    );
    await assert.rejects(client.offers.publish(ID, 1), (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, 409);
      assert.equal(error.code, "content_version_conflict");
      assert.equal(error.message, "Version de contenu obsolète.");
      return true;
    });
  });

  test("réponse d'erreur sans la forme attendue (HTML, JSON libre, code invalide) : invalid_response, texte fixe", async () => {
    const bodies = [
      new Response("<html><body>Bad gateway SECRET-HOST</body></html>", { status: 502 }),
      json(500, { message: "boom SECRET" }),
      json(500, { error: "SECRET" }),
      json(500, { error: { code: "Code Invalide", message: "SECRET" } }),
      json(500, { error: { code: "ok_code", message: 42 } }),
      new Response(null, { status: 500 }),
    ];
    for (const response of bodies) {
      const { client } = harness(() => response);
      await assert.rejects(client.auth.session(), (error: unknown) => {
        assert.ok(error instanceof ApiError);
        assert.equal(error.code, API_INVALID_RESPONSE);
        assert.equal(error.message.includes("SECRET"), false);
        return true;
      });
    }
  });

  test("panne réseau : code network_error, jamais le texte de l'exception", async () => {
    const { client } = harness(() => {
      throw new TypeError("connect ECONNREFUSED 10.0.0.5:5432 password=hunter2");
    });
    await assert.rejects(client.offers.list(), (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, 0);
      assert.equal(error.code, API_NETWORK_ERROR);
      for (const text of [error.message, String(error), describeApiError(error, "catalog")]) {
        assert.equal(text.includes("ECONNREFUSED"), false);
        assert.equal(text.includes("hunter2"), false);
      }
      return true;
    });
  });

  test("succès au mauvais format (champ manquant, statut inconnu, pas de JSON) : invalid_response", async () => {
    const bad = [
      json(201, { offer: offerFixture({ contentVersion: undefined }) }),
      json(201, { offer: offerFixture({ status: "weird" }) }),
      json(201, { offer: offerFixture({ price: { amount: "x", currency: "XOF" } }) }),
      json(201, { demand: demandFixture() }),
      json(201, { offer: "texte" }),
      new Response("pas du json", { status: 201 }),
    ];
    for (const response of bad) {
      const { client } = harness(() => response);
      await assert.rejects(
        client.offers.create({ rawText: "x" }),
        (error: unknown) => error instanceof ApiError && error.code === API_INVALID_RESPONSE,
      );
    }
  });
});

describe("messages fixes en français pour l'utilisateur", () => {
  const contexts: ApiErrorContext[] = ["otp-request", "otp-verify", "catalog", "matches", "boost", "default"];

  test("les statuts d'authentification 400, 401, 429 et 503 ont chacun un message fixe distinct", () => {
    const message = (status: number, context: ApiErrorContext) =>
      describeApiError(new ApiError(status, "x_code", "ignoré"), context);
    assert.equal(message(400, "otp-request"), "Numéro de téléphone invalide. Vérifiez-le et réessayez.");
    assert.equal(message(400, "otp-verify"), "Code invalide. Saisissez les 6 chiffres reçus.");
    assert.equal(message(401, "otp-verify"), "Code incorrect ou expiré. Vérifiez-le ou demandez un nouveau code.");
    assert.equal(message(429, "otp-request"), "Trop de demandes de code. Patientez quelques minutes avant de réessayer.");
    assert.equal(message(503, "otp-request"), "Le service est temporairement indisponible. Réessayez dans un instant.");
    assert.equal(message(503, "otp-verify"), "Le service est temporairement indisponible. Réessayez dans un instant.");
  });

  test("409 du catalogue : un message par code", () => {
    const message = (code: string) => describeApiError(new ApiError(409, code, "ignoré"), "catalog");
    assert.match(message("content_version_conflict"), /modifié entre-temps/);
    assert.match(message("resource_archived"), /archivé/);
    assert.match(message("status_transition_conflict"), /Action impossible/);
    assert.equal(message("autre"), GENERIC_ERROR_MESSAGE);
  });

  test("le message du serveur n'est jamais repris", () => {
    for (const context of contexts) {
      for (const status of [0, 400, 401, 403, 404, 409, 413, 429, 500, 503]) {
        const text = describeApiError(new ApiError(status, "some_code", "<script>alert(1)</script> SERVER-TEXT"), context);
        assert.equal(text.includes("SERVER-TEXT"), false, `${context}/${status}`);
        assert.equal(text.includes("<script>"), false, `${context}/${status}`);
      }
    }
  });

  test("une exception quelconque n'est jamais affichée : message générique", () => {
    for (const context of contexts) {
      for (const raw of [new Error("ECONNRESET secret-token"), new TypeError("x.y is undefined"), "texte brut", null, undefined, { message: "obj" }]) {
        assert.equal(describeApiError(raw, context), GENERIC_ERROR_MESSAGE);
      }
    }
  });

  test("isUnauthorized : seulement un ApiError de statut 401", () => {
    assert.equal(isUnauthorized(new ApiError(401, "authentication_required", "x")), true);
    assert.equal(isUnauthorized(new ApiError(403, "invalid_origin", "x")), false);
    assert.equal(isUnauthorized(new Error("401")), false);
    assert.equal(isUnauthorized(null), false);
  });
});

// ─── Correspondances enregistrées et cotations de boost (lot E1b) ───────────────────────────────────

const BUYER_ID = "22222222-2222-4222-8222-222222222222";
const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const PHONE = "+2250700000042";
const CURSOR = "eyJ2IjoxLCJzb3VyY2VLaW5kIjoiZGVtYW5kIn0";

function matchDto(overrides: Record<string, unknown> = {}) {
  return {
    candidateId: ID,
    candidateContentVersion: 2,
    candidate: {
      id: ID,
      contentVersion: 2,
      category: "Téléphones",
      brand: "Apple",
      model: "iPhone 12",
      variant: "128 Go",
      condition: "Occasion",
      quantity: null,
      unit: null,
      location: "Abidjan",
      deadlineAt: null,
      price: { amount: 150000, currency: "XOF" },
      availabilityStatus: "available",
    },
    compatibilityStatus: "compatible",
    score: 92.4,
    coverage: 1,
    evaluation: { status: "compatible", summary: { matchedCount: 3, mismatchedCount: 0, unknownCount: 0, totalExploitableCriteria: 3 } },
    scoring: { score: 92.4, coverage: 1, summary: {}, preferences: {} },
    evaluatedAt: "2031-01-01T10:00:00.000Z",
    indicators: {
      availability: { level: "confirmed_recent", score: 100, confirmedAgeHours: 3, factors: [] },
      price: { position: "below_market", score: 100, deltaPercent: -12, sampleSize: 8, factors: [] },
      confidence: { level: "high", score: 91, accountAgeBand: "gte_30d", factors: ["phone_verified"] },
    },
    relevance: 88.5,
    sponsored: false,
    ...overrides,
  };
}

function matchesPageDto(items: unknown[], overrides: Record<string, unknown> = {}) {
  return {
    contractVersion: "matching-stored-http/v1",
    source: { id: BUYER_ID, contentVersion: 1, category: "Téléphones", brand: "Apple", model: "iPhone 12", variant: null, condition: null, quantity: null, unit: null, location: null, deadlineAt: null, budget: { amount: 200000, currency: "XOF" } },
    items,
    processing: false,
    readAt: "2031-01-01T10:00:05.000Z",
    nextCursor: null,
    hasMore: false,
    limit: 20,
    truncated: false,
    ...overrides,
  };
}

describe("couche cliente : correspondances enregistrées (storedMatches)", () => {
  test("besoin : GET /api/demands/{id}/stored-matches avec sort et curseur, paramètres encodés", async () => {
    const { client, calls } = harness(() => json(200, matchesPageDto([matchDto()], { nextCursor: CURSOR, hasMore: true })));
    const page = await client.demands.storedMatches(BUYER_ID, { sort: "relevance", cursor: CURSOR, limit: 20 });
    assert.equal(calls[0].url, `/api/demands/${BUYER_ID}/stored-matches?sort=relevance&cursor=${CURSOR}&limit=20`);
    assert.equal(calls[0].init.method, "GET");
    assert.equal(calls[0].init.credentials, "same-origin");
    assert.equal(calls[0].init.body, undefined);
    assert.equal(page.items.length, 1);
    assert.equal(page.nextCursor, CURSOR);
    assert.equal(page.hasMore, true);
    assert.equal(page.processing, false);
    await client.demands.storedMatches(BUYER_ID);
    assert.equal(calls[1].url, `/api/demands/${BUYER_ID}/stored-matches`);
  });

  test("offre : GET /api/offers/{id}/stored-matches", async () => {
    const { client, calls } = harness(() => json(200, matchesPageDto([])));
    await client.offers.storedMatches(ID, { sort: "score" });
    assert.equal(calls[0].url, `/api/offers/${ID}/stored-matches?sort=score`);
  });

  test("un curseur à caractères spéciaux est encodé dans l'URL", async () => {
    const { client, calls } = harness(() => json(200, matchesPageDto([])));
    await client.demands.storedMatches(BUYER_ID, { cursor: "a+b/c=d&e" });
    assert.equal(calls[0].url, `/api/demands/${BUYER_ID}/stored-matches?cursor=a%2Bb%2Fc%3Dd%26e`);
  });

  test("identifiant non UUID ou paramètre invalide : ApiError sans AUCUNE requête", async () => {
    const { client, calls } = harness(() => json(200, matchesPageDto([])));
    for (const bad of ["", "../auth/session", `${ID}/extra`, "pas-un-uuid", `${ID}?x=1`]) {
      await assert.rejects(client.demands.storedMatches(bad), (error: unknown) => error instanceof ApiError && error.code === API_INVALID_ID && error.status === 0);
      await assert.rejects(client.offers.storedMatches(bad), (error: unknown) => error instanceof ApiError && error.code === API_INVALID_ID);
    }
    for (const query of [
      { sort: "price" },
      { sort: "" },
      { cursor: "" },
      { cursor: "x".repeat(513) },
      { limit: 0 },
      { limit: 101 },
      { limit: 1.5 },
      { limit: Number.NaN },
    ]) {
      await assert.rejects(
        client.demands.storedMatches(BUYER_ID, query as never),
        (error: unknown) => error instanceof ApiError && error.code === API_INVALID_ARGUMENT && error.status === 0,
        JSON.stringify(query),
      );
    }
    assert.equal(calls.length, 0);
  });

  test("lecture en liste blanche : ni identité du propriétaire, ni texte brut, ni champ inconnu n'atteint l'écran", async () => {
    const hostile = matchDto({
      ownerId: OWNER_ID,
      owner: { id: OWNER_ID, phone: PHONE },
      sellerPhone: PHONE,
      rawText: "texte brut du vendeur",
      candidate: { ...matchDto().candidate, ownerId: OWNER_ID, phone: PHONE, rawText: "texte brut" },
    });
    const { client } = harness(() => json(200, matchesPageDto([hostile], { ownerId: OWNER_ID })));
    const page = await client.demands.storedMatches(BUYER_ID);
    const text = JSON.stringify(page);
    for (const secret of [OWNER_ID, PHONE, "texte brut"]) assert.equal(text.includes(secret), false, secret);
    assert.deepEqual(Object.keys(page.items[0]).sort(), [
      "candidate", "candidateId", "compatibilityStatus", "coverage", "evaluatedAt", "indicators", "relevance", "score", "sponsored",
    ]);
    assert.deepEqual(Object.keys(page.items[0].candidate).sort(), [
      "availabilityStatus", "brand", "budget", "category", "condition", "deadlineAt", "location", "model", "price", "quantity", "unit", "variant",
    ]);
    assert.equal(page.items[0].candidate.price?.amount, 150000);
    assert.equal(page.items[0].candidate.budget, null);
    assert.equal(page.items[0].indicators.price?.position, "below_market");
    assert.equal(page.items[0].sponsored, false);
    assert.equal(page.source.budget?.amount, 200000);
  });

  test("disponibilité de l'offre en liste blanche : seules available, reserved, unavailable (ou absente) sont acceptées", async () => {
    for (const status of ["available", "reserved", "unavailable", null]) {
      const { client } = harness(() => json(200, matchesPageDto([matchDto({ candidate: { ...matchDto().candidate, availabilityStatus: status } })])));
      const page = await client.demands.storedMatches(BUYER_ID);
      assert.equal(page.items[0].candidate.availabilityStatus, status);
    }
    for (const bad of ["bizarre", "", "AVAILABLE", 42, true, {}, []]) {
      const inCandidate = harness(() => json(200, matchesPageDto([matchDto({ candidate: { ...matchDto().candidate, availabilityStatus: bad } })])));
      await assert.rejects(
        inCandidate.client.demands.storedMatches(BUYER_ID),
        (error: unknown) => error instanceof ApiError && error.code === API_INVALID_RESPONSE,
        `candidat : ${JSON.stringify(bad)}`,
      );
      const inSource = harness(() =>
        json(200, { ...matchesPageDto([]), source: { ...matchesPageDto([]).source, availabilityStatus: bad } }),
      );
      await assert.rejects(
        inSource.client.offers.storedMatches(ID),
        (error: unknown) => error instanceof ApiError && error.code === API_INVALID_RESPONSE,
        `source : ${JSON.stringify(bad)}`,
      );
    }
  });

  test("sens offre : indicateurs de disponibilité et de prix absents (null), confiance seule", async () => {
    const demandItem = matchDto({
      candidateId: BUYER_ID,
      candidate: { ...matchDto().candidate, price: undefined, availabilityStatus: undefined, budget: { amount: 200000, currency: "XOF" } },
      indicators: { availability: null, price: null, confidence: { level: "medium", score: 55, accountAgeBand: "7d_30d", factors: [] } },
    });
    const { client } = harness(() => json(200, matchesPageDto([demandItem])));
    const page = await client.offers.storedMatches(ID);
    assert.equal(page.items[0].indicators.availability, null);
    assert.equal(page.items[0].indicators.price, null);
    assert.equal(page.items[0].indicators.confidence.level, "medium");
    assert.equal(page.items[0].candidate.budget?.amount, 200000);
    assert.equal(page.items[0].candidate.price, null);
  });

  test("sponsored conservé tel quel (vrai uniquement si le serveur le dit)", async () => {
    const { client } = harness(() => json(200, matchesPageDto([matchDto({ sponsored: true }), matchDto({ candidateId: BUYER_ID })])));
    const page = await client.demands.storedMatches(BUYER_ID, { sort: "relevance" });
    assert.deepEqual(page.items.map((item) => item.sponsored), [true, false]);
  });

  test("erreurs : ApiError construite depuis le corps seulement ; corps inattendu ou version de contrat inconnue = invalid_response", async () => {
    for (const status of [400, 401, 404, 503]) {
      const { client } = harness(() => json(status, { error: { code: "resource_not_found", message: "Ressource introuvable." } }));
      await assert.rejects(
        client.demands.storedMatches(BUYER_ID),
        (error: unknown) => error instanceof ApiError && error.status === status && error.code === "resource_not_found",
      );
    }
    const bad: Response[] = [
      json(200, { ...matchesPageDto([]), contractVersion: "matching-stored-http/v2" }),
      json(200, { ...matchesPageDto([]), items: "non" }),
      json(200, { ...matchesPageDto([]), processing: "oui" }),
      json(200, matchesPageDto([matchDto({ sponsored: "oui" })])),
      json(200, matchesPageDto([matchDto({ relevance: "88" })])),
      json(200, matchesPageDto([matchDto({ indicators: { availability: null, price: null } })])),
      json(200, matchesPageDto([matchDto({ indicators: { availability: null, price: { position: "cher", score: null, deltaPercent: null, sampleSize: 1, factors: [] }, confidence: matchDto().indicators.confidence } })])),
      json(200, matchesPageDto([matchDto({ candidate: { ...matchDto().candidate, price: { amount: "150" } } })])),
      new Response("<html>502</html>", { status: 200 }),
    ];
    for (const response of bad) {
      const { client } = harness(() => response.clone());
      await assert.rejects(
        client.demands.storedMatches(BUYER_ID),
        (error: unknown) => error instanceof ApiError && error.code === API_INVALID_RESPONSE,
      );
    }
    const { client } = harness(() => {
      throw new TypeError("fetch failed ECONNREFUSED 127.0.0.1:3211");
    });
    await assert.rejects(
      client.demands.storedMatches(BUYER_ID),
      (error: unknown) => error instanceof ApiError && error.code === API_NETWORK_ERROR && !error.message.includes("ECONNREFUSED"),
    );
  });
});

function quoteDto(overrides: Record<string, unknown> = {}) {
  return {
    id: "44444444-4444-4444-8444-444444444444",
    durationCode: "3d",
    currency: "XOF",
    status: "available",
    amount: 2300,
    unavailableReason: null,
    factors: { competitionMilli: 1060, demandMilli: 1300, scarcityMilli: 1333, durationMilli: 2500 },
    inputs: { competingSellers: 3, compatibleBuyers: 4, slotsTotal: 3, slotsUsed: 1 },
    computedAt: "2031-01-01T10:00:00.000Z",
    expiresAt: "2031-01-01T10:15:00.000Z",
    reused: false,
    ...overrides,
  };
}

describe("couche cliente : cotations de boost (boostQuotes)", () => {
  test("create : POST /api/offers/{id}/boost-quotes avec exactement { durationCode }, 201 puis 200 réutilisée", async () => {
    const { client, calls } = harness((_request, index) =>
      json(index === 0 ? 201 : 200, { contractVersion: "boost-quote/v1", quote: quoteDto({ reused: index === 1 }) }),
    );
    const created = await client.boostQuotes.create(ID, "3d");
    const reused = await client.boostQuotes.create(ID, "3d");
    assert.equal(calls[0].url, `/api/offers/${ID}/boost-quotes`);
    assert.equal(calls[0].init.method, "POST");
    assert.equal(calls[0].init.body, JSON.stringify({ durationCode: "3d" }));
    assert.equal(headerOf(calls[0], "Content-Type"), "application/json");
    assert.equal(created.amount, 2300);
    assert.equal(created.reused, false);
    assert.equal(created.expired, null);
    assert.equal(reused.reused, true);
    assert.deepEqual(created.factors, { competitionMilli: 1060, demandMilli: 1300, scarcityMilli: 1333, durationMilli: 2500 });
    assert.deepEqual(created.inputs, { competingSellers: 3, compatibleBuyers: 4, slotsTotal: 3, slotsUsed: 1 });
  });

  test("un devis indisponible est un SUCCÈS (jamais une erreur) avec son motif", async () => {
    const { client } = harness(() =>
      json(201, {
        contractVersion: "boost-quote/v1",
        quote: quoteDto({ status: "unavailable", amount: null, factors: null, unavailableReason: "no_compatible_buyer" }),
      }),
    );
    const quote = await client.boostQuotes.create(ID, "24h");
    assert.equal(quote.status, "unavailable");
    assert.equal(quote.amount, null);
    assert.equal(quote.factors, null);
    assert.equal(quote.unavailableReason, "no_compatible_buyer");
  });

  test("list : GET avec limit seulement, plus récentes d'abord ; chaque devis porte `expired`", async () => {
    const { client, calls } = harness(() =>
      json(200, {
        contractVersion: "boost-quote/v1",
        quotes: [
          { ...quoteDto({ id: "55555555-5555-4555-8555-555555555555" }), reused: undefined, expired: false },
          { ...quoteDto(), reused: undefined, expired: true },
        ],
      }),
    );
    const quotes = await client.boostQuotes.list(ID, { limit: 10 });
    assert.equal(calls[0].url, `/api/offers/${ID}/boost-quotes?limit=10`);
    assert.equal(calls[0].init.method, "GET");
    assert.deepEqual(quotes.map((quote) => quote.expired), [false, true]);
    assert.deepEqual(quotes.map((quote) => quote.reused), [null, null]);
    await client.boostQuotes.list(ID);
    assert.equal(calls[1].url, `/api/offers/${ID}/boost-quotes`);
  });

  test("identifiant non UUID, durée ou limite invalide : ApiError sans AUCUNE requête", async () => {
    const { client, calls } = harness(() => json(200, { contractVersion: "boost-quote/v1", quote: quoteDto() }));
    await assert.rejects(client.boostQuotes.create("pas-un-uuid", "3d"), (error: unknown) => error instanceof ApiError && error.code === API_INVALID_ID);
    await assert.rejects(client.boostQuotes.list("../x"), (error: unknown) => error instanceof ApiError && error.code === API_INVALID_ID);
    for (const duration of ["1h", "", "3D", "24h; DROP"]) {
      await assert.rejects(
        client.boostQuotes.create(ID, duration as never),
        (error: unknown) => error instanceof ApiError && error.code === API_INVALID_ARGUMENT,
        duration,
      );
    }
    for (const limit of [0, 51, 2.5, Number.NaN]) {
      await assert.rejects(client.boostQuotes.list(ID, { limit }), (error: unknown) => error instanceof ApiError && error.code === API_INVALID_ARGUMENT, String(limit));
    }
    assert.equal(calls.length, 0);
  });

  test("erreurs du serveur (403, 404, 409, 503) : code et statut venant du corps seulement", async () => {
    for (const [status, code] of [[403, "invalid_origin"], [404, "resource_not_found"], [409, "offer_not_eligible"], [409, "offer_not_boostable"], [503, "boost_unavailable"]] as const) {
      const { client } = harness(() => json(status, { error: { code, message: "ignoré" } }));
      await assert.rejects(
        client.boostQuotes.create(ID, "3d"),
        (error: unknown) => error instanceof ApiError && error.status === status && error.code === code,
      );
    }
  });

  test("réponse inattendue : invalid_response (champ manquant, durée ou état inconnus, version de contrat)", async () => {
    const wrap = (quote: unknown, extra: Record<string, unknown> = {}) => json(201, { contractVersion: "boost-quote/v1", quote, ...extra });
    const bad: Response[] = [
      wrap(quoteDto({ durationCode: "30d" })),
      wrap(quoteDto({ status: "pending" })),
      wrap(quoteDto({ amount: "2300" })),
      wrap(quoteDto({ amount: 2300.5 })),
      wrap(quoteDto({ unavailableReason: "Motif Brut!" })),
      wrap(quoteDto({ reused: undefined })),
      wrap(quoteDto({ factors: { competitionMilli: 1060 } })),
      wrap(quoteDto({ inputs: null })),
      wrap(quoteDto({ expiresAt: 5 })),
      wrap(quoteDto(), { contractVersion: "boost-quote/v2" }),
      json(201, { contractVersion: "boost-quote/v1" }),
      new Response("pas du json", { status: 201 }),
    ];
    for (const response of bad) {
      const { client } = harness(() => response.clone());
      await assert.rejects(
        client.boostQuotes.create(ID, "3d"),
        (error: unknown) => error instanceof ApiError && error.code === API_INVALID_RESPONSE,
      );
    }
    const { client } = harness(() => json(200, { contractVersion: "boost-quote/v1", quotes: "non" }));
    await assert.rejects(client.boostQuotes.list(ID), (error: unknown) => error instanceof ApiError && error.code === API_INVALID_RESPONSE);
  });

  test("le DTO ne laisse passer aucun champ inconnu (prix brut, configuration tarifaire, identifiants)", async () => {
    const { client } = harness(() =>
      json(201, {
        contractVersion: "boost-quote/v1",
        quote: quoteDto({ rawAmount: "2296.0925", pricing: { key: "default", version: 1 }, offerId: ID, sellerId: OWNER_ID }),
      }),
    );
    const quote = await client.boostQuotes.create(ID, "3d");
    const text = JSON.stringify(quote);
    for (const leaked of ["rawAmount", "2296.0925", "pricing", OWNER_ID, "offerId", "sellerId"]) assert.equal(text.includes(leaked), false, leaked);
  });
});

describe("messages fixes : correspondances et boost", () => {
  test("correspondances : 400, 404, 503 ont un message propre ; le reste retombe sur les messages communs", () => {
    const message = (status: number, code = "x_code") => describeApiError(new ApiError(status, code, "ignoré"), "matches");
    assert.equal(message(400), "Les résultats ne peuvent pas être affichés pour le moment. Actualisez la page.");
    assert.equal(message(404), "Introuvable : cet élément a peut-être été archivé ou n'existe plus.");
    assert.equal(message(503), "Les correspondances sont temporairement indisponibles. Réessayez dans un instant.");
    assert.equal(message(401), "Votre session a expiré. Reconnectez-vous pour continuer.");
    assert.equal(describeApiError(new ApiError(0, API_INVALID_ARGUMENT, "x"), "matches"), "Paramètre invalide. Rechargez la page.");
  });

  test("boost : 404, 409 par code, 503 ont un message propre", () => {
    const message = (status: number, code: string) => describeApiError(new ApiError(status, code, "ignoré"), "boost");
    assert.equal(message(404, "resource_not_found"), "Annonce introuvable : elle a peut-être été archivée ou n'existe plus.");
    assert.equal(message(409, "offer_not_eligible"), "Cette annonce ne peut pas être boostée : elle doit être en ligne et disponible.");
    assert.equal(message(409, "offer_not_boostable"), "Pour booster cette annonce, indiquez sa catégorie, sa marque et son modèle.");
    assert.equal(message(503, "boost_unavailable"), "Le boost est temporairement indisponible. Réessayez plus tard.");
    assert.equal(message(409, "autre"), GENERIC_ERROR_MESSAGE);
    assert.equal(message(403, "invalid_origin"), "Requête refusée. Rechargez la page et réessayez.");
  });
});
