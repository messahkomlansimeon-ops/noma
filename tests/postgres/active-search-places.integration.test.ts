import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";
import type { Pool, PoolClient } from "pg";
import { ACTIVE_SEARCH_MAX_ACCELERATED_KEYS_PER_USER, ACTIVE_SEARCH_PRICE_XOF, ACTIVE_SEARCH_USER_LOCK_NAMESPACE } from "../../lib/server/active-search/config";
import { activeSearchStateDto } from "../../lib/server/active-search/http";
import { reconcileAcceleratedPlaces } from "../../lib/server/active-search/places";
import { reconcilePlacesForCycle } from "../../lib/server/active-search/places-run";
import { purchaseActiveSearch } from "../../lib/server/active-search/purchase";
import { refundActiveSearchPurchase } from "../../lib/server/active-search/refund";
import { readActiveSearchState } from "../../lib/server/active-search/state";
import { runActiveSearchStep } from "../../lib/server/active-search/step";
import { activateDemand, satisfyDemand, updateDemand } from "../../lib/server/catalog";
import { runCollectStep } from "../../lib/server/external/collect";
import { readAcceleratedKeys, syncMarketWatches } from "../../lib/server/external/watches";
import { withPostgresTransaction } from "../../lib/server/postgres/client";
import { FAKE_ENV, TEST_PSEUDONYM_KEY, barrier, count, createFakeConnectors, installNetworkGuard, makeDemand, recordingSleep, resetDemands, resetExternal, selfTestNetworkGuard, type NetworkGuard } from "./external-fixtures";
import { makePerson } from "./metrics-fixtures";
import { balanceOf, fund, scalar } from "./pro-fixtures";
import { openTestSchema, type TestSchema } from "./social-fixtures";

/**
 * Places de collecte accélérée (lot RA1-ter) : plafond de deux produits par acheteur (à l'achat ET à la prolongation), invariant unique « jamais plus de places que la capacité » maintenu par
 * UNE fonction (achat, prolongation, réactivation d'un besoin suspendu, modification d'un besoin, cycle de collecte), accélération « en attente de place » puis attribuée à la libération
 * (plus ancien achat d'abord), concurrence à deux pools, base sans la migration 0029. Sources FICTIVES, argent SIMULÉ. Le catalogue lit l'environnement du processus pour la capacité :
 * chaque essai pose `NOMA_EXTERNAL_FAKE=1` le temps de son corps.
 */

const DAY = 86_400_000;
let env: TestSchema;
let pool: Pool;
let guard: NetworkGuard;
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
  await pool.query("TRUNCATE active_search_places, active_search_seen, active_search_state CASCADE");
});

/** Corps d'essai avec les connecteurs fictifs disponibles pour le catalogue (capacité lue dans `process.env`). */
async function withFake(body: () => Promise<void>): Promise<void> {
  const previous = process.env.NOMA_EXTERNAL_FAKE;
  process.env.NOMA_EXTERNAL_FAKE = "1";
  try {
    await body();
  } finally {
    if (previous === undefined) delete process.env.NOMA_EXTERNAL_FAKE;
    else process.env.NOMA_EXTERNAL_FAKE = previous;
  }
}

const daysAgo = (days: number): Date => new Date(Date.now() - days * DAY);
const key = (): string => randomUUID();

async function person(credit = 20_000): Promise<string> {
  const created = await makePerson(pool);
  if (credit > 0) await fund(pool, created.id, credit);
  return created.id;
}

const demandOf = async (ownerId: string, model: string, brand = "Google") => (await makeDemand(pool, { ownerId, brand, model })).id;

const buy = (userId: string, demandId: string, extra: { now?: Date; pool?: Pool; hooks?: Parameters<typeof purchaseActiveSearch>[0]["hooks"] } = {}) =>
  purchaseActiveSearch({ expectedPriceXof: ACTIVE_SEARCH_PRICE_XOF, env: FAKE_ENV, pool: extra.pool ?? pool, userId, demandId, idempotencyKey: key(), now: extra.now, hooks: extra.hooks });

async function code(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "ok";
  } catch (error) {
    return (error as { code?: string }).code ?? `${(error as Error).name}: ${(error as Error).message}`;
  }
}

const version = async (demandId: string): Promise<number> => (await pool.query<{ v: number }>("SELECT content_version AS v FROM demands WHERE id = $1", [demandId])).rows[0].v;
const places = async (): Promise<Array<{ product_key: string; demand_id: string; user_id: string }>> =>
  (await pool.query("SELECT product_key, demand_id, user_id FROM active_search_places ORDER BY granted_at, product_key")).rows;
