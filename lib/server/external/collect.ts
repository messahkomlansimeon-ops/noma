import "server-only";

import type { Pool, PoolClient } from "pg";
import {
  BREAKER_FAILURE_THRESHOLD,
  BREAKER_PAUSE_MS,
  BREAKER_TRIAL_LEASE_MS,
  MAX_SOURCE_WAIT_MS,
  RUNS_RETENTION_DAYS,
  SEARCH_TIMEOUT_MS,
  SOURCE_LOCK_TIMEOUT_MS,
  STEP_MAX_WATCHES,
  STEP_TIME_BUDGET_MS,
  USAGE_RETENTION_DAYS,
  WATCH_RETRY_SECONDS,
  ALLOWED_SOURCE_TYPE,
} from "./config";
import { acceleratedQuotaShare } from "../active-search/config";
import { connectorFor, externalSchemaPresent, listSources, resolveConnectors, SOURCE_COLUMNS } from "./registry";
import { groupWatchDuplicates } from "./grouping";
import { sanitizeBatch, type SanitizedBatch } from "./sanitize";
import { readPseudonymKey } from "./secret";
import { isListingDataError, isStoreConflict, storeSearchResult, type Analyzer, type StoreOutcome } from "./store";
import { productKeyOfWatch, type ClaimedWatch, type ConnectorContext, type ProductKey, type SourceConnector, type SourceRow } from "./types";
import { claimDueWatches, finishWatch, readLeasedFrequency, releaseWatches, renewLease, syncMarketWatches, type SyncResult } from "./watches";

/**
 * Étape « collect » du worker (lot EXT1). Isolée comme les autres étapes : elle ne lève jamais, rapporte des codes stables, et une panne de la collecte ne change rien au reste du cycle.
 *
 *  1. migration 0025 absente : étape ignorée sans erreur (`skipped`) ;
 *  2. synchronisation des surveillances (création, réactivation, pause) ;
 *  3. sans connecteur (production, ou fictifs non autorisés) : rien de plus (`noConnectors`) ;
 *  4. réservation des surveillances dues (`FOR UPDATE SKIP LOCKED`, bail de 10 min avec JETON) : une collecte par CLÉ PRODUIT, jamais une par besoin. Le bail est revérifié (et
 *     prolongé) juste avant d'interroger les sources ; un exécuteur dont le bail a été repris par un autre n'interroge rien et ne clôt rien (`leaseLost`) ;
 *  5. pour chaque surveillance, chaque source active est interrogée UNE fois, dans son budget (quota de la source par jour, budget de la surveillance par source et par jour), après
 *     le délai minimal de la source, avec un délai maximal par recherche. AU SEIN d'une surveillance les sources sont interrogées en parallèle : une source lente ou en panne ne
 *     retarde pas les autres sources de CETTE surveillance. Les surveillances, elles, se suivent : la surveillance suivante attend la fin de la précédente, donc de sa source la plus
 *     lente (au plus 8 s de recherche + 5 s d'attente du délai minimal + le stockage) ;
 *  6. BUDGET DE TEMPS de l'étape (10 s par défaut) : une surveillance n'est commencée que si le budget n'est pas épuisé ; les surveillances réservées mais non commencées sont rendues
 *     tout de suite pour le cycle suivant, SANS consommer ni quota ni budget. Une surveillance commencée est toujours terminée : l'étape dure donc au plus le budget plus la durée de la
 *     dernière surveillance commencée ;
 *  7. délai minimal d'une source JAMAIS raccourci : si l'attente nécessaire dépasse 5 s, la requête est refusée (motif « intervalle », compteurs annulés) et la surveillance revient dans
 *     10 minutes ; un arrêt demandé pendant l'attente rend la réservation sans appel ; le verrou de la ligne d'une source n'est attendu que 2 s (source « occupée », pas une erreur) ;
 *  8. DISJONCTEUR par source : 3 échecs de suite, pause de 30 minutes, puis UN SEUL essai décisif (jeton pris sous le verrou de la source) ;
 *  9. réponse tronquée à ses 4 × 50 premières entrées, nettoyée (numéros de téléphone retirés, dates absurdes écartées), analysée une fois par contenu, stockée (une annonce refusée par
 *     la base est rejetée seule), regroupée entre sources ; disponibilité mise à jour. Une erreur de DONNÉE de la base, un interblocage ou une réponse inexploitable sont des
 *     échecs de la SOURCE (journal, disjoncteur), jamais des erreurs d'infrastructure ;
 * 10. prochaine échéance : la fréquence de la surveillance ; 10 minutes si aucune source n'a pu être interrogée ou si une source a été refusée pour son délai minimal ou occupée ; le
 *     prochain minuit UTC si SEUL le quota ou le budget du jour empêche la collecte.
 *
 * Aucun appel réseau : les connecteurs sont fictifs et ne reçoivent aucun client réseau.
 */

