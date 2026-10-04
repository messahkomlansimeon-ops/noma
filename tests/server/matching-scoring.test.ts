import assert from "node:assert/strict";
import test from "node:test";
import type { DemandRecord, OfferRecord } from "../../lib/server/catalog/types";
import { evaluateOfflineMatching } from "../../lib/server/matching/offline";
import {
  computeMatchingScore,
  DEFAULT_CRITERIA_WEIGHTS,
  DEFAULT_CRITERION_WEIGHT,
} from "../../lib/server/matching/scoring";
import {
  MATCHING_SCORING_CONTRACT_VERSION,
  MatchingScoringValidationError,
} from "../../lib/server/matching/types";

function deepFreeze<T>(obj: T): Readonly<T> {
  if (obj === null || typeof obj !== "object") return obj;
  Object.freeze(obj);
  for (const key of Object.keys(obj)) {
    const val = (obj as Record<string, unknown>)[key];
    if (val !== null && typeof val === "object" && !Object.isFrozen(val)) {
      deepFreeze(val);
    }
  }
  return obj;
}

const fixedNow = new Date("2026-10-04T12:00:00.000Z");

function baseOffer(overrides: Partial<OfferRecord> = {}): OfferRecord {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    ownerId: "11111111-1111-1111-1111-111111111111",
    status: "published",
    contentVersion: 1,
    rawText: "iPhone 12 Pro 128 Go 200 000 FCFA Cocody bon état avec chargeur",
    category: "phones",
    brand: "Apple",
    model: "iPhone 12",
    variant: "Pro",
    attributes: {
      storage_capacity: { value: 128, unit: "Go", sourceUnit: "Go" },
      charger_included: { value: true, unit: null, sourceUnit: null },
    },
    condition: "good",
    quantity: 1,
    unit: "pièce",
    location: "Cocody, Abidjan",
    deadlineAt: null,
    price: { amount: 200_000, currency: "XOF" },
    availabilityStatus: "available",
    availabilityConfirmedAt: new Date("2026-10-01T10:00:00.000Z"),
    extractorVersion: "noma-deterministic/v1",
    extractionMetadata: null,
    extractedAt: new Date("2026-10-01T10:00:00.000Z"),
    createdAt: new Date("2026-10-01T10:00:00.000Z"),
    updatedAt: new Date("2026-10-01T10:00:00.000Z"),
    archivedAt: null,
    ...overrides,
  };
}

function baseDemand(overrides: Partial<DemandRecord> = {}): DemandRecord {
  return {
    id: "00000000-0000-0000-0000-000000000002",
    ownerId: "22222222-2222-2222-2222-222222222222",
    status: "active",
    contentVersion: 1,
    rawText: "Cherche iPhone 12 Pro 128 Go max 250 000 FCFA Cocody bon état avec chargeur",
    category: "phones",
    brand: "Apple",
    model: "iPhone 12",
    variant: "Pro",
    attributes: {
      storage_capacity: { value: 128, unit: "Go", sourceUnit: "Go" },
    },
    condition: "good",
    quantity: 1,
    unit: "pièce",
    location: "Cocody",
    deadlineAt: null,
    budget: { amount: 250_000, currency: "XOF" },
    requirements: [
      { key: "chargeur", operator: "includes", value: "chargeur" },
    ],
    preferences: [
      { key: "color", operator: "equals", value: "noir" },
    ],
    extractorVersion: "noma-deterministic/v1",
    extractionMetadata: null,
    extractedAt: new Date("2026-10-01T11:00:00.000Z"),
    createdAt: new Date("2026-10-01T11:00:00.000Z"),
    updatedAt: new Date("2026-10-01T11:00:00.000Z"),
    archivedAt: null,
    ...overrides,
  };
}

