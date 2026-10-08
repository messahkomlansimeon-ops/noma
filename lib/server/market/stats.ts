import { percentileContSorted } from "../matching/market";
import { roundCount, type StatCount } from "../metrics/privacy";
import {
  MARKET_MIN_SELLERS,
  MARKET_OUTLIER_IQR_FACTOR,
  MARKET_PRICE_ROUNDING_XOF,
  MARKET_RANGE_MIN_SELLERS,
  MARKET_RANGE_STEPS_PER_MEDIAN,
  MARKET_TREND_BLOCK_DAYS,
  MARKET_TREND_MIN_SELLERS,
  type MarketPeriod,
} from "./config";

/**
 * Statistiques des PRIX DEMANDÉS dans les annonces (lots H1, H1-bis et H1-ter) : fonctions PURES, sans accès à la base. Entrée : des relevés du prix affiché d'annonces publiées (un par
 * annonce et par jour) ; sortie : ce qui peut être PUBLIÉ, jamais davantage. Définitions exactes et ce que l'adversaire prouve : HISTORIQUE-PRIX.md.
 *
 * Les prix de VENTE ne sont jamais publiés (une vente est déclarée par l'acheteur et confirmée par le vendeur, sans vérification : quelques comptes suffisent à fabriquer un
 * groupe qui franchit les seuils et à faire publier le prix exact d'une vente). Ce module ne connaît donc que les annonces.
 *
 *  - UNE valeur par VENDEUR et par période : la médiane des derniers prix de ses annonces de la période (le dernier prix observé de chaque annonce, jamais pondéré par les jours).
 *    Un seul vendeur, quel que soit son nombre d'annonces, ne pèse qu'une valeur : il déplace la médiane d'au plus une position parmi les valeurs par vendeur (une annonce par
 *    vendeur ne suffit pas : six annonces d'un seul vendeur à 120 000 fixaient la médiane de ses concurrents à 120 000 quand la valeur était par annonce) ;
 *  - période : N jours UTC, aujourd'hui compris (de « aujourd'hui − (N − 1) » à aujourd'hui) ;
 *  - comparabilité : la clé exacte d'abord ; si ses seuils ne sont pas atteints, la variante est retirée (si elle était demandée), puis l'état (s'il était demandé), et le texte DIT
 *    contre quoi le prix est comparé ;
 *  - prix atypiques : toute valeur par vendeur hors de [Q1 − 1,5 × IQR ; Q3 + 1,5 × IQR] est écartée avant toute publication, et le nombre d'annonces concernées est publié ;
 *  - seuils de confidentialité, sur les VENDEURS retenus après retrait des prix atypiques : médiane à partir de 5 vendeurs distincts, fourchette (Q1, Q3, arrondie en RELATIF : multiples
 *    de 5 % de la médiane, jamais une borne ≤ 0) à partir de 10 vendeurs, un point de tendance (médiane d'une semaine) à partir de 20 vendeurs ; sinon « pas assez de données » ;
 *  - chaque prix est d'abord arrondi à 500 FCFA, puis la médiane est calculée sur ces prix arrondis et arrondie à 500 FCFA ;
 *  - effectifs (annonces, vendeurs) arrondis comme les autres mesures (`roundCount`) ; jamais de minimum ni de maximum, jamais d'identifiant.
 */

/** Un relevé du prix affiché d'une annonce (les identifiants servent uniquement à compter des annonces et des vendeurs distincts : ils ne sortent jamais de ce module). */
export interface MarketObservation {
  /** L'annonce. */
  referenceId: string;
  sellerId: string | null;
  /** Jour UTC, AAAA-MM-JJ. */
  day: string;
  /** Prix demandé en FCFA (entier). */
  priceXof: number;
  /** Clés normalisées de la ligne (texte vide : variante ou état absent). */
  variantKey: string;
  conditionKey: string;
}

export type ComparisonScope = "exact" | "any_variant" | "any_condition" | "any_variant_and_condition";

export interface ComparisonLevel {
  scope: ComparisonScope;
  /** Clé de variante exigée (`null` : toutes les variantes). */
  variantKey: string | null;
  /** Clé d'état exigée (`null` : tous les états). */
  conditionKey: string | null;
}

