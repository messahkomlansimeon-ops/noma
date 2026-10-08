import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { Pool, type PoolClient, type PoolConfig } from "pg";
import { createUser } from "../../lib/server/catalog";
import { CatalogValidationError } from "../../lib/server/catalog/errors";
import { withPostgresTransaction } from "../../lib/server/postgres/client";
import { runMigrations } from "../../lib/server/postgres/migrations";
import { checkWalletIntegrity, runWalletCheck, type WalletCheckCode } from "../../lib/server/wallet/check";
import { WalletError, type WalletErrorCode } from "../../lib/server/wallet/errors";
import {
  ensureUserWalletAccount, postWalletTransaction, readWalletBalance, readWalletOverview, recordWalletTransaction,
  type WalletTransactionInput,
} from "../../lib/server/wallet/ledger";
import {
  applyProviderEvent, createTopupIntent, expirePaymentIntents, readTopupIntent, type PaymentIntent, type ProviderEvent,
  type ProviderEventResult,
} from "../../lib/server/wallet/topups";
import { WALLET_LOCK_TIMEOUT_MS, WALLET_TOPUP_LOCK_NAMESPACE } from "../../lib/server/wallet/config";
import { runScript } from "./run-script";
import {
  createTemporarySchemaName, openVerifiedIsolatedPool, openVerifiedTestDatabase, quoteTemporarySchema, type DedicatedTestDatabase,
} from "./test-database";

// ───────────── infrastructure ─────────────

const schema = createTemporarySchemaName();
const quoted = quoteTemporarySchema(schema);
const dirtySchema = createTemporarySchemaName();
const dirtyQuoted = quoteTemporarySchema(dirtySchema);
let admin: Pool;
let target: DedicatedTestDatabase;
/** Schéma PROPRE : toutes les données y restent cohérentes, wallet:check y est vert à la fin du fichier. */
let pool: Pool;
/** Pool dédié aux transactions de test annulées (le schéma propre n'est jamais corrompu). */
let txPool: Pool;
/** Schéma « sale » : les tests y laissent volontairement des écarts (corruption, état intermédiaire). */
let dirtyPool: Pool;
/** Pool réservé à la session qui tient les verrous de test (jamais utilisé par les opérations testées). */
let holderPool: Pool;
const extraPools: Pool[] = [];
const big = (value: number | string): bigint => BigInt(value);
const ZERO = big(0);
const MAX_SAFE = big("9007199254740991");

/**
 * Chaque pool de ce fichier porte un `application_name` unique à cette exécution (`<RUN_ID>_<étiquette>`) : le comptage des
 * attentes de verrou ne regarde que NOS sessions, jamais celles d'une autre exécution simultanée sur la même base de test.
 */
const RUN_ID = `wlt_${process.pid}_${randomBytes(4).toString("hex")}`;
const namedPoolFactory = (label: string) => (config: PoolConfig): Pool => new Pool({ ...config, application_name: `${RUN_ID}_${label}` });
const openNamed = (label: string, schemaName = schema): Promise<Pool> => openVerifiedIsolatedPool(target, schemaName, namedPoolFactory(label));

before(async () => {
  const opened = await openVerifiedTestDatabase(process.env.TEST_DATABASE_URL);
  admin = opened.pool;
  target = opened.target;
  await admin.query(`CREATE SCHEMA ${quoted}`);
  await admin.query(`CREATE SCHEMA ${dirtyQuoted}`);
  pool = await openNamed("main");
  txPool = await openNamed("tx");
  dirtyPool = await openNamed("dirty", dirtySchema);
  holderPool = await openNamed("holder");
  assert.equal((await runMigrations(pool)).applied.length, 26);
  assert.equal((await runMigrations(dirtyPool)).applied.length, 26);
});

after(async () => {
  for (const extra of extraPools) await extra.end().catch(() => {});
  for (const each of [pool, txPool, dirtyPool, holderPool]) if (each) await each.end().catch(() => {});
  if (admin) {
    await admin.query(`DROP SCHEMA IF EXISTS ${quoted} CASCADE`);
    await admin.query(`DROP SCHEMA IF EXISTS ${dirtyQuoted} CASCADE`);
    await admin.end();
  }
});

const makeUser = async (db: Pool = pool): Promise<string> => (await createUser({}, db)).id;
const scalar = async <T = string>(db: Pool, text: string, values: unknown[] = []): Promise<T> => (await db.query(text, values)).rows[0].n as T;
const count = async (table: string, db: Pool = pool): Promise<number> => Number(await scalar(db, `SELECT count(*)::int AS n FROM ${table}`));
const sha = (text: string): string => createHash("sha256").update(text).digest("hex");

/** Pools à une seule connexion chacun, réutilisés d'un test à l'autre (la base de test limite les connexions) : les N premiers sont toujours distincts. */
const bank = new Map<string, Pool[]>();
async function distinctPools(size: number, schemaName = schema): Promise<Pool[]> {
  const pools = bank.get(schemaName) ?? [];
  bank.set(schemaName, pools);
  while (pools.length < size) {
    const extra = await openNamed(`bank${pools.length}`, schemaName);
    extraPools.push(extra);
    pools.push(extra);
  }
  return pools.slice(0, size);
}

interface Failure { code?: string; constraint?: string }

/** Exécute `operation` dans une transaction : annulée (défaut) ou validée. Renvoie l'échec SQL (code, contrainte) ou null. */
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
  assert.equal(failure.code, code, `${label} : code SQL`);
  if (constraint) assert.equal(failure.constraint, constraint, `${label} : contrainte`);
}

const expectAccepted = async (label: string, operation: (client: PoolClient) => Promise<unknown>): Promise<void> => {
  assert.equal(await failureOf(operation), null, `${label} : aucun refus attendu`);
};

/** Compte système (identifiant). */
const systemAccount = async (kind: "provider_clearing" | "boost_revenue", db: Pool = pool): Promise<string> =>
  scalar(db, "SELECT id AS n FROM wallet_accounts WHERE kind = $1", [kind]);

async function walletError(operation: Promise<unknown>): Promise<WalletErrorCode | "ok" | string> {
  try { await operation; return "ok"; } catch (error) {
    if (error instanceof WalletError) return error.code;
    return `${(error as Error).name}: ${(error as Error).message}`;
  }
}

/** Crédit d'ajustement d'un utilisateur : boost_revenue → utilisateur (opération du grand livre autonome). */
let adjustmentSequence = 0;
const adjustment = (ownerId: string, amount: number, db: Pool = pool) => {
  adjustmentSequence += 1;
  return recordWalletTransaction(db, {
    kind: "adjustment",
    reference: `adjustment:test-${adjustmentSequence}-${randomUUID()}`,
    metadata: { reasonCode: "test_fixture" },
    entries: [
      { account: { kind: "boost_revenue" }, amount: -big(amount) },
      { account: { kind: "user", ownerId }, amount: big(amount) },
    ],
  });
};

const newIntent = async (ownerId: string, amount = 1000, db: Pool = pool): Promise<PaymentIntent> =>
  (await createTopupIntent({ pool: db, ownerId, amountXof: big(amount), idempotencyKey: randomUUID() })).intent;

/** Intention en attente dont l'échéance est PASSÉE (insertion directe : une intention existante ne se modifie jamais). */
async function expiredPendingIntent(ownerId: string, amount = 1000, db: Pool = pool, expiredSecondsAgo = 3600): Promise<string> {
  const id = randomUUID();
  await db.query(
    `INSERT INTO payment_intents (id, owner_id, amount_xof, provider, status, idempotency_key, provider_reference, created_at, expires_at)
     VALUES ($1, $2, $3, 'fake', 'pending', $4, $5, clock_timestamp() - make_interval(secs => $6::int + 3600), clock_timestamp() - make_interval(secs => $6::int))`,
    [id, ownerId, amount, randomUUID(), `fakepay_${randomBytes(12).toString("hex")}`, expiredSecondsAgo],
  );
  return id;
}

/** Marque expirées toutes les intentions échues déjà présentes (état de départ connu pour les tests de balayage). */
async function drainDueIntents(db: Pool = pool): Promise<void> {
  while ((await expirePaymentIntents({ pool: db, limit: 1000 })).expired > 0) { /* jusqu'à épuisement */ }
}

const eventFor = (intent: { providerReference: string; amountXof: bigint }, override: Partial<ProviderEvent> = {}): ProviderEvent => {
  const eventId = override.eventId ?? `evt_${randomUUID().replaceAll("-", "")}`;
  return {
    provider: "fake", eventId, type: "payment.succeeded", providerReference: intent.providerReference, amountXof: intent.amountXof,
    payloadSha256: sha(`corps:${eventId}`), ...override,
  };
};

const apply = (event: ProviderEvent, db: Pool = pool): Promise<ProviderEventResult> => applyProviderEvent({ pool: db, event });

/** Intention créée puis payée par un événement valide : le chemin complet, sans raccourci. */
async function paidIntent(ownerId: string, amount = 1000, db: Pool = pool): Promise<PaymentIntent> {
  const intent = await newIntent(ownerId, amount, db);
  const result = await apply(eventFor(intent), db);
  assert.equal(result.outcome, "applied");
  return intent;
}

/** Barrière : toutes les opérations démarrent ensemble. */
function barrier(): { gate: Promise<void>; open: () => void } {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => { open = resolve; });
  return { gate, open };
}