test("lot 2B — contrat de scoring versionné et métadonnées", () => {
  const evalRes = evaluateOfflineMatching(baseOffer(), baseDemand(), { now: fixedNow });
  const scoreRes = computeMatchingScore(evalRes, { now: fixedNow });

  assert.equal(scoreRes.contractVersion, MATCHING_SCORING_CONTRACT_VERSION);
  assert.equal(scoreRes.contractVersion, "matching-scoring/v1");
  assert.equal(scoreRes.scoredAt.toISOString(), fixedNow.toISOString());
  assert.equal(scoreRes.evaluationTimestamp.toISOString(), evalRes.evaluatedAt.toISOString());
  assert.equal(scoreRes.offerId, evalRes.offer.id);
  assert.equal(scoreRes.demandId, evalRes.demand.id);
  assert.equal(DEFAULT_CRITERION_WEIGHT, 1);
  assert.equal(DEFAULT_CRITERIA_WEIGHTS.category, 1);
});

test("lot 2B — cas nominal parfait (score = 100, couverture = 100)", () => {
  const evalRes = evaluateOfflineMatching(baseOffer(), baseDemand(), { now: fixedNow });
  assert.equal(evalRes.compatibility.status, "compatible");

  const scoreRes = computeMatchingScore(evalRes, { now: fixedNow });

  assert.equal(scoreRes.score, 100);
  assert.equal(scoreRes.coverage, 100);
  assert.equal(scoreRes.isCompatible, true);
  assert.equal(scoreRes.isEligible, true);
  assert.equal(scoreRes.compatibilityStatus, "compatible");
  assert.equal(scoreRes.eligibilityStatus, "eligible");

  assert.equal(scoreRes.summary.mismatchedCount, 0);
  assert.equal(scoreRes.summary.unknownCount, 0);
  assert.ok(scoreRes.summary.matchedCount > 0);
  assert.equal(scoreRes.summary.matchedWeight, scoreRes.summary.totalApplicableWeight);

  // Vérifier la somme des contributions
  let totalContribPercent = 0;
  for (const contrib of Object.values(scoreRes.contributions)) {
    if (contrib.isApplicable && !contrib.isDuplicate) {
      assert.equal(contrib.status, "matched");
      assert.ok(contrib.scoreContributionPercent > 0);
      assert.equal(contrib.scoreContributionPercent, contrib.coverageContributionPercent);
      totalContribPercent += contrib.scoreContributionPercent;
    }
  }
  assert.equal(Math.round(totalContribPercent), 100);
});

test("lot 2B — calculs manuels vérifiables avec poids personnalisés", () => {
  // Construire un résultat avec 3 critères applicables :
  // - category (matched, poids 2)
  // - brand (matched, poids 3)
  // - model (mismatched, poids 5)
  // Total applicable weight = 10
  // Matched weight = 5 -> score = 100 * 5 / 10 = 50
  // Covered weight = 10 -> coverage = 100 * 10 / 10 = 100
  const offer = baseOffer({ model: "iPhone 13" }); // modèle différent -> mismatched
  const demand = baseDemand({
    // Isoler seulement category, brand, model
    variant: null,
    budget: null,
    quantity: null,
    condition: null,
    location: null,
    attributes: null,
    requirements: null,
    preferences: null,
  });

  const evalRes = evaluateOfflineMatching(offer, demand, { now: fixedNow });
  assert.equal(evalRes.compatibility.criteria.category.status, "matched");
  assert.equal(evalRes.compatibility.criteria.brand.status, "matched");
  assert.equal(evalRes.compatibility.criteria.model.status, "mismatched");

  const scoreRes = computeMatchingScore(evalRes, {
    weights: {
      category: 2,
      brand: 3,
      model: 5,
    },
    now: fixedNow,
  });

  assert.equal(scoreRes.summary.totalApplicableWeight, 10);
  assert.equal(scoreRes.summary.matchedWeight, 5);
  assert.equal(scoreRes.summary.mismatchedWeight, 5);
  assert.equal(scoreRes.summary.unknownWeight, 0);

  assert.equal(scoreRes.score, 50);
  assert.equal(scoreRes.coverage, 100);

  // Contributions détaillées
  const contribCategory = scoreRes.contributions.category;
  assert.equal(contribCategory.weight, 2);
  assert.equal(contribCategory.effectiveWeight, 2);
  assert.equal(contribCategory.scoreContributionPercent, 20); // 2/10 * 100
  assert.equal(contribCategory.coverageContributionPercent, 20);

  const contribBrand = scoreRes.contributions.brand;
  assert.equal(contribBrand.weight, 3);
  assert.equal(contribBrand.effectiveWeight, 3);
  assert.equal(contribBrand.scoreContributionPercent, 30); // 3/10 * 100
  assert.equal(contribBrand.coverageContributionPercent, 30);

  const contribModel = scoreRes.contributions.model;
  assert.equal(contribModel.weight, 5);
  assert.equal(contribModel.effectiveWeight, 5);
  assert.equal(contribModel.scoreContributionPercent, 0); // mismatched -> 0
  assert.equal(contribModel.coverageContributionPercent, 50); // covered -> 50%
});

