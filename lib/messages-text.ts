/**
 * Texte d'un message de la messagerie (lot D2). Module PUR, sans dépendance serveur : il sert au serveur (validation de l'envoi) et à l'écran (compteur de caractères).
 *  - le texte est normalisé : NFKC, toute suite d'espaces, de tabulations ou de sauts de ligne devient UN espace, puis le texte est rogné ;
 *  - après normalisation il compte de 1 à 1000 caractères (points de code) ;
 *  - un caractère de contrôle, de direction de texte ou invisible (U+200B, U+202E…) est refusé, avant comme après normalisation ;
 *  - aucun HTML n'est interprété : le texte est stocké tel quel et TOUJOURS affiché comme du texte (jamais de dangerouslySetInnerHTML).
 * Un numéro de téléphone n'est PAS bloqué : le contact direct est voulu dans une conversation entre un acheteur et un vendeur.
 */
import { hasUnsafeCharacters } from "./phone-text";

export const MESSAGE_MAX_LENGTH = 1_000;

export type MessageBodyCheck =
  | { ok: true; body: string }
  | { ok: false; reason: "not_text" | "empty" | "too_long" | "unsafe" };

/** Rappel affiché la première fois qu'un participant ouvre une conversation. */
export const SAFETY_REMINDER = "Pour votre sécurité, ne payez jamais avant d'avoir vu l'objet.";

/** Forme normalisée d'un message : NFKC, espaces et sauts de ligne ramenés à un espace, rognée. */
export function normalizeMessageBody(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim();
}

export function countCharacters(value: string): number {
  return Array.from(value).length;
}

/** Contrôle d'un texte saisi : renvoie le texte normalisé à envoyer ou le motif du refus. */
export function checkMessageBody(value: unknown): MessageBodyCheck {
  if (typeof value !== "string") return { ok: false, reason: "not_text" };
  // Contrôle AVANT la normalisation des espaces : un caractère invisible ou de direction ne doit jamais être « absorbé » par elle.
  if (hasUnsafeCharacters(value.replace(/[\t\n\r]/gu, " "))) return { ok: false, reason: "unsafe" };
  const body = normalizeMessageBody(value);
  if (body === "") return { ok: false, reason: "empty" };
  if (hasUnsafeCharacters(body)) return { ok: false, reason: "unsafe" };
  if (countCharacters(body) > MESSAGE_MAX_LENGTH) return { ok: false, reason: "too_long" };
  return { ok: true, body };
}
