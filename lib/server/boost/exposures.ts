import "server-only";

import type { Pool } from "pg";
import { requireTransactionPool, requireUuid } from "../catalog/validation";
import { CatalogValidationError } from "../catalog/errors";
import { withPostgresTransaction, type SqlExecutor } from "../postgres/client";
import { BoostError, withReadOnlySnapshot } from "./boosts";
import type { BoostDurationCode } from "./boost-config";

/**
 * Journal d'exposition des boosts (lot 2I4). Une ligne de `boost_exposures` = les apparitions SERVIES d'une offre boostée dans les
 * réponses de stored-matches (sort=relevance, sens demande) pour UNE demande et UN jour UTC. « Servie » ne veut PAS dire « vue » :
 * aucun écran n'existe encore. Voir BOOST-METRICS.md.
 */

/** Plafond de durée de l'écriture du journal : au-delà, l'écriture est abandonnée (la réponse, elle, est déjà prête). */
export const BOOST_EXPOSURE_WRITE_TIMEOUT = "2s";

export const BOOST_EXPOSURE_STATS_MAX_LIMIT = 20;

/** Une apparition servie d'une offre boostée dans la page réponse. */
export interface BoostExposureRow {
  boostId: string;
  offerId: string;
  /** Position dans l'ordre FINAL complet (décalage de la page compris). */
  position: number;
  /** max(0, position organique − position finale). */
  gain: number;
  /** Vrai si l'offre a gagné des places grâce au boost. */
  sponsored: boolean;
}

export interface BoostExposureBatch {
  demandId: string;
  /** Propriétaire de la demande : stocké, JAMAIS renvoyé par une lecture destinée au vendeur. */
  viewerId: string;
  /** Horloge figée de la réponse ; le jour UTC de `at` est le jour de dédoublonnage. */
  at: string;
  rows: readonly BoostExposureRow[];
}

/**
 * Enregistre une page servie, dans une transaction COURTE et SÉPARÉE de la transaction de lecture (qui reste READ ONLY), avec un
 * plafond de durée. UN SEUL `INSERT … SELECT FROM unnest(…) ON CONFLICT (boost_id, demand_id, served_day) DO UPDATE` : servings + 1,
 * sponsored_servings + 1 si sponsorisée, best_position = LEAST, best_gain = GREATEST, last_served_at = maintenant. Les lignes sont
 * triées par boost : deux écritures concurrentes de la même page prennent leurs verrous dans le même ordre. L'appelant attrape
 * toute erreur : l'enregistrement ne doit JAMAIS changer la réponse.
 */
export async function recordBoostExposures(pool: Pool, batch: BoostExposureBatch): Promise<void> {
  if (batch.rows.length === 0) return;
  const rows = [...batch.rows].sort((a, b) => (a.boostId < b.boostId ? -1 : a.boostId > b.boostId ? 1 : 0));
  await withPostgresTransaction(async (client) => {
    await client.query(`SET LOCAL statement_timeout = '${BOOST_EXPOSURE_WRITE_TIMEOUT}'`);
    await client.query(
      `INSERT INTO boost_exposures (boost_id, offer_id, demand_id, viewer_id, served_day, first_served_at, last_served_at,
                                    servings, sponsored_servings, best_position, best_gain)
       SELECT x.boost_id, x.offer_id, $3::uuid, $4::uuid, ($5::timestamptz AT TIME ZONE 'UTC')::date, clock_timestamp(), clock_timestamp(),
              1, CASE WHEN x.sponsored THEN 1 ELSE 0 END, x.position, x.gain
         FROM unnest($1::uuid[], $2::uuid[], $6::boolean[], $7::int[], $8::int[]) AS x(boost_id, offer_id, sponsored, position, gain)
        ORDER BY x.boost_id
       ON CONFLICT (boost_id, demand_id, served_day) DO UPDATE SET
         servings = boost_exposures.servings + 1,
         sponsored_servings = boost_exposures.sponsored_servings + EXCLUDED.sponsored_servings,
         best_position = LEAST(boost_exposures.best_position, EXCLUDED.best_position),
         best_gain = GREATEST(boost_exposures.best_gain, EXCLUDED.best_gain),
         last_served_at = clock_timestamp()`,
      [
        rows.map((row) => row.boostId), rows.map((row) => row.offerId), batch.demandId, batch.viewerId, batch.at,
        rows.map((row) => row.sponsored), rows.map((row) => row.position), rows.map((row) => row.gain),
      ],
    );
  }, pool);
}

// ───────────── lecture vendeur ─────────────

export type BoostExposureStatus = "effective" | "expired" | "cancelled" | "scheduled";

/** Statistiques d'un boost. JAMAIS : viewer_id, demand_id, ni aucune identité d'acheteur. */
export interface OfferBoostExposureStats {
  boostId: string;
  durationCode: BoostDurationCode;
  startsAt: Date;
  endsAt: Date;
  /** Statut effectif à la lecture : cancelled, expired (statut ou échéance passée), scheduled (début futur) ou effective. */
  status: BoostExposureStatus;
  /** Acheteurs distincts (propriétaires de demandes) à qui l'offre a été servie. */
  uniqueBuyersExposed: number;
  /** Acheteurs distincts à qui elle a été servie avec un gain de places (sponsored_servings > 0). */
  uniqueBuyersSponsored: number;
  servings: number;
  sponsoredServings: number;
  bestPosition: number | null;
  bestGain: number | null;
  /** Jours UTC distincts avec au moins une apparition servie. */
  activeDays: number;
}

