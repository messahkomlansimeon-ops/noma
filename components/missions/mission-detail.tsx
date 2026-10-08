"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useUnauthorizedRedirect } from "@/components/session-gate";
import { ProgressBar } from "@/components/missions/missions-list";
import { ProposalSection } from "@/components/missions/proposal-section";
import { TopBar } from "@/components/top-bar";
import { Badge, KvRow } from "@/components/ui";
import { describeMissionError, missions, type MissionDetail as MissionDetailData, type MissionProposal } from "@/lib/client/missions-api";
import {
  CANCEL_MISSION_WARNING,
  MISSIONS_TITLE,
  MISSION_ACTION_DONE,
  MISSION_ACTION_LABELS,
  MISSION_LOADING,
  NO_PAYMENT_NOTICE,
  ORDERS_TITLE,
  missionEditPath,
  orderLine,
  percentOf,
  statusLabel,
  statusTone,
} from "@/lib/client/missions-view";
import { orderPath } from "@/lib/client/orders-view";
import { formatDateFr, formatFcfa } from "@/lib/client/wallet-view";
import type { MissionAction } from "@/lib/missions-rules";

/**
 * Page d'une mission (lot MV1) : état, quantité déjà achetée (achats CONFIRMÉS), budget, proposition de répartition entre vendeurs anonymes, achats de la mission et actions
 * (lancer, pause, reprise, annulation). « Écrire » et « Déclarer l'achat » sont des actions de l'acheteur, ligne par ligne : rien n'est envoyé ni déclaré automatiquement.
 * Aucun paiement de l'objet ne passe par noma.
 */
