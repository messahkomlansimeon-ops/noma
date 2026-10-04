import assert from "node:assert/strict";
import test from "node:test";
import type { DemandRecord, JsonObject, OfferRecord } from "../../lib/server/catalog/types";
import { evaluateOfflineMatching } from "../../lib/server/matching/offline";
import { MATCHING_OFFLINE_CONTRACT_VERSION } from "../../lib/server/matching/types";
import { extractCatalogProposal } from "../../lib/server/catalog-extraction/service";

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
    contentVersion: 2,
    rawText: "iPhone 12 Pro 128 Go 200 000 FCFA Cocody avec chargeur bon état",
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
    location: "Abidjan, Cocody",
    deadlineAt: new Date("2026-12-31T23:59:59.000Z"),
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

test("lot 2A — contrat versionné, métadonnées et horloge injectée", () => {
  const offer = baseOffer();
  const demand = baseDemand();

  const res = evaluateOfflineMatching(offer, demand, { now: fixedNow });

  assert.equal(res.contractVersion, MATCHING_OFFLINE_CONTRACT_VERSION);
  assert.equal(res.evaluatedAt.toISOString(), fixedNow.toISOString());
  assert.equal(res.offer.id, offer.id);
  assert.equal(res.offer.contentVersion, offer.contentVersion);
  assert.equal(res.offer.status, "published");
  assert.equal(res.offer.ownerId, offer.ownerId);

  assert.equal(res.demand.id, demand.id);
  assert.equal(res.demand.contentVersion, demand.contentVersion);
  assert.equal(res.demand.status, "active");
  assert.equal(res.demand.ownerId, demand.ownerId);

  assert.deepEqual(res.marketPrice, { status: "unknown", reason: "insufficient_data" });
  assert.deepEqual(res.confidence, { status: "unknown", reason: "insufficient_data" });
});

test("lot 2A — éligibilité et faits de disponibilité", () => {
  const offer = baseOffer();
  const demand = baseDemand();
  const resEligible = evaluateOfflineMatching(offer, demand, { now: fixedNow });
  assert.equal(resEligible.eligibility.status, "eligible");
  assert.deepEqual(resEligible.eligibility.reasons, []);
  assert.equal(resEligible.availability.isAvailable, true);
  assert.equal(resEligible.availability.status, "available");
  assert.equal(resEligible.availability.quantity, 1);
  assert.equal(resEligible.availability.unit, "pièce");
  assert.ok(resEligible.availability.confirmedAt instanceof Date);

  // Rejet offre draft
  const resDraftOffer = evaluateOfflineMatching(baseOffer({ status: "draft" }), demand, { now: fixedNow });
  assert.equal(resDraftOffer.eligibility.status, "ineligible");
  assert.ok(resDraftOffer.eligibility.reasons.includes("offer_not_published"));

  // Rejet offre paused
  const resPausedOffer = evaluateOfflineMatching(baseOffer({ status: "paused" }), demand, { now: fixedNow });
  assert.equal(resPausedOffer.eligibility.status, "ineligible");
  assert.ok(resPausedOffer.eligibility.reasons.includes("offer_not_published"));

  // Rejet demande draft
  const resDraftDemand = evaluateOfflineMatching(offer, baseDemand({ status: "draft" }), { now: fixedNow });
  assert.equal(resDraftDemand.eligibility.status, "ineligible");
  assert.ok(resDraftDemand.eligibility.reasons.includes("demand_not_active"));

  // Rejet demande satisfied
  const resSatisfiedDemand = evaluateOfflineMatching(offer, baseDemand({ status: "satisfied" }), { now: fixedNow });
  assert.equal(resSatisfiedDemand.eligibility.status, "ineligible");
  assert.ok(resSatisfiedDemand.eligibility.reasons.includes("demand_not_active"));

  // Rejet même propriétaire
  const resSameOwner = evaluateOfflineMatching(offer, baseDemand({ ownerId: offer.ownerId }), { now: fixedNow });
  assert.equal(resSameOwner.eligibility.status, "ineligible");
  assert.ok(resSameOwner.eligibility.reasons.includes("same_owner"));

  // Rejet offre indisponible
  const resUnavailableOffer = evaluateOfflineMatching(
    baseOffer({ availabilityStatus: "unavailable" }),
    demand,
    { now: fixedNow },
  );
  assert.equal(resUnavailableOffer.eligibility.status, "ineligible");
  assert.ok(resUnavailableOffer.eligibility.reasons.includes("offer_unavailable"));
  assert.equal(resUnavailableOffer.availability.isAvailable, false);
  assert.equal(resUnavailableOffer.availability.status, "unavailable");

  // Cumul des motifs d'inéligibilité
  const resMultipleIneligibility = evaluateOfflineMatching(
    baseOffer({ status: "paused", availabilityStatus: "unavailable", ownerId: "same-user" }),
    baseDemand({ status: "draft", ownerId: "same-user" }),
    { now: fixedNow },
  );
  assert.equal(resMultipleIneligibility.eligibility.status, "ineligible");
  assert.ok(resMultipleIneligibility.eligibility.reasons.includes("offer_not_published"));
  assert.ok(resMultipleIneligibility.eligibility.reasons.includes("demand_not_active"));
  assert.ok(resMultipleIneligibility.eligibility.reasons.includes("same_owner"));
  assert.ok(resMultipleIneligibility.eligibility.reasons.includes("offer_unavailable"));
});

test("lot 2A — correspondance nominale parfaite (compatible)", () => {
  const offer = baseOffer();
  const demand = baseDemand();

  const res = evaluateOfflineMatching(offer, demand, { now: fixedNow });

  assert.equal(res.compatibility.status, "compatible");
  assert.equal(res.compatibility.summary.mismatchedCount, 0);
  assert.equal(res.compatibility.summary.unknownCount, 0);
  assert.ok(res.compatibility.summary.matchedCount > 0);
  assert.equal(
    res.compatibility.summary.totalExploitableCriteria,
    res.compatibility.summary.matchedCount,
  );

  assert.equal(res.compatibility.criteria.category.status, "matched");
  assert.equal(res.compatibility.criteria.brand.status, "matched");
  assert.equal(res.compatibility.criteria.model.status, "matched");
  assert.equal(res.compatibility.criteria.variant.status, "matched");
  assert.equal(res.compatibility.criteria.price_vs_budget.status, "matched");
  assert.equal(res.compatibility.criteria.quantity.status, "matched");
  assert.equal(res.compatibility.criteria.condition.status, "matched");
  assert.equal(res.compatibility.criteria.location.status, "matched");
  assert.equal(res.compatibility.criteria.deadline.status, "not_applicable");
  assert.equal(res.compatibility.criteria["attributes.storage_capacity"]?.status, "matched");
  assert.equal(res.compatibility.criteria["requirements.0"]?.status, "matched");
});

