import "server-only";

import type { SqlExecutor } from "../postgres/client";
import { ACTIVE_SEARCH_WATCH_DAILY_BUDGET, ACTIVE_SEARCH_WATCH_FREQUENCY_SECONDS } from "../active-search/config";
import { activeSearchSchemaPresent } from "../active-search/state";
import { WATCH_CLAIM_LEASE_SECONDS } from "./config";
import { productKeyOf, productKeyString } from "./product-key";
import type { ClaimedWatch, ProductKey, WatchRow } from "./types";

/**
 * Surveillances de marché (lot EXT1) : UNE par clé produit, partagée par tous les besoins actifs qui ont cette clé (c'est la mutualisation : trois besoins « iPhone 12 à Abidjan »
 * coûtent UNE collecte). Créée ou rattachée automatiquement quand un besoin actif apparaît (`syncMarketWatches`, appelée par l'étape « collect » à chaque cycle), mise en pause
 * quand plus aucun besoin actif ne la référence. Une seule instruction par opération, sur `pool.query` : aucune connexion dédiée, donc rien à tenir en cas de panne.
 */

export const WATCH_COLUMNS = "id, product_key, category, brand, model, variant, zone, status, frequency_seconds, daily_request_budget, last_run_at, next_run_at, accelerated";

export interface SyncResult {
  /** Clés produit portées par au moins un besoin actif. */
  activeKeys: number;
  created: number;
  reactivated: number;
  paused: number;
  /** Surveillances passées à la fréquence rapide (1 h) parce qu'au moins un besoin actif de leur clé a la recherche active (lot RA1). */
  accelerated: number;
  /** Surveillances revenues à la fréquence ordinaire (6 h) : plus aucun besoin actif de leur clé n'a la recherche active. */
  decelerated: number;
}

interface DemandKeyRow {
  category: string;
  brand: string;
  model: string;
  variant: string | null;
  location_text: string | null;
}

/**
 * Les clés produit des besoins ACTIFS (propriétaire actif, besoin non archivé), dédoublonnées après normalisation, triées (ordre de verrouillage stable). `ownerId` restreint aux
 * besoins d'un seul utilisateur (amorçage de démonstration). Lot MV1 : le besoin porteur d'une mission EN PAUSE n'est pas un besoin vivant, il ne fait pas surveiller de marché.
 */
export async function readActiveDemandKeys(executor: SqlExecutor, ownerId: string | null = null): Promise<Array<{ text: string; key: ProductKey }>> {
  // Lot MV1 : sans la table des missions (migration 0027 pas encore appliquée), aucun besoin n'est un besoin porteur : la collecte continue sans erreur.
  const missions = await executor.query<{ present: boolean }>("SELECT to_regclass('missions') IS NOT NULL AS present");
  const pausedCarriers = missions.rows[0]?.present === true ? "AND NOT EXISTS (SELECT 1 FROM missions mp WHERE mp.demand_id = d.id AND mp.status = 'paused')" : "";
  const rows = await executor.query<DemandKeyRow>(
    `SELECT d.category, d.brand, d.model, d.variant, d.location_text
       FROM demands d JOIN users u ON u.id = d.owner_id
      WHERE d.status = 'active' AND d.archived_at IS NULL AND u.status = 'active' AND u.archived_at IS NULL
        ${pausedCarriers}
        AND d.category IS NOT NULL AND d.brand IS NOT NULL AND d.model IS NOT NULL AND ($1::uuid IS NULL OR d.owner_id = $1::uuid)
      GROUP BY d.category, d.brand, d.model, d.variant, d.location_text`,
    [ownerId],
  );
  const keys = new Map<string, ProductKey>();
  for (const row of rows.rows) {
    const key = productKeyOf({ category: row.category, brand: row.brand, model: row.model, variant: row.variant, location: row.location_text });
    if (key !== null) keys.set(productKeyString(key), key);
  }
  return [...keys.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([text, key]) => ({ text, key }));
}

/**
 * Crée les surveillances manquantes, réactive celles qui étaient en pause et remet en pause celles qu'aucun besoin actif ne référence. Une surveillance existante garde sa
 * fréquence, son budget et son échéance. Idempotente.
 */
