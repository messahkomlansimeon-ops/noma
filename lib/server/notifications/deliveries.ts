import "server-only";

import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { SqlExecutor } from "../postgres/client";
import { buildMatchingFreshnessPredicate, MATCHING_FRESHNESS_FROM, resolveMatchingFreshnessParams } from "../matching/persistence";
import {
  DELIVERY_MAX_AGE_MS,
  DELIVERY_MAX_ATTEMPTS,
  DELIVERY_RETRY_DELAYS_MS,
  EXTERNAL_DAILY_CAP_PER_USER,
  EXTERNAL_MIN_INTERVAL_MS,
  NOTIFICATION_USER_LOCK_NAMESPACE,
  NOTIFY_EXPIRY_BATCH,
  NOTIFY_ROWS_PER_USER,
  NOTIFY_USERS_PER_CYCLE,
  QUIET_HOURS_END_UTC,
  QUIET_HOURS_START_UTC,
  TRANSPORT_TIMEOUT_MS,
} from "./config";
import { EXTERNAL_MESSAGE_LINK } from "./content";
import type { NotificationTransport } from "./transport";

/**
 * Envoi hors de l'application (lot N1) : l'étape « notify » du runner lit l'outbox `notification_deliveries`, REVÉRIFIE tout au moment d'envoyer, regroupe
 * les envois en attente d'un même utilisateur en UN message, et n'envoie rien sans transport. Voir NOTIFICATIONS.md.
 *
 * Rythme par utilisateur (lot N1-bis) : un premier envoi en attente n'est envoyable qu'après la fenêtre de collecte (15 min, posée à la création : `next_attempt_at`),
 * au moins 4 h séparent deux messages, au plus 3 messages par jour UTC, jamais pendant les heures calmes. Ce qui ne peut pas partir est REPORTÉ (`next_attempt_at`),
 * jamais écarté pour cause de plafond ; seule l'attente de plus de 48 h sort du canal externe (`skipped`, `expired`). Un message emporte TOUT ce qui est en attente.
 *
 * Par utilisateur, DEUX temps courts sous le verrou consultatif de l'utilisateur (`pg_try_advisory_xact_lock` : jamais deux messages en même temps pour lui),
 * lignes prises en `FOR UPDATE SKIP LOCKED` (une ligne tenue par une autre transaction est laissée) :
 *  1. revérification, heures calmes, plafond, intervalle, puis FIGEAGE du lot (`batch_key` posée sur chaque ligne membre, COMMIT) ;
 *  2. nouvelle prise du verrou, revérification, appel au transport, marquage, COMMIT.
 * Le lot figé et sa clé d'idempotence survivent à toute panne : une nouvelle tentative envoie le MÊME lot avec la MÊME clé, même si d'autres lignes sont arrivées
 * entre-temps (elles partiront dans le message suivant). Une mort du processus avant le COMMIT du temps 2 laisse les lignes en attente ; entre l'appel au transport et ce
 * COMMIT le message peut être renvoyé : livraison « au moins une fois », avec la clé du lot pour qu'un vrai fournisseur dédoublonne.
 */

// ───────────── fonctions pures ─────────────

/** Heures calmes : de 22 h (inclus) à 7 h (exclu), UTC (Afrique/Abidjan = UTC). */
export function isQuietHour(now: Date): boolean {
  const hour = now.getUTCHours();
  return hour >= QUIET_HOURS_START_UTC || hour < QUIET_HOURS_END_UTC;
}

/** Prochain 7 h UTC (strictement après `now`) : la fin des heures calmes en cours. */
export function nextQuietEnd(now: Date): Date {
  const sameDay = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), QUIET_HOURS_END_UTC);
  const target = sameDay > now.getTime() ? sameDay : sameDay + 24 * 3_600_000;
  return new Date(target);
}

/** Premier instant d'envoi permis à partir de `at` : `at` lui-même, ou la fin des heures calmes si `at` y tombe. */
export function allowedSendTime(at: Date): Date {
  return isQuietHour(at) ? nextQuietEnd(at) : at;
}