test("lot 2B — critères inconnus (unknown) réduisent le score et la couverture", () => {
  // Offre sans prix face à une demande avec budget -> price_vs_budget = unknown
  const offer = baseOffer({ price: null });
  const demand = baseDemand({
    variant: null,
    condition: null,
    location: null,
    attributes: null,
    requirements: null,
    preferences: null,
  });

  const evalRes = evaluateOfflineMatching(offer, demand, { now: fixedNow });
  // category(m), brand(m), model(m), quantity(m), price_vs_budget(u)
  // 4 matched, 1 unknown (poids par défaut 1) -> total 5
  // score = 100 * 4 / 5 = 80
  // coverage = 100 * 4 / 5 = 80

  const scoreRes = computeMatchingScore(evalRes, { now: fixedNow });
  assert.equal(scoreRes.summary.matchedCount, 4);
  assert.equal(scoreRes.summary.unknownCount, 1);
  assert.equal(scoreRes.summary.mismatchedCount, 0);
  assert.equal(scoreRes.score, 80);
  assert.equal(scoreRes.coverage, 80);
  assert.equal(scoreRes.contributions.price_vs_budget.status, "unknown");
  assert.equal(scoreRes.contributions.price_vs_budget.scoreContributionPercent, 0);
  assert.equal(scoreRes.contributions.price_vs_budget.coverageContributionPercent, 0);
});

test("lot 2B — demande sans critère applicable produit score et couverture null", () => {
  const emptyDemand = baseDemand({
    category: null,
    brand: null,
    model: null,
    variant: null,
    budget: null,
    quantity: null,
    unit: null,
    condition: null,
    location: null,
    deadlineAt: null,
    attributes: null,
    requirements: null,
    preferences: null,
  });

  const evalRes = evaluateOfflineMatching(baseOffer(), emptyDemand, { now: fixedNow });
  assert.equal(evalRes.compatibility.status, "unknown");

  const scoreRes = computeMatchingScore(evalRes, { now: fixedNow });
  assert.equal(scoreRes.score, null);
  assert.equal(scoreRes.coverage, null);
  assert.equal(scoreRes.summary.totalApplicableWeight, 0);
  assert.equal(scoreRes.summary.applicableCriteriaCount, 0);
});

test("lot 2B — non-récompense de la duplication exacte d'un critère explicite", () => {
  // Demande avec 2 exigences identiques : "chargeur"
  const demandWithDuplicates = baseDemand({
    requirements: [
      { key: "chargeur", operator: "includes", value: "chargeur" },
      { key: "chargeur", operator: "includes", value: "chargeur" }, // doublon exact
    ],
  });

  const evalRes = evaluateOfflineMatching(baseOffer(), demandWithDuplicates, { now: fixedNow });
  assert.equal(evalRes.compatibility.criteria["requirements.0"].status, "matched");
  assert.equal(evalRes.compatibility.criteria["requirements.1"].status, "matched");

  const scoreRes = computeMatchingScore(evalRes, { now: fixedNow });

  // Le doublon doit être marqué isDuplicate = true et son poids effectif est 0
  const req0 = scoreRes.contributions["requirements.0"];
  const req1 = scoreRes.contributions["requirements.1"];

  assert.equal(req0.isDuplicate, false);
  assert.equal(req0.effectiveWeight, 1);
  assert.ok(req0.scoreContributionPercent > 0);

  assert.equal(req1.isDuplicate, true);
  assert.equal(req1.effectiveWeight, 0);
  assert.equal(req1.scoreContributionPercent, 0);
  assert.equal(scoreRes.summary.duplicateCount, 1);

  // Le score avec doublon ignoré doit être identique au score sans le doublon
  const demandWithoutDuplicate = baseDemand({
    requirements: [
      { key: "chargeur", operator: "includes", value: "chargeur" },
    ],
  });
  const evalResSingle = evaluateOfflineMatching(baseOffer(), demandWithoutDuplicate, { now: fixedNow });
  const scoreResSingle = computeMatchingScore(evalResSingle, { now: fixedNow });

  assert.equal(scoreRes.score, scoreResSingle.score);
  assert.equal(scoreRes.coverage, scoreResSingle.coverage);
  assert.equal(scoreRes.summary.totalApplicableWeight, scoreResSingle.summary.totalApplicableWeight);
});

