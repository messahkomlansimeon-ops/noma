/**
 * Présentation des prix DEMANDÉS dans les annonces (lots H1, H1-bis et H1-ter) : fonctions PURES, sans React, testées isolément. Trois endroits : l'encart « Prix demandés dans les annonces »
 * de la fiche d'une annonce (acheteur), l'indication du formulaire d'annonce (vendeur) et le tableau « Marché » de l'administration.
 *
 * Règles de présentation (en mots simples, honnêtes) :
 *  - ce sont des prix DEMANDÉS par les vendeurs, jamais des prix payés : l'écran ne dit jamais « prix du marché » seul, et AUCUN prix de vente n'est montré (les ventes ne sont pas publiées ;
 *    seule l'administration voit un NOMBRE de ventes confirmées, arrondi, sans prix) ;
 *  - les prix sont ceux du serveur (médiane arrondie à 500 FCFA ; fourchette arrondie en multiples de 5 % de la médiane, seulement à partir de 10 vendeurs) ; jamais de minimum ni de maximum ;
 *  - un effectif s'affiche arrondi (« environ 15 annonces d'environ 10 vendeurs », « moins de 5 annonces aux prix atypiques écartées » : jamais un compte exact) ;
 *  - la période et la comparabilité sont toujours dites (« Sur les 90 derniers jours », « Comparé à : iPhone 12, tous états confondus ») ;
 *  - une source sous les seuils de confidentialité : « Pas assez de données » (aucun chiffre) ;
 *  - la mini-courbe est un tracé SVG calculé ici (`sparklineGeometry`), sans bibliothèque.
 */

import { formatFcfa } from "./wallet-view";
import type { MarketCount, MarketListings, MarketPeriodDays, MarketQuery, MarketStats, MarketTrendPoint } from "./market-api";
import { cleanMarketParameter } from "./market-api";
import { countText } from "./metrics-view";

export const MARKET_CARD_TITLE = "Prix demandés dans les annonces";
export const MARKET_ASKING_NOTE = "Ce sont des prix demandés par les vendeurs, pas des prix payés.";
export const MARKET_INSUFFICIENT_TEXT = "Pas assez de données";
export const MARKET_PRIVACY_NOTE =
  "Calculé sur au moins 5 vendeurs différents, une seule valeur par vendeur (la médiane de ses annonces), prix atypiques écartés, chiffres arrondis (prix à 500 FCFA, effectifs à 5 près).";
export const MARKET_RANGE_MISSING_NOTE = "Fourchette non affichée : il faut au moins 10 vendeurs.";
export const MARKET_LOADING_TEXT = "Chargement des prix demandés…";
export const MARKET_UNAVAILABLE_TEXT = "Les prix demandés ne sont pas disponibles pour le moment.";

export const MARKET_PERIOD_CHOICES: ReadonlyArray<{ days: MarketPeriodDays; label: string }> = Object.freeze([
  { days: 30, label: "30 jours" },
  { days: 90, label: "90 jours" },
  { days: 365, label: "1 an" },
]);

/** « Sur les 30 derniers jours », « Sur la dernière année ». */
export function periodText(days: MarketPeriodDays): string {
  return days === 365 ? "Sur la dernière année" : `Sur les ${days} derniers jours`;
}

/** « 90 jours », « 1 an » (forme courte, pour l'indication du formulaire). */
export function periodShortText(days: MarketPeriodDays): string {
  return days === 365 ? "1 an" : `${days} jours`;
}

/** Produit d'une fiche (champs publics de la correspondance) → requête ; `null` si la catégorie, la marque ou le modèle manque (pas de marché sans eux). */
export function marketQueryFromProduct(
  product: { category: string | null; brand: string | null; model: string | null; variant: string | null; condition: string | null },
  periodDays?: MarketPeriodDays,
): MarketQuery | null {
  const category = cleanMarketParameter(product.category);
  const brand = cleanMarketParameter(product.brand);
  const model = cleanMarketParameter(product.model);
  if (category === null || brand === null || model === null) return null;
  const query: MarketQuery = { category, brand, model, variant: cleanMarketParameter(product.variant), condition: cleanMarketParameter(product.condition) };
  if (periodDays !== undefined) query.periodDays = periodDays;
  return query;
}

/** « 165 000 FCFA » (espace insécable entre les milliers). */
export function priceText(amountXof: number): string {
  return formatFcfa(amountXof);
}

/** « environ 15 annonces » (un effectif publié vaut toujours 5 ou plus : le pluriel ; « moins de 5 annonces » pour les écartées). */
function countWithNoun(count: MarketCount, noun: string): string {
  return `${countText(count)} ${noun}`;
}

/** « d'environ 10 vendeurs » (« de moins de 5 vendeurs » : jamais publié, un vendeur retenu vaut au moins 5). */
function sellersPhrase(count: MarketCount): string {
  return count.kind === "approx" ? `d'environ ${count.value} vendeurs` : `de moins de ${count.bound} vendeurs`;
}

