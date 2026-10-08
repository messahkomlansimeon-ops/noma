import "server-only";

import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { getPostgresPool, withPostgresTransaction, type SqlExecutor } from "../postgres/client";
import {
  ArchivedCatalogResourceError,
  CatalogNotFoundError,
  CatalogOwnershipError,
  CatalogPhoneNumberError,
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
import { assertCanPublishOffer, lockUserEntitlements } from "../subscriptions/entitlements";
import type {
  AvailabilityStatus,
  CatalogPagination,
  CreateOfferInput,
  JsonObject,
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
  requireNoPhoneInOfferFields,
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
  requireNoPhoneInOfferFields(content);
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
  // Aucun numéro de téléphone dans les champs que l'acheteur voit (lot D1) : contrôle des seules modifications fournies.
  requireNoPhoneInOfferFields({
    category: changes.category, brand: changes.brand, model: changes.model, variant: changes.variant,
    condition: changes.condition, unit: changes.unit, location: changes.location, attributes: changes.attributes,
  });

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
    // Lot PRO1 : le verrou de l'utilisateur est pris AVANT la ligne de l'annonce (ordre des verrous : voir subscriptions/config.ts).
    if (targetStatus === "published") await lockUserEntitlements(client, ownerId);
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
    // Une annonce enregistrée avant la règle (ou par un chemin qui ne la contrôlait pas) ne peut pas être mise en ligne avec un numéro caché (lot D1).
    if (targetStatus === "published") {
      requireNoPhoneInOfferFields({
        category: row.category, brand: row.brand, model: row.model, variant: row.variant,
        condition: row.condition_text, unit: row.unit, location: row.location_text, attributes: row.attributes as JsonObject | null,
      });
    }
    if (!allowedSources.includes(row.status)) {
      throw new CatalogStatusTransitionError("offre", row.status, targetStatus);
    }
    // Lot PRO1 : mettre une annonce en ligne (publication, remise en ligne après une pause) compte dans la limite du plan ; la mettre en pause ne coûte rien.
    if (targetStatus === "published") await assertCanPublishOffer(client, ownerId);

    if (options?.beforeUpdate) {
      await options.beforeUpdate();
    }

    return applyOfferStatus(client, row, targetStatus);
  }, targetPool);
}

/**
 * Raison d'une mise en pause décidée par le SYSTÈME (lot PRO1) : la fin d'un abonnement met en pause les annonces au-delà de la limite du plan Gratuit (`plan_limit`). Une pause du
 * vendeur n'a pas de raison. La colonne `offers.paused_reason` n'a de sens que pendant la pause (la base l'efface dès que le statut change).
 */
export type OfferPauseReason = "plan_limit";

/** Écrit le nouveau statut d'une annonce DÉJÀ verrouillée et contrôlée : version de contenu, invalidation des correspondances, événement de l'outbox (une seule copie, partagée). */
async function applyOfferStatus(client: PoolClient, row: OfferRow, targetStatus: "published" | "paused", pausedReason: OfferPauseReason | null = null): Promise<OfferRecord> {
  const updateResult = await client.query<OfferRow>(
    `UPDATE offers
        SET status = $2,
            paused_reason = $3::text,
            content_version = content_version + 1,
            updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
     RETURNING ${OFFER_COLUMNS}`,
    [row.id, targetStatus, targetStatus === "paused" ? pausedReason : null],
  );
  await invalidateMatchesForOffer(client, row.id, "offer_updated");
  await recordOfferMutation(client, mapOffer(updateResult.rows[0]), mapOffer(row));
  return mapOffer(updateResult.rows[0]);
}

/**
 * Met en pause, DANS la transaction de l'appelant, une annonce publiée (fin d'un abonnement : les annonces au-delà de la limite du plan Gratuit, lot PRO1). Même chemin que
 * `pauseOffer` (version de contenu, correspondances invalidées, événement de l'outbox), sans version attendue : c'est le système qui décide. La raison (`plan_limit`) est ÉCRITE : elle
 * seule permet de remettre l'annonce en ligne à une souscription ultérieure. Renvoie null si l'annonce n'est plus publiée.
 */
export async function pauseOfferInTransaction(client: PoolClient, offerId: string, reason: OfferPauseReason | null = null): Promise<OfferRecord | null> {
  const found = await client.query<OfferRow>(`SELECT ${OFFER_COLUMNS} FROM offers WHERE id = $1 FOR UPDATE`, [requireUuid(offerId, "id")]);
  const row = found.rows[0];
  if (!row || row.status !== "published" || row.archived_at !== null) return null;
  return applyOfferStatus(client, row, "paused", reason);
}

/**
 * Verrouille (FOR UPDATE) les annonces de l'utilisateur mises en pause PAR LE SYSTÈME à la fin d'un abonnement (`paused_reason = 'plan_limit'`, non archivées), les plus RÉCENTES
 * d'abord. Jamais une annonce que le vendeur a mise en pause lui-même (raison absente). À appeler sous le verrou de l'utilisateur, avant les comptes du grand livre (ordre des verrous).
 */
export async function lockPlanLimitPausedOffers(client: PoolClient, ownerId: string): Promise<string[]> {
  const result = await client.query<{ id: string }>(
    `SELECT id FROM offers
      WHERE owner_id = $1::uuid AND status = 'paused' AND paused_reason = 'plan_limit' AND archived_at IS NULL
      ORDER BY created_at DESC, id DESC
      FOR UPDATE`,
    [requireUuid(ownerId, "ownerId")],
  );
  return result.rows.map((row) => row.id);
}

/**
 * Remet en ligne, DANS la transaction de l'appelant, une annonce mise en pause par le système (`plan_limit`) : même chemin que la publication (version de contenu, correspondances,
 * événement de l'outbox) et même contrôle des numéros de téléphone. Renvoie null (rien n'est écrit) si l'annonce n'est plus dans cet état ou ne passe plus la règle des numéros.
 * La limite du plan est vérifiée PAR L'APPELANT (il connaît la place restante).
 */
export async function republishPlanLimitOfferInTransaction(client: PoolClient, offerId: string): Promise<OfferRecord | null> {
  const found = await client.query<OfferRow & { paused_reason: string | null }>(`SELECT ${OFFER_COLUMNS}, paused_reason FROM offers WHERE id = $1 FOR UPDATE`, [requireUuid(offerId, "id")]);
  const row = found.rows[0];
  if (!row || row.status !== "paused" || row.archived_at !== null || row.paused_reason !== "plan_limit") return null;
  try {
    requireNoPhoneInOfferFields({
      category: row.category, brand: row.brand, model: row.model, variant: row.variant,
      condition: row.condition_text, unit: row.unit, location: row.location_text, attributes: row.attributes as JsonObject | null,
    });
  } catch (error) {
    if (error instanceof CatalogPhoneNumberError) return null;
    throw error;
  }
  return applyOfferStatus(client, row, "published");
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