const holders = async (): Promise<string[]> => (await places()).map((row) => row.demand_id).sort();
const acceleratedWatches = async (): Promise<number> => count(pool, "market_watches", "accelerated");
const state = (userId: string, demandId: string) => readActiveSearchState({ env: FAKE_ENV, executor: pool, ownerId: userId, demandId });
const purchaseId = async (demandId: string, number = 1): Promise<string> =>
  (await pool.query<{ id: string }>("SELECT id FROM active_search_purchases WHERE demand_id = $1 AND number = $2", [demandId, number])).rows[0].id;

/**
 * Le grand livre reste équilibré (somme de tous les comptes nulle) : aucun crédit créé ou perdu par une attribution de place. (`wallet:check` complet compare les revenus aux achats, que le remise
 * à zéro des besoins entre deux essais fausserait : il est exécuté sur le schéma jamais remis à zéro des autres essais et par `wallet:check` lui-même.)
 */
async function ledgerBalanced(label: string): Promise<void> {
  assert.equal(await scalar(pool, "SELECT COALESCE(sum(balance), 0)::text AS n FROM wallet_accounts"), "0", `${label} : grand livre équilibré`);
}

/** Un cycle de collecte (l'attribution des places précède la synchronisation des surveillances) avec les connecteurs fictifs, horloge réelle. */
async function cycle() {
  return runCollectStep({ pool, connectors: createFakeConnectors(), now: () => new Date(), sleep: timer.sleep, pseudonymKey: TEST_PSEUDONYM_KEY, maxWatches: 20 });
}

/** Quatre places prises par deux acheteurs (deux produits chacun) : la capacité par défaut (200 → 4) est atteinte. */
async function fillCapacity(): Promise<{ owners: [string, string]; demands: string[] }> {
  const owners: [string, string] = [await person(), await person()];
  const demands: string[] = [];
  for (const [index, owner] of owners.entries()) {
    for (const model of [`Remplissage ${index}-1`, `Remplissage ${index}-2`]) {
      const id = await demandOf(owner, model);
      assert.equal(await code(buy(owner, id, { now: daysAgo(10 - index) })), "ok");
      demands.push(id);
    }
  }
  assert.equal((await places()).length, 4);
  return { owners, demands };
}

// ═════════════ 1. Plafond par utilisateur ═════════════

test("P7-a : un seul acheteur ne confisque plus la capacité : deux produits au plus (user_cap au 3e), rien débité ni écrit, les autres acheteurs gardent les deux autres places", async () => {
  const attacker = await person(60_000);
  const mine = [await demandOf(attacker, "Pixel 1"), await demandOf(attacker, "Pixel 2"), await demandOf(attacker, "Pixel 3"), await demandOf(attacker, "Pixel 4")];
  const outcomes: string[] = [];
  for (const id of mine) outcomes.push(await code(buy(attacker, id)));
  assert.deepEqual(outcomes, ["ok", "ok", "user_cap", "user_cap"]);
  assert.equal(await balanceOf(pool, attacker), BigInt(60_000 - 2 * ACTIVE_SEARCH_PRICE_XOF), "seuls deux achats débités");
  assert.equal(await count(pool, "active_search_purchases", `demand_id = ANY('{${mine[2]},${mine[3]}}'::uuid[])`), 0, "aucun achat écrit pour les refusés");
  const refused = await state(attacker, mine[2]);
  assert.deepEqual([refused.canPurchase, refused.blockedReason, refused.nextEndsAt], [false, "user_cap", null]);
  assert.equal(activeSearchStateDto(refused).blockedReason, "user_cap");
  // Un 2e besoin sur une clé qu'il suit déjà n'ajoute pas de clé : admis.
  const twin = await demandOf(attacker, "Pixel 1");
  assert.equal(await code(buy(attacker, twin)), "ok");
  // Les autres acheteurs obtiennent les deux autres places, le troisième trouve la capacité complète.
  const victims: string[] = [];
  for (const [brand, model] of [["Apple", "iPhone 12"], ["Samsung", "Galaxy S21"], ["Tecno", "Spark 10"]]) {
    const victim = await person(10_000);
    victims.push(await code(buy(victim, (await makeDemand(pool, { ownerId: victim, brand, model })).id)));
  }
  assert.deepEqual(victims, ["ok", "ok", "capacity"]);
  assert.equal((await places()).filter((row) => row.user_id === attacker).length, ACTIVE_SEARCH_MAX_ACCELERATED_KEYS_PER_USER);
  assert.equal((await places()).length, 4);
  await ledgerBalanced("après le plafond par utilisateur");
});

