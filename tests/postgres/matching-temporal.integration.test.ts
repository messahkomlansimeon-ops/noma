import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { before, after, test } from "node:test";
import { Pool, type PoolClient } from "pg";
import { requestOtp, verifyOtp, type SendOtpInput } from "../../lib/server/auth";
import {
  archiveDemand, createDemand, createOffer, createUser, pauseOffer, satisfyDemand, updateOffer, updateUser,
} from "../../lib/server/catalog";
import { CatalogValidationError } from "../../lib/server/catalog/errors";
import type { DemandRecord, OfferRecord, UserRecord } from "../../lib/server/catalog/types";
import { findDemandCandidatesForOffer } from "../../lib/server/matching/candidates";
import { buildInitialChunkManifest } from "../../lib/server/matching/chunk-manifest";
import { initializeChunk } from "../../lib/server/matching/chunks";
import { createMatchingHttpHandlers } from "../../lib/server/matching/http";
import { MatchingJobValidationError, claimMatchingJobs, type JobLease } from "../../lib/server/matching/jobs";
import { OUTBOX_COLUMNS, mapOutboxRow, type OutboxRow } from "../../lib/server/matching/outbox";
import { computeScoringConfigHash, normalizeScoringConfig } from "../../lib/server/matching/persistence";
import {
  PROJECTABLE_EVENT_TYPES, computeJobIdentity, planOutboxProjection, projectOutboxBatch,
} from "../../lib/server/matching/projection";
import { runMatchingCycle, runMatchingWorkerLoop, type MatchingCycleResult } from "../../lib/server/matching/runner";
import { findEvaluatedDemandMatchesForOffer } from "../../lib/server/matching/service";
import { MatchingTemporalError, runTemporalExpirySweep } from "../../lib/server/matching/temporal";
import { runMatchingJob, type MatchingJobRunResult, type MatchingWorkerHooks } from "../../lib/server/matching/worker";
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
  assert.equal((await runMigrations(pool)).applied.length, 19);
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

/** Échéance lointaine : l'évaluation reçoit un expires_at non nul sans que le temps ait à passer. */
const farFuture = () => new Date(Date.now() + 3_600_000);

interface PairWorld {
  seller: UserRecord;
  buyer: UserRecord;
  offer: OfferRecord;
  /** Demandes avec échéance lointaine (leurs évaluations ont un expires_at). */
  timed: DemandRecord[];
  /** Demandes sans échéance (evaluations sans expires_at). */
  plain: DemandRecord[];
}

const cycleAll = async (db: Pool = pool, workerId = "temporal-a"): Promise<MatchingCycleResult[]> => {
  const results: MatchingCycleResult[] = [];
  for (let i = 0; i < 60; i++) {
    const result = await runMatchingCycle({ pool: db, workerId });
    results.push(result);
    if (result.idle) return results;
  }
  assert.fail("le travail ne se termine pas : trop de cycles");
};

/** Une offre, des demandes avec ou sans échéance, le tout évalué par le pipeline réel jusqu'à idle. */
async function pairWorld(options: { timed?: number; plain?: number; offerUpdates?: number } = {}): Promise<PairWorld> {
  const { timed: timedCount = 1, plain: plainCount = 0, offerUpdates = 0 } = options;
  await resetAll();
  const seller = await createUser({}, pool), buyer = await createUser({}, pool);
  let offer = await createOffer(offerInput(seller.id), pool);
  // Versions > 1 : l'événement doit porter la version RÉELLE de l'offre (jamais une fiction « version = 1 »).
  for (let i = 0; i < offerUpdates; i++) {
    offer = await updateOffer({ id: offer.id, ownerId: seller.id, expectedContentVersion: offer.contentVersion, changes: { rawText: `iPhone 13 128Go avec chargeur (révision ${i + 1})` } }, pool);
  }
  const timed: DemandRecord[] = [], plain: DemandRecord[] = [];
  for (let i = 0; i < timedCount; i++) timed.push(await createDemand(demandInput(buyer.id, { rawText: `Cherche iPhone 13 pressé n°${i}`, deadlineAt: farFuture() }), pool));
  for (let i = 0; i < plainCount; i++) plain.push(await createDemand(demandInput(buyer.id, { rawText: `Cherche iPhone 13 tranquille n°${i}` }), pool));
  await cycleAll();
  return { seller, buyer, offer, timed, plain };
}

// ───────────── aides d'inspection ─────────────
// L'horloge n'est pas simulée : pour « faire passer le temps », les tests mettent expires_at dans le passé par SQL
// (le balayeur compare à clock_timestamp()). Seul le test de bout en bout attend une vraie échéance.

const evaluations = async () => (await pool.query("SELECT * FROM matching_evaluations ORDER BY offer_id, demand_id, evaluated_at, id")).rows;
const latestRows = async () => (await evaluations()).filter((row) => row.is_latest);
const expireNow = (demandIds: string[]) => pool.query(
  "UPDATE matching_evaluations SET expires_at = clock_timestamp() - interval '1 second' WHERE is_latest AND demand_id = ANY($1::uuid[])", [demandIds]);
const temporalEvents = async () => (await pool.query(
  "SELECT * FROM matching_outbox_events WHERE event_type = 'temporal.deadline_passed' ORDER BY occurred_at, id")).rows;
const pairJobs = async () => (await pool.query("SELECT * FROM matching_jobs WHERE job_type = 'reevaluate_pair_temporal' ORDER BY created_at, id")).rows;
const snapshot = async (sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows;

async function sweepAndProject() {
  const swept = await runTemporalExpirySweep({ pool });
  const projection = await projectOutboxBatch({ pool, limit: 100 });
  return { swept, projection };
}

async function claimPair(db: Pool = pool, workerId = "pair-a"): Promise<JobLease> {
  const [lease] = await claimMatchingJobs({ pool: db, workerId, limit: 1, jobTypes: ["reevaluate_pair_temporal"] });
  assert.ok(lease, "un job de paire réservable est attendu");
  return lease;
}

const runPair = (lease: JobLease, hooks?: MatchingWorkerHooks, db: Pool = pool): Promise<MatchingJobRunResult> =>
  runMatchingJob({ pool: db, lease, hooks });

const expireLease = (jobId: string) =>
  pool.query("UPDATE matching_jobs SET lock_expires_at = clock_timestamp() - interval '1 second' WHERE id = $1 AND status = 'running'", [jobId]);

const failingFunction = () => pool.query(
  "CREATE OR REPLACE FUNCTION reject_temporal_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'temporal audit failure'; END $$");
async function withTrigger(ddl: string, name: string, table: string, run: () => Promise<void>) {
  await failingFunction();
  await pool.query(ddl);
  try { await run(); } finally { await pool.query(`DROP TRIGGER IF EXISTS ${name} ON ${table}`); }
}

/** Pool dont connect()/query() sont comptés ; `trace` reçoit chaque requête (texte, valeurs) des clients réservés. */
function observed(trace?: (text: string, values: unknown[] | undefined) => void) {
  let queries = 0;
  const spy = Object.create(pool) as Pool;
  const baseQuery = pool.query.bind(pool);
  spy.query = ((...args: unknown[]) => {
    queries++;
    trace?.(typeof args[0] === "string" ? args[0] : "", Array.isArray(args[1]) ? args[1] : undefined);
    return (baseQuery as (...a: unknown[]) => unknown)(...args);
  }) as never;
  spy.connect = (async () => {
    queries++;
    const client = await pool.connect();
    const originalQuery = client.query;
    const originalRelease = client.release;
    const query = client.query.bind(client) as (...a: unknown[]) => Promise<unknown>;
    client.query = ((...args: unknown[]) => {
      trace?.(typeof args[0] === "string" ? args[0] : "", Array.isArray(args[1]) ? args[1] : undefined);
      return query(...args);
    }) as never;
    // La connexion revient au pool : on retire le détournement pour ne pas contaminer les tests suivants.
    client.release = ((error?: Error | boolean) => { client.query = originalQuery; client.release = originalRelease; return originalRelease.call(client, error); }) as never;
    return client as PoolClient;
  }) as never;
  return { spy, count: () => queries };
}

function barrier(parties: number) {
  let arrived = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("barrière non atteinte")), 8000));
  return async () => { if (++arrived === parties) release(); await Promise.race([gate, timeout]); };
}