export async function syncMarketWatches(executor: SqlExecutor, now: Date): Promise<SyncResult> {
  const keys = await readActiveDemandKeys(executor);
  const texts = keys.map((entry) => entry.text);
  // Aucune de ces instructions n'attend un verrou tenu par un autre processus : création sans mise à jour (`DO NOTHING`), réactivation et pause en `SKIP LOCKED`
  // (une surveillance momentanément verrouillée est traitée au cycle suivant).
  const inserted = await executor.query<{ created: number }>(
    `WITH wanted AS (
       SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[]) AS k(product_key, category, brand, model, variant, zone)
        ORDER BY product_key
     ), written AS (
       INSERT INTO market_watches (product_key, category, brand, model, variant, zone, next_run_at, created_at, updated_at)
       SELECT product_key, category, brand, model, NULLIF(variant, ''), zone, $7::timestamptz, $7::timestamptz, $7::timestamptz FROM wanted ORDER BY product_key
       ON CONFLICT (product_key) DO NOTHING
       RETURNING 1
     )
     SELECT count(*)::int AS created FROM written`,
    [
      texts,
      keys.map((entry) => entry.key.category),
      keys.map((entry) => entry.key.brand),
      keys.map((entry) => entry.key.model),
      keys.map((entry) => entry.key.variant ?? ""),
      keys.map((entry) => entry.key.zone),
      now,
    ],
  );
  const reactivated = await executor.query(
    `UPDATE market_watches SET status = 'active', paused_at = NULL, updated_at = $2::timestamptz
      WHERE id IN (SELECT id FROM market_watches WHERE status = 'paused' AND product_key = ANY($1::text[]) ORDER BY id FOR UPDATE SKIP LOCKED)`,
    [texts, now],
  );
  const paused = await executor.query(
    `UPDATE market_watches SET status = 'paused', paused_at = $2::timestamptz, updated_at = $2::timestamptz
      WHERE id IN (
        SELECT w.id FROM market_watches w
         WHERE w.status = 'active' AND NOT EXISTS (SELECT 1 FROM unnest($1::text[]) k WHERE k = w.product_key)
         ORDER BY w.id FOR UPDATE SKIP LOCKED)`,
    [texts, now],
  );
  const speeds = await syncWatchFrequencies(executor, now);
  return { activeKeys: keys.length, created: inserted.rows[0]?.created ?? 0, reactivated: reactivated.rowCount ?? 0, paused: paused.rowCount ?? 0, ...speeds };
}

/**
 * Clés des besoins ACTIFS (propriétaire actif) dont la recherche active est en vigueur à `now`. Sans la migration 0028, aucune. Lot MV1 : un besoin PORTEUR d'une mission (en pause ou non)
 * n'accélère JAMAIS une surveillance (il n'est pas un besoin de l'acheteur : l'option ne s'y achète pas, et une éventuelle ligne d'achat n'aurait aucun effet sur la collecte).
 */
export async function readActiveSearchKeys(executor: SqlExecutor, now: Date): Promise<string[]> {
  if (!(await activeSearchSchemaPresent(executor))) return [];
  // Comme `readActiveDemandKeys` : sans la table des missions (jamais le cas quand la 0028 est appliquée, mais une panne de cette table ne doit pas arrêter la collecte), aucun besoin n'est porteur.
  const missions = await executor.query<{ present: boolean }>("SELECT to_regclass('missions') IS NOT NULL AS present");
  const carriers = missions.rows[0]?.present === true ? "AND NOT EXISTS (SELECT 1 FROM missions mc WHERE mc.demand_id = d.id)" : "";
  const rows = await executor.query<DemandKeyRow>(
    `SELECT d.category, d.brand, d.model, d.variant, d.location_text
       FROM demands d JOIN users u ON u.id = d.owner_id
      WHERE d.status = 'active' AND d.archived_at IS NULL AND u.status = 'active' AND u.archived_at IS NULL
        ${carriers}
        AND d.category IS NOT NULL AND d.brand IS NOT NULL AND d.model IS NOT NULL
        AND EXISTS (SELECT 1 FROM active_search_purchases p
                     WHERE p.demand_id = d.id AND p.status = 'active' AND p.refunded_at IS NULL AND p.starts_at <= $1::timestamptz AND p.ends_at > $1::timestamptz)
      GROUP BY d.category, d.brand, d.model, d.variant, d.location_text`,
    [now],
  );
  const keys = new Set<string>();
  for (const row of rows.rows) {
    const key = productKeyOf({ category: row.category, brand: row.brand, model: row.model, variant: row.variant, location: row.location_text });
    if (key !== null) keys.add(productKeyString(key));
  }
  return [...keys].sort();
}

