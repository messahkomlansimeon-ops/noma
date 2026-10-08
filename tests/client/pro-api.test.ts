import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ApiError, describeApiError, OFFER_LIMIT_REACHED_MESSAGE } from "../../lib/client/api";
import { createProClient } from "../../lib/client/pro-api";

/** Client de l'offre Pro (lot PRO1) : requêtes exactes, réponses relues champ par champ (liste blanche), erreurs en messages fixes. */

const UUID_A = "1a1a1a1a-2b2b-4c3c-8d4d-5e5e5e5e5e5e";
const UUID_B = "2a2a2a2a-2b2b-4c3c-8d4d-5e5e5e5e5e5e";
const NOW = "2026-10-06T10:00:00.000Z";
const LATER = "2026-11-06T10:00:00.000Z";

interface Seen { url: string; method: string; body: unknown; credentials: string | undefined; cache: string | undefined; contentType: string | null }

function client(respond: (seen: Seen) => { status: number; body: unknown }) {
  const calls: Seen[] = [];
  const fetchStub = (async (input: string, init: RequestInit) => {
    const headers = new Headers(init.headers as HeadersInit);
    const seen: Seen = {
      url: input, method: String(init.method), body: init.body === undefined ? undefined : JSON.parse(String(init.body)), credentials: init.credentials, cache: init.cache,
      contentType: headers.get("content-type"),
    };
    calls.push(seen);
    const answer = respond(seen);
    return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { api: createProClient({ fetch: fetchStub }), calls };
}

const plans = () => [
  { code: "free", name: "Gratuit", version: 1, monthlyPriceXof: 0, promoCreditsXof: 0, maxOnlineOffers: 10, entitlements: [] },
  { code: "pro", name: "Pro", version: 1, monthlyPriceXof: 10_000, promoCreditsXof: 5_000, maxOnlineOffers: 100, entitlements: ["badge_pro", "catalog_import"] },
];
const subscription = (overrides: Record<string, unknown> = {}) => ({
  planCode: "pro", status: "active", periodStart: NOW, periodEnd: LATER, autoRenew: true, canceledAt: null, graceEndsAt: null, currentPriceXof: 10_000, renewalPriceXof: 10_000, entitled: true, ...overrides,
});
const state = (overrides: Record<string, unknown> = {}) => ({
  contractVersion: "subscription/v1", pricesProvisional: true, plans: plans(),
  current: { source: "subscription", planCode: "pro", planName: "Pro", maxOnlineOffers: 100, entitlements: ["badge_pro", "catalog_import"] },
  onlineOffers: 3, subscription: subscription(), promo: { balanceXof: 5_000, expiresAt: LATER },
  notices: [{ id: UUID_A, code: "renewal_failed", listingCount: null, createdAt: NOW, readAt: null }], unreadNotices: 1, readAt: NOW, ...overrides,
});

describe("abonnement", () => {
  test("state : GET /api/subscription, plans, droits, abonnement, crédits promotionnels, avis relus champ par champ ; même origine, sans cache", async () => {
    const { api, calls } = client(() => ({ status: 200, body: state() }));
    const result = await api.subscription.state();
    assert.equal(calls[0].url, "/api/subscription");
    assert.equal(calls[0].method, "GET");
    assert.ok(calls[0].credentials === "same-origin" && calls[0].cache === "no-store");
    assert.equal(result.pricesProvisional, true);
    assert.deepEqual(result.plans.map((plan) => [plan.code, plan.monthlyPriceXof]), [["free", 0], ["pro", 10_000]]);
    assert.equal(result.current.source, "subscription");
    assert.equal(result.subscription?.autoRenew, true);
    assert.deepEqual(result.promo, { balanceXof: 5_000, expiresAt: LATER });
    assert.equal(result.notices[0].code, "renewal_failed");
    assert.equal(result.unreadNotices, 1);
    // Sans abonnement.
    const free = client(() => ({ status: 200, body: state({ subscription: null, current: { source: "free", planCode: "free", planName: "Gratuit", maxOnlineOffers: 10, entitlements: [] }, promo: { balanceXof: 0, expiresAt: null }, notices: [], unreadNotices: 0 }) }));
    assert.equal((await free.api.subscription.state()).subscription, null);
  });

  test("state : un champ que le serveur ajouterait n'atteint jamais l'écran (identifiant, compte, version de plan)", async () => {
    const SECRET_USER = "9a9a9a9a-2b2b-4c3c-8d4d-5e5e5e5e5e5e";
    const SECRET_VERSION = "8a8a8a8a-2b2b-4c3c-8d4d-5e5e5e5e5e5e";
    const hostile = state({ userId: SECRET_USER, plans: plans().map((plan) => ({ ...plan, versionId: SECRET_VERSION })), subscription: { ...subscription(), id: SECRET_VERSION, transactionId: SECRET_USER } });
    const { api } = client(() => ({ status: 200, body: hostile }));
    const result = await api.subscription.state();
    const text = JSON.stringify(result);
    for (const secret of [SECRET_USER, SECRET_VERSION, "versionId", "transactionId", "userId"]) assert.equal(text.includes(secret), false, secret);
    assert.deepEqual(Object.keys(result.plans[0]).sort(), ["code", "entitlements", "maxOnlineOffers", "monthlyPriceXof", "name", "promoCreditsXof", "version"]);
    assert.deepEqual(Object.keys(result.subscription!).sort(), ["autoRenew", "canceledAt", "currentPriceXof", "entitled", "graceEndsAt", "periodEnd", "periodStart", "planCode", "renewalPriceXof", "status"]);
  });

  test("state : l'avis « annonces remises en ligne » est accepté avec son nombre (au moins 1)", async () => {
    const { api } = client(() => ({ status: 200, body: state({ notices: [{ id: UUID_A, code: "listings_restored", listingCount: 3, createdAt: NOW, readAt: null }] }) }));
    const result = await api.subscription.state();
    assert.deepEqual([result.notices[0].code, result.notices[0].listingCount], ["listings_restored", 3]);
  });

  test("state : réponse hors liste blanche = invalid_response (contrat, montant non sûr, droit inconnu, statut, avis incohérent, date illisible)", async () => {
    const bad = (override: Record<string, unknown>) => client(() => ({ status: 200, body: state(override) })).api.subscription.state();
    for (const override of [
      { contractVersion: "subscription/v2" }, { pricesProvisional: "oui" }, { plans: "x" }, { onlineOffers: -1 }, { promo: { balanceXof: 1.5, expiresAt: null } }, { promo: { balanceXof: -1, expiresAt: null } },
      { plans: [{ ...plans()[1], entitlements: ["inconnu"] }] }, { plans: [{ ...plans()[1], monthlyPriceXof: 2 ** 60 }] },
      { subscription: subscription({ status: "ended" }) }, { subscription: subscription({ periodEnd: "pas une date" }) }, { subscription: subscription({ autoRenew: "oui" }) },
      { notices: [{ id: UUID_A, code: "inconnu", listingCount: null, createdAt: NOW, readAt: null }] },
      { notices: [{ id: UUID_A, code: "listings_paused", listingCount: null, createdAt: NOW, readAt: null }] },
      { notices: [{ id: UUID_A, code: "listings_restored", listingCount: null, createdAt: NOW, readAt: null }] },
      { notices: [{ id: UUID_A, code: "renewal_failed", listingCount: 3, createdAt: NOW, readAt: null }] },
      { current: { source: "autre", planCode: "free", planName: "Gratuit", maxOnlineOffers: 10, entitlements: [] } },
    ]) {
      await assert.rejects(bad(override), (error: unknown) => error instanceof ApiError && error.code === "invalid_response", JSON.stringify(Object.keys(override)));
    }
  });

  test("subscribe : POST /api/subscription avec exactement { planCode, idempotencyKey } ; 201 puis 200 (rejeu) ; clé et plan vérifiés AVANT la requête", async () => {
    let call = 0;
    const { api, calls } = client(() => ({ status: call++ === 0 ? 201 : 200, body: { ...state(), reused: call > 1 } }));
    const first = await api.subscription.subscribe({ planCode: "pro", idempotencyKey: UUID_A });
    const replay = await api.subscription.subscribe({ planCode: "pro", idempotencyKey: UUID_A });
    assert.equal(first.reused, false);
    assert.equal(replay.reused, true);
    assert.equal(first.state.subscription?.status, "active");
    assert.deepEqual(calls[0].body, { planCode: "pro", idempotencyKey: UUID_A });
    assert.equal(calls[0].contentType, "application/json");
    assert.deepEqual(calls[0].body, calls[1].body, "le rejeu envoie exactement la même requête");
    const before = calls.length;
    for (const request of [{ planCode: "Pro", idempotencyKey: UUID_A }, { planCode: "pro", idempotencyKey: "x" }, { planCode: 5, idempotencyKey: UUID_A }, undefined]) {
      await assert.rejects(api.subscription.subscribe(request as never), (error: unknown) => error instanceof ApiError && error.code === "invalid_argument" && error.status === 0);
    }
    assert.equal(calls.length, before, "aucune requête pour un argument invalide");
  });

  test("setAutoRenew et markNoticesRead : corps exacts, arguments vérifiés avant la requête", async () => {
    const { api, calls } = client((seen) => (seen.url.endsWith("/read") ? { status: 200, body: { contractVersion: "subscription/v1", unreadNotices: 0 } } : { status: 200, body: state() }));
    assert.equal((await api.subscription.setAutoRenew(false)).current.planCode, "pro");
    assert.deepEqual(calls[0].body, { autoRenew: false });
    assert.equal(calls[0].url, "/api/subscription/auto-renew");
    assert.equal(await api.subscription.markNoticesRead({ all: true }), 0);
    assert.deepEqual(calls[1].body, { all: true });
    assert.equal(await api.subscription.markNoticesRead({ ids: [UUID_A, UUID_B] }), 0);
    assert.deepEqual(calls[2].body, { ids: [UUID_A, UUID_B] });
    const before = calls.length;
    await assert.rejects(api.subscription.setAutoRenew("non" as never), (error: unknown) => error instanceof ApiError && error.code === "invalid_argument");
    await assert.rejects(api.subscription.markNoticesRead({ ids: [] }), (error: unknown) => error instanceof ApiError && error.code === "invalid_argument");
    await assert.rejects(api.subscription.markNoticesRead({ ids: ["x"] }), (error: unknown) => error instanceof ApiError && error.code === "invalid_argument");
    assert.equal(calls.length, before);
  });

  test("erreurs du serveur : statut et code viennent du corps seulement ; une réponse sans corps d'erreur = invalid_response", async () => {
    const fail = (status: number, code: string) => client(() => ({ status, body: { error: { code, message: "Texte du serveur" } } })).api.subscription.state();
    await assert.rejects(fail(409, "already_subscribed"), (error: unknown) => error instanceof ApiError && error.status === 409 && error.code === "already_subscribed");
    await assert.rejects(fail(403, "entitlement_required"), (error: unknown) => error instanceof ApiError && error.status === 403 && error.code === "entitlement_required");
    await assert.rejects(client(() => ({ status: 500, body: "boum" })).api.subscription.state(), (error: unknown) => error instanceof ApiError && error.code === "invalid_response" && error.status === 500);
    await assert.rejects(
      createProClient({ fetch: (async () => { throw new TypeError("secret interne"); }) as unknown as typeof fetch }).subscription.state(),
      (error: unknown) => error instanceof ApiError && error.code === "network_error" && !error.message.includes("secret"),
    );
  });
});

describe("import de catalogue", () => {
  const report = (overrides: Record<string, unknown> = {}) => ({
    contractVersion: "catalog-import/v1", mode: "preview", alreadyApplied: false, rowCount: 2, acceptedCount: 1, rejectedCount: 1,
    rows: [
      { line: 2, outcome: "would_create", code: null, field: null, offerId: null },
      { line: 3, outcome: "rejected", code: "invalid_field", field: "price", offerId: null },
    ], ...overrides,
  });

  test("run : POST /api/offers/import avec exactement { csv, dryRun } ; le rapport est relu champ par champ", async () => {
    const { api, calls } = client(() => ({ status: 200, body: report() }));
    const result = await api.catalogImport.run({ csv: "titre\nA", dryRun: true });
    assert.deepEqual(calls[0].body, { csv: "titre\nA", dryRun: true });
    assert.equal(calls[0].url, "/api/offers/import");
    assert.equal(result.mode, "preview");
    assert.equal(result.acceptedCount, 1);
    assert.deepEqual(result.rows[1], { line: 3, outcome: "rejected", code: "invalid_field", field: "price", offerId: null });
    const applied = client(() => ({ status: 201, body: report({ mode: "apply", rows: [{ line: 2, outcome: "created", code: null, field: null, offerId: UUID_A }, { line: 3, outcome: "rejected", code: "phone_number_in_offer", field: null, offerId: null }] }) }));
    assert.equal((await applied.api.catalogImport.run({ csv: "titre\nA", dryRun: false })).rows[0].offerId, UUID_A);
    await assert.rejects(api.catalogImport.run({ csv: 5 as never, dryRun: true }), (error: unknown) => error instanceof ApiError && error.code === "invalid_argument");
    await assert.rejects(api.catalogImport.run({ csv: "x", dryRun: "oui" as never }), (error: unknown) => error instanceof ApiError && error.code === "invalid_argument");
  });

  test("run : rapport hors liste blanche = invalid_response (compteurs incohérents, issue ou code inconnu, identifiant invalide)", async () => {
    const bad = (override: Record<string, unknown>) => client(() => ({ status: 200, body: report(override) })).api.catalogImport.run({ csv: "titre\nA", dryRun: true });
    for (const override of [
      { rowCount: 3 }, { acceptedCount: 2 }, { mode: "autre" }, { contractVersion: "x" }, { rows: [] },
      { rows: [{ line: 2, outcome: "bizarre", code: null, field: null, offerId: null }, report().rows[1]] },
      { rows: [report().rows[0], { line: 3, outcome: "rejected", code: "Code Invalide", field: null, offerId: null }] },
      { rows: [report().rows[0], { line: 3, outcome: "rejected", code: null, field: null, offerId: "pas-un-uuid" }] },
      { rows: [report().rows[0], { line: 0, outcome: "rejected", code: null, field: null, offerId: null }] },
    ]) {
      await assert.rejects(bad(override), (error: unknown) => error instanceof ApiError && error.code === "invalid_response", JSON.stringify(Object.keys(override)));
    }
  });
});

describe("administration des plans", () => {
  const version = (overrides: Record<string, unknown> = {}) => ({ version: 1, name: "Pro", monthlyPriceXof: 10_000, promoCreditsXof: 5_000, maxOnlineOffers: 100, entitlements: ["badge_pro"], createdAt: NOW, ...overrides });
  const overview = (overrides: Record<string, unknown> = {}) => ({
    contractVersion: "admin-plans/v1", pricesProvisional: true, plans: [{ code: "pro", versions: [version()] }], subscribers: [{ planCode: "pro", approximateCount: 5 }], totalSubscribersApproximate: 5,
    month: { startsAt: NOW, endsAt: LATER }, subscriptionRevenueXof: 40_000, promo: { issuedXof: 20_000, spentXof: 2_300, expiredXof: 0 }, readAt: NOW, ...overrides,
  });

  test("overview et createVersion : requêtes exactes ; abonnés toujours des multiples de 5 ; une valeur non arrondie est refusée", async () => {
    const { api, calls } = client((seen) => (seen.method === "GET" ? { status: 200, body: overview() } : { status: 201, body: { contractVersion: "admin-plans/v1", planCode: "pro", version: version({ version: 2 }) } }));
    const result = await api.adminPlans.overview();
    assert.equal(result.subscribers[0].approximateCount, 5);
    assert.equal(result.subscriptionRevenueXof, 40_000);
    const created = await api.adminPlans.createVersion("pro", { name: "Pro", monthlyPriceXof: 12_000, promoCreditsXof: 6_000, maxOnlineOffers: 150, entitlements: ["badge_pro"] });
    assert.equal(created.version, 2);
    assert.equal(calls[1].url, "/api/admin/plans/pro/versions");
    assert.deepEqual(calls[1].body, { name: "Pro", monthlyPriceXof: 12_000, promoCreditsXof: 6_000, maxOnlineOffers: 150, entitlements: ["badge_pro"] });
    const exact = client(() => ({ status: 200, body: overview({ subscribers: [{ planCode: "pro", approximateCount: 4 }] }) }));
    await assert.rejects(exact.api.adminPlans.overview(), (error: unknown) => error instanceof ApiError && error.code === "invalid_response");
    await assert.rejects(api.adminPlans.createVersion("Pro!", { name: "x", monthlyPriceXof: 1, promoCreditsXof: 0, maxOnlineOffers: 1, entitlements: [] }), (error: unknown) => error instanceof ApiError && error.code === "invalid_id");
  });

  test("un non-administrateur reçoit le 404 du serveur tel quel", async () => {
    const { api } = client(() => ({ status: 404, body: { error: { code: "resource_not_found", message: "Ressource introuvable." } } }));
    await assert.rejects(api.adminPlans.overview(), (error: unknown) => error instanceof ApiError && error.status === 404 && error.code === "resource_not_found");
  });
});

describe("messages fixes", () => {
  test("abonnement et import : un message en français par code connu, jamais le code brut ni le texte du serveur", () => {
    const failure = (status: number, code: string) => new ApiError(status, code, "TEXTE DU SERVEUR");
    assert.match(describeApiError(failure(409, "insufficient_balance"), "subscription"), /Solde insuffisant.*crédits payés/);
    assert.match(describeApiError(failure(409, "already_subscribed"), "subscription"), /déjà un abonnement/);
    assert.match(describeApiError(failure(409, "period_ended"), "subscription"), /Souscrivez de nouveau/);
    assert.equal(describeApiError(failure(409, "code_inconnu"), "subscription").includes("code_inconnu"), false);
    assert.equal(describeApiError(failure(409, "code_inconnu"), "subscription").includes("TEXTE"), false);
    assert.match(describeApiError(failure(403, "entitlement_required"), "import"), /réservé à l'offre Pro/);
    assert.match(describeApiError(failure(400, "too_many_rows"), "import"), /plus de 200 lignes/);
    assert.match(describeApiError(failure(400, "invalid_file"), "import"), /illisible/);
    assert.match(describeApiError(failure(413, "payload_too_large"), "import"), /trop volumineux/);
    assert.equal(describeApiError(failure(409, "offer_limit_reached"), "catalog"), OFFER_LIMIT_REACHED_MESSAGE);
    assert.equal(describeApiError(failure(409, "offer_limit_reached"), "default"), OFFER_LIMIT_REACHED_MESSAGE);
    assert.match(OFFER_LIMIT_REACHED_MESSAGE, /pause|offre Pro/);
  });
});