test("lot 2B — rejet des configurations de poids invalides (erreur typée)", () => {
  const evalRes = evaluateOfflineMatching(baseOffer(), baseDemand(), { now: fixedNow });

  // 1. Poids = 0
  assert.throws(
    () => computeMatchingScore(evalRes, { weights: { category: 0 } }),
    (err: unknown) => err instanceof MatchingScoringValidationError && err.code === "INVALID_SCORING_CONFIG",
  );

  // 2. Poids négatif
  assert.throws(
    () => computeMatchingScore(evalRes, { weights: { category: -2 } }),
    (err: unknown) => err instanceof MatchingScoringValidationError && err.code === "INVALID_SCORING_CONFIG",
  );

  // 3. Poids NaN
  assert.throws(
    () => computeMatchingScore(evalRes, { weights: { category: Number.NaN } }),
    (err: unknown) => err instanceof MatchingScoringValidationError && err.code === "INVALID_SCORING_CONFIG",
  );

  // 4. Poids infini
  assert.throws(
    () => computeMatchingScore(evalRes, { weights: { category: Number.POSITIVE_INFINITY } }),
    (err: unknown) => err instanceof MatchingScoringValidationError && err.code === "INVALID_SCORING_CONFIG",
  );

  // 5. defaultWeight invalide (0)
  assert.throws(
    () => computeMatchingScore(evalRes, { defaultWeight: 0 }),
    (err: unknown) => err instanceof MatchingScoringValidationError && err.code === "INVALID_SCORING_CONFIG",
  );

  // 6. Précision invalide (négative ou non entière)
  assert.throws(
    () => computeMatchingScore(evalRes, { precision: -1 }),
    (err: unknown) => err instanceof MatchingScoringValidationError && err.code === "INVALID_SCORING_CONFIG",
  );
  assert.throws(
    () => computeMatchingScore(evalRes, { precision: 2.5 }),
    (err: unknown) => err instanceof MatchingScoringValidationError && err.code === "INVALID_SCORING_CONFIG",
  );

  // 7. weights n'est pas un objet
  assert.throws(
    () => computeMatchingScore(evalRes, { weights: "invalide" as unknown as Record<string, number> }),
    (err: unknown) => err instanceof MatchingScoringValidationError && err.code === "INVALID_SCORING_CONFIG",
  );
});

