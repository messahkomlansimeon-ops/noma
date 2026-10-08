"use client";

import { ChevronLeft, ChevronRight, ImagePlus, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { PHOTO_ACCEPT_ATTRIBUTE } from "@/lib/client/photos-api";
import { addPicked, removePicked, type PickedFile, type PickedPhoto } from "@/lib/client/photos-queue";
import { moveItem, PHONE_REMINDER, PHOTOS_ADD_LABEL, PHOTOS_HINT, PHOTOS_TITLE, photoCountText, progressPercent, remainingSlots } from "@/lib/client/photos-view";

/**
 * Photos choisies dans le formulaire d'une annonce (lot PH1) : aperçu local, retrait, ordre (la première est la couverture), progression de l'envoi. Les fichiers ne partent
 * qu'après la création de l'annonce (voir `uploadPicked`) ; ici, rien n'est envoyé.
 */
export function PhotoPicker({ items, onChange, disabled = false }: { items: readonly PickedPhoto[]; onChange: (items: PickedPhoto[]) => void; disabled?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const [message, setMessage] = useState<string | null>(null);
  // Les aperçus (adresses blob) sont libérés quand le composant disparaît.
  const live = useRef<readonly PickedPhoto[]>(items);
  useEffect(() => {
    live.current = items;
  }, [items]);
  useEffect(() => {
    const kept = live;
    return () => {
      for (const item of kept.current) if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
    };
  }, []);

  const onFiles = (list: FileList | null) => {
    if (!list || list.length === 0) return;
    const files = Array.from(list) as PickedFile[];
    if (input.current) input.current.value = "";
    const next = addPicked(items, files, (file) => URL.createObjectURL(file));
    setMessage(next.rejected.length > 0 ? next.rejected.join(" ") : null);
    onChange(next.items);
  };

  const remove = (key: string) => {
    const gone = items.find((item) => item.key === key);
    if (gone?.previewUrl) URL.revokeObjectURL(gone.previewUrl);
    onChange(removePicked(items, key));
  };

  const move = (from: number, to: number) => onChange(moveItem(items, from, to));
  const room = remainingSlots(items.length);
  return (
    <div data-testid="photo-picker">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[13px] font-bold text-ink">{PHOTOS_TITLE} (facultatif)</span>
        <span className="text-[12px] font-semibold text-ink-soft">{photoCountText(items.length)}</span>
      </div>
      {items.length > 0 ? (
        <ul className="mt-2 grid grid-cols-3 gap-2" data-testid="picked-list">
          {items.map((item, index) => (
            <li key={item.key} data-testid="picked-tile" data-status={item.status} className="overflow-hidden rounded-xl border border-line bg-white">
              <div className="relative">
                {item.previewUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element -- aperçu local (adresse blob) d'un fichier choisi
                  <img src={item.previewUrl} alt={`Photo ${index + 1}`} className="aspect-square w-full object-cover" />
                ) : (
                  <div className="aspect-square w-full bg-wash" />
                )}
                {index === 0 ? <span className="absolute left-1 top-1 rounded-md bg-forest px-1.5 py-0.5 text-[10px] font-extrabold uppercase tracking-wide text-white">Couverture</span> : null}
                {item.status === "uploading" ? (
                  <div className="absolute inset-x-0 bottom-0 h-1.5 bg-wash" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progressPercent(item.progress)}>
                    <div className="h-full bg-forest" style={{ width: `${progressPercent(item.progress)}%` }} />
                  </div>
                ) : null}
              </div>
              {item.status === "failed" && item.error ? (
                <p role="alert" data-testid="picked-error" className="px-1.5 pt-1 text-[11px] font-semibold leading-snug text-carrot-ink">
                  {item.error}
                </p>
              ) : null}
              <div className="flex items-center justify-between gap-0.5 p-1">
                <button type="button" disabled={disabled || index === 0} onClick={() => move(index, index - 1)} aria-label="Reculer cette photo" className="flex size-8 items-center justify-center rounded-lg text-ink-soft disabled:opacity-30">
                  <ChevronLeft className="size-4" aria-hidden />
                </button>
                <button type="button" disabled={disabled} onClick={() => remove(item.key)} aria-label="Retirer cette photo" data-testid="picked-remove" className="flex size-8 items-center justify-center rounded-lg text-carrot-ink disabled:opacity-30">
                  <X className="size-4" aria-hidden />
                </button>
                <button type="button" disabled={disabled || index === items.length - 1} onClick={() => move(index, index + 1)} aria-label="Avancer cette photo" className="flex size-8 items-center justify-center rounded-lg text-ink-soft disabled:opacity-30">
                  <ChevronRight className="size-4" aria-hidden />
                </button>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
      {message ? (
        <p role="alert" data-testid="picked-message" className="mt-2 text-[13px] font-semibold text-carrot-ink">
          {message}
        </p>
      ) : null}
      {room > 0 ? (
        <label className={`mt-2 flex w-full cursor-pointer items-center justify-center gap-2 rounded-xl border border-forest/30 bg-white py-3 text-[14px] font-bold text-forest ${disabled ? "pointer-events-none opacity-40" : ""}`}>
          <ImagePlus className="size-4" aria-hidden />
          {PHOTOS_ADD_LABEL}
          <input ref={input} type="file" accept={PHOTO_ACCEPT_ATTRIBUTE} multiple disabled={disabled} onChange={(event) => onFiles(event.target.files)} data-testid="picked-input" className="sr-only" />
        </label>
      ) : null}
      <p className="mt-1.5 text-[11px] leading-relaxed text-ink-soft">{PHOTOS_HINT}</p>
      <p data-testid="photo-phone-reminder" className="mt-1 rounded-lg bg-sage px-2.5 py-1.5 text-[12px] font-semibold leading-snug text-sage-ink">
        {PHONE_REMINDER}
      </p>
    </div>
  );
}
