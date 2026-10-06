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
 * (`boost-quote/v1`), lib/server/wallet/http.ts (`wallet/v1`) et lib/server/boost/purchase-http.ts (`boost-purchase/v1`), contrats
 * documentés dans AUTH-SERVER.md, CATALOG-HTTP.md, MATCHING-STORED-READ.md, BOOST-HTTP.md, WALLET.md et BOOST-PURCHASE.md.
 * Les réponses sont relues champ par champ (liste blanche) : un champ que le serveur ajouterait un jour n'atteint jamais l'écran.
 * Les montants du portefeuille sont des entiers sûrs (|n| ≤ 2^53 − 1), vérifiés à l'envoi comme à la lecture.
 */

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

// ─── Cotations de boost (boost-quote/v1) ──────────────────────────────────────────────────────────

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
    compatibleBuyers: number;
    /** Acheteurs pour lesquels le boost ferait réellement monter l'annonce ; `null` : non évalué (devis ancien ou indisponible plus tôt). */
    reachableBuyers: number | null;
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

export const WALLET_TRANSACTION_KINDS = ["topup", "adjustment", "boost_purchase", "boost_refund"] as const;
/**
 * Types connus ; « unknown » = un type que cette version de l'écran ne connaît pas (ajouté un jour par le serveur) : la ligne s'affiche « Opération »,
 * avec son montant (validé), au lieu de faire rejeter tout l'historique. Le code brut du serveur n'atteint jamais l'écran.
 */
export type WalletTransactionKind = (typeof WALLET_TRANSACTION_KINDS)[number] | "unknown";

/** Une ligne de l'historique : `amountXof` est SIGNÉ du côté de l'utilisateur (positif = crédit, négatif = débit). */
export interface WalletTransaction {
  id: string;
  kind: WalletTransactionKind;
  amountXof: number;
  createdAt: string;
}

export interface WalletOverview {
  /** Solde en FCFA (entier, jamais négatif). */
  balanceXof: number;
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
  /** Chemin de la page de paiement simulé (`/paiement-simule/<id>`) : à vérifier avant toute navigation. */
  checkoutPath: string;
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
  startsAt: string;
  endsAt: string;
  createdAt: string;
  refundedAt: string | null;
}

export interface OtpChallenge {
  challengeId: string;
  expiresAt: string;
  resendAvailableAt: string;
}

export type SessionOutcome =
  | { kind: "authenticated"; userId: string }
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

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

function fixedError(status: number, code: string): ApiError {
  return new ApiError(status, code, FIXED_ERROR_MESSAGES[code] ?? FIXED_ERROR_MESSAGES[API_INVALID_RESPONSE]);
}

const ERROR_CODE = /^[a-z][a-z0-9_]{0,63}$/;

