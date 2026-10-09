/**
 * Présentation des photos d'annonces (lot PH1) : fonctions PURES (aucun accès réseau ni DOM). Contrôles faits AVANT l'envoi pour répondre tout de suite en mots simples ; le serveur
 * reste l'autorité (il relit les octets et ne croit ni le nom ni le type annoncés par le navigateur).
 */

import { PHOTO_ACCEPTED_TYPES, PHOTO_MAX_BYTES, PHOTO_MAX_PER_OFFER, type OfferPhoto, type PhotoMime } from "./photos-api";

/** Rappel montré au vendeur partout où il ajoute des photos : le numéro écrit DANS une photo n'est pas détecté (ni OCR, ni IA). */
export const PHONE_REMINDER = "N'écrivez pas votre numéro sur les photos : l'acheteur vous contacte par noma.";

export const PHOTOS_TITLE = "Photos";
export const PHOTOS_ADD_LABEL = "Ajouter des photos";
export const PHOTOS_EMPTY = "Aucune photo pour le moment. Une annonce avec des photos est plus rassurante pour l'acheteur.";
export const PHOTOS_HINT = "JPEG, PNG ou WebP, 5 Mo au plus. La première photo est la couverture. Les informations cachées dans la photo (lieu, date, appareil) sont retirées.";
export const PHOTOS_LIMIT_REACHED = `Vous avez déjà ${PHOTO_MAX_PER_OFFER} photos : supprimez-en une pour en ajouter.`;

const TYPE_BY_EXTENSION: Readonly<Record<string, PhotoMime>> = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp" };

export interface LocalFileInfo {
  name: string;
  size: number;
  type: string;
}

/**
 * Contrôle rapide d'un fichier choisi : `null` s'il peut partir, sinon la phrase qui explique. Le type est celui que le navigateur annonce (à défaut, l'extension) : il ne sert qu'à
 * éviter un envoi inutile, jamais à décider de quoi que ce soit (le serveur lit les octets).
 */
export function checkLocalPhoto(file: LocalFileInfo): string | null {
  if (file.size <= 0) return "Ce fichier est vide.";
  if (file.size > PHOTO_MAX_BYTES) return "Cette photo est trop lourde : 5 Mo au plus.";
  const declared = file.type.trim().toLowerCase();
  const extension = file.name.includes(".") ? file.name.slice(file.name.lastIndexOf(".") + 1).toLowerCase() : "";
  const type = declared !== "" ? declared : (TYPE_BY_EXTENSION[extension] ?? "");
  if (!(PHOTO_ACCEPTED_TYPES as readonly string[]).includes(type)) return "Ce format n'est pas accepté : choisissez une photo JPEG, PNG ou WebP.";
  return null;
}

/** « 2 photos sur 6 ». */
export function photoCountText(count: number): string {
  return `${count} ${count > 1 ? "photos" : "photo"} sur ${PHOTO_MAX_PER_OFFER}`;
}

/** Combien de fichiers de plus peuvent partir (jamais négatif). */
export function remainingSlots(count: number): number {
  return Math.max(0, PHOTO_MAX_PER_OFFER - count);
}

/** Déplace l'élément `from` à la place `to` (hors bornes : ordre inchangé). */
export function moveItem<T>(items: readonly T[], from: number, to: number): T[] {
  const copy = [...items];
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < 0 || from >= copy.length || to >= copy.length || from === to) return copy;
  const [moved] = copy.splice(from, 1);
  copy.splice(to, 0, moved);
  return copy;
}

/** Ordre où la photo choisie passe en tête (la couverture) ; les autres gardent leur ordre. Identifiant inconnu : ordre inchangé. */
export function orderWithCoverFirst(ids: readonly string[], coverId: string): string[] {
  const index = ids.indexOf(coverId);
  return index <= 0 ? [...ids] : moveItem(ids, index, 0);
}

export function orderOf(photos: readonly OfferPhoto[]): string[] {
  return [...photos].sort((a, b) => a.position - b.position).map((photo) => photo.id);
}

/**
 * Lot T3 : photo de COUVERTURE d'une fiche d'annonce (la première photo, dans l'ordre de l'annonce) ; `null` quand l'annonce n'a pas de photo. La vignette à côté du titre montre cette photo
 * quand elle existe et l'icône de la catégorie sinon (jamais l'icône alors qu'une photo existe).
 */
export function coverPhotoIdOf(photos: ReadonlyArray<{ id: string }> | undefined): string | null {
  return photos !== undefined && photos.length > 0 ? photos[0].id : null;
}

/** Texte alternatif d'une photo de la galerie. */
export function galleryAlt(title: string, index: number, total: number): string {
  return total > 1 ? `${title} : photo ${index + 1} sur ${total}` : `${title} : photo`;
}

/** Pourcentage de progression pour une barre (entier 0 à 100). */
export function progressPercent(fraction: number): number {
  return Math.round(Math.max(0, Math.min(1, Number.isFinite(fraction) ? fraction : 0)) * 100);
}
