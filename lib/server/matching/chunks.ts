import "server-only";

import type { Pool, QueryResultRow } from "pg";
import {
  LEASE_FENCE,
  MatchingJobValidationError,
  requireLease,
  requireLeaseSeconds,
  requirePool,
  type JobLease,
} from "./jobs";
import {
  assertAppendOnly,
  parseChunkManifest,
  type ChunkManifest,
  type ResolvedCandidateStatus,
} from "./chunk-manifest";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const RESOLVED_STATUSES: readonly string[] = ["persisted", "replayed", "skipped_stale", "already_superseded"];
const MAX_INTEGER = 2_147_483_647;

export type ChunkRejectedReason =
  | "eof_reached"
  | "predecessor_missing"
  | "predecessor_not_validated"
  | "predecessor_mismatch"
  | "chunk_id_conflict"
  | "chunk_validated"
  | "no_chunk"
  | "invalid_stored_manifest"
  | "unsupported_job_type"
  | "config_mismatch"
  | "pair_resource_mismatch"
  | "target_mismatch"
  | "cursor_discontinuity"
  | "invalid_next_manifest";

export type ChunkOperationResult =
  | { kind: "applied" }
  | { kind: "already_applied" }
  | { kind: "lease_lost" }
  | { kind: "conflict"; fresh: ChunkManifest }
  | { kind: "stale_chunk" }
  | { kind: "rejected"; reason: ChunkRejectedReason };

export type CompleteChunkedJobResult = "completed" | "lease_lost" | "not_ready";

export interface ChunkJobState {
  status: string;
  claimToken: string | null;
  leaseValid: boolean;
  cursorPosition: string | null;
  manifest: ChunkManifest | null;
}

function requireChunkUuid(value: unknown, field: string): string {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new MatchingJobValidationError(`${field} doit être un UUID en minuscules.`);
  }
  return value;
}

function requireExpectedVersion(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value >= MAX_INTEGER) {
    throw new MatchingJobValidationError(`expectedManifestVersion doit être un entier entre 1 et ${MAX_INTEGER - 1}.`);
  }
  return value;
}

/**
 * Clauses SQL de non-régression structurelle : tout champ du manifeste hors révision, état et
 * candidats reste identique ; les candidats gardent leur ordre et leurs champs ; chaque tentative
 * existante reste identique à son statut près (pending → résolu seulement).
 */
function appendOnlySql(next: string): string {
  return `
   AND (chunk_manifest - ARRAY['manifest_version','state','candidates']::text[])
       = (${next}::jsonb - ARRAY['manifest_version','state','candidates']::text[])
   AND jsonb_array_length(chunk_manifest->'candidates') = jsonb_array_length(${next}::jsonb->'candidates')
   AND NOT EXISTS (
     SELECT 1
       FROM jsonb_array_elements(chunk_manifest->'candidates') WITH ORDINALITY AS o(cand, pos)
       JOIN jsonb_array_elements(${next}::jsonb->'candidates') WITH ORDINALITY AS n(cand, pos) USING (pos)
      WHERE (o.cand - ARRAY['status','current_attempt_id','attempts']::text[])
              <> (n.cand - ARRAY['status','current_attempt_id','attempts']::text[])
         OR jsonb_array_length(n.cand->'attempts') < jsonb_array_length(o.cand->'attempts')
         OR EXISTS (
              SELECT 1
                FROM jsonb_array_elements(o.cand->'attempts') WITH ORDINALITY AS oa(att, apos)
                JOIN jsonb_array_elements(n.cand->'attempts') WITH ORDINALITY AS na(att, apos) USING (apos)
               WHERE (oa.att - 'status'::text) <> (na.att - 'status'::text)
                  OR NOT (oa.att->>'status' = na.att->>'status' OR oa.att->>'status' = 'pending')
            )
   )`;
}

function attemptTotalSql(manifest: string): string {
  return `(SELECT count(*) FROM jsonb_array_elements(${manifest}->'candidates') AS c,
            jsonb_array_elements(c->'attempts') AS a)`;
}

