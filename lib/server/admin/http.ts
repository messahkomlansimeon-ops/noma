import "server-only";

import { noStoreJsonResponse } from "../http/protection";
import { UUID, createSocialContext, failure, hasUnexpectedQuery, invalidRequest, logCodeOf, resourceNotFound, type SocialHttpDependencies } from "../social/http-common";
import { marketAdminDto } from "../market/http";
import { readAdminMarket } from "../market/reads";
import { setUserStatusByAdmin, type VendorAction } from "./actions";
import { AdminError } from "./errors";
import { ADMIN_REPORTS_PAGE_DEFAULT, ADMIN_REPORTS_PAGE_MAX, decideReport, listAdminReports, readAdminReport } from "../reports/reports";
import { mapReportError } from "../reports/http";
import { PHONE_IN_REPORT_MESSAGE, REPORTS_CONTRACT_VERSION, checkDecisionInput, type ReportStatus } from "../../reports-rules";
import {
  ADMIN_CONTRACT_VERSION,
  ADMIN_VENDORS_PAGE_DEFAULT,
  ADMIN_VENDORS_PAGE_MAX,
  listAdminActions,
  listAdminVendors,
  readAdminBoostSettings,
  readAdminSummary,
} from "./reads";

/**
 * Routes HTTP de l'administration (lot D2). TOUTES : `no-store`, origine vérifiée sur les écritures (AVANT la session), et le MÊME 404 « Ressource introuvable » pour tout
 * ce qui n'est pas un administrateur (visiteur sans session, compte ordinaire, compte suspendu) : l'existence de ces routes ne se devine pas.
 *  - GET  /api/admin/summary                    : chiffres du tableau de bord ;
 *  - GET  /api/admin/vendors?limit&offset       : vendeurs (numéros masqués sauf les deux derniers chiffres) ;
 *  - POST /api/admin/vendors/{id}/suspend|reactivate : confirmation côté écran, journalisé ;
 *  - GET  /api/admin/actions                    : journal d'administration ;
 *  - GET  /api/admin/settings                   : réglages du boost par catégorie (lecture seule) ;
 *  - GET  /api/admin/market                     : les 20 clés produit les plus relevées (lot H1), mêmes seuils et arrondis que /api/market ;
 *  - GET  /api/admin/reports?status&limit&offset : dossiers de modération (lot FIN3-C2), numéros masqués ; GET /api/admin/reports/{id} : un dossier ;
 *  - POST /api/admin/reports/{id}/decision      : { decision: "dismissed"|"seller_suspended", note } : clôt le dossier, journalisé (la suspension passe par le chemin existant).
 */

export interface AdminHttpHandlers {
  summary(request: Request): Promise<Response>;
  vendors(request: Request): Promise<Response>;
  vendorAction(request: Request, userId: string, action: string): Promise<Response>;
  actions(request: Request): Promise<Response>;
  settings(request: Request): Promise<Response>;
  market(request: Request): Promise<Response>;
  reports(request: Request): Promise<Response>;
  report(request: Request, reportId: string): Promise<Response>;
  reportDecision(request: Request, reportId: string): Promise<Response>;
}

