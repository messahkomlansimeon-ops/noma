import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import type { PoolClient } from "pg";
import { checkWalletIntegrity } from "../../lib/server/wallet/check";
import { createWalletHttpHandlers, type WalletHttpHandlers } from "../../lib/server/wallet/http";
import { applyProviderEvent, createTopupIntent } from "../../lib/server/wallet/topups";
import { SublymusApiError, SublymusClient } from "../../lib/server/wallet/sublymus/client";
import type { FakeSublymusApi } from "../../scripts/sublymus-fake-api";
import {
  TEST_API_KEY, TEST_MANAGER_ID, TEST_WALLET_ID, TEST_WEBHOOK_SECRET, balanceOf, countRows, newTopup, providerOf, startApi, sublymusEnv, topupTransactions, webhookRequest, type Env,
} from "./sublymus-fixtures";
import { login, openTestSchema, reply, request, type Reply, type TestSchema } from "./social-fixtures";

/**
 * Lot PAY1 : création de la session de paiement Wave (contre la FAUSSE API locale : aucun appel réel), reprise, erreurs, limite de débit, retour du navigateur sans crédit,
 * DTO, routes fictives, contrôle `wallet:check` du paiement Sublymus.
 */

let env: TestSchema;
let api: FakeSublymusApi;
let envVars: Env;
let handlers: WalletHttpHandlers;
const logs: string[] = [];
const consoleLines: string[] = [];
const realConsole = { error: console.error, log: console.log, warn: console.warn };

before(async () => {
  env = await openTestSchema(12);
  api = await startApi();
  envVars = sublymusEnv(api);
  handlers = createWalletHttpHandlers({ pool: env.pool, env: envVars, log: (code) => { logs.push(code); } });
  // Tout ce que le serveur écrirait dans la console pendant ces essais est relevé : la clé et le secret n'y figurent jamais.
  for (const name of ["error", "log", "warn"] as const) console[name] = (...args: unknown[]) => { consoleLines.push(args.map(String).join(" ")); };
});

after(async () => {
  console.error = realConsole.error;
  console.log = realConsole.log;
  console.warn = realConsole.warn;
  await api.close();
  await env.close();
});

type Json = Record<string, unknown>;
const obj = (value: unknown): Json => value as Json;
const topupOf = (answer: Reply): Json => obj(obj(answer.json).topup);
const create = (cookie: string | null, body: unknown, origin?: string | null) => handlers.topups.create(request("POST", "/api/wallet/topups", { cookie, body, origin })).then(reply);
const read = (cookie: string | null, id: string) => handlers.topups.get(request("GET", `/api/wallet/topups/${id}`, { cookie }), id).then(reply);
const walletOf = (cookie: string) => handlers.wallet.get(request("GET", "/api/wallet", { cookie })).then(reply);
const posts = (): Array<Json> => api.requests.filter((entry) => entry.method === "POST" && entry.path === "/v1/checkout/complex").map((entry) => obj(entry.body));

// ═════════════ 1. Création de la session ═════════════

