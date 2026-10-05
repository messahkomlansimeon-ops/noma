import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { before, after, test } from "node:test";
import { Pool } from "pg";
import { createDemand, createOffer, createUser, publishOffer, updateOffer, updateUser } from "../../lib/server/catalog";
import { MatchingJobValidationError } from "../../lib/server/matching/jobs";
import { PROJECTABLE_EVENT_TYPES } from "../../lib/server/matching/projection";
import {
  MATCHING_RUNNER_JOB_TYPES, runMatchingCycle, runMatchingWorkerLoop, type MatchingCycleResult,
} from "../../lib/server/matching/runner";
import { runMigrations } from "../../lib/server/postgres/migrations";
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
  assert.equal((await runMigrations(pool)).applied.length, 10);
});

after(async () => {
  for (const db of [second, pool]) if (db) await db.end();
  if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${quoted} CASCADE`); await admin.end(); }
});

// ───────────── données catalogue réelles ─────────────

const resetAll = () => pool.query(
  "TRUNCATE matching_evaluations, matching_jobs, matching_outbox_events, demands, offers, users CASCADE");

const offerInput = (ownerId: string, extra: Record<string, unknown> = {}) => ({
  ownerId, rawText: "iPhone 13 128Go avec chargeur", category: "smartphones", brand: "Apple", model: "iPhone 13",
  attributes: { charger_included: true }, price: { amount: 250_000, currency: "XOF" }, status: "published" as const, ...extra,
});

const demandInput = (ownerId: string, extra: Record<string, unknown> = {}) => ({
  ownerId, rawText: "Cherche iPhone 13", category: "smartphones", brand: "Apple", model: "iPhone 13",
  requirements: [{ key: "chargeur", operator: "includes", value: "chargeur" }],
  budget: { amount: 300_000, currency: "XOF" }, status: "active" as const, ...extra,
});

/** Vendeurs et acheteurs réels, sans projection : c'est le cycle qui projette. */
async function simpleWorld(sellers = 2, buyers = 2) {
  await resetAll();
  const offers = [], demands = [];
  for (let i = 0; i < sellers; i++) offers.push(await createOffer(offerInput((await createUser({}, pool)).id, { rawText: `iPhone 13 n°${i}` }), pool));
  for (let i = 0; i < buyers; i++) demands.push(await createDemand(demandInput((await createUser({}, pool)).id, { rawText: `Cherche iPhone 13 n°${i}` }), pool));
  return { offers, demands };
}

// ───────────── aides ─────────────

const SUPPORTED = ["evaluate_offer_candidates", "evaluate_demand_candidates", "user_reactivation_sweep"];
const jobs = async () => (await pool.query("SELECT * FROM matching_jobs ORDER BY created_at, id")).rows;
const pendingProjectable = async () => Number((await pool.query(
  "SELECT count(*) AS n FROM matching_outbox_events WHERE dispatch_status = 'pending' AND event_type = ANY($1::text[])",
  [PROJECTABLE_EVENT_TYPES])).rows[0].n);
const duplicateActivePairs = async () => (await pool.query(
  "SELECT offer_id, demand_id, count(*) FROM matching_evaluations WHERE is_latest GROUP BY offer_id, demand_id HAVING count(*) > 1")).rows;

async function cyclesUntilIdle(db: Pool = pool, workerId = "runner-a", maxJobs?: number): Promise<MatchingCycleResult[]> {
  const results: MatchingCycleResult[] = [];
  for (let i = 0; i < 60; i++) {
    const result = await runMatchingCycle({ pool: db, workerId, maxJobs });
    results.push(result);
    if (result.idle) return results;
  }
  assert.fail("le travail ne se termine pas : trop de cycles");
}

/** Pool dont `query` et `connect` sont observables ; `onQuery` peut déclencher un effet ou une panne. */
function observedPool(base: Pool, hooks: { onQuery?: (text: string, params: unknown[] | undefined) => void; failConnect?: () => Error | null } = {}) {
  let queries = 0;
  const spy = Object.create(base) as Pool;
  spy.query = ((...args: unknown[]) => {
    queries++;
    hooks.onQuery?.(typeof args[0] === "string" ? args[0] : "", Array.isArray(args[1]) ? args[1] : undefined);
    return (base.query as (...a: unknown[]) => unknown)(...args);
  }) as never;
  spy.connect = ((...args: unknown[]) => {
    queries++;
    const failure = hooks.failConnect?.();
    if (failure) return Promise.reject(failure);
    return (base.connect as (...a: unknown[]) => unknown)(...args);
  }) as never;
  return { spy, count: () => queries };
}

// ───────────── 9. bout en bout ─────────────

test("bout en bout : création, publication, modification, réactivation, puis cycles jusqu'à idle", async () => {
  await resetAll();
  const seller1 = await createUser({}, pool), seller2 = await createUser({}, pool);
  const buyer1 = await createUser({}, pool), buyer2 = await createUser({}, pool);
  const draft = await createOffer(offerInput(seller1.id, { status: "draft" }), pool);
  const published = await publishOffer(seller1.id, draft.id, draft.contentVersion, pool);
  const offer2 = await createOffer(offerInput(seller1.id, { rawText: "iPhone 13 pro" }), pool);
  await updateOffer({ id: offer2.id, ownerId: seller1.id, expectedContentVersion: offer2.contentVersion, changes: { rawText: "iPhone 13 pro max" } }, pool);
  await createOffer(offerInput(seller2.id), pool);
  await createDemand(demandInput(buyer1.id), pool);
  await createDemand(demandInput(buyer1.id, { rawText: "Cherche iPhone 13 bis" }), pool);
  await createDemand(demandInput(buyer2.id), pool);
  const suspended = await updateUser({ id: seller1.id, expectedVersion: seller1.version, status: "suspended" }, pool);
  await updateUser({ id: seller1.id, expectedVersion: suspended.version, status: "active" }, pool);
  assert.ok(published.contentVersion >= 2);

  assert.ok(await pendingProjectable() > 0);
  const results = await cyclesUntilIdle();
  assert.equal(results.at(-1)!.idle, true);
  assert.ok(results.some((result) => result.jobs.some((job) => job.jobType === "user_reactivation_sweep" && job.outcome === "completed")));

  assert.equal(await pendingProjectable(), 0, "plus aucun événement projetable en attente");
  const all = await jobs();
  assert.ok(all.length > 0);
  assert.equal(all.filter((job) => SUPPORTED.includes(job.job_type) && (job.status === "pending" || job.status === "running")).length, 0);
  assert.equal(all.filter((job) => job.status === "failed" || job.status === "dead_letter").length, 0);
  assert.ok(all.every((job) => job.status === "completed" || job.status === "superseded"));
  assert.ok(all.filter((job) => job.status === "completed").length >= 6);

  const evaluations = (await pool.query("SELECT count(*) AS n FROM matching_evaluations")).rows[0].n;
  assert.ok(Number(evaluations) > 0, "des évaluations existent");
  assert.deepEqual(await duplicateActivePairs(), [], "aucun doublon actif par paire");
  const active = Number((await pool.query("SELECT count(*) AS n FROM matching_evaluations WHERE is_latest")).rows[0].n);
  assert.equal(active, 3 * 3, "3 offres publiées × 3 demandes : chaque paire est évaluée, une seule fois active");
  assert.equal(results.reduce((sum, result) => sum + result.maintenance.deadLettered, 0), 0);
});

test("les cycles réservent un seul job à la fois : claim limit 1, avec les trois types, jamais deux jobs en cours", async () => {
  await simpleWorld(3, 3);
  const claims: Array<{ limit: unknown; types: unknown }> = [];
  const { spy } = observedPool(pool, {
    onQuery: (text, params) => { if (text.includes("WITH claimable")) claims.push({ limit: params?.[0], types: params?.[3] }); },
  });
  const results: MatchingCycleResult[] = [];
  for (let i = 0; i < 20; i++) {
    const result = await runMatchingCycle({ pool: spy, workerId: "runner-a" });
    results.push(result);
    if (result.idle) break;
  }
  const executed = results.flatMap((result) => result.jobs);
  assert.equal(executed.length, 6);
  assert.ok(claims.length >= executed.length + 1, "au moins une réservation vide termine le cycle");
  for (const claim of claims) {
    assert.equal(claim.limit, 1);
    assert.deepEqual(claim.types, [...MATCHING_RUNNER_JOB_TYPES]);
  }
  assert.ok((await jobs()).every((row) => row.status === "completed"));
});

// ───────────── 10. types exclus ─────────────

test("reevaluate_pair_temporal et scoring_config_sweep restent pending, jamais réservés", async () => {
  await simpleWorld(1, 1);
  const insert = (type: string) => pool.query(
    `INSERT INTO matching_jobs (job_identity, job_type, resource_id, resource_version, target_resource_id)
     VALUES ($1, $2, $3, 1, $4)`,
    [randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", ""), type, randomUUID(), type === "reevaluate_pair_temporal" ? randomUUID() : null]);
  await insert("reevaluate_pair_temporal");
  await insert("scoring_config_sweep");
  const results = await cyclesUntilIdle();
  assert.ok(results.flatMap((result) => result.jobs).length >= 2, "les jobs d'évaluation sont exécutés");
  const rows = (await jobs()).filter((job) => job.job_type === "reevaluate_pair_temporal" || job.job_type === "scoring_config_sweep");
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(row.status, "pending");
    assert.equal(row.attempts, 0);
    assert.equal(row.locked_by, null);
  }
});

// ───────────── 11. maintenance ─────────────

test("maintenance : un job épuisé dans un état bloqué passe en dead_letter pendant un cycle", async () => {
  await resetAll();
  const insert = (identityChar: string, status: string) => pool.query(
    `INSERT INTO matching_jobs (job_identity, job_type, resource_id, resource_version, status, attempts, max_attempts,
                                locked_by, locked_at, lock_expires_at, claim_token, scheduled_at)
     VALUES ($1, 'evaluate_offer_candidates', $2, 1, $3, 5, 5,
             $4, $5, $6, $7, clock_timestamp() - interval '1 hour')`,
    [identityChar.repeat(64), randomUUID(), status,
      status === "running" ? "ghost" : null,
      status === "running" ? new Date(Date.now() - 3_600_000) : null,
      status === "running" ? new Date(Date.now() - 60_000) : null,
      status === "running" ? randomUUID() : null]);
  await insert("a", "running");
  await insert("b", "failed");
  const result = await runMatchingCycle({ pool, workerId: "runner-a" });
  assert.equal(result.maintenance.deadLettered, 2);
  assert.equal(result.jobs.length, 0, "un job épuisé n'est jamais réservé");
  assert.equal(result.idle, false, "la maintenance compte comme travail");
  const rows = await jobs();
  assert.deepEqual(rows.map((row) => row.status), ["dead_letter", "dead_letter"]);
  assert.ok(rows.every((row) => row.claim_token === null && row.completed_at !== null));
});

// ───────────── 12. arrêt propre ─────────────

test("AbortSignal déclenché PENDANT un job : ce job se termine, aucun autre n'est réservé, la boucle rend la main", async () => {
  await simpleWorld(2, 2);
  const controller = new AbortController();
  let aborted = 0;
  const { spy } = observedPool(pool, {
    onQuery: (text) => {
      // Lecture de la configuration scellée : le premier job vient d'être réservé et commence.
      if (text.includes("SELECT payload FROM matching_outbox_events") && !controller.signal.aborted) { aborted++; controller.abort(); }
    },
  });
  let sleeps = 0;
  const result = await runMatchingWorkerLoop({
    pool: spy, workerId: "runner-a", signal: controller.signal,
    sleep: async () => { sleeps++; },
  });
  assert.equal(aborted, 1);
  assert.deepEqual(result, { cycles: 1, jobsRun: 1 });
  assert.equal(sleeps, 0);
  const rows = await jobs();
  assert.equal(rows.filter((row) => row.status === "completed").length, 1, "le job en cours est terminé, non abandonné");
  assert.equal(rows.filter((row) => row.status === "running").length, 0);
  assert.equal(rows.filter((row) => row.status === "pending").length, rows.length - 1, "aucun autre job réservé");
  assert.ok((await pool.query("SELECT count(*) AS n FROM matching_evaluations")).rows[0].n > 0);
});

test("signal déjà déclenché : la boucle ne lance aucun cycle", async () => {
  await simpleWorld(1, 1);
  const controller = new AbortController();
  controller.abort();
  const { spy, count } = observedPool(pool);
  assert.deepEqual(await runMatchingWorkerLoop({ pool: spy, workerId: "runner-a", signal: controller.signal }), { cycles: 0, jobsRun: 0 });
  assert.equal(count(), 0);
});

test("signal déclenché pendant l'attente : la boucle sort sans attendre le délai", async () => {
  await resetAll();
  const controller = new AbortController();
  const started = Date.now();
  const loop = runMatchingWorkerLoop({ pool, workerId: "runner-a", signal: controller.signal, idleDelayMs: 20_000, maxIdleDelayMs: 20_000 });
  await new Promise((resolve) => setTimeout(resolve, 300));
  controller.abort();
  const result = await loop;
  assert.ok(Date.now() - started < 5_000, "l'attente par défaut est interrompue par le signal");
  assert.equal(result.jobsRun, 0);
  assert.ok(result.cycles >= 1);
});

// ───────────── 13. délai d'inactivité ─────────────

test("délai d'inactivité croissant (×2, borné) puis remis au minimum après un cycle utile", async () => {
  await resetAll();
  const controller = new AbortController();
  const delays: number[] = [];
  const cycleLog: boolean[] = [];
  const result = await runMatchingWorkerLoop({
    pool, workerId: "runner-a", signal: controller.signal, idleDelayMs: 100, maxIdleDelayMs: 300,
    onCycle: (cycle) => { cycleLog.push(cycle.idle); },
    sleep: async (ms) => {
      delays.push(ms);
      if (delays.length === 4) {
        // Du travail apparaît pendant l'attente : le cycle suivant travaille, puis le délai repart du minimum.
        const seller = await createUser({}, pool), buyer = await createUser({}, pool);
        await createOffer(offerInput(seller.id), pool);
        await createDemand(demandInput(buyer.id), pool);
      }
      if (delays.length === 7) controller.abort();
    },
  });
  assert.deepEqual(delays, [100, 200, 300, 300, 100, 200, 300]);
  assert.deepEqual(cycleLog, [true, true, true, true, false, true, true, true]);
  assert.equal(result.cycles, 8);
  assert.equal(result.jobsRun, 2);
});

// ───────────── 14. erreur de cycle ─────────────

test("erreur de cycle (base indisponible) : journalisée par code stable, la boucle continue", async () => {
  await simpleWorld(1, 1);
  const failures = [Object.assign(new Error("connect ECONNREFUSED 10.0.0.1 secret-owner-id"), { code: "57P01" }), new Error("texte brut du propriétaire")];
  const { spy } = observedPool(pool, { failConnect: () => failures.shift() ?? null });
  const logs: string[] = [];
  const delays: number[] = [];
  const controller = new AbortController();
  const result = await runMatchingWorkerLoop({
    pool: spy, workerId: "runner-a", signal: controller.signal, idleDelayMs: 50, maxIdleDelayMs: 400,
    log: (line) => logs.push(line),
    sleep: async (ms) => { delays.push(ms); },
    onCycle: (cycle) => { if (cycle.jobs.length > 0) controller.abort(); },
  });
  assert.deepEqual(logs, ["matching_worker cycle_error_57p01", "matching_worker cycle_error_unknown"]);
  assert.ok(logs.every((line) => !/secret|ECONNREFUSED|propriétaire/.test(line)), "ni message d'erreur ni identifiant dans le journal");
  assert.deepEqual(delays, [50, 100], "une attente (croissante) suit chaque erreur");
  assert.ok(result.jobsRun >= 1, "la boucle a survécu et travaillé");
  assert.equal(result.cycles >= 1, true);
});

// ───────────── 15. concurrence ─────────────

test("deux boucles concurrentes (deux pools) : chaque job exécuté une seule fois, aucun doublon actif", async () => {
  await simpleWorld(4, 4);
  const run = (db: Pool, workerId: string) => {
    const controller = new AbortController();
    return runMatchingWorkerLoop({
      pool: db, workerId, signal: controller.signal, maxJobsPerCycle: 2,
      sleep: async () => {},
      onCycle: (cycle) => { if (cycle.idle) controller.abort(); },
    });
  };
  const [a, b] = await Promise.all([run(pool, "runner-a"), run(second, "runner-b")]);
  const rows = await jobs();
  assert.equal(rows.length, 8, "un job par ressource créée");
  assert.ok(rows.every((row) => row.status === "completed" && row.attempts === 1), "chaque job exécuté exactement une fois");
  assert.equal(a.jobsRun + b.jobsRun, 8);
  assert.equal(await pendingProjectable(), 0);
  assert.deepEqual(await duplicateActivePairs(), []);
  const active = Number((await pool.query("SELECT count(*) AS n FROM matching_evaluations WHERE is_latest")).rows[0].n);
  assert.equal(active, 16, "4 offres × 4 demandes, une évaluation active par paire");
});

// ───────────── 16. validation avant SQL ─────────────

test("validation avant SQL : cycle et boucle refusent les paramètres invalides sans aucune requête", async () => {
  const { spy, count } = observedPool(pool);
  const controller = new AbortController();
  const base = { pool: spy, workerId: "runner-a" };
  const cycleCases: Array<[string, Record<string, unknown>]> = [
    ["pool absent", { ...base, pool: undefined }],
    ["pool arbitraire", { ...base, pool: { query: async () => ({ rows: [] }) } }],
    ["workerId vide", { ...base, workerId: "" }],
    ["workerId invalide", { ...base, workerId: "bad id!" }],
    ["workerId trop long", { ...base, workerId: "a".repeat(129) }],
    ["workerId non texte", { ...base, workerId: 12 }],
    ...[0, 51, 1.5, -1, Number.NaN, "5", null].map((maxJobs): [string, Record<string, unknown>] => [`maxJobs ${String(maxJobs)}`, { ...base, maxJobs }]),
    ...[0, 101, 2.5].map((projectionLimit): [string, Record<string, unknown>] => [`projectionLimit ${projectionLimit}`, { ...base, projectionLimit }]),
    ...[0, 101, null].map((pageSize): [string, Record<string, unknown>] => [`pageSize ${String(pageSize)}`, { ...base, pageSize }]),
    ["signal invalide", { ...base, signal: {} }],
    ["leaseSeconds trop court", { ...base, leaseSeconds: 3 }],
  ];
  for (const [name, options] of cycleCases) {
    await assert.rejects(() => runMatchingCycle(options as never), MatchingJobValidationError, `cycle : ${name}`);
  }
  const loopBase = { ...base, signal: controller.signal };
  const loopCases: Array<[string, Record<string, unknown>]> = [
    ["pool absent", { ...loopBase, pool: undefined }],
    ["workerId invalide", { ...loopBase, workerId: "x y" }],
    ["signal absent", { ...base }],
    ["signal arbitraire", { ...base, signal: { aborted: false } }],
    ...[0, -5, 1.5, "100", null, 3_600_001].map((idleDelayMs): [string, Record<string, unknown>] => [`idleDelayMs ${String(idleDelayMs)}`, { ...loopBase, idleDelayMs }]),
    ["maxIdleDelayMs < idleDelayMs", { ...loopBase, idleDelayMs: 500, maxIdleDelayMs: 100 }],
    ["maxIdleDelayMs trop grand", { ...loopBase, maxIdleDelayMs: 3_600_001 }],
    ...[0, 51, 1.5].map((maxJobsPerCycle): [string, Record<string, unknown>] => [`maxJobsPerCycle ${maxJobsPerCycle}`, { ...loopBase, maxJobsPerCycle }]),
    ["onCycle non fonction", { ...loopBase, onCycle: "x" }],
    ["sleep non fonction", { ...loopBase, sleep: 1 }],
    ["log non fonction", { ...loopBase, log: {} }],
  ];
  for (const [name, options] of loopCases) {
    await assert.rejects(() => runMatchingWorkerLoop(options as never), MatchingJobValidationError, `boucle : ${name}`);
  }
  assert.equal(count(), 0);
});
