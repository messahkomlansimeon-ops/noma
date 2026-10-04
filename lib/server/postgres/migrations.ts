import "server-only";

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool, PoolClient } from "pg";
import { getPostgresPool } from "./client";

const MIGRATIONS_DIRECTORY = fileURLToPath(
  new URL("../../../database/migrations/", import.meta.url),
);
const MIGRATION_NAME = /^\d{4}_[a-z0-9_-]+\.sql$/;
const LOCK_NAMESPACE = 1_314_664_945;
const LOCK_KEY = 1;

interface MigrationFile {
  version: string;
  checksum: string;
  sql: string;
}

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

function loadMigrations(directory = MIGRATIONS_DIRECTORY): MigrationFile[] {
  const names = readdirSync(directory)
    .filter((name) => MIGRATION_NAME.test(name))
    .sort((a, b) => a.localeCompare(b));
  const versions = new Set<string>();

  return names.map((name) => {
    const version = name.slice(0, -4);
    if (versions.has(version)) throw new Error(`Migration dupliquée : ${version}`);
    versions.add(version);
    const sql = readFileSync(join(directory, name), "utf8");
    return {
      version,
      sql,
      checksum: createHash("sha256").update(sql).digest("hex"),
    };
  });
}

async function applyMigrations(client: PoolClient): Promise<MigrationResult> {
  await client.query("SELECT pg_advisory_xact_lock($1, $2)", [LOCK_NAMESPACE, LOCK_KEY]);
  await client.query(`
    CREATE TABLE IF NOT EXISTS noma_schema_migrations (
      version TEXT PRIMARY KEY,
      checksum TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  const result: MigrationResult = { applied: [], skipped: [] };
  for (const migration of loadMigrations()) {
    const existing = await client.query<{ checksum: string }>(
      "SELECT checksum FROM noma_schema_migrations WHERE version = $1",
      [migration.version],
    );
    if (existing.rowCount) {
      if (existing.rows[0].checksum !== migration.checksum) {
        throw new Error(`Checksum modifié pour la migration appliquée ${migration.version}`);
      }
      result.skipped.push(migration.version);
      continue;
    }

    await client.query(migration.sql);
    await client.query(
      "INSERT INTO noma_schema_migrations (version, checksum) VALUES ($1, $2)",
      [migration.version, migration.checksum],
    );
    result.applied.push(migration.version);
  }
  return result;
}

/** Exécution explicite uniquement : aucune migration n'est lancée à l'import. */
export async function runMigrations(pool: Pool = getPostgresPool()): Promise<MigrationResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await applyMigrations(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Préserver l'erreur de migration initiale.
    }
    throw error;
  } finally {
    client.release();
  }
}
