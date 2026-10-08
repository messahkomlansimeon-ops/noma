import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { Pool, type PoolConfig } from "pg";
import { createDemand, createOffer, createUser } from "../../lib/server/catalog";
import { CatalogValidationError } from "../../lib/server/catalog/errors";
import type { DemandRecord, OfferRecord } from "../../lib/server/catalog/types";
import { BoostError, grantOfferBoost, readBoostSlots, type BoostErrorCode } from "../../lib/server/boost/boosts";
import {
  listOfferBoostQuotes, quoteOfferBoost, readBoostPricingSettings, readScopeBoostPriceHistory, type BoostQuote, type BoostQuoteTestHooks,
} from "../../lib/server/boost/quotes";
import { createReachGate } from "../../lib/server/boost/gate";
import { createReuseRecheckGuard, processReuseRecheckGuard } from "../../lib/server/boost/recheck-guard";
import { BOOST_QUOTE_LOCK_NAMESPACE, BOOST_QUOTE_RATE_LIMIT, BOOST_QUOTE_RATE_NAMESPACE, BOOST_SCOPE_LOCK_NAMESPACE } from "../../lib/server/boost/boost-config";
import {
  BOOST_PURCHASE_REACH_BUDGET_MS, BOOST_QUOTE_REACH_BUDGET_MS, BOOST_REACH_COUNT_LIMIT, BOOST_REACH_SEARCH_LIMIT, BOOST_REACH_STATEMENT_TIMEOUT_MS, BOOST_REUSE_REACH_BUDGET_MS, computeBoostReach, isReachUndetermined,
} from "../../lib/server/boost/reach";
import { listStoredOfferMatchesForDemand, readDemandOrganicRanking } from "../../lib/server/matching/stored-matches";
import { computeScoringConfigHash, normalizeScoringConfig } from "../../lib/server/matching/persistence";
import { MATCHING_SCORING_CONTRACT_VERSION } from "../../lib/server/matching/scoring-types";
import { MATCHING_OFFLINE_CONTRACT_VERSION } from "../../lib/server/matching/types";
import { runMigrations } from "../../lib/server/postgres/migrations";
import { EVALUATION_SUMMARY_JSON, PREFERENCES_SUMMARY_JSON, REACHABLE_LIST_SIZE, SCORING_SUMMARY_JSON, slowReachPool } from "./boost-fixtures";
import { runScript } from "./run-script";
import {
  createTemporarySchemaName, openVerifiedIsolatedPool, openVerifiedTestDatabase, ownAdvisoryLocks, quoteTemporarySchema, uniqueApplicationPrefix, type DedicatedTestDatabase,
} from "./test-database";

const HASH = computeScoringConfigHash(normalizeScoringConfig());
const schema = createTemporarySchemaName();
const quoted = quoteTemporarySchema(schema);
/**
 * Chaque pool de ce fichier porte un `application_name` unique à cette exécution : `pg_locks` est global à l'instance PostgreSQL (d'autres exécutions tiennent des
 * verrous consultatifs des MÊMES espaces sur la même base de test), les vérifications de verrous ne regardent donc que NOS sessions (`ownAdvisoryLocks`).
 */
const APPLICATION = uniqueApplicationPrefix("bqu");
const ownSessions = (config: PoolConfig): Pool => new Pool({ ...config, application_name: APPLICATION });
const emptySchema = createTemporarySchemaName();
let admin: Pool, pool: Pool;
let target: DedicatedTestDatabase;
let firstMigration: Awaited<ReturnType<typeof runMigrations>>;
const extraPools: Pool[] = [];

before(async () => {
  const opened = await openVerifiedTestDatabase(process.env.TEST_DATABASE_URL);
  admin = opened.pool;
  target = opened.target;
  await admin.query(`CREATE SCHEMA ${quoted}`);
  await admin.query(`CREATE SCHEMA ${quoteTemporarySchema(emptySchema)}`);
  pool = await openVerifiedIsolatedPool(target, schema, ownSessions);
  firstMigration = await runMigrations(pool);
});

after(async () => {
  for (const extra of extraPools) await extra.end().catch(() => {});
  if (pool) await pool.end();
  if (admin) {
    for (const name of [schema, emptySchema]) await admin.query(`DROP SCHEMA IF EXISTS ${quoteTemporarySchema(name)} CASCADE`);
    await admin.end();
  }
});

// ───────────── fixtures ─────────────

let counter = 0;
interface OfferInput {
  ownerId?: string;
  category?: string | null;
  brand?: string | null;
  model?: string | null;
  status?: "published" | "paused" | "draft";
  availability?: "available" | "reserved" | "unavailable" | null;
}

const makeUser = async (): Promise<string> => (await createUser({}, pool)).id;

async function makeOffer(input: OfferInput = {}): Promise<OfferRecord> {
  counter += 1;
  const has = <K extends keyof OfferInput>(key: K) => key in input;
  return createOffer({
    ownerId: input.ownerId ?? await makeUser(),
    rawText: `RAW_SECRET_TEXT offre ${counter}`,
    category: has("category") ? input.category : "smartphones",
    brand: has("brand") ? input.brand : "Apple",
    model: has("model") ? input.model : "iPhone 13",
    price: { amount: 100_000 + counter, currency: "XOF" },
    status: input.status ?? "published",
    availabilityStatus: input.availability === undefined ? "available" : input.availability,
  }, pool);
}

const makeDemand = (ownerId: string, status: "active" | "satisfied" = "active"): Promise<DemandRecord> => createDemand({
  ownerId, rawText: "RAW_SECRET_TEXT demande", category: "smartphones", brand: "Apple", model: "iPhone 13", status,
}, pool);

interface EvalOptions { compatibility?: "compatible" | "incompatible" | "unknown"; eligibility?: "eligible" | "ineligible"; isStale?: boolean; score?: number }

async function evaluate(offer: OfferRecord, demand: DemandRecord, options: EvalOptions = {}): Promise<string> {
  const stale = options.isStale === true;
  const result = await pool.query<{ id: string }>(
    `INSERT INTO matching_evaluations (
       idempotency_key, attempt_hash, offer_id, demand_id, offer_owner_id, demand_owner_id,
       offer_content_version, demand_content_version, engine_offline_version, engine_scoring_version,
       scoring_config_hash, scoring_config, evaluated_at, expires_at, eligibility_status, eligibility_reasons,
       compatibility_status, score, coverage, evaluation_summary, scoring_summary, preferences_summary,
       evaluation_details, is_latest, is_stale, stale_reason, staled_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, '{}'::jsonb, clock_timestamp(), NULL, $12, '{}', $13, $16::numeric, 80,
       '${EVALUATION_SUMMARY_JSON}'::jsonb, '${SCORING_SUMMARY_JSON}'::jsonb, '${PREFERENCES_SUMMARY_JSON}'::jsonb, '{"criteria":[]}'::jsonb, TRUE, $14, $15, CASE WHEN $14 THEN clock_timestamp() END)
     RETURNING id`,
    [
      randomUUID(), `ATTEMPT_${randomUUID()}`, offer.id, demand.id, offer.ownerId, demand.ownerId, offer.contentVersion, demand.contentVersion,
      MATCHING_OFFLINE_CONTRACT_VERSION, MATCHING_SCORING_CONTRACT_VERSION, HASH,
      options.eligibility ?? "eligible", options.compatibility ?? "compatible", stale, stale ? "engine_superseded" : null, options.score ?? 90,
    ],
  );
  return result.rows[0].id;
}

/**
 * Offres « remplissage » : d'AUTRES offres (autre modèle : hors périmètre du boost, aucun effet sur les places, les vendeurs concurrents ni le
 * prix) qui complètent la liste de résultats d'un acheteur. Sans elles, une liste de moins de 7 offres a un quota de places promues nul
 * (floor(0,15 × N)) et un boost n'y ferait rien monter (lot P2-bis : cotation `no_visible_effect`).
 */
let fillerOffers: OfferRecord[] = [];
async function fillersFor(count: number): Promise<OfferRecord[]> {
  const owner = fillerOffers[0]?.ownerId ?? await makeUser();
  while (fillerOffers.length < count) fillerOffers.push(await makeOffer({ ownerId: owner, model: "FILLER-MODEL" }));
  return fillerOffers.slice(0, count);
}

/**
 * Un acheteur distinct avec une demande active et une évaluation confirmée et fraîche sur l'offre. La liste de l'acheteur compte `listSize`
 * offres (7 par défaut : quota 1, l'offre y est évaluée EN PREMIER donc classée après les remplissages de même pertinence : un boost la ferait
 * monter) ; `listSize: 1` donne une liste où le boost ne ferait rien monter.
 */
async function addBuyer(offer: OfferRecord, options: EvalOptions & { listSize?: number; targetFirst?: boolean } = {}): Promise<{ buyerId: string; demand: DemandRecord; evaluationId: string }> {
  const buyerId = await makeUser();
  return { buyerId, ...(await addDemand(offer, buyerId, options)) };
}

/** Un besoin de plus pour un acheteur existant ; `targetFirst` : l'offre est évaluée EN DERNIER, donc classée première à pertinence égale. */
async function addDemand(offer: OfferRecord, buyerId: string, options: EvalOptions & { listSize?: number; targetFirst?: boolean } = {}): Promise<{ demand: DemandRecord; evaluationId: string }> {
  const demand = await makeDemand(buyerId);
  const others = await fillersFor((options.listSize ?? REACHABLE_LIST_SIZE) - 1);
  // Compatibilité des remplissages : plus haute que celle de l'offre cotée (elle est classée après eux), ou plus basse (`targetFirst` : elle est première).
  const fillerScore = options.targetFirst ? 40 : 100;
  if (options.targetFirst) {
    for (const filler of others) await evaluate(filler, demand, { score: fillerScore });
    return { demand, evaluationId: await evaluate(offer, demand, options) };
  }
  const evaluationId = await evaluate(offer, demand, options);
  for (const filler of others) await evaluate(filler, demand, { score: fillerScore });
  return { demand, evaluationId };
}

const wipe = () => { fillerOffers = []; return wipeTables(); };
const wipeTables = () => pool.query("TRUNCATE boost_quotes, offer_boosts, matching_evaluations, matching_jobs, matching_outbox_events, demands, offers CASCADE");
const sqlRow = async <T extends Record<string, unknown>>(text: string, values: unknown[] = []): Promise<T> => (await pool.query<T>(text, values)).rows[0];
// Lot M1 : la revérification d'un devis réutilisé a une mémoire de 10 s PAR PROCESSUS et une limite par vendeur. Les essais d'avant le lot (qui enchaînent
// des revérifications du MÊME devis en changeant le monde entre deux) reçoivent une garde SANS mémoire à chaque appel ; les essais du lot M1 passent la leur.
const quote = (offer: OfferRecord, durationCode: "24h" | "3d" | "7d" = "24h", db: Pool = pool, hooks?: BoostQuoteTestHooks) =>
  quoteOfferBoost({ pool: db, ownerId: offer.ownerId, offerId: offer.id, durationCode, hooks: { reuseRecheckGuard: createReuseRecheckGuard({ ttlMs: 0 }), ...hooks } });
const grant = (offer: OfferRecord) => grantOfferBoost({ pool, offerId: offer.id, ownerId: offer.ownerId, durationCode: "24h", source: "admin_grant" });

async function code(promise: Promise<unknown>): Promise<BoostErrorCode | "ok" | string> {
  try { await promise; return "ok"; } catch (error) {
    if (error instanceof BoostError) return error.code;
    return `${(error as Error).name}: ${(error as Error).message}`;
  }
}

const setBoostSettings = (key: string, values: Partial<Record<string, number>>) => {
  const merged = { slot_ratio: 0.15, min_slots: 1, max_slots: 50, max_active_per_seller: 2, max_seller_slot_share: 0.34, max_promoted_share: 0.15, min_relevance: 60, ...values };
  return pool.query(
    `INSERT INTO boost_settings (key, slot_ratio, min_slots, max_slots, max_active_per_seller, max_seller_slot_share, max_promoted_share, min_relevance)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (key) DO UPDATE SET slot_ratio = $2, min_slots = $3, max_slots = $4, max_active_per_seller = $5,
       max_seller_slot_share = $6, max_promoted_share = $7, min_relevance = $8`,
    [key, merged.slot_ratio, merged.min_slots, merged.max_slots, merged.max_active_per_seller, merged.max_seller_slot_share, merged.max_promoted_share, merged.min_relevance]);
};
const resetBoostSettings = () => pool.query("DELETE FROM boost_settings WHERE key <> 'default'");

function insertPricing(key: string, version: number, overrides: Record<string, unknown> = {}) {
  const row: Record<string, unknown> = {
    key, version, currency: "XOF", base_amount: 500, grid_amount: 100, min_amount: 500, max_amount: 50_000,
    competition_step_milli: 20, competition_max_milli: 1500, demand_step_milli: 100, demand_max_milli: 3000, scarcity_max_milli: 2000,
    duration_24h_milli: 1000, duration_3d_milli: 2500, duration_7d_milli: 5000, quote_validity_seconds: 900, ...overrides,
  };
  const columns = Object.keys(row);
  return pool.query(`INSERT INTO boost_pricing_settings (${columns.join(", ")}) VALUES (${columns.map((_, index) => `$${index + 1}`).join(", ")})`, columns.map((column) => row[column]));
}

/**
 * Monde de l'exemple de contrôle : 14 offres éligibles du périmètre (11 du vendeur coté, 1 pour chacun de 3 autres vendeurs) →
 * ceil(0,15 × 14) = 3 places ; un boost effectif d'un autre vendeur → 1 place utilisée ; 4 acheteurs compatibles distincts.
 */
async function controlWorld() {
  await wipe();
  const seller = await makeUser();
  const own: OfferRecord[] = [];
  for (let index = 0; index < 11; index++) own.push(await makeOffer({ ownerId: seller }));
  const others: OfferRecord[] = [];
  for (let index = 0; index < 3; index++) others.push(await makeOffer());
  await grant(others[0]);
  const buyers = [];
  for (let index = 0; index < 4; index++) buyers.push(await addBuyer(own[0]));
  return { seller, offer: own[0], own, others, buyers };
}

// ═════════════ 1. Migration 0012 ═════════════

