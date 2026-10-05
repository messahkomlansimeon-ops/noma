import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  API_ABORTED,
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
  const contexts: ApiErrorContext[] = ["otp-request", "otp-verify", "catalog", "default"];

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
