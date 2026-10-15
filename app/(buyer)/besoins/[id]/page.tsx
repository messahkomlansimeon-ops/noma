"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { ActiveSearchCard } from "@/components/active-search-card";
import { ExternalSection } from "@/components/external/external-section";
import { BuyerMatchCard } from "@/components/matches/match-parts";
import { SessionGate, useUnauthorizedRedirect } from "@/components/session-gate";
import { TopBar } from "@/components/top-bar";
import { TrackingPanel } from "@/components/tracking-panel";
import { Badge } from "@/components/ui";
import { UnreadSync } from "@/components/unread-badge";
import { useNoma } from "@/lib/store";
import {
  api,
  describeApiError,
  isUuid,
  type DemandRecord,
  type StoredMatch,
} from "@/lib/client/api";
import { DEMAND_STATUS_VIEW, demandSummary, recordTitle } from "@/lib/client/catalog-view";
import { COMPARE_COUNT, COMPARE_LIMIT_MESSAGE, comparePath, pruneSelection, toggleSelection } from "@/lib/client/compare-view";
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
import { missions } from "@/lib/client/missions-api";
import { missionPath } from "@/lib/client/missions-view";
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
  // Lot FIN3-C1 : deux offres cochées à comparer ; la sélection vit dans cette page, puis dans l'adresse de la page de comparaison.
  const [selected, setSelected] = useState<string[]>([]);
  const showToast = useNoma((state) => state.showToast);
  const [refreshing, setRefreshing] = useState(false);
  // Un achat de recherche active change le plafond du suivi (180 jours) : le panneau de suivi est relu.
  const [trackingKey, setTrackingKey] = useState(0);
  // « Actualiser » ouvre une nouvelle génération : une réponse de « Voir plus » partie avant est ignorée.
  const guard = useRef(createGenerationGuard());
  const busy = refreshing || loadingMore;
  // Lot FIN1 : le besoin PORTEUR d'une mission d'achat en volume n'est pas un besoin ordinaire : son suivi et la recherche active ne se gèrent que par la mission (le serveur refuse
  // tout autre chemin, 409). Il ne s'affiche donc jamais avec « Prolonger », « Pause » ou « Reprendre ». `undefined` : pas encore su ; `null` : besoin ordinaire.
  const [carrier, setCarrier] = useState<{ id: string; title: string } | null | undefined>(undefined);
  useEffect(() => {
    const controller = new AbortController();
    missions.list(null, { signal: controller.signal }).then(
      (page) => {
        const found = page.missions.find((mission) => mission.demandId === demandId);
        setCarrier(found ? { id: found.id, title: found.title } : null);
      },
      () => {
        if (!controller.signal.aborted) setCarrier(null);
      },
    );
    return () => controller.abort();
  }, [demandId]);

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
  const chosen = pruneSelection(selected, loaded.items);
  const state = notActive ? "inactive" : resultsState({ loaded: true, itemCount: loaded.items.length, processing: loaded.processing });
  // Un besoin PORTEUR d'une mission n'a pas la carte (`carrier === null` à chaque emplacement) ; actif ou satisfait seulement.
  const activeSearchCard = demand.status === "active" || demand.status === "satisfied" ? <ActiveSearchCard demandId={demandId} onChanged={() => setTrackingKey((key) => key + 1)} /> : null;

  return (
    <>
      <div className="rounded-2xl border border-line bg-white p-3.5">
        <div className="text-[15px] font-bold text-ink">{recordTitle(demand)}</div>
        {summary ? <div className="text-[12px] text-ink-soft">{summary}</div> : null}
        <div className="mt-2">
          <Badge tone={status.tone}>{status.label}</Badge>
        </div>
      </div>

      {carrier ? (
        <div data-testid="mission-carrier-note" className="mt-3 rounded-2xl border border-line bg-white p-3.5">
          <p className="text-[13px] font-semibold text-ink">Ce besoin appartient à votre mission « {carrier.title} » : il se gère depuis la mission.</p>
          <Link href={missionPath(carrier.id)} className="mt-2 inline-block text-[13px] font-bold text-forest">
            Ouvrir la mission ›
          </Link>
        </div>
      ) : null}

      {carrier === null && demand.status === "active" ? <TrackingPanel demandId={demandId} key={`tracking-${trackingKey}`} /> : null}

      {/* Lot RA1 : option payante « Recherche active » (annonces d'autres sites notifiées, collecte plus fréquente, suivi jusqu'à 180 jours). */}
      {/* Un besoin « satisfait » SUSPEND l'option en cours (la carte le dit, sans bouton d'achat) ; pour tout autre statut, la carte ne s'affiche pas. */}
      {/* Lot FIN1 : la carte vient APRÈS les résultats (le premier écran montre la première annonce, pas une carte de réglages longue de plusieurs écrans). */}
      {notActive ? (
        <>
          <p role="status" className="mt-4 rounded-2xl bg-wash p-4 text-[14px] font-semibold text-ink-soft">
            {notActive}
          </p>
          {carrier === null ? activeSearchCard : null}
        </>
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
                <BuyerMatchCard
                  key={item.candidateId}
                  item={item}
                  detailHref={offerDetailPath(demandId, item.candidateId)}
                  compare={{
                    selected: chosen.includes(item.candidateId),
                    onToggle: () => {
                      const next = toggleSelection(chosen, item.candidateId);
                      if (next.refused) showToast(COMPARE_LIMIT_MESSAGE);
                      setSelected(next.selected);
                    },
                  }}
                />
              ))}
            </ul>
          ) : null}

          {state === "results" && chosen.length > 0 ? (
            <div data-testid="compare-bar" className="sticky bottom-20 z-10 mt-3 rounded-2xl border border-forest/30 bg-white p-3 shadow-sm">
              {chosen.length === COMPARE_COUNT && comparePath(demandId, chosen) ? (
                <Link
                  href={comparePath(demandId, chosen) ?? "#"}
                  data-testid="compare-link"
                  className="flex w-full items-center justify-center rounded-xl bg-forest py-3 text-[14px] font-bold text-white"
                >
                  Comparer ces 2 offres
                </Link>
              ) : (
                <p className="text-center text-[13px] font-semibold text-ink-soft">Cochez une deuxième offre pour les comparer.</p>
              )}
            </div>
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

          {carrier === null ? activeSearchCard : null}

          {/* Lot EXT1 : annonces d'AUTRES SITES, section séparée (jamais dans la liste ni le classement ci-dessus). */}
          <ExternalSection demandId={demandId} />
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
      <UnreadSync />
      <PageContent />
    </SessionGate>
  );
}
