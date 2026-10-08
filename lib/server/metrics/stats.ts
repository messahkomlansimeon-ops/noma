import "server-only";

import type { Pool } from "pg";
import { requireTransactionPool, requireUuid } from "../catalog/validation";
import { withReadOnlySnapshot } from "../boost/boosts";
import type { BoostDurationCode } from "../boost/boost-config";
import { queryOfferBoostExposureStats, type BoostExposureStatus, type OfferBoostExposureStats } from "../boost/exposures";
import {
  MATCHING_CURRENT_CLOCK_CTE,
  MATCHING_FRESHNESS_FROM,
  MATCHING_NOT_PAUSED_CARRIER,
  buildMatchingFreshnessPredicate,
  resolveMatchingFreshnessParams,
} from "../matching/persistence";
import type { SqlExecutor } from "../postgres/client";
import { ATTRIBUTION_WINDOW_DAYS, STATS_BOOST_LIMIT, STATS_PERIODS, STATS_PERIOD_DAYS, type StatsPeriod } from "./config";
import { MetricsError } from "./errors";
import { roundCount, roundedRatio, type StatCount, type StatRatio } from "./privacy";

/**
 * Statistiques d'efficacité d'UNE annonce pour son vendeur (lot M1) : correspondances actives, apparitions servies, acheteurs exposés, ouvertures,
 * acheteurs uniques ayant ouvert, contacts uniques, sur 7 jours, 30 jours et tout l'historique conservé, puis les mêmes chiffres par boost. Le tout
 * dans UN instantané en lecture seule. Définitions exactes, dénominateurs et attribution : MESURES.md.
 *
 * Confidentialité (lot M1-quater) : AUCUNE identité d'acheteur n'est lue ni renvoyée, et AUCUN compte exact n'est publié. Tous les comptes (acheteurs uniques et
 * événements) sont arrondis par `buildOfferStats` : « moins de 5 » de 0 à 4, sinon « environ N » (multiple de 5 le plus proche). Un pourcentage est calculé sur les
 * deux nombres PUBLIÉS et arrondi à la dizaine (privacy.ts) : il n'apprend rien de plus que les comptes publiés.
 */

// ───────────── lignes brutes (jamais exposées) ─────────────

export interface PeriodRaw {
  since: string | null;
  exposedBuyers: number;
  sponsoredBuyers: number;
  servings: number;
  sponsoredServings: number;
  openerBuyers: number;
  openerBuyersAttributed: number;
  opens: number;
  opensAttributed: number;
  contactBuyers: number;
  contactBuyersAttributed: number;
  reveals: number;
  /** Acheteurs qui ont ouvert ET à qui l'annonce a été servie pendant un boost (numérateur du taux d'ouverture : jamais plus que `exposedBuyers`). */
  openerBuyersExposed: number;
  /** Acheteurs qui ont contacté ET ouvert dans la période (numérateur du taux de contact : jamais plus que `openerBuyers`). */
  contactBuyersOpened: number;
}

export interface BoostRaw {
  boostId: string;
  durationCode: BoostDurationCode;
  status: BoostExposureStatus;
  startsAt: Date;
  endsAt: Date;
  exposedBuyers: number;
  sponsoredBuyers: number;
  servings: number;
  sponsoredServings: number;
  /** Ouvertures attribuées à ce boost et acheteurs uniques qui les ont faites. */
  attributedOpens: number;
  attributedOpeners: number;
  /** Acheteurs uniques dont un contact est attribué à ce boost, et leurs révélations. */
  attributedContactBuyers: number;
  attributedReveals: number;
}

// ───────────── forme publique (déjà arrondie) ─────────────

export interface ExposureStats { servings: StatCount; sponsoredServings: StatCount; buyersExposed: StatCount; buyersSponsored: StatCount }

