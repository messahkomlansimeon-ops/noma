import { COUNT_ROUNDING_BASE } from "../metrics/config";
import type { BoostDurationCode } from "./boost-config";

/**
 * Prix dynamique du boost (lot 2I2) : montant = base × concurrence × demande × rareté × durée. Fonctions PURES : facteurs en
 * millièmes ENTIERS, produit en BigInt (il dépasse 2^53), aucun flottant. Voir BOOST-PRICING.md.
 */

export interface BoostPricingSettings {
  /** Clé de la ligne lue : `default` ou la catégorie en minuscules. */
  key: string;
  /** Version de la ligne : une modification de configuration est une nouvelle version. */
  version: number;
  currency: "XOF";
  baseAmount: number;
  gridAmount: number;
  minAmount: number;
  maxAmount: number;
  competitionStepMilli: number;
  competitionMaxMilli: number;
  demandStepMilli: number;
  demandMaxMilli: number;
  scarcityMaxMilli: number;
  duration24hMilli: number;
  duration3dMilli: number;
  duration7dMilli: number;
  quoteValiditySeconds: number;
}

export interface BoostPriceFactors {
  competitionMilli: number;
  demandMilli: number;
  scarcityMilli: number;
  durationMilli: number;
}

export interface BoostPriceInputs {
  /** Vendeurs AUTRES (distincts) ayant au moins une offre éligible dans le périmètre. */
  competingSellers: number;
  /** Acheteurs compatibles distincts (au moins 1). */
  compatibleBuyers: number;
  slotsUsed: number;
  slotsTotal: number;
  durationCode: BoostDurationCode;
  settings: BoostPricingSettings;
}

export interface BoostPrice {
  /** Montant en XOF : sur la grille et dans [min, max]. */
  amount: number;
  /** Prix brut exact, 12 décimales (NUMERIC(30,12)). */
  rawAmount: string;
  factors: BoostPriceFactors;
}

// 1000^4 = 10^12 (les quatre facteurs sont des millièmes). Pas de littéraux BigInt : la cible TypeScript du projet est inférieure à ES2020.
const RAW_SCALE = BigInt("1000000000000");
const TWO = BigInt(2);

function requireIntegerInRange(value: unknown, min: number, max: number, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new RangeError(`${field} doit être un entier compris entre ${min} et ${max}.`);
  }
  return value;
}

/** Défense en profondeur : les mêmes règles que les CHECK de `boost_pricing_settings`. */
export function validatePricingSettings(settings: BoostPricingSettings): BoostPricingSettings {
  if (typeof settings !== "object" || settings === null) throw new RangeError("réglages tarifaires absents.");
  if (typeof settings.key !== "string" || settings.key === "" || settings.key !== settings.key.trim().toLowerCase()) {
    throw new RangeError("key doit être non vide, en minuscules et sans espaces de bord.");
  }
  requireIntegerInRange(settings.version, 1, 2_147_483_647, "version");
  if (settings.currency !== "XOF") throw new RangeError("currency doit valoir XOF.");
  requireIntegerInRange(settings.baseAmount, 1, 10_000_000, "baseAmount");
  requireIntegerInRange(settings.gridAmount, 1, 2_147_483_647, "gridAmount");
  requireIntegerInRange(settings.minAmount, 1, 2_147_483_647, "minAmount");
  requireIntegerInRange(settings.maxAmount, settings.minAmount, 2_147_483_647, "maxAmount");
  if (settings.minAmount % settings.gridAmount !== 0 || settings.maxAmount % settings.gridAmount !== 0) {
    throw new RangeError("minAmount et maxAmount doivent être des multiples de gridAmount.");
  }
  requireIntegerInRange(settings.competitionStepMilli, 0, 1000, "competitionStepMilli");
  requireIntegerInRange(settings.competitionMaxMilli, 1000, 5000, "competitionMaxMilli");
  requireIntegerInRange(settings.demandStepMilli, 0, 1000, "demandStepMilli");
  requireIntegerInRange(settings.demandMaxMilli, 1000, 5000, "demandMaxMilli");
  requireIntegerInRange(settings.scarcityMaxMilli, 1000, 5000, "scarcityMaxMilli");
  requireIntegerInRange(settings.duration24hMilli, 1000, 20_000, "duration24hMilli");
  requireIntegerInRange(settings.duration3dMilli, 1000, 20_000, "duration3dMilli");
  requireIntegerInRange(settings.duration7dMilli, 1000, 20_000, "duration7dMilli");
  if (!(settings.duration24hMilli <= settings.duration3dMilli && settings.duration3dMilli <= settings.duration7dMilli)) {
    throw new RangeError("les facteurs de durée doivent être croissants (24h ≤ 3d ≤ 7d).");
  }
  requireIntegerInRange(settings.quoteValiditySeconds, 60, 3600, "quoteValiditySeconds");
  return settings;
}

