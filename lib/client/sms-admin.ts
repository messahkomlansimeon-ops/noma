/**
 * Couche cliente et présentation de l'administration des SMS (lot SMS1) : module partagé navigateur (aucun import serveur). Contrat : lib/server/sms/admin-http.ts
 * (`admin-sms/v1`). Réponses relues champ par champ (liste blanche) ; toute erreur devient une `ApiError { status, code }` construite uniquement depuis le corps du serveur
 * ou d'un code fixe, comme `social-api.ts`. Numéros : seulement les deux derniers chiffres (masqués côté serveur). Aucune action : pas de renvoi depuis cet écran.
 */

import { API_ABORTED, API_INVALID_RESPONSE, API_NETWORK_ERROR, ApiError, isUuid, type RequestOptions } from "./api";
import { formatDateTimeFr, formatFcfa } from "./wallet-view";

export const ADMIN_SMS_CONTRACT_VERSION = "admin-sms/v1";
export const SMS_TITLE = "SMS";
export const SMS_NOTE = "Lecture seule. Chaque SMS accepté coûte 15 F CFA. Un envoi incertain n'est JAMAIS renvoyé automatiquement : vérifiez-le chez le fournisseur avec son identifiant.";
export const SMS_UNCERTAIN_EMPTY = "Aucun envoi incertain à rapprocher.";
export const SMS_FAILED_EMPTY = "Aucun envoi échoué ces dernières 24 h.";
export const SMS_FAILED_NOTE = "Échoués : rien n'est parti (fournisseur injoignable, cadence dépassée). Un envoi dont le sort est inconnu est « incertain », jamais « échoué ». Un refus pour budget ne laisse aucune ligne : voir « Budgets du jour » (codes non envoyés faute de capacité).";

export type SmsPurposeLabel = "otp" | "notification" | "smoke";

export interface SmsUsage {
  accepted: number;
  uncertain: number;
  rejected: number;
  acceptedAmountXof: number;
  unitPriceXof: number;
  currency: string;
  cachedAt: string;
}

export interface SmsUncertainRow {
  id: string;
  purpose: SmsPurposeLabel;
  maskedPhone: string;
  status: "uncertain" | "pending";
  createdAt: string;
  httpStatus: number | null;
  errorCode: string | null;
  providerId: string | null;
  attempts: number;
}

export interface SmsFailedRow {
  id: string;
  purpose: SmsPurposeLabel;
  maskedPhone: string;
  createdAt: string;
  httpStatus: number | null;
  errorCode: string | null;
  attempts: number;
}

export interface SmsBudgetPlanView {
  total: number;
  notifications: number;
  codes: number;
  existingReserve: number;
  newNumbers: number;
  newNumbersPerHour: number;
}

export interface SmsBudgetUsedView {
  total: number;
  codes: number;
  newNumbers: number;
  newNumbersHour: number;
  notifications: number;
}

export interface SmsUnsentCodesView {
  windowHours: 24;
  total: number;
  byCode: { code: string; count: number }[];
}

export interface SmsAdminOverview {
  provider: { mode: "none" | "console" | "meno" | "invalid"; active: boolean; unitPriceXof: number };
  usage: SmsUsage | null;
  usageError: string | null;
  local: { month: string; accepted: number; uncertain: number; rejected: number; failed: number; pending: number };
  uncertain: SmsUncertainRow[];
  recentFailed: SmsFailedRow[];
  budget: { day: string; plan: SmsBudgetPlanView; used: SmsBudgetUsedView };
  unsentCodes: SmsUnsentCodesView;
  readAt: string;
}

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const isCount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const isIso = (value: unknown): value is string => typeof value === "string" && value.length <= 40 && !Number.isNaN(Date.parse(value));
const ERROR_CODE = /^[a-z][a-z0-9_]{0,63}$/;
const FIXED_ERROR = "Une erreur est survenue. Réessayez dans un instant.";

function invalid(status: number): never {
  throw new ApiError(status, API_INVALID_RESPONSE, FIXED_ERROR);
}

function need(status: number, condition: boolean): void {
  if (!condition) invalid(status);
}

