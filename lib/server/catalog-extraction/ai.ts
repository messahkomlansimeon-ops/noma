import { accentNormalize } from "../../../poc/lib/need";
import { valueSupportedByEvidence } from "../../../poc/lib/understanding";
import { CatalogExtractionValidationError } from "./errors";
import {
  contextualEvidenceState,
  moneyAffirmedByEvidence,
  moneySupportedByEvidence,
  quantityAffirmedByEvidence,
  quantitySupportedByEvidence,
} from "./deterministic";
import {
  evidenceContainsExactNumber,
  extractCompleteNumberOccurrences,
  measurementsMatchingAttribute,
} from "./measurements";
import type {
  CatalogDemandProposedFields,
  CatalogExtractionAmbiguity,
  CatalogExtractionProposal,
  CatalogOfferProposedFields,
  CatalogProposedFields,
  CatalogTextEvidence,
  ProposedAttribute,
  ProposedCriterion,
  ProposedMoney,
} from "./types";

const COMMON_FIELDS = [
  "category",
  "brand",
  "model",
  "variant",
  "attributes",
  "condition",
  "quantity",
  "location",
  "deadlineAt",
] as const;
const OFFER_FIELDS = [...COMMON_FIELDS, "price"] as const;
const DEMAND_FIELDS = [...COMMON_FIELDS, "budget", "requirements", "preferences"] as const;
const MAX_QUANTITY = 2_147_483_647;
const MAX_AI_BYTES = 32 * 1_024;

type RecordValue = Record<string, unknown>;

interface ValidatedAiSuggestion {
  fields: Partial<CatalogProposedFields>;
  evidence: CatalogTextEvidence[];
  ambiguities: CatalogExtractionAmbiguity[];
}

function invalid(): never {
  throw new CatalogExtractionValidationError();
}

function isRecord(value: unknown): value is RecordValue {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function allowedObject(value: unknown, allowed: readonly string[]): RecordValue {
  if (!isRecord(value) || Object.keys(value).some((key) => !allowed.includes(key))) invalid();
  return value;
}

function boundedString(value: unknown, max: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max || value.trim() !== value) {
    invalid();
  }
  return value;
}

function nullableString(value: unknown, max: number): string | null {
  return value === null ? null : boundedString(value, max);
}

function validateMoney(value: unknown): ProposedMoney | null {
  if (value === null) return null;
  const money = allowedObject(value, ["amount", "currency"]);
  if (
    !Object.hasOwn(money, "amount") ||
    !Number.isSafeInteger(money.amount) ||
    (money.amount as number) < 0 ||
    !Object.hasOwn(money, "currency")
  ) invalid();
  const currency = money.currency === null ? null : boundedString(money.currency, 3);
  if (currency !== null && !/^[A-Z]{3}$/.test(currency)) invalid();
  return { amount: money.amount as number, currency };
}

function validateAttribute(value: unknown): ProposedAttribute {
  const attribute = allowedObject(value, ["key", "value", "unit", "sourceUnit"]);
  if (!Object.hasOwn(attribute, "value")) invalid();
  const scalar = attribute.value;
  if (
    !["string", "number", "boolean"].includes(typeof scalar) ||
    (typeof scalar === "string" && (scalar.length === 0 || scalar.length > 120)) ||
    (typeof scalar === "number" && !Number.isFinite(scalar))
  ) invalid();
  const key = boundedString(attribute.key, 60);
  if (!/^[a-z][a-z0-9_]*$/.test(key)) invalid();
  return {
    key,
    value: scalar as string | number | boolean,
    unit: nullableString(attribute.unit, 20),
    sourceUnit: nullableString(attribute.sourceUnit, 30),
  };
}

function validateAttributes(value: unknown): ProposedAttribute[] | null {
  if (value === null) return null;
  if (!Array.isArray(value) || value.length === 0 || value.length > 20) invalid();
  return value.map(validateAttribute);
}

