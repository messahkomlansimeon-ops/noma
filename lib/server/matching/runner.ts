import "server-only";

import type { Pool } from "pg";
import { BOOST_EXPIRY_DEFAULT_LIMIT, BOOST_EXPIRY_MAX_LIMIT } from "../boost/boost-config";
import { expireOfferBoosts } from "../boost/boosts";
import {
  MatchingJobValidationError,
  claimMatchingJobs,
  requireLeaseSeconds,
  requirePool,
  requireWorkerId,
  runMatchingJobMaintenance,
} from "./jobs";
import { runMarketStep, type MarketStepResult } from "../market/observe";
import { runNotificationStep, type NotifyHooks, type NotifyStepResult } from "../notifications/deliveries";
import { resolveNotificationTransport, type NotificationTransport } from "../notifications/transport";
import { runSubscriptionStep, type SubscriptionStepResult } from "../subscriptions/lifecycle";
import { emptyCollectResult, runCollectStep, type CollectStepOptions, type CollectStepResult } from "../external/collect";
import { EMPTY_CATCHUP_RESULT, runSublymusCatchupStep, type CatchupStepResult } from "../wallet/sublymus/catchup";
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
  /**
   * Boosts échus marqués `expired` (étape exécutée juste après l'étape temporelle). `skipped: true` : la migration 0011_offer_boosts
   * n'est pas enregistrée, l'étape n'a pas été exécutée (jamais une erreur).
   */
  boost: { expired: number; skipped: boolean };
  projected: ProjectOutboxBatchResult;
  maintenance: { deadLettered: number };
  jobs: MatchingCycleJobSummary[];
  /**
   * Étape « notify » (lot N1, exécutée en dernier) : envois externes SIMULÉS des notifications de nouvelles correspondances. `skipped: true` : la migration 0019
   * n'est pas appliquée (étape ignorée sans erreur) ; `noTransport: true` : aucun transport, aucun envoi. Voir NOTIFICATIONS.md.
   */
  notify: NotifyStepResult;
  /** Étape « subscriptions » (lot PRO1, après « notify ») : renouvellements, délais de grâce, fins d'abonnement, expiration des crédits promotionnels. `skipped: true` : migration 0021 absente. Voir OFFRE-PRO.md. */
  subscriptions: SubscriptionStepResult;
  /** Étape « paymentCatchup » (lot PAY1, après « subscriptions », AVANT « market » et « collect » : l'argent d'abord) : rattrape les recharges Sublymus en attente (webhook perdu). `skipped: true` : prestataire fictif ou migration 0026 absente. Budget d'un passage : 20 s. Voir PAIEMENT-WAVE.md. */
  paymentCatchup: CatchupStepResult;
  /**
   * Étape « market » (lot H1, exécutée après « notify ») : relevé quotidien des prix affichés des annonces publiées (une fois par jour UTC, jour courant seulement : aucun rattrapage).
   * `skipped: true` : la migration 0023 n'est pas enregistrée (étape ignorée sans erreur). Elle ne compte jamais dans `idle` : un relevé quotidien n'est pas du travail
   * qui doit relancer la boucle. Voir HISTORIQUE-PRIX.md.
   */
  market: MarketStepResult;
  /**
   * Étape « collect » (lot EXT1, exécutée en dernier, après « market ») : collecte MUTUALISÉE d'annonces externes par surveillance de marché, sources FICTIVES seulement. `skipped: true` : la migration 0025 n'est
   * pas appliquée (étape ignorée sans erreur) ; `noConnectors: true` : aucun connecteur disponible, rien collecté. Une panne d'une source n'est pas une erreur du cycle. Voir COLLECTE-EXTERNE.md.
   */
  collect: CollectStepResult;
  /** Aucun progrès : rien périmé, aucun boost expiré, rien lu par la projection, rien en maintenance, aucun job exécuté, aucune recharge Sublymus examinée par le rattrapage, aucune surveillance collectée, aucun envoi traité (un utilisateur en erreur ou laissé à un autre processus compte comme « au repos »). */
  idle: boolean;
  /** Codes stables des étapes en échec (`temporal_error_<code>`, `boost_error_<code>`, `projection_error_<code>`, `maintenance_error_<code>`, `job_error_<code>`, `notify_error_<code>`, `market_error_<code>`, `catchup_error_<code>`, `collect_error_<code>`). */
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
  /** Nombre maximal de boosts échus marqués `expired` en un cycle (1 à 1000, 200 par défaut). */
  boostLimit?: number;
  leaseSeconds?: number;
  /** Quand il est déclenché, plus aucun job n'est réservé ; le job en cours se termine. */
  signal?: AbortSignal;
  /**
   * Transport des envois externes SIMULÉS (lot N1). Absent : résolu à chaque cycle depuis l'environnement (`NODE_ENV=development` ET `NOMA_DEV_NOTIFY_CONSOLE=1`,
   * sinon aucun transport). `null` : aucun transport, quoi que dise l'environnement. Réservé aux tests pour en injecter un.
   */
  notificationTransport?: NotificationTransport | null;
  /** Horloge de l'étape « notify » (heures calmes, plafond du jour) : réservée aux tests. */
  notificationNow?: () => Date;
  /** Crochets de l'étape « notify » : réservés aux tests. */
  notificationHooks?: NotifyHooks;
  /** Instant de l'étape « market » (jour UTC du relevé) : réservé aux tests ; sinon l'horloge de la base. */
  marketNow?: () => Date;
  /** Étape « collect » (lot EXT1) : connecteurs, horloge, analyseur… Absent : connecteurs résolus depuis l'environnement (aucun sans `NOMA_EXTERNAL_FAKE=1`, jamais en production). Réservé aux tests. */
  collect?: Omit<CollectStepOptions, "pool" | "signal">;
  /** Étape « catchup » (lot PAY1) : environnement, appels sortants et horloge : réservés aux tests (qui les branchent sur la FAUSSE API locale). */
  paymentCatchup?: { env?: Record<string, string | undefined>; fetch?: typeof fetch; now?: Date };
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

