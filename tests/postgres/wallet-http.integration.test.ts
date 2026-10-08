import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { Pool, type PoolConfig } from "pg";
import { requestOtp, revokeSession, SESSION_TTL_MS, verifyOtp, type SendOtpInput } from "../../lib/server/auth";
import { runMigrations } from "../../lib/server/postgres/migrations";
import { checkWalletIntegrity } from "../../lib/server/wallet/check";
import { FAKE_SIGNATURE_HEADER, FAKE_WEBHOOK_MAX_BODY_BYTES, WALLET_CONTRACT_VERSION, WALLET_LOCK_TIMEOUT_MS, WALLET_TOPUP_LOCK_NAMESPACE } from "../../lib/server/wallet/config";
import { signFakePaymentBody } from "../../lib/server/wallet/fake-provider";
import { createWalletHttpHandlers, WALLET_HTTP_BODY_MAX_BYTES, type WalletHttpHandlers } from "../../lib/server/wallet/http";
import { recordWalletTransaction } from "../../lib/server/wallet/ledger";
import * as walletRoute from "../../app/api/wallet/route";
import * as topupsRoute from "../../app/api/wallet/topups/route";
import * as topupRoute from "../../app/api/wallet/topups/[id]/route";
import * as webhookRoute from "../../app/api/payments/fake/webhook/route";
import * as confirmRoute from "../../app/api/dev/fake-payments/[id]/confirm/route";
import * as failRoute from "../../app/api/dev/fake-payments/[id]/fail/route";
import {
  createTemporarySchemaName, openVerifiedIsolatedPool, openVerifiedTestDatabase, quoteTemporarySchema, type DedicatedTestDatabase,
} from "./test-database";

// ───────────── infrastructure ─────────────

class TestClock {
  constructor(private timestamp: number) {}
  readonly now = (): Date => new Date(this.timestamp);
  advance(milliseconds: number): void { this.timestamp += milliseconds; }
}

interface Login { userId: string; token: string; cookie: string }

const AUTH_SECRET = randomBytes(32);
const FAKE_SECRET = randomBytes(24).toString("hex");
const ORIGIN = "https://noma.test";
const FIXED_503 = { error: { code: "payment_unavailable", message: "Le paiement est temporairement indisponible." } };
const FIXED_WALLET_503 = { error: { code: "wallet_unavailable", message: "Le portefeuille est temporairement indisponible." } };
const FIXED_404 = { error: { code: "resource_not_found", message: "Ressource introuvable." } };
const FIXED_400 = { error: { code: "invalid_request", message: "Requête invalide." } };
const schema = createTemporarySchemaName();
const quoted = quoteTemporarySchema(schema);
const clock = new TestClock(Date.UTC(2032, 0, 1, 10));
const logs: string[] = [];
const log = (code: string): void => { logs.push(code); };
const baseEnv = { NODE_ENV: "test", NOMA_AUTH_ORIGIN: ORIGIN, NOMA_FAKE_PAYMENTS: "1", NOMA_FAKE_PAYMENT_SECRET: FAKE_SECRET };
const env: Record<string, string | undefined> = { ...baseEnv };
let admin: Pool, pool: Pool, holderPool: Pool;
let target: DedicatedTestDatabase;
let handlers: WalletHttpHandlers;
let alice: Login, bob: Login;
const extraPools: Pool[] = [];
/**
 * Chaque pool de ce fichier porte un `application_name` unique à cette exécution : le comptage des attentes de verrou ne regarde
 * que NOS sessions, jamais celles d'une autre exécution simultanée sur la même base de test.
 */
const RUN_ID = `wlh_${process.pid}_${randomBytes(4).toString("hex")}`;
const namedPoolFactory = (label: string) => (config: PoolConfig): Pool => new Pool({ ...config, application_name: `${RUN_ID}_${label}` });
const openNamed = (label: string): Promise<Pool> => openVerifiedIsolatedPool(target, schema, namedPoolFactory(label));
let phoneSequence = 0;
let ipSequence = 0;

async function login(): Promise<Login> {
  phoneSequence += 1;
  ipSequence += 1;
  let delivery: SendOtpInput | undefined;
  const requested = await requestOtp(`+22508${phoneSequence.toString().padStart(8, "0")}`, {
    pool, now: clock.now, authSecret: AUTH_SECRET, requestIp: `198.51.100.${ipSequence}`,
    sendOtp: async (input) => { delivery = input; },
  });
  assert.ok(delivery);
  const verified = await verifyOtp(requested.challengeId, delivery.code, { pool, now: clock.now, authSecret: AUTH_SECRET });
  return { userId: verified.userId, token: verified.sessionToken, cookie: `noma_auth=${verified.sessionToken}` };
}

before(async () => {
  const opened = await openVerifiedTestDatabase(process.env.TEST_DATABASE_URL);
  admin = opened.pool;
  target = opened.target;
  await admin.query(`CREATE SCHEMA ${quoted}`);
  pool = await openNamed("main");
  holderPool = await openNamed("holder");
  await runMigrations(pool);
  handlers = createWalletHttpHandlers({ pool, now: clock.now, env, log });
  alice = await login();
  bob = await login();
});

after(async () => {
  for (const extra of extraPools) await extra.end().catch(() => {});
  for (const each of [pool, holderPool]) if (each) await each.end().catch(() => {});
  if (admin) {
    await admin.query(`DROP SCHEMA IF EXISTS ${quoted} CASCADE`);
    await admin.end();
  }
});

const bank: Pool[] = [];
async function distinctPools(size: number): Promise<Pool[]> {
  while (bank.length < size) {
    const extra = await openNamed(`bank${bank.length}`);
    extraPools.push(extra);
    bank.push(extra);
  }
  return bank.slice(0, size);
}

// ───────────── requêtes et réponses ─────────────

interface CallOptions {
  /** Défaut : la session d'Alice. `null` : aucun cookie. */
  cookie?: string | null;
  /** Défaut : l'origine configurée. `null` : aucun en-tête Origin. */
  origin?: string | null;
  /** Corps sérialisé en JSON. */
  body?: unknown;
  /** Corps brut (prioritaire sur `body`). */
  raw?: string;
  contentType?: string | null;
  handlers?: WalletHttpHandlers;
}

function build(method: "GET" | "POST", path: string, options: CallOptions): Request {
  const headers: Record<string, string> = {};
  const cookie = options.cookie === undefined ? alice.cookie : options.cookie;
  if (cookie) headers.cookie = cookie;
  const origin = options.origin === undefined ? ORIGIN : options.origin;
  if (method === "POST" && origin !== null) headers.origin = origin;
  const payload = options.raw !== undefined ? options.raw : "body" in options ? JSON.stringify(options.body) : undefined;
  if (payload !== undefined) {
    const type = options.contentType === undefined ? "application/json" : options.contentType;
    if (type !== null) headers["content-type"] = type;
  }
  return new Request(`${ORIGIN}${path}`, { method, headers, ...(payload !== undefined ? { body: payload } : {}) });
}

interface Reply { status: number; text: string; json: unknown; headers: Array<[string, string]> }
const statusesSeen = new Set<number>();
const allTexts: string[] = [];

/** Chaque réponse du fichier passe ici : no-store, nosniff et JSON sont donc vérifiés sur TOUTES. */
async function reply(response: Response): Promise<Reply> {
  const text = await response.text();
  assert.equal(response.headers.get("cache-control"), "no-store", `Cache-Control sur ${response.status}`);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff", `nosniff sur ${response.status}`);
  assert.match(response.headers.get("content-type") ?? "", /^application\/json/, `content-type sur ${response.status}`);
  statusesSeen.add(response.status);
  allTexts.push(text);
  return { status: response.status, text, json: JSON.parse(text), headers: [...response.headers.entries()].sort() };
}

const asObject = (value: unknown): Record<string, unknown> => value as Record<string, unknown>;
const keys = (value: unknown): string[] => Object.keys(value as object).sort();
const sorted = (list: string[]): string[] => [...list].sort();
const h = (options: CallOptions) => options.handlers ?? handlers;

const getWallet = async (query = "", options: CallOptions = {}): Promise<Reply> => reply(await h(options).wallet.get(build("GET", `/api/wallet${query}`, options)));
const postTopup = async (body: unknown, options: CallOptions = {}): Promise<Reply> => reply(await h(options).topups.create(build("POST", "/api/wallet/topups", { body, ...options })));
const postTopupRaw = async (raw: string, options: CallOptions = {}): Promise<Reply> => reply(await h(options).topups.create(build("POST", "/api/wallet/topups", { raw, ...options })));
const getTopup = async (id: string, options: CallOptions = {}): Promise<Reply> => reply(await h(options).topups.get(build("GET", `/api/wallet/topups/${id}`, options), id));
const confirm = async (id: string, options: CallOptions = {}): Promise<Reply> => reply(await h(options).fakePayments.confirm(build("POST", `/api/dev/fake-payments/${id}/confirm`, options), id));
const fail = async (id: string, options: CallOptions = {}): Promise<Reply> => reply(await h(options).fakePayments.fail(build("POST", `/api/dev/fake-payments/${id}/fail`, options), id));

interface WebhookOptions {
  /** Défaut : la signature valide du corps. `null` : en-tête absent. */
  signature?: string | null;
  secret?: string;
  headers?: Record<string, string>;
  handlers?: WalletHttpHandlers;
}

const nowSeconds = (): number => Math.floor(clock.now().getTime() / 1000);
const bytesOf = (body: string | Uint8Array): Uint8Array => typeof body === "string" ? new TextEncoder().encode(body) : body;

