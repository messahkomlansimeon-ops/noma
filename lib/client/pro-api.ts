/**
 * Couche cliente de l'offre Pro (lot PRO1) : abonnement, crédits promotionnels, avis, import de catalogue, administration des plans. Module partagé navigateur (aucun import
 * serveur), mêmes règles que `api.ts` et `social-api.ts` : fetch même origine, JSON, toute erreur devient une `ApiError { status, code }` construite UNIQUEMENT depuis le corps
 * `{ error: { code, message } }` du serveur (ou un code fixe), réponses relues champ par champ (liste blanche : un champ ajouté un jour par le serveur n'atteint jamais l'écran).
 * Contrats : lib/server/subscriptions/http.ts (`subscription/v1`, `catalog-import/v1`) et lib/server/admin/plans-http.ts (`admin-plans/v1`). Voir OFFRE-PRO.md.
 *
 * PRIX PROVISOIRES : les prix, crédits promotionnels et limites des plans de départ attendent une décision du fondateur ; le serveur le dit (`pricesProvisional`) et l'écran l'affiche.
 */

import { API_ABORTED, API_INVALID_ARGUMENT, API_INVALID_ID, API_INVALID_RESPONSE, API_NETWORK_ERROR, ApiError, isUuid, type RequestOptions } from "./api";

export const SUBSCRIPTION_CONTRACT_VERSION = "subscription/v1";
export const CATALOG_IMPORT_CONTRACT_VERSION = "catalog-import/v1";
export const ADMIN_PLANS_CONTRACT_VERSION = "admin-plans/v1";

export const ENTITLEMENTS = ["badge_pro", "catalog_import", "priority_support_label"] as const;
export type Entitlement = (typeof ENTITLEMENTS)[number];

export const NOTICE_CODES = ["renewal_failed", "subscription_ended", "listings_paused", "listings_restored"] as const;
export type SubscriptionNoticeCode = (typeof NOTICE_CODES)[number];

export type SubscriptionStatus = "active" | "past_due";

export interface PlanView {
  code: string;
  name: string;
  version: number;
  monthlyPriceXof: number;
  promoCreditsXof: number;
  maxOnlineOffers: number;
  entitlements: Entitlement[];
}

export interface CurrentPlan {
  source: "free" | "subscription";
  planCode: string;
  planName: string;
  maxOnlineOffers: number;
  entitlements: Entitlement[];
}

export interface SubscriptionView {
  planCode: string;
  status: SubscriptionStatus;
  periodStart: string;
  periodEnd: string;
  autoRenew: boolean;
  canceledAt: string | null;
  graceEndsAt: string | null;
  currentPriceXof: number;
  renewalPriceXof: number;
  entitled: boolean;
}

export interface SubscriptionNoticeView {
  id: string;
  code: SubscriptionNoticeCode;
  listingCount: number | null;
  createdAt: string;
  readAt: string | null;
}

export interface SubscriptionState {
  pricesProvisional: boolean;
  plans: PlanView[];
  current: CurrentPlan;
  onlineOffers: number;
  subscription: SubscriptionView | null;
  promo: { balanceXof: number; expiresAt: string | null };
  notices: SubscriptionNoticeView[];
  unreadNotices: number;
  readAt: string;
}

export interface SubscribeResult {
  /** Vrai si la même clé d'idempotence avait déjà servi : aucun nouveau débit. */
  reused: boolean;
  state: SubscriptionState;
}

export type ImportOutcome = "created" | "would_create" | "rejected";

export interface ImportRowReport {
  line: number;
  outcome: ImportOutcome;
  code: string | null;
  field: string | null;
  offerId: string | null;
}

export interface CatalogImportResult {
  mode: "preview" | "apply";
  alreadyApplied: boolean;
  rowCount: number;
  acceptedCount: number;
  rejectedCount: number;
  rows: ImportRowReport[];
}

export interface AdminPlanVersion {
  version: number;
  name: string;
  monthlyPriceXof: number;
  promoCreditsXof: number;
  maxOnlineOffers: number;
  entitlements: Entitlement[];
  createdAt: string;
}

