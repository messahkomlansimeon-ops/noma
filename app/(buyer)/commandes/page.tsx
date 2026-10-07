"use client";

import { OrdersList } from "@/components/orders/orders-list";
import { SessionGate } from "@/components/session-gate";

export default function Commandes() {
  return (
    <SessionGate>
      <OrdersList space="buyer" />
    </SessionGate>
  );
}
