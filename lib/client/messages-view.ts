/**
 * Présentation de la messagerie (lot D2) : libellés et règles en fonctions PURES, sans React, testées isolément. Écrans : la liste des conversations (non lues en gras, l'autre
 * partie désignée SANS identité), le fil d'une conversation (envoi, réception en direct) et la pastille de non-lus (même règle de relecture que les notifications).
 *
 * Règles : l'autre partie n'a jamais de nom ni de numéro : « Vendeur de l'annonce iPhone 12 » côté acheteur, « Acheteur intéressé » côté vendeur ; le texte d'un message est
 * toujours montré comme du TEXTE (jamais interprété comme du HTML) ; le rappel de sécurité ne s'affiche que la première fois ; un lien reconstruit depuis les identifiants.
 */

import { SAFETY_REMINDER, MESSAGE_MAX_LENGTH, checkMessageBody, countCharacters } from "../messages-text";
import type { ConversationDetail, ConversationMessage, ConversationSummary, ParticipantRole } from "./social-api";
import { formatDateTimeFr } from "./wallet-view";

export { SAFETY_REMINDER, MESSAGE_MAX_LENGTH };

export const MESSAGES_TITLE = "Messages";
export const MESSAGES_LOADING = "Chargement de vos conversations…";
export const MESSAGES_EMPTY = "Aucune conversation pour le moment.";
export const MESSAGES_EMPTY_BUYER_HINT = "Depuis la fiche d'une annonce, touchez « Écrire au vendeur » pour démarrer une conversation.";
export const MESSAGES_EMPTY_SELLER_HINT = "Quand un acheteur vous écrit depuis une de vos annonces, la conversation apparaît ici. Vous pouvez répondre, jamais écrire le premier.";
export const WRITE_TO_SELLER_LABEL = "Écrire au vendeur";
export const WRITE_TO_SELLER_ONGOING = "Ouverture…";
export const SEND_LABEL = "Envoyer";
export const COMPOSER_PLACEHOLDER = "Écrivez votre message…";
export const THREAD_EMPTY_BUYER = "Écrivez le premier message : le vendeur recevra une notification.";
export const THREAD_EMPTY_SELLER = "Aucun message pour le moment.";
export const OFFER_GONE_NOTICE = "Cette annonce n'est plus disponible.";
export const SAFETY_DISMISS_LABEL = "J'ai compris";
export const NO_PAYMENT_THROUGH_NOMA = "noma ne gère aucun paiement de l'objet : réglez directement avec le vendeur, après avoir vu l'objet.";

/** Désignation de l'autre partie, SANS identité. */
export function counterpartLabel(role: ParticipantRole, title: string): string {
  return role === "buyer" ? `Vendeur de l'annonce ${title}` : "Acheteur intéressé";
}

export interface ConversationRowView {
  id: string;
  /** « Vendeur de l'annonce iPhone 12 » ou « Acheteur intéressé ». */
  label: string;
  /** Côté vendeur : « Annonce : iPhone 12 » (l'acheteur n'a pas de nom) ; côté acheteur : rien (le titre est dans l'étiquette). */
  subtitle: string | null;
  /** Dernier message (« Vous : … » pour le sien) ou « Aucun message ». */
  preview: string;
  dateText: string;
  unread: boolean;
  unreadCount: number;
  /** Page de la conversation dans l'espace du participant. */
  href: string;
  available: boolean;
}

/** Page d'une conversation dans l'espace du participant (acheteur : /messages/{id} ; vendeur : /vendeur/messages/{id}). */
export function conversationPath(role: ParticipantRole, id: string): string {
  return role === "buyer" ? `/messages/${id}` : `/vendeur/messages/${id}`;
}