test("le monopole ne se garde pas par prolongations : deux produits prolongés plusieurs fois, jamais plus de deux places pour l'acheteur, jusqu'à l'horizon de 180 jours", async () => {
  const attacker = await person(60_000);
  const mine = [await demandOf(attacker, "Pixel 1"), await demandOf(attacker, "Pixel 2")];
  for (const id of mine) assert.equal(await code(buy(attacker, id)), "ok");
  const outcomes: string[] = [];
  for (const id of mine) for (let extension = 0; extension < 6; extension += 1) outcomes.push(await code(buy(attacker, id)));
  assert.equal(outcomes.filter((entry) => entry === "ok").length, 10, outcomes.join(","));
  assert.ok(outcomes.every((entry) => entry === "ok" || entry === "max_horizon"), outcomes.join(","));
  assert.equal((await places()).filter((row) => row.user_id === attacker).length, 2);
  const third = await demandOf(attacker, "Pixel 3");
  assert.equal(await code(buy(attacker, third)), "user_cap", "un troisième produit reste refusé pendant les prolongations");
});

test("plafond à la PROLONGATION : un acheteur qui a entre-temps des options sur plus de deux produits ne peut plus prolonger (user_cap, rien débité), jusqu'à ce qu'il retombe à deux", async () => {
  await withFake(async () => {
    const owner = await person(40_000);
    const a = await demandOf(owner, "Pixel 1");
    const b = await demandOf(owner, "Pixel 2");
    const c = await demandOf(owner, "Pixel 1"); // même clé que a : admis
    for (const id of [a, b, c]) assert.equal(await code(buy(owner, id, { now: daysAgo(5) })), "ok");
    // Modification du modèle de c : trois produits distincts en vigueur (la modification ne contrôle que la capacité).
    await updateDemand({ id: c, ownerId: owner, expectedContentVersion: await version(c), changes: { model: "Pixel 3", rawText: "Je cherche un Pixel 3" } }, pool);
    const before = await balanceOf(pool, owner);
    const frozen = await state(owner, a);
    assert.deepEqual([frozen.canPurchase, frozen.blockedReason], [false, "user_cap"]);
    for (const id of [a, b, c]) assert.equal(await code(buy(owner, id)), "user_cap", "prolongation refusée au-delà du plafond");
    assert.equal(await balanceOf(pool, owner), before, "rien débité");
    assert.equal(await count(pool, "active_search_purchases", `demand_id = '${a}'`), 1);
    // c (le 3e produit) est remboursé : l'acheteur retombe à deux produits, la prolongation repasse.
    await refundActiveSearchPurchase({ pool, purchaseId: await purchaseId(c), reasonCode: "essai" });
    assert.equal(await code(buy(owner, a)), "ok");
    assert.equal(await code(buy(owner, b)), "ok");
    await ledgerBalanced("après le plafond à la prolongation");
  });
});

// ═════════════ 2. Réactivation et modification sans place ═════════════

test("P7-b : réactivation d'un besoin suspendu quand la capacité a été reprise → option en vigueur SANS accélération (en attente), notifications intactes, jamais plus de places que la capacité ; la place arrive à la libération", async () => {
  await withFake(async () => {
    const waiting = await person();
    const a = await demandOf(waiting, "Pixel A");
    assert.equal(await code(buy(waiting, a, { now: daysAgo(6) })), "ok");
    assert.deepEqual(await holders(), [a]);
    await satisfyDemand(waiting, a, await version(a), pool);
    assert.deepEqual(await holders(), [], "le besoin satisfait suspend l'option : sa place est libérée tout de suite");
    const { demands } = await fillCapacity();
    const balanceBefore = await balanceOf(pool, waiting);
    await activateDemand(waiting, a, await version(a), pool);
    assert.equal((await places()).length, 4, "la réactivation ne dépasse jamais la capacité");
    assert.equal((await places()).some((row) => row.demand_id === a), false);
    const pending = await state(waiting, a);
    assert.deepEqual([pending.active, pending.accelerationPending, pending.suspended], [true, true, false]);
    assert.equal(activeSearchStateDto(pending).accelerationPending, true);
    assert.equal(await balanceOf(pool, waiting), balanceBefore, "aucun remboursement ni débit automatique");
    await cycle();
    assert.equal(await acceleratedWatches(), 4, "quatre surveillances accélérées, jamais cinq");
    assert.equal((await pool.query("SELECT accelerated FROM market_watches WHERE product_key LIKE '%pixel a%'")).rows[0].accelerated, false, "la surveillance du produit en attente reste ordinaire");
    assert.equal(await count(pool, "active_search_purchases", `demand_id = '${a}' AND status = 'active'`), 1, "l'option reste en vigueur");
    // Une place se libère (option remboursée) : le prochain cycle la donne à l'option en attente.
    await refundActiveSearchPurchase({ pool, purchaseId: await purchaseId(demands[0]), reasonCode: "essai" });
    await cycle();
    assert.equal(await acceleratedWatches(), 4);
    assert.ok((await holders()).includes(a), "l'option en attente reçoit la place libérée");
    const running = await state(waiting, a);
    assert.deepEqual([running.active, running.accelerationPending], [true, false]);
    assert.equal((await pool.query("SELECT accelerated FROM market_watches WHERE product_key LIKE '%pixel a%'")).rows[0].accelerated, true);
    await ledgerBalanced("après la réactivation sans place");
  });
});

