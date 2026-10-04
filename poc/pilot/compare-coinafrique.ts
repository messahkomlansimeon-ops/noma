import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { RawListing } from "../lib/normalize";
import { extractCoinAfriqueCheerio } from "../sources/coinafrique-parser";
import { extractCoinAfriqueScrapling } from "./scrapling-bridge";

const WARMUPS = 5;
const MEASUREMENTS = 30;
const MAX_OVERHEAD_P95_MS = 500;
const MAX_SCRAPLING_RSS_BYTES = 128 * 1024 * 1024;

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(here, "../..");
const fixturesDir = join(projectRoot, "poc", "tests", "fixtures", "coinafrique");
const outputDir = join(projectRoot, "poc", "results", "scrapling-pilot");
const pythonPath = join(projectRoot, ".venv-scrapling", "bin", "python");

const CorpusSchema = z.object({
  baseUrl: z.string().url(),
  cases: z.array(
    z.object({
      id: z.string(),
      html: z.string(),
      expected: z.string(),
      adaptiveTrain: z.string(),
    }),
  ),
});

interface Accuracy {
  expected: number;
  actual: number;
  matched: number;
  missed: number;
  falsePositives: number;
  precision: number;
  recall: number;
}

interface ExtractorResult extends Accuracy {
  extractor: "cheerio" | "scrapling-standard" | "scrapling-adaptive";
  latencyMs: { median: number; p95: number };
  maxRssBytes: number;
  maxNetworkAttempts: number;
  nondeterministicRuns: number;
  errors: string[];
}

const listingKey = (listing: RawListing): string =>
  JSON.stringify([
    listing.id,
    listing.source,
    listing.title,
    listing.price,
    listing.currency,
    listing.zone,
    listing.vendor,
    listing.url,
    listing.photo,
    listing.date,
    listing.description,
  ]);

function accuracy(expected: RawListing[], actual: RawListing[]): Accuracy {
  const remaining = new Map<string, number>();
  for (const listing of expected) {
    const key = listingKey(listing);
    remaining.set(key, (remaining.get(key) ?? 0) + 1);
  }
  let matched = 0;
  for (const listing of actual) {
    const key = listingKey(listing);
    const count = remaining.get(key) ?? 0;
    if (count > 0) {
      matched++;
      remaining.set(key, count - 1);
    }
  }
  const missed = expected.length - matched;
  const falsePositives = actual.length - matched;
  return {
    expected: expected.length,
    actual: actual.length,
    matched,
    missed,
    falsePositives,
    precision: actual.length === 0 ? (expected.length === 0 ? 1 : 0) : matched / actual.length,
    recall: expected.length === 0 ? 1 : matched / expected.length,
  };
}

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
}