test("lot 2A — contradictions obligatoires (incompatible)", () => {
  // 1. Marque différente
  const resBrand = evaluateOfflineMatching(baseOffer({ brand: "Samsung" }), baseDemand(), { now: fixedNow });
  assert.equal(resBrand.compatibility.status, "incompatible");
  assert.equal(resBrand.compatibility.criteria.brand.status, "mismatched");
  assert.equal(resBrand.compatibility.criteria.brand.code, "BRAND_MISMATCH");

  // 2. Modèle différent
  const resModel = evaluateOfflineMatching(baseOffer({ model: "iPhone 11" }), baseDemand(), { now: fixedNow });
  assert.equal(resModel.compatibility.status, "incompatible");
  assert.equal(resModel.compatibility.criteria.model.status, "mismatched");
  assert.equal(resModel.compatibility.criteria.model.code, "MODEL_MISMATCH");

  // 3. Variante différente
  const resVariant = evaluateOfflineMatching(baseOffer({ variant: "Pro Max" }), baseDemand({ variant: "Mini" }), { now: fixedNow });
  assert.equal(resVariant.compatibility.status, "incompatible");
  assert.equal(resVariant.compatibility.criteria.variant.status, "mismatched");
  assert.equal(resVariant.compatibility.criteria.variant.code, "VARIANT_MISMATCH");

  // 4. Prix supérieur au budget
  const resPrice = evaluateOfflineMatching(
    baseOffer({ price: { amount: 300_000, currency: "XOF" } }),
    baseDemand({ budget: { amount: 250_000, currency: "XOF" } }),
    { now: fixedNow },
  );
  assert.equal(resPrice.compatibility.status, "incompatible");
  assert.equal(resPrice.compatibility.criteria.price_vs_budget.status, "mismatched");
  assert.equal(resPrice.compatibility.criteria.price_vs_budget.code, "PRICE_EXCEEDS_BUDGET");

  // 5. Quantité insuffisante
  const resQty = evaluateOfflineMatching(
    baseOffer({ quantity: 2 }),
    baseDemand({ quantity: 5 }),
    { now: fixedNow },
  );
  assert.equal(resQty.compatibility.status, "incompatible");
  assert.equal(resQty.compatibility.criteria.quantity.status, "mismatched");
  assert.equal(resQty.compatibility.criteria.quantity.code, "QUANTITY_INSUFFICIENT");

  // 6. État inférieur
  const resCond = evaluateOfflineMatching(
    baseOffer({ condition: "good" }),
    baseDemand({ condition: "new" }),
    { now: fixedNow },
  );
  assert.equal(resCond.compatibility.status, "incompatible");
  assert.equal(resCond.compatibility.criteria.condition.status, "mismatched");
  assert.equal(resCond.compatibility.criteria.condition.code, "CONDITION_INFERIOR");

  // 7. Localisation incompatible prouvée (Bouaké vs Abidjan)
  const resLoc = evaluateOfflineMatching(
    baseOffer({ location: "Bouaké" }),
    baseDemand({ location: "Abidjan" }),
    { now: fixedNow },
  );
  assert.equal(resLoc.compatibility.status, "incompatible");
  assert.equal(resLoc.compatibility.criteria.location.status, "mismatched");
  assert.equal(resLoc.compatibility.criteria.location.code, "LOCATION_MISMATCH");

  // 8. Échéance dépassée
  const resDeadlineDemand = evaluateOfflineMatching(
    baseOffer(),
    baseDemand({ deadlineAt: new Date("2026-10-01T00:00:00.000Z") }),
    { now: fixedNow },
  );
  assert.equal(resDeadlineDemand.compatibility.status, "incompatible");
  assert.equal(resDeadlineDemand.compatibility.criteria.deadline.status, "mismatched");
  assert.equal(resDeadlineDemand.compatibility.criteria.deadline.code, "DEMAND_EXPIRED");

  const resDeadlineOffer = evaluateOfflineMatching(
    baseOffer({ deadlineAt: new Date("2026-10-01T00:00:00.000Z") }),
    baseDemand(),
    { now: fixedNow },
  );
  assert.equal(resDeadlineOffer.compatibility.status, "incompatible");
  assert.equal(resDeadlineOffer.compatibility.criteria.deadline.status, "mismatched");
  assert.equal(resDeadlineOffer.compatibility.criteria.deadline.code, "OFFER_EXPIRED");

  // 9. Attribut chiffré différent
  const resAttr = evaluateOfflineMatching(
    baseOffer({ attributes: { storage_capacity: { value: 64, unit: "Go", sourceUnit: "Go" } } }),
    baseDemand({ attributes: { storage_capacity: { value: 128, unit: "Go", sourceUnit: "Go" } } }),
    { now: fixedNow },
  );
  assert.equal(resAttr.compatibility.status, "incompatible");
  assert.equal(resAttr.compatibility.criteria["attributes.storage_capacity"]?.status, "mismatched");
  assert.equal(resAttr.compatibility.criteria["attributes.storage_capacity"]?.code, "ATTRIBUTE_MISMATCH");

  // 10. Exigence contredite
  const resReq = evaluateOfflineMatching(
    baseOffer({ attributes: { charger_included: { value: false, unit: null, sourceUnit: null } } }),
    baseDemand({ requirements: [{ key: "chargeur", operator: "includes", value: "chargeur" }] }),
    { now: fixedNow },
  );
  assert.equal(resReq.compatibility.status, "incompatible");
  assert.equal(resReq.compatibility.criteria["requirements.0"]?.status, "mismatched");
  assert.equal(resReq.compatibility.criteria["requirements.0"]?.code, "REQUIREMENT_CONTRADICTED");

  // 11. Exclusion violée
  const resExcl = evaluateOfflineMatching(
    baseOffer({ attributes: { barter_accepted: { value: true, unit: null, sourceUnit: null } } }),
    baseDemand({ requirements: [{ key: "troc", operator: "excludes", value: "troc" }] }),
    { now: fixedNow },
  );
  assert.equal(resExcl.compatibility.status, "incompatible");
  assert.equal(resExcl.compatibility.criteria["requirements.0"]?.status, "mismatched");
  assert.equal(resExcl.compatibility.criteria["requirements.0"]?.code, "EXCLUSION_VIOLATED");
});

