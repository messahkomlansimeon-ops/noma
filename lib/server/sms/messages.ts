import { OTP_TTL_MS } from "../auth/config";

/**
 * Textes des SMS (lot SMS1). Chacun tient dans UN segment GSM-7 (160 septets) : pas d'accent hors table, pas de « ç », pas de caractère hors alphabet GSM. Le contrôle réel est refait
 * par `localRefusal` avant chaque envoi ; ces fonctions ne font que composer le texte. Le texte contient le code (OTP) : il n'est JAMAIS journalisé ni stocké.
 */

/** « noma : votre code est 123456. Il expire dans 5 min. Ne le partagez pas. » (la durée suit OTP_TTL_MS). */
export function otpMessage(code: string, ttlMs: number = OTP_TTL_MS): string {
  const minutes = Math.max(1, Math.round(ttlMs / 60_000));
  return `noma : votre code est ${code}. Il expire dans ${minutes} min. Ne le partagez pas.`;
}

/** Texte de la notification : voir notification-text.ts (module pur, lu aussi par la configuration du démarrage). */
export { notificationMessage } from "./notification-text";

export const SMOKE_MESSAGE = "noma : SMS de test. Si vous le recevez, la liaison avec le fournisseur fonctionne.";
