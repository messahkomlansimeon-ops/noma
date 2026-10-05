import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import type { Pool } from "pg";
import { requestOtp, verifyOtp, type SendOtpInput } from "../../lib/server/auth";
import { createDemand, createOffer, createUser } from "../../lib/server/catalog";
import { CatalogValidationError } from "../../lib/server/catalog/errors";
import type { DemandRecord, OfferRecord } from "../../lib/server/catalog/types";
import { createMatchingHttpHandlers, type MatchingHttpHandlers } from "../../lib/server/matching/http";
import {
  computeAvailabilityIndicator, computeConfidenceIndicator, computePriceIndicator, computeRelevance, type MarketReference,
} from "../../lib/server/matching/indicators";
import { readMarketReferences } from "../../lib/server/matching/market";
import { runMatchingCycle } from "../../lib/server/matching/runner";
import { computeScoringConfigHash, normalizeScoringConfig } from "../../lib/server/matching/persistence";
import { RELEVANCE_CONFIG } from "../../lib/server/matching/relevance-config";
import {
  listStoredDemandMatchesForOffer, listStoredOfferMatchesForDemand, type StoredMatchesPage, type StoredMatchesQueryOptions,
} from "../../lib/server/matching/stored-matches";
import { MATCHING_SCORING_CONTRACT_VERSION } from "../../lib/server/matching/scoring-types";
import { MATCHING_OFFLINE_CONTRACT_VERSION } from "../../lib/server/matching/types";
import { runMigrations } from "../../lib/server/postgres/migrations";
import {
  createTemporarySchemaName, openVerifiedIsolatedPool, openVerifiedTestDatabase, quoteTemporarySchema,
} from "./test-database";

type Direction = "offer" | "demand";
interface Login { userId: string; cookie: string; phone: string }

const ORIGIN = "https://noma.test";
const SECRET = randomBytes(32);
const HASH = computeScoringConfigHash(normalizeScoringConfig());
const HOUR = 3_600_000;
const schema = createTemporarySchemaName();
const quoted = quoteTemporarySchema(schema);
let admin: Pool, pool: Pool;
let handlers: MatchingHttpHandlers;
let buyer: Login, seller: Login, stranger: Login;
const clock = { timestamp: Date.UTC(2032, 0, 1, 10), now() { return new Date(this.timestamp); } };
let phoneSequence = 0;
let verifiedPhoneSequence = 0;

async function login(): Promise<Login> {
  let delivery: SendOtpInput | undefined;
  phoneSequence += 1;
  const phone = `+22505${phoneSequence.toString().padStart(8, "0")}`;
  const requested = await requestOtp(phone, {
    pool, now: () => clock.now(), authSecret: SECRET, requestIp: `198.51.100.${phoneSequence}`,
    sendOtp: async (input) => { delivery = input; },
  });
  assert.ok(delivery);
  const verified = await verifyOtp(requested.challengeId, delivery.code, { pool, now: () => clock.now(), authSecret: SECRET });
  return { userId: verified.userId, cookie: `noma_auth=${verified.sessionToken}`, phone };
}

before(async () => {
  const opened = await openVerifiedTestDatabase(process.env.TEST_DATABASE_URL);
  admin = opened.pool;
  await admin.query(`CREATE SCHEMA ${quoted}`);
  pool = await openVerifiedIsolatedPool(opened.target, schema);
  assert.equal((await runMigrations(pool)).applied.length, 10);
  handlers = createMatchingHttpHandlers({ pool, now: () => clock.now() });
  buyer = await login();
  seller = await login();
  stranger = await login();
});

