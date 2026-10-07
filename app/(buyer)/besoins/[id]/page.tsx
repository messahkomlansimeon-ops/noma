"use client";

import { useParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { BuyerMatchCard } from "@/components/matches/match-parts";
import { SessionGate, useUnauthorizedRedirect } from "@/components/session-gate";
import { TopBar } from "@/components/top-bar";
import { Badge } from "@/components/ui";
import {
  api,
  describeApiError,
  isUuid,
  type DemandRecord,
  type StoredMatch,
} from "@/lib/client/api";
import { DEMAND_STATUS_VIEW, demandSummary, recordTitle } from "@/lib/client/catalog-view";
import {
  EMPTY_BUYER_HINT,
  EMPTY_BUYER_MESSAGE,
  PROCESSING_HINT,
  PROCESSING_MESSAGE,
  TRUNCATED_NOTE,
  buyerResultsLabel,
  createGenerationGuard,
  demandNotActiveMessage,
  mergeIfCurrent,
  resultsState,
} from "@/lib/client/match-view";
import { offerDetailPath } from "@/lib/client/metrics-view";

interface Loaded {
  demand: DemandRecord;
  items: StoredMatch[];
  processing: boolean;
  nextCursor: string | null;
  truncated: boolean;
}

/** Résultats d'un besoin : offres compatibles, triées par pertinence (le tri applique la mise en avant « Sponsorisé »). */
function ResultatsDuBesoin({ demandId }: { demandId: string }) {
  const redirectIfUnauthorized = useUnauthorizedRedirect();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [moreError, setMoreError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  // « Actualiser » ouvre une nouvelle génération : une réponse de « Voir plus » partie avant est ignorée.
  const guard = useRef(createGenerationGuard());
  const busy = refreshing || loadingMore;

  useEffect(() => {
    const controller = new AbortController();
    const token = guard.current.begin();
    (async () => {
      try {
        const demand = await api.demands.get(demandId, { signal: controller.signal });
        // Le serveur ne sert des résultats que pour un besoin actif (sinon 400) : on n'appelle pas dans ce cas.
        if (demand.status !== "active") {
          if (guard.current.isCurrent(token)) setLoaded({ demand, items: [], processing: false, nextCursor: null, truncated: false });
          return;
        }
        const page = await api.demands.storedMatches(demandId, { sort: "relevance" }, { signal: controller.signal });
        if (!guard.current.isCurrent(token)) return;
        setLoaded({
          demand,
          items: page.items,
          processing: page.processing,
          nextCursor: page.nextCursor,
          truncated: page.truncated,
        });
      } catch (failure) {
        if (controller.signal.aborted || !guard.current.isCurrent(token) || redirectIfUnauthorized(failure)) return;
        setLoadError(describeApiError(failure, "matches"));
      } finally {
        if (!controller.signal.aborted && guard.current.isCurrent(token)) setRefreshing(false);
      }
    })();
    return () => controller.abort();
  }, [demandId, reloadKey, redirectIfUnauthorized]);

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
      const page = await api.demands.storedMatches(demandId, { sort: "relevance", cursor: loaded.nextCursor });
      setLoaded((current) => {
        const merged = current ? mergeIfCurrent(guard.current, token, current.items, page.items) : null;
        return current && merged
          ? { ...current, items: merged, processing: page.processing, nextCursor: page.nextCursor, truncated: page.truncated }
          : current;
      });
    } catch (failure) {
      if (!guard.current.isCurrent(token) || redirectIfUnauthorized(failure)) return;
      setMoreError(describeApiError(failure, "matches"));
    } finally {
      if (guard.current.isCurrent(token)) setLoadingMore(false);
    }
  }, [demandId, loaded, busy, redirectIfUnauthorized]);

  if (loadError) {
    return (
      <div role="alert" className="mt-4 rounded-2xl border border-line bg-white p-4 text-center">
        <p className="text-[14px] font-semibold text-ink">{loadError}</p>
        <button onClick={refresh} className="mt-3 rounded-xl bg-forest px-5 py-2.5 text-[14px] font-bold text-white">
          Réessayer
        </button>
      </div>
    );
  }
  if (!loaded) {
    return (
      <p className="mt-6 text-center text-[14px] text-ink-soft" aria-busy="true">
        Chargement des résultats…
      </p>
    );
  }

  const { demand } = loaded;
  const status = DEMAND_STATUS_VIEW[demand.status];
  const summary = demandSummary(demand);
  const notActive = demandNotActiveMessage(demand.status);
  const state = notActive ? "inactive" : resultsState({ loaded: true, itemCount: loaded.items.length, processing: loaded.processing });

  return (
    <>
      <div className="rounded-2xl border border-line bg-white p-3.5">
        <div className="text-[15px] font-bold text-ink">{recordTitle(demand)}</div>
        {summary ? <div className="text-[12px] text-ink-soft">{summary}</div> : null}
        <div className="mt-2">
          <Badge tone={status.tone}>{status.label}</Badge>
        </div>
      </div>

      {notActive ? (
        <p role="status" className="mt-4 rounded-2xl bg-wash p-4 text-[14px] font-semibold text-ink-soft">
          {notActive}
        </p>
      ) : (
        <>
          <div className="mt-4 flex items-center justify-between gap-3">
            <h2 className="text-[16px] font-extrabold text-ink" data-testid="results-count">
              {state === "results" ? buyerResultsLabel(loaded.items.length, loaded.nextCursor !== null) : "Offres correspondantes"}
            </h2>
            <button
              onClick={refresh}
              disabled={busy}
              className="flex items-center gap-1.5 rounded-full border border-line bg-white px-3 py-1.5 text-[13px] font-semibold text-ink disabled:opacity-50"
            >
              <RefreshCw className={`size-3.5 ${refreshing ? "animate-spin" : ""}`} aria-hidden />
              Actualiser
            </button>
          </div>

          {loaded.processing && state === "results" ? (
            <p role="status" className="mt-2 text-[12px] font-semibold text-carrot-ink">
              {PROCESSING_MESSAGE} De nouveaux résultats peuvent arriver : appuyez sur Actualiser.
            </p>
          ) : null}

          {state === "processing" ? (
            <div role="status" className="mt-4 rounded-2xl bg-wash p-4 text-center">
              <p className="text-[14px] font-bold text-ink">{PROCESSING_MESSAGE}</p>
              <p className="mt-1 text-[13px] text-ink-soft">{PROCESSING_HINT}</p>
            </div>
          ) : null}

          {state === "empty" ? (
            <div role="status" className="mt-4 rounded-2xl bg-wash p-4 text-center">
              <p className="text-[14px] font-bold text-ink">{EMPTY_BUYER_MESSAGE}</p>
              <p className="mt-1 text-[13px] text-ink-soft">{EMPTY_BUYER_HINT}</p>
            </div>
          ) : null}

          {state === "results" ? (
            <ul className="mt-3 space-y-3" aria-label="Offres correspondant à votre besoin">
              {loaded.items.map((item) => (
                <BuyerMatchCard key={item.candidateId} item={item} detailHref={offerDetailPath(demandId, item.candidateId)} />
              ))}
            </ul>
          ) : null}

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
              onClick={() => void loadMore()}
              disabled={busy}
              className="mt-4 flex w-full items-center justify-center rounded-xl border border-forest/30 bg-white py-3 text-[14px] font-bold text-forest disabled:opacity-50"
            >
              {loadingMore ? "Chargement…" : "Voir plus"}
            </button>
          ) : null}
        </>
      )}
    </>
  );
}

function PageContent() {
  const params = useParams<{ id: string }>();
  const demandId = typeof params.id === "string" ? params.id : "";
  return (
    <main>
      <TopBar back="/alertes" title="Résultats de mon besoin" />
      <div className="px-4 pb-6">
        {isUuid(demandId) ? (
          <ResultatsDuBesoin demandId={demandId} />
        ) : (
          <p role="alert" className="mt-6 text-center text-[14px] font-semibold text-ink">
            Besoin introuvable.
          </p>
        )}
      </div>
    </main>
  );
}

export default function BesoinResultatsPage() {
  return (
    <SessionGate>
      <PageContent />
    </SessionGate>
  );
}
