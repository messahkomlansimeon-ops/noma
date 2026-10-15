import "server-only";

import type { Pool } from "pg";
import { requireTransactionPool } from "../catalog/validation";
import { SMS_SENDS_RETENTION_DAYS } from "./config";

/**
 * Rétention du journal `sms_sends` : envois créés depuis plus de 62 jours, sauf `uncertain` et `pending` (jamais purgés : ils servent au rapprochement de l'administration).
 * « Plus de » est strict : une ligne d'exactement 62 jours est gardée. Simulation par défaut, suppression par lots. Frère de `notifications:purge` (même garde d'environnement).
 * Voir SMS.md.
 */

export const SMS_PURGE_BATCH_SIZE = 5_000;

export interface SmsPurgeResult {
  apply: boolean;
  /** Instant de référence (ISO). */
  reference: string;
  /** Simulation : lignes qui seraient supprimées. Application : lignes supprimées. */
  sms_sends: number;
}

const CONDITION = `created_at < $1::timestamptz - ($2::int * interval '1 day') AND status NOT IN ('uncertain', 'pending')`;

export async function purgeSmsSends(input: { pool: Pool; apply: boolean; now?: Date }): Promise<SmsPurgeResult> {
  const pool = requireTransactionPool(input.pool);
  const reference = input.now ?? (await pool.query<{ now: Date }>("SELECT clock_timestamp() AS now")).rows[0].now;
  const params = [reference, SMS_SENDS_RETENTION_DAYS];
  if (!input.apply) {
    const found = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM sms_sends WHERE ${CONDITION}`, params);
    return { apply: false, reference: reference.toISOString(), sms_sends: found.rows[0].n };
  }
  let total = 0;
  for (;;) {
    const removed = await pool.query(
      `DELETE FROM sms_sends WHERE ctid IN (SELECT ctid FROM sms_sends WHERE ${CONDITION} LIMIT $3::int)`,
      [...params, SMS_PURGE_BATCH_SIZE],
    );
    total += removed.rowCount ?? 0;
    if ((removed.rowCount ?? 0) < SMS_PURGE_BATCH_SIZE) break;
  }
  return { apply: true, reference: reference.toISOString(), sms_sends: total };
}