// ═════════════ 2. Restriction interne à un candidat (2C1 et 2C2) ═════════════

test("candidateId : éligible → 1, ineligible → 0, inexistant → 0, avec exactement les filtres de la recherche normale", async () => {
  await resetAll();
  const seller = await createUser({}, pool), buyer = await createUser({}, pool), suspended = await createUser({}, pool);
  const offer = await createOffer(offerInput(seller.id), pool);
  const eligible = await createDemand(demandInput(buyer.id), pool);
  const draft = await createDemand(demandInput(buyer.id, { status: "draft" }), pool);
  const satisfiedBase = await createDemand(demandInput(buyer.id), pool);
  const satisfied = await satisfyDemand(buyer.id, satisfiedBase.id, satisfiedBase.contentVersion, pool);
  const archivedBase = await createDemand(demandInput(buyer.id), pool);
  const archived = await archiveDemand(buyer.id, archivedBase.id, archivedBase.contentVersion, pool);
  const ownDemand = await createDemand(demandInput(seller.id), pool);
  const ofSuspended = await createDemand(demandInput(suspended.id), pool);
  await updateUser({ id: suspended.id, expectedVersion: suspended.version, status: "suspended" }, pool);
  // La recherche 2C1 n'a AUCUN filtre de catégorie : une demande d'une autre catégorie reste candidate (l'évaluation
  // la dira incompatible). La restriction doit donc la retrouver aussi.
  const otherCategory = await createDemand(demandInput(buyer.id, { category: "vehicules", brand: "Toyota", model: "Corolla" }), pool);

  const normal = (await findDemandCandidatesForOffer(seller.id, offer.id, { limit: 100 }, pool)).items.map((item) => item.id);
  const restricted = async (candidateId: string) =>
    (await findDemandCandidatesForOffer(seller.id, offer.id, { candidateId }, pool)).items.map((item) => item.id);

  assert.deepEqual(await restricted(eligible.id), [eligible.id]);
  assert.deepEqual(await restricted(otherCategory.id), [otherCategory.id], "pas de filtre de catégorie en 2C1");
  for (const [name, demand] of [["brouillon", draft], ["satisfaite", satisfied], ["archivée", archived], ["même propriétaire", ownDemand], ["propriétaire suspendu", ofSuspended]] as const) {
    assert.deepEqual(await restricted(demand.id), [], name);
  }
  assert.deepEqual(await restricted(randomUUID()), [], "candidat inexistant");
  // Équivalence avec la recherche normale pour chaque demande créée.
  for (const demand of [eligible, draft, satisfied, archived, ownDemand, ofSuspended, otherCategory]) {
    assert.deepEqual(await restricted(demand.id), normal.includes(demand.id) ? [demand.id] : [], demand.id);
  }
  // Même casse que la recherche normale : un UUID en majuscules est accepté.
  assert.deepEqual(await restricted(eligible.id.toUpperCase()), [eligible.id]);

  // La source reste contrôlée exactement comme avant : offre en pause → erreur de validation, avec ou sans restriction.
  await pauseOffer(seller.id, offer.id, offer.contentVersion, pool);
  await assert.rejects(findDemandCandidatesForOffer(seller.id, offer.id, { candidateId: eligible.id }, pool), CatalogValidationError);
});

test("candidateId au niveau 2C2 : une seule évaluation, la même que dans la page complète ; inéligible → page vide", async () => {
  await resetAll();
  const seller = await createUser({}, pool), buyer = await createUser({}, pool);
  const offer = await createOffer(offerInput(seller.id), pool);
  const target = await createDemand(demandInput(buyer.id), pool);
  await createDemand(demandInput(buyer.id, { rawText: "Cherche iPhone 13 autre" }), pool);
  const archivedBase = await createDemand(demandInput(buyer.id), pool);
  const archived = await archiveDemand(buyer.id, archivedBase.id, archivedBase.contentVersion, pool);
  const now = new Date();
  const full = await findEvaluatedDemandMatchesForOffer(seller.id, offer.id, { limit: 100, now }, pool);
  assert.equal(full.items.length, 2);
  const one = await findEvaluatedDemandMatchesForOffer(seller.id, offer.id, { limit: 1, now, candidateId: target.id }, pool);
  assert.equal(one.items.length, 1);
  assert.equal(one.hasMore, false);
  assert.equal(one.nextCursor, null);
  assert.deepEqual(one.items[0], full.items.find((item) => item.candidateId === target.id));
  const none = await findEvaluatedDemandMatchesForOffer(seller.id, offer.id, { limit: 1, now, candidateId: archived.id }, pool);
  assert.deepEqual(none.items, []);
  assert.equal(none.source.id, offer.id);
});

test("candidateId : validation avant tout SQL (UUID, curseur incompatible)", async () => {
  let queries = 0;
  const executor = { query: async () => { queries++; throw new Error("requête inattendue"); } };
  const { spy, count } = observed();
  const ownerId = randomUUID(), offerId = randomUUID();
  const cursor = Buffer.from(JSON.stringify({ createdAtIso: "2026-01-01T00:00:00.000000Z", id: randomUUID() })).toString("base64url");
  for (const candidateId of ["x", "", "123", 12, null, {}, `${randomUUID()}-`] as unknown[]) {
    await assert.rejects(findDemandCandidatesForOffer(ownerId, offerId, { candidateId } as never, executor as never), CatalogValidationError, String(candidateId));
    await assert.rejects(findEvaluatedDemandMatchesForOffer(ownerId, offerId, { candidateId } as never, spy), CatalogValidationError, String(candidateId));
  }
  const valid = randomUUID();
  await assert.rejects(findDemandCandidatesForOffer(ownerId, offerId, { candidateId: valid, cursor }, executor as never), /candidateId ne peut pas être combiné à un curseur/);
  await assert.rejects(findEvaluatedDemandMatchesForOffer(ownerId, offerId, { candidateId: valid, cursor }, spy), /candidateId ne peut pas être combiné à un curseur/);
  assert.equal(queries, 0);
  assert.equal(count(), 0);
});

