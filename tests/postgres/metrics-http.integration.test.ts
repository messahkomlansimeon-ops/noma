import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import { Pool } from "pg";
import { requestOtp, verifyOtp, type SendOtpInput } from "../../lib/server/auth";
import type { OfferRecord } from "../../lib/server/catalog/types";
import { listStoredOfferMatchesForDemand } from "../../lib/server/matching/stored-matches";
import { runMigrations } from "../../lib/server/postgres/migrations";
import { CONTACT_DAILY_SELLER_LIMIT } from "../../lib/server/metrics/config";
import { createMetricsHttpHandlers, scheduleAfterResponse, type MetricsHttpDependencies, type MetricsHttpHandlers } from "../../lib/server/metrics/http";
import * as demandOfferRoute from "../../app/api/demands/[id]/offers/[offerId]/route";
import * as contactRoute from "../../app/api/demands/[id]/offers/[offerId]/contact/route";
import * as statsRoute from "../../app/api/offers/[id]/stats/route";
import { REACHABLE_LIST_SIZE, insertExposure, makeBoost, makeDemand, makeMatch, makeOffer } from "./metrics-fixtures";
import {
  createTemporarySchemaName, openVerifiedIsolatedPool, openVerifiedTestDatabase, quoteTemporarySchema, type DedicatedTestDatabase,
} from "./test-database";

// ───────────── infrastructure ─────────────

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
// 2032-01-01 10:00 UTC : il reste 14 h = 50 400 s avant minuit UTC.
const clock = new TestClock(Date.UTC(2032, 0, 1, 10));
const logs: string[] = [];
const log = (code: string): void => { logs.push(code); };
let admin: Pool, pool: Pool, lockPool: Pool;
let target: DedicatedTestDatabase;
let handlers: MetricsHttpHandlers;
/**
 * Planificateur d'essai (`after()` n'a pas de requête ici) : les écritures du journal des ouvertures sont MISES EN FILE et ne partent que quand l'essai appelle
 * `flush()` : preuve que le journal n'est jamais écrit avant la fin de la réponse (comme `after()` de Next.js).
 */
const scheduled: Array<() => Promise<void>> = [];
const schedule = (task: () => Promise<void>): void => { scheduled.push(task); };
async function flush(): Promise<void> {
  while (scheduled.length > 0) await scheduled.shift()!();
}
const makeHandlers = (extra: Partial<MetricsHttpDependencies> = {}): MetricsHttpHandlers =>
  createMetricsHttpHandlers({ pool, now: clock.now, env: { NOMA_AUTH_ORIGIN: ORIGIN }, log, schedule, ...extra });
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
  return { userId: verified.userId, cookie: `noma_auth=${verified.sessionToken}`, phone };
}

before(async () => {
  const opened = await openVerifiedTestDatabase(process.env.TEST_DATABASE_URL);
  admin = opened.pool;
  target = opened.target;
  await admin.query(`CREATE SCHEMA ${quoted}`);
  pool = await openVerifiedIsolatedPool(target, schema);
  await runMigrations(pool);
  lockPool = await openVerifiedIsolatedPool(target, schema);
  handlers = makeHandlers();
});

after(async () => {
  if (lockPool) await lockPool.end().catch(() => {});
  if (pool) await pool.end();
  if (admin) {
    await admin.query(`DROP SCHEMA IF EXISTS ${quoted} CASCADE`);
    await admin.end();
  }
});

