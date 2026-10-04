import { Pool } from "pg";
import { getPostgresPool } from "../postgres/client";
import { CatalogValidationError } from "./errors";
import type {
  CatalogContentInput,
  CatalogPagination,
  JsonObject,
  JsonValue,
  Money,
} from "./types";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_INTEGER_QUANTITY = 2_147_483_647;

export function requireTransactionPool(pool: unknown): Pool {
  if (pool === undefined) {
    return getPostgresPool();
  }
  if (
    pool instanceof Pool ||
    (typeof pool === "object" &&
      pool !== null &&
      typeof (pool as Pool).connect === "function" &&
      typeof (pool as { release?: unknown }).release !== "function")
  ) {
    return pool as Pool;
  }
  throw new CatalogValidationError(
    "Un pool PostgreSQL valide est requis pour cette opération transactionnelle.",
  );
}

export function requireUuid(value: string, field: string): string {
  if (!UUID.test(value)) throw new CatalogValidationError(`${field} doit être un UUID valide.`);
  return value;
}

export function requireVersion(value: number, field = "version"): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new CatalogValidationError(`${field} doit être un entier positif.`);
  }
  return value;
}

export function requireCatalogPagination(value: CatalogPagination): CatalogPagination {
  if (!Number.isSafeInteger(value.limit) || value.limit <= 0 || value.limit > 100) {
    throw new CatalogValidationError("limit doit être un entier compris entre 1 et 100.");
  }
  if (!Number.isSafeInteger(value.offset) || value.offset < 0) {
    throw new CatalogValidationError("offset doit être un entier positif ou nul.");
  }
  return value;
}

export function optionalText(value: string | null | undefined, field: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new CatalogValidationError(`${field} doit être un texte.`);
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

export function requiredText(value: string, field: string): string {
  const normalized = optionalText(value, field);
  if (!normalized) throw new CatalogValidationError(`${field} est requis.`);
  return normalized;
}

export function optionalDate(value: Date | null | undefined, field: string): Date | null {
  if (value === null || value === undefined) return null;
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new CatalogValidationError(`${field} doit être une date valide.`);
  }
  return value;
}

export function optionalQuantity(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_INTEGER_QUANTITY) {
    throw new CatalogValidationError(
      `quantity doit être un entier compris entre 1 et ${MAX_INTEGER_QUANTITY}.`,
    );
  }
  return value;
}

export function optionalMoney(value: Money | null | undefined, field: string): Money | null {
  if (value === null || value === undefined) return null;
  if (!Number.isSafeInteger(value.amount) || value.amount < 0) {
    throw new CatalogValidationError(`${field}.amount doit être un entier positif ou nul.`);
  }
  const currency = value.currency.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new CatalogValidationError(`${field}.currency doit être un code ISO de trois lettres.`);
  }
  return { amount: value.amount, currency };
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || ["string", "boolean"].includes(typeof value)) return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    return (prototype === Object.prototype || prototype === null) &&
      Object.values(value as Record<string, unknown>).every(isJsonValue);
  }
  return false;
}

export function optionalJsonObject(
  value: JsonObject | null | undefined,
  field: string,
): JsonObject | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object" || Array.isArray(value) || !isJsonValue(value)) {
    throw new CatalogValidationError(`${field} doit être un objet JSON valide.`);
  }
  return value;
}

export function optionalJsonArray(
  value: JsonValue[] | null | undefined,
  field: string,
): JsonValue[] | null {
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value) || !value.every(isJsonValue)) {
    throw new CatalogValidationError(`${field} doit être un tableau JSON valide.`);
  }
  return value;
}

export function jsonParameter(value: JsonObject | JsonValue[] | null): string | null {
  return value === null ? null : JSON.stringify(value);
}

export function normalizeCatalogContent(input: CatalogContentInput) {
  return {
    rawText: requiredText(input.rawText, "rawText"),
    category: optionalText(input.category, "category"),
    brand: optionalText(input.brand, "brand"),
    model: optionalText(input.model, "model"),
    variant: optionalText(input.variant, "variant"),
    attributes: optionalJsonObject(input.attributes, "attributes"),
    condition: optionalText(input.condition, "condition"),
    quantity: optionalQuantity(input.quantity),
    unit: optionalText(input.unit, "unit"),
    location: optionalText(input.location, "location"),
    deadlineAt: optionalDate(input.deadlineAt, "deadlineAt"),
    extractorVersion: optionalText(input.extractorVersion, "extractorVersion"),
    extractionMetadata: optionalJsonObject(input.extractionMetadata, "extractionMetadata"),
    extractedAt: optionalDate(input.extractedAt, "extractedAt"),
  };
}
