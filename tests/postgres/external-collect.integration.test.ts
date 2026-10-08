import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { Pool } from "pg";
import { archiveDemand, createOffer, createUser, satisfyDemand, updateUser } from "../../lib/server/catalog";
import { runCollectStep, type CollectStepOptions, type Sleep } from "../../lib/server/external/collect";
import {
  BREAKER_FAILURE_THRESHOLD, BREAKER_PAUSE_MS, BREAKER_TRIAL_LEASE_MS, MAX_SOURCE_WAIT_MS, WATCH_CLAIM_LEASE_SECONDS, WATCH_DEFAULT_DAILY_BUDGET, WATCH_DEFAULT_FREQUENCY_SECONDS, WATCH_RETRY_SECONDS,
} from "../../lib/server/external/config";
import type { ExternalListingDraft, ProductKey, SourceConnector } from "../../lib/server/external/types";
import { runMatchingCycle } from "../../lib/server/matching/runner";
import { runMigrations } from "../../lib/server/postgres/migrations";
import {
  barrier, count, createFakeConnectors, fixedClock, installNetworkGuard, makeDemand, recordingSleep, resetDemands, resetExternal, selfTestNetworkGuard,
  type FakeConnector, type NetworkGuard,
} from "./external-fixtures";
import { createTemporarySchemaName, openVerifiedTestDatabase, quoteTemporarySchema } from "./test-database";
import { openTestSchema, type TestSchema } from "./social-fixtures";

/**
 * Collecte d'annonces externes MUTUALISÉE (lot EXT1) : surveillances partagées par clé produit, pause, budgets, délai par source, disjoncteur, isolation des pannes, étape
 * du runner, concurrence. Sources FICTIVES seulement ; un garde du réseau sortant échoue l'essai au moindre appel externe.
 */

const BASE = new Date("2026-10-07T10:00:00.000Z");
let env: TestSchema;
let guard: NetworkGuard;
let fakes: FakeConnector[];
let a: FakeConnector;
let b: FakeConnector;
const clock = fixedClock(BASE);
const timer = recordingSleep();

before(async () => {
  env = await openTestSchema(10);
  guard = installNetworkGuard();
  await selfTestNetworkGuard(guard);
});

after(async () => {
  guard?.restore();
  await env?.close();
});

beforeEach(async () => {
  await resetDemands(env.pool);
  await resetExternal(env.pool);
  fakes = createFakeConnectors();
  [a, b] = fakes;
  clock.set(BASE);
  timer.waits.length = 0;
});

const step = (extra: Partial<CollectStepOptions> = {}, pool: Pool = env.pool) =>
  runCollectStep({ pool, connectors: fakes, now: clock.now, sleep: timer.sleep, ...extra });
const makeDue = (where = "TRUE") => env.pool.query(`UPDATE market_watches SET next_run_at = $1 WHERE ${where}`, [new Date(clock.now().getTime() - 1_000)]);
const watches = async () => (await env.pool.query("SELECT * FROM market_watches ORDER BY product_key")).rows;
const source = async (code: string) => (await env.pool.query("SELECT * FROM external_sources WHERE code = $1", [code])).rows[0];

// ───────────── mutualisation ─────────────

test("trois besoins de même clé : UNE surveillance, UNE collecte (une requête par source, jamais une par besoin)", async () => {
  await makeDemand(env.pool, { budget: 150_000 });
  await makeDemand(env.pool, { budget: 200_000, rawText: "iPhone 12 pas cher" });
  await makeDemand(env.pool, { budget: 300_000, rawText: "Un iPhone 12 svp" });
  const result = await step();
  assert.deepEqual(result.errors, []);
  assert.equal(result.sync.activeKeys, 1);
  assert.equal(result.sync.created, 1);
  assert.equal(await count(env.pool, "market_watches"), 1, "une seule surveillance pour les trois besoins");
  assert.equal(result.claimed, 1);
  assert.equal(result.watchesProcessed, 1);
  assert.equal(result.sourceCalls, 2, "une requête par source : 2, jamais 3 × 2");
  assert.equal(a.controls.calls, 1);
  assert.equal(b.controls.calls, 1);
  assert.equal(await count(env.pool, "external_collect_runs", "status = 'ok'"), 2);
  assert.ok(result.created > 0);
  // Les trois besoins relisent la MÊME surveillance : une collecte de plus n'est due qu'à l'échéance (6 h).
  const again = await step();
  assert.equal(again.claimed, 0, "rien de dû tout de suite");
  assert.equal(a.controls.calls, 1);
  clock.advance(6 * 3_600_000 + 1_000);
  const later = await step();
  assert.equal(later.claimed, 1);
  assert.equal(later.sourceCalls, 2);
  assert.equal(a.controls.calls, 2);
  assert.equal(await count(env.pool, "market_watches"), 1);
});

test("clé normalisée : casse, accents et espaces ne créent pas une autre surveillance ; une variante ou une zone différente, si", async () => {
  await makeDemand(env.pool, { category: "Téléphones", brand: "Apple", model: "iPhone 12", location: "Abidjan" });
  await makeDemand(env.pool, { category: "  téléphones ", brand: "APPLE", model: "iphone   12", location: "ABIDJAN" });
  await step();
  assert.equal(await count(env.pool, "market_watches"), 1);
  await makeDemand(env.pool, { variant: "128 Go" });
  await makeDemand(env.pool, { location: "Cocody" });
  await makeDemand(env.pool, { location: null });
  const result = await step();
  assert.equal(result.sync.activeKeys, 4);
  assert.equal(result.sync.created, 3);
  const rows = await watches();
  assert.equal(rows.length, 4);
  assert.deepEqual(rows.map((row) => `${row.variant ?? "-"}|${row.zone}`).sort(), ["-|", "-|abidjan", "-|cocody", "128 go|abidjan"]);
  assert.ok(rows.every((row) => row.category === "telephones" && row.brand === "apple" && row.model === "iphone 12"));
});

test("un besoin sans catégorie, marque ou modèle, un brouillon et le besoin d'un compte suspendu ne créent aucune surveillance", async () => {
  const owner = await createUser({}, env.pool);
  await makeDemand(env.pool, { ownerId: owner.id, status: "draft" });
  await env.pool.query("INSERT INTO demands (id, owner_id, status, raw_text, category, brand) VALUES (gen_random_uuid(), $1, 'active', 'sans modèle', 'Téléphones', 'Apple')", [owner.id]);
  const suspended = await createUser({}, env.pool);
  await makeDemand(env.pool, { ownerId: suspended.id });
  await updateUser({ id: suspended.id, expectedVersion: suspended.version, status: "suspended" }, env.pool);
  const result = await step();
  assert.equal(result.sync.activeKeys, 0);
  assert.equal(await count(env.pool, "market_watches"), 0);
  assert.equal(result.sourceCalls, 0);
});

test("besoin clos : la surveillance reste active tant qu'un besoin actif la référence, puis passe en pause ; un nouveau besoin la réactive", async () => {
  const first = await makeDemand(env.pool);
  const second = await makeDemand(env.pool);
  await step();
  assert.equal((await watches())[0].status, "active");
  await satisfyDemand(first.ownerId, first.id, first.contentVersion, env.pool);
  const stillWatched = await step();
  assert.equal(stillWatched.sync.paused, 0);
  assert.equal((await watches())[0].status, "active", "un besoin actif la référence encore");
  await archiveDemand(second.ownerId, second.id, second.contentVersion, env.pool);
  const closed = await step();
  assert.equal(closed.sync.paused, 1);
  const paused = (await watches())[0];
  assert.equal(paused.status, "paused");
  assert.notEqual(paused.paused_at, null);
  // Une surveillance en pause n'est plus due : plus aucune requête.
  clock.advance(7 * 3_600_000);
  const calls = a.controls.calls;
  const idle = await step();
  assert.equal(idle.claimed, 0);
  assert.equal(a.controls.calls, calls);
  await makeDemand(env.pool);
  const resumed = await step();
  assert.equal(resumed.sync.reactivated, 1);
  assert.equal(resumed.sync.created, 0);
  assert.equal(await count(env.pool, "market_watches"), 1, "la même surveillance est rattachée");
  assert.equal((await watches())[0].status, "active");
  assert.equal(resumed.claimed, 1, "échue : collectée");
});

