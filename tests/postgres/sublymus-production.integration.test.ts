import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { runMatchingCycle } from "../../lib/server/matching/runner";
import { checkWalletIntegrity } from "../../lib/server/wallet/check";
import { createWalletHttpHandlers, type WalletHttpHandlers } from "../../lib/server/wallet/http";
import { runSublymusCatchupStep } from "../../lib/server/wallet/sublymus/catchup";
import type { FakeSublymusApi } from "../../scripts/sublymus-fake-api";
import {
  TEST_API_KEY, TEST_MANAGER_ID, TEST_WALLET_ID, TEST_WEBHOOK_SECRET, balanceOf, countRows, startApi, topupTransactions, webhookRequest, type Env,
} from "./sublymus-fixtures";
import { ORIGIN, login, openTestSchema, reply, request, type TestSchema } from "./social-fixtures";

/**
 * Lot PAY1-bis : les chemins de PRODUCTION, qui n'étaient jamais exercés (le rattrapage y était inopérant : le client refusait l'adresse du vrai service). Configuration de
 * PRODUCTION complète (adresse par défaut https://wallet.sublymus.com, liens Wave), un fetch BOUCHON intercepte https://wallet.sublymus.com et renvoie vers la FAUSSE API locale :
 * AUCUN appel réel ne part (le bouchon refuse toute autre origine). Création de session, webhook, rattrapage (étape et cycle du worker), lien de paiement hors domaines Wave.
 */

const MINUTE = 60_000;
const REAL_ORIGIN = "https://wallet.sublymus.com";

let env: TestSchema;
let api: FakeSublymusApi;
let evilApi: FakeSublymusApi;
const seen: string[] = [];
const logs: string[] = [];

const prodEnv = (extra: Env = {}): Env => ({
  NODE_ENV: "production",
  NOMA_AUTH_ORIGIN: ORIGIN,
  NOMA_PAYMENT_PROVIDER: "sublymus",
  WAVE_API_KEY: TEST_API_KEY,
  NOMA_SUBLYMUS_MANAGER_ID: TEST_MANAGER_ID,
  NOMA_SUBLYMUS_WALLET_ID: TEST_WALLET_ID,
  SUBLYMUS_WEBHOOK_SECRET: TEST_WEBHOOK_SECRET,
  NOMA_PUBLIC_URL: "https://noma.test",
  ...extra,
});

/** Fetch bouchon : n'accepte QUE https://wallet.sublymus.com et le renvoie vers la fausse API locale (jamais de sortie sur le réseau). */
const interceptor = (target: () => FakeSublymusApi): typeof fetch => (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  seen.push(`${init?.method ?? "GET"} ${url.origin}${url.pathname}`);
  if (url.origin !== REAL_ORIGIN) throw new Error(`appel hors du faux Sublymus : ${url.origin}`);
  return fetch(`${target().url}${url.pathname}${url.search}`, init);
}) as typeof fetch;

let handlers: WalletHttpHandlers;
let evilHandlers: WalletHttpHandlers;

before(async () => {
  env = await openTestSchema(12);
  api = await startApi({ checkoutLinkBase: "https://pay.wave.com/c" });
  evilApi = await startApi({ checkoutLinkBase: "https://evil.example/c" });
  handlers = createWalletHttpHandlers({ pool: env.pool, env: prodEnv(), fetch: interceptor(() => api), log: (code) => { logs.push(code); } });
  evilHandlers = createWalletHttpHandlers({ pool: env.pool, env: prodEnv(), fetch: interceptor(() => evilApi), log: (code) => { logs.push(code); } });
});

after(async () => {
  await api.close();
  await evilApi.close();
  await env.close();
});

type Json = Record<string, unknown>;
const obj = (value: unknown): Json => value as Json;
const create = (cookie: string, amountXof: number, target: WalletHttpHandlers = handlers) =>
  target.topups.create(request("POST", "/api/wallet/topups", { cookie, body: { amountXof, idempotencyKey: randomUUID() } })).then(reply);
const intentRow = async (id: string) => (await env.pool.query<{ status: string; created_at: Date; url: string | null; provider_status: string | null }>(
  "SELECT p.status, p.created_at, c.checkout_url AS url, c.provider_status FROM payment_intents p JOIN sublymus_checkouts c ON c.intent_id = p.id WHERE p.id = $1", [id])).rows[0];

test("production : la configuration complète est acceptée (adresse par défaut = vrai service), la création de session passe par https://wallet.sublymus.com et le lien est un lien Wave", async () => {
  const user = await login(env.pool);
  const before = seen.length;
  const answer = await create(user.cookie, 5_000);
  assert.equal(answer.status, 201, answer.text);
  const topup = obj(obj(answer.json).topup);
  assert.match(String(topup.checkoutUrl), /^https:\/\/pay\.wave\.com\/c\/pi_[0-9a-f]+$/);
  assert.deepEqual(seen.slice(before), [`POST ${REAL_ORIGIN}/v1/checkout/complex`]);
  assert.equal(obj((await handlers.wallet.get(request("GET", "/api/wallet", { cookie: user.cookie })).then(reply)).json).paymentMode, "sublymus");
  const body = obj(api.requests.filter((entry) => entry.path === "/v1/checkout/complex").at(-1)!.body);
  assert.equal(body.success_url, `https://noma.test/paiement-retour/${topup.id}?resultat=succes`);
  assert.equal(api.requests.at(-1)!.authorization, `Bearer ${TEST_API_KEY}`);
});

