import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { runMatchingCycle } from "../../lib/server/matching/runner";
import { checkWalletIntegrity } from "../../lib/server/wallet/check";
import { createWalletHttpHandlers, type WalletHttpHandlers } from "../../lib/server/wallet/http";
import { catchupDelayMs, runCatchup, type CatchupStepResult } from "../../lib/server/wallet/sublymus/catchup";
import { SublymusClient } from "../../lib/server/wallet/sublymus/client";
import type { FakeSublymusApi } from "../../scripts/sublymus-fake-api";
import {
  TEST_API_KEY, TEST_MANAGER_ID, TEST_WALLET_ID, TEST_WEBHOOK_SECRET, balanceOf, countRows, newTopup, providerOf, startApi, sublymusEnv, topupTransactions, webhookRequest, type Env,
} from "./sublymus-fixtures";
import { createTopupIntent } from "../../lib/server/wallet/topups";
import { login, openTestSchema, reply, type Login, type TestSchema } from "./social-fixtures";

/**
 * Lot PAY1 : rattrapage des recharges Sublymus (étape isolée du worker). Contre la FAUSSE API locale : la recherche est PARTIELLE (références voisines renvoyées) ; le filtre est la
 * référence EXACTE ; COMPLETED crédite une seule fois, y compris en concurrence avec le webhook ; attente croissante, fenêtre de 24 h, écarts journalisés.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

let env: TestSchema;
let api: FakeSublymusApi;
let envVars: Env;
let handlers: WalletHttpHandlers;

before(async () => {
  env = await openTestSchema(16);
  api = await startApi();
  envVars = sublymusEnv(api);
  handlers = createWalletHttpHandlers({ pool: env.pool, env: envVars });
});

after(async () => {
  await api.close();
  await env.close();
});

const client = (options: { fetch?: typeof fetch; timeoutMs?: number } = {}): SublymusClient => new SublymusClient({ apiKey: TEST_API_KEY, managerId: TEST_MANAGER_ID, walletId: TEST_WALLET_ID, baseUrl: api.url }, options);
const catchup = (now: Date, limit = 100, extra: { client?: SublymusClient; budgetMs?: number } = {}): Promise<CatchupStepResult> =>
  runCatchup({ pool: env.pool, client: extra.client ?? client(), managerId: TEST_MANAGER_ID, now, limit, budgetMs: extra.budgetMs });
const createdAt = async (intentId: string): Promise<Date> => (await env.pool.query<{ at: Date }>("SELECT created_at AS at FROM payment_intents WHERE id = $1", [intentId])).rows[0].at;
const status = async (intentId: string): Promise<string> => (await env.pool.query<{ status: string }>("SELECT status FROM payment_intents WHERE id = $1", [intentId])).rows[0].status;
const state = async (intentId: string) => (await env.pool.query<{ attempts: number; outcome: string | null; next: Date | null; done: boolean; provider_status: string | null }>(
  "SELECT catchup_attempts AS attempts, last_catchup_outcome AS outcome, next_catchup_at AS next, catchup_done_at IS NOT NULL AS done, provider_status FROM sublymus_checkouts WHERE intent_id = $1", [intentId])).rows[0];
const kindsOf = async (intentId: string): Promise<string[]> => (await env.pool.query<{ kind: string }>("SELECT kind FROM sublymus_anomalies WHERE intent_id = $1 AND origin = 'catchup' ORDER BY kind", [intentId])).rows.map((row) => row.kind);
/** Ferme le rattrapage de toutes les sessions déjà créées par les autres essais du fichier : chaque essai ne voit que SES intentions (le schéma est partagé). */
async function quiesce(): Promise<void> {
  await env.pool.query("UPDATE sublymus_checkouts SET next_catchup_at = NULL, catchup_done_at = COALESCE(catchup_done_at, clock_timestamp()) WHERE next_catchup_at IS NOT NULL");
}
/** Horloge du rattrapage : `minutes` après la création de l'intention. */
const later = async (intentId: string, minutes: number): Promise<Date> => new Date((await createdAt(intentId)).getTime() + minutes * MINUTE);

// ═════════════ 1. Calendrier ═════════════

test("calendrier : rien avant 2 minutes, puis une tentative dont l'attente double (4, 8, 16, 32 minutes, plafond 1 heure) ; une session en attente chez Wave reste « en attente »", async () => {
  await quiesce();
  assert.deepEqual([0, 1, 2, 3, 4, 5, 8].map((attempts) => catchupDelayMs(attempts) / MINUTE), [2, 4, 8, 16, 32, 60, 60]);
  const owner = await login(env.pool);
  const handle = await newTopup(env.pool, api, envVars, owner.userId, 5_000);
  const start = await createdAt(handle.intent.id);
  const first = await state(handle.intent.id);
  assert.equal(first.attempts, 0);
  assert.equal(first.next!.getTime() - start.getTime(), 2 * MINUTE, "première tentative : 2 minutes après la création");
  // Avant l'échéance : la ligne n'est pas touchée.
  assert.equal((await catchup(new Date(start.getTime() + MINUTE))).examined >= 0, true);
  assert.equal((await state(handle.intent.id)).attempts, 0);
  // Après chaque échéance : une tentative, l'attente double.
  let now = new Date(start.getTime() + 3 * MINUTE);
  for (const expected of [4, 8, 16, 32, 60, 60]) {
    const result = await catchup(now);
    assert.ok(result.examined >= 1);
    const after = await state(handle.intent.id);
    assert.equal(after.outcome, "waiting");
    assert.equal(after.provider_status, "WAVE_CREATED");
    assert.equal(after.next!.getTime() - now.getTime(), expected * MINUTE, `attente de ${expected} minutes`);
    // Une relance immédiate ne refait rien (rien n'est échu).
    const idle = await catchup(now);
    assert.equal((await state(handle.intent.id)).attempts, after.attempts);
    assert.ok(idle.errors.length === 0);
    now = new Date(after.next!.getTime() + 1_000);
  }
  assert.equal(await balanceOf(env.pool, owner.userId), BigInt(0));
});