test("lot 2B — invariant : 100 ne doit jamais être affiché avec une obligation inconnue ou contredite", () => {
  // Construire un cas où 999 critères sont matched et 1 critère minuscule est unknown.
  // rawScore = 100 * 999 / 1000 = 99.9%.
  // Avec arrondi à l'entier (precision: 0), Math.round(99.9) donnerait 100.
  // Mais l'invariant STRICT interdit formellement d'afficher 100 !
  const evalRes = evaluateOfflineMatching(
    baseOffer({ price: null }), // price_vs_budget = unknown
    baseDemand({
      variant: null,
      condition: null,
      location: null,
      attributes: null,
      requirements: null,
      preferences: null,
    }),
    { now: fixedNow },
  );

  // Donner un poids écrasant aux 4 critères matched et un poids minime au critère unknown
  const scoreWithHighPrecision = computeMatchingScore(evalRes, {
    weights: {
      category: 999,
      brand: 999,
      model: 999,
      quantity: 999,
      price_vs_budget: 0.001,
    },
    precision: 0, // arrondi entier
    now: fixedNow,
  });

  // Ne doit JAMAIS être 100 !
  assert.ok(scoreWithHighPrecision.score !== null);
  assert.ok(scoreWithHighPrecision.score < 100, `Score reçu: ${scoreWithHighPrecision.score} (doit être < 100)`);
  assert.equal(scoreWithHighPrecision.score, 99);

  // Idem avec precision 2 décimales
  const scoreWithDecimals = computeMatchingScore(evalRes, {
    weights: {
      category: 99999,
      brand: 99999,
      model: 99999,
      quantity: 99999,
      price_vs_budget: 0.0001,
    },
    precision: 2,
    now: fixedNow,
  });

  assert.ok(scoreWithDecimals.score !== null);
  assert.ok(scoreWithDecimals.score < 100);
  assert.equal(scoreWithDecimals.score, 99.99);

  // De même avec un critère contredit (mismatched)
  const evalResMismatched = evaluateOfflineMatching(
    baseOffer({ brand: "Samsung" }), // brand mismatched
    baseDemand({
      variant: null,
      condition: null,
      location: null,
      attributes: null,
      requirements: null,
      preferences: null,
    }),
    { now: fixedNow },
  );
  const scoreMismatched = computeMatchingScore(evalResMismatched, {
    weights: {
      category: 9999,
      brand: 0.0001,
    },
    precision: 0,
    now: fixedNow,
  });
  assert.ok(scoreMismatched.score !== null);
  assert.ok(scoreMismatched.score < 100);
  assert.equal(scoreMismatched.score, 99);
});

test("lot 2B — monotonie : remplacer matched par unknown ne doit jamais augmenter le score", () => {
  // Étape 1 : tout matched
  const evalFullMatch = evaluateOfflineMatching(baseOffer(), baseDemand(), { now: fixedNow });
  const score1 = computeMatchingScore(evalFullMatch, { now: fixedNow }).score!;

  // Étape 2 : remplacer un critère matched par unknown (prix absent sur l'offre)
  const evalOneUnknown = evaluateOfflineMatching(baseOffer({ price: null }), baseDemand(), { now: fixedNow });
  const score2 = computeMatchingScore(evalOneUnknown, { now: fixedNow }).score!;

  assert.ok(score2 < score1, `Score après unknown (${score2}) doit être inférieur à score avant (${score1})`);

  // Étape 3 : remplacer un deuxième critère par unknown (marque absente sur l'offre)
  const evalTwoUnknown = evaluateOfflineMatching(baseOffer({ price: null, brand: null }), baseDemand(), { now: fixedNow });
  const score3 = computeMatchingScore(evalTwoUnknown, { now: fixedNow }).score!;

  assert.ok(score3 < score2, `Score après 2 inconnues (${score3}) doit être inférieur à (${score2})`);
});

test("lot 2B — absence de mutation des entrées (immuabilité stricte sous deepFreeze)", () => {
  const evalRes = evaluateOfflineMatching(baseOffer(), baseDemand(), { now: fixedNow });
  const options = { weights: { category: 2, brand: 3 }, precision: 2, now: fixedNow };

  const frozenEval = deepFreeze(evalRes);
  const frozenOptions = deepFreeze(options);

  const scoreRes = computeMatchingScore(frozenEval, frozenOptions);

  assert.equal(scoreRes.score, 100);
  assert.equal(frozenEval.offer.id, "00000000-0000-0000-0000-000000000001");
  assert.equal(frozenOptions.weights.category, 2);
});

