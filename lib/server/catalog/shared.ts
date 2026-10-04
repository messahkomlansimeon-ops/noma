import type { Pool, PoolClient, QueryResultRow } from "pg";
import { withPostgresTransaction, type NomaTransactionalClient, type SqlExecutor } from "../postgres/client";
import { CatalogValidationError } from "./errors";

function isPoolClient(db: unknown): db is PoolClient {
  return Boolean(db && typeof (db as PoolClient).release === "function");
}

function isPool(db: unknown): db is Pool {
  return Boolean(
    db &&
      typeof (db as Pool).connect === "function" &&
      typeof (db as unknown as { release?: unknown }).release !== "function",
  );
}

export async function executeInTransactionScope<T>(
  db: SqlExecutor,
  operation: (executor: SqlExecutor) => Promise<T>,
): Promise<T> {
  if (isPoolClient(db)) {
    const client = db as PoolClient & { __inNomaTransaction?: boolean; _txStatus?: string };
    if (client.__inNomaTransaction === true || client._txStatus === "T") {
      return operation(client);
    }
    await client.query("BEGIN");
    client.__inNomaTransaction = true;
    try {
      const result = await operation(client);
      await client.query("COMMIT");
      client.__inNomaTransaction = false;
      return result;
    } catch (error) {
      client.__inNomaTransaction = false;
      try {
        await client.query("ROLLBACK");
      } catch {
        // Ignorer l'erreur secondaire de rollback
      }
      throw error;
    }
  }

  if (isPool(db)) {
    return withPostgresTransaction(async (client) => {
      const txClient = client as NomaTransactionalClient;
      txClient.__inNomaTransaction = true;
      try {
        return await operation(txClient);
      } finally {
        txClient.__inNomaTransaction = false;
      }
    }, db as Pool);
  }

  throw new CatalogValidationError(
    "Une transaction PostgreSQL valide (Pool ou PoolClient) est requise pour exécuter cette mutation.",
  );
}
import {
  ArchivedCatalogResourceError,
  CatalogNotFoundError,
  CatalogOwnershipError,
  StaleContentVersionError,
} from "./errors";
import type {
  AvailabilityStatus,
  DemandRecord,
  OfferRecord,
  OfferStatus,
  DemandStatus,
} from "./types";

export const CATALOG_COLUMNS = `
  raw_text, category, brand, model, variant, attributes, condition_text,
  quantity, unit, location_text, deadline_at, extractor_version,
  extraction_metadata, extracted_at, created_at, updated_at, archived_at
`;

export interface CatalogRow extends QueryResultRow {
  raw_text: string;
  category: string | null;
  brand: string | null;
  model: string | null;
  variant: string | null;
  attributes: Record<string, unknown> | null;
  condition_text: string | null;
  quantity: number | null;
  unit: string | null;
  location_text: string | null;
  deadline_at: Date | null;
  extractor_version: string | null;
  extraction_metadata: Record<string, unknown> | null;
  extracted_at: Date | null;
  created_at: Date;
  updated_at: Date;
  archived_at: Date | null;
}

export function mapCatalogRow(row: CatalogRow) {
  return {
    rawText: row.raw_text,
    category: row.category,
    brand: row.brand,
    model: row.model,
    variant: row.variant,
    attributes: row.attributes,
    condition: row.condition_text,
    quantity: row.quantity,
    unit: row.unit,
    location: row.location_text,
    deadlineAt: row.deadline_at,
    extractorVersion: row.extractor_version,
    extractionMetadata: row.extraction_metadata,
    extractedAt: row.extracted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
  };
}

export function parseMoneyAmount(value: string | null, field: string): number | null {
  if (value === null) return null;
  const amount = Number(value);
  if (!Number.isSafeInteger(amount)) throw new Error(`${field} hors plage JavaScript sûre.`);
  return amount;
}

export interface OfferRow extends CatalogRow, QueryResultRow {
  id: string;
  owner_id: string;
  status: OfferStatus;
  price_amount: string | null;
  price_currency: string | null;
  availability_status: AvailabilityStatus | null;
  availability_confirmed_at: Date | null;
  content_version: number;
  created_at_iso?: string;
}

export const OFFER_COLUMNS = `
  id, owner_id, status, price_amount::text AS price_amount, price_currency,
  availability_status, availability_confirmed_at, content_version,
  ${CATALOG_COLUMNS}
`;

export function mapOffer(row: OfferRow): OfferRecord {
  const amount = parseMoneyAmount(row.price_amount, "price_amount");
  return {
    id: row.id,
    ownerId: row.owner_id,
    status: row.status,
    price: amount === null ? null : { amount, currency: row.price_currency! },
    availabilityStatus: row.availability_status,
    availabilityConfirmedAt: row.availability_confirmed_at,
    contentVersion: row.content_version,
    ...mapCatalogRow(row),
  } as OfferRecord;
}

export interface DemandRow extends CatalogRow, QueryResultRow {
  id: string;
  owner_id: string;
  status: DemandStatus;
  budget_amount: string | null;
  budget_currency: string | null;
  requirements: DemandRecord["requirements"];
  preferences: DemandRecord["preferences"];
  content_version: number;
  created_at_iso?: string;
}

export const DEMAND_COLUMNS = `
  id, owner_id, status, budget_amount::text AS budget_amount, budget_currency,
  requirements, preferences, content_version, ${CATALOG_COLUMNS}
`;

export function mapDemand(row: DemandRow): DemandRecord {
  const amount = parseMoneyAmount(row.budget_amount, "budget_amount");
  return {
    id: row.id,
    ownerId: row.owner_id,
    status: row.status,
    budget: amount === null ? null : { amount, currency: row.budget_currency! },
    requirements: row.requirements,
    preferences: row.preferences,
    contentVersion: row.content_version,
    ...mapCatalogRow(row),
  } as DemandRecord;
}

export async function diagnoseOwnedMutation(
  db: SqlExecutor,
  table: "offers" | "demands",
  entity: string,
  id: string,
  ownerId: string,
  expectedVersion: number,
): Promise<never> {
  const versionColumn = "content_version";
  const result = await db.query<{
    owner_id: string;
    content_version: number;
    status: string;
  }>(
    `SELECT owner_id, ${versionColumn}, status FROM ${table} WHERE id = $1`,
    [id],
  );
  if (!result.rowCount) throw new CatalogNotFoundError(entity);
  const row = result.rows[0];
  if (row.owner_id !== ownerId) throw new CatalogOwnershipError(entity);
  if (row.status === "archived") throw new ArchivedCatalogResourceError(entity);
  throw new StaleContentVersionError(entity, expectedVersion, row.content_version);
}
