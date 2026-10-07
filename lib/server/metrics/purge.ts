import "server-only";

import type { Pool } from "pg";
import { requireTransactionPool } from "../catalog/validation";
import { METRICS_RETENTION_DAYS, PURGE_PRODUCTION_VARIABLE } from "./config";

/**
 * Rétention des mesures (lot M1) : `boost_exposures`, `offer_views` et `offer_contacts` ne sont conservés que `METRICS_RETENTION_DAYS` jours. Une ligne
 * est supprimée quand son JOUR UTC (jour servi, jour d'ouverture, jour du DERNIER contact) précède `aujourd'hui − 400 jours` : une ligne vieille de
 * 400 jours pile est gardée, celle de 401 jours est supprimée. Les statistiques agrégées ne sont PAS conservées au-delà (elles se recalculent depuis ces
 * lignes). Simulation par défaut. Voir MESURES.md. (La garde d'environnement est partagée avec `notifications:purge`, lot N1, avec sa propre variable de production.)
 */

export interface PurgeTableCounts {
  boost_exposures: number;
  offer_views: number;
  offer_contacts: number;
}

export interface PurgeResult {
  apply: boolean;
  /** Premier jour UTC conservé (les lignes d'un jour STRICTEMENT antérieur sont concernées). */
  cutoffDay: string;
  /** Simulation : lignes qui seraient supprimées. Application : lignes supprimées. */
  counts: PurgeTableCounts;
}

/** Lignes supprimées par instruction : jamais un verrou long sur un journal volumineux. */
export const PURGE_BATCH_SIZE = 5_000;

const TABLES: ReadonlyArray<{ table: keyof PurgeTableCounts; dayExpression: string }> = [
  { table: "boost_exposures", dayExpression: "served_day" },
  { table: "offer_views", dayExpression: "viewed_day" },
  { table: "offer_contacts", dayExpression: "(last_contact_at AT TIME ZONE 'UTC')::date" },
];

/**
 * Refus de lancer la purge (même la simulation : on ne touche pas à une base inconnue par défaut). Elle ne s'exécute que si `NODE_ENV` est ABSENT,
 * `development` ou `test`, casse exacte. Toute autre valeur (`Production`, `PRODUCTION`, `prod`, `staging`, vide…) est refusée ; `production` n'est permis que
 * avec `NOMA_METRICS_PURGE_PRODUCTION=1`. Renvoie le texte du refus (sans jamais répéter la valeur reçue), ou null si la purge est permise.
 */
export function purgeEnvironmentRefusal(
  env: Record<string, string | undefined>,
  productionVariable: string = PURGE_PRODUCTION_VARIABLE,
): string | null {
  const nodeEnv = env.NODE_ENV;
  if (nodeEnv === undefined || nodeEnv === "development" || nodeEnv === "test") return null;
  if (nodeEnv === "production") {
    return env[productionVariable] === "1"
      ? null
      : `refus en production : définissez ${productionVariable}=1 pour confirmer explicitement (rien n'a été lu ni supprimé).`;
  }
  return "refus : NODE_ENV doit être absent, « development » ou « test » (casse exacte ; toute autre valeur est refusée, la production exige " +
    `${productionVariable}=1 avec NODE_ENV=production) ; rien n'a été lu ni supprimé.`;
}

/**
 * Simule (`apply` faux, lecture seule) ou applique (`apply` vrai) la purge. `now` (réservé aux tests) fixe l'instant de référence ; sinon l'horloge de
 * la base. L'application supprime par lots (`PURGE_BATCH_SIZE`) jusqu'à épuisement, une table après l'autre.
 */
export async function purgeMetrics(input: { pool: Pool; apply: boolean; now?: Date; retentionDays?: number }): Promise<PurgeResult> {
  const pool = requireTransactionPool(input.pool);
  const retentionDays = input.retentionDays ?? METRICS_RETENTION_DAYS;
  if (!Number.isSafeInteger(retentionDays) || retentionDays < 1) throw new RangeError("retentionDays doit être un entier strictement positif.");
  const reference = input.now ?? null;
  const cutoff = await pool.query<{ cutoff: string }>(
    "SELECT (((COALESCE($1::timestamptz, clock_timestamp())) AT TIME ZONE 'UTC')::date - $2::int)::text AS cutoff",
    [reference, retentionDays],
  );
  const cutoffDay = cutoff.rows[0].cutoff;
  const counts: PurgeTableCounts = { boost_exposures: 0, offer_views: 0, offer_contacts: 0 };
  for (const { table, dayExpression } of TABLES) {
    if (!input.apply) {
      const found = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} WHERE ${dayExpression} < $1::date`, [cutoffDay]);
      counts[table] = found.rows[0].n;
      continue;
    }
    for (;;) {
      const removed = await pool.query(
        `DELETE FROM ${table} WHERE ctid IN (SELECT ctid FROM ${table} WHERE ${dayExpression} < $1::date LIMIT $2::int)`,
        [cutoffDay, PURGE_BATCH_SIZE],
      );
      counts[table] += removed.rowCount ?? 0;
      if ((removed.rowCount ?? 0) < PURGE_BATCH_SIZE) break;
    }
  }
  return { apply: input.apply, cutoffDay, counts };
}
