/**
 * Couche cliente de la RECHERCHE ACTIVE payante (lot RA1) : état de l'option d'un besoin, achat d'une période (30 jours), administration. Module partagé navigateur (aucun import
 * serveur), mêmes règles que `pro-api.ts` : fetch même origine, JSON, toute erreur devient une `ApiError { status, code }` construite UNIQUEMENT depuis le corps `{ error: { code, message } }`
 * du serveur (ou un code fixe), réponses relues champ par champ (liste blanche). Contrat : lib/server/active-search/http.ts (`active-search/v1`). Voir RECHERCHE-ACTIVE.md.
 *
 * PRIX PROVISOIRE : 2 000 FCFA pour 30 jours (décision du fondateur en attente) ; le serveur le dit (`priceProvisional`) et l'écran l'affiche.
 */

import { API_ABORTED, API_INVALID_ARGUMENT, API_INVALID_ID, API_INVALID_RESPONSE, API_NETWORK_ERROR, ApiError, isUuid, type RequestOptions } from "./api";

export const ACTIVE_SEARCH_CONTRACT_VERSION = "active-search/v1";

export type ActiveSearchBlockedReason = "demand_not_active" | "no_product_key" | "unavailable" | "capacity" | "max_horizon";
const BLOCKED_REASONS: readonly string[] = ["demand_not_active", "no_product_key", "unavailable", "capacity", "max_horizon"];
export type ActiveSearchPurchaseKind = "activation" | "extension";

export interface ActiveSearchState {
  priceProvisional: boolean;
  paidCreditsOnly: boolean;
  autoRenew: boolean;
  demandId: string;
  demandStatus: string;
  /** L'option est en vigueur MAINTENANT. */
  active: boolean;
  /** L'option est SUSPENDUE : le besoin est « satisfait » alors qu'une période court encore (rien n'est notifié ; la réactivation du besoin la reprend). */
  suspended: boolean;
  startsAt: string | null;
  /** Fin de la dernière période payée (la chaîne en vigueur). */
  endsAt: string | null;
  remainingDays: number | null;
  purchasedPeriods: number;
  /** Fin qu'aurait l'option après un achat maintenant ; null si un achat est impossible. */
  nextEndsAt: string | null;
  maxEndsAt: string;
  canPurchase: boolean;
  blockedReason: ActiveSearchBlockedReason | null;
  expiringSoon: boolean;
  priceXof: number;
  durationDays: number;
  /** Solde en crédits PAYÉS (les crédits promotionnels ne paient jamais cette option). */
  balanceXof: number;
  readAt: string;
}

export interface ActiveSearchPurchaseResult {
  /** Vrai si la même clé d'idempotence avait déjà servi : aucun nouveau débit. */
  reused: boolean;
  kind: ActiveSearchPurchaseKind;
  startsAt: string;
  endsAt: string;
  priceXof: number;
  state: ActiveSearchState;
}

