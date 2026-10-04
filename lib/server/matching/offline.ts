import type { DemandRecord, OfferRecord } from "../catalog/types";
import { accentNormalize } from "../../../poc/lib/need";
import {
  MATCHING_OFFLINE_CONTRACT_VERSION,
  type AvailabilityFacts,
  type CompatibilitySummary,
  type CriterionEvaluation,
  type EligibilityReasonCode,
  type MatchingCompatibilityStatus,
  type MatchingEligibilityStatus,
  type MatchingEvaluationResult,
  type OfflineMatchingOptions,
  type PreferenceEvaluation,
} from "./types";

const CONDITION_RANKS: Record<string, number> = {
  "sous blister": 5,
  scelle: 5,
  neuf: 5,
  new: 5,
  "comme neuf": 4,
  "casi neuf": 4,
  "quasi neuf": 4,
  like_new: 4,
  "tres bon etat": 3,
  very_good: 3,
  "bon etat": 2,
  good: 2,
  "etat correct": 1,
  fair: 1,
  pour_pieces: 0,
  poor: 0,
};

const ABIDJAN_INTRA = new Set([
  "abidjan", "cocody", "yopougon", "marcory", "treichville", "adjame",
  "plateau", "koumassi", "port bouet", "riviera", "angre",
]);

const KNOWN_CITIES = new Set([
  "abidjan", "bouake", "yamoussoukro", "san pedro", "daloa",
  "korhogo", "man", "gagnoa", "abengourou", "dabou", "agboville",
]);

const DEMAND_TO_OFFER_ATTRIBUTE_KEYS: Record<string, string> = {
  chargeur: "charger_included",
  charger_included: "charger_included",
  garantie: "warranty_mentioned",
  warranty_mentioned: "warranty_mentioned",
  troc: "barter_accepted",
  troc_possible: "barter_accepted",
  barter_accepted: "barter_accepted",
};

function normalizeUnit(unit: string | null | undefined): string | null {
  if (!unit) return null;
  const n = accentNormalize(unit);
  if (n === "go" || n === "gb" || n === "gigas") return "go";
  if (n === "to" || n === "tb") return "to";
  if (n === "po" || n === "pouces" || n === "in" || n === "″" || n === '"') return "pouces";
  if (n === "w" || n === "watts" || n === "watt") return "w";
  if (n === "btu") return "btu";
  if (n === "cv" || n === "ch" || n === "chevaux") return "cv";
  if (n === "l" || n === "litres" || n === "litre") return "l";
  if (n === "m" || n === "metres" || n === "metre") return "m";
  if (n === "cm" || n === "centimetres" || n === "centimetre") return "cm";
  if (n === "kg" || n === "kilos" || n === "kilo" || n === "kilogrammes") return "kg";
  if (n === "places" || n === "place") return "places";
  return n;
}

/**
 * Déplie un attribut catalogue.
 * Si la valeur est un objet avec `.value`, on utilise `.value` et `.unit`.
 * Si `.unit` est présent mais n'est ni null ni string → résultat invalide
 * (signalé par `malformed: true`) pour que l'appelant émette UNKNOWN.
 * Si la valeur (scalaire ou enveloppée) est une chaîne vide ou uniquement
 * composée d'espaces, elle est signalée comme `isBlank: true` avec `value: null`.
 */
function unpackAttribute(val: unknown): {
  value: unknown;
  unit: string | null;
  malformed?: true;
  isBlank?: true;
} {
  if (val === null || val === undefined) {
    return { value: null, unit: null };
  }
  if (typeof val === "object" && !Array.isArray(val) && "value" in val) {
    const obj = val as Record<string, unknown>;
    // unit doit être absent, null ou une chaîne — sinon la valeur est mal formée.
    if ("unit" in obj && obj.unit !== null && obj.unit !== undefined && typeof obj.unit !== "string") {
      return { value: null, unit: null, malformed: true };
    }
    const unit = typeof obj.unit === "string" ? obj.unit : null;
    const innerVal = obj.value;
    if (typeof innerVal === "string" && innerVal.trim() === "") {
      return { value: null, unit, isBlank: true };
    }
    return { value: innerVal, unit };
  }
  if (typeof val === "string" && val.trim() === "") {
    return { value: null, unit: null, isBlank: true };
  }
  return { value: val, unit: null };
}

function locationSegments(loc: string): string[] {
  return loc.split(/[,;\/-]+/).map((s) => accentNormalize(s)).filter(Boolean);
}

interface EvaluatedCriterionOutput {
  status: "matched" | "mismatched" | "unknown";
  code: string;
  message: string;
  observedValue: unknown;
}

/**
 * Logique partagée entre exigences et préférences pour évaluer un critère explicite.
 *
 * Matrice de comparaisons supportées :
 *   operator=equals   × boolean  × boolean  → matched/mismatched
 *   operator=equals   × number   × number   → matched/mismatched  (sans unité des deux côtés)
 *   operator=equals   × string   × string   → matched/mismatched  (normalisation accent/casse)
 *   operator=includes × canonique booléen × correspondance connue → matched / BOOLEAN_INSUFFICIENT_FOR_SPECIFIC_VALUE
 *   operator=excludes × canonique booléen × correspondance connue → matched / BOOLEAN_INSUFFICIENT_FOR_SPECIFIC_VALUE
 *   operator=includes × string   × string   (expNorm non vide)    → matched/mismatched
 *   operator=excludes × string   × string   (expNorm non vide)    → matched/mismatched
 *   Toute combinaison non supportée → unknown
 *
 * Invariants :
 *   - Aucun Number(x) générique : un booléen n'est pas un nombre.
 *   - Une chaîne vide ou d'espaces n'est pas une valeur exploitable.
 *   - Une unité présente dans le critère (propriété `unit`) → unknown.
 *   - Un attribut offre à unité non-string → unknown (unité mal formée).
 *   - La valeur null ou objet sur l'offre → OFFER_VALUE_UNKNOWN (pas mismatched).
 */
