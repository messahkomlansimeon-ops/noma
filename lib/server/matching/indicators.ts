import { RELEVANCE_CONFIG } from "./relevance-config";

/**
 * Indicateurs séparés (brief SCOUTR §5) et pertinence organique (§15, sans boost). Fonctions PURES : aucun accès à la
 * base, déterministes, `now` en paramètre. Toutes les valeurs numériques viennent de relevance-config.ts.
 * Un score de compatibilité n'est jamais une garantie de fiabilité : la compatibilité, le prix, la disponibilité et
 * la confiance restent quatre indicateurs distincts, la pertinence n'étant qu'une combinaison pour le tri.
 */

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const C = RELEVANCE_CONFIG;

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

// ───────────── Disponibilité (concerne l'OFFRE de la paire) ─────────────

export type AvailabilityLevel = "confirmed_recent" | "confirmed" | "unconfirmed" | "reserved" | "unavailable" | "unknown";

export interface AvailabilityIndicator {
  level: AvailabilityLevel;
  /** 0 à 100, ou null (statut inconnu). */
  score: number | null;
  /** Âge entier (heures) de la dernière confirmation, ou null si jamais confirmée. */
  confirmedAgeHours: number | null;
  /** Codes stables ; `insufficient_quantity` si la quantité de l'offre est inférieure à la quantité demandée. */
  factors: string[];
}

export interface AvailabilityInput {
  /** availability_status de l'offre ; null = inconnu. */
  status: "available" | "reserved" | "unavailable" | null;
  confirmedAt: Date | null;
  /** Quantité de l'offre, si connue. */
  quantity: number | null;
  /** Quantité demandée par la demande de la paire, si connue. */
  requestedQuantity: number | null;
  now: Date;
}

export function computeAvailabilityIndicator(input: AvailabilityInput): AvailabilityIndicator {
  const { scores } = C.availability;
  const ageMs = input.confirmedAt ? Math.max(0, input.now.getTime() - input.confirmedAt.getTime()) : null;
  const confirmedAgeHours = ageMs === null ? null : Math.floor(ageMs / HOUR_MS);
  const factors: string[] = [];

  let level: AvailabilityLevel;
  let score: number | null;
  switch (input.status) {
    case null:
      level = "unknown"; score = null;
      break;
    case "unavailable":
      level = "unavailable"; score = scores.unavailable;
      break;
    case "reserved":
      level = "reserved"; score = scores.reserved;
      break;
    default:
      if (ageMs !== null && ageMs <= C.availability.recentConfirmationHours * HOUR_MS) { level = "confirmed_recent"; score = scores.confirmedRecent; }
      else if (ageMs !== null && ageMs <= C.availability.confirmationValidityHours * HOUR_MS) { level = "confirmed"; score = scores.confirmed; }
      else { level = "unconfirmed"; score = scores.unconfirmed; }
  }

  if (input.quantity !== null && input.requestedQuantity !== null && input.quantity < input.requestedQuantity) {
    factors.push("insufficient_quantity");
    if (score !== null) score = Math.min(score, C.availability.insufficientQuantityCap);
  }
  return { level, score, confirmedAgeHours, factors };
}

// ───────────── Prix (concerne l'OFFRE de la paire) ─────────────

export type PricePosition = "below_market" | "in_market" | "above_market" | "insufficient_data";

export interface MarketReference {
  /** Échantillon HORS l'offre évaluée. */
  sampleSize: number;
  p25: number | null;
  median: number | null;
  p75: number | null;
}

export interface PriceIndicator {
  position: PricePosition;
  score: number | null;
  /** Écart entier à la médiane, en pourcentage ; null si indisponible. */
  deltaPercent: number | null;
  sampleSize: number;
}

export function computePriceIndicator(input: { price: number | null; market: MarketReference | null }): PriceIndicator {
  const { market, price } = input;
  const sampleSize = market?.sampleSize ?? 0;
  const insufficient: PriceIndicator = { position: "insufficient_data", score: null, deltaPercent: null, sampleSize };
  if (price === null || market === null || sampleSize < C.price.minSampleSize) return insufficient;
  if (market.p25 === null || market.median === null || market.p75 === null || market.median <= 0) return insufficient;

  const deltaPercent = Math.round(((price - market.median) / market.median) * 100);
  const { scores } = C.price;
  if (price <= market.p25) return { position: "below_market", score: scores.belowMarket, deltaPercent, sampleSize };
  if (price <= market.p75) return { position: "in_market", score: scores.inMarket, deltaPercent, sampleSize };
  return { position: "above_market", score: scores.aboveMarket, deltaPercent, sampleSize };
}

// ───────────── Confiance (concerne le PROPRIÉTAIRE et l'annonce du candidat) ─────────────

