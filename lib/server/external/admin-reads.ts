import "server-only";

import type { Pool } from "pg";
import { ADMIN_RECENT_ERRORS, BREAKER_FAILURE_THRESHOLD } from "./config";
import { externalSchemaPresent } from "./registry";
import type { SourceRow } from "./types";

/**
 * Lecture pour l'administration de la collecte externe (lot EXT1) : sources (état, disjoncteur, quota consommé), surveillances (nombre, dues, en pause), annonces, dernières erreurs.
 * Lecture seule : aucun bouton d'activation d'une source réelle, aucune écriture. Les erreurs sont des CODES stables, jamais un message d'une source.
 */

export type BreakerState = "disabled" | "closed" | "open" | "half_open";

export interface AdminCollectionSource {
  code: string;
  name: string;
  type: string;
  enabled: boolean;
  state: BreakerState;
  consecutiveFailures: number;
  breakerOpenUntil: Date | null;
  usedToday: number;
  dailyQuota: number;
  minIntervalMs: number;
  lastSuccessAt: Date | null;
  lastFailureAt: Date | null;
  lastErrorCode: string | null;
}

export interface AdminCollectionError {
  at: Date;
  sourceCode: string;
  sourceName: string;
  code: string;
}

export interface AdminCollection {
  schemaReady: boolean;
  sources: AdminCollectionSource[];
  watches: { total: number; active: number; paused: number; due: number };
  listings: { available: number; gone: number; unknown: number; groups: number };
  errors: AdminCollectionError[];
  readAt: Date;
}

/** État du disjoncteur : ouvert pendant la pause, « semi-ouvert » une fois la pause écoulée tant que le prochain essai n'a pas réussi. */
export function breakerStateOf(source: Pick<SourceRow, "enabled" | "consecutive_failures" | "breaker_open_until">, now: Date): BreakerState {
  if (!source.enabled) return "disabled";
  if (source.breaker_open_until !== null && source.breaker_open_until.getTime() > now.getTime()) return "open";
  return source.consecutive_failures >= BREAKER_FAILURE_THRESHOLD ? "half_open" : "closed";
}

const count = (value: string | number | null | undefined): number => {
  const parsed = Number(value ?? 0);
  return Number.isSafeInteger(parsed) ? parsed : 0;
};

export async function readAdminCollection(input: { pool: Pool; now?: Date }): Promise<AdminCollection> {
  const now = input.now ?? new Date();
  const empty: AdminCollection = {
    schemaReady: false, sources: [], watches: { total: 0, active: 0, paused: 0, due: 0 }, listings: { available: 0, gone: 0, unknown: 0, groups: 0 }, errors: [], readAt: now,
  };
  if (!(await externalSchemaPresent(input.pool))) return empty;
  const day = now.toISOString().slice(0, 10);
  const sources = await input.pool.query<SourceRow & { used_today: number }>(
    `SELECT s.code, s.name, s.type, s.enabled, s.daily_quota, s.min_interval_ms, s.consecutive_failures, s.breaker_open_until, s.last_request_at, s.last_success_at, s.last_failure_at,
            s.last_error_code, COALESCE(u.requests, 0) AS used_today
       FROM external_sources s LEFT JOIN external_source_usage u ON u.source_code = s.code AND u.day = $1::date
      ORDER BY s.code`,
    [day],
  );
  const watches = await input.pool.query<Record<string, string>>(
    `SELECT count(*) AS total, count(*) FILTER (WHERE status = 'active') AS active, count(*) FILTER (WHERE status = 'paused') AS paused,
            count(*) FILTER (WHERE status = 'active' AND next_run_at <= $1::timestamptz) AS due
       FROM market_watches`,
    [now],
  );
  const listings = await input.pool.query<Record<string, string>>(
    `SELECT count(*) FILTER (WHERE availability_status = 'available') AS available, count(*) FILTER (WHERE availability_status = 'gone') AS gone,
            count(*) FILTER (WHERE availability_status = 'unknown') AS unknown, (SELECT count(*) FROM duplicate_groups) AS groups
       FROM external_listings`,
  );
  const errors = await input.pool.query<{ started_at: Date; source_code: string; name: string; error_code: string }>(
    `SELECT r.started_at, r.source_code, s.name, r.error_code
       FROM external_collect_runs r JOIN external_sources s ON s.code = r.source_code
      WHERE r.status = 'error' ORDER BY r.started_at DESC, r.id DESC LIMIT $1::int`,
    [ADMIN_RECENT_ERRORS],
  );
  const w = watches.rows[0] ?? {};
  const l = listings.rows[0] ?? {};
  return {
    schemaReady: true,
    sources: sources.rows.map((row) => ({
      code: row.code,
      name: row.name,
      type: row.type,
      enabled: row.enabled,
      state: breakerStateOf(row, now),
      consecutiveFailures: row.consecutive_failures,
      breakerOpenUntil: row.breaker_open_until,
      usedToday: count(row.used_today),
      dailyQuota: row.daily_quota,
      minIntervalMs: row.min_interval_ms,
      lastSuccessAt: row.last_success_at,
      lastFailureAt: row.last_failure_at,
      lastErrorCode: row.last_error_code,
    })),
    watches: { total: count(w.total), active: count(w.active), paused: count(w.paused), due: count(w.due) },
    listings: { available: count(l.available), gone: count(l.gone), unknown: count(l.unknown), groups: count(l.groups) },
    errors: errors.rows.map((row) => ({ at: row.started_at, sourceCode: row.source_code, sourceName: row.name, code: row.error_code })),
    readAt: now,
  };
}
