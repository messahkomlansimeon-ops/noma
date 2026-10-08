"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { useUnauthorizedRedirect } from "@/components/session-gate";
import { TopBar } from "@/components/top-bar";
import { Badge, KvRow } from "@/components/ui";
import { api } from "@/lib/client/api";
import { conversationPath } from "@/lib/client/messages-view";
import {
  CANCEL_LABEL,
  CONFIRM_LABEL,
  DECLINE_LABEL,
  MARK_SATISFIED_HINT,
  MARK_SATISFIED_LABEL,
  NO_PAYMENT_NOTICE,
  ORDER_ACTION_DONE,
  SATISFIED_DONE,
  orderPath,
  statusLabel,
  statusTone,
} from "@/lib/client/orders-view";
import { describeSocialError, social, type OrderAction, type OrderView } from "@/lib/client/social-api";
import { formatDateTimeFr, formatFcfa } from "@/lib/client/wallet-view";

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
          <div role="alert" data-testid="order-error" className="mt-4 rounded-2xl border border-line bg-white p-4 text-center">
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
        ) : order === null ? (
          <p className="mt-6 text-center text-[14px] text-ink-soft" aria-busy="true">
            Chargement de la commande…
          </p>
        ) : (
          <article data-testid="order-detail" data-status={order.status}>
            <h1 className="font-display text-[22px] font-extrabold leading-tight text-ink">{order.title}</h1>
            <div data-testid="order-price" className="font-display text-[26px] font-extrabold text-ink">
              {formatFcfa(order.price.amount)}
              {order.quantity > 1 ? " l'unité" : ""}
            </div>
            {order.quantity > 1 ? (
              // Lot MV1 : un achat en volume dit la quantité et le total ; le vendeur ne voit que cette commande, jamais la mission entière.
              <div data-testid="order-quantity-line" className="text-[14px] font-semibold text-ink">
                {order.role === "seller" ? "Quantité demandée" : "Quantité"} : {order.quantity} · Total {formatFcfa(order.price.amount * order.quantity)}
              </div>
            ) : null}
            <div className="mt-1">
              <Badge tone={statusTone(order.status)}>
                <span data-testid="order-status">{statusLabel(order.status, order.role)}</span>
              </Badge>
            </div>
            <div className="mt-3 divide-y divide-line rounded-2xl border border-line bg-white px-4 py-1">
              <KvRow label="Déclarée le" value={formatDateTimeFr(order.createdAt)} />
              {order.decidedAt ? <KvRow label="Décision le" value={formatDateTimeFr(order.decidedAt)} /> : null}
              <KvRow label={order.role === "buyer" ? "Vendeur" : "Acheteur"} value={order.role === "buyer" ? "Vendeur de l'annonce" : "Acheteur intéressé"} />
            </div>
            {order.role === "buyer" && order.missionId ? (
              <Link href={`/missions/${order.missionId}`} data-testid="order-mission-link" className="mt-3 inline-block text-[13px] font-bold text-forest">
                Voir la mission ›
              </Link>
            ) : null}

            {notice ? (
              <p role="status" data-testid="order-notice" className="mt-3 rounded-xl bg-sage px-3 py-2 text-[13px] font-semibold text-forest">
                {notice}
              </p>
            ) : null}
            {actionError ? (
              <p role="alert" data-testid="order-action-error" className="mt-3 text-[13px] font-semibold text-carrot-ink">
                {actionError}
              </p>
            ) : null}

            {order.canConfirm || order.canDecline || order.canCancel ? (
              <div className="mt-4 grid gap-2.5">
                {order.canConfirm ? (
                  <button onClick={() => void act("confirm")} disabled={pending} data-testid="order-confirm" className="rounded-xl bg-forest px-4 py-3 text-[15px] font-bold text-white transition active:scale-[0.99] disabled:opacity-50">
                    {CONFIRM_LABEL}
                  </button>
                ) : null}
                {order.canDecline ? (
                  <button onClick={() => void act("decline")} disabled={pending} data-testid="order-decline" className="rounded-xl border border-line bg-white px-4 py-3 text-[14px] font-bold text-ink disabled:opacity-50">
                    {DECLINE_LABEL}
                  </button>
                ) : null}
                {order.canCancel ? (
                  <button onClick={() => void act("cancel")} disabled={pending} data-testid="order-cancel" className="rounded-xl border border-line bg-white px-4 py-3 text-[14px] font-bold text-ink disabled:opacity-50">
                    {CANCEL_LABEL}
                  </button>
                ) : null}
              </div>
            ) : null}

            {order.canMarkDemandSatisfied ? (
              <section className="mt-4 rounded-2xl bg-sage p-4" data-testid="order-satisfy">
                <p className="text-[13px] text-sage-ink">{MARK_SATISFIED_HINT}</p>
                <button onClick={() => void markSatisfied()} disabled={pending} data-testid="order-satisfy-button" className="mt-2 w-full rounded-xl bg-forest px-4 py-3 text-[14px] font-bold text-white disabled:opacity-50">
                  {MARK_SATISFIED_LABEL}
                </button>
              </section>
            ) : null}

            <p data-testid="no-payment-notice" className="mt-4 text-[12px] leading-relaxed text-ink-soft">
              {NO_PAYMENT_NOTICE}
            </p>
            {order.conversationId ? (
              <Link href={conversationPath(order.role, order.conversationId)} className="mt-3 inline-block text-[13px] font-bold text-forest">
                Ouvrir la conversation ›
              </Link>
            ) : null}
          </article>
        )}
      </div>
    </main>
  );
}
