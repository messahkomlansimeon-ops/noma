import "server-only";

import type { Pool } from "pg";
import { requireTransactionPool } from "../catalog/validation";
import type { SmsBudgetCounts, SmsBudgetPlan } from "./budget";
import { readBudgetCounts, utcDayStart } from "./journal";
import { createMenoClient, MenoUsageError, type MenoUsage } from "./meno";
import { isMenoActive, readSmsConfig, SMS_UNIT_PRICE_XOF, type Environment, type SmsProvider } from "./config";
import { SMS_STALE_PENDING_MS } from "./sender";

/**
 * Lectures de l'administration des SMS (lot SMS1) : consommation du mois UTC lue chez le fournisseur (GET /usage, côté serveur, cache de 60 s), décompte local du journal
 * `sms_sends`, et liste des envois INCERTAINS à rapprocher (numéro masqué : deux derniers chiffres seulement). Aucune action : jamais de renvoi automatique.
 * Lot SMS1-bis : budgets du jour (consommation par rapport au plan : total, codes, numéros inconnus et leur heure glissante, notifications) et envois `failed` des dernières 24 h
 * (rien n'est parti, mais la ligne est visible : un échec n'est jamais invisible).
 */

export const ADMIN_SMS_CONTRACT_VERSION = "admin-sms/v1" as const;
export const SMS_USAGE_CACHE_MS = 60_000;
/** Un échec de lecture de la consommation est gardé peu de temps : une page rechargée en boucle ne martèle pas le fournisseur. */
export const SMS_USAGE_ERROR_CACHE_MS = 10_000;
export const ADMIN_SMS_RECONCILE_LIMIT = 50;
export const ADMIN_SMS_FAILED_LIMIT = 20;
export const ADMIN_SMS_FAILED_WINDOW_MS = 24 * 3_600_000;

export interface UsageReading {
  usage: (MenoUsage & { cachedAt: string }) | null;
  /** Code stable (jamais un message du fournisseur), null si la lecture a réussi. */
  usageError: string | null;
}

export interface UsageCache {
  read(): Promise<UsageReading>;
}

/** Cache de la consommation : 60 s, une seule requête en vol à la fois (les lectures simultanées partagent la même). `fetchUsage` null : fournisseur non actif. */
export function createUsageCache(options: { fetchUsage: (() => Promise<MenoUsage>) | null; ttlMs?: number; errorTtlMs?: number; now?: () => number }): UsageCache {
  const ttlMs = options.ttlMs ?? SMS_USAGE_CACHE_MS;
  const errorTtlMs = options.errorTtlMs ?? SMS_USAGE_ERROR_CACHE_MS;
  const now = options.now ?? (() => Date.now());
  let cached: { at: number; reading: UsageReading; ttl: number } | null = null;
  let inFlight: Promise<UsageReading> | null = null;

  async function fetchFresh(): Promise<UsageReading> {
    const fetchUsage = options.fetchUsage;
    if (!fetchUsage) return { usage: null, usageError: "provider_inactive" };
    const startedAt = now();
    try {
      const usage = await fetchUsage();
      const reading: UsageReading = { usage: { ...usage, cachedAt: new Date(startedAt).toISOString() }, usageError: null };
      cached = { at: now(), reading, ttl: ttlMs };
      return reading;
    } catch (error) {
      const code = error instanceof MenoUsageError ? error.code : "usage_unreachable";
      const reading: UsageReading = { usage: null, usageError: code };
      cached = { at: now(), reading, ttl: errorTtlMs };
      return reading;
    }
  }

  return {
    async read() {
      if (cached && now() - cached.at < cached.ttl) return cached.reading;
      inFlight ??= fetchFresh().finally(() => {
        inFlight = null;
      });
      return inFlight;
    },
  };
}

const usageCaches = new Map<string, UsageCache>();

/** Cache de consommation du runtime pour l'environnement donné (un par base et clé) ; sans branchement actif, `fetchUsage` est null. */
export function resolveUsageCache(env: Environment = process.env): UsageCache {
  const config = readSmsConfig(env);
  if (!isMenoActive(config) || config.apiKey === null) return createUsageCache({ fetchUsage: null });
  const key = `${config.baseUrl}\u0000${config.apiKey}`;
  let cache = usageCaches.get(key);
  if (!cache) {
    const client = createMenoClient({ apiKey: config.apiKey, baseUrl: config.baseUrl });
    cache = createUsageCache({ fetchUsage: () => client.usage() });
    usageCaches.set(key, cache);
  }
  return cache;
}

export interface UncertainSend {
  id: string;
  purpose: "otp" | "notification" | "smoke";
  /** « +••••••••••12 » : seuls les deux derniers chiffres. */
  maskedPhone: string;
  /** `uncertain`, ou `pending` resté trop longtemps (processus mort pendant l'appel). */
  status: "uncertain" | "pending";
  createdAt: Date;
  httpStatus: number | null;
  errorCode: string | null;
  providerId: string | null;
  attempts: number;
}

