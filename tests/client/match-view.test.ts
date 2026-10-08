import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { MatchIndicators, StoredMatch } from "../../lib/client/api";
import {
  EMPTY_BUYER_MESSAGE,
  EMPTY_SELLER_MESSAGE,
  PROCESSING_MESSAGE,
  SPONSORED_BADGE_LABEL,
  SPONSORED_NOTICE,
  availabilityIndicatorView,
  buyerMatchRow,
  buyerResultsLabel,
  compatibilityPercent,
  compatibilityText,
  confidenceIndicatorView,
  confirmationAgeText,
  demandNotActiveMessage,
  indicatorViews,
  interestedBuyerRow,
  NEEDS_NOTE,
  createGenerationGuard,
  mergeIfCurrent,
  mergeMatchPages,
  offerNotPublishedMessage,
  priceIndicatorView,
  productTitle,
  resultsState,
} from "../../lib/client/match-view";

const SELLER_ID = "11111111-1111-4111-8111-111111111111";
const BUYER_ID = "22222222-2222-4222-8222-222222222222";
const PHONE = "+2250700000042";
const OFFER_ID = "33333333-3333-4333-8333-333333333333";

const baseIndicators = (): MatchIndicators => ({
  availability: { level: "confirmed_recent", score: 100, confirmedAgeHours: 5, factors: [] },
  price: { position: "in_market", score: 60, deltaPercent: 3, sampleSize: 8, factors: [] },
  confidence: { level: "high", score: 91, accountAgeBand: "gte_30d", factors: ["phone_verified", "account_age_gte_30d"] },
});

function offerMatch(overrides: Partial<StoredMatch> = {}): StoredMatch {
  return {
    candidateId: OFFER_ID,
    candidate: {
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
      budget: null,
      availabilityStatus: "available",
    },
    compatibilityStatus: "compatible",
    score: 92.4,
    coverage: 1,
    evaluatedAt: "2031-01-01T10:00:00.000Z",
    indicators: baseIndicators(),
    relevance: 88.5,
    sponsored: false,
    proBadge: false,
    ...overrides,
  };
}

function demandMatch(overrides: Partial<StoredMatch> = {}): StoredMatch {
  return offerMatch({
    candidateId: BUYER_ID,
    candidate: {
      category: "Téléphones",
      brand: "Apple",
      model: "iPhone 12",
      variant: null,
      condition: "Occasion",
      quantity: null,
      unit: null,
      location: "Abidjan",
      deadlineAt: null,
      price: null,
      budget: { amount: 200000, currency: "XOF" },
      availabilityStatus: null,
    },
    indicators: { availability: null, price: null, confidence: baseIndicators().confidence },
    ...overrides,
  });
}

