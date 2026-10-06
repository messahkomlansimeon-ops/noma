import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { before, after, test } from "node:test";
import { Pool } from "pg";
import {
  archiveUser, createDemand, createOffer, createUser, satisfyDemand, updateOffer, updateUser,
} from "../../lib/server/catalog";
import type { DemandRecord, OfferRecord, UserRecord } from "../../lib/server/catalog/types";
import { MatchingJobValidationError, claimMatchingJobs, type JobLease } from "../../lib/server/matching/jobs";
import { computeJobIdentity, projectOutboxBatch } from "../../lib/server/matching/projection";
import {
  runUserReactivationSweep, type UserReactivationSweepHooks, type UserReactivationSweepResult,
} from "../../lib/server/matching/sweeps";
import { runMatchingWorkerOnce } from "../../lib/server/matching/worker";
import { runMigrations } from "../../lib/server/postgres/migrations";
import {
  openVerifiedTestDatabase, openVerifiedIsolatedPool, createTemporarySchemaName, quoteTemporarySchema,
} from "./test-database";

let admin: Pool, pool: Pool;
const schema = createTemporarySchemaName();
const quoted = quoteTemporarySchema(schema);

before(async () => {
  const opened = await openVerifiedTestDatabase(process.env.TEST_DATABASE_URL);
  admin = opened.pool;
  await admin.query(`CREATE SCHEMA ${quoted}`);
  pool = await openVerifiedIsolatedPool(opened.target, schema);
  assert.equal((await runMigrations(pool)).applied.length, 17);
});

