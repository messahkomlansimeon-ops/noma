import "server-only";

import type { SqlExecutor } from "../postgres/client";
import { ALLOWED_SOURCE_TYPE, FAKE_CONNECTORS_ENV } from "./config";
import { createFakeConnectors } from "./fake-connectors";
import type { SourceConnector, SourceRow } from "./types";

/**
 * Registre des sources et des connecteurs (lot EXT1).
 *
 * AUCUN connecteur réel n'existe, et aucune source non fictive ne peut être enregistrée ni activée : `assertAllowedSourceType` refuse tout type autre que « fake », la contrainte
 * CHECK de `external_sources.type` aussi, et le type TypeScript `SourceConnector.kind` ne vaut que « fake ». Un futur lot qui voudra une vraie source devra élargir ces trois garde-fous
 * avec une liste blanche validée (droit, conditions d'utilisation, robots.txt, quotas, consentement) : voir COLLECTE-EXTERNE.md.
 */

export class SourceNotAllowedError extends Error {
  readonly code = "source_not_allowed" as const;
  constructor(type: string) {
    super(`Une source de type « ${type} » n'est pas autorisée : seules les sources fictives existent (aucune collecte réelle avant validation par le fondateur).`);
    this.name = "SourceNotAllowedError";
  }
}

/** Refuse tout type de source autre que « fake ». */
export function assertAllowedSourceType(type: unknown): asserts type is typeof ALLOWED_SOURCE_TYPE {
  if (type !== ALLOWED_SOURCE_TYPE) throw new SourceNotAllowedError(typeof type === "string" ? type.slice(0, 40) : String(type));
}

const SCHEMA_TABLES = [
  "external_sources", "market_watches", "external_source_usage", "market_watch_usage", "external_collect_runs",
  "external_analyses", "duplicate_groups", "external_listings", "source_observations",
] as const;

/** Les tables de la migration 0025 existent-elles ? Une base pas encore migrée n'est jamais une erreur : l'étape est ignorée. */
export async function externalSchemaPresent(executor: SqlExecutor): Promise<boolean> {
  const checks = SCHEMA_TABLES.map((table) => `to_regclass('${table}') IS NOT NULL`).join(" AND ");
  const result = await executor.query<{ present: boolean }>(`SELECT (${checks}) AS present`);
  return result.rows[0]?.present === true;
}

export const SOURCE_COLUMNS = `code, name, type, enabled, daily_quota, min_interval_ms, consecutive_failures, breaker_open_until, breaker_trial_until, last_request_at, last_success_at, last_failure_at, last_error_code`;

export async function listSources(executor: SqlExecutor): Promise<SourceRow[]> {
  const result = await executor.query<SourceRow>(`SELECT ${SOURCE_COLUMNS} FROM external_sources ORDER BY code`);
  return result.rows;
}

export interface RegisterSourceInput {
  code: string;
  name: string;
  type: string;
  enabled?: boolean;
  dailyQuota?: number;
  minIntervalMs?: number;
}

/** Enregistre (ou met à jour) une source. Refus de tout type autre que « fake » AVANT la base. */
export async function registerSource(pool: SqlExecutor, input: RegisterSourceInput): Promise<void> {
  assertAllowedSourceType(input.type);
  await pool.query(
    `INSERT INTO external_sources (code, name, type, enabled, daily_quota, min_interval_ms)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, enabled = EXCLUDED.enabled, daily_quota = EXCLUDED.daily_quota, min_interval_ms = EXCLUDED.min_interval_ms, updated_at = clock_timestamp()`,
    [input.code, input.name, input.type, input.enabled ?? false, input.dailyQuota ?? 200, input.minIntervalMs ?? 250],
  );
}

/** Active ou désactive une source existante. Activer exige un type autorisé (« fake ») : une source d'un autre type ne s'active jamais. */
export async function setSourceEnabled(pool: SqlExecutor, code: string, enabled: boolean): Promise<boolean> {
  const found = await pool.query<{ type: string }>("SELECT type FROM external_sources WHERE code = $1", [code]);
  const row = found.rows[0];
  if (!row) return false;
  if (enabled) assertAllowedSourceType(row.type);
  const updated = await pool.query("UPDATE external_sources SET enabled = $2, updated_at = clock_timestamp() WHERE code = $1", [code, enabled]);
  return (updated.rowCount ?? 0) > 0;
}

/**
 * Connecteurs disponibles pour le worker : AUCUN en production, AUCUN sans `NOMA_EXTERNAL_FAKE=1`, sinon les deux connecteurs fictifs. L'environnement ne peut jamais
 * apporter un connecteur réel : il n'en existe pas.
 */
export function resolveConnectors(env: Record<string, string | undefined> = process.env): SourceConnector[] {
  if (env.NODE_ENV === "production") return [];
  if (env[FAKE_CONNECTORS_ENV] !== "1") return [];
  return createFakeConnectors();
}

/** Relie une source enregistrée à son connecteur : jamais pour un type non autorisé ni pour un connecteur d'un autre type. */
export function connectorFor(source: SourceRow, connectors: ReadonlyMap<string, SourceConnector>): SourceConnector | null {
  if (source.type !== ALLOWED_SOURCE_TYPE) return null;
  const connector = connectors.get(source.code);
  if (!connector || connector.kind !== ALLOWED_SOURCE_TYPE) return null;
  return connector;
}