test("lot 2A — devises différentes : critère et statut inconnus sans conversion implicite", () => {
  const offer = baseOffer({ price: { amount: 300, currency: "EUR" } });
  const demand = baseDemand({ budget: { amount: 200_000, currency: "XOF" } });

  const res = evaluateOfflineMatching(offer, demand, { now: fixedNow });

  assert.equal(res.compatibility.criteria.price_vs_budget.status, "unknown");
  assert.equal(res.compatibility.criteria.price_vs_budget.code, "CURRENCY_INCOMPARABLE");
  assert.equal(res.compatibility.status, "unknown");
  assert.ok(res.compatibility.summary.unknownCount >= 1);
});

test("lot 2A — données manquantes sur l'offre empêchent la confirmation (unknown)", () => {
  // Marque absente sur l'offre
  const resNoBrand = evaluateOfflineMatching(baseOffer({ brand: null }), baseDemand(), { now: fixedNow });
  assert.equal(resNoBrand.compatibility.criteria.brand.status, "unknown");
  assert.equal(resNoBrand.compatibility.criteria.brand.code, "OFFER_BRAND_MISSING");
  assert.equal(resNoBrand.compatibility.status, "unknown");

  // Modèle absent sur l'offre
  const resNoModel = evaluateOfflineMatching(baseOffer({ model: null }), baseDemand(), { now: fixedNow });
  assert.equal(resNoModel.compatibility.criteria.model.status, "unknown");
  assert.equal(resNoModel.compatibility.criteria.model.code, "OFFER_MODEL_MISSING");
  assert.equal(resNoModel.compatibility.status, "unknown");

  // Prix absent sur l'offre
  const resNoPrice = evaluateOfflineMatching(baseOffer({ price: null }), baseDemand(), { now: fixedNow });
  assert.equal(resNoPrice.compatibility.criteria.price_vs_budget.status, "unknown");
  assert.equal(resNoPrice.compatibility.criteria.price_vs_budget.code, "OFFER_PRICE_MISSING");
  assert.equal(resNoPrice.compatibility.status, "unknown");

  // Attribut requis absent sur l'offre
  const resNoAttr = evaluateOfflineMatching(baseOffer({ attributes: null }), baseDemand(), { now: fixedNow });
  assert.equal(resNoAttr.compatibility.criteria["attributes.storage_capacity"]?.status, "unknown");
  assert.equal(resNoAttr.compatibility.criteria["attributes.storage_capacity"]?.code, "OFFER_ATTRIBUTE_MISSING");
  assert.equal(resNoAttr.compatibility.status, "unknown");

  // Exigence requise sans information sur l'offre
  const resNoReq = evaluateOfflineMatching(
    baseOffer({ attributes: { storage_capacity: { value: 128, unit: "Go" } } }),
    baseDemand({ requirements: [{ key: "warranty_mentioned", operator: "includes", value: "garantie" }] }),
    { now: fixedNow },
  );
  assert.equal(resNoReq.compatibility.criteria["requirements.0"]?.status, "unknown");
  assert.equal(resNoReq.compatibility.criteria["requirements.0"]?.code, "OFFER_ATTRIBUTE_MISSING");
  assert.equal(resNoReq.compatibility.status, "unknown");
});

test("lot 2A — demande sans critère exploitable produit unknown (jamais compatible)", () => {
  const emptyDemand: DemandRecord = {
    id: "00000000-0000-0000-0000-000000000099",
    ownerId: "22222222-2222-2222-2222-222222222222",
    status: "active",
    contentVersion: 1,
    rawText: "je cherche un truc",
    category: null,
    brand: null,
    model: null,
    variant: null,
    attributes: null,
    condition: null,
    quantity: null,
    unit: null,
    location: null,
    deadlineAt: null,
    budget: null,
    requirements: null,
    preferences: null,
    extractorVersion: null,
    extractionMetadata: null,
    extractedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    archivedAt: null,
  };

  const res = evaluateOfflineMatching(baseOffer(), emptyDemand, { now: fixedNow });
  assert.equal(res.compatibility.status, "unknown");
  assert.equal(res.compatibility.summary.totalExploitableCriteria, 0);
  assert.equal(res.compatibility.summary.matchedCount, 0);
  assert.equal(res.compatibility.summary.mismatchedCount, 0);
});

test("lot 2A — unités de quantité et d'attributs incomparables restent inconnues", () => {
  // Unités de quantité différentes : kg vs litres (aucune conversion inventée)
  const resUnits = evaluateOfflineMatching(
    baseOffer({ quantity: 10, unit: "litres" }),
    baseDemand({ quantity: 10, unit: "kg" }),
    { now: fixedNow },
  );
  assert.equal(resUnits.compatibility.criteria.quantity.status, "unknown");
  assert.equal(resUnits.compatibility.criteria.quantity.code, "QUANTITY_UNIT_INCOMPARABLE");
  assert.equal(resUnits.compatibility.status, "unknown");

  // Unité présente dans l'offre et absente dans la demande
  const resOneUnit = evaluateOfflineMatching(
    baseOffer({ quantity: 10, unit: "boîtes" }),
    baseDemand({ quantity: 10, unit: null }),
    { now: fixedNow },
  );
  assert.equal(resOneUnit.compatibility.criteria.quantity.status, "unknown");
  assert.equal(resOneUnit.compatibility.criteria.quantity.code, "QUANTITY_UNIT_INCOMPARABLE");

  // Unités d'attributs différentes : Watts vs Pouces
  const resAttrUnits = evaluateOfflineMatching(
    baseOffer({ attributes: { screen_size: { value: 55, unit: "W" } } }),
    baseDemand({ attributes: { screen_size: { value: 55, unit: "in" } } }),
    { now: fixedNow },
  );
  assert.equal(resAttrUnits.compatibility.criteria["attributes.screen_size"]?.status, "unknown");
  assert.equal(resAttrUnits.compatibility.criteria["attributes.screen_size"]?.code, "ATTRIBUTE_UNIT_INCOMPARABLE");

  // Unités équivalentes reconnues (in vs pouces, Go vs GB)
  const resAliasedUnits = evaluateOfflineMatching(
    baseOffer({ attributes: { storage_capacity: { value: 128, unit: "GB" } } }),
    baseDemand({ attributes: { storage_capacity: { value: 128, unit: "Go" } } }),
    { now: fixedNow },
  );
  assert.equal(resAliasedUnits.compatibility.criteria["attributes.storage_capacity"]?.status, "matched");
});

