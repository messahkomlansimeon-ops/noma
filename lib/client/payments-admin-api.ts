/**
 * Couche cliente de l'administration des PAIEMENTS (lot PAY1) : intentions récentes, anomalies de rapprochement, état du rattrapage. Module partagé navigateur (aucun import
 * serveur), mêmes règles que `pro-api.ts` : fetch même origine, JSON, toute erreur devient une `ApiError { status, code }`, réponses relues champ par champ (liste blanche).
 * Contrat : lib/server/admin/payments-http.ts (`admin-payments/v1`). AUCUNE donnée personnelle n'y figure. Voir PAIEMENT-WAVE.md.
 */

import { API_ABORTED, API_INVALID_ARGUMENT, API_INVALID_RESPONSE, API_NETWORK_ERROR, ApiError, isUuid, type RequestOptions } from "./api";

export const ADMIN_PAYMENTS_CONTRACT_VERSION = "admin-payments/v1";

export const ANOMALY_KINDS = [
  "amount_mismatch", "currency_mismatch", "status_mismatch", "unknown_reference", "payer_mismatch", "source_mismatch",
  "intent_id_mismatch", "event_mismatch", "state_conflict", "invalid_amount", "duplicate_provider_intents", "unreadable_event", "unknown_event",
] as const;
export type AnomalyKind = (typeof ANOMALY_KINDS)[number];

export interface PaymentsOverviewAnomaly {
  id: string;
  kind: AnomalyKind;
  origin: "webhook" | "catchup";
  createdAt: string;
  intentId: string | null;
  expectedAmountXof: number | null;
  receivedAmountXof: number | null;
  receivedCurrency: string | null;
  receivedStatus: string | null;
  resolvedAt: string | null;
}

export interface PaymentsOverviewIntent {
  id: string;
  provider: "fake" | "sublymus";
  amountXof: number;
  status: "pending" | "succeeded" | "failed" | "expired";
  createdAt: string;
  completedAt: string | null;
  checkoutOpened: boolean | null;
  providerStatus: string | null;
  catchupAttempts: number | null;
  nextCatchupAt: string | null;
  lastCatchupAt: string | null;
  lastCatchupOutcome: string | null;
  catchupDone: boolean | null;
}

export interface PaymentsOverview {
  provider: "fake" | "sublymus" | "misconfigured";
  openAnomalies: number;
  anomalies: PaymentsOverviewAnomaly[];
  intents: PaymentsOverviewIntent[];
  catchup: { waiting: number; overdue: number; done: number; lastRunAt: string | null };
  webhooks: { last24h: number; lastReceivedAt: string | null };
  readAt: string;
}

type Json = Record<string, unknown>;

const ERROR_CODE = /^[a-z][a-z0-9_]{0,63}$/;
const FIXED_MESSAGE = "Réponse du serveur inattendue.";
const INTENT_STATUSES = ["pending", "succeeded", "failed", "expired"] as const;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function bad(status: number): never {
  throw new ApiError(status, API_INVALID_RESPONSE, FIXED_MESSAGE);
}

const isAmount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const isAmountOrNull = (value: unknown): value is number | null => value === null || isAmount(value);
const isIso = (value: unknown): value is string => typeof value === "string" && value.length >= 10 && value.length <= 40 && Number.isFinite(Date.parse(value));
const isIsoOrNull = (value: unknown): value is string | null => value === null || isIso(value);
const shortTextOrNull = (value: unknown, max: number): value is string | null => value === null || (typeof value === "string" && value.length <= max);

function parseAnomaly(status: number, value: unknown): PaymentsOverviewAnomaly {
  if (
    !isObject(value) || !isUuid(value.id) || !(ANOMALY_KINDS as readonly string[]).includes(String(value.kind)) || !(value.origin === "webhook" || value.origin === "catchup")
    || !isIso(value.createdAt) || !(value.intentId === null || isUuid(value.intentId)) || !isAmountOrNull(value.expectedAmountXof) || !isAmountOrNull(value.receivedAmountXof)
    || !shortTextOrNull(value.receivedCurrency, 8) || !shortTextOrNull(value.receivedStatus, 32) || !isIsoOrNull(value.resolvedAt)
  ) bad(status);
  const entry = value as Json;
  return {
    id: entry.id as string, kind: entry.kind as AnomalyKind, origin: entry.origin as "webhook" | "catchup", createdAt: entry.createdAt as string, intentId: entry.intentId as string | null,
    expectedAmountXof: entry.expectedAmountXof as number | null, receivedAmountXof: entry.receivedAmountXof as number | null, receivedCurrency: entry.receivedCurrency as string | null,
    receivedStatus: entry.receivedStatus as string | null, resolvedAt: entry.resolvedAt as string | null,
  };
}

