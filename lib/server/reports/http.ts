import "server-only";

import { noStoreJsonResponse } from "../http/protection";
import { createSocialContext, failure, hasUnexpectedQuery, invalidRequest, logCodeOf, resourceNotFound, type SocialHttpDependencies } from "../social/http-common";
import { PHONE_IN_REPORT_MESSAGE, REPORTS_CONTRACT_VERSION, checkReportInput } from "../../reports-rules";
import { REPORT_ERROR_MESSAGES, ReportError, createReport, listMyReports } from "./reports";

/**
 * Routes HTTP des signalements (lot FIN3-C2) : `no-store`, origine vérifiée sur l'écriture (AVANT la session), session obligatoire.
 *  - POST /api/reports : { targetType: "offer"|"order", targetId, demandId (annonce seulement), reason, detail? } → 201 { report: { id, status, createdAt } } ;
 *      404 : cible inconnue OU sans accès (indiscernables) ; 409 `already_reported` ; 429 `reports_daily_limit` ; 400 `phone_number_in_report` ou `invalid_request` ;
 *  - GET  /api/reports : les signalements du compte (statut ouvert/clos seulement : jamais la décision ni le motif de l'administrateur).
 */

const BODY_MAX_BYTES = 2_048;

export interface ReportsHttpHandlers {
  create(request: Request): Promise<Response>;
  list(request: Request): Promise<Response>;
}

export function mapReportError(error: unknown): Response | null {
  if (!(error instanceof ReportError)) return null;
  switch (error.code) {
    case "not_found":
      return resourceNotFound();
    case "already_reported":
      return failure(409, "already_reported", REPORT_ERROR_MESSAGES.already_reported);
    case "daily_limit":
      return failure(429, "reports_daily_limit", REPORT_ERROR_MESSAGES.daily_limit);
    case "already_decided":
      return failure(409, "report_closed", REPORT_ERROR_MESSAGES.already_decided);
  }
}

export function createReportsHttpHandlers(dependencies: SocialHttpDependencies = {}): ReportsHttpHandlers {
  const context = createSocialContext(dependencies, "reports-http");

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
      const mapped = mapReportError(error) ?? context.mapError(error);
      if (mapped) return mapped;
      return context.unavailable(logCodeOf(error), "reports");
    }
  }

  return {
    create: (request) =>
      guarded(request, { write: true }, async (userId) => {
        if (hasUnexpectedQuery(request)) return invalidRequest();
        const body = await context.readJsonObject(request, BODY_MAX_BYTES);
        if (body === null) return invalidRequest();
        const checked = checkReportInput(body);
        if (!checked.ok) return checked.reason === "phone" ? failure(400, "phone_number_in_report", PHONE_IN_REPORT_MESSAGE) : invalidRequest();
        const created = await createReport({ pool: context.poolOf(), reporterId: userId, report: checked.value });
        return noStoreJsonResponse(201, { contractVersion: REPORTS_CONTRACT_VERSION, report: { id: created.id, status: created.status, createdAt: created.createdAt.toISOString() } });
      }),

    list: (request) =>
      guarded(request, { write: false }, async (userId) => {
        if (hasUnexpectedQuery(request)) return invalidRequest();
        const reports = await listMyReports({ pool: context.poolOf(), reporterId: userId });
        return noStoreJsonResponse(200, {
          contractVersion: REPORTS_CONTRACT_VERSION,
          reports: reports.map((report) => ({
            id: report.id,
            targetType: report.targetType,
            reason: report.reason,
            status: report.status,
            targetTitle: report.targetTitle,
            createdAt: report.createdAt.toISOString(),
          })),
        });
      }),
  };
}

export const defaultReportsHttpHandlers = createReportsHttpHandlers();
