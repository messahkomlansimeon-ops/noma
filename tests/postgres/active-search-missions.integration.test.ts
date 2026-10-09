import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, test } from "node:test";
import type { Pool } from "pg";
import { ACTIVE_SEARCH_PRICE_XOF } from "../../lib/server/active-search/config";
import { createActiveSearchHttpHandlers, type ActiveSearchHttpHandlers } from "../../lib/server/active-search/http";
import { purchaseActiveSearch } from "../../lib/server/active-search/purchase";
import { readActiveSearchState } from "../../lib/server/active-search/state";
import { CatalogNotFoundError } from "../../lib/server/catalog/errors";
import { runCollectStep } from "../../lib/server/external/collect";
import type { ExternalListingDraft } from "../../lib/server/external/types";
import { readActiveSearchKeys, syncMarketWatches } from "../../lib/server/external/watches";
import { runMatchingCycle } from "../../lib/server/matching/runner";
import { runMissionsStep } from "../../lib/server/missions/step";
import { listNotifications } from "../../lib/server/notifications/inbox";
import {
  FAKE_ENV, TEST_PSEUDONYM_KEY, createFakeConnectors, fixedClock, installNetworkGuard, makeDemand, recordingSleep, resetExternal, selfTestNetworkGuard,
  type FakeConnector, type NetworkGuard,
} from "./external-fixtures";
import { actMissionCall, addCandidate, ageClosedMission, carrierStatus, makeHandlers, startMission, withoutMissionGuard, type Handlers } from "./missions-fixtures";
import { balanceOf, fund } from "./pro-fixtures";
import { NOT_FOUND, ORIGIN, count, login, openTestSchema, reply, request, resetSocial, type TestSchema } from "./social-fixtures";

/**
 * Intégration de la recherche active payante (lot RA1) et des missions d'achat en volume (lot MV1) : le besoin PORTEUR d'une mission n'est pas un besoin de l'acheteur (il est masqué de
 * « Mes besoins »), donc l'option ne s'y vend ni ne s'y lit — MÊME réponse « introuvable » que pour un besoin d'autrui, quel que soit l'état de la mission — et il n'accélère jamais la
 * collecte. Les deux étapes du runner travaillent dans un même cycle et chacune écrit sa notification. Sources FICTIVES, argent SIMULÉ.
 */

// Jour UTC fixe (les compteurs de quota sont par jour UTC) : 00 h 30 du jour courant, ou de la veille si on est avant.
const todayStart = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate());
const BASE = new Date(Date.now() >= todayStart + 30 * 60_000 ? todayStart + 30 * 60_000 : todayStart - 24 * 3_600_000 + 30 * 60_000);
const HOUR = 3_600_000;

let env: TestSchema;
let pool: Pool;
let h: Handlers;
let search: ActiveSearchHttpHandlers;
let guard: NetworkGuard;
let fakes: FakeConnector[];
let a: FakeConnector;
const clock = fixedClock(BASE);
const timer = recordingSleep();

before(async () => {
  env = await openTestSchema(10);
  pool = env.pool;
  h = makeHandlers(pool);
  search = createActiveSearchHttpHandlers({ pool, env: { NOMA_AUTH_ORIGIN: ORIGIN, ...FAKE_ENV }, log: () => {} });
  guard = installNetworkGuard();
  await selfTestNetworkGuard(guard);
});

after(async () => {
  guard?.restore();
  await env?.close();
});

beforeEach(async () => {
  await resetSocial(pool);
  await resetExternal(pool);
  fakes = createFakeConnectors();
  [a] = fakes;
  clock.set(BASE);
  timer.waits.length = 0;
});

afterEach(() => {
  a.controls.extra = [];
});

const buyFor = (userId: string, demandId: string, at: Date = clock.now()) =>
  purchaseActiveSearch({ expectedPriceXof: ACTIVE_SEARCH_PRICE_XOF, env: FAKE_ENV, pool, userId, demandId, idempotencyKey: randomUUID(), now: at });

async function failureOf(operation: Promise<unknown>): Promise<unknown> {
  try {
    await operation;
  } catch (error) {
    return error;
  }
  return null;
}