test("migration 0012 : 19 appliquées (dont 0012, 0016 et 0017), la relance n'en applique aucune, ligne default v1 exacte, index présents", async () => {
  assert.equal(firstMigration.applied.length, 26);
  assert.equal(firstMigration.applied.at(-1), "0026_sublymus_payments");
  assert.ok(firstMigration.applied.includes("0012_boost_pricing"));
  const rerun = await runMigrations(pool);
  assert.deepEqual(rerun.applied, []);
  assert.equal(rerun.skipped.length, 26);
  const rows = (await pool.query("SELECT * FROM boost_pricing_settings")).rows;
  assert.equal(rows.length, 1);
  const { created_at: createdAt, ...rest } = rows[0];
  assert.ok(createdAt instanceof Date);
  assert.deepEqual(rest, {
    key: "default", version: 1, currency: "XOF", base_amount: 500, grid_amount: 100, min_amount: 500, max_amount: 50_000,
    competition_step_milli: 20, competition_max_milli: 1500, demand_step_milli: 100, demand_max_milli: 3000, scarcity_max_milli: 2000,
    duration_24h_milli: 1000, duration_3d_milli: 2500, duration_7d_milli: 5000, quote_validity_seconds: 900,
  });
  assert.equal((await sqlRow<{ n: number }>("SELECT count(*)::int AS n FROM boost_quotes")).n, 0);
  const indexes = new Map((await pool.query<{ indexname: string; indexdef: string }>(
    "SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = $1 AND tablename = 'boost_quotes'", [schema])).rows.map((row) => [row.indexname, row.indexdef]));
  assert.match(indexes.get("idx_boost_quotes_offer_duration") ?? "", /\(offer_id, duration_code, expires_at DESC\)/);
  assert.match(indexes.get("idx_boost_quotes_scope_history") ?? "", /\(scope_category, scope_brand, scope_model, computed_at DESC\) WHERE \(status = 'available'::text\)/);
});

test("migration 0012 : boost_pricing_settings, chaque CHECK refuse son cas et accepte sa borne ; clé primaire (key, version)", async () => {
  const cases: Array<[string, Record<string, unknown>, Record<string, unknown> | null]> = [
    ["chk_boost_pricing_settings_key", { key: "Majuscule" }, null], ["chk_boost_pricing_settings_key", { key: "" }, null], ["chk_boost_pricing_settings_key", { key: " espace" }, null],
    ["chk_boost_pricing_settings_version", { version: 0 }, { version: 1 }],
    ["chk_boost_pricing_settings_currency", { currency: "EUR" }, null],
    ["chk_boost_pricing_settings_base", { base_amount: 0 }, { base_amount: 1 }], ["chk_boost_pricing_settings_base", { base_amount: 10_000_001 }, { base_amount: 10_000_000 }],
    ["chk_boost_pricing_settings_grid", { grid_amount: 0 }, { grid_amount: 1, min_amount: 1, max_amount: 1 }],
    ["chk_boost_pricing_settings_min", { min_amount: 0, grid_amount: 1, max_amount: 5 }, { min_amount: 1, grid_amount: 1, max_amount: 5 }],
    ["chk_boost_pricing_settings_max", { min_amount: 600, max_amount: 500 }, { min_amount: 500, max_amount: 500 }],
    ["chk_boost_pricing_settings_grid_multiples", { min_amount: 550 }, null], ["chk_boost_pricing_settings_grid_multiples", { max_amount: 50_050 }, null],
    ["chk_boost_pricing_settings_competition_step", { competition_step_milli: -1 }, { competition_step_milli: 0 }], ["chk_boost_pricing_settings_competition_step", { competition_step_milli: 1001 }, { competition_step_milli: 1000 }],
    ["chk_boost_pricing_settings_competition_max", { competition_max_milli: 999 }, { competition_max_milli: 1000 }], ["chk_boost_pricing_settings_competition_max", { competition_max_milli: 5001 }, { competition_max_milli: 5000 }],
    ["chk_boost_pricing_settings_demand_step", { demand_step_milli: -1 }, { demand_step_milli: 0 }], ["chk_boost_pricing_settings_demand_step", { demand_step_milli: 1001 }, { demand_step_milli: 1000 }],
    ["chk_boost_pricing_settings_demand_max", { demand_max_milli: 999 }, { demand_max_milli: 1000 }], ["chk_boost_pricing_settings_demand_max", { demand_max_milli: 5001 }, { demand_max_milli: 5000 }],
    ["chk_boost_pricing_settings_scarcity_max", { scarcity_max_milli: 999 }, { scarcity_max_milli: 1000 }], ["chk_boost_pricing_settings_scarcity_max", { scarcity_max_milli: 5001 }, { scarcity_max_milli: 5000 }],
    ["chk_boost_pricing_settings_duration_24h", { duration_24h_milli: 999 }, { duration_24h_milli: 1000 }],
    ["chk_boost_pricing_settings_duration_3d", { duration_3d_milli: 999 }, { duration_3d_milli: 2500 }],
    ["chk_boost_pricing_settings_duration_7d", { duration_7d_milli: 20_001 }, { duration_7d_milli: 20_000 }],
    ["chk_boost_pricing_settings_duration_order", { duration_24h_milli: 3000, duration_3d_milli: 2500 }, { duration_24h_milli: 2500, duration_3d_milli: 2500 }],
    ["chk_boost_pricing_settings_duration_order", { duration_3d_milli: 6000 }, { duration_3d_milli: 5000 }],
    ["chk_boost_pricing_settings_validity", { quote_validity_seconds: 59 }, { quote_validity_seconds: 60 }], ["chk_boost_pricing_settings_validity", { quote_validity_seconds: 3601 }, { quote_validity_seconds: 3600 }],
  ];
  let sequence = 0;
  for (const [constraint, bad, good] of cases) {
    sequence += 1;
    const { key: badKey, version: badVersion, ...badRest } = bad as { key?: string; version?: number } & Record<string, unknown>;
    await assert.rejects(insertPricing(badKey ?? `k${sequence}`, badVersion ?? 1, badRest), new RegExp(constraint), `${constraint} ${JSON.stringify(bad)}`);
    if (good) {
      const { version: goodVersion, ...goodRest } = good as { version?: number } & Record<string, unknown>;
      await insertPricing(`ok${sequence}`, goodVersion ?? 1, goodRest);
    }
  }
  await assert.rejects(insertPricing("default", 1), /boost_pricing_settings_pkey/, "clé primaire (key, version)");
  await insertPricing("default", 2);
  await pool.query("DELETE FROM boost_pricing_settings WHERE key <> 'default' OR version <> 1");
  assert.equal((await sqlRow<{ n: number }>("SELECT count(*)::int AS n FROM boost_pricing_settings")).n, 1);
});

interface QuoteFields {
  offerId: string; sellerId: string; category?: string; brand?: string; model?: string; duration?: string; pricingKey?: string; pricingVersion?: number;
  currency?: string; status?: string; reason?: string | null; amount?: number | null; raw?: string | null;
  competition?: number | null; demand?: number | null; scarcity?: number | null; durationMilli?: number | null;
  sellers?: number; buyers?: number; reachable?: number | null; total?: number; used?: number; computedAt?: string; expiresAt?: string;
}

function insertQuote(fields: QuoteFields) {
  const available = (fields.status ?? "available") === "available";
  const pick = <T,>(value: T | null | undefined, fallback: T | null): T | null => (value === undefined ? fallback : value);
  return pool.query(
    `INSERT INTO boost_quotes (id, offer_id, seller_id, scope_category, scope_brand, scope_model, duration_code, pricing_key, pricing_version, currency,
       status, unavailable_reason, amount, raw_amount, competition_milli, demand_milli, scarcity_milli, duration_milli,
       competing_sellers, compatible_buyers, slots_total, slots_used, computed_at, expires_at, reachable_buyers)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,
       COALESCE($23::timestamptz, clock_timestamp()), COALESCE($24::timestamptz, clock_timestamp() + interval '15 minutes'), $25::int)`,
    [randomUUID(), fields.offerId, fields.sellerId, fields.category ?? "smartphones", fields.brand ?? "apple", fields.model ?? "iphone 13", fields.duration ?? "24h",
      fields.pricingKey ?? "default", fields.pricingVersion ?? 1, fields.currency ?? "XOF", fields.status ?? "available",
      pick(fields.reason, available ? null : "no_slot_available"), pick(fields.amount, available ? 500 : null), pick(fields.raw, available ? "500.000000000000" : null),
      pick(fields.competition, available ? 1000 : null), pick(fields.demand, available ? 1000 : null), pick(fields.scarcity, available ? 1000 : null), pick(fields.durationMilli, available ? 1000 : null),
      fields.sellers ?? 0, fields.buyers ?? 0, fields.total ?? 1, fields.used ?? 0, fields.computedAt ?? null, fields.expiresAt ?? null, fields.reachable ?? null]);
}

test("migration 0012 : boost_quotes, chaque CHECK, clés étrangères (dont la version tarifaire) et CASCADE", async () => {
  await wipe();
  const offer = await makeOffer();
  const base = { offerId: offer.id, sellerId: offer.ownerId };
  const refuse = (constraint: string, fields: Partial<QuoteFields>) =>
    assert.rejects(insertQuote({ ...base, ...fields }), new RegExp(constraint), `${constraint} ${JSON.stringify(fields)}`);

  for (const scope of [{ category: "Smartphones" }, { brand: " apple" }, { model: "IPHONE 13" }, { category: "" }, { brand: "" }, { model: "" }]) await refuse("chk_boost_quotes_scope_normalized", scope);
  await refuse("chk_boost_quotes_duration_code", { duration: "30d" });
  await refuse("chk_boost_quotes_currency", { currency: "EUR" });
  // Un statut inconnu est aussi refusé par la cohérence disponible / indisponible (qui est évaluée avant).
  await refuse("chk_boost_quotes_(status|availability)", { status: "pending" });
  await refuse("chk_boost_quotes_reason", { status: "unavailable", reason: "autre" });
  await refuse("chk_boost_quotes_amount", { amount: 0 });
  await refuse("chk_boost_quotes_amount", { amount: -100 });
  for (const counts of [{ sellers: -1 }, { buyers: -1 }, { total: -1 }, { used: -1 }]) await refuse("chk_boost_quotes_counts", counts);
  // Disponible : tout renseigné et aucun motif.
  await refuse("chk_boost_quotes_availability", { amount: null });
  await refuse("chk_boost_quotes_availability", { raw: null });
  await refuse("chk_boost_quotes_availability", { competition: null });
  await refuse("chk_boost_quotes_availability", { demand: null });
  await refuse("chk_boost_quotes_availability", { scarcity: null });
  await refuse("chk_boost_quotes_availability", { durationMilli: null });
  await refuse("chk_boost_quotes_availability", { reason: "no_slot_available" });
  // Indisponible : aucun prix, aucun facteur, un motif.
  await refuse("chk_boost_quotes_availability", { status: "unavailable", reason: null });
  await refuse("chk_boost_quotes_availability", { status: "unavailable", amount: 500 });
  await refuse("chk_boost_quotes_availability", { status: "unavailable", raw: "500.000000000000" });
  await refuse("chk_boost_quotes_availability", { status: "unavailable", competition: 1000 });
  await refuse("chk_boost_quotes_availability", { status: "unavailable", demand: 1000 });
  await refuse("chk_boost_quotes_availability", { status: "unavailable", scarcity: 1000 });
  await refuse("chk_boost_quotes_availability", { status: "unavailable", durationMilli: 1000 });
  await refuse("chk_boost_quotes_validity", { computedAt: "2032-01-01T00:00:00Z", expiresAt: "2032-01-01T00:00:00Z" });
  await refuse("chk_boost_quotes_validity", { computedAt: "2032-01-02T00:00:00Z", expiresAt: "2032-01-01T00:00:00Z" });
  // Clés étrangères : offre, vendeur, version tarifaire.
  await refuse("boost_quotes_offer_id_fkey", { offerId: randomUUID() });
  await refuse("boost_quotes_seller_id_fkey", { sellerId: randomUUID() });
  await refuse("fk_boost_quotes_pricing", { pricingVersion: 99 });
  await refuse("fk_boost_quotes_pricing", { pricingKey: "inconnue" });
  // Cas acceptés.
  await insertQuote({ ...base });
  for (const reason of ["offer_already_boosted", "no_slot_available", "seller_boost_limit_reached", "no_compatible_buyer"]) await insertQuote({ ...base, status: "unavailable", reason });
  assert.equal((await sqlRow<{ n: number }>("SELECT count(*)::int AS n FROM boost_quotes")).n, 5);
  // Pas d'unicité : plusieurs cotations d'une même offre coexistent (historique).
  await insertQuote({ ...base });
  // ON DELETE CASCADE : supprimer l'offre supprime ses cotations.
  await pool.query("DELETE FROM offers WHERE id = $1", [offer.id]);
  assert.equal((await sqlRow<{ n: number }>("SELECT count(*)::int AS n FROM boost_quotes")).n, 0);
});

// ═════════════ 2. Exemple de contrôle de bout en bout ═════════════

