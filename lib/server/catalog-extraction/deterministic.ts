import { accentNormalize, parseNeed, parsePrice, type ParsedNeed } from "../../../poc/lib/need";
import {
  extractMeasurementNumericIssues,
  extractMeasurementOccurrences,
  numericCandidateAfter,
  numericCandidateBefore,
  parseCompleteNumber,
} from "./measurements";
import {
  CATALOG_EXTRACTION_CONTRACT_VERSION,
  DETERMINISTIC_EXTRACTOR_VERSION,
  type CatalogDemandProposedFields,
  type CatalogExtractionAmbiguity,
  type CatalogExtractionInput,
  type CatalogExtractionProposal,
  type CatalogOfferProposedFields,
  type CatalogProposedCommonFields,
  type CatalogTextEvidence,
  type ProposedAttribute,
  type ProposedCriterion,
  type ProposedMoney,
} from "./types";

const MAX_QUANTITY = 2_147_483_647;
const QUANTITY_PREFIX_SOURCE = String.raw`\b(?:quantit[eé]\s*[:=]?|lot\s+de)\s*`;
const QUANTITY_UNIT_SOURCE = String.raw`\b(?:unit[eé]s?|pi[eè]ces?|articles?|exemplaires?)\b`;

interface TextToken {
  normalized: string;
  start: number;
  end: number;
}

function tokens(text: string): TextToken[] {
  return [...text.matchAll(/[\p{L}\p{N}]+/gu)].map((match) => ({
    normalized: accentNormalize(match[0]),
    start: match.index ?? 0,
    end: (match.index ?? 0) + match[0].length,
  }));
}

function findPhrase(text: string, phrase: string): string | null {
  return findPhraseOccurrences(text, phrase)[0]?.quote ?? null;
}

interface PhraseOccurrence {
  quote: string;
  start: number;
  end: number;
}

function findPhraseOccurrences(text: string, phrase: string): PhraseOccurrence[] {
  const sourceTokens = tokens(text);
  const wanted = accentNormalize(phrase).split(/[^a-z0-9]+/).filter(Boolean);
  if (wanted.length === 0) return [];
  const found: PhraseOccurrence[] = [];
  for (let start = 0; start <= sourceTokens.length - wanted.length; start += 1) {
    if (wanted.every((part, offset) => sourceTokens[start + offset].normalized === part)) {
      const begin = sourceTokens[start].start;
      const end = sourceTokens[start + wanted.length - 1].end;
      found.push({ quote: text.slice(begin, end), start: begin, end });
    }
  }
  if (wanted.length === 1 && /^[a-z]+$/.test(wanted[0])) {
    for (const token of sourceTokens) {
      if (!new RegExp(`^${wanted[0]}\\d+$`).test(token.normalized)) continue;
      const end = token.start + wanted[0].length;
      found.push({ quote: text.slice(token.start, end), start: token.start, end });
    }
  }
  return found;
}

function modelPhraseOccurrences(text: string, model: string, variant: string | null): PhraseOccurrence[] {
  const [family, number] = model.split(" ");
  if (!family || !number) return [];
  const suffix = variant
    ? variant.split(" ").map((part) => `\\s+${part}`).join("")
    : "";
  const pattern = new RegExp(`\\b${family}\\s*${number}${suffix}\\b`, "giu");
  return [...text.matchAll(pattern)].map((match) => {
    const start = match.index ?? 0;
    return { quote: match[0], start, end: start + match[0].length };
  });
}

function affirmedModelPhrase(text: string, model: string, variant: string | null): PhraseOccurrence | null {
  return modelPhraseOccurrences(text, model, variant)
    .find((item) => !occurrenceIsNegated(text, item.start)) ?? null;
}

function occurrenceIsNegated(text: string, start: number): boolean {
  const before = accentNormalize(text.slice(Math.max(0, start - 48), start));
  return /(?:^|[\s,;.])(?:pas|non|sans|jamais|plus|ni|aucun|aucune)(?:\s+(?:en|de|d(?:['’])?|l(?:['’])?|un|une|des|du|le|la|les))*$/.test(before);
}

function affirmedPhrase(text: string, phrase: string): PhraseOccurrence | null {
  return findPhraseOccurrences(text, phrase).find((item) => !occurrenceIsNegated(text, item.start)) ?? null;
}

