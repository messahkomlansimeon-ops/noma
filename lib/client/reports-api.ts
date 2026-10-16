/**
 * Couche cliente des signalements et des dossiers de modération (lot FIN3-C2) : module partagé navigateur (aucun import serveur), mêmes règles que `missions-api.ts` : fetch même
 * origine, JSON, toute erreur devient une `ApiError { status, code }` construite UNIQUEMENT depuis le corps `{ error: { code, message } }` du serveur (ou un code fixe), réponses relues
 * champ par champ (liste blanche). Contrat : lib/server/reports/http.ts et lib/server/admin/http.ts (`reports/v1`). Voir SIGNALEMENTS.md.
 */

import { API_ABORTED, API_INVALID_ID, API_INVALID_RESPONSE, API_NETWORK_ERROR, ApiError, isUuid, type RequestOptions } from "./api";
import {
  REPORTS_CONTRACT_VERSION,
  REPORT_DECISIONS,
  REPORT_REASONS,
  REPORT_STATUSES,
  REPORT_TARGET_TYPES,
  checkDecisionInput,
  checkReportInput,
  type DecisionInput,
  type ReportDecision,
  type ReportInput,
  type ReportReason,
  type ReportStatus,
  type ReportTargetType,
} from "../reports-rules";

export { REPORTS_CONTRACT_VERSION };

export interface MyReport {
  id: string;
  targetType: ReportTargetType;
  reason: ReportReason;
  status: ReportStatus;
  targetTitle: string;
  createdAt: string;
}

export interface AdminReportRow {
  id: string;
  status: ReportStatus;
  targetType: ReportTargetType;
  reason: ReportReason;
  targetTitle: string;
  reporterMaskedPhone: string | null;
  reportedMaskedPhone: string | null;
  reportedOpenCount: number;
  decision: ReportDecision | null;
  createdAt: string;
}

export interface AdminReportsPage {
  total: number;
  limit: number;
  offset: number;
  reports: AdminReportRow[];
}

export interface AdminReportDetail extends AdminReportRow {
  reportedTotalCount: number;
  reportedStatus: "active" | "suspended" | "archived";
  detail: string | null;
  decisionNote: string | null;
  decidedAt: string | null;
  decidedByMaskedPhone: string | null;
  offer: { status: string; availability: string | null; priceAmount: number | null; priceCurrency: string | null } | null;
  order: { status: string; priceAmount: number } | null;
}

export interface DecisionResult {
  status: "closed";
  decision: ReportDecision;
  suspended: boolean;
}

const ERROR_CODE = /^[a-z][a-z0-9_]{0,63}$/;
type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const isIso = (value: unknown): value is string => typeof value === "string" && value.length <= 40 && Number.isFinite(Date.parse(value));
const isCount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const isText = (value: unknown, max = 200): value is string => typeof value === "string" && value.length >= 1 && value.length <= max;
const nullableText = (value: unknown, max: number): boolean => value === null || isText(value, max);
const oneOf = (list: readonly string[], value: unknown): boolean => typeof value === "string" && list.includes(value);

function fixedError(status: number, code: string): ApiError {
  const messages: Record<string, string> = {
    [API_NETWORK_ERROR]: "Connexion au serveur impossible.",
    [API_INVALID_RESPONSE]: "Réponse du serveur inattendue.",
    [API_ABORTED]: "Requête interrompue.",
    [API_INVALID_ID]: "Identifiant invalide.",
    invalid_argument: "Paramètre invalide.",
    phone_number_in_report: "Pas de numéro de téléphone dans le texte.",
  };
  return new ApiError(status, code, messages[code] ?? messages[API_INVALID_RESPONSE]);
}

function need(status: number, condition: boolean): void {
  if (!condition) throw fixedError(status, API_INVALID_RESPONSE);
}

function parseRow(status: number, value: unknown): AdminReportRow {
  need(
    status,
    isObject(value) && isUuid(value.id) && oneOf(REPORT_STATUSES, value.status) && oneOf(REPORT_TARGET_TYPES, value.targetType) && oneOf(REPORT_REASONS, value.reason) && isText(value.targetTitle, 200) &&
      nullableText(value.reporterMaskedPhone, 40) && nullableText(value.reportedMaskedPhone, 40) && isCount(value.reportedOpenCount) && (value.decision === null || oneOf(REPORT_DECISIONS, value.decision)) &&
      isIso(value.createdAt),
  );
  const r = value as Json;
  return {
    id: r.id as string,
    status: r.status as ReportStatus,
    targetType: r.targetType as ReportTargetType,
    reason: r.reason as ReportReason,
    targetTitle: r.targetTitle as string,
    reporterMaskedPhone: r.reporterMaskedPhone as string | null,
    reportedMaskedPhone: r.reportedMaskedPhone as string | null,
    reportedOpenCount: r.reportedOpenCount as number,
    decision: r.decision as ReportDecision | null,
    createdAt: r.createdAt as string,
  };
}

