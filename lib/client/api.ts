/**
 * Couche cliente UNIQUE vers l'API noma (module partagé navigateur : aucun import serveur).
 *
 * - fetch même origine, `credentials: "same-origin"`, JSON, en-tête `Content-Type` quand il y a un corps ;
 * - toute erreur devient une `ApiError { status, code }` construite UNIQUEMENT depuis le corps
 *   `{ error: { code, message } }` renvoyé par le serveur. Une panne réseau, une réponse qui n'a pas cette forme
 *   ou une exception inattendue donnent un code fixe (`network_error`, `invalid_response`, `aborted`, et `invalid_id` pour
 *   un identifiant qui n'est pas un UUID : aucune requête n'est alors envoyée) et un
 *   message fixe : le texte d'une exception brute n'est jamais repris ni affiché ;
 * - le texte montré à l'utilisateur vient de `describeApiError`, table de messages fixes en français.
 *
 * Les formes de corps et de réponses reprennent EXACTEMENT celles de lib/server/auth/http.ts,
 * lib/server/catalog/http.ts, lib/server/matching/http-dto.ts (`matching-stored-http/v1`), lib/server/boost/http.ts
 * (`boost-quote/v2`), lib/server/metrics/http.ts (`demand-offer/v1`, `offer-contact/v1`, `offer-stats/v1`), lib/server/wallet/http.ts (`wallet/v1`) et lib/server/boost/purchase-http.ts (`boost-purchase/v1`), et
 * lib/server/notifications/http.ts (`notifications/v1`, `notification-preferences/v1`, `demand-tracking/v1`), contrats
 * documentés dans AUTH-SERVER.md, CATALOG-HTTP.md, MATCHING-STORED-READ.md, BOOST-HTTP.md, WALLET.md, BOOST-PURCHASE.md et NOTIFICATIONS.md.
 * Les réponses sont relues champ par champ (liste blanche) : un champ que le serveur ajouterait un jour n'atteint jamais l'écran.
 * Les montants du portefeuille sont des entiers sûrs (|n| ≤ 2^53 − 1), vérifiés à l'envoi comme à la lecture.
 */

import { ATTRIBUTE_KEY_MESSAGE, OFFER_TEXT_FIELDS, phoneInOfferMessage, type OfferTextField } from "../phone-text";
import { parseCoverPhotoId, parsePhotoRefs, type PhotoRef } from "./photos-refs";

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export interface Money {
  amount: number;
  /** Code ISO sur trois lettres (XOF pour le FCFA). */
  currency: string;
}

export type OfferStatus = "draft" | "published" | "paused" | "archived";
export type DemandStatus = "draft" | "active" | "satisfied" | "archived";
export type AvailabilityStatus = "available" | "reserved" | "unavailable";