test("fenêtre de 24 heures : au-delà, le rattrapage s'arrête (aucun appel à Sublymus pour cette intention) ; une intention déjà terminée par webhook est fermée aussi", async () => {
  await quiesce();
  const owner = await login(env.pool);
  const stale = await newTopup(env.pool, api, envVars, owner.userId, 2_000);
  const done = await newTopup(env.pool, api, envVars, owner.userId, 2_100);
  const signed = api.webhook({ intent: done.fakeIntent!, secret: TEST_WEBHOOK_SECRET, webhookId: "wh_catchup_done_01" });
  assert.equal((await handlers.sublymus.webhook(webhookRequest(signed)).then(reply)).status, 200);
  const calls = api.requests.length;
  const result = await catchup(await later(stale.intent.id, 25 * 60));
  assert.ok(result.windowClosed >= 1);
  const closed = await state(stale.intent.id);
  assert.deepEqual([closed.done, closed.next, closed.outcome], [true, null, "window_closed"]);
  assert.equal(api.requests.slice(calls).filter((entry) => entry.path.includes(stale.reference)).length, 0, "aucune requête pour une intention hors fenêtre");
  assert.equal(await balanceOf(env.pool, owner.userId), BigInt(2_100), "seul le paiement confirmé par webhook est crédité");
});

// ═════════════ 2. Filtre exact, crédit unique ═════════════

test("recherche PARTIELLE : seules les références EXACTES comptent ; un voisin payé (préfixe, suffixe) ne crédite jamais ; COMPLETED crédite UNE fois, le second passage ne refait rien", async () => {
  await quiesce();
  const owner = await login(env.pool);
  const handle = await newTopup(env.pool, api, envVars, owner.userId, 5_000);
  api.seed({ externalReference: `${handle.reference}-bis`, amount: 5_000, status: "COMPLETED" });
  api.seed({ externalReference: `x${handle.reference}`, amount: 5_000, status: "COMPLETED" });
  api.seed({ externalReference: handle.reference.slice(0, -1), amount: 5_000, status: "COMPLETED" });
  const now = await later(handle.intent.id, 3);
  const result = await catchup(now);
  assert.ok(result.waiting >= 1);
  assert.equal(await status(handle.intent.id), "pending", "les voisins payés ne comptent pas");
  assert.equal(await balanceOf(env.pool, owner.userId), BigInt(0));
  assert.deepEqual(await kindsOf(handle.intent.id), [], "un voisin n'est ni un doublon ni une anomalie : le filtre sur la référence EXACTE l'ignore");
  assert.equal((await state(handle.intent.id)).outcome, "waiting");
  // La session exacte est payée chez Wave : le rattrapage crédite.
  api.setStatus(handle.fakeIntent!.id, "COMPLETED");
  const credited = await catchup(new Date(now.getTime() + 10 * MINUTE));
  assert.ok(credited.completed >= 1);
  assert.equal(await status(handle.intent.id), "succeeded");
  assert.equal(await balanceOf(env.pool, owner.userId), BigInt(5_000));
  assert.equal(await topupTransactions(env.pool, handle.intent.id), 1);
  assert.deepEqual(await kindsOf(handle.intent.id), [], "aucune anomalie : seule la référence exacte compte");
  const after = await state(handle.intent.id);
  assert.deepEqual([after.done, after.next, after.outcome, after.provider_status], [true, null, "completed", "COMPLETED"]);
  const event = (await env.pool.query<{ provider_event_id: string; outcome: string }>("SELECT provider_event_id, outcome FROM payment_events WHERE intent_id = $1", [handle.intent.id])).rows;
  assert.deepEqual(event.map((row) => row.outcome), ["applied"]);
  assert.match(event[0].provider_event_id, /^sublymus_poll_[0-9a-f]{32}_c$/);
  await catchup(new Date(now.getTime() + 2 * HOUR));
  assert.equal(await topupTransactions(env.pool, handle.intent.id), 1, "un second passage ne crédite pas");
  assert.equal(await balanceOf(env.pool, owner.userId), BigInt(5_000));
  assert.deepEqual((await checkWalletIntegrity(env.pool)).violations, []);
});

test("FAILED chez Sublymus : l'intention échoue, rien n'est crédité ; introuvable : « introuvable », nouvelle tentative plus tard", async () => {
  await quiesce();
  const owner = await login(env.pool);
  const failed = await newTopup(env.pool, api, envVars, owner.userId, 3_000);
  api.setStatus(failed.fakeIntent!.id, "FAILED");
  assert.ok((await catchup(await later(failed.intent.id, 3))).failed >= 1);
  assert.equal(await status(failed.intent.id), "failed");
  assert.equal(await balanceOf(env.pool, owner.userId), BigInt(0));
  // Lot PAY1-ter (N4) : un échec ne ferme PLUS la session (elle reste sondée jusqu'à 24 h : un paiement peut réussir après un échec).
  const afterFailure = await state(failed.intent.id);
  assert.deepEqual([afterFailure.done, afterFailure.outcome, afterFailure.provider_status, afterFailure.next !== null], [false, "failed", "FAILED", true]);
  // Introuvable chez Sublymus (création perdue) : on retente plus tard, rien n'est présumé.
  const lost = await newTopup(env.pool, api, envVars, owner.userId, 3_000);
  api.intents.delete(lost.fakeIntent!.id);
  assert.ok((await catchup(await later(lost.intent.id, 3))).notFound >= 1);
  const lostState = await state(lost.intent.id);
  assert.deepEqual([lostState.outcome, lostState.done, lostState.attempts], ["not_found", false, 1]);
  assert.equal(await status(lost.intent.id), "pending");
});

// ═════════════ 3. Concurrence avec le webhook ═════════════

