import {
  accentNormalize,
  extractAttributeValues,
  type Attribute,
} from "../../../poc/lib/need";

const UNSIGNED_NUMBER_SOURCE = String.raw`(?:\d{1,3}(?:[ \u00a0.]\d{3})+|\d{1,3}(?:,\d{3})+|\d+(?:[.,]\d{1,2})?)`;
const NUMBER_SOURCE = String.raw`(?:[+-]\s*)?${UNSIGNED_NUMBER_SOURCE}`;
const NUMBER_START_BOUNDARY = String.raw`(?<![\p{L}\p{N}.,+\-])`;
const NUMBER_END_BOUNDARY = String.raw`(?![\p{L}\p{N}]|[.,]\d)`;

export interface NormalizedMeasurementOccurrence {
  key: string;
  value: number;
  unit: string | null;
  sourceUnit: string;
  sourceValue: number;
  quote: string;
  start: number;
  end: number;
}

function parseNumber(raw: string): number {
  const signed = raw.trim().match(/^([+-])?\s*(.*)$/);
  if (!signed) return Number.NaN;
  const sign = signed[1] === "-" ? -1 : 1;
  const value = signed[2];
  if (/^\d{1,3}(?:[ \u00a0.]\d{3})+$/.test(value)) {
    return sign * Number(value.replace(/[ \u00a0.]/g, ""));
  }
  if (/^\d{1,3}(?:,\d{3})+$/.test(value)) return sign * Number(value.replace(/,/g, ""));
  if (/^\d+,[0-9]{1,2}$/.test(value)) return sign * Number(value.replace(",", "."));
  return sign * Number(value.replace(/[ \u00a0]/g, ""));
}

export function parseCompleteNumber(raw: string): number | null {
  if (!new RegExp(`^${NUMBER_SOURCE}$`, "u").test(raw)) return null;
  const value = parseNumber(raw);
  return Number.isFinite(value) ? value : null;
}

export interface CompleteNumberOccurrence {
  value: number;
  quote: string;
  start: number;
  end: number;
}

export function extractCompleteNumberOccurrences(text: string): CompleteNumberOccurrence[] {
  const pattern = `${NUMBER_START_BOUNDARY}(${NUMBER_SOURCE})${NUMBER_END_BOUNDARY}`;
  return [...text.matchAll(new RegExp(pattern, "gu"))].flatMap((match) => {
    const value = parseNumber(match[1]);
    if (!Number.isFinite(value)) return [];
    const fullStart = match.index ?? 0;
    const relativeStart = match[0].indexOf(match[1]);
    const start = fullStart + Math.max(0, relativeStart);
    return [{ value, quote: match[1], start, end: start + match[1].length }];
  });
}

/** Compare des nombres complets : 28 ne peut jamais être prouvé par 128. */
export function evidenceContainsExactNumber(value: number, text: string): boolean {
  return extractCompleteNumberOccurrences(text).some((occurrence) => occurrence.value === value);
}