function parseIntent(status: number, value: unknown): PaymentsOverviewIntent {
  if (
    !isObject(value) || !isUuid(value.id) || !(value.provider === "fake" || value.provider === "sublymus") || !isAmount(value.amountXof) || value.amountXof < 1
    || !(INTENT_STATUSES as readonly string[]).includes(String(value.status)) || !isIso(value.createdAt) || !isIsoOrNull(value.completedAt)
    || !(value.checkoutOpened === null || typeof value.checkoutOpened === "boolean") || !shortTextOrNull(value.providerStatus, 32)
    || !(value.catchupAttempts === null || isAmount(value.catchupAttempts)) || !isIsoOrNull(value.nextCatchupAt) || !isIsoOrNull(value.lastCatchupAt)
    || !shortTextOrNull(value.lastCatchupOutcome, 32) || !(value.catchupDone === null || typeof value.catchupDone === "boolean")
  ) bad(status);
  const entry = value as Json;
  return {
    id: entry.id as string, provider: entry.provider as "fake" | "sublymus", amountXof: entry.amountXof as number, status: entry.status as PaymentsOverviewIntent["status"],
    createdAt: entry.createdAt as string, completedAt: entry.completedAt as string | null, checkoutOpened: entry.checkoutOpened as boolean | null,
    providerStatus: entry.providerStatus as string | null, catchupAttempts: entry.catchupAttempts as number | null, nextCatchupAt: entry.nextCatchupAt as string | null,
    lastCatchupAt: entry.lastCatchupAt as string | null, lastCatchupOutcome: entry.lastCatchupOutcome as string | null, catchupDone: entry.catchupDone as boolean | null,
  };
}

function parseOverview(status: number, value: unknown): PaymentsOverview {
  if (
    !isObject(value) || value.contractVersion !== ADMIN_PAYMENTS_CONTRACT_VERSION || !(value.provider === "fake" || value.provider === "sublymus" || value.provider === "misconfigured")
    || !isAmount(value.openAnomalies) || !Array.isArray(value.anomalies) || value.anomalies.length > 200 || !Array.isArray(value.intents) || value.intents.length > 200
    || !isObject(value.catchup) || !isAmount(value.catchup.waiting) || !isAmount(value.catchup.overdue) || !isAmount(value.catchup.done) || !isIsoOrNull(value.catchup.lastRunAt)
    || !isObject(value.webhooks) || !isAmount(value.webhooks.last24h) || !isIsoOrNull(value.webhooks.lastReceivedAt) || !isIso(value.readAt)
  ) bad(status);
  const body = value as Json;
  const catchup = body.catchup as Json;
  const webhooks = body.webhooks as Json;
  return {
    provider: body.provider as PaymentsOverview["provider"],
    openAnomalies: body.openAnomalies as number,
    anomalies: (body.anomalies as unknown[]).map((entry) => parseAnomaly(status, entry)),
    intents: (body.intents as unknown[]).map((entry) => parseIntent(status, entry)),
    catchup: { waiting: catchup.waiting as number, overdue: catchup.overdue as number, done: catchup.done as number, lastRunAt: catchup.lastRunAt as string | null },
    webhooks: { last24h: webhooks.last24h as number, lastReceivedAt: webhooks.lastReceivedAt as string | null },
    readAt: body.readAt as string,
  };
}

export interface PaymentsAdminClientOptions {
  fetch?: typeof fetch;
}

export function createPaymentsAdminClient(options: PaymentsAdminClientOptions = {}) {
  async function send(method: "GET" | "POST", path: string, body?: unknown, requestOptions: RequestOptions = {}): Promise<{ status: number; json: unknown }> {
    const headers: Record<string, string> = { Accept: "application/json" };
    const init: RequestInit = { method, headers, credentials: "same-origin", cache: "no-store", signal: requestOptions.signal };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    let response: Response;
    try {
      response = await (options.fetch ?? fetch)(path, init);
    } catch {
      throw new ApiError(0, requestOptions.signal?.aborted ? API_ABORTED : API_NETWORK_ERROR, requestOptions.signal?.aborted ? "Requête interrompue." : "Connexion au serveur impossible.");
    }
    let json: unknown = undefined;
    try {
      json = await response.json();
    } catch {
      json = undefined;
    }
    if (!response.ok) {
      if (isObject(json) && isObject(json.error) && typeof json.error.code === "string" && ERROR_CODE.test(json.error.code) && typeof json.error.message === "string" && json.error.message.length <= 500) {
        throw new ApiError(response.status, json.error.code, json.error.message);
      }
      throw new ApiError(response.status, API_INVALID_RESPONSE, FIXED_MESSAGE);
    }
    return { status: response.status, json };
  }

  return {
    adminPayments: {
      /** GET /api/admin/payments : intentions récentes, anomalies de rapprochement, état du rattrapage et des webhooks (aucune donnée personnelle). */
      async overview(requestOptions?: RequestOptions): Promise<PaymentsOverview> {
        const { status, json } = await send("GET", "/api/admin/payments", undefined, requestOptions);
        return parseOverview(status, json);
      },
      /** POST /api/admin/payments/anomalies/{id}/resolve `{}` : marque l'anomalie comme traitée (idempotent). */
      async resolveAnomaly(anomalyId: string, requestOptions?: RequestOptions): Promise<{ changed: boolean }> {
        if (!isUuid(anomalyId)) throw new ApiError(0, API_INVALID_ARGUMENT, "Paramètre invalide.");
        const { status, json } = await send("POST", `/api/admin/payments/anomalies/${anomalyId}/resolve`, {}, requestOptions);
        if (!isObject(json) || json.contractVersion !== ADMIN_PAYMENTS_CONTRACT_VERSION || typeof json.changed !== "boolean") bad(status);
        return { changed: (json as Json).changed as boolean };
      },
    },
  };
}

export type PaymentsAdminClient = ReturnType<typeof createPaymentsAdminClient>;
export const paymentsAdminApi: PaymentsAdminClient = createPaymentsAdminClient();
