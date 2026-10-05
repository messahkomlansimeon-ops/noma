/**
 * Garde de session des écrans : fonctions pures (sans React) pour que le comportement soit testable.
 * L'état de session vient UNIQUEMENT de GET /api/auth/session (le cookie `noma_auth` est HttpOnly : le navigateur
 * ne le lit jamais). Cette garde est une commodité d'interface : l'autorisation réelle est appliquée par chaque
 * route de l'API (401 sans session valide).
 */

import type { SessionOutcome } from "./api";

/** Origine factice servant à vérifier qu'un chemin reste interne. */
const PROBE_ORIGIN = "http://noma.invalid";
const MAX_NEXT_LENGTH = 512;
/** Pages de connexion : jamais une destination de retour (boucle de redirection). */
const AUTH_PATHS = ["/connexion", "/verification"];

/**
 * Chemin interne sûr pour le paramètre `next` : une chaîne qui commence par un seul « / », sans « // » ni « /\ »
 * initial, sans barre oblique inverse ni caractère de contrôle, qui reste sur la même origine une fois analysée
 * et qui ne désigne pas une page de connexion. Toute autre valeur (URL absolue, `//hôte`, `javascript:`, vide…)
 * donne `fallback`.
 */
export function safeNextPath(value: unknown, fallback = "/"): string {
  if (typeof value !== "string") return fallback;
  if (value.length === 0 || value.length > MAX_NEXT_LENGTH) return fallback;
  if (!value.startsWith("/") || value.startsWith("//")) return fallback;
  if (/[\u0000-\u001f\u007f\\]/.test(value)) return fallback;

  let url: URL;
  try {
    url = new URL(value, PROBE_ORIGIN);
  } catch {
    return fallback;
  }
  if (url.origin !== PROBE_ORIGIN) return fallback;
  if (AUTH_PATHS.some((path) => url.pathname === path || url.pathname.startsWith(`${path}/`))) return fallback;
  const normalized = `${url.pathname}${url.search}${url.hash}`;
  // Les segments « .. » ou « . » peuvent rapprocher « /..//hôte » de « //hôte » après analyse : revérifier.
  if (normalized.startsWith("//")) return fallback;
  return normalized;
}

/** Adresse de la page de connexion avec retour vers `nextPath` (nettoyé ; absent si c'est l'accueil). */
export function loginHref(nextPath: string | null | undefined): string {
  const safe = safeNextPath(nextPath);
  return safe === "/" ? "/connexion" : `/connexion?next=${encodeURIComponent(safe)}`;
}

export type GateDecision =
  | { kind: "allow"; userId: string }
  | { kind: "redirect"; to: string }
  | { kind: "unavailable" };

/** Décision de la garde : session valide → on affiche ; pas de session → connexion ; panne → on n'affiche rien. */
export function decideGate(outcome: SessionOutcome, currentPath: string): GateDecision {
  switch (outcome.kind) {
    case "authenticated":
      return { kind: "allow", userId: outcome.userId };
    case "anonymous":
      return { kind: "redirect", to: loginHref(currentPath) };
    default:
      return { kind: "unavailable" };
  }
}

export type GateState =
  | { kind: "checking" }
  | { kind: "allowed"; userId: string }
  | { kind: "redirecting" }
  | { kind: "unavailable" };

/** Tant que la session n'est pas confirmée, rien d'autre que « vérification en cours » n'est montré. */
export const INITIAL_GATE_STATE: GateState = { kind: "checking" };

export interface GateDependencies {
  sessionOutcome: () => Promise<SessionOutcome>;
  /** Chemin courant (avec la requête) : destination de retour après connexion. */
  currentPath: string;
  /** Navigation sans entrée d'historique (router.replace) vers une adresse interne déjà nettoyée. */
  navigate: (to: string) => void;
}

/** Interroge la session, redirige si besoin, et renvoie le nouvel état de la garde. */
export async function runSessionGate(dependencies: GateDependencies): Promise<GateState> {
  const decision = decideGate(await dependencies.sessionOutcome(), dependencies.currentPath);
  if (decision.kind === "redirect") {
    dependencies.navigate(decision.to);
    return { kind: "redirecting" };
  }
  if (decision.kind === "allow") return { kind: "allowed", userId: decision.userId };
  return { kind: "unavailable" };
}