function errorFromBody(status: number, body: unknown): ApiError {
  if (isObject(body) && isObject(body.error)) {
    const { code, message } = body.error;
    if (typeof code === "string" && ERROR_CODE.test(code) && typeof message === "string" && message.length <= 500) {
      return new ApiError(status, code, message);
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
export const BOOST_QUOTE_CONTRACT_VERSION = "boost-quote/v1";
export const WALLET_CONTRACT_VERSION = "wallet/v1";
export const BOOST_PURCHASE_CONTRACT_VERSION = "boost-purchase/v1";

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

function parseStoredMatch(status: number, value: unknown): StoredMatch {
  if (
    !isObject(value) ||
    typeof value.candidateId !== "string" ||
    typeof value.compatibilityStatus !== "string" ||
    !isNumberOrNull(value.score) ||
    !isNumberOrNull(value.coverage) ||
    typeof value.evaluatedAt !== "string" ||
    typeof value.relevance !== "number" ||
    typeof value.sponsored !== "boolean"
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
    typeof inputs.compatibleBuyers !== "number" ||
    !(inputs.reachableBuyers === null || (typeof inputs.reachableBuyers === "number" && Number.isSafeInteger(inputs.reachableBuyers) && inputs.reachableBuyers >= 0)) ||
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
      compatibleBuyers: inputs.compatibleBuyers,
      reachableBuyers: inputs.reachableBuyers as number | null,
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
    value.amountXof === 0 ||
    !isIsoDate(value.createdAt)
  ) {
    throw fixedError(status, API_INVALID_RESPONSE);
  }
  return {
    id: value.id,
    kind: (WALLET_TRANSACTION_KINDS as readonly string[]).includes(value.kind) ? (value.kind as WalletTransactionKind) : "unknown",
    amountXof: value.amountXof,
    createdAt: value.createdAt,
  };
}

function parseWalletOverview(status: number, value: unknown): WalletOverview {
  if (
    !isObject(value) ||
    value.contractVersion !== WALLET_CONTRACT_VERSION ||
    !isSafeAmount(value.balanceXof) ||
    value.balanceXof < 0 ||
    !Array.isArray(value.transactions) ||
    !(value.nextCursor === null || isCursor(value.nextCursor))
  ) {
    throw fixedError(status, API_INVALID_RESPONSE);
  }
  return {
    balanceXof: value.balanceXof,
    transactions: value.transactions.map((entry) => parseWalletTransaction(status, entry)),
    nextCursor: value.nextCursor,
  };
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
    value.checkoutPath.length > 200
  ) {
    throw fixedError(status, API_INVALID_RESPONSE);
  }
  return {
    id: value.id,
    amountXof: value.amountXof,
    status: value.status as TopupStatus,
    expiresAt: value.expiresAt,
    checkoutPath: value.checkoutPath,
  };
}

function parseBoostPurchaseCore(status: number, value: Record<string, unknown>): Omit<BoostPurchaseHistoryItem, "createdAt" | "refundedAt"> {
  if (
    !isUuid(value.id) ||
    !isUuid(value.quoteId) ||
    !(BOOST_DURATION_CODES as readonly string[]).includes(String(value.durationCode)) ||
    !isSafeAmount(value.amountXof) ||
    value.amountXof <= 0 ||
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
    method: "GET" | "POST" | "PATCH",
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

  async function session(requestOptions?: RequestOptions): Promise<{ userId: string }> {
    const { status, json } = await send("GET", "/api/auth/session", undefined, requestOptions);
    if (!isObject(json) || typeof json.userId !== "string") throw fixedError(status, API_INVALID_RESPONSE);
    return { userId: json.userId };
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

      /** GET /api/auth/session → 200 `{ userId }` ; 401 sans session valide (ApiError). */
      session,

      /**
       * Résultat de session sans exception : 200 → authenticated, 401 → anonymous, tout le reste
       * (503, panne réseau, réponse inattendue) → unavailable. Sert la garde de session des écrans.
       */
      async sessionOutcome(requestOptions?: RequestOptions): Promise<SessionOutcome> {
        try {
          const { userId } = await session(requestOptions);
          return { kind: "authenticated", userId };
        } catch (error) {
          if (error instanceof ApiError && error.status === 401) return { kind: "anonymous" };
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

export type ApiErrorContext = "otp-request" | "otp-verify" | "catalog" | "matches" | "boost" | "wallet" | "purchase" | "default";

export const GENERIC_ERROR_MESSAGE = "Une erreur est survenue. Réessayez dans un instant.";
/** 429 d'une demande de devis (limite de débit par vendeur, lot P3). */
export const BOOST_RATE_LIMITED_MESSAGE = "Trop de demandes de prix en peu de temps. Patientez une minute, puis réessayez.";
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

  if (context === "matches") {
    if (error.status === 400) return "Les résultats ne peuvent pas être affichés pour le moment. Actualisez la page.";
    if (error.status === 404) return "Introuvable : cet élément a peut-être été archivé ou n'existe plus.";
    if (error.status === 503) return "Les correspondances sont temporairement indisponibles. Réessayez dans un instant.";
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
      return "Le service est temporairement indisponible. Réessayez dans un instant.";
    default:
      return GENERIC_ERROR_MESSAGE;
  }
}

/** Vrai si l'erreur signifie « pas de session » (401) : l'écran redirige alors vers la connexion. */
export function isUnauthorized(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401;
}
