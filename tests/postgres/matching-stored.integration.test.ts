import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import type { Pool } from "pg";
import { requestOtp, verifyOtp, type SendOtpInput } from "../../lib/server/auth";
import { createDemand, createOffer, createUser, updateOffer } from "../../lib/server/catalog";
import { CatalogValidationError } from "../../lib/server/catalog/errors";
import type { DemandRecord, OfferRecord } from "../../lib/server/catalog/types";
import { createMatchingHttpHandlers, type MatchingHttpHandlers } from "../../lib/server/matching/http";
import { computeScoringConfigHash, normalizeScoringConfig } from "../../lib/server/matching/persistence";
import { projectOutboxBatch } from "../../lib/server/matching/projection";
import { runMatchingCycle } from "../../lib/server/matching/runner";
import { findEvaluatedDemandMatchesForOffer, findEvaluatedOfferMatchesForDemand } from "../../lib/server/matching/service";
import {
  listStoredDemandMatchesForOffer, listStoredOfferMatchesForDemand, type StoredMatchesPage,
} from "../../lib/server/matching/stored-matches";
import { MATCHING_OFFLINE_CONTRACT_VERSION } from "../../lib/server/matching/types";
import { MATCHING_SCORING_CONTRACT_VERSION } from "../../lib/server/matching/scoring-types";
import { GET as demandStoredGet } from "../../app/api/demands/[id]/stored-matches/route";
import { GET as offerStoredGet } from "../../app/api/offers/[id]/stored-matches/route";
import { runMigrations } from "../../lib/server/postgres/migrations";
import {
  createTemporarySchemaName, openVerifiedIsolatedPool, openVerifiedTestDatabase, quoteTemporarySchema,
} from "./test-database";

type Direction = "offer" | "demand";
interface Login { userId: string; cookie: string }

const ORIGIN = "https://noma.test";
const SECRET = randomBytes(32);
const HASH = computeScoringConfigHash(normalizeScoringConfig());
const OTHER_HASH = "a".repeat(64);
const schema = createTemporarySchemaName();
const quoted = quoteTemporarySchema(schema);
let admin: Pool, pool: Pool;
let handlers: MatchingHttpHandlers;
let seller: Login, buyer: Login, stranger: Login;
const clock = { timestamp: Date.UTC(2032, 0, 1, 10), now() { return new Date(this.timestamp); } };
let phoneSequence = 0;

async function login(): Promise<Login> {
  let delivery: SendOtpInput | undefined;
  phoneSequence += 1;
  const requested = await requestOtp(`+22505${phoneSequence.toString().padStart(8, "0")}`, {
    pool, now: () => clock.now(), authSecret: SECRET, requestIp: `198.51.100.${phoneSequence}`,
    sendOtp: async (input) => { delivery = input; },
  });
  assert.ok(delivery);
  const verified = await verifyOtp(requested.challengeId, delivery.code, { pool, now: () => clock.now(), authSecret: SECRET });
  return { userId: verified.userId, cookie: `noma_auth=${verified.sessionToken}` };
}

before(async () => {
  const opened = await openVerifiedTestDatabase(process.env.TEST_DATABASE_URL);
  admin = opened.pool;
  await admin.query(`CREATE SCHEMA ${quoted}`);
  pool = await openVerifiedIsolatedPool(opened.target, schema);
  assert.equal((await runMigrations(pool)).applied.length, 10);
  handlers = createMatchingHttpHandlers({ pool, now: () => clock.now() });
  seller = await login();
  buyer = await login();
  stranger = await login();
});