async function main() {
  const corpus = CorpusSchema.parse(
    JSON.parse(readFileSync(join(fixturesDir, "corpus.json"), "utf8")),
  );
  const scratch = mkdtempSync(join(tmpdir(), "noma-scrapling-benchmark-"));
  const cases: { id: string; results: ExtractorResult[] }[] = [];

  try {
    for (const corpusCase of corpus.cases) {
      const html = readFileSync(join(fixturesDir, corpusCase.html), "utf8");
      const expected = JSON.parse(
        readFileSync(join(fixturesDir, corpusCase.expected), "utf8"),
      ) as { listings: RawListing[]; errors: string[] };
      const storagePath = join(scratch, `${corpusCase.id}.sqlite`);
      const trainHtml = readFileSync(join(fixturesDir, corpusCase.adaptiveTrain), "utf8");

      await extractCoinAfriqueScrapling(
        { html: trainHtml, baseUrl: corpus.baseUrl },
        { mode: "adaptive-train", storagePath },
      );

      const configurations = [
        {
          extractor: "cheerio" as const,
          run: async () => {
            const rssBefore = process.memoryUsage().rss;
            const started = performance.now();
            const result = await extractCoinAfriqueCheerio({ html, baseUrl: corpus.baseUrl });
            return {
              ...result,
              wallMs: performance.now() - started,
              rssBytes: Math.max(0, process.memoryUsage().rss - rssBefore),
              networkAttempts: 0,
            };
          },
        },
        {
          extractor: "scrapling-standard" as const,
          run: async () => {
            const result = await extractCoinAfriqueScrapling({ html, baseUrl: corpus.baseUrl });
            return {
              ...result,
              wallMs: result.metrics.wallMs,
              rssBytes: result.metrics.rssBytes,
              networkAttempts: result.metrics.networkAttempts,
            };
          },
        },
        {
          extractor: "scrapling-adaptive" as const,
          run: async () => {
            const result = await extractCoinAfriqueScrapling(
              { html, baseUrl: corpus.baseUrl },
              { mode: "adaptive", storagePath },
            );
            return {
              ...result,
              wallMs: result.metrics.wallMs,
              rssBytes: result.metrics.rssBytes,
              networkAttempts: result.metrics.networkAttempts,
            };
          },
        },
      ];

      const results: ExtractorResult[] = [];
      for (const configuration of configurations) {
        for (let i = 0; i < WARMUPS; i++) await configuration.run();

        const latencies: number[] = [];
        const rssValues: number[] = [];
        const networkAttempts: number[] = [];
        let reference: RawListing[] | null = null;
        let nondeterministicRuns = 0;
        let errors: string[] = [];
        for (let i = 0; i < MEASUREMENTS; i++) {
          const result = await configuration.run();
          latencies.push(result.wallMs);
          rssValues.push(result.rssBytes);
          networkAttempts.push(result.networkAttempts);
          errors = result.errors;
          if (reference === null) reference = result.listings;
          else if (JSON.stringify(reference) !== JSON.stringify(result.listings)) {
            nondeterministicRuns++;
          }
        }
        const actual = reference ?? [];
        results.push({
          extractor: configuration.extractor,
          ...accuracy(expected.listings, actual),
          latencyMs: {
            median: percentile(latencies, 0.5),
            p95: percentile(latencies, 0.95),
          },
          maxRssBytes: Math.max(...rssValues, 0),
          maxNetworkAttempts: Math.max(...networkAttempts, 0),
          nondeterministicRuns,
          errors,
        });
      }
      cases.push({ id: corpusCase.id, results });
      console.log(`✓ ${corpusCase.id}`);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  const allResults = cases.flatMap((entry) => entry.results);
  const nominal = cases.find((entry) => entry.id === "nominal")!;
  const changed = cases.find((entry) => entry.id === "adaptive-structure-change")!;
  const standardNominal = nominal.results.find(
    (entry) => entry.extractor === "scrapling-standard",
  )!;
  const cheerioChanged = changed.results.find((entry) => entry.extractor === "cheerio")!;
  const adaptiveChanged = changed.results.find(
    (entry) => entry.extractor === "scrapling-adaptive",
  )!;
  const pythonResults = allResults.filter((entry) => entry.extractor !== "cheerio");
  const maxP95Overhead = Math.max(
    ...cases.flatMap((entry) => {
      const cheerio = entry.results.find((result) => result.extractor === "cheerio")!;
      return entry.results
        .filter((result) => result.extractor !== "cheerio")
        .map((result) => result.latencyMs.p95 - cheerio.latencyMs.p95);
    }),
  );
  const maxPythonRss = Math.max(...pythonResults.map((entry) => entry.maxRssBytes));
  const checks = {
    nominalParity:
      standardNominal.missed === 0 && standardNominal.falsePositives === 0,
    adaptiveGain:
      cheerioChanged.recall === 0 &&
      adaptiveChanged.recall === 1 &&
      adaptiveChanged.falsePositives === 0,
    noFalseListings: pythonResults.every((entry) => entry.falsePositives === 0),
    deterministic: pythonResults.every((entry) => entry.nondeterministicRuns === 0),
    offline: pythonResults.every((entry) => entry.maxNetworkAttempts === 0),
    latencyBudget: maxP95Overhead <= MAX_OVERHEAD_P95_MS,
    memoryBudget: maxPythonRss <= MAX_SCRAPLING_RSS_BYTES,
  };
  const passed = Object.values(checks).every(Boolean);
  const report = {
    generatedAt: new Date().toISOString(),
    configuration: {
      warmups: WARMUPS,
      measurements: MEASUREMENTS,
      maxOverheadP95Ms: MAX_OVERHEAD_P95_MS,
      maxScraplingRssBytes: MAX_SCRAPLING_RSS_BYTES,
    },
    versions: {
      node: process.version,
      python: execFileSync(pythonPath, ["--version"], { encoding: "utf8" }).trim(),
      scrapling: "0.4.15",
    },
    cases,
    summary: { maxP95Overhead, maxPythonRss, checks },
    verdict: passed
      ? "CANDIDAT_ESSAI_REEL — garder Cheerio actif en production"
      : "CONSERVER_CHEERIO — gain ou budgets non démontrés",
  };

  mkdirSync(outputDir, { recursive: true });
  const output = join(outputDir, "benchmark.json");
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\n${report.verdict}`);
  console.log(`Rapport JSON : ${output}`);
}

await main();
