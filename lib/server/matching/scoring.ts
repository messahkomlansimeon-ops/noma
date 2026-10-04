import type { MatchingEvaluationResult } from "./types";
import {
  MATCHING_SCORING_CONTRACT_VERSION,
  MatchingScoringValidationError,
  type CriterionContribution,
  type MatchingScoringOptions,
  type MatchingScoringResult,
  type PreferenceCriterionContribution,
  type PreferencesScoringSummary,
  type ScoringSummary,
} from "./scoring-types";

export const DEFAULT_CRITERION_WEIGHT = 1 as const;

export const DEFAULT_CRITERIA_WEIGHTS: Readonly<Record<string, number>> = Object.freeze({
  category: 1,
  brand: 1,
  model: 1,
  variant: 1,
  price_vs_budget: 1,
  quantity: 1,
  condition: 1,
  location: 1,
  deadline: 1,
});

/**
 * Valide et extrait la configuration de scoring.
 * Lève MatchingScoringValidationError si un poids n'est pas un nombre fini > 0.
 */
function canonicalStringify(val: unknown): string {
  if (val === null || typeof val !== "object") {
    return JSON.stringify(val);
  }
  if (Array.isArray(val)) {
    return "[" + val.map((elem) => canonicalStringify(elem)).join(",") + "]";
  }
  const obj = val as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalStringify(obj[k])).join(",") + "}";
}

/**
 * Valide et extrait la configuration de scoring.
 * Lève MatchingScoringValidationError si un poids n'est pas un nombre fini > 0.
 */
function validateScoringOptions(options?: MatchingScoringOptions): {
  weightsMap: Map<string, number>;
  defaultWeight: number;
  precision: number;
  now: Date;
} {
  const defaultWeight = options?.defaultWeight ?? DEFAULT_CRITERION_WEIGHT;
  if (typeof defaultWeight !== "number" || !Number.isFinite(defaultWeight) || defaultWeight <= 0) {
    throw new MatchingScoringValidationError(
      `Poids par défaut invalide : attendu un nombre fini strictement positif, reçu ${String(defaultWeight)}.`,
    );
  }

  const precision = options?.precision ?? 2;
  if (
    typeof precision !== "number" ||
    !Number.isInteger(precision) ||
    precision < 0 ||
    precision > 6
  ) {
    throw new MatchingScoringValidationError(
      `Précision invalide : attendu un entier entre 0 et 6, reçu ${String(precision)}.`,
    );
  }

  const weightsMap = new Map<string, number>();
  if (options?.weights !== undefined) {
    if (
      typeof options.weights !== "object" ||
      options.weights === null ||
      Array.isArray(options.weights)
    ) {
      throw new MatchingScoringValidationError(
        "L'option 'weights' doit être un objet clé-valeur non nul.",
      );
    }

    const ownKeys = Object.getOwnPropertyNames(options.weights);
    for (const key of ownKeys) {
      const val = (options.weights as Record<string, unknown>)[key];
      if (typeof val !== "number" || !Number.isFinite(val) || val <= 0) {
        throw new MatchingScoringValidationError(
          `Poids invalide pour '${key}' : attendu un nombre fini strictement positif (> 0), reçu ${String(val)}.`,
        );
      }
      weightsMap.set(key, val);
    }
  }

  const now = options?.now ?? new Date();

  return { weightsMap, defaultWeight, precision, now };
}

/**
 * Résout le poids nominal d'un critère en interrogeant uniquement les clés propres :
 * 1. options.weights[name] (nom exact du critère)
 * 2. options.weights[attrKey] (clé courte d'attribut si attributes.<key>)
 * 3. options.weights[reqKey] (clé de critère si requirements.<idx>)
 * 4. DEFAULT_CRITERIA_WEIGHTS[name] si standard
 * 5. defaultWeight (1 par défaut)
 */
function resolveCriterionWeight(
  name: string,
  demandValue: unknown,
  weightsMap: Map<string, number>,
  defaultWeight: number,
): number {
  if (weightsMap.has(name)) {
    return weightsMap.get(name)!;
  }

  if (name.startsWith("attributes.")) {
    const attrKey = name.slice("attributes.".length);
    if (weightsMap.has(attrKey)) {
      return weightsMap.get(attrKey)!;
    }
  }

  if (name.startsWith("requirements.") && demandValue !== null && typeof demandValue === "object") {
    const reqObj = demandValue as Record<string, unknown>;
    if (typeof reqObj.key === "string") {
      const reqKey = reqObj.key.trim();
      if (weightsMap.has(reqKey)) {
        return weightsMap.get(reqKey)!;
      }
    }
  }

  if (Object.prototype.hasOwnProperty.call(DEFAULT_CRITERIA_WEIGHTS, name)) {
    return DEFAULT_CRITERIA_WEIGHTS[name];
  }

  return defaultWeight;
}

