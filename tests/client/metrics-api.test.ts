import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  API_INVALID_ARGUMENT,
  API_INVALID_ID,
  API_INVALID_RESPONSE,
  ApiError,
  CONTACT_OFFER_GONE_MESSAGE,
  CONTACT_RATE_LIMITED_MESSAGE,
  OFFER_UNAVAILABLE_MESSAGE,
  createApiClient,
  describeApiError,
} from "../../lib/client/api";

// ─── Harnais ──────────────────────────────────────────────────────────────────────────────────────

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
const SELLER_ID = "11111111-1111-4111-8111-111111111111";
const PHONE = "+2250700000042";

function itemDto(overrides: Record<string, unknown> = {}) {
  return {
    candidateId: OFFER_ID,
    candidateContentVersion: 2,
    candidate: {
      id: OFFER_ID, contentVersion: 2, category: "Téléphones", brand: "Apple", model: "iPhone 12", variant: "128 Go", condition: "Occasion", quantity: null, unit: null,
      location: "Abidjan", deadlineAt: null, price: { amount: 150000, currency: "XOF" }, availabilityStatus: "available",
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
    sponsored: true,
    ...overrides,
  };
}

function detailDto(overrides: Record<string, unknown> = {}) {
  return {
    contractVersion: "demand-offer/v1",
    item: itemDto(),
    details: { createdAt: "2031-01-01T09:00:00.000Z", attributes: [{ key: "couleur", value: "noir" }, { key: "stockage", value: "128 Go" }] },
    readAt: "2031-01-01T10:00:05.000Z",
    ...overrides,
  };
}

/** Comptes arrondis tels que le serveur les envoie : `{ kind: "approx", value }` (multiple de 5, au moins 5), ou `{ kind: "below", bound: 5 }` pour `null`. */
const count = (value: number | null) => (value === null ? { kind: "below", bound: 5 } : { kind: "approx", value });
const percent = (value: number) => ({ kind: "percent", value });
const INSUFFICIENT = { kind: "insufficient" };

function periodDto(period: string, overrides: Record<string, unknown> = {}) {
  return {
    period,
    since: period === "all" ? null : "2031-01-01",
    exposure: { servings: count(40), sponsoredServings: count(10), buyersExposed: count(15), buyersSponsored: count(5) },
    opens: {
      total: count(10), uniqueBuyers: count(5),
      attributedToBoost: { opens: count(5), uniqueBuyers: count(null) },
      organic: { opens: count(null), uniqueBuyers: count(null) },
    },
    contacts: { uniqueBuyers: count(5), reveals: count(5), attributedToBoost: { uniqueBuyers: count(null) }, organic: { uniqueBuyers: count(null) } },
    ratios: { openRate: percent(70), contactRate: INSUFFICIENT },
    ...overrides,
  };
}

function boostDto(overrides: Record<string, unknown> = {}) {
  return {
    boostId: "33333333-3333-4333-8333-333333333333", durationCode: "3d", status: "effective", startsAt: "2031-01-01T00:00:00.000Z", endsAt: "2031-01-04T00:00:00.000Z",
    exposure: { servings: count(20), sponsoredServings: count(10), buyersExposed: count(10), buyersSponsored: count(10) },
    attributed: { opens: count(10), uniqueOpeners: count(5), uniqueContacts: count(null), reveals: count(null) },
    ratios: { openRate: percent(50), contactRate: INSUFFICIENT },
    ...overrides,
  };
}

function statsDto(overrides: Record<string, unknown> = {}) {
  return {
    contractVersion: "offer-stats/v1",
    activeMatches: { needs: count(10) },
    periods: [periodDto("7d"), periodDto("30d"), periodDto("all")],
    boosts: [boostDto()],
    ...overrides,
  };
}

const invalid = (error: unknown) => error instanceof ApiError && error.code === API_INVALID_RESPONSE;

// ─── Fiche d'une annonce ──────────────────────────────────────────────────────────────────────────

describe("couche cliente : fiche d'une annonce (demands.offer)", () => {
  test("GET /api/demands/{id}/offers/{offerId} : l'élément de correspondance, les attributs publics, la date ; « Sponsorisé » vient du serveur", async () => {
    const { client, calls } = harness(() => json(200, detailDto()));
    const detail = await client.demands.offer(DEMAND_ID, OFFER_ID);
    assert.equal(calls[0].url, `/api/demands/${DEMAND_ID}/offers/${OFFER_ID}`);
    assert.equal(calls[0].init.method, "GET");
    assert.equal(calls[0].init.body, undefined);
    assert.equal(calls[0].init.credentials, "same-origin");
    assert.equal(calls[0].init.cache, "no-store");
    assert.equal(detail.item.candidateId, OFFER_ID);
    assert.equal(detail.item.sponsored, true);
    assert.equal(detail.item.candidate.price?.amount, 150000);
    assert.deepEqual(detail.details.attributes, [{ key: "couleur", value: "noir" }, { key: "stockage", value: "128 Go" }]);
    assert.equal(detail.details.createdAt, "2031-01-01T09:00:00.000Z");
    const plain = harness(() => json(200, detailDto({ item: itemDto({ sponsored: false }) })));
    assert.equal((await plain.client.demands.offer(DEMAND_ID, OFFER_ID)).item.sponsored, false);
  });

  test("identifiants non UUID : ApiError invalid_id SANS requête", async () => {
    const { client, calls } = harness(() => json(200, detailDto()));
    for (const [demandId, offerId] of [["x", OFFER_ID], [DEMAND_ID, "x"], ["", OFFER_ID], [DEMAND_ID, `${OFFER_ID}/contact`], [`${DEMAND_ID}?a=1`, OFFER_ID]]) {
      await assert.rejects(client.demands.offer(demandId, offerId), (error: unknown) => error instanceof ApiError && error.code === API_INVALID_ID && error.status === 0, `${demandId}/${offerId}`);
    }
    assert.equal(calls.length, 0);
  });

  test("lecture en liste blanche : aucun identifiant de vendeur, téléphone, texte brut ni champ inconnu n'atteint l'écran", async () => {
    const { client } = harness(() => json(200, detailDto({
      ownerId: SELLER_ID, phone: PHONE, rawText: "RAW_SECRET",
      item: itemDto({ ownerId: SELLER_ID, rawText: "RAW_SECRET", candidate: { ...itemDto().candidate, ownerId: SELLER_ID, phone: PHONE } }),
      details: { createdAt: "2031-01-01T09:00:00.000Z", attributes: [], sellerId: SELLER_ID },
    })));
    const detail = await client.demands.offer(DEMAND_ID, OFFER_ID);
    const text = JSON.stringify(detail);
    for (const leaked of [SELLER_ID, PHONE, "RAW_SECRET", "ownerId", "sellerId", "\"phone\"", "rawText"]) assert.equal(text.includes(leaked), false, leaked);
  });

  test("réponse inattendue : invalid_response (version de contrat, détails, attribut mal formé, date illisible, élément invalide)", async () => {
    const bad = [
      detailDto({ contractVersion: "demand-offer/v2" }),
      detailDto({ details: null }),
      detailDto({ details: { createdAt: "pas une date", attributes: [] } }),
      detailDto({ details: { createdAt: "2031-01-01T09:00:00.000Z", attributes: "non" } }),
      detailDto({ details: { createdAt: "2031-01-01T09:00:00.000Z", attributes: [{ key: "mauvaise cle", value: "x" }] } }),
      detailDto({ details: { createdAt: "2031-01-01T09:00:00.000Z", attributes: [{ key: "ok", value: "" }] } }),
      detailDto({ details: { createdAt: "2031-01-01T09:00:00.000Z", attributes: [{ key: "ok", value: "x".repeat(81) }] } }),
      detailDto({ details: { createdAt: "2031-01-01T09:00:00.000Z", attributes: Array.from({ length: 13 }, (_, index) => ({ key: `k${index}`, value: "v" })) } }),
      detailDto({ item: null }),
      detailDto({ item: itemDto({ sponsored: "oui" }) }),
      detailDto({ readAt: 5 }),
    ];
    for (const body of bad) {
      const { client } = harness(() => json(200, body));
      await assert.rejects(client.demands.offer(DEMAND_ID, OFFER_ID), invalid, JSON.stringify(body).slice(0, 100));
    }
    const notJson = harness(() => new Response("pas du json", { status: 200 }));
    await assert.rejects(notJson.client.demands.offer(DEMAND_ID, OFFER_ID), invalid);
  });

  test("404 : une ApiError sans texte du serveur ; message fixe « n'est plus disponible pour votre besoin, ou elle n'existe pas »", async () => {
    const { client } = harness(() => json(404, { error: { code: "resource_not_found", message: "Ressource introuvable." } }));
    await assert.rejects(client.demands.offer(DEMAND_ID, OFFER_ID), (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, 404);
      assert.equal(describeApiError(error, "offer"), OFFER_UNAVAILABLE_MESSAGE);
      return true;
    });
  });
});

