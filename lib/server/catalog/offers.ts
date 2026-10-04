import "server-only";

import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { getPostgresPool, withPostgresTransaction, type SqlExecutor } from "../postgres/client";
import {
  ArchivedCatalogResourceError,
  CatalogNotFoundError,
  CatalogOwnershipError,
  CatalogStatusTransitionError,
  CatalogValidationError,
  StaleContentVersionError,
} from "./errors";
import {
  diagnoseOwnedMutation,
  executeInTransactionScope,
  OFFER_COLUMNS,
  mapOffer,
  type OfferRow,
} from "./shared";
import { invalidateMatchesForOffer } from "../matching/persistence";
import { recordOfferMutation } from "../matching/outbox";
import type {
  AvailabilityStatus,
  CatalogPagination,
  CreateOfferInput,
  OfferRecord,
  OfferStatus,
  UpdateOfferInput,
} from "./types";
import {
  normalizeCatalogContent,
  jsonParameter,
  optionalDate,
  optionalJsonObject,
  optionalMoney,
  optionalQuantity,
  optionalText,
  requiredText,
  requireCatalogPagination,
  requireTransactionPool,
  requireUuid,
  requireVersion,
} from "./validation";

const OFFER_STATUSES = new Set<OfferStatus>(["draft", "published", "paused"]);
const AVAILABILITY_STATUSES = new Set<AvailabilityStatus>([
  "available",
  "reserved",
  "unavailable",
]);

function requireOfferStatus(status: OfferStatus): OfferStatus {
  if (!OFFER_STATUSES.has(status)) throw new CatalogValidationError(`Statut offre invalide : ${status}`);
  return status;
}

function optionalAvailability(status: AvailabilityStatus | null | undefined) {
  if (status === null || status === undefined) return null;
  if (!AVAILABILITY_STATUSES.has(status)) {
    throw new CatalogValidationError(`Disponibilité invalide : ${status}`);
  }
  return status;
}

export async function createOffer(
  input: CreateOfferInput,
  db: SqlExecutor = getPostgresPool(),
): Promise<OfferRecord> {
  const content = normalizeCatalogContent(input);
  const id = requireUuid(input.id ?? randomUUID(), "id");
  const ownerId = requireUuid(input.ownerId, "ownerId");
  const status = requireOfferStatus(input.status ?? "draft");
  const price = optionalMoney(input.price, "price");
  const availability = optionalAvailability(input.availabilityStatus);
  const availabilityConfirmedAt = optionalDate(
    input.availabilityConfirmedAt,
    "availabilityConfirmedAt",
  );

  return executeInTransactionScope(db, async (tx) => {
    const result = await tx.query<OfferRow>(
      `INSERT INTO offers (
         id, owner_id, status, raw_text, category, brand, model, variant,
         attributes, condition_text, quantity, unit, location_text, deadline_at,
         price_amount, price_currency, availability_status, availability_confirmed_at,
         extractor_version, extraction_metadata, extracted_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
         $15, $16, $17, $18, $19, $20, $21
       ) RETURNING ${OFFER_COLUMNS}`,
      [
        id, ownerId, status, content.rawText, content.category, content.brand,
        content.model, content.variant, jsonParameter(content.attributes), content.condition,
        content.quantity, content.unit, content.location, content.deadlineAt,
        price?.amount ?? null, price?.currency ?? null, availability,
        availabilityConfirmedAt, content.extractorVersion,
        jsonParameter(content.extractionMetadata), content.extractedAt,
      ],
    );
    await recordOfferMutation(tx, mapOffer(result.rows[0]));
    return mapOffer(result.rows[0]);
  });
}

export async function getOfferById(
  ownerIdValue: string,
  idValue: string,
  db: SqlExecutor = getPostgresPool(),
): Promise<OfferRecord | null> {
  const result = await db.query<OfferRow>(
    `SELECT ${OFFER_COLUMNS} FROM offers WHERE id = $1 AND owner_id = $2`,
    [requireUuid(idValue, "id"), requireUuid(ownerIdValue, "ownerId")],
  );
  return result.rowCount ? mapOffer(result.rows[0]) : null;
}

export async function listOffersByOwner(
  ownerIdValue: string,
  db: SqlExecutor = getPostgresPool(),
  pagination?: CatalogPagination,
): Promise<OfferRecord[]> {
  const ownerId = requireUuid(ownerIdValue, "ownerId");
  const page = pagination ? requireCatalogPagination(pagination) : null;
  const result = await db.query<OfferRow>(
    `SELECT ${OFFER_COLUMNS} FROM offers
      WHERE owner_id = $1
      ORDER BY created_at, id
      ${page ? "LIMIT $2 OFFSET $3" : ""}`,
    page ? [ownerId, page.limit, page.offset] : [ownerId],
  );
  return result.rows.map(mapOffer);
}