/** Jour UTC de `now` : [début, fin[. */
export function utcDayBounds(now: Date): { start: Date; end: Date } {
  const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return { start: new Date(start), end: new Date(start + 24 * 3_600_000) };
}

/** Attente avant la tentative suivante, après `attempts` tentatives déjà échouées (1 : 5 min, 2 : 30 min). */
export function retryDelayMs(attempts: number): number {
  return DELIVERY_RETRY_DELAYS_MS[Math.min(Math.max(attempts, 1), DELIVERY_RETRY_DELAYS_MS.length) - 1];
}

/** Clé d'idempotence du message regroupé, calculée UNE fois quand le lot est figé (puis relue sur les lignes) : déterministe, 32 caractères hexadécimaux. */
export function batchKeyOf(deliveryIds: readonly string[]): string {
  return createHash("sha256").update([...deliveryIds].sort().join("|")).digest("hex").slice(0, 32);
}

// ───────────── annulation ─────────────

/** Les tables de ce lot existent-elles ? (une base pas encore migrée n'est jamais une erreur : rien à annuler, rien à envoyer). */
export async function notificationsSchemaPresent(executor: SqlExecutor): Promise<boolean> {
  const result = await executor.query<{ present: boolean }>("SELECT to_regclass('notification_deliveries') IS NOT NULL AS present");
  return result.rows[0]?.present === true;
}

/**
 * Annule les envois EN ATTENTE d'un besoin (satisfait ou archivé : « arrête tout »), sur l'exécuteur de la transaction qui change le statut : annulés
 * avec le changement, ou pas du tout. Renvoie le nombre de lignes annulées.
 */
export async function cancelPendingDeliveriesForDemand(executor: SqlExecutor, demandId: string, reason: string): Promise<number> {
  if (!(await notificationsSchemaPresent(executor))) return 0;
  const result = await executor.query(
    `UPDATE notification_deliveries
        SET status = 'cancelled', reason = $2, updated_at = clock_timestamp()
      WHERE demand_id = $1::uuid AND status = 'pending'`,
    [demandId, reason],
  );
  return result.rowCount ?? 0;
}

// ───────────── étape « notify » ─────────────

export interface NotifyHooks {
  /** Juste après la lecture des utilisateurs à traiter, avant le traitement du premier : la liste peut être périmée quand un autre processus passe entre-temps (essais de concurrence). */
  afterDue?: (userIds: readonly string[]) => void | Promise<void>;
  /** Après la prise (verrou consultatif et lignes), avant la revérification. Lever annule la transaction de l'utilisateur ; l'erreur est comptée comme une tentative de ses lignes. */
  afterLock?: (userId: string) => void | Promise<void>;
  /** Juste avant l'appel au transport. */
  beforeSend?: (userId: string, count: number) => void | Promise<void>;
  /** Juste après un envoi réussi, avant le marquage et le COMMIT (simule une mort du processus : le message est parti, rien n'est marqué). */
  afterSend?: (userId: string, count: number) => void | Promise<void>;
  /** Juste après le COMMIT du figeage du lot (clé et membres durables), avant le temps d'envoi. */
  afterFreeze?: (userId: string, batchKey: string) => void | Promise<void>;
}

export interface NotifyStepResult {
  /** Migration 0019 absente : étape ignorée sans erreur. */
  skipped: boolean;
  /** Aucun transport : aucun envoi externe (les envois restent en attente, puis expirent). */
  noTransport: boolean;
  /** Utilisateurs pris en charge. */
  users: number;
  /** Messages envoyés (chacun regroupe les envois en attente d'un utilisateur). */
  messages: number;
  /** Lignes marquées envoyées. */
  delivered: number;
  /** Lignes écartées à l'envoi (revérification, expiration). Jamais pour cause de plafond : le plafond reporte. */
  skippedDeliveries: number;
  /** Lignes reportées (heures calmes, intervalle de 4 h, plafond du jour). */
  deferred: number;
  /** Lignes passées à `failed` (3 tentatives). */
  failed: number;
  /** Lignes remises en attente après un échec. */
  retried: number;
  /** Lignes expirées sans envoi (48 h). */
  expired: number;
  /** Utilisateurs laissés (un autre processus les traite). */
  busy: number;
  /** Codes stables des erreurs d'utilisateurs (jamais de message), un par utilisateur en erreur : les tentatives de ses lignes sont comptées (voir `recordUserFailure`). */
  errors: string[];
}

