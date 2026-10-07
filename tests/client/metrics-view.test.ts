import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { BoostStatsEntry, OfferDetail, OfferStats, PeriodStats, StatCount, StatRatio, StoredMatch } from "../../lib/client/api";
import {
  ATTRIBUTION_SENTENCE,
  BOOST_NOT_STARTED_SENTENCE,
  CONTACT_BUTTON_LABEL,
  CONTACT_NOTICE,
  EXPOSURE_SENTENCE,
  FEW_STATS_YET,
  NO_BOOST_SENTENCE,
  OPEN_SENTENCE,
  PRIVACY_SENTENCE,
  PERIOD_LABELS,
  RATIO_INSUFFICIENT_TEXT,
  activeMatchesText,
  attributeLabel,
  boostStatsView,
  buyersText,
  contactLinks,
  countText,
  eventsText,
  formatContactPhone,
  frenchDate,
  offerDetailPath,
  offerDetailView,
  offerStatsView,
  periodView,
  ratioText,
} from "../../lib/client/metrics-view";

const about = (value: number): StatCount => ({ kind: "approx", value });
const BELOW: StatCount = { kind: "below", bound: 5 };
const percent = (value: number): StatRatio => ({ kind: "percent", value });
const INSUFFICIENT: StatRatio = { kind: "insufficient" };

describe("comptes arrondis : « moins de 5 », « environ 15 », jamais le nombre exact", () => {
  test("countText et buyersText", () => {
    assert.equal(countText(about(5)), "environ 5");
    assert.equal(countText(about(15)), "environ 15");
    assert.equal(countText(BELOW), "moins de 5");
    assert.equal(buyersText(about(5)), "environ 5 acheteurs");
    assert.equal(buyersText(about(100)), "environ 100 acheteurs");
    assert.equal(buyersText(BELOW), "moins de 5 acheteurs");
  });

  test("eventsText : ouvertures, apparitions", () => {
    assert.equal(eventsText(about(10), "ouvertures"), "environ 10 ouvertures");
    assert.equal(eventsText(BELOW, "ouvertures"), "moins de 5 ouvertures");
    assert.equal(eventsText(BELOW, "apparitions"), "moins de 5 apparitions");
  });

  test("ratioText : « environ 70 % » ; non publié : « pas assez d'acheteurs pour un pourcentage », jamais un faux 0 %", () => {
    assert.equal(ratioText(percent(70)), "environ 70 %");
    assert.equal(ratioText(percent(0)), "environ 0 %", "un pourcentage déjà publié reste affiché tel quel");
    assert.equal(ratioText(percent(100)), "environ 100 %");
    assert.equal(ratioText(INSUFFICIENT), "pas assez d'acheteurs pour un pourcentage");
    assert.equal(RATIO_INSUFFICIENT_TEXT, "pas assez d'acheteurs pour un pourcentage");
  });

  test("plus aucun « moins de 3 » nulle part dans les textes de la vue", () => {
    const sentences = [ATTRIBUTION_SENTENCE, EXPOSURE_SENTENCE, OPEN_SENTENCE, PRIVACY_SENTENCE, FEW_STATS_YET, NO_BOOST_SENTENCE, BOOST_NOT_STARTED_SENTENCE, RATIO_INSUFFICIENT_TEXT, countText(BELOW), activeMatchesText(BELOW)];
    for (const text of sentences) assert.equal(/moins de 3|inférieur à 3/i.test(text), false, text);
  });
});

function period(overrides: Partial<PeriodStats> = {}): PeriodStats {
  return {
    period: "7d",
    since: "2031-01-01",
    exposure: { servings: about(40), sponsoredServings: about(10), buyersExposed: about(15), buyersSponsored: about(5) },
    opens: { total: about(10), uniqueBuyers: about(5), attributedToBoost: { opens: about(5), uniqueBuyers: BELOW }, organic: { opens: BELOW, uniqueBuyers: BELOW } },
    contacts: { uniqueBuyers: about(5), reveals: about(5), attributedToBoost: { uniqueBuyers: BELOW }, organic: { uniqueBuyers: BELOW } },
    ratios: { openRate: percent(70), contactRate: INSUFFICIENT },
    ...overrides,
  };
}

