/**
 * Partie PURE de l'historique de prix de `npm run demo:seed` (lots H1 et H1-ter) : aucun accès à la base, aucun module serveur. Elle fabrique, pour chaque produit de démonstration,
 * 90 jours de relevés SYNTHÉTIQUES cohérents (annonces fictives qui se renouvellent, avec des baisses de prix, et ventes fictives entre les vendeurs et les acheteurs fictifs : les ventes ne sont JAMAIS publiées, l'administration n'en voit que le nombre arrondi),
 * pour que l'encart « Prix demandés dans les annonces » soit rempli pendant la démonstration. Testée sans base (tests/scripts/demo-seed.test.ts).
 *
 * Tout est une fonction du JOUR UTC ABSOLU et du produit (jamais de l'instant de lancement) : relancer la commande, ce jour-là ou un autre, réécrit exactement les mêmes lignes
 * pour les mêmes jours (identifiants stables) ; les jours déjà présents sont ignorés (`ON CONFLICT DO NOTHING`), les nouveaux jours s'ajoutent. Les identifiants d'annonce et de
 * commande sont fictifs (aucune annonce ni commande de la base ne leur correspond : un relevé est un fait historique, sans clé étrangère).
 *
 * Cohérence : le prix demandé d'un produit baisse lentement avec le temps (−0,08 % par jour, de +7 % il y a 90 jours à 0 % le jour de référence), chaque annonce fictive est en ligne
 * 30 jours sur 36 et baisse son prix de 5 % après 18 jours ; les ventes se concluent 5 à 10 % sous le prix demandé. Les vendeurs et les acheteurs sont tournés pour que sept jours de
 * ventes consécutifs aient 7 vendeurs et 7 acheteurs distincts (des acteurs variés pour le nombre de ventes confirmées de l'administration).
 *
 * Lot H1-ter : l'unité statistique est le VENDEUR (HISTORIQUE-PRIX.md), un point de tendance exige 20 vendeurs distincts dans la semaine. Les annonces fictives sont donc réparties entre
 * 24 vendeurs fictifs (les 7 comptes vendeurs, les 11 comptes acheteurs fictifs, qui vendent aussi : n'importe qui peut vendre, et 6 comptes fictifs de l'historique des prix), tournés pour que 24 places en parallèle aient 24
 * vendeurs différents : les produits très présents (24 places, une par vendeur) comptent 24 vendeurs chaque semaine, les autres (12 places) 12 vendeurs. Les ventes restent entre les 7 vendeurs et les acheteurs.
 */
import { createHash } from "node:crypto";
import { DEMO_EXTRA_BUYER_COUNT, DEMO_HISTORY_SELLER_COUNT, DEMO_OFFERS, type DemoOffer } from "./demo-seed-plan";

/** Nombre de jours d'historique synthétique (les 89 jours AVANT aujourd'hui ; aujourd'hui est relevé par les vraies annonces : 90 jours en tout). */
export const DEMO_MARKET_HISTORY_DAYS = 90;
/** Jour de référence du prix de base (le prix de base est celui de ce jour ; avant lui, plus cher ; après lui, un peu moins cher). */
export const DEMO_MARKET_ANCHOR_DAY = "2026-10-07";
export const DEMO_MARKET_DRIFT_PER_DAY = 0.0008;
/** Vendeurs fictifs des VENTES (les 7 comptes vendeurs). */
export const DEMO_MARKET_FICTIVE_SELLERS = 7;
/**
 * Vendeurs fictifs des ANNONCES : les 7 comptes vendeurs (n° 1 à 7), les 11 comptes acheteurs fictifs (n° 8 à 18), puis les 6 comptes fictifs de l'historique des prix (n° 19 à 24). Au moins 22 exigés, 24 donnés : avec 22, les prix atypiques écartés d'une semaine ôtaient un point de tendance dans 5 cas sur 120 (produit phare, jour de lancement) ;
 * soit davantage que le minimum d'un point de la tendance (20, `MARKET_TREND_MIN_SELLERS`) : de la marge pour les prix atypiques écartés d'une semaine.
 */