// ───────────── budgets, quota, délai par source ─────────────

test("budget de la surveillance par source et par jour : respecté, remis à zéro le lendemain", async () => {
  await makeDemand(env.pool);
  await step(); // 1re requête de chaque source
  await env.pool.query("UPDATE market_watches SET daily_request_budget = 2");
  await makeDue();
  const second = await step();
  assert.equal(second.sourceCalls, 2, "2e requête de chaque source : dans le budget");
  await makeDue();
  const third = await step();
  assert.equal(third.sourceCalls, 0, "budget de 2 par source atteint");
  assert.equal(third.budgetSkipped, 2);
  assert.equal(a.controls.calls, 2);
  assert.equal(b.controls.calls, 2);
  assert.equal((await env.pool.query("SELECT sum(requests)::int AS n FROM market_watch_usage")).rows[0].n, 4);
  // Rien n'a pu être interrogé parce que le budget du jour est atteint : la surveillance revient au prochain minuit UTC (les compteurs sont par jour UTC), pas toutes les 10 minutes.
  const row = (await watches())[0];
  assert.equal(new Date(row.next_run_at).toISOString(), "2026-10-08T00:00:00.000Z");
  // Le lendemain (jour UTC suivant), le budget est neuf.
  clock.set(new Date("2026-10-08T00:30:00.000Z"));
  await makeDue();
  const nextDay = await step();
  assert.equal(nextDay.sourceCalls, 2);
  assert.equal(a.controls.calls, 3);
});

test("quota journalier de la source : une surveillance de plus attend le lendemain, sans toucher à l'autre source", async () => {
  await makeDemand(env.pool);
  await makeDemand(env.pool, { model: "Galaxy S21", brand: "Samsung" });
  await env.pool.query("UPDATE external_sources SET daily_quota = 1 WHERE code = 'demo_a'");
  const result = await step();
  assert.equal(result.watchesProcessed, 2);
  assert.equal(a.controls.calls, 1, "quota de 1 pour la source A");
  assert.equal(b.controls.calls, 2, "la source B n'est pas concernée");
  assert.equal(result.quotaSkipped, 1);
  assert.equal((await env.pool.query("SELECT requests FROM external_source_usage WHERE source_code = 'demo_a'")).rows[0].requests, 1);
});

test("délai minimal par source : l'attente est imposée entre deux requêtes de la même source, bornée", async () => {
  await makeDemand(env.pool);
  await makeDemand(env.pool, { model: "Galaxy S21", brand: "Samsung" });
  await env.pool.query("UPDATE external_sources SET min_interval_ms = 1000");
  const result = await step();
  assert.equal(result.watchesProcessed, 2);
  // La première requête de chaque source part tout de suite ; la seconde attend le délai minimal.
  assert.equal(result.waits, 2);
  assert.deepEqual(timer.waits, [1000, 1000]);
  // Délai démesuré : la requête n'est PAS avancée, elle est refusée (voir le test dédié).
  timer.waits.length = 0;
  await env.pool.query("UPDATE external_sources SET min_interval_ms = 3600000, last_request_at = $1", [clock.now()]);
  await makeDue();
  clock.advance(1_000);
  const refused = await step();
  assert.deepEqual(timer.waits, [], "aucune attente écourtée à 5 s");
  assert.equal(refused.sourceCalls, 0);
  assert.equal(refused.intervalSkipped, 4, "2 surveillances × 2 sources");
});

// ───────────── disjoncteur ─────────────

test("disjoncteur : 3 échecs de suite → pause de 30 minutes (aucun appel) → reprise au premier succès", async () => {
  await makeDemand(env.pool);
  await env.pool.query("UPDATE market_watches SET daily_request_budget = 20");
  a.controls.failure = new Error("panne simulée");
  for (let attempt = 1; attempt <= 3; attempt++) {
    await makeDue();
    const result = await step();
    assert.equal(result.sourceFailures, 1, `échec n°${attempt}`);
    assert.equal(b.controls.calls, attempt, "la source B continue de répondre");
    assert.deepEqual(result.errors, [], "une panne de source n'est pas une erreur de l'étape");
    clock.advance(1_000);
  }
  let row = await source("demo_a");
  assert.equal(row.consecutive_failures, 3);
  assert.notEqual(row.breaker_open_until, null, "disjoncteur ouvert au 3e échec");
  assert.equal(new Date(row.breaker_open_until).getTime() - new Date(row.last_failure_at).getTime(), BREAKER_PAUSE_MS);
  assert.equal(row.last_error_code, "connector_error");
  // Pendant la pause : aucune requête à la source A.
  const callsDuringPause = a.controls.calls;
  await makeDue();
  clock.advance(10 * 60_000);
  const paused = await step();
  assert.equal(a.controls.calls, callsDuringPause, "aucun appel pendant la pause");
  assert.equal(paused.breakerSkipped, 1);
  assert.equal(paused.sourceFailures, 0);
  assert.equal(b.controls.calls, 4, "B est interrogée normalement");
  // Reprise : la pause est écoulée, la source répond de nouveau.
  a.controls.failure = null;
  await makeDue();
  clock.advance(BREAKER_PAUSE_MS);
  const resumed = await step();
  assert.equal(a.controls.calls, callsDuringPause + 1, "un essai décisif");
  assert.equal(resumed.sourceFailures, 0);
  row = await source("demo_a");
  assert.equal(row.consecutive_failures, 0);
  assert.equal(row.breaker_open_until, null);
  assert.equal(row.last_error_code, null);
  assert.ok(row.last_success_at);
});

test("disjoncteur semi-ouvert : un échec après la pause le rouvre aussitôt pour 30 minutes", async () => {
  await makeDemand(env.pool);
  await env.pool.query("UPDATE market_watches SET daily_request_budget = 20");
  a.controls.failure = new Error("panne");
  for (let attempt = 0; attempt < 3; attempt++) {
    await makeDue();
    await step();
    clock.advance(1_000);
  }
  clock.advance(BREAKER_PAUSE_MS + 1_000);
  await makeDue();
  const probe = await step();
  assert.equal(probe.sourceFailures, 1, "l'essai décisif échoue");
  assert.equal(probe.breakerOpened, 1);
  const row = await source("demo_a");
  assert.equal(row.consecutive_failures, 4);
  assert.ok(new Date(row.breaker_open_until).getTime() >= clock.now().getTime() + BREAKER_PAUSE_MS - 1_000);
  const callsAfterProbe = a.controls.calls;
  await makeDue();
  const next = await step();
  assert.equal(next.breakerSkipped, 1);
  assert.equal(a.controls.calls, callsAfterProbe);
});

test("une source en panne ne bloque ni l'autre source ni la surveillance suivante", async () => {
  await makeDemand(env.pool);
  await makeDemand(env.pool, { model: "Galaxy S21", brand: "Samsung" });
  a.controls.failure = new Error("la source A est en panne");
  const result = await step();
  assert.deepEqual(result.errors, []);
  assert.equal(result.watchesProcessed, 2, "les deux surveillances sont traitées");
  assert.equal(result.sourceFailures, 2);
  assert.equal(b.controls.calls, 2);
  const stored = await env.pool.query("SELECT source_code, count(*)::int AS n FROM external_listings GROUP BY source_code");
  assert.deepEqual(stored.rows.map((row) => row.source_code), ["demo_b"], "seules les annonces de la source saine sont stockées");
  assert.equal(await count(env.pool, "external_collect_runs", "status = 'error' AND source_code = 'demo_a'"), 2);
  assert.equal(await count(env.pool, "external_collect_runs", "status = 'ok' AND source_code = 'demo_b'"), 2);
  // La surveillance est replanifiée dans son ensemble : une source en panne n'est réessayée qu'à la prochaine échéance de la surveillance (6 h), pas plus tôt.
  for (const row of await watches()) assert.equal(new Date(row.next_run_at).getTime(), BASE.getTime() + 6 * 3_600_000);
});

