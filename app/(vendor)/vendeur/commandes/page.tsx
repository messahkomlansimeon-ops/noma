"use client";

import { OrdersList } from "@/components/orders/orders-list";
import { SessionGate } from "@/components/session-gate";

export default function CommandesVendeur() {
  return (
    <SessionGate>
      <OrdersList space="vendor" />
    </SessionGate>
  );
}
