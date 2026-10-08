import "server-only";

import { noStoreJsonResponse } from "../http/protection";
import { createSocialContext, hasUnexpectedQuery, invalidRequest, logCodeOf, resourceNotFound, type SocialHttpDependencies } from "../social/http-common";
import { ADMIN_SMS_CONTRACT_VERSION, readSmsAdmin, resolveUsageCache, type UsageCache } from "./admin";

/**
 * Route HTTP de l'administration des SMS (lot SMS1) : GET /api/admin/sms. `no-store`, et le MÊME 404 « Ressource introuvable » pour tout ce qui n'est pas un administrateur actif
 * (visiteur sans session, compte ordinaire, compte suspendu) : l'existence de la route ne se devine pas. Lecture seule : aucune écriture, aucun renvoi.
 */

export interface AdminSmsHttpDependencies extends SocialHttpDependencies {
  /** Cache de consommation injecté (tests) ; défaut : celui de l'environnement (60 s). */
  usageCache?: UsageCache;
}

export interface AdminSmsHttpHandlers {
  overview(request: Request): Promise<Response>;
}

export function createAdminSmsHttpHandlers(dependencies: AdminSmsHttpDependencies = {}): AdminSmsHttpHandlers {
  const context = createSocialContext(dependencies, "admin-sms");

  return {
    async overview(request) {
      const authenticated = await context.authenticate(request);
      if (!authenticated.ok) return authenticated.response.status === 401 ? resourceNotFound() : authenticated.response;
      try {
        const admin = await context.poolOf().query("SELECT 1 FROM users WHERE id = $1::uuid AND is_admin = TRUE AND status = 'active'", [authenticated.userId]);
        if (!admin.rowCount) return resourceNotFound();
        if (hasUnexpectedQuery(request)) return invalidRequest();
        const reading = await readSmsAdmin({ pool: context.poolOf(), env: context.environment(), now: context.clock() });
        const usage = await (dependencies.usageCache ?? resolveUsageCache(context.environment())).read();
        return noStoreJsonResponse(200, {
          contractVersion: ADMIN_SMS_CONTRACT_VERSION,
          provider: reading.provider,
          usage: usage.usage,
          usageError: usage.usageError,
          local: reading.local,
          uncertain: reading.uncertain.map((send) => ({
            id: send.id,
            purpose: send.purpose,
            maskedPhone: send.maskedPhone,
            status: send.status,
            createdAt: send.createdAt.toISOString(),
            httpStatus: send.httpStatus,
            errorCode: send.errorCode,
            providerId: send.providerId,
            attempts: send.attempts,
          })),
          recentFailed: reading.recentFailed.map((send) => ({
            id: send.id,
            purpose: send.purpose,
            maskedPhone: send.maskedPhone,
            createdAt: send.createdAt.toISOString(),
            httpStatus: send.httpStatus,
            errorCode: send.errorCode,
            attempts: send.attempts,
          })),
          budget: reading.budget,
          readAt: reading.readAt.toISOString(),
        });
      } catch (error) {
        const mapped = context.mapError(error);
        if (mapped) return mapped;
        return context.unavailable(logCodeOf(error), "admin");
      }
    },
  };
}

export const defaultAdminSmsHttpHandlers = createAdminSmsHttpHandlers();
