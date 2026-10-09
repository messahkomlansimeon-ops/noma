import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { Pool, type PoolClient, type PoolConfig } from "pg";
import { createDemand, createOffer, createUser } from "../../lib/server/catalog";
import { CatalogValidationError } from "../../lib/server/catalog/errors";
import type { DemandRecord, OfferRecord } from "../../lib/server/catalog/types";
import { BOOST_PURCHASE_LOCK_NAMESPACE, BOOST_QUOTE_LOCK_NAMESPACE, BOOST_SCOPE_LOCK_NAMESPACE } from "../../lib/server/boost/boost-config";
import {
  BoostError, cancelOfferBoost, expireOfferBoosts, grantOfferBoost, readBoostSlots,
} from "../../lib/server/boost/boosts";
import {
  listOfferBoostPurchases, purchaseOfferBoost, refundBoostPurchase, type BoostPurchaseResult, type BoostPurchaseTestHooks,
} from "../../lib/server/boost/purchase";
import { quoteOfferBoost as quoteOfferBoostWithProcessGuard } from "../../lib/server/boost/quotes";
import { createReuseRecheckGuard } from "../../lib/server/boost/recheck-guard";

// Lot M1 : la revérification d'un devis réutilisé a une mémoire de 10 s par processus (D6). Ces essais enchaînent des revérifications du MÊME devis en changeant
// le monde entre deux : chaque appel reçoit une garde SANS mémoire (les essais de la mémoire et de la limite sont dans boost-quotes.integration.test.ts).
const quoteOfferBoost: typeof quoteOfferBoostWithProcessGuard = (input) =>
  quoteOfferBoostWithProcessGuard({ ...input, hooks: { reuseRecheckGuard: createReuseRecheckGuard({ ttlMs: 0 }), ...input.hooks } });
import { runMatchingCycle } from "../../lib/server/matching/runner";
import { listStoredOfferMatchesForDemand } from "../../lib/server/matching/stored-matches";
import { runMigrations } from "../../lib/server/postgres/migrations";
import { checkWalletIntegrity, runWalletCheck, type WalletCheckReport } from "../../lib/server/wallet/check";
import { WalletError } from "../../lib/server/wallet/errors";
import { readWalletBalance, readWalletOverview, recordWalletTransaction } from "../../lib/server/wallet/ledger";
import { applyProviderEvent, createTopupIntent, type ProviderEvent } from "../../lib/server/wallet/topups";
import { addReachableBuyer, insertEvaluation } from "./boost-fixtures";
import { runScript } from "./run-script";
import {
  createTemporarySchemaName, openVerifiedIsolatedPool, openVerifiedTestDatabase, ownAdvisoryLocks, quoteTemporarySchema, type DedicatedTestDatabase,
} from "./test-database";

// ───────────── infrastructure ─────────────

const schema = createTemporarySchemaName();
const quoted = quoteTemporarySchema(schema);
const scratchSchema = createTemporarySchemaName();
const sponsorSchema = createTemporarySchemaName();
const emptySchema = createTemporarySchemaName();
let admin: Pool;
let target: DedicatedTestDatabase;
/** Schéma PROPRE : toutes ses données restent cohérentes, wallet:check y est vert à la fin du fichier. */
let pool: Pool;
/** Pool des transactions de test annulées (injections de corruption : le schéma propre n'est jamais corrompu). */
let txPool: Pool;
/** Pool large : les rejeux simultanés d'une même clé (20 transactions à la fois). */
let widePool: Pool;
let firstMigration: Awaited<ReturnType<typeof runMigrations>>;
const extraPools: Pool[] = [];
const big = (value: number | string): bigint => BigInt(value);

/**
 * Chaque pool de ce fichier porte un `application_name` unique à cette exécution (`<RUN_ID>_<étiquette>`) : le comptage des attentes de
 * verrou ne regarde que NOS sessions, jamais celles d'une autre exécution simultanée sur la même base de test (leçon du lot P1a).
 */
const RUN_ID = `bpu_${process.pid}_${randomBytes(4).toString("hex")}`;
const namedPoolFactory = (label: string, max = 1) => (config: PoolConfig): Pool =>
  new Pool({ ...config, max, application_name: `${RUN_ID}_${label}` });
const openNamed = (label: string, schemaName = schema, max = 1): Promise<Pool> =>
  openVerifiedIsolatedPool(target, schemaName, namedPoolFactory(label, max));

before(async () => {
  const opened = await openVerifiedTestDatabase(process.env.TEST_DATABASE_URL);
  admin = opened.pool;
  target = opened.target;
  await admin.query(`CREATE SCHEMA ${quoted}`);
  await admin.query(`CREATE SCHEMA ${quoteTemporarySchema(emptySchema)}`);
  pool = await openNamed("main", schema, 4);
  txPool = await openNamed("tx");
  widePool = await openNamed("wide", schema, 24);
  firstMigration = await runMigrations(pool);
});

after(async () => {
  for (const extra of extraPools) await extra.end().catch(() => {});
  for (const each of [pool, txPool, widePool]) if (each) await each.end().catch(() => {});
  if (admin) {
    for (const name of [schema, scratchSchema, sponsorSchema, emptySchema]) await admin.query(`DROP SCHEMA IF EXISTS ${quoteTemporarySchema(name)} CASCADE`);
    await admin.end();
  }
});

/** Pools à une seule connexion chacun, réutilisés d'un test à l'autre : les N premiers sont toujours distincts. */
const bank: Pool[] = [];
async function distinctPools(size: number): Promise<Pool[]> {
  while (bank.length < size) {
    const extra = await openNamed(`bank${bank.length}`);
    extraPools.push(extra);
    bank.push(extra);
  }
  return bank.slice(0, size);
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

/** Nombre de sessions de CETTE exécution (application_name préfixé par RUN_ID) en attente d'un verrou. */
async function lockWaiters(): Promise<number> {
  return Number((await admin.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname = current_database() AND pid <> pg_backend_pid() AND wait_event_type = 'Lock'
        AND starts_with(application_name, $1)`, [`${RUN_ID}_`])).rows[0].n);
}

async function waitForLockWaiters(expected: number, timeoutMs: number): Promise<number> {
  const started = Date.now();
  let waiting = await lockWaiters();
  while (waiting < expected && Date.now() - started < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    waiting = await lockWaiters();
  }
  return waiting;
}

function observedPool(base: Pool = pool): { spy: Pool; count: () => number } {
  let queries = 0;
  const spy = Object.create(base) as Pool;
  spy.query = ((...args: unknown[]) => { queries++; return (base.query as (...a: unknown[]) => unknown)(...args); }) as never;
  spy.connect = ((...args: unknown[]) => { queries++; return (base.connect as (...a: unknown[]) => unknown)(...args); }) as never;
  return { spy, count: () => queries };
}

// ───────────── données ─────────────

let counter = 0;

/** Un périmètre produit UNIQUE par test : aucune interférence de places, de plafond ou de comptage entre les tests. */
interface Scope { category: string; brand: string; model: string }
const makeScope = (): Scope => { counter += 1; return { category: `cat${counter}x${randomBytes(2).toString("hex")}`, brand: "acme", model: `m${counter}` }; };

const makeUser = async (db: Pool = pool): Promise<string> => (await createUser({}, db)).id;

interface OfferInput { ownerId?: string; scope?: Scope; status?: "published" | "paused" | "draft"; availability?: "available" | "reserved" | "unavailable" | null; model?: string | null }

async function makeOffer(input: OfferInput = {}, db: Pool = pool): Promise<OfferRecord> {
  counter += 1;
  const scope = input.scope ?? makeScope();
  return createOffer({
    ownerId: input.ownerId ?? await makeUser(db),
    rawText: `RAW_SECRET_TEXT offre ${counter}`,
    category: scope.category,
    brand: scope.brand,
    model: input.model === undefined ? scope.model : input.model,
    price: { amount: 100_000 + counter, currency: "XOF" },
    status: input.status ?? "published",
    availabilityStatus: input.availability === undefined ? "available" : input.availability,
  }, db);
}

const scopeOf = (offer: OfferRecord): Scope => ({
  category: offer.category!.trim().toLowerCase(), brand: offer.brand!.trim().toLowerCase(), model: offer.model!.trim().toLowerCase(),
});

interface QuoteOptions {
  amount?: number;
  durationCode?: "24h" | "3d" | "7d";
  status?: "available" | "unavailable";
  /** Secondes avant l'échéance (négatif : déjà échue). */
  expiresInSeconds?: number;
  sellerId?: string;
  /** Faux : l'offre n'a AUCUN acheteur qui la verrait monter (par défaut un acheteur atteignable existe : l'achat revérifie la portée, lot P3). */
  reachable?: boolean;
}

/** Offres qui ont déjà un acheteur atteignable (une fois par offre, quel que soit le nombre de cotations). */
const reachableOffers = new Set<string>();
async function ensureReachable(offer: OfferRecord, db: Pool): Promise<void> {
  if (reachableOffers.has(offer.id)) return;
  reachableOffers.add(offer.id);
  await addReachableBuyer(db, offer);
}

/** Cotation insérée directement (lignes immuables : seul le code les écrit en production). Le prix est celui qu'on donne. */
async function insertQuote(offer: OfferRecord, options: QuoteOptions = {}, db: Pool = pool): Promise<string> {
  const id = randomUUID();
  const scope = scopeOf(offer);
  const available = (options.status ?? "available") === "available";
  const expiresIn = options.expiresInSeconds ?? 900;
  await db.query(
    `INSERT INTO boost_quotes (
       id, offer_id, seller_id, scope_category, scope_brand, scope_model, duration_code, pricing_key, pricing_version, currency,
       status, unavailable_reason, amount, raw_amount, competition_milli, demand_milli, scarcity_milli, duration_milli,
       competing_sellers, compatible_buyers, slots_total, slots_used, computed_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'default', 1, 'XOF',
       $8, $9, $10, $11, $12, $13, $14, $15, 1, 1, 1, 0,
       clock_timestamp() - make_interval(secs => 7200), clock_timestamp() + make_interval(secs => $16::int))`,
    [
      id, offer.id, options.sellerId ?? offer.ownerId, scope.category, scope.brand, scope.model, options.durationCode ?? "24h",
      available ? "available" : "unavailable", available ? null : "no_compatible_buyer",
      available ? (options.amount ?? 2300) : null, available ? String(options.amount ?? 2300) : null,
      available ? 1000 : null, available ? 1000 : null, available ? 1000 : null, available ? 1000 : null, expiresIn,
    ],
  );
  if (options.reachable !== false) await ensureReachable(offer, db);
  return id;
}

/** Crédit de départ (opération du grand livre autonome : boost_revenue → utilisateur, motif de test). */
async function fund(userId: string, amount: number, db: Pool = pool): Promise<void> {
  await recordWalletTransaction(db, {
    kind: "adjustment",
    reference: `adjustment:fund-${randomUUID()}`,
    metadata: { reasonCode: "test_fixture" },
    entries: [
      { account: { kind: "boost_revenue" }, amount: -big(amount) },
      { account: { kind: "user", ownerId: userId }, amount: big(amount) },
    ],
  });
}

const sha = (text: string): string => createHash("sha256").update(text).digest("hex");

/** Recharge par le chemin complet (intention, événement signé du prestataire fictif appliqué) : aucun raccourci. */
async function fundByTopup(ownerId: string, amount: number, db: Pool = pool): Promise<void> {
  const { intent } = await createTopupIntent({ pool: db, ownerId, amountXof: big(amount), idempotencyKey: randomUUID() });
  const eventId = `evt_${randomUUID().replaceAll("-", "")}`;
  const event: ProviderEvent = {
    provider: "fake", eventId, type: "payment.succeeded", providerReference: intent.providerReference, amountXof: intent.amountXof,
    payloadSha256: sha(`corps:${eventId}`),
  };
  assert.equal((await applyProviderEvent({ pool: db, event })).outcome, "applied");
}

const scalar = async <T = string>(text: string, values: unknown[] = [], db: Pool = pool): Promise<T> => (await db.query(text, values)).rows[0].n as T;
const countRows = async (table: string, where = "TRUE", values: unknown[] = []): Promise<number> =>
  Number(await scalar(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`, values));
const balanceOf = (userId: string, db: Pool = pool): Promise<bigint> => readWalletBalance(db, userId);
const revenueBalance = async (db: Pool = pool): Promise<bigint> => big(await scalar("SELECT balance::text AS n FROM wallet_accounts WHERE kind = 'boost_revenue'", [], db));

/** Code de domaine d'une promesse : BoostError, WalletError, ou le nom et le message de toute autre erreur. */
async function outcome(promise: Promise<unknown>): Promise<string> {
  try { await promise; return "ok"; } catch (error) {
    if (error instanceof BoostError || error instanceof WalletError) return error.code;
    return `${(error as Error).name}: ${(error as Error).message}`;
  }
}

interface Setup { sellerId: string; offer: OfferRecord; quoteId: string; scope: Scope }

/** Un vendeur crédité avec une offre publiée et une cotation disponible (prix donné) : un monde d'achat minimal. */
async function setup(options: { credit?: number; quote?: QuoteOptions; offers?: number } = {}): Promise<Setup> {
  const scope = makeScope();
  const sellerId = await makeUser();
  const offer = await makeOffer({ ownerId: sellerId, scope });
  for (let index = 1; index < (options.offers ?? 1); index++) await makeOffer({ scope });
  if ((options.credit ?? 10_000) > 0) await fund(sellerId, options.credit ?? 10_000);
  return { sellerId, offer, quoteId: await insertQuote(offer, options.quote), scope };
}

const buy = (world: { sellerId: string; offer: OfferRecord; quoteId: string }, over: Partial<{ idempotencyKey: string; db: Pool; hooks: BoostPurchaseTestHooks; quoteId: string; offerId: string }> = {}): Promise<BoostPurchaseResult> =>
  purchaseOfferBoost({
    pool: over.db ?? pool, sellerId: world.sellerId, offerId: over.offerId ?? world.offer.id, quoteId: over.quoteId ?? world.quoteId,
    idempotencyKey: over.idempotencyKey ?? randomUUID(), hooks: over.hooks,
  });

const setCategorySettings = (category: string, values: Partial<Record<string, number>>) => {
  const merged = { slot_ratio: 0.15, min_slots: 1, max_slots: 50, max_active_per_seller: 2, max_seller_slot_share: 0.34, max_promoted_share: 0.15, min_relevance: 60, ...values };
  return pool.query(
    `INSERT INTO boost_settings (key, slot_ratio, min_slots, max_slots, max_active_per_seller, max_seller_slot_share, max_promoted_share, min_relevance)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (key) DO UPDATE SET slot_ratio = $2, min_slots = $3, max_slots = $4, max_active_per_seller = $5,
       max_seller_slot_share = $6, max_promoted_share = $7, min_relevance = $8`,
    [category, merged.slot_ratio, merged.min_slots, merged.max_slots, merged.max_active_per_seller, merged.max_seller_slot_share, merged.max_promoted_share, merged.min_relevance]);
};

/** État comptable global : rien n'a changé si cet instantané est identique avant et après un refus. */
async function ledgerSnapshot(): Promise<Record<string, string>> {
  const row = (await pool.query<Record<string, string>>(
    `SELECT (SELECT count(*) FROM wallet_transactions)::text AS transactions, (SELECT count(*) FROM wallet_entries)::text AS entries,
            (SELECT COALESCE(sum(balance), 0) FROM wallet_accounts)::text AS balances, (SELECT count(*) FROM offer_boosts)::text AS boosts,
            (SELECT count(*) FROM boost_purchases)::text AS purchases, (SELECT count(*) FROM wallet_accounts)::text AS accounts`)).rows[0];
  return row;
}

async function assertWalletGreen(label: string, db: Pool = pool): Promise<WalletCheckReport> {
  const report = await checkWalletIntegrity(db);
  assert.deepEqual(report.violations, [], `${label} : wallet:check doit être vert`);
  return report;
}

/**
 * Fausse l'écoulement du temps pour un boost ACHETÉ : sa fenêtre est figée par `trg_offer_boosts_purchase_window`, le test désactive donc ce
 * déclencheur (et lui seul) le temps de la mise à jour, puis le réactive. Renvoie la fonction qui RESTAURE la fenêtre d'origine (au
 * microseconde près : valeurs relues en texte) : une fenêtre faussée serait un écart de wallet:check, le schéma propre doit rester sain.
 */
async function tamperPurchasedBoost(boostId: string, assignments: string): Promise<() => Promise<void>> {
  const original = (await pool.query<{ s: string; e: string }>("SELECT starts_at::text AS s, ends_at::text AS e FROM offer_boosts WHERE id = $1", [boostId])).rows[0];
  const run = async (sql: string, values: unknown[]): Promise<void> => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("ALTER TABLE offer_boosts DISABLE TRIGGER trg_offer_boosts_purchase_window");
      await client.query(sql, values);
      await client.query("ALTER TABLE offer_boosts ENABLE TRIGGER trg_offer_boosts_purchase_window");
      await client.query("COMMIT");
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { /* conserver l'erreur utile */ }
      throw error;
    } finally {
      client.release();
    }
  };
  await run(`UPDATE offer_boosts SET ${assignments} WHERE id = $1`, [boostId]);
  return () => run("UPDATE offer_boosts SET starts_at = $2::timestamptz, ends_at = $3::timestamptz WHERE id = $1", [boostId, original.s, original.e]);
}

// ═════════════ 1. Migration 0015 ═════════════

test("migration 0015 (suivie de 0016 à 0019) : 19 appliquées, la relance n'en applique aucune, tables, index et déclencheurs présents", async () => {
  assert.equal(firstMigration.applied.length, 29);
  assert.ok(firstMigration.applied.includes("0015_boost_purchases"));
  assert.equal(firstMigration.applied.at(-1), "0029_active_search_places");
  const rerun = await runMigrations(pool);
  assert.deepEqual(rerun.applied, []);
  assert.equal(rerun.skipped.length, 29);
  assert.equal(rerun.skipped.at(-1), "0029_active_search_places");
  assert.equal(await countRows("boost_purchases"), 0);

  const columns = (await pool.query<{ column_name: string; is_nullable: string; data_type: string }>(
    "SELECT column_name, is_nullable, data_type FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'boost_purchases' ORDER BY ordinal_position", [schema])).rows;
  assert.deepEqual(columns.map((column) => [column.column_name, column.is_nullable, column.data_type]), [
    ["id", "NO", "uuid"], ["seller_id", "NO", "uuid"], ["offer_id", "NO", "uuid"], ["quote_id", "NO", "uuid"], ["boost_id", "NO", "uuid"],
    ["transaction_id", "NO", "uuid"], ["amount_xof", "NO", "bigint"], ["duration_code", "NO", "text"], ["idempotency_key", "NO", "uuid"],
    ["created_at", "NO", "timestamp with time zone"], ["refunded_at", "YES", "timestamp with time zone"], ["refund_transaction_id", "YES", "uuid"],
    // Lot PRO1 (migration 0021) : part payée en crédits promotionnels, et part payée en crédits (calculée).
    ["promo_xof", "NO", "bigint"], ["paid_xof", "YES", "bigint"],
  ]);
  const constraints = (await pool.query<{ conname: string }>(
    "SELECT conname FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace WHERE n.nspname = $1 AND t.relname = 'boost_purchases' ORDER BY conname", [schema])).rows.map((row) => row.conname);
  for (const name of [
    "uq_boost_purchases_quote", "uq_boost_purchases_boost", "uq_boost_purchases_transaction", "uq_boost_purchases_refund_transaction",
    "uq_boost_purchases_seller_idempotency", "chk_boost_purchases_amount", "chk_boost_purchases_duration_code", "chk_boost_purchases_refund",
    "chk_boost_purchases_refund_order", "boost_purchases_seller_id_fkey", "boost_purchases_offer_id_fkey", "boost_purchases_quote_id_fkey",
    "boost_purchases_boost_id_fkey", "boost_purchases_transaction_id_fkey", "boost_purchases_refund_transaction_id_fkey",
  ]) assert.ok(constraints.includes(name), `contrainte ${name}`);
  const triggers = (await pool.query<{ tgname: string; tgdeferrable: boolean; tginitdeferred: boolean }>(
    `SELECT t.tgname, t.tgdeferrable, t.tginitdeferred FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE NOT t.tgisinternal AND n.nspname = $1 AND t.tgname IN ('trg_boost_purchases_guard', 'trg_offer_boosts_purchase_linked', 'trg_offer_boosts_purchase_window', 'trg_wallet_transactions_boost_linked')
      ORDER BY t.tgname`, [schema])).rows;
  assert.deepEqual(triggers, [
    { tgname: "trg_boost_purchases_guard", tgdeferrable: false, tginitdeferred: false },
    { tgname: "trg_offer_boosts_purchase_linked", tgdeferrable: true, tginitdeferred: true },
    { tgname: "trg_offer_boosts_purchase_window", tgdeferrable: false, tginitdeferred: false },
    { tgname: "trg_wallet_transactions_boost_linked", tgdeferrable: true, tginitdeferred: true },
  ]);
  const index = (await pool.query<{ indexdef: string }>("SELECT indexdef FROM pg_indexes WHERE schemaname = $1 AND indexname = 'idx_boost_purchases_offer'", [schema])).rows[0];
  assert.match(index.indexdef, /\(offer_id, created_at DESC\)/);
  // Les comptes système existent toujours (0014 inchangée) et aucune écriture n'a été créée par la migration.
  // (Lot PRO1 : la migration 0021 ajoute quatre comptes système ; lot RA1 : la migration 0028 ajoute celui des revenus de la recherche active ; on vérifie la liste complète.)
  assert.deepEqual((await pool.query("SELECT kind FROM wallet_accounts ORDER BY kind")).rows.map((row) => row.kind),
    ["active_search_revenue", "boost_revenue", "promo_consumed", "promo_expired", "promo_issuance", "provider_clearing", "subscription_revenue"]);
});