/** Nombre de sessions de CETTE exécution (application_name préfixé par RUN_ID) en attente d'un verrou. */
async function lockWaiters(): Promise<number> {
  return Number(await scalar(admin,
    `SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname = current_database() AND pid <> pg_backend_pid() AND wait_event_type = 'Lock'
        AND starts_with(application_name, $1)`, [`${RUN_ID}_`]));
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

/** Espion : compte les requêtes et connexions demandées au pool. */
function observedPool(base: Pool = pool): { spy: Pool; count: () => number } {
  let queries = 0;
  const spy = Object.create(base) as Pool;
  spy.query = ((...args: unknown[]) => { queries++; return (base.query as (...a: unknown[]) => unknown)(...args); }) as never;
  spy.connect = ((...args: unknown[]) => { queries++; return (base.connect as (...a: unknown[]) => unknown)(...args); }) as never;
  return { spy, count: () => queries };
}

const intentColumns = (owner: string, over: Record<string, string> = {}): Record<string, string> => ({
  id: `'${randomUUID()}'`, owner_id: `'${owner}'`, amount_xof: "1000", provider: "'fake'", status: "'pending'",
  idempotency_key: `'${randomUUID()}'`, provider_reference: `'fakepay_${randomBytes(8).toString("hex")}'`,
  created_at: "clock_timestamp()", expires_at: "clock_timestamp() + interval '30 minutes'", completed_at: "NULL", ...over,
});

/** INSERT d'une intention avec des expressions SQL littérales (réservé aux tests) ; renvoie son identifiant. */
async function insertIntent(client: PoolClient, owner: string, over: Record<string, string> = {}): Promise<string> {
  const columns = intentColumns(owner, over);
  await client.query(`INSERT INTO payment_intents (${Object.keys(columns).join(", ")}) VALUES (${Object.values(columns).join(", ")})`);
  return columns.id.slice(1, -1);
}

async function insertEvent(client: PoolClient, intentId: string | null, over: Record<string, string> = {}): Promise<void> {
  const columns: Record<string, string> = {
    id: `'${randomUUID()}'`, provider: "'fake'", provider_event_id: `'evt_${randomBytes(8).toString("hex")}'`,
    intent_id: intentId === null ? "NULL" : `'${intentId}'`, type: "'payment.succeeded'", amount_xof: "1000",
    payload_sha256: `'${sha("x")}'`, outcome: intentId === null ? "'rejected_unknown_intent'" : "'applied'", ...over,
  };
  await client.query(`INSERT INTO payment_events (${Object.keys(columns).join(", ")}) VALUES (${Object.values(columns).join(", ")})`);
}

/** Insère une transaction du grand livre « adjustment » (sans écriture) avec des clés SQL littérales. */
async function insertTransaction(client: PoolClient, over: Record<string, string> = {}): Promise<string> {
  const columns: Record<string, string> = {
    id: `'${randomUUID()}'`, kind: "'adjustment'", reference: `'adjustment:${randomBytes(8).toString("hex")}'`, metadata: "'{}'::jsonb", ...over,
  };
  await client.query(`INSERT INTO wallet_transactions (${Object.keys(columns).join(", ")}) VALUES (${Object.values(columns).join(", ")})`);
  return columns.id.slice(1, -1);
}

const insertEntry = (client: PoolClient, transactionId: string, accountId: string, amount: string): Promise<unknown> =>
  client.query("INSERT INTO wallet_entries (id, transaction_id, account_id, amount) VALUES (gen_random_uuid(), $1, $2, $3::bigint)", [transactionId, accountId, amount]);

// ═════════════ 1. Migration 0014 ═════════════

test("migration 0014 : 14 appliquées, la relance n'en applique aucune, comptes système créés, tables et index présents", async () => {
  const rerun = await runMigrations(pool);
  assert.deepEqual(rerun.applied, []);
  assert.equal(rerun.skipped.length, 26);
  assert.equal(rerun.skipped.at(-1), "0026_sublymus_payments");
  const accounts = (await pool.query("SELECT kind, owner_id, balance::text AS balance FROM wallet_accounts ORDER BY kind")).rows;
  // Lot PRO1 (migration 0021) : quatre comptes système de plus (revenus d'abonnement et crédits promotionnels : émis, dépensés, expirés).
  assert.deepEqual(accounts, [
    { kind: "boost_revenue", owner_id: null, balance: "0" },
    { kind: "promo_consumed", owner_id: null, balance: "0" },
    { kind: "promo_expired", owner_id: null, balance: "0" },
    { kind: "promo_issuance", owner_id: null, balance: "0" },
    { kind: "provider_clearing", owner_id: null, balance: "0" },
    { kind: "subscription_revenue", owner_id: null, balance: "0" },
  ]);
  const tables = (await pool.query(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_name IN
       ('wallet_accounts', 'wallet_transactions', 'wallet_entries', 'payment_intents', 'payment_events') ORDER BY table_name`, [schema])).rows;
  assert.deepEqual(tables.map((row) => row.table_name), ["payment_events", "payment_intents", "wallet_accounts", "wallet_entries", "wallet_transactions"]);
  const indexes = (await pool.query("SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND indexname LIKE ANY (ARRAY['uq_wallet%', 'idx_wallet%', 'idx_payment%', 'uq_payment%']) ORDER BY indexname", [schema])).rows.map((row) => row.indexname);
  for (const name of [
    "uq_wallet_accounts_user_owner", "uq_wallet_accounts_system_kind", "uq_wallet_transactions_reference", "uq_wallet_entries_transaction_account",
    "idx_wallet_entries_account", "uq_payment_intents_owner_idempotency", "uq_payment_intents_provider_reference", "idx_payment_intents_owner_pending",
    "idx_payment_intents_due", "uq_payment_events_provider_event", "idx_payment_events_intent",
  ]) assert.ok(indexes.includes(name), `index ${name}`);
  const triggers = (await pool.query(
    `SELECT t.tgname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE NOT t.tgisinternal AND n.nspname = $1 AND (c.relname LIKE 'wallet\_%' OR c.relname LIKE 'payment\_%') ORDER BY t.tgname`, [schema])).rows.map((row) => row.tgname);
  assert.deepEqual(triggers, [
    "trg_payment_events_immutable", "trg_payment_intents_guard",
    // Ajoutés par la migration 0021 (lot PRO1) : une transaction de l'offre Pro n'existe jamais sans son objet (contrainte différée), et un compte promotionnel ou de revenus
    // d'abonnement n'est touché que par les types de transaction de son rôle, dans le bon sens.
    "trg_pro_transactions_linked",
    "trg_wallet_accounts_guard", "trg_wallet_entries_account_usage", "trg_wallet_entries_balance", "trg_wallet_entries_balanced",
    "trg_wallet_entries_immutable", "trg_wallet_entries_same_transaction", "trg_wallet_transactions_balanced",
    // Ajouté par la migration 0015 (lot P1b) : une transaction d'achat ou de remboursement de boost n'existe jamais sans son achat (contrainte différée).
    "trg_wallet_transactions_boost_linked", "trg_wallet_transactions_immutable",
  ]);
  const deferrable = (await pool.query(
    `SELECT t.tgname, t.tgdeferrable, t.tginitdeferred FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND t.tgname IN ('trg_wallet_entries_balanced', 'trg_wallet_transactions_balanced') ORDER BY t.tgname`, [schema])).rows;
  assert.deepEqual(deferrable, [
    { tgname: "trg_wallet_entries_balanced", tgdeferrable: true, tginitdeferred: true },
    { tgname: "trg_wallet_transactions_balanced", tgdeferrable: true, tginitdeferred: true },
  ]);
});

test("0014 wallet_accounts : chaque CHECK, index unique, clé étrangère et garde de mutation refuse son cas", async () => {
  const user = await makeUser();
  const owner = await makeUser();
  const insertAccount = (kind: string, ownerId: string | null, balance = "0") => (client: PoolClient) =>
    client.query("INSERT INTO wallet_accounts (id, kind, owner_id, balance) VALUES (gen_random_uuid(), $1, $2, $3::bigint)", [kind, ownerId, balance]);
  // Le déclencheur de garde (solde initial nul) passe avant les CHECK de solde : pour les atteindre on le désactive le temps de l'essai (annulé ensuite).
  const guardOff = (operation: (client: PoolClient) => Promise<unknown>) => async (client: PoolClient) => {
    await client.query("ALTER TABLE wallet_accounts DISABLE TRIGGER trg_wallet_accounts_guard");
    await operation(client);
  };
  await expectFailure("type inconnu", insertAccount("bank", null), "23514", "chk_wallet_accounts_kind");
  await expectFailure("compte utilisateur sans propriétaire", insertAccount("user", null), "23514", "chk_wallet_accounts_owner");
  await expectFailure("compte système avec propriétaire", insertAccount("boost_revenue", user), "23514", "chk_wallet_accounts_owner");
  await expectFailure("solde au-delà de 2^53 - 1", guardOff(insertAccount("boost_revenue", null, "9007199254740992")), "23514", "chk_wallet_accounts_balance_range");
  await expectFailure("solde sous -(2^53 - 1)", guardOff(insertAccount("boost_revenue", null, "-9007199254740992")), "23514", "chk_wallet_accounts_balance_range");
  await expectFailure("solde utilisateur négatif", guardOff(insertAccount("user", user, "-1")), "23514", "chk_wallet_accounts_user_balance_non_negative");
  await expectFailure("propriétaire inexistant", insertAccount("user", randomUUID()), "23503");
  await expectFailure("deuxième compte du même utilisateur", async (client) => {
    await insertAccount("user", user)(client);
    await insertAccount("user", user)(client);
  }, "23505", "uq_wallet_accounts_user_owner");
  await expectFailure("deuxième compte provider_clearing", insertAccount("provider_clearing", null), "23505", "uq_wallet_accounts_system_kind");
  await expectFailure("deuxième compte boost_revenue", insertAccount("boost_revenue", null), "23505", "uq_wallet_accounts_system_kind");
  await expectAccepted("compte utilisateur à solde nul", insertAccount("user", owner));

  // Garde : le solde ne change que par une écriture ; identité et suppression interdites.
  const clearing = await systemAccount("provider_clearing");
  await expectFailure("UPDATE direct du solde", (client) => client.query("UPDATE wallet_accounts SET balance = balance + 1 WHERE id = $1", [clearing]), "23001");
  await expectFailure("UPDATE direct du solde (même valeur écrite par un autre chemin)", (client) => client.query("UPDATE wallet_accounts SET balance = 5 WHERE id = $1", [clearing]), "23001");
  await expectFailure("changement de type", (client) => client.query("UPDATE wallet_accounts SET kind = 'boost_revenue' WHERE id = $1", [clearing]), "23001");
  await expectFailure("changement d'identifiant", (client) => client.query("UPDATE wallet_accounts SET id = gen_random_uuid() WHERE id = $1", [clearing]), "23001");
  await expectFailure("changement de propriétaire", async (client) => {
    await insertAccount("user", user)(client);
    await client.query("UPDATE wallet_accounts SET owner_id = $2 WHERE kind = 'user' AND owner_id = $1", [user, owner]);
  }, "23001");
  await expectFailure("suppression d'un compte", (client) => client.query("DELETE FROM wallet_accounts WHERE id = $1", [clearing]), "23001");
  await expectFailure("suppression d'un compte utilisateur vide", async (client) => {
    await insertAccount("user", user)(client);
    await client.query("DELETE FROM wallet_accounts WHERE kind = 'user' AND owner_id = $1", [user]);
  }, "23001");
  await expectAccepted("mise à jour sans changement de solde (la ligne est réécrite à l'identique)", (client) =>
    client.query("UPDATE wallet_accounts SET balance = balance WHERE id = $1", [clearing]));
});

test("0014 comptes : un compte naît à solde NUL (garde d'insertion) ; le solde ne vient jamais que des écritures", async () => {
  const user = await makeUser();
  const insertAccount = (kind: string, ownerId: string | null, balance: string) => (client: PoolClient) =>
    client.query("INSERT INTO wallet_accounts (id, kind, owner_id, balance) VALUES (gen_random_uuid(), $1, $2, $3::bigint)", [kind, ownerId, balance]);
  for (const balance of ["1", "-1", "100", "500000", "9007199254740991", "-9007199254740991"]) {
    await expectFailure(`compte utilisateur créé à ${balance}`, insertAccount("user", user, balance), "23001");
    await expectFailure(`compte système créé à ${balance}`, insertAccount("boost_revenue", null, balance), "23001");
    await expectFailure(`compte système (provider_clearing) créé à ${balance}`, insertAccount("provider_clearing", null, balance), "23001");
  }
  for (const [label, columns] of [
    ["sans solde explicite (valeur par défaut)", "INSERT INTO wallet_accounts (id, kind, owner_id) VALUES (gen_random_uuid(), 'user', $1)"],
    ["avec un solde explicitement nul", "INSERT INTO wallet_accounts (id, kind, owner_id, balance) VALUES (gen_random_uuid(), 'user', $1, 0)"],
  ] as const) {
    await expectAccepted(`compte utilisateur ${label}`, (client) => client.query(columns, [user]));
  }
  // Le chemin applicatif (création à la demande) n'est pas gêné : le compte naît à zéro et reçoit son solde par une écriture.
  const fresh = await makeUser();
  const account = await ensureUserWalletAccount(pool, fresh);
  assert.equal(await scalar(pool, "SELECT balance::text AS n FROM wallet_accounts WHERE id = $1", [account]), "0");
  await adjustment(fresh, 250);
  assert.equal(await readWalletBalance(pool, fresh), big(250));
});

test("0014 transactions validées : aucune écriture ne peut s'ajouter plus tard à une transaction existante (identifiant de la transaction SQL de premier niveau, SAVEPOINT compris)", async () => {
  const column = (await pool.query(
    `SELECT data_type, is_nullable FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'wallet_transactions' AND column_name = 'created_xid'`, [schema])).rows[0];
  assert.deepEqual(column, { data_type: "xid8", is_nullable: "NO" });
  const user = await makeUser();
  const stranger = await makeUser();
  await ensureUserWalletAccount(pool, user);
  const strangerAccount = await ensureUserWalletAccount(pool, stranger);
  const clearing = await systemAccount("provider_clearing");
  const revenue = await systemAccount("boost_revenue");
  const intent = await paidIntent(user, 700);
  const adjustmentTx = (await adjustment(user, 500)).id;
  const topupTx = await scalar(pool, "SELECT id AS n FROM wallet_transactions WHERE reference = $1", [`topup:${intent.id}`]);
  const snapshot = async () => JSON.stringify([await count("wallet_entries"), await count("wallet_transactions"), String(await readWalletBalance(pool, user)), String(await readWalletBalance(pool, stranger))]);
  const before = await snapshot();

  // Écritures ÉQUILIBRÉES ajoutées plus tard à une recharge ou à un ajustement déjà validés : refusées, y compris dans un SAVEPOINT.
  for (const [label, transactionId, accounts] of [
    ["recharge", topupTx, [strangerAccount, revenue]],
    ["ajustement", adjustmentTx, [strangerAccount, clearing]],
  ] as const) {
    const addBalanced = async (client: PoolClient) => {
      await insertEntry(client, transactionId, accounts[0], "50");
      await insertEntry(client, transactionId, accounts[1], "-50");
    };
    await expectFailure(`${label} : écritures équilibrées ajoutées plus tard`, addBalanced, "23001", undefined, true);
    await expectFailure(`${label} : dans un SAVEPOINT`, async (client) => { await client.query("SAVEPOINT tardif"); await addBalanced(client); }, "23001", undefined, true);
    await expectFailure(`${label} : nouvelle tentative après ROLLBACK TO SAVEPOINT`, async (client) => {
      await client.query("SAVEPOINT tardif");
      try { await addBalanced(client); } catch { await client.query("ROLLBACK TO SAVEPOINT tardif"); }
      await addBalanced(client);
    }, "23001", undefined, true);
    await expectFailure(`${label} : après avoir créé une AUTRE transaction dans la même transaction SQL`, async (client) => {
      const own = await insertTransaction(client);
      await insertEntry(client, own, accounts[0], "1");
      await insertEntry(client, own, accounts[1], "-1");
      await addBalanced(client);
    }, "23001", undefined, true);
  }
  assert.equal(await snapshot(), before, "aucun refus n'a laissé de trace");

  // Un parent inexistant reste l'affaire de la clé étrangère (pas de confusion de codes).
  await expectFailure("transaction parente inexistante", (client) => insertEntry(client, randomUUID(), strangerAccount, "5"), "23503");

  // Cas passants : tout ce qui se passe dans LA MÊME transaction SQL de premier niveau, avec ou sans SAVEPOINT.
  const adjustmentRefs: string[] = [];
  const newTransaction = (client: PoolClient) => {
    const reference = `adjustment:${randomBytes(8).toString("hex")}`;
    adjustmentRefs.push(reference);
    return insertTransaction(client, { reference: `'${reference}'` });
  };
  assert.equal(await failureOf(async (client) => {
    const first = await newTransaction(client);
    await client.query("SAVEPOINT a");
    await insertEntry(client, first, strangerAccount, "10");
    await client.query("ROLLBACK TO SAVEPOINT a");
    await client.query("SAVEPOINT b");
    await insertEntry(client, first, strangerAccount, "10");
    await client.query("RELEASE SAVEPOINT b");
    await insertEntry(client, first, revenue, "-10");
  }, true), null, "écritures dans des SAVEPOINT, l'un annulé puis refait");
  assert.equal(await failureOf(async (client) => {
    await client.query("SAVEPOINT parent");
    const second = await newTransaction(client);
    await insertEntry(client, second, strangerAccount, "20");
    await client.query("RELEASE SAVEPOINT parent");
    await client.query("SAVEPOINT autre");
    await insertEntry(client, second, revenue, "-20");
    await client.query("RELEASE SAVEPOINT autre");
  }, true), null, "transaction créée DANS un SAVEPOINT, écritures dans un autre ou hors SAVEPOINT");
  assert.equal(await failureOf(async (client) => {
    // Un SAVEPOINT annulé emporte la transaction créée à l'intérieur ; une autre prend sa place et se complète.
    await client.query("SAVEPOINT perdu");
    await newTransaction(client);
    await client.query("ROLLBACK TO SAVEPOINT perdu");
    const third = await newTransaction(client);
    await insertEntry(client, third, strangerAccount, "30");
    await insertEntry(client, third, revenue, "-30");
  }, true), null, "transaction annulée avec son SAVEPOINT puis remplacée");
  assert.equal(await failureOf(async (client) => {
    const outer = (await client.query("SELECT pg_current_xact_id()::text AS xid")).rows[0].xid;
    await client.query("SAVEPOINT sous");
    const inside = await newTransaction(client); // force l'attribution d'un identifiant de sous-transaction
    const nested = (await client.query("SELECT pg_current_xact_id()::text AS xid")).rows[0].xid;
    assert.equal(nested, outer, "pg_current_xact_id() renvoie l'identifiant de premier niveau dans un SAVEPOINT");
    const stored = (await client.query("SELECT created_xid::text AS xid FROM wallet_transactions WHERE id = $1", [inside])).rows[0].xid;
    assert.equal(stored, outer, "created_xid est celui de la transaction de premier niveau");
    await insertEntry(client, inside, strangerAccount, "40");
    await insertEntry(client, inside, revenue, "-40");
  }, true), null);
  assert.equal(await readWalletBalance(pool, stranger), big(100), "10 + 20 + 30 + 40 : les cas passants ont bien écrit");
  // Les transactions validées ont des identifiants de transaction différents, le contrôle de réconciliation reste vert.
  assert.equal(Number(await scalar(pool, "SELECT count(DISTINCT created_xid)::int AS n FROM wallet_transactions")) >= 4, true);
  assert.deepEqual((await checkWalletIntegrity(pool)).violations, []);
});

test("0014 wallet_transactions : chaque CHECK (type, référence, métadonnées, recharge) et la référence unique refusent leur cas", async () => {
  const reference = () => `adjustment:${randomBytes(8).toString("hex")}`;
  const insert = (over: Record<string, string>) => (client: PoolClient) => insertTransaction(client, over);
  await expectFailure("type inconnu", insert({ kind: "'refund'", reference: "'refund:abc'" }), "23514", "chk_wallet_transactions_kind");
  // Depuis la migration 0015 (lot P1b), boost_purchase est un type autorisé : sans les métadonnées de l'achat, c'est chk_wallet_transactions_boost qui le refuse.
  await expectFailure("type boost_purchase sans métadonnées d'achat", insert({ kind: "'boost_purchase'", reference: "'boost_purchase:abc'" }), "23514", "chk_wallet_transactions_boost");
  await expectFailure("référence avec espace", insert({ reference: "'adjustment:a b'" }), "23514", "chk_wallet_transactions_reference");
  await expectFailure("référence sans séparateur", insert({ reference: "'adjustmentabc'" }), "23514", "chk_wallet_transactions_reference");
  await expectFailure("référence d'un autre type", insert({ reference: "'topup:abc'" }), "23514", "chk_wallet_transactions_reference");
  await expectFailure("référence vide après le type", insert({ reference: "'adjustment:'" }), "23514", "chk_wallet_transactions_reference");
  await expectFailure("référence trop longue", insert({ reference: `'adjustment:${"a".repeat(101)}'` }), "23514", "chk_wallet_transactions_reference");
  await expectFailure("référence en majuscules pour le type", insert({ reference: "'Adjustment:abc'" }), "23514", "chk_wallet_transactions_reference");
  await expectFailure("référence déjà utilisée", async (client) => {
    const duplicate = reference();
    await insertTransaction(client, { reference: `'${duplicate}'` });
    await insertTransaction(client, { reference: `'${duplicate}'` });
  }, "23505", "uq_wallet_transactions_reference");

  const badMetadata: Array<[string, string]> = [
    ["tableau", "'[]'"],
    ["texte", "'\"texte\"'"],
    ["nombre", "'12'"],
    ["null JSON", "'null'"],
    ["clé inconnue (donnée personnelle possible)", "'{\"phone\":\"+2250700000000\"}'"],
    ["clé inconnue à côté d'une clé permise", "'{\"provider\":\"fake\",\"email\":\"a@b.c\"}'"],
    ["valeur imbriquée", "'{\"provider\":{\"nom\":\"fake\"}}'"],
    ["valeur non textuelle", "'{\"provider\":1}'"],
    ["valeur tableau", "'{\"reasonCode\":[\"x\"]}'"],
    ["provider en majuscules", "'{\"provider\":\"FAKE\"}'"],
    ["provider trop long", `'{"provider":"${"a".repeat(21)}"}'`],
    ["paymentIntentId non UUID", "'{\"paymentIntentId\":\"pas-un-uuid\"}'"],
    ["paymentIntentId en majuscules", `'{"paymentIntentId":"${randomUUID().toUpperCase()}"}'`],
    ["paymentIntentId nombre", "'{\"paymentIntentId\":12}'"],
    ["reasonCode avec espace", "'{\"reasonCode\":\"a b\"}'"],
    ["reasonCode trop long", `'{"reasonCode":"${"a".repeat(41)}"}'`],
  ];
  for (const [label, literal] of badMetadata) {
    await expectFailure(`métadonnées : ${label}`, insert({ metadata: `${literal}::jsonb` }), "23514", "chk_wallet_transactions_metadata");
  }
  const intentId = randomUUID();
  await expectFailure("recharge sans paymentIntentId", insert({ kind: "'topup'", reference: "'topup:abc'", metadata: "'{}'::jsonb" }), "23514", "chk_wallet_transactions_topup");
  await expectFailure("recharge dont la référence ne dérive pas de l'intention", insert({
    kind: "'topup'", reference: `'topup:${randomUUID()}'`, metadata: `'{"paymentIntentId":"${intentId}"}'::jsonb`,
  }), "23514", "chk_wallet_transactions_topup");
  // Cas passants : au COMMIT seulement, la transaction vide est refusée (équilibre) — c'est donc ce refus-là qui prouve que le CHECK a laissé passer.
  for (const literal of ["'{}'", "'{\"provider\":\"fake\"}'", "'{\"reasonCode\":\"manual_fix\"}'", `'{"paymentIntentId":"${intentId}","provider":"fake","reasonCode":"abc"}'`]) {
    await expectFailure(`métadonnées valides ${literal}`, insert({ metadata: `${literal}::jsonb` }), "23514", "trg_wallet_transaction_balanced", true);
  }
  await expectFailure("recharge cohérente", insert({
    kind: "'topup'", reference: `'topup:${intentId}'`, metadata: `'{"paymentIntentId":"${intentId}"}'::jsonb`,
  }), "23514", "trg_wallet_transaction_balanced", true);
});

test("0014 wallet_entries : montant non nul et borné, une écriture par compte et transaction, clés étrangères ; UPDATE et DELETE interdits sur le livre et le journal", async () => {
  const user = await makeUser();
  const account = await ensureUserWalletAccount(pool, user);
  const clearing = await systemAccount("provider_clearing");
  const withTransaction = (amount: string, accountId = account) => async (client: PoolClient) => {
    const transactionId = await insertTransaction(client);
    await insertEntry(client, transactionId, accountId, amount);
  };
  await expectFailure("écriture nulle", withTransaction("0"), "23514", "chk_wallet_entries_amount_non_zero");
  await expectFailure("écriture au-delà de 2^53 - 1", withTransaction("9007199254740992", clearing), "23514", "chk_wallet_entries_amount_range");
  await expectFailure("écriture sous -(2^53 - 1)", withTransaction("-9007199254740992", clearing), "23514", "chk_wallet_entries_amount_range");
  await expectFailure("compte absent", withTransaction("5", randomUUID()), "23503");
  await expectFailure("transaction absente", (client) => insertEntry(client, randomUUID(), account, "5"), "23503");
  await expectFailure("deux écritures du même compte dans une transaction", async (client) => {
    const transactionId = await insertTransaction(client);
    await insertEntry(client, transactionId, clearing, "5");
    await insertEntry(client, transactionId, clearing, "-5");
  }, "23505", "uq_wallet_entries_transaction_account");

  // Immuabilité : une opération existe, puis aucune modification ni suppression n'est possible.
  await adjustment(user, 300);
  await expectFailure("UPDATE du montant d'une écriture", (client) => client.query("UPDATE wallet_entries SET amount = amount"), "23001");
  await expectFailure("UPDATE du compte d'une écriture", (client) => client.query("UPDATE wallet_entries SET account_id = account_id"), "23001");
  await expectFailure("DELETE d'une écriture", (client) => client.query("DELETE FROM wallet_entries"), "23001");
  await expectFailure("UPDATE d'une transaction", (client) => client.query("UPDATE wallet_transactions SET kind = kind"), "23001");
  await expectFailure("UPDATE de la référence", (client) => client.query("UPDATE wallet_transactions SET reference = reference || 'x'"), "23001");
  await expectFailure("DELETE d'une transaction", (client) => client.query("DELETE FROM wallet_transactions"), "23001");
  const paid = await paidIntent(user, 700);
  assert.ok(paid.id);
  await expectFailure("UPDATE d'un événement du prestataire", (client) => client.query("UPDATE payment_events SET outcome = outcome"), "23001");
  await expectFailure("UPDATE de l'empreinte d'un événement", (client) => client.query("UPDATE payment_events SET payload_sha256 = repeat('0', 64)"), "23001");
  await expectFailure("DELETE d'un événement", (client) => client.query("DELETE FROM payment_events"), "23001");
  // Les refus n'ont rien modifié.
  assert.equal((await readWalletBalance(pool, user)).toString(), "1000");
});

test("0014 équilibre : somme des écritures nulle imposée au COMMIT (contrainte différée), transaction vide ou à une écriture refusée, déséquilibre transitoire permis", async () => {
  const user = await makeUser();
  const account = await ensureUserWalletAccount(pool, user);
  const clearing = await systemAccount("provider_clearing");
  const revenue = await systemAccount("boost_revenue");
  const before = { transactions: await count("wallet_transactions"), entries: await count("wallet_entries"), balance: await readWalletBalance(pool, user) };

  await expectFailure("une seule écriture", async (client) => {
    await insertEntry(client, await insertTransaction(client), account, "100");
  }, "23514", "trg_wallet_transaction_balanced", true);
  await expectFailure("somme non nulle (deux écritures)", async (client) => {
    const transactionId = await insertTransaction(client);
    await insertEntry(client, transactionId, account, "100");
    await insertEntry(client, transactionId, clearing, "-90");
  }, "23514", "trg_wallet_transaction_balanced", true);
  await expectFailure("somme non nulle (trois écritures)", async (client) => {
    const transactionId = await insertTransaction(client);
    await insertEntry(client, transactionId, account, "100");
    await insertEntry(client, transactionId, clearing, "-60");
    await insertEntry(client, transactionId, revenue, "-39");
  }, "23514", "trg_wallet_transaction_balanced", true);
  await expectFailure("transaction sans aucune écriture", async (client) => { await insertTransaction(client); }, "23514", "trg_wallet_transaction_balanced", true);
  await expectFailure("contrainte rendue immédiate (SET CONSTRAINTS) : le déséquilibre est refusé dès l'écriture", async (client) => {
    const transactionId = await insertTransaction(client);
    await insertEntry(client, transactionId, account, "50");
    await insertEntry(client, transactionId, clearing, "-50");
    await client.query("SET CONSTRAINTS ALL IMMEDIATE");
    await insertEntry(client, transactionId, revenue, "7");
  }, "23514", "trg_wallet_transaction_balanced", true);

  // Rien n'a été écrit par les transactions refusées.
  assert.equal(await count("wallet_transactions"), before.transactions);
  assert.equal(await count("wallet_entries"), before.entries);
  assert.equal((await readWalletBalance(pool, user)).toString(), before.balance.toString());

  // Déséquilibre transitoire permis dans la transaction (contrainte différée), équilibre exigé au COMMIT.
  assert.equal(await failureOf(async (client) => {
    const transactionId = await insertTransaction(client);
    await insertEntry(client, transactionId, account, "75");
    const inside = await client.query("SELECT balance::text AS balance FROM wallet_accounts WHERE id = $1", [account]);
    assert.equal(inside.rows[0].balance, (before.balance + big(75)).toString(), "le solde suit l'écriture dans la même transaction");
    await insertEntry(client, transactionId, clearing, "-75");
  }, true), null);
  assert.equal((await readWalletBalance(pool, user)).toString(), (before.balance + big(75)).toString());
});

test("0014 payment_intents : chaque CHECK, index unique et clé étrangère refuse son cas ; création en attente seulement", async () => {
  const owner = await makeUser();
  const insert = (over: Record<string, string>) => (client: PoolClient) => insertIntent(client, owner, over);
  await expectFailure("montant nul", insert({ amount_xof: "0" }), "23514", "chk_payment_intents_amount");
  await expectFailure("montant négatif", insert({ amount_xof: "-500" }), "23514", "chk_payment_intents_amount");
  await expectFailure("montant au-delà de 2^53 - 1", insert({ amount_xof: "9007199254740992" }), "23514", "chk_payment_intents_amount");
  await expectFailure("prestataire inconnu", insert({ provider: "'stripe'" }), "23514", "chk_payment_intents_provider");
  // Le déclencheur passe avant les CHECK : pour atteindre le CHECK du statut on le désactive le temps de l'essai (annulé ensuite).
  await expectFailure("statut inconnu (déclencheur désactivé)", async (client) => {
    await client.query("ALTER TABLE payment_intents DISABLE TRIGGER trg_payment_intents_guard");
    await insertIntent(client, owner, { status: "'done'", completed_at: "clock_timestamp()" });
  }, "23514", "chk_payment_intents_status");
  await expectFailure("statut inconnu (déclencheur actif)", insert({ status: "'done'" }), "23514", "trg_payment_intents_guard");
  await expectFailure("référence du prestataire trop courte", insert({ provider_reference: "'abc'" }), "23514", "chk_payment_intents_provider_reference");
  await expectFailure("référence du prestataire avec espace", insert({ provider_reference: "'fakepay abcdefgh'" }), "23514", "chk_payment_intents_provider_reference");
  await expectFailure("échéance non postérieure à la création", insert({ expires_at: "clock_timestamp() - interval '1 minute'" }), "23514", "chk_payment_intents_expiry");
  await expectFailure("en attente avec une date de fin", insert({ completed_at: "clock_timestamp()" }), "23514", "chk_payment_intents_completed");
  await expectFailure("propriétaire inexistant", (client) => insertIntent(client, randomUUID()), "23503");
  await expectFailure("création directement réussie", insert({ status: "'succeeded'", completed_at: "clock_timestamp()" }), "23514", "trg_payment_intents_guard");
  await expectFailure("création directement échouée", insert({ status: "'failed'", completed_at: "clock_timestamp()" }), "23514", "trg_payment_intents_guard");
  await expectFailure("création directement expirée", insert({ status: "'expired'", completed_at: "clock_timestamp()" }), "23514", "trg_payment_intents_guard");
  await expectFailure("terminée sans date de fin (transition)", async (client) => {
    const id = await insertIntent(client, owner);
    await client.query("UPDATE payment_intents SET status = 'failed' WHERE id = $1", [id]);
  }, "23514", "chk_payment_intents_completed");
  await expectFailure("date de fin antérieure à la création (transition)", async (client) => {
    const id = await insertIntent(client, owner);
    await client.query("UPDATE payment_intents SET status = 'failed', completed_at = created_at - interval '1 hour' WHERE id = $1", [id]);
  }, "23514", "chk_payment_intents_completed_order");
  await expectFailure("retour en attente avec une date de fin", async (client) => {
    const id = await insertIntent(client, owner);
    await client.query("UPDATE payment_intents SET completed_at = clock_timestamp() WHERE id = $1", [id]);
  }, "23514", "trg_payment_intents_guard");
  await expectFailure("même clé d'idempotence pour le même utilisateur", async (client) => {
    const key = `'${randomUUID()}'`;
    await insertIntent(client, owner, { idempotency_key: key });
    await insertIntent(client, owner, { idempotency_key: key });
  }, "23505", "uq_payment_intents_owner_idempotency");
  await expectFailure("même référence du prestataire", async (client) => {
    const reference = `'fakepay_${randomBytes(8).toString("hex")}'`;
    await insertIntent(client, owner, { provider_reference: reference });
    await insertIntent(client, owner, { provider_reference: reference });
  }, "23505", "uq_payment_intents_provider_reference");
  await expectAccepted("même clé d'idempotence pour deux utilisateurs différents", async (client) => {
    const key = `'${randomUUID()}'`;
    await insertIntent(client, owner, { idempotency_key: key });
    await insertIntent(client, await makeUser(), { idempotency_key: key });
  });
  await expectAccepted("intention en attente, 500 000 XOF", insert({ amount_xof: "500000" }));
});

test("0014 payment_intents : seules transitions pending → succeeded | failed | expired et expired → succeeded ; champs figés ; aucune suppression", async () => {
  const owner = await makeUser();
  const reach = async (client: PoolClient, state: "pending" | "failed" | "succeeded" | "expired"): Promise<string> => {
    const id = await insertIntent(client, owner);
    if (state !== "pending") await client.query("UPDATE payment_intents SET status = $2, completed_at = clock_timestamp() WHERE id = $1", [id, state]);
    return id;
  };
  const move = (from: "pending" | "failed" | "succeeded" | "expired", to: string) => async (client: PoolClient) => {
    const id = await reach(client, from);
    await client.query("UPDATE payment_intents SET status = $2, completed_at = clock_timestamp() WHERE id = $1", [id, to]);
  };
  for (const [from, to] of [["pending", "succeeded"], ["pending", "failed"], ["pending", "expired"], ["expired", "succeeded"]] as const) {
    await expectAccepted(`${from} → ${to}`, move(from, to));
  }
  for (const [from, to] of [
    ["pending", "pending"], ["failed", "succeeded"], ["failed", "pending"], ["failed", "expired"], ["failed", "failed"],
    ["succeeded", "pending"], ["succeeded", "failed"], ["succeeded", "expired"], ["succeeded", "succeeded"],
    ["expired", "pending"], ["expired", "failed"], ["expired", "expired"],
  ] as const) {
    // « → pending » est refusé par le CHECK de cohérence de la date de fin lorsqu'elle est renseignée : on teste la transition elle-même.
    if (to === "pending") {
      await expectFailure(`${from} → pending`, async (client) => {
        const id = await reach(client, from);
        await client.query("UPDATE payment_intents SET status = 'pending', completed_at = NULL WHERE id = $1", [id]);
      }, "23514", "trg_payment_intents_guard");
    } else {
      await expectFailure(`${from} → ${to}`, move(from, to), "23514", "trg_payment_intents_guard");
    }
  }
  // La date de fin ne se réécrit pas sans transition (même statut) ; un succès tardif met à jour completed_at par la transition expired → succeeded.
  await expectFailure("réécriture de completed_at sans changer de statut", async (client) => {
    const id = await reach(client, "failed");
    await client.query("UPDATE payment_intents SET completed_at = clock_timestamp() WHERE id = $1", [id]);
  }, "23514", "trg_payment_intents_guard");
  // Champs figés.
  for (const [label, assignment] of [
    ["amount_xof", "amount_xof = amount_xof + 100"], ["owner_id", `owner_id = '${await makeUser()}'`], ["provider_reference", "provider_reference = 'fakepay_autre_chose'"],
    ["idempotency_key", `idempotency_key = '${randomUUID()}'`], ["created_at", "created_at = created_at - interval '1 minute'"],
    ["expires_at", "expires_at = expires_at + interval '1 hour'"], ["id", `id = '${randomUUID()}'`], ["provider", "provider = 'fake'"],
  ] as const) {
    const expectation = label === "provider" ? "accepted" : "refused";
    const operation = async (client: PoolClient) => {
      const id = await reach(client, "pending");
      await client.query(`UPDATE payment_intents SET ${assignment}, status = 'failed', completed_at = clock_timestamp() WHERE id = $1`, [id]);
    };
    if (expectation === "accepted") await expectAccepted(`${label} réécrit à l'identique (permis)`, operation);
    else await expectFailure(`${label} modifié`, operation, "23001");
  }
  await expectFailure("suppression d'une intention", async (client) => {
    const id = await reach(client, "pending");
    await client.query("DELETE FROM payment_intents WHERE id = $1", [id]);
  }, "23001");
});

test("0014 payment_events : chaque CHECK, la clé unique (prestataire, événement) et la clé étrangère refusent leur cas", async () => {
  const owner = await makeUser();
  const withIntent = (over: Record<string, string>) => async (client: PoolClient) => {
    await insertEvent(client, await insertIntent(client, owner), over);
  };
  await expectFailure("prestataire inconnu", withIntent({ provider: "'stripe'" }), "23514", "chk_payment_events_provider");
  await expectFailure("identifiant d'événement trop court", withIntent({ provider_event_id: "'abc'" }), "23514", "chk_payment_events_event_id");
  await expectFailure("identifiant d'événement avec espace", withIntent({ provider_event_id: "'evt 12345678'" }), "23514", "chk_payment_events_event_id");
  await expectFailure("type inconnu", withIntent({ type: "'payment.refunded'" }), "23514", "chk_payment_events_type");
  await expectFailure("montant nul", withIntent({ amount_xof: "0" }), "23514", "chk_payment_events_amount");
  await expectFailure("montant au-delà de 2^53 - 1", withIntent({ amount_xof: "9007199254740992" }), "23514", "chk_payment_events_amount");
  await expectFailure("empreinte mal formée", withIntent({ payload_sha256: "'abc'" }), "23514", "chk_payment_events_sha256");
  await expectFailure("empreinte en majuscules", withIntent({ payload_sha256: `'${sha("x").toUpperCase()}'` }), "23514", "chk_payment_events_sha256");
  await expectFailure("issue inconnue", withIntent({ outcome: "'maybe'" }), "23514", "chk_payment_events_outcome");
  await expectFailure("intention inconnue sans intention rattachée mais issue « appliqué »", (client) => insertEvent(client, null, { outcome: "'applied'" }), "23514", "chk_payment_events_intent");
  await expectFailure("intention rattachée avec l'issue « intention inconnue »", withIntent({ outcome: "'rejected_unknown_intent'" }), "23514", "chk_payment_events_intent");
  await expectFailure("intention inexistante", (client) => insertEvent(client, randomUUID()), "23503");
  await expectFailure("même événement du même prestataire deux fois", async (client) => {
    const intent = await insertIntent(client, owner);
    await insertEvent(client, intent, { provider_event_id: "'evt_same_event'" });
    await insertEvent(client, intent, { provider_event_id: "'evt_same_event'", type: "'payment.failed'" });
  }, "23505", "uq_payment_events_provider_event");
  for (const outcome of ["applied", "duplicate", "rejected_amount", "rejected_state"]) {
    await expectAccepted(`issue ${outcome}`, withIntent({ outcome: `'${outcome}'` }));
  }
  await expectAccepted("intention inconnue", (client) => insertEvent(client, null));
});

// ═════════════ 2. Grand livre (domaine) ═════════════

test("grand livre : comptes créés à la demande, crédit puis débit, solde tenu dans la même transaction, historique signé du plus récent au plus ancien", async () => {
  const user = await makeUser();
  const countAccounts = async () => Number(await scalar(pool, "SELECT count(*)::int AS n FROM wallet_accounts WHERE owner_id = $1", [user]));
  assert.equal(await readWalletBalance(pool, user), ZERO, "sans compte : solde nul");
  assert.deepEqual(await readWalletOverview({ pool, ownerId: user }), { balance: ZERO, promoBalance: ZERO, promoExpiresAt: null, items: [], nextCursor: null });
  assert.equal(await countAccounts(), 0, "les lectures ne créent aucun compte");
  const revenueBefore = big(await scalar(pool, "SELECT balance::text AS n FROM wallet_accounts WHERE kind = 'boost_revenue'"));

  const credit = await adjustment(user, 1500);
  assert.equal(await countAccounts(), 1, "compte créé à la première écriture");
  assert.equal(credit.kind, "adjustment");
  assert.equal(credit.entries.length, 2);
  assert.equal(credit.entries.reduce((sum, entry) => sum + entry.amount, ZERO), ZERO, "somme des écritures = 0");
  assert.deepEqual(credit.entries.map((entry) => entry.accountId), [...credit.entries.map((entry) => entry.accountId)].sort(), "écritures insérées par identifiant de compte croissant");
  assert.equal(await readWalletBalance(pool, user), big(1500));

  const debit = await recordWalletTransaction(pool, {
    kind: "adjustment", reference: `adjustment:debit-${randomUUID()}`,
    entries: [{ account: { kind: "user", ownerId: user }, amount: -big(400) }, { account: { kind: "boost_revenue" }, amount: big(400) }],
  });
  assert.equal(await readWalletBalance(pool, user), big(1100));
  assert.equal(await countAccounts(), 1, "toujours un seul compte");
  assert.equal(big(await scalar(pool, "SELECT balance::text AS n FROM wallet_accounts WHERE kind = 'boost_revenue'")), revenueBefore - big(1500) + big(400), "compte système mis à jour dans la même opération");
  const stored = (await pool.query("SELECT kind, reference, metadata FROM wallet_transactions WHERE id = $1", [credit.id])).rows[0];
  assert.equal(stored.kind, "adjustment");
  assert.deepEqual(stored.metadata, { reasonCode: "test_fixture" });

  const overview = await readWalletOverview({ pool, ownerId: user });
  assert.equal(overview.balance, big(1100));
  assert.deepEqual(overview.items.map((item) => [item.id, item.kind, item.amount]), [[debit.id, "adjustment", -big(400)], [credit.id, "adjustment", big(1500)]]);
  assert.equal(overview.nextCursor, null);
  assert.ok(overview.items.every((item) => item.createdAt instanceof Date));
  // Un autre utilisateur ne voit rien de ce compte.
  assert.deepEqual(await readWalletOverview({ pool, ownerId: await makeUser() }), { balance: ZERO, promoBalance: ZERO, promoExpiresAt: null, items: [], nextCursor: null });
});

test("historique : pages par curseur sans trou ni doublon, ordre stable, limite bornée, curseur invalide refusé", async () => {
  const user = await makeUser();
  const ids: string[] = [];
  for (let index = 0; index < 25; index++) ids.push((await adjustment(user, 100 + index)).id);
  const expectedOrder = [...ids].reverse();
  const seen: string[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const page = await readWalletOverview({ pool, ownerId: user, limit: 10, cursor });
    pages += 1;
    assert.ok(page.items.length <= 10);
    seen.push(...page.items.map((item) => item.id));
    cursor = page.nextCursor;
  } while (cursor !== null && pages < 10);
  assert.equal(pages, 3, "25 lignes, pages de 10");
  assert.deepEqual(seen, expectedOrder, "plus récent d'abord, sans trou ni doublon");
  assert.equal((await readWalletOverview({ pool, ownerId: user })).items.length, 20, "20 lignes par défaut");
  assert.equal((await readWalletOverview({ pool, ownerId: user })).nextCursor === null, false);
  assert.equal((await readWalletOverview({ pool, ownerId: user, limit: 25 })).nextCursor, null, "exactement 25 lignes : pas de page suivante");
  for (const limit of [0, -1, 51, 1.5, Number.NaN, "10" as unknown as number]) {
    await assert.rejects(readWalletOverview({ pool, ownerId: user, limit }), CatalogValidationError, `limite ${String(limit)}`);
  }
  for (const cursor of ["", "abc", "x".repeat(200), Buffer.from("2032-01-01|x").toString("base64url")]) {
    await assert.rejects(readWalletOverview({ pool, ownerId: user, cursor }), CatalogValidationError);
  }
});

test("solde utilisateur négatif : insufficient_balance, aucune trace ; solde exact permis ; référence déjà utilisée et propriétaire inconnu refusés", async () => {
  const user = await makeUser();
  await adjustment(user, 500);
  const traces = async () => [await count("wallet_transactions"), await count("wallet_entries"), String(await readWalletBalance(pool, user))];
  const before = await traces();
  const debit = (amount: number, reference = `adjustment:debit-${randomUUID()}`): Promise<unknown> => recordWalletTransaction(pool, {
    kind: "adjustment", reference,
    entries: [{ account: { kind: "user", ownerId: user }, amount: -big(amount) }, { account: { kind: "boost_revenue" }, amount: big(amount) }],
  });
  assert.equal(await walletError(debit(501)), "insufficient_balance");
  assert.deepEqual(await traces(), before, "le refus n'a laissé ni transaction, ni écriture, ni changement de solde");
  assert.equal(await walletError(debit(500)), "ok");
  assert.equal(await readWalletBalance(pool, user), ZERO, "solde exactement nul permis");
  assert.equal(await walletError(debit(1)), "insufficient_balance");
  assert.equal(await readWalletBalance(pool, user), ZERO);

  const reference = `adjustment:once-${randomUUID()}`;
  await adjustment(user, 50);
  assert.equal(await walletError(debit(10, reference)), "ok");
  const afterFirst = await traces();
  assert.equal(await walletError(debit(10, reference)), "duplicate_reference");
  assert.deepEqual(await traces(), afterFirst, "la référence rejouée n'a rien écrit : une seule opération");

  const ghost = randomUUID();
  const rowsBefore = await count("wallet_accounts");
  assert.equal(await walletError(recordWalletTransaction(pool, {
    kind: "adjustment", reference: `adjustment:ghost-${randomUUID()}`,
    entries: [{ account: { kind: "boost_revenue" }, amount: -big(5) }, { account: { kind: "user", ownerId: ghost } , amount: big(5) }],
  })), "account_owner_not_found");
  assert.equal(await count("wallet_accounts"), rowsBefore);
});

test("postWalletTransaction : exige la transaction de l'appelant, et reste atomique avec les autres écritures de cette transaction", async () => {
  const user = await makeUser();
  await adjustment(user, 900);
  const input: WalletTransactionInput = {
    kind: "adjustment", reference: `adjustment:caller-${randomUUID()}`,
    entries: [{ account: { kind: "user", ownerId: user }, amount: -big(200) }, { account: { kind: "boost_revenue" }, amount: big(200) }],
  };
  const bare = await pool.connect();
  try {
    await assert.rejects(postWalletTransaction(bare, input), CatalogValidationError, "client hors transaction refusé");
  } finally { bare.release(); }
  assert.equal(await readWalletBalance(pool, user), big(900), "rien n'a été écrit hors transaction");

  const failure = new Error("échec après l'écriture");
  await assert.rejects(withPostgresTransaction(async (client) => {
    await postWalletTransaction(client, input);
    const inside = await client.query("SELECT balance::text AS n FROM wallet_accounts WHERE owner_id = $1", [user]);
    assert.equal(inside.rows[0].n, "700", "visible dans la transaction");
    throw failure;
  }, pool), (error) => error === failure);
  assert.equal(await readWalletBalance(pool, user), big(900), "annulée avec la transaction de l'appelant");
  assert.equal(Number(await scalar(pool, "SELECT count(*)::int AS n FROM wallet_transactions WHERE reference = $1", [input.reference])), 0);

  await withPostgresTransaction((client) => postWalletTransaction(client, input), pool);
  assert.equal(await readWalletBalance(pool, user), big(700));
});

test("concurrence du grand livre : 10 débits simultanés de 100 sur 500 → exactement 5 réussissent, 5 insufficient_balance, solde final 0, jamais négatif", async () => {
  const user = await makeUser();
  await adjustment(user, 500);
  const pools = await distinctPools(10);
  const { gate, open } = barrier();
  const attempts = pools.map(async (db, index) => {
    await gate;
    return walletError(recordWalletTransaction(db, {
      kind: "adjustment", reference: `adjustment:race-${index}-${randomUUID()}`,
      entries: [{ account: { kind: "user", ownerId: user }, amount: -big(100) }, { account: { kind: "boost_revenue" }, amount: big(100) }],
    }));
  });
  open();
  const results = await Promise.all(attempts);
  assert.equal(results.filter((result) => result === "ok").length, 5, JSON.stringify(results));
  assert.equal(results.filter((result) => result === "insufficient_balance").length, 5, JSON.stringify(results));
  assert.equal(await readWalletBalance(pool, user), ZERO);
});

test("concurrence du grand livre : transferts croisés simultanés entre deux comptes → aucun interblocage (verrous de comptes pris par identifiant croissant)", async () => {
  const left = await makeUser();
  const right = await makeUser();
  await adjustment(left, 100_000);
  await adjustment(right, 100_000);
  const rounds = 6;
  const size = 12;
  const pools = await distinctPools(size);
  for (let round = 0; round < rounds; round++) {
    const { gate, open } = barrier();
    const attempts = pools.map(async (db, index) => {
      await gate;
      const [from, to] = index % 2 === 0 ? [left, right] : [right, left];
      return walletError(recordWalletTransaction(db, {
        kind: "adjustment", reference: `adjustment:swap-${round}-${index}-${randomUUID()}`,
        entries: [{ account: { kind: "user", ownerId: from }, amount: -big(100) }, { account: { kind: "user", ownerId: to }, amount: big(100) }],
      }));
    });
    open();
    const results = await Promise.all(attempts);
    assert.deepEqual([...new Set(results)], ["ok"], `tour ${round} : ${JSON.stringify(results)}`);
  }
  assert.equal(await readWalletBalance(pool, left), big(100_000), "autant de transferts dans chaque sens");
  assert.equal(await readWalletBalance(pool, right), big(100_000));
});

// ═════════════ 3. Recharges : intentions ═════════════

test("recharge : intention en attente (30 min, référence du prestataire, aucune écriture au grand livre) ; lecture réservée au propriétaire, inexistante et d'autrui indiscernables", async () => {
  const owner = await makeUser();
  const other = await makeUser();
  const transactions = await count("wallet_transactions");
  const created = await createTopupIntent({ pool, ownerId: owner, amountXof: big(2500), idempotencyKey: randomUUID() });
  assert.equal(created.reused, false);
  const { intent } = created;
  assert.equal(intent.ownerId, owner);
  assert.equal(intent.amountXof, big(2500));
  assert.equal(intent.provider, "fake");
  assert.equal(intent.status, "pending");
  assert.equal(intent.storedStatus, "pending");
  assert.equal(intent.completedAt, null);
  assert.equal(intent.expiresAt.getTime() - intent.createdAt.getTime(), 30 * 60 * 1000, "validité exacte de 30 minutes");
  assert.match(intent.providerReference, /^fakepay_[0-9a-f]{24}$/);
  assert.equal(await count("wallet_transactions"), transactions, "créer une intention ne touche pas le grand livre");
  assert.equal(await readWalletBalance(pool, owner), ZERO);

  const own = await readTopupIntent({ pool, ownerId: owner, intentId: intent.id });
  assert.equal(own?.id, intent.id);
  assert.equal(own?.status, "pending");
  assert.equal(await readTopupIntent({ pool, ownerId: other, intentId: intent.id }), null, "intention d'autrui : null");
  assert.equal(await readTopupIntent({ pool, ownerId: owner, intentId: randomUUID() }), null, "intention inexistante : null, comme celle d'autrui");
});

test("recharge : le statut est EFFECTIF (échue = expired avant tout balayage) et le balayage l'enregistre", async () => {
  await drainDueIntents();
  const owner = await makeUser();
  const id = await expiredPendingIntent(owner, 1200);
  const before = await readTopupIntent({ pool, ownerId: owner, intentId: id });
  assert.equal(before?.status, "expired", "statut effectif");
  assert.equal(before?.storedStatus, "pending", "statut enregistré inchangé tant que le balayage n'a pas eu lieu");
  const fresh = await newIntent(owner);
  assert.equal((await readTopupIntent({ pool, ownerId: owner, intentId: fresh.id }))?.status, "pending");
  assert.deepEqual(await expirePaymentIntents({ pool, limit: 1000 }), { expired: 1 });
  const after = await readTopupIntent({ pool, ownerId: owner, intentId: id });
  assert.equal(after?.status, "expired");
  assert.equal(after?.storedStatus, "expired");
  assert.ok(after?.completedAt instanceof Date);
});

test("idempotence : même clé et même montant → même intention (aucune écriture) ; autre montant → idempotency_conflict ; clé en majuscules identique ; clés indépendantes entre utilisateurs", async () => {
  const owner = await makeUser();
  const other = await makeUser();
  const key = randomUUID();
  const first = await createTopupIntent({ pool, ownerId: owner, amountXof: big(1000), idempotencyKey: key });
  const again = await createTopupIntent({ pool, ownerId: owner, amountXof: big(1000), idempotencyKey: key });
  const upper = await createTopupIntent({ pool, ownerId: owner, amountXof: big(1000), idempotencyKey: key.toUpperCase() });
  assert.equal(first.reused, false);
  assert.equal(again.reused, true);
  assert.equal(upper.reused, true);
  assert.deepEqual([again.intent.id, upper.intent.id], [first.intent.id, first.intent.id]);
  assert.equal(Number(await scalar(pool, "SELECT count(*)::int AS n FROM payment_intents WHERE owner_id = $1", [owner])), 1);
  assert.equal(await walletError(createTopupIntent({ pool, ownerId: owner, amountXof: big(2000), idempotencyKey: key })), "idempotency_conflict");
  assert.equal(Number(await scalar(pool, "SELECT count(*)::int AS n FROM payment_intents WHERE owner_id = $1", [owner])), 1, "le conflit n'a rien créé");
  const foreign = await createTopupIntent({ pool, ownerId: other, amountXof: big(2000), idempotencyKey: key });
  assert.equal(foreign.reused, false, "la même clé chez un autre utilisateur est une autre intention");
  assert.notEqual(foreign.intent.id, first.intent.id);
  // Après paiement, la même demande renvoie la même intention (et son statut réel), jamais une nouvelle.
  assert.equal((await apply(eventFor(first.intent))).outcome, "applied");
  const replayAfterPayment = await createTopupIntent({ pool, ownerId: owner, amountXof: big(1000), idempotencyKey: key });
  assert.equal(replayAfterPayment.reused, true);
  assert.equal(replayAfterPayment.intent.status, "succeeded");
  assert.equal(replayAfterPayment.intent.id, first.intent.id);
});

test("limite : au plus 5 intentions en attente et non échues ; les autres statuts et les intentions échues ne comptent pas ; la limite est par utilisateur", async () => {
  const owner = await makeUser();
  const other = await makeUser();
  const keys: string[] = [];
  for (let index = 0; index < 5; index++) {
    const key = randomUUID();
    keys.push(key);
    assert.equal((await createTopupIntent({ pool, ownerId: owner, amountXof: big(500), idempotencyKey: key })).reused, false);
  }
  assert.equal(await walletError(createTopupIntent({ pool, ownerId: owner, amountXof: big(500), idempotencyKey: randomUUID() })), "too_many_pending_topups");
  assert.equal(Number(await scalar(pool, "SELECT count(*)::int AS n FROM payment_intents WHERE owner_id = $1", [owner])), 5, "la sixième n'a pas été créée");
  assert.equal((await createTopupIntent({ pool, ownerId: owner, amountXof: big(500), idempotencyKey: keys[0] })).reused, true, "rejouer une clé connue reste permis à la limite");
  assert.equal(await walletError(createTopupIntent({ pool, ownerId: owner, amountXof: big(600), idempotencyKey: keys[0] })), "idempotency_conflict", "et un autre montant reste un conflit, pas une limite");
  assert.equal((await createTopupIntent({ pool, ownerId: other, amountXof: big(500), idempotencyKey: randomUUID() })).reused, false, "un autre utilisateur n'est pas concerné");

  // Une intention qui n'est plus en attente libère une place.
  const failed = (await createTopupIntent({ pool, ownerId: owner, amountXof: big(500), idempotencyKey: keys[0] })).intent;
  assert.equal((await apply(eventFor(failed, { type: "payment.failed" }))).outcome, "applied");
  assert.equal((await createTopupIntent({ pool, ownerId: owner, amountXof: big(500), idempotencyKey: randomUUID() })).reused, false, "une place libérée par un échec");
  assert.equal(await walletError(createTopupIntent({ pool, ownerId: owner, amountXof: big(500), idempotencyKey: randomUUID() })), "too_many_pending_topups");

  // Les intentions échues (même non balayées) ne comptent pas.
  const third = await makeUser();
  for (let index = 0; index < 4; index++) await expiredPendingIntent(third);
  for (let index = 0; index < 5; index++) await createTopupIntent({ pool, ownerId: third, amountXof: big(500), idempotencyKey: randomUUID() });
  assert.equal(await walletError(createTopupIntent({ pool, ownerId: third, amountXof: big(500), idempotencyKey: randomUUID() })), "too_many_pending_topups");
});

test("concurrence : 6 créations simultanées avec la même clé (verrou de l'utilisateur) → une seule ligne, six réponses de même identifiant, une seule `reused: false`", async () => {
  const owner = await makeUser();
  const key = randomUUID();
  const pools = await distinctPools(6);
  const { results, waiting } = await contended("payment_intents", () => pools.map((db) =>
    createTopupIntent({ pool: db, ownerId: owner, amountXof: big(3000), idempotencyKey: key })), 6);
  assert.equal(waiting, 6, "les six transactions attendaient en même temps");
  const settled = results.map((result) => result.status === "fulfilled" ? result.value : result.reason);
  assert.ok(settled.every((value) => !(value instanceof Error)), JSON.stringify(settled.map((value) => value instanceof Error ? value.message : "ok")));
  const created = settled as Array<Awaited<ReturnType<typeof createTopupIntent>>>;
  assert.equal(new Set(created.map((entry) => entry.intent.id)).size, 1, "une seule intention");
  assert.equal(created.filter((entry) => !entry.reused).length, 1, "une seule création");
  assert.equal(Number(await scalar(pool, "SELECT count(*)::int AS n FROM payment_intents WHERE owner_id = $1", [owner])), 1);
});

test("concurrence : 8 créations simultanées avec des clés différentes → exactement 5 créées et 3 too_many_pending_topups", async () => {
  const owner = await makeUser();
  const pools = await distinctPools(8);
  const { results, waiting } = await contended("payment_intents", () => pools.map((db) =>
    createTopupIntent({ pool: db, ownerId: owner, amountXof: big(500), idempotencyKey: randomUUID() })), 8);
  assert.equal(waiting, 8);
  const outcomes = results.map((result) => result.status === "fulfilled" ? "created" : result.reason instanceof WalletError ? result.reason.code : `erreur: ${String(result.reason)}`);
  assert.equal(outcomes.filter((outcome) => outcome === "created").length, 5, JSON.stringify(outcomes));
  assert.equal(outcomes.filter((outcome) => outcome === "too_many_pending_topups").length, 3, JSON.stringify(outcomes));
  assert.equal(Number(await scalar(pool, "SELECT count(*)::int AS n FROM payment_intents WHERE owner_id = $1", [owner])), 5);
});

/**
 * Lance `launch` pendant qu'une session tient un verrou de table (SHARE ROW EXCLUSIVE : bloque les écritures, pas les lectures ni
 * FOR UPDATE), attend que `waiters` sessions soient en attente d'un verrou, puis relâche. La contention est donc réelle et
 * reproductible : un verrou manquant dans le code testé se voit au résultat.
 */
async function contended<T>(table: string, launch: () => Array<Promise<T>>, waiters: number): Promise<{ results: Array<PromiseSettledResult<T>>; waiting: number }> {
  const holder = await holderPool.connect();
  let attempts: Array<Promise<T>> = [];
  let waiting = 0;
  try {
    await holder.query("BEGIN");
    await holder.query(`LOCK TABLE ${table} IN SHARE ROW EXCLUSIVE MODE`);
    attempts = launch();
    waiting = await waitForLockWaiters(waiters, 6_000);
    await holder.query("COMMIT");
  } finally {
    await holder.query("ROLLBACK").catch(() => {});
    holder.release();
  }
  return { results: await Promise.allSettled(attempts), waiting };
}

// ═════════════ 4. Recharges : événements du prestataire ═════════════

const ledgerRows = async (intentId: string) => (await pool.query(
  `SELECT t.kind, t.reference, t.metadata, e.amount::text AS amount, a.kind AS account_kind
     FROM wallet_transactions t JOIN wallet_entries e ON e.transaction_id = t.id JOIN wallet_accounts a ON a.id = e.account_id
    WHERE t.reference = $1 ORDER BY e.amount`, [`topup:${intentId}`])).rows;
const eventsOf = async (intentId: string) => (await pool.query(
  "SELECT provider_event_id, type, amount_xof::text AS amount, payload_sha256, outcome, intent_id FROM payment_events WHERE intent_id = $1 ORDER BY received_at, id", [intentId])).rows;
const statusOf = async (intentId: string) => (await pool.query("SELECT status, completed_at FROM payment_intents WHERE id = $1", [intentId])).rows[0];

test("événement payment.succeeded : intention réussie, recharge de référence unique (débit provider_clearing, crédit du compte), événement journalisé « applied »", async () => {
  const owner = await makeUser();
  const intent = await newIntent(owner, 2500);
  const clearingBefore = big(await scalar(pool, "SELECT balance::text AS n FROM wallet_accounts WHERE kind = 'provider_clearing'"));
  const event = eventFor(intent);
  const result = await apply(event);
  assert.deepEqual(result, { outcome: "applied", intentId: intent.id });
  assert.equal(await readWalletBalance(pool, owner), big(2500));
  assert.equal(big(await scalar(pool, "SELECT balance::text AS n FROM wallet_accounts WHERE kind = 'provider_clearing'")), clearingBefore - big(2500), "provider_clearing débité");
  const status = await statusOf(intent.id);
  assert.equal(status.status, "succeeded");
  assert.ok(status.completed_at instanceof Date);
  assert.deepEqual(await ledgerRows(intent.id), [
    { kind: "topup", reference: `topup:${intent.id}`, metadata: { paymentIntentId: intent.id, provider: "fake" }, amount: "-2500", account_kind: "provider_clearing" },
    { kind: "topup", reference: `topup:${intent.id}`, metadata: { paymentIntentId: intent.id, provider: "fake" }, amount: "2500", account_kind: "user" },
  ]);
  assert.deepEqual(await eventsOf(intent.id), [{
    provider_event_id: event.eventId, type: "payment.succeeded", amount: "2500", payload_sha256: event.payloadSha256, outcome: "applied", intent_id: intent.id,
  }]);
  const overview = await readWalletOverview({ pool, ownerId: owner });
  assert.deepEqual(overview.items.map((item) => [item.kind, item.amount]), [["topup", big(2500)]]);
  assert.equal((await readTopupIntent({ pool, ownerId: owner, intentId: intent.id }))?.status, "succeeded");
});

test("événement payment.failed : pending → failed, aucun crédit ; une intention échouée ne peut plus réussir (rejected_state) ni être rejouée autrement (duplicate)", async () => {
  const owner = await makeUser();
  const intent = await newIntent(owner, 1800);
  assert.deepEqual(await apply(eventFor(intent, { type: "payment.failed" })), { outcome: "applied", intentId: intent.id });
  assert.equal((await statusOf(intent.id)).status, "failed");
  assert.equal(await readWalletBalance(pool, owner), ZERO);
  assert.deepEqual(await ledgerRows(intent.id), []);
  assert.equal((await apply(eventFor(intent, { type: "payment.succeeded" }))).outcome, "rejected_state", "failed puis succeeded");
  assert.equal((await apply(eventFor(intent, { type: "payment.failed" }))).outcome, "duplicate", "failed puis failed (autre événement)");
  assert.equal((await statusOf(intent.id)).status, "failed", "toujours échouée");
  assert.equal(await readWalletBalance(pool, owner), ZERO, "aucun crédit");
  assert.deepEqual((await eventsOf(intent.id)).map((row) => row.outcome), ["applied", "rejected_state", "duplicate"], "tout événement valide est journalisé");
});

test("événement rejoué (même identifiant) : aucune ligne ajoutée, aucun crédit ; corps différent signalé ; deux événements DISTINCTS pour la même intention → un seul crédit, « duplicate » journalisé", async () => {
  const owner = await makeUser();
  const intent = await newIntent(owner, 4000);
  const event = eventFor(intent);
  assert.equal((await apply(event)).outcome, "applied");
  const replay = await apply(event);
  assert.deepEqual(replay, { outcome: "replayed", intentId: intent.id, payloadMatches: true });
  const tampered = await apply({ ...event, payloadSha256: sha("autre corps") });
  assert.deepEqual(tampered, { outcome: "replayed", intentId: intent.id, payloadMatches: false }, "même identifiant, corps différent : rien n'est refait, le désaccord est signalé");
  assert.equal(await readWalletBalance(pool, owner), big(4000));
  assert.equal((await eventsOf(intent.id)).length, 1, "une relecture n'ajoute aucune ligne au journal");
  const second = eventFor(intent);
  assert.deepEqual(await apply(second), { outcome: "duplicate", intentId: intent.id });
  assert.equal(await readWalletBalance(pool, owner), big(4000), "un seul crédit");
  assert.deepEqual((await eventsOf(intent.id)).map((row) => row.outcome), ["applied", "duplicate"]);
  assert.equal((await ledgerRows(intent.id)).length, 2, "une seule transaction de recharge (deux écritures)");
});

test("montant falsifié : rejected_amount, aucun crédit, intention intacte, événement journalisé ; l'intention peut encore être payée au bon montant", async () => {
  const owner = await makeUser();
  const intent = await newIntent(owner, 1000);
  for (const [type, forged] of [["payment.succeeded", 1100], ["payment.succeeded", 900], ["payment.succeeded", 1], ["payment.succeeded", 100_000_000], ["payment.failed", 999]] as const) {
    const result = await apply(eventFor(intent, { type, amountXof: big(forged) }));
    assert.equal(result.outcome, "rejected_amount", `${type} à ${forged}`);
  }
  assert.equal(await readWalletBalance(pool, owner), ZERO);
  assert.equal((await statusOf(intent.id)).status, "pending", "ni crédit ni échec");
  assert.deepEqual((await eventsOf(intent.id)).map((row) => row.outcome), ["rejected_amount", "rejected_amount", "rejected_amount", "rejected_amount", "rejected_amount"]);
  assert.deepEqual(await ledgerRows(intent.id), []);
  assert.equal((await apply(eventFor(intent))).outcome, "applied", "le bon montant passe ensuite");
  assert.equal(await readWalletBalance(pool, owner), big(1000));
  // Le montant falsifié n'est pas non plus pris en compte sur une intention déjà payée.
  assert.equal((await apply(eventFor(intent, { amountXof: big(5000) }))).outcome, "rejected_amount");
  assert.equal(await readWalletBalance(pool, owner), big(1000));
});

test("intention expirée : un payment.succeeded est APPLIQUÉ (l'argent a été pris) ; un payment.failed est refusé ; un second succès est un doublon", async () => {
  await drainDueIntents();
  const owner = await makeUser();
  const expiredId = await expiredPendingIntent(owner, 3500);
  assert.deepEqual(await expirePaymentIntents({ pool }), { expired: 1 });
  const expired = (await readTopupIntent({ pool, ownerId: owner, intentId: expiredId }))!;
  assert.equal(expired.storedStatus, "expired");
  assert.equal((await apply(eventFor(expired, { type: "payment.failed" }))).outcome, "rejected_state");
  assert.equal((await statusOf(expiredId)).status, "expired");
  assert.equal(await readWalletBalance(pool, owner), ZERO);
  assert.deepEqual(await apply(eventFor(expired)), { outcome: "applied", intentId: expiredId });
  assert.equal((await statusOf(expiredId)).status, "succeeded");
  assert.equal(await readWalletBalance(pool, owner), big(3500));
  assert.equal((await apply(eventFor(expired))).outcome, "duplicate");
  assert.equal(await readWalletBalance(pool, owner), big(3500));
  assert.deepEqual((await eventsOf(expiredId)).map((row) => row.outcome), ["rejected_state", "applied", "duplicate"]);

  // Échue par le temps mais pas encore balayée : le paiement est appliqué aussi.
  const lateId = await expiredPendingIntent(owner, 800);
  const late = (await readTopupIntent({ pool, ownerId: owner, intentId: lateId }))!;
  assert.equal(late.storedStatus, "pending");
  assert.equal((await apply(eventFor(late))).outcome, "applied");
  assert.equal(await readWalletBalance(pool, owner), big(4300));
});

test("intention inconnue : rejected_unknown_intent journalisé sans intention rattachée, aucun crédit ; l'événement d'un autre utilisateur ne peut pas créditer un tiers", async () => {
  const owner = await makeUser();
  const before = await count("wallet_transactions");
  const stranger = { providerReference: "fakepay_inconnue000001", amountXof: big(1000) };
  const event = eventFor(stranger);
  assert.deepEqual(await apply(event), { outcome: "rejected_unknown_intent", intentId: null });
  const row = (await pool.query("SELECT intent_id, outcome FROM payment_events WHERE provider_event_id = $1", [event.eventId])).rows[0];
  assert.deepEqual(row, { intent_id: null, outcome: "rejected_unknown_intent" });
  assert.equal(await count("wallet_transactions"), before);
  assert.deepEqual(await apply(event), { outcome: "replayed", intentId: null, payloadMatches: true });
  // Le crédit va toujours au propriétaire de l'intention désignée, jamais à un autre.
  const intent = await newIntent(owner, 1500);
  const bystander = await makeUser();
  await apply(eventFor(intent));
  assert.equal(await readWalletBalance(pool, owner), big(1500));
  assert.equal(await readWalletBalance(pool, bystander), ZERO);
});

test("tout ou rien : si l'écriture du grand livre échoue (référence déjà prise), l'intention reste en attente et l'événement n'est pas journalisé", async () => {
  // Schéma « sale » : la référence topup:<intention> est occupée à l'avance par une opération sans intention réussie.
  const owner = await makeUser(dirtyPool);
  const intent = await newIntent(owner, 1000, dirtyPool);
  await recordWalletTransaction(dirtyPool, {
    kind: "topup", reference: `topup:${intent.id}`, metadata: { paymentIntentId: intent.id, provider: "fake" },
    entries: [{ account: { kind: "provider_clearing" }, amount: -big(1000) }, { account: { kind: "user", ownerId: owner }, amount: big(1000) }],
  });
  const events = Number(await scalar(dirtyPool, "SELECT count(*)::int AS n FROM payment_events"));
  const transactions = Number(await scalar(dirtyPool, "SELECT count(*)::int AS n FROM wallet_transactions"));
  const event = eventFor(intent);
  assert.equal(await walletError(apply(event, dirtyPool)), "duplicate_reference");
  const status = (await dirtyPool.query("SELECT status, completed_at FROM payment_intents WHERE id = $1", [intent.id])).rows[0];
  assert.equal(status.status, "pending", "la mise à jour de l'intention a été annulée");
  assert.equal(status.completed_at, null);
  assert.equal(Number(await scalar(dirtyPool, "SELECT count(*)::int AS n FROM payment_events")), events, "l'événement n'est pas journalisé");
  assert.equal(Number(await scalar(dirtyPool, "SELECT count(*)::int AS n FROM wallet_transactions")), transactions);
  assert.equal(String(await readWalletBalance(dirtyPool, owner)), "1000", "seule l'opération préexistante a crédité");
});

// ═════════════ 5. Concurrence des événements ═════════════

test("concurrence : le MÊME événement rejoué 10 fois en parallèle (10 pools, verrou de table tenu) → un seul crédit, 1 « applied » et 9 relectures", async () => {
  const owner = await makeUser();
  const intent = await newIntent(owner, 2500);
  const event = eventFor(intent);
  const pools = await distinctPools(10);
  const { results, waiting } = await contended("payment_intents", () => pools.map((db) => apply(event, db)), 10);
  assert.equal(waiting, 10, "les dix transactions attendaient en même temps");
  const values = results.map((result) => result.status === "fulfilled" ? result.value.outcome : `erreur: ${String(result.reason)}`);
  assert.equal(values.filter((value) => value === "applied").length, 1, JSON.stringify(values));
  assert.equal(values.filter((value) => value === "replayed").length, 9, JSON.stringify(values));
  assert.equal(await readWalletBalance(pool, owner), big(2500), "un seul crédit");
  assert.equal((await ledgerRows(intent.id)).length, 2);
  assert.equal((await eventsOf(intent.id)).length, 1);
});

test("concurrence : 6 événements DISTINCTS payment.succeeded pour la même intention en parallèle → un seul crédit, 1 « applied » et 5 « duplicate », aucune erreur", async () => {
  const owner = await makeUser();
  const intent = await newIntent(owner, 6000);
  const pools = await distinctPools(6);
  const { results, waiting } = await contended("payment_intents", () => pools.map((db) => apply(eventFor(intent), db)), 6);
  assert.equal(waiting, 6, "les six transactions attendaient en même temps");
  const values = results.map((result) => result.status === "fulfilled" ? result.value.outcome : `erreur: ${String(result.reason)}`);
  assert.equal(values.filter((value) => value === "applied").length, 1, JSON.stringify(values));
  assert.equal(values.filter((value) => value === "duplicate").length, 5, JSON.stringify(values));
  assert.equal(await readWalletBalance(pool, owner), big(6000), "un seul crédit");
  assert.equal((await ledgerRows(intent.id)).length, 2);
  assert.deepEqual((await eventsOf(intent.id)).map((row) => row.outcome).sort(), ["applied", "duplicate", "duplicate", "duplicate", "duplicate", "duplicate"]);
});

test("concurrence : succès et échec simultanés pour la même intention → un seul état final cohérent (jamais crédité ET échoué)", async () => {
  for (let round = 0; round < 4; round++) {
    const owner = await makeUser();
    const intent = await newIntent(owner, 1300);
    const pools = await distinctPools(4);
    const { results } = await contended("payment_intents", () => [
      apply(eventFor(intent, { type: "payment.succeeded" }), pools[0]), apply(eventFor(intent, { type: "payment.failed" }), pools[1]),
      apply(eventFor(intent, { type: "payment.succeeded" }), pools[2]), apply(eventFor(intent, { type: "payment.failed" }), pools[3]),
    ], 4);
    assert.ok(results.every((result) => result.status === "fulfilled"), JSON.stringify(results.map((result) => result.status)));
    const status = (await statusOf(intent.id)).status;
    const balance = await readWalletBalance(pool, owner);
    if (status === "succeeded") assert.equal(balance, big(1300), "réussie : créditée une fois");
    else { assert.equal(status, "failed"); assert.equal(balance, ZERO, "échouée : jamais créditée"); }
    assert.equal((await ledgerRows(intent.id)).length, status === "succeeded" ? 2 : 0);
  }
});

// ═════════════ 6. Expiration ═════════════

test("expirePaymentIntents : marque seulement les intentions en attente échues, les PLUS ANCIENNES D'ABORD (par échéance, pas par ordre d'insertion), dans la limite, jamais les autres", async () => {
  await drainDueIntents();
  const owner = await makeUser();
  // Insérées dans le désordre : l'ordre d'insertion n'est PAS l'ordre d'échéance (a : échue depuis 4 h, b : 3 h, c : 2 h, d : 1 h).
  const c = await expiredPendingIntent(owner, 1000, pool, 2 * 3600);
  const a = await expiredPendingIntent(owner, 1000, pool, 4 * 3600);
  const d = await expiredPendingIntent(owner, 1000, pool, 3600);
  const b = await expiredPendingIntent(owner, 1000, pool, 3 * 3600);
  const alive = await newIntent(owner);
  const paid = await paidIntent(owner, 700);
  const failedIntent = await newIntent(owner);
  await apply(eventFor(failedIntent, { type: "payment.failed" }));
  const expiredIds = async () => new Set((await pool.query("SELECT id FROM payment_intents WHERE owner_id = $1 AND status = 'expired'", [owner])).rows.map((row) => row.id as string));
  assert.deepEqual(await expirePaymentIntents({ pool, limit: 2 }), { expired: 2 }, "limite respectée");
  assert.deepEqual([...await expiredIds()].sort(), [a, b].sort(), "les deux échéances les plus anciennes d'abord");
  assert.deepEqual(await expirePaymentIntents({ pool, limit: 1 }), { expired: 1 });
  assert.deepEqual([...await expiredIds()].sort(), [a, b, c].sort(), "puis la suivante");
  assert.deepEqual(await expirePaymentIntents({ pool }), { expired: 1 });
  const states = (await pool.query("SELECT id, status FROM payment_intents WHERE owner_id = $1", [owner])).rows.reduce<Record<string, string>>((acc, row) => ({ ...acc, [row.id]: row.status }), {});
  for (const id of [a, b, c, d]) assert.equal(states[id], "expired");
  assert.equal(states[alive.id], "pending", "intention non échue intacte");
  assert.equal(states[paid.id], "succeeded", "intention réussie intacte");
  assert.equal(states[failedIntent.id], "failed", "intention échouée intacte");
  assert.deepEqual(await expirePaymentIntents({ pool }), { expired: 0 }, "rien d'autre à expirer");
  const completed = (await pool.query("SELECT count(*)::int AS n FROM payment_intents WHERE owner_id = $1 AND status = 'expired' AND completed_at IS NOT NULL", [owner])).rows[0].n;
  assert.equal(completed, 4);
});

test("expirePaymentIntents en parallèle : 4 balayages simultanés sur 60 intentions échues → chaque intention expirée une seule fois (SKIP LOCKED)", async () => {
  await drainDueIntents();
  const owner = await makeUser();
  await pool.query(
    `INSERT INTO payment_intents (id, owner_id, amount_xof, provider, status, idempotency_key, provider_reference, created_at, expires_at)
     SELECT gen_random_uuid(), $1, 1000, 'fake', 'pending', gen_random_uuid(), 'fakepay_' || md5(random()::text || i::text),
            clock_timestamp() - interval '3 hours', clock_timestamp() - interval '2 hours' - (i || ' seconds')::interval
       FROM generate_series(1, 60) AS i`, [owner]);
  const pools = await distinctPools(4);
  const { gate, open } = barrier();
  const sweeps = pools.map(async (db) => {
    await gate;
    let total = 0;
    for (;;) {
      const { expired } = await expirePaymentIntents({ pool: db, limit: 7 });
      if (expired === 0) return total;
      total += expired;
    }
  });
  open();
  const totals = await Promise.all(sweeps);
  assert.equal(totals.reduce((sum, value) => sum + value, 0), 60, `somme des balayages : ${JSON.stringify(totals)}`);
  assert.equal(Number(await scalar(pool, "SELECT count(*)::int AS n FROM payment_intents WHERE owner_id = $1 AND status = 'expired'", [owner])), 60);
});

test("expirePaymentIntents : une intention verrouillée (événement en cours de traitement) est ignorée puis expirée au balayage suivant ; limite invalide refusée avant SQL", async () => {
  await drainDueIntents();
  const owner = await makeUser();
  const lockedId = await expiredPendingIntent(owner);
  const freeId = await expiredPendingIntent(owner);
  const holder = await holderPool.connect();
  let sweep: Promise<{ expired: number }> | undefined;
  try {
    await holder.query("BEGIN");
    await holder.query("SELECT id FROM payment_intents WHERE id = $1 FOR UPDATE", [lockedId]);
    sweep = expirePaymentIntents({ pool });
    const outcome = await Promise.race([sweep, new Promise<"bloqué">((resolve) => setTimeout(() => resolve("bloqué"), 4_000))]);
    assert.notEqual(outcome, "bloqué", "le balayage ne doit pas attendre une ligne verrouillée (FOR UPDATE SKIP LOCKED)");
    assert.deepEqual(outcome, { expired: 1 }, "la ligne verrouillée est ignorée, pas attendue");
    assert.equal((await statusOf(lockedId)).status, "pending");
    assert.equal((await statusOf(freeId)).status, "expired");
    await holder.query("COMMIT");
  } finally {
    await holder.query("ROLLBACK").catch(() => {});
    holder.release();
    await sweep?.catch(() => {});
  }
  assert.deepEqual(await expirePaymentIntents({ pool }), { expired: 1 });
  assert.equal((await statusOf(lockedId)).status, "expired");
  const { spy, count: queries } = observedPool();
  for (const limit of [0, -1, 1001, 1.5, Number.NaN, "10" as unknown as number]) {
    await assert.rejects(expirePaymentIntents({ pool: spy, limit }), CatalogValidationError, `limite ${String(limit)}`);
  }
  assert.equal(queries(), 0, "aucune requête pour une limite invalide");
});

test("lock_timeout effectif : un verrou tenu par un autre client fait échouer VITE createTopupIntent et applyProviderEvent avec une erreur propre (55P03), sans rien écrire ; l'opération réussit une fois le verrou relâché", async () => {
  const deadline = WALLET_LOCK_TIMEOUT_MS + 3_000;
  const attempt = async <T>(operation: Promise<T>): Promise<{ failure: Failure | null; elapsed: number; value?: T }> => {
    const started = Date.now();
    const result = await Promise.race([
      operation.then((value) => ({ value }), (error: unknown) => ({ error })),
      new Promise<{ stalled: true }>((resolve) => setTimeout(() => resolve({ stalled: true }), deadline)),
    ]);
    assert.ok(!("stalled" in result), `l'opération attendait encore le verrou après ${deadline} ms : pas de lock_timeout`);
    return "error" in result ? { failure: result.error as Failure, elapsed: Date.now() - started } : { failure: null, elapsed: Date.now() - started, value: result.value };
  };

  // 1. createTopupIntent : verrou consultatif de l'utilisateur tenu ailleurs.
  const owner = await makeUser();
  const holder = await holderPool.connect();
  try {
    await holder.query("BEGIN");
    await holder.query("SELECT pg_advisory_xact_lock($1::int, hashtext($2::text))", [WALLET_TOPUP_LOCK_NAMESPACE, owner]);
    const create = await attempt(createTopupIntent({ pool, ownerId: owner, amountXof: big(1000), idempotencyKey: randomUUID() }));
    assert.equal(create.failure?.code, "55P03", "erreur propre : lock_not_available");
    assert.ok(create.elapsed >= WALLET_LOCK_TIMEOUT_MS - 500 && create.elapsed < deadline, `échec après ${create.elapsed} ms (lock_timeout ${WALLET_LOCK_TIMEOUT_MS} ms)`);
    assert.equal(Number(await scalar(pool, "SELECT count(*)::int AS n FROM payment_intents WHERE owner_id = $1", [owner])), 0, "rien n'a été écrit");
    await holder.query("COMMIT");
  } finally {
    await holder.query("ROLLBACK").catch(() => {});
    holder.release();
  }
  assert.equal((await createTopupIntent({ pool, ownerId: owner, amountXof: big(1000), idempotencyKey: randomUUID() })).reused, false, "le verrou relâché, la création réussit");

  // 2. applyProviderEvent : ligne de l'intention verrouillée ailleurs (FOR UPDATE).
  const payer = await makeUser();
  const intent = await newIntent(payer, 2000);
  const event = eventFor(intent);
  const rowHolder = await holderPool.connect();
  try {
    await rowHolder.query("BEGIN");
    await rowHolder.query("SELECT id FROM payment_intents WHERE id = $1 FOR UPDATE", [intent.id]);
    const applied = await attempt(apply(event));
    assert.equal(applied.failure?.code, "55P03", "erreur propre : lock_not_available");
    assert.ok(applied.elapsed >= WALLET_LOCK_TIMEOUT_MS - 500 && applied.elapsed < deadline, `échec après ${applied.elapsed} ms`);
    await rowHolder.query("COMMIT");
  } finally {
    await rowHolder.query("ROLLBACK").catch(() => {});
    rowHolder.release();
  }
  assert.equal((await statusOf(intent.id)).status, "pending", "l'intention n'a pas bougé");
  assert.equal((await eventsOf(intent.id)).length, 0, "l'événement n'est pas journalisé");
  assert.equal(await readWalletBalance(pool, payer), ZERO);
  assert.deepEqual(await apply(event), { outcome: "applied", intentId: intent.id }, "rejoué une fois le verrou relâché : appliqué une seule fois");
  assert.equal(await readWalletBalance(pool, payer), big(2000));
});

// ═════════════ 7. wallet:check (réconciliation) ═════════════

/** Injecte une corruption dans une transaction ANNULÉE (déclencheurs désactivés le temps de l'injection) puis lance le contrôle. */
async function checkAfter(inject: (client: PoolClient) => Promise<void>) {
  const client = await txPool.connect();
  try {
    await client.query("BEGIN");
    await inject(client);
    return await runWalletCheck(client);
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    client.release();
  }
}
const codesOf = (report: { violations: Array<{ code: WalletCheckCode }> }): WalletCheckCode[] => report.violations.map((violation) => violation.code).sort();

/** Recharge écrite à la main : transaction « topup » et ses écritures (montants libres pour fabriquer des écarts). */
async function insertTopupSql(client: PoolClient, intentId: string, entries: Array<[string, string]>): Promise<string> {
  const transactionId = await insertTransaction(client, {
    kind: "'topup'", reference: `'topup:${intentId}'`, metadata: `'{"paymentIntentId":"${intentId}","provider":"fake"}'::jsonb`,
  });
  for (const [accountId, amount] of entries) await insertEntry(client, transactionId, accountId, amount);
  return transactionId;
}

/**
 * Intention réussie « à la main » (pending puis succeeded : transition permise), sans passer par le grand livre, AVEC son
 * événement payment.succeeded « applied » de même montant (sauf `withEvent: false`).
 */
async function succeededIntentSql(client: PoolClient, owner: string, amount = 1000, withEvent = true): Promise<string> {
  const id = await insertIntent(client, owner, { amount_xof: String(amount) });
  await client.query("UPDATE payment_intents SET status = 'succeeded', completed_at = clock_timestamp() WHERE id = $1", [id]);
  if (withEvent) await insertEvent(client, id, { amount_xof: String(amount), outcome: "'applied'" });
  return id;
}

/** Intention échouée « à la main », avec son événement payment.failed « applied » (sauf `withEvent: false`). */
async function failedIntentSql(client: PoolClient, owner: string, amount = 1000, withEvent = true): Promise<string> {
  const id = await insertIntent(client, owner, { amount_xof: String(amount) });
  await client.query("UPDATE payment_intents SET status = 'failed', completed_at = clock_timestamp() WHERE id = $1", [id]);
  if (withEvent) await insertEvent(client, id, { type: "'payment.failed'", amount_xof: String(amount), outcome: "'applied'" });
  return id;
}

/** Recharge COMPLÈTE et cohérente : intention réussie, son événement et la transaction « topup » (deux écritures). */
async function settledTopupSql(client: PoolClient, owner: string, ownerAccount: string, clearing: string, amount = 1000): Promise<string> {
  const intent = await succeededIntentSql(client, owner, amount);
  await insertTopupSql(client, intent, [[clearing, `-${amount}`], [ownerAccount, String(amount)]]);
  return intent;
}

test("wallet:check vert sur la base saine (toutes les opérations des tests précédents) et sur une base vide", async () => {
  const report = await checkWalletIntegrity(pool);
  assert.deepEqual(report.violations, []);
  assert.equal(report.ok, true);
  assert.ok(report.totals.accounts >= 10 && report.totals.transactions >= 20 && report.totals.entries >= 40 && report.totals.paymentIntents >= 10 && report.totals.paymentEvents >= 10, JSON.stringify(report.totals));
  // Les tests précédents ont fait refuser des payment.succeeded (montant falsifié, état, intention inconnue) : ce sont des AVERTISSEMENTS, jamais des écarts.
  // Depuis le lot P1b, les ajustements qui créditent un compte utilisateur (crédits de départ des tests) sont aussi signalés.
  assert.deepEqual(report.warnings.map((warning) => warning.code).sort(), ["adjustment_credits_user_account", "succeeded_event_rejected_amount", "succeeded_event_rejected_state", "succeeded_event_rejected_unknown_intent"]);
  assert.ok(report.warnings.every((warning) => warning.count >= 1 && warning.examples.length >= 1 && warning.examples.length <= 20));
  const [empty] = [createTemporarySchemaName()];
  await admin.query(`CREATE SCHEMA ${quoteTemporarySchema(empty)}`);
  const emptyPool = await openVerifiedIsolatedPool(target, empty);
  try {
    await runMigrations(emptyPool);
    assert.deepEqual(await checkWalletIntegrity(emptyPool), { ok: true, totals: { accounts: 6, transactions: 0, entries: 0, paymentIntents: 0, paymentEvents: 0 }, violations: [], warnings: [] });
  } finally {
    await emptyPool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${quoteTemporarySchema(empty)} CASCADE`);
  }
});

test("wallet:check ROUGE : transaction déséquilibrée, transaction sans écriture (déclencheurs d'équilibre désactivés le temps de l'injection)", async () => {
  const user = await makeUser();
  const account = await ensureUserWalletAccount(pool, user);
  const unbalanced = await checkAfter(async (client) => {
    await client.query("ALTER TABLE wallet_entries DISABLE TRIGGER trg_wallet_entries_balanced");
    await client.query("ALTER TABLE wallet_transactions DISABLE TRIGGER trg_wallet_transactions_balanced");
    await insertEntry(client, await insertTransaction(client), account, "100");
  });
  assert.equal(unbalanced.ok, false);
  assert.deepEqual(codesOf(unbalanced), ["ledger_total_nonzero", "transaction_unbalanced"]);
  const violation = unbalanced.violations.find((entry) => entry.code === "transaction_unbalanced")!;
  assert.equal(violation.count, 1);
  assert.deepEqual(Object.keys(violation.examples[0]).sort(), ["entries", "total", "transaction_id"]);
  assert.equal(violation.examples[0].entries, "1");
  assert.equal(violation.examples[0].total, "100");

  const empty = await checkAfter(async (client) => {
    await client.query("ALTER TABLE wallet_transactions DISABLE TRIGGER trg_wallet_transactions_balanced");
    await insertTransaction(client);
  });
  assert.deepEqual(codesOf(empty), ["transaction_unbalanced"]);

  const twoThatSumToSeven = await checkAfter(async (client) => {
    await client.query("ALTER TABLE wallet_entries DISABLE TRIGGER trg_wallet_entries_balanced");
    await client.query("ALTER TABLE wallet_transactions DISABLE TRIGGER trg_wallet_transactions_balanced");
    const transactionId = await insertTransaction(client);
    await insertEntry(client, transactionId, account, "10");
    await insertEntry(client, transactionId, await systemAccount("boost_revenue"), "-3");
  });
  assert.deepEqual(codesOf(twoThatSumToSeven), ["ledger_total_nonzero", "transaction_unbalanced"]);
  assert.equal(twoThatSumToSeven.violations.find((entry) => entry.code === "transaction_unbalanced")!.examples[0].total, "7");
});

test("wallet:check ROUGE : solde différent de la somme des écritures, solde utilisateur négatif, compte système manquant", async () => {
  const user = await makeUser();
  const account = await ensureUserWalletAccount(pool, user);
  await adjustment(user, 300);
  const drift = await checkAfter(async (client) => {
    await client.query("ALTER TABLE wallet_accounts DISABLE TRIGGER trg_wallet_accounts_guard");
    await client.query("UPDATE wallet_accounts SET balance = balance + 7 WHERE id = $1", [account]);
  });
  assert.deepEqual(codesOf(drift), ["balance_mismatch", "ledger_total_nonzero"]);
  assert.deepEqual(drift.violations.find((entry) => entry.code === "balance_mismatch")!.examples, [{ account_id: account, kind: "user", balance: "307", expected: "300" }]);
  assert.equal(drift.violations.find((entry) => entry.code === "ledger_total_nonzero")!.examples[0].total, "7");

  const negative = await checkAfter(async (client) => {
    await client.query("ALTER TABLE wallet_accounts DISABLE TRIGGER trg_wallet_accounts_guard");
    await client.query("ALTER TABLE wallet_accounts DROP CONSTRAINT chk_wallet_accounts_user_balance_non_negative");
    await client.query("UPDATE wallet_accounts SET balance = -5 WHERE id = $1", [account]);
  });
  assert.deepEqual(codesOf(negative), ["balance_mismatch", "ledger_total_nonzero", "negative_user_balance"]);
  assert.deepEqual(negative.violations.find((entry) => entry.code === "negative_user_balance")!.examples, [{ account_id: account, balance: "-5" }]);

  const missing = await checkAfter(async (client) => {
    // Suppression d'un compte système et de ses écritures : possible seulement hors déclencheurs (rôle de réplication).
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query("DELETE FROM wallet_entries WHERE account_id = (SELECT id FROM wallet_accounts WHERE kind = 'boost_revenue')");
    await client.query("DELETE FROM wallet_accounts WHERE kind = 'boost_revenue'");
  });
  assert.ok(codesOf(missing).includes("system_account_invalid"), JSON.stringify(codesOf(missing)));
  assert.deepEqual(missing.violations.find((entry) => entry.code === "system_account_invalid")!.examples, [{ kind: "boost_revenue", found: "0" }]);

  // Compte système DUPLIQUÉ : index unique supprimé le temps de l'injection (annulé ensuite) puis second compte provider_clearing.
  const duplicated = await checkAfter(async (client) => {
    await client.query("DROP INDEX uq_wallet_accounts_system_kind");
    await client.query("INSERT INTO wallet_accounts (id, kind, owner_id) VALUES (gen_random_uuid(), 'provider_clearing', NULL)");
  });
  assert.deepEqual(codesOf(duplicated), ["system_account_invalid"]);
  assert.deepEqual(duplicated.violations[0].examples, [{ kind: "provider_clearing", found: "2" }]);
});

test("wallet:check ROUGE : intention réussie sans recharge, recharge sans intention réussie, recharge de montant, de compte ou de nombre d'écritures différents, paiement appliqué deux fois", async () => {
  const owner = await makeUser();
  const stranger = await makeUser();
  const ownerAccount = await ensureUserWalletAccount(pool, owner);
  const strangerAccount = await ensureUserWalletAccount(pool, stranger);
  const clearing = await systemAccount("provider_clearing");
  const revenue = await systemAccount("boost_revenue");

  const noTopup = await checkAfter(async (client) => { await succeededIntentSql(client, owner, 1000); });
  assert.deepEqual(codesOf(noTopup), ["provider_clearing_mismatch", "succeeded_intent_without_topup"]);
  assert.deepEqual(Object.keys(noTopup.violations.find((entry) => entry.code === "succeeded_intent_without_topup")!.examples[0]).sort(), ["amount", "intent_id"]);
  const mismatch = noTopup.violations.find((entry) => entry.code === "provider_clearing_mismatch")!;
  assert.deepEqual(Object.keys(mismatch.examples[0]).sort(), ["balance", "expected", "other_entries_total", "succeeded_intents_total"]);
  assert.equal(BigInt(mismatch.examples[0].expected) - BigInt(mismatch.examples[0].balance), -big(1000), "il manquait 1000 XOF de contrepartie");

  const pendingWithTopup = await checkAfter(async (client) => {
    const intent = await insertIntent(client, owner);
    await insertTopupSql(client, intent, [[clearing, "-1000"], [ownerAccount, "1000"]]);
  });
  assert.deepEqual(codesOf(pendingWithTopup), ["provider_clearing_mismatch", "topup_without_succeeded_intent"]);
  const unknownIntent = await checkAfter(async (client) => { await insertTopupSql(client, randomUUID(), [[clearing, "-1000"], [ownerAccount, "1000"]]); });
  assert.deepEqual(codesOf(unknownIntent), ["provider_clearing_mismatch", "topup_without_succeeded_intent"]);
  const failedWithTopup = await checkAfter(async (client) => {
    const intent = await failedIntentSql(client, owner, 1000);
    await insertTopupSql(client, intent, [[clearing, "-1000"], [ownerAccount, "1000"]]);
  });
  assert.deepEqual(codesOf(failedWithTopup), ["provider_clearing_mismatch", "topup_without_succeeded_intent"], "une recharge pour une intention échouée");

  const cases: Array<[string, Array<[string, string]>]> = [
    ["montant crédité inférieur", [[clearing, "-900"], [ownerAccount, "900"]]],
    ["montant crédité supérieur", [[clearing, "-1100"], [ownerAccount, "1100"]]],
    ["crédit d'un autre utilisateur", [[clearing, "-1000"], [strangerAccount, "1000"]]],
    ["contrepartie sur boost_revenue au lieu de provider_clearing", [[revenue, "-1000"], [ownerAccount, "1000"]]],
    ["trois écritures", [[clearing, "-900"], [revenue, "-100"], [ownerAccount, "1000"]]],
    ["signe inversé", [[clearing, "1000"], [ownerAccount, "-1000"]]],
  ];
  for (const [label, entries] of cases) {
    const report = await checkAfter(async (client) => {
      // Un solde négatif par injection ne peut pas passer : on crédite d'abord le compte du propriétaire pour les cas à signe inversé.
      await client.query("ALTER TABLE wallet_accounts DISABLE TRIGGER trg_wallet_accounts_guard");
      await client.query("UPDATE wallet_accounts SET balance = balance + 5000 WHERE id = ANY($1::uuid[])", [[ownerAccount, strangerAccount]]);
      const intent = await succeededIntentSql(client, owner, 1000);
      await insertTopupSql(client, intent, entries);
    });
    assert.ok(codesOf(report).includes("topup_mismatch"), `${label} : ${JSON.stringify(codesOf(report))}`);
    assert.deepEqual(Object.keys(report.violations.find((entry) => entry.code === "topup_mismatch")!.examples[0]).sort(), ["amount", "intent_id", "transaction_id"]);
  }

  // Plus de deux écritures alors que les montants CONCORDENT (utilisateur +1000, provider_clearing -1000) : refusé par le nombre d'écritures seul.
  const concordantButTooMany = await checkAfter(async (client) => {
    // Le tiers reçoit d'abord, légitimement (écritures équilibrées de la même transaction SQL), de quoi couvrir le -7 : aucune dérive de solde.
    const credit = await insertTransaction(client);
    await insertEntry(client, credit, revenue, "-7");
    await insertEntry(client, credit, strangerAccount, "7");
    const intent = await succeededIntentSql(client, owner, 1000);
    await insertTopupSql(client, intent, [[clearing, "-1000"], [ownerAccount, "1000"], [revenue, "7"], [strangerAccount, "-7"]]);
  });
  assert.ok(codesOf(concordantButTooMany).includes("topup_mismatch"), JSON.stringify(codesOf(concordantButTooMany)));
  assert.ok(!codesOf(concordantButTooMany).includes("provider_clearing_mismatch"), "les montants de provider_clearing concordent : seul le nombre d'écritures est en cause");
  // Depuis le lot P1b, l'écriture boost_revenue d'une recharge n'est pas une écriture d'ajustement : le solde de boost_revenue la signale aussi.
  assert.deepEqual(codesOf(concordantButTooMany), ["boost_revenue_mismatch", "topup_mismatch"]);

  // Contrôles positifs : une recharge COMPLÈTE (intention, événement « applied », deux écritures) et des ajustements qui touchent provider_clearing ne lèvent rien.
  const proper = await checkAfter(async (client) => { await settledTopupSql(client, owner, ownerAccount, clearing, 1000); });
  assert.deepEqual(proper.violations, [], "contrôle positif : une recharge complète et conforme ne lève aucun écart");
  const withAdjustment = await checkAfter(async (client) => {
    await settledTopupSql(client, owner, ownerAccount, clearing, 1000);
    const transactionId = await insertTransaction(client);
    await insertEntry(client, transactionId, clearing, "-75");
    await insertEntry(client, transactionId, ownerAccount, "75");
  });
  assert.deepEqual(withAdjustment.violations, [], "un ajustement qui touche provider_clearing est compté dans la formule du solde attendu");

  const twiceApplied = await checkAfter(async (client) => {
    const intent = await settledTopupSql(client, owner, ownerAccount, clearing, 1000);
    await insertEvent(client, intent, { outcome: "'applied'" });
    await insertEvent(client, intent, { outcome: "'applied'" });
  });
  assert.deepEqual(codesOf(twiceApplied), ["duplicate_applied_event"]);
  assert.equal(twiceApplied.violations[0].count, 1);
  assert.deepEqual(Object.keys(twiceApplied.violations[0].examples[0]).sort(), ["applied_events", "intent_id", "type"]);
  assert.equal(twiceApplied.violations[0].examples[0].applied_events, "3");
});

test("wallet:check ROUGE : lien intention ↔ événement du prestataire (événement absent, effacé, réécrit, d'un autre état ou d'un autre montant)", async () => {
  const owner = await makeUser();
  const ownerAccount = await ensureUserWalletAccount(pool, owner);
  const clearing = await systemAccount("provider_clearing");

  // Le cas qui était déclaré conforme à tort : intention réussie et recharge à deux écritures, SANS AUCUN événement du prestataire.
  const noEvent = await checkAfter(async (client) => {
    const intent = await succeededIntentSql(client, owner, 1000, false);
    await insertTopupSql(client, intent, [[clearing, "-1000"], [ownerAccount, "1000"]]);
  });
  assert.equal(noEvent.ok, false);
  assert.deepEqual(codesOf(noEvent), ["succeeded_intent_without_applied_event"]);
  assert.equal(noEvent.violations[0].count, 1);
  assert.deepEqual(Object.keys(noEvent.violations[0].examples[0]).sort(), ["amount", "intent_id"]);

  // TRUNCATE payment_events : tout ce qui était réussi ou échoué perd son événement.
  const truncated = await checkAfter(async (client) => {
    await settledTopupSql(client, owner, ownerAccount, clearing, 1000);
    await client.query("TRUNCATE payment_events");
  });
  const succeededCount = Number(await scalar(pool, "SELECT count(*)::int AS n FROM payment_intents WHERE status = 'succeeded'")) + 1;
  const failedCount = Number(await scalar(pool, "SELECT count(*)::int AS n FROM payment_intents WHERE status = 'failed'"));
  assert.ok(failedCount >= 1 && succeededCount >= 2);
  assert.deepEqual(codesOf(truncated), ["failed_intent_without_applied_event", "succeeded_intent_without_applied_event"]);
  assert.equal(truncated.violations.find((entry) => entry.code === "succeeded_intent_without_applied_event")!.count, succeededCount);
  assert.equal(truncated.violations.find((entry) => entry.code === "failed_intent_without_applied_event")!.count, failedCount);

  // Issue d'un événement réécrite (« applied » → « duplicate »), journal rendu modifiable le temps de l'injection.
  const rewritten = await checkAfter(async (client) => {
    const intent = await settledTopupSql(client, owner, ownerAccount, clearing, 1000);
    await client.query("ALTER TABLE payment_events DISABLE TRIGGER trg_payment_events_immutable");
    await client.query("UPDATE payment_events SET outcome = 'duplicate' WHERE intent_id = $1", [intent]);
  });
  assert.deepEqual(codesOf(rewritten), ["succeeded_intent_without_applied_event"]);
  assert.equal(rewritten.violations[0].count, 1);

  // Type d'un événement réécrit (payment.succeeded → payment.failed) : l'intention réussie perd son événement et l'événement pointe une intention réussie.
  const retyped = await checkAfter(async (client) => {
    const intent = await settledTopupSql(client, owner, ownerAccount, clearing, 1000);
    await client.query("ALTER TABLE payment_events DISABLE TRIGGER trg_payment_events_immutable");
    await client.query("UPDATE payment_events SET type = 'payment.failed' WHERE intent_id = $1", [intent]);
  });
  assert.deepEqual(codesOf(retyped), ["applied_event_state_mismatch", "succeeded_intent_without_applied_event"]);

  // Intention ÉCHOUÉE portant un payment.succeeded « applied » (et sans payment.failed appliqué).
  const failedWithSuccess = await checkAfter(async (client) => {
    const intent = await failedIntentSql(client, owner, 1000, false);
    await insertEvent(client, intent, { type: "'payment.succeeded'", outcome: "'applied'" });
  });
  assert.deepEqual(codesOf(failedWithSuccess), ["applied_event_state_mismatch", "failed_intent_without_applied_event"]);
  assert.deepEqual(Object.keys(failedWithSuccess.violations.find((entry) => entry.code === "applied_event_state_mismatch")!.examples[0]).sort(), ["amount", "event_id", "intent_id", "intent_status", "type"]);
  assert.equal(failedWithSuccess.violations.find((entry) => entry.code === "applied_event_state_mismatch")!.examples[0].intent_status, "failed");

  // Intention échouée : contrôle positif (avec son payment.failed appliqué) puis sans événement.
  assert.deepEqual((await checkAfter(async (client) => { await failedIntentSql(client, owner, 1000); })).violations, []);
  assert.deepEqual(codesOf(await checkAfter(async (client) => { await failedIntentSql(client, owner, 1000, false); })), ["failed_intent_without_applied_event"]);

  // Événements « applied » qui ne correspondent pas à l'état de leur intention.
  const failedOnSucceeded = await checkAfter(async (client) => {
    const intent = await settledTopupSql(client, owner, ownerAccount, clearing, 1000);
    await insertEvent(client, intent, { type: "'payment.failed'", outcome: "'applied'" });
  });
  assert.deepEqual(codesOf(failedOnSucceeded), ["applied_event_state_mismatch"]);
  const succeededOnPending = await checkAfter(async (client) => { await insertEvent(client, await insertIntent(client, owner), { outcome: "'applied'" }); });
  assert.deepEqual(codesOf(succeededOnPending), ["applied_event_state_mismatch"]);
  const failedOnPending = await checkAfter(async (client) => { await insertEvent(client, await insertIntent(client, owner), { type: "'payment.failed'", outcome: "'applied'" }); });
  assert.deepEqual(codesOf(failedOnPending), ["applied_event_state_mismatch"]);
  const succeededOnExpired = await checkAfter(async (client) => {
    const intent = await insertIntent(client, owner);
    await client.query("UPDATE payment_intents SET status = 'expired', completed_at = clock_timestamp() WHERE id = $1", [intent]);
    await insertEvent(client, intent, { outcome: "'applied'" });
  });
  assert.deepEqual(codesOf(succeededOnExpired), ["applied_event_state_mismatch"]);
  const otherAmount = await checkAfter(async (client) => {
    const intent = await succeededIntentSql(client, owner, 1000, false);
    await insertTopupSql(client, intent, [[clearing, "-1000"], [ownerAccount, "1000"]]);
    await insertEvent(client, intent, { amount_xof: "1100", outcome: "'applied'" });
  });
  assert.deepEqual(codesOf(otherAmount), ["applied_event_state_mismatch", "succeeded_intent_without_applied_event"], "un événement « applied » d'un autre montant ne vaut pas événement de l'intention");
  // Les événements refusés (autre issue que « applied ») ne sont pas des écarts : ce sont, au plus, des avertissements.
  const refusedOnly = await checkAfter(async (client) => {
    const intent = await settledTopupSql(client, owner, ownerAccount, clearing, 1000);
    await insertEvent(client, intent, { outcome: "'duplicate'" });
    await insertEvent(client, intent, { amount_xof: "5000", outcome: "'rejected_amount'" });
    await insertEvent(client, intent, { type: "'payment.failed'", outcome: "'rejected_state'" });
  });
  assert.deepEqual(refusedOnly.violations, []);
});

test("wallet:check : au plus 20 exemples par écart avec le total exact, et AUCUNE donnée personnelle dans le rapport", async () => {
  const owner = await makeUser();
  const ownerAccount = await ensureUserWalletAccount(pool, owner);
  const clearing = await systemAccount("provider_clearing");
  const report = await checkAfter(async (client) => {
    await client.query("ALTER TABLE wallet_transactions DISABLE TRIGGER trg_wallet_transactions_balanced");
    for (let index = 0; index < 25; index++) await insertTransaction(client);
    const intent = await succeededIntentSql(client, owner, 1000);
    await insertTopupSql(client, intent, [[clearing, "-900"], [ownerAccount, "900"]]);
  });
  const unbalanced = report.violations.find((entry) => entry.code === "transaction_unbalanced")!;
  assert.equal(unbalanced.count, 25);
  assert.equal(unbalanced.examples.length, 20);
  const text = JSON.stringify(report);
  assert.ok(!text.includes(owner), "l'identifiant de l'utilisateur ne figure pas dans le rapport");
  assert.ok(!/owner|phone|téléphone|\+225/i.test(text), "aucun champ de propriétaire ou de téléphone");
  const allowed = [
    "transaction_id", "entries", "total", "account_id", "kind", "balance", "expected", "intent_id", "amount", "found", "applied_events", "type",
    "event_id", "intent_status", "succeeded_intents_total", "other_entries_total",
  ];
  for (const violation of report.violations) {
    for (const example of violation.examples) {
      for (const key of Object.keys(example)) assert.ok(allowed.includes(key), `clé ${key}`);
    }
  }
});

test("wallet:check AVERTISSEMENTS : payment.succeeded refusés (montant, état, intention inconnue) listés à part, sans changer `ok` ni le code de sortie hors --strict ; --strict sort en 1", async () => {
  const scratch = createTemporarySchemaName();
  await admin.query(`CREATE SCHEMA ${quoteTemporarySchema(scratch)}`);
  const scratchPool = await openVerifiedIsolatedPool(target, scratch);
  try {
    await runMigrations(scratchPool);
    const owner = await makeUser(scratchPool);
    const clean = await checkWalletIntegrity(scratchPool);
    assert.deepEqual(clean.warnings, []);
    assert.equal((await runScript("scripts/wallet-check.ts", ["--strict"], scratch)).code, 0, "sans avertissement, --strict sort en 0");

    // Un paiement légitime, puis des refus : montant falsifié, succès sur une intention échouée, intention inconnue, et un échec refusé (hors compte).
    const paid = await paidIntent(owner, 1000, scratchPool);
    const forged = await newIntent(owner, 2000, scratchPool);
    assert.equal((await apply(eventFor(forged, { amountXof: big(2100) }), scratchPool)).outcome, "rejected_amount");
    const failedFirst = await newIntent(owner, 3000, scratchPool);
    assert.equal((await apply(eventFor(failedFirst, { type: "payment.failed" }), scratchPool)).outcome, "applied");
    assert.equal((await apply(eventFor(failedFirst), scratchPool)).outcome, "rejected_state");
    const unknown = eventFor({ providerReference: "fakepay_inconnue000009", amountXof: big(4000) });
    assert.equal((await apply(unknown, scratchPool)).outcome, "rejected_unknown_intent");
    assert.equal((await apply(eventFor(paid, { type: "payment.failed" }), scratchPool)).outcome, "rejected_state", "un échec refusé n'est pas un avertissement d'argent");
    assert.equal((await apply(eventFor(forged, { type: "payment.failed", amountXof: big(2999) }), scratchPool)).outcome, "rejected_amount", "idem pour un échec au mauvais montant");

    const report = await checkWalletIntegrity(scratchPool);
    assert.equal(report.ok, true, "les avertissements ne sont pas des écarts");
    assert.deepEqual(report.violations, []);
    assert.deepEqual(report.warnings.map((warning) => [warning.code, warning.count]), [
      ["succeeded_event_rejected_amount", 1], ["succeeded_event_rejected_state", 1], ["succeeded_event_rejected_unknown_intent", 1],
    ]);
    for (const warning of report.warnings) assert.deepEqual(Object.keys(warning.examples[0]).sort(), ["amount", "event_id", "intent_id"]);
    assert.equal(report.warnings[2].examples[0].intent_id, "", "intention inconnue : identifiant vide");
    assert.equal(report.warnings[2].examples[0].amount, "4000");
    assert.equal(report.warnings[0].examples[0].intent_id, forged.id);

    const normal = await runScript("scripts/wallet-check.ts", [], scratch);
    assert.equal(normal.code, 0, normal.output);
    assert.match(normal.output, /Portefeuille : aucun écart\./);
    assert.match(normal.output, /AVERTISSEMENTS \(payment\.succeeded refusés/);
    for (const code of ["succeeded_event_rejected_amount", "succeeded_event_rejected_state", "succeeded_event_rejected_unknown_intent"]) {
      assert.match(normal.output, new RegExp(`AVERTISSEMENT ${code} : 1 événement\\(s\\)`));
    }
    assert.ok(normal.output.includes(forged.id) && normal.output.includes(unknown.eventId), "identifiants techniques de l'événement et de l'intention");
    assert.ok(!normal.output.includes(owner) && !normal.output.includes(forged.providerReference), "ni propriétaire ni référence du prestataire");
    const strict = await runScript("scripts/wallet-check.ts", ["--strict"], scratch);
    assert.equal(strict.code, 1, strict.output);
    assert.match(strict.output, /mode strict, 3 type\(s\) d'avertissement : code de sortie 1/);
    assert.equal((await runScript("scripts/wallet-check.ts", ["--strict", "--strict"], scratch)).code, 2);
    assert.equal((await runScript("scripts/wallet-check.ts", ["--lax"], scratch)).code, 2);
    // Un événement refusé de plus : le compteur suit le journal (immuable).
    assert.equal((await apply(eventFor(forged, { amountXof: big(2200) }), scratchPool)).outcome, "rejected_amount");
    assert.equal((await checkWalletIntegrity(scratchPool)).warnings[0].count, 2);
  } finally {
    await scratchPool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${quoteTemporarySchema(scratch)} CASCADE`);
  }
});

test("wallet:check est en lecture seule : un instantané REPEATABLE READ READ ONLY et seulement des SELECT", async () => {
  const statements: string[] = [];
  const spy = Object.create(pool) as Pool;
  spy.connect = (async () => {
    const client = await pool.connect();
    const proxy = Object.create(client) as PoolClient;
    proxy.query = ((text: unknown, ...rest: unknown[]) => {
      statements.push(String(typeof text === "string" ? text : (text as { text: string }).text));
      return (client.query as (...args: unknown[]) => unknown)(text, ...rest);
    }) as never;
    proxy.release = ((...args: unknown[]) => (client.release as (...a: unknown[]) => void)(...args)) as never;
    return proxy;
  }) as never;
  assert.equal((await checkWalletIntegrity(spy)).ok, true);
  assert.ok(statements.length >= 11, `${statements.length} requêtes`);
  assert.equal(statements[0], "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
  assert.equal(statements.at(-1), "COMMIT");
  for (const statement of statements.slice(1, -1)) assert.match(statement.trimStart(), /^SELECT /, statement.slice(0, 80));
  assert.ok(!statements.some((statement) => /\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE)\b/i.test(statement.replaceAll("FOR UPDATE", ""))), "aucune écriture");
});

test("compte système manquant : détecté par le contrôle, recréé à la demande par le grand livre", async () => {
  const scratch = createTemporarySchemaName();
  await admin.query(`CREATE SCHEMA ${quoteTemporarySchema(scratch)}`);
  const scratchPool = await openVerifiedIsolatedPool(target, scratch);
  try {
    await runMigrations(scratchPool);
    const owner = await makeUser(scratchPool);
    await scratchPool.query("ALTER TABLE wallet_accounts DISABLE TRIGGER trg_wallet_accounts_guard");
    await scratchPool.query("DELETE FROM wallet_accounts WHERE kind = 'boost_revenue'");
    await scratchPool.query("ALTER TABLE wallet_accounts ENABLE TRIGGER trg_wallet_accounts_guard");
    assert.deepEqual((await checkWalletIntegrity(scratchPool)).violations.map((violation) => violation.code), ["system_account_invalid"]);
    await recordWalletTransaction(scratchPool, {
      kind: "adjustment", reference: `adjustment:recreate-${randomUUID()}`,
      entries: [{ account: { kind: "boost_revenue" }, amount: -big(40) }, { account: { kind: "user", ownerId: owner }, amount: big(40) }],
    });
    assert.deepEqual((await checkWalletIntegrity(scratchPool)).violations, [], "boost_revenue recréé, grand livre cohérent");
    assert.equal(Number(await scalar(scratchPool, "SELECT count(*)::int AS n FROM wallet_accounts WHERE kind = 'boost_revenue'")), 1);
  } finally {
    await scratchPool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${quoteTemporarySchema(scratch)} CASCADE`);
  }
});

// ═════════════ 8. Scripts npm ═════════════

test("script wallet:check : code 0 sur base saine, code 1 avec rapport sans donnée personnelle sur base corrompue (corruption validée, déclencheur désactivé), de nouveau 0 une fois réparée ; code 2 si usage invalide", async () => {
  const scratch = createTemporarySchemaName();
  await admin.query(`CREATE SCHEMA ${quoteTemporarySchema(scratch)}`);
  const scratchPool = await openVerifiedIsolatedPool(target, scratch);
  try {
    await runMigrations(scratchPool);
    const owner = await makeUser(scratchPool);
    const intent = await paidIntent(owner, 2000, scratchPool);
    const healthy = await runScript("scripts/wallet-check.ts", [], scratch);
    assert.equal(healthy.code, 0, healthy.output);
    assert.match(healthy.output, /Portefeuille : 7 compte\(s\), 1 transaction\(s\), 2 écriture\(s\), 1 intention\(s\) de paiement, 1 événement\(s\) du prestataire\./);
    assert.match(healthy.output, /aucun écart/);

    const revenue = await systemAccount("boost_revenue", scratchPool);
    await scratchPool.query("ALTER TABLE wallet_accounts DISABLE TRIGGER trg_wallet_accounts_guard");
    await scratchPool.query("UPDATE wallet_accounts SET balance = balance + 13 WHERE id = $1", [revenue]);
    await scratchPool.query("ALTER TABLE wallet_accounts ENABLE TRIGGER trg_wallet_accounts_guard");
    const corrupted = await runScript("scripts/wallet-check.ts", [], scratch);
    assert.equal(corrupted.code, 1, corrupted.output);
    assert.match(corrupted.output, /ÉCART balance_mismatch : 1 cas/);
    assert.match(corrupted.output, /ÉCART ledger_total_nonzero : 1 cas/);
    assert.ok(corrupted.output.includes(revenue), "identifiant technique du compte");
    assert.ok(!corrupted.output.includes(owner) && !corrupted.output.includes(intent.providerReference), "ni propriétaire ni référence du prestataire");

    await scratchPool.query("ALTER TABLE wallet_accounts DISABLE TRIGGER trg_wallet_accounts_guard");
    await scratchPool.query("UPDATE wallet_accounts SET balance = balance - 13 WHERE id = $1", [revenue]);
    await scratchPool.query("ALTER TABLE wallet_accounts ENABLE TRIGGER trg_wallet_accounts_guard");
    assert.equal((await runScript("scripts/wallet-check.ts", [], scratch)).code, 0, "réparée");
    const usage = await runScript("scripts/wallet-check.ts", ["--rapide"], scratch);
    assert.equal(usage.code, 2);
    assert.match(usage.output, /Usage : npm run wallet:check/);
  } finally {
    await scratchPool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${quoteTemporarySchema(scratch)} CASCADE`);
  }
});

