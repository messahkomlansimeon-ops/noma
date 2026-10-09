import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { Pool } from "pg";
import { ACTIVE_SEARCH_PRICE_XOF } from "../../lib/server/active-search/config";
import { purchaseActiveSearch } from "../../lib/server/active-search/purchase";
import { runMigrations } from "../../lib/server/postgres/migrations";
import { FAKE_ENV } from "./external-fixtures";
import { makeHandlers, startMission, type LiveMission } from "./missions-fixtures";
import { fund } from "./pro-fixtures";
import { makeMarket, openTestSchema, type Market, type TestSchema } from "./social-fixtures";
import { createTemporarySchemaName, openVerifiedTestDatabase, quoteTemporarySchema } from "./test-database";

/**
 * Contraintes FUSIONNÉES de la table `notifications` (intégration des lots des missions, migration 0027, et de la recherche active, migration 0028). Les deux migrations suppriment puis
 * recréent les mêmes deux contraintes (`notifications_kind_check`, `chk_notifications_shape`) ; la 0028 passe après la 0027 et doit donc REPRENDRE le genre `mission_coverage` et la
 * colonne `mission_id`. Ce fichier prouve, sur le vrai schéma (0001 → 0028) :
 *  - les SIX genres (`new_match`, `new_matches_digest`, `new_message`, `mission_coverage`, `new_external_match`, `active_search_expiring`) s'insèrent avec leur forme légitime ;
 *  - aucune colonne d'un autre genre n'est acceptée (`mission_id` dans cinq genres, `external_listing_id` / `source_name` / `active_search_id` dans la couverture d'une mission, etc.) ;
 *  - une base DÉJÀ migrée jusqu'à 0027 qui contient une notification `mission_coverage` reçoit la 0028 sans erreur, et la ligne est conservée.
 */

const KINDS = ["new_match", "new_matches_digest", "new_message", "mission_coverage", "new_external_match", "active_search_expiring"] as const;
type Kind = (typeof KINDS)[number];
type Columns = Record<string, unknown>;

interface Context {
  market: Market;
  live: LiveMission;
  conversationId: string;
  purchaseId: string;
}

const today = (): string => new Date().toISOString().slice(0, 10);

async function insertNotification(pool: Pool, columns: Columns): Promise<string> {
  const names = Object.keys(columns);
  const result = await pool.query<{ id: string }>(
    `INSERT INTO notifications (${names.join(", ")}) VALUES (${names.map((_, index) => `$${index + 1}`).join(", ")}) RETURNING id`,
    names.map((name) => columns[name]),
  );
  return result.rows[0].id;
}

/** Une insertion refusée par la base : code SQL et nom de la contrainte. */
async function refusal(pool: Pool, columns: Columns): Promise<{ code?: string; constraint?: string }> {
  try {
    await insertNotification(pool, columns);
  } catch (error) {
    const details = error as { code?: string; constraint?: string };
    return { code: details.code, constraint: details.constraint };
  }
  throw new Error(`insertion acceptée alors qu'elle devait être refusée : ${JSON.stringify(columns)}`);
}

/** La ligne légitime de chaque genre. */
function legitimate(context: Context): Record<Kind, Columns> {
  const user = context.market.buyer.userId;
  return {
    new_match: { user_id: user, kind: "new_match", demand_id: context.market.demand.id, offer_id: context.market.offer.id, title: "Apple iPhone 13", price_amount: 150_000, price_currency: "XOF" },
    new_matches_digest: { user_id: user, kind: "new_matches_digest", demand_id: context.market.demand.id, digest_day: today(), item_count: 3 },
    new_message: { user_id: user, kind: "new_message", demand_id: context.market.demand.id, offer_id: context.market.offer.id, conversation_id: context.conversationId, title: "Apple iPhone 13" },
    mission_coverage: { user_id: user, kind: "mission_coverage", demand_id: context.live.demandId, mission_id: context.live.id, digest_day: today(), item_count: 2, title: "Apple iPhone 13 : 2 sur 6" },
    new_external_match: { user_id: user, kind: "new_external_match", demand_id: context.market.demand.id, source_name: "Annonces Démo A", title: "iPhone 13 violet", price_amount: 139_000, price_currency: "XOF" },
    active_search_expiring: { user_id: user, kind: "active_search_expiring", demand_id: context.market.demand.id, active_search_id: context.purchaseId },
  };
}

