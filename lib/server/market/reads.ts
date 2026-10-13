import "server-only";

import type { SqlExecutor } from "../postgres/client";
import { roundCount, type StatCount } from "../metrics/privacy";
import { MARKET_ADMIN_KEY_LIMIT, MARKET_ADMIN_PERIOD, MARKET_PERIODS, MARKET_TREND_BLOCK_DAYS, type MarketPeriod } from "./config";
import { addDays, computeMarketStats, isUtcDay, type ListingsOutcome, type MarketObservation, type MarketStats } from "./stats";

/**
 * Lectures SQL des statistiques de marché (lots H1 et H1-bis). La base FILTRE (catégorie, marque, modèle normalisés par `price_key_part`, période) et RÉDUIT : elle ne renvoie, pour
 * chaque annonce, que son dernier relevé de la période et son dernier relevé de chaque bloc de 7 jours de la tendance (`DISTINCT ON`), donc au plus (1 + blocs) lignes par annonce quel
 * que soit le nombre de jours observés : le nombre de lignes lues est borné par le nombre d'annonces, jamais refusé ni tronqué. Tout le reste (niveaux de comparabilité, prix
 * atypiques, seuils, arrondis, médiane, tendance) est calculé par les fonctions pures de `stats.ts`, les mêmes que celles que l'adversaire met à l'épreuve. Seuls les relevés d'ANNONCES
 * sont lus : aucun prix de vente ne sort jamais d'ici (l'administration lit un NOMBRE de ventes confirmées, arrondi). Les identifiants des vendeurs sont lus pour compter des vendeurs
 * distincts : ils ne sortent jamais de ces fonctions.
 */

export class MarketError extends Error {
  constructor(readonly code: "invalid_query", message: string) {
    super(message);
    this.name = "MarketError";
  }
}

export interface MarketQueryInput {
  category: string;
  brand: string;
  model: string;
  /** Variante demandée ; `null` ou absente : toutes. */
  variant?: string | null;
  /** État demandé ; `null` ou absent : tous. */
  condition?: string | null;
  periodDays: MarketPeriod;
  /** Instant de référence (réservé aux tests) ; sinon l'horloge de la base. */
  now?: Date;
  /** Faux : la clé exacte seule (tableau d'administration). */
  allowWidening?: boolean;
}

interface KeyRow {
  category: string;
  brand: string;
  model: string;
  variant: string | null;
  condition: string | null;
  today: string;
}

interface ObservationRow {
  reference_id: string;
  seller_id: string | null;
  day: string;
  price_xof: string;
  variant_key: string;
  condition_key: string;
}

const INSUFFICIENT: ListingsOutcome = { status: "insufficient" };

function requirePeriod(value: unknown): MarketPeriod {
  if (!(MARKET_PERIODS as readonly unknown[]).includes(value)) throw new MarketError("invalid_query", "période invalide.");
  return value as MarketPeriod;
}

/**
 * Les relevés d'ANNONCES d'un marché (catégorie, marque, modèle déjà NORMALISÉS) sur la période, RÉDUITS par la base : le dernier relevé de chaque annonce par bloc de 7 jours de la
 * tendance (les `période mod 7` jours les plus anciens forment le bloc −1). Le dernier relevé de la période de chaque annonce est le dernier de son bloc le plus récent : il figure
 * donc dans le résultat. Au plus (1 + blocs) lignes par annonce.
 */
export async function readListingObservations(
  db: SqlExecutor,
  keys: { category: string; brand: string; model: string },
  period: { from: string; to: string; days: MarketPeriod },
): Promise<MarketObservation[]> {
  const blocks = Math.floor(period.days / MARKET_TREND_BLOCK_DAYS);
  const trendStart = addDays(period.to, -(MARKET_TREND_BLOCK_DAYS * blocks - 1));
  const rows = await db.query<ObservationRow>(
    `WITH win AS (
       SELECT id, reference_id, seller_id, price_xof, variant_key, condition_key, observed_on,
              CASE WHEN observed_on >= $6::date THEN (observed_on - $6::date) / $7::int ELSE -1 END AS block
         FROM price_observations
        WHERE source = 'listing' AND category_key = $1::text AND brand_key = $2::text AND model_key = $3::text AND observed_on BETWEEN $4::date AND $5::date
     )
     SELECT DISTINCT ON (reference_id, block) reference_id::text AS reference_id, seller_id::text AS seller_id, to_char(observed_on, 'YYYY-MM-DD') AS day,
            price_xof::text AS price_xof, variant_key, condition_key
       FROM win
      ORDER BY reference_id, block, observed_on DESC, id DESC`,
    [keys.category, keys.brand, keys.model, period.from, period.to, trendStart, MARKET_TREND_BLOCK_DAYS],
  );
  return rows.rows.map((row) => ({
    referenceId: row.reference_id,
    sellerId: row.seller_id,
    day: row.day,
    priceXof: Number(row.price_xof),
    variantKey: row.variant_key,
    conditionKey: row.condition_key,
  }));
}

