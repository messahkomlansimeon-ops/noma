"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { CircleAlert, CircleCheck, CircleX, ChevronRight, Flag, Layers, MessageCircle, Package, RotateCw, ShieldCheck, Undo2 } from "lucide-react";
import { ArtAlert } from "@/components/illustrations";
import { useUnauthorizedRedirect } from "@/components/session-gate";
import { TopBar } from "@/components/top-bar";
import { Badge, Btn, Card, IconTile, KvRow, Skeleton } from "@/components/ui";
import { api } from "@/lib/client/api";
import { conversationPath } from "@/lib/client/messages-view";
import {
  CANCEL_LABEL,
  CONFIRM_LABEL,
  DECLINE_LABEL,
  MARK_SATISFIED_LABEL,
  NO_PAYMENT_NOTICE,
  ORDER_ACTION_DONE,
  SATISFIED_DONE,
  orderPath,
  statusLabel,
  statusTone,
} from "@/lib/client/orders-view";
import { describeSocialError, social, type OrderAction, type OrderView } from "@/lib/client/social-api";
import { reportOrderPath } from "@/lib/client/reports-view";
import { formatDateTimeFr, formatFcfa } from "@/lib/client/wallet-view";

const PRIMARY_BTN =
  "press flex min-h-12 w-full items-center justify-center gap-2 rounded-2xl bg-brand px-5 py-3 text-[16px] font-bold text-white hover:bg-brand-deep disabled:cursor-not-allowed disabled:opacity-40";
const OUTLINE_BTN =
  "press flex min-h-12 w-full items-center justify-center gap-2 rounded-2xl border-2 border-line-strong bg-white px-5 py-3 text-[16px] font-bold text-ink hover:border-brand hover:text-brand disabled:cursor-not-allowed disabled:opacity-40";
const LINK_ROW = "press flex min-h-14 items-center gap-3 rounded-2xl border border-line bg-white px-3 py-2 text-[15px] font-bold text-ink hover:border-brand";

/**
 * Détail d'une commande (lot D2) : le vendeur confirme ou refuse, l'acheteur annule tant que ce n'est pas confirmé ; une fois confirmée, le besoin de l'acheteur peut être
 * marqué satisfait (proposé, jamais automatique). Aucun paiement de l'objet ne passe par noma : c'est écrit à l'écran.
 */