/** Tout ce qu'un refus ne doit pas toucher. */
async function ledger(): Promise<Record<string, string>> {
  return (await pool.query<Record<string, string>>(
    `SELECT (SELECT count(*) FROM wallet_transactions)::text AS transactions, (SELECT count(*) FROM wallet_entries)::text AS entries,
            (SELECT COALESCE(sum(abs(balance)), 0) FROM wallet_accounts)::text AS balances, (SELECT count(*) FROM active_search_purchases)::text AS purchases,
            (SELECT count(*) FROM active_search_state)::text AS states, (SELECT count(*) FROM active_search_seen)::text AS seen,
            (SELECT COALESCE(sum(extract(epoch FROM notify_until)), 0) FROM demands)::text AS tracking`)).rows[0];
}

// ═════════════ 1. Le besoin porteur d'une mission est « introuvable » (service et HTTP) ═════════════

test("service : l'état et l'achat sur le besoin PORTEUR d'une mission lèvent la même erreur « introuvable » qu'un besoin d'autrui ; rien n'est écrit ni débité ; vrai quel que soit l'état de la mission", async () => {
  const buyer = await login(pool);
  await fund(pool, buyer.userId, 10_000);
  const live = await startMission(pool, h, buyer);
  const foreign = await makeDemand(pool, { ownerId: (await login(pool)).userId });
  const snapshot = await ledger();

  const assertHidden = async (label: string): Promise<void> => {
    const carrierState = await failureOf(readActiveSearchState({ executor: pool, ownerId: buyer.userId, demandId: live.demandId, env: FAKE_ENV }));
    const foreignState = await failureOf(readActiveSearchState({ executor: pool, ownerId: buyer.userId, demandId: foreign.id, env: FAKE_ENV }));
    assert.ok(carrierState instanceof CatalogNotFoundError, `${label} : état → introuvable`);
    assert.ok(foreignState instanceof CatalogNotFoundError);
    assert.deepEqual([carrierState.name, carrierState.message], [(foreignState as Error).name, (foreignState as Error).message], `${label} : même erreur que pour un besoin d'autrui`);
    const carrierBuy = await failureOf(buyFor(buyer.userId, live.demandId));
    const foreignBuy = await failureOf(buyFor(buyer.userId, foreign.id));
    assert.ok(carrierBuy instanceof CatalogNotFoundError, `${label} : achat → introuvable`);
    assert.ok(foreignBuy instanceof CatalogNotFoundError);
    assert.deepEqual([carrierBuy.name, carrierBuy.message], [(foreignBuy as Error).name, (foreignBuy as Error).message]);
    assert.deepEqual(await ledger(), snapshot, `${label} : rien n'est écrit ni débité`);
    assert.equal(await balanceOf(pool, buyer.userId), BigInt(10_000));
  };

  await assertHidden("mission active");
  await actMissionCall(h, buyer.cookie, live.id, "pause");
  await assertHidden("mission en pause");
  await actMissionCall(h, buyer.cookie, live.id, "resume");
  await actMissionCall(h, buyer.cookie, live.id, "cancel");
  assert.equal(await carrierStatus(pool, live.demandId), "active", "le besoin porteur d'une mission annulée est libéré 24 h plus tard seulement");
  await assertHidden("mission annulée, besoin porteur encore actif");
  // Libéré (archivé) par l'étape du runner : ce n'est PAS « besoin non actif » (409), c'est toujours « introuvable » : le motif du porteur passe avant les autres.
  await ageClosedMission(pool, live.id, 25);
  const released = await runMissionsStep({ pool });
  assert.equal(released.released, 1);
  assert.equal(await carrierStatus(pool, live.demandId), "archived");
  await assertHidden("besoin porteur archivé");

  // Contrôle : un besoin ORDINAIRE du même acheteur reste éligible (et un besoin ordinaire archivé donne bien son motif propre, pas « introuvable »).
  const own = await makeDemand(pool, { ownerId: buyer.userId });
  const state = await readActiveSearchState({ executor: pool, ownerId: buyer.userId, demandId: own.id, env: FAKE_ENV });
  assert.deepEqual([state.canPurchase, state.blockedReason], [true, null]);
  assert.equal((await buyFor(buyer.userId, own.id)).kind, "activation");
});

