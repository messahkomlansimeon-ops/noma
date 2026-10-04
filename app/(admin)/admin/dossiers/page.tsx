"use client";

import Link from "next/link";
import { useState } from "react";
import { ChevronRight, Clock, Funnel, Search, SlidersHorizontal } from "lucide-react";
import { TopBar } from "@/components/top-bar";
import { Thumb } from "@/components/thumb";
import { Badge } from "@/components/ui";
import { useNoma } from "@/lib/store";

export default function Dossiers() {
  const cases = useNoma((s) => s.cases);
  const showToast = useNoma((s) => s.showToast);
  const [tab, setTab] = useState<"ouverts" | "clotures">("ouverts");
  const open = cases.filter((c) => c.status === "open");
  const closed = cases.filter((c) => c.status === "closed");

  return (
    <main>
      <TopBar
        back="/admin"
        title="Signalements"
        right={
          <button
            onClick={() => showToast("Prototype : filtres simulés")}
            className="flex size-9 items-center justify-center rounded-full text-ink transition hover:bg-wash"
            aria-label="Filtres"
          >
            <Funnel className="size-5" strokeWidth={1.8} />
          </button>
        }
      />

      <div className="px-4">
        <div className="flex items-center gap-2.5 rounded-xl border border-line bg-white px-3.5 py-3">
          <Search className="size-4 text-ink-soft" />
          <input
            placeholder="Annonce, vendeur ou dossier"
            className="w-full bg-transparent text-[14px] text-ink placeholder:text-ink-soft/60"
          />
        </div>

        <div className="mt-3 flex gap-2">
          <button
            onClick={() => setTab("ouverts")}
            className={`rounded-full px-4 py-2 text-[13px] font-bold transition ${
              tab === "ouverts"
                ? "bg-forest text-white"
                : "border border-line bg-white text-ink-soft"
            }`}
          >
            Ouverts · {open.length}
          </button>
          <button
            onClick={() => setTab("clotures")}
            className={`rounded-full px-4 py-2 text-[13px] font-semibold transition ${
              tab === "clotures"
                ? "bg-forest text-white"
                : "border border-line bg-white text-ink-soft"
            }`}
          >
            Clôturés
          </button>
        </div>

        <div className="mt-4 space-y-3">
          {tab === "ouverts" ? (
            open.map((c) => (
              <Link
                key={c.id}
                href={`/admin/dossiers/${c.id}`}
                className="block rounded-2xl border border-line bg-white p-3.5 transition hover:bg-wash/40"
              >
                <div className="flex items-center gap-3">
                  <Thumb art={c.art} className="size-14" iconClassName="size-7" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-[12px] font-extrabold text-ink-soft">
                        {c.id}
                      </span>
                      <Badge tone="carrot" className="ml-auto">
                        À examiner
                      </Badge>
                      <ChevronRight className="size-4 text-ink-soft" />
                    </div>
                    <div className="mt-0.5 text-[16px] font-extrabold text-ink">
                      {c.motif}
                    </div>
                    <div className="truncate text-[13px] text-ink-soft">
                      {c.offer}
                    </div>
                    <div className="mt-0.5 flex items-center gap-2 text-[12px] text-ink-soft">
                      <span>{c.meta}</span>
                      <span className="ml-auto flex items-center gap-1">
                        <Clock className="size-3.5" />
                        {c.time}
                      </span>
                    </div>
                  </div>
                </div>
              </Link>
            ))
          ) : closed.length === 0 ? (
            <div className="rounded-2xl border border-line bg-white p-5 text-center text-[14px] text-ink-soft">
              Aucun dossier clôturé pour l'instant.
            </div>
          ) : (
            closed.map((c) => (
              <Link
                key={c.id}
                href={`/admin/dossiers/${c.id}`}
                className="block rounded-2xl border border-line bg-white p-3.5 opacity-70"
              >
                <div className="flex items-center gap-3">
                  <Thumb art={c.art} className="size-14" iconClassName="size-7" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-[12px] font-extrabold text-ink-soft">
                        {c.id}
                      </span>
                      <Badge tone="sage" className="ml-auto">
                        Clôturé
                      </Badge>
                    </div>
                    <div className="mt-0.5 text-[16px] font-extrabold text-ink">
                      {c.motif}
                    </div>
                    <div className="truncate text-[13px] text-ink-soft">
                      {c.offer} · {c.decision}
                    </div>
                  </div>
                </div>
              </Link>
            ))
          )}
        </div>

        <button
          onClick={() => showToast("Prototype : tri assisté simulé")}
          className="mt-4 flex w-full items-center gap-3 rounded-2xl bg-sage p-3.5 text-left"
        >
          <SlidersHorizontal className="size-5 text-forest" strokeWidth={1.9} />
          <span className="text-[14px] font-bold text-forest">
            Tri assisté par IA
          </span>
          <ChevronRight className="ml-auto size-4 text-sage-ink" />
        </button>
      </div>
    </main>
  );
}
