"use client";

import { SessionGate } from "@/components/session-gate";
import { ProOfferScreen } from "@/components/vendor/pro-offer-screen";

export default function OffreProPage() {
  return (
    <SessionGate>
      <ProOfferScreen />
    </SessionGate>
  );
}
