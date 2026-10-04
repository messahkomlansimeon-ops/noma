import type {
  CriterionStatus,
  MatchingCompatibilityStatus,
  MatchingEligibilityStatus,
} from "./types";

export const MATCHING_SCORING_CONTRACT_VERSION = "matching-scoring/v1" as const;

export class MatchingScoringValidationError extends Error {
  readonly code = "INVALID_SCORING_CONFIG" as const;

  constructor(message: string) {
    super(message);
    this.name = "MatchingScoringValidationError";
  }
}

export interface CriterionContribution {
  name: string;
  status: CriterionStatus;
  weight: number;
  effectiveWeight: number;
  isApplicable: boolean;
  isDuplicate: boolean;
  deduplicationReason?: string;
  weightedMatched: number;
  weightedCovered: number;
  scoreContributionPercent: number;
  coverageContributionPercent: number;
  code: string;
  message: string;
}

export interface ScoringSummary {
  totalApplicableWeight: number;
  matchedWeight: number;
  mismatchedWeight: number;
  unknownWeight: number;
  applicableCriteriaCount: number;
  matchedCount: number;
  mismatchedCount: number;
  unknownCount: number;
  notApplicableCount: number;
  duplicateCount: number;
}

export interface PreferenceCriterionContribution {
  name: string;
  status: "matched" | "mismatched" | "unknown";
  weight: number;
  isDuplicate: boolean;
  code: string;
  message: string;
}

export interface PreferencesScoringSummary {
  preferenceScore: number | null;
  preferenceCoverage: number | null;
  totalPreferencesCount: number;
  matchedCount: number;
  mismatchedCount: number;
  unknownCount: number;
  contributions: PreferenceCriterionContribution[];
}

export interface MatchingScoringResult {
  contractVersion: typeof MATCHING_SCORING_CONTRACT_VERSION;
  scoredAt: Date;
  evaluationTimestamp: Date;
  offerId: string;
  demandId: string;

  /**
   * Statuts inchangés du comparateur 2A (le score ne modifie JAMAIS ces statuts).
   */
  eligibilityStatus: MatchingEligibilityStatus;
  compatibilityStatus: MatchingCompatibilityStatus;
  isEligible: boolean;
  isCompatible: boolean;

  /**
   * Score de compatibilité confirmée (0 à 100), ou null si aucun critère applicable.
   * Invariant : 100 ne peut JAMAIS être affiché si au moins une obligation est unknown ou mismatched.
   */
  score: number | null;

  /**
   * Taux de couverture des critères évaluables (0 à 100), ou null si aucun critère applicable.
   * Couverture = 100 * poids (matched + mismatched) / poids total.
   */
  coverage: number | null;

  /**
   * Décomposition détaillée pour auditabilité intégrale.
   */
  summary: ScoringSummary;
  contributions: Record<string, CriterionContribution>;

  /**
   * Préférences évaluées séparément, sans aucun bonus compensatoire sur le score de compatibilité.
   */
  preferences: PreferencesScoringSummary;
}

export interface MatchingScoringOptions {
  /**
   * Poids spécifiques par critère (ex: { category: 2, price_vs_budget: 3, storage_capacity: 2 }).
   * Doivent être des nombres finis strictement positifs (> 0).
   */
  weights?: Record<string, number>;

  /**
   * Poids par défaut pour tout critère non spécifié (défaut: 1).
   * Doit être un nombre fini strictement positif (> 0).
   */
  defaultWeight?: number;

  /**
   * Nombre de décimales pour l'arrondi (défaut: 2).
   * Doit être un entier compris entre 0 et 6.
   */
  precision?: number;

  /**
   * Horloge injectée pour déterminisme des tests.
   */
  now?: Date;
}
