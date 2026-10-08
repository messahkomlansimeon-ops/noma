import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { Pool } from "pg";
import { runMigrations } from "../../lib/server/postgres/migrations";
import { METRICS_RETENTION_DAYS } from "../../lib/server/metrics/config";
import { PURGE_BATCH_SIZE, purgeMetrics } from "../../lib/server/metrics/purge";
import { TRUNCATE_METRICS_TABLES, makeBoost, makeBuyerMatch, makeOffer, makePerson } from "./metrics-fixtures";
import { runScript } from "./run-script";
import {
  createTemporarySchemaName, openVerifiedIsolatedPool, openVerifiedTestDatabase, quoteTemporarySchema, type DedicatedTestDatabase,
} from "./test-database";

const schema = createTemporarySchemaName();
const quoted = quoteTemporarySchema(schema);
let admin: Pool, pool: Pool;
let target: DedicatedTestDatabase;

before(async () => {
  const opened = await openVerifiedTestDatabase(process.env.TEST_DATABASE_URL);
  admin = opened.pool;
  target = opened.target;
  await admin.query(`CREATE SCHEMA ${quoted}`);
  pool = await openVerifiedIsolatedPool(target, schema);
  await runMigrations(pool);
});

after(async () => {
  if (pool) await pool.end();
  if (admin) {
    await admin.query(`DROP SCHEMA IF EXISTS ${quoted} CASCADE`);
    await admin.end();
  }
});

