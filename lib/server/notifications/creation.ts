import "server-only";

import type { PoolClient } from "pg";
import type { SqlExecutor } from "../postgres/client";
import {
  MATCHING_CURRENT_CLOCK_CTE,
  MATCHING_FRESHNESS_FROM,
  buildMatchingFreshnessPredicate,
  resolveMatchingFreshnessParams,
} from "../matching/persistence";
import {
  EXTERNAL_COLLECTION_WINDOW_MS,
  NEW_MATCH_DAILY_CAP_PER_DEMAND,
  NEW_MATCH_DAILY_CAP_PER_USER,
  NOTIFICATION_CAP_LOCK_NAMESPACE,
  SIMULATED_CHANNEL,
} from "./config";
import { buildDeliveryContent, buildNotificationPrice, buildNotificationTitle } from "./content";

/**
 * Naissance d'une notification `new_match` (lot N1), DANS LA TRANSACTION qui écrit l'évaluation (voir `persistEvaluatedMatch`, option `inTransaction`).
 * Une panne, une relance ou un rejeu d'un job ne crée donc jamais de doublon (clé unique + ON CONFLICT DO NOTHING) et ne perd rien de ce qui a été validé
 * (la notification est validée avec l'évaluation, ou annulée avec elle). Aucune notification, avec un motif, si :
 *  - l'évaluation n'est pas une correspondance confirmée ET FRAÎCHE (même prédicat que la lecture des correspondances) ;
 *  - le vendeur est l'acheteur lui-même ;
 *  - le besoin n'est pas actif, son suivi est en pause ou expiré ;
 *  - le recalcul vient du bootstrap du catalogue existant (aucune rafale) ;
 *  - l'évaluation sort d'un job côté BESOIN (création, activation, modification d'un besoin, tout job `evaluate_demand_candidates`) : l'acheteur a déjà les
 *    résultats sous les yeux ; seules les annonces NOUVELLES pour le besoin notifient ;
 *  - l'annonce (sa publication, ou sa dernière version publiée) n'est pas postérieure à l'activation du besoin (ou à sa dernière modification) ;
 *    exception : le balayage de réactivation d'un VENDEUR (`user.reactivated`) garde la règle de N1 ;
 *  - le couple a DÉJÀ été une correspondance confirmée (réévaluation, recalcul en masse, changement de scoring) ou a déjà sa notification.
 * Au-delà de 20 notifications par besoin ou de 50 par utilisateur et par jour UTC : un seul résumé par besoin et par jour (item_count qui augmente remet read_at à NULL).
 * Lot RA1 : les notifications d'annonces d'AUTRES SITES (`new_external_match`, recherche active payante) comptent dans les MÊMES plafonds que les annonces internes.
 * Toute annonce, résumée ou non, a sa ligne d'envoi externe pour un utilisateur qui l'a demandé : le message regroupé en compte tout. Voir NOTIFICATIONS.md.
 */

/** Événements de l'outbox dont les jobs ne notifient jamais : le bootstrap du catalogue existant (les couples existaient avant le service). */
export const SILENT_SOURCE_EVENT_TYPES: readonly string[] = Object.freeze(["catalog.bootstrap_sync"]);

/** Événements d'un BESOIN (création, activation, modification) : une évaluation qui en sort ne notifie jamais (l'acheteur a les résultats sous les yeux). */
export const DEMAND_SIDE_EVENT_TYPES: readonly string[] = Object.freeze(["demand.created", "demand.activated", "demand.updated"]);
/** Job d'évaluation côté besoin : jamais de notification, quel que soit l'événement d'origine. */
export const DEMAND_SIDE_JOB_TYPE = "evaluate_demand_candidates";
/** Événements d'une ANNONCE : sa publication (ou sa remise en vente) et sa dernière version publiée. */
export const OFFER_PUBLICATION_EVENT_TYPES: readonly string[] = Object.freeze(["offer.created", "offer.published", "offer.available", "offer.updated"]);
/** Le balayage de réactivation d'un vendeur garde la règle de N1 (ses annonces redeviennent visibles : elles sont nouvelles pour les acheteurs). */
export const SELLER_REACTIVATION_EVENT_TYPE = "user.reactivated";
export const OFFER_SIDE_JOB_TYPE = "evaluate_offer_candidates";

