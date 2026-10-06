/**
 * Éléments partagés par les essais de cotation et d'achat de boost (lot P2-bis).
 *
 * Une cotation n'est « disponible » que si le boost ferait MONTER l'offre dans la liste d'au moins un acheteur : il faut donc des listes
 * lisibles par la lecture des résultats (résumés d'évaluation bien formés, pertinence calculable) et assez longues (quota de places promues
 * floor(0,15 × N) ≥ 1, soit 7 offres au moins), avec l'offre cotée classée APRÈS les autres de même pertinence.
 */

import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { createDemand, createOffer, createUser } from "../../lib/server/catalog";
import type { DemandRecord, OfferRecord } from "../../lib/server/catalog/types";
import { computeScoringConfigHash, normalizeScoringConfig } from "../../lib/server/matching/persistence";
import { MATCHING_SCORING_CONTRACT_VERSION } from "../../lib/server/matching/scoring-types";
import { MATCHING_OFFLINE_CONTRACT_VERSION } from "../../lib/server/matching/types";

/** Résumés d'évaluation bien formés (la lecture des résultats les contrôle champ par champ). */
export const EVALUATION_SUMMARY_JSON = JSON.stringify({
  eligibilityReasons: [],
  criteriaSummary: { matchedCount: 2, mismatchedCount: 0, unknownCount: 0, totalExploitableCriteria: 2 },
});
export const SCORING_SUMMARY_JSON = JSON.stringify({
  totalApplicableWeight: 3, matchedWeight: 3, mismatchedWeight: 0, unknownWeight: 0, applicableCriteriaCount: 3,
  matchedCount: 3, mismatchedCount: 0, unknownCount: 0, notApplicableCount: 0, duplicateCount: 0,
});
export const PREFERENCES_SUMMARY_JSON = JSON.stringify({
  preferenceScore: null, preferenceCoverage: 0, totalPreferencesCount: 0, matchedCount: 0, mismatchedCount: 0, unknownCount: 0, contributions: [],
});

/** Longueur de liste par défaut d'un acheteur « atteignable » : floor(0,15 × 7) = 1 place promue. */
export const REACHABLE_LIST_SIZE = 7;

// ───────────── acheteur atteignable (lot P3) ─────────────
// L'achat REVÉRIFIE la portée du boost sous le verrou du périmètre : une cotation insérée à la main ne suffit plus, il faut un acheteur qui verrait
// l'offre monter. Ce monde minimal est partagé par les essais d'achat (cotations insérées directement).

const SCORING_HASH = computeScoringConfigHash(normalizeScoringConfig());

/** Évaluation confirmée et fraîche, insérée directement (comme le worker l'aurait enregistrée). */
export async function insertEvaluation(
  db: Pool,
  input: { offer: OfferRecord; demand: DemandRecord; score?: number },
): Promise<string> {
  const result = await db.query<{ id: string }>(
    `INSERT INTO matching_evaluations (
       idempotency_key, attempt_hash, offer_id, demand_id, offer_owner_id, demand_owner_id,
       offer_content_version, demand_content_version, engine_offline_version, engine_scoring_version,
       scoring_config_hash, scoring_config, evaluated_at, expires_at, eligibility_status, eligibility_reasons,
       compatibility_status, score, coverage, evaluation_summary, scoring_summary, preferences_summary,
       evaluation_details, is_latest, is_stale
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, '{}'::jsonb, clock_timestamp(), NULL, 'eligible', '{}',
       'compatible', $12::numeric, 80, $13::jsonb, $14::jsonb, $15::jsonb, '{"criteria":[]}'::jsonb, TRUE, FALSE)
     RETURNING id`,
    [
      randomUUID(), `ATTEMPT_${randomUUID()}`, input.offer.id, input.demand.id, input.offer.ownerId, input.demand.ownerId,
      input.offer.contentVersion, input.demand.contentVersion, MATCHING_OFFLINE_CONTRACT_VERSION, MATCHING_SCORING_CONTRACT_VERSION, SCORING_HASH,
      input.score ?? 90, EVALUATION_SUMMARY_JSON, SCORING_SUMMARY_JSON, PREFERENCES_SUMMARY_JSON,
    ],
  );
  return result.rows[0].id;
}

