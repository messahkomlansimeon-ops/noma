import "server-only";

import { CatalogNotFoundError, CatalogValidationError } from "../catalog/errors";
import { noStoreJsonResponse } from "../http/protection";
import { UUID, createSocialContext, failure, hasUnexpectedQuery, invalidRequest, logCodeOf, resourceNotFound, type SocialHttpDependencies } from "../social/http-common";
import { WalletError } from "../wallet/errors";
import { readStrictJsonBody } from "../wallet/http";
import { WALLET_MAX_SAFE_AMOUNT } from "../wallet/config";
import { importCatalogCsv, type CatalogImportResult } from "./catalog-import";
import {
  CATALOG_IMPORT_CONTRACT_VERSION, IMPORT_HTTP_BODY_MAX_BYTES, SUBSCRIPTION_CONTRACT_VERSION, SUBSCRIPTION_HTTP_BODY_MAX_BYTES,
} from "./config";
import { SubscriptionError } from "./errors";
import { setSubscriptionAutoRenew, subscribeToPlan } from "./lifecycle";
import { markSubscriptionNoticesRead } from "./notices";
import { readSubscriptionState, type SubscriptionState } from "./state";

/**
 * Routes HTTP de l'offre Pro (lot PRO1), toutes en `no-store`, origine vérifiée AVANT la session sur ce qui écrit, session obligatoire (l'utilisateur vient TOUJOURS de la session),
 * corps JSON STRICT (`application/json`, clés exactes), DTO en liste blanche, textes fixes, journal serveur limité à un code :
 *  - GET  /api/subscription                      : plans courants, droits en vigueur, abonnement, crédits promotionnels, annonces en ligne, avis ;
 *  - POST /api/subscription                      : `{ planCode, idempotencyKey }` souscrit avec les crédits payés (201 ; 200 pour un rejeu de la clé) ;
 *  - POST /api/subscription/auto-renew           : `{ autoRenew }` active ou désactive (annule) le renouvellement automatique ;
 *  - POST /api/subscription/notices/read         : `{ all: true }` ou `{ ids }` marque des avis comme lus ;
 *  - POST /api/offers/import                     : `{ csv, dryRun }` aperçu à blanc ou application de l'import de catalogue (droit `catalog_import`).
 * Voir OFFRE-PRO.md.
 */

export interface SubscriptionHttpHandlers {
  state(request: Request): Promise<Response>;
  subscribe(request: Request): Promise<Response>;
  autoRenew(request: Request): Promise<Response>;
  noticesRead(request: Request): Promise<Response>;
  importCatalog(request: Request): Promise<Response>;
}

