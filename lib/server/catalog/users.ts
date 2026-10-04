import "server-only";

import { randomUUID } from "node:crypto";
import type { QueryResultRow } from "pg";
import { getPostgresPool, type SqlExecutor } from "../postgres/client";
import {
  CatalogNotFoundError,
  CatalogValidationError,
  StaleContentVersionError,
} from "./errors";
import { executeInTransactionScope } from "./shared";
import { invalidateMatchesForUser } from "../matching/persistence";
import { recordUserMutation } from "../matching/outbox";
import type { CreateUserInput, UpdateUserInput, UserRecord, UserStatus } from "./types";
import { requireUuid, requireVersion } from "./validation";

interface UserRow extends QueryResultRow {
  id: string;
  status: UserStatus;
  version: number;
  created_at: Date;
  updated_at: Date;
  archived_at: Date | null;
}

const USER_COLUMNS = "id, status, version, created_at, updated_at, archived_at";
const ACTIVE_USER_STATUSES = new Set<UserStatus>(["active", "suspended"]);

const mapUser = (row: UserRow): UserRecord => ({
  id: row.id,
  status: row.status,
  version: row.version,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  archivedAt: row.archived_at,
});

export async function createUser(
  input: CreateUserInput = {},
  db: SqlExecutor = getPostgresPool(),
): Promise<UserRecord> {
  const id = requireUuid(input.id ?? randomUUID(), "id");
  const status = input.status ?? "active";
  if (!ACTIVE_USER_STATUSES.has(status)) {
    throw new CatalogValidationError(`Statut utilisateur invalide : ${status}`);
  }
  return executeInTransactionScope(db, async (tx) => {
    const result = await tx.query<UserRow>(
      `INSERT INTO users (id, status) VALUES ($1, $2) RETURNING ${USER_COLUMNS}`,
      [id, status],
    );
    return mapUser(result.rows[0]);
  });
}

export async function getUserById(
  id: string,
  db: SqlExecutor = getPostgresPool(),
): Promise<UserRecord | null> {
  const result = await db.query<UserRow>(
    `SELECT ${USER_COLUMNS} FROM users WHERE id = $1`,
    [requireUuid(id, "id")],
  );
  return result.rowCount ? mapUser(result.rows[0]) : null;
}

export async function updateUser(
  input: UpdateUserInput,
  db: SqlExecutor = getPostgresPool(),
): Promise<UserRecord> {
  const id = requireUuid(input.id, "id");
  const version = requireVersion(input.expectedVersion, "expectedVersion");
  if (!ACTIVE_USER_STATUSES.has(input.status)) {
    throw new CatalogValidationError(`Statut utilisateur invalide : ${input.status}`);
  }

  return executeInTransactionScope(db, async (tx) => {
    const locked = await tx.query<UserRow>(`SELECT ${USER_COLUMNS} FROM users WHERE id = $1 FOR UPDATE`, [id]);
    if (!locked.rowCount) throw new CatalogNotFoundError("utilisateur");
    const previous = locked.rows[0];
    if (previous.version !== version) throw new StaleContentVersionError("utilisateur", version, previous.version);
    if (previous.status === "archived") throw new CatalogValidationError("Utilisateur archivé.");
    if (previous.status === input.status) return mapUser(previous);
    const result = await tx.query<UserRow>(
      `UPDATE users
         SET status = $3, version = version + 1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND version = $2
       RETURNING ${USER_COLUMNS}`,
      [id, version, input.status],
    );

    if (result.rowCount) {
      if (input.status === "suspended") {
        await invalidateMatchesForUser(tx, id, "user_suspended");
      }
      await recordUserMutation(tx, mapUser(result.rows[0]), mapUser(previous));
      return mapUser(result.rows[0]);
    }

    const current = await tx.query<{ version: number }>("SELECT version FROM users WHERE id = $1", [id]);
    if (!current.rowCount) throw new CatalogNotFoundError("utilisateur");
    throw new StaleContentVersionError("utilisateur", version, current.rows[0].version);
  });
}

export async function archiveUser(
  idValue: string,
  expectedVersion: number,
  db: SqlExecutor = getPostgresPool(),
): Promise<UserRecord> {
  const id = requireUuid(idValue, "id");
  const version = requireVersion(expectedVersion, "expectedVersion");

  return executeInTransactionScope(db, async (tx) => {
    const locked = await tx.query<UserRow>(`SELECT ${USER_COLUMNS} FROM users WHERE id = $1 FOR UPDATE`, [id]);
    if (!locked.rowCount) throw new CatalogNotFoundError("utilisateur");
    const previous = locked.rows[0];
    if (previous.version !== version) throw new StaleContentVersionError("utilisateur", version, previous.version);
    if (previous.status === "archived") return mapUser(previous);
    const result = await tx.query<UserRow>(
      `UPDATE users
         SET status = 'archived', archived_at = CURRENT_TIMESTAMP,
             version = version + 1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND version = $2
       RETURNING ${USER_COLUMNS}`,
      [id, version],
    );

    if (result.rowCount) {
      await invalidateMatchesForUser(tx, id, "user_archived");
      await recordUserMutation(tx, mapUser(result.rows[0]), mapUser(previous));
      return mapUser(result.rows[0]);
    }

    const current = await tx.query<{ version: number }>("SELECT version FROM users WHERE id = $1", [id]);
    if (!current.rowCount) throw new CatalogNotFoundError("utilisateur");
    throw new StaleContentVersionError("utilisateur", version, current.rows[0].version);
  });
}
