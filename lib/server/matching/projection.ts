import "server-only";

import { createHash } from "node:crypto";
import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { requireUuid } from "../catalog/validation";
import {
  OUTBOX_COLUMNS,
  mapOutboxRow,
  type OutboxEventRecord,
  type OutboxEventType,
  type OutboxRow,
} from "./outbox";
import { canonicalJsonStringify, computeScoringConfigHash } from "./persistence";

const MAX_INTEGER = 2_147_483_647;
const SHA256_HEX = /^[0-9a-f]{64}$/;

export type MatchingProjectedJobType =
  | "evaluate_offer_candidates"
  | "evaluate_demand_candidates"
  | "reevaluate_pair_temporal"
  | "user_reactivation_sweep";

const JOB_TYPES = new Set<string>([
  "evaluate_offer_candidates",
  "evaluate_demand_candidates",
  "reevaluate_pair_temporal",
  "scoring_config_sweep",
  "user_reactivation_sweep",
]);

export class MatchingProjectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MatchingProjectionError";
  }
}

/** Un job déjà présent diverge de celui que l'événement produirait : le lot est annulé. */
export class MatchingProjectionIntegrityError extends MatchingProjectionError {
  constructor(message: string) {
    super(message);
    this.name = "MatchingProjectionIntegrityError";
  }
}

export interface ComputeJobIdentityInput {
  generation: number;
  jobType: string;
  resourceId: string;
  resourceVersion: number;
  scoringConfigHash: string;
  sourceEventId: string;
  targetResourceId?: string | null;
}

function requireBoundedInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > MAX_INTEGER) {
    throw new MatchingProjectionError(`${field} doit être un entier entre 1 et ${MAX_INTEGER}.`);
  }
  return value;
}

function requireProjectionUuid(value: unknown, field: string): string {
  if (typeof value !== "string") throw new MatchingProjectionError(`${field} doit être un UUID valide.`);
  try {
    return requireUuid(value, field);
  } catch {
    throw new MatchingProjectionError(`${field} doit être un UUID valide.`);
  }
}

