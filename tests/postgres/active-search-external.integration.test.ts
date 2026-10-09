import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";
import type { Pool } from "pg";
import { activateDemand, satisfyDemand, updateDemand } from "../../lib/server/catalog";
import { runCollectStep, type CollectStepOptions } from "../../lib/server/external/collect";
import { syncMarketWatches } from "../../lib/server/external/watches";
import type { ExternalListingDraft } from "../../lib/server/external/types";
import { ACTIVE_SEARCH_PRICE_XOF } from "../../lib/server/active-search/config";
import { purchaseActiveSearch } from "../../lib/server/active-search/purchase";
import { refundActiveSearchPurchase } from "../../lib/server/active-search/refund";
import { scanActiveSearchDemands } from "../../lib/server/active-search/notify";
import { runActiveSearchStep } from "../../lib/server/active-search/step";
import { simulateNewExternalListing } from "../../lib/server/active-search/simulate";
import { runMatchingCycle } from "../../lib/server/matching/runner";
import { applyTrackingAction } from "../../lib/server/notifications/tracking";
import { runActiveSearchMaintenance } from "../../lib/server/active-search/maintenance";
import { listNotifications } from "../../lib/server/notifications/inbox";
import { runNotificationStep } from "../../lib/server/notifications/deliveries";
import type { NotificationMessage, NotificationTransport } from "../../lib/server/notifications/transport";
import { FAKE_ENV, count, createFakeConnectors, fixedClock, installNetworkGuard, makeDemand, recordingSleep, resetDemands, resetExternal, selfTestNetworkGuard, TEST_PSEUDONYM_KEY, type FakeConnector, type NetworkGuard } from "./external-fixtures";
import { makeOffer, makePerson } from "./metrics-fixtures";
import { fund } from "./pro-fixtures";
import { openTestSchema, type TestSchema } from "./social-fixtures";

/**
 * Recherche active (lot RA1) côté annonces d'AUTRES SITES : relevé de l'existant, notification des seules annonces NOUVELLES et compatibles, une fois par groupe de doublons, sans confondre
 * deux capacités, plafonds N1, suivi en pause, besoin modifié, fin de l'option, collecte accélérée (1 h, 24 requêtes) dans le quota de chaque source, étape du runner APRÈS la collecte et
 * isolée, envois externes simulés, concurrence. Sources FICTIVES, argent SIMULÉ, un garde du réseau sortant.
 */

// Jour UTC fixe pendant tout l'essai (les compteurs de quota sont par jour UTC) : 00 h 30 du jour courant.
const todayStart = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate());
const BASE = new Date(Date.now() >= todayStart + 30 * 60_000 ? todayStart + 30 * 60_000 : todayStart - 24 * 3_600_000 + 30 * 60_000);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

let env: TestSchema;
let pool: Pool;
let guard: NetworkGuard;
let fakes: FakeConnector[];
let a: FakeConnector;
let b: FakeConnector;
const clock = fixedClock(BASE);
const timer = recordingSleep();

before(async () => {
  env = await openTestSchema(12);
  pool = env.pool;
  guard = installNetworkGuard();
  await selfTestNetworkGuard(guard);
});

after(async () => {
  guard?.restore();
  await env?.close();
});

beforeEach(async () => {
  await resetDemands(pool);
  await resetExternal(pool);
  await pool.query("TRUNCATE notification_deliveries, notification_preferences CASCADE");
  fakes = createFakeConnectors();
  [a, b] = fakes;
  clock.set(BASE);
  timer.waits.length = 0;
});

interface World { userId: string; demandId: string; keyOf: (n?: number) => string }

/** Un acheteur crédité, avec un besoin « iPhone 12 à Abidjan » (budget 200 000) ; `external` active les envois externes simulés. */
async function world(options: { credit?: number; budget?: number; variant?: string | null; external?: boolean; location?: string | null } = {}): Promise<World> {
  const person = await makePerson(pool);
  await fund(pool, person.id, options.credit ?? 10_000);
  if (options.external) await pool.query("INSERT INTO notification_preferences (user_id, external_enabled) VALUES ($1, TRUE)", [person.id]);
  const demand = await makeDemand(pool, { ownerId: person.id, budget: options.budget ?? 200_000, variant: options.variant ?? null, ...(options.location !== undefined ? { location: options.location } : {}) });
  return { userId: person.id, demandId: demand.id, keyOf: () => randomUUID() };
}

const buy = (w: World, key: string = randomUUID(), at: Date = clock.now()) =>
  purchaseActiveSearch({ expectedPriceXof: ACTIVE_SEARCH_PRICE_XOF, env: FAKE_ENV, pool, userId: w.userId, demandId: w.demandId, idempotencyKey: key, now: at });

const watchIds = async (): Promise<string[]> => (await pool.query<{ id: string }>("SELECT id FROM market_watches WHERE status = 'active' ORDER BY product_key")).rows.map((row) => row.id);

/** Une collecte de TOUTES les surveillances actives (forcée si elles existent déjà), sources fictives, attente instantanée. */
async function collect(extra: Partial<CollectStepOptions> = {}) {
  // Une minute de plus à chaque collecte : le filigrane du balayage compare des dates strictement croissantes.
  clock.advance(60_000);
  const ids = await watchIds();
  return runCollectStep({ pool, connectors: fakes, now: clock.now, sleep: timer.sleep, pseudonymKey: TEST_PSEUDONYM_KEY, ...(ids.length > 0 ? { only: ids } : {}), maxWatches: 10, ...extra });
}

const search = (extra: { budgetMs?: number; maxDemands?: number } = {}) => runActiveSearchStep({ pool, now: clock.now, ...extra });

const listing = (code: string, n: number, over: Partial<ExternalListingDraft> = {}): ExternalListingDraft => ({
  externalId: `${code}-nouveau-${n}`, title: `iPhone 12 128 Go violet n°${n}`, price: 140_000 + n, currency: "XOF", url: `https://annonces-${code.replace("_", "-")}.example/annonce/${code}-nouveau-${n}`,
  location: "Cocody", listedAt: new Date(clock.now().getTime() - HOUR), availability: "available", ...over,
});

const externalNotifications = async (userId: string) =>
  (await pool.query<{ id: string; title: string; price_amount: string | null; source_name: string; offer_id: string | null; external_listing_id: string | null; demand_id: string }>(
    "SELECT id, title, price_amount::text, source_name, offer_id, external_listing_id, demand_id FROM notifications WHERE user_id = $1 AND kind = 'new_external_match' ORDER BY created_at, id", [userId])).rows;

// ═════════════ 1. L'existant ne notifie jamais, le nouveau notifie une fois ═════════════

test("l'existant n'est JAMAIS notifié ; une annonce nouvelle et compatible l'est UNE seule fois (titre, prix, source, lien du besoin, aucune adresse externe)", async () => {
  const w = await world();
  const first = await collect();
  assert.equal(first.watchesProcessed, 1);
  assert.ok((await count(pool, "external_listings")) >= 6, "des annonces existent avant l'achat");
  await buy(w);
  assert.equal(await count(pool, "active_search_seen", "reason = 'baseline'") > 0, true, "l'existant est marqué vu à l'activation");
  assert.equal(await pool.query("SELECT baseline_pending AS n FROM active_search_state WHERE demand_id = $1", [w.demandId]).then((result) => result.rows[0].n), false);
  const quiet = await search();
  assert.deepEqual([quiet.notified, quiet.baselines, quiet.errors], [0, 0, []]);
  clock.advance(HOUR);
  await collect();
  assert.equal((await search()).notified, 0, "une collecte sans annonce nouvelle ne notifie rien");
  assert.equal((await externalNotifications(w.userId)).length, 0);

  a.controls.extra = [listing("demo_a", 1)];
  clock.advance(HOUR);
  const second = await collect();
  assert.ok(second.created >= 1);
  const found = await search();
  assert.equal(found.notified, 1);
  const rows = await externalNotifications(w.userId);
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].title, rows[0].price_amount, rows[0].source_name, rows[0].offer_id, rows[0].demand_id], ["iPhone 12 128 Go violet n°1", "140001", "Annonces Démo A", null, w.demandId]);
  assert.notEqual(rows[0].external_listing_id, null);

  const page = await listNotifications({ pool, userId: w.userId });
  const item = page.items.find((entry) => entry.kind === "new_external_match");
  assert.ok(item);
  assert.equal(item.link, `/besoins/${w.demandId}`, "le lien est la page du BESOIN");
  assert.equal(item.sourceName, "Annonces Démo A");
  assert.equal(item.offerId, null);
  assert.equal(JSON.stringify(page).includes("annonces-demo-a.example"), false, "jamais l'adresse de l'annonce externe");
  assert.equal(page.unreadCount, 1);

  // Idempotence : ni un second balayage, ni une nouvelle collecte de la même annonce ne notifient.
  assert.equal((await search()).notified, 0);
  clock.advance(HOUR);
  await collect();
  assert.equal((await search()).notified, 0);
  assert.equal((await externalNotifications(w.userId)).length, 1);
  assert.equal(await count(pool, "active_search_seen", "reason = 'notified'"), 1);
});

test("surveillance JAMAIS collectée à l'achat : le relevé attend la première collecte réussie, qui relève l'existant SANS notifier ; l'annonce suivante notifie", async () => {
  const w = await world();
  await buy(w);
  assert.equal(await pool.query("SELECT baseline_pending AS n FROM active_search_state WHERE demand_id = $1", [w.demandId]).then((result) => result.rows[0].n), true);
  const early = await search();
  assert.deepEqual([early.baselines, early.notified], [0, 0], "aucune surveillance : rien à relever");
  await collect();
  const taken = await search();
  assert.equal(taken.baselines, 1, "la première collecte est relevée");
  assert.equal(taken.notified, 0, "l'existant ne notifie jamais");
  assert.equal(await pool.query("SELECT baseline_pending AS n FROM active_search_state WHERE demand_id = $1", [w.demandId]).then((result) => result.rows[0].n), false);
  a.controls.extra = [listing("demo_a", 2)];
  clock.advance(HOUR);
  await collect();
  assert.equal((await search()).notified, 1);
});