function escaped(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function numberSourceFor(value: number): string {
  const raw = String(value);
  if (!Number.isInteger(value)) {
    const [integer, decimal] = raw.split(".");
    return `${escaped(integer)}[.,]${escaped(decimal)}`;
  }
  const grouped = raw.replace(/\B(?=(\d{3})+(?!\d))/g, "[ \\u00a0.,]");
  return grouped === raw ? escaped(raw) : `(?:${escaped(raw)}|${grouped})`;
}

const ATTRIBUTE_UNITS: Record<string, { key: string; unit: string | null; aliases: string }> = {
  pointure: { key: "shoe_size", unit: null, aliases: "pointure" },
  taille: { key: "size", unit: null, aliases: "taille" },
  pouces: { key: "screen_size", unit: "in", aliases: String.raw`pouces?|po|″|"` },
  BTU: { key: "cooling_capacity", unit: "BTU", aliases: "btu" },
  CV: { key: "power", unit: "hp", aliases: "cv|chevaux|ch" },
  W: { key: "power", unit: "W", aliases: "watts?|w" },
  L: { key: "volume", unit: "L", aliases: "litres?|l" },
  m: { key: "length", unit: "m", aliases: String.raw`m[eè]tres?|m` },
  cm: { key: "length", unit: "cm", aliases: String.raw`centim[eè]tres?|cm` },
  kg: { key: "weight", unit: "kg", aliases: "kilogrammes?|kilos?|kg" },
  places: { key: "seating_capacity", unit: "count", aliases: "places?" },
};

function locateParsedAttribute(rawText: string, attribute: Attribute): NormalizedMeasurementOccurrence[] {
  const definition = ATTRIBUTE_UNITS[attribute.label];
  if (!definition) return [];
  const number = numberSourceFor(attribute.value);
  const positiveNumber = `(?:\\+\\s*${number}|${number})`;
  const unit = `(?:${definition.aliases})`;
  const prefix = attribute.label === "pointure" || attribute.label === "taille";
  const source = prefix
    ? String.raw`(?<![\p{L}])${unit}(?![\p{L}])\s*${positiveNumber}${NUMBER_END_BOUNDARY}`
    : String.raw`${NUMBER_START_BOUNDARY}${positiveNumber}${NUMBER_END_BOUNDARY}\s*${unit}(?![\p{L}\p{N}])`;
  const found: NormalizedMeasurementOccurrence[] = [];
  for (const match of rawText.matchAll(new RegExp(source, "giu"))) {
    if (/-\s*$/.test(rawText.slice(Math.max(0, (match.index ?? 0) - 4), match.index ?? 0))) continue;
    const unitMatch = match[0].match(new RegExp(definition.aliases, "iu"));
    if (!unitMatch) continue;
    const start = match.index ?? 0;
    found.push({
      key: definition.key,
      value: attribute.value,
      unit: definition.unit,
      sourceUnit: unitMatch[0],
      sourceValue: attribute.value,
      quote: match[0],
      start,
      end: start + match[0].length,
    });
  }
  return found;
}

function storageOccurrences(rawText: string): NormalizedMeasurementOccurrence[] {
  // Pas de groupement par espace ici : « iPhone 12 128 Go » doit conserver
  // deux nombres distincts. Les décimaux utilisent un seul séparateur.
  const storageNumber = String.raw`(?:[+-]\s*)?\d{1,4}(?:[.,]\d{1,2})?`;
  const source = String.raw`${NUMBER_START_BOUNDARY}(${storageNumber})${NUMBER_END_BOUNDARY}\s*(gigas?|gigaoctets?|go|gb|t[eé]ras?|t[eé]raoctets?|to|tb)\b`;
  return [...rawText.matchAll(new RegExp(source, "giu"))].flatMap((match) => {
    const sourceValue = parseNumber(match[1]);
    if (!Number.isFinite(sourceValue) || sourceValue <= 0) return [];
    const start = match.index ?? 0;
    const before = rawText.slice(Math.max(0, start - 40), start);
    if (
      /\d{1,3}[ \u00a0]+$/.test(before) &&
      !/(?:iphone|ipad|galaxy|redmi|tecno|infinix|pixel|note|camon|spark)\s*\d{1,2}[ \u00a0]+$/i.test(before)
    ) return [];
    const normalizedUnit = accentNormalize(match[2]);
    const isTerabyte = /^(?:t|tera)/.test(normalizedUnit);
    return [{
      key: "storage_capacity",
      value: isTerabyte ? sourceValue * 1_024 : sourceValue,
      unit: "GB",
      sourceUnit: match[2],
      sourceValue,
      quote: match[0],
      start,
      end: start + match[0].length,
    }];
  });
}

function mileageOccurrences(rawText: string): NormalizedMeasurementOccurrence[] {
  const source = String.raw`${NUMBER_START_BOUNDARY}(${NUMBER_SOURCE})${NUMBER_END_BOUNDARY}\s*(km|kilom[eè]tres?)\b`;
  return [...rawText.matchAll(new RegExp(source, "giu"))].flatMap((match) => {
    const value = parseNumber(match[1]);
    if (!Number.isFinite(value) || value <= 0) return [];
    const start = match.index ?? 0;
    return [{
      key: "mileage",
      value,
      unit: "km",
      sourceUnit: match[2],
      sourceValue: value,
      quote: match[0],
      start,
      end: start + match[0].length,
    }];
  });
}

export interface MeasurementNumericIssue {
  key: string;
  quote: string;
  start: number;
  end: number;
}

const MEASUREMENT_UNIT_DEFINITIONS: Array<{ key: string; aliases: string; prefix?: boolean }> = [
  { key: "storage_capacity", aliases: String.raw`gigas?|gigaoctets?|go|gb|t[eé]ras?|t[eé]raoctets?|to|tb` },
  { key: "mileage", aliases: String.raw`km|kilom[eè]tres?` },
  { key: "shoe_size", aliases: "pointure", prefix: true },
  { key: "size", aliases: "taille", prefix: true },
  { key: "screen_size", aliases: String.raw`pouces?|po|″|"` },
  { key: "cooling_capacity", aliases: "btu" },
  { key: "power", aliases: "cv|chevaux|ch|watts?|w" },
  { key: "volume", aliases: "litres?|l" },
  { key: "length", aliases: String.raw`centim[eè]tres?|cm|m[eè]tres?|m` },
  { key: "weight", aliases: "kilogrammes?|kilos?|kg" },
  { key: "seating_capacity", aliases: "places?" },
];

// Capture d'abord le lexème entier attenant au marqueur. Les signes peuvent
// être espacés et les groupements par milliers sont conservés ; la validation
// de la syntaxe complète reste la responsabilité de parseCompleteNumber.
const NUMERIC_LEXEME_SOURCE = String.raw`(?:[+-]\s*)*(?:\d{1,3}(?:[ \u00a0]\d{3})+[^\s;:()]*|[^\s;:()]*\d[^\s;:()]*)`;

function withoutNormalTrailingPunctuation(candidate: string): string {
  return /\d[.,]$/u.test(candidate) ? candidate.slice(0, -1) : candidate;
}

export function numericCandidateBefore(rawText: string, end: number): { quote: string; start: number } | null {
  const before = rawText.slice(0, end);
  const match = before.match(new RegExp(`(${NUMERIC_LEXEME_SOURCE})\\s*$`, "u"));
  if (!match) return null;
  const quote = withoutNormalTrailingPunctuation(match[1]);
  if (!quote) return null;
  const start = (match.index ?? 0) + match[0].indexOf(match[1]);
  return { quote, start };
}

export function numericCandidateAfter(
  rawText: string,
  start: number,
): { quote: string; start: number; end: number } | null {
  const after = rawText.slice(start);
  const match = after.match(new RegExp(`^\\s*(${NUMERIC_LEXEME_SOURCE})`, "u"));
  if (!match) return null;
  const quote = withoutNormalTrailingPunctuation(match[1]);
  if (!quote) return null;
  const candidateStart = start + match[0].indexOf(match[1]);
  return { quote, start: candidateStart, end: candidateStart + quote.length };
}

/** Signale tout nombre accolé à une unité connue mais non normalisable. */
export function extractMeasurementNumericIssues(rawText: string): MeasurementNumericIssue[] {
  const valid = extractMeasurementOccurrences(rawText);
  const issues: MeasurementNumericIssue[] = [];
  for (const definition of MEASUREMENT_UNIT_DEFINITIONS) {
    const unitEndBoundary = definition.prefix ? "(?![\\p{L}])" : "(?![\\p{L}\\p{N}])";
    const pattern = new RegExp(`(?<![\\p{L}])(?:${definition.aliases})${unitEndBoundary}`, "giu");
    for (const unit of rawText.matchAll(pattern)) {
      const unitStart = unit.index ?? 0;
      const unitEnd = unitStart + unit[0].length;
      if (valid.some((measurement) =>
        definition.prefix ? measurement.start === unitStart : measurement.end === unitEnd)) continue;
      const before = definition.prefix ? null : numericCandidateBefore(rawText, unitStart);
      const after = definition.prefix ? numericCandidateAfter(rawText, unitEnd) : null;
      if (!before && !after) continue;
      const start = before?.start ?? unitStart;
      const end = after?.end ?? unitEnd;
      const quote = rawText.slice(start, end).trim();
      if (!/\d/.test(quote)) continue;
      issues.push({ key: definition.key, quote, start, end });
    }
  }
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const key = `${issue.start}|${issue.end}|${issue.key}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Adapte les mesures du parseur PoC au contrat catalogue et ajoute seulement
 * les unités absentes du PoC (gigaoctets/téraoctets et kilométrage).
 */
export function extractMeasurementOccurrences(rawText: string): NormalizedMeasurementOccurrence[] {
  const parsed = extractAttributeValues(accentNormalize(rawText));
  const generic = parsed.flatMap((attribute) => locateParsedAttribute(rawText, attribute));
  const all = [...storageOccurrences(rawText), ...generic, ...mileageOccurrences(rawText)];
  const seen = new Set<string>();
  return all.filter((item) => {
    const key = `${item.start}|${item.end}|${item.key}|${item.value}|${item.unit}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function measurementsMatchingAttribute(
  rawText: string,
  attribute: { key: string; value: number; unit: string | null; sourceUnit: string | null },
): NormalizedMeasurementOccurrence[] {
  return extractMeasurementOccurrences(rawText).filter((measurement) =>
    measurement.key === attribute.key &&
    measurement.value === attribute.value &&
    measurement.unit === attribute.unit &&
    attribute.sourceUnit !== null &&
    measurement.sourceUnit === attribute.sourceUnit);
}
