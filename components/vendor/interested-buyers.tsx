"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, RefreshCw, ShieldCheck, Users } from "lucide-react";
import { ArtSearch } from "@/components/illustrations";
import { InterestedBuyerCard } from "@/components/matches/match-parts";
import { useUnauthorizedRedirect } from "@/components/session-gate";
import { EmptyState } from "@/components/ui";
import { BTN_OUTLINE, ErrorState, LINK_ACTION, LoadingBlock, Notice, SectionHeading } from "@/components/vendor/vendor-parts";
import { api, describeApiError, type OfferRecord, type StoredMatch } from "@/lib/client/api";
import {
  EMPTY_SELLER_MESSAGE,
  NEEDS_NOTE,
  PROCESSING_MESSAGE,
  TRUNCATED_NOTE,
  createGenerationGuard,
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
 * « Acheteurs intéressés » : la liste anonyme des BESOINS d'acheteurs qui correspondent à l'annonce (un acheteur peut en avoir plusieurs : on ne parle jamais d'un nombre
 * d'acheteurs), SANS identité ni téléphone (le serveur n'en envoie pas et l'écran n'en affiche jamais). Lot D3 : AUCUN compte n'est affiché au-dessus de la liste (le titre
 * arrondi « Environ 10 besoins… » contredisait les lignes visibles : l'arrondi protège les STATISTIQUES, pas la liste, qui est le produit) ; une phrase dit ce qu'est une ligne.
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
    <section aria-labelledby="interested-title">
      <SectionHeading
        icon={Users}
        id="interested-title"
        aside={
          !notPublished ? (
            <button onClick={refresh} disabled={busy} className={`${LINK_ACTION} border border-line bg-white`}>
              <RefreshCw className={`size-4 ${refreshing ? "animate-spin" : ""}`} aria-hidden />
              Actualiser
            </button>
          ) : null
        }
      >
        Acheteurs intéressés
      </SectionHeading>

      {notPublished ? (
        <Notice tone="mist" role="status" className="mt-3">
          {notPublished}
        </Notice>
      ) : loadError ? (
        <ErrorState message={loadError} onRetry={refresh} />
      ) : !loaded ? (
        <LoadingBlock label="Chargement des besoins d'acheteurs…" rows={2} rowClassName="h-20 w-full rounded-3xl" className="mt-3" />
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

export function InterestedList({
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
      {loaded.items.length > 0 ? (
        <Notice tone="info" icon={ShieldCheck} className="mt-3" data-testid="interested-note">
          {NEEDS_NOTE}
        </Notice>
      ) : null}

      {loaded.processing ? (
        <Notice tone="accent" role="status" icon={Loader2} className="mt-3">
          {PROCESSING_MESSAGE} La liste peut encore évoluer : appuyez sur Actualiser.
        </Notice>
      ) : null}

      {state === "empty" || state === "processing" ? (
        <div data-testid="interested-empty">
          <EmptyState art={<ArtSearch className="size-32" />} title={state === "processing" ? PROCESSING_MESSAGE : EMPTY_SELLER_MESSAGE} />
        </div>
      ) : (
        <ul className="stagger mt-3 flex flex-col gap-3 md:grid md:grid-cols-2 md:items-start" aria-label="Besoins qui correspondent à votre annonce">
          {loaded.items.map((item) => (
            <InterestedBuyerCard key={item.candidateId} item={item} />
          ))}
        </ul>
      )}

      {loaded.truncated && state === "results" ? (
        <Notice tone="mist" role="status" className="mt-3">
          {TRUNCATED_NOTE}
        </Notice>
      ) : null}

      {moreError ? (
        <Notice tone="danger" role="alert" className="mt-3">
          {moreError}
        </Notice>
      ) : null}

      {loaded.nextCursor ? (
        <button onClick={onMore} disabled={disabled} className={`${BTN_OUTLINE} mt-4`}>
          {loadingMore ? "Chargement…" : "Voir plus"}
        </button>
      ) : null}
    </>
  );
}