test("rattrapage et webhook EN MÊME TEMPS : une seule recharge, jamais deux crédits (répété sur plusieurs intentions)", async () => {
  await quiesce();
  const owner = await login(env.pool);
  const pools = Array.from({ length: 6 }, () => env.extraPool(2));
  for (let round = 0; round < 6; round += 1) {
    const handle = await newTopup(env.pool, api, envVars, owner.userId, 1_000 + round * 100);
    api.setStatus(handle.fakeIntent!.id, "COMPLETED");
    const signed = api.webhook({ intent: handle.fakeIntent!, secret: TEST_WEBHOOK_SECRET, webhookId: `wh_race_catchup_${round}` });
    const now = await later(handle.intent.id, 3);
    const farm = pools.map((pool) => createWalletHttpHandlers({ pool, env: envVars }));
    await Promise.all([
      farm[0].sublymus.webhook(webhookRequest(signed)).then(reply),
      farm[1].sublymus.webhook(webhookRequest(signed)).then(reply),
      runCatchup({ pool: pools[2], client: client(), managerId: TEST_MANAGER_ID, now }),
      runCatchup({ pool: pools[3], client: client(), managerId: TEST_MANAGER_ID, now }),
      farm[4].sublymus.webhook(webhookRequest(api.webhook({ intent: handle.fakeIntent!, secret: TEST_WEBHOOK_SECRET, webhookId: `wh_race_catchup_b${round}` }))).then(reply),
    ]);
    assert.equal(await topupTransactions(env.pool, handle.intent.id), 1, `tour ${round}`);
    assert.equal(await status(handle.intent.id), "succeeded");
    const applied = await countRows(env.pool, "payment_events", "intent_id = $1 AND outcome = 'applied'", [handle.intent.id]);
    assert.equal(applied, 1);
  }
  assert.equal(await balanceOf(env.pool, owner.userId), BigInt(1_000 + 1_100 + 1_200 + 1_300 + 1_400 + 1_500));
  assert.deepEqual((await checkWalletIntegrity(env.pool)).violations, []);
});

// ═════════════ 4. Écarts ═════════════

test("écarts chez Sublymus (montant, devise, payeur, système source, identifiant, statut inconnu, doublons) : rien n'est crédité, une anomalie « rattrapage » par genre", async () => {
  await quiesce();
  const owners: Login[] = [];
  const newHandle = async (amount: number) => {
    const owner = await login(env.pool);
    owners.push(owner);
    return newTopup(env.pool, api, envVars, owner.userId, amount);
  };
  const cases: Array<{ kind: string; mutate: (intent: { amount: number }, handle: Awaited<ReturnType<typeof newTopup>>) => void }> = [
    { kind: "amount_mismatch", mutate: (_intent, handle) => { handle.fakeIntent!.amount = 4_999; handle.fakeIntent!.status = "COMPLETED"; } },
    { kind: "currency_mismatch", mutate: (_intent, handle) => { handle.fakeIntent!.currency = "USD"; handle.fakeIntent!.status = "COMPLETED"; } },
    { kind: "payer_mismatch", mutate: (_intent, handle) => { handle.fakeIntent!.payerId = "quelquun_d_autre"; handle.fakeIntent!.status = "COMPLETED"; } },
    { kind: "source_mismatch", mutate: (_intent, handle) => { handle.fakeIntent!.sourceSystem = "AUTRE"; handle.fakeIntent!.status = "COMPLETED"; } },
    { kind: "status_mismatch", mutate: (_intent, handle) => { (handle.fakeIntent as { status: string }).status = "WEIRD"; } },
  ];
  for (const entry of cases) {
    const handle = await newHandle(5_000);
    entry.mutate({ amount: 5_000 }, handle);
    const result = await catchup(await later(handle.intent.id, 3));
    assert.ok(result.anomalies >= 1, entry.kind);
    assert.equal(await status(handle.intent.id), "pending", entry.kind);
    assert.deepEqual(await kindsOf(handle.intent.id), [entry.kind]);
    assert.equal((await state(handle.intent.id)).outcome, "anomaly");
  }
  // Identifiant Sublymus différent de celui de la session enregistrée.
  const swapped = await newHandle(5_000);
  api.intents.delete(swapped.fakeIntent!.id);
  api.seed({ externalReference: swapped.reference, amount: 5_000, status: "COMPLETED", id: "pi_une_autre_session" });
  await catchup(await later(swapped.intent.id, 3));
  assert.deepEqual(await kindsOf(swapped.intent.id), ["intent_id_mismatch"]);
  assert.equal(await status(swapped.intent.id), "pending");
  // Deux intentions exactes chez Sublymus pour la même référence : ambigu, rien n'est crédité.
  const twin = await newHandle(5_000);
  api.seed({ externalReference: twin.reference, amount: 5_000, status: "COMPLETED" });
  await catchup(await later(twin.intent.id, 3));
  assert.deepEqual(await kindsOf(twin.intent.id), ["duplicate_provider_intents"]);
  assert.equal(await status(twin.intent.id), "pending");
  for (const owner of owners) assert.equal(await balanceOf(env.pool, owner.userId), BigInt(0));
  // Le payeur reçu n'est jamais enregistré en clair.
  assert.ok(!JSON.stringify((await env.pool.query("SELECT * FROM sublymus_anomalies")).rows).includes("quelquun_d_autre"));
});