function contextualQuote(text: string, occurrence: PhraseOccurrence): string {
  if (!occurrenceIsNegated(text, occurrence.start)) return occurrence.quote;
  const source = tokens(text);
  const first = source.findIndex((token) => token.start >= occurrence.start);
  let start = occurrence.start;
  if (first >= 0) {
    const negators = new Set(["pas", "non", "sans", "jamais", "plus", "ni"]);
    for (let index = first - 1; index >= Math.max(0, first - 4); index -= 1) {
      if (!negators.has(source[index].normalized)) continue;
      start = source[index].start;
      break;
    }
  }
  return text.slice(start, occurrence.end);
}

export function contextualEvidenceState(
  rawText: string,
  quote: string,
  value: string,
): "affirmed" | "negated" | "absent" | "mixed" {
  const states = new Set<"affirmed" | "negated">();
  let quoteStart = rawText.indexOf(quote);
  while (quoteStart >= 0) {
    const quoteEnd = quoteStart + quote.length;
    for (const occurrence of findPhraseOccurrences(rawText, value)) {
      if (occurrence.start < quoteStart || occurrence.end > quoteEnd) continue;
      states.add(occurrenceIsNegated(rawText, occurrence.start) ? "negated" : "affirmed");
    }
    quoteStart = rawText.indexOf(quote, quoteStart + 1);
  }
  if (states.size > 1) return "mixed";
  return states.values().next().value ?? "absent";
}

function exactFragment(text: string, fragment: string): string {
  const trimmed = fragment.trim();
  const index = text.indexOf(trimmed);
  if (index >= 0) return text.slice(index, index + Math.min(trimmed.length, 180));
  return text.trim().slice(0, 180);
}

function addEvidence(
  evidence: CatalogTextEvidence[],
  field: string,
  quote: string | null,
): void {
  if (!quote) return;
  if (!evidence.some((item) => item.field === field && item.quote === quote)) {
    evidence.push({ field, quote });
  }
}

function ambiguity(
  field: string,
  code: string,
  message: string,
  evidence: string[],
): CatalogExtractionAmbiguity {
  return { field, code, message, evidence: [...new Set(evidence.filter(Boolean))].slice(0, 8) };
}

const CATEGORY_RULES: Array<{ value: string; terms: string[] }> = [
  { value: "phones", terms: ["iphone", "smartphone", "telephone", "samsung", "galaxy", "redmi", "tecno", "infinix", "pixel"] },
  { value: "televisions", terms: ["televiseur", "television", "tv"] },
  { value: "computers", terms: ["ordinateur", "laptop", "macbook", "pc"] },
  { value: "appliances", terms: ["refrigerateur", "frigo", "climatiseur", "congelateur", "machine a laver"] },
  { value: "furniture", terms: ["canape", "canapes", "table", "tables", "chaise", "chaises", "meuble", "meubles", "lit", "lits", "armoire", "armoires"] },
  { value: "vehicles", terms: ["voiture", "moto", "velo", "vehicule"] },
  { value: "fashion", terms: ["chaussure", "chaussures", "sac", "robe", "chemise"] },
];

const BRAND_RULES: Array<{ value: string; terms: string[] }> = [
  { value: "Apple", terms: ["apple", "iphone", "ipad", "macbook"] },
  { value: "Samsung", terms: ["samsung", "galaxy"] },
  { value: "Xiaomi", terms: ["xiaomi", "redmi"] },
  { value: "Google", terms: ["google pixel", "pixel"] },
  { value: "Tecno", terms: ["tecno", "camon", "spark"] },
  { value: "Infinix", terms: ["infinix"] },
];

function detectMappedValue(
  rawText: string,
  field: "category" | "brand",
  rules: Array<{ value: string; terms: string[] }>,
  evidence: CatalogTextEvidence[],
  ambiguities: CatalogExtractionAmbiguity[],
): string | null {
  const matches = rules.flatMap((rule) => {
    const occurrence = rule.terms.map((term) => affirmedPhrase(rawText, term)).find(Boolean) ?? null;
    return occurrence ? [{ value: rule.value, quote: occurrence.quote }] : [];
  });
  const values = [...new Set(matches.map((match) => match.value))];
  if (values.length > 1) {
    ambiguities.push(ambiguity(
      field,
      "multiple_values",
      `Plusieurs valeurs sont possibles pour ${field}.`,
      matches.map((match) => match.quote),
    ));
    return null;
  }
  if (matches[0]) addEvidence(evidence, field, matches[0].quote);
  return matches[0]?.value ?? null;
}