test("candidateId n'est exposé par aucune route : paramètre refusé, DTO et routes sans trace", async () => {
  await resetAll();
  const secret = randomBytes(32);
  let phone = 0;
  const clock = () => new Date();
  let delivery: SendOtpInput | undefined;
  const requested = await requestOtp(`+22507${String(++phone).padStart(8, "0")}`, {
    pool, now: clock, authSecret: secret, requestIp: "198.51.100.77", sendOtp: async (input) => { delivery = input; },
  });
  assert.ok(delivery);
  const verified = await verifyOtp(requested.challengeId, delivery.code, { pool, now: clock, authSecret: secret });
  const cookie = `noma_auth=${verified.sessionToken}`;
  const offer = await createOffer(offerInput(verified.userId), pool);
  const buyer = await createUser({}, pool);
  const demand = await createDemand(demandInput(buyer.id), pool);
  await createDemand(demandInput(buyer.id, { rawText: "Cherche iPhone 13 autre" }), pool);
  const handlers = createMatchingHttpHandlers({ pool, now: clock });
  const get = (query: string) => handlers.offers.matches(
    new Request(`https://noma.test/api/offers/${offer.id}/matches${query}`, { headers: { cookie } }), offer.id);

  const control = await get("?limit=5");
  assert.equal(control.status, 200);
  assert.equal(((await control.json()) as { items: unknown[] }).items.length, 2, "sans paramètre : toute la liste");
  for (const query of [`?candidateId=${demand.id}`, `?limit=5&candidateId=${demand.id}`, `?candidate_id=${demand.id}`]) {
    const response = await get(query);
    assert.equal(response.status, 400, query);
    assert.equal(((await response.json()) as { error: { code: string } }).error.code, "invalid_request");
  }
  for (const file of ["lib/server/matching/http.ts", "app/api/offers/[id]/matches/route.ts", "app/api/demands/[id]/matches/route.ts"]) {
    assert.ok(!readFileSync(file, "utf8").includes("candidateId"), `${file} ne référence pas candidateId`);
  }
});

// ═════════════ 3. Balayeur temporel ═════════════

test("balayeur : une ligne expirée est périmée (temporal_expiry) avec UN événement aux champs exacts", async () => {
  const world = await pairWorld({ timed: 1, offerUpdates: 2 });
  assert.equal(world.offer.contentVersion, 3);
  const [before] = await latestRows();
  assert.ok(before.expires_at, "l'évaluation a un expires_at");
  await expireNow([world.timed[0].id]);

  assert.deepEqual(await runTemporalExpirySweep({ pool }), { expired: 1 });
  const row = (await pool.query("SELECT * FROM matching_evaluations WHERE id = $1", [before.id])).rows[0];
  assert.equal(row.is_stale, true);
  assert.equal(row.is_latest, false);
  assert.equal(row.stale_reason, "temporal_expiry");
  assert.ok(row.staled_at);

  const events = await temporalEvents();
  assert.equal(events.length, 1);
  const [event] = events;
  assert.equal(event.aggregate_type, "temporal");
  assert.equal(event.aggregate_id, world.offer.id);
  assert.equal(event.aggregate_version, world.offer.contentVersion);
  assert.equal(event.target_aggregate_id, world.timed[0].id);
  assert.equal(event.dispatch_status, "pending");
  assert.equal(event.payload.demandId, world.timed[0].id);
  assert.equal(event.payload.demandContentVersion, world.timed[0].contentVersion);
  assert.equal(event.payload.expiredEvaluationId, before.id);
  assert.equal(event.payload.generation, world.offer.contentVersion);
  assert.equal(event.payload.scoring_config_hash, computeScoringConfigHash(normalizeScoringConfig()), "configuration scellée");
  assert.deepEqual(Object.keys(event.payload).sort(), [
    "demandContentVersion", "demandId", "engine_offline_version", "engine_scoring_version", "expiredEvaluationId",
    "generation", "scoring_config", "scoring_config_hash",
  ]);
  // Rejouer le balayage ne produit rien de plus.
  assert.deepEqual(await runTemporalExpirySweep({ pool }), { expired: 0 });
  assert.equal((await temporalEvents()).length, 1);
});

test("balayeur : lignes non expirées, déjà périmées, non-latest ou fraîchement réévaluées intactes", async () => {
  const world = await pairWorld({ timed: 4 });
  const rows = await latestRows();
  const byDemand = new Map(rows.map((row) => [row.demand_id, row]));
  const [expiredDemand, futureDemand, staleDemand, archivedDemand] = world.timed;

  await expireNow([expiredDemand.id, staleDemand.id, archivedDemand.id]);
  await pool.query("UPDATE matching_evaluations SET is_stale = TRUE, stale_reason = 'demand_updated', staled_at = clock_timestamp() WHERE id = $1", [byDemand.get(staleDemand.id).id]);
  await pool.query("UPDATE matching_evaluations SET is_latest = FALSE WHERE id = $1", [byDemand.get(archivedDemand.id).id]);
  const intactIds = [byDemand.get(futureDemand.id).id, byDemand.get(staleDemand.id).id, byDemand.get(archivedDemand.id).id];
  const before = await snapshot("SELECT to_jsonb(e.*) AS row FROM matching_evaluations e WHERE id = ANY($1::uuid[]) ORDER BY id", [intactIds]);

  assert.deepEqual(await runTemporalExpirySweep({ pool }), { expired: 1 });
  assert.deepEqual(await snapshot("SELECT to_jsonb(e.*) AS row FROM matching_evaluations e WHERE id = ANY($1::uuid[]) ORDER BY id", [intactIds]), before);
  const [event] = await temporalEvents();
  assert.equal(event.payload.expiredEvaluationId, byDemand.get(expiredDemand.id).id);
  assert.equal((await temporalEvents()).length, 1);
});

test("balayeur : une évaluation fraîche persistée entre-temps sur la même paire n'est jamais touchée", async () => {
  const world = await pairWorld({ timed: 1 });
  // Le pipeline a évalué la paire dans les deux sens : l'ancienne ligne est archivée, la plus récente est active.
  const all = (await evaluations()).filter((row) => row.demand_id === world.timed[0].id);
  assert.ok(all.length >= 2, "au moins deux évaluations de la paire (réévaluation)");
  const fresh = all.find((row) => row.is_latest);
  const archived = all.filter((row) => !row.is_latest);
  assert.ok(fresh && archived.every((row) => row.stale_reason === "superseded_by_reevaluation"));
  // L'ancienne ligne a une échéance dépassée ; la fraîche non.
  await pool.query("UPDATE matching_evaluations SET expires_at = clock_timestamp() - interval '1 second' WHERE id = ANY($1::uuid[])", [archived.map((row) => row.id)]);
  const before = await snapshot("SELECT to_jsonb(e.*) AS row FROM matching_evaluations e ORDER BY id");
  assert.deepEqual(await runTemporalExpirySweep({ pool }), { expired: 0 });
  assert.deepEqual(await snapshot("SELECT to_jsonb(e.*) AS row FROM matching_evaluations e ORDER BY id"), before);
  assert.equal((await temporalEvents()).length, 0);
});