/** Un acheteur, un vendeur, une annonce, une conversation et une mission lancée (besoin porteur), sans la recherche active (elle exige la 0028). */
async function baseWorld(pool: Pool): Promise<{ market: Market; live: LiveMission; conversationId: string }> {
  const market = await makeMarket(pool);
  const conversation = await pool.query<{ id: string }>(
    "INSERT INTO conversations (demand_id, offer_id, buyer_id, seller_id) VALUES ($1, $2, $3, $4) RETURNING id",
    [market.demand.id, market.offer.id, market.buyer.userId, market.seller.userId],
  );
  const live = await startMission(pool, makeHandlers(pool), market.buyer);
  return { market, live, conversationId: conversation.rows[0].id };
}

/** Un achat réel de recherche active sur le besoin ordinaire de l'acheteur (grand livre, crédits payés). */
async function buyOption(pool: Pool, market: Market): Promise<string> {
  await fund(pool, market.buyer.userId, 10_000);
  const bought = await purchaseActiveSearch({
    expectedPriceXof: ACTIVE_SEARCH_PRICE_XOF, env: FAKE_ENV, pool, userId: market.buyer.userId, demandId: market.demand.id, idempotencyKey: randomUUID(),
  });
  return bought.purchaseId;
}

async function definitionOf(pool: Pool, name: string): Promise<string> {
  return (await pool.query<{ def: string }>(
    "SELECT pg_get_constraintdef(c.oid) AS def FROM pg_constraint c WHERE c.conrelid = 'notifications'::regclass AND c.conname = $1", [name])).rows[0].def;
}

/**
 * Les six genres sur un schéma migré jusqu'à 0028. `preexisting` : la notification `mission_coverage` existait AVANT la 0028 (elle est conservée, on n'en insère pas une deuxième le même jour).
 */
