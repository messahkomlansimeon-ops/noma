"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ArrowRight, Archive, Bell, ChevronRight, CircleCheck, Play, Plus, RotateCw, TriangleAlert, type LucideIcon } from "lucide-react";
import { ArtAlert, ArtSearch } from "@/components/illustrations";
import { LogoMark } from "@/components/logo";
import { SessionGate, useUnauthorizedRedirect } from "@/components/session-gate";
import { Thumb } from "@/components/thumb";
import { HeaderBtn } from "@/components/top-bar";
import { Badge, Btn, BtnOutline, Chip, EmptyState, Skeleton } from "@/components/ui";
import { UnreadBadge, UnreadSync } from "@/components/unread-badge";
import { ApiError, api, describeApiError, type DemandRecord } from "@/lib/client/api";
import {
  DEMAND_FILTERS,
  DEMAND_STATUS_VIEW,
  LIST_TRUNCATED_MESSAGE,
  artForCategory,
  countSuffix,
  demandActions,
  demandSummary,
  filterDemands,
  newestFirst,
  recordTitle,
  replaceRecord,
  type DemandAction,
  type DemandFilter,
} from "@/lib/client/catalog-view";
import { useNoma } from "@/lib/store";

const ACTION_DONE: Record<DemandAction, string> = {
  activate: "Besoin activé",
  satisfy: "Besoin marqué satisfait",
  archive: "Besoin archivé",
};

const ACTION_ICONS: Record<DemandAction, LucideIcon> = { activate: Play, satisfy: CircleCheck, archive: Archive };