export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

export interface CollectHooks {
  /** Après la réservation des surveillances, avant leur traitement. */
  afterClaim?: (watchIds: readonly string[]) => void | Promise<void>;
  /** Juste avant l'appel à une source (requête réservée, délai écoulé, arrêt non demandé). */
  beforeSource?: (sourceCode: string, watchId: string) => void | Promise<void>;
}

export interface CollectStepOptions {
  pool: Pool;
  /** Absent : résolus depuis l'environnement (`resolveConnectors`). `null` ou liste vide : aucune collecte. Réservé aux tests et à l'amorçage de démonstration. */
  connectors?: readonly SourceConnector[] | null;
  now?: () => Date;
  sleep?: Sleep;
  analyze?: Analyzer;
  /** Clé d'empreinte (HMAC) des identifiants externes qui ressemblent à un numéro. Absent : dérivée de NOMA_AUTH_SECRET ; `null` : aucune clé (ces annonces sont rejetées). */
  pseudonymKey?: Uint8Array | null;
  signal?: AbortSignal;
  /** Surveillances traitées au plus (défaut 3). */
  maxWatches?: number;
  /** Délai d'une recherche auprès d'une source (défaut 8 s). */
  searchTimeoutMs?: number;
  /** Budget de temps de l'étape (défaut 10 s) : au-delà, les surveillances non commencées sont rendues. */
  stepBudgetMs?: number;
  /** Forcer ces surveillances, dues ou non (amorçage de démonstration, essais). */
  only?: readonly string[];
  hooks?: CollectHooks;
}

export interface CollectStepResult {
  /** Migration 0025 absente : étape ignorée sans erreur. */
  skipped: boolean;
  /** Aucun connecteur disponible : surveillances synchronisées, rien collecté. */
  noConnectors: boolean;
  sync: SyncResult;
  claimed: number;
  /** Surveillances réservées, interrogées et closes par CET exécuteur. */
  watchesProcessed: number;
  /** Surveillances rendues sans avoir été (entièrement) traitées : budget de temps, arrêt demandé, arrêt pendant une attente. */
  released: number;
  /** Surveillances dont le bail a été repris par un autre exécuteur avant la fin : rien n'a été écrit sur la surveillance. */
  leaseLost: number;
  sourceCalls: number;
  sourceFailures: number;
  breakerOpened: number;
  breakerSkipped: number;
  /** Requêtes refusées : quota du jour de la source atteint. */
  quotaSkipped: number;
  /** Requêtes refusées : budget du jour de la surveillance, pour cette source, atteint. */
  budgetSkipped: number;
  /** Requêtes refusées : le délai minimal de la source exigeait une attente de plus de 5 s (quota et budget non consommés). */
  intervalSkipped: number;
  /** Requêtes refusées : la ligne de la source était verrouillée par un autre processus depuis plus de 2 s. */
  busySkipped: number;
  /** Requêtes réservées puis rendues sans appel parce qu'un arrêt a été demandé pendant l'attente. */
  abortedRequests: number;
  inactiveSources: number;
  /** Attentes imposées par le délai minimal d'une source. */
  waits: number;
  stored: number;
  created: number;
  changed: number;
  unchanged: number;
  revived: number;
  goneBySource: number;
  goneByAbsence: number;
  analyzed: number;
  analysisReused: number;
  grouped: number;
  /** Regroupements abandonnés pour un interblocage (repris à la collecte suivante). */
  groupingConflicts: number;
  /** Écritures d'une réponse de source reprises après un interblocage (zéro tant que les verrous sont pris dans l'ordre). */
  storeRetries: number;
  rejected: number;
  phoneRemoved: number;
  duplicatesInResponse: number;
  truncated: number;
  /** Codes stables des erreurs de l'étape (jamais un message). Une panne d'une SOURCE n'en est pas une : elle est comptée dans `sourceFailures`. */
  errors: string[];
}

