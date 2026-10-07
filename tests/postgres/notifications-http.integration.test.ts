import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import { Pool } from "pg";
import { requestOtp, verifyOtp, type SendOtpInput } from "../../lib/server/auth";
import { satisfyDemand } from "../../lib/server/catalog";
import {
  DEMAND_TRACKING_CONTRACT_VERSION, EXTERNAL_NOTICE, NOTIFICATIONS_CONTRACT_VERSION, NOTIFICATION_PREFERENCES_CONTRACT_VERSION,
} from "../../lib/server/notifications/config";
import { createNotificationsHttpHandlers, type NotificationsHttpDependencies, type NotificationsHttpHandlers } from "../../lib/server/notifications/http";
import { runMigrations } from "../../lib/server/postgres/migrations";
import * as notificationsRoute from "../../app/api/notifications/route";
import * as readRoute from "../../app/api/notifications/read/route";
import * as preferencesRoute from "../../app/api/notifications/preferences/route";
import * as trackingRoute from "../../app/api/demands/[id]/tracking/route";
import { makeDemand, makeOffer } from "./metrics-fixtures";
import {
  createTemporarySchemaName, openVerifiedIsolatedPool, openVerifiedTestDatabase, quoteTemporarySchema, type DedicatedTestDatabase,
} from "./test-database";

class TestClock {
  constructor(private timestamp: number) {}
  readonly now = (): Date => new Date(this.timestamp);
}

interface Login { userId: string; cookie: string; phone: string }

const SECRET = randomBytes(32);
const ORIGIN = "https://noma.test";
const FIXED_404 = { error: { code: "resource_not_found", message: "Ressource introuvable." } };
const schema = createTemporarySchemaName();
const quoted = quoteTemporarySchema(schema);
// Horloge figée à l'instant réel du démarrage : les dates de la base (création des besoins, suivi) sont celles de l'horloge réelle.
const clock = new TestClock(Date.now());
const logs: string[] = [];
const log = (code: string): void => { logs.push(code); };
let admin: Pool, pool: Pool;
let target: DedicatedTestDatabase;
let handlers: NotificationsHttpHandlers;
const makeHandlers = (extra: Partial<NotificationsHttpDependencies> = {}): NotificationsHttpHandlers =>
  createNotificationsHttpHandlers({ pool, now: clock.now, env: { NOMA_AUTH_ORIGIN: ORIGIN }, log, transportAvailable: () => false, ...extra });
let phoneSequence = 0;
let ipSequence = 0;

async function login(): Promise<Login> {
  phoneSequence += 1;
  ipSequence += 1;
  const phone = `+22507${phoneSequence.toString().padStart(8, "0")}`;
  let delivery: SendOtpInput | undefined;
  const requested = await requestOtp(phone, {
    pool, now: clock.now, authSecret: SECRET, requestIp: `198.51.100.${ipSequence}`,
    sendOtp: async (input) => { delivery = input; },
  });
  assert.ok(delivery);
  const verified = await verifyOtp(requested.challengeId, delivery.code, { pool, now: clock.now, authSecret: SECRET });
  await pool.query("INSERT INTO phone_identities (phone_e164, user_id, verified_at) VALUES ($1, $2, clock_timestamp()) ON CONFLICT DO NOTHING", [phone, verified.userId]);
  return { userId: verified.userId, cookie: `noma_auth=${verified.sessionToken}`, phone };
}

before(async () => {
  const opened = await openVerifiedTestDatabase(process.env.TEST_DATABASE_URL);
  admin = opened.pool;
  target = opened.target;
  await admin.query(`CREATE SCHEMA ${quoted}`);
  pool = await openVerifiedIsolatedPool(target, schema, (config) => new Pool({ ...config, max: 4 }));
  await runMigrations(pool);
  handlers = makeHandlers();
});

