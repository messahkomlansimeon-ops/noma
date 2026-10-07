import { COUNT_FIRST_BUCKET_MAX, COUNT_ROUNDING_BASE, RATIO_MIN_PUBLISHED_COUNT, RATIO_ROUNDING_PERCENT } from "./config";

/**
 * Arrondi des statistiques publiées (lot M1-quater) : deux fonctions PURES, aucune table de suppression.
 *
 *  - `roundCount` : un compte (acheteurs uniques ou événements) de 0 à 4 est publié « moins de 5 » ; de 5 à 8, « environ 5 » ; au-delà, il est arrondi au multiple de 5
 *    le plus proche (la moitié vers le haut : 9 à 12 → 10, 13 à 17 → 15…) et publié « environ N ». Aucun compte exact n'est jamais publié.
 *  - `roundedRatio` : un pourcentage est calculé sur les deux nombres PUBLIÉS (déjà arrondis), jamais sur les valeurs exactes, et n'est publié que si les deux valent
 *    au moins 10 ; il est arrondi à la dizaine de pour cent. Une fonction des seuls chiffres publiés n'apprend rien de plus à qui les lit (MESURES.md : un pourcentage
 *    calculé sur les valeurs exactes, lui, laisse retrouver des différences de 1 à 4 acheteurs, ce que l'adversaire de tests/server/metrics-adversary.test.ts démontre).
 * Ce que l'arrondi protège, et ce qu'il ne protège pas : MESURES.md.
 */

export interface BelowCount {
  kind: "below";
  /** Le compte est strictement inférieur à cette borne (toujours COUNT_ROUNDING_BASE). */
  bound: number;
}

export interface ApproximateCount {
  kind: "approx";
  /** Multiple de COUNT_ROUNDING_BASE, au moins égal à COUNT_ROUNDING_BASE. */
  value: number;
}

export type StatCount = BelowCount | ApproximateCount;

export interface PercentRatio {
  kind: "percent";
  /** Multiple de RATIO_ROUNDING_PERCENT, de 0 à 100. */
  value: number;
}

export interface InsufficientRatio {
  kind: "insufficient";
}

export type StatRatio = PercentRatio | InsufficientRatio;

function requireCount(value: number, what: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${what} doit être un entier positif ou nul.`);
}

/** Multiple de `base` le plus proche d'un entier positif ou nul, la moitié vers le haut (arithmétique entière : aucun flottant). */
export function roundToBase(count: number, base: number = COUNT_ROUNDING_BASE): number {
  requireCount(count, "count");
  return Math.floor((2 * count + base) / (2 * base)) * base;
}

/** Compte publié : « moins de 5 » de 0 à 4, « environ 5 » de 5 à 8, au-delà « environ N » (multiple de 5 le plus proche, la moitié vers le haut). */
export function roundCount(count: number): StatCount {
  requireCount(count, "count");
  if (count < COUNT_ROUNDING_BASE) return { kind: "below", bound: COUNT_ROUNDING_BASE };
  if (count <= COUNT_FIRST_BUCKET_MAX) return { kind: "approx", value: COUNT_ROUNDING_BASE };
  return { kind: "approx", value: roundToBase(count) };
}

/** Pourcentage publié d'un rapport de deux comptes EXACTS, calculé sur leurs valeurs publiées ; `insufficient` si l'un des deux publiés vaut moins de 10. */
export function roundedRatio(numerator: number, denominator: number): StatRatio {
  const top = roundCount(numerator);
  const bottom = roundCount(denominator);
  if (top.kind !== "approx" || bottom.kind !== "approx" || top.value < RATIO_MIN_PUBLISHED_COUNT || bottom.value < RATIO_MIN_PUBLISHED_COUNT) return { kind: "insufficient" };
  // 100 × top / bottom arrondi à RATIO_ROUNDING_PERCENT près, la moitié vers le haut, en entiers (les deux termes sont des multiples de 5).
  const steps = Math.floor((2 * 100 * top.value + RATIO_ROUNDING_PERCENT * bottom.value) / (2 * RATIO_ROUNDING_PERCENT * bottom.value));
  return { kind: "percent", value: Math.min(100, steps * RATIO_ROUNDING_PERCENT) };
}