export interface MarketRequest {
  periodDays: MarketPeriod;
  /** Aujourd'hui, jour UTC AAAA-MM-JJ. */
  today: string;
  /** Clé normalisée de la variante demandée ; `null` : aucune variante demandée. */
  variantKey: string | null;
  /** Clé normalisée de l'état demandé ; `null` : aucun état demandé. */
  conditionKey: string | null;
  /** Textes demandés (casse de l'appelant) : servent uniquement à la phrase de comparabilité. */
  display: { model: string; variant: string | null; condition: string | null };
  /** Faux : la clé exacte seule (tableau d'administration). Vrai par défaut. */
  allowWidening?: boolean;
}

export interface TrendPoint {
  /** Premier jour du bloc de 7 jours (AAAA-MM-JJ). */
  from: string;
  /** Médiane des valeurs par vendeur du bloc, arrondie à 500 FCFA ; `null` : le bloc n'atteint pas les seuils (au moins 20 vendeurs retenus dans la semaine). */
  median: number | null;
}

export interface PublishedListings {
  status: "published";
  comparedTo: { scope: ComparisonScope; text: string };
  /** Annonces des vendeurs retenus : arrondi. */
  count: StatCount;
  /** Vendeurs retenus (une valeur chacun) : arrondi. */
  sellers: StatCount;
  /** Annonces des vendeurs aux prix atypiques écartés : arrondi ; `null` quand aucun vendeur n'a été écarté. */
  excluded: StatCount | null;
  median: number;
  /** Fourchette arrondie en relatif (multiples de 5 % de la médiane), seulement à partir de 10 vendeurs retenus, et jamais avec une borne ≤ 0. */
  range: { q1: number; q3: number } | null;
  trend: TrendPoint[];
}

export interface InsufficientListings {
  status: "insufficient";
}

export type ListingsOutcome = PublishedListings | InsufficientListings;

export interface MarketStats {
  period: { days: MarketPeriod; from: string; to: string };
  listings: ListingsOutcome;
}