test("erreurs chez Sublymus : une clé refusée (401) arrête le passage sans marteler (les lignes gardent leur bail de 5 minutes) ; une erreur 5xx arrête aussi le passage, les autres intentions restent dues et sont reprises ensuite", async () => {
  await quiesce();
  const owner = await login(env.pool);
  const handles = [await newTopup(env.pool, api, envVars, owner.userId, 1_500), await newTopup(env.pool, api, envVars, owner.userId, 1_600), await newTopup(env.pool, api, envVars, owner.userId, 1_700)];
  const now = new Date(Math.max(...(await Promise.all(handles.map((handle) => later(handle.intent.id, 3)))).map((date) => date.getTime())));
  for (const handle of handles) api.setStatus(handle.fakeIntent!.id, "COMPLETED");
  const calls = api.requests.length;
  api.setMode("unauthorized");
  const refused = await catchup(now);
  assert.ok(refused.errors.includes("catchup_error_sublymus_auth"));
  assert.equal(api.requests.slice(calls).filter((entry) => entry.path.startsWith("/v1/intents")).length, 1, "un seul appel : on ne martèle pas une clé refusée");
  assert.equal(await balanceOf(env.pool, owner.userId), BigInt(0));
  api.setMode("ok");
  const immediate = await catchup(now);
  assert.equal(immediate.examined, 0, "le bail empêche de réessayer aussitôt");
  const resumed = new Date(now.getTime() + 6 * MINUTE);
  // Une erreur serveur (5xx) ARRÊTE le passage : une seule requête, la fautive a son attente croissante, les autres restent dues (réservation rendue) et passent au passage suivant.
  api.setMode("server_error", { times: 1 });
  const requestsBefore = api.requests.length;
  const stopped = await catchup(resumed);
  assert.ok(stopped.errors.includes("catchup_error_sublymus_server"));
  assert.equal(stopped.examined, 1, "un seul sondage avant l'arrêt");
  assert.equal(stopped.deferred, 2, "les deux autres ne sont pas examinées");
  assert.equal(stopped.completed, 0);
  assert.equal(api.requests.slice(requestsBefore).filter((entry) => entry.path.startsWith("/v1/intents")).length, 1, "pas d'insistance sur un Sublymus en panne");
  const due = (await env.pool.query<{ id: string; due: boolean; attempts: number; outcome: string | null }>(
    `SELECT intent_id AS id, next_catchup_at <= $2::timestamptz AS due, catchup_attempts AS attempts, last_catchup_outcome AS outcome
       FROM sublymus_checkouts WHERE intent_id = ANY($1::uuid[])`, [handles.map((handle) => handle.intent.id), resumed.toISOString()])).rows;
  assert.equal(due.filter((row) => row.due).length, 2, "les intentions non examinées restent dues");
  const erroring = due.find((row) => !row.due)!;
  assert.deepEqual([erroring.attempts, erroring.outcome], [1, "error"], "la fautive a son attente croissante");
  const second = await catchup(resumed);
  assert.equal(second.completed, 2, "les deux autres sont créditées au passage suivant");
  const third = await catchup(new Date(resumed.getTime() + 5 * MINUTE));
  assert.equal(third.completed, 1, "la fautive est reprise une fois son attente écoulée");
  assert.equal(await balanceOf(env.pool, owner.userId), BigInt(4_800), "1 500 + 1 600 + 1 700, chacune une seule fois");
  assert.equal(await countRows(env.pool, "wallet_transactions", "kind = 'topup' AND reference = ANY($1::text[])", [handles.map((handle) => `topup:${handle.intent.id}`)]), 3);
  assert.equal(erroring.id, (await env.pool.query<{ id: string }>("SELECT intent_id AS id FROM sublymus_checkouts WHERE intent_id = $1 AND last_catchup_outcome = 'completed'", [erroring.id])).rows[0].id);
});

test("Sublymus LENT : le passage s'arrête à la première erreur de délai (une seule requête), les autres intentions restent dues ; budget de temps épuisé : le reste est rendu, jamais perdu", async () => {
  api.setMode("ok");
  await quiesce();
  const owner = await login(env.pool);
  const handles = [await newTopup(env.pool, api, envVars, owner.userId, 2_100), await newTopup(env.pool, api, envVars, owner.userId, 2_200), await newTopup(env.pool, api, envVars, owner.userId, 2_300)];
  for (const handle of handles) api.setStatus(handle.fakeIntent!.id, "COMPLETED");
  const now = new Date(Math.max(...(await Promise.all(handles.map((handle) => later(handle.intent.id, 3)))).map((date) => date.getTime())));
  const ids = handles.map((handle) => handle.intent.id);
  const dueCount = async (at: Date): Promise<number> => (await env.pool.query<{ n: number }>("SELECT count(*)::int AS n FROM sublymus_checkouts WHERE intent_id = ANY($1::uuid[]) AND next_catchup_at <= $2::timestamptz", [ids, at.toISOString()])).rows[0].n;
  // Délai dépassé (appel borné à 250 ms, Sublymus répond en 1,5 s) : première erreur = arrêt.
  api.setMode("delay", { delayMs: 1_500 });
  const started = Date.now();
  const calls = api.requests.length;
  const slow = await catchup(now, 100, { client: client({ timeoutMs: 250 }) });
  assert.ok(Date.now() - started < 1_400, `le passage n'attend qu'un seul délai : ${Date.now() - started} ms`);
  assert.equal(api.requests.slice(calls).filter((entry) => entry.path.startsWith("/v1/intents")).length, 1, "une seule requête");
  assert.deepEqual(slow.errors, ["catchup_error_sublymus_timeout"]);
  assert.deepEqual([slow.examined, slow.deferred, slow.completed], [1, 2, 0]);
  assert.equal(await dueCount(now), 2, "les deux intentions non examinées restent dues");
  assert.equal(await balanceOf(env.pool, owner.userId), BigInt(0));
  // Réseau coupé : même arrêt. Limite de débit (429) : même arrêt.
  api.setMode("ok");
  const dropped = (async () => { throw new Error("réseau coupé"); }) as unknown as typeof fetch;
  const offline = await catchup(now, 100, { client: client({ fetch: dropped }) });
  assert.deepEqual([offline.examined, offline.deferred, offline.errors.length], [1, 1, 1]);
  assert.ok(offline.errors[0].startsWith("catchup_error_sublymus_network"));
  const limited = (async () => new Response("{}", { status: 429 })) as unknown as typeof fetch;
  const throttled = await catchup(now, 100, { client: client({ fetch: limited }) });
  assert.deepEqual([throttled.examined, throttled.deferred, throttled.errors], [1, 0, ["catchup_error_sublymus_rate_limited"]]);
  // Budget de temps : chaque réponse prend 300 ms, budget de 400 ms -> deux sondages, puis arrêt ; la troisième reste due.
  const owner2 = await login(env.pool);
  await quiesce();
  const slowHandles = [await newTopup(env.pool, api, envVars, owner2.userId, 3_100), await newTopup(env.pool, api, envVars, owner2.userId, 3_200), await newTopup(env.pool, api, envVars, owner2.userId, 3_300)];
  for (const handle of slowHandles) api.setStatus(handle.fakeIntent!.id, "COMPLETED");
  const budgetNow = new Date(Math.max(...(await Promise.all(slowHandles.map((handle) => later(handle.intent.id, 3)))).map((date) => date.getTime())));
  api.setMode("delay", { delayMs: 300 });
  const budgeted = await catchup(budgetNow, 100, { budgetMs: 400 });
  api.setMode("ok");
  assert.deepEqual([budgeted.examined, budgeted.completed, budgeted.deferred, budgeted.errors], [2, 2, 1, []]);
  const rest = await catchup(budgetNow);
  assert.deepEqual([rest.examined, rest.completed], [1, 1], "l'intention rendue est reprise au passage suivant");
  assert.equal(await balanceOf(env.pool, owner2.userId), BigInt(9_600));
  // Le budget lui-même est borné par le code (environ 20 s) et validé.
  await assert.rejects(catchup(budgetNow, 100, { budgetMs: 0 }), /budgetMs/);
});