/** La migration 0011 est-elle enregistrée ? Sans elle (ou sans table de migrations) l'étape boost est ignorée, jamais en erreur. */
async function isBoostMigrationRegistered(pool: Pool): Promise<boolean> {
  const table = await pool.query<{ present: boolean }>("SELECT to_regclass('noma_schema_migrations') IS NOT NULL AS present");
  if (table.rows[0]?.present !== true) return false;
  const result = await pool.query("SELECT 1 FROM noma_schema_migrations WHERE version = '0011_offer_boosts'");
  return result.rowCount === 1;
}

/**
 * Un cycle : balayage temporel, expiration des boosts échus, projection de l'outbox, maintenance, puis au plus maxJobs jobs
 * réservés UN PAR UN (une réservation en lot laisserait expirer les baux des jobs en attente). Les cinq étapes sont
 * cloisonnées : un échec est rapporté dans `errors` (codes stables) sans empêcher les suivantes.
 */
export async function runMatchingCycle(options: RunMatchingCycleOptions): Promise<MatchingCycleResult> {
  const pool = requirePool(options.pool);
  const workerId = requireWorkerId(options.workerId);
  const maxJobs = requireBoundedInteger(options.maxJobs === undefined ? DEFAULT_MAX_JOBS : options.maxJobs, "maxJobs", 1, MAX_MAX_JOBS);
  const projectionLimit = requireBoundedInteger(
    options.projectionLimit === undefined ? DEFAULT_PROJECTION_LIMIT : options.projectionLimit, "projectionLimit", 1, MAX_PROJECTION_LIMIT);
  const temporalLimit = requireBoundedInteger(
    options.temporalLimit === undefined ? DEFAULT_TEMPORAL_LIMIT : options.temporalLimit, "temporalLimit", 1, MAX_TEMPORAL_LIMIT);
  const boostLimit = requireBoundedInteger(
    options.boostLimit === undefined ? BOOST_EXPIRY_DEFAULT_LIMIT : options.boostLimit, "boostLimit", 1, BOOST_EXPIRY_MAX_LIMIT);
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
  // Étape boost : seulement si la migration 0011 est enregistrée (sinon ignorée, sans erreur). Cloisonnée comme les autres.
  let boost = { expired: 0, skipped: false };
  try {
    if (await isBoostMigrationRegistered(pool)) {
      boost = { expired: (await expireOfferBoosts({ pool, limit: boostLimit })).expired, skipped: false };
    } else {
      boost = { expired: 0, skipped: true };
    }
  } catch (error) {
    errors.push(`boost_error_${errorCodeOf(error)}`);
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
  // Étape « notify » (lot N1) : isolée comme l'étape boost, exécutée APRÈS les jobs (une notification née dans ce cycle part dans ce cycle). Sans la migration 0019,
  // elle est ignorée sans erreur ; sans transport, aucun envoi externe n'a lieu.
  let notify: NotifyStepResult = {
    skipped: false, noTransport: false, users: 0, messages: 0, delivered: 0, skippedDeliveries: 0, deferred: 0, failed: 0, retried: 0, expired: 0, busy: 0, errors: [],
  };
  try {
    const transport = options.notificationTransport === undefined ? resolveNotificationTransport(process.env) : (options.notificationTransport ?? undefined);
    notify = await runNotificationStep({ pool, transport, now: options.notificationNow, hooks: options.notificationHooks });
    for (const code of notify.errors) errors.push(`notify_error_${code}`);
  } catch (error) {
    errors.push(`notify_error_${errorCodeOf(error)}`);
  }
  let subscriptions: SubscriptionStepResult = { skipped: false, renewed: 0, pastDue: 0, ended: 0, unchanged: 0, pausedOffers: 0, promoExpired: 0, promoExpiredXof: 0, errors: [] };
  try {
    subscriptions = await runSubscriptionStep({ pool });
    for (const code of subscriptions.errors) errors.push(code);
  } catch (error) {
    errors.push(`subscriptions_error_${errorCodeOf(error)}`);
  }
  // Étape « paymentCatchup » (lot PAY1) : isolée dans son propre try, exécutée AVANT « market » et « collect » (budget propre de 20 s : une source externe lente ne la retarde jamais) ; sans prestataire Sublymus ou sans la migration 0026, elle est ignorée sans erreur.
  let paymentCatchup: CatchupStepResult = { ...EMPTY_CATCHUP_RESULT, errors: [] };
  try {
    paymentCatchup = await runSublymusCatchupStep({ pool, ...(options.paymentCatchup ?? {}) });
    for (const code of paymentCatchup.errors) errors.push(code);
  } catch (error) {
    errors.push(`catchup_error_${errorCodeOf(error)}`);
  }
  // Étape « market » (lot H1) : isolée comme les autres, exécutée en dernier. Sans la migration 0023, ignorée sans erreur ; une erreur de l'étape ne change rien aux autres.
  let market: MarketStepResult = { observed: 0, skipped: false, alreadyDone: false };
  try {
    market = await runMarketStep({ pool, now: options.marketNow?.() });
  } catch (error) {
    errors.push(`market_error_${errorCodeOf(error)}`);
  }
  // Étape « collect » (lot EXT1) : isolée comme les autres, exécutée en dernier (budget borné) ; ne lève jamais (ses erreurs sont des codes stables) et une panne d'une source n'est jamais une erreur du cycle.
  let collect = emptyCollectResult();
  try {
    collect = await runCollectStep({ ...options.collect, pool, signal });
    for (const code of collect.errors) errors.push(`collect_error_${code}`);
  } catch (error) {
    errors.push(`collect_error_${errorCodeOf(error)}`);
  }
  return {
    temporal,
    boost,
    projected,
    maintenance,
    jobs,
    notify,
    subscriptions,
    paymentCatchup,
    market,
    collect,
    // Au repos : l'utilisateur laissé à un autre processus (busy) ET l'utilisateur en erreur (une erreur de l'étape notify compte comme « au repos » : ses lignes ont
    // une tentative de plus et une attente croissante, `recordUserFailure`) ne comptent pas comme du travail ; sinon un échec permanent ferait tourner la boucle sans pause.
    idle: temporal.expired === 0 && boost.expired === 0 && projected.selected === 0 && maintenance.deadLettered === 0 && jobs.length === 0
      && notify.users - notify.busy - notify.errors.length <= 0 && notify.expired === 0
      && subscriptions.renewed + subscriptions.pastDue + subscriptions.ended + subscriptions.promoExpired === 0
      && paymentCatchup.examined === 0
      && collect.watchesProcessed === 0,
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
  /** Étape « notify » de chaque cycle (transport, horloge, crochets) : réservé aux tests. */
  notification?: Pick<RunMatchingCycleOptions, "notificationTransport" | "notificationNow" | "notificationHooks" | "paymentCatchup">;
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
      const result = await runMatchingCycle({ pool, workerId, maxJobs: maxJobsPerCycle, signal, ...options.notification });
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
