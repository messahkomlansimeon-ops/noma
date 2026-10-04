import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { runCtx, logLine } from "./log";

const DEFAULT_TTL_MS = 15 * 60 * 1000; // 15 minutes
let FILE = "results/cache.json";

/**
 * Durée de validité PAR SOURCE (revue « mesures »). Facebook Marketplace
 * bouge vite ; une recherche Google CSE coûte de l'argent → gardée plus
 * longtemps. Toute source non listée = défaut (15 min). Une entrée expirée
 * est une lecture en ÉCHEC, jamais réutilisée ; les blocages/erreurs ne sont
 * jamais écrits (`cacheable`).
 */
export const SOURCE_TTL_MS: Record<string, number> = {
  facebook: 10 * 60 * 1000,
  coinafrique: 15 * 60 * 1000,
  locanto: 30 * 60 * 1000,
  google: 60 * 60 * 1000,
  page: 6 * 60 * 60 * 1000,
};

interface CacheEntry {
  v: unknown;
  exp: number;
  /** Instant d'écriture — permet l'âge des données (« données de Xs »). */
  ts?: number;
  ttl?: number;
  /** Durée RÉSEAU de la recherche initiale (revue P2 : la durée affichée
   *  d'un résultat servi par le cache n'est pas la durée réseau). */
  netMs?: number;
}

/** Ce qu'une lecture a réellement fait (revue P2 : séparer durée actuelle,
 *  provenance cache et durée réseau initiale). */
export interface CacheReadMeta {
  fromCache?: boolean;
  /** Âge des données servies (ms) ; null si inconnu (ancienne entrée). */
  ageMs?: number | null;
  /** Durée réseau de la recherche d'origine (ms) ; null hors cache. */
  netMs?: number | null;
}

let cache: Record<string, CacheEntry> = {};
try {
  cache = JSON.parse(readFileSync(FILE, "utf-8"));
} catch {
  cache = {};
}

let stats = { hits: 0, misses: 0, writes: 0, skipped: 0 };
let bySource: Record<string, { hits: number; misses: number; writes: number; skipped: number }> = {};
export const cacheStats = () => ({ ...stats });
/** Compteurs PAR SOURCE (revue P2 : les compteurs globaux masquent les
 *  écarts entre connecteurs). */
export const cacheStatsBySource = () =>
  JSON.parse(JSON.stringify(bySource)) as Record<
    string,
    { hits: number; misses: number; writes: number; skipped: number }
  >;
/** Compat (ancien code/tests) : nombre de lectures réussies. */
export const cacheHits = () => stats.hits;

/** Durée de validité applicable : paramètre explicite > source > défaut. */
export function ttlForKey(key: string, overrideMs?: number): number {
  if (overrideMs && overrideMs > 0) return overrideMs;
  const source = key.split(":")[0] ?? "";
  return SOURCE_TTL_MS[source] ?? DEFAULT_TTL_MS;
}

function persist() {
  mkdirSync("results", { recursive: true });
  // écritures sérialisées (étape 1 multi-utilisateur) : des recherches
  // simultanées ne doivent pas écraser mutuellement leurs entrées.
  // LIMITE ASSUMÉE : ce mutex protège UN processus — plusieurs workers
  // exigeront un cache partagé (étapes 2-3 : Supabase/Redis).
  persistChain = persistChain.then(() => {
    writeFileSync(FILE, JSON.stringify(cache, null, 1));
  });
  persistChain.catch(() => {});
}
let persistChain: Promise<void> = Promise.resolve();

/** Clé versionnée : source + version du connecteur + requête effective. */
export const cacheKey = (
  source: string,
  version: string,
  query: string,
): string => `${source}:${version}:${query}`;

/**
 * Réutilise une valeur tant qu'elle est fraîche (TTL par source).
 * `cacheable` exclut les résultats non réutilisables (blocage, erreur,
 * délai) : une recherche échouée n'est JAMAIS mise en cache comme réussie
 * ni comme « vide ».
 */
export async function cached<T>(
  key: string,
  fn: () => Promise<T>,
  cacheable: (v: T) => boolean = () => true,
  ttlMs?: number,
  meta?: CacheReadMeta,
): Promise<T> {
  const src = key.split(":")[0] ?? "?";
  const s = (bySource[src] ??= { hits: 0, misses: 0, writes: 0, skipped: 0 });
  // compteurs du RUN courant (isolation multi-recherches) ; fallback global
  const ctx = runCtx();
  const bump = (k: "hits" | "misses" | "writes" | "skipped") => {
    stats[k]++;
    s[k]++;
    if (ctx) {
      ctx.cache[k]++;
      (ctx.cache.bySource[src] ??= { hits: 0, misses: 0, writes: 0, skipped: 0 })[k]++;
    }
  };
  const hit = cache[key];
  const ttl = ttlForKey(key, ttlMs);
  if (hit && hit.exp > Date.now()) {
    bump("hits");
    const ts = hit.ts;
    const net0 = hit.netMs;
    const ageMs = ts !== undefined ? Date.now() - ts : null;
    if (meta) {
      meta.fromCache = true;
      meta.ageMs = ageMs;
      meta.netMs = net0 ?? null;
    }
    // journal court : la SOURCE, pas l'URL complète (requête dérivée)
    logLine(
      `   ⚡ cache ${src} : ${Math.round((hit.exp - Date.now()) / 1000)}s restant${
        ageMs !== null ? ` · données de ${Math.round(ageMs / 1000)}s` : ""
      }${net0 !== undefined ? ` · réseau initial ${Math.round(net0 / 1000)}s` : ""}`,
    );
    return hit.v as T;
  }
  bump("misses");
  if (meta) {
    meta.fromCache = false;
    meta.netMs = null;
  }
  const tFn = Date.now();
  const value = await fn();
  const netMs = Date.now() - tFn;
  if (meta) meta.netMs = netMs;
  if (cacheable(value)) {
    cache[key] = { v: value, exp: Date.now() + ttl, ts: Date.now(), ttl, netMs };
    // purge des entrées expirées à chaque écriture (croissance bornée)
    const now = Date.now();
    for (const [k, e] of Object.entries(cache)) {
      if (e.exp <= now) delete cache[k];
    }
    bump("writes");
    persist();
  } else {
    bump("skipped"); // blocage/erreur/délai → non mémorisé
  }
  return value;
}

/**
 * Post-traitement d'un résultat servi depuis le cache (revue P2) : la durée
 * affichée devient celle de la lecture ACTUELLE, la provenance est marquée
 * et la durée réseau initiale est préservée pour le bilan.
 */
export function avecCache<
  T extends { durationMs: number; warnings: string[] },
>(
  valeur: T,
  meta: CacheReadMeta,
  lectureMs: number,
): T & { fromCache?: boolean; networkMs?: number } {
  if (!meta.fromCache) return valeur;
  const age = meta.ageMs != null ? Math.round(meta.ageMs / 1000) : null;
  const net = meta.netMs != null ? Math.round(meta.netMs / 1000) : null;
  return {
    ...valeur,
    durationMs: lectureMs,
    fromCache: true,
    networkMs: meta.netMs ?? undefined,
    warnings: [
      ...valeur.warnings,
      `issu du cache — données de ${age ?? "?"}s, recherche initiale ${net ?? "?"}s`,
    ],
  };
}

/** Réinitialise l'état du cache (tests) — fichier isolé optionnel. */
export function __resetCache(file?: string) {
  cache = {};
  stats = { hits: 0, misses: 0, writes: 0, skipped: 0 };
  bySource = {};
  if (file) FILE = file;
}