function parseDetail(status: number, value: unknown): AdminReportDetail {
  const row = parseRow(status, value);
  const r = value as Json;
  const offer = r.offer;
  const order = r.order;
  need(
    status,
    isCount(r.reportedTotalCount) && oneOf(["active", "suspended", "archived"], r.reportedStatus) && nullableText(r.detail, 500) && nullableText(r.decisionNote, 500) &&
      (r.decidedAt === null || isIso(r.decidedAt)) && nullableText(r.decidedByMaskedPhone, 40) &&
      (offer === null || (isObject(offer) && typeof offer.status === "string" && (offer.availability === null || typeof offer.availability === "string") &&
        (offer.priceAmount === null || isCount(offer.priceAmount)) && (offer.priceCurrency === null || typeof offer.priceCurrency === "string"))) &&
      (order === null || (isObject(order) && typeof order.status === "string" && isCount(order.priceAmount))),
  );
  return {
    ...row,
    reportedTotalCount: r.reportedTotalCount as number,
    reportedStatus: r.reportedStatus as AdminReportDetail["reportedStatus"],
    detail: r.detail as string | null,
    decisionNote: r.decisionNote as string | null,
    decidedAt: r.decidedAt as string | null,
    decidedByMaskedPhone: r.decidedByMaskedPhone as string | null,
    offer: offer === null ? null : { status: (offer as Json).status as string, availability: (offer as Json).availability as string | null, priceAmount: (offer as Json).priceAmount as number | null, priceCurrency: (offer as Json).priceCurrency as string | null },
    order: order === null ? null : { status: (order as Json).status as string, priceAmount: (order as Json).priceAmount as number },
  };
}

export interface ReportsClientOptions {
  /** fetch injecté (tests) ; par défaut le fetch global, résolu à chaque appel. */
  fetch?: typeof fetch;
}

