import "server-only";

import type { AvailabilityStatus, DemandRecord, Money, OfferRecord } from "../catalog/types";
import type { EvaluatedMatchItem, EvaluatedMatchPage } from "./service-types";
import type { MatchingCompatibilityStatus } from "./types";

export const MATCHING_HTTP_CONTRACT_VERSION = "matching-http/v1" as const;

export interface EvaluatedMatchProductDto {
  id: string;
  contentVersion: number;
  category: string | null;
  brand: string | null;
  model: string | null;
  variant: string | null;
  condition: string | null;
  quantity: number | null;
  unit: string | null;
  location: string | null;
  deadlineAt: string | null;
  price?: Money | null;
  availabilityStatus?: AvailabilityStatus | null;
  budget?: Money | null;
}

export interface EvaluatedMatchEvaluationSummaryDto {
  matchedCount: number;
  mismatchedCount: number;
  unknownCount: number;
  totalExploitableCriteria: number;
}

export interface EvaluatedMatchScoringSummaryDto {
  totalApplicableWeight: number;
  matchedWeight: number;
  mismatchedWeight: number;
  unknownWeight: number;
  applicableCriteriaCount: number;
  matchedCount: number;
  mismatchedCount: number;
  unknownCount: number;
}

export interface EvaluatedMatchPreferencesSummaryDto {
  preferenceScore: number | null;
  preferenceCoverage: number | null;
  totalPreferencesCount: number;
  matchedCount: number;
  mismatchedCount: number;
  unknownCount: number;
}

export interface EvaluatedMatchItemDto {
  candidateId: string;
  candidateContentVersion: number;
  candidate: EvaluatedMatchProductDto;
  compatibilityStatus: MatchingCompatibilityStatus;
  score: number | null;
  coverage: number | null;
  evaluation: {
    status: MatchingCompatibilityStatus;
    summary: EvaluatedMatchEvaluationSummaryDto;
  };
  scoring: {
    score: number | null;
    coverage: number | null;
    summary: EvaluatedMatchScoringSummaryDto;
    preferences: EvaluatedMatchPreferencesSummaryDto;
  };
}

export interface EvaluatedMatchesResponseDto {
  contractVersion: typeof MATCHING_HTTP_CONTRACT_VERSION;
  evaluatedAt: string;
  source: EvaluatedMatchProductDto;
  items: EvaluatedMatchItemDto[];
  nextCursor: string | null;
  hasMore: boolean;
  limit: number;
}

/**
 * Mappe un enregistrement catalogue vers sa représentation produit exposée.
 * Exclut strictement le propriétaire tiers, le texte brut, les métadonnées d'extraction,
 * et toute structure de règles/attributs arbitraires.
 */
function mapProductRecord(record: OfferRecord | DemandRecord): EvaluatedMatchProductDto {
  const common = {
    id: record.id,
    contentVersion: record.contentVersion,
    category: record.category ?? null,
    brand: record.brand ?? null,
    model: record.model ?? null,
    variant: record.variant ?? null,
    condition: record.condition ?? null,
    quantity: record.quantity ?? null,
    unit: record.unit ?? null,
    location: record.location ?? null,
    deadlineAt: record.deadlineAt ? record.deadlineAt.toISOString() : null,
  };

  if ("price" in record) {
    return {
      ...common,
      price: record.price ? { amount: record.price.amount, currency: record.price.currency } : null,
      availabilityStatus: record.availabilityStatus,
    };
  }

  return {
    ...common,
    budget: record.budget ? { amount: record.budget.amount, currency: record.budget.currency } : null,
  };
}

/**
 * Mappe un élément candidat évalué vers sa forme DTO publique.
 * Exclut toute preuve interne, exigence brute ou détail arbitraire de calcul.
 */
function mapEvaluatedMatchItem<TCandidate extends OfferRecord | DemandRecord>(
  item: EvaluatedMatchItem<TCandidate>,
): EvaluatedMatchItemDto {
  return {
    candidateId: item.candidateId,
    candidateContentVersion: item.candidateContentVersion,
    candidate: mapProductRecord(item.candidate),
    compatibilityStatus: item.compatibilityStatus,
    score: item.scoring.score,
    coverage: item.scoring.coverage,
    evaluation: {
      status: item.evaluation.compatibility.status,
      summary: {
        matchedCount: item.evaluation.compatibility.summary.matchedCount,
        mismatchedCount: item.evaluation.compatibility.summary.mismatchedCount,
        unknownCount: item.evaluation.compatibility.summary.unknownCount,
        totalExploitableCriteria: item.evaluation.compatibility.summary.totalExploitableCriteria,
      },
    },
    scoring: {
      score: item.scoring.score,
      coverage: item.scoring.coverage,
      summary: {
        totalApplicableWeight: item.scoring.summary.totalApplicableWeight,
        matchedWeight: item.scoring.summary.matchedWeight,
        mismatchedWeight: item.scoring.summary.mismatchedWeight,
        unknownWeight: item.scoring.summary.unknownWeight,
        applicableCriteriaCount: item.scoring.summary.applicableCriteriaCount,
        matchedCount: item.scoring.summary.matchedCount,
        mismatchedCount: item.scoring.summary.mismatchedCount,
        unknownCount: item.scoring.summary.unknownCount,
      },
      preferences: {
        preferenceScore: item.scoring.preferences.preferenceScore,
        preferenceCoverage: item.scoring.preferences.preferenceCoverage,
        totalPreferencesCount: item.scoring.preferences.totalPreferencesCount,
        matchedCount: item.scoring.preferences.matchedCount,
        mismatchedCount: item.scoring.preferences.mismatchedCount,
        unknownCount: item.scoring.preferences.unknownCount,
      },
    },
  };
}

/**
 * Convertit une page d'évaluations 2C2 en DTO public strictement filtré par liste blanche.
 */
export function mapEvaluatedMatchesPageToDto<
  TSource extends OfferRecord | DemandRecord,
  TCandidate extends OfferRecord | DemandRecord,
>(page: EvaluatedMatchPage<TSource, TCandidate>): EvaluatedMatchesResponseDto {
  return {
    contractVersion: MATCHING_HTTP_CONTRACT_VERSION,
    evaluatedAt: page.evaluatedAt.toISOString(),
    source: mapProductRecord(page.source.record),
    items: page.items.map(mapEvaluatedMatchItem),
    nextCursor: page.nextCursor,
    hasMore: page.hasMore,
    limit: page.limit,
  };
}
