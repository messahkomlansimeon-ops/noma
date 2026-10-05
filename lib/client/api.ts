/**
 * Couche cliente UNIQUE vers l'API noma (module partagé navigateur : aucun import serveur).
 *
 * - fetch même origine, `credentials: "same-origin"`, JSON, en-tête `Content-Type` quand il y a un corps ;
 * - toute erreur devient une `ApiError { status, code }` construite UNIQUEMENT depuis le corps
 *   `{ error: { code, message } }` renvoyé par le serveur. Une panne réseau, une réponse qui n'a pas cette forme
 *   ou une exception inattendue donnent un code fixe (`network_error`, `invalid_response`, `aborted`, et `invalid_id` pour
 *   un identifiant qui n'est pas un UUID : aucune requête n'est alors envoyée) et un
 *   message fixe : le texte d'une exception brute n'est jamais repris ni affiché ;
 * - le texte montré à l'utilisateur vient de `describeApiError`, table de messages fixes en français.
 *
 * Les formes de corps et de réponses reprennent EXACTEMENT celles de lib/server/auth/http.ts et
 * lib/server/catalog/http.ts (contrats documentés dans AUTH-SERVER.md et CATALOG-HTTP.md).
 */

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export interface Money {
  amount: number;
  /** Code ISO sur trois lettres (XOF pour le FCFA). */
  currency: string;
}

export type OfferStatus = "draft" | "published" | "paused" | "archived";
export type DemandStatus = "draft" | "active" | "satisfied" | "archived";
export type AvailabilityStatus = "available" | "reserved" | "unavailable";