export type NewMatchOutcome =
  | { kind: "not_confirmed" }
  | { kind: "own_offer" }
  | { kind: "schema_absent" }
  | { kind: "silent_source" }
  | { kind: "demand_side" }
  | { kind: "not_new_for_demand" }
  | { kind: "not_fresh" }
  | { kind: "demand_inactive" }
  | { kind: "tracking_paused" }
  | { kind: "tracking_expired" }
  | { kind: "already_notified" }
  | { kind: "already_matched" }
  | { kind: "created"; notificationId: string; deliveryCreated: boolean }
  | { kind: "digested"; itemCount: number; notificationId: string; deliveryCreated: boolean };

export interface NewMatchInput {
  evaluationId: string;
  offerId: string;
  demandId: string;
  offerOwnerId: string;
  demandOwnerId: string;
  isConfirmedMatch: boolean;
  /** Événement de l'outbox à l'origine du job (null : appel direct, jamais silencieux). */
  sourceEventId?: string | null;
  /**
   * Type du job qui produit l'évaluation (le worker le passe toujours). `evaluate_demand_candidates` : jamais de notification. Un job côté annonce (ou de paire) ne
   * notifie que si l'annonce est postérieure à l'activation du besoin. ABSENT (appel direct, réservé aux tests et aux outils) : aucune de ces deux règles.
   */
  jobType?: string | null;
}

export class NotificationTransactionError extends Error {
  constructor() {
    super("Un client PostgreSQL dans une transaction active est requis.");
    this.name = "NotificationTransactionError";
  }
}

/** Même exigence que l'outbox : jamais un pool ni une connexion hors transaction (la notification doit partager la transaction de l'évaluation). */
export function requireTransactionClient(executor: SqlExecutor): PoolClient {
  const client = executor as PoolClient & { _txStatus?: string; getTransactionStatus?: () => string };
  const status = typeof client.getTransactionStatus === "function" ? client.getTransactionStatus() : client._txStatus;
  if (typeof client.release !== "function" || status !== "T") throw new NotificationTransactionError();
  return client;
}

/** Note, dans la transaction de l'évaluation, qu'elle n'a pas pu notifier faute d'annonce nouvelle (elle ne compte pas comme « déjà une correspondance »). */
async function markSilentEvaluation(client: PoolClient, evaluationId: string, reason: "demand_side" | "not_new_for_demand"): Promise<void> {
  await client.query(
    "INSERT INTO notification_silent_evaluations (evaluation_id, reason) VALUES ($1::uuid, $2) ON CONFLICT (evaluation_id) DO NOTHING",
    [evaluationId, reason],
  );
}