test("création : splits dont la somme vaut EXACTEMENT le montant, référence stable noma-topup-<intention>, en-têtes d'authentification, adresses de retour en https, DTO en liste blanche", async () => {
  const user = await login(env.pool);
  const key = randomUUID();
  const before = posts().length;
  const first = await create(user.cookie, { amountXof: 5_000, idempotencyKey: key });
  assert.equal(first.status, 201);
  const topup = topupOf(first);
  assert.deepEqual(Object.keys(topup).sort(), ["amountXof", "checkoutPath", "checkoutUrl", "expiresAt", "id", "provider", "status"]);
  assert.equal(topup.provider, "sublymus");
  assert.equal(topup.status, "pending");
  assert.equal(topup.checkoutPath, `/paiement-retour/${topup.id}`);
  assert.equal(posts().length, before + 1, "une seule session ouverte");
  const sent = api.requests.filter((entry) => entry.method === "POST" && entry.path === "/v1/checkout/complex").at(-1)!;
  assert.equal(sent.authorization, `Bearer ${TEST_API_KEY}`);
  assert.equal(sent.managerId, TEST_MANAGER_ID);
  const body = obj(sent.body);
  assert.equal(body.amount, 5_000);
  assert.equal(body.currency, "XOF");
  assert.equal(body.external_reference, `noma-topup-${topup.id}`, "référence stable dérivée de l'intention");
  assert.equal(body.source_system, "NOMA");
  assert.equal(typeof body.description, "string");
  assert.equal(body.success_url, `https://noma.test/paiement-retour/${topup.id}?resultat=succes`);
  assert.equal(body.error_url, `https://noma.test/paiement-retour/${topup.id}?resultat=echec`);
  const splits = body.splits as Array<Json>;
  assert.equal(splits.length, 1);
  assert.deepEqual(splits[0], { wallet_id: TEST_WALLET_ID, amount: 5_000, category: "PAYMENT", label: splits[0].label, release_delay_hours: 0 });
  assert.equal(splits.reduce((sum, split) => sum + Number(split.amount), 0), body.amount, "somme des splits = montant, exactement");
  assert.deepEqual(Object.keys(body).sort(), ["amount", "currency", "description", "error_url", "external_reference", "source_system", "splits", "success_url"]);

  // La session est enregistrée, et le lien est celui que Sublymus a renvoyé.
  const fake = [...api.intents.values()].find((entry) => entry.externalReference === `noma-topup-${topup.id}`)!;
  assert.equal(topup.checkoutUrl, fake.waveCheckoutUrl);
  const row = (await env.pool.query<{ url: string; sub: string; status: string; ref: string; provider: string; due: boolean }>(
    `SELECT c.checkout_url AS url, c.sublymus_intent_id AS sub, c.provider_status AS status, c.external_reference AS ref, p.provider,
            (c.next_catchup_at = p.created_at + interval '2 minutes') AS due
       FROM sublymus_checkouts c JOIN payment_intents p ON p.id = c.intent_id WHERE c.intent_id = $1`, [topup.id])).rows[0];
  assert.deepEqual(row, { url: fake.waveCheckoutUrl, sub: fake.id, status: "WAVE_CREATED", ref: `noma-topup-${topup.id}`, provider: "sublymus", due: true });
  // Aucune donnée interne dans la réponse : ni référence, ni clé d'idempotence, ni propriétaire, ni clé d'API.
  for (const secret of [`noma-topup-${topup.id}`, key, user.userId, TEST_API_KEY, TEST_WEBHOOK_SECRET, "owner"]) assert.ok(!first.text.includes(secret), `fuite : ${secret}`);
  assert.equal(await balanceOf(env.pool, user.userId), BigInt(0), "créer une recharge ne crédite rien");
});

test("reprise : la même clé renvoie la même session sans second appel à Sublymus ; après un échec de création, la reprise rouvre la session avec la MÊME référence et le MÊME montant", async () => {
  const user = await login(env.pool);
  const key = randomUUID();
  const first = await create(user.cookie, { amountXof: 3_000, idempotencyKey: key });
  const count = posts().length;
  const replay = await create(user.cookie, { amountXof: 3_000, idempotencyKey: key });
  assert.equal(replay.status, 200);
  assert.equal(topupOf(replay).id, topupOf(first).id);
  assert.equal(topupOf(replay).checkoutUrl, topupOf(first).checkoutUrl);
  assert.equal(posts().length, count, "aucune seconde session : le lien enregistré est servi");
  // Même clé, autre montant : refusé, sans appel.
  assert.equal((await create(user.cookie, { amountXof: 4_000, idempotencyKey: key })).status, 409);
  assert.equal(posts().length, count);

  // Échec de la création chez Sublymus : l'intention reste en attente, sans lien ; la reprise (même clé) ouvre la session.
  const other = await login(env.pool);
  const retryKey = randomUUID();
  api.setMode("server_error", { times: 1 });
  const failed = await create(other.cookie, { amountXof: 2_500, idempotencyKey: retryKey });
  assert.equal(failed.status, 503);
  assert.deepEqual(obj(failed.json), { error: { code: "payment_unavailable", message: "Le paiement est temporairement indisponible." } });
  const pending = (await env.pool.query<{ id: string; url: string | null }>(
    "SELECT p.id, c.checkout_url AS url FROM payment_intents p JOIN sublymus_checkouts c ON c.intent_id = p.id WHERE p.owner_id = $1", [other.userId])).rows;
  assert.equal(pending.length, 1, "l'intention existe (en attente)");
  assert.equal(pending[0].url, null, "sans lien");
  const retried = await create(other.cookie, { amountXof: 2_500, idempotencyKey: retryKey });
  assert.equal(retried.status, 200, "intention retrouvée");
  assert.equal(topupOf(retried).id, pending[0].id);
  assert.match(String(topupOf(retried).checkoutUrl), /^https:\/\/pay\.wave\.example\/c\/pi_/);
  const bodies = posts().filter((entry) => entry.external_reference === `noma-topup-${pending[0].id}`);
  assert.equal(bodies.length, 2, "deux appels : l'échec et la reprise");
  assert.deepEqual([bodies[0].amount, bodies[0].external_reference], [bodies[1].amount, bodies[1].external_reference], "même référence, même montant à la reprise");
  assert.equal(await balanceOf(env.pool, other.userId), BigInt(0));
});