interface CatalogRecordCommon {
  id: string;
  rawText: string;
  category: string | null;
  brand: string | null;
  model: string | null;
  variant: string | null;
  attributes: JsonObject | null;
  condition: string | null;
  quantity: number | null;
  unit: string | null;
  location: string | null;
  deadlineAt: string | null;
  /** Version de contenu que le serveur exige pour toute transition ou modification. */
  contentVersion: number;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

export interface OfferRecord extends CatalogRecordCommon {
  status: OfferStatus;
  price: Money | null;
  availabilityStatus: AvailabilityStatus | null;
}

export interface DemandRecord extends CatalogRecordCommon {
  status: DemandStatus;
  budget: Money | null;
  requirements: JsonValue[] | null;
  preferences: JsonValue[] | null;
}

/** Champs de contenu communs acceptés à la création (`rawText` est requis par le serveur). */
export interface CatalogContentInput {
  rawText: string;
  category?: string | null;
  brand?: string | null;
  model?: string | null;
  variant?: string | null;
  attributes?: JsonObject | null;
  condition?: string | null;
  quantity?: number | null;
  unit?: string | null;
  location?: string | null;
  /** Date ISO UTC stricte (`2031-01-01T10:00:00Z`) ou null. */
  deadlineAt?: string | null;
}

export interface OfferInput extends CatalogContentInput {
  price?: Money | null;
  availabilityStatus?: AvailabilityStatus | null;
}

/** Modification partielle : au moins un champ, la version de contenu attendue est fournie à part. */
export type OfferChanges = Partial<OfferInput>;

export interface DemandInput extends CatalogContentInput {
  budget?: Money | null;
  requirements?: JsonValue[] | null;
  preferences?: JsonValue[] | null;
}

export interface Pagination {
  limit: number;
  offset: number;
}

export interface OtpChallenge {
  challengeId: string;
  expiresAt: string;
  resendAvailableAt: string;
}

export type SessionOutcome =
  | { kind: "authenticated"; userId: string }
  | { kind: "anonymous" }
  | { kind: "unavailable" };

export const API_NETWORK_ERROR = "network_error";
export const API_INVALID_RESPONSE = "invalid_response";
export const API_ABORTED = "aborted";
export const API_INVALID_ID = "invalid_id";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Même forme d'identifiant que le serveur (lib/server/catalog/validation.ts). */
export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

const FIXED_ERROR_MESSAGES: Record<string, string> = {
  [API_NETWORK_ERROR]: "Connexion au serveur impossible.",
  [API_INVALID_RESPONSE]: "Réponse du serveur inattendue.",
  [API_ABORTED]: "Requête interrompue.",
  [API_INVALID_ID]: "Identifiant invalide.",
};

/** Erreur d'API : `status` HTTP (0 = pas de réponse) et `code` du serveur ; jamais de texte d'exception brute. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

function fixedError(status: number, code: string): ApiError {
  return new ApiError(status, code, FIXED_ERROR_MESSAGES[code] ?? FIXED_ERROR_MESSAGES[API_INVALID_RESPONSE]);
}

const ERROR_CODE = /^[a-z][a-z0-9_]{0,63}$/;

function errorFromBody(status: number, body: unknown): ApiError {
  if (isObject(body) && isObject(body.error)) {
    const { code, message } = body.error;
    if (typeof code === "string" && ERROR_CODE.test(code) && typeof message === "string" && message.length <= 500) {
      return new ApiError(status, code, message);
    }
  }
  return fixedError(status, API_INVALID_RESPONSE);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringOrNull(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isMoneyOrNull(value: unknown): value is Money | null {
  return (
    value === null ||
    (isObject(value) && typeof value.amount === "number" && typeof value.currency === "string")
  );
}

function parseCommon(status: number, value: unknown): CatalogRecordCommon {
  if (
    !isObject(value) ||
    typeof value.id !== "string" ||
    typeof value.status !== "string" ||
    typeof value.rawText !== "string" ||
    !isStringOrNull(value.category) ||
    !isStringOrNull(value.brand) ||
    !isStringOrNull(value.model) ||
    !isStringOrNull(value.variant) ||
    !isStringOrNull(value.condition) ||
    !isStringOrNull(value.unit) ||
    !isStringOrNull(value.location) ||
    !isStringOrNull(value.deadlineAt) ||
    !(value.quantity === null || typeof value.quantity === "number") ||
    !(value.attributes === null || isObject(value.attributes)) ||
    typeof value.contentVersion !== "number" ||
    !Number.isSafeInteger(value.contentVersion) ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string" ||
    !isStringOrNull(value.archivedAt)
  ) {
    throw fixedError(status, API_INVALID_RESPONSE);
  }
  return value as unknown as CatalogRecordCommon;
}

const OFFER_STATUSES: readonly string[] = ["draft", "published", "paused", "archived"];
const DEMAND_STATUSES: readonly string[] = ["draft", "active", "satisfied", "archived"];

function parseOffer(status: number, value: unknown): OfferRecord {
  const common = parseCommon(status, value);
  const record = value as Record<string, unknown>;
  if (
    !OFFER_STATUSES.includes(String(record.status)) ||
    !isMoneyOrNull(record.price) ||
    !(record.availabilityStatus === null || typeof record.availabilityStatus === "string")
  ) {
    throw fixedError(status, API_INVALID_RESPONSE);
  }
  return { ...common, status: record.status, price: record.price, availabilityStatus: record.availabilityStatus } as OfferRecord;
}

function parseDemand(status: number, value: unknown): DemandRecord {
  const common = parseCommon(status, value);
  const record = value as Record<string, unknown>;
  if (
    !DEMAND_STATUSES.includes(String(record.status)) ||
    !isMoneyOrNull(record.budget) ||
    !(record.requirements === null || Array.isArray(record.requirements)) ||
    !(record.preferences === null || Array.isArray(record.preferences))
  ) {
    throw fixedError(status, API_INVALID_RESPONSE);
  }
  return {
    ...common,
    status: record.status,
    budget: record.budget,
    requirements: record.requirements,
    preferences: record.preferences,
  } as DemandRecord;
}

function parsePagination(status: number, value: unknown): Pagination {
  if (!isObject(value) || typeof value.limit !== "number" || typeof value.offset !== "number") {
    throw fixedError(status, API_INVALID_RESPONSE);
  }
  return { limit: value.limit, offset: value.offset };
}

export interface RequestOptions {
  signal?: AbortSignal;
}

export interface ApiClientOptions {
  /** fetch injecté (tests) ; par défaut le fetch global, résolu à chaque appel. */
  fetch?: typeof fetch;
}

/** Taille de page maximale acceptée par le serveur et garde-fou de `listAll`. */
export const PAGE_LIMIT = 100;
export const LIST_ALL_MAX_PAGES = 20;

/** Résultat de `listAll` : `truncated` vaut true si le plafond de pages est atteint et qu'il reste des éléments. */
export interface ListAllResult<T> {
  items: T[];
  truncated: boolean;
}