/** Exécute `operation` dans une transaction ANNULÉE (ou validée) ; renvoie l'échec SQL (code, contrainte) ou null. */
interface Failure { code?: string; constraint?: string }
async function failureOf(operation: (client: PoolClient) => Promise<unknown>, commit = false, db: Pool = txPool): Promise<Failure | null> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await operation(client);
    await client.query(commit ? "COMMIT" : "ROLLBACK");
    return null;
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* conserver l'erreur utile */ }
    const details = error as Failure;
    return { code: details.code, constraint: details.constraint };
  } finally {
    client.release();
  }
}

async function expectFailure(label: string, operation: (client: PoolClient) => Promise<unknown>, code: string, constraint?: string, commit = false): Promise<void> {
  const failure = await failureOf(operation, commit);
  assert.ok(failure, `${label} : un refus était attendu`);
  assert.equal(failure.code, code, `${label} : code SQL (${JSON.stringify(failure)})`);
  if (constraint) assert.equal(failure.constraint, constraint, `${label} : contrainte`);
}

const expectAccepted = async (label: string, operation: (client: PoolClient) => Promise<unknown>, commit = false): Promise<void> => {
  assert.equal(await failureOf(operation, commit), null, `${label} : aucun refus attendu`);
};

test("0015 offer_boosts.source et wallet_transactions : source « purchase » permise (jamais sans achat), types et métadonnées élargis, formes exactes imposées", async () => {
  // offer_boosts.source : « purchase » est permise par le CHECK, « payment » reste refusée ; sans achat, le COMMIT est refusé (déclencheur différé).
  const world = await setup();
  const boostSql = (source: string) => (client: PoolClient) => client.query(
    `INSERT INTO offer_boosts (id, offer_id, seller_id, scope_category, scope_brand, scope_model, status, duration_code, starts_at, ends_at, source)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, 'active', '24h', clock_timestamp(), clock_timestamp() + interval '1 day', $6)`,
    [world.offer.id, world.sellerId, world.scope.category, world.scope.brand, world.scope.model, source]);
  await expectFailure("source inconnue", boostSql("payment"), "23514", "chk_offer_boosts_source");
  await expectAccepted("source purchase tant que rien n'est validé", boostSql("purchase"));
  await expectFailure("boost « purchase » sans achat refusé au COMMIT", boostSql("purchase"), "23514", "trg_boost_purchases_linked", true);
  await expectAccepted("boost admin_grant inchangé", boostSql("admin_grant"));
  assert.equal(await countRows("offer_boosts", "offer_id = $1", [world.offer.id]), 0);

  // Types de transaction.
  const insertTx = (over: Record<string, string>) => (client: PoolClient) => {
    const columns: Record<string, string> = { id: `'${randomUUID()}'`, kind: "'adjustment'", reference: `'adjustment:${randomBytes(8).toString("hex")}'`, metadata: "'{}'::jsonb", ...over };
    return client.query(`INSERT INTO wallet_transactions (${Object.keys(columns).join(", ")}) VALUES (${Object.values(columns).join(", ")})`);
  };
  const purchase = randomUUID();
  const quote = randomUUID();
  await expectFailure("type « refund » inconnu", insertTx({ kind: "'refund'", reference: "'refund:abc'" }), "23514", "chk_wallet_transactions_kind");
  await expectFailure("type « boost_refunds » inconnu", insertTx({ kind: "'boost_refunds'", reference: "'boost_refunds:abc'" }), "23514", "chk_wallet_transactions_kind");
  const bad: Array<[string, Record<string, string>]> = [
    ["achat sans métadonnées", { kind: "'boost_purchase'", reference: `'boost_purchase:${purchase}'` }],
    ["achat sans quoteId", { kind: "'boost_purchase'", reference: `'boost_purchase:${purchase}'`, metadata: `'{"boostPurchaseId":"${purchase}"}'::jsonb` }],
    ["achat sans boostPurchaseId", { kind: "'boost_purchase'", reference: `'boost_purchase:${purchase}'`, metadata: `'{"quoteId":"${quote}"}'::jsonb` }],
    ["achat avec une clé en plus (reasonCode)", { kind: "'boost_purchase'", reference: `'boost_purchase:${purchase}'`, metadata: `'{"boostPurchaseId":"${purchase}","quoteId":"${quote}","reasonCode":"x"}'::jsonb` }],
    ["achat dont la référence ne dérive pas de l'achat", { kind: "'boost_purchase'", reference: `'boost_purchase:${randomUUID()}'`, metadata: `'{"boostPurchaseId":"${purchase}","quoteId":"${quote}"}'::jsonb` }],
    ["remboursement sans reasonCode", { kind: "'boost_refund'", reference: `'boost_refund:${purchase}'`, metadata: `'{"boostPurchaseId":"${purchase}"}'::jsonb` }],
    ["remboursement avec quoteId", { kind: "'boost_refund'", reference: `'boost_refund:${purchase}'`, metadata: `'{"boostPurchaseId":"${purchase}","reasonCode":"x","quoteId":"${quote}"}'::jsonb` }],
    ["remboursement dont la référence est celle d'un achat", { kind: "'boost_refund'", reference: `'boost_refund:${randomUUID()}'`, metadata: `'{"boostPurchaseId":"${purchase}","reasonCode":"x"}'::jsonb` }],
    ["ajustement qui porte boostPurchaseId", { metadata: `'{"boostPurchaseId":"${purchase}"}'::jsonb` }],
    ["recharge qui porte quoteId", { kind: "'topup'", reference: `'topup:${purchase}'`, metadata: `'{"paymentIntentId":"${purchase}","quoteId":"${quote}"}'::jsonb` }],
  ];
  for (const [label, over] of bad) await expectFailure(label, insertTx(over), "23514", "chk_wallet_transactions_boost");
  // Valeurs de forme invalide : refusées par le CHECK des métadonnées élargi (la référence dérive de la valeur : le CHECK de forme exacte passe).
  for (const [label, id, quoteValue] of [
    ["boostPurchaseId non UUID", "pas-un-uuid", `"${quote}"`], ["boostPurchaseId en majuscules", randomUUID().toUpperCase(), `"${quote}"`],
    ["quoteId non UUID", purchase, `"x"`], ["quoteId nombre", purchase, "12"],
  ] as Array<[string, string, string]>) {
    await expectFailure(label, insertTx({
      kind: "'boost_purchase'", reference: `'boost_purchase:${id}'`, metadata: `'{"boostPurchaseId":"${id}","quoteId":${quoteValue}}'::jsonb`,
    }), "23514", "chk_wallet_transactions_metadata");
  }
  await expectFailure("clé inconnue à côté d'une clé d'achat", insertTx({
    kind: "'boost_purchase'", reference: `'boost_purchase:${purchase}'`, metadata: `'{"boostPurchaseId":"${purchase}","quoteId":"${quote}","email":"a@b.c"}'::jsonb`,
  }), "23514", "chk_wallet_transactions_boost");
  // Formes exactes acceptées par les CHECK : seul l'équilibre (au COMMIT) refuse alors la transaction vide, ce qui prouve qu'ils ont laissé passer.
  await expectFailure("achat de forme exacte", insertTx({ kind: "'boost_purchase'", reference: `'boost_purchase:${purchase}'`, metadata: `'{"boostPurchaseId":"${purchase}","quoteId":"${quote}"}'::jsonb` }), "23514", "trg_wallet_transaction_balanced", true);
  await expectFailure("remboursement de forme exacte", insertTx({ kind: "'boost_refund'", reference: `'boost_refund:${purchase}'`, metadata: `'{"boostPurchaseId":"${purchase}","reasonCode":"customer_request"}'::jsonb` }), "23514", "trg_wallet_transaction_balanced", true);
});

// ───────────── lignes écrites à la main (pour exercer la base seule, sans le code applicatif) ─────────────

interface KitOptions {
  id?: string;
  /** Montant de la ligne d'achat ET, par défaut, des écritures. */
  amount?: number;
  ledgerAmount?: number;
  quoteId?: string;
  duration?: string;
  boostDuration?: string;
  boostSource?: string;
  boostOffer?: string;
  boostSeller?: string;
  boostStatus?: string;
  /** −1 (défaut) : le vendeur est débité ; +1 : signe inversé. */
  ledgerSign?: 1 | -1;
  ledgerOwner?: string;
  key?: string;
  /** Ligne insérée avec une date de remboursement (la garde l'interdit à la création). */
  refunded?: boolean;
  /** Durée réelle de la fenêtre du boost, en secondes (défaut : celle du code de durée). */
  boostSeconds?: number;
  /** Décalage du début du boost par rapport à l'instant de l'insertion, en secondes (défaut 0). */
  boostStartOffsetSeconds?: number;
}

const DURATION_SECONDS: Record<string, number> = { "24h": 86_400, "3d": 259_200, "7d": 604_800 };

async function systemAccountId(client: PoolClient, kind: "boost_revenue" | "provider_clearing"): Promise<string> {
  return (await client.query<{ id: string }>("SELECT id FROM wallet_accounts WHERE kind = $1", [kind])).rows[0].id;
}

async function userAccountId(client: PoolClient, ownerId: string): Promise<string> {
  const found = await client.query<{ id: string }>("SELECT id FROM wallet_accounts WHERE kind = 'user' AND owner_id = $1", [ownerId]);
  if (found.rows[0]) return found.rows[0].id;
  const id = randomUUID();
  await client.query("INSERT INTO wallet_accounts (id, kind, owner_id) VALUES ($1, 'user', $2)", [id, ownerId]);
  return id;
}

/** Un boost « purchase », la transaction d'achat et la ligne d'achat, écrits en SQL dans la transaction du client. */
async function insertKit(client: PoolClient, world: Setup, over: KitOptions = {}): Promise<{ id: string; boostId: string; transactionId: string; key: string }> {
  const id = over.id ?? randomUUID();
  const amount = over.amount ?? 2300;
  const ledgerAmount = over.ledgerAmount ?? amount;
  const boostId = randomUUID();
  const transactionId = randomUUID();
  const key = over.key ?? randomUUID();
  const status = over.boostStatus ?? "active";
  const boostOffer = over.boostOffer ?? world.offer.id;
  await client.query(
    `WITH t AS (SELECT clock_timestamp() AS now)
     INSERT INTO offer_boosts (id, offer_id, seller_id, scope_category, scope_brand, scope_model, status, duration_code, starts_at, ends_at, source, cancelled_at)
     SELECT $1, $2, $3, $4, $5, $6, $7, $8, t.now + make_interval(secs => $10::int), t.now + make_interval(secs => $10::int + $11::int), $9,
            CASE WHEN $7 = 'cancelled' THEN t.now END
       FROM t`,
    [boostId, boostOffer, over.boostSeller ?? world.sellerId, world.scope.category, world.scope.brand, world.scope.model, status,
      over.boostDuration ?? over.duration ?? "24h", over.boostSource ?? "purchase", over.boostStartOffsetSeconds ?? 0,
      over.boostSeconds ?? DURATION_SECONDS[over.boostDuration ?? over.duration ?? "24h"]]);
  await client.query(
    "INSERT INTO wallet_transactions (id, kind, reference, metadata) VALUES ($1, 'boost_purchase', $2, $3::jsonb)",
    [transactionId, `boost_purchase:${id}`, JSON.stringify({ boostPurchaseId: id, quoteId: over.quoteId ?? world.quoteId })]);
  const sign = over.ledgerSign ?? -1;
  const userAccount = await userAccountId(client, over.ledgerOwner ?? world.sellerId);
  const revenue = await systemAccountId(client, "boost_revenue");
  await client.query("INSERT INTO wallet_entries (id, transaction_id, account_id, amount) VALUES (gen_random_uuid(), $1, $2, $3::bigint)", [transactionId, userAccount, String(sign * ledgerAmount)]);
  await client.query("INSERT INTO wallet_entries (id, transaction_id, account_id, amount) VALUES (gen_random_uuid(), $1, $2, $3::bigint)", [transactionId, revenue, String(-sign * ledgerAmount)]);
  await client.query(
    `INSERT INTO boost_purchases (id, seller_id, offer_id, quote_id, boost_id, transaction_id, amount_xof, duration_code, idempotency_key, refunded_at, refund_transaction_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7::bigint, $8, $9, CASE WHEN $10::boolean THEN clock_timestamp() END, CASE WHEN $10::boolean THEN $6::uuid END)`,
    [id, world.sellerId, world.offer.id, over.quoteId ?? world.quoteId, boostId, transactionId, String(amount), over.duration ?? "24h", key, over.refunded === true]);
  return { id, boostId, transactionId, key };
}

const GUARD = "trg_boost_purchases_guard";
const guardOff = (operation: (client: PoolClient) => Promise<unknown>) => async (client: PoolClient): Promise<void> => {
  await client.query("ALTER TABLE boost_purchases DISABLE TRIGGER trg_boost_purchases_guard");
  await operation(client);
};

test("0015 boost_purchases : la garde d'insertion exige une cotation, un boost et des écritures qui correspondent EXACTEMENT à la ligne ; chaque cas est refusé, le cas conforme est validé", async () => {
  const world = await setup({ credit: 20_000 });
  const other = await setup({ credit: 10_000 });
  const unavailableQuote = await insertQuote(world.offer, { status: "unavailable" });
  const foreignOfferQuote = await insertQuote(other.offer, { sellerId: world.sellerId });
  const foreignSellerQuote = await insertQuote(world.offer, { sellerId: other.sellerId });
  const threeDays = await insertQuote(world.offer, { durationCode: "3d" });
  const refuse = (label: string, over: KitOptions) => expectFailure(label, (client) => insertKit(client, world, over), "23514", GUARD);

  await refuse("montant de la ligne différent de la cotation (écritures cohérentes avec la ligne)", { amount: 2400 });
  await refuse("cotation indisponible", { quoteId: unavailableQuote });
  await refuse("cotation d'une autre offre", { quoteId: foreignOfferQuote });
  await refuse("cotation d'un autre vendeur", { quoteId: foreignSellerQuote });
  await refuse("durée de la ligne différente de la cotation (le boost suit la ligne)", { duration: "3d" });
  await refuse("cotation inexistante", { quoteId: randomUUID() });
  await refuse("boost d'une autre source (admin_grant)", { boostSource: "admin_grant" });
  await refuse("boost d'un autre vendeur", { boostSeller: other.sellerId });
  await refuse("boost d'une autre offre", { boostOffer: other.offer.id });
  await refuse("boost d'une autre durée", { boostDuration: "7d" });
  await refuse("écritures d'un autre montant que la ligne", { ledgerAmount: 2200 });
  await refuse("signe inversé (le vendeur serait crédité)", { ledgerSign: 1 });
  await refuse("compte du mauvais utilisateur", { ledgerOwner: other.sellerId });
  await expectFailure("transaction d'un autre achat (la référence ne dérive pas de CET achat)", async (client) => {
    const first = await insertKit(client, world, { boostStatus: "expired" });
    const boostId = randomUUID();
    await client.query(
      `INSERT INTO offer_boosts (id, offer_id, seller_id, scope_category, scope_brand, scope_model, status, duration_code, starts_at, ends_at, source)
       VALUES ($1, $2, $3, $4, $5, $6, 'expired', '3d', clock_timestamp(), clock_timestamp() + interval '3 days', 'purchase')`,
      [boostId, world.offer.id, world.sellerId, world.scope.category, world.scope.brand, world.scope.model]);
    await client.query(
      `INSERT INTO boost_purchases (id, seller_id, offer_id, quote_id, boost_id, transaction_id, amount_xof, duration_code, idempotency_key)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, 2300, '3d', gen_random_uuid())`,
      [world.sellerId, world.offer.id, threeDays, boostId, first.transactionId]);
  }, "23514", GUARD);
  await refuse("ligne insérée déjà remboursée", { refunded: true });
  // Fenêtre du boost : durée EXACTE du code et début à l'instant de l'achat (60 s près).
  await refuse("boost de 365 jours pour un achat de 24 h", { boostSeconds: 365 * 86_400 });
  await refuse("boost d'une seconde de moins que la durée payée", { boostSeconds: 86_399 });
  await refuse("boost d'une seconde de plus que la durée payée", { boostSeconds: 86_401 });
  await refuse("boost de 3 jours pour un achat de 24 h (durée du boost = celle de la ligne, fenêtre fausse)", { boostSeconds: 259_200 });
  await refuse("début du boost 70 s avant l'achat (au-delà de la tolérance de 60 s)", { boostStartOffsetSeconds: -70 });
  await refuse("début du boost dans le futur (après l'achat)", { boostStartOffsetSeconds: 30 });
  await expectAccepted("début du boost 50 s avant l'achat (dans la tolérance)", (client) => insertKit(client, world, { boostStartOffsetSeconds: -50, boostStatus: "expired" }));

  // Cas conforme, validé au COMMIT : les déclencheurs différés (boost et transaction rattachés à leur achat) laissent passer.
  await expectAccepted("achat écrit à la main, conforme", (client) => insertKit(client, world), true);
  assert.equal(await countRows("boost_purchases", "seller_id = $1", [world.sellerId]), 1);
  assert.equal(await balanceOf(world.sellerId), big(20_000 - 2300));
  await assertWalletGreen("après un achat écrit à la main et conforme");
});

