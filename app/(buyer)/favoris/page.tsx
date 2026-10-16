"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowRight, Heart, RotateCw, TriangleAlert } from "lucide-react";
import { ArtAlert, ArtHeart } from "@/components/illustrations";
import { PhotoCover } from "@/components/photos/photo-cover";
import { SessionGate, useUnauthorizedRedirect } from "@/components/session-gate";
import { TopBar } from "@/components/top-bar";
import { Badge, Btn, EmptyState, IconTile, Skeleton } from "@/components/ui";
import {
  FAVORITES_EMPTY,
  FAVORITES_LOADING,
  FAVORITES_TITLE,
  OPEN_LISTING_LABEL,
  REMOVE_FAVORITE_LABEL,
  favoriteRow,
} from "@/lib/client/favorites-view";
import { describeSocialError, social, type FavoriteItem } from "@/lib/client/social-api";

/** Mes favoris (lot D2) : titre, prix et statut ; « n'est plus disponible » si l'annonce n'est plus en ligne ; lien vers la fiche par le besoin d'origine ; retrait. */
function Favorites() {
  const redirectIfUnauthorized = useUnauthorizedRedirect();
  const [items, setItems] = useState<FavoriteItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const busy = useRef<Set<string>>(new Set());

  useEffect(() => {
    const controller = new AbortController();
    social.favorites.list({ signal: controller.signal }).then(
      (list) => {
        setItems(list);
        setError(null);
      },
      (failure) => {
        if (controller.signal.aborted || redirectIfUnauthorized(failure)) return;
        setError(describeSocialError(failure, "favorites"));
      },
    );
    return () => controller.abort();
  }, [reloadKey, redirectIfUnauthorized]);

  const remove = useCallback(
    async (offerId: string) => {
      if (busy.current.has(offerId)) return;
      busy.current.add(offerId);
      setActionError(null);
      try {
        await social.favorites.remove(offerId);
        setItems((current) => (current === null ? current : current.filter((item) => item.offerId !== offerId)));
      } catch (failure) {
        if (redirectIfUnauthorized(failure)) return;
        setActionError(describeSocialError(failure, "favorites"));
      } finally {
        busy.current.delete(offerId);
      }
    },
    [redirectIfUnauthorized],
  );

  return (
    <main>
      {/* Lot FIN1 : le titre n'est dit qu'une fois (le h1) : plus de « Mes favoris » en double dans la barre du haut. */}
      <TopBar back="/" />
      <div className="flex flex-col gap-4 px-4 pb-6 pt-1">
        <h1 className="text-[24px] font-extrabold tracking-tight text-ink">{FAVORITES_TITLE}</h1>
        {error ? (
          <div role="alert" className="animate-rise flex flex-col items-center gap-4 px-6 py-8 text-center">
            <ArtAlert className="size-28" />
            <p className="text-[16px] font-bold text-ink">{error}</p>
            <div className="w-full max-w-xs">
              <Btn
                onClick={() => {
                  setError(null);
                  setReloadKey((key) => key + 1);
                }}
              >
                <RotateCw className="size-5" aria-hidden />
                Réessayer
              </Btn>
            </div>
          </div>
        ) : items === null ? (
          <div className="flex flex-col gap-3" aria-busy="true">
            <span className="sr-only">{FAVORITES_LOADING}</span>
            <Skeleton className="h-28 w-full rounded-3xl" />
            <Skeleton className="h-28 w-full rounded-3xl" />
          </div>
        ) : items.length === 0 ? (
          <div role="status" data-testid="favorites-empty">
            <EmptyState art={<ArtHeart className="size-36" />} title={FAVORITES_EMPTY} />
          </div>
        ) : (
          <>
            {actionError ? (
              <p role="alert" className="flex items-start gap-2 rounded-2xl bg-accent-soft px-3.5 py-3 text-[14px] font-semibold text-accent-ink">
                <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
                {actionError}
              </p>
            ) : null}
            <ul aria-label="Vos annonces gardées" className="stagger flex flex-col gap-3 md:grid md:grid-cols-2" data-testid="favorites-list">
              {items.map((item) => {
                const row = favoriteRow(item);
                const iconFallback = <IconTile icon={Heart} tone="accent" className="size-16" />;
                return (
                  <li key={row.offerId} data-testid="favorite-row" data-available={row.available ? "true" : "false"} className="flex flex-col gap-2 rounded-3xl border border-line bg-white p-3.5">
                    <div className="flex items-center gap-3">
                      {row.coverPhotoId ? <PhotoCover photoId={row.coverPhotoId} className="size-16" fallback={iconFallback} /> : iconFallback}
                      <div className="min-w-0 flex-1">
                        <div className="line-clamp-2 text-[16px] font-bold leading-snug text-ink">{row.title}</div>
                        {row.priceText ? <div className="text-[20px] font-extrabold leading-tight text-ink">{row.priceText}</div> : null}
                        <Badge tone={row.available ? "sage" : "wash"} className="mt-1">
                          {row.statusText}
                        </Badge>
                      </div>
                      <button
                        onClick={() => void remove(row.offerId)}
                        aria-label={`${REMOVE_FAVORITE_LABEL} : ${row.title}`}
                        title={REMOVE_FAVORITE_LABEL}
                        data-testid="favorite-remove"
                        className="press flex size-12 shrink-0 items-center justify-center rounded-full border-2 border-line bg-white hover:border-line-strong"
                      >
                        <Heart className="size-6 fill-accent text-accent" aria-hidden />
                      </button>
                    </div>
                    {row.href ? (
                      <Link href={row.href} className="press flex min-h-11 items-center justify-end gap-1 text-[14px] font-bold text-brand">
                        {OPEN_LISTING_LABEL}
                        <ArrowRight className="size-4" aria-hidden />
                      </Link>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </div>
    </main>
  );
}

export default function FavorisPage() {
  return (
    <SessionGate>
      <Favorites />
    </SessionGate>
  );
}
