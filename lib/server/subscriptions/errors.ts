import "server-only";

/** Refus de domaine de l'offre Pro : code stable et texte fixe (jamais une donnée de la base). */
export type SubscriptionErrorCode =
  | "plan_not_found"
  | "plan_not_subscribable"
  | "price_changed"
  | "already_subscribed"
  | "no_subscription"
  | "period_ended"
  | "idempotency_conflict"
  | "entitlement_required"
  | "period_not_found"
  | "already_refunded"
  | "invalid_plan_version"
  | "plans_unavailable"
  | "import_too_many_rows"
  | "import_invalid_file";

export const SUBSCRIPTION_ERROR_MESSAGES: Readonly<Record<SubscriptionErrorCode, string>> = Object.freeze({
  plan_not_found: "Ce plan n'existe pas.",
  plan_not_subscribable: "Ce plan ne se souscrit pas : il est gratuit.",
  price_changed: "Le prix de l'abonnement a changé : rechargez la page, puis réessayez.",
  already_subscribed: "Vous avez déjà un abonnement en cours.",
  no_subscription: "Vous n'avez pas d'abonnement en cours.",
  period_ended: "La période en cours est terminée : le renouvellement automatique ne peut plus être réactivé.",
  idempotency_conflict: "Cette clé d'idempotence a déjà servi pour un autre plan.",
  entitlement_required: "Cette fonction est réservée à l'offre Pro.",
  period_not_found: "Période d'abonnement introuvable.",
  already_refunded: "Cette période est déjà remboursée.",
  invalid_plan_version: "Version de plan invalide.",
  plans_unavailable: "Les plans ne sont pas disponibles pour le moment.",
  import_too_many_rows: "Le fichier compte plus de 200 lignes : découpez-le en plusieurs fichiers.",
  import_invalid_file: "Le fichier est illisible : vérifiez l'en-tête et le format CSV.",
});

export class SubscriptionError extends Error {
  readonly code: SubscriptionErrorCode;

  constructor(code: SubscriptionErrorCode) {
    super(SUBSCRIPTION_ERROR_MESSAGES[code]);
    this.name = "SubscriptionError";
    this.code = code;
  }
}