function evaluateExplicitCriterion(
  rawItem: unknown,
  offerAttributes: Record<string, unknown> | null,
): EvaluatedCriterionOutput {
  if (!rawItem || typeof rawItem !== "object" || Array.isArray(rawItem)) {
    return {
      status: "unknown",
      code: "CRITERION_MALFORMED",
      message: "Critère explicite mal formé (doit être un objet non null).",
      observedValue: null,
    };
  }

  const reqObj = rawItem as Record<string, unknown>;
  const key = typeof reqObj.key === "string" ? reqObj.key.trim() : "";
  if (!key) {
    return {
      status: "unknown",
      code: "CRITERION_MALFORMED",
      message: "Clé de critère manquante ou invalide.",
      observedValue: null,
    };
  }

  const operator = reqObj.operator;
  if (operator !== "includes" && operator !== "excludes" && operator !== "equals") {
    return {
      status: "unknown",
      code: "CRITERION_INVALID_OPERATOR",
      message: `Opérateur absent ou non supporté ('${String(operator)}').`,
      observedValue: null,
    };
  }

  // Propriétés autorisées : key, operator, value. Toute propriété supplémentaire rend le critère unknown.
  const ALLOWED_CRITERION_PROPERTIES = new Set(["key", "operator", "value"]);
  const extraProperties = Object.keys(reqObj).filter(
    (prop) => !ALLOWED_CRITERION_PROPERTIES.has(prop) && reqObj[prop] !== undefined,
  );
  if (extraProperties.length > 0) {
    if (extraProperties.includes("unit")) {
      return {
        status: "unknown",
        code: "CRITERION_UNIT_NOT_SUPPORTED",
        message: "La propriété 'unit' dans un critère n'est pas supportée dans cette version du contrat.",
        observedValue: null,
      };
    }
    return {
      status: "unknown",
      code: "CRITERION_UNSUPPORTED_PROPERTY",
      message: `Propriété(s) de critère non supportée(s) : ${extraProperties.join(", ")}.`,
      observedValue: null,
    };
  }

  const expectedValue = reqObj.value;
  // Chaîne vide ou uniquement espaces : non exploitable.
  if (typeof expectedValue === "string" && expectedValue.trim() === "") {
    return {
      status: "unknown",
      code: "CRITERION_INVALID_VALUE",
      message: "Valeur demandée vide ou composée d'espaces.",
      observedValue: null,
    };
  }
  if (
    expectedValue === null ||
    expectedValue === undefined ||
    typeof expectedValue === "object" ||
    (typeof expectedValue !== "string" &&
      typeof expectedValue !== "number" &&
      typeof expectedValue !== "boolean")
  ) {
    return {
      status: "unknown",
      code: "CRITERION_INVALID_VALUE",
      message: "Valeur demandée absente, nulle ou de type non supporté (objet/structure).",
      observedValue: null,
    };
  }

  if (!offerAttributes || typeof offerAttributes !== "object" || Array.isArray(offerAttributes)) {
    return {
      status: "unknown",
      code: "OFFER_ATTRIBUTE_MISSING",
      message: `Caractéristique '${key}' absente des attributs de l'offre.`,
      observedValue: null,
    };
  }

  const resolvedKey =
    key in offerAttributes
      ? key
      : DEMAND_TO_OFFER_ATTRIBUTE_KEYS[key] &&
          DEMAND_TO_OFFER_ATTRIBUTE_KEYS[key] in offerAttributes
        ? DEMAND_TO_OFFER_ATTRIBUTE_KEYS[key]
        : null;

  if (!resolvedKey) {
    return {
      status: "unknown",
      code: "OFFER_ATTRIBUTE_MISSING",
      message: `Caractéristique '${key}' non trouvée dans l'offre.`,
      observedValue: null,
    };
  }

  const rawOfferEntry = offerAttributes[resolvedKey];
  if (rawOfferEntry === null || rawOfferEntry === undefined) {
    return {
      status: "unknown",
      code: "OFFER_VALUE_UNKNOWN",
      message: `Information sur '${key}' nulle ou indéterminée sur l'offre.`,
      observedValue: null,
    };
  }

  const unpacked = unpackAttribute(rawOfferEntry);

  // Unité mal formée sur l'attribut offre (ex: unit: { name: "kg" } au lieu de string).
  if (unpacked.malformed) {
    return {
      status: "unknown",
      code: "OFFER_ATTRIBUTE_UNIT_MALFORMED",
      message: `L'unité de l'attribut '${key}' sur l'offre n'est pas une chaîne valide.`,
      observedValue: rawOfferEntry,
    };
  }

  if (unpacked.isBlank || unpacked.value === null || unpacked.value === undefined) {
    return {
      status: "unknown",
      code: "OFFER_VALUE_UNKNOWN",
      message: `Valeur observée nulle ou vide pour '${key}'.`,
      observedValue: rawOfferEntry,
    };
  }

  const oVal = unpacked.value;
  const oUnit = unpacked.unit;

  if (typeof oVal === "string" && oVal.trim() === "") {
    return {
      status: "unknown",
      code: "OFFER_VALUE_UNKNOWN",
      message: `Valeur observée vide pour '${key}'.`,
      observedValue: rawOfferEntry,
    };
  }

  if (typeof oVal === "object") {
    return {
      status: "unknown",
      code: "OFFER_VALUE_UNSUPPORTED",
      message: `Valeur observée pour '${key}' est un objet non supporté.`,
      observedValue: oVal,
    };
  }

  // Si l'attribut de l'offre a une unité dimensionnelle mais que la demande ne la spécifie pas
  if (oUnit !== null && oUnit !== undefined && oUnit.trim()) {
    return {
      status: "unknown",
      code: "UNIT_INCOMPARABLE",
      message: `L'attribut de l'offre possède une unité dimensionnelle ('${oUnit}') non vérifiable dans la demande.`,
      observedValue: rawOfferEntry,
    };
  }

  // ── Cas booléen ──────────────────────────────────────────────────────────
  if (typeof oVal === "boolean") {
    // 1. Déterminer si la comparaison est supportée AVANT d'examiner la valeur booléenne observée.
    if (typeof expectedValue === "number") {
      return {
        status: "unknown",
        code: "TYPE_INCOMPARABLE",
        message: "Comparaison impossible entre booléen et nombre.",
        observedValue: oVal,
      };
    }

    if (operator === "includes") {
      if (typeof expectedValue === "boolean") {
        const match = expectedValue === true ? oVal === true : oVal === false;
        return {
          status: match ? "matched" : "mismatched",
          code: match ? "REQUIREMENT_SATISFIED" : "REQUIREMENT_CONTRADICTED",
          message: match ? "Valeur booléenne identique." : "Valeur booléenne opposée.",
          observedValue: oVal,
        };
      }

      if (typeof expectedValue === "string") {
        const isCanonicalFlagMatch =
          (resolvedKey === "charger_included" &&
            (accentNormalize(expectedValue) === "chargeur" || accentNormalize(expectedValue) === "avec chargeur")) ||
          (resolvedKey === "warranty_mentioned" &&
            (accentNormalize(expectedValue) === "garantie" || accentNormalize(expectedValue) === "avec garantie")) ||
          (resolvedKey === "barter_accepted" &&
            (accentNormalize(expectedValue) === "troc" || accentNormalize(expectedValue) === "troc possible"));

        if (!isCanonicalFlagMatch) {
          // Un indicateur booléen ne prouve ni n'invalide une spécification détaillée ou non canonique
          return {
            status: "unknown",
            code: "BOOLEAN_INSUFFICIENT_FOR_SPECIFIC_VALUE",
            message: `Un indicateur booléen ne prouve pas une spécification détaillée ('${String(expectedValue)}').`,
            observedValue: oVal,
          };
        }

        // Correspondance canonique connue : true confirme, false contredit (« chargeur demandé, chargeur absent »)
        if (oVal === true) {
          return {
            status: "matched",
            code: "REQUIREMENT_SATISFIED",
            message: `Exigence '${key}' confirmée par l'offre.`,
            observedValue: oVal,
          };
        } else {
          return {
            status: "mismatched",
            code: "REQUIREMENT_CONTRADICTED",
            message: `Exigence '${key}' contredite par l'offre (valeur false).`,
            observedValue: oVal,
          };
        }
      }

      return {
        status: "unknown",
        code: "TYPE_UNSUPPORTED",
        message: "Type non supporté pour includes sur booléen.",
        observedValue: oVal,
      };
    } else if (operator === "excludes") {
      if (typeof expectedValue === "boolean") {
        const excluded = oVal !== expectedValue;
        return {
          status: excluded ? "matched" : "mismatched",
          code: excluded ? "EXCLUSION_RESPECTED" : "EXCLUSION_VIOLATED",
          message: excluded ? "Exclusion booléenne respectée." : "Exclusion booléenne violée.",
          observedValue: oVal,
        };
      }

      if (typeof expectedValue === "string") {
        const isCanonicalExcludeMatch =
          (resolvedKey === "charger_included" &&
            (accentNormalize(expectedValue) === "chargeur" || accentNormalize(expectedValue) === "avec chargeur")) ||
          (resolvedKey === "warranty_mentioned" &&
            (accentNormalize(expectedValue) === "garantie" || accentNormalize(expectedValue) === "avec garantie")) ||
          (resolvedKey === "barter_accepted" &&
            (accentNormalize(expectedValue) === "troc" || accentNormalize(expectedValue) === "troc possible"));

        if (!isCanonicalExcludeMatch) {
          return {
            status: "unknown",
            code: "BOOLEAN_INSUFFICIENT_FOR_SPECIFIC_VALUE",
            message: `Un indicateur booléen ne peut exclure une valeur spécifique ('${String(expectedValue)}').`,
            observedValue: oVal,
          };
        }

        // false = trait absent = exclusion respectée ; true = trait présent = exclusion violée
        const excluded = oVal === false;
        return {
          status: excluded ? "matched" : "mismatched",
          code: excluded ? "EXCLUSION_RESPECTED" : "EXCLUSION_VIOLATED",
          message: excluded ? `Exclusion '${key}' respectée par l'offre.` : `Critère exclu '${key}' présent sur l'offre.`,
          observedValue: oVal,
        };
      }

      return {
        status: "unknown",
        code: "TYPE_UNSUPPORTED",
        message: "Type non supporté pour excludes sur booléen.",
        observedValue: oVal,
      };
    } else {
      // equals
      if (typeof expectedValue === "boolean") {
        const eq = oVal === expectedValue;
        return {
          status: eq ? "matched" : "mismatched",
          code: eq ? "REQUIREMENT_SATISFIED" : "REQUIREMENT_CONTRADICTED",
          message: eq ? "Valeur booléenne identique." : "Valeur booléenne différente.",
          observedValue: oVal,
        };
      }
      return {
        status: "unknown",
        code: "TYPE_INCOMPARABLE",
        message: `Comparaison 'equals' impossible entre booléen et ${typeof expectedValue}.`,
        observedValue: oVal,
      };
    }
  }

  // ── Cas numérique ─────────────────────────────────────────────────────────
  // Aucune conversion Number() générique : seul typeof expectedValue === "number" est accepté.
  if (typeof oVal === "number") {
    if (typeof expectedValue !== "number") {
      return {
        status: "unknown",
        code: "TYPE_INCOMPARABLE",
        message: `Comparaison numérique impossible : la valeur demandée (${typeof expectedValue}) n'est pas un nombre.`,
        observedValue: oVal,
      };
    }
    const eq = Math.abs(oVal - expectedValue) < 1e-9;
    if (operator === "equals" || operator === "includes") {
      return {
        status: eq ? "matched" : "mismatched",
        code: eq ? "REQUIREMENT_SATISFIED" : "REQUIREMENT_CONTRADICTED",
        message: eq
          ? `Valeur numérique identique (${oVal}).`
          : `Valeur numérique différente (${oVal} vs ${expectedValue}).`,
        observedValue: oVal,
      };
    } else {
      return {
        status: !eq ? "matched" : "mismatched",
        code: !eq ? "EXCLUSION_RESPECTED" : "EXCLUSION_VIOLATED",
        message: !eq
          ? "Valeur numérique exclue absente de l'offre."
          : "Valeur numérique exclue présente dans l'offre.",
        observedValue: oVal,
      };
    }
  }

  // ── Cas textuel ───────────────────────────────────────────────────────────
  if (typeof oVal === "string") {
    if (typeof expectedValue !== "string") {
      return {
        status: "unknown",
        code: "TYPE_INCOMPARABLE",
        message: "Comparaison textuelle impossible avec une valeur non textuelle.",
        observedValue: oVal,
      };
    }
    const oNorm = accentNormalize(oVal);
    const expNorm = accentNormalize(expectedValue);
    // Valeur attendue normalisée vide : non exploitable (déjà filtrée avant mais par sécurité).
    if (expNorm === "") {
      return {
        status: "unknown",
        code: "CRITERION_INVALID_VALUE",
        message: "Valeur textuelle demandée vide après normalisation.",
        observedValue: oVal,
      };
    }
    if (operator === "equals") {
      const eq = oNorm === expNorm;
      return {
        status: eq ? "matched" : "mismatched",
        code: eq ? "REQUIREMENT_SATISFIED" : "REQUIREMENT_CONTRADICTED",
        message: eq ? "Valeur textuelle identique." : "Valeur textuelle différente.",
        observedValue: oVal,
      };
    } else {
      // includes / excludes sur du texte libre : le contexte (négations, qualification) ne peut
      // pas être interprété sans NLP. Retourner unknown pour éviter les faux matchs.
      // Exemple : "sans garantie".includes("garantie") serait techniquement vrai mais faux
      // sémantiquement. Ce contrat n'implémente pas d'analyseur de négation.
      return {
        status: "unknown",
        code: "TEXT_FREE_UNINTERPRETABLE",
        message: "Correspondance textuelle libre non supportée sans analyseur sémantique.",
        observedValue: oVal,
      };
    }
  }

  return {
    status: "unknown",
    code: "TYPE_UNSUPPORTED",
    message: `Type de valeur non supporté (${typeof oVal}).`,
    observedValue: oVal,
  };
}