const count = async (table: string): Promise<number> => (await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n;
/**
 * Lot H1 : `purgeMetrics` compte aussi les relevés de prix (`price_observations`, rétention de 3 ans). Les annonces créées par ces essais en écrivent d'office (déclencheur de la
 * migration 0023) ; les essais ci-dessous portent sur les TROIS tables de mesures d'origine, qu'ils lisent par cette vue ; la purge des relevés a ses propres essais
 * (tests/postgres/market-purge.integration.test.ts).
 */
const legacy = (value: { boost_exposures: number; offer_views: number; offer_contacts: number }) => ({ boost_exposures: value.boost_exposures, offer_views: value.offer_views, offer_contacts: value.offer_contacts });
const counts = async () => ({ boost_exposures: await count("boost_exposures"), offer_views: await count("offer_views"), offer_contacts: await count("offer_contacts") });

// Instant de référence fixe : 2032-06-15 12:00 UTC. Rétention 400 jours → premier jour conservé : 2031-05-12 (2032-06-15 − 400 j).
const NOW = new Date(Date.UTC(2032, 5, 15, 12));
const KEPT_FROM = "2031-05-12";

interface Seeded { offerId: string; boostId: string; entries: Array<{ demandId: string; viewerId: string }> }

/** Une annonce, un boost et `count` besoins (un acheteur chacun) : les lignes des trois journaux s'y rattachent. */
async function seed(entries: number): Promise<Seeded> {
  await pool.query(TRUNCATE_METRICS_TABLES);
  const seller = await makePerson(pool);
  const offer = await makeOffer(pool, seller.id);
  const boostId = await makeBoost(pool, offer);
  const list: Seeded["entries"] = [];
  for (let index = 0; index < entries; index++) {
    const { buyer, demand } = await makeBuyerMatch(pool, offer);
    list.push({ demandId: demand.id, viewerId: buyer.id });
  }
  return { offerId: offer.id, boostId, entries: list };
}

/** `ageDays` jours avant le 2032-06-15 (jour UTC). */
async function insertRows(seeded: Seeded, index: number, ageDays: number): Promise<void> {
  const { demandId, viewerId } = seeded.entries[index];
  await pool.query(
    `INSERT INTO boost_exposures (boost_id, offer_id, demand_id, viewer_id, served_day, first_served_at, last_served_at, servings, sponsored_servings, best_position, best_gain)
     VALUES ($1, $2, $3, $4, ($5::date - $6::int), clock_timestamp(), clock_timestamp(), 1, 1, 0, 1)`,
    [seeded.boostId, seeded.offerId, demandId, viewerId, "2032-06-15", ageDays],
  );
  await pool.query(
    `INSERT INTO offer_views (offer_id, demand_id, viewed_day, viewer_id, views, boosted_views, first_at, last_at)
     VALUES ($1, $2, ($3::date - $4::int), $5, 1, 0, clock_timestamp(), clock_timestamp())`,
    [seeded.offerId, demandId, "2032-06-15", ageDays, viewerId],
  );
  await pool.query(
    `INSERT INTO offer_contacts (offer_id, demand_id, viewer_id, reveals, first_contact_at, last_contact_at)
     VALUES ($1, $2, $3, 1, ($4::date - $5::int)::timestamp AT TIME ZONE 'UTC' + interval '12 hours', ($4::date - $5::int)::timestamp AT TIME ZONE 'UTC' + interval '12 hours')`,
    [seeded.offerId, demandId, viewerId, "2032-06-15", ageDays],
  );
}

test(`rétention : ${METRICS_RETENTION_DAYS} jours (constante) ; premier jour conservé = aujourd'hui − 400 jours`, async () => {
  assert.equal(METRICS_RETENTION_DAYS, 400);
  const seeded = await seed(1);
  await insertRows(seeded, 0, 400);
  const result = await purgeMetrics({ pool, apply: false, now: NOW });
  assert.equal(result.cutoffDay, KEPT_FROM);
  assert.deepEqual(legacy(result.counts), { boost_exposures: 0, offer_views: 0, offer_contacts: 0 }, "400 jours pile : conservé");
});

test("simulation : compte les lignes de PLUS de 400 jours dans les trois tables et ne supprime RIEN", async () => {
  const seeded = await seed(4);
  await insertRows(seeded, 0, 401);
  await insertRows(seeded, 1, 500);
  await insertRows(seeded, 2, 399);
  await insertRows(seeded, 3, 10);
  const before = await counts();
  assert.deepEqual(before, { boost_exposures: 4, offer_views: 4, offer_contacts: 4 });
  const result = await purgeMetrics({ pool, apply: false, now: NOW });
  assert.equal(result.apply, false);
  assert.deepEqual(legacy(result.counts), { boost_exposures: 2, offer_views: 2, offer_contacts: 2 });
  assert.deepEqual(await counts(), before, "rien n'est supprimé en simulation");
  // La simulation est le défaut de la fonction aussi : apply est explicite et obligatoire pour supprimer.
  assert.deepEqual((await purgeMetrics({ pool, apply: false, now: NOW })).counts, result.counts);
});

test("application : supprime au-delà de 400 jours, bornes 399 / 400 / 401 jours exactes dans CHAQUE table, garde le reste intact", async () => {
  const seeded = await seed(5);
  const ages = [399, 400, 401, 1, 800];
  for (const [index, age] of ages.entries()) await insertRows(seeded, index, age);
  const result = await purgeMetrics({ pool, apply: true, now: NOW });
  assert.equal(result.apply, true);
  assert.deepEqual(legacy(result.counts), { boost_exposures: 2, offer_views: 2, offer_contacts: 2 }, "401 et 800 jours supprimés");
  assert.deepEqual(await counts(), { boost_exposures: 3, offer_views: 3, offer_contacts: 3 });
  const kept = async (table: string, column: string) => (await pool.query<{ age: number }>(
    `SELECT ($1::date - (${column} AT TIME ZONE 'UTC')::date)::int AS age FROM ${table} ORDER BY age`, ["2032-06-15"])).rows.map((row) => row.age);
  assert.deepEqual(await kept("boost_exposures", "served_day::timestamp"), [1, 399, 400]);
  assert.deepEqual(await kept("offer_views", "viewed_day::timestamp"), [1, 399, 400]);
  assert.deepEqual(await kept("offer_contacts", "last_contact_at"), [1, 399, 400]);
  // Idempotent : une seconde application ne supprime plus rien.
  assert.deepEqual(legacy((await purgeMetrics({ pool, apply: true, now: NOW })).counts), { boost_exposures: 0, offer_views: 0, offer_contacts: 0 });
});

test("contacts : le jour du DERNIER contact décide (un premier contact ancien révélé de nouveau récemment est conservé)", async () => {
  const seeded = await seed(2);
  await insertRows(seeded, 0, 300);
  await insertRows(seeded, 1, 300);
  await pool.query(
    `UPDATE offer_contacts SET first_contact_at = (DATE '2032-06-15' - 450)::timestamp AT TIME ZONE 'UTC', last_contact_at = (DATE '2032-06-15' - 2)::timestamp AT TIME ZONE 'UTC' WHERE demand_id = $1`,
    [seeded.entries[0].demandId],
  );
  await pool.query(
    `UPDATE offer_contacts SET first_contact_at = (DATE '2032-06-15' - 450)::timestamp AT TIME ZONE 'UTC', last_contact_at = (DATE '2032-06-15' - 410)::timestamp AT TIME ZONE 'UTC' WHERE demand_id = $1`,
    [seeded.entries[1].demandId],
  );
  const result = await purgeMetrics({ pool, apply: true, now: NOW });
  assert.equal(result.counts.offer_contacts, 1, "seul celui dont le dernier contact a plus de 400 jours");
  assert.equal((await pool.query<{ demand_id: string }>("SELECT demand_id FROM offer_contacts")).rows[0].demand_id, seeded.entries[0].demandId);
});

test(`application par lots (${PURGE_BATCH_SIZE} lignes par instruction) : plus d'un lot de lignes anciennes est entièrement supprimé, les récentes restent`, async () => {
  const seeded = await seed(2);
  const total = PURGE_BATCH_SIZE + 100;
  await pool.query(
    `INSERT INTO boost_exposures (boost_id, offer_id, demand_id, viewer_id, served_day, first_served_at, last_served_at, servings, sponsored_servings, best_position, best_gain)
     SELECT $1, $2, $3, $4, DATE '2000-01-01' + g, clock_timestamp(), clock_timestamp(), 1, 0, 0, 0 FROM generate_series(1, $5::int) g`,
    [seeded.boostId, seeded.offerId, seeded.entries[0].demandId, seeded.entries[0].viewerId, total],
  );
  await insertRows(seeded, 1, 5);
  assert.equal(await count("boost_exposures"), total + 1);
  const result = await purgeMetrics({ pool, apply: true, now: NOW });
  assert.equal(result.counts.boost_exposures, total);
  assert.equal(await count("boost_exposures"), 1, "la ligne récente reste");
});

test("arguments invalides : une rétention nulle, négative ou décimale est refusée", async () => {
  for (const retentionDays of [0, -1, 1.5, Number.NaN]) {
    await assert.rejects(purgeMetrics({ pool, apply: false, retentionDays }), RangeError, String(retentionDays));
  }
});

// ═════════════ Commande `metrics:purge` (processus enfant) ═════════════

const script = "scripts/metrics-purge.ts";

test("commande : sans argument = SIMULATION (rien n'est supprimé), --apply supprime ; texte clair", async () => {
  const seeded = await seed(2);
  // Lignes de 500 jours par rapport à l'horloge RÉELLE de la base (la commande n'a pas d'instant de référence réglable).
  for (const index of [0, 1]) {
    const { demandId, viewerId } = seeded.entries[index];
    await pool.query(
      `INSERT INTO boost_exposures (boost_id, offer_id, demand_id, viewer_id, served_day, first_served_at, last_served_at, servings, sponsored_servings, best_position, best_gain)
       VALUES ($1, $2, $3, $4, ((clock_timestamp() AT TIME ZONE 'UTC')::date - $5::int), clock_timestamp(), clock_timestamp(), 1, 0, 0, 0)`,
      [seeded.boostId, seeded.offerId, demandId, viewerId, index === 0 ? 500 : 10],
    );
  }
  await pool.query(
    `INSERT INTO offer_views (offer_id, demand_id, viewed_day, viewer_id, views, boosted_views, first_at, last_at)
     VALUES ($1, $2, ((clock_timestamp() AT TIME ZONE 'UTC')::date - 450), $3, 1, 0, clock_timestamp(), clock_timestamp())`,
    [seeded.offerId, seeded.entries[0].demandId, seeded.entries[0].viewerId],
  );
  const simulation = await runScript(script, [], schema);
  assert.equal(simulation.code, 0, simulation.output);
  assert.match(simulation.output, /Mesures : simulation, 1 ligne\(s\) de boost_exposures, 1 d'offer_views, 0 d'offer_contacts de plus de 400 jours \(avant le \d{4}-\d{2}-\d{2} UTC\) seraient supprimée\(s\)\. Rien n'a été supprimé : relancez avec --apply pour supprimer\./);
  assert.deepEqual(await counts(), { boost_exposures: 2, offer_views: 1, offer_contacts: 0 }, "la simulation ne supprime rien");
  const applied = await runScript(script, ["--apply"], schema);
  assert.equal(applied.code, 0, applied.output);
  assert.match(applied.output, /Mesures : 1 ligne\(s\) de boost_exposures, 1 d'offer_views, 0 d'offer_contacts de plus de 400 jours \(avant le \d{4}-\d{2}-\d{2} UTC\) supprimée\(s\)\./);
  assert.deepEqual(await counts(), { boost_exposures: 1, offer_views: 0, offer_contacts: 0 });
  assert.equal(applied.output.includes("password"), false);
});

test("commande : argument inconnu, répété ou mal placé → code 1 et RIEN n'est supprimé (jamais d'application sans --apply exact)", async () => {
  const seeded = await seed(1);
  await pool.query(
    `INSERT INTO offer_views (offer_id, demand_id, viewed_day, viewer_id, views, boosted_views, first_at, last_at)
     VALUES ($1, $2, ((clock_timestamp() AT TIME ZONE 'UTC')::date - 450), $3, 1, 0, clock_timestamp(), clock_timestamp())`,
    [seeded.offerId, seeded.entries[0].demandId, seeded.entries[0].viewerId],
  );
  for (const args of [["--apply", "--apply"], ["apply"], ["--force"], ["--apply=1"], ["--dry-run"], ["--APPLY"], ["-a"]]) {
    const result = await runScript(script, args, schema);
    assert.equal(result.code, 1, `${args.join(" ")} : ${result.output}`);
    assert.match(result.output, /Usage : npm run metrics:purge \[-- --apply\]/);
  }
  assert.equal(await count("offer_views"), 1, "aucune suppression");
});

test("commande : refus en PRODUCTION sans NOMA_METRICS_PURGE_PRODUCTION=1 (simulation comprise), rien lu ni supprimé ; permis avec la variable ; DATABASE_URL obligatoire", async () => {
  const seeded = await seed(1);
  await pool.query(
    `INSERT INTO offer_views (offer_id, demand_id, viewed_day, viewer_id, views, boosted_views, first_at, last_at)
     VALUES ($1, $2, ((clock_timestamp() AT TIME ZONE 'UTC')::date - 450), $3, 1, 0, clock_timestamp(), clock_timestamp())`,
    [seeded.offerId, seeded.entries[0].demandId, seeded.entries[0].viewerId],
  );
  for (const args of [[], ["--apply"]]) {
    const refused = await runScript(script, args, schema, { NODE_ENV: "production" });
    assert.equal(refused.code, 1, refused.output);
    assert.match(refused.output, /refus en production : définissez NOMA_METRICS_PURGE_PRODUCTION=1/);
    assert.equal(await count("offer_views"), 1, `${args.join(" ") || "simulation"} : rien supprimé`);
  }
  const wrongValue = await runScript(script, ["--apply"], schema, { NODE_ENV: "production", NOMA_METRICS_PURGE_PRODUCTION: "oui" });
  assert.equal(wrongValue.code, 1, wrongValue.output);
  assert.equal(await count("offer_views"), 1);
  const allowedSimulation = await runScript(script, [], schema, { NODE_ENV: "production", NOMA_METRICS_PURGE_PRODUCTION: "1" });
  assert.equal(allowedSimulation.code, 0, allowedSimulation.output);
  assert.equal(await count("offer_views"), 1);
  const allowed = await runScript(script, ["--apply"], schema, { NODE_ENV: "production", NOMA_METRICS_PURGE_PRODUCTION: "1" });
  assert.equal(allowed.code, 0, allowed.output);
  assert.equal(await count("offer_views"), 0);
  const noDatabase = await runScript(script, [], schema, { DATABASE_URL: "" });
  assert.equal(noDatabase.code, 1);
  assert.match(noDatabase.output, /DATABASE_URL est requis/);
});

test("commande (M2) : NODE_ENV doit être absent, development ou test, casse exacte — « Production », « PRODUCTION », « prod », « staging », vide sont REFUSÉS (simulation comprise), même avec la variable de production", async () => {
  const seeded = await seed(1);
  await pool.query(
    `INSERT INTO offer_views (offer_id, demand_id, viewed_day, viewer_id, views, boosted_views, first_at, last_at)
     VALUES ($1, $2, ((clock_timestamp() AT TIME ZONE 'UTC')::date - 450), $3, 1, 0, clock_timestamp(), clock_timestamp())`,
    [seeded.offerId, seeded.entries[0].demandId, seeded.entries[0].viewerId],
  );
  for (const value of ["Production", "PRODUCTION", "prod", "staging", "", "Test", "DEVELOPMENT"]) {
    for (const args of [[], ["--apply"]]) {
      const refused = await runScript(script, args, schema, { NODE_ENV: value });
      assert.equal(refused.code, 1, `NODE_ENV=${JSON.stringify(value)} ${args.join(" ")} : ${refused.output}`);
      assert.match(refused.output, /refus : NODE_ENV doit être absent, « development » ou « test »/);
    }
    const withVariable = await runScript(script, ["--apply"], schema, { NODE_ENV: value, NOMA_METRICS_PURGE_PRODUCTION: "1" });
    assert.equal(withVariable.code, 1, `NODE_ENV=${JSON.stringify(value)} + NOMA_METRICS_PURGE_PRODUCTION=1 : ${withVariable.output}`);
    assert.equal(await count("offer_views"), 1, `NODE_ENV=${JSON.stringify(value)} : rien supprimé`);
  }
  // Permis : development et test (casse exacte).
  for (const value of ["development", "test"]) {
    const simulation = await runScript(script, [], schema, { NODE_ENV: value });
    assert.equal(simulation.code, 0, `NODE_ENV=${value} : ${simulation.output}`);
    assert.equal(await count("offer_views"), 1);
  }
  const applied = await runScript(script, ["--apply"], schema, { NODE_ENV: "development" });
  assert.equal(applied.code, 0, applied.output);
  assert.equal(await count("offer_views"), 0);
});
