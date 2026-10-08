import "server-only";

import { CatalogValidationError } from "../catalog/errors";
import { noStoreJsonResponse } from "../http/protection";
import { createSocialContext, failure, hasUnexpectedQuery, invalidRequest, logCodeOf, resourceNotFound, type SocialHttpDependencies } from "../social/http-common";
import { WALLET_MAX_SAFE_AMOUNT } from "../wallet/config";
import { readStrictJsonBody } from "../wallet/http";
import { readAdminPlansOverview } from "../subscriptions/admin";
import { ADMIN_PLANS_CONTRACT_VERSION, SUBSCRIPTION_HTTP_BODY_MAX_BYTES } from "../subscriptions/config";
import { SubscriptionError } from "../subscriptions/errors";
import { createPlanVersion, type PlanVersionView } from "../subscriptions/plans";

/**
 * Routes HTTP de l'administration de l'offre Pro (lot PRO1). TOUTES : `no-store`, origine vérifiée sur les écritures (AVANT la session), et le MÊME 404 « Ressource introuvable »
 * pour tout ce qui n'est pas un administrateur actif (visiteur sans session, compte ordinaire, compte suspendu), comme les routes du lot D2 :
 *  - GET  /api/admin/plans                       : versions de chaque plan (lecture seule), abonnés arrondis à 5 près, revenus d'abonnement du mois ;
 *  - POST /api/admin/plans/{code}/versions       : `{ name, monthlyPriceXof, promoCreditsXof, maxOnlineOffers, entitlements }` crée une NOUVELLE version (jamais la modification d'une
 *    version existante : aucune route ne la permet, et la base la refuse). Elle ne s'applique qu'aux NOUVELLES souscriptions : les abonnés actuels gardent leur prix.
 * PRIX PROVISOIRES : l'écran le dit. Voir OFFRE-PRO.md.
 */

export interface AdminPlansHttpHandlers {
  overview(request: Request): Promise<Response>;
  createVersion(request: Request, planCode: string): Promise<Response>;
}

function jsonInteger(value: bigint): number {
  if (value > WALLET_MAX_SAFE_AMOUNT || value < -WALLET_MAX_SAFE_AMOUNT) throw new RangeError("montant hors des entiers sûrs");
  return Number(value);
}

function versionDto(version: PlanVersionView) {
  return {
    version: version.version,
    name: version.name,
    monthlyPriceXof: jsonInteger(version.monthlyPriceXof),
    promoCreditsXof: jsonInteger(version.promoCreditsXof),
    maxOnlineOffers: version.maxOnlineOffers,
    entitlements: [...version.entitlements],
    createdAt: version.createdAt.toISOString(),
  };
}

const PLAN_CODE = /^[a-z][a-z0-9_]{1,29}$/;

export function createAdminPlansHttpHandlers(dependencies: SocialHttpDependencies = {}): AdminPlansHttpHandlers {
  const context = createSocialContext(dependencies, "admin-plans-http");

  /** Origine (écriture) → session → rôle admin actif ; sinon le MÊME 404. */
  async function guarded(request: Request, options: { write: boolean }, run: (adminId: string) => Promise<Response>): Promise<Response> {
    if (options.write) {
      const refusal = context.originGuard(request);
      if (refusal) return refusal;
    }
    const authenticated = await context.authenticate(request);
    if (!authenticated.ok) return authenticated.response.status === 401 ? resourceNotFound() : authenticated.response;
    try {
      const admin = await context.poolOf().query("SELECT 1 FROM users WHERE id = $1::uuid AND is_admin = TRUE AND status = 'active'", [authenticated.userId]);
      if (!admin.rowCount) return resourceNotFound();
      return await run(authenticated.userId);
    } catch (error) {
      if (error instanceof SubscriptionError) return error.code === "plan_not_found" ? resourceNotFound() : failure(409, error.code, error.message);
      if (error instanceof CatalogValidationError) return invalidRequest();
      return context.unavailable(logCodeOf(error), "admin");
    }
  }

  return {
    overview: (request) =>
      guarded(request, { write: false }, async () => {
        if (hasUnexpectedQuery(request)) return invalidRequest();
        const overview = await readAdminPlansOverview({ pool: context.poolOf() });
        return noStoreJsonResponse(200, {
          contractVersion: ADMIN_PLANS_CONTRACT_VERSION,
          pricesProvisional: true,
          plans: overview.plans.map((plan) => ({ code: plan.code, versions: plan.versions.map(versionDto) })),
          subscribers: overview.subscribers,
          totalSubscribersApproximate: overview.totalSubscribersApproximate,
          month: { startsAt: overview.month.startsAt.toISOString(), endsAt: overview.month.endsAt.toISOString() },
          subscriptionRevenueXof: jsonInteger(overview.subscriptionRevenueXof),
          promo: { issuedXof: jsonInteger(overview.promoIssuedXof), spentXof: jsonInteger(overview.promoSpentXof), expiredXof: jsonInteger(overview.promoExpiredXof) },
          readAt: overview.readAt.toISOString(),
        });
      }),

    createVersion: (request, planCode) =>
      guarded(request, { write: true }, async (adminId) => {
        if (!PLAN_CODE.test(planCode) || hasUnexpectedQuery(request)) return resourceNotFound();
        const body = await readStrictJsonBody(request, SUBSCRIPTION_HTTP_BODY_MAX_BYTES);
        if (!body.ok || typeof body.value !== "object" || body.value === null || Array.isArray(body.value)) return invalidRequest();
        const value = body.value as Record<string, unknown>;
        const keys = Object.keys(value).sort().join(",");
        if (keys !== "entitlements,maxOnlineOffers,monthlyPriceXof,name,promoCreditsXof") return invalidRequest();
        const created = await createPlanVersion({
          pool: context.poolOf(),
          planCode,
          name: value.name as string,
          monthlyPriceXof: value.monthlyPriceXof as number,
          promoCreditsXof: value.promoCreditsXof as number,
          maxOnlineOffers: value.maxOnlineOffers as number,
          entitlements: value.entitlements as string[],
          createdBy: adminId,
        });
        return noStoreJsonResponse(201, { contractVersion: ADMIN_PLANS_CONTRACT_VERSION, planCode, version: versionDto(created) });
      }),
  };
}

export const defaultAdminPlansHttpHandlers = createAdminPlansHttpHandlers();
