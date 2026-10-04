"use client";

import { useState } from "react";
import { ChevronRight, Clock, MapPin, MessageCircle } from "lucide-react";
import { LogoMark } from "@/components/logo";
import { Thumb } from "@/components/thumb";
import { Badge } from "@/components/ui";
import { demandsSeed } from "@/lib/data";
import { useNoma } from "@/lib/store";

const filters = ["Toutes", "Nouvelle", "Répondues"] as const;

export default function DemandesRecues() {
  const showToast = useNoma((s) => s.showToast);
  const [filter, setFilter] = useState<(typeof filters)[number]>("Toutes");

  const counts = {
    Toutes: demandsSeed.length,
    Nouvelle: demandsSeed.filter((d) => d.state === "new").length,
    Répondues: demandsSeed.filter((d) => d.state === "answered").length,
  };

  const visible = demandsSeed.filter((d) =>
    filter === "Toutes" ? true : filter === "Nouvelle" ? d.state === "new" : d.state === "answered",
  );

  return (
    <main>
      <div className="flex items-center justify-between px-4 py-3">
        <LogoMark />
        <div className="flex items-center gap-2">
          <span className="rounded-full border border-line bg-white px-3 py-1.5 text-[13px] font-bold text-ink">
            Vendeur ▾
          </span>
          <button
            onClick={() => showToast("Prototype : messages vendeur simulés")}
            className="relative flex size-9 items-center justify-center rounded-full text-ink transition hover:bg-wash"
            aria-label="Messages"
          >
            <MessageCircle className="size-5" strokeWidth={1.8} />
            <span className="absolute right-1 top-1 size-2 rounded-full bg-carrot ring-2 ring-cream" />
          </button>
        </div>
      </div>

      <div className="px-4">
        <h1 className="font-display text-[26px] font-extrabold text-ink">
          Demandes reçues
        </h1>
        <div className="text-[13px] text-ink-soft">
          Selon vos catégories et vos zones
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
              {f} · {counts[f]}
            </button>
          ))}
        </div>

        <div className="mt-4 space-y-3">
          {visible.map((d) => (
            <div key={d.id} className="rounded-2xl border border-line bg-white p-3.5">
              <div className="flex items-center gap-2">
                <span className="text-[12px] font-extrabold text-ink-soft">
                  {d.id}
                </span>
                {d.state === "new" ? (
                  <Badge tone="carrot" className="ml-auto">
                    Nouvelle
                  </Badge>
                ) : (
                  <Badge tone="sage" className="ml-auto">
                    Proposition envoyée
                  </Badge>
                )}
              </div>
              <div className="mt-2 flex gap-3">
                <Thumb art={d.art} className="size-14" iconClassName="size-7" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[16px] font-bold text-ink">
                    {d.title}
                  </div>
                  <div className="font-display text-[18px] font-extrabold text-ink">
                    {d.budget}
                  </div>
                  <div className="mt-0.5 flex items-center gap-3 text-[12px] text-ink-soft">
                    <span className="flex items-center gap-1">
                      <MapPin className="size-3.5" />
                      {d.zone}
                    </span>
                    {d.delay && (
                      <span className="flex items-center gap-1">
                        <Clock className="size-3.5" />
                        {d.delay}
                      </span>
                    )}
                  </div>
                </div>
              </div>
              <div className="mt-1.5 text-[13px] text-ink-soft">{d.traits}</div>
              {d.state === "new" ? (
                <button
                  onClick={() => showToast("Proposition (prototype)")}
                  className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl bg-forest py-3 text-[14px] font-bold text-white transition active:scale-[0.99]"
                >
                  Faire une proposition
                  <ChevronRight className="size-4" />
                </button>
              ) : (
                <button
                  onClick={() => showToast("Proposition déjà envoyée (prototype)")}
                  className="mt-3 flex w-full items-center justify-center rounded-xl border border-forest/30 bg-white py-3 text-[14px] font-bold text-forest"
                >
                  Voir ma réponse
                </button>
              )}
            </div>
          ))}
        </div>
      </div>
    </main>
  );
}
