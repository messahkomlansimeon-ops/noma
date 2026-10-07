import "server-only";

import {
  BOOST_REUSE_RECHECK_CACHE_MS,
  BOOST_REUSE_RECHECK_LIMIT,
  BOOST_REUSE_RECHECK_MAX_ENTRIES,
  BOOST_REUSE_RECHECK_WINDOW_MS,
} from "./boost-config";

/**
 * Garde de la revérification de portée d'un devis réutilisé (lot M1) : mémoire courte du résultat « atteignable » et limite de revérifications par
 * vendeur. Tout est en mémoire du processus (le créneau de calcul de portée qu'elle protège l'est aussi) : une relance du serveur remet le compteur à zéro.
 * L'horloge est monotone (`performance.now`), jamais l'horloge murale.
 */
export interface ReuseRecheckGuard {
  /** Vrai si ce devis a été vérifié ATTEIGNABLE il y a moins de `ttlMs`. Jamais pour un résultat non atteignable ou indéterminé (on ne les retient pas). */
  isFresh(quoteId: string): boolean;
  /** Retient « atteignable » pour ce devis. */
  remember(quoteId: string): void;
  /** Compte UNE revérification pour ce vendeur ; faux (et rien de compté) si `limit` revérifications ont déjà eu lieu dans la fenêtre. */
  tryAcquire(sellerId: string): boolean;
  /** Nombre d'entrées en mémoire (observation et tests). */
  size(): { quotes: number; sellers: number };
}

export interface ReuseRecheckGuardOptions {
  now?: () => number;
  ttlMs?: number;
  limit?: number;
  windowMs?: number;
  maxEntries?: number;
}

export function createReuseRecheckGuard(options: ReuseRecheckGuardOptions = {}): ReuseRecheckGuard {
  const now = options.now ?? (() => performance.now());
  const ttlMs = options.ttlMs ?? BOOST_REUSE_RECHECK_CACHE_MS;
  const limit = options.limit ?? BOOST_REUSE_RECHECK_LIMIT;
  const windowMs = options.windowMs ?? BOOST_REUSE_RECHECK_WINDOW_MS;
  const maxEntries = options.maxEntries ?? BOOST_REUSE_RECHECK_MAX_ENTRIES;
  /** quoteId → instant de la vérification. */
  const verified = new Map<string, number>();
  /** vendeur → instants des revérifications de la fenêtre (croissants). */
  const checks = new Map<string, number[]>();

  function sweepVerified(at: number): void {
    for (const [quoteId, checkedAt] of verified) if (at - checkedAt >= ttlMs) verified.delete(quoteId);
    // Toujours trop plein (devis tous récents) : on retire les plus anciens (ordre d'insertion).
    while (verified.size >= maxEntries) {
      const oldest = verified.keys().next();
      if (oldest.done) break;
      verified.delete(oldest.value);
    }
  }

  function sweepChecks(at: number): void {
    for (const [sellerId, instants] of checks) {
      while (instants.length > 0 && at - instants[0] >= windowMs) instants.shift();
      if (instants.length === 0) checks.delete(sellerId);
    }
    while (checks.size >= maxEntries) {
      const oldest = checks.keys().next();
      if (oldest.done) break;
      checks.delete(oldest.value);
    }
  }

  return {
    isFresh(quoteId) {
      const checkedAt = verified.get(quoteId);
      if (checkedAt === undefined) return false;
      if (now() - checkedAt >= ttlMs) {
        verified.delete(quoteId);
        return false;
      }
      return true;
    },
    remember(quoteId) {
      const at = now();
      if (verified.size >= maxEntries) sweepVerified(at);
      verified.delete(quoteId);
      verified.set(quoteId, at);
    },
    tryAcquire(sellerId) {
      const at = now();
      if (checks.size >= maxEntries && !checks.has(sellerId)) sweepChecks(at);
      const instants = checks.get(sellerId) ?? [];
      while (instants.length > 0 && at - instants[0] >= windowMs) instants.shift();
      if (instants.length >= limit) {
        checks.set(sellerId, instants);
        return false;
      }
      instants.push(at);
      checks.set(sellerId, instants);
      return true;
    },
    size: () => ({ quotes: verified.size, sellers: checks.size }),
  };
}

/** Garde du processus : celle des devis réels. Les tests injectent la leur (`BoostQuoteTestHooks.reuseRecheckGuard`). */
export const processReuseRecheckGuard: ReuseRecheckGuard = createReuseRecheckGuard();