export interface AdminPlansOverview {
  pricesProvisional: boolean;
  plans: Array<{ code: string; versions: AdminPlanVersion[] }>;
  subscribers: Array<{ planCode: string; approximateCount: number }>;
  totalSubscribersApproximate: number;
  month: { startsAt: string; endsAt: string };
  subscriptionRevenueXof: number;
  promo: { issuedXof: number; spentXof: number; expiredXof: number };
  readAt: string;
}

export interface NewPlanVersionRequest {
  name: string;
  monthlyPriceXof: number;
  promoCreditsXof: number;
  maxOnlineOffers: number;
  entitlements: readonly Entitlement[];
}

// ───────────── lecture stricte ─────────────

type Json = Record<string, unknown>;

const ERROR_CODE = /^[a-z][a-z0-9_]{0,63}$/;
const FIXED_MESSAGE = "Réponse du serveur inattendue.";

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function bad(status: number): never {
  throw new ApiError(status, API_INVALID_RESPONSE, FIXED_MESSAGE);
}

const isAmount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const isIso = (value: unknown): value is string => typeof value === "string" && value.length >= 10 && value.length <= 40 && Number.isFinite(Date.parse(value));
const isIsoOrNull = (value: unknown): value is string | null => value === null || isIso(value);

function parseEntitlements(status: number, value: unknown): Entitlement[] {
  if (!Array.isArray(value) || value.length > ENTITLEMENTS.length) bad(status);
  const result: Entitlement[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !(ENTITLEMENTS as readonly string[]).includes(entry) || result.includes(entry as Entitlement)) bad(status);
    result.push(entry as Entitlement);
  }
  return result;
}

function parsePlan(status: number, value: unknown): PlanView {
  if (
    !isObject(value) || typeof value.code !== "string" || !/^[a-z][a-z0-9_]{1,29}$/.test(value.code) || typeof value.name !== "string" || value.name.length < 1 || value.name.length > 60
    || !Number.isSafeInteger(value.version) || (value.version as number) < 1 || !isAmount(value.monthlyPriceXof) || !isAmount(value.promoCreditsXof)
    || !Number.isSafeInteger(value.maxOnlineOffers) || (value.maxOnlineOffers as number) < 1
  ) bad(status);
  const plan = value as Json;
  return {
    code: plan.code as string, name: plan.name as string, version: plan.version as number, monthlyPriceXof: plan.monthlyPriceXof as number,
    promoCreditsXof: plan.promoCreditsXof as number, maxOnlineOffers: plan.maxOnlineOffers as number, entitlements: parseEntitlements(status, plan.entitlements),
  };
}

function parseSubscription(status: number, value: unknown): SubscriptionView {
  if (
    !isObject(value) || typeof value.planCode !== "string" || !(value.status === "active" || value.status === "past_due") || !isIso(value.periodStart) || !isIso(value.periodEnd)
    || typeof value.autoRenew !== "boolean" || !isIsoOrNull(value.canceledAt) || !isIsoOrNull(value.graceEndsAt) || !isAmount(value.currentPriceXof)
    || !isAmount(value.renewalPriceXof) || typeof value.entitled !== "boolean"
  ) bad(status);
  const sub = value as Json;
  return {
    planCode: sub.planCode as string, status: sub.status as SubscriptionStatus, periodStart: sub.periodStart as string, periodEnd: sub.periodEnd as string,
    autoRenew: sub.autoRenew as boolean, canceledAt: sub.canceledAt as string | null, graceEndsAt: sub.graceEndsAt as string | null,
    currentPriceXof: sub.currentPriceXof as number, renewalPriceXof: sub.renewalPriceXof as number, entitled: sub.entitled as boolean,
  };
}

function parseNotice(status: number, value: unknown): SubscriptionNoticeView {
  if (
    !isObject(value) || !isUuid(value.id) || !(NOTICE_CODES as readonly string[]).includes(String(value.code)) || !isIso(value.createdAt) || !isIsoOrNull(value.readAt)
    || !(value.listingCount === null || (Number.isSafeInteger(value.listingCount) && (value.listingCount as number) >= 1))
    || (value.code === "listings_paused" || value.code === "listings_restored") !== (value.listingCount !== null)
  ) bad(status);
  const notice = value as Json;
  return {
    id: notice.id as string, code: notice.code as SubscriptionNoticeCode, listingCount: notice.listingCount as number | null,
    createdAt: notice.createdAt as string, readAt: notice.readAt as string | null,
  };
}