function jsonInteger(value: bigint): number {
  if (value > WALLET_MAX_SAFE_AMOUNT || value < -WALLET_MAX_SAFE_AMOUNT) throw new RangeError("montant hors des entiers sûrs");
  return Number(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** DTO de l'état : liste blanche champ par champ. Jamais d'identifiant d'utilisateur, de compte, de période, de transaction ni de version de plan. */
export function subscriptionStateDto(state: SubscriptionState) {
  return {
    contractVersion: SUBSCRIPTION_CONTRACT_VERSION,
    // Les prix et crédits des plans de départ sont PROVISOIRES (décision du fondateur en attente) : l'écran le dit.
    pricesProvisional: true,
    plans: state.plans.map((plan) => ({
      code: plan.planCode,
      name: plan.name,
      version: plan.version,
      monthlyPriceXof: jsonInteger(plan.monthlyPriceXof),
      promoCreditsXof: jsonInteger(plan.promoCreditsXof),
      maxOnlineOffers: plan.maxOnlineOffers,
      entitlements: [...plan.entitlements],
    })),
    current: {
      source: state.entitlements.source,
      planCode: state.entitlements.planCode,
      planName: state.entitlements.planName,
      maxOnlineOffers: state.entitlements.maxOnlineOffers,
      entitlements: [...state.entitlements.entitlements],
    },
    onlineOffers: state.onlineOffers,
    subscription: state.subscription === null
      ? null
      : {
          planCode: state.subscription.planCode,
          status: state.subscription.status,
          periodStart: state.subscription.periodStart.toISOString(),
          periodEnd: state.subscription.periodEnd.toISOString(),
          autoRenew: state.subscription.autoRenew,
          canceledAt: state.subscription.canceledAt === null ? null : state.subscription.canceledAt.toISOString(),
          graceEndsAt: state.subscription.graceEndsAt === null ? null : state.subscription.graceEndsAt.toISOString(),
          currentPriceXof: jsonInteger(state.subscription.currentPriceXof),
          renewalPriceXof: jsonInteger(state.subscription.renewalPriceXof),
          entitled: state.subscription.entitled,
        },
    promo: { balanceXof: jsonInteger(state.promo.balance), expiresAt: state.promo.expiresAt === null ? null : state.promo.expiresAt.toISOString() },
    notices: state.notices.map((notice) => ({
      id: notice.id,
      code: notice.code,
      listingCount: notice.listingCount,
      createdAt: notice.createdAt.toISOString(),
      readAt: notice.readAt === null ? null : notice.readAt.toISOString(),
    })),
    unreadNotices: state.unreadNotices,
    readAt: state.readAt.toISOString(),
  };
}

function importDto(result: CatalogImportResult) {
  return {
    contractVersion: CATALOG_IMPORT_CONTRACT_VERSION,
    mode: result.mode,
    alreadyApplied: result.alreadyApplied,
    rowCount: result.rowCount,
    acceptedCount: result.acceptedCount,
    rejectedCount: result.rejectedCount,
    rows: result.rows.map((row) => ({
      line: row.line,
      outcome: row.outcome,
      code: row.code ?? null,
      field: row.field ?? null,
      offerId: row.offerId ?? null,
    })),
  };
}

export function createSubscriptionHttpHandlers(dependencies: SocialHttpDependencies = {}): SubscriptionHttpHandlers {
  const context = createSocialContext(dependencies, "subscription-http");

  /** Traduit un refus de domaine en réponse ; null si ce n'est pas un refus de domaine. */
  function mapDomainError(error: unknown): Response | null {
    if (error instanceof SubscriptionError) {
      switch (error.code) {
        case "plan_not_found": return resourceNotFound();
        case "entitlement_required": return failure(403, "entitlement_required", error.message);
        case "import_too_many_rows": return failure(400, "too_many_rows", error.message);
        case "import_invalid_file": return failure(400, "invalid_file", error.message);
        case "plans_unavailable": return failure(503, "subscription_unavailable", "Le service est temporairement indisponible.");
        default: return failure(409, error.code, error.message);
      }
    }
    if (error instanceof WalletError && error.code === "insufficient_balance") return failure(409, "insufficient_balance", "Solde insuffisant : rechargez votre porte-monnaie.");
    if (error instanceof CatalogValidationError) return invalidRequest();
    return null;
  }

  async function authenticatedWrite(request: Request, run: (userId: string) => Promise<Response>): Promise<Response> {
    const refusal = context.originGuard(request);
    if (refusal) return refusal;
    const authenticated = await context.authenticate(request);
    if (!authenticated.ok) return authenticated.response;
    try {
      return await run(authenticated.userId);
    } catch (error) {
      const mapped = mapDomainError(error);
      if (mapped) return mapped;
      return context.unavailable(logCodeOf(error), "subscription");
    }
  }

  return {
    async state(request) {
      const authenticated = await context.authenticate(request);
      if (!authenticated.ok) return authenticated.response;
      try {
        if (hasUnexpectedQuery(request)) return invalidRequest();
        return noStoreJsonResponse(200, subscriptionStateDto(await readSubscriptionState({ pool: context.poolOf(), userId: authenticated.userId })));
      } catch (error) {
        return mapDomainError(error) ?? context.unavailable(logCodeOf(error), "subscription");
      }
    },

    subscribe: (request) =>
      authenticatedWrite(request, async (userId) => {
        const body = await readStrictJsonBody(request, SUBSCRIPTION_HTTP_BODY_MAX_BYTES);
        if (!body.ok || !isPlainObject(body.value)) return invalidRequest();
        const keys = Object.keys(body.value);
        const { planCode, idempotencyKey } = body.value;
        if (keys.length !== 2 || typeof planCode !== "string" || typeof idempotencyKey !== "string" || !UUID.test(idempotencyKey) || hasUnexpectedQuery(request)) return invalidRequest();
        const pool = context.poolOf();
        const result = await subscribeToPlan({ pool, userId, planCode, idempotencyKey });
        const dto = subscriptionStateDto(await readSubscriptionState({ pool, userId }));
        return noStoreJsonResponse(result.reused ? 200 : 201, { ...dto, reused: result.reused });
      }),

    autoRenew: (request) =>
      authenticatedWrite(request, async (userId) => {
        const body = await readStrictJsonBody(request, SUBSCRIPTION_HTTP_BODY_MAX_BYTES);
        if (!body.ok || !isPlainObject(body.value) || Object.keys(body.value).length !== 1 || typeof body.value.autoRenew !== "boolean" || hasUnexpectedQuery(request)) return invalidRequest();
        const pool = context.poolOf();
        await setSubscriptionAutoRenew({ pool, userId, autoRenew: body.value.autoRenew });
        return noStoreJsonResponse(200, subscriptionStateDto(await readSubscriptionState({ pool, userId })));
      }),

    noticesRead: (request) =>
      authenticatedWrite(request, async (userId) => {
        const body = await readStrictJsonBody(request, SUBSCRIPTION_HTTP_BODY_MAX_BYTES);
        if (!body.ok || !isPlainObject(body.value) || hasUnexpectedQuery(request)) return invalidRequest();
        const keys = Object.keys(body.value);
        let target: { all: true } | { ids: string[] };
        if (keys.length === 1 && body.value.all === true) {
          target = { all: true };
        } else if (keys.length === 1 && Array.isArray(body.value.ids) && body.value.ids.length >= 1 && body.value.ids.length <= 50 && body.value.ids.every((id) => typeof id === "string" && UUID.test(id))) {
          target = { ids: body.value.ids as string[] };
        } else {
          return invalidRequest();
        }
        try {
          const result = await markSubscriptionNoticesRead({ pool: context.poolOf(), userId, target });
          return noStoreJsonResponse(200, { contractVersion: SUBSCRIPTION_CONTRACT_VERSION, unreadNotices: result.unreadCount });
        } catch (error) {
          // Un avis inconnu ou d'autrui : la même réponse (404).
          if (error instanceof CatalogNotFoundError) return resourceNotFound();
          throw error;
        }
      }),

    importCatalog: (request) =>
      authenticatedWrite(request, async (userId) => {
        const body = await readStrictJsonBody(request, IMPORT_HTTP_BODY_MAX_BYTES);
        if (!body.ok || !isPlainObject(body.value) || hasUnexpectedQuery(request)) return invalidRequest();
        const keys = Object.keys(body.value);
        const { csv, dryRun } = body.value;
        if (keys.length !== 2 || typeof csv !== "string" || typeof dryRun !== "boolean") return invalidRequest();
        const result = await importCatalogCsv({ pool: context.poolOf(), sellerId: userId, csv, dryRun });
        return noStoreJsonResponse(!dryRun && !result.alreadyApplied ? 201 : 200, importDto(result));
      }),
  };
}

export const defaultSubscriptionHttpHandlers = createSubscriptionHttpHandlers();