test("0015 boost_purchases : chaque CHECK, chaque unicité (cotation, boost, transaction, remboursement, clé d'idempotence) et chaque clé étrangère refuse son cas (garde désactivée le temps de l'essai, annulé ensuite)", async () => {
  const world = await setup({ credit: 50_000 });
  const second = await insertQuote(world.offer);
  const third = await insertQuote(world.offer);
  const trial = (label: string, over: KitOptions, code: string, constraint: string) => expectFailure(label, guardOff((client) => insertKit(client, world, over)), code, constraint);

  await trial("montant nul", { amount: 0, ledgerAmount: 1 }, "23514", "chk_boost_purchases_amount");
  await trial("montant négatif", { amount: -5, ledgerAmount: 1 }, "23514", "chk_boost_purchases_amount");
  await trial("montant au-delà de 2^53 - 1", { amount: Number.MAX_SAFE_INTEGER + 1, ledgerAmount: 1 }, "23514", "chk_boost_purchases_amount");
  await trial("durée inconnue", { duration: "30d", boostDuration: "24h" }, "23514", "chk_boost_purchases_duration_code");
  await trial("cotation inexistante", { quoteId: randomUUID() }, "23503", "boost_purchases_quote_id_fkey");

  // Une date de remboursement sans transaction, ou l'inverse ; une date de remboursement antérieure à l'achat.
  await expectFailure("remboursé sans transaction de remboursement", guardOff(async (client) => {
    const kit = await insertKit(client, world, { boostStatus: "expired" });
    await client.query("UPDATE boost_purchases SET refunded_at = clock_timestamp() WHERE id = $1", [kit.id]);
  }), "23514", "chk_boost_purchases_refund");
  await expectFailure("transaction de remboursement sans date", guardOff(async (client) => {
    const kit = await insertKit(client, world, { boostStatus: "expired" });
    await client.query("UPDATE boost_purchases SET refund_transaction_id = transaction_id WHERE id = $1", [kit.id]);
  }), "23514", "chk_boost_purchases_refund");
  await expectFailure("remboursement antérieur à l'achat", guardOff(async (client) => {
    const kit = await insertKit(client, world, { boostStatus: "expired" });
    await client.query("UPDATE boost_purchases SET refunded_at = created_at - interval '1 second', refund_transaction_id = transaction_id WHERE id = $1", [kit.id]);
  }), "23514", "chk_boost_purchases_refund_order");

  // Unicités : cotation, boost, transaction, transaction de remboursement, (vendeur, clé d'idempotence).
  await expectFailure("une cotation ne s'achète qu'une fois", guardOff(async (client) => {
    await insertKit(client, world, { boostStatus: "expired" });
    await insertKit(client, world, { boostStatus: "expired" });
  }), "23505", "uq_boost_purchases_quote");
  await expectFailure("(vendeur, clé d'idempotence) unique", guardOff(async (client) => {
    const key = randomUUID();
    await insertKit(client, world, { boostStatus: "expired", key });
    await insertKit(client, world, { boostStatus: "expired", key, quoteId: second });
  }), "23505", "uq_boost_purchases_seller_idempotency");
  await expectFailure("un boost ne sert qu'un achat", guardOff(async (client) => {
    const kit = await insertKit(client, world, { boostStatus: "expired" });
    await client.query(
      `INSERT INTO boost_purchases (id, seller_id, offer_id, quote_id, boost_id, transaction_id, amount_xof, duration_code, idempotency_key)
       SELECT gen_random_uuid(), seller_id, offer_id, $2, boost_id, gen_random_uuid(), amount_xof, duration_code, gen_random_uuid() FROM boost_purchases WHERE id = $1`, [kit.id, second]);
  }), "23505", "uq_boost_purchases_boost");
  await expectFailure("une transaction ne sert qu'un achat", guardOff(async (client) => {
    const kit = await insertKit(client, world, { boostStatus: "expired" });
    const boostId = randomUUID();
    await client.query(
      `INSERT INTO offer_boosts (id, offer_id, seller_id, scope_category, scope_brand, scope_model, status, duration_code, starts_at, ends_at, source)
       VALUES ($1, $2, $3, $4, $5, $6, 'expired', '24h', clock_timestamp(), clock_timestamp() + interval '1 day', 'purchase')`,
      [boostId, world.offer.id, world.sellerId, world.scope.category, world.scope.brand, world.scope.model]);
    await client.query(
      `INSERT INTO boost_purchases (id, seller_id, offer_id, quote_id, boost_id, transaction_id, amount_xof, duration_code, idempotency_key)
       SELECT gen_random_uuid(), seller_id, offer_id, $2, $3, transaction_id, amount_xof, duration_code, gen_random_uuid() FROM boost_purchases WHERE id = $1`, [kit.id, third, boostId]);
  }), "23505", "uq_boost_purchases_transaction");
  await expectFailure("une transaction de remboursement ne sert qu'un achat", guardOff(async (client) => {
    const first = await insertKit(client, world, { boostStatus: "expired" });
    const secondKit = await insertKit(client, world, { boostStatus: "expired", quoteId: second });
    await client.query("UPDATE boost_purchases SET refunded_at = clock_timestamp(), refund_transaction_id = $2 WHERE id = $1", [first.id, first.transactionId]);
    await client.query("UPDATE boost_purchases SET refunded_at = clock_timestamp(), refund_transaction_id = $2 WHERE id = $1", [secondKit.id, first.transactionId]);
  }), "23505", "uq_boost_purchases_refund_transaction");

  // Clés étrangères (la garde étant désactivée, c'est la clé qui refuse la valeur inexistante).
  for (const [label, constraint, column] of [
    ["vendeur inexistant", "boost_purchases_seller_id_fkey", "seller_id"], ["offre inexistante", "boost_purchases_offer_id_fkey", "offer_id"],
    ["boost inexistant", "boost_purchases_boost_id_fkey", "boost_id"], ["transaction inexistante", "boost_purchases_transaction_id_fkey", "transaction_id"],
  ] as Array<[string, string, string]>) {
    await expectFailure(label, guardOff(async (client) => {
      const kit = await insertKit(client, world, { boostStatus: "expired" });
      await client.query(`UPDATE boost_purchases SET ${column} = $2::uuid WHERE id = $1`, [kit.id, randomUUID()]);
    }), "23503", constraint);
  }
  await expectFailure("transaction de remboursement inexistante", guardOff(async (client) => {
    const kit = await insertKit(client, world, { boostStatus: "expired" });
    await client.query("UPDATE boost_purchases SET refunded_at = clock_timestamp(), refund_transaction_id = $2 WHERE id = $1", [kit.id, randomUUID()]);
  }), "23503", "boost_purchases_refund_transaction_id_fkey");
  // Rien n'a été validé par ces essais.
  assert.equal(await countRows("boost_purchases", "seller_id = $1", [world.sellerId]), 0);
});

test("0015 boost_purchases : après la création, tout champ est figé ; seul le passage unique « non remboursé → remboursé » est permis, avec la transaction de remboursement du montant intégral ; jamais de suppression", async () => {
  const world = await setup({ credit: 50_000 });
  const refundSql = (client: PoolClient, purchaseId: string, amount: number, over: { sign?: 1 | -1; reference?: string } = {}) => (async () => {
    const transactionId = randomUUID();
    await client.query("INSERT INTO wallet_transactions (id, kind, reference, metadata) VALUES ($1, 'boost_refund', $2, $3::jsonb)",
      [transactionId, over.reference ?? `boost_refund:${purchaseId}`, JSON.stringify({ boostPurchaseId: purchaseId, reasonCode: "customer_request" })]);
    const user = await userAccountId(client, world.sellerId);
    const revenue = await systemAccountId(client, "boost_revenue");
    const sign = over.sign ?? 1;
    await client.query("INSERT INTO wallet_entries (id, transaction_id, account_id, amount) VALUES (gen_random_uuid(), $1, $2, $3::bigint)", [transactionId, revenue, String(-sign * amount)]);
    await client.query("INSERT INTO wallet_entries (id, transaction_id, account_id, amount) VALUES (gen_random_uuid(), $1, $2, $3::bigint)", [transactionId, user, String(sign * amount)]);
    return transactionId;
  })();
  const markRefunded = (client: PoolClient, purchaseId: string, transactionId: string) =>
    client.query("UPDATE boost_purchases SET refunded_at = clock_timestamp(), refund_transaction_id = $2 WHERE id = $1", [purchaseId, transactionId]);

  const inTx = (operation: (client: PoolClient, kit: { id: string; boostId: string; transactionId: string }) => Promise<unknown>, commit = false) =>
    failureOf(async (client) => { const kit = await insertKit(client, world, { boostStatus: "expired" }); await operation(client, kit); }, commit);
  const expectRefusal = async (label: string, operation: (client: PoolClient, kit: { id: string; boostId: string; transactionId: string }) => Promise<unknown>, code: string, constraint?: string) => {
    const failure = await inTx(operation);
    assert.ok(failure, `${label} : un refus était attendu`);
    assert.equal(failure.code, code, `${label} : ${JSON.stringify(failure)}`);
    if (constraint) assert.equal(failure.constraint, constraint, label);
  };

  // Champs figés : « restrict_violation » (23001).
  const frozen: Array<[string, string, string]> = [
    ["identifiant", "id = gen_random_uuid()", ""], ["montant", "amount_xof = amount_xof + 1", ""], ["durée", "duration_code = '3d'", ""],
    ["clé d'idempotence", "idempotency_key = gen_random_uuid()", ""], ["date de création", "created_at = created_at + interval '1 second'", ""],
    ["vendeur", `seller_id = '${randomUUID()}'`, ""], ["offre", `offer_id = '${randomUUID()}'`, ""], ["cotation", `quote_id = '${randomUUID()}'`, ""],
    ["boost", `boost_id = '${randomUUID()}'`, ""], ["transaction", `transaction_id = '${randomUUID()}'`, ""],
  ];
  for (const [label, assignment] of frozen) {
    await expectRefusal(`champ figé : ${label}`, (client, kit) => client.query(`UPDATE boost_purchases SET ${assignment} WHERE id = $1`, [kit.id]), "23001");
  }
  await expectRefusal("mise à jour sans effet (aucune transition)", (client, kit) => client.query("UPDATE boost_purchases SET created_at = created_at WHERE id = $1", [kit.id]), "23514", GUARD);
  await expectRefusal("suppression", (client, kit) => client.query("DELETE FROM boost_purchases WHERE id = $1", [kit.id]), "23001");
  // Remboursement : la transaction doit être celle du montant INTÉGRAL, du bon type, avec la bonne référence et les bons comptes.
  await expectRefusal("remboursement qui pointe la transaction d'achat elle-même", (client, kit) => markRefunded(client, kit.id, kit.transactionId), "23514", GUARD);
  await expectRefusal("remboursement partiel (1 000 sur 2 300)", async (client, kit) => markRefunded(client, kit.id, await refundSql(client, kit.id, 1000)), "23514", GUARD);
  await expectRefusal("remboursement supérieur au montant payé", async (client, kit) => markRefunded(client, kit.id, await refundSql(client, kit.id, 2400)), "23514", GUARD);
  await expectRefusal("remboursement de signe inversé (le vendeur serait débité deux fois)", async (client, kit) => markRefunded(client, kit.id, await refundSql(client, kit.id, 2300, { sign: -1 })), "23514", GUARD);
  await expectRefusal("remboursement sans date (transaction seule)", async (client, kit) => {
    const transactionId = await refundSql(client, kit.id, 2300);
    await client.query("UPDATE boost_purchases SET refund_transaction_id = $2 WHERE id = $1", [kit.id, transactionId]);
  }, "23514", GUARD);
  await expectRefusal("deuxième remboursement du même achat", async (client, kit) => {
    await markRefunded(client, kit.id, await refundSql(client, kit.id, 2300));
    const other = randomUUID();
    await client.query("INSERT INTO wallet_transactions (id, kind, reference, metadata) VALUES ($1, 'boost_refund', $2, $3::jsonb)", [other, `boost_refund:${kit.id}`, JSON.stringify({ boostPurchaseId: kit.id, reasonCode: "again" })]);
  }, "23505", "uq_wallet_transactions_reference");
  await expectRefusal("deuxième remboursement : la ligne ne se remet pas à jour", async (client, kit) => {
    await markRefunded(client, kit.id, await refundSql(client, kit.id, 2300));
    await client.query("UPDATE boost_purchases SET refunded_at = clock_timestamp() + interval '1 second' WHERE id = $1", [kit.id]);
  }, "23514", GUARD);
  await expectRefusal("annulation du remboursement (retour à non remboursé)", async (client, kit) => {
    await markRefunded(client, kit.id, await refundSql(client, kit.id, 2300));
    await client.query("UPDATE boost_purchases SET refunded_at = NULL, refund_transaction_id = NULL WHERE id = $1", [kit.id]);
  }, "23514", GUARD);

  // Le remboursement conforme est accepté, et validé au COMMIT (déclencheur différé : la transaction de remboursement a son achat).
  assert.equal(await inTx(async (client, kit) => { await markRefunded(client, kit.id, await refundSql(client, kit.id, 2300)); }), null, "remboursement conforme");
  assert.equal(await inTx(async (client, kit) => { await markRefunded(client, kit.id, await refundSql(client, kit.id, 2300)); }, true), null, "remboursement conforme validé");
  assert.equal(await countRows("boost_purchases", "seller_id = $1 AND refunded_at IS NOT NULL", [world.sellerId]), 1);
  await assertWalletGreen("après un achat écrit à la main puis remboursé à la main");

  // Déclencheurs différés : une transaction de remboursement ou d'achat n'existe pas sans son achat.
  const orphanRefund = await failureOf(async (client) => {
    const kit = await insertKit(client, world, { boostStatus: "expired", quoteId: await insertQuote(world.offer) });
    await refundSql(client, kit.id, 2300);
  }, true);
  assert.deepEqual(orphanRefund, { code: "23514", constraint: "trg_boost_purchases_linked" }, "remboursement sans achat marqué remboursé : refusé au COMMIT");
  const orphanPurchase = await failureOf(async (client) => {
    const kit = await insertKit(client, world, { boostStatus: "expired", quoteId: await insertQuote(world.offer) });
    await client.query("ALTER TABLE boost_purchases DISABLE TRIGGER trg_boost_purchases_guard");
    await client.query("DELETE FROM boost_purchases WHERE id = $1", [kit.id]);
  }, true);
  assert.deepEqual(orphanPurchase, { code: "23514", constraint: "trg_boost_purchases_linked" }, "achat dont la ligne a disparu : le boost et la transaction ne passent pas au COMMIT");
});

// ═════════════ 2. Validation avant tout SQL ═════════════

test("purchaseOfferBoost, refundBoostPurchase, listOfferBoostPurchases : validation complète AVANT tout SQL (aucune requête ni connexion) ; casse des UUID tolérée", async () => {
  const { spy, count } = observedPool();
  const good = { pool: spy, sellerId: randomUUID(), offerId: randomUUID(), quoteId: randomUUID(), idempotencyKey: randomUUID() };
  const rejects = (override: Record<string, unknown>) =>
    assert.rejects(purchaseOfferBoost({ ...good, ...override } as never), (error: unknown) => error instanceof CatalogValidationError, JSON.stringify(Object.keys(override)));
  await rejects({ pool: undefined });
  await rejects({ pool: null });
  await rejects({ pool: {} });
  for (const field of ["sellerId", "offerId", "quoteId", "idempotencyKey"]) {
    await rejects({ [field]: "pas-un-uuid" });
    await rejects({ [field]: undefined });
    await rejects({ [field]: "" });
  }
  const refundGood = { pool: spy, purchaseId: randomUUID(), reasonCode: "customer_request" };
  const refundRejects = (override: Record<string, unknown>) =>
    assert.rejects(refundBoostPurchase({ ...refundGood, ...override } as never), (error: unknown) => error instanceof CatalogValidationError, JSON.stringify(override));
  await refundRejects({ pool: undefined });
  await refundRejects({ purchaseId: "x" });
  for (const reasonCode of ["", "Majuscule", "avec espace", "a".repeat(41), "tiret-interdit", "é", undefined, 12, null]) await refundRejects({ reasonCode });
  const listGood = { pool: spy, sellerId: randomUUID(), offerId: randomUUID(), limit: 20 };
  const listRejects = (override: Record<string, unknown>) =>
    assert.rejects(listOfferBoostPurchases({ ...listGood, ...override } as never), (error: unknown) => error instanceof CatalogValidationError, JSON.stringify(override));
  await listRejects({ pool: undefined });
  await listRejects({ sellerId: "x" });
  await listRejects({ offerId: "x" });
  for (const limit of [0, 51, -1, 1.5, "20", undefined, Number.NaN]) await listRejects({ limit });
  assert.equal(count(), 0, "aucune requête SQL avant la validation");

  const world = await setup();
  const upper = await purchaseOfferBoost({
    pool, sellerId: world.sellerId.toUpperCase(), offerId: world.offer.id.toUpperCase(), quoteId: world.quoteId.toUpperCase(), idempotencyKey: randomUUID().toUpperCase(),
  });
  assert.equal(upper.purchase.offerId, world.offer.id);
  assert.equal(upper.purchase.quoteId, world.quoteId);
  assert.equal(upper.purchase.idempotencyKey, upper.purchase.idempotencyKey.toLowerCase());
});

// ═════════════ 3. Achat nominal ═════════════

test("achat nominal : prix = montant de la cotation, durée de la cotation, boost « purchase » actif, débit + crédit boost_revenue en deux écritures, solde exact, historique, wallet:check vert", async () => {
  const world = await setup({ credit: 0, quote: { amount: 2300, durationCode: "3d" } });
  await fundByTopup(world.sellerId, 5000);
  assert.equal(await balanceOf(world.sellerId), big(5000));
  const revenueBefore = await revenueBalance();
  const slotsBefore = await readBoostSlots({ pool, offerId: world.offer.id });
  assert.equal(slotsBefore.used, 0);
  const key = randomUUID();

  const result = await buy(world, { idempotencyKey: key });
  assert.equal(result.reused, false);
  assert.equal(result.purchase.sellerId, world.sellerId);
  assert.equal(result.purchase.offerId, world.offer.id);
  assert.equal(result.purchase.quoteId, world.quoteId);
  assert.equal(result.purchase.durationCode, "3d");
  assert.equal(result.purchase.amount, big(2300), "le prix est exactement le montant de la cotation");
  assert.equal(result.purchase.idempotencyKey, key);
  assert.equal(result.purchase.refundedAt, null);
  assert.equal(result.purchase.refundTransactionId, null);
  assert.equal(result.purchase.boostId, result.boost.id);
  assert.equal(result.balance, big(2700));
  assert.equal(await balanceOf(world.sellerId), big(2700));
  assert.equal(await revenueBalance() - revenueBefore, big(2300));

  const boost = result.boost;
  assert.equal(boost.source, "purchase");
  assert.equal(boost.status, "active");
  assert.equal(boost.durationCode, "3d");
  assert.equal(boost.sellerId, world.sellerId);
  assert.equal(boost.offerId, world.offer.id);
  assert.deepEqual(boost.scope, world.scope);
  assert.equal(boost.endsAt.getTime() - boost.startsAt.getTime(), 259_200_000, "3 jours exactement");
  assert.equal(boost.cancelledAt, null);
  const effective = (await pool.query<{ effective: boolean; fresh: boolean }>(
    "SELECT (status = 'active' AND starts_at <= clock_timestamp() AND clock_timestamp() < ends_at) AS effective, abs(extract(epoch FROM clock_timestamp() - starts_at)) < 30 AS fresh FROM offer_boosts WHERE id = $1", [boost.id])).rows[0];
  assert.deepEqual(effective, { effective: true, fresh: true }, "le boost commence à l'horloge de la base");
  assert.equal((await readBoostSlots({ pool, offerId: world.offer.id })).used, 1);

  // Le grand livre : une transaction `boost_purchase`, deux écritures, métadonnées exactes.
  const transaction = (await pool.query<{ kind: string; reference: string; metadata: Record<string, string> }>(
    "SELECT kind, reference, metadata FROM wallet_transactions WHERE id = $1", [result.purchase.transactionId])).rows[0];
  assert.equal(transaction.kind, "boost_purchase");
  assert.equal(transaction.reference, `boost_purchase:${result.purchase.id}`);
  assert.deepEqual(transaction.metadata, { boostPurchaseId: result.purchase.id, quoteId: world.quoteId });
  const entries = (await pool.query<{ kind: string; owner_id: string | null; amount: string }>(
    `SELECT a.kind, a.owner_id, e.amount::text AS amount FROM wallet_entries e JOIN wallet_accounts a ON a.id = e.account_id
      WHERE e.transaction_id = $1 ORDER BY e.amount`, [result.purchase.transactionId])).rows;
  assert.deepEqual(entries, [
    { kind: "user", owner_id: world.sellerId, amount: "-2300" },
    { kind: "boost_revenue", owner_id: null, amount: "2300" },
  ]);

  // L'historique du vendeur (sans identifiant de boost ni de transaction) et le portefeuille (montant signé côté utilisateur).
  const history = await listOfferBoostPurchases({ pool, sellerId: world.sellerId, offerId: world.offer.id, limit: 10 });
  assert.equal(history.length, 1);
  assert.deepEqual(Object.keys(history[0]).sort(), ["amount", "createdAt", "durationCode", "endsAt", "id", "promoAmount", "quoteId", "refundedAt", "startsAt"]);
  assert.equal(history[0].id, result.purchase.id);
  assert.equal(history[0].amount, big(2300));
  assert.equal(history[0].startsAt.getTime(), boost.startsAt.getTime());
  const overview = await readWalletOverview({ pool, ownerId: world.sellerId });
  assert.deepEqual(overview.items.map((item) => [item.kind, item.amount]), [["boost_purchase", -big(2300)], ["topup", big(5000)]]);
  assert.equal(overview.balance, big(2700));
  await assert.rejects(listOfferBoostPurchases({ pool, sellerId: (await makeUser()), offerId: world.offer.id, limit: 5 }), (error: unknown) => error instanceof BoostError && error.code === "offer_not_owned");
  await assert.rejects(listOfferBoostPurchases({ pool, sellerId: world.sellerId, offerId: randomUUID(), limit: 5 }), (error: unknown) => error instanceof BoostError && error.code === "offer_not_found");
  await assertWalletGreen("après un achat nominal");
});

test("prix = montant de la cotation, jamais recalculé : un changement de tarif ou de marché entre la cotation et l'achat ne change pas le débit ; solde exact permis", async () => {
  const world = await setup({ credit: 2300, quote: { amount: 2300, durationCode: "24h" } });
  // Une nouvelle tarification (base 9 000) et des acheteurs en plus : une cotation recalculée donnerait un autre prix.
  await pool.query(
    `INSERT INTO boost_pricing_settings (key, version, currency, base_amount, grid_amount, min_amount, max_amount, competition_step_milli, competition_max_milli,
       demand_step_milli, demand_max_milli, scarcity_max_milli, duration_24h_milli, duration_3d_milli, duration_7d_milli, quote_validity_seconds)
     VALUES ($1, 1, 'XOF', 9000, 100, 500, 50000, 20, 1500, 100, 3000, 2000, 1000, 2500, 5000, 900)`, [world.scope.category]);
  const result = await buy(world);
  assert.equal(result.purchase.amount, big(2300));
  assert.equal(result.balance, big(0), "le solde exact suffit");
  assert.equal(await balanceOf(world.sellerId), big(0));
  await pool.query("DELETE FROM boost_pricing_settings WHERE key = $1", [world.scope.category]);
  await assertWalletGreen("solde exact");
});

// ═════════════ 4. Refus : chaque cause a son code et ne laisse AUCUNE trace ═════════════

async function expectRefusal(label: string, run: () => Promise<unknown>, code: string): Promise<void> {
  const before = await ledgerSnapshot();
  assert.equal(await outcome(run()), code, label);
  assert.deepEqual(await ledgerSnapshot(), before, `${label} : ni débit, ni boost, ni achat, ni compte créé`);
}