test("lot 2B — les préférences restent séparées et n'apportent aucun bonus compensatoire", () => {
  // Cas A : offre avec préférence satisfaite (color: noir)
  const offerWithPref = baseOffer({
    attributes: {
      storage_capacity: { value: 128, unit: "Go" },
      charger_included: { value: true },
      color: { value: "noir" },
    },
  });
  // Cas B : offre avec préférence insatisfaite (color: bleu)
  const offerWithoutPref = baseOffer({
    attributes: {
      storage_capacity: { value: 128, unit: "Go" },
      charger_included: { value: true },
      color: { value: "bleu" },
    },
  });

  const demand = baseDemand({
    preferences: [{ key: "color", operator: "equals", value: "noir" }],
  });

  const evalA = evaluateOfflineMatching(offerWithPref, demand, { now: fixedNow });
  const evalB = evaluateOfflineMatching(offerWithoutPref, demand, { now: fixedNow });

  const scoreA = computeMatchingScore(evalA, { now: fixedNow });
  const scoreB = computeMatchingScore(evalB, { now: fixedNow });

  // Invariant absolu : le score obligatoire est strictement identique !
  assert.equal(scoreA.score, scoreB.score);
  assert.equal(scoreA.coverage, scoreB.coverage);

  // Les préférences ont leur propre résumé séparé
  assert.equal(scoreA.preferences.preferenceScore, 100);
  assert.equal(scoreA.preferences.matchedCount, 1);
  assert.equal(scoreB.preferences.preferenceScore, 0);
  assert.equal(scoreB.preferences.mismatchedCount, 1);
});

test("lot 2B — préservation des statuts 2A et non-admissibilité d'un couple incompatible ou inéligible", () => {
  // Cas 1 : Offre brouillon -> inéligible
  const draftOffer = baseOffer({ status: "draft" });
  const evalIneligible = evaluateOfflineMatching(draftOffer, baseDemand(), { now: fixedNow });
  assert.equal(evalIneligible.eligibility.status, "ineligible");

  const scoreIneligible = computeMatchingScore(evalIneligible, { now: fixedNow });
  assert.equal(scoreIneligible.isEligible, false);
  assert.equal(scoreIneligible.eligibilityStatus, "ineligible");

  // Cas 2 : Marque différente -> incompatible
  const differentBrandOffer = baseOffer({ brand: "Samsung" });
  const evalIncompatible = evaluateOfflineMatching(differentBrandOffer, baseDemand(), { now: fixedNow });
  assert.equal(evalIncompatible.compatibility.status, "incompatible");

  const scoreIncompatible = computeMatchingScore(evalIncompatible, { now: fixedNow });
  assert.equal(scoreIncompatible.isCompatible, false);
  assert.equal(scoreIncompatible.compatibilityStatus, "incompatible");
  // Le score existe mathématiquement (ex: 80% des autres critères sont bons),
  // mais isCompatible reste STRICTEMENT false !
  assert.ok(scoreIncompatible.score !== null);
  assert.ok(scoreIncompatible.score > 0);
  assert.equal(scoreIncompatible.isCompatible, false);
});

test("lot 2B (audit) — attribut avec unité et exigence sans unité sont des obligations distinctes", () => {
  const attributes = { storage_capacity: { value: 128, unit: "GB" } };
  const offer = baseOffer({ attributes });
  const demand = baseDemand({
    category: null,
    brand: null,
    model: null,
    variant: null,
    budget: null,
    quantity: null,
    unit: null,
    condition: null,
    location: null,
    deadlineAt: null,
    attributes,
    requirements: [{ key: "storage_capacity", operator: "equals", value: 128 }],
    preferences: null,
  });

  const evalRes = evaluateOfflineMatching(offer, demand, { now: fixedNow });
  const scoreRes = computeMatchingScore(evalRes, { now: fixedNow });

  // attributes.storage_capacity est matched (1 point), requirements.0 est unknown (0 point)
  // Total applicable weight = 2, score = 50, coverage = 50
  assert.equal(scoreRes.score, 50);
  assert.equal(scoreRes.coverage, 50);
  assert.equal(scoreRes.contributions["requirements.0"].isDuplicate, false);
});