test("une collecte en échec complet (toutes les sources en panne) ne vaut pas collecte réussie : le relevé en attente continue d'attendre", async () => {
  const w = await world();
  await buy(w);
  a.controls.failure = new Error("panne A");
  b.controls.failure = new Error("panne B");
  const failed = await collect();
  assert.equal(failed.sourceFailures, 2);
  assert.equal((await search()).baselines, 0);
  assert.equal(await pool.query("SELECT baseline_pending AS n FROM active_search_state WHERE demand_id = $1", [w.demandId]).then((result) => result.rows[0].n), true);
  a.controls.failure = null;
  b.controls.failure = null;
  clock.advance(HOUR);
  await collect();
  assert.equal((await search()).baselines, 1);
});

// ═════════════ 2. Doublons : une fois par groupe ═════════════

test("la même annonce chez DEUX sources dans la même collecte : UNE seule notification, les deux annonces sont vues", async () => {
  const w = await world();
  await collect();
  await buy(w);
  a.controls.extra = [listing("demo_a", 3, { title: "iPhone 12 128 Go rouge scellé", price: 140_000 })];
  b.controls.extra = [listing("demo_b", 3, { title: "iPhone 12 128 Go rouge scellé (très bon état)", price: 141_000, currency: "FCFA" })];
  clock.advance(HOUR);
  const collected = await collect();
  assert.ok(collected.grouped >= 2, "les deux annonces sont regroupées");
  const found = await search();
  assert.equal(found.notified, 1);
  const rows = await externalNotifications(w.userId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].price_amount, "140000", "la moins chère du groupe");
  assert.equal(await count(pool, "active_search_seen", "reason IN ('notified', 'duplicate')"), 2, "les deux annonces du groupe sont vues");
  clock.advance(HOUR);
  await collect();
  assert.equal((await search()).notified, 0);
  assert.equal((await externalNotifications(w.userId)).length, 1);
});

test("le doublon arrive APRÈS la notification de la première annonce : aucune seconde notification", async () => {
  const w = await world();
  await collect();
  await buy(w);
  a.controls.extra = [listing("demo_a", 4, { title: "iPhone 12 128 Go bleu", price: 138_000 })];
  clock.advance(HOUR);
  await collect();
  assert.equal((await search()).notified, 1);
  b.controls.extra = [listing("demo_b", 4, { title: "iPhone 12 128 Go bleu", price: 138_500, currency: "FCFA" })];
  clock.advance(HOUR);
  await collect();
  assert.equal((await search()).notified, 0, "c'est la même annonce vue chez une autre source");
  assert.equal((await externalNotifications(w.userId)).length, 1);
});

test("regroupement stocké EN RETARD (les deux annonces sont encore séparées) : le doublon vérifié n'est notifié qu'une fois", async () => {
  const w = await world();
  await collect();
  await buy(w);
  a.controls.extra = [listing("demo_a", 5, { title: "iPhone 12 128 Go vert", price: 139_000 })];
  b.controls.extra = [listing("demo_b", 5, { title: "iPhone 12 128 Go vert", price: 139_500, currency: "FCFA" })];
  clock.advance(HOUR);
  await collect();
  await pool.query("UPDATE external_listings SET duplicate_group_id = NULL");
  const found = await search();
  assert.equal(found.notified, 1, "un doublon vérifié n'est pas une annonce de plus, même sans groupe");
  assert.equal((await externalNotifications(w.userId)).length, 1);
  assert.equal(await count(pool, "active_search_seen", "reason = 'duplicate'"), 1);
});

test("deux CAPACITÉS différentes ne sont jamais confondues (64 Go et 128 Go au prix voisin) : deux notifications, même si un groupe enregistré les réunit à tort", async () => {
  const w = await world();
  await collect();
  await buy(w);
  a.controls.extra = [listing("demo_a", 6, { title: "iPhone 12 64 Go noir", price: 120_000 })];
  b.controls.extra = [listing("demo_b", 6, { title: "iPhone 12 128 Go noir", price: 121_000, currency: "FCFA" })];
  clock.advance(HOUR);
  const collected = await collect();
  assert.equal(collected.grouped, 0, "deux produits différents ne sont jamais regroupés");
  // Un groupe posé à tort (réunit deux capacités) : la lecture ne les absorbe pas.
  const group = (await pool.query<{ id: string }>("INSERT INTO duplicate_groups (product_key) SELECT product_key FROM market_watches LIMIT 1 RETURNING id")).rows[0].id;
  await pool.query("UPDATE external_listings SET duplicate_group_id = $1 WHERE external_id IN ($2, $3)", [group, "demo_a-nouveau-6", "demo_b-nouveau-6"]);
  const found = await search();
  assert.equal(found.notified, 2, "64 Go et 128 Go sont deux annonces à notifier");
  assert.deepEqual((await externalNotifications(w.userId)).map((row) => row.title).sort(), ["iPhone 12 128 Go noir", "iPhone 12 64 Go noir"]);
});

// ═════════════ 3. Filtres de compatibilité et fraîcheur ═════════════

test("seules les annonces COMPATIBLES notifient : hors budget, accessoire, autre modèle, sans lieu, titre porteur d'un numéro ou indisponible sont écartés", async () => {
  const w = await world({ budget: 150_000 });
  await collect();
  await buy(w);
  a.controls.extra = [
    listing("demo_a", 10, { title: "iPhone 12 128 Go premium", price: 300_000 }),
    listing("demo_a", 11, { title: "Coque silicone pour iPhone 12", price: 3_000 }),
    listing("demo_a", 12, { title: "iPhone 12 Pro Max 256 Go", price: 140_000 }),
    listing("demo_a", 13, { title: "iPhone 12 128 Go sans lieu", price: 140_000, location: null }),
    listing("demo_a", 14, { title: "iPhone 12 128 Go appelez le 07 08 09 10 11", price: 140_000 }),
    listing("demo_a", 15, { title: "iPhone 12 128 Go indisponible", price: 140_000, availability: "unavailable" }),
    listing("demo_a", 16, { title: "iPhone 12 128 Go compatible", price: 140_000 }),
  ];
  clock.advance(HOUR);
  await collect();
  const found = await search();
  assert.equal(found.notified, 1);
  assert.deepEqual((await externalNotifications(w.userId)).map((row) => row.title), ["iPhone 12 128 Go compatible"]);
  const everything = JSON.stringify((await pool.query("SELECT title, source_name FROM notifications WHERE user_id = $1", [w.userId])).rows);
  assert.equal(/0[0-9] ?0[0-9] ?0[0-9]/.test(everything), false, "aucun numéro de téléphone dans une notification");
});

test("fraîcheur : une annonce NON VUE depuis plus de 48 h n'est pas notifiée (seule la dernière vue compte) ; revue plus tard, elle l'est", async () => {
  const w = await world();
  await collect();
  await buy(w);
  a.controls.extra = [listing("demo_a", 20)];
  clock.advance(HOUR);
  await collect();
  const collectedAt = clock.now();
  const rescan = async (): Promise<void> => {
    // La surveillance est « collectée » une fois de plus : le balayage se déclenche.
    await pool.query("UPDATE market_watches SET last_run_at = last_run_at + interval '1 minute'");
  };
  // 49 h après sa dernière vue, l'annonce n'est plus visible : trop ancienne.
  clock.set(new Date(collectedAt.getTime() + 49 * HOUR));
  await rescan();
  assert.equal((await search()).notified, 0, "vue il y a 49 h : trop ancienne");
  // Revue il y a 47 h (la première vue reste APRÈS le relevé de l'existant) : visible, donc notifiée.
  const lastSeen = new Date(clock.now().getTime() - 47 * HOUR);
  await pool.query("UPDATE external_listings SET last_seen_at = $1, last_checked_at = $1 WHERE external_id = 'demo_a-nouveau-20'", [lastSeen]);
  await rescan();
  assert.equal((await search()).notified, 1, "vue il y a 47 h : notifiée");
});

// ═════════════ 4. Plafonds et suivi ═════════════

test("plafonds de N1 : 20 notifications par besoin et par jour, le reste dans UN résumé « n nouvelles annonces » qui remonte non lu", async () => {
  const w = await world();
  await collect();
  await buy(w);
  a.controls.extra = Array.from({ length: 25 }, (_, index) => listing("demo_a", 100 + index, { title: `iPhone 12 128 Go violet modèle ${100 + index}`, price: 120_000 + index * 100 }));
  clock.advance(HOUR);
  await collect();
  const found = await search();
  assert.equal(found.notified, 20);
  assert.equal(found.digested, 5);
  assert.equal((await externalNotifications(w.userId)).length, 20);
  const digest = (await pool.query<{ item_count: number; read_at: Date | null }>("SELECT item_count, read_at FROM notifications WHERE user_id = $1 AND kind = 'new_matches_digest'", [w.userId])).rows;
  assert.deepEqual(digest.map((row) => [row.item_count, row.read_at]), [[5, null]]);
  assert.equal((await search()).notified, 0);
  assert.equal(await count(pool, "active_search_seen", "reason = 'notified'"), 25, "les 25 annonces sont vues : aucune ne sera renotifiée");
});

