import "server-only";

import { CatalogExtractionConfigurationError, CatalogExtractionValidationError } from "./errors";
import { mergeAiSuggestion, validateAiSuggestion } from "./ai";
import { deterministicCatalogExtraction } from "./deterministic";
import {
  AI_EXTRACTOR_VERSION,
  CATALOG_EXTRACTION_CONTRACT_VERSION,
  type CatalogExtractionInput,
  type CatalogExtractionOptions,
  type CatalogExtractionProposal,
} from "./types";

const MAX_RAW_TEXT_BYTES = 32 * 1_024;
const MAX_RAW_TEXT_CHARACTERS = 10_000;

function validateInput(value: CatalogExtractionInput): CatalogExtractionInput {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => key !== "type" && key !== "rawText") ||
    (value.type !== "offer" && value.type !== "demand") ||
    typeof value.rawText !== "string" ||
    value.rawText.trim().length === 0 ||
    value.rawText.length > MAX_RAW_TEXT_CHARACTERS ||
    Buffer.byteLength(value.rawText, "utf8") > MAX_RAW_TEXT_BYTES
  ) {
    throw new CatalogExtractionValidationError("Entrée d'extraction invalide.");
  }
  return value;
}

function mergeEvidence<T extends { field: string; quote: string }>(
  left: T[],
  right: T[],
): T[] {
  const seen = new Set(left.map((item) => `${item.field}\u0000${item.quote}`));
  return [...left, ...right.filter((item) => {
    const key = `${item.field}\u0000${item.quote}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  })];
}

export async function extractCatalogProposal(
  inputValue: CatalogExtractionInput,
  options: CatalogExtractionOptions = {},
): Promise<CatalogExtractionProposal> {
  const input = validateInput(inputValue);
  const mode = options.mode ?? "deterministic";
  if (mode !== "deterministic" && mode !== "ai") {
    throw new CatalogExtractionValidationError("Mode d'extraction invalide.");
  }
  if (mode === "ai" && !options.ai) throw new CatalogExtractionConfigurationError();

  const deterministic = deterministicCatalogExtraction(input);
  if (mode === "deterministic") return deterministic;

  const rawSuggestion = await options.ai!.extract({
    contractVersion: CATALOG_EXTRACTION_CONTRACT_VERSION,
    type: input.type,
    rawText: input.rawText,
    deterministicFields: deterministic.fields,
  }, options.signal);
  const suggestion = validateAiSuggestion(input.rawText, input.type, rawSuggestion);
  const fields = mergeAiSuggestion(deterministic, suggestion);
  const common = {
    ...deterministic,
    extractorVersion: AI_EXTRACTOR_VERSION,
    provenance: "ai" as const,
    evidence: mergeEvidence(deterministic.evidence, suggestion.evidence),
    ambiguities: [...deterministic.ambiguities, ...suggestion.ambiguities],
  };
  return input.type === "offer"
    ? { ...common, type: "offer", fields: fields as Extract<CatalogExtractionProposal, { type: "offer" }>["fields"] }
    : { ...common, type: "demand", fields: fields as Extract<CatalogExtractionProposal, { type: "demand" }>["fields"] };
}
