/**
 * Admission d'une recherche publique (Lot 4) — compose les protections :
 * interrupteurs → Turnstile → quotas session/IP → réservation de budget.
 * Le rejet est sans file d'attente (429 + Retry-After) ; si le solde est
 * insuffisant, la recherche est admise SANS IA (secours web préservé).
 */
import type { GuardDatabase } from "./db";
import type { GuardConfig } from "./config";
import { reserveForSearch, reconcileReservation, type ReconcileOutcome } from "./budget";
import { admitSearch, releaseActive } from "./quotas";
import { verifyTurnstile, type TurnstileVerifier, type TurnstileCheck } from "./turnstile";

export interface AdmissionRequest {
  sessionId: string;
  ipHash: string;
  /** IP en clair — utilisée SEULEMENT pour siteverify (remoteip), jamais
   *  stockée ni journalisée. */
  remoteip: string | null;
  turnstileToken?: string;
  /** Continuation signée déjà validée par la route. */
  turnstileVerified?: boolean;
  now: Date;
}

export type AdmissionResult =
  | {
      allowed: true;
      searchId: string;
      /** false = mode sans IA (budget épuisé ou interrupteur serveur). */
      aiEnabled: boolean;
      reservationMicros: number;
    }
  | {
      allowed: false;
      /** Code HTTP à renvoyer. */
      status: 403 | 429 | 503;
      code: string;
      message: string;
      retryAfterSeconds?: number;
    };

export interface AdmissionDeps {
  cfg: GuardConfig;
  db: GuardDatabase;
  verify: TurnstileVerifier;
}

export async function admitPublicSearch(
  deps: AdmissionDeps,
  req: AdmissionRequest,
): Promise<AdmissionResult> {
  const { cfg, db, verify } = deps;

  // 1. Interrupteur serveur « recherches désactivées »
  if (cfg.searchDisabled) {
    return { allowed: false, status: 503, code: "searches_disabled", message: "La recherche est temporairement désactivée." };
  }

  // 2. Turnstile — jeton, hostname et action validés côté serveur
  const check: TurnstileCheck = req.turnstileVerified
    ? { ok: true }
    : await verifyTurnstile(verify, { ...cfg.turnstile, production: process.env.NODE_ENV === "production" }, req.turnstileToken, req.remoteip);
  if (!check.ok) {
    return {
      allowed: false,
      status: 403,
      code: check.reason === "config" ? "antibot_config" : "antibot_invalid",
      message: "La vérification anti-robot a échoué. Rechargez la page et réessayez.",
    };
  }

  // 3. Quotas session/IP + concurrence globale (transaction atomique)
  const quota = admitSearch(db, {
    sessionId: req.sessionId,
    ipHash: req.ipHash,
    now: req.now,
    timezone: cfg.budgetTimezone,
    activeSearchTtlMs: cfg.activeSearchTtlMs,
    startsPerMinute: cfg.startsPerMinute,
    startsPerDay: cfg.startsPerDay,
    maxConcurrentSearches: cfg.maxConcurrentSearches,
  });
  if (!quota.allowed || !quota.searchId) {
    return {
      allowed: false,
      status: 429,
      code: quota.rejection === "already-active" ? "search_in_progress" : "rate_limited",
      message:
        quota.rejection === "already-active"
          ? "Une recherche est déjà en cours sur cette session."
          : "Trop de recherches. Réessayez dans un instant.",
      retryAfterSeconds: quota.retryAfterSeconds,
    };
  }

  // 4. Budget prévisionnel — réserve si le solde le permet, sinon sans IA
  let aiEnabled = !cfg.aiDisabled;
  let reservationMicros = 0;
  if (aiEnabled) {
    const reserve = reserveForSearch(db, quota.searchId, cfg.reserveMicros, cfg.dailyBudgetMicros, req.now, cfg.budgetTimezone);
    if (reserve.reserved) {
      reservationMicros = reserve.amountMicros;
    } else {
      aiEnabled = false; // budget épuisé → secours web, sans augmenter le budget
    }
  }

  return { allowed: true, searchId: quota.searchId, aiEnabled, reservationMicros };
}

/** Fin de recherche : libère la place (concurrence) et réconcilie la réserve
 *  (coût connu → reliquat libéré ; coût inconnu → réserve conservée).
 *  À appeler DANS TOUS LES CAS (finally) : arrêt, déconnexion, échéance. */
export function completePublicSearch(
  deps: { cfg: GuardConfig; db: GuardDatabase },
  sessionId: string,
  searchId: string,
  reconciliation: { totalCostKnown: boolean; costMicros: number },
  now: Date,
): ReconcileOutcome {
  releaseActive(deps.db, sessionId, searchId);
  return reconcileReservation(deps.db, searchId, reconciliation.totalCostKnown, reconciliation.costMicros, now);
}