test("doublons EXACTS chez Sublymus : l'identifiant enregistré désigne NOTRE session, jugée et créditée ; le doublon est journalisé (anomalie) sans bloquer le crédit ; sans identifiant enregistré, ambigu = rien n'est décidé", async () => {
  await quiesce();
  const owner = await login(env.pool);
  // Notre session est payée, un doublon (autre identifiant, même référence) existe : crédit + anomalie « doublons ».
  const paid = await newTopup(env.pool, api, envVars, owner.userId, 2_000);
  api.setStatus(paid.fakeIntent!.id, "COMPLETED");
  const twin = api.seed({ externalReference: paid.reference, amount: 2_000, status: "WAVE_CREATED" });
  const first = await catchup(await later(paid.intent.id, 3));
  assert.equal(first.completed, 1);
  assert.equal(await status(paid.intent.id), "succeeded");
  assert.equal(await balanceOf(env.pool, owner.userId), BigInt(2_000));
  assert.deepEqual(await kindsOf(paid.intent.id), ["duplicate_provider_intents"]);
  assert.equal((await state(paid.intent.id)).outcome, "completed");
  await catchup(await later(paid.intent.id, 70));
  assert.equal(await balanceOf(env.pool, owner.userId), BigInt(2_000), "jamais un second crédit");
  assert.equal(await countRows(env.pool, "sublymus_anomalies", "intent_id = $1", [paid.intent.id]), 1);
  // Le doublon payé, la nôtre en attente : on juge la NÔTRE (en attente), le doublon est journalisé, rien n'est crédité.
  const waiting = await newTopup(env.pool, api, envVars, owner.userId, 2_100);
  api.seed({ externalReference: waiting.reference, amount: 2_100, status: "COMPLETED" });
  const second = await catchup(await later(waiting.intent.id, 3));
  assert.deepEqual([second.completed, second.waiting], [0, 1]);
  assert.equal(await status(waiting.intent.id), "pending");
  assert.deepEqual(await kindsOf(waiting.intent.id), ["duplicate_provider_intents"]);
  // Aucun identifiant enregistré (la création a été interrompue) : on ne sait pas laquelle est la nôtre, anomalie et rien de décidé.
  const bare = await createTopupIntent({ pool: env.pool, ownerId: owner.userId, amountXof: BigInt(2_200), idempotencyKey: "00000000-0000-4000-8000-0000000000aa", provider: providerOf(envVars) });
  api.seed({ externalReference: bare.intent.providerReference, amount: 2_200, status: "COMPLETED" });
  api.seed({ externalReference: bare.intent.providerReference, amount: 2_200, status: "COMPLETED" });
  const third = await catchup(await later(bare.intent.id, 3));
  assert.equal(third.completed, 0);
  assert.equal(await status(bare.intent.id), "pending");
  assert.deepEqual(await kindsOf(bare.intent.id), ["duplicate_provider_intents"]);
  assert.equal(twin.externalReference, paid.reference);
  assert.deepEqual((await checkWalletIntegrity(env.pool)).violations, []);
});

test("course rattrapage / webhook : un webhook qui crédite PENDANT le sondage (qui voit encore « en attente ») ne provoque aucune erreur ; la session reste terminée, jamais ré-ouverte ni régressée", async () => {
  await quiesce();
  const owner = await login(env.pool);
  const handle = await newTopup(env.pool, api, envVars, owner.userId, 2_500);
  const created = await createdAt(handle.intent.id);
  let delivered = false;
  const stub = (async (input: string, init?: RequestInit) => {
    const answer = await fetch(input, init); // la fausse API répond WAVE_CREATED : lu AVANT le paiement
    if (!delivered && String(input).includes("/v1/intents")) {
      delivered = true;
      const signed = api.webhook({ intent: handle.fakeIntent!, secret: TEST_WEBHOOK_SECRET });
      assert.equal((await reply(await handlers.sublymus.webhook(webhookRequest(signed)))).status, 200);
    }
    return answer;
  }) as unknown as typeof fetch;
  const result = await catchup(new Date(created.getTime() + 3 * MINUTE), 100, { client: client({ fetch: stub }) });
  assert.deepEqual(result.errors, [], "plus d'erreur 23514 : la course est absorbée");
  assert.equal(result.examined, 1);
  assert.equal(await status(handle.intent.id), "succeeded");
  assert.equal(await topupTransactions(env.pool, handle.intent.id), 1);
  assert.equal(await balanceOf(env.pool, owner.userId), BigInt(2_500));
  const session = await state(handle.intent.id);
  assert.deepEqual([session.provider_status, session.outcome, session.next, session.done], ["COMPLETED", "completed", null, true], "terminée par le webhook, rien n'est écrasé par un sondage qui avait vu « en attente »");
  assert.ok(session.attempts >= 1);
  assert.deepEqual((await checkWalletIntegrity(env.pool)).violations, []);
  // Idem quand le sondage voit une ANOMALIE pendant que le webhook crédite.
  const other = await newTopup(env.pool, api, envVars, owner.userId, 2_600);
  other.fakeIntent!.amount = 2_601;
  let again = false;
  const racing = (async (input: string, init?: RequestInit) => {
    const answer = await fetch(input, init);
    if (!again && String(input).includes("/v1/intents")) {
      again = true;
      other.fakeIntent!.amount = 2_600;
      assert.equal((await reply(await handlers.sublymus.webhook(webhookRequest(api.webhook({ intent: other.fakeIntent!, secret: TEST_WEBHOOK_SECRET }))))).status, 200);
    }
    return answer;
  }) as unknown as typeof fetch;
  const resultAnomaly = await catchup(await later(other.intent.id, 3), 100, { client: client({ fetch: racing }) });
  assert.deepEqual(resultAnomaly.errors, []);
  assert.equal(await status(other.intent.id), "succeeded");
  assert.deepEqual([(await state(other.intent.id)).next, (await state(other.intent.id)).outcome], [null, "completed"]);
});

