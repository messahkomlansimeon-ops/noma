/**
 * Port des connecteurs de sources externes (lot EXT1) et types communs. Module PUR.
 *
 * Un connecteur reçoit une CLÉ PRODUIT (jamais un besoin, jamais un utilisateur) et renvoie des annonces normalisées. Il ne reçoit AUCUN client réseau : le port est
 * prêt pour de vrais connecteurs, mais aucun n'est écrit et le type `kind` n'admet que « fake » (un futur lot l'élargira avec la liste blanche validée).
 */

/** Clé produit normalisée d'une surveillance : minuscules, sans accents, espaces simples. */
export interface ProductKey {
  category: string;
  brand: string;
  model: string;
  /** Absente : le besoin ne précise pas de variante. */
  variant: string | null;
  /** Zone du besoin (vide : aucune zone précisée). */
  zone: string;
}

export type ConnectorAvailability = "available" | "unavailable" | "unknown";

/** Annonce normalisée renvoyée par un connecteur. Le collecteur la revalide et la nettoie ENTIÈREMENT (numéros de téléphone retirés, URL contrôlée) avant tout stockage. */
export interface ExternalListingDraft {
  /** Identifiant externe stable chez la source. */
  externalId: string;
  title: string;
  /** Montant entier, dans la devise. */
  price: number | null;
  /** Devise (XOF, FCFA…). */
  currency: string | null;
  /** URL de l'annonce chez la source. */
  url: string;
  location: string | null;
  /** Date de publication de l'annonce chez la source. */
  listedAt: Date | null;
  availability: ConnectorAvailability;
}

export interface ConnectorContext {
  /** Déclenché à l'expiration du délai de la recherche : le connecteur doit s'arrêter. */
  signal: AbortSignal;
  now: Date;
}

export interface SourceConnector {
  /** Code de la source dans `external_sources`. */
  readonly code: string;
  /** SEUL type admis : « fake ». Un connecteur réel n'existe pas et ne peut pas être déclaré sans modifier ce type. */
  readonly kind: "fake";
  search(key: ProductKey, context: ConnectorContext): Promise<ExternalListingDraft[]>;
}

export type ListingAvailability = "available" | "gone" | "unknown";

export interface SourceRow {
  code: string;
  name: string;
  type: string;
  enabled: boolean;
  daily_quota: number;
  min_interval_ms: number;
  consecutive_failures: number;
  breaker_open_until: Date | null;
  /** Jeton de l'essai décisif en cours (disjoncteur semi-ouvert) : tant qu'il n'est pas expiré, aucun autre essai ne part. */
  breaker_trial_until: Date | null;
  last_request_at: Date | null;
  last_success_at: Date | null;
  last_failure_at: Date | null;
  last_error_code: string | null;
}

export interface WatchRow {
  id: string;
  product_key: string;
  category: string;
  brand: string;
  model: string;
  variant: string | null;
  zone: string;
  status: "active" | "paused";
  frequency_seconds: number;
  daily_request_budget: number;
  last_run_at: Date | null;
  next_run_at: Date;
  /** Fréquence et budget relevés par la recherche active payante (lot RA1) ; ses requêtes ne consomment qu'une part du quota de chaque source. */
  accelerated: boolean;
}

/** Surveillance réservée par un exécuteur : `claim_token` est le jeton de son bail (seul lui peut la clore ou la rendre). */
export interface ClaimedWatch extends WatchRow {
  claim_token: string;
}

export function productKeyOfWatch(watch: Pick<WatchRow, "category" | "brand" | "model" | "variant" | "zone">): ProductKey {
  return { category: watch.category, brand: watch.brand, model: watch.model, variant: watch.variant, zone: watch.zone };
}
