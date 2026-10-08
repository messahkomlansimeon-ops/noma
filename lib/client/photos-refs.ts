/**
 * Références de photos reçues par les écrans (lot PH1) : module FEUILLE (aucun import), partagé par les relectures de réponses de `api.ts`, `social-api.ts` et `photos-api.ts`.
 * Un identifiant de couverture n'est lu que s'il est un UUID ; une référence invalide est IGNORÉE (une photo en trop ou abîmée ne casse jamais une liste ni une fiche).
 */

/** Copie de la borne du serveur (lib/server/media/config.ts : `PHOTO_MAX_PER_OFFER`) ; un essai vérifie qu'elles sont identiques. */
export const PHOTO_REFS_MAX = 6;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Référence publique d'une photo (acheteur) : l'identifiant et les dimensions (pour réserver la place de l'image). */
export interface PhotoRef {
  id: string;
  width: number;
  height: number;
}

const isDimension = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= 65_535;

/** URL du fichier d'une photo (`/api/media/{id}`) ; `null` si l'identifiant n'est pas un UUID (aucune URL n'est construite à la main). */
export function mediaUrl(photoId: string | null | undefined): string | null {
  return typeof photoId === "string" && UUID.test(photoId) ? `/api/media/${photoId.toLowerCase()}` : null;
}

/** Identifiant de couverture (acheteur, vendeur, favoris) : un UUID en minuscules, sinon `null` (toute autre valeur est ignorée). */
export function parseCoverPhotoId(value: unknown): string | null {
  return typeof value === "string" && UUID.test(value) ? value.toLowerCase() : null;
}

/** Références publiques d'une fiche : identifiant et dimensions seulement, au plus 6, les entrées invalides ignorées. */
export function parsePhotoRefs(value: unknown): PhotoRef[] {
  if (!Array.isArray(value)) return [];
  const refs: PhotoRef[] = [];
  for (const entry of value.slice(0, PHOTO_REFS_MAX)) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
    const { id, width, height } = entry as Record<string, unknown>;
    if (typeof id === "string" && UUID.test(id) && isDimension(width) && isDimension(height)) refs.push({ id: id.toLowerCase(), width, height });
  }
  return refs;
}
