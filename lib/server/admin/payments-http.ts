import "server-only";

import { CatalogNotFoundError, CatalogValidationError } from "../catalog/errors";
import { noStoreJsonResponse } from "../http/protection";
import { createSocialContext, hasUnexpectedQuery, invalidRequest, logCodeOf, resourceNotFound, UUID, type SocialHttpDependencies } from "../social/http-common";
import { WALLET_MAX_SAFE_AMOUNT } from "../wallet/config";
import { readStrictJsonBody } from "../wallet/http";
import { readPaymentsOverview, resolveAnomaly } from "../wallet/sublymus/overview";
import { resolvePaymentSelection } from "../wallet/sublymus/config";

/**
 * Routes HTTP de l'administration des PAIEMENTS (lot PAY1) : TOUTES `no-store`, origine vérifiée sur les écritures (AVANT la session), et le MÊME 404 « Ressource introuvable »
 * pour tout ce qui n'est pas un administrateur actif (comme les routes du lot D2 et /api/admin/plans) :
 *  - GET  /api/admin/payments                              : intentions récentes, anomalies de rapprochement, état du rattrapage et des webhooks. AUCUNE donnée personnelle ;
 *  - POST /api/admin/payments/anomalies/{id}/resolve       : marque une anomalie comme TRAITÉE (corps `{}`), journalisé par l'administrateur et la date ; idempotent.
 * Voir PAIEMENT-WAVE.md.
 */

export const ADMIN_PAYMENTS_CONTRACT_VERSION = "admin-payments/v1" as const;

export interface AdminPaymentsHttpHandlers {
  overview(request: Request): Promise<Response>;
  resolveAnomaly(request: Request, anomalyId: string): Promise<Response>;
}

function jsonInteger(value: bigint): number {
  if (value > WALLET_MAX_SAFE_AMOUNT || value < -WALLET_MAX_SAFE_AMOUNT) throw new RangeError("montant hors des entiers sûrs");
  return Number(value);
}

const iso = (value: Date | null): string | null => (value === null ? null : value.toISOString());

export function createAdminPaymentsHttpHandlers(dependencies: SocialHttpDependencies = {}): AdminPaymentsHttpHandlers {
  const context = createSocialContext(dependencies, "admin-payments-http");

  /** Origine (écriture) → session → rôle administrateur actif ; sinon le MÊME 404. */
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
      if (error instanceof CatalogNotFoundError) return resourceNotFound();
      if (error instanceof CatalogValidationError) return invalidRequest();
      return context.unavailable(logCodeOf(error), "admin");
    }
  }

  function providerState(): "fake" | "sublymus" | "misconfigured" {
    try {
      return resolvePaymentSelection(context.environment()).provider;
    } catch {
      return "misconfigured";
    }
  }

  return {
    overview: (request) =>
      guarded(request, { write: false }, async () => {
        if (hasUnexpectedQuery(request)) return invalidRequest();
        const overview = await readPaymentsOverview({ pool: context.poolOf() });
        return noStoreJsonResponse(200, {
          contractVersion: ADMIN_PAYMENTS_CONTRACT_VERSION,
          provider: providerState(),
          openAnomalies: overview.openAnomalies,
          anomalies: overview.anomalies.map((entry) => ({
            id: entry.id,
            kind: entry.kind,
            origin: entry.origin,
            createdAt: entry.createdAt.toISOString(),
            intentId: entry.intentId,
            expectedAmountXof: entry.expectedAmountXof === null ? null : jsonInteger(entry.expectedAmountXof),
            receivedAmountXof: entry.receivedAmountXof === null ? null : jsonInteger(entry.receivedAmountXof),
            receivedCurrency: entry.receivedCurrency,
            receivedStatus: entry.receivedStatus,
            resolvedAt: iso(entry.resolvedAt),
          })),
          intents: overview.intents.map((entry) => ({
            id: entry.id,
            provider: entry.provider,
            amountXof: jsonInteger(entry.amountXof),
            status: entry.status,
            createdAt: entry.createdAt.toISOString(),
            completedAt: iso(entry.completedAt),
            checkoutOpened: entry.checkoutOpened,
            providerStatus: entry.providerStatus,
            catchupAttempts: entry.catchupAttempts,
            nextCatchupAt: iso(entry.nextCatchupAt),
            lastCatchupAt: iso(entry.lastCatchupAt),
            lastCatchupOutcome: entry.lastCatchupOutcome,
            catchupDone: entry.catchupDone,
          })),
          catchup: { ...overview.catchup, lastRunAt: iso(overview.catchup.lastRunAt) },
          webhooks: { last24h: overview.webhooks.last24h, lastReceivedAt: iso(overview.webhooks.lastReceivedAt) },
          readAt: overview.readAt.toISOString(),
        });
      }),

    resolveAnomaly: (request, anomalyId) =>
      guarded(request, { write: true }, async (adminId) => {
        if (!UUID.test(anomalyId) || hasUnexpectedQuery(request)) return resourceNotFound();
        const body = await readStrictJsonBody(request, 64);
        if (!body.ok || typeof body.value !== "object" || body.value === null || Array.isArray(body.value) || Object.keys(body.value).length !== 0) return invalidRequest();
        const resolved = await resolveAnomaly({ pool: context.poolOf(), anomalyId, adminId });
        return noStoreJsonResponse(200, { contractVersion: ADMIN_PAYMENTS_CONTRACT_VERSION, anomalyId: anomalyId.toLowerCase(), changed: resolved.changed });
      }),
  };
}

export const defaultAdminPaymentsHttpHandlers = createAdminPaymentsHttpHandlers();
