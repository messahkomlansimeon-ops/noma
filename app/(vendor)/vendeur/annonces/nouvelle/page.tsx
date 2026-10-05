"use client";

import { SessionGate } from "@/components/session-gate";
import { NouvelleAnnonceForm } from "@/components/vendor/nouvelle-annonce-form";

export default function NouvelleAnnoncePage() {
  return (
    <SessionGate>
      <main>
        <NouvelleAnnonceForm />
      </main>
    </SessionGate>
  );
}
