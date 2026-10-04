import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { safeFetch, SafeFetchError } from "../lib/fetch";
import { extractCoinAfriqueCheerio } from "../sources/coinafrique-parser";
import { extractCoinAfriqueScrapling, type ScraplingExtraction } from "./scrapling-bridge";
import type { RawListing } from "../lib/normalize";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(here, "../..");
const outputDir = join(projectRoot, "poc", "results", "scrapling-real-trial");
const pythonPath = join(projectRoot, ".venv-scrapling", "bin", "python");

export const MAX_TRIAL_DOWNLOADS = 3;
export const MAX_OVERHEAD_MS = 500;
export const MAX_SCRAPLING_RSS_BYTES = 128 * 1024 * 1024; // 128 Mio

export interface ListingDifference {
  index: number;
  listingId: string;
  field: keyof RawListing | "extra" | "missing";
  cheerioValue?: unknown;
  scraplingValue?: unknown;
}

export interface CaseComparison {
  isIdentical: boolean;
  differences: ListingDifference[];
  cheerioCount: number;
  scraplingCount: number;
  errorsIdentical: boolean;
  cheerioErrors: string[];
  scraplingErrors: string[];
}

export function createDownloadLimiter(maxDownloads = MAX_TRIAL_DOWNLOADS) {
  let count = 0;
  return {
    getCount: () => count,
    fetch: async <T>(fn: () => Promise<T>): Promise<T> => {
      if (count >= maxDownloads) {
        throw new Error(`Plafond strict de téléchargements atteint (${maxDownloads})`);
      }
      count++;
      return fn();
    },
  };
}

export function compareListings(
  cheerioListings: RawListing[],
  scraplingListings: RawListing[],
): { isIdentical: boolean; differences: ListingDifference[] } {
  const differences: ListingDifference[] = [];
  const maxLen = Math.max(cheerioListings.length, scraplingListings.length);
  const fields: (keyof RawListing)[] = [
    "id",
    "source",
    "title",
    "price",
    "currency",
    "zone",
    "vendor",
    "url",
    "photo",
    "date",
    "description",
  ];

  for (let i = 0; i < maxLen; i++) {
    const c = cheerioListings[i];
    const s = scraplingListings[i];
    if (!c && s) {
      differences.push({
        index: i,
        listingId: s.id,
        field: "extra",
        scraplingValue: s,
      });
      continue;
    }
    if (c && !s) {
      differences.push({
        index: i,
        listingId: c.id,
        field: "missing",
        cheerioValue: c,
      });
      continue;
    }
    if (c && s) {
      for (const field of fields) {
        if (c[field] !== s[field]) {
          differences.push({
            index: i,
            listingId: c.id,
            field,
            cheerioValue: c[field],
            scraplingValue: s[field],
          });
        }
      }
    }
  }

  return {
    isIdentical: differences.length === 0,
    differences,
  };
}

export function compareErrors(
  cheerioErrors: string[],
  scraplingErrors: string[],
): { isIdentical: boolean; differences: string[] } {
  const cSet = new Set(cheerioErrors);
  const sSet = new Set(scraplingErrors);
  const diffs: string[] = [];

  for (const err of cheerioErrors) {
    if (!sSet.has(err)) diffs.push(`Erreur Cheerio manquante dans Scrapling: ${err}`);
  }
  for (const err of scraplingErrors) {
    if (!cSet.has(err)) diffs.push(`Erreur Scrapling supplémentaire: ${err}`);
  }

  return {
    isIdentical: diffs.length === 0 && cheerioErrors.length === scraplingErrors.length,
    differences: diffs,
  };
}

export interface TrialCaseResult {
  id: string;
  label: string;
  url: string;
  httpStatus: number;
  bytes: number;
  cheerioDurationMs: number;
  scraplingDurationMs: number;
  scraplingWallMs: number;
  scraplingRssBytes: number;
  scraplingNetworkAttempts: number;
  overheadMs: number;
  comparison: CaseComparison;
}

export interface TrialReport {
  generatedAt: string;
  configuration: {
    maxDownloads: number;
    maxOverheadMs: number;
    maxRssBytes: number;
  };
  versions: {
    node: string;
    python: string;
    scrapling: string;
  };
  downloadsExecuted: number;
  cases: TrialCaseResult[];
  checks: {
    exactParity: boolean;
    noFalseListings: boolean;
    zeroNetworkAttempts: boolean;
    latencyBudget: boolean;
    memoryBudget: boolean;
    noBlockOrCaptcha: boolean;
  };
  verdict: "GO_LIMITE" | "NO_GO" | "ARRET_BLOCAGE";
  verdictDetail: string;
}

