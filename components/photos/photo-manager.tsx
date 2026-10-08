"use client";

import { ChevronLeft, ChevronRight, ImagePlus, Star, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useUnauthorizedRedirect } from "@/components/session-gate";
import { ApiError } from "@/lib/client/api";
import { describePhotoError, mediaUrl, PHOTO_ACCEPT_ATTRIBUTE, PHOTO_MAX_PER_OFFER, photosApi, type OfferPhoto } from "@/lib/client/photos-api";
import { addPicked, uploadPicked, type PickedFile, type PickedPhoto } from "@/lib/client/photos-queue";
import {
  moveItem, orderOf, orderWithCoverFirst, PHONE_REMINDER, PHOTOS_ADD_LABEL, PHOTOS_EMPTY, PHOTOS_HINT, PHOTOS_LIMIT_REACHED, PHOTOS_TITLE, photoCountText, progressPercent, remainingSlots,
} from "@/lib/client/photos-view";

/**
 * Photos d'UNE annonce du vendeur (lot PH1) : ajout (aperçu, progression, erreurs en mots simples), changement d'ordre (la première photo est la couverture), suppression en deux
 * temps. Tout passe par `/api/offers/{id}/photos` ; le serveur relit les octets, retire les métadonnées de chaque photo et refuse le reste. Une annonce archivée ne reçoit plus
 * de photo mais peut encore en retirer.
 */