/**
 * Fréquence d'une surveillance PARTAGÉE (lots RA1 et RA1-bis) : la plus élevée demandée par ses besoins actifs. Si au moins un besoin ACTIF de la clé a la recherche active en vigueur, la
 * surveillance passe à `LEAST(intervalle actuel, 1 h)` et `GREATEST(budget actuel, 24 requêtes par jour et par source)` : l'accélération ne ralentit JAMAIS une surveillance déjà plus
 * rapide ou mieux dotée. Ses valeurs d'AVANT sont gardées (`base_frequency_seconds`, `base_daily_request_budget`, `accelerated`) et rétablies quand plus aucun besoin actif de la clé n'a
 * l'option (un besoin SATISFAIT suspend l'option : il n'accélère rien). Une surveillance qu'aucun changement ne concerne (déjà au moins aussi rapide et dotée) n'est pas marquée accélérée.
 * Les quotas journaliers de chaque SOURCE s'appliquent toujours, et les surveillances accélérées ne peuvent en consommer que la moitié (`reserveRequest`). Quand la fréquence monte, la
 * prochaine collecte est avancée (jamais pendant le bail d'une collecte en cours : `claim_token` doit être vide ; la collecte en cours relit la fréquence à sa clôture,
 * `readLeasedFrequency`). À la décélération, des valeurs réglées à la main depuis l'accélération ne sont pas écrasées. Instructions sans attente de verrou (`SKIP LOCKED`) : une
 * surveillance verrouillée est traitée au cycle suivant.
 */
async function syncWatchFrequencies(executor: SqlExecutor, now: Date): Promise<{ accelerated: number; decelerated: number }> {
  if (!(await activeSearchSchemaPresent(executor))) return { accelerated: 0, decelerated: 0 };
  const boosted = await readActiveSearchKeys(executor, now);
  const accelerated = await executor.query(
    `UPDATE market_watches
        SET base_frequency_seconds = frequency_seconds, base_daily_request_budget = daily_request_budget, accelerated = TRUE,
            frequency_seconds = LEAST(frequency_seconds, $1::int), daily_request_budget = GREATEST(daily_request_budget, $2::int),
            next_run_at = CASE WHEN claim_token IS NULL AND last_run_at IS NOT NULL AND next_run_at > $4::timestamptz
                               THEN LEAST(next_run_at, last_run_at + (LEAST(frequency_seconds, $1::int) * interval '1 second')) ELSE next_run_at END,
            updated_at = $4::timestamptz
      WHERE id IN (SELECT id FROM market_watches
                    WHERE product_key = ANY($3::text[]) AND NOT accelerated AND (frequency_seconds > $1::int OR daily_request_budget < $2::int)
                    ORDER BY id FOR UPDATE SKIP LOCKED)`,
    [ACTIVE_SEARCH_WATCH_FREQUENCY_SECONDS, ACTIVE_SEARCH_WATCH_DAILY_BUDGET, boosted, now],
  );
  const decelerated = await executor.query(
    `UPDATE market_watches
        SET frequency_seconds = CASE WHEN frequency_seconds = LEAST(base_frequency_seconds, $1::int) AND daily_request_budget = GREATEST(base_daily_request_budget, $2::int)
                                     THEN base_frequency_seconds ELSE frequency_seconds END,
            daily_request_budget = CASE WHEN frequency_seconds = LEAST(base_frequency_seconds, $1::int) AND daily_request_budget = GREATEST(base_daily_request_budget, $2::int)
                                        THEN base_daily_request_budget ELSE daily_request_budget END,
            accelerated = FALSE, base_frequency_seconds = NULL, base_daily_request_budget = NULL, updated_at = $4::timestamptz
      WHERE id IN (SELECT id FROM market_watches WHERE accelerated AND NOT (product_key = ANY($3::text[])) ORDER BY id FOR UPDATE SKIP LOCKED)`,
    [ACTIVE_SEARCH_WATCH_FREQUENCY_SECONDS, ACTIVE_SEARCH_WATCH_DAILY_BUDGET, boosted, now],
  );
  return { accelerated: accelerated.rowCount ?? 0, decelerated: decelerated.rowCount ?? 0 };
}

export interface ClaimOptions {
  limit: number;
  /** Seulement ces surveillances (et sans exiger qu'elles soient dues) : essais et amorçage de démonstration. */
  only?: readonly string[];
}

/**
 * Réserve les surveillances dues : `FOR UPDATE SKIP LOCKED` (une surveillance tenue par un autre processus est laissée), puis bail de 10 minutes posé sur `next_run_at` et JETON
 * de bail (`claim_token`, aléatoire) dans la MÊME instruction : deux processus ne collectent jamais la même surveillance. Si le processus meurt, la surveillance redevient due à
 * l'échéance du bail. Le jeton sert à `renewLease`, `finishWatch` et `releaseWatches` : un exécuteur dont le bail a expiré (processus figé) et qu'un autre a repris n'écrase rien.
 */
