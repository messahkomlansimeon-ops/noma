"use client";

import { ChevronLeft, ChevronRight, ImagePlus, Images, ShieldCheck, Star, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useUnauthorizedRedirect } from "@/components/session-gate";
import { ErrorState, LoadingBlock, Notice, SectionHeading } from "@/components/vendor/vendor-parts";
import { ApiError } from "@/lib/client/api";
import { describePhotoError, mediaUrl, PHOTO_ACCEPT_ATTRIBUTE, PHOTO_MAX_PER_OFFER, photosApi, type OfferPhoto } from "@/lib/client/photos-api";
import { addPicked, uploadPicked, type PickedFile, type PickedPhoto } from "@/lib/client/photos-queue";
import {
  moveItem, orderOf, orderWithCoverFirst, PHONE_REMINDER, PHOTOS_ADD_LABEL, PHOTOS_HINT, PHOTOS_LIMIT_REACHED, PHOTOS_TITLE, photoCountText, progressPercent, remainingSlots,
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
  const tileBtn = "press flex size-11 items-center justify-center rounded-xl text-ink-soft hover:bg-mist disabled:opacity-30";
  return (
    <section aria-labelledby="photos-title" data-testid="photo-manager">
      <SectionHeading
        icon={Images}
        id="photos-title"
        aside={
          photos ? (
            <span data-testid="photo-count" className="rounded-full bg-mist px-3 py-1 text-[13px] font-bold text-ink-soft">
              {photoCountText(count)}
            </span>
          ) : null
        }
      >
        {PHOTOS_TITLE}
      </SectionHeading>

      {loadError ? (
        <ErrorState
          message={loadError}
          onRetry={() => {
            setLoadError(null);
            setReloadKey((key) => key + 1);
          }}
        />
      ) : photos === null ? (
        <LoadingBlock label="Chargement des photos…" rows={1} rowClassName="h-32 w-full rounded-3xl" className="mt-3" />
      ) : (
        <>
          {photos.length > 0 ? (
            <ul className="stagger mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3" data-testid="photo-list">
              {photos.map((photo, index) => (
                <li key={photo.id} data-testid="photo-tile" data-photo-id={photo.id} data-cover={photo.position === 0 ? "true" : "false"} className="overflow-hidden rounded-3xl border border-line bg-white">
                  <div className="relative">
                    {/* eslint-disable-next-line @next/next/no-img-element -- fichiers servis par /api/media avec contrôle d'accès */}
                    <img src={mediaUrl(photo.id) ?? undefined} alt={`Photo ${index + 1}`} loading="lazy" decoding="async" referrerPolicy="no-referrer" className="aspect-square w-full object-cover" />
                    {photo.position === 0 ? (
                      <span className="absolute left-2 top-2 rounded-full bg-brand px-2.5 py-1 text-[12px] font-extrabold text-white shadow-sm">Couverture</span>
                    ) : null}
                  </div>
                  {readOnly ? null : (
                    <div className="flex items-center justify-between p-1">
                      <button type="button" disabled={busy || index === 0} onClick={() => void reorder(moveItem(ids, index, index - 1))} aria-label="Reculer cette photo" data-testid="photo-move-left" className={tileBtn}>
                        <ChevronLeft className="size-5" aria-hidden />
                      </button>
                      <button type="button" disabled={busy || index === 0} onClick={() => void reorder(orderWithCoverFirst(ids, photo.id))} aria-label="Mettre en couverture" data-testid="photo-cover-button" className={tileBtn}>
                        <Star className="size-5" aria-hidden />
                      </button>
                      <button type="button" disabled={busy || index === photos.length - 1} onClick={() => void reorder(moveItem(ids, index, index + 1))} aria-label="Avancer cette photo" data-testid="photo-move-right" className={tileBtn}>
                        <ChevronRight className="size-5" aria-hidden />
                      </button>
                    </div>
                  )}
                  <div className="border-t border-line p-1">
                    {confirming === photo.id ? (
                      <div className="flex gap-1">
                        <button type="button" disabled={busy} onClick={() => void remove(photo.id)} data-testid="photo-delete-confirm" className="press min-h-11 flex-1 rounded-xl bg-accent px-1 text-[13px] font-bold text-ink disabled:opacity-40">
                          Confirmer
                        </button>
                        <button type="button" onClick={() => setConfirming(null)} className="press min-h-11 flex-1 rounded-xl bg-mist px-1 text-[13px] font-bold text-ink">
                          Annuler
                        </button>
                      </div>
                    ) : (
                      <button type="button" disabled={busy} onClick={() => setConfirming(photo.id)} aria-label="Supprimer cette photo" data-testid="photo-delete" className="press flex min-h-11 w-full items-center justify-center gap-1.5 rounded-xl text-[13px] font-bold text-danger-ink hover:bg-danger-soft disabled:opacity-40">
                        <Trash2 className="size-4" aria-hidden />
                        Supprimer
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          ) : null}

          {picked.length > 0 ? (
            <ul className="mt-3 space-y-2" data-testid="photo-uploads" aria-live="polite">
              {picked.map((item) => (
                <li key={item.key} data-status={item.status} className="flex items-center gap-3 rounded-2xl border border-line bg-white p-2.5">
                  {item.previewUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element -- aperçu local (adresse blob) d'un fichier choisi
                    <img src={item.previewUrl} alt="" className="size-14 shrink-0 rounded-xl object-cover" />
                  ) : (
                    <span className="size-14 shrink-0 rounded-xl bg-mist" />
                  )}
                  <div className="min-w-0 flex-1">
                    {item.status === "failed" ? (
                      <p role="alert" data-testid="photo-error" className="text-[13px] font-semibold text-danger-ink">
                        {item.error}
                      </p>
                    ) : (
                      <>
                        <p className="text-[13px] font-semibold text-ink">{item.status === "done" ? "Photo envoyée" : item.status === "uploading" ? "Envoi en cours…" : "En attente"}</p>
                        <div className="mt-1.5 h-2 w-full overflow-hidden rounded-full bg-mist" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progressPercent(item.progress)} data-testid="photo-progress">
                          <div className="h-full rounded-full bg-brand transition-all" style={{ width: `${progressPercent(item.progress)}%` }} />
                        </div>
                      </>
                    )}
                  </div>
                  {item.status === "failed" ? (
                    <button type="button" onClick={() => dismissFailed(item.key)} aria-label="Fermer ce message" className="press flex size-11 shrink-0 items-center justify-center rounded-xl text-ink-soft hover:bg-mist">
                      <X className="size-5" aria-hidden />
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}

          {message ? (
            <Notice tone="danger" role="alert" data-testid="photo-message" className="mt-3">
              {message}
            </Notice>
          ) : null}

          {readOnly ? null : room > 0 ? (
            <label
              className={`press mt-3 flex w-full cursor-pointer flex-col items-center justify-center gap-1.5 rounded-3xl border-2 border-dashed border-brand/40 bg-brand-soft/50 px-4 text-[15px] font-bold text-brand hover:bg-brand-soft ${
                photos.length === 0 && picked.length === 0 ? "min-h-32" : "min-h-16"
              } ${busy ? "pointer-events-none opacity-40" : ""}`}
            >
              <ImagePlus className={photos.length === 0 && picked.length === 0 ? "size-9" : "size-6"} aria-hidden />
              {PHOTOS_ADD_LABEL}
              <input ref={input} type="file" accept={PHOTO_ACCEPT_ATTRIBUTE} multiple disabled={busy} onChange={(event) => void onFiles(event.target.files)} data-testid="photo-add-input" className="sr-only" />
            </label>
          ) : (
            <Notice tone="mist" data-testid="photo-limit" className="mt-3">
              {PHOTOS_LIMIT_REACHED}
            </Notice>
          )}
          <p className="mt-2 text-[12px] leading-snug text-ink-soft">{PHOTOS_HINT}</p>
          <Notice tone="brand" icon={ShieldCheck} data-testid="photo-phone-reminder" className="mt-2" small>
            {PHONE_REMINDER}
          </Notice>
          <span className="sr-only">{`Maximum ${PHOTO_MAX_PER_OFFER} photos.`}</span>
        </>
      )}
    </section>
  );
}