function validateCriterion(value: unknown): ProposedCriterion {
  const criterion = allowedObject(value, ["key", "operator", "value"]);
  const key = boundedString(criterion.key, 60);
  const itemValue = boundedString(criterion.value, 120);
  if (!/^[a-z][a-z0-9_]*$/.test(key)) invalid();
  if (!new Set(["includes", "excludes", "equals"]).has(criterion.operator as string)) invalid();
  return {
    key,
    operator: criterion.operator as ProposedCriterion["operator"],
    value: itemValue,
  };
}

function validateCriteria(value: unknown): ProposedCriterion[] | null {
  if (value === null) return null;
  if (!Array.isArray(value) || value.length === 0 || value.length > 20) invalid();
  return value.map(validateCriterion);
}

function validateDeadline(value: unknown): string | null {
  if (value === null) return null;
  const deadline = boundedString(value, 30);
  const parsed = new Date(deadline);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== deadline) invalid();
  return deadline;
}

function validateFields(
  type: CatalogExtractionProposal["type"],
  value: unknown,
): Partial<CatalogProposedFields> {
  const fields = allowedObject(value, type === "offer" ? OFFER_FIELDS : DEMAND_FIELDS);
  const result: RecordValue = {};
  for (const [field, candidate] of Object.entries(fields)) {
    switch (field) {
      case "category":
      case "brand":
      case "model":
      case "variant":
      case "condition":
      case "location":
        result[field] = nullableString(candidate, field === "category" ? 60 : 120);
        break;
      case "attributes":
        result.attributes = validateAttributes(candidate);
        break;
      case "quantity":
        if (candidate !== null && (!Number.isSafeInteger(candidate) || (candidate as number) < 1 || (candidate as number) > MAX_QUANTITY)) invalid();
        result.quantity = candidate;
        break;
      case "deadlineAt":
        result.deadlineAt = validateDeadline(candidate);
        break;
      case "price":
      case "budget":
        result[field] = validateMoney(candidate);
        break;
      case "requirements":
      case "preferences":
        result[field] = validateCriteria(candidate);
        break;
      default:
        invalid();
    }
  }
  return result as Partial<CatalogProposedFields>;
}

function quoteIsPresent(rawText: string, quote: string): boolean {
  return rawText.includes(quote);
}

function allowedPath(
  type: CatalogExtractionProposal["type"],
  path: string,
  allowArrayRoot = false,
): boolean {
  const fields = type === "offer" ? OFFER_FIELDS : DEMAND_FIELDS;
  const [root, index, extra] = path.split(".");
  if (!fields.includes(root as never) || extra !== undefined) return false;
  const arrayField = root === "attributes" || root === "requirements" || root === "preferences";
  return arrayField
    ? (index === undefined ? allowArrayRoot : /^(?:0|[1-9]\d*)$/.test(index))
    : index === undefined;
}

function validateEvidence(
  rawText: string,
  type: CatalogExtractionProposal["type"],
  value: unknown,
): CatalogTextEvidence[] {
  if (!Array.isArray(value) || value.length > 64) invalid();
  return value.map((candidate) => {
    const evidence = allowedObject(candidate, ["field", "quote"]);
    const field = boundedString(evidence.field, 80);
    const quote = boundedString(evidence.quote, 200);
    if (!allowedPath(type, field) || !quoteIsPresent(rawText, quote)) invalid();
    return { field, quote };
  });
}

function validateAmbiguities(
  rawText: string,
  type: CatalogExtractionProposal["type"],
  value: unknown,
): CatalogExtractionAmbiguity[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 20) invalid();
  return value.map((candidate) => {
    const item = allowedObject(candidate, ["field", "code", "message", "evidence"]);
    const field = boundedString(item.field, 80);
    const code = boundedString(item.code, 60);
    const message = boundedString(item.message, 200);
    if (!allowedPath(type, field, true) || !Array.isArray(item.evidence) || item.evidence.length > 8) invalid();
    const evidence = item.evidence.map((quote) => boundedString(quote, 200));
    if (evidence.some((quote) => !quoteIsPresent(rawText, quote))) invalid();
    return { field, code, message, evidence };
  });
}

