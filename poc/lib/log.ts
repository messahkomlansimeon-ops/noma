import { AsyncLocalStorage } from "node:async_hooks";

export interface UsageEntry {
  task: string;
  model: string;
  /** null = coût inconnu (usage.cost absent) — jamais compté comme zéro. */
  cost: number | null;
  promptTokens: number;
  completionTokens: number;
  ts: string;
}

/** Compteurs cache D'UN run (remplis par lib/cache.ts quand un contexte
 *  existe ; sinon les compteurs globaux du module s'appliquent). */
export interface RunCacheStats {
  hits: number;
  misses: number;
  writes: number;
  skipped: number;
  bySource: Record<string, { hits: number; misses: number; writes: number; skipped: number }>;
}

/**
 * Contexte D'UNE recherche (étape 1 « multi-utilisateur ») : journal,
 * compteur IA et compteurs cache isolés par exécution — plusieurs
 * recherches simultanées ne se mélangent plus. Hors contexte (CLI direct,
 * tests unitaires), l'état global du module s'applique comme avant.
 */
export interface RunCtx {
  /** Journal du run (le CLI passe console.log ; le backend peut rester muet). */
  log: (line: string) => void;
  /** Entrées IA de CE run (coût, tokens). */
  entries: UsageEntry[];
  /** Plafond de dépense IA de CE run — llmJson refuse d'appeler au-delà,
   *  AVANT chaque modèle, avec réserve pour les appels simultanés. */
  maxCostUsd?: number;
  /** Dépense réservée par les appels IA en cours (plafond strict). */
  reservedUsd?: number;
  /** false = IA désactivée pour CE run (`ai: null`) — TOUS les chemins IA
   *  (scoring, extraction Google, secours SERP) refusent d'appeler. */
  aiEnabled?: boolean;
  /** Dossier d'artefacts du run — preuves navigateur (captures) écrites
   *  SEULEMENT ici, jamais dans un chemin partagé (étapes simultanées). */
  artifactsDir?: string;
  cache: RunCacheStats;
}

const als = new AsyncLocalStorage<RunCtx>();

/** Contexte du run courant, sinon undefined. */
export const runCtx = (): RunCtx | undefined => als.getStore();

/** Exécute une fonction dans un contexte de run isolé. */
export function runWithCtx<T>(ctx: RunCtx, fn: () => Promise<T>): Promise<T> {
  return als.run(ctx, fn);
}

/** Journal du run courant (fallback : console). */
export const logLine = (line: string): void =>
  (runCtx()?.log ?? console.log)(line);

const globalEntries: UsageEntry[] = [];

const journal = (): { entries: UsageEntry[]; log: (line: string) => void } => {
  const ctx = runCtx();
  return ctx ? { entries: ctx.entries, log: ctx.log } : { entries: globalEntries, log: console.log };
};

export function logUsage(e: Omit<UsageEntry, "ts">) {
  const { entries, log } = journal();
  entries.push({ ...e, ts: new Date().toISOString() });
  const cost = e.cost === null ? "coût inconnu" : `$${e.cost.toFixed(6)}`;
  log(`  💰 ${e.task} [${e.model}] ${cost} (${e.promptTokens} in / ${e.completionTokens} out)`);
}

export function ledgerRows(entries?: UsageEntry[]): UsageEntry[] {
  return [...(entries ?? globalEntries)];
}

export interface CostReport {
  total: number | null;
  /** false si au moins un appel n'a pas renvoyé usage.cost. */
  known: boolean;
}

export function totalCost(entries?: UsageEntry[]): CostReport {
  let total = 0;
  for (const e of entries ?? globalEntries) {
    if (e.cost === null) return { total, known: false };
    total += e.cost;
  }
  return { total, known: true };
}

export function ledgerByModel(entries?: UsageEntry[]): Record<string, { calls: number; cost: number | null }> {
  const out: Record<string, { calls: number; cost: number | null }> = {};
  for (const e of entries ?? globalEntries) {
    out[e.model] ??= { calls: 0, cost: 0 };
    out[e.model].calls += 1;
    if (e.cost === null) {
      out[e.model].cost = out[e.model].cost === null ? null : (out[e.model].cost ?? 0);
      if (e.cost === null) out[e.model].cost = null;
    } else if (out[e.model].cost !== null) {
      out[e.model].cost = (out[e.model].cost ?? 0) + e.cost;
    }
  }
  return out;
}

export function aiCallCount(entries?: UsageEntry[]): number {
  return (entries ?? globalEntries).length;
}

export function tokenTotals(entries?: UsageEntry[]): { prompt: number; completion: number } {
  return (entries ?? globalEntries).reduce(
    (acc, e) => ({
      prompt: acc.prompt + e.promptTokens,
      completion: acc.completion + e.completionTokens,
    }),
    { prompt: 0, completion: 0 },
  );
}

export const sleep = (ms: number) =>
  new Promise<void>((r) => setTimeout(r, ms));