test("par défaut, au plus 3 surveillances sont collectées par cycle ; la 4e l'est au cycle suivant", async () => {
  for (const [brand, model] of FOUR) await makeDemand(env.pool, { brand, model });
  const first = await step();
  assert.equal(first.claimed, 3);
  assert.equal(first.watchesProcessed, 3);
  const second = await step();
  assert.equal(second.claimed, 1, "les trois autres ne sont dues que dans 6 h");
  assert.equal(second.watchesProcessed, 1);
  assert.equal(a.controls.calls, 4);
});

test("source lente : abandonnée au délai (échec « timeout »), l'autre source n'attend pas", async () => {
  await makeDemand(env.pool);
  a.controls.latencyMs = 2_000;
  const started = Date.now();
  const result = await step({ searchTimeoutMs: 150 });
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 1_500, `l'étape n'attend pas la source lente (${elapsed} ms)`);
  assert.equal(result.sourceFailures, 1);
  assert.equal((await source("demo_a")).last_error_code, "timeout");
  assert.equal(await count(env.pool, "external_collect_runs", "status = 'ok' AND source_code = 'demo_b'"), 1);
  assert.ok(result.created > 0, "les annonces de la source B sont stockées");
});

test("réponses invalides : non-liste, rebuts seuls, exception non standard → échecs de la source, jamais de la collecte", async () => {
  await makeDemand(env.pool);
  await env.pool.query("UPDATE market_watches SET daily_request_budget = 20");
  b.controls.malformed = true;
  a.controls.failure = "texte brut jeté";
  const first = await step();
  assert.deepEqual(first.errors, []);
  assert.equal(first.sourceFailures, 2);
  assert.equal((await source("demo_a")).last_error_code, "connector_error");
  assert.equal((await source("demo_b")).last_error_code, "invalid_response");
  // Une liste faite uniquement de rebuts : la source a changé de format.
  b.controls.malformed = false;
  a.controls.failure = null;
  a.controls.extra = [];
  await makeDue();
  clock.advance(1_000);
  const junk = createFakeConnectors()[0];
  junk.search = async () => [{ nope: 1 }, "x", null] as never;
  const rebuts = await step({ connectors: [junk, b] });
  assert.equal(rebuts.sourceFailures, 1);
  assert.equal((await source("demo_a")).last_error_code, "invalid_response");
  assert.ok(!JSON.stringify(await env.pool.query("SELECT * FROM external_collect_runs")).includes("texte brut"), "jamais le message d'une source");
});

// ───────────── étape du runner ─────────────

test("l'étape du runner : tout passe par runMatchingCycle ; une collecte en échec laisse le runner vert et les jobs exécutés", async () => {
  const seller = await createUser({}, env.pool);
  await createOffer({ ownerId: seller.id, rawText: "iPhone 12 128 Go", category: "Téléphones", brand: "Apple", model: "iPhone 12", price: { amount: 150_000, currency: "XOF" }, location: "Cocody", status: "published" }, env.pool);
  await makeDemand(env.pool);
  // Collecte saine : le cycle rapporte l'étape.
  const healthy = await runMatchingCycle({ pool: env.pool, workerId: "ext-a", notificationTransport: null, collect: { connectors: fakes, now: clock.now, sleep: timer.sleep } });
  assert.deepEqual(healthy.errors, []);
  assert.equal(healthy.collect.watchesProcessed, 1);
  assert.equal(healthy.collect.sourceCalls, 2);
  assert.ok(healthy.jobs.length > 0, "le matching interne a travaillé");
  assert.equal(healthy.idle, false);

  // Collecte qui lève (connecteur qui explose) : la panne est une panne de SOURCE, le cycle reste vert.
  await makeDue();
  a.controls.failure = new Error("explosion");
  const sourceDown = await runMatchingCycle({ pool: env.pool, workerId: "ext-a", notificationTransport: null, collect: { connectors: fakes, now: clock.now, sleep: timer.sleep } });
  assert.deepEqual(sourceDown.errors, [], "une source en panne n'est pas une erreur du cycle");
  assert.equal(sourceDown.collect.sourceFailures, 1);

  // Panne de la base pendant l'étape seulement : code stable, les autres étapes ont travaillé.
  const second = await createUser({}, env.pool);
  await createOffer({ ownerId: second.id, rawText: "iPhone 12 64 Go", category: "Téléphones", brand: "Apple", model: "iPhone 12", price: { amount: 120_000, currency: "XOF" }, location: "Marcory", status: "published" }, env.pool);
  await makeDue();
  const spy = Object.create(env.pool) as Pool;
  spy.query = ((...args: unknown[]) => {
    const text = typeof args[0] === "string" ? args[0] : "";
    if (text.includes("FOR UPDATE SKIP LOCKED") && text.includes("market_watches")) return Promise.reject(Object.assign(new Error("hôte secret 10.0.0.1"), { code: "57P01" }));
    return (env.pool.query as (...a: unknown[]) => unknown)(...args);
  }) as never;
  const broken = await runMatchingCycle({ pool: spy, workerId: "ext-a", notificationTransport: null, collect: { connectors: fakes, now: clock.now, sleep: timer.sleep } });
  assert.deepEqual(broken.errors, ["collect_error_57p01"]);
  assert.ok(broken.jobs.length > 0, "les jobs du matching sont exécutés malgré l'échec de la collecte");
  assert.ok(!JSON.stringify(broken).includes("secret"), "ni message ni hôte dans le résultat");
  // Un cycle ensuite : tout est revenu.
  const after = await runMatchingCycle({ pool: env.pool, workerId: "ext-a", notificationTransport: null, collect: { connectors: fakes, now: clock.now, sleep: timer.sleep } });
  assert.deepEqual(after.errors, []);
  assert.equal(after.collect.watchesProcessed, 1);
});

// Tests d'intégration du runner (rebase EXT1 sur INT1, H1 et SMS1) : l'étape « collect » cohabite avec les étapes « subscriptions », « market » et « notify ».

test("runner : une surveillance collectée est du travail (idle faux), l'absence de travail laisse le cycle au repos", async () => {
  await makeDemand(env.pool);
  const cycle = () => runMatchingCycle({ pool: env.pool, workerId: "ext-idle", notificationTransport: null, collect: { connectors: fakes, now: clock.now, sleep: timer.sleep } });
  let quiet = await cycle();
  for (let index = 0; index < 12 && !quiet.idle; index += 1) quiet = await cycle();
  assert.equal(quiet.idle, true, "tout le travail interne est fait et la surveillance n'est pas due : le cycle est au repos");
  assert.equal(quiet.collect.watchesProcessed, 0);
  await makeDue();
  const work = await cycle();
  assert.equal(work.collect.watchesProcessed, 1);
  assert.equal(work.jobs.length, 0, "aucun job interne : seule la collecte a travaillé");
  assert.equal(work.idle, false, "une surveillance collectée compte comme du travail");
});

test("runner : un signal déjà déclenché empêche la collecte de commencer une surveillance (arrêt propre du worker)", async () => {
  await makeDemand(env.pool);
  const controller = new AbortController();
  controller.abort();
  const cycle = await runMatchingCycle({ pool: env.pool, workerId: "ext-abort", notificationTransport: null, signal: controller.signal, collect: { connectors: fakes, now: clock.now, sleep: timer.sleep } });
  assert.equal(cycle.collect.watchesProcessed, 0);
  assert.equal(cycle.collect.sourceCalls, 0);
  assert.equal(a.controls.calls, 0);
  assert.equal(b.controls.calls, 0);
});