test("HTTP : GET et POST sur le besoin porteur d'une mission → le MÊME 404 (statut, corps à l'octet près) qu'un besoin inconnu ou d'autrui, rien n'est écrit", async () => {
  const buyer = await login(pool);
  const stranger = await login(pool);
  await fund(pool, buyer.userId, 10_000);
  const live = await startMission(pool, h, buyer);
  const foreign = await makeDemand(pool, { ownerId: stranger.userId });
  const state = (cookie: string, id: string) => search.get(request("GET", `/api/demands/${id}/active-search`, { cookie }), id).then(reply);
  const buy = (cookie: string, id: string) =>
    search.purchase(request("POST", `/api/demands/${id}/active-search`, { cookie, body: { idempotencyKey: randomUUID(), expectedPriceXof: ACTIVE_SEARCH_PRICE_XOF } }), id).then(reply);
  const snapshot = await ledger();
  const unknownId = randomUUID();

  for (const [label, run] of [["GET", state], ["POST", buy]] as const) {
    const carrier = await run(buyer.cookie, live.demandId);
    const unknown = await run(buyer.cookie, unknownId);
    const other = await run(buyer.cookie, foreign.id);
    assert.deepEqual([carrier.status, carrier.json], [404, NOT_FOUND], `${label} sur le besoin porteur (par son propriétaire)`);
    assert.equal(carrier.text, unknown.text, `${label} : corps identique à celui d'un besoin inconnu`);
    assert.equal(carrier.text, other.text, `${label} : corps identique à celui d'un besoin d'autrui`);
    assert.equal(carrier.text.includes("mission"), false, "aucune mention de la mission");
    // Un autre acheteur reçoit lui aussi le même 404.
    assert.equal((await run(stranger.cookie, live.demandId)).text, carrier.text);
  }
  assert.deepEqual(await ledger(), snapshot, "aucun débit, aucune période, aucun état");
  assert.equal(await count(pool, "active_search_purchases", `demand_id = '${live.demandId}'`), 0);
});

// ═════════════ 2. Un besoin porteur n'accélère jamais la collecte ═════════════

test("collecte : une option en vigueur sur un besoin devenu PORTEUR n'accélère aucune surveillance (clés, synchronisation) ; redevenu ordinaire, il accélère de nouveau", async () => {
  const owner = await login(pool);
  await fund(pool, owner.userId, 10_000);
  const demand = await makeDemand(pool, { ownerId: owner.userId });
  await buyFor(owner.userId, demand.id);
  const keys = await readActiveSearchKeys(pool, clock.now());
  assert.equal(keys.length, 1, "contrôle : le besoin ordinaire avec option fait accélérer sa clé");
  assert.equal((await syncMarketWatches(pool, clock.now())).accelerated, 1);

  // Une mission lancée par un autre acheteur est rattachée à CE besoin (état synthétique : le service refuse d'en vendre, mais une ligne d'achat peut exister sur un porteur).
  const other = await login(pool);
  const live = await startMission(pool, h, other);
  await withoutMissionGuard(pool, () => pool.query("UPDATE missions SET demand_id = $2 WHERE id = $1", [live.id, demand.id]));
  try {
    assert.deepEqual(await readActiveSearchKeys(pool, clock.now()), [], "un besoin porteur n'accélère jamais");
    const sync = await syncMarketWatches(pool, clock.now());
    assert.equal(sync.decelerated, 1, "la surveillance revient à sa fréquence ordinaire");
    assert.deepEqual((await pool.query<{ accelerated: boolean; frequency_seconds: number }>("SELECT accelerated, frequency_seconds FROM market_watches WHERE product_key = $1", [keys[0]])).rows, [{ accelerated: false, frequency_seconds: 21_600 }]);
    // Même un porteur EN PAUSE (qui ne fait déjà plus surveiller de marché) n'accélère rien.
    await withoutMissionGuard(pool, () => pool.query("UPDATE missions SET status = 'paused' WHERE id = $1", [live.id]));
    assert.deepEqual(await readActiveSearchKeys(pool, clock.now()), []);
  } finally {
    await withoutMissionGuard(pool, () => pool.query("UPDATE missions SET status = 'active', demand_id = $2 WHERE id = $1", [live.id, live.demandId]));
  }
  assert.deepEqual(await readActiveSearchKeys(pool, clock.now()), keys, "le besoin n'étant plus porteur, l'option accélère de nouveau");
  assert.equal((await syncMarketWatches(pool, clock.now())).accelerated, 1);
});

