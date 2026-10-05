import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { before, after, test } from "node:test";
import { Pool } from "pg";
import { createUser, createOffer, updateUser } from "../../lib/server/catalog";
import {
  MatchingJobValidationError, claimMatchingJobs, failMatchingJob, heartbeatMatchingJob,
  runMatchingJobMaintenance, supersedeMatchingJob, type JobLease,
} from "../../lib/server/matching/jobs";
import { projectOutboxBatch } from "../../lib/server/matching/projection";
import { runMigrations } from "../../lib/server/postgres/migrations";
import {
  openVerifiedTestDatabase, openVerifiedIsolatedPool, createTemporarySchemaName, quoteTemporarySchema,
} from "./test-database";

let admin: Pool, pool: Pool, second: Pool, third: Pool;
const schema = createTemporarySchemaName();
const quoted = quoteTemporarySchema(schema);
const FIXED_MAINTENANCE_ERROR = "Tentatives maximales autorisées épuisées ou bail expiré.";

before(async () => {
  const opened = await openVerifiedTestDatabase(process.env.TEST_DATABASE_URL);
  admin = opened.pool;
  await admin.query(`CREATE SCHEMA ${quoted}`);
  pool = await openVerifiedIsolatedPool(opened.target, schema);
  second = await openVerifiedIsolatedPool(opened.target, schema);
  third = await openVerifiedIsolatedPool(opened.target, schema);
  const first = await runMigrations(pool);
  assert.equal(first.applied.length, 13);
  assert.equal(first.applied.at(-1), "0013_boost_exposures");
  const rerun = await runMigrations(pool);
  assert.deepEqual(rerun.applied, []);
  assert.equal(rerun.skipped.length, 13);
});

