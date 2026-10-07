"use client";

import { useEffect, useRef, useState } from "react";
import { Heart } from "lucide-react";
import { useUnauthorizedRedirect } from "@/components/session-gate";
import { ADD_FAVORITE_LABEL, REMOVE_FAVORITE_LABEL, isFavorite } from "@/lib/client/favorites-view";
import { describeSocialError, social } from "@/lib/client/social-api";

/**
 * Le cœur de la fiche d'une annonce (lot D2) : garde l'annonce dans le contexte du besoin d'origine, ou la retire. L'état se lit dans la liste des favoris du serveur
 * (200 au plus) : rien n'est supposé côté navigateur. Un double appui n'envoie qu'UNE demande à la fois.
 */
export function FavoriteButton({ demandId, offerId }: { demandId: string; offerId: string }) {
  const redirectIfUnauthorized = useUnauthorizedRedirect();
  const [favorite, setFavorite] = useState<boolean | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    social.favorites.list({ signal: controller.signal }).then(
      (items) => setFavorite(isFavorite(items, offerId)),
      (failure) => {
        if (controller.signal.aborted || redirectIfUnauthorized(failure)) return;
        setFavorite(false);
      },
    );
    return () => controller.abort();
  }, [offerId, redirectIfUnauthorized]);

  const toggle = async () => {
    if (busy.current || favorite === null) return;
    busy.current = true;
    setPending(true);
    setError(null);
    try {
      if (favorite) await social.favorites.remove(offerId);
      else await social.favorites.add(demandId, offerId);
      setFavorite(!favorite);
    } catch (failure) {
      if (redirectIfUnauthorized(failure)) return;
      setError(describeSocialError(failure, "favorites"));
    } finally {
      busy.current = false;
      setPending(false);
    }
  };

  const label = favorite ? REMOVE_FAVORITE_LABEL : ADD_FAVORITE_LABEL;
  return (
    <div className="shrink-0">
      <button
        onClick={() => void toggle()}
        disabled={pending || favorite === null}
        aria-pressed={favorite === true}
        aria-label={label}
        title={label}
        data-testid="favorite-button"
        data-favorite={favorite ? "true" : "false"}
        className="flex size-11 items-center justify-center rounded-full border border-line bg-white transition active:scale-95 disabled:opacity-50"
      >
        <Heart className={`size-5 ${favorite ? "fill-carrot text-carrot" : "text-ink"}`} aria-hidden />
      </button>
      {error ? (
        <p role="alert" data-testid="favorite-error" className="mt-1 max-w-40 text-[11px] font-semibold text-carrot-ink">
          {error}
        </p>
      ) : null}
    </div>
  );
}