function modelCandidates(rawText: string): Array<{ model: string; variant: string | null }> {
  const fragments = rawText.split(/\b(?:ou|et|versus|vs)\b|[,;/]/i);
  const found = new Map<string, { model: string; variant: string | null }>();
  for (const fragment of fragments) {
    const parsed = parseNeed(fragment);
    if (!parsed.model) continue;
    if (!affirmedModelPhrase(rawText, parsed.model, parsed.variant)) continue;
    const key = `${parsed.model}|${parsed.variant ?? ""}`;
    found.set(key, { model: parsed.model, variant: parsed.variant });
  }
  return [...found.values()];
}

function detectModel(
  rawText: string,
  evidence: CatalogTextEvidence[],
  ambiguities: CatalogExtractionAmbiguity[],
): { model: string | null; variant: string | null } {
  const candidates = modelCandidates(rawText);
  const models = [...new Set(candidates.map((candidate) => candidate.model))];
  if (models.length > 1) {
    ambiguities.push(ambiguity(
      "model",
      "multiple_models",
      "Plusieurs modèles distincts sont mentionnés.",
      models.map((model) => affirmedModelPhrase(rawText, model, null)?.quote ?? model),
    ));
    return { model: null, variant: null };
  }
  const selected = candidates[0];
  if (!selected) return { model: null, variant: null };
  addEvidence(evidence, "model", affirmedModelPhrase(rawText, selected.model, null)?.quote ?? null);
  const variants = [...new Set(
    candidates
      .filter((candidate) => candidate.model === selected.model)
      .map((candidate) => candidate.variant ?? ""),
  )];
  if (variants.length > 1) {
    ambiguities.push(ambiguity(
      "variant",
      "multiple_variants",
      "Plusieurs variantes distinctes sont mentionnées.",
      candidates.map((candidate) =>
        affirmedModelPhrase(rawText, candidate.model, candidate.variant)?.quote ?? candidate.model),
    ));
    return { model: selected.model, variant: null };
  }
  if (selected.variant) addEvidence(evidence, "variant", affirmedPhrase(rawText, selected.variant)?.quote ?? null);
  return { model: selected.model, variant: selected.variant };
}

const CONDITION_VALUES: Record<string, string> = {
  "sous blister": "new",
  scelle: "new",
  neuf: "new",
  "comme neuf": "like_new",
  "casi neuf": "like_new",
  "tres bon etat": "very_good",
  "bon etat": "good",
};

function detectCondition(
  rawText: string,
  parsed: ParsedNeed,
  evidence: CatalogTextEvidence[],
  ambiguities: CatalogExtractionAmbiguity[],
): string | null {
  const relevant = parsed.criteria
    .filter((criterion) => Object.hasOwn(CONDITION_VALUES, criterion))
    .filter((criterion, _index, all) =>
      !all.some((other) => other !== criterion && other.length > criterion.length && other.includes(criterion)))
    .flatMap((criterion) => findPhraseOccurrences(rawText, criterion).map((occurrence) => ({
      criterion,
      value: CONDITION_VALUES[criterion],
      quote: contextualQuote(rawText, occurrence),
      state: occurrenceIsNegated(rawText, occurrence.start) ? "negated" as const : "affirmed" as const,
    })));
  const negated = relevant.filter((item) => item.state === "negated");
  if (negated.length > 0) {
    ambiguities.push(ambiguity(
      "condition",
      "negated_value",
      "L'état est mentionné sous forme négative et n'est pas proposé.",
      negated.map((item) => item.quote ?? item.criterion),
    ));
  }
  const affirmed = relevant.filter((item) => item.state === "affirmed");
  if (negated.length > 0 && affirmed.length > 0) {
    ambiguities.push(ambiguity(
      "condition",
      "contradictory_condition",
      "L'état est affirmé et nié dans le même texte.",
      relevant.map((item) => item.quote),
    ));
    return null;
  }
  const values = [...new Set(affirmed.map((item) => item.value))];
  if (values.length > 1) {
    ambiguities.push(ambiguity(
      "condition",
      "multiple_values",
      "Plusieurs états incompatibles sont mentionnés.",
      affirmed.map((item) => item.quote ?? item.criterion),
    ));
    return null;
  }
  if (affirmed[0]) addEvidence(evidence, "condition", affirmed[0].quote);
  return affirmed[0]?.value ?? null;
}