test("référence déjà connue chez Sublymus : jamais réutilisée avec un autre montant (refus), reprise adoptée seulement si montant, devise et statut correspondent", async () => {
  const user = await login(env.pool);
  const key = randomUUID();
  // Première tentative en échec : l'intention existe, la session n'est pas ouverte.
  api.setMode("server_error", { times: 1 });
  assert.equal((await create(user.cookie, { amountXof: 6_000, idempotencyKey: key })).status, 503);
  const intentId = (await env.pool.query<{ id: string }>("SELECT id FROM payment_intents WHERE owner_id = $1", [user.userId])).rows[0].id;
  // Sublymus connaît déjà cette référence, mais pour un AUTRE montant : conflit, aucune session adoptée.
  const seeded = api.seed({ externalReference: `noma-topup-${intentId}`, amount: 9_999 });
  const conflict = await create(user.cookie, { amountXof: 6_000, idempotencyKey: key });
  assert.equal(conflict.status, 503);
  assert.ok(logs.includes("sublymus_conflict"));
  assert.equal((await env.pool.query("SELECT checkout_url FROM sublymus_checkouts WHERE intent_id = $1", [intentId])).rows[0].checkout_url, null);
  for (const body of posts().filter((entry) => entry.external_reference === `noma-topup-${intentId}`)) assert.equal(body.amount, 6_000, "jamais un autre montant pour cette référence");
  // Sublymus connaît la référence avec le BON montant et une session en attente : la reprise l'adopte (même lien).
  api.intents.delete(seeded.id);
  const adoptable = api.seed({ externalReference: `noma-topup-${intentId}`, amount: 6_000 });
  api.setMode("conflict", { times: 1 });
  const adopted = await create(user.cookie, { amountXof: 6_000, idempotencyKey: key });
  assert.equal(adopted.status, 200);
  assert.equal(topupOf(adopted).checkoutUrl, adoptable.waveCheckoutUrl);
  assert.equal((await env.pool.query("SELECT sublymus_intent_id AS id FROM sublymus_checkouts WHERE intent_id = $1", [intentId])).rows[0].id, adoptable.id);
});

test("erreurs de Sublymus (401, 409, 422, 500, réponse illisible) : 503 à texte fixe, l'intention reste en attente, un code dans le journal, jamais la clé ni la réponse", async () => {
  const cases: Array<{ mode: Parameters<FakeSublymusApi["setMode"]>[0]; code: string }> = [
    { mode: "unauthorized", code: "sublymus_auth" }, { mode: "conflict", code: "sublymus_conflict" }, { mode: "unprocessable", code: "sublymus_validation" },
    { mode: "server_error", code: "sublymus_server" }, { mode: "bad_body", code: "sublymus_invalid_response" },
  ];
  for (const entry of cases) {
    const user = await login(env.pool);
    api.setMode(entry.mode, { times: 1 });
    const before = logs.length;
    const answer = await create(user.cookie, { amountXof: 1_000, idempotencyKey: randomUUID() });
    assert.equal(answer.status, 503, entry.mode);
    assert.deepEqual(obj(answer.json), { error: { code: "payment_unavailable", message: "Le paiement est temporairement indisponible." } });
    assert.ok(logs.slice(before).includes(entry.code), `${entry.mode} : ${logs.slice(before).join(",")}`);
    assert.equal(await countRows(env.pool, "payment_intents", "owner_id = $1 AND status = 'pending'", [user.userId]), 1);
    assert.ok(!answer.text.includes(TEST_API_KEY));
  }
  // Délai dépassé : le client abandonne (délai court demandé) et ne confond jamais l'attente avec un succès.
  const slow = new SublymusClient({ apiKey: TEST_API_KEY, managerId: TEST_MANAGER_ID, walletId: TEST_WALLET_ID, baseUrl: api.url }, { timeoutMs: 120 });
  api.setMode("delay", { times: 1, delayMs: 600 });
  await assert.rejects(slow.findIntents("noma-topup-x"), (error: unknown) => error instanceof SublymusApiError && error.kind === "timeout" && !String(error.message).includes(TEST_API_KEY));
  // Aucune clé ni secret n'a jamais été écrit dans la console du serveur ni dans le journal.
  for (const line of [...consoleLines, ...logs]) {
    assert.ok(!line.includes(TEST_API_KEY) && !line.includes(TEST_WEBHOOK_SECRET), `fuite dans le journal : ${line.slice(0, 60)}`);
  }
});

test("clé refusée (401) : l'erreur ne contient jamais la clé, même dans son texte", async () => {
  const wrong = new SublymusClient({ apiKey: "mauvaise_cle_de_test", managerId: TEST_MANAGER_ID, walletId: TEST_WALLET_ID, baseUrl: api.url });
  await assert.rejects(wrong.findIntents("noma-topup-x"), (error: unknown) => {
    assert.ok(error instanceof SublymusApiError);
    assert.equal(error.kind, "auth");
    assert.ok(!JSON.stringify({ message: error.message, stack: error.stack ?? "" }).includes("mauvaise_cle_de_test"));
    return true;
  });
});

