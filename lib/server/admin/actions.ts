import "server-only";

import type { Pool } from "pg";
import { requireTransactionPool, requireUuid } from "../catalog/validation";
import { updateUser } from "../catalog/users";
import { withPostgresTransaction } from "../postgres/client";
import { AdminError } from "./errors";

/**
 * Suspendre et réactiver un compte (lot D2). Réutilise le statut `users` existant et son chemin (`updateUser` : suspension = évaluations invalidées, session refusée dès
 * la requête suivante ; réactivation = événement `user.reactivated`, donc le BALAYAGE DE RÉACTIVATION du worker remet les annonces en correspondance). Le changement de statut
 * et la ligne du journal d'administration (`admin_actions` : qui, quoi, quand) sont écrits dans la MÊME transaction. Un compte administrateur ne se suspend pas (ni lui-même).
 */

export type VendorAction = "suspend" | "reactivate";

export async function setUserStatusByAdmin(input: { pool: Pool; adminId: string; targetUserId: string; action: VendorAction }): Promise<{ changed: boolean; status: "active" | "suspended" }> {
  const pool = requireTransactionPool(input.pool);
  const adminId = requireUuid(input.adminId, "adminId").toLowerCase();
  const targetId = requireUuid(input.targetUserId, "targetUserId").toLowerCase();
  const target = input.action === "suspend" ? "suspended" : "active";
  return withPostgresTransaction(async (client) => {
    await client.query("SET LOCAL statement_timeout = '10s'");
    const locked = await client.query<{ status: "active" | "suspended" | "archived"; version: number; is_admin: boolean }>(
      "SELECT status, version, is_admin FROM users WHERE id = $1::uuid FOR UPDATE",
      [targetId],
    );
    const user = locked.rows[0];
    if (!user) throw new AdminError("target_not_found");
    if (user.is_admin) throw new AdminError("target_protected");
    if (user.status === "archived") throw new AdminError("target_archived");
    if (user.status === target) return { changed: false, status: target };
    await updateUser({ id: targetId, expectedVersion: user.version, status: target }, client);
    await client.query(
      "INSERT INTO admin_actions (admin_id, source, action, target_user_id) VALUES ($1::uuid, 'admin_ui', $2::text, $3::uuid)",
      [adminId, input.action === "suspend" ? "suspend_user" : "reactivate_user", targetId],
    );
    return { changed: true, status: target };
  }, pool);
}