test("runner : l'étape « collect » est isolée même quand l'appel lui-même lève (code stable, les étapes précédentes ont travaillé)", async () => {
  const seller = await createUser({}, env.pool);
  await createOffer({ ownerId: seller.id, rawText: "iPhone 12 128 Go", category: "Téléphones", brand: "Apple", model: "iPhone 12", price: { amount: 150_000, currency: "XOF" }, location: "Cocody", status: "published" }, env.pool);
  await makeDemand(env.pool);
  const exploding = new Proxy({}, { ownKeys() { throw Object.assign(new Error("hôte secret 10.0.0.1"), { code: "XX000" }); } }) as never;
  const cycle = await runMatchingCycle({ pool: env.pool, workerId: "ext-throw", notificationTransport: null, collect: exploding });
  assert.deepEqual(cycle.errors, ["collect_error_xx000"]);
  assert.ok(cycle.jobs.length > 0, "les jobs du matching sont exécutés malgré l'échec de l'étape");
  assert.equal(cycle.subscriptions.skipped, false, "l'étape des abonnements a tourné");
  assert.equal(cycle.market.skipped, false, "l'étape du relevé des prix a tourné");
  assert.equal(cycle.collect.watchesProcessed, 0);
  assert.ok(!JSON.stringify(cycle).includes("secret"), "ni message ni hôte dans le résultat");
});

test("sans connecteur (production, ou fictifs non autorisés) : surveillances synchronisées, rien collecté, aucun appel", async () => {
  await makeDemand(env.pool);
  const none = await step({ connectors: null });
  assert.equal(none.noConnectors, true);
  assert.equal(none.sync.created, 1);
  assert.equal(none.sourceCalls, 0);
  const empty = await step({ connectors: [] });
  assert.equal(empty.noConnectors, true);
  assert.equal(await count(env.pool, "external_collect_runs"), 0);
  const cycle = await runMatchingCycle({ pool: env.pool, workerId: "ext-b", notificationTransport: null, collect: { connectors: null } });
  assert.equal(cycle.collect.noConnectors, true);
  assert.deepEqual(cycle.errors, []);
});

test("sans la migration 0025 : l'étape est ignorée sans erreur et le cycle travaille", async () => {
  const opened = await openVerifiedTestDatabase(process.env.TEST_DATABASE_URL);
  const schema = createTemporarySchemaName();
  await opened.pool.query(`CREATE SCHEMA ${quoteTemporarySchema(schema)}`);
  const bare = new Pool({ connectionString: opened.target.connectionString, max: 2, options: `-c search_path=${schema}` });
  try {
    assert.equal((await runMigrations(bare)).applied.at(-1), "0026_sublymus_payments");
    await bare.query("DROP TABLE source_observations, external_listings, duplicate_groups, external_analyses, external_collect_runs, external_source_usage, market_watch_usage, market_watches, external_sources CASCADE");
    await bare.query("DELETE FROM noma_schema_migrations WHERE version = '0025_external_collection'");
    const direct = await runCollectStep({ pool: bare, connectors: fakes, now: clock.now });
    assert.equal(direct.skipped, true);
    assert.deepEqual(direct.errors, []);
    const cycle = await runMatchingCycle({ pool: bare, workerId: "ext-c", notificationTransport: null, collect: { connectors: fakes } });
    assert.equal(cycle.collect.skipped, true);
    assert.deepEqual(cycle.errors, []);
    assert.equal(a.controls.calls, 0, "aucun connecteur appelé");
  } finally {
    await bare.end().catch(() => undefined);
    await opened.pool.query(`DROP SCHEMA IF EXISTS ${quoteTemporarySchema(schema)} CASCADE`).catch(() => undefined);
    await opened.pool.end().catch(() => undefined);
  }
});

test("migration 0025 appliquée à neuf : deux sources fictives (200 requêtes par jour, 250 ms), surveillances toutes les 6 h avec 4 requêtes par jour et par source, jetons de bail et d'essai, unicité par source", async () => {
  const opened = await openVerifiedTestDatabase(process.env.TEST_DATABASE_URL);
  const schema = createTemporarySchemaName();
  await opened.pool.query(`CREATE SCHEMA ${quoteTemporarySchema(schema)}`);
  const fresh = new Pool({ connectionString: opened.target.connectionString, max: 2, options: `-c search_path=${schema}` });
  try {
    await runMigrations(fresh);
    const sources = (await fresh.query("SELECT code, name, type, enabled, daily_quota, min_interval_ms, breaker_trial_until FROM external_sources ORDER BY code")).rows;
    assert.deepEqual(sources.map((row) => [row.code, row.name, row.type, row.enabled, row.daily_quota, row.min_interval_ms, row.breaker_trial_until]), [
      ["demo_a", "Annonces Démo A", "fake", true, 200, 250, null], ["demo_b", "Annonces Démo B", "fake", true, 200, 250, null],
    ]);
    const columns = (await fresh.query("SELECT column_name, column_default FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'market_watches'")).rows;
    const defaults = Object.fromEntries(columns.map((row) => [row.column_name, row.column_default]));
    assert.equal(defaults.frequency_seconds, String(WATCH_DEFAULT_FREQUENCY_SECONDS), "une collecte toutes les 6 h");
    assert.equal(defaults.daily_request_budget, String(WATCH_DEFAULT_DAILY_BUDGET), "4 requêtes par jour et par source");
    assert.ok("claim_token" in defaults, "jeton du bail");
    const definitions = (await fresh.query("SELECT conname, pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid = 'external_listings'::regclass AND contype = 'u' ORDER BY conname")).rows;
    assert.deepEqual(definitions.map((row) => [row.conname, row.definition]), [
      ["uq_external_listings_canonical_url", "UNIQUE (source_code, canonical_url)"], ["uq_external_listings_source_external", "UNIQUE (source_code, external_id)"],
    ]);
  } finally {
    await fresh.end().catch(() => undefined);
    await opened.pool.query(`DROP SCHEMA IF EXISTS ${quoteTemporarySchema(schema)} CASCADE`).catch(() => undefined);
    await opened.pool.end().catch(() => undefined);
  }
});

// ───────────── concurrence, bail, temps ─────────────

test("deux exécuteurs en concurrence : chaque surveillance n'est collectée qu'UNE fois", async () => {
  for (const model of ["iPhone 12", "Galaxy S21", "MacBook Air M1"]) await makeDemand(env.pool, { model, brand: model === "iPhone 12" ? "Apple" : model === "Galaxy S21" ? "Samsung" : "Apple" });
  for (const connector of fakes) connector.controls.onSearch = async () => new Promise((resolve) => setTimeout(resolve, 60));
  const other = env.extraPool(6);
  const [first, second] = await Promise.all([step({ maxWatches: 2 }), step({ maxWatches: 2 }, other)]);
  assert.deepEqual([...first.errors, ...second.errors], []);
  assert.equal(first.claimed + second.claimed, 3, "chaque surveillance est réservée une seule fois");
  assert.equal(a.controls.calls, 3, "une requête par surveillance et par source, pas une de plus");
  assert.equal(b.controls.calls, 3);
  assert.equal(await count(env.pool, "external_collect_runs"), 6);
  assert.equal(await count(env.pool, "external_listings", "TRUE") > 0, true);
  // Aucune annonce en double malgré les deux exécuteurs.
  assert.equal((await env.pool.query("SELECT count(*)::int AS n FROM (SELECT source_code, external_id FROM external_listings GROUP BY 1, 2 HAVING count(*) > 1) d")).rows[0].n, 0);
});