after(async () => {
  if (pool) await pool.end();
  if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${quoted} CASCADE`); await admin.end(); }
});

// Corps JSON de la réponse relu tel quel : les essais en vérifient la forme exacte champ par champ.
interface Reply { status: number; text: string; json: any; headers: Map<string, string> } // eslint-disable-line @typescript-eslint/no-explicit-any

async function reply(response: Response): Promise<Reply> {
  const text = await response.text();
  assert.equal(response.headers.get("cache-control"), "no-store", `Cache-Control sur ${response.status}`);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.match(response.headers.get("content-type") ?? "", /^application\/json/);
  return { status: response.status, text, json: JSON.parse(text), headers: new Map(response.headers.entries()) };
}

interface Call { cookie?: string | null; origin?: string | null; body?: string; contentType?: string | null; query?: string; handlers?: NotificationsHttpHandlers }

function request(method: "GET" | "POST" | "PUT", path: string, call: Call): Request {
  const headers: Record<string, string> = {};
  if (call.cookie) headers.cookie = call.cookie;
  const origin = call.origin === undefined ? ORIGIN : call.origin;
  if (method !== "GET" && origin !== null) headers.origin = origin;
  if (call.body !== undefined && call.contentType !== null) headers["content-type"] = call.contentType ?? "application/json";
  return new Request(`${ORIGIN}${path}${call.query ?? ""}`, { method, headers, ...(call.body !== undefined ? { body: call.body } : {}) });
}

const list = async (call: Call): Promise<Reply> => reply(await (call.handlers ?? handlers).notifications.list(request("GET", "/api/notifications", call)));
const read = async (call: Call): Promise<Reply> => reply(await (call.handlers ?? handlers).notifications.read(request("POST", "/api/notifications/read", call)));
const getPreferences = async (call: Call): Promise<Reply> => reply(await (call.handlers ?? handlers).preferences.get(request("GET", "/api/notifications/preferences", call)));
const putPreferences = async (call: Call): Promise<Reply> => reply(await (call.handlers ?? handlers).preferences.put(request("PUT", "/api/notifications/preferences", call)));
const getTracking = async (demandId: string, call: Call): Promise<Reply> => reply(await (call.handlers ?? handlers).tracking.get(request("GET", `/api/demands/${demandId}/tracking`, call), demandId));
const postTracking = async (demandId: string, call: Call): Promise<Reply> => reply(await (call.handlers ?? handlers).tracking.act(request("POST", `/api/demands/${demandId}/tracking`, call), demandId));

/** « Tout ce qui a été vu » : `{ all: true, upTo }` ; l'instant est très lointain quand l'essai ne teste pas la borne. */
const UP_TO_FAR = "2099-01-01T00:00:00.000Z";
const ALL_BODY = JSON.stringify({ all: true, upTo: UP_TO_FAR });

const reset = () => pool.query("TRUNCATE notification_deliveries, notifications, notification_preferences, matching_evaluations, matching_jobs, matching_outbox_events, demands, offers CASCADE");

/** `count` notifications `new_match` pour `userId`, de la plus ancienne (index 0) à la plus récente, plus un résumé s'il est demandé. */
async function seedNotifications(userId: string, count: number, options: { digest?: number } = {}): Promise<{ ids: string[]; demandId: string; offerIds: string[]; sellerPhone: string }> {
  const seller = await login();
  const demand = await makeDemand(pool, userId);
  const ids: string[] = [];
  const offerIds: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const offer = await makeOffer(pool, seller.userId, { price: 100_000 + index });
    offerIds.push(offer.id);
    const inserted = await pool.query<{ id: string }>(
      `INSERT INTO notifications (user_id, kind, demand_id, offer_id, title, price_amount, price_currency, created_at)
       VALUES ($1, 'new_match', $2, $3, $4, $5, 'XOF', TIMESTAMPTZ '2020-01-01 08:00:00+00' + ($6::int * interval '1 minute')) RETURNING id`,
      [userId, demand.id, offer.id, `Apple iPhone 13 n°${index}`, 100_000 + index, index],
    );
    ids.push(inserted.rows[0].id);
  }
  if (options.digest !== undefined) {
    const inserted = await pool.query<{ id: string }>(
      `INSERT INTO notifications (user_id, kind, demand_id, digest_day, item_count, created_at)
       VALUES ($1, 'new_matches_digest', $2, DATE '2020-01-01', $3, TIMESTAMPTZ '2020-01-01 09:00:00+00') RETURNING id`,
      [userId, demand.id, options.digest],
    );
    ids.push(inserted.rows[0].id);
  }
  return { ids, demandId: demand.id, offerIds, sellerPhone: seller.phone };
}

// ───────────── accès et origine ─────────────

test("sans session : 401 partout ; l'origine est vérifiée AVANT la session sur les écritures (403 sans cookie)", async () => {
  await reset();
  const anonymous = await login();
  const demand = await makeDemand(pool, anonymous.userId);
  for (const answered of [await list({}), await getPreferences({}), await getTracking(demand.id, {})]) {
    assert.equal(answered.status, 401);
    assert.deepEqual(answered.json, { error: { code: "authentication_required", message: "Authentification requise." } });
  }
  for (const answered of [
    await read({ body: ALL_BODY }),
    await putPreferences({ body: '{"externalEnabled":true}' }),
    await postTracking(demand.id, { body: '{"action":"pause"}' }),
  ]) {
    assert.equal(answered.status, 401, "origine valable, session absente");
  }
  for (const origin of [null, "https://evil.example", `${ORIGIN}/`, "http://noma.test"]) {
    for (const answered of [
      await read({ body: ALL_BODY, origin }),
      await putPreferences({ body: '{"externalEnabled":true}', origin }),
      await postTracking(demand.id, { body: '{"action":"pause"}', origin }),
      await read({ body: ALL_BODY, origin, cookie: anonymous.cookie }),
    ]) {
      assert.equal(answered.status, 403, `origine ${String(origin)} refusée avant la session`);
      assert.equal(answered.json.error.code, "invalid_origin");
    }
  }
  assert.equal((await pool.query("SELECT 1 FROM notification_preferences")).rowCount, 0, "aucune écriture après un refus");
  // Origine non configurée : 503 avant tout.
  const unconfigured = makeHandlers({ env: {} });
  assert.equal((await read({ body: ALL_BODY, cookie: anonymous.cookie, handlers: unconfigured })).status, 503);
  assert.ok(logs.includes("origin_unconfigured"));
  // Session inconnue ou invalide : 401.
  assert.equal((await list({ cookie: "noma_auth=inconnu" })).status, 401);
  assert.equal((await list({ cookie: "noma_auth=a; noma_auth=b" })).status, 401, "deux cookies : refusé");
});

// ───────────── lecture ─────────────

test("GET /api/notifications : liste vide, puis pages par curseur sans doublon, plus récentes d'abord, compteur TOTAL de non-lues ; DTO en liste blanche", async () => {
  await reset();
  const buyer = await login();
  const empty = await list({ cookie: buyer.cookie });
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.json, { contractVersion: NOTIFICATIONS_CONTRACT_VERSION, unreadCount: 0, items: [], nextCursor: null });

  const seeded = await seedNotifications(buyer.userId, 5, { digest: 7 });
  const pages: Array<{ id: string }> = [];
  let cursor: string | null = null;
  let guard = 0;
  do {
    const query: string = `?limit=2${cursor ? `&cursor=${cursor}` : ""}`;
    const page = await list({ cookie: buyer.cookie, query });
    assert.equal(page.status, 200);
    assert.equal(page.json.contractVersion, NOTIFICATIONS_CONTRACT_VERSION);
    assert.equal(page.json.unreadCount, 6, "le compteur est celui de TOUTES les non-lues, pas de la page");
    pages.push(...page.json.items);
    cursor = page.json.nextCursor;
    guard += 1;
  } while (cursor && guard < 10);
  assert.equal(pages.length, 6);
  assert.equal(new Set(pages.map((item) => item.id)).size, 6, "aucun doublon d'une page à l'autre");
  assert.deepEqual(pages.map((item) => item.id), [seeded.ids[5], seeded.ids[4], seeded.ids[3], seeded.ids[2], seeded.ids[1], seeded.ids[0]], "plus récentes d'abord (le résumé est le plus récent)");

  const full = await list({ cookie: buyer.cookie });
  const [digest, newest] = full.json.items;
  assert.deepEqual(Object.keys(digest).sort(), ["count", "createdAt", "demandId", "id", "kind", "link", "offerId", "price", "readAt", "title"]);
  assert.deepEqual({ kind: digest.kind, title: digest.title, price: digest.price, count: digest.count, offerId: digest.offerId, link: digest.link },
    { kind: "new_matches_digest", title: null, price: null, count: 7, offerId: null, link: `/besoins/${seeded.demandId}` });
  assert.deepEqual({ kind: newest.kind, title: newest.title, price: newest.price, count: newest.count, demandId: newest.demandId, offerId: newest.offerId, link: newest.link, readAt: newest.readAt },
    {
      kind: "new_match", title: "Apple iPhone 13 n°4", price: { amount: 100_004, currency: "XOF" }, count: null, demandId: seeded.demandId, offerId: seeded.offerIds[4],
      link: `/besoins/${seeded.demandId}/offres/${seeded.offerIds[4]}`, readAt: null,
    });
  assert.equal(newest.createdAt, "2020-01-01T08:04:00.000Z");
  // Jamais : utilisateur, vendeur, téléphone, texte libre.
  for (const forbidden of [seeded.sellerPhone, buyer.userId, buyer.phone, "RAW_SECRET", "user_id", "seller", "owner"]) {
    assert.equal(full.text.includes(forbidden), false, `réponse sans « ${forbidden} »`);
  }
});

test("GET /api/notifications : paramètres stricts (limit 1 à 50, cursor opaque, rien d'autre)", async () => {
  await reset();
  const buyer = await login();
  await seedNotifications(buyer.userId, 3);
  for (const query of ["?limit=0", "?limit=51", "?limit=abc", "?limit=-1", "?limit=1.5", "?limit=1&limit=2", "?page=2", "?cursor=!!!", "?cursor=", `?cursor=${"A".repeat(200)}`, "?limit=%20"]) {
    const answered = await list({ cookie: buyer.cookie, query });
    assert.equal(answered.status, 400, query);
    assert.deepEqual(answered.json, { error: { code: "invalid_request", message: "Requête invalide." } });
  }
  assert.equal((await list({ cookie: buyer.cookie, query: "?limit=50" })).json.items.length, 3);
  assert.equal((await list({ cookie: buyer.cookie, query: "?limit=1" })).json.items.length, 1);
});

test("isolation : un utilisateur ne voit JAMAIS les notifications d'un autre", async () => {
  await reset();
  const alice = await login();
  const bob = await login();
  await seedNotifications(alice.userId, 4);
  const asBob = await list({ cookie: bob.cookie });
  assert.equal(asBob.json.items.length, 0);
  assert.equal(asBob.json.unreadCount, 0);
  const asAlice = await list({ cookie: alice.cookie });
  assert.equal(asAlice.json.items.length, 4);
  assert.equal(asAlice.json.unreadCount, 4);
  // Un curseur d'Alice ne donne rien de plus à Bob.
  const cursor = (await list({ cookie: alice.cookie, query: "?limit=1" })).json.nextCursor as string;
  assert.equal((await list({ cookie: bob.cookie, query: `?cursor=${cursor}` })).json.items.length, 0);
});

// ───────────── marquer comme lu ─────────────

test("POST /api/notifications/read : par identifiants ou « tout », idempotent, compteur renvoyé", async () => {
  await reset();
  const buyer = await login();
  const seeded = await seedNotifications(buyer.userId, 4);
  const first = await read({ cookie: buyer.cookie, body: JSON.stringify({ ids: [seeded.ids[0], seeded.ids[1]] }) });
  assert.equal(first.status, 200);
  assert.deepEqual(first.json, { contractVersion: NOTIFICATIONS_CONTRACT_VERSION, marked: 2, unreadCount: 2 });
  const stamp = (await pool.query<{ read_at: Date }>("SELECT read_at FROM notifications WHERE id = $1", [seeded.ids[0]])).rows[0].read_at;
  const again = await read({ cookie: buyer.cookie, body: JSON.stringify({ ids: [seeded.ids[0], seeded.ids[0]] }) });
  assert.deepEqual(again.json, { contractVersion: NOTIFICATIONS_CONTRACT_VERSION, marked: 0, unreadCount: 2 }, "doublons dans la liste et notification déjà lue : sans effet");
  assert.equal((await pool.query<{ read_at: Date }>("SELECT read_at FROM notifications WHERE id = $1", [seeded.ids[0]])).rows[0].read_at.getTime(), stamp.getTime(), "la date de lecture ne bouge pas");
  const listed = await list({ cookie: buyer.cookie });
  assert.equal(listed.json.unreadCount, 2);
  assert.equal(listed.json.items.filter((item: { readAt: string | null }) => item.readAt !== null).length, 2);
  const all = await read({ cookie: buyer.cookie, body: ALL_BODY });
  assert.deepEqual(all.json, { contractVersion: NOTIFICATIONS_CONTRACT_VERSION, marked: 2, unreadCount: 0 });
  const allAgain = await read({ cookie: buyer.cookie, body: ALL_BODY });
  assert.deepEqual(allAgain.json, { contractVersion: NOTIFICATIONS_CONTRACT_VERSION, marked: 0, unreadCount: 0 });
});

test("POST /api/notifications/read : la notification d'un AUTRE ou inconnue donne le MÊME 404 et aucune n'est touchée (même mélangée aux siennes) ; « tout » ne touche que les siennes", async () => {
  await reset();
  const alice = await login();
  const bob = await login();
  const aliceSeed = await seedNotifications(alice.userId, 2);
  const bobSeed = await seedNotifications(bob.userId, 2);
  const unknown = "00000000-0000-4000-8000-000000000000";
  const other = await read({ cookie: bob.cookie, body: JSON.stringify({ ids: [aliceSeed.ids[0]] }) });
  const missing = await read({ cookie: bob.cookie, body: JSON.stringify({ ids: [unknown] }) });
  assert.equal(other.status, 404);
  assert.deepEqual(other.json, FIXED_404);
  assert.equal(other.text, missing.text, "indiscernable d'une notification inconnue (octet pour octet)");
  assert.equal(missing.status, 404);
  const mixed = await read({ cookie: bob.cookie, body: JSON.stringify({ ids: [bobSeed.ids[0], aliceSeed.ids[1]] }) });
  assert.equal(mixed.status, 404);
  assert.deepEqual(mixed.json, FIXED_404);
  assert.equal((await pool.query("SELECT 1 FROM notifications WHERE read_at IS NOT NULL")).rowCount, 0, "aucune notification n'a bougé, pas même celle de Bob");
  // « tout » : seulement les siennes.
  const all = await read({ cookie: bob.cookie, body: ALL_BODY });
  assert.deepEqual(all.json, { contractVersion: NOTIFICATIONS_CONTRACT_VERSION, marked: 2, unreadCount: 0 });
  assert.equal((await list({ cookie: alice.cookie })).json.unreadCount, 2, "celles d'Alice sont intactes");
});

test("POST /api/notifications/read { all: true, upTo } : ne marque que les notifications créées avant ou à `upTo` ; celles arrivées après le chargement restent non lues", async () => {
  await reset();
  const buyer = await login();
  const seeded = await seedNotifications(buyer.userId, 3);
  // L'écran charge la liste : la plus récente notification affichée donne `upTo`.
  const loaded = await list({ cookie: buyer.cookie });
  const upTo = loaded.json.items[0].createdAt as string;
  assert.match(upTo, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  // Une notification arrive APRÈS le chargement de l'écran.
  const seller = await login();
  const lateOffer = await makeOffer(pool, seller.userId, { price: 111_111 });
  const late = await pool.query<{ id: string }>(
    `INSERT INTO notifications (user_id, kind, demand_id, offer_id, title, price_amount, price_currency) VALUES ($1, 'new_match', $2, $3, 'Arrivée après le chargement', 111111, 'XOF') RETURNING id`,
    [buyer.userId, seeded.demandId, lateOffer.id],
  );
  const marked = await read({ cookie: buyer.cookie, body: JSON.stringify({ all: true, upTo }) });
  assert.equal(marked.status, 200);
  assert.deepEqual(marked.json, { contractVersion: NOTIFICATIONS_CONTRACT_VERSION, marked: 3, unreadCount: 1 }, "les trois affichées sont lues, l'arrivée tardive reste non lue");
  assert.equal((await pool.query<{ read_at: Date | null }>("SELECT read_at FROM notifications WHERE id = $1", [late.rows[0].id])).rows[0].read_at, null);
  assert.equal((await list({ cookie: buyer.cookie })).json.unreadCount, 1);
  // Idempotent ; une date plus récente marque ensuite la dernière.
  assert.equal((await read({ cookie: buyer.cookie, body: JSON.stringify({ all: true, upTo }) })).json.marked, 0);
  assert.equal((await read({ cookie: buyer.cookie, body: ALL_BODY })).json.unreadCount, 0);

  // Borne exacte, à la milliseconde : créée dans la même milliseconde que `upTo` (microsecondes comprises) = marquée ; une milliseconde plus tard = non marquée.
  await reset();
  const other = await login();
  const demand = await makeDemand(pool, other.userId);
  const insertAt = async (stamp: string, price: number): Promise<string> => {
    const offer = await makeOffer(pool, seller.userId, { price });
    return (await pool.query<{ id: string }>(
      `INSERT INTO notifications (user_id, kind, demand_id, offer_id, title, price_amount, price_currency, created_at) VALUES ($1, 'new_match', $2, $3, 't', $4, 'XOF', $5::timestamptz) RETURNING id`,
      [other.userId, demand.id, offer.id, price, stamp],
    )).rows[0].id;
  };
  const before = await insertAt("2021-01-01T09:59:59.999999Z", 120_001);
  const sameMillisecond = await insertAt("2021-01-01T10:00:00.000400Z", 120_002);
  const next = await insertAt("2021-01-01T10:00:00.001200Z", 120_003);
  const bounded = await read({ cookie: other.cookie, body: JSON.stringify({ all: true, upTo: "2021-01-01T10:00:00.000Z" }) });
  assert.deepEqual(bounded.json, { contractVersion: NOTIFICATIONS_CONTRACT_VERSION, marked: 2, unreadCount: 1 });
  const states = new Map((await pool.query<{ id: string; read_at: Date | null }>("SELECT id, read_at FROM notifications")).rows.map((row) => [row.id, row.read_at]));
  assert.notEqual(states.get(before), null);
  assert.notEqual(states.get(sameMillisecond), null);
  assert.equal(states.get(next), null, "créée une milliseconde plus tard : non marquée");
  // Jamais celles d'autrui, même avec une date très lointaine.
  const bystander = await login();
  assert.deepEqual((await read({ cookie: bystander.cookie, body: ALL_BODY })).json, { contractVersion: NOTIFICATIONS_CONTRACT_VERSION, marked: 0, unreadCount: 0 });
  assert.equal((await pool.query<{ read_at: Date | null }>("SELECT read_at FROM notifications WHERE id = $1", [next])).rows[0].read_at, null, "celle d'Alice/Bob n'est pas touchée par un tiers");
});

test("POST /api/notifications/read : corps strict (exactement ids OU all), origine, type de contenu, taille", async () => {
  await reset();
  const buyer = await login();
  const seeded = await seedNotifications(buyer.userId, 2);
  const id = seeded.ids[0];
  const many = Array.from({ length: 101 }, (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`);
  for (const body of [
    "", "{}", "[]", "null", "42", '"all"', '{"all":false}', '{"all":"true"}', '{"all":true,"ids":[]}', '{"all":true}', `{"all":true,"upTo":null}`, `{"all":true,"upTo":1}`, `{"all":true,"upTo":""}`, `{"all":true,"upTo":"2020-01-01"}`,
    `{"all":true,"upTo":"2020-01-01T00:00:00Z"}`, `{"all":true,"upTo":"2020-01-01T00:00:00.000+01:00"}`, `{"all":true,"upTo":"2020-01-01t00:00:00.000z"}`, `{"all":true,"upTo":"2020-13-45T00:00:00.000Z"}`,
    `{"all":true,"upTo":"2020-02-30T00:00:00.000Z"}`, `{"all":true,"upTo":"2020-01-01T00:00:00.000000Z"}`, `{"all":false,"upTo":"${UP_TO_FAR}"}`, `{"upTo":"${UP_TO_FAR}"}`, `{"all":true,"upTo":"${UP_TO_FAR}","extra":1}`,
    `{"ids":["${id}"],"upTo":"${UP_TO_FAR}"}`, `{"ids":["${id}"],"all":true}`, '{"ids":[]}', '{"ids":"x"}',
    '{"ids":["pas-un-uuid"]}', '{"ids":[1]}', `{"ids":[null]}`, JSON.stringify({ ids: many }), `{"ids":["${id}"],"extra":1}`, '{"all":true,"all":true}', "{pas du json", `{"x":"${"a".repeat(5_000)}"}`,
  ]) {
    const answered = await read({ cookie: buyer.cookie, body });
    assert.equal(answered.status, 400, body.slice(0, 60));
    assert.equal(answered.json.error.code, "invalid_request");
  }
  assert.equal((await read({ cookie: buyer.cookie, body: ALL_BODY, contentType: "text/plain" })).status, 400);
  assert.equal((await read({ cookie: buyer.cookie, body: ALL_BODY, contentType: null })).status, 400);
  assert.equal((await read({ cookie: buyer.cookie, body: ALL_BODY, query: "?x=1" })).status, 400);
  assert.equal((await pool.query("SELECT 1 FROM notifications WHERE read_at IS NOT NULL")).rowCount, 0, "aucun corps invalide n'a rien marqué");
  assert.equal((await read({ cookie: buyer.cookie, body: JSON.stringify({ ids: many.slice(0, 100) }) })).status, 404, "100 identifiants inconnus : 404, pas 400");
});