/** Condition CAS commune : chunk et révision exacts, état modifiable, révision suivante, état cible. */
function casSql(next: string, expectedChunk: string, expectedVersion: string, targetState: "processing" | "validated"): string {
  return `
   AND chunk_manifest->>'chunk_id' = ${expectedChunk}::text
   AND ${next}::jsonb->>'chunk_id' = ${expectedChunk}::text
   AND (chunk_manifest->>'manifest_version')::int = ${expectedVersion}::int
   AND (${next}::jsonb->>'manifest_version')::int = ${expectedVersion}::int + 1
   AND chunk_manifest->>'state' IN ('initialized', 'processing')
   AND ${next}::jsonb->>'state' = '${targetState}'`;
}

const EXTEND_LEASE = (leaseParam: string) =>
  `lock_expires_at = clock_timestamp() + (${leaseParam}::int * interval '1 second'),
        updated_at = clock_timestamp()`;

interface JobStateRow extends QueryResultRow {
  status: string;
  claim_token: string | null;
  lease_valid: boolean;
  cursor_position: string | null;
  chunk_manifest: unknown;
  job_type: string;
  scoring_config_hash: string | null;
  resource_id: string;
  resource_version: number;
  target_resource_id: string | null;
}

/**
 * Types de job chunkés. `reevaluate_pair_temporal` (2E4C2) est un cas dégénéré : un seul chunk EOF, au plus un
 * candidat (la demande ciblée), avec des règles de liaison supplémentaires.
 */
const CHUNKED_JOB_TYPES: readonly string[] = [
  "evaluate_offer_candidates", "evaluate_demand_candidates", "reevaluate_pair_temporal",
];

async function readJobState(pool: Pool, jobId: string): Promise<JobStateRow | null> {
  const result = await pool.query<JobStateRow>(
    `SELECT status, claim_token,
            (lock_expires_at IS NOT NULL AND lock_expires_at >= clock_timestamp()) AS lease_valid,
            cursor_position, chunk_manifest, job_type, scoring_config_hash, resource_id, resource_version,
            target_resource_id
       FROM matching_jobs WHERE id = $1`,
    [jobId],
  );
  return result.rows[0] ?? null;
}

function leaseIsLost(row: JobStateRow | null, lease: JobLease): boolean {
  return !row || row.status !== "running" || row.claim_token !== lease.claimToken || !row.lease_valid;
}

const INVALID_STORED = Symbol("invalid_stored_manifest");

/** `null` pour `{}`, le manifeste parsé, ou INVALID_STORED si la base contient un manifeste corrompu. */
function parseStoredManifest(value: unknown): ChunkManifest | null | typeof INVALID_STORED {
  if (typeof value === "object" && value !== null && !Array.isArray(value) && Object.keys(value).length === 0) return null;
  try {
    return parseChunkManifest(value);
  } catch {
    return INVALID_STORED;
  }
}

const STRUCTURAL_KEYS = [
  "chunk_index", "predecessor_chunk_id", "predecessor_manifest_version", "cursor_in", "cursor_out", "is_eof",
  "evaluated_at", "scoring_config_hash", "engine_offline_version", "engine_scoring_version",
] as const;

function sameInitialStructure(stored: ChunkManifest, initial: ChunkManifest): boolean {
  if (stored.chunk_id !== initial.chunk_id) return false;
  for (const key of STRUCTURAL_KEYS) if (stored[key] !== initial[key]) return false;
  if (stored.candidates.length !== initial.candidates.length) return false;
  return stored.candidates.every((candidate, index) => {
    const wanted = initial.candidates[index];
    return candidate.candidate_id === wanted.candidate_id
      && candidate.candidate_version === wanted.candidate_version
      && candidate.pair_resource_id === wanted.pair_resource_id
      && candidate.pair_resource_version === wanted.pair_resource_version
      && candidate.attempts[0].attempt_id === wanted.attempts[0].attempt_id
      && candidate.attempts[0].idempotency_key === wanted.attempts[0].idempotency_key
      && candidate.attempts[0].attempt_hash === wanted.attempts[0].attempt_hash;
  });
}

export interface InitializeChunkOptions {
  pool: Pool;
  lease: JobLease;
  manifest: ChunkManifest;
  leaseSeconds?: number;
}