test("P7-c : un achat sur une clé DÉJÀ accélérée puis la modification du modèle n'ajoute aucune place au-delà de la capacité : l'option reste en vigueur sans accélération, puis reçoit une place à la libération", async () => {
  await withFake(async () => {
    const { demands } = await fillCapacity();
    const [first] = (await places()).map((row) => row.product_key);
    assert.ok(first);
    const newcomers: string[] = [];
    const modified: string[] = [];
    for (const [index, target] of ["Galaxy S21", "Galaxy S22", "Galaxy S23"].entries()) {
      const buyer = await person(10_000);
      const id = await demandOf(buyer, "Remplissage 0-1"); // clé déjà accélérée : admise sans place de plus
      assert.equal(await code(buy(buyer, id, { now: daysAgo(3 - index) })), "ok");
      await updateDemand({ id, ownerId: buyer, expectedContentVersion: await version(id), changes: { brand: "Samsung", model: target, rawText: `Je cherche un ${target}` } }, pool);
      newcomers.push(buyer);
      modified.push(id);
    }
    assert.equal((await places()).length, 4, "la modification ne dépasse jamais la capacité");
    for (const [index, id] of modified.entries()) assert.equal((await state(newcomers[index], id)).accelerationPending, true, "option en vigueur, accélération en attente de place");
    await cycle();
    assert.equal(await acceleratedWatches(), 4, "jamais plus de surveillances accélérées que la capacité");
    assert.equal(await count(pool, "active_search_purchases", "status = 'active'"), 7);
    // Deux places se libèrent : les deux options les PLUS ANCIENNES (achats de J-3 et J-2) les reçoivent, la plus récente (J-1) attend.
    await refundActiveSearchPurchase({ pool, purchaseId: await purchaseId(demands[0]), reasonCode: "essai" });
    await refundActiveSearchPurchase({ pool, purchaseId: await purchaseId(demands[2]), reasonCode: "essai" });
    await cycle();
    const held = await holders();
    assert.equal(held.length, 4);
    assert.deepEqual([modified[0], modified[1]].every((id) => held.includes(id)), true, "plus ancien achat d'abord");
    assert.equal(held.includes(modified[2]), false);
    assert.equal(await acceleratedWatches(), 4);
    assert.equal((await state(newcomers[2], modified[2])).accelerationPending, true);
  });
});

test("le plafond par utilisateur s'applique aussi aux places : un 3e produit obtenu par modification reste en attente même s'il reste de la capacité, et la reçoit quand l'acheteur retombe à deux", async () => {
  await withFake(async () => {
    const owner = await person(40_000);
    const a = await demandOf(owner, "Pixel 1");
    const b = await demandOf(owner, "Pixel 2");
    const c = await demandOf(owner, "Pixel 1");
    for (const id of [a, b, c]) assert.equal(await code(buy(owner, id, { now: daysAgo(4) })), "ok");
    await updateDemand({ id: c, ownerId: owner, expectedContentVersion: await version(c), changes: { model: "Pixel 3", rawText: "Je cherche un Pixel 3" } }, pool);
    assert.equal((await places()).length, 2, "deux places pour l'acheteur, bien que la capacité soit de quatre");
    assert.deepEqual([(await state(owner, c)).accelerationPending, (await state(owner, a)).accelerationPending], [true, false]);
    await refundActiveSearchPurchase({ pool, purchaseId: await purchaseId(a), reasonCode: "essai" });
    await cycle();
    assert.deepEqual((await holders()), [b, c].sort());
    assert.equal((await state(owner, c)).accelerationPending, false);
    assert.equal(await acceleratedWatches(), 2);
  });
});

