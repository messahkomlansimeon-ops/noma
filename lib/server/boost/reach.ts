import "server-only";

import type { SqlExecutor } from "../postgres/client";
import { countDemandOrganicList, readDemandOrganicRanking } from "../matching/stored-matches";
import {
  MATCHING_FRESHNESS_FROM, buildMatchingFreshnessPredicate, resolveMatchingFreshnessParams,
} from "../matching/persistence";
import { readBoostSettings, readEffectiveBoostsByOffer, type BoostSettings } from "./boosts";
import { computeMaxPromoted, isPromotedByBoost } from "./placement";

/**
 * Portée visible d'un boost (lot P2-bis) : combien d'acheteurs verraient réellement l'offre MONTER s'ils la voyaient boostée. Un boost qui ne
 * monte dans aucune liste est du crédit dépensé sans effet (prouvé : une annonce, un besoin, devis « disponible », achat réussi, 0 « Sponsorisé »
 * parce que le quota floor(part promue × N) vaut 0 sous 7 offres).
 *
 * Pour chaque besoin actif compatible (le plus récent d'abord ; un acheteur n'est compté qu'une fois, un seul besoin atteignable suffit) :
 *   1. N = taille de la liste que l'acheteur verrait ; si `computeMaxPromoted(N, part promue)` vaut 0, le besoin est écarté sans autre calcul ;
 *   2. sinon le classement organique de ce besoin est relu avec LA fonction de la lecture des résultats (pertinence incluse) ;
 *   3. le placement est simulé avec `placeBoostedItems` (via `isPromotedByBoost`) : promouvables = les offres déjà boostées PLUS celle-ci, dont la
 *      pertinence atteint le seuil des réglages de la catégorie du besoin ; l'offre est atteignable si elle y est marquée promue (quota non épuisé,
 *      pertinence suffisante, pas déjà à la place cible). Aucune copie de la logique de placement.
 *
 * Bornes : au plus `BOOST_REACH_COUNT_LIMIT` besoins évalués pour le COMPTAGE ; au-delà, on ne continue que tant qu'aucun acheteur atteignable n'est
 * trouvé et on s'arrête dès qu'il y en a un, sans dépasser `BOOST_REACH_SEARCH_LIMIT` besoins évalués au total. Passé ce plafond sans acheteur
 * atteignable, le résultat est 0 (limite documentée : BOOST-PRICING.md). Le compte est donc exact jusqu'à `BOOST_REACH_COUNT_LIMIT` besoins
 * évalués, un minimum au-delà.
 */
export const BOOST_REACH_COUNT_LIMIT = 200;
export const BOOST_REACH_SEARCH_LIMIT = 1_000;

export interface BoostReach {
  /** Acheteurs distincts pour lesquels le boost ferait monter l'offre. */
  reachableBuyers: number;
  /** Besoins réellement examinés (comptage + recherche). */
  evaluatedDemands: number;
  /** Plus de besoins compatibles existaient que ceux examinés : `reachableBuyers` est alors un minimum. */
  truncated: boolean;
}

interface CompatibleDemandRow {
  demand_id: string;
  demand_owner_id: string;
  category: string | null;
}

/** Besoins actifs compatibles de l'offre (mêmes évaluations que le comptage des acheteurs compatibles), les plus récents d'abord. */
async function readCompatibleDemands(client: SqlExecutor, offerId: string, limit: number): Promise<CompatibleDemandRow[]> {
  const freshness = buildMatchingFreshnessPredicate(resolveMatchingFreshnessParams(), 3);
  const result = await client.query<CompatibleDemandRow>(
    `WITH current_clock AS (SELECT clock_timestamp() AS fresh_now)
     SELECT e.demand_id, e.demand_owner_id, d.category
       FROM ${MATCHING_FRESHNESS_FROM}
      WHERE e.offer_id = $1::uuid AND e.is_confirmed_match = TRUE
        AND ${freshness.conditions.join("\n        AND ")}
      ORDER BY d.created_at DESC, d.id DESC
      LIMIT $2::int`,
    [offerId, limit, ...freshness.values],
  );
  return result.rows;
}