describe("indicateurs en mots simples", () => {
  test("prix : en dessous / dans la moyenne / au-dessus / marché insuffisant / prix absent", () => {
    const view = (position: "below_market" | "in_market" | "above_market" | "insufficient_data", extra = {}) =>
      priceIndicatorView({ position, score: null, deltaPercent: null, sampleSize: 0, factors: [], ...extra });
    assert.deepEqual(
      [view("below_market"), view("in_market"), view("above_market")].map((entry) => [entry?.label, entry?.tone]),
      [
        ["Prix en dessous du marché", "good"],
        ["Prix dans la moyenne du marché", "neutral"],
        ["Prix au-dessus du marché", "warn"],
      ],
    );
    const insufficient = view("insufficient_data", { factors: ["insufficient_market"], sampleSize: 2 });
    assert.equal(insufficient?.label, "Marché insuffisant pour comparer le prix");
    assert.equal(insufficient?.detail, "Seulement 2 annonces comparables");
    assert.equal(view("insufficient_data", { factors: ["insufficient_market"], sampleSize: 1 })?.detail, "Seulement 1 annonce comparable");
    assert.equal(view("insufficient_data", { factors: ["insufficient_market"], sampleSize: 0 })?.detail, "Aucune annonce comparable");
    assert.equal(view("insufficient_data", { factors: ["price_missing"] })?.label, "Prix non renseigné par le vendeur");
    assert.equal(priceIndicatorView(null), null, "sens offre : pas d'indicateur de prix");
  });

  test("écart au prix médian dit en clair, jamais un code ni un prix de marché", () => {
    const text = (deltaPercent: number | null) =>
      priceIndicatorView({ position: "in_market", score: 60, deltaPercent, sampleSize: 9, factors: [] })?.detail;
    assert.equal(text(-12), "12 % en dessous du prix médian des annonces comparables");
    assert.equal(text(8), "8 % au-dessus du prix médian des annonces comparables");
    assert.equal(text(0), "Pile au prix médian des annonces comparables");
    assert.equal(text(null), null);
  });

  test("disponibilité : confirmée récemment, confirmée, à reconfirmer, réservée, indisponible, non renseignée", () => {
    const view = (level: "confirmed_recent" | "confirmed" | "unconfirmed" | "reserved" | "unavailable" | "unknown", extra = {}) =>
      availabilityIndicatorView({ level, score: null, confirmedAgeHours: null, factors: [], ...extra });
    assert.deepEqual(
      (["confirmed_recent", "confirmed", "unconfirmed", "reserved", "unavailable", "unknown"] as const).map((level) => view(level)?.label),
      [
        "Disponibilité confirmée récemment",
        "Disponibilité confirmée",
        "Disponibilité à reconfirmer auprès du vendeur",
        "Offre réservée",
        "Offre indisponible",
        "Disponibilité non renseignée",
      ],
    );
    assert.equal(view("confirmed_recent", { confirmedAgeHours: 5 })?.detail, "Confirmée il y a 5 h");
    assert.equal(view("confirmed", { confirmedAgeHours: 100 })?.detail, "Confirmée il y a 4 jours");
    assert.equal(view("unconfirmed", { confirmedAgeHours: null })?.detail, "Jamais confirmée");
    assert.equal(
      view("confirmed", { confirmedAgeHours: 2, factors: ["insufficient_quantity"] })?.detail,
      "Confirmée il y a 2 h. Quantité proposée inférieure à celle demandée",
    );
    assert.equal(availabilityIndicatorView(null), null);
    assert.equal(confirmationAgeText(0), "moins d'une heure");
    assert.equal(confirmationAgeText(47), "47 h");
    assert.equal(confirmationAgeText(48), "2 jours");
    assert.equal(confirmationAgeText(null), null);
  });

  test("confiance : élevée, moyenne, faible, avec l'ancienneté du compte par tranche et jamais une date ni un numéro", () => {
    const view = (level: "high" | "medium" | "low", accountAgeBand: "lt_7d" | "7d_30d" | "gte_30d", factors: string[] = []) =>
      confidenceIndicatorView({ level, score: 50, accountAgeBand, factors });
    assert.deepEqual(
      (["high", "medium", "low"] as const).map((level) => view(level, "gte_30d").label),
      ["Confiance élevée", "Confiance moyenne", "Confiance faible"],
    );
    assert.equal(view("high", "gte_30d", ["phone_verified"]).detail, "Compte créé il y a plus de 30 jours, téléphone vérifié");
    assert.equal(view("low", "lt_7d", ["phone_not_verified"]).detail, "Compte créé il y a moins de 7 jours, téléphone non vérifié");
    assert.equal(view("medium", "7d_30d").detail, "Compte créé il y a 7 à 30 jours");
  });

  test("les indicateurs applicables sont dans l'ordre prix, disponibilité, confiance (sens offre : confiance seule)", () => {
    assert.deepEqual(indicatorViews(baseIndicators()).map((entry) => entry.key), ["price", "availability", "confidence"]);
    assert.deepEqual(
      indicatorViews({ availability: null, price: null, confidence: baseIndicators().confidence }).map((entry) => entry.key),
      ["confidence"],
    );
  });

  test("aucun libellé n'expose un code brut du serveur", () => {
    const everything = JSON.stringify(indicatorViews(baseIndicators()));
    for (const code of ["confirmed_recent", "in_market", "gte_30d", "phone_verified", "below_market", "insufficient_data"]) {
      assert.equal(everything.includes(code), false, code);
    }
  });
});

