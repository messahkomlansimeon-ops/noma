import type { AvailabilityStatus, DemandStatus, OfferStatus } from "../catalog/types";

export const MATCHING_OFFLINE_CONTRACT_VERSION = "matching-offline/v1" as const;

export type MatchingCompatibilityStatus = "compatible" | "incompatible" | "unknown";

export type MatchingEligibilityStatus = "eligible" | "ineligible";

export type CriterionStatus = "matched" | "mismatched" | "unknown" | "not_applicable";

export type EligibilityReasonCode =
  | "offer_not_published"
  | "demand_not_active"
  | "same_owner"
  | "offer_unavailable";

export interface CriterionEvaluation {
  name: string;
  status: CriterionStatus;
  offerValue: unknown;
  demandValue: unknown;
  code: string;
  message: string;
}

export interface PreferenceEvaluation {
  name: string;
  status: "matched" | "mismatched" | "unknown";
  operator?: string;
  targetValue?: unknown;
  observedValue?: unknown;
  code: string;
  message: string;
}

export interface AvailabilityFacts {
  status: AvailabilityStatus | "unknown";
  confirmedAt: Date | null;
  quantity: number | null;
  unit: string | null;
  isAvailable: boolean;
}

export interface MarketPriceEstimation {
  status: "unknown";
  reason: "insufficient_data";
}

export interface EvaluationConfidence {
  status: "unknown";
  reason: "insufficient_data";
}

export interface CompatibilitySummary {
  matchedCount: number;
  mismatchedCount: number;
  unknownCount: number;
  totalExploitableCriteria: number;
}

export interface MatchingEvaluationResult {
  contractVersion: typeof MATCHING_OFFLINE_CONTRACT_VERSION;
  evaluatedAt: Date;
  offer: {
    id: string;
    contentVersion: number;
    status: OfferStatus;
    ownerId: string;
  };
  demand: {
    id: string;
    contentVersion: number;
    status: DemandStatus;
    ownerId: string;
  };
  eligibility: {
    status: MatchingEligibilityStatus;
    reasons: EligibilityReasonCode[];
  };
  compatibility: {
    status: MatchingCompatibilityStatus;
    criteria: Record<string, CriterionEvaluation>;
    summary: CompatibilitySummary;
  };
  preferences: PreferenceEvaluation[];
  availability: AvailabilityFacts;
  marketPrice: MarketPriceEstimation;
  confidence: EvaluationConfidence;
}

export interface OfflineMatchingOptions {
  /** Horloge injectée pour déterminisme temporel (échéance deadlineAt) */
  now?: Date;
}

export * from "./scoring-types";
export * from "./candidates-types";
export * from "./service-types";
