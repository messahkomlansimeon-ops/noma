"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Heart } from "lucide-react";
import { SessionGate, useUnauthorizedRedirect } from "@/components/session-gate";
import { TopBar } from "@/components/top-bar";
import { Badge } from "@/components/ui";
import {
  FAVORITES_EMPTY,
  FAVORITES_EMPTY_HINT,
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
      <TopBar back="/" title={FAVORITES_TITLE} />
      <div className="px-4 pb-6">
        <h1 className="font-display text-[22px] font-extrabold text-ink">{FAVORITES_TITLE}</h1>
        {error ? (
          <div role="alert" className="mt-4 rounded-2xl border border-line bg-white p-4 text-center">
            <p className="text-[14px] font-semibold text-ink">{error}</p>
            <button
              onClick={() => {
                setError(null);
                setReloadKey((key) => key + 1);
              }}
              className="mt-3 rounded-xl bg-forest px-5 py-2.5 text-[14px] font-bold text-white"
            >
              Réessayer
            </button>
          </div>
        ) : items === null ? (
          <p className="mt-6 text-center text-[14px] text-ink-soft" aria-busy="true">
            {FAVORITES_LOADING}
          </p>
        ) : items.length === 0 ? (
          <div role="status" data-testid="favorites-empty" className="mt-6 rounded-2xl bg-wash p-5 text-center">
            <Heart className="mx-auto size-7 text-ink-soft" aria-hidden />
            <p className="mt-2 text-[14px] font-bold text-ink">{FAVORITES_EMPTY}</p>
            <p className="mt-1 text-[13px] text-ink-soft">{FAVORITES_EMPTY_HINT}</p>
          </div>
        ) : (
          <>
            {actionError ? (
              <p role="alert" className="mt-3 text-[13px] font-semibold text-carrot-ink">
                {actionError}
              </p>
            ) : null}
            <ul aria-label="Vos annonces gardées" className="mt-3 space-y-2.5" data-testid="favorites-list">
              {items.map((item) => {
                const row = favoriteRow(item);
                return (
                  <li key={row.offerId} data-testid="favorite-row" data-available={row.available ? "true" : "false"} className="rounded-2xl border border-line bg-white p-3.5">
                    <div className="flex items-start gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="text-[15px] font-bold text-ink">{row.title}</div>
                        {row.priceText ? <div className="font-display text-[18px] font-extrabold text-ink">{row.priceText}</div> : null}
                        <div className="mt-1">
                          <Badge tone={row.available ? "sage" : "wash"}>{row.statusText}</Badge>
                        </div>
                      </div>
                      <button
                        onClick={() => void remove(row.offerId)}
                        aria-label={`${REMOVE_FAVORITE_LABEL} : ${row.title}`}
                        title={REMOVE_FAVORITE_LABEL}
                        data-testid="favorite-remove"
                        className="flex size-10 shrink-0 items-center justify-center rounded-full border border-line bg-white"
                      >
                        <Heart className="size-5 fill-carrot text-carrot" aria-hidden />
                      </button>
                    </div>
                    {row.href ? (
                      <Link href={row.href} className="mt-2 inline-block text-[13px] font-bold text-forest">
                        {OPEN_LISTING_LABEL} ›
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