export async function updateOffer(
  input: UpdateOfferInput,
  db: SqlExecutor = getPostgresPool(),
): Promise<OfferRecord> {
  const id = requireUuid(input.id, "id");
  const ownerId = requireUuid(input.ownerId, "ownerId");
  const version = requireVersion(input.expectedContentVersion, "expectedContentVersion");
  const values: unknown[] = [id, ownerId, version];
  const assignments: string[] = [];
  const add = (column: string, value: unknown) => {
    values.push(value);
    assignments.push(`${column} = $${values.length}`);
  };
  const changes = input.changes;

  if (Object.hasOwn(changes, "rawText")) add("raw_text", requiredText(changes.rawText!, "rawText"));
  if (Object.hasOwn(changes, "category")) add("category", optionalText(changes.category, "category"));
  if (Object.hasOwn(changes, "brand")) add("brand", optionalText(changes.brand, "brand"));
  if (Object.hasOwn(changes, "model")) add("model", optionalText(changes.model, "model"));
  if (Object.hasOwn(changes, "variant")) add("variant", optionalText(changes.variant, "variant"));
  if (Object.hasOwn(changes, "attributes")) add("attributes", jsonParameter(optionalJsonObject(changes.attributes, "attributes")));
  if (Object.hasOwn(changes, "condition")) add("condition_text", optionalText(changes.condition, "condition"));
  if (Object.hasOwn(changes, "quantity")) add("quantity", optionalQuantity(changes.quantity));
  if (Object.hasOwn(changes, "unit")) add("unit", optionalText(changes.unit, "unit"));
  if (Object.hasOwn(changes, "location")) add("location_text", optionalText(changes.location, "location"));
  if (Object.hasOwn(changes, "deadlineAt")) add("deadline_at", optionalDate(changes.deadlineAt, "deadlineAt"));
  if (Object.hasOwn(changes, "extractorVersion")) add("extractor_version", optionalText(changes.extractorVersion, "extractorVersion"));
  if (Object.hasOwn(changes, "extractionMetadata")) add("extraction_metadata", jsonParameter(optionalJsonObject(changes.extractionMetadata, "extractionMetadata")));
  if (Object.hasOwn(changes, "extractedAt")) add("extracted_at", optionalDate(changes.extractedAt, "extractedAt"));
  if (Object.hasOwn(changes, "status")) add("status", requireOfferStatus(changes.status!));
  if (Object.hasOwn(changes, "price")) {
    const price = optionalMoney(changes.price, "price");
    add("price_amount", price?.amount ?? null);
    add("price_currency", price?.currency ?? null);
  }
  if (Object.hasOwn(changes, "availabilityStatus")) {
    add("availability_status", optionalAvailability(changes.availabilityStatus));
  }
  if (Object.hasOwn(changes, "availabilityConfirmedAt")) {
    add("availability_confirmed_at", optionalDate(changes.availabilityConfirmedAt, "availabilityConfirmedAt"));
  }
  if (assignments.length === 0) throw new CatalogValidationError("Aucune modification d'offre fournie.");

  return executeInTransactionScope(db, async (tx) => {
    const previousResult = await tx.query<OfferRow>(
      `SELECT ${OFFER_COLUMNS} FROM offers
        WHERE id = $1 AND owner_id = $2 AND content_version = $3 AND status <> 'archived'
        FOR UPDATE`, [id, ownerId, version],
    );
    if (!previousResult.rowCount) return diagnoseOwnedMutation(tx, "offers", "offre", id, ownerId, version);
    const previous = previousResult.rows[0];
    // PostgreSQL compares canonical column values (JSONB, dates, money included).
    const differences = assignments.map((assignment) => assignment.replace(" = ", " IS DISTINCT FROM "));
    assignments.push("content_version = content_version + 1", "updated_at = CURRENT_TIMESTAMP");
    const result = await tx.query<OfferRow>(
      `UPDATE offers SET ${assignments.join(", ")}
       WHERE id = $1 AND owner_id = $2 AND content_version = $3
         AND status <> 'archived' AND (${differences.join(" OR ")})
       RETURNING ${OFFER_COLUMNS}`,
      values,
    );
    if (result.rowCount) {
      await invalidateMatchesForOffer(tx, id, result.rows[0].availability_status === "unavailable" ? "offer_unavailable" : "offer_updated");
      await recordOfferMutation(tx, mapOffer(result.rows[0]), mapOffer(previous));
      return mapOffer(result.rows[0]);
    }
    return mapOffer(previous);
  });
}

