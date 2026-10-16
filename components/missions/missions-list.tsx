"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ChevronRight, CircleAlert, Layers, Plus, RotateCw } from "lucide-react";
import { useUnauthorizedRedirect } from "@/components/session-gate";
import { ArtAlert, ArtBag } from "@/components/illustrations";
import { TopBar } from "@/components/top-bar";
import { Badge, Btn, EmptyState, IconTile, Skeleton } from "@/components/ui";
import { describeMissionError, missions, type MissionSummary } from "@/lib/client/missions-api";
import {
  MISSIONS_EMPTY,
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
    <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} className="h-2.5 w-full overflow-hidden rounded-full bg-mist">
      <div className="h-2.5 rounded-full bg-brand transition-[width] duration-500" style={{ width: `${percent}%` }} />
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
      {/* Lot FIN1 : titre dit une fois (le h1). */}
      <TopBar back="/compte" />
      <div className="px-4 pb-6">
        <div className="flex items-center justify-between gap-3">
          <h1 className="flex items-center gap-2.5 text-[24px] font-extrabold tracking-tight text-ink">
            <Layers className="size-6 text-brand" aria-hidden />
            {MISSIONS_TITLE}
          </h1>
          <Link
            href="/missions/nouvelle"
            data-testid="mission-new"
            className="press flex min-h-11 items-center gap-1.5 rounded-full bg-brand px-4 text-[15px] font-bold text-white hover:bg-brand-deep"
          >
            <Plus className="size-5" aria-hidden />
            {MISSIONS_NEW_LABEL}
          </Link>
        </div>
        {error ? (
          <div role="alert" className="animate-rise mt-4 flex flex-col items-center gap-4 rounded-3xl border border-line bg-white p-6 text-center">
            <ArtAlert className="size-24" />
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
          <div className="mt-4 flex flex-col gap-3 md:grid md:grid-cols-2" aria-busy="true">
            <span className="sr-only">{MISSIONS_LOADING}</span>
            <Skeleton className="h-28 w-full rounded-3xl" />
            <Skeleton className="h-28 w-full rounded-3xl" />
            <Skeleton className="h-28 w-full rounded-3xl" />
          </div>
        ) : items.length === 0 ? (
          <div role="status" data-testid="missions-empty">
            <EmptyState art={<ArtBag className="size-36" />} title={MISSIONS_EMPTY} />
          </div>
        ) : (
          <ul aria-label="Vos missions" className="stagger mt-4 flex flex-col gap-3 md:grid md:grid-cols-2" data-testid="missions-list">
            {items.map((mission) => {
              const row = missionRow(mission);
              return (
                <li key={row.id} data-testid="mission-row" data-status={mission.status}>
                  <Link href={row.href} className="press flex h-full items-start gap-3 rounded-3xl border border-line bg-white p-3.5 hover:border-brand">
                    <IconTile icon={Layers} className="size-12" />
                    <span className="min-w-0 flex-1">
                      <span className="block text-[16px] font-bold leading-snug text-ink">{row.title}</span>
                      <span className="mt-1 flex flex-wrap items-center gap-1.5">
                        <Badge tone={row.tone}>{row.statusText}</Badge>
                        {row.deadlineText ? <span className="text-[13px] text-ink-soft">{row.deadlineText}</span> : null}
                      </span>
                      {row.securedText ? (
                        <span className="mt-2.5 block">
                          <span data-testid="mission-secured" className="mb-1.5 block text-[14px] font-semibold text-ink">
                            {row.securedText}
                          </span>
                          <ProgressBar percent={row.securedPercent} label="Achats confirmés" />
                        </span>
                      ) : null}
                      {row.coverageText ? (
                        <span data-testid="mission-coverage" className="mt-1.5 block text-[13px] text-ink-soft">
                          {row.coverageText}
                          {row.coveragePercent !== null ? ` (${row.coveragePercent} %)` : ""}
                        </span>
                      ) : null}
                      <span className="mt-1 block text-[13px] text-ink-soft">{row.budgetText}</span>
                    </span>
                    <ChevronRight className="mt-3 size-5 shrink-0 text-ink-soft" aria-hidden />
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
        {items !== null && items.length > 0 && nextCursor !== null ? (
          <div className="mt-4">
            <button
              onClick={() => void loadMore()}
              disabled={loadingMore}
              data-testid="missions-more"
              className="press flex min-h-12 w-full items-center justify-center gap-2 rounded-2xl border-2 border-line-strong bg-white px-5 py-3 text-[16px] font-bold text-ink hover:border-brand hover:text-brand disabled:cursor-not-allowed disabled:opacity-40"
            >
              {loadingMore ? MISSIONS_MORE_LOADING : MISSIONS_MORE_LABEL}
            </button>
            {moreError ? (
              <p role="alert" data-testid="missions-more-error" className="mt-2 flex items-center justify-center gap-2 text-[14px] font-semibold text-danger-ink">
                <CircleAlert className="size-4 shrink-0" aria-hidden />
                {moreError}
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
    </main>
  );
}