function parseUsage(status: number, value: unknown): SmsUsage | null {
  if (value === null) return null;
  need(status, isObject(value) && [value.accepted, value.uncertain, value.rejected, value.acceptedAmountXof, value.unitPriceXof].every(isCount) && typeof value.currency === "string" && /^[A-Z]{3}$/.test(value.currency) && isIso(value.cachedAt));
  const usage = value as Json;
  return {
    accepted: usage.accepted as number,
    uncertain: usage.uncertain as number,
    rejected: usage.rejected as number,
    acceptedAmountXof: usage.acceptedAmountXof as number,
    unitPriceXof: usage.unitPriceXof as number,
    currency: usage.currency as string,
    cachedAt: usage.cachedAt as string,
  };
}

function parseRow(status: number, value: unknown): SmsUncertainRow {
  need(
    status,
    isObject(value) && isUuid(value.id) && (value.purpose === "otp" || value.purpose === "notification" || value.purpose === "smoke") &&
      typeof value.maskedPhone === "string" && /^\+•{1,15}[0-9]{2}$/.test(value.maskedPhone) && (value.status === "uncertain" || value.status === "pending") && isIso(value.createdAt) &&
      (value.httpStatus === null || (isCount(value.httpStatus) && value.httpStatus >= 100 && value.httpStatus <= 599)) &&
      (value.errorCode === null || (typeof value.errorCode === "string" && /^[a-z0-9_]{1,60}$/.test(value.errorCode))) &&
      (value.providerId === null || (typeof value.providerId === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(value.providerId))) && isCount(value.attempts),
  );
  const row = value as Json;
  return {
    id: row.id as string,
    purpose: row.purpose as SmsPurposeLabel,
    maskedPhone: row.maskedPhone as string,
    status: row.status as "uncertain" | "pending",
    createdAt: row.createdAt as string,
    httpStatus: row.httpStatus as number | null,
    errorCode: row.errorCode as string | null,
    providerId: row.providerId as string | null,
    attempts: row.attempts as number,
  };
}

function parseFailedRow(status: number, value: unknown): SmsFailedRow {
  need(
    status,
    isObject(value) && isUuid(value.id) && (value.purpose === "otp" || value.purpose === "notification" || value.purpose === "smoke") &&
      typeof value.maskedPhone === "string" && /^\+•{1,15}[0-9]{2}$/.test(value.maskedPhone) && isIso(value.createdAt) &&
      (value.httpStatus === null || (isCount(value.httpStatus) && value.httpStatus >= 100 && value.httpStatus <= 599)) &&
      (value.errorCode === null || (typeof value.errorCode === "string" && /^[a-z0-9_]{1,60}$/.test(value.errorCode))) && isCount(value.attempts),
  );
  const row = value as Json;
  return {
    id: row.id as string,
    purpose: row.purpose as SmsPurposeLabel,
    maskedPhone: row.maskedPhone as string,
    createdAt: row.createdAt as string,
    httpStatus: row.httpStatus as number | null,
    errorCode: row.errorCode as string | null,
    attempts: row.attempts as number,
  };
}

function parseBudget(status: number, value: unknown): SmsAdminOverview["budget"] {
  need(status, isObject(value) && typeof value.day === "string" && /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value.day) && isObject(value.plan) && isObject(value.used));
  const budget = value as Json;
  const plan = budget.plan as Json;
  const used = budget.used as Json;
  need(status, [plan.total, plan.notifications, plan.codes, plan.existingReserve, plan.newNumbers, plan.newNumbersPerHour].every(isCount));
  need(status, [used.total, used.codes, used.newNumbers, used.newNumbersHour, used.notifications].every(isCount));
  return {
    day: budget.day as string,
    plan: {
      total: plan.total as number,
      notifications: plan.notifications as number,
      codes: plan.codes as number,
      existingReserve: plan.existingReserve as number,
      newNumbers: plan.newNumbers as number,
      newNumbersPerHour: plan.newNumbersPerHour as number,
    },
    used: {
      total: used.total as number,
      codes: used.codes as number,
      newNumbers: used.newNumbers as number,
      newNumbersHour: used.newNumbersHour as number,
      notifications: used.notifications as number,
    },
  };
}