interface CatalogRecordCommon {
  id: string;
  rawText: string;
  category: string | null;
  brand: string | null;
  model: string | null;
  variant: string | null;
  attributes: JsonObject | null;
  condition: string | null;
  quantity: number | null;
  unit: string | null;
  location: string | null;
  deadlineAt: string | null;
  /** Version de contenu que le serveur exige pour toute transition ou modification. */
  contentVersion: number;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

export interface OfferRecord extends CatalogRecordCommon {
  status: OfferStatus;
  price: Money | null;
  availabilityStatus: AvailabilityStatus | null;
}

export interface DemandRecord extends CatalogRecordCommon {
  status: DemandStatus;
  budget: Money | null;
  requirements: JsonValue[] | null;
  preferences: JsonValue[] | null;
}

/** Champs de contenu communs acceptés à la création (`rawText` est requis par le serveur). */
export interface CatalogContentInput {
  rawText: string;
  category?: string | null;
  brand?: string | null;
  model?: string | null;
  variant?: string | null;
  attributes?: JsonObject | null;
  condition?: string | null;
  quantity?: number | null;
  unit?: string | null;
  location?: string | null;
  /** Date ISO UTC stricte (`2031-01-01T10:00:00Z`) ou null. */
  deadlineAt?: string | null;
}

export interface OfferInput extends CatalogContentInput {
  price?: Money | null;
  availabilityStatus?: AvailabilityStatus | null;
}

/** Modification partielle : au moins un champ, la version de contenu attendue est fournie à part. */
export type OfferChanges = Partial<OfferInput>;

export interface DemandInput extends CatalogContentInput {
  budget?: Money | null;
  requirements?: JsonValue[] | null;
  preferences?: JsonValue[] | null;
}

export interface Pagination {
  limit: number;
  offset: number;
}

// ─── Correspondances enregistrées (matching-stored-http/v1) ───────────────────────────────────────

export type MatchSort = "score" | "relevance";
export type AvailabilityLevel = "confirmed_recent" | "confirmed" | "unconfirmed" | "reserved" | "unavailable" | "unknown";
export type PricePosition = "below_market" | "in_market" | "above_market" | "insufficient_data";
export type ConfidenceLevel = "high" | "medium" | "low";
export type AccountAgeBand = "lt_7d" | "7d_30d" | "gte_30d";

/** Fiche produit épurée d'une correspondance : jamais de propriétaire, de texte brut ni de téléphone. */
export interface MatchProduct {
  category: string | null;
  brand: string | null;
  model: string | null;
  variant: string | null;
  condition: string | null;
  quantity: number | null;
  unit: string | null;
  location: string | null;
  deadlineAt: string | null;
  /** Offre : prix demandé. Absent (null) pour une demande. */
  price: Money | null;
  /** Demande : budget maximal. Absent (null) pour une offre. */
  budget: Money | null;
  availabilityStatus: AvailabilityStatus | null;
}

export interface MatchIndicators {
  /** Null dans le sens offre (le vendeur voit des besoins). */
  availability: { level: AvailabilityLevel; score: number | null; confirmedAgeHours: number | null; factors: string[] } | null;
  /** Null dans le sens offre. */
  price: { position: PricePosition; score: number | null; deltaPercent: number | null; sampleSize: number; factors: string[] } | null;
  confidence: { level: ConfidenceLevel; score: number; accountAgeBand: AccountAgeBand; factors: string[] };
}

export interface StoredMatch {
  /** Identifiant de l'offre (sens besoin) ou du besoin (sens offre) : sert de clé de liste, jamais affiché. */
  candidateId: string;
  candidate: MatchProduct;
  compatibilityStatus: string;
  /** Compatibilité 0 à 100, ou null. */
  score: number | null;
  coverage: number | null;
  evaluatedAt: string;
  indicators: MatchIndicators;
  /** Pertinence organique 0 à 100 (sans boost). */
  relevance: number;
  /** Vrai seulement pour un élément qui a gagné des places grâce à un boost (tri `relevance`, sens besoin). */
  sponsored: boolean;
  /** Lot PRO1 : le vendeur a un abonnement Pro en vigueur (badge « Vendeur Pro », sens besoin). Ce n'est pas une garantie de qualité. */
  proBadge: boolean;
  /** Lot PH1 : photo de couverture de l'annonce (le fichier est servi par `/api/media/{id}`) ; absente quand l'annonce n'a pas de photo. */
  coverPhotoId?: string;
}

export interface StoredMatchesPage {
  source: MatchProduct;
  items: StoredMatch[];
  /** La version courante de la source est encore en cours de traitement par le worker. */
  processing: boolean;
  readAt: string;
  nextCursor: string | null;
  hasMore: boolean;
  limit: number;
  /** Plus de 200 correspondances existent : seules les meilleures ont été triées par pertinence. */
  truncated: boolean;
}

export interface StoredMatchesQuery {
  sort?: MatchSort;
  /** Curseur opaque renvoyé par la page précédente (`nextCursor`). */
  cursor?: string;
  /** 1 à 100 (défaut serveur : 20). */
  limit?: number;
}

// ─── Mesures d'efficacité (lot M1) : comptes arrondis, fiche d'une annonce, contact, statistiques ───────────

/** Base de l'arrondi des comptes publiés (copie de COUNT_ROUNDING_BASE du serveur : un compte de 0 à 4 est « moins de 5 », sinon un multiple de 5). */
export const STAT_ROUNDING_BASE = 5;

/**
 * Compte d'acheteurs uniques (ou d'événements) publié ARRONDI (lot M1-quater) : `{ kind: "below", bound: 5 }` (« moins de 5 ») de 0 à 4, sinon
 * `{ kind: "approx", value }` (« environ N », multiple de 5 le plus proche). Jamais le compte exact.
 */
export type StatCount = { kind: "below"; bound: number } | { kind: "approx"; value: number };

/** Taux publié : pourcentage arrondi à la dizaine (« environ 70 % »), calculé sur les nombres publiés ; ou `insufficient` (pas assez d'acheteurs pour un pourcentage). */
export type StatRatio = { kind: "percent"; value: number } | { kind: "insufficient" };

export type StatsPeriodCode = "7d" | "30d" | "all";
export const STATS_PERIOD_CODES: readonly StatsPeriodCode[] = ["7d", "30d", "all"];

export interface ExposureStatsEntry { servings: StatCount; sponsoredServings: StatCount; buyersExposed: StatCount; buyersSponsored: StatCount }

export interface PeriodStats {
  period: StatsPeriodCode;
  /** Premier jour UTC de la période (AAAA-MM-JJ) ; null pour tout l'historique conservé. */
  since: string | null;
  /** Apparitions servies pendant un boost ; `null` quand aucun boost de l'annonce ne peut avoir servi l'annonce dans la période (annonce sans boost). */
  exposure: ExposureStatsEntry | null;
  opens: {
    total: StatCount;
    uniqueBuyers: StatCount;
    /** `null` (avec `organic`) quand aucun boost ne peut avoir attribué une ouverture dans la période : tout est organique. */
    attributedToBoost: { opens: StatCount; uniqueBuyers: StatCount } | null;
    organic: { opens: StatCount; uniqueBuyers: StatCount } | null;
  };
  contacts: {
    uniqueBuyers: StatCount;
    reveals: StatCount;
    attributedToBoost: { uniqueBuyers: StatCount } | null;
    organic: { uniqueBuyers: StatCount } | null;
  };
  ratios: {
    /** Acheteurs qui ont ouvert parmi ceux à qui l'annonce a été servie pendant un boost / acheteurs servis ; `null` : aucune apparition possible dans la période. */
    openRate: StatRatio | null;
    /** Acheteurs qui ont contacté parmi ceux qui ont ouvert / acheteurs qui ont ouvert. */
    contactRate: StatRatio;
  };
}

export interface BoostStatsEntry {
  boostId: string;
  durationCode: BoostDurationCode;
  status: "effective" | "expired" | "cancelled" | "scheduled";
  startsAt: string;
  endsAt: string;
  /** `null` pour un boost qui n'a pas commencé (aucune apparition possible). */
  exposure: ExposureStatsEntry | null;
  attributed: { opens: StatCount; uniqueOpeners: StatCount; uniqueContacts: StatCount; reveals: StatCount } | null;
  ratios: { openRate: StatRatio | null; contactRate: StatRatio | null };
}

/** Ce que produit une annonce (vendeur) : AUCUNE identité d'acheteur ; aucun compte exact n'est publié (« moins de 5 », « environ N »). */
export interface OfferStats {
  /** Besoins d'acheteurs dont la correspondance est confirmée et fraîche à la lecture (des besoins, pas des acheteurs) ; « moins de 5 » de 0 à 4, sinon « environ N ». */
  activeMatches: { needs: StatCount };
  periods: PeriodStats[];
  /** Les boosts de l'annonce, du plus récent au plus ancien ; vide : aucun boost, tout est organique. */
  boosts: BoostStatsEntry[];
}

/** Attribut public d'une annonce : clé simple et valeur courte (jamais un numéro de téléphone). */
export interface OfferPublicAttribute {
  key: string;
  value: string;
}

/** Fiche d'une annonce pour l'acheteur, dans le contexte d'un de ses besoins : la correspondance (indicateurs, `sponsored`) et les détails publics. */
export interface OfferDetail {
  item: StoredMatch;
  details: {
    /** Date de CRÉATION de l'annonce (le modèle ne conserve pas de date de mise en ligne distincte). */
    createdAt: string;
    attributes: OfferPublicAttribute[];
    /** Lot PH1 : photos de l'annonce (identifiant et dimensions), dans l'ordre ; absentes quand l'annonce n'a pas de photo. */
    photos?: PhotoRef[];
  };
  readAt: string;
}

/** Contact du vendeur : son numéro VÉRIFIÉ (E.164) et deux liens, jamais mis en cache. */
export interface OfferContact {
  phone: string;
  telUrl: string;
  whatsappUrl: string;
  /** Vrai la première fois que ce besoin contacte cette annonce. */
  firstContact: boolean;
}

// ─── Notifications et suivi des besoins (notifications/v1, notification-preferences/v1, demand-tracking/v1) ───

export type NotificationKind = "new_match" | "new_matches_digest" | "new_message" | "mission_coverage";
export const NOTIFICATION_KINDS: readonly NotificationKind[] = ["new_match", "new_matches_digest", "new_message", "mission_coverage"];

/** Une notification DANS l'application : liste blanche (titre, prix, lien interne) ; jamais de téléphone, d'identifiant du vendeur ni de texte libre. */
export interface NotificationItem {
  id: string;
  kind: NotificationKind;
  /** Titre de l'annonce (new_match) ; null pour un résumé. */
  title: string | null;
  price: Money | null;
  /** Résumé : nombre d'annonces au-delà du plafond du jour ; mission_coverage : quantité couverte ; null sinon. */
  count: number | null;
  demandId: string;
  /** new_match : l'annonce, dans le contexte du besoin ; null pour un résumé. */
  offerId: string | null;
  /** Lien INTERNE vers la fiche (new_match), le besoin (résumé), la conversation (new_message : `/messages/{id}`) ou la mission (mission_coverage : `/missions/{id}`). */
  link: string;
  createdAt: string;
  readAt: string | null;
}

export interface NotificationsPage {
  items: NotificationItem[];
  nextCursor: string | null;
  /** Nombre TOTAL de notifications non lues (pas seulement celles de la page). */
  unreadCount: number;
}

export interface NotificationsQuery {
  /** 1 à 50 (20 par défaut). */
  limit?: number;
  cursor?: string;
}

export interface MarkReadResult {
  marked: number;
  unreadCount: number;
}

export interface NotificationPreferences {
  /** Envoi externe simulé demandé par l'utilisateur (désactivé par défaut). */
  externalEnabled: boolean;
  /** Un transport (simulé) existe dans l'environnement du serveur. */
  externalAvailable: boolean;
  /** Texte fixe du serveur : « Les envois par SMS ne sont pas encore disponibles : ils sont simulés en développement. » */
  notice: string;
  /** Lot SMS1 : le transport est un VRAI fournisseur SMS (présent seulement quand il est actif) : les libellés ne parlent plus de simulation. */
  real?: boolean;
}

export type TrackingAction = "extend" | "pause" | "resume";
export const TRACKING_ACTIONS: readonly TrackingAction[] = ["extend", "pause", "resume"];

/** Suivi d'un besoin : le matching continue pendant une pause ou après la fin ; seules les notifications s'arrêtent. */
export interface DemandTracking {
  demandId: string;
  demandStatus: DemandStatus;
  until: string;
  paused: boolean;
  /** Les notifications partent pour ce besoin : actif, pas en pause, échéance dans le futur. */
  active: boolean;
  /** Échéance maximale d'une prolongation (maintenant + 90 jours). */
  maxUntil: string;
  readAt: string;
}

// ─── Cotations de boost (boost-quote/v2) ──────────────────────────────────────────────────────────

export const BOOST_DURATION_CODES = ["24h", "3d", "7d"] as const;
export type BoostDurationCode = (typeof BOOST_DURATION_CODES)[number];

export interface BoostQuote {
  id: string;
  durationCode: BoostDurationCode;
  currency: string;
  status: "available" | "unavailable";
  /** Montant entier (XOF) ; null si la cotation est indisponible. */
  amount: number | null;
  /** Code stable (`offer_already_boosted`, `no_slot_available`, `seller_boost_limit_reached`, `no_compatible_buyer`, `no_visible_effect`) ou null. */
  unavailableReason: string | null;
  /** Facteurs en millièmes (1000 = ×1) ; null si la cotation est indisponible. */
  factors: { competitionMilli: number; demandMilli: number; scarcityMilli: number; durationMilli: number } | null;
  inputs: {
    competingSellers: number;
    /** Acheteurs compatibles, arrondis : `{ kind: "below", bound: 5 }` (« moins de 5 ») de 0 à 4, sinon `{ kind: "approx", value }` (lots M1 à M1-quater). */
    compatibleBuyers: StatCount;
    /** Acheteurs pour lesquels le boost ferait réellement monter l'annonce (même arrondi) ; `null` : non évalué (devis ancien ou indisponible plus tôt). */
    reachableBuyers: StatCount | null;
    /** Lot P3 : la portée est une estimation bornée ; vrai = des acheteurs n'ont pas été examinés, `reachableBuyers` est un MINIMUM (« au moins X »). */
    reachTruncated: boolean;
    slotsTotal: number;
    slotsUsed: number;
  };
  computedAt: string;
  expiresAt: string;
  /** POST : cotation réutilisée (vrai) ou créée (faux). Null dans l'historique. */
  reused: boolean | null;
  /** Historique : cotation expirée à la lecture. Null dans la réponse du POST. */
  expired: boolean | null;
  /**
   * Heure du SERVEUR à l'émission de la réponse (en-tête HTTP `Date`, résolution 1 s), en millisecondes depuis 1970 ; `null` si l'en-tête
   * manque ou n'est pas une date. Sert à ancrer le compte à rebours d'un devis réutilisé (son âge) sans l'horloge de l'appareil.
   */
  serverTime: number | null;
}

// ─── Portefeuille, recharge simulée et achat de boost (wallet/v1, boost-purchase/v1) ───────────────

export const WALLET_TRANSACTION_KINDS = [
  "topup", "adjustment", "boost_purchase", "boost_refund", "subscription_charge", "subscription_refund", "promo_expiry",
] as const;
/**
 * Types connus ; « unknown » = un type que cette version de l'écran ne connaît pas (ajouté un jour par le serveur) : la ligne s'affiche « Opération »,
 * avec son montant (validé), au lieu de faire rejeter tout l'historique. Le code brut du serveur n'atteint jamais l'écran.
 */
export type WalletTransactionKind = (typeof WALLET_TRANSACTION_KINDS)[number] | "unknown";

/**
 * Une ligne de l'historique : `amountXof` est SIGNÉ du côté de l'utilisateur sur ses crédits PAYÉS (positif = crédit, négatif = débit) ; `promoAmountXof` l'est sur ses crédits
 * PROMOTIONNELS (lot PRO1 : émis ou restitué, dépensé, expiré ou annulé). Une opération purement promotionnelle a `amountXof` nul.
 */
export interface WalletTransaction {
  id: string;
  kind: WalletTransactionKind;
  amountXof: number;
  promoAmountXof: number;
  createdAt: string;
}

/** Prestataires de paiement (lot PAY1) : le prestataire fictif (développement) et Wave via Sublymus ; « none » : aucun n'est actif. */
export const PAYMENT_PROVIDERS = ["fake", "sublymus"] as const;
export type PaymentProviderName = (typeof PAYMENT_PROVIDERS)[number];

export interface WalletOverview {
  /** Prestataire de paiement ACTIF côté serveur (lot PAY1) : sert à dire à l'écran par quel moyen on recharge. */
  paymentMode: PaymentProviderName | "none";
  /** Crédits PAYÉS en FCFA (entier, jamais négatif). */
  balanceXof: number;
  /** Crédits promotionnels dépensables maintenant (lot PRO1) : distincts des crédits payés, non remboursables, non retirables, ils expirent. */
  promoBalanceXof: number;
  /** Échéance la plus proche de ces crédits promotionnels ; null s'il n'y en a pas. */
  promoExpiresAt: string | null;
  /** Du plus récent au plus ancien. */
  transactions: WalletTransaction[];
  nextCursor: string | null;
}

export interface WalletOverviewQuery {
  /** Curseur opaque renvoyé par la page précédente (`nextCursor`). */
  cursor?: string;
  /** 1 à 50 (défaut serveur : 20). */
  limit?: number;
}

export const TOPUP_STATUSES = ["pending", "succeeded", "failed", "expired"] as const;
export type TopupStatus = (typeof TOPUP_STATUSES)[number];

export interface WalletTopup {
  id: string;
  amountXof: number;
  status: TopupStatus;
  expiresAt: string;
  /** Chemin de la page de paiement simulé (`/paiement-simule/<id>`) ou de retour de paiement (`/paiement-retour/<id>`) : à vérifier avant toute navigation. */
  checkoutPath: string;
  /** Prestataire de CETTE recharge (lot PAY1). */
  provider: PaymentProviderName;
  /** Lien de paiement Wave (https) vers lequel rediriger le navigateur ; null : prestataire fictif, session non ouverte, ou recharge terminée. À vérifier avant toute navigation. */
  checkoutUrl: string | null;
}

export interface TopupRequest {
  /** Entier sûr strictement positif (les bornes métier sont vérifiées par l'écran et par le serveur). */
  amountXof: number;
  /** UUID généré UNE fois par tentative et réutilisé à chaque nouvel essai. */
  idempotencyKey: string;
}

export const FAKE_PAYMENT_OUTCOMES = [
  "applied",
  "duplicate",
  "rejected_amount",
  "rejected_state",
  "rejected_unknown_intent",
  "replayed",
] as const;
export type FakePaymentOutcome = (typeof FAKE_PAYMENT_OUTCOMES)[number];

export interface FakePaymentResult {
  outcome: FakePaymentOutcome;
  topup: WalletTopup;
}

export interface BoostPurchase {
  id: string;
  quoteId: string;
  durationCode: BoostDurationCode;
  amountXof: number;
  /** Part du prix payée en crédits promotionnels (lot PRO1) ; le reste est payé en crédits. */
  promoAmountXof: number;
  startsAt: string;
  endsAt: string;
  /** Vrai si la même clé d'idempotence avait déjà servi (aucun nouveau débit). */
  reused: boolean;
}

export interface BoostPurchaseResult {
  purchase: BoostPurchase;
  /** Solde après l'opération (le solde courant pour un rejeu). */
  balanceXof: number;
}

export interface BoostPurchaseRequest {
  quoteId: string;
  idempotencyKey: string;
}

export interface BoostPurchaseHistoryItem {
  id: string;
  quoteId: string;
  durationCode: BoostDurationCode;
  amountXof: number;
  promoAmountXof: number;
  startsAt: string;
  endsAt: string;
  createdAt: string;
  refundedAt: string | null;
}

// ─── Accueils de l'acheteur et du vendeur (lot D1) ──────────────────────────────────────────────────

export const BUYER_HOME_CONTRACT_VERSION = "home-buyer/v1";
export const VENDOR_HOME_CONTRACT_VERSION = "home-vendor/v1";

export interface BuyerHomeDemand {
  id: string;
  title: string;
  category: string | null;
  brand: string | null;
  model: string | null;
  variant: string | null;
  location: string | null;
  budget: Money | null;
  /** Nombre d'annonces servies par la page de résultats du besoin. */
  matchCount: number;
  createdAt: string;
}

export interface BuyerHomeNotification {
  id: string;
  kind: NotificationKind;
  title: string | null;
  price: Money | null;
  count: number | null;
  link: string;
  createdAt: string;
  unread: boolean;
}

export interface BuyerHome {
  activeDemandCount: number;
  demands: BuyerHomeDemand[];
  unreadNotifications: number;
  notifications: BuyerHomeNotification[];
}

export type VendorOfferStatus = "draft" | "published" | "paused";

export interface VendorHomeOffer {
  id: string;
  title: string;
  status: VendorOfferStatus;
  category: string | null;
  brand: string | null;
  model: string | null;
  variant: string | null;
  price: Money | null;
  /** Besoins correspondants, ARRONDIS (« moins de 5 », « environ N »). */
  needs: StatCount;
  boostEndsAt: string | null;
  /** Lot PH1 : photo de couverture (le fichier est servi par `/api/media/{id}`) ; absente quand l'annonce n'a pas de photo. */
  coverPhotoId?: string;
}

export interface VendorHome {
  counts: { published: number; paused: number; draft: number };
  needs: StatCount;
  balance: number;
  activeBoosts: { offerId: string; endsAt: string }[];
  offers: VendorHomeOffer[];
}

export interface OtpChallenge {
  challengeId: string;
  expiresAt: string;
  resendAvailableAt: string;
}

export type SessionOutcome =
  | { kind: "authenticated"; userId: string; /** Compte administrateur (booléen seulement) : affiche l'onglet Admin du sélecteur d'espace. */ isAdmin: boolean }
  | { kind: "anonymous" }
  | { kind: "unavailable" };

export const API_NETWORK_ERROR = "network_error";
export const API_INVALID_RESPONSE = "invalid_response";
export const API_ABORTED = "aborted";
export const API_INVALID_ID = "invalid_id";
export const API_INVALID_ARGUMENT = "invalid_argument";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Même forme d'identifiant que le serveur (lib/server/catalog/validation.ts). */
export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

const FIXED_ERROR_MESSAGES: Record<string, string> = {
  [API_NETWORK_ERROR]: "Connexion au serveur impossible.",
  [API_INVALID_RESPONSE]: "Réponse du serveur inattendue.",
  [API_ABORTED]: "Requête interrompue.",
  [API_INVALID_ID]: "Identifiant invalide.",
  [API_INVALID_ARGUMENT]: "Paramètre invalide.",
};

/** Erreur d'API : `status` HTTP (0 = pas de réponse) et `code` du serveur ; jamais de texte d'exception brute. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  /** Champ de l'annonce nommé par le serveur (liste fermée, lot D3) : seulement pour `phone_number_in_offer`. */
  readonly field: OfferTextField | null;

  constructor(status: number, code: string, message: string, field: OfferTextField | null = null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.field = field;
  }
}

function fixedError(status: number, code: string): ApiError {
  return new ApiError(status, code, FIXED_ERROR_MESSAGES[code] ?? FIXED_ERROR_MESSAGES[API_INVALID_RESPONSE]);
}

const ERROR_CODE = /^[a-z][a-z0-9_]{0,63}$/;