/** « environ 15 annonces d'environ 10 vendeurs ». */
function listingsAndSellers(listings: MarketCount, sellers: MarketCount): string {
  return `${countWithNoun(listings, "annonces")} ${sellersPhrase(sellers)}`;
}

// ───────────── mini-courbe ─────────────

export interface SparklinePoint {
  x: number;
  y: number;
}

export interface SparklineGeometry {
  /** Tracés (commandes « M x y L x y … ») : un par suite de blocs consécutifs qui ont une médiane (un bloc sans médiane coupe le tracé). */
  paths: string[];
  /** Points tracés (un cercle chacun : un tracé d'un seul point reste visible). */
  points: SparklinePoint[];
  /** Nombre de blocs qui ont une médiane. */
  known: number;
}

/**
 * Géométrie d'une mini-courbe : abscisses réparties sur [padding, width − padding] selon le rang du bloc, ordonnées de la plus petite médiane (en bas) à la plus grande (en haut)
 * dans [padding, height − padding] ; toutes égales : une ligne à mi-hauteur. Les nombres sont arrondis à 0,1 (sortie stable). Moins de deux blocs avec médiane : aucun tracé.
 */
export function sparklineGeometry(trend: readonly MarketTrendPoint[], width: number, height: number, padding = 4): SparklineGeometry {
  const known = trend.filter((point) => point.median !== null).length;
  const empty: SparklineGeometry = { paths: [], points: [], known };
  if (!(width > 2 * padding) || !(height > 2 * padding) || trend.length < 2 || known < 2) return empty;
  const values = trend.flatMap((point) => (point.median === null ? [] : [point.median]));
  const low = Math.min(...values);
  const high = Math.max(...values);
  const round = (value: number) => Math.round(value * 10) / 10;
  const xOf = (index: number) => round(padding + ((width - 2 * padding) * index) / (trend.length - 1));
  const yOf = (value: number) => round(high === low ? height / 2 : height - padding - ((height - 2 * padding) * (value - low)) / (high - low));
  const paths: string[] = [];
  const points: SparklinePoint[] = [];
  let current: string[] = [];
  const flush = () => {
    if (current.length > 0) paths.push(current.join(" "));
    current = [];
  };
  trend.forEach((point, index) => {
    if (point.median === null) {
      flush();
      return;
    }
    const x = xOf(index);
    const y = yOf(point.median);
    points.push({ x, y });
    current.push(`${current.length === 0 ? "M" : "L"} ${x} ${y}`);
  });
  flush();
  return { paths, points, known };
}

/** Phrase de la tendance, pour un lecteur d'écran et sous la courbe : « Tendance en baisse : de 174 000 FCFA à 159 000 FCFA (médiane par semaine) » ; `null` sans courbe. */
export function trendSummary(trend: readonly MarketTrendPoint[]): string | null {
  const values = trend.flatMap((point) => (point.median === null ? [] : [point.median]));
  if (values.length < 2) return null;
  const first = values[0];
  const last = values[values.length - 1];
  const direction = last > first ? "en hausse" : last < first ? "en baisse" : "stable";
  return `Tendance ${direction} : de ${priceText(first)} à ${priceText(last)} (médiane par semaine)`;
}

// ───────────── les annonces ─────────────

export interface ListingsView {
  title: string;
  published: boolean;
  /** Médiane des prix demandés : « 165 000 FCFA » ; `null` si non publié. */
  headline: string | null;
  /**
   * « La moitié des prix demandés est entre X et Y » ; quand les deux bornes arrondies sont égales (largeur nulle), « La plupart des prix demandés sont autour de X » (jamais « entre X et X ») ;
   * `null` sans fourchette (moins de 10 vendeurs) ou non publié.
   */
  range: string | null;
  /** « Fourchette non affichée : il faut au moins 10 vendeurs. » quand la médiane est publiée sans fourchette ; sinon `null`. */
  rangeNote: string | null;
  /** « environ 15 annonces d'environ 10 vendeurs » ; `null` si non publié. */
  countText: string | null;
  /** « environ 5 annonces aux prix atypiques écartées » ; `null` quand aucune n'a été écartée ou non publié. */
  excludedText: string | null;
  /** « Comparé à : iPhone 12, tous états confondus » ; `null` si non publié. */
  comparedTo: string | null;
  /** Vrai si la comparaison a été élargie (la clé exacte n'avait pas assez de données). */
  widened: boolean;
  /** « Pas assez de données » ; `null` si publié. */
  insufficient: string | null;
  trend: MarketTrendPoint[];
  trendSummary: string | null;
}

const LISTINGS_TITLE = "Annonces en ligne";