/**
 * Calcule une signature canonique pour détecter les doublons stricts d'exigences (requirements).
 * Ne déduplique JAMAIS des exigences avec des attributs directs (mécanismes 2A distincts).
 * Préserve intégralement les types, unités, casse et propriétés additionnelles de l'objet exigence.
 */
function getRequirementExplicitSignature(name: string, demandValue: unknown): string | null {
  if (name.startsWith("requirements.") && demandValue !== null && typeof demandValue === "object") {
    return `requirement:${canonicalStringify(demandValue)}`;
  }

  return null;
}

/**
 * Fonction pure de scoring explicable du Lot 2B.
 * Consomme le résultat du comparateur Lot 2A (MatchingEvaluationResult).
 *
 * Invariants stricts :
 * 1. Ne modifie JAMAIS les statuts du comparateur (eligibility, compatibility.status).
 * 2. 100 ne peut JAMAIS être affiché si au moins une obligation applicable est unknown ou mismatched.
 * 3. Ne récompense pas la duplication exacte d'un même critère explicite.
 * 4. Sans critère applicable, score et couverture valent null.
 * 5. Les préférences restent séparées, sans aucun bonus compensatoire.
 * 6. Les inputs et options ne sont jamais mutés.
 */
export function computeMatchingScore(
  evaluation: MatchingEvaluationResult,
  options?: MatchingScoringOptions,
): MatchingScoringResult {
  const { weightsMap, defaultWeight, precision, now } = validateScoringOptions(options);

  const criteriaRecord = evaluation.compatibility?.criteria ?? {};
  const criteriaEntries = Object.entries(criteriaRecord);

  const seenRequirementSignatures = new Set<string>();
  const contributions: Record<string, CriterionContribution> = {};

  let totalApplicableWeight = 0;
  let matchedWeight = 0;
  let mismatchedWeight = 0;
  let unknownWeight = 0;

  let applicableCriteriaCount = 0;
  let matchedCount = 0;
  let mismatchedCount = 0;
  let unknownCount = 0;
  let notApplicableCount = 0;
  let duplicateCount = 0;

  // Passe 1 : identification des doublons et des poids nominaux
  for (const [name, crit] of criteriaEntries) {
    const weight = resolveCriterionWeight(name, crit.demandValue, weightsMap, defaultWeight);
    const isApplicable = crit.status !== "not_applicable";

    let isDuplicate = false;
    let deduplicationReason: string | undefined;

    if (isApplicable) {
      const sig = getRequirementExplicitSignature(name, crit.demandValue);
      if (sig) {
        if (seenRequirementSignatures.has(sig)) {
          isDuplicate = true;
          duplicateCount++;
          deduplicationReason =
            "Exigence dupliquée à l'identique ; ignorée pour ne pas sur-pondérer artificiellement.";
        } else {
          seenRequirementSignatures.add(sig);
        }
      }
    }

    const effectiveWeight = isApplicable && !isDuplicate ? weight : 0;

    if (!isApplicable) {
      notApplicableCount++;
    } else if (!isDuplicate) {
      applicableCriteriaCount++;
      totalApplicableWeight += effectiveWeight;
      if (!Number.isFinite(totalApplicableWeight)) {
        throw new MatchingScoringValidationError(
          "Dépassement de capacité : la somme totale des poids applicables dépasse Number.MAX_VALUE.",
        );
      }

      if (crit.status === "matched") {
        matchedWeight += effectiveWeight;
        matchedCount++;
      } else if (crit.status === "mismatched") {
        mismatchedWeight += effectiveWeight;
        mismatchedCount++;
      } else {
        unknownWeight += effectiveWeight;
        unknownCount++;
      }
    }

    contributions[name] = {
      name,
      status: crit.status,
      weight,
      effectiveWeight,
      isApplicable,
      isDuplicate,
      deduplicationReason,
      weightedMatched: crit.status === "matched" ? effectiveWeight : 0,
      weightedCovered:
        crit.status === "matched" || crit.status === "mismatched" ? effectiveWeight : 0,
      scoreContributionPercent: 0,
      coverageContributionPercent: 0,
      code: crit.code,
      message: crit.message,
    };
  }

  // Passe 2 : calcul du score, de la couverture et des contributions en pourcentage
  const factor = Math.pow(10, precision);

  let finalScore: number | null = null;
  let finalCoverage: number | null = null;

  if (totalApplicableWeight > 0) {
    // Calcul sécurisé contre le débordement (ex: matchedWeight ~ 1e308) :
    // (matchedWeight / totalApplicableWeight) * 100 reste toujours <= 100 car matchedWeight <= totalApplicableWeight.
    // Pour la couverture, on additionne les ratios séparés pour éviter que (matchedWeight + mismatchedWeight)
    // ne dépasse Number.MAX_VALUE en raison des arrondis flottants si l'un vaut Number.MAX_VALUE.
    const rawScore = (matchedWeight / totalApplicableWeight) * 100;
    const rawCoverage = Math.min(
      100,
      (matchedWeight / totalApplicableWeight) * 100 +
        (mismatchedWeight / totalApplicableWeight) * 100,
    );

    let roundedScore = Math.round(rawScore * factor) / factor;
    let roundedCoverage = Math.round(rawCoverage * factor) / factor;

    // INVARIANT CRUCIAL : 100 ne doit JAMAIS être affiché avec une obligation inconnue ou contredite.
    if (unknownCount > 0 || mismatchedCount > 0) {
      const maxAllowed = 100 - 1 / factor;
      if (roundedScore >= 100) {
        roundedScore = Math.max(0, maxAllowed);
      }
    }

    // De même, la couverture ne peut pas être 100 s'il reste des inconnues.
    if (unknownCount > 0) {
      const maxAllowedCov = 100 - 1 / factor;
      if (roundedCoverage >= 100) {
        roundedCoverage = Math.max(0, maxAllowedCov);
      }
    }

    finalScore = roundedScore;
    finalCoverage = roundedCoverage;

    // Mise à jour des parts relatives de chaque critère
    for (const contrib of Object.values(contributions)) {
      if (contrib.effectiveWeight > 0) {
        if (contrib.status === "matched") {
          contrib.scoreContributionPercent =
            Math.round(((contrib.effectiveWeight / totalApplicableWeight) * 100) * factor) / factor;
        }
        if (contrib.status === "matched" || contrib.status === "mismatched") {
          contrib.coverageContributionPercent =
            Math.round(((contrib.effectiveWeight / totalApplicableWeight) * 100) * factor) / factor;
        }
      }
    }
  }

  // Évaluation séparée des préférences (sans aucun bonus compensatoire sur le score obligatoire)
  const prefContributions: PreferenceCriterionContribution[] = [];
  let prefMatched = 0;
  let prefMismatched = 0;
  let prefUnknown = 0;

  if (Array.isArray(evaluation.preferences)) {
    for (const pref of evaluation.preferences) {
      if (pref.status === "matched") prefMatched++;
      else if (pref.status === "mismatched") prefMismatched++;
      else prefUnknown++;

      prefContributions.push({
        name: pref.name,
        status: pref.status,
        weight: 1,
        isDuplicate: false,
        code: pref.code,
        message: pref.message,
      });
    }
  }

  const prefTotal = prefContributions.length;
  const preferenceScore =
    prefTotal > 0 ? Math.round(((100 * prefMatched) / prefTotal) * factor) / factor : null;
  const preferenceCoverage =
    prefTotal > 0
      ? Math.round(((100 * (prefMatched + prefMismatched)) / prefTotal) * factor) / factor
      : null;

  const preferencesSummary: PreferencesScoringSummary = {
    preferenceScore,
    preferenceCoverage,
    totalPreferencesCount: prefTotal,
    matchedCount: prefMatched,
    mismatchedCount: prefMismatched,
    unknownCount: prefUnknown,
    contributions: prefContributions,
  };

  const summary: ScoringSummary = {
    totalApplicableWeight,
    matchedWeight,
    mismatchedWeight,
    unknownWeight,
    applicableCriteriaCount,
    matchedCount,
    mismatchedCount,
    unknownCount,
    notApplicableCount,
    duplicateCount,
  };

  return {
    contractVersion: MATCHING_SCORING_CONTRACT_VERSION,
    scoredAt: now,
    evaluationTimestamp: evaluation.evaluatedAt,
    offerId: evaluation.offer?.id ?? "",
    demandId: evaluation.demand?.id ?? "",
    eligibilityStatus: evaluation.eligibility.status,
    compatibilityStatus: evaluation.compatibility.status,
    isEligible: evaluation.eligibility.status === "eligible",
    isCompatible: evaluation.compatibility.status === "compatible",
    score: finalScore,
    coverage: finalCoverage,
    summary,
    contributions,
    preferences: preferencesSummary,
  };
}
