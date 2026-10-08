import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { before, after, test } from "node:test";
import { Pool } from "pg";
import {
  createUser, updateUser, archiveUser, createOffer, updateOffer, publishOffer, pauseOffer,
  createDemand, updateDemand, activateDemand, satisfyDemand, archiveDemand,
} from "../../lib/server/catalog";
import {
  OUTBOX_COLUMNS, OutboxValidationError, mapOutboxRow, recordOutboxEvent,
  type OutboxEventRecord, type OutboxRow,
} from "../../lib/server/matching/outbox";
import {
  MatchingProjectionError, PROJECTABLE_EVENT_TYPES,
  computeJobIdentity, planOutboxProjection, projectOutboxBatch,
} from "../../lib/server/matching/projection";
import { computeScoringConfigHash, normalizeScoringConfig } from "../../lib/server/matching/persistence";
import { withPostgresTransaction } from "../../lib/server/postgres/client";
import { runMigrations } from "../../lib/server/postgres/migrations";
import {
  openVerifiedTestDatabase, openVerifiedIsolatedPool, createTemporarySchemaName, quoteTemporarySchema,
} from "./test-database";

let admin: Pool, pool: Pool, second: Pool;
const schema = createTemporarySchemaName();
const quoted = quoteTemporarySchema(schema);
const DEFAULT_HASH = computeScoringConfigHash(normalizeScoringConfig());

before(async () => {
  const opened = await openVerifiedTestDatabase(process.env.TEST_DATABASE_URL);
  admin = opened.pool;
  await admin.query(`CREATE SCHEMA ${quoted}`);
  pool = await openVerifiedIsolatedPool(opened.target, schema);
  second = await openVerifiedIsolatedPool(opened.target, schema);
  const first = await runMigrations(pool);
  assert.equal(first.applied.length, 25);
  assert.ok(first.applied.includes("0009_matching_projection"));
  assert.equal(first.applied.at(-1), "0025_external_collection");
  const rerun = await runMigrations(pool);
  assert.deepEqual(rerun.applied, []);
  assert.equal(rerun.skipped.length, 25);
  await pool.query(`CREATE FUNCTION reject_audit_job() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'audit job failure'; END $$`);
});

