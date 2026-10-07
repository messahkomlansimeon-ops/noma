import "server-only";

import type { Pool } from "pg";
import { CatalogNotFoundError, CatalogValidationError } from "../catalog/errors";
import { requireTransactionPool, requireUuid } from "../catalog/validation";
import { TRACKING_EXTEND_DAYS, TRACKING_MAX_DAYS } from "./config";

/**
 * Suivi d'un besoin (« recherche active » interne, lot N1) : `demands.notify_until` (défaut création + 30 jours) et `demands.notify_paused`. Réservé au propriétaire
 * (un besoin d'autrui ou inconnu : la même erreur « introuvable »). Le MATCHING continue pendant une pause ou après l'expiration (les résultats restent visibles) :
 * seules les notifications s'arrêtent. Prolonger ajoute 30 jours (à partir de l'échéance si elle est dans le futur, sinon de maintenant), plafonné à maintenant + 90 jours.
 * Ces colonnes ne sont pas du contenu : changer le suivi n'incrémente jamais `content_version` et n'émet aucun événement de matching. Voir NOTIFICATIONS.md.
 */

export type TrackingAction = "extend" | "pause" | "resume";
export const TRACKING_ACTIONS: readonly TrackingAction[] = Object.freeze(["extend", "pause", "resume"]);

export class TrackingNotActiveError extends Error {
  constructor() {
    super("Le suivi n'est disponible que pour un besoin actif.");
    this.name = "TrackingNotActiveError";
  }
}

export interface DemandTracking {
  demandId: string;
  /** Statut du besoin (le suivi ne se modifie que pour un besoin actif). */
  demandStatus: string;
  until: Date;
  paused: boolean;
  /** Vrai si les notifications partent pour ce besoin : actif, pas en pause, échéance dans le futur. */
  active: boolean;
  /** Échéance maximale d'une prolongation (maintenant + 90 jours). */
  maxUntil: Date;
  readAt: Date;
}

interface TrackingRow {
  status: string;
  archived: boolean;
  notify_until: Date;
  notify_paused: boolean;
}

function toTracking(demandId: string, row: TrackingRow, now: Date): DemandTracking {
  return {
    demandId,
    demandStatus: row.status,
    until: row.notify_until,
    paused: row.notify_paused,
    active: row.status === "active" && !row.archived && !row.notify_paused && row.notify_until.getTime() > now.getTime(),
    maxUntil: new Date(now.getTime() + TRACKING_MAX_DAYS * 86_400_000),
    readAt: now,
  };
}

/** Suivi d'un besoin DU propriétaire ; null si le besoin est inconnu ou à un autre compte. */
export async function readDemandTracking(input: { pool: Pool; ownerId: string; demandId: string; now?: Date }): Promise<DemandTracking | null> {
  const pool = requireTransactionPool(input.pool);
  const demandId = requireUuid(input.demandId, "demandId").toLowerCase();
  const ownerId = requireUuid(input.ownerId, "ownerId").toLowerCase();
  const now = input.now ?? new Date();
  const result = await pool.query<TrackingRow>(
    `SELECT status, archived_at IS NOT NULL AS archived, notify_until, notify_paused
       FROM demands WHERE id = $1::uuid AND owner_id = $2::uuid`,
    [demandId, ownerId],
  );
  return result.rows[0] ? toTracking(demandId, result.rows[0], now) : null;
}

/**
 * Prolonge, met en pause ou reprend le suivi (une transaction, ligne du besoin verrouillée). Inconnu ou d'autrui : CatalogNotFoundError. Besoin non actif :
 * TrackingNotActiveError. Rejouer une action est sans effet (pause d'un suivi en pause, reprise d'un suivi actif, prolongation déjà au plafond).
 */
export async function applyTrackingAction(input: {
  pool: Pool;
  ownerId: string;
  demandId: string;
  action: TrackingAction;
  now?: Date;
}): Promise<DemandTracking> {
  const pool = requireTransactionPool(input.pool);
  const demandId = requireUuid(input.demandId, "demandId").toLowerCase();
  const ownerId = requireUuid(input.ownerId, "ownerId").toLowerCase();
  if (!TRACKING_ACTIONS.includes(input.action)) throw new CatalogValidationError("action de suivi invalide.");
  const now = input.now ?? new Date();

  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    await client.query("SET LOCAL lock_timeout = '3s'");
    await client.query("SET LOCAL statement_timeout = '5s'");
    const locked = await client.query<TrackingRow>(
      `SELECT status, archived_at IS NOT NULL AS archived, notify_until, notify_paused
         FROM demands WHERE id = $1::uuid AND owner_id = $2::uuid FOR UPDATE`,
      [demandId, ownerId],
    );
    if (!locked.rows[0]) throw new CatalogNotFoundError("demande");
    if (locked.rows[0].status !== "active" || locked.rows[0].archived) throw new TrackingNotActiveError();

    let updated: TrackingRow;
    if (input.action === "extend") {
      const result = await client.query<TrackingRow>(
        `UPDATE demands
            SET notify_until = GREATEST(
                  notify_until,
                  LEAST(
                    GREATEST(notify_until, $2::timestamptz) + ($3::int * interval '1 day'),
                    $2::timestamptz + ($4::int * interval '1 day')))
          WHERE id = $1::uuid
          RETURNING status, archived_at IS NOT NULL AS archived, notify_until, notify_paused`,
        [demandId, now, TRACKING_EXTEND_DAYS, TRACKING_MAX_DAYS],
      );
      updated = result.rows[0];
    } else {
      const result = await client.query<TrackingRow>(
        `UPDATE demands SET notify_paused = $2::boolean WHERE id = $1::uuid
          RETURNING status, archived_at IS NOT NULL AS archived, notify_until, notify_paused`,
        [demandId, input.action === "pause"],
      );
      updated = result.rows[0];
    }
    await client.query("COMMIT");
    return toTracking(demandId, updated, now);
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // l'erreur utile reste la première
    }
    throw error;
  } finally {
    client.release();
  }
}