test("balayeur : panne de recordOutboxEvent → aucune ligne périmée, aucun événement (lot annulé)", async () => {
  const world = await pairWorld({ timed: 2 });
  await expireNow(world.timed.map((demand) => demand.id));
  const before = await snapshot("SELECT to_jsonb(e.*) AS row FROM matching_evaluations e ORDER BY id");
  const eventsBefore = (await pool.query("SELECT count(*)::int AS n FROM matching_outbox_events")).rows[0].n;
  await withTrigger(
    "CREATE TRIGGER reject_temporal_event BEFORE INSERT ON matching_outbox_events FOR EACH ROW EXECUTE FUNCTION reject_temporal_audit()",
    "reject_temporal_event", "matching_outbox_events", async () => {
      await assert.rejects(runTemporalExpirySweep({ pool }), /temporal audit failure/);
    });
  assert.deepEqual(await snapshot("SELECT to_jsonb(e.*) AS row FROM matching_evaluations e ORDER BY id"), before);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM matching_outbox_events")).rows[0].n, eventsBefore);

  // Panne après la première ligne périmée (hook) : même garantie, y compris pour la première ligne.
  let recorded = 0;
  await assert.rejects(runTemporalExpirySweep({ pool, hooks: { beforeRecord: () => { if (++recorded === 2) throw new Error("panne du hook"); } } }), /panne du hook/);
  assert.deepEqual(await snapshot("SELECT to_jsonb(e.*) AS row FROM matching_evaluations e ORDER BY id"), before);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM matching_outbox_events")).rows[0].n, eventsBefore);
  // Les verrous sont libérés : un balayage normal réussit ensuite.
  assert.deepEqual(await runTemporalExpirySweep({ pool }), { expired: 2 });
  assert.equal((await temporalEvents()).length, 2);
});

test("balayeur : limit respectée (plus anciennes échéances d'abord)", async () => {
  const world = await pairWorld({ timed: 3 });
  const rows = await latestRows();
  const order = world.timed.map((demand) => rows.find((row) => row.demand_id === demand.id));
  for (const [index, row] of order.entries()) {
    await pool.query("UPDATE matching_evaluations SET expires_at = clock_timestamp() - ($2::int * interval '1 minute') WHERE id = $1", [row.id, 10 - index]);
  }
  assert.deepEqual(await runTemporalExpirySweep({ pool, limit: 2 }), { expired: 2 });
  const events = await temporalEvents();
  assert.deepEqual(events.map((event) => event.payload.expiredEvaluationId).sort(), [order[0].id, order[1].id].sort());
  assert.deepEqual(await runTemporalExpirySweep({ pool, limit: 2 }), { expired: 1 });
});

test("balayeur : validation avant SQL (pool, limit)", async () => {
  const { spy, count } = observed();
  for (const bad of [undefined, null, {}, { query: async () => ({ rows: [] }) }, { query: async () => ({ rows: [] }), connect: async () => ({}) }]) {
    await assert.rejects(runTemporalExpirySweep({ pool: bad as never }), MatchingTemporalError);
  }
  for (const limit of [0, -1, 501, 1.5, Number.NaN, "5", null, Number.POSITIVE_INFINITY]) {
    await assert.rejects(runTemporalExpirySweep({ pool: spy, limit: limit as never }), MatchingTemporalError, String(limit));
  }
  assert.equal(count(), 0);
});

// ═════════════ 2. Concurrence des balayeurs ═════════════

test("concurrence : deux balayeurs avec barrière → ensembles disjoints, un événement par ligne expirée, aucun doublon", async () => {
  const world = await pairWorld({ timed: 6 });
  await expireNow(world.timed.map((demand) => demand.id));
  const meet = barrier(2);
  const seen: string[][] = [[], []];
  const run = (db: Pool, index: number) => runTemporalExpirySweep({
    pool: db, limit: 3,
    hooks: { afterSelect: async (rows) => { seen[index] = rows.map((row) => row.id); await meet(); } },
  });
  const [first, other] = await Promise.all([run(pool, 0), run(second, 1)]);
  assert.equal(first.expired, 3);
  assert.equal(other.expired, 3);
  assert.equal(seen[0].filter((id) => seen[1].includes(id)).length, 0, "ensembles disjoints");
  const events = await temporalEvents();
  assert.equal(events.length, 6, "autant d'événements que de lignes expirées");
  assert.equal(new Set(events.map((event) => event.payload.expiredEvaluationId)).size, 6, "aucun doublon");
  assert.deepEqual(events.map((event) => event.payload.expiredEvaluationId).sort(), [...seen[0], ...seen[1]].sort());
  assert.equal((await latestRows()).filter((row) => row.expires_at !== null).length, 0, "plus aucune ligne active expirée");
});

// ═════════════ 4. Projection de temporal.deadline_passed ═════════════

function sealedPayload(overrides: Record<string, unknown> = {}) {
  const config = normalizeScoringConfig();
  return {
    demandId: randomUUID(), demandContentVersion: 1, expiredEvaluationId: randomUUID(), generation: 1,
    scoring_config: config, scoring_config_hash: computeScoringConfigHash(config),
    engine_offline_version: "matching-offline/v1", engine_scoring_version: "matching-scoring/v1", ...overrides,
  };
}

async function rawTemporalEvent(input: { offerId?: string; version?: number | null; target?: string | null; payload?: Record<string, unknown>; aggregateType?: string }) {
  const id = randomUUID();
  const offerId = input.offerId ?? randomUUID();
  const target = input.target === undefined ? randomUUID() : input.target;
  const payload = input.payload ?? sealedPayload({ demandId: target, generation: input.version === undefined ? 1 : input.version });
  await pool.query(
    `INSERT INTO matching_outbox_events (id, event_type, aggregate_type, aggregate_id, aggregate_version, target_aggregate_id, payload)
     VALUES ($1, 'temporal.deadline_passed', $2, $3, $4, $5, $6::jsonb)`,
    [id, input.aggregateType ?? "temporal", offerId, input.version === undefined ? 1 : input.version, target, JSON.stringify(payload)]);
  return id;
}

