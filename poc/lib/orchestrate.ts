import type { SourceResult } from "../sources/types";
import { emptyResult } from "../sources/types";
import { logLine } from "./log";

export interface Runner {
  name: string;
  /** Tâche navigateur (Playwright) — concurrence limitée à 2. */
  browser: boolean;
  /** Le signal d'annulation est déclenché au délai par source. */
  run: (signal?: AbortSignal) => Promise<SourceResult>;
}

export interface OrchestrationResult {
  results: SourceResult[];
  /** Délai avant le premier résultat contenant des annonces. */
  firstResultMs: number;
  totalMs: number;
}

export interface RunSourcesOptions {
  browserLimit?: number;
  /** Délai MAXIMAL par connecteur ; au-delà, coupure + statut timeout
   *  (revue P2-9 : une source lente ne bloque plus les résultats). */
  sourceTimeoutMs?: number;
  /** Annulation EXTERNE (moteur multi-utilisateur) : coupe tous les
   *  connecteurs en cours. */
  signal?: AbortSignal;
  /** Appelé dès la terminaison de chaque connecteur (émission progressive). */
  onResult?: (result: SourceResult) => void;
}

/** Semaphore minimal. */
function limit<T>(n: number, tasks: (() => Promise<T>)[]): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(n, tasks.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= tasks.length) return;
      results[i] = await tasks[i]();
    }
  });
  return Promise.all(workers).then(() => results);
}

const fallbackCaps = () => ({
  search: false,
  location: false,
  pagination: false,
  itemCheck: false,
  services: false,
  unsupported: [],
});

/** Sémaphore GLOBAL de navigateurs (Lot 4) : 2 Chromium simultanés maximum,
 *  toutes recherches confondues. Injecté pour les tests. */
let GLOBAL_BROWSER_LIMIT = 2;
let activeBrowsers = 0;
const browserWaiters: (() => void)[] = [];

export function setGlobalBrowserLimit(n: number): void {
  GLOBAL_BROWSER_LIMIT = Math.max(1, n);
}

const acquireBrowserSlot = (): Promise<void> =>
  new Promise((resolve) => {
    if (activeBrowsers < GLOBAL_BROWSER_LIMIT) {
      activeBrowsers++;
      resolve();
    } else {
      browserWaiters.push(resolve);
    }
  });

const releaseBrowserSlot = (): void => {
  const next = browserWaiters.shift();
  if (next) next();
  else activeBrowsers = Math.max(0, activeBrowsers - 1);
};

/**
 * Exécute les connecteurs avec concurrence limitée (2 navigateurs) et émet
 * chaque résultat dès sa terminaison. Un connecteur qui lève est isolé :
 * sa panne n'affecte pas les autres. Un connecteur trop lent est coupé au
 * délai (signal d'annulation) et marqué « timeout ».
 */