function webhookRequest(body: string | Uint8Array, options: WebhookOptions = {}): Request {
  const bytes = bytesOf(body);
  const headers: Record<string, string> = { "content-type": "application/json", ...options.headers };
  const signature = options.signature === undefined ? signFakePaymentBody(options.secret ?? FAKE_SECRET, bytes) : options.signature;
  if (signature !== null) headers[FAKE_SIGNATURE_HEADER] = signature;
  return new Request(`${ORIGIN}/api/payments/fake/webhook`, { method: "POST", headers, body: bytes as BodyInit });
}
const webhook = async (body: string | Uint8Array, options: WebhookOptions = {}): Promise<Reply> => reply(await h(options).fakePayments.webhook(webhookRequest(body, options)));

interface IntentLike { id: string; providerReference: string; amountXof: bigint }

function eventBody(intent: { providerReference: string; amountXof: bigint }, override: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: `evt_${randomUUID().replaceAll("-", "")}`, type: "payment.succeeded", timestamp: nowSeconds(),
    providerReference: intent.providerReference, amountXof: Number(intent.amountXof), ...override,
  });
}

// ───────────── données ─────────────

interface ToupDto { id: string; amountXof: number; status: string; expiresAt: string; checkoutPath: string }
const topupOf = (reply: Reply): ToupDto => asObject(reply.json).topup as ToupDto;

async function createIntent(who: Login, amount = 1000): Promise<{ dto: ToupDto; intent: IntentLike }> {
  const created = await postTopup({ amountXof: amount, idempotencyKey: randomUUID() }, { cookie: who.cookie });
  assert.equal(created.status, 201, created.text);
  const dto = topupOf(created);
  const row = (await pool.query("SELECT provider_reference FROM payment_intents WHERE id = $1", [dto.id])).rows[0];
  return { dto, intent: { id: dto.id, providerReference: row.provider_reference, amountXof: BigInt(amount) } };
}

/** Intention en attente dont l'échéance est PASSÉE (insertion directe). */
async function expiredIntent(who: Login, amount = 1000): Promise<IntentLike> {
  const id = randomUUID();
  const reference = `fakepay_${randomBytes(12).toString("hex")}`;
  await pool.query(
    `INSERT INTO payment_intents (id, owner_id, amount_xof, provider, status, idempotency_key, provider_reference, created_at, expires_at)
     VALUES ($1, $2, $3, 'fake', 'pending', $4, $5, clock_timestamp() - interval '2 hours', clock_timestamp() - interval '1 hour')`,
    [id, who.userId, amount, randomUUID(), reference],
  );
  return { id, providerReference: reference, amountXof: BigInt(amount) };
}

const scalar = async (text: string, values: unknown[] = []): Promise<string> => String((await pool.query(text, values)).rows[0].n);
const balanceOf = async (who: Login): Promise<string> => scalar("SELECT COALESCE((SELECT balance::text FROM wallet_accounts WHERE kind = 'user' AND owner_id = $1), '0') AS n", [who.userId]);
const intentCount = async (who?: Login): Promise<number> => Number(who ? await scalar("SELECT count(*)::int AS n FROM payment_intents WHERE owner_id = $1", [who.userId]) : await scalar("SELECT count(*)::int AS n FROM payment_intents"));
const statusOf = async (id: string): Promise<string> => scalar("SELECT status AS n FROM payment_intents WHERE id = $1", [id]);

/** Photographie de tout ce qu'une requête pourrait écrire. */
async function snapshot(): Promise<string> {
  return JSON.stringify((await pool.query(
    `SELECT (SELECT count(*) FROM payment_intents)::int AS intents, (SELECT count(*) FROM payment_events)::int AS events,
            (SELECT count(*) FROM wallet_transactions)::int AS transactions, (SELECT count(*) FROM wallet_entries)::int AS entries,
            (SELECT COALESCE(sum(abs(balance)), 0) FROM wallet_accounts)::text AS balances,
            (SELECT count(*) FROM payment_intents WHERE status <> 'pending')::int AS settled`)).rows[0]);
}

function observedPool(): { spy: Pool; count: () => number } {
  let queries = 0;
  const spy = Object.create(pool) as Pool;
  spy.query = ((...args: unknown[]) => { queries++; return (pool.query as (...a: unknown[]) => unknown)(...args); }) as never;
  spy.connect = ((...args: unknown[]) => { queries++; return (pool.connect as (...a: unknown[]) => unknown)(...args); }) as never;
  return { spy, count: () => queries };
}

/** Nombre de sessions de CETTE exécution (application_name préfixé par RUN_ID) en attente d'un verrou. */
async function lockWaiters(): Promise<number> {
  return Number((await admin.query(
    `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND wait_event_type = 'Lock'
        AND starts_with(application_name, $1)`, [`${RUN_ID}_`])).rows[0].n);
}

/** Lance `launch` pendant qu'une session tient un verrou de table (écritures bloquées), attend `waiters` sessions en attente, puis relâche. */
async function contended<T>(launch: () => Array<Promise<T>>, waiters: number): Promise<{ results: Array<PromiseSettledResult<T>>; waiting: number }> {
  const holder = await holderPool.connect();
  let attempts: Array<Promise<T>> = [];
  let waiting = 0;
  try {
    await holder.query("BEGIN");
    await holder.query("LOCK TABLE payment_intents IN SHARE ROW EXCLUSIVE MODE");
    attempts = launch();
    const started = Date.now();
    waiting = await lockWaiters();
    while (waiting < waiters && Date.now() - started < 6_000) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      waiting = await lockWaiters();
    }
    await holder.query("COMMIT");
  } finally {
    await holder.query("ROLLBACK").catch(() => {});
    holder.release();
  }
  return { results: await Promise.allSettled(attempts), waiting };
}

// ═════════════ 1. Authentification, origine ═════════════

test("authentification : 401 sans cookie, cookie invalide ou double, session révoquée, expirée ou compte suspendu (toutes les routes à session)", async () => {
  const { dto } = await createIntent(alice);
  const revoked = await login();
  await revokeSession(revoked.token, { pool, now: clock.now });
  const expired = await login();
  clock.advance(SESSION_TTL_MS + 1_000);
  const fresh = await login();
  const suspended = await login();
  await pool.query("UPDATE users SET status = 'suspended' WHERE id = $1", [suspended.userId]);
  // Après l'avance de l'horloge, les sessions d'Alice et de Bob ont aussi expiré : on les renouvelle pour la suite du fichier.
  alice = await login();
  bob = await login();
  assert.ok(fresh.userId);

  const checks: Array<[string, CallOptions]> = [
    ["sans cookie", { cookie: null }],
    ["cookie invalide", { cookie: "noma_auth=invalide" }],
    ["deux cookies de session", { cookie: `${alice.cookie}; ${alice.cookie}` }],
    ["cookie d'un autre nom", { cookie: `autre=${alice.token}` }],
    ["session révoquée", { cookie: revoked.cookie }],
    ["session expirée", { cookie: expired.cookie }],
    ["compte suspendu", { cookie: suspended.cookie }],
  ];
  const expected = { error: { code: "authentication_required", message: "Authentification requise." } };
  for (const [label, options] of checks) {
    for (const response of [
      await getWallet("", options), await postTopup({ amountXof: 1000, idempotencyKey: randomUUID() }, options), await getTopup(dto.id, options),
      await confirm(dto.id, options), await fail(dto.id, options),
    ]) {
      assert.equal(response.status, 401, label);
      assert.deepEqual(response.json, expected, label);
    }
  }
  assert.equal(await statusOf(dto.id), "pending", "aucune requête refusée n'a touché l'intention");
});

test("origine : vérifiée AVANT la session sur les POST (aucune résolution de session ni requête SQL) ; absente, étrangère ou mal formée → 403 ; non configurée → 503 + code de journal", async () => {
  let sessionCalls = 0;
  const { spy, count } = observedPool();
  const guarded = createWalletHttpHandlers({
    pool: spy, now: clock.now, env, log, resolveSession: async (...args) => { sessionCalls++; return (await import("../../lib/server/auth/sessions")).resolveSession(...args); },
  });
  const id = randomUUID();
  const body = { amountXof: 1000, idempotencyKey: randomUUID() };
  for (const origin of [null, "https://evil.example", "http://noma.test", "https://noma.test:8443", "https://noma.test/", "https://noma.test/path", "null", "", "https://NOMA.test.evil.example"]) {
    for (const [label, response] of [
      ["topups", await postTopup(body, { origin, cookie: null, handlers: guarded })],
      ["confirm", await confirm(id, { origin, cookie: null, handlers: guarded })],
      ["fail", await fail(id, { origin, cookie: null, handlers: guarded })],
    ] as const) {
      assert.equal(response.status, 403, `${label} avec origine ${JSON.stringify(origin)}`);
      assert.deepEqual(response.json, { error: { code: "invalid_origin", message: "Origine de la requête non autorisée." } });
    }
  }
  assert.equal(sessionCalls, 0, "la session n'est jamais résolue pour une origine douteuse");
  assert.equal(count(), 0, "aucune requête SQL");

  // Origine correcte mais pas de session : alors seulement 401 (la session est lue après).
  assert.equal((await postTopup(body, { cookie: null, handlers: guarded })).status, 401);
  assert.equal(sessionCalls, 0, "pas de cookie : la résolution de session n'est même pas tentée");
  assert.equal((await postTopup(body, { cookie: "noma_auth=invalide", handlers: guarded })).status, 401);
  assert.equal(sessionCalls, 1);

  // Origine non configurée : 503 fixe et code de journal (jamais de message), avant la session.
  const before = logs.length;
  const unconfigured = createWalletHttpHandlers({ pool, now: clock.now, env: { ...baseEnv, NOMA_AUTH_ORIGIN: undefined }, log });
  for (const response of [
    await postTopup(body, { handlers: unconfigured }), await confirm(id, { handlers: unconfigured }), await fail(id, { handlers: unconfigured }),
  ]) {
    assert.equal(response.status, 503);
    assert.deepEqual(response.json, FIXED_503);
  }
  assert.deepEqual(logs.slice(before), ["origin_unconfigured", "origin_unconfigured", "origin_unconfigured"]);
  // Le GET (lecture seule) ne contrôle pas l'origine.
  assert.equal((await getWallet("", { handlers: unconfigured })).status, 200);
  assert.equal((await getWallet("", { origin: "https://evil.example" })).status, 200);
});