export function emptyCollectResult(): CollectStepResult {
  return {
    skipped: false, noConnectors: false, sync: { activeKeys: 0, created: 0, reactivated: 0, paused: 0, accelerated: 0, decelerated: 0 }, claimed: 0, watchesProcessed: 0, released: 0, leaseLost: 0, sourceCalls: 0,
    sourceFailures: 0, breakerOpened: 0, breakerSkipped: 0, quotaSkipped: 0, budgetSkipped: 0, intervalSkipped: 0, busySkipped: 0, abortedRequests: 0, inactiveSources: 0, waits: 0,
    stored: 0, created: 0, changed: 0, unchanged: 0, revived: 0, goneBySource: 0, goneByAbsence: 0, analyzed: 0, analysisReused: 0, grouped: 0, groupingConflicts: 0, storeRetries: 0, rejected: 0,
    phoneRemoved: 0, duplicatesInResponse: 0, truncated: 0, errors: [],
  };
}

/** Code stable d'une erreur d'infrastructure : jamais le message (il peut contenir hôte, requête ou identifiant). */
export function collectErrorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && /^[A-Za-z0-9_]{1,40}$/.test(code)) return code.toLowerCase();
  return "unknown";
}

const defaultSleep: Sleep = (ms, signal) =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });

/** Échec d'une recherche ou de son stockage, classé en un code stable. `store_conflict` : interblocage persistant à l'écriture (ni la faute de la source ni de l'infrastructure). */
export type SourceFailureCode = "timeout" | "invalid_response" | "connector_error" | "store_conflict";

class SourceTimeout extends Error {
  constructor() {
    super("source_timeout");
    this.name = "SourceTimeout";
  }
}