after(async () => {
  if (pool) await pool.end();
  if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${quoted} CASCADE`); await admin.end(); }
});

// ───────────── fixtures ─────────────

const resetCatalog = () => pool.query(
  "TRUNCATE matching_evaluations, matching_jobs, matching_outbox_events, demands, offers CASCADE");

/** Propriétaire de test : téléphone vérifié (ou non) et ancienneté de compte réglables par SQL de test. */
async function makeOwner(options: { verified?: boolean; ageDays?: number } = {}): Promise<string> {
  const user = await createUser({}, pool);
  if (options.verified) {
    verifiedPhoneSequence += 1;
    await pool.query("INSERT INTO phone_identities (phone_e164, user_id, verified_at) VALUES ($1, $2, clock_timestamp())",
      [`+22507${verifiedPhoneSequence.toString().padStart(8, "0")}`, user.id]);
  }
  if (options.ageDays !== undefined) {
    await pool.query("UPDATE users SET created_at = clock_timestamp() - ($2::int * interval '1 day') WHERE id = $1", [user.id, options.ageDays]);
  }
  return user.id;
}

interface OfferOptions {
  ownerId: string;
  price?: number | null;
  currency?: string;
  confirmedHoursAgo?: number | null;
  availability?: "available" | "reserved" | "unavailable" | null;
  quantity?: number | null;
  status?: "published" | "paused" | "draft";
  condition?: string | null;
  location?: string | null;
  category?: string | null;
  brand?: string | null;
  model?: string | null;
  variant?: string | null;
}

function newOffer(options: OfferOptions): Promise<OfferRecord> {
  const has = <K extends keyof OfferOptions>(key: K) => key in options;
  return createOffer({
    ownerId: options.ownerId,
    rawText: "RAW_SECRET_TEXT offre iPhone 13",
    category: has("category") ? options.category : "smartphones",
    brand: has("brand") ? options.brand : "Apple",
    model: has("model") ? options.model : "iPhone 13",
    variant: options.variant ?? null,
    condition: has("condition") ? options.condition : "good",
    location: has("location") ? options.location : "Cocody",
    quantity: options.quantity ?? null,
    price: options.price === null ? null : { amount: options.price ?? 250_000, currency: options.currency ?? "XOF" },
    status: options.status ?? "published",
    availabilityStatus: options.availability === undefined ? "available" : options.availability,
    availabilityConfirmedAt: options.confirmedHoursAgo === undefined || options.confirmedHoursAgo === null
      ? null : new Date(Date.now() - options.confirmedHoursAgo * HOUR),
  }, pool);
}

function newDemand(ownerId: string, extra: { quantity?: number | null; condition?: string | null; location?: string | null; budget?: null } = {}): Promise<DemandRecord> {
  return createDemand({
    ownerId, rawText: "RAW_SECRET_TEXT demande iPhone 13", category: "smartphones", brand: "Apple", model: "iPhone 13",
    condition: "condition" in extra ? extra.condition : "good", location: "location" in extra ? extra.location : "Cocody",
    quantity: extra.quantity ?? null,
    budget: "budget" in extra ? extra.budget : { amount: 500_000, currency: "XOF" }, status: "active",
  }, pool);
}

interface EvalOptions { score?: string | null; evaluatedAt?: string; compatibility?: "compatible" | "incompatible" | "unknown"; eligibility?: "eligible" | "ineligible"; isStale?: boolean }

async function insertEvaluation(offer: OfferRecord, demand: DemandRecord, options: EvalOptions = {}): Promise<string> {
  const stale = options.isStale === true;
  const result = await pool.query<{ id: string }>(
    `INSERT INTO matching_evaluations (
       idempotency_key, attempt_hash, offer_id, demand_id, offer_owner_id, demand_owner_id,
       offer_content_version, demand_content_version, engine_offline_version, engine_scoring_version,
       scoring_config_hash, scoring_config, evaluated_at, expires_at, eligibility_status, eligibility_reasons,
       compatibility_status, score, coverage, evaluation_summary, scoring_summary, preferences_summary,
       evaluation_details, is_latest, is_stale, stale_reason, staled_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, '{}'::jsonb, $12, NULL, $13, '{}', $14, $15, 80,
       $16::jsonb, $17::jsonb, $18::jsonb, '{"criteria":[]}'::jsonb, TRUE, $19, $20, CASE WHEN $19 THEN clock_timestamp() END)
     RETURNING id`,
    [
      randomUUID(), `ATTEMPT_${randomUUID()}`, offer.id, demand.id, offer.ownerId, demand.ownerId, offer.contentVersion, demand.contentVersion,
      MATCHING_OFFLINE_CONTRACT_VERSION, MATCHING_SCORING_CONTRACT_VERSION, HASH,
      options.evaluatedAt ?? "2026-06-01T10:00:00.000000Z", options.eligibility ?? "eligible", options.compatibility ?? "compatible",
      options.score === undefined ? "90.000000" : options.score,
      JSON.stringify({ eligibilityReasons: [], criteriaSummary: { matchedCount: 2, mismatchedCount: 0, unknownCount: 0, totalExploitableCriteria: 2 } }),
      JSON.stringify({ totalApplicableWeight: 2, matchedWeight: 2, mismatchedWeight: 0, unknownWeight: 0, applicableCriteriaCount: 2, matchedCount: 2, mismatchedCount: 0, unknownCount: 0 }),
      JSON.stringify({ preferenceScore: null, preferenceCoverage: null, totalPreferencesCount: 0, matchedCount: 0, mismatchedCount: 0, unknownCount: 0 }),
      stale, stale ? "engine_superseded" : null,
    ],
  );
  return result.rows[0].id;
}

type AnyPage = StoredMatchesPage<OfferRecord | DemandRecord, OfferRecord | DemandRecord>;
const listStored = (direction: Direction, ownerId: string, sourceId: string, options?: StoredMatchesQueryOptions, db?: Pool): Promise<AnyPage> =>
  (direction === "offer"
    ? listStoredDemandMatchesForOffer(ownerId, sourceId, options, db ?? pool)
    : listStoredOfferMatchesForDemand(ownerId, sourceId, options, db ?? pool)) as Promise<AnyPage>;

const ids = (page: { items: Array<{ candidateId: string }> }) => page.items.map((item) => item.candidateId);

function observed() {
  let queries = 0;
  const spy = Object.create(pool) as Pool;
  spy.query = ((...args: unknown[]) => { queries++; return (pool.query as (...a: unknown[]) => unknown)(...args); }) as never;
  spy.connect = ((...args: unknown[]) => { queries++; return (pool.connect as (...a: unknown[]) => unknown)(...args); }) as never;
  return { spy, count: () => queries };
}

// ───────────── référence JS indépendante du SQL ─────────────

/** percentile_cont(p) : interpolation linéaire sur les valeurs triées. */
function percentileCont(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const position = p * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function referenceMarket(prices: number[]): MarketReference {
  if (prices.length === 0) return { sampleSize: 0, p25: null, median: null, p75: null };
  return { sampleSize: prices.length, p25: percentileCont(prices, 0.25), median: percentileCont(prices, 0.5), p75: percentileCont(prices, 0.75) };
}

const close = (a: number | null, b: number | null) => (a === null || b === null ? a === b : Math.abs(a - b) < 1e-6);

// ═════════════ Étape 3 : marché observé ═════════════

test("marché : sample et percentiles égaux à un calcul JS de référence, clé insensible à la casse et aux espaces, variante ignorée", async () => {
  await resetCatalog();
  const owner = await makeOwner();
  const target = await newOffer({ ownerId: owner, price: 175_000 });
  const prices = [100_000, 120_000, 150_000, 170_000, 200_000, 260_000, 300_000, 90_000];
  const variants = ["128 Go", "256 Go", null, "512 Go", null, "128 Go", "256 Go", null];
  const others: OfferRecord[] = [];
  for (const [index, price] of prices.entries()) others.push(await newOffer({ ownerId: owner, price, variant: variants[index] }));
  // Casse et espaces différents : même clé après lower(btrim()).
  await pool.query("UPDATE offers SET category = '  SMARTPHONES ', brand = 'apple', model = ' IPHONE 13' WHERE id = $1", [others[0].id]);

  const result = await readMarketReferences(pool, [{ offerId: target.id, category: "smartphones", brand: "Apple", model: "iPhone 13", currency: "XOF" }]);
  const expected = referenceMarket(prices);
  const actual = result.get(target.id)!;
  assert.equal(actual.sampleSize, 8, "la variante est ignorée et l'offre évaluée est exclue");
  assert.ok(close(actual.p25, expected.p25) && close(actual.median, expected.median) && close(actual.p75, expected.p75), JSON.stringify({ actual, expected }));
  // Clé fournie avec une casse et des espaces différents : même résultat.
  const spaced = await readMarketReferences(pool, [{ offerId: target.id, category: " SMARTPHONES", brand: "APPLE ", model: "iphone 13", currency: "XOF" }]);
  assert.deepEqual(spaced.get(target.id), actual);
});

test("marché : chaque exclusion (pause, archive, unavailable, propriétaire suspendu ou archivé, autre devise, prix nul, brouillon, l'offre elle-même)", async () => {
  await resetCatalog();
  const owner = await makeOwner();
  const target = await newOffer({ ownerId: owner, price: 300_000 });
  const good = [];
  for (const price of [100_000, 110_000, 120_000, 130_000, 140_000]) good.push(await newOffer({ ownerId: owner, price }));
  const query = (offer: OfferRecord) => ({ offerId: offer.id, category: "smartphones", brand: "Apple", model: "iPhone 13", currency: "XOF" });
  const sample = async (offer: OfferRecord) => (await readMarketReferences(pool, [query(offer)])).get(offer.id)!.sampleSize;
  assert.equal(await sample(target), 5, "l'offre évaluée ne compte pas dans SON marché (5 autres)");
  assert.equal(await sample(good[0]), 5, "pour une autre offre : target + 4 autres");

  const excluded: Array<[string, () => Promise<unknown>]> = [
    ["pause", async () => { const o = await newOffer({ ownerId: owner, price: 105_000 }); await pool.query("UPDATE offers SET status = 'paused' WHERE id = $1", [o.id]); }],
    ["archivée", async () => { const o = await newOffer({ ownerId: owner, price: 105_000 }); await pool.query("UPDATE offers SET status = 'archived', archived_at = clock_timestamp() WHERE id = $1", [o.id]); }],
    ["brouillon", () => newOffer({ ownerId: owner, price: 105_000, status: "draft" })],
    ["unavailable", () => newOffer({ ownerId: owner, price: 105_000, availability: "unavailable" })],
    ["propriétaire suspendu", async () => { const u = await makeOwner(); await newOffer({ ownerId: u, price: 105_000 }); await pool.query("UPDATE users SET status = 'suspended', version = version + 1 WHERE id = $1", [u]); }],
    ["propriétaire archivé", async () => { const u = await makeOwner(); await newOffer({ ownerId: u, price: 105_000 }); await pool.query("UPDATE users SET status = 'archived', archived_at = clock_timestamp(), version = version + 1 WHERE id = $1", [u]); }],
    ["autre devise", () => newOffer({ ownerId: owner, price: 105_000, currency: "EUR" })],
    ["prix nul", () => newOffer({ ownerId: owner, price: null })],
    ["autre modèle", () => newOffer({ ownerId: owner, price: 105_000, model: "iPhone 12" })],
  ];
  for (const [label, make] of excluded) {
    await make();
    assert.equal(await sample(target), 5, `exclusion « ${label} »`);
  }
  // Disponibilité NULL et réservée : acceptées.
  await newOffer({ ownerId: owner, price: 135_000, availability: null });
  await newOffer({ ownerId: owner, price: 136_000, availability: "reserved" });
  assert.equal(await sample(target), 7, "disponibilité NULL ou réservée : comptées");
});

test("marché : échantillon de 4 → insufficient_data ; 5 → position calculée ; clé incomplète → échantillon 0", async () => {
  await resetCatalog();
  const owner = await makeOwner();
  const target = await newOffer({ ownerId: owner, price: 50_000 });
  const query = { offerId: target.id, category: "smartphones", brand: "Apple", model: "iPhone 13", currency: "XOF" };
  for (const price of [100_000, 110_000, 120_000, 130_000]) await newOffer({ ownerId: owner, price });
  const four = (await readMarketReferences(pool, [query])).get(target.id)!;
  assert.equal(four.sampleSize, 4);
  assert.equal(computePriceIndicator({ price: 50_000, market: four }).position, "insufficient_data");
  await newOffer({ ownerId: owner, price: 140_000 });
  const five = (await readMarketReferences(pool, [query])).get(target.id)!;
  assert.equal(five.sampleSize, 5);
  const indicator = computePriceIndicator({ price: 50_000, market: five });
  assert.deepEqual({ position: indicator.position, score: indicator.score, delta: indicator.deltaPercent }, { position: "below_market", score: 100, delta: -58 });
  const incomplete = await readMarketReferences(pool, [
    { ...query, category: null }, { ...query, offerId: randomUUID(), currency: null },
  ]);
  assert.deepEqual([...incomplete.values()].map((entry) => entry.sampleSize), [0, 0]);
  assert.equal((await readMarketReferences(pool, [])).size, 0);
});

// ═════════════ Étape 5.1 : sens demande, pertinence ≠ score ═════════════

/** Marché interne : 6 offres publiées de prix distinctifs (et sans lien avec les candidats). */
const MARKET_PRICES = [100_111, 110_222, 120_333, 130_444, 140_555, 150_666];
async function seedMarket(): Promise<void> {
  const owner = await makeOwner();
  for (const price of MARKET_PRICES) await newOffer({ ownerId: owner, price });
}

test("sens demande : une offre moins compatible mais disponible, bon marché et d'un vendeur vérifié passe devant ; la compatibilité domine les grands écarts", async () => {
  await resetCatalog();
  await seedMarket();
  const demand = await newDemand(buyer.userId);
  // X : très compatible (92) mais non confirmée, chère, vendeur non vérifié et récent.
  const x = await newOffer({ ownerId: await makeOwner({ ageDays: 1 }), price: 400_999, confirmedHoursAgo: null });
  // Y : un peu moins compatible (85), confirmée il y a 1 h, bon marché, vendeur vérifié et ancien, disponibilité déjà confirmée.
  const y = await newOffer({ ownerId: await makeOwner({ verified: true, ageDays: 40 }), price: 90_777, confirmedHoursAgo: 1 });
  // Z : très peu compatible (30) mais parfaite sur tous les indicateurs.
  const z = await newOffer({ ownerId: await makeOwner({ verified: true, ageDays: 40 }), price: 100_001, confirmedHoursAgo: 2 });
  await insertEvaluation(x, demand, { score: "92.000000" });
  await insertEvaluation(y, demand, { score: "85.000000" });
  await insertEvaluation(z, demand, { score: "30.000000" });

  const byScore = await listStoredOfferMatchesForDemand(buyer.userId, demand.id, { sort: "score" }, pool);
  assert.deepEqual(ids(byScore), [x.id, y.id, z.id], "tri par score : X d'abord");
  const byRelevance = await listStoredOfferMatchesForDemand(buyer.userId, demand.id, { sort: "relevance" }, pool);
  assert.deepEqual(ids(byRelevance), [y.id, x.id, z.id], "tri par pertinence : Y passe devant X ; Z (compat 30) reste dernier");
  assert.equal(byRelevance.truncated, false);

  const [yy, xx, zz] = byRelevance.items;
  assert.deepEqual({ level: yy.indicators.availability!.level, score: yy.indicators.availability!.score }, { level: "confirmed_recent", score: 100 });
  assert.deepEqual({ position: yy.indicators.price!.position, sample: yy.indicators.price!.sampleSize }, { position: "below_market", sample: 8 });
  assert.deepEqual({ level: yy.indicators.confidence.level, score: yy.indicators.confidence.score, band: yy.indicators.confidence.accountAgeBand }, { level: "high", score: 100, band: "gte_30d" });
  assert.deepEqual({ level: xx.indicators.availability!.level, position: xx.indicators.price!.position }, { level: "unconfirmed", position: "above_market" });
  assert.deepEqual({ score: xx.indicators.confidence.score, band: xx.indicators.confidence.accountAgeBand }, { score: 30, band: "lt_7d" });
  assert.ok(xx.indicators.confidence.factors.includes("phone_not_verified"));
  // Valeurs calculées à la main : 0,55 × 85 + 0,20 × 100 + 0,15 × 100 + 0,10 × 100 = 91,75 ; X : 50,6 + 8 + 3 + 3 = 64,6 ; Z : 16,5 + 20 + 15 + 10 = 61,5.
  assert.deepEqual([yy.relevance, xx.relevance, zz.relevance], [91.75, 64.6, 61.5]);
  // Les indicateurs sont séparés du score de compatibilité : le score enregistré est inchangé.
  assert.deepEqual([yy.score, xx.score, zz.score], [85, 92, 30]);
});

// ═════════════ Jeu de 25 offres pour la pagination et la référence JS ═════════════

interface Candidate { offer: OfferRecord; ownerId: string; evaluationId: string; score: string | null; evaluatedAt: string }

async function seedTwentyFive(demand: DemandRecord): Promise<Candidate[]> {
  const candidates: Candidate[] = [];
  const confirmations = [1, 71, 72.4, 300, 400, null, 5, 71, 200, null];
  const prices = [95_000, 105_000, 125_000, 135_000, 145_000, 155_000, 210_000, 320_000, 99_500, 135_500];
  for (let index = 0; index < 25; index++) {
    const ownerId = await makeOwner({ verified: index % 2 === 0, ageDays: [1, 10, 40][index % 3] });
    const offer = await newOffer({
      ownerId, price: prices[index % prices.length] + index, confirmedHoursAgo: confirmations[index % confirmations.length],
      availability: index % 11 === 5 ? "reserved" : "available", condition: index % 4 === 0 ? null : "good", location: index % 5 === 0 ? null : "Cocody",
    });
    const score = index % 8 === 7 ? null : (40 + ((index * 17) % 61)).toFixed(6);
    const evaluatedAt = `2026-06-01T10:00:00.00000${index % 2}Z`;
    candidates.push({ offer, ownerId, evaluationId: await insertEvaluation(offer, demand, { score, evaluatedAt }), score, evaluatedAt });
  }
  return candidates;
}

/** Tri de référence : mêmes faits, mêmes fonctions pures, marché recalculé en JS (hors l'offre elle-même). */
async function referenceOrder(demand: DemandRecord, candidates: Candidate[], universe: OfferRecord[], now: Date): Promise<string[]> {
  const scored = [];
  for (const candidate of candidates) {
    const owner = (await pool.query<{ created_at: Date; verified: boolean }>(
      `SELECT created_at, EXISTS (SELECT 1 FROM phone_identities WHERE user_id = users.id AND verified_at IS NOT NULL) AS verified FROM users WHERE id = $1`,
      [candidate.ownerId])).rows[0];
    const offer = (await pool.query<{ availability_status: "available" | "reserved"; availability_confirmed_at: Date | null; quantity: number | null; condition_text: string | null; location_text: string | null }>(
      "SELECT availability_status, availability_confirmed_at, quantity, condition_text, location_text FROM offers WHERE id = $1", [candidate.offer.id])).rows[0];
    const market = referenceMarket(universe.filter((other) => other.id !== candidate.offer.id).map((other) => other.price!.amount));
    const availability = computeAvailabilityIndicator({
      status: offer.availability_status, confirmedAt: offer.availability_confirmed_at, quantity: offer.quantity, requestedQuantity: demand.quantity, now,
    });
    const price = computePriceIndicator({ price: candidate.offer.price!.amount, market });
    const confidence = computeConfidenceIndicator({
      kind: "offer", phoneVerified: owner.verified, accountCreatedAt: owner.created_at, availabilityEverConfirmed: offer.availability_confirmed_at !== null, now,
      fields: { category: "smartphones", brand: "Apple", model: "iPhone 13", condition: offer.condition_text, price: candidate.offer.price!.amount, location: offer.location_text },
    });
    const relevance = computeRelevance({
      confirmed: true, sense: "demand_source", compatibility: candidate.score === null ? null : Number(candidate.score),
      availability: availability.score, price: price.score, confidence: confidence.score,
    })!;
    scored.push({ candidate, relevance });
  }
  scored.sort((a, b) => {
    if (a.relevance !== b.relevance) return b.relevance - a.relevance;
    const sa = a.candidate.score === null ? null : Number(a.candidate.score), sb = b.candidate.score === null ? null : Number(b.candidate.score);
    if ((sa === null) !== (sb === null)) return sa === null ? 1 : -1;
    if (sa !== null && sb !== null && sa !== sb) return sb - sa;
    if (a.candidate.evaluatedAt !== b.candidate.evaluatedAt) return a.candidate.evaluatedAt < b.candidate.evaluatedAt ? 1 : -1;
    return a.candidate.evaluationId < b.candidate.evaluationId ? 1 : -1;
  });
  return scored.map((entry) => entry.candidate.offer.id);
}

async function walkRelevance(demandId: string, limit: number, options: StoredMatchesQueryOptions = {}): Promise<{ ids: string[]; pages: AnyPage[]; cursors: string[] }> {
  const collected: string[] = [];
  const pages: AnyPage[] = [];
  const cursors: string[] = [];
  let cursor: string | undefined;
  for (let guard = 0; guard < 50; guard++) {
    const page = await listStoredOfferMatchesForDemand(buyer.userId, demandId, { ...options, limit, cursor, sort: "relevance" }, pool) as AnyPage;
    pages.push(page);
    assert.ok(page.items.length > 0, "jamais de page vide");
    collected.push(...ids(page));
    if (!page.hasMore) { assert.equal(page.nextCursor, null); return { ids: collected, pages, cursors }; }
    cursors.push(page.nextCursor!);
    cursor = page.nextCursor!;
  }
  assert.fail("pagination sans fin");
}

let sharedWorld: { demand: DemandRecord; candidates: Candidate[]; universe: OfferRecord[] } | null = null;
async function twentyFiveWorld() {
  if (sharedWorld) return sharedWorld;
  await resetCatalog();
  await seedMarket();
  const demand = await newDemand(buyer.userId, { quantity: 1 });
  const candidates = await seedTwentyFive(demand);
  const universeRows = (await pool.query<{ id: string }>("SELECT id FROM offers WHERE status = 'published' AND price_amount IS NOT NULL")).rows;
  const universe: OfferRecord[] = [];
  for (const row of universeRows) {
    const known = candidates.find((candidate) => candidate.offer.id === row.id);
    if (known) universe.push(known.offer);
    else {
      const amount = Number((await pool.query<{ price_amount: string }>("SELECT price_amount::text FROM offers WHERE id = $1", [row.id])).rows[0].price_amount);
      universe.push({ id: row.id, price: { amount, currency: "XOF" } } as OfferRecord);
    }
  }
  sharedWorld = { demand, candidates, universe };
  return sharedWorld;
}

test("pertinence (sens demande) : l'ordre sort=relevance égale le tri de référence JS sur 25 éléments ; le tri par score reste celui d'avant", async () => {
  const { demand, candidates, universe } = await twentyFiveWorld();
  const full = await listStoredOfferMatchesForDemand(buyer.userId, demand.id, { sort: "relevance", limit: 100 }, pool);
  assert.equal(full.items.length, 25);
  const expected = await referenceOrder(demand, candidates, universe, full.readAt);
  assert.deepEqual(ids(full), expected, "ordre de pertinence = référence");
  // Pertinence ≠ score : l'ordre diffère du tri par score sur ce jeu.
  const byScore = await listStoredOfferMatchesForDemand(buyer.userId, demand.id, { limit: 100 }, pool);
  assert.notDeepEqual(ids(full), ids(byScore));
  const relevances = full.items.map((item) => item.relevance);
  assert.deepEqual(relevances, [...relevances].sort((a, b) => b - a), "décroissante");
  for (const item of full.items) {
    assert.ok(item.relevance >= 0 && item.relevance <= 100 && item.indicators.availability && item.indicators.price);
  }
});

test("pagination relevance : 25 éléments, limit 7 → ni doublon ni trou, ordre exact ; at figé et indépendant de l'horloge", async () => {
  const { demand, candidates, universe } = await twentyFiveWorld();
  const walked = await walkRelevance(demand.id, 7);
  assert.deepEqual(walked.pages.map((page) => page.items.length), [7, 7, 7, 4]);
  assert.equal(new Set(walked.ids).size, 25);
  const first = walked.pages[0];
  const at = first.readAt;
  const expected = await referenceOrder(demand, candidates, universe, at);
  assert.deepEqual(walked.ids, expected, "pages concaténées = référence calculée à at");
  const cursor = JSON.parse(Buffer.from(walked.cursors[0], "base64url").toString("utf8"));
  assert.deepEqual(Object.keys(cursor).sort(), ["at", "offset", "sort", "sourceId", "sourceKind", "v"]);
  assert.deepEqual({ v: cursor.v, sort: cursor.sort, kind: cursor.sourceKind, id: cursor.sourceId, offset: cursor.offset }, { v: 1, sort: "relevance", kind: "demand", id: demand.id, offset: 7 });
  assert.equal(cursor.at, at.toISOString().replace(/Z$/, "000Z"), "at = readAt de la première page, 6 décimales");
  for (const raw of walked.cursors) assert.equal(JSON.parse(Buffer.from(raw, "base64url").toString("utf8")).at, cursor.at, "at identique sur toutes les pages");

  // Les pages suivantes recalculent avec now = at (et NON avec l'horloge courante).
  const second = walked.pages[1];
  assert.ok(second.readAt.getTime() > at.getTime(), "readAt de la page 2 est l'horloge courante, postérieure à at");
  const forge = (shiftMs: number) => Buffer.from(JSON.stringify({ ...cursor, at: new Date(at.getTime() + shiftMs).toISOString().replace(/Z$/, "000Z") }), "utf8").toString("base64url");
  // `at` ne peut plus être dans le futur (borne +5 s) : on le recule de 50 min (dans la limite d'une heure), ce qui fait
  // passer sous 72 h les confirmations à 72,4 h.
  const earlier = new Date(at.getTime() - 50 * 60_000);
  const expectedEarlier = await referenceOrder(demand, candidates, universe, earlier);
  assert.notDeepEqual(expectedEarlier, expected, "le jeu est sensible à l'horloge (confirmations à 72,4 h)");
  const pageAtEarlier = await listStoredOfferMatchesForDemand(buyer.userId, demand.id, { sort: "relevance", limit: 7, cursor: forge(-50 * 60_000) }, pool);
  assert.deepEqual(ids(pageAtEarlier), expectedEarlier.slice(7, 14), "at forgé (−50 min) : l'ordre suit at");
  const pageAtOriginal = await listStoredOfferMatchesForDemand(buyer.userId, demand.id, { sort: "relevance", limit: 7, cursor: forge(0) }, pool);
  assert.deepEqual(ids(pageAtOriginal), expected.slice(7, 14), "at d'origine : ordre d'origine");
  assert.notDeepEqual(ids(pageAtEarlier), ids(pageAtOriginal));

  // Une modification de availability_confirmed_at qui ne change pas la tranche (même niveau à at) ne change pas l'ordre.
  const target = candidates.find((candidate) => candidate.offer.id === ids(second)[0])!;
  await pool.query("UPDATE offers SET availability_confirmed_at = availability_confirmed_at - interval '5 minutes' WHERE id = $1 AND availability_confirmed_at IS NOT NULL", [target.offer.id]);
  const again = await listStoredOfferMatchesForDemand(buyer.userId, demand.id, { sort: "relevance", limit: 7, cursor: walked.cursors[0] }, pool);
  assert.deepEqual(ids(again), ids(second), "décalage de 5 minutes dans la même tranche : mêmes éléments, même ordre");
});

test("pagination relevance : curseur altéré ou croisé (score ↔ relevance, autre source, autre sens) → erreur de validation avant tout SQL", async () => {
  const { demand } = await twentyFiveWorld();
  const relevancePage = await listStoredOfferMatchesForDemand(buyer.userId, demand.id, { sort: "relevance", limit: 7 }, pool);
  const relevanceCursor = relevancePage.nextCursor!;
  const scorePage = await listStoredOfferMatchesForDemand(buyer.userId, demand.id, { limit: 7 }, pool);
  const scoreCursor = scorePage.nextCursor!;
  const otherDemand = await newDemand(buyer.userId);
  const offerSource = await newOffer({ ownerId: seller.userId });
  const remake = (mutate: (payload: Record<string, unknown>) => unknown) =>
    Buffer.from(JSON.stringify(mutate(JSON.parse(Buffer.from(relevanceCursor, "base64url").toString("utf8")))), "utf8").toString("base64url");

  const cases: Array<[string, string, StoredMatchesQueryOptions["sort"], string?]> = [
    ["curseur score avec sort=relevance", scoreCursor, "relevance"],
    ["curseur relevance avec sort=score", relevanceCursor, "score"],
    ["curseur relevance sans sort (défaut score)", relevanceCursor, undefined],
    ["autre source", remake((p) => ({ ...p, sourceId: otherDemand.id })), "relevance"],
    ["sens inversé", remake((p) => ({ ...p, sourceKind: "offer" })), "relevance"],
    ["tri altéré", remake((p) => ({ ...p, sort: "score" })), "relevance"],
    ["version", remake((p) => ({ ...p, v: 2 })), "relevance"],
    ["propriété en trop", remake((p) => ({ ...p, extra: 1 })), "relevance"],
    ["propriété manquante", remake((p) => Object.fromEntries(Object.entries(p).filter(([key]) => key !== "at"))), "relevance"],
    ["décalage négatif", remake((p) => ({ ...p, offset: -1 })), "relevance"],
    ["décalage décimal", remake((p) => ({ ...p, offset: 1.5 })), "relevance"],
    ["décalage trop grand", remake((p) => ({ ...p, offset: RELEVANCE_CONFIG.relevance.maxOffset + 1 })), "relevance"],
    ["décalage en texte", remake((p) => ({ ...p, offset: "7" })), "relevance"],
    ["date sans microsecondes", remake((p) => ({ ...p, at: "2026-06-01T10:00:00Z" })), "relevance"],
    ["date non calendaire", remake((p) => ({ ...p, at: "2026-02-30T10:00:00.000000Z" })), "relevance"],
    ["non base64url", "abc$%", "relevance"],
    ["JSON tableau", Buffer.from("[]").toString("base64url"), "relevance"],
    ["trop long", "A".repeat(600), "relevance"],
  ];
  for (const [label, cursor, sort] of cases) {
    const { spy, count } = observed();
    await assert.rejects(listStoredOfferMatchesForDemand(buyer.userId, demand.id, { cursor, sort }, spy), (error: unknown) => error instanceof CatalogValidationError, label);
    assert.equal(count(), 0, `${label} : refusé avant tout SQL`);
  }
  // Le curseur de pertinence d'une demande n'est pas valable sur une offre (autre sens), et inversement.
  await assert.rejects(listStoredDemandMatchesForOffer(seller.userId, offerSource.id, { cursor: relevanceCursor, sort: "relevance" }, pool), (error: unknown) => error instanceof CatalogValidationError);
  await assert.rejects(listStoredDemandMatchesForOffer(seller.userId, offerSource.id, { cursor: relevanceCursor }, pool), (error: unknown) => error instanceof CatalogValidationError);
  // Valeurs de sort et de fenêtre invalides.
  for (const sort of ["", "Relevance", "price", 1, null] as unknown[]) {
    await assert.rejects(listStoredOfferMatchesForDemand(buyer.userId, demand.id, { sort: sort as never }, pool), (error: unknown) => error instanceof CatalogValidationError, String(sort));
  }
  for (const relevanceWindow of [0, -1, 1.5, 1001, "5" as unknown as number]) {
    await assert.rejects(listStoredOfferMatchesForDemand(buyer.userId, demand.id, { sort: "relevance", relevanceWindow }, pool), (error: unknown) => error instanceof CatalogValidationError, String(relevanceWindow));
  }
  // Le curseur légitime fonctionne.
  assert.equal((await listStoredOfferMatchesForDemand(buyer.userId, demand.id, { sort: "relevance", limit: 7, cursor: relevanceCursor }, pool)).items.length, 7);
});

test("truncated : fenêtre de test réduite → seules les meilleures par score sont triées ; par défaut (200) faux", async () => {
  const { demand } = await twentyFiveWorld();
  const small = await walkRelevance(demand.id, 4, { relevanceWindow: 10 });
  assert.equal(small.ids.length, 10);
  assert.ok(small.pages.every((page) => page.truncated === true));
  const byScore = await listStoredOfferMatchesForDemand(buyer.userId, demand.id, { limit: 10 }, pool);
  assert.deepEqual([...small.ids].sort(), [...ids(byScore)].sort(), "la fenêtre = les 10 meilleures correspondances par score");
  const exact = await listStoredOfferMatchesForDemand(buyer.userId, demand.id, { sort: "relevance", limit: 100, relevanceWindow: 25 }, pool);
  assert.equal(exact.truncated, false, "fenêtre = nombre exact de lignes : pas tronqué");
  assert.equal((await listStoredOfferMatchesForDemand(buyer.userId, demand.id, { sort: "relevance", limit: 100 }, pool)).truncated, false);
  assert.equal(byScore.truncated, false, "le tri par score n'est jamais tronqué");
});

test("tri par défaut : identique à celui d'avant le lot (ordre et curseurs), indicateurs en plus", async () => {
  const { demand } = await twentyFiveWorld();
  const walk = async (options: StoredMatchesQueryOptions) => {
    const collected: string[] = [];
    const cursors: string[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 20; guard++) {
      const page = await listStoredOfferMatchesForDemand(buyer.userId, demand.id, { ...options, limit: 7, cursor }, pool);
      collected.push(...ids(page));
      if (!page.hasMore) return { collected, cursors };
      cursors.push(page.nextCursor!);
      cursor = page.nextCursor!;
    }
    return assert.fail("sans fin");
  };
  const implicit = await walk({});
  const explicit = await walk({ sort: "score" });
  assert.deepEqual(implicit, explicit, "sort omis = sort=score (ordre ET curseurs identiques)");
  assert.equal(implicit.collected.length, 25);
  // Ordre historique : score décroissant (NULL en dernier), puis date, puis id.
  const rows = (await pool.query<{ offer_id: string }>(
    "SELECT offer_id FROM matching_evaluations WHERE demand_id = $1 ORDER BY score DESC NULLS LAST, evaluated_at DESC, id DESC", [demand.id])).rows;
  assert.deepEqual(implicit.collected, rows.map((row) => row.offer_id));
  // Curseur historique : six clés, sans `sort`.
  const cursor = JSON.parse(Buffer.from(implicit.cursors[0], "base64url").toString("utf8"));
  assert.deepEqual(Object.keys(cursor).sort(), ["evaluatedAt", "id", "score", "sourceId", "sourceKind", "v"]);
  assert.match(cursor.score, /^[0-9]{1,3}\.[0-9]{6}$/);
});

// ═════════════ Étape 5.2 : sens offre ═════════════

test("sens offre : seules la compatibilité et la confiance de l'acheteur comptent (le prix et la disponibilité de l'offre source n'ont aucun effet)", async () => {
  await resetCatalog();
  const offer = await newOffer({ ownerId: seller.userId, price: 250_000, confirmedHoursAgo: 1 });
  const buyers: Array<[string, { verified: boolean; ageDays: number }, string | null]> = [
    ["A", { verified: false, ageDays: 1 }, "95.000000"],
    ["B", { verified: true, ageDays: 40 }, "70.000000"],
    ["C", { verified: true, ageDays: 10 }, "88.000000"],
    ["D", { verified: false, ageDays: 40 }, null],
    ["E", { verified: true, ageDays: 1 }, "60.000000"],
  ];
  const demands: Record<string, DemandRecord> = {};
  for (const [name, owner, score] of buyers) {
    const demand = await newDemand(await makeOwner(owner));
    demands[name] = demand;
    await insertEvaluation(offer, demand, { score });
  }
  const read = (sort: "score" | "relevance") => listStoredDemandMatchesForOffer(seller.userId, offer.id, { sort, limit: 100 }, pool);
  const baseline = await read("relevance");
  assert.equal(baseline.items.length, 5);
  for (const item of baseline.items) {
    assert.equal(item.indicators.availability, null, "disponibilité de SA propre offre : non applicable");
    assert.equal(item.indicators.price, null, "prix de SA propre offre : non applicable");
    const confidence = item.indicators.confidence;
    const compat = item.score;
    const expected = Math.round(((0.55 * (compat ?? 50) + 0.1 * confidence.score) / 0.65) * 100) / 100; // compatibilité nulle → substitution 50
    assert.ok(Math.abs(item.relevance - expected) <= 0.011, `pertinence = (0,55 × compat + 0,10 × confiance) renormalisée (${item.candidateId}) : ${item.relevance} vs ${expected}`);
  }
  assert.ok(baseline.items.every((item) => item.indicators.confidence.factors.every((factor) => factor !== "availability_confirmed")), "pas de facteur d'offre pour une demande");

  // Faire varier le prix et la disponibilité de l'offre source : ni l'ordre ni les valeurs ne changent.
  const order = ids(baseline);
  const relevances = baseline.items.map((item) => item.relevance);
  for (const patch of [
    "price_amount = 1", "price_amount = 99999999", "availability_status = 'reserved'", "availability_confirmed_at = NULL",
    "availability_confirmed_at = clock_timestamp() - interval '40 days'", "quantity = 1", "price_amount = 250000, availability_status = 'available', availability_confirmed_at = clock_timestamp()",
  ]) {
    await pool.query(`UPDATE offers SET ${patch} WHERE id = $1`, [offer.id]);
    const page = await read("relevance");
    assert.deepEqual(ids(page), order, `ordre inchangé après « ${patch} »`);
    assert.deepEqual(page.items.map((item) => item.relevance), relevances);
  }
  // Le tri par pertinence diffère du tri par score (confiance) sur ce jeu, et seule la confiance explique l'écart.
  assert.notDeepEqual(order, ids(await read("score")));
  assert.equal(order[0], demands.C.id, "88 de compat + acheteur vérifié devant 95 d'un acheteur non vérifié et récent");
});

// ═════════════ Étape 5.3 : §15 ═════════════

for (const direction of ["demand", "offer"] as const) {
  test(`§15 (${direction}) : aucune correspondance incompatible, inéligible ou périmée n'apparaît, dans aucun des deux tris, même avec les meilleurs indicateurs`, async () => {
    await resetCatalog();
    await seedMarket();
    const demandSource = direction === "demand" ? await newDemand(buyer.userId, { quantity: 1 }) : null;
    const offerSource = direction === "offer" ? await newOffer({ ownerId: seller.userId }) : null;
    const best = async () => ({ verified: true, ageDays: 400 });
    const goodIds: string[] = [];
    const badIds: string[] = [];
    const make = async (options: EvalOptions, isGood: boolean): Promise<string> => {
      const owner = await makeOwner(await best());
      let evaluationId: string;
      if (direction === "demand") {
        const offer = await newOffer({ ownerId: owner, price: 100_500, confirmedHoursAgo: 1 });
        evaluationId = await insertEvaluation(offer, demandSource!, options);
        (isGood ? goodIds : badIds).push(offer.id);
      } else {
        const demand = await newDemand(owner);
        evaluationId = await insertEvaluation(offerSource!, demand, options);
        (isGood ? goodIds : badIds).push(demand.id);
      }
      return evaluationId;
    };
    await make({ score: "40.000000" }, true);
    await make({ score: "35.000000" }, true);
    await make({ score: "100.000000", compatibility: "incompatible" }, false);
    await make({ score: "100.000000", compatibility: "unknown" }, false);
    await make({ score: "100.000000", eligibility: "ineligible" }, false);
    await make({ score: "100.000000", isStale: true }, false);
    const expiredEvaluation = await make({ score: "100.000000" }, false);
    await pool.query("UPDATE matching_evaluations SET expires_at = clock_timestamp() - interval '1 second' WHERE id = $1", [expiredEvaluation]);
    for (const sort of ["score", "relevance"] as const) {
      const page = await listStored(direction, direction === "demand" ? buyer.userId : seller.userId, (demandSource ?? offerSource)!.id, { sort, limit: 100 });
      assert.deepEqual([...ids(page)].sort(), [...goodIds].sort(), `tri ${sort}`);
      for (const bad of badIds) assert.ok(!ids(page).includes(bad));
      assert.ok(page.items.every((item) => item.compatibilityStatus === "compatible" && Number.isFinite(item.relevance)));
    }
  });
}