export interface AdminActiveSearchOverview {
  priceProvisional: boolean;
  /** Besoins avec une option en vigueur, arrondis à 5 près. */
  activeApproximate: number;
  month: { startsAt: string; endsAt: string };
  revenueXof: number;
  readAt: string;
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

function parseState(status: number, value: unknown): ActiveSearchState {
  if (
    !isObject(value) || value.contractVersion !== ACTIVE_SEARCH_CONTRACT_VERSION || typeof value.priceProvisional !== "boolean" || value.paidCreditsOnly !== true || value.autoRenew !== false
    || !isUuid(value.demandId) || typeof value.demandStatus !== "string" || !/^[a-z_]{1,20}$/.test(value.demandStatus) || typeof value.active !== "boolean" || typeof value.suspended !== "boolean"
    || !isIsoOrNull(value.startsAt) || !isIsoOrNull(value.endsAt) || !(value.remainingDays === null || (Number.isSafeInteger(value.remainingDays) && (value.remainingDays as number) >= 0))
    || !isAmount(value.purchasedPeriods) || !isIsoOrNull(value.nextEndsAt) || !isIso(value.maxEndsAt) || typeof value.canPurchase !== "boolean"
    || !(value.blockedReason === null || (typeof value.blockedReason === "string" && BLOCKED_REASONS.includes(value.blockedReason))) || typeof value.expiringSoon !== "boolean"
    || !isAmount(value.priceXof) || !isAmount(value.durationDays) || !isAmount(value.balanceXof) || !isIso(value.readAt)
    // Cohérences : achat possible ⇔ pas de raison de blocage et une fin prévue ; en vigueur ⇒ une fin connue.
    || value.canPurchase !== (value.blockedReason === null) || (value.canPurchase === true) !== (value.nextEndsAt !== null) || (value.active === true && value.endsAt === null)
    // Une option suspendue n'est jamais en vigueur, et a une fin connue.
    || (value.suspended === true && (value.active === true || value.endsAt === null))
  ) bad(status);
  const body = value as Json;
  return {
    priceProvisional: body.priceProvisional as boolean,
    paidCreditsOnly: true,
    autoRenew: false,
    demandId: body.demandId as string,
    demandStatus: body.demandStatus as string,
    active: body.active as boolean,
    suspended: body.suspended as boolean,
    startsAt: body.startsAt as string | null,
    endsAt: body.endsAt as string | null,
    remainingDays: body.remainingDays as number | null,
    purchasedPeriods: body.purchasedPeriods as number,
    nextEndsAt: body.nextEndsAt as string | null,
    maxEndsAt: body.maxEndsAt as string,
    canPurchase: body.canPurchase as boolean,
    blockedReason: body.blockedReason as ActiveSearchBlockedReason | null,
    expiringSoon: body.expiringSoon as boolean,
    priceXof: body.priceXof as number,
    durationDays: body.durationDays as number,
    balanceXof: body.balanceXof as number,
    readAt: body.readAt as string,
  };
}

function parseAdminOverview(status: number, value: unknown): AdminActiveSearchOverview {
  if (
    !isObject(value) || value.contractVersion !== ACTIVE_SEARCH_CONTRACT_VERSION || typeof value.priceProvisional !== "boolean" || !isAmount(value.activeApproximate)
    || (value.activeApproximate as number) % 5 !== 0 || !isObject(value.month) || !isIso(value.month.startsAt) || !isIso(value.month.endsAt) || typeof value.revenueXof !== "number"
    || !Number.isSafeInteger(value.revenueXof) || !isIso(value.readAt)
  ) bad(status);
  const body = value as Json;
  const month = body.month as Json;
  return {
    priceProvisional: body.priceProvisional as boolean,
    activeApproximate: body.activeApproximate as number,
    month: { startsAt: month.startsAt as string, endsAt: month.endsAt as string },
    revenueXof: body.revenueXof as number,
    readAt: body.readAt as string,
  };
}

// ───────────── client ─────────────

export interface ActiveSearchClientOptions {
  fetch?: typeof fetch;
}

export function createActiveSearchClient(options: ActiveSearchClientOptions = {}) {
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

  const invalidId = (): ApiError => new ApiError(0, API_INVALID_ID, "Identifiant invalide.");

  return {
    /** GET /api/demands/{id}/active-search : état de l'option pour ce besoin (propriétaire seulement : 404 sinon). */
    async state(demandId: string, requestOptions?: RequestOptions): Promise<ActiveSearchState> {
      if (!isUuid(demandId)) throw invalidId();
      const { status, json } = await send("GET", `/api/demands/${demandId}/active-search`, undefined, requestOptions);
      return parseState(status, json);
    },

    /**
     * POST /api/demands/{id}/active-search `{ idempotencyKey, expectedPriceXof }` : achète une période de 30 jours en crédits PAYÉS au prix AFFICHÉ (409 `price_changed`, aucun débit, si le prix
     * a changé ; 201 ; 200 pour un rejeu de la même clé : `reused`, aucun second débit). La clé est un UUID généré UNE fois par tentative et réutilisé à chaque nouvel essai ;
     * `expectedPriceXof` est le prix que l'écran affiche.
     */
    async purchase(demandId: string, idempotencyKey: string, expectedPriceXof: number, requestOptions?: RequestOptions): Promise<ActiveSearchPurchaseResult> {
      if (!isUuid(demandId)) throw invalidId();
      if (!isUuid(idempotencyKey) || !Number.isSafeInteger(expectedPriceXof) || expectedPriceXof <= 0) throw new ApiError(0, API_INVALID_ARGUMENT, "Paramètre invalide.");
      const { status, json } = await send("POST", `/api/demands/${demandId}/active-search`, { idempotencyKey, expectedPriceXof }, requestOptions);
      if (!isObject(json) || !isObject(json.purchase)) bad(status);
      const purchase = (json as Json).purchase as Json;
      if (
        typeof purchase.reused !== "boolean" || !(purchase.kind === "activation" || purchase.kind === "extension") || !isIso(purchase.startsAt) || !isIso(purchase.endsAt)
        || !isAmount(purchase.priceXof)
      ) bad(status);
      return {
        reused: purchase.reused as boolean, kind: purchase.kind as ActiveSearchPurchaseKind, startsAt: purchase.startsAt as string, endsAt: purchase.endsAt as string,
        priceXof: purchase.priceXof as number, state: parseState(status, json),
      };
    },

    adminOverview: {
      /** GET /api/admin/active-search : options en vigueur arrondies à 5 près, revenus du mois (administrateur seulement : 404 sinon). */
      async read(requestOptions?: RequestOptions): Promise<AdminActiveSearchOverview> {
        const { status, json } = await send("GET", "/api/admin/active-search", undefined, requestOptions);
        return parseAdminOverview(status, json);
      },
    },
  };
}

export type ActiveSearchClient = ReturnType<typeof createActiveSearchClient>;

/** Client du navigateur : fetch global, même origine. */
export const activeSearchApi: ActiveSearchClient = createActiveSearchClient();
