import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { Pool } from "pg";
import { createOffer, createUser } from "../../lib/server/catalog";
import { CatalogValidationError } from "../../lib/server/catalog/errors";
import type { OfferRecord } from "../../lib/server/catalog/types";
import {
  BoostError, cancelOfferBoost, grantOfferBoost, readBoostSettings, readBoostSlots, readEffectiveBoostedOfferIds,
  type BoostErrorCode, type BoostSettings,
} from "../../lib/server/boost/boosts";
import { runMigrations } from "../../lib/server/postgres/migrations";
import { runScript } from "./run-script";
import {
  createTemporarySchemaName, openVerifiedIsolatedPool, openVerifiedTestDatabase, quoteTemporarySchema,
  type DedicatedTestDatabase,
} from "./test-database";

const schema = createTemporarySchemaName();
const quoted = quoteTemporarySchema(schema);
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
  pool = await openVerifiedIsolatedPool(target, schema);
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

const makeSeller = async (): Promise<string> => (await createUser({}, pool)).id;

async function makeOffer(input: OfferInput = {}): Promise<OfferRecord> {
  counter += 1;
  const has = <K extends keyof OfferInput>(key: K) => key in input;
  return createOffer({
    ownerId: input.ownerId ?? await makeSeller(),
    rawText: `RAW_SECRET_TEXT offre ${counter}`,
    category: has("category") ? input.category : "smartphones",
    brand: has("brand") ? input.brand : "Apple",
    model: has("model") ? input.model : "iPhone 13",
    price: { amount: 100_000 + counter, currency: "XOF" },
    status: input.status ?? "published",
    availabilityStatus: input.availability === undefined ? "available" : input.availability,
  }, pool);
}

const wipe = () => pool.query("TRUNCATE offer_boosts, matching_evaluations, matching_jobs, matching_outbox_events, demands, offers CASCADE");

const grant = (offer: OfferRecord, durationCode: "24h" | "3d" | "7d" = "24h", db: Pool = pool, hooks?: { beforeInsert?: () => Promise<void> | void }) =>
  grantOfferBoost({ pool: db, offerId: offer.id, ownerId: offer.ownerId, durationCode, source: "admin_grant", hooks });

async function code(promise: Promise<unknown>): Promise<BoostErrorCode | "ok" | string> {
  try { await promise; return "ok"; } catch (error) {
    if (error instanceof BoostError) return error.code;
    return `${(error as Error).name}: ${(error as Error).message}`;
  }
}

const setSettings = (key: string, values: Partial<Record<string, number>>) => {
  const merged = { slot_ratio: 0.15, min_slots: 1, max_slots: 50, max_active_per_seller: 2, max_seller_slot_share: 0.34, max_promoted_share: 0.15, min_relevance: 60, ...values };
  return pool.query(
    `INSERT INTO boost_settings (key, slot_ratio, min_slots, max_slots, max_active_per_seller, max_seller_slot_share, max_promoted_share, min_relevance)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (key) DO UPDATE SET slot_ratio = $2, min_slots = $3, max_slots = $4, max_active_per_seller = $5,
       max_seller_slot_share = $6, max_promoted_share = $7, min_relevance = $8`,
    [key, merged.slot_ratio, merged.min_slots, merged.max_slots, merged.max_active_per_seller, merged.max_seller_slot_share, merged.max_promoted_share, merged.min_relevance]);
};

const sqlRow = async <T extends Record<string, unknown>>(text: string, values: unknown[] = []): Promise<T> => (await pool.query<T>(text, values)).rows[0];

// ═════════════ 1. Migration 0011 ═════════════

test("migration 0011 : appliquée sur un schéma temporaire, la relance l'ignore, la ligne par défaut est insérée", async () => {
  const first = firstMigration;
  assert.equal(first.applied.length, 26);
  assert.equal(first.applied.at(-1), "0026_sublymus_payments")
  assert.ok(first.applied.includes("0011_offer_boosts"));
  assert.ok(first.applied.includes("0010_matching_job_leases"));
  const rerun = await runMigrations(pool);
  assert.deepEqual(rerun.applied, []);
  assert.equal(rerun.skipped.length, 26);
  assert.equal(rerun.skipped.at(-1), "0026_sublymus_payments");

  const rows = (await pool.query("SELECT key, slot_ratio::text, min_slots, max_slots, max_active_per_seller, max_seller_slot_share::text, max_promoted_share::text, min_relevance::text FROM boost_settings")).rows;
  assert.deepEqual(rows, [{
    key: "default", slot_ratio: "0.150", min_slots: 1, max_slots: 50, max_active_per_seller: 2,
    max_seller_slot_share: "0.340", max_promoted_share: "0.150", min_relevance: "60.00",
  }]);
  assert.equal((await sqlRow<{ n: number }>("SELECT count(*)::int AS n FROM offer_boosts")).n, 0);
});

