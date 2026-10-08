/**
 * Présentation des favoris (lot D2) : fonctions PURES. Une annonce gardée affiche son titre, son prix et son statut ; si l'annonce n'est plus en ligne : « n'est plus
 * disponible » ; le lien rouvre la fiche DANS le contexte du besoin d'origine (seulement tant que la correspondance existe).
 */

import { formatMoney } from "./catalog-view";
import type { FavoriteItem } from "./social-api";

export const FAVORITES_TITLE = "Mes favoris";
export const FAVORITES_LOADING = "Chargement de vos favoris…";
export const FAVORITES_EMPTY = "Aucun favori pour le moment.";
export const FAVORITES_EMPTY_HINT = "Touchez le cœur sur la fiche d'une annonce pour la garder de côté.";
export const FAVORITES_LIMIT = 200;
export const GONE_TEXT = "n'est plus disponible";
export const ADD_FAVORITE_LABEL = "Garder cette annonce";
export const REMOVE_FAVORITE_LABEL = "Retirer des favoris";
export const OPEN_LISTING_LABEL = "Voir l'annonce";

export interface FavoriteRowView {
  offerId: string;
  title: string;
  priceText: string | null;
  /** « En ligne » ou « n'est plus disponible ». */
  statusText: string;
  available: boolean;
  /** Fiche dans le contexte du besoin d'origine, ou null (annonce retirée, correspondance perdue). */
  href: string | null;
  /** Lot PH1 : photo de couverture ; absente quand l'annonce n'a pas de photo (rien n'est affiché à sa place). */
  coverPhotoId?: string;
}

export function favoriteRow(item: FavoriteItem): FavoriteRowView {
  return {
    offerId: item.offerId,
    title: item.title,
    // Lot D3 : une annonce qui n'est plus disponible n'affiche plus de prix (même si le serveur en envoyait un).
    priceText: item.available ? formatMoney(item.price) : null,
    statusText: item.available ? "En ligne" : `Cette annonce ${GONE_TEXT}.`,
    available: item.available,
    href: item.available && item.openable ? `/besoins/${item.demandId}/offres/${item.offerId}` : null,
    ...(item.coverPhotoId === undefined ? {} : { coverPhotoId: item.coverPhotoId }),
  };
}

/** Vrai si l'annonce est dans la liste des favoris (sert au cœur de la fiche). */
export function isFavorite(items: readonly FavoriteItem[], offerId: string): boolean {
  return items.some((item) => item.offerId === offerId);
}