test("suivi EN PAUSE : aucune notification ; à la reprise, l'annonce arrivée pendant la pause notifie", async () => {
  const w = await world();
  await collect();
  await buy(w);
  await applyTrackingAction({ pool, ownerId: w.userId, demandId: w.demandId, action: "pause", now: clock.now() });
  a.controls.extra = [listing("demo_a", 30)];
  clock.advance(HOUR);
  await collect();
  const held = await search();
  assert.deepEqual([held.notified, held.trackingHeld], [0, 1]);
  assert.equal((await externalNotifications(w.userId)).length, 0);
  await applyTrackingAction({ pool, ownerId: w.userId, demandId: w.demandId, action: "resume", now: clock.now() });
  const resumed = await search();
  assert.equal(resumed.notified, 1, "reprise : l'annonce de la pause notifie");
});

test("suivi ÉCHU : aucune notification (l'achat prolonge le suivi au moins jusqu'à la fin de l'option ; un suivi ramené à sa création est échu)", async () => {
  const w = await world();
  await collect();
  await buy(w);
  assert.ok((await pool.query<{ ok: boolean }>("SELECT notify_until >= $2::timestamptz AS ok FROM demands WHERE id = $1", [w.demandId, new Date(BASE.getTime() + 30 * DAY)])).rows[0].ok, "l'achat prolonge le suivi");
  a.controls.extra = [listing("demo_a", 31)];
  // Deux jours après la création du besoin (horloge réelle), l'option est toujours en vigueur mais le suivi ramené à sa création est échu.
  clock.set(new Date(Date.now() + 2 * DAY));
  await collect();
  await pool.query("UPDATE demands SET notify_until = created_at WHERE id = $1", [w.demandId]);
  const held = await search();
  assert.deepEqual([held.notified, held.trackingHeld], [0, 1]);
});

test("besoin MODIFIÉ (budget relevé) : l'existant devenu compatible ne notifie PAS (nouveau relevé), l'annonce suivante notifie", async () => {
  const w = await world({ budget: 150_000 });
  await collect();
  await buy(w);
  const version = (await pool.query<{ v: number }>("SELECT content_version AS v FROM demands WHERE id = $1", [w.demandId])).rows[0].v;
  await updateDemand({ id: w.demandId, ownerId: w.userId, expectedContentVersion: version, changes: { budget: { amount: 400_000, currency: "XOF" } } }, pool);
  clock.advance(HOUR);
  await collect();
  const retaken = await search();
  assert.deepEqual([retaken.baselines, retaken.notified], [1, 0], "les annonces à 285 000 FCFA, devenues compatibles, sont de l'existant");
  a.controls.extra = [listing("demo_a", 32, { price: 350_000 })];
  clock.advance(HOUR);
  await collect();
  assert.equal((await search()).notified, 1);
});

// ═════════════ 5. Fin de l'option ═════════════

/** Témoin positif (avec l'option, une annonce nouvelle notifie) puis l'option s'arrête de la façon donnée : une annonce nouvelle de plus ne notifie plus. */
async function stopsNotifying(stop: (w: World, purchaseId: string) => Promise<void>): Promise<void> {
  const w = await world();
  await collect();
  const bought = await buy(w);
  a.controls.extra = [listing("demo_a", 40)];
  clock.advance(HOUR);
  await collect();
  assert.equal((await search()).notified, 1, "témoin : avec l'option, l'annonce nouvelle notifie");
  await stop(w, bought.purchaseId);
  a.controls.extra = [listing("demo_a", 40), listing("demo_a", 41)];
  clock.advance(HOUR);
  await collect();
  const after = await search();
  assert.equal(after.notified, 0, "plus d'option en vigueur : aucune notification d'annonce d'un autre site");
  assert.equal((await externalNotifications(w.userId)).length, 1);
}

test("option TERMINÉE à l'échéance : plus aucune notification, la maintenance termine la période", async () => {
  await stopsNotifying(async () => { clock.set(new Date(clock.now().getTime() + 31 * DAY)); });
  assert.equal(await count(pool, "active_search_purchases", "status = 'ended'"), 1);
});

test("option REMBOURSÉE : plus aucune notification", async () => {
  await stopsNotifying(async (_w, purchaseId) => { await refundActiveSearchPurchase({ pool, purchaseId, reasonCode: "essai", now: clock.now() }); });
});

test("besoin SATISFAIT : l'option est SUSPENDUE (aucune notification, aucun arrêt, aucun remboursement)", async () => {
  await stopsNotifying(async (w) => {
    const version = (await pool.query<{ v: number }>("SELECT content_version AS v FROM demands WHERE id = $1", [w.demandId])).rows[0].v;
    await satisfyDemand(w.userId, w.demandId, version, pool);
  });
  assert.equal(await count(pool, "active_search_purchases", "status = 'active' AND stop_reason IS NULL AND refunded_at IS NULL"), 1, "la période court toujours : suspendue, pas arrêtée");
  assert.equal(await count(pool, "active_search_purchases", "status = 'stopped'"), 0);
});

// ═════════════ 6. Collecte accélérée et quotas ═════════════

const watchRow = async () => (await pool.query<{ frequency_seconds: number; daily_request_budget: number; next_run_at: Date; last_run_at: Date | null; product_key: string }>(
  "SELECT frequency_seconds, daily_request_budget, next_run_at, last_run_at, product_key FROM market_watches ORDER BY product_key")).rows;

test("surveillance PARTAGÉE : 1 h et 24 requêtes dès qu'UN besoin actif de la clé a l'option, retour à 6 h et 4 requêtes quand plus aucun ne l'a ; une autre clé n'est pas touchée", async () => {
  const paying = await world();
  await world();
  await world({ variant: "autre-cle" });
  await collect();
  let rows = await watchRow();
  assert.equal(rows.length, 2);
  assert.ok(rows.every((row) => row.frequency_seconds === 21_600 && row.daily_request_budget === 4), "avant l'option : 6 h et 4 requêtes");
  const bought = await buy(paying);
  const sync = await syncMarketWatches(pool, clock.now());
  assert.equal(sync.accelerated, 1);
  rows = await watchRow();
  const shared = rows.find((row) => row.frequency_seconds === 3_600);
  assert.ok(shared, "la surveillance de la clé du payeur est accélérée");
  assert.equal(shared.daily_request_budget, 24);
  assert.equal(rows.filter((row) => row.frequency_seconds === 21_600).length, 1, "l'autre clé garde 6 h");
  assert.ok(shared.next_run_at.getTime() <= (shared.last_run_at as Date).getTime() + HOUR, "prochaine collecte avancée à 1 h après la dernière");
  // Un deuxième sync n'a plus rien à changer (idempotent), l'acheteur sans option profite de la même surveillance.
  assert.deepEqual([(await syncMarketWatches(pool, clock.now())).accelerated, (await syncMarketWatches(pool, clock.now())).decelerated], [0, 0]);
  // Remboursement : plus d'option en vigueur → 6 h et 4 requêtes.
  await refundActiveSearchPurchase({ pool, purchaseId: bought.purchaseId, reasonCode: "essai", now: clock.now() });
  const back = await syncMarketWatches(pool, clock.now());
  assert.equal(back.decelerated, 1);
  assert.ok((await watchRow()).every((row) => row.frequency_seconds === 21_600 && row.daily_request_budget === 4));
  // Une fréquence réglée à la main n'est pas touchée à la baisse.
  await pool.query("UPDATE market_watches SET frequency_seconds = 7200 WHERE frequency_seconds = 21600 AND product_key = $1", [shared.product_key]);
  assert.equal((await syncMarketWatches(pool, clock.now())).decelerated, 0);
  assert.equal((await watchRow()).find((row) => row.product_key === shared.product_key)?.frequency_seconds, 7200);
});

test("la surveillance accélérée est collectée toutes les heures (budget 24), la surveillance ordinaire toutes les 6 heures (budget 4)", async () => {
  const w = await world();
  await collect();
  await buy(w);
  await syncMarketWatches(pool, clock.now());
  const dueAfter = async (ms: number): Promise<number> => {
    clock.set(new Date(BASE.getTime() + ms));
    await syncMarketWatches(pool, clock.now());
    return (await runCollectStep({ pool, connectors: fakes, now: clock.now, sleep: timer.sleep, pseudonymKey: TEST_PSEUDONYM_KEY })).claimed;
  };
  // La première collecte a eu lieu à BASE + 1 min (le helper avance l'horloge d'une minute avant chaque collecte).
  assert.equal(await dueAfter(30 * 60_000), 0, "30 minutes : pas encore due");
  assert.equal(await dueAfter(HOUR + 2 * 60_000), 1, "1 h plus tard : due");
  assert.equal(await dueAfter(HOUR + 10 * 60_000), 0);
  assert.equal(await dueAfter(2 * HOUR + 3 * 60_000), 1, "toutes les heures");
  // Sans option (autre jeu de données), l'échéance est de 6 h.
  await resetDemands(pool);
  await resetExternal(pool);
  clock.set(BASE);
  await world();
  await collect();
  assert.equal(await dueAfter(HOUR), 0);
  assert.equal(await dueAfter(5 * HOUR), 0);
  assert.equal(await dueAfter(6 * HOUR + 2 * 60_000), 1);
});