/** Initialise le chunk 0 sur `{}`, ou le chunk suivant après un prédécesseur exact, validé et non EOF. */
export async function initializeChunk(options: InitializeChunkOptions): Promise<ChunkOperationResult> {
  const pool = requirePool(options.pool);
  const lease = requireLease(options.lease);
  const leaseSeconds = requireLeaseSeconds(options.leaseSeconds);
  const manifest = parseChunkManifest(options.manifest);
  if (manifest.manifest_version !== 1 || manifest.state !== "initialized") {
    throw new MatchingJobValidationError("Un manifeste initial porte manifest_version 1 et l'état initialized.");
  }
  if (manifest.candidates.some((candidate) => candidate.attempts.length !== 1 || candidate.status !== "pending")) {
    throw new MatchingJobValidationError("Un manifeste initial ne contient qu'une tentative pending par candidat.");
  }
  const serialized = JSON.stringify(manifest);
  const updated = await pool.query(
    `UPDATE matching_jobs
        SET chunk_evaluated_at = $3,
            chunk_manifest = $4::jsonb,
            ${EXTEND_LEASE("$5")}
      WHERE ${LEASE_FENCE}
        AND ($4::jsonb->>'chunk_id') IS NOT NULL
        AND ($4::jsonb->>'chunk_index') IS NOT NULL
        AND ($4::jsonb->>'manifest_version') IS NOT NULL
        AND ($4::jsonb->>'manifest_version')::int = 1
        AND ($4::jsonb->>'state') = 'initialized'
        AND ($4::jsonb->>'is_eof') IS NOT NULL
        -- Liaison au job : configuration scellée (un hash NULL en base ne vaut jamais l'égalité),
        -- type de job supporté, ressource pivot et version de chaque candidat.
        AND ($4::jsonb->>'scoring_config_hash') = scoring_config_hash
        AND job_type IN ('evaluate_offer_candidates', 'evaluate_demand_candidates', 'reevaluate_pair_temporal')
        AND NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements($4::jsonb->'candidates') AS c
           WHERE c->>'pair_resource_id' IS DISTINCT FROM resource_id::text
              OR (c->>'pair_resource_version')::int IS DISTINCT FROM resource_version
        )
        -- reevaluate_pair_temporal : un seul chunk EOF, au plus un candidat, et c'est la demande ciblée.
        AND (
          job_type <> 'reevaluate_pair_temporal'
          OR (
            ($4::jsonb->>'chunk_index')::int = 0
            AND ($4::jsonb->>'cursor_in') IS NULL
            AND ($4::jsonb->>'is_eof')::boolean = true
            AND jsonb_array_length($4::jsonb->'candidates') <= 1
            AND NOT EXISTS (
              SELECT 1 FROM jsonb_array_elements($4::jsonb->'candidates') AS c
               WHERE c->>'candidate_id' IS DISTINCT FROM target_resource_id::text
            )
          )
        )
        AND (
              (
                chunk_manifest = '{}'::jsonb
                AND ($4::jsonb->>'chunk_index')::int = 0
                AND ($4::jsonb->>'predecessor_chunk_id') IS NULL
                AND ($4::jsonb->>'predecessor_manifest_version') IS NULL
                AND ($4::jsonb->>'cursor_in') IS NULL
                AND cursor_position IS NULL
              )
              OR (
                chunk_manifest->>'chunk_id' IS NOT NULL
                AND chunk_manifest->>'manifest_version' IS NOT NULL
                AND chunk_manifest->>'chunk_index' IS NOT NULL
                AND chunk_manifest->>'state' = 'validated'
                AND (chunk_manifest->>'is_eof')::boolean = false
                AND ($4::jsonb->>'predecessor_chunk_id') IS NOT NULL
                AND ($4::jsonb->>'predecessor_manifest_version') IS NOT NULL
                AND chunk_manifest->>'chunk_id' = ($4::jsonb->>'predecessor_chunk_id')
                AND (chunk_manifest->>'manifest_version')::int = ($4::jsonb->>'predecessor_manifest_version')::int
                AND ($4::jsonb->>'chunk_id') IS DISTINCT FROM chunk_manifest->>'chunk_id'
                AND ($4::jsonb->>'chunk_index')::int = (chunk_manifest->>'chunk_index')::int + 1
                AND ($4::jsonb->>'cursor_in') = chunk_manifest->>'cursor_out'
                AND ($4::jsonb->>'cursor_in') = cursor_position
              )
            )`,
    [lease.jobId, lease.claimToken, manifest.evaluated_at, serialized, leaseSeconds],
  );
  if (updated.rowCount === 1) return { kind: "applied" };

  const row = await readJobState(pool, lease.jobId);
  if (leaseIsLost(row, lease)) return { kind: "lease_lost" };
  const stored = parseStoredManifest(row!.chunk_manifest);
  if (stored === INVALID_STORED) return { kind: "rejected", reason: "invalid_stored_manifest" };
  if (stored && stored.chunk_id === manifest.chunk_id) {
    return sameInitialStructure(stored, manifest)
      ? { kind: "already_applied" }
      : { kind: "rejected", reason: "chunk_id_conflict" };
  }
  // Liaison au job, avant les raisons liées à l'état du parcours.
  const job = row!;
  if (!CHUNKED_JOB_TYPES.includes(job.job_type)) return { kind: "rejected", reason: "unsupported_job_type" };
  if (job.scoring_config_hash === null || manifest.scoring_config_hash !== job.scoring_config_hash) {
    return { kind: "rejected", reason: "config_mismatch" };
  }
  if (manifest.candidates.some((candidate) =>
    candidate.pair_resource_id !== job.resource_id || candidate.pair_resource_version !== job.resource_version)) {
    return { kind: "rejected", reason: "pair_resource_mismatch" };
  }
  if (job.job_type === "reevaluate_pair_temporal") {
    if (manifest.candidates.length > 1 || manifest.candidates.some((candidate) => candidate.candidate_id !== job.target_resource_id)) {
      return { kind: "rejected", reason: "target_mismatch" };
    }
    if (manifest.chunk_index !== 0 || manifest.cursor_in !== null || !manifest.is_eof) {
      return { kind: "rejected", reason: "invalid_next_manifest" };
    }
  }
  if (!stored) {
    if (manifest.chunk_index > 0) return { kind: "rejected", reason: "predecessor_missing" };
    if (manifest.cursor_in !== null || job.cursor_position !== null) return { kind: "rejected", reason: "cursor_discontinuity" };
    return { kind: "rejected", reason: "invalid_next_manifest" };
  }
  const predecessorMatches = stored.state === "validated" && !stored.is_eof
    && stored.chunk_id === manifest.predecessor_chunk_id
    && stored.manifest_version === manifest.predecessor_manifest_version
    && manifest.chunk_index === stored.chunk_index + 1;
  if (predecessorMatches && (manifest.cursor_in !== stored.cursor_out || manifest.cursor_in !== job.cursor_position)) {
    return { kind: "rejected", reason: "cursor_discontinuity" };
  }
  if (stored.state === "validated" && stored.is_eof) return { kind: "rejected", reason: "eof_reached" };
  if (stored.state !== "validated") return { kind: "rejected", reason: "predecessor_not_validated" };
  return { kind: "rejected", reason: "predecessor_mismatch" };
}