/**
 * Un acheteur distinct avec une demande active dont la liste compte `listSize` offres : l'offre donnée (évaluée EN PREMIER, donc classée après
 * les remplissages de même pertinence : un boost la ferait monter) et `listSize - 1` offres « remplissage » d'AUTRES produits (aucun effet sur les
 * places, les vendeurs concurrents ni le prix du périmètre de l'offre).
 */
export async function addReachableBuyer(
  db: Pool,
  offer: OfferRecord,
  options: { listSize?: number; offerScore?: number; fillerScore?: number } = {},
): Promise<{ buyerId: string; demand: DemandRecord; fillers: OfferRecord[] }> {
  const buyerId = (await createUser({}, db)).id;
  const demand = await createDemand({
    ownerId: buyerId, rawText: "RAW_SECRET_TEXT demande", category: offer.category, brand: offer.brand, model: offer.model, status: "active",
  }, db);
  const fillerOwner = (await createUser({}, db)).id;
  const fillers: OfferRecord[] = [];
  for (let index = 1; index < (options.listSize ?? REACHABLE_LIST_SIZE); index += 1) {
    fillers.push(await createOffer({
      ownerId: fillerOwner, rawText: `RAW_SECRET_TEXT remplissage ${index}`, category: "remplissage", brand: "acme", model: `r${index}`,
      price: { amount: 90_000 + index, currency: "XOF" }, status: "published", availabilityStatus: "available",
      // Disponibilité confirmée à l'instant : les remplissages dominent TOUJOURS l'offre cotée (+12 points de pertinence), quel que soit le prix de l'offre
      // face à un marché qui change d'un test à l'autre (sinon une offre bon marché passerait en tête de la liste : plus rien à gagner).
      availabilityConfirmedAt: new Date(),
    }, db));
  }
  await insertEvaluation(db, { offer, demand, score: options.offerScore ?? 90 });
  for (const filler of fillers) await insertEvaluation(db, { offer: filler, demand, score: options.fillerScore ?? 100 });
  return { buyerId, demand, fillers };
}

// ───────────── lenteur de la portée (lot P3-bis) ─────────────

/**
 * Une VUE du pool dont chaque connexion ralentit le calcul de la portée : le délai d'instruction posé par `computeBoostReach` est ramené à `timeoutMs`
 * et la PREMIÈRE lecture d'un classement (`ORDER BY e.score`, propre au calcul de la portée et à la lecture des résultats) est précédée d'une instruction de 1 s,
 * interrompue par ce délai (SQLSTATE 57014) : le calcul épuise son budget SANS acheteur trouvé. Les connexions rendues au pool ne gardent aucun crochet
 * (la vue en est une surcouche), les autres requêtes passent inchangées.
 */
export function slowReachPool(base: Pool, timeoutMs = 80): Pool {
  const view = Object.create(base) as Pool;
  const connectWrapped = async (): Promise<PoolClient> => {
    const client = await base.connect();
    const realQuery = client.query.bind(client) as (...args: unknown[]) => Promise<unknown>;
    let slept = false;
    const surface = Object.create(client) as typeof client;
    (surface as unknown as { query: unknown }).query = async (...args: unknown[]) => {
      const text = typeof args[0] === "string" ? args[0] : "";
      if (/^SET LOCAL statement_timeout = [0-9]+$/.test(text)) return realQuery(`SET LOCAL statement_timeout = ${timeoutMs}`);
      if (!slept && /ORDER BY e\.score/.test(text)) {
        slept = true;
        await realQuery("SELECT pg_sleep(1)");
      }
      return realQuery(...args);
    };
    return surface;
  };
  // `Pool.query` (hérité par la vue) appelle `connect` AVEC un rappel : ce chemin-là reste celui du pool d'origine (requêtes simples, session).
  view.connect = ((...args: unknown[]) => (typeof args[0] === "function" ? (base.connect as (...a: unknown[]) => unknown)(...args) : connectWrapped())) as unknown as Pool["connect"];
  return view;
}
