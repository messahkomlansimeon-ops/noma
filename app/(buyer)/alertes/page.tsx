"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Plus } from "lucide-react";
import { SessionGate, useUnauthorizedRedirect } from "@/components/session-gate";
import { Thumb } from "@/components/thumb";
import { Badge, BtnOutline } from "@/components/ui";
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
    <main>
      <div className="flex items-center justify-between px-4 py-3">
        <Link href="/" className="flex size-9 items-center">
          <span className="font-display text-[20px] font-extrabold text-forest">
            noma
          </span>
        </Link>
      </div>

      <div className="px-4">
        <h1 className="font-display text-[26px] font-extrabold text-ink">
          Mes besoins
        </h1>

        <div className="mt-3 flex flex-wrap gap-2">
          {DEMAND_FILTERS.map((f) => (
            <button
              key={f.id}
              onClick={() => {
                setFilter(f.id);
                setArmed(null);
              }}
              className={`rounded-full px-3.5 py-1.5 text-[13px] font-semibold transition ${
                filter === f.id
                  ? "bg-forest text-white"
                  : "border border-line bg-white text-ink"
              }`}
            >
              {f.label}
              {demands ? countSuffix(filterDemands(demands, f.id).length, truncated) : ""}
            </button>
          ))}
        </div>

        {truncated && !loadError ? (
          <p role="status" className="mt-3 text-[13px] font-semibold text-carrot-ink">
            {LIST_TRUNCATED_MESSAGE}
          </p>
        ) : null}

        {loadError ? (
          <div role="alert" className="mt-4 rounded-2xl border border-line bg-white p-4 text-center">
            <p className="text-[14px] font-semibold text-ink">{loadError}</p>
            <button
              onClick={() => {
                setLoadError(null);
                reload();
              }}
              className="mt-3 rounded-xl bg-forest px-5 py-2.5 text-[14px] font-bold text-white"
            >
              Réessayer
            </button>
          </div>
        ) : demands === null ? (
          <p className="mt-6 text-center text-[14px] text-ink-soft" aria-busy="true">
            Chargement de vos besoins…
          </p>
        ) : visible.length === 0 ? (
          <p className="mt-6 text-center text-[14px] text-ink-soft">
            {demands.length === 0
              ? "Vous n'avez pas encore de besoin."
              : "Aucun besoin ne correspond à ce filtre."}
          </p>
        ) : (
          <div className="mt-4 space-y-3">
            {visible.map((demand) => {
              const status = DEMAND_STATUS_VIEW[demand.status];
              const summary = demandSummary(demand);
              const busy = busyId === demand.id;
              return (
                <div key={demand.id} className="rounded-2xl border border-line bg-white p-3.5">
                  <div className="flex items-center gap-3">
                    <Thumb art={artForCategory(demand.category)} className="size-12" iconClassName="size-6" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[15px] font-bold text-ink">
                        {recordTitle(demand)}
                      </div>
                      {summary && <div className="text-[12px] text-ink-soft">{summary}</div>}
                    </div>
                  </div>
                  <div className="mt-2">
                    <Badge tone={status.tone}>{status.label}</Badge>
                  </div>
                  {demandActions(demand.status).length > 0 && (
                    <div className="mt-2.5 flex border-t border-line pt-2.5">
                      {demandActions(demand.status).map((a, index) => (
                        <button
                          key={a.action}
                          onClick={() => void run(demand, a.action)}
                          disabled={busyId !== null}
                          className={`flex flex-1 items-center justify-center gap-1.5 text-[13px] font-bold disabled:opacity-40 ${
                            a.action === "archive" && armed === `${demand.id}:archive`
                              ? "text-carrot-ink"
                              : "text-ink"
                          } ${index > 0 ? "border-l border-line" : ""}`}
                        >
                          {busy
                            ? "…"
                            : a.action === "archive" && armed === `${demand.id}:archive`
                              ? "Confirmer l'archivage"
                              : a.label}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        <BtnOutline href="/alerte/nouvelle" className="mt-4">
          <Plus className="size-4" />
          Nouveau besoin
        </BtnOutline>
      </div>
    </main>
  );
}

export default function RecherchesSuivies() {
  return (
    <SessionGate>
      <MesBesoins />
    </SessionGate>
  );
}
