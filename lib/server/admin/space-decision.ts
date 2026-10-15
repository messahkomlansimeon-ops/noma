import "server-only";

import type { ResolvedSession } from "../auth/types";

/**
 * Décision de la garde de l'ESPACE d'administration (lot D3), pure et testable sans Next : voir `space-guard.ts` pour le câblage (cookie, session, `notFound()`).
 *  - visiteur sans session (ou session périmée, compte suspendu) : rien n'est décidé ici, l'espace se charge et la garde de session de la page redirige vers la connexion ;
 *  - administrateur (booléen vrai) : l'espace s'affiche ;
 *  - tout autre compte connecté : 404 (la page 404 standard de Next, statut 404, aucun titre « Administration » ;
 *  - session illisible (base indisponible, `DATABASE_URL` absente, délai dépassé) : « indisponible » — l'espace affiche « Le service est temporairement indisponible » au lieu de lever une erreur de rendu
 *    (page d'erreur de Next) ; rien n'est dit de la cause.
 * Ce n'est qu'une commodité d'interface : l'autorisation réelle est celle des routes `/api/admin/*` (le même 404 pour tout ce qui n'est pas un administrateur actif), qui relisent la base.
 */

export type AdminSpaceDecision = "show" | "not_found" | "unavailable";

export interface AdminSpaceDependencies {
  /** Valeur du cookie de session, ou null. */
  readToken(): Promise<string | null>;
  resolve(token: string): Promise<ResolvedSession | null>;
  /** Lève la page 404 de Next (ne rend jamais la main). */
  notFound(): never;
}

export async function decideAdminSpace(dependencies: Pick<AdminSpaceDependencies, "readToken" | "resolve">): Promise<AdminSpaceDecision> {
  const token = await dependencies.readToken();
  if (token === null) return "show";
  let session: ResolvedSession | null;
  try {
    session = await dependencies.resolve(token);
  } catch {
    return "unavailable";
  }
  if (session === null) return "show";
  return session.isAdmin === true ? "show" : "not_found";
}

/** Garde : 404 pour un compte connecté qui n'est pas administrateur ; « unavailable » si la session ne peut pas être lue ; sinon « show ». */
export async function requireAdminSpaceWith(dependencies: AdminSpaceDependencies): Promise<"show" | "unavailable"> {
  const decision = await decideAdminSpace(dependencies);
  if (decision === "not_found") dependencies.notFound();
  return decision === "unavailable" ? "unavailable" : "show";
}