test("projection temporal : deux expirations sur la même offre v1 avec deux demandes → 2 jobs distincts (plan §9.1)", async () => {
  const world = await pairWorld({ timed: 2 });
  await expireNow(world.timed.map((demand) => demand.id));
  assert.deepEqual(await runTemporalExpirySweep({ pool }), { expired: 2 });
  const events = await temporalEvents();
  assert.equal(events.length, 2);
  assert.ok(PROJECTABLE_EVENT_TYPES.includes("temporal.deadline_passed"));
  assert.ok(!PROJECTABLE_EVENT_TYPES.includes("scoring_config.updated" as never));
  assert.ok(!PROJECTABLE_EVENT_TYPES.includes("catalog.bootstrap_sync" as never));

  const projection = await projectOutboxBatch({ pool, limit: 100 });
  assert.deepEqual({ selected: projection.selected, projected: projection.projected, inserted: projection.jobsInserted, invalid: projection.invalid }, { selected: 2, projected: 2, inserted: 2, invalid: 0 });
  const jobs = await pairJobs();
  assert.equal(jobs.length, 2);
  assert.equal(new Set(jobs.map((job) => job.job_identity)).size, 2);
  for (const job of jobs) {
    const event = events.find((candidate) => candidate.id === job.source_event_id)!;
    assert.equal(job.resource_id, world.offer.id);
    assert.equal(job.resource_version, world.offer.contentVersion);
    assert.equal(job.target_resource_id, event.target_aggregate_id);
    assert.equal(job.scoring_config_hash, event.payload.scoring_config_hash);
    assert.equal(job.status, "pending");
    assert.equal(job.job_identity, computeJobIdentity({
      generation: world.offer.contentVersion, jobType: "reevaluate_pair_temporal", resourceId: world.offer.id,
      resourceVersion: world.offer.contentVersion, scoringConfigHash: event.payload.scoring_config_hash as string,
      sourceEventId: event.id, targetResourceId: event.target_aggregate_id,
    }));
  }
  assert.deepEqual(new Set(jobs.map((job) => job.target_resource_id)), new Set(world.timed.map((demand) => demand.id)));
  // Rejouer la projection d'un événement ne crée rien de plus.
  await pool.query("UPDATE matching_outbox_events SET dispatch_status = 'pending', dispatched_at = NULL WHERE event_type = 'temporal.deadline_passed'");
  const replay = await projectOutboxBatch({ pool, limit: 100 });
  assert.deepEqual({ inserted: replay.jobsInserted, present: replay.jobsAlreadyPresent }, { inserted: 0, present: 2 });
  assert.equal((await pairJobs()).length, 2);
});

test("projection temporal : chaque cas invalide → code stable, événement acquitté, lot jamais bloqué", async () => {
  await resetAll();
  const target = randomUUID();
  const cases: Array<[string, Promise<string>]> = [];
  const bad = (code: string, create: () => Promise<string>) => cases.push([code, create()]);
  bad("aggregate_mismatch", () => rawTemporalEvent({ aggregateType: "offer", version: 1, target }));
  bad("missing_target", () => rawTemporalEvent({ target: null }));
  bad("invalid_aggregate_version", () => rawTemporalEvent({ version: null, target }));
  bad("generation_mismatch", () => rawTemporalEvent({ version: 2, target, payload: sealedPayload({ demandId: target, generation: 3 }) }));
  bad("invalid_scoring_config", () => rawTemporalEvent({ target, payload: { ...sealedPayload({ demandId: target }), scoring_config: "x" } }));
  bad("invalid_scoring_config_hash", () => rawTemporalEvent({ target, payload: sealedPayload({ demandId: target, scoring_config_hash: "zz" }) }));
  bad("scoring_config_hash_mismatch", () => rawTemporalEvent({ target, payload: sealedPayload({ demandId: target, scoring_config_hash: "a".repeat(64) }) }));
  bad("invalid_engine_version", () => rawTemporalEvent({ target, payload: sealedPayload({ demandId: target, engine_scoring_version: "" }) }));
  bad("invalid_expired_evaluation_id", () => rawTemporalEvent({ target, payload: sealedPayload({ demandId: target, expiredEvaluationId: "pas-un-uuid" }) }));
  bad("invalid_expired_evaluation_id", () => rawTemporalEvent({ target, payload: (() => { const p = sealedPayload({ demandId: target }) as Record<string, unknown>; delete p.expiredEvaluationId; return p; })() }));
  bad("target_payload_mismatch", () => rawTemporalEvent({ target, payload: sealedPayload({ demandId: randomUUID() }) }));
  bad("target_payload_mismatch", () => rawTemporalEvent({ target, payload: (() => { const p = sealedPayload({ demandId: target }) as Record<string, unknown>; delete p.demandId; return p; })() }));
  const ids = await Promise.all(cases.map(([, id]) => id));
  const healthyId = await rawTemporalEvent({ version: 1, target });

  const projection = await projectOutboxBatch({ pool, limit: 100 });
  assert.deepEqual({ selected: projection.selected, projected: projection.projected, invalid: projection.invalid }, { selected: ids.length + 1, projected: 1, invalid: ids.length });
  for (const [index, [code]] of cases.entries()) {
    const row = (await pool.query("SELECT dispatch_status, error_message FROM matching_outbox_events WHERE id = $1", [ids[index]])).rows[0];
    assert.deepEqual(row, { dispatch_status: "ignored", error_message: code }, `cas ${index} : ${code}`);
    const event = mapOutboxRow((await pool.query<OutboxRow>(`SELECT ${OUTBOX_COLUMNS} FROM matching_outbox_events WHERE id = $1`, [ids[index]])).rows[0]);
    assert.deepEqual(planOutboxProjection(event), { kind: "invalid", code });
  }
  const healthy = (await pool.query("SELECT dispatch_status FROM matching_outbox_events WHERE id = $1", [healthyId])).rows[0];
  assert.equal(healthy.dispatch_status, "projected", "l'événement valide du même lot est projeté");
  assert.equal((await pairJobs()).length, 1);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM matching_outbox_events WHERE dispatch_status = 'pending'")).rows[0].n, 0);
});

// ═════════════ 5. Liaison du manifeste pour reevaluate_pair_temporal ═════════════

async function pairLeaseWithLoad() {
  const world = await pairWorld({ timed: 1, plain: 1 });
  await expireNow([world.timed[0].id]);
  await sweepAndProject();
  const lease = await claimPair();
  assert.equal(lease.targetResourceId, world.timed[0].id);
  return { world, lease };
}

function manifestFor(lease: JobLease, options: { candidates?: string[]; chunkIndex?: number; cursorIn?: string | null; cursorOut?: string | null; pairVersion?: number; pred?: { id: string; version: number } }) {
  return buildInitialChunkManifest({
    chunkId: randomUUID(), chunkIndex: options.chunkIndex ?? 0,
    predecessorChunkId: options.pred?.id ?? null, predecessorManifestVersion: options.pred?.version ?? null,
    cursorIn: options.cursorIn ?? null, cursorOut: options.cursorOut ?? null,
    evaluatedAt: new Date(Date.now() - 1000), scoringConfigHash: lease.scoringConfigHash as string,
    engineOfflineVersion: "matching-offline/v1", engineScoringVersion: "matching-scoring/v1",
    candidates: (options.candidates ?? []).map((candidateId) => ({
      candidateId, candidateVersion: 1, pairResourceId: lease.resourceId, pairResourceVersion: options.pairVersion ?? lease.resourceVersion,
      attemptId: randomUUID(), idempotencyKey: randomUUID(), attemptHash: "b".repeat(64),
    })),
  });
}