function parseUnsentCodes(status: number, value: unknown): SmsUnsentCodesView {
  need(status, isObject(value) && value.windowHours === 24 && isCount(value.total) && Array.isArray(value.byCode) && value.byCode.length <= 20);
  const unsent = value as Json;
  const byCode = (unsent.byCode as unknown[]).map((entry) => {
    need(status, isObject(entry) && typeof entry.code === "string" && /^[a-z0-9_]{1,60}$/.test(entry.code) && isCount(entry.count));
    return { code: (entry as Json).code as string, count: (entry as Json).count as number };
  });
  return { windowHours: 24, total: unsent.total as number, byCode };
}

export function parseSmsAdminOverview(status: number, json: unknown): SmsAdminOverview {
  need(status, isObject(json) && json.contractVersion === ADMIN_SMS_CONTRACT_VERSION && isObject(json.provider) && isObject(json.local) && Array.isArray(json.uncertain) && Array.isArray(json.recentFailed) && isIso(json.readAt));
  const body = json as Json;
  const provider = body.provider as Json;
  const local = body.local as Json;
  need(status, (provider.mode === "none" || provider.mode === "console" || provider.mode === "meno" || provider.mode === "invalid") && typeof provider.active === "boolean" && isCount(provider.unitPriceXof));
  need(status, typeof local.month === "string" && /^[0-9]{4}-[0-9]{2}$/.test(local.month) && [local.accepted, local.uncertain, local.rejected, local.failed, local.pending].every(isCount));
  need(status, body.usageError === null || (typeof body.usageError === "string" && /^[a-z0-9_]{1,60}$/.test(body.usageError)));
  return {
    provider: { mode: provider.mode as SmsAdminOverview["provider"]["mode"], active: provider.active as boolean, unitPriceXof: provider.unitPriceXof as number },
    usage: parseUsage(status, body.usage),
    usageError: body.usageError as string | null,
    local: {
      month: local.month as string,
      accepted: local.accepted as number,
      uncertain: local.uncertain as number,
      rejected: local.rejected as number,
      failed: local.failed as number,
      pending: local.pending as number,
    },
    uncertain: (body.uncertain as unknown[]).map((row) => parseRow(status, row)),
    recentFailed: (body.recentFailed as unknown[]).map((row) => parseFailedRow(status, row)),
    budget: parseBudget(status, body.budget),
    unsentCodes: parseUnsentCodes(status, body.unsentCodes),
    readAt: body.readAt as string,
  };
}

export async function loadSmsAdmin(options: RequestOptions & { fetchImpl?: typeof fetch } = {}): Promise<SmsAdminOverview> {
  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)("/api/admin/sms", { method: "GET", headers: { Accept: "application/json" }, credentials: "same-origin", cache: "no-store", signal: options.signal });
  } catch {
    throw new ApiError(0, options.signal?.aborted ? API_ABORTED : API_NETWORK_ERROR, FIXED_ERROR);
  }
  let json: unknown;
  try {
    json = await response.json();
  } catch {
    json = undefined;
  }
  if (!response.ok) {
    if (isObject(json) && isObject(json.error) && typeof json.error.code === "string" && ERROR_CODE.test(json.error.code) && typeof json.error.message === "string" && json.error.message.length <= 500) {
      throw new ApiError(response.status, json.error.code, json.error.message);
    }
    invalid(response.status);
  }
  return parseSmsAdminOverview(response.status, json);
}

// ───────────── présentation ─────────────

export const PURPOSE_LABELS: Readonly<Record<SmsPurposeLabel, string>> = Object.freeze({ otp: "Code de connexion", notification: "Notification", smoke: "Essai" });

