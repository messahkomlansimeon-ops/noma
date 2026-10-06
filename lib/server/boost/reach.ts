import "server-only";

import type { SqlExecutor } from "../postgres/client";
import {
  countDemandOrganicLists, createOrganicReadCache, readDemandOrganicRanking, type OrganicReadCache,
} from "../matching/stored-matches";
import {
  MATCHING_FRESHNESS_FROM, buildMatchingFreshnessPredicate, resolveMatchingFreshnessParams,
} from "../matching/persistence";
import { rankEffectiveBoosts, readBoostSettings, readEffectiveBoostDetails, type BoostSettings, type EffectiveBoost } from "./boosts";
import { computeMaxPromoted, computePromotionStep, isPromotedByBoost } from "./placement";

/**
 * Portée visible d'un boost (lots P2-bis et P3) : combien d'acheteurs verraient réellement l'offre MONTER s'ils la voyaient boostée. Un boost qui
 * ne monte dans aucune liste est du crédit dépensé sans effet (prouvé : une annonce, un besoin, devis « disponible », achat réussi, 0 « Sponsorisé »
 * parce que le quota floor(part promue × N) vaut 0 sous 7 offres).
 *
 * Pour chaque besoin actif compatible (le plus récent d'abord ; un acheteur n'est compté qu'une fois, un seul besoin atteignable suffit) :
 *   1. N = taille de la liste que l'acheteur verrait, lue pour TOUS les besoins candidats en UNE requête ; si `computeMaxPromoted(N, part promue)`
 *      vaut 0, le besoin est écarté sans relire son classement ;
 *   2. sinon le classement organique de ce besoin est relu avec LA fonction de la lecture des résultats (pertinence incluse) ; les propriétaires
 *      et le marché de chaque offre, qui ne dépendent pas de la demande, ne sont lus qu'une fois pour toute la portée ;
 *   3. le placement est simulé avec `placeBoostedItems` (via `isPromotedByBoost`, aucune copie de la logique) : promouvables = les offres déjà
 *      boostées PLUS celle-ci, dont la pertinence atteint le seuil des réglages de la catégorie du besoin. PRIORITÉ D'ANCIENNETÉ (lot P3) : les
 *      offres déjà boostées gardent leur rang d'ancienneté, l'offre cotée est ajoutée comme le boost le plus RÉCENT (rang le plus bas) ; elle n'est
 *      atteignable que si elle y est marquée promue (quota non épuisé par les boosts existants, pertinence suffisante, gain de place strict). Un
 *      boost existant n'est donc JAMAIS évincé par celui qu'on achète (théorème testé de `placeBoostedItems`).
 *
 * Coût borné : au plus `BOOST_REACH_COUNT_LIMIT` besoins examinés pour le COMPTAGE (les plus récents d'abord) ; au-delà, on ne continue que tant
 * qu'aucun acheteur atteignable n'est trouvé, sans dépasser `BOOST_REACH_SEARCH_LIMIT` besoins examinés au total ; mode « premier » (revérification
 * d'un achat) : arrêt au PREMIER acheteur atteignable. Budget de temps (`budgetMs`) et `statement_timeout` : jamais d'attente sans borne ; budget
 * épuisé, le résultat est ce qui a été démontré (zéro acheteur : pas d'effet démontré). `truncated` : des besoins compatibles n'ont pas été
 * examinés, `reachableBuyers` est alors un MINIMUM (l'écran dit « au moins X »).
 */
export const BOOST_REACH_COUNT_LIMIT = 20;
export const BOOST_REACH_SEARCH_LIMIT = 50;
/** Budget de temps de la portée d'un DEVIS (ms), et de la revérification d'un ACHAT, qui tient le verrou du périmètre. */
export const BOOST_QUOTE_REACH_BUDGET_MS = 3_000;
export const BOOST_PURCHASE_REACH_BUDGET_MS = 1_500;
/** Budget (ms) de la REVÉRIFICATION de la portée d'un devis « disponible » réutilisé (lot P3-bis) : mode « premier atteignable », hors verrous. */
export const BOOST_REUSE_REACH_BUDGET_MS = 1_000;
/** `statement_timeout` (ms) posé pendant le calcul de la portée : une requête plus longue est interrompue (SQLSTATE 57014). */
export const BOOST_REACH_STATEMENT_TIMEOUT_MS = 2_000;