export interface PeriodStats {
  period: StatsPeriod;
  /** Premier jour UTC de la période (AAAA-MM-JJ, aujourd'hui compris), ou null pour tout l'historique conservé. */
  since: string | null;
  /**
   * Journal d'exposition : apparitions SERVIES pendant un boost seulement. `null` quand aucun boost de l'annonce ne peut avoir servi l'annonce pendant la
   * période (annonce sans boost : aucune ligne « pendant un boost »).
   */
  exposure: ExposureStats | null;
  opens: {
    total: StatCount;
    uniqueBuyers: StatCount;
    /** `null` (avec `organic`) quand aucun boost ne peut avoir attribué une ouverture dans la période : tout est organique. */
    attributedToBoost: { opens: StatCount; uniqueBuyers: StatCount } | null;
    organic: { opens: StatCount; uniqueBuyers: StatCount } | null;
  };
  contacts: {
    uniqueBuyers: StatCount;
    reveals: StatCount;
    attributedToBoost: { uniqueBuyers: StatCount } | null;
    organic: { uniqueBuyers: StatCount } | null;
  };
  ratios: {
    /** Acheteurs qui ont ouvert parmi ceux à qui l'annonce a été servie pendant un boost / acheteurs servis ; `null` quand aucune apparition n'est possible dans la période. */
    openRate: StatRatio | null;
    /** Acheteurs qui ont contacté parmi ceux qui ont ouvert / acheteurs qui ont ouvert. */
    contactRate: StatRatio;
  };
}

export interface BoostStats {
  boostId: string;
  durationCode: BoostDurationCode;
  status: BoostExposureStatus;
  startsAt: Date;
  endsAt: Date;
  /** `null` pour un boost qui n'a pas commencé (aucune apparition possible). */
  exposure: ExposureStats | null;
  attributed: { opens: StatCount; uniqueOpeners: StatCount; uniqueContacts: StatCount; reveals: StatCount } | null;
  ratios: {
    /** Acheteurs uniques dont une ouverture est attribuée à ce boost / acheteurs à qui l'annonce a été servie SPONSORISÉE par ce boost (l'attribution exige cette apparition). */
    openRate: StatRatio | null;
    /** Acheteurs uniques dont un contact est attribué à ce boost / acheteurs à qui l'annonce a été servie SPONSORISÉE par ce boost (idem). */
    contactRate: StatRatio | null;
  };
}

export interface OfferStats {
  /** Besoins d'acheteurs dont la correspondance est confirmée et fraîche À LA LECTURE (un instantané, pas une période) : des besoins, pas des acheteurs. */
  activeMatches: { needs: StatCount };
  periods: PeriodStats[];
  /** Les boosts de l'annonce, du plus récent au plus ancien (`STATS_BOOST_LIMIT` au plus). Vide : aucun boost, tout est organique. */
  boosts: BoostStats[];
}

// ───────────── construction (pure : testée sans base) ─────────────

/** Valeurs brutes de toute la réponse : l'objet de statistiques est publié D'UN BLOC (`buildOfferStats`), jamais chiffre par chiffre. */
export interface OfferStatsRaw {
  needs: number;
  /** Instant de la lecture (horloge de la base) : place chaque boost sur la ligne du temps (quelle période un boost peut-il toucher). */
  readAt: Date;
  periods: Readonly<Record<StatsPeriod, PeriodRaw>>;
  /** Les boosts, du plus récent au plus ancien. */
  boosts: readonly BoostRaw[];
}

const DAY_MS = 86_400_000;

/** Âge maximal (jours UTC avant la lecture, aujourd'hui = 0) des jours d'une période. */
const PERIOD_MAX_AGE: Readonly<Record<StatsPeriod, number>> = { "7d": 6, "30d": 29, all: Number.POSITIVE_INFINITY };

/** Jours d'apparition possibles d'un boost, en âges (jours UTC avant la lecture) ; null s'il n'a pas commencé. Large : une fenêtre trop large ne rend jamais la publication moins sûre. */
export interface BoostWindow {
  /** Âge du jour d'apparition le plus récent. */
  newest: number;
  /** Âge du jour d'apparition le plus ancien. */
  oldest: number;
}

export function boostWindow(readAt: Date, startsAt: Date, endsAt: Date): BoostWindow | null {
  const today = Math.floor(readAt.getTime() / DAY_MS);
  const oldest = today - Math.floor(startsAt.getTime() / DAY_MS);
  if (oldest < 0) return null;
  return { newest: Math.max(0, today - Math.floor(endsAt.getTime() / DAY_MS)), oldest };
}

/** Un boost a-t-il pu SERVIR l'annonce pendant la période ? (au moins un de ses jours d'apparition dans la période) */
function canServe(window: BoostWindow | null, period: StatsPeriod): boolean {
  return window !== null && window.newest <= PERIOD_MAX_AGE[period];
}