function errorFromBody(status: number, body: unknown): ApiError {
  if (isObject(body) && isObject(body.error)) {
    const { code, message, field } = body.error;
    if (typeof code === "string" && ERROR_CODE.test(code) && typeof message === "string" && message.length <= 500) {
      // Le champ n'est repris que s'il fait partie de la liste fermée des champs d'une annonce : jamais un texte du serveur.
      const known = typeof field === "string" ? OFFER_TEXT_FIELDS.find((candidate) => candidate === field) : undefined;
      return new ApiError(status, code, message, known ?? null);
    }
  }
  return fixedError(status, API_INVALID_RESPONSE);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringOrNull(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isMoneyOrNull(value: unknown): value is Money | null {
  return (
    value === null ||
    (isObject(value) && typeof value.amount === "number" && typeof value.currency === "string")
  );
}

function parseCommon(status: number, value: unknown): CatalogRecordCommon {
  if (
    !isObject(value) ||
    typeof value.id !== "string" ||
    typeof value.status !== "string" ||
    typeof value.rawText !== "string" ||
    !isStringOrNull(value.category) ||
    !isStringOrNull(value.brand) ||
    !isStringOrNull(value.model) ||
    !isStringOrNull(value.variant) ||
    !isStringOrNull(value.condition) ||
    !isStringOrNull(value.unit) ||
    !isStringOrNull(value.location) ||
    !isStringOrNull(value.deadlineAt) ||
    !(value.quantity === null || typeof value.quantity === "number") ||
    !(value.attributes === null || isObject(value.attributes)) ||
    typeof value.contentVersion !== "number" ||
    !Number.isSafeInteger(value.contentVersion) ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string" ||
    !isStringOrNull(value.archivedAt)
  ) {
    throw fixedError(status, API_INVALID_RESPONSE);
  }
  return value as unknown as CatalogRecordCommon;
}

const OFFER_STATUSES: readonly string[] = ["draft", "published", "paused", "archived"];
const DEMAND_STATUSES: readonly string[] = ["draft", "active", "satisfied", "archived"];

function parseOffer(status: number, value: unknown): OfferRecord {
  const common = parseCommon(status, value);
  const record = value as Record<string, unknown>;
  if (
    !OFFER_STATUSES.includes(String(record.status)) ||
    !isMoneyOrNull(record.price) ||
    !(record.availabilityStatus === null || typeof record.availabilityStatus === "string")
  ) {
    throw fixedError(status, API_INVALID_RESPONSE);
  }
  return { ...common, status: record.status, price: record.price, availabilityStatus: record.availabilityStatus } as OfferRecord;
}

function parseDemand(status: number, value: unknown): DemandRecord {
  const common = parseCommon(status, value);
  const record = value as Record<string, unknown>;
  if (
    !DEMAND_STATUSES.includes(String(record.status)) ||
    !isMoneyOrNull(record.budget) ||
    !(record.requirements === null || Array.isArray(record.requirements)) ||
    !(record.preferences === null || Array.isArray(record.preferences))
  ) {
    throw fixedError(status, API_INVALID_RESPONSE);
  }
  return {
    ...common,
    status: record.status,
    budget: record.budget,
    requirements: record.requirements,
    preferences: record.preferences,
  } as DemandRecord;
}

function parsePagination(status: number, value: unknown): Pagination {
  if (!isObject(value) || typeof value.limit !== "number" || typeof value.offset !== "number") {
    throw fixedError(status, API_INVALID_RESPONSE);
  }
  return { limit: value.limit, offset: value.offset };
}

// ─── Lecture stricte des correspondances et des cotations ───────────────────────────────────────

const AVAILABILITY_LEVELS: readonly string[] = ["confirmed_recent", "confirmed", "unconfirmed", "reserved", "unavailable", "unknown"];
const PRICE_POSITIONS: readonly string[] = ["below_market", "in_market", "above_market", "insufficient_data"];
const CONFIDENCE_LEVELS: readonly string[] = ["high", "medium", "low"];
const ACCOUNT_AGE_BANDS: readonly string[] = ["lt_7d", "7d_30d", "gte_30d"];
const AVAILABILITY_STATUSES: readonly string[] = ["available", "reserved", "unavailable"];
const FACTOR_CODE = /^[a-z][a-z0-9_]{0,63}$/;

export const MATCHING_STORED_CONTRACT_VERSION = "matching-stored-http/v1";
export const BOOST_QUOTE_CONTRACT_VERSION = "boost-quote/v2";
export const OFFER_DETAIL_CONTRACT_VERSION = "demand-offer/v1";
export const OFFER_CONTACT_CONTRACT_VERSION = "offer-contact/v1";
export const OFFER_STATS_CONTRACT_VERSION = "offer-stats/v1";
export const WALLET_CONTRACT_VERSION = "wallet/v1";
export const BOOST_PURCHASE_CONTRACT_VERSION = "boost-purchase/v1";
export const NOTIFICATIONS_CONTRACT_VERSION = "notifications/v1";
export const NOTIFICATION_PREFERENCES_CONTRACT_VERSION = "notification-preferences/v1";
export const DEMAND_TRACKING_CONTRACT_VERSION = "demand-tracking/v1";

function isNumberOrNull(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value));
}

function isCodeList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string" && FACTOR_CODE.test(entry));
}

function moneyOrNull(status: number, value: unknown): Money | null {
  if (value === undefined || value === null) return null;
  if (!isMoneyOrNull(value)) throw fixedError(status, API_INVALID_RESPONSE);
  const money = value as Money;
  return { amount: money.amount, currency: money.currency };
}

/** Fiche produit d'une correspondance : liste blanche, champ par champ (jamais de propriétaire ni de texte brut). */
function parseMatchProduct(status: number, value: unknown): MatchProduct {
  if (
    !isObject(value) ||
    !isStringOrNull(value.category) ||
    !isStringOrNull(value.brand) ||
    !isStringOrNull(value.model) ||
    !isStringOrNull(value.variant) ||
    !isStringOrNull(value.condition) ||
    !isNumberOrNull(value.quantity) ||
    !isStringOrNull(value.unit) ||
    !isStringOrNull(value.location) ||
    !isStringOrNull(value.deadlineAt) ||
    !(value.availabilityStatus === undefined || value.availabilityStatus === null || AVAILABILITY_STATUSES.includes(String(value.availabilityStatus)))
  ) {
    throw fixedError(status, API_INVALID_RESPONSE);
  }
  return {
    category: value.category,
    brand: value.brand,
    model: value.model,
    variant: value.variant,
    condition: value.condition,
    quantity: value.quantity,
    unit: value.unit,
    location: value.location,
    deadlineAt: value.deadlineAt,
    price: moneyOrNull(status, value.price),
    budget: moneyOrNull(status, value.budget),
    availabilityStatus: (value.availabilityStatus ?? null) as AvailabilityStatus | null,
  };
}

function parseIndicators(status: number, value: unknown): MatchIndicators {
  if (!isObject(value) || !isObject(value.confidence)) throw fixedError(status, API_INVALID_RESPONSE);
  const { availability, price, confidence } = value;
  const parsed: MatchIndicators = {
    availability: null,
    price: null,
    confidence: undefined as unknown as MatchIndicators["confidence"],
  };
  if (availability !== null) {
    if (
      !isObject(availability) ||
      !AVAILABILITY_LEVELS.includes(String(availability.level)) ||
      !isNumberOrNull(availability.score) ||
      !isNumberOrNull(availability.confirmedAgeHours) ||
      !isCodeList(availability.factors)
    ) {
      throw fixedError(status, API_INVALID_RESPONSE);
    }
    parsed.availability = {
      level: availability.level as AvailabilityLevel,
      score: availability.score,
      confirmedAgeHours: availability.confirmedAgeHours,
      factors: availability.factors,
    };
  }
  if (price !== null) {
    if (
      !isObject(price) ||
      !PRICE_POSITIONS.includes(String(price.position)) ||
      !isNumberOrNull(price.score) ||
      !isNumberOrNull(price.deltaPercent) ||
      typeof price.sampleSize !== "number" ||
      !isCodeList(price.factors)
    ) {
      throw fixedError(status, API_INVALID_RESPONSE);
    }
    parsed.price = {
      position: price.position as PricePosition,
      score: price.score,
      deltaPercent: price.deltaPercent,
      sampleSize: price.sampleSize,
      factors: price.factors,
    };
  }
  if (
    !CONFIDENCE_LEVELS.includes(String(confidence.level)) ||
    typeof confidence.score !== "number" ||
    !ACCOUNT_AGE_BANDS.includes(String(confidence.accountAgeBand)) ||
    !isCodeList(confidence.factors)
  ) {
    throw fixedError(status, API_INVALID_RESPONSE);
  }
  parsed.confidence = {
    level: confidence.level as ConfidenceLevel,
    score: confidence.score,
    accountAgeBand: confidence.accountAgeBand as AccountAgeBand,
    factors: confidence.factors,
  };
  return parsed;
}

/** Lot PH1 : la couverture n'est reprise que si c'est un UUID ; absente sinon (jamais une valeur arbitraire du serveur). */
function coverField(value: unknown): { coverPhotoId?: string } {
  const cover = parseCoverPhotoId(value);
  return cover === null ? {} : { coverPhotoId: cover };
}

function parseStoredMatch(status: number, value: unknown): StoredMatch {
  if (
    !isObject(value) ||
    typeof value.candidateId !== "string" ||
    typeof value.compatibilityStatus !== "string" ||
    !isNumberOrNull(value.score) ||
    !isNumberOrNull(value.coverage) ||
    typeof value.evaluatedAt !== "string" ||
    typeof value.relevance !== "number" ||
    typeof value.sponsored !== "boolean" ||
    // Lot PRO1 : absent chez un serveur plus ancien (faux) ; s'il est présent, c'est un booléen.
    !(value.proBadge === undefined || typeof value.proBadge === "boolean")
  ) {
    throw fixedError(status, API_INVALID_RESPONSE);
  }
  return {
    candidateId: value.candidateId,
    candidate: parseMatchProduct(status, value.candidate),
    compatibilityStatus: value.compatibilityStatus,
    score: value.score,
    coverage: value.coverage,
    evaluatedAt: value.evaluatedAt,
    indicators: parseIndicators(status, value.indicators),
    relevance: value.relevance,
    sponsored: value.sponsored,
    proBadge: value.proBadge === true,
    ...coverField(value.coverPhotoId),
  };
}

function parseStoredMatchesPage(status: number, value: unknown): StoredMatchesPage {
  if (
    !isObject(value) ||
    value.contractVersion !== MATCHING_STORED_CONTRACT_VERSION ||
    !Array.isArray(value.items) ||
    typeof value.processing !== "boolean" ||
    typeof value.readAt !== "string" ||
    !isStringOrNull(value.nextCursor) ||
    typeof value.hasMore !== "boolean" ||
    typeof value.limit !== "number" ||
    typeof value.truncated !== "boolean"
  ) {
    throw fixedError(status, API_INVALID_RESPONSE);
  }
  return {
    source: parseMatchProduct(status, value.source),
    items: value.items.map((item) => parseStoredMatch(status, item)),
    processing: value.processing,
    readAt: value.readAt,
    nextCursor: value.nextCursor,
    hasMore: value.hasMore,
    limit: value.limit,
    truncated: value.truncated,
  };
}

/**
 * En-tête HTTP `Date` d'une réponse → millisecondes depuis 1970 ; `null` s'il manque ou n'est pas une date. Seul le FORMAT est contrôlé ici ;
 * la cohérence avec le devis (une heure du serveur antérieure au calcul du devis est absurde) est contrôlée par `anchorQuote` (wallet-view.ts).
 */
export function serverTimeFromDateHeader(value: string | null | undefined): number | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 64) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

function parseBoostQuote(status: number, value: unknown, flag: "reused" | "expired", serverTime: number | null): BoostQuote {
  if (
    !isObject(value) ||
    typeof value.id !== "string" ||
    !(BOOST_DURATION_CODES as readonly string[]).includes(String(value.durationCode)) ||
    typeof value.currency !== "string" ||
    (value.status !== "available" && value.status !== "unavailable") ||
    !(value.amount === null || (typeof value.amount === "number" && Number.isSafeInteger(value.amount))) ||
    !(value.unavailableReason === null || (typeof value.unavailableReason === "string" && FACTOR_CODE.test(value.unavailableReason))) ||
    typeof value[flag] !== "boolean" ||
    typeof value.computedAt !== "string" ||
    typeof value.expiresAt !== "string" ||
    !isObject(value.inputs)
  ) {
    throw fixedError(status, API_INVALID_RESPONSE);
  }
  const { inputs } = value;
  if (
    typeof inputs.competingSellers !== "number" ||
    !isStatCount(inputs.compatibleBuyers) ||
    !(inputs.reachableBuyers === null || isStatCount(inputs.reachableBuyers)) ||
    !(inputs.reachTruncated === undefined || typeof inputs.reachTruncated === "boolean") ||
    typeof inputs.slotsTotal !== "number" ||
    typeof inputs.slotsUsed !== "number"
  ) {
    throw fixedError(status, API_INVALID_RESPONSE);
  }
  let factors: BoostQuote["factors"] = null;
  if (value.factors !== null) {
    const raw = value.factors;
    if (
      !isObject(raw) ||
      typeof raw.competitionMilli !== "number" ||
      typeof raw.demandMilli !== "number" ||
      typeof raw.scarcityMilli !== "number" ||
      typeof raw.durationMilli !== "number"
    ) {
      throw fixedError(status, API_INVALID_RESPONSE);
    }
    factors = {
      competitionMilli: raw.competitionMilli,
      demandMilli: raw.demandMilli,
      scarcityMilli: raw.scarcityMilli,
      durationMilli: raw.durationMilli,
    };
  }
  return {
    id: value.id,
    durationCode: value.durationCode as BoostDurationCode,
    currency: value.currency,
    status: value.status,
    amount: value.amount as number | null,
    unavailableReason: value.unavailableReason as string | null,
    factors,
    inputs: {
      competingSellers: inputs.competingSellers,
      compatibleBuyers: toStatCount(inputs.compatibleBuyers),
      reachableBuyers: inputs.reachableBuyers === null ? null : toStatCount(inputs.reachableBuyers),
      reachTruncated: inputs.reachTruncated === true,
      slotsTotal: inputs.slotsTotal,
      slotsUsed: inputs.slotsUsed,
    },
    computedAt: value.computedAt,
    expiresAt: value.expiresAt,
    reused: flag === "reused" ? (value.reused as boolean) : null,
    expired: flag === "expired" ? (value.expired as boolean) : null,
    serverTime,
  };
}

// ─── Lecture stricte des mesures (lot M1) ───────────────────────────────────────────────────────────

/**
 * Compte arrondi EXACT : `{ kind: "below", bound: 5 }` ou `{ kind: "approx", value }` avec `value` un multiple de 5 d'au moins 5 (jamais un nombre nu, un compte
 * « approx » non arrondi, une borne autre que 5, ni un champ de plus).
 */
function isStatCount(value: unknown): value is StatCount {
  if (!isObject(value) || Object.keys(value).length !== 2) return false;
  if (value.kind === "below") return value.bound === STAT_ROUNDING_BASE;
  if (value.kind === "approx") return typeof value.value === "number" && Number.isSafeInteger(value.value) && value.value >= STAT_ROUNDING_BASE && value.value % STAT_ROUNDING_BASE === 0;
  return false;
}

function toStatCount(value: StatCount): StatCount {
  return value.kind === "below" ? { kind: "below", bound: value.bound } : { kind: "approx", value: value.value };
}

function statCount(status: number, value: unknown): StatCount {
  if (!isStatCount(value)) throw fixedError(status, API_INVALID_RESPONSE);
  return toStatCount(value);
}

/** Taux : `{ kind: "percent", value }` (multiple de 10, de 0 à 100) ou `{ kind: "insufficient" }`, rien d'autre. */
function statRatio(status: number, value: unknown): StatRatio {
  if (!isObject(value)) throw fixedError(status, API_INVALID_RESPONSE);
  if (value.kind === "insufficient" && Object.keys(value).length === 1) return { kind: "insufficient" };
  if (value.kind === "percent" && Object.keys(value).length === 2 && typeof value.value === "number" && Number.isSafeInteger(value.value) && value.value >= 0 && value.value <= 100 && value.value % 10 === 0) {
    return { kind: "percent", value: value.value };
  }
  throw fixedError(status, API_INVALID_RESPONSE);
}

const DAY_TEXT = /^\d{4}-\d{2}-\d{2}$/;
const BOOST_STATUSES: readonly string[] = ["effective", "expired", "cancelled", "scheduled"];

