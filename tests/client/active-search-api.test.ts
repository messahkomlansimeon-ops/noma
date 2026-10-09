import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { API_INVALID_ARGUMENT, API_INVALID_ID, API_INVALID_RESPONSE, API_NETWORK_ERROR, ApiError, ACTIVE_SEARCH_ERROR_MESSAGES, GENERIC_ERROR_MESSAGE, describeApiError } from "../../lib/client/api";
import { ACTIVE_SEARCH_CONTRACT_VERSION, createActiveSearchClient, type ActiveSearchState } from "../../lib/client/active-search-api";

/** Couche cliente de la recherche active (lot RA1) : requêtes, lecture stricte des réponses, erreurs, messages fixes. */

const DEMAND_ID = "22222222-2222-4222-8222-222222222222";
const KEY = "0f1e2d3c-4b5a-4968-8776-a5b4c3d2e1f0";

interface Captured { url: string; init: RequestInit }
function harness(responder: (request: Captured, index: number) => Response | Promise<Response>) {
  const calls: Captured[] = [];
  const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const captured = { url: String(input), init: init ?? {} };
    calls.push(captured);
    return responder(captured, calls.length - 1);
  }) as typeof fetch;
  return { client: createActiveSearchClient({ fetch: fakeFetch }), calls };
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const stateDto = (overrides: Record<string, unknown> = {}) => ({
  contractVersion: ACTIVE_SEARCH_CONTRACT_VERSION, priceProvisional: true, paidCreditsOnly: true, autoRenew: false, demandId: DEMAND_ID, demandStatus: "active", active: false, suspended: false, accelerationPending: false, startsAt: null, endsAt: null,
  remainingDays: null, purchasedPeriods: 0, nextEndsAt: "2031-02-01T10:00:00.000Z", maxEndsAt: "2031-07-01T10:00:00.000Z", canPurchase: true, blockedReason: null, expiringSoon: false, priceXof: 2_000,
  durationDays: 30, balanceXof: 5_000, readAt: "2031-01-02T10:00:00.000Z", ...overrides,
});
const activeDto = (overrides: Record<string, unknown> = {}) => stateDto({ active: true, startsAt: "2031-01-02T10:00:00.000Z", endsAt: "2031-02-01T10:00:00.000Z", remainingDays: 30, purchasedPeriods: 1, nextEndsAt: "2031-03-03T10:00:00.000Z", ...overrides });
const purchaseDto = (overrides: Record<string, unknown> = {}) => ({
  ...activeDto(), purchase: { kind: "activation", reused: false, startsAt: "2031-01-02T10:00:00.000Z", endsAt: "2031-02-01T10:00:00.000Z", priceXof: 2_000 }, ...overrides,
});
const adminDto = (overrides: Record<string, unknown> = {}) => ({
  contractVersion: ACTIVE_SEARCH_CONTRACT_VERSION, priceProvisional: true, activeApproximate: 10, month: { startsAt: "2031-01-01T00:00:00.000Z", endsAt: "2031-02-01T00:00:00.000Z" }, revenueXof: 14_000,
  readAt: "2031-01-02T10:00:00.000Z", ...overrides,
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

describe("client.state", () => {
  test("GET /api/demands/{id}/active-search, même origine, sans cache ; réponse relue champ par champ", async () => {
    const { client, calls } = harness(() => json(200, stateDto()));
    const state: ActiveSearchState = await client.state(DEMAND_ID);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `/api/demands/${DEMAND_ID}/active-search`);
    assert.equal(calls[0].init.method, "GET");
    assert.equal(calls[0].init.credentials, "same-origin");
    assert.equal(calls[0].init.cache, "no-store");
    assert.equal(calls[0].init.body, undefined);
    assert.deepEqual(Object.keys(state).sort(), [
      "accelerationPending", "active", "autoRenew", "balanceXof", "blockedReason", "canPurchase", "demandId", "demandStatus", "durationDays", "endsAt", "expiringSoon", "maxEndsAt", "nextEndsAt", "paidCreditsOnly", "priceProvisional",
      "priceXof", "purchasedPeriods", "readAt", "remainingDays", "startsAt", "suspended",
    ]);
    assert.deepEqual([state.priceProvisional, state.paidCreditsOnly, state.autoRenew, state.priceXof, state.durationDays, state.balanceXof], [true, true, false, 2_000, 30, 5_000]);
  });

  test("B1 / A4 : toutes les raisons de blocage du serveur et l'option suspendue sont relues", async () => {
    for (const reason of ["demand_not_active", "no_product_key", "unavailable", "user_cap", "capacity", "max_horizon"] as const) {
      const { client } = harness(() => json(200, stateDto({ canPurchase: false, nextEndsAt: null, blockedReason: reason })));
      const state = await client.state(DEMAND_ID);
      assert.deepEqual([state.canPurchase, state.blockedReason], [false, reason]);
    }
    const suspended = harness(() => json(200, stateDto({ demandStatus: "satisfied", suspended: true, endsAt: "2031-02-01T10:00:00.000Z", remainingDays: 30, canPurchase: false, nextEndsAt: null, blockedReason: "demand_not_active" })));
    const state = await suspended.client.state(DEMAND_ID);
    assert.deepEqual([state.suspended, state.active, state.demandStatus], [true, false, "satisfied"]);
  });

  test("un champ en plus du serveur n'est pas relayé (liste blanche)", async () => {
    const { client } = harness(() => json(200, { ...stateDto(), purchaseId: KEY, transactionId: KEY, extra: "x" }));
    const state = await client.state(DEMAND_ID);
    assert.equal(JSON.stringify(state).includes(KEY), false);
    assert.equal("extra" in state, false);
  });

  test("réponse invalide : version de contrat, crédits payés, renouvellement automatique, cohérences, dates, montants", async () => {
    const bad: Array<[string, Record<string, unknown>]> = [
      ["version", { contractVersion: "active-search/v2" }],
      ["crédits promotionnels", { paidCreditsOnly: false }],
      ["renouvellement automatique", { autoRenew: true }],
      ["prix provisoire non booléen", { priceProvisional: "oui" }],
      ["identifiant", { demandId: "pas-un-uuid" }],
      ["achat possible sans fin prévue", { nextEndsAt: null }],
      ["blocage sans raison", { canPurchase: false, nextEndsAt: null }],
      ["raison inconnue", { canPurchase: false, nextEndsAt: null, blockedReason: "autre" }],
      ["suspendue non booléen", { suspended: "oui" }],
      ["suspendue sans fin connue", { suspended: true, endsAt: null }],
      ["suspendue et en vigueur", { suspended: true, active: true, startsAt: "2031-01-02T10:00:00.000Z", endsAt: "2031-02-01T10:00:00.000Z" }],
      ["en vigueur sans fin", { active: true, startsAt: "2031-01-02T10:00:00.000Z" }],
      ["date illisible", { readAt: "hier" }],
      ["montant négatif", { balanceXof: -1 }],
      ["montant non entier", { priceXof: 1999.5 }],
      ["jours restants négatifs", { remainingDays: -1 }],
      ["statut de besoin technique", { demandStatus: "Actif!" }],
    ];
    for (const [label, overrides] of bad) {
      const { client } = harness(() => json(200, stateDto(overrides)));
      const error = await rejection(client.state(DEMAND_ID));
      assert.equal(error.code, API_INVALID_RESPONSE, label);
    }
    const { client } = harness(() => json(200, "texte"));
    assert.equal((await rejection(client.state(DEMAND_ID))).code, API_INVALID_RESPONSE);
  });

  test("identifiant invalide : refusé AVANT toute requête", async () => {
    const { client, calls } = harness(() => json(200, stateDto()));
    assert.equal((await rejection(client.state("pas-un-uuid"))).code, API_INVALID_ID);
    assert.equal(calls.length, 0);
  });

  test("erreurs : le code vient du corps du serveur ou d'un code fixe, jamais d'un texte libre ; réseau coupé et annulation distingués", async () => {
    const refused = harness(() => json(404, { error: { code: "resource_not_found", message: "Ressource introuvable." } }));
    const notFound = await rejection(refused.client.state(DEMAND_ID));
    assert.deepEqual([notFound.status, notFound.code], [404, "resource_not_found"]);
    const html = harness(() => new Response("<html>boom</html>", { status: 502 }));
    assert.deepEqual(await rejection(html.client.state(DEMAND_ID)).then((error) => [error.status, error.code]), [502, API_INVALID_RESPONSE]);
    const weirdCode = harness(() => json(409, { error: { code: "Pas un code!", message: "x" } }));
    assert.equal((await rejection(weirdCode.client.state(DEMAND_ID))).code, API_INVALID_RESPONSE);
    const down = createActiveSearchClient({ fetch: (async () => { throw new TypeError("fetch failed"); }) as typeof fetch });
    assert.equal((await rejection(down.state(DEMAND_ID))).code, API_NETWORK_ERROR);
  });
});

describe("client.purchase", () => {
  test("POST {idempotencyKey, expectedPriceXof} seulement, JSON ; 201 → résultat et état relu", async () => {
    const { client, calls } = harness(() => json(201, purchaseDto()));
    const result = await client.purchase(DEMAND_ID, KEY, 2_000);
    assert.equal(calls[0].url, `/api/demands/${DEMAND_ID}/active-search`);
    assert.equal(calls[0].init.method, "POST");
    assert.deepEqual(JSON.parse(String(calls[0].init.body)), { idempotencyKey: KEY, expectedPriceXof: 2_000 }, "le prix AFFICHÉ est envoyé");
    assert.equal((calls[0].init.headers as Record<string, string>)["Content-Type"], "application/json");
    assert.deepEqual([result.reused, result.kind, result.priceXof, result.endsAt, result.state.active], [false, "activation", 2_000, "2031-02-01T10:00:00.000Z", true]);
  });

  test("rejeu (200) : reused, aucun second débit côté serveur ; prolongation : kind extension", async () => {
    const reused = harness(() => json(200, purchaseDto({ purchase: { kind: "extension", reused: true, startsAt: "2031-02-01T10:00:00.000Z", endsAt: "2031-03-03T10:00:00.000Z", priceXof: 2_000 } })));
    const result = await reused.client.purchase(DEMAND_ID, KEY, 2_000);
    assert.deepEqual([result.reused, result.kind], [true, "extension"]);
  });

  test("arguments invalides refusés avant toute requête ; réponse sans achat ou à l'achat invalide refusée", async () => {
    const { client, calls } = harness(() => json(201, purchaseDto()));
    assert.equal((await rejection(client.purchase("x", KEY, 2_000))).code, API_INVALID_ID);
    assert.equal((await rejection(client.purchase(DEMAND_ID, "x", 2_000))).code, API_INVALID_ARGUMENT);
    // A6 : le prix affiché est obligatoire, entier, positif.
    for (const price of [0, -2_000, 2_000.5, Number.NaN, undefined as unknown as number, "2000" as unknown as number]) {
      assert.equal((await rejection(client.purchase(DEMAND_ID, KEY, price))).code, API_INVALID_ARGUMENT, String(price));
    }
    assert.equal(calls.length, 0);
    for (const purchase of [undefined, null, { kind: "autre", reused: false, startsAt: "2031-01-02T10:00:00.000Z", endsAt: "2031-02-01T10:00:00.000Z", priceXof: 2_000 }, { kind: "activation", reused: "non", startsAt: "2031-01-02T10:00:00.000Z", endsAt: "2031-02-01T10:00:00.000Z", priceXof: 2_000 }, { kind: "activation", reused: false, startsAt: "x", endsAt: "2031-02-01T10:00:00.000Z", priceXof: 2_000 }, { kind: "activation", reused: false, startsAt: "2031-01-02T10:00:00.000Z", endsAt: "2031-02-01T10:00:00.000Z", priceXof: -1 }]) {
      const broken = harness(() => json(201, { ...activeDto(), purchase }));
      assert.equal((await rejection(broken.client.purchase(DEMAND_ID, KEY, 2_000))).code, API_INVALID_RESPONSE, JSON.stringify(purchase));
    }
  });

  test("refus du serveur : le code est conservé, le message affiché est TOUJOURS le texte fixe du client", async () => {
    for (const [status, code] of [[409, "insufficient_balance"], [409, "demand_not_active"], [409, "no_product_key"], [409, "unavailable"], [409, "user_cap"], [409, "capacity"], [409, "price_changed"], [409, "purchase_refunded"], [409, "max_horizon"], [409, "idempotency_conflict"], [404, "resource_not_found"], [400, "invalid_request"], [503, "active_search_unavailable"]] as const) {
      const { client } = harness(() => json(status, { error: { code, message: "Texte du serveur qui ne doit pas s'afficher" } }));
      const error = await rejection(client.purchase(DEMAND_ID, KEY, 2_000));
      assert.equal(error.code, code);
      const message = describeApiError(error, "active-search");
      assert.equal(message, ACTIVE_SEARCH_ERROR_MESSAGES[code]);
      assert.equal(message.includes(code), false, "jamais le code brut");
      assert.equal(message.includes("serveur qui ne doit pas"), false);
    }
  });
});

describe("messages fixes de la recherche active", () => {
  test("le solde insuffisant dit que seuls les crédits payés règlent l'option ; un code inconnu donne le message générique", () => {
    assert.match(ACTIVE_SEARCH_ERROR_MESSAGES.insufficient_balance, /Seuls vos crédits payés règlent la recherche active, pas les crédits promotionnels\./);
    assert.match(ACTIVE_SEARCH_ERROR_MESSAGES.max_horizon, /180 jours/);
    assert.match(ACTIVE_SEARCH_ERROR_MESSAGES.unavailable, /pas encore disponible/);
    assert.match(ACTIVE_SEARCH_ERROR_MESSAGES.no_product_key, /Option indisponible pour ce besoin/);
    assert.match(ACTIVE_SEARCH_ERROR_MESSAGES.price_changed, /prix de la recherche active a changé/);
    assert.match(ACTIVE_SEARCH_ERROR_MESSAGES.purchase_refunded, /remboursée/);
    assert.equal(describeApiError(new ApiError(409, "code_inconnu", "x"), "active-search"), GENERIC_ERROR_MESSAGE);
    assert.equal(describeApiError(new ApiError(500, "insufficient_balance", "x"), "active-search"), GENERIC_ERROR_MESSAGE, "un 500 n'affiche pas le message d'un refus de domaine");
    for (const text of Object.values(ACTIVE_SEARCH_ERROR_MESSAGES)) assert.equal(/[a-z]+_[a-z0-9_]+/.test(text), false, text);
  });
});

describe("client.adminOverview", () => {
  test("GET /api/admin/active-search ; options arrondies à 5 près exigées ; revenu entier", async () => {
    const { client, calls } = harness(() => json(200, adminDto()));
    const overview = await client.adminOverview.read();
    assert.equal(calls[0].url, "/api/admin/active-search");
    assert.deepEqual([overview.activeApproximate, overview.revenueXof, overview.priceProvisional], [10, 14_000, true]);
    for (const overrides of [{ activeApproximate: 7 }, { activeApproximate: -5 }, { revenueXof: 1.5 }, { month: { startsAt: "x", endsAt: "y" } }, { contractVersion: "x" }, { readAt: "x" }]) {
      const broken = harness(() => json(200, adminDto(overrides)));
      assert.equal((await rejection(broken.client.adminOverview.read())).code, API_INVALID_RESPONSE, JSON.stringify(overrides));
    }
    const notAdmin = harness(() => json(404, { error: { code: "resource_not_found", message: "Ressource introuvable." } }));
    assert.equal((await rejection(notAdmin.client.adminOverview.read())).status, 404);
  });
});

describe("accélération en attente de place (lot RA1-ter)", () => {
  test("accelerationPending est un booléen exigé ; il n'est vrai que pour une option en vigueur ; relu tel quel", async () => {
    const pending = await harness(() => json(200, activeDto({ accelerationPending: true }))).client.state(DEMAND_ID);
    assert.deepEqual([pending.active, pending.accelerationPending], [true, true]);
    const running = await harness(() => json(200, activeDto())).client.state(DEMAND_ID);
    assert.equal(running.accelerationPending, false);
    for (const accelerationPending of [undefined, "oui", 1, null]) {
      const { client } = harness(() => json(200, activeDto({ accelerationPending })));
      assert.equal((await rejection(client.state(DEMAND_ID))).code, API_INVALID_RESPONSE, String(accelerationPending));
    }
    const inactive = harness(() => json(200, stateDto({ accelerationPending: true })));
    assert.equal((await rejection(inactive.client.state(DEMAND_ID))).code, API_INVALID_RESPONSE, "en attente de place sans option en vigueur : incohérent");
  });

  test("plafond par compte : la raison user_cap est relue et son message est fixe", async () => {
    const { client } = harness(() => json(200, stateDto({ canPurchase: false, nextEndsAt: null, blockedReason: "user_cap" })));
    assert.equal((await client.state(DEMAND_ID)).blockedReason, "user_cap");
    assert.match(ACTIVE_SEARCH_ERROR_MESSAGES.user_cap, /deux produits différents/);
  });
});
