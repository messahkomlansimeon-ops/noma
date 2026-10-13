import "server-only";

import { MARKET_DEFAULT_PERIOD } from "../market/config";
import { marketKeyOf, readListingObservationsForMarkets, type MarketKeyParts } from "../market/reads";
import { addDays, computeMarketStats, type MarketObservation, type PublishedListings } from "../market/stats";
import type { SqlExecutor } from "../postgres/client";
import type { MarketReference } from "./indicators";
import { readMarketReferences, type MarketQuery } from "./market";
import { RELEVANCE_CONFIG } from "./relevance-config";

/**
 * Référence de prix de l'indicateur « Prix » des résultats et de la fiche (lot FIN1) : UNE SEULE référence pour l'encart « Prix demandés dans les annonces » et pour l'indicateur.
 *
 *  - Quand l'encart est PUBLIÉ pour la clé de l'annonce (catégorie, marque, modèle, variante, état ; mêmes élargissements, mêmes seuils de vendeurs, mêmes prix atypiques écartés, même
 *    période par défaut), l'indicateur se calcule par rapport à SA médiane (`computeMarketStats`, la fonction même de GET /api/market) : écart = (prix − médiane publiée) / médiane
 *    publiée, « sous / dans / au-dessus du marché » selon la fourchette publiée (Q1, Q3) ou, sans fourchette (moins de 10 vendeurs), un écart d'au plus `publishedBandPercent` de la médiane.
 *    L'annonce évaluée fait partie de son marché, comme dans l'encart (même médiane, même effectif).
 *  - Sinon (encart non publié : sous les seuils, ou prix hors XOF), repli sur le marché des offres publiées de la base (`readMarketReferences`) avec une clé qui INCLUT la variante et
 *    l'état de l'annonce (une variante ou un état absent est confondu). Jamais « Marché insuffisant » à côté d'un encart rempli.
 * Lecture seule ; une requête de clés normalisées par la base (`price_key_part`) et une de relevés pour tous les marchés de la page (jamais une par annonce).
 */

/** Une annonce dont on veut la référence de prix : sa clé produit (catégorie, marque, modèle, variante, état) et sa devise. */
export type PriceReferenceQuery = MarketQuery;

interface KeyRow {
  offer_id: string;
  category: string;
  brand: string;
  model: string;
  variant: string | null;
  condition: string | null;
}

/** Référence tirée de l'encart publié : la médiane publiée et, comme p25 et p75, la fourchette publiée ou, sans elle, la médiane ± `publishedBandPercent` %. */
export function referenceFromPublished(listings: PublishedListings): MarketReference {
  const band = RELEVANCE_CONFIG.price.publishedBandPercent / 100;
  const { median, range } = listings;
  return {
    sampleSize: listings.count.kind === "approx" ? listings.count.value : listings.count.bound,
    p25: range === null ? median * (1 - band) : range.q1,
    median,
    p75: range === null ? median * (1 + band) : range.q3,
    source: "published",
  };
}

/**
 * Une référence de prix par annonce demandée (entrée pour chacune). « Aujourd'hui » (jour UTC qui termine la période) est celui de l'horloge de la base, comme dans la route des prix
 * demandés : ni l'instant d'un curseur de pagination ni l'horloge du processus n'interviennent.
 */
export async function readPriceReferences(client: SqlExecutor, queries: readonly PriceReferenceQuery[]): Promise<Map<string, MarketReference>> {
  const result = new Map<string, MarketReference>();
  if (queries.length === 0) return result;

  // Base d'avant la migration 0023 (relevés de prix et `price_key_part`) : pas d'encart, donc le marché des offres de la base seul, sans variante ni état (jamais une erreur de lecture).
  const ready = await client.query<{ ready: boolean }>("SELECT to_regclass('price_observations') IS NOT NULL AND to_regprocedure('price_key_part(text)') IS NOT NULL AS ready");
  if (ready.rows[0]?.ready !== true) return readMarketReferences(client, queries.map((query) => ({ ...query, variant: null, condition: null })));

  const eligible = queries.filter((query) => query.category && query.brand && query.model && query.currency === "XOF");
  const keys = new Map<string, KeyRow>();
  let today = "";
  if (eligible.length > 0) {
    const resolved = await client.query<KeyRow & { today: string }>(
      `SELECT r.offer_id::text AS offer_id, price_key_part(r.category) AS category, price_key_part(r.brand) AS brand, price_key_part(r.model) AS model,
              nullif(price_key_part(r.variant), '') AS variant, nullif(price_key_part(r.condition), '') AS condition,
              to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS today
         FROM unnest($1::uuid[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[]) AS r(offer_id, category, brand, model, variant, condition)`,
      [
        eligible.map((query) => query.offerId),
        eligible.map((query) => query.category),
        eligible.map((query) => query.brand),
        eligible.map((query) => query.model),
        eligible.map((query) => query.variant ?? null),
        eligible.map((query) => query.condition ?? null),
      ],
    );
    for (const row of resolved.rows) {
      keys.set(row.offer_id, row);
      today = row.today;
    }
  }
  const period = { days: MARKET_DEFAULT_PERIOD, from: today === "" ? "" : addDays(today, -(MARKET_DEFAULT_PERIOD - 1)), to: today };

  // Les marchés (catégorie, marque, modèle) de la page : relus UNE fois.
  const markets = new Map<string, MarketKeyParts>();
  for (const row of keys.values()) {
    if (row.category === "" || row.brand === "" || row.model === "") continue;
    markets.set(marketKeyOf(row), { category: row.category, brand: row.brand, model: row.model });
  }
  const observations: Map<string, MarketObservation[]> = markets.size > 0 ? await readListingObservationsForMarkets(client, [...markets.values()], period) : new Map();

  // Le même calcul que la route des prix demandés, une fois par (marché, variante, état).
  const memo = new Map<string, PublishedListings | null>();
  const fallback: PriceReferenceQuery[] = [];
  for (const query of queries) {
    const key = keys.get(query.offerId);
    let published: PublishedListings | null = null;
    if (key !== undefined && key.category !== "" && key.brand !== "" && key.model !== "") {
      const marketKey = marketKeyOf(key);
      const memoKey = JSON.stringify([marketKey, key.variant, key.condition]);
      if (!memo.has(memoKey)) {
        const stats = computeMarketStats(observations.get(marketKey) ?? [], {
          periodDays: period.days,
          today,
          variantKey: key.variant,
          conditionKey: key.condition,
          display: { model: key.model, variant: key.variant, condition: key.condition },
          allowWidening: true,
        });
        memo.set(memoKey, stats.listings.status === "published" ? stats.listings : null);
      }
      published = memo.get(memoKey) ?? null;
    }
    if (published !== null) result.set(query.offerId, referenceFromPublished(published));
    else fallback.push(query);
  }

  if (fallback.length > 0) {
    const live = await readMarketReferences(client, fallback);
    for (const [offerId, reference] of live) result.set(offerId, reference);
  }
  return result;
}
