"use client";

import { ChevronRight, Store } from "lucide-react";
import { TopBar } from "@/components/top-bar";
import { Badge } from "@/components/ui";

const vendeurs = [
  { name: "Marcory Mobile", zone: "Marcory, Abidjan", verif: "Téléphone confirmé", tone: "sage" as const },
  { name: "Maison Cocody", zone: "Cocody, Abidjan", verif: "Téléphone confirmé", tone: "sage" as const },
  { name: "Atelier Koffi", zone: "Cocody, Abidjan", verif: "Contrôles à compléter", tone: "carrot" as const },
];

export default function AdminVendeurs() {
  return (
    <main>
      <TopBar back="/admin" title="Vendeurs" />

      <div className="px-4">
        <div className="mt-1 flex items-center gap-2.5">
          <h1 className="font-display text-[26px] font-extrabold text-ink">
            Profils vendeurs
          </h1>
          <Badge tone="carrot">2 à contrôler</Badge>
        </div>

        <div className="mt-4 divide-y divide-line overflow-hidden rounded-2xl border border-line bg-white">
          {vendeurs.map((v) => (
            <button
              key={v.name}
              className="flex w-full items-center gap-3 px-4 py-3.5 text-left transition hover:bg-wash/60"
            >
              <span className="flex size-11 shrink-0 items-center justify-center rounded-full bg-sage text-forest">
                <Store className="size-5" strokeWidth={1.8} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[15px] font-bold text-ink">
                  {v.name}
                </span>
                <span className="block text-[12px] text-ink-soft">{v.zone}</span>
                <Badge tone={v.tone} className="mt-1">
                  {v.verif}
                </Badge>
              </span>
              <ChevronRight className="size-4 text-ink-soft" />
            </button>
          ))}
        </div>
      </div>
    </main>
  );
}
