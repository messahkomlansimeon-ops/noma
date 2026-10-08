import "server-only";

import type { SqlExecutor } from "../postgres/client";

/**
 * Instants de l'offre Pro. Toutes les écritures datées reçoivent un instant en TEXTE ISO UTC (microsecondes quand il vient de la base) que la requête relit avec `::timestamptz` :
 * un `Date` JavaScript perdrait les microsecondes et une période n'aurait plus exactement un mois. Sans horloge fournie, c'est l'horloge de la base (`clock_timestamp()`).
 * L'horloge injectable (`now`) sert aux essais et aux outils : elle ne change que les dates ÉCRITES et les échéances comparées, jamais les règles.
 */

const ISO_MICROS = "YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"";

/** L'instant courant : `now` si fourni (millisecondes), sinon l'horloge de la base (microsecondes). */
export async function currentInstant(executor: SqlExecutor, now?: Date): Promise<string> {
  if (now !== undefined) {
    if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new RangeError("now doit être une date valide.");
    return now.toISOString();
  }
  const result = await executor.query<{ at: string }>(`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', '${ISO_MICROS}') AS at`);
  return result.rows[0].at;
}

/** Un mois civil UTC après l'instant (période d'abonnement). */
export async function addOneMonth(executor: SqlExecutor, instant: string): Promise<string> {
  const result = await executor.query<{ at: string }>(
    `SELECT to_char(($1::timestamptz AT TIME ZONE 'UTC' + INTERVAL '1 month'), '${ISO_MICROS}') AS at`,
    [instant],
  );
  return result.rows[0].at;
}

/** Fin du délai de grâce : la fin de la période plus `hours` heures. */
export async function addHours(executor: SqlExecutor, instant: string, hours: number): Promise<string> {
  const result = await executor.query<{ at: string }>(
    `SELECT to_char(($1::timestamptz + make_interval(hours => $2::int)) AT TIME ZONE 'UTC', '${ISO_MICROS}') AS at`,
    [instant, hours],
  );
  return result.rows[0].at;
}

/** Début de la période de renouvellement : la fin de la précédente (périodes contiguës) ; si cette période serait déjà ENTIÈREMENT passée (worker arrêté plus d'un mois), maintenant. */
export async function renewalStart(executor: SqlExecutor, previousEnd: string, now: string): Promise<string> {
  const result = await executor.query<{ at: string }>(
    `SELECT to_char((CASE WHEN ($1::timestamptz AT TIME ZONE 'UTC' + INTERVAL '1 month') AT TIME ZONE 'UTC' <= $2::timestamptz THEN $2::timestamptz ELSE $1::timestamptz END) AT TIME ZONE 'UTC', '${ISO_MICROS}') AS at`,
    [previousEnd, now],
  );
  return result.rows[0].at;
}

/** Un instant lu en texte (même format) : à relire avec `::timestamptz`. */
export const INSTANT_TEXT_SQL = (column: string): string => `to_char(${column} AT TIME ZONE 'UTC', '${ISO_MICROS}')`;