test("lot 2B (audit) — propriété additionnelle inconnue sur une exigence ne disparaît pas", () => {
  const req = { key: "garantie", operator: "includes", value: "garantie" };
  const offer = baseOffer({ attributes: { warranty_mentioned: true } });
  const demand = baseDemand({
    category: null,
    brand: null,
    model: null,
    variant: null,
    budget: null,
    quantity: null,
    unit: null,
    condition: null,
    location: null,
    deadlineAt: null,
    attributes: null,
    requirements: [req, { ...req, minimumDurationMonths: 12 }],
    preferences: null,
  });

  const evalRes = evaluateOfflineMatching(offer, demand, { now: fixedNow });
  const scoreRes = computeMatchingScore(evalRes, { now: fixedNow });

  // req est matched, la seconde avec minimumDurationMonths est unknown (car propriété non supportée dans 2A)
  // Total applicable weight = 2, score = 50, coverage = 50
  assert.equal(scoreRes.score, 50);
  assert.equal(scoreRes.coverage, 50);
  assert.equal(scoreRes.contributions["requirements.1"].isDuplicate, false);
});

test("lot 2B (audit) — clés d'attributs sensibles à la casse conservent l'obligation contradictoire", () => {
  const offer = baseOffer({ attributes: { Color: "red", color: "blue" } });
  const demand = baseDemand({
    category: null,
    brand: null,
    model: null,
    variant: null,
    budget: null,
    quantity: null,
    unit: null,
    condition: null,
    location: null,
    deadlineAt: null,
    attributes: { Color: "red", color: "red" },
    requirements: null,
    preferences: null,
  });

  const evalRes = evaluateOfflineMatching(offer, demand, { now: fixedNow });
  const scoreRes = computeMatchingScore(evalRes, { now: fixedNow });

  assert.equal(scoreRes.compatibilityStatus, "incompatible");
  assert.equal(scoreRes.score, 50);
  assert.equal(scoreRes.coverage, 100);
});

test("lot 2B (audit) — grand poids fini ne produit pas Infinity", () => {
  const offer = baseOffer({ model: "iPhone 12" });
  const demand = baseDemand({
    category: null,
    brand: null,
    model: "iPhone 12",
    variant: null,
    budget: null,
    quantity: null,
    unit: null,
    condition: null,
    location: null,
    deadlineAt: null,
    attributes: null,
    requirements: null,
    preferences: null,
  });

  const evalRes = evaluateOfflineMatching(offer, demand, { now: fixedNow });
  const scoreRes = computeMatchingScore(evalRes, { weights: { model: 1e308 }, now: fixedNow });

  assert.equal(scoreRes.score, 100);
  assert.equal(scoreRes.coverage, 100);
  assert.ok(Number.isFinite(scoreRes.summary.totalApplicableWeight));
  assert.ok(Number.isFinite(scoreRes.contributions.model.scoreContributionPercent));
});

test("lot 2B (audit) — dépassement de capacité de la somme des poids rejeté avec MatchingScoringValidationError", () => {
  const offer = baseOffer({ model: "iPhone 12", brand: "Apple" });
  const demand = baseDemand({
    category: null,
    brand: "Apple",
    model: "iPhone 12",
    variant: null,
    budget: null,
    quantity: null,
    unit: null,
    condition: null,
    location: null,
    deadlineAt: null,
    attributes: null,
    requirements: null,
    preferences: null,
  });

  const evalRes = evaluateOfflineMatching(offer, demand, { now: fixedNow });
  assert.throws(
    () => computeMatchingScore(evalRes, { weights: { model: Number.MAX_VALUE, brand: Number.MAX_VALUE }, now: fixedNow }),
    (err: unknown) => err instanceof MatchingScoringValidationError && err.code === "INVALID_SCORING_CONFIG",
  );
});

test("lot 2B (audit) — clés de catalogue propres (constructor, toString, __proto__) n'héritent pas du prototype", () => {
  for (const key of ["constructor", "toString", "__proto__"]) {
    const attributes = JSON.parse(JSON.stringify({ [key]: "yes" }));
    const offer = baseOffer({ attributes });
    const demand = baseDemand({
      category: null,
      brand: null,
      model: null,
      variant: null,
      budget: null,
      quantity: null,
      unit: null,
      condition: null,
      location: null,
      deadlineAt: null,
      attributes,
      requirements: null,
      preferences: null,
    });

    const evalRes = evaluateOfflineMatching(offer, demand, { now: fixedNow });
    const scoreRes = computeMatchingScore(evalRes, { now: fixedNow });

    assert.equal(scoreRes.contributions[`attributes.${key}`].weight, 1);
    assert.equal(scoreRes.score, 100);
    assert.ok(Number.isFinite(scoreRes.summary.totalApplicableWeight));
  }
});

