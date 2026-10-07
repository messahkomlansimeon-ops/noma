import "server-only";

import type { QueryResultRow } from "pg";
import { getPostgresPool } from "../postgres/client";
import { readNow } from "./config";
import { sessionTokenHash } from "./primitives";
import type { ResolvedSession, SessionContext } from "./types";

interface SessionRow extends QueryResultRow {
  user_id: string;
  expires_at: Date;
  revoked_at: Date | null;
  account_status: "active" | "suspended" | "archived";
  is_admin: boolean;
}

export async function resolveSession(
  token: string,
  context: SessionContext = {},
): Promise<ResolvedSession | null> {
  const hash = sessionTokenHash(token);
  if (!hash) return null;
  const pool = context.pool ?? getPostgresPool();
  const result = await pool.query<SessionRow>(
    `SELECT session.user_id, session.expires_at, session.revoked_at,
            account.status AS account_status, account.is_admin
       FROM auth_sessions AS session
       JOIN users AS account ON account.id = session.user_id
      WHERE session.token_sha256 = $1`,
    [hash],
  );
  if (!result.rowCount) return null;
  // pool.query peut avoir attendu une connexion. La decision se prend seulement
  // apres cette attente, avec l'horloge injectable relue a cet instant.
  const resolvedAt = readNow(context.now);
  const session = result.rows[0];
  if (
    session.revoked_at !== null ||
    session.account_status !== "active" ||
    session.expires_at.getTime() <= resolvedAt.getTime()
  ) {
    return null;
  }
  return { userId: session.user_id, expiresAt: session.expires_at, isAdmin: session.is_admin === true };
}

export async function revokeSession(
  token: string,
  context: SessionContext = {},
): Promise<void> {
  const hash = sessionTokenHash(token);
  if (!hash) return;
  const now = readNow(context.now);
  const pool = context.pool ?? getPostgresPool();
  await pool.query(
    `UPDATE auth_sessions
        SET revoked_at = COALESCE(revoked_at, $2)
      WHERE token_sha256 = $1`,
    [hash, now],
  );
}