test("réattribution : un besoin dont l'option se termine, est satisfait ou change de clé libère sa place ; une autre option de la MÊME clé la reprend (transfert), sinon la place est libre", async () => {
  await withFake(async () => {
    const first = await person();
    const second = await person();
    const holder = await demandOf(first, "Pixel 1");
    const successor = await demandOf(second, "Pixel 1");
    assert.equal(await code(buy(first, holder, { now: daysAgo(5) })), "ok");
    assert.equal(await code(buy(second, successor, { now: daysAgo(4) })), "ok");
    assert.deepEqual(await holders(), [holder], "une place par clé : la surveillance est partagée");
    await satisfyDemand(first, holder, await version(holder), pool);
    assert.deepEqual(await holders(), [successor], "la place passe à l'autre option de la même clé, sans interruption");
    assert.equal((await places())[0].user_id, second);
    await cycle();
    assert.equal(await acceleratedWatches(), 1);
    await satisfyDemand(second, successor, await version(successor), pool);
    assert.deepEqual(await holders(), [], "plus aucune option active sur la clé : place libre");
    await cycle();
    assert.equal(await acceleratedWatches(), 0);
  });
});

test("le changement d'un besoin ne fait jamais échouer à cause de l'accélération : verrou global tenu par un autre processus, la modification réussit et le cycle suivant réattribue", async () => {
  await withFake(async () => {
    const owner = await person();
    const a = await demandOf(owner, "Pixel 1");
    assert.equal(await code(buy(owner, a, { now: daysAgo(1) })), "ok");
    const holderClient = await pool.connect();
    try {
      await holderClient.query("BEGIN");
      await holderClient.query("SELECT pg_advisory_xact_lock($1::int, hashtext('capacity'))", [ACTIVE_SEARCH_USER_LOCK_NAMESPACE]);
      const started = Date.now();
      const changed = await updateDemand({ id: a, ownerId: owner, expectedContentVersion: await version(a), changes: { model: "Pixel 9", rawText: "Je cherche un Pixel 9" } }, pool);
      assert.equal(changed.model, "Pixel 9", "la modification a réussi");
      assert.ok(Date.now() - started < 8_000, "attente du verrou bornée");
    } finally {
      await holderClient.query("ROLLBACK");
      holderClient.release();
    }
    assert.equal(await count(pool, "active_search_places", `product_key LIKE '%pixel 9%'`), 0, "la place n'a pas été réattribuée dans la modification");
    await cycle();
    assert.equal((await places()).length, 1, "le cycle suivant réattribue");
    assert.equal(await acceleratedWatches(), 1);
    assert.equal((await places())[0].product_key.includes("pixel 9"), true);
  });
});

test("réactivation AVEC place libre : l'option reprend accélérée tout de suite (pas d'attente du cycle) ; modification du modèle : l'ancienne clé libère sa place et la nouvelle la reçoit dans la même opération", async () => {
  await withFake(async () => {
    const owner = await person();
    const a = await demandOf(owner, "Pixel 1");
    assert.equal(await code(buy(owner, a, { now: daysAgo(2) })), "ok");
    await satisfyDemand(owner, a, await version(a), pool);
    assert.deepEqual(await holders(), []);
    await activateDemand(owner, a, await version(a), pool);
    assert.deepEqual(await holders(), [a], "place redemandée et obtenue dans la transaction de la réactivation");
    assert.equal((await state(owner, a)).accelerationPending, false);
    await updateDemand({ id: a, ownerId: owner, expectedContentVersion: await version(a), changes: { model: "Pixel 9", rawText: "Je cherche un Pixel 9" } }, pool);
    const held = await places();
    assert.equal(held.length, 1);
    assert.deepEqual([held[0].demand_id, held[0].product_key.includes("pixel 9"), held[0].product_key.includes("pixel 1")], [a, true, false], "la place a suivi la nouvelle clé");
    assert.equal((await state(owner, a)).accelerationPending, false);
  });
});

