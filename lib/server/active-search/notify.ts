import "server-only";

import type { Pool, PoolClient } from "pg";
import { CatalogNotFoundError, CatalogValidationError } from "../catalog/errors";
import type { DemandRecord } from "../catalog/types";
import { isDuplicatePair } from "../external/duplicates";
import { evaluateExternalForDemand, type CollapsedListing, type ExternalEvaluation } from "../external/matching";
import { productKeyOf, productKeyString } from "../external/product-key";
import { loadSourceDemand } from "../matching/service";
import {
  EXTERNAL_COLLECTION_WINDOW_MS,
  NEW_MATCH_DAILY_CAP_PER_DEMAND,
  NEW_MATCH_DAILY_CAP_PER_USER,
  NOTIFICATION_CAP_LOCK_NAMESPACE,
  SIMULATED_CHANNEL,
} from "../notifications/config";
import { buildExternalDeliveryContent, buildExternalNotificationTitle, buildExternalSourceName, buildNotificationPrice } from "../notifications/content";
import { markBaselinePending, takeBaseline } from "./baseline";
import {
  ACTIVE_SEARCH_FRESH_COLLECTION_MS,
  ACTIVE_SEARCH_NOTIFY_BATCH,
  ACTIVE_SEARCH_SCAN_LOCK_TIMEOUT_MS,
  ACTIVE_SEARCH_STEP_BUDGET_MS,
  ACTIVE_SEARCH_STEP_MAX_DEMANDS,
  ACTIVE_SEARCH_USER_LOCK_NAMESPACE,
} from "./config";
import { activeSearchSchemaPresent } from "./state";

/**
 * Notifications « annonce d'un AUTRE SITE » de la recherche active (lot RA1), produites par l'étape « activeSearch » du worker, APRÈS la collecte. Pour chaque besoin ACTIF qui a une
 * option en vigueur :
 *  - jamais pour l'EXISTANT : les annonces déjà présentes à l'activation, ou à la dernière modification du besoin, sont « vues » (`baseline`) ; tant que la surveillance du besoin n'a
 *    pas de collecte RÉUSSIE de moins de 48 h (au-delà, plus aucune annonce n'est visible : un relevé serait faussement vide), le relevé reste EN ATTENTE de la première collecte récente.
 *    Besoin modifié : si la clé produit change (ou si la surveillance n'a pas de collecte récente), relevé complet de la nouvelle clé ou relevé en attente ; si la clé ne change pas, le
 *    relevé a pour instant de coupure le dernier horizon de balayage, de sorte que les annonces vues pour la première fois DEPUIS restent nouvelles. DÉFENSE, quel que soit le chemin :
 *    une annonce dont la première vue (`first_seen_at`, du groupe de doublons le plus ancien) ne dépasse pas l'instant de coupure du relevé n'est jamais notifiée ;
 *  - un besoin n'est réexaminé que si sa surveillance a été collectée depuis son dernier balayage : `market_watches.last_run_at > active_search_state.scanned_at`, où `scanned_at` est le
 *    FILIGRANE du balayage (la dernière collecte lue avant les annonces, jamais l'horloge du processus). Sans collecte, le balayage ne coûte aucune lecture des annonces ;
 *  - une seule fois : une annonce n'est notifiée qu'une fois par besoin, et un groupe de doublons entre sources aussi. L'annonce présentée ET les annonces qu'elle absorbe (doublons
 *    REVÉRIFIÉS comme à la lecture : même adresse, ou prix à 2 % près, mêmes nombres dans le titre et titre proche) sont marquées vues ; un membre de groupe qui n'est plus un doublon
 *    (capacité, prix) n'est jamais marqué par un autre. Une annonce qui est un doublon vérifié d'une annonce DÉJÀ vue n'est pas notifiée, même si le regroupement stocké est en retard ;
 *  - mêmes filtres de compatibilité et même fraîcheur (vue il y a moins de 48 h) que les résultats (`evaluateExternalForDemand`) : jamais une annonce hors budget, sans lieu, d'un autre
 *    modèle ou d'une capacité différente ;
 *  - mêmes PLAFONDS que N1 : 20 par besoin et 50 par utilisateur et par jour UTC (les notifications d'annonces internes et d'autres sites comptent ensemble), au-delà un seul résumé par
 *    besoin et par jour ; mêmes ENVOIS externes simulés (fenêtre de collecte de 15 min, regroupés, 4 h entre deux messages, 3 par jour, heures calmes) et mêmes préférences ;
 *  - suivi en pause ou échu : aucune notification (les annonces restent « non vues » : elles notifieront à la reprise) ;
 *  - contenu en liste blanche : titre nettoyé, prix, nom de la source, lien vers la page du BESOIN (jamais l'URL de l'annonce externe, jamais un numéro de téléphone).
 * UNE transaction par besoin, sous un verrou consultatif TENTÉ (jamais attendu) : la marque « vue » est la barrière contre le double envoi, même si deux processus balayent le même besoin.
 * Budget de temps et nombre de besoins par passage bornés : le reste attend le cycle suivant.
 */

