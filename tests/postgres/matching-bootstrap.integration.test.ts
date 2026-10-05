import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { before, after, test } from "node:test";
import { Pool } from "pg";
import {
  archiveDemand, archiveOffer, archiveUser, createDemand, createOffer, createUser, satisfyDemand, updateOffer, updateUser,
} from "../../lib/server/catalog";
import type { DemandRecord, OfferRecord, UserRecord } from "../../lib/server/catalog/types";
import { MatchingBootstrapError, runCatalogBootstrap } from "../../lib/server/matching/bootstrap";
import { computeScoringConfigHash, normalizeScoringConfig } from "../../lib/server/matching/persistence";
import { computeJobIdentity } from "../../lib/server/matching/projection";
import { runMatchingCycle } from "../../lib/server/matching/runner";
import { runMigrations } from "../../lib/server/postgres/migrations";
import { runScript } from "./run-script";
import {
  openVerifiedTestDatabase, openVerifiedIsolatedPool, createTemporarySchemaName, quoteTemporarySchema,
} from "./test-database";

let admin: Pool, pool: Pool, second: Pool;
const schema = createTemporarySchemaName();
const quoted = quoteTemporarySchema(schema);

before(async () => {
  const opened = await openVerifiedTestDatabase(process.env.TEST_DATABASE_URL);
  admin = opened.pool;
  await admin.query(`CREATE SCHEMA ${quoted}`);
  pool = await openVerifiedIsolatedPool(opened.target, schema);
  second = await openVerifiedIsolatedPool(opened.target, schema);
  assert.equal((await runMigrations(pool)).applied.length, 13);
});