describe("compatibilité", () => {
  test("pourcentage entier borné ; inconnu = « à confirmer »", () => {
    assert.equal(compatibilityPercent(92.4), 92);
    assert.equal(compatibilityPercent(92.5), 93);
    assert.equal(compatibilityPercent(120), 100);
    assert.equal(compatibilityPercent(-4), 0);
    assert.equal(compatibilityPercent(null), null);
    assert.equal(compatibilityPercent(Number.NaN), null);
    assert.equal(compatibilityText(92.4), "Compatibilité 92 %");
    assert.equal(compatibilityText(null), "Compatibilité à confirmer");
  });
});

describe("ligne d'une offre côté acheteur (« Sponsorisé »)", () => {
  test("offre non sponsorisée : aucun badge ni mention de mise en avant", () => {
    const row = buyerMatchRow(offerMatch({ sponsored: false }));
    assert.equal(row.sponsored, false);
    assert.equal(row.sponsoredBadge, null);
    assert.equal(row.sponsoredNotice, null);
    assert.equal(JSON.stringify(row).includes(SPONSORED_BADGE_LABEL), false);
  });

  test("offre sponsorisée : badge « Sponsorisé » et mention « Mis en avant par le vendeur, parmi des résultats déjà pertinents »", () => {
    const row = buyerMatchRow(offerMatch({ sponsored: true }));
    assert.equal(row.sponsored, true);
    assert.equal(row.sponsoredBadge, "Sponsorisé");
    assert.equal(row.sponsoredNotice, "Mis en avant par le vendeur, parmi des résultats déjà pertinents");
    assert.equal(SPONSORED_BADGE_LABEL, "Sponsorisé");
    assert.equal(SPONSORED_NOTICE, "Mis en avant par le vendeur, parmi des résultats déjà pertinents");
  });

  test("titre, prix, compatibilité et indicateurs ; prix absent dit en clair", () => {
    const row = buyerMatchRow(offerMatch());
    assert.equal(row.title, "Apple iPhone 12 128 Go");
    assert.equal(row.subtitle, "Occasion · Abidjan");
    assert.match(row.priceText, /^150\s000 FCFA$/);
    assert.equal(row.compatibility, "Compatibilité 92 %");
    assert.equal(row.compatibilityPercent, 92);
    assert.deepEqual(row.indicators.map((entry) => entry.key), ["price", "availability", "confidence"]);
    const noPrice = buyerMatchRow(offerMatch({ candidate: { ...offerMatch().candidate, price: null } }));
    assert.equal(noPrice.priceText, "Prix non renseigné");
  });

  test("aucune identité ni identifiant du vendeur dans la ligne : seule la clé de liste porte l'identifiant de l'offre", () => {
    // Un élément reçu avec des champs d'identité en trop (le client les ignore déjà à la lecture) : rien ne doit sortir.
    const hostile = {
      ...offerMatch(),
      ownerId: SELLER_ID,
      sellerPhone: PHONE,
      owner: { id: SELLER_ID, phone: PHONE, name: "Awa Traoré" },
    } as StoredMatch;
    const { key, ...displayed } = buyerMatchRow(hostile);
    assert.equal(key, OFFER_ID);
    const text = JSON.stringify(displayed);
    for (const secret of [SELLER_ID, PHONE, "Awa", OFFER_ID, "0700000042"]) assert.equal(text.includes(secret), false, secret);
    assert.equal(/[0-9a-f]{8}-[0-9a-f]{4}-/.test(text), false, "aucun UUID dans les textes affichés");
  });

  test("titre de repli : catégorie, puis texte fixe", () => {
    assert.equal(productTitle({ brand: null, model: null, variant: null, category: "Téléphones" }, "Offre"), "Téléphones");
    assert.equal(productTitle({ brand: " ", model: "", variant: null, category: null }, "Offre"), "Offre");
    assert.equal(productTitle({ brand: "Apple", model: null, variant: "128 Go", category: "Téléphones" }, "Offre"), "Apple 128 Go");
  });
});