function evidenceFor(evidence: CatalogTextEvidence[], field: string): CatalogTextEvidence {
  const found = evidence.find((item) => item.field === field);
  if (!found) invalid();
  return found;
}

function numericEvidence(value: number, quote: string): boolean {
  return evidenceContainsExactNumber(value, quote);
}

function currencyEvidence(currency: string, quote: string): boolean {
  const normalized = accentNormalize(quote);
  if (currency === "XOF") return /\b(?:xof|cfa|fcfa|francs?)\b/.test(normalized);
  if (currency === "USD") return /\b(?:usd)\b|\$/.test(normalized);
  if (currency === "EUR") return /\b(?:eur)\b|€/.test(normalized);
  return normalized.includes(currency.toLowerCase());
}

function proveAttribute(rawText: string, attribute: ProposedAttribute, quote: string): void {
  if (typeof attribute.value === "number") {
    const measurements = measurementsMatchingAttribute(rawText, {
      key: attribute.key,
      value: attribute.value,
      unit: attribute.unit,
      sourceUnit: attribute.sourceUnit,
    });
    const quotedMeasurements = measurements.filter((measurement) => {
      let quoteStart = rawText.indexOf(quote);
      while (quoteStart >= 0) {
        if (measurement.start >= quoteStart && measurement.end <= quoteStart + quote.length) return true;
        quoteStart = rawText.indexOf(quote, quoteStart + 1);
      }
      return false;
    });
    if (quotedMeasurements.length > 0) {
      if (!quotedMeasurements.some((measurement) =>
        contextualEvidenceState(rawText, quote, measurement.quote) === "affirmed")) invalid();
    } else {
      if (!numericEvidence(attribute.value, quote) || attribute.unit !== null || attribute.sourceUnit !== null) invalid();
      const rawNumbers = extractCompleteNumberOccurrences(rawText)
        .filter((occurrence) => occurrence.value === attribute.value)
        .filter((occurrence) => {
          let quoteStart = rawText.indexOf(quote);
          while (quoteStart >= 0) {
            if (occurrence.start >= quoteStart && occurrence.end <= quoteStart + quote.length) return true;
            quoteStart = rawText.indexOf(quote, quoteStart + 1);
          }
          return false;
        });
      if (!rawNumbers.some((occurrence) =>
        contextualEvidenceState(rawText, quote, occurrence.quote) === "affirmed")) invalid();
    }
  } else if (typeof attribute.value === "string") {
    if (!valueSupportedByEvidence(attribute.value, quote)) invalid();
    if (contextualEvidenceState(rawText, quote, attribute.value) !== "affirmed") invalid();
  } else {
    const aliases: Record<string, string[]> = {
      charger_included: ["chargeur"],
      barter_accepted: ["troc"],
      warranty_mentioned: ["garantie"],
    };
    const states = (aliases[attribute.key] ?? [attribute.key.replace(/_/g, " ")])
      .map((target) => contextualEvidenceState(rawText, quote, target));
    const wanted = attribute.value ? "affirmed" : "negated";
    if (!states.includes(wanted) || states.some((state) => state === "mixed")) invalid();
  }
  const aliases: Record<string, string[]> = {
    storage_capacity: ["stockage", "capacite", "memoire", "go", "gb", "giga", "gigas", "gigaoctet", "gigaoctets", "to", "tb", "tera", "teraoctet", "teraoctets"],
    screen_size: ["ecran", "pouce", "pouces"],
    cooling_capacity: ["btu", "climatisation", "climatiseur"],
    power: ["puissance", "w", "watt", "watts", "cv"],
    volume: ["volume", "l", "litre", "litres"],
    weight: ["poids", "kg", "kilo", "kilos"],
    shoe_size: ["pointure"],
    seating_capacity: ["place", "places"],
    mileage: ["km", "kilometre", "kilometres", "kilometrage"],
    charger_included: ["chargeur"],
    barter_accepted: ["troc"],
    warranty_mentioned: ["garantie"],
  };
  const normalized = accentNormalize(quote);
  const supportedKey = (aliases[attribute.key] ?? [attribute.key.replace(/_/g, " ")])
    .some((alias) => valueSupportedByEvidence(alias, normalized));
  if (!supportedKey) invalid();
}