async function exerciseSixKinds(pool: Pool, context: Context, preexisting: { coverageId: string } | null): Promise<void> {
  const rows = legitimate(context);

  // 1. Les contraintes recréées : la liste des genres est l'UNION des deux lots, et chaque branche exclut `mission_id` sauf la couverture d'une mission.
  const kindDefinition = await definitionOf(pool, "notifications_kind_check");
  assert.deepEqual([...kindDefinition.matchAll(/'([a-z_]+)'/g)].map((match) => match[1]).sort(), [...KINDS].sort(), kindDefinition);
  const shape = await definitionOf(pool, "chk_notifications_shape");
  assert.equal((shape.match(/mission_id IS NULL/g) ?? []).length, 5, "mission_id IS NULL dans les cinq branches des autres genres");
  assert.equal((shape.match(/mission_id IS NOT NULL/g) ?? []).length, 1, "mission_id IS NOT NULL dans la seule couverture d'une mission");
  for (const column of ["external_listing_id", "source_name", "active_search_id"]) {
    assert.ok((shape.match(new RegExp(`${column} IS NULL`, "g")) ?? []).length >= 4, `${column} IS NULL dans les branches des genres qui ne le portent pas`);
  }

  // 2. Les six genres s'insèrent (la couverture d'une mission antérieure à la 0028 est déjà là, intacte).
  const inserted: Partial<Record<Kind, string>> = {};
  for (const kind of KINDS) {
    if (kind === "mission_coverage" && preexisting !== null) {
      inserted[kind] = preexisting.coverageId;
      continue;
    }
    inserted[kind] = await insertNotification(pool, rows[kind]);
  }
  const stored = await pool.query<{ kind: string; n: number }>("SELECT kind, count(*)::int AS n FROM notifications GROUP BY kind ORDER BY kind");
  assert.deepEqual(stored.rows.map((row) => row.kind), [...KINDS].sort());
  assert.ok(stored.rows.every((row) => row.n === 1), "une ligne de chaque genre");
  const coverage = (await pool.query("SELECT user_id, demand_id, mission_id, digest_day::text AS digest_day, item_count, title, offer_id, conversation_id, external_listing_id, source_name, active_search_id FROM notifications WHERE id = $1", [inserted.mission_coverage])).rows[0];
  assert.equal(coverage.mission_id, context.live.id);
  assert.equal(coverage.demand_id, context.live.demandId);
  assert.deepEqual([coverage.offer_id, coverage.conversation_id, coverage.external_listing_id, coverage.source_name, coverage.active_search_id], [null, null, null, null, null]);

  // 3. `mission_id` n'est accepté dans AUCUN des cinq autres genres.
  for (const kind of KINDS.filter((name) => name !== "mission_coverage")) {
    assert.deepEqual(await refusal(pool, { ...rows[kind], mission_id: context.live.id }), { code: "23514", constraint: "chk_notifications_shape" }, `${kind} + mission_id`);
  }

  // 4. La couverture d'une mission n'accepte aucune colonne des autres genres, et exige les siennes.
  const coverageRow = rows.mission_coverage;
  const tampered: Array<[string, Columns]> = [
    ["external_listing_id", { external_listing_id: randomUUID() }],
    ["source_name", { source_name: "Annonces Démo A" }],
    ["active_search_id", { active_search_id: context.purchaseId }],
    ["offer_id", { offer_id: context.market.offer.id }],
    ["conversation_id", { conversation_id: context.conversationId }],
    ["prix", { price_amount: 1_000, price_currency: "XOF" }],
    ["mission_id absent", { mission_id: null }],
    ["quantité nulle", { item_count: 0 }],
    ["quantité absente", { item_count: null }],
    ["jour absent", { digest_day: null }],
    ["titre absent", { title: null }],
    ["titre vide", { title: "   " }],
    ["titre trop long", { title: "x".repeat(161) }],
  ];
  for (const [label, change] of tampered) {
    assert.deepEqual(await refusal(pool, { ...coverageRow, ...change }), { code: "23514", constraint: "chk_notifications_shape" }, `mission_coverage + ${label}`);
  }

  // 5. Les formes des genres de la recherche active et des genres plus anciens restent exactes.
  assert.deepEqual(await refusal(pool, { ...rows.new_external_match, offer_id: context.market.offer.id }), { code: "23514", constraint: "chk_notifications_shape" }, "annonce d'un autre site liée à une annonce interne");
  assert.deepEqual(await refusal(pool, { ...rows.new_external_match, source_name: null }), { code: "23514", constraint: "chk_notifications_shape" }, "annonce d'un autre site sans source");
  assert.deepEqual(await refusal(pool, { ...rows.new_external_match, active_search_id: context.purchaseId }), { code: "23514", constraint: "chk_notifications_shape" }, "annonce d'un autre site liée à un achat");
  assert.deepEqual(await refusal(pool, { ...rows.active_search_expiring, title: "x" }), { code: "23514", constraint: "chk_notifications_shape" }, "avis d'échéance avec un titre");
  assert.deepEqual(await refusal(pool, { ...rows.active_search_expiring, active_search_id: null }), { code: "23514", constraint: "chk_notifications_shape" }, "avis d'échéance sans achat");
  assert.deepEqual(await refusal(pool, { ...rows.new_match, source_name: "Annonces Démo A" }), { code: "23514", constraint: "chk_notifications_shape" }, "annonce interne avec une source");
  assert.deepEqual(await refusal(pool, { ...rows.new_message, active_search_id: context.purchaseId }), { code: "23514", constraint: "chk_notifications_shape" }, "message avec un achat");
  assert.deepEqual(await refusal(pool, { ...rows.new_matches_digest, external_listing_id: randomUUID() }), { code: "23514", constraint: "chk_notifications_shape" }, "résumé avec une annonce externe");

  // 6. Un genre inconnu est refusé (PostgreSQL évalue les contraintes dans l'ordre de leurs noms : la forme d'abord, puis la liste des genres, déjà vérifiée par sa définition plus haut).
  const unknown = await refusal(pool, { ...rows.new_match, kind: "inconnu" });
  assert.equal(unknown.code, "23514");
  assert.ok(["chk_notifications_shape", "notifications_kind_check"].includes(unknown.constraint ?? ""), String(unknown.constraint));

  // 7. Les index uniques des deux lots sont toujours là : une couverture par mission et par jour, un avis d'échéance par achat.
  assert.deepEqual(await refusal(pool, rows.mission_coverage), { code: "23505", constraint: "uq_notifications_mission_coverage" });
  assert.deepEqual(await refusal(pool, rows.active_search_expiring), { code: "23505", constraint: "uq_notifications_active_search_expiring" });
}