after(async () => {
  if (pool) await pool.end();
  if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${quoted} CASCADE`); await admin.end(); }
});

// ───────────── fixtures ─────────────

const resetMatching = () => pool.query(
  "TRUNCATE matching_evaluations, matching_jobs, matching_outbox_events, demands, offers CASCADE");

const offerInput = (ownerId: string, extra: Record<string, unknown> = {}) => ({
  ownerId, rawText: "RAW_SECRET_TEXT offre iPhone 13", category: "smartphones", brand: "Apple", model: "iPhone 13",
  attributes: { charger_included: true }, price: { amount: 250_000, currency: "XOF" }, status: "published" as const, ...extra,
});
const demandInput = (ownerId: string, extra: Record<string, unknown> = {}) => ({
  ownerId, rawText: "RAW_SECRET_TEXT demande iPhone 13", category: "smartphones", brand: "Apple", model: "iPhone 13",
  requirements: [{ key: "chargeur", operator: "includes", value: "chargeur" }],
  budget: { amount: 300_000, currency: "XOF" }, status: "active" as const, ...extra,
});
const newOffer = (ownerId: string, extra: Record<string, unknown> = {}) => createOffer(offerInput(ownerId, extra), pool);
const newDemand = (ownerId: string, extra: Record<string, unknown> = {}) => createDemand(demandInput(ownerId, extra), pool);

interface EvalOptions {
  score?: string | null;
  coverage?: string | null;
  evaluatedAt?: string;
  compatibility?: "compatible" | "incompatible" | "unknown";
  eligibility?: "eligible" | "ineligible";
  isLatest?: boolean;
  isStale?: boolean;
  hash?: string;
  offlineVersion?: string;
  scoringVersion?: string;
}

/** Insère directement une évaluation enregistrée (SQL de test) ; les colonnes sensibles portent des marqueurs. */
async function insertEvaluation(offer: OfferRecord, demand: DemandRecord, options: EvalOptions = {}): Promise<string> {
  const stale = options.isStale === true;
  const result = await pool.query<{ id: string }>(
    `INSERT INTO matching_evaluations (
       idempotency_key, attempt_hash, offer_id, demand_id, offer_owner_id, demand_owner_id,
       offer_content_version, demand_content_version, engine_offline_version, engine_scoring_version,
       scoring_config_hash, scoring_config, evaluated_at, expires_at, eligibility_status, eligibility_reasons,
       compatibility_status, score, coverage, evaluation_summary, scoring_summary, preferences_summary,
       evaluation_details, is_latest, is_stale, stale_reason, staled_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13, NULL, $14, '{}', $15, $16, $17,
       $18::jsonb, $19::jsonb, $20::jsonb, $21::jsonb, $22, $23, $24, CASE WHEN $23 THEN clock_timestamp() END)
     RETURNING id`,
    [
      randomUUID(), `ATTEMPT_HASH_MARKER_${randomUUID()}`, offer.id, demand.id, offer.ownerId, demand.ownerId,
      offer.contentVersion, demand.contentVersion,
      options.offlineVersion ?? MATCHING_OFFLINE_CONTRACT_VERSION, options.scoringVersion ?? MATCHING_SCORING_CONTRACT_VERSION,
      options.hash ?? HASH, JSON.stringify({ marker: "CONFIG_LEAK_MARKER" }),
      options.evaluatedAt ?? "2026-06-01T10:00:00.000000Z",
      options.eligibility ?? "eligible", options.compatibility ?? "compatible",
      options.score === undefined ? "0.870000" : options.score, options.coverage === undefined ? "0.750000" : options.coverage,
      JSON.stringify({ eligibilityReasons: [], criteriaSummary: { matchedCount: 2, mismatchedCount: 0, unknownCount: 1, totalExploitableCriteria: 3 } }),
      JSON.stringify({
        totalApplicableWeight: 3, matchedWeight: 2, mismatchedWeight: 0, unknownWeight: 1, applicableCriteriaCount: 3,
        matchedCount: 2, mismatchedCount: 0, unknownCount: 1, notApplicableCount: 0, duplicateCount: 0,
      }),
      JSON.stringify({
        preferenceScore: null, preferenceCoverage: 0.5, totalPreferencesCount: 2, matchedCount: 1, mismatchedCount: 0,
        unknownCount: 1, contributions: [{ marker: "PREFERENCE_CONTRIB_MARKER" }],
      }),
      JSON.stringify({ criteria: [{ marker: "DETAIL_LEAK_MARKER" }] }),
      options.isLatest ?? true, stale, stale ? "engine_superseded" : null,
    ],
  );
  return result.rows[0].id;
}

const pairOf = (direction: Direction, source: OfferRecord | DemandRecord, candidate: OfferRecord | DemandRecord) =>
  (direction === "offer" ? [source, candidate] : [candidate, source]) as [OfferRecord, DemandRecord];

const makeSource = (direction: Direction) => direction === "offer" ? newOffer(seller.userId) : newDemand(buyer.userId);
const makeCandidate = (direction: Direction, ownerId?: string, extra: Record<string, unknown> = {}) =>
  direction === "offer" ? newDemand(ownerId ?? buyer.userId, extra) : newOffer(ownerId ?? seller.userId, extra);
const sourceOwner = (direction: Direction) => direction === "offer" ? seller.userId : buyer.userId;

type AnyPage = StoredMatchesPage<OfferRecord | DemandRecord, OfferRecord | DemandRecord>;
const listStored = (direction: Direction, ownerId: string, sourceId: string, options?: { limit?: number; cursor?: string }, db?: Pool): Promise<AnyPage> =>
  (direction === "offer"
    ? listStoredDemandMatchesForOffer(ownerId, sourceId, options, db ?? pool)
    : listStoredOfferMatchesForDemand(ownerId, sourceId, options, db ?? pool)) as Promise<AnyPage>;

const candidateIds = (page: { items: Array<{ candidateId: string }> }) => page.items.map((item) => item.candidateId);
const sorted = (values: string[]) => [...values].sort();

function observed() {
  let queries = 0;
  const spy = Object.create(pool) as Pool;
  spy.query = ((...args: unknown[]) => { queries++; return (pool.query as (...a: unknown[]) => unknown)(...args); }) as never;
  spy.connect = ((...args: unknown[]) => { queries++; return (pool.connect as (...a: unknown[]) => unknown)(...args); }) as never;
  return { spy, count: () => queries };
}

function request(path: string, cookie?: string): Request {
  return new Request(`${ORIGIN}${path}`, { method: "GET", headers: cookie ? { cookie } : {} });
}
const storedHandler = (direction: Direction) => (direction === "offer" ? handlers.offers.storedMatches : handlers.demands.storedMatches);
const liveHandler = (direction: Direction) => (direction === "offer" ? handlers.offers.matches : handlers.demands.matches);
const urlOf = (direction: Direction, id: string, suffix: string, query = "") =>
  `/api/${direction === "offer" ? "offers" : "demands"}/${id}/${suffix}${query}`;

async function cyclesUntilIdle(workerId = "stored-test"): Promise<void> {
  for (let i = 0; i < 80; i++) {
    const cycle = await runMatchingCycle({ pool, workerId });
    assert.deepEqual(cycle.errors, []);
    if (cycle.idle) return;
  }
  assert.fail("le cycle n'atteint pas l'état idle");
}

const DIRECTIONS: Direction[] = ["offer", "demand"];

// ═════════════ 1. Exclusions ═════════════

for (const direction of DIRECTIONS) {
  test(`exclusions (${direction === "offer" ? "offre → demandes" : "demande → offres"}) : seules les correspondances confirmées et fraîches apparaissent`, async () => {
    await resetMatching();
    const source = await makeSource(direction);
    const good: string[] = [];
    const excluded: string[] = [];
    const evaluate = async (candidate: OfferRecord | DemandRecord, options?: EvalOptions): Promise<string> => {
      const [offer, demand] = pairOf(direction, source, candidate);
      return insertEvaluation(offer, demand, options);
    };
    const bad = async (extra: Record<string, unknown> = {}, owner?: string, options?: EvalOptions) => {
      const candidate = await makeCandidate(direction, owner, extra);
      const evaluationId = await evaluate(candidate, options);
      excluded.push(candidate.id);
      return { candidate, evaluationId };
    };
    const table = direction === "offer" ? "demands" : "offers";

    for (const score of ["0.900000", "0.400000"]) {
      const candidate = await makeCandidate(direction);
      await evaluate(candidate, { score });
      good.push(candidate.id);
    }

    await bad({}, undefined, { isStale: true });
    await bad({}, undefined, { isLatest: false });
    const expired = await bad();
    await pool.query("UPDATE matching_evaluations SET expires_at = clock_timestamp() - interval '1 second' WHERE id = $1", [expired.evaluationId]);
    const bumped = await bad();
    await pool.query(`UPDATE ${table} SET content_version = content_version + 1 WHERE id = $1`, [bumped.candidate.id]);
    const suspendedOwner = await createUser({}, pool);
    await bad({}, suspendedOwner.id);
    await pool.query("UPDATE users SET status = 'suspended', version = version + 1 WHERE id = $1", [suspendedOwner.id]);
    await bad({}, undefined, { hash: OTHER_HASH });
    await bad({}, undefined, { offlineVersion: "matching-offline/v0" });
    await bad({}, undefined, { scoringVersion: "matching-scoring/v0" });
    await bad({}, undefined, { compatibility: "incompatible" });
    await bad({}, undefined, { compatibility: "unknown" });
    await bad({}, undefined, { eligibility: "ineligible" });

    if (direction === "demand") {
      for (const patch of [
        "status = 'paused'",
        "status = 'archived', archived_at = clock_timestamp()",
        "availability_status = 'unavailable'",
        "status = 'draft'",
      ]) {
        const { candidate } = await bad();
        await pool.query(`UPDATE offers SET ${patch} WHERE id = $1`, [candidate.id]);
      }
    } else {
      for (const patch of [
        "status = 'satisfied'",
        "status = 'archived', archived_at = clock_timestamp()",
        "status = 'draft'",
      ]) {
        const { candidate } = await bad();
        await pool.query(`UPDATE demands SET ${patch} WHERE id = $1`, [candidate.id]);
      }
    }

    const page = await listStored(direction, sourceOwner(direction), source.id, { limit: 100 });
    assert.deepEqual(sorted(candidateIds(page)), sorted(good), `exclus attendus : ${excluded.length}`);
    assert.deepEqual(candidateIds(page), [good[0], good[1]], "tri par score décroissant");
    assert.equal(page.hasMore, false);
    assert.equal(page.nextCursor, null);
    assert.ok(excluded.length >= 14);
    for (const item of page.items) assert.equal(item.compatibilityStatus, "compatible");
  });
}

// ═════════════ 2. Tri et pagination ═════════════

interface Seeded { evaluationId: string; candidateId: string; score: string | null; at: string }

async function seedRanking(direction: Direction, count: number, nullCount: number): Promise<{ source: OfferRecord | DemandRecord; rows: Seeded[] }> {
  await resetMatching();
  const source = await makeSource(direction);
  const scores = ["0.900000", "0.900000", "0.900000", "0.800000", "0.800000", "0.750000", "0.750000", "0.750000", "0.750000",
    "0.500000", "0.500000", "0.500000", "0.250000", "0.250000", "0.100000", "0.100000", "0.100000", "0.050000", "0.050000",
    "0.000000", "0.000000", "1.000000", "1.000000", "0.330000"];
  const rows: Seeded[] = [];
  const order = Array.from({ length: count }, (_, index) => index).sort((a, b) => ((a * 7919) % 31) - ((b * 7919) % 31));
  for (const index of order) {
    const score = index < count - nullCount ? scores[index % scores.length] : null;
    // Même seconde, deux microsecondes : de NOMBREUSES égalités (score, date) que seul l'id départage, et un curseur à la microseconde.
    const at = `2026-06-01T10:00:00.00000${index % 2}Z`;
    const candidate = await makeCandidate(direction);
    const [offer, demand] = pairOf(direction, source, candidate);
    const evaluationId = await insertEvaluation(offer, demand, { score, evaluatedAt: at });
    rows.push({ evaluationId, candidateId: candidate.id, score, at });
  }
  return { source, rows };
}

function expectedOrder(rows: Seeded[]): string[] {
  return [...rows].sort((a, b) => {
    if ((a.score === null) !== (b.score === null)) return a.score === null ? 1 : -1;
    if (a.score !== null && b.score !== null && Number(a.score) !== Number(b.score)) return Number(b.score) - Number(a.score);
    if (a.at !== b.at) return a.at < b.at ? 1 : -1;
    return a.evaluationId < b.evaluationId ? 1 : -1;
  }).map((row) => row.candidateId);
}

async function walk(direction: Direction, sourceId: string, limit: number): Promise<{ ids: string[]; pages: number; cursors: string[] }> {
  const ids: string[] = [];
  const cursors: string[] = [];
  let cursor: string | undefined;
  let pages = 0;
  for (;;) {
    const page = await listStored(direction, sourceOwner(direction), sourceId, { limit, cursor });
    pages++;
    assert.ok(page.items.length <= limit);
    assert.equal(page.limit, limit);
    ids.push(...candidateIds(page));
    assert.ok(page.items.length > 0, "jamais de page vide");
    if (!page.hasMore) { assert.equal(page.nextCursor, null); return { ids, pages, cursors }; }
    assert.ok(page.nextCursor);
    cursors.push(page.nextCursor);
    cursor = page.nextCursor;
    assert.ok(pages < 100, "pagination sans fin");
  }
}

for (const direction of DIRECTIONS) {
  test(`tri et pagination (${direction}) : 30 lignes, scores égaux et NULL, ni doublon ni trou, passage NULLS LAST`, async () => {
    const { source, rows } = await seedRanking(direction, 30, 9);
    const expected = expectedOrder(rows);
    assert.equal(rows.filter((row) => row.score === null).length, 9);
    assert.ok(new Set(rows.map((row) => `${row.score}|${row.at}`)).size < 30, "des égalités complètes (score, date) existent");
    for (const limit of [7, 15, 21, 30]) {
      const walked = await walk(direction, source.id, limit);
      assert.equal(new Set(walked.ids).size, 30, `aucun doublon (limit ${limit})`);
      assert.deepEqual(walked.ids, expected, `ordre exact (limit ${limit})`);
      assert.equal(walked.pages, Math.ceil(30 / limit), `nombre de pages exact, jamais de page vide (limit ${limit})`);
    }
    // limit 21 : la 1re page se termine EXACTEMENT sur le dernier score non nul (curseur à score non nul), la 2e est le segment NULL.
    const first = await listStored(direction, sourceOwner(direction), source.id, { limit: 21 });
    assert.equal(first.items.length, 21);
    assert.ok(first.items.every((item) => item.score !== null));
    const second = await listStored(direction, sourceOwner(direction), source.id, { limit: 21, cursor: first.nextCursor! });
    assert.equal(second.items.length, 9);
    assert.ok(second.items.every((item) => item.score === null));
    // limit 7 : la 4e page (indices 21 à 27) est dans le segment NULL ; son curseur porte un score nul.
    const walked7 = await walk(direction, source.id, 7);
    const nullCursor = JSON.parse(Buffer.from(walked7.cursors[3], "base64url").toString("utf8"));
    assert.equal(nullCursor.score, null);
    assert.equal(nullCursor.v, 1);
    const firstPage7 = JSON.parse(Buffer.from(walked7.cursors[0], "base64url").toString("utf8"));
    assert.match(firstPage7.score, /^[0-9]\.[0-9]{6}$/);
    assert.match(firstPage7.evaluatedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
    // Limite par défaut : 20.
    const dflt = await listStored(direction, sourceOwner(direction), source.id);
    assert.equal(dflt.limit, 20);
    assert.equal(dflt.items.length, 20);
    assert.equal(dflt.hasMore, true);
  });
}

test("curseur : altéré, réutilisé sur une autre source ou dans l'autre sens → erreur de validation, aucune requête SQL", async () => {
  const offerSide = await seedRanking("offer", 12, 3);
  const offerPage = await listStored("offer", seller.userId, offerSide.source.id, { limit: 5 });
  const offerCursor = offerPage.nextCursor!;
  assert.ok(offerCursor);
  const otherOffer = await newOffer(seller.userId);
  const demandSource = await newDemand(buyer.userId);
  const demandCursor = (await (async () => {
    const candidate = await newOffer(seller.userId);
    await insertEvaluation(candidate, demandSource, { score: "0.500000" });
    const other = await newOffer(seller.userId);
    await insertEvaluation(other, demandSource, { score: "0.400000" });
    return (await listStored("demand", buyer.userId, demandSource.id, { limit: 1 })).nextCursor!;
  })());
  assert.ok(demandCursor);

  const remake = (mutate: (payload: Record<string, unknown>) => unknown) =>
    Buffer.from(JSON.stringify(mutate(JSON.parse(Buffer.from(offerCursor, "base64url").toString("utf8")))), "utf8").toString("base64url");
  const forged: Array<[string, string]> = [
    ["caractères hors base64url", "abc$%"],
    ["base64url non JSON", Buffer.from("pas du json", "utf8").toString("base64url")],
    ["JSON tableau", Buffer.from("[]", "utf8").toString("base64url")],
    ["JSON null", Buffer.from("null", "utf8").toString("base64url")],
    ["propriété en trop", remake((p) => ({ ...p, extra: 1 }))],
    ["propriété manquante", remake((p) => Object.fromEntries(Object.entries(p).filter(([key]) => key !== "id")))],
    ["version inconnue", remake((p) => ({ ...p, v: 2 }))],
    ["sens inversé (demand)", remake((p) => ({ ...p, sourceKind: "demand" }))],
    ["sens inconnu", remake((p) => ({ ...p, sourceKind: "user" }))],
    ["autre source", remake((p) => ({ ...p, sourceId: otherOffer.id }))],
    ["source non UUID", remake((p) => ({ ...p, sourceId: "x" }))],
    ["score au mauvais format", remake((p) => ({ ...p, score: "0.87" }))],
    ["score numérique", remake((p) => ({ ...p, score: 0.87 }))],
    ["date sans microsecondes", remake((p) => ({ ...p, evaluatedAt: "2026-06-01T10:00:00Z" }))],
    ["date non calendaire", remake((p) => ({ ...p, evaluatedAt: "2026-02-30T10:00:00.000000Z" }))],
    ["identifiant non UUID", remake((p) => ({ ...p, id: "nope" }))],
    ["curseur trop long", "A".repeat(600)],
    ["curseur d'une demande utilisé sur une offre", demandCursor],
    ["curseur au format des routes en direct", Buffer.from(JSON.stringify({ createdAtIso: "2026-06-01T10:00:00.000000Z", id: randomUUID() }), "utf8").toString("base64url")],
  ];
  for (const [label, cursor] of forged) {
    const { spy, count } = observed();
    await assert.rejects(listStoredDemandMatchesForOffer(seller.userId, offerSide.source.id, { cursor }, spy),
      (error: unknown) => error instanceof CatalogValidationError, label);
    assert.equal(count(), 0, `${label} : refusé avant tout SQL`);
  }
  // Dans l'autre sens : le curseur d'une offre utilisé sur une demande, et le curseur d'une autre demande.
  await assert.rejects(listStoredOfferMatchesForDemand(buyer.userId, demandSource.id, { cursor: offerCursor }, pool),
    (error: unknown) => error instanceof CatalogValidationError);
  const otherDemand = await newDemand(buyer.userId);
  await assert.rejects(listStoredOfferMatchesForDemand(buyer.userId, otherDemand.id, { cursor: demandCursor }, pool),
    (error: unknown) => error instanceof CatalogValidationError);
  // Et dans l'autre direction : un curseur enregistré n'est pas valide sur la route en direct.
  await assert.rejects(findEvaluatedDemandMatchesForOffer(seller.userId, offerSide.source.id, { cursor: offerCursor }, pool),
    (error: unknown) => error instanceof CatalogValidationError);
  // Le curseur légitime fonctionne sur sa source.
  assert.ok((await listStoredDemandMatchesForOffer(seller.userId, offerSide.source.id, { cursor: offerCursor }, pool)).items.length > 0);
});

test("validation avant SQL : identifiants et limite invalides → zéro requête", async () => {
  const source = await newOffer(seller.userId);
  for (const [owner, id, limit] of [["x", source.id, undefined], [seller.userId, "x", undefined], [seller.userId, source.id, 0],
    [seller.userId, source.id, 101], [seller.userId, source.id, 1.5], [seller.userId, source.id, "5" as never]] as const) {
    const { spy, count } = observed();
    await assert.rejects(listStoredDemandMatchesForOffer(owner, id, { limit }, spy), (error: unknown) => error instanceof CatalogValidationError);
    assert.equal(count(), 0);
  }
});

// ═════════════ 3. Équivalence avec l'endpoint en direct ═════════════

const round6 = (value: number | null) => (value === null ? null : Number(value.toFixed(6)));

test("équivalence : pour une paire persistée par le worker, l'item enregistré égale l'item en direct (now = evaluated_at)", async () => {
  await resetMatching();
  const o1 = await newOffer(seller.userId, { rawText: "iPhone 13 n°1" });
  const o2 = await newOffer(seller.userId, { rawText: "iPhone 13 n°2", availabilityStatus: "reserved" });
  const d1 = await newDemand(buyer.userId, { rawText: "Cherche iPhone 13 n°1" });
  const d2 = await newDemand(buyer.userId, {
    rawText: "Cherche iPhone 13 n°2", budget: { amount: 100_000, currency: "XOF" },
    preferences: [{ key: "couleur", value: "noir" }],
  });
  const d3 = await newDemand(buyer.userId, { rawText: "Cherche iPhone 13 n°3" });
  await cyclesUntilIdle();
  let compared = 0;
  const sources: Array<[Direction, string, string]> = [
    ["offer", seller.userId, o1.id], ["offer", seller.userId, o2.id],
    ["demand", buyer.userId, d1.id], ["demand", buyer.userId, d2.id], ["demand", buyer.userId, d3.id],
  ];
  for (const [direction, owner, sourceId] of sources) {
    const stored = await listStored(direction, owner, sourceId, { limit: 100 });
    for (const item of stored.items) {
      const live = direction === "offer"
        ? await findEvaluatedDemandMatchesForOffer(owner, sourceId, { limit: 100, now: item.evaluatedAt }, pool)
        : await findEvaluatedOfferMatchesForDemand(owner, sourceId, { limit: 100, now: item.evaluatedAt }, pool);
      const match = live.items.find((candidate) => candidate.candidateId === item.candidateId);
      assert.ok(match, "le candidat est aussi dans la liste en direct");
      assert.equal(item.candidateContentVersion, match.candidateContentVersion);
      assert.deepEqual(item.candidate, match.candidate);
      assert.equal(item.compatibilityStatus, match.compatibilityStatus);
      assert.equal(item.score, round6(match.scoring.score));
      assert.equal(item.coverage, round6(match.scoring.coverage));
      assert.deepEqual(item.evaluationSummary, match.evaluation.compatibility.summary);
      const without = (value: object, ...omitted: string[]) =>
        Object.fromEntries(Object.entries(value).filter(([key]) => !omitted.includes(key)));
      assert.deepEqual(item.scoringSummary, without(match.scoring.summary, "notApplicableCount", "duplicateCount"));
      assert.deepEqual(item.preferencesSummary, without(match.scoring.preferences, "contributions"));
      compared++;
    }
  }
  assert.ok(compared >= 3, `au moins 3 paires comparées (${compared})`);
});

// ═════════════ 4. Source : mêmes erreurs que les routes en direct ═════════════

test("source : autre propriétaire, source inéligible ou inexistante → mêmes statuts et mêmes codes que les routes en direct", async () => {
  for (const direction of DIRECTIONS) {
    await resetMatching();
    const owner = direction === "offer" ? seller : buyer;
    const make = (extra: Record<string, unknown> = {}) => direction === "offer" ? newOffer(owner.userId, extra) : newDemand(owner.userId, extra);
    const ok = await make();
    const table = direction === "offer" ? "offers" : "demands";
    const ineligible: Array<[string, string]> = direction === "offer"
      ? [["status = 'paused'", "offre en pause"], ["status = 'draft'", "offre brouillon"], ["availability_status = 'unavailable'", "offre indisponible"],
        ["status = 'archived', archived_at = clock_timestamp()", "offre archivée"]]
      : [["status = 'draft'", "demande brouillon"], ["status = 'satisfied'", "demande satisfaite"],
        ["status = 'archived', archived_at = clock_timestamp()", "demande archivée"]];
    const scenarios: Array<{ label: string; id: string; cookie: string; owner: string }> = [
      { label: "autre propriétaire", id: ok.id, cookie: stranger.cookie, owner: stranger.userId },
      { label: "source inexistante", id: randomUUID(), cookie: owner.cookie, owner: owner.userId },
      { label: "id invalide", id: "pas-un-uuid", cookie: owner.cookie, owner: owner.userId },
      { label: "sans session", id: ok.id, cookie: "", owner: owner.userId },
    ];
    for (const [patch, label] of ineligible) {
      const resource = await make();
      await pool.query(`UPDATE ${table} SET ${patch} WHERE id = $1`, [resource.id]);
      scenarios.push({ label, id: resource.id, cookie: owner.cookie, owner: owner.userId });
    }
    for (const scenario of scenarios) {
      const path = (suffix: string) => urlOf(direction, scenario.id, suffix);
      const live = await liveHandler(direction)(request(path("matches"), scenario.cookie || undefined), scenario.id);
      const stored = await storedHandler(direction)(request(path("stored-matches"), scenario.cookie || undefined), scenario.id);
      assert.notEqual(live.status, 200, `${direction} / ${scenario.label} : la route en direct refuse`);
      assert.equal(stored.status, live.status, `${direction} / ${scenario.label}`);
      assert.deepEqual(await stored.json(), await live.json(), `${direction} / ${scenario.label}`);
      assert.equal(stored.headers.get("cache-control"), "no-store");
      if (scenario.label !== "id invalide" && scenario.label !== "sans session") {
        const liveError = await (direction === "offer"
          ? findEvaluatedDemandMatchesForOffer(scenario.owner, scenario.id, undefined, pool)
          : findEvaluatedOfferMatchesForDemand(scenario.owner, scenario.id, undefined, pool)).then(() => null, (error: unknown) => error as Error);
        const storedError = await listStored(direction, scenario.owner, scenario.id).then(() => null, (error: unknown) => error as Error);
        assert.ok(liveError && storedError);
        assert.equal(storedError.constructor, liveError.constructor, scenario.label);
        assert.equal(storedError.message, liveError.message, scenario.label);
      }
    }
    // Propriétaire de la source suspendu : mêmes erreurs de service.
    const suspended = await createUser({}, pool);
    const suspendedSource = direction === "offer" ? await newOffer(suspended.id) : await newDemand(suspended.id);
    await pool.query("UPDATE users SET status = 'suspended', version = version + 1 WHERE id = $1", [suspended.id]);
    const liveError = await (direction === "offer" ? findEvaluatedDemandMatchesForOffer(suspended.id, suspendedSource.id, undefined, pool) : findEvaluatedOfferMatchesForDemand(suspended.id, suspendedSource.id, undefined, pool)).then(() => null, (error: unknown) => error as Error);
    const storedError = await listStored(direction, suspended.id, suspendedSource.id).then(() => null, (error: unknown) => error as Error);
    assert.ok(liveError instanceof CatalogValidationError);
    assert.equal(storedError?.constructor, liveError.constructor);
    assert.equal(storedError?.message, liveError.message);
  }
});

// ═════════════ 5. processing ═════════════

let jobSequence = 0;
async function insertJobAt(type: string, resourceId: string, version: number, status: string): Promise<void> {
  jobSequence++;
  await pool.query(
    `INSERT INTO matching_jobs (job_identity, job_type, resource_id, resource_version, status, locked_by, locked_at, lock_expires_at, claim_token, completed_at)
     VALUES ($1, $2, $3::uuid, $4::int, $5::text,
       CASE WHEN $5::text = 'running' THEN 'stored-test' END,
       CASE WHEN $5::text = 'running' THEN clock_timestamp() END,
       CASE WHEN $5::text = 'running' THEN clock_timestamp() + interval '1 hour' END,
       CASE WHEN $5::text = 'running' THEN $6::uuid END,
       CASE WHEN $5::text IN ('completed','superseded','dead_letter') THEN clock_timestamp() END)`,
    [`${jobSequence}`.padStart(64, "0"), type, resourceId, version, status, randomUUID()],
  );
}

for (const direction of DIRECTIONS) {
  test(`processing (${direction}) : événement pending, job pending/running/failed à la version courante ; faux une fois terminé ; version ancienne ignorée`, async () => {
    await resetMatching();
    const source = await makeSource(direction);
    const owner = sourceOwner(direction);
    const jobType = direction === "offer" ? "evaluate_offer_candidates" : "evaluate_demand_candidates";
    const otherType = direction === "offer" ? "evaluate_demand_candidates" : "evaluate_offer_candidates";
    const processing = async () => (await listStored(direction, owner, source.id)).processing;

    assert.equal(await processing(), true, "événement outbox pending de la version courante");
    await projectOutboxBatch({ pool, limit: 50 });
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM matching_outbox_events WHERE dispatch_status = 'pending'")).rows[0].n, 0);
    assert.equal(await processing(), true, "job pending issu de la projection");
    await cyclesUntilIdle();
    assert.equal(await processing(), false, "job terminé : plus de traitement en cours");

    // La source change de version SANS événement ni job : plus rien n'est en cours pour la version courante.
    const table = direction === "offer" ? "offers" : "demands";
    await pool.query(`UPDATE ${table} SET content_version = content_version + 1 WHERE id = $1`, [source.id]);
    const version = source.contentVersion + 1;
    assert.equal(await processing(), false);
    await insertJobAt(jobType, source.id, version - 1, "pending");
    assert.equal(await processing(), false, "un job d'une version ANCIENNE est ignoré");
    await insertJobAt(otherType, source.id, version, "pending");
    assert.equal(await processing(), false, "un job d'un autre type est ignoré");
    for (const status of ["completed", "superseded", "dead_letter"]) {
      await pool.query("DELETE FROM matching_jobs WHERE job_type = $1 AND resource_id = $2 AND resource_version = $3", [jobType, source.id, version]);
      await insertJobAt(jobType, source.id, version, status);
      assert.equal(await processing(), false, `statut ${status} : pas de traitement en cours`);
    }
    for (const status of ["pending", "running", "failed"]) {
      await pool.query("DELETE FROM matching_jobs WHERE job_type = $1 AND resource_id = $2 AND resource_version = $3", [jobType, source.id, version]);
      await insertJobAt(jobType, source.id, version, status);
      assert.equal(await processing(), true, `statut ${status} : traitement en cours`);
    }
  });
}

// ═════════════ 6. HTTP ═════════════

const ITEM_KEYS = ["candidate", "candidateContentVersion", "candidateId", "compatibilityStatus", "coverage", "evaluatedAt", "evaluation", "indicators", "relevance", "score", "scoring"];
const TOP_KEYS = ["contractVersion", "hasMore", "items", "limit", "nextCursor", "processing", "readAt", "source", "truncated"];

test("HTTP : 401, 400, 200 avec la forme exacte, no-store et aucune fuite", async () => {
  for (const direction of DIRECTIONS) {
    await resetMatching();
    const owner = direction === "offer" ? seller : buyer;
    const source = await makeSource(direction);
    const candidates: Array<OfferRecord | DemandRecord> = [];
    for (let index = 0; index < 3; index++) {
      const candidate = await makeCandidate(direction);
      candidates.push(candidate);
      const [offer, demand] = pairOf(direction, source, candidate);
      await insertEvaluation(offer, demand, { score: index === 2 ? null : `0.${9 - index}00000` });
    }
    const call = (query = "", cookie: string | null = owner.cookie, id = source.id) =>
      storedHandler(direction)(request(urlOf(direction, id, "stored-matches", query), cookie ?? undefined), id);

    assert.equal((await call("", null)).status, 401);
    assert.equal((await call("", "noma_auth=invalide")).status, 401);
    for (const query of ["?foo=1", "?limit=0", "?limit=101", "?limit=abc", "?limit=1&limit=2", "?cursor=", "?cursor=zzz$", "?cursor=a&cursor=b", "?limit=5&order=score"]) {
      const response = await call(query);
      assert.equal(response.status, 400, query);
      assert.deepEqual(await response.json(), { error: { code: "invalid_request", message: "Requête invalide." } });
    }
    assert.equal((await call("", owner.cookie, "pas-un-uuid")).status, 400);

    const response = await call("?limit=2");
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    const text = await response.text();
    const body = JSON.parse(text);
    assert.deepEqual(Object.keys(body).sort(), TOP_KEYS);
    assert.equal(body.contractVersion, "matching-stored-http/v1");
    assert.equal(body.processing, true, "les événements de création sont encore pending");
    assert.equal(body.limit, 2);
    assert.equal(body.hasMore, true);
    assert.equal(typeof body.nextCursor, "string");
    assert.match(body.readAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(body.items.length, 2);
    for (const item of body.items) {
      assert.deepEqual(Object.keys(item).sort(), ITEM_KEYS);
      assert.deepEqual(Object.keys(item.evaluation).sort(), ["status", "summary"]);
      assert.deepEqual(Object.keys(item.evaluation.summary).sort(), ["matchedCount", "mismatchedCount", "totalExploitableCriteria", "unknownCount"]);
      assert.deepEqual(Object.keys(item.scoring).sort(), ["coverage", "preferences", "score", "summary"]);
      assert.deepEqual(Object.keys(item.scoring.summary).sort(), [
        "applicableCriteriaCount", "matchedCount", "matchedWeight", "mismatchedCount", "mismatchedWeight", "totalApplicableWeight", "unknownCount", "unknownWeight"]);
      assert.deepEqual(Object.keys(item.scoring.preferences).sort(), [
        "matchedCount", "mismatchedCount", "preferenceCoverage", "preferenceScore", "totalPreferencesCount", "unknownCount"]);
      assert.equal(item.evaluatedAt, "2026-06-01T10:00:00.000Z");
      assert.equal(typeof item.score, "number");
      assert.equal(item.coverage, 0.75);
      assert.deepEqual(item.evaluation.summary, { matchedCount: 2, mismatchedCount: 0, unknownCount: 1, totalExploitableCriteria: 3 });
      const commonKeys = ["brand", "category", "condition", "contentVersion", "deadlineAt", "id", "location", "model", "quantity", "unit", "variant"];
      assert.deepEqual(Object.keys(item.candidate).sort(), direction === "offer"
        ? [...commonKeys, "budget"].sort() : [...commonKeys, "availabilityStatus", "price"].sort());
    }
    assert.deepEqual(Object.keys(body.source).sort(), direction === "offer"
      ? ["availabilityStatus", "brand", "category", "condition", "contentVersion", "deadlineAt", "id", "location", "model", "price", "quantity", "unit", "variant"]
      : ["brand", "budget", "category", "condition", "contentVersion", "deadlineAt", "id", "location", "model", "quantity", "unit", "variant"]);
    assert.deepEqual(body.items.map((item: { score: number | null }) => item.score), [0.9, 0.8]);

    // Aucune fuite : propriétaires, texte brut, détails d'évaluation, configuration, clés internes.
    for (const forbidden of [seller.userId, buyer.userId, stranger.userId, "owner", "RAW_SECRET_TEXT", "rawText", "raw_text",
      "evaluation_details", "evaluationDetails", "DETAIL_LEAK_MARKER", "CONFIG_LEAK_MARKER", "PREFERENCE_CONTRIB_MARKER",
      "scoring_config", "scoringConfig", "idempotency", "attempt_hash", "attemptHash", "ATTEMPT_HASH_MARKER", "extraction"]) {
      assert.ok(!text.includes(forbidden), `fuite : ${forbidden}`);
    }

    // Page suivante par le curseur renvoyé, jusqu'au segment NULL.
    const next = await (await call(`?limit=2&cursor=${body.nextCursor}`)).json();
    assert.equal(next.items.length, 1);
    assert.equal(next.items[0].score, null);
    assert.equal(next.hasMore, false);
    assert.equal(next.nextCursor, null);
  }
});

test("routes : les fichiers app/api/{offers,demands}/[id]/stored-matches/route.ts exportent GET", () => {
  assert.equal(typeof offerStoredGet, "function");
  assert.equal(typeof demandStoredGet, "function");
});

// ═════════════ 7. Bout en bout ═════════════

test("bout en bout : catalogue créé par les services, cycles jusqu'à idle, ensemble enregistré = items en direct compatibles et éligibles ; mise à jour → processing", async () => {
  await resetMatching();
  const third = await createUser({}, pool);
  const offers = [
    await newOffer(seller.userId, { rawText: "iPhone 13 A" }),
    await newOffer(seller.userId, { rawText: "iPhone 13 B", price: { amount: 450_000, currency: "XOF" } }),
    await newOffer(third.id, { rawText: "iPhone 13 C" }),
  ];
  const demands = [
    await newDemand(buyer.userId, { rawText: "Cherche iPhone 13 A" }),
    await newDemand(buyer.userId, { rawText: "Cherche iPhone 13 B", budget: { amount: 100_000, currency: "XOF" } }),
    await newDemand(third.id, { rawText: "Cherche iPhone 13 C" }),
  ];
  assert.equal((await listStored("offer", seller.userId, offers[0].id)).processing, true);
  await cyclesUntilIdle();

  const confirmedLive = (items: Array<{ candidateId: string; compatibilityStatus: string; evaluation: { eligibility: { status: string } } }>) =>
    items.filter((item) => item.compatibilityStatus === "compatible" && item.evaluation.eligibility.status === "eligible").map((item) => item.candidateId);
  const check = async () => {
    let total = 0;
    for (const offer of offers) {
      const owner = offer.ownerId;
      const stored = await listStoredDemandMatchesForOffer(owner, offer.id, { limit: 100 }, pool);
      const live = await findEvaluatedDemandMatchesForOffer(owner, offer.id, { limit: 100 }, pool);
      assert.deepEqual(sorted(candidateIds(stored)), sorted(confirmedLive(live.items)), `offre ${offer.id}`);
      assert.equal(stored.processing, false);
      total += stored.items.length;
    }
    for (const demand of demands) {
      const owner = demand.ownerId;
      const stored = await listStoredOfferMatchesForDemand(owner, demand.id, { limit: 100 }, pool);
      const live = await findEvaluatedOfferMatchesForDemand(owner, demand.id, { limit: 100 }, pool);
      assert.deepEqual(sorted(candidateIds(stored)), sorted(confirmedLive(live.items)), `demande ${demand.id}`);
      assert.equal(stored.processing, false);
      total += stored.items.length;
    }
    return total;
  };
  const total = await check();
  assert.ok(total > 0, "au moins une correspondance confirmée");

  // Mise à jour de la source : processing = true (et lignes périmées masquées), puis le cycle remet processing à false.
  const target = offers[0];
  const updated = await updateOffer({ id: target.id, ownerId: target.ownerId, expectedContentVersion: target.contentVersion, changes: { rawText: "iPhone 13 A révisé" } }, pool);
  assert.equal(updated.contentVersion, target.contentVersion + 1);
  const during = await listStoredDemandMatchesForOffer(target.ownerId, target.id, { limit: 100 }, pool);
  assert.equal(during.processing, true);
  assert.equal(during.source.contentVersion, updated.contentVersion);
  assert.equal(during.items.length, 0, "les lignes de l'ancienne version sont masquées en attendant la réévaluation");
  await cyclesUntilIdle();
  const after = await listStoredDemandMatchesForOffer(target.ownerId, target.id, { limit: 100 }, pool);
  assert.equal(after.processing, false);
  assert.equal(after.source.contentVersion, updated.contentVersion);
  assert.ok(after.items.length > 0, "les correspondances reviennent avec la nouvelle version");
  await check();
});
