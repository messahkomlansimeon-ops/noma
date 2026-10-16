"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ChevronRight, Package, RotateCw } from "lucide-react";
import { useUnauthorizedRedirect } from "@/components/session-gate";
import { ArtAlert, ArtBag } from "@/components/illustrations";
import { TopBar } from "@/components/top-bar";
import { Badge, Btn, EmptyState, IconTile, Skeleton } from "@/components/ui";
import {
  ORDERS_EMPTY_BUYER,
  ORDERS_EMPTY_SELLER,
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
      {/* Lot FIN1 : titre dit une fois (le h1). */}
      <TopBar back={buyer ? "/compte" : "/vendeur"} />
      <div className="px-4 pb-6">
        <h1 className="flex items-center gap-2.5 text-[24px] font-extrabold tracking-tight text-ink">
          <Package className="size-6 text-brand" aria-hidden />
          {title}
        </h1>
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
        ) : orders === null ? (
          <div className="mt-4 flex flex-col gap-3 md:grid md:grid-cols-2" aria-busy="true">
            <span className="sr-only">{ORDERS_LOADING}</span>
            <Skeleton className="h-24 w-full rounded-3xl" />
            <Skeleton className="h-24 w-full rounded-3xl" />
            <Skeleton className="h-24 w-full rounded-3xl" />
          </div>
        ) : orders.length === 0 ? (
          <div role="status" data-testid="orders-empty">
            <EmptyState art={<ArtBag className="size-36" />} title={buyer ? ORDERS_EMPTY_BUYER : ORDERS_EMPTY_SELLER} />
          </div>
        ) : (
          <ul aria-label="Vos commandes" className="stagger mt-4 flex flex-col gap-3 md:grid md:grid-cols-2" data-testid="orders-list">
            {orders.map((order) => {
              const row = orderRow(order);
              return (
                <li key={row.id} data-testid="order-row" data-status={order.status} data-needs-action={row.needsAction ? "true" : "false"}>
                  <Link href={row.href} className="press flex h-full items-center gap-3 rounded-3xl border border-line bg-white p-3.5 hover:border-brand">
                    <IconTile icon={Package} tone={row.needsAction ? "accent" : "brand"} className="size-12" />
                    <span className="min-w-0 flex-1">
                      <span className="block text-[16px] font-bold leading-snug text-ink">{row.title}</span>
                      <span className="block text-[18px] font-extrabold text-ink">{row.priceText}</span>
                      <span className="mt-1 flex flex-wrap items-center gap-1.5">
                        <Badge tone={row.tone}>{row.statusText}</Badge>
                        {!buyer ? <span className="text-[13px] text-ink-soft">{row.counterpart}</span> : null}
                      </span>
                      <span className="mt-1 block text-[12px] text-ink-soft">{row.dateText}</span>
                    </span>
                    <ChevronRight className="size-5 shrink-0 text-ink-soft" aria-hidden />
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