test("lot 2A — variantes : préservation de l'association nombres-labels (rejet des faux matchs)", () => {
  // Inversion des nombres et labels : doit être mismatched !
  const resInverted = evaluateOfflineMatching(
    baseOffer({ variant: "RAM 8 Go stockage 128 Go" }),
    baseDemand({ variant: "RAM 128 Go stockage 8 Go" }),
    { now: fixedNow },
  );
  assert.equal(resInverted.compatibility.criteria.variant.status, "mismatched");
  assert.equal(resInverted.compatibility.criteria.variant.code, "VARIANT_MISMATCH");

  // Témoin positif : variante strictement identique
  const resSame = evaluateOfflineMatching(
    baseOffer({ variant: "RAM 8 Go stockage 128 Go" }),
    baseDemand({ variant: "RAM 8 Go stockage 128 Go" }),
    { now: fixedNow },
  );
  assert.equal(resSame.compatibility.criteria.variant.status, "matched");
  assert.equal(resSame.compatibility.criteria.variant.code, "VARIANT_MATCH");

  // "Pro" vs "Pro Max" -> mismatch
  const resDifferent = evaluateOfflineMatching(
    baseOffer({ variant: "Pro" }),
    baseDemand({ variant: "Pro Max" }),
    { now: fixedNow },
  );
  assert.equal(resDifferent.compatibility.criteria.variant.status, "mismatched");
});

test("lot 2A — critères mal formés ou non supportés restent inconnus sans plantage", () => {
  const malformedDemand = baseDemand({
    requirements: [
      null as unknown as { key: string; operator: "includes"; value: string },
      { key: "custom_flag", operator: "unknown_op" as unknown as "includes", value: "x" },
      { key: "warranty", operator: "equals", value: {} as unknown as string },
      { key: "warranty", operator: "equals", value: null as unknown as string },
    ],
  });

  const res = evaluateOfflineMatching(baseOffer(), malformedDemand, { now: fixedNow });
  assert.equal(res.compatibility.criteria["requirements.0"]?.status, "unknown");
  assert.equal(res.compatibility.criteria["requirements.0"]?.code, "CRITERION_MALFORMED");

  assert.equal(res.compatibility.criteria["requirements.1"]?.status, "unknown");
  assert.equal(res.compatibility.criteria["requirements.1"]?.code, "CRITERION_INVALID_OPERATOR");

  assert.equal(res.compatibility.criteria["requirements.2"]?.status, "unknown");
  assert.equal(res.compatibility.criteria["requirements.2"]?.code, "CRITERION_INVALID_VALUE");

  assert.equal(res.compatibility.criteria["requirements.3"]?.status, "unknown");
  assert.equal(res.compatibility.criteria["requirements.3"]?.code, "CRITERION_INVALID_VALUE");
});

test("lot 2A — les préférences restent séparées et ne compensent jamais un refus", () => {
  // Cas 1 : Préférence non satisfaite mais toutes les obligations satisfaites -> compatible !
  const resPrefMismatched = evaluateOfflineMatching(
    baseOffer({
      attributes: {
        storage_capacity: { value: 128, unit: "Go" },
        charger_included: { value: true },
        color: { value: "bleu" },
      },
    }),
    baseDemand({
      preferences: [{ key: "color", operator: "equals", value: "noir" }],
    }),
    { now: fixedNow },
  );
  assert.equal(resPrefMismatched.preferences[0]?.status, "mismatched");
  assert.equal(resPrefMismatched.compatibility.status, "compatible");

  // Cas 2 : Préférence satisfaite mais obligation violée (hors budget) -> incompatible !
  const resPrefDoesNotCompensate = evaluateOfflineMatching(
    baseOffer({
      price: { amount: 400_000, currency: "XOF" },
      attributes: {
        storage_capacity: { value: 128, unit: "Go" },
        charger_included: { value: true },
        color: { value: "noir" },
      },
    }),
    baseDemand({
      budget: { amount: 200_000, currency: "XOF" },
      preferences: [{ key: "color", operator: "equals", value: "noir" }],
    }),
    { now: fixedNow },
  );
  assert.equal(resPrefDoesNotCompensate.preferences[0]?.status, "matched");
  assert.equal(resPrefDoesNotCompensate.compatibility.status, "incompatible");
});

test("lot 2A — absence de mutation des entrées (immuabilité stricte sous Object.freeze)", () => {
  const frozenOffer = deepFreeze(baseOffer());
  const frozenDemand = deepFreeze(baseDemand());
  const frozenOptions = deepFreeze({ now: fixedNow });

  const res = evaluateOfflineMatching(frozenOffer, frozenDemand, frozenOptions);

  assert.equal(res.compatibility.status, "compatible");
  assert.equal(frozenOffer.price?.amount, 200_000);
  assert.equal(frozenDemand.budget?.amount, 250_000);
});