after(async () => {
  for (const db of [second, pool]) if (db) await db.end();
  if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${quoted} CASCADE`); await admin.end(); }
});

// ───────────── catalogue « antérieur à l'outbox » ─────────────
// Les services catalogue enregistrent leurs événements outbox : pour simuler un catalogue créé AVANT l'outbox, les
// ressources sont créées avec les vrais services, puis leurs événements (et jobs) sont supprimés par SQL de test.

const resetAll = () => pool.query(
  "TRUNCATE matching_evaluations, matching_jobs, matching_outbox_events, demands, offers, users CASCADE");
const wipeOutboxAndJobs = async () => {
  await pool.query("DELETE FROM matching_jobs");
  await pool.query("DELETE FROM matching_outbox_events");
};

const offerInput = (ownerId: string, extra: Record<string, unknown> = {}) => ({
  ownerId, rawText: "iPhone 13 128Go avec chargeur", category: "smartphones", brand: "Apple", model: "iPhone 13",
  attributes: { charger_included: true }, price: { amount: 250_000, currency: "XOF" }, status: "published" as const, ...extra,
});
const demandInput = (ownerId: string, extra: Record<string, unknown> = {}) => ({
  ownerId, rawText: "Cherche iPhone 13", category: "smartphones", brand: "Apple", model: "iPhone 13",
  requirements: [{ key: "chargeur", operator: "includes", value: "chargeur" }],
  budget: { amount: 300_000, currency: "XOF" }, status: "active" as const, ...extra,
});

interface Catalog {
  seller: UserRecord;
  buyer: UserRecord;
  eligibleOffers: OfferRecord[];
  eligibleDemands: DemandRecord[];
  ineligible: Array<OfferRecord | DemandRecord>;
}

/** 3 offres et 2 demandes éligibles ; une ressource de chaque motif d'inéligibilité ; propriétaires suspendu et archivé. */
async function legacyCatalog(): Promise<Catalog> {
  await resetAll();
  const seller = await createUser({}, pool), buyer = await createUser({}, pool);
  const suspended = await createUser({}, pool), archived = await createUser({}, pool);
  const o1 = await createOffer(offerInput(seller.id, { rawText: "iPhone 13 n°1" }), pool);
  let o2 = await createOffer(offerInput(seller.id, { rawText: "iPhone 13 n°2", availabilityStatus: "reserved" }), pool);
  o2 = await updateOffer({ id: o2.id, ownerId: seller.id, expectedContentVersion: o2.contentVersion, changes: { rawText: "iPhone 13 n°2 révisé" } }, pool);
  const d1 = await createDemand(demandInput(seller.id, { rawText: "Cherche iPhone 13 (vendeur)" }), pool);
  const ob = await createOffer(offerInput(buyer.id, { rawText: "iPhone 13 de l'acheteur" }), pool);
  const db = await createDemand(demandInput(buyer.id), pool);

  const ineligible: Array<OfferRecord | DemandRecord> = [];
  ineligible.push(await createOffer(offerInput(seller.id, { availabilityStatus: "unavailable" }), pool));
  ineligible.push(await createOffer(offerInput(seller.id, { status: "draft" }), pool));
  ineligible.push(await createOffer(offerInput(seller.id, { status: "paused" }), pool));
  const toArchive = await createOffer(offerInput(seller.id), pool);
  ineligible.push(await archiveOffer(seller.id, toArchive.id, toArchive.contentVersion, pool));
  ineligible.push(await createDemand(demandInput(buyer.id, { status: "draft" }), pool));
  const satisfiable = await createDemand(demandInput(buyer.id), pool);
  ineligible.push(await satisfyDemand(buyer.id, satisfiable.id, satisfiable.contentVersion, pool));
  const archivable = await createDemand(demandInput(buyer.id), pool);
  ineligible.push(await archiveDemand(buyer.id, archivable.id, archivable.contentVersion, pool));
  ineligible.push(await createOffer(offerInput(suspended.id), pool), await createDemand(demandInput(suspended.id), pool));
  await updateUser({ id: suspended.id, expectedVersion: suspended.version, status: "suspended" }, pool);
  ineligible.push(await createOffer(offerInput(archived.id), pool), await createDemand(demandInput(archived.id), pool));
  await archiveUser(archived.id, archived.version, pool);

  await wipeOutboxAndJobs();
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM matching_outbox_events")).rows[0].n, 0);
  return { seller, buyer, eligibleOffers: [o1, o2, ob], eligibleDemands: [d1, db], ineligible };
}

const jobs = async () => (await pool.query("SELECT * FROM matching_jobs ORDER BY created_at, id")).rows;
const bootstrapEvents = async () => (await pool.query("SELECT * FROM matching_outbox_events WHERE event_type = 'catalog.bootstrap_sync' ORDER BY occurred_at, id")).rows;
const SNAPSHOT_TABLES = ["users", "offers", "demands", "matching_jobs", "matching_outbox_events", "matching_evaluations"];
const snapshotAll = async () => {
  const out: Record<string, unknown[]> = {};
  for (const table of SNAPSHOT_TABLES) out[table] = (await pool.query(`SELECT to_jsonb(t.*) AS row FROM ${table} t ORDER BY 1::text`)).rows;
  return out;
};

const insertJobRow = (type: string, resourceId: string, version: number, status: string) => pool.query(
  `INSERT INTO matching_jobs (job_identity, job_type, resource_id, resource_version, status, completed_at)
   VALUES ($1, $2, $3, $4, $5, CASE WHEN $5 IN ('completed','superseded','dead_letter') THEN clock_timestamp() END)`,
  [randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", ""), type, resourceId, version, status]);

const ids = (records: Array<{ id: string }>) => records.map((record) => record.id).sort();

function observed() {
  let queries = 0;
  const spy = Object.create(pool) as Pool;
  spy.query = ((...args: unknown[]) => { queries++; return (pool.query as (...a: unknown[]) => unknown)(...args); }) as never;
  spy.connect = ((...args: unknown[]) => { queries++; return (pool.connect as (...a: unknown[]) => unknown)(...args); }) as never;
  return { spy, count: () => queries };
}

// ═════════════ 1. Catalogue sans événements ═════════════

test("catalogue sans événements : un job par ressource éligible, aucun pour les autres, champs exacts", async () => {
  const catalog = await legacyCatalog();
  const result = await runCatalogBootstrap({ pool });
  assert.equal(result.dryRun, false);
  assert.deepEqual({ offers: result.offersScanned, demands: result.demandsScanned, inserted: result.jobsInserted, covered: result.alreadyCovered }, { offers: 3, demands: 2, inserted: 5, covered: 0 });
  assert.ok(result.eventId);

  const events = await bootstrapEvents();
  assert.equal(events.length, 1);
  const [event] = events;
  assert.equal(event.id, result.eventId);
  assert.equal(event.aggregate_type, "system");
  assert.equal(event.aggregate_version, null);
  assert.equal(event.dispatch_status, "projected");
  assert.ok(event.dispatched_at);
  assert.equal(event.payload.generation, 1);
  const hash = computeScoringConfigHash(normalizeScoringConfig());
  assert.equal(event.payload.scoring_config_hash, hash);

  const rows = await jobs();
  assert.equal(rows.length, 5);
  assert.deepEqual(rows.map((row) => row.resource_id).sort(), ids([...catalog.eligibleOffers, ...catalog.eligibleDemands]));
  for (const ineligible of catalog.ineligible) assert.equal(rows.some((row) => row.resource_id === ineligible.id), false, ineligible.id);
  for (const row of rows) {
    const resource = [...catalog.eligibleOffers, ...catalog.eligibleDemands].find((candidate) => candidate.id === row.resource_id)!;
    const kind = catalog.eligibleOffers.some((offer) => offer.id === resource.id) ? "evaluate_offer_candidates" : "evaluate_demand_candidates";
    assert.equal(row.job_type, kind);
    assert.equal(row.resource_version, resource.contentVersion);
    assert.equal(row.scoring_config_hash, hash);
    assert.equal(row.source_event_id, event.id);
    assert.equal(row.target_resource_id, null);
    assert.equal(row.status, "pending");
    assert.equal(row.job_identity, computeJobIdentity({
      generation: resource.contentVersion, jobType: kind, resourceId: resource.id, resourceVersion: resource.contentVersion,
      scoringConfigHash: hash, sourceEventId: event.id, targetResourceId: null,
    }));
  }
  assert.ok(catalog.eligibleOffers.some((offer) => offer.contentVersion === 2), "une ressource est à la version 2");
});

// ═════════════ 2. Règle « déjà couvert » ═════════════

test("règle « déjà couvert » : job non dead_letter ou événement pending à la version courante ignorés ; dead_letter et ancienne version relancés", async () => {
  await resetAll();
  const owner = await createUser({}, pool);
  const mk = (rawText: string) => createOffer(offerInput(owner.id, { rawText }), pool);
  const [a, b, c, e, f, g, h] = [await mk("A"), await mk("B"), await mk("C"), await mk("E"), await mk("F"), await mk("G"), await mk("H")];
  let d = await mk("D");
  d = await updateOffer({ id: d.id, ownerId: owner.id, expectedContentVersion: d.contentVersion, changes: { rawText: "D révisé" } }, pool);
  await wipeOutboxAndJobs();

  await insertJobRow("evaluate_offer_candidates", a.id, a.contentVersion, "completed");   // couverte
  await insertJobRow("evaluate_offer_candidates", b.id, b.contentVersion, "dead_letter"); // relancée
  await pool.query(                                                                       // couverte : événement pending
    "INSERT INTO matching_outbox_events(event_type, aggregate_type, aggregate_id, aggregate_version, payload) VALUES ('offer.updated','offer',$1,$2,'{}'::jsonb)",
    [c.id, c.contentVersion]);
  await insertJobRow("evaluate_offer_candidates", d.id, d.contentVersion - 1, "completed"); // ancienne version seulement : relancée
  await insertJobRow("evaluate_offer_candidates", f.id, f.contentVersion, "pending");      // couverte
  await insertJobRow("evaluate_offer_candidates", g.id, g.contentVersion, "failed");       // couverte
  await insertJobRow("evaluate_offer_candidates", h.id, h.contentVersion, "superseded");   // couverte
  await pool.query(                                                                        // événement pending à une ANCIENNE version : n'couvre pas
    "INSERT INTO matching_outbox_events(event_type, aggregate_type, aggregate_id, aggregate_version, payload) VALUES ('offer.updated','offer',$1,$2,'{}'::jsonb)",
    [e.id, e.contentVersion + 5]);
  // Un événement DÉJÀ projeté à la version courante ne couvre pas non plus : seul le job le ferait.
  await pool.query(
    "INSERT INTO matching_outbox_events(event_type, aggregate_type, aggregate_id, aggregate_version, payload, dispatch_status, dispatched_at) VALUES ('offer.created','offer',$1,$2,'{}'::jsonb,'projected',now())",
    [e.id, e.contentVersion]);

  const result = await runCatalogBootstrap({ pool });
  assert.deepEqual({ scanned: result.offersScanned, inserted: result.jobsInserted, covered: result.alreadyCovered }, { scanned: 8, inserted: 3, covered: 5 });
  const created = (await jobs()).filter((job) => job.source_event_id === result.eventId);
  assert.deepEqual(created.map((job) => job.resource_id).sort(), ids([b, d, e]));
  assert.equal(created.find((job) => job.resource_id === d.id)!.resource_version, d.contentVersion);
  // Les jobs préexistants sont intacts.
  assert.equal((await jobs()).filter((job) => job.source_event_id !== result.eventId).length, 6);

  // Un type de job différent (demande) ne couvre pas une offre : les ids sont distincts, mais le type doit compter.
  await resetAll();
  const buyer = await createUser({}, pool);
  const demand = await createDemand(demandInput(buyer.id), pool);
  await wipeOutboxAndJobs();
  await insertJobRow("evaluate_offer_candidates", demand.id, demand.contentVersion, "completed");
  assert.equal((await runCatalogBootstrap({ pool })).jobsInserted, 1, "un job d'offre ne couvre pas une demande");
});

// ═════════════ 3. Simulation ═════════════

test("dryRun : compteurs corrects et aucune écriture (snapshot complet des tables)", async () => {
  const catalog = await legacyCatalog();
  await insertJobRow("evaluate_offer_candidates", catalog.eligibleOffers[0].id, catalog.eligibleOffers[0].contentVersion, "completed");
  const before = await snapshotAll();
  const result = await runCatalogBootstrap({ pool, dryRun: true });
  assert.deepEqual(result, { eventId: null, offersScanned: 3, demandsScanned: 2, jobsInserted: 4, alreadyCovered: 1, dryRun: true });
  assert.deepEqual(await snapshotAll(), before, "aucune écriture, aucun événement");
  assert.equal((await bootstrapEvents()).length, 0);
  // La simulation ne verrouille rien durablement : l'application réelle suit.
  const applied = await runCatalogBootstrap({ pool });
  assert.deepEqual({ inserted: applied.jobsInserted, covered: applied.alreadyCovered }, { inserted: 4, covered: 1 });
});

// ═════════════ 4. Idempotence et reprise ═════════════

test("idempotence : une 2e exécution crée 0 job", async () => {
  await legacyCatalog();
  assert.equal((await runCatalogBootstrap({ pool })).jobsInserted, 5);
  const again = await runCatalogBootstrap({ pool });
  assert.deepEqual({ inserted: again.jobsInserted, covered: again.alreadyCovered }, { inserted: 0, covered: 5 });
  assert.equal((await jobs()).length, 5);
  assert.ok((await bootstrapEvents()).every((event) => event.dispatch_status === "projected"));
});

test("crash après le 1er lot : l'événement reste pending, la reprise réutilise le MÊME eventId, sans doublon, puis l'événement est projeté", async () => {
  await legacyCatalog();
  await assert.rejects(runCatalogBootstrap({ pool, batchSize: 2, hooks: { afterBatch: (index) => { if (index === 0) throw new Error("crash simulé"); } } }), /crash simulé/);
  const events = await bootstrapEvents();
  assert.equal(events.length, 1);
  assert.equal(events[0].dispatch_status, "pending");
  assert.equal((await jobs()).length, 2, "le premier lot est validé");

  const resumed = await runCatalogBootstrap({ pool, batchSize: 2 });
  assert.equal(resumed.eventId, events[0].id, "même événement");
  assert.deepEqual({ inserted: resumed.jobsInserted, covered: resumed.alreadyCovered }, { inserted: 3, covered: 2 });
  const rows = await jobs();
  assert.equal(rows.length, 5);
  assert.equal(new Set(rows.map((row) => row.job_identity)).size, 5);
  assert.equal(new Set(rows.map((row) => row.resource_id)).size, 5);
  assert.ok(rows.every((row) => row.source_event_id === events[0].id));
  const after = await bootstrapEvents();
  assert.equal(after.length, 1, "aucun second événement");
  assert.equal(after[0].dispatch_status, "projected");
  assert.ok(after[0].dispatched_at);
});

test("lots : batchSize 1 parcourt tout sans doublon ni perte", async () => {
  await legacyCatalog();
  const result = await runCatalogBootstrap({ pool, batchSize: 1 });
  assert.deepEqual({ offers: result.offersScanned, demands: result.demandsScanned, inserted: result.jobsInserted }, { offers: 3, demands: 2, inserted: 5 });
});

// ═════════════ 5. Concurrence ═════════════

test("concurrence : un second bootstrap est refusé (« déjà en cours »), un seul événement, aucun doublon", async () => {
  await legacyCatalog();
  // Les pools de test n'ont qu'une connexion : le premier bootstrap garde celle de `pool` pendant tout le test ;
  // les inspections et le second bootstrap passent par `second`, sans chevauchement entre eux.
  const count = async (table: string) => (await second.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n as number;
  let locked!: () => void;
  const lockObtained = new Promise<void>((resolve) => { locked = resolve; });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const first = runCatalogBootstrap({ pool, hooks: { afterLock: async () => { locked(); await gate; } } });
  await lockObtained;
  const eventsWhileHeld = await count("matching_outbox_events");
  await assert.rejects(runCatalogBootstrap({ pool: second }), (error: unknown) => error instanceof MatchingBootstrapError && /déjà en cours/.test(error.message));
  await assert.rejects(runCatalogBootstrap({ pool: second, dryRun: true }), /déjà en cours/);
  assert.equal(await count("matching_outbox_events"), eventsWhileHeld, "le refus n'écrit rien");
  assert.equal(await count("matching_jobs"), 0);
  release();
  const done = await first;
  assert.equal(done.jobsInserted, 5);
  assert.equal((await bootstrapEvents()).length, 1);
  assert.equal((await jobs()).length, 5);
  // Le verrou est libéré (succès comme échec) : l'exécution suivante passe.
  assert.equal((await runCatalogBootstrap({ pool: second })).jobsInserted, 0);
  await assert.rejects(runCatalogBootstrap({ pool, hooks: { afterLock: () => { throw new Error("échec sous verrou"); } } }), /échec sous verrou/);
  assert.equal((await runCatalogBootstrap({ pool: second })).jobsInserted, 0);
});

// ═════════════ 5 bis. Échec d'écriture au milieu d'un lot ═════════════

test("échec de l'INSERT d'un job au milieu du 2e lot : lot atomique, événement pending, connexion rendue propre, reprise immédiate sur le même pool", async () => {
  const catalog = await legacyCatalog();
  // 4e offre éligible : avec batchSize 2, le lot 0 écrit 2 jobs, le lot 1 en écrit un 3e puis échoue sur le 4e.
  await createOffer(offerInput(catalog.seller.id, { rawText: "iPhone 13 n°4" }), pool);
  await wipeOutboxAndJobs();
  await pool.query(`CREATE FUNCTION reject_fourth_job() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF (SELECT count(*) FROM matching_jobs) >= 3 THEN RAISE EXCEPTION 'échec injecté du 4e job' USING ERRCODE = 'P0001'; END IF;
      RETURN NEW;
    END $$`);
  await pool.query("CREATE TRIGGER reject_fourth_job BEFORE INSERT ON matching_jobs FOR EACH ROW EXECUTE FUNCTION reject_fourth_job()");
  const pidOf = async (db: Pool) => (await db.query("SELECT pg_backend_pid() AS pid")).rows[0].pid as number;
  const pid = await pidOf(pool);
  const queries: string[] = [];
  const spy = Object.create(pool) as Pool;
  spy.connect = (async () => {
    const client = await pool.connect();
    const original = client.query.bind(client) as (...a: unknown[]) => unknown;
    (client as { query: unknown }).query = (...args: unknown[]) => {
      const text = typeof args[0] === "string" ? args[0] : (args[0] as { text?: string } | undefined)?.text;
      if (text) queries.push(text);
      return original(...args);
    };
    const release = client.release.bind(client);
    client.release = ((error?: Error | boolean) => { (client as { query: unknown }).query = original; return release(error); }) as never;
    return client;
  }) as never;
  spy.query = ((...args: unknown[]) => (pool.query as (...a: unknown[]) => unknown)(...args)) as never;

  let failed = false;
  try {
    await assert.rejects(runCatalogBootstrap({ pool: spy, batchSize: 2 }), /échec injecté du 4e job/);
    failed = true;
    assert.ok(queries.includes("ROLLBACK"), "un ROLLBACK explicite est émis avant la libération");
    assert.ok(queries.lastIndexOf("ROLLBACK") < queries.findIndex((text) => text.includes("pg_advisory_unlock")), "le ROLLBACK précède le déverrouillage");

    // Lot atomique : seul le lot 0 (2 jobs) est validé ; le 3e job du lot 1 est annulé avec lui.
    assert.equal((await jobs()).length, 2);
    const events = await bootstrapEvents();
    assert.equal(events.length, 1);
    assert.equal(events[0].dispatch_status, "pending");
    assert.equal(events[0].dispatched_at, null);

    // Aucune session « idle in transaction » parmi celles du test, et la connexion est la MÊME : rendue au pool propre.
    assert.equal(await pidOf(pool), pid, "connexion non détruite : le ROLLBACK a nettoyé la transaction");
    const pids = [pid, await pidOf(second)];
    const states = await admin.query("SELECT pid, state FROM pg_stat_activity WHERE pid = ANY($1::int[])", [pids]);
    assert.ok(states.rows.every((row) => !String(row.state).startsWith("idle in transaction")), JSON.stringify(states.rows));
  } finally {
    await pool.query("DROP TRIGGER IF EXISTS reject_fourth_job ON matching_jobs");
    await pool.query("DROP FUNCTION IF EXISTS reject_fourth_job()");
  }
  assert.ok(failed);

  // Reprise immédiate sur le MÊME pool : même événement, aucun doublon, tout est couvert.
  const [pending] = await bootstrapEvents();
  const resumed = await runCatalogBootstrap({ pool, batchSize: 2 });
  assert.equal(resumed.eventId, pending.id, "l'événement pending est réutilisé");
  assert.equal(resumed.jobsInserted, 4, "6 jobs au total : 2 déjà validés, 4 créés");
  assert.equal(resumed.alreadyCovered, 2);
  assert.equal((await jobs()).length, 6);
  assert.equal(new Set((await jobs()).map((job) => job.job_identity)).size, 6);
  const finalEvents = await bootstrapEvents();
  assert.equal(finalEvents.length, 1);
  assert.equal(finalEvents[0].dispatch_status, "projected");
});

// ═════════════ 6. Schéma non prêt ═════════════

test("refus si la migration 0010 n'est pas enregistrée : aucune écriture, aucune migration appliquée", async () => {
  await legacyCatalog();
  const saved = (await pool.query("SELECT * FROM noma_schema_migrations WHERE version = '0010_matching_job_leases'")).rows[0];
  assert.ok(saved);
  await pool.query("DELETE FROM noma_schema_migrations WHERE version = '0010_matching_job_leases'");
  try {
    const before = await snapshotAll();
    const migrationsBefore = (await pool.query("SELECT version FROM noma_schema_migrations ORDER BY version")).rows;
    for (const dryRun of [false, true]) {
      await assert.rejects(runCatalogBootstrap({ pool, dryRun }), (error: unknown) => error instanceof MatchingBootstrapError && /0010_matching_job_leases/.test(error.message));
    }
    assert.deepEqual(await snapshotAll(), before);
    assert.deepEqual((await pool.query("SELECT version FROM noma_schema_migrations ORDER BY version")).rows, migrationsBefore, "aucune migration appliquée");
  } finally {
    await pool.query("INSERT INTO noma_schema_migrations (version, checksum) VALUES ($1, $2)", [saved.version, saved.checksum]);
  }
  // Table de migrations absente : même refus clair.
  await pool.query("ALTER TABLE noma_schema_migrations RENAME TO noma_schema_migrations_off");
  try {
    await assert.rejects(runCatalogBootstrap({ pool }), /Schéma non prêt/);
  } finally {
    await pool.query("ALTER TABLE noma_schema_migrations_off RENAME TO noma_schema_migrations");
  }
  assert.equal((await runCatalogBootstrap({ pool })).jobsInserted, 5, "le verrou a été libéré, le schéma est de nouveau prêt");
});

// ═════════════ 7. Bout en bout ═════════════

test("bout en bout : catalogue sans événements → bootstrap → cycles jusqu'à idle : une évaluation active par paire éligible", async () => {
  const catalog = await legacyCatalog();
  assert.equal((await runCatalogBootstrap({ pool })).jobsInserted, 5);
  let idle = false;
  for (let i = 0; i < 40 && !idle; i++) {
    const cycle = await runMatchingCycle({ pool, workerId: "bootstrap-a" });
    assert.deepEqual(cycle.errors, []);
    idle = cycle.idle;
  }
  assert.ok(idle, "le travail se termine");
  assert.ok((await jobs()).every((job) => job.status === "completed"));

  const expected = new Set<string>();
  for (const offer of catalog.eligibleOffers) {
    for (const demand of catalog.eligibleDemands) if (offer.ownerId !== demand.ownerId) expected.add(`${offer.id}|${demand.id}`);
  }
  assert.equal(expected.size, 3, "o1×db, o2×db, ob×d1 (même propriétaire exclu)");
  const active = (await pool.query(
    `SELECT e.*, o.content_version AS o_version, d.content_version AS d_version
       FROM matching_evaluations e JOIN offers o ON o.id = e.offer_id JOIN demands d ON d.id = e.demand_id
      WHERE e.is_latest`)).rows;
  assert.equal(active.length, expected.size, "ni manquante ni en trop");
  assert.deepEqual(new Set(active.map((row) => `${row.offer_id}|${row.demand_id}`)), expected);
  for (const row of active) {
    assert.equal(row.offer_content_version, row.o_version, "version de l'offre courante");
    assert.equal(row.demand_content_version, row.d_version, "version de la demande courante");
    assert.equal(row.is_stale, false);
  }
  const ineligibleIds = new Set(catalog.ineligible.map((resource) => resource.id));
  assert.ok(active.every((row) => !ineligibleIds.has(row.offer_id) && !ineligibleIds.has(row.demand_id)), "aucune évaluation active sur une paire inéligible");
});

// ═════════════ Validation ═════════════

test("validation avant SQL : pool, batchSize et dryRun invalides → zéro requête", async () => {
  const { spy, count } = observed();
  for (const bad of [undefined, null, {}, { query: async () => ({ rows: [] }), connect: async () => ({}) }]) {
    await assert.rejects(runCatalogBootstrap({ pool: bad as never }), MatchingBootstrapError);
  }
  for (const batchSize of [0, -1, 501, 1.5, Number.NaN, "10", null]) {
    await assert.rejects(runCatalogBootstrap({ pool: spy, batchSize: batchSize as never }), MatchingBootstrapError, String(batchSize));
  }
  for (const dryRun of ["true", 1, null, {}]) {
    await assert.rejects(runCatalogBootstrap({ pool: spy, dryRun: dryRun as never }), MatchingBootstrapError, String(dryRun));
  }
  assert.equal(count(), 0);
});

// ═════════════ 8. Script réel ═════════════

test("script matching-bootstrap sur un schéma temporaire : simulation sans écriture, --apply crée les jobs, relance sans doublon", async () => {
  await legacyCatalog();
  const before = await snapshotAll();
  const dry = await runScript("scripts/matching-bootstrap.ts", [], schema);
  assert.equal(dry.code, 0, dry.output);
  assert.match(dry.output, /\(simulation, rien n'est écrit\) : 3 offre\(s\) et 2 demande\(s\) éligibles parcourues, 5 job\(s\) à créer, 0 déjà couverte\(s\)\./);
  assert.match(dry.output, /--apply/);
  assert.deepEqual(await snapshotAll(), before, "0 écriture en simulation");

  const applied = await runScript("scripts/matching-bootstrap.ts", ["--apply"], schema);
  assert.equal(applied.code, 0, applied.output);
  assert.match(applied.output, /appliqué : 3 offre\(s\) et 2 demande\(s\) éligibles parcourues, 5 job\(s\) créé\(s\), 0 déjà couverte\(s\)\./);
  assert.equal((await jobs()).length, 5);

  const again = await runScript("scripts/matching-bootstrap.ts", ["--apply"], schema);
  assert.equal(again.code, 0, again.output);
  assert.match(again.output, /0 job\(s\) créé\(s\), 5 déjà couverte\(s\)/);
  assert.equal((await jobs()).length, 5);

  // Schéma non prêt : code 1, message clair et fixe, aucune écriture.
  const saved = (await pool.query("SELECT * FROM noma_schema_migrations WHERE version = '0010_matching_job_leases'")).rows[0];
  await pool.query("DELETE FROM noma_schema_migrations WHERE version = '0010_matching_job_leases'");
  try {
    const refused = await runScript("scripts/matching-bootstrap.ts", ["--apply"], schema);
    assert.equal(refused.code, 1, refused.output);
    assert.match(refused.output, /Matching bootstrap : Schéma non prêt/);
  } finally {
    await pool.query("INSERT INTO noma_schema_migrations (version, checksum) VALUES ($1, $2)", [saved.version, saved.checksum]);
  }
  assert.equal((await jobs()).length, 5);
});