export function MissionDetail({ missionId }: { missionId: string }) {
  const redirectIfUnauthorized = useUnauthorizedRedirect();
  const [detail, setDetail] = useState<MissionDetailData | null>(null);
  const [proposal, setProposal] = useState<MissionProposal | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [armedCancel, setArmedCancel] = useState(false);
  const [pending, setPending] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const busy = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      try {
        const loaded = await missions.get(missionId, { signal: controller.signal });
        setDetail(loaded);
        setError(null);
        if (loaded.mission.status === "active" || loaded.mission.status === "paused") {
          const read = await missions.proposal(missionId, { signal: controller.signal });
          setProposal(read);
        } else {
          setProposal({ state: "inactive", lines: [], engaged: [], requestedQuantity: loaded.mission.quantity, committedQuantity: 0, committedXof: 0, remainingQuantity: loaded.mission.quantity, coveredQuantity: 0, coveragePercent: 0, budgetUsedXof: 0, budgetRemainingXof: loaded.mission.totalBudgetXof, totalBudgetXof: loaded.mission.totalBudgetXof, unitBudgetXof: loaded.mission.unitBudgetXof, sellerCount: 0, candidateCount: 0, reasons: [], readAt: new Date().toISOString() });
        }
      } catch (failure) {
        if (controller.signal.aborted || redirectIfUnauthorized(failure)) return;
        setError(describeMissionError(failure, "mission"));
      }
    })();
    return () => controller.abort();
  }, [missionId, reloadKey, redirectIfUnauthorized]);

  // Retour au premier plan : la couverture et les achats ont pu changer (un vendeur a confirmé, une annonce est arrivée).
  useEffect(() => {
    const onForeground = () => {
      if (document.visibilityState === "visible") setReloadKey((key) => key + 1);
    };
    document.addEventListener("visibilitychange", onForeground);
    return () => document.removeEventListener("visibilitychange", onForeground);
  }, []);

  const reload = useCallback(() => setReloadKey((key) => key + 1), []);

  const act = async (action: MissionAction) => {
    if (busy.current) return;
    if (action === "cancel" && !armedCancel) {
      setArmedCancel(true);
      return;
    }
    busy.current = true;
    setArmedCancel(false);
    setPending(true);
    setActionError(null);
    setNotice(null);
    try {
      await missions.act(missionId, action);
      setNotice(MISSION_ACTION_DONE[action]);
      reload();
    } catch (failure) {
      if (redirectIfUnauthorized(failure)) return;
      setActionError(describeMissionError(failure, "action"));
      reload();
    } finally {
      busy.current = false;
      setPending(false);
    }
  };

  const mission = detail?.mission ?? null;
  return (
    <main>
      <TopBar back="/missions" title="Mission" />
      <div className="px-4 pb-8">
        {error ? (
          <div role="alert" data-testid="mission-error" className="mt-4 rounded-2xl border border-line bg-white p-4 text-center">
            <p className="text-[14px] font-semibold text-ink">{error}</p>
            <button
              onClick={() => {
                setError(null);
                reload();
              }}
              className="mt-3 rounded-xl bg-forest px-5 py-2.5 text-[14px] font-bold text-white"
            >
              Réessayer
            </button>
            <Link href="/missions" className="mt-3 block text-[13px] font-bold text-forest">
              {MISSIONS_TITLE} ›
            </Link>
          </div>
        ) : mission === null || detail === null ? (
          <p className="mt-6 text-center text-[14px] text-ink-soft" aria-busy="true">
            {MISSION_LOADING}
          </p>
        ) : (
          <article data-testid="mission-detail" data-status={mission.status}>
            <h1 data-testid="mission-title" className="font-display text-[22px] font-extrabold leading-tight text-ink">
              {mission.title}
            </h1>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <Badge tone={statusTone(mission.status)}>
                <span data-testid="mission-status">{statusLabel(mission.status)}</span>
              </Badge>
              {mission.deadlineAt ? <span className="text-[12px] text-ink-soft">Jusqu'au {formatDateFr(mission.deadlineAt)}</span> : <span className="text-[12px] text-ink-soft">{mission.deadlineDays} jours après le lancement</span>}
            </div>

            {mission.status !== "draft" ? (
              <div className="mt-4 rounded-2xl border border-line bg-white p-3.5">
                <div data-testid="mission-secured" className="text-[15px] font-bold text-ink">
                  {mission.securedQuantity} sur {mission.quantity} achetés
                </div>
                <div className="mt-1.5">
                  <ProgressBar percent={percentOf(mission.securedQuantity, mission.quantity)} label="Achats confirmés" />
                </div>
                <div className="mt-1.5 text-[12px] text-ink-soft">
                  Seuls les achats que le vendeur a confirmés comptent.
                  {mission.pendingQuantity > 0 ? ` ${mission.pendingQuantity} en attente de confirmation.` : ""}
                </div>
              </div>
            ) : null}

            <div className="mt-3 divide-y divide-line rounded-2xl border border-line bg-white px-4 py-1">
              <KvRow label="Produit" value={mission.title.replace(/^\d+ × /, "")} />
              <KvRow label="État voulu" value={mission.condition} />
              <KvRow label="Budget par unité" value={formatFcfa(mission.unitBudgetXof)} />
              <KvRow label="Budget total" value={formatFcfa(mission.totalBudgetXof)} />
              {mission.status !== "draft" ? <KvRow label="Déjà engagé" value={formatFcfa(mission.committedXof)} /> : null}
              {mission.location ? <KvRow label="Lieu" value={mission.location} /> : null}
            </div>

            {notice ? (
              <p role="status" data-testid="mission-notice" className="mt-3 rounded-xl bg-sage px-3 py-2 text-[13px] font-semibold text-forest">
                {notice}
              </p>
            ) : null}
            {actionError ? (
              <p role="alert" data-testid="mission-action-error" className="mt-3 text-[13px] font-semibold text-carrot-ink">
                {actionError}
              </p>
            ) : null}

            {mission.canEdit || mission.canActivate || mission.canPause || mission.canResume || mission.canCancel ? (
              <div className="mt-4 grid gap-2.5">
                {mission.canActivate ? (
                  <button onClick={() => void act("activate")} disabled={pending} data-testid="mission-activate" className="rounded-xl bg-forest px-4 py-3 text-[15px] font-bold text-white disabled:opacity-50">
                    {MISSION_ACTION_LABELS.activate}
                  </button>
                ) : null}
                {mission.canEdit ? (
                  <Link href={missionEditPath(mission.id)} data-testid="mission-edit" className="rounded-xl border border-line bg-white px-4 py-3 text-center text-[14px] font-bold text-ink">
                    Modifier
                  </Link>
                ) : null}
                {mission.canPause ? (
                  <button onClick={() => void act("pause")} disabled={pending} data-testid="mission-pause" className="rounded-xl border border-line bg-white px-4 py-3 text-[14px] font-bold text-ink disabled:opacity-50">
                    {MISSION_ACTION_LABELS.pause}
                  </button>
                ) : null}
                {mission.canResume ? (
                  <button onClick={() => void act("resume")} disabled={pending} data-testid="mission-resume" className="rounded-xl bg-forest px-4 py-3 text-[14px] font-bold text-white disabled:opacity-50">
                    {MISSION_ACTION_LABELS.resume}
                  </button>
                ) : null}
                {mission.canCancel ? (
                  <button onClick={() => void act("cancel")} disabled={pending} data-testid="mission-cancel" className="rounded-xl border border-line bg-white px-4 py-3 text-[14px] font-bold text-ink disabled:opacity-50">
                    {armedCancel ? CANCEL_MISSION_WARNING : MISSION_ACTION_LABELS.cancel}
                  </button>
                ) : null}
              </div>
            ) : null}

            {mission.status === "active" || mission.status === "paused" ? <ProposalSection mission={mission} proposal={proposal} onChanged={reload} /> : null}

            {detail.orders.length > 0 ? (
              <section className="mt-5" data-testid="mission-orders">
                <h2 className="text-[16px] font-extrabold text-ink">{ORDERS_TITLE}</h2>
                <ul className="mt-2 space-y-2">
                  {detail.orders.map((order) => {
                    const line = orderLine(order);
                    return (
                      <li key={order.id} data-testid="mission-order" data-status={order.status}>
                        <Link href={orderPath("buyer", order.id)} className="flex items-center justify-between gap-3 rounded-2xl border border-line bg-white p-3">
                          <span className="min-w-0">
                            <span className="block text-[14px] font-bold text-ink">{line.title}</span>
                            <span className="block text-[12px] text-ink-soft">{line.text}</span>
                          </span>
                          <Badge tone={order.status === "confirmed" ? "sage" : order.status === "proposed" ? "carrot" : "wash"}>{line.statusText}</Badge>
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ) : null}

            <p data-testid="no-payment-notice" className="mt-5 text-[12px] leading-relaxed text-ink-soft">
              {NO_PAYMENT_NOTICE}
            </p>
          </article>
        )}
      </div>
    </main>
  );
}
