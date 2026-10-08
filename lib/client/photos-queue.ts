/**
 * File d'envoi des photos choisies dans le formulaire d'une annonce (lot PH1) : fonctions sans DOM. Une photo choisie est contrôlée tout de suite (taille, format annoncé), garde
 * un aperçu, puis part UNE À LA FOIS une fois l'annonce créée (le serveur a besoin de son identifiant) ; chaque photo a sa progression et son erreur en mots simples. Une photo
 * qui échoue n'arrête pas les autres ni ne perd l'annonce (elle reste en brouillon : les photos se rajoutent depuis la page de l'annonce).
 */

import { ApiError } from "./api";
import { describePhotoError, PHOTO_MAX_PER_OFFER, type PhotosClient } from "./photos-api";
import { checkLocalPhoto, PHOTOS_LIMIT_REACHED, remainingSlots } from "./photos-view";

export interface PickedFile extends Blob {
  readonly name: string;
}

export type PickedStatus = "ready" | "uploading" | "done" | "failed";

export interface PickedPhoto {
  key: string;
  file: PickedFile;
  /** Adresse d'aperçu (`URL.createObjectURL`), à libérer avec `URL.revokeObjectURL` ; null hors navigateur. */
  previewUrl: string | null;
  status: PickedStatus;
  /** 0 à 1. */
  progress: number;
  error: string | null;
}

let sequence = 0;

/**
 * Ajoute des fichiers choisis : ceux qui ne passent pas le contrôle rapide ne sont pas ajoutés (leur raison est renvoyée), et au plus `PHOTO_MAX_PER_OFFER` photos (avec les
 * `existing` déjà enregistrées) restent dans la file (le reste est refusé avec la phrase de la limite).
 */
export function addPicked(
  current: readonly PickedPhoto[],
  files: readonly PickedFile[],
  makePreview: (file: PickedFile) => string | null,
  /** Photos déjà enregistrées sur l'annonce (elles comptent dans la limite de 6). */
  existing = 0,
): { items: PickedPhoto[]; rejected: string[] } {
  const items = [...current];
  const rejected: string[] = [];
  for (const file of files) {
    const refusal = checkLocalPhoto({ name: file.name, size: file.size, type: file.type });
    if (refusal !== null) {
      rejected.push(refusal);
      continue;
    }
    if (remainingSlots(existing + items.length) === 0) {
      if (!rejected.includes(PHOTOS_LIMIT_REACHED)) rejected.push(PHOTOS_LIMIT_REACHED);
      continue;
    }
    sequence += 1;
    items.push({ key: `photo-${sequence}`, file, previewUrl: makePreview(file), status: "ready", progress: 0, error: null });
  }
  return { items, rejected };
}

export function removePicked(items: readonly PickedPhoto[], key: string): PickedPhoto[] {
  return items.filter((item) => item.key !== key);
}

export interface UploadSummary {
  uploaded: number;
  failed: number;
  /** Une réponse 401 : la session a expiré, l'écran redirige vers la connexion. */
  unauthorized: boolean;
}

/**
 * Envoie, l'une après l'autre, les photos `ready` ou `failed` (relance). `onChange` reçoit la liste à jour à chaque étape. S'arrête net à une réponse 401 (session expirée) ou au
 * refus « 6 photos » (les suivantes seraient refusées de la même façon).
 */
export async function uploadPicked(
  offerId: string,
  initial: readonly PickedPhoto[],
  client: Pick<PhotosClient, "upload">,
  onChange: (items: PickedPhoto[]) => void,
  signal?: AbortSignal,
): Promise<UploadSummary> {
  let items = [...initial];
  const update = (key: string, patch: Partial<PickedPhoto>): void => {
    items = items.map((item) => (item.key === key ? { ...item, ...patch } : item));
    onChange(items);
  };
  const summary: UploadSummary = { uploaded: 0, failed: 0, unauthorized: false };
  for (const item of initial) {
    if (item.status !== "ready" && item.status !== "failed") continue;
    if (signal?.aborted) break;
    update(item.key, { status: "uploading", progress: 0, error: null });
    try {
      await client.upload(offerId, item.file, { signal, onProgress: (fraction) => update(item.key, { progress: fraction }) });
      summary.uploaded += 1;
      update(item.key, { status: "done", progress: 1 });
    } catch (failure) {
      summary.failed += 1;
      update(item.key, { status: "failed", error: describePhotoError(failure) });
      if (failure instanceof ApiError && failure.status === 401) {
        summary.unauthorized = true;
        break;
      }
      if (failure instanceof ApiError && failure.code === "photo_limit") break;
    }
  }
  return summary;
}

export const PICKED_LIMIT = PHOTO_MAX_PER_OFFER;
