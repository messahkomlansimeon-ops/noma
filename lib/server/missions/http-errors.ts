import "server-only";

import { noStoreJsonResponse } from "../http/protection";
import { MissionError } from "./errors";

/**
 * Traduit un refus de domaine d'une mission en réponse HTTP (lot MV1) : code stable et texte fixe, jamais la valeur saisie ni une donnée de la base. Partagé par les routes des
 * missions et par celles des commandes (la déclaration d'un achat rattaché à une mission peut être refusée par la mission). `resource_not_found` est la MÊME réponse que celle
 * des autres routes (404 indiscernable).
 */
export function missionErrorResponse(error: MissionError): Response {
  const body = (status: number, extra: Record<string, unknown> = {}, headers?: HeadersInit): Response =>
    noStoreJsonResponse(status, { error: { code: error.code, message: error.message, ...extra } }, headers);
  switch (error.code) {
    case "resource_not_found":
      return body(404);
    case "invalid_mission":
    case "phone_number_in_mission":
      return body(400, error.field === null ? {} : { field: error.field });
    case "invalid_quantity":
      return body(400);
    case "mission_daily_limit":
      return body(429, {}, { "retry-after": String(error.retryAfterSeconds ?? 60) });
    case "mission_not_draft":
    case "mission_state_conflict":
    case "mission_active_limit":
    case "mission_not_active":
    case "mission_quantity_exceeded":
    case "mission_price_over_budget":
    case "mission_budget_exceeded":
      return body(409);
    default:
      return body(400);
  }
}