test("double clic SIMULTANÉ : une seule intention, une seule session retenue, le même lien pour tous ; même si Sublymus ouvrait deux sessions, le lien enregistré est unique et seule SA session est créditée", async () => {
  const user = await login(env.pool);
  const key = randomUUID();
  const pools = Array.from({ length: 6 }, () => env.extraPool(2));
  const farm = pools.map((pool) => createWalletHttpHandlers({ pool, env: envVars, log: (code) => { logs.push(code); } }));
  const answers = await Promise.all(farm.map((entry) => entry.topups.create(request("POST", "/api/wallet/topups", { cookie: user.cookie, body: { amountXof: 8_000, idempotencyKey: key } })).then(reply)));
  assert.ok(answers.every((answer) => answer.status === 200 || answer.status === 201), answers.map((answer) => answer.status).join(","));
  assert.equal(answers.filter((answer) => answer.status === 201).length, 1, "une seule intention créée");
  const ids = new Set(answers.map((answer) => topupOf(answer).id));
  const urls = new Set(answers.map((answer) => topupOf(answer).checkoutUrl));
  assert.equal(ids.size, 1);
  assert.equal(urls.size, 1, "le même lien pour tous");
  assert.equal(await countRows(env.pool, "payment_intents", "owner_id = $1", [user.userId]), 1);
  // Un fournisseur qui n'est pas idempotent (cas dégradé) : plusieurs sessions chez lui, UNE seule enregistrée chez nous ; le paiement de l'autre session est une anomalie, jamais un crédit.
  const loose = await startApi({ reuseSession: false });
  try {
    const looseEnv = sublymusEnv(loose);
    const other = await login(env.pool);
    const handlersLoose = Array.from({ length: 4 }, () => createWalletHttpHandlers({ pool: env.extraPool(2), env: looseEnv, log: (code) => { logs.push(code); } }));
    const key2 = randomUUID();
    const replies = await Promise.all(handlersLoose.map((entry) => entry.topups.create(request("POST", "/api/wallet/topups", { cookie: other.cookie, body: { amountXof: 4_000, idempotencyKey: key2 } })).then(reply)));
    assert.ok(replies.every((answer) => answer.status === 200 || answer.status === 201));
    assert.equal(new Set(replies.map((answer) => topupOf(answer).checkoutUrl)).size, 1, "un seul lien enregistré pour l'intention");
    const intentId = String(topupOf(replies[0]).id);
    const sessions = [...loose.intents.values()].filter((entry) => entry.externalReference === `noma-topup-${intentId}`);
    const stored = (await env.pool.query<{ sub: string }>("SELECT sublymus_intent_id AS sub FROM sublymus_checkouts WHERE intent_id = $1", [intentId])).rows[0].sub;
    assert.ok(sessions.some((entry) => entry.id === stored));
    const orphan = sessions.find((entry) => entry.id !== stored);
    if (orphan) {
      const { signSublymusBody } = await import("../../lib/server/wallet/sublymus/webhook");
      const body = JSON.stringify({ event: "payment.completed", data: { id: orphan.id, externalReference: orphan.externalReference, payerId: TEST_MANAGER_ID, amount: 4_000, currency: "XOF", sourceSystem: "NOMA", status: "COMPLETED" }, timestamp: "2026-10-08T10:00:00Z" });
      const answer = await createWalletHttpHandlers({ pool: env.pool, env: looseEnv }).sublymus.webhook(new Request("https://noma.test/api/webhooks/sublymus", {
        method: "POST", body,
        headers: { "x-wave-signature": signSublymusBody(TEST_WEBHOOK_SECRET, body), "x-wave-event": "payment.completed", "x-manager-id": TEST_MANAGER_ID, "x-webhook-id": "wh_orphan_session_1" },
      })).then(reply);
      assert.equal(answer.status, 200);
      assert.equal(await balanceOf(env.pool, other.userId), BigInt(0), "la session orpheline n'est jamais créditée");
      assert.equal(await countRows(env.pool, "sublymus_anomalies", "intent_id = $1 AND kind = 'intent_id_mismatch'", [intentId]), 1);
    }
  } finally {
    await loose.close();
  }
});

// ═════════════ 2. Limite de débit ═════════════

test("limite de débit : cinq recharges en attente au plus par utilisateur (la limite actuelle des recharges) ; la sixième est refusée AVANT tout appel à Sublymus", async () => {
  const user = await login(env.pool);
  for (let index = 0; index < 5; index += 1) assert.equal((await create(user.cookie, { amountXof: 1_000 + index * 100, idempotencyKey: randomUUID() })).status, 201);
  const calls = posts().length;
  const sixth = await create(user.cookie, { amountXof: 1_000, idempotencyKey: randomUUID() });
  assert.equal(sixth.status, 409);
  assert.equal(obj(obj(sixth.json).error).code, "too_many_pending_topups");
  assert.equal(posts().length, calls, "aucun appel à Sublymus pour la sixième");
  assert.equal(await countRows(env.pool, "payment_intents", "owner_id = $1", [user.userId]), 5);
});