export interface RunNotificationStepOptions {
  pool: Pool;
  /** Aucun transport (undefined ou null) : aucun envoi externe. */
  transport?: NotificationTransport | null;
  /** Horloge (réservée aux tests : heures calmes, plafond du jour, échéances). Défaut : l'heure du système. */
  now?: () => Date;
  userLimit?: number;
  hooks?: NotifyHooks;
}

class TransportTimeoutError extends Error {
  constructor() {
    super("transport_timeout");
    this.name = "TransportTimeoutError";
  }
}

function withTimeout<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TransportTimeoutError()), milliseconds);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error: unknown) => { clearTimeout(timer); reject(error); },
    );
  });
}

function errorCodeOf(error: unknown): string {
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" && /^[A-Za-z0-9_]{1,40}$/.test(code) ? code.toLowerCase() : "unknown";
}

type UserOutcome = Partial<Omit<NotifyStepResult, "skipped" | "noTransport" | "users" | "errors" | "expired">> & { busy?: number };

/** SQL de la revérification : une raison par ligne (null : l'envoi est valable). Ordre : préférence, compte, besoin, suivi, annonce, correspondance, expiration (48 h). */
function verdictQuery(): { text: string; values: unknown[] } {
  const freshness = buildMatchingFreshnessPredicate(resolveMatchingFreshnessParams(), 3);
  const text = `
    SELECT nd.id,
           CASE
             WHEN COALESCE(pref.external_enabled, FALSE) = FALSE THEN 'preference_disabled'
             WHEN usr.status IS DISTINCT FROM 'active' OR usr.archived_at IS NOT NULL THEN 'user_inactive'
             WHEN dem.id IS NULL OR dem.status <> 'active' OR dem.archived_at IS NOT NULL THEN 'demand_inactive'
             WHEN dem.notify_paused THEN 'tracking_paused'
             WHEN dem.notify_until <= $2::timestamptz THEN 'tracking_expired'
             WHEN ofr.id IS NULL OR ofr.status <> 'published' OR ofr.archived_at IS NOT NULL
                  OR ofr.availability_status IS NOT DISTINCT FROM 'unavailable' THEN 'offer_unavailable'
             WHEN NOT EXISTS (
               WITH current_clock AS (SELECT clock_timestamp() AS fresh_now)
               SELECT 1 FROM ${MATCHING_FRESHNESS_FROM}
                WHERE e.offer_id = nd.offer_id AND e.demand_id = nd.demand_id AND e.is_confirmed_match = TRUE
                  AND ${freshness.conditions.join(" AND ")}
             ) THEN 'no_longer_matching'
             WHEN nd.created_at < $2::timestamptz - ($${3 + freshness.values.length}::bigint * interval '1 millisecond') THEN 'expired'
             ELSE NULL
           END AS verdict
      FROM notification_deliveries nd
      LEFT JOIN users usr ON usr.id = nd.user_id
      LEFT JOIN notification_preferences pref ON pref.user_id = nd.user_id
      LEFT JOIN demands dem ON dem.id = nd.demand_id
      LEFT JOIN offers ofr ON ofr.id = nd.offer_id
     WHERE nd.id = ANY($1::uuid[])`;
  return { text, values: [...freshness.values, DELIVERY_MAX_AGE_MS] };
}


