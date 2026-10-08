import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  API_ABORTED,
  API_INVALID_ARGUMENT,
  API_INVALID_ID,
  API_INVALID_RESPONSE,
  API_NETWORK_ERROR,
  ApiError,
  BOOST_RATE_LIMITED_MESSAGE,
  REACH_CHECK_UNAVAILABLE_MESSAGE,
  GENERIC_ERROR_MESSAGE,
  LIST_ALL_MAX_PAGES,
  PAGE_LIMIT,
  createApiClient,
  describeApiError,
  isUnauthorized,
  serverTimeFromDateHeader,
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
    const { client, calls } = harness(() => json(200, { authenticated: true, userId: ID, isAdmin: false }));
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

  test("sessionOutcome (lot D3) : 200 { authenticated: true, userId, isAdmin } connecté ; 200 { authenticated: false } ou 401 anonyme ; 503/réseau/réponse inattendue indisponible", async () => {
    const outcome = async (responder: Responder) => harness(responder).client.auth.sessionOutcome();
    assert.deepEqual(await outcome(() => json(200, { authenticated: true, userId: ID, isAdmin: false })), { kind: "authenticated", userId: ID, isAdmin: false });
    assert.deepEqual(await outcome(() => json(200, { authenticated: true, userId: ID, isAdmin: true })), { kind: "authenticated", userId: ID, isAdmin: true });
    assert.deepEqual(await outcome(() => json(200, { authenticated: false })), { kind: "anonymous" }, "le visiteur anonyme : 200, jamais un 401 dans la console");
    assert.deepEqual(
      await outcome(() => json(401, { error: { code: "authentication_refused", message: "Authentification refusée." } })),
      { kind: "anonymous" },
      "un ancien serveur qui répond 401 reste lu comme anonyme",
    );
    assert.deepEqual(
      await outcome(() => json(503, { error: { code: "auth_unavailable", message: "Indisponible." } })),
      { kind: "unavailable" },
    );
    assert.deepEqual(await outcome(() => { throw new TypeError("fetch failed"); }), { kind: "unavailable" });
    assert.deepEqual(await outcome(() => new Response("<html>502</html>", { status: 502 })), { kind: "unavailable" });
    assert.deepEqual(await outcome(() => json(200, { nope: true })), { kind: "unavailable" });
    assert.deepEqual(await outcome(() => json(200, { userId: ID })), { kind: "unavailable" }, "l'ancienne forme { userId } n'est plus une réponse valide");
    for (const isAdmin of ["true", 1, null, undefined]) {
      assert.deepEqual(await outcome(() => json(200, { authenticated: true, userId: ID, isAdmin })), { kind: "unavailable" }, `isAdmin ${String(isAdmin)} n'est pas un booléen`);
    }
    assert.deepEqual(await outcome(() => json(200, { authenticated: "oui", userId: ID, isAdmin: false })), { kind: "unavailable" });
  });

  test("session (lot D3) : { userId, isAdmin } quand la session est valide ; une ApiError 401 sans session (200 { authenticated: false } ou 401)", async () => {
    assert.deepEqual(await harness(() => json(200, { authenticated: true, userId: ID, isAdmin: true })).client.auth.session(), { userId: ID, isAdmin: true });
    for (const responder of [() => json(200, { authenticated: false }), () => json(401, { error: { code: "authentication_refused", message: "x" } })]) {
      await assert.rejects(harness(responder).client.auth.session(), (error: unknown) => error instanceof ApiError && error.status === 401 && error.code === "authentication_required");
    }
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
  const contexts: ApiErrorContext[] = ["otp-request", "otp-verify", "catalog", "matches", "boost", "wallet", "purchase", "default"];

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
      "candidate", "candidateId", "compatibilityStatus", "coverage", "evaluatedAt", "indicators", "proBadge", "relevance", "score", "sponsored",
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

/** Compte d'acheteurs tel que le serveur l'envoie (lots M1 à M1-quater) : `{ kind: "approx", value }` (multiple de 5) ou `{ kind: "below", bound: 5 }`. */
const BUYERS = (value: number) => ({ kind: "approx", value });
const BELOW = { kind: "below", bound: 5 };

function quoteDto(overrides: Record<string, unknown> = {}) {
  return {
    id: "44444444-4444-4444-8444-444444444444",
    durationCode: "3d",
    currency: "XOF",
    status: "available",
    amount: 2500,
    unavailableReason: null,
    factors: { competitionMilli: 1060, demandMilli: 1400, scarcityMilli: 1333, durationMilli: 2500 },
    inputs: { competingSellers: 3, compatibleBuyers: BUYERS(5), reachableBuyers: BUYERS(5), reachTruncated: false, slotsTotal: 3, slotsUsed: 1 },
    computedAt: "2031-01-01T10:00:00.000Z",
    expiresAt: "2031-01-01T10:15:00.000Z",
    reused: false,
    ...overrides,
  };
}

describe("couche cliente : cotations de boost (boostQuotes)", () => {
  test("heure du serveur : l'en-tête Date de la réponse est lue (create et list) ; absent, illisible ou trop long : null", async () => {
    const withDate = (status: number, body: unknown, date: string | null) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...(date === null ? {} : { date }) } });
    const GMT = "Wed, 06 Oct 2027 12:00:00 GMT";
    const expected = Date.parse(GMT);
    const create = harness(() => withDate(200, { contractVersion: "boost-quote/v2", quote: quoteDto({ reused: true }) }, GMT));
    assert.equal((await create.client.boostQuotes.create(ID, "3d")).serverTime, expected);
    const listed = harness(() => withDate(200, { contractVersion: "boost-quote/v2", quotes: [{ ...quoteDto(), reused: undefined, expired: false }, { ...quoteDto({ id: "55555555-5555-4555-8555-555555555555" }), reused: undefined, expired: true }] }, GMT));
    assert.deepEqual((await listed.client.boostQuotes.list(ID)).map((quote) => quote.serverTime), [expected, expected]);
    for (const date of [null, "pas une date", "", "x".repeat(65)]) {
      const { client } = harness(() => withDate(201, { contractVersion: "boost-quote/v2", quote: quoteDto() }, date));
      assert.equal((await client.boostQuotes.create(ID, "3d")).serverTime, null, String(date));
    }
    assert.equal(serverTimeFromDateHeader(GMT), expected);
    assert.equal(serverTimeFromDateHeader(undefined), null);
    assert.equal(serverTimeFromDateHeader(null), null);
    assert.equal(serverTimeFromDateHeader(""), null);
  });

  test("create : POST /api/offers/{id}/boost-quotes avec exactement { durationCode }, 201 puis 200 réutilisée", async () => {
    const { client, calls } = harness((_request, index) =>
      json(index === 0 ? 201 : 200, { contractVersion: "boost-quote/v2", quote: quoteDto({ reused: index === 1 }) }),
    );
    const created = await client.boostQuotes.create(ID, "3d");
    const reused = await client.boostQuotes.create(ID, "3d");
    assert.equal(calls[0].url, `/api/offers/${ID}/boost-quotes`);
    assert.equal(calls[0].init.method, "POST");
    assert.equal(calls[0].init.body, JSON.stringify({ durationCode: "3d" }));
    assert.equal(headerOf(calls[0], "Content-Type"), "application/json");
    assert.equal(created.amount, 2500);
    assert.equal(created.reused, false);
    assert.equal(created.expired, null);
    assert.equal(reused.reused, true);
    assert.deepEqual(created.factors, { competitionMilli: 1060, demandMilli: 1400, scarcityMilli: 1333, durationMilli: 2500 });
    assert.deepEqual(created.inputs, { competingSellers: 3, compatibleBuyers: BUYERS(5), reachableBuyers: BUYERS(5), reachTruncated: false, slotsTotal: 3, slotsUsed: 1 });
  });

  test("un devis indisponible est un SUCCÈS (jamais une erreur) avec son motif", async () => {
    const { client } = harness(() =>
      json(201, {
        contractVersion: "boost-quote/v2",
        quote: quoteDto({ status: "unavailable", amount: null, factors: null, unavailableReason: "no_compatible_buyer" }),
      }),
    );
    const quote = await client.boostQuotes.create(ID, "24h");
    assert.equal(quote.status, "unavailable");
    assert.equal(quote.amount, null);
    assert.equal(quote.factors, null);
    assert.equal(quote.unavailableReason, "no_compatible_buyer");
  });

  test("portée visible : reachableBuyers (compte arrondi { kind, … } ou null) relu ; motif no_visible_effect = un devis INDISPONIBLE (succès), jamais une erreur", async () => {
    const withInputs = (reachableBuyers: unknown) => ({ competingSellers: 3, compatibleBuyers: BUYERS(5), reachableBuyers, reachTruncated: false, slotsTotal: 3, slotsUsed: 1 });
    for (const reachable of [BELOW, BUYERS(5), BUYERS(15), null]) {
      const { client } = harness(() => json(201, { contractVersion: "boost-quote/v2", quote: quoteDto({ inputs: withInputs(reachable) }) }));
      assert.deepEqual((await client.boostQuotes.create(ID, "3d")).inputs.reachableBuyers, reachable);
    }
    const { client } = harness(() =>
      json(201, {
        contractVersion: "boost-quote/v2",
        quote: quoteDto({ status: "unavailable", amount: null, factors: null, unavailableReason: "no_visible_effect", inputs: withInputs(BELOW) }),
      }),
    );
    const useless = await client.boostQuotes.create(ID, "24h");
    assert.deepEqual([useless.status, useless.unavailableReason, useless.amount, useless.inputs.reachableBuyers], ["unavailable", "no_visible_effect", null, BELOW]);
  });

  test("portée estimée (lot P3) : reachTruncated booléen relu ; absent = faux ; une valeur qui n'est pas un booléen est refusée (invalid_response)", async () => {
    const inputs = (reachTruncated: unknown) => ({ competingSellers: 3, compatibleBuyers: BUYERS(40), reachableBuyers: BUYERS(20), reachTruncated, slotsTotal: 3, slotsUsed: 1 });
    for (const [sent, expected] of [[true, true], [false, false]] as const) {
      const { client } = harness(() => json(201, { contractVersion: "boost-quote/v2", quote: quoteDto({ inputs: inputs(sent) }) }));
      assert.equal((await client.boostQuotes.create(ID, "3d")).inputs.reachTruncated, expected);
    }
    const legacyInputs: Record<string, unknown> = inputs(true);
    delete legacyInputs.reachTruncated;
    const legacy = harness(() => json(201, { contractVersion: "boost-quote/v2", quote: quoteDto({ inputs: legacyInputs }) }));
    assert.equal((await legacy.client.boostQuotes.create(ID, "3d")).inputs.reachTruncated, false, "champ absent : faux");
    for (const bad of ["true", 1, null, {}]) {
      const { client } = harness(() => json(201, { contractVersion: "boost-quote/v2", quote: quoteDto({ inputs: inputs(bad) }) }));
      await assert.rejects(client.boostQuotes.create(ID, "3d"), (error: unknown) => error instanceof ApiError && error.code === API_INVALID_RESPONSE, String(bad));
    }
  });

  test("list : GET avec limit seulement, plus récentes d'abord ; chaque devis porte `expired`", async () => {
    const { client, calls } = harness(() =>
      json(200, {
        contractVersion: "boost-quote/v2",
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
    const { client, calls } = harness(() => json(200, { contractVersion: "boost-quote/v2", quote: quoteDto() }));
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
    for (const [status, code] of [[403, "invalid_origin"], [404, "resource_not_found"], [409, "offer_not_eligible"], [409, "offer_not_boostable"], [503, "boost_unavailable"], [503, "reach_check_unavailable"]] as const) {
      const { client } = harness(() => json(status, { error: { code, message: "ignoré" } }));
      await assert.rejects(
        client.boostQuotes.create(ID, "3d"),
        (error: unknown) => error instanceof ApiError && error.status === status && error.code === code,
      );
    }
  });

  test("réponse inattendue : invalid_response (champ manquant, durée ou état inconnus, version de contrat)", async () => {
    const wrap = (quote: unknown, extra: Record<string, unknown> = {}) => json(201, { contractVersion: "boost-quote/v2", quote, ...extra });
    const bad: Response[] = [
      wrap(quoteDto({ durationCode: "30d" })),
      wrap(quoteDto({ status: "pending" })),
      wrap(quoteDto({ amount: "2300" })),
      wrap(quoteDto({ amount: 2300.5 })),
      wrap(quoteDto({ unavailableReason: "Motif Brut!" })),
      wrap(quoteDto({ reused: undefined })),
      wrap(quoteDto({ factors: { competitionMilli: 1060 } })),
      wrap(quoteDto({ inputs: null })),
      wrap(quoteDto({ inputs: { competingSellers: 3, compatibleBuyers: BUYERS(5), slotsTotal: 3, slotsUsed: 1 } })),
      wrap(quoteDto({ inputs: { competingSellers: 3, compatibleBuyers: BUYERS(5), reachableBuyers: "4", slotsTotal: 3, slotsUsed: 1 } })),
      wrap(quoteDto({ inputs: { competingSellers: 3, compatibleBuyers: BUYERS(5), reachableBuyers: BUYERS(-1), slotsTotal: 3, slotsUsed: 1 } })),
      wrap(quoteDto({ inputs: { competingSellers: 3, compatibleBuyers: BUYERS(5), reachableBuyers: BUYERS(1.5), slotsTotal: 3, slotsUsed: 1 } })),
      // Lots M1 à M1-quater : un nombre nu (ancienne forme), l'ancienne forme { value, belowThreshold }, une valeur qui n'est pas un multiple de 5, une borne autre que 5 ou un champ de plus sont refusés.
      wrap(quoteDto({ inputs: { competingSellers: 3, compatibleBuyers: 4, reachableBuyers: BUYERS(5), slotsTotal: 3, slotsUsed: 1 } })),
      wrap(quoteDto({ inputs: { competingSellers: 3, compatibleBuyers: BUYERS(5), reachableBuyers: 4, slotsTotal: 3, slotsUsed: 1 } })),
      wrap(quoteDto({ inputs: { competingSellers: 3, compatibleBuyers: { value: 2, belowThreshold: true }, reachableBuyers: BUYERS(5), slotsTotal: 3, slotsUsed: 1 } })),
      wrap(quoteDto({ inputs: { competingSellers: 3, compatibleBuyers: { value: null, belowThreshold: true }, reachableBuyers: BUYERS(5), slotsTotal: 3, slotsUsed: 1 } })),
      wrap(quoteDto({ inputs: { competingSellers: 3, compatibleBuyers: BUYERS(4), reachableBuyers: BUYERS(5), slotsTotal: 3, slotsUsed: 1 } })),
      wrap(quoteDto({ inputs: { competingSellers: 3, compatibleBuyers: BUYERS(12), reachableBuyers: BUYERS(5), slotsTotal: 3, slotsUsed: 1 } })),
      wrap(quoteDto({ inputs: { competingSellers: 3, compatibleBuyers: { kind: "below", bound: 3 }, reachableBuyers: BUYERS(5), slotsTotal: 3, slotsUsed: 1 } })),
      wrap(quoteDto({ inputs: { competingSellers: 3, compatibleBuyers: { kind: "approx", value: 10, exact: 12 }, reachableBuyers: BUYERS(5), slotsTotal: 3, slotsUsed: 1 } })),
      wrap(quoteDto({ expiresAt: 5 })),
      wrap(quoteDto(), { contractVersion: "boost-quote/v1" }), // l'ancienne forme (comptes d'acheteurs en nombres) n'est plus acceptée
      json(201, { contractVersion: "boost-quote/v2" }),
      new Response("pas du json", { status: 201 }),
    ];
    for (const response of bad) {
      const { client } = harness(() => response.clone());
      await assert.rejects(
        client.boostQuotes.create(ID, "3d"),
        (error: unknown) => error instanceof ApiError && error.code === API_INVALID_RESPONSE,
      );
    }
    const { client } = harness(() => json(200, { contractVersion: "boost-quote/v2", quotes: "non" }));
    await assert.rejects(client.boostQuotes.list(ID), (error: unknown) => error instanceof ApiError && error.code === API_INVALID_RESPONSE);
  });

  test("le DTO ne laisse passer aucun champ inconnu (prix brut, configuration tarifaire, identifiants)", async () => {
    const { client } = harness(() =>
      json(201, {
        contractVersion: "boost-quote/v2",
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
    // Lot P3-bis : vérification de la portée non terminée (503 reach_check_unavailable) : message propre, retriable, jamais le code brut.
    assert.equal(message(503, "reach_check_unavailable"), "Vérification impossible pour le moment, réessayez dans un instant.");
    assert.equal(message(503, "reach_check_unavailable"), REACH_CHECK_UNAVAILABLE_MESSAGE);
    assert.equal(message(503, "reach_check_unavailable").includes("reach_check"), false);
    // Lot P3 : limite de débit des devis (429 rate_limited), message propre (jamais celui des codes de connexion).
    assert.equal(message(429, "rate_limited"), "Trop de demandes de prix en peu de temps. Patientez une minute, puis réessayez.");
    assert.equal(message(429, "rate_limited"), BOOST_RATE_LIMITED_MESSAGE);
    assert.equal(message(429, "rate_limited").includes("code"), false);
    assert.equal(message(409, "autre"), GENERIC_ERROR_MESSAGE);
    assert.equal(message(403, "invalid_origin"), "Requête refusée. Rechargez la page et réessayez.");
  });
});

// ─── Portefeuille, recharge simulée et achat de boost (lot P2) ────────────────────────────────────

const TOPUP_ID = "77777777-7777-4777-8777-777777777777";
const TX_ID = "88888888-8888-4888-8888-888888888888";
const QUOTE_ID = "44444444-4444-4444-8444-444444444444";
const PURCHASE_ID = "99999999-9999-4999-8999-999999999999";
const KEY = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function topupDto(overrides: Record<string, unknown> = {}) {
  return {
    id: TOPUP_ID,
    amountXof: 2000,
    status: "pending",
    expiresAt: "2031-01-01T10:30:00.000Z",
    checkoutPath: `/paiement-simule/${TOPUP_ID}`,
    ...overrides,
  };
}

function walletDto(overrides: Record<string, unknown> = {}) {
  return {
    contractVersion: "wallet/v1",
    balanceXof: 700,
    transactions: [
      { id: TX_ID, kind: "boost_purchase", amountXof: -1300, createdAt: "2031-01-01T10:05:00.000Z" },
      { id: "88888888-8888-4888-8888-888888888889", kind: "topup", amountXof: 2000, createdAt: "2031-01-01T10:00:00.000Z" },
    ],
    nextCursor: CURSOR,
    ...overrides,
  };
}

function purchaseDto(overrides: Record<string, unknown> = {}) {
  return {
    id: PURCHASE_ID,
    quoteId: QUOTE_ID,
    durationCode: "3d",
    amountXof: 1300,
    startsAt: "2031-01-01T10:05:00.000Z",
    endsAt: "2031-01-04T10:05:00.000Z",
    reused: false,
    ...overrides,
  };
}

describe("couche cliente : porte-monnaie (wallet)", () => {
  test("overview : GET /api/wallet, solde et historique signé relus champ par champ", async () => {
    const { client, calls } = harness(() => json(200, walletDto()));
    const overview = await client.wallet.overview();
    assert.equal(calls[0].url, "/api/wallet");
    assert.equal(calls[0].init.method, "GET");
    assert.equal(calls[0].init.body, undefined);
    assert.equal(overview.balanceXof, 700);
    assert.deepEqual(overview.transactions.map((entry) => [entry.kind, entry.amountXof]), [["boost_purchase", -1300], ["topup", 2000]]);
    assert.equal(overview.nextCursor, CURSOR);
    const last = await harness(() => json(200, walletDto({ nextCursor: null }))).client.wallet.overview();
    assert.equal(last.nextCursor, null);
  });

  test("overview : curseur et limite encodés, vérifiés AVANT la requête", async () => {
    const { client, calls } = harness(() => json(200, walletDto()));
    await client.wallet.overview({ cursor: CURSOR, limit: 50 });
    assert.equal(calls[0].url, `/api/wallet?limit=50&cursor=${encodeURIComponent(CURSOR)}`);
    await client.wallet.overview({ cursor: "a b/c+d" });
    assert.equal(calls[1].url, "/api/wallet?cursor=a+b%2Fc%2Bd");
    await client.wallet.overview({ limit: 1 });
    assert.equal(calls[2].url, "/api/wallet?limit=1");
    for (const query of [{ limit: 0 }, { limit: 51 }, { limit: 1.5 }, { limit: Number.NaN }, { cursor: "" }, { cursor: "x".repeat(513) }]) {
      await assert.rejects(client.wallet.overview(query), (error: unknown) => error instanceof ApiError && error.code === API_INVALID_ARGUMENT && error.status === 0, JSON.stringify(query));
    }
    assert.equal(calls.length, 3);
  });

  test("overview : réponse hors liste blanche = invalid_response (version de contrat, solde, montant non sûr, type inconnu, date)", async () => {
    const tx = (overrides: Record<string, unknown>) => ({ id: TX_ID, kind: "topup", amountXof: 2000, createdAt: "2031-01-01T10:00:00.000Z", ...overrides });
    const bad: Response[] = [
      json(200, walletDto({ contractVersion: "wallet/v2" })),
      json(200, walletDto({ contractVersion: undefined })),
      json(200, walletDto({ balanceXof: "700" })),
      json(200, walletDto({ balanceXof: 700.5 })),
      json(200, walletDto({ balanceXof: -1 })),
      json(200, walletDto({ balanceXof: 2 ** 53 })),
      json(200, walletDto({ transactions: "non" })),
      json(200, walletDto({ transactions: [tx({ kind: 5 })] })),
      json(200, walletDto({ transactions: [tx({ kind: "" })] })),
      json(200, walletDto({ transactions: [tx({ kind: "x".repeat(65) })] })),
      json(200, walletDto({ transactions: [tx({ kind: "cadeau", amountXof: 0 })] })),
      json(200, walletDto({ transactions: [tx({ kind: "cadeau", amountXof: 1.5 })] })),
      json(200, walletDto({ transactions: [tx({ kind: "cadeau", amountXof: 2 ** 53 })] })),
      json(200, walletDto({ transactions: [tx({ amountXof: 1.5 })] })),
      json(200, walletDto({ transactions: [tx({ amountXof: "2000" })] })),
      json(200, walletDto({ transactions: [tx({ amountXof: 0 })] })),
      json(200, walletDto({ transactions: [tx({ amountXof: 2 ** 53 })] })),
      json(200, walletDto({ transactions: [tx({ id: "pas-un-uuid" })] })),
      json(200, walletDto({ transactions: [tx({ createdAt: "hier" })] })),
      json(200, walletDto({ nextCursor: "" })),
      json(200, walletDto({ nextCursor: 5 })),
      new Response("<html>502</html>", { status: 200 }),
    ];
    for (const response of bad) {
      const { client } = harness(() => response.clone());
      await assert.rejects(client.wallet.overview(), (error: unknown) => error instanceof ApiError && error.code === API_INVALID_RESPONSE);
    }
  });

  test("overview : un type de transaction INCONNU ne rejette pas l'historique : ligne « unknown » (affichée « Opération »), montant validé, code brut jamais conservé", async () => {
    const tx = (kind: string, amountXof: number, id: string) => ({ id, kind, amountXof, createdAt: "2031-01-01T10:00:00.000Z" });
    const { client } = harness(() =>
      json(200, walletDto({
        transactions: [
          tx("topup", 2000, "88888888-8888-4888-8888-888888888801"),
          tx("cadeau_de_noel", -750, "88888888-8888-4888-8888-888888888802"),
          tx("__proto__", 100, "88888888-8888-4888-8888-888888888803"),
          tx("boost_refund", 1300, "88888888-8888-4888-8888-888888888804"),
        ],
      })),
    );
    const overview = await client.wallet.overview();
    assert.deepEqual(overview.transactions.map((entry) => [entry.kind, entry.amountXof]), [["topup", 2000], ["unknown", -750], ["unknown", 100], ["boost_refund", 1300]]);
    const text = JSON.stringify(overview);
    for (const leaked of ["cadeau_de_noel", "__proto__"]) assert.equal(text.includes(leaked), false, leaked);
  });

  test("overview : un champ que le serveur ajouterait n'atteint jamais l'écran (compte, référence, métadonnées, identifiant d'utilisateur)", async () => {
    const { client } = harness(() =>
      json(200, walletDto({
        accountId: "acct-secret",
        transactions: [{ id: TX_ID, kind: "topup", amountXof: 2000, createdAt: "2031-01-01T10:00:00.000Z", reference: "topup:secret-ref", metadata: { paymentIntentId: TOPUP_ID }, ownerId: OWNER_ID }],
      })),
    );
    const text = JSON.stringify(await client.wallet.overview());
    for (const leaked of ["acct-secret", "secret-ref", "metadata", "paymentIntentId", OWNER_ID, "ownerId", "reference", "accountId"]) assert.equal(text.includes(leaked), false, leaked);
  });

  test("createTopup : POST /api/wallet/topups avec exactement { amountXof, idempotencyKey } ; 201 créé, 200 retrouvé", async () => {
    const { client, calls } = harness((_request, index) => json(index === 0 ? 201 : 200, { contractVersion: "wallet/v1", topup: topupDto() }));
    const created = await client.wallet.createTopup({ amountXof: 2000, idempotencyKey: KEY });
    const again = await client.wallet.createTopup({ amountXof: 2000, idempotencyKey: KEY });
    assert.equal(calls[0].url, "/api/wallet/topups");
    assert.equal(calls[0].init.method, "POST");
    assert.deepEqual(JSON.parse(String(calls[0].init.body)), { amountXof: 2000, idempotencyKey: KEY });
    assert.equal(headerOf(calls[0], "Content-Type"), "application/json");
    assert.equal(created.reused, false);
    assert.equal(again.reused, true);
    assert.deepEqual(created.topup, { id: TOPUP_ID, amountXof: 2000, status: "pending", expiresAt: "2031-01-01T10:30:00.000Z", checkoutPath: `/paiement-simule/${TOPUP_ID}` });
    // Le corps ne porte rien d'autre que le montant et la clé (jamais un identifiant d'utilisateur).
    assert.deepEqual(Object.keys(JSON.parse(String(calls[0].init.body))).sort(), ["amountXof", "idempotencyKey"]);
  });

  test("createTopup : montant non sûr ou clé invalide refusés AVANT la requête", async () => {
    const { client, calls } = harness(() => json(201, { contractVersion: "wallet/v1", topup: topupDto() }));
    const bad: unknown[] = [0, -500, 1.5, 2000.25, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53, 2 ** 60, "2000", null, undefined, BigInt(2000), [2000], { v: 2000 }];
    for (const amountXof of bad) {
      await assert.rejects(
        client.wallet.createTopup({ amountXof: amountXof as number, idempotencyKey: KEY }),
        (error: unknown) => error instanceof ApiError && error.code === API_INVALID_ARGUMENT && error.status === 0,
        String(amountXof),
      );
    }
    for (const idempotencyKey of ["", "pas-un-uuid", "aaaaaaaa-aaaa-0aaa-8aaa-aaaaaaaaaaaa", undefined as unknown as string]) {
      await assert.rejects(client.wallet.createTopup({ amountXof: 2000, idempotencyKey }), (error: unknown) => error instanceof ApiError && error.code === API_INVALID_ARGUMENT, String(idempotencyKey));
    }
    await assert.rejects(client.wallet.createTopup(undefined as never), (error: unknown) => error instanceof ApiError && error.code === API_INVALID_ARGUMENT);
    assert.equal(calls.length, 0, "aucune requête n'est partie");
  });

  test("createTopup et topup : réponse hors liste blanche = invalid_response", async () => {
    const wrap = (topup: unknown, extra: Record<string, unknown> = {}) => json(201, { contractVersion: "wallet/v1", topup, ...extra });
    const bad: Response[] = [
      wrap(topupDto({ status: "paid" })),
      wrap(topupDto({ amountXof: "2000" })),
      wrap(topupDto({ amountXof: 0 })),
      wrap(topupDto({ amountXof: 2000.5 })),
      wrap(topupDto({ id: "pas-un-uuid" })),
      wrap(topupDto({ expiresAt: "bientôt" })),
      wrap(topupDto({ checkoutPath: 12 })),
      wrap(topupDto({ checkoutPath: "x".repeat(201) })),
      wrap(topupDto(), { contractVersion: "wallet/v2" }),
      json(201, { contractVersion: "wallet/v1" }),
      new Response("pas du json", { status: 201 }),
    ];
    for (const response of bad) {
      const { client } = harness(() => response.clone());
      await assert.rejects(client.wallet.createTopup({ amountXof: 2000, idempotencyKey: KEY }), (error: unknown) => error instanceof ApiError && error.code === API_INVALID_RESPONSE);
      await assert.rejects(client.wallet.topup(TOPUP_ID), (error: unknown) => error instanceof ApiError && error.code === API_INVALID_RESPONSE);
    }
  });

  test("createTopup : un champ ajouté (référence du prestataire, propriétaire, clé) n'atteint jamais l'écran", async () => {
    const { client } = harness(() => json(201, { contractVersion: "wallet/v1", topup: topupDto({ providerReference: "fakepay_secret", ownerId: OWNER_ID, idempotencyKey: KEY }) }));
    const text = JSON.stringify(await client.wallet.createTopup({ amountXof: 2000, idempotencyKey: KEY }));
    for (const leaked of ["fakepay_secret", OWNER_ID, "providerReference", "ownerId"]) assert.equal(text.includes(leaked), false, leaked);
    assert.equal(text.includes(KEY), false, "la clé d'idempotence n'est pas renvoyée");
  });

  test("topup : GET /api/wallet/topups/{id} ; identifiant non UUID refusé sans requête", async () => {
    const { client, calls } = harness(() => json(200, { contractVersion: "wallet/v1", topup: topupDto({ status: "succeeded" }) }));
    const topup = await client.wallet.topup(TOPUP_ID);
    assert.equal(calls[0].url, `/api/wallet/topups/${TOPUP_ID}`);
    assert.equal(calls[0].init.method, "GET");
    assert.equal(topup.status, "succeeded");
    for (const bad of ["pas-un-uuid", "../x", `${TOPUP_ID}/confirm`, ""]) {
      await assert.rejects(client.wallet.topup(bad), (error: unknown) => error instanceof ApiError && error.code === API_INVALID_ID, bad);
    }
    assert.equal(calls.length, 1);
  });

  test("erreurs du serveur (400, 401, 403, 404, 409, 503) : statut et code viennent du corps seulement", async () => {
    const cases: [number, string][] = [[400, "invalid_request"], [401, "authentication_required"], [403, "invalid_origin"], [404, "resource_not_found"], [409, "idempotency_conflict"], [409, "too_many_pending_topups"], [503, "payment_unavailable"], [503, "wallet_unavailable"]];
    for (const [status, code] of cases) {
      const { client } = harness(() => json(status, { error: { code, message: "ignoré" } }));
      await assert.rejects(client.wallet.createTopup({ amountXof: 2000, idempotencyKey: KEY }), (error: unknown) => error instanceof ApiError && error.status === status && error.code === code);
      await assert.rejects(client.wallet.overview(), (error: unknown) => error instanceof ApiError && error.status === status && error.code === code);
    }
  });
});

describe("couche cliente : paiement simulé de développement (devPayments)", () => {
  test("confirm et fail : POST sans corps ni Content-Type sur /api/dev/fake-payments/{id}/…, issue et recharge relues", async () => {
    const { client, calls } = harness(() => json(200, { contractVersion: "wallet/v1", outcome: "applied", topup: topupDto({ status: "succeeded" }) }));
    const confirmed = await client.devPayments.confirm(TOPUP_ID);
    const failed = await client.devPayments.fail(TOPUP_ID);
    assert.equal(calls[0].url, `/api/dev/fake-payments/${TOPUP_ID}/confirm`);
    assert.equal(calls[1].url, `/api/dev/fake-payments/${TOPUP_ID}/fail`);
    for (const call of calls) {
      assert.equal(call.init.method, "POST");
      assert.equal(call.init.body, undefined);
      assert.equal(headerOf(call, "Content-Type"), undefined);
    }
    assert.equal(confirmed.outcome, "applied");
    assert.equal(confirmed.topup.status, "succeeded");
    assert.equal(failed.outcome, "applied");
  });

  test("toutes les issues connues acceptées ; une issue inconnue ou une version de contrat inconnue = invalid_response", async () => {
    for (const outcome of ["applied", "duplicate", "rejected_amount", "rejected_state", "rejected_unknown_intent", "replayed"]) {
      const { client } = harness(() => json(200, { contractVersion: "wallet/v1", outcome, topup: topupDto() }));
      assert.equal((await client.devPayments.confirm(TOPUP_ID)).outcome, outcome);
    }
    for (const body of [
      { contractVersion: "wallet/v1", outcome: "ok", topup: topupDto() },
      { contractVersion: "wallet/v1", topup: topupDto() },
      { contractVersion: "wallet/v2", outcome: "applied", topup: topupDto() },
      { contractVersion: "wallet/v1", outcome: "applied", topup: topupDto({ status: "x" }) },
      { outcome: "applied", topup: topupDto() },
    ]) {
      const { client } = harness(() => json(200, body));
      await assert.rejects(client.devPayments.confirm(TOPUP_ID), (error: unknown) => error instanceof ApiError && error.code === API_INVALID_RESPONSE);
      await assert.rejects(client.devPayments.fail(TOPUP_ID), (error: unknown) => error instanceof ApiError && error.code === API_INVALID_RESPONSE);
    }
  });

  test("identifiant non UUID refusé sans requête ; 404 (fictif inactif) transmis tel quel", async () => {
    const { client, calls } = harness(() => json(404, { error: { code: "resource_not_found", message: "x" } }));
    for (const bad of ["pas-un-uuid", "../x", `${TOPUP_ID}/../other`]) {
      await assert.rejects(client.devPayments.confirm(bad), (error: unknown) => error instanceof ApiError && error.code === API_INVALID_ID, bad);
      await assert.rejects(client.devPayments.fail(bad), (error: unknown) => error instanceof ApiError && error.code === API_INVALID_ID, bad);
    }
    assert.equal(calls.length, 0);
    await assert.rejects(client.devPayments.confirm(TOPUP_ID), (error: unknown) => error instanceof ApiError && error.status === 404 && error.code === "resource_not_found");
  });
});

describe("couche cliente : achat de boost (boostPurchases)", () => {
  test("create : POST /api/offers/{id}/boost-purchases avec exactement { quoteId, idempotencyKey } ; 201 puis 200 (rejeu)", async () => {
    const { client, calls } = harness((_request, index) =>
      json(index === 0 ? 201 : 200, { contractVersion: "boost-purchase/v1", purchase: purchaseDto({ reused: index === 1 }), balanceXof: 700 }),
    );
    const created = await client.boostPurchases.create(ID, { quoteId: QUOTE_ID, idempotencyKey: KEY });
    const replay = await client.boostPurchases.create(ID, { quoteId: QUOTE_ID, idempotencyKey: KEY });
    assert.equal(calls[0].url, `/api/offers/${ID}/boost-purchases`);
    assert.equal(calls[0].init.method, "POST");
    assert.deepEqual(JSON.parse(String(calls[0].init.body)), { quoteId: QUOTE_ID, idempotencyKey: KEY });
    assert.equal(headerOf(calls[0], "Content-Type"), "application/json");
    assert.equal(calls[0].init.body, calls[1].init.body, "le rejeu envoie exactement la même requête");
    assert.equal(created.balanceXof, 700);
    // Lot PRO1 : la part promotionnelle (absente chez un serveur plus ancien : nulle) est relue.
    assert.deepEqual(created.purchase, { ...purchaseDto(), promoAmountXof: 0, reused: false });
    assert.equal(replay.purchase.reused, true);
  });

  test("le prix ne vient JAMAIS du client : aucun montant dans le corps, même si l'appelant en passe un", async () => {
    const { client, calls } = harness(() => json(201, { contractVersion: "boost-purchase/v1", purchase: purchaseDto(), balanceXof: 700 }));
    await client.boostPurchases.create(ID, { quoteId: QUOTE_ID, idempotencyKey: KEY, amountXof: 1, price: 1 } as never);
    assert.deepEqual(Object.keys(JSON.parse(String(calls[0].init.body))).sort(), ["idempotencyKey", "quoteId"]);
  });

  test("identifiants invalides refusés AVANT la requête (invalid_id pour l'annonce, invalid_argument pour le devis et la clé)", async () => {
    const { client, calls } = harness(() => json(201, { contractVersion: "boost-purchase/v1", purchase: purchaseDto(), balanceXof: 700 }));
    await assert.rejects(client.boostPurchases.create("pas-un-uuid", { quoteId: QUOTE_ID, idempotencyKey: KEY }), (error: unknown) => error instanceof ApiError && error.code === API_INVALID_ID);
    await assert.rejects(client.boostPurchases.create("../x", { quoteId: QUOTE_ID, idempotencyKey: KEY }), (error: unknown) => error instanceof ApiError && error.code === API_INVALID_ID);
    for (const bad of ["", "x", "pas-un-uuid", undefined as unknown as string]) {
      await assert.rejects(client.boostPurchases.create(ID, { quoteId: bad, idempotencyKey: KEY }), (error: unknown) => error instanceof ApiError && error.code === API_INVALID_ARGUMENT, `quoteId ${String(bad)}`);
      await assert.rejects(client.boostPurchases.create(ID, { quoteId: QUOTE_ID, idempotencyKey: bad }), (error: unknown) => error instanceof ApiError && error.code === API_INVALID_ARGUMENT, `clé ${String(bad)}`);
    }
    await assert.rejects(client.boostPurchases.create(ID, undefined as never), (error: unknown) => error instanceof ApiError && error.code === API_INVALID_ARGUMENT);
    assert.equal(calls.length, 0);
  });

  test("réponse hors liste blanche = invalid_response (solde, durée, montant non sûr, dates, contrat)", async () => {
    const wrap = (purchase: unknown, extra: Record<string, unknown> = {}) => json(201, { contractVersion: "boost-purchase/v1", purchase, balanceXof: 700, ...extra });
    const bad: Response[] = [
      wrap(purchaseDto({ durationCode: "30d" })),
      wrap(purchaseDto({ amountXof: "1300" })),
      wrap(purchaseDto({ amountXof: 1300.5 })),
      wrap(purchaseDto({ amountXof: 0 })),
      wrap(purchaseDto({ amountXof: 2 ** 53 })),
      wrap(purchaseDto({ id: "pas-un-uuid" })),
      wrap(purchaseDto({ quoteId: 5 })),
      wrap(purchaseDto({ startsAt: "demain" })),
      wrap(purchaseDto({ endsAt: null })),
      wrap(purchaseDto({ reused: undefined })),
      wrap(purchaseDto({ reused: "false" })),
      wrap(purchaseDto(), { balanceXof: "700" }),
      wrap(purchaseDto(), { balanceXof: -1 }),
      wrap(purchaseDto(), { balanceXof: 0.5 }),
      wrap(purchaseDto(), { balanceXof: undefined }),
      wrap(purchaseDto(), { contractVersion: "boost-purchase/v2" }),
      wrap(undefined),
      new Response("<html>502</html>", { status: 201 }),
    ];
    for (const response of bad) {
      const { client } = harness(() => response.clone());
      await assert.rejects(client.boostPurchases.create(ID, { quoteId: QUOTE_ID, idempotencyKey: KEY }), (error: unknown) => error instanceof ApiError && error.code === API_INVALID_RESPONSE);
    }
  });

  test("le DTO ne laisse passer aucun champ inconnu (boost, transaction, vendeur, offre, clé d'idempotence)", async () => {
    const { client } = harness(() =>
      json(201, {
        contractVersion: "boost-purchase/v1",
        purchase: purchaseDto({ boostId: "boost-secret", transactionId: "tx-secret", sellerId: OWNER_ID, offerId: ID, idempotencyKey: KEY }),
        balanceXof: 700,
        walletAccountId: "acct-secret",
      }),
    );
    const text = JSON.stringify(await client.boostPurchases.create(ID, { quoteId: QUOTE_ID, idempotencyKey: KEY }));
    for (const leaked of ["boost-secret", "tx-secret", OWNER_ID, "sellerId", "offerId", "acct-secret", "boostId", "transactionId"]) assert.equal(text.includes(leaked), false, leaked);
    assert.equal(text.includes(KEY), false);
  });

  test("list : GET avec limit seulement ; achats, remboursement éventuel ; limite et identifiant vérifiés avant la requête", async () => {
    const item = (overrides: Record<string, unknown> = {}) => ({ ...purchaseDto(), reused: undefined, createdAt: "2031-01-01T10:05:01.000Z", refundedAt: null, ...overrides });
    const { client, calls } = harness(() =>
      json(200, { contractVersion: "boost-purchase/v1", purchases: [item({ refundedAt: "2031-01-02T08:00:00.000Z" }), item({ id: "99999999-9999-4999-8999-999999999990" })] }),
    );
    const purchases = await client.boostPurchases.list(ID, { limit: 10 });
    assert.equal(calls[0].url, `/api/offers/${ID}/boost-purchases?limit=10`);
    assert.equal(calls[0].init.method, "GET");
    assert.deepEqual(purchases.map((entry) => entry.refundedAt), ["2031-01-02T08:00:00.000Z", null]);
    assert.equal("reused" in purchases[0], false);
    await client.boostPurchases.list(ID);
    assert.equal(calls[1].url, `/api/offers/${ID}/boost-purchases`);
    await assert.rejects(client.boostPurchases.list("../x"), (error: unknown) => error instanceof ApiError && error.code === API_INVALID_ID);
    for (const limit of [0, 51, 2.5, Number.NaN]) {
      await assert.rejects(client.boostPurchases.list(ID, { limit }), (error: unknown) => error instanceof ApiError && error.code === API_INVALID_ARGUMENT, String(limit));
    }
    assert.equal(calls.length, 2);
  });

  test("list : réponse hors liste blanche = invalid_response ; aucun identifiant interne ne passe", async () => {
    for (const body of [
      { contractVersion: "boost-purchase/v2", purchases: [] },
      { contractVersion: "boost-purchase/v1", purchases: "non" },
      { contractVersion: "boost-purchase/v1", purchases: [{ ...purchaseDto(), createdAt: "hier", refundedAt: null }] },
      { contractVersion: "boost-purchase/v1", purchases: [{ ...purchaseDto(), createdAt: "2031-01-01T10:05:01.000Z", refundedAt: "jamais" }] },
      { contractVersion: "boost-purchase/v1", purchases: [{ ...purchaseDto(), createdAt: "2031-01-01T10:05:01.000Z" }] },
    ]) {
      const { client } = harness(() => json(200, body));
      await assert.rejects(client.boostPurchases.list(ID), (error: unknown) => error instanceof ApiError && error.code === API_INVALID_RESPONSE);
    }
    const { client } = harness(() =>
      json(200, { contractVersion: "boost-purchase/v1", purchases: [{ ...purchaseDto(), reused: undefined, createdAt: "2031-01-01T10:05:01.000Z", refundedAt: null, sellerId: OWNER_ID, boostId: "boost-secret" }] }),
    );
    const text = JSON.stringify(await client.boostPurchases.list(ID));
    for (const leaked of [OWNER_ID, "boost-secret", "sellerId", "boostId"]) assert.equal(text.includes(leaked), false, leaked);
  });

  test("erreurs de l'achat (400, 401, 403, 404, 409 par code, 503) : statut et code viennent du corps seulement", async () => {
    const cases: [number, string][] = [
      [400, "invalid_request"], [401, "authentication_required"], [403, "invalid_origin"], [404, "resource_not_found"],
      [409, "insufficient_balance"], [409, "quote_expired"], [409, "quote_unavailable"], [409, "quote_already_used"], [409, "offer_not_eligible"],
      [409, "offer_already_boosted"], [409, "no_slot_available"], [409, "seller_boost_limit_reached"], [409, "no_visible_effect"], [409, "idempotency_conflict"], [503, "boost_purchase_unavailable"], [503, "reach_check_unavailable"],
    ];
    for (const [status, code] of cases) {
      const { client } = harness(() => json(status, { error: { code, message: "ignoré" } }));
      await assert.rejects(client.boostPurchases.create(ID, { quoteId: QUOTE_ID, idempotencyKey: KEY }), (error: unknown) => error instanceof ApiError && error.status === status && error.code === code);
    }
  });
});

describe("messages fixes : porte-monnaie et achat de boost (jamais le code brut)", () => {
  const wallet = (status: number, code: string) => describeApiError(new ApiError(status, code, "ignoré"), "wallet");
  const purchase = (status: number, code: string) => describeApiError(new ApiError(status, code, "ignoré"), "purchase");

  test("recharge : 503 payment_unavailable → « La recharge n'est pas disponible pour le moment. »", () => {
    assert.equal(wallet(503, "payment_unavailable"), "La recharge n'est pas disponible pour le moment.");
    assert.equal(wallet(503, "wallet_unavailable"), "Le porte-monnaie est temporairement indisponible. Réessayez dans un instant.");
    assert.match(wallet(409, "too_many_pending_topups"), /plusieurs recharges en attente/);
    assert.match(wallet(409, "idempotency_conflict"), /autre montant/);
    assert.match(wallet(400, "invalid_request"), /500 à 500\s000 FCFA, par multiples de 100/);
    assert.equal(wallet(404, "resource_not_found"), "Cette recharge est introuvable.");
    assert.equal(wallet(401, "authentication_required"), "Votre session a expiré. Reconnectez-vous pour continuer.");
    assert.equal(wallet(403, "invalid_origin"), "Requête refusée. Rechargez la page et réessayez.");
    assert.equal(wallet(503, "code_inconnu"), "Le service est temporairement indisponible. Réessayez dans un instant.");
  });

  test("achat : un message simple par code de boost-purchase/v1", () => {
    assert.match(purchase(409, "insufficient_balance"), /^Solde insuffisant : rechargez votre porte-monnaie/);
    assert.match(purchase(409, "quote_expired"), /^Ce devis a expiré\./);
    assert.match(purchase(409, "quote_already_used"), /^Ce devis a déjà servi/);
    assert.match(purchase(409, "quote_unavailable"), /pas de prix/);
    assert.equal(purchase(409, "no_slot_available"), "Il n'y a plus de place de mise en avant disponible pour ce produit pour le moment.");
    assert.equal(purchase(409, "seller_boost_limit_reached"), "Vous avez atteint votre plafond de boosts pour ce produit.");
    // Lot P3 : portée revérifiée à l'achat : message simple, rien n'a été acheté, un nouveau prix est à demander.
    // Lot P3-bis (N2) : texte neutre unique, qui couvre aussi « place prise par un boost plus ancien ».
    assert.equal(
      purchase(409, "no_visible_effect"),
      "Ce boost ne ferait plus monter votre annonce chez aucun acheteur (place déjà occupée par un boost acheté plus tôt, ou liste trop courte). Aucun débit. Demandez un nouveau prix plus tard.",
    );
    // Lot P3-bis (N3) : vérification non terminée = 503 retriable, jamais confondue avec « aucun effet ».
    assert.equal(purchase(503, "reach_check_unavailable"), "Vérification impossible pour le moment, réessayez dans un instant.");
    assert.equal(purchase(503, "reach_check_unavailable"), REACH_CHECK_UNAVAILABLE_MESSAGE);
    assert.notEqual(purchase(503, "reach_check_unavailable"), purchase(409, "no_visible_effect"));
    assert.equal(purchase(503, "reach_check_unavailable").includes("Aucun débit"), false);
    assert.equal(purchase(409, "offer_already_boosted"), "Cette annonce est déjà boostée.");
    assert.equal(purchase(409, "offer_not_eligible"), "Cette annonce ne peut pas être boostée : elle doit être en ligne et disponible.");
    assert.match(purchase(409, "idempotency_conflict"), /conflit avec une demande précédente/);
    assert.equal(purchase(503, "boost_purchase_unavailable"), "L'achat de boost est temporairement indisponible. Réessayez dans un instant.");
    assert.match(purchase(404, "resource_not_found"), /introuvable/);
    assert.match(purchase(400, "invalid_request"), /n'est pas valide/);
  });

  test("429 (limite de débit) : message propre au portefeuille et à l'achat, jamais celui des codes de connexion", () => {
    for (const context of ["wallet", "purchase"] as const) {
      for (const code of ["rate_limited", "too_many_requests", "otp_request_limited"]) {
        assert.equal(describeApiError(new ApiError(429, code, "ignoré"), context), "Trop de tentatives, réessayez dans un instant.", `${context}/${code}`);
      }
    }
    // Les autres contextes gardent leur message.
    assert.equal(describeApiError(new ApiError(429, "otp_request_limited", "x"), "otp-request"), "Trop de demandes de code. Patientez quelques minutes avant de réessayer.");
    assert.equal(describeApiError(new ApiError(429, "x", "x"), "catalog"), "Trop de demandes de code. Patientez quelques minutes avant de réessayer.");
  });

  test("tous les codes : message en français, distinct, sans le code brut ni le texte du serveur", () => {
    const walletCodes: [number, string][] = [[400, "invalid_request"], [404, "resource_not_found"], [409, "too_many_pending_topups"], [409, "idempotency_conflict"], [503, "payment_unavailable"], [503, "wallet_unavailable"]];
    const purchaseCodes: [number, string][] = [
      [400, "invalid_request"], [404, "resource_not_found"], [409, "insufficient_balance"], [409, "quote_expired"], [409, "quote_already_used"], [409, "quote_unavailable"],
      [409, "offer_not_eligible"], [409, "offer_already_boosted"], [409, "no_slot_available"], [409, "seller_boost_limit_reached"], [409, "no_visible_effect"], [409, "idempotency_conflict"], [503, "boost_purchase_unavailable"], [503, "reach_check_unavailable"],
    ];
    for (const [status, code] of walletCodes) {
      const text = wallet(status, code);
      assert.equal(text.includes(code), false, `wallet ${code}`);
      assert.equal(/[a-z]+_[a-z]+/.test(text), false, `wallet ${code} : « ${text} »`);
    }
    const seen = new Set<string>();
    for (const [status, code] of purchaseCodes) {
      const text = purchase(status, code);
      assert.equal(text.includes(code), false, `purchase ${code}`);
      assert.equal(/[a-z]+_[a-z]+/.test(text), false, `purchase ${code} : « ${text} »`);
      assert.notEqual(text, GENERIC_ERROR_MESSAGE, code);
      if (code !== "invalid_request" && code !== "resource_not_found") seen.add(text);
    }
    assert.equal(seen.size, purchaseCodes.length - 2, "chaque code d'achat a son propre message");
  });

  test("code inconnu : jamais le code brut (messages génériques pour 400, 404 et 409, comme pour toute exception)", () => {
    for (const context of ["wallet", "purchase"] as const) {
      for (const status of [400, 404, 409]) {
        assert.equal(describeApiError(new ApiError(status, "code_futur_inconnu", "ignoré"), context), GENERIC_ERROR_MESSAGE, `${context}/${status}`);
      }
      assert.equal(describeApiError(new ApiError(0, API_NETWORK_ERROR, "x"), context), "Connexion impossible. Vérifiez votre réseau et réessayez.");
      assert.equal(describeApiError(new ApiError(0, API_INVALID_ARGUMENT, "x"), context), "Paramètre invalide. Rechargez la page.");
      assert.equal(describeApiError(new ApiError(200, API_INVALID_RESPONSE, "x"), context), GENERIC_ERROR_MESSAGE);
    }
  });
});