function parseState(status: number, value: unknown): SubscriptionState {
  if (
    !isObject(value) || value.contractVersion !== SUBSCRIPTION_CONTRACT_VERSION || typeof value.pricesProvisional !== "boolean" || !Array.isArray(value.plans) || value.plans.length > 20
    || !isObject(value.current) || !Number.isSafeInteger(value.onlineOffers) || (value.onlineOffers as number) < 0 || !isObject(value.promo) || !isAmount(value.promo.balanceXof)
    || !isIsoOrNull(value.promo.expiresAt) || !Array.isArray(value.notices) || value.notices.length > 50 || !isAmount(value.unreadNotices) || !isIso(value.readAt)
  ) bad(status);
  const body = value as Json;
  const current = body.current as Json;
  if (
    !(current.source === "free" || current.source === "subscription") || typeof current.planCode !== "string" || typeof current.planName !== "string"
    || !Number.isSafeInteger(current.maxOnlineOffers) || (current.maxOnlineOffers as number) < 1
  ) bad(status);
  const promo = body.promo as Json;
  return {
    pricesProvisional: body.pricesProvisional as boolean,
    plans: (body.plans as unknown[]).map((plan) => parsePlan(status, plan)),
    current: {
      source: current.source as "free" | "subscription", planCode: current.planCode as string, planName: current.planName as string,
      maxOnlineOffers: current.maxOnlineOffers as number, entitlements: parseEntitlements(status, current.entitlements),
    },
    onlineOffers: body.onlineOffers as number,
    subscription: body.subscription === null ? null : parseSubscription(status, body.subscription),
    promo: { balanceXof: promo.balanceXof as number, expiresAt: promo.expiresAt as string | null },
    notices: (body.notices as unknown[]).map((notice) => parseNotice(status, notice)),
    unreadNotices: body.unreadNotices as number,
    readAt: body.readAt as string,
  };
}

function parseImportRow(status: number, value: unknown): ImportRowReport {
  if (
    !isObject(value) || !Number.isSafeInteger(value.line) || (value.line as number) < 1 || !(["created", "would_create", "rejected"] as string[]).includes(String(value.outcome))
    || !(value.code === null || (typeof value.code === "string" && ERROR_CODE.test(value.code))) || !(value.field === null || (typeof value.field === "string" && ERROR_CODE.test(value.field)))
    || !(value.offerId === null || isUuid(value.offerId))
  ) bad(status);
  const row = value as Json;
  return { line: row.line as number, outcome: row.outcome as ImportOutcome, code: row.code as string | null, field: row.field as string | null, offerId: row.offerId as string | null };
}

function parseImport(status: number, value: unknown): CatalogImportResult {
  if (
    !isObject(value) || value.contractVersion !== CATALOG_IMPORT_CONTRACT_VERSION || !(value.mode === "preview" || value.mode === "apply") || typeof value.alreadyApplied !== "boolean"
    || !isAmount(value.rowCount) || !isAmount(value.acceptedCount) || !isAmount(value.rejectedCount) || !Array.isArray(value.rows) || value.rows.length > 200
    || value.acceptedCount + value.rejectedCount !== value.rowCount || value.rows.length !== value.rowCount
  ) bad(status);
  const body = value as Json;
  return {
    mode: body.mode as "preview" | "apply", alreadyApplied: body.alreadyApplied as boolean, rowCount: body.rowCount as number, acceptedCount: body.acceptedCount as number,
    rejectedCount: body.rejectedCount as number, rows: (body.rows as unknown[]).map((row) => parseImportRow(status, row)),
  };
}

function parseAdminVersion(status: number, value: unknown): AdminPlanVersion {
  if (
    !isObject(value) || !Number.isSafeInteger(value.version) || (value.version as number) < 1 || typeof value.name !== "string" || !isAmount(value.monthlyPriceXof) || !isAmount(value.promoCreditsXof)
    || !Number.isSafeInteger(value.maxOnlineOffers) || !isIso(value.createdAt)
  ) bad(status);
  const version = value as Json;
  return {
    version: version.version as number, name: version.name as string, monthlyPriceXof: version.monthlyPriceXof as number, promoCreditsXof: version.promoCreditsXof as number,
    maxOnlineOffers: version.maxOnlineOffers as number, entitlements: parseEntitlements(status, version.entitlements), createdAt: version.createdAt as string,
  };
}