interface TakenRow {
  id: string;
  attempts: number;
  batch_key: string | null;
  next_attempt_at: Date;
}

interface PassResult {
  outcome: UserOutcome;
  /** Le lot vient d'être figé et validé : le temps d'envoi suit (une seule fois par appel). */
  send: boolean;
}

const ZERO_OUTCOME = (): UserOutcome => ({ skippedDeliveries: 0, deferred: 0, delivered: 0, messages: 0, failed: 0, retried: 0 });

function mergeOutcome(into: UserOutcome, from: UserOutcome): void {
  for (const key of ["skippedDeliveries", "deferred", "delivered", "messages", "failed", "retried", "busy"] as const) {
    if (from[key] !== undefined) into[key] = (into[key] ?? 0) + (from[key] ?? 0);
  }
}

/**
 * Une passe (une transaction) pour un utilisateur : prise du verrou et des lignes en attente, contrôle d'échéance, revérification, heures calmes, plafond du jour,
 * intervalle de 4 h ; puis, soit FIGEAGE du lot (aucun lot figé valable : `batch_key` posée sur toutes les lignes valables, COMMIT, `send: true`), soit ENVOI du lot
 * figé (appel au transport et marquage, COMMIT).
 */
async function processPass(
  client: PoolClient,
  transport: NotificationTransport,
  userId: string,
  clock: () => Date,
  hooks: NotifyHooks,
  first: boolean,
): Promise<PassResult> {
  await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
  await client.query("SET LOCAL lock_timeout = '3s'");
  await client.query("SET LOCAL statement_timeout = '10s'");

  // Un seul traitement à la fois par utilisateur : sans ce verrou, deux processus pourraient se partager les lignes d'un utilisateur et lui envoyer deux messages.
  const lock = await client.query<{ locked: boolean }>("SELECT pg_try_advisory_xact_lock($1, hashtext($2)) AS locked", [NOTIFICATION_USER_LOCK_NAMESPACE, userId]);
  if (lock.rows[0]?.locked !== true) {
    await client.query("ROLLBACK");
    return { outcome: { busy: 1 }, send: false };
  }

  const now = clock();
  // TOUT ce qui est en attente pour l'utilisateur (un message emporte tout), dans la limite de NOTIFY_ROWS_PER_USER ; le reste partira dans le message suivant.
  const taken = await client.query<TakenRow>(
    `SELECT id, attempts, batch_key, next_attempt_at FROM notification_deliveries
      WHERE user_id = $1::uuid AND status = 'pending'
      ORDER BY created_at, id
      LIMIT $2::int
        FOR UPDATE SKIP LOCKED`,
    [userId, NOTIFY_ROWS_PER_USER],
  );
  if (taken.rowCount === 0) {
    await client.query("COMMIT");
    return { outcome: {}, send: false };
  }
  if (first) await hooks.afterLock?.(userId);

  // Échéance : un lot figé attend SA prochaine tentative (attente croissante après un échec) ; sans lot figé, la première ligne arrivée à échéance (fenêtre de collecte).
  const frozenRows = taken.rows.filter((row) => row.batch_key !== null);
  const gate = frozenRows.length > 0 ? frozenRows : taken.rows;
  if (Math.min(...gate.map((row) => row.next_attempt_at.getTime())) > now.getTime()) {
    await client.query("COMMIT");
    return { outcome: {}, send: false };
  }

  const ids = taken.rows.map((row) => row.id);
  const rowById = new Map(taken.rows.map((row) => [row.id, row]));

  // 1. Revérification au moment d'envoyer : tout ce qui n'est plus valable est écarté AVEC son motif.
  const verdict = verdictQuery();
  const verdicts = await client.query<{ id: string; verdict: string | null }>(verdict.text, [ids, now, ...verdict.values]);
  const reasonById = new Map(verdicts.rows.map((row) => [row.id, row.verdict]));
  const skippedByReason = new Map<string, string[]>();
  const valid: string[] = [];
  for (const id of ids) {
    const reason = reasonById.has(id) ? reasonById.get(id) ?? null : "demand_inactive";
    if (reason === null) valid.push(id);
    else skippedByReason.set(reason, [...(skippedByReason.get(reason) ?? []), id]);
  }
  const outcome = ZERO_OUTCOME();
  for (const [reason, targets] of skippedByReason) {
    await client.query(
      `UPDATE notification_deliveries SET status = 'skipped', reason = $2, updated_at = $3::timestamptz WHERE id = ANY($1::uuid[]) AND status = 'pending'`,
      [targets, reason, now],
    );
    outcome.skippedDeliveries = (outcome.skippedDeliveries ?? 0) + targets.length;
  }
  if (valid.length === 0) {
    await client.query("COMMIT");
    return { outcome, send: false };
  }

  // 2. Report (jamais un écart) : heures calmes (22 h – 7 h UTC), plafond de messages du jour, intervalle minimal entre deux messages.
  let notBefore: Date | null = null;
  if (isQuietHour(now)) {
    notBefore = nextQuietEnd(now);
  } else {
    const day = utcDayBounds(now);
    const sentToday = await client.query<{ n: number }>(
      `SELECT count(DISTINCT batch_key)::int AS n FROM notification_deliveries
        WHERE user_id = $1::uuid AND status = 'sent' AND sent_at >= $2::timestamptz AND sent_at < $3::timestamptz`,
      [userId, day.start, day.end],
    );
    if (sentToday.rows[0].n >= EXTERNAL_DAILY_CAP_PER_USER) notBefore = day.end;
    const last = await client.query<{ sent_at: Date }>(
      `SELECT sent_at FROM notification_deliveries WHERE user_id = $1::uuid AND status = 'sent' ORDER BY sent_at DESC LIMIT 1`,
      [userId],
    );
    if (last.rows[0]) {
      const earliest = new Date(last.rows[0].sent_at.getTime() + EXTERNAL_MIN_INTERVAL_MS);
      if (earliest.getTime() > now.getTime() && (notBefore === null || earliest.getTime() > notBefore.getTime())) notBefore = earliest;
    }
    if (notBefore !== null) notBefore = allowedSendTime(notBefore);
  }
  if (notBefore !== null) {
    await client.query(
      `UPDATE notification_deliveries SET next_attempt_at = GREATEST(next_attempt_at, $2::timestamptz), updated_at = $3::timestamptz WHERE id = ANY($1::uuid[]) AND status = 'pending'`,
      [valid, notBefore, now],
    );
    outcome.deferred = valid.length;
    await client.query("COMMIT");
    return { outcome, send: false };
  }

  // 3. Le lot : celui qui est déjà figé (nouvelle tentative : même composition, même clé), sinon tout ce qui est valable, figé AVANT l'envoi.
  const frozenValid = valid.filter((id) => rowById.get(id)?.batch_key != null);
  if (frozenValid.length === 0) {
    const batchKey = batchKeyOf(valid);
    await client.query(`UPDATE notification_deliveries SET batch_key = $2, updated_at = $3::timestamptz WHERE id = ANY($1::uuid[]) AND status = 'pending'`, [valid, batchKey, now]);
    await client.query("COMMIT");
    await hooks.afterFreeze?.(userId, batchKey);
    return { outcome, send: true };
  }
  const batchKey = rowById.get(frozenValid[0])?.batch_key as string;
  const members = frozenValid.filter((id) => rowById.get(id)?.batch_key === batchKey);

  // 4. Envoi : UN message pour tout le lot (nombre d'annonces et lien vers /notifications, rien d'autre).
  await hooks.beforeSend?.(userId, members.length);
  let failure: string | null = null;
  try {
    await withTimeout(transport.send({ userId, count: members.length, link: EXTERNAL_MESSAGE_LINK, idempotencyKey: batchKey }), TRANSPORT_TIMEOUT_MS);
  } catch (error) {
    failure = error instanceof TransportTimeoutError ? "transport_timeout" : "transport_error";
  }
  if (failure === null) {
    await hooks.afterSend?.(userId, members.length);
    await client.query(
      `UPDATE notification_deliveries
          SET status = 'sent', attempts = attempts + 1, sent_at = $2::timestamptz, last_error = NULL, updated_at = $2::timestamptz
        WHERE id = ANY($1::uuid[]) AND status = 'pending'`,
      [members, now],
    );
    outcome.messages = 1;
    outcome.delivered = members.length;
  } else {
    // Échec : une tentative de plus pour les membres du lot ; trois tentatives au plus, attente croissante, puis `failed`. Le lot reste figé (même clé au prochain essai).
    const byAttempts = new Map<number, string[]>();
    for (const id of members) {
      const attempts = rowById.get(id)?.attempts ?? 0;
      byAttempts.set(attempts, [...(byAttempts.get(attempts) ?? []), id]);
    }
    for (const [attempts, targets] of byAttempts) {
      const next = attempts + 1;
      if (next >= DELIVERY_MAX_ATTEMPTS) {
        await client.query(
          `UPDATE notification_deliveries SET status = 'failed', attempts = $2::int, last_error = $3, updated_at = $4::timestamptz WHERE id = ANY($1::uuid[]) AND status = 'pending'`,
          [targets, next, failure, now],
        );
        outcome.failed = (outcome.failed ?? 0) + targets.length;
      } else {
        await client.query(
          `UPDATE notification_deliveries SET attempts = $2::int, last_error = $3, next_attempt_at = $4::timestamptz, updated_at = $5::timestamptz WHERE id = ANY($1::uuid[]) AND status = 'pending'`,
          [targets, next, failure, new Date(now.getTime() + retryDelayMs(next)), now],
        );
        outcome.retried = (outcome.retried ?? 0) + targets.length;
      }
    }
  }
  await client.query("COMMIT");
  return { outcome, send: false };
}