test("script wallet:expire-intents : expire les intentions échues dans la limite demandée, usage invalide refusé (code 1), aucune intention vivante touchée", async () => {
  await drainDueIntents();
  const owner = await makeUser();
  for (let index = 0; index < 3; index++) await expiredPendingIntent(owner);
  const alive = await newIntent(owner);
  const limited = await runScript("scripts/wallet-expire-intents.ts", ["--limit", "2"], schema);
  assert.equal(limited.code, 0, limited.output);
  assert.match(limited.output, /2 intention\(s\) de recharge marquée\(s\) expirée\(s\) \(limite 2\)\./);
  const full = await runScript("scripts/wallet-expire-intents.ts", [], schema);
  assert.equal(full.code, 0, full.output);
  assert.match(full.output, /1 intention\(s\) de recharge marquée\(s\) expirée\(s\) \(limite 200\)\./);
  assert.match((await runScript("scripts/wallet-expire-intents.ts", [], schema)).output, /0 intention\(s\)/);
  assert.equal((await statusOf(alive.id)).status, "pending");
  for (const args of [["--limit"], ["--limit", "0"], ["--limit", "1001"], ["--limit", "abc"], ["--limit", "5", "--limit", "6"], ["--limite", "5"], ["5"]]) {
    const refused = await runScript("scripts/wallet-expire-intents.ts", args, schema);
    assert.equal(refused.code, 1, `${args.join(" ")} : ${refused.output}`);
    assert.match(refused.output, /Usage : npm run wallet:expire-intents/);
  }
});