/** Une période d'annonce SANS boost : ni exposition, ni part attribuée ou organique, ni taux d'ouverture (le serveur envoie null). */
function periodWithoutBoost(overrides: Partial<PeriodStats> = {}): PeriodStats {
  return {
    period: "7d",
    since: "2031-01-01",
    exposure: null,
    opens: { total: about(10), uniqueBuyers: about(5), attributedToBoost: null, organic: null },
    contacts: { uniqueBuyers: about(5), reveals: about(5), attributedToBoost: null, organic: null },
    ratios: { openRate: null, contactRate: INSUFFICIENT },
    ...overrides,
  };
}

function boost(overrides: Partial<BoostStatsEntry> = {}): BoostStatsEntry {
  return {
    boostId: "33333333-3333-4333-8333-333333333333", durationCode: "3d", status: "effective", startsAt: "2031-01-01T00:00:00.000Z", endsAt: "2031-01-04T00:00:00.000Z",
    exposure: { servings: about(20), sponsoredServings: about(10), buyersExposed: about(10), buyersSponsored: about(10) },
    attributed: { opens: about(10), uniqueOpeners: about(5), uniqueContacts: BELOW, reveals: BELOW },
    ratios: { openRate: percent(50), contactRate: INSUFFICIENT },
    ...overrides,
  };
}

