import "server-only";

import { randomUUID } from "node:crypto";
import type { PoolClient, QueryResultRow } from "pg";
import type { SqlExecutor } from "../postgres/client";
import { requireUuid } from "../catalog/validation";
import type { OfferRecord, DemandRecord, UserRecord } from "../catalog/types";
import { cancelPendingDeliveriesForDemand } from "../notifications/deliveries";
import { computeScoringConfigHash, normalizeScoringConfig } from "./persistence";
import { MATCHING_OFFLINE_CONTRACT_VERSION } from "./types";
import { MATCHING_SCORING_CONTRACT_VERSION } from "./scoring-types";

export type OutboxAggregateType = "offer" | "demand" | "user" | "temporal" | "system";

export type OutboxEventType =
  | "offer.created"
  | "offer.published"
  | "offer.available"
  | "offer.updated"
  | "offer.paused"
  | "offer.unavailable"
  | "offer.archived"
  | "demand.created"
  | "demand.activated"
  | "demand.updated"
  | "demand.satisfied"
  | "demand.archived"
  | "user.reactivated"
  | "user.suspended"
  | "user.archived"
  | "temporal.deadline_passed"
  | "scoring_config.updated"
  | "catalog.bootstrap_sync";

export type OutboxDispatchStatus = "pending" | "projected" | "ignored";

export interface OutboxEventRecord {
  id: string;
  eventType: OutboxEventType;
  aggregateType: OutboxAggregateType;
  aggregateId: string;
  aggregateVersion: number | null;
  targetAggregateId: string | null;
  payload: Record<string, unknown>;
  occurredAt: Date;
  dispatchedAt: Date | null;
  dispatchStatus: OutboxDispatchStatus;
  errorMessage: string | null;
}

export interface RecordOutboxEventInput {
  id?: string;
  eventType: OutboxEventType;
  aggregateType: OutboxAggregateType;
  aggregateId: string;
  aggregateVersion?: number | null;
  targetAggregateId?: string | null;
  payload?: Record<string, unknown>;
}

export class OutboxValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OutboxValidationError";
  }
}

export interface OutboxRow extends QueryResultRow {
  id: string;
  event_type: OutboxEventType;
  aggregate_type: OutboxAggregateType;
  aggregate_id: string;
  aggregate_version: number | null;
  target_aggregate_id: string | null;
  payload: Record<string, unknown>;
  occurred_at: Date;
  dispatched_at: Date | null;
  dispatch_status: OutboxDispatchStatus;
  error_message: string | null;
}

export const OUTBOX_COLUMNS = `
  id, event_type, aggregate_type, aggregate_id, aggregate_version,
  target_aggregate_id, payload, occurred_at, dispatched_at,
  dispatch_status, error_message
`;

export function mapOutboxRow(row: OutboxRow): OutboxEventRecord {
  return {
    id: row.id,
    eventType: row.event_type,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    aggregateVersion: row.aggregate_version,
    targetAggregateId: row.target_aggregate_id,
    payload: row.payload,
    occurredAt: row.occurred_at,
    dispatchedAt: row.dispatched_at,
    dispatchStatus: row.dispatch_status,
    errorMessage: row.error_message,
  };
}

const VALID_AGGREGATE_TYPES = new Set<OutboxAggregateType>([
  "offer",
  "demand",
  "user",
  "temporal",
  "system",
]);

const VALID_EVENT_TYPES = new Set<OutboxEventType>([
  "offer.created",
  "offer.published",
  "offer.available",
  "offer.updated",
  "offer.paused",
  "offer.unavailable",
  "offer.archived",
  "demand.created",
  "demand.activated",
  "demand.updated",
  "demand.satisfied",
  "demand.archived",
  "user.reactivated",
  "user.suspended",
  "user.archived",
  "temporal.deadline_passed",
  "scoring_config.updated",
  "catalog.bootstrap_sync",
]);

function assertJsonValue(value: unknown, ancestors = new Set<object>()): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (typeof value !== "object" || ancestors.has(value)) {
    throw new OutboxValidationError("Le payload doit être un JSON fini, sans cycles ni conversions implicites.");
  }
  const proto = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && proto !== Object.prototype && proto !== null) {
    throw new OutboxValidationError("Le payload doit contenir uniquement des objets JSON simples.");
  }
  ancestors.add(value);
  for (const child of Object.values(value)) assertJsonValue(child, ancestors);
  ancestors.delete(value);
}

/**
 * Enregistre de manière atomique un événement d'outbox sur l'exécuteur SQL fourni (client transactionnel).
 * Ne démarre ni ne termine aucune transaction autonome afin de préserver l'atomicité avec la mutation métier.
 */
