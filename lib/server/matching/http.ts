import "server-only";

import type { Pool } from "pg";
import { AUTH_SESSION_COOKIE } from "../auth/http";
import { resolveSession } from "../auth/sessions";
import type { AuthClock } from "../auth/types";
import {
  CatalogNotFoundError,
  CatalogOwnershipError,
  CatalogValidationError,
} from "../catalog/errors";
import {
  noStoreJsonResponse,
  readSingleCookie,
} from "../http/protection";
import {
  findEvaluatedDemandMatchesForOffer,
  findEvaluatedOfferMatchesForDemand,
} from "./service";
import { mapEvaluatedMatchesPageToDto, mapStoredMatchesPageToDto } from "./http-dto";
import { listStoredDemandMatchesForOffer, listStoredOfferMatchesForDemand } from "./stored-matches";
import { attachCoverPhotos } from "../media/read";
import { getPostgresPool } from "../postgres/client";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface MatchingHttpDependencies {
  pool?: Pool;
  now?: AuthClock;
  env?: Record<string, string | undefined>;
}

export interface MatchingHttpHandlers {
  demands: {
    matches(request: Request, id: string): Promise<Response>;
    storedMatches(request: Request, id: string): Promise<Response>;
  };
  offers: {
    matches(request: Request, id: string): Promise<Response>;
    storedMatches(request: Request, id: string): Promise<Response>;
  };
}

function matchingError(status: number, code: string, message: string): Response {
  return noStoreJsonResponse(status, { error: { code, message } });
}

function unauthorized(): Response {
  return matchingError(401, "authentication_required", "Authentification requise.");
}

function resourceNotFound(): Response {
  return matchingError(404, "resource_not_found", "Ressource introuvable.");
}

function invalidRequest(): Response {
  return matchingError(400, "invalid_request", "Requête invalide.");
}

function serviceUnavailable(): Response {
  return matchingError(
    503,
    "matching_unavailable",
    "Le service de matching est temporairement indisponible.",
  );
}

function mapMatchingError(error: unknown): Response {
  if (error instanceof CatalogValidationError) {
    return invalidRequest();
  }
  if (error instanceof CatalogNotFoundError || error instanceof CatalogOwnershipError) {
    return resourceNotFound();
  }
  return serviceUnavailable();
}

/**
 * Valide strictement les paramètres de requête HTTP.
 * Autorise uniquement 'limit' et 'cursor' ; les routes `stored-matches` autorisent en plus 'sort' (`allowSort`,
 * faux par défaut : les routes en direct refusent `sort`).
 * Rejette tout paramètre inconnu, répété ou mal formé.
 */
function parseQueryParams(
  request: Request,
  allowSort = false,
): { limit?: number; cursor?: string; sort?: "score" | "relevance" } {
  const url = new URL(request.url);
  const keys = [...url.searchParams.keys()];
  for (const key of keys) {
    if (key !== "limit" && key !== "cursor" && !(allowSort && key === "sort")) {
      throw new CatalogValidationError(`Paramètre non autorisé : ${key}`);
    }
  }
  if (url.searchParams.getAll("limit").length > 1) {
    throw new CatalogValidationError("Paramètre 'limit' dupliqué.");
  }
  if (url.searchParams.getAll("cursor").length > 1) {
    throw new CatalogValidationError("Paramètre 'cursor' dupliqué.");
  }
  if (url.searchParams.getAll("sort").length > 1) {
    throw new CatalogValidationError("Paramètre 'sort' dupliqué.");
  }

  let limit: number | undefined;
  if (url.searchParams.has("limit")) {
    const rawLimit = url.searchParams.get("limit")!;
    if (!/^[0-9]+$/.test(rawLimit)) {
      throw new CatalogValidationError("limit doit être un entier.");
    }
    limit = Number(rawLimit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new CatalogValidationError("limit doit être compris entre 1 et 100.");
    }
  }

  let cursor: string | undefined;
  if (url.searchParams.has("cursor")) {
    cursor = url.searchParams.get("cursor")!;
    if (typeof cursor !== "string" || cursor.trim().length === 0) {
      throw new CatalogValidationError("cursor doit être une chaîne non vide.");
    }
  }

  let sort: "score" | "relevance" | undefined;
  if (url.searchParams.has("sort")) {
    const rawSort = url.searchParams.get("sort");
    if (rawSort !== "score" && rawSort !== "relevance") {
      throw new CatalogValidationError("sort doit valoir score ou relevance.");
    }
    sort = rawSort;
  }

  return { limit, cursor, ...(allowSort ? { sort } : {}) };
}

