import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { before, after, test } from "node:test";
import { Pool } from "pg";
import { createUser, createOffer, updateUser } from "../../lib/server/catalog";
import { encodeCandidateCursor } from "../../lib/server/matching/candidates";
import {
  acknowledgeCandidateAttempt, appendCandidateAttempt, buildInitialChunkManifest, validateChunkManifest,
  type ChunkManifest, type ResolvedCandidateStatus,
} from "../../lib/server/matching/chunk-manifest";
import {
  acknowledgeCandidate, completeChunkedJob, initializeChunk, readChunkState, recordCandidateAttempt,
  validateChunk, type ChunkOperationResult,
} from "../../lib/server/matching/chunks";
import { MatchingJobValidationError, claimMatchingJobs, type JobLease } from "../../lib/server/matching/jobs";
import { projectOutboxBatch } from "../../lib/server/matching/projection";
import { runMigrations } from "../../lib/server/postgres/migrations";
import {
  openVerifiedTestDatabase, openVerifiedIsolatedPool, createTemporarySchemaName, quoteTemporarySchema,
} from "./test-database";

let admin: Pool, pool: Pool, second: Pool;
const schema = createTemporarySchemaName();
const quoted = quoteTemporarySchema(schema);
const HASH = "a".repeat(64);
const cursorAt = (second: number) => encodeCandidateCursor({ createdAtIso: `2026-10-04T12:00:${String(second).padStart(2, "0")}.123456Z`, id: randomUUID() });
// Ordre 2C1 : created_at décroissant, donc chaque curseur suivant est plus petit que le précédent.
const [C1, C2, C3] = [cursorAt(50), cursorAt(40), cursorAt(30)];

before(async () => {
  const opened = await openVerifiedTestDatabase(process.env.TEST_DATABASE_URL);
  admin = opened.pool;
  await admin.query(`CREATE SCHEMA ${quoted}`);
  pool = await openVerifiedIsolatedPool(opened.target, schema);
  second = await openVerifiedIsolatedPool(opened.target, schema);
  const migrations = await runMigrations(pool);
  assert.equal(migrations.applied.length, 26);
});