export async function claimDueWatches(executor: SqlExecutor, now: Date, options: ClaimOptions): Promise<ClaimedWatch[]> {
  const only = options.only === undefined ? null : [...options.only];
  const claimed = await executor.query<ClaimedWatch>(
    `UPDATE market_watches w
        SET next_run_at = $1::timestamptz + ($3::int * interval '1 second'), claim_token = gen_random_uuid(), updated_at = $1::timestamptz
       FROM (
         SELECT id FROM market_watches
          WHERE status = 'active' AND (($4::uuid[] IS NULL AND next_run_at <= $1::timestamptz) OR ($4::uuid[] IS NOT NULL AND id = ANY($4::uuid[])))
          ORDER BY next_run_at, id
          LIMIT $2::int
          FOR UPDATE SKIP LOCKED
       ) due
      WHERE w.id = due.id
      RETURNING w.id, w.product_key, w.category, w.brand, w.model, w.variant, w.zone, w.status, w.frequency_seconds, w.daily_request_budget, w.last_run_at, w.next_run_at, w.accelerated, w.claim_token`,
    [now, options.limit, WATCH_CLAIM_LEASE_SECONDS, only],
  );
  return claimed.rows;
}

/**
 * Revérifie le bail AVANT d'interroger les sources, et le prolonge de 10 minutes : vrai seulement si cet exécuteur détient toujours le jeton (nul autre n'a repris la surveillance) et
 * qu'elle est toujours active. Faux : la surveillance appartient à un autre, rien ne doit être demandé aux sources ni écrit sur la surveillance.
 */
export async function renewLease(executor: SqlExecutor, watch: Pick<ClaimedWatch, "id" | "claim_token">, now: Date): Promise<boolean> {
  const renewed = await executor.query(
    `UPDATE market_watches SET next_run_at = $3::timestamptz + ($4::int * interval '1 second'), updated_at = $3::timestamptz
      WHERE id = $1::uuid AND claim_token = $2::uuid AND status = 'active'`,
    [watch.id, watch.claim_token, now, WATCH_CLAIM_LEASE_SECONDS],
  );
  return (renewed.rowCount ?? 0) > 0;
}

/**
 * Fréquence ACTUELLE d'une surveillance dont cet exécuteur détient le bail (jeton), lue juste avant la clôture : une option de recherche active achetée PENDANT la collecte change la
 * fréquence en base, et la prochaine échéance doit en tenir compte (sinon la surveillance attendrait 6 h au lieu d'1 h). Null : le bail n'est plus le nôtre.
 */
export async function readLeasedFrequency(executor: SqlExecutor, watch: Pick<ClaimedWatch, "id" | "claim_token">): Promise<number | null> {
  const result = await executor.query<{ frequency_seconds: number }>("SELECT frequency_seconds FROM market_watches WHERE id = $1::uuid AND claim_token = $2::uuid", [watch.id, watch.claim_token]);
  return result.rows[0]?.frequency_seconds ?? null;
}

/**
 * Fin d'une collecte : dernière exécution et prochaine échéance, CONDITIONNÉES au jeton du bail (le jeton est effacé). Faux : le bail a été repris par un autre exécuteur, dont
 * l'échéance est conservée (rien n'est écrit).
 */
export async function finishWatch(executor: SqlExecutor, watch: Pick<ClaimedWatch, "id" | "claim_token">, now: Date, nextRunAt: Date): Promise<boolean> {
  const finished = await executor.query(
    `UPDATE market_watches SET last_run_at = $3::timestamptz, next_run_at = $4::timestamptz, claim_token = NULL, updated_at = $3::timestamptz
      WHERE id = $1::uuid AND claim_token = $2::uuid`,
    [watch.id, watch.claim_token, now, nextRunAt],
  );
  return (finished.rowCount ?? 0) > 0;
}

/** Rend des surveillances réservées mais non traitées (budget de temps, arrêt demandé) : elles redeviennent dues tout de suite, si leur bail est toujours le nôtre. */
export async function releaseWatches(executor: SqlExecutor, watches: ReadonlyArray<Pick<ClaimedWatch, "id" | "claim_token">>, now: Date): Promise<void> {
  if (watches.length === 0) return;
  await executor.query(
    `UPDATE market_watches w SET next_run_at = $3::timestamptz, claim_token = NULL, updated_at = $3::timestamptz
       FROM unnest($1::uuid[], $2::uuid[]) AS c(id, token)
      WHERE w.id = c.id AND w.claim_token = c.token`,
    [watches.map((watch) => watch.id), watches.map((watch) => watch.claim_token), now],
  );
}

export async function readWatchByKey(executor: SqlExecutor, key: ProductKey): Promise<(WatchRow & { paused_at: Date | null }) | null> {
  const result = await executor.query<WatchRow & { paused_at: Date | null }>(
    `SELECT ${WATCH_COLUMNS}, paused_at FROM market_watches WHERE product_key = $1`,
    [productKeyString(key)],
  );
  return result.rows[0] ?? null;
}
