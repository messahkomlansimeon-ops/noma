import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DatabaseConfigurationError, POSTGRES_CONNECTION_TIMEOUT_MS, POSTGRES_POOL_MAX, closePostgresPool, getPostgresPool, postgresPoolConfig,
} from "../../lib/server/postgres/client";
import { requirePerfDatabaseUrl } from "../perf/perf-guard";

/**
 * Pool applicatif (lot P3) : taille maximale EXPLICITE et délai d'attente d'une connexion. Sans délai, `pg` fait attendre sans fin quand toutes les
 * connexions sont prises (constaté : 12 devis simultanés, un GET /api/wallet d'un autre utilisateur attendait 63,9 s). Aucune connexion n'est ouverte ici.
 */

test("constantes : 20 connexions au plus par processus, 5 s d'attente d'une connexion", () => {
  assert.equal(POSTGRES_POOL_MAX, 20);
  assert.equal(POSTGRES_CONNECTION_TIMEOUT_MS, 5_000);
});

test("postgresPoolConfig : adresse lue de l'environnement, max et connectionTimeoutMillis explicites ; DATABASE_URL absente ou vide → erreur de configuration", () => {
  const config = postgresPoolConfig({ DATABASE_URL: " postgresql://u:p@127.0.0.1:1/noma_essai " });
  assert.deepEqual(config, { connectionString: "postgresql://u:p@127.0.0.1:1/noma_essai", max: 20, connectionTimeoutMillis: 5_000 });
  for (const env of [{}, { DATABASE_URL: "" }, { DATABASE_URL: "   " }]) {
    assert.throws(() => postgresPoolConfig(env), DatabaseConfigurationError);
  }
});

test("getPostgresPool : le pool partagé porte max et connectionTimeoutMillis, est créé une seule fois et se referme", async () => {
  const previous = process.env.DATABASE_URL;
  process.env.DATABASE_URL = "postgresql://u:p@127.0.0.1:1/noma_essai";
  try {
    const pool = getPostgresPool();
    const options = (pool as unknown as { options: { max?: number; connectionTimeoutMillis?: number } }).options;
    assert.equal(options.max, 20);
    assert.equal(options.connectionTimeoutMillis, 5_000);
    assert.equal(getPostgresPool(), pool, "un seul pool partagé");
    await closePostgresPool();
    assert.notEqual(getPostgresPool(), pool, "un pool neuf après la fermeture");
  } finally {
    await closePostgresPool();
    if (previous === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previous;
  }
});

test("un pool configuré ainsi échoue vite quand aucune connexion n'est libre (jamais une attente sans fin)", async () => {
  const { Pool } = await import("pg");
  // Même configuration, mais une seule connexion et un délai court : la connexion tenue bloque la suivante, qui échoue dans le délai.
  const pool = new Pool({ ...postgresPoolConfig({ DATABASE_URL: process.env.TEST_DATABASE_URL ?? "postgresql://noma_local:noma_local_only@127.0.0.1:55432/noma_test" }), max: 1, connectionTimeoutMillis: 200 });
  try {
    const held = await pool.connect();
    const started = Date.now();
    await assert.rejects(pool.connect(), /timeout exceeded when trying to connect/);
    assert.ok(Date.now() - started < 2_000, `échec en ${Date.now() - started} ms`);
    held.release();
  } finally {
    await pool.end();
  }
});

test("perf:boost (lot P3) : seule une base jetable noma_perf_* de CE poste est acceptée, toute autre est refusée avant toute connexion", () => {
  for (const name of ["noma_perf_p3", "noma_perf_before", "noma_perf_a1_b2"]) {
    assert.equal(requirePerfDatabaseUrl(`postgresql://u:p@127.0.0.1:55432/${name}`), `postgresql://u:p@127.0.0.1:55432/${name}`, name);
  }
  assert.equal(requirePerfDatabaseUrl("postgres://u:p@localhost/noma_perf_x"), "postgres://u:p@localhost/noma_perf_x");
  for (const name of ["noma_dev", "noma_test", "noma_e2e", "noma_essai", "noma_prod", "noma_perf", "noma_perf_", "noma_perf_P3", "noma_perf_é", "autre", "postgres", "noma_perf_" + "a".repeat(41)]) {
    assert.throws(() => requirePerfDatabaseUrl(`postgresql://u:p@127.0.0.1:55432/${name}`), /noma_perf_/, name);
  }
  assert.throws(() => requirePerfDatabaseUrl("postgresql://u:p@db.example.com/noma_perf_p3"), /ce poste/);
  assert.throws(() => requirePerfDatabaseUrl("mysql://u:p@127.0.0.1/noma_perf_p3"), /postgres/);
  for (const value of [undefined, "", "  ", "pas une adresse"]) assert.throws(() => requirePerfDatabaseUrl(value));
});