test("collecte : sans la table des missions (panne), la lecture des clés accélérées et la synchronisation des surveillances continuent sans erreur", async () => {
  const second = await openTestSchema(4);
  try {
    const bare = second.pool;
    const owner = await login(bare);
    await fund(bare, owner.userId, 10_000);
    const demand = await makeDemand(bare, { ownerId: owner.userId });
    await purchaseActiveSearch({ expectedPriceXof: ACTIVE_SEARCH_PRICE_XOF, env: FAKE_ENV, pool: bare, userId: owner.userId, demandId: demand.id, idempotencyKey: randomUUID(), now: clock.now() });
    await bare.query("DROP TABLE missions CASCADE");
    assert.equal((await readActiveSearchKeys(bare, clock.now())).length, 1);
    assert.equal((await syncMarketWatches(bare, clock.now())).accelerated, 1);
  } finally {
    await second.close();
  }
});

// ═════════════ 3. Un même cycle du runner ═════════════

const listing = (n: number): ExternalListingDraft => ({
  externalId: `demo_a-nouveau-${n}`, title: `iPhone 12 128 Go violet n°${n}`, price: 140_000 + n, currency: "XOF", url: `https://annonces-demo-a.example/annonce/demo_a-nouveau-${n}`,
  location: "Cocody", listedAt: new Date(clock.now().getTime() - HOUR), availability: "available",
});

const watchIds = async (): Promise<string[]> => (await pool.query<{ id: string }>("SELECT id FROM market_watches WHERE status = 'active' ORDER BY product_key")).rows.map((row) => row.id);

test("un même cycle : l'étape « missions » (couverture) ET l'étape « activeSearch » (annonce d'un autre site) travaillent et écrivent chacune leur notification, sans erreur, le cycle n'est pas au repos ; les deux genres se lisent dans la boîte", async () => {
  const optionOwner = await login(pool);
  await fund(pool, optionOwner.userId, 10_000);
  const demand = await makeDemand(pool, { ownerId: optionOwner.userId });
  clock.advance(60_000);
  await runCollectStep({ pool, connectors: fakes, now: clock.now, sleep: timer.sleep, pseudonymKey: TEST_PSEUDONYM_KEY, maxWatches: 10 });
  await buyFor(optionOwner.userId, demand.id);

  const missionBuyer = await login(pool);
  const live = await startMission(pool, h, missionBuyer, { quantity: 6 });
  // Le matching du besoin porteur se termine : la base de la couverture est posée sans bruit.
  for (let index = 0; index < 30; index += 1) {
    if ((await runMatchingCycle({ pool, workerId: "ra-mv", notificationTransport: null, collect: { connectors: [] }, activeSearch: { now: clock.now } })).idle) break;
  }
  assert.deepEqual((await pool.query("SELECT covered_quantity, notified_quantity FROM missions WHERE id = $1", [live.id])).rows[0], { covered_quantity: 0, notified_quantity: 0 });

  // Une annonce correspond à la mission (2 pièces) ET une annonce d'un autre site correspond au besoin qui a l'option.
  await addCandidate(pool, live, { quantity: 2 });
  a.controls.extra = [listing(1)];
  clock.advance(HOUR);
  // Deux surveillances : celle du besoin qui a l'option et celle du besoin porteur de la mission (un besoin porteur actif fait surveiller le marché, comme un besoin ordinaire).
  const ids = await watchIds();
  assert.equal(ids.length, 2);
  const cycle = await runMatchingCycle({
    pool, workerId: "ra-mv", maxJobs: 1, notificationTransport: null,
    collect: { connectors: fakes, now: clock.now, sleep: timer.sleep, pseudonymKey: TEST_PSEUDONYM_KEY, only: ids },
    activeSearch: { now: clock.now },
  });
  assert.deepEqual(cycle.errors, []);
  assert.equal(cycle.missions.skipped, false);
  assert.equal(cycle.missions.notified, 1, "couverture de la mission notifiée dans ce cycle");
  assert.equal(cycle.collect.watchesProcessed, 2);
  assert.equal(cycle.activeSearch.skipped, false);
  assert.equal(cycle.activeSearch.notified, 1, "annonce d'un autre site notifiée dans ce cycle");
  assert.equal(cycle.idle, false);

  const coverage = (await listNotifications({ pool, userId: missionBuyer.userId })).items;
  assert.deepEqual(coverage.map((item) => [item.kind, item.count, item.link]), [["mission_coverage", 2, `/missions/${live.id}`]]);
  const external = (await listNotifications({ pool, userId: optionOwner.userId })).items;
  assert.deepEqual(external.map((item) => [item.kind, item.link, item.sourceName]), [["new_external_match", `/besoins/${demand.id}`, "Annonces Démo A"]]);
  assert.equal(JSON.stringify([coverage, external]).includes("annonces-demo-a.example"), false, "jamais l'adresse d'une annonce externe");
  assert.equal(await count(pool, "notifications", "kind = 'new_external_match' AND mission_id IS NOT NULL"), 0);
  assert.equal(await count(pool, "notifications", "kind = 'mission_coverage' AND (external_listing_id IS NOT NULL OR source_name IS NOT NULL OR active_search_id IS NOT NULL)"), 0);

  // Rien de plus au cycle suivant : chaque notification n'est écrite qu'une fois.
  const quiet = await runMatchingCycle({ pool, workerId: "ra-mv", maxJobs: 1, notificationTransport: null, collect: { connectors: [] }, activeSearch: { now: clock.now } });
  assert.deepEqual([quiet.missions.notified, quiet.activeSearch.notified, quiet.errors], [0, 0, []]);
  assert.equal(await count(pool, "notifications", "kind IN ('mission_coverage', 'new_external_match')"), 2);
});