test("QUOTAS respectés : le quota du jour de CHAQUE source borne la collecte accélérée, le budget de 24 par source la borne aussi ; la surveillance ordinaire reste à 4", async () => {
  // Surveillance ordinaire : 4 requêtes par jour et par source.
  await world({ variant: "ordinaire" });
  let skipped = 0;
  for (let index = 0; index < 6; index += 1) {
    clock.advance(10 * 60_000);
    skipped += (await collect()).budgetSkipped;
  }
  assert.equal((await pool.query<{ requests: number }>("SELECT sum(requests)::int AS requests FROM market_watch_usage WHERE source_code = 'demo_a'")).rows[0].requests, 4, "4 requêtes par jour pour la source A");
  assert.ok(skipped >= 4, `budget ordinaire refusé ${skipped} fois`);
  // Surveillance accélérée : jusqu'à 24 par jour, mais le quota de la SOURCE reste la limite ET les requêtes accélérées n'en prennent que la MOITIÉ (3 ici : 1 requête accélérée).
  await resetDemands(pool);
  await resetExternal(pool);
  clock.set(BASE);
  fakes = createFakeConnectors();
  [a, b] = fakes;
  const w = await world();
  await collect();
  await buy(w);
  await pool.query("UPDATE external_sources SET daily_quota = 3 WHERE code = 'demo_a'");
  let quotaSkipped = 0;
  for (let index = 0; index < 8; index += 1) {
    clock.advance(10 * 60_000);
    quotaSkipped += (await collect()).quotaSkipped;
  }
  const usage = (await pool.query<{ source_code: string; requests: number; accelerated_requests: number }>("SELECT source_code, requests, accelerated_requests FROM external_source_usage ORDER BY source_code")).rows;
  assert.equal(usage.find((row) => row.source_code === "demo_a")?.requests, 2, "la source A (quota 3) : 1 requête ordinaire d'avant l'achat + 1 accélérée (la moitié du quota), jamais plus");
  assert.equal(usage.find((row) => row.source_code === "demo_a")?.accelerated_requests, 1, "la part accélérée du quota de 3 est de 1");
  assert.ok((usage.find((row) => row.source_code === "demo_b")?.requests ?? 0) >= 9, "la source B (quota 200) est interrogée à chaque collecte forcée : 9 fois, au-delà des 4 d'une surveillance ordinaire");
  assert.ok(quotaSkipped >= 5, `quota refusé ${quotaSkipped} fois`);
  assert.equal(a.controls.calls, 2, "la source A n'a reçu que 2 requêtes en tout (la première, avant l'achat, comprise)");
});

test("une option achetée PENDANT la collecte de la surveillance : la prochaine échéance est dans 1 h (la fréquence est relue à la clôture), jamais 6 h", async () => {
  const w = await world();
  await collect();
  clock.advance(7 * HOUR);
  // Pendant la collecte (juste avant l'interrogation des sources), l'acheteur achète l'option et la synchronisation accélère la surveillance.
  let purchased = false;
  const result = await collect({
    hooks: {
      beforeSource: async () => {
        if (purchased) return;
        purchased = true;
        await buy(w);
        await syncMarketWatches(pool, clock.now());
      },
    },
  });
  assert.equal(result.watchesProcessed, 1);
  const row = (await watchRow())[0];
  assert.equal(row.frequency_seconds, 3_600);
  assert.equal(row.next_run_at.getTime(), (row.last_run_at as Date).getTime() + HOUR, "prochaine collecte 1 h après la clôture");
});

// ═════════════ 7. Étape du runner ═════════════

test("runner : l'étape « activeSearch » passe APRÈS la collecte du même cycle (l'annonce collectée est notifiée dans ce cycle), le résultat porte l'étape", async () => {
  const w = await world();
  await collect();
  await buy(w);
  a.controls.extra = [listing("demo_a", 50)];
  clock.advance(HOUR);
  const cycle = await runMatchingCycle({
    pool, workerId: "ra-runner", maxJobs: 1, notificationTransport: null,
    collect: { connectors: fakes, now: clock.now, sleep: timer.sleep, pseudonymKey: TEST_PSEUDONYM_KEY, only: await watchIds() },
    activeSearch: { now: clock.now },
  });
  assert.deepEqual(cycle.errors, []);
  assert.equal(cycle.collect.watchesProcessed, 1);
  assert.equal(cycle.activeSearch.notified, 1, "collectée puis notifiée dans le même cycle");
  assert.equal(cycle.activeSearch.skipped, false);
  assert.equal(cycle.idle, false);
  assert.equal((await externalNotifications(w.userId)).length, 1);
  const quiet = await runMatchingCycle({ pool, workerId: "ra-runner", maxJobs: 1, notificationTransport: null, collect: { connectors: [] }, activeSearch: { now: clock.now } });
  assert.equal(quiet.activeSearch.notified, 0);
});

test("runner : une panne de l'étape « activeSearch » est isolée (code stable, collecte et autres étapes intactes) ; sans la migration, ignorée sans erreur", async () => {
  const second = await openTestSchema(4);
  try {
    const bare = second.pool;
    const person = await makePerson(bare);
    await makeDemand(bare, { ownerId: person.id });
    await resetExternal(bare);
    const healthy = await runMatchingCycle({ pool: bare, workerId: "ra-iso", maxJobs: 1, notificationTransport: null, collect: { connectors: createFakeConnectors(), pseudonymKey: TEST_PSEUDONYM_KEY, sleep: timer.sleep }, activeSearch: {} });
    assert.deepEqual(healthy.errors, []);
    assert.equal(healthy.collect.watchesProcessed, 1);
    // Colonne supprimée : la lecture des besoins à balayer échoue, l'erreur est un code stable de l'étape et rien d'autre.
    await bare.query("ALTER TABLE active_search_state DROP COLUMN scanned_at");
    await bare.query("UPDATE market_watches SET next_run_at = now() - interval '1 minute'");
    const broken = await runMatchingCycle({ pool: bare, workerId: "ra-iso", maxJobs: 1, notificationTransport: null, collect: { connectors: createFakeConnectors(), pseudonymKey: TEST_PSEUDONYM_KEY, sleep: timer.sleep } });
    assert.deepEqual(broken.errors, ["active_search_error_scan_42703"]);
    assert.equal(broken.collect.watchesProcessed, 1, "la collecte du même cycle est intacte");
    assert.equal(broken.collect.errors.length, 0);
    assert.equal(broken.activeSearch.skipped, false);
    // Sans les tables : ignorée.
    await bare.query("DROP TABLE active_search_seen, active_search_state, active_search_purchases CASCADE");
    const skipped = await runMatchingCycle({ pool: bare, workerId: "ra-iso", maxJobs: 1, notificationTransport: null, collect: { connectors: [] } });
    assert.deepEqual([skipped.activeSearch.skipped, skipped.errors], [true, []]);
  } finally {
    await second.close();
  }
});

test("budget de l'étape : au plus N besoins par passage, un budget de temps épuisé reporte tout, le reste est repris au passage suivant", async () => {
  const worlds = [await world({ variant: "alpha" }), await world({ variant: "beta" }), await world({ variant: "gamma" })];
  await collect();
  for (const w of worlds) await buy(w);
  a.controls.extra = [listing("demo_a", 60, { title: "iPhone 12 alpha beta gamma 128 Go violet" })];
  clock.advance(HOUR);
  await collect();
  const limited = await search({ maxDemands: 1 });
  assert.deepEqual([limited.examined, limited.deferred], [1, 2]);
  const noTime = await search({ budgetMs: -1 });
  assert.deepEqual([noTime.examined, noTime.deferred], [0, 2], "budget de temps épuisé : aucun besoin commencé");
  const rest = await search();
  assert.equal(rest.deferred, 0);
  const total = await Promise.all(worlds.map(async (w) => (await externalNotifications(w.userId)).length));
  assert.deepEqual(total, [1, 1, 1], "chaque acheteur est notifié une fois, quel que soit le nombre de passages");
});

// ═════════════ 8. Concurrence ═════════════

test("P1-c : 60 options sur le MÊME produit (une seule surveillance, admises) qui demandent toutes un balayage → l'étape reste bornée à 25 besoins par passage, le reste est repris aux passages suivants, chaque acheteur est notifié UNE fois", async () => {
  const worlds: World[] = [];
  for (let index = 0; index < 60; index += 1) worlds.push(await world());
  await collect();
  for (const w of worlds) await buy(w);
  a.controls.extra = [listing("demo_a", 65)];
  clock.advance(HOUR);
  await collect();
  const first = await search();
  assert.ok(first.examined <= 26, `examinés ${first.examined}`);
  assert.ok(first.deferred >= 34, `reportés ${first.deferred}`);
  let passes = 1;
  for (let guard = 0; guard < 6; guard += 1) {
    const next = await search();
    passes += 1;
    if (next.deferred === 0) break;
  }
  assert.ok(passes >= 3 && passes <= 7, `passes ${passes}`);
  const counts = await Promise.all(worlds.map(async (w) => (await externalNotifications(w.userId)).length));
  assert.deepEqual(counts.filter((n) => n !== 1), [], "chaque acheteur est notifié exactement une fois");
});

test("deux processus balaient le MÊME besoin en même temps (deux pools) : chaque annonce n'est notifiée qu'une fois", async () => {
  const w = await world();
  await collect();
  await buy(w);
  a.controls.extra = Array.from({ length: 6 }, (_, index) => listing("demo_a", 70 + index, { title: `iPhone 12 128 Go gris modèle ${70 + index}`, price: 130_000 + index * 200 }));
  clock.advance(HOUR);
  await collect();
  const wide = env.extraPool(10);
  const results = await Promise.all(Array.from({ length: 6 }, (_, index) => scanActiveSearchDemands({ pool: index % 2 === 0 ? pool : wide, now: clock.now() })));
  assert.deepEqual(results.flatMap((result) => result.errors), []);
  assert.equal((await externalNotifications(w.userId)).length, 6, "six annonces, six notifications, jamais plus");
  assert.equal(results.reduce((total, result) => total + result.notified, 0), 6);
  assert.equal(await count(pool, "active_search_seen", "reason = 'notified'"), 6);
});