test("recharge terminée : la reprise (même clé) n'ouvre AUCUNE nouvelle session Wave et le lien de paiement n'est plus servi, ni pour une recharge échouée ni pour une recharge payée", async () => {
  const user = await login(env.pool);
  const webhook = (signed: { body: string; headers: Record<string, string> }) => handlers.sublymus.webhook(webhookRequest(signed)).then(reply);
  // Recharge échouée avant l'ouverture de la session (Sublymus en panne), puis déclarée échouée par un webhook authentifié.
  const failedKey = randomUUID();
  api.setMode("server_error", { times: 1 });
  assert.equal((await create(user.cookie, { amountXof: 3_500, idempotencyKey: failedKey })).status, 503);
  const failedId = (await env.pool.query<{ id: string }>("SELECT id FROM payment_intents WHERE owner_id = $1", [user.userId])).rows[0].id;
  const stray = api.seed({ externalReference: `noma-topup-${failedId}`, amount: 3_500 });
  assert.equal((await webhook(api.webhook({ intent: stray, event: "payment.failed", secret: TEST_WEBHOOK_SECRET, webhookId: "wh_end_0001" }))).status, 200);
  assert.equal((await env.pool.query<{ status: string }>("SELECT status FROM payment_intents WHERE id = $1", [failedId])).rows[0].status, "failed");
  const calls = posts().length;
  const replay = await create(user.cookie, { amountXof: 3_500, idempotencyKey: failedKey });
  assert.equal(replay.status, 200);
  assert.equal(topupOf(replay).status, "failed");
  assert.equal(topupOf(replay).checkoutUrl, null);
  assert.equal(posts().length, calls, "aucune session ouverte pour une recharge terminée");
  assert.equal((await env.pool.query<{ url: string | null }>("SELECT checkout_url AS url FROM sublymus_checkouts WHERE intent_id = $1", [failedId])).rows[0].url, null);

  // Recharge payée : la reprise ne montre plus le lien (la session est terminée chez Wave).
  const paidKey = randomUUID();
  const paid = await create(user.cookie, { amountXof: 2_600, idempotencyKey: paidKey });
  assert.equal(paid.status, 201);
  const fakePaid = [...api.intents.values()].find((entry) => entry.externalReference === `noma-topup-${String(topupOf(paid).id)}`)!;
  assert.equal((await webhook(api.webhook({ intent: fakePaid, secret: TEST_WEBHOOK_SECRET, webhookId: "wh_end_0002" }))).status, 200);
  const again = await create(user.cookie, { amountXof: 2_600, idempotencyKey: paidKey });
  assert.equal(again.status, 200);
  assert.equal(topupOf(again).status, "succeeded");
  assert.equal(topupOf(again).checkoutUrl, null, "le lien d'une recharge payée n'est plus servi");
  assert.ok(!again.text.includes("wave.example"));
  assert.equal(await balanceOf(env.pool, user.userId), BigInt(2_600));
});

test("le webhook arrive PENDANT l'ouverture de la session : la recharge est créditée, le statut de la session ne régresse JAMAIS vers « WAVE_CREATED », le lien n'est ni servi à la création ni à la lecture", async () => {
  const user = await login(env.pool);
  let hook: number | null = null;
  const racing = createWalletHttpHandlers({
    pool: env.pool,
    env: envVars,
    log: (code) => { logs.push(code); },
    fetch: (async (input: string, init?: RequestInit) => {
      const answer = await fetch(input, init);
      if (hook === null && String(input).endsWith("/v1/checkout/complex")) {
        const created = ((await answer.clone().json()) as { data: { payment_intent_id: string } }).data;
        const signed = api.webhook({ intent: api.intents.get(created.payment_intent_id)!, secret: TEST_WEBHOOK_SECRET });
        hook = (await reply(await handlers.sublymus.webhook(webhookRequest(signed)))).status;
      }
      return answer;
    }) as unknown as typeof fetch,
  });
  const answer = await racing.topups.create(request("POST", "/api/wallet/topups", { cookie: user.cookie, body: { amountXof: 3_000, idempotencyKey: randomUUID() } })).then(reply);
  assert.equal(hook, 200, "le webhook a bien été livré pendant l'ouverture de la session");
  assert.equal(answer.status, 201);
  assert.equal(topupOf(answer).status, "succeeded", "l'état servi est relu après l'ouverture de la session");
  assert.equal(topupOf(answer).checkoutUrl, null, "le lien d'une recharge terminée n'est pas servi");
  assert.ok(!answer.text.includes("wave.example"));
  const id = String(topupOf(answer).id);
  const session = (await env.pool.query<{ status: string; next: Date | null; done: boolean; url: string | null }>(
    "SELECT provider_status AS status, next_catchup_at AS next, catchup_done_at IS NOT NULL AS done, checkout_url AS url FROM sublymus_checkouts WHERE intent_id = $1", [id])).rows[0];
  assert.deepEqual([session.status, session.next, session.done], ["COMPLETED", null, true], "la session terminée par le webhook n'est pas ramenée à WAVE_CREATED");
  assert.notEqual(session.url, null, "le lien reçu est tout de même enregistré (immuable)");
  assert.equal(topupOf(await read(user.cookie, id)).checkoutUrl, null);
  assert.equal(await balanceOf(env.pool, user.userId), BigInt(3_000));
  assert.equal(await topupTransactions(env.pool, id), 1);
});

