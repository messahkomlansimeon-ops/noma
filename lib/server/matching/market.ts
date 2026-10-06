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

/** Offres retenues pour le marché : publiées, non archivées, disponibilité ≠ `unavailable` (NULL accepté), propriétaire actif et non archivé, prix et devise renseignés. */
const MARKET_OFFER_FILTER = `m.status = 'published'
        AND m.archived_at IS NULL
        AND m.availability_status IS DISTINCT FROM 'unavailable'
        AND m.price_amount IS NOT NULL
        AND m.owner_id IN (SELECT id FROM users WHERE status = 'active' AND archived_at IS NULL)`;

/**
 * `percentile_cont(p)` de PostgreSQL sur des valeurs DÉJÀ TRIÉES (float8) : position p × (n − 1), interpolation `bas + fraction × (haut − bas)` en
 * double précision, exactement la formule du serveur (`float8_lerp`) ; NULL sans valeur. Recopié ici pour calculer, par offre, le marché HORS cette offre en
 * O(n) au lieu d'une jointure O(n²) ; l'égalité avec PostgreSQL est vérifiée par un test différentiel (tests/postgres/matching-stored.integration.test.ts).
 */
export function percentileContSorted(sorted: readonly number[], percentile: number): number | null {
  const count = sorted.length;
  if (count === 0) return null;
  const position = percentile * (count - 1);
  const first = Math.floor(position);
  const second = Math.ceil(position);
  if (first === second) return sorted[first];
  return sorted[first] + (position - first) * (sorted[second] - sorted[first]);
}

interface MarketRow {
  kind: "request" | "market";
  key: string;
  offer_id: string;
  price: string | null;
}

/**
 * Une seule requête pour toute une page : pour chaque offre demandée, échantillon et percentiles (p25, médiane, p75,
 * `percentile_cont`) des offres retenues de la même clé, HORS cette offre (un percentile ne se « soustrait » pas : il est
 * recalculé sans l'offre). Offres retenues : voir `MARKET_OFFER_FILTER`, même devise. Renvoie une entrée par offre demandée
 * (échantillon 0 et percentiles nuls si aucun marché).
 *
 * Lot P3 : la requête renvoie les offres de chaque marché UNE fois (clé normalisée PAR POSTGRESQL, `lower(btrim)`, jamais en JavaScript) et le calcul
 * par offre se fait ici sur des prix triés (`percentileContSorted`) : coût linéaire au lieu d'une jointure carrée (mesuré : 23 ms pour 200 offres d'un
 * même produit, dont 39 800 lignes triées). Résultats identiques à l'ancienne requête (test différentiel sur des jeux variés).
 */
export async function readMarketReferences(
  client: SqlExecutor,
  queries: readonly MarketQuery[],
): Promise<Map<string, MarketReference>> {
  const result = new Map<string, MarketReference>();
  const usable = queries.filter((query) => query.category && query.brand && query.model && query.currency);
  for (const query of queries) result.set(query.offerId, { sampleSize: 0, p25: null, median: null, p75: null });
  if (usable.length === 0) return result;

  // Séparateur de la clé : un caractère de contrôle que ni lower() ni btrim() ne produisent à partir d'un texte d'annonce valide ; la clé n'est qu'un
  // regroupement côté JavaScript (la comparaison de fond reste faite par PostgreSQL dans la jointure).
  const rows = await client.query<MarketRow>(
    `WITH req AS (
       SELECT * FROM unnest($1::uuid[], $2::text[], $3::text[], $4::text[], $5::text[]) AS r(offer_id, category, brand, model, currency)
     ), keys AS (
       SELECT DISTINCT lower(btrim(category)) AS c, lower(btrim(brand)) AS b, lower(btrim(model)) AS mo, currency FROM req
     )
     SELECT 'request' AS kind,
            concat_ws(chr(31), lower(btrim(r.category)), lower(btrim(r.brand)), lower(btrim(r.model)), r.currency) AS key,
            r.offer_id::text AS offer_id, NULL::text AS price
       FROM req r
     UNION ALL
     SELECT 'market',
            concat_ws(chr(31), k.c, k.b, k.mo, k.currency),
            m.id::text, m.price_amount::text
       FROM keys k
       JOIN offers m
         ON lower(btrim(m.category)) = k.c
        AND lower(btrim(m.brand)) = k.b
        AND lower(btrim(m.model)) = k.mo
        AND m.price_currency = k.currency
      WHERE ${MARKET_OFFER_FILTER}`,
    [
      usable.map((query) => query.offerId),
      usable.map((query) => query.category),
      usable.map((query) => query.brand),
      usable.map((query) => query.model),
      usable.map((query) => query.currency),
    ],
  );

  // Marché de chaque clé : prix triés avec l'identifiant de l'offre (pour exclure l'offre évaluée de SON marché).
  const markets = new Map<string, Array<{ id: string; price: number }>>();
  const requests: Array<{ offerId: string; key: string }> = [];
  for (const row of rows.rows) {
    if (row.kind === "request") {
      requests.push({ offerId: row.offer_id, key: row.key });
      continue;
    }
    const list = markets.get(row.key) ?? [];
    list.push({ id: row.offer_id, price: Number(row.price) });
    markets.set(row.key, list);
  }
  for (const list of markets.values()) list.sort((a, b) => a.price - b.price);

  for (const request of requests) {
    const market = markets.get(request.key) ?? [];
    const prices = market.filter((entry) => entry.id !== request.offerId).map((entry) => entry.price);
    result.set(request.offerId, {
      sampleSize: prices.length,
      p25: percentileContSorted(prices, 0.25),
      median: percentileContSorted(prices, 0.5),
      p75: percentileContSorted(prices, 0.75),
    });
  }
  return result;
}
