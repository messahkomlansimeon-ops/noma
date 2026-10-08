import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";
import type { Pool } from "pg";
import { MARKET_RETENTION_DAYS } from "../../lib/server/market/config";
import { PURGE_BATCH_SIZE, purgeMetrics } from "../../lib/server/metrics/purge";
import { MARKET_NOW, dayBefore, insertObservation, makeActors, resetObservations } from "./market-fixtures";
import { runScript } from "./run-script";
import { openTestSchema, resetSocial, type TestSchema } from "./social-fixtures";
import { createTemporarySchemaName, openVerifiedIsolatedPool, quoteTemporarySchema } from "./test-database";

/**
 * Purge des relevés de prix (lot H1), par la commande de purge existante (`metrics:purge`, simulation par défaut, `--apply`) : rétention de 3 ans (1 095 jours, jour UTC du
 * relevé), bornes exactes (1 095 jours pile conservé, 1 096 supprimé), suppression par lots, journal du relevé quotidien purgé avec eux, mesures de 400 jours intactes,
 * base d'avant la 0023 sans erreur.
 */

let env: TestSchema;
let pool: Pool;
let seller: string;

before(async () => {
  env = await openTestSchema();
  pool = env.pool;
  seller = (await makeActors(pool, 1, 0)).sellers[0].id;
});

after(async () => {
  await env.close();
});

beforeEach(async () => {
  await resetSocial(pool);
  await resetObservations(pool);
});

const remaining = async (): Promise<number[]> =>
  (await pool.query<{ age: number }>("SELECT ($1::date - observed_on)::int AS age FROM price_observations ORDER BY age", ["2030-06-15"])).rows.map((row) => row.age);

describe("rétention de 3 ans", () => {
  test(`constante : ${MARKET_RETENTION_DAYS} jours ; premier jour conservé = aujourd'hui − 1 095 jours (bornes 1 094 / 1 095 / 1 096 exactes)`, async () => {
    assert.equal(MARKET_RETENTION_DAYS, 1095);
    for (const age of [1094, 1095, 1096, 1, 3000]) await insertObservation(pool, { day: dayBefore(age), price: 150_000, sellerId: seller });
    const simulation = await purgeMetrics({ pool, apply: false, now: MARKET_NOW });
    assert.equal(simulation.marketCutoffDay, dayBefore(1095));
    assert.equal(simulation.counts.price_observations, 2, "1 096 et 3 000 jours");
    assert.deepEqual(await remaining(), [1, 1094, 1095, 1096, 3000], "la simulation ne supprime rien");
    const applied = await purgeMetrics({ pool, apply: true, now: MARKET_NOW });
    assert.equal(applied.counts.price_observations, 2);
    assert.deepEqual(await remaining(), [1, 1094, 1095], "1 095 jours pile : conservé");
    assert.equal((await purgeMetrics({ pool, apply: true, now: MARKET_NOW })).counts.price_observations, 0, "idempotent");
  });

  test("la rétention des relevés est la leur : un relevé de 500 jours (au-delà des 400 jours des mesures) est conservé", async () => {
    await insertObservation(pool, { day: dayBefore(500), price: 150_000, sellerId: seller });
    await insertObservation(pool, { day: dayBefore(2000), price: 150_000, sellerId: seller });
    const result = await purgeMetrics({ pool, apply: true, now: MARKET_NOW });
    assert.equal(result.counts.price_observations, 1);
    assert.deepEqual(await remaining(), [500]);
  });

  test("ventes et annonces sont purgées de la même façon ; seul le jour UTC du relevé décide (pas sa date d'écriture)", async () => {
    await insertObservation(pool, { source: "sale", day: dayBefore(1200), price: 150_000, sellerId: seller, buyerId: seller });
    await insertObservation(pool, { source: "listing", day: dayBefore(1200), price: 150_000, sellerId: seller });
    await pool.query("UPDATE price_observations SET created_at = clock_timestamp()");
    assert.equal((await purgeMetrics({ pool, apply: true, now: MARKET_NOW })).counts.price_observations, 2);
    assert.deepEqual(await remaining(), []);
  });

  test(`suppression par lots de ${PURGE_BATCH_SIZE} : ${PURGE_BATCH_SIZE + 1} relevés anciens et 3 récents (tous les anciens partent, aucun récent)`, async () => {
    await pool.query(
      `INSERT INTO price_observations (source, reference_id, observed_on, category_key, brand_key, model_key, variant_key, condition_key, label, price_xof, seller_id)
       SELECT 'listing', gen_random_uuid(), DATE '2030-06-15' - 1500, 'telephones', 'apple', 'iphone 12', '128 go', 'occasion', 'x', 150000, $1 FROM generate_series(1, $2::int)`,
      [seller, PURGE_BATCH_SIZE + 1],
    );
    for (const age of [10, 100, 1000]) await insertObservation(pool, { day: dayBefore(age), price: 150_000, sellerId: seller });
    const result = await purgeMetrics({ pool, apply: true, now: MARKET_NOW });
    assert.equal(result.counts.price_observations, PURGE_BATCH_SIZE + 1);
    assert.deepEqual(await remaining(), [10, 100, 1000]);
  });

  test("le journal du relevé quotidien suit la même rétention (appliqué seulement)", async () => {
    await pool.query("INSERT INTO price_observation_runs (day, observed) VALUES ($1::date, 1), ($2::date, 1), ($3::date, 1)", [dayBefore(1096), dayBefore(1095), dayBefore(5)]);
    await purgeMetrics({ pool, apply: false, now: MARKET_NOW });
    assert.equal((await pool.query("SELECT 1 FROM price_observation_runs")).rowCount, 3, "la simulation ne supprime rien");
    await purgeMetrics({ pool, apply: true, now: MARKET_NOW });
    assert.deepEqual((await pool.query<{ day: string }>("SELECT to_char(day, 'YYYY-MM-DD') AS day FROM price_observation_runs ORDER BY day")).rows.map((row) => row.day), [dayBefore(1095), dayBefore(5)]);
  });

  test("rétention invalide : refusée (nulle, négative, décimale)", async () => {
    for (const marketRetentionDays of [0, -1, 1.5, Number.NaN]) await assert.rejects(purgeMetrics({ pool, apply: false, marketRetentionDays }), RangeError, String(marketRetentionDays));
  });
});

