import "server-only";

import { countDigits, hasUnsafeCharacters, looksLikePhoneNumber, normalizePublicText } from "../metrics/public-text";

/**
 * Contenu d'une notification : LISTE BLANCHE (titre de l'annonce = marque, modèle, variante ; prix ; lien vers la fiche dans le contexte du besoin).
 * Jamais : téléphone, identifiant du vendeur, texte libre de l'annonce (description, attributs). Chaque morceau de titre est un texte saisi par le
 * vendeur : il est nettoyé comme les attributs publics de la fiche, par les MÊMES fonctions (`metrics/public-text.ts`) : normalisation NFKC, caractères de
 * contrôle, de direction ou invisibles refusés, chiffres de tous les systèmes d'écriture comptés (`\p{Nd}`) ; un morceau qui ressemble à un numéro de téléphone
 * (neuf chiffres ou plus d'affilée) est écarté, et le titre ASSEMBLÉ ne porte jamais plus de 8 chiffres au total (le morceau qui dépasse est retiré).
 * Fonctions pures. Voir NOTIFICATIONS.md.
 */

/** Longueur maximale d'un morceau du titre (marque, modèle, variante) : 3 × 50 + 2 espaces ≤ 160 (CHECK de la migration 0019). */
export const TITLE_PART_MAX_LENGTH = 50;
export const TITLE_FALLBACK = "Nouvelle annonce";
/** Chiffres au plus dans le titre assemblé (marque, modèle et variante ensemble) : « iPhone 12 128 Go » en compte 5 ; un numéro de téléphone en compte 9 ou plus. */
export const TITLE_MAX_DIGITS = 8;

/** Un morceau du titre nettoyé et NORMALISÉ (NFKC) : le texte conservé ne porte que des formes usuelles ; null s'il est refusé. */
export function sanitizeTitlePart(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const text = normalizePublicText(value.replace(/\s+/g, " ").trim()).replace(/\s+/g, " ").trim();
  if (text === "" || text.length > TITLE_PART_MAX_LENGTH || hasUnsafeCharacters(text) || looksLikePhoneNumber(text)) return null;
  return text;
}

/**
 * « Apple iPhone 12 128 Go » : marque, modèle, variante, chacun nettoyé et omis s'il est refusé ; « Nouvelle annonce » s'il ne reste rien. Le titre ASSEMBLÉ est
 * contrôlé à son tour : au plus 8 chiffres au total, tous systèmes d'écriture confondus ; le morceau qui ferait dépasser est retiré (les précédents restent).
 */
export function buildNotificationTitle(offer: { brand: string | null; model: string | null; variant: string | null }): string {
  const kept: string[] = [];
  let digits = 0;
  for (const part of [offer.brand, offer.model, offer.variant].map(sanitizeTitlePart)) {
    if (part === null) continue;
    const partDigits = countDigits(part);
    if (digits + partDigits > TITLE_MAX_DIGITS) continue;
    digits += partDigits;
    kept.push(part);
  }
  return kept.length > 0 ? kept.join(" ") : TITLE_FALLBACK;
}

export interface NotificationPrice {
  amount: number;
  currency: string;
}

export function buildNotificationPrice(amount: unknown, currency: unknown): NotificationPrice | null {
  if (typeof amount !== "number" || !Number.isSafeInteger(amount) || amount < 0) return null;
  if (typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency)) return null;
  return { amount, currency };
}

/** Fiche de l'annonce dans le contexte du besoin (page `app/(buyer)/besoins/[id]/offres/[offerId]`). */
export function offerLink(demandId: string, offerId: string): string {
  return `/besoins/${demandId}/offres/${offerId}`;
}

export function demandLink(demandId: string): string {
  return `/besoins/${demandId}`;
}

/** Le seul lien d'un message externe : la liste des notifications. */
export const EXTERNAL_MESSAGE_LINK = "/notifications";

/** « 3 nouvelles annonces pour vos besoins » : le texte du message externe regroupé (jamais de titre, de prix ni d'identifiant). */
export function groupedMessageText(count: number): string {
  return count === 1 ? "1 nouvelle annonce pour vos besoins" : `${count} nouvelles annonces pour vos besoins`;
}

/** Contenu figé d'un envoi externe (colonne `content`) : titre, prix, lien. */
export interface DeliveryContent {
  title: string;
  price: NotificationPrice | null;
  link: string;
}

export function buildDeliveryContent(input: { title: string; price: NotificationPrice | null; demandId: string; offerId: string }): DeliveryContent {
  return { title: input.title, price: input.price, link: offerLink(input.demandId, input.offerId) };
}

// ───────────── annonces d'AUTRES SITES (lot RA1, recherche active) ─────────────

/** Titre d'une annonce d'un autre site : 120 caractères au plus, au plus 12 chiffres au total ; sinon le texte de repli. */
export const EXTERNAL_TITLE_MAX_LENGTH = 120;
export const EXTERNAL_TITLE_MAX_DIGITS = 12;
export const EXTERNAL_TITLE_FALLBACK = "Nouvelle annonce d'un autre site";
export const EXTERNAL_SOURCE_NAME_MAX_LENGTH = 80;
export const EXTERNAL_SOURCE_FALLBACK = "un autre site";

/**
 * Titre d'une annonce d'un autre site, nettoyé comme tout texte venu d'un tiers : normalisation NFKC, caractères de contrôle, de direction ou invisibles refusés, aucun texte qui
 * ressemble à un numéro de téléphone, au plus 12 chiffres ; sinon « Nouvelle annonce d'un autre site ». Jamais l'URL de l'annonce.
 */
export function buildExternalNotificationTitle(title: string | null | undefined): string {
  if (typeof title !== "string") return EXTERNAL_TITLE_FALLBACK;
  const text = normalizePublicText(title.replace(/\s+/g, " ").trim()).replace(/\s+/g, " ").trim();
  if (text === "" || hasUnsafeCharacters(text) || looksLikePhoneNumber(text) || countDigits(text) > EXTERNAL_TITLE_MAX_DIGITS) return EXTERNAL_TITLE_FALLBACK;
  return text.length > EXTERNAL_TITLE_MAX_LENGTH ? `${text.slice(0, EXTERNAL_TITLE_MAX_LENGTH - 1).trimEnd()}…` : text;
}

/** Nom de la source (« Annonces Démo A ») nettoyé de la même façon ; « un autre site » s'il est refusé. */
export function buildExternalSourceName(name: string | null | undefined): string {
  if (typeof name !== "string") return EXTERNAL_SOURCE_FALLBACK;
  const text = normalizePublicText(name.replace(/\s+/g, " ").trim()).replace(/\s+/g, " ").trim();
  if (text === "" || text.length > EXTERNAL_SOURCE_NAME_MAX_LENGTH || hasUnsafeCharacters(text) || looksLikePhoneNumber(text)) return EXTERNAL_SOURCE_FALLBACK;
  return text;
}

/** Contenu figé d'un envoi externe pour une annonce d'un autre site : titre, prix, et le lien vers la page du BESOIN (jamais l'URL de l'annonce externe). */
export function buildExternalDeliveryContent(input: { title: string; price: NotificationPrice | null; demandId: string }): DeliveryContent {
  return { title: input.title, price: input.price, link: demandLink(input.demandId) };
}