after(async () => {
  for (const db of [second, pool]) if (db) await db.end();
  if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${quoted} CASCADE`); await admin.end(); }
});

/** Jobs réels : catalogue + projection + réservation. Aucune évaluation : les candidats sont synthétiques. */
/** Liaison du manifeste au job : ressource pivot et configuration scellée du dernier job réservé. */
const bound = { resourceId: "", resourceVersion: 0, hash: "" };

async function claimJobs(count: number, workerId = "w1"): Promise<JobLease[]> {
  await pool.query("DELETE FROM matching_jobs");
  await pool.query("DELETE FROM matching_outbox_events");
  const user = await createUser({}, pool);
  for (let i = 0; i < count; i++) await createOffer({ ownerId: user.id, rawText: `iPhone ${i}`, status: "published" }, pool);
  assert.equal((await projectOutboxBatch({ pool, limit: 100 })).jobsInserted, count);
  const leases = await claimMatchingJobs({ pool, workerId, limit: count });
  assert.equal(leases.length, count);
  Object.assign(bound, { resourceId: leases[0].resourceId, resourceVersion: leases[0].resourceVersion, hash: leases[0].scoringConfigHash });
  return leases;
}
const claimJob = async (workerId = "w1") => (await claimJobs(1, workerId))[0];

const jobRow = async (id: string) => (await pool.query("SELECT * FROM matching_jobs WHERE id = $1", [id])).rows[0];
const snapshot = async (id: string) =>
  (await pool.query("SELECT to_jsonb(j) AS row FROM matching_jobs j WHERE id = $1", [id])).rows[0].row;
const expireLease = (id: string) =>
  pool.query("UPDATE matching_jobs SET lock_expires_at = clock_timestamp() - interval '1 second' WHERE id = $1 AND status = 'running'", [id]);

function mk(options: { n?: number; pred?: ChunkManifest | null; cursorIn?: string | null; cursorOut: string | null }): ChunkManifest {
  const { pred = null } = options;
  return buildInitialChunkManifest({
    chunkId: randomUUID(), chunkIndex: pred ? pred.chunk_index + 1 : 0,
    predecessorChunkId: pred?.chunk_id ?? null, predecessorManifestVersion: pred?.manifest_version ?? null,
    cursorIn: options.cursorIn ?? null, cursorOut: options.cursorOut,
    evaluatedAt: new Date(Date.now() - 1000), scoringConfigHash: bound.hash,
    engineOfflineVersion: "matching-offline/v1", engineScoringVersion: "matching-scoring/v1",
    candidates: Array.from({ length: options.n ?? 2 }, (_, i) => ({
      candidateId: randomUUID(), candidateVersion: i + 1, pairResourceId: bound.resourceId, pairResourceVersion: bound.resourceVersion,
      attemptId: randomUUID(), idempotencyKey: randomUUID(), attemptHash: HASH,
    })),
  });
}

interface Step { next: ChunkManifest; result: ChunkOperationResult }

const init = (lease: JobLease, manifest: ChunkManifest, db: Pool = pool) => initializeChunk({ pool: db, lease, manifest });

async function ack(lease: JobLease, prev: ChunkManifest, index: number, status: ResolvedCandidateStatus, db: Pool = pool): Promise<Step> {
  const candidate = prev.candidates[index];
  const next = acknowledgeCandidateAttempt(prev, candidate.candidate_id, candidate.current_attempt_id, status);
  const result = await acknowledgeCandidate({
    pool: db, lease, expectedChunkId: prev.chunk_id, expectedManifestVersion: prev.manifest_version, nextManifest: next,
    candidateId: candidate.candidate_id, attemptId: candidate.current_attempt_id, status,
  });
  return { next, result };
}

function freshAttempt(prev: ChunkManifest, index: number) {
  return { ...prev.candidates[index].attempts[0], attempt_id: randomUUID(), idempotency_key: randomUUID(),
    evaluated_at: new Date().toISOString(), attempt_hash: "b".repeat(64), status: "pending" as const, error_class: null };
}

async function record(lease: JobLease, prev: ChunkManifest, index: number, db: Pool = pool): Promise<Step & { attemptId: string }> {
  const attempt = freshAttempt(prev, index);
  const next = appendCandidateAttempt(prev, prev.candidates[index].candidate_id, attempt);
  const result = await recordCandidateAttempt({
    pool: db, lease, expectedChunkId: prev.chunk_id, expectedManifestVersion: prev.manifest_version,
    nextManifest: next, attemptId: attempt.attempt_id,
  });
  return { next, result, attemptId: attempt.attempt_id };
}

async function validate(lease: JobLease, prev: ChunkManifest, db: Pool = pool): Promise<Step> {
  const next = validateChunkManifest(prev);
  const result = await validateChunk({
    pool: db, lease, expectedChunkId: prev.chunk_id, expectedManifestVersion: prev.manifest_version, nextManifest: next,
  });
  return { next, result };
}

const applied = (step: { result: ChunkOperationResult }) => assert.deepEqual(step.result, { kind: "applied" });

/** init → acquittement de chaque candidat → validation ; renvoie le manifeste validé. */
async function runChunk(lease: JobLease, manifest: ChunkManifest, statuses: ResolvedCandidateStatus[]): Promise<ChunkManifest> {
  assert.deepEqual(await init(lease, manifest), { kind: "applied" });
  let current = manifest;
  for (const [index, status] of statuses.entries()) {
    const step = await ack(lease, current, index, status);
    applied(step);
    current = step.next;
  }
  const done = await validate(lease, current);
  applied(done);
  return done.next;
}

/** Job avec un chunk à la révision 5 (3 candidats, c2 encore pending). */
async function chunkAtVersion5(lease: JobLease): Promise<ChunkManifest> {
  let current = mk({ n: 3, cursorOut: C1 });
  assert.deepEqual(await init(lease, current), { kind: "applied" });
  const recorded0 = await record(lease, current, 0); applied(recorded0);
  const acked0 = await ack(lease, recorded0.next, 0, "persisted"); applied(acked0);
  const recorded1 = await record(lease, acked0.next, 1); applied(recorded1);
  const acked1 = await ack(lease, recorded1.next, 1, "replayed"); applied(acked1);
  current = acked1.next;
  assert.equal(current.manifest_version, 5);
  return current;
}

function barrier(parties: number) {
  let arrived = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("barrière non atteinte")), 8000));
  return async () => { if (++arrived === parties) release(); await Promise.race([gate, timeout]); };
}

function spyPool() {
  let queries = 0;
  const spy = Object.create(pool) as Pool;
  spy.connect = ((...args: unknown[]) => { queries++; return (pool.connect as (...a: unknown[]) => unknown)(...args); }) as never;
  spy.query = ((...args: unknown[]) => { queries++; return (pool.query as (...a: unknown[]) => unknown)(...args); }) as never;
  return { spy, count: () => queries };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const tamper = (manifest: ChunkManifest, change: (value: any) => void): ChunkManifest => { const copy = structuredClone(manifest); change(copy); return copy; };

test("page unique (§6.E.1) : validation, curseur NULL, compteurs dérivés puis completed", async () => {
  const lease = await claimJob();
  const manifest = mk({ n: 3, cursorOut: null });
  const validated = await runChunk(lease, manifest, ["persisted", "replayed", "skipped_stale"]);
  const row = await jobRow(lease.jobId);
  assert.equal(row.cursor_position, null);
  assert.equal(row.processed_candidates_count, 3);
  assert.equal(row.created_evaluations_count, 1);
  assert.deepEqual(row.chunk_manifest, validated);
  assert.equal(row.chunk_evaluated_at.getTime(), Date.parse(manifest.evaluated_at));
  assert.equal(validated.is_eof, true);
  assert.equal(await completeChunkedJob({ pool, lease }), "completed");
  const done = await jobRow(lease.jobId);
  assert.equal(done.status, "completed");
  assert.ok(done.completed_at instanceof Date);
  for (const field of ["claim_token", "locked_by", "locked_at", "lock_expires_at"]) assert.equal(done[field], null, field);
  assert.equal(await completeChunkedJob({ pool, lease }), "lease_lost");
});

test("page vide (§6.E.2) : zéro candidat, curseur NULL, compteurs à zéro, completed", async () => {
  const lease = await claimJob();
  await runChunk(lease, mk({ n: 0, cursorOut: null }), []);
  const row = await jobRow(lease.jobId);
  assert.equal(row.cursor_position, null);
  assert.equal(row.processed_candidates_count, 0);
  assert.equal(row.created_evaluations_count, 0);
  assert.equal(row.chunk_manifest.manifest_version, 2);
  assert.equal(await completeChunkedJob({ pool, lease }), "completed");
});

test("plusieurs pages : prédécesseur exact, curseur jamais sentinelle, compteurs = somme des chunks", async () => {
  const lease = await claimJob();
  const chunk0 = await runChunk(lease, mk({ n: 2, cursorOut: C1 }), ["persisted", "persisted"]);
  let row = await jobRow(lease.jobId);
  assert.equal(row.cursor_position, C1);
  assert.equal(row.processed_candidates_count, 2);
  assert.equal(row.created_evaluations_count, 2);
  assert.equal(chunk0.manifest_version, 4);
  assert.deepEqual(await completeChunkedJob({ pool, lease }), "not_ready");

  const chunk1 = await runChunk(lease, mk({ n: 3, pred: chunk0, cursorIn: C1, cursorOut: C2 }), ["persisted", "replayed", "persisted"]);
  row = await jobRow(lease.jobId);
  assert.equal(row.cursor_position, C2);
  assert.equal(row.processed_candidates_count, 5);
  assert.equal(row.created_evaluations_count, 4);
  assert.equal(chunk1.predecessor_chunk_id, chunk0.chunk_id);
  assert.equal(chunk1.predecessor_manifest_version, chunk0.manifest_version);

  const last = await runChunk(lease, mk({ n: 1, pred: chunk1, cursorIn: C2, cursorOut: null }), ["already_superseded"]);
  row = await jobRow(lease.jobId);
  assert.equal(row.cursor_position, C2, "dernière page : curseur inchangé");
  assert.notEqual(row.cursor_position, "EOF");
  assert.equal(last.is_eof, true);
  assert.equal(row.processed_candidates_count, 6);
  assert.equal(row.created_evaluations_count, 4);
  assert.equal(row.chunk_manifest.chunk_index, 2);
  assert.equal(await completeChunkedJob({ pool, lease }), "completed");

  const state = await readChunkState({ pool, jobId: lease.jobId });
  assert.equal(state?.status, "completed");
  assert.equal(state?.cursorPosition, C2);
  assert.equal(state?.manifest?.state, "validated");
  assert.equal(await readChunkState({ pool, jobId: randomUUID() }), null);
});

test("§9.7 : contournements rejetés sans modification (jeton, version, chunk, prédécesseur, EOF)", async () => {
  const [lease, emptyLease] = await claimJobs(2);
  const current = await chunkAtVersion5(lease);
  const before = await snapshot(lease.jobId);
  const sameSnapshot = async (id = lease.jobId, expected = before) => assert.deepEqual(await snapshot(id), expected);

  // Un job sans chunk : aucune mutation n'est acceptée (chunk_id absent).
  const stray = mk({ n: 2, cursorOut: C1 });
  const emptyBefore = await snapshot(emptyLease.jobId);
  const strayRecord = await record(emptyLease, stray, 0);
  assert.deepEqual(strayRecord.result, { kind: "rejected", reason: "no_chunk" });
  assert.deepEqual((await ack(emptyLease, stray, 0, "persisted")).result, { kind: "rejected", reason: "no_chunk" });
  assert.deepEqual((await validate(emptyLease, mk({ n: 0, cursorOut: null }))).result, { kind: "rejected", reason: "no_chunk" });
  await sameSnapshot(emptyLease.jobId, emptyBefore);

  // Manifeste en base sans manifest_version, ou sans chunk_id : rien n'est accepté ni réparé.
  for (const corrupt of [
    { chunk_id: stray.chunk_id, state: "processing" },
    { manifest_version: 1, state: "processing" },
  ]) {
    await pool.query("UPDATE matching_jobs SET chunk_manifest = $2::jsonb WHERE id = $1", [emptyLease.jobId, JSON.stringify(corrupt)]);
    const corruptBefore = await snapshot(emptyLease.jobId);
    assert.deepEqual((await record(emptyLease, stray, 0)).result, { kind: "rejected", reason: "invalid_stored_manifest" });
    assert.deepEqual((await ack(emptyLease, stray, 0, "persisted")).result, { kind: "rejected", reason: "invalid_stored_manifest" });
    assert.deepEqual((await validate(emptyLease, mk({ n: 0, cursorOut: null }))).result, { kind: "rejected", reason: "invalid_stored_manifest" });
    await sameSnapshot(emptyLease.jobId, corruptBefore);
  }

  // Saut de version 5 → 99, version inférieure, mauvaise version attendue : conflit, base intacte.
  const nextFor = (version: number) => tamper(appendCandidateAttempt(current, current.candidates[2].candidate_id, freshAttempt(current, 2)), (m) => { m.manifest_version = version; });
  for (const [expected, label] of [[98, "saut 5 → 99"], [3, "version inférieure"], [4, "mauvaise version attendue"], [6, "version attendue future"]] as const) {
    const next = nextFor(expected + 1);
    const result = await recordCandidateAttempt({
      pool, lease, expectedChunkId: current.chunk_id, expectedManifestVersion: expected, nextManifest: next,
      attemptId: next.candidates[2].current_attempt_id,
    });
    assert.equal(result.kind, "conflict", label);
    if (result.kind === "conflict") assert.deepEqual(result.fresh, current);
    await sameSnapshot();
  }
  // Un manifeste suivant qui saute une révision est refusé avant SQL.
  await assert.rejects(recordCandidateAttempt({
    pool, lease, expectedChunkId: current.chunk_id, expectedManifestVersion: 5, nextManifest: nextFor(99),
    attemptId: nextFor(99).candidates[2].current_attempt_id,
  }), MatchingJobValidationError);
  await sameSnapshot();

  // chunk_id différent : chunk périmé.
  const otherChunk = tamper(nextFor(6), (m) => { m.chunk_id = randomUUID(); });
  assert.deepEqual(await recordCandidateAttempt({
    pool, lease, expectedChunkId: otherChunk.chunk_id, expectedManifestVersion: 5, nextManifest: otherChunk,
    attemptId: otherChunk.candidates[2].current_attempt_id,
  }), { kind: "stale_chunk" });
  await sameSnapshot();

  // Initialisation d'un chunk N : prédécesseur non validé, mauvaise révision, mauvaise identité, saut d'index.
  const successor = mk({ n: 1, pred: current, cursorIn: C1, cursorOut: C2 });
  assert.deepEqual(await init(lease, successor), { kind: "rejected", reason: "predecessor_not_validated" });
  await sameSnapshot();

  const resolved2 = await ack(lease, current, 2, "persisted"); applied(resolved2);
  const validated = await validate(lease, resolved2.next); applied(validated);
  const afterValidation = await snapshot(lease.jobId);
  const wrongRevision = mk({ n: 1, pred: { ...validated.next, manifest_version: validated.next.manifest_version - 1 }, cursorIn: C1, cursorOut: C2 });
  assert.deepEqual(await init(lease, wrongRevision), { kind: "rejected", reason: "predecessor_mismatch" });
  const wrongIdentity = mk({ n: 1, pred: { ...validated.next, chunk_id: randomUUID() }, cursorIn: C1, cursorOut: C2 });
  assert.deepEqual(await init(lease, wrongIdentity), { kind: "rejected", reason: "predecessor_mismatch" });
  const skipped = buildInitialChunkManifest({
    chunkId: randomUUID(), chunkIndex: 2, predecessorChunkId: validated.next.chunk_id,
    predecessorManifestVersion: validated.next.manifest_version, cursorIn: C1, cursorOut: C2,
    evaluatedAt: new Date(), scoringConfigHash: bound.hash, engineOfflineVersion: "v1", engineScoringVersion: "v1", candidates: [],
  });
  assert.deepEqual(await init(lease, skipped), { kind: "rejected", reason: "predecessor_mismatch" });
  const restart = mk({ n: 1, cursorOut: C2 });
  assert.deepEqual(await init(lease, restart), { kind: "rejected", reason: "predecessor_mismatch" });
  await sameSnapshot(lease.jobId, afterValidation);

  // Initialisation après EOF : jamais.
  const final = await runChunk(lease, mk({ n: 1, pred: validated.next, cursorIn: C1, cursorOut: null }), ["persisted"]);
  const afterEof = await snapshot(lease.jobId);
  assert.deepEqual(await init(lease, mk({ n: 1, pred: final, cursorIn: C2, cursorOut: C3 })), { kind: "rejected", reason: "eof_reached" });
  assert.deepEqual(await init(lease, mk({ n: 1, cursorOut: C3 })), { kind: "rejected", reason: "eof_reached" });
  await sameSnapshot(lease.jobId, afterEof);
});

test("même révision (§6.E.8) : une seule réussit, l'autre reçoit le manifeste frais et reconstruit sans perte", async () => {
  // Version séquentielle déterministe.
  const lease = await claimJob();
  const base = mk({ n: 2, cursorOut: C1 });
  assert.deepEqual(await init(lease, base), { kind: "applied" });
  const first = await ack(lease, base, 0, "persisted");
  applied(first);
  const late = await ack(lease, base, 1, "replayed", second);
  assert.equal(late.result.kind, "conflict");
  if (late.result.kind === "conflict") {
    assert.deepEqual(late.result.fresh, first.next);
    const rebuilt = await ack(lease, late.result.fresh, 1, "replayed", second);
    applied(rebuilt);
    const row = await jobRow(lease.jobId);
    assert.deepEqual(row.chunk_manifest, rebuilt.next);
    assert.deepEqual(row.chunk_manifest.candidates.map((c: { status: string }) => c.status), ["persisted", "replayed"]);
    assert.equal(row.chunk_manifest.manifest_version, 3);
  }

  // Course réelle sur deux connexions, depuis la même révision.
  const racing = await claimJob();
  const start = mk({ n: 2, cursorOut: C1 });
  assert.deepEqual(await init(racing, start), { kind: "applied" });
  const go = barrier(2);
  const run = async (db: Pool, index: number, status: ResolvedCandidateStatus) => { await go(); return ack(racing, start, index, status, db); };
  const [a, b] = await Promise.all([run(pool, 0, "persisted"), run(second, 1, "skipped_stale")]);
  assert.deepEqual([a.result.kind, b.result.kind].sort(), ["applied", "conflict"]);
  const [winner, loser, loserIndex, loserStatus] = a.result.kind === "applied"
    ? [a, b, 1, "skipped_stale" as const] : [b, a, 0, "persisted" as const];
  assert.equal(loser.result.kind, "conflict");
  if (loser.result.kind !== "conflict") return;
  assert.deepEqual(loser.result.fresh, winner.next);
  const retried = await ack(racing, loser.result.fresh, loserIndex, loserStatus);
  applied(retried);
  const finalRow = await jobRow(racing.jobId);
  assert.deepEqual(finalRow.chunk_manifest.candidates.map((c: { status: string }) => c.status), ["persisted", "skipped_stale"]);
  assert.equal(finalRow.chunk_manifest.manifest_version, 3);
});

test("réponses perdues (§6.E.5-6) : l'effet précis est vérifié, une autre opération ne prouve rien", async () => {
  const lease = await claimJob();
  const base = mk({ n: 3, cursorOut: C1 });
  assert.deepEqual(await init(lease, base), { kind: "applied" });
  assert.deepEqual(await init(lease, base), { kind: "already_applied" });

  const attempt = freshAttempt(base, 0);
  const recordedNext = appendCandidateAttempt(base, base.candidates[0].candidate_id, attempt);
  const recordOptions = {
    pool, lease, expectedChunkId: base.chunk_id, expectedManifestVersion: 1, nextManifest: recordedNext, attemptId: attempt.attempt_id,
  };
  assert.deepEqual(await recordCandidateAttempt(recordOptions), { kind: "applied" });
  assert.deepEqual(await recordCandidateAttempt(recordOptions), { kind: "already_applied" });

  const acked = await ack(lease, recordedNext, 0, "persisted"); applied(acked);
  assert.deepEqual((await ack(lease, recordedNext, 0, "persisted")).result, { kind: "already_applied" });
  assert.deepEqual(await recordCandidateAttempt(recordOptions), { kind: "already_applied" }, "même après d'autres opérations");
  assert.deepEqual(await init(lease, base), { kind: "already_applied" });

  // Une autre opération a fait avancer la révision : ce n'est PAS la preuve de l'effet demandé.
  const row1 = await ack(lease, acked.next, 1, "persisted");
  applied(row1);
  const unrelatedRecord = await record(lease, acked.next, 2);
  assert.equal(unrelatedRecord.result.kind, "conflict");
  assert.equal((await ack(lease, acked.next, 2, "replayed")).result.kind, "conflict");
  const wrongStatus = await ack(lease, acked.next, 1, "replayed");
  assert.equal(wrongStatus.result.kind, "conflict", "statut différent de celui présent en base");

  const two = await ack(lease, row1.next, 2, "replayed"); applied(two);
  const done = await validate(lease, two.next); applied(done);
  const afterValidation = await snapshot(lease.jobId);
  assert.deepEqual((await validate(lease, two.next)).result, { kind: "already_applied" });
  assert.deepEqual(await snapshot(lease.jobId), afterValidation, "aucun recomptage");
  const row = await jobRow(lease.jobId);
  assert.equal(row.processed_candidates_count, 3);
  assert.equal(row.created_evaluations_count, 2);
  assert.equal(row.cursor_position, C1);
});

test("ancien acquittement ou ancienne validation du chunk 0 après le chunk 1 (§6.E.3) : stale_chunk", async () => {
  const lease = await claimJob();
  const base = mk({ n: 2, cursorOut: C1 });
  assert.deepEqual(await init(lease, base), { kind: "applied" });
  const ack0 = await ack(lease, base, 0, "persisted"); applied(ack0);
  const ack1 = await ack(lease, ack0.next, 1, "persisted"); applied(ack1);
  const validated0 = await validate(lease, ack1.next); applied(validated0);
  const chunk1 = await runChunk(lease, mk({ n: 2, pred: validated0.next, cursorIn: C1, cursorOut: C2 }), ["persisted", "persisted"]);
  const frozen = await snapshot(lease.jobId);
  const row = await jobRow(lease.jobId);
  assert.equal(row.cursor_position, C2);
  assert.equal(row.processed_candidates_count, 4);

  assert.deepEqual((await validate(lease, ack1.next)).result, { kind: "stale_chunk" });
  assert.deepEqual((await ack(lease, base, 0, "persisted")).result, { kind: "stale_chunk" });
  assert.deepEqual((await ack(lease, ack0.next, 1, "persisted")).result, { kind: "stale_chunk" });
  assert.deepEqual((await record(lease, base, 1)).result, { kind: "stale_chunk" });
  assert.deepEqual(await init(lease, base), { kind: "rejected", reason: "predecessor_mismatch" });
  assert.deepEqual(await snapshot(lease.jobId), frozen);
  assert.equal((await jobRow(lease.jobId)).cursor_position, C2);
  assert.equal(chunk1.chunk_index, 1);
});

test("bail : chaque opération renvoie lease_lost après expiration ou reprise, sans modification", async () => {
  const lease = await claimJob("w1");
  const base = mk({ n: 2, cursorOut: C1 });
  assert.deepEqual(await init(lease, base), { kind: "applied" });
  const acked = await ack(lease, base, 0, "persisted"); applied(acked);
  const allResolved = acknowledgeCandidateAttempt(acked.next, acked.next.candidates[1].candidate_id, acked.next.candidates[1].current_attempt_id, "persisted");
  const attempts = async (db: Pool = pool) => {
    const outcomes = [
      await init(lease, mk({ n: 1, cursorOut: C2 }), db),
      (await record(lease, acked.next, 1, db)).result,
      (await ack(lease, acked.next, 1, "persisted", db)).result,
      (await validate(lease, allResolved, db)).result,
    ];
    return [...outcomes.map((outcome) => outcome.kind), await completeChunkedJob({ pool: db, lease })];
  };
  await expireLease(lease.jobId);
  const expired = await snapshot(lease.jobId);
  assert.deepEqual(await attempts(), ["lease_lost", "lease_lost", "lease_lost", "lease_lost", "lease_lost"]);
  assert.deepEqual(await snapshot(lease.jobId), expired);

  const [w2] = await claimMatchingJobs({ pool: second, workerId: "w2", limit: 1 });
  assert.equal(w2.jobId, lease.jobId);
  assert.equal(w2.attempts, 2);
  assert.deepEqual(w2.chunkManifest, acked.next);
  const resumed = await snapshot(lease.jobId);
  assert.deepEqual(await attempts(second), ["lease_lost", "lease_lost", "lease_lost", "lease_lost", "lease_lost"]);
  assert.deepEqual(await snapshot(lease.jobId), resumed);
  // Le repreneur, lui, avance normalement sur le manifeste durable.
  const continued = await ack(w2, acked.next, 1, "persisted"); applied(continued);
});

test("reprise après validation finale EOF (§6.E.4) : le repreneur clôture sans réinitialiser", async () => {
  const lease = await claimJob("w1");
  const validated = await runChunk(lease, mk({ n: 2, cursorOut: null }), ["persisted", "persisted"]);
  await expireLease(lease.jobId);
  assert.equal(await completeChunkedJob({ pool, lease }), "lease_lost");
  const [w2] = await claimMatchingJobs({ pool: second, workerId: "w2", limit: 1 });
  assert.equal(w2.attempts, 2);
  assert.equal(w2.cursorPosition, null);
  assert.deepEqual(w2.chunkManifest, validated);
  const state = await readChunkState({ pool: second, jobId: lease.jobId });
  assert.equal(state?.status, "running");
  assert.equal(state?.leaseValid, true);
  assert.equal(state?.claimToken, w2.claimToken);
  assert.equal(state?.manifest?.state, "validated");
  assert.equal(state?.manifest?.is_eof, true);
  assert.deepEqual(await init(w2, mk({ n: 1, pred: validated, cursorIn: C1, cursorOut: C2 }), second), { kind: "rejected", reason: "eof_reached" });
  assert.equal(await completeChunkedJob({ pool: second, lease: w2 }), "completed");
  assert.equal((await jobRow(lease.jobId)).status, "completed");
});

test("tentatives append-only (§6.E.7) : conservées en base, toute altération refusée", async () => {
  const lease = await claimJob();
  const base = mk({ n: 2, cursorOut: C1 });
  assert.deepEqual(await init(lease, base), { kind: "applied" });
  const originalAttempt = structuredClone((await jobRow(lease.jobId)).chunk_manifest.candidates[0].attempts[0]);
  const retried = await record(lease, base, 0); applied(retried);
  const stored = (await jobRow(lease.jobId)).chunk_manifest;
  assert.equal(stored.candidates[0].attempts.length, 2);
  assert.deepEqual(stored.candidates[0].attempts[0], originalAttempt);
  assert.deepEqual(stored.candidates[0].attempts[1], retried.next.candidates[0].attempts[1]);
  assert.equal(stored.candidates[0].current_attempt_id, retried.attemptId);

  // Altérations refusées avant SQL quand le manifeste précédent est fourni.
  const { spy, count } = spyPool();
  const newAttempt = freshAttempt(retried.next, 1);
  const legit = appendCandidateAttempt(retried.next, retried.next.candidates[1].candidate_id, newAttempt);
  const forged = tamper(legit, (m) => { m.candidates[0].attempts = [m.candidates[0].attempts[1]]; });
  await assert.rejects(recordCandidateAttempt({
    pool: spy, lease, expectedChunkId: base.chunk_id, expectedManifestVersion: 2, nextManifest: forged,
    previousManifest: retried.next, attemptId: newAttempt.attempt_id,
  }), /Tentative supprimée|supprimée/);
  assert.equal(count(), 0);

  // Même sans manifeste précédent, SQL refuse toute altération des tentatives, des candidats ou de la structure.
  const before = await snapshot(lease.jobId);
  const cur = retried.next;
  const recordTampers: [string, (m: any) => void][] = [ // eslint-disable-line @typescript-eslint/no-explicit-any
    ["tentative modifiée", (m) => { m.candidates[0].attempts[0].idempotency_key = randomUUID(); }],
    ["tentative supprimée", (m) => { m.candidates[0].attempts.shift(); }],
    ["tentative réordonnée", (m) => { m.candidates[0].attempts.reverse(); m.candidates[0].current_attempt_id = m.candidates[0].attempts.at(-1).attempt_id; }],
    ["candidat modifié", (m) => { m.candidates[0].pair_resource_id = randomUUID(); }],
    ["champ structurant modifié", (m) => { m.evaluated_at = "2030-01-01T00:00:00.000Z"; }],
    ["curseur modifié", (m) => { m.cursor_out = C3; }],
  ];
  for (const [label, change] of recordTampers) {
    const next = tamper(legit, (m) => { change(m); });
    const result = await recordCandidateAttempt({
      pool, lease, expectedChunkId: cur.chunk_id, expectedManifestVersion: cur.manifest_version,
      nextManifest: next, attemptId: newAttempt.attempt_id,
    });
    assert.deepEqual(result, { kind: "rejected", reason: "invalid_next_manifest" }, label);
    assert.deepEqual(await snapshot(lease.jobId), before, label);
  }
  const acked = await ack(lease, cur, 0, "persisted"); applied(acked);
  const afterAck = await snapshot(lease.jobId);
  const ackTampers: [string, (m: any) => void][] = [ // eslint-disable-line @typescript-eslint/no-explicit-any
    ["acquittement + nouvelle tentative", (m) => { m.candidates[1].attempts.push({ ...freshAttempt(cur, 1) }); m.candidates[1].current_attempt_id = m.candidates[1].attempts[1].attempt_id; m.candidates[1].status = "pending"; }],
    ["acquittement + candidat modifié", (m) => { m.candidates[0].candidate_version = 9; }],
    ["acquittement + curseur modifié", (m) => { m.cursor_out = C3; }],
    ["acquittement + statut résolu réécrit", (m) => { m.candidates[0].attempts[1].status = "replayed"; m.candidates[0].status = "replayed"; }],
  ];
  for (const [label, change] of ackTampers) {
    const base2 = acked.next;
    const next = tamper(acknowledgeCandidateAttempt(base2, base2.candidates[1].candidate_id, base2.candidates[1].current_attempt_id, "persisted"), (m) => { change(m); });
    const candidate = next.candidates[1];
    if (candidate.status === "pending") continue;
    const result = await acknowledgeCandidate({
      pool, lease, expectedChunkId: base2.chunk_id, expectedManifestVersion: base2.manifest_version, nextManifest: next,
      candidateId: candidate.candidate_id, attemptId: candidate.current_attempt_id, status: "persisted",
    });
    assert.deepEqual(result, { kind: "rejected", reason: "invalid_next_manifest" }, label);
    assert.deepEqual(await snapshot(lease.jobId), afterAck, label);
  }
});

test("complétion : not_ready sans chunk validé ou sans is_eof", async () => {
  const lease = await claimJob();
  assert.equal(await completeChunkedJob({ pool, lease }), "not_ready", "aucun chunk");
  const base = mk({ n: 1, cursorOut: C1 });
  assert.deepEqual(await init(lease, base), { kind: "applied" });
  assert.equal(await completeChunkedJob({ pool, lease }), "not_ready", "chunk initialized");
  const acked = await ack(lease, base, 0, "persisted"); applied(acked);
  assert.equal(await completeChunkedJob({ pool, lease }), "not_ready", "chunk processing");
  const validated = await validate(lease, acked.next); applied(validated);
  const before = await snapshot(lease.jobId);
  assert.equal(await completeChunkedJob({ pool, lease }), "not_ready", "chunk validated mais is_eof faux");
  assert.deepEqual(await snapshot(lease.jobId), before);
  await runChunk(lease, mk({ n: 1, pred: validated.next, cursorIn: C1, cursorOut: null }), ["persisted"]);
  assert.equal(await completeChunkedJob({ pool, lease }), "completed");
});

test("validation avant SQL : aucune requête pour un pool, un bail ou un manifeste invalide", async () => {
  const lease = await claimJob();
  const base = mk({ n: 2, cursorOut: C1 });
  const acked = acknowledgeCandidateAttempt(base, base.candidates[0].candidate_id, base.candidates[0].current_attempt_id, "persisted");
  const allResolved = acknowledgeCandidateAttempt(acked, acked.candidates[1].candidate_id, acked.candidates[1].current_attempt_id, "persisted");
  const validated = validateChunkManifest(allResolved);
  const appended = appendCandidateAttempt(base, base.candidates[0].candidate_id, freshAttempt(base, 0));
  const candidate = acked.candidates[0];
  const { spy, count } = spyPool();
  const bad = (call: () => Promise<unknown>) => assert.rejects(call);
  const cas = { pool: spy, lease, expectedChunkId: base.chunk_id, expectedManifestVersion: 1 };

  // Pool, bail, durée.
  let foreign = 0;
  const client = await pool.connect();
  const original = client.query.bind(client);
  (client as unknown as { query: unknown }).query = (...args: unknown[]) => { foreign++; return (original as (...a: unknown[]) => unknown)(...args); };
  const arbitrary = { query: async () => { foreign++; throw new Error("unexpected"); } };
  const duck = { ...arbitrary, connect: async () => { foreign++; throw new Error("unexpected"); } };
  try {
    for (const bogus of [client, arbitrary, duck, undefined, null]) {
      const options = { ...cas, pool: bogus as never };
      await bad(() => initializeChunk({ pool: bogus as never, lease, manifest: base }));
      await bad(() => recordCandidateAttempt({ ...options, nextManifest: appended, attemptId: appended.candidates[0].current_attempt_id }));
      await bad(() => acknowledgeCandidate({ ...options, nextManifest: acked, candidateId: candidate.candidate_id, attemptId: candidate.current_attempt_id, status: "persisted" }));
      await bad(() => validateChunk({ ...options, nextManifest: validated }));
      await bad(() => completeChunkedJob({ pool: bogus as never, lease }));
      await bad(() => readChunkState({ pool: bogus as never, jobId: lease.jobId }));
    }
  } finally { client.release(); }
  assert.equal(foreign, 0);
  for (const badLease of [null, { ...lease, jobId: "nope" }, { ...lease, claimToken: undefined }]) {
    await bad(() => initializeChunk({ pool: spy, lease: badLease as never, manifest: base }));
    await bad(() => completeChunkedJob({ pool: spy, lease: badLease as never }));
  }
  for (const leaseSeconds of [14, 601, 15.5, null as never]) {
    await bad(() => initializeChunk({ pool: spy, lease, manifest: base, leaseSeconds }));
    await bad(() => validateChunk({ ...cas, nextManifest: validated, leaseSeconds }));
  }
  await bad(() => readChunkState({ pool: spy, jobId: "nope" }));

  // Manifestes et paramètres CAS.
  const withKey = tamper(base, (m) => { m.extra = true; });
  await bad(() => initializeChunk({ pool: spy, lease, manifest: withKey }));
  await bad(() => initializeChunk({ pool: spy, lease, manifest: acked }));
  await bad(() => initializeChunk({ pool: spy, lease, manifest: validated }));
  await bad(() => initializeChunk({ pool: spy, lease, manifest: tamper(base, (m) => { m.candidates[0].attempts.push(m.candidates[0].attempts[0]); }) }));
  await bad(() => validateChunk({ ...cas, nextManifest: tamper(validated, (m) => { m.manifest_version = 99; }) }));
  await bad(() => validateChunk({ ...cas, nextManifest: tamper(validated, (m) => { m.chunk_id = randomUUID(); }) }));
  await bad(() => validateChunk({ ...cas, expectedManifestVersion: 0, nextManifest: validated }));
  await bad(() => validateChunk({ ...cas, expectedManifestVersion: 1.5, nextManifest: validated }));
  await bad(() => validateChunk({ ...cas, expectedChunkId: "nope", nextManifest: validated }));
  await bad(() => validateChunk({ ...cas, nextManifest: appended }));
  await bad(() => validateChunk({ ...cas, nextManifest: { ...validated, state: "validated", candidates: [{}] } as never }));
  await bad(() => recordCandidateAttempt({ ...cas, nextManifest: acked, attemptId: appended.candidates[0].current_attempt_id }));
  await bad(() => recordCandidateAttempt({ ...cas, nextManifest: appended, attemptId: randomUUID() }));
  await bad(() => recordCandidateAttempt({ ...cas, nextManifest: appended, attemptId: "nope" }));
  await bad(() => acknowledgeCandidate({ ...cas, nextManifest: acked, candidateId: candidate.candidate_id, attemptId: candidate.current_attempt_id, status: "pending" as never }));
  await bad(() => acknowledgeCandidate({ ...cas, nextManifest: acked, candidateId: candidate.candidate_id, attemptId: candidate.current_attempt_id, status: "replayed" }));
  await bad(() => acknowledgeCandidate({ ...cas, nextManifest: acked, candidateId: randomUUID(), attemptId: candidate.current_attempt_id, status: "persisted" }));
  await bad(() => acknowledgeCandidate({ ...cas, nextManifest: appended, candidateId: candidate.candidate_id, attemptId: candidate.current_attempt_id, status: "persisted" }));
  await bad(() => acknowledgeCandidate({ ...cas, previousManifest: tamper(base, (m) => { m.manifest_version = 7; }), nextManifest: acked, candidateId: candidate.candidate_id, attemptId: candidate.current_attempt_id, status: "persisted" }));
  assert.equal(count(), 0);
});

test("liaison au job : R1 à R5, type de job et configuration NULL rejetés, job strictement inchangé", async () => {
  const lease = await claimJob();
  const row0 = async () => snapshot(lease.jobId);
  const rejectedWith = async (manifest: ChunkManifest, reason: string, label: string) => {
    const before = await row0();
    assert.deepEqual(await init(lease, manifest), { kind: "rejected", reason }, label);
    assert.deepEqual(await row0(), before, label);
  };

  // R1 : chunk 0 dont cursor_in n'est pas nul (des pages seraient sautées).
  await rejectedWith(mk({ n: 1, cursorIn: C1, cursorOut: C2 }), "cursor_discontinuity", "R1");
  // R1 bis : job vierge dont cursor_position n'est pas nul.
  await pool.query("UPDATE matching_jobs SET cursor_position = $2 WHERE id = $1", [lease.jobId, C1]);
  await rejectedWith(mk({ n: 1, cursorOut: C2 }), "cursor_discontinuity", "R1 bis");
  await pool.query("UPDATE matching_jobs SET cursor_position = NULL WHERE id = $1", [lease.jobId]);

  // R4 : configuration différente de celle du job.
  const foreignConfig = buildInitialChunkManifest({
    chunkId: randomUUID(), chunkIndex: 0, cursorIn: null, cursorOut: C1, evaluatedAt: new Date(), scoringConfigHash: "c".repeat(64),
    engineOfflineVersion: "matching-offline/v1", engineScoringVersion: "matching-scoring/v1", candidates: [],
  });
  await rejectedWith(foreignConfig, "config_mismatch", "R4");
  // Un job dont scoring_config_hash est NULL est refusé, même avec le hash qu'il portait.
  await pool.query("UPDATE matching_jobs SET scoring_config_hash = NULL WHERE id = $1", [lease.jobId]);
  await rejectedWith(mk({ n: 1, cursorOut: C1 }), "config_mismatch", "job sans scoring_config_hash");
  await pool.query("UPDATE matching_jobs SET scoring_config_hash = $2 WHERE id = $1", [lease.jobId, bound.hash]);

  // R5 : pivot ou version de candidat différents de ceux du job.
  const wrongPair = tamper(mk({ n: 2, cursorOut: C1 }), (m) => { m.candidates[1].pair_resource_id = randomUUID(); });
  await rejectedWith(wrongPair, "pair_resource_mismatch", "R5 pair_resource_id");
  const wrongVersion = tamper(mk({ n: 2, cursorOut: C1 }), (m) => { m.candidates[0].pair_resource_version = bound.resourceVersion + 1; });
  await rejectedWith(wrongVersion, "pair_resource_mismatch", "R5 pair_resource_version");

  // R3 : le curseur n'avance pas — refusé avant tout SQL (module pur), job inchangé.
  const { spy, count } = spyPool();
  const before = await row0();
  const stuck = { ...mk({ n: 1, cursorOut: C1 }), cursor_in: C1, cursor_out: C1, is_eof: false };
  await assert.rejects(initializeChunk({ pool: spy, lease, manifest: stuck }), /strictement après cursor_in/);
  const backwards = { ...mk({ n: 1, cursorOut: C1 }), cursor_in: C2, cursor_out: C1, is_eof: false };
  await assert.rejects(initializeChunk({ pool: spy, lease, manifest: backwards }), /strictement après cursor_in/);
  assert.equal(count(), 0);
  assert.deepEqual(await row0(), before);

  // Le manifeste lié au job est accepté.
  assert.deepEqual(await init(lease, mk({ n: 2, cursorOut: C1 })), { kind: "applied" });
});

test("liaison au job : R2 (cursor_in ≠ cursor_out du prédécesseur ou ≠ cursor_position), R3 sur chunk N", async () => {
  const lease = await claimJob();
  const chunk0 = await runChunk(lease, mk({ n: 1, cursorOut: C1 }), ["persisted"]);
  const frozen = async () => snapshot(lease.jobId);
  const before = await frozen();

  // cursor_in ≠ cursor_out du prédécesseur : des pages seraient sautées.
  assert.deepEqual(await init(lease, mk({ n: 1, pred: chunk0, cursorIn: C2, cursorOut: C3 })), { kind: "rejected", reason: "cursor_discontinuity" });
  assert.deepEqual(await frozen(), before);

  // cursor_in = cursor_out du prédécesseur mais ≠ cursor_position du job.
  await pool.query("UPDATE matching_jobs SET cursor_position = $2 WHERE id = $1", [lease.jobId, C2]);
  const diverged = await frozen();
  assert.deepEqual(await init(lease, mk({ n: 1, pred: chunk0, cursorIn: C1, cursorOut: C3 })), { kind: "rejected", reason: "cursor_discontinuity" });
  assert.deepEqual(await frozen(), diverged);
  // cursor_in = cursor_position du job mais ≠ cursor_out du prédécesseur (isole la condition sur le prédécesseur).
  assert.deepEqual(await init(lease, mk({ n: 1, pred: chunk0, cursorIn: C2, cursorOut: C3 })), { kind: "rejected", reason: "cursor_discontinuity" });
  assert.deepEqual(await frozen(), diverged);
  await pool.query("UPDATE matching_jobs SET cursor_position = NULL WHERE id = $1", [lease.jobId]);
  assert.deepEqual(await init(lease, mk({ n: 1, pred: chunk0, cursorIn: C1, cursorOut: C3 })), { kind: "rejected", reason: "cursor_discontinuity" });
  await pool.query("UPDATE matching_jobs SET cursor_position = $2 WHERE id = $1", [lease.jobId, C1]);
  assert.deepEqual(await frozen(), before);

  // Curseur qui n'avance pas sur un chunk N : refusé par le module pur.
  const { spy, count } = spyPool();
  const stuck = { ...mk({ n: 1, pred: chunk0, cursorIn: C1, cursorOut: C2 }), cursor_out: C1 };
  await assert.rejects(initializeChunk({ pool: spy, lease, manifest: stuck }), /strictement après cursor_in/);
  assert.equal(count(), 0);
  assert.deepEqual(await frozen(), before);

  // R5 sur un chunk N, et configuration divergente sur un chunk N.
  const wrongPair = tamper(mk({ n: 1, pred: chunk0, cursorIn: C1, cursorOut: C2 }), (m) => { m.candidates[0].pair_resource_id = randomUUID(); });
  assert.deepEqual(await init(lease, wrongPair), { kind: "rejected", reason: "pair_resource_mismatch" });
  assert.deepEqual(await frozen(), before);
  assert.deepEqual(await init(lease, mk({ n: 1, pred: chunk0, cursorIn: C1, cursorOut: C2 })), { kind: "applied" });
});

test("liaison au job : un job d'un autre type (user_reactivation_sweep) est refusé", async () => {
  await pool.query("DELETE FROM matching_jobs");
  await pool.query("DELETE FROM matching_outbox_events");
  const user = await createUser({}, pool);
  const suspended = await updateUser({ id: user.id, expectedVersion: user.version, status: "suspended" }, pool);
  await updateUser({ id: user.id, expectedVersion: suspended.version, status: "active" }, pool);
  assert.equal((await projectOutboxBatch({ pool })).jobsInserted, 1);
  const [lease] = await claimMatchingJobs({ pool, workerId: "w1", limit: 1 });
  assert.equal(lease.jobType, "user_reactivation_sweep");
  // Manifeste par ailleurs parfaitement lié au job (ressource, version, configuration) : seul le type est en cause.
  Object.assign(bound, { resourceId: lease.resourceId, resourceVersion: lease.resourceVersion, hash: lease.scoringConfigHash });
  const before = await snapshot(lease.jobId);
  assert.deepEqual(await init(lease, mk({ n: 1, cursorOut: C1 })), { kind: "rejected", reason: "unsupported_job_type" });
  assert.deepEqual(await snapshot(lease.jobId), before);
});

test("liaison au job : trois pages enchaînées (cursor_in = cursor_out précédent = cursor_position), rejeu identique", async () => {
  const lease = await claimJob();
  const first = mk({ n: 2, cursorOut: C1 });
  assert.equal(first.cursor_in, null);
  const chunk0 = await runChunk(lease, first, ["persisted", "replayed"]);
  assert.equal((await jobRow(lease.jobId)).cursor_position, chunk0.cursor_out);

  const second = mk({ n: 2, pred: chunk0, cursorIn: chunk0.cursor_out, cursorOut: C2 });
  assert.equal(second.cursor_in, chunk0.cursor_out);
  assert.equal(second.cursor_in, (await jobRow(lease.jobId)).cursor_position);
  const chunk1 = await runChunk(lease, second, ["persisted", "persisted"]);
  assert.equal((await jobRow(lease.jobId)).cursor_position, chunk1.cursor_out);

  const third = mk({ n: 1, pred: chunk1, cursorIn: chunk1.cursor_out, cursorOut: null });
  assert.equal(third.cursor_in, (await jobRow(lease.jobId)).cursor_position);
  assert.deepEqual(await init(lease, third), { kind: "applied" });
  // Rejeu identique d'une initialisation réussie : already_applied, jamais un rejet, même après d'autres opérations.
  assert.deepEqual(await init(lease, third), { kind: "already_applied" });
  const acked = await ack(lease, third, 0, "persisted"); applied(acked);
  assert.deepEqual(await init(lease, third), { kind: "already_applied" });
  const validated = await validate(lease, acked.next); applied(validated);
  assert.deepEqual(await init(lease, third), { kind: "already_applied" });
  assert.deepEqual(await init(lease, second), { kind: "rejected", reason: "eof_reached" }, "chunk antérieur rejoué après EOF");
  const row = await jobRow(lease.jobId);
  assert.equal(row.cursor_position, C2, "dernière page : curseur inchangé");
  assert.equal(row.processed_candidates_count, 5);
  assert.equal(await completeChunkedJob({ pool, lease }), "completed");
});
