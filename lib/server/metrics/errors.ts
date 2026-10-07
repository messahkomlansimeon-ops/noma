/** Refus de domaine des mesures (lot M1) : code stable et texte fixe, jamais de donnée de la base. */
export type MetricsErrorCode =
  | "resource_not_found"
  | "offer_not_available"
  | "contact_unavailable"
  | "rate_limited";

export const METRICS_ERROR_MESSAGES: Readonly<Record<MetricsErrorCode, string>> = Object.freeze({
  resource_not_found: "Ressource introuvable.",
  offer_not_available: "Cette annonce n'est plus disponible.",
  contact_unavailable: "Le contact de ce vendeur n'est pas disponible.",
  rate_limited: "Trop de vendeurs contactés aujourd'hui.",
});

export class MetricsError extends Error {
  readonly code: MetricsErrorCode;

  constructor(code: MetricsErrorCode) {
    super(METRICS_ERROR_MESSAGES[code]);
    this.name = "MetricsError";
    this.code = code;
  }
}
