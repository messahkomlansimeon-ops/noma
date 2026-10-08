/**
 * Éléments partagés par les essais du lot PAY1 (paiement Wave via Sublymus). RÈGLE ABSOLUE : AUCUN appel réel à wallet.sublymus.com ni à Wave. Tout passe par la FAUSSE API
 * locale (`scripts/sublymus-fake-api.ts`, boucle locale) et par des webhooks synthétiques signés avec un secret de TEST inventé ici. Aucune vraie clé : celle-ci est tirée au sort.
 */

import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { startFakeSublymusApi, type FakeIntent, type FakeSublymusApi, type FakeSublymusOptions } from "../../scripts/sublymus-fake-api";
import { resolvePaymentProvider } from "../../lib/server/wallet/payment-provider";
import { createTopupIntent, type PaymentIntent } from "../../lib/server/wallet/topups";
import type { SublymusProvider } from "../../lib/server/wallet/sublymus/provider";
import { ORIGIN } from "./social-fixtures";

/** Clé, secret et identifiants INVENTÉS pour les essais : ils ne désignent rien chez Sublymus. */
export const TEST_API_KEY = `testkey_${randomBytes(12).toString("hex")}`;
export const TEST_MANAGER_ID = "mgr_test_001";
export const TEST_WALLET_ID = "wal_test_001";
export const TEST_WEBHOOK_SECRET = randomBytes(24).toString("hex");
export const TEST_PUBLIC_URL = "https://noma.test";

export type Env = Record<string, string | undefined>;

export function startApi(options: Partial<FakeSublymusOptions> = {}): Promise<FakeSublymusApi> {
  return startFakeSublymusApi({ apiKey: TEST_API_KEY, managerId: TEST_MANAGER_ID, walletId: TEST_WALLET_ID, ...options });
}

/** Environnement du serveur en mode Sublymus, branché sur la fausse API locale. */
export function sublymusEnv(api: FakeSublymusApi, extra: Env = {}): Env {
  return {
    NODE_ENV: "test",
    NOMA_AUTH_ORIGIN: ORIGIN,
    NOMA_PAYMENT_PROVIDER: "sublymus",
    WAVE_API_KEY: TEST_API_KEY,
    NOMA_SUBLYMUS_MANAGER_ID: TEST_MANAGER_ID,
    NOMA_SUBLYMUS_WALLET_ID: TEST_WALLET_ID,
    SUBLYMUS_WEBHOOK_SECRET: TEST_WEBHOOK_SECRET,
    NOMA_PUBLIC_URL: TEST_PUBLIC_URL,
    NOMA_SUBLYMUS_BASE_URL: api.url,
    ...extra,
  };
}

export function providerOf(env: Env, options: { fetch?: typeof fetch } = {}): SublymusProvider {
  const resolved = resolvePaymentProvider(env, options);
  assert.ok(resolved.active && resolved.sublymus, "le prestataire Sublymus doit être actif");
  return resolved.sublymus;
}

export interface TopupHandle {
  intent: PaymentIntent;
  reference: string;
  checkoutUrl: string | null;
  fakeIntent: FakeIntent | null;
}

/** Une recharge Sublymus : intention créée (même chemin que la route), session ouverte chez la fausse API. */
export async function newTopup(pool: Pool, api: FakeSublymusApi, env: Env, ownerId: string, amountXof = 5_000, idempotencyKey: string = randomUUID()): Promise<TopupHandle> {
  const provider = providerOf(env);
  const created = await createTopupIntent({ pool, ownerId, amountXof: BigInt(amountXof), idempotencyKey, provider });
  const prepared = await provider.prepareCheckout({ pool, intent: created.intent });
  const fakeIntent = [...api.intents.values()].find((entry) => entry.externalReference === created.intent.providerReference) ?? null;
  return { intent: created.intent, reference: created.intent.providerReference, checkoutUrl: prepared.checkoutUrl, fakeIntent };
}

export async function balanceOf(pool: Pool, ownerId: string): Promise<bigint> {
  const result = await pool.query<{ balance: string }>("SELECT balance::text AS balance FROM wallet_accounts WHERE kind = 'user' AND owner_id = $1::uuid", [ownerId]);
  return BigInt(result.rows[0]?.balance ?? "0");
}

export async function countRows(pool: Pool, table: string, where = "TRUE", values: unknown[] = []): Promise<number> {
  return (await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`, values)).rows[0].n;
}

/** Nombre de recharges créditées (transactions `topup`) : jamais plus d'une par intention. */
export const topupTransactions = (pool: Pool, intentId: string): Promise<number> => countRows(pool, "wallet_transactions", "kind = 'topup' AND reference = $1", [`topup:${intentId}`]);

export const webhookRequest = (signed: { body: string; headers: Record<string, string> }, options: { path?: string; method?: string } = {}): Request =>
  new Request(`${ORIGIN}${options.path ?? "/api/webhooks/sublymus"}`, { method: options.method ?? "POST", headers: signed.headers, body: signed.body });

/** Ce qui a changé dans la base : lignes des tables de paiement et du grand livre (rien ne bouge sur un refus). */
export async function paymentSnapshot(pool: Pool): Promise<Record<string, number>> {
  const result = await pool.query<Record<string, number>>(
    `SELECT (SELECT count(*) FROM wallet_transactions)::int AS transactions, (SELECT count(*) FROM wallet_entries)::int AS entries, (SELECT count(*) FROM payment_events)::int AS events,
            (SELECT count(*) FROM sublymus_webhook_deliveries)::int AS deliveries, (SELECT count(*) FROM sublymus_anomalies)::int AS anomalies,
            (SELECT count(*) FROM payment_intents WHERE status = 'succeeded')::int AS succeeded`,
  );
  return result.rows[0];
}
