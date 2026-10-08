/**
 * Couche cliente de la collecte d'annonces externes (lot EXT1) : module partagé navigateur (aucun import serveur), mêmes règles que `api.ts` et `social-api.ts` : fetch même origine,
 * JSON, toute erreur devient une `ApiError { status, code }` (corps `{ error: { code, message } }` du serveur ou code fixe), réponses relues champ par champ (liste blanche : un champ
 * que le serveur ajouterait un jour n'atteint jamais l'écran). Contrats : lib/server/external/http.ts (`external-listings/v1`, `admin-collection/v1`). Voir COLLECTE-EXTERNE.md.
 *
 * Un lien vers une annonce externe n'est accepté que s'il est en http(s) sans identifiants : tout autre schéma (javascript:, data:…) rend la réponse invalide.
 */

import { API_ABORTED, API_INVALID_ID, API_INVALID_RESPONSE, API_NETWORK_ERROR, ApiError, isUuid, type Money, type RequestOptions } from "./api";

export const EXTERNAL_LISTINGS_CONTRACT_VERSION = "external-listings/v1";
export const ADMIN_COLLECTION_CONTRACT_VERSION = "admin-collection/v1";

export interface ExternalSourceRef {
  code: string;
  name: string;
}

export interface ExternalListing {
  id: string;
  title: string;
  price: Money | null;
  location: string | null;
  listedAt: string | null;
  source: ExternalSourceRef;
  alsoOn: ExternalSourceRef[];
  url: string;
  score: number;
  /** Dernière fois qu'une collecte a VU l'annonce chez sa source (« Vue le »). */
  seenAt: string;
  confirmedAt: string | null;
}

/** Page d'annonces d'autres sites. Aucune information sur la surveillance partagée n'est exposée à l'acheteur (ni son existence, ni sa dernière collecte). */
export interface ExternalListingsPage {
  items: ExternalListing[];
  nextCursor: string | null;
  hasMore: boolean;
}

export type BreakerState = "disabled" | "closed" | "open" | "half_open";

export interface AdminCollectionSource {
  code: string;
  name: string;
  type: string;
  enabled: boolean;
  state: BreakerState;
  consecutiveFailures: number;
  breakerOpenUntil: string | null;
  usedToday: number;
  dailyQuota: number;
  minIntervalMs: number;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastErrorCode: string | null;
}

export interface AdminCollection {
  schemaReady: boolean;
  sources: AdminCollectionSource[];
  watches: { total: number; active: number; paused: number; due: number };
  listings: { available: number; gone: number; unknown: number; groups: number };
  errors: Array<{ at: string; sourceCode: string; sourceName: string; code: string }>;
  readAt: string;
}

// ───────────── relecture des réponses (liste blanche) ─────────────

const FIXED_MESSAGES: Record<string, string> = {
  [API_NETWORK_ERROR]: "Connexion au serveur impossible.",
  [API_INVALID_RESPONSE]: "Réponse du serveur inattendue.",
  [API_ABORTED]: "Requête interrompue.",
  [API_INVALID_ID]: "Identifiant invalide.",
  invalid_argument: "Paramètre invalide.",
};

function fixedError(status: number, code: string): ApiError {
  return new ApiError(status, code, FIXED_MESSAGES[code] ?? FIXED_MESSAGES[API_INVALID_RESPONSE]);
}

const ERROR_CODE = /^[a-z][a-z0-9_]{0,63}$/;
const SOURCE_CODE = /^[a-z][a-z0-9_]{1,39}$/;
const CURSOR = /^[A-Za-z0-9_-]{1,300}$/;
type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const isIso = (value: unknown): value is string => typeof value === "string" && value.length <= 40 && Number.isFinite(Date.parse(value));
const isCount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const isText = (value: unknown, max: number): value is string => typeof value === "string" && value.length <= max;

function bad(status: number): never {
  throw fixedError(status, API_INVALID_RESPONSE);
}

function need(status: number, condition: boolean): void {
  if (!condition) bad(status);
}

/** Lien sortant admissible : http(s), sans identifiants, 1 000 caractères au plus. */
export function isSafeExternalUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 8 || value.length > 1_000) return false;
  try {
    const parsed = new URL(value);
    return (parsed.protocol === "https:" || parsed.protocol === "http:") && parsed.username === "" && parsed.password === "" && parsed.hostname !== "";
  } catch {
    return false;
  }
}

