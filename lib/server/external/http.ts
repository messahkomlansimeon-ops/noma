import "server-only";

import { noStoreJsonResponse } from "../http/protection";
import { UUID, createSocialContext, hasUnexpectedQuery, invalidRequest, logCodeOf, resourceNotFound, type SocialHttpDependencies } from "../social/http-common";
import { readAdminCollection } from "./admin-reads";
import { ADMIN_COLLECTION_CONTRACT_VERSION, EXTERNAL_LISTINGS_CONTRACT_VERSION, EXTERNAL_PAGE_MAX } from "./config";
import { listExternalMatchesForDemand } from "./matching";

/**
 * Routes HTTP de la collecte externe (lot EXT1). Toutes `no-store`, en lecture seule.
 *  - GET /api/demands/{id}/external-listings?limit&cursor : annonces d'AUTRES SITES compatibles avec son besoin actif (section « Sur d'autres sites »). Session exigée (401 sinon),
 *    404 pour le besoin d'autrui, 400 pour un besoin inactif. Réponse en liste blanche : ni identifiant chez la source, ni numéro de téléphone, ni boost.
 *  - GET /api/admin/collection : état de la collecte pour l'administration ; le MÊME 404 « Ressource introuvable » pour tout ce qui n'est pas un administrateur actif.
 */

export interface ExternalHttpHandlers {
  demandListings(request: Request, demandId: string): Promise<Response>;
  adminCollection(request: Request): Promise<Response>;
}

const iso = (value: Date | null): string | null => (value === null ? null : value.toISOString());

export function createExternalHttpHandlers(dependencies: SocialHttpDependencies = {}): ExternalHttpHandlers {
  const context = createSocialContext(dependencies, "external-http");

  return {
    async demandListings(request, demandId) {
      const authenticated = await context.authenticate(request);
      if (!authenticated.ok) return authenticated.response;
      if (!UUID.test(demandId) || hasUnexpectedQuery(request, ["limit", "cursor"])) return invalidRequest();
      const parameters = new URL(request.url).searchParams;
      let limit: number | undefined;
      if (parameters.has("limit")) {
        const text = parameters.get("limit") ?? "";
        if (!/^[0-9]{1,3}$/.test(text) || Number(text) < 1 || Number(text) > EXTERNAL_PAGE_MAX) return invalidRequest();
        limit = Number(text);
      }
      const cursor = parameters.has("cursor") ? (parameters.get("cursor") ?? "") : undefined;
      try {
        const page = await listExternalMatchesForDemand({ pool: context.poolOf(), ownerId: authenticated.userId, demandId, limit, cursor, now: context.clock() });
        return noStoreJsonResponse(200, {
          contractVersion: EXTERNAL_LISTINGS_CONTRACT_VERSION,
          hasMore: page.hasMore,
          nextCursor: page.nextCursor,
          items: page.items.map((item) => ({
            id: item.id,
            title: item.title,
            price: item.price,
            location: item.location,
            listedAt: iso(item.listedAt),
            source: { code: item.source.code, name: item.source.name },
            alsoOn: item.alsoOn.map((source) => ({ code: source.code, name: source.name })),
            url: item.url,
            score: Math.round(item.score),
            seenAt: item.seenAt.toISOString(),
            confirmedAt: iso(item.confirmedAt),
          })),
        });
      } catch (error) {
        const mapped = context.mapError(error);
        if (mapped) return mapped;
        return context.unavailable(logCodeOf(error), "external");
      }
    },

    async adminCollection(request) {
      const authenticated = await context.authenticate(request);
      if (!authenticated.ok) return authenticated.response.status === 401 ? resourceNotFound() : authenticated.response;
      try {
        const admin = await context.poolOf().query("SELECT 1 FROM users WHERE id = $1::uuid AND is_admin = TRUE AND status = 'active'", [authenticated.userId]);
        if (!admin.rowCount) return resourceNotFound();
        if (hasUnexpectedQuery(request)) return invalidRequest();
        const collection = await readAdminCollection({ pool: context.poolOf(), now: context.clock() });
        return noStoreJsonResponse(200, {
          contractVersion: ADMIN_COLLECTION_CONTRACT_VERSION,
          schemaReady: collection.schemaReady,
          sources: collection.sources.map((source) => ({
            code: source.code,
            name: source.name,
            type: source.type,
            enabled: source.enabled,
            state: source.state,
            consecutiveFailures: source.consecutiveFailures,
            breakerOpenUntil: iso(source.breakerOpenUntil),
            usedToday: source.usedToday,
            dailyQuota: source.dailyQuota,
            minIntervalMs: source.minIntervalMs,
            lastSuccessAt: iso(source.lastSuccessAt),
            lastFailureAt: iso(source.lastFailureAt),
            lastErrorCode: source.lastErrorCode,
          })),
          watches: collection.watches,
          listings: collection.listings,
          errors: collection.errors.map((entry) => ({ at: entry.at.toISOString(), sourceCode: entry.sourceCode, sourceName: entry.sourceName, code: entry.code })),
          readAt: collection.readAt.toISOString(),
        });
      } catch (error) {
        const mapped = context.mapError(error);
        if (mapped) return mapped;
        return context.unavailable(logCodeOf(error), "external");
      }
    },
  };
}

export const defaultExternalHttpHandlers = createExternalHttpHandlers();