export interface ScanResult {
  /** Migration 0028 absente : balayage ignoré sans erreur. */
  skipped: boolean;
  /** Besoins avec une option en vigueur examinés (balayés ou relevés) pendant ce passage. */
  examined: number;
  /** Notifications créées (une ligne par annonce). */
  notified: number;
  /** Annonces ajoutées à un résumé (au-delà des plafonds). */
  digested: number;
  /** Besoins dont la liste d'annonces existantes a été relevée (sans notification). */
  baselines: number;
  /** Besoins laissés sans notification parce que le suivi est en pause ou échu. */
  trackingHeld: number;
  /** Lignes d'envoi externe simulé créées. */
  deliveries: number;
  /** Besoins laissés au passage suivant : budget de temps ou nombre maximal atteint. */
  deferred: number;
  /** Besoins dont le verrou de balayage ou un verrou d'écriture était tenu par un autre processus : repris au passage suivant (jamais une erreur). */
  busy: number;
  /** Codes stables des erreurs (jamais un message). */
  errors: string[];
}

export function emptyScanResult(): ScanResult {
  return { skipped: false, examined: 0, notified: 0, digested: 0, baselines: 0, trackingHeld: 0, deliveries: 0, deferred: 0, busy: 0, errors: [] };
}

export interface ScanCandidate {
  id: string;
  owner_id: string;
  category: string;
  brand: string;
  model: string;
  variant: string | null;
  location_text: string | null;
  content_version: number;
  paused: boolean;
  tracking_live: boolean;
  baseline_pending: boolean | null;
  state_version: number | null;
  scanned_at: Date | null;
}

export interface ScanWatch {
  product_key: string;
  last_run_at: Date | null;
  /** La surveillance a une collecte RÉUSSIE de moins de 48 h : seule une collecte récente peut servir de relevé (au-delà, aucune annonce n'est plus visible). */
  has_fresh_ok_run: boolean;
}

export interface ScanOptions {
  pool: Pool;
  now: Date;
  budgetMs?: number;
  maxDemands?: number;
}

/** Les besoins qui ont une option en vigueur à `now` (besoin et propriétaire actifs), les moins récemment balayés d'abord. */
async function readCandidates(pool: Pool, now: Date): Promise<ScanCandidate[]> {
  const result = await pool.query<ScanCandidate>(
    `SELECT d.id, d.owner_id, d.category, d.brand, d.model, d.variant, d.location_text, d.content_version,
            d.notify_paused AS paused, (d.notify_until > $1::timestamptz) AS tracking_live,
            s.baseline_pending, s.content_version AS state_version, s.scanned_at
       FROM demands d
       JOIN users u ON u.id = d.owner_id AND u.status = 'active' AND u.archived_at IS NULL
       LEFT JOIN active_search_state s ON s.demand_id = d.id
      WHERE d.status = 'active' AND d.archived_at IS NULL AND d.category IS NOT NULL AND d.brand IS NOT NULL AND d.model IS NOT NULL
        AND EXISTS (SELECT 1 FROM active_search_purchases p
                     WHERE p.demand_id = d.id AND p.status = 'active' AND p.refunded_at IS NULL AND p.starts_at <= $1::timestamptz AND p.ends_at > $1::timestamptz)
      ORDER BY s.scanned_at NULLS FIRST, d.id`,
    [now],
  );
  return result.rows;
}

