import "server-only";

import { noStoreJsonResponse } from "../http/protection";
import { UUID, createSocialContext, failure, hasUnexpectedQuery, invalidRequest, logCodeOf, resourceNotFound, type SocialHttpDependencies } from "../social/http-common";
import { SHARES_CONTRACT_VERSION, SHARE_PATH_PREFIX, SHARE_TOKEN_PATTERN } from "../../shares-rules";
import { SHARE_ERROR_MESSAGES, ShareError, createShareLink, readSharedNeed, readShareStatus, revokeShareLink } from "./shares";

/**
 * Routes HTTP du lien de partage d'un besoin (lot FIN3-C4) : `no-store`, origine vérifiée sur les écritures (AVANT la session).
 *  - GET    /api/demands/{id}/share   : l'état du lien (actif ou non, date de création : jamais le jeton) ;
 *  - POST   /api/demands/{id}/share   : crée un lien (révoque le précédent) → 201 { path, token, createdAt } : le jeton n'est montré QU'ICI ; 429 `share_daily_limit` ;
 *  - DELETE /api/demands/{id}/share   : révoque le lien actif (rejoué : sans effet) ;
 *  - GET    /api/shared-needs/{token} : PUBLIC, sans session : le résumé du besoin sans identité ; un jeton inconnu, révoqué ou d'un besoin plus actif : le MÊME 404.
 * La réponse publique porte `X-Robots-Tag: noindex, nofollow` et `Referrer-Policy: no-referrer` (le jeton est dans l'adresse : il ne doit fuir par aucun en-tête Referer).
 */

const PUBLIC_HEADERS = { "X-Robots-Tag": "noindex, nofollow", "Referrer-Policy": "no-referrer" } as const;

export interface SharesHttpHandlers {
  status(request: Request, demandId: string): Promise<Response>;
  create(request: Request, demandId: string): Promise<Response>;
  revoke(request: Request, demandId: string): Promise<Response>;
  shared(request: Request, token: string): Promise<Response>;
}

export function mapShareError(error: unknown): Response | null {
  if (!(error instanceof ShareError)) return null;
  return error.code === "not_found" ? resourceNotFound() : failure(429, "share_daily_limit", SHARE_ERROR_MESSAGES.daily_limit);
}

export function createSharesHttpHandlers(dependencies: SocialHttpDependencies = {}): SharesHttpHandlers {
  const context = createSocialContext(dependencies, "shares-http");

  async function guarded(request: Request, options: { write: boolean }, run: (userId: string) => Promise<Response>): Promise<Response> {
    if (options.write) {
      const refusal = context.originGuard(request);
      if (refusal) return refusal;
    }
    const authenticated = await context.authenticate(request);
    if (!authenticated.ok) return authenticated.response;
    try {
      return await run(authenticated.userId);
    } catch (error) {
      const mapped = mapShareError(error) ?? context.mapError(error);
      if (mapped) return mapped;
      return context.unavailable(logCodeOf(error), "shares");
    }
  }

  return {
    status: (request, demandId) =>
      guarded(request, { write: false }, async (userId) => {
        if (!UUID.test(demandId) || hasUnexpectedQuery(request)) return resourceNotFound();
        const status = await readShareStatus({ pool: context.poolOf(), ownerId: userId, demandId: demandId.toLowerCase() });
        return noStoreJsonResponse(200, { contractVersion: SHARES_CONTRACT_VERSION, share: { active: status.active, createdAt: status.createdAt === null ? null : status.createdAt.toISOString() } });
      }),

    create: (request, demandId) =>
      guarded(request, { write: true }, async (userId) => {
        if (!UUID.test(demandId) || hasUnexpectedQuery(request)) return resourceNotFound();
        const body = await context.readJsonObject(request, 64);
        if (body === null || Object.keys(body).length > 0) return invalidRequest();
        const created = await createShareLink({ pool: context.poolOf(), ownerId: userId, demandId: demandId.toLowerCase() });
        return noStoreJsonResponse(201, { contractVersion: SHARES_CONTRACT_VERSION, share: { path: `${SHARE_PATH_PREFIX}${created.token}`, token: created.token, createdAt: created.createdAt.toISOString() } });
      }),

    revoke: (request, demandId) =>
      guarded(request, { write: true }, async (userId) => {
        if (!UUID.test(demandId) || hasUnexpectedQuery(request)) return resourceNotFound();
        const result = await revokeShareLink({ pool: context.poolOf(), ownerId: userId, demandId: demandId.toLowerCase() });
        return noStoreJsonResponse(200, { contractVersion: SHARES_CONTRACT_VERSION, revoked: result.revoked });
      }),

    shared: async (request, token) => {
      if (hasUnexpectedQuery(request) || !SHARE_TOKEN_PATTERN.test(token)) return failure(404, "resource_not_found", "Ressource introuvable.", PUBLIC_HEADERS);
      try {
        const need = await readSharedNeed({ pool: context.poolOf(), token });
        if (need === null) return failure(404, "resource_not_found", "Ressource introuvable.", PUBLIC_HEADERS);
        return noStoreJsonResponse(200, { contractVersion: SHARES_CONTRACT_VERSION, need }, PUBLIC_HEADERS);
      } catch (error) {
        return context.unavailable(logCodeOf(error), "shares");
      }
    },
  };
}

export const defaultSharesHttpHandlers = createSharesHttpHandlers();