// ═════════════ Étape 5.6 : HTTP ═════════════

const request = (path: string, cookie?: string) => new Request(`${ORIGIN}${path}`, { method: "GET", headers: cookie ? { cookie } : {} });
const storedHandler = (direction: Direction) => (direction === "offer" ? handlers.offers.storedMatches : handlers.demands.storedMatches);
const liveHandler = (direction: Direction) => (direction === "offer" ? handlers.offers.matches : handlers.demands.matches);
const urlOf = (direction: Direction, id: string, suffix: string, query = "") => `/api/${direction === "offer" ? "offers" : "demands"}/${id}/${suffix}${query}`;

test("HTTP : sort=score|relevance accepté ; sort inconnu, vide ou dupliqué → 400 ; routes en direct : sort → 400", async () => {
  await resetCatalog();
  const demand = await newDemand(buyer.userId);
  const offer = await newOffer({ ownerId: seller.userId });
  for (const score of ["80.000000", "70.000000"]) {
    await insertEvaluation(await newOffer({ ownerId: await makeOwner() }), demand, { score });
    await insertEvaluation(offer, await newDemand(await makeOwner()), { score });
  }
  for (const direction of ["demand", "offer"] as const) {
    const cookie = direction === "demand" ? buyer.cookie : seller.cookie;
    const id = direction === "demand" ? demand.id : offer.id;
    const stored = (query: string) => storedHandler(direction)(request(urlOf(direction, id, "stored-matches", query), cookie), id);
    const live = (query: string) => liveHandler(direction)(request(urlOf(direction, id, "matches", query), cookie), id);

    for (const query of ["", "?sort=score", "?sort=relevance", "?limit=1&sort=relevance"]) assert.equal((await stored(query)).status, 200, query);
    for (const query of ["?sort=", "?sort=Relevance", "?sort=price", "?sort=score&sort=relevance", "?sort=score&sort=score", "?sort=relevance&sort=", "?sorting=score"]) {
      const response = await stored(query);
      assert.equal(response.status, 400, query);
      assert.deepEqual(await response.json(), { error: { code: "invalid_request", message: "Requête invalide." } });
    }
    // Routes en direct : `sort` reste un paramètre inconnu.
    for (const query of ["?sort=score", "?sort=relevance", "?limit=5&sort=relevance", "?sort=score&sort=score"]) {
      const response = await live(query);
      assert.equal(response.status, 400, `route en direct ${direction} ${query}`);
      assert.deepEqual(await response.json(), { error: { code: "invalid_request", message: "Requête invalide." } });
    }
    assert.equal((await live("?limit=5")).status, 200, "la route en direct fonctionne toujours sans sort");
    // Curseur croisé en HTTP : 400.
    const relevance = await (await stored("?limit=1&sort=relevance")).json();
    const score = await (await stored("?limit=1")).json();
    assert.ok(relevance.nextCursor && score.nextCursor, "deux éléments, limit 1 : un curseur existe");
    assert.equal((await stored(`?sort=score&cursor=${relevance.nextCursor}`)).status, 400);
    assert.equal((await stored(`?sort=relevance&cursor=${score.nextCursor}`)).status, 400);
    assert.equal((await stored(`?cursor=${relevance.nextCursor}`)).status, 400);
    assert.equal((await stored(`?sort=relevance&cursor=${relevance.nextCursor}`)).status, 200, "le curseur légitime fonctionne");
  }
});