test("production : un webhook signé crédite la recharge (une fois) ; le rattrapage de l'étape du worker joint le vrai service par le bouchon et crédite la recharge payée dont le webhook est perdu", async () => {
  const owner = await login(env.pool);
  // Webhook.
  const hooked = obj(obj((await create(owner.cookie, 4_000)).json).topup);
  const hookedFake = [...api.intents.values()].find((entry) => entry.externalReference === `noma-topup-${String(hooked.id)}`)!;
  assert.equal((await handlers.sublymus.webhook(webhookRequest(api.webhook({ intent: hookedFake, secret: TEST_WEBHOOK_SECRET }))).then(reply)).status, 200);
  assert.equal(await balanceOf(env.pool, owner.userId), BigInt(4_000));

  // Rattrapage : webhook perdu, la session est payée chez Wave.
  const lost = obj(obj((await create(owner.cookie, 3_000)).json).topup);
  const lostFake = [...api.intents.values()].find((entry) => entry.externalReference === `noma-topup-${String(lost.id)}`)!;
  api.setStatus(lostFake.id, "COMPLETED");
  const created = (await intentRow(String(lost.id))).created_at;
  const before = seen.length;
  const step = await runSublymusCatchupStep({ pool: env.pool, env: prodEnv(), fetch: interceptor(() => api), now: new Date(created.getTime() + 3 * MINUTE) });
  assert.deepEqual(step.errors, [], "le rattrapage ne lève plus sublymus_real_host_forbidden en production");
  assert.equal(step.skipped, false);
  assert.ok(step.completed >= 1, JSON.stringify(step));
  assert.ok(seen.slice(before).some((line) => line.startsWith(`GET ${REAL_ORIGIN}/v1/intents`)), seen.slice(before).join(" | "));
  assert.equal((await intentRow(String(lost.id))).status, "succeeded");
  assert.equal(await topupTransactions(env.pool, String(lost.id)), 1);
  assert.equal(await balanceOf(env.pool, owner.userId), BigInt(7_000));

  // Cycle complet du worker : même chemin (runMatchingCycle -> étape isolée), recharge payée créditée une fois.
  const cycleTopup = obj(obj((await create(owner.cookie, 2_000)).json).topup);
  const cycleFake = [...api.intents.values()].find((entry) => entry.externalReference === `noma-topup-${String(cycleTopup.id)}`)!;
  api.setStatus(cycleFake.id, "COMPLETED");
  const cycleCreated = (await intentRow(String(cycleTopup.id))).created_at;
  const cycle = await runMatchingCycle({ pool: env.pool, workerId: "worker-pay1bis-prod", paymentCatchup: { env: prodEnv(), fetch: interceptor(() => api), now: new Date(cycleCreated.getTime() + 3 * MINUTE) } });
  assert.deepEqual(cycle.errors.filter((code) => code.startsWith("catchup_")), []);
  assert.equal(cycle.paymentCatchup.completed >= 1, true);
  assert.equal(await balanceOf(env.pool, owner.userId), BigInt(9_000));
  assert.equal(await topupTransactions(env.pool, String(cycleTopup.id)), 1);
  assert.deepEqual((await checkWalletIntegrity(env.pool)).violations, []);
});

test("hors production, le rattrapage ne joint jamais le vrai service : configuration refusée (adresse non locale), étape ignorée avec un code, aucune requête", async () => {
  const before = seen.length;
  const development = await runSublymusCatchupStep({ pool: env.pool, env: prodEnv({ NODE_ENV: "development" }), fetch: interceptor(() => api), now: new Date() });
  assert.deepEqual([development.skipped, development.errors], [true, ["catchup_error_provider_config"]]);
  const test = await runSublymusCatchupStep({ pool: env.pool, env: prodEnv({ NODE_ENV: "test", NOMA_SUBLYMUS_BASE_URL: "https://wallet.sublymus.com." }), fetch: interceptor(() => api), now: new Date() });
  assert.deepEqual([test.skipped, test.errors], [true, ["catchup_error_provider_config"]]);
  assert.equal(seen.length, before, "aucune requête sortante");
});

test("lien de paiement : hors domaines Wave (sous-domaines de wave.com), la session n'est NI enregistrée NI servie ; l'intention reste en attente et le journal garde un code", async () => {
  const user = await login(env.pool);
  const before = await countRows(env.pool, "sublymus_checkouts", "checkout_url IS NOT NULL");
  const answer = await create(user.cookie, 2_500, evilHandlers);
  assert.equal(answer.status, 503);
  assert.deepEqual(obj(answer.json), { error: { code: "payment_unavailable", message: "Le paiement est temporairement indisponible." } });
  assert.ok(!answer.text.includes("evil.example"));
  assert.equal(await countRows(env.pool, "sublymus_checkouts", "checkout_url IS NOT NULL"), before, "aucun lien enregistré");
  assert.ok(logs.includes("sublymus_invalid_response"));
  const row = (await env.pool.query<{ id: string; url: string | null }>("SELECT p.id, c.checkout_url AS url FROM payment_intents p JOIN sublymus_checkouts c ON c.intent_id = p.id WHERE p.owner_id = $1", [user.userId])).rows;
  assert.deepEqual(row.map((entry) => entry.url), [null]);
  // Un nom qui ressemble à Wave n'est pas Wave.
  const lookalike = await startApi({ checkoutLinkBase: "https://pay.wave.com.evil.example/c" });
  try {
    const lookalikeHandlers = createWalletHttpHandlers({ pool: env.pool, env: prodEnv(), fetch: interceptor(() => lookalike), log: (code) => { logs.push(code); } });
    assert.equal((await create((await login(env.pool)).cookie, 2_600, lookalikeHandlers)).status, 503);
  } finally {
    await lookalike.close();
  }
  // Les journaux et la console ne contiennent ni clé ni secret.
  for (const line of logs) assert.ok(!line.includes(TEST_API_KEY) && !line.includes(TEST_WEBHOOK_SECRET));
});
