import "server-only";

import type { Pool } from "pg";
import { AUTH_SESSION_COOKIE } from "../auth/http";
import { resolveSession as resolveStoredSession } from "../auth/sessions";
import type { AuthClock, ResolvedSession, SessionContext } from "../auth/types";
import { noStoreJsonResponse, readSingleCookie } from "../http/protection";
import { getPostgresPool } from "../postgres/client";
import { readBuyerHome, readVendorHome } from "./reads";

/**
 * Routes HTTP des accueils (lot D1) : GET /api/home/buyer et GET /api/home/vendor. Lecture seule, propriétaire TOUJOURS pris dans la session, aucun paramètre accepté,
 * réponses `no-store`, textes fixes, journal serveur limité à un code. Les DTO sont ceux de `reads.ts` (liste blanche : aucun identifiant d'acheteur, aucun
 * téléphone, aucun compte exact de besoins côté vendeur).
 */

const LOG_CODE = /^[A-Za-z0-9_]{1,40}$/;

export interface HomeHttpDependencies {
  pool?: Pool;
  now?: AuthClock;
  resolveSession?: (token: string, context: SessionContext) => Promise<ResolvedSession | null>;
  log?: (code: string) => void;
}

export interface HomeHttpHandlers {
  buyer(request: Request): Promise<Response>;
  vendor(request: Request): Promise<Response>;
}

const failure = (status: number, code: string, message: string): Response => noStoreJsonResponse(status, { error: { code, message } });

function logCodeOf(error: unknown): string {
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" && LOG_CODE.test(code) ? code : "unexpected_error";
}

export function createHomeHttpHandlers(dependencies: HomeHttpDependencies = {}): HomeHttpHandlers {
  const readSession = dependencies.resolveSession ?? resolveStoredSession;
  const clock = (): Date => (dependencies.now ?? (() => new Date()))();
  const poolOf = (): Pool => dependencies.pool ?? getPostgresPool();

  function unavailable(code: string): Response {
    try {
      if (dependencies.log) dependencies.log(code);
      else console.error(`[home-http] ${code}`);
    } catch {
      // Un journal défaillant ne change jamais la réponse.
    }
    return failure(503, "home_unavailable", "Le service est temporairement indisponible.");
  }

  async function handle(request: Request, read: (userId: string) => Promise<unknown>): Promise<Response> {
    const token = readSingleCookie(request, AUTH_SESSION_COOKIE);
    if (!token) return failure(401, "authentication_required", "Authentification requise.");
    let userId: string;
    try {
      const session = await readSession(token, { pool: dependencies.pool, now: dependencies.now });
      if (!session) return failure(401, "authentication_required", "Authentification requise.");
      userId = session.userId;
    } catch (error) {
      return unavailable(logCodeOf(error));
    }
    if ([...new URL(request.url).searchParams.keys()].length > 0) return failure(400, "invalid_request", "Requête invalide.");
    try {
      return noStoreJsonResponse(200, await read(userId));
    } catch (error) {
      return unavailable(logCodeOf(error));
    }
  }

  return {
    buyer: (request) => handle(request, (userId) => readBuyerHome({ pool: poolOf(), userId, now: clock() })),
    vendor: (request) => handle(request, (userId) => readVendorHome({ pool: poolOf(), userId, now: clock() })),
  };
}

export const defaultHomeHttpHandlers = createHomeHttpHandlers();
