import "server-only";

import type { Pool } from "pg";
import { requireTransactionPool, requireUuid } from "../catalog/validation";

/**
 * Préférences de notification (lot N1) : un seul réglage, l'envoi externe SIMULÉ (désactivé par défaut, opt-in). Sans ligne, tout est désactivé. Voir NOTIFICATIONS.md.
 */

export interface NotificationPreferences {
  externalEnabled: boolean;
}

export async function readNotificationPreferences(input: { pool: Pool; userId: string }): Promise<NotificationPreferences> {
  const pool = requireTransactionPool(input.pool);
  const result = await pool.query<{ external_enabled: boolean }>(
    "SELECT external_enabled FROM notification_preferences WHERE user_id = $1::uuid",
    [requireUuid(input.userId, "userId").toLowerCase()],
  );
  return { externalEnabled: result.rows[0]?.external_enabled === true };
}

export async function writeNotificationPreferences(input: { pool: Pool; userId: string; externalEnabled: boolean }): Promise<NotificationPreferences> {
  const pool = requireTransactionPool(input.pool);
  if (typeof input.externalEnabled !== "boolean") throw new TypeError("externalEnabled doit être un booléen.");
  const result = await pool.query<{ external_enabled: boolean }>(
    `INSERT INTO notification_preferences (user_id, external_enabled) VALUES ($1::uuid, $2::boolean)
     ON CONFLICT (user_id) DO UPDATE SET external_enabled = EXCLUDED.external_enabled, updated_at = clock_timestamp()
     RETURNING external_enabled`,
    [requireUuid(input.userId, "userId").toLowerCase(), input.externalEnabled],
  );
  return { externalEnabled: result.rows[0].external_enabled };
}