export function createAdminHttpHandlers(dependencies: SocialHttpDependencies = {}): AdminHttpHandlers {
  const context = createSocialContext(dependencies, "admin-http");

  /** Origine (écriture) → session → rôle admin ; sinon le MÊME 404. */
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
      const reportFailure = mapReportError(error);
      if (reportFailure) return reportFailure;
      if (error instanceof AdminError) {
        if (error.code === "target_not_found") return resourceNotFound();
        return failure(409, error.code, error.message);
      }
      const mapped = context.mapError(error);
      if (mapped) return mapped;
      return context.unavailable(logCodeOf(error), "admin");
    }
  }

  return {
    summary: (request) =>
      guarded(request, { write: false }, async () => {
        if (hasUnexpectedQuery(request)) return invalidRequest();
        return noStoreJsonResponse(200, { contractVersion: ADMIN_CONTRACT_VERSION, summary: await readAdminSummary({ pool: context.poolOf() }) });
      }),

    vendors: (request) =>
      guarded(request, { write: false }, async () => {
        if (hasUnexpectedQuery(request, ["limit", "offset"])) return invalidRequest();
        const parameters = new URL(request.url).searchParams;
        let limit = ADMIN_VENDORS_PAGE_DEFAULT;
        let offset = 0;
        if (parameters.has("limit")) {
          const text = parameters.get("limit") ?? "";
          if (!/^[0-9]{1,3}$/.test(text) || Number(text) < 1 || Number(text) > ADMIN_VENDORS_PAGE_MAX) return invalidRequest();
          limit = Number(text);
        }
        if (parameters.has("offset")) {
          const text = parameters.get("offset") ?? "";
          if (!/^[0-9]{1,7}$/.test(text)) return invalidRequest();
          offset = Number(text);
        }
        const page = await listAdminVendors({ pool: context.poolOf(), limit, offset });
        return noStoreJsonResponse(200, {
          contractVersion: ADMIN_CONTRACT_VERSION,
          total: page.total,
          limit,
          offset,
          vendors: page.vendors.map((vendor) => ({
            id: vendor.id,
            maskedPhone: vendor.maskedPhone,
            offerCount: vendor.offerCount,
            publishedCount: vendor.publishedCount,
            createdAt: vendor.createdAt.toISOString(),
            status: vendor.status,
            isAdmin: vendor.isAdmin,
          })),
        });
      }),

    vendorAction: (request, userId, action) =>
      guarded(request, { write: true }, async (adminId) => {
        if (!UUID.test(userId) || hasUnexpectedQuery(request) || (action !== "suspend" && action !== "reactivate")) return resourceNotFound();
        const body = await context.readJsonObject(request, 64);
        if (body === null || Object.keys(body).length > 0) return invalidRequest();
        const result = await setUserStatusByAdmin({ pool: context.poolOf(), adminId, targetUserId: userId, action: action as VendorAction });
        return noStoreJsonResponse(200, { contractVersion: ADMIN_CONTRACT_VERSION, status: result.status, changed: result.changed });
      }),

    actions: (request) =>
      guarded(request, { write: false }, async () => {
        if (hasUnexpectedQuery(request)) return invalidRequest();
        const entries = await listAdminActions({ pool: context.poolOf() });
        return noStoreJsonResponse(200, {
          contractVersion: ADMIN_CONTRACT_VERSION,
          actions: entries.map((entry) => ({
            id: entry.id,
            action: entry.action,
            source: entry.source,
            byMaskedPhone: entry.byMaskedPhone,
            targetMaskedPhone: entry.targetMaskedPhone,
            createdAt: entry.createdAt.toISOString(),
          })),
        });
      }),

    settings: (request) =>
      guarded(request, { write: false }, async () => {
        if (hasUnexpectedQuery(request)) return invalidRequest();
        return noStoreJsonResponse(200, { contractVersion: ADMIN_CONTRACT_VERSION, settings: await readAdminBoostSettings({ pool: context.poolOf() }) });
      }),

    market: (request) =>
      guarded(request, { write: false }, async () => {
        if (hasUnexpectedQuery(request)) return invalidRequest();
        return noStoreJsonResponse(200, marketAdminDto(await readAdminMarket(context.poolOf())));
      }),

    reports: (request) =>
      guarded(request, { write: false }, async () => {
        if (hasUnexpectedQuery(request, ["status", "limit", "offset"])) return invalidRequest();
        const parameters = new URL(request.url).searchParams;
        const statusText = parameters.get("status") ?? "open";
        if (statusText !== "open" && statusText !== "closed") return invalidRequest();
        let limit = ADMIN_REPORTS_PAGE_DEFAULT;
        let offset = 0;
        if (parameters.has("limit")) {
          const text = parameters.get("limit") ?? "";
          if (!/^[0-9]{1,3}$/.test(text) || Number(text) < 1 || Number(text) > ADMIN_REPORTS_PAGE_MAX) return invalidRequest();
          limit = Number(text);
        }
        if (parameters.has("offset")) {
          const text = parameters.get("offset") ?? "";
          if (!/^[0-9]{1,7}$/.test(text)) return invalidRequest();
          offset = Number(text);
        }
        const page = await listAdminReports({ pool: context.poolOf(), status: statusText as ReportStatus, limit, offset });
        return noStoreJsonResponse(200, {
          contractVersion: REPORTS_CONTRACT_VERSION,
          total: page.total,
          limit,
          offset,
          reports: page.reports.map((report) => ({
            id: report.id,
            status: report.status,
            targetType: report.targetType,
            reason: report.reason,
            targetTitle: report.targetTitle,
            reporterMaskedPhone: report.reporterMaskedPhone,
            reportedMaskedPhone: report.reportedMaskedPhone,
            reportedOpenCount: report.reportedOpenCount,
            decision: report.decision,
            createdAt: report.createdAt.toISOString(),
          })),
        });
      }),

    report: (request, reportId) =>
      guarded(request, { write: false }, async () => {
        if (!UUID.test(reportId) || hasUnexpectedQuery(request)) return resourceNotFound();
        const report = await readAdminReport({ pool: context.poolOf(), reportId });
        if (!report) return resourceNotFound();
        return noStoreJsonResponse(200, {
          contractVersion: REPORTS_CONTRACT_VERSION,
          report: {
            id: report.id,
            status: report.status,
            targetType: report.targetType,
            reason: report.reason,
            targetTitle: report.targetTitle,
            reporterMaskedPhone: report.reporterMaskedPhone,
            reportedMaskedPhone: report.reportedMaskedPhone,
            reportedOpenCount: report.reportedOpenCount,
            reportedTotalCount: report.reportedTotalCount,
            reportedStatus: report.reportedStatus,
            detail: report.detail,
            decision: report.decision,
            decisionNote: report.decisionNote,
            decidedAt: report.decidedAt === null ? null : report.decidedAt.toISOString(),
            decidedByMaskedPhone: report.decidedByMaskedPhone,
            createdAt: report.createdAt.toISOString(),
            offer: report.offer,
            order: report.order,
          },
        });
      }),

    reportDecision: (request, reportId) =>
      guarded(request, { write: true }, async (adminId) => {
        if (!UUID.test(reportId) || hasUnexpectedQuery(request)) return resourceNotFound();
        const body = await context.readJsonObject(request, 2_048);
        if (body === null) return invalidRequest();
        const checked = checkDecisionInput(body);
        if (!checked.ok) return checked.reason === "phone" ? failure(400, "phone_number_in_report", PHONE_IN_REPORT_MESSAGE) : invalidRequest();
        const result = await decideReport({ pool: context.poolOf(), adminId, reportId, decision: checked.value.decision, note: checked.value.note });
        return noStoreJsonResponse(200, { contractVersion: REPORTS_CONTRACT_VERSION, status: result.status, decision: result.decision, suspended: result.suspended });
      }),
  };
}

export const defaultAdminHttpHandlers = createAdminHttpHandlers();