test("un verrou de balayage tenu par un autre processus n'est jamais attendu : le besoin est repris au passage suivant (busy), sans erreur", async () => {
  const w = await world();
  await collect();
  await buy(w);
  a.controls.extra = [listing("demo_a", 80)];
  clock.advance(HOUR);
  await collect();
  const holder = await pool.connect();
  try {
    await holder.query("BEGIN");
    await holder.query("SELECT pg_advisory_xact_lock($1::int, hashtext($2))", [1_314_664_990, `scan:${w.demandId}`]);
    const began = Date.now();
    const busy = await search();
    assert.ok(Date.now() - began < 2_000, "aucune attente");
    assert.deepEqual([busy.busy, busy.notified, busy.errors], [1, 0, []]);
  } finally {
    await holder.query("ROLLBACK").catch(() => undefined);
    holder.release();
  }
  assert.equal((await search()).notified, 1, "libre : repris et notifié");
});

// ═════════════ 9. Envois externes simulés ═════════════

test("envois externes simulés : une ligne par annonce notifiée (annonce externe, lien du besoin, jamais l'adresse), envoyée si l'option est en vigueur, écartée sinon", async () => {
  const w = await world({ external: true });
  await collect();
  const bought = await buy(w);
  a.controls.extra = [listing("demo_a", 90)];
  clock.advance(HOUR);
  await collect();
  assert.equal((await search()).deliveries, 1);
  const row = (await pool.query<{ offer_id: string | null; external_listing_id: string | null; content: { title: string; link: string; price: unknown }; idempotency_key: string; channel: string }>(
    "SELECT offer_id, external_listing_id, content, idempotency_key, channel FROM notification_deliveries")).rows[0];
  assert.equal(row.offer_id, null);
  assert.notEqual(row.external_listing_id, null);
  assert.equal(row.content.link, `/besoins/${w.demandId}`);
  assert.equal(JSON.stringify(row.content).includes("annonces-demo-a.example"), false);
  assert.match(row.idempotency_key, /^sms_sim:new_external_match:/);
  assert.equal(row.channel, "sms_sim");
  // Rejouer le balayage ne crée pas une seconde ligne.
  assert.equal((await search()).deliveries, 0);
  assert.equal(await count(pool, "notification_deliveries"), 1);

  const noon = new Date(BASE.getTime() + 11.5 * HOUR);
  const align = async (): Promise<void> => {
    await pool.query("UPDATE notification_deliveries SET created_at = $1::timestamptz - interval '1 hour', updated_at = $1::timestamptz - interval '1 hour', next_attempt_at = $1::timestamptz - interval '1 minute' WHERE status = 'pending'", [noon]);
  };
  await align();
  const calls: NotificationMessage[] = [];
  const transport: NotificationTransport = { channel: "sms_sim", async send(message) { calls.push(message); } };
  const sent = await runNotificationStep({ pool, transport, now: () => noon });
  assert.deepEqual([sent.messages, sent.delivered, sent.failed], [1, 1, 0]);
  assert.equal(calls.length, 1);
  assert.equal(JSON.stringify(calls).includes("annonces-demo-a.example"), false, "le message ne porte jamais l'adresse de l'annonce externe");

  // L'option est remboursée avant l'envoi de la suivante : la ligne est ÉCARTÉE (option plus en vigueur), rien n'est envoyé.
  a.controls.extra = [listing("demo_a", 91)];
  clock.advance(HOUR);
  await collect();
  assert.equal((await search()).deliveries, 1);
  await refundActiveSearchPurchase({ pool, purchaseId: bought.purchaseId, reasonCode: "avant_envoi", now: clock.now() });
  await align();
  const skipped = await runNotificationStep({ pool, transport, now: () => noon });
  assert.equal(calls.length, 1, "aucun nouvel envoi");
  assert.equal(skipped.skippedDeliveries, 1);
  assert.equal((await pool.query<{ reason: string }>("SELECT reason FROM notification_deliveries WHERE status = 'skipped'")).rows[0].reason, "search_inactive");
});

// ═════════════ 10. Avis d'échéance dans les notifications ═════════════

test("l'avis d'échéance arrive par l'étape du worker, une seule fois, avec la fin de l'option, sans annonce", async () => {
  const w = await world();
  await collect();
  const bought = await buy(w);
  clock.set(new Date(bought.startsAt.getTime() + 27 * DAY + HOUR));
  const first = await search();
  assert.equal(first.notices, 1);
  assert.equal((await search()).notices, 0);
  const page = await listNotifications({ pool, userId: w.userId });
  const notice = page.items.find((item) => item.kind === "active_search_expiring");
  assert.ok(notice);
  assert.equal(notice.title, null);
  assert.equal(notice.price, null);
  assert.equal(notice.link, `/besoins/${w.demandId}`);
  assert.equal(notice.endsAt?.getTime(), bought.endsAt.getTime());
});

// ═════════════ 11. Outil de démonstration ═════════════

test("outil de démonstration (active-search:simulate) : une annonce fictive COMPATIBLE apparaît, la collecte puis l'étape du worker créent UNE notification pour le besoin qui a l'option et aucune pour celui qui ne l'a pas", async () => {
  const paying = await world();
  const free = await world();
  await collect();
  await buy(paying);
  clock.advance(HOUR);
  const result = await simulateNewExternalListing({ pool, demandId: paying.demandId, now: clock.now });
  assert.deepEqual([result.created, result.notified, result.sourceFailures, result.errors], [1, 1, 0, []]);
  assert.ok(result.priceAmount > 0 && result.priceAmount <= 200_000, "prix sous le budget");
  const rows = await externalNotifications(paying.userId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].price_amount, String(result.priceAmount));
  assert.equal(rows[0].source_name, "Annonces Démo A");
  assert.equal((await externalNotifications(free.userId)).length, 0, "sans option, l'annonce simulée ne notifie pas");
  // Une seconde annonce simulée : une seconde notification (l'annonce précédente ne renotifie pas).
  clock.advance(HOUR);
  const second = await simulateNewExternalListing({ pool, demandId: paying.demandId, now: clock.now });
  assert.deepEqual([second.created, second.notified], [1, 1]);
  assert.equal((await externalNotifications(paying.userId)).length, 2);
  // Besoin inconnu : erreur claire, rien d'écrit.
  const before = await count(pool, "notifications");
  await assert.rejects(simulateNewExternalListing({ pool, demandId: randomUUID(), now: clock.now }), /besoin introuvable/);
  assert.equal(await count(pool, "notifications"), before);
});

// ═════════════ 12. Contraintes de la table notifications (bloc fusionnable de la migration 0028) ═════════════

