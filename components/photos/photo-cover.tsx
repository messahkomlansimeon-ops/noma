"use client";

import { useState, type ReactNode } from "react";
import { mediaUrl } from "@/lib/client/photos-api";

/**
 * Vignette de COUVERTURE d'une annonce (lot PH1) : la photo si elle se charge, sinon le repli (l'icône d'avant les photos). Aucun redimensionnement côté serveur : le navigateur
 * affiche en `object-fit: cover` avec `loading="lazy"`. Une photo qu'on n'a plus le droit de voir (annonce dépubliée entre-temps) se replie sans bruit.
 */
export function PhotoCover({ photoId, className = "size-14", fallback }: { photoId: string; className?: string; fallback: ReactNode }) {
  const [failed, setFailed] = useState(false);
  const src = mediaUrl(photoId);
  if (src === null || failed) return <>{fallback}</>;
  return (
    // eslint-disable-next-line @next/next/no-img-element -- fichiers servis par /api/media avec contrôle d'accès (l'optimisation d'images de Next ne les atteindrait pas)
    <img
      src={src}
      alt=""
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      data-testid="photo-cover"
      className={`shrink-0 rounded-xl bg-sage object-cover ${className}`}
    />
  );
}
