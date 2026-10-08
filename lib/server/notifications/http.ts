import "server-only";

import type { Pool } from "pg";
import { AUTH_SESSION_COOKIE } from "../auth/http";
import { resolveSession as resolveStoredSession } from "../auth/sessions";
import type { AuthClock, ResolvedSession, SessionContext } from "../auth/types";
import { CatalogNotFoundError, CatalogValidationError } from "../catalog/errors";
import { checkPostOrigin, noStoreJsonResponse, readSingleCookie } from "../http/protection";
import { getPostgresPool } from "../postgres/client";
import { readStrictJsonBody } from "../wallet/http";
import {
  DEMAND_TRACKING_CONTRACT_VERSION,
  EXTERNAL_NOTICE,
  EXTERNAL_NOTICE_REAL,
  MENO_CHANNEL,
  NOTIFICATIONS_CONTRACT_VERSION,
  NOTIFICATIONS_PAGE_DEFAULT_LIMIT,
  NOTIFICATIONS_PAGE_MAX_LIMIT,
  NOTIFICATIONS_READ_MAX_IDS,
  NOTIFICATION_PREFERENCES_CONTRACT_VERSION,
} from "./config";
import { listNotifications, markNotificationsRead, type NotificationItem } from "./inbox";
import { readNotificationPreferences, writeNotificationPreferences } from "./preferences";
import {
  TRACKING_ACTIONS,
  TrackingNotActiveError,
  applyTrackingAction,
  readDemandTracking,
  type DemandTracking,
  type TrackingAction,
} from "./tracking";
import { resolveNotificationTransport } from "./transport";

/**
 * Routes HTTP des notifications et du suivi des besoins (lot N1) :
 *  - GET  /api/notifications                     : les notifications de l'utilisateur (curseur) et le nombre de non-lues ;
 *  - POST /api/notifications/read                : marque comme lues `{ ids }` ou `{ all: true, upTo }` (tout ce qui a été vu : créé avant ou à `upTo`) (origine vérifiée AVANT la session) ;
 *  - GET  /api/notifications/preferences, PUT    : envoi externe simulé `{ externalEnabled }` (origine vérifiée AVANT la session) ;
 *  - GET  /api/demands/{id}/tracking, POST       : suivi du besoin ; POST `{ action: extend | pause | resume }` (origine vérifiée AVANT la session).
 * Le propriétaire vient TOUJOURS de la session. Réponses `no-store`, textes fixes (jamais une donnée de la base), DTO en liste blanche avec `contractVersion`,
 * 404 identique pour toute ressource d'autrui ou inconnue, journal serveur limité à un code. Voir NOTIFICATIONS.md.
 */

const BODY_MAX_BYTES = 4_096;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LOG_CODE = /^[A-Za-z0-9_]{1,40}$/;

type Environment = Record<string, string | undefined>;

export interface NotificationsHttpDependencies {
  pool?: Pool;
  now?: AuthClock;
  env?: Environment;
  resolveSession?: (token: string, context: SessionContext) => Promise<ResolvedSession | null>;
  /** Disponibilité affichée d'un envoi externe (défaut : un transport existe dans cet environnement). Réservé aux tests. */
  transportAvailable?: (env: Environment) => boolean;
  /** Le transport disponible est-il le transport SMS RÉEL ? (défaut : le transport résolu est « meno »). Lot SMS1-bis (M5). Réservé aux tests. */
  realTransport?: (env: Environment) => boolean;
  /** Journal serveur : ne reçoit QU'UN code. Un journal qui lève est ignoré. Défaut : console.error. */
  log?: (code: string) => void;
}

export interface NotificationsHttpHandlers {
  notifications: {
    list(request: Request): Promise<Response>;
    read(request: Request): Promise<Response>;
  };
  preferences: {
    get(request: Request): Promise<Response>;
    put(request: Request): Promise<Response>;
  };
  tracking: {
    get(request: Request, demandId: string): Promise<Response>;
    act(request: Request, demandId: string): Promise<Response>;
  };
}

// ───────────── réponses (textes fixes) ─────────────

function failure(status: number, code: string, message: string): Response {
  return noStoreJsonResponse(status, { error: { code, message } });
}