export function createReportsClient(options: ReportsClientOptions = {}) {
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
      throw fixedError(0, requestOptions.signal?.aborted ? API_ABORTED : API_NETWORK_ERROR);
    }
    let json: unknown = undefined;
    try {
      json = await response.json();
    } catch {
      json = undefined;
    }
    if (!response.ok) {
      if (isObject(json) && isObject(json.error) && typeof json.error.code === "string" && ERROR_CODE.test(json.error.code) && typeof json.error.message === "string" && json.error.message.length <= 300) {
        throw new ApiError(response.status, json.error.code, json.error.message);
      }
      throw fixedError(response.status, API_INVALID_RESPONSE);
    }
    return { status: response.status, json };
  }

  const id = (value: string): string => {
    if (!isUuid(value)) throw fixedError(0, API_INVALID_ID);
    return value;
  };

  function contract(status: number, json: unknown): Json {
    if (!isObject(json) || json.contractVersion !== REPORTS_CONTRACT_VERSION) throw fixedError(status, API_INVALID_RESPONSE);
    return json;
  }

  return {
    /** Écrit un signalement. Contrôlé AVANT l'envoi par la même règle que le serveur : un texte refusé ne part pas. */
    async create(input: ReportInput, requestOptions?: RequestOptions): Promise<{ id: string; status: "open"; createdAt: string }> {
      const checked = checkReportInput(input);
      if (!checked.ok) throw fixedError(0, checked.reason === "phone" ? "phone_number_in_report" : "invalid_argument");
      const { status, json } = await send("POST", "/api/reports", checked.value, requestOptions);
      const body = contract(status, json);
      const report = body.report;
      need(status, isObject(report) && isUuid(report.id) && report.status === "open" && isIso(report.createdAt));
      return { id: (report as Json).id as string, status: "open", createdAt: (report as Json).createdAt as string };
    },
    /** Mes signalements : ouvert ou clos seulement (jamais la décision ni le motif). */
    async mine(requestOptions?: RequestOptions): Promise<MyReport[]> {
      const { status, json } = await send("GET", "/api/reports", undefined, requestOptions);
      const body = contract(status, json);
      need(status, Array.isArray(body.reports));
      return (body.reports as unknown[]).map((entry) => {
        need(status, isObject(entry) && isUuid(entry.id) && oneOf(REPORT_TARGET_TYPES, entry.targetType) && oneOf(REPORT_REASONS, entry.reason) && oneOf(REPORT_STATUSES, entry.status) && isText(entry.targetTitle, 200) && isIso(entry.createdAt));
        const e = entry as Json;
        return { id: e.id as string, targetType: e.targetType as ReportTargetType, reason: e.reason as ReportReason, status: e.status as ReportStatus, targetTitle: e.targetTitle as string, createdAt: e.createdAt as string };
      });
    },
    admin: {
      async list(query: { status: ReportStatus; limit?: number; offset?: number }, requestOptions?: RequestOptions): Promise<AdminReportsPage> {
        if (!oneOf(REPORT_STATUSES, query.status)) throw fixedError(0, "invalid_argument");
        const parameters = new URLSearchParams({ status: query.status });
        if (query.limit !== undefined) parameters.set("limit", String(query.limit));
        if (query.offset !== undefined) parameters.set("offset", String(query.offset));
        const { status, json } = await send("GET", `/api/admin/reports?${parameters.toString()}`, undefined, requestOptions);
        const body = contract(status, json);
        need(status, isCount(body.total) && isCount(body.limit) && isCount(body.offset) && Array.isArray(body.reports));
        return { total: body.total as number, limit: body.limit as number, offset: body.offset as number, reports: (body.reports as unknown[]).map((row) => parseRow(status, row)) };
      },
      async get(reportId: string, requestOptions?: RequestOptions): Promise<AdminReportDetail> {
        const { status, json } = await send("GET", `/api/admin/reports/${id(reportId)}`, undefined, requestOptions);
        return parseDetail(status, contract(status, json).report);
      },
      /** Clôt le dossier : une décision connue et un motif obligatoire (contrôlés avant l'envoi). */
      async decide(reportId: string, input: DecisionInput, requestOptions?: RequestOptions): Promise<DecisionResult> {
        const checked = checkDecisionInput(input);
        if (!checked.ok) throw fixedError(0, checked.reason === "phone" ? "phone_number_in_report" : "invalid_argument");
        const { status, json } = await send("POST", `/api/admin/reports/${id(reportId)}/decision`, checked.value, requestOptions);
        const body = contract(status, json);
        need(status, body.status === "closed" && oneOf(REPORT_DECISIONS, body.decision) && typeof body.suspended === "boolean");
        return { status: "closed", decision: body.decision as ReportDecision, suspended: body.suspended as boolean };
      },
    },
  };
}

export type ReportsClient = ReturnType<typeof createReportsClient>;

/** Client du navigateur : fetch global, même origine. */
export const reports: ReportsClient = createReportsClient();

export type ReportErrorContext = "send" | "list" | "admin";

/** Message FIXE pour l'utilisateur d'après (contexte, statut, code) : jamais le texte d'une exception ni celui du serveur. */
export function describeReportError(error: unknown, context: ReportErrorContext): string {
  if (!(error instanceof ApiError)) return "Une erreur est survenue. Réessayez dans un instant.";
  if (error.code === API_NETWORK_ERROR) return "Connexion impossible. Vérifiez votre réseau et réessayez.";
  if (error.code === API_ABORTED) return "Requête interrompue.";
  if (error.status === 401) return "Votre session a expiré. Reconnectez-vous pour continuer.";
  if (error.status === 403) return "Requête refusée. Rechargez la page et réessayez.";
  if (error.code === "invalid_argument") return "Paramètre invalide. Rechargez la page.";
  if (error.code === "phone_number_in_report") return "Pas de numéro de téléphone dans le texte : l'équipe noma traite le signalement sans contacter personne.";
  if (error.code === "already_reported") return "Vous avez déjà signalé cet élément : le signalement est en cours de traitement.";
  if (error.code === "reports_daily_limit") return "Vous avez atteint le nombre de signalements autorisés aujourd'hui. Réessayez demain.";
  if (error.code === "report_closed") return "Ce dossier est déjà clos. La page va être actualisée.";
  if (error.code === "target_protected") return "Un compte administrateur ne peut pas être suspendu : classez le dossier sans suite.";
  if (error.code === "target_archived") return "Ce compte est archivé : il ne peut plus être suspendu. Classez le dossier sans suite.";
  if (error.status === 404) return context === "send" ? "Cet élément n'est plus signalable : il a peut-être été retiré." : "Dossier introuvable.";
  if (error.status === 503) return "Le service est temporairement indisponible. Réessayez dans un instant.";
  if (error.status === 400) return "La demande n'est pas valide. Rechargez la page.";
  return "Une erreur est survenue. Réessayez dans un instant.";
}
