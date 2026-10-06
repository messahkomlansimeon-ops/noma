import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { Pool, type PoolConfig } from "pg";
import { requestOtp, revokeSession, SESSION_TTL_MS, verifyOtp, type SendOtpInput } from "../../lib/server/auth";
import { createDemand, createOffer, createUser } from "../../lib/server/catalog";
import type { DemandRecord, OfferRecord } from "../../lib/server/catalog/types";
import { BOOST_PURCHASE_LOCK_NAMESPACE } from "../../lib/server/boost/boost-config";
import { grantOfferBoost } from "../../lib/server/boost/boosts";
import { createBoostHttpHandlers } from "../../lib/server/boost/http";
import { computeScoringConfigHash, normalizeScoringConfig } from "../../lib/server/matching/persistence";
import { MATCHING_SCORING_CONTRACT_VERSION } from "../../lib/server/matching/scoring-types";
import { MATCHING_OFFLINE_CONTRACT_VERSION } from "../../lib/server/matching/types";
import {
  BOOST_PURCHASE_CONTRACT_VERSION, createBoostPurchaseHttpHandlers, type BoostPurchaseHttpDependencies, type BoostPurchaseHttpHandlers,
} from "../../lib/server/boost/purchase-http";
import { refundBoostPurchase } from "../../lib/server/boost/purchase";
import { runMigrations } from "../../lib/server/postgres/migrations";
import { createWalletHttpHandlers } from "../../lib/server/wallet/http";
import { recordWalletTransaction } from "../../lib/server/wallet/ledger";
import { checkWalletIntegrity } from "../../lib/server/wallet/check";
import * as purchasesRoute from "../../app/api/offers/[id]/boost-purchases/route";
import {
  createTemporarySchemaName, openVerifiedIsolatedPool, openVerifiedTestDatabase, quoteTemporarySchema, type DedicatedTestDatabase,
} from "./test-database";
import { EVALUATION_SUMMARY_JSON, PREFERENCES_SUMMARY_JSON, REACHABLE_LIST_SIZE, SCORING_SUMMARY_JSON, addReachableBuyer, slowReachPool } from "./boost-fixtures";

// ───────────── infrastructure ─────────────

class TestClock {
  constructor(private timestamp: number) {}
  readonly now = (): Date => new Date(this.timestamp);
  advance(milliseconds: number): void { this.timestamp += milliseconds; }
}

interface Login { userId: string; token: string; cookie: string }

const SECRET = randomBytes(32);
const ORIGIN = "https://noma.test";
const FIXED_503 = { error: { code: "boost_purchase_unavailable", message: "L'achat de boost est temporairement indisponible." } };
const FIXED_404 = { error: { code: "resource_not_found", message: "Ressource introuvable." } };
const FIXED_400 = { error: { code: "invalid_request", message: "Requête invalide." } };
const schema = createTemporarySchemaName();
const quoted = quoteTemporarySchema(schema);
const clock = new TestClock(Date.UTC(2032, 0, 1, 10));
const logs: string[] = [];
const log = (code: string): void => { logs.push(code); };
const env = { NOMA_AUTH_ORIGIN: ORIGIN };
const RUN_ID = `bph_${process.pid}_${randomBytes(4).toString("hex")}`;
let admin: Pool, pool: Pool;
let target: DedicatedTestDatabase;
let handlers: BoostPurchaseHttpHandlers;
let seller: Login, other: Login;
let phoneSequence = 0;
let ipSequence = 0;
let counter = 0;
const extraPools: Pool[] = [];
const big = (value: number): bigint => BigInt(value);

async function login(): Promise<Login> {
  phoneSequence += 1;
  ipSequence += 1;
  let delivery: SendOtpInput | undefined;
  const requested = await requestOtp(`+22507${phoneSequence.toString().padStart(8, "0")}`, {
    pool, now: clock.now, authSecret: SECRET, requestIp: `198.51.100.${ipSequence}`,
    sendOtp: async (input) => { delivery = input; },
  });
  assert.ok(delivery);
  const verified = await verifyOtp(requested.challengeId, delivery.code, { pool, now: clock.now, authSecret: SECRET });
  return { userId: verified.userId, token: verified.sessionToken, cookie: `noma_auth=${verified.sessionToken}` };
}

before(async () => {
  const opened = await openVerifiedTestDatabase(process.env.TEST_DATABASE_URL);
  admin = opened.pool;
  target = opened.target;
  await admin.query(`CREATE SCHEMA ${quoted}`);
  pool = await openVerifiedIsolatedPool(target, schema, (config: PoolConfig) => new Pool({ ...config, max: 16, application_name: `${RUN_ID}_main` }));
  await runMigrations(pool);
  handlers = createBoostPurchaseHttpHandlers({ pool, now: clock.now, env, log });
  seller = await login();
  other = await login();
});

after(async () => {
  for (const extra of extraPools) await extra.end().catch(() => {});
  if (pool) await pool.end();
  if (admin) {
    await admin.query(`DROP SCHEMA IF EXISTS ${quoted} CASCADE`);
    await admin.end();
  }
});

// ───────────── requêtes et réponses ─────────────

interface CallOptions {
  /** Défaut : la session du vendeur. `null` : aucun cookie. */
  cookie?: string | null;
  /** Défaut : l'origine configurée. `null` : aucun en-tête Origin. */
  origin?: string | null;
  body?: unknown;
  /** Corps brut (prioritaire sur `body`). */
  raw?: string;
  contentType?: string | null;
  handlers?: BoostPurchaseHttpHandlers;
}

