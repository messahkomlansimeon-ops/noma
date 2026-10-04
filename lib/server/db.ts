/**
 * SQLite persistant (node:sqlite) pour quotas, réservations de budget et
 * dépenses — Lot 4. Montants en MICRODOLLARS (entiers) ; toutes les
 * opérations sont synchrones (DatabaseSync) donc atomiques au sein du
 * processus ; les séquences multi-opérations sont encadrées par
 * BEGIN IMMEDIATE / COMMIT pour être atomicité complète.
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface GuardDb {
  db: DatabaseSync;
  close(): void;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS reservations (
  search_id    TEXT PRIMARY KEY,
  amount_micros INTEGER NOT NULL,
  day          TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  resolved_at  TEXT,
  spent_micros INTEGER
);
CREATE TABLE IF NOT EXISTS ledger (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  search_id     TEXT,
  kind          TEXT NOT NULL,
  amount_micros INTEGER NOT NULL,
  day           TEXT NOT NULL,
  ts            TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS attempts (
  scope      TEXT NOT NULL,
  window_key TEXT NOT NULL,
  count      INTEGER NOT NULL,
  PRIMARY KEY (scope, window_key)
);
CREATE TABLE IF NOT EXISTS active_searches (
  session_id TEXT PRIMARY KEY,
  search_id  TEXT NOT NULL,
  ip_hash    TEXT NOT NULL,
  started_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ledger_day ON ledger (day);
CREATE INDEX IF NOT EXISTS idx_reservations_day ON reservations (day, resolved_at);
`;

export function openGuardDb(path: string): GuardDb {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = FULL");
  db.exec(SCHEMA);
  return { db, close: () => db.close() };
}

export type GuardDatabase = DatabaseSync;

/** Clé du jour pour le budget quotidien, selon le fuseau configuré
 *  (Africa/Abidjan par défaut). */
export function dayKey(now: Date, timezone = "Africa/Abidjan"): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/** Transaction synchrone : BEGIN IMMEDIATE → fn → COMMIT, ROLLBACK en cas
 *  d'exception (relancée). */
export function withTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}