describe("commande `metrics:purge`", () => {
  test("sans argument : simulation (rien n'est supprimé) ; --apply supprime ; texte clair sur la ligne « Historique des prix »", async () => {
    const insertAged = (age: number) =>
      pool.query(
        `INSERT INTO price_observations (source, reference_id, observed_on, category_key, brand_key, model_key, variant_key, condition_key, label, price_xof, seller_id)
         VALUES ('listing', gen_random_uuid(), (clock_timestamp() AT TIME ZONE 'UTC')::date - $1::int, 'telephones', 'apple', 'iphone 12', '', '', 'x', 150000, $2)`,
        [age, seller],
      );
    await insertAged(1200);
    await insertAged(1096);
    await insertAged(1095);
    await insertAged(10);
    const simulation = await runScript("scripts/metrics-purge.ts", [], env.schema);
    assert.equal(simulation.code, 0, simulation.output);
    assert.match(simulation.output, /Historique des prix : simulation, 2 relevé\(s\) de prix de plus de 1095 jours \(avant le \d{4}-\d{2}-\d{2} UTC\) seraient supprimé\(s\)\. Rien n'a été supprimé : relancez avec --apply pour supprimer\./);
    assert.equal((await pool.query("SELECT 1 FROM price_observations")).rowCount, 4);
    const applied = await runScript("scripts/metrics-purge.ts", ["--apply"], env.schema);
    assert.equal(applied.code, 0, applied.output);
    assert.match(applied.output, /Historique des prix : 2 relevé\(s\) de prix de plus de 1095 jours \(avant le \d{4}-\d{2}-\d{2} UTC\) supprimé\(s\)\./);
    assert.equal((await pool.query("SELECT 1 FROM price_observations")).rowCount, 2);
    assert.equal(applied.output.includes("password"), false);
  });
});

describe("base d'avant la migration 0023", () => {
  test("la purge ne lit pas la table absente : comptes à zéro, aucune erreur (simulation et application)", async () => {
    const schema = createTemporarySchemaName();
    const quoted = quoteTemporarySchema(schema);
    await env.admin.query(`CREATE SCHEMA ${quoted}`);
    const old = await openVerifiedIsolatedPool(env.target, schema);
    try {
      const directory = join(process.cwd(), "database", "migrations");
      for (const name of readdirSync(directory).filter((entry) => /^\d{4}_.*\.sql$/.test(entry) && entry < "0023_").sort()) await old.query(readFileSync(join(directory, name), "utf8"));
      assert.equal((await old.query("SELECT to_regclass('price_observations') AS t")).rows[0].t, null);
      for (const apply of [false, true]) {
        const result = await purgeMetrics({ pool: old, apply, now: MARKET_NOW });
        assert.equal(result.counts.price_observations, 0);
      }
    } finally {
      await old.end();
      await env.admin.query(`DROP SCHEMA IF EXISTS ${quoted} CASCADE`);
    }
  });
});