export const DEMO_MARKET_LISTING_SELLERS = 7 + DEMO_EXTRA_BUYER_COUNT + DEMO_HISTORY_SELLER_COUNT;
export const DEMO_MARKET_CYCLE_DAYS = 36;
export const DEMO_MARKET_ONLINE_DAYS = 30;
export const DEMO_MARKET_MARKDOWN_AFTER_DAYS = 18;
/**
 * Annonces fictives en parallèle d'un produit très présent (iPhone 12 128 Go d'occasion, Galaxy S21 128 Go d'occasion) : 24 places, UNE par vendeur fictif, donc 24 vendeurs chaque semaine
 * (une place en ligne 30 jours sur 36 compte toujours au moins une annonce dans chaque semaine), au moins 20, le minimum d'un point de la tendance (HISTORIQUE-PRIX.md). Une annonce
 * par vendeur et par semaine, et non plusieurs : la valeur d'un vendeur est la médiane de SES annonces, et plusieurs annonces par vendeur resserraient les valeurs au point que l'écart
 * interquartile écartait comme « atypiques » jusqu'à un tiers des vendeurs d'une semaine (mesuré : points de tendance manquants).
 */
export const DEMO_MARKET_POPULAR_SLOTS = DEMO_MARKET_LISTING_SELLERS;
/**
 * Annonces fictives en parallèle des autres produits : 12 places de 12 vendeurs fictifs différents. Six places ne suffisaient pas (une valeur par vendeur : deux prix atypiques écartés sur six
 * laissent 4 vendeurs, sous le seuil de 5) ; douze laissent toujours de la marge pour la médiane, la fourchette (10 vendeurs) apparaît le plus souvent, et la tendance (20 vendeurs par semaine)
 * n'est jamais publiée pour ces produits.
 */
export const DEMO_MARKET_NICHE_SLOTS = 12;

export interface DemoMarketGroup {
  key: string;
  category: string;
  brand: string;
  model: string;
  variant: string | null;
  condition: string;
  /** Libellé de la clé, au format de la base (`price_obs_label`) : « Apple iPhone 12 · 128 Go · Occasion ». */
  label: string;
  /** Prix de base (FCFA) : la médiane des annonces de démonstration du produit. */
  basePriceXof: number;
  /** Annonces fictives en parallèle. */
  listingSlots: number;
  /** Probabilité d'une vente par jour (1 : une chaque jour). */
  salesPerDay: number;
}

export interface DemoMarketRow {
  source: "listing" | "sale";
  referenceId: string;
  /** Jour UTC AAAA-MM-JJ. */
  day: string;
  group: DemoMarketGroup;
  priceXof: number;
  /** Vendeur fictif n° 1 à 24 pour une annonce (1 à 7 : comptes vendeurs, 8 à 18 : comptes acheteurs fictifs n° 1 à 11, 19 à 24 : comptes de l'historique des prix n° 1 à 6) ; n° 1 à 7 pour une vente. */
  sellerIndex: number;
  /** Acheteur fictif n° 1 à 11 (relevé de vente seulement). */
  buyerIndex: number | null;
}

/**
 * Compte d'un vendeur fictif de l'historique de prix : n° 1 à 7 : les comptes vendeurs ; n° 8 à 18 : les comptes acheteurs fictifs n° 1 à 11 (ils vendent aussi dans l'historique) ; n° 19 à 24 :
 * les comptes fictifs de l'historique des prix n° 1 à 6 (pour que les produits phares comptent au moins 22 vendeurs distincts par semaine, au-dessus du minimum de 20 d'un point de tendance).
 */
