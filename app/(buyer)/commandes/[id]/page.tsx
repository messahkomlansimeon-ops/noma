"use client";

import { useParams } from "next/navigation";
import { OrderDetail } from "@/components/orders/order-detail";
import { SessionGate } from "@/components/session-gate";
import { ArtAlert } from "@/components/illustrations";
import { TopBar } from "@/components/top-bar";
import { EmptyState } from "@/components/ui";
import { isUuid } from "@/lib/client/api";

export default function CommandeDetail() {
  const params = useParams<{ id: string }>();
  const id = typeof params.id === "string" ? params.id : "";
  return (
    <SessionGate>
      {isUuid(id) ? (
        <OrderDetail orderId={id} space="buyer" />
      ) : (
        <main>
          <TopBar back="/commandes" title="Commande" />
          <div role="alert">
            <EmptyState art={<ArtAlert className="size-32" />} title="Commande introuvable." />
          </div>
        </main>
      )}
    </SessionGate>
  );
}
