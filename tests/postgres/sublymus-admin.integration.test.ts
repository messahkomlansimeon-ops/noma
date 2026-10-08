import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { grantAdmin } from "../../lib/server/admin/grant";
import { createAdminPaymentsHttpHandlers, type AdminPaymentsHttpHandlers } from "../../lib/server/admin/payments-http";
import { createWalletHttpHandlers } from "../../lib/server/wallet/http";
import * as paymentsRoute from "../../app/api/admin/payments/route";
import * as resolveRoute from "../../app/api/admin/payments/anomalies/[id]/resolve/route";
import * as webhookRoute from "../../app/api/webhooks/sublymus/route";
import type { FakeSublymusApi } from "../../scripts/sublymus-fake-api";
import { TEST_API_KEY, TEST_MANAGER_ID, TEST_WEBHOOK_SECRET, newTopup, startApi, sublymusEnv, webhookRequest, type Env } from "./sublymus-fixtures";
import { NOT_FOUND, ORIGIN, count, login, openTestSchema, reply, request, type Login, type Reply, type TestSchema } from "./social-fixtures";

/** Lot PAY1 : administration des paiements (page /admin/paiements et ses routes) : garde administrateur, aucune donnée personnelle, anomalies à traiter. */

let env: TestSchema;
let api: FakeSublymusApi;
let envVars: Env;
let admin: AdminPaymentsHttpHandlers;
let boss: Login;
let ordinary: Login;
const logs: string[] = [];

before(async () => {
  env = await openTestSchema(8);
  api = await startApi();
  envVars = sublymusEnv(api);
  admin = createAdminPaymentsHttpHandlers({ pool: env.pool, env: envVars, log: (code) => { logs.push(code); } });
  boss = await login(env.pool);
  ordinary = await login(env.pool);
  assert.equal((await grantAdmin({ pool: env.pool, phone: boss.phone })).granted, true);
});

after(async () => {
  await api.close();
  await env.close();
});

type Json = Record<string, unknown>;
const obj = (value: unknown): Json => value as Json;
const overview = (cookie: string | null, query = ""): Promise<Reply> => admin.overview(request("GET", "/api/admin/payments", { cookie, query })).then(reply);
const resolve = (cookie: string | null, id: string, body: unknown = {}, origin?: string | null): Promise<Reply> =>
  admin.resolveAnomaly(request("POST", `/api/admin/payments/anomalies/${id}/resolve`, { cookie, body, origin }), id).then(reply);

test("garde : le MÊME 404 pour un visiteur, un compte ordinaire ou un administrateur suspendu ; origine vérifiée sur l'écriture ; requête inattendue refusée", async () => {
  for (const cookie of [null, ordinary.cookie]) {
    const answer = await overview(cookie);
    assert.deepEqual([answer.status, answer.json], [404, NOT_FOUND]);
    const written = await resolve(cookie, randomUUID());
    assert.deepEqual([written.status, written.json], [404, NOT_FOUND]);
    assert.equal(written.text, answer.text, "indiscernable");
  }
  assert.equal((await resolve(boss.cookie, randomUUID(), {}, null)).status, 403, "origine absente");
  assert.equal((await overview(boss.cookie)).status, 200);
  assert.equal((await overview(boss.cookie, "?limit=3")).status, 400);
  const suspended = await login(env.pool);
  await grantAdmin({ pool: env.pool, phone: suspended.phone });
  assert.equal((await overview(suspended.cookie)).status, 200);
  await env.pool.query("UPDATE users SET status = 'suspended' WHERE id = $1", [suspended.userId]);
  assert.equal((await overview(suspended.cookie)).status, 404);
  assert.deepEqual(Object.keys(paymentsRoute).filter((key) => ["GET", "POST", "PUT", "PATCH", "DELETE"].includes(key)).sort(), ["GET"]);
  assert.deepEqual(Object.keys(resolveRoute).filter((key) => ["GET", "POST", "PUT", "PATCH", "DELETE"].includes(key)).sort(), ["POST"]);
  assert.deepEqual(Object.keys(webhookRoute).filter((key) => ["GET", "POST", "PUT", "PATCH", "DELETE"].includes(key)).sort(), ["POST"]);
  for (const route of [paymentsRoute, resolveRoute, webhookRoute]) {
    assert.equal((route as { runtime?: string }).runtime, "nodejs");
    assert.equal((route as { dynamic?: string }).dynamic, "force-dynamic");
  }
});

