"use client";

import { useState } from "react";
import { CircleCheck, Ellipsis, Pencil, Plus, Search, Tag } from "lucide-react";
import { TopBar } from "@/components/top-bar";
import { Sheet } from "@/components/modal";
import { NouvelleAnnonceForm } from "@/components/vendor/nouvelle-annonce-form";
import { Thumb } from "@/components/thumb";
import { Badge } from "@/components/ui";
import { formatShort } from "@/lib/data";
import { useNoma } from "@/lib/store";

const filters = ["Toutes", "En ligne", "Brouillon"] as const;

export default function MesAnnonces() {
  const showToast = useNoma((s) => s.showToast);
  const [filter, setFilter] = useState<(typeof filters)[number]>("Toutes");
  const [sheet, setSheet] = useState(false);
  const listings = [
    {
      id: "l-1",
      title: "iPhone 12 · 128 Go",
      price: 150000,
      art: "phone" as const,
      badge: { tone: "sage" as const, label: "En ligne" },
      note: "Disponibilité confirmée il y a 1 h",
      actions: [
        { icon: Pencil, label: "Modifier" },
        { icon: Tag, label: "Marquer vendu" },
      ],
    },
    {
      id: "l-2",
      title: "Galaxy A54 · 128 Go",
      price: 125000,
      art: "phone" as const,
      badge: { tone: "sage" as const, label: "En ligne" },
      badge2: { tone: "carrot" as const, label: "À reconfirmer" },
      note: "",
      actions: [
        { icon: CircleCheck, label: "Confirmer la disponibilité" },
        { icon: Pencil, label: "Modifier" },
      ],
    },
    {
      id: "l-3",
      title: "iPhone 13 · 128 Go",
      price: 0,
      art: "phone" as const,
      badge: { tone: "wash" as const, label: "Brouillon" },
      note: "Prix à compléter",
      actions: [{ icon: undefined, label: "Compléter l'annonce" }],
    },
  ];

  const visible = listings.filter((l) =>
    filter === "Toutes"
      ? true
      : filter === "En ligne"
        ? l.badge.label === "En ligne"
        : l.badge.label === "Brouillon",
  );

  return (
    <main>
      <TopBar
        back="/vendeur"
        title="Mes annonces"
        right={
          <button
            onClick={() => setSheet(true)}
            className="flex size-9 items-center justify-center rounded-full bg-forest text-white"
            aria-label="Nouvelle annonce"
          >
            <Plus className="size-5" />
          </button>
        }
      />

      <div className="px-4">
        <div className="flex items-center gap-2.5 rounded-xl border border-line bg-white px-3.5 py-3">
          <Search className="size-4 text-ink-soft" />
          <input
            placeholder="Rechercher une annonce"
            className="w-full bg-transparent text-[14px] text-ink placeholder:text-ink-soft/60"
          />
        </div>

        <div className="mt-3 flex gap-2">
          {filters.map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`rounded-full px-3.5 py-1.5 text-[13px] font-semibold transition ${
                filter === f
                  ? "bg-forest text-white"
                  : "border border-line bg-white text-ink"
              }`}
            >
              {f}
              {f === "Toutes" ? " · 3" : f === "En ligne" ? " · 2" : " · 1"}
            </button>
          ))}
        </div>

        <div className="mt-4 space-y-3">
          {visible.map((l) => (
            <div key={l.id} className="rounded-2xl border border-line bg-white p-3.5">
              <div className="flex items-center gap-3">
                <Thumb art={l.art} className="size-14" iconClassName="size-7" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-start justify-between gap-2">
                    <span className="truncate text-[15px] font-bold text-ink">
                      {l.title}
                    </span>
                    <button
                      onClick={() => showToast("Prototype : options de l'annonce")}
                      className="text-ink-soft"
                      aria-label="Options"
                    >
                      <Ellipsis />
                    </button>
                  </div>
                  {l.price > 0 ? (
                    <div className="font-display text-[18px] font-extrabold text-ink">
                      {formatShort(l.price)} FCFA
                    </div>
                  ) : (
                    <div className="text-[13px] text-ink-soft">
                      Prix à compléter
                    </div>
                  )}
                  <div className="mt-1 flex flex-wrap items-center gap-1.5">
                    <Badge tone={l.badge.tone}>{l.badge.label}</Badge>
                    {l.badge2 && <Badge tone={l.badge2.tone}>{l.badge2.label}</Badge>}
                  </div>
                </div>
              </div>
              {l.note && (
                <div className="mt-1.5 text-[12px] text-ink-soft">{l.note}</div>
              )}
              <div className="mt-2.5 flex border-t border-line pt-2.5">
                {l.actions.map((a, i) => (
                  <button
                    key={a.label}
                    onClick={() => showToast("Prototype : action simulée")}
                    className={`flex flex-1 items-center justify-center gap-1.5 text-[13px] font-bold text-ink ${
                      i > 0 ? "border-l border-line" : ""
                    }`}
                  >
                    {a.icon && <a.icon className="size-4" strokeWidth={1.8} />}
                    {a.label}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>

        <button
          onClick={() => setSheet(true)}
          className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-forest py-3.5 text-[15px] font-bold text-white transition active:scale-[0.99]"
        >
          <Plus className="size-4" />
          Nouvelle annonce
        </button>
      </div>

      <Sheet
        open={sheet}
        onClose={() => setSheet(false)}
        title="Nouvelle annonce"
      >
        <NouvelleAnnonceForm embedded onDone={() => setSheet(false)} />
      </Sheet>
    </main>
  );
}