function parseSourceRef(status: number, value: unknown): ExternalSourceRef {
  need(status, isObject(value) && typeof value.code === "string" && SOURCE_CODE.test(value.code) && isText(value.name, 80) && value.name.trim() !== "");
  return { code: (value as Json).code as string, name: (value as Json).name as string };
}

function parseMoney(status: number, value: unknown): Money | null {
  if (value === null) return null;
  need(status, isObject(value) && isCount(value.amount) && typeof value.currency === "string" && /^[A-Z]{3}$/.test(value.currency));
  return { amount: (value as Json).amount as number, currency: (value as Json).currency as string };
}

function parseListing(status: number, value: unknown): ExternalListing {
  need(
    status,
    isObject(value) && isUuid(value.id) && isText(value.title, 200) && value.title.trim() !== "" && (value.location === null || isText(value.location, 120)) &&
      (value.listedAt === null || isIso(value.listedAt)) && Array.isArray(value.alsoOn) && value.alsoOn.length <= 10 && isSafeExternalUrl(value.url) &&
      typeof value.score === "number" && Number.isFinite(value.score) && value.score >= 0 && value.score <= 100 && isIso(value.seenAt) && (value.confirmedAt === null || isIso(value.confirmedAt)),
  );
  const item = value as Json;
  return {
    id: item.id as string,
    title: item.title as string,
    price: parseMoney(status, item.price),
    location: item.location as string | null,
    listedAt: item.listedAt as string | null,
    source: parseSourceRef(status, item.source),
    alsoOn: (item.alsoOn as unknown[]).map((entry) => parseSourceRef(status, entry)),
    url: item.url as string,
    score: item.score as number,
    seenAt: item.seenAt as string,
    confirmedAt: item.confirmedAt as string | null,
  };
}

export function parseListingsPage(status: number, json: unknown): ExternalListingsPage {
  need(status, isObject(json) && json.contractVersion === EXTERNAL_LISTINGS_CONTRACT_VERSION && Array.isArray(json.items) && json.items.length <= 50);
  const body = json as Json;
  need(status, typeof body.hasMore === "boolean" && (body.nextCursor === null || (typeof body.nextCursor === "string" && CURSOR.test(body.nextCursor))));
  return {
    items: (body.items as unknown[]).map((item) => parseListing(status, item)),
    nextCursor: body.nextCursor as string | null,
    hasMore: body.hasMore as boolean,
  };
}

function parseSource(status: number, value: unknown): AdminCollectionSource {
  need(
    status,
    isObject(value) && typeof value.code === "string" && SOURCE_CODE.test(value.code) && isText(value.name, 80) && isText(value.type, 20) && typeof value.enabled === "boolean" &&
      (value.state === "disabled" || value.state === "closed" || value.state === "open" || value.state === "half_open") && isCount(value.consecutiveFailures) &&
      (value.breakerOpenUntil === null || isIso(value.breakerOpenUntil)) && isCount(value.usedToday) && isCount(value.dailyQuota) && isCount(value.minIntervalMs) &&
      (value.lastSuccessAt === null || isIso(value.lastSuccessAt)) && (value.lastFailureAt === null || isIso(value.lastFailureAt)) &&
      (value.lastErrorCode === null || (typeof value.lastErrorCode === "string" && /^[a-z0-9_]{1,60}$/.test(value.lastErrorCode))),
  );
  const row = value as Json;
  return {
    code: row.code as string,
    name: row.name as string,
    type: row.type as string,
    enabled: row.enabled as boolean,
    state: row.state as BreakerState,
    consecutiveFailures: row.consecutiveFailures as number,
    breakerOpenUntil: row.breakerOpenUntil as string | null,
    usedToday: row.usedToday as number,
    dailyQuota: row.dailyQuota as number,
    minIntervalMs: row.minIntervalMs as number,
    lastSuccessAt: row.lastSuccessAt as string | null,
    lastFailureAt: row.lastFailureAt as string | null,
    lastErrorCode: row.lastErrorCode as string | null,
  };
}