/** Un envoi `failed` récent : rien n'est parti (budget, fournisseur injoignable, cadence). Numéro masqué, aucun détail du fournisseur. */
export interface FailedSend {
  id: string;
  purpose: "otp" | "notification" | "smoke";
  maskedPhone: string;
  createdAt: Date;
  httpStatus: number | null;
  errorCode: string | null;
  attempts: number;
}

/** Budgets du jour UTC : le plan (NOMA_SMS_DAILY_CAP découpé) et la consommation lue dans le journal (pending, accepted, uncertain). */
export interface BudgetReading {
  day: string;
  plan: SmsBudgetPlan;
  used: SmsBudgetCounts;
}

export interface LocalTally {
  /** Mois UTC « AAAA-MM ». */
  month: string;
  accepted: number;
  uncertain: number;
  rejected: number;
  failed: number;
  pending: number;
}

export interface SmsAdminReading {
  provider: { mode: SmsProvider; active: boolean; unitPriceXof: number };
  local: LocalTally;
  uncertain: UncertainSend[];
  recentFailed: FailedSend[];
  budget: BudgetReading;
  readAt: Date;
}

function safeCount(value: string | number | null): number {
  const parsed = Number(value ?? 0);
  return Number.isSafeInteger(parsed) ? parsed : 0;
}

/** Numéro masqué d'après les deux derniers chiffres seulement (+225 : 13 chiffres au total). */
export function maskedFromLast2(last2: string): string {
  return `+${"•".repeat(11)}${/^[0-9]{2}$/.test(last2) ? last2 : "00"}`;
}

export async function readSmsAdmin(input: { pool: Pool; env?: Environment; now?: Date }): Promise<SmsAdminReading> {
  const pool = requireTransactionPool(input.pool);
  const env = input.env ?? process.env;
  const config = readSmsConfig(env);
  const readAt = input.now ?? new Date();
  const monthStart = new Date(Date.UTC(readAt.getUTCFullYear(), readAt.getUTCMonth(), 1));
  const monthLabel = `${readAt.getUTCFullYear()}-${String(readAt.getUTCMonth() + 1).padStart(2, "0")}`;
  const tally = await pool.query<{ status: string; n: string }>(
    "SELECT status, count(*)::text AS n FROM sms_sends WHERE created_at >= $1::timestamptz GROUP BY status",
    [monthStart],
  );
  const counts: Record<string, number> = {};
  for (const row of tally.rows) counts[row.status] = safeCount(row.n);
  const staleBefore = new Date(readAt.getTime() - SMS_STALE_PENDING_MS);
  const rows = await pool.query<{
    id: string;
    purpose: "otp" | "notification" | "smoke";
    phone_last2: string;
    status: "uncertain" | "pending";
    created_at: Date;
    http_status: number | null;
    error_code: string | null;
    provider_id: string | null;
    attempts: number;
  }>(
    `SELECT id, purpose, phone_last2, status, created_at, http_status, error_code, provider_id, attempts
       FROM sms_sends
      WHERE status = 'uncertain' OR (status = 'pending' AND updated_at < $1::timestamptz)
      ORDER BY created_at DESC, id DESC
      LIMIT $2::int`,
    [staleBefore, ADMIN_SMS_RECONCILE_LIMIT],
  );
  const failed = await pool.query<{
    id: string;
    purpose: "otp" | "notification" | "smoke";
    phone_last2: string;
    created_at: Date;
    http_status: number | null;
    error_code: string | null;
    attempts: number;
  }>(
    `SELECT id, purpose, phone_last2, created_at, http_status, error_code, attempts
       FROM sms_sends
      WHERE status = 'failed' AND created_at >= $1::timestamptz
      ORDER BY created_at DESC, id DESC
      LIMIT $2::int`,
    [new Date(readAt.getTime() - ADMIN_SMS_FAILED_WINDOW_MS), ADMIN_SMS_FAILED_LIMIT],
  );
  const dayStart = utcDayStart(readAt);
  const used = await readBudgetCounts(pool, dayStart, readAt);
  return {
    provider: { mode: config.provider, active: isMenoActive(config), unitPriceXof: SMS_UNIT_PRICE_XOF },
    local: {
      month: monthLabel,
      accepted: counts.accepted ?? 0,
      uncertain: counts.uncertain ?? 0,
      rejected: counts.rejected ?? 0,
      failed: counts.failed ?? 0,
      pending: counts.pending ?? 0,
    },
    uncertain: rows.rows.map((row) => ({
      id: row.id,
      purpose: row.purpose,
      maskedPhone: maskedFromLast2(row.phone_last2),
      status: row.status,
      createdAt: row.created_at,
      httpStatus: row.http_status,
      errorCode: row.error_code,
      providerId: row.provider_id,
      attempts: row.attempts,
    })),
    recentFailed: failed.rows.map((row) => ({
      id: row.id,
      purpose: row.purpose,
      maskedPhone: maskedFromLast2(row.phone_last2),
      createdAt: row.created_at,
      httpStatus: row.http_status,
      errorCode: row.error_code,
      attempts: row.attempts,
    })),
    budget: { day: dayStart.toISOString().slice(0, 10), plan: config.budget, used },
    readAt,
  };
}