export function detectPythonVersion(runVersion?: () => string): string {
  if (!runVersion && !existsSync(pythonPath)) return "indisponible";

  try {
    const version = (runVersion
      ? runVersion()
      : execFileSync(pythonPath, ["--version"], { encoding: "utf8" })
    ).trim();
    return version || "indisponible";
  } catch (error) {
    const stdout = (error as { stdout?: unknown }).stdout;
    const recovered =
      typeof stdout === "string"
        ? stdout.trim()
        : Buffer.isBuffer(stdout)
          ? stdout.toString("utf8").trim()
          : "";
    return recovered || "indisponible";
  }
}

export function evaluateTrial(
  cases: TrialCaseResult[],
  downloadsExecuted: number,
  blockedError?: { code: string; message: string },
): TrialReport {
  const pythonVersion = detectPythonVersion();

  if (blockedError) {
    return {
      generatedAt: new Date().toISOString(),
      configuration: {
        maxDownloads: MAX_TRIAL_DOWNLOADS,
        maxOverheadMs: MAX_OVERHEAD_MS,
        maxRssBytes: MAX_SCRAPLING_RSS_BYTES,
      },
      versions: {
        node: process.version,
        python: pythonVersion,
        scrapling: "0.4.15",
      },
      downloadsExecuted,
      cases,
      checks: {
        exactParity: false,
        noFalseListings: false,
        zeroNetworkAttempts: true,
        latencyBudget: false,
        memoryBudget: false,
        noBlockOrCaptcha: false,
      },
      verdict: "ARRET_BLOCAGE",
      verdictDetail: `Arrêt sur blocage détecté (${blockedError.code}: ${blockedError.message})`,
    };
  }

  const exactParity = cases.every(
    (c) => c.comparison.isIdentical && c.comparison.errorsIdentical,
  );
  const noFalseListings = cases.every((c) =>
    c.comparison.differences.every((d) => d.field !== "extra"),
  );
  const zeroNetworkAttempts = cases.every((c) => c.scraplingNetworkAttempts === 0);
  const latencyBudget = cases.every((c) => c.overheadMs <= MAX_OVERHEAD_MS);
  const memoryBudget = cases.every((c) => c.scraplingRssBytes <= MAX_SCRAPLING_RSS_BYTES);
  const noBlockOrCaptcha = cases.every((c) => c.httpStatus === 200);

  const checks = {
    exactParity,
    noFalseListings,
    zeroNetworkAttempts,
    latencyBudget,
    memoryBudget,
    noBlockOrCaptcha,
  };

  const isGo = Object.values(checks).every(Boolean);
  const verdict: "GO_LIMITE" | "NO_GO" = isGo ? "GO_LIMITE" : "NO_GO";
  const verdictDetail = isGo
    ? "Parité exacte et budgets respectés sur les 3 pages réelles. Conserver Cheerio actif en production."
    : `Échec des critères de validation (${Object.entries(checks)
        .filter(([, v]) => !v)
        .map(([k]) => k)
        .join(", ")}).`;

  return {
    generatedAt: new Date().toISOString(),
    configuration: {
      maxDownloads: MAX_TRIAL_DOWNLOADS,
      maxOverheadMs: MAX_OVERHEAD_MS,
      maxRssBytes: MAX_SCRAPLING_RSS_BYTES,
    },
    versions: {
      node: process.version,
      python: pythonVersion,
      scrapling: "0.4.15",
    },
    downloadsExecuted,
    cases,
    checks,
    verdict,
    verdictDetail,
  };
}