test("lot 2B (audit) — regroupement de sous-totaux finis ne produit pas de débordement de couverture", () => {
  const oa: Record<string, string> = {};
  const da: Record<string, string> = {};
  const weights: Record<string, number> = { model: Number.MAX_VALUE };
  for (let i = 0; i < 20; i++) {
    oa["a" + i] = "red";
    da["a" + i] = "blue";
    weights["a" + i] = 1e291;
  }

  const offer = baseOffer({
    category: null,
    brand: null,
    model: "iPhone 12",
    variant: null,
    attributes: oa,
  });
  const demand = baseDemand({
    category: null,
    brand: null,
    model: "iPhone 12",
    variant: null,
    budget: null,
    quantity: null,
    unit: null,
    condition: null,
    location: null,
    deadlineAt: null,
    attributes: da,
    requirements: null,
    preferences: null,
  });

  const evalRes = evaluateOfflineMatching(offer, demand, { now: fixedNow });
  const scoreRes = computeMatchingScore(evalRes, { weights, now: fixedNow });

  assert.ok(Number.isFinite(scoreRes.coverage));
  assert.equal(scoreRes.coverage, 100);
  assert.ok(scoreRes.score !== null && scoreRes.score < 100);
});

test("lot 2B (audit) — poids explicites pour clés propres spéciales (constructor, toString, __proto__) respectés", () => {
  for (const key of ["constructor", "toString", "__proto__"]) {
    const attributes = JSON.parse(JSON.stringify({ [key]: "yes" }));
    const weights = JSON.parse(JSON.stringify({ [key]: 2 }));
    const offer = baseOffer({
      category: null,
      brand: null,
      model: null,
      variant: null,
      attributes,
    });
    const demand = baseDemand({
      category: null,
      brand: null,
      model: null,
      variant: null,
      budget: null,
      quantity: null,
      unit: null,
      condition: null,
      location: null,
      deadlineAt: null,
      attributes,
      requirements: null,
      preferences: null,
    });

    const evalRes = evaluateOfflineMatching(offer, demand, { now: fixedNow });
    const scoreRes = computeMatchingScore(evalRes, { weights, now: fixedNow });

    assert.equal(scoreRes.contributions[`attributes.${key}`].weight, 2);
    assert.equal(scoreRes.score, 100);
    assert.ok(Number.isFinite(scoreRes.summary.totalApplicableWeight));
  }
});

test("lot 2B (audit) — poids sous-normaux et ratios extrêmes préservent des bornes finies", () => {
  for (const weights of [
    { model: Number.MIN_VALUE, brand: Number.MIN_VALUE },
    { model: 1e308, brand: Number.MIN_VALUE },
  ]) {
    const offer = baseOffer({
      category: null,
      brand: null,
      model: "iPhone 12",
      variant: null,
      attributes: null,
    });
    const demand = baseDemand({
      category: null,
      brand: "Apple",
      model: "iPhone 12",
      variant: null,
      budget: null,
      quantity: null,
      unit: null,
      condition: null,
      location: null,
      deadlineAt: null,
      attributes: null,
      requirements: null,
      preferences: null,
    });

    const evalRes = evaluateOfflineMatching(offer, demand, { now: fixedNow });
    const scoreRes = computeMatchingScore(evalRes, { weights, now: fixedNow });

    assert.ok(scoreRes.score !== null && scoreRes.score >= 0 && scoreRes.score < 100);
    assert.ok(scoreRes.coverage !== null && scoreRes.coverage >= 0 && scoreRes.coverage < 100);
    assert.ok(Number.isFinite(scoreRes.summary.totalApplicableWeight));
  }
});


