import "server-only";

import { Pool, type PoolClient } from "pg";
import { BOOST_EXPIRY_OVERDUE_SECONDS } from "../boost/boost-config";
import { JOB_INTEGRITY_CONFLICT_CODE } from "./projection";
import { isMatchingSchemaReady } from "./schema-ready";

/** Au-delà de ce délai, l'événement pending le plus ancien déclenche `oldest_pending_too_old`. */
export const MATCHING_STATUS_PENDING_AGE_WARNING_SECONDS = 300;

/** Texte posé par la maintenance sur un job épuisé : le seul message de `last_error` qui n'est pas un code. */
const MAINTENANCE_EXHAUSTED_MESSAGE = "Tentatives maximales autorisées épuisées ou bail expiré.";

export type MatchingStatusWarningCode =
  | "schema_not_ready"
  | "dead_letter_present"
  | "integrity_quarantine_present"
  | "oldest_pending_too_old"
  | "job_lease_expired"
  | "active_evaluation_expired"
  | "boost_settings_missing"
  | "boost_pricing_missing"
  | "boost_expiry_overdue";

/** Textes fixes : jamais de donnée de la base. */
export const MATCHING_STATUS_WARNING_MESSAGES: Record<MatchingStatusWarningCode, string> = {
  schema_not_ready: "La migration 0010_matching_job_leases n'est pas enregistrée : appliquez les migrations (npm run db:migrate).",
  dead_letter_present: "Des jobs sont en dead_letter (abandonnés après épuisement des tentatives).",
  integrity_quarantine_present: "Des événements ont été mis en quarantaine (job_integrity_conflict).",
  oldest_pending_too_old: `Un événement attend la projection depuis plus de ${MATCHING_STATUS_PENDING_AGE_WARNING_SECONDS} s : le worker ne tourne probablement pas.`,
  job_lease_expired: "Des jobs running ont un bail expiré (worker mort ou bloqué).",
  active_evaluation_expired: "Des évaluations actives sont expirées : le balayeur temporel ne tourne pas.",
  boost_settings_missing: "Aucune ligne « default » dans boost_settings : le boost est inactif (le classement organique est servi) ; réinsérez les réglages par défaut.",
  boost_pricing_missing: "Aucune ligne « default » dans boost_pricing_settings : les cotations de boost sont impossibles (boost_pricing_missing) ; insérez une version de la configuration tarifaire par défaut.",
  boost_expiry_overdue: `Des boosts échus depuis plus de ${BOOST_EXPIRY_OVERDUE_SECONDS / 60} minutes sont encore actifs en base : le worker ne tourne probablement pas (ils n'ont aucun effet, mais ne sont pas marqués expirés).`,
};

export interface MatchingStatusWarning {
  code: MatchingStatusWarningCode;
  message: string;
}

export interface MatchingStatusReport {
  /** clock_timestamp() de la base, ISO 8601. */
  readAt: string;
  schemaReady: boolean;
  migrations: { count: number; latest: string | null };
  outbox: {
    pendingByType: Record<string, number>;
    /** Événements déjà projetés, par type (information : n'entre dans aucun avertissement). */
    projectedByType: Record<string, number>;
    oldestPending: { eventType: string; ageSeconds: number } | null;
    /** Événements ignored par code d'`error_message` (`none` si nul, `other` si ce n'est pas un code). */
    ignoredByCode: Record<string, number>;
  };
  jobs: {
    byTypeAndStatus: Array<{ jobType: string; status: string; count: number }>;
    runningWithExpiredLease: number;
    deadLetter: { count: number; byErrorCode: Record<string, number> };
    lastCompletedAt: string | null;
  };
  evaluations: { active: number; activeExpired: number };
  /** Boosts (migration 0011 enregistrée, sinon 0) : effectifs maintenant ; en retard d'expiration (actifs en base, échus depuis plus de 10 minutes). */
  boosts: { effective: number; overdue: number };
  warnings: MatchingStatusWarning[];
}

export interface ReadMatchingStatusOptions {
  pool: Pool;
  /** Réservé aux tests : appelé DANS la transaction READ ONLY (preuve qu'aucune écriture n'y est possible). */
  hooks?: { inSnapshot?: (client: PoolClient) => void | Promise<void> };
}