const unauthorized = () => failure(401, "authentication_required", "Authentification requise.");
const forbiddenOrigin = () => failure(403, "invalid_origin", "Origine de la requête non autorisée.");
const invalidRequest = () => failure(400, "invalid_request", "Requête invalide.");
/** Ressource inexistante ET ressource d'autrui : la MÊME réponse. */
const resourceNotFound = () => failure(404, "resource_not_found", "Ressource introuvable.");
const demandNotActive = () => failure(409, "demand_not_active", "Le suivi n'est disponible que pour un besoin actif.");
const unavailableResponse = () => failure(503, "notifications_unavailable", "Le service est temporairement indisponible.");

// ───────────── DTO (liste blanche) ─────────────

function itemDto(item: NotificationItem) {
  return {
    id: item.id,
    kind: item.kind,
    title: item.title,
    price: item.price === null ? null : { amount: item.price.amount, currency: item.price.currency },
    count: item.count,
    demandId: item.demandId,
    offerId: item.offerId,
    link: item.link,
    createdAt: item.createdAt.toISOString(),
    readAt: item.readAt === null ? null : item.readAt.toISOString(),
  };
}

function trackingDto(tracking: DemandTracking) {
  return {
    demandId: tracking.demandId,
    demandStatus: tracking.demandStatus,
    until: tracking.until.toISOString(),
    paused: tracking.paused,
    active: tracking.active,
    maxUntil: tracking.maxUntil.toISOString(),
    readAt: tracking.readAt.toISOString(),
  };
}

// ───────────── lecture stricte des entrées ─────────────

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Seuls `limit` (1 à 50, défaut 20) et `cursor` sont admis, chacun au plus une fois. */
function parseListQuery(request: Request): { limit: number; cursor: string | null } {
  const parameters = new URL(request.url).searchParams;
  if ([...parameters.keys()].some((key) => key !== "limit" && key !== "cursor")) throw new CatalogValidationError("Paramètre non autorisé.");
  const limits = parameters.getAll("limit");
  const cursors = parameters.getAll("cursor");
  if (limits.length > 1 || cursors.length > 1) throw new CatalogValidationError("Paramètre dupliqué.");
  let limit = NOTIFICATIONS_PAGE_DEFAULT_LIMIT;
  if (limits.length === 1) {
    if (!/^[0-9]+$/.test(limits[0])) throw new CatalogValidationError("limit doit être un entier.");
    limit = Number(limits[0]);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > NOTIFICATIONS_PAGE_MAX_LIMIT) {
      throw new CatalogValidationError(`limit doit être compris entre 1 et ${NOTIFICATIONS_PAGE_MAX_LIMIT}.`);
    }
  }
  return { limit, cursor: cursors.length === 1 ? cursors[0] : null };
}

function hasQuery(request: Request): boolean {
  return [...new URL(request.url).searchParams.keys()].length > 0;
}

/** `upTo` : un instant ISO 8601 en UTC à la milliseconde (`YYYY-MM-DDTHH:MM:SS.mmmZ`), tel que l'API le sert (`createdAt`) ; toute autre forme est refusée. */
const UP_TO = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/;

function parseUpTo(value: unknown): Date {
  if (typeof value !== "string" || !UP_TO.test(value)) throw new CatalogValidationError("upTo invalide.");
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || date.toISOString() !== value) throw new CatalogValidationError("upTo invalide.");
  return date;
}

/** Exactement `{ "ids": [uuid, …] }` (1 à 100) ou `{ "all": true, "upTo": "<createdAt de la plus récente notification affichée>" }`. */
function parseReadBody(value: unknown): { all: true; upTo: Date } | { ids: string[] } {
  if (!isPlainObject(value)) throw new CatalogValidationError("Corps invalide.");
  const keys = Object.keys(value).sort();
  if (keys.length === 2 && keys[0] === "all" && keys[1] === "upTo") {
    if (value.all !== true) throw new CatalogValidationError("all doit valoir true.");
    return { all: true, upTo: parseUpTo(value.upTo) };
  }
  if (keys.length === 1 && keys[0] === "ids") {
    const { ids } = value;
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > NOTIFICATIONS_READ_MAX_IDS || ids.some((id) => typeof id !== "string" || !UUID.test(id))) {
      throw new CatalogValidationError("ids invalide.");
    }
    return { ids: ids as string[] };
  }
  throw new CatalogValidationError("Corps invalide.");
}