test("vue d'ensemble : recharges récentes, anomalies à traiter, rattrapage et webhooks ; AUCUNE donnée personnelle (ni propriétaire, ni téléphone, ni référence, ni payeur, ni clé)", async () => {
  const owner = await login(env.pool);
  const paid = await newTopup(env.pool, api, envVars, owner.userId, 5_000);
  const waiting = await newTopup(env.pool, api, envVars, owner.userId, 3_000);
  const handlers = createWalletHttpHandlers({ pool: env.pool, env: envVars });
  assert.equal((await handlers.sublymus.webhook(webhookRequest(api.webhook({ intent: paid.fakeIntent!, secret: TEST_WEBHOOK_SECRET, webhookId: "wh_admin_ok_01" }))).then(reply)).status, 200);
  const payerSecret = "payeur_inconnu_999";
  assert.equal((await handlers.sublymus.webhook(webhookRequest(api.webhook({ intent: waiting.fakeIntent!, secret: TEST_WEBHOOK_SECRET, data: { amount: 2_999, payerId: payerSecret }, webhookId: "wh_admin_ko_01" }))).then(reply)).status, 200);

  const answer = await overview(boss.cookie);
  assert.equal(answer.status, 200);
  const body = obj(answer.json);
  assert.deepEqual(Object.keys(body).sort(), ["anomalies", "catchup", "contractVersion", "intents", "openAnomalies", "provider", "readAt", "webhooks"]);
  assert.equal(body.contractVersion, "admin-payments/v1");
  assert.equal(body.provider, "sublymus");
  assert.ok(Number(body.openAnomalies) >= 2, "montant différent et payeur différent");
  const intents = body.intents as Json[];
  const mine = intents.filter((entry) => entry.id === paid.intent.id || entry.id === waiting.intent.id);
  assert.deepEqual(mine.map((entry) => [entry.amountXof, entry.status, entry.provider]).sort(), [[3_000, "pending", "sublymus"], [5_000, "succeeded", "sublymus"]]);
  assert.deepEqual(Object.keys(intents[0]).sort(), ["amountXof", "catchupAttempts", "catchupDone", "checkoutOpened", "completedAt", "createdAt", "id", "lastCatchupAt", "lastCatchupOutcome", "nextCatchupAt", "provider", "providerStatus", "status"]);
  const anomalies = body.anomalies as Json[];
  assert.ok(anomalies.some((entry) => entry.kind === "amount_mismatch" && entry.expectedAmountXof === 3_000 && entry.receivedAmountXof === 2_999 && entry.resolvedAt === null));
  assert.deepEqual(Object.keys(anomalies[0]).sort(), ["createdAt", "expectedAmountXof", "id", "intentId", "kind", "origin", "receivedAmountXof", "receivedCurrency", "receivedStatus", "resolvedAt"]);
  assert.equal(obj(body.webhooks).last24h, 2);
  assert.deepEqual(Object.keys(obj(body.catchup)).sort(), ["done", "lastRunAt", "overdue", "waiting"]);
  for (const secret of [owner.userId, owner.phone, paid.reference, waiting.reference, payerSecret, "pa***", TEST_API_KEY, TEST_WEBHOOK_SECRET, TEST_MANAGER_ID, "idempotency", "owner"]) {
    assert.ok(!answer.text.includes(secret), `donnée interne dans la vue : ${secret}`);
  }
});

test("anomalie : marquée traitée par l'administrateur (une fois, idempotent), journalisée par son identifiant et la date ; inconnue ou mal formée : 404 ; corps non vide : 400 ; jamais modifiable autrement", async () => {
  const owner = await login(env.pool);
  const handle = await newTopup(env.pool, api, envVars, owner.userId, 5_000);
  const handlers = createWalletHttpHandlers({ pool: env.pool, env: envVars });
  await handlers.sublymus.webhook(webhookRequest(api.webhook({ intent: handle.fakeIntent!, secret: TEST_WEBHOOK_SECRET, data: { currency: "USD" }, webhookId: "wh_admin_res_01" }))).then(reply);
  const anomaly = (await env.pool.query<{ id: string }>("SELECT id FROM sublymus_anomalies WHERE intent_id = $1", [handle.intent.id])).rows[0];
  const before = Number(obj((await overview(boss.cookie)).json).openAnomalies);
  assert.equal((await resolve(boss.cookie, anomaly.id, { force: true })).status, 400);
  assert.equal((await resolve(boss.cookie, "pas-un-uuid")).status, 404);
  assert.equal((await resolve(boss.cookie, randomUUID())).status, 404);
  const first = await resolve(boss.cookie, anomaly.id);
  assert.deepEqual([first.status, obj(first.json).changed], [200, true]);
  assert.deepEqual(obj(await resolve(boss.cookie, anomaly.id).then((answer) => answer.json)).changed, false, "idempotent");
  const row = (await env.pool.query<{ by: string; at: Date | null }>("SELECT resolved_by AS by, resolved_at AS at FROM sublymus_anomalies WHERE id = $1", [anomaly.id])).rows[0];
  assert.equal(row.by, boss.userId);
  assert.ok(row.at instanceof Date);
  assert.equal(Number(obj((await overview(boss.cookie)).json).openAnomalies), before - 1);
  // La base refuse toute autre modification d'une anomalie, et sa suppression.
  await assert.rejects(env.pool.query("UPDATE sublymus_anomalies SET received_amount_xof = 1 WHERE id = $1", [anomaly.id]), /wallet_immutable/);
  await assert.rejects(env.pool.query("DELETE FROM sublymus_anomalies WHERE id = $1", [anomaly.id]), /wallet_immutable/);
  assert.equal(await count(env.pool, "sublymus_anomalies", `id = '${anomaly.id}'`), 1);
});

test("prestataire fictif : la vue le dit (provider « fake ») ; configuration refusée : « misconfigured »", async () => {
  const fake = createAdminPaymentsHttpHandlers({ pool: env.pool, env: { NODE_ENV: "test", NOMA_AUTH_ORIGIN: ORIGIN } });
  assert.equal(obj((await fake.overview(request("GET", "/api/admin/payments", { cookie: boss.cookie })).then(reply)).json).provider, "fake");
  const broken = createAdminPaymentsHttpHandlers({ pool: env.pool, env: { ...envVars, SUBLYMUS_WEBHOOK_SECRET: "court" } });
  assert.equal(obj((await broken.overview(request("GET", "/api/admin/payments", { cookie: boss.cookie })).then(reply)).json).provider, "misconfigured");
});