// ═════════════ 9. Validation avant SQL et aucun flottant ═════════════

test("validation avant SQL : toute entrée invalide lève une erreur de validation sans UNE SEULE requête ni connexion", async () => {
  const { spy, count: queries } = observedPool();
  const owner = randomUUID();
  const good = { pool: spy, ownerId: owner, amountXof: big(1000), idempotencyKey: randomUUID() };
  const badTopups: Array<[string, Record<string, unknown>]> = [
    ["propriétaire", { ownerId: "x" }], ["propriétaire vide", { ownerId: "" }], ["montant flottant", { amountXof: 1000.5 }], ["montant nombre", { amountXof: 1000 }],
    ["montant chaîne", { amountXof: "1000" }], ["montant nul", { amountXof: ZERO }], ["montant négatif", { amountXof: -big(500) }], ["sous le minimum", { amountXof: big(400) }],
    ["pas un multiple de 100", { amountXof: big(1050) }], ["au-dessus du maximum", { amountXof: big(500_100) }], ["2^53", { amountXof: MAX_SAFE + big(1) }],
    ["2^53 + 1", { amountXof: MAX_SAFE + big(2) }], ["énorme", { amountXof: big("100000000000000000000000") }], ["clé", { idempotencyKey: "x" }],
    ["clé absente", { idempotencyKey: undefined }], ["pool absent", { pool: undefined }], ["pool nul", { pool: null }], ["pool invalide", { pool: {} }],
  ];
  for (const [label, override] of badTopups) await assert.rejects(createTopupIntent({ ...good, ...override } as never), CatalogValidationError, `createTopupIntent : ${label}`);
  for (const [label, input] of [
    ["propriétaire", { pool: spy, ownerId: "x", intentId: randomUUID() }], ["intention", { pool: spy, ownerId: owner, intentId: "x" }], ["pool", { pool: undefined, ownerId: owner, intentId: randomUUID() }],
  ] as const) await assert.rejects(readTopupIntent(input as never), CatalogValidationError, `readTopupIntent : ${label}`);

  const event: ProviderEvent = eventFor({ providerReference: "fakepay_abcdef123456", amountXof: big(1000) });
  const badEvents: Array<[string, unknown]> = [
    ["null", null], ["prestataire", { ...event, provider: "stripe" }], ["identifiant court", { ...event, eventId: "evt" }], ["identifiant avec espace", { ...event, eventId: "evt 12345678" }],
    ["type", { ...event, type: "payment.refunded" }], ["référence", { ...event, providerReference: "x" }], ["montant flottant", { ...event, amountXof: 1000.5 }],
    ["montant nombre", { ...event, amountXof: 1000 }], ["montant nul", { ...event, amountXof: ZERO }], ["montant négatif", { ...event, amountXof: -big(1) }],
    ["montant 2^53", { ...event, amountXof: MAX_SAFE + big(1) }], ["empreinte", { ...event, payloadSha256: "abc" }], ["empreinte en majuscules", { ...event, payloadSha256: sha("x").toUpperCase() }],
  ];
  for (const [label, bad] of badEvents) await assert.rejects(applyProviderEvent({ pool: spy, event: bad as ProviderEvent }), CatalogValidationError, `applyProviderEvent : ${label}`);

  const entries = (amount: unknown) => [
    { account: { kind: "boost_revenue" as const }, amount: -big(100) }, { account: { kind: "user" as const, ownerId: owner }, amount: amount as bigint },
  ];
  const badTransactions: Array<[string, unknown]> = [
    ["type", { kind: "refund", reference: "refund:x", entries: entries(big(100)) }], ["déséquilibre", { kind: "adjustment", reference: "adjustment:x", entries: entries(big(99)) }],
    ["flottant", { kind: "adjustment", reference: "adjustment:x", entries: entries(100) }], ["2^53", { kind: "adjustment", reference: "adjustment:x", entries: entries(MAX_SAFE + big(1)) }],
    ["référence", { kind: "adjustment", reference: "nimporte quoi", entries: entries(big(100)) }], ["métadonnée personnelle", { kind: "adjustment", reference: "adjustment:x", metadata: { email: "a@b.c" }, entries: entries(big(100)) }],
    ["une écriture", { kind: "adjustment", reference: "adjustment:x", entries: [entries(big(100))[1]] }],
  ];
  for (const [label, bad] of badTransactions) await assert.rejects(recordWalletTransaction(spy, bad as WalletTransactionInput), CatalogValidationError, `recordWalletTransaction : ${label}`);
  await assert.rejects(recordWalletTransaction(undefined as never, { kind: "adjustment", reference: "adjustment:x", entries: entries(big(100)) }), CatalogValidationError);

  for (const bad of ["x", "", 12, null, undefined]) {
    await assert.rejects(readWalletBalance(spy, bad as string), CatalogValidationError, `readWalletBalance : ${String(bad)}`);
    await assert.rejects(readWalletOverview({ pool: spy, ownerId: bad as string }), CatalogValidationError, `readWalletOverview : ${String(bad)}`);
    await assert.rejects(ensureUserWalletAccount(spy, bad as string), CatalogValidationError, `ensureUserWalletAccount : ${String(bad)}`);
  }
  await assert.rejects(readWalletOverview({ pool: spy, ownerId: owner, limit: 0 }), CatalogValidationError);
  await assert.rejects(readWalletOverview({ pool: spy, ownerId: owner, cursor: "x" }), CatalogValidationError);
  await assert.rejects(checkWalletIntegrity({} as Pool), CatalogValidationError);
  await assert.rejects(expirePaymentIntents({ pool: undefined as never }), CatalogValidationError);
  assert.equal(queries(), 0, "aucune requête, aucune connexion : la validation précède tout SQL");

  // Contrôle positif : l'espion compte bien les requêtes d'une entrée valide.
  await createTopupIntent({ ...good, ownerId: await makeUser() });
  assert.ok(queries() >= 1);
});