/** Un boost a-t-il pu ATTRIBUER une ouverture ou un contact de la période ? (une apparition sponsorisée au plus 7 jours avant un jour de la période) */
function canAttribute(window: BoostWindow | null, period: StatsPeriod): boolean {
  return window !== null && Math.max(0, window.newest - ATTRIBUTION_WINDOW_DAYS) <= PERIOD_MAX_AGE[period];
}

/**
 * Toute la réponse publique : chaque compte est arrondi (privacy.ts), chaque pourcentage est calculé sur les nombres publiés. Un seul chemin de sortie pour les comptes
 * des statistiques : aucun compte exact n'est publié.
 */
export function buildOfferStats(raw: OfferStatsRaw): OfferStats {
  const windows = raw.boosts.map((boost) => boostWindow(raw.readAt, boost.startsAt, boost.endsAt));
  const count = roundCount;

  const periods: PeriodStats[] = STATS_PERIODS.map((period): PeriodStats => {
    const p = raw.periods[period];
    const served = windows.some((window) => canServe(window, period));
    // Aucun boost ne peut avoir attribué : tout est organique, on ne publie pas de répartition (les deux parts seraient nulles ou identiques au total).
    const attributable = windows.some((window) => canAttribute(window, period));
    return {
      period,
      since: p.since,
      exposure: served
        ? { servings: count(p.servings), sponsoredServings: count(p.sponsoredServings), buyersExposed: count(p.exposedBuyers), buyersSponsored: count(p.sponsoredBuyers) }
        : null,
      opens: {
        total: count(p.opens),
        uniqueBuyers: count(p.openerBuyers),
        attributedToBoost: attributable ? { opens: count(p.opensAttributed), uniqueBuyers: count(p.openerBuyersAttributed) } : null,
        organic: attributable ? { opens: count(p.opens - p.opensAttributed), uniqueBuyers: count(p.openerBuyers - p.openerBuyersAttributed) } : null,
      },
      contacts: {
        uniqueBuyers: count(p.contactBuyers),
        reveals: count(p.reveals),
        attributedToBoost: attributable ? { uniqueBuyers: count(p.contactBuyersAttributed) } : null,
        organic: attributable ? { uniqueBuyers: count(p.contactBuyers - p.contactBuyersAttributed) } : null,
      },
      ratios: {
        openRate: served ? roundedRatio(p.openerBuyersExposed, p.exposedBuyers) : null,
        contactRate: roundedRatio(p.contactBuyersOpened, p.openerBuyers),
      },
    };
  });

  const boosts: BoostStats[] = raw.boosts.map((boost, index): BoostStats => {
    const started = windows[index] !== null;
    return {
      boostId: boost.boostId,
      durationCode: boost.durationCode,
      status: boost.status,
      startsAt: boost.startsAt,
      endsAt: boost.endsAt,
      exposure: started
        ? { servings: count(boost.servings), sponsoredServings: count(boost.sponsoredServings), buyersExposed: count(boost.exposedBuyers), buyersSponsored: count(boost.sponsoredBuyers) }
        : null,
      attributed: started
        ? { opens: count(boost.attributedOpens), uniqueOpeners: count(boost.attributedOpeners), uniqueContacts: count(boost.attributedContactBuyers), reveals: count(boost.attributedReveals) }
        : null,
      ratios: {
        openRate: started ? roundedRatio(boost.attributedOpeners, boost.sponsoredBuyers) : null,
        contactRate: started ? roundedRatio(boost.attributedContactBuyers, boost.sponsoredBuyers) : null,
      },
    };
  });

  return { activeMatches: { needs: count(raw.needs) }, periods, boosts };
}

// ───────────── lectures ─────────────

interface PeriodRow {
  since: string | null;
  exposed_buyers: number;
  sponsored_buyers: number;
  servings: number;
  sponsored_servings: number;
  opener_buyers: number;
  opener_buyers_attributed: number;
  opens: number;
  opens_attributed: number;
  contact_buyers: number;
  contact_buyers_attributed: number;
  reveals: number;
  opener_buyers_exposed: number;
  contact_buyers_opened: number;
}

/**
 * Comptages d'une période, en UNE requête : par acheteur (`viewer_id`) pour les trois journaux, puis comptage et recoupements d'ensembles (ouvert parmi
 * exposé, contact parmi ouvert : un taux ne dépasse jamais 100 %). Jours UTC : `since` est le premier jour inclus (aujourd'hui − (N − 1)), ou NULL.
 */