export async function archiveOffer(
  ownerIdValue: string,
  idValue: string,
  expectedContentVersion: number,
  db: SqlExecutor = getPostgresPool(),
): Promise<OfferRecord> {
  const id = requireUuid(idValue, "id");
  const ownerId = requireUuid(ownerIdValue, "ownerId");
  const version = requireVersion(expectedContentVersion, "expectedContentVersion");
  return executeInTransactionScope(db, async (tx) => {
    const result = await tx.query<OfferRow>(
      `UPDATE offers
         SET status = 'archived', archived_at = CURRENT_TIMESTAMP,
             content_version = content_version + 1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND owner_id = $2 AND content_version = $3
         AND status <> 'archived'
       RETURNING ${OFFER_COLUMNS}`,
      [id, ownerId, version],
    );
    if (result.rowCount) {
      await invalidateMatchesForOffer(tx, id, "offer_archived");
      await recordOfferMutation(tx, mapOffer(result.rows[0]));
      return mapOffer(result.rows[0]);
    }
    return diagnoseOwnedMutation(tx, "offers", "offre", id, ownerId, version);
  });
}

export interface CatalogTransitionOptions {
  beforeUpdate?: () => Promise<void>;
}

async function transitionOfferStatus(
  ownerIdValue: string,
  idValue: string,
  expectedContentVersion: number,
  targetStatus: "published" | "paused",
  allowedSources: readonly OfferStatus[],
  pool: unknown,
  options?: CatalogTransitionOptions,
): Promise<OfferRecord> {
  const id = requireUuid(idValue, "id");
  const ownerId = requireUuid(ownerIdValue, "ownerId");
  const version = requireVersion(expectedContentVersion, "expectedContentVersion");
  const targetPool = requireTransactionPool(pool);

  return withPostgresTransaction(async (client) => {
    const result = await client.query<OfferRow>(
      `SELECT ${OFFER_COLUMNS} FROM offers WHERE id = $1 FOR UPDATE`,
      [id],
    );
    if (!result.rowCount) throw new CatalogNotFoundError("offre");
    const row = result.rows[0];
    if (row.owner_id !== ownerId) throw new CatalogOwnershipError("offre");
    if (row.status === "archived") throw new ArchivedCatalogResourceError("offre");
    if (row.content_version !== version) {
      throw new StaleContentVersionError("offre", version, row.content_version);
    }
    if (row.status === targetStatus) {
      return mapOffer(row);
    }
    if (!allowedSources.includes(row.status)) {
      throw new CatalogStatusTransitionError("offre", row.status, targetStatus);
    }

    if (options?.beforeUpdate) {
      await options.beforeUpdate();
    }

    const updateResult = await client.query<OfferRow>(
      `UPDATE offers
          SET status = $2,
              content_version = content_version + 1,
              updated_at = CURRENT_TIMESTAMP
        WHERE id = $1
       RETURNING ${OFFER_COLUMNS}`,
      [id, targetStatus],
    );
    await invalidateMatchesForOffer(client, id, "offer_updated");
    await recordOfferMutation(client, mapOffer(updateResult.rows[0]), mapOffer(row));
    return mapOffer(updateResult.rows[0]);
  }, targetPool);
}

/**
 * Publie une offre existante (depuis draft ou paused).
 * Requiert un Pool PostgreSQL pour exécuter la transition sous transaction stricte avec verrou FOR UPDATE.
 */
export async function publishOffer(
  ownerIdValue: string,
  idValue: string,
  expectedContentVersion: number,
  pool: Pool = getPostgresPool(),
  options?: CatalogTransitionOptions,
): Promise<OfferRecord> {
  return transitionOfferStatus(
    ownerIdValue,
    idValue,
    expectedContentVersion,
    "published",
    ["draft", "paused"],
    pool,
    options,
  );
}

/**
 * Met en pause une offre existante (depuis published).
 * Requiert un Pool PostgreSQL pour exécuter la transition sous transaction stricte avec verrou FOR UPDATE.
 */
export async function pauseOffer(
  ownerIdValue: string,
  idValue: string,
  expectedContentVersion: number,
  pool: Pool = getPostgresPool(),
  options?: CatalogTransitionOptions,
): Promise<OfferRecord> {
  return transitionOfferStatus(
    ownerIdValue,
    idValue,
    expectedContentVersion,
    "paused",
    ["published"],
    pool,
    options,
  );
}
