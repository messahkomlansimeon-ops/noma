import "server-only";

import { MARKET_RATE_LIMIT, MARKET_RATE_MAX_USERS, MARKET_RATE_WINDOW_MS } from "./config";

/**
 * Limite de débit de la route des statistiques de marché (lot H1) : au plus `MARKET_RATE_LIMIT` (60) lectures par fenêtre glissante de `MARKET_RATE_WINDOW_MS` (une minute)
 * et par utilisateur. Tout est en mémoire du processus (comme la garde des revérifications de boost) : une relance du serveur remet les compteurs à zéro, et deux
 * processus ont chacun leur compteur. L'horloge est monotone (`performance.now`), jamais l'horloge murale.
 */
export interface MarketRateLimiter {
  /** Compte UNE lecture pour cet utilisateur ; `ok: false` (et rien de compté) si la limite est atteinte, avec le délai avant la prochaine lecture permise (secondes, au moins 1). */
  tryAcquire(userId: string): { ok: true } | { ok: false; retryAfterSeconds: number };
  /** Utilisateurs en mémoire (observation et tests). */
  size(): number;
}

export interface MarketRateLimiterOptions {
  now?: () => number;
  limit?: number;
  windowMs?: number;
  maxUsers?: number;
}

export function createMarketRateLimiter(options: MarketRateLimiterOptions = {}): MarketRateLimiter {
  const now = options.now ?? (() => performance.now());
  const limit = options.limit ?? MARKET_RATE_LIMIT;
  const windowMs = options.windowMs ?? MARKET_RATE_WINDOW_MS;
  const maxUsers = options.maxUsers ?? MARKET_RATE_MAX_USERS;
  /** utilisateur → instants des lectures de la fenêtre (croissants). */
  const reads = new Map<string, number[]>();

  function sweep(at: number): void {
    for (const [userId, instants] of reads) {
      while (instants.length > 0 && at - instants[0] >= windowMs) instants.shift();
      if (instants.length === 0) reads.delete(userId);
    }
    // Toujours trop plein (utilisateurs tous actifs) : on retire les plus anciens (ordre d'insertion).
    while (reads.size >= maxUsers) {
      const oldest = reads.keys().next();
      if (oldest.done) break;
      reads.delete(oldest.value);
    }
  }

  return {
    tryAcquire(userId) {
      const at = now();
      if (reads.size >= maxUsers && !reads.has(userId)) sweep(at);
      const instants = reads.get(userId) ?? [];
      while (instants.length > 0 && at - instants[0] >= windowMs) instants.shift();
      if (instants.length >= limit) {
        reads.set(userId, instants);
        return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((instants[0] + windowMs - at) / 1000)) };
      }
      instants.push(at);
      reads.set(userId, instants);
      return { ok: true };
    },
    size: () => reads.size,
  };
}

/** Limiteur du processus. Les tests injectent le leur. */
export const processMarketRateLimiter: MarketRateLimiter = createMarketRateLimiter();