test("HTTP : forme exacte des indicateurs et de la pertinence, et aucune fuite (téléphone, date de création, owner ids, prix des autres offres, texte brut)", async () => {
  await resetCatalog();
  await seedMarket();
  const demand = await newDemand(buyer.userId);
  const owners = [await makeOwner({ verified: true, ageDays: 40 }), await makeOwner({ ageDays: 3 }), await makeOwner({ verified: true, ageDays: 10 })];
  const offers: OfferRecord[] = [];
  for (const [index, owner] of owners.entries()) {
    const offer = await newOffer({ ownerId: owner, price: 410_000 + index * 1_111, confirmedHoursAgo: index === 0 ? 2 : null });
    offers.push(offer);
    await insertEvaluation(offer, demand, { score: `${90 - index * 10}.000000` });
  }
  const call = async (query: string) => storedHandler("demand")(request(urlOf("demand", demand.id, "stored-matches", query), buyer.cookie), demand.id);
  for (const sort of ["score", "relevance"]) {
    const response = await call(`?sort=${sort}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const text = await response.text();
    const body = JSON.parse(text);
    assert.equal(body.contractVersion, "matching-stored-http/v1");
    assert.deepEqual(Object.keys(body).sort(), ["contractVersion", "hasMore", "items", "limit", "nextCursor", "processing", "readAt", "source", "truncated"]);
    assert.equal(body.truncated, false);
    assert.equal(body.items.length, 3);
    for (const item of body.items) {
      assert.deepEqual(Object.keys(item).sort(), ["candidate", "candidateContentVersion", "candidateId", "compatibilityStatus", "coverage", "evaluatedAt", "evaluation", "indicators", "relevance", "score", "scoring"]);
      assert.deepEqual(Object.keys(item.indicators).sort(), ["availability", "confidence", "price"]);
      assert.deepEqual(Object.keys(item.indicators.availability).sort(), ["confirmedAgeHours", "factors", "level", "score"]);
      assert.deepEqual(Object.keys(item.indicators.price).sort(), ["deltaPercent", "factors", "position", "sampleSize", "score"]);
      assert.deepEqual(Object.keys(item.indicators.confidence).sort(), ["accountAgeBand", "factors", "level", "score"]);
      assert.equal(typeof item.relevance, "number");
      assert.ok(["lt_7d", "7d_30d", "gte_30d"].includes(item.indicators.confidence.accountAgeBand));
      assert.ok(item.indicators.confidence.factors.every((factor: string) => /^[a-z0-9_]+$/.test(factor)));
      assert.equal(item.indicators.price.position, "above_market");
      assert.equal(typeof item.indicators.price.deltaPercent, "number");
    }
    if (sort === "relevance") assert.deepEqual(body.items.map((item: { relevance: number }) => item.relevance), [...body.items.map((item: { relevance: number }) => item.relevance)].sort((a: number, b: number) => b - a));

    const createdAts = (await pool.query<{ created_at: Date }>("SELECT created_at FROM users")).rows.flatMap((row) => [row.created_at.toISOString(), row.created_at.toISOString().replace("T", " ")]);
    const forbidden = [
      buyer.phone, seller.phone, stranger.phone, "+22507", "phone_e164", "phone_identities",
      buyer.userId, seller.userId, stranger.userId, ...owners, ...createdAts,
      "createdAt", "created_at", "accountCreatedAt", "RAW_SECRET_TEXT", "rawText", "raw_text", "owner",
      ...MARKET_PRICES.map(String), "median", "p25", "p75",
    ];
    for (const needle of forbidden) assert.ok(!text.includes(needle), `fuite (${sort}) : ${needle}`);
  }
});

// ═════════════ 2H1-bis : information inconnue ou cachée ═════════════

async function cyclesUntilIdle(): Promise<void> {
  for (let i = 0; i < 80; i++) {
    const cycle = await runMatchingCycle({ pool, workerId: "relevance-test" });
    assert.deepEqual(cycle.errors, []);
    if (cycle.idle) return;
  }
  assert.fail("le cycle n'atteint pas l'état idle");
}

test("information cachée (vrai pipeline : catalogue → cycles jusqu'à idle → sort=relevance) : déclarer ne fait plus perdre", async () => {
  await resetCatalog();
  // Demande sans budget : aucune comparaison de prix dans la compatibilité, toutes les offres sont compatibles.
  const demand = await newDemand(buyer.userId, { budget: null });
  const offerOf = async (options: Partial<OfferOptions>) => newOffer({ ownerId: await makeOwner(), price: 100_000, ...options });
  const references: OfferRecord[] = [];
  for (let index = 0; index < 6; index++) references.push(await offerOf({}));
  const a = await offerOf({ availability: null });        // disponibilité NON renseignée
  const b = await offerOf({ availability: "available" }); // « available », non confirmée
  const c = await offerOf({ price: null });               // prix CACHÉ
  const d = await offerOf({ price: 150_000 });            // prix déclaré, au-dessus du marché
  await cyclesUntilIdle();

  const page = await listStoredOfferMatchesForDemand(buyer.userId, demand.id, { sort: "relevance", limit: 100 }, pool);
  assert.equal(page.items.length, 10, "les dix offres sont compatibles et confirmées");
  const byId = new Map(page.items.map((item) => [item.candidateId, item]));
  const order = ids(page);
  const item = (offer: OfferRecord) => byId.get(offer.id)!;

  // Défaut 1 : B (disponibilité déclarée) passe devant A (disponibilité cachée).
  assert.ok(order.indexOf(b.id) < order.indexOf(a.id), "B devant A");
  assert.ok(Math.abs(item(b).relevance - item(a).relevance - 2) < 0.011, `B − A = 0,20 × (40 − 30) : ${item(b).relevance} − ${item(a).relevance}`);
  // D (prix déclaré au-dessus du marché) n'est pas battu par C (prix caché) : devant ou ex æquo.
  assert.ok(item(d).relevance >= item(c).relevance, `D ≥ C : ${item(d).relevance} vs ${item(c).relevance}`);
  assert.ok(order.indexOf(d.id) < order.indexOf(c.id) || item(d).relevance === item(c).relevance);

  // Les indicateurs exposés restent honnêtes : inconnu = null.
  assert.deepEqual({ level: item(a).indicators.availability!.level, score: item(a).indicators.availability!.score }, { level: "unknown", score: null });
  assert.deepEqual({ level: item(b).indicators.availability!.level, score: item(b).indicators.availability!.score }, { level: "unconfirmed", score: 40 });
  assert.deepEqual(
    { position: item(c).indicators.price!.position, score: item(c).indicators.price!.score, delta: item(c).indicators.price!.deltaPercent, factors: item(c).indicators.price!.factors },
    { position: "insufficient_data", score: null, delta: null, factors: ["price_missing"] });
  assert.deepEqual(
    { position: item(d).indicators.price!.position, score: item(d).indicators.price!.score, delta: item(d).indicators.price!.deltaPercent },
    { position: "above_market", score: 20, delta: 50 });

  // Défaut 2 : à prix égal, les offres de référence sont « in_market » (jamais « below_market »), écart nul.
  for (const reference of [...references, a, b]) {
    const price = item(reference).indicators.price!;
    assert.deepEqual({ position: price.position, score: price.score, delta: price.deltaPercent, factors: price.factors, sample: price.sampleSize }, { position: "in_market", score: 60, delta: 0, factors: [], sample: 8 });
  }
});

test("marché dégénéré (p25 = médiane = p75) : le prix égal donne in_market et un écart nul", async () => {
  await resetCatalog();
  const owner = await makeOwner();
  const target = await newOffer({ ownerId: owner, price: 100_000 });
  for (let index = 0; index < 5; index++) await newOffer({ ownerId: owner, price: 100_000 });
  const market = (await readMarketReferences(pool, [{ offerId: target.id, category: "smartphones", brand: "Apple", model: "iPhone 13", currency: "XOF" }])).get(target.id)!;
  assert.deepEqual(market, { sampleSize: 5, p25: 100_000, median: 100_000, p75: 100_000 });
  const equal = computePriceIndicator({ price: 100_000, market });
  assert.deepEqual({ position: equal.position, delta: equal.deltaPercent }, { position: "in_market", delta: 0 });
  assert.equal(computePriceIndicator({ price: 99_999, market }).position, "below_market");
  assert.equal(computePriceIndicator({ price: 100_001, market }).position, "above_market");
  // Bornes strictes sur un marché non dégénéré : p25 = 110 000 exactement, p75 = 140 000 exactement.
  await resetCatalog();
  const probe = await newOffer({ ownerId: owner, price: 1 });
  for (const price of [100_000, 110_000, 120_000, 130_000, 140_000, 150_000, 160_000]) await newOffer({ ownerId: owner, price });
  const spread = (await readMarketReferences(pool, [{ offerId: probe.id, category: "smartphones", brand: "Apple", model: "iPhone 13", currency: "XOF" }])).get(probe.id)!;
  assert.deepEqual({ p25: spread.p25, median: spread.median, p75: spread.p75 }, { p25: 115_000, median: 130_000, p75: 145_000 });
  assert.equal(computePriceIndicator({ price: 115_000, market: spread }).position, "in_market", "prix = p25 : dans le marché");
  assert.equal(computePriceIndicator({ price: 114_999, market: spread }).position, "below_market");
  assert.equal(computePriceIndicator({ price: 145_000, market: spread }).position, "in_market", "prix = p75 : dans le marché");
  assert.equal(computePriceIndicator({ price: 145_001, market: spread }).position, "above_market");
});

test("curseur relevance : at futur (> +5 s) ou expiré (> 1 h) → 400 ; at valide → OK ; an 2999 refusé", async () => {
  await resetCatalog();
  const demand = await newDemand(buyer.userId);
  for (let index = 0; index < 9; index++) {
    await insertEvaluation(await newOffer({ ownerId: await makeOwner(), price: 100_000 + index }), demand, { score: `${90 - index}.000000` });
  }
  const first = await listStoredOfferMatchesForDemand(buyer.userId, demand.id, { sort: "relevance", limit: 7 }, pool);
  assert.ok(first.nextCursor);
  const base = JSON.parse(Buffer.from(first.nextCursor!, "base64url").toString("utf8"));
  const withAt = (at: Date | string) => Buffer.from(JSON.stringify({ ...base, at: typeof at === "string" ? at : at.toISOString().replace(/Z$/, "000Z") }), "utf8").toString("base64url");
  const read = (at: Date | string) => listStoredOfferMatchesForDemand(buyer.userId, demand.id, { sort: "relevance", limit: 7, cursor: withAt(at) }, pool);
  const now = Date.now();

  for (const [label, at] of [
    ["+10 s", new Date(now + 10_000)], ["+1 min", new Date(now + 60_000)], ["+3 h", new Date(now + 3 * HOUR)],
    ["an 2999", "2999-01-01T00:00:00.000000Z"], ["−61 min (expiré)", new Date(now - 61 * 60_000)], ["−2 h", new Date(now - 2 * HOUR)],
    ["an 2000", "2000-01-01T00:00:00.000000Z"],
  ] as Array<[string, Date | string]>) {
    await assert.rejects(read(at), (error: unknown) => error instanceof CatalogValidationError, label);
  }
  for (const [label, at] of [
    ["maintenant", new Date(now)], ["+2 s", new Date(now + 2_000)], ["−59 min", new Date(now - 59 * 60_000)], ["−1 min", new Date(now - 60_000)],
  ] as Array<[string, Date]>) {
    assert.equal((await read(at)).items.length, 2, label); // 9 éléments, offset 7 : la page restante
  }
  assert.equal((await listStoredOfferMatchesForDemand(buyer.userId, demand.id, { sort: "relevance", limit: 7, cursor: first.nextCursor! }, pool)).items.length, 2, "le curseur d'origine est valide");

  // En HTTP : 400 invalid_request.
  const response = await storedHandler("demand")(request(urlOf("demand", demand.id, "stored-matches", `?sort=relevance&cursor=${withAt("2999-01-01T00:00:00.000000Z")}`), buyer.cookie), demand.id);
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: { code: "invalid_request", message: "Requête invalide." } });
  const expired = await storedHandler("demand")(request(urlOf("demand", demand.id, "stored-matches", `?sort=relevance&cursor=${withAt(new Date(now - 2 * HOUR))}`), buyer.cookie), demand.id);
  assert.equal(expired.status, 400);
});