function keyTextOf(candidate: Pick<ScanCandidate, "category" | "brand" | "model" | "variant" | "location_text">): string | null {
  const key = productKeyOf({ category: candidate.category, brand: candidate.brand, model: candidate.model, variant: candidate.variant, location: candidate.location_text });
  return key === null ? null : productKeyString(key);
}

function errorCodeOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[A-Za-z0-9_]{1,40}$/.test(code) ? code.toLowerCase() : "unknown";
}

/**
 * Le besoin doit-il être relevé ou balayé à ce passage ? Présélection : elle est refaite sous le verrou, sur des lectures fraîches. Un relevé en attente attend la première collecte
 * RÉUSSIE de la surveillance ; un besoin modifié depuis le relevé est relevé aussitôt ; sinon un balayage n'a lieu que si la surveillance a été collectée depuis (filigrane).
 */
export function needsScan(candidate: Pick<ScanCandidate, "baseline_pending" | "state_version" | "content_version" | "scanned_at">, watch: ScanWatch | undefined): boolean {
  if (candidate.baseline_pending !== false) return watch !== undefined && watch.has_fresh_ok_run;
  if (candidate.state_version !== candidate.content_version) return true;
  return watch !== undefined && watch.last_run_at !== null && (candidate.scanned_at === null || watch.last_run_at.getTime() > candidate.scanned_at.getTime());
}

export async function scanActiveSearchDemands(options: ScanOptions): Promise<ScanResult> {
  const { pool, now } = options;
  const result = emptyScanResult();
  if (!(await activeSearchSchemaPresent(pool))) return { ...result, skipped: true };
  const began = performance.now();
  const budgetMs = options.budgetMs ?? ACTIVE_SEARCH_STEP_BUDGET_MS;
  const maxDemands = options.maxDemands ?? ACTIVE_SEARCH_STEP_MAX_DEMANDS;

  const candidates = await readCandidates(pool, now);
  const keyTexts = [...new Set(candidates.map(keyTextOf).filter((text): text is string => text !== null))];
  const watches = new Map<string, ScanWatch>();
  if (keyTexts.length > 0) {
    const rows = await pool.query<ScanWatch>(
      `SELECT w.product_key, w.last_run_at,
              EXISTS (SELECT 1 FROM external_collect_runs r WHERE r.watch_id = w.id AND r.status = 'ok' AND r.finished_at >= $2::timestamptz) AS has_fresh_ok_run
         FROM market_watches w WHERE w.product_key = ANY($1::text[])`,
      [keyTexts, new Date(now.getTime() - ACTIVE_SEARCH_FRESH_COLLECTION_MS)],
    );
    for (const row of rows.rows) watches.set(row.product_key, row);
  }

  const work: ScanCandidate[] = [];
  const reset: string[] = [];
  for (const candidate of candidates) {
    if (candidate.paused || !candidate.tracking_live) {
      // Suivi en pause ou échu : aucune notification. Le balayage est « à refaire » (filigrane vidé) pour que les annonces arrivées pendant la pause notifient à la reprise.
      result.trackingHeld += 1;
      if (candidate.scanned_at !== null) reset.push(candidate.id);
      continue;
    }
    const keyText = keyTextOf(candidate);
    if (needsScan(candidate, keyText === null ? undefined : watches.get(keyText))) work.push(candidate);
  }
  if (reset.length > 0) {
    await pool.query("UPDATE active_search_state SET scanned_at = NULL WHERE demand_id = ANY($1::uuid[]) AND scanned_at IS NOT NULL", [reset]);
  }

  for (const [index, candidate] of work.entries()) {
    if (index >= maxDemands || performance.now() - began > budgetMs) {
      result.deferred += work.length - index;
      break;
    }
    try {
      const outcome = await scanDemand(pool, candidate, now);
      if (outcome.busy) result.busy += 1;
      if (outcome.examined) result.examined += 1;
      result.notified += outcome.notified;
      result.digested += outcome.digested;
      result.baselines += outcome.baseline ? 1 : 0;
      result.deliveries += outcome.deliveries;
    } catch (error) {
      // Un verrou tenu trop longtemps (55P03) n'est pas une erreur : le besoin est repris au passage suivant. Les autres besoins continuent.
      if ((error as { code?: unknown } | null)?.code === "55P03") result.busy += 1;
      else {
        const code = errorCodeOf(error);
        if (!result.errors.includes(code)) result.errors.push(code);
      }
    }
  }
  return result;
}