export const USAGE_ERROR_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  provider_inactive: "Le fournisseur n'est pas activé : aucune consommation à lire.",
  usage_unreachable: "Consommation indisponible : le fournisseur ne répond pas.",
  usage_unauthorized: "Consommation indisponible : la clé du fournisseur est refusée.",
  usage_http_error: "Consommation indisponible : réponse inattendue du fournisseur.",
  usage_invalid_response: "Consommation indisponible : réponse illisible du fournisseur.",
});

export function usageErrorMessage(code: string): string {
  return USAGE_ERROR_MESSAGES[code] ?? "Consommation indisponible.";
}

export function providerLine(provider: SmsAdminOverview["provider"]): string {
  if (provider.active) return "Fournisseur Meno : actif.";
  if (provider.mode === "meno") return "Fournisseur Meno : demandé mais inactif (clé absente ou invalide).";
  return "Fournisseur Meno : désactivé (aucun SMS réel n'est envoyé).";
}

export function usageLines(usage: SmsUsage): string[] {
  return [
    `Acceptés ce mois : ${usage.accepted} (${formatFcfa(usage.acceptedAmountXof)})`,
    `Incertains : ${usage.uncertain} · Refusés : ${usage.rejected}`,
    `Prix unitaire : ${formatFcfa(usage.unitPriceXof)} · lu le ${formatDateTimeFr(usage.cachedAt)}`,
  ];
}

export function localLines(local: SmsAdminOverview["local"]): string[] {
  return [`Journal local (${local.month}) : ${local.accepted} acceptés · ${local.uncertain} incertains · ${local.rejected} refusés · ${local.failed} échoués · ${local.pending} en cours`];
}

/** Consommation du jour par rapport aux budgets : « codes 12/600 · numéros inconnus 5/300 (38 par heure : 3) · notifications 4/400 · total 21/1000 ». */
export function budgetLines(budget: SmsAdminOverview["budget"]): string[] {
  const { plan, used } = budget;
  return [
    `Budgets du jour (${budget.day}, UTC) : total ${used.total}/${plan.total}`,
    `Codes de connexion : ${used.codes}/${plan.codes} (dont ${plan.existingReserve} réservés aux numéros qui ont déjà un compte)`,
    `Numéros inconnus : ${used.newNumbers}/${plan.newNumbers} · cette heure : ${used.newNumbersHour}/${plan.newNumbersPerHour}`,
    `Notifications : ${used.notifications}/${plan.notifications}`,
  ];
}

/** Codes de connexion non envoyés faute de capacité (24 h) : la réponse au visiteur est identique à un succès, la trace est ici. */
export function unsentCodeLines(unsent: SmsUnsentCodesView): string[] {
  if (unsent.total === 0) return ["Codes non envoyés faute de capacité (24 h) : aucun"];
  return [`Codes non envoyés faute de capacité (24 h) : ${unsent.total}`, ...unsent.byCode.map((entry) => `${entry.code} : ${entry.count}`)];
}

export interface FailedView {
  id: string;
  title: string;
  detail: string;
}

export function failedRows(rows: readonly SmsFailedRow[]): FailedView[] {
  return rows.map((row) => ({
    id: row.id,
    title: `${formatDateTimeFr(row.createdAt)} · ${PURPOSE_LABELS[row.purpose]} · ${row.maskedPhone}`,
    detail: ["Rien n'est parti", row.httpStatus === null ? null : `HTTP ${row.httpStatus}`, row.errorCode].filter((part): part is string => part !== null).join(" · "),
  }));
}

export interface UncertainView {
  id: string;
  title: string;
  detail: string;
}

export function uncertainRows(rows: readonly SmsUncertainRow[]): UncertainView[] {
  return rows.map((row) => ({
    id: row.id,
    title: `${formatDateTimeFr(row.createdAt)} · ${PURPOSE_LABELS[row.purpose]} · ${row.maskedPhone}`,
    detail: [
      row.status === "pending" ? "Interrompu pendant l'appel" : "Résultat incertain",
      row.httpStatus === null ? null : `HTTP ${row.httpStatus}`,
      row.errorCode,
      row.providerId === null ? "identifiant du fournisseur inconnu" : `identifiant ${row.providerId}`,
    ].filter((part): part is string => part !== null).join(" · "),
  }));
}