/** Appelle le connecteur avec un délai maximal : le signal est déclenché ET la réponse est abandonnée, même si le connecteur l'ignore. */
async function searchWithTimeout(connector: SourceConnector, key: ProductKey, now: Date, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new SourceTimeout());
    }, timeoutMs);
  });
  const context: ConnectorContext = { signal: controller.signal, now };
  try {
    return await Promise.race([Promise.resolve().then(() => connector.search(key, context)), expired]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

type RefusalReason = "inactive" | "breaker" | "quota" | "budget" | "interval" | "busy";

/** Ce qu'il faut pour RENDRE une réservation (compteurs, dernière requête, jeton d'essai) si la requête ne part finalement pas. */
interface Ticket {
  day: string;
  /** La requête a été comptée dans la part ACCÉLÉRÉE du quota de la source (surveillance accélérée par la recherche active). */
  accelerated: boolean;
  reservedAt: Date;
  previousRequestAt: Date | null;
  trialUntil: Date | null;
}

type Reservation = { granted: true; waitMs: number; ticket: Ticket } | { granted: false; reason: RefusalReason };

const utcDay = (date: Date): string => date.toISOString().slice(0, 10);

/** Prochain minuit UTC strictement après `now` (les compteurs de quota et de budget sont par jour UTC). */
export function nextUtcMidnight(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
}

/** Transaction courte sur la base : jamais plus de `SOURCE_LOCK_TIMEOUT_MS` d'attente d'un verrou de ligne. */
async function withShortTransaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL lock_timeout = '${SOURCE_LOCK_TIMEOUT_MS}ms'`);
    const value = await work(client);
    await client.query("COMMIT");
    return value;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Réserve UNE requête, de façon atomique : source active et disjoncteur fermé (relus sous le verrou de la ligne de la source, attendu 2 s au plus), UN SEUL essai décisif quand le
 * disjoncteur est semi-ouvert (jeton pris sous ce verrou), quota du jour de la source, budget du jour de la surveillance pour cette source (compteurs incrémentés seulement s'ils
 * restent sous la limite), puis délai minimal de la source : si l'attente nécessaire dépasse 5 s la requête est refusée et TOUT est annulé (compteurs compris). Tout ou rien.
 */
async function reserveRequest(pool: Pool, watch: ClaimedWatch, sourceCode: string, now: Date): Promise<Reservation> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL lock_timeout = '${SOURCE_LOCK_TIMEOUT_MS}ms'`);
    const locked = await client.query<SourceRow>(`SELECT ${SOURCE_COLUMNS} FROM external_sources WHERE code = $1 FOR UPDATE`, [sourceCode]);
    const source = locked.rows[0];
    const refuse = async (reason: RefusalReason): Promise<Reservation> => {
      await client.query("ROLLBACK");
      return { granted: false, reason };
    };
    if (!source || !source.enabled || source.type !== ALLOWED_SOURCE_TYPE) return await refuse("inactive");
    if (source.breaker_open_until !== null && source.breaker_open_until.getTime() > now.getTime()) return await refuse("breaker");
    // Semi-ouvert : la pause est écoulée mais le dernier essai n'a pas réussi. UN seul essai décisif à la fois ; son jeton expire de lui-même si son processus meurt.
    const halfOpen = source.consecutive_failures >= BREAKER_FAILURE_THRESHOLD;
    if (halfOpen && source.breaker_trial_until !== null && source.breaker_trial_until.getTime() > now.getTime()) return await refuse("breaker");
    const day = utcDay(now);
    if (source.daily_quota < 1) return await refuse("quota");
    // Surveillance ACCÉLÉRÉE (recherche active, lot RA1-bis) : ses requêtes ne consomment qu'une PART du quota de la source (la moitié) ; la part ordinaire reste réservée.
    const accelerated = watch.accelerated === true ? 1 : 0;
    const acceleratedShare = acceleratedQuotaShare(source.daily_quota);
    if (accelerated === 1 && acceleratedShare < 1) return await refuse("quota");
    const quota = await client.query(
      `INSERT INTO external_source_usage (source_code, day, requests, accelerated_requests) VALUES ($1, $2::date, 1, $4::int)
       ON CONFLICT (source_code, day) DO UPDATE
         SET requests = external_source_usage.requests + 1, accelerated_requests = external_source_usage.accelerated_requests + $4::int
         WHERE external_source_usage.requests < $3::int AND ($4::int = 0 OR external_source_usage.accelerated_requests < $5::int)
       RETURNING requests`,
      [sourceCode, day, source.daily_quota, accelerated, acceleratedShare],
    );
    if (quota.rowCount === 0) return await refuse("quota");
    if (watch.daily_request_budget < 1) return await refuse("budget");
    const budget = await client.query(
      `INSERT INTO market_watch_usage (watch_id, source_code, day, requests) VALUES ($1::uuid, $2, $3::date, 1)
       ON CONFLICT (watch_id, source_code, day) DO UPDATE SET requests = market_watch_usage.requests + 1 WHERE market_watch_usage.requests < $4::int
       RETURNING requests`,
      [watch.id, sourceCode, day, watch.daily_request_budget],
    );
    if (budget.rowCount === 0) return await refuse("budget");
    const earliest = source.last_request_at === null ? 0 : source.last_request_at.getTime() + source.min_interval_ms;
    const waitMs = Math.max(0, earliest - now.getTime());
    // Le délai minimal n'est jamais raccourci : une attente trop longue refuse la requête (le ROLLBACK annule les compteurs ci-dessus).
    if (waitMs > MAX_SOURCE_WAIT_MS) return await refuse("interval");
    const reservedAt = new Date(now.getTime() + waitMs);
    const trialUntil = halfOpen ? new Date(now.getTime() + waitMs + BREAKER_TRIAL_LEASE_MS) : null;
    await client.query("UPDATE external_sources SET last_request_at = $2::timestamptz, breaker_trial_until = $3::timestamptz, updated_at = $4::timestamptz WHERE code = $1", [
      sourceCode, reservedAt, trialUntil, now,
    ]);
    await client.query("COMMIT");
    return { granted: true, waitMs, ticket: { day, accelerated: accelerated === 1, reservedAt, previousRequestAt: source.last_request_at, trialUntil } };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    // Verrou de la source tenu plus de 2 s par un autre processus : source « occupée », pas une panne d'infrastructure.
    if ((error as { code?: unknown } | null)?.code === "55P03") return { granted: false, reason: "busy" };
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Rend une réservation dont la requête ne part pas (arrêt demandé pendant l'attente) : compteurs du jour décrémentés, dernière requête de la source rétablie SI personne n'a
 * réservé depuis, jeton d'essai décisif rendu.
 */
async function releaseReservation(pool: Pool, watchId: string, sourceCode: string, ticket: Ticket): Promise<void> {
  await withShortTransaction(pool, async (client) => {
    await client.query(
      "UPDATE external_source_usage SET requests = GREATEST(requests - 1, 0), accelerated_requests = GREATEST(accelerated_requests - $3::int, 0) WHERE source_code = $1 AND day = $2::date",
      [sourceCode, ticket.day, ticket.accelerated ? 1 : 0],
    );
    await client.query("UPDATE market_watch_usage SET requests = GREATEST(requests - 1, 0) WHERE watch_id = $1::uuid AND source_code = $2 AND day = $3::date", [watchId, sourceCode, ticket.day]);
    await client.query("UPDATE external_sources SET last_request_at = $2::timestamptz WHERE code = $1 AND last_request_at = $3::timestamptz", [sourceCode, ticket.previousRequestAt, ticket.reservedAt]);
    if (ticket.trialUntil !== null) {
      await client.query("UPDATE external_sources SET breaker_trial_until = NULL WHERE code = $1 AND breaker_trial_until = $2::timestamptz", [sourceCode, ticket.trialUntil]);
    }
  });
}

async function recordSuccess(pool: Pool, sourceCode: string, now: Date): Promise<void> {
  await withShortTransaction(pool, (client) =>
    client.query(
      `UPDATE external_sources SET consecutive_failures = 0, breaker_open_until = NULL, breaker_trial_until = NULL, last_success_at = $2::timestamptz, last_error_code = NULL, updated_at = $2::timestamptz WHERE code = $1`,
      [sourceCode, now],
    ),
  );
}

/** Enregistre un échec ; au 3e échec de suite (et à chaque échec ensuite), le disjoncteur s'ouvre pour 30 minutes. Renvoie vrai si le disjoncteur est ouvert à l'issue. */
async function recordFailure(pool: Pool, sourceCode: string, code: SourceFailureCode, now: Date): Promise<boolean> {
  const updated = await withShortTransaction(pool, (client) =>
    client.query<{ consecutive_failures: number; breaker_open_until: Date | null }>(
      `UPDATE external_sources
          SET consecutive_failures = consecutive_failures + 1, last_failure_at = $2::timestamptz, last_error_code = $3, breaker_trial_until = NULL,
              breaker_open_until = CASE WHEN consecutive_failures + 1 >= $4::int THEN $2::timestamptz + ($5::int * interval '1 millisecond') ELSE breaker_open_until END,
              updated_at = $2::timestamptz
        WHERE code = $1
        RETURNING consecutive_failures, breaker_open_until`,
      [sourceCode, now, code, BREAKER_FAILURE_THRESHOLD, BREAKER_PAUSE_MS],
    ),
  );
  const row = updated.rows[0];
  return row !== undefined && row.consecutive_failures >= BREAKER_FAILURE_THRESHOLD;
}

async function recordRun(
  pool: Pool,
  watchId: string,
  sourceCode: string,
  startedAt: Date,
  durationMs: number,
  detail: { status: "ok" } & Partial<Pick<StoreOutcome, "stored" | "created" | "changed" | "goneBySource" | "goneByAbsence">> | { status: "error"; code: SourceFailureCode },
): Promise<void> {
  const finishedAt = new Date(startedAt.getTime() + durationMs);
  const ok = detail.status === "ok";
  await pool.query(
    `INSERT INTO external_collect_runs (watch_id, source_code, started_at, finished_at, status, listing_count, created_count, changed_count, gone_count, error_code, duration_ms)
     VALUES ($1::uuid, $2, $3::timestamptz, $4::timestamptz, $5, $6::int, $7::int, $8::int, $9::int, $10, $11::int)`,
    [
      watchId, sourceCode, startedAt, finishedAt, detail.status,
      ok ? (detail.stored ?? 0) : 0, ok ? (detail.created ?? 0) : 0, ok ? (detail.changed ?? 0) : 0, ok ? (detail.goneBySource ?? 0) + (detail.goneByAbsence ?? 0) : 0,
      detail.status === "error" ? detail.code : null, Math.min(durationMs, 2_000_000_000),
    ],
  );
}

interface Context {
  pool: Pool;
  clock: () => Date;
  sleep: Sleep;
  analyze?: Analyzer;
  pseudonymKey: Uint8Array | null;
  signal?: AbortSignal;
  timeoutMs: number;
  connectors: ReadonlyMap<string, SourceConnector>;
  hooks: CollectHooks;
  result: CollectStepResult;
}

function addOutcome(result: CollectStepResult, outcome: StoreOutcome): void {
  result.stored += outcome.stored;
  result.created += outcome.created;
  result.changed += outcome.changed;
  result.unchanged += outcome.unchanged;
  result.revived += outcome.revived;
  result.goneBySource += outcome.goneBySource;
  result.goneByAbsence += outcome.goneByAbsence;
  result.analyzed += outcome.analyzed;
  result.analysisReused += outcome.analysisReused;
  result.rejected += outcome.rejected;
  result.phoneRemoved += outcome.phoneRemoved;
  result.duplicatesInResponse += outcome.duplicatesInResponse;
  result.truncated += outcome.truncated;
}

type SourceVerdict = { status: "queried" } | { status: "refused"; reason: RefusalReason } | { status: "aborted" };

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Stocke une réponse ; un interblocage (rare : les verrous sont pris dans l'ordre) est retenté UNE fois. */
async function storeWithRetry(ctx: Context, watch: ClaimedWatch, sourceCode: string, batch: SanitizedBatch): Promise<StoreOutcome> {
  const attempt = (): Promise<StoreOutcome> => storeSearchResult(ctx.pool, { watch, sourceCode, batch, now: ctx.clock(), analyze: ctx.analyze });
  try {
    return await attempt();
  } catch (error) {
    if (!isStoreConflict(error)) throw error;
    ctx.result.storeRetries += 1;
    await pause(40 + Math.floor(Math.random() * 60));
    return await attempt();
  }
}

/** Interroge UNE source pour une surveillance. Les pannes de la source sont absorbées (comptées, disjoncteur) ; seules les erreurs d'infrastructure remontent. */
async function querySource(ctx: Context, watch: ClaimedWatch, source: SourceRow, connector: SourceConnector): Promise<SourceVerdict> {
  const { pool, result } = ctx;
  const reservation = await reserveRequest(pool, watch, source.code, ctx.clock());
  if (!reservation.granted) {
    if (reservation.reason === "breaker") result.breakerSkipped += 1;
    else if (reservation.reason === "quota") result.quotaSkipped += 1;
    else if (reservation.reason === "budget") result.budgetSkipped += 1;
    else if (reservation.reason === "interval") result.intervalSkipped += 1;
    else if (reservation.reason === "busy") result.busySkipped += 1;
    else result.inactiveSources += 1;
    return { status: "refused", reason: reservation.reason };
  }
  if (reservation.waitMs > 0) {
    result.waits += 1;
    await ctx.sleep(reservation.waitMs, ctx.signal);
  }
  // Arrêt demandé pendant l'attente (l'attente est alors écourtée) : la requête ne part PAS, la réservation est rendue.
  if (ctx.signal?.aborted) {
    await releaseReservation(pool, watch.id, source.code, reservation.ticket);
    result.abortedRequests += 1;
    return { status: "aborted" };
  }
  await ctx.hooks.beforeSource?.(source.code, watch.id);
  const startedAt = ctx.clock();
  const began = performance.now();
  result.sourceCalls += 1;
  const duration = (): number => Math.max(0, Math.round(performance.now() - began));
  const fail = async (code: SourceFailureCode, rejected = 0): Promise<SourceVerdict> => {
    result.sourceFailures += 1;
    result.rejected += rejected;
    if (await recordFailure(pool, source.code, code, ctx.clock())) result.breakerOpened += 1;
    await recordRun(pool, watch.id, source.code, startedAt, duration(), { status: "error", code });
    return { status: "queried" };
  };

  let response: unknown;
  try {
    response = await searchWithTimeout(connector, productKeyOfWatch(watch), startedAt, ctx.timeoutMs);
  } catch (error) {
    return await fail(error instanceof SourceTimeout ? "timeout" : "connector_error");
  }
  if (!Array.isArray(response)) return await fail("invalid_response");

  // Nettoyage et stockage d'UNE source : une réponse que le nettoyage ou la base ne supportent pas est un échec de CETTE source, pas de l'infrastructure.
  let batch: SanitizedBatch;
  try {
    batch = sanitizeBatch(response as unknown[], startedAt, { pseudonymKey: ctx.pseudonymKey });
  } catch {
    return await fail("invalid_response");
  }
  if ((response as unknown[]).length > 0 && batch.listings.length === 0 && batch.duplicatesInResponse === 0) {
    // Une réponse qui n'est faite que de rebuts : la source a changé de format. C'est un échec de la source, pas une absence d'annonces.
    return await fail("invalid_response", batch.rejected);
  }
  let outcome: StoreOutcome;
  try {
    outcome = await storeWithRetry(ctx, watch, source.code, batch);
  } catch (error) {
    if (isListingDataError(error)) return await fail("invalid_response", batch.rejected);
    if (isStoreConflict(error)) return await fail("store_conflict", batch.rejected);
    throw error;
  }
  addOutcome(result, outcome);
  await recordSuccess(pool, source.code, ctx.clock());
  await recordRun(pool, watch.id, source.code, startedAt, duration(), { status: "ok", ...outcome });
  return { status: "queried" };
}

/** Bilan d'une surveillance, de quoi décider de sa prochaine échéance. */
export interface WatchVerdict {
  /** Sources réellement interrogées. */
  queried: number;
  /** Sources actives (activées, avec connecteur) : interrogées ou refusées. */
  active: number;
  /** Sources refusées pour le quota du jour ou le budget du jour. */
  dayLimited: number;
  /** Sources refusées pour leur délai minimal ou parce qu'occupées : à reprendre bientôt. */
  transient: number;
  /** Un arrêt a été demandé pendant une attente : la surveillance est rendue. */
  aborted: boolean;
}

/**
 * Prochaine échéance d'une surveillance. Une collecte aboutie : la fréquence de la surveillance. Une source refusée pour son délai minimal (ou occupée), ou aucune source
 * interrogée : 10 minutes. Aucune source interrogée parce que le quota ou le budget du jour de TOUTES les sources actives est atteint : prochain minuit UTC.
 */
export function planNextRun(now: Date, frequencySeconds: number, verdict: Pick<WatchVerdict, "queried" | "active" | "dayLimited" | "transient">): Date {
  if (verdict.queried > 0 && verdict.transient === 0) return new Date(now.getTime() + frequencySeconds * 1_000);
  if (verdict.queried === 0 && verdict.transient === 0 && verdict.active > 0 && verdict.dayLimited === verdict.active) return nextUtcMidnight(now);
  return new Date(now.getTime() + WATCH_RETRY_SECONDS * 1_000);
}

/** Collecte UNE surveillance : toutes les sources actives, en parallèle. */
async function collectWatch(ctx: Context, watch: ClaimedWatch): Promise<WatchVerdict> {
  const sources = await listSources(ctx.pool);
  const tasks: Array<Promise<SourceVerdict>> = [];
  for (const source of sources) {
    const connector = connectorFor(source, ctx.connectors);
    if (!source.enabled || connector === null) {
      ctx.result.inactiveSources += 1;
      continue;
    }
    tasks.push(querySource(ctx, watch, source, connector));
  }
  const settled = await Promise.allSettled(tasks);
  const failed = settled.find((entry): entry is PromiseRejectedResult => entry.status === "rejected");
  if (failed) throw failed.reason;
  const verdicts = settled.map((entry) => (entry as PromiseFulfilledResult<SourceVerdict>).value);
  const queried = verdicts.filter((verdict) => verdict.status === "queried").length;
  // Regroupement entre sources : APRÈS le stockage de toutes les sources (deux sources stockées en parallèle ne se voient pas l'une l'autre avant leur validation).
  if (queried > 0) {
    try {
      ctx.result.grouped += await groupWatchDuplicates(ctx.pool, watch);
    } catch (error) {
      // Interblocage : le regroupement est repris à la collecte suivante (rien n'est perdu). Toute autre erreur reste une erreur d'infrastructure.
      if (!isStoreConflict(error)) throw error;
      ctx.result.groupingConflicts += 1;
    }
  }
  return {
    queried,
    active: tasks.length,
    dayLimited: verdicts.filter((verdict) => verdict.status === "refused" && (verdict.reason === "quota" || verdict.reason === "budget")).length,
    transient: verdicts.filter((verdict) => verdict.status === "refused" && (verdict.reason === "interval" || verdict.reason === "busy")).length,
    aborted: verdicts.some((verdict) => verdict.status === "aborted"),
  };
}

/** Un cycle de collecte. Ne lève jamais. */
export async function runCollectStep(options: CollectStepOptions): Promise<CollectStepResult> {
  const result = emptyCollectResult();
  const pool = options.pool;
  const clock = options.now ?? (() => new Date());
  try {
    if (!(await externalSchemaPresent(pool))) {
      result.skipped = true;
      return result;
    }
    result.sync = await syncMarketWatches(pool, clock());
    const list = options.connectors === undefined ? resolveConnectors(process.env) : (options.connectors ?? []);
    if (list.length === 0) {
      result.noConnectors = true;
      return result;
    }
    const ctx: Context = {
      pool, clock, sleep: options.sleep ?? defaultSleep, analyze: options.analyze, signal: options.signal, timeoutMs: options.searchTimeoutMs ?? SEARCH_TIMEOUT_MS,
      pseudonymKey: options.pseudonymKey !== undefined ? options.pseudonymKey : readPseudonymKey(process.env),
      connectors: new Map(list.map((connector) => [connector.code, connector])), hooks: options.hooks ?? {}, result,
    };
    const claimed = await claimDueWatches(pool, clock(), { limit: options.maxWatches ?? STEP_MAX_WATCHES, only: options.only });
    result.claimed = claimed.length;
    if (claimed.length === 0) return result;
    await ctx.hooks.afterClaim?.(claimed.map((watch) => watch.id));
    const began = performance.now();
    const budgetMs = options.stepBudgetMs ?? STEP_TIME_BUDGET_MS;
    const pending = new Map(claimed.map((watch) => [watch.id, watch]));
    try {
      for (const watch of claimed) {
        if (options.signal?.aborted || performance.now() - began > budgetMs) break;
        // Une surveillance commencée n'est jamais rendue pour budget de temps : terminée, elle reçoit son échéance ; en panne d'infrastructure, elle garde son bail (nouvelle tentative
        // à son expiration, jamais en boucle).
        pending.delete(watch.id);
        // Bail revérifié (et prolongé) AVANT d'interroger les sources : un exécuteur figé plus de 10 minutes dont la surveillance a été reprise par un autre n'interroge rien.
        if (!(await renewLease(pool, watch, clock()))) {
          result.leaseLost += 1;
          continue;
        }
        const verdict = await collectWatch(ctx, watch);
        const now = clock();
        if (verdict.aborted) {
          // Arrêt demandé pendant une attente : la surveillance n'est pas close, elle redevient due tout de suite (si le bail est encore le nôtre).
          await releaseWatches(pool, [watch], now);
          result.released += 1;
          break;
        }
        // Clôture conditionnée au jeton du bail : si un autre exécuteur a repris la surveillance entre-temps, son échéance est conservée. La fréquence est RELUE juste avant (lot RA1) :
        // une recherche active achetée pendant la collecte accélère la surveillance, et la prochaine échéance doit en tenir compte.
        const frequency = (await readLeasedFrequency(pool, watch)) ?? watch.frequency_seconds;
        if (await finishWatch(pool, watch, now, planNextRun(now, frequency, verdict))) result.watchesProcessed += 1;
        else result.leaseLost += 1;
      }
    } finally {
      // Surveillances réservées mais pas commencées (temps écoulé, arrêt demandé, panne d'une précédente) : rendues tout de suite, sans quota ni budget consommés.
      if (pending.size > 0) {
        result.released += pending.size;
        await releaseWatches(pool, [...pending.values()], clock()).catch(() => undefined);
      }
    }
    if (result.watchesProcessed > 0) await purgeOld(pool, clock());
  } catch (error) {
    result.errors.push(collectErrorCode(error));
  }
  return result;
}

async function purgeOld(pool: Pool, now: Date): Promise<void> {
  const day = utcDay(now);
  await pool.query("DELETE FROM external_collect_runs WHERE started_at < $1::timestamptz - ($2::int * interval '1 day')", [now, RUNS_RETENTION_DAYS]);
  await pool.query("DELETE FROM external_source_usage WHERE day < $1::date - $2::int", [day, USAGE_RETENTION_DAYS]);
  await pool.query("DELETE FROM market_watch_usage WHERE day < $1::date - $2::int", [day, USAGE_RETENTION_DAYS]);
}