test("exemple de contrôle de bout en bout : S = 3, D = 4 (D' = 5), 1 place utilisée sur 3, durée 3d → 1060 / 1400 / 1333 / 2500, brut 2472,715, 2 500 XOF", async () => {
  const { offer, seller } = await controlWorld();
  assert.deepEqual((await readBoostSlots({ pool, offerId: offer.id })).used, 1);
  const result = await quote(offer, "3d");
  assert.equal(result.status, "available");
  assert.equal(result.reused, false);
  assert.equal(result.amount, 2500);
  assert.equal(result.rawAmount, "2472.715000000000");
  assert.equal(result.currency, "XOF");
  assert.deepEqual(result.factors, { competitionMilli: 1060, demandMilli: 1400, scarcityMilli: 1333, durationMilli: 2500 });
  assert.deepEqual(result.inputs, { competingSellers: 3, compatibleBuyers: 4, reachableBuyers: 4, reachTruncated: false, slotsTotal: 3, slotsUsed: 1 });
  assert.deepEqual(result.pricing, { key: "default", version: 1 });
  assert.equal(result.unavailableReason, null);
  assert.equal(result.durationCode, "3d");
  assert.equal(result.offerId, offer.id);
  assert.equal(result.expiresAt.getTime() - result.computedAt.getTime(), 900_000, "validité de 900 s");
  const stored = await sqlRow<Record<string, unknown>>("SELECT * FROM boost_quotes WHERE id = $1", [result.id]);
  assert.equal(stored.seller_id, seller);
  assert.deepEqual([stored.scope_category, stored.scope_brand, stored.scope_model], ["smartphones", "apple", "iphone 13"]);
  assert.equal(stored.amount, 2500);
  assert.equal(stored.raw_amount, "2472.715000000000");
  assert.deepEqual([stored.competition_milli, stored.demand_milli, stored.scarcity_milli, stored.duration_milli], [1060, 1400, 1333, 2500]);
  assert.deepEqual([stored.competing_sellers, stored.compatible_buyers, stored.reachable_buyers, stored.slots_total, stored.slots_used], [3, 4, 4, 3, 1]);
  assert.equal(stored.status, "available");
  // Les deux autres durées sur le même monde : brut = 500 × 1,060 × 1,300 × 1,333 × durée.
  assert.equal((await quote(offer, "24h")).rawAmount, "989.086000000000");
  assert.equal((await quote(offer, "24h")).amount, 1000);
  assert.equal((await quote(offer, "7d")).rawAmount, "4945.430000000000");
  assert.equal((await quote(offer, "7d")).amount, 4900);
  // Aucune réservation de place : les places utilisées n'ont pas bougé.
  assert.equal((await readBoostSlots({ pool, offerId: offer.id })).used, 1);
  assert.equal((await sqlRow<{ n: number }>("SELECT count(*)::int AS n FROM offer_boosts")).n, 1);
});

// ═════════════ 3. Réutilisation, expiration, versions ═════════════

const expire = (id: string) => pool.query("UPDATE boost_quotes SET computed_at = computed_at - interval '2 hours', expires_at = expires_at - interval '2 hours' WHERE id = $1", [id]);

test("réutilisation : même id pendant la validité malgré des comptages et une version tarifaire changés ; nouvelle ligne après expiration, autre durée ou autre clé produit", async () => {
  const { offer, seller, others } = await controlWorld();
  const first = await quote(offer, "3d");
  const again = await quote(offer, "3d");
  assert.equal(again.id, first.id);
  assert.equal(again.reused, true);
  assert.deepEqual({ ...again, reused: false }, first, "renvoyée telle quelle");
  assert.equal((await sqlRow<{ n: number }>("SELECT count(*)::int AS n FROM boost_quotes")).n, 1);

  // Les comptages changent (un acheteur de plus, un boost de plus, un vendeur de plus) et une nouvelle version tarifaire est insérée.
  await addBuyer(offer);
  await grant(others[1]);
  await makeOffer();
  await insertPricing("default", 2, { base_amount: 1000 });
  const stillValid = await quote(offer, "3d");
  assert.equal(stillValid.id, first.id, "même cotation pendant sa validité, même si tout a changé");
  assert.equal(stillValid.reused, true);
  assert.equal(stillValid.amount, 2500);
  assert.deepEqual(stillValid.pricing, { key: "default", version: 1 });
  assert.equal((await sqlRow<{ n: number }>("SELECT count(*)::int AS n FROM boost_quotes")).n, 1);

  // Une autre durée : nouvelle ligne, avec la version tarifaire la plus haute et les nouveaux comptages.
  const day = await quote(offer, "24h");
  assert.notEqual(day.id, first.id);
  assert.equal(day.reused, false);
  assert.deepEqual(day.pricing, { key: "default", version: 2 });
  assert.equal(day.inputs.compatibleBuyers, 5);
  assert.equal(day.inputs.slotsUsed, 2);
  assert.equal(day.inputs.competingSellers, 4);

  // Après expiration : nouvelle ligne, version 2, nouveaux comptages.
  await expire(first.id);
  const renewed = await quote(offer, "3d");
  assert.notEqual(renewed.id, first.id);
  assert.equal(renewed.reused, false);
  assert.deepEqual(renewed.pricing, { key: "default", version: 2 });
  assert.equal(renewed.inputs.compatibleBuyers, 5);
  assert.equal((await quote(offer, "3d")).id, renewed.id, "la nouvelle cotation est à son tour réutilisée");
  // Une cotation de 24h expirée à son tour.
  await expire(day.id);
  assert.notEqual((await quote(offer, "24h")).id, day.id);

  // Un changement de clé produit : le périmètre change, une nouvelle cotation est calculée (l'ancienne n'est pas réutilisée).
  const beforeKey = await quote(offer, "3d");
  await pool.query("UPDATE offers SET model = 'iPhone 14' WHERE id = $1", [offer.id]);
  const moved = await quote(offer, "3d");
  assert.notEqual(moved.id, beforeKey.id);
  assert.equal(moved.reused, false);
  const scopeRow = await sqlRow<{ scope_model: string; seller_id: string }>("SELECT scope_model, seller_id FROM boost_quotes WHERE id = $1", [moved.id]);
  assert.deepEqual(scopeRow, { scope_model: "iphone 14", seller_id: seller });
  assert.equal((await quote(offer, "3d")).id, moved.id);
  // Les cotations de l'ancien périmètre restent dans l'historique, intactes.
  assert.equal((await sqlRow<{ n: number }>("SELECT count(*)::int AS n FROM boost_quotes WHERE scope_model = 'iphone 13'")).n, 4);
});

// ═════════════ 4. Indisponibilités ═════════════

test("indisponibilités : chaque motif, comptages renseignés, aucun prix ni facteur, validité de 60 s ; une cotation disponible dure 900 s", async () => {
  // offer_already_boosted
  const world = await controlWorld();
  const available = await quote(world.offer);
  assert.equal(available.expiresAt.getTime() - available.computedAt.getTime(), 900_000);
  await expire(available.id);
  await grant(world.offer);
  const boosted = await quote(world.offer);
  assert.deepEqual({ status: boosted.status, reason: boosted.unavailableReason, amount: boosted.amount, raw: boosted.rawAmount, factors: boosted.factors },
    { status: "unavailable", reason: "offer_already_boosted", amount: null, raw: null, factors: null });
  assert.deepEqual(boosted.inputs, { competingSellers: 3, compatibleBuyers: 4, reachableBuyers: null, reachTruncated: false, slotsTotal: 3, slotsUsed: 2 });
  assert.equal(boosted.expiresAt.getTime() - boosted.computedAt.getTime(), 60_000, "validité de 60 s");
  assert.equal(boosted.reused, false);
  const row = await sqlRow<Record<string, unknown>>("SELECT * FROM boost_quotes WHERE id = $1", [boosted.id]);
  assert.deepEqual([row.status, row.unavailable_reason, row.amount, row.raw_amount, row.competition_milli, row.demand_milli, row.scarcity_milli, row.duration_milli],
    ["unavailable", "offer_already_boosted", null, null, null, null, null, null]);
  assert.equal((await quote(world.offer)).id, boosted.id, "l'indisponibilité est réutilisée pendant ses 60 s");

  // no_slot_available : un périmètre de 1 place occupée par un autre vendeur.
  await wipe();
  const lone = await makeOffer();
  const rival = await makeOffer();
  await grant(rival);
  await addBuyer(lone);
  const noSlot = await quote(lone);
  assert.equal(noSlot.unavailableReason, "no_slot_available");
  assert.deepEqual(noSlot.inputs, { competingSellers: 1, compatibleBuyers: 1, reachableBuyers: null, reachTruncated: false, slotsTotal: 1, slotsUsed: 1 });

  // total = 0 (min_slots = max_slots = 0) : indisponible, jamais un prix infini.
  await setBoostSettings("smartphones", { min_slots: 0, max_slots: 0 });
  try {
    const zero = await quote(await makeOffer());
    assert.equal(zero.unavailableReason, "no_slot_available");
    assert.equal(zero.inputs.slotsTotal, 0);
    assert.equal(zero.amount, null);
  } finally { await resetBoostSettings(); }

  // seller_boost_limit_reached : 2 places, le vendeur en occupe déjà une (plafond 1).
  await wipe();
  const seller = await makeUser();
  const a = await makeOffer({ ownerId: seller });
  const b = await makeOffer({ ownerId: seller });
  for (let index = 0; index < 5; index++) await makeOffer();
  await grant(a);
  await addBuyer(b);
  const limit = await quote(b);
  assert.equal(limit.unavailableReason, "seller_boost_limit_reached");
  assert.deepEqual(limit.inputs, { competingSellers: 5, compatibleBuyers: 1, reachableBuyers: null, reachTruncated: false, slotsTotal: 2, slotsUsed: 1 });

  // no_compatible_buyer : aucune évaluation → pas de vente sans exposition possible.
  await wipe();
  const unseen = await makeOffer();
  const noBuyer = await quote(unseen);
  assert.equal(noBuyer.unavailableReason, "no_compatible_buyer");
  assert.deepEqual(noBuyer.inputs, { competingSellers: 0, compatibleBuyers: 0, reachableBuyers: 0, reachTruncated: false, slotsTotal: 1, slotsUsed: 0 });
  assert.equal(noBuyer.factors, null);
});

test("indisponibilités : ordre de priorité quand plusieurs motifs s'appliquent", async () => {
  // already_boosted + no_slot + seller_limit + no_buyer → already_boosted
  await wipe();
  const seller = await makeUser();
  const mine = await makeOffer({ ownerId: seller });
  await grant(mine);                                  // 1 place sur 1 : plus de place, plafond vendeur atteint, aucun acheteur, déjà boosté
  assert.equal((await quote(mine)).unavailableReason, "offer_already_boosted");
  // no_slot + seller_limit + no_buyer (offre non boostée du même vendeur) → no_slot_available
  const second = await makeOffer({ ownerId: seller });
  assert.equal((await quote(second)).unavailableReason, "no_slot_available");
  // seller_limit + no_buyer, avec une place libre → seller_boost_limit_reached
  await wipe();
  const owner = await makeUser();
  const first = await makeOffer({ ownerId: owner });
  const other = await makeOffer({ ownerId: owner });
  for (let index = 0; index < 6; index++) await makeOffer();   // 8 offres → 2 places, plafond vendeur 1
  await grant(first);
  assert.equal((await quote(other)).unavailableReason, "seller_boost_limit_reached", "plafond vendeur prioritaire sur l'absence d'acheteur");
  // no_buyer seul → no_compatible_buyer
  const fresh = await makeOffer();
  assert.equal((await quote(fresh)).unavailableReason, "no_compatible_buyer");
  // Avec un acheteur, la même offre devient disponible.
  await addBuyer(fresh);
  await pool.query("DELETE FROM boost_quotes");
  assert.equal((await quote(fresh)).status, "available");
});

// ═════════════ 5. Comptages ═════════════

async function freshQuote(offer: OfferRecord): Promise<BoostQuote> {
  await pool.query("DELETE FROM boost_quotes");
  return quote(offer);
}

test("acheteurs compatibles : distincts ; compatibilité inconnue, évaluation périmée, acheteur suspendu, demande non active ou évaluation inéligible ne comptent pas", async () => {
  await wipe();
  const offer = await makeOffer();
  const buyers = async () => (await freshQuote(offer)).inputs.compatibleBuyers;
  assert.equal(await buyers(), 0);

  const one = await addBuyer(offer);
  assert.equal(await buyers(), 1);
  // Deux demandes du même acheteur → 1.
  const secondDemand = await makeDemand(one.buyerId);
  await evaluate(offer, secondDemand);
  assert.equal(await buyers(), 1, "deux demandes du même acheteur : un seul acheteur");
  // Un deuxième acheteur → 2.
  await addBuyer(offer);
  assert.equal(await buyers(), 2);

  // Compatibilité « unknown » (à confirmer) : ne compte pas. Idem incompatible et inéligible.
  await addBuyer(offer, { compatibility: "unknown" });
  await addBuyer(offer, { compatibility: "incompatible" });
  await addBuyer(offer, { eligibility: "ineligible" });
  assert.equal(await buyers(), 2, "unknown, incompatible, inéligible : 0");
  // Évaluation périmée (is_stale) et évaluation expirée (expires_at) : 0.
  await addBuyer(offer, { isStale: true });
  const expired = await addBuyer(offer);
  await pool.query("UPDATE matching_evaluations SET expires_at = clock_timestamp() - interval '1 second' WHERE id = $1", [expired.evaluationId]);
  assert.equal(await buyers(), 2, "stale et expirée : 0");
  // Version de moteur ancienne : 0 (prédicat de fraîcheur partagé).
  const oldEngine = await addBuyer(offer);
  await pool.query("UPDATE matching_evaluations SET engine_scoring_version = 'ancienne' WHERE id = $1", [oldEngine.evaluationId]);
  assert.equal(await buyers(), 2, "version de moteur périmée : 0");
  // Acheteur suspendu ou archivé, demande non active : 0.
  const suspended = await addBuyer(offer);
  await pool.query("UPDATE users SET status = 'suspended' WHERE id = $1", [suspended.buyerId]);
  const archived = await addBuyer(offer);
  await pool.query("UPDATE users SET status = 'archived', archived_at = clock_timestamp() WHERE id = $1", [archived.buyerId]);
  const satisfied = await addBuyer(offer);
  await pool.query("UPDATE demands SET status = 'satisfied' WHERE id = $1", [satisfied.demand.id]);
  assert.equal(await buyers(), 2, "acheteur suspendu, archivé, demande non active : 0");
  // Une évaluation d'une AUTRE offre ne compte pas pour celle-ci.
  const stranger = await makeOffer();
  await addBuyer(stranger);
  assert.equal(await buyers(), 2);
  // Version du contenu de l'offre périmée : 0.
  const versioned = await addBuyer(offer);
  await pool.query("UPDATE matching_evaluations SET offer_content_version = offer_content_version + 1 WHERE id = $1", [versioned.evaluationId]);
  assert.equal(await buyers(), 2);
});