test("refus de cotation : expirée, indisponible, d'une autre offre ou d'un autre vendeur ou inexistante (404 indiscernables), déjà achetée, périmètre changé, offre d'autrui ; ordre des contrôles", async () => {
  const world = await setup({ credit: 20_000 });
  const stranger = await setup({ credit: 20_000 });

  // Cotation échue (horloge de la base, par SQL de test sur expires_at) ; échéance dans le futur proche : acceptée.
  const expired = await insertQuote(world.offer, { expiresInSeconds: 900 });
  await pool.query("UPDATE boost_quotes SET computed_at = clock_timestamp() - interval '2 hours', expires_at = clock_timestamp() - interval '1 hour' WHERE id = $1", [expired]);
  await expectRefusal("cotation échue", () => buy(world, { quoteId: expired }), "quote_expired");
  const justExpired = await insertQuote(world.offer, { expiresInSeconds: 900 });
  await pool.query("UPDATE boost_quotes SET computed_at = clock_timestamp() - interval '2 hours', expires_at = clock_timestamp() - interval '1 millisecond' WHERE id = $1", [justExpired]);
  await expectRefusal("cotation échue il y a une milliseconde", () => buy(world, { quoteId: justExpired }), "quote_expired");
  const unavailable = await insertQuote(world.offer, { status: "unavailable" });
  await expectRefusal("cotation indisponible (aucun prix)", () => buy(world, { quoteId: unavailable }), "quote_unavailable");
  const unavailableAndExpired = await insertQuote(world.offer, { status: "unavailable" });
  await pool.query("UPDATE boost_quotes SET computed_at = clock_timestamp() - interval '2 hours', expires_at = clock_timestamp() - interval '1 hour' WHERE id = $1", [unavailableAndExpired]);
  await expectRefusal("indisponible ET échue : l'indisponibilité prime (ordre des contrôles)", () => buy(world, { quoteId: unavailableAndExpired }), "quote_unavailable");

  // 404 indiscernables : cotation inexistante, d'une autre offre (même vendeur), d'un autre vendeur, offre inexistante.
  const sibling = await makeOffer({ ownerId: world.sellerId });
  const siblingQuote = await insertQuote(sibling);
  await expectRefusal("cotation inexistante", () => buy(world, { quoteId: randomUUID() }), "quote_not_found");
  await expectRefusal("cotation d'une autre offre du même vendeur", () => buy(world, { quoteId: siblingQuote }), "quote_not_found");
  await expectRefusal("cotation d'un autre vendeur", () => buy(world, { quoteId: stranger.quoteId }), "quote_not_found");
  await expectRefusal("offre inexistante", () => buy(world, { offerId: randomUUID() }), "quote_not_found");
  await expectRefusal("offre d'un autre vendeur avec sa propre cotation", () => buy(world, { offerId: stranger.offer.id }), "quote_not_found");
  // Cotation fabriquée au nom du vendeur sur l'offre d'un autre : l'offre n'est pas à lui.
  const forged = await insertQuote(stranger.offer, { sellerId: world.sellerId });
  await expectRefusal("cotation au nom du vendeur sur l'offre d'autrui : offer_not_owned", () => buy(world, { offerId: stranger.offer.id, quoteId: forged }), "offer_not_owned");

  // Le périmètre de l'offre a changé depuis la cotation : le prix ne vaut plus (quote_expired).
  const moved = await setup({ credit: 20_000 });
  await pool.query("UPDATE offers SET model = 'autre modele' WHERE id = $1", [moved.offer.id]);
  await expectRefusal("périmètre de l'offre changé depuis la cotation", () => buy(moved), "quote_expired");

  // Déjà achetée (même après remboursement : un devis ne s'achète qu'une fois).
  const done = await setup({ credit: 20_000 });
  const first = await buy(done);
  await expectRefusal("cotation déjà achetée (autre clé)", () => buy(done), "quote_already_used");
  await refundBoostPurchase({ pool, purchaseId: first.purchase.id, reasonCode: "customer_request" });
  await expectRefusal("cotation déjà achetée puis remboursée", () => buy(done), "quote_already_used");

  // Priorité : une cotation échue prime sur une offre devenue inéligible.
  const both = await setup({ credit: 20_000 });
  await pool.query("UPDATE boost_quotes SET computed_at = clock_timestamp() - interval '2 hours', expires_at = clock_timestamp() - interval '1 hour' WHERE id = $1", [both.quoteId]);
  await pool.query("UPDATE offers SET status = 'paused' WHERE id = $1", [both.offer.id]);
  await expectRefusal("cotation échue et offre en pause", () => buy(both), "quote_expired");
  await assertWalletGreen("après des refus de cotation");
});

test("refus d'offre : en pause, archivée, indisponible, vendeur suspendu ou archivé (offer_not_eligible), clé produit effacée (offer_not_boostable), déjà boostée, plus de place, plafond vendeur ; jamais de débit", async () => {
  // Inéligibilité : chaque cause, entre la cotation et l'achat.
  const causes: Array<[string, (world: Setup) => Promise<unknown>]> = [
    ["en pause", (world) => pool.query("UPDATE offers SET status = 'paused' WHERE id = $1", [world.offer.id])],
    ["archivée", (world) => pool.query("UPDATE offers SET status = 'archived', archived_at = clock_timestamp() WHERE id = $1", [world.offer.id])],
    ["indisponible", (world) => pool.query("UPDATE offers SET availability_status = 'unavailable' WHERE id = $1", [world.offer.id])],
    ["vendeur suspendu", (world) => pool.query("UPDATE users SET status = 'suspended' WHERE id = $1", [world.sellerId])],
    ["vendeur archivé", (world) => pool.query("UPDATE users SET status = 'archived', archived_at = clock_timestamp() WHERE id = $1", [world.sellerId])],
  ];
  for (const [label, change] of causes) {
    const world = await setup({ credit: 10_000 });
    await change(world);
    await expectRefusal(`offre ${label} entre la cotation et l'achat`, () => buy(world), "offer_not_eligible");
  }
  const blank = await setup({ credit: 10_000 });
  await pool.query("UPDATE offers SET model = '   ' WHERE id = $1", [blank.offer.id]);
  await expectRefusal("clé produit effacée (modèle blanc)", () => buy(blank), "offer_not_boostable");

  // Offre déjà boostée (attribution d'administration après la cotation) : aucune seconde place consommée, aucun débit.
  const boosted = await setup({ credit: 10_000 });
  await grantOfferBoost({ pool, offerId: boosted.offer.id, ownerId: boosted.sellerId, durationCode: "24h", source: "admin_grant" });
  await expectRefusal("offre déjà boostée", () => buy(boosted), "offer_already_boosted");

  // Plus de place : le périmètre n'a qu'une place (2 offres), prise par un autre vendeur.
  const full = await setup({ credit: 10_000, offers: 2 });
  const rival = await makeOffer({ scope: full.scope });
  await grantOfferBoost({ pool, offerId: rival.id, ownerId: rival.ownerId, durationCode: "24h", source: "admin_grant" });
  await expectRefusal("plus aucune place", () => buy(full), "no_slot_available");
  // Priorité (comme l'attribution) : « plus de place » prime sur « plafond vendeur ».
  const second = await makeOffer({ ownerId: full.sellerId, scope: full.scope });
  const secondQuote = await insertQuote(second);
  await expectRefusal("plus de place, prioritaire sur le plafond vendeur", () => buy({ ...full, offer: second, quoteId: secondQuote }), "no_slot_available");

  // Plafond vendeur : places en abondance, plafond de 1 boost par vendeur ; le second achat du même vendeur est refusé.
  const limited = await setup({ credit: 20_000 });
  await setCategorySettings(limited.scope.category, { slot_ratio: 0.5, min_slots: 8, max_slots: 20, max_active_per_seller: 1, max_seller_slot_share: 1 });
  try {
    const twin = await makeOffer({ ownerId: limited.sellerId, scope: limited.scope });
    const twinQuote = await insertQuote(twin);
    const accepted = await buy(limited);
    assert.equal(accepted.boost.source, "purchase");
    await expectRefusal("plafond de boosts du vendeur atteint", () => buy({ ...limited, offer: twin, quoteId: twinQuote }), "seller_boost_limit_reached");
    // Un autre vendeur du même périmètre reste servi (le plafond est PAR vendeur).
    const neighbourOffer = await makeOffer({ scope: limited.scope });
    await fund(neighbourOffer.ownerId, 5000);
    const served = await buy({ sellerId: neighbourOffer.ownerId, offer: neighbourOffer, quoteId: await insertQuote(neighbourOffer) });
    assert.equal(served.boost.source, "purchase");
  } finally {
    await pool.query("DELETE FROM boost_settings WHERE key = $1", [limited.scope.category]);
  }

  // Solde insuffisant : sans compte, trop court d'un XOF ; aucune trace (même pas un compte créé).
  const poor = await setup({ credit: 0 });
  await expectRefusal("aucun crédit, aucun compte", () => buy(poor), "insufficient_balance");
  const short = await setup({ credit: 2299 });
  await expectRefusal("2 299 XOF pour un boost de 2 300", () => buy(short), "insufficient_balance");
  assert.equal(await balanceOf(short.sellerId), big(2299));
  await assertWalletGreen("après des refus d'offre et de solde");
});

// ═════════════ 5. Idempotence ═════════════

test("idempotence : même clé et même cotation → même achat (reused, aucun nouveau débit, même après l'expiration de la cotation) ; autre cotation ou autre offre → idempotency_conflict ; clés indépendantes entre vendeurs", async () => {
  const world = await setup({ credit: 20_000 });
  const key = randomUUID();
  const first = await buy(world, { idempotencyKey: key });
  assert.equal(first.reused, false);
  const snapshot = await ledgerSnapshot();
  const replay = await buy(world, { idempotencyKey: key.toUpperCase() });
  assert.equal(replay.reused, true);
  assert.equal(replay.purchase.id, first.purchase.id);
  assert.equal(replay.boost.id, first.boost.id);
  assert.equal(replay.boost.startsAt.getTime(), first.boost.startsAt.getTime());
  assert.equal(replay.boost.endsAt.getTime(), first.boost.endsAt.getTime());
  assert.equal(replay.balance, first.balance, "aucun second débit");
  assert.deepEqual(await ledgerSnapshot(), snapshot, "le rejeu n'écrit rien");

  // La cotation expire : le rejeu de la MÊME requête renvoie toujours l'achat (il ne reconsulte pas la cotation).
  await pool.query("UPDATE boost_quotes SET computed_at = clock_timestamp() - interval '2 hours', expires_at = clock_timestamp() - interval '1 hour' WHERE id = $1", [world.quoteId]);
  const late = await buy(world, { idempotencyKey: key });
  assert.equal(late.reused, true);
  assert.equal(late.purchase.id, first.purchase.id);

  // Même clé, autre cotation de la même offre : conflit (et rien n'est écrit) ; même clé pour une autre offre du vendeur : conflit.
  const otherQuote = await insertQuote(world.offer);
  await expectRefusal("même clé, autre cotation", () => buy(world, { idempotencyKey: key, quoteId: otherQuote }), "idempotency_conflict");
  const sibling = await makeOffer({ ownerId: world.sellerId });
  const siblingQuote = await insertQuote(sibling);
  await expectRefusal("même clé, autre offre", () => buy({ sellerId: world.sellerId, offer: sibling, quoteId: siblingQuote }, { idempotencyKey: key }), "idempotency_conflict");
  await expectRefusal("même clé, cotation inexistante", () => buy(world, { idempotencyKey: key, quoteId: randomUUID() }), "idempotency_conflict");
  // Même clé ET même cotation mais pour une AUTRE offre : ce n'est pas le même achat (jamais renvoyé comme un rejeu).
  await expectRefusal("même clé, MÊME cotation, autre offre du vendeur", () => buy({ sellerId: world.sellerId, offer: sibling, quoteId: world.quoteId }, { idempotencyKey: key }), "idempotency_conflict");

  // Une clé est propre à un vendeur : un autre vendeur peut utiliser la même valeur pour son propre achat.
  const neighbour = await setup({ credit: 20_000 });
  const own = await buy(neighbour, { idempotencyKey: key });
  assert.equal(own.reused, false);
  assert.notEqual(own.purchase.id, first.purchase.id);

  // Deux clés différentes pour deux cotations différentes d'une même offre : le second achat est refusé (offre déjà boostée), sans débit.
  await expectRefusal("deuxième achat sur une offre déjà boostée par achat", () => buy(world, { quoteId: otherQuote }), "offer_already_boosted");
  assert.equal(await countRows("boost_purchases", "seller_id = $1", [world.sellerId]), 1);
  await assertWalletGreen("après des rejeux");
});

test("concurrence : 20 rejeux SIMULTANÉS de la même requête (verrou d'idempotence, 19 sessions en attente prouvées) → un seul achat, un seul débit, 20 réponses de même identifiant dont une seule `reused: false`", async () => {
  const world = await setup({ credit: 10_000, quote: { amount: 2300 } });
  const key = randomUUID();
  const waiting: number[] = [];
  const results = await Promise.all(Array.from({ length: 20 }, (_, index) => outcome2(buy(world, {
    idempotencyKey: key, db: widePool,
    // Le premier à entrer dans la section critique attend que les 19 autres soient bloqués sur le verrou : la contention est réelle.
    hooks: { beforeDebit: async () => { waiting.push(await waitForLockWaiters(19, 4000)); } },
  }), index)));
  const failures = results.filter((entry) => entry.error);
  assert.deepEqual(failures.map((entry) => entry.error), [], "aucun rejeu ne doit échouer");
  assert.deepEqual(waiting, [19], "la section critique a vu 19 sessions en attente du verrou d'idempotence");
  const ids = new Set(results.map((entry) => entry.value!.purchase.id));
  assert.equal(ids.size, 1);
  assert.equal(results.filter((entry) => entry.value!.reused === false).length, 1, "une seule création");
  assert.equal(results.filter((entry) => entry.value!.reused === true).length, 19);
  assert.equal(await countRows("boost_purchases", "seller_id = $1", [world.sellerId]), 1);
  assert.equal(await countRows("offer_boosts", "seller_id = $1", [world.sellerId]), 1);
  assert.equal(await countRows("wallet_transactions", "kind = 'boost_purchase' AND metadata ->> 'quoteId' = $1", [world.quoteId]), 1);
  assert.equal(await balanceOf(world.sellerId), big(7700), "un seul débit de 2 300");
  assert.ok(results.every((entry) => entry.value!.balance === big(7700)), "chaque réponse porte le même solde");
  await assertWalletGreen("après 20 rejeux simultanés");
});

async function outcome2<T>(promise: Promise<T>, index: number): Promise<{ index: number; value?: T; error?: string }> {
  try { return { index, value: await promise }; } catch (error) {
    return { index, error: error instanceof BoostError || error instanceof WalletError ? error.code : `${(error as Error).name}: ${(error as Error).message}` };
  }
}

// ═════════════ 6. Concurrence ═════════════

test("concurrence : deux cotations DIFFÉRENTES de la même offre achetées en parallèle → un seul boost, un seul débit ; l'autre reçoit offer_already_boosted sans aucun débit", async () => {
  const world = await setup({ credit: 10_000, quote: { amount: 2000 } });
  const secondQuote = await insertQuote(world.offer, { amount: 3000 });
  const pools = await distinctPools(2);
  const waiting: number[] = [];
  const hooks = { beforeDebit: async () => { waiting.push(await waitForLockWaiters(1, 3000)); } };
  const results = await Promise.all([
    outcome2(buy(world, { db: pools[0], hooks }), 0),
    outcome2(buy(world, { db: pools[1], quoteId: secondQuote, hooks }), 1),
  ]);
  assert.deepEqual(results.map((entry) => entry.error ?? "ok").sort(), ["offer_already_boosted", "ok"]);
  assert.equal(waiting.length, 1, "un seul achat atteint le débit : l'autre est bloqué derrière le verrou du périmètre");
  assert.ok(waiting[0] >= 1, "…et il a vu l'autre en attente");
  const winner = results.find((entry) => entry.value)!.value!;
  assert.equal(await countRows("boost_purchases", "seller_id = $1", [world.sellerId]), 1);
  assert.equal(await countRows("offer_boosts", "offer_id = $1", [world.offer.id]), 1);
  assert.equal(await balanceOf(world.sellerId), big(10_000) - winner.purchase.amount, "un seul débit");
  const loserQuote = winner.purchase.quoteId === world.quoteId ? secondQuote : world.quoteId;
  assert.equal(await countRows("boost_purchases", "quote_id = $1", [loserQuote]), 0, "la cotation perdante n'est pas consommée");
  await assertWalletGreen("après deux cotations d'une même offre en parallèle");
});

test("concurrence : la MÊME cotation avec deux clés d'idempotence différentes en parallèle → un seul achat (le second reçoit quote_already_used), jamais un second débit", async () => {
  const world = await setup({ credit: 10_000, quote: { amount: 2300 } });
  const pools = await distinctPools(2);
  const waiting: number[] = [];
  const hooks = { beforeDebit: async () => { waiting.push(await waitForLockWaiters(1, 3000)); } };
  const results = await Promise.all([
    outcome2(buy(world, { db: pools[0], idempotencyKey: randomUUID(), hooks }), 0),
    outcome2(buy(world, { db: pools[1], idempotencyKey: randomUUID(), hooks }), 1),
  ]);
  assert.deepEqual(results.map((entry) => entry.error ?? "ok").sort(), ["ok", "quote_already_used"], "la cotation relue sous le verrou du périmètre est déjà consommée");
  assert.equal(waiting.length, 1);
  assert.ok(waiting[0] >= 1);
  assert.equal(await countRows("boost_purchases", "quote_id = $1", [world.quoteId]), 1);
  assert.equal(await countRows("offer_boosts", "offer_id = $1", [world.offer.id]), 1);
  assert.equal(await balanceOf(world.sellerId), big(7700), "un seul débit");
  await assertWalletGreen("après deux clés pour une même cotation");
});

test("concurrence : deux vendeurs se disputent la DERNIÈRE place → pas de survente, le perdant n'est PAS débité", async () => {
  const scope = makeScope();
  const alice = await makeOffer({ scope });
  const bob = await makeOffer({ scope });                // 2 offres → 1 place (ceil(0,15 × 2))
  for (const offer of [alice, bob]) await fund(offer.ownerId, 10_000);
  const quotes = [await insertQuote(alice, { amount: 2500 }), await insertQuote(bob, { amount: 2700 })];
  assert.equal((await readBoostSlots({ pool, offerId: alice.id })).total, 1);
  const pools = await distinctPools(2);
  const waiting: number[] = [];
  const hooks = { beforeDebit: async () => { waiting.push(await waitForLockWaiters(1, 3000)); } };
  const results = await Promise.all([
    outcome2(buy({ sellerId: alice.ownerId, offer: alice, quoteId: quotes[0] }, { db: pools[0], hooks }), 0),
    outcome2(buy({ sellerId: bob.ownerId, offer: bob, quoteId: quotes[1] }, { db: pools[1], hooks }), 1),
  ]);
  assert.deepEqual(results.map((entry) => entry.error ?? "ok").sort(), ["no_slot_available", "ok"]);
  assert.equal(waiting.length, 1);
  assert.ok(waiting[0] >= 1);
  assert.equal(await countRows("offer_boosts", "scope_category = $1 AND status = 'active'", [scope.category]), 1, "pas de survente");
  const winner = results.find((entry) => entry.value)!;
  const loserOffer = winner.index === 0 ? bob : alice;
  const winnerOffer = winner.index === 0 ? alice : bob;
  assert.equal(await balanceOf(loserOffer.ownerId), big(10_000), "le perdant n'est pas débité");
  assert.equal(await balanceOf(winnerOffer.ownerId), big(10_000) - winner.value!.purchase.amount);
  assert.equal(await countRows("boost_purchases", "seller_id = $1", [loserOffer.ownerId]), 0);
  assert.equal(await countRows("wallet_transactions", "kind = 'boost_purchase' AND reference = ANY($1::text[])", [[`boost_purchase:${winner.value!.purchase.id}`]]), 1);
  await assertWalletGreen("après la dispute de la dernière place");
});

test("concurrence : un vendeur, deux offres de périmètres différents, des crédits pour UNE seule → une réussite, une insufficient_balance, aucune écriture pour la perdante", async () => {
  const sellerId = await makeUser();
  const first = await makeOffer({ ownerId: sellerId });
  const second = await makeOffer({ ownerId: sellerId });
  await fund(sellerId, 3000);
  const quotes = [await insertQuote(first, { amount: 2300 }), await insertQuote(second, { amount: 2300 })];
  const pools = await distinctPools(2);
  const meet = meetingPoint(2, 800);
  const results = await Promise.all([
    outcome2(buy({ sellerId, offer: first, quoteId: quotes[0] }, { db: pools[0], hooks: { beforeDebit: meet } }), 0),
    outcome2(buy({ sellerId, offer: second, quoteId: quotes[1] }, { db: pools[1], hooks: { beforeDebit: meet } }), 1),
  ]);
  assert.deepEqual(results.map((entry) => entry.error ?? "ok").sort(), ["insufficient_balance", "ok"]);
  assert.equal(await balanceOf(sellerId), big(700));
  assert.equal(await countRows("boost_purchases", "seller_id = $1", [sellerId]), 1);
  assert.equal(await countRows("offer_boosts", "seller_id = $1", [sellerId]), 1);
  assert.equal(await countRows("wallet_transactions", "kind = 'boost_purchase' AND metadata ->> 'quoteId' = ANY($1::text[])", [quotes]), 1, "aucune écriture pour la perdante");
  const loser = results.find((entry) => entry.error)!.index === 0 ? first : second;
  assert.equal(await countRows("offer_boosts", "offer_id = $1", [loser.id]), 0, "la perdante n'a aucun boost");
  await assertWalletGreen("après deux achats pour un seul crédit");
});

