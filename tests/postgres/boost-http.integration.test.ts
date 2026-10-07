import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { Pool } from "pg";
import { requestOtp, revokeSession, SESSION_TTL_MS, verifyOtp, type SendOtpInput } from "../../lib/server/auth";
import { createDemand, createOffer, createUser } from "../../lib/server/catalog";
import type { DemandRecord, OfferRecord } from "../../lib/server/catalog/types";
import { BOOST_QUOTE_LOCK_NAMESPACE } from "../../lib/server/boost/boost-config";
import { grantOfferBoost } from "../../lib/server/boost/boosts";
import { processReachGate } from "../../lib/server/boost/quotes";
import { processReuseRecheckGuard } from "../../lib/server/boost/recheck-guard";
import {
  BOOST_QUOTE_CONTRACT_VERSION, createBoostHttpHandlers, type BoostHttpHandlers, type BoostHttpDependencies,
} from "../../lib/server/boost/http";
import { computeScoringConfigHash, normalizeScoringConfig } from "../../lib/server/matching/persistence";
import { MATCHING_SCORING_CONTRACT_VERSION } from "../../lib/server/matching/scoring-types";
import { MATCHING_OFFLINE_CONTRACT_VERSION } from "../../lib/server/matching/types";
import { runMigrations } from "../../lib/server/postgres/migrations";
import * as boostQuotesRoute from "../../app/api/offers/[id]/boost-quotes/route";
import { EVALUATION_SUMMARY_JSON, PREFERENCES_SUMMARY_JSON, REACHABLE_LIST_SIZE, SCORING_SUMMARY_JSON, slowReachPool } from "./boost-fixtures";
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

const HASH = computeScoringConfigHash(normalizeScoringConfig());
const SECRET = randomBytes(32);
const ORIGIN = "https://noma.test";
const FIXED_503 = { error: { code: "boost_unavailable", message: "Le service de boost est temporairement indisponible." } };
const FIXED_404 = { error: { code: "resource_not_found", message: "Ressource introuvable." } };
const schema = createTemporarySchemaName();
const quoted = quoteTemporarySchema(schema);
const clock = new TestClock(Date.UTC(2032, 0, 1, 10));
const logs: string[] = [];
const log = (code: string): void => { logs.push(code); };
const env = { NOMA_AUTH_ORIGIN: ORIGIN };
let admin: Pool, pool: Pool;
let target: DedicatedTestDatabase;
let handlers: BoostHttpHandlers;
let seller: Login, other: Login;
const extraPools: Pool[] = [];
let phoneSequence = 0;
let ipSequence = 0;

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
  pool = await openVerifiedIsolatedPool(target, schema);
  await runMigrations(pool);
  handlers = createBoostHttpHandlers({ pool, now: clock.now, env, log });
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
  /** Corps sérialisé en JSON. */
  body?: unknown;
  /** Corps brut (prioritaire sur `body`). */
  raw?: string;
  contentType?: string | null;
  handlers?: BoostHttpHandlers;
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
const statusesSeen = new Set<number>();

/** Chaque réponse du fichier passe ici : no-store, nosniff et JSON sont donc vérifiés sur TOUTES. */
async function reply(response: Response): Promise<Reply> {
  const text = await response.text();
  assert.equal(response.headers.get("cache-control"), "no-store", `Cache-Control sur ${response.status}`);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff", `nosniff sur ${response.status}`);
  assert.match(response.headers.get("content-type") ?? "", /^application\/json/, `content-type sur ${response.status}`);
  statusesSeen.add(response.status);
  return { status: response.status, text, json: JSON.parse(text), headers: [...response.headers.entries()].sort() };
}

const post = async (offerId: string, options: CallOptions = {}): Promise<Reply> =>
  reply(await (options.handlers ?? handlers).quotes.create(build("POST", `/api/offers/${offerId}/boost-quotes`, options), offerId));
const list = async (offerId: string, query = "", options: CallOptions = {}): Promise<Reply> =>
  reply(await (options.handlers ?? handlers).quotes.list(build("GET", `/api/offers/${offerId}/boost-quotes${query}`, options), offerId));

/** Compte d'acheteurs uniques du DTO (lots M1 à M1-quater, contrat boost-quote/v2) : « moins de 5 » de 0 à 4, sinon « environ N » (multiple de 5). */
type Buyers = { kind: "below"; bound: number } | { kind: "approx"; value: number };
const buyers = (value: number): Buyers => ({ kind: "approx", value });
const BELOW: Buyers = { kind: "below", bound: 5 };

interface QuoteDto {
  id: string; durationCode: string; currency: string; status: string; amount: number | null; unavailableReason: string | null;
  factors: { competitionMilli: number; demandMilli: number; scarcityMilli: number; durationMilli: number } | null;
  inputs: { competingSellers: number; compatibleBuyers: Buyers; reachableBuyers: Buyers | null; reachTruncated: boolean; slotsTotal: number; slotsUsed: number };
  computedAt: string; expiresAt: string; reused?: boolean; expired?: boolean;
}

const asObject = (reply: Reply): Record<string, unknown> => reply.json as Record<string, unknown>;
const errorCode = (reply: Reply): string => ((asObject(reply).error as { code: string }).code);
const quoteOf = (reply: Reply): QuoteDto => (asObject(reply).quote as QuoteDto);
const quotesOf = (reply: Reply): QuoteDto[] => (asObject(reply).quotes as QuoteDto[]);
const keys = (value: unknown): string[] => Object.keys(value as object).sort();

// ───────────── données ─────────────

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

const makeDemand = (ownerId: string): Promise<DemandRecord> => createDemand({
  ownerId, rawText: "RAW_SECRET_TEXT demande", category: "smartphones", brand: "Apple", model: "iPhone 13", status: "active",
}, pool);