test("lot 2A — hiérarchie d'état, inclusion géographique et quantités sans unité", () => {
  // 1. Hiérarchie d'état : offre "sous blister" (rank 5) vs demande "bon etat" (rank 2) -> compatible
  const resBetterCond = evaluateOfflineMatching(
    baseOffer({ condition: "sous blister" }),
    baseDemand({ condition: "bon etat" }),
    { now: fixedNow },
  );
  assert.equal(resBetterCond.compatibility.criteria.condition.status, "matched");
  assert.equal(resBetterCond.compatibility.criteria.condition.code, "CONDITION_SATISFIED");

  // Offre "tres bon etat" (rank 3) vs demande "comme neuf" (rank 4) -> incompatible
  const resWorseCond = evaluateOfflineMatching(
    baseOffer({ condition: "tres bon etat" }),
    baseDemand({ condition: "comme neuf" }),
    { now: fixedNow },
  );
  assert.equal(resWorseCond.compatibility.criteria.condition.status, "mismatched");
  assert.equal(resWorseCond.compatibility.criteria.condition.code, "CONDITION_INFERIOR");

  // État non standardisé identique textuellement -> matched
  const resCustomSame = evaluateOfflineMatching(
    baseOffer({ condition: "reconditionne a neuf" }),
    baseDemand({ condition: "reconditionné à neuf" }),
    { now: fixedNow },
  );
  assert.equal(resCustomSame.compatibility.criteria.condition.status, "matched");
  assert.equal(resCustomSame.compatibility.criteria.condition.code, "CONDITION_EXACT_MATCH");

  // État non standardisé différent -> unknown
  const resCustomDiff = evaluateOfflineMatching(
    baseOffer({ condition: "reconditionné" }),
    baseDemand({ condition: "impeccable" }),
    { now: fixedNow },
  );
  assert.equal(resCustomDiff.compatibility.criteria.condition.status, "unknown");
  assert.equal(resCustomDiff.compatibility.criteria.condition.code, "CONDITION_INCOMPARABLE");

  // 2. Géographie : commune demandée contenue comme segment dans l'adresse offre
  const resLocSubset = evaluateOfflineMatching(
    baseOffer({ location: "Abidjan, Cocody, Riviera 2" }),
    baseDemand({ location: "Cocody" }),
    { now: fixedNow },
  );
  assert.equal(resLocSubset.compatibility.criteria.location.status, "matched");
  assert.equal(resLocSubset.compatibility.criteria.location.code, "LOCATION_CONTAINED");

  // Rejet du faux match par sous-chaîne : "Mankono" n'est pas "Man" !
  const resSubstringFalseMatch = evaluateOfflineMatching(
    baseOffer({ location: "Mankono" }),
    baseDemand({ location: "Man" }),
    { now: fixedNow },
  );
  assert.equal(resSubstringFalseMatch.compatibility.criteria.location.status, "unknown");
  assert.equal(resSubstringFalseMatch.compatibility.criteria.location.code, "LOCATION_UNKNOWN");

  // Témoin positif : ville "Man" égale à "Man"
  const resManSame = evaluateOfflineMatching(
    baseOffer({ location: "Man" }),
    baseDemand({ location: "Man" }),
    { now: fixedNow },
  );
  assert.equal(resManSame.compatibility.criteria.location.status, "matched");
  assert.equal(resManSame.compatibility.criteria.location.code, "LOCATION_EXACT_MATCH");

  // Commune demandée alors que l'offre cite seulement la métropole sans précision
  const resLocBroad = evaluateOfflineMatching(
    baseOffer({ location: "Abidjan" }),
    baseDemand({ location: "Cocody" }),
    { now: fixedNow },
  );
  assert.equal(resLocBroad.compatibility.criteria.location.status, "unknown");
  assert.equal(resLocBroad.compatibility.criteria.location.code, "LOCATION_IMPRECISE");

  // 3. Quantités sans unité : offre >= demande -> matched
  const resQtyNoUnit = evaluateOfflineMatching(
    baseOffer({ quantity: 10, unit: null }),
    baseDemand({ quantity: 5, unit: null }),
    { now: fixedNow },
  );
  assert.equal(resQtyNoUnit.compatibility.criteria.quantity.status, "matched");
  assert.equal(resQtyNoUnit.compatibility.criteria.quantity.code, "QUANTITY_SUFFICIENT");

  // Quantités sans unité : offre < demande -> mismatched
  const resQtyShort = evaluateOfflineMatching(
    baseOffer({ quantity: 3, unit: null }),
    baseDemand({ quantity: 5, unit: null }),
    { now: fixedNow },
  );
  assert.equal(resQtyShort.compatibility.criteria.quantity.status, "mismatched");
  assert.equal(resQtyShort.compatibility.criteria.quantity.code, "QUANTITY_INSUFFICIENT");

  // 4. Prix égal au budget pile -> matched
  const resPriceEqual = evaluateOfflineMatching(
    baseOffer({ price: { amount: 250_000, currency: "XOF" } }),
    baseDemand({ budget: { amount: 250_000, currency: "XOF" } }),
    { now: fixedNow },
  );
  assert.equal(resPriceEqual.compatibility.criteria.price_vs_budget.status, "matched");
  assert.equal(resPriceEqual.compatibility.criteria.price_vs_budget.code, "PRICE_WITHIN_BUDGET");
});

test("lot 2A — sémantique temporelle : une date future ne prouve pas une obligation satisfaite", () => {
  const testNow = new Date("2032-01-01T00:00:00.000Z");
  const demandTarget = new Date("2032-01-10T00:00:00.000Z");

  // 1. Demande avec date limite, offre sans date -> unknown (pas de confirmation)
  const resNoOfferDate = evaluateOfflineMatching(
    baseOffer({ deadlineAt: null }),
    baseDemand({ deadlineAt: demandTarget }),
    { now: testNow },
  );
  assert.equal(resNoOfferDate.compatibility.criteria.deadline.status, "unknown");
  assert.equal(resNoOfferDate.compatibility.criteria.deadline.code, "OFFER_DEADLINE_MISSING");

  // 2. Offre avec date plus tardive (2032-03-01) -> unknown (délai insuffisant pour confirmer 2032-01-10)
  const resLaterOfferDate = evaluateOfflineMatching(
    baseOffer({ deadlineAt: new Date("2032-03-01T00:00:00.000Z") }),
    baseDemand({ deadlineAt: demandTarget }),
    { now: testNow },
  );
  assert.equal(resLaterOfferDate.compatibility.criteria.deadline.status, "unknown");
  assert.equal(resLaterOfferDate.compatibility.criteria.deadline.code, "DEADLINE_SEMANTICS_INSUFFICIENT");

  // 3. Offre avec date antérieure ou égale : deadlineAt ne prouve pas l'engagement de livraison -> unknown
  const resCompliantDate = evaluateOfflineMatching(
    baseOffer({ deadlineAt: new Date("2032-01-05T00:00:00.000Z") }),
    baseDemand({ deadlineAt: demandTarget }),
    { now: testNow },
  );
  assert.equal(resCompliantDate.compatibility.criteria.deadline.status, "unknown");
  assert.equal(resCompliantDate.compatibility.criteria.deadline.code, "DEADLINE_SEMANTICS_INSUFFICIENT");
});