// ───────────── préférences ─────────────

test("préférences : désactivées par défaut, opt-in explicite, texte « pas encore disponibles » tant qu'aucun vrai transport n'existe, isolées par utilisateur", async () => {
  await reset();
  const alice = await login();
  const bob = await login();
  const initial = await getPreferences({ cookie: alice.cookie });
  assert.equal(initial.status, 200);
  assert.deepEqual(initial.json, {
    contractVersion: NOTIFICATION_PREFERENCES_CONTRACT_VERSION,
    preferences: { externalEnabled: false },
    external: { available: false, notice: "Les envois par SMS ne sont pas encore disponibles : ils sont simulés en développement." },
  });
  assert.equal(EXTERNAL_NOTICE, initial.json.external.notice);
  const enabled = await putPreferences({ cookie: alice.cookie, body: '{"externalEnabled":true}' });
  assert.equal(enabled.status, 200);
  assert.equal(enabled.json.preferences.externalEnabled, true);
  assert.equal((await getPreferences({ cookie: alice.cookie })).json.preferences.externalEnabled, true);
  assert.equal((await getPreferences({ cookie: bob.cookie })).json.preferences.externalEnabled, false, "Bob n'est pas touché");
  assert.equal((await putPreferences({ cookie: alice.cookie, body: '{"externalEnabled":false}' })).json.preferences.externalEnabled, false);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM notification_preferences")).rows[0].n, 1);
  // La disponibilité affichée suit l'environnement ; le texte reste le même tant que le transport est simulé.
  const available = makeHandlers({ transportAvailable: () => true });
  const withTransport = await getPreferences({ cookie: alice.cookie, handlers: available });
  assert.equal(withTransport.json.external.available, true);
  assert.equal(withTransport.json.external.notice, EXTERNAL_NOTICE);
  for (const body of ["", "{}", '{"externalEnabled":"true"}', '{"externalEnabled":1}', '{"externalEnabled":null}', '{"externalEnabled":true,"x":1}', '{"enabled":true}', "[]", '{"externalEnabled":true,"externalEnabled":false}']) {
    assert.equal((await putPreferences({ cookie: alice.cookie, body })).status, 400, body);
  }
  assert.equal((await getPreferences({ cookie: alice.cookie, query: "?x=1" })).status, 400);
});