async function processUser(
  pool: Pool,
  transport: NotificationTransport,
  userId: string,
  clock: () => Date,
  hooks: NotifyHooks,
): Promise<UserOutcome> {
  const client: PoolClient = await pool.connect();
  let rollbackFailed = false;
  const total: UserOutcome = {};
  try {
    // Au plus deux passes : figer le lot (durable), puis l'envoyer. Un lot figé par un cycle précédent (nouvelle tentative) s'envoie dès la première passe.
    for (let pass = 0; pass < 2; pass += 1) {
      const result = await processPass(client, transport, userId, clock, hooks, pass === 0);
      mergeOutcome(total, result.outcome);
      if (!result.send) break;
    }
    return total;
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

/**
 * Une erreur de l'étape pour un utilisateur (jamais une erreur du transport : celle-ci est déjà comptée par le traitement lui-même) compte comme une TENTATIVE de ses
 * lignes arrivées à échéance : tentatives incrémentées, attente croissante (5 min, puis 30 min), `failed` après 3. L'utilisateur en erreur n'est donc relu qu'à
 * l'échéance suivante : ni boucle sans pause, ni ligne de journal par cycle. Au mieux : si cette écriture échoue à son tour, seul le code d'erreur est journalisé.
 */
async function recordUserFailure(pool: Pool, userId: string, code: string, now: Date): Promise<void> {
  try {
    await pool.query(
      `UPDATE notification_deliveries
          SET attempts = attempts + 1,
              status = CASE WHEN attempts + 1 >= $3::int THEN 'failed' ELSE status END,
              last_error = $4,
              next_attempt_at = CASE WHEN attempts + 1 >= $3::int THEN next_attempt_at
                                     ELSE $2::timestamptz + (CASE WHEN attempts + 1 = 1 THEN $5::bigint ELSE $6::bigint END * interval '1 millisecond') END,
              updated_at = $2::timestamptz
        WHERE user_id = $1::uuid AND status = 'pending' AND next_attempt_at <= $2::timestamptz`,
      [userId, now, DELIVERY_MAX_ATTEMPTS, `user_${code}`, retryDelayMs(1), retryDelayMs(2)],
    );
  } catch {
    // Rien de plus à faire : la base est probablement malade ; le cycle reste « au repos » et le code est journalisé par l'appelant.
  }
}

/** Envois expirés (en attente depuis plus de 48 h) : sortis du canal externe, jamais un message périmé (la notification reste dans l'application). Par lots, sans attendre une ligne tenue par un autre processus. */
async function expireStale(pool: Pool, now: Date): Promise<number> {
  const result = await pool.query(
    `UPDATE notification_deliveries
        SET status = 'skipped', reason = 'expired', updated_at = $1::timestamptz
      WHERE id IN (
        SELECT id FROM notification_deliveries
         WHERE status = 'pending' AND created_at < $1::timestamptz - ($2::bigint * interval '1 millisecond')
         ORDER BY created_at
         LIMIT $3::int
           FOR UPDATE SKIP LOCKED)`,
    [now, DELIVERY_MAX_AGE_MS, NOTIFY_EXPIRY_BATCH],
  );
  return result.rowCount ?? 0;
}

export async function runNotificationStep(options: RunNotificationStepOptions): Promise<NotifyStepResult> {
  const { pool } = options;
  const clock = options.now ?? (() => new Date());
  const hooks = options.hooks ?? {};
  const userLimit = options.userLimit ?? NOTIFY_USERS_PER_CYCLE;
  if (!Number.isSafeInteger(userLimit) || userLimit < 1 || userLimit > 200) throw new RangeError("userLimit doit être un entier entre 1 et 200.");
  const result: NotifyStepResult = {
    skipped: false, noTransport: false, users: 0, messages: 0, delivered: 0, skippedDeliveries: 0, deferred: 0, failed: 0, retried: 0, expired: 0, busy: 0, errors: [],
  };
  if (!(await notificationsSchemaPresent(pool))) return { ...result, skipped: true };

  result.expired = await expireStale(pool, clock());
  const transport = options.transport ?? undefined;
  if (!transport) return { ...result, noTransport: true };

  // Utilisateurs à traiter : un lot figé est relu à sa propre échéance (jamais celle de lignes plus récentes) ; sans lot figé, la première ligne arrivée à échéance.
  const due = await pool.query<{ user_id: string }>(
    `SELECT nd.user_id FROM notification_deliveries nd
      WHERE nd.status = 'pending' AND nd.next_attempt_at <= $1::timestamptz
        AND (nd.batch_key IS NOT NULL
             OR NOT EXISTS (SELECT 1 FROM notification_deliveries frozen WHERE frozen.user_id = nd.user_id AND frozen.status = 'pending' AND frozen.batch_key IS NOT NULL))
      GROUP BY nd.user_id
      ORDER BY min(nd.next_attempt_at), nd.user_id
      LIMIT $2::int`,
    [clock(), userLimit],
  );
  await hooks.afterDue?.(due.rows.map((row) => row.user_id));
  for (const { user_id: userId } of due.rows) {
    result.users += 1;
    try {
      const outcome = await processUser(pool, transport, userId, clock, hooks);
      result.messages += outcome.messages ?? 0;
      result.delivered += outcome.delivered ?? 0;
      result.skippedDeliveries += outcome.skippedDeliveries ?? 0;
      result.deferred += outcome.deferred ?? 0;
      result.failed += outcome.failed ?? 0;
      result.retried += outcome.retried ?? 0;
      result.busy += outcome.busy ?? 0;
    } catch (error) {
      // Cloisonné : l'échec d'un utilisateur n'empêche pas les suivants ; seul un code stable est conservé, et les lignes de l'utilisateur comptent une tentative.
      const code = errorCodeOf(error);
      result.errors.push(`user_${code}`);
      await recordUserFailure(pool, userId, code, clock());
    }
  }
  return result;
}