test("FOR UPDATE SKIP LOCKED : une surveillance tenue par un autre processus est laissée, sans attendre", async () => {
  await makeDemand(env.pool);
  await step({ connectors: null }); // crée la surveillance
  await makeDue();
  const holder = await env.pool.connect();
  try {
    await holder.query("BEGIN");
    await holder.query("SELECT id FROM market_watches FOR UPDATE");
    const started = Date.now();
    const raced = await Promise.race([step(), new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 2_500))]);
    assert.notEqual(raced, "blocked", "l'étape ne doit pas attendre le verrou d'un autre processus");
    assert.ok(Date.now() - started < 2_000);
    const result = raced as Awaited<ReturnType<typeof step>>;
    assert.equal(result.claimed, 0, "la surveillance verrouillée est laissée");
    assert.equal(a.controls.calls, 0);
  } finally {
    await holder.query("ROLLBACK").catch(() => undefined);
    holder.release();
  }
  const released = await step();
  assert.equal(released.claimed, 1, "une fois libérée, elle est collectée");
});

test("bail : une surveillance réservée dont le traitement échoue n'est pas reprise en boucle, mais à l'expiration du bail", async () => {
  await makeDemand(env.pool);
  const crashed = await step({ hooks: { afterClaim: () => { throw Object.assign(new Error("mort du processus"), { code: "XX000" }); } } });
  assert.deepEqual(crashed.errors, ["xx000"]);
  assert.equal(a.controls.calls, 0);
  const row = (await watches())[0];
  assert.equal(new Date(row.next_run_at).getTime(), clock.now().getTime() + 600_000, "bail de 10 minutes");
  assert.equal((await step()).claimed, 0, "pas de reprise immédiate");
  clock.advance(601_000);
  const retried = await step();
  assert.equal(retried.claimed, 1);
  assert.equal(retried.sourceCalls, 2);
});

test("budget de temps de l'étape : les surveillances non commencées sont rendues, la première est terminée", async () => {
  for (const [brand, model] of [["Apple", "iPhone 12"], ["Samsung", "Galaxy S21"], ["Apple", "MacBook Air M1"]]) await makeDemand(env.pool, { brand, model });
  a.controls.onSearch = async () => new Promise((resolve) => setTimeout(resolve, 80));
  const result = await step({ stepBudgetMs: 20, maxWatches: 3 });
  assert.equal(result.claimed, 3);
  assert.equal(result.watchesProcessed, 1);
  assert.equal(result.released, 2);
  const due = await env.pool.query("SELECT count(*)::int AS n FROM market_watches WHERE next_run_at <= $1", [clock.now()]);
  assert.equal(due.rows[0].n, 2, "les deux autres sont dues tout de suite");
  // Rendues SANS consommer ni quota ni budget : seules les deux requêtes de la surveillance commencée sont comptées ; les deux autres n'ont ni compteur, ni journal, ni bail.
  assert.equal((await env.pool.query("SELECT coalesce(sum(requests), 0)::int AS n FROM external_source_usage")).rows[0].n, 2);
  assert.equal(await count(env.pool, "market_watch_usage"), 2);
  assert.equal(await count(env.pool, "external_collect_runs"), 2);
  assert.equal(await count(env.pool, "market_watches", "claim_token IS NOT NULL"), 0, "aucun bail ne reste posé");
  assert.equal(a.controls.calls, 1);
  // Le cycle suivant les reprend (quota et budget intacts pour elles).
  const next = await step({ maxWatches: 3 });
  assert.equal(next.watchesProcessed, 2);
  assert.equal(next.budgetSkipped + next.quotaSkipped, 0);
  assert.equal(a.controls.calls, 3);
});

test("source lente : le budget de temps (10 s par défaut) borne l'étape — une source qui répond lentement n'allonge pas le cycle de toutes les surveillances réservées", async () => {
  for (const [brand, model] of [["Apple", "iPhone 12"], ["Samsung", "Galaxy S21"], ["Apple", "MacBook Air M1"]]) await makeDemand(env.pool, { brand, model });
  a.controls.latencyMs = 250;
  b.controls.latencyMs = 250;
  const started = Date.now();
  const result = await step({ stepBudgetMs: 200, maxWatches: 3 });
  const elapsed = Date.now() - started;
  // La 1re surveillance (250 ms) est terminée même si elle dépasse le budget de 200 ms ; le budget est vérifié AVANT chaque surveillance : les deux autres sont rendues.
  assert.equal(result.watchesProcessed, 1);
  assert.equal(result.released, 2);
  assert.equal(result.sourceFailures, 0, "la surveillance commencée n'a pas été coupée");
  assert.ok(elapsed < 700, `3 × 250 ms évités : ${elapsed} ms`);
  assert.equal(await count(env.pool, "external_collect_runs", "status = 'ok'"), 2);
});

test("arrêt demandé (signal) : rien n'est commencé, tout est rendu", async () => {
  await makeDemand(env.pool);
  const controller = new AbortController();
  controller.abort();
  const result = await step({ signal: controller.signal });
  assert.equal(result.watchesProcessed, 0);
  assert.equal(result.released, 1);
  assert.equal(a.controls.calls, 0);
});

test("compteurs d'usage et journaux anciens purgés après une collecte", async () => {
  await makeDemand(env.pool);
  await step({ connectors: null });
  const watchId = (await watches())[0].id;
  await env.pool.query("INSERT INTO external_source_usage (source_code, day, requests) VALUES ('demo_a', '2026-08-01', 3)");
  await env.pool.query("INSERT INTO market_watch_usage (watch_id, source_code, day, requests) VALUES ($1, 'demo_a', '2026-08-01', 3)", [watchId]);
  // Les annonces externes, elles, ne sont jamais purgées (même très anciennes).
  const oldHash = "c".repeat(64);
  await env.pool.query("INSERT INTO external_analyses (content_hash, analysis, analyzer_version) VALUES ($1, '{\"version\":\"ext-analysis/v1\",\"tokens\":[],\"notTheProduct\":false}'::jsonb, 'ext-analysis/v1')", [oldHash]);
  await env.pool.query(
    `INSERT INTO external_listings (source_code, external_id, canonical_url, title, availability_status, content_hash, first_seen_at, last_seen_at, last_checked_at)
     VALUES ('demo_a', 'vieille', 'https://annonces-demo-a.example/annonce/vieille', 'iPhone 12', 'gone', $1, '2025-01-01', '2025-01-02', '2025-01-02')`,
    [oldHash],
  );
  await env.pool.query("INSERT INTO external_collect_runs (watch_id, source_code, started_at, finished_at, status) VALUES ($1, 'demo_a', '2026-08-01', '2026-08-01', 'ok')", [watchId]);
  await makeDue();
  await step();
  assert.equal(await count(env.pool, "external_source_usage", "day = '2026-08-01'"), 0);
  assert.equal(await count(env.pool, "market_watch_usage", "day = '2026-08-01'"), 0);
  assert.equal(await count(env.pool, "external_collect_runs", "started_at < '2026-09-01'"), 0);
  assert.equal(await count(env.pool, "external_listings", "external_id = 'vieille'"), 1, "les annonces externes ne sont pas purgées");
});


// ───────────── EXT1-bis : délai minimal, essai décisif, arrêt, bail, verrou de source, minuit ─────────────

const FOUR = [["Apple", "iPhone 12"], ["Samsung", "Galaxy S21"], ["Apple", "MacBook Air M1"], ["Apple", "iPad Air"]] as const;

/** Connecteur scripté (type « fake ») qui garde l'heure à laquelle chaque requête est partie. */
function recorder(code: string, answer: (key: ProductKey) => unknown = (key) => [listing(code, `${key.model.replace(/\W+/g, "-")}-1`)]): SourceConnector & { calls: Array<{ at: number; model: string }> } {
  const connector: SourceConnector & { calls: Array<{ at: number; model: string }> } = {
    code,
    kind: "fake",
    calls: [],
    async search(key, context) {
      connector.calls.push({ at: context.now.getTime(), model: key.model });
      return answer(key) as ExternalListingDraft[];
    },
  };
  return connector;
}
const listing = (code: string, id: string): ExternalListingDraft => ({
  externalId: id, title: `iPhone 12 ${id}`, price: 150_000, currency: "XOF", url: `https://annonces-${code.replace("_", "-")}.example/annonce/${id}`, location: "Cocody", listedAt: BASE, availability: "available",
});

