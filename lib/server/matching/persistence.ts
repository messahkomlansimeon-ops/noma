import "server-only";

import { createHash } from "node:crypto";
import type { PoolClient, QueryResultRow } from "pg";
import { getPostgresPool, type SqlExecutor } from "../postgres/client";
import {
  requireTransactionPool,
  requireUuid,
} from "../catalog/validation";
import {
  EvaluationExpiredDuringLockWaitError,
  MatchingIdempotencyConflictError,
  MatchingInputConsistencyError,
  MatchingPersistenceError,
  StaleAttemptSupersededError,
  StalePreconditionsError,
  type GetActiveMatchingEvaluationOptions,
  type MatchingStaleReason,
  type PersistedMatchingEvaluation,
  type PersistEvaluatedMatchOptions,
} from "./persistence-types";
import {
  MATCHING_OFFLINE_CONTRACT_VERSION,
  type MatchingCompatibilityStatus,
  type MatchingEligibilityStatus,
} from "./types";
import {
  MATCHING_SCORING_CONTRACT_VERSION,
  MatchingScoringValidationError,
  type MatchingScoringOptions,
} from "./scoring-types";
import { computeMatchingScore } from "./scoring";

const IDEMPOTENCY_LOCK_NAMESPACE = 1_314_664_947;
const MATCHING_PAIR_LOCK_NAMESPACE = 1_314_664_946;

interface MatchingEvaluationRow extends QueryResultRow {
  id: string;
  idempotency_key: string;
  attempt_hash: string;
  offer_id: string;
  demand_id: string;
  offer_owner_id: string;
  demand_owner_id: string;
  offer_content_version: number;
  demand_content_version: number;
  engine_offline_version: string;
  engine_scoring_version: string;
  scoring_config_hash: string;
  scoring_config: Record<string, unknown>;
  evaluated_at: Date;
  persisted_at: Date;
  expires_at: Date | null;
  eligibility_status: MatchingEligibilityStatus;
  eligibility_reasons: string[];
  compatibility_status: MatchingCompatibilityStatus;
  is_confirmed_match: boolean;
  score: string | number | null;
  coverage: string | number | null;
  evaluation_summary: Record<string, unknown>;
  scoring_summary: Record<string, unknown>;
  preferences_summary: Record<string, unknown>;
  evaluation_details: Record<string, unknown>;
  is_latest: boolean;
  is_stale: boolean;
  stale_reason: MatchingStaleReason | null;
  staled_at: Date | null;
}

const EVALUATION_SELECT_COLUMNS = `
  id, idempotency_key, attempt_hash, offer_id, demand_id, offer_owner_id, demand_owner_id,
  offer_content_version, demand_content_version, engine_offline_version, engine_scoring_version,
  scoring_config_hash, scoring_config, evaluated_at, persisted_at, expires_at,
  eligibility_status, eligibility_reasons, compatibility_status, is_confirmed_match,
  score::text AS score, coverage::text AS coverage, evaluation_summary, scoring_summary,
  preferences_summary, evaluation_details, is_latest, is_stale, stale_reason, staled_at
`;

export function canonicalJsonStringify(val: unknown): string {
  if (val === null || typeof val !== "object") {
    return JSON.stringify(val);
  }
  if (val instanceof Date) {
    return JSON.stringify(val.toISOString());
  }
  if (Array.isArray(val)) {
    return "[" + val.map((elem) => canonicalJsonStringify(elem)).join(",") + "]";
  }
  const obj = val as Record<string, unknown>;
  const keys = Object.getOwnPropertyNames(obj).sort();
  return (
    "{" +
    keys
      .map((k) => JSON.stringify(k) + ":" + canonicalJsonStringify((obj as Record<string, unknown>)[k]))
      .join(",") +
    "}"
  );
}

export function computeScoringConfigHash(scoringConfig: Record<string, unknown>): string {
  const canonical = canonicalJsonStringify(scoringConfig);
  return createHash("sha256").update(canonical).digest("hex");
}

