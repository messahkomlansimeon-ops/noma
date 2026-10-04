"use client";

import { TopBar } from "@/components/top-bar";
import { Badge } from "@/components/ui";
import { Settings } from "lucide-react";

export default function AdminReglages() {
  return (
    <main>
      <TopBar back="/admin" title="Réglages" />

      <div className="px-4">
        <div className="mt-6 rounded-2xl border border-line bg-white p-6 text-center">
          <span className="mx-auto flex size-14 items-center justify-center rounded-full bg-sage text-forest">
            <Settings className="size-7" strokeWidth={1.6} />
          </span>
          <div className="mt-3 font-display text-[18px] font-extrabold text-ink">
            Réglages admin
          </div>
          <p className="mt-1 text-[13px] leading-relaxed text-ink-soft">
            Règles de modération, seuils de risque et santé des sources
            seront configurés ici.
          </p>
          <Badge tone="wash" className="mt-3">
            Écran à venir · non maquetté
          </Badge>
        </div>
      </div>
    </main>
  );
}