// ═════════════ 3. Retour du navigateur et lecture ═════════════

test("retour du navigateur : lire la recharge (ce que fait la page de retour) ne crédite JAMAIS ; « en attente » tant que ni webhook ni rattrapage authentifiés n'ont confirmé ; le lien n'est servi qu'au propriétaire", async () => {
  const user = await login(env.pool);
  const stranger = await login(env.pool);
  const created = await create(user.cookie, { amountXof: 7_000, idempotencyKey: randomUUID() });
  const id = String(topupOf(created).id);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const answer = await read(user.cookie, id);
    assert.equal(answer.status, 200);
    assert.equal(topupOf(answer).status, "pending", "Paiement en cours de confirmation");
    assert.equal(topupOf(answer).checkoutUrl, topupOf(created).checkoutUrl);
  }
  assert.equal(await balanceOf(env.pool, user.userId), BigInt(0), "aucun crédit au retour du navigateur");
  assert.equal(await topupTransactions(env.pool, id), 0);
  assert.equal(obj((await walletOf(user.cookie)).json).balanceXof, 0);
  // Un autre compte ne reçoit ni le lien ni l'existence de la recharge.
  const foreign = await read(stranger.cookie, id);
  assert.equal(foreign.status, 404);
  assert.ok(!foreign.text.includes("wave.example"));
  assert.equal((await read(null, id)).status, 401);
});

// ═════════════ 4. DTO du porte-monnaie et routes fictives ═════════════

test("porte-monnaie : le prestataire actif est dit par le serveur (sublymus, fictif, aucun) ; les routes de développement du prestataire fictif ne touchent jamais une recharge Sublymus", async () => {
  const user = await login(env.pool);
  assert.equal(obj((await walletOf(user.cookie)).json).paymentMode, "sublymus");
  const created = await create(user.cookie, { amountXof: 2_000, idempotencyKey: randomUUID() });
  const id = String(topupOf(created).id);
  const dev: Env = { ...envVars, NOMA_FAKE_PAYMENTS: "1", NOMA_FAKE_PAYMENT_SECRET: TEST_WEBHOOK_SECRET };
  const withFake = createWalletHttpHandlers({ pool: env.pool, env: dev, log: (code) => { logs.push(code); } });
  const confirm = await withFake.fakePayments.confirm(request("POST", `/api/dev/fake-payments/${id}/confirm`, { cookie: user.cookie, body: undefined }), id).then(reply);
  assert.equal(confirm.status, 404, "une recharge Sublymus n'est jamais simulée");
  assert.equal(await balanceOf(env.pool, user.userId), BigInt(0));
  const fakeOnly = createWalletHttpHandlers({ pool: env.pool, env: { NODE_ENV: "test", NOMA_AUTH_ORIGIN: "https://noma.test", NOMA_FAKE_PAYMENTS: "1", NOMA_FAKE_PAYMENT_SECRET: TEST_WEBHOOK_SECRET } });
  assert.equal(obj((await fakeOnly.wallet.get(request("GET", "/api/wallet", { cookie: user.cookie })).then(reply)).json).paymentMode, "fake");
  const none = createWalletHttpHandlers({ pool: env.pool, env: { NODE_ENV: "test", NOMA_AUTH_ORIGIN: "https://noma.test" } });
  assert.equal(obj((await none.wallet.get(request("GET", "/api/wallet", { cookie: user.cookie })).then(reply)).json).paymentMode, "none");
  assert.equal((await none.topups.create(request("POST", "/api/wallet/topups", { cookie: user.cookie, body: { amountXof: 1_000, idempotencyKey: randomUUID() } })).then(reply)).status, 503);
});

