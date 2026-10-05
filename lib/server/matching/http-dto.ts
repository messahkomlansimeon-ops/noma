import "server-only";

import type { AvailabilityStatus, DemandRecord, Money, OfferRecord } from "../catalog/types";
import type { EvaluatedMatchItem, EvaluatedMatchPage } from "./service-types";
import type { AvailabilityLevel, ConfidenceLevel, PricePosition, AccountAgeBand } from "./indicators";
import type { StoredMatchItem, StoredMatchesPage } from "./stored-matches";
import type { MatchingCompatibilityStatus } from "./types";

export const MATCHING_HTTP_CONTRACT_VERSION = "matching-http/v1" as const;
export const MATCHING_STORED_HTTP_CONTRACT_VERSION = "matching-stored-http/v1" as const;

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

/** Indicateurs séparés (brief §5), calculés à la lecture. `availability` et `price` sont null dans le sens offre. */
export interface StoredMatchIndicatorsDto {
  availability: { level: AvailabilityLevel; score: number | null; confirmedAgeHours: number | null; factors: string[] } | null;
  /** Position par rapport au marché observé : jamais le prix de marché brut ni les offres d'autrui. */
  price: { position: PricePosition; score: number | null; deltaPercent: number | null; sampleSize: number; factors: string[] } | null;
  /** Ancienneté du compte par tranche seulement ; jamais de téléphone ni de date de création. */
  confidence: { level: ConfidenceLevel; score: number; accountAgeBand: AccountAgeBand; factors: string[] };
}

/** Élément de correspondance ENREGISTRÉE : la forme de l'élément en direct, plus la date de l'évaluation, les indicateurs et la pertinence. */
export interface StoredMatchItemDto extends EvaluatedMatchItemDto {
  evaluatedAt: string;
  indicators: StoredMatchIndicatorsDto;
  /** Pertinence organique 0..100 (sans boost). */
  relevance: number;
}

export interface StoredMatchesResponseDto {
  contractVersion: typeof MATCHING_STORED_HTTP_CONTRACT_VERSION;
  source: EvaluatedMatchProductDto;
  items: StoredMatchItemDto[];
  /** La version courante de la source est en cours de traitement (voir MATCHING-STORED-READ.md). */
  processing: boolean;
  readAt: string;
  nextCursor: string | null;
  hasMore: boolean;
  limit: number;
  /** Tri par pertinence : plus de 200 correspondances existent, seules les meilleures par score ont été triées. */
  truncated: boolean;
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

/**
 * Mappe un élément enregistré vers le DTO public. Liste blanche stricte, champ par champ : ni identifiant de
 * propriétaire, ni texte brut, ni evaluation_details, ni configuration de scoring, ni clé d'idempotence, ni hash de
 * tentative (aucun de ces champs n'est même lu par le service).
 */
function mapStoredMatchItem<TCandidate extends OfferRecord | DemandRecord>(
  item: StoredMatchItem<TCandidate>,
): StoredMatchItemDto {
  return {
    candidateId: item.candidateId,
    candidateContentVersion: item.candidateContentVersion,
    candidate: mapProductRecord(item.candidate),
    compatibilityStatus: item.compatibilityStatus,
    score: item.score,
    coverage: item.coverage,
    evaluation: {
      status: item.compatibilityStatus,
      summary: {
        matchedCount: item.evaluationSummary.matchedCount,
        mismatchedCount: item.evaluationSummary.mismatchedCount,
        unknownCount: item.evaluationSummary.unknownCount,
        totalExploitableCriteria: item.evaluationSummary.totalExploitableCriteria,
      },
    },
    scoring: {
      score: item.score,
      coverage: item.coverage,
      summary: {
        totalApplicableWeight: item.scoringSummary.totalApplicableWeight,
        matchedWeight: item.scoringSummary.matchedWeight,
        mismatchedWeight: item.scoringSummary.mismatchedWeight,
        unknownWeight: item.scoringSummary.unknownWeight,
        applicableCriteriaCount: item.scoringSummary.applicableCriteriaCount,
        matchedCount: item.scoringSummary.matchedCount,
        mismatchedCount: item.scoringSummary.mismatchedCount,
        unknownCount: item.scoringSummary.unknownCount,
      },
      preferences: {
        preferenceScore: item.preferencesSummary.preferenceScore,
        preferenceCoverage: item.preferencesSummary.preferenceCoverage,
        totalPreferencesCount: item.preferencesSummary.totalPreferencesCount,
        matchedCount: item.preferencesSummary.matchedCount,
        mismatchedCount: item.preferencesSummary.mismatchedCount,
        unknownCount: item.preferencesSummary.unknownCount,
      },
    },
    evaluatedAt: item.evaluatedAt.toISOString(),
    indicators: {
      availability: item.indicators.availability === null ? null : {
        level: item.indicators.availability.level,
        score: item.indicators.availability.score,
        confirmedAgeHours: item.indicators.availability.confirmedAgeHours,
        factors: [...item.indicators.availability.factors],
      },
      price: item.indicators.price === null ? null : {
        position: item.indicators.price.position,
        score: item.indicators.price.score,
        deltaPercent: item.indicators.price.deltaPercent,
        sampleSize: item.indicators.price.sampleSize,
        factors: [...item.indicators.price.factors],
      },
      confidence: {
        level: item.indicators.confidence.level,
        score: item.indicators.confidence.score,
        accountAgeBand: item.indicators.confidence.accountAgeBand,
        factors: [...item.indicators.confidence.factors],
      },
    },
    relevance: item.relevance,
  };
}

/** Convertit une page de correspondances enregistrées en DTO public strictement filtré par liste blanche. */
export function mapStoredMatchesPageToDto<
  TSource extends OfferRecord | DemandRecord,
  TCandidate extends OfferRecord | DemandRecord,
>(page: StoredMatchesPage<TSource, TCandidate>): StoredMatchesResponseDto {
  return {
    contractVersion: MATCHING_STORED_HTTP_CONTRACT_VERSION,
    source: mapProductRecord(page.source.record),
    items: page.items.map(mapStoredMatchItem),
    processing: page.processing,
    readAt: page.readAt.toISOString(),
    nextCursor: page.nextCursor,
    hasMore: page.hasMore,
    limit: page.limit,
    truncated: page.truncated,
  };
}
