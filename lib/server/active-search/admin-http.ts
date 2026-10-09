import "server-only";

import { noStoreJsonResponse } from "../http/protection";
import { createSocialContext, hasUnexpectedQuery, invalidRequest, logCodeOf, resourceNotFound, type SocialHttpDependencies } from "../social/http-common";
import { WALLET_MAX_SAFE_AMOUNT } from "../wallet/config";
import { readAdminActiveSearchOverview } from "./admin";
import { ACTIVE_SEARCH_CONTRACT_VERSION } from "./config";

/**
 * Route HTTP d'administration de la RECHERCHE ACTIVE (lot RA1) : GET /api/admin/active-search (options en vigueur arrondies à 5 près, revenus du mois lus dans le grand livre). `no-store`,
 * le MÊME 404 « Ressource introuvable » pour tout ce qui n'est pas un administrateur actif (visiteur sans session, compte ordinaire, compte suspendu), comme les routes du lot D2.
 * Aucun remboursement ici : il se fait par la commande `active-search:refund`. Voir RECHERCHE-ACTIVE.md.
 */

export interface AdminActiveSearchHttpHandlers {
  overview(request: Request): Promise<Response>;
}

function jsonInteger(value: bigint): number {
  if (value > WALLET_MAX_SAFE_AMOUNT || value < -WALLET_MAX_SAFE_AMOUNT) throw new RangeError("montant hors des entiers sûrs");
  return Number(value);
}

export function createAdminActiveSearchHttpHandlers(dependencies: SocialHttpDependencies = {}): AdminActiveSearchHttpHandlers {
  const context = createSocialContext(dependencies, "admin-active-search-http");
  return {
    async overview(request) {
      const authenticated = await context.authenticate(request);
      if (!authenticated.ok) return authenticated.response.status === 401 ? resourceNotFound() : authenticated.response;
      try {
        const admin = await context.poolOf().query("SELECT 1 FROM users WHERE id = $1::uuid AND is_admin = TRUE AND status = 'active'", [authenticated.userId]);
        if (!admin.rowCount) return resourceNotFound();
        if (hasUnexpectedQuery(request)) return invalidRequest();
        const overview = await readAdminActiveSearchOverview({ pool: context.poolOf() });
        return noStoreJsonResponse(200, {
          contractVersion: ACTIVE_SEARCH_CONTRACT_VERSION,
          priceProvisional: true,
          activeApproximate: overview.activeApproximate,
          month: { startsAt: overview.month.startsAt.toISOString(), endsAt: overview.month.endsAt.toISOString() },
          revenueXof: jsonInteger(overview.revenueXof),
          readAt: overview.readAt.toISOString(),
        });
      } catch (error) {
        return context.unavailable(logCodeOf(error), "admin");
      }
    },
  };
}

export const defaultAdminActiveSearchHttpHandlers = createAdminActiveSearchHttpHandlers();