/**
 * Fonction pure évaluant une offre structurée par rapport à une demande structurée.
 * Contrat versionné, déterministe et sans effet de bord.
 */
export function evaluateOfflineMatching(
  offer: Readonly<OfferRecord>,
  demand: Readonly<DemandRecord>,
  options: OfflineMatchingOptions = {},
): MatchingEvaluationResult {
  const now = options.now ?? new Date();

  // 1. Éligibilité
  const eligibilityReasons: EligibilityReasonCode[] = [];
  if (offer.status !== "published") {
    eligibilityReasons.push("offer_not_published");
  }
  if (demand.status !== "active") {
    eligibilityReasons.push("demand_not_active");
  }
  if (offer.ownerId === demand.ownerId) {
    eligibilityReasons.push("same_owner");
  }
  if (offer.availabilityStatus === "unavailable") {
    eligibilityReasons.push("offer_unavailable");
  }

  const eligibilityStatus: MatchingEligibilityStatus =
    eligibilityReasons.length === 0 ? "eligible" : "ineligible";

  // 2. Disponibilité
  const availability: AvailabilityFacts = {
    status: offer.availabilityStatus ?? "unknown",
    confirmedAt: offer.availabilityConfirmedAt ? new Date(offer.availabilityConfirmedAt) : null,
    quantity: offer.quantity ?? null,
    unit: offer.unit ?? null,
    isAvailable: offer.availabilityStatus === "available",
  };

  // 3. Critères de compatibilité
  const criteria: Record<string, CriterionEvaluation> = {};

  // Catégorie
  if (demand.category && demand.category.trim()) {
    if (offer.category && offer.category.trim()) {
      const match = accentNormalize(offer.category) === accentNormalize(demand.category);
      criteria.category = {
        name: "category",
        status: match ? "matched" : "mismatched",
        offerValue: offer.category,
        demandValue: demand.category,
        code: match ? "CATEGORY_MATCH" : "CATEGORY_MISMATCH",
        message: match ? "Catégorie identique." : "Catégorie différente.",
      };
    } else {
      criteria.category = {
        name: "category",
        status: "unknown",
        offerValue: null,
        demandValue: demand.category,
        code: "OFFER_CATEGORY_MISSING",
        message: "Catégorie non spécifiée sur l'offre.",
      };
    }
  } else {
    criteria.category = {
      name: "category",
      status: "not_applicable",
      offerValue: offer.category ?? null,
      demandValue: null,
      code: "DEMAND_CATEGORY_NOT_SPECIFIED",
      message: "Aucune catégorie requise par la demande.",
    };
  }

  // Marque
  if (demand.brand && demand.brand.trim()) {
    if (offer.brand && offer.brand.trim()) {
      const match = accentNormalize(offer.brand) === accentNormalize(demand.brand);
      criteria.brand = {
        name: "brand",
        status: match ? "matched" : "mismatched",
        offerValue: offer.brand,
        demandValue: demand.brand,
        code: match ? "BRAND_MATCH" : "BRAND_MISMATCH",
        message: match ? "Marque identique." : "Marque différente.",
      };
    } else {
      criteria.brand = {
        name: "brand",
        status: "unknown",
        offerValue: null,
        demandValue: demand.brand,
        code: "OFFER_BRAND_MISSING",
        message: "Marque non spécifiée sur l'offre.",
      };
    }
  } else {
    criteria.brand = {
      name: "brand",
      status: "not_applicable",
      offerValue: offer.brand ?? null,
      demandValue: null,
      code: "DEMAND_BRAND_NOT_SPECIFIED",
      message: "Aucune marque requise par la demande.",
    };
  }

  // Modèle
  if (demand.model && demand.model.trim()) {
    if (offer.model && offer.model.trim()) {
      const match = accentNormalize(offer.model) === accentNormalize(demand.model);
      criteria.model = {
        name: "model",
        status: match ? "matched" : "mismatched",
        offerValue: offer.model,
        demandValue: demand.model,
        code: match ? "MODEL_MATCH" : "MODEL_MISMATCH",
        message: match ? "Modèle identique." : "Modèle différent.",
      };
    } else {
      criteria.model = {
        name: "model",
        status: "unknown",
        offerValue: null,
        demandValue: demand.model,
        code: "OFFER_MODEL_MISSING",
        message: "Modèle non spécifié sur l'offre.",
      };
    }
  } else {
    criteria.model = {
      name: "model",
      status: "not_applicable",
      offerValue: offer.model ?? null,
      demandValue: null,
      code: "DEMAND_MODEL_NOT_SPECIFIED",
      message: "Aucun modèle requis par la demande.",
    };
  }

  // Variante (comparaison exacte sans sac de mots destructeur)
  if (demand.variant && demand.variant.trim()) {
    if (offer.variant && offer.variant.trim()) {
      const match = accentNormalize(offer.variant) === accentNormalize(demand.variant);
      criteria.variant = {
        name: "variant",
        status: match ? "matched" : "mismatched",
        offerValue: offer.variant,
        demandValue: demand.variant,
        code: match ? "VARIANT_MATCH" : "VARIANT_MISMATCH",
        message: match ? "Variante identique." : "Variante différente.",
      };
    } else {
      criteria.variant = {
        name: "variant",
        status: "unknown",
        offerValue: null,
        demandValue: demand.variant,
        code: "OFFER_VARIANT_MISSING",
        message: "Variante non spécifiée sur l'offre.",
      };
    }
  } else {
    criteria.variant = {
      name: "variant",
      status: "not_applicable",
      offerValue: offer.variant ?? null,
      demandValue: null,
      code: "DEMAND_VARIANT_NOT_SPECIFIED",
      message: "Aucune variante requise par la demande.",
    };
  }

  // Prix vs Budget
  if (demand.budget !== null && demand.budget !== undefined) {
    if (offer.price !== null && offer.price !== undefined) {
      const dCur = (demand.budget.currency ?? "").trim().toUpperCase();
      const oCur = (offer.price.currency ?? "").trim().toUpperCase();

      if (
        !dCur ||
        !oCur ||
        dCur !== oCur ||
        typeof offer.price.amount !== "number" ||
        !Number.isFinite(offer.price.amount) ||
        typeof demand.budget.amount !== "number" ||
        !Number.isFinite(demand.budget.amount)
      ) {
        criteria.price_vs_budget = {
          name: "price_vs_budget",
          status: "unknown",
          offerValue: offer.price,
          demandValue: demand.budget,
          code: "CURRENCY_INCOMPARABLE",
          message: "Devises différentes ou montants incomparables ; aucune conversion implicite.",
        };
      } else if (offer.price.amount <= demand.budget.amount) {
        criteria.price_vs_budget = {
          name: "price_vs_budget",
          status: "matched",
          offerValue: offer.price,
          demandValue: demand.budget,
          code: "PRICE_WITHIN_BUDGET",
          message: `Prix de ${offer.price.amount} ${oCur} respecte le budget max de ${demand.budget.amount} ${dCur}.`,
        };
      } else {
        criteria.price_vs_budget = {
          name: "price_vs_budget",
          status: "mismatched",
          offerValue: offer.price,
          demandValue: demand.budget,
          code: "PRICE_EXCEEDS_BUDGET",
          message: `Prix de ${offer.price.amount} ${oCur} dépasse le budget max de ${demand.budget.amount} ${dCur}.`,
        };
      }
    } else {
      criteria.price_vs_budget = {
        name: "price_vs_budget",
        status: "unknown",
        offerValue: null,
        demandValue: demand.budget,
        code: "OFFER_PRICE_MISSING",
        message: "Prix non affiché sur l'offre.",
      };
    }
  } else {
    criteria.price_vs_budget = {
      name: "price_vs_budget",
      status: "not_applicable",
      offerValue: offer.price ?? null,
      demandValue: null,
      code: "DEMAND_BUDGET_NOT_SPECIFIED",
      message: "Aucun budget spécifié dans la demande.",
    };
  }

  // Quantité et Unité
  if (demand.quantity !== null && demand.quantity !== undefined) {
    if (offer.quantity !== null && offer.quantity !== undefined) {
      const dUnit = normalizeUnit(demand.unit);
      const oUnit = normalizeUnit(offer.unit);

      const unitsIncomparable =
        (dUnit !== null && oUnit === null) ||
        (dUnit === null && oUnit !== null) ||
        (dUnit !== null && oUnit !== null && dUnit !== oUnit);

      if (unitsIncomparable) {
        criteria.quantity = {
          name: "quantity",
          status: "unknown",
          offerValue: { quantity: offer.quantity, unit: offer.unit },
          demandValue: { quantity: demand.quantity, unit: demand.unit },
          code: "QUANTITY_UNIT_INCOMPARABLE",
          message: "Unités de quantité incomparables ou manquantes d'un côté ; aucune conversion implicite.",
        };
      } else if (offer.quantity >= demand.quantity) {
        criteria.quantity = {
          name: "quantity",
          status: "matched",
          offerValue: { quantity: offer.quantity, unit: offer.unit },
          demandValue: { quantity: demand.quantity, unit: demand.unit },
          code: "QUANTITY_SUFFICIENT",
          message: `Quantité offerte (${offer.quantity}) suffisante pour la demande (${demand.quantity}).`,
        };
      } else {
        criteria.quantity = {
          name: "quantity",
          status: "mismatched",
          offerValue: { quantity: offer.quantity, unit: offer.unit },
          demandValue: { quantity: demand.quantity, unit: demand.unit },
          code: "QUANTITY_INSUFFICIENT",
          message: `Quantité offerte (${offer.quantity}) insuffisante pour la demande (${demand.quantity}).`,
        };
      }
    } else {
      criteria.quantity = {
        name: "quantity",
        status: "unknown",
        offerValue: null,
        demandValue: { quantity: demand.quantity, unit: demand.unit },
        code: "OFFER_QUANTITY_MISSING",
        message: "Quantité non renseignée sur l'offre.",
      };
    }
  } else {
    criteria.quantity = {
      name: "quantity",
      status: "not_applicable",
      offerValue: { quantity: offer.quantity, unit: offer.unit },
      demandValue: null,
      code: "DEMAND_QUANTITY_NOT_SPECIFIED",
      message: "Aucune quantité requise par la demande.",
    };
  }

  // État / Condition
  if (demand.condition && demand.condition.trim()) {
    if (offer.condition && offer.condition.trim()) {
      const dNorm = accentNormalize(demand.condition);
      const oNorm = accentNormalize(offer.condition);
      const dRank = CONDITION_RANKS[dNorm];
      const oRank = CONDITION_RANKS[oNorm];

      if (dRank !== undefined && oRank !== undefined) {
        if (oRank >= dRank) {
          criteria.condition = {
            name: "condition",
            status: "matched",
            offerValue: offer.condition,
            demandValue: demand.condition,
            code: "CONDITION_SATISFIED",
            message: `État de l'offre (${offer.condition}) satisfait ou dépasse l'exigence (${demand.condition}).`,
          };
        } else {
          criteria.condition = {
            name: "condition",
            status: "mismatched",
            offerValue: offer.condition,
            demandValue: demand.condition,
            code: "CONDITION_INFERIOR",
            message: `État de l'offre (${offer.condition}) inférieur à l'exigence (${demand.condition}).`,
          };
        }
      } else if (dNorm === oNorm) {
        criteria.condition = {
          name: "condition",
          status: "matched",
          offerValue: offer.condition,
          demandValue: demand.condition,
          code: "CONDITION_EXACT_MATCH",
          message: "État textuel identique.",
        };
      } else {
        criteria.condition = {
          name: "condition",
          status: "unknown",
          offerValue: offer.condition,
          demandValue: demand.condition,
          code: "CONDITION_INCOMPARABLE",
          message: "État non standardisé et non comparable sans sémantique inventée.",
        };
      }
    } else {
      criteria.condition = {
        name: "condition",
        status: "unknown",
        offerValue: null,
        demandValue: demand.condition,
        code: "OFFER_CONDITION_MISSING",
        message: "État non renseigné sur l'offre.",
      };
    }
  } else {
    criteria.condition = {
      name: "condition",
      status: "not_applicable",
      offerValue: offer.condition ?? null,
      demandValue: null,
      code: "DEMAND_CONDITION_NOT_SPECIFIED",
      message: "Aucun état requis par la demande.",
    };
  }

  // Localisation (relations établies uniquement ; aucune sous-chaîne arbitraire)
  if (demand.location && demand.location.trim()) {
    if (offer.location && offer.location.trim()) {
      const dNorm = accentNormalize(demand.location);
      const oNorm = accentNormalize(offer.location);
      const oSegments = locationSegments(offer.location);

      if (dNorm === oNorm) {
        criteria.location = {
          name: "location",
          status: "matched",
          offerValue: offer.location,
          demandValue: demand.location,
          code: "LOCATION_EXACT_MATCH",
          message: "Localisation identique.",
        };
      } else if (oSegments.some((s) => s === dNorm)) {
        criteria.location = {
          name: "location",
          status: "matched",
          offerValue: offer.location,
          demandValue: demand.location,
          code: "LOCATION_CONTAINED",
          message: `L'adresse de l'offre comporte explicitement le segment '${dNorm}'.`,
        };
      } else if (dNorm === "abidjan" && oSegments.some((s) => ABIDJAN_INTRA.has(s))) {
        criteria.location = {
          name: "location",
          status: "matched",
          offerValue: offer.location,
          demandValue: demand.location,
          code: "LOCATION_CONTAINED",
          message: "L'offre est située dans une commune d'Abidjan.",
        };
      } else if (ABIDJAN_INTRA.has(dNorm) && oNorm === "abidjan") {
        criteria.location = {
          name: "location",
          status: "unknown",
          offerValue: offer.location,
          demandValue: demand.location,
          code: "LOCATION_IMPRECISE",
          message: `L'offre indique Abidjan sans préciser la commune demandée '${dNorm}'.`,
        };
      } else if (
        ABIDJAN_INTRA.has(dNorm) &&
        dNorm !== "abidjan" &&
        oSegments.some((s) => ABIDJAN_INTRA.has(s) && s !== "abidjan" && s !== dNorm)
      ) {
        criteria.location = {
          name: "location",
          status: "mismatched",
          offerValue: offer.location,
          demandValue: demand.location,
          code: "LOCATION_MISMATCH",
          message: "Communes d'Abidjan distinctes.",
        };
      } else if (
        KNOWN_CITIES.has(dNorm) &&
        KNOWN_CITIES.has(oNorm) &&
        dNorm !== oNorm
      ) {
        criteria.location = {
          name: "location",
          status: "mismatched",
          offerValue: offer.location,
          demandValue: demand.location,
          code: "LOCATION_MISMATCH",
          message: `Villes différentes (${oNorm} vs ${dNorm}).`,
        };
      } else {
        criteria.location = {
          name: "location",
          status: "unknown",
          offerValue: offer.location,
          demandValue: demand.location,
          code: "LOCATION_UNKNOWN",
          message: "Localisations sans relation géographique formellement établie ; aucune géographie inventée.",
        };
      }
    } else {
      criteria.location = {
        name: "location",
        status: "unknown",
        offerValue: null,
        demandValue: demand.location,
        code: "OFFER_LOCATION_MISSING",
        message: "Localisation non renseignée sur l'offre.",
      };
    }
  } else {
    criteria.location = {
      name: "location",
      status: "not_applicable",
      offerValue: offer.location ?? null,
      demandValue: null,
      code: "DEMAND_LOCATION_NOT_SPECIFIED",
      message: "Aucune localisation requise par la demande.",
    };
  }

  // Délai / Échéance (obligation temporelle prouvée ; absence ou délai insuffisant = unknown)
  if (demand.deadlineAt !== null && demand.deadlineAt !== undefined) {
    const dDate = new Date(demand.deadlineAt);
    if (Number.isNaN(dDate.getTime())) {
      criteria.deadline = {
        name: "deadline",
        status: "unknown",
        offerValue: offer.deadlineAt ?? null,
        demandValue: demand.deadlineAt,
        code: "DEMAND_DEADLINE_INVALID",
        message: "Échéance de la demande invalide.",
      };
    } else if (dDate.getTime() < now.getTime()) {
      criteria.deadline = {
        name: "deadline",
        status: "mismatched",
        offerValue: offer.deadlineAt ?? null,
        demandValue: demand.deadlineAt,
        code: "DEMAND_EXPIRED",
        message: "La date limite de la demande est déjà échue.",
      };
    } else if (offer.deadlineAt !== null && offer.deadlineAt !== undefined) {
      const oDate = new Date(offer.deadlineAt);
      if (Number.isNaN(oDate.getTime())) {
        criteria.deadline = {
          name: "deadline",
          status: "unknown",
          offerValue: offer.deadlineAt,
          demandValue: demand.deadlineAt,
          code: "OFFER_DEADLINE_INVALID",
          message: "Échéance de l'offre invalide.",
        };
      } else if (oDate.getTime() < now.getTime()) {
        criteria.deadline = {
          name: "deadline",
          status: "mismatched",
          offerValue: offer.deadlineAt,
          demandValue: demand.deadlineAt,
          code: "OFFER_EXPIRED",
          message: "L'offre est échue.",
        };
      } else {
        // deadlineAt ne distingue pas expiration et engagement de livraison.
        // Comparer deux dates futures par <= ne suffit jamais à confirmer le délai demandé.
        // Que l'offre soit antérieure ou postérieure à la demande, la sémantique manque.
        criteria.deadline = {
          name: "deadline",
          status: "unknown",
          offerValue: offer.deadlineAt,
          demandValue: demand.deadlineAt,
          code: "DEADLINE_SEMANTICS_INSUFFICIENT",
          message: "deadlineAt ne distingue pas expiration et engagement de livraison ; comparaison de dates insuffisante.",
        };
      }
    } else {
      criteria.deadline = {
        name: "deadline",
        status: "unknown",
        offerValue: null,
        demandValue: demand.deadlineAt,
        code: "OFFER_DEADLINE_MISSING",
        message: "L'offre ne précise pas d'échéance garantissant le respect de la date demandée.",
      };
    }
  } else if (offer.deadlineAt !== null && offer.deadlineAt !== undefined) {
    const oDate = new Date(offer.deadlineAt);
    if (!Number.isNaN(oDate.getTime()) && oDate.getTime() < now.getTime()) {
      criteria.deadline = {
        name: "deadline",
        status: "mismatched",
        offerValue: offer.deadlineAt,
        demandValue: null,
        code: "OFFER_EXPIRED",
        message: "L'offre a expiré.",
      };
    } else {
      criteria.deadline = {
        name: "deadline",
        status: "not_applicable",
        offerValue: offer.deadlineAt,
        demandValue: null,
        code: "DEMAND_DEADLINE_NOT_SPECIFIED",
        message: "Aucune échéance requise par la demande.",
      };
    }
  } else {
    criteria.deadline = {
      name: "deadline",
      status: "not_applicable",
      offerValue: null,
      demandValue: null,
      code: "DEMAND_DEADLINE_NOT_SPECIFIED",
      message: "Aucune échéance requise par la demande.",
    };
  }

  // Caractéristiques (`attributes`)
  if (demand.attributes && typeof demand.attributes === "object" && !Array.isArray(demand.attributes)) {
    const demandKeys = Object.keys(demand.attributes);
    for (const key of demandKeys) {
      const dAttr = unpackAttribute(demand.attributes[key]);
      const critName = `attributes.${key}`;

      if (dAttr.malformed) {
        criteria[critName] = {
          name: critName,
          status: "unknown",
          offerValue: offer.attributes ? (offer.attributes as Record<string, unknown>)[key] : null,
          demandValue: demand.attributes[key],
          code: "DEMAND_ATTRIBUTE_MALFORMED",
          message: `Enveloppe d'attribut mal formée dans la demande pour '${key}'.`,
        };
        continue;
      }

      if (dAttr.isBlank || dAttr.value === null || dAttr.value === undefined) {
        criteria[critName] = {
          name: critName,
          status: "unknown",
          offerValue: offer.attributes ? (offer.attributes as Record<string, unknown>)[key] : null,
          demandValue: demand.attributes[key],
          code: "DEMAND_ATTRIBUTE_NULL",
          message: `Caractéristique '${key}' vide ou sans valeur valide dans la demande.`,
        };
        continue;
      }

      if (
        !offer.attributes ||
        typeof offer.attributes !== "object" ||
        Array.isArray(offer.attributes) ||
        !(key in offer.attributes)
      ) {
        criteria[critName] = {
          name: critName,
          status: "unknown",
          offerValue: null,
          demandValue: demand.attributes[key],
          code: "OFFER_ATTRIBUTE_MISSING",
          message: `Caractéristique '${key}' absente de l'offre.`,
        };
        continue;
      }

      const oRaw = (offer.attributes as Record<string, unknown>)[key];
      if (oRaw === null || oRaw === undefined) {
        criteria[critName] = {
          name: critName,
          status: "unknown",
          offerValue: null,
          demandValue: demand.attributes[key],
          code: "OFFER_ATTRIBUTE_MISSING",
          message: `Caractéristique '${key}' nulle sur l'offre.`,
        };
        continue;
      }

      const oAttr = unpackAttribute(oRaw);
      if (oAttr.malformed) {
        criteria[critName] = {
          name: critName,
          status: "unknown",
          offerValue: oRaw,
          demandValue: demand.attributes[key],
          code: "OFFER_ATTRIBUTE_UNIT_MALFORMED",
          message: `Unité mal formée pour '${key}' sur l'offre.`,
        };
        continue;
      }

      if (oAttr.isBlank || oAttr.value === null || oAttr.value === undefined) {
        criteria[critName] = {
          name: critName,
          status: "unknown",
          offerValue: oRaw,
          demandValue: demand.attributes[key],
          code: "OFFER_ATTRIBUTE_MISSING",
          message: `Valeur de caractéristique '${key}' nulle ou vide sur l'offre.`,
        };
        continue;
      }

      const dUnitNorm = normalizeUnit(dAttr.unit);
      const oUnitNorm = normalizeUnit(oAttr.unit);

      const unitsIncomparable =
        (dUnitNorm !== null && oUnitNorm === null) ||
        (dUnitNorm === null && oUnitNorm !== null) ||
        (dUnitNorm !== null && oUnitNorm !== null && dUnitNorm !== oUnitNorm);

      if (unitsIncomparable) {
        criteria[critName] = {
          name: critName,
          status: "unknown",
          offerValue: (offer.attributes as Record<string, unknown>)[key],
          demandValue: demand.attributes[key],
          code: "ATTRIBUTE_UNIT_INCOMPARABLE",
          message: `Unités incomparables pour la caractéristique '${key}'.`,
        };
      } else if (typeof dAttr.value === "number" && typeof oAttr.value === "number") {
        const match = Math.abs(dAttr.value - oAttr.value) < 1e-9;
        criteria[critName] = {
          name: critName,
          status: match ? "matched" : "mismatched",
          offerValue: (offer.attributes as Record<string, unknown>)[key],
          demandValue: demand.attributes[key],
          code: match ? "ATTRIBUTE_MATCH" : "ATTRIBUTE_MISMATCH",
          message: match
            ? `Valeur numérique identique pour '${key}'.`
            : `Valeur différente pour '${key}' (${oAttr.value} vs ${dAttr.value}).`,
        };
      } else if (typeof dAttr.value === "string" && typeof oAttr.value === "string") {
        const match = accentNormalize(dAttr.value) === accentNormalize(oAttr.value);
        criteria[critName] = {
          name: critName,
          status: match ? "matched" : "mismatched",
          offerValue: (offer.attributes as Record<string, unknown>)[key],
          demandValue: demand.attributes[key],
          code: match ? "ATTRIBUTE_MATCH" : "ATTRIBUTE_MISMATCH",
          message: match
            ? `Valeur textuelle identique pour '${key}'.`
            : `Valeur différente pour '${key}'.`,
        };
      } else if (typeof dAttr.value === "boolean" && typeof oAttr.value === "boolean") {
        const match = dAttr.value === oAttr.value;
        criteria[critName] = {
          name: critName,
          status: match ? "matched" : "mismatched",
          offerValue: (offer.attributes as Record<string, unknown>)[key],
          demandValue: demand.attributes[key],
          code: match ? "ATTRIBUTE_MATCH" : "ATTRIBUTE_MISMATCH",
          message: match
            ? `Valeur booléenne identique pour '${key}'.`
            : `Valeur booléenne opposée pour '${key}'.`,
        };
      } else {
        criteria[critName] = {
          name: critName,
          status: "unknown",
          offerValue: (offer.attributes as Record<string, unknown>)[key],
          demandValue: demand.attributes[key],
          code: "ATTRIBUTE_TYPE_INCOMPARABLE",
          message: `Types incompatibles pour la caractéristique '${key}'.`,
        };
      }
    }
  }

  // Critères explicites obligatoires (`requirements`)
  if (Array.isArray(demand.requirements) && demand.requirements.length > 0) {
    demand.requirements.forEach((reqItem, index) => {
      const critName = `requirements.${index}`;
      const evalRes = evaluateExplicitCriterion(
        reqItem,
        offer.attributes as Record<string, unknown> | null,
      );
      criteria[critName] = {
        name: critName,
        status: evalRes.status,
        offerValue: evalRes.observedValue,
        demandValue: reqItem,
        code: evalRes.code,
        message: evalRes.message,
      };
    });
  }

  // 4. Préférences séparées
  const preferences: PreferenceEvaluation[] = [];
  if (Array.isArray(demand.preferences)) {
    demand.preferences.forEach((prefItem, index) => {
      const prefName = `preferences.${index}`;
      const evalRes = evaluateExplicitCriterion(
        prefItem,
        offer.attributes as Record<string, unknown> | null,
      );
      const prefObj = prefItem && typeof prefItem === "object" ? (prefItem as Record<string, unknown>) : {};
      preferences.push({
        name: prefName,
        status: evalRes.status,
        operator: typeof prefObj.operator === "string" ? prefObj.operator : undefined,
        targetValue: prefObj.value,
        observedValue: evalRes.observedValue,
        code: evalRes.code,
        message: evalRes.message,
      });
    });
  }

  // 5. Synthèse de compatibilité
  const applicableCriteria = Object.values(criteria).filter(
    (c) => c.status !== "not_applicable",
  );
  const matchedCount = applicableCriteria.filter((c) => c.status === "matched").length;
  const mismatchedCount = applicableCriteria.filter((c) => c.status === "mismatched").length;
  const unknownCount = applicableCriteria.filter((c) => c.status === "unknown").length;
  const totalExploitableCriteria = applicableCriteria.length;

  let compatibilityStatus: MatchingCompatibilityStatus;
  if (totalExploitableCriteria === 0) {
    compatibilityStatus = "unknown";
  } else if (mismatchedCount > 0) {
    compatibilityStatus = "incompatible";
  } else if (unknownCount > 0) {
    compatibilityStatus = "unknown";
  } else {
    compatibilityStatus = "compatible";
  }

  const summary: CompatibilitySummary = {
    matchedCount,
    mismatchedCount,
    unknownCount,
    totalExploitableCriteria,
  };

  return {
    contractVersion: MATCHING_OFFLINE_CONTRACT_VERSION,
    evaluatedAt: now,
    offer: {
      id: offer.id,
      contentVersion: offer.contentVersion,
      status: offer.status,
      ownerId: offer.ownerId,
    },
    demand: {
      id: demand.id,
      contentVersion: demand.contentVersion,
      status: demand.status,
      ownerId: demand.ownerId,
    },
    eligibility: {
      status: eligibilityStatus,
      reasons: eligibilityReasons,
    },
    compatibility: {
      status: compatibilityStatus,
      criteria,
      summary,
    },
    preferences,
    availability,
    marketPrice: {
      status: "unknown",
      reason: "insufficient_data",
    },
    confidence: {
      status: "unknown",
      reason: "insufficient_data",
    },
  };
}