/** Exactement `{ "externalEnabled": booléen }`. */
function parsePreferencesBody(value: unknown): { externalEnabled: boolean } {
  if (!isPlainObject(value)) throw new CatalogValidationError("Corps invalide.");
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== "externalEnabled" || typeof value.externalEnabled !== "boolean") throw new CatalogValidationError("Corps invalide.");
  return { externalEnabled: value.externalEnabled };
}

/** Exactement `{ "action": "extend" | "pause" | "resume" }`. */
function parseTrackingBody(value: unknown): { action: TrackingAction } {
  if (!isPlainObject(value)) throw new CatalogValidationError("Corps invalide.");
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== "action" || typeof value.action !== "string" || !(TRACKING_ACTIONS as readonly string[]).includes(value.action)) {
    throw new CatalogValidationError("Corps invalide.");
  }
  return { action: value.action as TrackingAction };
}

function logCodeOf(error: unknown): string {
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" && LOG_CODE.test(code) ? code : "unexpected_error";
}

// ───────────── gestionnaires ─────────────

export function createNotificationsHttpHandlers(dependencies: NotificationsHttpDependencies = {}): NotificationsHttpHandlers {
  const environment = (): Environment => dependencies.env ?? process.env;
  const readSession = dependencies.resolveSession ?? resolveStoredSession;
  const clock = (): Date => (dependencies.now ?? (() => new Date()))();
  const poolOf = (): Pool => dependencies.pool ?? getPostgresPool();
  const transportAvailable = dependencies.transportAvailable ?? ((env: Environment) => resolveNotificationTransport(env) !== undefined);
  const realTransport = dependencies.realTransport ?? ((env: Environment) => resolveNotificationTransport(env)?.channel === MENO_CHANNEL);

  function journal(code: string): void {
    try {
      if (dependencies.log) dependencies.log(code);
      else console.error(`[notifications-http] ${code}`);
    } catch {
      // Un journal défaillant ne doit jamais changer la réponse.
    }
  }

  function unavailable(code: string): Response {
    journal(code);
    return unavailableResponse();
  }

  /** Domaine → HTTP. Tout ce qui n'est pas explicitement connu devient 503, sans le message de l'erreur. */
  function mapError(error: unknown): Response {
    if (error instanceof CatalogValidationError) return invalidRequest();
    if (error instanceof CatalogNotFoundError) return resourceNotFound();
    if (error instanceof TrackingNotActiveError) return demandNotActive();
    // Lot MV1 : le suivi du besoin porteur d'une mission ouverte ne change que par la mission (garde-fou de la base, migration 0027).
    const raised = error as { code?: unknown; message?: unknown } | null;
    if (raised?.code === "23001" && raised.message === "mission_carrier_locked") return failure(409, "mission_carrier_locked", "Ce besoin appartient à une mission : modifiez la mission.");
    return unavailable(logCodeOf(error));
  }

  async function authenticate(request: Request): Promise<{ ok: true; userId: string } | { ok: false; response: Response }> {
    const token = readSingleCookie(request, AUTH_SESSION_COOKIE);
    if (!token) return { ok: false, response: unauthorized() };
    try {
      const session = await readSession(token, { pool: dependencies.pool, now: dependencies.now });
      return session ? { ok: true, userId: session.userId } : { ok: false, response: unauthorized() };
    } catch (error) {
      return { ok: false, response: unavailable(logCodeOf(error)) };
    }
  }

  /** Origine AVANT la session : une requête d'origine douteuse n'atteint ni la résolution de session ni la base. */
  function originRefusal(request: Request): Response | null {
    const origin = checkPostOrigin(request, environment().NOMA_AUTH_ORIGIN);
    if (origin === "unconfigured") return unavailable("origin_unconfigured");
    return origin === "forbidden" ? forbiddenOrigin() : null;
  }

  function preferencesBody(externalEnabled: boolean) {
    const env = environment();
    const available = transportAvailable(env);
    // Lot SMS1 / SMS1-bis (M5) : le texte « SMS réel » n'est affiché que si le transport de notification est RÉELLEMENT disponible et réel (clé valide, NODE_ENV ou base locale,
    // NOMA_PUBLIC_URL, pas de configuration ambiguë) ; sinon l'utilisateur lirait une promesse que rien ne tiendra. `real` n'est présent que dans ce cas.
    const real = available && realTransport(env);
    return {
      contractVersion: NOTIFICATION_PREFERENCES_CONTRACT_VERSION,
      preferences: { externalEnabled },
      external: {
        available,
        notice: real ? EXTERNAL_NOTICE_REAL : EXTERNAL_NOTICE,
        ...(real ? { real: true } : {}),
      },
    };
  }

  return {
    notifications: {
      async list(request) {
        const authenticated = await authenticate(request);
        if (!authenticated.ok) return authenticated.response;
        try {
          const query = parseListQuery(request);
          const page = await listNotifications({ pool: poolOf(), userId: authenticated.userId, limit: query.limit, cursor: query.cursor });
          return noStoreJsonResponse(200, {
            contractVersion: NOTIFICATIONS_CONTRACT_VERSION,
            unreadCount: page.unreadCount,
            items: page.items.map(itemDto),
            nextCursor: page.nextCursor,
          });
        } catch (error) {
          return mapError(error);
        }
      },

      async read(request) {
        const refused = originRefusal(request);
        if (refused) return refused;
        const authenticated = await authenticate(request);
        if (!authenticated.ok) return authenticated.response;
        if (hasQuery(request)) return invalidRequest();
        const body = await readStrictJsonBody(request, BODY_MAX_BYTES);
        if (!body.ok) return invalidRequest();
        try {
          const result = await markNotificationsRead({ pool: poolOf(), userId: authenticated.userId, target: parseReadBody(body.value) });
          return noStoreJsonResponse(200, { contractVersion: NOTIFICATIONS_CONTRACT_VERSION, marked: result.marked, unreadCount: result.unreadCount });
        } catch (error) {
          return mapError(error);
        }
      },
    },

    preferences: {
      async get(request) {
        const authenticated = await authenticate(request);
        if (!authenticated.ok) return authenticated.response;
        if (hasQuery(request)) return invalidRequest();
        try {
          const preferences = await readNotificationPreferences({ pool: poolOf(), userId: authenticated.userId });
          return noStoreJsonResponse(200, preferencesBody(preferences.externalEnabled));
        } catch (error) {
          return mapError(error);
        }
      },

      async put(request) {
        const refused = originRefusal(request);
        if (refused) return refused;
        const authenticated = await authenticate(request);
        if (!authenticated.ok) return authenticated.response;
        if (hasQuery(request)) return invalidRequest();
        const body = await readStrictJsonBody(request, BODY_MAX_BYTES);
        if (!body.ok) return invalidRequest();
        try {
          const parsed = parsePreferencesBody(body.value);
          const preferences = await writeNotificationPreferences({ pool: poolOf(), userId: authenticated.userId, externalEnabled: parsed.externalEnabled });
          return noStoreJsonResponse(200, preferencesBody(preferences.externalEnabled));
        } catch (error) {
          return mapError(error);
        }
      },
    },

    tracking: {
      async get(request, demandId) {
        const authenticated = await authenticate(request);
        if (!authenticated.ok) return authenticated.response;
        if (!UUID.test(demandId) || hasQuery(request)) return invalidRequest();
        try {
          const tracking = await readDemandTracking({ pool: poolOf(), ownerId: authenticated.userId, demandId, now: clock() });
          if (tracking === null) return resourceNotFound();
          return noStoreJsonResponse(200, { contractVersion: DEMAND_TRACKING_CONTRACT_VERSION, tracking: trackingDto(tracking) });
        } catch (error) {
          return mapError(error);
        }
      },

      async act(request, demandId) {
        const refused = originRefusal(request);
        if (refused) return refused;
        const authenticated = await authenticate(request);
        if (!authenticated.ok) return authenticated.response;
        if (!UUID.test(demandId) || hasQuery(request)) return invalidRequest();
        const body = await readStrictJsonBody(request, BODY_MAX_BYTES);
        if (!body.ok) return invalidRequest();
        try {
          const { action } = parseTrackingBody(body.value);
          const tracking = await applyTrackingAction({ pool: poolOf(), ownerId: authenticated.userId, demandId, action, now: clock() });
          return noStoreJsonResponse(200, { contractVersion: DEMAND_TRACKING_CONTRACT_VERSION, tracking: trackingDto(tracking) });
        } catch (error) {
          return mapError(error);
        }
      },
    },
  };
}

export const defaultNotificationsHttpHandlers = createNotificationsHttpHandlers();