export function parseAdminCollection(status: number, json: unknown): AdminCollection {
  need(
    status,
    isObject(json) && json.contractVersion === ADMIN_COLLECTION_CONTRACT_VERSION && typeof json.schemaReady === "boolean" && Array.isArray(json.sources) && json.sources.length <= 50 &&
      isObject(json.watches) && isObject(json.listings) && Array.isArray(json.errors) && json.errors.length <= 50 && isIso(json.readAt),
  );
  const body = json as Json;
  const watches = body.watches as Json;
  const listings = body.listings as Json;
  need(status, [watches.total, watches.active, watches.paused, watches.due, listings.available, listings.gone, listings.unknown, listings.groups].every(isCount));
  return {
    schemaReady: body.schemaReady as boolean,
    sources: (body.sources as unknown[]).map((source) => parseSource(status, source)),
    watches: { total: watches.total as number, active: watches.active as number, paused: watches.paused as number, due: watches.due as number },
    listings: { available: listings.available as number, gone: listings.gone as number, unknown: listings.unknown as number, groups: listings.groups as number },
    errors: (body.errors as unknown[]).map((entry) => {
      need(status, isObject(entry) && isIso(entry.at) && typeof entry.sourceCode === "string" && SOURCE_CODE.test(entry.sourceCode) && isText(entry.sourceName, 80) && typeof entry.code === "string" && /^[a-z0-9_]{1,60}$/.test(entry.code));
      const row = entry as Json;
      return { at: row.at as string, sourceCode: row.sourceCode as string, sourceName: row.sourceName as string, code: row.code as string };
    }),
    readAt: body.readAt as string,
  };
}

// ───────────── client ─────────────

export interface ExternalClientOptions {
  /** fetch injecté (tests) ; par défaut le fetch global, résolu à chaque appel. */
  fetch?: typeof fetch;
}

export interface ExternalListingsQuery {
  limit?: number;
  cursor?: string;
}

export function createExternalClient(options: ExternalClientOptions = {}) {
  async function get(path: string, requestOptions: RequestOptions = {}): Promise<{ status: number; json: unknown }> {
    let response: Response;
    try {
      response = await (options.fetch ?? fetch)(path, { method: "GET", headers: { Accept: "application/json" }, credentials: "same-origin", cache: "no-store", signal: requestOptions.signal });
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
      if (isObject(json) && isObject(json.error) && typeof json.error.code === "string" && ERROR_CODE.test(json.error.code) && typeof json.error.message === "string" && json.error.message.length <= 500) {
        throw new ApiError(response.status, json.error.code, json.error.message);
      }
      throw fixedError(response.status, API_INVALID_RESPONSE);
    }
    return { status: response.status, json };
  }

  return {
    /** Annonces d'autres sites compatibles avec le besoin (section « Sur d'autres sites »). */
    async listings(demandId: string, query: ExternalListingsQuery = {}, requestOptions?: RequestOptions): Promise<ExternalListingsPage> {
      if (!isUuid(demandId)) throw fixedError(0, API_INVALID_ID);
      const params = new URLSearchParams();
      if (query.limit !== undefined) {
        if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > 30) throw fixedError(0, "invalid_argument");
        params.set("limit", String(query.limit));
      }
      if (query.cursor !== undefined) {
        if (!CURSOR.test(query.cursor)) throw fixedError(0, "invalid_argument");
        params.set("cursor", query.cursor);
      }
      const text = params.toString();
      const { status, json } = await get(`/api/demands/${demandId}/external-listings${text ? `?${text}` : ""}`, requestOptions);
      return parseListingsPage(status, json);
    },
    /** État de la collecte pour l'administration. */
    async adminCollection(requestOptions?: RequestOptions): Promise<AdminCollection> {
      const { status, json } = await get("/api/admin/collection", requestOptions);
      return parseAdminCollection(status, json);
    },
  };
}

export type ExternalClient = ReturnType<typeof createExternalClient>;

/** Client du navigateur : fetch global, même origine. */
export const external: ExternalClient = createExternalClient();

export type ExternalErrorContext = "listings" | "admin";

/** Message FIXE pour l'utilisateur : jamais le texte d'une exception ni celui du serveur. */
export function describeExternalError(error: unknown, context: ExternalErrorContext): string {
  if (!(error instanceof ApiError)) return "Une erreur est survenue. Réessayez dans un instant.";
  if (error.code === API_NETWORK_ERROR) return "Connexion impossible. Vérifiez votre réseau et réessayez.";
  if (error.code === API_ABORTED) return "Requête interrompue.";
  if (error.status === 401) return "Votre session a expiré. Reconnectez-vous pour continuer.";
  if (context === "admin") return error.status === 404 ? "Page introuvable." : "Le service est temporairement indisponible. Réessayez dans un instant.";
  if (error.status === 404) return "Ce besoin n'est plus disponible.";
  return "Les annonces d'autres sites sont momentanément indisponibles.";
}