export async function runSources(
  runners: Runner[],
  opts: RunSourcesOptions = {},
): Promise<OrchestrationResult> {
  const t0 = Date.now();
  const sourceTimeoutMs = opts.sourceTimeoutMs ?? 60_000;
  const firstResultMs = { v: Number.POSITIVE_INFINITY };
  const results: SourceResult[] = new Array(runners.length);

  const taskFor = (r: Runner, i: number) => async () => {
    const start = Date.now();
    // annulé avant le démarrage : aucun travail lancé (concurrence préservée)
    if (opts.signal?.aborted) {
      results[i] = emptyResult(r.name, "", fallbackCaps(), "error", 0, [
        "annulé avant le démarrage",
      ]);
      return;
    }
    const controller = new AbortController();
    // annulation externe → tous les connecteurs du run sont coupés
    if (opts.signal?.aborted) controller.abort();
    else opts.signal?.addEventListener("abort", () => controller.abort(), { once: true });

    const runP = r
      .run(controller.signal)
      .then(
        (res) => ({ res, timedOut: false as const }),
        (e: Error) => ({
          res: emptyResult(r.name, "", fallbackCaps(), "error", Date.now() - start, [
            e.message.slice(0, 200),
          ]),
          timedOut: false as const,
        }),
      );
    const timerP = new Promise<{ res: SourceResult; timedOut: true }>((resolve) => {
      const t = setTimeout(() => {
        controller.abort();
        resolve({
          res: emptyResult(r.name, "", fallbackCaps(), "timeout", Date.now() - start, [
            `délai dépassé (${sourceTimeoutMs} ms) — coupure`,
          ]),
          timedOut: true,
        });
      }, sourceTimeoutMs);
      t.unref?.();
    });

    const { res: result, timedOut } = await Promise.race([runP, timerP]);
    // le résultat (timeout ou réel) est écrit ; une réponse arrivée APRÈS la
    // coupure ne doit pas écraser le timeout
    results[i] = result;
    if (timedOut) {
      void runP.then((late) => {
        if (late.res.listings.length > 0) {
          logLine(
            `   ⏱ ${r.name} : ${late.res.listings.length} annonces arrivées APRÈS coupure (ignorées)`,
          );
        }
      });
    }
    opts.onResult?.(result);
    if (result.listings.length > 0) {
      const elapsed = Date.now() - t0;
      if (elapsed < firstResultMs.v) firstResultMs.v = elapsed;
      logLine(
        `   ✓ ${r.name} : ${result.listings.length} annonces (${result.durationMs} ms)`,
      );
    } else {
      logLine(
        `   ○ ${r.name} : ${result.status}${result.errors.length ? ` — ${result.errors[0].slice(0, 80)}` : ""} (${result.durationMs} ms)`,
      );
    }
  };

  const browserTasks = runners
    .map((r, i) => (r.browser ? taskFor(r, i) : null))
    .filter((t): t is () => Promise<void> => t !== null);
  const plainTasks = runners
    .map((r, i) => (!r.browser ? taskFor(r, i) : null))
    .filter((t): t is () => Promise<void> => t !== null);

  // Limite GLOBALE de navigateurs (toutes recherches confondues — Lot 4) :
  // deux recherches simultanées ne doivent jamais lancer 4 Chromium.
  // Comportement inchangé pour une recherche seule (limite par run ≤ 2).
  const wrappedBrowserTasks = browserTasks.map((t) => async () => {
    await acquireBrowserSlot();
    try {
      await t();
    } finally {
      releaseBrowserSlot();
    }
  });

  await Promise.all([
    limit(opts.browserLimit ?? 2, wrappedBrowserTasks),
    ...plainTasks.map((t) => t()),
  ]);

  const totalMs = Date.now() - t0;
  return {
    results: runners.map((_, i) => results[i] ?? emptyResult(runners[i].name, "", fallbackCaps(), "error", 0, ["aucun résultat"])),
    firstResultMs: Number.isFinite(firstResultMs.v) ? firstResultMs.v : totalMs,
    totalMs,
  };
}
// ─── Synthèse : « aucun résultat » ≠ « sources indisponibles » ─────────────

export interface SourcesSummary {
  ok: number;
  empty: number;
  indisponibles: number;
  verdict:
    | "résultats disponibles"
    | "aucune offre trouvée (sources opérationnelles)"
    | "sources indisponibles";
}

export function summarizeSources(results: SourceResult[]): SourcesSummary {
  const ok = results.filter((r) => r.status === "ok").length;
  const empty = results.filter((r) => r.status === "empty").length;
  const indisponibles = results.filter((r) =>
    ["blocked", "timeout", "error"].includes(r.status),
  ).length;
  let verdict: SourcesSummary["verdict"];
  if (ok > 0) verdict = "résultats disponibles";
  else if (empty > 0) verdict = "aucune offre trouvée (sources opérationnelles)";
  else verdict = "sources indisponibles";
  return { ok, empty, indisponibles, verdict };
}

/** Bilan synthétique PAR SOURCE (revue « mesures ») : statut en clair,
 *  détail (annonces/vide), durée et MOTIF d'échec. Dérivé des SourceResult —
 *  aucune donnée dupliquée, c'est la forme imprimable de `results`. */
export function bilanSources(results: SourceResult[]): string[] {
  const label: Record<SourceResult["status"], string> = {
    ok: "succès",
    empty: "vide (source opérationnelle)",
    blocked: "bloquée",
    timeout: "coupure",
    error: "erreur",
  };
  return results.map((r) => {
    const detail =
      r.status === "ok"
        ? `${r.listings.length} annonce${r.listings.length > 1 ? "s" : ""}`
        : r.status === "empty"
          ? "aucune annonce trouvée"
          : "";
    const motif = r.errors.length > 0 ? ` — motif : ${r.errors[0]}` : "";
    const duree = r.fromCache
      ? `cache · lecture ${Math.round(r.durationMs / 100) / 10} s${
          r.networkMs != null ? ` (réseau initial ${Math.round(r.networkMs / 100) / 10} s)` : ""
        }`
      : `${Math.round(r.durationMs / 100) / 10} s`;
    return `${r.source} : ${label[r.status]}${detail ? ` — ${detail}` : ""} · ${duree}${motif}`;
  });
}