// ═════════════ 5. Étape du worker ═════════════

test("étape du worker (runMatchingCycle) : isolée, ignorée avec le prestataire fictif, crédite avec Sublymus ; une panne de Sublymus n'empêche aucune autre étape", async () => {
  await quiesce();
  const owner = await login(env.pool);
  const handle = await newTopup(env.pool, api, envVars, owner.userId, 2_200);
  api.setStatus(handle.fakeIntent!.id, "COMPLETED");
  const now = await later(handle.intent.id, 3);
  const fakeProvider = await runMatchingCycle({ pool: env.pool, workerId: "worker-pay1-fake", paymentCatchup: { env: { NODE_ENV: "test" }, now } });
  assert.equal(fakeProvider.paymentCatchup.skipped, true);
  assert.equal(await status(handle.intent.id), "pending");
  const misconfigured = await runMatchingCycle({ pool: env.pool, workerId: "worker-pay1-bad", paymentCatchup: { env: { ...envVars, WAVE_API_KEY: "" }, now } });
  assert.equal(misconfigured.paymentCatchup.skipped, true);
  assert.ok(misconfigured.errors.includes("catchup_error_provider_config"));
  assert.equal(await status(handle.intent.id), "pending");
  const real = await runMatchingCycle({ pool: env.pool, workerId: "worker-pay1-real", paymentCatchup: { env: envVars, now } });
  assert.equal(real.paymentCatchup.completed >= 1, true);
  assert.equal(real.idle, false, "un cycle qui a rattrapé n'est pas au repos");
  assert.equal(await status(handle.intent.id), "succeeded");
  assert.equal(await balanceOf(env.pool, owner.userId), BigInt(2_200));
  // Sublymus injoignable : le cycle rend ses autres étapes, l'erreur est un code stable.
  const broken = await newTopup(env.pool, api, envVars, owner.userId, 2_300);
  const failingFetch = (async () => { throw new Error("réseau coupé"); }) as unknown as typeof fetch;
  const cycle = await runMatchingCycle({ pool: env.pool, workerId: "worker-pay1-net", paymentCatchup: { env: envVars, fetch: failingFetch, now: await later(broken.intent.id, 3) } });
  assert.ok(cycle.errors.some((code) => code.startsWith("catchup_error_")), cycle.errors.join(","));
  assert.ok(cycle.errors.every((code) => /^[a-z]+_error_[a-z0-9_]+$/.test(code)));
  assert.equal(Array.isArray(cycle.jobs) && typeof cycle.notify === "object" && typeof cycle.subscriptions === "object", true, "les autres étapes ont rendu leur résultat");
  assert.equal(await status(broken.intent.id), "pending");
  // Une erreur INATTENDUE de l'étape elle-même (horloge illisible) n'emporte jamais le cycle : elle devient un code stable et les autres étapes rendent leur résultat.
  const unexpected = await runMatchingCycle({ pool: env.pool, workerId: "worker-pay1-clock", paymentCatchup: { env: envVars, now: new Date(Number.NaN) } });
  assert.ok(unexpected.errors.some((code) => code.startsWith("catchup_error_")), unexpected.errors.join(","));
  assert.ok(unexpected.errors.every((code) => /^[a-z]+_error_[a-z0-9_]+$/.test(code)));
  assert.equal(typeof unexpected.notify, "object");
  assert.equal(typeof unexpected.subscriptions, "object");
});

// ═════════════ 6. Lot PAY1-ter (N4) : les intentions ÉCHOUÉES restent sondées ═════════════

const eventsOf = async (intentId: string): Promise<Array<{ type: string; outcome: string }>> =>
  (await env.pool.query<{ type: string; outcome: string }>("SELECT type, outcome FROM payment_events WHERE intent_id = $1 ORDER BY received_at, id", [intentId])).rows;

