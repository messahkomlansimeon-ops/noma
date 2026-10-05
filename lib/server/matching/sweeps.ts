import "server-only";

import type { Pool } from "pg";
import {
  LEASE_FENCE,
  MatchingJobValidationError,
  failMatchingJob,
  requireLease,
  requireLeaseSeconds,
  requirePool,
  supersedeMatchingJob,
  type JobLease,
} from "./jobs";
import { MatchingProjectionIntegrityError, insertJob } from "./projection";
import {
  INITIAL_SCAN_POSITION,
  buildEvaluationChildJob,
  listEligibleResources,
  nextScanPosition,
  type ScanPosition,
} from "./resource-scan";
import { classifyFailure, readSealedConfig } from "./worker";

const DEFAULT_BATCH_SIZE = 100;
const MAX_BATCH_SIZE = 500;

export type UserReactivationSweepOutcome =
  | "completed" | "superseded" | "failed" | "dead_letter" | "lease_lost" | "abandoned";

export interface UserReactivationSweepResult {
  outcome: UserReactivationSweepOutcome;
  childJobsInserted: number;
  childJobsAlreadyPresent: number;
  /** Code stable de l'échec, présent pour failed et dead_letter. */
  errorCode?: string;
}

type HookResult = void | "abandon" | Promise<void | "abandon">;

/** Hooks réservés aux tests. Renvoyer "abandon" simule la mort du processus : plus aucune écriture. */
export interface UserReactivationSweepHooks {
  /** Avant l'ouverture de la transaction du lot `batchIndex` (0, 1, …). */
  beforeBatch?: (batchIndex: number) => HookResult;
  /** Après le COMMIT du lot `batchIndex`. */
  afterBatch?: (batchIndex: number) => HookResult;
  /** Après le dernier lot, avant la clôture du sweep. */
  beforeComplete?: () => HookResult;
}

export interface RunUserReactivationSweepOptions {
  pool: Pool;
  lease: JobLease;
  batchSize?: number;
  leaseSeconds?: number;
  hooks?: UserReactivationSweepHooks;
}

/** Arrêt contrôlé : porte le résultat final, jamais une erreur brute. */
class StopSignal extends Error {
  constructor(readonly outcome: UserReactivationSweepOutcome, readonly errorCode?: string) {
    super(outcome);
    this.name = "StopSignal";
  }
}

interface Context {
  pool: Pool;
  lease: JobLease;
  batchSize: number;
  leaseSeconds: number;
  hooks: UserReactivationSweepHooks;
  summary: { childJobsInserted: number; childJobsAlreadyPresent: number };
}

function requireBatchSize(value: unknown): number {
  const batchSize = value === undefined ? DEFAULT_BATCH_SIZE : value;
  if (typeof batchSize !== "number" || !Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > MAX_BATCH_SIZE) {
    throw new MatchingJobValidationError(`batchSize doit être un entier entre 1 et ${MAX_BATCH_SIZE}.`);
  }
  return batchSize;
}

async function runHook(result: HookResult): Promise<void> {
  if ((await result) === "abandon") throw new StopSignal("abandoned");
}

async function failWith(ctx: Context, errorCode: string): Promise<never> {
  const outcome = await failMatchingJob({ pool: ctx.pool, lease: ctx.lease, errorCode });
  throw new StopSignal(outcome, outcome === "lease_lost" ? undefined : errorCode);
}

async function supersede(ctx: Context): Promise<never> {
  const outcome = await supersedeMatchingJob({ pool: ctx.pool, lease: ctx.lease });
  throw new StopSignal(outcome);
}

interface UserRow {
  version: number;
  status: string;
  archived_at: Date | null;
}

/**
 * Relit le compte. Absent, version supérieure, suspendu ou archivé → superseded (une suspension ou une
 * réactivation ultérieure a son propre événement) ; version inférieure → échec.
 */
async function checkAccount(ctx: Context): Promise<void> {
  const result = await ctx.pool.query<UserRow>(
    "SELECT version, status, archived_at FROM users WHERE id = $1::uuid",
    [ctx.lease.resourceId],
  );
  const row = result.rows[0];
  if (!row) return supersede(ctx);
  if (row.version > ctx.lease.resourceVersion) return supersede(ctx);
  if (row.version < ctx.lease.resourceVersion) return failWith(ctx, "pivot_version_regression");
  if (row.status !== "active" || row.archived_at !== null) return supersede(ctx);
}

/**
 * Configuration scellée (même contrôle que le worker) puis génération : payload.generation doit être
 * la version du compte portée par le job.
 */
async function checkSealedConfig(ctx: Context): Promise<void> {
  const sealed = await readSealedConfig(ctx.pool, ctx.lease);
  if (!sealed.ok) return failWith(ctx, sealed.errorCode);
  if (sealed.payload.generation !== ctx.lease.resourceVersion) return failWith(ctx, "generation_mismatch");
}