async function readPeriod(client: SqlExecutor, offerId: string, days: number | null, readAt: Date): Promise<PeriodRaw> {
  const result = await client.query<PeriodRow>(
    `WITH p AS (
       SELECT CASE WHEN $2::int IS NULL THEN NULL::date ELSE ($3::timestamptz AT TIME ZONE 'UTC')::date - ($2::int - 1) END AS since
     ),
     ex AS (
       SELECT e.viewer_id, sum(e.servings)::int AS servings, sum(e.sponsored_servings)::int AS sponsored
         FROM boost_exposures e, p
        WHERE e.offer_id = $1::uuid AND (p.since IS NULL OR e.served_day >= p.since)
        GROUP BY e.viewer_id
     ),
     vw AS (
       SELECT v.viewer_id, sum(v.views)::int AS views, sum(v.boosted_views)::int AS boosted
         FROM offer_views v, p
        WHERE v.offer_id = $1::uuid AND (p.since IS NULL OR v.viewed_day >= p.since)
        GROUP BY v.viewer_id
     ),
     ct AS (
       SELECT c.viewer_id, sum(c.reveals)::int AS reveals, bool_or(c.boost_id IS NOT NULL) AS attributed
         FROM offer_contacts c, p
        WHERE c.offer_id = $1::uuid AND (p.since IS NULL OR c.first_contact_at >= (p.since::timestamp AT TIME ZONE 'UTC'))
        GROUP BY c.viewer_id
     )
     SELECT (SELECT since::text FROM p) AS since,
            (SELECT count(*) FROM ex)::int AS exposed_buyers,
            (SELECT count(*) FROM ex WHERE sponsored > 0)::int AS sponsored_buyers,
            (SELECT COALESCE(sum(servings), 0) FROM ex)::int AS servings,
            (SELECT COALESCE(sum(sponsored), 0) FROM ex)::int AS sponsored_servings,
            (SELECT count(*) FROM vw)::int AS opener_buyers,
            (SELECT count(*) FROM vw WHERE boosted > 0)::int AS opener_buyers_attributed,
            (SELECT COALESCE(sum(views), 0) FROM vw)::int AS opens,
            (SELECT COALESCE(sum(boosted), 0) FROM vw)::int AS opens_attributed,
            (SELECT count(*) FROM ct)::int AS contact_buyers,
            (SELECT count(*) FROM ct WHERE attributed)::int AS contact_buyers_attributed,
            (SELECT COALESCE(sum(reveals), 0) FROM ct)::int AS reveals,
            (SELECT count(*) FROM vw WHERE viewer_id IN (SELECT viewer_id FROM ex))::int AS opener_buyers_exposed,
            (SELECT count(*) FROM ct WHERE viewer_id IN (SELECT viewer_id FROM vw))::int AS contact_buyers_opened`,
    [offerId, days, readAt],
  );
  const row = result.rows[0];
  return {
    since: row.since,
    exposedBuyers: row.exposed_buyers,
    sponsoredBuyers: row.sponsored_buyers,
    servings: row.servings,
    sponsoredServings: row.sponsored_servings,
    openerBuyers: row.opener_buyers,
    openerBuyersAttributed: row.opener_buyers_attributed,
    opens: row.opens,
    opensAttributed: row.opens_attributed,
    contactBuyers: row.contact_buyers,
    contactBuyersAttributed: row.contact_buyers_attributed,
    reveals: row.reveals,
    openerBuyersExposed: row.opener_buyers_exposed,
    contactBuyersOpened: row.contact_buyers_opened,
  };
}