test("délai minimal d'une source JAMAIS raccourci : une attente de plus de 5 s REFUSE la requête (motif « intervalle »), quota et budget non consommés, surveillance reprogrammée", async () => {
  for (const [brand, model] of FOUR.slice(0, 3)) await makeDemand(env.pool, { brand, model });
  await env.pool.query("UPDATE external_sources SET min_interval_ms = 60000 WHERE code = 'demo_a'");
  await env.pool.query("UPDATE external_sources SET enabled = FALSE WHERE code = 'demo_b'");
  const only = recorder("demo_a");
  const first = await step({ connectors: [only], maxWatches: 3 });
  assert.deepEqual(first.errors, []);
  assert.equal(only.calls.length, 1, "une seule requête : les deux autres devraient attendre 60 s");
  assert.equal(first.intervalSkipped, 2);
  assert.equal(first.waits, 0, "aucune attente écourtée à 5 s");
  assert.deepEqual(timer.waits, []);
  assert.equal(first.watchesProcessed, 3, "les trois surveillances sont closes (une collectée, deux reprogrammées)");
  // Compteurs : seule la requête partie est comptée (l'incrément des deux refusées est annulé).
  assert.equal((await env.pool.query("SELECT requests FROM external_source_usage WHERE source_code = 'demo_a'")).rows[0].requests, 1);
  assert.equal(await count(env.pool, "market_watch_usage"), 1);
  assert.equal(new Date((await source("demo_a")).last_request_at).getTime(), BASE.getTime(), "la dernière requête reste celle qui est partie");
  const byModel = Object.fromEntries((await watches()).map((row) => [row.model, new Date(row.next_run_at).getTime()]));
  const served = only.calls[0].model;
  for (const [model, nextRun] of Object.entries(byModel)) {
    assert.equal(nextRun, BASE.getTime() + (model === served ? 6 * 3_600_000 : WATCH_RETRY_SECONDS * 1_000), `${model} : ${model === served ? "6 h" : "10 minutes"}`);
  }
  // Jamais plus tôt que le délai : à +54 s il faudrait attendre 6 s (> 5 s) → refusée ; à +55 s l'attente de 5 s est imposée et la requête part à +60 s, pas avant.
  const refusedIds = (await watches()).filter((row) => row.model !== served).map((row) => row.id as string);
  clock.advance(54_000);
  const early = await step({ connectors: [only], only: refusedIds, maxWatches: 2 });
  assert.equal(only.calls.length, 1);
  assert.equal(early.intervalSkipped, 2);
  assert.equal(early.waits, 0);
  clock.advance(1_000);
  timer.waits.length = 0;
  const advancing: Sleep = async (ms) => {
    timer.waits.push(ms);
    clock.advance(ms);
  };
  const onTime = await step({ connectors: [only], only: refusedIds, maxWatches: 2, sleep: advancing });
  assert.deepEqual(timer.waits, [5_000], "attente de 5 s exactement (la borne est incluse)");
  assert.equal(only.calls.length, 2, "la première des deux part à +60 s, l'autre est refusée à son tour");
  assert.equal(onTime.intervalSkipped, 1);
  assert.equal(only.calls[1].at - only.calls[0].at, 60_000, `écart ${only.calls[1].at - only.calls[0].at} ms`);
  assert.equal((await env.pool.query("SELECT requests FROM external_source_usage WHERE source_code = 'demo_a'")).rows[0].requests, 2, "compteurs : 2 requêtes réellement parties");
});

test("délai minimal respecté dans la limite de 5 s : l'attente est imposée, l'écart entre deux requêtes de la même source n'est jamais inférieur au délai", async () => {
  for (const [brand, model] of FOUR.slice(0, 3)) await makeDemand(env.pool, { brand, model });
  await env.pool.query("UPDATE external_sources SET min_interval_ms = 4000 WHERE code = 'demo_a'");
  await env.pool.query("UPDATE external_sources SET enabled = FALSE WHERE code = 'demo_b'");
  const only = recorder("demo_a");
  // L'attente fait avancer l'horloge du temps demandé : l'heure vue par le connecteur est l'heure réelle d'envoi.
  const advancing: Sleep = async (ms) => void clock.advance(ms);
  const result = await step({ connectors: [only], sleep: advancing, maxWatches: 3 });
  assert.equal(result.sourceCalls, 3);
  assert.equal(result.waits, 2);
  assert.equal(result.intervalSkipped, 0);
  const gaps = only.calls.slice(1).map((call, index) => call.at - only.calls[index].at);
  assert.deepEqual(gaps, [4_000, 4_000], "jamais moins que min_interval_ms");
  assert.ok(MAX_SOURCE_WAIT_MS === 5_000);
});

test("disjoncteur semi-ouvert : UN SEUL essai décisif, même avec plusieurs exécuteurs et plusieurs surveillances en parallèle (jeton pris sous le verrou de la source)", { timeout: 90_000 }, async () => {
  for (const [brand, model] of FOUR) await makeDemand(env.pool, { brand, model });
  await env.pool.query("UPDATE external_sources SET enabled = (code = 'demo_a')");
  await env.pool.query("UPDATE market_watches SET daily_request_budget = 50");
  await step({ connectors: null });
  const ids = (await watches()).map((row) => row.id as string);
  assert.equal(ids.length, 4);
  const pools = [env.pool, env.extraPool(4), env.extraPool(4), env.extraPool(4)];
  const halfOpen = () => env.pool.query("UPDATE external_sources SET consecutive_failures = $2, breaker_open_until = $1, breaker_trial_until = NULL, quota_placeholder = NULL WHERE code = 'demo_a'".replace(", quota_placeholder = NULL", ""), [new Date(clock.now().getTime() - 1_000), BREAKER_FAILURE_THRESHOLD]);

  // 1. Essai décisif EN ÉCHEC : un seul appel part vers la source encore en panne, les trois autres exécuteurs voient le disjoncteur.
  await halfOpen();
  const failing = recorder("demo_a", () => { throw Object.assign(new Error("panne"), { code: "ECONNRESET" }); });
  const gate = barrier();
  const safety = setTimeout(() => gate.open(), 4_000); // jamais d'attente infinie si le jeton n'existait pas
  let arrived = 0;
  let finished = 0;
  const hooks = { beforeSource: async () => { arrived += 1; await gate.wait; } };
  const runs = ids.map((id, index) => step({ pool: pools[index], connectors: [failing], only: [id], hooks }).then((result) => { finished += 1; if (finished === 3) gate.open(); return result; }));
  const results = await Promise.all(runs);
  clearTimeout(safety);
  assert.equal(failing.calls.length, 1, "UN seul essai décisif");
  assert.equal(arrived, 1);
  assert.equal(results.reduce((total, result) => total + result.breakerSkipped, 0), 3, "les trois autres sont refusées par le disjoncteur");
  assert.equal(results.reduce((total, result) => total + result.sourceFailures, 0), 1);
  assert.deepEqual(results.flatMap((result) => result.errors), []);
  let row = await source("demo_a");
  assert.equal(row.consecutive_failures, BREAKER_FAILURE_THRESHOLD + 1);
  assert.equal(new Date(row.breaker_open_until).getTime(), clock.now().getTime() + BREAKER_PAUSE_MS, "rouvert aussitôt pour 30 minutes");
  assert.equal(row.breaker_trial_until, null, "le jeton est rendu");

  // 2. Essai décisif RÉUSSI : un seul appel, le disjoncteur se referme.
  await halfOpen();
  const healthy = recorder("demo_a");
  const gate2 = barrier();
  const safety2 = setTimeout(() => gate2.open(), 4_000);
  let finished2 = 0;
  const hooks2 = { beforeSource: async () => { await gate2.wait; } };
  const results2 = await Promise.all(ids.map((id, index) => step({ pool: pools[index], connectors: [healthy], only: [id], hooks: hooks2 }).then((result) => { finished2 += 1; if (finished2 === 3) gate2.open(); return result; })));
  clearTimeout(safety2);
  assert.equal(healthy.calls.length, 1, "un seul essai décisif réussi");
  assert.equal(results2.reduce((total, result) => total + result.breakerSkipped, 0), 3);
  row = await source("demo_a");
  assert.equal(row.consecutive_failures, 0);
  assert.equal(row.breaker_open_until, null);
  assert.equal(row.breaker_trial_until, null);

  // 3. Le jeton d'un processus MORT expire : tant qu'il est valide aucun autre essai ne part, après il en part un.
  await halfOpen();
  await env.pool.query("UPDATE external_sources SET breaker_trial_until = $1 WHERE code = 'demo_a'", [new Date(clock.now().getTime() + BREAKER_TRIAL_LEASE_MS)]);
  const dead = recorder("demo_a");
  const blocked = await step({ connectors: [dead], only: [ids[0]] });
  assert.equal(dead.calls.length, 0);
  assert.equal(blocked.breakerSkipped, 1);
  clock.advance(BREAKER_TRIAL_LEASE_MS + 1_000);
  const later = await step({ connectors: [dead], only: [ids[0]] });
  assert.equal(dead.calls.length, 1, "le jeton a expiré : un nouvel essai décisif");
  assert.equal(later.breakerSkipped, 0);
  assert.equal((await source("demo_a")).consecutive_failures, 0);
});