test("contraintes de `notifications` : la forme exacte de chaque genre, l'unicité d'une notification par annonce externe et par avis, la cible exclusive d'un envoi (annonce interne OU externe)", async () => {
  const w = await world({ external: true });
  await collect();
  const bought = await buy(w);
  a.controls.extra = [listing("demo_a", 95)];
  clock.advance(HOUR);
  await collect();
  assert.equal((await search()).notified, 1);
  clock.set(new Date(bought.startsAt.getTime() + 28 * DAY));
  assert.equal((await search()).notices >= 1, true);
  const external = (await pool.query<{ id: string; external_listing_id: string }>("SELECT id, external_listing_id FROM notifications WHERE user_id = $1 AND kind = 'new_external_match'", [w.userId])).rows[0];
  const expiring = (await pool.query<{ id: string; active_search_id: string }>("SELECT id, active_search_id FROM notifications WHERE user_id = $1 AND kind = 'active_search_expiring'", [w.userId])).rows[0];
  const seller = await makePerson(pool);
  const offer = await makeOffer(pool, seller.id);
  const probe = async (text: string, values: unknown[]): Promise<{ code?: string; constraint?: string } | null> => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      try {
        await client.query(text, values);
        return null;
      } catch (error) {
        const details = error as { code?: string; constraint?: string };
        return { code: details.code, constraint: details.constraint };
      } finally {
        await client.query("ROLLBACK");
      }
    } finally {
      client.release();
    }
  };
  const insert = (columns: Record<string, unknown>) => {
    const names = Object.keys(columns);
    return probe(`INSERT INTO notifications (${names.join(", ")}) VALUES (${names.map((_, index) => `$${index + 1}`).join(", ")})`, names.map((name) => columns[name]));
  };
  const base = { user_id: w.userId, demand_id: w.demandId };
  // Formes valides (aucune violation) : annonce d'un autre site sans annonce liée (ON DELETE SET NULL), avis d'échéance, annonce interne, résumé.
  assert.equal(await insert({ ...base, kind: "new_external_match", title: "iPhone 12", source_name: "Annonces Démo A" }), null);
  assert.equal(await insert({ ...base, kind: "new_match", offer_id: offer.id, title: "iPhone 12" }), null);
  assert.equal(await insert({ ...base, kind: "new_matches_digest", digest_day: "2031-01-01", item_count: 2 }), null);
  const shape = { code: "23514", constraint: "chk_notifications_shape" };
  // Formes refusées, une par règle de la table des genres.
  const refused: Array<[string, Record<string, unknown>]> = [
    ["annonce externe sans nom de source", { ...base, kind: "new_external_match", title: "iPhone 12" }],
    ["annonce externe sans titre", { ...base, kind: "new_external_match", source_name: "Source" }],
    ["annonce externe liée à une annonce interne", { ...base, kind: "new_external_match", title: "iPhone 12", source_name: "Source", offer_id: offer.id }],
    ["annonce externe avec un résumé", { ...base, kind: "new_external_match", title: "iPhone 12", source_name: "Source", digest_day: "2031-01-01", item_count: 1 }],
    ["annonce externe avec un avis", { ...base, kind: "new_external_match", title: "iPhone 12", source_name: "Source", active_search_id: expiring.active_search_id }],
    ["avis sans achat", { ...base, kind: "active_search_expiring" }],
    ["avis avec un titre", { ...base, kind: "active_search_expiring", active_search_id: bought.purchaseId, title: "iPhone 12" }],
    ["avis avec une annonce externe", { ...base, kind: "active_search_expiring", active_search_id: bought.purchaseId, external_listing_id: external.external_listing_id }],
    ["avis avec un nom de source", { ...base, kind: "active_search_expiring", active_search_id: bought.purchaseId, source_name: "Source" }],
    ["annonce interne avec un nom de source", { ...base, kind: "new_match", offer_id: offer.id, title: "iPhone 12", source_name: "Source" }],
    ["annonce interne avec une annonce externe", { ...base, kind: "new_match", offer_id: offer.id, title: "iPhone 12", external_listing_id: external.external_listing_id }],
    ["résumé avec une annonce externe", { ...base, kind: "new_matches_digest", digest_day: "2031-01-02", item_count: 2, external_listing_id: external.external_listing_id }],
    ["résumé avec un avis", { ...base, kind: "new_matches_digest", digest_day: "2031-01-03", item_count: 2, active_search_id: bought.purchaseId }],
  ];
  for (const [label, columns] of refused) assert.deepEqual(await insert(columns), shape, label);
  assert.deepEqual(await insert({ ...base, kind: "new_external_match", title: "x".repeat(161), source_name: "Source" }), shape, "titre de plus de 160 caractères");
  assert.equal((await insert({ ...base, kind: "new_external_match", title: "iPhone 12", source_name: "x".repeat(81) }))?.code, "23514", "nom de source de plus de 80 caractères");
  const unknownKind = await insert({ ...base, kind: "genre_inconnu", title: "iPhone 12" });
  assert.equal(unknownKind?.code, "23514", "un genre inconnu est refusé");
  assert.ok(["notifications_kind_check", "chk_notifications_shape"].includes(unknownKind?.constraint ?? ""));
  // Unicité : une notification par annonce externe et par besoin ; un seul avis par achat.
  assert.deepEqual(await insert({ ...base, kind: "new_external_match", title: "iPhone 12", source_name: "Source", external_listing_id: external.external_listing_id }), { code: "23505", constraint: "uq_notifications_new_external_match" });
  assert.deepEqual(await insert({ ...base, kind: "active_search_expiring", active_search_id: expiring.active_search_id }), { code: "23505", constraint: "uq_notifications_active_search_expiring" });
  // Envois externes : exactement une cible, annonce interne OU annonce externe.
  const delivery = (columns: Record<string, unknown>) => {
    const all = { user_id: w.userId, demand_id: w.demandId, channel: "sms_sim", next_attempt_at: new Date(), idempotency_key: `ra1-probe-${randomUUID()}`, content: JSON.stringify({ title: "x", price: null, link: `/besoins/${w.demandId}` }), ...columns };
    const names = Object.keys(all);
    return probe(`INSERT INTO notification_deliveries (${names.join(", ")}) VALUES (${names.map((name, index) => (name === "content" ? `$${index + 1}::jsonb` : `$${index + 1}`)).join(", ")})`, names.map((name) => (all as Record<string, unknown>)[name]));
  };
  assert.equal(await delivery({ offer_id: offer.id }), null, "cible interne");
  assert.equal(await delivery({ external_listing_id: external.external_listing_id }), null, "cible externe");
  assert.deepEqual(await delivery({}), { code: "23514", constraint: "chk_notification_deliveries_target" }, "aucune cible");
  assert.deepEqual(await delivery({ offer_id: offer.id, external_listing_id: external.external_listing_id }), { code: "23514", constraint: "chk_notification_deliveries_target" }, "deux cibles");
});

// ═════════════ 9. Lot RA1-bis : relevé de l'existant, suspension, quotas ═════════════

/** Synchronise les surveillances (crée celles des clés nouvelles) PUIS collecte : le cycle du worker, en deux gestes. */
const syncAndCollect = async (extra: Partial<CollectStepOptions> = {}) => {
  await syncMarketWatches(pool, clock.now());
  return collect(extra);
};

const versionOf = async (demandId: string): Promise<number> => (await pool.query<{ v: number }>("SELECT content_version AS v FROM demands WHERE id = $1", [demandId])).rows[0].v;
const stateOf = async (demandId: string) => (await pool.query<{ baseline_pending: boolean; product_key: string | null; baseline_cutoff_at: Date | null; scan_horizon_at: Date | null }>(
  "SELECT baseline_pending, product_key, baseline_cutoff_at, scan_horizon_at FROM active_search_state WHERE demand_id = $1", [demandId])).rows[0];

test("A1 / P1-a : modifier le MODÈLE d'un besoin avec option (nouvelle clé jamais collectée) → relevé EN ATTENTE ; la première collecte de la nouvelle clé n'est JAMAIS notifiée (existant), l'annonce suivante l'est", async () => {
  const w = await world();
  await collect();
  await buy(w);
  const quiet = await search();
  assert.deepEqual([quiet.notified, quiet.baselines], [0, 0]);
  const firstKey = (await stateOf(w.demandId)).product_key;
  await updateDemand({ id: w.demandId, ownerId: w.userId, expectedContentVersion: await versionOf(w.demandId), changes: { model: "iPhone 13", rawText: "Je cherche un iPhone 13" } }, pool);
  const afterEdit = await search();
  assert.deepEqual([afterEdit.notified, afterEdit.baselines], [0, 0], "la surveillance de la nouvelle clé n'existe pas encore : rien n'est relevé comme « complet »");
  const pending = await stateOf(w.demandId);
  assert.equal(pending.baseline_pending, true, "relevé en attente de la première collecte réussie");
  assert.notEqual(pending.product_key, firstKey, "la nouvelle clé est enregistrée");
  assert.equal(pending.baseline_cutoff_at, null);
  a.controls.extra = [listing("demo_a", 60, { title: "iPhone 13 128 Go violet" })];
  const first = await syncAndCollect();
  assert.equal(first.watchesProcessed, 1);
  assert.equal((await count(pool, "external_listings", "title LIKE 'iPhone 13%'")) >= 1, true, "des annonces iPhone 13 EXISTAIENT déjà au moment de la 1re collecte");
  const scan = await search();
  assert.deepEqual([scan.notified, scan.baselines], [0, 1], "l'existant de la nouvelle clé est relevé, jamais notifié");
  assert.equal((await externalNotifications(w.userId)).length, 0);
  assert.equal((await stateOf(w.demandId)).baseline_pending, false);
  a.controls.extra = [listing("demo_a", 60, { title: "iPhone 13 128 Go violet" }), listing("demo_a", 61, { title: "iPhone 13 256 Go bleu" })];
  clock.advance(HOUR);
  await collect();
  assert.equal((await search()).notified, 1, "une annonce vraiment nouvelle notifie");
});

test("A1 : modification de clé quand la surveillance de la nouvelle clé existe mais n'a AUCUNE collecte réussie récente (échec, ou plus de 48 h) → relevé en attente, jamais un relevé vide", async () => {
  const w = await world();
  await collect();
  await buy(w);
  // Une autre personne cherche déjà « iPhone 13 » : sa surveillance existe et a été collectée…
  const other = await world();
  await updateDemand({ id: other.demandId, ownerId: other.userId, expectedContentVersion: await versionOf(other.demandId), changes: { model: "iPhone 13", rawText: "iPhone 13" } }, pool);
  await syncAndCollect();
  const watch13 = "(SELECT id FROM market_watches WHERE product_key LIKE '%iphone 13%')";
  assert.ok(await count(pool, "external_collect_runs", `status = 'ok' AND watch_id IN ${watch13}`) >= 1, "la surveillance de la nouvelle clé a une collecte réussie");
  // … mais cette collecte est classée en ERREUR : aucune réussite.
  await pool.query(`UPDATE external_collect_runs SET status = 'error', error_code = 'source_unavailable' WHERE watch_id IN ${watch13}`);
  const seenBefore = await count(pool, "active_search_seen", `demand_id = '${w.demandId}'`);
  await updateDemand({ id: w.demandId, ownerId: w.userId, expectedContentVersion: await versionOf(w.demandId), changes: { model: "iPhone 13", rawText: "Je cherche un iPhone 13" } }, pool);
  const failed = await search();
  assert.deepEqual([failed.notified, failed.baselines], [0, 0]);
  assert.equal((await stateOf(w.demandId)).baseline_pending, true, "aucune collecte réussie : relevé en attente");
  assert.equal(await count(pool, "active_search_seen", `demand_id = '${w.demandId}'`), seenBefore, "rien de la nouvelle clé n'est marqué vu à partir d'une liste vide");
  // Collecte réussie PÉRIMÉE (plus de 48 h) : en attente aussi.
  await pool.query(`UPDATE external_collect_runs SET status = 'ok', error_code = NULL, finished_at = finished_at - interval '3 days', started_at = started_at - interval '3 days' WHERE watch_id IN ${watch13}`);
  await pool.query("UPDATE market_watches SET last_run_at = last_run_at + interval '1 minute'");
  const stale = await search();
  assert.deepEqual([stale.notified, stale.baselines], [0, 0]);
  assert.equal((await stateOf(w.demandId)).baseline_pending, true, "collecte réussie trop ancienne : toujours en attente");
  // La première collecte récente lève l'attente SANS notifier l'existant.
  clock.advance(HOUR);
  const scanned = await collect();
  assert.ok(scanned.watchesProcessed >= 1);
  const done = await search();
  assert.deepEqual([done.notified, done.baselines], [0, 1]);
  assert.equal((await externalNotifications(w.userId)).length, 0);
  assert.equal((await stateOf(w.demandId)).baseline_pending, false);
});

