import "server-only";

import type { Pool } from "pg";
import { AUTH_SESSION_COOKIE } from "../auth/http";
import { resolveSession as resolveStoredSession } from "../auth/sessions";
import type { AuthClock, ResolvedSession, SessionContext } from "../auth/types";
import { CatalogNotFoundError, CatalogValidationError } from "../catalog/errors";
import { checkPostOrigin, noStoreJsonResponse, readBodyCapped, readSingleCookie } from "../http/protection";
import { getPostgresPool } from "../postgres/client";
import { SocialError } from "./errors";

/**
 * Éléments communs des routes HTTP du lot D2 (favoris, messagerie, commandes, administration) : authentification par cookie de session, origine vérifiée AVANT la
 * session sur tout ce qui écrit, réponses `no-store` à textes fixes (jamais une donnée de la base), 404 identique pour tout accès refusé, journal serveur limité à un code.
 */

export type Environment = Record<string, string | undefined>;

export interface SocialHttpDependencies {
  pool?: Pool;
  now?: AuthClock;
  env?: Environment;
  /** Résolution de session (défaut : `resolveSession` de lib/server/auth). */
  resolveSession?: (token: string, context: SessionContext) => Promise<ResolvedSession | null>;
  /** Journal serveur : ne reçoit QU'UN code. Un journal qui lève est ignoré. Défaut : console.error. */
  log?: (code: string) => void;
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LOG_CODE = /^[A-Za-z0-9_]{1,40}$/;

export function failure(status: number, code: string, message: string, headers?: HeadersInit): Response {
  return noStoreJsonResponse(status, { error: { code, message } }, headers);
}

export const unauthorized = (): Response => failure(401, "authentication_required", "Authentification requise.");
export const forbiddenOrigin = (): Response => failure(403, "invalid_origin", "Origine de la requête non autorisée.");
export const invalidRequest = (): Response => failure(400, "invalid_request", "Requête invalide.");
/** Accès refusé, ressource inexistante, d'un autre : la MÊME réponse. */
export const resourceNotFound = (): Response => failure(404, "resource_not_found", "Ressource introuvable.");

export function logCodeOf(error: unknown): string {
  if (error instanceof SocialError) return error.code;
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" && LOG_CODE.test(code) ? code : "unexpected_error";
}

export interface SocialContext {
  poolOf(): Pool;
  environment(): Environment;
  clock(): Date;
  journal(code: string): void;
  unavailable(code: string, service: string): Response;
  /** Origine des requêtes qui écrivent : null si elle est correcte, sinon la réponse de refus. */
  originGuard(request: Request): Response | null;
  authenticate(request: Request): Promise<{ ok: true; userId: string } | { ok: false; response: Response }>;
  /** Corps JSON strict (objet simple) de taille bornée ; null si invalide. */
  readJsonObject(request: Request, maxBytes: number): Promise<Record<string, unknown> | null>;
  /** Traduit un refus de domaine en réponse HTTP ; null si l'erreur n'est pas un refus de domaine. */
  mapError(error: unknown): Response | null;
}

export function createSocialContext(dependencies: SocialHttpDependencies, serviceCode: string): SocialContext {
  const readSession = dependencies.resolveSession ?? resolveStoredSession;
  const environment = (): Environment => dependencies.env ?? process.env;

  function journal(code: string): void {
    try {
      if (dependencies.log) dependencies.log(code);
      else console.error(`[${serviceCode}] ${code}`);
    } catch {
      // Un journal défaillant ne change jamais la réponse.
    }
  }

  return {
    poolOf: () => dependencies.pool ?? getPostgresPool(),
    environment,
    clock: () => (dependencies.now ? dependencies.now() : new Date()),
    journal,
    unavailable(code, service) {
      journal(code);
      return failure(503, `${service}_unavailable`, "Le service est temporairement indisponible.");
    },
    originGuard(request) {
      const origin = checkPostOrigin(request, environment().NOMA_AUTH_ORIGIN);
      if (origin === "unconfigured") {
        journal("origin_unconfigured");
        return failure(503, `${serviceCode}_unavailable`, "Le service est temporairement indisponible.");
      }
      return origin === "forbidden" ? forbiddenOrigin() : null;
    },
    async authenticate(request) {
      const token = readSingleCookie(request, AUTH_SESSION_COOKIE);
      if (!token) return { ok: false, response: unauthorized() };
      try {
        const session = await readSession(token, { pool: dependencies.pool, now: dependencies.now });
        return session ? { ok: true, userId: session.userId } : { ok: false, response: unauthorized() };
      } catch (error) {
        journal(logCodeOf(error));
        return { ok: false, response: failure(503, `${serviceCode}_unavailable`, "Le service est temporairement indisponible.") };
      }
    },
    async readJsonObject(request, maxBytes) {
      const body = await readBodyCapped(request, maxBytes);
      if (!body.ok) return null;
      if (body.text.trim() === "") return {};
      let value: unknown;
      try {
        value = JSON.parse(body.text);
      } catch {
        return null;
      }
      if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
      const prototype = Object.getPrototypeOf(value);
      return prototype === Object.prototype || prototype === null ? (value as Record<string, unknown>) : null;
    },
    mapError(error) {
      if (error instanceof CatalogValidationError) return invalidRequest();
      if (error instanceof CatalogNotFoundError) return resourceNotFound();
      if (!(error instanceof SocialError)) return null;
      switch (error.code) {
        case "resource_not_found":
          return resourceNotFound();
        case "offer_not_available":
          return failure(409, "offer_not_available", "Cette annonce n'est plus disponible.");
        case "rate_limited":
          return failure(429, "rate_limited", "Trop de demandes : réessayez plus tard.", { "retry-after": String(error.retryAfterSeconds ?? 60) });
        case "favorites_limit":
          return failure(409, "favorites_limit", "Vous avez atteint la limite de 200 favoris.");
        case "invalid_message":
          return failure(400, "invalid_message", "Ce message n'est pas valide.");
        case "invalid_price":
          return failure(400, "invalid_price", "Le prix convenu doit être un entier de 1 à 100 000 000 FCFA.");
        case "order_active_exists":
          return failure(409, "order_active_exists", "Une commande est déjà en cours pour cette annonce.");
        case "order_state_conflict":
          return failure(409, "order_state_conflict", "Cette commande ne peut plus changer d'état.");
        case "action_not_allowed":
          return failure(403, "action_not_allowed", "Cette action n'est pas permise pour votre rôle.");
        default:
          return null;
      }
    },
  };
}

/** Aucun paramètre de requête n'est admis (hors liste blanche donnée). */
export function hasUnexpectedQuery(request: Request, allowed: readonly string[] = []): boolean {
  const keys = [...new URL(request.url).searchParams.keys()];
  return keys.some((key) => !allowed.includes(key)) || new Set(keys).size !== keys.length;
}

export function isoOrNull(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}