/**
 * Un lot dans SA transaction : verrou du sweep sous LEASE_FENCE, lecture du lot, insertion des enfants,
 * extension du bail sous le même fence, COMMIT. Bail perdu à n'importe quel point → ROLLBACK.
 * Renvoie la position suivante, ou null en fin de parcours.
 */
async function runBatch(ctx: Context, position: ScanPosition): Promise<ScanPosition | null> {
  const client = await ctx.pool.connect();
  let rollbackFailed = false;
  try {
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    await client.query("SET LOCAL lock_timeout = '3s'");
    await client.query("SET LOCAL statement_timeout = '15s'");

    const locked = await client.query(
      `SELECT id FROM matching_jobs
        WHERE ${LEASE_FENCE} AND job_type = 'user_reactivation_sweep'
        FOR UPDATE`,
      [ctx.lease.jobId, ctx.lease.claimToken],
    );
    if (locked.rowCount !== 1) throw new StopSignal("lease_lost");

    const rows = await listEligibleResources(client, { kind: "account", ownerId: ctx.lease.resourceId }, position, ctx.batchSize);
    let inserted = 0;
    let present = 0;
    for (const row of rows) {
      const child = buildEvaluationChildJob({
        kind: position.kind,
        row,
        generation: ctx.lease.resourceVersion,
        scoringConfigHash: ctx.lease.scoringConfigHash as string,
        sourceEventId: ctx.lease.sourceEventId as string,
      });
      if (await insertJob(client, child)) inserted++;
      else present++;
    }

    const extended = await client.query(
      `UPDATE matching_jobs
          SET lock_expires_at = clock_timestamp() + ($3::int * interval '1 second'),
              updated_at = clock_timestamp()
        WHERE ${LEASE_FENCE} AND job_type = 'user_reactivation_sweep'`,
      [ctx.lease.jobId, ctx.lease.claimToken, ctx.leaseSeconds],
    );
    if (extended.rowCount !== 1) throw new StopSignal("lease_lost");
    await client.query("COMMIT");
    ctx.summary.childJobsInserted += inserted;
    ctx.summary.childJobsAlreadyPresent += present;

    return nextScanPosition(position, rows, ctx.batchSize);
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

async function complete(ctx: Context): Promise<UserReactivationSweepOutcome> {
  const result = await ctx.pool.query(
    `UPDATE matching_jobs
        SET status = 'completed',
            locked_by = NULL,
            locked_at = NULL,
            lock_expires_at = NULL,
            claim_token = NULL,
            completed_at = clock_timestamp(),
            updated_at = clock_timestamp()
      WHERE ${LEASE_FENCE} AND job_type = 'user_reactivation_sweep'`,
    [ctx.lease.jobId, ctx.lease.claimToken],
  );
  if (result.rowCount !== 1) throw new StopSignal("lease_lost");
  return "completed";
}

async function execute(ctx: Context): Promise<UserReactivationSweepOutcome> {
  if (ctx.lease.jobType !== "user_reactivation_sweep") return failWith(ctx, "unsupported_job_type");
  await checkSealedConfig(ctx);

  // Aucune progression persistée : une reprise refait tout le parcours, les identités déterministes
  // rendent ce rejeu sans effet.
  let position: ScanPosition | null = INITIAL_SCAN_POSITION;
  for (let batchIndex = 0; position; batchIndex++) {
    await runHook(ctx.hooks.beforeBatch?.(batchIndex));
    await checkAccount(ctx);
    try {
      position = await runBatch(ctx, position);
    } catch (error) {
      if (error instanceof MatchingProjectionIntegrityError) return failWith(ctx, "child_job_integrity_conflict");
      throw error;
    }
    await runHook(ctx.hooks.afterBatch?.(batchIndex));
  }
  await runHook(ctx.hooks.beforeComplete?.());
  return complete(ctx);
}

/**
 * Expanse un job user_reactivation_sweep en un job d'évaluation par ressource éligible du compte réactivé.
 * Aucune évaluation ici : les enfants sont exécutés par le worker d'évaluation.
 */
export async function runUserReactivationSweep(
  options: RunUserReactivationSweepOptions,
): Promise<UserReactivationSweepResult> {
  const pool = requirePool(options.pool);
  const lease = requireLease(options.lease);
  const batchSize = requireBatchSize(options.batchSize);
  const leaseSeconds = requireLeaseSeconds(options.leaseSeconds);
  const ctx: Context = {
    pool, lease, batchSize, leaseSeconds,
    hooks: options.hooks ?? {},
    summary: { childJobsInserted: 0, childJobsAlreadyPresent: 0 },
  };
  const result = (outcome: UserReactivationSweepOutcome, errorCode?: string): UserReactivationSweepResult =>
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
