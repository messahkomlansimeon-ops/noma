import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { API_INVALID_RESPONSE, ApiError, BUYER_HOME_CONTRACT_VERSION, VENDOR_HOME_CONTRACT_VERSION, createApiClient, describeApiError, type BuyerHome, type VendorHome } from "../../lib/client/api";
import {
  BOOST_UNTIL_PREFIX, LANDING_STEPS, buyerHomeView, matchCountText, needsText, unreadSummaryText, vendorHomeView,
} from "../../lib/client/home-view";
import { ratioText } from "../../lib/client/metrics-view";
import { PHONE_IN_OFFER_MESSAGE } from "../../lib/phone-text";

/** Lot D1 : présentation des deux accueils (fonctions pures), lecture stricte des deux réponses du serveur, message de refus d'un numéro dans une annonce. */

const DEMAND_ID = "22222222-2222-4222-8222-222222222222";
const OFFER_ID = "6f1d4f5c-9d2e-4d8e-8f56-0a8b9f0a1b2c";
const NOTIF_ID = "0f1e2d3c-4b5a-4968-8776-a5b4c3d2e1f0";

const buyerDto = (overrides: Record<string, unknown> = {}) => ({
  contractVersion: BUYER_HOME_CONTRACT_VERSION,
  activeDemandCount: 2,
  demands: [
    { id: DEMAND_ID, title: "Je cherche un iPhone 12", category: "Téléphones", brand: "Apple", model: "iPhone 12", variant: null, location: "Abidjan", budget: { amount: 200_000, currency: "XOF" }, matchCount: 9, createdAt: "2031-01-01T10:00:00.000Z" },
    { id: "33333333-3333-4333-8333-333333333333", title: "MacBook", category: "Électronique", brand: null, model: null, variant: null, location: null, budget: null, matchCount: 0, createdAt: "2031-01-01T09:00:00.000Z" },
  ],
  unreadNotifications: 3,
  notifications: [
    { id: NOTIF_ID, kind: "new_match", title: "Apple iPhone 12 64 Go", price: { amount: 128_000, currency: "XOF" }, count: null, link: `/besoins/${DEMAND_ID}/offres/${OFFER_ID}`, createdAt: "2031-01-01T10:00:00.000Z", unread: true },
    { id: "1a1a1a1a-2b2b-4c3c-8d4d-5e5e5e5e5e5e", kind: "new_matches_digest", title: null, price: null, count: 8, link: `/besoins/${DEMAND_ID}`, createdAt: "2031-01-01T08:00:00.000Z", unread: false },
  ],
  readAt: "2031-01-01T11:00:00.000Z",
  ...overrides,
});

const vendorDto = (overrides: Record<string, unknown> = {}) => ({
  contractVersion: VENDOR_HOME_CONTRACT_VERSION,
  counts: { published: 3, paused: 1, draft: 0 },
  needs: { kind: "approx", value: 15 },
  balance: 25_000,
  currency: "XOF",
  activeBoosts: [{ offerId: OFFER_ID, endsAt: "2031-01-08T10:00:00.000Z" }],
  offers: [
    { id: OFFER_ID, title: "iPhone 12 128 Go noir", status: "published", category: "Téléphones", brand: "Apple", model: "iPhone 12", variant: "128 Go", price: { amount: 165_000, currency: "XOF" }, needs: { kind: "approx", value: 10 }, boostEndsAt: "2031-01-08T10:00:00.000Z" },
    { id: "44444444-4444-4444-8444-444444444444", title: "Machine à laver", status: "paused", category: "Maison et meubles", brand: "LG", model: null, variant: null, price: null, needs: { kind: "below", bound: 5 }, boostEndsAt: null },
  ],
  readAt: "2031-01-01T11:00:00.000Z",
  ...overrides,
});

/** Les montants utilisent une espace insécable : les comparaisons de texte la ramènent à une espace simple. */
const plain = (text: string | null): string | null => (text === null ? null : text.replace(/[\u00a0\u202f]/g, " "));