// ═════════════ 2. GET /api/wallet ═════════════

test("GET /api/wallet : solde et historique de l'utilisateur de la session, DTO en liste blanche, montants en entiers JSON signés, rien d'un autre compte", async () => {
  const empty = await getWallet("", { cookie: bob.cookie });
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.json, { contractVersion: WALLET_CONTRACT_VERSION, balanceXof: 0, promoBalanceXof: 0, promoExpiresAt: null, transactions: [], nextCursor: null });

  const { intent } = await createIntent(alice, 2500);
  const ledgerBefore = await getWallet();
  assert.equal(asObject(ledgerBefore.json).balanceXof, 0, "une intention n'est pas un crédit");
  assert.equal((await webhook(eventBody(intent))).status, 200);
  const wallet = await getWallet();
  assert.equal(wallet.status, 200);
  const body = asObject(wallet.json);
  assert.deepEqual(keys(body), sorted(["contractVersion", "balanceXof", "promoBalanceXof", "promoExpiresAt", "transactions", "nextCursor"]));
  assert.equal(body.promoBalanceXof, 0, "aucun crédit promotionnel sans abonnement");
  assert.equal(body.promoExpiresAt, null);
  assert.equal(body.contractVersion, "wallet/v1");
  assert.equal(body.balanceXof, 2500);
  assert.equal(typeof body.balanceXof, "number");
  const transactions = body.transactions as Array<Record<string, unknown>>;
  assert.equal(transactions.length, 1);
  assert.deepEqual(keys(transactions[0]), sorted(["id", "kind", "amountXof", "promoAmountXof", "createdAt"]));
  assert.equal(transactions[0].promoAmountXof, 0);
  assert.equal(transactions[0].kind, "topup");
  assert.equal(transactions[0].amountXof, 2500);
  assert.ok(Number.isInteger(transactions[0].amountXof));
  assert.match(String(transactions[0].createdAt), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

  // Débit côté utilisateur : montant négatif ; l'autre compte reste vide.
  await recordWalletTransaction(pool, {
    kind: "adjustment", reference: `adjustment:http-${randomUUID()}`,
    entries: [{ account: { kind: "user", ownerId: alice.userId }, amount: -BigInt(500) }, { account: { kind: "boost_revenue" }, amount: BigInt(500) }],
  });
  const after = asObject((await getWallet()).json);
  assert.equal(after.balanceXof, 2000);
  assert.deepEqual((after.transactions as Array<Record<string, unknown>>).map((item) => [item.kind, item.amountXof]), [["adjustment", -500], ["topup", 2500]]);
  assert.equal(asObject((await getWallet("", { cookie: bob.cookie })).json).balanceXof, 0, "Bob ne voit rien du compte d'Alice");
  const text = (await getWallet()).text;
  assert.ok(!/provider|fakepay|reference|account|owner|metadata|idempotency/i.test(text), `aucune donnée interne : ${text}`);
});

test("GET /api/wallet : pagination par curseur (limit 1 à 50, défaut 20), curseur d'une autre personne sans effet de fuite, paramètres invalides → 400", async () => {
  const carol = await login();
  for (let index = 0; index < 23; index++) {
    await recordWalletTransaction(pool, {
      kind: "adjustment", reference: `adjustment:page-${index}-${randomUUID()}`,
      entries: [{ account: { kind: "boost_revenue" }, amount: -BigInt(100 + index) }, { account: { kind: "user", ownerId: carol.userId }, amount: BigInt(100 + index) }],
    });
  }
  const first = asObject((await getWallet("", { cookie: carol.cookie })).json);
  assert.equal((first.transactions as unknown[]).length, 20, "20 par défaut");
  assert.equal(typeof first.nextCursor, "string");
  const second = asObject((await getWallet(`?cursor=${first.nextCursor}`, { cookie: carol.cookie })).json);
  assert.equal((second.transactions as unknown[]).length, 3);
  assert.equal(second.nextCursor, null);
  const ids = [...(first.transactions as Array<{ id: string }>), ...(second.transactions as Array<{ id: string }>)].map((item) => item.id);
  assert.equal(new Set(ids).size, 23, "sans doublon");
  const small = asObject((await getWallet("?limit=5", { cookie: carol.cookie })).json);
  assert.equal((small.transactions as unknown[]).length, 5);
  assert.equal((asObject((await getWallet("?limit=50", { cookie: carol.cookie })).json).transactions as unknown[]).length, 23);
  assert.equal((asObject((await getWallet("?limit=1", { cookie: carol.cookie })).json).transactions as unknown[]).length, 1);
  // Le curseur de Carol utilisé par Bob : Bob ne voit que SES lignes.
  const crossed = await getWallet(`?cursor=${first.nextCursor}`, { cookie: bob.cookie });
  assert.equal(crossed.status, 200);
  for (const id of ids) assert.ok(!crossed.text.includes(id), "aucune ligne de Carol chez Bob");

  const badQueries = [
    "?foo=1", "?limit=1&foo=2", "?Limit=5", "?offset=1", "?limit=1&limit=2", "?limit=0", "?limit=51", "?limit=-1", "?limit=1.5", "?limit=abc", "?limit=",
    "?limit=%20", "?limit=1e1", "?limit=%2B5", "?limit=0x10", "?limit=99999999999999999999", "?cursor=abc", "?cursor=", "?cursor=a&cursor=b",
    `?cursor=${"x".repeat(200)}`, `?cursor=${first.nextCursor}&cursor=${first.nextCursor}`, "?cursor=%00",
  ];
  for (const query of badQueries) {
    const response = await getWallet(query, { cookie: carol.cookie });
    assert.equal(response.status, 400, `GET ${query}`);
    assert.deepEqual(response.json, FIXED_400, `GET ${query}`);
  }
});

// ═════════════ 3. POST /api/wallet/topups ═════════════

