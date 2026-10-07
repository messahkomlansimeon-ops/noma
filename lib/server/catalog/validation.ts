import { Pool } from "pg";
import { getPostgresPool } from "../postgres/client";
import { isValidNestedAttributeKey, isValidOfferAttributeKey, looksLikePhoneNumber, type OfferTextField } from "../../phone-text";
import { CatalogAttributeKeyError, CatalogPhoneNumberError, CatalogValidationError } from "./errors";
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

const JSON_DEPTH_LIMIT = 8;

/** Toute valeur (texte ou nombre, à toute profondeur) d'un objet JSON : une seule qui ressemble à un numéro de téléphone suffit. Les valeurs sont contrôlées UNE PAR UNE, jamais concaténées. */
function jsonValueCarriesPhoneNumber(value: JsonValue | undefined, depth = 0): boolean {
  if (value === null || value === undefined || typeof value === "boolean" || depth > JSON_DEPTH_LIMIT) return false;
  if (typeof value === "string") return looksLikePhoneNumber(value);
  if (typeof value === "number") return looksLikePhoneNumber(String(value));
  if (Array.isArray(value)) return value.some((item) => jsonValueCarriesPhoneNumber(item, depth + 1));
  return Object.values(value).some((inner) => jsonValueCarriesPhoneNumber(inner, depth + 1));
}

/**
 * Un nom d'attribut qui n'est pas écrit en lettres minuscules et tiret bas seulement. Les noms d'attributs sont les clés du niveau supérieur ; les clés d'un objet imbriqué
 * (« value », « unit », « sourceUnit » de l'extraction) n'ont jamais de chiffre, ni de séparateur (lettres et tiret bas, majuscules admises).
 */
function jsonHasInvalidKey(value: JsonValue | undefined, depth = 0): boolean {
  if (value === null || value === undefined || typeof value !== "object" || depth > JSON_DEPTH_LIMIT) return false;
  if (Array.isArray(value)) return value.some((item) => jsonHasInvalidKey(item, depth + 1));
  const valid = depth === 0 ? isValidOfferAttributeKey : isValidNestedAttributeKey;
  return Object.entries(value).some(([key, inner]) => !valid(key) || jsonHasInvalidKey(inner, depth + 1));
}

export interface OfferTextFields {
  category?: string | null;
  brand?: string | null;
  model?: string | null;
  variant?: string | null;
  condition?: string | null;
  unit?: string | null;
  location?: string | null;
  attributes?: JsonObject | null;
}

/** Champs textuels de l'annonce dans l'ordre où ils sont contrôlés. */
const TEXT_FIELDS_IN_ORDER = ["category", "brand", "model", "variant", "condition", "unit", "location"] as const;

/** Premier champ de l'annonce dont le texte (ou une valeur d'attribut) ressemble à un numéro de téléphone ; null si aucun. Les champs ne sont jamais concaténés. */
export function findPhoneNumberField(fields: OfferTextFields): OfferTextField | null {
  for (const field of TEXT_FIELDS_IN_ORDER) {
    const text = fields[field];
    if (typeof text === "string" && looksLikePhoneNumber(text)) return field;
  }
  return jsonValueCarriesPhoneNumber(fields.attributes ?? null) ? "attributes" : null;
}

/**
 * Une annonce (offre) ne porte jamais de numéro de téléphone dans les champs que l'acheteur voit : catégorie, marque, modèle, variante, état, unité,
 * localisation et attributs (lots D1 et D3). L'acheteur contacte le vendeur par noma, le numéro ne se révèle que par ce contact.
 *  - lève `CatalogPhoneNumberError` (message clair avec le champ concerné : « Pas de numéro de téléphone dans l'annonce (champ : variante) : l'acheteur vous contactera
 *    par noma. ») ; chaque champ et chaque valeur d'attribut est contrôlé SEUL : un numéro coupé entre plusieurs champs ou attributs n'est pas détecté (limite documentée) ;
 *  - lève `CatalogAttributeKeyError` si un nom d'attribut (à toute profondeur) n'est pas écrit en lettres minuscules et tiret bas seulement (« tel_0708 » est refusé : un
 *    chiffre dans un nom ne sert qu'à faire passer un numéro).
 * Le texte brut de l'annonce n'est pas contrôlé : il n'est jamais servi à un acheteur.
 */
export function requireNoPhoneInOfferFields(fields: OfferTextFields): void {
  for (const field of TEXT_FIELDS_IN_ORDER) {
    const text = fields[field];
    if (typeof text === "string" && looksLikePhoneNumber(text)) throw new CatalogPhoneNumberError(field);
  }
  if (jsonHasInvalidKey(fields.attributes ?? null)) throw new CatalogAttributeKeyError();
  if (jsonValueCarriesPhoneNumber(fields.attributes ?? null)) throw new CatalogPhoneNumberError("attributes");
}