export interface CasOptions {
  pool: Pool;
  lease: JobLease;
  expectedChunkId: string;
  expectedManifestVersion: number;
  nextManifest: ChunkManifest;
  /** Révision attendue complète, facultative : contrôle additif avant SQL. */
  previousManifest?: ChunkManifest;
  leaseSeconds?: number;
}

interface ValidatedCas {
  pool: Pool;
  lease: JobLease;
  expectedChunkId: string;
  expectedManifestVersion: number;
  next: ChunkManifest;
  leaseSeconds: number;
}

function validateCas(options: CasOptions, targetState: "processing" | "validated"): ValidatedCas {
  const pool = requirePool(options.pool);
  const lease = requireLease(options.lease);
  const leaseSeconds = requireLeaseSeconds(options.leaseSeconds);
  const expectedChunkId = requireChunkUuid(options.expectedChunkId, "expectedChunkId");
  const expectedManifestVersion = requireExpectedVersion(options.expectedManifestVersion);
  const next = parseChunkManifest(options.nextManifest);
  if (next.chunk_id !== expectedChunkId) throw new MatchingJobValidationError("nextManifest.chunk_id doit égaler expectedChunkId.");
  if (next.manifest_version !== expectedManifestVersion + 1) {
    throw new MatchingJobValidationError("nextManifest.manifest_version doit valoir expectedManifestVersion + 1.");
  }
  if (next.state !== targetState) throw new MatchingJobValidationError(`nextManifest.state doit valoir ${targetState}.`);
  if (options.previousManifest !== undefined) {
    const previous = parseChunkManifest(options.previousManifest);
    if (previous.chunk_id !== expectedChunkId || previous.manifest_version !== expectedManifestVersion) {
      throw new MatchingJobValidationError("previousManifest ne correspond pas à expectedChunkId / expectedManifestVersion.");
    }
    assertAppendOnly(previous, next);
  }
  return { pool, lease, expectedChunkId, expectedManifestVersion, next, leaseSeconds };
}