export function marketSellerId(
  world: { sellerIds: ReadonlyMap<number, string>; extraBuyerIds: readonly string[]; historySellerIds: readonly string[] },
  sellerIndex: number,
): string {
  const afterBuyers = DEMO_MARKET_FICTIVE_SELLERS + DEMO_EXTRA_BUYER_COUNT;
  const id = sellerIndex <= DEMO_MARKET_FICTIVE_SELLERS
    ? world.sellerIds.get(sellerIndex)
    : sellerIndex <= afterBuyers ? world.extraBuyerIds[sellerIndex - DEMO_MARKET_FICTIVE_SELLERS - 1] : world.historySellerIds[sellerIndex - afterBuyers - 1];
  if (!Number.isInteger(sellerIndex) || sellerIndex < 1 || sellerIndex > DEMO_MARKET_LISTING_SELLERS || id === undefined) throw new RangeError(`vendeur fictif n° ${sellerIndex} inconnu.`);
  return id;
}

export function dayIndexOf(day: string): number {
  const time = Date.parse(`${day}T00:00:00.000Z`);
  if (!Number.isFinite(time)) throw new RangeError("jour UTC invalide.");
  return Math.round(time / 86_400_000);
}

/** Jour UTC décalé de `days` jours (négatif : avant). */
export function addDaysToIndex(day: string, days: number): string {
  return dayOfIndex(dayIndexOf(day) + days);
}

export function dayOfIndex(index: number): string {
  return new Date(index * 86_400_000).toISOString().slice(0, 10);
}

/** Nombre pseudo-aléatoire stable dans [0, 1) pour une suite de parties. */
export function unit(...parts: Array<string | number>): number {
  const hex = createHash("sha256").update(`noma-demo-market:${parts.join("|")}`).digest("hex");
  return parseInt(hex.slice(0, 12), 16) / 2 ** 48;
}