function detectQuantity(
  rawText: string,
  evidence: CatalogTextEvidence[],
  ambiguities: CatalogExtractionAmbiguity[],
): number | null {
  const found = quantityMentions(rawText);
  const invalid = found.filter((item) =>
    item.value === null ||
    !Number.isSafeInteger(item.value) ||
    item.value < 1 ||
    item.value > MAX_QUANTITY);
  if (invalid.length > 0) {
    ambiguities.push(ambiguity(
      "quantity",
      "invalid_numeric_quantity",
      `La quantité doit être un entier compris entre 1 et ${MAX_QUANTITY}.`,
      invalid.map((item) => item.quote),
    ));
    return null;
  }
  const valid = found.filter((item): item is QuantityMention & { value: number } => item.value !== null);
  const values = [...new Set(valid.map((item) => item.value))];
  if (values.length > 1) {
    ambiguities.push(ambiguity(
      "quantity",
      "multiple_values",
      "Plusieurs quantités distinctes sont mentionnées.",
      valid.map((item) => item.quote),
    ));
    return null;
  }
  if (!valid[0]) return null;
  addEvidence(evidence, "quantity", valid[0].quote);
  return valid[0].value;
}

export function quantitySupportedByEvidence(value: number, quote: string): boolean {
  return quantityMentions(quote).some((mention) => mention.value === value);
}

interface QuantityMention {
  value: number | null;
  quote: string;
  numberStart: number;
  numberEnd: number;
  contextStart: number;
  quoteStart: number;
  quoteEnd: number;
}

function quantityMentions(rawText: string): QuantityMention[] {
  const mentions = new Map<string, QuantityMention>();
  const add = (
    number: { quote: string; start: number; end: number },
    contextStart: number,
    quoteStart: number,
    quoteEnd: number,
  ) => {
    const key = `${number.start}|${number.end}`;
    const existing = mentions.get(key);
    const start = Math.min(existing?.quoteStart ?? quoteStart, quoteStart);
    const end = Math.max(existing?.quoteEnd ?? quoteEnd, quoteEnd);
    mentions.set(key, {
      value: parseCompleteNumber(number.quote),
      quote: rawText.slice(start, end),
      numberStart: number.start,
      numberEnd: number.end,
      contextStart: Math.min(existing?.contextStart ?? contextStart, contextStart),
      quoteStart: start,
      quoteEnd: end,
    });
  };

  for (const marker of rawText.matchAll(new RegExp(QUANTITY_PREFIX_SOURCE, "giu"))) {
    const markerStart = marker.index ?? 0;
    const markerEnd = markerStart + marker[0].length;
    const number = numericCandidateAfter(rawText, markerEnd);
    if (number) add(number, markerStart, markerStart, number.end);
  }
  for (const unit of rawText.matchAll(new RegExp(QUANTITY_UNIT_SOURCE, "giu"))) {
    const unitStart = unit.index ?? 0;
    const unitEnd = unitStart + unit[0].length;
    const number = numericCandidateBefore(rawText, unitStart);
    if (number) add(
      { ...number, end: number.start + number.quote.length },
      number.start,
      number.start,
      unitEnd,
    );
  }
  return [...mentions.values()].filter((mention) =>
    !occurrenceIsNegated(rawText, mention.numberStart) &&
    !occurrenceIsNegated(rawText, mention.contextStart));
}

export function quantityAffirmedByEvidence(
  rawText: string,
  value: number,
  quote: string,
): boolean {
  return quantityMentions(rawText).some((mention) => {
    if (mention.value !== value) return false;
    let quoteStart = rawText.indexOf(quote);
    while (quoteStart >= 0) {
      if (
        mention.numberStart >= quoteStart &&
        mention.numberEnd <= quoteStart + quote.length &&
        contextualEvidenceState(
          rawText,
          quote,
          rawText.slice(mention.numberStart, mention.numberEnd),
        ) === "affirmed"
      ) return true;
      quoteStart = rawText.indexOf(quote, quoteStart + 1);
    }
    return false;
  });
}

function validUtcDate(year: number, month: number, day: number): string | null {
  const value = new Date(Date.UTC(year, month - 1, day));
  if (
    value.getUTCFullYear() !== year ||
    value.getUTCMonth() !== month - 1 ||
    value.getUTCDate() !== day
  ) return null;
  return value.toISOString();
}

