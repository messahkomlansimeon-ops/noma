import "server-only";

/** Refus de domaine de la recherche active : code stable et texte fixe (jamais une donnée de la base). */
export type ActiveSearchErrorCode =
  | "demand_not_active"
  | "no_product_key"
  | "unavailable"
  | "user_cap"
  | "capacity"
  | "price_changed"
  | "purchase_refunded"
  | "max_horizon"
  | "idempotency_conflict"
  | "purchase_not_found"
  | "already_refunded"
  | "later_period_exists";

export const ACTIVE_SEARCH_ERROR_MESSAGES: Readonly<Record<ActiveSearchErrorCode, string>> = Object.freeze({
  demand_not_active: "La recherche active n'est disponible que pour un besoin actif.",
  no_product_key: "Option indisponible pour ce besoin : il faut au moins une catégorie, une marque et un modèle.",
  unavailable: "La recherche active n'est pas encore disponible : aucune annonce d'un autre site n'est collectée pour le moment.",
  user_cap: "Vous avez déjà des recherches actives sur deux produits différents, c'est le maximum par compte : attendez la fin de l'une d'elles.",
  capacity: "La collecte accélérée est complète pour le moment : réessayez plus tard.",
  price_changed: "Le prix de la recherche active a changé : rechargez la page, puis réessayez.",
  purchase_refunded: "Cette option a été remboursée : démarrez une nouvelle option si vous la souhaitez.",
  max_horizon: "La recherche active ne peut pas dépasser 180 jours à partir d'aujourd'hui.",
  idempotency_conflict: "Cette clé d'idempotence a déjà servi pour un autre besoin.",
  purchase_not_found: "Achat de recherche active introuvable.",
  already_refunded: "Cet achat est déjà remboursé.",
  later_period_exists: "Une période plus récente existe pour ce besoin : remboursez-la d'abord.",
});

export class ActiveSearchError extends Error {
  readonly code: ActiveSearchErrorCode;

  constructor(code: ActiveSearchErrorCode) {
    super(ACTIVE_SEARCH_ERROR_MESSAGES[code]);
    this.name = "ActiveSearchError";
    this.code = code;
  }
}