function record(status: number, value: unknown): Record<string, unknown> {
  if (!isObject(value)) throw fixedError(status, API_INVALID_RESPONSE);
  return value;
}

function optionalRecord(status: number, value: unknown): Record<string, unknown> | null {
  return value === null ? null : record(status, value);
}

function parseExposure(status: number, value: unknown): ExposureStatsEntry | null {
  const exposure = optionalRecord(status, value);
  if (exposure === null) return null;
  return {
    servings: statCount(status, exposure.servings),
    sponsoredServings: statCount(status, exposure.sponsoredServings),
    buyersExposed: statCount(status, exposure.buyersExposed),
    buyersSponsored: statCount(status, exposure.buyersSponsored),
  };
}

function parsePeriodStats(status: number, value: unknown): PeriodStats {
  const raw = record(status, value);
  if (!(STATS_PERIOD_CODES as readonly string[]).includes(String(raw.period)) || !(raw.since === null || (typeof raw.since === "string" && DAY_TEXT.test(raw.since)))) {
    throw fixedError(status, API_INVALID_RESPONSE);
  }
  const opens = record(status, raw.opens);
  const contacts = record(status, raw.contacts);
  const attributedOpens = optionalRecord(status, opens.attributedToBoost);
  const organicOpens = optionalRecord(status, opens.organic);
  const attributedContacts = optionalRecord(status, contacts.attributedToBoost);
  const organicContacts = optionalRecord(status, contacts.organic);
  const periodRatios = record(status, raw.ratios);
  // Les deux parts (attribuée, organique) vont ensemble : l'une sans l'autre est une réponse invalide.
  if ((attributedOpens === null) !== (organicOpens === null) || (attributedContacts === null) !== (organicContacts === null)) throw fixedError(status, API_INVALID_RESPONSE);
  return {
    period: raw.period as StatsPeriodCode,
    since: raw.since as string | null,
    exposure: parseExposure(status, raw.exposure),
    opens: {
      total: statCount(status, opens.total),
      uniqueBuyers: statCount(status, opens.uniqueBuyers),
      attributedToBoost: attributedOpens === null ? null : { opens: statCount(status, attributedOpens.opens), uniqueBuyers: statCount(status, attributedOpens.uniqueBuyers) },
      organic: organicOpens === null ? null : { opens: statCount(status, organicOpens.opens), uniqueBuyers: statCount(status, organicOpens.uniqueBuyers) },
    },
    contacts: {
      uniqueBuyers: statCount(status, contacts.uniqueBuyers),
      reveals: statCount(status, contacts.reveals),
      attributedToBoost: attributedContacts === null ? null : { uniqueBuyers: statCount(status, attributedContacts.uniqueBuyers) },
      organic: organicContacts === null ? null : { uniqueBuyers: statCount(status, organicContacts.uniqueBuyers) },
    },
    ratios: {
      openRate: periodRatios.openRate === null ? null : statRatio(status, periodRatios.openRate),
      contactRate: statRatio(status, periodRatios.contactRate),
    },
  };
}

function parseBoostStatsEntry(status: number, value: unknown): BoostStatsEntry {
  const raw = record(status, value);
  const attributed = optionalRecord(status, raw.attributed);
  const ratios = record(status, raw.ratios);
  if (
    !isUuid(raw.boostId) ||
    !(BOOST_DURATION_CODES as readonly string[]).includes(String(raw.durationCode)) ||
    !BOOST_STATUSES.includes(String(raw.status)) ||
    !isIsoDate(raw.startsAt) ||
    !isIsoDate(raw.endsAt)
  ) {
    throw fixedError(status, API_INVALID_RESPONSE);
  }
  return {
    boostId: raw.boostId,
    durationCode: raw.durationCode as BoostDurationCode,
    status: raw.status as BoostStatsEntry["status"],
    startsAt: raw.startsAt,
    endsAt: raw.endsAt,
    exposure: parseExposure(status, raw.exposure),
    attributed: attributed === null
      ? null
      : {
          opens: statCount(status, attributed.opens),
          uniqueOpeners: statCount(status, attributed.uniqueOpeners),
          uniqueContacts: statCount(status, attributed.uniqueContacts),
          reveals: statCount(status, attributed.reveals),
        },
    ratios: {
      openRate: ratios.openRate === null ? null : statRatio(status, ratios.openRate),
      contactRate: ratios.contactRate === null ? null : statRatio(status, ratios.contactRate),
    },
  };
}

function parseOfferStats(status: number, value: unknown): OfferStats {
  const raw = record(status, value);
  const matches = record(status, raw.activeMatches);
  if (
    raw.contractVersion !== OFFER_STATS_CONTRACT_VERSION ||
    !isStatCount(matches.needs) ||
    !Array.isArray(raw.periods) ||
    !Array.isArray(raw.boosts)
  ) {
    throw fixedError(status, API_INVALID_RESPONSE);
  }
  const periods = raw.periods.map((entry) => parsePeriodStats(status, entry));
  if (periods.map((entry) => entry.period).join(",") !== STATS_PERIOD_CODES.join(",")) throw fixedError(status, API_INVALID_RESPONSE);
  return {
    activeMatches: { needs: toStatCount(matches.needs) },
    periods,
    boosts: raw.boosts.map((entry) => parseBoostStatsEntry(status, entry)),
  };
}

const E164 = /^\+[1-9][0-9]{1,14}$/;
const ATTRIBUTE_KEY_TEXT = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;

function parseOfferDetail(status: number, value: unknown): OfferDetail {
  const raw = record(status, value);
  const details = record(status, raw.details);
  if (
    raw.contractVersion !== OFFER_DETAIL_CONTRACT_VERSION ||
    !isIsoDate(raw.readAt) ||
    !isIsoDate(details.createdAt) ||
    !Array.isArray(details.attributes) ||
    details.attributes.length > 12
  ) {
    throw fixedError(status, API_INVALID_RESPONSE);
  }
  return {
    item: parseStoredMatch(status, raw.item),
    details: {
      createdAt: details.createdAt,
      attributes: details.attributes.map((entry): OfferPublicAttribute => {
        const attribute = record(status, entry);
        if (typeof attribute.key !== "string" || !ATTRIBUTE_KEY_TEXT.test(attribute.key) || typeof attribute.value !== "string" || attribute.value.length < 1 || attribute.value.length > 80) {
          throw fixedError(status, API_INVALID_RESPONSE);
        }
        return { key: attribute.key, value: attribute.value };
      }),
      ...(parsePhotoRefs(details.photos).length > 0 ? { photos: parsePhotoRefs(details.photos) } : {}),
    },
    readAt: raw.readAt,
  };
}

/** Contact : le numéro doit être E.164 et les deux liens EXACTEMENT ceux de ce numéro (jamais un lien arbitraire venu du serveur). */
function parseOfferContact(status: number, value: unknown): OfferContact {
  const raw = record(status, value);
  const contact = record(status, raw.contact);
  if (
    raw.contractVersion !== OFFER_CONTACT_CONTRACT_VERSION ||
    typeof contact.phone !== "string" ||
    !E164.test(contact.phone) ||
    contact.telUrl !== `tel:${contact.phone}` ||
    contact.whatsappUrl !== `https://wa.me/${contact.phone.slice(1)}` ||
    typeof contact.firstContact !== "boolean"
  ) {
    throw fixedError(status, API_INVALID_RESPONSE);
  }
  return { phone: contact.phone, telUrl: contact.telUrl, whatsappUrl: contact.whatsappUrl, firstContact: contact.firstContact };
}

// ─── Lecture stricte du portefeuille et des achats de boost ─────────────────────────────────────────

/** Entier sûr (|n| ≤ 2^53 − 1) : un montant ne passe JAMAIS par un flottant. */
function isSafeAmount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && value.length >= 10 && value.length <= 40 && Number.isFinite(Date.parse(value));
}

function isCursor(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 512;
}

function parseWalletTransaction(status: number, value: unknown): WalletTransaction {
  if (
    !isObject(value) ||
    !isUuid(value.id) ||
    typeof value.kind !== "string" ||
    value.kind.length < 1 ||
    value.kind.length > 64 ||
    !isSafeAmount(value.amountXof) ||
    // Lot PRO1 : absent chez un serveur plus ancien (nul) ; une ligne a au moins un montant non nul (crédits payés ou promotionnels).
    !(value.promoAmountXof === undefined || isSafeAmount(value.promoAmountXof)) ||
    (value.amountXof === 0 && (value.promoAmountXof === undefined || value.promoAmountXof === 0)) ||
    !isIsoDate(value.createdAt)
  ) {
    throw fixedError(status, API_INVALID_RESPONSE);
  }
  return {
    id: value.id,
    kind: (WALLET_TRANSACTION_KINDS as readonly string[]).includes(value.kind) ? (value.kind as WalletTransactionKind) : "unknown",
    amountXof: value.amountXof,
    promoAmountXof: value.promoAmountXof === undefined ? 0 : value.promoAmountXof,
    createdAt: value.createdAt,
  };
}

function parseWalletOverview(status: number, value: unknown): WalletOverview {
  if (
    !isObject(value) ||
    value.contractVersion !== WALLET_CONTRACT_VERSION ||
    !isSafeAmount(value.balanceXof) ||
    value.balanceXof < 0 ||
    !(value.promoBalanceXof === undefined || (isSafeAmount(value.promoBalanceXof) && value.promoBalanceXof >= 0)) ||
    !(value.promoExpiresAt === undefined || value.promoExpiresAt === null || isIsoDate(value.promoExpiresAt)) ||
    !(value.paymentMode === undefined || value.paymentMode === "none" || (PAYMENT_PROVIDERS as readonly string[]).includes(String(value.paymentMode))) ||
    !Array.isArray(value.transactions) ||
    !(value.nextCursor === null || isCursor(value.nextCursor))
  ) {
    throw fixedError(status, API_INVALID_RESPONSE);
  }
  return {
    paymentMode: value.paymentMode === undefined ? "fake" : (value.paymentMode as PaymentProviderName | "none"),
    balanceXof: value.balanceXof,
    promoBalanceXof: value.promoBalanceXof === undefined ? 0 : value.promoBalanceXof,
    promoExpiresAt: typeof value.promoExpiresAt === "string" ? value.promoExpiresAt : null,
    transactions: value.transactions.map((entry) => parseWalletTransaction(status, entry)),
    nextCursor: value.nextCursor,
  };
}

/** Lien de paiement externe accepté : https, sans identifiant, sans espace, 2 000 caractères au plus (jamais javascript:, data:, http:). */
export function isExternalCheckoutUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 2000 || /\s/.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.username === "" && url.password === "" && url.hostname !== "";
  } catch {
    return false;
  }
}

function parseTopup(status: number, value: unknown): WalletTopup {
  if (
    !isObject(value) ||
    !isUuid(value.id) ||
    !isSafeAmount(value.amountXof) ||
    value.amountXof <= 0 ||
    !(TOPUP_STATUSES as readonly string[]).includes(String(value.status)) ||
    !isIsoDate(value.expiresAt) ||
    typeof value.checkoutPath !== "string" ||
    value.checkoutPath.length > 200 ||
    !(value.provider === undefined || (PAYMENT_PROVIDERS as readonly string[]).includes(String(value.provider))) ||
    !(value.checkoutUrl === undefined || value.checkoutUrl === null || isExternalCheckoutUrl(value.checkoutUrl))
  ) {
    throw fixedError(status, API_INVALID_RESPONSE);
  }
  return {
    id: value.id,
    amountXof: value.amountXof,
    status: value.status as TopupStatus,
    expiresAt: value.expiresAt,
    checkoutPath: value.checkoutPath,
    provider: value.provider === undefined ? "fake" : (value.provider as PaymentProviderName),
    checkoutUrl: typeof value.checkoutUrl === "string" ? value.checkoutUrl : null,
  };
}

function parseBoostPurchaseCore(status: number, value: Record<string, unknown>): Omit<BoostPurchaseHistoryItem, "createdAt" | "refundedAt"> {
  if (
    !isUuid(value.id) ||
    !isUuid(value.quoteId) ||
    !(BOOST_DURATION_CODES as readonly string[]).includes(String(value.durationCode)) ||
    !isSafeAmount(value.amountXof) ||
    value.amountXof <= 0 ||
    !(value.promoAmountXof === undefined || (isSafeAmount(value.promoAmountXof) && value.promoAmountXof >= 0 && value.promoAmountXof <= value.amountXof)) ||
    !isIsoDate(value.startsAt) ||
    !isIsoDate(value.endsAt)
  ) {
    throw fixedError(status, API_INVALID_RESPONSE);
  }
  return {
    id: value.id,
    quoteId: value.quoteId,
    durationCode: value.durationCode as BoostDurationCode,
    amountXof: value.amountXof,
    promoAmountXof: value.promoAmountXof === undefined ? 0 : value.promoAmountXof,
    startsAt: value.startsAt,
    endsAt: value.endsAt,
  };
}

function parseBoostPurchase(status: number, value: unknown): BoostPurchase {
  if (!isObject(value) || typeof value.reused !== "boolean") throw fixedError(status, API_INVALID_RESPONSE);
  return { ...parseBoostPurchaseCore(status, value), reused: value.reused };
}

function parseBoostPurchaseHistoryItem(status: number, value: unknown): BoostPurchaseHistoryItem {
  if (!isObject(value) || !isIsoDate(value.createdAt) || !(value.refundedAt === null || isIsoDate(value.refundedAt))) {
    throw fixedError(status, API_INVALID_RESPONSE);
  }
  return { ...parseBoostPurchaseCore(status, value), createdAt: value.createdAt, refundedAt: value.refundedAt };
}

// ─── Lecture stricte des notifications, des préférences et du suivi ─────────────────────────────────

/** Texte d'une notification : sans caractère de contrôle ni de direction (le serveur le nettoie déjà ; lecture défensive). */
const UNSAFE_NOTIFICATION_TEXT = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