test("lot 2A — contrat réel d'extraction et intégration avec extractCatalogProposal", async () => {
  function fieldsForCatalog(proposal: Awaited<ReturnType<typeof extractCatalogProposal>>) {
    const fields = { ...proposal.fields } as Record<string, unknown>;
    if (fields.attributes && Array.isArray(fields.attributes)) {
      fields.attributes = Object.fromEntries(
        (fields.attributes as Array<{ key: string; value: unknown; unit: string | null; sourceUnit: string | null }>).map(
          ({ key, value, unit, sourceUnit }) => [key, { value, unit, sourceUnit }],
        ),
      );
    }
    if (fields.deadlineAt && typeof fields.deadlineAt === "string") {
      fields.deadlineAt = new Date(fields.deadlineAt);
    }
    return fields;
  }

  // 1. avec chargeur
  const offerWithCharger = await extractCatalogProposal({ type: "offer", rawText: "iPhone 12 avec chargeur" });
  const demandWithCharger = await extractCatalogProposal({ type: "demand", rawText: "Cherche iPhone 12 avec chargeur" });
  const resWithCharger = evaluateOfflineMatching(
    baseOffer(fieldsForCatalog(offerWithCharger)),
    baseDemand(fieldsForCatalog(demandWithCharger)),
    { now: fixedNow },
  );
  assert.equal(resWithCharger.compatibility.criteria["requirements.0"]?.status, "matched");
  assert.equal(resWithCharger.compatibility.criteria["requirements.0"]?.code, "REQUIREMENT_SATISFIED");

  // 2. sans chargeur
  const offerWithoutCharger = await extractCatalogProposal({ type: "offer", rawText: "iPhone 12 sans chargeur" });
  const demandWithoutCharger = await extractCatalogProposal({ type: "demand", rawText: "Cherche iPhone 12 sans chargeur" });
  const resWithoutCharger = evaluateOfflineMatching(
    baseOffer(fieldsForCatalog(offerWithoutCharger)),
    baseDemand(fieldsForCatalog(demandWithoutCharger)),
    { now: fixedNow },
  );
  assert.equal(resWithoutCharger.compatibility.criteria["requirements.0"]?.status, "matched");
  assert.equal(resWithoutCharger.compatibility.criteria["requirements.0"]?.code, "EXCLUSION_RESPECTED");

  // 3. garantie
  const offerWarranty = await extractCatalogProposal({ type: "offer", rawText: "iPhone 12 garantie" });
  const demandWarranty = await extractCatalogProposal({ type: "demand", rawText: "Cherche iPhone 12 garantie" });
  const resWarranty = evaluateOfflineMatching(
    baseOffer(fieldsForCatalog(offerWarranty)),
    baseDemand(fieldsForCatalog(demandWarranty)),
    { now: fixedNow },
  );
  assert.equal(resWarranty.compatibility.criteria["requirements.0"]?.status, "matched");
  assert.equal(resWarranty.compatibility.criteria["requirements.0"]?.code, "REQUIREMENT_SATISFIED");

  // 4. Contradiction réelle : offre sans chargeur vs demande avec chargeur -> incompatible
  const resContradiction = evaluateOfflineMatching(
    baseOffer(fieldsForCatalog(offerWithoutCharger)),
    baseDemand(fieldsForCatalog(demandWithCharger)),
    { now: fixedNow },
  );
  assert.equal(resContradiction.compatibility.criteria["requirements.0"]?.status, "mismatched");
  assert.equal(resContradiction.compatibility.criteria["requirements.0"]?.code, "REQUIREMENT_CONTRADICTED");
  assert.equal(resContradiction.compatibility.status, "incompatible");

  // 5. Information absente : offre sans mention vs demande avec chargeur -> unknown
  const offerBare = await extractCatalogProposal({ type: "offer", rawText: "iPhone 12" });
  const resMissing = evaluateOfflineMatching(
    baseOffer(fieldsForCatalog(offerBare)),
    baseDemand(fieldsForCatalog(demandWithCharger)),
    { now: fixedNow },
  );
  assert.equal(resMissing.compatibility.criteria["requirements.0"]?.status, "unknown");
  assert.equal(resMissing.compatibility.criteria["requirements.0"]?.code, "OFFER_ATTRIBUTE_MISSING");
  assert.equal(resMissing.compatibility.status, "unknown");

  // 6. Booléen ne prouve pas une spécification de durée arbitraire ("garantie 12 mois")
  const resBoolNotDuration = evaluateOfflineMatching(
    baseOffer({ attributes: { warranty_mentioned: { value: true, unit: null, sourceUnit: null } } }),
    baseDemand({ requirements: [{ key: "warranty_mentioned", operator: "includes", value: "garantie 12 mois" }] }),
    { now: fixedNow },
  );
  assert.equal(resBoolNotDuration.compatibility.criteria["requirements.0"]?.status, "unknown");
  assert.equal(resBoolNotDuration.compatibility.criteria["requirements.0"]?.code, "BOOLEAN_INSUFFICIENT_FOR_SPECIFIC_VALUE");

  // 7. Unité dimensionnelle non ignorée
  const resDimUnit = evaluateOfflineMatching(
    baseOffer({ attributes: { storage_capacity: { value: 128, unit: "W", sourceUnit: "W" } } }),
    baseDemand({ requirements: [{ key: "storage_capacity", operator: "equals", value: "128" }] }),
    { now: fixedNow },
  );
  assert.equal(resDimUnit.compatibility.criteria["requirements.0"]?.status, "unknown");
  assert.equal(resDimUnit.compatibility.criteria["requirements.0"]?.code, "UNIT_INCOMPARABLE");
});