// Les comptes (et leurs sessions) restent d'un essai à l'autre : seules les données métier sont vidées.
const reset = () => { scheduled.length = 0; return pool.query("TRUNCATE offer_views, offer_contacts, boost_exposures, offer_boosts, matching_evaluations, matching_jobs, matching_outbox_events, demands, offers CASCADE"); };
const count = async (table: string): Promise<number> => (await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n;

// ───────────── requêtes et réponses ─────────────

interface Reply { status: number; text: string; json: unknown; headers: Map<string, string> }

async function reply(response: Response): Promise<Reply> {
  const text = await response.text();
  assert.equal(response.headers.get("cache-control"), "no-store", `Cache-Control sur ${response.status}`);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff", `nosniff sur ${response.status}`);
  assert.match(response.headers.get("content-type") ?? "", /^application\/json/);
  return { status: response.status, text, json: JSON.parse(text), headers: new Map(response.headers.entries()) };
}

interface Call { cookie?: string | null; origin?: string | null; body?: string; handlers?: MetricsHttpHandlers; query?: string; keepWrites?: boolean }

function request(method: "GET" | "POST", path: string, call: Call): Request {
  const headers: Record<string, string> = {};
  if (call.cookie) headers.cookie = call.cookie;
  const origin = call.origin === undefined ? ORIGIN : call.origin;
  if (method === "POST" && origin !== null) headers.origin = origin;
  if (call.body !== undefined) headers["content-type"] = "application/json";
  return new Request(`${ORIGIN}${path}${call.query ?? ""}`, { method, headers, ...(call.body !== undefined ? { body: call.body } : {}) });
}

/** Lit la fiche puis, sauf `keepWrites`, exécute les écritures du journal mises en file (la réponse est déjà lue : elles viennent « après »). */
const getOffer = async (demandId: string, offerId: string, call: Call): Promise<Reply> => {
  const answered = await reply(await (call.handlers ?? handlers).demandOffers.get(request("GET", `/api/demands/${demandId}/offers/${offerId}`, call), demandId, offerId));
  if (!call.keepWrites) await flush();
  return answered;
};
const contact = async (demandId: string, offerId: string, call: Call): Promise<Reply> =>
  reply(await (call.handlers ?? handlers).demandOffers.contact(request("POST", `/api/demands/${demandId}/offers/${offerId}/contact`, call), demandId, offerId));
const getStats = async (offerId: string, call: Call): Promise<Reply> =>
  reply(await (call.handlers ?? handlers).offers.stats(request("GET", `/api/offers/${offerId}/stats`, call), offerId));

const sortedKeys = (value: unknown): string[] => Object.keys(value as object).sort();
/** Nœud d'un DTO de statistiques lu en JSON : on descend par clés sans typer chaque forme. */
type StatsNode = { [key: string]: StatsNode } & { kind?: string; value?: number; bound?: number; period?: string; boostId?: string };
const asRecord = (reply: Reply): Record<string, unknown> => reply.json as Record<string, unknown>;

interface World { seller: Login; buyer: Login; offer: OfferRecord; demandId: string }

async function world(options: { attributes?: Record<string, string> | null; sellerLogin?: Login } = {}): Promise<World> {
  await reset();
  const seller = options.sellerLogin ?? await login();
  const buyer = await login();
  const offer = await makeOffer(pool, seller.userId, { attributes: options.attributes ?? null });
  const demand = await makeDemand(pool, buyer.userId);
  await makeMatch(pool, offer, demand);
  return { seller, buyer, offer, demandId: demand.id };
}

// ═════════════ 1. Routes Next ═════════════

test("routes : GET fiche, POST contact et GET statistiques existent, sont dynamiques et nodejs, et ne portent pas d'autre méthode", () => {
  for (const route of [demandOfferRoute, contactRoute, statsRoute]) {
    assert.equal(route.runtime, "nodejs");
    assert.equal(route.dynamic, "force-dynamic");
  }
  assert.equal(typeof demandOfferRoute.GET, "function");
  assert.equal(typeof contactRoute.POST, "function");
  assert.equal(typeof statsRoute.GET, "function");
  for (const forbidden of ["POST", "PUT", "PATCH", "DELETE"]) assert.equal((demandOfferRoute as Record<string, unknown>)[forbidden], undefined, `fiche : ${forbidden}`);
  for (const forbidden of ["GET", "PUT", "PATCH", "DELETE"]) assert.equal((contactRoute as Record<string, unknown>)[forbidden], undefined, `contact : ${forbidden}`);
  for (const forbidden of ["POST", "PUT", "PATCH", "DELETE"]) assert.equal((statsRoute as Record<string, unknown>)[forbidden], undefined, `statistiques : ${forbidden}`);
});

// ═════════════ 2. Fiche (GET) ═════════════

test("fiche : authentification (401 sans cookie ou cookie invalide), identifiants et requête stricts (400)", async () => {
  const w = await world();
  assert.equal((await getOffer(w.demandId, w.offer.id, {})).status, 401);
  assert.equal((await getOffer(w.demandId, w.offer.id, { cookie: "noma_auth=invalide" })).status, 401);
  for (const [demandId, offerId] of [["pas-un-uuid", w.offer.id], [w.demandId, "pas-un-uuid"], ["", w.offer.id]] as const) {
    const response = await getOffer(demandId, offerId, { cookie: w.buyer.cookie });
    assert.equal(response.status, 400, `${demandId}/${offerId}`);
  }
  assert.equal((await getOffer(w.demandId, w.offer.id, { cookie: w.buyer.cookie, query: "?limit=5" })).status, 400, "aucun paramètre de requête");
  assert.equal(await count("offer_views"), 0, "aucune ouverture pour un refus");
});

test("fiche : 404 STRICTEMENT identique pour tout accès refusé (autre acheteur, besoin d'autrui, annonce hors correspondances, vendeur lui-même, besoin clos, inconnus) ; rien d'enregistré", async () => {
  const w = await world();
  const stranger = await login();
  const strangerDemand = await makeDemand(pool, stranger.userId);
  const unrelated = await makeOffer(pool, w.seller.userId, { model: "iPhone 14" });
  const cases: Array<[string, () => Promise<Reply>]> = [
    ["autre acheteur sur le besoin", () => getOffer(w.demandId, w.offer.id, { cookie: stranger.cookie })],
    ["besoin d'autrui", () => getOffer(strangerDemand.id, w.offer.id, { cookie: w.buyer.cookie })],
    ["son besoin, annonce hors correspondances", () => getOffer(w.demandId, unrelated.id, { cookie: w.buyer.cookie })],
    ["le vendeur sur le besoin de l'acheteur", () => getOffer(w.demandId, w.offer.id, { cookie: w.seller.cookie })],
    ["annonce inconnue", () => getOffer(w.demandId, "0f6b72e6-ad2b-4a9f-84f8-a56a4f4572dc", { cookie: w.buyer.cookie })],
    ["besoin inconnu", () => getOffer("0f6b72e6-ad2b-4a9f-84f8-a56a4f4572dc", w.offer.id, { cookie: w.buyer.cookie })],
  ];
  const results: Array<[string, Reply]> = [];
  for (const [label, run] of cases) results.push([label, await run()]);
  await pool.query("UPDATE demands SET status = 'satisfied' WHERE id = $1", [w.demandId]);
  results.push(["besoin clos", await getOffer(w.demandId, w.offer.id, { cookie: w.buyer.cookie })]);
  await pool.query("UPDATE demands SET status = 'active' WHERE id = $1", [w.demandId]);
  for (const [label, response] of results) {
    assert.equal(response.status, 404, label);
    assert.deepEqual(response.json, FIXED_404, label);
    assert.equal(response.text, results[0][1].text, `${label} : corps identique`);
    assert.equal(response.headers.get("content-type"), results[0][1].headers.get("content-type"), `${label} : même type`);
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
  assert.equal(await count("offer_views"), 0, "aucun refus n'enregistre d'ouverture");
});

test("fiche : DTO en LISTE BLANCHE — clés exactes, ni téléphone, ni identifiant du vendeur, ni texte brut, ni identifiant de boost ; attributs publics filtrés ; no-store", async () => {
  const w = await world({ attributes: { couleur: "noir", stockage: { value: 128, unit: "Go" }, contact: "07 00 00 00 99", note: "appelez le 0700000099", __secret: "x", nested: { a: 1 } } as never });
  const response = await getOffer(w.demandId, w.offer.id, { cookie: w.buyer.cookie });
  assert.equal(response.status, 200);
  assert.deepEqual(sortedKeys(response.json), ["contractVersion", "details", "item", "readAt"]);
  assert.equal(asRecord(response).contractVersion, "demand-offer/v1");
  const body = response.json as { item: Record<string, unknown> & { candidate: Record<string, unknown> }; details: { createdAt: string; attributes: Array<{ key: string; value: string }> } };
  // L'élément a EXACTEMENT les clés de la liste des résultats.
  const page = await listStoredOfferMatchesForDemand(w.buyer.userId, w.demandId, { sort: "relevance" }, pool);
  assert.ok(page.items.length === 1);
  assert.deepEqual(sortedKeys(body.item), sortedKeys({
    candidateId: 1, candidateContentVersion: 1, candidate: 1, compatibilityStatus: 1, score: 1, coverage: 1, evaluation: 1, scoring: 1, evaluatedAt: 1, indicators: 1, relevance: 1, sponsored: 1,
  }));
  assert.deepEqual(sortedKeys(body.item.candidate), sortedKeys({
    id: 1, contentVersion: 1, category: 1, brand: 1, model: 1, variant: 1, condition: 1, quantity: 1, unit: 1, location: 1, deadlineAt: 1, price: 1, availabilityStatus: 1,
  }));
  assert.deepEqual(sortedKeys(body.details), ["attributes", "createdAt"]);
  assert.deepEqual(body.details.attributes, [{ key: "couleur", value: "noir" }, { key: "stockage", value: "128 Go" }], "seuls les attributs publics, sans numéro de téléphone");
  assert.equal(body.item.candidateId, w.offer.id);
  assert.equal(body.item.sponsored, false);
  assert.equal(response.headers.get("cache-control"), "no-store");
  // Aucune fuite, dans le corps BRUT.
  const secrets = [w.seller.userId, w.seller.phone, w.seller.phone.slice(4), w.seller.phone.slice(1), "0700000099", "07 00 00 00 99", "RAW_SECRET_TEXT", "ownerId", "owner_id", "sellerId", "boostId", "boost_id", "viewer", "rawText"];
  for (const secret of secrets) assert.equal(response.text.includes(secret), false, `le corps ne doit pas contenir ${secret}`);
  assert.equal(response.text.includes(w.buyer.userId), false, "pas même l'identifiant de l'acheteur");
});

test("fiche : l'ouverture est enregistrée côté serveur à chaque lecture réussie (une ligne par jour, compteur), jamais pour un refus ; le vendeur n'est jamais compté", async () => {
  const w = await world();
  for (let index = 0; index < 3; index++) assert.equal((await getOffer(w.demandId, w.offer.id, { cookie: w.buyer.cookie })).status, 200);
  const rows = (await pool.query<{ viewer_id: string; views: number; boosted_views: number; boost_id: string | null }>("SELECT viewer_id, views, boosted_views, boost_id FROM offer_views")).rows;
  assert.deepEqual(rows, [{ viewer_id: w.buyer.userId, views: 3, boosted_views: 0, boost_id: null }]);
  // Le vendeur qui ouvre sa propre annonce : refus 404 et rien d'écrit, même avec un besoin à lui.
  const sellerDemand = await makeDemand(pool, w.seller.userId);
  assert.equal((await getOffer(sellerDemand.id, w.offer.id, { cookie: w.seller.cookie })).status, 404);
  assert.equal((await getOffer(w.demandId, w.offer.id, { cookie: w.seller.cookie })).status, 404);
  assert.equal(await count("offer_views"), 1);
});

test("fiche : « Sponsorisé » relu par le serveur et attribution de l'ouverture au boost quand l'acheteur l'a vu sponsorisé dans les résultats", async () => {
  await reset();
  const seller = await login();
  const buyer = await login();
  const offer = await makeOffer(pool, seller.userId);
  const demand = await makeDemand(pool, buyer.userId);
  // Liste de 7 : quota 1 ; l'annonce est évaluée EN PREMIER (classée après les remplissages plus compatibles) : un boost la fait monter.
  await makeMatch(pool, offer, demand);
  for (let index = 1; index < REACHABLE_LIST_SIZE; index++) {
    const filler = await makeOffer(pool, seller.userId, { model: `FILLER-${index}`, price: 90_000 + index });
    await makeMatch(pool, filler, demand, 100);
  }
  const boost = await makeBoost(pool, offer);
  const first = await getOffer(demand.id, offer.id, { cookie: buyer.cookie });
  assert.equal((first.json as { item: { sponsored: boolean } }).item.sponsored, true, "boost effectif, place gagnée : sponsorisé");
  assert.equal((await pool.query("SELECT boost_id FROM offer_views")).rows[0].boost_id, null, "pas encore vu sponsorisé dans une liste : ouverture organique");
  await pool.query("DELETE FROM offer_views");
  // La liste des résultats sert l'annonce sponsorisée (journal d'exposition), puis la fiche est ouverte : attribuée.
  const results = await listStoredOfferMatchesForDemand(buyer.userId, demand.id, { sort: "relevance" }, pool);
  assert.equal(results.items.find((item) => item.candidateId === offer.id)?.sponsored, true);
  const opened = await getOffer(demand.id, offer.id, { cookie: buyer.cookie });
  assert.equal((opened.json as { item: { sponsored: boolean } }).item.sponsored, true);
  const stored = (await pool.query<{ boost_id: string | null; boosted_views: number }>("SELECT boost_id, boosted_views FROM offer_views")).rows[0];
  assert.deepEqual([stored.boost_id, stored.boosted_views], [boost, 1]);
  assert.equal(opened.text.includes(boost), false, "l'identifiant du boost ne sort jamais");
  // Sans boost effectif : organique.
  await pool.query("UPDATE offer_boosts SET status = 'expired' WHERE id = $1", [boost]);
  assert.equal(((await getOffer(demand.id, offer.id, { cookie: buyer.cookie })).json as { item: { sponsored: boolean } }).item.sponsored, false);
});

test("fiche : un journal en panne ne casse JAMAIS la lecture (table absente, erreur inattendue avec un message sensible, délai de verrou) ; seul un code est journalisé", async () => {
  const w = await world();
  const control = await getOffer(w.demandId, w.offer.id, { cookie: w.buyer.cookie });
  assert.equal(control.status, 200);
  const stable = (reply: Reply) => { const { readAt, ...rest } = reply.json as Record<string, unknown>; void readAt; return rest; };
  await pool.query("DELETE FROM offer_views");
  // 1. Table absente (42P01).
  logs.length = 0;
  await pool.query("ALTER TABLE offer_views RENAME TO offer_views_hors_service");
  try {
    const broken = await getOffer(w.demandId, w.offer.id, { cookie: w.buyer.cookie });
    assert.equal(broken.status, 200);
    assert.deepEqual(stable(broken), stable(control), "même réponse, avec ou sans journal");
    assert.deepEqual(logs, ["offer_view_ignored_42P01"]);
  } finally {
    await pool.query("ALTER TABLE offer_views_hors_service RENAME TO offer_views");
  }
  // 2. Erreur inattendue dont le message contient un numéro et un identifiant : jamais journalisés, jamais renvoyés.
  logs.length = 0;
  const secretive = makeHandlers({
    recordView: async () => { throw new Error(`échec secret ${w.seller.phone} ${w.seller.userId}`); },
  });
  const survived = await getOffer(w.demandId, w.offer.id, { cookie: w.buyer.cookie, handlers: secretive });
  assert.equal(survived.status, 200);
  assert.deepEqual(stable(survived), stable(control));
  assert.deepEqual(logs, ["offer_view_ignored_unexpected_error"]);
  assert.equal(logs.join().includes(w.seller.phone), false);
  assert.equal(survived.text.includes("secret"), false);
  // 3. Verrou tenu : la fiche répond tout de suite (l'écriture vient APRÈS la réponse) ; l'écriture est abandonnée au bout du délai court (2 s) avec UN seul code.
  const holder = await lockPool.connect();
  logs.length = 0;
  try {
    await holder.query("BEGIN");
    await holder.query("LOCK TABLE offer_views IN ACCESS EXCLUSIVE MODE");
    const started = Date.now();
    const blocked = await getOffer(w.demandId, w.offer.id, { cookie: w.buyer.cookie, keepWrites: true });
    const answeredIn = Date.now() - started;
    assert.equal(blocked.status, 200);
    assert.deepEqual(stable(blocked), stable(control));
    assert.ok(answeredIn < 300, `la fiche ne dépend pas du journal : ${answeredIn} ms`);
    assert.deepEqual(logs, [], "rien n'est journalisé avant l'écriture");
    const writeStarted = Date.now();
    await flush();
    const writeTook = Date.now() - writeStarted;
    assert.ok(writeTook >= 1_500 && writeTook < 4_500, `délai court de l'écriture (≈ 2 s) : ${writeTook} ms`);
    assert.deepEqual(logs, ["offer_view_ignored_57014"], "délai d'instruction dépassé : un seul code");
  } finally {
    await holder.query("ROLLBACK");
    holder.release();
  }
  // Le journal repart dès que le verrou tombe.
  assert.equal((await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM offer_views")).rows[0].n, 0, "les lectures en panne n'ont rien écrit");
  assert.equal((await getOffer(w.demandId, w.offer.id, { cookie: w.buyer.cookie })).status, 200);
  assert.equal((await pool.query<{ views: number }>("SELECT views FROM offer_views")).rows[0].views, 1, "la lecture suivante est comptée");
});

test("fiche (M1) : le journal des ouvertures est écrit APRÈS l'envoi de la réponse — table verrouillée, la fiche répond en moins de 300 ms ; l'ouverture est écrite dès que le verrou tombe, dans le délai de 2 s", async () => {
  const w = await world();
  const holder = await lockPool.connect();
  try {
    await holder.query("BEGIN");
    await holder.query("LOCK TABLE offer_views IN ACCESS EXCLUSIVE MODE");
    logs.length = 0;
    const started = Date.now();
    const answered = await getOffer(w.demandId, w.offer.id, { cookie: w.buyer.cookie, keepWrites: true });
    const answeredIn = Date.now() - started;
    assert.equal(answered.status, 200);
    assert.ok(answeredIn < 300, `la fiche ne doit pas attendre le journal : ${answeredIn} ms`);
    assert.equal(scheduled.length, 1, "UNE écriture est planifiée, pas encore exécutée : rien n'est écrit avant la fin de la réponse");
    // Le verrou tombe 500 ms après le début de l'écriture : l'écriture (délai de 2 s) aboutit.
    const writing = flush();
    await new Promise((resolve) => setTimeout(resolve, 500));
    await holder.query("ROLLBACK");
    await writing;
  } finally {
    holder.release();
  }
  assert.deepEqual(logs, [], "aucun code journalisé : l'écriture a réussi");
  const rows = (await pool.query<{ viewer_id: string; views: number }>("SELECT viewer_id, views FROM offer_views")).rows;
  assert.deepEqual(rows, [{ viewer_id: w.buyer.userId, views: 1 }], "l'ouverture est bien écrite, une fois");
});

test("fiche (M1) : le planificateur par défaut est `after()` de Next.js (il exige une requête en cours) ; sans requête, la fiche répond quand même et UN code est journalisé", async () => {
  const w = await world();
  // Hors requête Next, `after()` lève : le planificateur par défaut est donc bien celui de Next.js (pas une promesse lancée à la main).
  assert.throws(() => scheduleAfterResponse(async () => {}), /outside a request scope/);
  logs.length = 0;
  const bare = makeHandlers({ schedule: undefined });
  const answered = await getOffer(w.demandId, w.offer.id, { cookie: w.buyer.cookie, handlers: bare });
  assert.equal(answered.status, 200, "la fiche n'est jamais cassée par le journal");
  assert.deepEqual(logs, ["offer_view_ignored_unexpected_error"], "un seul code");
  assert.equal(await count("offer_views"), 0);
});

// ═════════════ 3. Contact (POST) ═════════════

test("contact : origine vérifiée AVANT la session (403 sans cookie), puis 401 ; origine non configurée → 503 ; identifiants, corps et requête stricts (400)", async () => {
  const w = await world();
  for (const origin of [null, "https://autre.test", "http://noma.test", `${ORIGIN}/`, "null"]) {
    const response = await contact(w.demandId, w.offer.id, { origin });
    assert.equal(response.status, 403, String(origin));
    assert.deepEqual(response.json, { error: { code: "invalid_origin", message: "Origine de la requête non autorisée." } });
    const authenticated = await contact(w.demandId, w.offer.id, { origin, cookie: w.buyer.cookie });
    assert.equal(authenticated.status, 403, `${String(origin)} avec session valide : toujours 403`);
  }
  assert.equal((await contact(w.demandId, w.offer.id, {})).status, 401);
  assert.equal((await contact(w.demandId, w.offer.id, { cookie: "noma_auth=invalide" })).status, 401);
  const unconfigured = makeHandlers({ env: {} });
  assert.equal((await contact(w.demandId, w.offer.id, { handlers: unconfigured, cookie: w.buyer.cookie })).status, 503);
  for (const [demandId, offerId] of [["x", w.offer.id], [w.demandId, "x"]] as const) assert.equal((await contact(demandId, offerId, { cookie: w.buyer.cookie })).status, 400);
  assert.equal((await contact(w.demandId, w.offer.id, { cookie: w.buyer.cookie, query: "?a=1" })).status, 400);
  assert.equal((await contact(w.demandId, w.offer.id, { cookie: w.buyer.cookie, body: JSON.stringify({ phone: "x" }) })).status, 400, "aucun corps utile");
  assert.equal((await contact(w.demandId, w.offer.id, { cookie: w.buyer.cookie, body: "pas du json" })).status, 400);
  assert.equal(await count("offer_contacts"), 0, "aucun contact pour un refus");
});

test("contact : 200 avec le numéro vérifié E.164 et les liens tel: et https://wa.me/<chiffres> ; no-store ; chaque révélation compte ; corps vide ou {} acceptés", async () => {
  const w = await world();
  const first = await contact(w.demandId, w.offer.id, { cookie: w.buyer.cookie });
  assert.equal(first.status, 200);
  assert.equal(first.headers.get("cache-control"), "no-store");
  assert.deepEqual(first.json, {
    contractVersion: "offer-contact/v1",
    contact: { phone: w.seller.phone, telUrl: `tel:${w.seller.phone}`, whatsappUrl: `https://wa.me/${w.seller.phone.slice(1)}`, firstContact: true },
  });
  assert.match(w.seller.phone, /^\+[1-9][0-9]{1,14}$/);
  assert.equal(first.text.includes(w.seller.userId), false, "jamais l'identifiant du vendeur");
  assert.equal(first.text.includes(w.buyer.userId), false);
  const second = await contact(w.demandId, w.offer.id, { cookie: w.buyer.cookie, body: "{}" });
  assert.equal(second.status, 200);
  assert.equal((second.json as { contact: { firstContact: boolean } }).contact.firstContact, false);
  const row = (await pool.query<{ reveals: number; viewer_id: string }>("SELECT reveals, viewer_id FROM offer_contacts")).rows;
  assert.deepEqual(row, [{ reveals: 2, viewer_id: w.buyer.userId }]);
});

test("contact : 404 IDENTIQUE à celui de la fiche pour tout accès refusé ; le vendeur ne peut pas se contacter lui-même ; rien d'écrit ni révélé", async () => {
  const w = await world();
  const stranger = await login();
  const strangerDemand = await makeDemand(pool, stranger.userId);
  const unrelated = await makeOffer(pool, w.seller.userId, { model: "iPhone 14" });
  const attempts: Array<[string, Reply]> = [
    ["autre acheteur", await contact(w.demandId, w.offer.id, { cookie: stranger.cookie })],
    ["besoin d'autrui", await contact(strangerDemand.id, w.offer.id, { cookie: w.buyer.cookie })],
    ["hors correspondances", await contact(w.demandId, unrelated.id, { cookie: w.buyer.cookie })],
    ["le vendeur lui-même", await contact(w.demandId, w.offer.id, { cookie: w.seller.cookie })],
    ["annonce inconnue", await contact(w.demandId, "0f6b72e6-ad2b-4a9f-84f8-a56a4f4572dc", { cookie: w.buyer.cookie })],
  ];
  for (const [label, response] of attempts) {
    assert.equal(response.status, 404, label);
    assert.deepEqual(response.json, FIXED_404, label);
    assert.equal(response.text.includes(w.seller.phone), false, label);
  }
  await pool.query("UPDATE demands SET status = 'satisfied' WHERE id = $1", [w.demandId]);
  const closed = await contact(w.demandId, w.offer.id, { cookie: w.buyer.cookie });
  assert.deepEqual([closed.status, closed.json], [404, FIXED_404], "besoin clos");
  const viaFiche = await getOffer(w.demandId, w.offer.id, { cookie: w.buyer.cookie });
  assert.equal(closed.text, viaFiche.text, "même corps que la fiche");
  assert.equal(await count("offer_contacts"), 0);
});

test("contact : annonce en pause, retirée ou vendue → 409 offer_not_available, aucun numéro dans la réponse, rien d'écrit ; vendeur sans numéro vérifié → 409 contact_unavailable", async () => {
  const w = await world();
  for (const sql of [
    "UPDATE offers SET status = 'paused' WHERE id = $1",
    "UPDATE offers SET status = 'published', availability_status = 'unavailable' WHERE id = $1",
    "UPDATE offers SET status = 'archived', archived_at = clock_timestamp(), availability_status = 'available' WHERE id = $1",
  ]) {
    await pool.query("UPDATE offers SET status = 'published', archived_at = NULL, availability_status = 'available' WHERE id = $1", [w.offer.id]);
    await pool.query(sql, [w.offer.id]);
    const response = await contact(w.demandId, w.offer.id, { cookie: w.buyer.cookie });
    assert.equal(response.status, 409, sql);
    assert.deepEqual(response.json, { error: { code: "offer_not_available", message: "Cette annonce n'est plus disponible." } });
    assert.equal(response.text.includes(w.seller.phone), false);
    assert.equal(response.text.includes(w.seller.phone.slice(4)), false);
  }
  assert.equal(await count("offer_contacts"), 0);
  // Vendeur sans numéro vérifié.
  await pool.query("UPDATE offers SET status = 'published', archived_at = NULL, availability_status = 'available' WHERE id = $1", [w.offer.id]);
  await pool.query("DELETE FROM phone_identities WHERE user_id = $1", [w.seller.userId]);
  const unreachable = await contact(w.demandId, w.offer.id, { cookie: w.buyer.cookie });
  assert.deepEqual([unreachable.status, unreachable.json], [409, { error: { code: "contact_unavailable", message: "Le contact de ce vendeur n'est pas disponible." } }]);
  assert.equal(await count("offer_contacts"), 0);
});

test(`contact : au plus ${CONTACT_DAILY_SELLER_LIMIT} vendeurs distincts par acheteur et par jour UTC → 429 rate_limited avec Retry-After (secondes jusqu'à minuit UTC) ; les vendeurs déjà révélés restent accessibles`, async () => {
  await reset();
  const buyer = await login();
  const demand = await makeDemand(pool, buyer.userId);
  const offers: OfferRecord[] = [];
  for (let index = 0; index < CONTACT_DAILY_SELLER_LIMIT + 1; index++) {
    const seller = await login();
    const offer = await makeOffer(pool, seller.userId);
    await makeMatch(pool, offer, demand);
    offers.push(offer);
  }
  for (const offer of offers.slice(0, CONTACT_DAILY_SELLER_LIMIT)) assert.equal((await contact(demand.id, offer.id, { cookie: buyer.cookie })).status, 200);
  const refused = await contact(demand.id, offers[CONTACT_DAILY_SELLER_LIMIT].id, { cookie: buyer.cookie });
  assert.equal(refused.status, 429);
  assert.deepEqual(refused.json, { error: { code: "rate_limited", message: `Vous avez déjà contacté ${CONTACT_DAILY_SELLER_LIMIT} vendeurs aujourd'hui : réessayez demain.` } });
  assert.equal(refused.headers.get("retry-after"), "50400");
  assert.equal(await count("offer_contacts"), CONTACT_DAILY_SELLER_LIMIT);
  assert.equal((await contact(demand.id, offers[0].id, { cookie: buyer.cookie })).status, 200, "un vendeur déjà révélé l'est de nouveau");
});

test("contact : attribution au boost au premier contact (servie sponsorisée dans les 7 jours)", async () => {
  const w = await world();
  const boost = await makeBoost(pool, w.offer);
  await insertExposure(pool, { boostId: boost, offerId: w.offer.id, demandId: w.demandId, viewerId: w.buyer.userId, firstServedAgo: "2 days" });
  assert.equal((await contact(w.demandId, w.offer.id, { cookie: w.buyer.cookie })).status, 200);
  assert.equal((await pool.query<{ boost_id: string }>("SELECT boost_id FROM offer_contacts")).rows[0].boost_id, boost);
});

// ═════════════ 4. Statistiques (GET) ═════════════

test("statistiques : 401 sans session, 400 (identifiant, requête), 404 IDENTIQUE pour l'annonce d'autrui et l'annonce inconnue (aucune existence révélée)", async () => {
  const w = await world();
  assert.equal((await getStats(w.offer.id, {})).status, 401);
  assert.equal((await getStats("x", { cookie: w.seller.cookie })).status, 400);
  assert.equal((await getStats(w.offer.id, { cookie: w.seller.cookie, query: "?period=7d" })).status, 400);
  const others = await getStats(w.offer.id, { cookie: w.buyer.cookie });
  const unknown = await getStats("0f6b72e6-ad2b-4a9f-84f8-a56a4f4572dc", { cookie: w.seller.cookie });
  assert.deepEqual([others.status, unknown.status], [404, 404]);
  assert.deepEqual(others.json, FIXED_404);
  assert.equal(others.text, unknown.text);
});

test("statistiques : DTO en liste blanche, aucun identifiant ni téléphone, comptes arrondis (« moins de 5 », « environ N »), jamais un compte exact, attribution au boost", async () => {
  const w = await world();
  const boost = await makeBoost(pool, w.offer);
  const buyers: Login[] = [w.buyer];
  const demands = [w.demandId];
  for (let index = 0; index < 5; index++) {
    const extra = await login();
    const demand = await makeDemand(pool, extra.userId);
    await makeMatch(pool, w.offer, demand);
    buyers.push(extra);
    demands.push(demand.id);
  }
  // Un seul acheteur a ouvert la fiche : « moins de 5 ».
  await insertExposure(pool, { boostId: boost, offerId: w.offer.id, demandId: demands[0], viewerId: buyers[0].userId, firstServedAgo: "1 hour", servings: 3, sponsoredServings: 3 });
  assert.equal((await getOffer(demands[0], w.offer.id, { cookie: buyers[0].cookie })).status, 200);
  assert.equal((await contact(demands[0], w.offer.id, { cookie: buyers[0].cookie })).status, 200);
  const one = await getStats(w.offer.id, { cookie: w.seller.cookie });
  assert.equal(one.status, 200);
  assert.deepEqual(sortedKeys(one.json), ["activeMatches", "boosts", "contractVersion", "periods"]);
  assert.equal(asRecord(one).contractVersion, "offer-stats/v1");
  assert.equal("privacyThreshold" in asRecord(one), false, "plus de seuil k : les comptes portent leur propre borne");
  assert.deepEqual(asRecord(one).activeMatches, { needs: { kind: "approx", value: 5 } }, "6 besoins : environ 5");
  const periods = asRecord(one).periods as Array<Record<string, StatsNode>>;
  assert.deepEqual(periods.map((period) => period.period), ["7d", "30d", "all"]);
  assert.deepEqual(sortedKeys(periods[0]), ["contacts", "exposure", "opens", "period", "ratios", "since"]);
  assert.deepEqual(periods[0].opens.uniqueBuyers, { kind: "below", bound: 5 });
  assert.deepEqual(periods[0].contacts.uniqueBuyers, { kind: "below", bound: 5 });
  assert.deepEqual(periods[0].ratios, { openRate: { kind: "insufficient" }, contactRate: { kind: "insufficient" } });
  assert.deepEqual((asRecord(one).boosts as Array<Record<string, StatsNode>>)[0].ratios, { openRate: { kind: "insufficient" }, contactRate: { kind: "insufficient" } });
  assert.equal(JSON.stringify(one.json).includes("bestPosition") || JSON.stringify(one.json).includes("activeDays"), false, "ni meilleure place ni jours actifs");
  for (const secret of [w.seller.userId, w.seller.phone, ...buyers.map((buyer) => buyer.userId), ...buyers.map((buyer) => buyer.phone), ...demands, w.offer.id, "viewer", "demand_id", "RAW_SECRET_TEXT"]) {
    assert.equal(one.text.includes(secret), false, `la réponse ne doit pas contenir ${secret}`);
  }
  // Les six acheteurs ouvrent la fiche et contactent : 6 acheteurs → « environ 5 », jamais « 6 » ; les 18 apparitions → « environ 20 ».
  for (const [index, buyer] of buyers.entries()) {
    if (index > 0) {
      await insertExposure(pool, { boostId: boost, offerId: w.offer.id, demandId: demands[index], viewerId: buyer.userId, firstServedAgo: "1 hour", servings: 3, sponsoredServings: 3 });
      assert.equal((await getOffer(demands[index], w.offer.id, { cookie: buyer.cookie })).status, 200);
      assert.equal((await contact(demands[index], w.offer.id, { cookie: buyer.cookie })).status, 200);
    }
  }
  const six = await getStats(w.offer.id, { cookie: w.seller.cookie });
  const all = (asRecord(six).periods as Array<Record<string, StatsNode>>)[2];
  assert.deepEqual(all.exposure.buyersExposed, { kind: "approx", value: 5 });
  assert.deepEqual(all.exposure.servings, { kind: "approx", value: 20 });
  assert.deepEqual(all.opens.uniqueBuyers, { kind: "approx", value: 5 });
  assert.deepEqual(all.opens.attributedToBoost.uniqueBuyers, { kind: "approx", value: 5 }, "6 ouvreurs attribués : environ 5 (la part attribuée est publiée)");
  assert.deepEqual(all.opens.organic.uniqueBuyers, { kind: "below", bound: 5 }, "0 organique : moins de 5, jamais un zéro exact");
  assert.deepEqual(all.contacts.uniqueBuyers, { kind: "approx", value: 5 });
  const boosts = asRecord(six).boosts as Array<Record<string, StatsNode>>;
  assert.equal(boosts.length, 1);
  assert.equal(boosts[0].boostId, boost, "l'identifiant d'un boost du vendeur est le sien");
  assert.deepEqual(boosts[0].attributed.uniqueOpeners, { kind: "approx", value: 5 });
  assert.deepEqual(boosts[0].ratios.openRate, { kind: "insufficient" }, "environ 5 : moins de 10, aucun pourcentage");
  // Aucun nombre de la réponse n'est un compte exact : seulement `bound` (5) ou `value` (multiple de 5 ou de 10) ; ni 6 ni 18.
  for (const match of six.text.matchAll(/"(\w+)":(-?\d+)/g)) {
    assert.ok(match[1] === "bound" || match[1] === "value", `${match[1]} : un nombre nu`);
    assert.equal(Number(match[2]) % 5, 0, `${match[1]} = ${match[2]}`);
  }
  for (const secret of [...buyers.map((buyer) => buyer.userId), ...buyers.map((buyer) => buyer.phone), ...demands]) assert.equal(six.text.includes(secret), false);
});