export async function recordOutboxEvent(
  executor: SqlExecutor,
  input: RecordOutboxEventInput,
): Promise<OutboxEventRecord> {
  // Never accept a pool, an arbitrary executor, or an idle reserved connection.
  // A flag alone is insufficient: require the driver's actual transaction state.
  const client = executor as PoolClient & { _txStatus?: string; getTransactionStatus?: () => string };
  const transactionStatus = typeof client.getTransactionStatus === "function"
    ? client.getTransactionStatus() : client._txStatus;
  if (typeof client.release !== "function" || transactionStatus !== "T") {
    throw new OutboxValidationError("Un client PostgreSQL dans une transaction active est requis.");
  }
  const id = requireUuid(input.id ?? randomUUID(), "id");
  const aggregateId = requireUuid(input.aggregateId, "aggregateId");
  const targetAggregateId = input.targetAggregateId !== undefined && input.targetAggregateId !== null
    ? requireUuid(input.targetAggregateId, "targetAggregateId")
    : null;

  if (!VALID_EVENT_TYPES.has(input.eventType)) {
    throw new OutboxValidationError(`Type d'événement outbox invalide : ${input.eventType}`);
  }

  if (!VALID_AGGREGATE_TYPES.has(input.aggregateType)) {
    throw new OutboxValidationError(`Type d'agrégat outbox invalide : ${input.aggregateType}`);
  }
  const expectedAggregate = input.eventType.startsWith("offer.") ? "offer"
    : input.eventType.startsWith("demand.") ? "demand"
    : input.eventType.startsWith("user.") ? "user"
    : input.eventType.startsWith("temporal.") ? "temporal" : "system";
  if (input.aggregateType !== expectedAggregate) {
    throw new OutboxValidationError("L'événement ne correspond pas au type d'agrégat.");
  }

  // Vérifier la cohérence aggregateType / aggregateVersion selon contrainte chk_outbox_aggregate_version
  // Offres, demandes et comptes portent la version durable de leur agrégat ; temporel et système, non.
  const versioned = input.aggregateType === "offer" || input.aggregateType === "demand" || input.aggregateType === "user";
  let aggregateVersion: number | null = null;
  if (versioned) {
    if (
      input.aggregateVersion === undefined ||
      input.aggregateVersion === null ||
      !Number.isSafeInteger(input.aggregateVersion) ||
      input.aggregateVersion <= 0 || input.aggregateVersion > 2147483647
    ) {
      throw new OutboxValidationError(
        `aggregateVersion est requis et doit être un entier > 0 pour l'agrégat ${input.aggregateType}`,
      );
    }
    aggregateVersion = input.aggregateVersion;
  } else if (input.aggregateVersion !== undefined && input.aggregateVersion !== null) {
    if (!Number.isSafeInteger(input.aggregateVersion) || input.aggregateVersion <= 0 || input.aggregateVersion > 2147483647) {
      throw new OutboxValidationError(
        `aggregateVersion doit être un entier > 0 pour l'agrégat ${input.aggregateType}`,
      );
    }
    aggregateVersion = input.aggregateVersion;
  }

  const payload = input.payload ?? {};
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new OutboxValidationError("Le payload de l'événement outbox doit être un objet JSON valide.");
  }
  assertJsonValue(payload);
  for (const field of ["scoring_config", "scoring_config_hash", "engine_offline_version", "engine_scoring_version"]) {
    if (Object.hasOwn(payload, field)) throw new OutboxValidationError(`Champ réservé : ${field}`);
  }
  // Pour un agrégat versionné, la génération est exactement sa version : une valeur divergente est refusée.
  if (versioned && Object.hasOwn(payload, "generation") && payload.generation !== aggregateVersion) {
    throw new OutboxValidationError("La génération doit être égale à aggregateVersion.");
  }
  const generation = payload.generation ?? aggregateVersion;
  if (!Number.isSafeInteger(generation) || (generation as number) <= 0) {
    throw new OutboxValidationError("Une génération durable strictement positive est requise.");
  }
  // No scoring administration exists yet. Seal the full default configuration,
  // not merely its hash, so future projection never consults mutable defaults.
  const scoringConfig = normalizeScoringConfig();
  const sealedPayload = {
    ...payload,
    generation,
    scoring_config: scoringConfig,
    scoring_config_hash: computeScoringConfigHash(scoringConfig),
    engine_offline_version: MATCHING_OFFLINE_CONTRACT_VERSION,
    engine_scoring_version: MATCHING_SCORING_CONTRACT_VERSION,
  };
  let serialized: string;
  try { serialized = JSON.stringify(sealedPayload); }
  catch { throw new OutboxValidationError("Payload non sérialisable en JSON."); }

  const result = await executor.query<OutboxRow>(
    `INSERT INTO matching_outbox_events (
       id, event_type, aggregate_type, aggregate_id, aggregate_version,
       target_aggregate_id, payload
     ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
     RETURNING ${OUTBOX_COLUMNS}`,
    [
      id,
      input.eventType,
      input.aggregateType,
      aggregateId,
      aggregateVersion,
      targetAggregateId,
      serialized,
    ],
  );

  return mapOutboxRow(result.rows[0]);
}