test("liaison reevaluate_pair_temporal : chaque règle supplémentaire est rejetée, job strictement inchangé ; cas valides appliqués", async () => {
  const { world, lease } = await pairLeaseWithLoad();
  const other = world.plain[0].id;
  const target = world.timed[0].id;
  const C1 = Buffer.from(JSON.stringify({ createdAtIso: "2026-01-02T00:00:00.000000Z", id: randomUUID() })).toString("base64url");
  const C0 = Buffer.from(JSON.stringify({ createdAtIso: "2026-01-03T00:00:00.000000Z", id: randomUUID() })).toString("base64url");
  const jobSnapshot = () => snapshot("SELECT to_jsonb(j.*) AS job FROM matching_jobs j WHERE id = $1", [lease.jobId]);
  const before = await jobSnapshot();
  const rejections: Array<[string, ReturnType<typeof manifestFor>, string]> = [
    ["candidat ≠ cible", manifestFor(lease, { candidates: [other] }), "target_mismatch"],
    ["cible + un autre candidat", manifestFor(lease, { candidates: [target, other] }), "target_mismatch"],
    ["pas EOF (curseur de sortie)", manifestFor(lease, { candidates: [target], cursorOut: C1 }), "invalid_next_manifest"],
    ["curseur d'entrée non nul", manifestFor(lease, { candidates: [target], cursorIn: C0 }), "invalid_next_manifest"],
    ["chunk d'index 1", manifestFor(lease, { candidates: [target], chunkIndex: 1, pred: { id: randomUUID(), version: 3 } }), "invalid_next_manifest"],
    ["version de paire ≠ job", manifestFor(lease, { candidates: [target], pairVersion: lease.resourceVersion + 1 }), "pair_resource_mismatch"],
  ];
  for (const [name, manifest, reason] of rejections) {
    assert.deepEqual(await initializeChunk({ pool, lease, manifest }), { kind: "rejected", reason }, name);
    assert.deepEqual(await jobSnapshot(), before, `${name} : job inchangé`);
  }
  // Configuration scellée : règle existante inchangée pour ce type.
  const wrongConfig = buildInitialChunkManifest({ chunkId: randomUUID(), chunkIndex: 0, cursorIn: null, cursorOut: null,
    evaluatedAt: new Date(), scoringConfigHash: "c".repeat(64), engineOfflineVersion: "matching-offline/v1", engineScoringVersion: "matching-scoring/v1", candidates: [] });
  assert.deepEqual(await initializeChunk({ pool, lease, manifest: wrongConfig }), { kind: "rejected", reason: "config_mismatch" });
  assert.deepEqual(await jobSnapshot(), before);

  // Cas valide : un chunk EOF, la cible seule.
  const good = manifestFor(lease, { candidates: [target] });
  assert.deepEqual(await initializeChunk({ pool, lease, manifest: good }), { kind: "applied" });
  assert.deepEqual(await initializeChunk({ pool, lease, manifest: good }), { kind: "already_applied" });
});

test("liaison reevaluate_pair_temporal : un chunk EOF sans candidat est accepté", async () => {
  const { lease } = await pairLeaseWithLoad();
  assert.deepEqual(await initializeChunk({ pool, lease, manifest: manifestFor(lease, { candidates: [] }) }), { kind: "applied" });
});

test("liaison reevaluate_pair_temporal : un job sans cible n'accepte aucun candidat", async () => {
  await resetAll();
  const config = normalizeScoringConfig();
  const eventId = await rawTemporalEvent({ version: 1, target: randomUUID() });
  await pool.query(
    "INSERT INTO matching_jobs(job_identity, job_type, resource_id, resource_version, scoring_config_hash, source_event_id) VALUES ($1,'reevaluate_pair_temporal',$2,1,$3,$4)",
    ["d".repeat(64), randomUUID(), computeScoringConfigHash(config), eventId]);
  const lease = await claimPair();
  assert.equal(lease.targetResourceId, null);
  const before = await snapshot("SELECT to_jsonb(j.*) AS job FROM matching_jobs j WHERE id = $1", [lease.jobId]);
  assert.deepEqual(await initializeChunk({ pool, lease, manifest: manifestFor(lease, { candidates: [randomUUID()] }) }), { kind: "rejected", reason: "target_mismatch" });
  assert.deepEqual(await snapshot("SELECT to_jsonb(j.*) AS job FROM matching_jobs j WHERE id = $1", [lease.jobId]), before);
});

// ═════════════ 6. Worker : job de paire ═════════════

test("job de paire : une évaluation active exactement pour la paire, aux versions courantes, ancienne ligne temporal_expiry", async () => {
  const world = await pairWorld({ timed: 1, plain: 2, offerUpdates: 1 });
  assert.equal(world.offer.contentVersion, 2);
  const target = world.timed[0];
  const old = (await latestRows()).find((row) => row.demand_id === target.id);
  const othersBefore = await snapshot("SELECT to_jsonb(e.*) AS row FROM matching_evaluations e WHERE demand_id <> $1 ORDER BY id", [target.id]);
  await expireNow([target.id]);
  const { swept, projection } = await sweepAndProject();
  assert.equal(swept.expired, 1);
  assert.equal(projection.jobsInserted, 1);

  const lease = await claimPair();
  const result = await runPair(lease);
  assert.deepEqual({ outcome: result.outcome, chunks: result.chunks, persisted: result.persisted, replayed: result.replayed, skippedStale: result.skippedStale }, { outcome: "completed", chunks: 1, persisted: 1, replayed: 0, skippedStale: 0 });

  const rows = (await evaluations()).filter((row) => row.demand_id === target.id);
  const latest = rows.filter((row) => row.is_latest);
  assert.equal(latest.length, 1, "exactement une évaluation active pour la paire");
  assert.notEqual(latest[0].id, old.id);
  assert.equal(latest[0].offer_content_version, world.offer.contentVersion);
  assert.equal(latest[0].demand_content_version, target.contentVersion);
  assert.equal(latest[0].is_stale, false);
  assert.ok(latest[0].evaluated_at.getTime() > old.evaluated_at.getTime());
  const oldNow = rows.find((row) => row.id === old.id);
  assert.equal(oldNow.stale_reason, "temporal_expiry", "l'ancienne ligne reste périmée pour la raison temporelle");
  assert.equal(oldNow.is_latest, false);
  // Les autres demandes de l'offre n'ont pas été relues ni réécrites.
  assert.deepEqual(await snapshot("SELECT to_jsonb(e.*) AS row FROM matching_evaluations e WHERE demand_id <> $1 ORDER BY id", [target.id]), othersBefore);
  const job = (await pairJobs())[0];
  assert.equal(job.status, "completed");
  assert.equal(job.chunk_manifest.is_eof, true);
  assert.equal(job.chunk_manifest.candidates.length, 1);
  assert.equal(job.chunk_manifest.candidates[0].candidate_id, target.id);
});