export interface BoostReach {
  /** Acheteurs distincts pour lesquels le boost ferait monter l'offre (un minimum si `truncated`). */
  reachableBuyers: number;
  /** Besoins réellement examinés (comptage + recherche). */
  evaluatedDemands: number;
  /** Des besoins compatibles n'ont pas été examinés (bornes, budget ou interruption) : `reachableBuyers` est un minimum. */
  truncated: boolean;
  /** Le budget de temps (ou le délai d'une requête) a interrompu le calcul. */
  budgetExhausted: boolean;
}

/**
 * Lot P3-bis : « aucun acheteur atteignable DÉMONTRÉ » (tous les besoins examinés dans les bornes, aucun atteignable : `no_visible_effect`) se distingue
 * de « vérification non terminée » (budget ou `statement_timeout` épuisé sans acheteur trouvé : rien n'est démontré, ni l'effet ni son absence ; l'achat
 * et le devis répondent alors `reach_check_unavailable`, 503 à réessayer, et n'écrivent rien).
 */
export function isReachUndetermined(reach: Pick<BoostReach, "reachableBuyers" | "budgetExhausted">): boolean {
  return reach.reachableBuyers === 0 && reach.budgetExhausted;
}

export interface BoostReachInput {
  offerId: string;
  /**
   * `count` (devis) : compte les acheteurs atteignables sur les `BOOST_REACH_COUNT_LIMIT` besoins les plus récents, puis cherche un premier
   * acheteur jusqu'à `BOOST_REACH_SEARCH_LIMIT`. `first` (revérification d'un achat) : s'arrête au premier acheteur atteignable.
   */
  mode: "count" | "first";
  /** Budget de temps total (ms) : épuisé, le calcul s'arrête et rend ce qui est démontré. */
  budgetMs: number;
  /** `statement_timeout` local (ms) ; par défaut `BOOST_REACH_STATEMENT_TIMEOUT_MS`. */
  statementTimeoutMs?: number;
  /** Horloge monotone en ms (défaut `performance.now`), injectable par les tests. */
  clock?: () => number;
  /** Réservé aux tests : appelé avant l'examen de chaque besoin (rang à partir de 0), pour retenir ou observer le calcul. */
  beforeDemand?: (index: number) => void | Promise<void>;
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

/** SQLSTATE d'une requête interrompue par `statement_timeout`. */
const QUERY_CANCELED = "57014";
const isQueryCanceled = (error: unknown): boolean => (error as { code?: unknown } | null)?.code === QUERY_CANCELED;

interface DemandContext {
  offerId: string;
  at: Date;
  atIso: string;
  settingsByCategory: Map<string, BoostSettings>;
  /** Boosts effectifs déjà lus (offre → boost, ou null : pas de boost effectif), partagés entre les listes de la même portée. */
  boosts: Map<string, EffectiveBoost | null>;
  cache: OrganicReadCache;
  listSizes: Map<string, number>;
}

/** Le boost ferait-il monter l'offre dans la liste que voit l'acheteur de CE besoin ? (quota, pertinence, ancienneté, gain strict : voir l'en-tête). */
async function isDemandReached(client: SqlExecutor, demand: CompatibleDemandRow, context: DemandContext): Promise<boolean> {
  const categoryKey = demand.category === null ? "" : demand.category.trim().toLowerCase();
  let settings = context.settingsByCategory.get(categoryKey);
  if (!settings) {
    settings = await readBoostSettings(client, demand.category);
    context.settingsByCategory.set(categoryKey, settings);
  }
  // Quota nul : aucune promotion possible dans cette liste, inutile de relire son classement.
  if (computeMaxPromoted(context.listSizes.get(demand.demand_id) ?? 0, settings.maxPromotedShare) < 1) return false;

  const organic = await readDemandOrganicRanking(client, { demandId: demand.demand_id, ownerId: demand.demand_owner_id, at: context.at }, context.cache);
  const targetIndex = organic.findIndex((entry) => entry.offerId === context.offerId);
  if (targetIndex < 0) return false;

  // Boosts effectifs des offres de cette liste ; ceux déjà lus pour une autre liste de la portée ne sont pas relus.
  const unknown = organic.map((entry) => entry.offerId).filter((offerId) => !context.boosts.has(offerId));
  if (unknown.length > 0) {
    const read = await readEffectiveBoostDetails(client, unknown, context.atIso);
    for (const offerId of unknown) context.boosts.set(offerId, read.get(offerId) ?? null);
  }
  const inList = new Map<string, EffectiveBoost>();
  for (const entry of organic) {
    const boost = context.boosts.get(entry.offerId);
    if (boost && entry.offerId !== context.offerId) inList.set(entry.offerId, boost);
  }
  // Rangs d'ancienneté des boosts DE LA LISTE (même fonction que la lecture des résultats) ; l'offre cotée est ajoutée comme le boost le plus récent.
  const ranks = rankEffectiveBoosts(inList);
  const candidateRank = ranks.size;
  const minRelevance = settings.minRelevance;
  return isPromotedByBoost(
    organic,
    targetIndex,
    (entry) => {
      if (entry.relevance < minRelevance) return null;
      return entry.offerId === context.offerId ? candidateRank : ranks.get(entry.offerId) ?? null;
    },
    settings.maxPromotedShare,
  );
}

/**
 * Calcule la portée d'un boost sur l'offre `offerId` (lecture seule, dans la transaction de l'appelant). Tout le calcul est sous un SAVEPOINT et
 * sous un `statement_timeout` LOCAL (rétabli ensuite) : une requête interrompue par le délai rend ce qui est démontré (`budgetExhausted`) et laisse
 * la transaction de l'appelant utilisable ; toute autre erreur de lecture de base est relancée (le besoin isolé qui échoue, lui, est tenu pour
 * non atteignable sans casser les autres).
 */
export async function computeBoostReach(client: SqlExecutor, input: BoostReachInput): Promise<BoostReach> {
  const clock = input.clock ?? (() => performance.now());
  const startedAt = clock();
  // Jamais plus long que le budget (lot P3-bis) : à l'achat, un verrou tenu par un tiers sur les évaluations ne retient pas la revérification (et le verrou du
  // périmètre) au-delà de `budgetMs` (plancher 250 ms), même pour les premières lectures (liste des besoins, tailles des listes).
  const timeoutMs = Math.max(1, Math.min(Math.trunc(input.statementTimeoutMs ?? BOOST_REACH_STATEMENT_TIMEOUT_MS), Math.max(250, Math.trunc(input.budgetMs))));
  const reachable = new Set<string>();
  let evaluated = 0;
  let truncated = false;
  let exhausted = false;

  await client.query(`SET LOCAL statement_timeout = ${timeoutMs}`);
  await client.query("SAVEPOINT boost_reach");
  try {
    const clockRow = await client.query<{ at: Date; at_iso: string }>(
      `SELECT clock_timestamp() AS at, to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at_iso`,
    );
    // Une ligne de plus que la borne : sait s'il restait des besoins compatibles non examinés.
    const demands = await readCompatibleDemands(client, input.offerId, BOOST_REACH_SEARCH_LIMIT + 1);
    const context: DemandContext = {
      offerId: input.offerId, at: clockRow.rows[0].at, atIso: clockRow.rows[0].at_iso, settingsByCategory: new Map(), boosts: new Map(),
      cache: createOrganicReadCache(), listSizes: new Map(),
    };
    // Préfiltre en UNE requête : la taille de chaque liste PLAFONNÉE au seuil de quota (le quota de places promues vaut 0 sous ceil(1 / part) offres :
    // `computePromotionStep`). Le plafond est le plus haut seuil des catégories des besoins candidats : « taille ≥ seuil » reste exact pour chacune.
    const candidates = demands.slice(0, BOOST_REACH_SEARCH_LIMIT);
    let cap = 1;
    for (const demand of candidates) {
      const categoryKey = demand.category === null ? "" : demand.category.trim().toLowerCase();
      let settings = context.settingsByCategory.get(categoryKey);
      if (!settings) {
        settings = await readBoostSettings(client, demand.category);
        context.settingsByCategory.set(categoryKey, settings);
      }
      cap = Math.max(cap, computePromotionStep(settings.maxPromotedShare));
    }
    context.listSizes = await countDemandOrganicLists(client, candidates.map((demand) => demand.demand_id), cap);

    let index = 0;
    for (; index < demands.length; index += 1) {
      const demand = demands[index];
      if (reachable.has(demand.demand_owner_id)) continue;
      // Arrêts : mode « premier » dès qu'un acheteur est atteignable ; mode « comptage » au-delà de la borne de comptage ; borne de recherche ;
      // budget de temps.
      if (input.mode === "first" && reachable.size > 0) break;
      if (evaluated >= BOOST_REACH_COUNT_LIMIT && reachable.size > 0) break;
      if (evaluated >= BOOST_REACH_SEARCH_LIMIT) break;
      if (clock() - startedAt >= input.budgetMs) {
        exhausted = true;
        break;
      }
      if (input.beforeDemand) await input.beforeDemand(evaluated);
      // Aucune requête de ce besoin ne dépasse le budget restant (et jamais le délai de base) : le verrou que l'appelant tient (périmètre,
      // à l'achat) n'est pas prolongé par une requête lente.
      const remainingMs = Math.max(1, Math.ceil(input.budgetMs - (clock() - startedAt)));
      await client.query(`SET LOCAL statement_timeout = ${Math.min(timeoutMs, remainingMs)}`);
      evaluated += 1;

      // Étape cloisonnée (comme l'étape boost de la lecture) : une évaluation enregistrée illisible ou une erreur SQL sur UN besoin ne casse ni la
      // cotation ni les autres besoins ; ce besoin est simplement tenu pour non atteignable (jamais de promesse sur un calcul qui a échoué).
      await client.query("SAVEPOINT boost_reach_demand");
      try {
        if (await isDemandReached(client, demand, context)) reachable.add(demand.demand_owner_id);
        await client.query("RELEASE SAVEPOINT boost_reach_demand");
      } catch (error) {
        await client.query("ROLLBACK TO SAVEPOINT boost_reach_demand");
        if (isQueryCanceled(error)) {
          exhausted = true;
          break;
        }
        console.error(`[boost] portée ignorée pour un besoin (${safeErrorCode(error)})`);
      }
    }
    // Des besoins compatibles restent-ils à examiner (acheteur pas déjà compté) ? Alors le compte est un minimum.
    for (let rest = index; rest < demands.length; rest += 1) {
      if (!reachable.has(demands[rest].demand_owner_id)) {
        truncated = true;
        break;
      }
    }
    await client.query("RELEASE SAVEPOINT boost_reach");
  } catch (error) {
    await client.query("ROLLBACK TO SAVEPOINT boost_reach");
    if (!isQueryCanceled(error)) throw error;
    exhausted = true;
    truncated = true;
  } finally {
    // Rétablit le délai d'avant (la transaction de l'appelant peut continuer, par exemple vers le débit d'un achat) ; sans effet si elle est annulée.
    try { await client.query("SET LOCAL statement_timeout = DEFAULT"); } catch { /* transaction à annuler par l'appelant */ }
  }
  return { reachableBuyers: reachable.size, evaluatedDemands: evaluated, truncated: truncated || exhausted, budgetExhausted: exhausted };
}
