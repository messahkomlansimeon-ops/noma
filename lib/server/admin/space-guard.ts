import "server-only";

import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { AUTH_SESSION_COOKIE } from "../auth/http";
import { resolveSession } from "../auth/sessions";
import { requireAdminSpaceWith, type AdminSpaceDependencies } from "./space-decision";

/**
 * Garde de l'ESPACE d'administration (lot D3), appliquée par le gabarit `app/(admin)/layout.tsx` AVANT toute page : un compte connecté qui n'est pas administrateur obtient la page 404
 * STANDARD de Next (`notFound()`, statut 404, aucun titre « Administration », aucun sélecteur d'espace) ; avant ce lot, la page s'affichait avec son titre puis écrivait « Page introuvable ».
 * La décision est dans `space-decision.ts` (pure, testée) ; ce fichier ne fait que le câblage à Next.
 */

function defaultDependencies(): AdminSpaceDependencies {
  return {
    readToken: async () => {
      const store = await cookies();
      const candidates = store.getAll(AUTH_SESSION_COOKIE);
      // Un cookie absent, vide ou en double n'authentifie personne (même règle que `readSingleCookie` des routes).
      return candidates.length === 1 && candidates[0].value !== "" ? candidates[0].value : null;
    },
    resolve: (token) => resolveSession(token),
    notFound: () => notFound(),
  };
}

/** Garde du gabarit : 404 pour un compte connecté qui n'est pas administrateur. */
export async function requireAdminSpace(): Promise<void> {
  await requireAdminSpaceWith(defaultDependencies());
}