test("transfert PRIORITAIRE : la place d'un porteur qui change de produit reste à une autre option de la MÊME clé, même si l'option qui part est la plus ancienne et demande aussitôt une place pour son nouveau produit", async () => {
  await withFake(async () => {
    // Trois options sur le produit K ; la plus ancienne porte la place (attribuée la première), les deux autres s'y joignent sans place de plus.
    const oldest = await person();
    const second = await person();
    const third = await person();
    const carrier = await demandOf(oldest, "Pixel K");
    assert.equal(await code(buy(oldest, carrier, { now: daysAgo(20) })), "ok");
    assert.equal(await code(buy(second, await demandOf(second, "Pixel K"), { now: daysAgo(10) })), "ok");
    assert.equal(await code(buy(third, await demandOf(third, "Pixel K"), { now: daysAgo(5) })), "ok");
    assert.deepEqual(await holders(), [carrier], "une place par clé");
    const fillers = await person();
    for (const model of ["Remplissage 1", "Remplissage 2"]) assert.equal(await code(buy(fillers, await demandOf(fillers, model), { now: daysAgo(1) })), "ok");
    const other = await person();
    assert.equal(await code(buy(other, await demandOf(other, "Remplissage 3"), { now: daysAgo(1) })), "ok");
    assert.equal((await places()).length, 4);
    // Le porteur change de produit. Sans transfert, il serait le premier servi pour son NOUVEAU produit (le plus ancien achat) et la clé K, encore voulue par deux autres options, perdrait sa place.
    await updateDemand({ id: carrier, ownerId: oldest, expectedContentVersion: await version(carrier), changes: { model: "Pixel Z", rawText: "Je cherche un Pixel Z" } }, pool);
    const afterChange = await places();
    assert.equal(afterChange.length, 4, "jamais plus de quatre places");
    const kPlace = afterChange.find((row) => row.product_key.includes("pixel k"));
    assert.ok(kPlace, "la clé K garde sa place");
    assert.notEqual(kPlace.demand_id, carrier, "elle n'est plus portée par le besoin qui a changé de produit");
    assert.equal(afterChange.some((row) => row.product_key.includes("pixel z")), false, "le nouveau produit attend une place");
    assert.equal((await state(oldest, carrier)).accelerationPending, true);
  });
});

test("l'achat voit les places libérées : une place dont le porteur n'a plus d'option est reprise tout de suite par l'admission (aucun refus capacity en attendant le cycle)", async () => {
  await withFake(async () => {
    const { demands } = await fillCapacity();
    await refundActiveSearchPurchase({ pool, purchaseId: await purchaseId(demands[0]), reasonCode: "essai" });
    const newcomer = await person();
    const wanted = await demandOf(newcomer, "Nouveau produit");
    assert.equal(await code(buy(newcomer, wanted)), "ok", "la place libérée par le remboursement est utilisable immédiatement");
    assert.equal((await places()).length, 4);
    assert.equal((await holders()).includes(wanted), true);
  });
});

test("le plafond compte les options SUSPENDUES : deux produits dont un besoin satisfait empêchent un troisième achat (il pourrait être réactivé)", async () => {
  await withFake(async () => {
    const owner = await person();
    const a = await demandOf(owner, "Pixel 1");
    const b = await demandOf(owner, "Pixel 2");
    for (const id of [a, b]) assert.equal(await code(buy(owner, id)), "ok");
    await satisfyDemand(owner, a, await version(a), pool);
    const c = await demandOf(owner, "Pixel 3");
    assert.equal(await code(buy(owner, c)), "user_cap");
    assert.deepEqual([(await state(owner, c)).blockedReason, (await state(owner, c)).canPurchase], ["user_cap", false]);
    await activateDemand(owner, a, await version(a), pool);
    assert.deepEqual(await holders(), [a, b].sort(), "réactivé, il reprend sa place, le plafond n'a jamais été dépassé");
  });
});

// ═════════════ 3. Cycle de collecte : retrait au-delà de la capacité ═════════════