describe("contraintes fusionnées de notifications : base vierge, migrations 0001 → 0028", () => {
  let env: TestSchema | null = null;
  after(async () => {
    await env?.close();
  });

  test("les six genres s'insèrent avec leur forme, aucune colonne d'un autre genre n'est acceptée, les index uniques des deux lots existent", async () => {
    env = await openTestSchema(6);
    const pool = env.pool;
    const names = readdirSync(join(import.meta.dirname, "../../database/migrations")).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort();
    assert.equal(names.at(-2), "0027_missions.sql");
    assert.equal(names.at(-1), "0028_active_search.sql");
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM noma_schema_migrations")).rows[0].n, names.length);
    const world = await baseWorld(pool);
    const purchaseId = await buyOption(pool, world.market);
    await exerciseSixKinds(pool, { ...world, purchaseId }, null);
  });
});

describe("contraintes fusionnées de notifications : base DÉJÀ migrée jusqu'à 0027 avec une notification mission_coverage", () => {
  test("la 0028 s'applique sans erreur, la notification est conservée telle quelle, puis les six genres sont acceptés", async () => {
    const opened = await openVerifiedTestDatabase(process.env.TEST_DATABASE_URL);
    const schema = createTemporarySchemaName();
    await opened.pool.query(`CREATE SCHEMA ${quoteTemporarySchema(schema)}`);
    const pool = new Pool({ connectionString: opened.target.connectionString, max: 6, options: `-c search_path=${schema}` });
    try {
      const directory = join(import.meta.dirname, "../../database/migrations");
      const names = readdirSync(directory).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort();
      assert.equal(names.at(-1), "0028_active_search.sql");
      await pool.query("CREATE TABLE noma_schema_migrations (version TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP)");
      // 0001 → 0027 avec leurs EMPREINTES réelles (le lanceur de migrations les contrôle ensuite).
      for (const name of names.filter((file) => file < "0028")) {
        const sql = readFileSync(join(directory, name), "utf8");
        await pool.query(sql);
        await pool.query("INSERT INTO noma_schema_migrations (version, checksum) VALUES ($1, $2)", [name.slice(0, -4), createHash("sha256").update(sql).digest("hex")]);
      }
      assert.equal((await pool.query("SELECT to_regclass('active_search_purchases') IS NULL AS absent")).rows[0].absent, true, "base d'avant 0028");
      const before = await definitionOf(pool, "notifications_kind_check");
      assert.deepEqual([...before.matchAll(/'([a-z_]+)'/g)].map((match) => match[1]).sort(), ["mission_coverage", "new_match", "new_matches_digest", "new_message"]);

      // Une notification de couverture d'une mission, écrite sous les contraintes de la 0027.
      const world = await baseWorld(pool);
      const coverageId = await insertNotification(pool, {
        user_id: world.market.buyer.userId, kind: "mission_coverage", demand_id: world.live.demandId, mission_id: world.live.id, digest_day: today(), item_count: 2, title: "Apple iPhone 13 : 2 sur 6",
      });
      const rowBefore = (await pool.query("SELECT * FROM notifications WHERE id = $1", [coverageId])).rows[0];

      const applied = await runMigrations(pool);
      assert.deepEqual(applied.applied, ["0028_active_search"], "seule la 0028 s'applique, sans erreur");
      assert.equal(applied.skipped.length, names.length - 1);

      // Conservée à l'identique (les colonnes ajoutées par la 0028 sont NULL).
      const rowAfter = (await pool.query("SELECT * FROM notifications WHERE id = $1", [coverageId])).rows[0];
      const added = ["external_listing_id", "source_name", "active_search_id"];
      for (const [column, value] of Object.entries(rowAfter)) {
        if (added.includes(column)) assert.equal(value, null, column);
        else assert.deepEqual(value, rowBefore[column], column);
      }

      const purchaseId = await buyOption(pool, world.market);
      await exerciseSixKinds(pool, { ...world, purchaseId }, { coverageId });
    } finally {
      await pool.end();
      await opened.pool.query(`DROP SCHEMA IF EXISTS ${quoteTemporarySchema(schema)} CASCADE`);
      await opened.pool.end();
    }
  });
});