export function PhotoManager({ offerId, readOnly = false, onChange }: { offerId: string; readOnly?: boolean; onChange?: (photos: OfferPhoto[]) => void }) {
  const redirectIfUnauthorized = useUnauthorizedRedirect();
  const [photos, setPhotos] = useState<OfferPhoto[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [picked, setPicked] = useState<PickedPhoto[]>([]);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    photosApi.list(offerId, { signal: controller.signal }).then(
      (loaded) => {
        setPhotos(loaded);
        setLoadError(null);
      },
      (failure) => {
        if (controller.signal.aborted || redirectIfUnauthorized(failure)) return;
        setLoadError(describePhotoError(failure));
      },
    );
    return () => controller.abort();
  }, [offerId, reloadKey, redirectIfUnauthorized]);

  useEffect(() => {
    if (photos) onChange?.(photos);
  }, [photos, onChange]);

  const releasePreviews = useCallback((items: readonly PickedPhoto[]) => {
    for (const item of items) if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
  }, []);

  const onFiles = async (list: FileList | null) => {
    if (!list || list.length === 0 || busy || !photos) return;
    const files = Array.from(list) as PickedFile[];
    if (input.current) input.current.value = "";
    const { items, rejected } = addPicked([], files, (file) => URL.createObjectURL(file), photos.length);
    setMessage(rejected.length > 0 ? rejected.join(" ") : null);
    if (items.length === 0) return;
    setBusy(true);
    setPicked(items);
    const summary = await uploadPicked(offerId, items, photosApi, setPicked);
    if (summary.unauthorized) redirectIfUnauthorized(new ApiError(401, "authentication_required", "Authentification requise."));
    try {
      setPhotos(await photosApi.list(offerId));
    } catch (failure) {
      if (!redirectIfUnauthorized(failure)) setMessage(describePhotoError(failure));
    }
    // Les photos envoyées disparaissent de la file ; celles qui ont échoué restent, avec leur raison.
    setPicked((current) => {
      const stay = current.filter((item) => item.status === "failed");
      releasePreviews(current.filter((item) => item.status !== "failed"));
      return stay;
    });
    setBusy(false);
  };

  const dismissFailed = (key: string) => {
    setPicked((current) => {
      releasePreviews(current.filter((item) => item.key === key));
      return current.filter((item) => item.key !== key);
    });
  };

  const reorder = async (order: string[]) => {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    try {
      setPhotos(await photosApi.reorder(offerId, order));
    } catch (failure) {
      if (!redirectIfUnauthorized(failure)) setMessage(describePhotoError(failure));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (photoId: string) => {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    setConfirming(null);
    try {
      setPhotos((await photosApi.remove(offerId, photoId)).photos);
    } catch (failure) {
      if (!redirectIfUnauthorized(failure)) setMessage(describePhotoError(failure));
    } finally {
      setBusy(false);
    }
  };

  const ids = photos ? orderOf(photos) : [];
  const count = photos?.length ?? 0;
  const room = remainingSlots(count);
  return (
    <section aria-labelledby="photos-title" className="mt-5" data-testid="photo-manager">
      <div className="flex items-baseline justify-between gap-2">
        <h2 id="photos-title" className="text-[16px] font-extrabold text-ink">
          {PHOTOS_TITLE}
        </h2>
        {photos ? (
          <span data-testid="photo-count" className="text-[12px] font-semibold text-ink-soft">
            {photoCountText(count)}
          </span>
        ) : null}
      </div>

      {loadError ? (
        <div role="alert" className="mt-2 rounded-2xl border border-line bg-white p-3 text-center">
          <p className="text-[13px] font-semibold text-ink">{loadError}</p>
          <button
            type="button"
            onClick={() => {
              setLoadError(null);
              setReloadKey((key) => key + 1);
            }}
            className="mt-2 rounded-xl bg-forest px-4 py-2 text-[13px] font-bold text-white"
          >
            Réessayer
          </button>
        </div>
      ) : photos === null ? (
        <p className="mt-2 text-[13px] text-ink-soft" aria-busy="true">
          Chargement des photos…
        </p>
      ) : (
        <>
          {photos.length === 0 && picked.length === 0 ? <p className="mt-2 text-[13px] text-ink-soft">{PHOTOS_EMPTY}</p> : null}
          {photos.length > 0 ? (
            <ul className="mt-2 grid grid-cols-3 gap-2" data-testid="photo-list">
              {photos.map((photo, index) => (
                <li key={photo.id} data-testid="photo-tile" data-photo-id={photo.id} data-cover={photo.position === 0 ? "true" : "false"} className="overflow-hidden rounded-xl border border-line bg-white">
                  <div className="relative">
                    {/* eslint-disable-next-line @next/next/no-img-element -- fichiers servis par /api/media avec contrôle d'accès */}
                    <img src={mediaUrl(photo.id) ?? undefined} alt={`Photo ${index + 1}`} loading="lazy" decoding="async" referrerPolicy="no-referrer" className="aspect-square w-full object-cover" />
                    {photo.position === 0 ? (
                      <span className="absolute left-1 top-1 rounded-md bg-forest px-1.5 py-0.5 text-[10px] font-extrabold uppercase tracking-wide text-white">Couverture</span>
                    ) : null}
                  </div>
                  {readOnly ? null : (
                    <div className="flex items-center justify-between gap-0.5 p-1">
                      <button type="button" disabled={busy || index === 0} onClick={() => void reorder(moveItem(ids, index, index - 1))} aria-label="Reculer cette photo" data-testid="photo-move-left" className="flex size-8 items-center justify-center rounded-lg text-ink-soft disabled:opacity-30">
                        <ChevronLeft className="size-4" aria-hidden />
                      </button>
                      <button type="button" disabled={busy || index === 0} onClick={() => void reorder(orderWithCoverFirst(ids, photo.id))} aria-label="Mettre en couverture" data-testid="photo-cover-button" className="flex size-8 items-center justify-center rounded-lg text-ink-soft disabled:opacity-30">
                        <Star className="size-4" aria-hidden />
                      </button>
                      <button type="button" disabled={busy || index === photos.length - 1} onClick={() => void reorder(moveItem(ids, index, index + 1))} aria-label="Avancer cette photo" data-testid="photo-move-right" className="flex size-8 items-center justify-center rounded-lg text-ink-soft disabled:opacity-30">
                        <ChevronRight className="size-4" aria-hidden />
                      </button>
                    </div>
                  )}
                  <div className="border-t border-line p-1">
                    {confirming === photo.id ? (
                      <div className="flex gap-1">
                        <button type="button" disabled={busy} onClick={() => void remove(photo.id)} data-testid="photo-delete-confirm" className="flex-1 rounded-lg bg-carrot px-1 py-1.5 text-[11px] font-bold text-white disabled:opacity-40">
                          Confirmer
                        </button>
                        <button type="button" onClick={() => setConfirming(null)} className="flex-1 rounded-lg bg-wash px-1 py-1.5 text-[11px] font-bold text-ink">
                          Annuler
                        </button>
                      </div>
                    ) : (
                      <button type="button" disabled={busy} onClick={() => setConfirming(photo.id)} aria-label="Supprimer cette photo" data-testid="photo-delete" className="flex w-full items-center justify-center gap-1 rounded-lg py-1.5 text-[11px] font-bold text-carrot-ink disabled:opacity-40">
                        <Trash2 className="size-3.5" aria-hidden />
                        Supprimer
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          ) : null}

          {picked.length > 0 ? (
            <ul className="mt-2 space-y-2" data-testid="photo-uploads" aria-live="polite">
              {picked.map((item) => (
                <li key={item.key} data-status={item.status} className="flex items-center gap-3 rounded-xl border border-line bg-white p-2">
                  {item.previewUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element -- aperçu local (adresse blob) d'un fichier choisi
                    <img src={item.previewUrl} alt="" className="size-12 shrink-0 rounded-lg object-cover" />
                  ) : (
                    <span className="size-12 shrink-0 rounded-lg bg-wash" />
                  )}
                  <div className="min-w-0 flex-1">
                    {item.status === "failed" ? (
                      <p role="alert" data-testid="photo-error" className="text-[12px] font-semibold text-carrot-ink">
                        {item.error}
                      </p>
                    ) : (
                      <>
                        <p className="text-[12px] font-semibold text-ink">{item.status === "done" ? "Photo envoyée" : item.status === "uploading" ? "Envoi en cours…" : "En attente"}</p>
                        <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-wash" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progressPercent(item.progress)} data-testid="photo-progress">
                          <div className="h-full rounded-full bg-forest" style={{ width: `${progressPercent(item.progress)}%` }} />
                        </div>
                      </>
                    )}
                  </div>
                  {item.status === "failed" ? (
                    <button type="button" onClick={() => dismissFailed(item.key)} aria-label="Fermer ce message" className="flex size-8 shrink-0 items-center justify-center rounded-lg text-ink-soft">
                      <X className="size-4" aria-hidden />
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}

          {message ? (
            <p role="alert" data-testid="photo-message" className="mt-2 text-[13px] font-semibold text-carrot-ink">
              {message}
            </p>
          ) : null}

          {readOnly ? null : room > 0 ? (
            <label
              className={`mt-2.5 flex w-full cursor-pointer items-center justify-center gap-2 rounded-xl border border-forest/30 bg-white py-3 text-[14px] font-bold text-forest ${busy ? "pointer-events-none opacity-40" : ""}`}
            >
              <ImagePlus className="size-4" aria-hidden />
              {PHOTOS_ADD_LABEL}
              <input ref={input} type="file" accept={PHOTO_ACCEPT_ATTRIBUTE} multiple disabled={busy} onChange={(event) => void onFiles(event.target.files)} data-testid="photo-add-input" className="sr-only" />
            </label>
          ) : (
            <p data-testid="photo-limit" className="mt-2 text-[12px] font-semibold text-ink-soft">
              {PHOTOS_LIMIT_REACHED}
            </p>
          )}
          <p className="mt-1.5 text-[11px] leading-relaxed text-ink-soft">{PHOTOS_HINT}</p>
          <p data-testid="photo-phone-reminder" className="mt-1 rounded-lg bg-sage px-2.5 py-1.5 text-[12px] font-semibold leading-snug text-sage-ink">
            {PHONE_REMINDER}
          </p>
          <span className="sr-only">{`Maximum ${PHOTO_MAX_PER_OFFER} photos.`}</span>
        </>
      )}
    </section>
  );
}