async function evaluate(offer: OfferRecord, demand: DemandRecord, score = 90): Promise<void> {
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

/**
 * Offres « remplissage » (autre modèle : hors périmètre du boost, sans effet sur places, vendeurs concurrents ni prix) : elles complètent la liste
 * de l'acheteur à 7 offres au moins, sinon le quota de places promues est nul et la cotation est `no_visible_effect` (lot P2-bis). Évaluées APRÈS
 * l'offre cotée et plus compatibles qu'elle : l'offre est classée après elles, un boost la ferait monter.
 */
let fillerOffers: OfferRecord[] = [];
async function fillersFor(count: number): Promise<OfferRecord[]> {
  const owner = fillerOffers[0]?.ownerId ?? await makeUser();
  while (fillerOffers.length < count) fillerOffers.push(await makeOffer({ ownerId: owner, model: "FILLER-MODEL" }));
  return fillerOffers.slice(0, count);
}

/** Un acheteur distinct avec une demande active et une évaluation confirmée et fraîche sur l'offre. */
async function addBuyer(offer: OfferRecord): Promise<string> {
  const buyerId = await makeUser();
  const demand = await makeDemand(buyerId);
  await evaluate(offer, demand);
  for (const filler of await fillersFor(REACHABLE_LIST_SIZE - 1)) await evaluate(filler, demand, 100);
  return buyerId;
}

const wipe = () => { fillerOffers = []; return pool.query("TRUNCATE boost_quotes, offer_boosts, matching_evaluations, matching_jobs, matching_outbox_events, demands, offers CASCADE"); };
const count = async (table = "boost_quotes"): Promise<number> => (await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n;

/** Monde minimal : une offre du vendeur (1 place, aucune utilisée) et `buyers` acheteurs compatibles. */
async function smallWorld(buyers = 1, input: OfferInput = {}): Promise<{ offer: OfferRecord; buyerIds: string[] }> {
  await wipe();
  const offer = await makeOffer({ ownerId: seller.userId, ...input });
  const buyerIds: string[] = [];
  for (let index = 0; index < buyers; index++) buyerIds.push(await addBuyer(offer));
  return { offer, buyerIds };
}

/**
 * Monde de l'exemple de contrôle de 2I2 : 14 offres éligibles du périmètre (11 du vendeur, 1 pour chacun de 3 autres vendeurs) →
 * 3 places ; un boost effectif d'un autre vendeur → 1 place utilisée ; 4 acheteurs compatibles distincts.
 */
async function controlWorld() {
  await wipe();
  const own: OfferRecord[] = [];
  for (let index = 0; index < 11; index++) own.push(await makeOffer({ ownerId: seller.userId }));
  const others: OfferRecord[] = [];
  for (let index = 0; index < 3; index++) others.push(await makeOffer());
  await grantOfferBoost({ pool, offerId: others[0].id, ownerId: others[0].ownerId, durationCode: "24h", source: "admin_grant" });
  const buyerIds: string[] = [];
  for (let index = 0; index < 4; index++) buyerIds.push(await addBuyer(own[0]));
  return { offer: own[0], own, others, buyerIds };
}

const insertDefaultPricing = () => pool.query(
  `INSERT INTO boost_pricing_settings (key, version, currency, base_amount, grid_amount, min_amount, max_amount, competition_step_milli, competition_max_milli,
     demand_step_milli, demand_max_milli, scarcity_max_milli, duration_24h_milli, duration_3d_milli, duration_7d_milli, quote_validity_seconds)
   VALUES ('default', 1, 'XOF', 500, 100, 500, 50000, 20, 1500, 100, 3000, 2000, 1000, 2500, 5000, 900)`);
const insertDefaultBoostSettings = () => pool.query(
  `INSERT INTO boost_settings (key, slot_ratio, min_slots, max_slots, max_active_per_seller, max_seller_slot_share, max_promoted_share, min_relevance)
   VALUES ('default', 0.150, 1, 50, 2, 0.340, 0.150, 60.00)`);

const sorted = (list: string[]): string[] => [...list].sort();
const COMMON_KEYS = ["id", "durationCode", "currency", "status", "amount", "unavailableReason", "factors", "inputs", "computedAt", "expiresAt"];
/** JSON valide complété d'espaces jusqu'à `total` octets exactement : le corps reste correct, seule sa taille change. */
const padded = (json: string, total: number): string => json + " ".repeat(total - Buffer.byteLength(json));
/** Le plafond du catalogue, en littéral : 32 Kio. Un corps de 32 768 octets passe, de 32 769 est refusé. */
const BODY_CAP_BYTES = 32 * 1024;

const POST_KEYS = sorted([...COMMON_KEYS, "reused"]);
const GET_KEYS = sorted([...COMMON_KEYS, "expired"]);
const FACTOR_KEYS = sorted(["competitionMilli", "demandMilli", "scarcityMilli", "durationMilli"]);
const INPUT_KEYS = sorted(["competingSellers", "compatibleBuyers", "reachableBuyers", "reachTruncated", "slotsTotal", "slotsUsed"]);

// ═════════════ 1. Authentification ═════════════

test("authentification : 401 sans cookie, cookie invalide ou double, session révoquée, expirée, compte suspendu (GET et POST)", async () => {
  const { offer } = await smallWorld();
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
  const expiringOffer = await makeOffer({ ownerId: expiring.userId });
  await addBuyer(expiringOffer);
  const lateClock = new TestClock(clock.now().getTime());
  const lateHandlers = createBoostHttpHandlers({ pool, now: lateClock.now, env, log });
  assert.equal((await post(expiringOffer.id, { cookie: expiring.cookie, body: { durationCode: "24h" }, handlers: lateHandlers })).status, 201, "valide avant expiration");
  lateClock.advance(SESSION_TTL_MS + 1);
  checks.push(["session expirée", { cookie: expiring.cookie, handlers: lateHandlers }]);

  const before = await count();
  for (const [label, options] of checks) {
    const posted = await post(offer.id, { ...options, body: { durationCode: "24h" } });
    assert.equal(posted.status, 401, `POST ${label}`);
    assert.deepEqual(posted.json, { error: { code: "authentication_required", message: "Authentification requise." } }, `POST ${label}`);
    const listed = await list(offer.id, "", options);
    assert.equal(listed.status, 401, `GET ${label}`);
    assert.deepEqual(listed.json, { error: { code: "authentication_required", message: "Authentification requise." } }, `GET ${label}`);
  }
  assert.equal(await count(), before, "aucune cotation créée par une requête non authentifiée");
  // La session est vérifiée avant l'identifiant : un identifiant invalide sans session reste un 401.
  assert.equal((await post("pas-un-uuid", { cookie: null, body: { durationCode: "24h" } })).status, 401);
  assert.equal((await list("pas-un-uuid", "", { cookie: null })).status, 401);
});

// ═════════════ 2. Origine (POST) ═════════════

test("POST : NOMA_AUTH_ORIGIN absente ou invalide → 503 ; origine absente, étrangère ou mal formée → 403 ; l'origine est contrôlée AVANT la session", async () => {
  const { offer } = await smallWorld();
  const body = { durationCode: "24h" };
  logs.length = 0;
  for (const value of [undefined, "", "   ", "pas une url", "ftp://noma.test", "https://noma.test/chemin"]) {
    const unconfigured = createBoostHttpHandlers({ pool, now: clock.now, env: value === undefined ? {} : { NOMA_AUTH_ORIGIN: value }, log });
    const withSession = await post(offer.id, { body, handlers: unconfigured });
    assert.equal(withSession.status, 503, `origine configurée = ${JSON.stringify(value)}`);
    assert.deepEqual(withSession.json, FIXED_503);
    // Même sans session : la configuration d'origine passe avant l'authentification.
    const withoutSession = await post(offer.id, { body, cookie: null, handlers: unconfigured });
    assert.equal(withoutSession.status, 503, "origine non configurée avant la session");
  }
  assert.ok(logs.length > 0 && logs.every((code) => code === "origin_unconfigured"), `journal : ${JSON.stringify(logs)}`);

  const refused: Array<[string, string | null]> = [
    ["absente", null], ["étrangère", "https://evil.example"], ["sous-domaine", "https://sub.noma.test"], ["autre schéma", "http://noma.test"],
    ["autre port", "https://noma.test:8443"], ["avec barre finale", `${ORIGIN}/`], ["avec chemin", `${ORIGIN}/x`], ["null", "null"], ["vide", ""], ["illisible", "pas une url"],
  ];
  for (const [label, origin] of refused) {
    for (const [sessionLabel, cookie] of [["avec session", seller.cookie], ["sans session", null], ["session invalide", "noma_auth=invalide"]] as const) {
      const response = await post(offer.id, { origin, cookie, body });
      assert.equal(response.status, 403, `origine ${label}, ${sessionLabel} : l'origine est refusée avant la session`);
      assert.deepEqual(response.json, { error: { code: "invalid_origin", message: "Origine de la requête non autorisée." } });
    }
  }
  assert.equal(await count(), 0, "aucune cotation créée par une origine refusée");
  // Origine valide : on passe à la session, puis à la cotation.
  assert.equal((await post(offer.id, { cookie: null, body })).status, 401);
  assert.equal((await post(offer.id, { body })).status, 201);
  // Le GET ne dépend pas de l'origine.
  assert.equal((await list(offer.id, "", { origin: "https://evil.example" })).status, 200);
});

// ═════════════ 3. 404 sans fuite d'existence ═════════════

test("404 : offre inexistante et offre d'autrui donnent des réponses identiques octet pour octet ; aucune ligne créée", async () => {
  await wipe();
  const mine = await makeOffer({ ownerId: seller.userId });
  await addBuyer(mine);
  const foreign = await makeOffer({ ownerId: other.userId });
  await addBuyer(foreign);
  // Offres d'autrui qui seraient 409 pour leur propriétaire : le propriétaire est contrôlé AVANT l'éligibilité.
  const foreignPaused = await makeOffer({ ownerId: other.userId, status: "paused" });
  const foreignNoBrand = await makeOffer({ ownerId: other.userId, brand: null });
  const body = { durationCode: "24h" };
  const missingPost = await post(randomUUID(), { body });
  const missingGet = await list(randomUUID());
  assert.equal(missingPost.status, 404);
  assert.deepEqual(missingPost.json, FIXED_404);
  for (const target of [foreign, foreignPaused, foreignNoBrand]) {
    const foreignPost = await post(target.id, { body });
    assert.equal(foreignPost.status, 404, "POST sur l'offre d'autrui");
    assert.equal(foreignPost.text, missingPost.text, "corps identique (POST)");
    assert.deepEqual(foreignPost.headers, missingPost.headers, "en-têtes identiques (POST)");
    const foreignGet = await list(target.id);
    assert.equal(foreignGet.status, 404, "GET sur l'offre d'autrui");
    assert.equal(foreignGet.text, missingGet.text, "corps identique (GET)");
    assert.deepEqual(foreignGet.headers, missingGet.headers, "en-têtes identiques (GET)");
  }
  assert.equal(missingGet.text, missingPost.text, "même corps pour POST et GET");
  assert.equal(await count(), 0, "aucune cotation créée");
  // Les offres d'autrui ne montrent rien, même quand le vendeur actuel a lui-même des cotations.
  assert.equal((await post(mine.id, { body })).status, 201);
  assert.equal((await list(foreign.id)).status, 404);
  assert.equal(await count(), 1);
});

// ═════════════ 4. 400 ═════════════

test("400 : identifiant invalide, corps invalide (POST) et paramètres invalides (GET) ; aucune ligne créée ; limites acceptées", async () => {
  const { offer } = await smallWorld();
  for (const id of ["pas-un-uuid", "", "123", `${randomUUID()}x`, randomUUID().replace(/-/g, "")]) {
    const posted = await post(id, { body: { durationCode: "24h" } });
    assert.equal(posted.status, 400, `POST id=${JSON.stringify(id)}`);
    assert.deepEqual(posted.json, { error: { code: "invalid_request", message: "Requête invalide." } });
    assert.equal((await list(id)).status, 400, `GET id=${JSON.stringify(id)}`);
  }

  const badBodies: Array<[string, CallOptions]> = [
    ["non JSON", { raw: "{oops" }],
    ["corps vide", { raw: "" }],
    ["tableau vide", { raw: "[]" }],
    ["tableau contenant l'objet attendu", { raw: '[{"durationCode":"24h"}]' }],
    ["null", { raw: "null" }],
    ["chaîne", { raw: '"24h"' }],
    ["nombre", { raw: "24" }],
    ["objet vide", { body: {} }],
    ["clé absente (autre clé)", { body: { duration: "24h" } }],
    ["clé inconnue en plus", { body: { durationCode: "24h", extra: 1 } }],
    ["offerId en plus", { body: { durationCode: "24h", offerId: randomUUID() } }],
    ["__proto__ en plus", { raw: '{"durationCode":"24h","__proto__":{}}' }],
    ["durée inconnue", { body: { durationCode: "48h" } }],
    ["durée vide", { body: { durationCode: "" } }],
    ["durée en majuscules", { body: { durationCode: "24H" } }],
    ["durée avec espace", { body: { durationCode: " 24h" } }],
    ["durée nombre", { body: { durationCode: 24 } }],
    ["durée null", { body: { durationCode: null } }],
    ["durée booléenne", { body: { durationCode: true } }],
    ["durée tableau", { body: { durationCode: ["24h"] } }],
    ["durée objet", { body: { durationCode: { code: "24h" } } }],
    ["content-type texte", { raw: '{"durationCode":"24h"}', contentType: "text/plain" }],
    ["content-type formulaire", { raw: "durationCode=24h", contentType: "application/x-www-form-urlencoded" }],
    ["corps valide mais un octet au-dessus du plafond de 32 Kio", { raw: padded('{"durationCode":"24h"}', BODY_CAP_BYTES + 1) }],
    ["corps valide mais très au-dessus du plafond", { raw: padded('{"durationCode":"24h"}', BODY_CAP_BYTES * 4) }],
  ];
  for (const [label, options] of badBodies) {
    const response = await post(offer.id, options);
    assert.equal(response.status, 400, `corps : ${label}`);
    assert.deepEqual(response.json, { error: { code: "invalid_request", message: "Requête invalide." } }, `corps : ${label}`);
  }
  assert.equal(await count(), 0, "aucun corps invalide ne crée de cotation");

  const badQueries = [
    "?foo=1", "?limit=1&foo=2", "?cursor=abc", "?Limit=5", "?offset=1", "?limit=1&limit=2", "?limit=1&limit=1",
    "?limit=0", "?limit=51", "?limit=-1", "?limit=1.5", "?limit=abc", "?limit=", "?limit=%20", "?limit=1e1", "?limit=%2B5", "?limit=0x10",
    "?limit=99999999999999999999", "?limit=5%20",
  ];
  for (const query of badQueries) {
    const response = await list(offer.id, query);
    assert.equal(response.status, 400, `GET ${query}`);
    assert.deepEqual(response.json, { error: { code: "invalid_request", message: "Requête invalide." } }, `GET ${query}`);
  }
  for (const query of ["?limit=1", "?limit=50", "?limit=20", ""]) assert.equal((await list(offer.id, query)).status, 200, `GET ${query || "(sans paramètre)"}`);
});

// ═════════════ 5. 201 puis 200 ═════════════

test("201 à la création, 200 en réutilisation (même id, reused true), 201 pour une autre durée ou après expiration", async () => {
  const { offer } = await smallWorld();
  const first = await post(offer.id, { body: { durationCode: "24h" } });
  assert.equal(first.status, 201);
  assert.equal(quoteOf(first).reused, false);
  assert.equal(quoteOf(first).status, "available");
  assert.equal(quoteOf(first).durationCode, "24h");
  assert.equal(quoteOf(first).amount, 700, "monde minimal : base 500 × demande 1,4 (un acheteur compatible : D' = 5, lot M1-quater ; avant : 1,2 puis 1,0)");
  const second = await post(offer.id, { body: { durationCode: "24h" } });
  assert.equal(second.status, 200);
  assert.equal(quoteOf(second).reused, true);
  assert.equal(quoteOf(second).id, quoteOf(first).id);
  assert.deepEqual({ ...quoteOf(second), reused: false }, quoteOf(first), "la cotation réutilisée est identique, seul reused change");
  assert.equal(await count(), 1);
  const threeDays = await post(offer.id, { body: { durationCode: "3d" } });
  assert.equal(threeDays.status, 201);
  assert.notEqual(quoteOf(threeDays).id, quoteOf(first).id);
  assert.equal(quoteOf(threeDays).amount, 1800, "500 × 2,5 × 1,4 (D' = 5) = 1 750 : pile à mi-grille de 100, arrondi demi-haut à 1 800 (avant M1-quater : 1 500 ; avant M1-bis : 1 250 arrondi à 1 300)");
  assert.equal(await count(), 2);
  // Plafond de corps : un corps valide de EXACTEMENT 32 768 octets est accepté (le plafond du catalogue, atteint mais non dépassé).
  const atCap = await post(offer.id, { raw: padded('{"durationCode":"7d"}', BODY_CAP_BYTES) });
  assert.equal(atCap.status, 201, "32 768 octets : accepté");
  assert.equal(quoteOf(atCap).durationCode, "7d");
  await pool.query("DELETE FROM boost_quotes WHERE duration_code = '7d'");
  // Après expiration forcée en SQL : une nouvelle cotation (201), l'ancienne reste en historique.
  await pool.query("UPDATE boost_quotes SET computed_at = computed_at - interval '2 hours', expires_at = expires_at - interval '2 hours'");
  const renewed = await post(offer.id, { body: { durationCode: "24h" } });
  assert.equal(renewed.status, 201);
  assert.notEqual(quoteOf(renewed).id, quoteOf(first).id);
  assert.equal(await count(), 3);
});

// ═════════════ 6. Cotation indisponible ═════════════

test("cotation indisponible (plus de place, aucun acheteur) : 201 avec status unavailable et son motif, jamais une erreur HTTP ; réutilisée en 200", async () => {
  // Plus de place : 2 offres dans le périmètre → 1 place, prise par le boost de l'autre vendeur.
  await wipe();
  const mine = await makeOffer({ ownerId: seller.userId });
  await addBuyer(mine);
  const rival = await makeOffer();
  await grantOfferBoost({ pool, offerId: rival.id, ownerId: rival.ownerId, durationCode: "24h", source: "admin_grant" });
  const full = await post(mine.id, { body: { durationCode: "3d" } });
  assert.equal(full.status, 201);
  assert.equal(quoteOf(full).status, "unavailable");
  assert.equal(quoteOf(full).unavailableReason, "no_slot_available");
  assert.equal(quoteOf(full).amount, null);
  assert.equal(quoteOf(full).factors, null);
  assert.deepEqual(quoteOf(full).inputs, { competingSellers: 1, compatibleBuyers: BELOW, reachableBuyers: null, reachTruncated: false, slotsTotal: 1, slotsUsed: 1 });
  assert.equal(quoteOf(full).reused, false);
  assert.equal(Date.parse(quoteOf(full).expiresAt) - Date.parse(quoteOf(full).computedAt), 60_000, "validité courte d'une indisponibilité");
  const again = await post(mine.id, { body: { durationCode: "3d" } });
  assert.equal(again.status, 200);
  assert.equal(quoteOf(again).id, quoteOf(full).id);
  assert.equal(quoteOf(again).reused, true);
  assert.equal(quoteOf(again).status, "unavailable");

  // Aucun acheteur compatible.
  const { offer } = await smallWorld(0);
  const lonely = await post(offer.id, { body: { durationCode: "24h" } });
  assert.equal(lonely.status, 201);
  assert.equal(quoteOf(lonely).status, "unavailable");
  assert.equal(quoteOf(lonely).unavailableReason, "no_compatible_buyer");
  assert.equal(quoteOf(lonely).amount, null);
  assert.equal(quoteOf(lonely).factors, null);
  assert.deepEqual(quoteOf(lonely).inputs, { competingSellers: 0, compatibleBuyers: BELOW, reachableBuyers: BELOW, reachTruncated: false, slotsTotal: 1, slotsUsed: 0 });
  assert.deepEqual(keys(quoteOf(lonely)), POST_KEYS, "mêmes clés qu'une cotation disponible");
  const history = await list(offer.id);
  assert.equal(history.status, 200);
  assert.equal(quotesOf(history)[0].status, "unavailable");
  assert.equal(quotesOf(history)[0].unavailableReason, "no_compatible_buyer");
});

test("portée visible (lot P2-bis) : liste de 6 offres → 201 unavailable no_visible_effect (jamais une erreur HTTP), reachableBuyers 0 ; liste de 7 → disponible, reachableBuyers 1 ; historique : devis ancien (NULL) lu comme null", async () => {
  // Liste de 6 : quota floor(0,15 × 6) = 0, le boost ne ferait rien monter.
  await wipe();
  const short = await makeOffer({ ownerId: seller.userId });
  const buyerId = await makeUser();
  const demand = await makeDemand(buyerId);
  await evaluate(short, demand);
  for (const filler of await fillersFor(5)) await evaluate(filler, demand, 100);
  const useless = await post(short.id, { body: { durationCode: "24h" } });
  assert.equal(useless.status, 201);
  assert.equal(quoteOf(useless).status, "unavailable");
  assert.equal(quoteOf(useless).unavailableReason, "no_visible_effect");
  assert.equal(quoteOf(useless).amount, null);
  assert.equal(quoteOf(useless).factors, null);
  assert.deepEqual(quoteOf(useless).inputs, { competingSellers: 0, compatibleBuyers: BELOW, reachableBuyers: BELOW, reachTruncated: false, slotsTotal: 1, slotsUsed: 0 });
  assert.deepEqual(keys(quoteOf(useless)), POST_KEYS);
  assert.deepEqual(keys(quoteOf(useless).inputs), INPUT_KEYS);
  assert.equal(Date.parse(quoteOf(useless).expiresAt) - Date.parse(quoteOf(useless).computedAt), 60_000);
  // Liste de 7 : quota 1, l'offre est classée après les autres → disponible.
  const { offer } = await smallWorld(1);
  const useful = await post(offer.id, { body: { durationCode: "24h" } });
  assert.equal(useful.status, 201);
  assert.equal(quoteOf(useful).status, "available");
  assert.equal(quoteOf(useful).unavailableReason, null);
  assert.deepEqual(quoteOf(useful).inputs, { competingSellers: 0, compatibleBuyers: BELOW, reachableBuyers: BELOW, reachTruncated: false, slotsTotal: 1, slotsUsed: 0 });
  assert.equal(quoteOf(useful).amount, 700, "base 500 × demande 1,4 (D' = 5 pour 1 à 5 acheteurs ; avant : 1,2 puis 1,0)");
  // Un devis d'avant la migration 0016 (NULL) est servi avec reachableBuyers null, DTO inchangé par ailleurs.
  await pool.query("UPDATE boost_quotes SET reachable_buyers = NULL, reach_truncated = NULL WHERE id = $1", [quoteOf(useful).id]);
  const history = await list(offer.id);
  assert.equal(history.status, 200);
  assert.equal(quotesOf(history)[0].inputs.reachableBuyers, null);
  assert.deepEqual(keys(quotesOf(history)[0]), GET_KEYS);
  assert.deepEqual(keys(quotesOf(history)[0].inputs), INPUT_KEYS);
  // Aucune fuite : ni identité d'acheteur, ni identifiant de besoin dans les réponses.
  const raw = JSON.stringify([useless.json, useful.json, history.json]);
  for (const forbidden of [buyerId, demand.id, "demandId", "buyerId", "rawAmount", "reachable_buyers"]) assert.equal(raw.includes(forbidden), false, forbidden);
});

// ═════════════ 7. 409 ═════════════

test("409 : offer_not_eligible (en pause, brouillon, indisponible) et offer_not_boostable (marque, catégorie ou modèle absent) ; aucune ligne créée", async () => {
  await wipe();
  const body = { durationCode: "24h" };
  const notEligible: Array<[string, OfferInput]> = [
    ["en pause", { status: "paused" }], ["brouillon", { status: "draft" }], ["indisponible", { availability: "unavailable" }],
  ];
  for (const [label, input] of notEligible) {
    const offer = await makeOffer({ ownerId: seller.userId, ...input });
    const response = await post(offer.id, { body });
    assert.equal(response.status, 409, label);
    assert.deepEqual(response.json, { error: { code: "offer_not_eligible", message: "Cette offre n'est pas éligible au boost." } }, label);
  }
  const notBoostable: Array<[string, OfferInput]> = [["marque absente", { brand: null }], ["catégorie absente", { category: null }], ["modèle absent", { model: null }]];
  for (const [label, input] of notBoostable) {
    const offer = await makeOffer({ ownerId: seller.userId, ...input });
    const response = await post(offer.id, { body });
    assert.equal(response.status, 409, label);
    assert.deepEqual(
      response.json,
      { error: { code: "offer_not_boostable", message: "Cette offre n'est pas boostable : catégorie, marque et modèle requis." } }, label,
    );
  }
  assert.equal(await count(), 0, "aucune cotation créée");
  // Le GET reste un historique : une offre non éligible du vendeur répond 200 avec une liste vide.
  const paused = await makeOffer({ ownerId: seller.userId, status: "paused" });
  const history = await list(paused.id);
  assert.equal(history.status, 200);
  assert.deepEqual(quotesOf(history), []);
});

// ═════════════ 8. 503 ═════════════

test("503 boost_unavailable : réglages tarifaires absents, réglages de boost absents, verrou, erreur inconnue, session indisponible, journal défaillant", async () => {
  const { offer } = await smallWorld();
  const body = { durationCode: "24h" };

  // boost_pricing_settings vidée.
  logs.length = 0;
  await pool.query("DELETE FROM boost_pricing_settings");
  try {
    const response = await post(offer.id, { body });
    assert.equal(response.status, 503);
    assert.deepEqual(response.json, FIXED_503);
    assert.equal(await count(), 0, "aucune cotation créée");
    assert.deepEqual(logs, ["boost_pricing_missing"], "journal : le code seulement");
    assert.equal((await list(offer.id)).status, 200, "l'historique ne dépend pas des réglages tarifaires");
  } finally {
    await insertDefaultPricing();
  }

  // boost_settings vidée.
  logs.length = 0;
  await pool.query("DELETE FROM boost_settings");
  try {
    const response = await post(offer.id, { body });
    assert.equal(response.status, 503);
    assert.deepEqual(response.json, FIXED_503);
    assert.equal(await count(), 0, "aucune cotation créée");
    assert.deepEqual(logs, ["boost_settings_missing"], "journal : le code seulement");
  } finally {
    await insertDefaultBoostSettings();
  }
  assert.equal((await post(offer.id, { body })).status, 201, "les réglages rétablis, la cotation fonctionne");
  // CASCADE : depuis la migration 0015 (lot P1b), boost_purchases référence boost_quotes (aucun achat n'existe dans ce fichier).
  await pool.query("TRUNCATE boost_quotes CASCADE");

  // Migration 0012 non appliquée (table absente) : 503 pour le POST et le GET, le seul SQLSTATE au journal.
  logs.length = 0;
  await pool.query("ALTER TABLE boost_quotes RENAME TO boost_quotes_absente");
  try {
    for (const response of [await post(offer.id, { body }), await list(offer.id)]) {
      assert.equal(response.status, 503);
      assert.deepEqual(response.json, FIXED_503);
      assert.ok(!response.text.includes("boost_quotes") && !response.text.includes("relation"), "aucun détail de la base");
    }
    assert.deepEqual(logs, ["42P01", "42P01"]);
  } finally {
    await pool.query("ALTER TABLE boost_quotes_absente RENAME TO boost_quotes");
  }

  // Verrou : une erreur 55P03 avec un message brut chargé de secrets ; ni le message, ni la requête, ni l'identifiant ne sortent.
  const rawMessage = `RAW_SECRET connexion postgres://noma:motdepasse@10.0.0.1/noma SELECT * FROM boost_quotes WHERE offer_id = '${offer.id}'`;
  const failing = (error: unknown): Pool => new Proxy(pool, {
    get: (real, property) => (property === "connect" ? async () => { throw error; } : Reflect.get(real, property)),
  });
  const session = async () => ({ userId: seller.userId, expiresAt: new Date(clock.now().getTime() + 60_000) });
  const dependenciesFor = (error: unknown): BoostHttpDependencies => ({ pool: failing(error), now: clock.now, env, log, resolveSession: session });
  const cases: Array<[string, unknown, string]> = [
    ["verrou 55P03", Object.assign(new Error(rawMessage), { code: "55P03" }), "55P03"],
    ["connexion refusée", Object.assign(new Error(rawMessage), { code: "ECONNREFUSED" }), "ECONNREFUSED"],
    ["erreur sans code", new Error(rawMessage), "unexpected_error"],
    ["code qui n'a pas la forme d'un code", Object.assign(new Error(rawMessage), { code: `fuite ${rawMessage}` }), "unexpected_error"],
    ["valeur levée non Error", rawMessage, "unexpected_error"],
  ];
  for (const [label, error, expectedCode] of cases) {
    logs.length = 0;
    const response = await post(offer.id, { body, handlers: createBoostHttpHandlers(dependenciesFor(error)) });
    assert.equal(response.status, 503, label);
    assert.deepEqual(response.json, FIXED_503, label);
    for (const forbidden of ["RAW_SECRET", "postgres://", "motdepasse", "SELECT", "boost_quotes", offer.id, "55P03", "ECONNREFUSED"]) {
      assert.ok(!response.text.includes(forbidden), `${label} : ${forbidden} ne doit pas sortir`);
    }
    assert.deepEqual(logs, [expectedCode], `${label} : journal = code seul`);
    assert.ok(logs.every((code) => !code.includes(" ") && !code.includes(offer.id)));
  }

  // Un journal qui lève ne change pas la réponse.
  const throwingLog = createBoostHttpHandlers({ ...dependenciesFor(Object.assign(new Error(rawMessage), { code: "55P03" })), log: () => { throw new Error("journal hors service"); } });
  const survived = await post(offer.id, { body, handlers: throwingLog });
  assert.equal(survived.status, 503);
  assert.deepEqual(survived.json, FIXED_503);

  // Résolution de session indisponible : 503 (et non 401), sans message brut.
  logs.length = 0;
  const brokenSession = createBoostHttpHandlers({
    pool, now: clock.now, env, log,
    resolveSession: async () => { throw Object.assign(new Error(rawMessage), { code: "ECONNRESET" }); },
  });
  for (const response of [await post(offer.id, { body, handlers: brokenSession }), await list(offer.id, "", { handlers: brokenSession })]) {
    assert.equal(response.status, 503);
    assert.deepEqual(response.json, FIXED_503);
    assert.ok(!response.text.includes("RAW_SECRET"));
  }
  assert.deepEqual(logs, ["ECONNRESET", "ECONNRESET"]);
  assert.equal(await count(), 0);
});

test("503 : un vrai verrou consultatif tenu plus longtemps que lock_timeout → 503 boost_unavailable, journal 55P03, puis la cotation fonctionne", async () => {
  const { offer } = await smallWorld();
  const holder = await admin.connect();
  logs.length = 0;
  try {
    await holder.query("BEGIN");
    await holder.query("SELECT pg_advisory_xact_lock($1::int, hashtext($2::text))", [BOOST_QUOTE_LOCK_NAMESPACE, offer.id]);
    const blocked = await post(offer.id, { body: { durationCode: "24h" } });
    assert.equal(blocked.status, 503);
    assert.deepEqual(blocked.json, FIXED_503);
    assert.deepEqual(logs, ["55P03"]);
    assert.equal(await count(), 0, "aucune cotation créée");
  } finally {
    await holder.query("ROLLBACK").catch(() => {});
    holder.release();
  }
  const recovered = await post(offer.id, { body: { durationCode: "24h" } });
  assert.equal(recovered.status, 201);
});

test("arrondi des acheteurs compatibles (lots M1 à M1-quater) : 1 à 4 acheteurs → { kind: \"below\", bound: 5 }, jamais le nombre ; 5 → « environ 5 » ; le prix est IDENTIQUE de 1 à 5 acheteurs (D' = 5), 6 est plus cher", async () => {
  const raw = (response: Reply) => response.text;
  const quotes: Reply[] = [];
  for (const count of [1, 2, 4, 5]) {
    const world = await smallWorld(count);
    const posted = await post(world.offer.id, { body: { durationCode: "24h" } });
    quotes.push(posted);
    const stored = await pool.query<{ compatible_buyers: number; demand_milli: number }>("SELECT compatible_buyers, demand_milli FROM boost_quotes WHERE id = $1", [quoteOf(posted).id]);
    assert.deepEqual(stored.rows[0], { compatible_buyers: count, demand_milli: 1400 }, `D = ${count} enregistré exact (administration), facteur de D' = 5`);
    if (count < 5) {
      assert.deepEqual(quoteOf(posted).inputs.compatibleBuyers, BELOW, `${count} acheteurs`);
      assert.ok(raw(posted).includes('"compatibleBuyers":{"kind":"below","bound":5}'), "le corps brut ne porte pas le nombre");
      assert.ok(!new RegExp(`"compatibleBuyers":\\s*\\{[^}]*${count}[,}]`).test(raw(posted)), `jamais ${count} en clair`);
    } else {
      assert.deepEqual(quoteOf(posted).inputs.compatibleBuyers, buyers(5), "5 acheteurs : environ 5");
    }
    // L'historique applique le même arrondi.
    const history = await list(world.offer.id);
    assert.deepEqual(quotesOf(history)[0].inputs.compatibleBuyers, quoteOf(posted).inputs.compatibleBuyers);
  }
  // K2 (lots M1-bis et M1-quater) : le PRIX et le facteur demande sont identiques de 1 à 5 acheteurs (D' = 5) : le facteur ne redonne pas le nombre masqué.
  for (const quote of quotes) {
    assert.equal(quoteOf(quote).factors?.demandMilli, 1400, "demande de 1 à 5 acheteurs = celle de 5 acheteurs");
    assert.equal(quoteOf(quote).amount, 700);
  }
  for (const quote of quotes.slice(1)) assert.deepEqual(quoteOf(quote).factors, quoteOf(quotes[0]).factors);
  assert.ok(!/"demandMilli":(?:1000|1100|1200|1300)[,}]/.test(quotes.map(raw).join("")), "ni 1 000, ni 1 100, ni 1 200, ni 1 300 (1 à 4 acheteurs) en clair");
  // 6 acheteurs : publiés « environ 5 » (6 à 8), le prix, lui, est celui de 6 (limite assumée, MESURES.md).
  const six = await smallWorld(6);
  const quoteSix = await post(six.offer.id, { body: { durationCode: "24h" } });
  assert.deepEqual(quoteOf(quoteSix).inputs.compatibleBuyers, buyers(5));
  assert.equal(quoteOf(quoteSix).factors?.demandMilli, 1500, "6 acheteurs : le facteur de 6");
  assert.ok(quoteOf(quoteSix).amount! > quoteOf(quotes[3]).amount!, "6 acheteurs : plus cher que 5");
});

test("revérification d'un devis réutilisé (lot M1, D6) : au-delà de 60 par vendeur et par minute → 429 rate_limited avec Retry-After, aucun devis écrit ; un autre vendeur n'est pas touché", async () => {
  const limited = await login();
  await wipe();
  const offer = await makeOffer({ ownerId: limited.userId });
  await addBuyer(offer);
  const created = await post(offer.id, { cookie: limited.cookie, body: { durationCode: "24h" } });
  assert.equal(created.status, 201);
  assert.equal(quoteOf(created).status, "available");
  // 60 revérifications déjà comptées pour ce vendeur dans la minute (garde du PROCESSUS, celle des routes réelles).
  for (let index = 0; index < 60; index++) assert.equal(processReuseRecheckGuard.tryAcquire(limited.userId), true);
  const refused = await post(offer.id, { cookie: limited.cookie, body: { durationCode: "24h" } });
  assert.equal(refused.status, 429);
  assert.deepEqual(keys(refused.json), ["error"]);
  assert.equal((refused.json as { error: { code: string } }).error.code, "rate_limited");
  assert.equal(refused.headers.find(([name]) => name === "retry-after")?.[1], "60");
  assert.equal((await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM boost_quotes")).rows[0].n, 1, "aucun devis écrit par le refus");
  // Un autre vendeur (autre garde) : sa revérification a lieu, le devis est renvoyé.
  const fine = await login();
  const fineOffer = await makeOffer({ ownerId: fine.userId, model: "iPhone 13" });
  await addBuyer(fineOffer);
  assert.equal((await post(fineOffer.id, { cookie: fine.cookie, body: { durationCode: "24h" } })).status, 201);
  const reused = await post(fineOffer.id, { cookie: fine.cookie, body: { durationCode: "24h" } });
  assert.equal(reused.status, 200);
  assert.equal(quoteOf(reused).reused, true);
});

// ═════════════ 9. DTO ═════════════

test("DTO : clés EXACTEMENT égales à la liste blanche (POST et GET), valeurs de l'exemple de contrôle, rien de secret dans le corps brut", async () => {
  const { offer, others, buyerIds } = await controlWorld();
  const created = await post(offer.id, { body: { durationCode: "3d" } });
  assert.equal(created.status, 201);
  assert.deepEqual(keys(created.json), sorted(["contractVersion", "quote"]));
  assert.equal(asObject(created).contractVersion, BOOST_QUOTE_CONTRACT_VERSION);
  assert.equal(BOOST_QUOTE_CONTRACT_VERSION, "boost-quote/v2");
  assert.deepEqual(keys(quoteOf(created)), POST_KEYS);
  assert.deepEqual(keys(quoteOf(created).factors), FACTOR_KEYS);
  assert.deepEqual(keys(quoteOf(created).inputs), INPUT_KEYS);
  const row = (await pool.query<{ id: string; computed_at: Date; expires_at: Date; raw_amount: string }>(
    "SELECT id, computed_at, expires_at, raw_amount::text AS raw_amount FROM boost_quotes")).rows[0];
  assert.deepEqual(quoteOf(created), {
    id: row.id, durationCode: "3d", currency: "XOF", status: "available", amount: 2500, unavailableReason: null,
    factors: { competitionMilli: 1060, demandMilli: 1400, scarcityMilli: 1333, durationMilli: 2500 },
    inputs: { competingSellers: 3, compatibleBuyers: BELOW, reachableBuyers: BELOW, reachTruncated: false, slotsTotal: 3, slotsUsed: 1 },
    computedAt: row.computed_at.toISOString(), expiresAt: row.expires_at.toISOString(), reused: false,
  });
  assert.equal(Date.parse(quoteOf(created).expiresAt) - Date.parse(quoteOf(created).computedAt), 900_000);

  const reused = await post(offer.id, { body: { durationCode: "3d" } });
  assert.equal(reused.status, 200);
  assert.deepEqual(keys(reused.json), sorted(["contractVersion", "quote"]));
  assert.deepEqual(keys(quoteOf(reused)), POST_KEYS);
  const sevenDays = await post(offer.id, { body: { durationCode: "7d" } });
  assert.equal(sevenDays.status, 201);
  assert.deepEqual(keys(quoteOf(sevenDays)), POST_KEYS);

  const history = await list(offer.id);
  assert.equal(history.status, 200);
  assert.deepEqual(keys(history.json), sorted(["contractVersion", "quotes"]));
  assert.equal(asObject(history).contractVersion, BOOST_QUOTE_CONTRACT_VERSION);
  assert.equal(quotesOf(history).length, 2);
  for (const item of quotesOf(history)) {
    assert.deepEqual(keys(item), GET_KEYS);
    assert.deepEqual(keys(item.factors), FACTOR_KEYS);
    assert.deepEqual(keys(item.inputs), INPUT_KEYS);
    assert.equal(item.expired, false);
  }
  const { expired: historyExpired, ...historyShape } = quotesOf(history).find((item) => item.id === row.id)!;
  const { reused: createdReused, ...createdShape } = quoteOf(created);
  assert.equal(historyExpired, false);
  assert.equal(createdReused, false);
  assert.deepEqual(historyShape, createdShape, "l'historique renvoie la même cotation, avec expired à la place de reused");

  // Corps brut : rien d'interne, aucun identifiant, aucune valeur exacte.
  const secrets = [
    offer.id, seller.userId, other.userId, ...others.map((candidate) => candidate.id), ...others.map((candidate) => candidate.ownerId), ...buyerIds,
    ...(await pool.query<{ id: string }>("SELECT id FROM demands")).rows.map((demand) => demand.id), row.raw_amount, "2296.0925",
  ];
  for (const text of [created.text, reused.text, sevenDays.text, history.text]) {
    for (const token of ["rawAmount", "raw_amount", "pricing", "pricingKey", "pricingVersion", "offerId", "offer_id", "sellerId", "seller_id", "scope", "ownerId", "buyerId", "demandId"]) {
      assert.ok(!text.includes(token), `le corps ne doit pas contenir ${token}`);
    }
    assert.ok(!/raw/i.test(text), "le corps ne contient jamais « raw »");
    assert.ok(!/"key"|"version"/.test(text), "ni clé ni version tarifaire");
    for (const secret of secrets) assert.ok(!text.includes(secret), `le corps ne doit pas contenir ${secret}`);
    assert.ok(!text.includes("RAW_SECRET_TEXT"), "aucun texte métier");
  }
});

// ═════════════ 10. Historique (GET) ═════════════

test("GET : plus récentes d'abord, limite par défaut 20, limite 50, limite explicite, expired après expiration forcée en SQL, historique vide → []", async () => {
  const { offer } = await smallWorld();
  const empty = await list(offer.id);
  assert.equal(empty.status, 200);
  assert.deepEqual(asObject(empty), { contractVersion: "boost-quote/v2", quotes: [] });

  // 55 cotations : g = 1 est la plus récente (valide), g = 55 la plus ancienne (expirée).
  await pool.query(
    `INSERT INTO boost_quotes (id, offer_id, seller_id, scope_category, scope_brand, scope_model, duration_code, pricing_key, pricing_version, currency,
       status, unavailable_reason, amount, raw_amount, competition_milli, demand_milli, scarcity_milli, duration_milli,
       competing_sellers, compatible_buyers, slots_total, slots_used, computed_at, expires_at)
     SELECT gen_random_uuid(), $1::uuid, $2::uuid, 'smartphones', 'apple', 'iphone 13', '24h', 'default', 1, 'XOF',
            'available', NULL, 500, '500.000000000000', 1000, 1000, 1000, 1000, 0, 1, 1, 0,
            clock_timestamp() - make_interval(secs => g * 60), clock_timestamp() - make_interval(secs => g * 60) + interval '15 minutes'
       FROM generate_series(1, 55) AS g`,
    [offer.id, seller.userId],
  );
  // Une cotation d'une AUTRE offre du vendeur ne doit pas apparaître.
  const sibling = await makeOffer({ ownerId: seller.userId });
  await pool.query(
    `INSERT INTO boost_quotes (id, offer_id, seller_id, scope_category, scope_brand, scope_model, duration_code, pricing_key, pricing_version, currency,
       status, unavailable_reason, amount, raw_amount, competition_milli, demand_milli, scarcity_milli, duration_milli,
       competing_sellers, compatible_buyers, slots_total, slots_used, computed_at, expires_at)
     VALUES (gen_random_uuid(), $1, $2, 'smartphones', 'apple', 'iphone 13', '24h', 'default', 1, 'XOF', 'available', NULL, 500, '500.000000000000',
       1000, 1000, 1000, 1000, 0, 1, 1, 0, clock_timestamp(), clock_timestamp() + interval '15 minutes')`,
    [sibling.id, seller.userId],
  );
  const dbOrder = (await pool.query<{ id: string }>("SELECT id FROM boost_quotes WHERE offer_id = $1 ORDER BY computed_at DESC, id DESC", [offer.id])).rows.map((row) => row.id);
  assert.equal(dbOrder.length, 55);

  const byDefault = await list(offer.id);
  assert.equal(byDefault.status, 200);
  assert.equal(quotesOf(byDefault).length, 20, "limite par défaut : 20");
  assert.deepEqual(quotesOf(byDefault).map((item) => item.id), dbOrder.slice(0, 20), "plus récentes d'abord");
  const stamps = quotesOf(byDefault).map((item) => Date.parse(item.computedAt));
  assert.deepEqual([...stamps].sort((a, b) => b - a), stamps, "ordre décroissant de computedAt");
  assert.equal(quotesOf(byDefault)[0].expired, false, "la plus récente est encore valable");

  const maximal = await list(offer.id, "?limit=50");
  assert.equal(quotesOf(maximal).length, 50, "limite 50");
  assert.deepEqual(quotesOf(maximal).map((item) => item.id), dbOrder.slice(0, 50));
  assert.equal(quotesOf(maximal)[49].expired, true, "une ancienne cotation est expirée à la lecture");
  const three = await list(offer.id, "?limit=3");
  assert.deepEqual(quotesOf(three).map((item) => item.id), dbOrder.slice(0, 3));
  assert.equal(quotesOf(await list(offer.id, "?limit=1")).length, 1);

  // Expiration forcée en SQL d'une cotation créée par POST : expired passe de faux à vrai.
  const { offer: fresh } = await smallWorld();
  const created = await post(fresh.id, { body: { durationCode: "24h" } });
  assert.equal(quotesOf(await list(fresh.id))[0].expired, false);
  await pool.query("UPDATE boost_quotes SET computed_at = computed_at - interval '2 hours', expires_at = expires_at - interval '2 hours' WHERE id = $1", [quoteOf(created).id]);
  const expired = await list(fresh.id);
  assert.equal(quotesOf(expired)[0].id, quoteOf(created).id);
  assert.equal(quotesOf(expired)[0].expired, true);
});

// ═════════════ 11. Concurrence ═════════════

/** Attentes du verrou de cotation DE CETTE OFFRE, dans cette base : `pg_locks` est global à l'instance, les attentes d'une autre exécution (autre offre) ne comptent pas. */
async function waitForQuoteLockWaiters(offerId: string, expected: number, timeoutMs: number): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let waiting = 0;
  while (Date.now() < deadline) {
    waiting = (await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_locks
        WHERE locktype = 'advisory' AND NOT granted AND classid::bigint = $1 AND objid = hashtext($2::text)::oid
          AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`, [BOOST_QUOTE_LOCK_NAMESPACE, offerId])).rows[0].n;
    if (waiting >= expected) return waiting;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return waiting;
}

test("concurrence : 6 POST simultanés (6 pools, verrou de l'offre tenu jusqu'à ce que les 6 attendent) → une ligne, 6 réponses de même id, exactement une en 201", async () => {
  const { offer } = await smallWorld(2);
  const pools: Pool[] = [];
  for (let index = 0; index < 6; index++) {
    const extra = await openVerifiedIsolatedPool(target, schema);
    extraPools.push(extra);
    pools.push(extra);
  }
  const concurrent = pools.map((db) => createBoostHttpHandlers({ pool: db, now: clock.now, env, log }));
  const holder = await admin.connect();
  let results: Reply[];
  let waiting = 0;
  try {
    await holder.query("BEGIN");
    await holder.query("SELECT pg_advisory_xact_lock($1::int, hashtext($2::text))", [BOOST_QUOTE_LOCK_NAMESPACE, offer.id]);
    const attempts = concurrent.map((each) => post(offer.id, { body: { durationCode: "3d" }, handlers: each }));
    waiting = await waitForQuoteLockWaiters(offer.id, 6, 4_000);
    await holder.query("COMMIT");
    results = await Promise.all(attempts);
  } finally {
    await holder.query("ROLLBACK").catch(() => {});
    holder.release();
  }
  assert.equal(waiting, 6, "les six requêtes attendaient bien le verrou en même temps");
  assert.equal(await count(), 1, "une seule ligne");
  assert.deepEqual(results.map((result) => result.status).sort(), [200, 200, 200, 200, 200, 201], "exactement une réponse 201");
  assert.equal(new Set(results.map((result) => quoteOf(result).id)).size, 1, "six réponses de même id");
  assert.equal(results.filter((result) => quoteOf(result).reused === false).length, 1);
  assert.equal(results.filter((result) => result.status === 201).every((result) => quoteOf(result).reused === false), true, "201 ⇔ reused false");
  assert.ok(results.every((result) => quoteOf(result).amount === quoteOf(results[0]).amount));
});

// ═════════════ 12. Route Next.js et en-têtes ═════════════

test("route Next.js : exports GET et POST seulement (plus runtime et dynamic), params asynchrones, gestionnaires par défaut sans base pour les refus précoces", async () => {
  assert.deepEqual(Object.keys(boostQuotesRoute).sort(), sorted(["GET", "POST", "dynamic", "runtime"]));
  assert.equal(boostQuotesRoute.runtime, "nodejs");
  assert.equal(boostQuotesRoute.dynamic, "force-dynamic");
  const id = randomUUID();
  const context = { params: Promise.resolve({ id }) };
  const previous = process.env.NOMA_AUTH_ORIGIN;
  const originalConsoleError = console.error;
  const consoleLines: string[] = [];
  console.error = (...parts: unknown[]) => { consoleLines.push(parts.join(" ")); };
  process.env.NOMA_AUTH_ORIGIN = ORIGIN;
  try {
    const noSession = await reply(await boostQuotesRoute.GET(build("GET", `/api/offers/${id}/boost-quotes`, { cookie: null }), context));
    assert.equal(noSession.status, 401);
    const foreignOrigin = await reply(await boostQuotesRoute.POST(build("POST", `/api/offers/${id}/boost-quotes`, { origin: "https://evil.example", body: { durationCode: "24h" } }), context));
    assert.equal(foreignOrigin.status, 403);
    const noCookie = await reply(await boostQuotesRoute.POST(build("POST", `/api/offers/${id}/boost-quotes`, { cookie: null, body: { durationCode: "24h" } }), context));
    assert.equal(noCookie.status, 401);
    delete process.env.NOMA_AUTH_ORIGIN;
    const unconfigured = await reply(await boostQuotesRoute.POST(build("POST", `/api/offers/${id}/boost-quotes`, { cookie: null, body: { durationCode: "24h" } }), context));
    assert.equal(unconfigured.status, 503, "l'origine est relue à chaque requête");
    assert.deepEqual(unconfigured.json, FIXED_503);
    assert.deepEqual(consoleLines, ["[boost-http] origin_unconfigured"], "journal par défaut : le code seulement");
  } finally {
    console.error = originalConsoleError;
    if (previous === undefined) delete process.env.NOMA_AUTH_ORIGIN;
    else process.env.NOMA_AUTH_ORIGIN = previous;
  }
});

test("limite de débit (lot P3) : 20 devis calculés par vendeur et par minute → le 21e est refusé en 429 rate_limited (texte fixe, Retry-After) sans rien écrire ; une cotation réutilisée, l'historique et un autre vendeur passent ; aucun journal d'erreur", async () => {
  await wipe();
  const offers: OfferRecord[] = [];
  for (let index = 0; index < 7; index++) offers.push(await makeOffer({ ownerId: seller.userId }));
  const plan = offers.flatMap((offer) => (["24h", "3d", "7d"] as const).map((durationCode) => ({ offer, durationCode })));
  const logsBefore = logs.length;
  for (const { offer, durationCode } of plan.slice(0, 20)) assert.equal((await post(offer.id, { body: { durationCode } })).status, 201, `${offer.id} ${durationCode}`);
  assert.equal(await count(), 20);
  const refused = await post(plan[20].offer.id, { body: { durationCode: plan[20].durationCode } });
  assert.equal(refused.status, 429);
  assert.deepEqual(refused.json, { error: { code: "rate_limited", message: "Trop de devis demandés en peu de temps : réessayez dans une minute." } });
  assert.equal(refused.headers.find(([name]) => name === "retry-after")?.[1], "60");
  assert.equal(await count(), 20, "le refus n'écrit rien");
  assert.equal(logs.length, logsBefore, "un refus de débit n'est pas une panne : aucun journal");
  // Réutilisation (200), historique (200) : pas de calcul, pas de limite.
  assert.equal((await post(plan[0].offer.id, { body: { durationCode: plan[0].durationCode } })).status, 200);
  assert.equal((await list(plan[0].offer.id)).status, 200);
  // Un autre vendeur n'est pas concerné.
  const foreign = await makeOffer({ ownerId: other.userId });
  assert.equal((await post(foreign.id, { cookie: other.cookie, body: { durationCode: "24h" } })).status, 201);
  assert.ok(!JSON.stringify(refused.json).includes(seller.userId));
});

test("503 propre (lot P3) : plus de connexion libre dans le pool → échec rapide en 503 boost_unavailable (jamais une attente sans fin) ; connexion rendue, la cotation fonctionne", async () => {
  const { offer } = await smallWorld(1);
  const tiny = new Pool({ connectionString: target.connectionString, max: 1, connectionTimeoutMillis: 300, options: `-c search_path=${schema}` });
  extraPools.push(tiny);
  const tinyHandlers = createBoostHttpHandlers({
    pool: tiny, now: clock.now, env, log,
    resolveSession: async () => ({ userId: seller.userId, expiresAt: new Date(Date.now() + 3_600_000) }),
  });
  const held = await tiny.connect();
  logs.length = 0;
  try {
    const started = Date.now();
    const busy = await post(offer.id, { handlers: tinyHandlers, body: { durationCode: "24h" } });
    assert.equal(busy.status, 503);
    assert.deepEqual(busy.json, FIXED_503);
    assert.ok(Date.now() - started < 3_000, `échec en ${Date.now() - started} ms (délai d'acquisition 300 ms)`);
    assert.deepEqual(logs, ["unexpected_error"], "journal : un code seulement");
  } finally {
    held.release();
  }
  assert.equal((await post(offer.id, { handlers: tinyHandlers, body: { durationCode: "24h" } })).status, 201);
});

test("503 propre (lot P3) : plus de créneau de calcul de portée → 503 boost_unavailable après l'attente maximale, journal quote_busy, rien d'écrit ; créneau libéré, la cotation fonctionne", async () => {
  const { offer } = await smallWorld(1);
  const slots: Array<() => void> = [];
  for (let index = 0; index < 4; index++) slots.push(await processReachGate.acquire(100));
  logs.length = 0;
  try {
    const started = Date.now();
    const busy = await post(offer.id, { body: { durationCode: "24h" } });
    assert.equal(busy.status, 503);
    assert.deepEqual(busy.json, FIXED_503);
    assert.ok(Date.now() - started >= 4_500 && Date.now() - started < 8_000, `attente maximale d'environ 5 s : ${Date.now() - started} ms`);
    assert.deepEqual(logs, ["quote_busy"]);
    assert.equal(await count(), 0, "rien d'écrit");
  } finally {
    for (const release of slots) release();
  }
  assert.equal((await post(offer.id, { body: { durationCode: "24h" } })).status, 201);
});

test("503 reach_check_unavailable (lot P3-bis, N3) : vérification de la portée non terminée à temps → 503 au texte fixe, Retry-After court, journal d'un code, AUCUN devis écrit ; la demande suivante aboutit (201) ; un devis réutilisable dont la revérification n'aboutit pas → même 503, devis intact", async () => {
  const { offer } = await smallWorld(1);
  const slowHandlers = createBoostHttpHandlers({
    pool: slowReachPool(pool), now: clock.now, env, log,
    resolveSession: async () => ({ userId: seller.userId, expiresAt: new Date(Date.now() + 3_600_000) }),
  });
  logs.length = 0;
  const slow = await post(offer.id, { handlers: slowHandlers, body: { durationCode: "24h" } });
  assert.equal(slow.status, 503);
  assert.deepEqual(slow.json, { error: { code: "reach_check_unavailable", message: "Vérification impossible pour le moment, réessayez dans un instant." } });
  assert.equal(slow.headers.find(([name]) => name === "retry-after")?.[1], "2", "Retry-After court");
  assert.deepEqual(logs, ["reach_check_unavailable"], "journal : un code seulement");
  assert.equal(await count(), 0, "rien d'écrit : un devis indéterminé ne doit pas être réutilisé");
  assert.ok(!slow.text.includes(seller.userId) && !slow.text.includes(offer.id));
  // La demande suivante (sans lenteur) calcule un devis disponible.
  const ok = await post(offer.id, { body: { durationCode: "24h" } });
  assert.equal(ok.status, 201);
  assert.equal(quoteOf(ok).status, "available");
  // Devis réutilisable, mais sa portée ne peut pas être revérifiée à temps : 503 (jamais le devis renvoyé « sur parole »), devis inchangé, aucune ligne de plus.
  logs.length = 0;
  const slowAgain = await post(offer.id, { handlers: slowHandlers, body: { durationCode: "24h" } });
  assert.equal(slowAgain.status, 503);
  assert.equal(errorCode(slowAgain), "reach_check_unavailable");
  assert.equal(await count(), 1);
  assert.equal(quoteOf(await post(offer.id, { body: { durationCode: "24h" } })).id, quoteOf(ok).id, "le devis d'origine est toujours réutilisé dès que la vérification aboutit");
});

test("DTO (lot P3) : inputs.reachTruncated est un booléen exposé tel que stocké (faux par défaut, vrai pour une estimation bornée), jamais autre chose", async () => {
  const { offer } = await smallWorld(1);
  const created = await post(offer.id, { body: { durationCode: "24h" } });
  assert.equal(quoteOf(created).inputs.reachTruncated, false);
  await pool.query("UPDATE boost_quotes SET reach_truncated = TRUE WHERE id = $1", [quoteOf(created).id]);
  const history = await list(offer.id);
  assert.equal(quotesOf(history)[0].inputs.reachTruncated, true);
  assert.equal(typeof quotesOf(history)[0].inputs.reachTruncated, "boolean");
  assert.equal(quoteOf(await post(offer.id, { body: { durationCode: "24h" } })).inputs.reachTruncated, true, "la cotation réutilisée porte le drapeau stocké");
});

test("en-têtes : toutes les réponses du fichier portaient Cache-Control: no-store, nosniff et du JSON ; tous les statuts attendus ont été exercés", () => {
  // La vérification est faite par reply() sur chaque réponse ; ici on s'assure que chaque famille de statut a bien été couverte.
  for (const status of [200, 201, 400, 401, 403, 404, 409, 429, 503]) assert.ok(statusesSeen.has(status), `statut ${status} exercé`);
  assert.ok(logs.every((code) => /^[A-Za-z0-9_]{1,40}$/.test(code)), `le journal ne contient que des codes : ${JSON.stringify(logs)}`);
});
