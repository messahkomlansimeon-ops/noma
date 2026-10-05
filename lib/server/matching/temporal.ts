import "server-only";

import { Pool } from "pg";
import { recordOutboxEvent } from "./outbox";

const DEFAULT_TEMPORAL_LIMIT = 100;
const MAX_TEMPORAL_LIMIT = 500;

export class MatchingTemporalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MatchingTemporalError";
  }
}

export interface ExpiredEvaluation {
  id: string;
  offerId: string;
  offerContentVersion: number;
  demandId: string;
  demandContentVersion: number;
}

/** Hooks réservés aux tests (concurrence, pannes). */
export interface TemporalExpirySweepHooks {
  /** Après la sélection verrouillée, avant toute écriture. */
  afterSelect?: (rows: readonly ExpiredEvaluation[]) => void | Promise<void>;
  /** Après la péremption de la ligne, avant l'enregistrement de son événement. */
  beforeRecord?: (row: ExpiredEvaluation) => void | Promise<void>;
}

export interface RunTemporalExpirySweepOptions {
  pool: Pool;
  limit?: number;
  hooks?: TemporalExpirySweepHooks;
}

interface ExpiredRow {
  id: string;
  offer_id: string;
  offer_content_version: number;
  demand_id: string;
  demand_content_version: number;
}

/**
 * Balayeur temporel (plan §8, corrigé en 2E4C2) : périme les évaluations actives dont `expires_at` est dépassé et
 * enregistre, dans la MÊME transaction, un événement `temporal.deadline_passed` par ligne périmée. Toute erreur annule
 * le lot entier : jamais de ligne périmée sans son événement, ni d'événement sans ligne périmée.
 *
 * L'événement est enregistré par `recordOutboxEvent` avec `aggregateType: 'temporal'` (et non 'offer' comme l'écrivait
 * le plan) : l'index unique de 0009 sur (aggregate_type, aggregate_id, aggregate_version) et le contrôle de préfixe
 * de `recordOutboxEvent` l'interdisent.
 */
export async function runTemporalExpirySweep(options: RunTemporalExpirySweepOptions): Promise<{ expired: number }> {
  const { pool, hooks } = options;
  const limit = options.limit === undefined ? DEFAULT_TEMPORAL_LIMIT : options.limit;
  if (!(pool instanceof Pool)) {
    throw new MatchingTemporalError("Un pool PostgreSQL (Pool) est requis pour le balayage temporel.");
  }
  if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_TEMPORAL_LIMIT) {
    throw new MatchingTemporalError(`limit doit être un entier entre 1 et ${MAX_TEMPORAL_LIMIT}.`);
  }

  const client = await pool.connect();
  let rollbackFailed = false;
  try {
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    await client.query("SET LOCAL lock_timeout = '3s'");
    await client.query("SET LOCAL statement_timeout = '5s'");

    const selection = await client.query<ExpiredRow>(
      `SELECT id, offer_id, offer_content_version, demand_id, demand_content_version
         FROM matching_evaluations
        WHERE is_latest = TRUE
          AND is_stale = FALSE
          AND expires_at IS NOT NULL
          AND expires_at <= clock_timestamp()
        ORDER BY expires_at ASC, id ASC
        LIMIT $1
          FOR UPDATE SKIP LOCKED`,
      [limit],
    );
    const rows: ExpiredEvaluation[] = selection.rows.map((row) => ({
      id: row.id,
      offerId: row.offer_id,
      offerContentVersion: row.offer_content_version,
      demandId: row.demand_id,
      demandContentVersion: row.demand_content_version,
    }));
    await hooks?.afterSelect?.(rows);

    for (const row of rows) {
      // Seule la ligne sélectionnée (et verrouillée) est périmée : une évaluation fraîche de la même paire, avec un
      // autre id, n'est jamais touchée.
      const updated = await client.query(
        `UPDATE matching_evaluations
            SET is_stale = TRUE,
                is_latest = FALSE,
                stale_reason = 'temporal_expiry',
                staled_at = clock_timestamp()
          WHERE id = $1`,
        [row.id],
      );
      if (updated.rowCount !== 1) {
        throw new MatchingTemporalError("Péremption d'une évaluation impossible : lot annulé.");
      }
      await hooks?.beforeRecord?.(row);
      await recordOutboxEvent(client, {
        eventType: "temporal.deadline_passed",
        aggregateType: "temporal",
        aggregateId: row.offerId,
        aggregateVersion: row.offerContentVersion,
        targetAggregateId: row.demandId,
        payload: {
          demandId: row.demandId,
          demandContentVersion: row.demandContentVersion,
          expiredEvaluationId: row.id,
        },
      });
    }
    await client.query("COMMIT");
    return { expired: rows.length };
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