describe("ligne d'un besoin côté vendeur (acheteurs intéressés)", () => {
  test("titre, budget, compatibilité et confiance de l'acheteur", () => {
    const row = interestedBuyerRow(demandMatch());
    assert.equal(row.title, "Apple iPhone 12");
    assert.equal(row.subtitle, "Occasion · Abidjan");
    assert.match(row.budgetText, /^Budget : jusqu'à 200\s000 FCFA$/);
    assert.equal(row.compatibility, "Compatibilité 92 %");
    assert.equal(row.confidence.label, "Confiance élevée");
    assert.equal(interestedBuyerRow(demandMatch({ candidate: { ...demandMatch().candidate, budget: null } })).budgetText, "Budget non précisé");
  });

  test("AUCUNE identité ni téléphone d'acheteur, aucun UUID dans les textes affichés", () => {
    const hostile = {
      ...demandMatch(),
      ownerId: BUYER_ID,
      buyerPhone: PHONE,
      owner: { id: BUYER_ID, phone: PHONE, name: "Kouadio Yao" },
    } as StoredMatch;
    const { key, ...displayed } = interestedBuyerRow(hostile);
    assert.equal(key, BUYER_ID, "seule la clé de liste porte l'identifiant du besoin (jamais affichée)");
    assert.deepEqual(Object.keys(displayed).sort(), ["budgetText", "compatibility", "compatibilityPercent", "confidence", "subtitle", "title"]);
    const text = JSON.stringify(displayed);
    for (const secret of [BUYER_ID, PHONE, "Kouadio", "0700000042", "ownerId", "buyerPhone"]) {
      assert.equal(text.includes(secret), false, secret);
    }
    assert.equal(/[0-9a-f]{8}-[0-9a-f]{4}-/.test(text), false);
  });
});

describe("pagination « Voir plus » et états", () => {
  test("la page suivante s'ajoute sans doublon et sans réordonner", () => {
    const a = offerMatch({ candidateId: "a" });
    const b = offerMatch({ candidateId: "b" });
    const c = offerMatch({ candidateId: "c" });
    assert.deepEqual(mergeMatchPages([a, b], [b, c]).map((item) => item.candidateId), ["a", "b", "c"]);
    assert.deepEqual(mergeMatchPages([], [c, a]).map((item) => item.candidateId), ["c", "a"]);
    assert.deepEqual(mergeMatchPages([a], []).map((item) => item.candidateId), ["a"]);
  });

  test("la page suivante est aussi dédupliquée EN ELLE-MÊME (un élément répété à l'intérieur d'une même page n'apparaît qu'une fois)", () => {
    const a = offerMatch({ candidateId: "a" });
    const b = offerMatch({ candidateId: "b" });
    const c = offerMatch({ candidateId: "c" });
    assert.deepEqual(mergeMatchPages([a], [b, b, c, b, c]).map((item) => item.candidateId), ["a", "b", "c"]);
    assert.deepEqual(mergeMatchPages([], [b, b]).map((item) => item.candidateId), ["b"]);
    assert.deepEqual(mergeMatchPages([a, b], [c, a, c]).map((item) => item.candidateId), ["a", "b", "c"]);
  });

  test("« Actualiser » invalide les « Voir plus » en cours : une réponse d'une génération antérieure n'est jamais fusionnée", () => {
    const guard = createGenerationGuard();
    const a = offerMatch({ candidateId: "a" });
    const b = offerMatch({ candidateId: "b" });
    const c = offerMatch({ candidateId: "c" });
    const firstPageT0 = guard.begin();
    assert.equal(guard.isCurrent(firstPageT0), true);
    const moreFromT0 = guard.begin(); // « Voir plus » parti à T0
    assert.equal(guard.isCurrent(moreFromT0), true);
    assert.deepEqual(mergeIfCurrent(guard, moreFromT0, [a], [b])?.map((item) => item.candidateId), ["a", "b"]);
    // « Actualiser » : nouvelle génération (T1) ; la réponse de « Voir plus » arrive APRÈS.
    const firstPageT1 = guard.begin();
    assert.equal(guard.isCurrent(moreFromT0), false);
    assert.equal(guard.isCurrent(firstPageT0), false);
    assert.equal(mergeIfCurrent(guard, moreFromT0, [a], [c]), null, "page 2 de T0 ignorée");
    assert.equal(guard.isCurrent(firstPageT1), true);
    assert.deepEqual(mergeIfCurrent(guard, firstPageT1, [a], [c])?.map((item) => item.candidateId), ["a", "c"]);
    // Deux gardes sont indépendantes.
    const other = createGenerationGuard();
    assert.equal(other.isCurrent(other.begin()), true);
    assert.equal(guard.isCurrent(firstPageT1), true);
  });

  test("état : chargement, « Recherche en cours… », vide, liste", () => {
    assert.equal(resultsState({ loaded: false, itemCount: 0, processing: true }), "loading");
    assert.equal(resultsState({ loaded: true, itemCount: 0, processing: true }), "processing");
    assert.equal(resultsState({ loaded: true, itemCount: 0, processing: false }), "empty");
    assert.equal(resultsState({ loaded: true, itemCount: 3, processing: true }), "results");
    assert.equal(resultsState({ loaded: true, itemCount: 3, processing: false }), "results");
    assert.equal(PROCESSING_MESSAGE, "Recherche en cours…");
    assert.match(EMPTY_BUYER_MESSAGE, /Aucune offre/);
    assert.equal(EMPTY_SELLER_MESSAGE, "Aucun besoin d'acheteur ne correspond pour le moment.");
  });

  test("besoin non actif et annonce non en ligne : messages clairs, rien à dire pour actif / en ligne", () => {
    assert.equal(demandNotActiveMessage("active"), null);
    assert.match(demandNotActiveMessage("draft") ?? "", /brouillon/);
    assert.match(demandNotActiveMessage("satisfied") ?? "", /satisfait/);
    assert.match(demandNotActiveMessage("archived") ?? "", /archivé/);
    assert.equal(offerNotPublishedMessage("published"), null);
    assert.match(offerNotPublishedMessage("draft") ?? "", /brouillon/);
    assert.match(offerNotPublishedMessage("paused") ?? "", /pause/);
    assert.match(offerNotPublishedMessage("archived") ?? "", /archivée/);
  });

  test("côté vendeur (lot D3) : aucun compte arrondi au-dessus de la liste ; la phrase dit que chaque ligne est le besoin d'un acheteur, sans son identité", () => {
    assert.equal(NEEDS_NOTE, "Chaque ligne est le besoin d'un acheteur, sans son identité.");
    assert.equal(/acheteurs? intéressés?/.test(NEEDS_NOTE), false);
    assert.equal(/\d/.test(NEEDS_NOTE), false, "aucun nombre dans la phrase");
  });

  test("compteurs de l'acheteur : accord au pluriel et « Au moins » tant qu'il reste des pages", () => {    assert.equal(buyerResultsLabel(0, false), "Aucune offre pour le moment");
    assert.equal(buyerResultsLabel(1, false), "1 offre correspond à votre besoin");
    assert.equal(buyerResultsLabel(4, false), "4 offres correspondent à votre besoin");
    assert.equal(buyerResultsLabel(20, true), "Au moins 20 offres correspondent à votre besoin");
  });
});