test("concurrence : 8 vendeurs de périmètres différents achètent en même temps → tous réussissent, boost_revenue = somme exacte, aucun interblocage", async () => {
  const worlds: Setup[] = [];
  for (let index = 0; index < 8; index++) worlds.push(await setup({ credit: 5000, quote: { amount: 1000 + index * 100 } }));
  const before = await revenueBalance();
  const pools = await distinctPools(8);
  const results = await Promise.all(worlds.map((world, index) => outcome2(buy(world, { db: pools[index] }), index)));
  assert.deepEqual(results.map((entry) => entry.error ?? "ok"), Array(8).fill("ok"));
  const total = worlds.reduce((sum, _world, index) => sum + big(1000 + index * 100), big(0));
  assert.equal(await revenueBalance() - before, total);
  for (const [index, world] of worlds.entries()) assert.equal(await balanceOf(world.sellerId), big(5000 - (1000 + index * 100)));
  await assertWalletGreen("après 8 achats simultanés");
});

// ═════════════ 7. Tout ou rien : un échec à n'importe quelle étape annule tout ═════════════

test("échec injecté APRÈS le débit (crochet, puis déclencheur de test à l'insertion de boost_purchases, puis déclencheur différé au COMMIT) → aucun débit, aucun boost, aucun achat", async () => {
  const world = await setup({ credit: 10_000 });
  // 1. Le crochet de test lève juste après le débit.
  await expectRefusal("échec juste après le débit (crochet)", () => buy(world, { hooks: { afterDebit: () => { throw new Error("panne_apres_debit"); } } }), "Error: panne_apres_debit");

  // 2. Un déclencheur de test lève à l'insertion de la ligne d'achat (le boost et le débit sont déjà écrits dans la transaction).
  await pool.query(`CREATE FUNCTION test_fail_purchase_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'panne_injectee' USING ERRCODE = 'P0001'; END $$`);
  await pool.query("CREATE TRIGGER trg_test_fail_purchase BEFORE INSERT ON boost_purchases FOR EACH ROW EXECUTE FUNCTION test_fail_purchase_insert()");
  try {
    await expectRefusal("échec à l'insertion de boost_purchases", () => buy(world), "error: panne_injectee");
  } finally {
    await pool.query("DROP TRIGGER trg_test_fail_purchase ON boost_purchases");
    await pool.query("DROP FUNCTION test_fail_purchase_insert()");
  }

  // 3. Un déclencheur DIFFÉRÉ lève au COMMIT : même la validation échoue proprement.
  await pool.query(`CREATE FUNCTION test_fail_at_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'panne_au_commit' USING ERRCODE = 'P0001'; END $$`);
  await pool.query("CREATE CONSTRAINT TRIGGER trg_test_fail_commit AFTER INSERT ON boost_purchases DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION test_fail_at_commit()");
  try {
    await expectRefusal("échec au COMMIT", () => buy(world), "error: panne_au_commit");
  } finally {
    await pool.query("DROP TRIGGER trg_test_fail_commit ON boost_purchases");
    await pool.query("DROP FUNCTION test_fail_at_commit()");
  }

  // Les pannes levées, le même vendeur achète normalement : rien n'est resté bloqué ni consommé (la cotation n'est pas « brûlée »).
  assert.equal(await balanceOf(world.sellerId), big(10_000));
  const result = await buy(world);
  assert.equal(result.balance, big(10_000 - 2300));
  await assertWalletGreen("après des pannes injectées");
});

// ═════════════ 8. Remboursement (administration) ═════════════

const refund = (purchaseId: string, db: Pool = pool, hooks?: { beforeLedger?: () => void | Promise<void> }, reasonCode = "customer_request") =>
  refundBoostPurchase({ pool: db, purchaseId, reasonCode, hooks });

test("remboursement nominal : MONTANT INTÉGRAL, boost actif annulé (place et offre libérées), achat marqué remboursé, grand livre à l'envers ; la cotation reste consommée, le rejeu de la clé renvoie l'achat", async () => {
  const world = await setup({ credit: 10_000, quote: { amount: 2300, durationCode: "7d" } });
  const revenueBefore = await revenueBalance();
  const key = randomUUID();
  const bought = await buy(world, { idempotencyKey: key });
  assert.equal((await readBoostSlots({ pool, offerId: world.offer.id })).used, 1);
  assert.equal(await balanceOf(world.sellerId), big(7700));

  const refunded = await refund(bought.purchase.id);
  assert.equal(refunded.boostCancelled, true);
  assert.equal(refunded.refundedAmount, big(2300), "montant intégral");
  assert.equal(refunded.boost.status, "cancelled");
  assert.ok(refunded.boost.cancelledAt instanceof Date);
  assert.equal(refunded.balance, big(10_000));
  assert.ok(refunded.purchase.refundedAt instanceof Date);
  assert.ok(refunded.purchase.refundTransactionId);
  assert.equal(await balanceOf(world.sellerId), big(10_000));
  assert.equal(await revenueBalance(), revenueBefore, "boost_revenue revient à son niveau d'avant l'achat");
  assert.equal((await readBoostSlots({ pool, offerId: world.offer.id })).used, 0, "la place est libérée");

  const transaction = (await pool.query<{ kind: string; reference: string; metadata: Record<string, string> }>(
    "SELECT kind, reference, metadata FROM wallet_transactions WHERE id = $1", [refunded.purchase.refundTransactionId])).rows[0];
  assert.equal(transaction.kind, "boost_refund");
  assert.equal(transaction.reference, `boost_refund:${bought.purchase.id}`);
  assert.deepEqual(transaction.metadata, { boostPurchaseId: bought.purchase.id, reasonCode: "customer_request" });
  const entries = (await pool.query<{ kind: string; amount: string }>(
    "SELECT a.kind, e.amount::text AS amount FROM wallet_entries e JOIN wallet_accounts a ON a.id = e.account_id WHERE e.transaction_id = $1 ORDER BY e.amount", [refunded.purchase.refundTransactionId])).rows;
  assert.deepEqual(entries, [{ kind: "boost_revenue", amount: "-2300" }, { kind: "user", amount: "2300" }]);
  const overview = await readWalletOverview({ pool, ownerId: world.sellerId });
  assert.deepEqual(overview.items.slice(0, 2).map((item) => [item.kind, item.amount]), [["boost_refund", big(2300)], ["boost_purchase", -big(2300)]]);

  // La cotation reste consommée ; le rejeu de la clé d'origine renvoie l'achat (remboursé), sans aucun nouveau débit.
  await expectRefusal("la cotation remboursée ne se rachète pas", () => buy(world), "quote_already_used");
  const replay = await buy(world, { idempotencyKey: key });
  assert.equal(replay.reused, true);
  assert.equal(replay.purchase.id, bought.purchase.id);
  assert.ok(replay.purchase.refundedAt instanceof Date);
  assert.equal(replay.balance, big(10_000));
  const history = await listOfferBoostPurchases({ pool, sellerId: world.sellerId, offerId: world.offer.id, limit: 5 });
  assert.equal(history.length, 1);
  assert.ok(history[0].refundedAt instanceof Date);

  // L'offre peut être achetée de nouveau avec une NOUVELLE cotation.
  const again = await buy({ ...world, quoteId: await insertQuote(world.offer, { amount: 1800 }) });
  assert.equal(again.balance, big(8200));
  await assertWalletGreen("après un achat, son remboursement et un nouvel achat");
});

test("remboursement : un seul par achat (séquentiel et 6 en PARALLÈLE) ; achat inconnu refusé ; refus propres sans aucune écriture", async () => {
  const world = await setup({ credit: 10_000 });
  const bought = await buy(world);
  const first = await refund(bought.purchase.id);
  assert.equal(first.boostCancelled, true);
  await expectRefusal("deuxième remboursement", () => refund(bought.purchase.id), "already_refunded");
  await expectRefusal("achat inconnu", () => refund(randomUUID()), "purchase_not_found");
  assert.equal(await balanceOf(world.sellerId), big(10_000), "un seul crédit");

  // Parallèle : le verrou de l'achat sérialise ; le gagnant attend que les autres soient bloqués avant d'écrire.
  const racing = await setup({ credit: 10_000 });
  const second = await buy(racing);
  const waiting: number[] = [];
  const results = await Promise.all(Array.from({ length: 6 }, (_, index) => outcome2(refund(second.purchase.id, widePool, {
    beforeLedger: async () => { waiting.push(await waitForLockWaiters(5, 4000)); },
  }), index)));
  assert.deepEqual(results.map((entry) => entry.error ?? "ok").sort(), ["already_refunded", "already_refunded", "already_refunded", "already_refunded", "already_refunded", "ok"]);
  assert.deepEqual(waiting, [5], "5 sessions attendaient le verrou de l'achat pendant l'écriture du gagnant");
  assert.equal(await balanceOf(racing.sellerId), big(10_000), "un seul crédit de 2 300");
  assert.equal(await countRows("wallet_transactions", "kind = 'boost_refund' AND reference = $1", [`boost_refund:${second.purchase.id}`]), 1);
  assert.equal(await countRows("boost_purchases", "id = $1 AND refunded_at IS NOT NULL", [second.purchase.id]), 1);
  await assertWalletGreen("après des remboursements concurrents");
});

test("remboursement d'un boost déjà échu, expiré ou annulé : le crédit est rendu SANS annuler quoi que ce soit ; un boost échu non marqué est marqué expiré (jamais annulé)", async () => {
  // Échu mais encore « active » en base : marqué expired par le remboursement, jamais cancelled.
  const lapsed = await setup({ credit: 10_000 });
  const bought = await buy(lapsed);
  const restoreLapsed = await tamperPurchasedBoost(bought.boost.id, "starts_at = clock_timestamp() - interval '2 days', ends_at = clock_timestamp() - interval '1 day'");
  const result = await refund(bought.purchase.id);
  assert.equal(result.boostCancelled, false);
  assert.equal(result.boost.status, "expired");
  assert.equal(result.boost.cancelledAt, null);
  assert.equal(await balanceOf(lapsed.sellerId), big(10_000), "le crédit est tout de même rendu");
  await restoreLapsed();

  // Déjà expiré par le worker.
  const expired = await setup({ credit: 10_000 });
  const second = await buy(expired);
  const restoreExpired = await tamperPurchasedBoost(second.boost.id, "starts_at = clock_timestamp() - interval '2 days', ends_at = clock_timestamp() - interval '1 day', status = 'expired'");
  const noop = await refund(second.purchase.id);
  assert.deepEqual({ cancelled: noop.boostCancelled, status: noop.boost.status }, { cancelled: false, status: "expired" });
  assert.equal(await balanceOf(expired.sellerId), big(10_000));
  await restoreExpired();

  // Annulé par le vendeur avant le remboursement : cancelled_at n'est pas réécrit.
  const cancelled = await setup({ credit: 10_000 });
  const third = await buy(cancelled);
  const manual = await cancelOfferBoost({ pool, boostId: third.boost.id, ownerId: cancelled.sellerId });
  assert.equal(manual.cancelled, true);
  const after = await refund(third.purchase.id);
  assert.equal(after.boostCancelled, false);
  assert.equal(after.boost.status, "cancelled");
  assert.equal(after.boost.cancelledAt!.getTime(), manual.boost.cancelledAt!.getTime(), "cancelled_at n'est pas réécrit");
  assert.equal(await balanceOf(cancelled.sellerId), big(10_000));
  await assertWalletGreen("après des remboursements de boosts terminés");
});

test("remboursement : un vendeur au solde nul est recrédité ; un échec du grand livre au moment du remboursement annule aussi l'annulation du boost (tout ou rien)", async () => {
  const world = await setup({ credit: 2300 });
  const bought = await buy(world);
  assert.equal(await balanceOf(world.sellerId), big(0));
  // Le grand livre échoue AU MOMENT du remboursement (crochet) : le boost reste actif, l'achat non remboursé.
  const snapshot = await ledgerSnapshot();
  assert.equal(await outcome(refund(bought.purchase.id, pool, { beforeLedger: () => { throw new Error("panne_remboursement"); } })), "Error: panne_remboursement");
  assert.deepEqual(await ledgerSnapshot(), snapshot);
  assert.equal(await scalar("SELECT status AS n FROM offer_boosts WHERE id = $1", [bought.boost.id]), "active", "l'annulation du boost est annulée avec le reste");
  assert.equal(await countRows("boost_purchases", "id = $1 AND refunded_at IS NULL", [bought.purchase.id]), 1);
  const done = await refund(bought.purchase.id);
  assert.equal(done.balance, big(2300));
  await assertWalletGreen("après un remboursement interrompu puis refait");
});

// ═════════════ 9. wallet:check ═════════════

/** Exécute `inject` dans une transaction qu'on ANNULE, et lance les contrôles dans cette même transaction : le schéma propre n'est jamais corrompu. */
async function checkAfter(inject: (client: PoolClient) => Promise<void>): Promise<WalletCheckReport> {
  const client = await txPool.connect();
  try {
    await client.query("BEGIN");
    await inject(client);
    return await runWalletCheck(client);
  } finally {
    try { await client.query("ROLLBACK"); } catch { /* conserver l'erreur utile */ }
    client.release();
  }
}

const codesOf = (report: WalletCheckReport): string[] => report.violations.map((violation) => violation.code).sort();