/** Identifiant stable de forme UUID v4 d'un relevé fictif. */
export function demoMarketReference(...parts: Array<string | number>): string {
  const hex = createHash("sha256").update(`noma-demo-market-ref:${parts.join("|")}`).digest("hex");
  const variant = ((parseInt(hex.slice(16, 18), 16) & 0x3f) | 0x80).toString(16).padStart(2, "0");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(18, 20)}-${hex.slice(20, 32)}`;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

const roundTo500 = (value: number): number => Math.max(500, Math.round(value / 500) * 500);

function groupKeyOf(offer: DemoOffer): string {
  return [offer.category, offer.brand, offer.model, offer.variant ?? "", offer.condition].join("|");
}

function labelOf(offer: DemoOffer): string {
  return [`${offer.brand} ${offer.model}`, offer.variant, offer.condition].filter((part): part is string => part !== null && part !== "").join(" · ");
}

/**
 * Les produits de démonstration : un par (catégorie, marque, modèle, variante, état) des annonces de démonstration. Les produits les plus présents (au moins 6 annonces de démonstration) ont
 * 18 annonces fictives en parallèle (une courbe de tendance hebdomadaire) et une vente par jour ou presque ; les autres douze annonces et une vente tous les deux jours environ.
 */
export function demoMarketGroups(): DemoMarketGroup[] {
  const grouped = new Map<string, DemoOffer[]>();
  for (const offer of DEMO_OFFERS) grouped.set(groupKeyOf(offer), [...(grouped.get(groupKeyOf(offer)) ?? []), offer]);
  const groups: DemoMarketGroup[] = [];
  for (const [key, offers] of grouped) {
    const first = offers[0];
    const popular = offers.length >= 6;
    groups.push({
      key,
      category: first.category,
      brand: first.brand,
      model: first.model,
      variant: first.variant,
      condition: first.condition,
      label: labelOf(first),
      basePriceXof: median(offers.map((offer) => offer.priceXof)),
      listingSlots: popular ? DEMO_MARKET_POPULAR_SLOTS : DEMO_MARKET_NICHE_SLOTS,
      salesPerDay: popular ? 1 : offers.length >= 3 ? 0.7 : 0.45,
    });
  }
  return groups.sort((a, b) => a.key.localeCompare(b.key));
}

/** Prix de base d'un produit un jour donné : −0,08 % par jour par rapport au jour de référence (borné de 80 % à 120 %). */
export function basePriceOn(group: DemoMarketGroup, dayIndex: number): number {
  const factor = 1 + DEMO_MARKET_DRIFT_PER_DAY * (dayIndexOf(DEMO_MARKET_ANCHOR_DAY) - dayIndex);
  return group.basePriceXof * Math.min(1.2, Math.max(0.8, factor));
}

/** Décalage d'un produit dans le cycle des annonces (étale les renouvellements d'un produit à l'autre). */
function groupOffset(group: DemoMarketGroup): number {
  return Math.floor(unit(group.key, "offset") * DEMO_MARKET_CYCLE_DAYS);
}

/**
 * Les relevés synthétiques des `DEMO_MARKET_HISTORY_DAYS − 1` jours qui précèdent `today` (jour UTC) : annonces fictives (un relevé par annonce et par jour en ligne) et ventes.
 * Pur et déterministe : mêmes entrées, mêmes lignes ; le résultat ne dépend du jour de lancement que par la liste des jours.
 */
export function buildDemoMarketHistory(today: string, groups: readonly DemoMarketGroup[] = demoMarketGroups()): DemoMarketRow[] {
  const todayIndex = dayIndexOf(today);
  const rows: DemoMarketRow[] = [];
  for (let dayIndex = todayIndex - (DEMO_MARKET_HISTORY_DAYS - 1); dayIndex < todayIndex; dayIndex += 1) {
    const day = dayOfIndex(dayIndex);
    for (const group of groups) {
      const offset = groupOffset(group);
      // Annonces fictives : la place j est en ligne 30 jours sur 36 ; chaque passage en ligne est UNE annonce (identifiant propre).
      for (let slot = 0; slot < group.listingSlots; slot += 1) {
        const shifted = dayIndex + slot * 5 + offset;
        const cycle = Math.floor(shifted / DEMO_MARKET_CYCLE_DAYS);
        const age = shifted - cycle * DEMO_MARKET_CYCLE_DAYS;
        if (age >= DEMO_MARKET_ONLINE_DAYS) continue;
        const startIndex = dayIndex - age;
        const asking = basePriceOn(group, startIndex) * (0.94 + 0.12 * unit(group.key, "listing-price", slot, cycle));
        const price = roundTo500(age >= DEMO_MARKET_MARKDOWN_AFTER_DAYS ? asking * 0.95 : asking);
        rows.push({
          source: "listing",
          referenceId: demoMarketReference(group.key, "listing", slot, cycle),
          day,
          group,
          priceXof: price,
          sellerIndex: ((slot + Math.floor(unit(group.key, "listing-seller") * DEMO_MARKET_LISTING_SELLERS)) % DEMO_MARKET_LISTING_SELLERS) + 1,
          buyerIndex: null,
        });
      }
      // Ventes fictives : une vente ce jour-là avec la probabilité du produit ; vendeurs et acheteurs tournés.
      if (unit(group.key, "sale-day", dayIndex) < group.salesPerDay) {
        const sold = basePriceOn(group, dayIndex) * (0.9 + 0.1 * unit(group.key, "sale-price", dayIndex));
        rows.push({
          source: "sale",
          referenceId: demoMarketReference(group.key, "sale", dayIndex),
          day,
          group,
          priceXof: roundTo500(sold),
          sellerIndex: ((dayIndex + Math.floor(unit(group.key, "sale-seller") * DEMO_MARKET_FICTIVE_SELLERS)) % DEMO_MARKET_FICTIVE_SELLERS) + 1,
          buyerIndex: ((3 * dayIndex + Math.floor(unit(group.key, "sale-buyer") * DEMO_EXTRA_BUYER_COUNT)) % DEMO_EXTRA_BUYER_COUNT) + 1,
        });
      }
    }
  }
  return rows;
}