// ───────────── suivi du besoin ─────────────

test("suivi : GET et POST réservés au propriétaire, 404 indiscernable pour un besoin d'autrui ou inconnu, actions prolonger / pause / reprise", async () => {
  await reset();
  const owner = await login();
  const stranger = await login();
  const demand = await makeDemand(pool, owner.userId);
  const initial = await getTracking(demand.id, { cookie: owner.cookie });
  assert.equal(initial.status, 200);
  assert.equal(initial.json.contractVersion, DEMAND_TRACKING_CONTRACT_VERSION);
  assert.deepEqual(Object.keys(initial.json.tracking).sort(), ["active", "demandId", "demandStatus", "maxUntil", "paused", "readAt", "until"]);
  assert.equal(initial.json.tracking.demandId, demand.id);
  assert.equal(initial.json.tracking.demandStatus, "active");
  assert.equal(initial.json.tracking.paused, false);
  assert.equal(initial.json.tracking.active, true);
  const createdAt = (await pool.query<{ created_at: Date }>("SELECT created_at FROM demands WHERE id = $1", [demand.id])).rows[0].created_at;
  assert.equal(initial.json.tracking.until, new Date(createdAt.getTime() + 30 * 86_400_000).toISOString(), "par défaut : création + 30 jours");
  assert.equal(initial.json.tracking.maxUntil, new Date(clock.now().getTime() + 90 * 86_400_000).toISOString());

  const unknown = "00000000-0000-4000-8000-000000000000";
  const foreign = await getTracking(demand.id, { cookie: stranger.cookie });
  const missing = await getTracking(unknown, { cookie: stranger.cookie });
  assert.equal(foreign.status, 404);
  assert.deepEqual(foreign.json, FIXED_404);
  assert.equal(foreign.text, missing.text, "indiscernable");
  for (const action of ["pause", "resume", "extend"]) {
    const refused = await postTracking(demand.id, { cookie: stranger.cookie, body: JSON.stringify({ action }) });
    assert.equal(refused.status, 404);
    assert.equal(refused.text, (await postTracking(unknown, { cookie: stranger.cookie, body: JSON.stringify({ action }) })).text);
  }
  assert.equal((await pool.query("SELECT notify_paused FROM demands WHERE id = $1", [demand.id])).rows[0].notify_paused, false, "l'étranger n'a rien changé");

  const paused = await postTracking(demand.id, { cookie: owner.cookie, body: '{"action":"pause"}' });
  assert.equal(paused.status, 200);
  assert.deepEqual({ paused: paused.json.tracking.paused, active: paused.json.tracking.active }, { paused: true, active: false });
  const resumed = await postTracking(demand.id, { cookie: owner.cookie, body: '{"action":"resume"}' });
  assert.deepEqual({ paused: resumed.json.tracking.paused, active: resumed.json.tracking.active }, { paused: false, active: true });
  let previous = Date.parse(resumed.json.tracking.until);
  const maxUntil = Date.parse(resumed.json.tracking.maxUntil);
  for (let index = 0; index < 5; index += 1) {
    const extended = await postTracking(demand.id, { cookie: owner.cookie, body: '{"action":"extend"}' });
    assert.equal(extended.status, 200);
    const until = Date.parse(extended.json.tracking.until);
    assert.ok(until >= previous, "jamais réduit");
    assert.ok(until <= maxUntil, "jamais au-delà de maintenant + 90 jours");
    previous = until;
  }
  assert.equal(previous, maxUntil, "plafonné à maintenant + 90 jours");
});

