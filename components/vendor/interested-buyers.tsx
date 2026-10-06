"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { InterestedBuyerCard } from "@/components/matches/match-parts";
import { useUnauthorizedRedirect } from "@/components/session-gate";
import { api, describeApiError, type OfferRecord, type StoredMatch } from "@/lib/client/api";
import {
  EMPTY_SELLER_HINT,
  EMPTY_SELLER_MESSAGE,
  NEEDS_NOTE,
  PROCESSING_MESSAGE,
  TRUNCATED_NOTE,
  createGenerationGuard,
  matchingNeedsLabel,
  mergeIfCurrent,
  offerNotPublishedMessage,
  resultsState,
} from "@/lib/client/match-view";

interface Loaded {
  items: StoredMatch[];
  processing: boolean;
  nextCursor: string | null;
  truncated: boolean;
}

/**
 * « Acheteurs intéressés » : le nombre et la liste des BESOINS d'acheteurs qui correspondent à l'annonce (un acheteur peut
 * en avoir plusieurs : on ne parle jamais d'un nombre d'acheteurs), SANS identité ni téléphone (le serveur n'en envoie pas
 * et l'écran n'en affiche jamais).
 */
export function InterestedBuyers({ offer }: { offer: OfferRecord }) {
  const redirectIfUnauthorized = useUnauthorizedRedirect();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [moreError, setMoreError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  // « Actualiser » ouvre une nouvelle génération : une réponse de « Voir plus » partie avant est ignorée.
  const guard = useRef(createGenerationGuard());
  const notPublished = offerNotPublishedMessage(offer.status);
  const offerId = offer.id;
  const busy = refreshing || loadingMore;

  useEffect(() => {
    // Le serveur ne sert des besoins correspondants que pour une annonce en ligne (sinon 400) : aucun appel dans ce cas.
    if (notPublished) return;
    const controller = new AbortController();
    const token = guard.current.begin();
    api.offers.storedMatches(offerId, {}, { signal: controller.signal }).then(
      (page) => {
        if (!guard.current.isCurrent(token)) return;
        setLoaded({ items: page.items, processing: page.processing, nextCursor: page.nextCursor, truncated: page.truncated });
        setLoadError(null);
        setRefreshing(false);
      },
      (failure) => {
        if (controller.signal.aborted || !guard.current.isCurrent(token) || redirectIfUnauthorized(failure)) return;
        setLoadError(describeApiError(failure, "matches"));
        setRefreshing(false);
      },
    );
    return () => controller.abort();
  }, [offerId, notPublished, reloadKey, redirectIfUnauthorized]);

  const refresh = () => {
    if (busy) return;
    // Invalide tout « Voir plus » en cours, puis recharge la première page.
    guard.current.begin();
    setLoadError(null);
    setMoreError(null);
    setLoadingMore(false);
    setRefreshing(true);
    setReloadKey((key) => key + 1);
  };

  const loadMore = useCallback(async () => {
    if (!loaded?.nextCursor || busy) return;
    const token = guard.current.begin();
    setLoadingMore(true);
    setMoreError(null);
    try {
      const page = await api.offers.storedMatches(offerId, { cursor: loaded.nextCursor });
      setLoaded((current) => {
        const merged = current ? mergeIfCurrent(guard.current, token, current.items, page.items) : null;
        return current && merged
          ? { items: merged, processing: page.processing, nextCursor: page.nextCursor, truncated: page.truncated }
          : current;
      });
    } catch (failure) {
      if (!guard.current.isCurrent(token) || redirectIfUnauthorized(failure)) return;
      setMoreError(describeApiError(failure, "matches"));
    } finally {
      if (guard.current.isCurrent(token)) setLoadingMore(false);
    }
  }, [offerId, loaded, busy, redirectIfUnauthorized]);

  return (
    <section aria-labelledby="interested-title" className="mt-5">
      <div className="flex items-center justify-between gap-3">
        <h2 id="interested-title" className="text-[16px] font-extrabold text-ink">
          Acheteurs intéressés
        </h2>
        {!notPublished ? (
          <button
            onClick={refresh}
            disabled={busy}
            className="flex items-center gap-1.5 rounded-full border border-line bg-white px-3 py-1.5 text-[13px] font-semibold text-ink disabled:opacity-50"
          >
            <RefreshCw className={`size-3.5 ${refreshing ? "animate-spin" : ""}`} aria-hidden />
            Actualiser
          </button>
        ) : null}
      </div>

      {notPublished ? (
        <p role="status" className="mt-3 rounded-2xl bg-wash p-4 text-[14px] font-semibold text-ink-soft">
          {notPublished}
        </p>
      ) : loadError ? (
        <div role="alert" className="mt-3 rounded-2xl border border-line bg-white p-4 text-center">
          <p className="text-[14px] font-semibold text-ink">{loadError}</p>
          <button onClick={refresh} className="mt-3 rounded-xl bg-forest px-5 py-2.5 text-[14px] font-bold text-white">
            Réessayer
          </button>
        </div>
      ) : !loaded ? (
        <p className="mt-3 text-[14px] text-ink-soft" aria-busy="true">
          Chargement des besoins d'acheteurs…
        </p>
      ) : (
        <InterestedList
          loaded={loaded}
          moreError={moreError}
          loadingMore={loadingMore}
          disabled={busy}
          onMore={() => void loadMore()}
        />
      )}
    </section>
  );
}

function InterestedList({
  loaded,
  moreError,
  loadingMore,
  disabled,
  onMore,
}: {
  loaded: Loaded;
  moreError: string | null;
  loadingMore: boolean;
  disabled: boolean;
  onMore: () => void;
}) {
  const state = resultsState({ loaded: true, itemCount: loaded.items.length, processing: loaded.processing });
  return (
    <>
      <p className="mt-1 text-[14px] font-bold text-ink" data-testid="interested-count">
        {matchingNeedsLabel(loaded.items.length, loaded.nextCursor !== null)}
      </p>
      {loaded.items.length > 0 ? (
        <p className="mt-0.5 text-[12px] text-ink-soft" data-testid="interested-note">
          {NEEDS_NOTE}
        </p>
      ) : null}

      {loaded.processing ? (
        <p role="status" className="mt-1 text-[12px] font-semibold text-carrot-ink">
          {PROCESSING_MESSAGE} La liste peut encore évoluer : appuyez sur Actualiser.
        </p>
      ) : null}

      {state === "empty" || state === "processing" ? (
        <div className="mt-3 rounded-2xl bg-wash p-4 text-center">
          <p className="text-[14px] font-bold text-ink">{state === "processing" ? PROCESSING_MESSAGE : EMPTY_SELLER_MESSAGE}</p>
          {state === "empty" ? <p className="mt-1 text-[13px] text-ink-soft">{EMPTY_SELLER_HINT}</p> : null}
        </div>
      ) : (
        <ul className="mt-3 space-y-3" aria-label="Besoins qui correspondent à votre annonce">
          {loaded.items.map((item) => (
            <InterestedBuyerCard key={item.candidateId} item={item} />
          ))}
        </ul>
      )}

      {loaded.truncated && state === "results" ? (
        <p role="status" className="mt-3 text-[12px] font-semibold text-ink-soft">
          {TRUNCATED_NOTE}
        </p>
      ) : null}

      {moreError ? (
        <p role="alert" className="mt-3 text-center text-[13px] font-semibold text-carrot-ink">
          {moreError}
        </p>
      ) : null}

      {loaded.nextCursor ? (
        <button
          onClick={onMore}
          disabled={disabled}
          className="mt-4 flex w-full items-center justify-center rounded-xl border border-forest/30 bg-white py-3 text-[14px] font-bold text-forest disabled:opacity-50"
        >
          {loadingMore ? "Chargement…" : "Voir plus"}
        </button>
      ) : null}
    </>
  );
}