function build(method: "GET" | "POST", path: string, options: CallOptions): Request {
  const headers: Record<string, string> = {};
  const cookie = options.cookie === undefined ? seller.cookie : options.cookie;
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

/** Chaque réponse du fichier passe ici : no-store, nosniff et JSON sont donc vérifiés sur TOUTES. */
async function reply(response: Response): Promise<Reply> {
  const text = await response.text();
  assert.equal(response.headers.get("cache-control"), "no-store", `Cache-Control sur ${response.status}`);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff", `nosniff sur ${response.status}`);
  assert.match(response.headers.get("content-type") ?? "", /^application\/json/, `content-type sur ${response.status}`);
  return { status: response.status, text, json: JSON.parse(text), headers: [...response.headers.entries()].sort() };
}

const post = async (offerId: string, options: CallOptions = {}): Promise<Reply> =>
  reply(await (options.handlers ?? handlers).purchases.create(build("POST", `/api/offers/${offerId}/boost-purchases`, options), offerId));
const list = async (offerId: string, query = "", options: CallOptions = {}): Promise<Reply> =>
  reply(await (options.handlers ?? handlers).purchases.list(build("GET", `/api/offers/${offerId}/boost-purchases${query}`, options), offerId));

const asObject = (value: unknown): Record<string, unknown> => value as Record<string, unknown>;
const keys = (value: unknown): string[] => Object.keys(value as object).sort();
const errorOf = (reply: Reply): { code: string; message: string } => (asObject(reply.json).error as { code: string; message: string });
const padded = (json: string, total: number): string => json + " ".repeat(total - Buffer.byteLength(json));

// ───────────── données ─────────────

interface Scope { category: string; brand: string; model: string }
const makeScope = (): Scope => { counter += 1; return { category: `cat${counter}x${randomBytes(2).toString("hex")}`, brand: "acme", model: `m${counter}` }; };

async function makeOffer(input: { ownerId?: string; scope?: Scope; status?: "published" | "paused" | "draft"; model?: string | null } = {}): Promise<OfferRecord> {
  counter += 1;
  const scope = input.scope ?? makeScope();
  return createOffer({
    ownerId: input.ownerId ?? (await createUser({}, pool)).id,
    rawText: `RAW_SECRET_TEXT offre ${counter}`,
    category: scope.category, brand: scope.brand, model: input.model === undefined ? scope.model : input.model,
    price: { amount: 100_000 + counter, currency: "XOF" },
    status: input.status ?? "published", availabilityStatus: "available",
  }, pool);
}

const HASH = computeScoringConfigHash(normalizeScoringConfig());

/**
 * Offres « remplissage » : d'autres offres (autre périmètre : aucun effet sur les places, les vendeurs concurrents ni le prix) qui complètent la liste
 * de l'acheteur à 7 offres. Sans elles, le quota de places promues est nul et la cotation réelle est `no_visible_effect` (lot P2-bis).
 */
const fillerOffers: OfferRecord[] = [];
async function fillersFor(count: number): Promise<OfferRecord[]> {
  const owner = fillerOffers[0]?.ownerId ?? (await createUser({}, pool)).id;
  while (fillerOffers.length < count) fillerOffers.push(await makeOffer({ ownerId: owner }));
  return fillerOffers.slice(0, count);
}

async function evaluate(offer: OfferRecord, demand: DemandRecord, score: number): Promise<void> {
  await pool.query(
    `INSERT INTO matching_evaluations (
       idempotency_key, attempt_hash, offer_id, demand_id, offer_owner_id, demand_owner_id,
       offer_content_version, demand_content_version, engine_offline_version, engine_scoring_version,
       scoring_config_hash, scoring_config, evaluated_at, expires_at, eligibility_status, eligibility_reasons,
       compatibility_status, score, coverage, evaluation_summary, scoring_summary, preferences_summary,
       evaluation_details, is_latest, is_stale, stale_reason, staled_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, '{}'::jsonb, clock_timestamp(), NULL, 'eligible', '{}',
       'compatible', $12::numeric, 80, '${EVALUATION_SUMMARY_JSON}'::jsonb, '${SCORING_SUMMARY_JSON}'::jsonb, '${PREFERENCES_SUMMARY_JSON}'::jsonb, '{"criteria":[]}'::jsonb, TRUE, FALSE, NULL, NULL)`,
    [
      randomUUID(), `ATTEMPT_${randomUUID()}`, offer.id, demand.id, offer.ownerId, demand.ownerId, offer.contentVersion, demand.contentVersion,
      MATCHING_OFFLINE_CONTRACT_VERSION, MATCHING_SCORING_CONTRACT_VERSION, HASH, score,
    ],
  );
}

/** Un acheteur distinct avec une demande active, une évaluation confirmée et fraîche sur l'offre, et une liste de 7 offres (cotation réelle possible, le boost ferait monter l'offre). */
async function addBuyer(offer: OfferRecord): Promise<void> {
  const buyerId = (await createUser({}, pool)).id;
  const demand: DemandRecord = await createDemand({
    ownerId: buyerId, rawText: "RAW_SECRET_TEXT demande", category: offer.category, brand: offer.brand, model: offer.model, status: "active",
  }, pool);
  await evaluate(offer, demand, 90);
  for (const filler of await fillersFor(REACHABLE_LIST_SIZE - 1)) await evaluate(filler, demand, 100);
}

/** Borne une promesse : au-delà de `ms`, le test échoue vite (au lieu de pendre) ; la promesse en cours est laissée finir. */
function bounded<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([promise, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${label} : aucune réponse après ${ms} ms (lock_timeout absent ?)`)), ms))]);
}

/** L'achat REVÉRIFIE la portée du boost (lot P3) : chaque offre dont on insère une cotation a un acheteur dont la liste la ferait monter (une fois par offre). */
const reachableOffers = new Set<string>();

async function insertQuote(offer: OfferRecord, options: { amount?: number; status?: "available" | "unavailable"; expiresInSeconds?: number; sellerId?: string; durationCode?: "24h" | "3d" | "7d"; reachable?: boolean } = {}): Promise<string> {
  const id = randomUUID();
  if (options.reachable !== false && !reachableOffers.has(offer.id)) {
    reachableOffers.add(offer.id);
    await addReachableBuyer(pool, offer);
  }
  const available = (options.status ?? "available") === "available";
  await pool.query(
    `INSERT INTO boost_quotes (
       id, offer_id, seller_id, scope_category, scope_brand, scope_model, duration_code, pricing_key, pricing_version, currency,
       status, unavailable_reason, amount, raw_amount, competition_milli, demand_milli, scarcity_milli, duration_milli,
       competing_sellers, compatible_buyers, slots_total, slots_used, computed_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'default', 1, 'XOF', $8, $9, $10, $11, $12, $13, $14, $15, 1, 1, 1, 0,
       clock_timestamp() - make_interval(secs => 7200), clock_timestamp() + make_interval(secs => $16::int))`,
    [
      id, offer.id, options.sellerId ?? offer.ownerId, offer.category!.toLowerCase(), offer.brand!.toLowerCase(), offer.model!.toLowerCase(), options.durationCode ?? "24h",
      available ? "available" : "unavailable", available ? null : "no_compatible_buyer", available ? (options.amount ?? 2300) : null, available ? String(options.amount ?? 2300) : null,
      available ? 1000 : null, available ? 1000 : null, available ? 1000 : null, available ? 1000 : null, options.expiresInSeconds ?? 900,
    ],
  );
  return id;
}

async function fund(userId: string, amount: number): Promise<void> {
  await recordWalletTransaction(pool, {
    kind: "adjustment", reference: `adjustment:fund-${randomUUID()}`, metadata: { reasonCode: "test_fixture" },
    entries: [{ account: { kind: "boost_revenue" }, amount: -big(amount) }, { account: { kind: "user", ownerId: userId }, amount: big(amount) }],
  });
}

const scalar = async <T = string>(text: string, values: unknown[] = []): Promise<T> => (await pool.query(text, values)).rows[0].n as T;
const count = async (table: string, where = "TRUE", values: unknown[] = []): Promise<number> => Number(await scalar(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`, values));
const balanceOf = async (userId: string): Promise<number> => Number(await scalar("SELECT COALESCE((SELECT balance FROM wallet_accounts WHERE kind = 'user' AND owner_id = $1), 0)::text AS n", [userId]));

interface World { offer: OfferRecord; quoteId: string; scope: Scope }

/** Une offre du vendeur connecté (session `seller`), créditée, avec une cotation disponible. */
async function world(options: { credit?: number; amount?: number; owner?: Login } = {}): Promise<World> {
  const owner = options.owner ?? seller;
  const scope = makeScope();
  const offer = await makeOffer({ ownerId: owner.userId, scope });
  if ((options.credit ?? 10_000) > 0) await fund(owner.userId, options.credit ?? 10_000);
  return { offer, quoteId: await insertQuote(offer, { amount: options.amount }), scope };
}

async function snapshot(): Promise<Record<string, string>> {
  return (await pool.query<Record<string, string>>(
    `SELECT (SELECT count(*) FROM wallet_transactions)::text AS transactions, (SELECT count(*) FROM wallet_entries)::text AS entries,
            (SELECT COALESCE(sum(balance), 0) FROM wallet_accounts)::text AS balances, (SELECT count(*) FROM offer_boosts)::text AS boosts,
            (SELECT count(*) FROM boost_purchases)::text AS purchases, (SELECT count(*) FROM wallet_accounts)::text AS accounts`)).rows[0];
}

const bodyFor = (w: { quoteId: string }, over: Record<string, unknown> = {}) => ({ quoteId: w.quoteId, idempotencyKey: randomUUID(), ...over });

// ═════════════ 1. Authentification ═════════════

test("authentification : 401 sans cookie, cookie invalide ou double, session révoquée, expirée, compte suspendu (GET et POST) ; la session est vérifiée avant l'identifiant", async () => {
  const w = await world();
  const checks: Array<[string, CallOptions]> = [
    ["sans cookie", { cookie: null }],
    ["cookie invalide", { cookie: "noma_auth=invalide" }],
    ["deux cookies de session", { cookie: `${seller.cookie}; ${seller.cookie}` }],
    ["cookie d'un autre nom", { cookie: `autre=${seller.token}` }],
  ];
  const revoked = await login();
  await revokeSession(revoked.token, { pool, now: clock.now });
  checks.push(["session révoquée", { cookie: revoked.cookie }]);
  const suspended = await login();
  await pool.query("UPDATE users SET status = 'suspended' WHERE id = $1", [suspended.userId]);
  checks.push(["compte suspendu", { cookie: suspended.cookie }]);
  // Session expirée : une horloge propre à ces gestionnaires, pour ne pas vieillir les autres sessions du fichier.
  const expiring = await login();
  const lateClock = new TestClock(clock.now().getTime());
  const lateHandlers = createBoostPurchaseHttpHandlers({ pool, now: lateClock.now, env, log });
  assert.equal((await list(w.offer.id, "", { cookie: expiring.cookie, handlers: lateHandlers })).status, 404, "valide avant expiration (offre d'autrui : 404)");
  lateClock.advance(SESSION_TTL_MS + 1);
  checks.push(["session expirée", { cookie: expiring.cookie, handlers: lateHandlers }]);

  const before = await snapshot();
  for (const [label, options] of checks) {
    const posted = await post(w.offer.id, { ...options, body: bodyFor(w) });
    assert.equal(posted.status, 401, `POST ${label}`);
    assert.deepEqual(posted.json, { error: { code: "authentication_required", message: "Authentification requise." } }, `POST ${label}`);
    const listed = await list(w.offer.id, "", options);
    assert.equal(listed.status, 401, `GET ${label}`);
    assert.deepEqual(listed.json, { error: { code: "authentication_required", message: "Authentification requise." } }, `GET ${label}`);
  }
  assert.deepEqual(await snapshot(), before, "aucun achat par une requête non authentifiée");
  assert.equal((await post("pas-un-uuid", { cookie: null, body: bodyFor(w) })).status, 401);
  assert.equal((await list("pas-un-uuid", "", { cookie: null })).status, 401);
});

// ═════════════ 2. Origine (POST) ═════════════

test("POST : NOMA_AUTH_ORIGIN absente ou invalide → 503 ; origine absente, étrangère ou mal formée → 403 ; l'origine est contrôlée AVANT la session (aucune résolution de session, aucune requête SQL)", async () => {
  const w = await world();
  const body = bodyFor(w);
  logs.length = 0;
  for (const value of [undefined, "", "   ", "pas une url", "ftp://noma.test", "https://noma.test/chemin"]) {
    const unconfigured = createBoostPurchaseHttpHandlers({ pool, now: clock.now, env: value === undefined ? {} : { NOMA_AUTH_ORIGIN: value }, log });
    assert.equal((await post(w.offer.id, { body, handlers: unconfigured })).status, 503, `origine configurée = ${JSON.stringify(value)}`);
    const withoutSession = await post(w.offer.id, { body, cookie: null, handlers: unconfigured });
    assert.equal(withoutSession.status, 503, "origine non configurée avant la session");
    assert.deepEqual(withoutSession.json, FIXED_503);
  }
  assert.ok(logs.length > 0 && logs.every((code) => code === "origin_unconfigured"), `journal : ${JSON.stringify(logs)}`);

  // Preuve par espion : une origine refusée n'atteint ni la résolution de session ni la base.
  let sessionCalls = 0;
  let queries = 0;
  const spyPool = Object.create(pool) as Pool;
  spyPool.query = ((...args: unknown[]) => { queries++; return (pool.query as (...a: unknown[]) => unknown)(...args); }) as never;
  spyPool.connect = ((...args: unknown[]) => { queries++; return (pool.connect as (...a: unknown[]) => unknown)(...args); }) as never;
  const spied = createBoostPurchaseHttpHandlers({
    pool: spyPool, now: clock.now, env, log,
    resolveSession: async () => { sessionCalls++; return null; },
  });
  const refused: Array<[string, string | null]> = [
    ["absente", null], ["étrangère", "https://evil.example"], ["sous-domaine", "https://sub.noma.test"], ["autre schéma", "http://noma.test"],
    ["autre port", "https://noma.test:8443"], ["avec barre finale", `${ORIGIN}/`], ["avec chemin", `${ORIGIN}/x`], ["null", "null"], ["vide", ""], ["illisible", "pas une url"],
  ];
  const stateBefore = await snapshot();
  for (const [label, origin] of refused) {
    for (const [sessionLabel, cookie] of [["avec session", seller.cookie], ["sans session", null], ["session invalide", "noma_auth=invalide"]] as const) {
      const response = await post(w.offer.id, { origin, cookie, body, handlers: spied });
      assert.equal(response.status, 403, `origine ${label}, ${sessionLabel}`);
      assert.deepEqual(response.json, { error: { code: "invalid_origin", message: "Origine de la requête non autorisée." } });
    }
  }
  assert.equal(sessionCalls, 0, "la session n'est jamais résolue pour une origine refusée");
  assert.equal(queries, 0, "aucune requête SQL pour une origine refusée");
  assert.deepEqual(await snapshot(), stateBefore, "aucune origine refusée n'achète");
  // Origine valide : on passe à la session, puis à l'achat. Le GET ne dépend pas de l'origine.
  assert.equal((await post(w.offer.id, { cookie: null, body })).status, 401);
  assert.equal((await post(w.offer.id, { body })).status, 201);
  assert.equal((await list(w.offer.id, "", { origin: "https://evil.example" })).status, 200);
});

// ═════════════ 3. 404 sans fuite d'existence ═════════════

test("404 : offre inexistante, offre d'autrui, cotation inexistante, d'une autre offre ou d'un autre vendeur → réponses identiques octet pour octet ; rien d'écrit", async () => {
  const mine = await world();
  const foreign = await world({ owner: other });
  const mineSibling = await makeOffer({ ownerId: seller.userId });
  const siblingQuote = await insertQuote(mineSibling);
  // Cotation fabriquée au nom du vendeur sur l'offre d'autrui, offre d'autrui en pause : jamais un 409.
  const foreignPaused = await makeOffer({ ownerId: other.userId, status: "paused" });
  const forged = await insertQuote(foreign.offer, { sellerId: seller.userId });

  const before = await snapshot();
  const reference = await post(randomUUID(), { body: bodyFor(mine) });
  assert.equal(reference.status, 404);
  assert.deepEqual(reference.json, FIXED_404);
  const attempts: Array<[string, string, string]> = [
    ["offre d'autrui avec sa cotation", foreign.offer.id, foreign.quoteId],
    ["offre d'autrui en pause", foreignPaused.id, randomUUID()],
    ["cotation inexistante", mine.offer.id, randomUUID()],
    ["cotation d'une autre offre du même vendeur", mine.offer.id, siblingQuote],
    ["cotation d'un autre vendeur", mine.offer.id, foreign.quoteId],
    ["cotation au nom du vendeur sur l'offre d'autrui", foreign.offer.id, forged],
  ];
  for (const [label, offerId, quoteId] of attempts) {
    const response = await post(offerId, { body: bodyFor({ quoteId }) });
    assert.equal(response.status, 404, label);
    assert.equal(response.text, reference.text, `${label} : corps identique`);
    assert.deepEqual(response.headers, reference.headers, `${label} : en-têtes identiques`);
  }
  // GET : offre inexistante et offre d'autrui, mêmes octets.
  const missingGet = await list(randomUUID());
  assert.equal(missingGet.status, 404);
  for (const target of [foreign.offer, foreignPaused]) {
    const foreignGet = await list(target.id);
    assert.equal(foreignGet.text, missingGet.text, "GET : corps identique");
    assert.deepEqual(foreignGet.headers, missingGet.headers, "GET : en-têtes identiques");
  }
  assert.equal(missingGet.text, reference.text, "même corps pour POST et GET");
  assert.deepEqual(await snapshot(), before, "rien n'a été écrit");
});

// ═════════════ 4. 400 ═════════════

test("400 : identifiant invalide, corps invalide (POST, JSON strict) et paramètres invalides (GET) ; rien d'écrit ; les limites sont acceptées", async () => {
  const w = await world();
  for (const id of ["pas-un-uuid", "", "123", `${randomUUID()}x`, randomUUID().replace(/-/g, "")]) {
    const posted = await post(id, { body: bodyFor(w) });
    assert.equal(posted.status, 400, `POST id=${JSON.stringify(id)}`);
    assert.deepEqual(posted.json, FIXED_400);
    assert.equal((await list(id)).status, 400, `GET id=${JSON.stringify(id)}`);
  }
  const quoteId = w.quoteId;
  const key = randomUUID();
  const good = JSON.stringify({ quoteId, idempotencyKey: key });
  const bad: Array<[string, CallOptions]> = [
    ["non JSON", { raw: "{oops" }], ["corps vide", { raw: "" }], ["tableau", { raw: "[]" }], ["tableau contenant l'objet", { raw: `[${good}]` }],
    ["null", { raw: "null" }], ["chaîne", { raw: '"x"' }], ["nombre", { raw: "12" }], ["objet vide", { body: {} }],
    ["quoteId absent", { body: { idempotencyKey: key } }], ["idempotencyKey absente", { body: { quoteId } }],
    ["clé en plus", { body: { quoteId, idempotencyKey: key, extra: 1 } }], ["offerId en plus", { body: { quoteId, idempotencyKey: key, offerId: w.offer.id } }],
    ["amountXof en plus (le prix ne vient jamais du client)", { body: { quoteId, idempotencyKey: key, amountXof: 1 } }],
    ["durationCode en plus", { body: { quoteId, idempotencyKey: key, durationCode: "24h" } }],
    ["quoteId non UUID", { body: { quoteId: "pas-un-uuid", idempotencyKey: key } }], ["idempotencyKey non UUID", { body: { quoteId, idempotencyKey: "x" } }],
    ["quoteId nombre", { body: { quoteId: 12, idempotencyKey: key } }], ["idempotencyKey null", { body: { quoteId, idempotencyKey: null } }],
    ["quoteId tableau", { body: { quoteId: [quoteId], idempotencyKey: key } }], ["quoteId objet", { body: { quoteId: { id: quoteId }, idempotencyKey: key } }],
    ["idempotencyKey vide", { body: { quoteId, idempotencyKey: "" } }], ["quoteId avec espace", { body: { quoteId: ` ${quoteId}`, idempotencyKey: key } }],
    ["content-type texte", { raw: good, contentType: "text/plain" }], ["sans content-type", { raw: good, contentType: null }],
    ["content-type formulaire", { raw: `quoteId=${quoteId}`, contentType: "application/x-www-form-urlencoded" }],
    ["corps valide un octet au-dessus du plafond de 2 Kio", { raw: padded(good, 2049) }],
    ["corps valide très au-dessus du plafond", { raw: padded(good, 100_000) }],
  ];
  const before = await snapshot();
  for (const [label, options] of bad) {
    const response = await post(w.offer.id, options);
    assert.equal(response.status, 400, `corps : ${label}`);
    assert.deepEqual(response.json, FIXED_400, `corps : ${label}`);
  }
  assert.deepEqual(await snapshot(), before, "aucun corps invalide n'achète");

  // JSON piégé : un lecteur tolérant (JSON.parse) accepterait ces corps, le lecteur strict les refuse TOUS.
  const trapped: Array<[string, string]> = [
    ["clé en double (quoteId)", `{"quoteId":"${randomUUID()}","quoteId":"${quoteId}","idempotencyKey":"${key}"}`],
    ["clé en double (idempotencyKey)", `{"quoteId":"${quoteId}","idempotencyKey":"${randomUUID()}","idempotencyKey":"${key}"}`],
    ["__proto__", `{"quoteId":"${quoteId}","idempotencyKey":"${key}","__proto__":{"x":1}}`],
    ["__proto__ échappé", `{"quoteId":"${quoteId}","idempotencyKey":"${key}","\\u005f\\u005fproto\\u005f\\u005f":{}}`],
    ["contenu après l'objet", `${good} {}`], ["deux objets", `${good}${good}`],
    ["nombre non entier en plus", `{"quoteId":"${quoteId}","idempotencyKey":"${key}","n":1.5}`], ["exposant", `{"quoteId":"${quoteId}","idempotencyKey":"${key}","n":1e3}`],
    ["entier au-delà de 2^53 - 1", `{"quoteId":"${quoteId}","idempotencyKey":"${key}","n":9007199254740993}`],
    ["profondeur excessive", `{"quoteId":"${quoteId}","idempotencyKey":"${key}","d":${"[".repeat(20)}${"]".repeat(20)}}`],
    ["commentaire", `{"quoteId":"${quoteId}",/*x*/"idempotencyKey":"${key}"}`], ["virgule finale", `{"quoteId":"${quoteId}","idempotencyKey":"${key}",}`],
  ];
  for (const [label, raw] of trapped) {
    const response = await post(w.offer.id, { raw });
    assert.equal(response.status, 400, `JSON piégé : ${label}`);
    assert.deepEqual(response.json, FIXED_400, `JSON piégé : ${label}`);
  }
  assert.deepEqual(await snapshot(), before, "aucun JSON piégé n'achète");
  // Un octet UTF-8 invalide (corps binaire) est refusé.
  const binary = new Request(`${ORIGIN}/api/offers/${w.offer.id}/boost-purchases`, {
    method: "POST", headers: { cookie: seller.cookie, origin: ORIGIN, "content-type": "application/json" }, body: new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]),
  });
  assert.equal((await reply(await handlers.purchases.create(binary, w.offer.id))).status, 400);
  // Un corps de EXACTEMENT 2 048 octets passe la lecture (il est valide), l'achat a lieu.
  const exact = await post(w.offer.id, { raw: padded(good, 2048) });
  assert.equal(exact.status, 201, JSON.stringify(exact.json));
  assert.deepEqual(await snapshot(), { ...before, transactions: String(Number(before.transactions) + 1), entries: String(Number(before.entries) + 2), boosts: String(Number(before.boosts) + 1), purchases: String(Number(before.purchases) + 1), accounts: before.accounts, balances: before.balances });

  const badQueries = [
    "?foo=1", "?limit=1&foo=2", "?cursor=abc", "?Limit=5", "?offset=1", "?limit=1&limit=2", "?limit=1&limit=1",
    "?limit=0", "?limit=51", "?limit=-1", "?limit=1.5", "?limit=abc", "?limit=", "?limit=%20", "?limit=1e1", "?limit=%2B5", "?limit=0x10", "?limit=99999999999999999999", "?limit=5%20",
  ];
  for (const query of badQueries) {
    const response = await list(w.offer.id, query);
    assert.equal(response.status, 400, `GET ${query}`);
    assert.deepEqual(response.json, FIXED_400, `GET ${query}`);
  }
  for (const query of ["?limit=1", "?limit=50", "?limit=20", ""]) assert.equal((await list(w.offer.id, query)).status, 200, `GET ${query || "(sans paramètre)"}`);
});