// ───────────── jours UTC ─────────────

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export function isUtcDay(value: unknown): value is string {
  if (typeof value !== "string" || !DAY.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** Jour UTC décalé de `days` jours (négatif : avant). */
export function addDays(day: string, days: number): string {
  if (!isUtcDay(day) || !Number.isSafeInteger(days)) throw new RangeError("jour UTC ou décalage invalide.");
  const date = new Date(`${day}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

// ───────────── arrondis ─────────────

/** Multiple de 500 FCFA le plus proche, la moitié vers le haut (valeur positive ou nulle). */
export function roundPriceXof(value: number): number {
  if (!Number.isFinite(value) || value < 0) throw new RangeError("prix invalide.");
  return Math.floor((value + MARKET_PRICE_ROUNDING_XOF / 2) / MARKET_PRICE_ROUNDING_XOF) * MARKET_PRICE_ROUNDING_XOF;
}

/** Quantile (interpolation linéaire, `percentile_cont`) de valeurs déjà TRIÉES ; erreur sans valeur. */
function quantile(sorted: readonly number[], percentile: number): number {
  const value = percentileContSorted(sorted, percentile);
  if (value === null) throw new RangeError("aucun prix.");
  return value;
}

/**
 * Q1 ou Q3 arrondi en RELATIF : le multiple de 5 % de la médiane publiée (médiane / 20) le plus proche, la moitié vers le haut, du côté de la médiane où se trouve le quartile.
 * Arithmétique entière : la médiane est un multiple de 500 (donc son vingtième un entier), les quartiles des prix arrondis sont des multiples de 125.
 */
export function relativeRound(median: number, quartile: number): number {
  const step = median / MARKET_RANGE_STEPS_PER_MEDIAN;
  if (!Number.isInteger(step) || step <= 0) return median;
  const distance = Math.abs(quartile - median);
  const steps = Math.floor((2 * distance + step) / (2 * step));
  return quartile < median ? median - steps * step : median + steps * step;
}

// ───────────── comparabilité ─────────────

/** Les niveaux de comparaison, du plus précis au plus large : la clé exacte, puis sans la variante (si elle était demandée), puis sans l'état (s'il était demandé). */
export function comparisonLevels(variantKey: string | null, conditionKey: string | null, allowWidening = true): ComparisonLevel[] {
  const levels: ComparisonLevel[] = [{ scope: "exact", variantKey, conditionKey }];
  if (!allowWidening) return levels;
  if (variantKey !== null) levels.push({ scope: "any_variant", variantKey: null, conditionKey });
  if (conditionKey !== null) levels.push({ scope: variantKey !== null ? "any_variant_and_condition" : "any_condition", variantKey: null, conditionKey: null });
  return levels;
}

/**
 * La phrase qui DIT contre quoi le prix est comparé, TOUJOURS avec ce qui est confondu : « Comparé à : iPhone 12, tous états confondus ». Une variante ou un état non précisé est dit
 * « confondu » (jamais passé sous silence), qu'il ait été élargi ou jamais demandé.
 */
export function comparisonText(level: ComparisonLevel, display: MarketRequest["display"]): string {
  const product = [display.model, level.variantKey !== null ? display.variant : null].filter((part): part is string => part !== null && part !== "").join(" ");
  const parts = [product];
  if (level.conditionKey !== null && display.condition) parts.push(display.condition);
  const anyVariant = level.variantKey === null;
  const anyCondition = level.conditionKey === null;
  const suffix = anyVariant && anyCondition ? ", toutes variantes et tous états confondus" : anyVariant ? ", toutes variantes confondues" : anyCondition ? ", tous états confondus" : "";
  return `Comparé à : ${parts.join(", ")}${suffix}`;
}

function inLevel(row: MarketObservation, level: ComparisonLevel): boolean {
  return (level.variantKey === null || row.variantKey === level.variantKey) && (level.conditionKey === null || row.conditionKey === level.conditionKey);
}

// ───────────── une valeur par annonce, puis UNE valeur par vendeur ─────────────

/** UNE valeur par annonce : le relevé le plus récent de chaque annonce (jamais de pondération par le nombre de jours en ligne). */
export function lastPerListing(rows: readonly MarketObservation[]): MarketObservation[] {
  const last = new Map<string, MarketObservation>();
  for (const row of rows) {
    const known = last.get(row.referenceId);
    if (known === undefined || row.day >= known.day) last.set(row.referenceId, row);
  }
  return [...last.values()];
}

/** La valeur d'UN vendeur : la médiane (arrondie à 500) des derniers prix, eux-mêmes arrondis à 500, de ses annonces. */
export interface SellerValue {
  sellerId: string;
  priceXof: number;
  /** Nombre d'annonces du vendeur dans le groupe. */
  listings: number;
}

/**
 * UNE valeur par VENDEUR : la médiane des derniers prix (arrondis à 500) de ses annonces. `listings` : une ligne par annonce (le dernier relevé de chacune). Un vendeur inconnu
 * (compte supprimé : `null`) ne peut être attribué à personne : ses annonces ne comptent pas.
 */
export function sellerValues(listings: readonly MarketObservation[]): SellerValue[] {
  const prices = new Map<string, number[]>();
  for (const row of listings) {
    if (row.sellerId === null) continue;
    const list = prices.get(row.sellerId) ?? [];
    list.push(roundPriceXof(row.priceXof));
    prices.set(row.sellerId, list);
  }
  return [...prices].map(([sellerId, list]) => ({ sellerId, priceXof: roundPriceXof(quantile(list.sort((a, b) => a - b), 0.5)), listings: list.length }));
}

/** Les seuils de confidentialité de la médiane sont-ils atteints ? Au moins 5 VENDEURS distincts (une valeur chacun : un vendeur ne compte jamais deux fois). */
export function meetsThresholds(values: readonly SellerValue[], minSellers: number = MARKET_MIN_SELLERS): boolean {
  return new Set(values.map((value) => value.sellerId)).size >= minSellers;
}

interface Retained {
  /** Valeurs par vendeur conservées. */
  kept: SellerValue[];
  /** Valeurs par vendeur écartées (prix atypiques). */
  excluded: SellerValue[];
}

/** Écarte les prix atypiques : toute valeur par vendeur hors de [Q1 − 1,5 × IQR ; Q3 + 1,5 × IQR] des valeurs par vendeur. */
export function discardOutliers(values: readonly SellerValue[]): Retained {
  if (values.length === 0) return { kept: [], excluded: [] };
  const sorted = values.map((value) => value.priceXof).sort((a, b) => a - b);
  const q1 = quantile(sorted, 0.25);
  const q3 = quantile(sorted, 0.75);
  const margin = MARKET_OUTLIER_IQR_FACTOR * (q3 - q1);
  const kept = values.filter((value) => value.priceXof >= q1 - margin && value.priceXof <= q3 + margin);
  return { kept, excluded: values.filter((value) => !(value.priceXof >= q1 - margin && value.priceXof <= q3 + margin)) };
}

interface Summary {
  sellers: number;
  listings: number;
  excludedListings: number;
  median: number;
  range: { q1: number; q3: number } | null;
}

/**
 * Le résumé publiable des annonces d'un groupe (une ligne par annonce) : une valeur par vendeur, prix atypiques écartés, seuils vérifiés sur les vendeurs RETENUS ; `null` sous les seuils.
 * `minSellers` : celui de la période (5) ou celui d'un point de tendance (20). La fourchette n'existe qu'à partir de 10 vendeurs, arrondie en relatif, et n'est jamais publiée avec une
 * borne ≤ 0 (une médiane énorme fait arrondir Q1 à 0 : la fourchette est alors omise).
 */
function summarize(listings: readonly MarketObservation[], minSellers: number): Summary | null {
  const { kept, excluded } = discardOutliers(sellerValues(listings));
  if (!meetsThresholds(kept, minSellers)) return null;
  const sorted = kept.map((value) => value.priceXof).sort((a, b) => a - b);
  const median = roundPriceXof(quantile(sorted, 0.5));
  let range: Summary["range"] = null;
  if (kept.length >= MARKET_RANGE_MIN_SELLERS) {
    const q1 = relativeRound(median, quantile(sorted, 0.25));
    const q3 = relativeRound(median, quantile(sorted, 0.75));
    if (q1 > 0 && q3 > 0) range = { q1, q3 };
  }
  return {
    sellers: kept.length,
    listings: kept.reduce((sum, value) => sum + value.listings, 0),
    excludedListings: excluded.reduce((sum, value) => sum + value.listings, 0),
    median,
    range,
  };
}

// ───────────── calcul ─────────────

function trendOf(rows: readonly MarketObservation[], level: ComparisonLevel, periodDays: number, today: string): TrendPoint[] {
  const blocks = Math.floor(periodDays / MARKET_TREND_BLOCK_DAYS);
  const first = addDays(today, -(MARKET_TREND_BLOCK_DAYS * blocks - 1));
  const points: TrendPoint[] = [];
  for (let index = 0; index < blocks; index += 1) {
    const start = addDays(first, MARKET_TREND_BLOCK_DAYS * index);
    const end = addDays(start, MARKET_TREND_BLOCK_DAYS - 1);
    const values = lastPerListing(rows.filter((row) => row.day >= start && row.day <= end)).filter((row) => inLevel(row, level));
    points.push({ from: start, median: summarize(values, MARKET_TREND_MIN_SELLERS)?.median ?? null });
  }
  return points;
}

function listingsOutcome(windowRows: readonly MarketObservation[], request: MarketRequest): ListingsOutcome {
  const periodValues = lastPerListing(windowRows);
  for (const level of comparisonLevels(request.variantKey, request.conditionKey, request.allowWidening !== false)) {
    const summary = summarize(periodValues.filter((row) => inLevel(row, level)), MARKET_MIN_SELLERS);
    if (summary === null) continue;
    return {
      status: "published",
      comparedTo: { scope: level.scope, text: comparisonText(level, request.display) },
      count: roundCount(summary.listings),
      sellers: roundCount(summary.sellers),
      excluded: summary.excludedListings === 0 ? null : roundCount(summary.excludedListings),
      median: summary.median,
      range: summary.range,
      trend: trendOf(windowRows, level, request.periodDays, request.today),
    };
  }
  return { status: "insufficient" };
}

/**
 * Ce qui se publie pour une clé produit et une période. `rows` : les relevés des annonces de la catégorie, de la marque et du modèle demandés (n'importe quelle variante, n'importe
 * quel état), bruts OU déjà réduits au dernier relevé de chaque annonce par période et par bloc de la tendance (la lecture SQL ne renvoie que ceux-là) ; seuls ceux de la
 * période comptent. Aucun identifiant ni prix individuel n'est dans le résultat.
 */
export function computeMarketStats(rows: readonly MarketObservation[], request: MarketRequest): MarketStats {
  if (!isUtcDay(request.today)) throw new RangeError("today doit être un jour UTC AAAA-MM-JJ.");
  const from = addDays(request.today, -(request.periodDays - 1));
  const windowRows = rows.filter((row) => row.day >= from && row.day <= request.today);
  return { period: { days: request.periodDays, from, to: request.today }, listings: listingsOutcome(windowRows, request) };
}