test("suivi : entrées strictes, besoin non actif refusé (409), identifiant invalide (400)", async () => {
  await reset();
  const owner = await login();
  const demand = await makeDemand(pool, owner.userId);
  for (const body of ["", "{}", '{"action":"stop"}', '{"action":1}', '{"action":"pause","x":1}', '{"act":"pause"}', "[]", '{"action":"pause","action":"resume"}']) {
    assert.equal((await postTracking(demand.id, { cookie: owner.cookie, body })).status, 400, body);
  }
  assert.equal((await postTracking(demand.id, { cookie: owner.cookie, body: '{"action":"pause"}', contentType: "text/plain" })).status, 400);
  assert.equal((await postTracking("pas-un-uuid", { cookie: owner.cookie, body: '{"action":"pause"}' })).status, 400);
  assert.equal((await getTracking("pas-un-uuid", { cookie: owner.cookie })).status, 400);
  assert.equal((await getTracking(demand.id, { cookie: owner.cookie, query: "?x=1" })).status, 400);
  await satisfyDemand(owner.userId, demand.id, demand.contentVersion, pool);
  const refused = await postTracking(demand.id, { cookie: owner.cookie, body: '{"action":"extend"}' });
  assert.equal(refused.status, 409);
  assert.deepEqual(refused.json, { error: { code: "demand_not_active", message: "Le suivi n'est disponible que pour un besoin actif." } });
  const state = await getTracking(demand.id, { cookie: owner.cookie });
  assert.equal(state.json.tracking.demandStatus, "satisfied");
  assert.equal(state.json.tracking.active, false);
});