function detectDeadline(
  rawText: string,
  evidence: CatalogTextEvidence[],
  ambiguities: CatalogExtractionAmbiguity[],
): string | null {
  const matches: Array<{ iso: string | null; quote: string }> = [];
  for (const match of rawText.matchAll(
    /\b(?:avant(?:\s+le)?|au\s+plus\s+tard(?:\s+le)?|jusqu['’]?au)\s+(\d{2})[/-](\d{2})[/-](\d{4})\b/giu,
  )) {
    matches.push({ iso: validUtcDate(Number(match[3]), Number(match[2]), Number(match[1])), quote: match[0] });
  }
  for (const match of rawText.matchAll(
    /\b(?:avant|au\s+plus\s+tard|jusqu['’]?au)\s+(\d{4})-(\d{2})-(\d{2})\b/giu,
  )) {
    matches.push({ iso: validUtcDate(Number(match[1]), Number(match[2]), Number(match[3])), quote: match[0] });
  }
  if (matches.some((match) => match.iso === null)) {
    ambiguities.push(ambiguity(
      "deadlineAt",
      "invalid_date",
      "Le délai contient une date invalide.",
      matches.filter((match) => match.iso === null).map((match) => match.quote),
    ));
    return null;
  }
  const values = [...new Set(matches.flatMap((match) => match.iso ? [match.iso] : []))];
  if (values.length > 1) {
    ambiguities.push(ambiguity(
      "deadlineAt",
      "multiple_values",
      "Plusieurs délais distincts sont mentionnés.",
      matches.map((match) => match.quote),
    ));
    return null;
  }
  if (values[0]) addEvidence(evidence, "deadlineAt", matches[0].quote);
  return values[0] ?? null;
}

function buildAttributes(
  rawText: string,
  parsed: ParsedNeed,
  type: CatalogExtractionInput["type"],
  evidence: CatalogTextEvidence[],
  ambiguities: CatalogExtractionAmbiguity[],
): ProposedAttribute[] | null {
  const attributes: ProposedAttribute[] = [];
  const numericIssues = extractMeasurementNumericIssues(rawText);
  const invalidKeys = new Set(numericIssues.map((issue) => issue.key));
  for (const key of invalidKeys) {
    ambiguities.push(ambiguity(
      "attributes",
      "invalid_numeric_measurement",
      `La valeur numérique de ${key} n'est pas prise en charge sans perte d'information.`,
      numericIssues.filter((issue) => issue.key === key).map((issue) => issue.quote),
    ));
  }
  const measurements = extractMeasurementOccurrences(rawText)
    .filter((item) => !occurrenceIsNegated(rawText, item.start))
    .filter((item) => !invalidKeys.has(item.key));
  for (const key of new Set(measurements.map((item) => item.key))) {
    const candidates = measurements.filter((item) => item.key === key);
    const values = new Set(candidates.map((item) => `${item.value}|${item.unit ?? ""}`));
    if (values.size > 1) {
      ambiguities.push(ambiguity(
        "attributes",
        key === "storage_capacity" ? "multiple_capacities" : "multiple_attribute_values",
        key === "storage_capacity"
          ? "Plusieurs capacités distinctes sont mentionnées."
          : `Plusieurs valeurs distinctes sont mentionnées pour ${key}.`,
        candidates.map((item) => item.quote),
      ));
      continue;
    }
    const measurement = candidates[0];
    const index = attributes.length;
    attributes.push({
      key: measurement.key,
      value: measurement.value,
      unit: measurement.unit,
      sourceUnit: measurement.sourceUnit,
    });
    addEvidence(evidence, `attributes.${index}`, measurement.quote);
  }
  if (type === "offer") {
    const offerFlags: Array<{ criterion: string; key: string; value: boolean }> = [
      { criterion: "avec chargeur", key: "charger_included", value: true },
      { criterion: "sans chargeur", key: "charger_included", value: false },
      { criterion: "troc possible", key: "barter_accepted", value: true },
      { criterion: "pas de troc", key: "barter_accepted", value: false },
      { criterion: "sans troc", key: "barter_accepted", value: false },
      { criterion: "garantie", key: "warranty_mentioned", value: true },
    ];
    const matchedFlags = offerFlags.flatMap((flag) => {
      if (!parsed.criteria.includes(flag.criterion)) return [];
      return findPhraseOccurrences(rawText, flag.criterion).map((flagOccurrence) => {
        const target = flag.key === "charger_included" ? "chargeur"
          : flag.key === "barter_accepted" ? "troc" : "garantie";
        const occurrence = findPhraseOccurrences(rawText, target).find((item) =>
          item.start >= flagOccurrence.start && item.end <= flagOccurrence.end) ?? flagOccurrence;
        const negated = occurrence ? occurrenceIsNegated(rawText, occurrence.start) : false;
        return {
          ...flag,
          value: negated ? false : flag.value,
          quote: occurrence ? contextualQuote(rawText, occurrence) : findPhrase(rawText, flag.criterion),
        };
      });
    });
    for (const key of new Set(matchedFlags.map((flag) => flag.key))) {
      const candidates = matchedFlags.filter((flag) => flag.key === key);
      if (new Set(candidates.map((flag) => flag.value)).size > 1) {
        ambiguities.push(ambiguity(
          "attributes",
          "contradictory_characteristic",
          "Une caractéristique d'offre est décrite de façon contradictoire.",
          candidates.map((flag) => flag.quote ?? flag.criterion),
        ));
        continue;
      }
      const flag = candidates[0];
      const index = attributes.length;
      attributes.push({ key: flag.key, value: flag.value, unit: null, sourceUnit: null });
      addEvidence(evidence, `attributes.${index}`, flag.quote);
    }
  }
  return attributes.length > 0 ? attributes : null;
}

function criterionKey(value: string): string {
  return accentNormalize(value).replace(/^(?:pas de|sans|avec)\s+/, "").replace(/[^a-z0-9]+/g, "_");
}

function buildDemandCriteria(
  rawText: string,
  parsed: ParsedNeed,
  evidence: CatalogTextEvidence[],
  ambiguities: CatalogExtractionAmbiguity[],
): { requirements: ProposedCriterion[] | null; preferences: ProposedCriterion[] | null } {
  const conditionCriteria = new Set(Object.keys(CONDITION_VALUES));
  const requirements: ProposedCriterion[] = [];
  const preferences: ProposedCriterion[] = [];
  const pending: Array<{
    field: "requirements" | "preferences";
    item: ProposedCriterion;
    quote: string;
  }> = [];
  for (const criterion of parsed.criteria) {
    if (conditionCriteria.has(criterion)) continue;
    for (const occurrence of findPhraseOccurrences(rawText, criterion)) {
      const quote = contextualQuote(rawText, occurrence);
      const negated = /^(?:pas de|sans)\s+/.test(criterion) || occurrenceIsNegated(rawText, occurrence.start);
      const value = criterion.replace(/^(?:pas de|sans|avec)\s+/, "");
      const before = accentNormalize(rawText.slice(Math.max(0, occurrence.start - 32), occurrence.start));
      const field = /(?:de preference|idealement|si possible|je prefere)\s*$/.test(before)
        ? "preferences" as const
        : "requirements" as const;
      pending.push({
        field,
        item: {
          key: criterionKey(criterion),
          operator: negated ? "excludes" : "includes",
          value,
        },
        quote,
      });
    }
  }
  const grouped = new Map<string, typeof pending>();
  for (const candidate of pending) {
    const key = `${candidate.field}|${candidate.item.key}`;
    grouped.set(key, [...(grouped.get(key) ?? []), candidate]);
  }
  for (const candidates of grouped.values()) {
    const operators = new Set(candidates.map((candidate) => candidate.item.operator));
    if (operators.size > 1) {
      ambiguities.push(ambiguity(
        candidates[0].field,
        "contradictory_criterion",
        "Un critère est à la fois inclus et exclu.",
        candidates.map((candidate) => candidate.quote),
      ));
      continue;
    }
    const candidate = candidates[0];
    const target = candidate.field === "preferences" ? preferences : requirements;
    const index = target.length;
    target.push(candidate.item);
    addEvidence(evidence, `${candidate.field}.${index}`, candidate.quote);
  }
  return {
    requirements: requirements.length > 0 ? requirements : null,
    preferences: preferences.length > 0 ? preferences : null,
  };
}

interface MoneyCandidate {
  money: ProposedMoney;
  quote: string;
  numericQuote: string;
  start: number;
  end: number;
}

function moneyCandidates(rawText: string): MoneyCandidate[] {
  const found = new Map<string, MoneyCandidate>();
  const measurements = extractMeasurementOccurrences(rawText);
  const numericCandidates = rawText.matchAll(
    /(?<![\p{L}\p{N}.,+\-])[+-]?(?:\d{1,3}(?:[ \u00a0.,]\d{3})+|\d{4,9}|\d{1,4}(?:[.,]\d{1,2})?\s*(?:k|mille|millions?)|\d{1,3}(?:[.,]\d{1,2})?)(?![\p{L}\p{N}.,])/giu,
  );
  for (const match of numericCandidates) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if (match[0].trimStart().startsWith("-")) continue;
    if (measurements.some((measurement) => start >= measurement.start && end <= measurement.end)) {
      continue;
    }
    const before = rawText.slice(Math.max(0, start - 32), start);
    const after = rawText.slice(end, Math.min(rawText.length, end + 24));
    if (/\d{2}[/-]\d{2}[/-]\s*$/.test(before) || /^\s*[/-]\d{2}[/-]\d{4}\b/.test(after)) {
      continue;
    }
    if (/\b(?:mod[eè]le|ann[eé]e|version|quantit[eé]|lot\s+de)\s*[:#=-]?\s*$/i.test(before)) {
      continue;
    }
    // Une capacité, puissance ou quantité explicite n'est jamais un montant.
    if (/^\s*(?:gigas?|go|gb|to|tb|pouces?|po|pointure|taille|btu|cv|ch|watts?|w|litres?|l|m|cm|kg|kilos?|places?|unit[eé]s?|pi[eè]ces?|articles?|exemplaires?)\b/i.test(after)) {
      continue;
    }
    const prefixCurrency = before.match(/(?:^|[\s:,(])((?:(?:f[.\s]?cfa|fcfa|cfa|xof|francs?|frs|usd|eur)\b|[€$]))\s*$/i)?.[1] ?? "";
    const suffixCurrency = after.match(/^\s*(?:(?:f[.\s]?cfa|fcfa|cfa|xof|francs?|frs|usd|eur)\b|[€$])/i)?.[0] ?? "";
    const marker = before.match(/(?:prix|budget|max(?:imum)?|moins de|au plus|jusqu['’]?a)\s*[:=]?\s*$/i)?.[0] ?? "";
    const candidateText = `${prefixCurrency || marker}${match[0]}${suffixCurrency}`.trim();
    const parsedPrice = parsePrice(candidateText);
    const parsedBudget = parseNeed(`budget ${match[0]}${suffixCurrency}`).budget;
    const parsed = parsedPrice.amount !== null
      ? {
          amount: parsedPrice.amount,
          currency: parsedPrice.currency === "unknown" ? null : parsedPrice.currency,
        }
      : parsedBudget
        ? { amount: parsedBudget.amount, currency: parsedBudget.currency }
        : null;
    if (!parsed || !Number.isSafeInteger(parsed.amount)) continue;
    if (parsed.amount < 10_000 && !prefixCurrency && !suffixCurrency && !marker) continue;
    const quoteStart = prefixCurrency || marker ? start - (prefixCurrency || marker).length : start;
    const quoteEnd = end + suffixCurrency.length;
    const boundedStart = Math.max(0, quoteStart);
    const untrimmedQuote = rawText.slice(boundedStart, Math.min(rawText.length, quoteEnd));
    const quote = untrimmedQuote.trim();
    const candidateStart = boundedStart + (untrimmedQuote.length - untrimmedQuote.trimStart().length);
    if (occurrenceIsNegated(rawText, start) || occurrenceIsNegated(rawText, candidateStart)) continue;
    const numericEnd = end + suffixCurrency.length;
    found.set(`${parsed.amount}|${parsed.currency ?? ""}|${candidateStart}`, {
      money: parsed,
      quote: exactFragment(rawText, quote),
      numericQuote: rawText.slice(start, numericEnd).trim(),
      start,
      end: numericEnd,
    });
  }
  return [...found.values()];
}

function parsedMoneyNumber(raw: string): number | null {
  const abbreviated = raw.trim().match(/^(.*?)(k|mille|millions?)$/i);
  if (!abbreviated) return parseCompleteNumber(raw.trim());
  const base = parseCompleteNumber(abbreviated[1].trim());
  if (base === null) return null;
  return base * (abbreviated[2].toLowerCase().startsWith("million") ? 1_000_000 : 1_000);
}

function invalidMoneyFragments(rawText: string): string[] {
  const invalid: string[] = [];
  const currencyPattern = /(?:(?:f[.\s]?cfa|fcfa|cfa|xof|francs?|frs|usd|eur)\b|[€$])/giu;
  for (const currency of rawText.matchAll(currencyPattern)) {
    const start = currency.index ?? 0;
    const candidate = numericCandidateBefore(rawText, start);
    if (!candidate) continue;
    const amount = parsedMoneyNumber(candidate.quote);
    if (amount === null || !Number.isSafeInteger(amount) || amount <= 0) {
      invalid.push(rawText.slice(candidate.start, start + currency[0].length).trim());
    }
  }
  for (const marker of rawText.matchAll(/(?:prix|budget|max(?:imum)?|moins de|au plus|jusqu['’]?a)\s*[:=]?\s*([^\s;:()]*\d[^\s;:()]*)/giu)) {
    const amount = parsedMoneyNumber(marker[1]);
    if (amount === null || !Number.isSafeInteger(amount) || amount <= 0) invalid.push(marker[0]);
  }
  return [...new Set(invalid)];
}

export function moneySupportedByEvidence(money: ProposedMoney, quote: string): boolean {
  return moneyCandidates(quote).some((candidate) =>
    candidate.money.amount === money.amount && candidate.money.currency === money.currency);
}

export function moneyAffirmedByEvidence(
  rawText: string,
  money: ProposedMoney,
  quote: string,
): boolean {
  return moneyCandidates(rawText).some((candidate) => {
    if (candidate.money.amount !== money.amount || candidate.money.currency !== money.currency) return false;
    let quoteStart = rawText.indexOf(quote);
    while (quoteStart >= 0) {
      if (
        candidate.start >= quoteStart &&
        candidate.end <= quoteStart + quote.length &&
        contextualEvidenceState(rawText, quote, candidate.numericQuote) === "affirmed"
      ) return true;
      quoteStart = rawText.indexOf(quote, quoteStart + 1);
    }
    return false;
  });
}

function detectMoney(
  type: CatalogExtractionInput["type"],
  rawText: string,
  evidence: CatalogTextEvidence[],
  ambiguities: CatalogExtractionAmbiguity[],
): ProposedMoney | null {
  const field = type === "offer" ? "price" : "budget";
  const numericIssues = invalidMoneyFragments(rawText);
  if (numericIssues.length > 0) {
    ambiguities.push(ambiguity(
      field,
      "invalid_numeric_amount",
      "Le format ou le signe du montant n'est pas pris en charge.",
      numericIssues,
    ));
    return null;
  }
  const candidates = moneyCandidates(rawText);
  const distinct = new Map(candidates.map((candidate) => [
    `${candidate.money.amount}|${candidate.money.currency ?? ""}`,
    candidate,
  ]));
  if (distinct.size > 1) {
    ambiguities.push(ambiguity(
      field,
      "multiple_amounts",
      "Plusieurs montants distincts sont mentionnés sans choix certain.",
      candidates.map((candidate) => candidate.quote),
    ));
    return null;
  }
  const candidate = distinct.values().next().value as MoneyCandidate | undefined;
  if (!candidate) return null;
  addEvidence(evidence, field, candidate.quote);
  if (candidate.money.currency === null) {
    ambiguities.push(ambiguity(
      field,
      "currency_missing",
      "Le montant est explicite mais sa devise est inconnue.",
      [candidate.quote],
    ));
  }
  return candidate.money;
}

export function deterministicCatalogExtraction(
  input: CatalogExtractionInput,
): CatalogExtractionProposal {
  const parsed = parseNeed(input.rawText);
  const evidence: CatalogTextEvidence[] = [];
  const ambiguities: CatalogExtractionAmbiguity[] = [];
  const category = parsed.kind === "service"
    ? "services"
    : detectMappedValue(input.rawText, "category", CATEGORY_RULES, evidence, ambiguities);
  if (parsed.kind === "service") {
    addEvidence(evidence, "category", findPhrase(input.rawText, parsed.product));
  }
  const brand = detectMappedValue(input.rawText, "brand", BRAND_RULES, evidence, ambiguities);
  const { model, variant } = detectModel(input.rawText, evidence, ambiguities);
  const condition = detectCondition(input.rawText, parsed, evidence, ambiguities);
  const quantity = detectQuantity(input.rawText, evidence, ambiguities);
  const deadlineAt = detectDeadline(input.rawText, evidence, ambiguities);
  if (parsed.zone) {
    const locationEvidence = findPhrase(input.rawText, parsed.zone) ?? (
      parsed.zone === "yopougon" ? findPhrase(input.rawText, "yop") : null
    );
    addEvidence(evidence, "location", locationEvidence);
  }
  const common: CatalogProposedCommonFields = {
    category,
    brand,
    model,
    variant,
    attributes: buildAttributes(input.rawText, parsed, input.type, evidence, ambiguities),
    condition,
    quantity,
    location: parsed.zone,
    deadlineAt,
  };
  const base = {
    contractVersion: CATALOG_EXTRACTION_CONTRACT_VERSION,
    extractorVersion: DETERMINISTIC_EXTRACTOR_VERSION,
    provenance: "deterministic" as const,
    rawText: input.rawText,
    evidence,
    ambiguities,
  };
  if (input.type === "offer") {
    const fields: CatalogOfferProposedFields = {
      ...common,
      price: detectMoney(input.type, input.rawText, evidence, ambiguities),
    };
    return { ...base, type: "offer", fields };
  }
  const criteria = buildDemandCriteria(input.rawText, parsed, evidence, ambiguities);
  const fields: CatalogDemandProposedFields = {
    ...common,
    budget: detectMoney(input.type, input.rawText, evidence, ambiguities),
    ...criteria,
  };
  return { ...base, type: "demand", fields };
}
