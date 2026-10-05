import "server-only";

import type { SqlExecutor } from "../postgres/client";
import type { MarketReference } from "./indicators";

/**
 * Marché observé INTERNE (offres publiées de la base), pour l'indicateur de prix. Lecture seule.
 *
 * Clé de regroupement : (lower(btrim(category)), lower(btrim(brand)), lower(btrim(model)), price_currency). La
 * VARIANTE est ignorée en v1 (iPhone 13 « 128 Go » et « 256 Go » partagent le même marché) : documenté dans
 * MATCHING-RELEVANCE.md. Une clé dont la catégorie, la marque ou le modèle est absent n'a pas de marché.
 */
export interface MarketQuery {
  /** Offre évaluée : elle est EXCLUE de SON PROPRE marché. Sert aussi de clé du résultat. */
  offerId: string;
  category: string | null;
  brand: string | null;
  model: string | null;
  /** Devise du prix de l'offre ; seules les offres de même devise comptent. */
  currency: string | null;
}

/**
 * Une seule requête pour toute une page : pour chaque offre demandée, échantillon et percentiles (p25, médiane, p75,
 * `percentile_cont`) des offres retenues de la même clé, HORS cette offre (jointure d'exclusion : un percentile ne se
 * « soustrait » pas, il est recalculé sans l'offre). Offres retenues : publiées, non archivées, disponibilité ≠
 * `unavailable` (NULL accepté), propriétaire actif et non archivé, prix renseigné, même devise.
 * Renvoie une entrée par offre demandée (échantillon 0 et percentiles nuls si aucun marché).
 */
export async function readMarketReferences(
  client: SqlExecutor,
  queries: readonly MarketQuery[],
): Promise<Map<string, MarketReference>> {
  const result = new Map<string, MarketReference>();
  const usable = queries.filter((query) => query.category && query.brand && query.model && query.currency);
  for (const query of queries) result.set(query.offerId, { sampleSize: 0, p25: null, median: null, p75: null });
  if (usable.length === 0) return result;

  const rows = await client.query<{ offer_id: string; n: number; p25: number | null; median: number | null; p75: number | null }>(
    `WITH req AS (
       SELECT * FROM unnest($1::uuid[], $2::text[], $3::text[], $4::text[], $5::text[]) AS r(offer_id, category, brand, model, currency)
     )
     SELECT r.offer_id,
            count(m.id)::int AS n,
            percentile_cont(0.25) WITHIN GROUP (ORDER BY m.price_amount) AS p25,
            percentile_cont(0.5)  WITHIN GROUP (ORDER BY m.price_amount) AS median,
            percentile_cont(0.75) WITHIN GROUP (ORDER BY m.price_amount) AS p75
       FROM req r
       LEFT JOIN offers m
         ON lower(btrim(m.category)) = lower(btrim(r.category))
        AND lower(btrim(m.brand)) = lower(btrim(r.brand))
        AND lower(btrim(m.model)) = lower(btrim(r.model))
        AND m.price_currency = r.currency
        AND m.id <> r.offer_id
        AND m.status = 'published'
        AND m.archived_at IS NULL
        AND m.availability_status IS DISTINCT FROM 'unavailable'
        AND m.price_amount IS NOT NULL
        AND m.owner_id IN (SELECT id FROM users WHERE status = 'active' AND archived_at IS NULL)
      GROUP BY r.offer_id`,
    [
      usable.map((query) => query.offerId),
      usable.map((query) => query.category),
      usable.map((query) => query.brand),
      usable.map((query) => query.model),
      usable.map((query) => query.currency),
    ],
  );
  for (const row of rows.rows) {
    result.set(row.offer_id, {
      sampleSize: row.n,
      p25: row.p25 === null ? null : Number(row.p25),
      median: row.median === null ? null : Number(row.median),
      p75: row.p75 === null ? null : Number(row.p75),
    });
  }
  return result;
}
