import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { before, after, test } from "node:test";
import { Pool } from "pg";
import { createDemand, createOffer, createUser, publishOffer, updateOffer, updateUser } from "../../lib/server/catalog";
import { MatchingJobValidationError } from "../../lib/server/matching/jobs";
import { OUTBOX_COLUMNS, mapOutboxRow, type OutboxRow } from "../../lib/server/matching/outbox";
import { PROJECTABLE_EVENT_TYPES, planOutboxProjection, projectOutboxBatch } from "../../lib/server/matching/projection";
import {
  MATCHING_RUNNER_JOB_TYPES, runMatchingCycle, runMatchingWorkerLoop, type MatchingCycleResult,
} from "../../lib/server/matching/runner";
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
  assert.equal((await runMigrations(pool)).applied.length, 24);
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
function observedPool(base: Pool, hooks: { onQuery?: (text: string, params: unknown[] | undefined) => void; failConnect?: () => Error | null; failQuery?: (text: string) => Error | null } = {}) {
  let queries = 0;
  const spy = Object.create(base) as Pool;
  spy.query = ((...args: unknown[]) => {
    queries++;
    hooks.onQuery?.(typeof args[0] === "string" ? args[0] : "", Array.isArray(args[1]) ? args[1] : undefined);
    const queryFailure = hooks.failQuery?.(typeof args[0] === "string" ? args[0] : "");
    if (queryFailure) return Promise.reject(queryFailure);
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

test("scoring_config_sweep reste pending, jamais réservé (reevaluate_pair_temporal est exécuté depuis 2E4C2)", async () => {
  await simpleWorld(1, 1);
  await pool.query(
    `INSERT INTO matching_jobs (job_identity, job_type, resource_id, resource_version)
     VALUES ($1, 'scoring_config_sweep', $2, 1)`,
    [randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", ""), randomUUID()]);
  const results = await cyclesUntilIdle();
  assert.ok(results.flatMap((result) => result.jobs).length >= 2, "les jobs d'évaluation sont exécutés");
  const rows = (await jobs()).filter((job) => job.job_type === "scoring_config_sweep");
  assert.equal(rows.length, 1);
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
  // Depuis 2E4C2 chaque cycle ouvre d'abord une connexion pour le balayage temporel, puis une pour la projection :
  // deux pannes par cycle en erreur.
  const failures = [
    Object.assign(new Error("connect ECONNREFUSED 10.0.0.1 secret-owner-id"), { code: "57P01" }), new Error("texte brut du propriétaire"),
    Object.assign(new Error("connect ECONNREFUSED 10.0.0.1 secret-owner-id"), { code: "57P01" }), new Error("texte brut du propriétaire"),
  ];
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
  assert.deepEqual(logs, [
    "matching_worker temporal_error_57p01", "matching_worker projection_error_unknown",
    "matching_worker temporal_error_57p01", "matching_worker projection_error_unknown",
  ]);
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

// ───────────── 17. cloisonnement des étapes (2E4C1-bis) ─────────────

const failingFunction = () => pool.query(
  "CREATE OR REPLACE FUNCTION reject_runner_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'runner audit failure'; END $$");
const withTrigger = async (ddl: string, name: string, table: string, run: () => Promise<void>) => {
  await failingFunction();
  await pool.query(ddl);
  try { await run(); } finally { await pool.query(`DROP TRIGGER IF EXISTS ${name} ON ${table}`); }
};
const insertPending = async (kind: "offer" | "demand") => {
  const owner = await createUser({}, pool);
  return kind === "offer" ? createOffer(offerInput(owner.id, { rawText: "iPhone 13 supplémentaire" }), pool) : createDemand(demandInput(owner.id), pool);
};

test("événement empoisonné plus ancien : quarantaine, 2 jobs sains exécutés, job divergent intact, second cycle idle", async () => {
  await simpleWorld(1, 1);
  assert.equal((await projectOutboxBatch({ pool })).jobsInserted, 2, "deux jobs sains pending");
  const extra = await insertPending("offer");
  const row = (await pool.query<OutboxRow>(`SELECT ${OUTBOX_COLUMNS} FROM matching_outbox_events WHERE aggregate_id = $1`, [extra.id])).rows[0];
  const decision = planOutboxProjection(mapOutboxRow(row));
  assert.equal(decision.kind, "job");
  if (decision.kind !== "job") return;
  await pool.query(
    `INSERT INTO matching_jobs(job_identity, job_type, resource_id, resource_version, scoring_config_hash, source_event_id, status, completed_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'completed', clock_timestamp())`,
    [decision.job.jobIdentity, decision.job.jobType, decision.job.resourceId, decision.job.resourceVersion + 1, decision.job.scoringConfigHash, decision.job.sourceEventId]);
  await pool.query("UPDATE matching_outbox_events SET occurred_at = occurred_at - interval '1 hour' WHERE id = $1", [row.id]);
  const divergent = async () => (await pool.query("SELECT * FROM matching_jobs WHERE job_identity = $1", [decision.job.jobIdentity])).rows;
  const before = await divergent();

  const first = await runMatchingCycle({ pool, workerId: "runner-a" });
  assert.deepEqual(first.errors, []);
  assert.equal(first.projected.quarantined, 1);
  assert.equal(first.jobs.length, 2, "les deux jobs sains sont exécutés");
  assert.ok(first.jobs.every((job) => job.outcome === "completed"));
  assert.equal(first.idle, false);

  const event = (await pool.query("SELECT dispatch_status, error_message FROM matching_outbox_events WHERE id = $1", [row.id])).rows[0];
  assert.deepEqual(event, { dispatch_status: "ignored", error_message: "job_integrity_conflict" });
  assert.deepEqual(await divergent(), before, "le job divergent est inchangé");
  const healthy = (await jobs()).filter((job) => job.job_identity !== decision.job.jobIdentity);
  assert.equal(healthy.length, 2);
  assert.ok(healthy.every((job) => job.status === "completed"));

  const second = await runMatchingCycle({ pool, workerId: "runner-a" });
  assert.equal(second.idle, true);
  assert.deepEqual(second.errors, []);
});

test("projection en échec à chaque cycle (sans conflit d'intégrité) : jobs exécutés, projection_error rapportée, événement conservé puis projeté", async () => {
  await simpleWorld(1, 1);
  assert.equal((await projectOutboxBatch({ pool })).jobsInserted, 2);
  const extra = await insertPending("offer");
  await withTrigger(
    "CREATE TRIGGER reject_runner_ack BEFORE UPDATE ON matching_outbox_events FOR EACH ROW EXECUTE FUNCTION reject_runner_audit()",
    "reject_runner_ack", "matching_outbox_events", async () => {
      const first = await runMatchingCycle({ pool, workerId: "runner-a" });
      assert.deepEqual(first.errors, ["projection_error_p0001"]);
      assert.equal(first.jobs.length, 2, "les jobs pending sont exécutés malgré l'échec de la projection");
      assert.ok(first.jobs.every((job) => job.outcome === "completed"));
      assert.equal(first.idle, false);

      const second = await runMatchingCycle({ pool, workerId: "runner-a" });
      assert.deepEqual(second.errors, ["projection_error_p0001"], "la projection échoue encore");
      assert.equal(second.idle, true, "idle = aucun progrès, même avec des erreurs");
      const event = (await pool.query("SELECT dispatch_status, error_message FROM matching_outbox_events WHERE aggregate_id = $1", [extra.id])).rows[0];
      assert.deepEqual(event, { dispatch_status: "pending", error_message: null }, "l'événement reste pending");
    });

  const third = await runMatchingCycle({ pool, workerId: "runner-a" });
  assert.deepEqual(third.errors, []);
  assert.equal(third.projected.selected, 1);
  assert.equal(third.jobs.length, 1, "l'événement est projeté puis son job exécuté");
  assert.equal((await pool.query("SELECT dispatch_status FROM matching_outbox_events WHERE aggregate_id = $1", [extra.id])).rows[0].dispatch_status, "projected");
});

test("maintenance en échec : les jobs sont exécutés, maintenance_error rapportée", async () => {
  await simpleWorld(1, 1);
  await pool.query(
    `INSERT INTO matching_jobs (job_identity, job_type, resource_id, resource_version, status, attempts, max_attempts, scheduled_at)
     VALUES ($1, 'evaluate_offer_candidates', $2, 1, 'failed', 5, 5, clock_timestamp() - interval '1 hour')`,
    ["c".repeat(64), randomUUID()]);
  await withTrigger(
    "CREATE TRIGGER reject_runner_dead BEFORE UPDATE ON matching_jobs FOR EACH ROW WHEN (NEW.status = 'dead_letter') EXECUTE FUNCTION reject_runner_audit()",
    "reject_runner_dead", "matching_jobs", async () => {
      const result = await runMatchingCycle({ pool, workerId: "runner-a" });
      assert.deepEqual(result.errors, ["maintenance_error_p0001"]);
      assert.equal(result.projected.selected, 2, "la projection a eu lieu");
      assert.equal(result.jobs.length, 2);
      assert.ok(result.jobs.every((job) => job.outcome === "completed"));
      assert.equal((await jobs()).find((job) => job.job_identity === "c".repeat(64)).status, "failed", "le job épuisé n'a pas été modifié");
    });
  const after = await runMatchingCycle({ pool, workerId: "runner-a" });
  assert.deepEqual(after.errors, []);
  assert.equal(after.maintenance.deadLettered, 1);
});

test("exception pendant l'exécution d'un job : job_error rapportée, plus aucun job dans ce cycle", async () => {
  await simpleWorld(1, 1);
  let sealedReads = 0;
  const { spy } = observedPool(pool, {
    failQuery: (text) => {
      // Lecture de la configuration scellée du premier job, puis son enregistrement d'échec : la base « tombe ».
      if (text.includes("SELECT payload FROM matching_outbox_events") && ++sealedReads === 1) return Object.assign(new Error("hôte secret"), { code: "57P01" });
      if (text.includes("SET status = CASE WHEN attempts") && sealedReads === 1) return Object.assign(new Error("hôte secret"), { code: "57P01" });
      return null;
    },
  });
  const result = await runMatchingCycle({ pool: spy, workerId: "runner-a" });
  assert.deepEqual(result.errors, ["job_error_57p01"]);
  assert.equal(result.jobs.length, 0);
  assert.ok(!JSON.stringify(result).includes("secret"));
  const rows = await jobs();
  assert.equal(rows.filter((job) => job.status === "running").length, 1, "le bail du job en cours expirera normalement");
  assert.equal(rows.filter((job) => job.status === "pending" && job.attempts === 0).length, 1, "aucun autre job n'a été réservé");
});

test("boucle : projection toujours en échec et aucun job → délai croissant, jamais de boucle sans attente", async () => {
  await simpleWorld(1, 1);
  await withTrigger(
    "CREATE TRIGGER reject_runner_ack BEFORE UPDATE ON matching_outbox_events FOR EACH ROW EXECUTE FUNCTION reject_runner_audit()",
    "reject_runner_ack", "matching_outbox_events", async () => {
      const controller = new AbortController();
      const delays: number[] = [];
      const logs: string[] = [];
      const result = await runMatchingWorkerLoop({
        pool, workerId: "runner-a", signal: controller.signal, idleDelayMs: 100, maxIdleDelayMs: 300,
        log: (line) => logs.push(line),
        sleep: async (ms) => { delays.push(ms); if (delays.length === 4) controller.abort(); },
      });
      assert.deepEqual(delays, [100, 200, 300, 300]);
      assert.equal(result.cycles, delays.length, "chaque cycle sans progrès est suivi d'une attente");
      assert.equal(result.jobsRun, 0);
      assert.deepEqual(logs, Array(4).fill("matching_worker projection_error_p0001"));
    });
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

// ───────────── 18. script --once (2E4C3) ─────────────

test("script matching-worker --once sur un schéma temporaire : code 0 au cas nominal, code 1 et code stable si une étape échoue", async () => {
  await simpleWorld(1, 1);
  const nominal = await runScript("scripts/matching-worker.ts", ["--once"], schema);
  assert.equal(nominal.code, 0, nominal.output);
  assert.match(nominal.output, /un cycle, 0 évaluation\(s\) périmée\(s\), 2 événement\(s\) lu\(s\), 0 job\(s\) en dead_letter, 2 job\(s\) exécuté\(s\)\./);
  assert.ok(!nominal.output.includes("Matching worker : projection_error"));
  assert.equal((await jobs()).filter((job) => job.status === "completed").length, 2, "le vrai script a exécuté les jobs");

  await createOffer(offerInput((await createUser({}, pool)).id, { rawText: "iPhone 13 supplémentaire" }), pool);
  await pool.query("CREATE OR REPLACE FUNCTION reject_script_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'script audit failure'; END $$");
  await pool.query("CREATE TRIGGER reject_script_ack BEFORE UPDATE ON matching_outbox_events FOR EACH ROW EXECUTE FUNCTION reject_script_audit()");
  try {
    const failing = await runScript("scripts/matching-worker.ts", ["--once"], schema);
    assert.equal(failing.code, 1, failing.output);
    assert.match(failing.output, /^Matching worker : projection_error_p0001$/m);
    assert.ok(!/script audit failure|audit/.test(failing.output), "aucun message brut");
    assert.match(failing.output, /un cycle, 0 évaluation\(s\) périmée\(s\), 0 événement\(s\) lu\(s\)/);
  } finally {
    await pool.query("DROP TRIGGER IF EXISTS reject_script_ack ON matching_outbox_events");
  }
  const recovered = await runScript("scripts/matching-worker.ts", ["--once"], schema);
  assert.equal(recovered.code, 0, recovered.output);
});