test("vendeurs concurrents : distincts, hors le vendeur coté, éligibles seulement ; offres en double d'un même autre vendeur → 1", async () => {
  await wipe();
  const seller = await makeUser();
  const offer = await makeOffer({ ownerId: seller });
  const competing = async () => (await freshQuote(offer)).inputs.competingSellers;
  assert.equal(await competing(), 0);
  // Les offres du vendeur lui-même ne comptent pas.
  await makeOffer({ ownerId: seller });
  await makeOffer({ ownerId: seller });
  assert.equal(await competing(), 0, "offres du vendeur lui-même : S = 0");
  // Un autre vendeur avec trois offres → 1.
  const rival = await makeUser();
  for (let index = 0; index < 3; index++) await makeOffer({ ownerId: rival });
  assert.equal(await competing(), 1, "offres en double d'un même autre vendeur : S = 1");
  await makeOffer();
  assert.equal(await competing(), 2);
  // Offres inéligibles d'autres vendeurs : brouillon, pause, archivée, indisponible, vendeur suspendu ou archivé, autre produit : 0.
  await makeOffer({ status: "draft" });
  await makeOffer({ status: "paused" });
  const archived = await makeOffer();
  await pool.query("UPDATE offers SET status = 'archived', archived_at = clock_timestamp() WHERE id = $1", [archived.id]);
  await makeOffer({ availability: "unavailable" });
  const suspended = await makeOffer();
  await pool.query("UPDATE users SET status = 'suspended' WHERE id = $1", [suspended.ownerId]);
  const gone = await makeOffer();
  await pool.query("UPDATE users SET status = 'archived', archived_at = clock_timestamp() WHERE id = $1", [gone.ownerId]);
  await makeOffer({ model: "iPhone 14" });
  await makeOffer({ category: "tablets" });
  assert.equal(await competing(), 2, "offres inéligibles ou d'un autre produit : 0");
  // Casse et espaces de la clé produit : même périmètre.
  const spelled = await makeOffer();
  await pool.query("UPDATE offers SET category = ' SMARTPHONES', brand = 'apple ', model = 'IPHONE 13' WHERE id = $1", [spelled.id]);
  assert.equal(await competing(), 3);
  // Disponibilité réservée ou inconnue : éligibles.
  await makeOffer({ availability: "reserved" });
  await makeOffer({ availability: null });
  assert.equal(await competing(), 5);
});

test("places : slots_total et slots_used identiques à readBoostSlots (plusieurs états de périmètre)", async () => {
  await wipe();
  const sellers = [await makeUser(), await makeUser(), await makeUser()];
  const offers: OfferRecord[] = [];
  for (let index = 0; index < 30; index++) offers.push(await makeOffer({ ownerId: sellers[index % 3] }));
  await makeOffer({ status: "paused" });
  await makeOffer({ availability: "unavailable" });
  await addBuyer(offers[0]);
  const check = async (label: string) => {
    const slots = await readBoostSlots({ pool, offerId: offers[0].id });
    const result = await freshQuote(offers[0]);
    assert.deepEqual({ total: result.inputs.slotsTotal, used: result.inputs.slotsUsed }, { total: slots.total, used: slots.used }, label);
  };
  await check("aucun boost");
  await grant(offers[1]);
  await check("un boost");
  await grant(offers[2]);
  await check("deux boosts");
  await pool.query("UPDATE offer_boosts SET starts_at = clock_timestamp() - interval '2 days', ends_at = clock_timestamp() - interval '1 day' WHERE offer_id = $1", [offers[1].id]);
  await check("un boost échu ne compte plus");
  await setBoostSettings("smartphones", { slot_ratio: 0.3, min_slots: 2, max_slots: 4 });
  try { await check("réglages de catégorie"); } finally { await resetBoostSettings(); }
});

// ═════════════ 6. Erreurs sans enregistrement, versions tarifaires ═════════════

test("erreurs de domaine sans aucune ligne créée : offer_not_found, offer_not_owned, offer_not_eligible, offer_not_boostable, boost_pricing_missing", async () => {
  await wipe();
  const offer = await makeOffer();
  const stranger = await makeUser();
  assert.equal(await code(quoteOfferBoost({ pool, ownerId: offer.ownerId, offerId: randomUUID(), durationCode: "24h" })), "offer_not_found");
  assert.equal(await code(quoteOfferBoost({ pool, ownerId: stranger, offerId: offer.id, durationCode: "24h" })), "offer_not_owned");
  const ineligible: Array<[string, OfferRecord]> = [
    ["brouillon", await makeOffer({ status: "draft" })], ["pause", await makeOffer({ status: "paused" })], ["indisponible", await makeOffer({ availability: "unavailable" })],
  ];
  const archived = await makeOffer();
  await pool.query("UPDATE offers SET status = 'archived', archived_at = clock_timestamp() WHERE id = $1", [archived.id]);
  ineligible.push(["archivée", archived]);
  const suspended = await makeOffer();
  await pool.query("UPDATE users SET status = 'suspended' WHERE id = $1", [suspended.ownerId]);
  ineligible.push(["vendeur suspendu", suspended]);
  for (const [label, candidate] of ineligible) assert.equal(await code(quote(candidate)), "offer_not_eligible", label);
  for (const [label, input] of [["sans catégorie", { category: null }], ["sans marque", { brand: null }], ["sans modèle", { model: null }]] as Array<[string, OfferInput]>) {
    assert.equal(await code(quote(await makeOffer(input))), "offer_not_boostable", label);
  }
  const blank = await makeOffer();
  await pool.query("UPDATE offers SET model = '   ' WHERE id = $1", [blank.id]);
  assert.equal(await code(quote(blank)), "offer_not_boostable", "modèle blanc");

  // boost_pricing_missing : ni ligne de catégorie ni ligne « default ».
  const saved = (await pool.query("SELECT * FROM boost_pricing_settings WHERE key = 'default' AND version = 1")).rows[0];
  await pool.query("DELETE FROM boost_pricing_settings");
  try {
    await addBuyer(offer);
    assert.equal(await code(quote(offer)), "boost_pricing_missing");
    await assert.rejects(readBoostPricingSettings(pool, "smartphones"), (error: unknown) => error instanceof BoostError && error.code === "boost_pricing_missing");
  } finally {
    await insertPricing(saved.key, saved.version);
  }
  assert.equal((await sqlRow<{ n: number }>("SELECT count(*)::int AS n FROM boost_quotes")).n, 0, "aucune erreur ne laisse de cotation");
  assert.equal((await quote(offer)).status, "available", "réglages rétablis : la cotation fonctionne");
  await wipe();
});

test("réglages tarifaires : la catégorie de l'offre (casse et espaces ignorés) avec sa version la plus haute, sinon default avec sa version la plus haute", async () => {
  await wipe();
  const offer = await makeOffer();
  await addBuyer(offer);
  try {
    // default v1 seulement.
    assert.deepEqual((await quote(offer)).pricing, { key: "default", version: 1 });
    // default v2 > v1 : la plus haute.
    await insertPricing("default", 2, { base_amount: 600 });
    await pool.query("DELETE FROM boost_quotes");
    assert.deepEqual((await quote(offer)).pricing, { key: "default", version: 2 });
    // Une catégorie avec trois versions (insérées dans le désordre) : sa version 3, pas default.
    await insertPricing("smartphones", 3, { base_amount: 3000 });
    await insertPricing("smartphones", 1, { base_amount: 1000 });
    await insertPricing("smartphones", 2, { base_amount: 2000 });
    await insertPricing("default", 9, { base_amount: 700 });
    await pool.query("DELETE FROM boost_quotes");
    const category = await quote(offer);
    assert.deepEqual(category.pricing, { key: "smartphones", version: 3 });
    assert.equal(category.rawAmount, "4200.000000000000", "base 3 000 × demande 1,4 (D = 1 → D' = 5, lot M1-quater ; avant : 1,2 puis 1,0), autres facteurs à 1000 (S = 0, 1 place sur 1, 24h)");
    // La catégorie de l'offre en casse mixte désigne la même ligne.
    await pool.query("UPDATE offers SET category = '  SmartPhones ' WHERE id = $1", [offer.id]);
    await pool.query("DELETE FROM boost_quotes");
    assert.deepEqual((await quote(offer)).pricing, { key: "smartphones", version: 3 });
    // Une autre catégorie sans ligne : default v9.
    await pool.query("UPDATE offers SET category = 'tablets' WHERE id = $1", [offer.id]);
    await pool.query("DELETE FROM boost_quotes");
    assert.deepEqual((await quote(offer)).pricing, { key: "default", version: 9 });
    assert.deepEqual(await readBoostPricingSettings(pool, null).then((settings) => [settings.key, settings.version]), ["default", 9]);
    // Une nouvelle version n'efface jamais l'ancienne : toutes les lignes subsistent.
    assert.equal((await sqlRow<{ n: number }>("SELECT count(*)::int AS n FROM boost_pricing_settings WHERE key = 'smartphones'")).n, 3);
  } finally {
    await pool.query("DELETE FROM boost_quotes");
    await pool.query("DELETE FROM boost_pricing_settings WHERE key <> 'default' OR version <> 1");
  }
  await wipe();
});

// ═════════════ 7. Concurrence ═════════════

async function distinctPools(count: number): Promise<Pool[]> {
  const pools: Pool[] = [];
  for (let index = 0; index < count; index++) {
    const extra = await openVerifiedIsolatedPool(target, schema, ownSessions);
    extraPools.push(extra);
    pools.push(extra);
  }
  return pools;
}

function meetingPoint(size: number, timeoutMs: number): () => Promise<void> {
  let arrived = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  return async () => {
    arrived += 1;
    if (arrived >= size) release();
    await Promise.race([gate, new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))]);
  };
}

test("concurrence : 6 cotations simultanées de la même offre et durée (pools distincts, point de rencontre forcé) → 1 ligne, 6 réponses de même id", async () => {
  const { offer } = await controlWorld();
  const pools = await distinctPools(6);
  const meet = meetingPoint(6, 300);
  let start!: () => void;
  const barrier = new Promise<void>((resolve) => { start = resolve; });
  const attempts = pools.map(async (db) => { await barrier; return quote(offer, "3d", db, { beforeInsert: meet }); });
  start();
  const results = await Promise.all(attempts);
  assert.equal((await sqlRow<{ n: number }>("SELECT count(*)::int AS n FROM boost_quotes")).n, 1, "une seule ligne");
  assert.equal(new Set(results.map((result) => result.id)).size, 1, "six réponses de même id");
  assert.equal(results.filter((result) => !result.reused).length, 1, "une seule calcule, les cinq autres réutilisent");
  assert.ok(results.every((result) => result.amount === 2500));
  // Offres ou durées différentes : pas de verrou partagé qui bloque (une ligne par couple).
  const other = await Promise.all([quote(offer, "24h", pools[0]), quote(offer, "7d", pools[1])]);
  assert.notEqual(other[0].id, other[1].id);
});

// ═════════════ 8. Immutabilité ═════════════

test("immutabilité : le contenu de boost_quotes reste identique après lectures, réutilisations, historiques et cotations d'autres durées", async () => {
  const { offer, seller } = await controlWorld();
  const first = await quote(offer, "3d");
  await expire((await quote(offer, "24h")).id);
  const snapshot = async () => (await pool.query("SELECT to_jsonb(q.*) AS row FROM boost_quotes q ORDER BY q.id")).rows;
  const before = await snapshot();
  assert.equal(before.length, 2);
  const target = before.find((row) => row.row.id === first.id)!;
  for (let index = 0; index < 3; index++) await quote(offer, "3d");
  await listOfferBoostQuotes({ pool, ownerId: seller, offerId: offer.id, limit: 50 });
  await readScopeBoostPriceHistory({ pool, category: "smartphones", brand: "apple", model: "iphone 13", limit: 50 });
  await readBoostPricingSettings(pool, "smartphones");
  const after = await snapshot();
  assert.deepEqual(after.filter((row) => row.row.id === first.id), [target], "la cotation réutilisée n'est jamais réécrite");
  assert.deepEqual(after, before, "aucune ligne modifiée, ajoutée ni supprimée par des lectures et réutilisations");
});

// ═════════════ 9. Historiques ═════════════

test("historique vendeur : propriété, ordre (plus récentes d'abord), limite, expired calculé à la lecture", async () => {
  const { offer, seller, others } = await controlWorld();
  const q24 = await quote(offer, "24h");
  const q3d = await quote(offer, "3d");
  const q7d = await quote(offer, "7d");
  await pool.query("UPDATE boost_quotes SET computed_at = computed_at - interval '3 minutes' WHERE id = $1", [q24.id]);
  await pool.query("UPDATE boost_quotes SET computed_at = computed_at - interval '2 minutes' WHERE id = $1", [q3d.id]);
  await pool.query("UPDATE boost_quotes SET computed_at = computed_at - interval '1 minutes' WHERE id = $1", [q7d.id]);
  await expire(q24.id);
  const history = await listOfferBoostQuotes({ pool, ownerId: seller, offerId: offer.id, limit: 50 });
  assert.deepEqual(history.map((item) => item.id), [q7d.id, q3d.id, q24.id], "plus récentes d'abord");
  assert.deepEqual(history.map((item) => item.expired), [false, false, true]);
  assert.deepEqual(history.map((item) => item.durationCode), ["7d", "3d", "24h"]);
  assert.ok(history.every((item) => item.offerId === offer.id && !("reused" in item)));
  assert.equal(history[0].amount, q7d.amount);
  assert.deepEqual(history[0].factors, q7d.factors);
  assert.equal((await listOfferBoostQuotes({ pool, ownerId: seller, offerId: offer.id, limit: 2 })).length, 2);
  assert.deepEqual((await listOfferBoostQuotes({ pool, ownerId: seller, offerId: offer.id, limit: 1 })).map((item) => item.id), [q7d.id]);
  // Indisponible : conservée dans l'historique avec son motif.
  await grant(offer);
  const unavailable = await quote(offer, "24h");
  assert.equal(unavailable.status, "unavailable");
  const withUnavailable = await listOfferBoostQuotes({ pool, ownerId: seller, offerId: offer.id, limit: 50 });
  assert.equal(withUnavailable[0].id, unavailable.id);
  assert.equal(withUnavailable[0].unavailableReason, "offer_already_boosted");
  // Propriété et erreurs.
  assert.equal(await code(listOfferBoostQuotes({ pool, ownerId: others[0].ownerId, offerId: offer.id, limit: 5 })), "offer_not_owned");
  assert.equal(await code(listOfferBoostQuotes({ pool, ownerId: seller, offerId: randomUUID(), limit: 5 })), "offer_not_found");
  assert.deepEqual(await listOfferBoostQuotes({ pool, ownerId: others[0].ownerId, offerId: others[0].id, limit: 5 }), [], "ses propres offres sans cotation : liste vide");
});

