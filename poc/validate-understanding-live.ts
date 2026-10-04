/**
 * Validation réelle, peu coûteuse, de la compréhension d'un besoin.
 * Uniquement OpenRouter : aucun connecteur, navigateur ou scraping.
 */
import { parseNeed, accentNormalize } from "./lib/need";
import { makeNeedUnderstander, semanticTokens } from "./lib/understanding";
import { runWithCtx, totalCost, tokenTotals, type RunCtx } from "./lib/log";

interface LiveCase {
  id: string;
  text: string;
  clarificationAnswer?: string;
  expectClarification: boolean;
  canonicalAny: string[];
  exclusionAny?: string[];
  budget?: number;
  zone?: string;
  kind?: "produit" | "service";
}

const cases: LiveCase[] = [
  {
    id: "tv-local",
    text: "Je veux une télé 55 pouces à Yop, budget 180k",
    expectClarification: false,
    canonicalAny: ["tele", "tv"],
    budget: 180_000,
    zone: "yopougon",
  },
  {
    id: "frigo-exclusion",
    text: "Je cherche un frigo 300 litres sans congélateur à Cocody",
    expectClarification: false,
    canonicalAny: ["frigo", "refrigerateur"],
    exclusionAny: ["congelateur"],
    zone: "cocody",
  },
  {
    id: "chargeur-exclusion",
    text: "Chargeur type C 20 watts à Abidjan, pas solaire",
    expectClarification: false,
    canonicalAny: ["chargeur"],
    exclusionAny: ["solaire"],
    zone: "abidjan",
  },
  {
    id: "console-ambigu",
    text: "Je cherche une console à Abidjan 150 000",
    expectClarification: true,
    canonicalAny: ["console"],
    budget: 150_000,
    zone: "abidjan",
  },
  {
    id: "console-choix",
    text: "Je cherche une console à Abidjan 150 000",
    clarificationAnswer: "Console de jeux",
    expectClarification: false,
    canonicalAny: ["console de jeux"],
    budget: 150_000,
    zone: "abidjan",
  },
  {
    id: "chaussures-authenticite",
    text: "Je veux des baskets Nike pointure 42, pas de contrefaçon, max 35k",
    expectClarification: false,
    canonicalAny: ["basket", "chaussure", "sneaker"],
    exclusionAny: ["contrefacon"],
    budget: 35_000,
  },
  {
    id: "service-clim",
    text: "Je cherche quelqu'un pour réparer mon climatiseur à Marcory aujourd'hui",
    expectClarification: false,
    canonicalAny: ["reparation", "reparer", "climatiseur", "climatisation"],
    zone: "marcory",
    kind: "service",
  },
  {
    id: "table-budget-local",
    text: "Je voudrais une table pour manger, 6 places, solide, vers Angré, moins de 100 mille francs",
    expectClarification: false,
    canonicalAny: ["table"],
    budget: 100_000,
    zone: "angre",
  },
];

const includesAny = (value: string, expected: string[]): boolean => {
  const normalized = accentNormalize(value);
  return expected.some((item) => normalized.includes(accentNormalize(item)));
};

const criteriaAreGrounded = (
  text: string,
  answer: string | undefined,
  criteria: { value: string; evidence: string }[],
): boolean => {
  const source = accentNormalize(`${text} ${answer ?? ""}`);
  return criteria.every((criterion) => {
    const evidence = accentNormalize(criterion.evidence);
    const evidenceTokens = new Set(semanticTokens(criterion.evidence));
    return source.includes(evidence) && semanticTokens(criterion.value).every((token) => evidenceTokens.has(token));
  });
};

const selectedCases = process.env.NOMA_UNDERSTANDING_ONLY
  ? cases.filter((item) => item.id === process.env.NOMA_UNDERSTANDING_ONLY)
  : cases;
const debug = process.env.NOMA_UNDERSTANDING_DEBUG === "1";

const ctx: RunCtx = {
  log: debug ? console.log : () => {},
  entries: [],
  maxCostUsd: 0.02,
  aiEnabled: true,
  cache: { hits: 0, misses: 0, writes: 0, skipped: 0, bySource: {} },
};

const understand = makeNeedUnderstander();
const results: Record<string, unknown>[] = [];

await runWithCtx(ctx, async () => {
  for (const item of selectedCases) {
    const need = parseNeed(item.text);
    const understanding = await understand(
      need,
      AbortSignal.timeout(40_000),
      item.clarificationAnswer,
    );
    const criteria = [
      ...understanding.requirements,
      ...understanding.preferences,
      ...understanding.exclusions,
    ];
    const checks = {
      source: understanding.source === "ai",
      canonical: includesAny(understanding.canonicalProduct, item.canonicalAny),
      clarification: Boolean(understanding.clarification) === item.expectClarification,
      grounded: criteriaAreGrounded(item.text, item.clarificationAnswer, criteria),
      exclusion: item.exclusionAny
        ? understanding.exclusions.some((criterion) => includesAny(criterion.value, item.exclusionAny!))
        : true,
      budget: item.budget === undefined || need.budget?.amount === item.budget,
      zone: item.zone === undefined || need.zone === item.zone,
      kind: item.kind === undefined || need.kind === item.kind,
    };
    results.push({
      id: item.id,
      ok: Object.values(checks).every(Boolean),
      checks,
      parsed: {
        kind: need.kind,
        product: need.product,
        budget: need.budget?.amount ?? null,
        zone: need.zone,
        attributes: need.attributes,
      },
      understanding,
    });
  }
});

const cost = totalCost(ctx.entries);
console.log(JSON.stringify({
  passed: results.filter((result) => result.ok === true).length,
  total: results.length,
  results,
  usage: {
    calls: ctx.entries.length,
    costUsd: cost.total,
    costKnown: cost.known,
    tokens: tokenTotals(ctx.entries),
  },
}, null, 2));