/** min(competition_max, 1000 + competition_step × S). S = vendeurs autres distincts. */
export function computeCompetitionFactor(competingSellers: number, settings: BoostPricingSettings): number {
  requireIntegerInRange(competingSellers, 0, 1_000_000_000, "competingSellers");
  return Math.min(settings.competitionMaxMilli, 1000 + settings.competitionStepMilli * competingSellers);
}

/**
 * D' : le nombre d'acheteurs utilisé par le facteur demande (lots M1-bis et M1-quater). Le facteur ne doit pas redonner un petit nombre d'acheteurs
 * (moins de 5, la borne de « moins de 5 » des devis) à qui connaît la formule : D' = 0 si D = 0 (aucun prix), D' = 5 pour 1 à 5 acheteurs (le prix est identique),
 * D' = D au-delà (limite assumée : à partir de 6 acheteurs, le prix reste fonction du nombre exact, MESURES.md). La cotation enregistrée garde D exact pour
 * l'administration ; seul le prix et le facteur affiché passent par D'.
 */
export function effectiveDemandBuyers(compatibleBuyers: number): number {
  requireIntegerInRange(compatibleBuyers, 0, 1_000_000_000, "compatibleBuyers");
  return compatibleBuyers === 0 ? 0 : Math.max(compatibleBuyers, COUNT_ROUNDING_BASE);
}

/** min(demand_max, 1000 + demand_step × (D' − 1)). D ≥ 1 acheteurs compatibles distincts (au moins 1 : sans acheteur il n'y a pas de prix) ; D' : voir `effectiveDemandBuyers`. */
export function computeDemandFactor(compatibleBuyers: number, settings: BoostPricingSettings): number {
  requireIntegerInRange(compatibleBuyers, 1, 1_000_000_000, "compatibleBuyers");
  return Math.min(settings.demandMaxMilli, 1000 + settings.demandStepMilli * (effectiveDemandBuyers(compatibleBuyers) - 1));
}

/** 1000 + floor((scarcity_max − 1000) × used / total), défini seulement si 0 ≤ used < total. */
export function computeScarcityFactor(slotsUsed: number, slotsTotal: number, settings: BoostPricingSettings): number {
  requireIntegerInRange(slotsTotal, 1, 1_000_000_000, "slotsTotal");
  requireIntegerInRange(slotsUsed, 0, slotsTotal - 1, "slotsUsed");
  return 1000 + Math.floor(((settings.scarcityMaxMilli - 1000) * slotsUsed) / slotsTotal);
}

export function computeDurationFactor(durationCode: BoostDurationCode, settings: BoostPricingSettings): number {
  switch (durationCode) {
    case "24h": return settings.duration24hMilli;
    case "3d": return settings.duration3dMilli;
    case "7d": return settings.duration7dMilli;
    default: throw new RangeError("durationCode doit valoir 24h, 3d ou 7d.");
  }
}

/** Décimal exact à 12 décimales d'un entier mis à l'échelle 10^12. */
function formatRaw(scaled: bigint): string {
  const integer = scaled / RAW_SCALE;
  const fraction = (scaled % RAW_SCALE).toString().padStart(12, "0");
  return `${integer}.${fraction}`;
}

/**
 * Prix d'une cotation. brut = base × fc × fd × fr × ft / 10^12 (rationnel exact num/den en BigInt). Montant =
 * clamp(grille × floor((2·num + den·grille) / (2·den·grille)), min, max) : arrondi demi-haut à la grille, PUIS bornes. Min et max
 * étant des multiples de la grille, le montant est toujours sur la grille et dans [min, max].
 */
export function computeBoostPrice(inputs: BoostPriceInputs): BoostPrice {
  const settings = validatePricingSettings(inputs.settings);
  const factors: BoostPriceFactors = {
    competitionMilli: computeCompetitionFactor(inputs.competingSellers, settings),
    demandMilli: computeDemandFactor(inputs.compatibleBuyers, settings),
    scarcityMilli: computeScarcityFactor(inputs.slotsUsed, inputs.slotsTotal, settings),
    durationMilli: computeDurationFactor(inputs.durationCode, settings),
  };
  // brut = numerator / RAW_SCALE (les quatre facteurs sont des millièmes : 1000^4 = 10^12).
  const numerator = BigInt(settings.baseAmount) * BigInt(factors.competitionMilli) * BigInt(factors.demandMilli)
    * BigInt(factors.scarcityMilli) * BigInt(factors.durationMilli);
  const grid = BigInt(settings.gridAmount);
  const gridUnits = (TWO * numerator + RAW_SCALE * grid) / (TWO * RAW_SCALE * grid);
  const rounded = grid * gridUnits;
  const clamped = rounded < BigInt(settings.minAmount) ? BigInt(settings.minAmount)
    : rounded > BigInt(settings.maxAmount) ? BigInt(settings.maxAmount) : rounded;
  return { amount: Number(clamped), rawAmount: formatRaw(numerator), factors };
}
