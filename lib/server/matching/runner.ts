import "server-only";

import type { Pool } from "pg";
import {
  MatchingJobValidationError,
  claimMatchingJobs,
  requireLeaseSeconds,
  requirePool,
  requireWorkerId,
  runMatchingJobMaintenance,
} from "./jobs";
import { projectOutboxBatch, type ProjectOutboxBatchResult } from "./projection";
import { runTemporalExpirySweep } from "./temporal";
import { runUserReactivationSweep, type UserReactivationSweepResult } from "./sweeps";
import { MATCHING_EVALUATION_JOB_TYPES, requirePageSize, runMatchingJob, type MatchingJobRunResult } from "./worker";

/**
 * Types exécutés par la boucle : les types d'évaluation (dont reevaluate_pair_temporal depuis 2E4C2) et le sweep de
 * réactivation. scoring_config_sweep n'y figure JAMAIS : il reste pending.
 */
export const MATCHING_RUNNER_JOB_TYPES = [...MATCHING_EVALUATION_JOB_TYPES, "user_reactivation_sweep"] as const;

const DEFAULT_MAX_JOBS = 5;
const MAX_MAX_JOBS = 50;
const DEFAULT_PROJECTION_LIMIT = 50;
const MAX_PROJECTION_LIMIT = 100;
const DEFAULT_TEMPORAL_LIMIT = 100;
const MAX_TEMPORAL_LIMIT = 500;
const DEFAULT_IDLE_DELAY_MS = 1_000;
const DEFAULT_MAX_IDLE_DELAY_MS = 30_000;
const MAX_DELAY_MS = 3_600_000;

export type MatchingCycleJobSummary =
  | ({ jobId: string; jobType: (typeof MATCHING_EVALUATION_JOB_TYPES)[number] } & MatchingJobRunResult)
  | ({ jobId: string; jobType: "user_reactivation_sweep" } & UserReactivationSweepResult);

export interface MatchingCycleResult {
  /** Évaluations périmées par le balayeur temporel (étape exécutée AVANT la projection). */
  temporal: { expired: number };
  projected: ProjectOutboxBatchResult;
  maintenance: { deadLettered: number };
  jobs: MatchingCycleJobSummary[];
  /** Aucun progrès : rien périmé, rien lu par la projection, rien en maintenance, aucun job exécuté (erreurs ou non). */
  idle: boolean;
  /** Codes stables des étapes en échec (`temporal_error_<code>`, `projection_error_<code>`, `maintenance_error_<code>`, `job_error_<code>`). */
  errors: string[];
}

export interface RunMatchingCycleOptions {
  pool: Pool;
  workerId: string;
  maxJobs?: number;
  pageSize?: number;
  projectionLimit?: number;
  /** Nombre maximal d'évaluations périmées par le balayeur temporel en un cycle (1 à 500, 100 par défaut). */
  temporalLimit?: number;
  leaseSeconds?: number;
  /** Quand il est déclenché, plus aucun job n'est réservé ; le job en cours se termine. */
  signal?: AbortSignal;
}

function requireBoundedInteger(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new MatchingJobValidationError(`${field} doit être un entier entre ${min} et ${max}.`);
  }
  return value;
}

function requireSignal(value: unknown): AbortSignal {
  if (typeof AbortSignal === "undefined" || !(value instanceof AbortSignal)) {
    throw new MatchingJobValidationError("Un AbortSignal est requis.");
  }
  return value;
}

/**
 * Un cycle : balayage temporel, projection de l'outbox, maintenance, puis au plus maxJobs jobs réservés UN PAR UN
 * (une réservation en lot laisserait expirer les baux des jobs en attente). Les quatre étapes sont cloisonnées :
 * un échec est rapporté dans `errors` (codes stables) sans empêcher les suivantes.
 */
