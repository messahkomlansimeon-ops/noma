import "server-only";

import type { SqlExecutor } from "../../postgres/client";

/**
 * Table de rapprochement (lot PAY1) : tout événement ou rattrapage AUTHENTIFIÉ de Sublymus qui ne se rapproche pas de notre intention est journalisé ici, et RIEN n'est crédité.
 * Aucune donnée personnelle : jamais un numéro de téléphone ; le `payerId` n'est conservé que MASQUÉ. Écriture idempotente : (origine, clé de déduplication, genre) est unique.
 */

export const ANOMALY_KINDS = [
  "amount_mismatch", "currency_mismatch", "status_mismatch", "unknown_reference", "payer_mismatch", "source_mismatch",
  "intent_id_mismatch", "event_mismatch", "state_conflict", "invalid_amount", "duplicate_provider_intents", "unreadable_event", "unknown_event",
] as const;
export type AnomalyKind = (typeof ANOMALY_KINDS)[number];
export type AnomalyOrigin = "webhook" | "catchup";

export interface AnomalyInput {
  kind: AnomalyKind;
  origin: AnomalyOrigin;
  dedupeKey: string;
  intentId: string | null;
  externalReference: string;
  webhookId?: string | null;
  sublymusIntentId?: string | null;
  expectedAmountXof?: bigint | null;
  receivedAmountXof?: bigint | null;
  receivedCurrency?: string | null;
  receivedStatus?: string | null;
  /** Identifiant du payeur tel que reçu : n'est JAMAIS conservé entier. */
  payerId?: string | null;
}

/** Identifiant masqué : deux premiers caractères puis « *** » (aucun identifiant complet dans une table lue par l'administration ni dans un journal). */
export function maskPayer(payerId: string | null | undefined): string | null {
  if (typeof payerId !== "string" || payerId === "") return null;
  return `${payerId.slice(0, 2).replace(/[^A-Za-z0-9_-]/g, "?")}***`;
}

/**
 * Identifiant masqué POUR LE FONDATEUR (commande wallet:provider-intent-check) : deux premiers et deux derniers caractères, le milieu caché. Jamais l'identifiant entier ;
 * un identifiant de 6 caractères ou moins n'en montre aucun (« *** »).
 */
export function maskPayerPartial(payerId: string | null | undefined): string | null {
  if (typeof payerId !== "string" || payerId === "") return null;
  const clean = (part: string): string => part.replace(/[^A-Za-z0-9_-]/g, "?");
  return payerId.length <= 6 ? "***" : `${clean(payerId.slice(0, 2))}***${clean(payerId.slice(-2))}`;
}

function printable(value: string, max: number): string {
  return value.replace(/[^\x20-\x7e]/g, "?").slice(0, max);
}

/** Écrit l'anomalie (une seule fois par origine, clé et genre). Renvoie vrai si une ligne a été créée. */
export async function recordAnomaly(executor: SqlExecutor, input: AnomalyInput): Promise<boolean> {
  const result = await executor.query(
    `INSERT INTO sublymus_anomalies
       (kind, origin, dedupe_key, intent_id, external_reference, webhook_id, sublymus_intent_id, expected_amount_xof, received_amount_xof, received_currency, received_status, payer_hint)
     VALUES ($1, $2, $3, $4::uuid, $5, $6, $7, $8::bigint, $9::bigint, $10, $11, $12)
     ON CONFLICT (origin, dedupe_key, kind) DO NOTHING`,
    [
      input.kind,
      input.origin,
      printable(input.dedupeKey, 160),
      input.intentId,
      printable(input.externalReference, 100) || "?",
      input.webhookId === null || input.webhookId === undefined ? null : printable(input.webhookId, 128),
      input.sublymusIntentId === null || input.sublymusIntentId === undefined ? null : printable(input.sublymusIntentId, 100),
      input.expectedAmountXof === null || input.expectedAmountXof === undefined ? null : input.expectedAmountXof.toString(),
      input.receivedAmountXof === null || input.receivedAmountXof === undefined ? null : input.receivedAmountXof.toString(),
      input.receivedCurrency === null || input.receivedCurrency === undefined ? null : printable(input.receivedCurrency, 8),
      input.receivedStatus === null || input.receivedStatus === undefined ? null : printable(input.receivedStatus, 32),
      maskPayer(input.payerId),
    ],
  );
  return (result.rowCount ?? 0) > 0;
}