function parseNotificationItem(status: number, value: unknown): NotificationItem {
  if (
    !isObject(value) ||
    !isUuid(value.id) ||
    !(NOTIFICATION_KINDS as readonly string[]).includes(String(value.kind)) ||
    !isUuid(value.demandId) ||
    !isIsoDate(value.createdAt) ||
    !(value.readAt === null || isIsoDate(value.readAt)) ||
    typeof value.link !== "string"
  ) {
    throw fixedError(status, API_INVALID_RESPONSE);
  }
  const kind = value.kind as NotificationKind;
  let price: Money | null = null;
  if (value.price !== null) {
    if (
      !isObject(value.price) ||
      !isSafeAmount(value.price.amount) ||
      value.price.amount < 0 ||
      typeof value.price.currency !== "string" ||
      !/^[A-Z]{3}$/.test(value.price.currency)
    ) {
      throw fixedError(status, API_INVALID_RESPONSE);
    }
    price = { amount: value.price.amount, currency: value.price.currency };
  }
  if (kind === "new_match") {
    // Une annonce : titre, annonce et lien INTERNE exact ; jamais de résumé déguisé.
    if (
      typeof value.title !== "string" ||
      value.title.length < 1 ||
      value.title.length > 160 ||
      UNSAFE_NOTIFICATION_TEXT.test(value.title) ||
      !isUuid(value.offerId) ||
      value.count !== null ||
      value.link !== `/besoins/${value.demandId}/offres/${value.offerId}`
    ) {
      throw fixedError(status, API_INVALID_RESPONSE);
    }
    return { id: value.id, kind, title: value.title, price, count: null, demandId: value.demandId, offerId: value.offerId, link: value.link, createdAt: value.createdAt, readAt: value.readAt };
  }
  if (kind === "new_message") {
    // Un nouveau message : titre de l'annonce et lien INTERNE exact vers la conversation ; jamais de texte de message, de prix ni d'identité.
    if (
      typeof value.title !== "string" ||
      value.title.length < 1 ||
      value.title.length > 160 ||
      UNSAFE_NOTIFICATION_TEXT.test(value.title) ||
      value.price !== null ||
      value.offerId !== null ||
      value.count !== null ||
      !/^\/messages\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.link)
    ) {
      throw fixedError(status, API_INVALID_RESPONSE);
    }
    return { id: value.id, kind, title: value.title, price: null, count: null, demandId: value.demandId, offerId: null, link: value.link, createdAt: value.createdAt, readAt: value.readAt };
  }
  if (kind === "mission_coverage") {
    // Couverture d'une mission (lot MV1) : titre assemblé par le serveur, quantité couverte, lien INTERNE exact vers la mission ; jamais de budget ni de vendeur.
    if (
      typeof value.title !== "string" ||
      value.title.length < 1 ||
      value.title.length > 160 ||
      UNSAFE_NOTIFICATION_TEXT.test(value.title) ||
      value.price !== null ||
      value.offerId !== null ||
      typeof value.count !== "number" ||
      !Number.isSafeInteger(value.count) ||
      value.count < 1 ||
      !/^\/missions\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.link)
    ) {
      throw fixedError(status, API_INVALID_RESPONSE);
    }
    return { id: value.id, kind, title: value.title, price: null, count: value.count, demandId: value.demandId, offerId: null, link: value.link, createdAt: value.createdAt, readAt: value.readAt };
  }
  if (
    value.title !== null ||
    value.price !== null ||
    value.offerId !== null ||
    typeof value.count !== "number" ||
    !Number.isSafeInteger(value.count) ||
    value.count < 1 ||
    value.link !== `/besoins/${value.demandId}`
  ) {
    throw fixedError(status, API_INVALID_RESPONSE);
  }
  return { id: value.id, kind, title: null, price: null, count: value.count, demandId: value.demandId, offerId: null, link: value.link, createdAt: value.createdAt, readAt: value.readAt };
}

function parseNotificationsPage(status: number, value: unknown): NotificationsPage {
  if (
    !isObject(value) ||
    value.contractVersion !== NOTIFICATIONS_CONTRACT_VERSION ||
    !Array.isArray(value.items) ||
    !(value.nextCursor === null || isCursor(value.nextCursor)) ||
    !isSafeAmount(value.unreadCount) ||
    value.unreadCount < 0
  ) {
    throw fixedError(status, API_INVALID_RESPONSE);
  }
  return {
    items: value.items.map((item) => parseNotificationItem(status, item)),
    nextCursor: value.nextCursor,
    unreadCount: value.unreadCount,
  };
}

function parseMarkReadResult(status: number, value: unknown): MarkReadResult {
  if (
    !isObject(value) ||
    value.contractVersion !== NOTIFICATIONS_CONTRACT_VERSION ||
    !isSafeAmount(value.marked) ||
    value.marked < 0 ||
    !isSafeAmount(value.unreadCount) ||
    value.unreadCount < 0
  ) {
    throw fixedError(status, API_INVALID_RESPONSE);
  }
  return { marked: value.marked, unreadCount: value.unreadCount };
}

function parseNotificationPreferences(status: number, value: unknown): NotificationPreferences {
  if (
    !isObject(value) ||
    value.contractVersion !== NOTIFICATION_PREFERENCES_CONTRACT_VERSION ||
    !isObject(value.preferences) ||
    typeof value.preferences.externalEnabled !== "boolean" ||
    !isObject(value.external) ||
    typeof value.external.available !== "boolean" ||
    typeof value.external.notice !== "string" ||
    value.external.notice.length < 1 ||
    value.external.notice.length > 300
  ) {
    throw fixedError(status, API_INVALID_RESPONSE);
  }
  return {
    externalEnabled: value.preferences.externalEnabled,
    externalAvailable: value.external.available,
    notice: value.external.notice,
    ...(value.external.real === true ? { real: true } : {}),
  };
}

function parseDemandTracking(status: number, value: unknown): DemandTracking {
  if (!isObject(value) || value.contractVersion !== DEMAND_TRACKING_CONTRACT_VERSION || !isObject(value.tracking)) {
    throw fixedError(status, API_INVALID_RESPONSE);
  }
  const tracking = value.tracking;
  if (
    !isUuid(tracking.demandId) ||
    !DEMAND_STATUSES.includes(String(tracking.demandStatus)) ||
    !isIsoDate(tracking.until) ||
    typeof tracking.paused !== "boolean" ||
    typeof tracking.active !== "boolean" ||
    !isIsoDate(tracking.maxUntil) ||
    !isIsoDate(tracking.readAt)
  ) {
    throw fixedError(status, API_INVALID_RESPONSE);
  }
  return {
    demandId: tracking.demandId,
    demandStatus: tracking.demandStatus as DemandStatus,
    until: tracking.until,
    paused: tracking.paused,
    active: tracking.active,
    maxUntil: tracking.maxUntil,
    readAt: tracking.readAt,
  };
}

// ─── Lecture stricte des accueils (lot D1) ──────────────────────────────────────────────────────────

const HOME_TEXT_MAX = 200;
const NOTIFICATION_LINK = /^\/(besoins\/[0-9a-f-]{36}(\/offres\/[0-9a-f-]{36})?|messages\/[0-9a-f-]{36}|missions\/[0-9a-f-]{36})$/i;

function homeText(status: number, value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.length > HOME_TEXT_MAX || UNSAFE_NOTIFICATION_TEXT.test(value)) throw fixedError(status, API_INVALID_RESPONSE);
  return value;
}

function homeTitle(status: number, value: unknown): string {
  const text = homeText(status, value);
  if (text === null || text.trim() === "") throw fixedError(status, API_INVALID_RESPONSE);
  return text;
}

function homeMoney(status: number, value: unknown): Money | null {
  if (value === null) return null;
  if (!isObject(value) || !isSafeAmount(value.amount) || value.amount < 0 || typeof value.currency !== "string" || !/^[A-Z]{3}$/.test(value.currency)) {
    throw fixedError(status, API_INVALID_RESPONSE);
  }
  return { amount: value.amount, currency: value.currency };
}

function parseBuyerHome(status: number, value: unknown): BuyerHome {
  if (
    !isObject(value) ||
    value.contractVersion !== BUYER_HOME_CONTRACT_VERSION ||
    !isSafeAmount(value.activeDemandCount) ||
    !Array.isArray(value.demands) ||
    !isSafeAmount(value.unreadNotifications) ||
    !Array.isArray(value.notifications)
  ) {
    throw fixedError(status, API_INVALID_RESPONSE);
  }
  const demands = value.demands.map((entry): BuyerHomeDemand => {
    if (!isObject(entry) || !isUuid(entry.id) || !isSafeAmount(entry.matchCount) || entry.matchCount < 0 || !isIsoDate(entry.createdAt)) throw fixedError(status, API_INVALID_RESPONSE);
    return {
      id: entry.id,
      title: homeTitle(status, entry.title),
      category: homeText(status, entry.category),
      brand: homeText(status, entry.brand),
      model: homeText(status, entry.model),
      variant: homeText(status, entry.variant),
      location: homeText(status, entry.location),
      budget: homeMoney(status, entry.budget),
      matchCount: entry.matchCount,
      createdAt: entry.createdAt,
    };
  });
  const notifications = value.notifications.map((entry): BuyerHomeNotification => {
    if (
      !isObject(entry) ||
      !isUuid(entry.id) ||
      !(NOTIFICATION_KINDS as readonly string[]).includes(String(entry.kind)) ||
      typeof entry.link !== "string" ||
      !NOTIFICATION_LINK.test(entry.link) ||
      !isIsoDate(entry.createdAt) ||
      typeof entry.unread !== "boolean" ||
      !(entry.count === null || (isSafeAmount(entry.count) && entry.count >= 1))
    ) {
      throw fixedError(status, API_INVALID_RESPONSE);
    }
    return {
      id: entry.id,
      kind: entry.kind as NotificationKind,
      title: homeText(status, entry.title),
      price: homeMoney(status, entry.price),
      count: entry.count,
      link: entry.link,
      createdAt: entry.createdAt,
      unread: entry.unread,
    };
  });
  return { activeDemandCount: value.activeDemandCount, demands, unreadNotifications: value.unreadNotifications, notifications };
}

function parseVendorHome(status: number, value: unknown): VendorHome {
  if (
    !isObject(value) ||
    value.contractVersion !== VENDOR_HOME_CONTRACT_VERSION ||
    !isObject(value.counts) ||
    !isSafeAmount(value.counts.published) ||
    !isSafeAmount(value.counts.paused) ||
    !isSafeAmount(value.counts.draft) ||
    !isStatCount(value.needs) ||
    !isSafeAmount(value.balance) ||
    !Array.isArray(value.activeBoosts) ||
    !Array.isArray(value.offers)
  ) {
    throw fixedError(status, API_INVALID_RESPONSE);
  }
  const offers = value.offers.map((entry): VendorHomeOffer => {
    if (
      !isObject(entry) ||
      !isUuid(entry.id) ||
      !["draft", "published", "paused"].includes(String(entry.status)) ||
      !isStatCount(entry.needs) ||
      !(entry.boostEndsAt === null || isIsoDate(entry.boostEndsAt))
    ) {
      throw fixedError(status, API_INVALID_RESPONSE);
    }
    return {
      id: entry.id,
      title: homeTitle(status, entry.title),
      status: entry.status as VendorOfferStatus,
      category: homeText(status, entry.category),
      brand: homeText(status, entry.brand),
      model: homeText(status, entry.model),
      variant: homeText(status, entry.variant),
      price: homeMoney(status, entry.price),
      needs: toStatCount(entry.needs),
      boostEndsAt: entry.boostEndsAt,
      ...coverField(entry.coverPhotoId),
    };
  });
  const activeBoosts = value.activeBoosts.map((entry) => {
    if (!isObject(entry) || !isUuid(entry.offerId) || !isIsoDate(entry.endsAt)) throw fixedError(status, API_INVALID_RESPONSE);
    return { offerId: entry.offerId, endsAt: entry.endsAt };
  });
  return {
    counts: { published: value.counts.published, paused: value.counts.paused, draft: value.counts.draft },
    needs: toStatCount(value.needs),
    balance: value.balance,
    activeBoosts,
    offers,
  };
}

export interface RequestOptions {
  signal?: AbortSignal;
}

export interface ApiClientOptions {
  /** fetch injecté (tests) ; par défaut le fetch global, résolu à chaque appel. */
  fetch?: typeof fetch;
}

/** Taille de page maximale acceptée par le serveur et garde-fou de `listAll`. */
export const PAGE_LIMIT = 100;
export const LIST_ALL_MAX_PAGES = 20;

/** Résultat de `listAll` : `truncated` vaut true si le plafond de pages est atteint et qu'il reste des éléments. */
export interface ListAllResult<T> {
  items: T[];
  truncated: boolean;
}

/** Pagination de `listAll` : pages pleines jusqu'à la première page incomplète, plafond signalé et jamais silencieux. */
async function collectAll<T>(fetchPage: (pagination: Pagination) => Promise<T[]>): Promise<ListAllResult<T>> {
  const items: T[] = [];
  for (let pageIndex = 0; pageIndex < LIST_ALL_MAX_PAGES; pageIndex += 1) {
    const rows = await fetchPage({ limit: PAGE_LIMIT, offset: pageIndex * PAGE_LIMIT });
    items.push(...rows);
    if (rows.length < PAGE_LIMIT) return { items, truncated: false };
  }
  const probe = await fetchPage({ limit: 1, offset: LIST_ALL_MAX_PAGES * PAGE_LIMIT });
  return { items, truncated: probe.length > 0 };
}