test("job de paire : offre modifiée entre-temps → superseded, aucune évaluation écrite", async () => {
  const world = await pairWorld({ timed: 1 });
  await expireNow([world.timed[0].id]);
  await sweepAndProject();
  await updateOffer({ id: world.offer.id, ownerId: world.seller.id, expectedContentVersion: world.offer.contentVersion, changes: { rawText: "iPhone 13 modifié" } }, pool);
  const evaluationsBefore = (await evaluations()).length;
  const result = await runPair(await claimPair());
  assert.equal(result.outcome, "superseded");
  assert.equal(result.persisted, 0);
  assert.equal((await pairJobs())[0].status, "superseded");
  assert.equal((await evaluations()).length, evaluationsBefore);
});

test("job de paire : demande devenue inéligible → completed sans évaluation (la recherche normale ne la sélectionnerait pas)", async () => {
  for (const mutate of [
    (world: PairWorld) => archiveDemand(world.buyer.id, world.timed[0].id, world.timed[0].contentVersion, pool),
    (world: PairWorld) => satisfyDemand(world.buyer.id, world.timed[0].id, world.timed[0].contentVersion, pool),
    (world: PairWorld) => pool.query("UPDATE users SET status = 'suspended' WHERE id = $1", [world.buyer.id]),
  ]) {
    const world = await pairWorld({ timed: 1 });
    await expireNow([world.timed[0].id]);
    await sweepAndProject();
    await mutate(world);
    const evaluationsBefore = (await evaluations()).length;
    const result = await runPair(await claimPair());
    assert.deepEqual({ outcome: result.outcome, chunks: result.chunks, persisted: result.persisted }, { outcome: "completed", chunks: 1, persisted: 0 });
    assert.equal((await evaluations()).length, evaluationsBefore, "aucune évaluation écrite");
    assert.equal((await latestRows()).filter((row) => row.demand_id === world.timed[0].id).length, 0);
    const job = (await pairJobs())[0];
    assert.equal(job.status, "completed");
    assert.deepEqual(job.chunk_manifest.candidates, []);
  }
});

test("job de paire : offre devenue inéligible ou propriétaire suspendu → superseded", async () => {
  const world = await pairWorld({ timed: 1 });
  await expireNow([world.timed[0].id]);
  await sweepAndProject();
  await pool.query("UPDATE users SET status = 'suspended' WHERE id = $1", [world.seller.id]);
  assert.equal((await runPair(await claimPair())).outcome, "superseded");
});

test("job de paire : crash après persistance (abandon) → la reprise rejoue sans doublon", async () => {
  const world = await pairWorld({ timed: 1 });
  await expireNow([world.timed[0].id]);
  await sweepAndProject();
  const first = await claimPair();
  const crashed = await runPair(first, { afterPersist: () => "abandon" });
  assert.equal(crashed.outcome, "abandoned");
  assert.equal((await latestRows()).filter((row) => row.demand_id === world.timed[0].id && row.stale_reason === null).length, 1, "l'évaluation est déjà écrite");
  const rowsAfterCrash = (await evaluations()).length;

  await expireLease(first.jobId);
  const resumed = await runPair(await claimPair(pool, "pair-b"));
  assert.deepEqual({ outcome: resumed.outcome, persisted: resumed.persisted, replayed: resumed.replayed }, { outcome: "completed", persisted: 0, replayed: 1 });
  assert.equal((await evaluations()).length, rowsAfterCrash, "aucune ligne en plus");
  assert.equal((await latestRows()).filter((row) => row.demand_id === world.timed[0].id).length, 1);
  assert.equal((await pairJobs())[0].status, "completed");
});

test("job de paire : crash après l'ouverture du chunk → la reprise ne relit que la demande ciblée (espion de requêtes)", async () => {
  const world = await pairWorld({ timed: 1, plain: 2 });
  await expireNow([world.timed[0].id]);
  await sweepAndProject();
  const target = world.timed[0].id;

  const candidateQueries: Array<{ text: string; values: unknown[] | undefined }> = [];
  const { spy } = observed((text, values) => {
    if (text.includes("WITH source_info AS") && text.includes("candidates AS")) candidateQueries.push({ text, values });
  });
  const first = await claimPair();
  const crashed = await runMatchingJob({ pool: spy, lease: first, hooks: { afterInitialize: () => "abandon" } });
  assert.equal(crashed.outcome, "abandoned");
  const openQueries = candidateQueries.length;
  assert.ok(openQueries >= 1);
  assert.equal((await latestRows()).filter((row) => row.demand_id === target && row.stale_reason === null).length, 0, "rien n'est écrit avant le crash");

  await expireLease(first.jobId);
  const resumedLease = await claimPair(pool, "pair-b");
  const resumed = await runMatchingJob({ pool: spy, lease: resumedLease });
  assert.deepEqual({ outcome: resumed.outcome, persisted: resumed.persisted }, { outcome: "completed", persisted: 1 });
  assert.ok(candidateQueries.length > openQueries, "la reprise a bien relu le candidat");
  for (const query of candidateQueries) {
    assert.ok(query.text.includes("AND d.id = $4::uuid"), "la restriction à un candidat est dans la requête");
    assert.equal(query.values?.[3], target, "la cible est le seul candidat demandé");
    assert.equal(query.values?.[2], 2, "limit 1 (+1 de détection de page suivante)");
    assert.equal(query.values?.length, 4, "aucun curseur");
  }
});

test("job de paire : deux jobs sur la même offre et deux demandes → les deux sont completed", async () => {
  const world = await pairWorld({ timed: 2 });
  await expireNow(world.timed.map((demand) => demand.id));
  const { swept, projection } = await sweepAndProject();
  assert.deepEqual({ expired: swept.expired, jobs: projection.jobsInserted }, { expired: 2, jobs: 2 });
  const results = [await runPair(await claimPair()), await runPair(await claimPair())];
  assert.deepEqual(results.map((result) => [result.outcome, result.persisted]), [["completed", 1], ["completed", 1]]);
  assert.deepEqual((await pairJobs()).map((job) => job.status), ["completed", "completed"]);
  const latest = await latestRows();
  assert.equal(latest.length, 2);
  assert.deepEqual(new Set(latest.map((row) => row.demand_id)), new Set(world.timed.map((demand) => demand.id)));
  assert.ok(latest.every((row) => row.stale_reason === null && row.expires_at !== null));
});

test("job de paire sans cible : échec missing_target (défensif), aucune lecture de candidats", async () => {
  await resetAll();
  const config = normalizeScoringConfig();
  const eventId = await rawTemporalEvent({ version: 1, target: randomUUID() });
  await pool.query(
    "INSERT INTO matching_jobs(job_identity, job_type, resource_id, resource_version, scoring_config_hash, source_event_id) VALUES ($1,'reevaluate_pair_temporal',$2,1,$3,$4)",
    ["e".repeat(64), randomUUID(), computeScoringConfigHash(config), eventId]);
  const { spy } = observed();
  const lease = await claimPair();
  const result = await runMatchingJob({ pool: spy, lease });
  assert.deepEqual({ outcome: result.outcome, errorCode: result.errorCode }, { outcome: "failed", errorCode: "missing_target" });
  assert.equal((await pairJobs())[0].status, "failed");
  assert.equal((await pairJobs())[0].last_error, "missing_target");
});