test("POST /topups : 201 avec le DTO exact, 200 pour la même clé et le même montant (même intention), 409 pour un autre montant, jamais d'identifiant d'un autre utilisateur", async () => {
  const dan = await login();
  const key = randomUUID();
  const created = await postTopup({ amountXof: 5000, idempotencyKey: key }, { cookie: dan.cookie });
  assert.equal(created.status, 201);
  const body = asObject(created.json);
  assert.deepEqual(keys(body), sorted(["contractVersion", "topup"]));
  assert.equal(body.contractVersion, "wallet/v1");
  const dto = topupOf(created);
  assert.deepEqual(keys(dto), sorted(["id", "amountXof", "status", "expiresAt", "checkoutPath"]));
  assert.match(dto.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(dto.amountXof, 5000);
  assert.equal(typeof dto.amountXof, "number");
  assert.equal(dto.status, "pending");
  assert.equal(dto.checkoutPath, `/paiement-simule/${dto.id}`);
  const lifetime = new Date(dto.expiresAt).getTime() - Date.now();
  assert.ok(lifetime > 29 * 60_000 && lifetime <= 30 * 60_000, `expiration à 30 minutes : ${lifetime} ms`);
  assert.ok(!created.text.includes(dan.userId) && !/fakepay|idempotency|owner/i.test(created.text));

  const again = await postTopup({ amountXof: 5000, idempotencyKey: key }, { cookie: dan.cookie });
  assert.equal(again.status, 200);
  assert.equal(again.text, created.text, "même corps, même intention");
  const conflict = await postTopup({ amountXof: 6000, idempotencyKey: key }, { cookie: dan.cookie });
  assert.equal(conflict.status, 409);
  assert.deepEqual(conflict.json, { error: { code: "idempotency_conflict", message: "Cette clé d'idempotence a déjà servi pour un autre montant." } });
  assert.equal(await intentCount(dan), 1);
  // La même clé chez un autre utilisateur est une autre intention (jamais un accès à celle d'autrui).
  const other = await postTopup({ amountXof: 5000, idempotencyKey: key }, { cookie: bob.cookie });
  assert.equal(other.status, 201);
  assert.notEqual(topupOf(other).id, dto.id);
});

test("POST /topups : bornes du montant (500 à 500 000, multiple de 100), 5 intentions en attente au plus (409 too_many_pending_topups)", async () => {
  const erin = await login();
  for (const amount of [500, 600, 100_000, 499_900, 500_000]) {
    assert.equal((await postTopup({ amountXof: amount, idempotencyKey: randomUUID() }, { cookie: erin.cookie })).status, 201, `montant ${amount}`);
  }
  assert.equal(await intentCount(erin), 5);
  const limited = await postTopup({ amountXof: 500, idempotencyKey: randomUUID() }, { cookie: erin.cookie });
  assert.equal(limited.status, 409);
  assert.deepEqual(limited.json, { error: { code: "too_many_pending_topups", message: "Trop de recharges en attente." } });
  assert.equal(await intentCount(erin), 5, "la sixième n'est pas créée");
  const frank = await login();
  for (const amount of [0, -500, -1, 100, 400, 499, 501, 550, 1050, 500_001, 500_100, 1_000_000, 9_007_199_254_740_991]) {
    const refused = await postTopup({ amountXof: amount, idempotencyKey: randomUUID() }, { cookie: frank.cookie });
    assert.equal(refused.status, 400, `montant ${amount}`);
    assert.deepEqual(refused.json, FIXED_400);
  }
  assert.equal(await intentCount(frank), 0, "aucune intention pour un montant refusé");
});

test("POST /topups : 400 pour tout corps invalide (JSON piégé, flottants, types, clés en trop, en-tête, taille) et aucune ligne créée", async () => {
  const grace = await login();
  const uuid = randomUUID();
  const before = await snapshot();
  const valid = `{"amountXof":1000,"idempotencyKey":"${uuid}"}`;
  const badBodies: Array<[string, CallOptions & { raw?: string }]> = [
    ["non JSON", { raw: "{oops" }],
    ["corps vide", { raw: "" }],
    ["tableau", { raw: "[]" }],
    ["tableau contenant l'objet attendu", { raw: `[${valid}]` }],
    ["null", { raw: "null" }],
    ["chaîne", { raw: '"1000"' }],
    ["nombre", { raw: "1000" }],
    ["objet vide", { raw: "{}" }],
    ["clé idempotencyKey absente", { raw: '{"amountXof":1000}' }],
    ["clé amountXof absente", { raw: `{"idempotencyKey":"${uuid}"}` }],
    ["clé en trop", { raw: `{"amountXof":1000,"idempotencyKey":"${uuid}","ownerId":"${randomUUID()}"}` }],
    ["ownerId à la place", { raw: `{"ownerId":"${randomUUID()}","idempotencyKey":"${uuid}"}` }],
    ["__proto__", { raw: `{"amountXof":1000,"idempotencyKey":"${uuid}","__proto__":{"admin":true}}` }],
    ["__proto__ échappé", { raw: `{"amountXof":1000,"idempotencyKey":"${uuid}","\\u005f_proto__":1}` }],
    ["clé amountXof en double", { raw: `{"amountXof":1000,"amountXof":500000,"idempotencyKey":"${uuid}"}` }],
    ["clé idempotencyKey en double", { raw: `{"amountXof":1000,"idempotencyKey":"${uuid}","idempotencyKey":"${randomUUID()}"}` }],
    ["montant flottant", { raw: `{"amountXof":1000.5,"idempotencyKey":"${uuid}"}` }],
    ["montant 1000.0", { raw: `{"amountXof":1000.0,"idempotencyKey":"${uuid}"}` }],
    ["montant en notation scientifique", { raw: `{"amountXof":1e3,"idempotencyKey":"${uuid}"}` }],
    ["montant au-delà de 2^53 (littéral)", { raw: `{"amountXof":9007199254740993,"idempotencyKey":"${uuid}"}` }],
    ["montant énorme", { raw: `{"amountXof":99999999999999999999999,"idempotencyKey":"${uuid}"}` }],
    ["montant -0", { raw: `{"amountXof":-0,"idempotencyKey":"${uuid}"}` }],
    ["montant chaîne", { raw: `{"amountXof":"1000","idempotencyKey":"${uuid}"}` }],
    ["montant null", { raw: `{"amountXof":null,"idempotencyKey":"${uuid}"}` }],
    ["montant booléen", { raw: `{"amountXof":true,"idempotencyKey":"${uuid}"}` }],
    ["montant tableau", { raw: `{"amountXof":[1000],"idempotencyKey":"${uuid}"}` }],
    ["montant objet", { raw: `{"amountXof":{"value":1000},"idempotencyKey":"${uuid}"}` }],
    ["clé non UUID", { raw: '{"amountXof":1000,"idempotencyKey":"abc"}' }],
    ["clé vide", { raw: '{"amountXof":1000,"idempotencyKey":""}' }],
    ["clé nombre", { raw: '{"amountXof":1000,"idempotencyKey":12}' }],
    ["clé null", { raw: '{"amountXof":1000,"idempotencyKey":null}' }],
    ["contenu après l'objet", { raw: `${valid} {}` }],
    ["virgule finale", { raw: `{"amountXof":1000,"idempotencyKey":"${uuid}",}` }],
    ["content-type texte", { raw: valid, contentType: "text/plain" }],
    ["content-type formulaire", { raw: `amountXof=1000&idempotencyKey=${uuid}`, contentType: "application/x-www-form-urlencoded" }],
    ["sans content-type", { raw: valid, contentType: null }],
    ["corps un octet au-dessus du plafond", { raw: valid + " ".repeat(WALLET_HTTP_BODY_MAX_BYTES + 1 - Buffer.byteLength(valid)) }],
    ["corps très au-dessus du plafond", { raw: valid + " ".repeat(WALLET_HTTP_BODY_MAX_BYTES * 8) }],
  ];
  for (const [label, options] of badBodies) {
    const response = await postTopupRaw(options.raw ?? "", { cookie: grace.cookie, contentType: options.contentType });
    assert.equal(response.status, 400, `corps : ${label}`);
    assert.deepEqual(response.json, FIXED_400, `corps : ${label}`);
  }
  assert.equal(await snapshot(), before, "aucun corps invalide n'écrit quoi que ce soit");
  // Un corps exactement au plafond reste accepté.
  const exact = valid + " ".repeat(WALLET_HTTP_BODY_MAX_BYTES - Buffer.byteLength(valid));
  assert.equal(exact.length, WALLET_HTTP_BODY_MAX_BYTES);
  assert.equal((await postTopupRaw(exact, { cookie: grace.cookie })).status, 201);
});

test("POST /topups en parallèle : même clé ×6 → un 201 et cinq 200 de même intention ; clés différentes ×8 → cinq 201 et trois 409 (verrou de l'utilisateur)", async () => {
  const heidi = await login();
  const key = randomUUID();
  const pools = await distinctPools(8);
  const concurrent = pools.map((db) => createWalletHttpHandlers({ pool: db, now: clock.now, env, log }));
  const same = await contended(() => concurrent.slice(0, 6).map((each) => postTopup({ amountXof: 3000, idempotencyKey: key }, { cookie: heidi.cookie, handlers: each })), 6);
  assert.equal(same.waiting, 6, "les six requêtes attendaient en même temps");
  const sameReplies = same.results.map((result) => result.status === "fulfilled" ? result.value : null);
  assert.ok(sameReplies.every((entry) => entry !== null));
  assert.deepEqual(sameReplies.map((entry) => entry!.status).sort(), [200, 200, 200, 200, 200, 201]);
  assert.equal(new Set(sameReplies.map((entry) => topupOf(entry!).id)).size, 1, "une seule intention");
  assert.equal(await intentCount(heidi), 1);

  const ivan = await login();
  const different = await contended(() => concurrent.map((each) => postTopup({ amountXof: 500, idempotencyKey: randomUUID() }, { cookie: ivan.cookie, handlers: each })), 8);
  assert.equal(different.waiting, 8);
  const statuses = different.results.map((result) => result.status === "fulfilled" ? result.value.status : 0).sort();
  assert.deepEqual(statuses, [201, 201, 201, 201, 201, 409, 409, 409]);
  assert.equal(await intentCount(ivan), 5, "jamais plus de cinq intentions en attente");
});

// ═════════════ 4. GET /api/wallet/topups/[id] ═════════════

test("GET /topups/{id} : l'état de SON intention ; inexistante et intention d'autrui indiscernables (statut, en-têtes, corps) ; identifiant invalide → 400 ; échue → expired", async () => {
  const { dto, intent } = await createIntent(alice, 1500);
  const own = await getTopup(dto.id);
  assert.equal(own.status, 200);
  assert.deepEqual(keys(own.json), sorted(["contractVersion", "topup"]));
  assert.deepEqual(keys(topupOf(own)), sorted(["id", "amountXof", "status", "expiresAt", "checkoutPath"]));
  assert.equal(topupOf(own).status, "pending");
  const missing = await getTopup(randomUUID());
  assert.equal(missing.status, 404);
  assert.deepEqual(missing.json, FIXED_404);
  const foreign = await getTopup(dto.id, { cookie: bob.cookie });
  assert.equal(foreign.status, 404);
  assert.equal(foreign.text, missing.text, "corps identique");
  assert.deepEqual(foreign.headers, missing.headers, "en-têtes identiques");
  for (const id of ["pas-un-uuid", "", "123", `${randomUUID()}x`, randomUUID().replace(/-/g, "")]) {
    const response = await getTopup(id);
    assert.equal(response.status, 400, `id ${JSON.stringify(id)}`);
    assert.deepEqual(response.json, FIXED_400);
  }
  assert.equal((await webhook(eventBody(intent))).status, 200);
  assert.equal(topupOf(await getTopup(dto.id)).status, "succeeded");

  const late = await expiredIntent(alice);
  const expired = await getTopup(late.id);
  assert.equal(topupOf(expired).status, "expired", "statut effectif d'une intention échue non balayée");
  assert.equal(topupOf(expired).checkoutPath, `/paiement-simule/${late.id}`);
});

// ═════════════ 5. Prestataire inactif ═════════════

test("prestataire fictif inactif (production, drapeau absent ou autre que « 1 », secret absent ou trop court) : recharge → 503 payment_unavailable fixe, routes fictives → 404 sans aucune requête SQL ; le solde reste lisible", async () => {
  const sets: Array<[string, Record<string, string | undefined>]> = [
    ["production avec drapeau et secret valides", { NODE_ENV: "production" }],
    ["NODE_ENV avec une espace devant", { NODE_ENV: " production" }],
    ["NODE_ENV en capitale initiale", { NODE_ENV: "Production" }],
    ["NODE_ENV en majuscules", { NODE_ENV: "PRODUCTION" }],
    ["NODE_ENV « prod »", { NODE_ENV: "prod" }],
    ["NODE_ENV « staging »", { NODE_ENV: "staging" }],
    ["NODE_ENV vide", { NODE_ENV: "" }],
    ["NODE_ENV absent", { NODE_ENV: undefined }],
    ["NODE_ENV « development » avec une espace derrière", { NODE_ENV: "development " }],
    ["drapeau absent", { NOMA_FAKE_PAYMENTS: undefined }],
    ["drapeau 0", { NOMA_FAKE_PAYMENTS: "0" }],
    ["drapeau true", { NOMA_FAKE_PAYMENTS: "true" }],
    ["secret absent", { NOMA_FAKE_PAYMENT_SECRET: undefined }],
    ["secret vide", { NOMA_FAKE_PAYMENT_SECRET: "" }],
    ["secret de 31 octets", { NOMA_FAKE_PAYMENT_SECRET: "x".repeat(31) }],
  ];
  const { dto } = await createIntent(alice, 700);
  const missing404 = await (async () => {
    const quiet = createWalletHttpHandlers({ pool, now: clock.now, env: { ...baseEnv, NOMA_FAKE_PAYMENTS: undefined }, log });
    return confirm(randomUUID(), { handlers: quiet });
  })();
  for (const [label, override] of sets) {
    const { spy, count } = observedPool();
    let sessionCalls = 0;
    const inactive = createWalletHttpHandlers({
      pool: spy, now: clock.now, env: { ...baseEnv, ...override }, log,
      resolveSession: async (...args) => { sessionCalls++; return (await import("../../lib/server/auth/sessions")).resolveSession(...args); },
    });
    const before = await snapshot();
    // Routes fictives : 404 immédiat, avant l'origine, la session et le corps ; aucune requête SQL.
    const hidden = [
      await webhook(eventBody({ providerReference: "fakepay_abcdef123456", amountXof: BigInt(1000) }), { handlers: inactive }),
      await confirm(dto.id, { handlers: inactive }),
      await confirm(dto.id, { handlers: inactive, origin: "https://evil.example", cookie: null }),
      await fail(dto.id, { handlers: inactive }),
      await fail(randomUUID(), { handlers: inactive, cookie: null }),
    ];
    for (const response of hidden) {
      assert.equal(response.status, 404, label);
      assert.deepEqual(response.json, FIXED_404, label);
      assert.equal(response.text, missing404.text, `${label} : même corps que n'importe quelle ressource inconnue`);
    }
    assert.equal(count(), 0, `${label} : aucune requête SQL pour les routes fictives`);
    assert.equal(sessionCalls, 0, `${label} : aucune session résolue pour les routes fictives`);
    // Routes de recharge : 503 fixe (avec une session valide).
    const created = await postTopup({ amountXof: 1000, idempotencyKey: randomUUID() }, { handlers: inactive });
    assert.equal(created.status, 503, label);
    assert.deepEqual(created.json, FIXED_503, label);
    const read = await getTopup(dto.id, { handlers: inactive });
    assert.equal(read.status, 503, label);
    assert.deepEqual(read.json, FIXED_503, label);
    // Origine d'abord : une origine étrangère reste un 403 même quand le prestataire est inactif.
    assert.equal((await postTopup({ amountXof: 1000, idempotencyKey: randomUUID() }, { handlers: inactive, origin: "https://evil.example" })).status, 403, label);
    // Le portefeuille (solde, historique) ne dépend pas du prestataire.
    assert.equal((await getWallet("", { handlers: inactive })).status, 200, label);
    assert.equal(await snapshot(), before, `${label} : rien n'a été écrit`);
  }
  assert.equal(await statusOf(dto.id), "pending");
  assert.ok(logs.filter((code) => code === "provider_inactive").length >= sets.length * 2, "le refus est journalisé par un code");
});

test("activation relue à chaque requête : l'environnement d'exécution est lu à l'usage (activer, désactiver, réactiver sans recréer les gestionnaires)", async () => {
  const mutable: Record<string, string | undefined> = { ...baseEnv, NOMA_FAKE_PAYMENTS: undefined };
  const live = createWalletHttpHandlers({ pool, now: clock.now, env: mutable, log });
  const body = { amountXof: 1000, idempotencyKey: randomUUID() };
  assert.equal((await postTopup(body, { handlers: live })).status, 503);
  mutable.NOMA_FAKE_PAYMENTS = "1";
  const created = await postTopup(body, { handlers: live });
  assert.equal(created.status, 201);
  const dto = topupOf(created);
  mutable.NODE_ENV = "production";
  assert.equal((await postTopup(body, { handlers: live })).status, 503);
  assert.equal((await confirm(dto.id, { handlers: live })).status, 404);
  mutable.NODE_ENV = "development";
  assert.equal((await confirm(dto.id, { handlers: live })).status, 200);
  assert.equal(await statusOf(dto.id), "succeeded");
});

test("webhook : prestataire inactif → 404 AVANT toute lecture du corps (le flux n'est ni tiré ni consommé) ; actif → le corps est bien lu", async () => {
  const bodyThatCountsReads = (): { request: Request; pulls: () => number } => {
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) { pulls += 1; controller.enqueue(new TextEncoder().encode("{}")); controller.close(); },
    }, { highWaterMark: 0 });
    const request = new Request(`${ORIGIN}/api/payments/fake/webhook`, {
      method: "POST", headers: { "content-type": "application/json", [FAKE_SIGNATURE_HEADER]: "0".repeat(64) }, body: stream, duplex: "half",
    } as RequestInit & { duplex: "half" });
    return { request, pulls: () => pulls };
  };
  for (const override of [{ NOMA_FAKE_PAYMENTS: undefined }, { NODE_ENV: "production" }, { NODE_ENV: "Production" }, { NOMA_FAKE_PAYMENT_SECRET: "court" }]) {
    const inactive = createWalletHttpHandlers({ pool, now: clock.now, env: { ...baseEnv, ...override }, log });
    const probe = bodyThatCountsReads();
    const response = await reply(await inactive.fakePayments.webhook(probe.request));
    assert.equal(response.status, 404, JSON.stringify(override));
    assert.deepEqual(response.json, FIXED_404);
    assert.equal(probe.pulls(), 0, `${JSON.stringify(override)} : le corps n'a pas été lu`);
    assert.equal(probe.request.bodyUsed, false, `${JSON.stringify(override)} : le corps n'a pas été consommé`);
  }
  // Contrôle positif : prestataire actif, le même flux est lu (signature fausse → 400, jamais 404).
  const probe = bodyThatCountsReads();
  const active = await reply(await handlers.fakePayments.webhook(probe.request));
  assert.equal(active.status, 400);
  assert.ok(probe.pulls() >= 1, "le corps est lu quand le prestataire est actif");
});