export function conversationRow(item: ConversationSummary): ConversationRowView {
  const last = item.lastMessage;
  return {
    id: item.id,
    label: counterpartLabel(item.role, item.title),
    subtitle: item.role === "seller" ? `Annonce : ${item.title}` : null,
    preview: last === null ? "Aucun message" : `${last.mine ? "Vous : " : ""}${last.body}`,
    dateText: formatDateTimeFr(last === null ? item.createdAt : last.createdAt),
    unread: item.unreadCount > 0,
    unreadCount: item.unreadCount,
    href: conversationPath(item.role, item.id),
    available: item.available,
  };
}

/** Lien vers la fiche de l'annonce (acheteur : dans le contexte de son besoin d'origine) ; le vendeur n'a que son annonce. */
export function conversationOfferPath(detail: Pick<ConversationDetail, "role" | "demandId" | "offerId">): string | null {
  if (detail.role === "seller") return `/vendeur/annonces/${detail.offerId}`;
  return detail.demandId === null ? null : `/besoins/${detail.demandId}/offres/${detail.offerId}`;
}

// ───────────── fil de la conversation ─────────────

/** Ajoute des messages au fil sans doublon (par id), du plus ancien au plus récent : un message reçu deux fois (écho, rattrapage) n'apparaît qu'une fois. */
export function mergeMessages(current: readonly ConversationMessage[], incoming: readonly ConversationMessage[]): ConversationMessage[] {
  const byId = new Map<number, ConversationMessage>();
  for (const message of current) byId.set(message.id, message);
  for (const message of incoming) if (!byId.has(message.id)) byId.set(message.id, message);
  return [...byId.values()].sort((a, b) => a.id - b.id);
}

export function lastMessageId(messages: readonly ConversationMessage[]): number | null {
  let last: number | null = null;
  for (const message of messages) if (last === null || message.id > last) last = message.id;
  return last;
}

export interface ComposerState {
  canSend: boolean;
  /** « 12 / 1000 » (caractères après normalisation). */
  counter: string;
  /** Motif d'un texte refusé (affiché sous la saisie) ; null si rien à dire. */
  problem: string | null;
}

export function composerState(text: string, sending: boolean): ComposerState {
  const trimmed = text.trim();
  if (trimmed === "") return { canSend: false, counter: `0 / ${MESSAGE_MAX_LENGTH}`, problem: null };
  const checked = checkMessageBody(text);
  if (checked.ok) return { canSend: !sending, counter: `${countCharacters(checked.body)} / ${MESSAGE_MAX_LENGTH}`, problem: null };
  const problem =
    checked.reason === "too_long"
      ? `Message trop long : ${MESSAGE_MAX_LENGTH} caractères au plus.`
      : checked.reason === "unsafe"
        ? "Ce message contient un caractère spécial non accepté."
        : null;
  return { canSend: false, counter: `${countCharacters(trimmed)} / ${MESSAGE_MAX_LENGTH}`, problem };
}

// ───────────── rappel de sécurité (la première fois) ─────────────

export const SAFETY_REMINDER_STORAGE_KEY = "noma:safety-reminder-seen";

export interface SimpleStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Le rappel ne s'affiche que la première fois : un stockage absent, bloqué ou qui lève ne fait JAMAIS échouer l'écran (le rappel est alors montré). */
export function shouldShowSafetyReminder(storage: SimpleStorage | null): boolean {
  try {
    return storage === null || storage.getItem(SAFETY_REMINDER_STORAGE_KEY) !== "1";
  } catch {
    return true;
  }
}

export function markSafetyReminderSeen(storage: SimpleStorage | null): void {
  try {
    storage?.setItem(SAFETY_REMINDER_STORAGE_KEY, "1");
  } catch {
    // Un stockage refusé n'est pas une erreur : le rappel reviendra.
  }
}

// ───────────── pastille de non-lus ─────────────

export function messagesBadgeAccessibleLabel(count: number | null): string {
  if (count === null || !Number.isSafeInteger(count) || count <= 0) return "Messages";
  return count === 1 ? "Messages : 1 conversation non lue" : `Messages : ${count > 99 ? "plus de 99" : count} conversations non lues`;
}