// ─── Contact ──────────────────────────────────────────────────────────────────────────────────────

function contactDto(overrides: Record<string, unknown> = {}) {
  return {
    contractVersion: "offer-contact/v1",
    contact: { phone: PHONE, telUrl: `tel:${PHONE}`, whatsappUrl: `https://wa.me/${PHONE.slice(1)}`, firstContact: true },
    ...overrides,
  };
}

describe("couche cliente : contact du vendeur (demands.contactOffer)", () => {
  test("POST /api/demands/{id}/offers/{offerId}/contact SANS corps ni type de contenu ; le numéro E.164 et les deux liens", async () => {
    const { client, calls } = harness(() => json(200, contactDto()));
    const contact = await client.demands.contactOffer(DEMAND_ID, OFFER_ID);
    assert.equal(calls[0].url, `/api/demands/${DEMAND_ID}/offers/${OFFER_ID}/contact`);
    assert.equal(calls[0].init.method, "POST");
    assert.equal(calls[0].init.body, undefined);
    assert.equal(calls[0].init.cache, "no-store", "jamais de cache côté client");
    assert.equal((calls[0].init.headers as Record<string, string>)["Content-Type"], undefined);
    assert.deepEqual(contact, { phone: PHONE, telUrl: `tel:${PHONE}`, whatsappUrl: "https://wa.me/2250700000042", firstContact: true });
  });

  test("identifiants non UUID : ApiError SANS requête", async () => {
    const { client, calls } = harness(() => json(200, contactDto()));
    await assert.rejects(client.demands.contactOffer("x", OFFER_ID), (error: unknown) => error instanceof ApiError && error.code === API_INVALID_ID);
    await assert.rejects(client.demands.contactOffer(DEMAND_ID, "../x"), (error: unknown) => error instanceof ApiError && error.code === API_INVALID_ID);
    assert.equal(calls.length, 0);
  });

  test("les liens sont EXACTEMENT ceux du numéro : un lien arbitraire, un schéma dangereux ou un numéro non E.164 sont refusés (invalid_response)", async () => {
    const bad = [
      contactDto({ contact: { phone: PHONE, telUrl: "tel:+2250799999999", whatsappUrl: `https://wa.me/${PHONE.slice(1)}`, firstContact: true } }),
      contactDto({ contact: { phone: PHONE, telUrl: `tel:${PHONE}`, whatsappUrl: "https://evil.example/2250700000042", firstContact: true } }),
      contactDto({ contact: { phone: PHONE, telUrl: `tel:${PHONE}`, whatsappUrl: `http://wa.me/${PHONE.slice(1)}`, firstContact: true } }),
      contactDto({ contact: { phone: PHONE, telUrl: "javascript:alert(1)", whatsappUrl: `https://wa.me/${PHONE.slice(1)}`, firstContact: true } }),
      contactDto({ contact: { phone: PHONE, telUrl: `tel:${PHONE}`, whatsappUrl: `https://wa.me/${PHONE.slice(1)}?text=x`, firstContact: true } }),
      contactDto({ contact: { phone: "0700000042", telUrl: "tel:0700000042", whatsappUrl: "https://wa.me/700000042", firstContact: true } }),
      contactDto({ contact: { phone: "+0123", telUrl: "tel:+0123", whatsappUrl: "https://wa.me/0123", firstContact: true } }),
      contactDto({ contact: { phone: PHONE, telUrl: `tel:${PHONE}`, whatsappUrl: `https://wa.me/${PHONE.slice(1)}`, firstContact: "oui" } }),
      contactDto({ contact: null }),
      contactDto({ contractVersion: "offer-contact/v2" }),
    ];
    for (const body of bad) {
      const { client } = harness(() => json(200, body));
      await assert.rejects(client.demands.contactOffer(DEMAND_ID, OFFER_ID), invalid, JSON.stringify(body));
    }
  });

  test("champs inconnus ignorés (liste blanche) : l'identifiant du vendeur n'atteint pas l'écran", async () => {
    const { client } = harness(() => json(200, contactDto({ sellerId: SELLER_ID, contact: { ...contactDto().contact, sellerId: SELLER_ID, name: "Jean" } })));
    const text = JSON.stringify(await client.demands.contactOffer(DEMAND_ID, OFFER_ID));
    assert.equal(text.includes(SELLER_ID), false);
    assert.equal(text.includes("Jean"), false);
  });

  test("messages fixes : 404 (accès refusé), 409 offer_not_available, 409 autre, 429 (20 vendeurs par jour), 503, 400 ; jamais le texte du serveur ni un code brut", async () => {
    const message = (status: number, code: string) => describeApiError(new ApiError(status, code, "texte du serveur ignoré"), "contact");
    assert.equal(message(404, "resource_not_found"), OFFER_UNAVAILABLE_MESSAGE);
    assert.equal(message(409, "offer_not_available"), CONTACT_OFFER_GONE_MESSAGE);
    assert.match(CONTACT_OFFER_GONE_MESSAGE, /Aucun contact n'a été enregistré/);
    assert.equal(message(409, "contact_unavailable"), "Le contact de ce vendeur n'est pas disponible pour le moment.");
    assert.equal(message(429, "rate_limited"), CONTACT_RATE_LIMITED_MESSAGE);
    assert.match(CONTACT_RATE_LIMITED_MESSAGE, /20 vendeurs aujourd'hui/);
    assert.equal(message(503, "metrics_unavailable"), "Le contact est temporairement indisponible. Réessayez dans un instant.");
    assert.match(message(400, "invalid_request"), /demande de contact n'est pas valide/);
    for (const code of ["resource_not_found", "offer_not_available", "rate_limited", "metrics_unavailable"]) {
      for (const status of [404, 409, 429, 503]) assert.equal(message(status, code).includes(code), false);
    }
    assert.equal(describeApiError(new Error("x"), "contact"), "Une erreur est survenue. Réessayez dans un instant.");
  });
});

// ─── Statistiques ─────────────────────────────────────────────────────────────────────────────────

describe("couche cliente : statistiques de l'annonce (offers.stats)", () => {
  test("GET /api/offers/{id}/stats : besoins correspondants arrondis, trois périodes dans l'ordre, taux, boosts ; plus de seuil k", async () => {
    const { client, calls } = harness(() => json(200, statsDto()));
    const stats = await client.offers.stats(OFFER_ID);
    assert.equal(calls[0].url, `/api/offers/${OFFER_ID}/stats`);
    assert.equal(calls[0].init.method, "GET");
    assert.equal("privacyThreshold" in stats, false);
    assert.deepEqual(stats.activeMatches, { needs: { kind: "approx", value: 10 } });
    assert.deepEqual(stats.periods.map((period) => period.period), ["7d", "30d", "all"]);
    assert.deepEqual(stats.periods[0].opens.uniqueBuyers, { kind: "approx", value: 5 });
    assert.deepEqual(stats.periods[0].opens.organic?.uniqueBuyers, { kind: "below", bound: 5 });
    assert.deepEqual(stats.periods[0].ratios, { openRate: { kind: "percent", value: 70 }, contactRate: { kind: "insufficient" } });
    assert.equal(stats.periods[2].since, null);
    assert.equal(stats.boosts.length, 1);
    assert.deepEqual(stats.boosts[0].ratios, { openRate: { kind: "percent", value: 50 }, contactRate: { kind: "insufficient" } });
  });

  test("identifiant non UUID : ApiError SANS requête", async () => {
    const { client, calls } = harness(() => json(200, statsDto()));
    await assert.rejects(client.offers.stats("x"), (error: unknown) => error instanceof ApiError && error.code === API_INVALID_ID);
    assert.equal(calls.length, 0);
  });

  test("un compte n'est JAMAIS exact : { kind: \"below\", bound: 5 } ou { kind: \"approx\", value } (multiple de 5, au moins 5) ; un nombre nu, l'ancienne forme, une valeur qui n'est pas un multiple de 5, une borne autre que 5 ou un champ de plus sont refusés", async () => {
    const withOpen = (uniqueBuyers: unknown) => statsDto({ periods: [periodDto("7d", { opens: { ...periodDto("7d").opens, uniqueBuyers } }), periodDto("30d"), periodDto("all")] });
    for (const good of [{ kind: "below", bound: 5 }, { kind: "approx", value: 5 }, { kind: "approx", value: 15 }, { kind: "approx", value: 1_000 }]) {
      const accepted = harness(() => json(200, withOpen(good)));
      assert.deepEqual((await accepted.client.offers.stats(OFFER_ID)).periods[0].opens.uniqueBuyers, good);
    }
    for (const bad of [2, "2", 12, { value: 2, belowThreshold: true }, { value: null, belowThreshold: true }, { value: 12, belowThreshold: false }, { kind: "approx", value: 12 }, { kind: "approx", value: 3 },
      { kind: "approx", value: 0 }, { kind: "approx", value: -5 }, { kind: "approx", value: 7.5 }, { kind: "approx", value: "10" }, { kind: "below", bound: 3 }, { kind: "below", bound: 10 },
      { kind: "below", bound: 5, value: 2 }, { kind: "approx", value: 10, exact: 12 }, { kind: "exact", value: 12 }, { kind: "approx" }, { kind: "below" }, { value: 10 }, null, []]) {
      const { client } = harness(() => json(200, withOpen(bad)));
      await assert.rejects(client.offers.stats(OFFER_ID), invalid, JSON.stringify(bad));
    }
  });

  test("besoins correspondants : « moins de 5 » = { kind: \"below\", bound: 5 } ; un nombre nu est refusé", async () => {
    const masked = harness(() => json(200, statsDto({ activeMatches: { needs: count(null) } })));
    assert.deepEqual((await masked.client.offers.stats(OFFER_ID)).activeMatches, { needs: { kind: "below", bound: 5 } });
  });

  test("taux (par période et par boost) : { kind: \"percent\", value } (multiple de 10, de 0 à 100) ou { kind: \"insufficient\" } ; le reste est refusé", async () => {
    const withRatio = (openRate: unknown) => statsDto({ boosts: [boostDto({ ratios: { openRate, contactRate: INSUFFICIENT } })] });
    for (const good of [percent(0), percent(50), percent(70), percent(100), INSUFFICIENT]) {
      const { client } = harness(() => json(200, withRatio(good)));
      assert.deepEqual((await client.offers.stats(OFFER_ID)).boosts[0].ratios.openRate, good);
    }
    for (const bad of [percent(65), percent(110), percent(-10), percent(33.3), { kind: "percent", value: "70" }, { kind: "percent" }, { kind: "insufficient", value: 70 }, { kind: "percent", value: 70, numerator: 3 },
      { numerator: count(5), denominator: count(10), value: 0.5, reason: null }, { value: 0.5 }, 0.5, "70 %", []]) {
      const { client } = harness(() => json(200, withRatio(bad)));
      await assert.rejects(client.offers.stats(OFFER_ID), invalid, JSON.stringify(bad));
    }
    // Les deux taux d'une période : l'un est optionnel (aucun boost n'a pu servir), l'autre ne l'est jamais.
    const noOpenRate = harness(() => json(200, statsDto({ periods: [periodDto("7d", { ratios: { openRate: null, contactRate: percent(70) } }), periodDto("30d"), periodDto("all")] })));
    assert.deepEqual((await noOpenRate.client.offers.stats(OFFER_ID)).periods[0].ratios, { openRate: null, contactRate: { kind: "percent", value: 70 } });
    for (const ratios of [{ openRate: null, contactRate: null }, { openRate: percent(70) }, undefined, null, { openRate: percent(75), contactRate: INSUFFICIENT }]) {
      const broken = harness(() => json(200, statsDto({ periods: [periodDto("7d", { ratios }), periodDto("30d"), periodDto("all")] })));
      await assert.rejects(broken.client.offers.stats(OFFER_ID), invalid, JSON.stringify(ratios));
    }
    // Un boost qui n'a pas commencé : aucune exposition, aucune part attribuée, aucun taux (null) — accepté tel quel.
    const notStarted = harness(() => json(200, statsDto({ boosts: [boostDto({ status: "scheduled", exposure: null, attributed: null, ratios: { openRate: null, contactRate: null } })] })));
    const parsed = (await notStarted.client.offers.stats(OFFER_ID)).boosts[0];
    assert.deepEqual([parsed.exposure, parsed.attributed, parsed.ratios.openRate, parsed.ratios.contactRate], [null, null, null, null]);
  });

  test("annonce sans boost : exposition, parts attribuée et organique et taux d'ouverture valent null (aucun boost) ; une seule des deux parts est refusée", async () => {
    const without = periodDto("7d", {
      exposure: null,
      opens: { total: count(10), uniqueBuyers: count(5), attributedToBoost: null, organic: null },
      contacts: { uniqueBuyers: count(5), reveals: count(5), attributedToBoost: null, organic: null },
      ratios: { openRate: null, contactRate: INSUFFICIENT },
    });
    const { client } = harness(() => json(200, statsDto({ periods: [without, { ...without, period: "30d" }, { ...without, period: "all", since: null }], boosts: [] })));
    const stats = await client.offers.stats(OFFER_ID);
    assert.deepEqual(stats.boosts, []);
    assert.equal(stats.periods[0].exposure, null);
    assert.equal(stats.periods[0].opens.attributedToBoost, null);
    assert.equal(stats.periods[0].opens.organic, null);
    assert.equal(stats.periods[0].contacts.attributedToBoost, null);
    assert.equal(stats.periods[0].contacts.organic, null);
    assert.equal(stats.periods[0].ratios.openRate, null);
    for (const half of [
      { opens: { ...without.opens, organic: { opens: count(null), uniqueBuyers: count(null) } }, contacts: without.contacts },
      { opens: without.opens, contacts: { ...without.contacts, attributedToBoost: { uniqueBuyers: count(null) } } },
    ]) {
      const broken = harness(() => json(200, statsDto({ periods: [periodDto("7d", { exposure: null, ...half }), periodDto("30d"), periodDto("all")] })));
      await assert.rejects(broken.client.offers.stats(OFFER_ID), invalid, JSON.stringify(half).slice(0, 100));
    }
  });

  test("réponse inattendue : version de contrat, périodes (ordre, nombre, code), boost mal formé → invalid_response", async () => {
    const bad = [
      statsDto({ contractVersion: "offer-stats/v2" }),
      statsDto({ activeMatches: { needs: -1 } }),
      statsDto({ activeMatches: { needs: 8 } }),
      statsDto({ activeMatches: { needs: { value: 2, belowThreshold: true } } }),
      statsDto({ activeMatches: { needs: { kind: "approx", value: 8 } } }),
      statsDto({ activeMatches: null }),
      statsDto({ periods: [periodDto("30d"), periodDto("7d"), periodDto("all")] }),
      statsDto({ periods: [periodDto("7d"), periodDto("30d")] }),
      statsDto({ periods: [periodDto("7d"), periodDto("30d"), periodDto("1y")] }),
      statsDto({ periods: [periodDto("7d", { since: "hier" }), periodDto("30d"), periodDto("all")] }),
      statsDto({ boosts: "non" }),
      statsDto({ boosts: [boostDto({ boostId: "pas-un-uuid" })] }),
      statsDto({ boosts: [boostDto({ durationCode: "30d" })] }),
      statsDto({ boosts: [boostDto({ status: "perdu" })] }),
      statsDto({ boosts: [boostDto({ startsAt: "n'importe quoi" })] }),
      statsDto({ boosts: [boostDto({ exposure: { ...boostDto().exposure, servings: 5 } })] }),
      statsDto({ boosts: [boostDto({ attributed: { ...boostDto().attributed, opens: undefined } })] }),
    ];
    for (const body of bad) {
      const { client } = harness(() => json(200, body));
      await assert.rejects(client.offers.stats(OFFER_ID), invalid, JSON.stringify(body).slice(0, 120));
    }
  });

  test("aucune identité ni identifiant interne n'atteint l'écran (champs inconnus ignorés) ; `privacyThreshold` n'existe plus", async () => {
    const { client } = harness(() => json(200, statsDto({
      privacyThreshold: 3,
      periods: [periodDto("7d", { viewers: [DEMAND_ID], demandId: DEMAND_ID }), periodDto("30d"), periodDto("all")],
      buyers: [{ id: DEMAND_ID, phone: PHONE }],
    })));
    const text = JSON.stringify(await client.offers.stats(OFFER_ID));
    for (const leaked of [DEMAND_ID, PHONE, "\"viewers\"", "\"demandId\"", "\"buyers\"", "\"phone\"", "privacyThreshold"]) assert.equal(text.includes(leaked), false, leaked);
  });

  test("messages fixes : 404 et 503 du contexte « stats »", () => {
    assert.equal(describeApiError(new ApiError(404, "resource_not_found", "x"), "stats"), "Annonce introuvable : elle n'existe pas ou n'est pas à vous.");
    assert.equal(describeApiError(new ApiError(503, "metrics_unavailable", "x"), "stats"), "Les statistiques sont temporairement indisponibles. Réessayez dans un instant.");
    assert.equal(describeApiError(new ApiError(0, API_INVALID_ARGUMENT, "x"), "stats"), "Paramètre invalide. Rechargez la page.");
  });
});