// ───────────── pannes ─────────────

test("une panne de la base donne 503 avec un texte fixe ; le journal ne reçoit qu'un code, jamais le message", async () => {
  await reset();
  const owner = await login();
  logs.length = 0;
  const broken = makeHandlers({
    pool: { connect: async () => { throw Object.assign(new Error("hôte secret db.interne:5432 mot de passe"), { code: "ECONNREFUSED" }); }, query: async () => { throw Object.assign(new Error("hôte secret"), { code: "57P01" }); } } as unknown as Pool,
    resolveSession: async () => ({ userId: owner.userId } as never),
  });
  const demand = await makeDemand(pool, owner.userId);
  for (const answered of [
    await list({ cookie: owner.cookie, handlers: broken }),
    await read({ cookie: owner.cookie, handlers: broken, body: ALL_BODY }),
    await getPreferences({ cookie: owner.cookie, handlers: broken }),
    await putPreferences({ cookie: owner.cookie, handlers: broken, body: '{"externalEnabled":true}' }),
    await getTracking(demand.id, { cookie: owner.cookie, handlers: broken }),
    await postTracking(demand.id, { cookie: owner.cookie, handlers: broken, body: '{"action":"pause"}' }),
  ]) {
    assert.equal(answered.status, 503);
    assert.deepEqual(answered.json, { error: { code: "notifications_unavailable", message: "Le service est temporairement indisponible." } });
    assert.equal(answered.text.includes("secret"), false);
  }
  assert.ok(logs.length >= 6);
  assert.ok(logs.every((code) => /^[A-Za-z0-9_]{1,40}$/.test(code)), `codes seulement : ${logs.join(",")}`);
  assert.equal(logs.some((code) => /secret|interne|mot de passe/.test(code)), false);
  // Un journal qui lève ne change pas la réponse.
  const throwing = makeHandlers({ pool: { connect: async () => { throw new Error("x"); } } as unknown as Pool, resolveSession: async () => ({ userId: owner.userId } as never), log: () => { throw new Error("journal en panne"); } });
  assert.equal((await list({ cookie: owner.cookie, handlers: throwing })).status, 503);
});

test("les fichiers de routes existent et exposent les bonnes méthodes", () => {
  assert.equal(typeof notificationsRoute.GET, "function");
  assert.equal(typeof readRoute.POST, "function");
  assert.equal(typeof preferencesRoute.GET, "function");
  assert.equal(typeof preferencesRoute.PUT, "function");
  assert.equal(typeof trackingRoute.GET, "function");
  assert.equal(typeof trackingRoute.POST, "function");
  for (const route of [notificationsRoute, readRoute, preferencesRoute, trackingRoute]) {
    assert.equal(route.runtime, "nodejs");
    assert.equal(route.dynamic, "force-dynamic");
  }
  assert.equal((notificationsRoute as Record<string, unknown>).POST, undefined);
  assert.equal((readRoute as Record<string, unknown>).GET, undefined);
});