// ═════════════ 4 (bout en bout). Vrai délai ═════════════

test("bout en bout avec une vraie échéance (≈ 2 s) : péremption, réévaluation, résultat reflétant l'échéance dépassée", async () => {
  await resetAll();
  const seller = await createUser({}, pool), buyer = await createUser({}, pool);
  const offer = await createOffer(offerInput(seller.id), pool);
  const deadlineAt = new Date(Date.now() + 2_000);
  const demand = await createDemand(demandInput(buyer.id, { deadlineAt }), pool);

  await cycleAll();
  const first = (await latestRows())[0];
  assert.ok(first, "la paire est évaluée avant l'échéance");
  assert.ok(first.expires_at, "expires_at non nul : l'échéance est proche");
  assert.ok(first.evaluated_at.getTime() < deadlineAt.getTime(), "évaluation faite avant l'échéance (sinon le test n'est pas valide)");
  assert.ok(!JSON.stringify(first.evaluation_details).includes("DEMAND_EXPIRED"), "avant l'échéance, la demande n'est pas échue");

  await new Promise((resolve) => setTimeout(resolve, Math.max(0, deadlineAt.getTime() + 50 - Date.now())));
  const results = await cycleAll();
  assert.ok(results[0].temporal.expired >= 1, "le balayeur périme la ligne dès le premier cycle");
  assert.equal(results.at(-1)!.idle, true);

  const rows = (await evaluations()).filter((row) => row.offer_id === offer.id && row.demand_id === demand.id);
  const old = rows.find((row) => row.id === first.id)!;
  assert.equal(old.stale_reason, "temporal_expiry");
  assert.equal(old.is_latest, false);
  const active = rows.filter((row) => row.is_latest);
  assert.equal(active.length, 1, "aucun doublon actif");
  assert.notEqual(active[0].id, first.id);
  assert.equal(active[0].offer_content_version, offer.contentVersion, "content_version inchangée");
  assert.equal(active[0].demand_content_version, demand.contentVersion);
  assert.equal(active[0].compatibility_status, "incompatible", "le résultat reflète l'échéance dépassée");
  assert.ok(JSON.stringify(active[0].evaluation_details).includes("DEMAND_EXPIRED"));
  assert.ok(active[0].evaluated_at.getTime() >= deadlineAt.getTime());
  const expiredActive = (await latestRows()).filter((row) => row.expires_at !== null && row.expires_at.getTime() <= Date.now());
  assert.equal(expiredActive.length, 0, "aucune ligne active n'a expires_at <= now");
  assert.equal((await temporalEvents()).length, 1);
  assert.equal((await pairJobs())[0].status, "completed");
});

// ═════════════ 5 (runner). Étape temporelle du cycle ═════════════

test("runner : étape temporal en échec → les jobs sont exécutés quand même, temporal_error rapportée et journalisée", async () => {
  const world = await pairWorld({ timed: 1 });
  await expireNow([world.timed[0].id]);
  const extra = await createOffer(offerInput(world.seller.id, { rawText: "iPhone 13 supplémentaire" }), pool);
  await withTrigger(
    "CREATE TRIGGER reject_temporal_event BEFORE INSERT ON matching_outbox_events FOR EACH ROW EXECUTE FUNCTION reject_temporal_audit()",
    "reject_temporal_event", "matching_outbox_events", async () => {
      const result = await runMatchingCycle({ pool, workerId: "temporal-a" });
      assert.deepEqual(result.errors, ["temporal_error_p0001"]);
      assert.deepEqual(result.temporal, { expired: 0 });
      assert.ok(result.jobs.length >= 1, "les jobs sont exécutés malgré l'échec de l'étape temporelle");
      assert.ok(result.jobs.every((job) => job.outcome === "completed"));
      assert.equal(result.idle, false);
      assert.equal((await latestRows()).filter((row) => row.demand_id === world.timed[0].id && row.is_stale).length, 0, "la ligne expirée n'est pas périmée (lot annulé)");
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM matching_jobs WHERE resource_id = $1 AND status = 'completed'", [extra.id])).rows[0].n, 1);

      // La boucle journalise le code comme les autres.
      const controller = new AbortController();
      const logs: string[] = [];
      await runMatchingWorkerLoop({
        pool, workerId: "temporal-a", signal: controller.signal, log: (line) => logs.push(line), sleep: async () => {},
        onCycle: () => controller.abort(),
      });
      assert.deepEqual(logs, ["matching_worker temporal_error_p0001"]);
    });
  // L'échec ne bloque rien durablement : le cycle suivant périme la ligne et exécute le job de paire.
  const recovered = await runMatchingCycle({ pool, workerId: "temporal-a" });
  assert.deepEqual(recovered.errors, []);
  assert.equal(recovered.temporal.expired, 1);
  assert.equal(recovered.jobs.filter((job) => job.jobType === "reevaluate_pair_temporal").length, 1);
});

test("runner : idle exige temporal.expired = 0 ; le balayage temporel compte comme progrès même si la projection échoue", async () => {
  const world = await pairWorld({ timed: 1 });
  await expireNow([world.timed[0].id]);
  await withTrigger(
    "CREATE TRIGGER reject_temporal_ack BEFORE UPDATE ON matching_outbox_events FOR EACH ROW EXECUTE FUNCTION reject_temporal_audit()",
    "reject_temporal_ack", "matching_outbox_events", async () => {
      const first = await runMatchingCycle({ pool, workerId: "temporal-a" });
      assert.equal(first.temporal.expired, 1);
      assert.deepEqual(first.errors, ["projection_error_p0001"]);
      assert.equal(first.jobs.length, 0);
      assert.equal(first.idle, false, "une évaluation périmée est un progrès");
      const second = await runMatchingCycle({ pool, workerId: "temporal-a" });
      assert.equal(second.temporal.expired, 0);
      assert.equal(second.idle, true, "plus aucun progrès (la projection échoue encore)");
    });
  const third = await runMatchingCycle({ pool, workerId: "temporal-a" });
  assert.deepEqual(third.errors, []);
  assert.equal(third.jobs.filter((job) => job.jobType === "reevaluate_pair_temporal" && job.outcome === "completed").length, 1);
  assert.equal((await latestRows()).filter((row) => row.demand_id === world.timed[0].id).length, 1);
});

test("runner : temporalLimit et validation avant SQL", async () => {
  const { spy, count } = observed();
  for (const temporalLimit of [0, 501, 1.5, Number.NaN, "5", null]) {
    await assert.rejects(runMatchingCycle({ pool: spy, workerId: "temporal-a", temporalLimit: temporalLimit as never }), MatchingJobValidationError, String(temporalLimit));
  }
  assert.equal(count(), 0);

  const world = await pairWorld({ timed: 3 });
  await expireNow(world.timed.map((demand) => demand.id));
  const limited = await runMatchingCycle({ pool, workerId: "temporal-a", temporalLimit: 2 });
  assert.equal(limited.temporal.expired, 2);
  assert.equal((await runMatchingCycle({ pool, workerId: "temporal-a", temporalLimit: 2 })).temporal.expired, 1);
});