// ═════════════ 6. Webhook ═════════════

test("webhook : un événement signé valide → 200 {\"received\":true} SANS session ni origine ; l'intention est réussie, le solde crédité une fois ; rejeu → 200 sans second crédit", async () => {
  const before = await balanceOf(alice);
  const { dto, intent } = await createIntent(alice, 2500);
  const body = eventBody(intent);
  const received = await webhook(body, { headers: { origin: "https://evil.example", cookie: "noma_auth=n-importe-quoi" } });
  assert.equal(received.status, 200);
  assert.equal(received.text, '{"received":true}');
  assert.equal(await statusOf(dto.id), "succeeded");
  assert.equal(await balanceOf(alice), String(Number(before) + 2500));
  const replay = await webhook(body);
  assert.equal(replay.status, 200);
  assert.equal(replay.text, '{"received":true}', "même réponse pour un doublon : la réponse ne révèle jamais l'issue");
  assert.equal(await balanceOf(alice), String(Number(before) + 2500), "un seul crédit");
  assert.equal(Number(await scalar("SELECT count(*)::int AS n FROM payment_events WHERE intent_id = $1", [dto.id])), 1, "la relecture n'ajoute aucune ligne");
  // Même identifiant d'événement, corps différent (montant) mais signature valide : relecture, journal applicatif, rien d'appliqué.
  const parsed = JSON.parse(body) as Record<string, unknown>;
  const before2 = logs.length;
  const tampered = await webhook(JSON.stringify({ ...parsed, amountXof: 100_000 }));
  assert.equal(tampered.status, 200);
  assert.deepEqual(logs.slice(before2), ["webhook_event_id_reused"]);
  assert.equal(await balanceOf(alice), String(Number(before) + 2500));
  // Un événement « failed » pour une intention réussie est refusé (rejected_state) mais reçu.
  const late = await webhook(eventBody(intent, { type: "payment.failed" }));
  assert.equal(late.status, 200);
  assert.equal(await statusOf(dto.id), "succeeded");
  assert.deepEqual(
    (await pool.query("SELECT outcome FROM payment_events WHERE intent_id = $1 ORDER BY received_at, id", [dto.id])).rows.map((row) => row.outcome),
    ["applied", "rejected_state"],
  );
});

test("webhook : montant falsifié → 200 reçu, rejected_amount, aucun crédit ; failed puis succeeded → rejected_state ; intention expirée → crédit appliqué ; référence inconnue → journalisée sans intention", async () => {
  const forged = await createIntent(alice, 1000);
  const balance = await balanceOf(alice);
  for (const amount of [1100, 900, 1]) assert.equal((await webhook(eventBody(forged.intent, { amountXof: amount }))).status, 200);
  assert.equal(await balanceOf(alice), balance, "aucun crédit");
  assert.equal(await statusOf(forged.dto.id), "pending");
  assert.deepEqual(
    (await pool.query("SELECT outcome FROM payment_events WHERE intent_id = $1", [forged.dto.id])).rows.map((row) => row.outcome),
    ["rejected_amount", "rejected_amount", "rejected_amount"],
  );

  const failedFirst = await createIntent(alice, 1200);
  assert.equal((await webhook(eventBody(failedFirst.intent, { type: "payment.failed" }))).status, 200);
  assert.equal(await statusOf(failedFirst.dto.id), "failed");
  assert.equal((await webhook(eventBody(failedFirst.intent))).status, 200);
  assert.equal(await statusOf(failedFirst.dto.id), "failed", "un échec est définitif");
  assert.equal(await balanceOf(alice), balance, "aucun crédit après un échec");
  assert.deepEqual(
    (await pool.query("SELECT outcome FROM payment_events WHERE intent_id = $1 ORDER BY received_at, id", [failedFirst.dto.id])).rows.map((row) => row.outcome),
    ["applied", "rejected_state"],
  );

  const late = await expiredIntent(alice, 3300);
  assert.equal((await webhook(eventBody(late))).status, 200);
  assert.equal(await statusOf(late.id), "succeeded", "un paiement tardif est appliqué");
  assert.equal(await balanceOf(alice), String(Number(balance) + 3300));

  const unknown = eventBody({ providerReference: "fakepay_inconnue000001", amountXof: BigInt(1000) });
  assert.equal((await webhook(unknown)).status, 200);
  const row = (await pool.query("SELECT intent_id, outcome FROM payment_events WHERE provider_event_id = $1", [JSON.parse(unknown).id])).rows[0];
  assert.deepEqual(row, { intent_id: null, outcome: "rejected_unknown_intent" });
});

