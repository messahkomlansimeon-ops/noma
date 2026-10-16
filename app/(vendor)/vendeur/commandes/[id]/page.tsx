"use client";

import { useParams } from "next/navigation";
import { OrderDetail } from "@/components/orders/order-detail";
import { SessionGate } from "@/components/session-gate";
import { TopBar } from "@/components/top-bar";
import { ErrorState } from "@/components/vendor/vendor-parts";
import { isUuid } from "@/lib/client/api";

export default function CommandeVendeurDetail() {
  const params = useParams<{ id: string }>();
  const id = typeof params.id === "string" ? params.id : "";
  return (
    <SessionGate>
      {isUuid(id) ? (
        <OrderDetail orderId={id} space="vendor" />
      ) : (
        <main>
          <TopBar back="/vendeur/commandes" title="Commande" />
          <ErrorState message="Commande introuvable." />
        </main>
      )}
    </SessionGate>
  );
}
