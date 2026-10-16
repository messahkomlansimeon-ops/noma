/**
 * Présentation du partage d'un besoin (lot FIN3-C4) : fonctions PURES, sans React, partagées par les écrans et testées isolément. Voir PARTAGE.md.
 */

import { SHARE_PATH_PREFIX, SHARE_TOKEN_PATTERN, type PublicNeed } from "../shares-rules";
import { formatDateTimeFr, formatFcfa } from "./wallet-view";

export const SHARE_TITLE = "Partager mon besoin";
export const SHARE_INTRO = "Créez un lien à envoyer à un vendeur (message, réseaux sociaux). Quiconque a le lien voit un résumé de votre besoin et peut publier une annonce qui y répond.";
export const SHARE_WHAT_TITLE = "Ce que le lien montre";
export const SHARE_WHAT_LINES: readonly string[] = Object.freeze([
  "Le produit recherché, l'état souhaité, la zone, la quantité et le budget.",
  "Jamais votre nom, votre numéro de téléphone ni le texte que vous avez écrit.",
  "Le vendeur ne peut pas vous écrire depuis ce lien : il publie une annonce, et noma la met en correspondance avec votre besoin.",
]);
export const SHARE_ONE_ACTIVE_NOTE = "Un seul lien est actif par besoin : en créer un nouveau désactive l'ancien. Le lien meurt aussi quand le besoin n'est plus actif. Pour des raisons de sécurité, le lien n'est montré qu'une fois : copiez-le tout de suite.";
export const SHARE_COPIED = "Lien copié.";
export const SHARE_COPY_FAILED = "Copie impossible : sélectionnez le lien et copiez-le à la main.";
export const SHARE_REVOKED = "Lien désactivé.";
export const PUBLIC_TITLE = "Quelqu'un cherche ceci";
export const PUBLIC_NOTE = "Ce résumé ne contient ni nom ni numéro. Si vous vendez ce produit, publiez une annonce : noma la met en correspondance avec ce besoin.";
export const PUBLIC_CTA = "Publier une annonce";
export const PUBLIC_DEAD = "Ce lien n'est plus valable.";
export const PUBLIC_LOADING = "Chargement…";

/** L'adresse complète à copier : l'origine de l'application et le chemin renvoyé par le serveur ; null si le chemin n'a pas la forme attendue. */
export function shareUrl(origin: string, path: string): string | null {
  if (!path.startsWith(SHARE_PATH_PREFIX) || !SHARE_TOKEN_PATTERN.test(path.slice(SHARE_PATH_PREFIX.length))) return null;
  return `${origin.replace(/\/$/, "")}${path}`;
}

export function statusText(status: { active: boolean; createdAt: string | null }): string {
  return status.active && status.createdAt ? `Un lien est actif depuis le ${formatDateTimeFr(status.createdAt)}.` : "Aucun lien actif pour ce besoin.";
}

export interface PublicNeedView {
  title: string;
  lines: string[];
}

/** Les lignes du résumé public : uniquement ce que le serveur a envoyé, dans un ordre fixe ; un champ absent n'est pas inventé. */
export function publicNeedLines(need: PublicNeed): PublicNeedView {
  const lines: string[] = [];
  if (need.category && need.category !== need.title) lines.push(`Catégorie : ${need.category}`);
  if (need.condition) lines.push(`État souhaité : ${need.condition}`);
  if (need.location) lines.push(`Zone : ${need.location}`);
  if (need.quantity !== null) lines.push(`Quantité : ${need.quantity}${need.unit ? ` ${need.unit}` : ""}`);
  if (need.budget) lines.push(`Budget : jusqu'à ${formatFcfa(need.budget.amount)}`);
  return { title: need.title, lines };
}
