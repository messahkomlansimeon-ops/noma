/**
 * Demande de code depuis /connexion : logique pure (sans React ni navigateur), testée isolément.
 *
 * Le parcours (numéro, challenge) est conservé dans sessionStorage. Si ce stockage est bloqué, /verification ne
 * pourrait pas le relire et renverrait vers /connexion (boucle) : on le teste AVANT d'envoyer un code (aucun SMS
 * inutile) et on vérifie aussi l'écriture après l'envoi. Dans les deux cas : message fixe, pas de navigation,
 * jamais de second envoi automatique.
 */

import type { OtpChallenge } from "./api";
import type { OtpFlow } from "./otp-flow";
import { loginHref } from "./session";

export const STORAGE_BLOCKED_MESSAGE = "Votre navigateur bloque le stockage nécessaire à la connexion.";

export interface StartOtpDependencies {
  /** Le stockage de l'onglet accepte-t-il une écriture ? */
  canStore: () => boolean;
  requestOtp: (phone: string) => Promise<OtpChallenge>;
  /** Enregistre le parcours ; `false` si l'écriture a échoué. */
  save: (flow: OtpFlow) => boolean;
  /** Message fixe d'une erreur d'API (contexte « otp-request »). */
  describeError: (error: unknown) => string;
}

export type StartOtpResult = { ok: true } | { ok: false; message: string };

export async function startOtpFlow(
  phone: string,
  next: string,
  dependencies: StartOtpDependencies,
): Promise<StartOtpResult> {
  if (!dependencies.canStore()) return { ok: false, message: STORAGE_BLOCKED_MESSAGE };
  let challenge: OtpChallenge;
  try {
    challenge = await dependencies.requestOtp(phone);
  } catch (failure) {
    return { ok: false, message: dependencies.describeError(failure) };
  }
  if (!dependencies.save({ phone, ...challenge, next })) return { ok: false, message: STORAGE_BLOCKED_MESSAGE };
  return { ok: true };
}

/** Adresse de /connexion pour « Modifier le numéro » : la destination de retour du parcours est conservée (nettoyée). */
export function changeNumberHref(flow: Pick<OtpFlow, "next"> | null): string {
  return loginHref(flow?.next);
}