test("lot 2A — matrice complète des comparaisons supportées et des rejets stricts", () => {
  function evalReq(offerAttr: Record<string, unknown>, criterion: Record<string, unknown>) {
    return evaluateOfflineMatching(
      baseOffer({ attributes: offerAttr as unknown as JsonObject }),
      baseDemand({ requirements: [criterion as unknown as { key: string; operator: "includes"; value: string }] }),
      { now: fixedNow },
    );
  }

  // 1. Types différents -> TYPE_INCOMPARABLE
  const resBoolVsNum = evalReq({ val: 0 }, { key: "val", operator: "equals", value: false });
  assert.equal(resBoolVsNum.compatibility.criteria["requirements.0"]?.status, "unknown");
  assert.equal(resBoolVsNum.compatibility.criteria["requirements.0"]?.code, "TYPE_INCOMPARABLE");

  const resNumVsBool = evalReq({ val: true }, { key: "val", operator: "equals", value: 1 });
  assert.equal(resNumVsBool.compatibility.criteria["requirements.0"]?.status, "unknown");
  assert.equal(resNumVsBool.compatibility.criteria["requirements.0"]?.code, "TYPE_INCOMPARABLE");

  const resStrVsNum = evalReq({ val: 42 }, { key: "val", operator: "equals", value: "42" });
  assert.equal(resStrVsNum.compatibility.criteria["requirements.0"]?.status, "unknown");
  assert.equal(resStrVsNum.compatibility.criteria["requirements.0"]?.code, "TYPE_INCOMPARABLE");

  const resNumVsStr = evalReq({ val: "42" }, { key: "val", operator: "equals", value: 42 });
  assert.equal(resNumVsStr.compatibility.criteria["requirements.0"]?.status, "unknown");
  assert.equal(resNumVsStr.compatibility.criteria["requirements.0"]?.code, "TYPE_INCOMPARABLE");

  // 2. Chaînes vides ou espaces -> CRITERION_INVALID_VALUE
  const resEmptyStr = evalReq({ val: "hello" }, { key: "val", operator: "equals", value: "" });
  assert.equal(resEmptyStr.compatibility.criteria["requirements.0"]?.status, "unknown");
  assert.equal(resEmptyStr.compatibility.criteria["requirements.0"]?.code, "CRITERION_INVALID_VALUE");

  const resSpacesStr = evalReq({ val: "hello" }, { key: "val", operator: "includes", value: "   " });
  assert.equal(resSpacesStr.compatibility.criteria["requirements.0"]?.status, "unknown");
  assert.equal(resSpacesStr.compatibility.criteria["requirements.0"]?.code, "CRITERION_INVALID_VALUE");

  // 3. Propriété unit dans un critère -> CRITERION_UNIT_NOT_SUPPORTED
  const resCritUnit = evalReq({ val: 10 }, { key: "val", operator: "equals", value: 10, unit: "kg" });
  assert.equal(resCritUnit.compatibility.criteria["requirements.0"]?.status, "unknown");
  assert.equal(resCritUnit.compatibility.criteria["requirements.0"]?.code, "CRITERION_UNIT_NOT_SUPPORTED");

  // 4. Unité d'attribut mal formée -> OFFER_ATTRIBUTE_UNIT_MALFORMED
  const resMalformedUnit = evalReq({ val: { value: 10, unit: { complex: true } } }, { key: "val", operator: "equals", value: 10 });
  assert.equal(resMalformedUnit.compatibility.criteria["requirements.0"]?.status, "unknown");
  assert.equal(resMalformedUnit.compatibility.criteria["requirements.0"]?.code, "OFFER_ATTRIBUTE_UNIT_MALFORMED");

  // 5. Comparaisons numériques rigoureuses
  const resNumEqualsMatch = evalReq({ n: 10 }, { key: "n", operator: "equals", value: 10 });
  assert.equal(resNumEqualsMatch.compatibility.criteria["requirements.0"]?.status, "matched");

  const resNumEqualsMismatch = evalReq({ n: 10 }, { key: "n", operator: "equals", value: 20 });
  assert.equal(resNumEqualsMismatch.compatibility.criteria["requirements.0"]?.status, "mismatched");

  const resNumExcludesMatch = evalReq({ n: 10 }, { key: "n", operator: "excludes", value: 20 });
  assert.equal(resNumExcludesMatch.compatibility.criteria["requirements.0"]?.status, "matched");

  const resNumExcludesMismatch = evalReq({ n: 10 }, { key: "n", operator: "excludes", value: 10 });
  assert.equal(resNumExcludesMismatch.compatibility.criteria["requirements.0"]?.status, "mismatched");

  // 6. Comparaisons booléennes rigoureuses
  const resBoolEqualsMatch = evalReq({ b: false }, { key: "b", operator: "equals", value: false });
  assert.equal(resBoolEqualsMatch.compatibility.criteria["requirements.0"]?.status, "matched");

  const resBoolEqualsMismatch = evalReq({ b: true }, { key: "b", operator: "equals", value: false });
  assert.equal(resBoolEqualsMismatch.compatibility.criteria["requirements.0"]?.status, "mismatched");

  const resBoolExcludesMatch = evalReq({ b: false }, { key: "b", operator: "excludes", value: true });
  assert.equal(resBoolExcludesMatch.compatibility.criteria["requirements.0"]?.status, "matched");

  const resBoolExcludesMismatch = evalReq({ b: true }, { key: "b", operator: "excludes", value: true });
  assert.equal(resBoolExcludesMismatch.compatibility.criteria["requirements.0"]?.status, "mismatched");

  // 7. Comparaisons textuelles rigoureuses
  const resTextEqualsMatch = evalReq({ t: "Abidjan" }, { key: "t", operator: "equals", value: "abidjan" });
  assert.equal(resTextEqualsMatch.compatibility.criteria["requirements.0"]?.status, "matched");

  const resTextEqualsMismatch = evalReq({ t: "Abidjan" }, { key: "t", operator: "equals", value: "Bouaké" });
  assert.equal(resTextEqualsMismatch.compatibility.criteria["requirements.0"]?.status, "mismatched");

  // Texte libre includes/excludes non-exact -> TEXT_FREE_UNINTERPRETABLE (unknown)
  const resTextFreeIncludes = evalReq({ t: "sans garantie" }, { key: "t", operator: "includes", value: "garantie" });
  assert.equal(resTextFreeIncludes.compatibility.criteria["requirements.0"]?.status, "unknown");
  assert.equal(resTextFreeIncludes.compatibility.criteria["requirements.0"]?.code, "TEXT_FREE_UNINTERPRETABLE");

  const resTextFreeExcludes = evalReq({ t: "rouge et bleu" }, { key: "t", operator: "excludes", value: "rouge" });
  assert.equal(resTextFreeExcludes.compatibility.criteria["requirements.0"]?.status, "unknown");
  assert.equal(resTextFreeExcludes.compatibility.criteria["requirements.0"]?.code, "TEXT_FREE_UNINTERPRETABLE");

  // 8. Correspondances canoniques de l'extracteur (chargeur, garantie, troc)
  const resCanonChargerInc = evalReq({ charger_included: true }, { key: "chargeur", operator: "includes", value: "chargeur" });
  assert.equal(resCanonChargerInc.compatibility.criteria["requirements.0"]?.status, "matched");

  const resCanonChargerExc = evalReq({ charger_included: false }, { key: "chargeur", operator: "excludes", value: "chargeur" });
  assert.equal(resCanonChargerExc.compatibility.criteria["requirements.0"]?.status, "matched");

  const resCanonChargerExcViolated = evalReq({ charger_included: true }, { key: "chargeur", operator: "excludes", value: "chargeur" });
  assert.equal(resCanonChargerExcViolated.compatibility.criteria["requirements.0"]?.status, "mismatched");

  const resCanonWarrantySpecificExc = evalReq({ warranty_mentioned: true }, { key: "warranty_mentioned", operator: "excludes", value: "garantie 12 mois" });
  assert.equal(resCanonWarrantySpecificExc.compatibility.criteria["requirements.0"]?.status, "unknown");
  assert.equal(resCanonWarrantySpecificExc.compatibility.criteria["requirements.0"]?.code, "BOOLEAN_INSUFFICIENT_FOR_SPECIFIC_VALUE");
});

