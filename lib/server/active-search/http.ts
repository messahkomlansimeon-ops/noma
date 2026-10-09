import "server-only";

import { CatalogNotFoundError, CatalogValidationError } from "../catalog/errors";
import { noStoreJsonResponse } from "../http/protection";
import { UUID, createSocialContext, failure, hasUnexpectedQuery, invalidRequest, logCodeOf, resourceNotFound, type SocialHttpDependencies } from "../social/http-common";
import { WalletError } from "../wallet/errors";
import { readStrictJsonBody } from "../wallet/http";
import { ACTIVE_SEARCH_CONTRACT_VERSION, ACTIVE_SEARCH_HTTP_BODY_MAX_BYTES } from "./config";
import { ActiveSearchError } from "./errors";
import { purchaseActiveSearch } from "./purchase";
import { readActiveSearchState, type ActiveSearchState } from "./state";

/**
 * Routes HTTP de la RECHERCHE ACTIVE payante (lot RA1), `no-store`, origine vérifiée AVANT la session sur ce qui écrit, session obligatoire (le propriétaire vient TOUJOURS de la session,
 * jamais du corps), corps JSON STRICT (`{ "idempotencyKey": uuid, "expectedPriceXof": entier }`, aucune autre clé : le prix AFFICHÉ à l'acheteur est exigé et comparé au prix courant, sinon 409 `price_changed`), DTO en liste blanche, textes fixes, journal serveur limité à un code :
 *  - GET  /api/demands/{id}/active-search : état de l'option pour ce besoin (en vigueur, fin, jours restants, achat possible, solde en crédits payés) ;
 *  - POST /api/demands/{id}/active-search : achète une période (30 jours) en crédits PAYÉS (201 ; 200 pour un rejeu de la clé : aucun nouveau débit).
 * Un besoin inconnu ou d'autrui : la MÊME réponse 404. Jamais d'identifiant d'achat, de transaction ni de compte dans les réponses. Voir RECHERCHE-ACTIVE.md.
 */

export interface ActiveSearchHttpHandlers {
  get(request: Request, demandId: string): Promise<Response>;
  purchase(request: Request, demandId: string): Promise<Response>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** DTO de l'état : liste blanche champ par champ. */
export function activeSearchStateDto(state: ActiveSearchState) {
  return {
    contractVersion: ACTIVE_SEARCH_CONTRACT_VERSION,
    // Le prix de départ est PROVISOIRE (décision du fondateur en attente) ; l'option se paie en crédits payés, jamais en crédits promotionnels ; elle n'est ni renouvelée ni remboursée seule.
    priceProvisional: true,
    paidCreditsOnly: true,
    autoRenew: false,
    demandId: state.demandId,
    demandStatus: state.demandStatus,
    active: state.active,
    suspended: state.suspended,
    startsAt: state.startsAt === null ? null : state.startsAt.toISOString(),
    endsAt: state.endsAt === null ? null : state.endsAt.toISOString(),
    remainingDays: state.remainingDays,
    purchasedPeriods: state.purchasedPeriods,
    nextEndsAt: state.nextEndsAt === null ? null : state.nextEndsAt.toISOString(),
    maxEndsAt: state.maxEndsAt.toISOString(),
    canPurchase: state.canPurchase,
    blockedReason: state.blockedReason,
    expiringSoon: state.expiringSoon,
    priceXof: state.priceXof,
    durationDays: state.durationDays,
    balanceXof: state.balanceXof,
    readAt: state.readAt.toISOString(),
  };
}

export function createActiveSearchHttpHandlers(dependencies: SocialHttpDependencies = {}): ActiveSearchHttpHandlers {
  const context = createSocialContext(dependencies, "active-search-http");

  /** Traduit un refus de domaine en réponse ; null si ce n'est pas un refus de domaine. */
  function mapDomainError(error: unknown): Response | null {
    if (error instanceof ActiveSearchError) {
      switch (error.code) {
        case "purchase_not_found": return resourceNotFound();
        default: return failure(409, error.code, error.message);
      }
    }
    if (error instanceof WalletError && error.code === "insufficient_balance") return failure(409, "insufficient_balance", "Solde insuffisant : rechargez votre porte-monnaie.");
    if (error instanceof CatalogNotFoundError) return resourceNotFound();
    if (error instanceof CatalogValidationError) return invalidRequest();
    return null;
  }

  return {
    async get(request, demandId) {
      const authenticated = await context.authenticate(request);
      if (!authenticated.ok) return authenticated.response;
      if (!UUID.test(demandId) || hasUnexpectedQuery(request)) return invalidRequest();
      try {
        const state = await readActiveSearchState({ executor: context.poolOf(), ownerId: authenticated.userId, demandId, now: context.clock(), env: context.environment() });
        return noStoreJsonResponse(200, activeSearchStateDto(state));
      } catch (error) {
        return mapDomainError(error) ?? context.unavailable(logCodeOf(error), "active_search");
      }
    },

    async purchase(request, demandId) {
      const refusal = context.originGuard(request);
      if (refusal) return refusal;
      const authenticated = await context.authenticate(request);
      if (!authenticated.ok) return authenticated.response;
      if (!UUID.test(demandId) || hasUnexpectedQuery(request)) return invalidRequest();
      const body = await readStrictJsonBody(request, ACTIVE_SEARCH_HTTP_BODY_MAX_BYTES);
      if (!body.ok || !isPlainObject(body.value)) return invalidRequest();
      const keys = Object.keys(body.value);
      const { idempotencyKey, expectedPriceXof } = body.value;
      if (keys.length !== 2 || typeof idempotencyKey !== "string" || !UUID.test(idempotencyKey)) return invalidRequest();
      if (typeof expectedPriceXof !== "number" || !Number.isSafeInteger(expectedPriceXof) || expectedPriceXof <= 0) return invalidRequest();
      try {
        const pool = context.poolOf();
        const result = await purchaseActiveSearch({
          pool, userId: authenticated.userId, demandId, idempotencyKey, expectedPriceXof, env: context.environment(), ...(dependencies.now ? { now: dependencies.now() } : {}),
        });
        const state = await readActiveSearchState({ executor: pool, ownerId: authenticated.userId, demandId, now: context.clock(), env: context.environment() });
        return noStoreJsonResponse(result.reused ? 200 : 201, {
          ...activeSearchStateDto(state),
          purchase: { kind: result.kind, reused: result.reused, startsAt: result.startsAt.toISOString(), endsAt: result.endsAt.toISOString(), priceXof: Number(result.priceXof) },
        });
      } catch (error) {
        return mapDomainError(error) ?? context.unavailable(logCodeOf(error), "active_search");
      }
    },
  };
}

export const defaultActiveSearchHttpHandlers = createActiveSearchHttpHandlers();