export function OrderDetail({ orderId, space }: { orderId: string; space: "buyer" | "vendor" }) {
  const router = useRouter();
  const redirectIfUnauthorized = useUnauthorizedRedirect();
  const [order, setOrder] = useState<OrderView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const busy = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    social.orders.get(orderId, { signal: controller.signal }).then(
      (loaded) => {
        // Un participant arrivé par l'autre espace (lien d'une notification…) est ramené dans le sien.
        if (loaded.role !== (space === "buyer" ? "buyer" : "seller")) {
          router.replace(orderPath(loaded.role, loaded.id));
          return;
        }
        setOrder(loaded);
        setError(null);
      },
      (failure) => {
        if (controller.signal.aborted || redirectIfUnauthorized(failure)) return;
        setError(describeSocialError(failure, "order"));
      },
    );
    return () => controller.abort();
  }, [orderId, space, reloadKey, redirectIfUnauthorized, router]);

  const run = useCallback(
    async (work: () => Promise<string>) => {
      if (busy.current) return;
      busy.current = true;
      setPending(true);
      setActionError(null);
      setNotice(null);
      try {
        setNotice(await work());
      } catch (failure) {
        if (redirectIfUnauthorized(failure)) return;
        setActionError(describeSocialError(failure, "order"));
        setReloadKey((key) => key + 1);
      } finally {
        busy.current = false;
        setPending(false);
      }
    },
    [redirectIfUnauthorized],
  );

  const act = (action: OrderAction) =>
    run(async () => {
      setOrder(await social.orders.act(orderId, action));
      return ORDER_ACTION_DONE[action];
    });

  const markSatisfied = () =>
    run(async () => {
      if (order === null || order.demandId === null) throw new Error("no demand");
      const demand = await api.demands.get(order.demandId);
      await api.demands.satisfy(order.demandId, demand.contentVersion);
      setOrder(await social.orders.get(orderId));
      return SATISFIED_DONE;
    });

  const back = space === "buyer" ? "/commandes" : "/vendeur/commandes";
  return (
    <main>
      <TopBar back={back} title="Commande" />
      <div className="px-4 pb-6">
        {error ? (
          <div role="alert" data-testid="order-error" className="animate-rise mt-4 flex flex-col items-center gap-4 rounded-3xl border border-line bg-white p-6 text-center">
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
        ) : order === null ? (
          <div className="mt-4 flex flex-col gap-3" aria-busy="true">
            <span className="sr-only">Chargement de la commande…</span>
            <Skeleton className="h-16 w-full rounded-3xl" />
            <Skeleton className="h-32 w-full rounded-3xl" />
            <Skeleton className="h-14 w-full rounded-2xl" />
          </div>
        ) : (
          <article data-testid="order-detail" data-status={order.status} className="mt-3 flex flex-col gap-4">
            <header className="animate-rise flex items-center gap-3">
              <IconTile icon={Package} className="size-14" />
              <div className="min-w-0 flex-1">
                <h1 className="text-[22px] font-extrabold leading-tight tracking-tight text-ink">{order.title}</h1>
                <Badge tone={statusTone(order.status)} className="mt-1.5">
                  <span data-testid="order-status">{statusLabel(order.status, order.role)}</span>
                </Badge>
              </div>
            </header>

            <Card className="animate-rise">
              <div data-testid="order-price" className="text-[32px] font-extrabold leading-tight text-ink">
                {formatFcfa(order.price.amount)}
                {order.quantity > 1 ? " l'unité" : ""}
              </div>
              {order.quantity > 1 ? (
                // Lot MV1 : un achat en volume dit la quantité et le total ; le vendeur ne voit que cette commande, jamais la mission entière.
                <div data-testid="order-quantity-line" className="text-[15px] font-semibold text-ink">
                  {order.role === "seller" ? "Quantité demandée" : "Quantité"} : {order.quantity} · Total {formatFcfa(order.price.amount * order.quantity)}
                </div>
              ) : null}
              <div className="mt-2 divide-y divide-line">
                <KvRow label="Déclarée le" value={formatDateTimeFr(order.createdAt)} />
                {order.decidedAt ? <KvRow label="Décision le" value={formatDateTimeFr(order.decidedAt)} /> : null}
                <KvRow label={order.role === "buyer" ? "Vendeur" : "Acheteur"} value={order.role === "buyer" ? "Vendeur de l'annonce" : "Acheteur intéressé"} />
              </div>
            </Card>

            {notice ? (
              <p role="status" data-testid="order-notice" className="animate-pop flex items-center gap-2.5 rounded-2xl bg-success-soft px-4 py-3 text-[15px] font-semibold text-success-ink">
                <CircleCheck className="size-5 shrink-0" aria-hidden />
                {notice}
              </p>
            ) : null}
            {actionError ? (
              <p role="alert" data-testid="order-action-error" className="animate-pop flex items-center gap-2.5 rounded-2xl bg-danger-soft px-4 py-3 text-[15px] font-semibold text-danger-ink">
                <CircleAlert className="size-5 shrink-0" aria-hidden />
                {actionError}
              </p>
            ) : null}

            {order.canConfirm || order.canDecline || order.canCancel ? (
              <div className="grid gap-3 md:grid-cols-2">
                {order.canConfirm ? (
                  <button onClick={() => void act("confirm")} disabled={pending} data-testid="order-confirm" className={PRIMARY_BTN}>
                    <CircleCheck className="size-5" aria-hidden />
                    {CONFIRM_LABEL}
                  </button>
                ) : null}
                {order.canDecline ? (
                  <button onClick={() => void act("decline")} disabled={pending} data-testid="order-decline" className={OUTLINE_BTN}>
                    <CircleX className="size-5" aria-hidden />
                    {DECLINE_LABEL}
                  </button>
                ) : null}
                {order.canCancel ? (
                  <button onClick={() => void act("cancel")} disabled={pending} data-testid="order-cancel" className={OUTLINE_BTN}>
                    <Undo2 className="size-5" aria-hidden />
                    {CANCEL_LABEL}
                  </button>
                ) : null}
              </div>
            ) : null}

            {order.canMarkDemandSatisfied ? (
              <section className="animate-rise rounded-3xl bg-brand-soft p-4" data-testid="order-satisfy">
                <button onClick={() => void markSatisfied()} disabled={pending} data-testid="order-satisfy-button" className={PRIMARY_BTN}>
                  <CircleCheck className="size-5" aria-hidden />
                  {MARK_SATISFIED_LABEL}
                </button>
              </section>
            ) : null}

            <p data-testid="no-payment-notice" className="flex items-start gap-2.5 rounded-2xl bg-mist p-3.5 text-[13px] leading-relaxed text-ink-soft">
              <ShieldCheck className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />
              {NO_PAYMENT_NOTICE}
            </p>

            <div className="flex flex-col gap-2.5 md:grid md:grid-cols-2">
              {order.role === "buyer" && order.missionId ? (
                <Link href={`/missions/${order.missionId}`} data-testid="order-mission-link" className={LINK_ROW}>
                  <IconTile icon={Layers} className="size-10" />
                  <span className="flex-1">Voir la mission</span>
                  <ChevronRight className="size-5 text-ink-soft" aria-hidden />
                </Link>
              ) : null}
              {order.conversationId ? (
                <Link href={conversationPath(order.role, order.conversationId)} className={LINK_ROW}>
                  <IconTile icon={MessageCircle} tone="info" className="size-10" />
                  <span className="flex-1">Ouvrir la conversation</span>
                  <ChevronRight className="size-5 text-ink-soft" aria-hidden />
                </Link>
              ) : null}
              {reportOrderPath(orderId) ? (
                <Link href={reportOrderPath(orderId) ?? "/signaler"} data-testid="report-order" className={LINK_ROW}>
                  <IconTile icon={Flag} tone="mist" className="size-10" />
                  <span className="flex-1">Signaler cette commande</span>
                  <ChevronRight className="size-5 text-ink-soft" aria-hidden />
                </Link>
              ) : null}
            </div>
          </article>
        )}
      </div>
    </main>
  );
}