/** Relit après rowCount = 0 puis classe le résultat ; `effectApplied` prouve l'effet précis de l'opération. */
async function classifyCasFailure(
  cas: ValidatedCas,
  effectApplied: (stored: ChunkManifest) => boolean,
): Promise<ChunkOperationResult> {
  const row = await readJobState(cas.pool, cas.lease.jobId);
  if (leaseIsLost(row, cas.lease)) return { kind: "lease_lost" };
  const stored = parseStoredManifest(row!.chunk_manifest);
  if (stored === INVALID_STORED) return { kind: "rejected", reason: "invalid_stored_manifest" };
  if (!stored) return { kind: "rejected", reason: "no_chunk" };
  if (stored.chunk_id !== cas.expectedChunkId) return { kind: "stale_chunk" };
  if (effectApplied(stored)) return { kind: "already_applied" };
  if (stored.state === "validated") return { kind: "rejected", reason: "chunk_validated" };
  if (stored.manifest_version !== cas.expectedManifestVersion) return { kind: "conflict", fresh: stored };
  return { kind: "rejected", reason: "invalid_next_manifest" };
}

export interface RecordCandidateAttemptOptions extends CasOptions {
  attemptId: string;
}

/** Enregistre une nouvelle tentative (révision + 1, état processing). */
export async function recordCandidateAttempt(options: RecordCandidateAttemptOptions): Promise<ChunkOperationResult> {
  const cas = validateCas(options, "processing");
  const attemptId = requireChunkUuid(options.attemptId, "attemptId");
  const candidate = cas.next.candidates.find((entry) => entry.current_attempt_id === attemptId);
  const attempt = candidate?.attempts[candidate.attempts.length - 1];
  if (!candidate || !attempt || attempt.status !== "pending") {
    throw new MatchingJobValidationError("attemptId doit désigner la tentative courante pending d'un candidat du manifeste suivant.");
  }
  const updated = await cas.pool.query(
    `UPDATE matching_jobs
        SET chunk_manifest = $3::jsonb,
            ${EXTEND_LEASE("$6")}
      WHERE ${LEASE_FENCE}
        ${casSql("$3", "$4", "$5", "processing")}
        ${appendOnlySql("$3")}
        AND ${attemptTotalSql("chunk_manifest")} + 1 = ${attemptTotalSql("$3::jsonb")}`,
    [cas.lease.jobId, cas.lease.claimToken, JSON.stringify(cas.next), cas.expectedChunkId, cas.expectedManifestVersion, cas.leaseSeconds],
  );
  if (updated.rowCount === 1) return { kind: "applied" };
  return classifyCasFailure(cas, (stored) => {
    const storedCandidate = stored.candidates.find((entry) => entry.candidate_id === candidate.candidate_id);
    return storedCandidate?.attempts.some((entry) =>
      entry.attempt_id === attempt.attempt_id
      && entry.idempotency_key === attempt.idempotency_key
      && entry.attempt_hash === attempt.attempt_hash) ?? false;
  });
}

export interface AcknowledgeCandidateOptions extends CasOptions {
  candidateId: string;
  attemptId: string;
  status: ResolvedCandidateStatus;
}

/** Acquitte la tentative courante d'un candidat (révision + 1, état processing). */
export async function acknowledgeCandidate(options: AcknowledgeCandidateOptions): Promise<ChunkOperationResult> {
  const cas = validateCas(options, "processing");
  const candidateId = requireChunkUuid(options.candidateId, "candidateId");
  const attemptId = requireChunkUuid(options.attemptId, "attemptId");
  if (typeof options.status !== "string" || !RESOLVED_STATUSES.includes(options.status)) {
    throw new MatchingJobValidationError("status d'acquittement invalide (pending exclu).");
  }
  const status = options.status;
  const candidate = cas.next.candidates.find((entry) => entry.candidate_id === candidateId);
  const attempt = candidate?.attempts.find((entry) => entry.attempt_id === attemptId);
  if (!candidate || !attempt || candidate.current_attempt_id !== attemptId || attempt.status !== status || candidate.status !== status) {
    throw new MatchingJobValidationError("Le manifeste suivant doit porter ce statut sur la tentative courante du candidat.");
  }
  const updated = await cas.pool.query(
    `UPDATE matching_jobs
        SET chunk_manifest = $3::jsonb,
            ${EXTEND_LEASE("$6")}
      WHERE ${LEASE_FENCE}
        ${casSql("$3", "$4", "$5", "processing")}
        ${appendOnlySql("$3")}
        AND ${attemptTotalSql("chunk_manifest")} = ${attemptTotalSql("$3::jsonb")}`,
    [cas.lease.jobId, cas.lease.claimToken, JSON.stringify(cas.next), cas.expectedChunkId, cas.expectedManifestVersion, cas.leaseSeconds],
  );
  if (updated.rowCount === 1) return { kind: "applied" };
  return classifyCasFailure(cas, (stored) =>
    stored.candidates
      .find((entry) => entry.candidate_id === candidateId)
      ?.attempts.find((entry) => entry.attempt_id === attemptId)?.status === status);
}