// ═════════════ 5. 201 puis 200 ═════════════

test("201 à l'achat (DTO exact, montants entiers, aucune fuite), 200 au rejeu de la même requête (mêmes valeurs, reused true, aucun second débit) ; l'historique et le portefeuille suivent", async () => {
  const w = await world({ credit: 10_000, amount: 2300 });
  const request = bodyFor(w);
  const before = await balanceOf(seller.userId);
  const created = await post(w.offer.id, { body: request });
  assert.equal(created.status, 201, created.text);
  assert.deepEqual(keys(created.json), ["balanceXof", "contractVersion", "purchase"]);
  const body = created.json as { contractVersion: string; purchase: Record<string, unknown>; balanceXof: number };
  assert.equal(body.contractVersion, BOOST_PURCHASE_CONTRACT_VERSION);
  assert.deepEqual(keys(body.purchase), ["amountXof", "durationCode", "endsAt", "id", "quoteId", "reused", "startsAt"]);
  assert.match(String(body.purchase.id), /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(body.purchase.quoteId, w.quoteId);
  assert.equal(body.purchase.durationCode, "24h");
  assert.equal(body.purchase.amountXof, 2300);
  assert.ok(Number.isInteger(body.purchase.amountXof) && Number.isInteger(body.balanceXof));
  assert.equal(body.purchase.reused, false);
  assert.equal(body.balanceXof, before - 2300);
  assert.match(String(body.purchase.startsAt), /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
  assert.equal(new Date(String(body.purchase.endsAt)).getTime() - new Date(String(body.purchase.startsAt)).getTime(), 86_400_000);

  // Aucune fuite : ni identifiant de boost, de transaction, de vendeur, d'offre, de clé d'idempotence, ni texte d'annonce ou périmètre.
  const row = (await pool.query<{ boost_id: string; transaction_id: string }>("SELECT boost_id, transaction_id FROM boost_purchases WHERE id = $1", [body.purchase.id])).rows[0];
  for (const secret of [row.boost_id, row.transaction_id, seller.userId, w.offer.id, request.idempotencyKey, "RAW_SECRET_TEXT", w.scope.category, "acme", "boost_revenue", "wallet"]) {
    assert.ok(!created.text.includes(secret), `fuite « ${secret} » dans la réponse`);
  }
  const stored = (await pool.query("SELECT source, status, duration_code FROM offer_boosts WHERE id = $1", [row.boost_id])).rows[0];
  assert.deepEqual(stored, { source: "purchase", status: "active", duration_code: "24h" });

  // Rejeu : 200, même achat, mêmes dates, même solde, reused true.
  const replay = await post(w.offer.id, { body: request });
  assert.equal(replay.status, 200);
  const again = replay.json as typeof body;
  assert.deepEqual(again.purchase, { ...body.purchase, reused: true });
  assert.equal(again.balanceXof, body.balanceXof);
  assert.equal(await balanceOf(seller.userId), before - 2300, "un seul débit");
  // Le rejeu avec la clé en majuscules est le même achat.
  const upper = await post(w.offer.id, { body: { quoteId: w.quoteId.toUpperCase(), idempotencyKey: request.idempotencyKey.toUpperCase() } });
  assert.equal(upper.status, 200);
  assert.equal(((upper.json as typeof body).purchase).id, body.purchase.id);

  // Historique : de CETTE offre, liste blanche stricte, plus récent d'abord.
  const history = await list(w.offer.id);
  assert.equal(history.status, 200);
  assert.deepEqual(keys(history.json), ["contractVersion", "purchases"]);
  const purchases = (history.json as { purchases: Array<Record<string, unknown>> }).purchases;
  assert.equal(purchases.length, 1);
  assert.deepEqual(keys(purchases[0]), ["amountXof", "createdAt", "durationCode", "endsAt", "id", "quoteId", "refundedAt", "startsAt"]);
  assert.equal(purchases[0].id, body.purchase.id);
  assert.equal(purchases[0].refundedAt, null);
  for (const secret of [row.boost_id, row.transaction_id, seller.userId, w.offer.id, request.idempotencyKey, "RAW_SECRET_TEXT"]) assert.ok(!history.text.includes(secret), `fuite « ${secret} » dans l'historique`);

  // Portefeuille : le débit apparaît, signé côté utilisateur ; puis le remboursement d'administration (crédit).
  const wallet = createWalletHttpHandlers({ pool, now: clock.now, env, log });
  const walletReply = async () => reply(await wallet.wallet.get(build("GET", "/api/wallet", {})));
  const first = await walletReply();
  assert.equal(first.status, 200);
  const transactions = (first.json as { transactions: Array<{ kind: string; amountXof: number }> }).transactions;
  assert.deepEqual([transactions[0].kind, transactions[0].amountXof], ["boost_purchase", -2300]);
  assert.equal((first.json as { balanceXof: number }).balanceXof, before - 2300);
  await refundBoostPurchase({ pool, purchaseId: String(body.purchase.id), reasonCode: "customer_request" });
  const second = await walletReply();
  const afterRefund = (second.json as { transactions: Array<{ kind: string; amountXof: number }> }).transactions;
  assert.deepEqual([afterRefund[0].kind, afterRefund[0].amountXof], ["boost_refund", 2300]);
  assert.deepEqual(keys(afterRefund[0]), ["amountXof", "createdAt", "id", "kind"], "DTO du portefeuille inchangé : aucune métadonnée, aucune référence");
  const replayAfterRefund = await post(w.offer.id, { body: request });
  assert.equal(replayAfterRefund.status, 200, "le rejeu d'un achat remboursé renvoie l'achat");
  const historyAfter = (await list(w.offer.id)).json as { purchases: Array<Record<string, unknown>> };
  assert.match(String(historyAfter.purchases[0].refundedAt), /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
});

test("historique : plus récents d'abord, limite respectée, achats d'une AUTRE offre du vendeur absents", async () => {
  const sellerOffer = await makeOffer({ ownerId: seller.userId });
  await fund(seller.userId, 50_000);
  const bought: string[] = [];
  for (let index = 0; index < 3; index++) {
    // Un boost par achat sur une même offre : on rembourse (annulation) entre deux achats pour libérer l'offre.
    const quoteId = await insertQuote(sellerOffer, { amount: 1000 + index * 100 });
    const response = await post(sellerOffer.id, { body: { quoteId, idempotencyKey: randomUUID() } });
    assert.equal(response.status, 201, response.text);
    const id = String(asObject(asObject(response.json).purchase).id);
    bought.push(id);
    await refundBoostPurchase({ pool, purchaseId: id, reasonCode: "history_test" });
  }
  const unrelated = await world();
  assert.equal((await post(unrelated.offer.id, { body: bodyFor(unrelated) })).status, 201);
  const all = (await list(sellerOffer.id)).json as { purchases: Array<{ id: string; amountXof: number }> };
  assert.deepEqual(all.purchases.map((entry) => entry.id), [...bought].reverse(), "plus récent d'abord, achats de l'autre offre absents");
  assert.deepEqual(all.purchases.map((entry) => entry.amountXof), [1200, 1100, 1000]);
  const limited = (await list(sellerOffer.id, "?limit=2")).json as { purchases: Array<{ id: string }> };
  assert.deepEqual(limited.purchases.map((entry) => entry.id), [bought[2], bought[1]]);
  // Une offre sans achat : liste vide.
  const empty = await makeOffer({ ownerId: seller.userId });
  assert.deepEqual((await list(empty.id)).json, { contractVersion: BOOST_PURCHASE_CONTRACT_VERSION, purchases: [] });
});

// ═════════════ 6. 409 ═════════════

async function conflict(label: string, offerId: string, body: unknown, code: string, message: string, cookie?: string): Promise<void> {
  const before = await snapshot();
  const response = await post(offerId, { body, ...(cookie ? { cookie } : {}) });
  assert.equal(response.status, 409, `${label} : ${response.text}`);
  assert.deepEqual(response.json, { error: { code, message } }, label);
  assert.deepEqual(await snapshot(), before, `${label} : rien n'est écrit`);
}

test("409 : chaque refus de règle a son code et son message fixes (quote_expired, quote_unavailable, quote_already_used, offer_not_eligible, offer_already_boosted, no_slot_available, seller_boost_limit_reached, insufficient_balance, idempotency_conflict) ; rien d'écrit", async () => {
  const w = await world({ credit: 50_000 });
  const expired = await insertQuote(w.offer);
  await pool.query("UPDATE boost_quotes SET computed_at = clock_timestamp() - interval '2 hours', expires_at = clock_timestamp() - interval '1 hour' WHERE id = $1", [expired]);
  await conflict("cotation échue", w.offer.id, bodyFor({ quoteId: expired }), "quote_expired", "Cette cotation a expiré : demandez-en une nouvelle.");
  const unavailable = await insertQuote(w.offer, { status: "unavailable" });
  await conflict("cotation indisponible", w.offer.id, bodyFor({ quoteId: unavailable }), "quote_unavailable", "Cette cotation est indisponible : aucun prix n'a été établi.");

  // idempotency_conflict et quote_already_used, après un achat réussi.
  const key = randomUUID();
  const first = await post(w.offer.id, { body: { quoteId: w.quoteId, idempotencyKey: key } });
  assert.equal(first.status, 201);
  const second = await insertQuote(w.offer);
  await conflict("même clé, autre cotation", w.offer.id, { quoteId: second, idempotencyKey: key }, "idempotency_conflict", "Cette clé d'idempotence a déjà servi pour un autre achat.");
  const sibling = await makeOffer({ ownerId: seller.userId });
  await conflict("même clé, MÊME cotation, autre offre du vendeur", sibling.id, { quoteId: w.quoteId, idempotencyKey: key }, "idempotency_conflict", "Cette clé d'idempotence a déjà servi pour un autre achat.");
  await conflict("cotation déjà achetée (autre clé)", w.offer.id, bodyFor({ quoteId: w.quoteId }), "quote_already_used", "Cette cotation a déjà été achetée.");
  await conflict("offre déjà boostée par achat (autre cotation, autre clé)", w.offer.id, bodyFor({ quoteId: second }), "offer_already_boosted", "Cette offre a déjà un boost actif.");

  // Offre non éligible : en pause ; et clé produit effacée (offer_not_boostable côté domaine → offer_not_eligible côté HTTP).
  const paused = await world();
  await pool.query("UPDATE offers SET status = 'paused' WHERE id = $1", [paused.offer.id]);
  await conflict("offre en pause", paused.offer.id, bodyFor(paused), "offer_not_eligible", "Cette offre n'est pas éligible au boost.");
  const blank = await world();
  await pool.query("UPDATE offers SET model = '  ' WHERE id = $1", [blank.offer.id]);
  await conflict("clé produit effacée", blank.offer.id, bodyFor(blank), "offer_not_eligible", "Cette offre n'est pas éligible au boost.");

  // Plus de place : 2 offres dans le périmètre → 1 place, prise par un autre vendeur ; plafond vendeur : réglage de la catégorie.
  const scope = makeScope();
  const mineFull = await makeOffer({ ownerId: seller.userId, scope });
  const rival = await makeOffer({ scope });
  await grantOfferBoost({ pool, offerId: rival.id, ownerId: rival.ownerId, durationCode: "24h", source: "admin_grant" });
  await conflict("plus aucune place", mineFull.id, bodyFor({ quoteId: await insertQuote(mineFull) }), "no_slot_available", "Aucune place de boost disponible dans ce périmètre.");
  const limitedScope = makeScope();
  await pool.query(
    `INSERT INTO boost_settings (key, slot_ratio, min_slots, max_slots, max_active_per_seller, max_seller_slot_share, max_promoted_share, min_relevance)
     VALUES ($1, 0.5, 10, 20, 1, 1, 0.15, 60)`, [limitedScope.category]);
  try {
    const one = await makeOffer({ ownerId: seller.userId, scope: limitedScope });
    const two = await makeOffer({ ownerId: seller.userId, scope: limitedScope });
    assert.equal((await post(one.id, { body: bodyFor({ quoteId: await insertQuote(one) }) })).status, 201);
    await conflict("plafond de boosts du vendeur", two.id, bodyFor({ quoteId: await insertQuote(two) }), "seller_boost_limit_reached", "Le plafond de boosts de ce vendeur dans ce périmètre est atteint.");
  } finally {
    await pool.query("DELETE FROM boost_settings WHERE key = $1", [limitedScope.category]);
  }

  // Solde insuffisant : aucun crédit, puis un XOF de moins que le prix.
  const brokeUser = await login();
  const poor = await world({ owner: brokeUser, credit: 0 });
  await conflict("aucun crédit", poor.offer.id, bodyFor(poor), "insufficient_balance", "Solde insuffisant.", brokeUser.cookie);
  const poorUser = await login();
  const short = await world({ owner: poorUser, credit: 2299 });
  const shortBefore = await balanceOf(poorUser.userId);
  const shortResponse = await post(short.offer.id, { body: bodyFor(short), cookie: poorUser.cookie });
  assert.equal(shortResponse.status, 409);
  assert.deepEqual(errorOf(shortResponse), { code: "insufficient_balance", message: "Solde insuffisant." });
  assert.equal(await balanceOf(poorUser.userId), shortBefore);

  // Aucun message de refus ne contient d'identifiant ni de montant.
  for (const text of Object.values({ a: "Cette cotation a expiré", b: "Solde insuffisant." })) assert.ok(!/[0-9]/.test(text));
});

test("409 no_visible_effect (lot P3) : plus aucun acheteur atteignable au moment de l'achat → 409 au texte fixe, rien d'écrit ; la portée revenue, le MÊME devis s'achète ; le message ne révèle ni acheteur, ni identifiant, ni montant", async () => {
  const w = await world();
  const buyerDemands = "id IN (SELECT demand_id FROM matching_evaluations WHERE offer_id = $1)";
  await pool.query(`UPDATE demands SET status = 'satisfied' WHERE ${buyerDemands}`, [w.offer.id]);
  const before = await snapshot();
  const refused = await post(w.offer.id, { body: bodyFor(w) });
  assert.equal(refused.status, 409);
  assert.deepEqual(errorOf(refused), { code: "no_visible_effect", message: "Ce boost ne ferait monter votre annonce chez aucun acheteur : rien n'a été acheté." });
  assert.deepEqual(await snapshot(), before, "ni débit, ni boost, ni achat");
  assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}/.test(refused.text) && !/[0-9]/.test(errorOf(refused).message), "aucun identifiant ni montant");
  await pool.query(`UPDATE demands SET status = 'active' WHERE ${buyerDemands}`, [w.offer.id]);
  assert.equal((await post(w.offer.id, { body: bodyFor(w) })).status, 201, "la portée revenue, le même devis s'achète");
});

test("503 reach_check_unavailable (lot P3-bis, N3) : vérification de la portée non terminée à temps → 503 au texte fixe, Retry-After court, rien d'écrit (ni débit, ni boost, ni achat), journal d'un code ; la MÊME clé d'idempotence réessayée aboutit (201, un seul débit) ; ce n'est jamais un 409 no_visible_effect", async () => {
  const w = await world();
  const slowHandlers = createBoostPurchaseHttpHandlers({ pool: slowReachPool(pool), now: clock.now, env, log });
  const body = bodyFor(w);
  const before = await snapshot();
  logs.length = 0;
  const slow = await post(w.offer.id, { handlers: slowHandlers, body });
  assert.equal(slow.status, 503);
  assert.deepEqual(slow.json, { error: { code: "reach_check_unavailable", message: "Vérification impossible pour le moment, réessayez dans un instant." } });
  assert.equal(slow.headers.find(([name]) => name === "retry-after")?.[1], "2", "Retry-After court");
  assert.deepEqual(logs, ["reach_check_unavailable"]);
  assert.deepEqual(await snapshot(), before, "ni débit, ni boost, ni achat");
  assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}/.test(slow.text) && !/[0-9]/.test(errorOf(slow).message), "aucun identifiant ni montant dans le message");
  // Même clé, vérification qui aboutit : l'achat passe, une seule fois.
  const retried = await post(w.offer.id, { body });
  assert.equal(retried.status, 201);
  assert.equal(asObject(asObject(retried.json).purchase).reused, false);
  assert.equal((await post(w.offer.id, { body })).status, 200, "rejeu de la même clé : aucun second débit");
  assert.equal(await scalar("SELECT count(*)::text AS n FROM boost_purchases WHERE seller_id = $1", [seller.userId]).then(Number) >= 1, true);
});