/** Classify one effective mutation from locked-before and persisted-after records. */
export async function recordOfferMutation(tx: SqlExecutor, offer: OfferRecord, before?: OfferRecord): Promise<void> {
  let eventType: OutboxEventType;
  if (offer.status === "archived") eventType = "offer.archived";
  else if (!before) {
    if (offer.status !== "published" || offer.availabilityStatus === "unavailable") return;
    eventType = "offer.created";
  } else if (offer.status === "paused" && before.status !== "paused") eventType = "offer.paused";
  else if (offer.status === "published" && before.status !== "published") eventType = "offer.published";
  else if (offer.availabilityStatus === "unavailable" && before.availabilityStatus !== "unavailable") eventType = "offer.unavailable";
  else if (offer.status === "published" && before.availabilityStatus === "unavailable" && offer.availabilityStatus !== "unavailable") eventType = "offer.available";
  else {
    if (offer.status !== "published" && before.status !== "published") return;
    eventType = "offer.updated";
  }
  await recordOutboxEvent(tx, {
    eventType, aggregateType: "offer", aggregateId: offer.id, aggregateVersion: offer.contentVersion,
    payload: { status: offer.status, availability_status: offer.availabilityStatus,
      eligible: offer.status === "published" && offer.availabilityStatus !== "unavailable" },
  });
}

export async function recordDemandMutation(tx: SqlExecutor, demand: DemandRecord, before?: DemandRecord): Promise<void> {
  // Lot N1 : un besoin qui cesse d'être actif (satisfait, archivé, remis en brouillon) arrête tout. Les envois externes EN ATTENTE passent à `cancelled`
  // dans la MÊME transaction que le changement de statut (annulés avec lui, ou pas du tout). Sans effet si les tables de ce lot n'existent pas encore.
  if (demand.status !== "active" && (demand.status === "archived" || before?.status === "active")) {
    await cancelPendingDeliveriesForDemand(tx, demand.id, `demand_${demand.status === "draft" ? "inactive" : demand.status}`);
  }
  let eventType: OutboxEventType;
  if (demand.status === "archived") eventType = "demand.archived";
  else if (!before) {
    if (demand.status !== "active") return;
    eventType = "demand.created";
  } else if (demand.status === "active" && before.status !== "active") eventType = "demand.activated";
  else if (demand.status === "satisfied" && before.status !== "satisfied") eventType = "demand.satisfied";
  else {
    if (demand.status !== "active" && before.status !== "active") return;
    eventType = "demand.updated";
  }
  await recordOutboxEvent(tx, {
    eventType, aggregateType: "demand", aggregateId: demand.id, aggregateVersion: demand.contentVersion,
    payload: { status: demand.status, eligible: demand.status === "active" },
  });
}

export async function recordUserMutation(tx: SqlExecutor, user: UserRecord, before: UserRecord): Promise<void> {
  if (user.status === before.status) return;
  const eventType = user.status === "archived" ? "user.archived"
    : user.status === "suspended" ? "user.suspended" : "user.reactivated";
  await recordOutboxEvent(tx, {
    eventType, aggregateType: "user", aggregateId: user.id, aggregateVersion: user.version,
    payload: { status: user.status, generation: user.version },
  });
}

/**
 * Récupère un événement d'outbox par son identifiant.
 */
export async function getOutboxEventById(
  executor: SqlExecutor,
  id: string,
): Promise<OutboxEventRecord | null> {
  const result = await executor.query<OutboxRow>(
    `SELECT ${OUTBOX_COLUMNS} FROM matching_outbox_events WHERE id = $1`,
    [requireUuid(id, "id")],
  );
  return result.rowCount ? mapOutboxRow(result.rows[0]) : null;
}

/**
 * Liste les événements d'outbox pour un agrégat donné.
 */
export async function listOutboxEventsForAggregate(
  executor: SqlExecutor,
  aggregateType: OutboxAggregateType,
  aggregateId: string,
): Promise<OutboxEventRecord[]> {
  const result = await executor.query<OutboxRow>(
    `SELECT ${OUTBOX_COLUMNS} FROM matching_outbox_events
      WHERE aggregate_type = $1 AND aggregate_id = $2
      ORDER BY occurred_at ASC, id ASC`,
    [aggregateType, requireUuid(aggregateId, "aggregateId")],
  );
  return result.rows.map(mapOutboxRow);
}
