"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ChevronRight, Layers, Plus } from "lucide-react";
import { useUnauthorizedRedirect } from "@/components/session-gate";
import { TopBar } from "@/components/top-bar";
import { Badge } from "@/components/ui";
import { describeMissionError, missions, type MissionSummary } from "@/lib/client/missions-api";
import {
  MISSIONS_EMPTY,
  MISSIONS_EMPTY_HINT,
  MISSIONS_LOADING,
  MISSIONS_MORE_LABEL,
  MISSIONS_MORE_LOADING,
  MISSIONS_NEW_LABEL,
  MISSIONS_TITLE,
  missionRow,
} from "@/lib/client/missions-view";

/** Barre de progression (pourcentage entier). */
export function ProgressBar({ percent, label }: { percent: number; label: string }) {
  return (
    <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} className="h-2 w-full overflow-hidden rounded-full bg-wash">
      <div className="h-2 rounded-full bg-forest" style={{ width: `${percent}%` }} />
    </div>
  );
}

/**
 * « Mes missions » (lot MV1) : la liste des missions d'achat en volume de l'acheteur, avec la quantité déjà achetée et la couverture de la proposition. Aucun paiement ne passe par
 * noma.
 */
export function MissionsList() {
  const redirectIfUnauthorized = useUnauthorizedRedirect();
  const [items, setItems] = useState<MissionSummary[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [moreError, setMoreError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    missions.list(null, { signal: controller.signal }).then(
      (page) => {
        setItems(page.missions);
        setNextCursor(page.nextCursor);
        setMoreError(null);
        setError(null);
      },
      (failure) => {
        if (controller.signal.aborted || redirectIfUnauthorized(failure)) return;
        setError(describeMissionError(failure, "list"));
      },
    );
    return () => controller.abort();
  }, [reloadKey, redirectIfUnauthorized]);

  // Pages suivantes : les missions ouvertes sont toujours en tête, les closes viennent ensuite par pages.
  const loadMore = async () => {
    if (nextCursor === null || loadingMore) return;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const page = await missions.list(nextCursor);
      setItems((current) => [...(current ?? []), ...page.missions]);
      setNextCursor(page.nextCursor);
    } catch (failure) {
      if (!redirectIfUnauthorized(failure)) setMoreError(describeMissionError(failure, "list"));
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <main>
      <TopBar back="/compte" title={MISSIONS_TITLE} />
      <div className="px-4 pb-6">
        <div className="flex items-center justify-between gap-3">
          <h1 className="font-display text-[22px] font-extrabold text-ink">{MISSIONS_TITLE}</h1>
          <Link href="/missions/nouvelle" data-testid="mission-new" className="flex items-center gap-1.5 rounded-full bg-forest px-3.5 py-2 text-[13px] font-bold text-white">
            <Plus className="size-4" aria-hidden />
            {MISSIONS_NEW_LABEL}
          </Link>
        </div>
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
            {MISSIONS_LOADING}
          </p>
        ) : items.length === 0 ? (
          <div role="status" data-testid="missions-empty" className="mt-6 rounded-2xl bg-wash p-5 text-center">
            <Layers className="mx-auto size-7 text-ink-soft" aria-hidden />
            <p className="mt-2 text-[14px] font-bold text-ink">{MISSIONS_EMPTY}</p>
            <p className="mt-1 text-[13px] text-ink-soft">{MISSIONS_EMPTY_HINT}</p>
          </div>
        ) : (
          <ul aria-label="Vos missions" className="mt-3 space-y-2.5" data-testid="missions-list">
            {items.map((mission) => {
              const row = missionRow(mission);
              return (
                <li key={row.id} data-testid="mission-row" data-status={mission.status}>
                  <Link href={row.href} className="flex items-start gap-3 rounded-2xl border border-line bg-white p-3.5">
                    <span className="min-w-0 flex-1">
                      <span className="block text-[15px] font-bold text-ink">{row.title}</span>
                      <span className="mt-1 flex flex-wrap items-center gap-1.5">
                        <Badge tone={row.tone}>{row.statusText}</Badge>
                        {row.deadlineText ? <span className="text-[12px] text-ink-soft">{row.deadlineText}</span> : null}
                      </span>
                      {row.securedText ? (
                        <span className="mt-2 block">
                          <span data-testid="mission-secured" className="block text-[13px] font-semibold text-ink">
                            {row.securedText}
                          </span>
                          <ProgressBar percent={row.securedPercent} label="Achats confirmés" />
                        </span>
                      ) : null}
                      {row.coverageText ? (
                        <span data-testid="mission-coverage" className="mt-1.5 block text-[12px] text-ink-soft">
                          {row.coverageText}
                          {row.coveragePercent !== null ? ` (${row.coveragePercent} %)` : ""}
                        </span>
                      ) : null}
                      <span className="mt-1 block text-[12px] text-ink-soft">{row.budgetText}</span>
                    </span>
                    <ChevronRight className="mt-1 size-4 shrink-0 text-ink-soft" aria-hidden />
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
        {items !== null && items.length > 0 && nextCursor !== null ? (
          <div className="mt-3 text-center">
            <button
              onClick={() => void loadMore()}
              disabled={loadingMore}
              data-testid="missions-more"
              className="rounded-xl border border-line bg-white px-5 py-2.5 text-[14px] font-bold text-ink disabled:opacity-50"
            >
              {loadingMore ? MISSIONS_MORE_LOADING : MISSIONS_MORE_LABEL}
            </button>
            {moreError ? (
              <p role="alert" data-testid="missions-more-error" className="mt-2 text-[12px] font-semibold text-carrot-ink">
                {moreError}
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
    </main>
  );
}
