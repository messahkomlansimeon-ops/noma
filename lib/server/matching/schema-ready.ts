import type { SqlExecutor } from "../postgres/client";

/** Dernière migration requise par le matching asynchrone (baux de jobs). */
export const MATCHING_REQUIRED_MIGRATION = "0010_matching_job_leases";

/**
 * Le schéma est prêt si la migration 0010 est enregistrée dans `noma_schema_migrations`. N'applique JAMAIS de
 * migration. Une table de migrations absente donne `false` (pas d'erreur SQL : utilisable dans une transaction
 * sans l'avorter). Partagé par le bootstrap, matching:status et dev:full ; module volontairement sans `server-only`
 * pour que dev:full (qui ne charge aucun module serveur) puisse l'importer.
 */
export async function isMatchingSchemaReady(executor: SqlExecutor): Promise<boolean> {
  const table = await executor.query<{ present: boolean }>(
    "SELECT to_regclass('noma_schema_migrations') IS NOT NULL AS present");
  if (table.rows[0]?.present !== true) return false;
  const result = await executor.query("SELECT 1 FROM noma_schema_migrations WHERE version = $1", [MATCHING_REQUIRED_MIGRATION]);
  return result.rowCount === 1;
}