// ═════════════ 6 bis. Une cotation achetée n'est jamais renvoyée (parcours complet par HTTP) ═════════════

test("POST boost-quotes après un achat : jamais la cotation achetée (devis neuf, reused false, indisponible offer_already_boosted) ; après remboursement et échéance de l'indisponibilité, un devis NORMAL et un nouvel achat ; avant l'achat le devis valable reste réutilisé", async () => {
  const quotes = createBoostHttpHandlers({ pool, now: clock.now, env, log });
  const offer = await makeOffer({ ownerId: seller.userId });
  await addBuyer(offer);
  await fund(seller.userId, 20_000);
  interface QuoteBody { quote: { id: string; status: string; unavailableReason: string | null; amount: number | null; reused: boolean } }
  const postQuote = async (): Promise<{ status: number; quote: QuoteBody["quote"] }> => {
    const response = await reply(await quotes.quotes.create(build("POST", `/api/offers/${offer.id}/boost-quotes`, { body: { durationCode: "24h" } }), offer.id));
    return { status: response.status, quote: (response.json as QuoteBody).quote };
  };
  const first = await postQuote();
  assert.equal(first.status, 201);
  assert.equal(first.quote.status, "available");
  const reusedBefore = await postQuote();
  assert.deepEqual([reusedBefore.status, reusedBefore.quote.id, reusedBefore.quote.reused], [200, first.quote.id, true], "avant l'achat, le devis valable est toujours réutilisé");

  const bought = await post(offer.id, { body: { quoteId: first.quote.id, idempotencyKey: randomUUID() } });
  assert.equal(bought.status, 201, bought.text);
  const purchaseId = String(asObject(asObject(bought.json).purchase).id);

  const requote = await postQuote();
  assert.equal(requote.status, 201, "un devis NEUF est calculé (et non 200 reused : le devis acheté n'est plus renvoyé)");
  assert.notEqual(requote.quote.id, first.quote.id);
  assert.equal(requote.quote.reused, false);
  assert.deepEqual([requote.quote.status, requote.quote.unavailableReason, requote.quote.amount], ["unavailable", "offer_already_boosted", null]);
  await conflict("l'ancien devis, déjà acheté", offer.id, { quoteId: first.quote.id, idempotencyKey: randomUUID() }, "quote_already_used", "Cette cotation a déjà été achetée.");

  // Remboursement d'administration, puis l'indisponibilité de 60 s s'écoule : devis normal, jamais l'acheté (encore valable), et nouvel achat.
  await refundBoostPurchase({ pool, purchaseId, reasonCode: "customer_request" });
  await pool.query("UPDATE boost_quotes SET computed_at = clock_timestamp() - interval '2 hours', expires_at = clock_timestamp() - interval '1 hour' WHERE id = $1", [requote.quote.id]);
  const renewed = await postQuote();
  assert.equal(renewed.status, 201);
  assert.equal(renewed.quote.status, "available");
  assert.ok(renewed.quote.id !== first.quote.id && renewed.quote.id !== requote.quote.id);
  const second = await post(offer.id, { body: { quoteId: renewed.quote.id, idempotencyKey: randomUUID() } });
  assert.equal(second.status, 201, second.text);
  assert.equal(await count("boost_purchases", "offer_id = $1", [offer.id]), 2);
  assert.equal((await checkWalletIntegrity(pool)).violations.length, 0, "wallet:check vert");
});