test("au repos : une étape « activeSearch » qui travaille SEULE (avis d'échéance) empêche le cycle d'être au repos ; sans travail, le cycle est au repos", async () => {
  const owner = await login(pool);
  await fund(pool, owner.userId, 10_000);
  const demand = await makeDemand(pool, { ownerId: owner.userId });
  await buyFor(owner.userId, demand.id, BASE);
  const cycleAt = (now: Date) => runMatchingCycle({ pool, workerId: "ra-idle", maxJobs: 5, notificationTransport: null, collect: { connectors: [] }, activeSearch: { now: () => now } });
  // Le matching du besoin se termine ; plus rien à faire (aucune mission, aucune collecte) : le cycle est au repos.
  let settled = await cycleAt(new Date(BASE.getTime() + HOUR));
  for (let index = 0; index < 30 && !settled.idle; index += 1) settled = await cycleAt(new Date(BASE.getTime() + HOUR));
  assert.equal(settled.idle, true, "plus rien à faire : au repos");
  // 27 jours plus tard : l'avis d'échéance (3 jours avant la fin) est la SEULE chose que le cycle fait.
  const notice = await cycleAt(new Date(BASE.getTime() + 27 * 24 * HOUR));
  assert.deepEqual(notice.errors, []);
  assert.equal(notice.activeSearch.notices, 1);
  assert.deepEqual([notice.collect.watchesProcessed, notice.missions.expired + notice.missions.changed + notice.missions.notified + notice.missions.released, notice.jobs.length], [0, 0, 0]);
  assert.equal(notice.idle, false, "un avis d'échéance écrit est du travail");
  const again = await cycleAt(new Date(BASE.getTime() + 27 * 24 * HOUR));
  assert.deepEqual([again.activeSearch.notices, again.idle], [0, true], "l'avis n'est écrit qu'une fois : le cycle suivant est au repos");
});

test("ordre des étapes du runner : missions, notify, subscriptions, paymentCatchup, market, collect, activeSearch — chacune dans son propre try (une panne n'arrête pas les suivantes)", () => {
  const source = readFileSync(join(import.meta.dirname, "../../lib/server/matching/runner.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  const steps = ["runMissionsStep(", "runNotificationStep(", "runSubscriptionStep(", "runSublymusCatchupStep(", "runMarketStep(", "runCollectStep(", "runActiveSearchStep("];
  const positions = steps.map((step) => {
    const calls = source.split(step).length - 1;
    assert.equal(calls, 1, `${step} est appelée une seule fois`);
    return source.indexOf(step);
  });
  assert.deepEqual([...positions].sort((x, y) => x - y), positions, "ordre des étapes");
  for (const [index, step] of steps.entries()) {
    const before = source.slice(0, positions[index]);
    const tryAt = before.lastIndexOf("try {");
    const segment = before.slice(tryAt);
    for (const other of steps) assert.equal(segment.includes(other), false, `${step} est dans son propre try (aucune autre étape entre le try et l'appel)`);
    const after = source.slice(positions[index]);
    assert.match(after.slice(0, after.indexOf("}") + 400), /catch \(error\)/, `${step} a son catch`);
  }
});