export type ValidateChunkOptions = CasOptions;

/**
 * Valide le chunk : curseur avancé seulement si cursor_out est non nul, compteurs dérivés du manifeste
 * en SQL (jamais fournis par l'appelant).
 */
export async function validateChunk(options: ValidateChunkOptions): Promise<ChunkOperationResult> {
  const cas = validateCas(options, "validated");
  const updated = await cas.pool.query(
    `UPDATE matching_jobs
        SET cursor_position = CASE WHEN $3::jsonb->>'cursor_out' IS NULL THEN cursor_position
                                   ELSE $3::jsonb->>'cursor_out' END,
            chunk_manifest = $3::jsonb,
            processed_candidates_count = processed_candidates_count
              + jsonb_array_length($3::jsonb->'candidates'),
            created_evaluations_count = created_evaluations_count
              + (SELECT count(*)::int FROM jsonb_array_elements($3::jsonb->'candidates') AS c
                  WHERE c->>'status' = 'persisted'),
            ${EXTEND_LEASE("$6")}
      WHERE ${LEASE_FENCE}
        ${casSql("$3", "$4", "$5", "validated")}
        ${appendOnlySql("$3")}
        AND ${attemptTotalSql("chunk_manifest")} = ${attemptTotalSql("$3::jsonb")}
        AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements($3::jsonb->'candidates') AS c WHERE c->>'status' = 'pending')`,
    [cas.lease.jobId, cas.lease.claimToken, JSON.stringify(cas.next), cas.expectedChunkId, cas.expectedManifestVersion, cas.leaseSeconds],
  );
  if (updated.rowCount === 1) return { kind: "applied" };
  return classifyCasFailure(cas, (stored) => stored.state === "validated");
}

export interface CompleteChunkedJobOptions {
  pool: Pool;
  lease: JobLease;
}

/** Clôture le job : exige un chunk validated avec is_eof = true sous bail valide. */
export async function completeChunkedJob(options: CompleteChunkedJobOptions): Promise<CompleteChunkedJobResult> {
  const pool = requirePool(options.pool);
  const lease = requireLease(options.lease);
  const updated = await pool.query(
    `UPDATE matching_jobs
        SET status = 'completed',
            locked_by = NULL,
            locked_at = NULL,
            lock_expires_at = NULL,
            claim_token = NULL,
            completed_at = clock_timestamp(),
            updated_at = clock_timestamp()
      WHERE ${LEASE_FENCE}
        AND chunk_manifest->>'state' = 'validated'
        AND (chunk_manifest->>'is_eof')::boolean = true`,
    [lease.jobId, lease.claimToken],
  );
  if (updated.rowCount === 1) return "completed";
  const row = await readJobState(pool, lease.jobId);
  return leaseIsLost(row, lease) ? "lease_lost" : "not_ready";
}

export interface ReadChunkStateOptions {
  pool: Pool;
  jobId: string;
}

/** Lecture seule pour diagnostic ; `null` si le job n'existe pas. */
export async function readChunkState(options: ReadChunkStateOptions): Promise<ChunkJobState | null> {
  const pool = requirePool(options.pool);
  const jobId = requireChunkUuid(options.jobId, "jobId");
  const row = await readJobState(pool, jobId);
  if (!row) return null;
  const manifest = parseStoredManifest(row.chunk_manifest);
  if (manifest === INVALID_STORED) throw new MatchingJobValidationError("Le manifeste stocké est invalide.");
  return {
    status: row.status,
    claimToken: row.claim_token,
    leaseValid: row.lease_valid,
    cursorPosition: row.cursor_position,
    manifest,
  };
}