/** SHA-256 hexadécimal de l'objet canonique décrit au plan 2E1 §4 (clés snake_case, cible nulle explicite). */
export function computeJobIdentity(input: ComputeJobIdentityInput): string {
  if (typeof input.jobType !== "string" || !JOB_TYPES.has(input.jobType)) {
    throw new MatchingProjectionError("jobType inconnu.");
  }
  if (typeof input.scoringConfigHash !== "string" || !SHA256_HEX.test(input.scoringConfigHash)) {
    throw new MatchingProjectionError("scoringConfigHash doit être un hash SHA-256 hexadécimal de 64 caractères.");
  }
  const targetResourceId = input.targetResourceId === undefined || input.targetResourceId === null
    ? null
    : requireProjectionUuid(input.targetResourceId, "targetResourceId");
  const canonical = canonicalJsonStringify({
    generation: requireBoundedInteger(input.generation, "generation"),
    job_type: input.jobType,
    resource_id: requireProjectionUuid(input.resourceId, "resourceId"),
    resource_version: requireBoundedInteger(input.resourceVersion, "resourceVersion"),
    scoring_config_hash: input.scoringConfigHash,
    source_event_id: requireProjectionUuid(input.sourceEventId, "sourceEventId"),
    target_resource_id: targetResourceId,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

export interface PlannedMatchingJob {
  jobIdentity: string;
  jobType: MatchingProjectedJobType;
  resourceId: string;
  resourceVersion: number;
  targetResourceId: string | null;
  scoringConfigHash: string;
  sourceEventId: string;
  generation: number;
}

export type OutboxProjectionIgnoredReason = "resource_not_eligible" | "non_search_event";

export type OutboxProjectionInvalidCode =
  | "unsupported_event_type"
  | "aggregate_mismatch"
  | "unexpected_target"
  | "invalid_aggregate_version"
  | "generation_mismatch"
  | "invalid_payload_status"
  | "invalid_availability_status"
  | "invalid_eligibility_flag"
  | "eligibility_status_mismatch"
  | "invalid_user_status"
  | "missing_target"
  | "invalid_target"
  | "invalid_expired_evaluation_id"
  | "target_payload_mismatch"
  | "invalid_scoring_config"
  | "invalid_scoring_config_hash"
  | "scoring_config_hash_mismatch"
  | "invalid_engine_version"
  | "invalid_job_identity_input";

export type OutboxProjectionDecision =
  | { kind: "job"; job: PlannedMatchingJob }
  | { kind: "ignored"; reason: OutboxProjectionIgnoredReason }
  | { kind: "invalid"; code: OutboxProjectionInvalidCode };

interface SearchRoute {
  aggregateType: "offer" | "demand" | "user" | "temporal";
  jobType: MatchingProjectedJobType;
}

const SEARCH_ROUTES: Partial<Record<OutboxEventType, SearchRoute>> = {
  "offer.created": { aggregateType: "offer", jobType: "evaluate_offer_candidates" },
  "offer.published": { aggregateType: "offer", jobType: "evaluate_offer_candidates" },
  "offer.available": { aggregateType: "offer", jobType: "evaluate_offer_candidates" },
  "offer.updated": { aggregateType: "offer", jobType: "evaluate_offer_candidates" },
  "demand.created": { aggregateType: "demand", jobType: "evaluate_demand_candidates" },
  "demand.activated": { aggregateType: "demand", jobType: "evaluate_demand_candidates" },
  "demand.updated": { aggregateType: "demand", jobType: "evaluate_demand_candidates" },
  "user.reactivated": { aggregateType: "user", jobType: "user_reactivation_sweep" },
  // Agrégat 'temporal' : aggregate_id = offre, aggregate_version = version de l'offre, target = demande (2E4C2).
  "temporal.deadline_passed": { aggregateType: "temporal", jobType: "reevaluate_pair_temporal" },
};

const NON_SEARCH_EVENTS = new Set<OutboxEventType>([
  "offer.paused",
  "offer.unavailable",
  "offer.archived",
  "demand.satisfied",
  "demand.archived",
  "user.suspended",
  "user.archived",
]);

/** Types lus par le projecteur. Les événements scoring_config et bootstrap restent pending (lots suivants). */
export const PROJECTABLE_EVENT_TYPES: readonly OutboxEventType[] = [
  ...Object.keys(SEARCH_ROUTES) as OutboxEventType[],
  ...NON_SEARCH_EVENTS,
];

const invalid = (code: OutboxProjectionInvalidCode): OutboxProjectionDecision => ({ kind: "invalid", code });

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Décision pure à partir du seul payload scellé : aucune configuration courante n'est relue
 * et le contenu du payload n'est jamais recopié dans les codes d'invalidité.
 */
export function planOutboxProjection(event: OutboxEventRecord): OutboxProjectionDecision {
  if (NON_SEARCH_EVENTS.has(event.eventType)) return { kind: "ignored", reason: "non_search_event" };
  // Object.hasOwn : un eventType comme "constructor" ou "__proto__" ne doit pas atteindre le prototype.
  const route = Object.hasOwn(SEARCH_ROUTES, event.eventType) ? SEARCH_ROUTES[event.eventType] : undefined;
  if (!route) return invalid("unsupported_event_type");

  if (event.aggregateType !== route.aggregateType) return invalid("aggregate_mismatch");
  const temporal = route.aggregateType === "temporal";
  if (temporal) {
    if (event.targetAggregateId === null || event.targetAggregateId === undefined) return invalid("missing_target");
    try {
      requireProjectionUuid(event.targetAggregateId, "targetAggregateId");
    } catch {
      return invalid("invalid_target");
    }
  } else if (event.targetAggregateId !== null) {
    return invalid("unexpected_target");
  }
  const version = event.aggregateVersion;
  if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 1 || version > MAX_INTEGER) {
    return invalid("invalid_aggregate_version");
  }
  const payload = event.payload;
  if (!isPlainObject(payload)) return invalid("invalid_payload_status");
  if (payload.generation !== version) return invalid("generation_mismatch");

  // L'événement temporel n'a ni statut ni éligibilité : la paire est relue par le worker.
  if (!temporal) {
    if (typeof payload.status !== "string") return invalid("invalid_payload_status");
    if (route.aggregateType === "user") {
      if (payload.status !== "active") return invalid("invalid_user_status");
    } else {
      if (typeof payload.eligible !== "boolean") return invalid("invalid_eligibility_flag");
      let expected: boolean;
      if (route.aggregateType === "offer") {
        const availability = payload.availability_status;
        if (availability !== undefined && availability !== null && typeof availability !== "string") {
          return invalid("invalid_availability_status");
        }
        expected = payload.status === "published" && availability !== "unavailable";
      } else {
        expected = payload.status === "active";
      }
      if (payload.eligible !== expected) return invalid("eligibility_status_mismatch");
      if (!payload.eligible) return { kind: "ignored", reason: "resource_not_eligible" };
    }
  }

  const config = payload.scoring_config;
  if (!isPlainObject(config)) return invalid("invalid_scoring_config");
  const hash = payload.scoring_config_hash;
  if (typeof hash !== "string" || !SHA256_HEX.test(hash)) return invalid("invalid_scoring_config_hash");
  if (hash !== computeScoringConfigHash(config)) return invalid("scoring_config_hash_mismatch");
  for (const field of ["engine_offline_version", "engine_scoring_version"] as const) {
    const value = payload[field];
    if (typeof value !== "string" || value.length === 0) return invalid("invalid_engine_version");
  }

  if (temporal) {
    try {
      requireProjectionUuid(payload.expiredEvaluationId, "expiredEvaluationId");
    } catch {
      return invalid("invalid_expired_evaluation_id");
    }
    if (payload.demandId !== event.targetAggregateId) return invalid("target_payload_mismatch");
  }

  let jobIdentity: string;
  try {
    jobIdentity = computeJobIdentity({
      generation: version,
      jobType: route.jobType,
      resourceId: event.aggregateId,
      resourceVersion: version,
      scoringConfigHash: hash,
      sourceEventId: event.id,
      targetResourceId: temporal ? event.targetAggregateId : null,
    });
  } catch {
    return invalid("invalid_job_identity_input");
  }
  return {
    kind: "job",
    job: {
      jobIdentity,
      jobType: route.jobType,
      resourceId: event.aggregateId,
      resourceVersion: version,
      targetResourceId: temporal ? event.targetAggregateId : null,
      scoringConfigHash: hash,
      sourceEventId: event.id,
      generation: version,
    },
  };
}

export interface ProjectOutboxBatchHooks {
  /** Après la sélection verrouillée, avant toute décision. Réservé aux tests. */
  afterSelect?: (events: readonly OutboxEventRecord[]) => void | Promise<void>;
  /** Après l'éventuelle insertion du job, avant l'acquittement de l'événement. Réservé aux tests. */
  beforeAcknowledge?: (event: OutboxEventRecord, decision: OutboxProjectionDecision) => void | Promise<void>;
}

export interface ProjectOutboxBatchOptions {
  pool: Pool;
  limit?: number;
  hooks?: ProjectOutboxBatchHooks;
}

export interface ProjectOutboxBatchResult {
  selected: number;
  projected: number;
  jobsInserted: number;
  jobsAlreadyPresent: number;
  ignored: number;
  invalid: number;
  /**
   * Événements dont le job existant diverge (même identité, champs différents) : acquittés `ignored` avec
   * `job_integrity_conflict`, sans toucher au job. Présent seulement s'il est > 0.
   */
  quarantined?: number;
}

/** Code stable posé en `error_message` d'un événement mis en quarantaine (autorisé par 0009 : statut ignored). */
export const JOB_INTEGRITY_CONFLICT_CODE = "job_integrity_conflict";

const DEFAULT_PROJECTION_LIMIT = 50;
const MAX_PROJECTION_LIMIT = 100;

interface ExistingJobRow extends QueryResultRow {
  job_type: string;
  resource_id: string;
  resource_version: number;
  target_resource_id: string | null;
  scoring_config_hash: string | null;
  source_event_id: string | null;
}

/** Insertion idempotente d'un job (ON CONFLICT DO NOTHING) avec contrôle d'intégrité de l'existant. true = inséré. */
export async function insertJob(client: PoolClient, job: PlannedMatchingJob): Promise<boolean> {
  const inserted = await client.query(
    `INSERT INTO matching_jobs (
       job_identity, job_type, resource_id, resource_version,
       target_resource_id, scoring_config_hash, source_event_id
     ) VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (job_identity) DO NOTHING
     RETURNING id`,
    [
      job.jobIdentity, job.jobType, job.resourceId, job.resourceVersion,
      job.targetResourceId, job.scoringConfigHash, job.sourceEventId,
    ],
  );
  if (inserted.rowCount === 1) return true;

  const existing = await client.query<ExistingJobRow>(
    `SELECT job_type, resource_id, resource_version, target_resource_id,
            scoring_config_hash, source_event_id
       FROM matching_jobs WHERE job_identity = $1`,
    [job.jobIdentity],
  );
  const row = existing.rows[0];
  if (
    !row ||
    row.job_type !== job.jobType ||
    row.resource_id !== job.resourceId ||
    row.resource_version !== job.resourceVersion ||
    row.target_resource_id !== job.targetResourceId ||
    row.scoring_config_hash !== job.scoringConfigHash ||
    row.source_event_id !== job.sourceEventId
  ) {
    throw new MatchingProjectionIntegrityError(
      "Un job existant porte la même identité mais des champs différents.",
    );
  }
  return false;
}

/**
 * Projette un lot d'événements outbox en jobs, puis les acquitte, dans une seule transaction.
 * Un job existant divergent met seulement CET événement en quarantaine (savepoint) ; toute autre erreur annule le lot.
 * Aucun job n'est réservé ni exécuté ici (lots 2E3B et 2E4).
 */
export async function projectOutboxBatch(
  options: ProjectOutboxBatchOptions,
): Promise<ProjectOutboxBatchResult> {
  const { pool, hooks } = options;
  const limit = options.limit ?? DEFAULT_PROJECTION_LIMIT;
  if (!(pool instanceof Pool)) {
    throw new MatchingProjectionError("Un pool PostgreSQL (Pool) est requis pour la projection.");
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PROJECTION_LIMIT) {
    throw new MatchingProjectionError(`limit doit être un entier entre 1 et ${MAX_PROJECTION_LIMIT}.`);
  }

  const result: ProjectOutboxBatchResult = {
    selected: 0, projected: 0, jobsInserted: 0, jobsAlreadyPresent: 0, ignored: 0, invalid: 0,
  };
  const client = await pool.connect();
  let rollbackFailed = false;
  try {
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    await client.query("SET LOCAL lock_timeout = '3s'");
    await client.query("SET LOCAL statement_timeout = '5s'");

    const selection = await client.query<OutboxRow>(
      `SELECT ${OUTBOX_COLUMNS}
         FROM matching_outbox_events
        WHERE dispatch_status = 'pending' AND event_type = ANY($1::text[])
        ORDER BY occurred_at, id
        LIMIT $2
        FOR UPDATE SKIP LOCKED`,
      [PROJECTABLE_EVENT_TYPES, limit],
    );
    const events = selection.rows.map(mapOutboxRow);
    result.selected = events.length;
    await hooks?.afterSelect?.(events);

    for (const event of events) {
      // Point de reprise par événement : seul un conflit d'intégrité de job (déterministe, il se reproduirait
      // à chaque essai) met l'événement en quarantaine. Toute autre erreur annule le lot entier.
      await client.query("SAVEPOINT projection_event");
      const decision = planOutboxProjection(event);
      let outcome: "projected" | "ignored" | "invalid" | "quarantined" | "present" = "ignored";
      let errorMessage: string | null = null;
      if (decision.kind === "job") {
        try {
          outcome = (await insertJob(client, decision.job)) ? "projected" : "present";
        } catch (error) {
          if (!(error instanceof MatchingProjectionIntegrityError)) throw error;
          await client.query("ROLLBACK TO SAVEPOINT projection_event");
          outcome = "quarantined";
          errorMessage = JOB_INTEGRITY_CONFLICT_CODE;
        }
      } else if (decision.kind === "invalid") {
        outcome = "invalid";
        errorMessage = decision.code;
      }
      await hooks?.beforeAcknowledge?.(event, decision);

      const acknowledged = await client.query(
        `UPDATE matching_outbox_events
            SET dispatch_status = $2, dispatched_at = clock_timestamp(), error_message = $3
          WHERE id = $1 AND dispatch_status = 'pending'`,
        [event.id, outcome === "projected" || outcome === "present" ? "projected" : "ignored", errorMessage],
      );
      if (acknowledged.rowCount !== 1) {
        throw new MatchingProjectionIntegrityError("Acquittement d'événement outbox impossible : lot annulé.");
      }
      await client.query("RELEASE SAVEPOINT projection_event");

      if (outcome === "projected") { result.jobsInserted++; result.projected++; }
      else if (outcome === "present") { result.jobsAlreadyPresent++; result.projected++; }
      else if (outcome === "invalid") result.invalid++;
      else if (outcome === "quarantined") result.quarantined = (result.quarantined ?? 0) + 1;
      else result.ignored++;
    }
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      rollbackFailed = true;
    }
    throw error;
  } finally {
    client.release(rollbackFailed ? new Error("rollback failed") : undefined);
  }
}