export async function recordNewMatchNotification(executor: SqlExecutor, input: NewMatchInput): Promise<NewMatchOutcome> {
  const client = requireTransactionClient(executor);
  if (!input.isConfirmedMatch) return { kind: "not_confirmed" };
  if (input.offerOwnerId === input.demandOwnerId) return { kind: "own_offer" };

  // Une base pas encore migrée (0019) n'est jamais une erreur : l'évaluation s'écrit sans notification. Toute AUTRE erreur annule l'évaluation.
  const schema = await client.query<{ present: boolean }>(
    `SELECT (to_regclass('notifications') IS NOT NULL AND to_regclass('notification_deliveries') IS NOT NULL
             AND to_regclass('notification_preferences') IS NOT NULL AND to_regclass('notification_silent_evaluations') IS NOT NULL) AS present`,
  );
  if (schema.rows[0]?.present !== true) return { kind: "schema_absent" };

  let sourceEventType: string | null = null;
  if (input.sourceEventId) {
    const source = await client.query<{ event_type: string }>("SELECT event_type FROM matching_outbox_events WHERE id = $1::uuid", [input.sourceEventId]);
    sourceEventType = source.rows[0]?.event_type ?? null;
    if (sourceEventType !== null && SILENT_SOURCE_EVENT_TYPES.includes(sourceEventType)) return { kind: "silent_source" };
  }
  // Un job côté BESOIN ne notifie jamais : créer, activer ou modifier un besoin (budget relevé…) ne doit pas rejouer, en notifications, des résultats que l'acheteur voit déjà.
  if (input.jobType === DEMAND_SIDE_JOB_TYPE || (sourceEventType !== null && DEMAND_SIDE_EVENT_TYPES.includes(sourceEventType))) {
    await markSilentEvaluation(client, input.evaluationId, "demand_side");
    return { kind: "demand_side" };
  }

  // « Fraîche » : EXACTEMENT le prédicat de la lecture (versions courantes, propriétaires actifs, statuts éligibles, moteur et configuration courants).
  const freshness = buildMatchingFreshnessPredicate(resolveMatchingFreshnessParams(), 2);
  const fresh = await client.query(
    `WITH ${MATCHING_CURRENT_CLOCK_CTE}
     SELECT 1 FROM ${MATCHING_FRESHNESS_FROM}
      WHERE e.id = $1::uuid AND ${freshness.conditions.join(" AND ")}`,
    [input.evaluationId, ...freshness.values],
  );
  if (!fresh.rowCount) return { kind: "not_fresh" };

  const demand = await client.query<{ status: string; archived: boolean; paused: boolean; live: boolean; owner_id: string }>(
    `SELECT status, archived_at IS NOT NULL AS archived, notify_paused AS paused, notify_until > clock_timestamp() AS live, owner_id
       FROM demands WHERE id = $1::uuid`,
    [input.demandId],
  );
  const row = demand.rows[0];
  if (!row || row.status !== "active" || row.archived || row.owner_id !== input.demandOwnerId) return { kind: "demand_inactive" };
  if (row.paused) return { kind: "tracking_paused" };
  if (!row.live) return { kind: "tracking_expired" };

  // Seules les annonces NOUVELLES pour le besoin notifient : l'annonce (sa publication, ou sa dernière version publiée) doit être postérieure à l'activation du besoin
  // (ou à sa dernière modification). Sans événement de publication connu (annonce d'avant le service), elle n'est pas nouvelle. Le balayage de réactivation d'un vendeur
  // garde la règle de N1. Appel direct (sans type de job) : règle non appliquée.
  if (input.jobType !== undefined && input.jobType !== null) {
    const sellerReactivation = sourceEventType === SELLER_REACTIVATION_EVENT_TYPE && input.jobType === OFFER_SIDE_JOB_TYPE;
    if (!sellerReactivation) {
      const times = await client.query<{ offer_at: Date | null; demand_at: Date | null }>(
        `SELECT (SELECT max(occurred_at) FROM matching_outbox_events
                  WHERE aggregate_type = 'offer' AND aggregate_id = $1::uuid AND event_type = ANY($3::text[])) AS offer_at,
                (SELECT max(occurred_at) FROM matching_outbox_events
                  WHERE aggregate_type = 'demand' AND aggregate_id = $2::uuid AND event_type = ANY($4::text[])) AS demand_at`,
        [input.offerId, input.demandId, [...OFFER_PUBLICATION_EVENT_TYPES], [...DEMAND_SIDE_EVENT_TYPES]],
      );
      const offerAt = times.rows[0]?.offer_at ?? null;
      const demandAt = times.rows[0]?.demand_at ?? null;
      if (offerAt === null || (demandAt !== null && offerAt.getTime() <= demandAt.getTime())) {
        await markSilentEvaluation(client, input.evaluationId, "not_new_for_demand");
        return { kind: "not_new_for_demand" };
      }
    }
  }

  const existing = await client.query(
    "SELECT 1 FROM notifications WHERE user_id = $1::uuid AND kind = 'new_match' AND demand_id = $2::uuid AND offer_id = $3::uuid",
    [input.demandOwnerId, input.demandId, input.offerId],
  );
  if (existing.rowCount) return { kind: "already_notified" };
  // « Déjà une correspondance » : une autre évaluation confirmée du couple, SAUF celles écrites sans pouvoir notifier (job du besoin, annonce non nouvelle : l'acheteur n'a
  // jamais été prévenu). Sans cette exception, un job du besoin passé avant celui de l'annonce la priverait de sa notification.
  const history = await client.query(
    `SELECT 1 FROM matching_evaluations e
      WHERE e.offer_id = $1::uuid AND e.demand_id = $2::uuid AND e.is_confirmed_match = TRUE AND e.id <> $3::uuid
        AND NOT EXISTS (SELECT 1 FROM notification_silent_evaluations silent WHERE silent.evaluation_id = e.id)
      LIMIT 1`,
    [input.offerId, input.demandId, input.evaluationId],
  );
  if (history.rowCount) return { kind: "already_matched" };

  // Plafonds exacts sous concurrence : un verrou par (utilisateur, jour UTC), tenu jusqu'à la fin de la transaction de l'évaluation. Tous les besoins appartiennent
  // à l'utilisateur : ce seul verrou sérialise aussi le plafond par besoin.
  const clock = await client.query<{ day: string }>("SELECT (clock_timestamp() AT TIME ZONE 'UTC')::date::text AS day");
  const day = clock.rows[0].day;
  await client.query("SELECT pg_advisory_xact_lock($1, hashtext($2))", [NOTIFICATION_CAP_LOCK_NAMESPACE, `${input.demandOwnerId}:${day}`]);
  const counted = await client.query<{ demand_count: number; user_count: number }>(
    `SELECT count(*) FILTER (WHERE demand_id = $1::uuid)::int AS demand_count, count(*)::int AS user_count FROM notifications
      WHERE user_id = $3::uuid AND kind IN ('new_match', 'new_external_match')
        AND created_at >= ($2::date)::timestamp AT TIME ZONE 'UTC'
        AND created_at < (($2::date) + 1)::timestamp AT TIME ZONE 'UTC'`,
    [input.demandId, day, input.demandOwnerId],
  );
  const capped = counted.rows[0].demand_count >= NEW_MATCH_DAILY_CAP_PER_DEMAND || counted.rows[0].user_count >= NEW_MATCH_DAILY_CAP_PER_USER;

  const offer = await client.query<{ brand: string | null; model: string | null; variant: string | null; price_amount: string | null; price_currency: string | null }>(
    "SELECT brand, model, variant, price_amount::text AS price_amount, price_currency FROM offers WHERE id = $1::uuid",
    [input.offerId],
  );
  const source = offer.rows[0];
  const title = buildNotificationTitle({ brand: source?.brand ?? null, model: source?.model ?? null, variant: source?.variant ?? null });
  const price = source?.price_amount != null ? buildNotificationPrice(Number(source.price_amount), source.price_currency) : null;

  let notificationId: string;
  let digestCount: number | null = null;
  if (capped) {
    // Au-delà du plafond : un seul résumé par besoin et par jour ; si le compte augmente, le résumé redevient NON LU et remonte en tête de liste (sa date est celle de la
    // dernière annonce ajoutée : une annonce de plus ne passe jamais inaperçue, ni sous un « tout marquer comme lu » qui ne l'a pas vue).
    const digest = await client.query<{ id: string; item_count: number }>(
      `INSERT INTO notifications (user_id, kind, demand_id, digest_day, item_count)
       VALUES ($1::uuid, 'new_matches_digest', $2::uuid, $3::date, 1)
       ON CONFLICT (demand_id, digest_day) WHERE kind = 'new_matches_digest'
       DO UPDATE SET item_count = notifications.item_count + 1, read_at = NULL, created_at = clock_timestamp()
       RETURNING id, item_count`,
      [input.demandOwnerId, input.demandId, day],
    );
    notificationId = digest.rows[0].id;
    digestCount = digest.rows[0].item_count;
  } else {
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO notifications (user_id, kind, demand_id, offer_id, title, price_amount, price_currency)
       VALUES ($1::uuid, 'new_match', $2::uuid, $3::uuid, $4, $5, $6)
       ON CONFLICT (user_id, kind, demand_id, offer_id) WHERE kind = 'new_match' DO NOTHING
       RETURNING id`,
      [input.demandOwnerId, input.demandId, input.offerId, title, price?.amount ?? null, price?.currency ?? null],
    );
    if (!inserted.rows[0]) return { kind: "already_notified" };
    notificationId = inserted.rows[0].id;
  }

  // Envoi externe simulé : une ligne d'outbox PAR ANNONCE (même celles d'un résumé, pour que le message regroupé en compte tout) et seulement pour un utilisateur qui l'a
  // demandé (désactivé par défaut). Envoyable après la fenêtre de collecte (15 min : regrouper les rafales) ; tout est revérifié à l'envoi.
  const preference = await client.query<{ external_enabled: boolean }>(
    "SELECT external_enabled FROM notification_preferences WHERE user_id = $1::uuid",
    [input.demandOwnerId],
  );
  let deliveryCreated = false;
  if (preference.rows[0]?.external_enabled === true) {
    const content = buildDeliveryContent({ title, price, demandId: input.demandId, offerId: input.offerId });
    const delivery = await client.query(
      `INSERT INTO notification_deliveries (user_id, notification_id, demand_id, offer_id, channel, created_at, next_attempt_at, idempotency_key, content)
       SELECT $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, t.now, t.now + ($8::bigint * interval '1 millisecond'), $6, $7::jsonb
         FROM (SELECT clock_timestamp() AS now) t
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [
        input.demandOwnerId, notificationId, input.demandId, input.offerId, SIMULATED_CHANNEL,
        `${SIMULATED_CHANNEL}:new_match:${input.demandId}:${input.offerId}`, JSON.stringify(content), EXTERNAL_COLLECTION_WINDOW_MS,
      ],
    );
    deliveryCreated = (delivery.rowCount ?? 0) === 1;
  }
  if (digestCount !== null) return { kind: "digested", itemCount: digestCount, notificationId, deliveryCreated };
  return { kind: "created", notificationId, deliveryCreated };
}
