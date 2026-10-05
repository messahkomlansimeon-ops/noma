import type { DemandRecord, OfferRecord } from "../catalog/types";
import type { CandidateQueryOptions, InternalDemandCandidateQueryOptions } from "./candidates-types";
import type { MatchingCompatibilityStatus, MatchingEvaluationResult } from "./types";
import type { MatchingScoringOptions, MatchingScoringResult } from "./scoring-types";

export const MATCHING_SERVICE_CONTRACT_VERSION = "matching-service/v1" as const;

export interface EvaluatedMatchesQueryOptions extends CandidateQueryOptions {
  /**
   * Horloge injectée pour l'ensemble des évaluations de la page.
   * Si non renseignée, une instance unique de Date est créée pour toute la page.
   */
  now?: Date;

  /**
   * Options de configuration du score Lot 2B (poids personnalisés, précision, etc.).
   */
  scoringOptions?: MatchingScoringOptions;
}

/** Options INTERNES du sens offre → demandes (worker temporel) : ajoute la restriction à un candidat. */
export interface InternalEvaluatedDemandMatchesQueryOptions
  extends EvaluatedMatchesQueryOptions, InternalDemandCandidateQueryOptions {}

export interface EvaluatedMatchItem<TCandidate extends OfferRecord | DemandRecord> {
  candidateId: string;
  candidateContentVersion: number;
  candidate: TCandidate;
  compatibilityStatus: MatchingCompatibilityStatus;
  evaluation: MatchingEvaluationResult;
  scoring: MatchingScoringResult;
}

export interface EvaluatedMatchPage<
  TSource extends OfferRecord | DemandRecord,
  TCandidate extends OfferRecord | DemandRecord,
> {
  contractVersion: typeof MATCHING_SERVICE_CONTRACT_VERSION;
  evaluatedAt: Date;
  source: {
    id: string;
    contentVersion: number;
    ownerId: string;
    record: TSource;
  };
  items: EvaluatedMatchItem<TCandidate>[];
  nextCursor: string | null;
  hasMore: boolean;
  limit: number;
}
