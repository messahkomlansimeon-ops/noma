/** Refus de domaine de la messagerie, des favoris et des commandes (lot D2) : code stable et texte fixe, jamais une donnée de la base. */
export type SocialErrorCode =
  | "resource_not_found"
  | "offer_not_available"
  | "rate_limited"
  | "favorites_limit"
  | "invalid_message"
  | "invalid_price"
  | "order_active_exists"
  | "order_state_conflict"
  | "action_not_allowed";

export const SOCIAL_ERROR_MESSAGES: Readonly<Record<SocialErrorCode, string>> = Object.freeze({
  resource_not_found: "Ressource introuvable.",
  offer_not_available: "Cette annonce n'est plus disponible.",
  rate_limited: "Trop de demandes : réessayez plus tard.",
  favorites_limit: "Vous avez atteint la limite de 200 favoris.",
  invalid_message: "Ce message n'est pas valide.",
  invalid_price: "Le prix convenu doit être un entier de 1 à 100 000 000 FCFA.",
  order_active_exists: "Une commande est déjà en cours pour cette annonce.",
  order_state_conflict: "Cette commande ne peut plus changer d'état.",
  action_not_allowed: "Cette action n'est pas permise pour votre rôle.",
});

export class SocialError extends Error {
  readonly code: SocialErrorCode;
  /** Pour `rate_limited` : secondes avant une nouvelle tentative (au moins 1). */
  readonly retryAfterSeconds: number | undefined;

  constructor(code: SocialErrorCode, retryAfterSeconds?: number) {
    super(SOCIAL_ERROR_MESSAGES[code]);
    this.name = "SocialError";
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}