interface StatsRow {
  boost_id: string;
  duration_code: BoostDurationCode;
  starts_at: Date;
  ends_at: Date;
  status: BoostExposureStatus;
  unique_exposed: number;
  unique_sponsored: number;
  servings: number;
  sponsored_servings: number;
  best_position: number | null;
  best_gain: number | null;
  active_days: number;
}

function requireStatsLimit(value: unknown): number {
  const limit = value === undefined ? BOOST_EXPOSURE_STATS_MAX_LIMIT : value;
  if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > BOOST_EXPOSURE_STATS_MAX_LIMIT) {
    throw new CatalogValidationError(`limit doit être un entier compris entre 1 et ${BOOST_EXPOSURE_STATS_MAX_LIMIT}.`);
  }
  return limit;
}

/**
 * Statistiques d'exposition des boosts d'UNE offre du vendeur, du plus récent au plus ancien (`starts_at`, `id`). `offer_not_found`
 * si l'offre n'existe pas, `offer_not_owned` si elle appartient à un autre (même règle que les cotations de 2I2). Lecture seule,
 * un seul instantané. Les nombres d'acheteurs sont des comptages : aucune identité n'est lue ni renvoyée.
 */
export async function readOfferBoostExposureStats(input: {
  pool: Pool;
  ownerId: string;
  offerId: string;
  limit?: number;
}): Promise<OfferBoostExposureStats[]> {
  if (input.pool === undefined || input.pool === null) throw new CatalogValidationError("Un pool PostgreSQL est requis.");
  const pool = requireTransactionPool(input.pool);
  const ownerId = requireUuid(input.ownerId, "ownerId").toLowerCase();
  const offerId = requireUuid(input.offerId, "offerId").toLowerCase();
  const limit = requireStatsLimit(input.limit);
  return withReadOnlySnapshot(pool, async (client) => {
    const offer = await client.query<{ owner_id: string }>("SELECT owner_id FROM offers WHERE id = $1::uuid", [offerId]);
    if (!offer.rows[0]) throw new BoostError("offer_not_found");
    if (offer.rows[0].owner_id !== ownerId) throw new BoostError("offer_not_owned");
    return queryOfferBoostExposureStats(client, offerId, limit);
  });
}

/**
 * Statistiques d'exposition des boosts d'une offre, lues avec un exécuteur FOURNI (lot M1 : les statistiques du vendeur les lisent dans le MÊME
 * instantané que leurs autres comptages). Aucun contrôle de propriété ici : l'appelant l'a déjà fait. Comptes BRUTS (administration) ; les lectures
 * destinées au vendeur appliquent le seuil de confidentialité (lib/server/metrics).
 */
export async function queryOfferBoostExposureStats(client: SqlExecutor, offerId: string, limit: number): Promise<OfferBoostExposureStats[]> {
  const result = await client.query<StatsRow>(
    `SELECT b.id AS boost_id, b.duration_code, b.starts_at, b.ends_at,
            CASE WHEN b.status = 'cancelled' THEN 'cancelled'
                 WHEN b.status = 'expired' OR b.ends_at <= clock_timestamp() THEN 'expired'
                 WHEN b.starts_at > clock_timestamp() THEN 'scheduled'
                 ELSE 'effective' END AS status,
            x.unique_exposed, x.unique_sponsored, x.servings, x.sponsored_servings, x.best_position, x.best_gain, x.active_days
       FROM offer_boosts b
       CROSS JOIN LATERAL (
         SELECT count(DISTINCT e.viewer_id)::int AS unique_exposed,
                count(DISTINCT e.viewer_id) FILTER (WHERE e.sponsored_servings > 0)::int AS unique_sponsored,
                COALESCE(sum(e.servings), 0)::int AS servings,
                COALESCE(sum(e.sponsored_servings), 0)::int AS sponsored_servings,
                min(e.best_position) AS best_position,
                max(e.best_gain) AS best_gain,
                count(DISTINCT e.served_day)::int AS active_days
           FROM boost_exposures e WHERE e.boost_id = b.id
       ) x
      WHERE b.offer_id = $1::uuid
      ORDER BY b.starts_at DESC, b.id DESC
      LIMIT $2::int`,
    [offerId, limit],
  );
  return result.rows.map((row): OfferBoostExposureStats => ({
    boostId: row.boost_id,
    durationCode: row.duration_code,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    status: row.status,
    uniqueBuyersExposed: row.unique_exposed,
    uniqueBuyersSponsored: row.unique_sponsored,
    servings: row.servings,
    sponsoredServings: row.sponsored_servings,
    bestPosition: row.best_position,
    bestGain: row.best_gain,
    activeDays: row.active_days,
  }));
}
