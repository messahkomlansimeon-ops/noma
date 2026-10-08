import "server-only";

import type { Pool } from "pg";
import { requireTransactionPool } from "../catalog/validation";
import type { SqlExecutor } from "../postgres/client";
import { MARKET_OBSERVE_BATCH, MARKET_OBSERVE_STATEMENT_TIMEOUT, MARKET_REQUIRED_MIGRATION } from "./config";
import { isUtcDay } from "./stats";

/**
 * Relevé quotidien des prix affichés (lots H1 et H1-bis, étape « market » du worker). Le prix d'une annonce PUBLIÉE est observé une fois par jour UTC et par annonce :
 *  - à la publication et à chaque changement de prix, c'est le déclencheur de la migration 0023 qui écrit la ligne du jour (dans la transaction de l'écriture) ;
 *  - ce relevé écrit, pour toutes les annonces observables, la ligne du JOUR COURANT si elle manque. AUCUN RATTRAPAGE : un jour où le worker n'a pas tourné reste un trou dans
 *    l'historique (documenté dans HISTORIQUE-PRIX.md). Un rattrapage fabriquerait des « jours fantômes » : une annonce suspendue puis remise en ligne aurait des relevés pour des
 *    jours où elle n'était pas en ligne ;
 *  - idempotent : `ON CONFLICT DO NOTHING` sur (source, annonce, jour) ; un jour terminé est consigné dans `price_observation_runs` et n'est pas recommencé à chaque cycle.
 * Sans la migration 0023, l'étape est IGNORÉE (jamais une erreur), comme l'étape boost sans la 0011.
 */

export interface MarketStepResult {
  /** Lignes du jour écrites par ce passage. */
  observed: number;
  /** La migration 0023 n'est pas enregistrée : rien n'a été exécuté. */
  skipped: boolean;
  /** Le jour était déjà terminé : rien n'a été relu. */
  alreadyDone: boolean;
}

/** La migration 0023 est-elle enregistrée ? Sans elle (ou sans table de migrations), l'étape est ignorée, jamais en erreur. */
export async function isMarketMigrationRegistered(pool: Pool): Promise<boolean> {
  const table = await pool.query<{ present: boolean }>("SELECT to_regclass('noma_schema_migrations') IS NOT NULL AS present");
  if (table.rows[0]?.present !== true) return false;
  const result = await pool.query("SELECT 1 FROM noma_schema_migrations WHERE version = $1", [MARKET_REQUIRED_MIGRATION]);
  return result.rowCount === 1;
}

const NIL_UUID = "00000000-0000-0000-0000-000000000000";

interface BatchRow {
  scanned: number;
  last_id: string | null;
  observed: number;
}

/**
 * UN lot d'annonces (par ordre d'identifiant, après `afterId`) : écrit la ligne de `day` des annonces OBSERVABLES du lot qui n'en ont pas. Idempotent. Renvoie le dernier identifiant lu.
 */
export async function observeListingsBatch(
  pool: SqlExecutor,
  input: { day: string; afterId?: string; batchSize?: number },
): Promise<{ scanned: number; lastId: string | null; observed: number }> {
  if (!isUtcDay(input.day)) throw new RangeError("day doit être un jour UTC AAAA-MM-JJ.");
  const batchSize = input.batchSize ?? MARKET_OBSERVE_BATCH;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 5_000) throw new RangeError("batchSize hors bornes.");
  const result = await pool.query<BatchRow>(
    `WITH batch AS (
       SELECT o.id FROM offers o WHERE o.id > $2::uuid AND o.status = 'published' ORDER BY o.id LIMIT $3::int
     ), observable AS (
       SELECT o.* FROM offers o JOIN batch b ON b.id = o.id WHERE price_obs_offer_ok(o)
     ), written AS (
       INSERT INTO price_observations (source, reference_id, observed_on, category_key, brand_key, model_key, variant_key, condition_key, label, price_xof, seller_id)
       SELECT 'listing', ob.id, $1::date, price_key_part(ob.category), price_key_part(ob.brand), price_key_part(ob.model), price_key_part(ob.variant), price_key_part(ob.condition_text),
              price_obs_label(ob), ob.price_amount, ob.owner_id
         FROM observable ob
       ON CONFLICT (source, reference_id, observed_on) DO NOTHING
       RETURNING 1
     )
     SELECT (SELECT count(*) FROM batch)::int AS scanned,
            (SELECT id::text FROM batch ORDER BY id DESC LIMIT 1) AS last_id,
            (SELECT count(*) FROM written)::int AS observed`,
    [input.day, input.afterId ?? NIL_UUID, batchSize],
  );
  const row = result.rows[0];
  return { scanned: row.scanned, lastId: row.last_id, observed: row.observed };
}

/** Tous les lots d'un jour, jusqu'à épuisement des annonces publiées (un lot après l'autre : jamais une longue instruction). */
export async function observeListingsForDay(pool: Pool, input: { day: string; batchSize?: number }): Promise<{ observed: number }> {
  const db = requireTransactionPool(pool);
  const batchSize = input.batchSize ?? MARKET_OBSERVE_BATCH;
  let afterId: string | undefined;
  let observed = 0;
  for (;;) {
    const client = await db.connect();
    let batch;
    try {
      await client.query(`SET statement_timeout = '${MARKET_OBSERVE_STATEMENT_TIMEOUT}'`);
      batch = await observeListingsBatch(client, { day: input.day, afterId, batchSize });
      await client.query("RESET statement_timeout");
    } finally {
      client.release();
    }
    observed += batch.observed;
    if (batch.scanned < batchSize || batch.lastId === null) break;
    afterId = batch.lastId;
  }
  return { observed };
}

/**
 * L'étape « market » d'un cycle du worker : sans migration 0023, ignorée ; un jour déjà terminé, ignoré (une lecture) ; sinon relevé du jour (jamais d'un autre jour), puis le jour est
 * consigné. `now` (réservé aux tests) fixe l'instant ; sinon l'horloge de la base.
 */
export async function runMarketStep(input: { pool: Pool; now?: Date }): Promise<MarketStepResult> {
  const pool = requireTransactionPool(input.pool);
  if (!(await isMarketMigrationRegistered(pool))) return { observed: 0, skipped: true, alreadyDone: false };
  // Un seul aller-retour pour savoir quel jour on est ET s'il est déjà terminé : le cycle du worker passe ici à chaque tour, même au repos.
  const state = (
    await pool.query<{ today: string; done: boolean }>(
      `WITH t AS (SELECT (COALESCE($1::timestamptz, clock_timestamp()) AT TIME ZONE 'UTC')::date AS day)
       SELECT to_char(t.day, 'YYYY-MM-DD') AS today, EXISTS (SELECT 1 FROM price_observation_runs r WHERE r.day = t.day) AS done FROM t`,
      [input.now ?? null],
    )
  ).rows[0];
  if (state.done) return { observed: 0, skipped: false, alreadyDone: true };
  const today = state.today;
  const { observed } = await observeListingsForDay(pool, { day: today });
  await pool.query("INSERT INTO price_observation_runs (day, observed) VALUES ($1::date, $2::int) ON CONFLICT (day) DO NOTHING", [today, observed]);
  return { observed, skipped: false, alreadyDone: false };
}
