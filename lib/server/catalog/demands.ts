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
  DEMAND_COLUMNS,
  mapDemand,
  type DemandRow,
} from "./shared";
import { invalidateMatchesForDemand } from "../matching/persistence";
import { recordDemandMutation } from "../matching/outbox";
import type {
  CreateDemandInput,
  CatalogPagination,
  DemandRecord,
  DemandStatus,
  UpdateDemandInput,
} from "./types";
import {
  normalizeCatalogContent,
  jsonParameter,
  optionalDate,
  optionalJsonArray,
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
import type { CatalogTransitionOptions } from "./offers";

const DEMAND_STATUSES = new Set<DemandStatus>(["draft", "active", "satisfied"]);

function requireDemandStatus(status: DemandStatus): DemandStatus {
  if (!DEMAND_STATUSES.has(status)) {
    throw new CatalogValidationError(`Statut demande invalide : ${status}`);
  }
  return status;
}

export async function createDemand(
  input: CreateDemandInput,
  db: SqlExecutor = getPostgresPool(),
): Promise<DemandRecord> {
  const content = normalizeCatalogContent(input);
  const id = requireUuid(input.id ?? randomUUID(), "id");
  const ownerId = requireUuid(input.ownerId, "ownerId");
  const status = requireDemandStatus(input.status ?? "draft");
  const budget = optionalMoney(input.budget, "budget");
  const requirements = optionalJsonArray(input.requirements, "requirements");
  const preferences = optionalJsonArray(input.preferences, "preferences");
  return executeInTransactionScope(db, async (tx) => {
    const result = await tx.query<DemandRow>(
      `INSERT INTO demands (
         id, owner_id, status, raw_text, category, brand, model, variant,
         attributes, condition_text, quantity, unit, location_text, deadline_at,
         budget_amount, budget_currency, requirements, preferences,
         extractor_version, extraction_metadata, extracted_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
         $15, $16, $17, $18, $19, $20, $21
       ) RETURNING ${DEMAND_COLUMNS}`,
      [
        id, ownerId, status, content.rawText, content.category, content.brand,
        content.model, content.variant, jsonParameter(content.attributes), content.condition,
        content.quantity, content.unit, content.location, content.deadlineAt,
        budget?.amount ?? null, budget?.currency ?? null,
        jsonParameter(requirements), jsonParameter(preferences),
        content.extractorVersion, jsonParameter(content.extractionMetadata), content.extractedAt,
      ],
    );
    await recordDemandMutation(tx, mapDemand(result.rows[0]));
    return mapDemand(result.rows[0]);
  });
}

export async function getDemandById(
  ownerIdValue: string,
  idValue: string,
  db: SqlExecutor = getPostgresPool(),
): Promise<DemandRecord | null> {
  const result = await db.query<DemandRow>(
    `SELECT ${DEMAND_COLUMNS} FROM demands WHERE id = $1 AND owner_id = $2`,
    [requireUuid(idValue, "id"), requireUuid(ownerIdValue, "ownerId")],
  );
  return result.rowCount ? mapDemand(result.rows[0]) : null;
}

export async function listDemandsByOwner(
  ownerIdValue: string,
  db: SqlExecutor = getPostgresPool(),
  pagination?: CatalogPagination,
): Promise<DemandRecord[]> {
  const ownerId = requireUuid(ownerIdValue, "ownerId");
  const page = pagination ? requireCatalogPagination(pagination) : null;
  const result = await db.query<DemandRow>(
    // Lot MV1 : le besoin PORTEUR d'une mission d'achat en volume n'est pas un besoin de l'acheteur (il le voit dans « Mes missions »).
    `SELECT ${DEMAND_COLUMNS} FROM demands
      WHERE owner_id = $1 AND NOT EXISTS (SELECT 1 FROM missions m WHERE m.demand_id = demands.id)
      ORDER BY created_at, id
      ${page ? "LIMIT $2 OFFSET $3" : ""}`,
    page ? [ownerId, page.limit, page.offset] : [ownerId],
  );
  return result.rows.map(mapDemand);
}

export async function updateDemand(
  input: UpdateDemandInput,
  db: SqlExecutor = getPostgresPool(),
): Promise<DemandRecord> {
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
  if (Object.hasOwn(changes, "status")) add("status", requireDemandStatus(changes.status!));
  if (Object.hasOwn(changes, "budget")) {
    const budget = optionalMoney(changes.budget, "budget");
    add("budget_amount", budget?.amount ?? null);
    add("budget_currency", budget?.currency ?? null);
  }
  if (Object.hasOwn(changes, "requirements")) {
    add("requirements", jsonParameter(optionalJsonArray(changes.requirements, "requirements")));
  }
  if (Object.hasOwn(changes, "preferences")) {
    add("preferences", jsonParameter(optionalJsonArray(changes.preferences, "preferences")));
  }
  if (assignments.length === 0) throw new CatalogValidationError("Aucune modification de demande fournie.");

  return executeInTransactionScope(db, async (tx) => {
    const previousResult = await tx.query<DemandRow>(
      `SELECT ${DEMAND_COLUMNS} FROM demands
        WHERE id = $1 AND owner_id = $2 AND content_version = $3 AND status <> 'archived'
        FOR UPDATE`, [id, ownerId, version],
    );
    if (!previousResult.rowCount) return diagnoseOwnedMutation(tx, "demands", "demande", id, ownerId, version);
    const previous = previousResult.rows[0];
    // PostgreSQL compares canonical column values (JSONB, dates, money included).
    const differences = assignments.map((assignment) => assignment.replace(" = ", " IS DISTINCT FROM "));
    assignments.push("content_version = content_version + 1", "updated_at = CURRENT_TIMESTAMP");
    const result = await tx.query<DemandRow>(
      `UPDATE demands SET ${assignments.join(", ")}
       WHERE id = $1 AND owner_id = $2 AND content_version = $3
         AND status <> 'archived' AND (${differences.join(" OR ")})
       RETURNING ${DEMAND_COLUMNS}`,
      values,
    );
    if (result.rowCount) {
      await invalidateMatchesForDemand(tx, id, "demand_updated");
      await recordDemandMutation(tx, mapDemand(result.rows[0]), mapDemand(previous));
      return mapDemand(result.rows[0]);
    }
    return mapDemand(previous);
  });
}

export async function archiveDemand(
  ownerIdValue: string,
  idValue: string,
  expectedContentVersion: number,
  db: SqlExecutor = getPostgresPool(),
): Promise<DemandRecord> {
  const id = requireUuid(idValue, "id");
  const ownerId = requireUuid(ownerIdValue, "ownerId");
  const version = requireVersion(expectedContentVersion, "expectedContentVersion");
  return executeInTransactionScope(db, async (tx) => {
    const result = await tx.query<DemandRow>(
      `UPDATE demands
         SET status = 'archived', archived_at = CURRENT_TIMESTAMP,
             content_version = content_version + 1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND owner_id = $2 AND content_version = $3
         AND status <> 'archived'
       RETURNING ${DEMAND_COLUMNS}`,
      [id, ownerId, version],
    );
    if (result.rowCount) {
      await invalidateMatchesForDemand(tx, id, "demand_archived");
      await recordDemandMutation(tx, mapDemand(result.rows[0]));
      return mapDemand(result.rows[0]);
    }
    return diagnoseOwnedMutation(tx, "demands", "demande", id, ownerId, version);
  });
}

async function transitionDemandStatus(
  ownerIdValue: string,
  idValue: string,
  expectedContentVersion: number,
  targetStatus: "active" | "satisfied",
  allowedSources: readonly DemandStatus[],
  pool: unknown,
  options?: CatalogTransitionOptions,
): Promise<DemandRecord> {
  const id = requireUuid(idValue, "id");
  const ownerId = requireUuid(ownerIdValue, "ownerId");
  const version = requireVersion(expectedContentVersion, "expectedContentVersion");
  const targetPool = requireTransactionPool(pool);

  return withPostgresTransaction(async (client) => {
    const result = await client.query<DemandRow>(
      `SELECT ${DEMAND_COLUMNS} FROM demands WHERE id = $1 FOR UPDATE`,
      [id],
    );
    if (!result.rowCount) throw new CatalogNotFoundError("demande");
    const row = result.rows[0];
    if (row.owner_id !== ownerId) throw new CatalogOwnershipError("demande");
    if (row.status === "archived") throw new ArchivedCatalogResourceError("demande");
    if (row.content_version !== version) {
      throw new StaleContentVersionError("demande", version, row.content_version);
    }
    if (row.status === targetStatus) {
      return mapDemand(row);
    }
    if (!allowedSources.includes(row.status)) {
      throw new CatalogStatusTransitionError("demande", row.status, targetStatus);
    }

    if (options?.beforeUpdate) {
      await options.beforeUpdate();
    }

    const updateResult = await client.query<DemandRow>(
      `UPDATE demands
          SET status = $2,
              content_version = content_version + 1,
              updated_at = CURRENT_TIMESTAMP
        WHERE id = $1
       RETURNING ${DEMAND_COLUMNS}`,
      [id, targetStatus],
    );
    const reason = targetStatus === "satisfied" ? "demand_satisfied" : "demand_updated";
    await invalidateMatchesForDemand(client, id, reason);
    await recordDemandMutation(client, mapDemand(updateResult.rows[0]), mapDemand(row));
    return mapDemand(updateResult.rows[0]);
  }, targetPool);
}

/**
 * Active une demande existante (depuis draft ou satisfied).
 * Requiert un Pool PostgreSQL pour exécuter la transition sous transaction stricte avec verrou FOR UPDATE.
 */
export async function activateDemand(
  ownerIdValue: string,
  idValue: string,
  expectedContentVersion: number,
  pool: Pool = getPostgresPool(),
  options?: CatalogTransitionOptions,
): Promise<DemandRecord> {
  return transitionDemandStatus(
    ownerIdValue,
    idValue,
    expectedContentVersion,
    "active",
    ["draft", "satisfied"],
    pool,
    options,
  );
}

/**
 * Marque une demande comme satisfaite (depuis active).
 * Requiert un Pool PostgreSQL pour exécuter la transition sous transaction stricte avec verrou FOR UPDATE.
 */
export async function satisfyDemand(
  ownerIdValue: string,
  idValue: string,
  expectedContentVersion: number,
  pool: Pool = getPostgresPool(),
  options?: CatalogTransitionOptions,
): Promise<DemandRecord> {
  return transitionDemandStatus(
    ownerIdValue,
    idValue,
    expectedContentVersion,
    "satisfied",
    ["active"],
    pool,
    options,
  );
}