const insertSettings = (key: string, overrides: Record<string, unknown> = {}) => {
  const row = { key, slot_ratio: 0.15, min_slots: 1, max_slots: 50, max_active_per_seller: 2, max_seller_slot_share: 0.34, max_promoted_share: 0.15, min_relevance: 60, ...overrides };
  return pool.query(
    `INSERT INTO boost_settings (key, slot_ratio, min_slots, max_slots, max_active_per_seller, max_seller_slot_share, max_promoted_share, min_relevance)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [row.key, row.slot_ratio, row.min_slots, row.max_slots, row.max_active_per_seller, row.max_seller_slot_share, row.max_promoted_share, row.min_relevance]);
};

test("migration 0011 : boost_settings, chaque CHECK refuse son cas et accepte sa borne", async () => {
  const cases: Array<[string, string, Record<string, unknown>, Record<string, unknown> | null]> = [
    ["chk_boost_settings_key", "Majuscule", {}, null],
    ["chk_boost_settings_key", "", {}, null],
    ["chk_boost_settings_key", " espace", {}, null],
    ["chk_boost_settings_slot_ratio", "k-ratio-zero", { slot_ratio: 0 }, { slot_ratio: 0.001 }],
    ["chk_boost_settings_slot_ratio", "k-ratio-haut", { slot_ratio: 0.501 }, { slot_ratio: 0.5 }],
    ["chk_boost_settings_min_slots", "k-min-negatif", { min_slots: -1 }, { min_slots: 0 }],
    ["chk_boost_settings_max_slots", "k-max-sous-min", { min_slots: 5, max_slots: 4 }, { min_slots: 5, max_slots: 5 }],
    ["chk_boost_settings_max_active_per_seller", "k-vendeur-zero", { max_active_per_seller: 0 }, { max_active_per_seller: 1 }],
    ["chk_boost_settings_max_seller_slot_share", "k-part-vendeur-zero", { max_seller_slot_share: 0 }, { max_seller_slot_share: 0.001 }],
    ["chk_boost_settings_max_seller_slot_share", "k-part-vendeur-haute", { max_seller_slot_share: 1.001 }, { max_seller_slot_share: 1 }],
    ["chk_boost_settings_max_promoted_share", "k-promu-zero", { max_promoted_share: 0 }, { max_promoted_share: 0.001 }],
    ["chk_boost_settings_max_promoted_share", "k-promu-haut", { max_promoted_share: 0.201 }, { max_promoted_share: 0.2 }],
    ["chk_boost_settings_min_relevance", "k-pertinence-negative", { min_relevance: -0.01 }, { min_relevance: 0 }],
    ["chk_boost_settings_min_relevance", "k-pertinence-haute", { min_relevance: 100.01 }, { min_relevance: 100 }],
  ];
  for (const [constraint, key, bad, good] of cases) {
    await assert.rejects(insertSettings(key, bad), new RegExp(constraint), `${constraint} ${JSON.stringify(bad)}`);
    if (good) await insertSettings(`${key}-ok`, good);
  }
  await assert.rejects(insertSettings("default"), /boost_settings_pkey/, "clé primaire");
  await pool.query("DELETE FROM boost_settings WHERE key <> 'default'");
});

interface BoostFields { id?: string; offerId: string; sellerId: string; category?: string; brand?: string; model?: string; status?: string; duration?: string;
  startsAt?: string; endsAt?: string; source?: string; cancelledAt?: string | null }

const insertBoost = (fields: BoostFields) => pool.query(
  `INSERT INTO offer_boosts (id, offer_id, seller_id, scope_category, scope_brand, scope_model, status, duration_code, starts_at, ends_at, source, cancelled_at)
   VALUES ($1,$2,$3,$4,$5,$6,$7,$8, COALESCE($9::timestamptz, clock_timestamp()), COALESCE($10::timestamptz, clock_timestamp() + interval '1 day'), $11, $12)`,
  [fields.id ?? randomUUID(), fields.offerId, fields.sellerId, fields.category ?? "smartphones", fields.brand ?? "apple", fields.model ?? "iphone 13",
    fields.status ?? "active", fields.duration ?? "24h", fields.startsAt ?? null, fields.endsAt ?? null, fields.source ?? "admin_grant", fields.cancelledAt ?? null]);

test("migration 0011 : offer_boosts, chaque CHECK, les clés étrangères et l'index unique partiel refusent leur cas", async () => {
  await wipe();
  const offer = await makeOffer();
  const other = await makeOffer();
  const base = { offerId: offer.id, sellerId: offer.ownerId };
  const expectRefusal = (constraint: string, fields: Partial<BoostFields>) =>
    assert.rejects(insertBoost({ ...base, ...fields }), new RegExp(constraint), `${constraint} ${JSON.stringify(fields)}`);

  await expectRefusal("chk_offer_boosts_scope_normalized", { category: "Smartphones" });
  await expectRefusal("chk_offer_boosts_scope_normalized", { brand: " apple" });
  await expectRefusal("chk_offer_boosts_scope_normalized", { model: "IPHONE 13" });
  await expectRefusal("chk_offer_boosts_scope_normalized", { category: "" });
  await expectRefusal("chk_offer_boosts_scope_normalized", { brand: "" });
  await expectRefusal("chk_offer_boosts_scope_normalized", { model: "" });
  await expectRefusal("chk_offer_boosts_status", { status: "pending" });
  await expectRefusal("chk_offer_boosts_duration_code", { duration: "30d" });
  await expectRefusal("chk_offer_boosts_duration_code", { duration: "24H" });
  await expectRefusal("chk_offer_boosts_period", { startsAt: "2032-01-01T00:00:00Z", endsAt: "2032-01-01T00:00:00Z" });
  await expectRefusal("chk_offer_boosts_period", { startsAt: "2032-01-02T00:00:00Z", endsAt: "2032-01-01T00:00:00Z" });
  await expectRefusal("chk_offer_boosts_source", { source: "payment" });
  await expectRefusal("chk_offer_boosts_cancelled_at", { status: "cancelled", cancelledAt: null });
  await expectRefusal("chk_offer_boosts_cancelled_at", { status: "active", cancelledAt: "2032-01-01T00:00:00Z" });
  await expectRefusal("chk_offer_boosts_cancelled_at", { status: "expired", cancelledAt: "2032-01-01T00:00:00Z" });
  await expectRefusal("offer_boosts_offer_id_fkey", { offerId: randomUUID() });
  await expectRefusal("offer_boosts_seller_id_fkey", { sellerId: randomUUID() });

  // Cas acceptés.
  await insertBoost({ ...base, status: "cancelled", cancelledAt: "2032-01-01T00:00:00Z" });
  await insertBoost({ ...base, status: "expired" });
  await insertBoost({ ...base, status: "active" });
  // Index unique partiel : un seul boost actif par offre, mais autant d'annulés ou d'expirés que l'on veut.
  await assert.rejects(insertBoost({ ...base, status: "active" }), /uq_offer_boosts_active_offer/);
  await insertBoost({ ...base, status: "expired" });
  await insertBoost({ offerId: other.id, sellerId: other.ownerId, status: "active" });

  const indexes = (await pool.query<{ indexname: string; indexdef: string }>(
    "SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = $1 AND tablename = 'offer_boosts' ORDER BY indexname", [schema])).rows;
  const byName = new Map(indexes.map((row) => [row.indexname, row.indexdef]));
  assert.match(byName.get("uq_offer_boosts_active_offer") ?? "", /UNIQUE INDEX .*\(offer_id\) WHERE \(status = 'active'::text\)/);
  assert.match(byName.get("idx_offer_boosts_active_scope") ?? "", /\(scope_category, scope_brand, scope_model\) WHERE \(status = 'active'::text\)/);
  assert.match(byName.get("idx_offer_boosts_active_seller") ?? "", /\(seller_id\) WHERE \(status = 'active'::text\)/);
  await wipe();
});

// ═════════════ 2. Réglages et places ═════════════

test("readBoostSettings : la ligne de la catégorie (casse et espaces ignorés), sinon default ; catégorie absente → default", async () => {
  const fallback = await readBoostSettings(pool, "smartphones");
  const expectedDefault: BoostSettings = {
    key: "default", slotRatio: 0.15, minSlots: 1, maxSlots: 50, maxActivePerSeller: 2, maxSellerSlotShare: 0.34, maxPromotedShare: 0.15, minRelevance: 60,
  };
  assert.deepEqual(fallback, expectedDefault);
  assert.deepEqual(await readBoostSettings(pool, null), expectedDefault);
  assert.deepEqual(await readBoostSettings(pool, "   "), expectedDefault);
  await setSettings("smartphones", { slot_ratio: 0.4, min_slots: 3, max_slots: 9, max_active_per_seller: 4, max_seller_slot_share: 0.5, max_promoted_share: 0.1, min_relevance: 72.5 });
  const expected: BoostSettings = { key: "smartphones", slotRatio: 0.4, minSlots: 3, maxSlots: 9, maxActivePerSeller: 4, maxSellerSlotShare: 0.5, maxPromotedShare: 0.1, minRelevance: 72.5 };
  try {
    for (const spelling of ["smartphones", "SMARTPHONES", "  Smartphones "]) assert.deepEqual(await readBoostSettings(pool, spelling), expected, spelling);
    assert.deepEqual(await readBoostSettings(pool, "tablets"), expectedDefault, "autre catégorie : default");
  } finally {
    await pool.query("DELETE FROM boost_settings WHERE key <> 'default'");
  }
  await pool.query("DELETE FROM boost_settings WHERE key = 'default'");
  try {
    await assert.rejects(readBoostSettings(pool, "x"), (error: unknown) => error instanceof BoostError && error.code === "boost_settings_missing");
  } finally {
    await setSettings("default", {});
  }
  assert.deepEqual(await readBoostSettings(pool, "x"), expectedDefault);
});

test("readBoostSlots : total, utilisées, disponibles ; seules les offres éligibles du périmètre comptent ; clé normalisée", async () => {
  await wipe();
  const sellers = [await makeSeller(), await makeSeller()];
  const offers: OfferRecord[] = [];
  for (let index = 0; index < 8; index++) offers.push(await makeOffer({ ownerId: sellers[index % 2] }));
  // Même périmètre avec une autre casse et des espaces : compté.
  const spelled = await makeOffer({ ownerId: sellers[0] });
  await pool.query("UPDATE offers SET category = ' SMARTPHONES', brand = 'apple ', model = 'IPHONE 13' WHERE id = $1", [spelled.id]);
  // Exclusions : brouillon, pause, archivée, indisponible, vendeur suspendu / archivé, autre modèle, autre catégorie.
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
  // Disponibilité réservée ou inconnue : comptent.
  await makeOffer({ availability: "reserved" });
  await makeOffer({ availability: null });

  // 8 + 1 + 2 = 11 offres → ceil(0,15 × 11) = 2 places.
  const slots = await readBoostSlots({ pool, offerId: offers[0].id });
  assert.deepEqual(slots, { scope: { category: "smartphones", brand: "apple", model: "iphone 13" }, total: 2, used: 0, available: 2 });
  assert.deepEqual(await readBoostSlots({ pool, offerId: spelled.id }), slots, "l'autre graphie désigne le même périmètre");
  await grant(offers[0]);
  assert.deepEqual(await readBoostSlots({ pool, offerId: offers[3].id }), { ...slots, used: 1, available: 1 });
  await grant(offers[1]);
  assert.deepEqual(await readBoostSlots({ pool, offerId: spelled.id }), { ...slots, used: 2, available: 0 });
  // Un boost échu ne compte plus.
  await pool.query("UPDATE offer_boosts SET starts_at = clock_timestamp() - interval '2 days', ends_at = clock_timestamp() - interval '1 day' WHERE offer_id = $1", [offers[0].id]);
  assert.deepEqual(await readBoostSlots({ pool, offerId: spelled.id }), { ...slots, used: 1, available: 1 });
  // Un boost futur ne compte pas non plus.
  await pool.query("UPDATE offer_boosts SET starts_at = clock_timestamp() + interval '1 day', ends_at = clock_timestamp() + interval '2 days' WHERE offer_id = $1", [offers[1].id]);
  assert.deepEqual(await readBoostSlots({ pool, offerId: spelled.id }), { ...slots, used: 0, available: 2 });

  // Erreurs de lecture.
  assert.equal(await code(readBoostSlots({ pool, offerId: randomUUID() })), "offer_not_found");
  const incomplete = await makeOffer({ model: null });
  assert.equal(await code(readBoostSlots({ pool, offerId: incomplete.id })), "offer_not_boostable");
  await wipe();
});

// ═════════════ 3. Attribution ═════════════

function observedPool(): { spy: Pool; count: () => number } {
  let queries = 0;
  const spy = Object.create(pool) as Pool;
  spy.query = ((...args: unknown[]) => { queries++; return (pool.query as (...a: unknown[]) => unknown)(...args); }) as never;
  spy.connect = ((...args: unknown[]) => { queries++; return (pool.connect as (...a: unknown[]) => unknown)(...args); }) as never;
  return { spy, count: () => queries };
}

test("grantOfferBoost : validation avant tout SQL (pool exigé, UUID, durée, source)", async () => {
  const { spy, count } = observedPool();
  const good = { pool: spy, offerId: randomUUID(), ownerId: randomUUID(), durationCode: "24h" as const, source: "admin_grant" as const };
  const rejects = (override: Record<string, unknown>) =>
    assert.rejects(grantOfferBoost({ ...good, ...override } as never), (error: unknown) => error instanceof CatalogValidationError, JSON.stringify(Object.keys(override)));
  await rejects({ pool: undefined });
  await rejects({ pool: null });
  await rejects({ pool: {} });
  await rejects({ offerId: "pas-un-uuid" });
  await rejects({ ownerId: "pas-un-uuid" });
  await rejects({ durationCode: "30d" });
  await rejects({ durationCode: "24H" });
  await rejects({ durationCode: undefined });
  await rejects({ source: "payment" });
  await rejects({ source: undefined });
  assert.equal(count(), 0, "aucune requête SQL avant la validation");
  await assert.rejects(readBoostSlots({ pool: spy, offerId: "x" }), CatalogValidationError);
  await assert.rejects(cancelOfferBoost({ pool: spy, boostId: "x", ownerId: randomUUID() }), CatalogValidationError);
  await assert.rejects(cancelOfferBoost({ pool: spy, boostId: randomUUID(), ownerId: "x" }), CatalogValidationError);
  await assert.rejects(cancelOfferBoost({ pool: undefined as never, boostId: randomUUID(), ownerId: randomUUID() }), CatalogValidationError);
  assert.equal(count(), 0);
  // Casse tolérée sur les UUID.
  const offer = await makeOffer();
  const result = await grantOfferBoost({ pool, offerId: offer.id.toUpperCase(), ownerId: offer.ownerId.toUpperCase(), durationCode: "24h", source: "admin_grant" });
  assert.equal(result.boost.offerId, offer.id);
  await wipe();
});

test("grantOfferBoost : succès — boost actif, durée exacte par code, périmètre normalisé, instantané des places", async () => {
  await wipe();
  const offers: OfferRecord[] = [];
  for (let index = 0; index < 14; index++) offers.push(await makeOffer());
  // 14 offres → ceil(2,1) = 3 places ; plafond vendeur min(max(1, floor(1,02)), 2) = 1.
  const results: Array<Awaited<ReturnType<typeof grant>>> = [];
  for (const [index, duration] of (["24h", "3d", "7d"] as const).entries()) results.push(await grant(offers[index], duration));
  for (const [index, expected] of [86_400, 259_200, 604_800].entries()) {
    const { boost } = results[index];
    assert.match(boost.id, /^[0-9a-f-]{36}$/);
    assert.equal(boost.offerId, offers[index].id);
    assert.equal(boost.sellerId, offers[index].ownerId);
    assert.equal(boost.status, "active");
    assert.equal(boost.source, "admin_grant");
    assert.equal(boost.cancelledAt, null);
    assert.deepEqual(boost.scope, { category: "smartphones", brand: "apple", model: "iphone 13" });
    assert.equal(boost.endsAt.getTime() - boost.startsAt.getTime(), expected * 1000);
    const row = await sqlRow<{ seconds: string; effective: boolean }>(
      "SELECT extract(epoch FROM ends_at - starts_at)::text AS seconds, (status = 'active' AND starts_at <= clock_timestamp() AND clock_timestamp() < ends_at) AS effective FROM offer_boosts WHERE id = $1", [boost.id]);
    assert.equal(Number(row.seconds), expected);
    assert.equal(row.effective, true);
  }
  assert.deepEqual(results.map((result) => result.slots), [
    { scope: { category: "smartphones", brand: "apple", model: "iphone 13" }, total: 3, used: 1, available: 2 },
    { scope: { category: "smartphones", brand: "apple", model: "iphone 13" }, total: 3, used: 2, available: 1 },
    { scope: { category: "smartphones", brand: "apple", model: "iphone 13" }, total: 3, used: 3, available: 0 },
  ]);
  // starts_at est l'horloge de la base (pas celle du processus de test).
  const drift = await sqlRow<{ ok: boolean }>("SELECT abs(extract(epoch FROM clock_timestamp() - starts_at)) < 30 AS ok FROM offer_boosts LIMIT 1");
  assert.ok(drift.ok);
  await wipe();
});

test("grantOfferBoost : chaque refus a son code de domaine stable (et ne laisse aucune ligne)", async () => {
  await wipe();
  // Offre inconnue, offre d'un autre vendeur.
  assert.equal(await code(grantOfferBoost({ pool, offerId: randomUUID(), ownerId: randomUUID(), durationCode: "24h", source: "admin_grant" })), "offer_not_found");
  const owned = await makeOffer();
  const stranger = await makeSeller();
  assert.equal(await code(grantOfferBoost({ pool, offerId: owned.id, ownerId: stranger, durationCode: "24h", source: "admin_grant" })), "offer_not_owned");

  // Inéligibilité : chaque cause.
  const ineligible: Array<[string, OfferRecord]> = [
    ["brouillon", await makeOffer({ status: "draft" })],
    ["en pause", await makeOffer({ status: "paused" })],
    ["indisponible", await makeOffer({ availability: "unavailable" })],
  ];
  const archived = await makeOffer();
  await pool.query("UPDATE offers SET status = 'archived', archived_at = clock_timestamp() WHERE id = $1", [archived.id]);
  ineligible.push(["archivée", archived]);
  const suspended = await makeOffer();
  await pool.query("UPDATE users SET status = 'suspended' WHERE id = $1", [suspended.ownerId]);
  ineligible.push(["vendeur suspendu", suspended]);
  const gone = await makeOffer();
  await pool.query("UPDATE users SET status = 'archived', archived_at = clock_timestamp() WHERE id = $1", [gone.ownerId]);
  ineligible.push(["vendeur archivé", gone]);
  for (const [label, offer] of ineligible) assert.equal(await code(grant(offer)), "offer_not_eligible", label);

  // Clé produit incomplète : catégorie, marque, modèle absents ou blancs.
  for (const [label, input] of [
    ["sans catégorie", { category: null }], ["sans marque", { brand: null }], ["sans modèle", { model: null }],
  ] as Array<[string, OfferInput]>) assert.equal(await code(grant(await makeOffer(input))), "offer_not_boostable", label);
  const blank = await makeOffer();
  await pool.query("UPDATE offers SET model = '   ' WHERE id = $1", [blank.id]);
  assert.equal(await code(grant(blank)), "offer_not_boostable", "modèle blanc");

  assert.equal((await sqlRow<{ n: number }>("SELECT count(*)::int AS n FROM offer_boosts")).n, 0, "aucun refus ne laisse de boost");
  await wipe();
});

test("grantOfferBoost : offer_already_boosted, no_slot_available et seller_boost_limit_reached (dans cet ordre de contrôle)", async () => {
  await wipe();
  const sellerA = await makeSeller();
  const sellerB = await makeSeller();
  const offers: OfferRecord[] = [];
  for (let index = 0; index < 10; index++) offers.push(await makeOffer({ ownerId: index < 4 ? sellerA : (index < 8 ? sellerB : undefined) }));
  // 10 offres → ceil(1,5) = 2 places ; plafond vendeur : min(max(1, floor(0,68)), 2) = 1.
  await grant(offers[0]);                                                  // vendeur A : 1/1
  assert.equal(await code(grant(offers[0])), "offer_already_boosted");
  assert.equal(await code(grant(offers[0], "7d")), "offer_already_boosted", "quelle que soit la durée");
  assert.equal(await code(grant(offers[1])), "seller_boost_limit_reached", "vendeur A : plafond de 1");
  await grant(offers[4]);                                                  // vendeur B : 2 places utilisées sur 2
  assert.equal(await code(grant(offers[5])), "no_slot_available", "vendeur B : plus de place (contrôlé avant le plafond)");
  assert.equal(await code(grant(offers[8])), "no_slot_available", "un autre vendeur : aucune place");
  assert.equal(await code(grant(offers[1])), "no_slot_available", "plus de place : prioritaire sur le plafond vendeur");
  assert.equal((await sqlRow<{ n: number }>("SELECT count(*)::int AS n FROM offer_boosts WHERE status = 'active'")).n, 2);

  // Plafond vendeur seul : réglage de la catégorie avec des places en abondance.
  await setSettings("smartphones", { slot_ratio: 0.5, min_slots: 8, max_slots: 20, max_active_per_seller: 2, max_seller_slot_share: 1 });
  try {
    await grant(offers[1]);                                                // vendeur A : 2e boost (plafond 2)
    assert.equal(await code(grant(offers[2])), "seller_boost_limit_reached", "vendeur A : plafond de 2 atteint");
    assert.equal(await code(grant(offers[3])), "seller_boost_limit_reached");
    await grant(offers[5]);                                                // vendeur B : 2e boost
    assert.equal(await code(grant(offers[6])), "seller_boost_limit_reached");
    await grant(offers[8]);                                                // un autre vendeur reste servi
    // La part du vendeur borne aussi : 8 places × 0,25 = 2 → plafond 2 ; 0,1 → max(1, floor(0,8)) = 1.
    await setSettings("smartphones", { slot_ratio: 0.5, min_slots: 8, max_slots: 20, max_active_per_seller: 5, max_seller_slot_share: 0.1 });
    assert.equal(await code(grant(offers[9])), "ok", "vendeur sans boost : plafond de 1, premier boost accepté");
    assert.equal(await code(grant(offers[2])), "seller_boost_limit_reached", "vendeur A a 2 boosts, plafond ramené à 1");
  } finally {
    await pool.query("DELETE FROM boost_settings WHERE key <> 'default'");
  }
  await wipe();
});

test("grantOfferBoost : attribution possible après l'expiration du boost de la même offre (l'ancien passe à expired)", async () => {
  await wipe();
  const offers: OfferRecord[] = [];
  for (let index = 0; index < 7; index++) offers.push(await makeOffer());
  const first = await grant(offers[0], "24h");
  assert.equal(await code(grant(offers[0])), "offer_already_boosted");
  // Le boost arrive à échéance (statut encore 'active' : il n'est marqué qu'à l'attribution suivante).
  await pool.query("UPDATE offer_boosts SET starts_at = clock_timestamp() - interval '2 days', ends_at = clock_timestamp() - interval '1 day' WHERE id = $1", [first.boost.id]);
  assert.equal((await sqlRow<{ status: string }>("SELECT status FROM offer_boosts WHERE id = $1", [first.boost.id])).status, "active");
  const second = await grant(offers[0], "3d");
  assert.notEqual(second.boost.id, first.boost.id);
  assert.equal((await sqlRow<{ status: string }>("SELECT status FROM offer_boosts WHERE id = $1", [first.boost.id])).status, "expired");
  assert.equal(second.boost.status, "active");
  assert.equal(second.slots.used, 1, "l'ancien boost échu ne compte pas : une seule place utilisée");
  assert.equal((await sqlRow<{ n: number }>("SELECT count(*)::int AS n FROM offer_boosts WHERE offer_id = $1 AND status = 'active'", [offers[0].id])).n, 1);
  // Un boost échu d'une AUTRE offre n'occupe plus de place même sans être marqué.
  await pool.query("UPDATE offer_boosts SET starts_at = clock_timestamp() - interval '2 days', ends_at = clock_timestamp() - interval '1 day' WHERE id = $1", [second.boost.id]);
  const other = await grant(offers[1]);
  assert.equal(other.slots.used, 1);
  await wipe();
});

test("cancelOfferBoost : annule (cancelled_at), idempotent, libère la place et l'offre ; refus de domaine ; boost échu → expired", async () => {
  await wipe();
  const offers: OfferRecord[] = [];
  for (let index = 0; index < 7; index++) offers.push(await makeOffer());
  const { boost } = await grant(offers[0]);
  assert.equal(await code(cancelOfferBoost({ pool, boostId: randomUUID(), ownerId: offers[0].ownerId })), "boost_not_found");
  assert.equal(await code(cancelOfferBoost({ pool, boostId: boost.id, ownerId: offers[1].ownerId })), "boost_not_owned");
  assert.equal((await sqlRow<{ status: string }>("SELECT status FROM offer_boosts WHERE id = $1", [boost.id])).status, "active", "refus : rien n'est modifié");

  const first = await cancelOfferBoost({ pool, boostId: boost.id, ownerId: offers[0].ownerId });
  assert.equal(first.cancelled, true);
  assert.equal(first.boost.status, "cancelled");
  assert.ok(first.boost.cancelledAt instanceof Date);
  const again = await cancelOfferBoost({ pool, boostId: boost.id.toUpperCase(), ownerId: offers[0].ownerId });
  assert.equal(again.cancelled, false, "idempotent : rien à faire");
  assert.equal(again.boost.status, "cancelled");
  assert.equal(again.boost.cancelledAt!.getTime(), first.boost.cancelledAt!.getTime(), "cancelled_at n'est pas réécrit");
  // Simultanément : un seul des deux annule, l'autre constate.
  const { boost: second } = await grant(offers[1]);
  const cancelPools = await distinctPools(2);
  const [a, b] = await Promise.all(cancelPools.map((db) => cancelOfferBoost({ pool: db, boostId: second.id, ownerId: offers[1].ownerId })));
  assert.deepEqual([a.cancelled, b.cancelled].sort(), [false, true]);

  // La place et l'offre sont libres : nouvelle attribution possible.
  assert.deepEqual((await readBoostSlots({ pool, offerId: offers[0].id })).used, 0);
  const regranted = await grant(offers[0]);
  assert.equal(regranted.boost.status, "active");

  // Boost actif mais échu : marqué expired, jamais cancelled.
  const lapsed = await grant(offers[2]);
  await pool.query("UPDATE offer_boosts SET starts_at = clock_timestamp() - interval '2 days', ends_at = clock_timestamp() - interval '1 day' WHERE id = $1", [lapsed.boost.id]);
  const lapsedResult = await cancelOfferBoost({ pool, boostId: lapsed.boost.id, ownerId: offers[2].ownerId });
  assert.equal(lapsedResult.cancelled, false);
  assert.equal(lapsedResult.boost.status, "expired");
  assert.equal(lapsedResult.boost.cancelledAt, null);
  // Boost expiré : l'annulation ne change rien.
  const noop = await cancelOfferBoost({ pool, boostId: lapsed.boost.id, ownerId: offers[2].ownerId });
  assert.deepEqual({ cancelled: noop.cancelled, status: noop.boost.status }, { cancelled: false, status: "expired" });
  await wipe();
});

test("plafond vendeur : propre à chaque périmètre (un vendeur boosté ailleurs n'est pas limité ici)", async () => {
  await wipe();
  const seller = await makeSeller();
  const iphone = await makeOffer({ ownerId: seller, brand: "Apple", model: "iPhone 13" });
  const galaxy = await makeOffer({ ownerId: seller, brand: "Samsung", model: "Galaxy S23" });
  const pixel = await makeOffer({ ownerId: seller, brand: "Google", model: "Pixel 8" });
  const second = await makeOffer({ ownerId: seller, brand: "Apple", model: "iPhone 13" });
  // Chaque périmètre n'a qu'une ou deux offres : 1 place, plafond vendeur 1.
  assert.equal((await grant(iphone)).slots.total, 1);
  assert.equal((await grant(galaxy)).slots.used, 1, "autre périmètre : le boost iPhone ne compte pas");
  assert.equal((await grant(pixel)).slots.used, 1);
  assert.equal(await code(grant(second)), "no_slot_available", "même périmètre que le boost iPhone : la place est prise");
  assert.equal((await sqlRow<{ n: number }>("SELECT count(*)::int AS n FROM offer_boosts WHERE seller_id = $1 AND status = 'active'", [seller])).n, 3);
  await wipe();
});

test("clé de périmètre normalisée : « Apple » et « apple » (casse, espaces) désignent la même place et le même verrou", async () => {
  await wipe();
  await setSettings("smartphones", { slot_ratio: 0.5, min_slots: 1, max_slots: 1, max_active_per_seller: 5, max_seller_slot_share: 1 });
  try {
    const upper = await makeOffer({ brand: "Apple", model: "iPhone 13" });
    const lower = await makeOffer({ brand: "apple", model: "iphone 13" });
    const spaced = await makeOffer({});
    await pool.query("UPDATE offers SET category = '  SMARTPHONES ', brand = ' APPLE', model = 'iPhone 13 ' WHERE id = $1", [spaced.id]);
    const other = await makeOffer({ brand: "Samsung", model: "Galaxy S23" });

    const first = await grant(upper);
    assert.deepEqual(first.boost.scope, { category: "smartphones", brand: "apple", model: "iphone 13" });
    assert.equal(first.slots.total, 1);
    assert.equal(await code(grant(lower)), "no_slot_available", "« apple » : même périmètre, la place est prise");
    assert.equal(await code(grant(spaced)), "no_slot_available", "casse et espaces ignorés");
    assert.equal(await code(grant(other)), "ok", "autre produit : autre périmètre, sa propre place");
    const scopes = (await pool.query<{ scope_brand: string; scope_model: string }>("SELECT scope_brand, scope_model FROM offer_boosts ORDER BY scope_brand")).rows;
    assert.deepEqual(scopes, [{ scope_brand: "apple", scope_model: "iphone 13" }, { scope_brand: "samsung", scope_model: "galaxy s23" }]);
  } finally {
    await pool.query("DELETE FROM boost_settings WHERE key <> 'default'");
  }
  await wipe();
});

// ═════════════ 4. Concurrence ═════════════

async function distinctPools(count: number): Promise<Pool[]> {
  const pools: Pool[] = [];
  for (let index = 0; index < count; index++) {
    const extra = await openVerifiedIsolatedPool(target, schema);
    extraPools.push(extra);
    pools.push(extra);
  }
  return pools;
}

/** Point de rencontre borné : tous les participants se libèrent dès que `size` sont arrivés, ou après `timeoutMs`. */
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

async function race(offers: OfferRecord[], pools: Pool[]): Promise<string[]> {
  const meet = meetingPoint(offers.length, 300);
  let start!: () => void;
  const barrier = new Promise<void>((resolve) => { start = resolve; });
  const attempts = offers.map(async (offer, index) => {
    await barrier;
    return code(grant(offer, "24h", pools[index], { beforeInsert: meet }));
  });
  start();
  return Promise.all(attempts);
}

test("concurrence : 6 attributions simultanées dans un périmètre de 2 places → exactement 2 succès et 4 no_slot_available", async () => {
  await wipe();
  await setSettings("smartphones", { slot_ratio: 0.5, min_slots: 2, max_slots: 2, max_active_per_seller: 5, max_seller_slot_share: 1 });
  try {
    const offers: OfferRecord[] = [];
    for (let index = 0; index < 6; index++) offers.push(await makeOffer());   // six vendeurs distincts
    const results = await race(offers, await distinctPools(6));
    assert.equal(results.filter((result) => result === "ok").length, 2, JSON.stringify(results));
    assert.equal(results.filter((result) => result === "no_slot_available").length, 4, JSON.stringify(results));
    assert.equal((await sqlRow<{ n: number }>("SELECT count(*)::int AS n FROM offer_boosts WHERE status = 'active'")).n, 2);
    assert.deepEqual(await readBoostSlots({ pool, offerId: offers[0].id }), { scope: { category: "smartphones", brand: "apple", model: "iphone 13" }, total: 2, used: 2, available: 0 });
  } finally {
    await pool.query("DELETE FROM boost_settings WHERE key <> 'default'");
  }
  await wipe();
});

test("concurrence : 6 attributions simultanées d'un même vendeur (plafond 2, places en abondance) → exactement 2 succès et 4 seller_boost_limit_reached", async () => {
  await wipe();
  await setSettings("smartphones", { slot_ratio: 0.5, min_slots: 8, max_slots: 8, max_active_per_seller: 2, max_seller_slot_share: 1 });
  try {
    const seller = await makeSeller();
    const offers: OfferRecord[] = [];
    for (let index = 0; index < 6; index++) offers.push(await makeOffer({ ownerId: seller }));
    const results = await race(offers, await distinctPools(6));
    assert.equal(results.filter((result) => result === "ok").length, 2, JSON.stringify(results));
    assert.equal(results.filter((result) => result === "seller_boost_limit_reached").length, 4, JSON.stringify(results));
    assert.equal((await sqlRow<{ n: number }>("SELECT count(*)::int AS n FROM offer_boosts WHERE seller_id = $1 AND status = 'active'", [seller])).n, 2);
  } finally {
    await pool.query("DELETE FROM boost_settings WHERE key <> 'default'");
  }
  await wipe();
});

test("concurrence : deux attributions simultanées pour la MÊME offre → un succès, un offer_already_boosted", async () => {
  await wipe();
  const offers: OfferRecord[] = [];
  for (let index = 0; index < 7; index++) offers.push(await makeOffer());
  const pools = await distinctPools(2);
  const meet = meetingPoint(2, 300);
  const results = await Promise.all(pools.map((db) => code(grant(offers[0], "24h", db, { beforeInsert: meet }))));
  assert.deepEqual([...results].sort(), ["offer_already_boosted", "ok"]);
  assert.equal((await sqlRow<{ n: number }>("SELECT count(*)::int AS n FROM offer_boosts WHERE offer_id = $1", [offers[0].id])).n, 1);
  await wipe();
});

// ═════════════ 5. Lecture des boosts effectifs (classement) ═════════════

test("readEffectiveBoostedOfferIds : effectif à l'instant demandé seulement (statut, période, vendeur, éligibilité, clé produit actuelle)", async () => {
  await wipe();
  const offers: OfferRecord[] = [];
  for (let index = 0; index < 14; index++) offers.push(await makeOffer());
  await setSettings("smartphones", { slot_ratio: 0.5, min_slots: 20, max_slots: 20, max_active_per_seller: 5, max_seller_slot_share: 1 });
  try {
    const boosts = new Map<number, string>();
    for (const index of [0, 1, 2, 3, 4, 5, 6, 7]) boosts.set(index, (await grant(offers[index])).boost.id);
    const now = (await sqlRow<{ at: string }>("SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS at")).at;
    const ids = offers.map((offer) => offer.id);
    const read = async (at = now) => {
      const found = await readEffectiveBoostedOfferIds(pool, ids, at);
      return offers.map((offer, index) => (found.has(offer.id) ? index : -1)).filter((index) => index >= 0);
    };
    assert.deepEqual(await read(), [0, 1, 2, 3, 4, 5, 6, 7]);
    assert.deepEqual([...await readEffectiveBoostedOfferIds(pool, [], now)], []);

    // Avant le début du boost, ou à l'échéance exacte : aucun effet ; une minute avant l'échéance : effectif.
    const row = await sqlRow<{ before: string; ends: string; inside: string }>(
      `SELECT to_char((starts_at - interval '1 second') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS before,
              to_char(ends_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ends,
              to_char((ends_at - interval '1 minute') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS inside
         FROM offer_boosts WHERE id = $1`, [boosts.get(0)]);
    assert.ok(!(await read(row.before)).includes(0), "avant starts_at");
    assert.ok(!(await read(row.ends)).includes(0), "à ends_at exactement : fini");
    assert.ok((await read(row.inside)).includes(0));

    // Annulé, expiré, futur.
    await pool.query("UPDATE offer_boosts SET status = 'cancelled', cancelled_at = clock_timestamp() WHERE id = $1", [boosts.get(1)]);
    await pool.query("UPDATE offer_boosts SET status = 'expired' WHERE id = $1", [boosts.get(2)]);
    await pool.query("UPDATE offer_boosts SET starts_at = clock_timestamp() + interval '1 hour', ends_at = clock_timestamp() + interval '2 hours' WHERE id = $1", [boosts.get(3)]);
    // Vendeur suspendu ; offre en pause ; offre indisponible.
    await pool.query("UPDATE users SET status = 'suspended' WHERE id = $1", [offers[4].ownerId]);
    await pool.query("UPDATE offers SET status = 'paused' WHERE id = $1", [offers[5].id]);
    await pool.query("UPDATE offers SET availability_status = 'unavailable' WHERE id = $1", [offers[6].id]);
    // Offre modifiée vers un autre produit : le boost du périmètre d'origine ne la suit pas.
    await pool.query("UPDATE offers SET model = 'iPhone 14' WHERE id = $1", [offers[7].id]);
    assert.deepEqual(await read(), [0]);
    // Casse et espaces de la clé actuelle de l'offre sont ignorés.
    await pool.query("UPDATE offers SET brand = ' APPLE ' WHERE id = $1", [offers[0].id]);
    assert.deepEqual(await read(), [0]);
  } finally {
    await pool.query("DELETE FROM boost_settings WHERE key <> 'default'");
  }
  await wipe();
});

// ═════════════ 6. Script boost:grant ═════════════

const GRANT = "scripts/boost-grant.ts";

test("script boost:grant : succès (mention « administration »), refus et erreurs → code 1, jamais de message brut", async () => {
  await wipe();
  const offers: OfferRecord[] = [];
  for (let index = 0; index < 7; index++) offers.push(await makeOffer());
  const lines = (output: string) => output.trim().split("\n");

  const ok = await runScript(GRANT, ["--offer", offers[0].id, "--duration", "3d"], schema);
  assert.equal(ok.code, 0, ok.output);
  assert.equal(lines(ok.output).length, 1);
  assert.match(ok.output.trim(), /^Boost \(administration\) attribué : [0-9a-f-]{36}, durée 3d, jusqu'au \d{4}-\d{2}-\d{2}T[\d:.]+Z\. Places du périmètre : 1 utilisée\(s\) sur 2 \(1 disponible\(s\)\)\.$/);
  const stored = await sqlRow<{ offer_id: string; duration_code: string; source: string; status: string }>("SELECT offer_id, duration_code, source, status FROM offer_boosts");
  assert.deepEqual(stored, { offer_id: offers[0].id, duration_code: "3d", source: "admin_grant", status: "active" });

  const refusal = await runScript(GRANT, ["--offer", offers[0].id, "--duration", "24h"], schema);
  assert.equal(refusal.code, 1, refusal.output);
  assert.equal(refusal.output.trim(), "Boost (administration) : refus offer_already_boosted (Cette offre a déjà un boost actif.)");
  const unknown = await runScript(GRANT, ["--offer", randomUUID(), "--duration", "24h"], schema);
  assert.equal(unknown.code, 1);
  assert.match(unknown.output, /refus offer_not_found \(Offre introuvable\.\)/);
  const incomplete = await makeOffer({ model: null });
  const notBoostable = await runScript(GRANT, ["--offer", incomplete.id, "--duration", "24h"], schema);
  assert.equal(notBoostable.code, 1);
  assert.match(notBoostable.output, /refus offer_not_boostable/);

  // Arguments invalides : code 1, usage, aucun accès à la base.
  const bad: string[][] = [
    [], ["--offer", offers[1].id], ["--duration", "24h"], ["--offer", "pas-un-uuid", "--duration", "24h"],
    ["--offer", offers[1].id, "--duration", "30d"], ["--offer", offers[1].id, "--duration", "24h", "--pay", "1"],
    ["--offer", offers[1].id, "--offer", offers[2].id, "--duration", "24h"], ["--offer", offers[1].id, "--duration"],
    ["--offer", offers[1].id, "--duration", "24h", "extra"],
  ];
  for (const args of bad) {
    const result = await runScript(GRANT, args, schema);
    assert.equal(result.code, 1, JSON.stringify(args) + result.output);
    assert.match(result.output, /^Boost \(administration\) : .*Usage : npm run boost:grant/m, JSON.stringify(args));
  }
  assert.equal((await sqlRow<{ n: number }>("SELECT count(*)::int AS n FROM offer_boosts")).n, 1, "aucun argument invalide n'écrit");

  // DATABASE_URL obligatoire.
  const noUrl = await runScript(GRANT, ["--offer", offers[1].id, "--duration", "24h"], schema, { DATABASE_URL: "" });
  assert.equal(noUrl.code, 1);
  assert.match(noUrl.output, /DATABASE_URL est requis/);

  // Erreur de base inattendue (schéma sans aucune table) : seul le code SQLSTATE est affiché.
  const missing = await runScript(GRANT, ["--offer", offers[1].id, "--duration", "24h"], emptySchema);
  assert.equal(missing.code, 1);
  assert.equal(missing.output.trim(), "Boost (administration) : erreur 42P01.");

  for (const output of [ok.output, refusal.output, unknown.output, notBoostable.output, noUrl.output, missing.output]) {
    for (const forbidden of ["RAW_SECRET_TEXT", "postgres://", "noma_local", "SELECT", "relation", "offers", " at "]) {
      assert.ok(!output.includes(forbidden), `fuite « ${forbidden} » dans : ${output}`);
    }
  }
  await wipe();
});