function harness(body: unknown, status = 200) {
  const calls: string[] = [];
  const fakeFetch = (async (input: RequestInfo | URL) => {
    calls.push(String(input));
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { client: createApiClient({ fetch: fakeFetch }), calls };
}

describe("textes simples", () => {
  test("nombre de correspondances, notifications non lues, besoins arrondis du vendeur", () => {
    assert.equal(matchCountText(0), "Aucune annonce pour le moment");
    assert.equal(matchCountText(1), "1 annonce correspond");
    assert.equal(matchCountText(9), "9 annonces correspondent");
    assert.equal(unreadSummaryText(0), "Aucune notification non lue");
    assert.equal(unreadSummaryText(1), "1 notification non lue");
    assert.equal(unreadSummaryText(3), "3 notifications non lues");
    assert.equal(needsText({ kind: "below", bound: 5 }), "moins de 5 besoins");
    assert.equal(needsText({ kind: "approx", value: 10 }), "environ 10 besoins");
  });

  test("tout pourcentage d'une statistique s'écrit « environ X % » (jamais un pourcentage nu)", () => {
    assert.equal(ratioText({ kind: "percent", value: 70 }), "environ 70 %");
    assert.equal(ratioText({ kind: "percent", value: 0 }), "environ 0 %");
    assert.equal(ratioText({ kind: "insufficient" }), "pas assez d'acheteurs pour un pourcentage");
  });

  test("présentation du visiteur sans compte : trois étapes", () => {
    assert.equal(LANDING_STEPS.length, 3);
    assert.ok(LANDING_STEPS.every((step) => step.title.length > 5 && step.text.length > 10));
  });
});

describe("accueil de l'acheteur (buyerHomeView)", () => {
  test("besoins avec leur nombre de correspondances et un lien vers les résultats ; notifications non lues ; aucun identifiant à l'écran", async () => {
    const { client } = harness(buyerDto());
    const home = await client.home.buyer();
    const view = buyerHomeView(home);
    assert.equal(view.hasDemands, true);
    assert.deepEqual(view.demands.map((demand) => [demand.title, demand.matchText, demand.href, plain(demand.subtitle)]), [
      ["Je cherche un iPhone 12", "9 annonces correspondent", `/besoins/${DEMAND_ID}`, "Abidjan · 200 000 FCFA max"],
      ["MacBook", "Aucune annonce pour le moment", "/besoins/33333333-3333-4333-8333-333333333333", null],
    ]);
    assert.equal(view.demands[0].hasMatches, true);
    assert.equal(view.demands[1].hasMatches, false);
    assert.equal(view.hiddenDemandCount, 0);
    assert.equal(view.unreadText, "3 notifications non lues");
    assert.deepEqual(view.notifications.map((item) => [item.title, plain(item.subtitle), item.unread]), [["Apple iPhone 12 64 Go", "128 000 FCFA", true], ["8 nouvelles annonces pour ce besoin", null, false]]);
    const visible = JSON.stringify([view.demands.map((d) => [d.title, d.subtitle, d.matchText]), view.unreadText, view.notifications.map((n) => [n.title, n.subtitle])]);
    assert.equal(/[0-9a-f]{8}-[0-9a-f]{4}-/.test(visible), false, "aucun UUID dans les textes affichés");
  });

  test("aucun besoin : liste vide ; au-delà de la liste courte : le nombre de besoins non montrés", () => {
    const empty = buyerHomeView({ activeDemandCount: 0, demands: [], unreadNotifications: 0, notifications: [] } as BuyerHome);
    assert.equal(empty.hasDemands, false);
    assert.equal(empty.hasUnread, false);
    const many = buyerHomeView({ activeDemandCount: 9, demands: buyerDto().demands.map((demand) => ({ ...demand })) as never, unreadNotifications: 0, notifications: [] } as BuyerHome);
    assert.equal(many.hiddenDemandCount, 7);
  });
});

describe("tableau de bord du vendeur (vendorHomeView)", () => {
  test("annonces par statut, besoins correspondants arrondis, solde, boosts actifs, lien vers chaque annonce", async () => {
    const { client } = harness(vendorDto());
    const view = vendorHomeView(await client.home.vendor());
    assert.deepEqual(view.tiles.map((tile) => [tile.label, tile.value]), [["En ligne", "3"], ["En pause", "1"], ["Brouillons", "0"]]);
    assert.equal(view.needsText, "environ 15 besoins d'acheteurs correspondent à vos annonces en ligne");
    assert.equal(plain(view.walletText), "25 000 FCFA");
    assert.equal(view.hasBoosts, true);
    assert.deepEqual(view.boosts.map((boost) => [boost.title, boost.text]), [["iPhone 12 128 Go noir", `${BOOST_UNTIL_PREFIX}8 janvier 2031`]]);
    assert.deepEqual(view.offers.map((offer) => [offer.title, offer.statusLabel, offer.needsText, offer.boostText, offer.href]), [
      ["iPhone 12 128 Go noir", "En ligne", "environ 10 besoins correspondent", `${BOOST_UNTIL_PREFIX}8 janvier 2031`, `/vendeur/annonces/${OFFER_ID}`],
      ["Machine à laver", "En pause", null, null, "/vendeur/annonces/44444444-4444-4444-8444-444444444444"],
    ]);
    assert.equal(plain(view.offers[0].subtitle), "Apple · iPhone 12 · 128 Go · 165 000 FCFA");
  });

  test("les annonces boostées passent en premier, l'ordre des autres est conservé", async () => {
    const dto = vendorDto();
    dto.offers = [dto.offers[1], dto.offers[0]];
    const view = vendorHomeView(await harness(dto).client.home.vendor());
    assert.deepEqual(view.offers.map((offer) => offer.title), ["iPhone 12 128 Go noir", "Machine à laver"]);
  });

  test("aucune annonce ni boost : états vides ; solde nul", () => {
    const view = vendorHomeView({ counts: { published: 0, paused: 0, draft: 0 }, needs: { kind: "below", bound: 5 }, balance: 0, activeBoosts: [], offers: [] });
    assert.equal(view.hasOffers, false);
    assert.equal(view.hasBoosts, false);
    assert.equal(view.needsText, "moins de 5 besoins d'acheteurs correspondent à vos annonces en ligne");
    assert.match(view.walletText, /^0 FCFA$/);
  });
});

describe("lecture stricte des accueils (api.home)", () => {
  test("requêtes GET sur les deux routes, sans paramètre", async () => {
    const buyer = harness(buyerDto());
    await buyer.client.home.buyer();
    assert.deepEqual(buyer.calls, ["/api/home/buyer"]);
    const vendor = harness(vendorDto());
    await vendor.client.home.vendor();
    assert.deepEqual(vendor.calls, ["/api/home/vendor"]);
  });

  test("réponses malformées : version de contrat, identifiant, compte non arrondi, lien, texte de contrôle, statut, champ manquant donnent `invalid_response`", async () => {
    const badBuyer: Array<[string, unknown]> = [
      ["version", buyerDto({ contractVersion: "home-buyer/v0" })],
      ["demandes absentes", buyerDto({ demands: undefined })],
      ["identifiant", buyerDto({ demands: [{ ...buyerDto().demands[0], id: "pas-un-uuid" }] })],
      ["matchCount négatif", buyerDto({ demands: [{ ...buyerDto().demands[0], matchCount: -1 }] })],
      ["titre de contrôle", buyerDto({ demands: [{ ...buyerDto().demands[0], title: "iPhone‮12" }] })],
      ["lien externe", buyerDto({ notifications: [{ ...buyerDto().notifications[0], link: "https://evil.example/x" }] })],
      ["type de notification", buyerDto({ notifications: [{ ...buyerDto().notifications[0], kind: "autre" }] })],
      ["budget invalide", buyerDto({ demands: [{ ...buyerDto().demands[0], budget: { amount: "x", currency: "XOF" } }] })],
    ];
    for (const [name, body] of badBuyer) {
      await assert.rejects(harness(body).client.home.buyer(), (error: unknown) => error instanceof ApiError && error.code === API_INVALID_RESPONSE, name);
    }
    const badVendor: Array<[string, unknown]> = [
      ["version", vendorDto({ contractVersion: "home-vendor/v0" })],
      ["compte exact (non arrondi)", vendorDto({ needs: { kind: "approx", value: 7 } })],
      ["compte nu", vendorDto({ needs: 12 })],
      ["compte d'annonce non arrondi", vendorDto({ offers: [{ ...vendorDto().offers[0], needs: { kind: "approx", value: 11 } }] })],
      ["statut", vendorDto({ offers: [{ ...vendorDto().offers[0], status: "archived" }] })],
      ["solde non entier", vendorDto({ balance: 1.5 })],
      ["boost sans date", vendorDto({ activeBoosts: [{ offerId: OFFER_ID, endsAt: "demain" }] })],
      ["titre manquant", vendorDto({ offers: [{ ...vendorDto().offers[0], title: "" }] })],
    ];
    for (const [name, body] of badVendor) {
      await assert.rejects(harness(body).client.home.vendor(), (error: unknown) => error instanceof ApiError && error.code === API_INVALID_RESPONSE, name);
    }
  });

  test("un champ que le serveur ajouterait un jour n'atteint jamais l'écran (liste blanche)", async () => {
    const withExtra = buyerDto();
    (withExtra.demands[0] as Record<string, unknown>).ownerId = "SECRET-OWNER";
    (withExtra as Record<string, unknown>).seller = { phone: "+2250700000202" };
    const home = await harness(withExtra).client.home.buyer();
    assert.equal(JSON.stringify(home).includes("SECRET-OWNER"), false);
    assert.equal(JSON.stringify(home).includes("+2250700000202"), false);
    const vendor = vendorDto();
    (vendor as Record<string, unknown>).buyers = [{ phone: "+2250700000101" }];
    assert.equal(JSON.stringify(await harness(vendor).client.home.vendor()).includes("+2250700000101"), false);
  });

  test("401 : ApiError 401 ; panne : message fixe, jamais le texte du serveur", async () => {
    await assert.rejects(harness({ error: { code: "authentication_required", message: "Authentification requise." } }, 401).client.home.buyer(), (error: unknown) => error instanceof ApiError && error.status === 401);
    const unavailable = await harness({ error: { code: "home_unavailable", message: "Le service est temporairement indisponible." } }, 503).client.home.vendor().catch((error: unknown) => error);
    assert.ok(unavailable instanceof ApiError);
    assert.equal(describeApiError(unavailable), "Le service est temporairement indisponible. Réessayez dans un instant.");
  });
});

describe("annonce refusée pour un numéro de téléphone : message clair, quel que soit l'écran", () => {
  test("400 phone_number_in_offer : le message de l'énoncé, dans tous les contextes ; un autre 400 garde son message générique", () => {
    const error = new ApiError(400, "phone_number_in_offer", "texte du serveur ignoré");
    for (const context of ["default", "catalog", "boost", "matches"] as const) {
      assert.equal(describeApiError(error, context), "Pas de numéro de téléphone dans l'annonce : l'acheteur vous contactera par noma.");
    }
    assert.equal(PHONE_IN_OFFER_MESSAGE, "Pas de numéro de téléphone dans l'annonce : l'acheteur vous contactera par noma.");
    assert.equal(describeApiError(new ApiError(400, "invalid_request", "x"), "catalog"), "Les informations saisies sont invalides. Vérifiez-les et réessayez.");
    assert.notEqual(describeApiError(new ApiError(409, "phone_number_in_offer", "x"), "catalog"), PHONE_IN_OFFER_MESSAGE, "seul un 400 porte ce code");
  });
});

export type { VendorHome };