test("webhook : signature absente, invalide ou mal formée → 400 invalid_signature, AUCUNE requête SQL, rien d'écrit, compté dans le journal ; code seulement", async () => {
  const { dto, intent } = await createIntent(alice, 1000);
  const body = eventBody(intent);
  const good = signFakePaymentBody(FAKE_SECRET, body);
  const { spy, count } = observedPool();
  const strict = createWalletHttpHandlers({ pool: spy, now: clock.now, env, log });
  const before = await snapshot();
  const logged = logs.length;
  const flipped = `${good.slice(0, 63)}${good[63] === "0" ? "1" : "0"}`;
  const wrongBody = signFakePaymentBody(FAKE_SECRET, `${body} `);
  const cases: Array<[string, WebhookOptions]> = [
    ["en-tête absent", { signature: null }],
    ["en-tête vide", { signature: "" }],
    ["un caractère modifié", { signature: flipped }],
    ["autre secret", { secret: "z".repeat(40) }],
    ["signature d'un autre corps", { signature: wrongBody }],
    ["majuscules", { signature: good.toUpperCase() }],
    ["préfixe sha256=", { signature: `sha256=${good}` }],
    ["trop courte", { signature: good.slice(0, 62) }],
    ["trop longue", { signature: `${good}00` }],
    ["non hexadécimale", { signature: "g".repeat(64) }],
    ["que des zéros", { signature: "0".repeat(64) }],
  ];
  for (const [label, options] of cases) {
    const response = await webhook(body, { ...options, handlers: strict });
    assert.equal(response.status, 400, label);
    assert.deepEqual(response.json, { error: { code: "invalid_signature", message: "Signature invalide." } }, label);
  }
  // Corps valide mais signature d'un corps légèrement différent (un octet de plus) : refusé aussi.
  assert.equal((await webhook(`${body} `, { signature: good, handlers: strict })).status, 400);
  assert.equal(count(), 0, "une signature invalide n'ouvre aucune connexion ni requête");
  assert.equal(await snapshot(), before, "rien n'est écrit, aucun événement stocké");
  assert.equal(await statusOf(dto.id), "pending");
  assert.deepEqual(logs.slice(logged), Array(cases.length + 1).fill("webhook_invalid_signature"), "chaque refus est compté par un code, sans contenu");
  assert.equal(Number(await scalar("SELECT count(*)::int AS n FROM payment_events WHERE provider_event_id = $1", [JSON.parse(body).id])), 0);
  // La signature valide du même corps passe.
  assert.equal((await webhook(body, { signature: good })).status, 200);
});

test("webhook : horodatage hors ±5 minutes, corps JSON piégé ou de forme fausse (signature VALIDE) → 400 invalid_event, aucune requête SQL ni écriture", async () => {
  const { intent } = await createIntent(alice, 1000);
  const { spy, count } = observedPool();
  const strict = createWalletHttpHandlers({ pool: spy, now: clock.now, env, log });
  const before = await snapshot();
  const base = { id: "evt_trap0001", type: "payment.succeeded", timestamp: nowSeconds(), providerReference: intent.providerReference, amountXof: 1000 };
  const text = (override: Record<string, unknown>) => JSON.stringify({ ...base, ...override });
  const canonical = `{"id":"evt_trap0001","type":"payment.succeeded","timestamp":${nowSeconds()},"providerReference":"${intent.providerReference}","amountXof":1000}`;
  const trapped: Array<[string, string | Uint8Array]> = [
    ["horodatage 301 s dans le passé", text({ timestamp: nowSeconds() - 301 })],
    ["horodatage 301 s dans le futur", text({ timestamp: nowSeconds() + 301 })],
    ["horodatage ancien", text({ timestamp: 1_000_000_000 })],
    ["horodatage texte", text({ timestamp: String(nowSeconds()) })],
    ["horodatage flottant", canonical.replace(String(nowSeconds()), `${nowSeconds()}.5`)],
    ["clé en double (montant)", canonical.replace('"amountXof":1000', '"amountXof":1000,"amountXof":1')],
    ["clé en double (référence)", canonical.replace('"id":"evt_trap0001",', '"id":"evt_trap0001","id":"evt_trap0002",')],
    ["__proto__", canonical.replace("{", '{"__proto__":{"amountXof":1},')],
    ["__proto__ échappé", canonical.replace("{", '{"\\u005f_proto__":1,')],
    ["montant flottant", canonical.replace('"amountXof":1000', '"amountXof":1000.5')],
    ["montant en notation scientifique", canonical.replace('"amountXof":1000', '"amountXof":1e3')],
    ["montant au-delà de 2^53", canonical.replace('"amountXof":1000', '"amountXof":9007199254740993')],
    ["montant chaîne", text({ amountXof: "1000" })],
    ["montant nul", text({ amountXof: 0 })],
    ["montant négatif", text({ amountXof: -1000 })],
    ["montant null", text({ amountXof: null })],
    ["type inconnu", text({ type: "payment.refunded" })],
    ["type nombre", text({ type: 1 })],
    ["identifiant trop court", text({ id: "evt" })],
    ["identifiant avec espace", text({ id: "evt trap0001" })],
    ["référence invalide", text({ providerReference: "x" })],
    ["clé en plus", text({ extra: 1 })],
    ["clé imbriquée en plus", text({ data: { amountXof: 1 } })],
    ["clé manquante", JSON.stringify({ id: "evt_trap0001", type: "payment.succeeded", timestamp: nowSeconds(), providerReference: intent.providerReference })],
    ["tableau", `[${canonical}]`],
    ["null", "null"],
    ["chaîne", '"texte"'],
    ["corps vide", ""],
    ["JSON invalide", "{oops"],
    ["contenu après l'objet", `${canonical} {}`],
    ["UTF-8 invalide", new Uint8Array([0x7b, 0xff, 0xfe, 0x7d])],
    ["BOM", new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(canonical)])],
    ["profondeur excessive", `{"a":${"[".repeat(20)}${"]".repeat(20)}}`],
  ];
  for (const [label, body] of trapped) {
    const response = await webhook(body, { handlers: strict });
    assert.equal(response.status, 400, label);
    assert.deepEqual(response.json, { error: { code: "invalid_event", message: "Événement invalide." } }, label);
  }
  assert.equal(count(), 0, "un événement invalide n'atteint pas la base");
  assert.equal(await snapshot(), before, "aucun événement stocké, aucun état modifié");
  // Les bornes exactes passent : ±300 s.
  for (const delta of [-300, 300, 0]) {
    assert.equal((await webhook(eventBody(intent, { timestamp: nowSeconds() + delta, id: `evt_edge${delta + 300}`.padEnd(12, "0") }))).status, 200, `delta ${delta}`);
  }
});

test("webhook : corps limité à 8 Kio (8 192 octets acceptés, 8 193 refusés même signés) ; en-tête Content-Length mensonger ou invalide refusé", async () => {
  const { intent } = await createIntent(alice, 1000);
  const { spy, count } = observedPool();
  const strict = createWalletHttpHandlers({ pool: spy, now: clock.now, env, log });
  const before = await snapshot();
  const compact = eventBody(intent);
  const padded = (total: number): string => compact + " ".repeat(total - Buffer.byteLength(compact));
  for (const size of [FAKE_WEBHOOK_MAX_BODY_BYTES + 1, FAKE_WEBHOOK_MAX_BODY_BYTES + 100, FAKE_WEBHOOK_MAX_BODY_BYTES * 20]) {
    const response = await webhook(padded(size), { handlers: strict });
    assert.equal(response.status, 400, `${size} octets`);
    assert.deepEqual(response.json, { error: { code: "invalid_event", message: "Événement invalide." } });
  }
  const declared = webhookRequest(compact, { handlers: strict, headers: { "content-length": "99999" } });
  assert.equal((await reply(await strict.fakePayments.webhook(declared))).status, 400, "taille annoncée trop grande");
  const garbage = webhookRequest(compact, { handlers: strict, headers: { "content-length": "abc" } });
  assert.equal((await reply(await strict.fakePayments.webhook(garbage))).status, 400, "Content-Length non numérique");
  assert.equal(count(), 0);
  assert.equal(await snapshot(), before, "aucun écrit");
  const exact = padded(FAKE_WEBHOOK_MAX_BODY_BYTES);
  assert.equal(Buffer.byteLength(exact), FAKE_WEBHOOK_MAX_BODY_BYTES);
  assert.equal((await webhook(exact)).status, 200, "exactement 8 192 octets : accepté (espaces de fin tolérés par JSON)");
  assert.equal(await statusOf(intent.id), "succeeded");
});

test("webhook en parallèle : le même événement rejoué ×10 → un seul crédit, tous en 200 ; deux événements distincts ×6 → un seul crédit, tous en 200", async () => {
  const judy = await login();
  const pools = await distinctPools(10);
  const concurrent = pools.map((db) => createWalletHttpHandlers({ pool: db, now: clock.now, env, log }));
  const { intent, dto } = await createIntent(judy, 2500);
  const body = eventBody(intent);
  const same = await contended(() => concurrent.map((each) => webhook(body, { handlers: each })), 10);
  assert.equal(same.waiting, 10, "les dix requêtes attendaient en même temps");
  const sameReplies = same.results.map((result) => result.status === "fulfilled" ? result.value.status : 0);
  assert.deepEqual(sameReplies, Array(10).fill(200));
  assert.equal(await balanceOf(judy), "2500", "un seul crédit");
  assert.equal(Number(await scalar("SELECT count(*)::int AS n FROM payment_events WHERE intent_id = $1", [dto.id])), 1);

  const second = await createIntent(judy, 4000);
  const distinct = await contended(() => concurrent.slice(0, 6).map((each) => webhook(eventBody(second.intent), { handlers: each })), 6);
  assert.equal(distinct.waiting, 6);
  assert.deepEqual(distinct.results.map((result) => result.status === "fulfilled" ? result.value.status : 0), Array(6).fill(200));
  assert.equal(await balanceOf(judy), "6500", "un seul crédit de 4000 de plus");
  assert.deepEqual(
    (await pool.query("SELECT outcome FROM payment_events WHERE intent_id = $1 ORDER BY outcome", [second.dto.id])).rows.map((row) => row.outcome),
    ["applied", "duplicate", "duplicate", "duplicate", "duplicate", "duplicate"],
  );
});