function parseAdminOverview(status: number, value: unknown): AdminPlansOverview {
  if (
    !isObject(value) || value.contractVersion !== ADMIN_PLANS_CONTRACT_VERSION || typeof value.pricesProvisional !== "boolean" || !Array.isArray(value.plans) || !Array.isArray(value.subscribers)
    || !isAmount(value.totalSubscribersApproximate) || !isObject(value.month) || !isIso(value.month.startsAt) || !isIso(value.month.endsAt) || typeof value.subscriptionRevenueXof !== "number"
    || !Number.isSafeInteger(value.subscriptionRevenueXof) || !isObject(value.promo) || !isAmount(value.promo.issuedXof) || !isAmount(value.promo.spentXof) || !isAmount(value.promo.expiredXof)
    || !isIso(value.readAt)
  ) bad(status);
  const body = value as Json;
  const month = body.month as Json;
  const promo = body.promo as Json;
  return {
    pricesProvisional: body.pricesProvisional as boolean,
    plans: (body.plans as unknown[]).map((plan) => {
      if (!isObject(plan) || typeof plan.code !== "string" || !Array.isArray(plan.versions)) bad(status);
      const entry = plan as Json;
      return { code: entry.code as string, versions: (entry.versions as unknown[]).map((version) => parseAdminVersion(status, version)) };
    }),
    subscribers: (body.subscribers as unknown[]).map((entry) => {
      if (!isObject(entry) || typeof entry.planCode !== "string" || !isAmount(entry.approximateCount) || (entry.approximateCount as number) % 5 !== 0) bad(status);
      const item = entry as Json;
      return { planCode: item.planCode as string, approximateCount: item.approximateCount as number };
    }),
    totalSubscribersApproximate: body.totalSubscribersApproximate as number,
    month: { startsAt: month.startsAt as string, endsAt: month.endsAt as string },
    subscriptionRevenueXof: body.subscriptionRevenueXof as number,
    promo: { issuedXof: promo.issuedXof as number, spentXof: promo.spentXof as number, expiredXof: promo.expiredXof as number },
    readAt: body.readAt as string,
  };
}

// ───────────── client ─────────────

export interface ProClientOptions {
  fetch?: typeof fetch;
}