test("aucun flottant : montants au-delà de 2^53 refusés par le domaine ET par la base (jamais arrondis) ; les soldes lus sont des bigint exacts", async () => {
  const owner = await makeUser();
  await expectFailure("écriture de 2^53 en base", async (client) => {
    const account = await ensureUserWalletAccount(pool, owner);
    await insertEntry(client, await insertTransaction(client), account, "9007199254740992");
  }, "23514", "chk_wallet_entries_amount_range");
  await expectFailure("intention de 2^53 en base", (client) => insertIntent(client, owner, { amount_xof: "9007199254740992" }), "23514", "chk_payment_intents_amount");
  const another = await makeUser();
  await expectFailure("solde de 2^53 en base (garde d'insertion à solde nul désactivée le temps de l'essai)", async (client) => {
    await client.query("ALTER TABLE wallet_accounts DISABLE TRIGGER trg_wallet_accounts_guard");
    await client.query("INSERT INTO wallet_accounts (id, kind, owner_id, balance) VALUES (gen_random_uuid(), 'user', $1, 9007199254740992)", [another]);
  }, "23514", "chk_wallet_accounts_balance_range");
  await expectFailure("solde de 2^53 en base (garde active : refusé dès l'insertion)", (client) =>
    client.query("INSERT INTO wallet_accounts (id, kind, owner_id, balance) VALUES (gen_random_uuid(), 'user', $1, 9007199254740992)", [another]), "23001");

  // Schéma « sale » (comptes système à zéro) : un solde peut monter jusqu'à 2^53 - 1 exactement, jamais au-delà.
  const rich = await makeUser(dirtyPool);
  await adjustment(rich, Number.MAX_SAFE_INTEGER - 5, dirtyPool);
  assert.equal(await readWalletBalance(dirtyPool, rich), MAX_SAFE - big(5), "lu sans perte de précision");
  assert.equal(typeof (await readWalletBalance(dirtyPool, rich)), "bigint");
  await adjustment(rich, 5, dirtyPool);
  assert.equal(await readWalletBalance(dirtyPool, rich), MAX_SAFE, "exactement 2^53 - 1");
  const transactions = Number(await scalar(dirtyPool, "SELECT count(*)::int AS n FROM wallet_transactions"));
  let refusal: Failure | null = null;
  try { await adjustment(rich, 1, dirtyPool); } catch (error) { refusal = { code: (error as Failure).code, constraint: (error as Failure).constraint }; }
  assert.deepEqual(refusal, { code: "23514", constraint: "chk_wallet_accounts_balance_range" }, "2^53 refusé par la base, jamais arrondi");
  assert.equal(await readWalletBalance(dirtyPool, rich), MAX_SAFE, "solde inchangé");
  assert.equal(Number(await scalar(dirtyPool, "SELECT count(*)::int AS n FROM wallet_transactions")), transactions, "aucune trace de l'opération refusée");
});

