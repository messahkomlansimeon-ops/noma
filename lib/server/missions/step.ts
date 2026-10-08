import "server-only";

import type { Pool } from "pg";
import { withReadSnapshot } from "../matching/service";
import { buildNotificationTitle } from "../notifications/content";
import { withPostgresTransaction } from "../postgres/client";
import {
  MISSIONS_MIGRATION,
  MISSIONS_STEP_EVALUATION_BATCH,
  MISSIONS_STEP_EXPIRY_BATCH,
  MISSIONS_STEP_NOTIFY_BATCH,
  MISSIONS_STEP_RELEASE_BATCH,
  MISSION_CARRIER_RELEASE_DELAY,
  MISSION_TRANSACTION_TIMEOUT,
} from "./config";
import { MISSION_COLUMNS, archiveCarrierDemand, closeOpenMission, mapMission, type MissionRow } from "./missions";
import { computeMissionAllocation } from "./proposal";

/**
 * Étape « missions » du runner (lot MV1), isolée comme les étapes boost et notify :
 *  1. ÉCHÉANCE : les missions ouvertes (actives ou en pause) dont l'échéance est passée passent à « échue » et leur besoin porteur est mis en attente d'archivage. Si toute la
 *     quantité est SÉCURISÉE (commandes confirmées) à l'échéance, la mission passe à « terminée », pas à « échue ». Idempotent (une mission déjà close n'est jamais touchée),
 *     une ligne tenue par une autre transaction est laissée (`SKIP LOCKED`) ;
 *  2. RÉÉVALUATION : une mission ACTIVE (échéance non passée) dont le besoin porteur a une évaluation CONFIRMÉE ET FRAÎCHE plus récente que sa dernière lecture, ou dont une commande a
 *     changé depuis (ou, à défaut, lue il y a plus de 10 minutes) voit sa couverture relue (la même répartition que la proposition : l'engagé plus le proposé). Tant que le matching du
 *     besoin porteur n'est pas terminé (événement ou job en cours, ou évaluation récemment périmée en attente d'être recalculée), rien n'est lu : la couverture ne chute pas
 *     pendant un recalcul. La première lecture après l'activation pose la base de comparaison SANS notification (comme N1 : créer un besoin ne notifie pas ce que l'acheteur voit déjà) ;
 *  3. NOTIFICATION : si la couverture lue dépasse le PLUS HAUT niveau dont l'acheteur a été prévenu (ou qu'il voyait à la première lecture), UNE notification « mission_coverage »
 *     (dans l'application, aucun envoi externe), au plus une par jour UTC et par mission (index unique) ; une hausse retenue ce jour-là part le lendemain. Une baisse puis une remontée
 *     ne notifie jamais ce qui a déjà été annoncé ;
 *  4. LIBÉRATION DES BESOINS PORTEURS : le besoin porteur d'une mission close est archivé 24 h APRÈS sa fin, jamais à l'instant de la fin : un vendeur dont la confirmation termine la
 *     mission ne le devine pas en voyant le besoin disparaître.
 * Sans la migration 0027 : étape ignorée sans erreur (`skipped`). Aucun message, aucune commande n'est jamais créé par cette étape.
 */

export interface MissionsStepResult {
  /** La migration 0027 n'est pas enregistrée : étape ignorée. */
  skipped: boolean;
  /** Missions dont l'échéance a été traitée (passées à « échue », ou à « terminée » quand toute la quantité était sécurisée). */
  expired: number;
  /** Missions dont la couverture a été relue. */
  evaluated: number;
  /** Relectures qui ont CHANGÉ la couverture (ou posé la première) : du travail pour la boucle du worker. */
  changed: number;
  notified: number;
  /** Besoins porteurs de missions closes depuis plus de 24 h archivés. */
  released: number;
  /** Codes stables (`mission_expire_<code>`, `mission_evaluate_<code>`, `mission_notify_<code>`, `mission_release_<code>`). */
  errors: string[];
}

export interface RunMissionsStepOptions {
  pool: Pool;
  expiryBatch?: number;
  evaluationBatch?: number;
  notifyBatch?: number;
  releaseBatch?: number;
}

