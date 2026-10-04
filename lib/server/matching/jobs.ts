import "server-only";

import { Pool, type QueryResultRow } from "pg";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const WORKER_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const ERROR_CODE = /^[a-z0-9_.:-]{1,120}$/;

export const DEFAULT_JOB_LEASE_SECONDS = 90;
const MIN_LEASE_SECONDS = 15;
const MAX_LEASE_SECONDS = 600;
const MAX_CLAIM_LIMIT = 50;

export class MatchingJobValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MatchingJobValidationError";
  }
}

export interface JobLease {
  jobId: string;
  claimToken: string;
  workerId: string;
  attempts: number;
  maxAttempts: number;
  lockExpiresAt: Date;
  jobType: string;
  resourceId: string;
  resourceVersion: number;
  targetResourceId: string | null;
  scoringConfigHash: string | null;
  sourceEventId: string | null;
  cursorPosition: string | null;
  chunkManifest: Record<string, unknown>;
}

export type MatchingJobHeartbeatResult =
  | { ok: true; lockExpiresAt: Date }
  | { ok: false; reason: "lease_lost" };

export type MatchingJobFailureOutcome = "failed" | "dead_letter" | "lease_lost";
export type MatchingJobSupersedeOutcome = "superseded" | "lease_lost";

/**
 * Prédicat de clôture unique de toute écriture d'un worker : identité du job, jeton
 * courant, statut running et bail encore valide selon l'horloge PostgreSQL.
 * $1 = id du job, $2 = claim_token. Ne jamais en dupliquer une variante plus permissive.
 */
export const LEASE_FENCE = `id = $1
   AND claim_token = $2
   AND status = 'running'
   AND lock_expires_at >= clock_timestamp()`;

interface JobRow extends QueryResultRow {
  id: string;
  claim_token: string;
  locked_by: string;
  attempts: number;
  max_attempts: number;
  lock_expires_at: Date;
  job_type: string;
  resource_id: string;
  resource_version: number;
  target_resource_id: string | null;
  scoring_config_hash: string | null;
  source_event_id: string | null;
  cursor_position: string | null;
  chunk_manifest: Record<string, unknown>;
}

export function requirePool(pool: unknown): Pool {
  if (!(pool instanceof Pool)) {
    throw new MatchingJobValidationError("Un pool PostgreSQL (Pool) est requis.");
  }
  return pool;
}

function requireUuid(value: unknown, field: string): string {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new MatchingJobValidationError(`${field} doit être un UUID valide.`);
  }
  return value;
}

function requireBoundedInteger(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new MatchingJobValidationError(`${field} doit être un entier entre ${min} et ${max}.`);
  }
  return value;
}

function requireWorkerId(value: unknown): string {
  if (typeof value !== "string" || !WORKER_ID.test(value)) {
    throw new MatchingJobValidationError("workerId doit contenir 1 à 128 caractères parmi A-Z a-z 0-9 . _ : -.");
  }
  return value;
}

export function requireLeaseSeconds(value: number | undefined): number {
  return requireBoundedInteger(value === undefined ? DEFAULT_JOB_LEASE_SECONDS : value, "leaseSeconds", MIN_LEASE_SECONDS, MAX_LEASE_SECONDS);
}

function requireErrorCode(value: unknown): string {
  if (typeof value !== "string" || !ERROR_CODE.test(value)) {
    throw new MatchingJobValidationError("errorCode doit être un code stable de 1 à 120 caractères [a-z0-9_.:-].");
  }
  return value;
}

export function requireLease(lease: unknown): JobLease {
  if (typeof lease !== "object" || lease === null) {
    throw new MatchingJobValidationError("Un bail (JobLease) est requis.");
  }
  const candidate = lease as Partial<JobLease>;
  requireUuid(candidate.jobId, "jobId");
  requireUuid(candidate.claimToken, "claimToken");
  return lease as JobLease;
}

function mapLease(row: JobRow): JobLease {
  return {
    jobId: row.id,
    claimToken: row.claim_token,
    workerId: row.locked_by,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    lockExpiresAt: row.lock_expires_at,
    jobType: row.job_type,
    resourceId: row.resource_id,
    resourceVersion: row.resource_version,
    targetResourceId: row.target_resource_id,
    scoringConfigHash: row.scoring_config_hash,
    sourceEventId: row.source_event_id,
    cursorPosition: row.cursor_position,
    chunkManifest: row.chunk_manifest,
  };
}

export interface ClaimMatchingJobsOptions {
  pool: Pool;
  workerId: string;
  limit: number;
  leaseSeconds?: number;
}

/** Réserve jusqu'à `limit` jobs avec un jeton de bail neuf, y compris pour une reprise après expiration. */
export async function claimMatchingJobs(options: ClaimMatchingJobsOptions): Promise<JobLease[]> {
  const pool = requirePool(options.pool);
  const workerId = requireWorkerId(options.workerId);
  const limit = requireBoundedInteger(options.limit, "limit", 1, MAX_CLAIM_LIMIT);
  const leaseSeconds = requireLeaseSeconds(options.leaseSeconds);
  const result = await pool.query<JobRow>(
    `WITH claimable AS (
       SELECT id
         FROM matching_jobs
        WHERE (
                status IN ('pending', 'failed')
                OR (status = 'running' AND lock_expires_at < clock_timestamp())
              )
          AND attempts < max_attempts
          AND scheduled_at <= clock_timestamp()
        ORDER BY scheduled_at ASC, id ASC
        LIMIT $1
          FOR UPDATE SKIP LOCKED
     ), claimed AS (
       UPDATE matching_jobs j
          SET status = 'running',
              locked_by = $2,
              locked_at = clock_timestamp(),
              lock_expires_at = clock_timestamp() + ($3::int * interval '1 second'),
              claim_token = gen_random_uuid(),
              attempts = attempts + 1,
              updated_at = clock_timestamp()
         FROM claimable
        WHERE j.id = claimable.id
        RETURNING j.*
     )
     SELECT * FROM claimed ORDER BY scheduled_at ASC, id ASC`,
    [limit, workerId, leaseSeconds],
  );
  return result.rows.map(mapLease);
}