test("arrêt demandé PENDANT l'attente du délai minimal : la requête ne part pas, la réservation est rendue (compteurs, dernière requête, jeton d'essai), la surveillance redevient due", async () => {
  await makeDemand(env.pool);
  await makeDemand(env.pool, { model: "Galaxy S21", brand: "Samsung" });
  await env.pool.query("UPDATE external_sources SET min_interval_ms = 4000 WHERE code = 'demo_a'");
  await env.pool.query("UPDATE external_sources SET enabled = FALSE WHERE code = 'demo_b'");
  const only = recorder("demo_a");
  const controller = new AbortController();
  // L'arrêt arrive pendant l'attente de la 2e requête : l'attente est écourtée (comme le fait defaultSleep).
  const sleepAndAbort: Sleep = async (ms) => {
    timer.waits.push(ms);
    controller.abort();
  };
  const result = await step({ connectors: [only], sleep: sleepAndAbort, signal: controller.signal, maxWatches: 2 });
  assert.deepEqual(result.errors, []);
  assert.equal(only.calls.length, 1, "la 2e requête ne part pas");
  assert.equal(result.abortedRequests, 1);
  assert.equal(result.waits, 1);
  assert.equal(result.watchesProcessed, 1);
  assert.equal(result.released, 1);
  assert.equal((await env.pool.query("SELECT requests FROM external_source_usage WHERE source_code = 'demo_a'")).rows[0].requests, 1, "compteur de la source rendu");
  assert.equal((await env.pool.query("SELECT coalesce(sum(requests), 0)::int AS n FROM market_watch_usage")).rows[0].n, 1, "budget de la 2e surveillance rendu");
  assert.equal(new Date((await source("demo_a")).last_request_at).getTime(), BASE.getTime(), "la dernière requête de la source est rétablie");
  const unfinished = (await watches()).filter((row) => row.last_run_at === null);
  assert.equal(unfinished.length, 1);
  assert.ok(new Date(unfinished[0].next_run_at).getTime() <= clock.now().getTime(), "la surveillance interrompue est due tout de suite");
  assert.equal(unfinished[0].claim_token, null);
  // Rien d'autre n'a été journalisé : une seule requête partie.
  assert.equal(await count(env.pool, "external_collect_runs"), 1);

  // Essai décisif du disjoncteur semi-ouvert interrompu : le jeton est rendu avec la réservation.
  await env.pool.query("UPDATE external_sources SET consecutive_failures = 3, breaker_open_until = $1, breaker_trial_until = NULL, last_request_at = $2 WHERE code = 'demo_a'", [new Date(clock.now().getTime() - 1_000), new Date(clock.now().getTime() - 1_000)]);
  const second = new AbortController();
  const again = await step({ connectors: [only], sleep: async () => void second.abort(), signal: second.signal, only: [unfinished[0].id] });
  assert.equal(again.abortedRequests, 1);
  assert.equal(only.calls.length, 1);
  const row = await source("demo_a");
  assert.equal(row.breaker_trial_until, null, "jeton rendu");
  assert.equal(row.consecutive_failures, 3);
});

test("exécuteur retardataire : A figé au-delà du bail, B reprend la surveillance, A se réveille → UNE seule collecte comptée, l'échéance de B est conservée", { timeout: 90_000 }, async () => {
  await makeDemand(env.pool);
  await step({ connectors: null });
  await makeDue();
  const other = env.extraPool(6);
  const frozen = barrier();
  const claimedByA = barrier();
  const runA = step({ hooks: { afterClaim: async () => { claimedByA.open(); await frozen.wait; } } });
  await claimedByA.wait;
  const tokenA = (await watches())[0].claim_token as string;
  assert.ok(tokenA);
  clock.advance((WATCH_CLAIM_LEASE_SECONDS + 1) * 1_000); // A reste figé plus de 10 minutes
  const runB = await step({}, other);
  const afterB = (await watches())[0];
  assert.equal(runB.claimed, 1);
  assert.equal(runB.watchesProcessed, 1);
  assert.equal(runB.sourceCalls, 2);
  assert.equal(afterB.claim_token, null, "B a clos la surveillance");
  assert.notEqual(afterB.claim_token, tokenA);
  const nextOfB = new Date(afterB.next_run_at).getTime();
  assert.equal(nextOfB, clock.now().getTime() + 6 * 3_600_000);
  clock.advance(3 * 3_600_000); // A se réveille 3 h plus tard
  frozen.open();
  const resA = await runA;
  assert.deepEqual(resA.errors, []);
  assert.equal(resA.claimed, 1);
  assert.equal(resA.leaseLost, 1, "le bail a été repris par B");
  assert.equal(resA.watchesProcessed, 0);
  assert.equal(resA.sourceCalls, 0, "A n'interroge aucune source");
  assert.equal(resA.released, 0, "A ne « rend » pas une surveillance qui n'est plus la sienne");
  assert.equal(a.controls.calls, 1, "une seule collecte pour la surveillance");
  assert.equal(b.controls.calls, 1);
  assert.equal(await count(env.pool, "external_collect_runs"), 2, "deux sources, une seule collecte journalisée");
  assert.equal((await env.pool.query("SELECT coalesce(sum(requests), 0)::int AS n FROM market_watch_usage")).rows[0].n, 2, "budget : une collecte, pas deux");
  const afterA = (await watches())[0];
  assert.equal(new Date(afterA.next_run_at).getTime(), nextOfB, "l'échéance de B est conservée");
  assert.equal(new Date(afterA.last_run_at).getTime(), new Date(afterB.last_run_at).getTime());

  // A figé EN PLEIN traitement (après avoir revérifié son bail) : B reprend ; A, à son réveil, ne clôt rien (clôture conditionnée au jeton).
  await env.pool.query("UPDATE market_watches SET next_run_at = $1", [new Date(clock.now().getTime() - 1_000)]);
  const midway = barrier();
  const atSource = barrier();
  const runC = step({ hooks: { beforeSource: async () => { atSource.open(); await midway.wait; } } });
  await atSource.wait;
  clock.advance((WATCH_CLAIM_LEASE_SECONDS + 1) * 1_000);
  const runD = await step({ hooks: { beforeSource: async () => undefined } }, other);
  assert.equal(runD.watchesProcessed, 1);
  const nextOfD = new Date((await watches())[0].next_run_at).getTime();
  clock.advance(60_000);
  midway.open();
  const resC = await runC;
  assert.equal(resC.watchesProcessed, 0, "A n'a clos aucune surveillance");
  assert.equal(resC.leaseLost, 1);
  assert.equal(new Date((await watches())[0].next_run_at).getTime(), nextOfD, "l'échéance de D est conservée");
});