/** Une relecture de plus de 10 minutes est refaite même sans nouvelle évaluation (offres retirées, prix ou disponibilité changés sans nouvelle évaluation). */
const REFRESH_INTERVAL = "10 minutes";
/** Marge sur la date de la dernière relecture : une évaluation validée un peu après le début de la lecture n'est jamais ratée. */
const EVALUATION_MARGIN = "5 seconds";
/** Motifs de péremption d'une évaluation qui sera RECALCULÉE (l'annonce ou le besoin a changé, ou l'évaluation a expiré) : tant qu'elle n'a pas de remplaçante, la couverture n'est pas relue. */
const AWAITING_RECALCULATION = "'offer_updated', 'demand_updated', 'offer_unavailable', 'engine_superseded', 'temporal_expiry'";

function errorCodeOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[A-Za-z0-9_]{1,40}$/.test(code) ? code.toLowerCase() : "unknown";
}

/** La migration 0027 est-elle enregistrée ? Sans elle (ou sans table de migrations) l'étape est ignorée, jamais en erreur. */
export async function isMissionsMigrationRegistered(pool: Pool): Promise<boolean> {
  const table = await pool.query<{ present: boolean }>("SELECT to_regclass('noma_schema_migrations') IS NOT NULL AS present");
  if (table.rows[0]?.present !== true) return false;
  const result = await pool.query("SELECT 1 FROM noma_schema_migrations WHERE version = $1", [MISSIONS_MIGRATION]);
  return result.rowCount === 1;
}

async function expireDueMissions(pool: Pool, batch: number, result: MissionsStepResult): Promise<void> {
  const due = await pool.query<{ id: string }>(
    "SELECT id FROM missions WHERE status IN ('active', 'paused') AND deadline_at <= clock_timestamp() ORDER BY deadline_at, id LIMIT $1::int",
    [batch],
  );
  for (const { id } of due.rows) {
    try {
      const closed = await withPostgresTransaction(async (client) => {
        await client.query(`SET LOCAL statement_timeout = '${MISSION_TRANSACTION_TIMEOUT}'`);
        const locked = await client.query<MissionRow>(
          `SELECT ${MISSION_COLUMNS} FROM missions WHERE id = $1::uuid AND status IN ('active', 'paused') AND deadline_at <= clock_timestamp() FOR UPDATE SKIP LOCKED`,
          [id],
        );
        if (!locked.rows[0]) return false;
        const mission = mapMission(locked.rows[0]);
        // Toute la quantité est sécurisée (commandes confirmées) à l'échéance : la mission est TERMINÉE, pas échue.
        const secured = await client.query<{ quantity: number }>("SELECT coalesce(sum(quantity), 0)::int AS quantity FROM orders WHERE mission_id = $1::uuid AND status = 'confirmed'", [id]);
        return closeOpenMission(client, mission, secured.rows[0].quantity >= mission.quantity ? "completed" : "expired");
      }, pool);
      if (closed) result.expired += 1;
    } catch (error) {
      result.errors.push(`mission_expire_${errorCodeOf(error)}`);
    }
  }
}

/**
 * Les missions à relire : actives, échéance non passée, matching du besoin porteur terminé (ni événement ni job en cours, aucune évaluation récemment périmée en attente de
 * recalcul), et jamais lues, lues il y a plus de 10 minutes, ou avec une évaluation ou une commande plus récente que la dernière lecture. Chaque sous-requête sur
 * `matching_evaluations` suit un index PARTIEL existant ou ajouté par la migration 0027 (`idx_matching_eval_demand_confirmed`, `idx_matching_eval_demand_awaiting`,
 * `uq_matching_evaluations_latest`) : le coût ne dépend pas de la taille de l'historique des évaluations périmées (essai de plan).
 */