/** Un code stable ou `other` : jamais un message brut (il pourrait contenir un identifiant ou un texte métier). */
function safeCode(value: string | null, exhaustedAlias = false): string {
  if (value === null) return "none";
  if (exhaustedAlias && value === MAINTENANCE_EXHAUSTED_MESSAGE) return "attempts_or_lease_exhausted";
  return /^[a-z0-9_]{1,64}$/i.test(value) ? value : "other";
}

function addCount(target: Record<string, number>, key: string, count: number): void {
  target[key] = (target[key] ?? 0) + count;
}

function emptyReport(readAt: string, schemaReady: boolean): MatchingStatusReport {
  return {
    readAt,
    schemaReady,
    migrations: { count: 0, latest: null },
    outbox: { pendingByType: {}, projectedByType: {}, oldestPending: null, ignoredByCode: {} },
    jobs: { byTypeAndStatus: [], runningWithExpiredLease: 0, deadLetter: { count: 0, byErrorCode: {} }, lastCompletedAt: null },
    evaluations: { active: 0, activeExpired: 0 },
    boosts: { effective: 0, overdue: 0 },
    warnings: [],
  };
}

async function collect(client: PoolClient): Promise<MatchingStatusReport> {
  const now = await client.query<{ read_at: Date }>("SELECT clock_timestamp() AS read_at");
  const readAt = now.rows[0].read_at.toISOString();
  const schemaReady = await isMatchingSchemaReady(client);
  const report = emptyReport(readAt, schemaReady);
  if (!schemaReady) {
    report.warnings.push({ code: "schema_not_ready", message: MATCHING_STATUS_WARNING_MESSAGES.schema_not_ready });
    return report;
  }

  const migrations = await client.query<{ version: string }>("SELECT version FROM noma_schema_migrations ORDER BY version");
  report.migrations = { count: migrations.rows.length, latest: migrations.rows.at(-1)?.version ?? null };

  const pending = await client.query<{ event_type: string; n: number }>(
    `SELECT event_type, count(*)::int AS n FROM matching_outbox_events
      WHERE dispatch_status = 'pending' GROUP BY event_type ORDER BY event_type`);
  for (const row of pending.rows) addCount(report.outbox.pendingByType, row.event_type, row.n);

  const projected = await client.query<{ event_type: string; n: number }>(
    `SELECT event_type, count(*)::int AS n FROM matching_outbox_events
      WHERE dispatch_status = 'projected' GROUP BY event_type ORDER BY event_type`);
  for (const row of projected.rows) addCount(report.outbox.projectedByType, row.event_type, row.n);

  const oldest = await client.query<{ event_type: string; age: number }>(
    `SELECT event_type, greatest(0, floor(extract(epoch FROM clock_timestamp() - occurred_at)))::int AS age
       FROM matching_outbox_events WHERE dispatch_status = 'pending' ORDER BY occurred_at, id LIMIT 1`);
  if (oldest.rows[0]) report.outbox.oldestPending = { eventType: oldest.rows[0].event_type, ageSeconds: oldest.rows[0].age };

  const ignored = await client.query<{ error_message: string | null; n: number }>(
    `SELECT error_message, count(*)::int AS n FROM matching_outbox_events
      WHERE dispatch_status = 'ignored' GROUP BY error_message`);
  for (const row of ignored.rows) addCount(report.outbox.ignoredByCode, safeCode(row.error_message), row.n);

  const jobs = await client.query<{ job_type: string; status: string; n: number }>(
    `SELECT job_type, status, count(*)::int AS n FROM matching_jobs GROUP BY job_type, status ORDER BY job_type, status`);
  report.jobs.byTypeAndStatus = jobs.rows.map((row) => ({ jobType: row.job_type, status: row.status, count: row.n }));

  const expired = await client.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM matching_jobs WHERE status = 'running' AND lock_expires_at <= clock_timestamp()`);
  report.jobs.runningWithExpiredLease = expired.rows[0].n;

  const dead = await client.query<{ last_error: string | null; n: number }>(
    `SELECT last_error, count(*)::int AS n FROM matching_jobs WHERE status = 'dead_letter' GROUP BY last_error`);
  for (const row of dead.rows) {
    report.jobs.deadLetter.count += row.n;
    addCount(report.jobs.deadLetter.byErrorCode, safeCode(row.last_error, true), row.n);
  }

  const completed = await client.query<{ last: Date | null }>("SELECT max(completed_at) AS last FROM matching_jobs WHERE status = 'completed'");
  report.jobs.lastCompletedAt = completed.rows[0].last?.toISOString() ?? null;

  const evaluations = await client.query<{ active: number; expired: number }>(
    `SELECT count(*) FILTER (WHERE is_latest AND NOT is_stale)::int AS active,
            count(*) FILTER (WHERE is_latest AND NOT is_stale AND expires_at IS NOT NULL AND expires_at <= clock_timestamp())::int AS expired
       FROM matching_evaluations`);
  report.evaluations = { active: evaluations.rows[0].active, activeExpired: evaluations.rows[0].expired };

  const flag = (code: MatchingStatusWarningCode, raised: boolean) => {
    if (raised) report.warnings.push({ code, message: MATCHING_STATUS_WARNING_MESSAGES[code] });
  };
  flag("dead_letter_present", report.jobs.deadLetter.count > 0);
  flag("integrity_quarantine_present", (report.outbox.ignoredByCode[JOB_INTEGRITY_CONFLICT_CODE] ?? 0) > 0);
  flag("oldest_pending_too_old", (report.outbox.oldestPending?.ageSeconds ?? 0) > MATCHING_STATUS_PENDING_AGE_WARNING_SECONDS);
  flag("job_lease_expired", report.jobs.runningWithExpiredLease > 0);
  flag("active_evaluation_expired", report.evaluations.activeExpired > 0);
  // Réglages du boost : seulement si la migration 0011 est enregistrée (sinon la table n'existe pas encore).
  const boostMigration = await client.query("SELECT 1 FROM noma_schema_migrations WHERE version = '0011_offer_boosts'");
  if (boostMigration.rowCount === 1) {
    const defaults = await client.query<{ n: number }>("SELECT count(*)::int AS n FROM boost_settings WHERE key = 'default'");
    flag("boost_settings_missing", defaults.rows[0].n === 0);
    const boosts = await client.query<{ effective: number; overdue: number }>(
      `SELECT count(*) FILTER (WHERE status = 'active' AND starts_at <= clock_timestamp() AND clock_timestamp() < ends_at)::int AS effective,
              count(*) FILTER (WHERE status = 'active' AND ends_at < clock_timestamp() - make_interval(secs => $1::int))::int AS overdue
         FROM offer_boosts`,
      [BOOST_EXPIRY_OVERDUE_SECONDS],
    );
    report.boosts = { effective: boosts.rows[0].effective, overdue: boosts.rows[0].overdue };
    flag("boost_expiry_overdue", report.boosts.overdue > 0);
  }
  // Configuration tarifaire du boost : seulement si la migration 0012 est enregistrée.
  const pricingMigration = await client.query("SELECT 1 FROM noma_schema_migrations WHERE version = '0012_boost_pricing'");
  if (pricingMigration.rowCount === 1) {
    const pricingDefaults = await client.query<{ n: number }>("SELECT count(*)::int AS n FROM boost_pricing_settings WHERE key = 'default'");
    flag("boost_pricing_missing", pricingDefaults.rows[0].n === 0);
  }
  return report;
}

/**
 * État de santé du matching, STRICTEMENT en lecture seule : une transaction `REPEATABLE READ READ ONLY` sur une
 * connexion dédiée (toute écriture y échoue avec 25006). Ne rapporte que des compteurs, des types, des statuts et
 * des codes : jamais un message brut ni un identifiant.
 */
export async function readMatchingStatus(options: ReadMatchingStatusOptions): Promise<MatchingStatusReport> {
  if (!(options.pool instanceof Pool)) throw new TypeError("Un pool PostgreSQL (Pool) est requis pour matching:status.");
  const client = await options.pool.connect();
  let discard = false;
  try {
    await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    try {
      await options.hooks?.inSnapshot?.(client);
      const report = await collect(client);
      await client.query("COMMIT");
      return report;
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { discard = true; }
      throw error;
    }
  } finally {
    client.release(discard ? new Error("connection discarded") : undefined);
  }
}