test("quotas réduits : au-delà de la nouvelle capacité les places les plus RÉCENTES sont retirées (les plus anciennes gardées), sans aucun remboursement", async () => {
  await withFake(async () => {
    const { owners, demands } = await fillCapacity();
    const order = (await places()).map((row) => row.demand_id);
    await cycle();
    assert.equal(await acceleratedWatches(), 4);
    await pool.query("UPDATE external_sources SET daily_quota = 100 WHERE code = 'demo_a'");
    const balances = [await balanceOf(pool, owners[0]), await balanceOf(pool, owners[1])];
    await cycle();
    assert.equal((await places()).length, 2, "100 → 50 → 2 surveillances");
    assert.deepEqual(await holders(), order.slice(0, 2).sort(), "les deux places les plus anciennes sont gardées");
    assert.equal(await acceleratedWatches(), 2);
    assert.deepEqual([await balanceOf(pool, owners[0]), await balanceOf(pool, owners[1])], balances, "aucun remboursement automatique");
    assert.equal((await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM active_search_purchases WHERE demand_id = ANY($1::uuid[]) AND status = 'active'", [demands])).rows[0].n, 4, "les options restent en vigueur");
    await pool.query("UPDATE external_sources SET daily_quota = 200 WHERE code = 'demo_a'");
    await cycle();
    assert.equal((await places()).length, 4, "quota rétabli : les options en attente retrouvent leur place");
  });
});

// ═════════════ 4. Concurrence (deux pools, verrou global) ═════════════

test("concurrence à DEUX pools avec barrière : deux achats pour la dernière place → un seul réussi, l'autre capacity, jamais plus de places que la capacité", async () => {
  const filler = await person();
  const fillerDemands = [await demandOf(filler, "Remplissage 1"), await demandOf(filler, "Remplissage 2")];
  for (const id of fillerDemands) assert.equal(await code(buy(filler, id)), "ok");
  const other = await person();
  assert.equal(await code(buy(other, await demandOf(other, "Remplissage 3"))), "ok");
  assert.equal((await places()).length, 3);
  const poolA = env.extraPool(4);
  const poolB = env.extraPool(4);
  const racers = [await person(), await person()];
  const racerDemands = [await demandOf(racers[0], "Course A"), await demandOf(racers[1], "Course B")];
  const gate = barrier();
  const run = async (index: number, poolOf: Pool): Promise<string> => {
    await gate.wait;
    return code(buy(racers[index], racerDemands[index], {
      pool: poolOf,
      // Le premier arrivé garde le verrou global pendant que l'autre l'attend.
      hooks: { beforeDebit: async () => void (await new Promise((resolve) => setTimeout(resolve, 400))) },
    }));
  };
  const both = Promise.all([run(0, poolA), run(1, poolB)]);
  gate.open();
  const outcomes = (await both).sort();
  assert.deepEqual(outcomes, ["capacity", "ok"]);
  assert.equal((await places()).length, 4, "jamais plus de quatre places");
  await ledgerBalanced("après la course pour la dernière place");
});

test("concurrence : un achat et une réactivation se disputent la dernière place → exactement une place attribuée, l'autre option en attente, jamais plus que la capacité", async () => {
  await withFake(async () => {
    const waiting = await person();
    const a = await demandOf(waiting, "Pixel A");
    assert.equal(await code(buy(waiting, a, { now: daysAgo(6) })), "ok");
    await satisfyDemand(waiting, a, await version(a), pool);
    const filler = await person();
    for (const model of ["Remplissage 1", "Remplissage 2"]) assert.equal(await code(buy(filler, await demandOf(filler, model))), "ok");
    const other = await person();
    assert.equal(await code(buy(other, await demandOf(other, "Remplissage 3"))), "ok");
    assert.equal((await places()).length, 3);
    const racer = await person();
    const racerDemand = await demandOf(racer, "Course");
    const poolA = env.extraPool(4);
    const poolB = env.extraPool(4);
    const buying = code(buy(racer, racerDemand, { pool: poolA, hooks: { beforeDebit: async () => void (await new Promise((resolve) => setTimeout(resolve, 600))) } }));
    await new Promise((resolve) => setTimeout(resolve, 150));
    await activateDemand(waiting, a, await version(a), poolB);
    assert.equal(await buying, "ok");
    assert.equal((await places()).length, 4, "jamais plus de quatre places");
    assert.equal((await holders()).includes(racerDemand), true, "l'achat tenait le verrou : il a la place");
    assert.equal((await state(waiting, a)).accelerationPending, true, "la réactivation attend");
  });
});

// ═════════════ 5. Fonction unique : cas de données ═════════════

test("fonction unique : sans option en vigueur ni besoin actif aucune place n'existe ; une place d'un besoin inconnu est retirée ; un second passage ne change plus rien (idempotent)", async () => {
  await withFake(async () => {
    const owner = await person();
    const a = await demandOf(owner, "Pixel 1");
    assert.equal(await code(buy(owner, a)), "ok");
    await pool.query("INSERT INTO active_search_places (product_key, demand_id, user_id) VALUES ('x'||chr(31)||'y'||chr(31)||'z'||chr(31)||''||chr(31)||'', $1, $2)", [randomUUID(), randomUUID()]);
    const run = () => withPostgresTransaction((client: PoolClient) => reconcileAcceleratedPlaces(client, { now: new Date(), limit: 4, trim: true }), pool);
    const first = await run();
    assert.equal(first.released, 1);
    assert.deepEqual(await holders(), [a]);
    const second = await run();
    assert.deepEqual([second.granted, second.transferred, second.released, second.trimmed], [0, 0, 0, 0]);
    assert.equal((await readAcceleratedKeys(pool, new Date())).length, 1);
    // Capacité nulle : plus aucune place.
    const none = await withPostgresTransaction((client: PoolClient) => reconcileAcceleratedPlaces(client, { now: new Date(), limit: 0, trim: true }), pool);
    assert.equal(none.trimmed, 1);
    assert.deepEqual(await places(), []);
    await syncMarketWatches(pool, new Date());
    assert.equal(await acceleratedWatches(), 0);
  });
});

test("un passage dont l'horloge a été lue AVANT un achat validé entre-temps ne lui retire pas sa place (tolérance sur le début des périodes) ; une période terminée n'est jamais tolérée", async () => {
  await withFake(async () => {
    const owner = await person();
    const a = await demandOf(owner, "Pixel 1");
    assert.equal(await code(buy(owner, a)), "ok"); // horloge de la base
    const early = new Date(Date.now() - 2_000);
    const kept = await withPostgresTransaction((client: PoolClient) => reconcileAcceleratedPlaces(client, { now: early, limit: 4, trim: true }), pool);
    assert.deepEqual([kept.released, kept.granted, kept.held.length], [0, 0, 1], "la place d'un achat tout neuf reste");
    const late = new Date(Date.now() + 31 * DAY);
    const ended = await withPostgresTransaction((client: PoolClient) => reconcileAcceleratedPlaces(client, { now: late, limit: 4, trim: true }), pool);
    assert.deepEqual([ended.released, ended.held.length], [1, 0], "30 jours plus tard l'option est terminée : la place est libérée");
  });
});

test("cycle de collecte : rien à faire → ni connexion dédiée ni verrou global (essai à blanc sur le pool) ; un changement à faire → une transaction sous le verrou", async () => {
  await withFake(async () => {
    let connects = 0;
    const counted = new Proxy(pool, {
      get(target, property) {
        if (property === "connect") return (...args: unknown[]) => { connects += 1; return (target.connect as (...inner: unknown[]) => unknown)(...args); };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const codes = createFakeConnectors().map((connector) => connector.code);
    const owner = await person();
    assert.equal(await code(buy(owner, await demandOf(owner, "Pixel 1"))), "ok");
    const quiet = await reconcilePlacesForCycle(counted, { connectorCodes: codes, now: new Date() });
    assert.deepEqual([connects, quiet?.granted, quiet?.released, quiet?.held.length], [0, 0, 0, 1], "rien à faire : aucune connexion dédiée");
    await pool.query("DELETE FROM active_search_places");
    const repair = await reconcilePlacesForCycle(counted, { connectorCodes: codes, now: new Date() });
    assert.deepEqual([connects, repair?.granted, repair?.held.length], [1, 1, 1], "une place manque : une transaction, la place est attribuée");
    assert.equal((await places()).length, 1);
  });
});

test("l'étape du worker et la synchronisation ignorent la recherche active quand la migration 0029 manque (migration AVANT le code) : option indisponible, aucune erreur", async () => {
  const bare = await openTestSchema(4);
  try {
    const owner = await makePerson(bare.pool);
    await fund(bare.pool, owner.id, 10_000);
    const demand = await makeDemand(bare.pool, { ownerId: owner.id });
    await bare.pool.query("DROP TABLE active_search_places");
    const read = await readActiveSearchState({ env: FAKE_ENV, executor: bare.pool, ownerId: owner.id, demandId: demand.id });
    assert.deepEqual([read.canPurchase, read.blockedReason, read.accelerationPending], [false, "unavailable", false]);
    assert.equal(await code(buy(owner.id, demand.id, { pool: bare.pool })), "unavailable");
    const step = await runActiveSearchStep({ pool: bare.pool });
    assert.deepEqual([step.skipped, step.errors], [true, []]);
    const collected = await runCollectStep({ pool: bare.pool, connectors: createFakeConnectors(), now: () => new Date(), sleep: timer.sleep, pseudonymKey: TEST_PSEUDONYM_KEY });
    assert.deepEqual(collected.errors, []);
    assert.equal(await count(bare.pool, "market_watches", "accelerated"), 0);
  } finally {
    await bare.close();
  }
});