test("le schéma propre reste cohérent à la fin du fichier : wallet:check vert (fonction et script) après toutes les opérations, y compris les concurrentes", async () => {
  await drainDueIntents();
  const report = await checkWalletIntegrity(pool);
  assert.deepEqual(report.violations, []);
  assert.equal(report.ok, true);
  const script = await runScript("scripts/wallet-check.ts", [], schema);
  assert.equal(script.code, 0, script.output);
  assert.match(script.output, /aucun écart/);
  assert.match(script.output, /AVERTISSEMENTS/, "les paiements refusés par les tests précédents sont listés à part");
  const strict = await runScript("scripts/wallet-check.ts", ["--strict"], schema);
  assert.equal(strict.code, 1, "--strict : les avertissements font sortir en 1");
  // Contrôle des invariants par SQL indépendant du module de contrôle.
  assert.equal(await scalar(pool, "SELECT COALESCE(sum(balance), 0)::text AS n FROM wallet_accounts"), "0", "partie double globale");
  assert.equal(Number(await scalar(pool, "SELECT count(*)::int AS n FROM wallet_accounts WHERE kind = 'user' AND balance < 0")), 0);
  assert.equal(Number(await scalar(pool, "SELECT count(*)::int AS n FROM (SELECT transaction_id FROM wallet_entries GROUP BY 1 HAVING sum(amount) <> 0) q")), 0);
});
