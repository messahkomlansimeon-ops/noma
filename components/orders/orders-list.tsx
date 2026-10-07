"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ChevronRight, Package } from "lucide-react";
import { useUnauthorizedRedirect } from "@/components/session-gate";
import { TopBar } from "@/components/top-bar";
import { Badge } from "@/components/ui";
import {
  ORDERS_EMPTY_BUYER,
  ORDERS_EMPTY_BUYER_HINT,
  ORDERS_EMPTY_SELLER,
  ORDERS_EMPTY_SELLER_HINT,
  ORDERS_LOADING,
  ORDERS_TITLE_BUYER,
  ORDERS_TITLE_SELLER,
  orderRow,
} from "@/lib/client/orders-view";
import { describeSocialError, social, type OrderView } from "@/lib/client/social-api";

/** Liste des commandes (lot D2) : acheteur (`/commandes`) ou vendeur (`/vendeur/commandes`) ; l'autre partie n'a jamais de nom ni de numéro. */
export function OrdersList({ space }: { space: "buyer" | "vendor" }) {
  const redirectIfUnauthorized = useUnauthorizedRedirect();
  const [orders, setOrders] = useState<OrderView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const buyer = space === "buyer";

  useEffect(() => {
    const controller = new AbortController();
    social.orders.list(buyer ? "buyer" : "seller", { signal: controller.signal }).then(
      (list) => {
        setOrders(list);
        setError(null);
      },
      (failure) => {
        if (controller.signal.aborted || redirectIfUnauthorized(failure)) return;
        setError(describeSocialError(failure, "order"));
      },
    );
    return () => controller.abort();
  }, [buyer, reloadKey, redirectIfUnauthorized]);

  const title = buyer ? ORDERS_TITLE_BUYER : ORDERS_TITLE_SELLER;
  return (
    <main>
      <TopBar back={buyer ? "/compte" : "/vendeur"} title={title} />
      <div className="px-4 pb-6">
        <h1 className="font-display text-[22px] font-extrabold text-ink">{title}</h1>
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
        ) : orders === null ? (
          <p className="mt-6 text-center text-[14px] text-ink-soft" aria-busy="true">
            {ORDERS_LOADING}
          </p>
        ) : orders.length === 0 ? (
          <div role="status" data-testid="orders-empty" className="mt-6 rounded-2xl bg-wash p-5 text-center">
            <Package className="mx-auto size-7 text-ink-soft" aria-hidden />
            <p className="mt-2 text-[14px] font-bold text-ink">{buyer ? ORDERS_EMPTY_BUYER : ORDERS_EMPTY_SELLER}</p>
            <p className="mt-1 text-[13px] text-ink-soft">{buyer ? ORDERS_EMPTY_BUYER_HINT : ORDERS_EMPTY_SELLER_HINT}</p>
          </div>
        ) : (
          <ul aria-label="Vos commandes" className="mt-3 space-y-2.5" data-testid="orders-list">
            {orders.map((order) => {
              const row = orderRow(order);
              return (
                <li key={row.id} data-testid="order-row" data-status={order.status} data-needs-action={row.needsAction ? "true" : "false"}>
                  <Link href={row.href} className="flex items-start gap-3 rounded-2xl border border-line bg-white p-3.5">
                    <span className="min-w-0 flex-1">
                      <span className="block text-[15px] font-bold text-ink">{row.title}</span>
                      <span className="block font-display text-[18px] font-extrabold text-ink">{row.priceText}</span>
                      <span className="mt-1 flex flex-wrap items-center gap-1.5">
                        <Badge tone={row.tone}>{row.statusText}</Badge>
                        {!buyer ? <span className="text-[12px] text-ink-soft">{row.counterpart}</span> : null}
                      </span>
                      <span className="mt-0.5 block text-[11px] text-ink-soft">{row.dateText}</span>
                    </span>
                    <ChevronRight className="mt-1 size-4 shrink-0 text-ink-soft" aria-hidden />
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </main>
  );
}