describe("« Ce que produit votre annonce » (vendeur)", () => {
  test("périodes : titres en clair, lignes en mots simples, attribution au boost, part organique et taux (« environ 70 % »)", () => {
    assert.deepEqual(PERIOD_LABELS, { "7d": "7 derniers jours", "30d": "30 derniers jours", all: "Depuis la publication" });
    const view = periodView(period());
    assert.equal(view.title, "7 derniers jours");
    const byKey = Object.fromEntries(view.lines.map((line) => [line.key, line.value]));
    assert.equal(byKey.served, "environ 40 apparitions");
    assert.equal(byKey.exposed, "environ 15 acheteurs");
    assert.equal(byKey.opens, "environ 10 ouvertures");
    assert.equal(byKey.openers, "environ 5 acheteurs");
    assert.equal(byKey["openers-boost"], "moins de 5 acheteurs");
    assert.equal(byKey["openers-organic"], "moins de 5 acheteurs");
    assert.equal(byKey.contacts, "environ 5 acheteurs");
    assert.equal(byKey["contacts-boost"], "moins de 5 acheteurs");
    assert.equal(byKey["contacts-organic"], "moins de 5 acheteurs");
    assert.equal(byKey["open-rate"], "environ 70 %");
    assert.equal(byKey["contact-rate"], "pas assez d'acheteurs pour un pourcentage");
    assert.deepEqual(view.lines.map((line) => line.key), ["served", "exposed", "opens", "openers", "openers-boost", "openers-organic", "contacts", "contacts-boost", "contacts-organic", "open-rate", "contact-rate"]);
    const hints = Object.fromEntries(view.lines.map((line) => [line.key, line.hint]));
    assert.match(hints["open-rate"] ?? "", /acheteurs qui ont ouvert parmi les acheteurs servis \/ acheteurs servis/);
    assert.match(hints["contact-rate"] ?? "", /acheteurs qui ont contacté parmi ceux qui ont ouvert \/ acheteurs qui ont ouvert/);
  });

  test("annonce SANS boost : aucune ligne « pendant un boost » ni « attribué au boost » ni taux d'ouverture ; les ouvertures et les contacts sont tous organiques ; le taux de contact des ouvreurs reste", () => {
    const view = periodView(periodWithoutBoost());
    assert.deepEqual(view.lines.map((line) => line.key), ["opens", "openers", "contacts", "contact-rate"]);
    const text = JSON.stringify(view.lines.filter((line) => line.key !== "contact-rate"));
    assert.equal(/pendant un boost|sponsoris|attribu|organique/.test(text), false, text);
    // Une période où aucun boost ne peut avoir servi (boost ancien) : pas de lignes d'exposition ; la part attribuée et le taux d'ouverture suivent leurs champs.
    assert.deepEqual(periodView(period({ exposure: null, ratios: { openRate: null, contactRate: INSUFFICIENT } })).lines.map((line) => line.key), ["opens", "openers", "openers-boost", "openers-organic", "contacts", "contacts-boost", "contacts-organic", "contact-rate"]);
  });

  test("tout est « moins de 5 » : aucun pourcentage, aucun nombre exact, « pas assez d'acheteurs pour un pourcentage »", () => {
    const small = period({
      exposure: { servings: BELOW, sponsoredServings: BELOW, buyersExposed: BELOW, buyersSponsored: BELOW },
      opens: { total: BELOW, uniqueBuyers: BELOW, attributedToBoost: { opens: BELOW, uniqueBuyers: BELOW }, organic: { opens: BELOW, uniqueBuyers: BELOW } },
      contacts: { uniqueBuyers: BELOW, reveals: BELOW, attributedToBoost: { uniqueBuyers: BELOW }, organic: { uniqueBuyers: BELOW } },
      ratios: { openRate: INSUFFICIENT, contactRate: INSUFFICIENT },
    });
    const text = JSON.stringify(periodView(small).lines.map((line) => line.value));
    assert.equal(text.includes("%"), false, "aucun pourcentage");
    assert.equal(/[0-9]/.test(text.replaceAll("moins de 5", "")), false, `aucun nombre exact : ${text}`);
    assert.match(text, /moins de 5 acheteurs/);
    assert.match(text, /moins de 5 ouvertures/);
    assert.match(text, /moins de 5 apparitions/);
    assert.match(text, /pas assez d'acheteurs pour un pourcentage/);
  });

  test("par boost : durée, état, comptes attribués et taux", () => {
    const view = boostStatsView(boost(), "3 jours");
    assert.equal(view.title, "Boost de 3 jours · en cours");
    const byKey = Object.fromEntries(view.lines.map((line) => [line.key, line.value]));
    assert.equal(byKey.exposed, "environ 10 acheteurs");
    assert.equal(byKey.sponsored, "environ 10 acheteurs");
    assert.equal(byKey.opens, "environ 5 acheteurs");
    assert.equal(byKey.contacts, "moins de 5 acheteurs");
    assert.equal(byKey["open-rate"], "environ 50 %");
    assert.equal(byKey["contact-rate"], "pas assez d'acheteurs pour un pourcentage");
    const hints = Object.fromEntries(view.lines.map((line) => [line.key, line.hint]));
    assert.match(hints["open-rate"] ?? "", /acheteurs qui ont ouvert \(attribué à ce boost\) \/ acheteurs servis sponsorisés/);
    assert.match(hints["contact-rate"] ?? "", /acheteurs qui ont contacté \(attribué à ce boost\) \/ acheteurs servis sponsorisés/);
    for (const [status, label] of [["expired", "terminé"], ["cancelled", "annulé"], ["scheduled", "programmé"], ["effective", "en cours"]] as const) {
      assert.match(boostStatsView(boost({ status }), "24 h").title, new RegExp(`· ${label}$`));
    }
  });

  test("un boost qui n'a pas commencé : aucune ligne, une phrase (rien d'attribuable ni de servi)", () => {
    const view = boostStatsView(boost({ status: "scheduled", exposure: null, attributed: null, ratios: { openRate: null, contactRate: null } }), "7 jours");
    assert.deepEqual(view.lines, []);
    assert.equal(view.note, BOOST_NOT_STARTED_SENTENCE);
    assert.match(view.title, /^Boost de 7 jours · programmé$/);
    assert.equal(boostStatsView(boost(), "3 jours").note, null);
  });

  test("0, 1 et 2 boosts : sans boost une phrase « tout est organique » et ni explication d'attribution ni d'exposition ; avec un ou deux boosts, la phrase disparaît et les explications reviennent", () => {
    const noBoost = offerStatsView({ activeMatches: { needs: about(10) }, periods: [periodWithoutBoost({ period: "7d" }), periodWithoutBoost({ period: "30d" }), periodWithoutBoost({ period: "all", since: null })], boosts: [] });
    assert.equal(noBoost.noBoost, true);
    assert.equal(noBoost.noBoostText, NO_BOOST_SENTENCE);
    assert.equal(NO_BOOST_SENTENCE, "Aucun boost sur cette annonce : tout est organique.");
    assert.deepEqual(noBoost.notes, [OPEN_SENTENCE, PRIVACY_SENTENCE], "ni attribution ni exposition à expliquer sans boost");
    assert.equal(noBoost.notes.some((note) => /boost|sponsoris/i.test(note) && note !== PRIVACY_SENTENCE), false);
    for (const entry of noBoost.periods) assert.deepEqual(entry.lines.map((line) => line.key), ["opens", "openers", "contacts", "contact-rate"]);
    for (const count of [1, 2]) {
      const boosts = Array.from({ length: count }, (_, index) => boost({ boostId: `3333333${index}-3333-4333-8333-333333333333` }));
      const view = offerStatsView({ activeMatches: { needs: about(10) }, periods: [period({ period: "7d" }), period({ period: "30d" }), period({ period: "all", since: null })], boosts });
      assert.equal(view.noBoost, false, `${count} boost`);
      assert.equal(view.noBoostText, null);
      assert.deepEqual(view.notes, [ATTRIBUTION_SENTENCE, EXPOSURE_SENTENCE, OPEN_SENTENCE, PRIVACY_SENTENCE]);
      assert.equal(boosts.map((entry) => boostStatsView(entry, "3 jours")).every((entry) => entry.lines.length === 7), true, "chaque boost a ses sept lignes");
    }
  });

  test("vue d'ensemble : besoins correspondants (des besoins, pas des acheteurs), trois périodes, phrases d'explication, « peu d'activité » quand tout est « moins de 5 »", () => {
    const stats: OfferStats = { activeMatches: { needs: about(10) }, periods: [period({ period: "7d" }), period({ period: "30d" }), period({ period: "all", since: null })], boosts: [boost()] };
    const view = offerStatsView(stats);
    assert.equal(view.matchingNeedsText, "Environ 10 besoins d'acheteurs correspondent à votre annonce.");
    assert.deepEqual(view.periods.map((entry) => entry.period), ["7d", "30d", "all"]);
    assert.equal(view.fewActivity, false);
    // Les phrases d'attribution, de mesure, d'ouverture et de confidentialité sont TOUJOURS là.
    assert.ok(view.notes.includes(ATTRIBUTION_SENTENCE));
    assert.match(ATTRIBUTION_SENTENCE, /attribués au boost seulement si l'acheteur avait vu votre annonce sponsorisée dans les 7 jours/);
    assert.ok(view.notes.some((note) => /ne sont comptées que pendant un boost/.test(note)));
    assert.ok(view.notes.some((note) => /ce n'est pas la preuve qu'il l'a lue\. Aucune vente n'est mesurée/.test(note)));
    assert.ok(view.notes.includes(PRIVACY_SENTENCE));
    assert.equal(PRIVACY_SENTENCE, "Pour protéger les acheteurs, les chiffres sont arrondis à 5 près et les petits nombres ne sont pas détaillés.");
    const masked = period({
      exposure: { servings: BELOW, sponsoredServings: BELOW, buyersExposed: BELOW, buyersSponsored: BELOW },
      opens: { total: BELOW, uniqueBuyers: BELOW, attributedToBoost: { opens: BELOW, uniqueBuyers: BELOW }, organic: { opens: BELOW, uniqueBuyers: BELOW } },
      contacts: { uniqueBuyers: BELOW, reveals: BELOW, attributedToBoost: { uniqueBuyers: BELOW }, organic: { uniqueBuyers: BELOW } },
      ratios: { openRate: INSUFFICIENT, contactRate: INSUFFICIENT },
    });
    const few = offerStatsView({ activeMatches: { needs: BELOW }, periods: [{ ...masked, period: "7d" }, { ...masked, period: "30d" }, { ...masked, period: "all", since: null }], boosts: [] });
    assert.equal(few.fewActivity, true);
    assert.equal(few.matchingNeedsText, "Moins de 5 besoins d'acheteurs correspondent à votre annonce.");
    assert.match(FEW_STATS_YET, /Encore peu d'activité/);
    assert.equal(/[0-9]/.test(JSON.stringify(few.periods.map((entry) => entry.lines.map((line) => line.value))).replaceAll("moins de 5", "")), false, "aucun nombre à l'écran, zéro compris, hors « moins de 5 »");
    // Un total publié : jamais présenté comme « peu d'activité ».
    assert.equal(offerStatsView({ ...stats, periods: [period({ period: "7d", opens: { ...period().opens, total: BELOW } }), period({ period: "30d" }), { ...period({ period: "all" }), opens: { ...period().opens, total: BELOW } }] }).fewActivity, false);
  });

  test("besoins correspondants : « environ 10 » (5 et plus) ou « moins de 5 » (de 0 à 4) ; jamais « 1 besoin » ni « aucun besoin »", () => {
    assert.equal(activeMatchesText(about(5)), "Environ 5 besoins d'acheteurs correspondent à votre annonce.");
    assert.equal(activeMatchesText(about(120)), "Environ 120 besoins d'acheteurs correspondent à votre annonce.");
    assert.equal(activeMatchesText(BELOW), "Moins de 5 besoins d'acheteurs correspondent à votre annonce.");
    assert.equal(/Aucun besoin|\b[01] besoin/.test(activeMatchesText(BELOW)), false);
  });
});

function detail(overrides: Partial<OfferDetail> = {}, item: Partial<StoredMatch> = {}): OfferDetail {
  return {
    item: {
      candidateId: "6f1d4f5c-9d2e-4d8e-8f56-0a8b9f0a1b2c",
      candidate: {
        category: "Téléphones", brand: "Apple", model: "iPhone 12", variant: "128 Go", condition: "Occasion", quantity: null, unit: null, location: "Abidjan", deadlineAt: null,
        price: { amount: 150000, currency: "XOF" }, budget: null, availabilityStatus: "available",
      },
      compatibilityStatus: "compatible", score: 87.4, coverage: 1, evaluatedAt: "2031-01-01T10:00:00.000Z",
      indicators: {
        availability: { level: "confirmed_recent", score: 100, confirmedAgeHours: 3, factors: [] },
        price: { position: "below_market", score: 100, deltaPercent: -12, sampleSize: 8, factors: [] },
        confidence: { level: "high", score: 91, accountAgeBand: "gte_30d", factors: ["phone_verified"] },
      },
      relevance: 88.5, sponsored: false, ...item,
    },
    details: { createdAt: "2031-10-12T09:00:00.000Z", attributes: [{ key: "etat_batterie", value: "89 %" }, { key: "couleur", value: "noir" }] },
    readAt: "2031-10-12T10:00:00.000Z",
    ...overrides,
  };
}

describe("fiche d'une annonce (acheteur)", () => {
  test("titre, prix, état, localisation, compatibilité, indicateurs en clair, date, attributs publics", () => {
    const view = offerDetailView(detail());
    assert.equal(view.title, "Apple iPhone 12 128 Go");
    assert.equal(view.subtitle, "Occasion · Abidjan");
    assert.match(view.priceText, /^150\s000 FCFA$/);
    assert.equal(view.compatibility, "Compatibilité 87 %");
    assert.equal(view.compatibilityPercent, 87);
    assert.deepEqual(view.indicators.map((indicator) => indicator.key), ["price", "availability", "confidence"]);
    assert.equal(view.dateText, "Annonce du 12 octobre 2031");
    assert.deepEqual(view.attributes, [{ label: "Etat batterie", value: "89 %" }, { label: "Couleur", value: "noir" }]);
    assert.equal(view.sponsored, false);
    assert.equal(view.sponsoredBadge, null);
    assert.equal(view.sponsoredNotice, null);
  });

  test("« Sponsorisé » SEULEMENT si le serveur le dit, avec la précision « parmi des résultats déjà pertinents »", () => {
    const sponsored = offerDetailView(detail({}, { sponsored: true }));
    assert.equal(sponsored.sponsoredBadge, "Sponsorisé");
    assert.match(sponsored.sponsoredNotice ?? "", /parmi des résultats déjà pertinents/);
    for (const flag of [false, undefined as unknown as boolean]) assert.equal(offerDetailView(detail({}, { sponsored: flag })).sponsoredBadge, null);
  });

  test("valeurs absentes : prix « non renseigné », compatibilité « à confirmer », pas de date illisible, pas de sous-titre vide", () => {
    const bare = offerDetailView(detail({ details: { createdAt: "pas une date", attributes: [] } }, {
      score: null, candidate: { category: null, brand: null, model: null, variant: null, condition: null, quantity: null, unit: null, location: null, deadlineAt: null, price: null, budget: null, availabilityStatus: null },
    }));
    assert.equal(bare.title, "Annonce");
    assert.equal(bare.priceText, "Prix non renseigné");
    assert.equal(bare.compatibility, "Compatibilité à confirmer");
    assert.equal(bare.compatibilityPercent, null);
    assert.equal(bare.subtitle, null);
    assert.equal(bare.dateText, null);
    assert.deepEqual(bare.attributes, []);
  });

  test("jamais d'identifiant ni de téléphone dans ce que la vue construit", () => {
    const text = JSON.stringify(offerDetailView(detail()));
    for (const leaked of ["6f1d4f5c", "ownerId", "sellerId", "+225", "tel:", "wa.me"]) assert.equal(text.includes(leaked), false, leaked);
  });

  test("date en UTC, sans le fuseau de l'appareil ; libellés d'attributs", () => {
    assert.equal(frenchDate("2031-01-01T23:59:59.000Z"), "1 janvier 2031");
    assert.equal(frenchDate("2031-12-31T00:00:00.000Z"), "31 décembre 2031");
    assert.equal(frenchDate("n'importe quoi"), null);
    assert.equal(attributeLabel("etat_batterie"), "Etat batterie");
    assert.equal(attributeLabel("couleur"), "Couleur");
  });

  test("lien vers la fiche : deux UUID exigés, sinon aucun lien", () => {
    const demandId = "22222222-2222-4222-8222-222222222222";
    const offerId = "6f1d4f5c-9d2e-4d8e-8f56-0a8b9f0a1b2c";
    assert.equal(offerDetailPath(demandId, offerId), `/besoins/${demandId}/offres/${offerId}`);
    for (const [a, b] of [["x", offerId], [demandId, "../x"], ["", ""], [demandId, `${offerId}/contact`], [`${demandId}?a=1`, offerId]]) assert.equal(offerDetailPath(a, b), null, `${a}/${b}`);
  });
});

describe("contact (acheteur)", () => {
  test("numéro lisible pour la Côte d'Ivoire, E.164 tel quel sinon ; liens reconstruits depuis le numéro", () => {
    assert.equal(formatContactPhone("+2250700000042"), "+225 07 00 00 00 42");
    assert.equal(formatContactPhone("+33612345678"), "+33612345678");
    assert.deepEqual(contactLinks({ phone: "+2250700000042" }), { tel: "tel:+2250700000042", whatsapp: "https://wa.me/2250700000042" });
  });

  test("le message d'information dit que le vendeur voit un contact, pas l'identité", () => {
    assert.equal(CONTACT_NOTICE, "Le vendeur verra que vous l'avez contacté via noma.");
    assert.equal(CONTACT_BUTTON_LABEL, "Contacter le vendeur");
  });
});