export function createProClient(options: ProClientOptions = {}) {
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
    if (response.status !== 204) {
      try {
        json = await response.json();
      } catch {
        json = undefined;
      }
    }
    if (!response.ok) {
      if (isObject(json) && isObject(json.error) && typeof json.error.code === "string" && ERROR_CODE.test(json.error.code) && typeof json.error.message === "string" && json.error.message.length <= 500) {
        throw new ApiError(response.status, json.error.code, json.error.message);
      }
      throw new ApiError(response.status, API_INVALID_RESPONSE, FIXED_MESSAGE);
    }
    return { status: response.status, json };
  }

  const argument = (): ApiError => new ApiError(0, API_INVALID_ARGUMENT, "Paramètre invalide.");

  return {
    subscription: {
      /** GET /api/subscription : plans courants (prix provisoires), droits en vigueur, abonnement, crédits promotionnels, annonces en ligne, avis. */
      async state(requestOptions?: RequestOptions): Promise<SubscriptionState> {
        const { status, json } = await send("GET", "/api/subscription", undefined, requestOptions);
        return parseState(status, json);
      },

      /**
       * POST /api/subscription `{ planCode, idempotencyKey }` : souscrit avec les crédits payés (201 ; 200 pour un rejeu de la même clé : `reused`, aucun second débit). La clé est un UUID
       * généré UNE fois par tentative et réutilisé à chaque nouvel essai.
       */
      async subscribe(request: { planCode: string; idempotencyKey: string }, requestOptions?: RequestOptions): Promise<SubscribeResult> {
        if (typeof request?.planCode !== "string" || !/^[a-z][a-z0-9_]{1,29}$/.test(request.planCode) || !isUuid(request.idempotencyKey)) throw argument();
        const { status, json } = await send("POST", "/api/subscription", { planCode: request.planCode, idempotencyKey: request.idempotencyKey }, requestOptions);
        if (!isObject(json) || typeof json.reused !== "boolean") bad(status);
        return { reused: (json as Json).reused as boolean, state: parseState(status, json) };
      },

      /** POST /api/subscription/auto-renew `{ autoRenew }` : active, ou désactive (= annule : effective à la fin de la période, sans remboursement) le renouvellement automatique. */
      async setAutoRenew(autoRenew: boolean, requestOptions?: RequestOptions): Promise<SubscriptionState> {
        if (typeof autoRenew !== "boolean") throw argument();
        const { status, json } = await send("POST", "/api/subscription/auto-renew", { autoRenew }, requestOptions);
        return parseState(status, json);
      },

      /** POST /api/subscription/notices/read : marque comme lus tous les avis, ou ceux dont on donne les identifiants. Renvoie le nombre d'avis non lus. */
      async markNoticesRead(target: { all: true } | { ids: readonly string[] }, requestOptions?: RequestOptions): Promise<number> {
        let body: unknown;
        if ("all" in target) body = { all: true };
        else if (Array.isArray(target.ids) && target.ids.length >= 1 && target.ids.length <= 50 && target.ids.every((id) => isUuid(id))) body = { ids: [...target.ids] };
        else throw argument();
        const { status, json } = await send("POST", "/api/subscription/notices/read", body, requestOptions);
        if (!isObject(json) || json.contractVersion !== SUBSCRIPTION_CONTRACT_VERSION || !isAmount(json.unreadNotices)) bad(status);
        return (json as Json).unreadNotices as number;
      },
    },

    catalogImport: {
      /**
       * POST /api/offers/import `{ csv, dryRun }` : aperçu à blanc (`dryRun: true`) ou application d'un fichier CSV de 200 lignes au plus (droit « import de catalogue » de l'offre Pro).
       * Le texte du fichier est envoyé tel quel et n'est JAMAIS stocké ; rejouer le même fichier ne recrée rien (`alreadyApplied`).
       */
      async run(request: { csv: string; dryRun: boolean }, requestOptions?: RequestOptions): Promise<CatalogImportResult> {
        if (typeof request?.csv !== "string" || typeof request.dryRun !== "boolean") throw argument();
        const { status, json } = await send("POST", "/api/offers/import", { csv: request.csv, dryRun: request.dryRun }, requestOptions);
        return parseImport(status, json);
      },
    },

    adminPlans: {
      /** GET /api/admin/plans : versions des plans, abonnés arrondis à 5 près, revenus d'abonnement du mois (administrateur seulement : 404 sinon). */
      async overview(requestOptions?: RequestOptions): Promise<AdminPlansOverview> {
        const { status, json } = await send("GET", "/api/admin/plans", undefined, requestOptions);
        return parseAdminOverview(status, json);
      },

      /** POST /api/admin/plans/{code}/versions : crée une NOUVELLE version (jamais la modification d'une version existante). */
      async createVersion(planCode: string, request: NewPlanVersionRequest, requestOptions?: RequestOptions): Promise<AdminPlanVersion> {
        if (typeof planCode !== "string" || !/^[a-z][a-z0-9_]{1,29}$/.test(planCode)) throw new ApiError(0, API_INVALID_ID, "Identifiant invalide.");
        const { status, json } = await send("POST", `/api/admin/plans/${planCode}/versions`, {
          name: request.name, monthlyPriceXof: request.monthlyPriceXof, promoCreditsXof: request.promoCreditsXof, maxOnlineOffers: request.maxOnlineOffers, entitlements: [...request.entitlements],
        }, requestOptions);
        if (!isObject(json) || json.contractVersion !== ADMIN_PLANS_CONTRACT_VERSION) bad(status);
        return parseAdminVersion(status, (json as Json).version);
      },
    },
  };
}

export type ProClient = ReturnType<typeof createProClient>;

/** Client du navigateur : fetch global, même origine. */
export const proApi: ProClient = createProClient();
