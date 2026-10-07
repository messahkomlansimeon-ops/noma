import "server-only";

import type { Pool } from "pg";
import { requireTransactionPool } from "../catalog/validation";
import { DELIVERIES_RETENTION_DAYS, NOTIFICATIONS_READ_RETENTION_DAYS, NOTIFICATIONS_RETENTION_DAYS } from "./config";

/**
 * Rétention des notifications (lot N1) : `notifications` lues depuis plus de 90 jours OU créées depuis plus de 180 jours ; `notification_deliveries` créés
 * depuis plus de 180 jours. « Plus de » est strict : une ligne d'exactement 90 (ou 180) jours est gardée. Simulation par défaut. Frère de `metrics:purge`
 * (même garde d'environnement). Voir NOTIFICATIONS.md.
 */

export interface NotificationsPurgeCounts {
  notifications: number;
  notification_deliveries: number;
}

export interface NotificationsPurgeResult {
  apply: boolean;
  /** Instant de référence (ISO). */
  reference: string;
  /** Simulation : lignes qui seraient supprimées. Application : lignes supprimées. */
  counts: NotificationsPurgeCounts;
}

export const NOTIFICATIONS_PURGE_BATCH_SIZE = 5_000;

interface TableRule {
  table: keyof NotificationsPurgeCounts;
  /** Condition de suppression ; ses paramètres sont `$1`, `$2`, … dans l'ordre de `values` (aucun paramètre inutilisé : PostgreSQL le refuserait). */
  condition: string;
  values: (reference: Date) => unknown[];
}

const TABLES: readonly TableRule[] = [
  {
    table: "notifications",
    condition: `(read_at IS NOT NULL AND read_at < $1::timestamptz - ($2::int * interval '1 day')) OR created_at < $1::timestamptz - ($3::int * interval '1 day')`,
    values: (reference) => [reference, NOTIFICATIONS_READ_RETENTION_DAYS, NOTIFICATIONS_RETENTION_DAYS],
  },
  {
    table: "notification_deliveries",
    condition: `created_at < $1::timestamptz - ($2::int * interval '1 day')`,
    values: (reference) => [reference, DELIVERIES_RETENTION_DAYS],
  },
];

export async function purgeNotifications(input: { pool: Pool; apply: boolean; now?: Date }): Promise<NotificationsPurgeResult> {
  const pool = requireTransactionPool(input.pool);
  const reference = input.now ?? (await pool.query<{ now: Date }>("SELECT clock_timestamp() AS now")).rows[0].now;
  const counts: NotificationsPurgeCounts = { notifications: 0, notification_deliveries: 0 };
  for (const { table, condition, values } of TABLES) {
    const params = values(reference);
    if (!input.apply) {
      const found = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} WHERE ${condition}`, params);
      counts[table] = found.rows[0].n;
      continue;
    }
    for (;;) {
      const removed = await pool.query(
        `DELETE FROM ${table} WHERE ctid IN (SELECT ctid FROM ${table} WHERE ${condition} LIMIT $${params.length + 1}::int)`,
        [...params, NOTIFICATIONS_PURGE_BATCH_SIZE],
      );
      counts[table] += removed.rowCount ?? 0;
      if ((removed.rowCount ?? 0) < NOTIFICATIONS_PURGE_BATCH_SIZE) break;
    }
  }
  return { apply: input.apply, reference: reference.toISOString(), counts };
}