// ═════════════ 7. 503 ═════════════

test("503 boost_purchase_unavailable : migration absente, erreur inattendue, verrou (55P03), session impossible à résoudre, journal défaillant → message fixe, un seul code au journal, rien d'écrit", async () => {
  const w = await world();
  const request = bodyFor(w);

  // Table absente (migration 0015 non appliquée) : SQLSTATE au journal seulement.
  logs.length = 0;
  await pool.query("ALTER TABLE boost_purchases RENAME TO boost_purchases_absente");
  try {
    const response = await post(w.offer.id, { body: request });
    assert.equal(response.status, 503);
    assert.deepEqual(response.json, FIXED_503);
    assert.deepEqual(logs, ["42P01"], "journal : le SQLSTATE seulement");
    logs.length = 0;
    assert.equal((await list(w.offer.id)).status, 503);
    assert.deepEqual(logs, ["42P01"]);
  } finally {
    await pool.query("ALTER TABLE boost_purchases_absente RENAME TO boost_purchases");
  }
  assert.equal(await count("boost_purchases", "quote_id = $1", [w.quoteId]), 0);

  // Erreur inattendue (pool défaillant) : jamais le message brut.
  logs.length = 0;
  const broken = createBoostPurchaseHttpHandlers({
    pool: { connect: async () => { throw new Error("secret interne postgres://noma:motdepasse@hote/base"); } } as unknown as Pool, now: clock.now, env, log,
    resolveSession: async () => ({ userId: seller.userId } as never),
  });
  const brokenResponse = await post(w.offer.id, { body: request, handlers: broken });
  assert.equal(brokenResponse.status, 503);
  assert.deepEqual(brokenResponse.json, FIXED_503);
  assert.ok(!brokenResponse.text.includes("secret") && !brokenResponse.text.includes("motdepasse"));
  assert.deepEqual(logs, ["unexpected_error"]);

  // Session impossible à résoudre : 503, jamais 401.
  logs.length = 0;
  const noSession = createBoostPurchaseHttpHandlers({ pool, now: clock.now, env, log, resolveSession: async () => { throw Object.assign(new Error("boom"), { code: "ECONNREFUSED" }); } });
  const sessionResponse = await post(w.offer.id, { body: request, handlers: noSession });
  assert.equal(sessionResponse.status, 503);
  assert.deepEqual(logs, ["ECONNREFUSED"]);

  // Un journal qui lève ne change pas la réponse.
  const throwingLog = createBoostPurchaseHttpHandlers({ pool, now: clock.now, env, log: () => { throw new Error("journal en panne"); }, resolveSession: async () => { throw new Error("x"); } });
  const throwingResponse = await post(w.offer.id, { body: request, handlers: throwingLog });
  assert.equal(throwingResponse.status, 503);
  assert.deepEqual(throwingResponse.json, FIXED_503);

  // Verrou : l'idempotence est tenue par une autre session ; l'achat attend lock_timeout (5 s) puis répond 503 sans rien écrire.
  const holder = await pool.connect();
  try {
    await holder.query("BEGIN");
    await holder.query("SELECT pg_advisory_xact_lock($1::int, hashtext($2::text))", [BOOST_PURCHASE_LOCK_NAMESPACE, `${seller.userId}:${request.idempotencyKey}`]);
    logs.length = 0;
    const started = Date.now();
    const locked = await bounded(post(w.offer.id, { body: request }), 9000, "POST de l'achat");
    assert.equal(locked.status, 503);
    assert.deepEqual(locked.json, FIXED_503);
    assert.deepEqual(logs, ["55P03"], "journal : le code du verrou seulement");
    assert.ok(Date.now() - started >= 4_000 && Date.now() - started < 9_000, `attente bornée par lock_timeout (${Date.now() - started} ms)`);
  } finally {
    await holder.query("ROLLBACK");
    holder.release();
  }
  assert.equal(await count("boost_purchases", "quote_id = $1", [w.quoteId]), 0, "rien d'écrit par les pannes");
  // Les pannes levées : la MÊME requête réussit.
  assert.equal((await post(w.offer.id, { body: request })).status, 201);
});