async function readBoosts(client: SqlExecutor, offerId: string): Promise<BoostRaw[]> {
  const exposures: OfferBoostExposureStats[] = await queryOfferBoostExposureStats(client, offerId, STATS_BOOST_LIMIT);
  if (exposures.length === 0) return [];
  const boostIds = exposures.map((boost) => boost.boostId);
  const opens = await client.query<{ boost_id: string; openers: number; opens: number }>(
    `SELECT v.boost_id, count(DISTINCT v.viewer_id)::int AS openers, COALESCE(sum(v.boosted_views), 0)::int AS opens
       FROM offer_views v
      WHERE v.offer_id = $1::uuid AND v.boost_id = ANY($2::uuid[]) AND v.boosted_views > 0
      GROUP BY v.boost_id`,
    [offerId, boostIds],
  );
  const contacts = await client.query<{ boost_id: string; buyers: number; reveals: number }>(
    `SELECT c.boost_id, count(DISTINCT c.viewer_id)::int AS buyers, COALESCE(sum(c.reveals), 0)::int AS reveals
       FROM offer_contacts c
      WHERE c.offer_id = $1::uuid AND c.boost_id = ANY($2::uuid[])
      GROUP BY c.boost_id`,
    [offerId, boostIds],
  );
  const opensByBoost = new Map(opens.rows.map((row) => [row.boost_id, row]));
  const contactsByBoost = new Map(contacts.rows.map((row) => [row.boost_id, row]));
  return exposures.map((boost): BoostRaw => {
    const opened = opensByBoost.get(boost.boostId);
    const contacted = contactsByBoost.get(boost.boostId);
    return {
      boostId: boost.boostId,
      durationCode: boost.durationCode,
      status: boost.status,
      startsAt: boost.startsAt,
      endsAt: boost.endsAt,
      exposedBuyers: boost.uniqueBuyersExposed,
      sponsoredBuyers: boost.uniqueBuyersSponsored,
      servings: boost.servings,
      sponsoredServings: boost.sponsoredServings,
      attributedOpens: opened?.opens ?? 0,
      attributedOpeners: opened?.openers ?? 0,
      attributedContactBuyers: contacted?.buyers ?? 0,
      attributedReveals: contacted?.reveals ?? 0,
    };
  });
}

/**
 * Comptes BRUTS de l'annonce du vendeur (jamais envoyés au client : `readOfferStats` les arrondit d'un bloc avant toute sortie). Exporté pour les essais, qui
 * vérifient les comptes exacts de chaque requête avant leur arrondi. `resource_not_found` si l'annonce n'existe pas OU appartient à un autre (réponse
 * identique : on ne révèle jamais l'existence de l'annonce d'un autre). Un seul instantané en lecture seule.
 */
export async function readOfferStatsRaw(input: { pool: Pool; ownerId: string; offerId: string }): Promise<OfferStatsRaw> {
  const pool = requireTransactionPool(input.pool);
  const ownerId = requireUuid(input.ownerId, "ownerId").toLowerCase();
  const offerId = requireUuid(input.offerId, "offerId").toLowerCase();
  return withReadOnlySnapshot(pool, async (client) => {
    const offer = await client.query<{ owner_id: string }>("SELECT owner_id FROM offers WHERE id = $1::uuid", [offerId]);
    if (!offer.rows[0] || offer.rows[0].owner_id !== ownerId) throw new MetricsError("resource_not_found");

    const freshness = buildMatchingFreshnessPredicate(resolveMatchingFreshnessParams(), 2);
    const matches = await client.query<{ needs: number }>(
      `WITH ${MATCHING_CURRENT_CLOCK_CTE}
       SELECT count(*)::int AS needs
         FROM ${MATCHING_FRESHNESS_FROM}
        WHERE e.offer_id = $1::uuid AND e.is_confirmed_match = TRUE
          AND ${freshness.conditions.join("\n          AND ")}
          AND ${MATCHING_NOT_PAUSED_CARRIER}`,
      [offerId, ...freshness.values],
    );

    // UN instant de lecture pour tout : les premiers jours des périodes ET la place de chaque boost sur la ligne du temps partent du même jour, même à minuit.
    const clock = await client.query<{ read_at: Date }>("SELECT clock_timestamp() AS read_at");
    const readAt = clock.rows[0].read_at;
    const periods = {} as Record<StatsPeriod, PeriodRaw>;
    for (const period of STATS_PERIODS) periods[period] = await readPeriod(client, offerId, STATS_PERIOD_DAYS[period], readAt);
    const boosts = await readBoosts(client, offerId);
    return { needs: matches.rows[0].needs, readAt, periods, boosts };
  });
}

/**
 * Statistiques de l'annonce du vendeur, PUBLIÉES : tous les comptes sont arrondis (`buildOfferStats`). Seule sortie des statistiques vers le client.
 */
export async function readOfferStats(input: { pool: Pool; ownerId: string; offerId: string }): Promise<OfferStats> {
  return buildOfferStats(await readOfferStatsRaw(input));
}