test("lot 2A — tests paramétrés : booléens true/false, chaînes vides, enveloppes et contraintes additionnelles", () => {
  // 1. Paramétré sur les deux valeurs booléennes pour types supportés et non supportés
  for (const observed of [true, false]) {
    // Non supporté : booléen vs nombre
    const rNum = evaluateOfflineMatching(
      baseOffer({ attributes: { feature: observed } as unknown as JsonObject }),
      baseDemand({ requirements: [{ key: "feature", operator: "includes", value: 42 }] }),
      { now: fixedNow },
    );
    assert.equal(rNum.compatibility.criteria["requirements.0"]?.status, "unknown");
    assert.equal(rNum.compatibility.criteria["requirements.0"]?.code, "TYPE_INCOMPARABLE");

    // Non supporté : booléen vs texte arbitraire non canonique
    const rText = evaluateOfflineMatching(
      baseOffer({ attributes: { feature: observed } as unknown as JsonObject }),
      baseDemand({ requirements: [{ key: "feature", operator: "includes", value: "valeur arbitraire" }] }),
      { now: fixedNow },
    );
    assert.equal(rText.compatibility.criteria["requirements.0"]?.status, "unknown");
    assert.equal(rText.compatibility.criteria["requirements.0"]?.code, "BOOLEAN_INSUFFICIENT_FOR_SPECIFIC_VALUE");

    // Supporté : correspondance canonique chargeur
    const rCharger = evaluateOfflineMatching(
      baseOffer({ attributes: { charger_included: observed } as unknown as JsonObject }),
      baseDemand({ requirements: [{ key: "chargeur", operator: "includes", value: "chargeur" }] }),
      { now: fixedNow },
    );
    assert.equal(rCharger.compatibility.criteria["requirements.0"]?.status, observed ? "matched" : "mismatched");

    // Supporté : correspondance canonique exclusion chargeur
    const rChargerExc = evaluateOfflineMatching(
      baseOffer({ attributes: { charger_included: observed } as unknown as JsonObject }),
      baseDemand({ requirements: [{ key: "chargeur", operator: "excludes", value: "chargeur" }] }),
      { now: fixedNow },
    );
    assert.equal(rChargerExc.compatibility.criteria["requirements.0"]?.status, observed ? "mismatched" : "matched");

    // Supporté : correspondance canonique garantie
    const rWarranty = evaluateOfflineMatching(
      baseOffer({ attributes: { warranty_mentioned: observed } as unknown as JsonObject }),
      baseDemand({ requirements: [{ key: "garantie", operator: "includes", value: "garantie" }] }),
      { now: fixedNow },
    );
    assert.equal(rWarranty.compatibility.criteria["requirements.0"]?.status, observed ? "matched" : "mismatched");

    // Supporté : correspondance canonique troc
    const rBarter = evaluateOfflineMatching(
      baseOffer({ attributes: { barter_accepted: observed } as unknown as JsonObject }),
      baseDemand({ requirements: [{ key: "troc", operator: "includes", value: "troc" }] }),
      { now: fixedNow },
    );
    assert.equal(rBarter.compatibility.criteria["requirements.0"]?.status, observed ? "matched" : "mismatched");
  }

  // 2. Chaînes vides ou espaces (scalaires et enveloppées, côté offre et demande)
  const blankVariants = ["", "   ", "\t  \n"];
  for (const blank of blankVariants) {
    // Attribut direct scalaire dans demand.attributes vs offer.attributes
    const rDirect = evaluateOfflineMatching(
      baseOffer({ attributes: { color: blank } as unknown as JsonObject }),
      baseDemand({ attributes: { color: blank } as unknown as JsonObject }),
      { now: fixedNow },
    );
    assert.equal(rDirect.compatibility.criteria["attributes.color"]?.status, "unknown");

    // Attribut direct enveloppé { value: blank, unit: ... }
    const rWrappedDemand = evaluateOfflineMatching(
      baseOffer({ attributes: { color: "bleu" } as unknown as JsonObject }),
      baseDemand({ attributes: { color: { value: blank, unit: null } } as unknown as JsonObject }),
      { now: fixedNow },
    );
    assert.equal(rWrappedDemand.compatibility.criteria["attributes.color"]?.status, "unknown");

    const rWrappedOffer = evaluateOfflineMatching(
      baseOffer({ attributes: { color: { value: blank, unit: null } } as unknown as JsonObject }),
      baseDemand({ attributes: { color: "bleu" } as unknown as JsonObject }),
      { now: fixedNow },
    );
    assert.equal(rWrappedOffer.compatibility.criteria["attributes.color"]?.status, "unknown");

    // Critère explicite avec valeur vide ou espaces
    const rCritBlank = evaluateOfflineMatching(
      baseOffer({ attributes: { color: "bleu" } as unknown as JsonObject }),
      baseDemand({ requirements: [{ key: "color", operator: "equals", value: blank }] }),
      { now: fixedNow },
    );
    assert.equal(rCritBlank.compatibility.criteria["requirements.0"]?.status, "unknown");
    assert.equal(rCritBlank.compatibility.criteria["requirements.0"]?.code, "CRITERION_INVALID_VALUE");
  }

  // 3. Propriétés de critères supplémentaires non supportées (requirements et preferences)
  const extraPropsList = [
    { minimumDurationMonths: 12 },
    { tolerance: 5 },
    { priority: "strict" },
    { customMetadata: { nested: true } },
  ];
  for (const extra of extraPropsList) {
    const criterionReq = { key: "garantie", operator: "includes", value: "garantie", ...extra };
    const rExtraReq = evaluateOfflineMatching(
      baseOffer({ attributes: { warranty_mentioned: true } as unknown as JsonObject }),
      baseDemand({ requirements: [criterionReq as unknown as { key: string; operator: "includes"; value: string }] }),
      { now: fixedNow },
    );
    assert.equal(rExtraReq.compatibility.criteria["requirements.0"]?.status, "unknown");
    assert.equal(rExtraReq.compatibility.criteria["requirements.0"]?.code, "CRITERION_UNSUPPORTED_PROPERTY");

    const rExtraPref = evaluateOfflineMatching(
      baseOffer({ attributes: { warranty_mentioned: true } as unknown as JsonObject }),
      baseDemand({ preferences: [criterionReq as unknown as { key: string; operator: "includes"; value: string }] }),
      { now: fixedNow },
    );
    assert.equal(rExtraPref.preferences[0]?.status, "unknown");
    assert.equal(rExtraPref.preferences[0]?.code, "CRITERION_UNSUPPORTED_PROPERTY");
  }
});