export function createApiClient(options: ApiClientOptions = {}) {
  async function send(
    method: "GET" | "POST" | "PATCH" | "PUT",
    path: string,
    body?: unknown,
    requestOptions: RequestOptions = {},
  ): Promise<{ status: number; json: unknown; serverTime: number | null }> {
    const headers: Record<string, string> = { Accept: "application/json" };
    const init: RequestInit = {
      method,
      headers,
      credentials: "same-origin",
      cache: "no-store",
      signal: requestOptions.signal,
    };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }

    let response: Response;
    try {
      response = await (options.fetch ?? fetch)(path, init);
    } catch {
      // Le texte de l'exception (hôte, port, pile…) n'est jamais repris.
      throw fixedError(0, requestOptions.signal?.aborted ? API_ABORTED : API_NETWORK_ERROR);
    }

    let json: unknown = undefined;
    if (response.status !== 204) {
      try {
        json = await response.json();
      } catch {
        json = undefined;
      }
    }
    if (!response.ok) throw errorFromBody(response.status, json);
    return { status: response.status, json, serverTime: serverTimeFromDateHeader(response.headers?.get?.("date")) };
  }

  /** Identifiant placé dans une URL : UUID uniquement, sinon `invalid_id` SANS requête (aucun chemin construit à la main). */
  function id(value: string): string {
    if (!isUuid(value)) throw fixedError(0, API_INVALID_ID);
    return value;
  }

  function page(pagination?: Partial<Pagination>): string {
    if (!pagination) return "";
    const query = new URLSearchParams();
    if (pagination.limit !== undefined) query.set("limit", String(pagination.limit));
    if (pagination.offset !== undefined) query.set("offset", String(pagination.offset));
    const text = query.toString();
    return text ? `?${text}` : "";
  }

  async function offerResult(call: Promise<{ status: number; json: unknown }>): Promise<OfferRecord> {
    const { status, json } = await call;
    if (!isObject(json)) throw fixedError(status, API_INVALID_RESPONSE);
    return parseOffer(status, json.offer);
  }

  async function demandResult(call: Promise<{ status: number; json: unknown }>): Promise<DemandRecord> {
    const { status, json } = await call;
    if (!isObject(json)) throw fixedError(status, API_INVALID_RESPONSE);
    return parseDemand(status, json.demand);
  }

  const versionBody = (expectedContentVersion: number) => ({ expectedContentVersion });

  /** Paramètres de lecture des correspondances : valeurs vérifiées AVANT toute requête (sinon `invalid_argument`). */
  function matchesQuery(query: StoredMatchesQuery): string {
    const params = new URLSearchParams();
    if (query.sort !== undefined) {
      if (query.sort !== "score" && query.sort !== "relevance") throw fixedError(0, API_INVALID_ARGUMENT);
      params.set("sort", query.sort);
    }
    if (query.cursor !== undefined) {
      if (typeof query.cursor !== "string" || query.cursor.length === 0 || query.cursor.length > 512) {
        throw fixedError(0, API_INVALID_ARGUMENT);
      }
      params.set("cursor", query.cursor);
    }
    if (query.limit !== undefined) {
      if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > PAGE_LIMIT) throw fixedError(0, API_INVALID_ARGUMENT);
      params.set("limit", String(query.limit));
    }
    const text = params.toString();
    return text ? `?${text}` : "";
  }

  async function storedMatches(
    kind: "offers" | "demands",
    sourceId: string,
    query: StoredMatchesQuery = {},
    requestOptions?: RequestOptions,
  ): Promise<StoredMatchesPage> {
    // Les contrôles (identifiant puis paramètres) précèdent toute requête.
    const path = `/api/${kind}/${id(sourceId)}/stored-matches${matchesQuery(query)}`;
    const { status, json } = await send("GET", path, undefined, requestOptions);
    return parseStoredMatchesPage(status, json);
  }

  /**
   * GET /api/auth/session (lot D3) : 200 `{ authenticated: true, userId, isAdmin }` ou 200 `{ authenticated: false }` (le visiteur anonyme ne provoque aucun 401). Une réponse 401 (ancien
   * serveur) est lue comme « anonyme ». Le résultat est `{ userId, isAdmin }` ; sans session, une ApiError 401 est levée par le client (comme avant le lot D3).
   */
  async function sessionRead(requestOptions?: RequestOptions): Promise<{ authenticated: false } | { authenticated: true; userId: string; isAdmin: boolean }> {
    let reply: { status: number; json: unknown };
    try {
      reply = await send("GET", "/api/auth/session", undefined, requestOptions);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) return { authenticated: false };
      throw error;
    }
    const { status, json } = reply;
    if (!isObject(json)) throw fixedError(status, API_INVALID_RESPONSE);
    if (json.authenticated === false) return { authenticated: false };
    if (json.authenticated !== true || typeof json.userId !== "string" || typeof json.isAdmin !== "boolean") throw fixedError(status, API_INVALID_RESPONSE);
    return { authenticated: true, userId: json.userId, isAdmin: json.isAdmin };
  }

  async function session(requestOptions?: RequestOptions): Promise<{ userId: string; isAdmin: boolean }> {
    const read = await sessionRead(requestOptions);
    if (!read.authenticated) throw new ApiError(401, "authentication_required", "Authentification requise.");
    return { userId: read.userId, isAdmin: read.isAdmin };
  }

  async function listOffers(pagination?: Partial<Pagination>, requestOptions?: RequestOptions) {
    const { status, json } = await send("GET", `/api/offers${page(pagination)}`, undefined, requestOptions);
    if (!isObject(json) || !Array.isArray(json.offers)) throw fixedError(status, API_INVALID_RESPONSE);
    return {
      offers: json.offers.map((offer) => parseOffer(status, offer)),
      pagination: parsePagination(status, json.pagination),
    };
  }

  async function listDemands(pagination?: Partial<Pagination>, requestOptions?: RequestOptions) {
    const { status, json } = await send("GET", `/api/demands${page(pagination)}`, undefined, requestOptions);
    if (!isObject(json) || !Array.isArray(json.demands)) throw fixedError(status, API_INVALID_RESPONSE);
    return {
      demands: json.demands.map((demand) => parseDemand(status, demand)),
      pagination: parsePagination(status, json.pagination),
    };
  }

  /** Événement du prestataire FICTIF pour une recharge de l'utilisateur (routes de développement, corps vide). */
  async function fakePayment(
    action: "confirm" | "fail",
    topupId: string,
    requestOptions?: RequestOptions,
  ): Promise<FakePaymentResult> {
    const { status, json } = await send("POST", `/api/dev/fake-payments/${id(topupId)}/${action}`, undefined, requestOptions);
    if (
      !isObject(json) ||
      json.contractVersion !== WALLET_CONTRACT_VERSION ||
      !(FAKE_PAYMENT_OUTCOMES as readonly string[]).includes(String(json.outcome))
    ) {
      throw fixedError(status, API_INVALID_RESPONSE);
    }
    return { outcome: json.outcome as FakePaymentOutcome, topup: parseTopup(status, json.topup) };
  }

  return {
    auth: {
      /** POST /api/auth/otp/request : `{ phone }` canonique (+…) → 202. */
      async requestOtp(phone: string, requestOptions?: RequestOptions): Promise<OtpChallenge> {
        const { status, json } = await send("POST", "/api/auth/otp/request", { phone }, requestOptions);
        if (
          !isObject(json) ||
          typeof json.challengeId !== "string" ||
          typeof json.expiresAt !== "string" ||
          typeof json.resendAvailableAt !== "string"
        ) {
          throw fixedError(status, API_INVALID_RESPONSE);
        }
        return {
          challengeId: json.challengeId,
          expiresAt: json.expiresAt,
          resendAvailableAt: json.resendAvailableAt,
        };
      },

      /** POST /api/auth/otp/verify : `{ challengeId, code }` → 200 `{ userId }` + cookie HttpOnly `noma_auth`. */
      async verifyOtp(challengeId: string, code: string, requestOptions?: RequestOptions): Promise<{ userId: string }> {
        const { status, json } = await send("POST", "/api/auth/otp/verify", { challengeId, code }, requestOptions);
        if (!isObject(json) || typeof json.userId !== "string") throw fixedError(status, API_INVALID_RESPONSE);
        return { userId: json.userId };
      },

      /** GET /api/auth/session → `{ userId, isAdmin }` ; sans session valide, une ApiError 401 est levée (le serveur répond 200 `{ authenticated: false }`). */
      session,

      /**
       * Résultat de session sans exception : session valide → authenticated (avec `isAdmin`), `{ authenticated: false }` (ou 401 d'un ancien serveur) → anonymous, tout le reste
       * (503, panne réseau, réponse inattendue) → unavailable. Sert la garde de session des écrans et le sélecteur d'espace.
       */
      async sessionOutcome(requestOptions?: RequestOptions): Promise<SessionOutcome> {
        try {
          const read = await sessionRead(requestOptions);
          return read.authenticated ? { kind: "authenticated", userId: read.userId, isAdmin: read.isAdmin } : { kind: "anonymous" };
        } catch (error) {
          if (error instanceof ApiError && error.code === API_ABORTED) throw error;
          return { kind: "unavailable" };
        }
      },

      /** POST /api/auth/logout (sans corps) → 204 ; idempotent. */
      async logout(requestOptions?: RequestOptions): Promise<void> {
        await send("POST", "/api/auth/logout", undefined, requestOptions);
      },
    },

    offers: {
      /** GET /api/offers?limit&offset → `{ offers, pagination }` (tri serveur : création croissante). */
      list: listOffers,

      /**
       * Toutes les offres du vendeur, page par page (100 au plus par requête, 20 pages au plus). Au-delà du plafond,
       * une requête de contrôle (1 élément) dit s'il en reste : le résultat est alors marqué `truncated`, jamais
       * tronqué en silence.
       */
      async listAll(requestOptions?: RequestOptions): Promise<ListAllResult<OfferRecord>> {
        return collectAll(async (pagination) => (await listOffers(pagination, requestOptions)).offers);
      },

      /**
       * GET /api/offers/{id}/stored-matches : les besoins d'acheteurs compatibles avec CETTE offre (404 si l'offre est
       * inconnue ou à un autre compte ; 400 si elle n'est pas en ligne). Aucune identité d'acheteur dans la réponse.
       */
      storedMatches(offerId: string, query?: StoredMatchesQuery, requestOptions?: RequestOptions): Promise<StoredMatchesPage> {
        return storedMatches("offers", offerId, query, requestOptions);
      },

      /**
       * GET /api/offers/{id}/stats : ce que produit l'annonce pour son vendeur (404 si l'annonce est inconnue OU à un autre compte). Aucune identité
       * d'acheteur ; aucun compte exact n'est publié (`{ kind: "below", bound: 5 }` ou `{ kind: "approx", value }`).
       */
      async stats(offerId: string, requestOptions?: RequestOptions): Promise<OfferStats> {
        const { status, json } = await send("GET", `/api/offers/${id(offerId)}/stats`, undefined, requestOptions);
        return parseOfferStats(status, json);
      },

      /** POST /api/offers → 201 `{ offer }` (statut brouillon). */
      create(input: OfferInput, requestOptions?: RequestOptions): Promise<OfferRecord> {
        return offerResult(send("POST", "/api/offers", input, requestOptions));
      },

      /** GET /api/offers/{id} → `{ offer }` ; 404 si inconnue OU appartenant à un autre compte. */
      async get(offerId: string, requestOptions?: RequestOptions): Promise<OfferRecord> {
        return offerResult(send("GET", `/api/offers/${id(offerId)}`, undefined, requestOptions));
      },

      /** PATCH /api/offers/{id} : `{ expectedContentVersion, …champs }` (au moins un champ). */
      async update(
        offerId: string,
        expectedContentVersion: number,
        changes: OfferChanges,
        requestOptions?: RequestOptions,
      ): Promise<OfferRecord> {
        return offerResult(
          send("PATCH", `/api/offers/${id(offerId)}`, { expectedContentVersion, ...changes }, requestOptions),
        );
      },

      /** POST /api/offers/{id}/publish : brouillon ou pause → en ligne. */
      async publish(offerId: string, expectedContentVersion: number, requestOptions?: RequestOptions): Promise<OfferRecord> {
        return offerResult(
          send("POST", `/api/offers/${id(offerId)}/publish`, versionBody(expectedContentVersion), requestOptions),
        );
      },

      /** POST /api/offers/{id}/pause : en ligne → en pause. */
      async pause(offerId: string, expectedContentVersion: number, requestOptions?: RequestOptions): Promise<OfferRecord> {
        return offerResult(
          send("POST", `/api/offers/${id(offerId)}/pause`, versionBody(expectedContentVersion), requestOptions),
        );
      },

      /** POST /api/offers/{id}/archive : tout statut non archivé → archivée (définitif). */
      async archive(offerId: string, expectedContentVersion: number, requestOptions?: RequestOptions): Promise<OfferRecord> {
        return offerResult(
          send("POST", `/api/offers/${id(offerId)}/archive`, versionBody(expectedContentVersion), requestOptions),
        );
      },
    },

    demands: {
      /** GET /api/demands?limit&offset → `{ demands, pagination }`. */
      list: listDemands,

      /** Tous les besoins de l'acheteur (mêmes règles que `offers.listAll`, troncature signalée). */
      async listAll(requestOptions?: RequestOptions): Promise<ListAllResult<DemandRecord>> {
        return collectAll(async (pagination) => (await listDemands(pagination, requestOptions)).demands);
      },

      /** POST /api/demands → 201 `{ demand }` (statut brouillon). */
      create(input: DemandInput, requestOptions?: RequestOptions): Promise<DemandRecord> {
        return demandResult(send("POST", "/api/demands", input, requestOptions));
      },

      /**
       * GET /api/demands/{id}/stored-matches : les offres compatibles avec CE besoin (404 si le besoin est inconnu ou à un
       * autre compte ; 400 s'il n'est pas actif). `sort=relevance` applique, le cas échéant, la mise en avant (`sponsored`).
       */
      storedMatches(demandId: string, query?: StoredMatchesQuery, requestOptions?: RequestOptions): Promise<StoredMatchesPage> {
        return storedMatches("demands", demandId, query, requestOptions);
      },

      async get(demandId: string, requestOptions?: RequestOptions): Promise<DemandRecord> {
        return demandResult(send("GET", `/api/demands/${id(demandId)}`, undefined, requestOptions));
      },

      /**
       * GET /api/demands/{id}/offers/{offerId} : la fiche d'UNE annonce des correspondances de ce besoin (404 identique pour tout accès refusé :
       * besoin d'un autre, besoin clos, annonce hors correspondances). La lecture réussie est comptée côté serveur comme une ouverture.
       */
      async offer(demandId: string, offerId: string, requestOptions?: RequestOptions): Promise<OfferDetail> {
        const { status, json } = await send("GET", `/api/demands/${id(demandId)}/offers/${id(offerId)}`, undefined, requestOptions);
        return parseOfferDetail(status, json);
      },

      /**
       * POST /api/demands/{id}/offers/{offerId}/contact (sans corps) : le numéro vérifié du vendeur et ses liens `tel:` et WhatsApp. 404 (accès refusé),
       * 409 `offer_not_available` (en pause, retirée ou vendue : rien n'est révélé), 429 (20 vendeurs distincts par jour).
       */
      async contactOffer(demandId: string, offerId: string, requestOptions?: RequestOptions): Promise<OfferContact> {
        const { status, json } = await send("POST", `/api/demands/${id(demandId)}/offers/${id(offerId)}/contact`, undefined, requestOptions);
        return parseOfferContact(status, json);
      },

      /**
       * GET /api/demands/{id}/tracking : le suivi de CE besoin (404 identique si le besoin est inconnu ou à un autre compte). Le matching continue pendant une
       * pause ou après la fin du suivi ; seules les notifications s'arrêtent.
       */
      async tracking(demandId: string, requestOptions?: RequestOptions): Promise<DemandTracking> {
        const { status, json } = await send("GET", `/api/demands/${id(demandId)}/tracking`, undefined, requestOptions);
        return parseDemandTracking(status, json);
      },

      /** POST /api/demands/{id}/tracking `{ action }` : prolonger de 30 jours (plafonné à 90 jours à partir de maintenant), mettre en pause, reprendre. 409 si le besoin n'est pas actif. */
      async trackingAction(demandId: string, action: TrackingAction, requestOptions?: RequestOptions): Promise<DemandTracking> {
        const path = `/api/demands/${id(demandId)}/tracking`;
        if (!(TRACKING_ACTIONS as readonly string[]).includes(action)) throw fixedError(0, API_INVALID_ARGUMENT);
        const { status, json } = await send("POST", path, { action }, requestOptions);
        return parseDemandTracking(status, json);
      },

      /** POST /api/demands/{id}/activate : brouillon ou satisfait → actif. */
      async activate(demandId: string, expectedContentVersion: number, requestOptions?: RequestOptions): Promise<DemandRecord> {
        return demandResult(
          send("POST", `/api/demands/${id(demandId)}/activate`, versionBody(expectedContentVersion), requestOptions),
        );
      },

      /** POST /api/demands/{id}/archive. */
      async archive(demandId: string, expectedContentVersion: number, requestOptions?: RequestOptions): Promise<DemandRecord> {
        return demandResult(
          send("POST", `/api/demands/${id(demandId)}/archive`, versionBody(expectedContentVersion), requestOptions),
        );
      },

      /** POST /api/demands/{id}/satisfy : actif → satisfait. */
      async satisfy(demandId: string, expectedContentVersion: number, requestOptions?: RequestOptions): Promise<DemandRecord> {
        return demandResult(
          send("POST", `/api/demands/${id(demandId)}/satisfy`, versionBody(expectedContentVersion), requestOptions),
        );
      },
    },

    home: {
      /** GET /api/home/buyer : besoins actifs de l'acheteur (avec leur nombre de correspondances) et ses notifications. */
      async buyer(requestOptions?: RequestOptions): Promise<BuyerHome> {
        const { status, json } = await send("GET", "/api/home/buyer", undefined, requestOptions);
        return parseBuyerHome(status, json);
      },
      /** GET /api/home/vendor : annonces du vendeur par statut, besoins correspondants (arrondis), solde et boosts actifs. */
      async vendor(requestOptions?: RequestOptions): Promise<VendorHome> {
        const { status, json } = await send("GET", "/api/home/vendor", undefined, requestOptions);
        return parseVendorHome(status, json);
      },
    },

    notifications: {
      /**
       * GET /api/notifications : les notifications de l'utilisateur (plus récentes d'abord, curseur) et le nombre TOTAL de non-lues. `limit` (1 à 50) et `cursor`
       * (1 à 512 caractères) sont vérifiés AVANT la requête (`invalid_argument`).
       */
      async list(query: NotificationsQuery = {}, requestOptions?: RequestOptions): Promise<NotificationsPage> {
        const params = new URLSearchParams();
        if (query.limit !== undefined) {
          if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > 50) throw fixedError(0, API_INVALID_ARGUMENT);
          params.set("limit", String(query.limit));
        }
        if (query.cursor !== undefined) {
          if (!isCursor(query.cursor)) throw fixedError(0, API_INVALID_ARGUMENT);
          params.set("cursor", query.cursor);
        }
        const text = params.toString();
        const { status, json } = await send("GET", `/api/notifications${text ? `?${text}` : ""}`, undefined, requestOptions);
        return parseNotificationsPage(status, json);
      },

      /** POST /api/notifications/read `{ ids }` : marque ces notifications (1 à 100 UUID, toutes à vous, sinon 404 et aucune n'est touchée). */
      async markRead(ids: readonly string[], requestOptions?: RequestOptions): Promise<MarkReadResult> {
        if (!Array.isArray(ids) || ids.length < 1 || ids.length > 100 || ids.some((entry) => !isUuid(entry))) throw fixedError(0, API_INVALID_ARGUMENT);
        const { status, json } = await send("POST", "/api/notifications/read", { ids: [...ids] }, requestOptions);
        return parseMarkReadResult(status, json);
      },

      /**
       * POST /api/notifications/read `{ all: true, upTo }` : marque comme lues les notifications créées avant ou à `upTo` (la date de la plus récente notification AFFICHÉE,
       * `YYYY-MM-DDTHH:MM:SS.mmmZ`, vérifiée AVANT la requête : `invalid_argument`). Celles arrivées après le chargement de l'écran restent non lues.
       */
      async markAllRead(upTo: string, requestOptions?: RequestOptions): Promise<MarkReadResult> {
        if (typeof upTo !== "string" || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/.test(upTo) || !Number.isFinite(Date.parse(upTo))) {
          throw fixedError(0, API_INVALID_ARGUMENT);
        }
        const { status, json } = await send("POST", "/api/notifications/read", { all: true, upTo }, requestOptions);
        return parseMarkReadResult(status, json);
      },

      /** GET /api/notifications/preferences : l'envoi externe simulé (désactivé par défaut) et le texte fixe « pas encore disponible ». */
      async preferences(requestOptions?: RequestOptions): Promise<NotificationPreferences> {
        const { status, json } = await send("GET", "/api/notifications/preferences", undefined, requestOptions);
        return parseNotificationPreferences(status, json);
      },

      /** PUT /api/notifications/preferences `{ externalEnabled }` : active ou désactive l'envoi externe simulé. */
      async setPreferences(externalEnabled: boolean, requestOptions?: RequestOptions): Promise<NotificationPreferences> {
        if (typeof externalEnabled !== "boolean") throw fixedError(0, API_INVALID_ARGUMENT);
        const { status, json } = await send("PUT", "/api/notifications/preferences", { externalEnabled }, requestOptions);
        return parseNotificationPreferences(status, json);
      },
    },

    boostQuotes: {
      /**
       * POST /api/offers/{id}/boost-quotes `{ durationCode }` : demande une cotation (201 créée, 200 réutilisée tant qu'elle est
       * valable). Une cotation INDISPONIBLE est un succès (`status: "unavailable"` et son motif), jamais une erreur HTTP.
       * Aucun paiement : une cotation n'engage à rien.
       */
      async create(offerId: string, durationCode: BoostDurationCode, requestOptions?: RequestOptions): Promise<BoostQuote> {
        const path = `/api/offers/${id(offerId)}/boost-quotes`;
        if (!(BOOST_DURATION_CODES as readonly string[]).includes(durationCode)) throw fixedError(0, API_INVALID_ARGUMENT);
        const { status, json, serverTime } = await send("POST", path, { durationCode }, requestOptions);
        if (!isObject(json) || json.contractVersion !== BOOST_QUOTE_CONTRACT_VERSION) throw fixedError(status, API_INVALID_RESPONSE);
        return parseBoostQuote(status, json.quote, "reused", serverTime);
      },

      /** GET /api/offers/{id}/boost-quotes?limit : l'historique des cotations de l'offre, plus récentes d'abord (1 à 50). */
      async list(offerId: string, query: { limit?: number } = {}, requestOptions?: RequestOptions): Promise<BoostQuote[]> {
        const base = `/api/offers/${id(offerId)}/boost-quotes`;
        let path = base;
        if (query.limit !== undefined) {
          if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > 50) throw fixedError(0, API_INVALID_ARGUMENT);
          path = `${base}?limit=${query.limit}`;
        }
        const { status, json, serverTime } = await send("GET", path, undefined, requestOptions);
        if (!isObject(json) || json.contractVersion !== BOOST_QUOTE_CONTRACT_VERSION || !Array.isArray(json.quotes)) {
          throw fixedError(status, API_INVALID_RESPONSE);
        }
        return json.quotes.map((quote) => parseBoostQuote(status, quote, "expired", serverTime));
      },
    },

    wallet: {
      /**
       * GET /api/wallet : solde et historique (du plus récent au plus ancien, 20 par page par défaut). `cursor` (1 à 512
       * caractères) et `limit` (1 à 50) sont vérifiés AVANT la requête (`invalid_argument`, statut 0).
       */
      async overview(query: WalletOverviewQuery = {}, requestOptions?: RequestOptions): Promise<WalletOverview> {
        const params = new URLSearchParams();
        if (query.limit !== undefined) {
          if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > 50) throw fixedError(0, API_INVALID_ARGUMENT);
          params.set("limit", String(query.limit));
        }
        if (query.cursor !== undefined) {
          if (!isCursor(query.cursor)) throw fixedError(0, API_INVALID_ARGUMENT);
          params.set("cursor", query.cursor);
        }
        const text = params.toString();
        const { status, json } = await send("GET", `/api/wallet${text ? `?${text}` : ""}`, undefined, requestOptions);
        return parseWalletOverview(status, json);
      },

      /**
       * POST /api/wallet/topups `{ amountXof, idempotencyKey }` : crée l'intention de recharge (201) ou retrouve celle de la même
       * clé et du même montant (200, `reused`). Le montant est un entier sûr strictement positif : tout autre nombre est refusé
       * AVANT la requête (`invalid_argument`).
       */
      async createTopup(
        request: TopupRequest,
        requestOptions?: RequestOptions,
      ): Promise<{ topup: WalletTopup; reused: boolean }> {
        if (!isSafeAmount(request?.amountXof) || request.amountXof <= 0 || !isUuid(request.idempotencyKey)) {
          throw fixedError(0, API_INVALID_ARGUMENT);
        }
        const { status, json } = await send(
          "POST",
          "/api/wallet/topups",
          { amountXof: request.amountXof, idempotencyKey: request.idempotencyKey },
          requestOptions,
        );
        if (!isObject(json) || json.contractVersion !== WALLET_CONTRACT_VERSION) throw fixedError(status, API_INVALID_RESPONSE);
        return { topup: parseTopup(status, json.topup), reused: status === 200 };
      },

      /** GET /api/wallet/topups/{id} : état d'une recharge de l'utilisateur (404 si inconnue ou à un autre compte). */
      async topup(topupId: string, requestOptions?: RequestOptions): Promise<WalletTopup> {
        const { status, json } = await send("GET", `/api/wallet/topups/${id(topupId)}`, undefined, requestOptions);
        if (!isObject(json) || json.contractVersion !== WALLET_CONTRACT_VERSION) throw fixedError(status, API_INVALID_RESPONSE);
        return parseTopup(status, json.topup);
      },
    },

    devPayments: {
      /**
       * POST /api/dev/fake-payments/{id}/confirm (sans corps) : simule un paiement RÉUSSI chez le prestataire fictif. N'existe que
       * pendant le développement (404 sinon). La réponse donne l'issue de l'événement et l'état de la recharge.
       */
      confirm(topupId: string, requestOptions?: RequestOptions): Promise<FakePaymentResult> {
        return fakePayment("confirm", topupId, requestOptions);
      },

      /** POST /api/dev/fake-payments/{id}/fail (sans corps) : simule un paiement ÉCHOUÉ. */
      fail(topupId: string, requestOptions?: RequestOptions): Promise<FakePaymentResult> {
        return fakePayment("fail", topupId, requestOptions);
      },
    },

    boostPurchases: {
      /**
       * POST /api/offers/{id}/boost-purchases `{ quoteId, idempotencyKey }` : achète le boost d'un devis du vendeur avec son
       * solde (201 créé, 200 rejeu de la même clé : `reused`, aucun second débit). Le prix ne vient JAMAIS du client : c'est
       * celui du devis. Les trois identifiants sont des UUID, vérifiés avant l'envoi (`invalid_id`, `invalid_argument`).
       */
      async create(
        offerId: string,
        request: BoostPurchaseRequest,
        requestOptions?: RequestOptions,
      ): Promise<BoostPurchaseResult> {
        const path = `/api/offers/${id(offerId)}/boost-purchases`;
        if (!isUuid(request?.quoteId) || !isUuid(request.idempotencyKey)) throw fixedError(0, API_INVALID_ARGUMENT);
        const { status, json } = await send(
          "POST",
          path,
          { quoteId: request.quoteId, idempotencyKey: request.idempotencyKey },
          requestOptions,
        );
        if (!isObject(json) || json.contractVersion !== BOOST_PURCHASE_CONTRACT_VERSION || !isSafeAmount(json.balanceXof) || json.balanceXof < 0) {
          throw fixedError(status, API_INVALID_RESPONSE);
        }
        return { purchase: parseBoostPurchase(status, json.purchase), balanceXof: json.balanceXof };
      },

      /** GET /api/offers/{id}/boost-purchases?limit : les achats du vendeur pour SON annonce, plus récents d'abord (1 à 50). */
      async list(offerId: string, query: { limit?: number } = {}, requestOptions?: RequestOptions): Promise<BoostPurchaseHistoryItem[]> {
        const base = `/api/offers/${id(offerId)}/boost-purchases`;
        let path = base;
        if (query.limit !== undefined) {
          if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > 50) throw fixedError(0, API_INVALID_ARGUMENT);
          path = `${base}?limit=${query.limit}`;
        }
        const { status, json } = await send("GET", path, undefined, requestOptions);
        if (!isObject(json) || json.contractVersion !== BOOST_PURCHASE_CONTRACT_VERSION || !Array.isArray(json.purchases)) {
          throw fixedError(status, API_INVALID_RESPONSE);
        }
        return json.purchases.map((entry) => parseBoostPurchaseHistoryItem(status, entry));
      },
    },
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;