test("N4 — échec par WEBHOOK : la session n'est pas fermée, elle reste sondée avec une attente doublée (4, 8, 16, 32 minutes, plafond 1 heure) ; fermée seulement à la fin des 24 h, l'issue « failed » restant lisible", async () => {
  await quiesce();
  const owner = await login(env.pool);
  const handle = await newTopup(env.pool, api, envVars, owner.userId, 2_000);
  const failedHook = api.webhook({ intent: handle.fakeIntent!, event: "payment.failed", secret: TEST_WEBHOOK_SECRET, webhookId: "wh_n4_failed_01" });
  assert.equal((await handlers.sublymus.webhook(webhookRequest(failedHook)).then(reply)).status, 200);
  assert.equal(await status(handle.intent.id), "failed");
  const afterHook = await state(handle.intent.id);
  assert.deepEqual([afterHook.done, afterHook.next !== null, afterHook.provider_status, afterHook.outcome], [false, true, "FAILED", "failed"], "le webhook d'échec ne ferme plus la session");
  // Sublymus répond FAILED : chaque passage échu fait une tentative, l'attente double.
  api.setStatus(handle.fakeIntent!.id, "FAILED");
  const start = await createdAt(handle.intent.id);
  let now = new Date(start.getTime() + 3 * MINUTE);
  for (const expected of [4, 8, 16, 32, 60, 60]) {
    const result = await catchup(now);
    assert.ok(result.examined >= 1, `un passage examine la session échouée (attente ${expected} min)`);
    const after = await state(handle.intent.id);
    assert.deepEqual([after.done, after.outcome], [false, "failed"]);
    assert.equal(after.next!.getTime() - now.getTime(), expected * MINUTE, `attente de ${expected} minutes`);
    assert.equal(await status(handle.intent.id), "failed");
    now = new Date(after.next!.getTime() + 1_000);
  }
  assert.equal(await balanceOf(env.pool, owner.userId), BigInt(0), "FAILED chez Sublymus : rien n'est crédité");
  // On continue de sonder à chaque échéance (toutes les heures) : la fenêtre de 24 h se referme PAR LE SONDAGE LUI-MÊME dès que la prochaine tentative la dépasserait, l'issue « failed » restant lisible.
  let polls = 0;
  while (!(await state(handle.intent.id)).done && polls < 40) {
    polls += 1;
    now = new Date((await state(handle.intent.id)).next!.getTime() + 1_000);
    await catchup(now);
    assert.equal(await status(handle.intent.id), "failed");
  }
  const closed = await state(handle.intent.id);
  assert.deepEqual([closed.done, closed.next, closed.outcome, closed.provider_status], [true, null, "failed", "FAILED"], "fenêtre refermée par le dernier sondage : l'issue « failed » n'est pas écrasée");
  assert.ok(now.getTime() <= start.getTime() + 24 * HOUR, "le dernier sondage a lieu dans les 24 h");
  assert.ok(polls >= 20 && polls <= 30, `une vingtaine de sondages horaires après la rampe de doublement (${polls})`);
  // Plus aucune requête ensuite, même bien après les 24 h.
  const requestsBefore = api.requests.length;
  await catchup(new Date(start.getTime() + 25 * HOUR));
  assert.equal(api.requests.slice(requestsBefore).filter((entry) => entry.path.includes(handle.reference)).length, 0, "aucune requête après les 24 h");
  assert.equal(await balanceOf(env.pool, owner.userId), BigInt(0));
});

test("N4 — échec par webhook, puis paiement RÉUSSI chez Wave dont le webhook est PERDU : le rattrapage voit COMPLETED et crédite UNE fois (anomalie state_conflict), aucun second crédit aux passages suivants", async () => {
  await quiesce();
  const owner = await login(env.pool);
  const handle = await newTopup(env.pool, api, envVars, owner.userId, 2_000);
  const failedHook = api.webhook({ intent: handle.fakeIntent!, event: "payment.failed", secret: TEST_WEBHOOK_SECRET, webhookId: "wh_n4_failed_02" });
  assert.equal((await handlers.sublymus.webhook(webhookRequest(failedHook)).then(reply)).status, 200);
  assert.equal(await status(handle.intent.id), "failed");
  api.setStatus(handle.fakeIntent!.id, "COMPLETED");
  const start = await createdAt(handle.intent.id);
  const passes: number[] = [];
  for (const minutes of [3, 30, 120, 600]) passes.push((await catchup(new Date(start.getTime() + minutes * MINUTE))).examined);
  assert.ok(passes[0] >= 1, "le premier passage échu examine l'intention échouée");
  assert.equal(await status(handle.intent.id), "succeeded", "l'argent a été pris : la recharge est créditée");
  assert.equal(await balanceOf(env.pool, owner.userId), BigInt(2_000));
  assert.equal(await topupTransactions(env.pool, handle.intent.id), 1, "UN seul crédit");
  assert.deepEqual(await kindsOf(handle.intent.id), ["state_conflict"], "le conflit d'état est journalisé");
  const after = await state(handle.intent.id);
  assert.deepEqual([after.done, after.next, after.outcome, after.provider_status], [true, null, "completed", "COMPLETED"]);
  assert.deepEqual(passes.slice(1), [0, 0, 0], "les passages suivants n'examinent plus rien");
  assert.deepEqual((await eventsOf(handle.intent.id)).map((row) => `${row.type}:${row.outcome}`), ["payment.failed:applied", "payment.succeeded:applied"]);
  const anomalyRows = await env.pool.query("SELECT kind, origin FROM sublymus_anomalies WHERE intent_id = $1", [handle.intent.id]);
  assert.deepEqual(anomalyRows.rows, [{ kind: "state_conflict", origin: "catchup" }]);
  assert.deepEqual((await checkWalletIntegrity(env.pool)).violations, [], "wallet:check ne signale rien");
});

test("N4 — échec lu par le RATTRAPAGE lui-même (FAILED) : l'intention échoue mais reste sondée ; COMPLETED plus tard est crédité une fois ; deux passages simultanés ne créditent pas deux fois", async () => {
  await quiesce();
  const owner = await login(env.pool);
  const handle = await newTopup(env.pool, api, envVars, owner.userId, 3_300);
  api.setStatus(handle.fakeIntent!.id, "FAILED");
  const first = await later(handle.intent.id, 3);
  assert.ok((await catchup(first)).failed >= 1);
  assert.equal(await status(handle.intent.id), "failed");
  const failedState = await state(handle.intent.id);
  assert.deepEqual([failedState.done, failedState.next !== null, failedState.attempts], [false, true, 1]);
  // Un second passage échu relit FAILED : rien ne change (événement déjà enregistré), l'attente double encore.
  assert.ok((await catchup(new Date(failedState.next!.getTime() + 1_000))).examined >= 1);
  assert.equal(await status(handle.intent.id), "failed");
  assert.equal((await state(handle.intent.id)).attempts, 2);
  // Le paiement aboutit finalement chez Wave : DEUX passages simultanés, un seul crédit.
  api.setStatus(handle.fakeIntent!.id, "COMPLETED");
  const due = new Date((await state(handle.intent.id)).next!.getTime() + 1_000);
  await Promise.all([catchup(due), catchup(due)]);
  assert.equal(await status(handle.intent.id), "succeeded");
  assert.equal(await topupTransactions(env.pool, handle.intent.id), 1, "jamais deux crédits");
  assert.equal(await balanceOf(env.pool, owner.userId), BigInt(3_300));
  assert.deepEqual(await kindsOf(handle.intent.id), ["state_conflict"]);
  await catchup(new Date(due.getTime() + 2 * HOUR));
  assert.equal(await topupTransactions(env.pool, handle.intent.id), 1);
  assert.deepEqual((await checkWalletIntegrity(env.pool)).violations, []);
});