test("A1 : changement de clé vers une surveillance DÉJÀ collectée récemment par un autre besoin → relevé complet de la nouvelle clé (coupure = maintenant) : ses annonces, vues après l'achat, ne sont jamais notifiées", async () => {
  const w = await world();
  await collect();
  await buy(w);
  await search();
  const firstKey = (await stateOf(w.demandId)).product_key;
  // Un AUTRE acheteur cherche « iPhone 13 » : sa surveillance est collectée APRÈS l'achat de w (les annonces iPhone 13 sont vues pour la première fois après le dernier horizon de w).
  const other = await world();
  await updateDemand({ id: other.demandId, ownerId: other.userId, expectedContentVersion: await versionOf(other.demandId), changes: { model: "iPhone 13", rawText: "iPhone 13" } }, pool);
  a.controls.extra = [listing("demo_a", 66, { title: "iPhone 13 128 Go violet" })];
  clock.advance(HOUR);
  await syncAndCollect();
  assert.ok(await count(pool, "external_listings", "title LIKE 'iPhone 13%'") >= 1, "des annonces iPhone 13 existent déjà");
  await updateDemand({ id: w.demandId, ownerId: w.userId, expectedContentVersion: await versionOf(w.demandId), changes: { model: "iPhone 13", rawText: "Je cherche un iPhone 13" } }, pool);
  const scan = await search();
  assert.deepEqual([scan.notified, scan.baselines], [0, 1], "la clé a changé : relevé complet de la nouvelle clé, aucune annonce déjà présente n'est nouvelle");
  assert.equal((await externalNotifications(w.userId)).length, 0);
  const after = await stateOf(w.demandId);
  assert.equal(after.baseline_pending, false);
  assert.notEqual(after.product_key, firstKey, "la nouvelle clé est enregistrée");
  assert.ok(after.baseline_cutoff_at && after.baseline_cutoff_at.getTime() >= clock.now().getTime() - HOUR, "la coupure est l'instant du relevé, pas l'ancien horizon");
  a.controls.extra = [listing("demo_a", 66, { title: "iPhone 13 128 Go violet" }), listing("demo_a", 67, { title: "iPhone 13 256 Go bleu" })];
  clock.advance(HOUR);
  await collect();
  assert.equal((await search()).notified, 1, "seule l'annonce vraiment nouvelle notifie");
});

test("A2 : au moment d'une modification de clé, une surveillance dont la seule collecte RÉUSSIE date de plus de 48 h ne sert pas de relevé → en attente (jamais un relevé vide)", async () => {
  const w = await world();
  await collect();
  await buy(w);
  const other = await world();
  await updateDemand({ id: other.demandId, ownerId: other.userId, expectedContentVersion: await versionOf(other.demandId), changes: { model: "iPhone 13", rawText: "iPhone 13" } }, pool);
  await syncAndCollect();
  const watch13 = "(SELECT id FROM market_watches WHERE product_key LIKE '%iphone 13%')";
  assert.ok(await count(pool, "external_collect_runs", `status = 'ok' AND watch_id IN ${watch13}`) >= 1);
  // Sa collecte réussie date de 3 jours (elle reste « réussie », mais périmée).
  await pool.query(`UPDATE external_collect_runs SET finished_at = finished_at - interval '3 days', started_at = started_at - interval '3 days' WHERE watch_id IN ${watch13}`);
  const seenBefore = await count(pool, "active_search_seen", `demand_id = '${w.demandId}'`);
  await updateDemand({ id: w.demandId, ownerId: w.userId, expectedContentVersion: await versionOf(w.demandId), changes: { model: "iPhone 13", rawText: "Je cherche un iPhone 13" } }, pool);
  const scan = await search();
  assert.deepEqual([scan.notified, scan.baselines], [0, 0]);
  const state = await stateOf(w.demandId);
  assert.equal(state.baseline_pending, true, "collecte réussie périmée : relevé en attente");
  assert.equal(state.baseline_cutoff_at, null);
  assert.equal(await count(pool, "active_search_seen", `demand_id = '${w.demandId}'`), seenBefore, "rien n'est marqué vu à partir d'une liste périmée");
});

test("A1 / P1-b : un besoin satisfait puis réactivé 3 jours plus tard, option achetée : la collecte connue est PÉRIMÉE (plus de 48 h) → relevé en attente ; la collecte suivante relève l'existant sans notifier", async () => {
  const w = await world();
  await collect();
  const known = await count(pool, "external_listings");
  assert.ok(known >= 6);
  await satisfyDemand(w.userId, w.demandId, await versionOf(w.demandId), pool);
  await syncMarketWatches(pool, clock.now());
  clock.advance(3 * DAY);
  await activateDemand(w.userId, w.demandId, await versionOf(w.demandId), pool);
  await syncMarketWatches(pool, clock.now());
  await buy(w);
  assert.equal((await stateOf(w.demandId)).baseline_pending, true, "la dernière collecte réussie date de 3 jours : pas de relevé tout de suite");
  assert.equal(await count(pool, "active_search_seen"), 0, "rien n'est marqué vu à partir d'une liste périmée");
  assert.deepEqual((({ notified, baselines }) => [notified, baselines])(await search()), [0, 0]);
  await collect();
  const scan = await search();
  assert.deepEqual([scan.notified, scan.baselines], [0, 1]);
  assert.equal((await externalNotifications(w.userId)).length, 0, "aucune annonce déjà connue n'est notifiée comme nouvelle");
  a.controls.extra = [listing("demo_a", 62)];
  clock.advance(HOUR);
  await collect();
  assert.equal((await search()).notified, 1);
});

test("A2 : à l'achat, une collecte réussie de moins de 48 h donne un relevé immédiat ; DÉFENSE — une annonce vue pour la première fois avant l'instant de coupure du relevé ne notifie jamais, même si on efface sa marque « vue »", async () => {
  const w = await world();
  await collect();
  await buy(w);
  const state = await stateOf(w.demandId);
  assert.equal(state.baseline_pending, false, "collecte récente : relevé immédiat");
  assert.notEqual(state.baseline_cutoff_at, null);
  // On efface les marques « vues » de l'existant (corruption) : le balayage suivant ne notifie rien et les remarque comme existantes.
  const marked = await count(pool, "active_search_seen", "reason = 'baseline'");
  assert.ok(marked > 0);
  await pool.query("DELETE FROM active_search_seen WHERE demand_id = $1", [w.demandId]);
  await pool.query("UPDATE market_watches SET last_run_at = last_run_at + interval '1 minute'");
  const scan = await search();
  assert.equal(scan.notified, 0, "l'existant ne notifie jamais, même sans marque");
  assert.equal(await count(pool, "active_search_seen", "reason = 'baseline'"), marked, "l'existant est remarqué vu");
  assert.equal((await externalNotifications(w.userId)).length, 0);
  // Une annonce arrivée APRÈS la coupure notifie.
  a.controls.extra = [listing("demo_a", 63)];
  clock.advance(HOUR);
  await collect();
  assert.equal((await search()).notified, 1);
});

test("M2 / P6-b : annonce arrivée PENDANT la pause du suivi, puis le besoin est modifié (même clé) avant la reprise → elle est notifiée à la reprise ; l'existant d'avant la pause ne l'est pas", async () => {
  const w = await world({ budget: 2_000_000 });
  await collect();
  await buy(w);
  await search();
  await applyTrackingAction({ pool, ownerId: w.userId, demandId: w.demandId, action: "pause", now: clock.now() });
  a.controls.extra = [listing("demo_a", 64)];
  clock.advance(HOUR);
  await collect();
  const held = await search();
  assert.equal(held.trackingHeld, 1);
  assert.equal(held.notified, 0);
  await updateDemand({ id: w.demandId, ownerId: w.userId, expectedContentVersion: await versionOf(w.demandId), changes: { rawText: "Je cherche un iPhone 12 en bon état" } }, pool);
  await applyTrackingAction({ pool, ownerId: w.userId, demandId: w.demandId, action: "resume", now: clock.now() });
  const resumed = await search();
  assert.equal(resumed.notified, 1, "l'annonce arrivée pendant la pause est notifiée");
  const rows = await externalNotifications(w.userId);
  assert.deepEqual(rows.map((row) => row.title), ["iPhone 12 128 Go violet n°64"]);
});

test("A4 : besoin SATISFAIT = option SUSPENDUE — aucune notification, plus d'accélération (fréquence ordinaire), la période court ; réactivé, l'option reprend et l'annonce arrivée entre-temps notifie UNE fois, avec ou sans passage de l'entretien", async () => {
  const outcomes: Array<{ during: number; after: number; frequency: number; titles: string[] }> = [];
  for (const maintenanceBetween of [false, true]) {
    await resetDemands(pool);
    await resetExternal(pool);
    await pool.query("TRUNCATE notification_deliveries, notification_preferences CASCADE");
    fakes = createFakeConnectors();
    [a, b] = fakes;
    clock.set(BASE);
    const w = await world();
    await collect();
    await buy(w);
    await syncMarketWatches(pool, clock.now());
    await search();
    assert.equal((await watchRow())[0].frequency_seconds, 3_600, "avec l'option : accélérée");
    await satisfyDemand(w.userId, w.demandId, await versionOf(w.demandId), pool);
    if (maintenanceBetween) await runActiveSearchMaintenance(pool, clock.now());
    await syncMarketWatches(pool, clock.now());
    a.controls.extra = [listing("demo_a", 70)];
    clock.advance(HOUR);
    await collect();
    const during = await search();
    assert.equal(during.notified, 0, "suspendue : rien n'est notifié");
    assert.equal(await count(pool, "active_search_purchases", "status = 'active' AND stop_reason IS NULL"), 1, "la période court toujours");
    await activateDemand(w.userId, w.demandId, await versionOf(w.demandId), pool);
    await syncMarketWatches(pool, clock.now());
    clock.advance(HOUR);
    await collect();
    const after = await search();
    const rows = await externalNotifications(w.userId);
    outcomes.push({ during: during.notified, after: after.notified, frequency: (await watchRow())[0].frequency_seconds, titles: rows.map((row) => row.title) });
    // Rien ne se renotifie ensuite.
    clock.advance(HOUR);
    await collect();
    assert.equal((await search()).notified, 0);
  }
  assert.deepEqual(outcomes[0], outcomes[1], "même issue avec ou sans passage de l'entretien entre les deux");
  assert.deepEqual(outcomes[0].titles, ["iPhone 12 128 Go violet n°70"]);
  assert.equal(outcomes[0].after, 1);
  assert.equal(outcomes[0].frequency, 3_600, "réactivé : de nouveau accélérée");
});