export const MISSIONS_WATCH_SQL = `SELECT m.id FROM missions m
      WHERE m.status = 'active' AND m.demand_id IS NOT NULL AND m.deadline_at > clock_timestamp()
        AND NOT EXISTS (SELECT 1 FROM matching_outbox_events ev
                         WHERE ev.aggregate_type = 'demand' AND ev.aggregate_id = m.demand_id AND ev.dispatch_status = 'pending')
        AND NOT EXISTS (SELECT 1 FROM matching_jobs j
                         WHERE j.job_type = 'evaluate_demand_candidates' AND j.resource_id = m.demand_id AND j.status IN ('pending', 'running', 'failed'))
        AND NOT EXISTS (SELECT 1 FROM matching_evaluations s
                         WHERE s.demand_id = m.demand_id AND s.is_stale = TRUE AND s.is_latest = FALSE AND s.stale_reason IN (${AWAITING_RECALCULATION})
                           AND s.staled_at > clock_timestamp() - interval '${REFRESH_INTERVAL}'
                           AND NOT EXISTS (SELECT 1 FROM matching_evaluations l WHERE l.offer_id = s.offer_id AND l.demand_id = s.demand_id AND l.is_latest = TRUE))
        AND (m.evaluated_at IS NULL
             OR m.evaluated_at < clock_timestamp() - interval '${REFRESH_INTERVAL}'
             OR EXISTS (SELECT 1 FROM matching_evaluations e
                         WHERE e.demand_id = m.demand_id AND e.is_latest = TRUE AND e.is_stale = FALSE AND e.is_confirmed_match = TRUE
                           AND e.evaluated_at > m.evaluated_at - interval '${EVALUATION_MARGIN}')
             OR EXISTS (SELECT 1 FROM orders o WHERE o.mission_id = m.id AND o.updated_at > m.evaluated_at - interval '${EVALUATION_MARGIN}'))
      ORDER BY m.evaluated_at NULLS FIRST, m.id
      LIMIT $1::int`;

async function evaluateMissions(pool: Pool, batch: number, result: MissionsStepResult): Promise<void> {
  const watched = await pool.query<{ id: string }>(MISSIONS_WATCH_SQL, [batch]);
  for (const { id } of watched.rows) {
    try {
      const read = await withReadSnapshot(pool, async (client) => {
        const row = await client.query<MissionRow & { read_at: Date }>(`SELECT ${MISSION_COLUMNS}, clock_timestamp() AS read_at FROM missions WHERE id = $1::uuid AND status = 'active'`, [id]);
        if (!row.rows[0]) return null;
        const mission = mapMission(row.rows[0]);
        const computed = await computeMissionAllocation(client, mission, row.rows[0].read_at);
        return { covered: computed === null ? 0 : computed.coveredQuantity, readAt: row.rows[0].read_at };
      });
      if (read === null) continue;
      const written = await pool.query<{ changed: boolean }>(
        // Base de comparaison : posée sans bruit à la première lecture. Elle ne BAISSE jamais ensuite : c'est le plus haut niveau que l'acheteur a vu ou dont il a été prévenu
        // (une baisse passagère puis une remontée ne notifie pas ce qu'il a déjà vu).
        `WITH previous AS (SELECT covered_quantity FROM missions WHERE id = $1::uuid)
         UPDATE missions SET covered_quantity = $2::int, evaluated_at = $3::timestamptz,
                notified_quantity = COALESCE(missions.notified_quantity, $2::int),
                updated_at = clock_timestamp()
           FROM previous
          WHERE missions.id = $1::uuid AND missions.status = 'active'
        RETURNING (previous.covered_quantity IS DISTINCT FROM $2::int) AS changed`,
        [id, read.covered, read.readAt],
      );
      if (written.rowCount) {
        result.evaluated += 1;
        if (written.rows[0].changed) result.changed += 1;
      }
    } catch (error) {
      result.errors.push(`mission_evaluate_${errorCodeOf(error)}`);
    }
  }
}

