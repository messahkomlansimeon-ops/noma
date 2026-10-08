import "server-only";

import type { Pool } from "pg";
import { withReadOnlySnapshot } from "../../boost/boosts";
import { requireTransactionPool, requireUuid } from "../../catalog/validation";
import { withPostgresTransaction } from "../../postgres/client";
import { CatalogNotFoundError } from "../../catalog/errors";
import { ANOMALY_KINDS, type AnomalyKind, type AnomalyOrigin } from "./anomalies";

/**
 * Lectures d'administration des paiements (lot PAY1, page /admin/paiements) : intentions récentes, anomalies de rapprochement à traiter, état du rattrapage. AUCUNE donnée
 * personnelle : ni propriétaire, ni téléphone, ni référence du prestataire, ni identifiant de payeur (même masqué). Voir PAIEMENT-WAVE.md.
 */

export const OVERVIEW_INTENT_LIMIT = 50;
export const OVERVIEW_ANOMALY_LIMIT = 50;
/** Un rattrapage échu depuis plus de ce délai (millisecondes) signale que le worker ne tourne pas. */
export const CATCHUP_OVERDUE_AFTER_MS = 15 * 60_000;

export interface PaymentIntentOverview {
  id: string;
  provider: "fake" | "sublymus";
  amountXof: bigint;
  status: "pending" | "succeeded" | "failed" | "expired";
  createdAt: Date;
  completedAt: Date | null;
  /** Sublymus seulement. */
  checkoutOpened: boolean | null;
  providerStatus: string | null;
  catchupAttempts: number | null;
  nextCatchupAt: Date | null;
  lastCatchupAt: Date | null;
  lastCatchupOutcome: string | null;
  catchupDone: boolean | null;
}

export interface PaymentAnomalyOverview {
  id: string;
  kind: AnomalyKind;
  origin: AnomalyOrigin;
  createdAt: Date;
  intentId: string | null;
  expectedAmountXof: bigint | null;
  receivedAmountXof: bigint | null;
  receivedCurrency: string | null;
  receivedStatus: string | null;
  resolvedAt: Date | null;
}

export interface PaymentsOverview {
  intents: PaymentIntentOverview[];
  anomalies: PaymentAnomalyOverview[];
  openAnomalies: number;
  catchup: { waiting: number; overdue: number; done: number; lastRunAt: Date | null };
  webhooks: { last24h: number; lastReceivedAt: Date | null };
  readAt: Date;
}

interface IntentRow {
  id: string;
  provider: "fake" | "sublymus";
  amount_xof: string;
  status: PaymentIntentOverview["status"];
  created_at: Date;
  completed_at: Date | null;
  checkout_url_set: boolean | null;
  provider_status: string | null;
  catchup_attempts: number | null;
  next_catchup_at: Date | null;
  last_catchup_at: Date | null;
  last_catchup_outcome: string | null;
  catchup_done_at: Date | null;
  has_checkout: boolean;
}