/** Un marché : catégorie, marque et modèle déjà NORMALISÉS (`price_key_part`). */
export interface MarketKeyParts {
  category: string;
  brand: string;
  model: string;
}

/** Clé d'un marché dans les résultats de `readListingObservationsForMarkets`. */
export const marketKeyOf = (key: MarketKeyParts): string => JSON.stringify([key.category, key.brand, key.model]);

/**
 * Les mêmes relevés que `readListingObservations`, pour PLUSIEURS marchés en une seule requête (la lecture des résultats d'un besoin en compare plusieurs : un aller-retour, jamais un par
 * annonce). Chaque marché reçoit exactement les lignes que `readListingObservations` lui donnerait (même réduction par annonce et par bloc) ; un marché sans relevé reçoit une liste vide.
 */
export async function readListingObservationsForMarkets(
  db: SqlExecutor,
  keys: readonly MarketKeyParts[],
  period: { from: string; to: string; days: MarketPeriod },
): Promise<Map<string, MarketObservation[]>> {
  const result = new Map<string, MarketObservation[]>();
  for (const key of keys) result.set(marketKeyOf(key), []);
  if (keys.length === 0) return result;
  const blocks = Math.floor(period.days / MARKET_TREND_BLOCK_DAYS);
  const trendStart = addDays(period.to, -(MARKET_TREND_BLOCK_DAYS * blocks - 1));
  const rows = await db.query<ObservationRow & { category_key: string; brand_key: string; model_key: string }>(
    `WITH req AS (
       SELECT DISTINCT * FROM unnest($1::text[], $2::text[], $3::text[]) AS r(category_key, brand_key, model_key)
     ), win AS (
       SELECT p.id, p.category_key, p.brand_key, p.model_key, p.reference_id, p.seller_id, p.price_xof, p.variant_key, p.condition_key, p.observed_on,
              CASE WHEN p.observed_on >= $6::date THEN (p.observed_on - $6::date) / $7::int ELSE -1 END AS block
         FROM price_observations p
         JOIN req r ON r.category_key = p.category_key AND r.brand_key = p.brand_key AND r.model_key = p.model_key
        WHERE p.source = 'listing' AND p.observed_on BETWEEN $4::date AND $5::date
     )
     SELECT DISTINCT ON (category_key, brand_key, model_key, reference_id, block) category_key, brand_key, model_key, reference_id::text AS reference_id, seller_id::text AS seller_id,
            to_char(observed_on, 'YYYY-MM-DD') AS day, price_xof::text AS price_xof, variant_key, condition_key
       FROM win
      ORDER BY category_key, brand_key, model_key, reference_id, block, observed_on DESC, id DESC`,
    [keys.map((key) => key.category), keys.map((key) => key.brand), keys.map((key) => key.model), period.from, period.to, trendStart, MARKET_TREND_BLOCK_DAYS],
  );
  for (const row of rows.rows) {
    const list = result.get(marketKeyOf({ category: row.category_key, brand: row.brand_key, model: row.model_key }));
    if (list === undefined) continue;
    list.push({
      referenceId: row.reference_id,
      sellerId: row.seller_id,
      day: row.day,
      priceXof: Number(row.price_xof),
      variantKey: row.variant_key,
      conditionKey: row.condition_key,
    });
  }
  return result;
}

/** Normalise les parties de la clé AVEC LA FONCTION DE LA BASE (une seule définition de la normalisation, celle qui a écrit les relevés) et lit « aujourd'hui » (jour UTC). */
async function resolveKey(db: SqlExecutor, input: MarketQueryInput): Promise<KeyRow> {
  const result = await db.query<KeyRow>(
    `SELECT price_key_part($1::text) AS category, price_key_part($2::text) AS brand, price_key_part($3::text) AS model,
            nullif(price_key_part($4::text), '') AS variant, nullif(price_key_part($5::text), '') AS condition,
            to_char(COALESCE($6::timestamptz, clock_timestamp()) AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS today`,
    [input.category, input.brand, input.model, input.variant ?? null, input.condition ?? null, input.now ?? null],
  );
  return result.rows[0];
}

function cleanDisplay(value: string | null | undefined): string | null {
  const text = (value ?? "").replace(/\s+/g, " ").trim();
  return text === "" ? null : text;
}