after(async () => {
  if (second) await second.end();
  if (pool) await pool.end();
  if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${quoted} CASCADE`); await admin.end(); }
});

async function clean() {
  await pool.query("DELETE FROM matching_jobs");
  await pool.query("DELETE FROM matching_outbox_events");
}

async function allEvents(): Promise<OutboxEventRecord[]> {
  const result = await pool.query<OutboxRow>(
    `SELECT ${OUTBOX_COLUMNS} FROM matching_outbox_events ORDER BY occurred_at, id`);
  return result.rows.map(mapOutboxRow);
}

async function eventById(id: string): Promise<OutboxEventRecord> {
  const result = await pool.query<OutboxRow>(`SELECT ${OUTBOX_COLUMNS} FROM matching_outbox_events WHERE id = $1`, [id]);
  return mapOutboxRow(result.rows[0]);
}

const jobsFor = async (sourceEventId: string) =>
  (await pool.query("SELECT * FROM matching_jobs WHERE source_event_id = $1", [sourceEventId])).rows;
const jobCount = async () => Number((await pool.query("SELECT count(*) AS n FROM matching_jobs")).rows[0].n);
const pendingCount = async () =>
  Number((await pool.query("SELECT count(*) AS n FROM matching_outbox_events WHERE dispatch_status = 'pending'")).rows[0].n);

/** Génère n offres publiées, donc n événements offer.created projetables. */
async function seedPublishedOffers(count: number) {
  const user = await createUser({}, pool);
  const offers = [];
  for (let i = 0; i < count; i++) offers.push(await createOffer({ ownerId: user.id, rawText: `iPhone ${i}`, status: "published" }, pool));
  return { user, offers };
}

function barrier(parties: number) {
  let arrived = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("barrière non atteinte")), 8000));
  return async () => { if (++arrived === parties) release(); await Promise.race([gate, timeout]); };
}

const CHECK_BASE = "INSERT INTO matching_outbox_events(event_type, aggregate_type, aggregate_id, aggregate_version, payload";

test("migration 0009 : contraintes outbox et jobs rejetant chacune leur cas", async () => {
  await clean();
  const id = randomUUID();
  const rejected = (sql: string, args: unknown[], pattern: RegExp) => assert.rejects(pool.query(sql, args), pattern);
  await rejected(`${CHECK_BASE}, dispatched_at) VALUES('offer.created','offer',$1,1,'{}'::jsonb, now())`, [id], /chk_outbox_dispatch_coherence/);
  await rejected(`${CHECK_BASE}, dispatch_status) VALUES('offer.created','offer',$1,1,'{}'::jsonb,'projected')`, [id], /chk_outbox_dispatch_coherence/);
  await rejected(`${CHECK_BASE}, dispatch_status, dispatched_at, error_message)
    VALUES('offer.created','offer',$1,1,'{}'::jsonb,'projected', now(), 'x')`, [id], /chk_outbox_error_message_ignored/);
  await rejected(`${CHECK_BASE}, error_message) VALUES('offer.created','offer',$1,1,'{}'::jsonb,'x')`, [id], /chk_outbox_error_message_ignored/);
  await rejected(`${CHECK_BASE}) VALUES('user.suspended','user',$1,NULL,'{}'::jsonb)`, [id], /chk_outbox_user_version/);
  // Acquittements légitimes acceptés.
  await pool.query(`${CHECK_BASE}, dispatch_status, dispatched_at, error_message)
    VALUES('offer.created','offer',$1,7,'{}'::jsonb,'ignored', now(), 'invalid')`, [randomUUID()]);
  // Une seule ligne par version d'agrégat versionné, y compris pour un compte.
  for (const [type, kind] of [["offer.created", "offer"], ["demand.created", "demand"], ["user.suspended", "user"]]) {
    const aggregateId = randomUUID();
    const insert = `${CHECK_BASE}) VALUES('${type}','${kind}',$1,2,'{}'::jsonb)`;
    await pool.query(insert, [aggregateId]);
    await rejected(insert, [aggregateId], /uq_matching_outbox_aggregate_version/);
    await pool.query(insert, [randomUUID()]);
  }
  // Les agrégats non versionnés ne sont pas concernés par l'unicité.
  const temporalId = randomUUID();
  for (let i = 0; i < 2; i++) await pool.query("INSERT INTO matching_outbox_events(event_type,aggregate_type,aggregate_id) VALUES('temporal.deadline_passed','temporal',$1)", [temporalId]);
  const job = "INSERT INTO matching_jobs(job_identity,job_type,resource_id,resource_version) VALUES($1,'evaluate_offer_candidates',$2,1)";
  for (const bad of ["x".repeat(64), "A".repeat(64), "a".repeat(63), "a".repeat(65), randomUUID()]) {
    await rejected(job, [bad, id], /chk_matching_jobs_identity_format/);
  }
  await pool.query(job, ["a".repeat(64), id]);
  const index = await pool.query("SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND indexname = 'idx_matching_jobs_source_event'", [schema]);
  assert.equal(index.rowCount, 1);
});

test("computeJobIdentity : vecteur indépendant, sept composantes et validation", () => {
  const base = {
    generation: 3, jobType: "evaluate_demand_candidates",
    resourceId: "11111111-1111-4111-8111-111111111111", resourceVersion: 5,
    scoringConfigHash: "ab".repeat(32), sourceEventId: "22222222-2222-4222-8222-222222222222",
    targetResourceId: null as string | null,
  };
  const literal = '{"generation":3,"job_type":"evaluate_demand_candidates",'
    + '"resource_id":"11111111-1111-4111-8111-111111111111","resource_version":5,'
    + `"scoring_config_hash":"${"ab".repeat(32)}","source_event_id":"22222222-2222-4222-8222-222222222222",`
    + '"target_resource_id":null}';
  const expected = createHash("sha256").update(literal).digest("hex");
  assert.equal(computeJobIdentity(base), expected);
  assert.equal(computeJobIdentity(base), expected);
  assert.equal(computeJobIdentity({ ...base, targetResourceId: undefined }), expected);
  const variants = [
    { ...base, generation: 4 },
    { ...base, jobType: "evaluate_offer_candidates" },
    { ...base, resourceId: "33333333-3333-4333-8333-333333333333" },
    { ...base, resourceVersion: 6 },
    { ...base, scoringConfigHash: "cd".repeat(32) },
    { ...base, sourceEventId: "44444444-4444-4444-8444-444444444444" },
    { ...base, targetResourceId: "55555555-5555-4555-8555-555555555555" },
  ].map(computeJobIdentity);
  assert.equal(new Set([expected, ...variants]).size, 8);
  for (const bad of [
    { generation: 0 }, { generation: 2147483648 }, { generation: 1.5 }, { resourceVersion: 0 },
    { resourceId: "nope" }, { sourceEventId: "nope" }, { targetResourceId: "nope" },
    { scoringConfigHash: "ab".repeat(31) }, { scoringConfigHash: "AB".repeat(32) }, { jobType: "unknown" },
  ]) {
    assert.throws(() => computeJobIdentity({ ...base, ...bad }), MatchingProjectionError);
  }
});

test("bout en bout avec les services catalogue : jobs attendus, champs issus du payload, événements acquittés", async () => {
  await clean();
  const seller = await createUser({}, pool), buyer = await createUser({}, pool), third = await createUser({}, pool);
  const offerA = await createOffer({ ownerId: seller.id, rawText: "iPhone 12", status: "published" }, pool);
  const demandA = await createDemand({ ownerId: buyer.id, rawText: "iPhone 12", status: "active" }, pool);
  let offerB = await createOffer({ ownerId: seller.id, rawText: "Samsung S21" }, pool);
  offerB = await publishOffer(seller.id, offerB.id, offerB.contentVersion, pool);
  const offer = await updateOffer({ id: offerA.id, ownerId: seller.id, expectedContentVersion: 1, changes: { quantity: 2 } }, pool);
  let demand = await updateDemand({ id: demandA.id, ownerId: buyer.id, expectedContentVersion: 1, changes: { quantity: 2 } }, pool);
  await pauseOffer(seller.id, offer.id, offer.contentVersion, pool);
  demand = await satisfyDemand(buyer.id, demand.id, demand.contentVersion, pool);
  demand = await activateDemand(buyer.id, demand.id, demand.contentVersion, pool);
  // Offre publiée mais indisponible : l'édition suivante est éligible=false.
  let offerC = await createOffer({ ownerId: seller.id, rawText: "Pixel 8", status: "published" }, pool);
  offerC = await updateOffer({ id: offerC.id, ownerId: seller.id, expectedContentVersion: 1, changes: { availabilityStatus: "unavailable" } }, pool);
  await updateOffer({ id: offerC.id, ownerId: seller.id, expectedContentVersion: offerC.contentVersion, changes: { category: "phones" } }, pool);
  let account = await updateUser({ id: third.id, expectedVersion: 1, status: "suspended" }, pool);
  account = await updateUser({ id: third.id, expectedVersion: account.version, status: "active" }, pool);
  await archiveDemand(buyer.id, demand.id, demand.contentVersion, pool);

  const events = await allEvents();
  const eligibleFalse = events.filter((event) => event.payload.eligible === false);
  assert.ok(eligibleFalse.some((event) => event.eventType === "offer.updated" && event.payload.status === "published" && event.payload.availability_status === "unavailable"));
  assert.ok(events.every((event) => event.dispatchStatus === "pending"));

  const result = await projectOutboxBatch({ pool });
  assert.equal(result.selected, events.length);
  assert.equal(result.invalid, 0);
  assert.equal(result.jobsAlreadyPresent, 0);
  assert.equal(result.projected, result.jobsInserted);
  assert.equal(result.projected + result.ignored, events.length);
  assert.equal(await pendingCount(), 0);

  const searchJobs: Record<string, string> = {
    "offer.created": "evaluate_offer_candidates", "offer.published": "evaluate_offer_candidates",
    "offer.available": "evaluate_offer_candidates", "offer.updated": "evaluate_offer_candidates",
    "demand.created": "evaluate_demand_candidates", "demand.activated": "evaluate_demand_candidates",
    "demand.updated": "evaluate_demand_candidates", "user.reactivated": "user_reactivation_sweep",
  };
  let expectedJobs = 0;
  for (const original of events) {
    const event = await eventById(original.id);
    const jobs = await jobsFor(event.id);
    assert.ok(event.dispatchedAt instanceof Date);
    assert.equal(event.errorMessage, null);
    const jobType = searchJobs[event.eventType];
    if (jobType && event.payload.eligible !== false) {
      expectedJobs++;
      assert.equal(event.dispatchStatus, "projected");
      assert.equal(jobs.length, 1);
      const [row] = jobs;
      assert.equal(row.job_type, jobType);
      assert.equal(row.resource_id, event.aggregateId);
      assert.equal(row.resource_version, event.aggregateVersion);
      assert.equal(row.target_resource_id, null);
      assert.equal(row.scoring_config_hash, event.payload.scoring_config_hash);
      assert.equal(row.scoring_config_hash, DEFAULT_HASH);
      assert.equal(row.source_event_id, event.id);
      assert.equal(row.status, "pending");
      assert.equal(row.job_identity, computeJobIdentity({
        generation: event.payload.generation as number, jobType, resourceId: event.aggregateId,
        resourceVersion: event.aggregateVersion as number, scoringConfigHash: DEFAULT_HASH, sourceEventId: event.id,
      }));
    } else {
      assert.equal(event.dispatchStatus, "ignored");
      assert.equal(jobs.length, 0);
    }
  }
  assert.equal(await jobCount(), expectedJobs);
  // 2 offres + 3 demandes + offre publiée après brouillon + offre C créée + réactivation du compte.
  assert.equal(expectedJobs, 8);
  const kinds = events.map((event) => event.eventType);
  for (const type of ["offer.paused", "offer.unavailable", "demand.satisfied", "demand.archived", "user.suspended"]) {
    assert.ok(kinds.includes(type as never), type);
  }
  const reactivation = events.find((event) => event.eventType === "user.reactivated")!;
  assert.equal((await jobsFor(reactivation.id))[0].resource_id, third.id);
  assert.equal((await jobsFor(reactivation.id))[0].resource_version, account.version);
  assert.equal(offerB.status, "published");
});

test("rejeu : job complété inchangé, aucun doublon, événement reprojeté", async () => {
  await clean();
  const { offers: [offer] } = await seedPublishedOffers(1);
  const [event] = await allEvents();
  assert.equal(event.aggregateId, offer.id);
  assert.deepEqual(await projectOutboxBatch({ pool }), { selected: 1, projected: 1, jobsInserted: 1, jobsAlreadyPresent: 0, ignored: 0, invalid: 0 });
  await pool.query("UPDATE matching_jobs SET status = 'completed', completed_at = clock_timestamp(), attempts = 1 WHERE source_event_id = $1", [event.id]);
  const snapshot = async () => (await pool.query("SELECT to_jsonb(j) AS row FROM matching_jobs j WHERE source_event_id = $1", [event.id])).rows[0].row;
  const before = await snapshot();
  await pool.query("UPDATE matching_outbox_events SET dispatch_status = 'pending', dispatched_at = NULL WHERE id = $1", [event.id]);
  assert.deepEqual(await projectOutboxBatch({ pool }), { selected: 1, projected: 1, jobsInserted: 0, jobsAlreadyPresent: 1, ignored: 0, invalid: 0 });
  assert.equal(await jobCount(), 1);
  assert.deepEqual(await snapshot(), before);
  assert.equal((await eventById(event.id)).dispatchStatus, "projected");
});

test("configuration scellée : le job porte le hash du payload, jamais les défauts courants", async () => {
  await clean();
  const { offers: [sealedOffer, forgedOffer] } = await seedPublishedOffers(2);
  const events = await allEvents();
  const sealedEvent = events.find((event) => event.aggregateId === sealedOffer.id)!;
  const forgedEvent = events.find((event) => event.aggregateId === forgedOffer.id)!;
  const customConfig = { defaultWeight: 7, precision: 3, weights: { price: 2 } };
  const customHash = computeScoringConfigHash(customConfig);
  assert.notEqual(customHash, DEFAULT_HASH);
  await pool.query("UPDATE matching_outbox_events SET payload = $2::jsonb WHERE id = $1", [
    sealedEvent.id, JSON.stringify({ ...sealedEvent.payload, scoring_config: customConfig, scoring_config_hash: customHash }),
  ]);
  // Configuration modifiée mais hash resté sur les défauts : incohérent.
  await pool.query("UPDATE matching_outbox_events SET payload = $2::jsonb WHERE id = $1", [
    forgedEvent.id, JSON.stringify({ ...forgedEvent.payload, scoring_config: customConfig }),
  ]);
  const result = await projectOutboxBatch({ pool });
  assert.deepEqual(result, { selected: 2, projected: 1, jobsInserted: 1, jobsAlreadyPresent: 0, ignored: 0, invalid: 1 });
  const [job] = await jobsFor(sealedEvent.id);
  assert.equal(job.scoring_config_hash, customHash);
  assert.equal(await jobCount(), 1);
  const forged = await eventById(forgedEvent.id);
  assert.equal(forged.dispatchStatus, "ignored");
  assert.equal(forged.errorMessage, "scoring_config_hash_mismatch");
  assert.equal((await jobsFor(forgedEvent.id)).length, 0);
});

test("payloads invalides : acquittés ignored avec code, le lot continue", async () => {
  await clean();
  const { offers } = await seedPublishedOffers(5);
  const events = await allEvents();
  const byOffer = (index: number) => events.find((event) => event.aggregateId === offers[index].id)!;
  const rewrite = (index: number, payload: Record<string, unknown>) =>
    pool.query("UPDATE matching_outbox_events SET payload = $2::jsonb WHERE id = $1", [byOffer(index).id, JSON.stringify(payload)]);
  const { scoring_config_hash: _omitted, ...withoutHash } = byOffer(3).payload;
  void _omitted;
  await rewrite(0, { ...byOffer(0).payload, generation: 99 });
  await rewrite(1, { ...byOffer(1).payload, eligible: "yes" });
  await rewrite(2, { ...byOffer(2).payload, status: "paused", eligible: true });
  await rewrite(3, withoutHash);
  const result = await projectOutboxBatch({ pool });
  assert.deepEqual(result, { selected: 5, projected: 1, jobsInserted: 1, jobsAlreadyPresent: 0, ignored: 0, invalid: 4 });
  const expectedCodes = ["generation_mismatch", "invalid_eligibility_flag", "eligibility_status_mismatch", "invalid_scoring_config_hash"];
  for (let i = 0; i < 4; i++) {
    const event = await eventById(byOffer(i).id);
    assert.equal(event.dispatchStatus, "ignored");
    assert.equal(event.errorMessage, expectedCodes[i]);
    assert.ok(event.dispatchedAt);
    assert.equal((await jobsFor(event.id)).length, 0);
  }
  const valid = await eventById(byOffer(4).id);
  assert.equal(valid.dispatchStatus, "projected");
  assert.equal((await jobsFor(valid.id)).length, 1);
  assert.equal(await pendingCount(), 0);
  // La décision pure ne recopie jamais le contenu du payload.
  const decision = planOutboxProjection({ ...byOffer(1), payload: { ...byOffer(1).payload, eligible: "SECRET-PAYLOAD" } });
  assert.ok(!JSON.stringify(decision).includes("SECRET-PAYLOAD"));
});

test("planOutboxProjection : un type de prototype est un type non supporté, jamais un agrégat incohérent", async () => {
  await clean();
  await seedPublishedOffers(1);
  const [event] = await allEvents();
  for (const eventType of ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"]) {
    assert.deepEqual(
      planOutboxProjection({ ...event, eventType: eventType as never }),
      { kind: "invalid", code: "unsupported_event_type" },
      eventType,
    );
  }
  assert.equal(planOutboxProjection(event).kind, "job");
});

test("événements scoring et bootstrap : non sélectionnés, restent pending (temporal est projetable depuis 2E4C2)", async () => {
  await clean();
  const unsupported: [string, string][] = [
    ["scoring_config.updated", "system"], ["catalog.bootstrap_sync", "system"],
  ];
  const ids: string[] = [];
  for (const [eventType, aggregateType] of unsupported) {
    const id = randomUUID();
    ids.push(id);
    await pool.query("INSERT INTO matching_outbox_events(id,event_type,aggregate_type,aggregate_id) VALUES($1,$2,$3,$4)", [id, eventType, aggregateType, randomUUID()]);
  }
  for (const type of unsupported.map(([eventType]) => eventType)) {
    assert.ok(!PROJECTABLE_EVENT_TYPES.includes(type as never), type);
  }
  await seedPublishedOffers(1);
  const result = await projectOutboxBatch({ pool });
  assert.deepEqual(result, { selected: 1, projected: 1, jobsInserted: 1, jobsAlreadyPresent: 0, ignored: 0, invalid: 0 });
  for (const id of ids) {
    const event = await eventById(id);
    assert.equal(event.dispatchStatus, "pending");
    assert.equal(event.dispatchedAt, null);
    assert.equal(event.errorMessage, null);
    assert.equal((await jobsFor(id)).length, 0);
  }
  assert.equal(await pendingCount(), 2);
  assert.equal((await projectOutboxBatch({ pool })).selected, 0);
});

test("concurrence : deux pools sur le même lot traitent des ensembles disjoints sans doublon", async () => {
  await clean();
  const total = 12;
  await seedPublishedOffers(total);
  const everyId = (await allEvents()).map((event) => event.id);
  const meet = barrier(2);
  const seen: string[][] = [[], []];
  const run = (db: Pool, index: number) => projectOutboxBatch({
    pool: db, limit: 6,
    hooks: { afterSelect: async (events) => { seen[index] = events.map((event) => event.id); await meet(); } },
  });
  const [first, other] = await Promise.all([run(pool, 0), run(second, 1)]);
  assert.equal(first.selected, seen[0].length);
  assert.equal(other.selected, seen[1].length);
  assert.equal(seen[0].filter((id) => seen[1].includes(id)).length, 0);
  assert.deepEqual([...seen[0], ...seen[1]].sort(), [...everyId].sort());
  assert.equal(first.jobsInserted + other.jobsInserted, total);
  assert.equal(await jobCount(), total);
  assert.equal(await pendingCount(), 0);
  const duplicates = await pool.query("SELECT source_event_id FROM matching_jobs GROUP BY source_event_id HAVING count(*) > 1");
  assert.equal(duplicates.rowCount, 0);
});

test("atomicité : échec d'insertion de job ou erreur après un premier job annule tout le lot", async () => {
  await clean();
  await seedPublishedOffers(3);
  await pool.query("CREATE TRIGGER reject_audit_job BEFORE INSERT ON matching_jobs FOR EACH ROW EXECUTE FUNCTION reject_audit_job()");
  try { await assert.rejects(projectOutboxBatch({ pool }), /audit job failure/); }
  finally { await pool.query("DROP TRIGGER reject_audit_job ON matching_jobs"); }
  assert.equal(await jobCount(), 0);
  assert.equal(await pendingCount(), 3);

  let acknowledged = 0;
  await assert.rejects(projectOutboxBatch({
    pool,
    hooks: { beforeAcknowledge: async () => { if (++acknowledged === 2) throw new Error("hook failure after first insert"); } },
  }), /hook failure after first insert/);
  assert.equal(acknowledged, 2);
  assert.equal(await jobCount(), 0);
  assert.equal(await pendingCount(), 3);
  assert.equal((await pool.query("SELECT 1 FROM matching_outbox_events WHERE dispatched_at IS NOT NULL")).rowCount, 0);

  // Les verrous sont libérés par le rollback : une projection normale réussit ensuite.
  assert.equal((await projectOutboxBatch({ pool })).jobsInserted, 3);
});

test("divergence d'un job existant : l'événement fautif est mis en quarantaine, le job est intact, le reste du lot est projeté", async () => {
  await clean();
  await seedPublishedOffers(3);
  const events = await allEvents();
  const poisoned = events[1];
  const decision = planOutboxProjection(poisoned);
  assert.equal(decision.kind, "job");
  if (decision.kind !== "job") return;
  await pool.query(
    "INSERT INTO matching_jobs(job_identity,job_type,resource_id,resource_version,scoring_config_hash,source_event_id) VALUES($1,$2,$3,$4,$5,$6)",
    [decision.job.jobIdentity, decision.job.jobType, decision.job.resourceId, decision.job.resourceVersion + 1, decision.job.scoringConfigHash, decision.job.sourceEventId],
  );
  const divergent = async () => (await pool.query("SELECT * FROM matching_jobs WHERE job_identity = $1", [decision.job.jobIdentity])).rows;
  const before = await divergent();
  assert.equal(before.length, 1);

  const result = await projectOutboxBatch({ pool });
  assert.deepEqual(result, { selected: 3, projected: 2, jobsInserted: 2, jobsAlreadyPresent: 0, ignored: 0, invalid: 0, quarantined: 1 });

  const quarantined = await eventById(poisoned.id);
  assert.equal(quarantined.dispatchStatus, "ignored");
  assert.equal(quarantined.errorMessage, "job_integrity_conflict");
  assert.notEqual(quarantined.dispatchedAt, null);
  assert.deepEqual(await divergent(), before, "le job divergent n'est jamais modifié");

  for (const event of [events[0], events[2]]) {
    const projected = await eventById(event.id);
    assert.equal(projected.dispatchStatus, "projected");
    assert.equal(projected.errorMessage, null);
    assert.equal((await jobsFor(event.id)).length, 1);
  }
  assert.equal(await jobCount(), 3, "le job divergent et deux jobs projetés");
  assert.equal(await pendingCount(), 0);
  // Plus rien à rejouer : la quarantaine est un acquittement, pas une relance.
  assert.deepEqual(await projectOutboxBatch({ pool }), { selected: 0, projected: 0, jobsInserted: 0, jobsAlreadyPresent: 0, ignored: 0, invalid: 0 });
});

test("erreur SQL sans lien avec l'intégrité : le lot entier est annulé, aucune quarantaine, même avec un événement empoisonné", async () => {
  await clean();
  await seedPublishedOffers(3);
  const events = await allEvents();
  const decision = planOutboxProjection(events[1]);
  assert.equal(decision.kind, "job");
  if (decision.kind !== "job") return;
  await pool.query(
    "INSERT INTO matching_jobs(job_identity,job_type,resource_id,resource_version,scoring_config_hash,source_event_id) VALUES($1,$2,$3,$4,$5,$6)",
    [decision.job.jobIdentity, decision.job.jobType, decision.job.resourceId, decision.job.resourceVersion + 1, decision.job.scoringConfigHash, decision.job.sourceEventId],
  );
  const noQuarantine = async () => {
    assert.equal(await jobCount(), 1, "aucun job créé");
    assert.equal(await pendingCount(), 3, "aucun événement acquitté");
    assert.equal((await pool.query("SELECT 1 FROM matching_outbox_events WHERE error_message IS NOT NULL OR dispatched_at IS NOT NULL")).rowCount, 0);
  };

  // Erreur à l'INSERT d'un job (le trigger se déclenche aussi avant la détection du conflit).
  await pool.query("CREATE TRIGGER reject_audit_job BEFORE INSERT ON matching_jobs FOR EACH ROW EXECUTE FUNCTION reject_audit_job()");
  try { await assert.rejects(projectOutboxBatch({ pool }), /audit job failure/); }
  finally { await pool.query("DROP TRIGGER reject_audit_job ON matching_jobs"); }
  await noQuarantine();

  // Erreur à l'acquittement d'un événement.
  await pool.query("CREATE TRIGGER reject_audit_ack BEFORE UPDATE ON matching_outbox_events FOR EACH ROW EXECUTE FUNCTION reject_audit_job()");
  try { await assert.rejects(projectOutboxBatch({ pool }), /audit job failure/); }
  finally { await pool.query("DROP TRIGGER reject_audit_ack ON matching_outbox_events"); }
  await noQuarantine();
});

test("validation avant SQL : limit, pool, client et exécuteur arbitraire refusés sans requête", async () => {
  await clean();
  let queries = 0;
  const spy = Object.create(pool) as Pool;
  spy.connect = ((...args: unknown[]) => { queries++; return (pool.connect as (...a: unknown[]) => unknown)(...args); }) as never;
  spy.query = ((...args: unknown[]) => { queries++; return (pool.query as (...a: unknown[]) => unknown)(...args); }) as never;
  for (const limit of [0, -1, 101, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "5" as never]) {
    await assert.rejects(projectOutboxBatch({ pool: spy, limit }), MatchingProjectionError);
  }
  assert.equal(queries, 0);
  const client = await pool.connect();
  const original = client.query.bind(client);
  (client as unknown as { query: unknown }).query = (...args: unknown[]) => { queries++; return (original as (...a: unknown[]) => unknown)(...args); };
  try {
    await assert.rejects(projectOutboxBatch({ pool: client as never }), MatchingProjectionError);
  } finally { client.release(); }
  const arbitrary = { query: async () => { queries++; throw new Error("unexpected"); } };
  await assert.rejects(projectOutboxBatch({ pool: arbitrary as never }), MatchingProjectionError);
  const duck = { query: arbitrary.query, connect: async () => { queries++; throw new Error("unexpected"); } };
  await assert.rejects(projectOutboxBatch({ pool: duck as never }), MatchingProjectionError);
  await assert.rejects(projectOutboxBatch({ pool: undefined as never }), MatchingProjectionError);
  assert.equal(queries, 0);
  // Les bornes sont acceptées.
  assert.equal((await projectOutboxBatch({ pool, limit: 1 })).selected, 0);
  assert.equal((await projectOutboxBatch({ pool, limit: 100 })).selected, 0);
});

test("recordOutboxEvent : génération alignée sur la version et version de compte obligatoire", async () => {
  await clean();
  await withPostgresTransaction(async (tx) => {
    let queries = 0;
    const query = tx.query.bind(tx);
    (tx as unknown as { query: unknown }).query = (...args: unknown[]) => { queries++; return (query as (...a: unknown[]) => unknown)(...args); };
    const offer = { eventType: "offer.updated" as const, aggregateType: "offer" as const, aggregateId: randomUUID(), aggregateVersion: 3 };
    const user = { eventType: "user.reactivated" as const, aggregateType: "user" as const, aggregateId: randomUUID(), aggregateVersion: 4 };
    await assert.rejects(recordOutboxEvent(tx, { ...offer, payload: { generation: 2 } }), OutboxValidationError);
    await assert.rejects(recordOutboxEvent(tx, { ...offer, payload: { generation: "3" } }), OutboxValidationError);
    await assert.rejects(recordOutboxEvent(tx, { ...user, payload: { generation: 5 } }), OutboxValidationError);
    await assert.rejects(recordOutboxEvent(tx, { ...user, aggregateVersion: undefined }), OutboxValidationError);
    await assert.rejects(recordOutboxEvent(tx, { ...user, aggregateVersion: null }), OutboxValidationError);
    await assert.rejects(recordOutboxEvent(tx, { ...user, aggregateVersion: 0 }), OutboxValidationError);
    assert.equal(queries, 0);
    const okOffer = await recordOutboxEvent(tx, { ...offer, payload: { generation: 3 } });
    assert.equal(okOffer.payload.generation, 3);
    const okUser = await recordOutboxEvent(tx, user);
    assert.equal(okUser.payload.generation, 4);
    assert.equal(okUser.aggregateVersion, 4);
  }, pool);
});

test("versions successives et réactivations répétées : jobs distincts", async () => {
  await clean();
  const owner = await createUser({}, pool);
  const offer = await createOffer({ ownerId: owner.id, rawText: "iPhone 12", status: "published" }, pool);
  await projectOutboxBatch({ pool });
  const updated = await updateOffer({ id: offer.id, ownerId: owner.id, expectedContentVersion: 1, changes: { quantity: 3 } }, pool);
  assert.equal(updated.contentVersion, 2);
  let account = owner;
  for (const status of ["suspended", "active", "suspended", "active"] as const) {
    account = await updateUser({ id: owner.id, expectedVersion: account.version, status }, pool);
  }
  const result = await projectOutboxBatch({ pool });
  assert.equal(result.jobsInserted, 3);
  assert.equal(result.ignored, 2);
  const offerJobs = (await pool.query("SELECT * FROM matching_jobs WHERE resource_id = $1 ORDER BY resource_version", [offer.id])).rows;
  assert.deepEqual(offerJobs.map((job) => job.resource_version), [1, 2]);
  assert.notEqual(offerJobs[0].job_identity, offerJobs[1].job_identity);
  const userJobs = (await pool.query("SELECT * FROM matching_jobs WHERE resource_id = $1 ORDER BY resource_version", [owner.id])).rows;
  assert.deepEqual(userJobs.map((job) => job.resource_version), [3, 5]);
  assert.notEqual(userJobs[0].job_identity, userJobs[1].job_identity);
  assert.equal(await jobCount(), 4);
  assert.equal(await pendingCount(), 0);
  await archiveUser(owner.id, account.version, pool);
  assert.equal((await projectOutboxBatch({ pool })).ignored, 1);
  assert.equal(await jobCount(), 4);
});