/** Code d'une erreur pour le journal serveur : jamais le message (il peut contenir hôte, requête ou identifiant). */
function safeErrorCode(error: unknown): string {
  const code = (error as { code?: unknown; message?: unknown } | null)?.code;
  if (typeof code === "string" && /^[A-Za-z0-9_]{1,40}$/.test(code)) return code;
  const message = (error as { message?: unknown } | null)?.message;
  return typeof message === "string" && /^[a-z0-9_]{1,60}$/.test(message) ? message : "erreur";
}

/** Le boost ferait-il monter l'offre dans la liste que voit l'acheteur de CE besoin ? (quota, pertinence, gain strict : voir l'en-tête). */
async function isDemandReached(
  client: SqlExecutor,
  input: { demand: CompatibleDemandRow; offerId: string; at: Date; atIso: string; settingsByCategory: Map<string, BoostSettings> },
): Promise<boolean> {
  const { demand } = input;
  const categoryKey = demand.category === null ? "" : demand.category.trim().toLowerCase();
  let settings = input.settingsByCategory.get(categoryKey);
  if (!settings) {
    settings = await readBoostSettings(client, demand.category);
    input.settingsByCategory.set(categoryKey, settings);
  }
  // Quota nul : aucune promotion possible dans cette liste, inutile de calculer les pertinences.
  const listSize = await countDemandOrganicList(client, demand.demand_id);
  if (computeMaxPromoted(listSize, settings.maxPromotedShare) < 1) return false;

  const organic = await readDemandOrganicRanking(client, { demandId: demand.demand_id, ownerId: demand.demand_owner_id, at: input.at });
  const targetIndex = organic.findIndex((entry) => entry.offerId === input.offerId);
  if (targetIndex < 0) return false;
  const boosted = await readEffectiveBoostsByOffer(client, organic.map((entry) => entry.offerId), input.atIso);
  const minRelevance = settings.minRelevance;
  return isPromotedByBoost(
    organic,
    targetIndex,
    (entry) => (entry.offerId === input.offerId || boosted.has(entry.offerId)) && entry.relevance >= minRelevance,
    settings.maxPromotedShare,
  );
}

export async function computeBoostReach(client: SqlExecutor, input: { offerId: string }): Promise<BoostReach> {
  const clock = await client.query<{ at: Date; at_iso: string }>(
    `SELECT clock_timestamp() AS at, to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at_iso`,
  );
  const at = clock.rows[0].at;
  const atIso = clock.rows[0].at_iso;
  // Une ligne de plus que le plafond : sait si la liste a été tronquée.
  const demands = await readCompatibleDemands(client, input.offerId, BOOST_REACH_SEARCH_LIMIT + 1);
  const settingsByCategory = new Map<string, BoostSettings>();
  const reachable = new Set<string>();
  let evaluated = 0;
  let stoppedEarly = false;

  for (const demand of demands) {
    if (reachable.has(demand.demand_owner_id)) continue;
    // Au-delà du plafond de comptage : on ne cherche plus qu'un premier acheteur atteignable.
    if (evaluated >= BOOST_REACH_COUNT_LIMIT && reachable.size > 0) { stoppedEarly = true; break; }
    if (evaluated >= BOOST_REACH_SEARCH_LIMIT) { stoppedEarly = true; break; }
    evaluated += 1;

    // Étape cloisonnée (comme l'étape boost de la lecture) : une évaluation enregistrée illisible ou une erreur SQL sur UN besoin ne casse ni la
    // cotation ni les autres besoins ; ce besoin est simplement tenu pour non atteignable (jamais de promesse sur un calcul qui a échoué).
    await client.query("SAVEPOINT boost_reach_demand");
    try {
      if (await isDemandReached(client, { demand, offerId: input.offerId, at, atIso, settingsByCategory })) reachable.add(demand.demand_owner_id);
      await client.query("RELEASE SAVEPOINT boost_reach_demand");
    } catch (error) {
      await client.query("ROLLBACK TO SAVEPOINT boost_reach_demand");
      console.error(`[boost] portée ignorée pour un besoin (${safeErrorCode(error)})`);
    }
  }

  return {
    reachableBuyers: reachable.size,
    evaluatedDemands: evaluated,
    truncated: stoppedEarly || demands.length > BOOST_REACH_SEARCH_LIMIT,
  };
}
