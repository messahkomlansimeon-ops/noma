import "server-only";

import type { PoolClient } from "pg";
import type {
  MatchingCompatibilityStatus,
  MatchingEligibilityStatus,
  MatchingEvaluationResult,
} from "./types";
import type {
  MatchingScoringOptions,
  MatchingScoringResult,
} from "./scoring-types";
import type { DemandRecord, OfferRecord } from "../catalog/types";

export type MatchingStaleReason =
  | "offer_updated"
  | "demand_updated"
  | "offer_archived"
  | "demand_archived"
  | "offer_unavailable"
  | "demand_satisfied"
  | "user_suspended"
  | "user_archived"
  | "engine_superseded"
  | "temporal_expiry"
  | "superseded_by_reevaluation";

export class MatchingPersistenceError extends Error {
  readonly code: string = "MATCHING_PERSISTENCE_ERROR";

  constructor(message = "Erreur de persistance du matching.") {
    super(message);
    this.name = "MatchingPersistenceError";
  }
}

export class MatchingInputConsistencyError extends MatchingPersistenceError {
  readonly code = "MATCHING_INPUT_CONSISTENCY" as const;
  readonly status = 400 as const;

  constructor(message = "Incohérence entre les identités, versions, propriétaires ou scoring fournis.") {
    super(message);
    this.name = "MatchingInputConsistencyError";
  }
}

export class MatchingIdempotencyConflictError extends MatchingPersistenceError {
  readonly code = "MATCHING_IDEMPOTENCY_CONFLICT" as const;
  readonly status = 409 as const;

  constructor(message = "La même clé d'idempotence a été soumise avec une empreinte de tentative différente.") {
    super(message);
    this.name = "MatchingIdempotencyConflictError";
  }
}

export class EvaluationExpiredDuringLockWaitError extends MatchingPersistenceError {
  readonly code = "EVALUATION_EXPIRED_DURING_LOCK_WAIT" as const;
  readonly status = 409 as const;

  constructor(message = "Une transition temporelle d'échéance a été franchie pendant l'attente du verrou.") {
    super(message);
    this.name = "EvaluationExpiredDuringLockWaitError";
  }
}

export class StaleAttemptSupersededError extends MatchingPersistenceError {
  readonly code = "STALE_ATTEMPT_SUPERSEDED" as const;
  readonly status = 409 as const;

  constructor(message = "Une tentative d'évaluation plus récente a déjà été enregistrée pour cette paire.") {
    super(message);
    this.name = "StaleAttemptSupersededError";
  }
}

export class StalePreconditionsError extends MatchingPersistenceError {
  readonly code = "STALE_PRECONDITIONS" as const;
  readonly status = 409 as const;

  constructor(message = "Les conditions préalables (versions ou statuts) ne sont plus satisfaites après verrouillage.") {
    super(message);
    this.name = "StalePreconditionsError";
  }
}

export interface PersistedMatchingEvaluation {
  id: string;
  idempotencyKey: string;
  attemptHash: string;
  offerId: string;
  demandId: string;
  offerOwnerId: string;
  demandOwnerId: string;
  offerContentVersion: number;
  demandContentVersion: number;
  engineOfflineVersion: string;
  engineScoringVersion: string;
  scoringConfigHash: string;
  scoringConfig: Record<string, unknown>;
  evaluatedAt: Date;
  persistedAt: Date;
  expiresAt: Date | null;
  eligibilityStatus: MatchingEligibilityStatus;
  eligibilityReasons: string[];
  compatibilityStatus: MatchingCompatibilityStatus;
  isConfirmedMatch: boolean;
  score: number | null;
  coverage: number | null;
  evaluationSummary: Record<string, unknown>;
  scoringSummary: Record<string, unknown>;
  preferencesSummary: Record<string, unknown>;
  evaluationDetails: Record<string, unknown>;
  isLatest: boolean;
  isStale: boolean;
  staleReason: MatchingStaleReason | null;
  staledAt: Date | null;
  isReplayed?: boolean;
}

export interface PersistEvaluatedMatchOptions {
  idempotencyKey: string;
  offerId?: string;
  demandId?: string;
  offer?: OfferRecord;
  demand?: DemandRecord;
  evaluation: MatchingEvaluationResult;
  scoring: MatchingScoringResult;
  scoringOptions?: MatchingScoringOptions;
  db?: unknown;
  pool?: unknown;
  /**
   * Crochet INTERNE (lot N1) exécuté DANS la transaction de l'évaluation, après l'INSERT de la nouvelle évaluation et avant le COMMIT, avec le client
   * transactionnel. Ce que le crochet écrit est validé avec l'évaluation ou annulé avec elle ; une erreur levée annule l'évaluation. Jamais appelé pour
   * un rejeu d'une tentative déjà enregistrée (aucune écriture : aucun doublon).
   */
  inTransaction?: (client: PoolClient, evaluation: PersistedMatchingEvaluation) => Promise<void>;
}

export interface GetActiveMatchingEvaluationOptions {
  offerId: string;
  demandId: string;
  expectedEngineOfflineVersion?: string;
  expectedEngineScoringVersion?: string;
  expectedScoringConfigHash?: string;
  db?: unknown;
  pool?: unknown;
}