test("A4 : pendant la suspension la surveillance retombe à sa fréquence ordinaire (6 h, 4 requêtes) si un AUTRE besoin actif la garde ; la clé n'est plus comptée dans la capacité accélérée", async () => {
  const paying = await world();
  await world();
  await collect();
  await buy(paying);
  await syncMarketWatches(pool, clock.now());
  assert.deepEqual((await watchRow()).map((row) => [row.frequency_seconds, row.daily_request_budget]), [[3_600, 24]]);
  await satisfyDemand(paying.userId, paying.demandId, await versionOf(paying.demandId), pool);
  const result = await syncMarketWatches(pool, clock.now());
  assert.ok(result.decelerated >= 1);
  assert.deepEqual((await watchRow()).map((row) => [row.frequency_seconds, row.daily_request_budget]), [[21_600, 4]], "retour aux valeurs ordinaires");
  const { acceleratedCapacity } = await import("../../lib/server/active-search/availability");
  assert.deepEqual((await acceleratedCapacity(pool, FAKE_ENV, clock.now())).keys, [], "plus aucune clé engagée");
});

test("M6 : l'accélération ne RALENTIT jamais une surveillance déjà plus rapide (intervalle minimal, budget maximal) et restaure exactement les valeurs de base à la fin", async () => {
  const w = await world();
  await collect();
  // Déjà plus rapide que l'option sur les deux axes : rien ne change.
  await pool.query("UPDATE market_watches SET frequency_seconds = 1800, daily_request_budget = 30");
  await buy(w);
  await syncMarketWatches(pool, clock.now());
  let row = (await pool.query<{ frequency_seconds: number; daily_request_budget: number; accelerated: boolean }>("SELECT frequency_seconds, daily_request_budget, accelerated FROM market_watches")).rows[0];
  assert.deepEqual([row.frequency_seconds, row.daily_request_budget], [1_800, 30], "ni plus lente ni plus petite");
  await refundActiveSearchPurchase({ pool, purchaseId: (await pool.query<{ id: string }>("SELECT id FROM active_search_purchases WHERE demand_id = $1", [w.demandId])).rows[0].id, reasonCode: "essai", now: clock.now() });
  await syncMarketWatches(pool, clock.now());
  row = (await pool.query("SELECT frequency_seconds, daily_request_budget, accelerated FROM market_watches")).rows[0];
  assert.deepEqual([row.frequency_seconds, row.daily_request_budget, row.accelerated], [1_800, 30, false], "les valeurs d'origine sont conservées");
  // Plus rapide sur un axe seulement : l'autre axe est accéléré, puis les DEUX reviennent à leur base.
  await pool.query("UPDATE market_watches SET frequency_seconds = 1800, daily_request_budget = 4");
  await buy(w);
  await syncMarketWatches(pool, clock.now());
  row = (await pool.query("SELECT frequency_seconds, daily_request_budget, accelerated FROM market_watches")).rows[0];
  assert.deepEqual([row.frequency_seconds, row.daily_request_budget, row.accelerated], [1_800, 24, true]);
  await pool.query("UPDATE active_search_purchases SET status = 'ended' WHERE demand_id = $1 AND status = 'active'", [w.demandId]);
  await syncMarketWatches(pool, clock.now());
  row = (await pool.query("SELECT frequency_seconds, daily_request_budget, accelerated FROM market_watches")).rows[0];
  assert.deepEqual([row.frequency_seconds, row.daily_request_budget, row.accelerated], [1_800, 4, false], "base restaurée exactement");
});

test("A5 / P4 : 12 options de UN acheteur + 1 surveillance ordinaire d'un autre sur une journée simulée (quota 200) → l'admission n'accepte que 4 produits, la surveillance ordinaire garde ses 4 collectes par source, les requêtes accélérées restent sous la moitié du quota", async () => {
  const payer = await makePerson(pool);
  await fund(pool, payer.id, 50_000);
  const other = await makePerson(pool);
  await makeDemand(pool, { ownerId: other.id, model: "Galaxy S21", brand: "Samsung" });
  const outcomes: string[] = [];
  for (let index = 1; index <= 12; index += 1) {
    const demand = await makeDemand(pool, { ownerId: payer.id, brand: "Google", model: `Pixel ${index}` });
    try {
      await buy({ userId: payer.id, demandId: demand.id, keyOf: () => randomUUID() });
      outcomes.push("ok");
    } catch (error) {
      outcomes.push((error as { code?: string }).code ?? "erreur");
    }
  }
  assert.equal(outcomes.filter((entry) => entry === "ok").length, 4, outcomes.join(","));
  assert.equal(outcomes.filter((entry) => entry === "capacity").length, 8, outcomes.join(","));
  assert.equal(await pool.query("SELECT balance::text AS b FROM wallet_accounts WHERE kind = 'user' AND owner_id = $1", [payer.id]).then((result) => result.rows[0].b), String(50_000 - 4 * ACTIVE_SEARCH_PRICE_XOF), "seuls 4 achats débités");
  const simulateDay = async (): Promise<void> => {
    for (let hour = 0; hour < 24; hour += 1) {
      clock.set(new Date(BASE.getTime() + hour * HOUR));
      for (let loop = 0; loop < 10; loop += 1) {
        clock.advance(60_000);
        const run = await runCollectStep({ pool, connectors: fakes, now: clock.now, sleep: timer.sleep, pseudonymKey: TEST_PSEUDONYM_KEY, maxWatches: 3 });
        if (run.claimed === 0) break;
      }
    }
  };
  await simulateDay();
  const ordinary = (await pool.query<{ source_code: string; requests: number }>(
    "SELECT u.source_code, u.requests FROM market_watch_usage u JOIN market_watches w ON w.id = u.watch_id WHERE w.product_key LIKE '%galaxy s21%' ORDER BY u.source_code")).rows;
  assert.deepEqual(ordinary.map((row) => row.requests), [4, 4], "la surveillance ordinaire d'un autre acheteur a ses 4 collectes du jour sur chaque source");
  const usage = (await pool.query<{ source_code: string; requests: number; accelerated_requests: number }>("SELECT source_code, requests, accelerated_requests FROM external_source_usage ORDER BY source_code")).rows;
  for (const row of usage) {
    assert.ok(row.accelerated_requests <= 100, `${row.source_code} : requêtes accélérées ${row.accelerated_requests} ≤ moitié du quota (100)`);
    assert.ok(row.requests <= 200, `${row.source_code} : quota total respecté`);
  }
});

test("A5 : le plafond de la moitié du quota est aussi appliqué à CHAQUE requête (pas seulement à l'achat) : un quota réduit après l'achat limite les requêtes accélérées, la part ordinaire reste intacte", async () => {
  const payer = await makePerson(pool);
  await fund(pool, payer.id, 50_000);
  const demands = [] as Array<{ userId: string; demandId: string; keyOf: () => string }>;
  for (let index = 1; index <= 4; index += 1) {
    const demand = await makeDemand(pool, { ownerId: payer.id, brand: "Google", model: `Pixel ${index}` });
    demands.push({ userId: payer.id, demandId: demand.id, keyOf: () => randomUUID() });
  }
  const ordinaryOwner = await makePerson(pool);
  await makeDemand(pool, { ownerId: ordinaryOwner.id, model: "Galaxy S21", brand: "Samsung" });
  for (const target of demands) await buy(target);
  await pool.query("UPDATE external_sources SET daily_quota = 60");
  for (let hour = 0; hour < 24; hour += 1) {
    clock.set(new Date(BASE.getTime() + hour * HOUR));
    for (let loop = 0; loop < 10; loop += 1) {
      clock.advance(60_000);
      const run = await runCollectStep({ pool, connectors: fakes, now: clock.now, sleep: timer.sleep, pseudonymKey: TEST_PSEUDONYM_KEY, maxWatches: 3 });
      if (run.claimed === 0) break;
    }
  }
  const usage = (await pool.query<{ source_code: string; requests: number; accelerated_requests: number }>("SELECT source_code, requests, accelerated_requests FROM external_source_usage ORDER BY source_code")).rows;
  for (const row of usage) {
    assert.ok(row.accelerated_requests <= 30, `${row.source_code} : requêtes accélérées ${row.accelerated_requests} ≤ 30 (moitié de 60)`);
    assert.ok(row.requests <= 60, `${row.source_code} : quota de 60 respecté`);
  }
  const ordinary = (await pool.query<{ requests: number }>(
    "SELECT u.requests FROM market_watch_usage u JOIN market_watches w ON w.id = u.watch_id WHERE w.product_key LIKE '%galaxy s21%'")).rows;
  assert.ok(ordinary.length > 0 && ordinary.every((row) => row.requests >= 4), "la surveillance ordinaire garde ses 4 collectes");
});