async function notifyCoverage(pool: Pool, batch: number, result: MissionsStepResult): Promise<void> {
  const pending = await pool.query<{ id: string }>(
    `SELECT m.id FROM missions m
      WHERE m.status = 'active' AND m.demand_id IS NOT NULL AND m.covered_quantity > m.notified_quantity
        AND NOT EXISTS (SELECT 1 FROM notifications n
                         WHERE n.mission_id = m.id AND n.kind = 'mission_coverage' AND n.digest_day = (clock_timestamp() AT TIME ZONE 'UTC')::date)
      ORDER BY m.evaluated_at, m.id
      LIMIT $1::int`,
    [batch],
  );
  for (const { id } of pending.rows) {
    try {
      const created = await withPostgresTransaction(async (client) => {
        await client.query(`SET LOCAL statement_timeout = '${MISSION_TRANSACTION_TIMEOUT}'`);
        const locked = await client.query<MissionRow>(
          `SELECT ${MISSION_COLUMNS} FROM missions WHERE id = $1::uuid AND status = 'active' AND demand_id IS NOT NULL AND covered_quantity > notified_quantity FOR UPDATE SKIP LOCKED`,
          [id],
        );
        if (!locked.rows[0]) return false;
        const mission = mapMission(locked.rows[0]);
        const covered = mission.coveredQuantity as number;
        const label = buildNotificationTitle({ brand: mission.brand, model: mission.model, variant: mission.variant });
        const title = `${label} : ${covered} sur ${mission.quantity}`.slice(0, 160);
        const inserted = await client.query(
          `INSERT INTO notifications (user_id, kind, demand_id, mission_id, digest_day, item_count, title)
           VALUES ($1::uuid, 'mission_coverage', $2::uuid, $3::uuid, (clock_timestamp() AT TIME ZONE 'UTC')::date, $4::int, $5)
           ON CONFLICT (mission_id, digest_day) WHERE kind = 'mission_coverage' DO NOTHING
           RETURNING id`,
          [mission.ownerId, mission.demandId, mission.id, covered, title],
        );
        if (!inserted.rowCount) return false;
        await client.query("UPDATE missions SET notified_quantity = $2::int, notified_at = clock_timestamp() WHERE id = $1::uuid", [mission.id, covered]);
        return true;
      }, pool);
      if (created) result.notified += 1;
    } catch (error) {
      result.errors.push(`mission_notify_${errorCodeOf(error)}`);
    }
  }
}

/** Archive les besoins porteurs des missions closes depuis plus de 24 h (le matching s'arrête alors) ; la libération est notée sur la mission (une seule fois). */
async function releaseCarriers(pool: Pool, batch: number, result: MissionsStepResult): Promise<void> {
  const due = await pool.query<{ id: string }>(
    `SELECT id FROM missions
      WHERE carrier_released_at IS NULL AND demand_id IS NOT NULL AND status IN ('completed', 'cancelled', 'expired')
        AND closed_at <= clock_timestamp() - interval '${MISSION_CARRIER_RELEASE_DELAY}'
      ORDER BY closed_at, id LIMIT $1::int`,
    [batch],
  );
  for (const { id } of due.rows) {
    try {
      const released = await withPostgresTransaction(async (client) => {
        await client.query(`SET LOCAL statement_timeout = '${MISSION_TRANSACTION_TIMEOUT}'`);
        const locked = await client.query<MissionRow>(
          `SELECT ${MISSION_COLUMNS} FROM missions
            WHERE id = $1::uuid AND carrier_released_at IS NULL AND demand_id IS NOT NULL AND status IN ('completed', 'cancelled', 'expired')
              AND closed_at <= clock_timestamp() - interval '${MISSION_CARRIER_RELEASE_DELAY}' FOR UPDATE SKIP LOCKED`,
          [id],
        );
        if (!locked.rows[0]) return false;
        const mission = mapMission(locked.rows[0]);
        await archiveCarrierDemand(client, mission.ownerId, mission.demandId as string);
        await client.query("UPDATE missions SET carrier_released_at = clock_timestamp(), updated_at = clock_timestamp() WHERE id = $1::uuid", [id]);
        return true;
      }, pool);
      if (released) result.released += 1;
    } catch (error) {
      result.errors.push(`mission_release_${errorCodeOf(error)}`);
    }
  }
}

export async function runMissionsStep(options: RunMissionsStepOptions): Promise<MissionsStepResult> {
  const result: MissionsStepResult = { skipped: false, expired: 0, evaluated: 0, changed: 0, notified: 0, released: 0, errors: [] };
  if (!(await isMissionsMigrationRegistered(options.pool))) return { ...result, skipped: true };
  await expireDueMissions(options.pool, options.expiryBatch ?? MISSIONS_STEP_EXPIRY_BATCH, result);
  await evaluateMissions(options.pool, options.evaluationBatch ?? MISSIONS_STEP_EVALUATION_BATCH, result);
  await notifyCoverage(options.pool, options.notifyBatch ?? MISSIONS_STEP_NOTIFY_BATCH, result);
  await releaseCarriers(options.pool, options.releaseBatch ?? MISSIONS_STEP_RELEASE_BATCH, result);
  return result;
}