// ═════════════ 8. Concurrence par HTTP ═════════════

test("concurrence HTTP : 10 POST identiques simultanés → un 201 et neuf 200 du même achat, un seul débit ; deux vendeurs pour la dernière place → un 201 et un 409 no_slot_available", async () => {
  const w = await world({ credit: 10_000, amount: 2300 });
  const request = bodyFor(w);
  const before = await balanceOf(seller.userId);
  const responses = await Promise.all(Array.from({ length: 10 }, () => post(w.offer.id, { body: request })));
  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 200, 200, 200, 200, 200, 200, 200, 200, 201]);
  assert.equal(new Set(responses.map((response) => String(asObject(asObject(response.json).purchase).id))).size, 1);
  assert.equal(await balanceOf(seller.userId), before - 2300);

  // Dernière place : une offre chacun dans un périmètre à 1 place.
  const scope = makeScope();
  const mine = await makeOffer({ ownerId: seller.userId, scope });
  const theirs = await makeOffer({ ownerId: other.userId, scope });
  await fund(seller.userId, 5000);
  await fund(other.userId, 5000);
  const myQuote = await insertQuote(mine);
  const theirQuote = await insertQuote(theirs);
  const beforeBoth = [await balanceOf(seller.userId), await balanceOf(other.userId)];
  const race = await Promise.all([
    post(mine.id, { body: bodyFor({ quoteId: myQuote }) }),
    post(theirs.id, { body: bodyFor({ quoteId: theirQuote }), cookie: other.cookie }),
  ]);
  assert.deepEqual(race.map((response) => response.status).sort(), [201, 409]);
  const loser = race.find((response) => response.status === 409)!;
  assert.equal(errorOf(loser).code, "no_slot_available");
  assert.equal(await count("offer_boosts", "scope_category = $1 AND status = 'active'", [scope.category]), 1, "pas de survente");
  const afterBoth = [await balanceOf(seller.userId), await balanceOf(other.userId)];
  assert.equal(afterBoth.filter((value, index) => value === beforeBoth[index]).length, 1, "le perdant n'est pas débité");
  assert.equal((await checkWalletIntegrity(pool)).violations.length, 0, "wallet:check vert");
});

test("module de route : seulement GET et POST (+ runtime et dynamic) ; le contrat est figé", async () => {
  assert.deepEqual(Object.keys(purchasesRoute).sort(), ["GET", "POST", "dynamic", "runtime"]);
  assert.equal(purchasesRoute.runtime, "nodejs");
  assert.equal(purchasesRoute.dynamic, "force-dynamic");
  assert.equal(BOOST_PURCHASE_CONTRACT_VERSION, "boost-purchase/v1");
  const dependencies: BoostPurchaseHttpDependencies = { pool, env };
  assert.deepEqual(Object.keys(createBoostPurchaseHttpHandlers(dependencies).purchases).sort(), ["create", "list"]);
});