test("wallet:check ROUGE sur chaque corruption injectée d'un achat ou d'un remboursement (une base saine reste verte)", async () => {
  const world = await setup({ credit: 30_000, quote: { amount: 2300 } });
  const other = await setup({ credit: 1000 });
  const bought = await buy(world);
  const refundedWorld = await setup({ credit: 30_000, quote: { amount: 1700 } });
  const refundedBuy = await buy(refundedWorld);
  const refundedDone = await refund(refundedBuy.purchase.id);
  const purchase = bought.purchase;
  assert.deepEqual((await checkAfter(async () => undefined)).violations, [], "base saine : aucune dérive");

  const off = (client: PoolClient, table: string, trigger: string) => client.query(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`);
  const insertTx = async (client: PoolClient, kind: string, reference: string, metadata: object, entries: Array<[string, number]>): Promise<string> => {
    const id = randomUUID();
    await client.query("INSERT INTO wallet_transactions (id, kind, reference, metadata) VALUES ($1, $2, $3, $4::jsonb)", [id, kind, reference, JSON.stringify(metadata)]);
    for (const [accountId, amount] of entries) {
      await client.query("INSERT INTO wallet_entries (id, transaction_id, account_id, amount) VALUES (gen_random_uuid(), $1, $2, $3::bigint)", [id, accountId, String(amount)]);
    }
    return id;
  };
  const userAccount = async (client: PoolClient) => userAccountId(client, world.sellerId);
  const revenue = (client: PoolClient) => systemAccountId(client, "boost_revenue");
  const exactly = async (label: string, inject: (client: PoolClient) => Promise<void>, expected: string[]) => {
    const report = await checkAfter(inject);
    assert.deepEqual(codesOf(report), [...expected].sort(), label);
    assert.equal(report.ok, false, label);
    for (const violation of report.violations) {
      assert.ok(violation.count >= 1 && violation.examples.length >= 1 && violation.examples.length <= 20, `${label} : ${violation.code}`);
    }
    return report;
  };

  // Un achat dont la transaction est orpheline (aucune ligne d'achat ne la porte) : valeur créée sans achat.
  const orphan = await exactly("transaction d'achat orpheline", async (client) => {
    await off(client, "wallet_transactions", "trg_wallet_transactions_boost_linked");
    const id = randomUUID();
    await insertTx(client, "boost_purchase", `boost_purchase:${id}`, { boostPurchaseId: id, quoteId: randomUUID() }, [[await userAccount(client), -500], [await revenue(client), 500]]);
  }, ["boost_purchase_transaction_orphan", "boost_revenue_mismatch"]);
  assert.deepEqual(Object.keys(orphan.violations.find((v) => v.code === "boost_purchase_transaction_orphan")!.examples[0]).sort(), ["reference", "transaction_id"]);
  assert.deepEqual(Object.keys(orphan.violations.find((v) => v.code === "boost_revenue_mismatch")!.examples[0]).sort(), ["adjustments_total", "balance", "expected", "purchases_total", "refunds_total"]);

  // Le montant de la ligne d'achat ne correspond plus aux écritures ni à la cotation, ni à boost_revenue.
  const altered = await exactly("montant de l'achat modifié", async (client) => {
    await off(client, "boost_purchases", GUARD);
    await client.query("UPDATE boost_purchases SET amount_xof = amount_xof + 100 WHERE id = $1", [purchase.id]);
  }, ["boost_purchase_mismatch", "boost_purchase_quote_mismatch", "boost_revenue_mismatch"]);
  assert.deepEqual(Object.keys(altered.violations.find((v) => v.code === "boost_purchase_mismatch")!.examples[0]).sort(), ["amount", "promo_amount", "purchase_id", "transaction_id"]);
  assert.deepEqual(Object.keys(altered.violations.find((v) => v.code === "boost_purchase_quote_mismatch")!.examples[0]).sort(), ["amount", "purchase_id", "quote_amount", "quote_id"]);

  await exactly("ligne d'achat effacée : transaction et boost orphelins", async (client) => {
    await off(client, "boost_purchases", GUARD);
    await client.query("DELETE FROM boost_purchases WHERE id = $1", [purchase.id]);
  }, ["boost_purchase_transaction_orphan", "boost_revenue_mismatch", "purchase_boost_without_purchase"]);

  await exactly("boost « purchase » sans achat", async (client) => {
    await off(client, "offer_boosts", "trg_offer_boosts_purchase_linked");
    await client.query(
      `INSERT INTO offer_boosts (id, offer_id, seller_id, scope_category, scope_brand, scope_model, status, duration_code, starts_at, ends_at, source)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, 'active', '24h', clock_timestamp(), clock_timestamp() + interval '1 day', 'purchase')`,
      [other.offer.id, other.sellerId, other.scope.category, other.scope.brand, other.scope.model]);
  }, ["purchase_boost_without_purchase"]);

  // Le boost de l'achat n'est plus celui qui a été payé : autre vendeur, autre durée, autre source.
  const windowOff = (client: PoolClient) => off(client, "offer_boosts", "trg_offer_boosts_purchase_window");
  await exactly("boost d'un autre vendeur", async (client) => {
    await windowOff(client);
    await client.query("UPDATE offer_boosts SET seller_id = $2 WHERE id = $1", [bought.boost.id, other.sellerId]);
  }, ["boost_purchase_boost_mismatch"]);
  await exactly("boost d'une autre durée (fenêtre de 7 j pour un achat de 24 h)", async (client) => {
    await windowOff(client);
    await client.query("UPDATE offer_boosts SET duration_code = '7d', ends_at = starts_at + interval '7 days' WHERE id = $1", [bought.boost.id]);
  }, ["boost_purchase_boost_mismatch", "boost_purchase_window_mismatch"]);
  await exactly("boost devenu « admin_grant »", async (client) => {
    await windowOff(client);
    await client.query("UPDATE offer_boosts SET source = 'admin_grant' WHERE id = $1", [bought.boost.id]);
  }, ["boost_purchase_boost_mismatch"]);
  // Fenêtre : durée exacte du code et début à l'instant de l'achat (tolérance documentée de 60 s). Sans autre écart.
  const windowReport = await exactly("fenêtre rallongée d'un an (+364 jours sur ends_at)", async (client) => {
    await windowOff(client);
    await client.query("UPDATE offer_boosts SET ends_at = ends_at + interval '364 days' WHERE id = $1", [bought.boost.id]);
  }, ["boost_purchase_window_mismatch"]);
  assert.deepEqual(Object.keys(windowReport.violations[0].examples[0]).sort(), ["boost_id", "boost_seconds", "expected_seconds", "purchase_id", "start_offset_seconds"]);
  assert.equal(windowReport.violations[0].examples[0].expected_seconds, "86400");
  assert.equal(Number(windowReport.violations[0].examples[0].boost_seconds), 86_400 + 364 * 86_400);
  await exactly("fenêtre raccourcie d'une heure", async (client) => {
    await windowOff(client);
    await client.query("UPDATE offer_boosts SET ends_at = ends_at - interval '1 hour' WHERE id = $1", [bought.boost.id]);
  }, ["boost_purchase_window_mismatch"]);
  await exactly("fenêtre de la bonne durée mais décalée de 2 jours dans le passé (début ≠ instant de l'achat)", async (client) => {
    await windowOff(client);
    await client.query("UPDATE offer_boosts SET starts_at = starts_at - interval '2 days', ends_at = ends_at - interval '2 days' WHERE id = $1", [bought.boost.id]);
  }, ["boost_purchase_window_mismatch"]);
  await exactly("fenêtre de la bonne durée mais commençant 1 h APRÈS l'achat", async (client) => {
    await windowOff(client);
    await client.query("UPDATE offer_boosts SET starts_at = starts_at + interval '1 hour', ends_at = ends_at + interval '1 hour' WHERE id = $1", [bought.boost.id]);
  }, ["boost_purchase_window_mismatch"]);
  // Tolérance de 60 s : 30 s d'avance restent sains, 70 s sont un écart.
  assert.deepEqual((await checkAfter(async (client) => {
    await windowOff(client);
    await client.query("UPDATE offer_boosts SET starts_at = starts_at - interval '30 seconds', ends_at = ends_at - interval '30 seconds' WHERE id = $1", [bought.boost.id]);
  })).violations, [], "30 s d'écart : dans la tolérance");
  await exactly("70 s d'écart : hors tolérance", async (client) => {
    await windowOff(client);
    await client.query("UPDATE offer_boosts SET starts_at = starts_at - interval '70 seconds', ends_at = ends_at - interval '70 seconds' WHERE id = $1", [bought.boost.id]);
  }, ["boost_purchase_window_mismatch"]);
  // Achat de 24 h écrit à la main avec un boost de 365 jours (garde d'insertion désactivée) : détecté par wallet:check.
  await exactly("achat de 24 h écrit à la main avec un boost de 365 jours", async (client) => {
    await off(client, "boost_purchases", GUARD);
    await insertKit(client, world, { boostStatus: "expired", quoteId: await insertQuote(world.offer), boostSeconds: 365 * 86_400 });
  }, ["boost_purchase_window_mismatch"]);
  await exactly("cotation dont le prix a changé", async (client) => {
    await client.query("UPDATE boost_quotes SET amount = amount + 1, raw_amount = raw_amount + 1 WHERE id = $1", [world.quoteId]);
  }, ["boost_purchase_quote_mismatch"]);
  await exactly("cotation devenue indisponible", async (client) => {
    await client.query(
      `UPDATE boost_quotes SET status = 'unavailable', unavailable_reason = 'no_compatible_buyer', amount = NULL, raw_amount = NULL, competition_milli = NULL,
         demand_milli = NULL, scarcity_milli = NULL, duration_milli = NULL WHERE id = $1`, [world.quoteId]);
  }, ["boost_purchase_quote_mismatch"]);

  // Transaction d'achat réécrite (type, écritures supplémentaires).
  await exactly("transaction d'achat devenue un ajustement", async (client) => {
    await off(client, "wallet_transactions", "trg_wallet_transactions_immutable");
    await client.query("UPDATE wallet_transactions SET kind = 'adjustment', reference = 'adjustment:reecrit', metadata = '{}'::jsonb WHERE id = $1", [purchase.transactionId]);
  }, ["boost_purchase_mismatch", "boost_revenue_mismatch"]);
  const extra = await checkAfter(async (client) => {
    await off(client, "wallet_entries", "trg_wallet_entries_same_transaction");
    const clearing = await systemAccountId(client, "provider_clearing");
    await client.query("INSERT INTO wallet_entries (id, transaction_id, account_id, amount) VALUES (gen_random_uuid(), $1, $2, 100)", [purchase.transactionId, clearing]);
  });
  assert.ok(codesOf(extra).includes("boost_purchase_mismatch"), "une troisième écriture sur la transaction d'achat");
  assert.ok(codesOf(extra).includes("transaction_unbalanced"));

  // Remboursements.
  const refundTx = (client: PoolClient, purchaseId: string, amount: number, user = world.sellerId) => (async () => insertTx(
    client, "boost_refund", `boost_refund:${purchaseId}`, { boostPurchaseId: purchaseId, reasonCode: "customer_request" },
    [[await revenue(client), -amount], [await userAccountId(client, user), amount]]))();
  await exactly("transaction de remboursement orpheline", async (client) => {
    await off(client, "wallet_transactions", "trg_wallet_transactions_boost_linked");
    await refundTx(client, purchase.id, 2300);
  }, ["boost_refund_transaction_orphan", "boost_revenue_mismatch"]);
  await exactly("remboursement d'un autre montant que l'achat", async (client) => {
    await off(client, "boost_purchases", GUARD);
    const id = await refundTx(client, purchase.id, 1000);
    await client.query("UPDATE boost_purchases SET refunded_at = clock_timestamp(), refund_transaction_id = $2 WHERE id = $1", [purchase.id, id]);
    await client.query("UPDATE offer_boosts SET status = 'cancelled', cancelled_at = clock_timestamp() WHERE id = $1", [bought.boost.id]);
  }, ["boost_refund_mismatch", "boost_revenue_mismatch"]);
  await exactly("boost d'un achat remboursé remis en service", async (client) => {
    await client.query("UPDATE offer_boosts SET status = 'active', cancelled_at = NULL WHERE id = $1", [refundedDone.boost.id]);
  }, ["refunded_purchase_boost_active"]);
  await exactly("remboursement crédité à un autre utilisateur", async (client) => {
    await off(client, "boost_purchases", GUARD);
    await off(client, "wallet_transactions", "trg_wallet_transactions_immutable");
    await off(client, "wallet_entries", "trg_wallet_entries_immutable");
    await client.query("UPDATE wallet_entries SET account_id = $2 WHERE transaction_id = $1 AND amount > 0", [refundedDone.purchase.refundTransactionId, await userAccountId(client, other.sellerId)]);
  }, ["boost_refund_mismatch", "balance_mismatch"]);

  // Le solde de boost_revenue lui-même (formule : achats − remboursements + écritures d'ajustement).
  const drift = await checkAfter(async (client) => {
    await off(client, "wallet_accounts", "trg_wallet_accounts_guard");
    await client.query("UPDATE wallet_accounts SET balance = balance + 1 WHERE kind = 'boost_revenue'");
  });
  assert.ok(codesOf(drift).includes("boost_revenue_mismatch"));
  const formula = drift.violations.find((v) => v.code === "boost_revenue_mismatch")!.examples[0];
  assert.equal(BigInt(formula.balance) - BigInt(formula.expected), big(1), "écart d'un XOF");
  assert.equal(BigInt(formula.expected), BigInt(formula.purchases_total) - BigInt(formula.refunds_total) + BigInt(formula.adjustments_total), "la formule documentée");
  // Une recharge qui touche boost_revenue n'est pas une écriture d'ajustement : l'égalité est rompue.
  const clearingToRevenue = await checkAfter(async (client) => {
    const id = randomUUID();
    await client.query("INSERT INTO wallet_transactions (id, kind, reference, metadata) VALUES ($1, 'topup', $2, $3::jsonb)", [id, `topup:${id}`, JSON.stringify({ paymentIntentId: id })]);
    await client.query("INSERT INTO wallet_entries (id, transaction_id, account_id, amount) VALUES (gen_random_uuid(), $1, $2, -50)", [id, await systemAccountId(client, "provider_clearing")]);
    await client.query("INSERT INTO wallet_entries (id, transaction_id, account_id, amount) VALUES (gen_random_uuid(), $1, $2, 50)", [id, await revenue(client)]);
  });
  assert.ok(codesOf(clearingToRevenue).includes("boost_revenue_mismatch"));
  // Contrôle positif : les ajustements qui touchent boost_revenue font partie de la formule (aucun écart).
  assert.deepEqual((await checkAfter(async (client) => {
    await insertTx(client, "adjustment", "adjustment:positif", { reasonCode: "test_fixture" }, [[await revenue(client), -75], [await userAccount(client), 75]]);
  })).violations, []);
});

test("wallet:check AVERTISSEMENT : ajustements qui créditent un compte utilisateur (nombre et exemples), sans effet sur `ok` ni sur le code de sortie hors --strict ; achats, remboursements et recharges ne comptent pas", async () => {
  // Différentiel sur le schéma propre : il contient des recharges, des achats, des remboursements ET des crédits d'ajustement (fund).
  // Le test se suffit à lui-même : il ajoute lui-même de quoi dépasser 20 crédits, un achat, son remboursement et une recharge.
  for (let index = 0; index < 22; index++) await fund(await makeUser(), 100);
  const funded = await setup({ credit: 0 });
  await fundByTopup(funded.sellerId, 3000);
  await refund((await buy(funded)).purchase.id);
  const report = await checkWalletIntegrity(pool);
  const credits = Number(await scalar(
    `SELECT count(*)::int AS n FROM wallet_entries e JOIN wallet_accounts a ON a.id = e.account_id JOIN wallet_transactions t ON t.id = e.transaction_id
      WHERE t.kind = 'adjustment' AND a.kind = 'user' AND e.amount > 0`));
  const warning = report.warnings.find((entry) => entry.code === "adjustment_credits_user_account")!;
  assert.ok(credits >= 10, `le schéma propre contient des crédits d'ajustement (${credits})`);
  assert.equal(warning.count, credits, "le nombre est celui des écritures d'ajustement qui créditent un compte utilisateur");
  assert.equal(warning.examples.length, 20, "au plus 20 exemples");
  assert.equal(report.ok, true);

  // Schéma neuf : cas exacts.
  await admin.query(`CREATE SCHEMA ${quoteTemporarySchema(scratchSchema)}`);
  const scratch = await openNamed("scratch", scratchSchema);
  extraPools.push(scratch);
  await runMigrations(scratch);
  const owner = await makeUser(scratch);
  const stranger = await makeUser(scratch);
  assert.deepEqual((await checkWalletIntegrity(scratch)).warnings, []);
  assert.equal((await runScript("scripts/wallet-check.ts", ["--strict"], scratchSchema)).code, 0, "aucun ajustement : --strict sort en 0");

  const credit = await recordWalletTransaction(scratch, {
    kind: "adjustment", reference: "adjustment:credit-1", metadata: { reasonCode: "manual_fix" },
    entries: [{ account: { kind: "boost_revenue" }, amount: -big(1500) }, { account: { kind: "user", ownerId: owner }, amount: big(1500) }],
  });
  // Ne comptent PAS : un ajustement qui DÉBITE un utilisateur, un ajustement entre comptes système.
  await recordWalletTransaction(scratch, {
    kind: "adjustment", reference: "adjustment:debit-1", metadata: { reasonCode: "manual_fix" },
    entries: [{ account: { kind: "user", ownerId: owner }, amount: -big(500) }, { account: { kind: "boost_revenue" }, amount: big(500) }],
  });
  await recordWalletTransaction(scratch, {
    kind: "adjustment", reference: "adjustment:systeme-1", metadata: { reasonCode: "manual_fix" },
    entries: [{ account: { kind: "boost_revenue" }, amount: -big(200) }, { account: { kind: "provider_clearing" }, amount: big(200) }],
  });
  const one = await checkWalletIntegrity(scratch);
  assert.equal(one.ok, true, "un avertissement n'est pas un écart");
  assert.deepEqual(one.violations, []);
  assert.deepEqual(one.warnings.map((entry) => [entry.code, entry.count]), [["adjustment_credits_user_account", 1]]);
  assert.deepEqual(one.warnings[0].examples, [{
    transaction_id: credit.id, account_id: credit.entries.find((entry) => entry.amount > BigInt(0))!.accountId, amount: "1500", reason_code: "manual_fix",
  }]);
  const normal = await runScript("scripts/wallet-check.ts", [], scratchSchema);
  assert.equal(normal.code, 0, normal.output);
  assert.match(normal.output, /Portefeuille : aucun écart\./);
  assert.match(normal.output, /AVERTISSEMENTS \(ajustements d'administration qui créditent un compte utilisateur/);
  assert.match(normal.output, /AVERTISSEMENT adjustment_credits_user_account : 1 crédit\(s\) d'ajustement/);
  assert.ok(normal.output.includes(credit.id) && normal.output.includes("reason_code=manual_fix"));
  assert.ok(!normal.output.includes(owner) && !normal.output.includes(stranger), "aucun identifiant d'utilisateur dans le rapport");
  const strict = await runScript("scripts/wallet-check.ts", ["--strict"], scratchSchema);
  assert.equal(strict.code, 1, strict.output);
  assert.match(strict.output, /mode strict, 1 type\(s\) d'avertissement : code de sortie 1/);

  // Au plus 20 exemples ; le total reste exact.
  for (let index = 0; index < 24; index++) {
    await recordWalletTransaction(scratch, {
      kind: "adjustment", reference: `adjustment:credit-extra-${index}`, metadata: { reasonCode: "bulk_fix" },
      entries: [{ account: { kind: "boost_revenue" }, amount: -big(10) }, { account: { kind: "user", ownerId: stranger }, amount: big(10) }],
    });
  }
  const many = await checkWalletIntegrity(scratch);
  assert.equal(many.warnings[0].count, 25);
  assert.equal(many.warnings[0].examples.length, 20);
  assert.deepEqual(many.violations, []);
});

// ═════════════ 10. Script boost:refund-purchase ═════════════

const REFUND_SCRIPT = "scripts/boost-refund-purchase.ts";

test("script boost:refund-purchase : succès (mention « administration »), refus et erreurs → code 1, jamais de message brut ; arguments invalides sans accès à la base", async () => {
  const world = await setup({ credit: 10_000 });
  const bought = await buy(world);
  const lines = (output: string) => output.trim().split("\n");

  const ok = await runScript(REFUND_SCRIPT, ["--purchase", bought.purchase.id, "--reason", "customer_request"], schema);
  assert.equal(ok.code, 0, ok.output);
  assert.equal(lines(ok.output).length, 1);
  assert.equal(ok.output.trim(), `Boost (administration) remboursé : achat ${bought.purchase.id}, 2300 XOF recrédités (boost annulé).`);
  assert.equal(await balanceOf(world.sellerId), big(10_000));
  assert.equal(await scalar("SELECT status AS n FROM offer_boosts WHERE id = $1", [bought.boost.id]), "cancelled");
  assert.equal(await scalar("SELECT metadata ->> 'reasonCode' AS n FROM wallet_transactions WHERE reference = $1", [`boost_refund:${bought.purchase.id}`]), "customer_request");

  const again = await runScript(REFUND_SCRIPT, ["--purchase", bought.purchase.id, "--reason", "customer_request"], schema);
  assert.equal(again.code, 1);
  assert.equal(again.output.trim(), "Boost (administration) : refus already_refunded (Cet achat est déjà remboursé.)");
  const unknown = await runScript(REFUND_SCRIPT, ["--purchase", randomUUID(), "--reason", "customer_request"], schema);
  assert.equal(unknown.code, 1);
  assert.equal(unknown.output.trim(), "Boost (administration) : refus purchase_not_found (Achat introuvable.)");
  assert.equal(await balanceOf(world.sellerId), big(10_000), "aucun second crédit");

  // Boost déjà terminé : le crédit est rendu, le boost n'est pas « annulé ».
  const ended = await setup({ credit: 10_000 });
  const boughtEnded = await buy(ended);
  const restoreEnded = await tamperPurchasedBoost(boughtEnded.boost.id, "status = 'expired', starts_at = clock_timestamp() - interval '2 days', ends_at = clock_timestamp() - interval '1 day'");
  const late = await runScript(REFUND_SCRIPT, ["--purchase", boughtEnded.purchase.id.toUpperCase(), "--reason", "boost_not_served"], schema);
  assert.equal(late.code, 0, late.output);
  await restoreEnded();
  assert.match(late.output.trim(), /^Boost \(administration\) remboursé : achat [0-9a-f-]{36}, 2300 XOF recrédités \(boost déjà terminé ou annulé\)\.$/);

  // Arguments invalides : code 1, usage, rien n'est écrit.
  const sample = (await buy(await setup({ credit: 10_000 }))).purchase.id;
  const before = await ledgerSnapshot();
  const bad: string[][] = [
    [], ["--purchase", sample], ["--reason", "x"], ["--purchase", "pas-un-uuid", "--reason", "customer_request"],
    ["--purchase", sample, "--reason", "Majuscule"], ["--purchase", sample, "--reason", "avec espace"], ["--purchase", sample, "--reason", "a".repeat(41)],
    ["--purchase", sample, "--reason", "x", "--force", "1"], ["--purchase", sample, "--purchase", sample, "--reason", "x"],
    ["--purchase", sample, "--reason"], ["--purchase", sample, "--reason", "x", "extra"], ["--purchase", sample, "--reason", "--purchase"],
  ];
  for (const args of bad) {
    const result = await runScript(REFUND_SCRIPT, args, schema);
    assert.equal(result.code, 1, JSON.stringify(args) + result.output);
    assert.match(result.output, /^Boost \(administration\) : .*Usage : npm run boost:refund-purchase/m, JSON.stringify(args));
  }
  assert.deepEqual(await ledgerSnapshot(), before, "aucun argument invalide n'écrit");

  const noUrl = await runScript(REFUND_SCRIPT, ["--purchase", sample, "--reason", "x"], schema, { DATABASE_URL: "" });
  assert.equal(noUrl.code, 1);
  assert.match(noUrl.output, /DATABASE_URL est requis/);
  const missing = await runScript(REFUND_SCRIPT, ["--purchase", sample, "--reason", "x"], emptySchema);
  assert.equal(missing.code, 1);
  assert.equal(missing.output.trim(), "Boost (administration) : erreur 42P01.");
  for (const output of [ok.output, again.output, unknown.output, late.output, noUrl.output, missing.output]) {
    for (const forbidden of ["RAW_SECRET_TEXT", "postgres://", "noma_local", "SELECT", "relation", " at ", "wallet_accounts"]) {
      assert.ok(!output.includes(forbidden), `fuite « ${forbidden} » dans : ${output}`);
    }
  }
  assert.equal(await countRows("boost_purchases", "id = $1 AND refunded_at IS NULL", [sample]), 1);
});

// ═════════════ 11. Les règles de places sont UNIQUES : attribution et achat se partagent places et plafond ═════════════

test("règles partagées avec boost:grant : une place prise par un achat bloque l'attribution et réciproquement ; un boost attribué compte dans le plafond vendeur de l'achat ; grantOfferBoost n'accepte pas la source « purchase »", async () => {
  // Validation avant SQL : la source « purchase » n'est pas une attribution d'administration.
  const { spy, count } = observedPool();
  await assert.rejects(
    grantOfferBoost({ pool: spy, offerId: randomUUID(), ownerId: randomUUID(), durationCode: "24h", source: "purchase" as never }),
    (error: unknown) => error instanceof CatalogValidationError,
  );
  assert.equal(count(), 0);

  const scope = makeScope();
  const alice = await makeOffer({ scope });
  const bob = await makeOffer({ scope });                 // 2 offres → 1 place
  await fund(alice.ownerId, 10_000);
  const aliceQuote = await insertQuote(alice);
  const bought = await buy({ sellerId: alice.ownerId, offer: alice, quoteId: aliceQuote });
  assert.equal(bought.boost.source, "purchase");
  // La place est prise par l'ACHAT : l'attribution d'administration pour Bob est refusée comme avant.
  await assert.rejects(grantOfferBoost({ pool, offerId: bob.id, ownerId: bob.ownerId, durationCode: "24h", source: "admin_grant" }),
    (error: unknown) => error instanceof BoostError && error.code === "no_slot_available");
  // Réciproquement : le remboursement libère la place, l'attribution d'administration la prend, l'achat suivant est refusé.
  await refund(bought.purchase.id);
  const granted = await grantOfferBoost({ pool, offerId: bob.id, ownerId: bob.ownerId, durationCode: "24h", source: "admin_grant" });
  assert.equal(granted.boost.source, "admin_grant");
  const second = await insertQuote(alice);
  await expectRefusal("place prise par une attribution d'administration", () => buy({ sellerId: alice.ownerId, offer: alice, quoteId: second }), "no_slot_available");

  // Le plafond vendeur compte les boosts attribués ET achetés.
  const crowded = makeScope();
  await setCategorySettings(crowded.category, { slot_ratio: 0.5, min_slots: 10, max_slots: 20, max_active_per_seller: 1, max_seller_slot_share: 1 });
  try {
    const seller = await makeUser();
    const first = await makeOffer({ ownerId: seller, scope: crowded });
    const twin = await makeOffer({ ownerId: seller, scope: crowded });
    await fund(seller, 10_000);
    await grantOfferBoost({ pool, offerId: first.id, ownerId: seller, durationCode: "3d", source: "admin_grant" });
    const twinQuote = await insertQuote(twin);
    await expectRefusal("plafond vendeur atteint par une attribution", () => buy({ sellerId: seller, offer: twin, quoteId: twinQuote }), "seller_boost_limit_reached");
    // Les deux voies produisent les mêmes décisions sur le même état : lecture des places identique.
    assert.deepEqual(await readBoostSlots({ pool, offerId: twin.id }), { scope: scopeOf(twin), total: 10, used: 1, available: 9 });
  } finally {
    await pool.query("DELETE FROM boost_settings WHERE key = $1", [crowded.category]);
  }
  await assertWalletGreen("achats et attributions mêlés");
});

test("charge mixte : achats, remboursements, attributions, annulations et cotations SIMULTANÉS sur le même périmètre → aucun interblocage (40P01), aucune erreur inattendue ; wallet:check vert", async () => {
  const scope = makeScope();
  await setCategorySettings(scope.category, { slot_ratio: 0.5, min_slots: 30, max_slots: 30, max_active_per_seller: 5, max_seller_slot_share: 1 });
  try {
    const buyers: Setup[] = [];
    for (let index = 0; index < 10; index++) {
      const sellerId = await makeUser();
      const offer = await makeOffer({ ownerId: sellerId, scope });
      await fund(sellerId, 6000);
      buyers.push({ sellerId, offer, quoteId: await insertQuote(offer, { amount: 1000 + index * 50 }), scope });
    }
    // Achats déjà faits : 4 à rembourser, 2 dont le boost sera annulé par le vendeur pendant la charge.
    const existing: Array<{ world: Setup; result: BoostPurchaseResult }> = [];
    for (let index = 0; index < 6; index++) {
      const sellerId = await makeUser();
      const offer = await makeOffer({ ownerId: sellerId, scope });
      await fund(sellerId, 6000);
      const world = { sellerId, offer, quoteId: await insertQuote(offer, { amount: 900 }), scope };
      existing.push({ world, result: await buy(world) });
    }
    const grantOffers: OfferRecord[] = [];
    for (let index = 0; index < 4; index++) grantOffers.push(await makeOffer({ scope }));
    const quoteOffers: OfferRecord[] = [];
    for (let index = 0; index < 4; index++) quoteOffers.push(await makeOffer({ scope }));

    const operations: Array<Promise<{ label: string; error?: string }>> = [];
    const run = (label: string, promise: Promise<unknown>) => operations.push(promise.then(() => ({ label }), (error: unknown) => ({
      label, error: error instanceof BoostError || error instanceof WalletError ? error.code : `${(error as { code?: string }).code ?? "?"} ${(error as Error).message}`,
    })));
    for (const world of buyers) run("achat", buy(world, { db: widePool }));
    for (const entry of existing.slice(0, 4)) run("remboursement", refund(entry.result.purchase.id, widePool));
    for (const entry of existing.slice(4)) run("annulation", cancelOfferBoost({ pool: widePool, boostId: entry.result.boost.id, ownerId: entry.world.sellerId }));
    for (const offer of grantOffers) run("attribution", grantOfferBoost({ pool: widePool, offerId: offer.id, ownerId: offer.ownerId, durationCode: "24h", source: "admin_grant" }));
    for (const offer of quoteOffers) run("cotation", quoteOfferBoost({ pool: widePool, ownerId: offer.ownerId, offerId: offer.id, durationCode: "24h" }));
    const results = await Promise.all(operations);
    assert.deepEqual(results.filter((entry) => entry.error), [], "aucune erreur : ni interblocage (40P01), ni délai de verrou (55P03), ni refus inattendu");
    assert.equal(results.length, 24);
    assert.equal(await countRows("boost_purchases", "refunded_at IS NOT NULL AND seller_id = ANY($1::uuid[])", [existing.map((entry) => entry.world.sellerId)]), 4);
    for (const world of buyers) assert.equal(await countRows("boost_purchases", "seller_id = $1", [world.sellerId]), 1);
  } finally {
    await pool.query("DELETE FROM boost_settings WHERE key = $1", [scope.category]);
  }
  await assertWalletGreen("après la charge mixte");
});

// ═════════════ 12. Un boost ACHETÉ rend l'offre « Sponsorisée » exactement comme une attribution (vrai pipeline) ═════════════

test("achat → « Sponsorisé » EFFECTIF dans stored-matches (sort=relevance, sens demande) : l'offre achetée monte, aucune autre ne change ; le remboursement la ramène à sa place organique ; le paiement n'ajoute aucune pertinence", async () => {
  await admin.query(`CREATE SCHEMA ${quoteTemporarySchema(sponsorSchema)}`);
  const sp = await openNamed("sponsor", sponsorSchema, 2);
  extraPools.push(sp);
  await runMigrations(sp);

  const offers: OfferRecord[] = [];
  for (let index = 0; index < 28; index++) {
    offers.push(await createOffer({
      ownerId: await makeUser(sp), rawText: `RAW_SECRET_TEXT offre iPhone 13 n°${index}`, category: "smartphones", brand: "Apple", model: "iPhone 13",
      condition: "good", location: "Cocody", price: { amount: 100_000 + index * 4_500, currency: "XOF" }, status: "published",
      availabilityStatus: index % 2 === 0 ? "available" : "reserved",
    }, sp));
  }
  const buyer = await makeUser(sp);
  const demand: DemandRecord = await createDemand({
    ownerId: buyer, rawText: "RAW_SECRET_TEXT demande", category: "smartphones", brand: "Apple", model: "iPhone 13", condition: "good", location: "Cocody", budget: null, status: "active",
  }, sp);
  for (let index = 0; index < 120; index++) {
    const cycle = await runMatchingCycle({ pool: sp, workerId: "boost-purchase-test" });
    assert.deepEqual(cycle.errors, []);
    if (cycle.idle) break;
    assert.ok(index < 119, "le cycle n'atteint pas l'état idle");
  }
  const read = () => listStoredOfferMatchesForDemand(buyer, demand.id, { sort: "relevance", limit: 100 }, sp);
  const organic = await read();
  assert.equal(organic.items.length, 28, "fenêtre réelle : 28 correspondances confirmées");
  assert.ok(organic.items.every((item) => item.sponsored === false));
  const organicIds = organic.items.map((item) => item.candidateId);
  const target = organic.items[12];
  const targetOffer = offers.find((offer) => offer.id === target.candidateId)!;
  // Seuil de pertinence : la cible est promouvable (sa pertinence le franchit exactement).
  await sp.query("UPDATE boost_settings SET min_relevance = $1 WHERE key = 'default'", [Math.floor(target.relevance * 100) / 100]);
  assert.deepEqual((await read()).items.map((item) => item.candidateId), organicIds, "sans boost : l'ordre organique");

  // Vraie cotation (un acheteur compatible), vrai crédit (recharge), vrai achat.
  const quote = await quoteOfferBoost({ pool: sp, ownerId: targetOffer.ownerId, offerId: targetOffer.id, durationCode: "3d" });
  assert.equal(quote.status, "available");
  assert.ok(quote.amount !== null && quote.amount >= 500);
  await fundByTopup(targetOffer.ownerId, 50_000, sp);
  const bought = await purchaseOfferBoost({ pool: sp, sellerId: targetOffer.ownerId, offerId: targetOffer.id, quoteId: quote.id, idempotencyKey: randomUUID() });
  assert.equal(bought.purchase.amount, big(quote.amount!), "le débit est le prix de la cotation");
  assert.equal(bought.balance, big(50_000 - quote.amount!));

  const boosted = await read();
  const boostedIds = boosted.items.map((item) => item.candidateId);
  const sponsoredItems = boosted.items.filter((item) => item.sponsored);
  assert.deepEqual(sponsoredItems.map((item) => item.candidateId), [target.candidateId], "seule l'offre achetée est sponsorisée");
  assert.ok(boostedIds.indexOf(target.candidateId) < organicIds.indexOf(target.candidateId), "elle a gagné des places grâce au boost acheté");
  assert.deepEqual([...boostedIds].sort(), [...organicIds].sort(), "aucun élément ajouté, retiré ni dupliqué");
  assert.deepEqual(boostedIds.filter((id) => id !== target.candidateId), organicIds.filter((id) => id !== target.candidateId), "les autres gardent leur ordre relatif");
  // Le paiement ne change ni la pertinence ni le score de l'offre (§15).
  const sameItem = boosted.items.find((item) => item.candidateId === target.candidateId)!;
  assert.equal(sameItem.relevance, target.relevance);

  // Une nouvelle demande de cotation (même durée) ne renvoie JAMAIS la cotation achetée : cotation neuve, indisponible tant que le boost est actif.
  const requote = await quoteOfferBoost({ pool: sp, ownerId: targetOffer.ownerId, offerId: targetOffer.id, durationCode: "3d" });
  assert.equal(requote.reused, false);
  assert.notEqual(requote.id, quote.id);
  assert.deepEqual([requote.status, requote.unavailableReason], ["unavailable", "offer_already_boosted"]);

  // Remboursement : le boost est annulé, l'ordre redevient organique.
  const refunded = await refundBoostPurchase({ pool: sp, purchaseId: bought.purchase.id, reasonCode: "customer_request" });
  assert.equal(refunded.boostCancelled, true);
  const after = await read();
  assert.deepEqual(after.items.map((item) => item.candidateId), organicIds);
  assert.ok(after.items.every((item) => item.sponsored === false));

  // Boucle complète : l'indisponibilité de 60 s écoulée, une cotation NORMALE et neuve est calculée (jamais la cotation remboursée, encore
  // valable), le vendeur la rachète, l'offre est de nouveau sponsorisée.
  await sp.query("UPDATE boost_quotes SET computed_at = clock_timestamp() - interval '2 hours', expires_at = clock_timestamp() - interval '1 hour' WHERE id = $1", [requote.id]);
  const renewed = await quoteOfferBoost({ pool: sp, ownerId: targetOffer.ownerId, offerId: targetOffer.id, durationCode: "3d" });
  assert.equal(renewed.status, "available");
  assert.equal(renewed.reused, false);
  assert.ok(renewed.id !== quote.id && renewed.id !== requote.id);
  const rebought = await purchaseOfferBoost({ pool: sp, sellerId: targetOffer.ownerId, offerId: targetOffer.id, quoteId: renewed.id, idempotencyKey: randomUUID() });
  assert.equal(rebought.purchase.amount, big(renewed.amount!));
  assert.deepEqual((await read()).items.filter((item) => item.sponsored).map((item) => item.candidateId), [target.candidateId], "de nouveau sponsorisée");
  await assertWalletGreen("monde sponsorisé", sp);
});

// ═════════════ 12 bis. Correctifs P1b-bis ═════════════

test("fenêtre d'un boost ACHETÉ figée par la base : starts_at, ends_at, duration_code, offer_id, seller_id et source refusés ; statut, annulation, expiration par le worker et remboursement passent toujours ; un boost d'administration reste modifiable", async () => {
  const world = await setup({ credit: 50_000 });
  const stranger = await setup({ credit: 1000 });
  const inTx = (operation: (client: PoolClient, kit: { boostId: string }) => Promise<unknown>) =>
    failureOf(async (client) => { const kit = await insertKit(client, world, { boostStatus: "active" }); await operation(client, kit); });

  const frozen: Array<[string, string]> = [
    ["ends_at rallongé d'un an", "ends_at = ends_at + interval '364 days'"],
    ["ends_at raccourci", "ends_at = ends_at - interval '1 second'"],
    ["starts_at avancé", "starts_at = starts_at - interval '1 day'"],
    ["fenêtre entière décalée (durée inchangée)", "starts_at = starts_at - interval '2 days', ends_at = ends_at - interval '2 days'"],
    ["duration_code", "duration_code = '7d'"],
    ["offer_id", `offer_id = '${stranger.offer.id}'`],
    ["seller_id", `seller_id = '${stranger.sellerId}'`],
    ["source", "source = 'admin_grant'"],
  ];
  for (const [label, assignment] of frozen) {
    const failure = await inTx((client, kit) => client.query(`UPDATE offer_boosts SET ${assignment} WHERE id = $1`, [kit.boostId]));
    assert.ok(failure, `${label} : un refus était attendu`);
    assert.equal(failure.code, "23001", `${label} : restrict_violation (${JSON.stringify(failure)})`);
  }
  // Les passages de statut ne touchent aucun champ figé : permis.
  assert.equal(await inTx((client, kit) => client.query("UPDATE offer_boosts SET status = 'expired' WHERE id = $1", [kit.boostId])), null, "expiration");
  assert.equal(await inTx((client, kit) => client.query("UPDATE offer_boosts SET status = 'cancelled', cancelled_at = clock_timestamp() WHERE id = $1", [kit.boostId])), null, "annulation");

  // Un boost d'administration n'est pas concerné par la fenêtre figée… mais ne peut pas DEVENIR un boost acheté (source).
  const granted = await grantOfferBoost({ pool, offerId: stranger.offer.id, ownerId: stranger.sellerId, durationCode: "24h", source: "admin_grant" });
  const adminWindow = await failureOf((client) => client.query("UPDATE offer_boosts SET ends_at = ends_at + interval '1 day' WHERE id = $1", [granted.boost.id]));
  assert.equal(adminWindow, null, "la fenêtre d'un boost d'administration reste modifiable");
  const toPurchase = await failureOf((client) => client.query("UPDATE offer_boosts SET source = 'purchase' WHERE id = $1", [granted.boost.id]));
  assert.equal(toPurchase?.code, "23001", "un boost d'administration ne devient pas un boost acheté");

  // Parcours réels, avec le déclencheur ACTIF : annulation par le vendeur, expiration par le worker, remboursement.
  const cancelled = await setup({ credit: 10_000 });
  const boughtCancelled = await buy(cancelled);
  assert.equal((await cancelOfferBoost({ pool, boostId: boughtCancelled.boost.id, ownerId: cancelled.sellerId })).boost.status, "cancelled");
  const expiring = await setup({ credit: 10_000 });
  const boughtExpiring = await buy(expiring);
  const restore = await tamperPurchasedBoost(boughtExpiring.boost.id, "starts_at = clock_timestamp() - interval '2 days', ends_at = clock_timestamp() - interval '1 day'");
  assert.ok((await expireOfferBoosts({ pool, limit: 1000 })).expired >= 1, "le balayage du worker marque le boost échu");
  assert.equal(await scalar("SELECT status AS n FROM offer_boosts WHERE id = $1", [boughtExpiring.boost.id]), "expired");
  await restore();
  const refundedLive = await setup({ credit: 10_000 });
  const boughtRefunded = await buy(refundedLive);
  assert.equal((await refund(boughtRefunded.purchase.id)).boostCancelled, true);
  assert.equal(await scalar("SELECT status AS n FROM offer_boosts WHERE id = $1", [boughtRefunded.boost.id]), "cancelled");
  // La fenêtre d'un boost réellement acheté est exacte (durée du code, début à l'instant de l'achat).
  const exact = (await pool.query<{ seconds: string; offset: string }>(
    `SELECT extract(epoch FROM b.ends_at - b.starts_at)::text AS seconds, extract(epoch FROM p.created_at - b.starts_at)::text AS offset
       FROM boost_purchases p JOIN offer_boosts b ON b.id = p.boost_id WHERE p.id = $1`, [boughtRefunded.purchase.id])).rows[0];
  assert.equal(Number(exact.seconds), 86_400);
  assert.ok(Number(exact.offset) >= 0 && Number(exact.offset) < 5, `le boost commence à l'instant de l'achat (${exact.offset} s)`);
  await assertWalletGreen("après des passages de statut sur des boosts achetés");
});

test("offre verrouillée en lecture partagée pendant l'achat : une mise en pause ou un changement de clé produit CONCURRENTS attendent la fin de l'achat (jamais un boost créé sur une offre déjà en pause)", async () => {
  for (const [label, update] of [
    ["mise en pause", "UPDATE offers SET status = 'paused' WHERE id = $1"],
    ["changement de clé produit", "UPDATE offers SET model = 'autre modele' WHERE id = $1"],
  ] as const) {
    const world = await setup({ credit: 10_000 });
    const [buyerPool] = await distinctPools(1);
    let updated = false;
    let updating: Promise<unknown> | undefined;
    const seen: Array<{ waiters: number; updatedWhileHeld: boolean }> = [];
    const result = await buy(world, { db: buyerPool, hooks: { beforeDebit: async () => {
      // L'achat a TOUT contrôlé (offre publiée, cotation valable) et tient l'offre : la modification concurrente doit attendre.
      updating = pool.query(update, [world.offer.id]).then(() => { updated = true; });
      const waiters = await waitForLockWaiters(1, 3000);
      await new Promise((resolve) => setTimeout(resolve, 250));
      seen.push({ waiters, updatedWhileHeld: updated });
    } } });
    await updating;
    assert.equal(seen.length, 1, label);
    assert.ok(seen[0].waiters >= 1, `${label} : la modification concurrente est bloquée sur l'offre verrouillée par l'achat`);
    assert.equal(seen[0].updatedWhileHeld, false, `${label} : elle n'a pas pu s'appliquer avant la fin de l'achat`);
    assert.equal(result.boost.source, "purchase");
    assert.equal(updated, true, `${label} : puis elle s'applique, APRÈS l'achat`);
    assert.equal(await balanceOf(world.sellerId), big(10_000 - 2300));
    assert.equal(await countRows("boost_purchases", "id = $1", [result.purchase.id]), 1);
  }
  await assertWalletGreen("après des modifications d'offre concurrentes");
});

/** Borne une promesse : au-delà de `ms`, le test échoue vite (au lieu de pendre) ; la promesse en cours est laissée finir. */
function bounded<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([promise, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${label} : aucune réponse après ${ms} ms (lock_timeout absent ?)`)), ms))]);
}

test("lock_timeout effectif : un verrou tenu par une autre session fait échouer VITE l'achat (idempotence) et le remboursement (ligne de l'achat) avec 55P03, sans rien écrire ; les opérations réussissent une fois les verrous relâchés", async () => {
  const world = await setup({ credit: 10_000 });
  const target = await setup({ credit: 10_000 });
  const bought = await buy(target);
  const [purchasePool, refundPool] = await distinctPools(2);
  const key = randomUUID();
  const holders: PoolClient[] = [];
  const snapshot = await ledgerSnapshot();
  const codeOf = (promise: Promise<unknown>) => promise.then(() => "ok", (error: unknown) => (error as { code?: string }).code ?? `${(error as Error).message}`);
  try {
    const advisory = await pool.connect();
    holders.push(advisory);
    await advisory.query("BEGIN");
    await advisory.query("SELECT pg_advisory_xact_lock($1::int, hashtext($2::text))", [BOOST_PURCHASE_LOCK_NAMESPACE, `${world.sellerId}:${key}`]);
    const rowLock = await pool.connect();
    holders.push(rowLock);
    await rowLock.query("BEGIN");
    await rowLock.query("SELECT 1 FROM boost_purchases WHERE id = $1 FOR UPDATE", [bought.purchase.id]);

    const started = Date.now();
    const [purchaseCode, refundCode] = await Promise.all([
      codeOf(bounded(buy(world, { db: purchasePool, idempotencyKey: key }), 9000, "achat")),
      codeOf(bounded(refund(bought.purchase.id, refundPool), 9000, "remboursement")),
    ]);
    const elapsed = Date.now() - started;
    assert.equal(purchaseCode, "55P03", "l'achat échoue sur le délai de verrou");
    assert.equal(refundCode, "55P03", "le remboursement échoue sur le délai de verrou");
    assert.ok(elapsed >= 4000 && elapsed < 9000, `attente bornée par lock_timeout (${elapsed} ms)`);
  } finally {
    for (const holder of holders) {
      await holder.query("ROLLBACK").catch(() => undefined);
      holder.release();
    }
  }
  assert.deepEqual(await ledgerSnapshot(), snapshot, "rien n'est écrit par les délais de verrou");
  // Verrous relâchés : les mêmes opérations réussissent.
  assert.equal((await buy(world, { idempotencyKey: key })).reused, false);
  assert.equal((await refund(bought.purchase.id)).boostCancelled, true);
  await assertWalletGreen("après des délais de verrou");
});

test("une cotation déjà achetée n'est JAMAIS réutilisée par quoteOfferBoost : une cotation neuve est calculée (indisponible tant que le boost est actif) ; une cotation non achetée reste réutilisée", async () => {
  const world = await setup({ credit: 10_000, quote: { amount: 2300 } });
  const quoteAgain = () => quoteOfferBoost({ pool, ownerId: world.sellerId, offerId: world.offer.id, durationCode: "24h" });
  const before = await quoteAgain();
  assert.equal(before.id, world.quoteId, "tant qu'elle n'est pas achetée, la cotation valable est réutilisée");
  assert.equal(before.reused, true);

  const bought = await buy(world);
  const after = await quoteAgain();
  assert.notEqual(after.id, world.quoteId, "la cotation achetée n'est plus renvoyée");
  assert.equal(after.reused, false, "une cotation neuve est calculée");
  assert.deepEqual([after.status, after.unavailableReason, after.amount], ["unavailable", "offer_already_boosted", null], "indisponible tant que le boost acheté est actif");
  assert.equal((await quoteAgain()).id, after.id, "la cotation indisponible (60 s) est ensuite réutilisée comme avant");

  // Après remboursement et échéance de la cotation indisponible : jamais l'achetée (encore valable pourtant), une cotation neuve.
  await refund(bought.purchase.id);
  await pool.query("UPDATE boost_quotes SET computed_at = clock_timestamp() - interval '2 hours', expires_at = clock_timestamp() - interval '1 hour' WHERE id = $1", [after.id]);
  assert.equal(await scalar("SELECT (expires_at > clock_timestamp())::text AS n FROM boost_quotes WHERE id = $1", [world.quoteId]), "true", "la cotation achetée n'a pas expiré");
  const fresh = await quoteAgain();
  assert.ok(fresh.id !== world.quoteId && fresh.id !== after.id);
  assert.equal(fresh.reused, false);
  assert.deepEqual([fresh.status, fresh.unavailableReason], ["available", null], "plus de boost actif : cotation normale (un acheteur atteignable existe dans ce monde de test, lot P3)");
  await expectRefusal("la cotation achetée puis remboursée reste consommée", () => buy(world), "quote_already_used");
});

// ═════════════ 12b. Portée REVÉRIFIÉE à l'achat (lot P3) ═════════════

const placementOf = async (demand: DemandRecord, buyerId: string) => (await listStoredOfferMatchesForDemand(buyerId, demand.id, { sort: "relevance", limit: 100 }, pool)).items;

test("portée revérifiée à l'achat — le scénario B de l'audit : D achète en premier (atteignable), puis A (mieux classé, devis calculé AVANT l'achat de D) → no_visible_effect au devis ET à l'achat avec le devis réutilisé ; D garde sa place sponsorisée, aucun débit pour A", async () => {
  // Liste de 8 offres (quota floor(0,15 × 8) = 1), périmètre à 2 places : A (classée avant D) et D du même périmètre, 6 remplissages.
  const scope = makeScope();
  await setCategorySettings(scope.category, { min_slots: 2, max_slots: 5, max_active_per_seller: 2, max_seller_slot_share: 1 });
  try {
    const sellerA = await makeUser();
    const sellerD = await makeUser();
    const offerA = await makeOffer({ ownerId: sellerA, scope });
    const offerD = await makeOffer({ ownerId: sellerD, scope });
    const buyer = await addReachableBuyer(pool, offerA, { listSize: 7, offerScore: 95 });
    await insertEvaluation(pool, { offer: offerD, demand: buyer.demand, score: 90 });
    const organic = await placementOf(buyer.demand, buyer.buyerId);
    assert.equal(organic.length, 8, "liste de 8 offres");
    const indexOf = (offer: OfferRecord) => organic.findIndex((item) => item.candidateId === offer.id);
    assert.ok(indexOf(offerA) < indexOf(offerD), "A est mieux classée que D");
    assert.ok(indexOf(offerD) > 0 && indexOf(offerA) > 0, "ni A ni D n'est déjà en tête : un boost les ferait monter");
    await fund(sellerA, 20_000);
    await fund(sellerD, 20_000);

    // Le devis d'A est calculé AVANT l'achat de D (réel : aucun boost, A atteignable) ; il est disponible.
    const quoteA = await quoteOfferBoost({ pool, ownerId: sellerA, offerId: offerA.id, durationCode: "24h" });
    assert.deepEqual([quoteA.status, quoteA.inputs.reachableBuyers], ["available", 1], "avant l'achat de D, A est atteignable");
    // D achète : son devis réel est disponible (D est atteignable tant qu'aucun boost n'existe) et l'achat réussit.
    const quoteD = await quoteOfferBoost({ pool, ownerId: sellerD, offerId: offerD.id, durationCode: "24h" });
    assert.equal(quoteD.status, "available");
    const bought = await purchaseOfferBoost({ pool, sellerId: sellerD, offerId: offerD.id, quoteId: quoteD.id, idempotencyKey: randomUUID() });
    assert.equal(bought.reused, false);
    const balanceA = await balanceOf(sellerA);
    const balanceD = await balanceOf(sellerD);

    // D est SPONSORISÉ dans la liste de l'acheteur.
    const afterD = await placementOf(buyer.demand, buyer.buyerId);
    assert.equal(afterD.find((item) => item.candidateId === offerD.id)!.sponsored, true, "D est sponsorisé");
    assert.equal(afterD[0].candidateId, offerD.id, "D est promu en tête");

    // A achète avec son devis (calculé avant, encore valable) : revérification à l'achat → no_visible_effect, rien n'est écrit.
    await expectRefusal("A achète avec son devis réutilisé", () => purchaseOfferBoost({
      pool, sellerId: sellerA, offerId: offerA.id, quoteId: quoteA.id, idempotencyKey: randomUUID(),
    }), "no_visible_effect");
    assert.equal(await balanceOf(sellerA), balanceA, "aucun débit pour A");
    assert.equal(await balanceOf(sellerD), balanceD, "D n'est pas touché");
    assert.equal(await countRows("offer_boosts", "offer_id = $1", [offerA.id]), 0, "aucun boost pour A");
    assert.equal(await countRows("boost_purchases", "seller_id = $1", [sellerA]), 0, "aucun achat pour A");
    assert.equal(await countRows("boost_purchases", "quote_id = $1", [quoteA.id]), 0, "le devis d'A n'est pas consommé");
    // D n'a pas été évincé : toujours promu, toujours en tête ; A n'est pas sponsorisée.
    const afterA = await placementOf(buyer.demand, buyer.buyerId);
    assert.equal(afterA.find((item) => item.candidateId === offerD.id)!.sponsored, true, "D reste sponsorisé");
    assert.equal(afterA.find((item) => item.candidateId === offerA.id)!.sponsored, false);
    assert.deepEqual(afterA.map((item) => item.candidateId), afterD.map((item) => item.candidateId), "l'ordre servi n'a pas changé");
    // Un NOUVEAU devis pour A dit la même chose : indisponible, aucun effet visible.
    const freshA = await quoteOfferBoost({ pool, ownerId: sellerA, offerId: offerA.id, durationCode: "3d" });
    assert.deepEqual([freshA.status, freshA.unavailableReason, freshA.inputs.reachableBuyers], ["unavailable", "no_visible_effect", 0], "le devis aussi");
    await assertWalletGreen("après le scénario B");
  } finally {
    await pool.query("DELETE FROM boost_settings WHERE key = $1", [scope.category]);
  }
});

test("devis réutilisé revérifié (lot P3-bis, N1) — la boucle de l'audit : D achète, A (devis disponible calculé avant) est refusée à l'achat ; redemander le devis ne rend PLUS le même devis « disponible » : un devis neuf indisponible (aucun effet visible), puis plus aucune boucle ; la place libérée et l'indisponible échu, le devis encore valable redevient réutilisable", async () => {
  const scope = makeScope();
  await setCategorySettings(scope.category, { min_slots: 2, max_slots: 5, max_active_per_seller: 2, max_seller_slot_share: 1 });
  try {
    const sellerA = await makeUser();
    const sellerD = await makeUser();
    const offerA = await makeOffer({ ownerId: sellerA, scope });
    const offerD = await makeOffer({ ownerId: sellerD, scope });
    const buyer = await addReachableBuyer(pool, offerA, { listSize: 7, offerScore: 95 });
    await insertEvaluation(pool, { offer: offerD, demand: buyer.demand, score: 90 });
    await fund(sellerA, 20_000);
    await fund(sellerD, 20_000);
    const quoteOf = (owner: string, offer: OfferRecord) => quoteOfferBoost({ pool, ownerId: owner, offerId: offer.id, durationCode: "24h" });

    const quoteA = await quoteOf(sellerA, offerA);
    assert.deepEqual([quoteA.status, quoteA.inputs.reachableBuyers, quoteA.reused], ["available", 1, false]);
    // Tant que la portée tient, le MÊME devis est renvoyé (revérifié : toujours atteignable).
    const stillOk = await quoteOf(sellerA, offerA);
    assert.deepEqual([stillOk.id, stillOk.reused, stillOk.status], [quoteA.id, true, "available"], "portée intacte : réutilisé comme avant");
    // D achète avant A : la place sponsorisée de l'acheteur est prise.
    const quoteD = await quoteOf(sellerD, offerD);
    await purchaseOfferBoost({ pool, sellerId: sellerD, offerId: offerD.id, quoteId: quoteD.id, idempotencyKey: randomUUID() });
    await expectRefusal("A achète avec son devis calculé avant", () => purchaseOfferBoost({
      pool, sellerId: sellerA, offerId: offerA.id, quoteId: quoteA.id, idempotencyKey: randomUUID(),
    }), "no_visible_effect");

    // A redemande le devis (même durée) : PLUS le même devis « disponible ».
    const again = await quoteOf(sellerA, offerA);
    assert.notEqual(again.id, quoteA.id, "le devis périmé n'est plus rendu");
    assert.deepEqual([again.status, again.unavailableReason, again.amount, again.inputs.reachableBuyers, again.reused], ["unavailable", "no_visible_effect", null, 0, false]);
    // Aucune boucle : la demande suivante renvoie ce devis indisponible (60 s), jamais un « disponible » ; rien de nouveau n'est écrit.
    const rows = await countRows("boost_quotes", "offer_id = $1", [offerA.id]);
    const third = await quoteOf(sellerA, offerA);
    assert.deepEqual([third.id, third.status, third.reused], [again.id, "unavailable", true]);
    assert.equal(await countRows("boost_quotes", "offer_id = $1", [offerA.id]), rows);
    // Le devis d'avant n'est ni modifié ni consommé (lignes immuables) ; il reste simplement non réutilisé tant que la portée ne tient pas.
    assert.equal(await countRows("boost_purchases", "quote_id = $1", [quoteA.id]), 0);

    // La place revient (le boost de D est annulé) et l'indisponible échoit : le devis d'origine, encore valable, est de nouveau réutilisable (revérifié atteignable).
    const boostD = await pool.query<{ id: string }>("SELECT id FROM offer_boosts WHERE offer_id = $1", [offerD.id]);
    await cancelOfferBoost({ pool, boostId: boostD.rows[0].id, ownerId: sellerD });
    await pool.query("UPDATE boost_quotes SET computed_at = clock_timestamp() - interval '2 hours', expires_at = clock_timestamp() - interval '1 hour' WHERE id = $1", [again.id]);
    const back = await quoteOf(sellerA, offerA);
    assert.deepEqual([back.id, back.status, back.reused], [quoteA.id, "available", true]);
    const bought = await purchaseOfferBoost({ pool, sellerId: sellerA, offerId: offerA.id, quoteId: quoteA.id, idempotencyKey: randomUUID() });
    assert.equal(bought.reused, false);
    await assertWalletGreen("après la boucle de l'audit");
  } finally {
    await pool.query("DELETE FROM boost_settings WHERE key = $1", [scope.category]);
  }
});

test("portée revérifiée à l'achat : sans acheteur atteignable (liste devenue courte) → no_visible_effect, rien d'écrit, le devis reste utilisable ; la liste rétablie, le MÊME devis s'achète", async () => {
  const world = await setup({ credit: 10_000 });
  // Le seul acheteur de l'offre voit sa demande satisfaite : plus aucun acheteur compatible.
  await pool.query("UPDATE demands SET status = 'satisfied' WHERE id IN (SELECT demand_id FROM matching_evaluations WHERE offer_id = $1)", [world.offer.id]);
  await expectRefusal("aucun acheteur atteignable", () => buy(world), "no_visible_effect");
  assert.equal(await countRows("boost_purchases", "quote_id = $1", [world.quoteId]), 0);
  await pool.query("UPDATE demands SET status = 'active' WHERE id IN (SELECT demand_id FROM matching_evaluations WHERE offer_id = $1)", [world.offer.id]);
  const bought = await buy(world);
  assert.equal(bought.reused, false);
  assert.equal(bought.boost.source, "purchase");
});

test("portée revérifiée à l'achat : un REJEU de la même clé renvoie l'achat déjà fait (aucune revérification, aucun débit) même quand plus aucun acheteur n'est atteignable", async () => {
  const world = await setup({ credit: 10_000 });
  const key = randomUUID();
  const first = await buy(world, { idempotencyKey: key });
  await pool.query("UPDATE demands SET status = 'satisfied' WHERE id IN (SELECT demand_id FROM matching_evaluations WHERE offer_id = $1)", [world.offer.id]);
  const balance = await balanceOf(world.sellerId);
  const replay = await buy(world, { idempotencyKey: key });
  assert.equal(replay.reused, true);
  assert.equal(replay.purchase.id, first.purchase.id);
  assert.equal(await balanceOf(world.sellerId), balance);
});

test("portée revérifiée à l'achat : SOUS le verrou du périmètre (verrous de périmètre et d'idempotence tenus, verrou de cotation jamais), après les contrôles de places et AVANT le débit (ordre des étapes)", async () => {
  const world = await setup({ credit: 10_000 });
  const observer = (await distinctPools(1))[0];
  let seen: { scope: number; idempotency: number; quote: number } | null = null;
  // Ordre des étapes de l'achat : le débit est invisible depuis une autre connexion avant le COMMIT, c'est donc l'ORDRE des crochets qui prouve que la revérification
  // précède le débit : portée (besoin n° 0) → « juste avant le débit » → « juste après le débit ».
  const events: string[] = [];
  const bought = await buy(world, {
    hooks: {
      beforeReachDemand: async (index) => {
        events.push(`portée:${index}`);
        if (index !== 0) return;
        // Seulement NOS sessions (`RUN_ID`), dans NOTRE base : `pg_locks` est global à l'instance, une autre exécution tient des verrous des mêmes espaces.
        const locks = await ownAdvisoryLocks(observer, RUN_ID, [BOOST_SCOPE_LOCK_NAMESPACE, BOOST_QUOTE_LOCK_NAMESPACE, BOOST_PURCHASE_LOCK_NAMESPACE], { granted: true });
        const count = (namespace: number) => locks.filter((row) => row.namespace === namespace).length;
        seen = { scope: count(BOOST_SCOPE_LOCK_NAMESPACE), idempotency: count(BOOST_PURCHASE_LOCK_NAMESPACE), quote: count(BOOST_QUOTE_LOCK_NAMESPACE) };
      },
      beforeDebit: async () => { events.push("avant-débit"); },
      afterDebit: async () => { events.push("après-débit"); },
    },
  });
  assert.deepEqual(seen, { scope: 1, idempotency: 1, quote: 0 }, "pendant la revérification : périmètre et idempotence tenus, cotation jamais");
  assert.deepEqual(events, ["portée:0", "avant-débit", "après-débit"], "la revérification de la portée précède le débit");
  assert.equal(bought.reused, false);
});

test("portée revérifiée à l'achat (lot P3-bis, N3) : budget épuisé SANS acheteur trouvé → reach_check_unavailable (503), jamais no_visible_effect : aucune écriture, devis non consommé ; la MÊME clé réessayée aboutit ; budget suffisant → l'achat passe", async () => {
  const world = await setup({ credit: 10_000 });
  // Horloge factice : chaque lecture avance de 2 000 ms (budget 1 500 ms) → épuisé avant le premier besoin ; avance de 600 ms → le premier besoin est examiné.
  const ticking = (step: number) => { let t = 0; return () => (t += step); };
  const key = randomUUID();
  await expectRefusal("budget épuisé avant le premier besoin", () => buy(world, { idempotencyKey: key, hooks: { reachBudgetMs: 1_500, reachClock: ticking(2_000) } }), "reach_check_unavailable");
  assert.equal(await countRows("boost_purchases", "seller_id = $1", [world.sellerId]), 0);
  assert.equal(await countRows("offer_boosts", "offer_id = $1", [world.offer.id]), 0);
  assert.equal(await countRows("boost_purchases", "quote_id = $1", [world.quoteId]), 0, "le devis n'est pas consommé");
  assert.equal(await balanceOf(world.sellerId), BigInt(10_000), "aucun débit");
  await assertWalletGreen("après un 503 de vérification");
  // Même clé d'idempotence, vérification qui aboutit : l'achat passe (une seule fois).
  const bought = await buy(world, { idempotencyKey: key, hooks: { reachBudgetMs: 1_500, reachClock: ticking(600) } });
  assert.equal(bought.purchase.quoteId, world.quoteId);
  assert.equal(bought.reused, false);
  assert.equal(await countRows("boost_purchases", "seller_id = $1", [world.sellerId]), 1);
  await assertWalletGreen("après la relance avec la même clé");
});

test("portée revérifiée à l'achat (lot P3-bis, N3) : un verrou RÉEL tenu sur matching_evaluations (la lecture est bloquée, statement_timeout) → reach_check_unavailable vite, rien d'écrit ; le verrou relâché, la même clé aboutit ; no_visible_effect reste réservé au cas démontré", async () => {
  const world = await setup({ credit: 10_000 });
  const [holder] = await distinctPools(1);
  const lockClient = await holder.connect();
  const key = randomUUID();
  try {
    await lockClient.query("BEGIN");
    await lockClient.query("LOCK TABLE matching_evaluations IN ACCESS EXCLUSIVE MODE");
    const startedAt = Date.now();
    await expectRefusal("lecture des évaluations bloquée", () => buy(world, { idempotencyKey: key, hooks: { reachBudgetMs: 400 } }), "reach_check_unavailable");
    assert.ok(Date.now() - startedAt < 2_500, `refus borné par le budget (${Date.now() - startedAt} ms)`);
  } finally {
    await lockClient.query("ROLLBACK").catch(() => {});
    lockClient.release();
  }
  const bought = await buy(world, { idempotencyKey: key });
  assert.equal(bought.reused, false);
  assert.equal(await countRows("boost_purchases", "seller_id = $1", [world.sellerId]), 1);
  // Cas DÉMONTRÉ : plus aucun acheteur compatible, aucune interruption → no_visible_effect (et non reach_check_unavailable).
  const other = await setup({ credit: 10_000 });
  await pool.query("UPDATE demands SET status = 'satisfied' WHERE id IN (SELECT demand_id FROM matching_evaluations WHERE offer_id = $1)", [other.offer.id]);
  await expectRefusal("aucun acheteur démontré", () => buy(other), "no_visible_effect");
  await assertWalletGreen("après le verrou réel");
});

test("portée revérifiée à l'achat (lot P3-bis) : des acheteurs trouvés avant l'épuisement du budget → l'achat passe (le budget épuisé n'est un refus que sans acheteur démontré)", async () => {
  const world = await setup({ credit: 10_000 });
  let t = 0;
  // 1er besoin examiné à 100 ms (budget 150 ms), il est atteignable : mode « premier » s'arrête dessus, jamais d'épuisement constaté.
  const bought = await buy(world, { hooks: { reachBudgetMs: 150, reachClock: () => (t += 50) } });
  assert.equal(bought.reused, false);
  assert.equal(bought.purchase.quoteId, world.quoteId);
});

test("portée revérifiée à l'achat : un boost PLUS ANCIEN dans la liste de l'acheteur garde le quota ; l'ordre d'attribution fait foi (le boost attribué d'abord est servi d'abord)", async () => {
  // Liste de 7 (quota 1) : une offre d'un autre vendeur du périmètre est boostée (attribution) AVANT l'achat → la liste n'a plus de place pour l'acheté.
  const scope = makeScope();
  await setCategorySettings(scope.category, { min_slots: 3, max_slots: 5, max_active_per_seller: 2, max_seller_slot_share: 1 });
  try {
    const sellerA = await makeUser();
    const offerA = await makeOffer({ ownerId: sellerA, scope });
    const other = await makeOffer({ scope });
    const buyer = await addReachableBuyer(pool, offerA, { listSize: 6, offerScore: 95 });
    await insertEvaluation(pool, { offer: other, demand: buyer.demand, score: 90 });
    await fund(sellerA, 10_000);
    const quoteA = await insertQuote(offerA, { reachable: false });
    // Un boost plus ancien sur `other` (attribution d'administration) : quota 1 (liste de 7) consommé.
    await grantOfferBoost({ pool, offerId: other.id, ownerId: other.ownerId, durationCode: "24h", source: "admin_grant" });
    await expectRefusal("le quota de la liste est pris par un boost plus ancien", () => purchaseOfferBoost({
      pool, sellerId: sellerA, offerId: offerA.id, quoteId: quoteA, idempotencyKey: randomUUID(),
    }), "no_visible_effect");
    // Le boost plus ancien est annulé : la place revient, le MÊME devis s'achète.
    const boost = await pool.query<{ id: string }>("SELECT id FROM offer_boosts WHERE offer_id = $1", [other.id]);
    await cancelOfferBoost({ pool, boostId: boost.rows[0].id, ownerId: other.ownerId });
    const bought = await purchaseOfferBoost({ pool, sellerId: sellerA, offerId: offerA.id, quoteId: quoteA, idempotencyKey: randomUUID() });
    assert.equal(bought.reused, false);
  } finally {
    await pool.query("DELETE FROM boost_settings WHERE key = $1", [scope.category]);
  }
});

// ═════════════ 13. Cohérence finale ═════════════

test("le schéma propre reste cohérent à la fin du fichier : wallet:check vert (fonction et script) après tous les scénarios, y compris les concurrents et les remboursés", async () => {
  const report = await checkWalletIntegrity(pool);
  assert.deepEqual(report.violations, []);
  assert.equal(report.ok, true);
  assert.ok(report.totals.transactions >= 60, JSON.stringify(report.totals));
  assert.ok(await countRows("boost_purchases") >= 25);
  assert.ok(await countRows("boost_purchases", "refunded_at IS NOT NULL") >= 8);
  assert.ok(await countRows("wallet_transactions", "kind = 'boost_refund'") >= 8);
  assert.ok(await countRows("offer_boosts", "source = 'purchase'") === await countRows("boost_purchases"), "un boost « purchase » par achat, ni plus ni moins");
  const script = await runScript("scripts/wallet-check.ts", [], schema);
  assert.equal(script.code, 0, script.output);
  assert.match(script.output, /Portefeuille : aucun écart\./);
  // Jamais de donnée personnelle ni de texte d'annonce dans le rapport.
  assert.ok(!script.output.includes("RAW_SECRET_TEXT"));
  // Aucune session du fichier ne reste bloquée sur un verrou.
  assert.equal(await lockWaiters(), 0);
});
