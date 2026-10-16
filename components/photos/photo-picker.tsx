"use client";

import { ChevronLeft, ChevronRight, ImagePlus, Images, ShieldCheck, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Notice } from "@/components/vendor/vendor-parts";
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
  const tileBtn = "press flex size-11 items-center justify-center rounded-xl hover:bg-mist disabled:opacity-30";
  return (
    <div data-testid="photo-picker">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-2 text-[14px] font-bold text-ink">
          <Images className="size-4 shrink-0 text-brand" aria-hidden />
          {PHOTOS_TITLE} (facultatif)
        </span>
        <span className="rounded-full bg-mist px-3 py-1 text-[13px] font-bold text-ink-soft">{photoCountText(items.length)}</span>
      </div>
      {items.length > 0 ? (
        <ul className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3" data-testid="picked-list">
          {items.map((item, index) => (
            <li key={item.key} data-testid="picked-tile" data-status={item.status} className="overflow-hidden rounded-3xl border border-line bg-white">
              <div className="relative">
                {item.previewUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element -- aperçu local (adresse blob) d'un fichier choisi
                  <img src={item.previewUrl} alt={`Photo ${index + 1}`} className="aspect-square w-full object-cover" />
                ) : (
                  <div className="aspect-square w-full bg-mist" />
                )}
                {index === 0 ? <span className="absolute left-2 top-2 rounded-full bg-brand px-2.5 py-1 text-[12px] font-extrabold text-white shadow-sm">Couverture</span> : null}
                {item.status === "uploading" ? (
                  <div className="absolute inset-x-0 bottom-0 h-2 bg-mist" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progressPercent(item.progress)}>
                    <div className="h-full bg-brand" style={{ width: `${progressPercent(item.progress)}%` }} />
                  </div>
                ) : null}
              </div>
              {item.status === "failed" && item.error ? (
                <p role="alert" data-testid="picked-error" className="px-2 pt-1.5 text-[13px] font-semibold leading-snug text-danger-ink">
                  {item.error}
                </p>
              ) : null}
              <div className="flex items-center justify-between p-1">
                <button type="button" disabled={disabled || index === 0} onClick={() => move(index, index - 1)} aria-label="Reculer cette photo" className={`${tileBtn} text-ink-soft`}>
                  <ChevronLeft className="size-5" aria-hidden />
                </button>
                <button type="button" disabled={disabled} onClick={() => remove(item.key)} aria-label="Retirer cette photo" data-testid="picked-remove" className={`${tileBtn} text-danger-ink`}>
                  <X className="size-5" aria-hidden />
                </button>
                <button type="button" disabled={disabled || index === items.length - 1} onClick={() => move(index, index + 1)} aria-label="Avancer cette photo" className={`${tileBtn} text-ink-soft`}>
                  <ChevronRight className="size-5" aria-hidden />
                </button>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
      {message ? (
        <Notice tone="danger" role="alert" data-testid="picked-message" className="mt-3">
          {message}
        </Notice>
      ) : null}
      {room > 0 ? (
        <label
          className={`press mt-3 flex w-full cursor-pointer flex-col items-center justify-center gap-1.5 rounded-3xl border-2 border-dashed border-brand/40 bg-brand-soft/50 px-4 text-[15px] font-bold text-brand hover:bg-brand-soft ${
            items.length === 0 ? "min-h-28" : "min-h-16"
          } ${disabled ? "pointer-events-none opacity-40" : ""}`}
        >
          <ImagePlus className={items.length === 0 ? "size-8" : "size-6"} aria-hidden />
          {PHOTOS_ADD_LABEL}
          <input ref={input} type="file" accept={PHOTO_ACCEPT_ATTRIBUTE} multiple disabled={disabled} onChange={(event) => onFiles(event.target.files)} data-testid="picked-input" className="sr-only" />
        </label>
      ) : null}
      <p className="mt-2 text-[12px] leading-snug text-ink-soft">{PHOTOS_HINT}</p>
      <Notice tone="brand" icon={ShieldCheck} data-testid="photo-phone-reminder" className="mt-2" small>
        {PHONE_REMINDER}
      </Notice>
    </div>
  );
}