export function createMatchingHttpHandlers(
  dependencies: MatchingHttpDependencies = {},
): MatchingHttpHandlers {
  async function authenticate(
    request: Request,
  ): Promise<{ ok: true; ownerId: string } | { ok: false; response: Response }> {
    const token = readSingleCookie(request, AUTH_SESSION_COOKIE);
    if (!token) return { ok: false, response: unauthorized() };
    try {
      const session = await resolveSession(token, {
        pool: dependencies.pool,
        now: dependencies.now,
      });
      return session
        ? { ok: true, ownerId: session.userId }
        : { ok: false, response: unauthorized() };
    } catch {
      return { ok: false, response: serviceUnavailable() };
    }
  }

  return {
    demands: {
      async matches(request: Request, id: string): Promise<Response> {
        const auth = await authenticate(request);
        if (!auth.ok) return auth.response;

        if (!UUID.test(id)) return invalidRequest();

        try {
          const { limit, cursor } = parseQueryParams(request);
          const page = await findEvaluatedOfferMatchesForDemand(
            auth.ownerId,
            id,
            { limit, cursor },
            dependencies.pool,
          );
          const dto = mapEvaluatedMatchesPageToDto(page);
          return noStoreJsonResponse(200, dto);
        } catch (error) {
          return mapMatchingError(error);
        }
      },
      async storedMatches(request: Request, id: string): Promise<Response> {
        const auth = await authenticate(request);
        if (!auth.ok) return auth.response;

        if (!UUID.test(id)) return invalidRequest();

        try {
          const { limit, cursor, sort } = parseQueryParams(request, true);
          const page = await listStoredOfferMatchesForDemand(
            auth.ownerId,
            id,
            { limit, cursor, sort },
            dependencies.pool,
          );
          const dto = mapStoredMatchesPageToDto(page);
          // Lot PH1 : vignette de couverture des annonces de la liste (décor : sans effet sur la réponse si la lecture échoue).
          await attachCoverPhotos(dependencies.pool ?? getPostgresPool(), dto.items);
          return noStoreJsonResponse(200, dto);
        } catch (error) {
          return mapMatchingError(error);
        }
      },
    },
    offers: {
      async matches(request: Request, id: string): Promise<Response> {
        const auth = await authenticate(request);
        if (!auth.ok) return auth.response;

        if (!UUID.test(id)) return invalidRequest();

        try {
          const { limit, cursor } = parseQueryParams(request);
          const page = await findEvaluatedDemandMatchesForOffer(
            auth.ownerId,
            id,
            { limit, cursor },
            dependencies.pool,
          );
          const dto = mapEvaluatedMatchesPageToDto(page);
          return noStoreJsonResponse(200, dto);
        } catch (error) {
          return mapMatchingError(error);
        }
      },
      async storedMatches(request: Request, id: string): Promise<Response> {
        const auth = await authenticate(request);
        if (!auth.ok) return auth.response;

        if (!UUID.test(id)) return invalidRequest();

        try {
          const { limit, cursor, sort } = parseQueryParams(request, true);
          const page = await listStoredDemandMatchesForOffer(
            auth.ownerId,
            id,
            { limit, cursor, sort },
            dependencies.pool,
          );
          return noStoreJsonResponse(200, mapStoredMatchesPageToDto(page));
        } catch (error) {
          return mapMatchingError(error);
        }
      },
    },
  };
}

export const defaultMatchingHttpHandlers = createMatchingHttpHandlers();