// ═════════════ 7. Routes de développement ═════════════

test("routes de développement : confirm crédite par le MÊME chemin que le webhook (événement signé journalisé, identifiant aléatoire), un second confirm est un doublon sans second crédit", async () => {
  const { dto } = await createIntent(alice, 1800);
  const balance = Number(await balanceOf(alice));
  const confirmed = await confirm(dto.id);
  assert.equal(confirmed.status, 200);
  assert.deepEqual(keys(confirmed.json), sorted(["contractVersion", "outcome", "topup"]));
  assert.equal(asObject(confirmed.json).outcome, "applied");
  assert.equal(topupOf(confirmed).status, "succeeded");
  assert.deepEqual(keys(topupOf(confirmed)), sorted(["id", "amountXof", "status", "expiresAt", "checkoutPath"]));
  assert.equal(await balanceOf(alice), String(balance + 1800));
  const events = (await pool.query("SELECT provider_event_id, type, amount_xof::text AS amount, payload_sha256, outcome FROM payment_events WHERE intent_id = $1", [dto.id])).rows;
  assert.equal(events.length, 1);
  assert.match(events[0].provider_event_id, /^evt_[0-9a-f]{32}$/);
  assert.match(events[0].payload_sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual([events[0].type, events[0].amount, events[0].outcome], ["payment.succeeded", "1800", "applied"]);
  const again = await confirm(dto.id);
  assert.equal(again.status, 200);
  assert.equal(asObject(again.json).outcome, "duplicate");
  assert.equal(await balanceOf(alice), String(balance + 1800), "pas de second crédit");
  const failedAfter = await fail(dto.id);
  assert.equal(asObject(failedAfter.json).outcome, "rejected_state");
  assert.equal(topupOf(failedAfter).status, "succeeded");
  assert.deepEqual(
    (await pool.query("SELECT outcome FROM payment_events WHERE intent_id = $1 ORDER BY received_at, id", [dto.id])).rows.map((row) => row.outcome),
    ["applied", "duplicate", "rejected_state"],
  );
});

test("routes de développement : fail → failed sans crédit ; intention échue non balayée → confirm applique le paiement ; propriétaire seulement (404 indiscernable) ; corps non vide ou identifiant invalide → 400", async () => {
  const { dto } = await createIntent(alice, 900);
  const balance = await balanceOf(alice);
  const failed = await fail(dto.id);
  assert.equal(failed.status, 200);
  assert.equal(asObject(failed.json).outcome, "applied");
  assert.equal(topupOf(failed).status, "failed");
  assert.equal(await balanceOf(alice), balance);
  assert.equal(asObject((await confirm(dto.id)).json).outcome, "rejected_state", "un échec est définitif");
  assert.equal(await balanceOf(alice), balance);

  const late = await expiredIntent(alice, 2200);
  assert.equal(topupOf(await getTopup(late.id)).status, "expired");
  const paid = await confirm(late.id);
  assert.equal(asObject(paid.json).outcome, "applied");
  assert.equal(topupOf(paid).status, "succeeded");
  assert.equal(await balanceOf(alice), String(Number(balance) + 2200));

  const mine = await createIntent(alice, 700);
  const missing = await confirm(randomUUID());
  assert.equal(missing.status, 404);
  assert.deepEqual(missing.json, FIXED_404);
  const before = await snapshot();
  for (const route of [confirm, fail]) {
    const foreign = await route(mine.dto.id, { cookie: bob.cookie });
    assert.equal(foreign.status, 404, "intention d'autrui");
    assert.equal(foreign.text, missing.text);
    assert.deepEqual(foreign.headers, missing.headers);
  }
  assert.equal(await snapshot(), before, "rien n'est écrit pour l'intention d'autrui");
  assert.equal(await statusOf(mine.dto.id), "pending");
  for (const id of ["pas-un-uuid", "123", `${randomUUID()}x`]) {
    assert.equal((await confirm(id)).status, 400);
    assert.equal((await fail(id)).status, 400);
  }
  for (const options of [{ raw: "{}" }, { raw: "x" }, { raw: '{"amountXof":1}' }]) {
    const withBody = await reply(await handlers.fakePayments.confirm(build("POST", `/api/dev/fake-payments/${mine.dto.id}/confirm`, { ...options }), mine.dto.id));
    assert.equal(withBody.status, 400);
    assert.deepEqual(withBody.json, FIXED_400);
  }
  assert.equal(await statusOf(mine.dto.id), "pending");
  assert.equal(await snapshot(), before);
});

// ═════════════ 8. Erreurs 503 et journal ═════════════

test("503 : base indisponible, session impossible à résoudre, verrou (55P03), erreur inconnue → code fixe, journal limité à un code, le webhook répond 503 pour être rejoué ; un journal défaillant est ignoré", async () => {
  const failingPool = (code: string | undefined, message = "secret interne : mot de passe=hunter2 SELECT * FROM users"): Pool => {
    const error = Object.assign(new Error(message), code === undefined ? {} : { code });
    const bad = Object.create(pool) as Pool;
    bad.query = (async () => { throw error; }) as never;
    bad.connect = (async () => { throw error; }) as never;
    return bad;
  };
  const { dto, intent } = await createIntent(alice, 1000);
  const cases: Array<[string | undefined, string]> = [["55P03", "55P03"], ["ECONNREFUSED", "ECONNREFUSED"], [undefined, "unexpected_error"], ["code avec espaces!", "unexpected_error"]];
  for (const [code, expected] of cases) {
    const seen: string[] = [];
    const broken = createWalletHttpHandlers({ pool: failingPool(code), now: clock.now, env, log: (entry) => seen.push(entry), resolveSession: async () => ({ userId: alice.userId, expiresAt: new Date(2040, 0, 1) }) });
    for (const response of [
      await postTopup({ amountXof: 1000, idempotencyKey: randomUUID() }, { handlers: broken }),
      await getTopup(dto.id, { handlers: broken }),
      await confirm(dto.id, { handlers: broken }),
      await fail(dto.id, { handlers: broken }),
    ]) {
      assert.equal(response.status, 503);
      assert.deepEqual(response.json, FIXED_503);
      assert.ok(!response.text.includes("hunter2") && !response.text.includes("SELECT"), "aucun message brut");
    }
    const wallet = await getWallet("", { handlers: broken });
    assert.equal(wallet.status, 503);
    assert.deepEqual(wallet.json, FIXED_WALLET_503);
    const webhookReply = await webhook(eventBody(intent), { handlers: broken });
    assert.equal(webhookReply.status, 503, "le prestataire pourra rejouer l'événement");
    assert.deepEqual(webhookReply.json, FIXED_503);
    assert.deepEqual(seen, Array(6).fill(expected), `journal pour ${String(code)} : un code seulement`);
  }
  assert.equal(await statusOf(dto.id), "pending", "rien n'a été appliqué pendant les pannes");
  const noSession = createWalletHttpHandlers({ pool, now: clock.now, env, log, resolveSession: async () => { throw Object.assign(new Error("session cassée"), { code: "08006" }); } });
  const before = logs.length;
  const unavailable = await getWallet("", { handlers: noSession });
  assert.equal(unavailable.status, 503);
  assert.deepEqual(unavailable.json, FIXED_WALLET_503);
  assert.equal((await postTopup({ amountXof: 1000, idempotencyKey: randomUUID() }, { handlers: noSession })).status, 503);
  assert.deepEqual(logs.slice(before), ["08006", "08006"]);
  const throwing = createWalletHttpHandlers({ pool: failingPool("57P01"), now: clock.now, env, log: () => { throw new Error("journal cassé"); }, resolveSession: async () => ({ userId: alice.userId, expiresAt: new Date(2040, 0, 1) }) });
  assert.equal((await getTopup(dto.id, { handlers: throwing })).status, 503, "un journal qui lève ne change pas la réponse");
  // Le journal par défaut écrit un seul code.
  const lines: string[] = [];
  const original = console.error;
  console.error = (...parts: unknown[]) => { lines.push(parts.join(" ")); };
  try {
    const byDefault = createWalletHttpHandlers({ pool: failingPool("57P01"), now: clock.now, env, resolveSession: async () => ({ userId: alice.userId, expiresAt: new Date(2040, 0, 1) }) });
    await getTopup(dto.id, { handlers: byDefault });
  } finally { console.error = original; }
  assert.deepEqual(lines, ["[wallet-http] 57P01"]);
});

test("verrou tenu par un autre client : POST /topups et webhook échouent VITE (lock_timeout) → 503 payment_unavailable, journal 55P03, rien d'écrit ; le webhook rejoué ensuite est appliqué une seule fois", async () => {
  const deadline = WALLET_LOCK_TIMEOUT_MS + 4_000;
  const timed = async (call: () => Promise<Reply>): Promise<{ response: Reply; elapsed: number }> => {
    const started = Date.now();
    const result = await Promise.race([call(), new Promise<"stalled">((resolve) => setTimeout(() => resolve("stalled"), deadline))]);
    assert.notEqual(result, "stalled", `la requête attendait encore le verrou après ${deadline} ms : pas de lock_timeout`);
    return { response: result as Reply, elapsed: Date.now() - started };
  };
  const user = await login();
  const before = logs.length;

  const holder = await holderPool.connect();
  try {
    await holder.query("BEGIN");
    await holder.query("SELECT pg_advisory_xact_lock($1::int, hashtext($2::text))", [WALLET_TOPUP_LOCK_NAMESPACE, user.userId]);
    const { response, elapsed } = await timed(() => postTopup({ amountXof: 1000, idempotencyKey: randomUUID() }, { cookie: user.cookie }));
    assert.equal(response.status, 503);
    assert.deepEqual(response.json, FIXED_503);
    assert.ok(elapsed >= WALLET_LOCK_TIMEOUT_MS - 500 && elapsed < deadline, `échec après ${elapsed} ms`);
    assert.equal(await intentCount(user), 0, "aucune intention créée");
    await holder.query("COMMIT");
  } finally {
    await holder.query("ROLLBACK").catch(() => {});
    holder.release();
  }
  assert.deepEqual(logs.slice(before), ["55P03"], "journal : un code seulement");
  assert.equal((await postTopup({ amountXof: 1000, idempotencyKey: randomUUID() }, { cookie: user.cookie })).status, 201, "le verrou relâché, la création réussit");

  const { intent, dto } = await createIntent(user, 2000);
  const body = eventBody(intent);
  const rowHolder = await holderPool.connect();
  try {
    await rowHolder.query("BEGIN");
    await rowHolder.query("SELECT id FROM payment_intents WHERE id = $1 FOR UPDATE", [dto.id]);
    const { response, elapsed } = await timed(() => webhook(body));
    assert.equal(response.status, 503, "503 : le prestataire pourra rejouer");
    assert.deepEqual(response.json, FIXED_503);
    assert.ok(elapsed >= WALLET_LOCK_TIMEOUT_MS - 500 && elapsed < deadline, `échec après ${elapsed} ms`);
    await rowHolder.query("COMMIT");
  } finally {
    await rowHolder.query("ROLLBACK").catch(() => {});
    rowHolder.release();
  }
  assert.deepEqual(logs.slice(before), ["55P03", "55P03"]);
  assert.equal(await statusOf(dto.id), "pending", "rien d'appliqué pendant le verrou");
  assert.equal(await scalar("SELECT count(*)::int AS n FROM payment_events WHERE intent_id = $1", [dto.id]), "0");
  assert.equal((await webhook(body)).status, 200, "rejoué une fois le verrou relâché");
  assert.equal(await statusOf(dto.id), "succeeded");
  assert.equal(await balanceOf(user), "2000", "un seul crédit");
});

// ═════════════ 9. Routes Next.js ═════════════

test("routes Next.js : exports exacts (méthodes + runtime + dynamic), params asynchrones, gestionnaires par défaut sans base pour les refus précoces", async () => {
  const exportsOf = (route: object): string[] => sorted(Object.keys(route));
  assert.deepEqual(exportsOf(walletRoute), sorted(["GET", "dynamic", "runtime"]));
  assert.deepEqual(exportsOf(topupsRoute), sorted(["POST", "dynamic", "runtime"]));
  assert.deepEqual(exportsOf(topupRoute), sorted(["GET", "dynamic", "runtime"]));
  assert.deepEqual(exportsOf(webhookRoute), sorted(["POST", "dynamic", "runtime"]));
  assert.deepEqual(exportsOf(confirmRoute), sorted(["POST", "dynamic", "runtime"]));
  assert.deepEqual(exportsOf(failRoute), sorted(["POST", "dynamic", "runtime"]));
  for (const route of [walletRoute, topupsRoute, topupRoute, webhookRoute, confirmRoute, failRoute]) {
    assert.equal(route.runtime, "nodejs");
    assert.equal(route.dynamic, "force-dynamic");
  }
  const id = randomUUID();
  const context = { params: Promise.resolve({ id }) };
  const saved = { origin: process.env.NOMA_AUTH_ORIGIN, flag: process.env.NOMA_FAKE_PAYMENTS, secret: process.env.NOMA_FAKE_PAYMENT_SECRET, database: process.env.DATABASE_URL };
  const originalConsoleError = console.error;
  const consoleLines: string[] = [];
  console.error = (...parts: unknown[]) => { consoleLines.push(parts.join(" ")); };
  delete process.env.DATABASE_URL;
  process.env.NOMA_AUTH_ORIGIN = ORIGIN;
  delete process.env.NOMA_FAKE_PAYMENTS;
  delete process.env.NOMA_FAKE_PAYMENT_SECRET;
  try {
    // Prestataire inactif par défaut : routes fictives en 404, sans base.
    assert.equal((await reply(await webhookRoute.POST(webhookRequest("{}")))).status, 404);
    assert.equal((await reply(await confirmRoute.POST(build("POST", `/api/dev/fake-payments/${id}/confirm`, {}), context))).status, 404);
    assert.equal((await reply(await failRoute.POST(build("POST", `/api/dev/fake-payments/${id}/fail`, {}), context))).status, 404);
    // Refus précoces des routes à session : 401 et 403 sans base.
    assert.equal((await reply(await walletRoute.GET(build("GET", "/api/wallet", { cookie: null })))).status, 401);
    assert.equal((await reply(await topupRoute.GET(build("GET", `/api/wallet/topups/${id}`, { cookie: null }), context))).status, 401);
    assert.equal((await reply(await topupsRoute.POST(build("POST", "/api/wallet/topups", { origin: "https://evil.example", body: { amountXof: 1000, idempotencyKey: id } })))).status, 403);
    assert.equal((await reply(await topupsRoute.POST(build("POST", "/api/wallet/topups", { cookie: null, body: { amountXof: 1000, idempotencyKey: id } })))).status, 401);
    // Prestataire actif : une signature invalide est refusée avant toute base.
    process.env.NOMA_FAKE_PAYMENTS = "1";
    process.env.NOMA_FAKE_PAYMENT_SECRET = FAKE_SECRET;
    const refused = await reply(await webhookRoute.POST(webhookRequest("{}", { signature: "0".repeat(64) })));
    assert.equal(refused.status, 400);
    assert.deepEqual(refused.json, { error: { code: "invalid_signature", message: "Signature invalide." } });
    delete process.env.NOMA_AUTH_ORIGIN;
    const unconfigured = await reply(await topupsRoute.POST(build("POST", "/api/wallet/topups", { cookie: null, body: { amountXof: 1000, idempotencyKey: id } })));
    assert.equal(unconfigured.status, 503, "l'origine est relue à chaque requête");
    assert.deepEqual(unconfigured.json, FIXED_503);
    assert.ok(consoleLines.includes("[wallet-http] origin_unconfigured"), "journal par défaut : le code seulement");
    assert.ok(consoleLines.every((line) => /^\[wallet-http\] [A-Za-z0-9_]{1,40}$/.test(line)), JSON.stringify(consoleLines));
  } finally {
    console.error = originalConsoleError;
    for (const [name, value] of [["NOMA_AUTH_ORIGIN", saved.origin], ["NOMA_FAKE_PAYMENTS", saved.flag], ["NOMA_FAKE_PAYMENT_SECRET", saved.secret], ["DATABASE_URL", saved.database]] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

// ═════════════ 10. Parcours complet et cohérence ═════════════

test("parcours complet : POST /topups → GET → confirm → GET /api/wallet → wallet:check vert ; aucune donnée interne ni secret dans aucune réponse du fichier", async () => {
  const zoe = await login();
  const created = await postTopup({ amountXof: 12_300, idempotencyKey: randomUUID() }, { cookie: zoe.cookie });
  assert.equal(created.status, 201);
  const dto = topupOf(created);
  assert.equal(topupOf(await getTopup(dto.id, { cookie: zoe.cookie })).status, "pending");
  assert.equal(asObject((await getWallet("", { cookie: zoe.cookie })).json).balanceXof, 0);
  const confirmed = await confirm(dto.id, { cookie: zoe.cookie });
  assert.equal(topupOf(confirmed).status, "succeeded");
  assert.equal(topupOf(await getTopup(dto.id, { cookie: zoe.cookie })).status, "succeeded");
  const wallet = asObject((await getWallet("", { cookie: zoe.cookie })).json);
  assert.equal(wallet.balanceXof, 12_300);
  assert.deepEqual((wallet.transactions as Array<Record<string, unknown>>).map((item) => [item.kind, item.amountXof]), [["topup", 12_300]]);
  const report = await checkWalletIntegrity(pool);
  assert.deepEqual(report.violations, [], "le grand livre reste cohérent après tout le fichier (dont les concurrences)");
  assert.equal(report.ok, true);

  const secrets = [FAKE_SECRET, "fakepay_", "providerReference", "provider_reference", "idempotencyKey", "idempotency_key", "owner_id", "ownerId", "payload_sha256", "hunter2"];
  for (const text of allTexts) for (const secret of secrets) assert.ok(!text.includes(secret), `« ${secret} » ne doit sortir dans aucune réponse : ${text.slice(0, 120)}`);
  const users = (await pool.query("SELECT id FROM users")).rows.map((row) => row.id as string);
  for (const text of allTexts) for (const user of users) assert.ok(!text.includes(user), "aucun identifiant d'utilisateur ne sort");
});

test("en-têtes : toutes les réponses du fichier portaient Cache-Control: no-store, nosniff et du JSON ; tous les statuts attendus ont été exercés ; le journal ne contient que des codes", () => {
  for (const status of [200, 201, 400, 401, 403, 404, 409, 503]) assert.ok(statusesSeen.has(status), `statut ${status} exercé`);
  assert.ok(logs.every((code) => /^[A-Za-z0-9_]{1,40}$/.test(code)), `le journal ne contient que des codes : ${JSON.stringify(logs.filter((code) => !/^[A-Za-z0-9_]{1,40}$/.test(code)))}`);
  assert.ok(logs.includes("webhook_invalid_signature") && logs.includes("webhook_invalid_event") && logs.includes("provider_inactive"));
});