export async function readPaymentsOverview(input: { pool: Pool }): Promise<PaymentsOverview> {
  const pool = requireTransactionPool(input.pool);
  return withReadOnlySnapshot(pool, async (client) => {
    const intents = await client.query<IntentRow>(
      `SELECT p.id, p.provider, p.amount_xof::text AS amount_xof, p.status, p.created_at, p.completed_at,
              (c.intent_id IS NOT NULL) AS has_checkout, (c.checkout_url IS NOT NULL) AS checkout_url_set, c.provider_status, c.catchup_attempts,
              c.next_catchup_at, c.last_catchup_at, c.last_catchup_outcome, c.catchup_done_at
         FROM payment_intents p LEFT JOIN sublymus_checkouts c ON c.intent_id = p.id
        ORDER BY p.created_at DESC, p.id DESC LIMIT $1::int`,
      [OVERVIEW_INTENT_LIMIT],
    );
    const anomalies = await client.query<{
      id: string; kind: AnomalyKind; origin: AnomalyOrigin; created_at: Date; intent_id: string | null; expected: string | null; received: string | null;
      currency: string | null; status: string | null; resolved_at: Date | null;
    }>(
      `SELECT id, kind, origin, created_at, intent_id, expected_amount_xof::text AS expected, received_amount_xof::text AS received,
              received_currency AS currency, received_status AS status, resolved_at
         FROM sublymus_anomalies ORDER BY (resolved_at IS NULL) DESC, created_at DESC, id DESC LIMIT $1::int`,
      [OVERVIEW_ANOMALY_LIMIT],
    );
    const counts = await client.query<{ open: number; waiting: number; overdue: number; done: number; last_run: Date | null; hooks: number; last_hook: Date | null; at: Date }>(
      `SELECT (SELECT count(*)::int FROM sublymus_anomalies WHERE resolved_at IS NULL) AS open,
              (SELECT count(*)::int FROM sublymus_checkouts WHERE next_catchup_at IS NOT NULL) AS waiting,
              (SELECT count(*)::int FROM sublymus_checkouts WHERE next_catchup_at IS NOT NULL AND next_catchup_at < clock_timestamp() - make_interval(secs => $1::int)) AS overdue,
              (SELECT count(*)::int FROM sublymus_checkouts WHERE catchup_done_at IS NOT NULL) AS done,
              (SELECT max(last_catchup_at) FROM sublymus_checkouts) AS last_run,
              (SELECT count(*)::int FROM sublymus_webhook_deliveries WHERE received_at > clock_timestamp() - interval '24 hours') AS hooks,
              (SELECT max(received_at) FROM sublymus_webhook_deliveries) AS last_hook,
              clock_timestamp() AS at`,
      [Math.round(CATCHUP_OVERDUE_AFTER_MS / 1000)],
    );
    const row = counts.rows[0];
    return {
      intents: intents.rows.map((entry) => ({
        id: entry.id,
        provider: entry.provider,
        amountXof: BigInt(entry.amount_xof),
        status: entry.status,
        createdAt: entry.created_at,
        completedAt: entry.completed_at,
        checkoutOpened: entry.has_checkout ? entry.checkout_url_set === true : null,
        providerStatus: entry.provider_status,
        catchupAttempts: entry.has_checkout ? entry.catchup_attempts : null,
        nextCatchupAt: entry.next_catchup_at,
        lastCatchupAt: entry.last_catchup_at,
        lastCatchupOutcome: entry.last_catchup_outcome,
        catchupDone: entry.has_checkout ? entry.catchup_done_at !== null : null,
      })),
      anomalies: anomalies.rows
        .filter((entry) => (ANOMALY_KINDS as readonly string[]).includes(entry.kind))
        .map((entry) => ({
          id: entry.id,
          kind: entry.kind,
          origin: entry.origin,
          createdAt: entry.created_at,
          intentId: entry.intent_id,
          expectedAmountXof: entry.expected === null ? null : BigInt(entry.expected),
          receivedAmountXof: entry.received === null ? null : BigInt(entry.received),
          receivedCurrency: entry.currency,
          receivedStatus: entry.status,
          resolvedAt: entry.resolved_at,
        })),
      openAnomalies: row.open,
      catchup: { waiting: row.waiting, overdue: row.overdue, done: row.done, lastRunAt: row.last_run },
      webhooks: { last24h: row.hooks, lastReceivedAt: row.last_hook },
      readAt: row.at,
    };
  });
}

/** Marque une anomalie comme TRAITÉE (administrateur) : une seule fois, jamais de suppression. Idempotent : renvoie `changed: false` si elle l'était déjà. */
export async function resolveAnomaly(input: { pool: Pool; anomalyId: string; adminId: string }): Promise<{ changed: boolean }> {
  const pool = requireTransactionPool(input.pool);
  const anomalyId = requireUuid(input.anomalyId, "anomalyId").toLowerCase();
  const adminId = requireUuid(input.adminId, "adminId").toLowerCase();
  return withPostgresTransaction(async (client) => {
    const updated = await client.query(
      "UPDATE sublymus_anomalies SET resolved_at = clock_timestamp(), resolved_by = $2::uuid WHERE id = $1::uuid AND resolved_at IS NULL",
      [anomalyId, adminId],
    );
    if (updated.rowCount) return { changed: true };
    const exists = await client.query("SELECT 1 FROM sublymus_anomalies WHERE id = $1::uuid", [anomalyId]);
    if (!exists.rowCount) throw new CatalogNotFoundError("anomalie");
    return { changed: false };
  }, pool);
}