test("configuration refusée : aucune recharge, aucune intention, 503 et un code dans le journal (jamais une valeur)", async () => {
  const user = await login(env.pool);
  const broken = createWalletHttpHandlers({ pool: env.pool, env: { ...envVars, SUBLYMUS_WEBHOOK_SECRET: "trop-court" }, log: (code) => { logs.push(code); } });
  const before = logs.length;
  const answer = await broken.topups.create(request("POST", "/api/wallet/topups", { cookie: user.cookie, body: { amountXof: 1_000, idempotencyKey: randomUUID() } })).then(reply);
  assert.equal(answer.status, 503);
  assert.ok(logs.slice(before).includes("provider_misconfigured"));
  assert.equal(await countRows(env.pool, "payment_intents", "owner_id = $1", [user.userId]), 0);
  assert.ok(!answer.text.includes("trop-court"));
});

test("gardes de la base : une intention Sublymus n'a que la référence noma-topup-<identifiant> ; un identifiant Sublymus ne sert qu'à une seule intention", async () => {
  const user = await login(env.pool);
  const insertIntent = (id: string, reference: string) => env.pool.query(
    `INSERT INTO payment_intents (id, owner_id, amount_xof, provider, status, idempotency_key, provider_reference, created_at, expires_at)
     VALUES ($1::uuid, $2::uuid, 1000, 'sublymus', 'pending', $3::uuid, $4, clock_timestamp(), clock_timestamp() + interval '30 minutes')`,
    [id, user.userId, randomUUID(), reference],
  );
  const code = (error: unknown): string | undefined => (error as { code?: string }).code;
  // Référence d'un autre identifiant, référence libre : refusées par la base (contrainte de contrôle).
  await assert.rejects(insertIntent(randomUUID(), `noma-topup-${randomUUID()}`), (error) => code(error) === "23514");
  await assert.rejects(insertIntent(randomUUID(), `fakepay_${"a".repeat(24)}`), (error) => code(error) === "23514");
  // La référence propre est admise (essai annulé : aucune intention sans ligne de session ne reste dans la base).
  const own = randomUUID();
  const client = await env.pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO payment_intents (id, owner_id, amount_xof, provider, status, idempotency_key, provider_reference, created_at, expires_at)
       VALUES ($1::uuid, $2::uuid, 1000, 'sublymus', 'pending', $3::uuid, $4, clock_timestamp(), clock_timestamp() + interval '30 minutes')`,
      [own, user.userId, randomUUID(), `noma-topup-${own}`],
    );
    await client.query("ROLLBACK");
  } finally {
    client.release();
  }
  // Une intention ÉCHOUÉE peut devenir réussie pour Sublymus seulement (paiement réussi arrivé après un échec) ; le prestataire fictif garde « échoué = terminal ».
  const secondTransition = async (provider: "fake" | "sublymus"): Promise<string | undefined> => {
    const transaction = await env.pool.connect();
    try {
      await transaction.query("BEGIN");
      const id = randomUUID();
      const reference = provider === "sublymus" ? `noma-topup-${id}` : `fakepay_${randomUUID().replaceAll("-", "").slice(0, 24)}`;
      await transaction.query(
        `INSERT INTO payment_intents (id, owner_id, amount_xof, provider, status, idempotency_key, provider_reference, created_at, expires_at)
         VALUES ($1::uuid, $2::uuid, 1000, $3, 'pending', $4::uuid, $5, clock_timestamp(), clock_timestamp() + interval '30 minutes')`,
        [id, user.userId, provider, randomUUID(), reference],
      );
      await transaction.query("UPDATE payment_intents SET status = 'failed', completed_at = clock_timestamp() WHERE id = $1", [id]);
      try {
        await transaction.query("UPDATE payment_intents SET status = 'succeeded', completed_at = clock_timestamp() WHERE id = $1", [id]);
        return undefined;
      } catch (error) {
        return code(error);
      }
    } finally {
      await transaction.query("ROLLBACK").catch(() => undefined);
      transaction.release();
    }
  };
  assert.equal(await secondTransition("sublymus"), undefined);
  assert.equal(await secondTransition("fake"), "23514");
  // Un identifiant Sublymus ne se retrouve jamais sur deux sessions (unicité de la base, en plus du contrôle de l'application).
  const first = await newTopup(env.pool, api, envVars, user.userId, 1_500);
  const second = await createTopupIntent({ pool: env.pool, ownerId: user.userId, amountXof: BigInt(1_600), idempotencyKey: randomUUID(), provider: providerOf(envVars) });
  await assert.rejects(
    env.pool.query("UPDATE sublymus_checkouts SET sublymus_intent_id = $2 WHERE intent_id = $1", [second.intent.id, first.fakeIntent!.id]),
    (error) => code(error) === "23505",
  );
});

// ═════════════ 5. wallet:check ═════════════

test("wallet:check : vert avec des recharges Sublymus ; chaque corruption injectée (transaction annulée) est détectée par SON contrôle ; un crédit hors webhook et rattrapage est un écart", async () => {
  const user = await login(env.pool);
  const handle = await newTopup(env.pool, api, envVars, user.userId, 4_000);
  assert.deepEqual((await checkWalletIntegrity(env.pool)).violations, []);
  const txPool = env.extraPool(2);
  const codesIn = async (corrupt: (client: PoolClient) => Promise<void>): Promise<{ violations: string[]; warnings: string[] }> => {
    const client = await txPool.connect();
    try {
      await client.query("BEGIN");
      await corrupt(client);
      const { runWalletCheck } = await import("../../lib/server/wallet/check");
      const report = await runWalletCheck(client);
      await client.query("ROLLBACK");
      return { violations: report.violations.map((violation) => violation.code), warnings: report.warnings.map((warning) => warning.code) };
    } finally {
      client.release();
    }
  };
  // Ligne de session absente.
  assert.ok((await codesIn(async (client) => {
    await client.query("ALTER TABLE sublymus_checkouts DISABLE TRIGGER trg_sublymus_checkouts_guard");
    await client.query("DELETE FROM sublymus_checkouts WHERE intent_id = $1", [handle.intent.id]);
  })).violations.includes("sublymus_checkout_missing"));
  // Référence de la session différente de celle de l'intention.
  assert.ok((await codesIn(async (client) => {
    await client.query("ALTER TABLE sublymus_checkouts DISABLE TRIGGER trg_sublymus_checkouts_guard");
    await client.query("UPDATE sublymus_checkouts SET external_reference = 'noma-topup-' || gen_random_uuid()::text WHERE intent_id = $1", [handle.intent.id]);
  })).violations.includes("sublymus_checkout_mismatch"));
  // Événement d'un autre prestataire rattaché à une intention Sublymus.
  assert.ok((await codesIn(async (client) => {
    await client.query(
      `INSERT INTO payment_events (id, provider, provider_event_id, intent_id, type, amount_xof, payload_sha256, outcome)
       VALUES (gen_random_uuid(), 'fake', 'evt_forged_provider', $1, 'payment.failed', 4000, repeat('a', 64), 'applied')`, [handle.intent.id]);
  })).violations.includes("sublymus_event_provider_mismatch"));
  // Un échec n'est « supplanté » que par un paiement réussi APPLIQUÉ ensuite : une intention réussie qui garde un échec appliqué sans paiement réussi appliqué est un écart.
  assert.ok((await codesIn(async (client) => {
    await client.query("UPDATE payment_intents SET status = 'failed', completed_at = clock_timestamp() WHERE id = $1", [handle.intent.id]);
    await client.query(
      `INSERT INTO payment_events (id, provider, provider_event_id, intent_id, type, amount_xof, payload_sha256, outcome)
       VALUES (gen_random_uuid(), 'sublymus', 'evt_failed_applied_1', $1, 'payment.failed', 4000, repeat('a', 64), 'applied')`, [handle.intent.id]);
    await client.query("UPDATE payment_intents SET status = 'succeeded', completed_at = clock_timestamp() WHERE id = $1", [handle.intent.id]);
  })).violations.includes("applied_event_state_mismatch"));
  // Avertissements : une anomalie à traiter, un rattrapage échu.
  const warned = await codesIn(async (client) => {
    await client.query(
      `INSERT INTO sublymus_anomalies (kind, origin, dedupe_key, intent_id, external_reference) VALUES ('amount_mismatch', 'webhook', 'essai', $1, $2)`, [handle.intent.id, handle.reference]);
    await client.query("UPDATE sublymus_checkouts SET next_catchup_at = clock_timestamp() - interval '2 hours' WHERE intent_id = $1", [handle.intent.id]);
  });
  assert.ok(warned.warnings.includes("sublymus_anomaly_open"));
  assert.ok(warned.warnings.includes("sublymus_catchup_overdue"));
  assert.deepEqual(warned.violations, [], "des avertissements, pas des écarts");
  // Un crédit qui ne vient ni d'un webhook authentifié ni du rattrapage (par exemple le retour du navigateur) est un écart.
  const applied = await applyProviderEvent({
    pool: env.pool,
    event: { provider: "sublymus", eventId: "browser_return_01", type: "payment.succeeded", providerReference: handle.reference, amountXof: BigInt(4_000), payloadSha256: "b".repeat(64) },
  });
  assert.equal(applied.outcome, "applied");
  const report = await checkWalletIntegrity(env.pool);
  assert.ok(report.violations.some((violation) => violation.code === "sublymus_credit_origin_unknown"), "le crédit d'origine inconnue est signalé");
  assert.equal(report.violations.filter((violation) => violation.code !== "sublymus_credit_origin_unknown").length, 0, "et lui seul");
});
