import "server-only";

import { createHash, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { SqlExecutor } from "../postgres/client";
import { CatalogNotFoundError, CatalogValidationError } from "../catalog/errors";
import type { DemandRecord, OfferRecord } from "../catalog/types";
import {
  acknowledgeCandidateAttempt,
  appendCandidateAttempt,
  buildInitialChunkManifest,
  isCursorStrictlyAfter,
  validateChunkManifest,
  type ChunkAttempt,
  type ChunkManifest,
  type ResolvedCandidateStatus,
} from "./chunk-manifest";
import {
  acknowledgeCandidate,
  completeChunkedJob,
  initializeChunk,
  readChunkState,
  recordCandidateAttempt,
  validateChunk,
  type ChunkJobState,
} from "./chunks";
import {
  MatchingJobValidationError,
  claimMatchingJobs,
  failMatchingJob,
  heartbeatMatchingJob,
  requireLease,
  requireLeaseSeconds,
  requirePool,
  supersedeMatchingJob,
  type JobLease,
} from "./jobs";
import { evaluateOfflineMatching } from "./offline";
import {
  EvaluationExpiredDuringLockWaitError,
  MatchingIdempotencyConflictError,
  MatchingInputConsistencyError,
  StaleAttemptSupersededError,
  StalePreconditionsError,
} from "./persistence-types";
import {
  canonicalJsonStringify,
  computeAttemptHash,
  computeScoringConfigHash,
  normalizeScoringConfig,
  persistEvaluatedMatch,
} from "./persistence";
import { computeMatchingScore } from "./scoring";
import { MATCHING_SCORING_CONTRACT_VERSION, type MatchingScoringOptions, type MatchingScoringResult } from "./scoring-types";
import { findEvaluatedDemandMatchesForOffer, findEvaluatedOfferMatchesForDemand } from "./service";
import type { EvaluatedMatchPage, InternalEvaluatedDemandMatchesQueryOptions } from "./service-types";
import { MATCHING_OFFLINE_CONTRACT_VERSION, type MatchingEvaluationResult } from "./types";

export const MATCHING_EVALUATION_JOB_TYPES = [
  "evaluate_offer_candidates", "evaluate_demand_candidates", "reevaluate_pair_temporal",
] as const;

/** Job de paire (2E4C2) : pivot = offre, un seul candidat = la demande ciblée, un seul chunk EOF. */
const PAIR_JOB_TYPE = "reevaluate_pair_temporal";

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;
const MAX_WORKER_BATCH = 10;
const MAX_ATTEMPTS_PER_CANDIDATE = 3;
const MAX_MANIFEST_RETRIES = 3;
const RESUME_PAGE_SIZE = 100;
const TRANSIENT_PG_CODES: readonly string[] = ["55P03", "40P01", "40001", "57014"];

export type MatchingJobOutcome = "completed" | "superseded" | "failed" | "dead_letter" | "lease_lost" | "abandoned";

export interface MatchingJobRunResult {
  outcome: MatchingJobOutcome;
  chunks: number;
  persisted: number;
  replayed: number;
  skippedStale: number;
  alreadySuperseded: number;
  /** Code stable de l'échec, présent pour failed et dead_letter. */
  errorCode?: string;
}

type HookResult = void | "abandon" | Promise<void | "abandon">;

/** Hooks réservés aux tests. Renvoyer "abandon" simule la mort du processus : plus aucune écriture. */
export interface MatchingWorkerHooks {
  beforeFetchPage?: () => HookResult;
  afterInitialize?: () => HookResult;
  beforePersist?: (candidateId: string) => HookResult;
  afterPersist?: (candidateId: string) => HookResult;
  beforeValidate?: () => HookResult;
  afterValidate?: () => HookResult;
}

export interface RunMatchingJobOptions {
  pool: Pool;
  lease: JobLease;
  pageSize?: number;
  leaseSeconds?: number;
  hooks?: MatchingWorkerHooks;
}

export interface RunMatchingWorkerOnceOptions {
  pool: Pool;
  workerId: string;
  limit?: number;
  pageSize?: number;
  leaseSeconds?: number;
  hooks?: MatchingWorkerHooks;
}

type PivotKind = "offer" | "demand";
type PivotRecord = OfferRecord | DemandRecord;
type CandidateRecord = OfferRecord | DemandRecord;

interface CachedRecord {
  candidate: CandidateRecord;
  evaluation: MatchingEvaluationResult;
  scoring: MatchingScoringResult;
  now: Date;
}

interface Context {
  pool: Pool;
  lease: JobLease;
  kind: PivotKind;
  pageSize: number;
  leaseSeconds: number;
  hooks: MatchingWorkerHooks;
  scoringOptions: MatchingScoringOptions;
  pivot: PivotRecord | null;
  summary: Omit<MatchingJobRunResult, "outcome" | "errorCode">;
}

/** Arrêt contrôlé du traitement : porte le résultat final, jamais une erreur brute. */
class StopSignal extends Error {
  constructor(readonly outcome: MatchingJobOutcome, readonly errorCode?: string) {
    super(outcome);
    this.name = "StopSignal";
  }
}

export function requirePageSize(value: unknown): number {
  const pageSize = value === undefined ? DEFAULT_PAGE_SIZE : value;
  if (typeof pageSize !== "number" || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) {
    throw new MatchingJobValidationError(`pageSize doit être un entier entre 1 et ${MAX_PAGE_SIZE}.`);
  }
  return pageSize;
}

/** UUID v4 valide dérivé de façon déterministe : stable à travers les crashs et les reprises. */
function deriveUuid(domain: "attempt" | "idempotency", jobId: string, chunkId: string, candidateId: string, ordinal: number): string {
  const digest = createHash("sha256")
    .update(canonicalJsonStringify({ attempt_ordinal: ordinal, candidate_id: candidateId, chunk_id: chunkId, domain, job_id: jobId }))
    .digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function runHook(result: HookResult): Promise<void> {
  if ((await result) === "abandon") throw new StopSignal("abandoned");
}

async function failWith(ctx: Context, errorCode: string): Promise<never> {
  const outcome = await failMatchingJob({ pool: ctx.pool, lease: ctx.lease, errorCode });
  throw new StopSignal(outcome === "lease_lost" ? "lease_lost" : outcome, outcome === "lease_lost" ? undefined : errorCode);
}

async function supersede(ctx: Context): Promise<never> {
  const outcome = await supersedeMatchingJob({ pool: ctx.pool, lease: ctx.lease });
  throw new StopSignal(outcome === "superseded" ? "superseded" : "lease_lost");
}

async function heartbeat(ctx: Context): Promise<void> {
  const result = await heartbeatMatchingJob({ pool: ctx.pool, lease: ctx.lease, leaseSeconds: ctx.leaseSeconds });
  if (!result.ok) throw new StopSignal("lease_lost");
}

async function databaseNow(ctx: Context): Promise<Date> {
  const result = await ctx.pool.query<{ now: Date }>("SELECT clock_timestamp() AS now");
  return result.rows[0].now;
}

/** Code d'échec stable d'une exception inattendue ; une erreur PostgreSQL transitoire est reconnue. */
export function classifyFailure(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && TRANSIENT_PG_CODES.includes(code)) return `transient_${code.toLowerCase()}`;
  if (error instanceof MatchingIdempotencyConflictError) return "idempotency_conflict";
  if (error instanceof MatchingInputConsistencyError) return "input_consistency";
  return "worker_exception";
}

export type SealedConfigResult =
  | { ok: true; config: MatchingScoringOptions; payload: Record<string, unknown> }
  | { ok: false; errorCode: "sealed_config_unavailable" | "engine_version_mismatch" };

/**
 * Configuration scellée dans l'événement source : jamais de repli sur les valeurs par défaut courantes.
 * Contrôle unique partagé par le worker d'évaluation et le sweep de réactivation : hash recalculé égal
 * au hash du job, puis versions de moteur. Aucune écriture ; l'appelant choisit comment échouer.
 */
export async function readSealedConfig(
  pool: SqlExecutor,
  sealed: { sourceEventId: string | null; scoringConfigHash: string | null },
): Promise<SealedConfigResult> {
  const unavailable = { ok: false, errorCode: "sealed_config_unavailable" } as const;
  if (!sealed.sourceEventId || !sealed.scoringConfigHash) return unavailable;
  const result = await pool.query<{ payload: Record<string, unknown> }>(
    "SELECT payload FROM matching_outbox_events WHERE id = $1",
    [sealed.sourceEventId],
  );
  if (result.rowCount !== 1) return unavailable;
  const payload = result.rows[0].payload;
  const config = payload.scoring_config;
  if (typeof config !== "object" || config === null || Array.isArray(config)) return unavailable;
  let sealedHash: string;
  try {
    sealedHash = computeScoringConfigHash(normalizeScoringConfig(config as MatchingScoringOptions));
  } catch {
    return unavailable;
  }
  if (sealedHash !== sealed.scoringConfigHash) return unavailable;
  if (
    payload.engine_offline_version !== MATCHING_OFFLINE_CONTRACT_VERSION ||
    payload.engine_scoring_version !== MATCHING_SCORING_CONTRACT_VERSION
  ) return { ok: false, errorCode: "engine_version_mismatch" };
  return { ok: true, config: config as MatchingScoringOptions, payload };
}

async function loadSealedConfig(ctx: Context): Promise<MatchingScoringOptions> {
  const sealed = await readSealedConfig(ctx.pool, ctx.lease);
  if (!sealed.ok) return failWith(ctx, sealed.errorCode);
  return sealed.config;
}

interface PivotRow {
  owner_id: string;
  content_version: number;
  status: string;
  archived_at: Date | null;
  availability_status: string | null;
  user_status: string | null;
  user_archived_at: Date | null;
}

/**
 * Relit le pivot avec le statut de son propriétaire. Éligibilité EXACTEMENT celle de loadSourceOffer /
 * loadSourceDemand (service.ts). Version supérieure, pivot absent ou inéligible → superseded ;
 * version inférieure → échec ; sinon renvoie le propriétaire.
 */
async function checkPivot(ctx: Context): Promise<string> {
  const { lease, kind } = ctx;
  const table = kind === "offer" ? "offers" : "demands";
  const availability = kind === "offer" ? "t.availability_status" : "NULL::text";
  const result = await ctx.pool.query<PivotRow>(
    `SELECT t.owner_id, t.content_version, t.status, t.archived_at, ${availability} AS availability_status,
            u.status AS user_status, u.archived_at AS user_archived_at
       FROM ${table} t
       LEFT JOIN users u ON u.id = t.owner_id
      WHERE t.id = $1::uuid`,
    [lease.resourceId],
  );
  const row = result.rows[0];
  if (!row) return supersede(ctx);
  if (row.content_version > lease.resourceVersion) return supersede(ctx);
  if (row.content_version < lease.resourceVersion) return failWith(ctx, "pivot_version_regression");
  const ownerActive = row.user_status === "active" && row.user_archived_at === null;
  const eligible = kind === "offer"
    ? row.status === "published" && row.archived_at === null && row.availability_status !== "unavailable"
    : row.status === "active" && row.archived_at === null;
  if (!ownerActive || !eligible) return supersede(ctx);
  return row.owner_id;
}

interface LoadedPage {
  page: EvaluatedMatchPage<PivotRecord, CandidateRecord>;
  now: Date;
}

/** Heartbeat, hook, contrôle du pivot, horloge, puis 2C2 ; toute erreur de chargement relit le pivot. */
async function loadPage(
  ctx: Context,
  cursor: string | null,
  limit: number,
  chooseNow: () => Promise<Date> | Date,
): Promise<LoadedPage> {
  await heartbeat(ctx);
  await runHook(ctx.hooks.beforeFetchPage?.());
  const ownerId = await checkPivot(ctx);
  const now = await chooseNow();
  // Job de paire : TOUTE lecture (ouverture, reprise après crash) passe par la restriction interne à la demande
  // ciblée ; jamais de relecture de la liste des demandes de l'offre.
  const pairTarget = ctx.lease.jobType === PAIR_JOB_TYPE ? ctx.lease.targetResourceId : null;
  const options: InternalEvaluatedDemandMatchesQueryOptions = pairTarget
    ? { cursor: null, limit: 1, now, scoringOptions: ctx.scoringOptions, candidateId: pairTarget }
    : { cursor, limit, now, scoringOptions: ctx.scoringOptions };
  let page: EvaluatedMatchPage<PivotRecord, CandidateRecord>;
  try {
    page = (ctx.kind === "offer"
      ? await findEvaluatedDemandMatchesForOffer(ownerId, ctx.lease.resourceId, options, ctx.pool)
      : await findEvaluatedOfferMatchesForDemand(ownerId, ctx.lease.resourceId, options, ctx.pool)) as
      EvaluatedMatchPage<PivotRecord, CandidateRecord>;
  } catch (error) {
    if (error instanceof CatalogNotFoundError || error instanceof CatalogValidationError) {
      await checkPivot(ctx);
      return failWith(ctx, "source_load_error");
    }
    throw error;
  }
  if (page.source.contentVersion > ctx.lease.resourceVersion) return supersede(ctx);
  if (page.source.contentVersion < ctx.lease.resourceVersion) return failWith(ctx, "pivot_version_regression");
  ctx.pivot = page.source.record;
  return { page, now };
}

async function readState(ctx: Context): Promise<ChunkJobState> {
  const state = await readChunkState({ pool: ctx.pool, jobId: ctx.lease.jobId });
  if (!state || state.status !== "running" || state.claimToken !== ctx.lease.claimToken || !state.leaseValid) {
    throw new StopSignal("lease_lost");
  }
  return state;
}

function offerAndDemand(ctx: Context, candidate: CandidateRecord): { offer: OfferRecord; demand: DemandRecord } {
  const pivot = ctx.pivot as PivotRecord;
  return ctx.kind === "offer"
    ? { offer: pivot as OfferRecord, demand: candidate as DemandRecord }
    : { offer: candidate as OfferRecord, demand: pivot as DemandRecord };
}

/** Mêmes entrées que celles que 2D recalculera dans persistEvaluatedMatch. */
function expectedAttemptHash(ctx: Context, candidate: CandidateRecord, evaluatedAt: Date): string {
  const { offer, demand } = offerAndDemand(ctx, candidate);
  return computeAttemptHash({
    demandContentVersion: demand.contentVersion,
    demandId: demand.id,
    engineOfflineVersion: MATCHING_OFFLINE_CONTRACT_VERSION,
    engineScoringVersion: MATCHING_SCORING_CONTRACT_VERSION,
    evaluatedAt,
    offerContentVersion: offer.contentVersion,
    offerId: offer.id,
    scoringConfigHash: ctx.lease.scoringConfigHash as string,
  });
}

/** Ouvre un chunk : T_eval PostgreSQL, page 2C2 sous ce T_eval, manifeste initial puis initializeChunk. */
async function openChunk(
  ctx: Context,
  predecessor: ChunkManifest | null,
  cursorIn: string | null,
): Promise<{ manifest: ChunkManifest; records: Map<string, CachedRecord> | null }> {
  const { page, now } = await loadPage(ctx, cursorIn, ctx.pageSize, () => databaseNow(ctx));
  const chunkId = randomUUID();
  const manifest = buildInitialChunkManifest({
    chunkId,
    chunkIndex: predecessor ? predecessor.chunk_index + 1 : 0,
    predecessorChunkId: predecessor?.chunk_id ?? null,
    predecessorManifestVersion: predecessor?.manifest_version ?? null,
    cursorIn,
    cursorOut: page.nextCursor,
    evaluatedAt: now,
    scoringConfigHash: ctx.lease.scoringConfigHash as string,
    engineOfflineVersion: MATCHING_OFFLINE_CONTRACT_VERSION,
    engineScoringVersion: MATCHING_SCORING_CONTRACT_VERSION,
    candidates: page.items.map((item) => ({
      candidateId: item.candidateId,
      candidateVersion: item.candidateContentVersion,
      pairResourceId: ctx.lease.resourceId,
      pairResourceVersion: ctx.lease.resourceVersion,
      attemptId: deriveUuid("attempt", ctx.lease.jobId, chunkId, item.candidateId, 1),
      idempotencyKey: deriveUuid("idempotency", ctx.lease.jobId, chunkId, item.candidateId, 1),
      attemptHash: expectedAttemptHash(ctx, item.candidate, now),
    })),
  });
  const result = await initializeChunk({ pool: ctx.pool, lease: ctx.lease, manifest, leaseSeconds: ctx.leaseSeconds });
  switch (result.kind) {
    case "applied": {
      const records = new Map<string, CachedRecord>();
      for (const item of page.items) {
        records.set(item.candidateId, { candidate: item.candidate, evaluation: item.evaluation, scoring: item.scoring, now });
      }
      await runHook(ctx.hooks.afterInitialize?.());
      return { manifest, records };
    }
    case "already_applied": {
      const state = await readState(ctx);
      await runHook(ctx.hooks.afterInitialize?.());
      return { manifest: state.manifest as ChunkManifest, records: null };
    }
    case "lease_lost":
      throw new StopSignal("lease_lost");
    case "stale_chunk":
    case "conflict":
      throw new StopSignal("abandoned");
    case "rejected":
      return failWith(ctx, `chunk_${result.reason}`);
  }
}

/** Reprise : relit les enregistrements de la plage du chunk (curseur d'entrée jusqu'au curseur de sortie). */
async function loadResumeRecords(ctx: Context, manifest: ChunkManifest): Promise<Map<string, CachedRecord>> {
  const needed = new Set(
    manifest.candidates.filter((c) => c.attempts[c.attempts.length - 1].status === "pending").map((c) => c.candidate_id),
  );
  const records = new Map<string, CachedRecord>();
  const now = new Date(manifest.evaluated_at);
  let cursor = manifest.cursor_in;
  while (needed.size > 0) {
    const { page } = await loadPage(ctx, cursor, RESUME_PAGE_SIZE, () => now);
    for (const item of page.items) {
      records.set(item.candidateId, { candidate: item.candidate, evaluation: item.evaluation, scoring: item.scoring, now });
      needed.delete(item.candidateId);
    }
    if (!page.hasMore || page.nextCursor === null) break;
    if (manifest.cursor_out !== null && (page.nextCursor === manifest.cursor_out || isCursorStrictlyAfter(page.nextCursor, manifest.cursor_out))) break;
    cursor = page.nextCursor;
  }
  return records;
}

async function manifestFromState(ctx: Context): Promise<ChunkManifest> {
  const state = await readState(ctx);
  if (!state.manifest) throw new StopSignal("abandoned");
  return state.manifest;
}

async function acknowledgeWithMerge(
  ctx: Context,
  start: ChunkManifest,
  candidateId: string,
  attemptId: string,
  status: ResolvedCandidateStatus,
): Promise<ChunkManifest> {
  let current = start;
  for (let retry = 0; retry < MAX_MANIFEST_RETRIES; retry++) {
    const next = acknowledgeCandidateAttempt(current, candidateId, attemptId, status);
    const result = await acknowledgeCandidate({
      pool: ctx.pool, lease: ctx.lease, expectedChunkId: current.chunk_id, expectedManifestVersion: current.manifest_version,
      nextManifest: next, candidateId, attemptId, status, leaseSeconds: ctx.leaseSeconds,
    });
    switch (result.kind) {
      case "applied": return next;
      case "already_applied": return manifestFromState(ctx);
      case "lease_lost": throw new StopSignal("lease_lost");
      case "stale_chunk": throw new StopSignal("abandoned");
      case "rejected": return failWith(ctx, `chunk_${result.reason}`);
      case "conflict": current = result.fresh; break;
    }
  }
  return failWith(ctx, "manifest_conflict");
}

async function recordAttemptWithMerge(ctx: Context, start: ChunkManifest, candidateId: string, attempt: ChunkAttempt): Promise<ChunkManifest> {
  let current = start;
  for (let retry = 0; retry < MAX_MANIFEST_RETRIES; retry++) {
    const known = current.candidates.find((c) => c.candidate_id === candidateId);
    if (known?.attempts.some((a) => a.attempt_id === attempt.attempt_id)) return current;
    const next = appendCandidateAttempt(current, candidateId, attempt);
    const result = await recordCandidateAttempt({
      pool: ctx.pool, lease: ctx.lease, expectedChunkId: current.chunk_id, expectedManifestVersion: current.manifest_version,
      nextManifest: next, attemptId: attempt.attempt_id, leaseSeconds: ctx.leaseSeconds,
    });
    switch (result.kind) {
      case "applied": return next;
      case "already_applied": return manifestFromState(ctx);
      case "lease_lost": throw new StopSignal("lease_lost");
      case "stale_chunk": throw new StopSignal("abandoned");
      case "rejected": return failWith(ctx, `chunk_${result.reason}`);
      case "conflict": current = result.fresh; break;
    }
  }
  return failWith(ctx, "manifest_conflict");
}

function countStatus(ctx: Context, status: ResolvedCandidateStatus): void {
  if (status === "persisted") ctx.summary.persisted++;
  else if (status === "replayed") ctx.summary.replayed++;
  else if (status === "skipped_stale") ctx.summary.skippedStale++;
  else ctx.summary.alreadySuperseded++;
}

/** Évalue, persiste (2D) puis acquitte un candidat ; classement selon le plan §6.D. */
async function processCandidate(
  ctx: Context,
  start: ChunkManifest,
  candidateId: string,
  records: Map<string, CachedRecord>,
): Promise<ChunkManifest> {
  let current = start;
  let tries = 0;
  for (;;) {
    const entry = current.candidates.find((c) => c.candidate_id === candidateId)!;
    const attempt = entry.attempts[entry.attempts.length - 1];
    if (attempt.status !== "pending") return current;
    tries++;

    const record = records.get(candidateId);
    if (!record || record.candidate.contentVersion !== entry.candidate_version) {
      current = await acknowledgeWithMerge(ctx, current, candidateId, attempt.attempt_id, "skipped_stale");
      countStatus(ctx, "skipped_stale");
      return current;
    }

    // L'évaluation est calculée EXACTEMENT comme 2C2, avec le T_eval de CETTE tentative.
    const now = new Date(attempt.evaluated_at);
    let evaluation = record.evaluation;
    let scoring = record.scoring;
    if (record.now.getTime() !== now.getTime()) {
      const { offer, demand } = offerAndDemand(ctx, record.candidate);
      evaluation = evaluateOfflineMatching(offer, demand, { now });
      scoring = computeMatchingScore(evaluation, { ...ctx.scoringOptions, now });
    }
    if (expectedAttemptHash(ctx, record.candidate, now) !== attempt.attempt_hash) {
      return failWith(ctx, "attempt_hash_mismatch");
    }

    await heartbeat(ctx);
    await runHook(ctx.hooks.beforePersist?.(candidateId));
    const { offer, demand } = offerAndDemand(ctx, record.candidate);
    let status: ResolvedCandidateStatus;
    try {
      const persisted = await persistEvaluatedMatch({
        idempotencyKey: attempt.idempotency_key, offer, demand, evaluation, scoring, scoringOptions: ctx.scoringOptions,
      }, ctx.pool);
      if (persisted.attemptHash !== attempt.attempt_hash) return failWith(ctx, "attempt_hash_mismatch");
      status = persisted.isReplayed ? "replayed" : "persisted";
    } catch (error) {
      if (error instanceof StalePreconditionsError) {
        // Le pivot a-t-il changé ? Alors tout le job est obsolète ; sinon seul ce candidat l'est.
        await checkPivot(ctx);
        status = "skipped_stale";
      } else if (error instanceof StaleAttemptSupersededError) {
        status = "already_superseded";
      } else if (error instanceof EvaluationExpiredDuringLockWaitError) {
        if (tries >= MAX_ATTEMPTS_PER_CANDIDATE) return failWith(ctx, "attempt_limit");
        const freshNow = await databaseNow(ctx);
        const ordinal = entry.attempts.length + 1;
        current = await recordAttemptWithMerge(ctx, current, candidateId, {
          attempt_id: deriveUuid("attempt", ctx.lease.jobId, current.chunk_id, candidateId, ordinal),
          evaluated_at: freshNow.toISOString(),
          scoring_config_hash: current.scoring_config_hash,
          engine_offline_version: current.engine_offline_version,
          engine_scoring_version: current.engine_scoring_version,
          idempotency_key: deriveUuid("idempotency", ctx.lease.jobId, current.chunk_id, candidateId, ordinal),
          attempt_hash: expectedAttemptHash(ctx, record.candidate, freshNow),
          status: "pending",
          error_class: null,
        });
        continue;
      } else {
        throw error;
      }
    }
    await runHook(ctx.hooks.afterPersist?.(candidateId));
    current = await acknowledgeWithMerge(ctx, current, candidateId, attempt.attempt_id, status);
    countStatus(ctx, status);
    return current;
  }
}

async function resolveCandidates(
  ctx: Context,
  start: ChunkManifest,
  cached: Map<string, CachedRecord> | null,
): Promise<ChunkManifest> {
  let current = start;
  const pending = () => current.candidates.some((c) => c.attempts[c.attempts.length - 1].status === "pending");
  if (!pending()) return current;
  const records = cached ?? await loadResumeRecords(ctx, current);
  for (const candidate of start.candidates) {
    current = await processCandidate(ctx, current, candidate.candidate_id, records);
  }
  return current;
}

async function validateAndAdvance(ctx: Context, start: ChunkManifest): Promise<ChunkManifest> {
  await runHook(ctx.hooks.beforeValidate?.());
  let current = start;
  for (let retry = 0; retry < MAX_MANIFEST_RETRIES; retry++) {
    if (current.state === "validated") return current;
    const next = validateChunkManifest(current);
    const result = await validateChunk({
      pool: ctx.pool, lease: ctx.lease, expectedChunkId: current.chunk_id, expectedManifestVersion: current.manifest_version,
      nextManifest: next, leaseSeconds: ctx.leaseSeconds,
    });
    switch (result.kind) {
      case "applied":
        await runHook(ctx.hooks.afterValidate?.());
        return next;
      case "already_applied":
        return manifestFromState(ctx);
      case "lease_lost": throw new StopSignal("lease_lost");
      case "stale_chunk": throw new StopSignal("abandoned");
      case "rejected": return failWith(ctx, `chunk_${result.reason}`);
      case "conflict": current = result.fresh; break;
    }
  }
  return failWith(ctx, "manifest_conflict");
}

async function complete(ctx: Context): Promise<MatchingJobOutcome> {
  const result = await completeChunkedJob({ pool: ctx.pool, lease: ctx.lease });
  if (result === "completed") return "completed";
  if (result === "lease_lost") throw new StopSignal("lease_lost");
  return failWith(ctx, "complete_not_ready");
}

async function execute(ctx: Context): Promise<MatchingJobOutcome> {
  if (!(MATCHING_EVALUATION_JOB_TYPES as readonly string[]).includes(ctx.lease.jobType)) {
    return failWith(ctx, "unsupported_job_type");
  }
  if (ctx.lease.jobType === PAIR_JOB_TYPE && !ctx.lease.targetResourceId) return failWith(ctx, "missing_target");
  ctx.scoringOptions = await loadSealedConfig(ctx);
  for (;;) {
    const state = await readState(ctx);
    let manifest = state.manifest;
    let records: Map<string, CachedRecord> | null = null;
    if (manifest && manifest.state === "validated") {
      if (manifest.is_eof) return complete(ctx);
      ({ manifest, records } = await openChunk(ctx, manifest, state.cursorPosition));
    } else if (!manifest) {
      ({ manifest, records } = await openChunk(ctx, null, state.cursorPosition));
    }
    manifest = await resolveCandidates(ctx, manifest, records);
    manifest = await validateAndAdvance(ctx, manifest);
    ctx.summary.chunks++;
    if (manifest.is_eof) return complete(ctx);
  }
}

/** Exécute un job réservé jusqu'à son terme, son échec, la perte du bail ou un abandon de test. */
export async function runMatchingJob(options: RunMatchingJobOptions): Promise<MatchingJobRunResult> {
  const pool = requirePool(options.pool);
  const lease = requireLease(options.lease);
  const pageSize = requirePageSize(options.pageSize);
  const leaseSeconds = requireLeaseSeconds(options.leaseSeconds);
  const ctx: Context = {
    pool, lease, pageSize, leaseSeconds,
    kind: lease.jobType === "evaluate_demand_candidates" ? "demand" : "offer",
    hooks: options.hooks ?? {},
    scoringOptions: {},
    pivot: null,
    summary: { chunks: 0, persisted: 0, replayed: 0, skippedStale: 0, alreadySuperseded: 0 },
  };
  const result = (outcome: MatchingJobOutcome, errorCode?: string): MatchingJobRunResult =>
    ({ outcome, ...ctx.summary, ...(errorCode === undefined ? {} : { errorCode }) });
  try {
    return result(await execute(ctx));
  } catch (error) {
    if (error instanceof StopSignal) return result(error.outcome, error.errorCode);
    try {
      return await failWith(ctx, classifyFailure(error));
    } catch (stop) {
      if (stop instanceof StopSignal) return result(stop.outcome, stop.errorCode);
      throw stop;
    }
  }
}

/** Réserve (types d'évaluation seulement) puis exécute séquentiellement : une passe, aucune boucle. */
export async function runMatchingWorkerOnce(
  options: RunMatchingWorkerOnceOptions,
): Promise<Array<MatchingJobRunResult & { jobId: string }>> {
  const pool = requirePool(options.pool);
  const limit = options.limit === undefined ? 1 : options.limit;
  if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_WORKER_BATCH) {
    throw new MatchingJobValidationError(`limit doit être un entier entre 1 et ${MAX_WORKER_BATCH}.`);
  }
  requirePageSize(options.pageSize);
  const leaseSeconds = requireLeaseSeconds(options.leaseSeconds);
  const leases = await claimMatchingJobs({
    pool, workerId: options.workerId, limit, leaseSeconds, jobTypes: MATCHING_EVALUATION_JOB_TYPES,
  });
  const results: Array<MatchingJobRunResult & { jobId: string }> = [];
  for (const lease of leases) {
    const result = await runMatchingJob({ pool, lease, pageSize: options.pageSize, leaseSeconds, hooks: options.hooks });
    results.push({ jobId: lease.jobId, ...result });
  }
  return results;
}