export interface HeartbeatMatchingJobOptions {
  pool: Pool;
  lease: JobLease;
  leaseSeconds?: number;
}

/** Prolonge le bail. `lease_lost` : jeton remplacé, statut changé ou bail déjà expiré. */
export async function heartbeatMatchingJob(options: HeartbeatMatchingJobOptions): Promise<MatchingJobHeartbeatResult> {
  const pool = requirePool(options.pool);
  const lease = requireLease(options.lease);
  const leaseSeconds = requireLeaseSeconds(options.leaseSeconds);
  const result = await pool.query<{ lock_expires_at: Date }>(
    `UPDATE matching_jobs
        SET lock_expires_at = clock_timestamp() + ($3::int * interval '1 second'),
            updated_at = clock_timestamp()
      WHERE ${LEASE_FENCE}
      RETURNING lock_expires_at`,
    [lease.jobId, lease.claimToken, leaseSeconds],
  );
  return result.rowCount === 1
    ? { ok: true, lockExpiresAt: result.rows[0].lock_expires_at }
    : { ok: false, reason: "lease_lost" };
}

export interface FailMatchingJobOptions {
  pool: Pool;
  lease: JobLease;
  errorCode: string;
}

/**
 * Échec sous bail valide : `failed` avec délai exponentiel borné à 600 s, ou `dead_letter`
 * si la dernière tentative est consommée. Sans bail valide, aucune écriture (`lease_lost`).
 */
export async function failMatchingJob(options: FailMatchingJobOptions): Promise<MatchingJobFailureOutcome> {
  const pool = requirePool(options.pool);
  const lease = requireLease(options.lease);
  const errorCode = requireErrorCode(options.errorCode);
  const result = await pool.query<{ status: "failed" | "dead_letter" }>(
    `UPDATE matching_jobs
        SET status = CASE WHEN attempts >= max_attempts THEN 'dead_letter'::text ELSE 'failed'::text END,
            locked_by = NULL,
            locked_at = NULL,
            lock_expires_at = NULL,
            claim_token = NULL,
            scheduled_at = clock_timestamp() + (interval '1 second' * LEAST(600, power(2, LEAST(attempts, 10)) * 2)),
            last_error = $3,
            completed_at = CASE WHEN attempts >= max_attempts THEN clock_timestamp() ELSE NULL END,
            updated_at = clock_timestamp()
      WHERE ${LEASE_FENCE}
      RETURNING status`,
    [lease.jobId, lease.claimToken, errorCode],
  );
  return result.rowCount === 1 ? result.rows[0].status : "lease_lost";
}

export interface SupersedeMatchingJobOptions {
  pool: Pool;
  lease: JobLease;
}

/**
 * Clôture `superseded` sous bail valide. La détection de l'obsolescence (version courante
 * de la ressource) appartient au worker du lot 2E4 ; seule l'écriture clôturée est fournie ici.
 */
export async function supersedeMatchingJob(options: SupersedeMatchingJobOptions): Promise<MatchingJobSupersedeOutcome> {
  const pool = requirePool(options.pool);
  const lease = requireLease(options.lease);
  const result = await pool.query(
    `UPDATE matching_jobs
        SET status = 'superseded',
            locked_by = NULL,
            locked_at = NULL,
            lock_expires_at = NULL,
            claim_token = NULL,
            completed_at = clock_timestamp(),
            updated_at = clock_timestamp()
      WHERE ${LEASE_FENCE}`,
    [lease.jobId, lease.claimToken],
  );
  return result.rowCount === 1 ? "superseded" : "lease_lost";
}

export interface RunMatchingJobMaintenanceOptions {
  pool: Pool;
}

/**
 * Seul chemin vers `dead_letter` hors échec sous bail valide : jobs épuisés
 * (running expiré ou failed avec attempts >= max_attempts). Les running expirés encore
 * réessayables restent réclamables.
 */
export async function runMatchingJobMaintenance(
  options: RunMatchingJobMaintenanceOptions,
): Promise<{ deadLettered: number }> {
  const pool = requirePool(options.pool);
  const result = await pool.query(
    `UPDATE matching_jobs
        SET status = 'dead_letter',
            locked_by = NULL,
            locked_at = NULL,
            lock_expires_at = NULL,
            claim_token = NULL,
            last_error = COALESCE(last_error, 'Tentatives maximales autorisées épuisées ou bail expiré.'),
            completed_at = clock_timestamp(),
            updated_at = clock_timestamp()
      WHERE (
              (status = 'running' AND lock_expires_at < clock_timestamp() AND attempts >= max_attempts)
              OR (status = 'failed' AND attempts >= max_attempts)
            )`,
  );
  return { deadLettered: result.rowCount ?? 0 };
}