/** Pagination de `listAll` : pages pleines jusqu'à la première page incomplète, plafond signalé et jamais silencieux. */
async function collectAll<T>(fetchPage: (pagination: Pagination) => Promise<T[]>): Promise<ListAllResult<T>> {
  const items: T[] = [];
  for (let pageIndex = 0; pageIndex < LIST_ALL_MAX_PAGES; pageIndex += 1) {
    const rows = await fetchPage({ limit: PAGE_LIMIT, offset: pageIndex * PAGE_LIMIT });
    items.push(...rows);
    if (rows.length < PAGE_LIMIT) return { items, truncated: false };
  }
  const probe = await fetchPage({ limit: 1, offset: LIST_ALL_MAX_PAGES * PAGE_LIMIT });
  return { items, truncated: probe.length > 0 };
}

export function createApiClient(options: ApiClientOptions = {}) {
  async function send(
    method: "GET" | "POST" | "PATCH",
    path: string,
    body?: unknown,
    requestOptions: RequestOptions = {},
  ): Promise<{ status: number; json: unknown }> {
    const headers: Record<string, string> = { Accept: "application/json" };
    const init: RequestInit = {
      method,
      headers,
      credentials: "same-origin",
      cache: "no-store",
      signal: requestOptions.signal,
    };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }

    let response: Response;
    try {
      response = await (options.fetch ?? fetch)(path, init);
    } catch {
      // Le texte de l'exception (hôte, port, pile…) n'est jamais repris.
      throw fixedError(0, requestOptions.signal?.aborted ? API_ABORTED : API_NETWORK_ERROR);
    }

    let json: unknown = undefined;
    if (response.status !== 204) {
      try {
        json = await response.json();
      } catch {
        json = undefined;
      }
    }
    if (!response.ok) throw errorFromBody(response.status, json);
    return { status: response.status, json };
  }

  /** Identifiant placé dans une URL : UUID uniquement, sinon `invalid_id` SANS requête (aucun chemin construit à la main). */
  function id(value: string): string {
    if (!isUuid(value)) throw fixedError(0, API_INVALID_ID);
    return value;
  }

  function page(pagination?: Partial<Pagination>): string {
    if (!pagination) return "";
    const query = new URLSearchParams();
    if (pagination.limit !== undefined) query.set("limit", String(pagination.limit));
    if (pagination.offset !== undefined) query.set("offset", String(pagination.offset));
    const text = query.toString();
    return text ? `?${text}` : "";
  }

  async function offerResult(call: Promise<{ status: number; json: unknown }>): Promise<OfferRecord> {
    const { status, json } = await call;
    if (!isObject(json)) throw fixedError(status, API_INVALID_RESPONSE);
    return parseOffer(status, json.offer);
  }

  async function demandResult(call: Promise<{ status: number; json: unknown }>): Promise<DemandRecord> {
    const { status, json } = await call;
    if (!isObject(json)) throw fixedError(status, API_INVALID_RESPONSE);
    return parseDemand(status, json.demand);
  }

  const versionBody = (expectedContentVersion: number) => ({ expectedContentVersion });

  async function session(requestOptions?: RequestOptions): Promise<{ userId: string }> {
    const { status, json } = await send("GET", "/api/auth/session", undefined, requestOptions);
    if (!isObject(json) || typeof json.userId !== "string") throw fixedError(status, API_INVALID_RESPONSE);
    return { userId: json.userId };
  }

  async function listOffers(pagination?: Partial<Pagination>, requestOptions?: RequestOptions) {
    const { status, json } = await send("GET", `/api/offers${page(pagination)}`, undefined, requestOptions);
    if (!isObject(json) || !Array.isArray(json.offers)) throw fixedError(status, API_INVALID_RESPONSE);
    return {
      offers: json.offers.map((offer) => parseOffer(status, offer)),
      pagination: parsePagination(status, json.pagination),
    };
  }

  async function listDemands(pagination?: Partial<Pagination>, requestOptions?: RequestOptions) {
    const { status, json } = await send("GET", `/api/demands${page(pagination)}`, undefined, requestOptions);
    if (!isObject(json) || !Array.isArray(json.demands)) throw fixedError(status, API_INVALID_RESPONSE);
    return {
      demands: json.demands.map((demand) => parseDemand(status, demand)),
      pagination: parsePagination(status, json.pagination),
    };
  }

  return {
    auth: {
      /** POST /api/auth/otp/request : `{ phone }` canonique (+…) → 202. */
      async requestOtp(phone: string, requestOptions?: RequestOptions): Promise<OtpChallenge> {
        const { status, json } = await send("POST", "/api/auth/otp/request", { phone }, requestOptions);
        if (
          !isObject(json) ||
          typeof json.challengeId !== "string" ||
          typeof json.expiresAt !== "string" ||
          typeof json.resendAvailableAt !== "string"
        ) {
          throw fixedError(status, API_INVALID_RESPONSE);
        }
        return {
          challengeId: json.challengeId,
          expiresAt: json.expiresAt,
          resendAvailableAt: json.resendAvailableAt,
        };
      },

      /** POST /api/auth/otp/verify : `{ challengeId, code }` → 200 `{ userId }` + cookie HttpOnly `noma_auth`. */
      async verifyOtp(challengeId: string, code: string, requestOptions?: RequestOptions): Promise<{ userId: string }> {
        const { status, json } = await send("POST", "/api/auth/otp/verify", { challengeId, code }, requestOptions);
        if (!isObject(json) || typeof json.userId !== "string") throw fixedError(status, API_INVALID_RESPONSE);
        return { userId: json.userId };
      },

      /** GET /api/auth/session → 200 `{ userId }` ; 401 sans session valide (ApiError). */
      session,

      /**
       * Résultat de session sans exception : 200 → authenticated, 401 → anonymous, tout le reste
       * (503, panne réseau, réponse inattendue) → unavailable. Sert la garde de session des écrans.
       */
      async sessionOutcome(requestOptions?: RequestOptions): Promise<SessionOutcome> {
        try {
          const { userId } = await session(requestOptions);
          return { kind: "authenticated", userId };
        } catch (error) {
          if (error instanceof ApiError && error.status === 401) return { kind: "anonymous" };
          if (error instanceof ApiError && error.code === API_ABORTED) throw error;
          return { kind: "unavailable" };
        }
      },

      /** POST /api/auth/logout (sans corps) → 204 ; idempotent. */
      async logout(requestOptions?: RequestOptions): Promise<void> {
        await send("POST", "/api/auth/logout", undefined, requestOptions);
      },
    },

    offers: {
      /** GET /api/offers?limit&offset → `{ offers, pagination }` (tri serveur : création croissante). */
      list: listOffers,

      /**
       * Toutes les offres du vendeur, page par page (100 au plus par requête, 20 pages au plus). Au-delà du plafond,
       * une requête de contrôle (1 élément) dit s'il en reste : le résultat est alors marqué `truncated`, jamais
       * tronqué en silence.
       */
      async listAll(requestOptions?: RequestOptions): Promise<ListAllResult<OfferRecord>> {
        return collectAll(async (pagination) => (await listOffers(pagination, requestOptions)).offers);
      },

      /** POST /api/offers → 201 `{ offer }` (statut brouillon). */
      create(input: OfferInput, requestOptions?: RequestOptions): Promise<OfferRecord> {
        return offerResult(send("POST", "/api/offers", input, requestOptions));
      },

      /** GET /api/offers/{id} → `{ offer }` ; 404 si inconnue OU appartenant à un autre compte. */
      async get(offerId: string, requestOptions?: RequestOptions): Promise<OfferRecord> {
        return offerResult(send("GET", `/api/offers/${id(offerId)}`, undefined, requestOptions));
      },

      /** PATCH /api/offers/{id} : `{ expectedContentVersion, …champs }` (au moins un champ). */
      async update(
        offerId: string,
        expectedContentVersion: number,
        changes: OfferChanges,
        requestOptions?: RequestOptions,
      ): Promise<OfferRecord> {
        return offerResult(
          send("PATCH", `/api/offers/${id(offerId)}`, { expectedContentVersion, ...changes }, requestOptions),
        );
      },

      /** POST /api/offers/{id}/publish : brouillon ou pause → en ligne. */
      async publish(offerId: string, expectedContentVersion: number, requestOptions?: RequestOptions): Promise<OfferRecord> {
        return offerResult(
          send("POST", `/api/offers/${id(offerId)}/publish`, versionBody(expectedContentVersion), requestOptions),
        );
      },

      /** POST /api/offers/{id}/pause : en ligne → en pause. */
      async pause(offerId: string, expectedContentVersion: number, requestOptions?: RequestOptions): Promise<OfferRecord> {
        return offerResult(
          send("POST", `/api/offers/${id(offerId)}/pause`, versionBody(expectedContentVersion), requestOptions),
        );
      },

      /** POST /api/offers/{id}/archive : tout statut non archivé → archivée (définitif). */
      async archive(offerId: string, expectedContentVersion: number, requestOptions?: RequestOptions): Promise<OfferRecord> {
        return offerResult(
          send("POST", `/api/offers/${id(offerId)}/archive`, versionBody(expectedContentVersion), requestOptions),
        );
      },
    },

    demands: {
      /** GET /api/demands?limit&offset → `{ demands, pagination }`. */
      list: listDemands,

      /** Tous les besoins de l'acheteur (mêmes règles que `offers.listAll`, troncature signalée). */
      async listAll(requestOptions?: RequestOptions): Promise<ListAllResult<DemandRecord>> {
        return collectAll(async (pagination) => (await listDemands(pagination, requestOptions)).demands);
      },

      /** POST /api/demands → 201 `{ demand }` (statut brouillon). */
      create(input: DemandInput, requestOptions?: RequestOptions): Promise<DemandRecord> {
        return demandResult(send("POST", "/api/demands", input, requestOptions));
      },

      async get(demandId: string, requestOptions?: RequestOptions): Promise<DemandRecord> {
        return demandResult(send("GET", `/api/demands/${id(demandId)}`, undefined, requestOptions));
      },

      /** POST /api/demands/{id}/activate : brouillon ou satisfait → actif. */
      async activate(demandId: string, expectedContentVersion: number, requestOptions?: RequestOptions): Promise<DemandRecord> {
        return demandResult(
          send("POST", `/api/demands/${id(demandId)}/activate`, versionBody(expectedContentVersion), requestOptions),
        );
      },

      /** POST /api/demands/{id}/archive. */
      async archive(demandId: string, expectedContentVersion: number, requestOptions?: RequestOptions): Promise<DemandRecord> {
        return demandResult(
          send("POST", `/api/demands/${id(demandId)}/archive`, versionBody(expectedContentVersion), requestOptions),
        );
      },

      /** POST /api/demands/{id}/satisfy : actif → satisfait. */
      async satisfy(demandId: string, expectedContentVersion: number, requestOptions?: RequestOptions): Promise<DemandRecord> {
        return demandResult(
          send("POST", `/api/demands/${id(demandId)}/satisfy`, versionBody(expectedContentVersion), requestOptions),
        );
      },
    },
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;

/** Client du navigateur : fetch global, même origine. */
export const api: ApiClient = createApiClient();

export type ApiErrorContext = "otp-request" | "otp-verify" | "catalog" | "default";

export const GENERIC_ERROR_MESSAGE = "Une erreur est survenue. Réessayez dans un instant.";

/**
 * Message FIXE en français pour l'utilisateur, choisi d'après (contexte, statut, code). Ne reprend jamais le texte
 * d'une exception ni, par principe, celui du serveur : une exception quelconque donne le message générique.
 */
export function describeApiError(error: unknown, context: ApiErrorContext = "default"): string {
  if (!(error instanceof ApiError)) return GENERIC_ERROR_MESSAGE;

  if (error.code === API_NETWORK_ERROR) {
    return "Connexion impossible. Vérifiez votre réseau et réessayez.";
  }
  if (error.code === API_ABORTED) return "Requête interrompue.";
  if (error.code === API_INVALID_ID) return "Identifiant invalide. Rechargez la page.";

  switch (error.status) {
    case 400:
      if (context === "otp-request") return "Numéro de téléphone invalide. Vérifiez-le et réessayez.";
      if (context === "otp-verify") return "Code invalide. Saisissez les 6 chiffres reçus.";
      return "Les informations saisies sont invalides. Vérifiez-les et réessayez.";
    case 401:
      if (context === "otp-verify") return "Code incorrect ou expiré. Vérifiez-le ou demandez un nouveau code.";
      return "Votre session a expiré. Reconnectez-vous pour continuer.";
    case 403:
      return "Requête refusée. Rechargez la page et réessayez.";
    case 404:
      return "Élément introuvable. La liste va être actualisée.";
    case 409:
      if (error.code === "content_version_conflict") {
        return "Cet élément a été modifié entre-temps. La liste a été actualisée, réessayez.";
      }
      if (error.code === "resource_archived") return "Cet élément est archivé et ne peut plus être modifié.";
      if (error.code === "status_transition_conflict") {
        return "Action impossible dans l'état actuel. La liste a été actualisée.";
      }
      return GENERIC_ERROR_MESSAGE;
    case 413:
      return "Le contenu envoyé est trop volumineux.";
    case 429:
      return "Trop de demandes de code. Patientez quelques minutes avant de réessayer.";
    case 503:
      return "Le service est temporairement indisponible. Réessayez dans un instant.";
    default:
      return GENERIC_ERROR_MESSAGE;
  }
}

/** Vrai si l'erreur signifie « pas de session » (401) : l'écran redirige alors vers la connexion. */
export function isUnauthorized(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401;
}