test("verrou de la ligne d'une source tenu par un autre processus : la source est « occupée » après 2 s, SANS erreur d'infrastructure ; l'étape et le cycle du runner ne restent pas bloqués", { timeout: 90_000 }, async () => {
  await makeDemand(env.pool);
  const holder = await env.pool.connect();
  try {
    await holder.query("BEGIN");
    await holder.query("SELECT 1 FROM external_sources WHERE code = 'demo_a' FOR UPDATE");
    const started = Date.now();
    const raced = await Promise.race([step(), new Promise<"bloqué">((resolve) => setTimeout(() => resolve("bloqué"), 8_000))]);
    assert.notEqual(raced, "bloqué", "l'étape reste bloquée tant que le verrou est tenu");
    const result = raced as Awaited<ReturnType<typeof step>>;
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 1_800 && elapsed < 5_000, `attente bornée à 2 s : ${elapsed} ms`);
    assert.deepEqual(result.errors, [], "pas d'erreur d'infrastructure (55p03)");
    assert.equal(result.busySkipped, 1);
    assert.equal(a.controls.calls, 0, "la source occupée n'est pas interrogée");
    assert.equal(b.controls.calls, 1, "l'autre source l'est");
    assert.equal(result.watchesProcessed, 1);
    assert.equal((await env.pool.query("SELECT coalesce(sum(requests), 0)::int AS n FROM external_source_usage WHERE source_code = 'demo_a'")).rows[0].n, 0, "quota non consommé");
    assert.equal(new Date((await watches())[0].next_run_at).getTime(), clock.now().getTime() + WATCH_RETRY_SECONDS * 1_000, "reprise dans 10 minutes");
    // Le même verrou, vu depuis le cycle du runner (l'audit : le cycle entier restait bloqué tant que le verrou était tenu).
    await makeDue();
    const cycle = await Promise.race([
      runMatchingCycle({ pool: env.pool, workerId: "ext-lock", notificationTransport: null, collect: { connectors: fakes, now: clock.now, sleep: timer.sleep } }),
      new Promise<"bloqué">((resolve) => setTimeout(() => resolve("bloqué"), 6_000)),
    ]);
    assert.notEqual(cycle, "bloqué", "le cycle du runner ne reste pas bloqué");
    if (cycle !== "bloqué") {
      assert.deepEqual(cycle.errors, []);
      assert.equal(cycle.collect.busySkipped, 1);
    }
  } finally {
    await holder.query("ROLLBACK").catch(() => undefined);
    holder.release();
  }
  clock.advance((WATCH_RETRY_SECONDS + 1) * 1_000);
  const released = await step();
  assert.equal(released.busySkipped, 0);
  assert.equal(a.controls.calls, 1, "la source libérée est interrogée à la reprise");
});

test("quota du jour épuisé : la surveillance est reprogrammée au prochain minuit UTC (pas toutes les 10 minutes) ; une source en pause ou occupée garde la reprise à 10 minutes", async () => {
  await makeDemand(env.pool);
  await makeDemand(env.pool, { model: "Galaxy S21", brand: "Samsung" });
  await env.pool.query("UPDATE external_sources SET daily_quota = 1");
  const result = await step({ maxWatches: 2 });
  assert.equal(result.watchesProcessed, 2);
  assert.equal(result.quotaSkipped, 2, "la 2e surveillance n'a plus de quota ni chez A ni chez B");
  const rows = await watches();
  const times = rows.map((row) => new Date(row.next_run_at).toISOString()).sort();
  assert.deepEqual(times, ["2026-10-08T00:00:00.000Z", new Date(BASE.getTime() + 6 * 3_600_000).toISOString()].sort());
  // Le cycle de 10 minutes plus tard ne la réserve pas ; le lendemain, elle part.
  clock.advance(WATCH_RETRY_SECONDS * 1_000 + 1_000);
  const idle = await step({ maxWatches: 2 });
  assert.equal(idle.claimed, 0);
  clock.set(new Date("2026-10-08T00:00:01.000Z"));
  const nextDay = await step({ maxWatches: 2 });
  assert.equal(nextDay.claimed, 2, "les deux sont dues (celle de minuit ; l'autre depuis 16 h)");
  assert.equal(nextDay.sourceCalls, 2, "quota de 1 par source : une seule des deux surveillances est servie");
  assert.equal(nextDay.quotaSkipped, 2);
  // Quota épuisé chez A et disjoncteur ouvert chez B : rien ne justifie d'attendre minuit, retour dans 10 minutes.
  await env.pool.query("UPDATE external_sources SET daily_quota = 200, consecutive_failures = 0, breaker_open_until = NULL");
  await env.pool.query("UPDATE external_source_usage SET requests = 200 WHERE source_code = 'demo_a'");
  await env.pool.query("UPDATE external_sources SET breaker_open_until = $1, consecutive_failures = 3 WHERE code = 'demo_b'", [new Date(clock.now().getTime() + BREAKER_PAUSE_MS)]);
  await makeDue();
  const mixed = await step({ maxWatches: 2 });
  assert.ok(mixed.quotaSkipped >= 1 && mixed.breakerSkipped >= 1);
  assert.equal(mixed.sourceCalls, 0);
  for (const row of await watches()) assert.equal(new Date(row.next_run_at).getTime(), clock.now().getTime() + WATCH_RETRY_SECONDS * 1_000);
});

test("regroupement en conflit (40P01) : repris à la collecte suivante, jamais une erreur d'infrastructure ni une annonce perdue", { timeout: 90_000 }, async () => {
  await makeDemand(env.pool);
  const spy = Object.create(env.pool) as Pool;
  let injected = 0;
  spy.query = ((...args: unknown[]) => (env.pool.query as (...a: unknown[]) => unknown)(...args)) as never;
  spy.connect = (async () => {
    const client = await env.pool.connect();
    const original = client.query.bind(client) as (...args: unknown[]) => unknown;
    const release = client.release.bind(client);
    // La connexion retourne au pool : on lui rend son vrai comportement.
    (client as unknown as { release: (error?: unknown) => void }).release = (error?: unknown) => {
      delete (client as unknown as { query?: unknown }).query;
      delete (client as unknown as { release?: unknown }).release;
      release(error as never);
    };
    (client as unknown as { query: (...args: unknown[]) => unknown }).query = (...args: unknown[]) => {
      if (typeof args[0] === "string" && args[0].includes("duplicate_group_id = ANY($2::uuid[]) ORDER BY id FOR UPDATE")) {
        injected += 1;
        return Promise.reject(Object.assign(new Error("interblocage simulé"), { code: "40P01" }));
      }
      return original(...args);
    };
    return client;
  }) as never;
  const result = await step({}, spy);
  assert.deepEqual(result.errors, []);
  assert.equal(injected, 1);
  assert.equal(result.groupingConflicts, 1);
  assert.equal(result.grouped, 0);
  assert.equal(result.watchesProcessed, 1, "la surveillance est close normalement");
  assert.ok(result.created > 0, "les annonces sont stockées");
  assert.equal(await count(env.pool, "duplicate_groups"), 0);
  // Collecte suivante, sans conflit : le regroupement est fait (le doublon des deux sources).
  await makeDue();
  clock.advance(1_000);
  const next = await step();
  assert.equal(next.groupingConflicts, 0);
  assert.ok(next.grouped >= 2);
  assert.equal(await count(env.pool, "duplicate_groups"), 1);
});

test("aucun appel réseau sortant pendant toute la suite (garde fetch, http, https, dns, TCP hors boucle locale)", () => {
  assert.deepEqual(guard.attempts, []);
});