export async function runTrial(): Promise<TrialReport> {
  const limiter = createDownloadLimiter(MAX_TRIAL_DOWNLOADS);

  const targetPages = [
    {
      id: "iphone",
      label: "Recherche normale avec annonces (iPhone)",
      url: "https://ci.coinafrique.com/search?keyword=iphone",
    },
    {
      id: "climatiseur",
      label: "Autre catégorie avec annonces (Climatiseur)",
      url: "https://ci.coinafrique.com/search?keyword=climatiseur",
    },
    {
      id: "introuvable",
      label: "Recherche vide ou rare",
      url: "https://ci.coinafrique.com/search?keyword=introuvable999xyztest",
    },
  ];

  const results: TrialCaseResult[] = [];
  let blockedError: { code: string; message: string } | undefined;

  for (const page of targetPages) {
    console.log(`\n[${results.length + 1}/${targetPages.length}] Téléchargement : ${page.label}`);
    console.log(`URL : ${page.url}`);

    let fetchResult: { status: number; body: string; finalUrl: string; bytes: number };
    try {
      fetchResult = await limiter.fetch(() =>
        safeFetch(page.url, {
          headers: { "Accept-Language": "fr-FR,fr;q=0.9" },
        }),
      );
    } catch (e) {
      const err = e as SafeFetchError;
      console.error(`Erreur HTTP/Réseau : ${err.message}`);
      if (err instanceof SafeFetchError && (err.kind === "blocked" || err.status === 403 || err.status === 429)) {
        blockedError = { code: `${err.status ?? err.kind}`, message: err.message };
        break;
      }
      throw e;
    }

    console.log(`Réponse HTTP ${fetchResult.status} (${fetchResult.bytes} octets)`);

    // 1. Extraction Cheerio
    const t0Cheerio = performance.now();
    const cheerioResult = await extractCoinAfriqueCheerio({
      html: fetchResult.body,
      baseUrl: fetchResult.finalUrl,
    });
    const cheerioDurationMs = performance.now() - t0Cheerio;

    // 2. Extraction Scrapling standard sur le MÊME HTML
    const t0Scrapling = performance.now();
    let scraplingResult: ScraplingExtraction;
    try {
      scraplingResult = await extractCoinAfriqueScrapling(
        {
          html: fetchResult.body,
          baseUrl: fetchResult.finalUrl,
        },
        { mode: "standard" },
      );
    } catch (e) {
      console.error(`Erreur Scrapling : ${(e as Error).message}`);
      throw e;
    }
    const scraplingDurationMs = performance.now() - t0Scrapling;

    // 3. Comparaison champ par champ
    const listingComp = compareListings(cheerioResult.listings, scraplingResult.listings);
    const errorComp = compareErrors(cheerioResult.errors, scraplingResult.errors);

    const comparison: CaseComparison = {
      isIdentical: listingComp.isIdentical,
      differences: listingComp.differences,
      cheerioCount: cheerioResult.listings.length,
      scraplingCount: scraplingResult.listings.length,
      errorsIdentical: errorComp.isIdentical,
      cheerioErrors: cheerioResult.errors,
      scraplingErrors: scraplingResult.errors,
    };

    const overheadMs = scraplingDurationMs - cheerioDurationMs;

    console.log(`- Annonces : Cheerio = ${comparison.cheerioCount}, Scrapling = ${comparison.scraplingCount}`);
    console.log(`- Durée : Cheerio = ${cheerioDurationMs.toFixed(1)} ms, Scrapling = ${scraplingDurationMs.toFixed(1)} ms (surcoût: ${overheadMs.toFixed(1)} ms)`);
    console.log(`- Scrapling RSS : ${(scraplingResult.metrics.rssBytes / (1024 * 1024)).toFixed(1)} Mo`);
    console.log(`- networkAttempts : ${scraplingResult.metrics.networkAttempts}`);
    console.log(`- Différences : ${listingComp.differences.length} champ(s) divergent(s)`);

    if (listingComp.differences.length > 0) {
      for (const diff of listingComp.differences) {
        console.log(`  * [diff index ${diff.index} id=${diff.listingId}] champ=${diff.field} : Cheerio=${JSON.stringify(diff.cheerioValue)} vs Scrapling=${JSON.stringify(diff.scraplingValue)}`);
      }
    }

    results.push({
      id: page.id,
      label: page.label,
      url: page.url,
      httpStatus: fetchResult.status,
      bytes: fetchResult.bytes,
      cheerioDurationMs,
      scraplingDurationMs,
      scraplingWallMs: scraplingResult.metrics.wallMs,
      scraplingRssBytes: scraplingResult.metrics.rssBytes,
      scraplingNetworkAttempts: scraplingResult.metrics.networkAttempts,
      overheadMs,
      comparison,
    });
  }

  const report = evaluateTrial(results, limiter.getCount(), blockedError);

  mkdirSync(outputDir, { recursive: true });
  const outputFile = join(outputDir, "benchmark.json");
  writeFileSync(outputFile, `${JSON.stringify(report, null, 2)}\n`);

  console.log(`\n========================================`);
  console.log(`VERDICT : ${report.verdict}`);
  console.log(`Détail : ${report.verdictDetail}`);
  console.log(`Fichier de résultat : ${outputFile}`);
  console.log(`========================================\n`);

  return report;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runTrial().catch((err) => {
    console.error("Échec de l'essai :", err);
    process.exit(1);
  });
}