/** Fourchette (Q1, Q3) en phrase : « entre X et Y » ; si les bornes arrondies sont égales, une fourchette de largeur nulle ne s'écrit jamais « entre X et X » : « autour de X ». */
export function rangeText(range: { q1: number; q3: number }): string {
  if (range.q1 === range.q3) return `La plupart des prix demandés sont autour de ${priceText(range.q1)}`;
  return `La moitié des prix demandés est entre ${priceText(range.q1)} et ${priceText(range.q3)}`;
}

export function listingsView(source: MarketListings): ListingsView {
  if (source.status === "insufficient") {
    return {
      title: LISTINGS_TITLE, published: false, headline: null, range: null, rangeNote: null, countText: null, excludedText: null, comparedTo: null, widened: false,
      insufficient: MARKET_INSUFFICIENT_TEXT, trend: [], trendSummary: null,
    };
  }
  return {
    title: LISTINGS_TITLE,
    published: true,
    headline: priceText(source.median),
    range: source.range === null ? null : rangeText(source.range),
    rangeNote: source.range === null ? MARKET_RANGE_MISSING_NOTE : null,
    countText: listingsAndSellers(source.count, source.sellers),
    excludedText: source.excluded === null ? null : `${countWithNoun(source.excluded, "annonces")} aux prix atypiques écartées`,
    comparedTo: source.comparedTo.text,
    widened: source.comparedTo.scope !== "exact",
    insufficient: null,
    trend: source.trend,
    trendSummary: trendSummary(source.trend),
  };
}

export interface MarketCardView {
  title: string;
  periodText: string;
  listings: ListingsView;
  /** Vrai quand les annonces n'ont pas assez de données. */
  empty: boolean;
  /** « Ce sont des prix demandés par les vendeurs, pas des prix payés. » */
  askingNote: string;
  /** Ce que contiennent les chiffres : au moins 5 vendeurs, une valeur par vendeur, prix atypiques écartés, chiffres arrondis. */
  note: string;
}

export function marketCardView(stats: MarketStats): MarketCardView {
  const listings = listingsView(stats.listings);
  return { title: MARKET_CARD_TITLE, periodText: periodText(stats.period.days), listings, empty: !listings.published, askingNote: MARKET_ASKING_NOTE, note: MARKET_PRIVACY_NOTE };
}

// ───────────── formulaire d'annonce (vendeur) ─────────────

/**
 * « Prix demandés dans les annonces pour ce produit : médiane X (environ N annonces d'environ M vendeurs, 90 jours). Comparé à : iPhone 12, tous états confondus. » La phrase de comparabilité est TOUJOURS
 * dite : elle porte « tous états confondus » tant que l'état n'est pas choisi dans le formulaire, et l'élargissement quand il a eu lieu. `null` quand les annonces n'ont pas assez de
 * données (aucune indication n'est alors affichée).
 */
export function marketHintText(stats: MarketStats): string | null {
  const source = stats.listings;
  if (source.status !== "published") return null;
  return `Prix demandés dans les annonces pour ce produit : médiane ${priceText(source.median)} (${listingsAndSellers(source.count, source.sellers)}, ${periodShortText(stats.period.days)}). ${source.comparedTo.text}.`;
}

/** Requête de l'indication du formulaire : la catégorie, la marque et le modèle sont indispensables ; l'état et la variante sont facultatifs (« confondus » tant qu'ils ne sont pas choisis). */
export function marketQueryFromForm(input: { category: string | null; brand: string; model: string; variant: string; condition: string | null }, periodDays: MarketPeriodDays = 90): MarketQuery | null {
  return marketQueryFromProduct({ category: input.category, brand: input.brand, model: input.model, variant: input.variant, condition: input.condition }, periodDays);
}

// ───────────── administration ─────────────

export const ADMIN_MARKET_TITLE = "Marché";
export const ADMIN_MARKET_EMPTY = "Aucun relevé de prix pour le moment.";
export const ADMIN_MARKET_NOTE =
  "Les 20 produits les plus relevés sur les 90 derniers jours. Prix demandés : mêmes seuils que pour les utilisateurs (sous les seuils, aucun chiffre). Ventes confirmées : un nombre arrondi, jamais un prix : les prix de vente ne sont pas publiés.";

export interface AdminMarketRowView {
  key: string;
  label: string;
  listings: ListingsView;
  /** « environ 15 ventes confirmées » / « moins de 5 ventes confirmées » : un nombre arrondi, sans aucun prix. */
  salesText: string;
}

export function adminMarketRows(rows: ReadonlyArray<{ label: string; listings: MarketListings; confirmedSales: MarketCount }>): AdminMarketRowView[] {
  return rows.map((row, index) => ({
    key: `${index}:${row.label}`,
    label: row.label,
    listings: listingsView(row.listings),
    salesText: `${countText(row.confirmedSales)} ventes confirmées`,
  }));
}