export function normalizeScoringConfig(options?: MatchingScoringOptions): Record<string, unknown> {
  const defaultWeight = options?.defaultWeight ?? 1;
  const precision = options?.precision ?? 2;

  if (typeof defaultWeight !== "number" || !Number.isFinite(defaultWeight) || defaultWeight <= 0) {
    throw new MatchingScoringValidationError(
      `Poids par défaut invalide : attendu un nombre fini strictement positif, reçu ${String(defaultWeight)}.`,
    );
  }

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

  const config: Record<string, unknown> = {
    defaultWeight,
    precision,
  };

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
    const ownKeys = Object.getOwnPropertyNames(options.weights).sort();
    if (ownKeys.length > 0) {
      const sortedWeights: Record<string, number> = Object.create(null);
      for (const key of ownKeys) {
        const val = (options.weights as Record<string, unknown>)[key];
        if (typeof val !== "number" || !Number.isFinite(val) || val <= 0) {
          throw new MatchingScoringValidationError(
            `Poids invalide pour '${key}' : attendu un nombre fini strictement positif (> 0), reçu ${String(val)}.`,
          );
        }
        Object.defineProperty(sortedWeights, key, {
          value: val,
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      config.weights = sortedWeights;
    }
  }

  return config;
}

export function computeAttemptHash(params: {
  demandId: string;
  demandContentVersion: number;
  engineOfflineVersion: string;
  engineScoringVersion: string;
  evaluatedAt: Date;
  offerId: string;
  offerContentVersion: number;
  scoringConfigHash: string;
}): string {
  const canonical = canonicalJsonStringify({
    demandContentVersion: params.demandContentVersion,
    demandId: params.demandId,
    engineOfflineVersion: params.engineOfflineVersion,
    engineScoringVersion: params.engineScoringVersion,
    evaluatedAt: params.evaluatedAt.toISOString(),
    offerContentVersion: params.offerContentVersion,
    offerId: params.offerId,
    scoringConfigHash: params.scoringConfigHash,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

export function computeEvaluationExpiration(
  evaluatedAt: Date,
  offerDeadlineAt: Date | string | null | undefined,
  demandDeadlineAt: Date | string | null | undefined,
): Date | null {
  const tEval = evaluatedAt.getTime();
  const deadlines: number[] = [];

  if (offerDeadlineAt !== null && offerDeadlineAt !== undefined) {
    const oDate = new Date(offerDeadlineAt);
    if (!Number.isNaN(oDate.getTime())) {
      deadlines.push(oDate.getTime());
    }
  }

  if (demandDeadlineAt !== null && demandDeadlineAt !== undefined) {
    const dDate = new Date(demandDeadlineAt);
    if (!Number.isNaN(dDate.getTime())) {
      deadlines.push(dDate.getTime());
    }
  }

  const futureBoundaries = deadlines
    .map((d) => d + 1)
    .filter((boundary) => boundary > tEval);

  if (futureBoundaries.length === 0) {
    return null;
  }

  const earliestBoundary = Math.min(...futureBoundaries);
  return new Date(earliestBoundary);
}

function mapMatchingEvaluationRow(
  row: MatchingEvaluationRow,
  options?: { isReplayed?: boolean },
): PersistedMatchingEvaluation {
  return {
    id: row.id,
    idempotencyKey: row.idempotency_key,
    attemptHash: row.attempt_hash,
    offerId: row.offer_id,
    demandId: row.demand_id,
    offerOwnerId: row.offer_owner_id,
    demandOwnerId: row.demand_owner_id,
    offerContentVersion: row.offer_content_version,
    demandContentVersion: row.demand_content_version,
    engineOfflineVersion: row.engine_offline_version,
    engineScoringVersion: row.engine_scoring_version,
    scoringConfigHash: row.scoring_config_hash,
    scoringConfig: row.scoring_config,
    evaluatedAt: row.evaluated_at,
    persistedAt: row.persisted_at,
    expiresAt: row.expires_at,
    eligibilityStatus: row.eligibility_status,
    eligibilityReasons: row.eligibility_reasons ?? [],
    compatibilityStatus: row.compatibility_status,
    isConfirmedMatch: row.is_confirmed_match,
    score: row.score === null ? null : Number(row.score),
    coverage: row.coverage === null ? null : Number(row.coverage),
    evaluationSummary: row.evaluation_summary,
    scoringSummary: row.scoring_summary,
    preferencesSummary: row.preferences_summary,
    evaluationDetails: row.evaluation_details,
    isLatest: row.is_latest,
    isStale: row.is_stale,
    staleReason: row.stale_reason,
    staledAt: row.staled_at,
    isReplayed: options?.isReplayed ?? false,
  };
}

export async function persistEvaluatedMatch(
  options: PersistEvaluatedMatchOptions,
  pool?: unknown,
): Promise<PersistedMatchingEvaluation> {
  if (!options || typeof options !== "object") {
    throw new MatchingInputConsistencyError("options est requis.");
  }
  const idempotencyKey = requireUuid(options.idempotencyKey, "idempotencyKey");
  const evaluation = options.evaluation;
  if (!evaluation || typeof evaluation !== "object" || !evaluation.offer || !evaluation.demand) {
    throw new MatchingInputConsistencyError("evaluation valide est requise.");
  }

  if (!(evaluation.evaluatedAt instanceof Date) || Number.isNaN(evaluation.evaluatedAt.getTime())) {
    throw new MatchingInputConsistencyError("evaluation.evaluatedAt doit être une Date valide.");
  }

  if (
    typeof evaluation.offer.contentVersion !== "number" ||
    !Number.isInteger(evaluation.offer.contentVersion) ||
    evaluation.offer.contentVersion <= 0
  ) {
    throw new MatchingInputConsistencyError("evaluation.offer.contentVersion doit être un entier strictement positif.");
  }
  if (
    typeof evaluation.demand.contentVersion !== "number" ||
    !Number.isInteger(evaluation.demand.contentVersion) ||
    evaluation.demand.contentVersion <= 0
  ) {
    throw new MatchingInputConsistencyError("evaluation.demand.contentVersion doit être un entier strictement positif.");
  }

  const scoring = options.scoring;
  if (!scoring || typeof scoring !== "object") {
    throw new MatchingInputConsistencyError("scoring valide est requis.");
  }

  if (scoring.score !== null) {
    if (typeof scoring.score !== "number" || !Number.isFinite(scoring.score) || scoring.score < 0 || scoring.score > 100) {
      throw new MatchingInputConsistencyError("scoring.score doit être null ou un nombre fini compris entre 0 et 100.");
    }
  }
  if (scoring.coverage !== null) {
    if (typeof scoring.coverage !== "number" || !Number.isFinite(scoring.coverage) || scoring.coverage < 0 || scoring.coverage > 100) {
      throw new MatchingInputConsistencyError("scoring.coverage doit être null ou un nombre fini compris entre 0 et 100.");
    }
  }
  if (!scoring.summary || typeof scoring.summary !== "object" || Array.isArray(scoring.summary)) {
    throw new MatchingInputConsistencyError("scoring.summary doit être un objet.");
  }
  if (!scoring.contributions || typeof scoring.contributions !== "object" || Array.isArray(scoring.contributions)) {
    throw new MatchingInputConsistencyError("scoring.contributions doit être un objet.");
  }
  if (!scoring.preferences || typeof scoring.preferences !== "object" || Array.isArray(scoring.preferences)) {
    throw new MatchingInputConsistencyError("scoring.preferences doit être un objet.");
  }
  if (!(scoring.evaluationTimestamp instanceof Date) || Number.isNaN(scoring.evaluationTimestamp.getTime())) {
    throw new MatchingInputConsistencyError("scoring.evaluationTimestamp doit être une Date valide.");
  }

  const offerId = requireUuid(evaluation.offer.id, "evaluation.offer.id");
  const demandId = requireUuid(evaluation.demand.id, "evaluation.demand.id");

  if (options.offerId !== undefined && options.offerId !== offerId) {
    throw new MatchingInputConsistencyError("offerId ne correspond pas à l'offre de l'évaluation.");
  }
  if (options.demandId !== undefined && options.demandId !== demandId) {
    throw new MatchingInputConsistencyError("demandId ne correspond pas à la demande de l'évaluation.");
  }

  if (options.offer) {
    if (options.offer.id !== offerId) {
      throw new MatchingInputConsistencyError("offer.id ne correspond pas à l'évaluation.");
    }
    if (options.offer.contentVersion !== evaluation.offer.contentVersion) {
      throw new MatchingInputConsistencyError("offer.contentVersion ne correspond pas à l'évaluation.");
    }
    if (options.offer.ownerId !== evaluation.offer.ownerId) {
      throw new MatchingInputConsistencyError("offer.ownerId ne correspond pas à l'évaluation.");
    }
  }

  if (options.demand) {
    if (options.demand.id !== demandId) {
      throw new MatchingInputConsistencyError("demand.id ne correspond pas à l'évaluation.");
    }
    if (options.demand.contentVersion !== evaluation.demand.contentVersion) {
      throw new MatchingInputConsistencyError("demand.contentVersion ne correspond pas à l'évaluation.");
    }
    if (options.demand.ownerId !== evaluation.demand.ownerId) {
      throw new MatchingInputConsistencyError("demand.ownerId ne correspond pas à l'évaluation.");
    }
  }

  if (offerId === demandId) {
    throw new MatchingInputConsistencyError("Une offre et une demande ne peuvent pas avoir le même identifiant.");
  }

  const offerOwnerId = requireUuid(evaluation.offer.ownerId, "offerOwnerId");
  const demandOwnerId = requireUuid(evaluation.demand.ownerId, "demandOwnerId");
  if (offerOwnerId === demandOwnerId) {
    throw new MatchingInputConsistencyError("Auto-matching interdit : l'offre et la demande appartiennent au même propriétaire.");
  }

  // Vérifications croisées avec scoring
  if (scoring.offerId !== offerId) {
    throw new MatchingInputConsistencyError("scoring.offerId ne correspond pas à l'évaluation.");
  }
  if (scoring.demandId !== demandId) {
    throw new MatchingInputConsistencyError("scoring.demandId ne correspond pas à l'évaluation.");
  }
  if (scoring.evaluationTimestamp.getTime() !== evaluation.evaluatedAt.getTime()) {
    throw new MatchingInputConsistencyError("scoring.evaluationTimestamp ne correspond pas à evaluation.evaluatedAt.");
  }
  if (scoring.eligibilityStatus !== evaluation.eligibility.status) {
    throw new MatchingInputConsistencyError("scoring.eligibilityStatus ne correspond pas à l'évaluation.");
  }
  if (scoring.compatibilityStatus !== evaluation.compatibility.status) {
    throw new MatchingInputConsistencyError("scoring.compatibilityStatus ne correspond pas à l'évaluation.");
  }
  if (scoring.isEligible !== (evaluation.eligibility.status === "eligible")) {
    throw new MatchingInputConsistencyError("scoring.isEligible incohérent avec eligibility.status.");
  }
  if (scoring.isCompatible !== (evaluation.compatibility.status === "compatible")) {
    throw new MatchingInputConsistencyError("scoring.isCompatible incohérent avec compatibility.status.");
  }

  // Validation de la configuration de scoring AVANT toute acquisition de connexion
  const scoringConfig = normalizeScoringConfig(options.scoringOptions);
  const scoringConfigHash = computeScoringConfigHash(scoringConfig);

  // Recalcul déterministe via computeMatchingScore et comparaison exhaustive des champs
  const expectedScoring = computeMatchingScore(evaluation, options.scoringOptions);

  if (scoring.score !== expectedScoring.score) {
    throw new MatchingInputConsistencyError(
      `scoring.score divergent : attendu ${String(expectedScoring.score)}, reçu ${String(scoring.score)}.`,
    );
  }
  if (scoring.coverage !== expectedScoring.coverage) {
    throw new MatchingInputConsistencyError(
      `scoring.coverage divergent : attendu ${String(expectedScoring.coverage)}, reçu ${String(scoring.coverage)}.`,
    );
  }
  if (scoring.eligibilityStatus !== expectedScoring.eligibilityStatus) {
    throw new MatchingInputConsistencyError("scoring.eligibilityStatus ne correspond pas au calcul déterministe.");
  }
  if (scoring.compatibilityStatus !== expectedScoring.compatibilityStatus) {
    throw new MatchingInputConsistencyError("scoring.compatibilityStatus ne correspond pas au calcul déterministe.");
  }
  if (scoring.isEligible !== expectedScoring.isEligible) {
    throw new MatchingInputConsistencyError("scoring.isEligible ne correspond pas au calcul déterministe.");
  }
  if (scoring.isCompatible !== expectedScoring.isCompatible) {
    throw new MatchingInputConsistencyError("scoring.isCompatible ne correspond pas au calcul déterministe.");
  }
  if (canonicalJsonStringify(scoring.summary) !== canonicalJsonStringify(expectedScoring.summary)) {
    throw new MatchingInputConsistencyError("scoring.summary divergent de la synthèse déterministe attendue.");
  }
  if (canonicalJsonStringify(scoring.contributions) !== canonicalJsonStringify(expectedScoring.contributions)) {
    throw new MatchingInputConsistencyError("scoring.contributions divergent des contributions déterministes attendues.");
  }
  if (canonicalJsonStringify(scoring.preferences) !== canonicalJsonStringify(expectedScoring.preferences)) {
    throw new MatchingInputConsistencyError("scoring.preferences divergent des préférences déterministes attendues.");
  }

  const engineOfflineVersion = evaluation.contractVersion ?? MATCHING_OFFLINE_CONTRACT_VERSION;
  const engineScoringVersion = scoring.contractVersion ?? MATCHING_SCORING_CONTRACT_VERSION;
  const evaluatedAt = evaluation.evaluatedAt;

  const attemptHash = computeAttemptHash({
    demandContentVersion: evaluation.demand.contentVersion,
    demandId,
    engineOfflineVersion,
    engineScoringVersion,
    evaluatedAt,
    offerContentVersion: evaluation.offer.contentVersion,
    offerId,
    scoringConfigHash,
  });

  const expectedOfferVersion = evaluation.offer.contentVersion;
  const expectedDemandVersion = evaluation.demand.contentVersion;

  // Acquisition de connexion uniquement après toutes les validations préalables
  const targetPool = requireTransactionPool(options.db ?? options.pool ?? pool);
  const client: PoolClient = await targetPool.connect();

  try {
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    await client.query("SET LOCAL lock_timeout = '3s'");
    await client.query("SET LOCAL statement_timeout = '5s'");

    // 1. Sérialisation globale sur la clé d'idempotence (couvre même les paires distinctes)
    await client.query(
      "SELECT pg_advisory_xact_lock($1, hashtext($2))",
      [IDEMPOTENCY_LOCK_NAMESPACE, idempotencyKey],
    );

    // 2. Contrôle d'idempotence de la tentative
    const existingAttempt = await client.query<MatchingEvaluationRow>(
      `SELECT ${EVALUATION_SELECT_COLUMNS}
         FROM matching_evaluations
        WHERE idempotency_key = $1`,
      [idempotencyKey],
    );

    if (existingAttempt.rowCount) {
      const existing = existingAttempt.rows[0];
      if (existing.attempt_hash === attemptHash) {
        await client.query("COMMIT");
        return mapMatchingEvaluationRow(existing, { isReplayed: true });
      }
      throw new MatchingIdempotencyConflictError();
    }

    // 3. Verrouillage ordonné des comptes utilisateurs (FOR SHARE)
    if (offerOwnerId === demandOwnerId) {
      throw new StalePreconditionsError("Auto-matching interdit : même propriétaire.");
    }
    const uFirst = offerOwnerId.localeCompare(demandOwnerId) < 0 ? offerOwnerId : demandOwnerId;
    const uSecond = offerOwnerId.localeCompare(demandOwnerId) < 0 ? demandOwnerId : offerOwnerId;

    const u1Res = await client.query<{ id: string; status: string }>(
      "SELECT id, status FROM users WHERE id = $1 FOR SHARE",
      [uFirst],
    );
    const u2Res = await client.query<{ id: string; status: string }>(
      "SELECT id, status FROM users WHERE id = $1 FOR SHARE",
      [uSecond],
    );

    if (
      !u1Res.rowCount ||
      !u2Res.rowCount ||
      u1Res.rows[0].status !== "active" ||
      u2Res.rows[0].status !== "active"
    ) {
      throw new StalePreconditionsError("L'un des comptes propriétaires n'est pas actif.");
    }

    // 4. Verrouillage ordonné des ressources avec départage strict par type ('demands' puis 'offers')
    const demandRes = await client.query<{
      id: string;
      content_version: number;
      status: string;
      deadline_at: Date | null;
      owner_id: string;
    }>(
      "SELECT id, content_version, status, deadline_at, owner_id FROM demands WHERE id = $1 FOR SHARE",
      [demandId],
    );
    const offerRes = await client.query<{
      id: string;
      content_version: number;
      status: string;
      availability_status: string | null;
      deadline_at: Date | null;
      owner_id: string;
    }>(
      "SELECT id, content_version, status, availability_status, deadline_at, owner_id FROM offers WHERE id = $1 FOR SHARE",
      [offerId],
    );

    if (!demandRes.rowCount || !offerRes.rowCount) {
      throw new StalePreconditionsError("Offre ou demande introuvable.");
    }

    const currentDemand = demandRes.rows[0];
    const currentOffer = offerRes.rows[0];

    // Vérification de fraîcheur post-lock
    if (
      currentDemand.status !== "active" ||
      currentDemand.content_version !== expectedDemandVersion ||
      currentDemand.owner_id !== demandOwnerId
    ) {
      throw new StalePreconditionsError("La demande a été modifiée ou n'est plus active.");
    }

    if (
      currentOffer.status !== "published" ||
      currentOffer.availability_status === "unavailable" ||
      currentOffer.content_version !== expectedOfferVersion ||
      currentOffer.owner_id !== offerOwnerId
    ) {
      throw new StalePreconditionsError("L'offre a été modifiée, est indisponible ou n'est pas publiée.");
    }

    // 5. Sérialisation de la paire de matching
    const pairKey =
      offerId.localeCompare(demandId) < 0
        ? `${offerId}:${demandId}`
        : `${demandId}:${offerId}`;

    await client.query(
      "SELECT pg_advisory_xact_lock($1, hashtext($2))",
      [MATCHING_PAIR_LOCK_NAMESPACE, pairKey],
    );

    // Calcul de la borne temporelle d'expiration
    const expiresAt = computeEvaluationExpiration(
      evaluatedAt,
      currentOffer.deadline_at,
      currentDemand.deadline_at,
    );

    // 6. Contrôle d'horloge fraîche post-lock vs expiration
    const clockRes = await client.query<{ fresh_now: Date }>(
      "SELECT clock_timestamp() AS fresh_now",
    );
    const freshNow = clockRes.rows[0].fresh_now;

    if (expiresAt !== null && freshNow.getTime() >= expiresAt.getTime()) {
      throw new EvaluationExpiredDuringLockWaitError();
    }

    // 7. Barrière historique contre les tentatives anciennes retardées
    const maxRes = await client.query<{ max_evaluated_at: Date | null }>(
      "SELECT MAX(evaluated_at) AS max_evaluated_at FROM matching_evaluations WHERE offer_id = $1 AND demand_id = $2",
      [offerId, demandId],
    );

    const maxEvaluatedAt = maxRes.rows[0]?.max_evaluated_at;
    if (maxEvaluatedAt !== null && maxEvaluatedAt !== undefined) {
      const maxTime = new Date(maxEvaluatedAt).getTime();
      if (evaluatedAt.getTime() < maxTime) {
        throw new StaleAttemptSupersededError();
      }
    }

    // 8. Archivage atomique de l'évaluation courante active
    await client.query(
      `UPDATE matching_evaluations
          SET is_latest = FALSE,
              is_stale = TRUE,
              stale_reason = 'superseded_by_reevaluation',
              staled_at = clock_timestamp()
        WHERE offer_id = $1 AND demand_id = $2 AND is_latest = TRUE`,
      [offerId, demandId],
    );

    // 9. Insertion de la nouvelle évaluation active
    const evaluationSummary = {
      eligibilityReasons: evaluation.eligibility.reasons,
      criteriaSummary: evaluation.compatibility.summary,
    };
    const scoringSummary = scoring.summary;
    const preferencesSummary = scoring.preferences;
    const evaluationDetails = {
      criteria: evaluation.compatibility.criteria,
      contributions: scoring.contributions,
      preferences: evaluation.preferences,
      availability: evaluation.availability,
      marketPrice: evaluation.marketPrice,
      confidence: evaluation.confidence,
    };

    const insertResult = await client.query<MatchingEvaluationRow>(
      `INSERT INTO matching_evaluations (
         idempotency_key, attempt_hash,
         offer_id, demand_id, offer_owner_id, demand_owner_id,
         offer_content_version, demand_content_version,
         engine_offline_version, engine_scoring_version, scoring_config_hash, scoring_config,
         evaluated_at, expires_at,
         eligibility_status, eligibility_reasons, compatibility_status,
         score, coverage,
         evaluation_summary, scoring_summary, preferences_summary, evaluation_details,
         is_latest, is_stale
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
         $15, $16, $17, $18, $19, $20, $21, $22, $23, TRUE, FALSE
       )
       RETURNING ${EVALUATION_SELECT_COLUMNS}`,
      [
        idempotencyKey,
        attemptHash,
        offerId,
        demandId,
        offerOwnerId,
        demandOwnerId,
        expectedOfferVersion,
        expectedDemandVersion,
        engineOfflineVersion,
        engineScoringVersion,
        scoringConfigHash,
        JSON.stringify(scoringConfig),
        evaluatedAt,
        expiresAt,
        evaluation.eligibility.status,
        evaluation.eligibility.reasons,
        evaluation.compatibility.status,
        scoring.score,
        scoring.coverage,
        JSON.stringify(evaluationSummary),
        JSON.stringify(scoringSummary),
        JSON.stringify(preferencesSummary),
        JSON.stringify(evaluationDetails),
      ],
    );

    await client.query("COMMIT");
    return mapMatchingEvaluationRow(insertResult.rows[0]);
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Ignorer l'erreur de rollback
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function getActiveMatchingEvaluation(
  options: GetActiveMatchingEvaluationOptions,
  db?: SqlExecutor,
): Promise<PersistedMatchingEvaluation | null> {
  const offerId = requireUuid(options.offerId, "offerId");
  const demandId = requireUuid(options.demandId, "demandId");
  const engineOfflineVersion = options.expectedEngineOfflineVersion ?? MATCHING_OFFLINE_CONTRACT_VERSION;
  const engineScoringVersion = options.expectedEngineScoringVersion ?? MATCHING_SCORING_CONTRACT_VERSION;

  const expectedConfigHash =
    options.expectedScoringConfigHash ??
    computeScoringConfigHash(normalizeScoringConfig());

  if (typeof expectedConfigHash !== "string" || !/^[0-9a-f]{64}$/.test(expectedConfigHash)) {
    throw new MatchingPersistenceError("expectedScoringConfigHash doit être un SHA-256 hexadécimal de 64 caractères.");
  }

  const executor = (options.db ?? options.pool ?? db ?? getPostgresPool()) as SqlExecutor;

  const conditions = [
    "e.offer_id = $1",
    "e.demand_id = $2",
    "e.is_latest = TRUE",
    "e.is_stale = FALSE",
    "o.content_version = e.offer_content_version",
    "d.content_version = e.demand_content_version",
    "e.offer_owner_id = o.owner_id",
    "e.demand_owner_id = d.owner_id",
    "o.owner_id <> d.owner_id",
    "o.status = 'published'",
    "o.availability_status IS DISTINCT FROM 'unavailable'",
    "d.status = 'active'",
    "uo.status = 'active'",
    "ud.status = 'active'",
    "e.engine_offline_version = $3",
    "e.engine_scoring_version = $4",
    "e.scoring_config_hash = $5",
    "(e.expires_at IS NULL OR e.expires_at > c.fresh_now)",
  ];

  const values: unknown[] = [
    offerId,
    demandId,
    engineOfflineVersion,
    engineScoringVersion,
    expectedConfigHash,
  ];

  const query = `
    WITH current_clock AS (
      SELECT clock_timestamp() AS fresh_now
    )
    SELECT e.*
      FROM matching_evaluations e
      JOIN offers o ON o.id = e.offer_id
      JOIN demands d ON d.id = e.demand_id
      JOIN users uo ON uo.id = e.offer_owner_id
      JOIN users ud ON ud.id = e.demand_owner_id
      CROSS JOIN current_clock c
     WHERE ${conditions.join("\n       AND ")}
     LIMIT 1
  `;

  const result = await executor.query<MatchingEvaluationRow>(query, values);
  return result.rowCount ? mapMatchingEvaluationRow(result.rows[0]) : null;
}

export async function invalidateMatchesForOffer(
  executor: SqlExecutor,
  offerId: string,
  reason: MatchingStaleReason,
): Promise<number> {
  const result = await executor.query(
    `UPDATE matching_evaluations
        SET is_stale = TRUE,
            is_latest = FALSE,
            stale_reason = $2,
            staled_at = clock_timestamp()
      WHERE offer_id = $1 AND is_latest = TRUE`,
    [requireUuid(offerId, "offerId"), reason],
  );
  return result.rowCount ?? 0;
}

export async function invalidateMatchesForDemand(
  executor: SqlExecutor,
  demandId: string,
  reason: MatchingStaleReason,
): Promise<number> {
  const result = await executor.query(
    `UPDATE matching_evaluations
        SET is_stale = TRUE,
            is_latest = FALSE,
            stale_reason = $2,
            staled_at = clock_timestamp()
      WHERE demand_id = $1 AND is_latest = TRUE`,
    [requireUuid(demandId, "demandId"), reason],
  );
  return result.rowCount ?? 0;
}

export async function invalidateMatchesForUser(
  executor: SqlExecutor,
  userId: string,
  reason: MatchingStaleReason,
): Promise<number> {
  const result = await executor.query(
    `UPDATE matching_evaluations
        SET is_stale = TRUE,
            is_latest = FALSE,
            stale_reason = $2,
            staled_at = clock_timestamp()
      WHERE (offer_owner_id = $1 OR demand_owner_id = $1) AND is_latest = TRUE`,
    [requireUuid(userId, "userId"), reason],
  );
  return result.rowCount ?? 0;
}