interface DemandOutcome {
  examined: boolean;
  busy: boolean;
  notified: number;
  digested: number;
  baseline: boolean;
  deliveries: number;
}

const NONE: DemandOutcome = { examined: false, busy: false, notified: 0, digested: 0, baseline: false, deliveries: 0 };

/** UNE transaction pour un besoin. Un besoin devenu inéligible entre la présélection et le verrou (archivé, propriétaire suspendu) est simplement ignoré. */
async function scanDemand(pool: Pool, candidate: ScanCandidate, now: Date): Promise<DemandOutcome> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL lock_timeout = '${ACTIVE_SEARCH_SCAN_LOCK_TIMEOUT_MS}ms'`);
    // Verrou TENTÉ, jamais attendu : un autre processus balaye déjà ce besoin.
    const lock = await client.query<{ ok: boolean }>("SELECT pg_try_advisory_xact_lock($1::int, hashtext($2)) AS ok", [ACTIVE_SEARCH_USER_LOCK_NAMESPACE, `scan:${candidate.id}`]);
    if (lock.rows[0].ok !== true) {
      await client.query("ROLLBACK");
      return { ...NONE, busy: true };
    }
    const outcome = await scanDemandLocked(client, candidate, now);
    await client.query("COMMIT");
    return outcome;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    if (error instanceof CatalogNotFoundError || error instanceof CatalogValidationError) return NONE;
    throw error;
  } finally {
    client.release();
  }
}

async function readWatch(client: PoolClient, keyText: string, now: Date): Promise<ScanWatch | undefined> {
  const rows = await client.query<ScanWatch>(
    `SELECT w.product_key, w.last_run_at,
            EXISTS (SELECT 1 FROM external_collect_runs r WHERE r.watch_id = w.id AND r.status = 'ok' AND r.finished_at >= $2::timestamptz) AS has_fresh_ok_run
       FROM market_watches w WHERE w.product_key = $1`,
    [keyText, new Date(now.getTime() - ACTIVE_SEARCH_FRESH_COLLECTION_MS)],
  );
  return rows.rows[0];
}

async function scanDemandLocked(client: PoolClient, candidate: ScanCandidate, now: Date): Promise<DemandOutcome> {
  // Lectures FRAÎCHES sous le verrou : le besoin, son option et son état ont pu changer depuis la présélection.
  const demand = await loadSourceDemand(candidate.owner_id, candidate.id, client);
  const live = await client.query(
    `SELECT 1 FROM active_search_purchases p
      WHERE p.demand_id = $1::uuid AND p.status = 'active' AND p.refunded_at IS NULL AND p.starts_at <= $2::timestamptz AND p.ends_at > $2::timestamptz LIMIT 1`,
    [demand.id, now],
  );
  if (!live.rowCount) return NONE;
  const tracking = await client.query<{ paused: boolean; live: boolean }>("SELECT notify_paused AS paused, (notify_until > $2::timestamptz) AS live FROM demands WHERE id = $1::uuid", [demand.id, now]);
  if (tracking.rows[0].paused || !tracking.rows[0].live) return NONE;
  const state = await client.query<{ baseline_pending: boolean; content_version: number; product_key: string | null; baseline_cutoff_at: Date | null; scan_horizon_at: Date | null }>(
    "SELECT baseline_pending, content_version, product_key, baseline_cutoff_at, scan_horizon_at FROM active_search_state WHERE demand_id = $1::uuid",
    [demand.id],
  );
  const keyText = keyTextOf({ category: demand.category ?? "", brand: demand.brand ?? "", model: demand.model ?? "", variant: demand.variant, location_text: demand.location });
  const watch = keyText === null ? undefined : await readWatch(client, keyText, now);
  const known = state.rows[0];

  // Relevé de l'existant (jamais de notification). EN ATTENTE (option activée sans collecte récente de la surveillance) : dès que sa première collecte RÉUSSIE de moins de 48 h a eu lieu.
  const pending = known === undefined || known.baseline_pending;
  if (pending) {
    if (!(watch !== undefined && watch.has_fresh_ok_run)) return NONE;
    await takeBaseline(client, candidate.owner_id, demand.id, now);
    return { ...NONE, examined: true, baseline: true };
  }
  // BESOIN MODIFIÉ depuis le dernier relevé. La clé produit change (ou la surveillance de la clé n'a aucune collecte réussie récente) : relevé COMPLET de la nouvelle clé, ou EN ATTENTE de sa
  // première collecte réussie, jamais un relevé vide qui laisserait notifier l'existant. La clé ne change pas : nouveau relevé dont l'instant de coupure est le dernier horizon de balayage,
  // de sorte que les annonces vues pour la première fois DEPUIS (arrivées pendant une pause, par exemple) restent nouvelles ; elles sont examinées dans la foulée.
  if (known.content_version !== demand.contentVersion) {
    if (!(watch !== undefined && watch.has_fresh_ok_run)) {
      await markBaselinePending(client, demand.id, keyText, demand.contentVersion, now);
      return { ...NONE, examined: true };
    }
    const sameKey = keyText !== null && known.product_key === keyText;
    await takeBaseline(client, candidate.owner_id, demand.id, now, sameKey && known.scan_horizon_at !== null ? known.scan_horizon_at : now);
    const rest = await notifyFresh(client, candidate, demand, now, sameKey && known.scan_horizon_at !== null ? known.scan_horizon_at : now);
    return { ...rest, baseline: true };
  }
  if (watch === undefined || watch.last_run_at === null) return NONE;
  return await notifyFresh(client, candidate, demand, now, known.baseline_cutoff_at);
}

/**
 * Les annonces à NOTIFIER parmi les annonces compatibles : ni vues, ni doublons (groupe absorbé ou doublon vérifié) d'une annonce déjà vue. Les identifiants à marquer « doublon » sont
 * renvoyés à part (`covered`) : ils ne notifient jamais, mais restent couverts si l'annonce vue disparaît.
 */
export function selectFreshListings(
  evaluation: Pick<ExternalEvaluation, "items" | "candidates">,
  seen: ReadonlySet<string>,
  cutoff: Date | null = null,
): { fresh: CollapsedListing[]; covered: string[]; existing: string[] } {
  const fresh: CollapsedListing[] = [];
  const covered: string[] = [];
  const existing: string[] = [];
  const firstSeen = new Map(evaluation.candidates.map((candidate) => [candidate.row.id, candidate.row.first_seen_at.getTime()]));
  for (const item of evaluation.items) {
    const ids = [item.entry.row.id, ...item.absorbedIds];
    if (ids.some((id) => seen.has(id))) {
      // Déjà notifiée, ou doublon d'une annonce déjà notifiée : les autres membres du groupe vérifié sont marqués pour que le groupe reste couvert.
      for (const id of ids) if (!seen.has(id)) covered.push(id);
      continue;
    }
    // DÉFENSE (quel que soit le chemin qui a mené ici) : une annonce vue pour la première fois AVANT l'instant de coupure du relevé est de l'EXISTANT, jamais une annonce nouvelle ; un doublon
    // d'une annonce existante l'est aussi (on regarde la plus ancienne vue du groupe vérifié).
    if (cutoff !== null && Math.min(...ids.map((id) => firstSeen.get(id) ?? Number.POSITIVE_INFINITY)) <= cutoff.getTime()) {
      existing.push(...ids);
      continue;
    }
    // Doublon VÉRIFIÉ d'une annonce déjà vue mais non regroupée (regroupement en retard) : couverte aussi.
    if (evaluation.candidates.some((other) => seen.has(other.row.id) && isDuplicatePair(item.entry.candidate, other.candidate))) {
      covered.push(...ids);
      continue;
    }
    fresh.push(item);
  }
  return { fresh, covered, existing };
}

async function notifyFresh(client: PoolClient, candidate: ScanCandidate, demand: DemandRecord, now: Date, cutoff: Date | null): Promise<DemandOutcome> {
  const evaluation = await evaluateExternalForDemand(client, demand, now);
  const watermark = evaluation.watch?.last_run_at ?? null;
  const seenRows = await client.query<{ listing_id: string }>("SELECT listing_id FROM active_search_seen WHERE demand_id = $1::uuid", [demand.id]);
  const seen = new Set(seenRows.rows.map((row) => row.listing_id));
  const { fresh, covered, existing } = selectFreshListings(evaluation, seen, cutoff);
  const outcome: DemandOutcome = { ...NONE, examined: true };
  if (existing.length > 0) {
    await client.query(
      "INSERT INTO active_search_seen (demand_id, listing_id, reason) SELECT $1::uuid, unnest($2::uuid[]), 'baseline' ON CONFLICT (demand_id, listing_id) DO NOTHING",
      [demand.id, [...new Set(existing)]],
    );
  }
  if (covered.length > 0) {
    await client.query(
      "INSERT INTO active_search_seen (demand_id, listing_id, reason) SELECT $1::uuid, unnest($2::uuid[]), 'duplicate' ON CONFLICT (demand_id, listing_id) DO NOTHING",
      [demand.id, [...new Set(covered)]],
    );
  }
  const batch = fresh.slice(0, ACTIVE_SEARCH_NOTIFY_BATCH);
  const complete = fresh.length <= ACTIVE_SEARCH_NOTIFY_BATCH;
  if (batch.length > 0) {
    const preference = await client.query<{ external_enabled: boolean }>("SELECT external_enabled FROM notification_preferences WHERE user_id = $1::uuid", [candidate.owner_id]);
    const wantsExternal = preference.rows[0]?.external_enabled === true;
    const clock = await client.query<{ day: string }>("SELECT (clock_timestamp() AT TIME ZONE 'UTC')::date::text AS day");
    const day = clock.rows[0].day;
    // Même verrou et mêmes plafonds que N1 : un verrou par (utilisateur, jour UTC) sérialise les plafonds par besoin et par utilisateur.
    await client.query("SELECT pg_advisory_xact_lock($1, hashtext($2))", [NOTIFICATION_CAP_LOCK_NAMESPACE, `${candidate.owner_id}:${day}`]);
    const seenNow = new Set(seen);
    for (const id of covered) seenNow.add(id);
    for (const item of batch) {
      const ids = [item.entry.row.id, ...item.absorbedIds];
      // Une annonce couverte par l'une des précédentes de ce lot (doublon vérifié, regroupement en retard) n'est pas notifiée.
      if (ids.some((id) => seenNow.has(id)) || evaluation.candidates.some((other) => seenNow.has(other.row.id) && isDuplicatePair(item.entry.candidate, other.candidate))) {
        const extra = ids.filter((id) => !seenNow.has(id));
        if (extra.length > 0) {
          await client.query(
            "INSERT INTO active_search_seen (demand_id, listing_id, reason) SELECT $1::uuid, unnest($2::uuid[]), 'duplicate' ON CONFLICT (demand_id, listing_id) DO NOTHING",
            [demand.id, extra],
          );
          for (const id of extra) seenNow.add(id);
        }
        continue;
      }
      // Barrière contre le double envoi : la marque « vue » du représentant ; une annonce déjà marquée par un autre traitement n'est pas notifiée.
      const marked = await client.query<{ listing_id: string }>(
        "INSERT INTO active_search_seen (demand_id, listing_id, reason) SELECT $1::uuid, unnest($2::uuid[]), 'notified' ON CONFLICT (demand_id, listing_id) DO NOTHING RETURNING listing_id",
        [demand.id, ids],
      );
      for (const id of ids) seenNow.add(id);
      if (!marked.rows.some((row) => row.listing_id === item.entry.row.id)) continue;

      const counted = await client.query<{ demand_count: number; user_count: number }>(
        `SELECT count(*) FILTER (WHERE demand_id = $1::uuid)::int AS demand_count, count(*)::int AS user_count FROM notifications
          WHERE user_id = $3::uuid AND kind IN ('new_match', 'new_external_match')
            AND created_at >= ($2::date)::timestamp AT TIME ZONE 'UTC'
            AND created_at < (($2::date) + 1)::timestamp AT TIME ZONE 'UTC'`,
        [demand.id, day, candidate.owner_id],
      );
      const capped = counted.rows[0].demand_count >= NEW_MATCH_DAILY_CAP_PER_DEMAND || counted.rows[0].user_count >= NEW_MATCH_DAILY_CAP_PER_USER;
      const title = buildExternalNotificationTitle(item.entry.row.title);
      const price = item.entry.row.price_amount === null ? null : buildNotificationPrice(Number(item.entry.row.price_amount), item.entry.row.price_currency);
      let notificationId: string;
      if (capped) {
        const digest = await client.query<{ id: string }>(
          `INSERT INTO notifications (user_id, kind, demand_id, digest_day, item_count)
           VALUES ($1::uuid, 'new_matches_digest', $2::uuid, $3::date, 1)
           ON CONFLICT (demand_id, digest_day) WHERE kind = 'new_matches_digest'
           DO UPDATE SET item_count = notifications.item_count + 1, read_at = NULL, created_at = clock_timestamp()
           RETURNING id`,
          [candidate.owner_id, demand.id, day],
        );
        notificationId = digest.rows[0].id;
        outcome.digested += 1;
      } else {
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO notifications (user_id, kind, demand_id, external_listing_id, title, price_amount, price_currency, source_name)
           VALUES ($1::uuid, 'new_external_match', $2::uuid, $3::uuid, $4, $5, $6, $7)
           ON CONFLICT (user_id, kind, demand_id, external_listing_id) WHERE kind = 'new_external_match' DO NOTHING
           RETURNING id`,
          [candidate.owner_id, demand.id, item.entry.row.id, title, price?.amount ?? null, price?.currency ?? null, buildExternalSourceName(item.entry.row.source_name)],
        );
        if (!inserted.rows[0]) continue;
        notificationId = inserted.rows[0].id;
        outcome.notified += 1;
      }
      if (wantsExternal) {
        const content = buildExternalDeliveryContent({ title, price, demandId: demand.id });
        const delivery = await client.query(
          `INSERT INTO notification_deliveries (user_id, notification_id, demand_id, external_listing_id, channel, created_at, next_attempt_at, idempotency_key, content)
           SELECT $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, t.now, t.now + ($8::bigint * interval '1 millisecond'), $6, $7::jsonb
             FROM (SELECT clock_timestamp() AS now) t
           ON CONFLICT (idempotency_key) DO NOTHING`,
          [
            candidate.owner_id, notificationId, demand.id, item.entry.row.id, SIMULATED_CHANNEL,
            `${SIMULATED_CHANNEL}:new_external_match:${demand.id}:${item.entry.row.id}`, JSON.stringify(content), EXTERNAL_COLLECTION_WINDOW_MS,
          ],
        );
        outcome.deliveries += delivery.rowCount ?? 0;
      }
    }
  }
  // Balayage complet : le filigrane avance à la collecte lue avant les annonces ; le besoin n'est réexaminé qu'après une collecte plus récente. Sinon (plus d'annonces nouvelles que
  // le lot), le filigrane reste en arrière et le reste est repris au passage suivant.
  if (complete) {
    await client.query("UPDATE active_search_state SET scanned_at = $2::timestamptz, scan_horizon_at = $3::timestamptz, updated_at = $3::timestamptz WHERE demand_id = $1::uuid", [demand.id, watermark, now]);
  }
  return outcome;
}