test("N4 — intention EXPIRÉE lue FAILED : elle reste sondée (statut inchangé) ; COMPLETED la crédite une fois (paiement tardif, sans conflit d'état : elle n'était pas échouée)", async () => {
  await quiesce();
  const owner = await login(env.pool);
  const handle = await newTopup(env.pool, api, envVars, owner.userId, 1_700);
  await env.pool.query("UPDATE payment_intents SET status = 'expired', completed_at = clock_timestamp() WHERE id = $1", [handle.intent.id]);
  api.setStatus(handle.fakeIntent!.id, "FAILED");
  assert.ok((await catchup(await later(handle.intent.id, 3))).failed >= 1);
  assert.equal(await status(handle.intent.id), "expired", "une intention expirée n'est pas déclarée échouée");
  const stillPolled = await state(handle.intent.id);
  assert.deepEqual([stillPolled.done, stillPolled.next !== null, stillPolled.outcome], [false, true, "failed"], "elle reste sondée");
  assert.deepEqual(await eventsOf(handle.intent.id), [{ type: "payment.failed", outcome: "rejected_state" }]);
  api.setStatus(handle.fakeIntent!.id, "COMPLETED");
  assert.ok((await catchup(new Date(stillPolled.next!.getTime() + 1_000))).completed >= 1);
  assert.equal(await status(handle.intent.id), "succeeded");
  assert.equal(await topupTransactions(env.pool, handle.intent.id), 1);
  assert.equal(await balanceOf(env.pool, owner.userId), BigInt(1_700));
  assert.deepEqual(await kindsOf(handle.intent.id), []);
});

test("N4 — passé 24 h après la création, une intention échouée n'est plus sondée même si Sublymus dit COMPLETED (aucune requête, aucun crédit)", async () => {
  await quiesce();
  const owner = await login(env.pool);
  const handle = await newTopup(env.pool, api, envVars, owner.userId, 1_900);
  const failedHook = api.webhook({ intent: handle.fakeIntent!, event: "payment.failed", secret: TEST_WEBHOOK_SECRET, webhookId: "wh_n4_failed_03" });
  assert.equal((await handlers.sublymus.webhook(webhookRequest(failedHook)).then(reply)).status, 200);
  api.setStatus(handle.fakeIntent!.id, "COMPLETED");
  const requestsBefore = api.requests.length;
  const result = await catchup(await later(handle.intent.id, 25 * 60));
  assert.ok(result.windowClosed >= 1);
  assert.equal(api.requests.slice(requestsBefore).filter((entry) => entry.path.includes(handle.reference)).length, 0);
  assert.equal(await status(handle.intent.id), "failed");
  assert.equal(await balanceOf(env.pool, owner.userId), BigInt(0));
});

test("N4 — wallet:check signale une session échouée dont le rattrapage est en retard de plus de 15 minutes (comme pour les autres intentions sondées)", async () => {
  await quiesce();
  const owner = await login(env.pool);
  const handle = await newTopup(env.pool, api, envVars, owner.userId, 1_100);
  const failedHook = api.webhook({ intent: handle.fakeIntent!, event: "payment.failed", secret: TEST_WEBHOOK_SECRET, webhookId: "wh_n4_failed_04" });
  assert.equal((await handlers.sublymus.webhook(webhookRequest(failedHook)).then(reply)).status, 200);
  await env.pool.query("UPDATE sublymus_checkouts SET next_catchup_at = clock_timestamp() - interval '20 minutes' WHERE intent_id = $1", [handle.intent.id]);
  const report = await checkWalletIntegrity(env.pool);
  const overdue = [...report.violations, ...report.warnings].filter((entry) => entry.code === "sublymus_catchup_overdue");
  assert.ok(overdue.length >= 1 && overdue[0].examples.some((example) => example.intent_id === handle.intent.id), "le retard d'une session échouée est signalé");
});

// ═════════════ 7. Lot PAY1-ter (N7) : identifiants Sublymus avec « . » et « : » ═════════════

for (const sublymusId of ["pi.abc123", "pi:abc123"]) {
  test(`N7 — identifiant Sublymus « ${sublymusId} » : le rattrapage enregistre l'identifiant (la contrainte de la base l'accepte) et crédite une fois`, async () => {
    await quiesce();
    const owner = await login(env.pool);
    // Intention dont la création de session a été interrompue : l'identifiant Sublymus n'est connu de noma que par la lecture du rattrapage.
    const created = await createTopupIntent({ pool: env.pool, ownerId: owner.userId, amountXof: BigInt(1_000), idempotencyKey: crypto.randomUUID(), provider: providerOf(envVars) });
    api.seed({ id: sublymusId, externalReference: created.intent.providerReference, amount: 1_000, status: "COMPLETED" });
    const result = await catchup(await later(created.intent.id, 3));
    assert.deepEqual(result.errors, []);
    assert.equal(await status(created.intent.id), "succeeded");
    assert.equal(await topupTransactions(env.pool, created.intent.id), 1);
    assert.equal(await balanceOf(env.pool, owner.userId), BigInt(1_000));
    assert.equal((await env.pool.query<{ id: string }>("SELECT sublymus_intent_id AS id FROM sublymus_checkouts WHERE intent_id = $1", [created.intent.id])).rows[0].id, sublymusId);
    assert.deepEqual(await kindsOf(created.intent.id), []);
    api.intents.delete(sublymusId);
  });
}