test("historique d'un périmètre : normalisation (casse, espaces), cotations DISPONIBLES seulement, plus récentes d'abord, aucun identifiant d'offre ni de vendeur", async () => {
  const { offer, seller, own } = await controlWorld();
  const q24 = await quote(offer, "24h");
  const q3d = await quote(offer, "3d");
  await pool.query("UPDATE boost_quotes SET computed_at = computed_at - interval '5 minutes' WHERE id = $1", [q24.id]);
  // Une cotation indisponible (autre offre, aucun acheteur) n'apparaît pas.
  const unavailable = await quote(own[1], "24h");
  assert.equal(unavailable.status, "unavailable");
  // Un autre périmètre n'apparaît pas.
  const other = await makeOffer({ brand: "Samsung", model: "Galaxy S23" });
  await addBuyer(other);
  await quote(other);
  const history = await readScopeBoostPriceHistory({ pool, category: "smartphones", brand: "apple", model: "iphone 13", limit: 200 });
  assert.equal(history.length, 2);
  assert.deepEqual(history.map((point) => [point.durationCode, point.amount]), [["3d", q3d.amount], ["24h", q24.amount]], "plus récentes d'abord, disponibles seulement");
  assert.deepEqual(history[0].factors, q3d.factors);
  assert.deepEqual(history[0].pricing, { key: "default", version: 1 });
  assert.equal(history[0].currency, "XOF");
  assert.ok(history[0].computedAt instanceof Date);
  for (const spelling of [["SMARTPHONES", "APPLE", "iPhone 13"], ["  Smartphones ", " apple", "IPHONE 13  "]]) {
    const same = await readScopeBoostPriceHistory({ pool, category: spelling[0], brand: spelling[1], model: spelling[2], limit: 200 });
    assert.deepEqual(same, history, `normalisation : ${JSON.stringify(spelling)}`);
  }
  assert.equal((await readScopeBoostPriceHistory({ pool, category: "smartphones", brand: "apple", model: "iphone 13", limit: 1 })).length, 1);
  assert.equal((await readScopeBoostPriceHistory({ pool, category: "smartphones", brand: "samsung", model: "galaxy s23", limit: 5 })).length, 1);
  assert.deepEqual(await readScopeBoostPriceHistory({ pool, category: "smartphones", brand: "inconnue", model: "x", limit: 5 }), []);
  // Aucun identifiant dans le résultat sérialisé.
  const text = JSON.stringify(history);
  const forbidden = [offer.id, seller, q24.id, q3d.id, ...own.map((candidate) => candidate.id), "offerId", "sellerId", "offer_id", "seller_id", "buyers", "compatibleBuyers", "RAW_SECRET_TEXT"];
  for (const needle of forbidden) assert.ok(!text.includes(needle), `fuite : ${needle}`);
  assert.deepEqual(Object.keys(history[0]).sort(), ["amount", "computedAt", "currency", "durationCode", "factors", "pricing"]);
});

// ═════════════ 10. Validation avant SQL ═════════════

function observedPool(): { spy: Pool; count: () => number } {
  let queries = 0;
  const spy = Object.create(pool) as Pool;
  spy.query = ((...args: unknown[]) => { queries++; return (pool.query as (...a: unknown[]) => unknown)(...args); }) as never;
  spy.connect = ((...args: unknown[]) => { queries++; return (pool.connect as (...a: unknown[]) => unknown)(...args); }) as never;
  return { spy, count: () => queries };
}

test("validation avant tout SQL : pool exigé, UUID, durée, limites, textes (zéro requête)", async () => {
  const { spy, count } = observedPool();
  const good = { pool: spy, ownerId: randomUUID(), offerId: randomUUID(), durationCode: "24h" as const };
  const rejects = (override: Record<string, unknown>) =>
    assert.rejects(quoteOfferBoost({ ...good, ...override } as never), (error: unknown) => error instanceof CatalogValidationError, JSON.stringify(Object.keys(override)));
  await rejects({ pool: undefined });
  await rejects({ pool: null });
  await rejects({ pool: {} });
  await rejects({ ownerId: "x" });
  await rejects({ offerId: "x" });
  await rejects({ durationCode: "30d" });
  await rejects({ durationCode: "24H" });
  await rejects({ durationCode: undefined });
  for (const limit of [0, 51, -1, 1.5, Number.NaN, "5" as unknown as number, undefined as unknown as number]) {
    await assert.rejects(listOfferBoostQuotes({ pool: spy, ownerId: good.ownerId, offerId: good.offerId, limit }), CatalogValidationError, `limite ${String(limit)}`);
  }
  await assert.rejects(listOfferBoostQuotes({ pool: spy, ownerId: "x", offerId: good.offerId, limit: 5 }), CatalogValidationError);
  await assert.rejects(listOfferBoostQuotes({ pool: spy, ownerId: good.ownerId, offerId: "x", limit: 5 }), CatalogValidationError);
  await assert.rejects(listOfferBoostQuotes({ pool: undefined as never, ownerId: good.ownerId, offerId: good.offerId, limit: 5 }), CatalogValidationError);
  const history = { pool: spy, category: "a", brand: "b", model: "c", limit: 5 };
  for (const override of [{ limit: 0 }, { limit: 201 }, { limit: 1.5 }, { category: "" }, { brand: "   " }, { model: undefined }, { category: 3 }, { pool: undefined }]) {
    await assert.rejects(readScopeBoostPriceHistory({ ...history, ...override } as never), CatalogValidationError, JSON.stringify(override));
  }
  assert.equal(count(), 0, "aucune requête SQL avant la validation");
  // Limites acceptées.
  assert.deepEqual(await readScopeBoostPriceHistory({ ...history, limit: 200 }), []);
  assert.deepEqual(await readScopeBoostPriceHistory({ ...history, limit: 1 }), []);
});

// ═════════════ 13. Portée visible d'un boost (lot P2-bis, migration 0016) ═════════════