function proveCriterion(rawText: string, criterion: ProposedCriterion, quote: string): void {
  if (!valueSupportedByEvidence(criterion.value, quote)) invalid();
  const state = contextualEvidenceState(rawText, quote, criterion.value);
  if (criterion.operator === "excludes" ? state !== "negated" : state !== "affirmed") invalid();
}

function proveFields(
  rawText: string,
  fields: Partial<CatalogProposedFields>,
  evidence: CatalogTextEvidence[],
): void {
  for (const [field, value] of Object.entries(fields)) {
    if (value === null) continue;
    if (field === "attributes" || field === "requirements" || field === "preferences") {
      (value as Array<ProposedAttribute | ProposedCriterion>).forEach((item, index) => {
        const quote = evidenceFor(evidence, `${field}.${index}`).quote;
        if (field === "attributes") proveAttribute(rawText, item as ProposedAttribute, quote);
        else proveCriterion(rawText, item as ProposedCriterion, quote);
      });
      continue;
    }
    const quote = evidenceFor(evidence, field).quote;
    if (field === "quantity") {
      if (!quantitySupportedByEvidence(value as number, quote)) invalid();
      if (!quantityAffirmedByEvidence(rawText, value as number, quote)) invalid();
    } else if (field === "price" || field === "budget") {
      const money = value as ProposedMoney;
      if (!moneySupportedByEvidence(money, quote)) invalid();
      if (!moneyAffirmedByEvidence(rawText, money, quote)) invalid();
      if (money.currency && !currencyEvidence(money.currency, quote)) invalid();
    } else if (field === "deadlineAt") {
      if (!quote.includes(value as string)) invalid();
    } else {
      const stringValue = value as string;
      if (!valueSupportedByEvidence(stringValue, quote)) invalid();
      if (contextualEvidenceState(rawText, quote, stringValue) !== "affirmed") invalid();
    }
  }
}

function serialize(value: unknown): string {
  try {
    const serialized = JSON.stringify(value);
    if (!serialized || Buffer.byteLength(serialized, "utf8") > MAX_AI_BYTES) invalid();
    return serialized;
  } catch {
    return invalid();
  }
}

export function validateAiSuggestion(
  rawText: string,
  type: CatalogExtractionProposal["type"],
  value: unknown,
): ValidatedAiSuggestion {
  serialize(value);
  const suggestion = allowedObject(value, ["fields", "evidence", "ambiguities"]);
  if (!Object.hasOwn(suggestion, "fields") || !Object.hasOwn(suggestion, "evidence")) invalid();
  const fields = validateFields(type, suggestion.fields);
  const evidence = validateEvidence(rawText, type, suggestion.evidence);
  const ambiguities = validateAmbiguities(rawText, type, suggestion.ambiguities);
  proveFields(rawText, fields, evidence);
  return { fields, evidence, ambiguities };
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function mergeAiSuggestion(
  deterministic: CatalogExtractionProposal,
  suggestion: ValidatedAiSuggestion,
): CatalogExtractionProposal["fields"] {
  const merged = { ...deterministic.fields } as RecordValue;
  const deterministicFields = deterministic.fields as unknown as RecordValue;
  for (const [field, value] of Object.entries(suggestion.fields)) {
    if (value === null) continue;
    if (deterministic.ambiguities.some((item) => item.field === field || item.field.startsWith(`${field}.`))) {
      invalid();
    }
    const existing = deterministicFields[field];
    if (existing !== null && existing !== undefined && !sameValue(existing, value)) invalid();
    if (existing === null || existing === undefined) merged[field] = value;
  }
  return merged as unknown as CatalogOfferProposedFields | CatalogDemandProposedFields;
}