/** Client du navigateur : fetch global, même origine. */
export const api: ApiClient = createApiClient();

export type ApiErrorContext =
  | "otp-request" | "otp-verify" | "catalog" | "matches" | "boost" | "wallet" | "purchase" | "offer" | "contact" | "stats" | "notifications" | "tracking" | "subscription" | "import" | "default";

export const GENERIC_ERROR_MESSAGE = "Une erreur est survenue. Réessayez dans un instant.";
/** 409 `offer_limit_reached` (lot PRO1) : la limite d'annonces EN LIGNE du plan est atteinte ; rien n'a été publié. */
export const OFFER_LIMIT_REACHED_MESSAGE = "Vous avez atteint le nombre maximal d'annonces en ligne de votre offre. Mettez une annonce en pause ou passez à l'offre Pro.";
/** 429 d'une demande de devis (limite de débit par vendeur, lot P3). */
export const BOOST_RATE_LIMITED_MESSAGE = "Trop de demandes de prix en peu de temps. Patientez une minute, puis réessayez.";
/** 404 de la fiche d'une annonce et du contact : accès refusé, annonce hors de vos correspondances, ou retirée : une seule phrase, rien n'est distingué. */
export const OFFER_UNAVAILABLE_MESSAGE = "Cette annonce n'est plus disponible pour votre besoin, ou elle n'existe pas.";
/** 409 `offer_not_available` du contact : en pause, retirée ou vendue ; rien n'a été révélé. */
export const CONTACT_OFFER_GONE_MESSAGE = "Cette annonce n'est plus disponible : le vendeur l'a mise en pause, retirée ou vendue. Aucun contact n'a été enregistré.";
/** 429 du contact : 20 vendeurs distincts par jour. */
export const CONTACT_RATE_LIMITED_MESSAGE = "Vous avez déjà contacté 20 vendeurs aujourd'hui. Réessayez demain.";
/** 429 d'une recharge, d'une lecture du porte-monnaie ou d'un achat. */
export const TOO_MANY_ATTEMPTS_MESSAGE = "Trop de tentatives, réessayez dans un instant.";