after(async () => {
  if (pool) await pool.end();
  if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${quoted} CASCADE`); await admin.end(); }
});

// ───────────── données catalogue réelles ─────────────

const resetAll = () => pool.query(
  "TRUNCATE matching_evaluations, matching_jobs, matching_outbox_events, demands, offers, users CASCADE");

const offerInput = (ownerId: string, extra: Record<string, unknown> = {}) => ({
  ownerId, rawText: "iPhone 13 128Go avec chargeur", category: "smartphones", brand: "Apple", model: "iPhone 13",
  attributes: { charger_included: true }, price: { amount: 250_000, currency: "XOF" }, status: "published" as const, ...extra,
});

const demandInput = (ownerId: string) => ({
  ownerId, rawText: "Cherche iPhone 13", category: "smartphones", brand: "Apple", model: "iPhone 13",
  requirements: [{ key: "chargeur", operator: "includes", value: "chargeur" }],
  budget: { amount: 300_000, currency: "XOF" }, status: "active" as const,
});

interface Scenario {
  seller: UserRecord;
  buyer: UserRecord;
  /** Ressources ÉLIGIBLES du compte (celles que le sweep doit couvrir). */
  offers: OfferRecord[];
  demands: DemandRecord[];
  /** Ressources NON éligibles du compte. */
  ignored: Array<OfferRecord | DemandRecord>;
  reactivated: UserRecord;
}

interface ScenarioOptions { offers?: number; demands?: number; extras?: boolean; reactivate?: boolean }

/**
 * Compte vendeur avec ses ressources (éligibles puis, si demandé, non éligibles), un acheteur avec les
 * contreparties, puis suspension et réactivation du vendeur. Les événements de création sont acquittés
 * puis leurs jobs supprimés : seul l'événement user.reactivated reste à projeter.
 */
async function scenario(options: ScenarioOptions = {}): Promise<Scenario> {
  const { offers: offerCount = 2, demands: demandCount = 1, extras = true, reactivate = true } = options;
  await resetAll();
  const seller = await createUser({}, pool), buyer = await createUser({}, pool);
  const offers: OfferRecord[] = [];
  for (let i = 0; i < offerCount; i++) {
    // Une offre « reserved » reste éligible : seule la disponibilité unavailable l'exclut.
    offers.push(await createOffer(offerInput(seller.id, { rawText: `iPhone 13 n°${i}`, ...(i === 1 ? { availabilityStatus: "reserved" } : {}) }), pool));
  }
  const demands: DemandRecord[] = [];
  for (let i = 0; i < demandCount; i++) demands.push(await createDemand({ ...demandInput(seller.id), rawText: `Cherche iPhone 13 n°${i}` }, pool));
  const ignored: Array<OfferRecord | DemandRecord> = [];
  if (extras) {
    ignored.push(await createOffer(offerInput(seller.id, { availabilityStatus: "unavailable" }), pool));
    ignored.push(await createOffer(offerInput(seller.id, { status: "draft" }), pool));
    ignored.push(await createOffer(offerInput(seller.id, { status: "paused" }), pool));
    const active = await createDemand(demandInput(seller.id), pool);
    ignored.push(await satisfyDemand(seller.id, active.id, active.contentVersion, pool));
  }
  await createDemand(demandInput(buyer.id), pool);
  await createOffer(offerInput(buyer.id), pool);

  assert.equal((await projectOutboxBatch({ pool, limit: 100 })).invalid, 0);
  await pool.query("DELETE FROM matching_jobs");
  let reactivated = seller;
  if (reactivate) {
    const suspended = await updateUser({ id: seller.id, expectedVersion: seller.version, status: "suspended" }, pool);
    reactivated = await updateUser({ id: seller.id, expectedVersion: suspended.version, status: "active" }, pool);
    const projection = await projectOutboxBatch({ pool, limit: 100 });
    assert.equal(projection.invalid, 0);
    assert.equal(projection.jobsInserted, 1, "un seul job : le sweep de réactivation");
  }
  return { seller, buyer, offers, demands, ignored, reactivated };
}

// ───────────── aides d'exécution et d'inspection ─────────────

const claimSweep = async (db: Pool = pool, workerId = "sweeper-a"): Promise<JobLease> => {
  const [lease] = await claimMatchingJobs({ pool: db, workerId, limit: 1, jobTypes: ["user_reactivation_sweep"] });
  assert.ok(lease, "un sweep réservable est attendu");
  return lease;
};
const sweepJob = async () => (await pool.query("SELECT * FROM matching_jobs WHERE job_type = 'user_reactivation_sweep'")).rows[0];
const childJobs = async () =>
  (await pool.query("SELECT * FROM matching_jobs WHERE job_type <> 'user_reactivation_sweep' ORDER BY job_type, resource_id")).rows;
const expireLease = (jobId: string) =>
  pool.query("UPDATE matching_jobs SET lock_expires_at = clock_timestamp() - interval '1 second' WHERE id = $1 AND status = 'running'", [jobId]);
const reactivationEventId = async () =>
  (await pool.query("SELECT id FROM matching_outbox_events WHERE event_type = 'user.reactivated'")).rows[0].id as string;

async function runSweep(hooks?: UserReactivationSweepHooks, batchSize?: number, lease?: JobLease): Promise<UserReactivationSweepResult> {
  return runUserReactivationSweep({ pool, lease: lease ?? await claimSweep(), batchSize, hooks });
}

const ids = (records: Array<{ id: string }>) => records.map((record) => record.id).sort();

function spyPool(intercept?: (text: string) => Error | null) {
  let queries = 0;
  const spy = Object.create(pool) as Pool;
  const wrap = (name: "query" | "connect") => ((...args: unknown[]) => {
    queries++;
    if (name === "query" && typeof args[0] === "string") {
      const failure = intercept?.(args[0]);
      if (failure) return Promise.reject(failure);
    }
    return (pool[name] as (...a: unknown[]) => unknown)(...args);
  }) as never;
  spy.query = wrap("query");
  spy.connect = wrap("connect");
  return { spy, count: () => queries };
}

// ───────────── 1. expansion nominale ─────────────

test("compte avec ressources éligibles et non éligibles : exactement 3 enfants, identités et champs scellés, enfants exécutés par le worker", async () => {
  const { offers, demands, ignored, reactivated } = await scenario();
  const sweep = await sweepJob();
  const eventId = await reactivationEventId();
  assert.equal(sweep.resource_version, reactivated.version);
  assert.equal(sweep.source_event_id, eventId);

  const result = await runSweep();
  assert.deepEqual(result, { outcome: "completed", childJobsInserted: 3, childJobsAlreadyPresent: 0 });

  const done = await sweepJob();
  assert.equal(done.status, "completed");
  assert.equal(done.claim_token, null);
  assert.equal(done.lock_expires_at, null);
  assert.ok(done.completed_at);
  assert.equal(done.cursor_position, null, "cursor_position reste réservé aux curseurs 2C1");
  assert.deepEqual(done.chunk_manifest, {});

  const children = await childJobs();
  assert.equal(children.length, 3);
  assert.deepEqual(ids(children.map((child) => ({ id: child.resource_id }))), ids([...offers, ...demands]));
  for (const child of children) {
    const resource = [...offers, ...demands].find((candidate) => candidate.id === child.resource_id)!;
    const kind = offers.some((offer) => offer.id === resource.id) ? "evaluate_offer_candidates" : "evaluate_demand_candidates";
    assert.equal(child.job_type, kind);
    assert.equal(child.resource_version, resource.contentVersion);
    assert.equal(child.scoring_config_hash, sweep.scoring_config_hash);
    assert.equal(child.source_event_id, eventId);
    assert.equal(child.target_resource_id, null);
    assert.equal(child.status, "pending");
    assert.equal(child.job_identity, computeJobIdentity({
      generation: reactivated.version, jobType: kind, resourceId: resource.id, resourceVersion: resource.contentVersion,
      scoringConfigHash: sweep.scoring_config_hash, sourceEventId: eventId, targetResourceId: null,
    }));
  }
  for (const resource of ignored) {
    assert.equal(children.some((child) => child.resource_id === resource.id), false, "ressource non éligible exclue");
  }

  // Les enfants sont exécutés par le worker d'évaluation (config relue dans l'événement de réactivation).
  for (let i = 0; i < 10; i++) {
    const run = await runMatchingWorkerOnce({ pool, workerId: "worker-a", limit: 1 });
    if (run.length === 0) break;
    assert.equal(run[0].outcome, "completed");
  }
  assert.deepEqual((await childJobs()).map((child) => child.status), ["completed", "completed", "completed"]);
  const evaluations = (await pool.query("SELECT offer_id, demand_id FROM matching_evaluations WHERE is_latest")).rows;
  assert.equal(evaluations.length, 3, "2 offres × demande de l'acheteur + demande du vendeur × offre de l'acheteur");
  const eligible = new Set([...offers, ...demands].map((resource) => resource.id));
  for (const row of evaluations) {
    assert.equal(eligible.has(row.offer_id) !== eligible.has(row.demand_id), true, "chaque paire contient une ressource éligible du compte");
  }
});

// ───────────── 2. lots ─────────────

test("batchSize 2 pour 5 ressources : plusieurs lots, aucun doublon", async () => {
  await scenario({ offers: 3, demands: 2 });
  const batches: number[] = [];
  const result = await runSweep({ beforeBatch: (index) => { batches.push(index); } }, 2);
  assert.deepEqual(result, { outcome: "completed", childJobsInserted: 5, childJobsAlreadyPresent: 0 });
  assert.deepEqual(batches, [0, 1, 2, 3], "offres 2+1, demandes 2+0 (lot plein suivi d'un lot vide)");
  const children = await childJobs();
  assert.equal(children.length, 5);
  assert.equal(new Set(children.map((child) => child.job_identity)).size, 5);
  assert.equal(new Set(children.map((child) => child.resource_id)).size, 5);
});

test("keyset sur created_at identiques à la microseconde : aucune ressource perdue ni doublée", async () => {
  const { seller } = await scenario({ offers: 5, demands: 3 });
  await pool.query("UPDATE offers SET created_at = '2026-01-01 00:00:00.123456+00' WHERE owner_id = $1", [seller.id]);
  await pool.query("UPDATE demands SET created_at = '2026-01-01 00:00:00.123456+00' WHERE owner_id = $1", [seller.id]);
  const result = await runSweep(undefined, 2);
  assert.deepEqual(result, { outcome: "completed", childJobsInserted: 8, childJobsAlreadyPresent: 0 });
  assert.equal((await childJobs()).length, 8);
});

// ───────────── 3. crash et reprise ─────────────

test("crash après un lot, bail expiré, reprise : aucun enfant en double et le sweep se termine", async () => {
  await scenario({ offers: 3, demands: 2 });
  const first = await claimSweep();
  const crashed = await runUserReactivationSweep({
    pool, lease: first, batchSize: 2, hooks: { afterBatch: (index) => (index === 0 ? "abandon" : undefined) },
  });
  assert.deepEqual(crashed, { outcome: "abandoned", childJobsInserted: 2, childJobsAlreadyPresent: 0 });
  assert.equal((await childJobs()).length, 2);
  assert.equal((await sweepJob()).status, "running");

  await expireLease(first.jobId);
  const second = await claimSweep(pool, "sweeper-b");
  assert.equal(second.attempts, 2);
  const resumed = await runUserReactivationSweep({ pool, lease: second, batchSize: 2 });
  assert.deepEqual(resumed, { outcome: "completed", childJobsInserted: 3, childJobsAlreadyPresent: 2 });
  const children = await childJobs();
  assert.equal(children.length, 5);
  assert.equal(new Set(children.map((child) => child.job_identity)).size, 5);
  assert.equal((await sweepJob()).status, "completed");
});

test("crash avant la clôture : la reprise ne crée rien et complète", async () => {
  await scenario();
  const first = await claimSweep();
  const crashed = await runUserReactivationSweep({ pool, lease: first, hooks: { beforeComplete: () => "abandon" } });
  assert.deepEqual(crashed, { outcome: "abandoned", childJobsInserted: 3, childJobsAlreadyPresent: 0 });
  assert.equal((await sweepJob()).status, "running");
  await expireLease(first.jobId);
  const resumed = await runUserReactivationSweep({ pool, lease: await claimSweep(pool, "sweeper-b") });
  assert.deepEqual(resumed, { outcome: "completed", childJobsInserted: 0, childJobsAlreadyPresent: 3 });
  assert.equal((await childJobs()).length, 3);
});

test("hook beforeBatch qui abandonne : aucune écriture du tout", async () => {
  await scenario();
  const result = await runSweep({ beforeBatch: () => "abandon" });
  assert.deepEqual(result, { outcome: "abandoned", childJobsInserted: 0, childJobsAlreadyPresent: 0 });
  assert.equal((await childJobs()).length, 0);
  assert.equal((await sweepJob()).status, "running");
});

// ───────────── 4. compte obsolète ─────────────

test("compte de nouveau suspendu, archivé, supprimé ou version supérieure avant le sweep → superseded, aucun enfant", async () => {
  const variants: Array<{ name: string; mutate: (s: Scenario) => Promise<void> }> = [
    { name: "suspendu à nouveau (version supérieure)", mutate: async (s) => { await updateUser({ id: s.seller.id, expectedVersion: s.reactivated.version, status: "suspended" }, pool); } },
    { name: "archivé", mutate: async (s) => { await archiveUser(s.seller.id, s.reactivated.version, pool); } },
    { name: "suspendu sans changement de version", mutate: async (s) => { await pool.query("UPDATE users SET status = 'suspended' WHERE id = $1", [s.seller.id]); } },
    { name: "archivé sans changement de version", mutate: async (s) => { await pool.query("UPDATE users SET status = 'archived', archived_at = clock_timestamp() WHERE id = $1", [s.seller.id]); } },
    { name: "version supérieure, compte actif", mutate: async (s) => { await pool.query("UPDATE users SET version = version + 1 WHERE id = $1", [s.seller.id]); } },
  ];
  for (const variant of variants) {
    const s = await scenario();
    await variant.mutate(s);
    const result = await runSweep();
    assert.deepEqual(result, { outcome: "superseded", childJobsInserted: 0, childJobsAlreadyPresent: 0 }, variant.name);
    assert.equal((await childJobs()).length, 0, variant.name);
    const job = await sweepJob();
    assert.equal(job.status, "superseded", variant.name);
    assert.equal(job.claim_token, null);
  }
});

test("compte absent → superseded ; version du compte inférieure → failed pivot_version_regression", async () => {
  await scenario({ offers: 0, demands: 0, extras: false });
  const buyerless = await pool.query("DELETE FROM users WHERE id NOT IN (SELECT owner_id FROM offers UNION SELECT owner_id FROM demands)");
  assert.ok((buyerless.rowCount ?? 0) >= 1, "le vendeur sans ressource est supprimé");
  assert.deepEqual(await runSweep(), { outcome: "superseded", childJobsInserted: 0, childJobsAlreadyPresent: 0 });

  const s = await scenario();
  await pool.query("UPDATE users SET version = version - 1 WHERE id = $1", [s.seller.id]);
  assert.deepEqual(await runSweep(), { outcome: "failed", childJobsInserted: 0, childJobsAlreadyPresent: 0, errorCode: "pivot_version_regression" });
  const job = await sweepJob();
  assert.equal(job.status, "failed");
  assert.equal(job.last_error, "pivot_version_regression");
  assert.equal((await childJobs()).length, 0);
});

test("compte suspendu entre deux lots → superseded, les enfants déjà créés seront écartés par le worker", async () => {
  const s = await scenario({ offers: 3, demands: 2 });
  const result = await runSweep({
    beforeBatch: async (index) => {
      if (index === 1) await pool.query("UPDATE users SET status = 'suspended', version = version + 1 WHERE id = $1", [s.seller.id]);
    },
  }, 2);
  assert.deepEqual(result, { outcome: "superseded", childJobsInserted: 2, childJobsAlreadyPresent: 0 });
  assert.equal((await sweepJob()).status, "superseded");
  const run = await runMatchingWorkerOnce({ pool, workerId: "worker-a", limit: 1 });
  assert.equal(run[0].outcome, "superseded", "le pivot de l'enfant a un propriétaire suspendu");
});

// ───────────── 5. configuration scellée ─────────────

test("configuration scellée falsifiée, version de moteur ou génération incohérente → failed avec code stable", async () => {
  const variants: Array<{ name: string; code: string; mutate: (eventId: string, jobId: string) => Promise<unknown> }> = [
    { name: "configuration modifiée (hash recalculé différent)", code: "sealed_config_unavailable",
      mutate: (eventId) => pool.query("UPDATE matching_outbox_events SET payload = jsonb_set(payload, '{scoring_config,precision}', '3'::jsonb) WHERE id = $1", [eventId]) },
    { name: "configuration retirée", code: "sealed_config_unavailable",
      mutate: (eventId) => pool.query("UPDATE matching_outbox_events SET payload = payload - 'scoring_config' WHERE id = $1", [eventId]) },
    { name: "événement source détaché", code: "sealed_config_unavailable",
      mutate: (_eventId, jobId) => pool.query("UPDATE matching_jobs SET source_event_id = NULL WHERE id = $1", [jobId]) },
    { name: "hash du job modifié", code: "sealed_config_unavailable",
      mutate: (_eventId, jobId) => pool.query("UPDATE matching_jobs SET scoring_config_hash = $2 WHERE id = $1", [jobId, "a".repeat(64)]) },
    { name: "version du moteur offline", code: "engine_version_mismatch",
      mutate: (eventId) => pool.query("UPDATE matching_outbox_events SET payload = jsonb_set(payload, '{engine_offline_version}', '\"autre/v9\"') WHERE id = $1", [eventId]) },
    { name: "génération du payload ≠ version du job", code: "generation_mismatch",
      mutate: (eventId) => pool.query("UPDATE matching_outbox_events SET payload = jsonb_set(payload, '{generation}', '99'::jsonb) WHERE id = $1", [eventId]) },
    { name: "version du job ≠ génération du payload", code: "generation_mismatch",
      mutate: (_eventId, jobId) => pool.query("UPDATE matching_jobs SET resource_version = resource_version + 1 WHERE id = $1", [jobId]) },
  ];
  for (const variant of variants) {
    await scenario();
    const job = await sweepJob();
    await variant.mutate(await reactivationEventId(), job.id);
    const result = await runSweep();
    assert.deepEqual(result, { outcome: "failed", childJobsInserted: 0, childJobsAlreadyPresent: 0, errorCode: variant.code }, variant.name);
    const after = await sweepJob();
    assert.equal(after.status, "failed", variant.name);
    assert.equal(after.last_error, variant.code);
    assert.equal((await childJobs()).length, 0, variant.name);
  }
});

test("dernière tentative consommée : dead_letter avec le code stable", async () => {
  await scenario();
  await pool.query("UPDATE matching_jobs SET attempts = max_attempts - 1 WHERE job_type = 'user_reactivation_sweep'");
  await pool.query("UPDATE matching_outbox_events SET payload = payload - 'scoring_config' WHERE event_type = 'user.reactivated'");
  assert.deepEqual(await runSweep(), { outcome: "dead_letter", childJobsInserted: 0, childJobsAlreadyPresent: 0, errorCode: "sealed_config_unavailable" });
  assert.equal((await sweepJob()).status, "dead_letter");
});

test("type de job non supporté : failed unsupported_job_type, aucun enfant", async () => {
  await scenario();
  await runSweep();
  const [child] = await claimMatchingJobs({ pool, workerId: "worker-a", limit: 1, jobTypes: ["evaluate_offer_candidates", "evaluate_demand_candidates"] });
  assert.ok(child);
  const before = (await childJobs()).length;
  const result = await runUserReactivationSweep({ pool, lease: child });
  assert.deepEqual(result, { outcome: "failed", childJobsInserted: 0, childJobsAlreadyPresent: 0, errorCode: "unsupported_job_type" });
  assert.equal((await childJobs()).length, before);
});

// ───────────── 6. bail ─────────────

test("bail repris par un autre worker entre deux lots → lease_lost, aucun enfant après la perte, aucune complétion", async () => {
  await scenario({ offers: 3, demands: 2 });
  const job = await sweepJob();
  const result = await runSweep({
    beforeBatch: async (index) => {
      if (index !== 1) return;
      await expireLease(job.id);
      await claimSweep(pool, "sweeper-b");
    },
  }, 2);
  assert.deepEqual(result, { outcome: "lease_lost", childJobsInserted: 2, childJobsAlreadyPresent: 0 });
  assert.equal((await childJobs()).length, 2, "aucun enfant inséré après la perte");
  const after = await sweepJob();
  assert.equal(after.status, "running");
  assert.equal(after.locked_by, "sweeper-b");
  assert.equal(after.completed_at, null);
});

test("bail expiré sans reprise entre deux lots, ou avant la clôture → lease_lost", async () => {
  await scenario({ offers: 3, demands: 2 });
  const job = await sweepJob();
  const midway = await runSweep({ beforeBatch: async (index) => { if (index === 1) await expireLease(job.id); } }, 2);
  assert.deepEqual(midway, { outcome: "lease_lost", childJobsInserted: 2, childJobsAlreadyPresent: 0 });
  assert.equal((await childJobs()).length, 2);

  await scenario();
  const job2 = await sweepJob();
  const atEnd = await runSweep({ beforeComplete: async () => { await expireLease(job2.id); } });
  assert.deepEqual(atEnd, { outcome: "lease_lost", childJobsInserted: 3, childJobsAlreadyPresent: 0 });
  const after = await sweepJob();
  assert.equal(after.status, "running", "aucune complétion sans bail valide");
  assert.equal(after.completed_at, null);
});

test("bail perdu pendant un lot (avant l'extension) : le lot entier est annulé", async () => {
  await scenario();
  const job = await sweepJob();
  const lease = await claimSweep();
  // Le lot verrouille le sweep puis insère ; le bail expire (sur la MÊME connexion, le sweep étant verrouillé)
  // juste avant l'extension → le fence échoue, ROLLBACK des enfants du lot.
  const spy = Object.create(pool) as Pool;
  spy.query = pool.query.bind(pool) as never; // Pool.query s'appuie sur this.connect avec rappel : ne pas le détourner
  spy.connect = (async () => {
    const client = await pool.connect();
    const originalQuery = client.query;
    const originalRelease = client.release;
    const query = client.query.bind(client) as (...a: unknown[]) => Promise<unknown>;
    // La connexion revient au pool : on retire les détournements pour ne pas contaminer les tests suivants.
    client.release = ((error?: Error | boolean) => { client.query = originalQuery; client.release = originalRelease; return originalRelease.call(client, error); }) as never;
    client.query = ((...args: unknown[]) => {
      const text = typeof args[0] === "string" ? args[0] : "";
      if (text.includes("SET lock_expires_at = clock_timestamp() +")) {
        return query("UPDATE matching_jobs SET lock_expires_at = clock_timestamp() - interval '1 second' WHERE id = $1", [job.id])
          .then(() => query(...args));
      }
      return query(...args);
    }) as never;
    return client;
  }) as never;
  const result = await runUserReactivationSweep({ pool: spy, lease });
  assert.deepEqual(result, { outcome: "lease_lost", childJobsInserted: 0, childJobsAlreadyPresent: 0 });
  assert.equal((await childJobs()).length, 0, "les enfants du lot annulé n'existent pas");
  assert.equal((await sweepJob()).status, "running");
});

// ───────────── 7. cohérence avec le worker ─────────────

test("ressource modifiée après la création de son enfant : le worker passe l'enfant en superseded", async () => {
  const { seller, offers } = await scenario();
  assert.equal((await runSweep()).outcome, "completed");
  const updated = await updateOffer({
    id: offers[0].id, ownerId: seller.id, expectedContentVersion: offers[0].contentVersion, changes: { rawText: "iPhone 13 modifié" },
  }, pool);
  assert.equal(updated.contentVersion, offers[0].contentVersion + 1);

  const outcomes = new Map<string, string>();
  for (let i = 0; i < 10; i++) {
    const run = await runMatchingWorkerOnce({ pool, workerId: "worker-a", limit: 1 });
    if (run.length === 0) break;
    const job = (await pool.query("SELECT resource_id FROM matching_jobs WHERE id = $1", [run[0].jobId])).rows[0];
    outcomes.set(job.resource_id, run[0].outcome);
  }
  assert.equal(outcomes.get(offers[0].id), "superseded");
  assert.equal(outcomes.get(offers[1].id), "completed");
  assert.equal(outcomes.size, 3);
});

// ───────────── 8. projection rejouée ─────────────

test("rejeu de la projection de l'événement de réactivation : aucun nouveau sweep", async () => {
  await scenario();
  const before = await pool.query("SELECT id, job_identity FROM matching_jobs");
  assert.equal(before.rowCount, 1);
  const idle = await projectOutboxBatch({ pool, limit: 100 });
  assert.equal(idle.selected, 0);
  await pool.query("UPDATE matching_outbox_events SET dispatch_status = 'pending', dispatched_at = NULL WHERE event_type = 'user.reactivated'");
  const replay = await projectOutboxBatch({ pool, limit: 100 });
  assert.deepEqual({ selected: replay.selected, inserted: replay.jobsInserted, present: replay.jobsAlreadyPresent }, { selected: 1, inserted: 0, present: 1 });
  const after = await pool.query("SELECT id, job_identity FROM matching_jobs");
  assert.deepEqual(after.rows, before.rows);
});

// ───────────── erreurs inattendues et validation ─────────────

test("erreur inattendue → worker_exception ; erreur PostgreSQL transitoire → transient_55p03, sous bail", async () => {
  await scenario();
  const generic = spyPool((text) => (text.includes("FROM users WHERE id") ? new Error("secret hôte interne") : null));
  const lease = await claimSweep();
  const first = await runUserReactivationSweep({ pool: generic.spy, lease });
  assert.deepEqual(first, { outcome: "failed", childJobsInserted: 0, childJobsAlreadyPresent: 0, errorCode: "worker_exception" });
  assert.equal((await sweepJob()).last_error, "worker_exception", "le message de l'erreur n'est jamais persisté");

  await scenario();
  const transient = spyPool((text) => (text.includes("FROM users WHERE id") ? Object.assign(new Error("lock"), { code: "55P03" }) : null));
  const second = await runUserReactivationSweep({ pool: transient.spy, lease: await claimSweep() });
  assert.deepEqual(second, { outcome: "failed", childJobsInserted: 0, childJobsAlreadyPresent: 0, errorCode: "transient_55p03" });
  assert.equal((await childJobs()).length, 0);
});

test("validation avant SQL : pool, bail, batchSize et leaseSeconds invalides → zéro requête", async () => {
  const { spy, count } = spyPool();
  const lease = { jobId: randomUUID(), claimToken: randomUUID() } as JobLease;
  const cases: Array<[string, Record<string, unknown>]> = [
    ["pool absent", { pool: undefined, lease }],
    ["pool arbitraire", { pool: { query: async () => ({ rows: [] }) }, lease }],
    ["bail absent", { pool: spy, lease: null }],
    ["bail sans UUID", { pool: spy, lease: { jobId: "x", claimToken: "y" } }],
    ...[0, 501, 1.5, -1, Number.NaN, "10", null].map((batchSize): [string, Record<string, unknown>] =>
      [`batchSize ${String(batchSize)}`, { pool: spy, lease, batchSize }]),
    ["leaseSeconds trop court", { pool: spy, lease, leaseSeconds: 14 }],
    ["leaseSeconds null", { pool: spy, lease, leaseSeconds: null }],
  ];
  for (const [name, options] of cases) {
    await assert.rejects(() => runUserReactivationSweep(options as never), MatchingJobValidationError, name);
  }
  assert.equal(count(), 0);
});