after(async () => {
  for (const db of [third, second, pool]) if (db) await db.end();
  if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${quoted} CASCADE`); await admin.end(); }
});

async function clean() {
  await pool.query("DELETE FROM matching_jobs");
  await pool.query("DELETE FROM matching_outbox_events");
}

/** Crée n jobs pending avec les vrais services catalogue puis la projection 2E3A. */
async function seedJobs(count: number): Promise<string[]> {
  await clean();
  const user = await createUser({}, pool);
  for (let i = 0; i < count; i++) await createOffer({ ownerId: user.id, rawText: `iPhone ${i}`, status: "published" }, pool);
  const projected = await projectOutboxBatch({ pool, limit: 100 });
  assert.equal(projected.jobsInserted, count);
  return (await pool.query("SELECT id FROM matching_jobs ORDER BY created_at, id")).rows.map((row) => row.id);
}

const jobRow = async (id: string) => (await pool.query("SELECT * FROM matching_jobs WHERE id = $1", [id])).rows[0];
const snapshot = async (id: string) =>
  (await pool.query("SELECT to_jsonb(j) AS row FROM matching_jobs j WHERE id = $1", [id])).rows[0].row;
const sqlTrue = async (sql: string, args: unknown[] = []) => (await pool.query(sql, args)).rows[0].ok === true;
const expireLease = (id: string) =>
  pool.query("UPDATE matching_jobs SET lock_expires_at = clock_timestamp() - interval '1 second' WHERE id = $1 AND status = 'running'", [id]);
const claimOne = async (workerId: string, db: Pool = pool, leaseSeconds?: number) => {
  const leases = await claimMatchingJobs({ pool: db, workerId, limit: 1, leaseSeconds });
  assert.equal(leases.length, 1);
  return leases[0];
};

function barrier(parties: number) {
  let arrived = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("barrière non atteinte")), 8000));
  return async () => { if (++arrived === parties) release(); await Promise.race([gate, timeout]); };
}

function fakeLease(over: Partial<JobLease> = {}): JobLease {
  return {
    jobId: randomUUID(), claimToken: randomUUID(), workerId: "w", attempts: 1, maxAttempts: 5,
    lockExpiresAt: new Date(), jobType: "evaluate_offer_candidates", resourceId: randomUUID(),
    resourceVersion: 1, targetResourceId: null, scoringConfigHash: null, sourceEventId: null,
    cursorPosition: null, chunkManifest: {}, ...over,
  };
}

function spyPool() {
  let queries = 0;
  const spy = Object.create(pool) as Pool;
  spy.connect = ((...args: unknown[]) => { queries++; return (pool.connect as (...a: unknown[]) => unknown)(...args); }) as never;
  spy.query = ((...args: unknown[]) => { queries++; return (pool.query as (...a: unknown[]) => unknown)(...args); }) as never;
  return { spy, count: () => queries };
}

const hex = () => createHash("sha256").update(randomUUID()).digest("hex");
const JOB_INSERT = `INSERT INTO matching_jobs(job_identity, job_type, resource_id, resource_version, status, attempts, max_attempts,
    claim_token, locked_by, locked_at, lock_expires_at, completed_at, processed_candidates_count, created_evaluations_count)
  VALUES($1,'evaluate_offer_candidates',$2,1,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`;
const insertJob = (fields: Partial<Record<"status" | "attempts" | "max" | "token" | "by" | "at" | "expires" | "done" | "processed" | "created", unknown>>) =>
  pool.query(JOB_INSERT, [hex(), randomUUID(), fields.status ?? "pending", fields.attempts ?? 0, fields.max ?? 5, fields.token ?? null,
    fields.by ?? null, fields.at ?? null, fields.expires ?? null, fields.done ?? null, fields.processed ?? 0, fields.created ?? 0]);

test("migration 0010 : chaque contrainte rejette son cas, index de reprise présent", async () => {
  await clean();
  const now = new Date().toISOString();
  const later = new Date(Date.now() + 60_000).toISOString();
  const running = { status: "running", by: "w", at: now, expires: later, attempts: 1 };
  await assert.rejects(insertJob(running), /chk_matching_jobs_running_claim_token/);
  await insertJob({ ...running, token: randomUUID() });
  const stray = (fields: Record<string, unknown>) => assert.rejects(insertJob(fields), /chk_matching_jobs_no_lease_unless_running/);
  await stray({ token: randomUUID() });
  await stray({ by: "w" });
  await stray({ at: now });
  await stray({ expires: later });
  await stray({ status: "failed", attempts: 1, token: randomUUID() });
  for (const status of ["completed", "superseded", "dead_letter"]) {
    await assert.rejects(insertJob({ status }), /chk_matching_jobs_completed_at_terminal/, status);
    await insertJob({ status, done: now });
  }
  for (const status of ["pending", "failed"]) {
    await assert.rejects(insertJob({ status, done: now }), /chk_matching_jobs_completed_at_terminal/, status);
    await insertJob({ status });
  }
  await assert.rejects(insertJob({ ...running, token: randomUUID(), done: now }), /chk_matching_jobs_completed_at_terminal/);
  await assert.rejects(insertJob({ attempts: 6, max: 5 }), /chk_matching_jobs_attempts_bounded/);
  await insertJob({ attempts: 5, max: 5 });
  await assert.rejects(insertJob({ processed: -1 }), /chk_matching_jobs_counters_non_negative/);
  await assert.rejects(insertJob({ created: -1 }), /chk_matching_jobs_counters_non_negative/);
  await insertJob({ processed: 0, created: 0 });
  const index = await pool.query(
    "SELECT indexdef FROM pg_indexes WHERE schemaname = $1 AND indexname = 'idx_matching_jobs_running_expiry'", [schema]);
  assert.equal(index.rowCount, 1);
  assert.match(index.rows[0].indexdef, /\(lock_expires_at\)/);
  assert.match(index.rows[0].indexdef, /status = 'running'/);
});

test("réservation : jeton neuf, tentative 1, bail calculé par PostgreSQL", async () => {
  const [id] = await seedJobs(1);
  const [lease] = await claimMatchingJobs({ pool, workerId: "worker-a", limit: 5 });
  assert.equal(lease.jobId, id);
  assert.match(lease.claimToken, /^[0-9a-f-]{36}$/);
  assert.equal(lease.workerId, "worker-a");
  assert.equal(lease.attempts, 1);
  assert.equal(lease.maxAttempts, 5);
  assert.equal(lease.jobType, "evaluate_offer_candidates");
  assert.equal(lease.targetResourceId, null);
  assert.match(lease.scoringConfigHash ?? "", /^[0-9a-f]{64}$/);
  assert.ok(lease.sourceEventId);
  assert.equal(lease.cursorPosition, null);
  assert.deepEqual(lease.chunkManifest, {});
  const row = await jobRow(id);
  assert.equal(row.status, "running");
  assert.equal(row.claim_token, lease.claimToken);
  assert.equal(row.locked_by, "worker-a");
  assert.equal(row.attempts, 1);
  assert.equal(row.lock_expires_at.getTime(), lease.lockExpiresAt.getTime());
  assert.ok(await sqlTrue(
    `SELECT lock_expires_at BETWEEN clock_timestamp() + interval '85 seconds' AND clock_timestamp() + interval '90 seconds' AS ok
       FROM matching_jobs WHERE id = $1`, [id]));
  assert.ok(await sqlTrue(
    "SELECT abs(extract(epoch FROM (lock_expires_at - locked_at)) - 90) < 1 AS ok FROM matching_jobs WHERE id = $1", [id]));
  assert.deepEqual(await claimMatchingJobs({ pool, workerId: "worker-b", limit: 5 }), []);
  const [custom] = await seedJobs(1).then(() => claimMatchingJobs({ pool, workerId: "w", limit: 1, leaseSeconds: 600 }));
  assert.ok(await sqlTrue(
    "SELECT lock_expires_at BETWEEN clock_timestamp() + interval '595 seconds' AND clock_timestamp() + interval '600 seconds' AS ok FROM matching_jobs WHERE id = $1",
    [custom.jobId]));
});

test("réservation : horaire futur ignoré, ordre (scheduled_at, id) et limite respectés", async () => {
  const ids = await seedJobs(1);
  await pool.query("UPDATE matching_jobs SET scheduled_at = clock_timestamp() + interval '1 hour' WHERE id = $1", [ids[0]]);
  assert.deepEqual(await claimMatchingJobs({ pool, workerId: "w", limit: 10 }), []);
  assert.equal((await jobRow(ids[0])).status, "pending");

  const seven = await seedJobs(7);
  const [a, b, c, d, e, f, g] = seven;
  const minutesAgo: [string, number][] = [[a, 10], [b, 50], [c, 30], [d, 20], [e, 40]];
  for (const [id, minutes] of minutesAgo) {
    await pool.query("UPDATE matching_jobs SET scheduled_at = clock_timestamp() - ($2::int * interval '1 minute') WHERE id = $1", [id, minutes]);
  }
  // Égalité parfaite d'horaire (même instruction) : départage par id.
  await pool.query("UPDATE matching_jobs SET scheduled_at = now() - interval '1 hour' WHERE id = ANY($1::uuid[])", [[f, g]]);
  const tied = [f, g].sort();
  const firstBatch = await claimMatchingJobs({ pool, workerId: "w", limit: 4 });
  assert.deepEqual(firstBatch.map((lease) => lease.jobId), [...tied, b, e]);
  const rest = await claimMatchingJobs({ pool, workerId: "w", limit: 10 });
  assert.deepEqual(rest.map((lease) => lease.jobId), [c, d, a]);
  assert.deepEqual(await claimMatchingJobs({ pool, workerId: "w", limit: 10 }), []);
});

test("réservation : jobs terminaux, épuisés ou sous bail valide jamais réservés", async () => {
  const ids = await seedJobs(7);
  const set = (id: string, sql: string) => pool.query(`UPDATE matching_jobs SET ${sql} WHERE id = $1`, [id]);
  await set(ids[0], "status = 'completed', completed_at = clock_timestamp()");
  await set(ids[1], "status = 'superseded', completed_at = clock_timestamp()");
  await set(ids[2], "status = 'dead_letter', completed_at = clock_timestamp()");
  await set(ids[3], "status = 'failed', attempts = max_attempts");
  await set(ids[4], `status = 'running', attempts = 1, claim_token = gen_random_uuid(), locked_by = 'w',
    locked_at = clock_timestamp(), lock_expires_at = clock_timestamp() + interval '1 hour'`);
  await set(ids[5], `status = 'running', attempts = max_attempts, claim_token = gen_random_uuid(), locked_by = 'w',
    locked_at = clock_timestamp(), lock_expires_at = clock_timestamp() - interval '1 second'`);
  const leases = await claimMatchingJobs({ pool, workerId: "w", limit: 50 });
  assert.deepEqual(leases.map((lease) => lease.jobId), [ids[6]]);
});

test("concurrence : deux pools réservent des ensembles disjoints", async () => {
  const ids = await seedJobs(20);
  const go = barrier(2);
  const run = async (db: Pool, workerId: string) => { await go(); return claimMatchingJobs({ pool: db, workerId, limit: 10 }); };
  const [first, other] = await Promise.all([run(pool, "w1"), run(second, "w2")]);
  const firstIds = first.map((lease) => lease.jobId), otherIds = other.map((lease) => lease.jobId);
  assert.equal(firstIds.filter((id) => otherIds.includes(id)).length, 0);
  assert.deepEqual([...firstIds, ...otherIds].sort(), [...ids].sort());
  assert.equal(new Set([...first, ...other].map((lease) => lease.claimToken)).size, 20);
  for (const lease of first) assert.equal((await jobRow(lease.jobId)).locked_by, "w1");
  for (const lease of other) assert.equal((await jobRow(lease.jobId)).locked_by, "w2");
});

test("concurrence : trois workers en boucle réservent chaque job une fois par tentative", async () => {
  const ids = await seedJobs(36);
  async function drain(db: Pool, workerId: string) {
    const got: JobLease[] = [];
    for (;;) {
      const batch = await claimMatchingJobs({ pool: db, workerId, limit: 5 });
      if (batch.length === 0) return got;
      got.push(...batch);
    }
  }
  const round = async () => (await Promise.all([drain(pool, "w1"), drain(second, "w2"), drain(third, "w3")])).flat();
  const firstRound = await round();
  assert.deepEqual(firstRound.map((lease) => lease.jobId).sort(), [...ids].sort());
  assert.ok(firstRound.every((lease) => lease.attempts === 1));
  await pool.query("UPDATE matching_jobs SET lock_expires_at = clock_timestamp() - interval '1 second' WHERE status = 'running'");
  const secondRound = await round();
  assert.deepEqual(secondRound.map((lease) => lease.jobId).sort(), [...ids].sort());
  assert.ok(secondRound.every((lease) => lease.attempts === 2));
  const oldTokens = new Set(firstRound.map((lease) => lease.claimToken));
  assert.ok(secondRound.every((lease) => !oldTokens.has(lease.claimToken)));
  assert.equal((await pool.query("SELECT 1 FROM matching_jobs WHERE attempts <> 2")).rowCount, 0);
});

test("reprise : nouveau jeton et tentative+1 ; l'ancien worker est refusé partout, job inchangé", async () => {
  const [id] = await seedJobs(1);
  const w1 = await claimOne("w1");
  await expireLease(id);
  const w2 = await claimOne("w2", second);
  assert.equal(w2.jobId, id);
  assert.notEqual(w2.claimToken, w1.claimToken);
  assert.equal(w2.attempts, 2);
  assert.equal(w2.workerId, "w2");
  const before = await snapshot(id);
  assert.deepEqual(await heartbeatMatchingJob({ pool, lease: w1 }), { ok: false, reason: "lease_lost" });
  assert.equal(await failMatchingJob({ pool, lease: w1, errorCode: "late.failure" }), "lease_lost");
  assert.equal(await supersedeMatchingJob({ pool, lease: w1 }), "lease_lost");
  assert.deepEqual(await snapshot(id), before);
  assert.equal((await heartbeatMatchingJob({ pool: second, lease: w2 })).ok, true);
});

test("bail expiré mais pas encore repris : l'ancien worker est quand même refusé", async () => {
  const [id] = await seedJobs(1);
  const w1 = await claimOne("w1");
  await expireLease(id);
  const before = await snapshot(id);
  assert.deepEqual(await heartbeatMatchingJob({ pool, lease: w1 }), { ok: false, reason: "lease_lost" });
  assert.equal(await failMatchingJob({ pool, lease: w1, errorCode: "late.failure" }), "lease_lost");
  assert.equal(await supersedeMatchingJob({ pool, lease: w1 }), "lease_lost");
  assert.deepEqual(await snapshot(id), before);
  assert.equal((await jobRow(id)).status, "running");
});

test("heartbeat : prolonge le bail, refusé avec un mauvais jeton, un mauvais job ou après expiration", async () => {
  const [id] = await seedJobs(1);
  const lease = await claimOne("w1", pool, 30);
  const result = await heartbeatMatchingJob({ pool, lease, leaseSeconds: 600 });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.ok(result.lockExpiresAt.getTime() > lease.lockExpiresAt.getTime() + 500_000);
  const row = await jobRow(id);
  assert.equal(row.lock_expires_at.getTime(), result.lockExpiresAt.getTime());
  assert.equal(row.claim_token, lease.claimToken);
  assert.equal(row.attempts, 1);
  assert.ok(await sqlTrue(
    "SELECT lock_expires_at BETWEEN clock_timestamp() + interval '595 seconds' AND clock_timestamp() + interval '600 seconds' AS ok FROM matching_jobs WHERE id = $1", [id]));
  assert.equal((await heartbeatMatchingJob({ pool, lease: { ...lease, claimToken: randomUUID() } })).ok, false);
  assert.equal((await heartbeatMatchingJob({ pool, lease: { ...lease, jobId: randomUUID() } })).ok, false);
  await expireLease(id);
  const expired = await snapshot(id);
  assert.deepEqual(await heartbeatMatchingJob({ pool, lease }), { ok: false, reason: "lease_lost" });
  assert.deepEqual(await snapshot(id), expired);
});

test("échec : état failed, bail effacé, code d'erreur, délai exponentiel et rejouabilité", async () => {
  const [id] = await seedJobs(1);
  const lease = await claimOne("w1");
  assert.equal(await failMatchingJob({ pool, lease, errorCode: "transient.timeout" }), "failed");
  const row = await jobRow(id);
  assert.equal(row.status, "failed");
  for (const field of ["claim_token", "locked_by", "locked_at", "lock_expires_at", "completed_at"]) assert.equal(row[field], null, field);
  assert.equal(row.last_error, "transient.timeout");
  assert.equal(row.attempts, 1);
  assert.ok(await sqlTrue(
    "SELECT scheduled_at BETWEEN clock_timestamp() + interval '3 seconds' AND clock_timestamp() + interval '4 seconds' AS ok FROM matching_jobs WHERE id = $1", [id]));
  assert.deepEqual(await claimMatchingJobs({ pool, workerId: "w2", limit: 1 }), []);
  assert.equal(await failMatchingJob({ pool, lease, errorCode: "again" }), "lease_lost");
  await pool.query("UPDATE matching_jobs SET scheduled_at = clock_timestamp() - interval '1 second' WHERE id = $1", [id]);
  const retry = await claimOne("w2");
  assert.equal(retry.attempts, 2);
  assert.notEqual(retry.claimToken, lease.claimToken);
});

test("échec : délai 2^min(tentative,10)*2 plafonné à 600 s", async () => {
  const expected: [number, number][] = [[1, 4], [2, 8], [5, 64], [8, 512], [9, 600], [10, 600], [11, 600]];
  for (const [attempt, seconds] of expected) {
    const [id] = await seedJobs(1);
    await pool.query("UPDATE matching_jobs SET attempts = $2, max_attempts = 50 WHERE id = $1", [id, attempt - 1]);
    const lease = await claimOne("w1");
    assert.equal(lease.attempts, attempt);
    assert.equal(await failMatchingJob({ pool, lease, errorCode: "transient.timeout" }), "failed");
    assert.ok(await sqlTrue(
      `SELECT scheduled_at BETWEEN clock_timestamp() + ($2::int - 1) * interval '1 second' AND clock_timestamp() + $2::int * interval '1 second' AS ok
         FROM matching_jobs WHERE id = $1`, [id, seconds]), `tentative ${attempt}`);
  }
});

test("échec à la dernière tentative sous bail valide : dead_letter avec completed_at", async () => {
  const [id] = await seedJobs(1);
  await pool.query("UPDATE matching_jobs SET max_attempts = 2, attempts = 1 WHERE id = $1", [id]);
  const lease = await claimOne("w1");
  assert.equal(lease.attempts, 2);
  assert.equal(await failMatchingJob({ pool, lease, errorCode: "permanent.invalid" }), "dead_letter");
  const row = await jobRow(id);
  assert.equal(row.status, "dead_letter");
  assert.ok(row.completed_at instanceof Date);
  assert.equal(row.last_error, "permanent.invalid");
  for (const field of ["claim_token", "locked_by", "locked_at", "lock_expires_at"]) assert.equal(row[field], null, field);
  assert.deepEqual(await claimMatchingJobs({ pool, workerId: "w2", limit: 1 }), []);
  assert.deepEqual(await runMatchingJobMaintenance({ pool }), { deadLettered: 0 });
});

test("§9.5 : échec tardif, crash et failed épuisé ne se règlent que par la maintenance", async () => {
  const [late, crash, exhausted] = await seedJobs(3);
  await pool.query("UPDATE matching_jobs SET max_attempts = 1 WHERE id = ANY($1::uuid[])", [[late, crash]]);
  const lateLease = await claimOne("w1");
  assert.equal(lateLease.jobId, late);
  const crashLease = await claimOne("w2");
  assert.equal(crashLease.jobId, crash);
  await pool.query("UPDATE matching_jobs SET status = 'failed', attempts = max_attempts, last_error = 'previous.error' WHERE id = $1", [exhausted]);
  await expireLease(late);
  await expireLease(crash);
  assert.deepEqual(await claimMatchingJobs({ pool, workerId: "w3", limit: 10 }), []);
  const lateBefore = await snapshot(late);
  assert.equal(await failMatchingJob({ pool, lease: lateLease, errorCode: "late.failure" }), "lease_lost");
  assert.deepEqual(await snapshot(late), lateBefore);
  assert.equal((await jobRow(late)).status, "running");
  assert.deepEqual(await claimMatchingJobs({ pool, workerId: "w3", limit: 10 }), []);

  assert.deepEqual(await runMatchingJobMaintenance({ pool }), { deadLettered: 3 });
  for (const id of [late, crash]) {
    const row = await jobRow(id);
    assert.equal(row.status, "dead_letter");
    assert.equal(row.last_error, FIXED_MAINTENANCE_ERROR);
  }
  assert.equal((await jobRow(exhausted)).last_error, "previous.error");
  for (const id of [late, crash, exhausted]) {
    const row = await jobRow(id);
    assert.equal(row.status, "dead_letter");
    assert.ok(row.completed_at instanceof Date);
    for (const field of ["claim_token", "locked_by", "locked_at", "lock_expires_at"]) assert.equal(row[field], null, field);
  }
  assert.deepEqual(await claimMatchingJobs({ pool, workerId: "w3", limit: 10 }), []);
  assert.deepEqual(await runMatchingJobMaintenance({ pool }), { deadLettered: 0 });
});

test("§9.6 : l'ancien worker ne peut pas déclarer superseded, le worker courant le peut", async () => {
  const [id] = await seedJobs(1);
  const w1 = await claimOne("w1");
  await expireLease(id);
  const w2 = await claimOne("w2", second);
  const before = await snapshot(id);
  assert.equal(await supersedeMatchingJob({ pool, lease: w1 }), "lease_lost");
  assert.deepEqual(await snapshot(id), before);
  assert.equal(await supersedeMatchingJob({ pool: second, lease: w2 }), "superseded");
  const row = await jobRow(id);
  assert.equal(row.status, "superseded");
  assert.ok(row.completed_at instanceof Date);
  for (const field of ["claim_token", "locked_by", "locked_at", "lock_expires_at"]) assert.equal(row[field], null, field);
  assert.equal(await supersedeMatchingJob({ pool: second, lease: w2 }), "lease_lost");
  assert.deepEqual(await claimMatchingJobs({ pool, workerId: "w3", limit: 10 }), []);
  await pool.query("UPDATE matching_jobs SET scheduled_at = clock_timestamp() - interval '1 hour' WHERE id = $1", [id]);
  assert.deepEqual(await claimMatchingJobs({ pool, workerId: "w3", limit: 10 }), []);
});

test("maintenance : ne touche ni les running expirés réessayables ni les jobs sains", async () => {
  const [retryable, healthy, pending, failed, completed] = await seedJobs(5);
  const lease = await claimOne("w1");
  assert.equal(lease.jobId, retryable);
  await expireLease(retryable);
  await pool.query(`UPDATE matching_jobs SET status = 'running', attempts = 1, claim_token = gen_random_uuid(), locked_by = 'w',
    locked_at = clock_timestamp(), lock_expires_at = clock_timestamp() + interval '1 hour' WHERE id = $1`, [healthy]);
  await pool.query("UPDATE matching_jobs SET status = 'failed', attempts = 2, last_error = 'x' WHERE id = $1", [failed]);
  await pool.query("UPDATE matching_jobs SET status = 'completed', completed_at = clock_timestamp() WHERE id = $1", [completed]);
  const ids = [retryable, healthy, pending, failed, completed];
  const before = await Promise.all(ids.map(snapshot));
  assert.deepEqual(await runMatchingJobMaintenance({ pool }), { deadLettered: 0 });
  assert.deepEqual(await Promise.all(ids.map(snapshot)), before);
  const reclaimed = await claimMatchingJobs({ pool, workerId: "w2", limit: 1 });
  assert.equal(reclaimed[0].jobId, retryable);
  assert.equal(reclaimed[0].attempts, 2);
});

test("validation avant SQL : aucune requête pour toute entrée invalide", async () => {
  const { spy, count } = spyPool();
  const tooLong = (n: number) => "a".repeat(n);
  const bad = async (call: () => Promise<unknown>) => assert.rejects(call, MatchingJobValidationError);
  const lease = fakeLease();
  for (const workerId of ["", tooLong(129), "bad id", "café", "a/b", undefined, 12]) {
    await bad(() => claimMatchingJobs({ pool: spy, workerId: workerId as never, limit: 1 }));
  }
  for (const limit of [0, -1, 51, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "5", undefined]) {
    await bad(() => claimMatchingJobs({ pool: spy, workerId: "w", limit: limit as never }));
  }
  for (const leaseSeconds of [14, 601, 15.5, Number.NaN, "90", null]) {
    await bad(() => claimMatchingJobs({ pool: spy, workerId: "w", limit: 1, leaseSeconds: leaseSeconds as never }));
    await bad(() => heartbeatMatchingJob({ pool: spy, lease, leaseSeconds: leaseSeconds as never }));
  }
  for (const broken of [{ ...lease, jobId: "nope" }, { ...lease, claimToken: "nope" }, { ...lease, jobId: undefined }, { ...lease, claimToken: 5 }, null, "lease"]) {
    await bad(() => heartbeatMatchingJob({ pool: spy, lease: broken as never }));
    await bad(() => failMatchingJob({ pool: spy, lease: broken as never, errorCode: "ok.code" }));
    await bad(() => supersedeMatchingJob({ pool: spy, lease: broken as never }));
  }
  for (const errorCode of ["", "UPPER", "has space", "Error: boom at x.ts:1", tooLong(121), "é", undefined, 3]) {
    await bad(() => failMatchingJob({ pool: spy, lease, errorCode: errorCode as never }));
  }
  assert.equal(count(), 0);

  // Pool invalide : client réservé, exécuteur arbitraire, faux pool, absence de pool.
  let foreign = 0;
  const client = await pool.connect();
  const original = client.query.bind(client);
  (client as unknown as { query: unknown }).query = (...args: unknown[]) => { foreign++; return (original as (...a: unknown[]) => unknown)(...args); };
  const arbitrary = { query: async () => { foreign++; throw new Error("unexpected"); } };
  const duck = { ...arbitrary, connect: async () => { foreign++; throw new Error("unexpected"); } };
  try {
    for (const bogus of [client, arbitrary, duck, undefined, null, {}]) {
      await bad(() => claimMatchingJobs({ pool: bogus as never, workerId: "w", limit: 1 }));
      await bad(() => heartbeatMatchingJob({ pool: bogus as never, lease }));
      await bad(() => failMatchingJob({ pool: bogus as never, lease, errorCode: "ok.code" }));
      await bad(() => supersedeMatchingJob({ pool: bogus as never, lease }));
      await bad(() => runMatchingJobMaintenance({ pool: bogus as never }));
    }
  } finally { client.release(); }
  assert.equal(foreign, 0);

  // Les bornes valides sont acceptées.
  await clean();
  await claimMatchingJobs({ pool: spy, workerId: tooLong(128), limit: 1, leaseSeconds: 15 });
  await claimMatchingJobs({ pool: spy, workerId: "a.B_c:d-e", limit: 50, leaseSeconds: 600 });
  assert.equal(await failMatchingJob({ pool: spy, lease, errorCode: "a" + "b".repeat(119) }), "lease_lost");
  assert.ok(count() > 0);
});

test("rejeu de la projection : le job dead_letter n'est ni recréé ni modifié", async () => {
  const [id] = await seedJobs(1);
  await pool.query("UPDATE matching_jobs SET max_attempts = 1 WHERE id = $1", [id]);
  await claimOne("w1");
  await expireLease(id);
  assert.deepEqual(await runMatchingJobMaintenance({ pool }), { deadLettered: 1 });
  const before = await snapshot(id);
  assert.equal(before.status, "dead_letter");
  await pool.query("UPDATE matching_outbox_events SET dispatch_status = 'pending', dispatched_at = NULL WHERE id = $1", [before.source_event_id]);
  assert.deepEqual(
    await projectOutboxBatch({ pool }),
    { selected: 1, projected: 1, jobsInserted: 0, jobsAlreadyPresent: 1, ignored: 0, invalid: 0 },
  );
  assert.equal((await pool.query("SELECT count(*) AS n FROM matching_jobs")).rows[0].n, "1");
  assert.deepEqual(await snapshot(id), before);
});

test("filtre jobTypes : un type non demandé n'est jamais réservé", async () => {
  await clean();
  const user = await createUser({}, pool);
  await createOffer({ ownerId: user.id, rawText: "iPhone 12", status: "published" }, pool);
  const suspended = await updateUser({ id: user.id, expectedVersion: user.version, status: "suspended" }, pool);
  await updateUser({ id: user.id, expectedVersion: suspended.version, status: "active" }, pool);
  assert.equal((await projectOutboxBatch({ pool })).jobsInserted, 2);
  const types = async () => (await pool.query("SELECT job_type, status, attempts FROM matching_jobs ORDER BY job_type")).rows;
  assert.deepEqual((await types()).map((row) => row.job_type), ["evaluate_offer_candidates", "user_reactivation_sweep"]);

  const evaluation = ["evaluate_offer_candidates", "evaluate_demand_candidates"];
  const leases = await claimMatchingJobs({ pool, workerId: "w1", limit: 10, jobTypes: evaluation });
  assert.deepEqual(leases.map((lease) => lease.jobType), ["evaluate_offer_candidates"]);
  assert.deepEqual(await claimMatchingJobs({ pool, workerId: "w2", limit: 10, jobTypes: evaluation }), []);
  const sweep = (await types()).find((row) => row.job_type === "user_reactivation_sweep");
  assert.equal(sweep?.status, "pending");
  assert.equal(sweep?.attempts, 0);
  assert.deepEqual(await claimMatchingJobs({ pool, workerId: "w2", limit: 10, jobTypes: ["scoring_config_sweep"] }), []);
  // Sans filtre : comportement historique, tous les types.
  const rest = await claimMatchingJobs({ pool, workerId: "w3", limit: 10 });
  assert.deepEqual(rest.map((lease) => lease.jobType), ["user_reactivation_sweep"]);
});

test("filtre jobTypes : vide, inconnu, doublon ou mal typé refusés avant SQL", async () => {
  const { spy, count } = spyPool();
  for (const jobTypes of [[], ["inconnu"], ["evaluate_offer_candidates", "evaluate_offer_candidates"], "evaluate_offer_candidates", [1], [null], null]) {
    await assert.rejects(
      claimMatchingJobs({ pool: spy, workerId: "w", limit: 1, jobTypes: jobTypes as never }),
      MatchingJobValidationError,
    );
  }
  assert.equal(count(), 0);
  await claimMatchingJobs({ pool: spy, workerId: "w", limit: 1, jobTypes: ["evaluate_offer_candidates", "evaluate_demand_candidates"] });
  assert.ok(count() > 0);
});