/** Messages fixes des refus du portefeuille et de la recharge (`wallet`) : jamais le code brut, jamais le texte du serveur. */
export const WALLET_ERROR_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  invalid_request:
    "Cette demande n'est pas valide. Le montant d'une recharge va de 500 à 500 000 FCFA, par multiples de 100.",
  resource_not_found: "Cette recharge est introuvable.",
  too_many_pending_topups:
    "Vous avez déjà plusieurs recharges en attente. Terminez-en une, ou patientez : elles expirent au bout de 30 minutes.",
  idempotency_conflict: "Cette recharge a déjà été demandée avec un autre montant. Rechargez la page, puis recommencez.",
  payment_unavailable: "La recharge n'est pas disponible pour le moment.",
  wallet_unavailable: "Le porte-monnaie est temporairement indisponible. Réessayez dans un instant.",
});

/** 503 `reach_check_unavailable` (lot P3-bis) : la vérification de la portée n'a pas pu se terminer ; rien n'a été écrit ni débité, on peut réessayer. */
export const REACH_CHECK_UNAVAILABLE_MESSAGE = "Vérification impossible pour le moment, réessayez dans un instant.";

/** Messages fixes des refus d'un achat de boost (`purchase`), un par code de `boost-purchase/v1`. */
export const PURCHASE_ERROR_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  invalid_request: "Cette demande d'achat n'est pas valide. Actualisez la page, puis réessayez.",
  resource_not_found: "Annonce ou devis introuvable : actualisez la page et demandez un nouveau prix.",
  insufficient_balance: "Solde insuffisant : rechargez votre porte-monnaie, puis réessayez.",
  quote_expired: "Ce devis a expiré. Demandez un nouveau prix pour acheter.",
  quote_already_used: "Ce devis a déjà servi : demandez un nouveau prix si vous souhaitez acheter à nouveau.",
  quote_unavailable: "Ce devis n'a pas de prix : le boost n'est pas disponible pour le moment.",
  offer_not_eligible: "Cette annonce ne peut pas être boostée : elle doit être en ligne et disponible.",
  offer_already_boosted: "Cette annonce est déjà boostée.",
  no_slot_available: "Il n'y a plus de place de mise en avant disponible pour ce produit pour le moment.",
  seller_boost_limit_reached: "Vous avez atteint votre plafond de boosts pour ce produit.",
  no_visible_effect: "Ce boost ne ferait plus monter votre annonce chez aucun acheteur (place déjà occupée par un boost acheté plus tôt, ou liste trop courte). Aucun débit. Demandez un nouveau prix plus tard.",
  reach_check_unavailable: REACH_CHECK_UNAVAILABLE_MESSAGE,
  idempotency_conflict: "Cet achat est en conflit avec une demande précédente. Demandez un nouveau prix, puis réessayez.",
  boost_purchase_unavailable: "L'achat de boost est temporairement indisponible. Réessayez dans un instant.",
});

/** Messages fixes des refus de l'offre Pro (`subscription`, lot PRO1) : jamais le code brut, jamais le texte du serveur. */
export const SUBSCRIPTION_ERROR_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  invalid_request: "Cette demande n'est pas valide. Rechargez la page, puis réessayez.",
  resource_not_found: "Ce plan ou cet avis est introuvable. Rechargez la page.",
  insufficient_balance: "Solde insuffisant : rechargez votre porte-monnaie, puis réessayez. Seuls vos crédits payés règlent l'abonnement, pas les crédits promotionnels.",
  already_subscribed: "Vous avez déjà un abonnement en cours. L'écran va être actualisé.",
  no_subscription: "Vous n'avez pas d'abonnement en cours. L'écran va être actualisé.",
  period_ended: "La période en cours est terminée : le renouvellement ne peut plus être réactivé. Souscrivez de nouveau pour continuer.",
  idempotency_conflict: "Cette demande est en conflit avec une demande précédente. Rechargez la page, puis réessayez.",
  plan_not_subscribable: "Ce plan ne se souscrit pas.",
  subscription_unavailable: "L'offre Pro est temporairement indisponible. Réessayez dans un instant.",
});

/** Messages fixes des refus de l'import de catalogue (`import`, lot PRO1). */
export const IMPORT_ERROR_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  invalid_request: "Cette demande n'est pas valide. Rechargez la page, puis réessayez.",
  entitlement_required: "L'import de catalogue est réservé à l'offre Pro.",
  too_many_rows: "Le fichier compte plus de 200 lignes : découpez-le en plusieurs fichiers.",
  invalid_file: "Le fichier est illisible : vérifiez l'en-tête (colonne « titre » obligatoire) et le format CSV.",
  subscription_unavailable: "L'import est temporairement indisponible. Réessayez dans un instant.",
});

function fixedMessage(table: Readonly<Record<string, string>>, code: string): string | null {
  return Object.prototype.hasOwnProperty.call(table, code) ? table[code] : null;
}

/**
 * Message FIXE en français pour l'utilisateur, choisi d'après (contexte, statut, code). Ne reprend jamais le texte
 * d'une exception ni, par principe, celui du serveur : une exception quelconque donne le message générique.
 */
export function describeApiError(error: unknown, context: ApiErrorContext = "default"): string {
  if (!(error instanceof ApiError)) return GENERIC_ERROR_MESSAGE;

  if (error.code === API_NETWORK_ERROR) {
    return "Connexion impossible. Vérifiez votre réseau et réessayez.";
  }
  if (error.code === API_ABORTED) return "Requête interrompue.";
  if (error.code === API_INVALID_ID) return "Identifiant invalide. Rechargez la page.";
  if (error.code === API_INVALID_ARGUMENT) return "Paramètre invalide. Rechargez la page.";
  // Annonce refusée parce qu'elle porte un numéro de téléphone (lots D1 et D3) : message fixe et clair qui nomme le champ (liste fermée), quel que soit le contexte.
  if (error.status === 400 && error.code === "phone_number_in_offer") return phoneInOfferMessage(error.field);
  // Nom d'attribut refusé (lot D3) : rappel de la règle, jamais le nom saisi.
  if (error.status === 400 && error.code === "invalid_attribute_key") return ATTRIBUTE_KEY_MESSAGE;
  // Limite d'annonces en ligne du plan (lot PRO1) : message fixe et clair, quel que soit le contexte.
  if (error.status === 409 && error.code === "offer_limit_reached") return OFFER_LIMIT_REACHED_MESSAGE;

  if (context === "matches") {
    if (error.status === 400) return "Les résultats ne peuvent pas être affichés pour le moment. Actualisez la page.";
    if (error.status === 404) return "Introuvable : cet élément a peut-être été archivé ou n'existe plus.";
    if (error.status === 503) return "Les correspondances sont temporairement indisponibles. Réessayez dans un instant.";
  }
  if (context === "offer") {
    if (error.status === 400) return "Cette annonce ne peut pas être affichée. Retournez aux résultats de votre besoin.";
    if (error.status === 404) return OFFER_UNAVAILABLE_MESSAGE;
    if (error.status === 503) return "L'annonce est temporairement indisponible. Réessayez dans un instant.";
  }
  if (context === "contact") {
    if (error.status === 404) return OFFER_UNAVAILABLE_MESSAGE;
    if (error.status === 409 && error.code === "offer_not_available") return CONTACT_OFFER_GONE_MESSAGE;
    if (error.status === 409) return "Le contact de ce vendeur n'est pas disponible pour le moment.";
    if (error.status === 429) return CONTACT_RATE_LIMITED_MESSAGE;
    if (error.status === 503) return "Le contact est temporairement indisponible. Réessayez dans un instant.";
    if (error.status === 400) return "Cette demande de contact n'est pas valide. Rechargez la page.";
  }
  if (context === "notifications") {
    if (error.status === 400) return "Cette demande n'est pas valide. Rechargez la page.";
    if (error.status === 404) return "Cette notification est introuvable. La liste va être actualisée.";
    if (error.status === 503) return "Les notifications sont temporairement indisponibles. Réessayez dans un instant.";
  }
  if (context === "tracking") {
    if (error.status === 404) return "Besoin introuvable : il a peut-être été archivé ou n'existe plus.";
    if (error.status === 409 && error.code === "demand_not_active") return "Le suivi n'est disponible que pour un besoin actif.";
    if (error.status === 503) return "Le suivi est temporairement indisponible. Réessayez dans un instant.";
  }
  if (context === "stats") {
    if (error.status === 404) return "Annonce introuvable : elle n'existe pas ou n'est pas à vous.";
    if (error.status === 503) return "Les statistiques sont temporairement indisponibles. Réessayez dans un instant.";
  }
  if (context === "boost") {
    if (error.status === 404) return "Annonce introuvable : elle a peut-être été archivée ou n'existe plus.";
    if (error.status === 409 && error.code === "offer_not_eligible") {
      return "Cette annonce ne peut pas être boostée : elle doit être en ligne et disponible.";
    }
    if (error.status === 409 && error.code === "offer_not_boostable") {
      return "Pour booster cette annonce, indiquez sa catégorie, sa marque et son modèle.";
    }
    if (error.status === 429) return BOOST_RATE_LIMITED_MESSAGE;
    if (error.status === 503 && error.code === "reach_check_unavailable") return REACH_CHECK_UNAVAILABLE_MESSAGE;
    if (error.status === 503) return "Le boost est temporairement indisponible. Réessayez plus tard.";
  }
  if (context === "wallet" || context === "purchase") {
    // Un code connu (avec un statut de refus cohérent) a son message fixe ; un code inconnu ne montre JAMAIS le code brut :
    // message générique pour 400, 404 et 409 (les messages communs parlent d'une « liste » qui n'existe pas ici).
    const known = fixedMessage(context === "wallet" ? WALLET_ERROR_MESSAGES : PURCHASE_ERROR_MESSAGES, error.code);
    if (known !== null && [400, 404, 409, 503].includes(error.status)) return known;
    if ([400, 404, 409].includes(error.status)) return GENERIC_ERROR_MESSAGE;
  }

  if (context === "subscription" || context === "import") {
    const known = fixedMessage(context === "subscription" ? SUBSCRIPTION_ERROR_MESSAGES : IMPORT_ERROR_MESSAGES, error.code);
    if (known !== null && [400, 403, 404, 409, 503].includes(error.status)) return known;
    if ([400, 403, 404, 409].includes(error.status)) return GENERIC_ERROR_MESSAGE;
    if (error.status === 413) return "Le fichier est trop volumineux : découpez-le en plusieurs fichiers.";
  }

  // Limite de débit (429) propre au portefeuille et à l'achat : le message des codes de connexion ne convient pas ici.
  if ((context === "wallet" || context === "purchase") && error.status === 429) return TOO_MANY_ATTEMPTS_MESSAGE;

  switch (error.status) {
    case 400:
      if (context === "otp-request") return "Numéro de téléphone invalide. Vérifiez-le et réessayez.";
      if (context === "otp-verify") return "Code invalide. Saisissez les 6 chiffres reçus.";
      return "Les informations saisies sont invalides. Vérifiez-les et réessayez.";
    case 401:
      if (context === "otp-verify") return "Code incorrect ou expiré. Vérifiez-le ou demandez un nouveau code.";
      return "Votre session a expiré. Reconnectez-vous pour continuer.";
    case 403:
      return "Requête refusée. Rechargez la page et réessayez.";
    case 404:
      return "Élément introuvable. La liste va être actualisée.";
    case 409:
      if (error.code === "content_version_conflict") {
        return "Cet élément a été modifié entre-temps. La liste a été actualisée, réessayez.";
      }
      if (error.code === "resource_archived") return "Cet élément est archivé et ne peut plus être modifié.";
      if (error.code === "status_transition_conflict") {
        return "Action impossible dans l'état actuel. La liste a été actualisée.";
      }
      return GENERIC_ERROR_MESSAGE;
    case 413:
      return "Le contenu envoyé est trop volumineux.";
    case 429:
      return "Trop de demandes de code. Patientez quelques minutes avant de réessayer.";
    case 503:
      // Lot SMS1 : l'envoi du code a échoué de façon définitive (message générique, sans détail du fournisseur).
      if (context === "otp-request" && error.code === "otp_delivery_failed") return "Envoi du code impossible pour le moment. Réessayez dans quelques minutes.";
      // Lot SMS1-ter : plus de réponse propre à la saturation (elle ferait deviner si un numéro a un compte) ; l'écran de vérification porte la consigne « réessayez plus tard ».
      return "Le service est temporairement indisponible. Réessayez dans un instant.";
    default:
      return GENERIC_ERROR_MESSAGE;
  }
}

/** Vrai si l'erreur signifie « pas de session » (401) : l'écran redirige alors vers la connexion. */
export function isUnauthorized(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401;
}
