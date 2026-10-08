"use client";

import { useState } from "react";
import { galleryAlt } from "@/lib/client/photos-view";
import { mediaUrl, type PhotoRef } from "@/lib/client/photos-api";

/**
 * Galerie de la fiche d'une annonce pour l'acheteur (lot PH1) : la photo choisie en grand (la première par défaut), la rangée de vignettes dessous. La place de l'image est réservée
 * d'après les dimensions de la première photo (pas de saut de page au chargement). Une photo qui ne se charge pas est retirée de la galerie sans bruit ; sans photo, rien n'est affiché.
 */
export function PhotoGallery({ photos, title }: { photos: readonly PhotoRef[]; title: string }) {
  const [selected, setSelected] = useState(0);
  const [failed, setFailed] = useState<readonly string[]>([]);
  const usable = photos.filter((photo) => !failed.includes(photo.id) && mediaUrl(photo.id) !== null);
  if (usable.length === 0) return null;
  const index = Math.min(selected, usable.length - 1);
  const current = usable[index];
  const drop = (id: string) => setFailed((known) => (known.includes(id) ? known : [...known, id]));
  return (
    <section aria-label="Photos de l'annonce" data-testid="photo-gallery" className="mb-3">
      <div className="overflow-hidden rounded-2xl bg-wash" style={{ aspectRatio: "4 / 3" }}>
        {/* eslint-disable-next-line @next/next/no-img-element -- fichiers servis par /api/media avec contrôle d'accès */}
        <img
          key={current.id}
          src={mediaUrl(current.id) as string}
          alt={galleryAlt(title, index, usable.length)}
          loading={index === 0 ? "eager" : "lazy"}
          decoding="async"
          referrerPolicy="no-referrer"
          width={current.width}
          height={current.height}
          onError={() => drop(current.id)}
          data-testid="gallery-main"
          className="size-full object-cover"
        />
      </div>
      {usable.length > 1 ? (
        <ul className="mt-2 flex gap-2 overflow-x-auto" aria-label="Choisir une photo">
          {usable.map((photo, position) => (
            <li key={photo.id} className="shrink-0">
              <button
                type="button"
                onClick={() => setSelected(position)}
                aria-label={`Voir la photo ${position + 1} sur ${usable.length}`}
                aria-current={position === index ? "true" : undefined}
                data-testid="gallery-thumb"
                className={`block overflow-hidden rounded-xl border-2 ${position === index ? "border-forest" : "border-transparent"}`}
              >
                {/* eslint-disable-next-line @next/next/no-img-element -- fichiers servis par /api/media avec contrôle d'accès */}
                <img
                  src={mediaUrl(photo.id) as string}
                  alt=""
                  loading="lazy"
                  decoding="async"
                  referrerPolicy="no-referrer"
                  onError={() => drop(photo.id)}
                  className="size-14 object-cover"
                />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
