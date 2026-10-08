import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { Pool } from "pg";
import {
  archiveDemand, createDemand, createOffer, createUser, pauseOffer, satisfyDemand, updateDemand, updateOffer, updateUser,
} from "../../lib/server/catalog";
import type { DemandRecord, OfferRecord, UserRecord } from "../../lib/server/catalog/types";
import { MatchingJobValidationError, claimMatchingJobs } from "../../lib/server/matching/jobs";
import { computeScoringConfigHash, normalizeScoringConfig } from "../../lib/server/matching/persistence";
import { projectOutboxBatch } from "../../lib/server/matching/projection";
import { findEvaluatedDemandMatchesForOffer, findEvaluatedOfferMatchesForDemand } from "../../lib/server/matching/service";
import type { MatchingScoringOptions } from "../../lib/server/matching/scoring-types";
import {
  runMatchingJob, runMatchingWorkerOnce, type MatchingJobRunResult, type MatchingWorkerHooks,
} from "../../lib/server/matching/worker";
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
  assert.equal((await runMigrations(pool)).applied.length, 22);
});

after(async () => {
  for (const db of [second, pool]) if (db) await db.end();
  if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${quoted} CASCADE`); await admin.end(); }
});

// ───────────── données catalogue réelles ─────────────

const resetAll = () => pool.query(
  "TRUNCATE matching_evaluations, matching_jobs, matching_outbox_events, demands, offers, users CASCADE");

type DemandKind = "compatible" | "incompatible" | "unknown";

const offerInput = (ownerId: string) => ({
  ownerId, rawText: "iPhone 13 128Go avec chargeur", category: "smartphones", brand: "Apple", model: "iPhone 13",
  attributes: { charger_included: true }, price: { amount: 250_000, currency: "XOF" }, status: "published" as const,
});

const demandInput = (ownerId: string, kind: DemandKind = "compatible", deadlineAt?: Date) => ({
  ownerId, rawText: `Cherche iPhone ${kind}`, category: "smartphones", brand: "Apple",
  model: kind === "incompatible" ? "iPhone 12" : "iPhone 13",
  requirements: kind === "unknown"
    ? [{ key: "garantie", operator: "includes", value: "garantie" }]
    : [{ key: "chargeur", operator: "includes", value: "chargeur" }],
  budget: { amount: 300_000, currency: "XOF" }, status: "active" as const,
  ...(deadlineAt ? { deadlineAt } : {}),
});

interface OfferScenario { seller: UserRecord; buyer: UserRecord; offer: OfferRecord; demands: DemandRecord[] }
interface DemandScenario { buyer: UserRecord; seller: UserRecord; demand: DemandRecord; offers: OfferRecord[] }

/** Une offre pivot et des demandes candidates (créées dans l'ordre, la plus récente d'abord pour 2C1). */
async function offerScenario(kinds: DemandKind[], options: { project?: boolean; deadlineAt?: Date } = {}): Promise<OfferScenario> {
  await resetAll();
  const seller = await createUser({}, pool), buyer = await createUser({}, pool);
  const offer = await createOffer(offerInput(seller.id), pool);
  const demands: DemandRecord[] = [];
  for (const kind of kinds) demands.push(await createDemand(demandInput(buyer.id, kind, options.deadlineAt), pool));
  if (options.project !== false) assert.equal((await projectOutboxBatch({ pool, limit: 100 })).invalid, 0);
  return { seller, buyer, offer, demands };
}

async function demandScenario(count: number): Promise<DemandScenario> {
  await resetAll();
  const buyer = await createUser({}, pool), seller = await createUser({}, pool);
  const demand = await createDemand(demandInput(buyer.id), pool);
  const offers: OfferRecord[] = [];
  for (let i = 0; i < count; i++) offers.push(await createOffer({ ...offerInput(seller.id), rawText: `iPhone 13 n°${i}` }, pool));
  assert.equal((await projectOutboxBatch({ pool, limit: 100 })).invalid, 0);
  return { buyer, seller, demand, offers };
}

// ───────────── aides d'exécution et d'inspection ─────────────

const jobFor = async (resourceId: string) =>
  (await pool.query("SELECT * FROM matching_jobs WHERE resource_id = $1 ORDER BY created_at LIMIT 1", [resourceId])).rows[0];
const expireLease = (jobId: string) =>
  pool.query("UPDATE matching_jobs SET lock_expires_at = clock_timestamp() - interval '1 second' WHERE id = $1 AND status = 'running'", [jobId]);
const evaluationRows = async () =>
  (await pool.query("SELECT * FROM matching_evaluations ORDER BY offer_id, demand_id, evaluated_at")).rows;
const latestRows = async () => (await evaluationRows()).filter((row) => row.is_latest);

/** Ne laisse réservable que le job du pivot demandé (les autres jobs créés par le catalogue sont écartés). */
async function isolate(resourceId: string) {
  await pool.query(
    "UPDATE matching_jobs SET status = 'superseded', completed_at = clock_timestamp() WHERE resource_id <> $1 AND status = 'pending'", [resourceId]);
}

async function runOnly(resourceId: string, options: { workerId?: string; pageSize?: number; hooks?: MatchingWorkerHooks; db?: Pool } = {}) {
  await isolate(resourceId);
  const results = await runMatchingWorkerOnce({
    pool: options.db ?? pool, workerId: options.workerId ?? "worker-a", limit: 1, pageSize: options.pageSize, hooks: options.hooks,
  });
  assert.equal(results.length, 1);
  return results[0];
}

const summary = (result: MatchingJobRunResult) =>
  ({ chunks: result.chunks, persisted: result.persisted, replayed: result.replayed, skippedStale: result.skippedStale, alreadySuperseded: result.alreadySuperseded });

const DEFAULT_OPTIONS = normalizeScoringConfig() as MatchingScoringOptions;

/** Compare chaque évaluation active de la page 2C2 (même now, mêmes options) avec la ligne 2D et le manifeste. */
async function assertMatchesService(kind: "offer" | "demand", pivotOwnerId: string, pivotId: string, scoringOptions: MatchingScoringOptions = DEFAULT_OPTIONS) {
  const job = await jobFor(pivotId);
  const manifest = job.chunk_manifest;
  const now = new Date(manifest.evaluated_at);
  const page = kind === "offer"
    ? await findEvaluatedDemandMatchesForOffer(pivotOwnerId, pivotId, { limit: 100, now, scoringOptions }, pool)
    : await findEvaluatedOfferMatchesForDemand(pivotOwnerId, pivotId, { limit: 100, now, scoringOptions }, pool);
  const latest = await latestRows();
  assert.equal(latest.length, page.items.length);
  for (const item of page.items) {
    const [offerId, demandId] = kind === "offer" ? [pivotId, item.candidateId] : [item.candidateId, pivotId];
    const row = latest.find((entry) => entry.offer_id === offerId && entry.demand_id === demandId);
    assert.ok(row, "évaluation active manquante pour la paire");
    assert.equal(row.compatibility_status, item.compatibilityStatus);
    assert.equal(row.eligibility_status, item.evaluation.eligibility.status);
    assert.equal(row.score === null ? null : Number(row.score), item.scoring.score);
    assert.equal(row.coverage === null ? null : Number(row.coverage), item.scoring.coverage);
    assert.equal(row.evaluated_at.getTime(), now.getTime());
    assert.equal(row.scoring_config_hash, computeScoringConfigHash(normalizeScoringConfig(scoringOptions)));
    const entry = manifest.candidates.find((c: { candidate_id: string }) => c.candidate_id === item.candidateId);
    assert.equal(entry.attempts.at(-1).attempt_hash, row.attempt_hash, "attempt_hash du manifeste = ligne 2D");
  }
  return { page, manifest, now };
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

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// ───────────── 1. bout en bout dans les deux sens ─────────────

test("bout en bout, offre pivot : completed, évaluations identiques à 2C2, attempt_hash et compteurs exacts", async () => {
  const { seller, offer, demands } = await offerScenario(["compatible", "incompatible", "unknown"]);
  const result = await runOnly(offer.id);
  assert.deepEqual({ outcome: result.outcome, ...summary(result) }, { outcome: "completed", chunks: 1, persisted: 3, replayed: 0, skippedStale: 0, alreadySuperseded: 0 });
  const job = await jobFor(offer.id);
  assert.equal(job.status, "completed");
  assert.equal(job.chunk_manifest.state, "validated");
  assert.equal(job.chunk_manifest.is_eof, true);
  assert.equal(job.cursor_position, null);
  assert.equal(job.processed_candidates_count, 3);
  assert.equal(job.created_evaluations_count, 3);
  assert.equal(job.last_error, null);
  assert.equal(job.attempts, 1);
  const { page } = await assertMatchesService("offer", seller.id, offer.id);
  assert.deepEqual(new Set(page.items.map((item) => item.compatibilityStatus)).size >= 2, true, "statuts variés");
  assert.equal((await evaluationRows()).length, 3);
  assert.equal(demands.length, 3);
});

test("bout en bout, demande pivot : completed, évaluations identiques à 2C2, attempt_hash et compteurs exacts", async () => {
  const { buyer, demand } = await demandScenario(3);
  const result = await runOnly(demand.id);
  assert.deepEqual({ outcome: result.outcome, ...summary(result) }, { outcome: "completed", chunks: 1, persisted: 3, replayed: 0, skippedStale: 0, alreadySuperseded: 0 });
  const job = await jobFor(demand.id);
  assert.equal(job.status, "completed");
  assert.equal(job.processed_candidates_count, 3);
  assert.equal(job.created_evaluations_count, 3);
  await assertMatchesService("demand", buyer.id, demand.id);
});

// ───────────── 2-3. pages ─────────────

test("plusieurs pages (pageSize 2, 5 candidats) : 3 chunks chaînés, chaque candidat évalué une fois", async () => {
  const { offer, seller } = await offerScenario(["compatible", "compatible", "incompatible", "compatible", "unknown"]);
  const chain: Array<{ index: number; cursorIn: string | null; cursorOut: string | null; cursorPosition: string | null }> = [];
  const hooks: MatchingWorkerHooks = {
    afterValidate: async () => {
      const row = (await pool.query("SELECT cursor_position, chunk_manifest FROM matching_jobs WHERE resource_id = $1", [offer.id])).rows[0];
      chain.push({ index: row.chunk_manifest.chunk_index, cursorIn: row.chunk_manifest.cursor_in, cursorOut: row.chunk_manifest.cursor_out, cursorPosition: row.cursor_position });
    },
  };
  const result = await runOnly(offer.id, { pageSize: 2, hooks });
  assert.deepEqual({ outcome: result.outcome, ...summary(result) }, { outcome: "completed", chunks: 3, persisted: 5, replayed: 0, skippedStale: 0, alreadySuperseded: 0 });
  assert.deepEqual(chain.map((c) => c.index), [0, 1, 2]);
  assert.equal(chain[0].cursorIn, null);
  assert.equal(chain[1].cursorIn, chain[0].cursorOut);
  assert.equal(chain[2].cursorIn, chain[1].cursorOut);
  assert.equal(chain[2].cursorOut, null);
  assert.equal(chain[0].cursorPosition, chain[0].cursorOut);
  assert.equal(chain[1].cursorPosition, chain[1].cursorOut);
  assert.equal(chain[2].cursorPosition, chain[1].cursorOut, "dernière page : curseur inchangé");
  const job = await jobFor(offer.id);
  assert.equal(job.processed_candidates_count, 5);
  assert.equal(job.created_evaluations_count, 5);
  const rows = await evaluationRows();
  assert.equal(rows.length, 5);
  assert.equal(new Set(rows.map((row) => row.demand_id)).size, 5);
  assert.ok(rows.every((row) => row.is_latest && row.offer_id === offer.id));
  assert.equal((await latestRows()).length, 5);
  assert.equal(seller.id, offer.ownerId);
});

test("page vide : completed avec des compteurs à zéro", async () => {
  const { offer } = await offerScenario([]);
  const result = await runOnly(offer.id);
  assert.deepEqual({ outcome: result.outcome, ...summary(result) }, { outcome: "completed", chunks: 1, persisted: 0, replayed: 0, skippedStale: 0, alreadySuperseded: 0 });
  const job = await jobFor(offer.id);
  assert.equal(job.processed_candidates_count, 0);
  assert.equal(job.created_evaluations_count, 0);
  assert.equal(job.cursor_position, null);
  assert.deepEqual(job.chunk_manifest.candidates, []);
  assert.equal((await evaluationRows()).length, 0);
});

// ───────────── 4. pivot obsolète ─────────────

test("pivot modifié, mis en pause, indisponible ou propriétaire suspendu : superseded, aucune évaluation", async () => {
  const variants: Array<[string, (s: OfferScenario) => Promise<unknown>]> = [
    ["offre modifiée", (s) => updateOffer({ id: s.offer.id, ownerId: s.seller.id, expectedContentVersion: 1, changes: { quantity: 2 } }, pool)],
    ["offre en pause", (s) => pauseOffer(s.seller.id, s.offer.id, 1, pool)],
    ["offre indisponible", (s) => updateOffer({ id: s.offer.id, ownerId: s.seller.id, expectedContentVersion: 1, changes: { availabilityStatus: "unavailable" } }, pool)],
    ["propriétaire suspendu", (s) => updateUser({ id: s.seller.id, expectedVersion: 1, status: "suspended" }, pool)],
  ];
  for (const [label, change] of variants) {
    const scenario = await offerScenario(["compatible", "incompatible"]);
    await change(scenario);
    const result = await runOnly(scenario.offer.id);
    assert.equal(result.outcome, "superseded", label);
    assert.deepEqual(summary(result), { chunks: 0, persisted: 0, replayed: 0, skippedStale: 0, alreadySuperseded: 0 }, label);
    const job = await jobFor(scenario.offer.id);
    assert.equal(job.status, "superseded", label);
    assert.ok(job.completed_at instanceof Date, label);
    assert.equal(job.claim_token, null, label);
    assert.equal((await evaluationRows()).length, 0, label);
  }
  // Demande pivot : satisfaite, puis modifiée.
  for (const [label, change] of [
    ["demande satisfaite", (s: DemandScenario) => satisfyDemand(s.buyer.id, s.demand.id, 1, pool)],
    ["demande modifiée", (s: DemandScenario) => updateDemand({ id: s.demand.id, ownerId: s.buyer.id, expectedContentVersion: 1, changes: { quantity: 3 } }, pool)],
  ] as const) {
    const scenario = await demandScenario(2);
    await change(scenario);
    const result = await runOnly(scenario.demand.id);
    assert.equal(result.outcome, "superseded", label);
    assert.equal((await evaluationRows()).length, 0, label);
  }
});

test("pivot modifié entre deux pages : superseded, la page déjà validée reste acquise", async () => {
  const { offer, seller } = await offerScenario(["compatible", "compatible", "compatible"]);
  let fetches = 0;
  const result = await runOnly(offer.id, {
    pageSize: 2,
    hooks: {
      beforeFetchPage: async () => {
        if (++fetches === 2) await updateOffer({ id: offer.id, ownerId: seller.id, expectedContentVersion: 1, changes: { quantity: 5 } }, pool);
      },
    },
  });
  assert.equal(result.outcome, "superseded");
  assert.equal(result.chunks, 1);
  assert.equal(result.persisted, 2);
  assert.equal((await jobFor(offer.id)).status, "superseded");
});

test("pivot modifié entre l'ouverture du chunk et la persistance : superseded, jamais des candidats « skipped_stale »", async () => {
  const { offer, seller } = await offerScenario(["compatible", "incompatible"]);
  let changed = false;
  const result = await runOnly(offer.id, {
    hooks: {
      beforePersist: async () => {
        if (changed) return;
        changed = true;
        await updateOffer({ id: offer.id, ownerId: seller.id, expectedContentVersion: 1, changes: { quantity: 9 } }, pool);
      },
    },
  });
  assert.equal(result.outcome, "superseded");
  assert.deepEqual(summary(result), { chunks: 0, persisted: 0, replayed: 0, skippedStale: 0, alreadySuperseded: 0 });
  const job = await jobFor(offer.id);
  assert.equal(job.status, "superseded");
  assert.equal(job.processed_candidates_count, 0);
  assert.equal((await evaluationRows()).length, 0);
});

// ───────────── 5-6. crash et reprise ─────────────

test("crash après l'initialisation, après k persistances et avant la validation : la reprise termine sans doublon", async () => {
  const variants: Array<[string, () => MatchingWorkerHooks, { replayed: number; persisted: number; evaluationsBeforeResume: number; created: number }]> = [
    ["après l'initialisation", () => ({ afterInitialize: () => "abandon" }), { replayed: 0, persisted: 3, evaluationsBeforeResume: 0, created: 3 }],
    ["après 2 persistances (la 2e sans acquittement)", () => {
      let calls = 0;
      return { afterPersist: () => (++calls === 2 ? "abandon" : undefined) };
    }, { replayed: 1, persisted: 1, evaluationsBeforeResume: 2, created: 2 }],
    ["avant la validation", () => ({ beforeValidate: () => "abandon" }), { replayed: 0, persisted: 0, evaluationsBeforeResume: 3, created: 3 }],
  ];
  for (const [label, hooks, expected] of variants) {
    const { offer, seller } = await offerScenario(["compatible", "incompatible", "unknown"]);
    const crashed = await runOnly(offer.id, { hooks: hooks() });
    assert.equal(crashed.outcome, "abandoned", label);
    assert.equal((await jobFor(offer.id)).status, "running", label);
    assert.equal((await evaluationRows()).length, expected.evaluationsBeforeResume, label);
    const manifestBefore = (await jobFor(offer.id)).chunk_manifest;
    assert.equal(manifestBefore.state === "validated", false, label);

    await expireLease((await jobFor(offer.id)).id);
    let fetches = 0;
    const resumed = await runOnly(offer.id, { workerId: "worker-b", hooks: { beforeFetchPage: () => { fetches++; } } });
    assert.equal(resumed.outcome, "completed", label);
    assert.equal(resumed.replayed, expected.replayed, label);
    assert.equal(resumed.persisted, expected.persisted, label);
    if (expected.persisted === 0 && expected.replayed === 0) assert.equal(fetches, 0, "aucun candidat pending : 2C2 non appelé");
    const job = await jobFor(offer.id);
    assert.equal(job.status, "completed", label);
    assert.equal(job.attempts, 2, label);
    assert.equal(job.processed_candidates_count, 3, label);
    // created = candidats « persisted » du manifeste : une évaluation écrite avant le crash puis rejouée compte comme « replayed ».
    assert.equal(job.created_evaluations_count, expected.created, label);
    assert.equal((await evaluationRows()).length, 3, `${label} : aucune ligne 2D en double`);
    assert.equal((await latestRows()).length, 3, label);
    assert.equal(job.chunk_manifest.chunk_id, manifestBefore.chunk_id, "le chunk repris est le chunk durable");
    assert.equal(seller.id, offer.ownerId);
  }
});

test("crash après la validation EOF : la reprise termine sans appeler 2C2", async () => {
  const { offer } = await offerScenario(["compatible", "compatible", "compatible"]);
  let validations = 0;
  const crashed = await runOnly(offer.id, { pageSize: 2, hooks: { afterValidate: () => (++validations === 2 ? "abandon" : undefined) } });
  assert.equal(crashed.outcome, "abandoned");
  const before = await jobFor(offer.id);
  assert.equal(before.chunk_manifest.state, "validated");
  assert.equal(before.chunk_manifest.is_eof, true);
  assert.equal(before.status, "running");
  const evaluationsBefore = await evaluationRows();
  await expireLease(before.id);
  let fetches = 0;
  const resumed = await runOnly(offer.id, { workerId: "worker-b", hooks: { beforeFetchPage: () => { fetches++; } } });
  assert.equal(fetches, 0);
  assert.deepEqual({ outcome: resumed.outcome, ...summary(resumed) }, { outcome: "completed", chunks: 0, persisted: 0, replayed: 0, skippedStale: 0, alreadySuperseded: 0 });
  const after = await jobFor(offer.id);
  assert.equal(after.status, "completed");
  assert.equal(after.processed_candidates_count, 3, "aucun recomptage");
  assert.deepEqual(await evaluationRows(), evaluationsBefore);
});

// ───────────── 7-8. candidats obsolètes et expiration ─────────────

test("candidat modifié ou archivé avant la persistance : skipped_stale, le job finit completed", async () => {
  const { offer, buyer, demands } = await offerScenario(["compatible", "incompatible", "unknown"]);
  const [, updated, archived] = demands;
  const done = new Set<string>();
  const result = await runOnly(offer.id, {
    hooks: {
      beforePersist: async (candidateId) => {
        if (done.has(candidateId)) return;
        done.add(candidateId);
        if (candidateId === updated.id) await updateDemand({ id: updated.id, ownerId: buyer.id, expectedContentVersion: 1, changes: { quantity: 4 } }, pool);
        if (candidateId === archived.id) await archiveDemand(buyer.id, archived.id, 1, pool);
      },
    },
  });
  assert.deepEqual({ outcome: result.outcome, ...summary(result) }, { outcome: "completed", chunks: 1, persisted: 1, replayed: 0, skippedStale: 2, alreadySuperseded: 0 });
  const job = await jobFor(offer.id);
  assert.equal(job.status, "completed");
  assert.equal(job.processed_candidates_count, 3);
  assert.equal(job.created_evaluations_count, 1);
  const rows = await evaluationRows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].demand_id, demands[0].id);
  const statuses = job.chunk_manifest.candidates.map((c: { status: string }) => c.status).sort();
  assert.deepEqual(statuses, ["persisted", "skipped_stale", "skipped_stale"]);
});

test("expiration pendant l'attente de verrou : nouvelle tentative, ancienne intacte, T_eval frais persisté", async () => {
  // La demande expire 3 s après sa création ; le hook attend l'échéance avant la persistance (délai court et justifié :
  // l'échéance doit être franchie réellement entre l'horloge T_eval et la lecture d'horloge fraîche de 2D).
  const deadlineAt = new Date(Date.now() + 3000);
  const { offer } = await offerScenario(["compatible"], { deadlineAt });
  let persists = 0;
  const result = await runOnly(offer.id, {
    hooks: {
      beforePersist: async () => {
        persists++;
        if (persists === 1) {
          const manifest = (await jobFor(offer.id)).chunk_manifest;
          assert.ok(Date.parse(manifest.evaluated_at) < deadlineAt.getTime(), "T_eval doit précéder l'échéance (précondition du scénario)");
          await sleep(Math.max(0, deadlineAt.getTime() - Date.now()) + 60);
        }
      },
    },
  });
  assert.equal(persists, 2, "première persistance expirée, seconde sous nouvelle tentative");
  assert.deepEqual({ outcome: result.outcome, ...summary(result) }, { outcome: "completed", chunks: 1, persisted: 1, replayed: 0, skippedStale: 0, alreadySuperseded: 0 });
  const job = await jobFor(offer.id);
  const attempts = job.chunk_manifest.candidates[0].attempts;
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0].status, "pending", "l'ancienne tentative reste intacte");
  assert.equal(attempts[1].status, "persisted");
  assert.ok(Date.parse(attempts[1].evaluated_at) > Date.parse(attempts[0].evaluated_at));
  assert.ok(Date.parse(attempts[1].evaluated_at) >= deadlineAt.getTime());
  assert.notEqual(attempts[1].attempt_id, attempts[0].attempt_id);
  assert.notEqual(attempts[1].idempotency_key, attempts[0].idempotency_key);
  assert.equal(job.chunk_manifest.evaluated_at, attempts[0].evaluated_at, "le chunk garde son T_eval d'ouverture");
  const rows = await evaluationRows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].evaluated_at.toISOString(), attempts[1].evaluated_at, "l'évaluation porte le T_eval frais");
  assert.equal(rows[0].idempotency_key, attempts[1].idempotency_key);
  assert.equal(rows[0].attempt_hash, attempts[1].attempt_hash);
  assert.equal(job.status, "completed");
});

// ───────────── 9-10. erreurs transitoires, conflit d'idempotence ─────────────

test("erreur transitoire 55P03 : job failed, curseur et manifeste intacts, la reprise termine", async () => {
  const { offer } = await offerScenario(["compatible", "incompatible"]);
  const result = await runOnly(offer.id, {
    hooks: { beforePersist: () => { throw Object.assign(new Error("verrou"), { code: "55P03" }); } },
  });
  assert.equal(result.outcome, "failed");
  assert.equal(result.errorCode, "transient_55p03");
  const failed = await jobFor(offer.id);
  assert.equal(failed.status, "failed");
  assert.equal(failed.last_error, "transient_55p03");
  assert.equal(failed.cursor_position, null);
  assert.equal(failed.chunk_manifest.state, "initialized");
  assert.equal(failed.chunk_manifest.manifest_version, 1);
  assert.equal(failed.claim_token, null);
  assert.equal((await evaluationRows()).length, 0);
  const manifestBefore = failed.chunk_manifest;
  await pool.query("UPDATE matching_jobs SET scheduled_at = clock_timestamp() - interval '1 second' WHERE id = $1", [failed.id]);
  const resumed = await runOnly(offer.id, { workerId: "worker-b" });
  assert.equal(resumed.outcome, "completed");
  assert.equal(resumed.persisted, 2);
  const done = await jobFor(offer.id);
  assert.equal(done.attempts, 2);
  assert.equal(done.chunk_manifest.chunk_id, manifestBefore.chunk_id);
  assert.equal((await evaluationRows()).length, 2);
});

test("conflit d'idempotence : manifeste ou ligne 2D falsifiés → failed avec un code stable, aucune écriture silencieuse", async () => {
  // a) attempt_hash falsifié dans le manifeste avant toute persistance.
  const first = await offerScenario(["compatible", "incompatible"]);
  const crashed = await runOnly(first.offer.id, { hooks: { afterInitialize: () => "abandon" } });
  assert.equal(crashed.outcome, "abandoned");
  const job = await jobFor(first.offer.id);
  await pool.query(
    "UPDATE matching_jobs SET chunk_manifest = jsonb_set(chunk_manifest, '{candidates,0,attempts,0,attempt_hash}', to_jsonb(repeat('0', 64))) WHERE id = $1", [job.id]);
  await expireLease(job.id);
  const forged = await runOnly(first.offer.id, { workerId: "worker-b" });
  assert.equal(forged.outcome, "failed");
  assert.equal(forged.errorCode, "attempt_hash_mismatch");
  assert.equal((await jobFor(first.offer.id)).last_error, "attempt_hash_mismatch");
  assert.equal((await evaluationRows()).length, 0);

  // b) ligne 2D existante avec la même clé d'idempotence mais une empreinte différente.
  const second = await offerScenario(["compatible", "incompatible"]);
  let calls = 0;
  await runOnly(second.offer.id, { hooks: { afterPersist: () => (++calls === 1 ? "abandon" : undefined) } });
  assert.equal((await evaluationRows()).length, 1);
  await pool.query("UPDATE matching_evaluations SET attempt_hash = repeat('0', 64)");
  await expireLease((await jobFor(second.offer.id)).id);
  const conflicting = await runOnly(second.offer.id, { workerId: "worker-b" });
  assert.equal(conflicting.outcome, "failed");
  assert.equal(conflicting.errorCode, "idempotency_conflict");
  const rows = await evaluationRows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].attempt_hash, "0".repeat(64), "la ligne falsifiée n'est pas réécrite");
});

// ───────────── 11. configuration scellée ─────────────

test("configuration scellée : payload incohérent, événement supprimé ou version de moteur → échec stable, aucune évaluation", async () => {
  const variants: Array<[string, string, (scenario: OfferScenario) => Promise<unknown>]> = [
    ["précision modifiée sans le hash", "sealed_config_unavailable", (s) => pool.query(
      "UPDATE matching_outbox_events SET payload = jsonb_set(payload, '{scoring_config,precision}', '3') WHERE aggregate_id = $1", [s.offer.id])],
    ["configuration invalide", "sealed_config_unavailable", (s) => pool.query(
      "UPDATE matching_outbox_events SET payload = jsonb_set(payload, '{scoring_config,precision}', '99') WHERE aggregate_id = $1", [s.offer.id])],
    ["configuration absente", "sealed_config_unavailable", (s) => pool.query(
      "UPDATE matching_outbox_events SET payload = payload - 'scoring_config' WHERE aggregate_id = $1", [s.offer.id])],
    ["événement source supprimé", "sealed_config_unavailable", (s) => pool.query(
      "DELETE FROM matching_outbox_events WHERE id = (SELECT source_event_id FROM matching_jobs WHERE resource_id = $1)", [s.offer.id])],
    ["version du moteur d'évaluation", "engine_version_mismatch", (s) => pool.query(
      "UPDATE matching_outbox_events SET payload = jsonb_set(payload, '{engine_offline_version}', '\"matching-offline/v0\"') WHERE aggregate_id = $1", [s.offer.id])],
    ["version du moteur de scoring", "engine_version_mismatch", (s) => pool.query(
      "UPDATE matching_outbox_events SET payload = jsonb_set(payload, '{engine_scoring_version}', '\"matching-scoring/v0\"') WHERE aggregate_id = $1", [s.offer.id])],
  ];
  for (const [label, code, change] of variants) {
    const scenario = await offerScenario(["compatible", "unknown"]);
    await change(scenario);
    const result = await runOnly(scenario.offer.id);
    assert.equal(result.outcome, "failed", label);
    assert.equal(result.errorCode, code, label);
    const job = await jobFor(scenario.offer.id);
    assert.equal(job.status, "failed", label);
    assert.equal(job.last_error, code, label);
    assert.equal(job.chunk_manifest && Object.keys(job.chunk_manifest).length, 0, `${label} : aucun chunk ouvert`);
    assert.equal((await evaluationRows()).length, 0, label);
  }
});

test("configuration scellée personnalisée et cohérente : les scores reflètent les poids scellés, pas les défauts", async () => {
  const sealed = { defaultWeight: 1, precision: 0, weights: { model: 20, price_vs_budget: 0.5 } };
  const sealedHash = computeScoringConfigHash(normalizeScoringConfig(sealed));
  assert.notEqual(sealedHash, computeScoringConfigHash(normalizeScoringConfig()));
  const scenario = await offerScenario(["compatible", "unknown", "incompatible"], { project: false });
  await pool.query(
    "UPDATE matching_outbox_events SET payload = payload || jsonb_build_object('scoring_config', $2::jsonb, 'scoring_config_hash', $3::text) WHERE aggregate_id = $1",
    [scenario.offer.id, JSON.stringify(sealed), sealedHash]);
  assert.equal((await projectOutboxBatch({ pool, limit: 100 })).invalid, 0);
  assert.equal((await jobFor(scenario.offer.id)).scoring_config_hash, sealedHash);
  const result = await runOnly(scenario.offer.id);
  assert.equal(result.outcome, "completed");
  const { page, now } = await assertMatchesService("offer", scenario.seller.id, scenario.offer.id, sealed);
  const withDefaults = await findEvaluatedDemandMatchesForOffer(scenario.seller.id, scenario.offer.id, { limit: 100, now, scoringOptions: DEFAULT_OPTIONS }, pool);
  const latest = await latestRows();
  assert.ok(latest.every((row) => row.scoring_config_hash === sealedHash));
  assert.deepEqual(latest[0].scoring_config, JSON.parse(JSON.stringify(normalizeScoringConfig(sealed))));
  const differing = page.items.filter((item) => {
    const base = withDefaults.items.find((other) => other.candidateId === item.candidateId)!;
    return base.scoring.score !== item.scoring.score;
  });
  assert.ok(differing.length > 0, "au moins un score diffère de celui des défauts : les poids scellés sont appliqués");
});

// ───────────── 12. bail perdu ─────────────

test("bail perdu en cours d'exécution : lease_lost, plus aucune écriture de ce worker, un autre worker termine", async () => {
  const { offer } = await offerScenario(["compatible", "compatible", "incompatible", "unknown"]);
  let persists = 0;
  const lost = await runOnly(offer.id, {
    hooks: {
      beforePersist: async () => {
        if (++persists === 2) await expireLease((await jobFor(offer.id)).id);
      },
    },
  });
  assert.equal(lost.outcome, "lease_lost");
  assert.equal(persists, 2, "aucune persistance après la perte du bail");
  const rows = await evaluationRows();
  assert.equal(rows.length, 2, "la 2e est l'écriture 2D déjà en vol (plan §6.F)");
  const frozen = (await jobFor(offer.id)).chunk_manifest;
  assert.equal(frozen.candidates.filter((c: { status: string }) => c.status !== "pending").length, 1, "seul le 1er candidat est acquitté");
  await sleep(30);
  assert.equal((await evaluationRows()).length, 2);
  assert.deepEqual((await jobFor(offer.id)).chunk_manifest, frozen);

  const resumed = await runOnly(offer.id, { workerId: "worker-b" });
  assert.equal(resumed.outcome, "completed");
  assert.equal(resumed.replayed, 1, "l'écriture en vol est rejouée sans doublon");
  assert.equal(resumed.persisted, 2);
  assert.equal((await evaluationRows()).length, 4);
  assert.equal((await jobFor(offer.id)).processed_candidates_count, 4);
});

test("bail expiré juste après l'ouverture du chunk : lease_lost avant toute persistance 2D", async () => {
  const { offer } = await offerScenario(["compatible", "incompatible"]);
  const lost = await runOnly(offer.id, {
    hooks: { afterInitialize: async () => { await expireLease((await jobFor(offer.id)).id); } },
  });
  assert.equal(lost.outcome, "lease_lost");
  assert.deepEqual(summary(lost), { chunks: 0, persisted: 0, replayed: 0, skippedStale: 0, alreadySuperseded: 0 });
  assert.equal((await evaluationRows()).length, 0, "le heartbeat protège avant l'écriture 2D");
  const job = await jobFor(offer.id);
  assert.equal(job.status, "running");
  assert.equal(job.chunk_manifest.state, "initialized");
  assert.equal(job.chunk_manifest.manifest_version, 1);
});

// ───────────── 13-14. concurrence et deux sens ─────────────

test("concurrence : deux pools exécutent runMatchingWorkerOnce, chaque job est completed une fois", async () => {
  await resetAll();
  const sellers = [await createUser({}, pool), await createUser({}, pool)];
  const buyers = [await createUser({}, pool), await createUser({}, pool)];
  for (const seller of sellers) for (let i = 0; i < 2; i++) await createOffer({ ...offerInput(seller.id), rawText: `iPhone 13 n°${i}` }, pool);
  for (const buyer of buyers) for (const kind of ["compatible", "incompatible"] as const) await createDemand(demandInput(buyer.id, kind), pool);
  assert.equal((await projectOutboxBatch({ pool, limit: 100 })).jobsInserted, 8);
  const go = barrier(2);
  const drain = async (db: Pool, workerId: string) => {
    await go();
    const done: Array<MatchingJobRunResult & { jobId: string }> = [];
    for (;;) {
      const batch = await runMatchingWorkerOnce({ pool: db, workerId, limit: 2 });
      if (batch.length === 0) return done;
      done.push(...batch);
    }
  };
  const [first, other] = await Promise.all([drain(pool, "worker-a"), drain(second, "worker-b")]);
  const all = [...first, ...other];
  assert.equal(all.length, 8);
  assert.ok(all.every((result) => result.outcome === "completed"));
  assert.equal(new Set(all.map((result) => result.jobId)).size, 8, "chaque job exécuté une seule fois");
  const jobs = (await pool.query("SELECT status, attempts FROM matching_jobs")).rows;
  assert.ok(jobs.every((job) => job.status === "completed" && job.attempts === 1));
  const pairs = await pool.query(
    "SELECT offer_id, demand_id, count(*) FILTER (WHERE is_latest) AS active FROM matching_evaluations GROUP BY offer_id, demand_id");
  assert.equal(pairs.rowCount, 16, "toutes les paires évaluées");
  assert.ok(pairs.rows.every((row) => Number(row.active) === 1), "au plus une évaluation active par paire");
});

test("les deux sens sur une même paire : réévaluation plus récente puis déjà remplacée, jamais de doublon actif", async () => {
  // Cas A, séquentiel : le job demande évalue après le job offre (T_eval plus récent) → réévaluation, l'ancienne ligne est archivée.
  const sequential = await offerScenario(["compatible"]);
  const [offerRun] = await runMatchingWorkerOnce({ pool, workerId: "worker-a", limit: 1 });
  assert.equal((await jobFor(sequential.offer.id)).status, "completed");
  assert.equal(offerRun.persisted, 1);
  const [demandRun] = await runMatchingWorkerOnce({ pool, workerId: "worker-b", limit: 1 });
  assert.equal((await jobFor(sequential.demands[0].id)).status, "completed");
  assert.deepEqual({ outcome: demandRun.outcome, persisted: demandRun.persisted, replayed: demandRun.replayed }, { outcome: "completed", persisted: 1, replayed: 0 });
  const rows = await evaluationRows();
  assert.equal(rows.length, 2);
  assert.equal(rows.filter((row) => row.is_latest).length, 1);
  const archived = rows.find((row) => !row.is_latest)!;
  assert.equal(archived.stale_reason, "superseded_by_reevaluation");
  assert.ok(rows.find((row) => row.is_latest)!.evaluated_at.getTime() >= archived.evaluated_at.getTime());

  // Cas B, imbriqué : le job demande est ouvert (T_eval = t1) ; avant sa persistance, le job offre s'exécute entièrement
  // (t2 > t1) ; la barrière historique de 2D rend alors la tentative du job demande déjà remplacée.
  const nested = await offerScenario(["compatible"]);
  const leases = await claimMatchingJobs({ pool, workerId: "worker-n", limit: 2, jobTypes: ["evaluate_offer_candidates", "evaluate_demand_candidates"] });
  const offerLease = leases.find((lease) => lease.resourceId === nested.offer.id)!;
  const demandLease = leases.find((lease) => lease.resourceId === nested.demands[0].id)!;
  let nestedResult: MatchingJobRunResult | null = null;
  const outer = await runMatchingJob({
    pool, lease: demandLease,
    hooks: { beforePersist: async () => { nestedResult ??= await runMatchingJob({ pool, lease: offerLease }); } },
  });
  assert.equal(nestedResult!.outcome, "completed");
  assert.equal(nestedResult!.persisted, 1);
  assert.deepEqual({ outcome: outer.outcome, alreadySuperseded: outer.alreadySuperseded, persisted: outer.persisted }, { outcome: "completed", alreadySuperseded: 1, persisted: 0 });
  const nestedRows = await evaluationRows();
  assert.equal(nestedRows.length, 1, "la tentative la plus ancienne n'écrit rien");
  assert.equal(nestedRows.filter((row) => row.is_latest).length, 1);
});

// ───────────── 15. types non supportés ─────────────

test("un job user_reactivation_sweep reste pending et n'est jamais réservé par le worker", async () => {
  await resetAll();
  const user = await createUser({}, pool);
  const suspended = await updateUser({ id: user.id, expectedVersion: user.version, status: "suspended" }, pool);
  await updateUser({ id: user.id, expectedVersion: suspended.version, status: "active" }, pool);
  assert.equal((await projectOutboxBatch({ pool })).jobsInserted, 1);
  assert.deepEqual(await runMatchingWorkerOnce({ pool, workerId: "worker-a", limit: 10 }), []);
  const job = (await pool.query("SELECT status, attempts, locked_by FROM matching_jobs")).rows[0];
  assert.deepEqual(job, { status: "pending", attempts: 0, locked_by: null });
  // Appelé directement avec un bail d'un autre type, runMatchingJob échoue proprement sans rien évaluer.
  const [lease] = await claimMatchingJobs({ pool, workerId: "w", limit: 1 });
  const result = await runMatchingJob({ pool, lease });
  assert.equal(result.outcome, "failed");
  assert.equal(result.errorCode, "unsupported_job_type");
  assert.equal((await evaluationRows()).length, 0);
});

// ───────────── 16. validation avant SQL ─────────────

test("validation avant SQL : pageSize, limit, pool, bail et workerId invalides → zéro requête", async () => {
  const { offer } = await offerScenario(["compatible"]);
  await isolate(offer.id);
  const [lease] = await claimMatchingJobs({ pool, workerId: "w", limit: 1 });
  const { spy, count } = spyPool();
  const bad = (call: () => Promise<unknown>) => assert.rejects(call, MatchingJobValidationError);
  for (const pageSize of [0, 101, -1, 1.5, Number.NaN, "5", null]) {
    await bad(() => runMatchingJob({ pool: spy, lease, pageSize: pageSize as never }));
    await bad(() => runMatchingWorkerOnce({ pool: spy, workerId: "w", pageSize: pageSize as never }));
  }
  for (const limit of [0, 11, -1, 1.5, Number.NaN, "2", null]) {
    await bad(() => runMatchingWorkerOnce({ pool: spy, workerId: "w", limit: limit as never }));
  }
  for (const workerId of ["", "bad id", "a".repeat(129), undefined]) {
    await bad(() => runMatchingWorkerOnce({ pool: spy, workerId: workerId as never }));
  }
  for (const leaseSeconds of [14, 601, 15.5, null]) {
    await bad(() => runMatchingJob({ pool: spy, lease, leaseSeconds: leaseSeconds as never }));
    await bad(() => runMatchingWorkerOnce({ pool: spy, workerId: "w", leaseSeconds: leaseSeconds as never }));
  }
  for (const badLease of [null, undefined, { ...lease, jobId: "nope" }, { ...lease, claimToken: 5 }]) {
    await bad(() => runMatchingJob({ pool: spy, lease: badLease as never }));
  }
  let foreign = 0;
  const client = await pool.connect();
  const original = client.query.bind(client);
  (client as unknown as { query: unknown }).query = (...args: unknown[]) => { foreign++; return (original as (...a: unknown[]) => unknown)(...args); };
  const arbitrary = { query: async () => { foreign++; throw new Error("unexpected"); } };
  const duck = { ...arbitrary, connect: async () => { foreign++; throw new Error("unexpected"); } };
  try {
    for (const bogus of [client, arbitrary, duck, undefined, null]) {
      await bad(() => runMatchingJob({ pool: bogus as never, lease }));
      await bad(() => runMatchingWorkerOnce({ pool: bogus as never, workerId: "w" }));
    }
  } finally { client.release(); }
  assert.equal(foreign, 0);
  assert.equal(count(), 0);
});
