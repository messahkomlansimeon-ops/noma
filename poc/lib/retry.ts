import { sleep } from "./log";

export interface RetryOptions {
  /** Nombre TOTAL d'appels (1 = aucun réessai). Défaut 2. */
  attempts?: number;
  /** Délai avant la 2e tentative. Défaut 1500 ms. */
  baseDelayMs?: number;
  /** Plafond du délai (doublement borné). Défaut 8000 ms. */
  maxDelayMs?: number;
  /** Annulation : arrête les relances immédiatement. */
  signal?: AbortSignal;
  /** Injectable pour les tests hors ligne. */
  sleep?: (ms: number) => Promise<void>;
  /** Poursuivre les relances ? Défaut : toujours. (ex : seulement les
   *  erreurs réseau transitoires, pas un blocage SSRF.) */
  shouldRetry?: (e: unknown) => boolean;
}

/**
 * Réessais BORNÉS avec espacement croissant (revue « charge ») : au plus
 * `attempts` appels, jamais infini ; délai base×2ⁿ plafonné ; annulation
 * honorée entre les tentatives. La dernière erreur est relancée telle quelle.
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const attempts = Math.max(1, opts.attempts ?? 2);
  const base = opts.baseDelayMs ?? 1500;
  const max = opts.maxDelayMs ?? 8000;
  const wait = opts.sleep ?? sleep;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (opts.signal?.aborted) {
      throw lastError ?? new Error("annulé avant la tentative");
    }
    try {
      return await fn(attempt);
    } catch (e) {
      lastError = e;
      if (
        attempt >= attempts ||
        opts.signal?.aborted ||
        (opts.shouldRetry && !opts.shouldRetry(e))
      ) {
        throw e;
      }
      await wait(Math.min(base * 2 ** (attempt - 1), max));
    }
  }
  throw lastError;
}