/** Statistiques des prix demandés pour une clé produit et une période : exactement ce qui peut être publié (voir `stats.ts`). */
export async function readMarketStats(db: SqlExecutor, input: MarketQueryInput): Promise<MarketStats> {
  const periodDays = requirePeriod(input.periodDays);
  const key = await resolveKey(db, input);
  if (!isUtcDay(key.today)) throw new MarketError("invalid_query", "jour invalide.");
  const from = addDays(key.today, -(periodDays - 1));
  const model = cleanDisplay(input.model);
  // Une catégorie, une marque ou un modèle absent n'a pas de marché (comme l'indicateur de prix du matching).
  if (key.category === "" || key.brand === "" || key.model === "" || model === null) {
    return { period: { days: periodDays, from, to: key.today }, listings: INSUFFICIENT };
  }
  const rows = await readListingObservations(db, key, { from, to: key.today, days: periodDays });
  return computeMarketStats(rows, {
    periodDays,
    today: key.today,
    variantKey: key.variant,
    conditionKey: key.condition,
    display: { model, variant: cleanDisplay(input.variant), condition: cleanDisplay(input.condition) },
    allowWidening: input.allowWidening,
  });
}

// ───────────── administration : les clés produit les plus relevées ─────────────

export interface AdminMarketRow {
  /** Libellé du dernier relevé de la clé (casse du vendeur). */
  label: string;
  /** Prix demandés : mêmes seuils, mêmes arrondis que la route publique, sur la clé exacte. */
  listings: ListingsOutcome;
  /** Ventes confirmées de la clé sur la période, celles d'une commande réelle de la base : un NOMBRE arrondi (jamais un prix, jamais un compte exact). */
  confirmedSales: StatCount;
  /**
   * Lot FIN1 : ventes de l'HISTORIQUE DE DÉMONSTRATION de la clé sur la période, arrondies comme les autres mesures : un relevé de vente que ne justifie aucune commande de la base (ceux que
   * `demo:seed` écrit directement). Elles ne sont jamais ajoutées aux ventes confirmées (l'aperçu de l'administration compte les commandes réelles) : l'écran les étiquette à part.
   */
  historicalSales: StatCount;
}

interface RankedKeyRow {
  category_key: string;
  brand_key: string;
  model_key: string;
  variant_key: string;
  condition_key: string;
  label: string;
  sales: number;
  historical_sales: number;
}

/**
 * Les `MARKET_ADMIN_KEY_LIMIT` clés produit (catégorie, marque, modèle, variante, état) les plus relevées sur les 90 derniers jours. Prix demandés : les MÊMES seuils, arrondis et règles
 * que la route publique, sur la clé EXACTE (sans élargissement : une clé sous les seuils reste listée, « Pas assez de données »). Ventes confirmées : seulement leur NOMBRE arrondi
 * (`roundCount`), jamais un prix.
 */
export async function readAdminMarket(db: SqlExecutor, options: { now?: Date } = {}): Promise<{ period: MarketStats["period"]; rows: AdminMarketRow[] }> {
  const today = (
    await db.query<{ today: string }>("SELECT to_char(COALESCE($1::timestamptz, clock_timestamp()) AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS today", [options.now ?? null])
  ).rows[0].today;
  const days = MARKET_ADMIN_PERIOD;
  const from = addDays(today, -(days - 1));
  const ranked = await db.query<RankedKeyRow>(
    `SELECT p.category_key, p.brand_key, p.model_key, p.variant_key, p.condition_key,
            (array_agg(p.label ORDER BY p.observed_on DESC, p.id DESC))[1] AS label,
            (count(DISTINCT p.reference_id) FILTER (WHERE p.source = 'sale' AND o.id IS NOT NULL))::int AS sales,
            (count(DISTINCT p.reference_id) FILTER (WHERE p.source = 'sale' AND o.id IS NULL))::int AS historical_sales
       FROM price_observations p
       LEFT JOIN orders o ON p.source = 'sale' AND o.id = p.reference_id
      WHERE p.observed_on BETWEEN $1::date AND $2::date
      GROUP BY p.category_key, p.brand_key, p.model_key, p.variant_key, p.condition_key
      ORDER BY count(*) DESC, p.category_key, p.brand_key, p.model_key, p.variant_key, p.condition_key
      LIMIT $3::int`,
    [from, today, MARKET_ADMIN_KEY_LIMIT],
  );
  // Un seul chargement par marché (catégorie, marque, modèle) : plusieurs clés de la liste en partagent souvent un.
  const markets = new Map<string, MarketObservation[]>();
  const rows: AdminMarketRow[] = [];
  for (const key of ranked.rows) {
    const marketKey = JSON.stringify([key.category_key, key.brand_key, key.model_key]);
    let observations = markets.get(marketKey);
    if (!observations) {
      observations = await readListingObservations(db, { category: key.category_key, brand: key.brand_key, model: key.model_key }, { from, to: today, days });
      markets.set(marketKey, observations);
    }
    const stats = computeMarketStats(observations, {
      periodDays: days,
      today,
      variantKey: key.variant_key,
      conditionKey: key.condition_key,
      display: { model: key.model_key, variant: key.variant_key === "" ? null : key.variant_key, condition: key.condition_key === "" ? null : key.condition_key },
      allowWidening: false,
    });
    rows.push({ label: key.label, listings: stats.listings, confirmedSales: roundCount(key.sales), historicalSales: roundCount(key.historical_sales) });
  }
  return { period: { days, from, to: today }, rows };
}
