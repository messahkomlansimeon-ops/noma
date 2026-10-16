"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronRight, CircleAlert, CircleCheck, Layers, Pause, Pencil, Play, Rocket, RotateCw, ShieldCheck, ShoppingBag, CircleX } from "lucide-react";
import { ArtAlert } from "@/components/illustrations";
import { useUnauthorizedRedirect } from "@/components/session-gate";
import { ProgressBar } from "@/components/missions/missions-list";
import { ProposalSection } from "@/components/missions/proposal-section";
import { TopBar } from "@/components/top-bar";
import { Badge, Btn, Card, IconTile, KvRow, Skeleton } from "@/components/ui";
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

const PRIMARY_BTN =
  "press flex min-h-12 w-full items-center justify-center gap-2 rounded-2xl bg-brand px-5 py-3 text-[16px] font-bold text-white hover:bg-brand-deep disabled:cursor-not-allowed disabled:opacity-40";
const OUTLINE_BTN =
  "press flex min-h-12 w-full items-center justify-center gap-2 rounded-2xl border-2 border-line-strong bg-white px-5 py-3 text-[16px] font-bold text-ink hover:border-brand hover:text-brand disabled:cursor-not-allowed disabled:opacity-40";

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
          <div role="alert" data-testid="mission-error" className="animate-rise mt-4 flex flex-col items-center gap-4 rounded-3xl border border-line bg-white p-6 text-center">
            <ArtAlert className="size-24" />
            <p className="text-[16px] font-bold text-ink">{error}</p>
            <div className="w-full max-w-xs">
              <Btn
                onClick={() => {
                  setError(null);
                  reload();
                }}
              >
                <RotateCw className="size-5" aria-hidden />
                Réessayer
              </Btn>
            </div>
            <Link href="/missions" className="press flex min-h-11 items-center gap-1 text-[15px] font-bold text-brand">
              {MISSIONS_TITLE}
              <ChevronRight className="size-4" aria-hidden />
            </Link>
          </div>
        ) : mission === null || detail === null ? (
          <div className="mt-4 flex flex-col gap-3" aria-busy="true">
            <span className="sr-only">{MISSION_LOADING}</span>
            <Skeleton className="h-16 w-full rounded-3xl" />
            <Skeleton className="h-24 w-full rounded-3xl" />
            <Skeleton className="h-36 w-full rounded-3xl" />
          </div>
        ) : (
          <article data-testid="mission-detail" data-status={mission.status} className="mt-3 flex flex-col gap-4">
            <header className="animate-rise flex items-center gap-3">
              <IconTile icon={Layers} className="size-14" />
              <div className="min-w-0 flex-1">
                <h1 data-testid="mission-title" className="text-[22px] font-extrabold leading-tight tracking-tight text-ink">
                  {mission.title}
                </h1>
                <div className="mt-1.5 flex flex-wrap items-center gap-2">
                  <Badge tone={statusTone(mission.status)}>
                    <span data-testid="mission-status">{statusLabel(mission.status)}</span>
                  </Badge>
                  {mission.deadlineAt ? <span className="text-[13px] text-ink-soft">Jusqu'au {formatDateFr(mission.deadlineAt)}</span> : <span className="text-[13px] text-ink-soft">{mission.deadlineDays} jours après le lancement</span>}
                </div>
              </div>
            </header>

            {mission.status !== "draft" ? (
              <Card className="animate-rise">
                <div data-testid="mission-secured" className="mb-2 flex items-center gap-2 text-[16px] font-bold text-ink">
                  <ShoppingBag className="size-5 text-brand" aria-hidden />
                  {mission.securedQuantity} sur {mission.quantity} achetés
                </div>
                <ProgressBar percent={percentOf(mission.securedQuantity, mission.quantity)} label="Achats confirmés" />
                {mission.pendingQuantity > 0 ? <div className="mt-2 text-[13px] text-ink-soft">{mission.pendingQuantity} en attente de confirmation.</div> : null}
              </Card>
            ) : null}

            <Card className="animate-rise divide-y divide-line py-1">
              <KvRow label="Produit" value={mission.title.replace(/^\d+ × /, "")} />
              <KvRow label="État voulu" value={mission.condition} />
              <KvRow label="Budget par unité" value={formatFcfa(mission.unitBudgetXof)} />
              <KvRow label="Budget total" value={formatFcfa(mission.totalBudgetXof)} />
              {mission.status !== "draft" ? <KvRow label="Déjà engagé" value={formatFcfa(mission.committedXof)} /> : null}
              {mission.location ? <KvRow label="Lieu" value={mission.location} /> : null}
            </Card>

            {notice ? (
              <p role="status" data-testid="mission-notice" className="animate-pop flex items-center gap-2.5 rounded-2xl bg-success-soft px-4 py-3 text-[15px] font-semibold text-success-ink">
                <CircleCheck className="size-5 shrink-0" aria-hidden />
                {notice}
              </p>
            ) : null}
            {actionError ? (
              <p role="alert" data-testid="mission-action-error" className="animate-pop flex items-center gap-2.5 rounded-2xl bg-danger-soft px-4 py-3 text-[15px] font-semibold text-danger-ink">
                <CircleAlert className="size-5 shrink-0" aria-hidden />
                {actionError}
              </p>
            ) : null}

            {mission.canEdit || mission.canActivate || mission.canPause || mission.canResume || mission.canCancel ? (
              <div className="grid gap-3 md:grid-cols-2">
                {mission.canActivate ? (
                  <button onClick={() => void act("activate")} disabled={pending} data-testid="mission-activate" className={PRIMARY_BTN}>
                    <Rocket className="size-5" aria-hidden />
                    {MISSION_ACTION_LABELS.activate}
                  </button>
                ) : null}
                {mission.canEdit ? (
                  <Link href={missionEditPath(mission.id)} data-testid="mission-edit" className={OUTLINE_BTN}>
                    <Pencil className="size-5" aria-hidden />
                    Modifier
                  </Link>
                ) : null}
                {mission.canPause ? (
                  <button onClick={() => void act("pause")} disabled={pending} data-testid="mission-pause" className={OUTLINE_BTN}>
                    <Pause className="size-5" aria-hidden />
                    {MISSION_ACTION_LABELS.pause}
                  </button>
                ) : null}
                {mission.canResume ? (
                  <button onClick={() => void act("resume")} disabled={pending} data-testid="mission-resume" className={PRIMARY_BTN}>
                    <Play className="size-5" aria-hidden />
                    {MISSION_ACTION_LABELS.resume}
                  </button>
                ) : null}
                {mission.canCancel ? (
                  <button
                    onClick={() => void act("cancel")}
                    disabled={pending}
                    data-testid="mission-cancel"
                    className={armedCancel ? `${OUTLINE_BTN} animate-pop border-danger text-danger-ink hover:border-danger hover:text-danger-ink` : OUTLINE_BTN}
                  >
                    <CircleX className="size-5" aria-hidden />
                    {armedCancel ? CANCEL_MISSION_WARNING : MISSION_ACTION_LABELS.cancel}
                  </button>
                ) : null}
              </div>
            ) : null}

            {mission.status === "active" || mission.status === "paused" ? <ProposalSection mission={mission} proposal={proposal} onChanged={reload} /> : null}

            {detail.orders.length > 0 ? (
              <section className="flex flex-col gap-3" data-testid="mission-orders">
                <h2 className="flex items-center gap-2 text-[18px] font-extrabold tracking-tight text-ink">
                  <ShoppingBag className="size-5 text-brand" aria-hidden />
                  {ORDERS_TITLE}
                </h2>
                <ul className="stagger flex flex-col gap-3 md:grid md:grid-cols-2">
                  {detail.orders.map((order) => {
                    const line = orderLine(order);
                    return (
                      <li key={order.id} data-testid="mission-order" data-status={order.status}>
                        <Link href={orderPath("buyer", order.id)} className="press flex h-full items-center gap-3 rounded-3xl border border-line bg-white p-3.5 hover:border-brand">
                          <span className="min-w-0 flex-1">
                            <span className="block text-[15px] font-bold text-ink">{line.title}</span>
                            <span className="block text-[13px] text-ink-soft">{line.text}</span>
                          </span>
                          <Badge tone={order.status === "confirmed" ? "sage" : order.status === "proposed" ? "carrot" : "wash"}>{line.statusText}</Badge>
                          <ChevronRight className="size-5 shrink-0 text-ink-soft" aria-hidden />
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ) : null}

            <p data-testid="no-payment-notice" className="flex items-start gap-2.5 rounded-2xl bg-mist p-3.5 text-[13px] leading-relaxed text-ink-soft">
              <ShieldCheck className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />
              {NO_PAYMENT_NOTICE}
            </p>
          </article>
        )}
      </div>
    </main>
  );
}