export type ConfidenceLevel = "high" | "medium" | "low";
export type AccountAgeBand = "lt_7d" | "7d_30d" | "gte_30d";

export interface ConfidenceIndicator {
  level: ConfidenceLevel;
  /** 0 à 100. */
  score: number;
  /** Ancienneté du compte par tranche : JAMAIS une date exacte. */
  accountAgeBand: AccountAgeBand;
  /** Codes stables (phone_verified, account_age_*, structured_fields_*, availability_confirmed…). */
  factors: string[];
}

export interface ConfidenceInput {
  kind: "offer" | "demand";
  phoneVerified: boolean;
  accountCreatedAt: Date;
  /** Valeurs des champs structurés ; seuls ceux de `completenessFields[kind]` comptent. */
  fields: Partial<Record<"category" | "brand" | "model" | "condition" | "price" | "location", string | number | null | undefined>>;
  /** Offre dont la disponibilité a déjà été confirmée ; ignoré pour une demande. */
  availabilityEverConfirmed: boolean;
  now: Date;
}

export function accountAgeBandOf(createdAt: Date, now: Date): AccountAgeBand {
  const ageDays = (now.getTime() - createdAt.getTime()) / DAY_MS;
  if (ageDays >= C.confidence.accountAgeDays.established) return "gte_30d";
  if (ageDays >= C.confidence.accountAgeDays.recent) return "7d_30d";
  return "lt_7d";
}

export function computeConfidenceIndicator(input: ConfidenceInput): ConfidenceIndicator {
  const { points } = C.confidence;
  const factors: string[] = [];
  let total = 0;

  if (input.phoneVerified) { total += points.phoneVerified; factors.push("phone_verified"); }
  else factors.push("phone_not_verified");

  const accountAgeBand = accountAgeBandOf(input.accountCreatedAt, input.now);
  if (accountAgeBand === "gte_30d") total += points.accountAgeGte30Days;
  else if (accountAgeBand === "7d_30d") total += points.accountAgeGte7Days;
  factors.push(`account_age_${accountAgeBand}`);

  const applicableFields = C.confidence.completenessFields[input.kind] as readonly string[];
  const filled = applicableFields.filter((field) => {
    const value = input.fields[field as keyof ConfidenceInput["fields"]];
    return typeof value === "number" || (typeof value === "string" && value.trim().length > 0);
  }).length;
  total += (filled / applicableFields.length) * points.completenessMax;
  factors.push(filled === applicableFields.length ? "structured_fields_complete" : filled === 0 ? "structured_fields_none" : "structured_fields_partial");

  // Maximum atteignable : une demande n'a pas le facteur « disponibilité confirmée » (total renormalisé sur 90).
  let maximum = points.phoneVerified + points.accountAgeGte30Days + points.completenessMax;
  if (input.kind === "offer") {
    maximum += points.availabilityEverConfirmed;
    if (input.availabilityEverConfirmed) { total += points.availabilityEverConfirmed; factors.push("availability_confirmed"); }
  }

  const score = round((total / maximum) * 100, C.relevance.decimals);
  const level: ConfidenceLevel = score >= C.confidence.levels.high ? "high" : score >= C.confidence.levels.medium ? "medium" : "low";
  return { level, score, accountAgeBand, factors };
}

// ───────────── Pertinence ─────────────

export type RelevanceSense = "demand_source" | "offer_source";

export interface RelevanceInput {
  /** Seule une correspondance CONFIRMÉE (compatible ET éligible) reçoit une pertinence. */
  confirmed: boolean;
  /** `demand_source` : l'acheteur voit des offres (quatre composantes). `offer_source` : le vendeur voit des demandes
   *  (compatibilité et confiance de l'acheteur seulement : disponibilité et prix de SA propre offre sont identiques
   *  pour tous les éléments, donc non applicables). */
  sense: RelevanceSense;
  /** Score de compatibilité enregistré (0 à 100), ou null. */
  compatibility: number | null;
  availability: number | null;
  price: number | null;
  confidence: number | null;
}

/** Pertinence 0..100 arrondie à 2 décimales, ou null pour une ligne non confirmée. */
export function computeRelevance(input: RelevanceInput): number | null {
  if (!input.confirmed) return null;
  const { weights } = C;
  const components: Array<[number, number | null]> = [
    [weights.compatibility, input.compatibility],
    [weights.confidence, input.confidence],
  ];
  if (input.sense === "demand_source") components.push([weights.availability, input.availability], [weights.price, input.price]);

  let weightSum = 0;
  let weighted = 0;
  for (const [weight, value] of components) {
    if (value === null) continue; // composante absente : retirée, les poids restants sont renormalisés
    weightSum += weight;
    weighted += weight * value;
  }
  if (weightSum === 0) return null;
  return round(weighted / weightSum, C.relevance.decimals);
}
