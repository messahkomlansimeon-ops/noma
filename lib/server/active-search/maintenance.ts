import "server-only";

import type { SqlExecutor } from "../postgres/client";
import { TRACKING_MAX_DAYS } from "../notifications/config";
import { ACTIVE_SEARCH_NOTICE_DAYS } from "./config";
import { activeSearchSchemaPresent } from "./state";

/**
 * Entretien de la recherche active (lots RA1 et RA1-bis), appelé par l'étape « activeSearch » du worker, APRÈS la collecte (isolé : une panne ici n'arrête aucune autre étape). Idempotent, en
 * instructions uniques sans attente de verrou (`SKIP LOCKED`) :
 *  1. `ended` : une période dont la fin est passée prend fin ;
 *  2. `stopped` : une période en vigueur d'un besoin ARCHIVÉ est arrêtée (raison écrite), SANS remboursement (c'est dit avant l'achat). Un besoin « satisfait » n'arrête RIEN : il SUSPEND
 *     l'option (aucune notification, aucune accélération ; la période continue de courir et la réactivation du besoin la reprend) : l'état d'une option ne dépend donc jamais du passage du worker ;
 *  3. suivi : un besoin qui n'a plus d'option en vigueur revient au plafond de 90 jours (le suivi prolongé au-delà ne dure que pendant l'option) ;
 *  4. avis : 3 jours avant la fin de la CHAÎNE (la dernière période, aucune extension payée derrière), une notification dans l'application, une seule par période ; l'écran lit la fin
 *     de la chaîne au moment de la lecture (`active_search_chain_end`).
 * Aucun renouvellement automatique : à l'échéance l'option s'arrête, c'est tout.
 */

export interface ActiveSearchMaintenanceResult {
  /** Migration 0028 absente : entretien ignoré sans erreur. */
  skipped: boolean;
  ended: number;
  stopped: number;
  trackingClamped: number;
  notices: number;
}

export async function runActiveSearchMaintenance(executor: SqlExecutor, now: Date): Promise<ActiveSearchMaintenanceResult> {
  const result: ActiveSearchMaintenanceResult = { skipped: false, ended: 0, stopped: 0, trackingClamped: 0, notices: 0 };
  if (!(await activeSearchSchemaPresent(executor))) return { ...result, skipped: true };

  // Aucune instruction n'attend un verrou tenu par un autre processus (`SKIP LOCKED`) : une ligne verrouillée par un achat ou un remboursement est traitée au passage suivant.
  const ended = await executor.query(
    `UPDATE active_search_purchases SET status = 'ended'
      WHERE id IN (SELECT id FROM active_search_purchases WHERE status = 'active' AND ends_at <= $1::timestamptz ORDER BY id FOR UPDATE SKIP LOCKED)`,
    [now],
  );
  result.ended = ended.rowCount ?? 0;

  const stopped = await executor.query(
    `UPDATE active_search_purchases p
        SET status = 'stopped', stopped_at = $1::timestamptz, stop_reason = 'demand_archived'
       FROM demands d
      WHERE d.id = p.demand_id AND p.id IN (
              SELECT q.id FROM active_search_purchases q JOIN demands e ON e.id = q.demand_id
               WHERE q.status = 'active' AND (e.status = 'archived' OR e.archived_at IS NOT NULL)
               ORDER BY q.id FOR UPDATE OF q SKIP LOCKED)`,
    [now],
  );
  result.stopped = stopped.rowCount ?? 0;

  const clamped = await executor.query(
    `UPDATE demands d
        SET notify_until = LEAST(d.notify_until, GREATEST(d.created_at, $1::timestamptz + make_interval(days => $2::int)))
      WHERE d.id IN (
              SELECT e.id FROM demands e
               WHERE e.id IN (SELECT demand_id FROM active_search_purchases) AND e.status = 'active' AND e.notify_until > $1::timestamptz + make_interval(days => $2::int)
                 AND NOT EXISTS (
                   SELECT 1 FROM active_search_purchases p
                    WHERE p.demand_id = e.id AND p.status = 'active' AND p.refunded_at IS NULL AND p.starts_at <= $1::timestamptz AND p.ends_at > $1::timestamptz)
               ORDER BY e.id FOR UPDATE OF e SKIP LOCKED)`,
    [now, TRACKING_MAX_DAYS],
  );
  result.trackingClamped = clamped.rowCount ?? 0;

  const notices = await executor.query(
    `WITH due AS (
       SELECT p.id FROM active_search_purchases p JOIN demands d ON d.id = p.demand_id
        WHERE p.status = 'active' AND p.refunded_at IS NULL AND p.notice_sent_at IS NULL AND p.starts_at <= $1::timestamptz
          AND p.ends_at > $1::timestamptz AND p.ends_at <= $1::timestamptz + make_interval(days => $2::int)
          AND d.status = 'active' AND d.archived_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM active_search_purchases q WHERE q.demand_id = p.demand_id AND q.status = 'active' AND q.refunded_at IS NULL AND q.starts_at >= p.ends_at)
        ORDER BY p.id
          FOR UPDATE OF p SKIP LOCKED
     ), marked AS (
       UPDATE active_search_purchases p SET notice_sent_at = $1::timestamptz FROM due WHERE p.id = due.id RETURNING p.id, p.user_id, p.demand_id
     )
     INSERT INTO notifications (user_id, kind, demand_id, active_search_id)
     SELECT user_id, 'active_search_expiring', demand_id, id FROM marked
     ON CONFLICT DO NOTHING`,
    [now, ACTIVE_SEARCH_NOTICE_DAYS],
  );
  result.notices = notices.rowCount ?? 0;
  return result;
}