export async function runMatchingCycle(options: RunMatchingCycleOptions): Promise<MatchingCycleResult> {
  const pool = requirePool(options.pool);
  const workerId = requireWorkerId(options.workerId);
  const maxJobs = requireBoundedInteger(options.maxJobs === undefined ? DEFAULT_MAX_JOBS : options.maxJobs, "maxJobs", 1, MAX_MAX_JOBS);
  const projectionLimit = requireBoundedInteger(
    options.projectionLimit === undefined ? DEFAULT_PROJECTION_LIMIT : options.projectionLimit, "projectionLimit", 1, MAX_PROJECTION_LIMIT);
  const temporalLimit = requireBoundedInteger(
    options.temporalLimit === undefined ? DEFAULT_TEMPORAL_LIMIT : options.temporalLimit, "temporalLimit", 1, MAX_TEMPORAL_LIMIT);
  const pageSize = options.pageSize === undefined ? undefined : requirePageSize(options.pageSize);
  const signal = options.signal === undefined ? undefined : requireSignal(options.signal);
  const leaseSeconds = options.leaseSeconds === undefined ? undefined : requireLeaseSeconds(options.leaseSeconds);

  // Étapes cloisonnées : l'échec de l'une n'empêche pas les suivantes. Seuls des codes stables sont conservés.
  const errors: string[] = [];
  let temporal = { expired: 0 };
  try {
    temporal = await runTemporalExpirySweep({ pool, limit: temporalLimit });
  } catch (error) {
    errors.push(`temporal_error_${errorCodeOf(error)}`);
  }
  let projected: ProjectOutboxBatchResult = { selected: 0, projected: 0, jobsInserted: 0, jobsAlreadyPresent: 0, ignored: 0, invalid: 0 };
  try {
    projected = await projectOutboxBatch({ pool, limit: projectionLimit });
  } catch (error) {
    errors.push(`projection_error_${errorCodeOf(error)}`);
  }
  let maintenance = { deadLettered: 0 };
  try {
    maintenance = await runMatchingJobMaintenance({ pool });
  } catch (error) {
    errors.push(`maintenance_error_${errorCodeOf(error)}`);
  }
  const jobs: MatchingCycleJobSummary[] = [];
  try {
    for (let index = 0; index < maxJobs; index++) {
      if (signal?.aborted) break;
      const [lease] = await claimMatchingJobs({ pool, workerId, limit: 1, leaseSeconds, jobTypes: MATCHING_RUNNER_JOB_TYPES });
      if (!lease) break;
      if (lease.jobType === "user_reactivation_sweep") {
        const result = await runUserReactivationSweep({ pool, lease, leaseSeconds });
        jobs.push({ jobId: lease.jobId, jobType: "user_reactivation_sweep", ...result });
      } else {
        const result = await runMatchingJob({ pool, lease, pageSize, leaseSeconds });
        jobs.push({ jobId: lease.jobId, jobType: lease.jobType as (typeof MATCHING_EVALUATION_JOB_TYPES)[number], ...result });
      }
    }
  } catch (error) {
    // La base est probablement malade : plus aucun job dans ce cycle. Le bail du job en cours expirera.
    errors.push(`job_error_${errorCodeOf(error)}`);
  }
  return {
    temporal,
    projected,
    maintenance,
    jobs,
    idle: temporal.expired === 0 && projected.selected === 0 && maintenance.deadLettered === 0 && jobs.length === 0,
    errors,
  };
}

export interface RunMatchingWorkerLoopOptions {
  pool: Pool;
  workerId: string;
  signal: AbortSignal;
  idleDelayMs?: number;
  maxIdleDelayMs?: number;
  maxJobsPerCycle?: number;
  onCycle?: (result: MatchingCycleResult) => void;
  /** Attente injectable pour les tests ; doit se terminer tôt quand le signal est déclenché. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Journal injectable (une ligne de texte, sans donnée métier). Défaut : console.error. */
  log?: (line: string) => void;
}

export interface MatchingWorkerLoopResult {
  /** Cycles menés à leur terme (un cycle en erreur n'est pas compté). */
  cycles: number;
  jobsRun: number;
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

/** Suffixe stable d'une erreur : jamais le message (il peut contenir hôte, requête ou identifiant). */
function errorCodeOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && /^[A-Za-z0-9_]{1,40}$/.test(code)) return code.toLowerCase();
  if (error instanceof MatchingJobValidationError) return "validation";
  return "unknown";
}

/** Code stable d'une erreur de cycle : jamais le message (il peut contenir hôte, requête ou identifiant). */
export function describeCycleError(error: unknown): string {
  return `cycle_error_${errorCodeOf(error)}`;
}

/**
 * Enchaîne des cycles jusqu'au déclenchement du signal. Inactivité : délai doublé jusqu'à maxIdleDelayMs,
 * remis au minimum dès qu'un cycle a travaillé. Une erreur de cycle est journalisée par code puis suivie
 * de la même attente ; la boucle ne meurt pas.
 */
export async function runMatchingWorkerLoop(options: RunMatchingWorkerLoopOptions): Promise<MatchingWorkerLoopResult> {
  const pool = requirePool(options.pool);
  const workerId = requireWorkerId(options.workerId);
  const signal = requireSignal(options.signal);
  const idleDelayMs = requireBoundedInteger(options.idleDelayMs === undefined ? DEFAULT_IDLE_DELAY_MS : options.idleDelayMs, "idleDelayMs", 1, MAX_DELAY_MS);
  const maxIdleDelayMs = requireBoundedInteger(
    options.maxIdleDelayMs === undefined ? DEFAULT_MAX_IDLE_DELAY_MS : options.maxIdleDelayMs, "maxIdleDelayMs", idleDelayMs, MAX_DELAY_MS);
  const maxJobsPerCycle = options.maxJobsPerCycle === undefined
    ? undefined
    : requireBoundedInteger(options.maxJobsPerCycle, "maxJobsPerCycle", 1, MAX_MAX_JOBS);
  for (const [field, value] of [["onCycle", options.onCycle], ["sleep", options.sleep], ["log", options.log]] as const) {
    if (value !== undefined && typeof value !== "function") throw new MatchingJobValidationError(`${field} doit être une fonction.`);
  }
  const sleep = options.sleep ?? abortableSleep;
  const log = options.log ?? ((line: string) => console.error(line));

  let delay = idleDelayMs;
  let cycles = 0;
  let jobsRun = 0;
  while (!signal.aborted) {
    let wait = false;
    try {
      const result = await runMatchingCycle({ pool, workerId, maxJobs: maxJobsPerCycle, signal });
      cycles++;
      jobsRun += result.jobs.length;
      for (const code of result.errors) log(`matching_worker ${code}`);
      options.onCycle?.(result);
      wait = result.idle;
    } catch (error) {
      log(`matching_worker ${describeCycleError(error)}`);
      wait = true;
    }
    if (signal.aborted) break;
    if (wait) {
      await sleep(delay, signal);
      delay = Math.min(delay * 2, maxIdleDelayMs);
    } else {
      delay = idleDelayMs;
    }
  }
  return { cycles, jobsRun };
}