function MesBesoins() {
  const showToast = useNoma((s) => s.showToast);
  const redirectIfUnauthorized = useUnauthorizedRedirect();
  const [demands, setDemands] = useState<DemandRecord[] | null>(null);
  // Plafond de pages atteint : la liste est incomplète et les compteurs ne sont pas exacts.
  const [truncated, setTruncated] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [filter, setFilter] = useState<DemandFilter>("all");
  const [busyId, setBusyId] = useState<string | null>(null);
  // Archiver est définitif : un premier appui arme l'action, le second la confirme.
  const [armed, setArmed] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    api.demands.listAll({ signal: controller.signal }).then(
      (result) => {
        setDemands(newestFirst(result.items));
        setTruncated(result.truncated);
        setLoadError(null);
      },
      (failure) => {
        if (controller.signal.aborted || redirectIfUnauthorized(failure)) return;
        setLoadError(describeApiError(failure, "catalog"));
      },
    );
    return () => controller.abort();
  }, [reloadKey, redirectIfUnauthorized]);

  const reload = () => setReloadKey((key) => key + 1);

  const run = async (demand: DemandRecord, action: DemandAction) => {
    if (busyId) return;
    if (action === "archive" && armed !== `${demand.id}:archive`) {
      setArmed(`${demand.id}:archive`);
      return;
    }
    setArmed(null);
    setBusyId(demand.id);
    try {
      const updated =
        action === "activate"
          ? await api.demands.activate(demand.id, demand.contentVersion)
          : action === "satisfy"
            ? await api.demands.satisfy(demand.id, demand.contentVersion)
            : await api.demands.archive(demand.id, demand.contentVersion);
      setDemands((current) => (current ? replaceRecord(current, updated) : current));
      showToast(ACTION_DONE[action]);
    } catch (failure) {
      if (redirectIfUnauthorized(failure)) return;
      showToast(describeApiError(failure, "catalog"));
      // Version obsolète, statut changé ou besoin disparu : la liste affichée n'est plus fiable.
      if (failure instanceof ApiError && (failure.status === 404 || failure.status === 409)) reload();
    } finally {
      setBusyId(null);
    }
  };

  const visible = filterDemands(demands ?? [], filter);

  return (
    <main className="flex flex-col gap-5 px-4 pb-6 pt-3">
      <div className="flex items-center justify-between">
        <span className="md:hidden">
          <LogoMark />
        </span>
        <span className="hidden md:block" />
        <span className="relative">
          <HeaderBtn icon={Bell} href="/notifications" label="Notifications" />
          <UnreadBadge className="pointer-events-none absolute -right-0.5 -top-0.5" />
        </span>
      </div>
      <h1 className="-mt-2 text-[24px] font-extrabold tracking-tight text-ink">Mes besoins</h1>

      <div className="no-scrollbar -mx-4 flex gap-2 overflow-x-auto px-4">
        {DEMAND_FILTERS.map((f) => (
          <Chip
            key={f.id}
            active={filter === f.id}
            className="min-h-11 shrink-0"
            onClick={() => {
              setFilter(f.id);
              setArmed(null);
            }}
          >
            {f.label}
            {demands ? countSuffix(filterDemands(demands, f.id).length, truncated) : ""}
          </Chip>
        ))}
      </div>

      {truncated && !loadError ? (
        <p role="status" className="flex items-start gap-2 rounded-2xl bg-accent-soft px-3.5 py-3 text-[14px] font-semibold text-accent-ink">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          {LIST_TRUNCATED_MESSAGE}
        </p>
      ) : null}

      {loadError ? (
        <div role="alert" className="animate-rise flex flex-col items-center gap-4 px-6 py-8 text-center">
          <ArtAlert className="size-28" />
          <p className="text-[16px] font-bold text-ink">{loadError}</p>
          <div className="w-full max-w-xs">
            <Btn
              onClick={() => {
                setLoadError(null);
                reload();
              }}
            >
              <RotateCw className="size-5" aria-hidden />
              Réessayer
            </Btn>
          </div>
        </div>
      ) : demands === null ? (
        <div className="flex flex-col gap-3" aria-busy="true">
          <span className="sr-only">Chargement de vos besoins…</span>
          <Skeleton className="h-28 w-full rounded-3xl" />
          <Skeleton className="h-28 w-full rounded-3xl" />
          <Skeleton className="h-28 w-full rounded-3xl" />
        </div>
      ) : visible.length === 0 ? (
        <EmptyState
          art={<ArtSearch className="size-36" />}
          title={demands.length === 0 ? "Vous n'avez pas encore de besoin." : "Aucun besoin ne correspond à ce filtre."}
          action={
            demands.length === 0 ? (
              <Btn href="/alerte/nouvelle">
                <Plus className="size-5" aria-hidden />
                Nouveau besoin
              </Btn>
            ) : undefined
          }
        />
      ) : (
        <div className="stagger flex flex-col gap-3 md:grid md:grid-cols-2">
          {visible.map((demand) => {
            const status = DEMAND_STATUS_VIEW[demand.status];
            const summary = demandSummary(demand);
            const busy = busyId === demand.id;
            const actions = demandActions(demand.status);
            return (
              <div key={demand.id} className="flex flex-col gap-2.5 rounded-3xl border border-line bg-white p-3.5">
                <Link
                  href={`/besoins/${demand.id}`}
                  aria-label={`Voir les offres pour : ${recordTitle(demand)}`}
                  className="press flex items-center gap-3"
                >
                  <Thumb art={artForCategory(demand.category)} className="size-14" iconClassName="size-7" />
                  <div className="min-w-0 flex-1">
                    <div className="line-clamp-2 text-[16px] font-bold leading-snug text-ink">{recordTitle(demand)}</div>
                    {summary && <div className="text-[14px] text-ink-soft">{summary}</div>}
                  </div>
                  <ChevronRight className="size-5 shrink-0 text-ink-soft" aria-hidden />
                </Link>
                <div className="flex items-center justify-between gap-2">
                  <Badge tone={status.tone}>{status.label}</Badge>
                  <Link href={`/besoins/${demand.id}`} className="press flex min-h-11 items-center gap-1 text-[14px] font-bold text-brand">
                    {demand.status === "active" ? "Voir les offres" : "Détails"}
                    <ArrowRight className="size-4" aria-hidden />
                  </Link>
                </div>
                {actions.length > 0 && (
                  <div className="flex gap-2 border-t border-line pt-2.5">
                    {actions.map((a) => {
                      const confirmArchive = a.action === "archive" && armed === `${demand.id}:archive`;
                      const ActionIcon = ACTION_ICONS[a.action];
                      return (
                        <button
                          key={a.action}
                          onClick={() => void run(demand, a.action)}
                          disabled={busyId !== null}
                          className={`press flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-2xl px-2 text-[14px] font-bold disabled:opacity-40 ${
                            confirmArchive ? "bg-accent-soft text-accent-ink" : "bg-mist text-ink hover:bg-line"
                          }`}
                        >
                          <ActionIcon className="size-4 shrink-0" aria-hidden />
                          {busy ? "…" : confirmArchive ? "Confirmer l'archivage" : a.label}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {demands !== null && demands.length === 0 && !loadError ? null : (
        <BtnOutline href="/alerte/nouvelle">
          <Plus className="size-5" aria-hidden />
          Nouveau besoin
        </BtnOutline>
      )}
    </main>
  );
}

export default function RecherchesSuivies() {
  return (
    <SessionGate>
      <UnreadSync />
      <MesBesoins />
    </SessionGate>
  );
}