/** Une transaction de lecture, comme celle de la cotation (le calcul de portée utilise des SAVEPOINT). */
async function inTransaction<T>(operation: (client: import("pg").PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally { client.release(); }
}

/** Ce que l'acheteur verrait réellement : l'offre est-elle « sponsorisée » dans SA liste, une fois l'offre boostée (attribution d'administration) ? */
async function seenSponsored(offer: OfferRecord, buyer: { buyerId: string; demand: DemandRecord }): Promise<boolean> {
  const page = await listStoredOfferMatchesForDemand(buyer.buyerId, buyer.demand.id, { sort: "relevance", limit: 100 }, pool);
  return page.items.some((item) => item.candidateId === offer.id && item.sponsored);
}

test("portée visible : listes de 1, 6, 7, 8 et 14 offres — quota nul sous 7 offres → no_visible_effect ; dès 7, disponible ; et l'acheteur voit « sponsorisé » exactement quand le devis le promet", async () => {
  const cases: Array<[number, boolean]> = [[1, false], [2, false], [6, false], [7, true], [8, true], [14, true]];
  for (const [listSize, reachable] of cases) {
    await wipe();
    const offer = await makeOffer();
    const buyer = await addBuyer(offer, { listSize });
    const result = await quote(offer, "24h");
    assert.equal(result.inputs.compatibleBuyers, 1, `liste de ${listSize} : un acheteur compatible`);
    assert.equal(result.inputs.reachableBuyers, reachable ? 1 : 0, `liste de ${listSize} : acheteurs atteignables`);
    if (reachable) {
      assert.equal(result.status, "available", `liste de ${listSize}`);
      assert.equal(result.unavailableReason, null);
      assert.ok(result.amount !== null && result.amount >= 500);
      assert.equal(result.expiresAt.getTime() - result.computedAt.getTime(), 900_000);
    } else {
      assert.deepEqual({ status: result.status, reason: result.unavailableReason, amount: result.amount, raw: result.rawAmount, factors: result.factors },
        { status: "unavailable", reason: "no_visible_effect", amount: null, raw: null, factors: null }, `liste de ${listSize}`);
      assert.equal(result.expiresAt.getTime() - result.computedAt.getTime(), 60_000, "indisponibilité : 60 s");
    }
    const row = await sqlRow<{ reachable_buyers: number | null; status: string; unavailable_reason: string | null }>("SELECT reachable_buyers, status, unavailable_reason FROM boost_quotes WHERE id = $1", [result.id]);
    assert.deepEqual([row.reachable_buyers, row.status, row.unavailable_reason], [reachable ? 1 : 0, reachable ? "available" : "unavailable", reachable ? null : "no_visible_effect"]);
    // Différentiel avec la lecture des résultats : mêmes fonctions de placement, donc le même verdict.
    await grant(offer);
    assert.equal(await seenSponsored(offer, buyer), reachable, `liste de ${listSize} : « sponsorisé » côté acheteur`);
  }
});

test("portée visible : seuil de pertinence — atteignable seulement si la pertinence organique atteint min_relevance (borne incluse)", async () => {
  await wipe();
  const offer = await makeOffer();
  const buyer = await addBuyer(offer);
  const ranking = await readDemandOrganicRanking(pool, { demandId: buyer.demand.id, ownerId: buyer.buyerId, at: new Date() });
  const mine = ranking.find((entry) => entry.offerId === offer.id)?.relevance;
  assert.ok(mine !== undefined && mine > 0 && mine < 100, `pertinence de l'offre : ${String(mine)}`);
  assert.equal(ranking.at(-1)?.offerId, offer.id, "l'offre est classée dernière (les remplissages, plus compatibles, passent devant)");
  try {
    await setBoostSettings("smartphones", { min_relevance: mine });
    const atThreshold = await freshQuote(offer);
    assert.equal(atThreshold.status, "available", "seuil = pertinence : atteignable (borne incluse)");
    assert.equal(atThreshold.inputs.reachableBuyers, 1);
    await setBoostSettings("smartphones", { min_relevance: mine + 0.01 });
    const above = await freshQuote(offer);
    assert.deepEqual([above.status, above.unavailableReason, above.inputs.reachableBuyers], ["unavailable", "no_visible_effect", 0], "seuil juste au-dessus : aucun effet visible");
    assert.equal(above.inputs.compatibleBuyers, 1, "l'acheteur reste compatible");
    await setBoostSettings("smartphones", { min_relevance: 0 });
    assert.equal((await freshQuote(offer)).status, "available");
  } finally { await resetBoostSettings(); }
});

test("portée visible : une offre déjà première dans la liste de l'acheteur ne monte pas — no_visible_effect, et l'acheteur ne la voit pas sponsorisée", async () => {
  await wipe();
  const offer = await makeOffer();
  const buyer = await addBuyer(offer, { targetFirst: true });
  const ranking = await readDemandOrganicRanking(pool, { demandId: buyer.demand.id, ownerId: buyer.buyerId, at: new Date() });
  assert.equal(ranking[0].offerId, offer.id, "l'offre est déjà première");
  const result = await quote(offer);
  assert.deepEqual([result.status, result.unavailableReason, result.inputs.compatibleBuyers, result.inputs.reachableBuyers], ["unavailable", "no_visible_effect", 1, 0]);
  await grant(offer);
  assert.equal(await seenSponsored(offer, buyer), false);
});

test("portée visible : acheteurs distincts — un acheteur à deux besoins atteignables compte une fois ; les listes courtes ne comptent pas ; compatibles ≥ atteignables", async () => {
  await wipe();
  const offer = await makeOffer();
  const a = await addBuyer(offer, { listSize: 7 });
  await addDemand(offer, a.buyerId, { listSize: 8 });
  await addBuyer(offer, { listSize: 1 });
  await addBuyer(offer, { listSize: 14 });
  const result = await quote(offer);
  assert.equal(result.inputs.compatibleBuyers, 3, "trois acheteurs compatibles");
  assert.equal(result.inputs.reachableBuyers, 2, "deux acheteurs atteignables");
  assert.equal(result.status, "available");
  // Le PRIX ne dépend que des acheteurs COMPATIBLES : même prix avec 1 ou 2 acheteurs atteignables.
  await wipe();
  const same = await makeOffer();
  await addBuyer(same, { listSize: 7 });
  await addBuyer(same, { listSize: 1 });
  await addBuyer(same, { listSize: 1 });
  const fewer = await quote(same);
  assert.equal(fewer.inputs.compatibleBuyers, 3);
  assert.equal(fewer.inputs.reachableBuyers, 1);
  assert.equal(fewer.amount, result.amount, "le prix est celui de 3 acheteurs compatibles, quel que soit le nombre d'acheteurs atteignables");
  assert.deepEqual(fewer.factors, result.factors);
});

test("portée visible : un autre boost déjà actif dans la liste consomme le quota — quota 1 pris par une offre boostée mieux classée → aucun effet ; quota 2 → l'offre monte", async () => {
  for (const [listSize, reachable] of [[7, false], [14, true]] as const) {
    await wipe();
    const offer = await makeOffer();
    const buyer = await addBuyer(offer, { listSize });
    const ranking = await readDemandOrganicRanking(pool, { demandId: buyer.demand.id, ownerId: buyer.buyerId, at: new Date() });
    const head = ranking[0];
    assert.notEqual(head.offerId, offer.id);
    const headOwner = (await sqlRow<{ owner_id: string }>("SELECT owner_id FROM offers WHERE id = $1", [head.offerId])).owner_id;
    await grantOfferBoost({ pool, offerId: head.offerId, ownerId: headOwner, durationCode: "24h", source: "admin_grant" });
    const result = await quote(offer);
    assert.equal(result.inputs.reachableBuyers, reachable ? 1 : 0, `liste de ${listSize}, une offre mieux classée est déjà boostée`);
    assert.equal(result.status, reachable ? "available" : "unavailable");
    await grant(offer);
    assert.equal(await seenSponsored(offer, buyer), reachable, `liste de ${listSize} : verdict identique à la lecture des résultats`);
  }
});

test("portée visible : ordre des motifs — aucun effet visible est le DERNIER (déjà boostée, plus de place, plafond vendeur et aucun acheteur compatible passent avant)", async () => {
  // Liste courte (aucun effet) mais l'offre est déjà boostée → offer_already_boosted ; reachable non évalué (null).
  await wipe();
  const boosted = await makeOffer();
  await addBuyer(boosted, { listSize: 1 });
  await grant(boosted);
  const first = await quote(boosted);
  assert.deepEqual([first.unavailableReason, first.inputs.reachableBuyers], ["offer_already_boosted", null]);
  // Plus de place (1 place prise par un autre vendeur) → no_slot_available, reachable non évalué.
  await wipe();
  const lone = await makeOffer();
  const rival = await makeOffer();
  await grant(rival);
  await addBuyer(lone, { listSize: 1 });
  const second = await quote(lone);
  assert.deepEqual([second.unavailableReason, second.inputs.reachableBuyers], ["no_slot_available", null]);
  // Aucun acheteur compatible → no_compatible_buyer (et non no_visible_effect), reachable = 0.
  await wipe();
  const unseen = await makeOffer();
  const third = await quote(unseen);
  assert.deepEqual([third.unavailableReason, third.inputs.compatibleBuyers, third.inputs.reachableBuyers], ["no_compatible_buyer", 0, 0]);
  // Des acheteurs compatibles mais aucun effet → no_visible_effect.
  await addBuyer(unseen, { listSize: 3 });
  await pool.query("DELETE FROM boost_quotes");
  const fourth = await quote(unseen);
  assert.deepEqual([fourth.unavailableReason, fourth.inputs.compatibleBuyers, fourth.inputs.reachableBuyers], ["no_visible_effect", 1, 0]);
});

const REACH_BUDGET = 30_000;
const reachOf = (offerId: string, mode: "count" | "first" = "count", extra: Partial<Parameters<typeof computeBoostReach>[1]> = {}) =>
  inTransaction((client) => computeBoostReach(client, { offerId, mode, budgetMs: REACH_BUDGET, ...extra }));

test("portée visible (lot P3) : bornes — 20 besoins comptés, 50 examinés pour trouver un premier acheteur ; tronqué = le compte est un minimum", async () => {
  assert.equal(BOOST_REACH_COUNT_LIMIT, 20);
  assert.equal(BOOST_REACH_SEARCH_LIMIT, 50);
  assert.equal(BOOST_QUOTE_REACH_BUDGET_MS, 3_000);
  assert.equal(BOOST_PURCHASE_REACH_BUDGET_MS, 1_500);
  assert.equal(BOOST_REUSE_REACH_BUDGET_MS, 1_000);
  assert.equal(BOOST_REACH_STATEMENT_TIMEOUT_MS, 2_000);
  // (1) Le seul besoin atteignable est le PLUS ANCIEN, derrière 44 besoins à liste courte : trouvé au-delà de 20 (45e examiné) ; 45 besoins existent, le compte est exact.
  await wipe();
  const offer = await makeOffer();
  await addBuyer(offer, { listSize: 7 });
  for (let index = 0; index < 44; index++) await addBuyer(offer, { listSize: 1 });
  const found = await reachOf(offer.id);
  assert.deepEqual([found.reachableBuyers, found.evaluatedDemands, found.truncated, found.budgetExhausted], [1, 45, false, false]);
  const availableQuote = await freshQuote(offer);
  assert.deepEqual([availableQuote.status, availableQuote.inputs.reachableBuyers, availableQuote.inputs.reachTruncated], ["available", 1, false]);
  // (2) 51 besoins, l'atteignable est le 51e (le plus ancien) : au-delà de la borne de recherche (50) → non trouvé, tronqué, aucun effet démontré.
  await wipe();
  const far = await makeOffer();
  await addBuyer(far, { listSize: 7 });
  for (let index = 0; index < 50; index++) await addBuyer(far, { listSize: 1 });
  const missed = await reachOf(far.id);
  assert.deepEqual([missed.reachableBuyers, missed.evaluatedDemands, missed.truncated], [0, 50, true]);
  const refused = await freshQuote(far);
  assert.deepEqual([refused.status, refused.unavailableReason, refused.inputs.compatibleBuyers, refused.inputs.reachableBuyers, refused.inputs.reachTruncated], ["unavailable", "no_visible_effect", 51, 0, true]);
  // (3) Trois atteignables parmi les 20 plus récents, 30 besoins plus anciens non examinés : comptage borné à 20, tronqué (minimum).
  await wipe();
  const crowded = await makeOffer();
  for (let index = 0; index < 30; index++) await addBuyer(crowded, { listSize: 1 });
  for (let index = 0; index < 17; index++) await addBuyer(crowded, { listSize: 1 });
  for (let index = 0; index < 3; index++) await addBuyer(crowded, { listSize: 7 });
  const capped = await reachOf(crowded.id);
  assert.deepEqual([capped.reachableBuyers, capped.evaluatedDemands, capped.truncated], [3, 20, true]);
  const cappedQuote = await freshQuote(crowded);
  assert.deepEqual([cappedQuote.status, cappedQuote.inputs.compatibleBuyers, cappedQuote.inputs.reachableBuyers, cappedQuote.inputs.reachTruncated], ["available", 50, 3, true]);
  const stored = await sqlRow<{ reachable_buyers: number; reach_truncated: boolean }>("SELECT reachable_buyers, reach_truncated FROM boost_quotes WHERE id = $1", [cappedQuote.id]);
  assert.deepEqual(stored, { reachable_buyers: 3, reach_truncated: true });
  // Relu tel quel : réutilisation et historique portent le drapeau.
  assert.equal((await quote(crowded)).inputs.reachTruncated, true);
  assert.equal((await listOfferBoostQuotes({ pool, ownerId: crowded.ownerId, offerId: crowded.id, limit: 5 }))[0].inputs.reachTruncated, true);
  // (4) Exactement 20 besoins, tous atteignables : compte exact (aucun besoin laissé de côté).
  await wipe();
  const exact = await makeOffer();
  for (let index = 0; index < 20; index++) await addBuyer(exact, { listSize: 7 });
  const all = await reachOf(exact.id);
  assert.deepEqual([all.reachableBuyers, all.evaluatedDemands, all.truncated], [20, 20, false]);
  // (5) Mode « premier » (revérification d'un achat) : arrêt au premier acheteur atteignable, quel que soit le nombre d'autres.
  const firstOnly = await reachOf(exact.id, "first");
  assert.deepEqual([firstOnly.reachableBuyers, firstOnly.evaluatedDemands, firstOnly.truncated], [1, 1, true]);
});

test("portée visible (lot P3) : budget de temps — épuisé, le calcul s'arrête et rend ce qui est démontré ; sans acheteur démontré → aucun effet visible (jamais une promesse)", async () => {
  await wipe();
  const offer = await makeOffer();
  for (let index = 0; index < 6; index++) await addBuyer(offer, { listSize: 7 });
  // Horloge factice : chaque lecture avance de 50 ms ; budget 120 ms → un seul besoin est examiné avant l'épuisement.
  const ticking = () => { let t = 0; return () => (t += 50); };
  const limited = await reachOf(offer.id, "count", { budgetMs: 120, clock: ticking() });
  assert.deepEqual([limited.evaluatedDemands, limited.reachableBuyers, limited.budgetExhausted, limited.truncated], [1, 1, true, true]);
  const none = await reachOf(offer.id, "count", { budgetMs: 40, clock: ticking() });
  assert.deepEqual([none.evaluatedDemands, none.reachableBuyers, none.budgetExhausted, none.truncated], [0, 0, true, true], "budget épuisé avant le premier besoin : rien de démontré");
  assert.equal(isReachUndetermined(none), true, "zéro acheteur ET budget épuisé : indéterminé (lot P3-bis)");
  assert.equal(isReachUndetermined(limited), false, "un acheteur démontré : pas indéterminé");
  assert.equal(isReachUndetermined({ reachableBuyers: 0, budgetExhausted: false }), false, "zéro acheteur, aucun épuisement : DÉMONTRÉ (no_visible_effect)");
  // Devis (lot P3-bis, N3) : budget épuisé SANS acheteur démontré → reach_check_unavailable (503) et AUCUN devis écrit (jamais un « aucun effet visible » : rien n'est
  // démontré) ; budget épuisé AVEC un acheteur démontré → disponible, « au moins 1 ».
  assert.equal(await code(quote(offer, "24h", pool, { reachBudgetMs: 40, reachClock: ticking() })), "reach_check_unavailable");
  assert.equal((await sqlRow<{ n: number }>("SELECT count(*)::int AS n FROM boost_quotes")).n, 0, "aucun devis indéterminé n'est persisté (il serait réutilisé 60 s)");
  await pool.query("DELETE FROM boost_quotes");
  const partial = await quote(offer, "24h", pool, { reachBudgetMs: 120, reachClock: ticking() });
  assert.deepEqual([partial.status, partial.inputs.reachableBuyers, partial.inputs.reachTruncated, partial.inputs.compatibleBuyers], ["available", 1, true, 6]);
});

test("portée visible (lot P3) : statement_timeout — une requête plus lente que le délai est interrompue (57014), le calcul s'arrête sans erreur, la transaction reste utilisable et le délai est rétabli", async () => {
  await wipe();
  const offer = await makeOffer();
  for (let index = 0; index < 3; index++) await addBuyer(offer, { listSize: 7 });
  const started = Date.now();
  const result = await inTransaction(async (client) => {
    const realQuery = client.query.bind(client) as (...args: unknown[]) => Promise<unknown>;
    // La première lecture d'un classement (tri par score) est précédée d'une instruction de 2 s : sous un délai de 100 ms elle doit être interrompue.
    let slept = false;
    (client as unknown as { query: unknown }).query = async (...args: unknown[]) => {
      const text = typeof args[0] === "string" ? args[0] : "";
      if (!slept && /ORDER BY e\.score/.test(text)) { slept = true; await realQuery("SELECT pg_sleep(2)"); }
      return realQuery(...args);
    };
    const reach = await computeBoostReach(client, { offerId: offer.id, mode: "count", budgetMs: REACH_BUDGET, statementTimeoutMs: 100 });
    (client as unknown as { query: unknown }).query = realQuery;
    const setting = (await client.query<{ statement_timeout: string }>("SHOW statement_timeout")).rows[0].statement_timeout;
    const usable = (await client.query<{ n: number }>("SELECT 1 AS n")).rows[0].n;
    return { reach, setting, usable };
  });
  assert.ok(Date.now() - started < 1_500, `l'instruction de 2 s a été interrompue vers 100 ms (${Date.now() - started} ms)`);
  assert.deepEqual([result.reach.budgetExhausted, result.reach.truncated, result.reach.reachableBuyers], [true, true, 0]);
  assert.equal(result.setting, "0", "délai rétabli (la transaction de l'appelant peut continuer vers un débit)");
  assert.equal(result.usable, 1, "la transaction reste utilisable après l'interruption");
});

test("devis (lot P3) : AUCUN verrou tenu pendant le calcul de la portée — un devis concurrent d'une autre durée et une mise en pause de l'offre passent pendant le calcul ; l'écriture relit l'offre sous verrou", async () => {
  await wipe();
  const offer = await makeOffer();
  for (let index = 0; index < 3; index++) await addBuyer(offer, { listSize: 7 });
  const observer = (await distinctPools(1))[0];
  let blocked!: () => void;
  const inReach = new Promise<void>((resolve) => { blocked = resolve; });
  let release!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  let first = true;
  const slow = quote(offer, "24h", pool, {
    beforeReachDemand: async () => { if (first) { first = false; blocked(); await hold; } },
  });
  const slowOutcome = slow.then((value) => ({ value }), (error: unknown) => ({ error }));
  await inReach;
  try {
    // Seulement NOS sessions, dans NOTRE base : un verrou de périmètre, de cotation ou de vendeur tenu par une autre exécution n'est pas une régression de ce test.
    const locks = await ownAdvisoryLocks(observer, APPLICATION, [BOOST_SCOPE_LOCK_NAMESPACE, BOOST_QUOTE_LOCK_NAMESPACE, BOOST_QUOTE_RATE_NAMESPACE], { granted: true });
    assert.deepEqual(locks, [], "aucun verrou consultatif de périmètre, de cotation ni de vendeur pendant le calcul de la portée");
    const startedAt = Date.now();
    const concurrent = await quote(offer, "3d", observer);
    assert.equal(concurrent.status, "available", "un devis d'une autre durée aboutit pendant le calcul du premier");
    const pause = await observer.query("UPDATE offers SET status = 'paused' WHERE id = $1", [offer.id]);
    assert.equal(pause.rowCount, 1, "la mise en pause de l'offre n'attend aucun verrou");
    assert.ok(Date.now() - startedAt < 2_000, `concurrent + pause en ${Date.now() - startedAt} ms`);
  } finally {
    release();
  }
  const outcome = await slowOutcome;
  assert.ok("error" in outcome && (outcome.error as { code?: string }).code === "offer_not_eligible", "l'écriture relit l'offre sous verrou : elle est en pause, le premier devis est refusé");
  assert.equal((await sqlRow<{ n: number }>("SELECT count(*)::int AS n FROM boost_quotes WHERE duration_code = '24h'")).n, 0, "rien n'est écrit pour le devis refusé");
});

test("devis (lot P3, P3-bis) : la portée est une estimation datée — si l'offre change de produit pendant le calcul, rien n'est démontré pour le nouveau périmètre : reach_check_unavailable (rien d'écrit), jamais un effet promis ni un refus définitif non démontré", async () => {
  await wipe();
  const offer = await makeOffer();
  for (let index = 0; index < 2; index++) await addBuyer(offer, { listSize: 7 });
  let moved = false;
  const writer = (await distinctPools(1))[0];
  const hooks: BoostQuoteTestHooks = {
    beforeReachDemand: async () => {
      if (!moved) { moved = true; await writer.query("UPDATE offers SET model = 'Autre produit' WHERE id = $1", [offer.id]); }
    },
  };
  assert.equal(await code(quote(offer, "24h", pool, hooks)), "reach_check_unavailable");
  assert.equal((await sqlRow<{ n: number }>("SELECT count(*)::int AS n FROM boost_quotes")).n, 0, "rien n'est écrit : aucune portée démontrée pour le nouveau périmètre");
  // Réessayé : la portée est calculée pour le périmètre actuel et le devis est écrit (réponse DÉMONTRÉE, jamais un 503).
  const retried = await quote(offer, "24h");
  assert.equal(retried.reused, false);
  const row = await sqlRow<{ scope_model: string }>("SELECT scope_model FROM boost_quotes WHERE id = $1", [retried.id]);
  assert.equal(row.scope_model, "autre produit", "le devis est écrit pour le périmètre actuel de l'offre");
});

test("devis (lot P3) : un créneau de calcul manquant → quote_busy (503 côté HTTP) sans rien écrire ; créneau libéré, le devis aboutit", async () => {
  await wipe();
  const offer = await makeOffer();
  for (let index = 0; index < 2; index++) await addBuyer(offer, { listSize: 7 });
  const gate = createReachGate(1);
  const second = (await distinctPools(1))[0];
  let release!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  let inReach!: () => void;
  const entered = new Promise<void>((resolve) => { inReach = resolve; });
  const first = quote(offer, "24h", pool, { reachGate: gate, beforeReachDemand: async (index) => { if (index === 0) { inReach(); await hold; } } });
  await entered;
  assert.deepEqual(gate.stats(), { active: 1, waiting: 0 });
  const refused = await code(quote(offer, "3d", second, { reachGate: gate, reachQueueWaitMs: 50 }));
  assert.equal(refused, "quote_busy");
  assert.equal((await second.query<{ n: number }>("SELECT count(*)::int AS n FROM boost_quotes")).rows[0].n, 0, "le refus n'écrit rien");
  release();
  assert.equal((await first).status, "available");
  assert.deepEqual(gate.stats(), { active: 0, waiting: 0 }, "le créneau est libéré (aussi après un refus)");
  assert.equal((await quote(offer, "3d", second, { reachGate: gate })).status, "available");
});

test("devis réutilisé revérifié (lot P3-bis, N1) : atteignable → même devis ; plus atteignable (démontré) → devis neuf INDISPONIBLE, jamais le même « disponible », sans boucle ; revérification non terminée → reach_check_unavailable, rien d'écrit ni modifié ; la portée revenue, le devis d'origine redevient réutilisable", async () => {
  await wipe();
  const offer = await makeOffer();
  await addBuyer(offer, { listSize: 7 });
  const first = await quote(offer);
  assert.deepEqual([first.status, first.inputs.reachableBuyers, first.reused], ["available", 1, false]);
  const same = await quote(offer);
  assert.deepEqual([same.id, same.reused, same.status], [first.id, true, "available"], "portée intacte : réutilisé");
  const stored = () => sqlRow<Record<string, unknown>>("SELECT * FROM boost_quotes WHERE id = $1", [first.id]);
  const snapshot = await stored();
  const total = () => sqlRow<{ n: number }>("SELECT count(*)::int AS n FROM boost_quotes").then((row) => row.n);
  assert.equal(await total(), 1);

  // Vérification NON TERMINÉE (budget épuisé avant le premier besoin) : 503, le devis d'origine n'est ni renvoyé, ni modifié, et rien n'est écrit.
  let t = 0;
  assert.equal(await code(quote(offer, "24h", pool, { reuseReachBudgetMs: 40, reachClock: () => (t += 50) })), "reach_check_unavailable");
  assert.equal(await total(), 1, "aucun devis écrit");
  assert.deepEqual(await stored(), snapshot, "le devis d'origine est intact");

  // La place disparaît (part promue ramenée à 5 % : floor(0,05 × 7) = 0) : portée DÉMONTRÉE nulle → devis neuf indisponible, pas le même « disponible ».
  await setBoostSettings("smartphones", { max_promoted_share: 0.05 });
  const stale = await quote(offer);
  assert.notEqual(stale.id, first.id, "le devis périmé n'est plus rendu");
  assert.deepEqual([stale.status, stale.unavailableReason, stale.amount, stale.inputs.reachableBuyers, stale.inputs.reachTruncated, stale.reused], ["unavailable", "no_visible_effect", null, 0, false, false]);
  assert.equal(await total(), 2);
  // Pas de boucle : l'indisponible (60 s) est ensuite renvoyé tel quel, rien n'est recalculé ni écrit.
  const loop = await quote(offer);
  assert.deepEqual([loop.id, loop.status, loop.reused], [stale.id, "unavailable", true]);
  assert.equal(await total(), 2);
  assert.deepEqual(await stored(), snapshot, "le devis d'origine reste immuable");

  // La portée revient et l'indisponible échoit : le devis d'origine, encore valable, est revérifié atteignable et renvoyé.
  await resetBoostSettings();
  await expire(stale.id);
  const back = await quote(offer);
  assert.deepEqual([back.id, back.reused, back.status], [first.id, true, "available"]);
  assert.equal(await total(), 2);
});

test("devis réutilisé (lot M1, D6) : « atteignable » gardé 10 s PAR DEVIS (aucune revérification pendant ce temps, même si la portée a disparu), puis revérifié ; « non atteignable » n'est jamais retenu ; un autre devis n'est pas couvert", async () => {
  await wipe();
  const offer = await makeOffer();
  await addBuyer(offer, { listSize: 7 });
  let now = 1_000;
  const guard = createReuseRecheckGuard({ now: () => now });
  let rechecks = 0;
  const hooks: BoostQuoteTestHooks = { reuseRecheckGuard: guard, beforeReachDemand: () => { rechecks += 1; } };
  const first = await quote(offer, "24h", pool, hooks);
  assert.equal(first.reused, false);
  rechecks = 0;
  // 1re réutilisation : revérifiée (la mémoire est vide), atteignable → retenue.
  const second = await quote(offer, "24h", pool, hooks);
  assert.deepEqual([second.id, second.reused], [first.id, true]);
  assert.equal(rechecks, 1, "une revérification calculée");
  assert.equal(guard.size().quotes, 1);
  // La portée disparaît (part promue ramenée à 5 % : plus aucune place). Pendant 10 s la mémoire répond : aucune revérification, même devis.
  await setBoostSettings("smartphones", { max_promoted_share: 0.05 });
  now += 9_999;
  const cached = await quote(offer, "24h", pool, hooks);
  assert.deepEqual([cached.id, cached.reused, cached.status], [first.id, true, "available"]);
  assert.equal(rechecks, 1, "dans les 10 s : aucune nouvelle revérification");
  // À 10 s pile : la mémoire est périmée, la revérification a lieu et DÉMONTRE que la portée a disparu : devis neuf indisponible.
  now += 1;
  const stale = await quote(offer, "24h", pool, hooks);
  assert.equal(rechecks, 2, "après 10 s : revérifié");
  assert.notEqual(stale.id, first.id);
  assert.deepEqual([stale.status, stale.unavailableReason], ["unavailable", "no_visible_effect"]);
  assert.equal(guard.size().quotes, 0, "un résultat non atteignable n'est jamais retenu (et le périmé a été oublié)");
  // L'indisponible est réutilisé tel quel (aucune revérification : seuls les devis « disponibles » sont revérifiés).
  const loop = await quote(offer, "24h", pool, hooks);
  assert.deepEqual([loop.id, loop.status, loop.reused], [stale.id, "unavailable", true]);
  assert.equal(rechecks, 2);
  // Un AUTRE devis (autre durée) n'est pas couvert par la mémoire du premier : il est revérifié.
  await resetBoostSettings();
  const other = await quote(offer, "3d", pool, hooks);
  assert.equal(other.reused, false);
  const before = rechecks;
  const otherAgain = await quote(offer, "3d", pool, hooks);
  assert.deepEqual([otherAgain.id, otherAgain.reused], [other.id, true]);
  assert.equal(rechecks, before + 1, "le devis de 3 jours est revérifié une fois (mémoire propre à chaque devis)");
  const otherCached = await quote(offer, "3d", pool, hooks);
  assert.equal(otherCached.id, other.id);
  assert.equal(rechecks, before + 1, "puis mémorisé 10 s");
  // Un résultat INDÉTERMINÉ (budget épuisé avant le premier besoin) n'est jamais retenu non plus : la garde reste vide et le même devis est revérifié ensuite.
  const fresh = createReuseRecheckGuard({ now: () => now });
  let tick = 0;
  assert.equal(await code(quote(offer, "3d", pool, { reuseRecheckGuard: fresh, reuseReachBudgetMs: 40, reachClock: () => (tick += 50) })), "reach_check_unavailable");
  assert.equal(fresh.size().quotes, 0, "indéterminé : rien de retenu");
  rechecks = 0;
  const afterwards = await quote(offer, "3d", pool, { reuseRecheckGuard: fresh, beforeReachDemand: () => { rechecks += 1; } });
  assert.deepEqual([afterwards.id, afterwards.reused], [other.id, true]);
  assert.equal(rechecks, 1, "revérifié");
});

test("devis réutilisé (lot M1, D6) : les revérifications comptent dans une limite de 60 par vendeur et par minute (rate_limited au-delà, aucune revérification calculée) ; un autre vendeur n'est pas touché ; la fenêtre glisse", async () => {
  await wipe();
  const offer = await makeOffer();
  await addBuyer(offer, { listSize: 7 });
  const rival = await makeOffer();
  await addBuyer(rival, { listSize: 7 });
  let now = 5_000;
  // Pas de mémoire (ttl 0) : chaque réutilisation est une revérification, donc comptée.
  const guard = createReuseRecheckGuard({ now: () => now, ttlMs: 0 });
  let rechecks = 0;
  const hooks: BoostQuoteTestHooks = { reuseRecheckGuard: guard, beforeReachDemand: () => { rechecks += 1; } };
  const created = await quote(offer, "24h", pool, hooks);
  const rivalQuote = await quote(rival, "24h", pool, hooks);
  rechecks = 0;
  for (let index = 0; index < 60; index++) {
    const again = await quote(offer, "24h", pool, hooks);
    assert.deepEqual([again.id, again.reused], [created.id, true], `revérification n° ${index + 1}`);
    now += 10;
  }
  assert.equal(rechecks, 60);
  assert.equal(await code(quote(offer, "24h", pool, hooks)), "rate_limited", "la 61e est refusée");
  assert.equal(rechecks, 60, "le refus ne calcule rien");
  // Un autre vendeur : sa propre limite.
  assert.deepEqual([(await quote(rival, "24h", pool, hooks)).id, rechecks], [rivalQuote.id, 61]);
  // Un devis NEUF (calculé) n'est pas une revérification : la limite de 20 devis par minute est celle de `assertQuoteRate`, pas celle-ci.
  // La fenêtre glisse : une minute après les premières revérifications, de nouveau permis.
  now += 60_000;
  assert.equal((await quote(offer, "24h", pool, hooks)).reused, true);
  assert.equal(rechecks, 62);
});

test("devis réutilisé (lot M1, D6) : la garde du PROCESSUS est celle des devis réels (par défaut) ; ses compteurs sont bornés en mémoire", async () => {
  // Par défaut (aucun hook) : la garde du processus compte et mémorise.
  await wipe();
  const offer = await makeOffer();
  await addBuyer(offer, { listSize: 7 });
  const created = await quoteOfferBoost({ pool, ownerId: offer.ownerId, offerId: offer.id, durationCode: "24h" });
  const reused = await quoteOfferBoost({ pool, ownerId: offer.ownerId, offerId: offer.id, durationCode: "24h" });
  assert.deepEqual([reused.id, reused.reused], [created.id, true]);
  assert.equal(processReuseRecheckGuard.isFresh(created.id), true, "mémorisé par la garde du processus");
  // Bornes : une garde de 3 entrées ne grandit jamais au-delà.
  const small = createReuseRecheckGuard({ now: () => 0, maxEntries: 3 });
  for (let index = 0; index < 20; index++) { small.remember(`q${index}`); small.tryAcquire(`s${index}`); }
  assert.ok(small.size().quotes <= 3 && small.size().sellers <= 3, JSON.stringify(small.size()));
});

test("devis (lot P3-bis, N3) : une vérification non terminée n'écrit AUCUN devis (rien n'est réutilisé 60 s) ; la demande suivante calcule normalement ; no_visible_effect n'est écrit que s'il est démontré", async () => {
  await wipe();
  const offer = await makeOffer();
  for (let index = 0; index < 3; index++) await addBuyer(offer, { listSize: 7 });
  const total = () => sqlRow<{ n: number }>("SELECT count(*)::int AS n FROM boost_quotes").then((row) => row.n);
  // Budget épuisé avant le premier besoin, puis en cours de route sans acheteur trouvé : dans les deux cas 503, aucune ligne.
  let t = 0;
  assert.equal(await code(quote(offer, "24h", pool, { reachBudgetMs: 40, reachClock: () => (t += 50) })), "reach_check_unavailable");
  assert.equal(await total(), 0);
  // Statement_timeout réel : une lecture du classement plus longue que le délai est interrompue → même refus, rien d'écrit.
  assert.equal(await code(quote(offer, "24h", slowReachPool(pool))), "reach_check_unavailable");
  assert.equal(await total(), 0, "délai d'une requête dépassé : aucun devis écrit");
  // La demande suivante (sans lenteur) calcule et écrit un devis disponible : rien d'indéterminé n'a été mis en cache.
  const ok = await quote(offer);
  assert.deepEqual([ok.status, ok.reused, ok.inputs.reachableBuyers], ["available", false, 3]);
  assert.equal(await total(), 1);
  // Démontré : une liste courte, aucune interruption → no_visible_effect écrit (et réutilisé 60 s).
  await wipe();
  const lonely = await makeOffer();
  await addBuyer(lonely, { listSize: 1 });
  const demonstrated = await quote(lonely);
  assert.deepEqual([demonstrated.status, demonstrated.unavailableReason], ["unavailable", "no_visible_effect"]);
  assert.equal((await quote(lonely)).id, demonstrated.id);
});

test("limite de débit (lot P3) : 20 devis CALCULÉS par vendeur et par minute → le 21e est refusé (rate_limited) sans rien écrire ; une cotation réutilisée n'est pas comptée ; un autre vendeur n'est pas touché ; la fenêtre glisse", async () => {
  assert.equal(BOOST_QUOTE_RATE_LIMIT, 20);
  await wipe();
  const seller = await makeUser();
  const offers: OfferRecord[] = [];
  for (let index = 0; index < 7; index++) offers.push(await makeOffer({ ownerId: seller }));
  const buyer = await addBuyer(offers[0], { listSize: 7 });
  void buyer;
  const durations = ["24h", "3d", "7d"] as const;
  const plan = offers.flatMap((offer) => durations.map((duration) => ({ offer, duration })));
  assert.equal(plan.length, 21);
  for (const { offer, duration } of plan.slice(0, 20)) assert.notEqual(await code(quote(offer, duration)), "rate_limited");
  assert.equal((await sqlRow<{ n: number }>("SELECT count(*)::int AS n FROM boost_quotes")).n, 20);
  // Le 21e calcul : refusé, rien d'écrit.
  const last = plan[20];
  assert.equal(await code(quote(last.offer, last.duration)), "rate_limited");
  assert.equal((await sqlRow<{ n: number }>("SELECT count(*)::int AS n FROM boost_quotes")).n, 20);
  // Une cotation encore valable est renvoyée telle quelle (aucun calcul, donc aucune limite).
  const reused = await quote(plan[0].offer, plan[0].duration);
  assert.equal(reused.reused, true);
  // Un autre vendeur n'est pas concerné.
  const other = await makeOffer();
  assert.notEqual(await code(quote(other, "24h")), "rate_limited");
  // La fenêtre est glissante : des devis vieux de plus d'une minute ne comptent plus.
  await pool.query("UPDATE boost_quotes SET computed_at = computed_at - interval '2 minutes', expires_at = expires_at - interval '2 minutes' WHERE seller_id = $1", [seller]);
  assert.notEqual(await code(quote(last.offer, last.duration)), "rate_limited");
});

test("limite de débit (lot P3) : 30 demandes SIMULTANÉES du même vendeur (offres et durées distinctes) → exactement 20 devis écrits, 10 refus rate_limited (le verrou du vendeur rend le compte exact)", async () => {
  await wipe();
  const seller = await makeUser();
  const offers: OfferRecord[] = [];
  for (let index = 0; index < 10; index++) offers.push(await makeOffer({ ownerId: seller }));
  await addBuyer(offers[0], { listSize: 7 });
  const concurrentPool = new Pool({ connectionString: target.connectionString, max: 12, options: `-c search_path=${schema}`, application_name: APPLICATION });
  extraPools.push(concurrentPool);
  const plan = offers.flatMap((offer) => (["24h", "3d", "7d"] as const).map((duration) => ({ offer, duration })));
  const outcomes = await Promise.all(plan.map(({ offer, duration }) => code(quote(offer, duration, concurrentPool))));
  assert.equal(outcomes.filter((outcome) => outcome === "rate_limited").length, 10, outcomes.join(","));
  assert.equal(outcomes.filter((outcome) => outcome === "ok").length, 20, outcomes.join(","));
  assert.equal((await sqlRow<{ n: number }>("SELECT count(*)::int AS n FROM boost_quotes")).n, 20, "exactement 20 devis écrits");
  // Le verrou du vendeur n'est tenu que pendant l'écriture : aucun reste après coup.
  assert.deepEqual(await ownAdvisoryLocks(pool, APPLICATION, [BOOST_QUOTE_RATE_NAMESPACE]), []);
});

test("migration 0017 (lot P3) : reach_truncated booléen (NULL permis, seulement avec reachable_buyers), index (vendeur, calculé le) présent", async () => {
  await wipe();
  const offer = await makeOffer();
  const base = { offerId: offer.id, sellerId: offer.ownerId };
  const column = await sqlRow<{ data_type: string; is_nullable: string }>(
    "SELECT data_type, is_nullable FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'boost_quotes' AND column_name = 'reach_truncated'", [schema]);
  assert.deepEqual(column, { data_type: "boolean", is_nullable: "YES" });
  const index = await sqlRow<{ indexdef: string }>("SELECT indexdef FROM pg_indexes WHERE schemaname = $1 AND indexname = 'idx_boost_quotes_seller_computed'", [schema]);
  assert.match(index.indexdef, /\(seller_id, computed_at DESC\)/);
  await insertQuote({ ...base, buyers: 3, reachable: 3 });
  await pool.query("UPDATE boost_quotes SET reach_truncated = TRUE WHERE reachable_buyers = 3");
  await insertQuote({ ...base, buyers: 3, reachable: null, duration: "3d" });
  await assert.rejects(pool.query("UPDATE boost_quotes SET reach_truncated = TRUE WHERE duration_code = '3d'"), /chk_boost_quotes_reach_truncated/, "drapeau renseigné sans portée évaluée : refusé");
  await pool.query("UPDATE boost_quotes SET reach_truncated = FALSE WHERE reachable_buyers = 3");
  await pool.query("UPDATE boost_quotes SET reach_truncated = TRUE WHERE reachable_buyers = 3");
  assert.equal((await sqlRow<{ n: number }>("SELECT count(*)::int AS n FROM boost_quotes WHERE reach_truncated IS TRUE")).n, 1);
});

test("portée visible : une évaluation illisible n'empêche pas la cotation — ce besoin est écarté, les autres comptent ; si tous sont illisibles, aucun effet visible (jamais une erreur)", async () => {
  await wipe();
  const offer = await makeOffer();
  const bad = await addBuyer(offer, { listSize: 7 });
  await pool.query("UPDATE matching_evaluations SET evaluation_summary = '{}'::jsonb WHERE id = $1", [bad.evaluationId]);
  const silenced = console.error;
  const messages: string[] = [];
  console.error = (...args: unknown[]) => { messages.push(args.join(" ")); };
  try {
    const onlyBad = await quote(offer);
    assert.deepEqual([onlyBad.status, onlyBad.unavailableReason, onlyBad.inputs.reachableBuyers], ["unavailable", "no_visible_effect", 0]);
    assert.ok(messages.some((message) => /portée ignorée pour un besoin \(stored_match_corrupt_evaluation_summary\)/.test(message)), messages.join("|"));
    assert.equal(messages.join("|").includes(bad.buyerId), false, "aucun identifiant dans le journal");
    await addBuyer(offer, { listSize: 7 });
    await pool.query("DELETE FROM boost_quotes");
    const mixed = await quote(offer);
    assert.deepEqual([mixed.status, mixed.inputs.compatibleBuyers, mixed.inputs.reachableBuyers], ["available", 2, 1]);
  } finally { console.error = silenced; }
});

test("migration 0016 : reachable_buyers (entier, NULL permis), motif no_visible_effect accepté, bornes et cohérence imposées par la base", async () => {
  await wipe();
  const offer = await makeOffer();
  const base = { offerId: offer.id, sellerId: offer.ownerId };
  const column = await sqlRow<{ data_type: string; is_nullable: string }>(
    "SELECT data_type, is_nullable FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'boost_quotes' AND column_name = 'reachable_buyers'", [schema]);
  assert.deepEqual(column, { data_type: "integer", is_nullable: "YES" });
  const refuse = (constraint: string, fields: Partial<QuoteFields>) =>
    assert.rejects(insertQuote({ ...base, ...fields }), new RegExp(constraint), `${constraint} ${JSON.stringify(fields)}`);
  await refuse("chk_boost_quotes_reachable_range", { buyers: 1, reachable: 2 });
  await refuse("chk_boost_quotes_reachable_range", { status: "unavailable", reason: "no_slot_available", buyers: 1, reachable: -1 });
  await refuse("chk_boost_quotes_reachable_available", { buyers: 1, reachable: 0 });
  await refuse("chk_boost_quotes_reachable_no_effect", { status: "unavailable", reason: "no_visible_effect", buyers: 1, reachable: 1 });
  await refuse("chk_boost_quotes_reachable_no_effect", { status: "unavailable", reason: "no_visible_effect", buyers: 1, reachable: null });
  await refuse("chk_boost_quotes_reason", { status: "unavailable", reason: "no_effect" });
  // Cas acceptés : NULL (devis d'avant 0016 ou non évalué), borne haute, aucun effet visible avec 0 atteignable.
  await insertQuote({ ...base });
  await insertQuote({ ...base, buyers: 3, reachable: 3 });
  await insertQuote({ ...base, buyers: 3, reachable: 1 });
  await insertQuote({ ...base, status: "unavailable", reason: "no_visible_effect", buyers: 2, reachable: 0 });
  await insertQuote({ ...base, status: "unavailable", reason: "no_compatible_buyer", reachable: 0 });
  await insertQuote({ ...base, status: "unavailable", reason: "no_slot_available", buyers: 2, reachable: null });
  assert.equal((await sqlRow<{ n: number }>("SELECT count(*)::int AS n FROM boost_quotes WHERE reachable_buyers IS NULL")).n, 2);
  // L'historique relit un devis ancien (NULL) comme « non évalué ».
  const history = await listOfferBoostQuotes({ pool, ownerId: offer.ownerId, offerId: offer.id, limit: 10 });
  assert.equal(history.length, 6);
  assert.ok(history.some((entry) => entry.inputs.reachableBuyers === null));
  assert.ok(history.some((entry) => entry.inputs.reachableBuyers === 3));
});

// ═════════════ 12. Script boost:quote ═════════════

const QUOTE = "scripts/boost-quote.ts";

test("script boost:quote : 0 pour une cotation disponible ou indisponible, 1 pour un refus ou une erreur, textes fixes, aucun message brut", async () => {
  const { offer, own } = await controlWorld();
  const first = await runScript(QUOTE, ["--offer", offer.id, "--duration", "3d"], schema);
  assert.equal(first.code, 0, first.output);
  assert.equal(first.output.trim().split("\n").length, 1);
  assert.match(first.output.trim(), /^Cotation \(administration\) : [0-9a-f-]{36}, durée 3d, DISPONIBLE 2500 XOF \(brut 2472\.715000000000\)\. Facteurs \(millièmes\) : concurrence 1060, demande 1400, rareté 1333, durée 2500\. Comptages : vendeurs concurrents 3, acheteurs compatibles 4, acheteurs qui verraient l'offre monter 4, places 1\/3\. Réglages default v1\. Cotation calculée le \d{4}-.*, valable jusqu'au \d{4}-.*\.$/);
  const again = await runScript(QUOTE, ["--offer", offer.id, "--duration", "3d"], schema);
  assert.equal(again.code, 0);
  assert.match(again.output, /\(cotation réutilisée\)/);
  assert.equal((await sqlRow<{ n: number }>("SELECT count(*)::int AS n FROM boost_quotes")).n, 1);

  // Indisponible : code 0 aussi (une cotation est renvoyée).
  const unavailable = await runScript(QUOTE, ["--offer", own[1].id, "--duration", "24h"], schema);
  assert.equal(unavailable.code, 0, unavailable.output);
  assert.match(unavailable.output, /INDISPONIBLE \(no_compatible_buyer\)\. Comptages : vendeurs concurrents 3, acheteurs compatibles 0, acheteurs qui verraient l'offre monter 0, places 1\/3/);

  // Refus de domaine : code 1, texte fixe.
  const unknown = await runScript(QUOTE, ["--offer", randomUUID(), "--duration", "24h"], schema);
  assert.equal(unknown.code, 1);
  assert.equal(unknown.output.trim(), "Cotation (administration) : refus offer_not_found (Offre introuvable.)");
  const incomplete = await makeOffer({ model: null });
  const notBoostable = await runScript(QUOTE, ["--offer", incomplete.id, "--duration", "24h"], schema);
  assert.equal(notBoostable.code, 1);
  assert.match(notBoostable.output, /refus offer_not_boostable/);
  const draft = await makeOffer({ status: "draft" });
  assert.match((await runScript(QUOTE, ["--offer", draft.id, "--duration", "24h"], schema)).output, /refus offer_not_eligible/);

  // Arguments invalides : code 1, usage, aucune écriture.
  const countBefore = (await sqlRow<{ n: number }>("SELECT count(*)::int AS n FROM boost_quotes")).n;
  const bad: string[][] = [
    [], ["--offer", offer.id], ["--duration", "24h"], ["--offer", "pas-un-uuid", "--duration", "24h"], ["--offer", offer.id, "--duration", "30d"],
    ["--offer", offer.id, "--duration", "24h", "--pay", "1"], ["--offer", offer.id, "--offer", own[1].id, "--duration", "24h"], ["--offer", offer.id, "--duration"],
  ];
  for (const args of bad) {
    const result = await runScript(QUOTE, args, schema);
    assert.equal(result.code, 1, JSON.stringify(args) + result.output);
    assert.match(result.output, /^Cotation \(administration\) : .*Usage : npm run boost:quote/m, JSON.stringify(args));
  }
  assert.equal((await sqlRow<{ n: number }>("SELECT count(*)::int AS n FROM boost_quotes")).n, countBefore);

  const noUrl = await runScript(QUOTE, ["--offer", offer.id, "--duration", "24h"], schema, { DATABASE_URL: "" });
  assert.equal(noUrl.code, 1);
  assert.match(noUrl.output, /DATABASE_URL est requis/);
  const missing = await runScript(QUOTE, ["--offer", offer.id, "--duration", "24h"], emptySchema);
  assert.equal(missing.code, 1);
  assert.equal(missing.output.trim(), "Cotation (administration) : erreur 42P01.");

  // Réglages tarifaires absents : refus de domaine, code 1.
  await pool.query("DELETE FROM boost_quotes");
  const saved = (await pool.query("SELECT * FROM boost_pricing_settings")).rows[0];
  await pool.query("DELETE FROM boost_pricing_settings");
  try {
    const noPricing = await runScript(QUOTE, ["--offer", offer.id, "--duration", "24h"], schema);
    assert.equal(noPricing.code, 1);
    assert.match(noPricing.output, /refus boost_pricing_missing/);
  } finally { await insertPricing(saved.key, saved.version); }

  for (const output of [first.output, unavailable.output, unknown.output, notBoostable.output, noUrl.output, missing.output]) {
    for (const forbidden of ["RAW_SECRET_TEXT", "postgres://", "noma_local", "SELECT", "relation", "boost_quotes"]) {
      assert.ok(!output.includes(forbidden), `fuite « ${forbidden} » dans : ${output}`);
    }
  }
  await wipe();
});
