"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, Calendar, ChevronRight, Info, Store } from "lucide-react";
import { TopBar } from "@/components/top-bar";
import { Thumb } from "@/components/thumb";
import { Badge } from "@/components/ui";
import { formatShort } from "@/lib/data";
import { useNoma } from "@/lib/store";

export default function Propositions() {
  const router = useRouter();
  const proposals = useNoma((s) => s.proposals);

  return (
    <main>
      <TopBar back="/partager" title="Propositions" avatar="AO" />

      <div className="px-4">
        <div className="rounded-2xl border border-line bg-white p-3.5">
          <div className="flex items-center gap-3">
            <Thumb art="phone" className="size-12" iconClassName="size-6" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[15px] font-bold text-ink">
                iPhone 12 · 128 Go
              </div>
              <div className="mt-1 flex flex-wrap gap-1.5 text-[11px] font-bold">
                <Badge tone="carrot">Cocody</Badge>
                <Badge tone="carrot">150 000 F max</Badge>
              </div>
            </div>
            <ChevronRight className="size-4 text-ink-soft" />
          </div>
        </div>

        <div className="mt-4 flex items-center gap-2">
          <span className="flex size-6 items-center justify-center rounded-full bg-carrot text-[12px] font-extrabold text-white">
            {proposals.length}
          </span>
          <span className="text-[15px] font-extrabold text-ink">
            vendeurs ont répondu
          </span>
        </div>

        <div className="mt-3 space-y-3">
          {proposals.map((p) => (
            <div key={p.id} className="rounded-2xl border border-line bg-white p-3.5">
              <div className="flex gap-3">
                <Link href={`/offre/${p.offerId}`} className="shrink-0">
                  <Thumb art={p.art} className="size-[72px]" iconClassName="size-9" />
                </Link>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <Store className="size-4 shrink-0 text-ink-soft" />
                    <span className="truncate text-[14px] font-bold text-ink">
                      {p.vendor}
                    </span>
                    <ChevronRight className="ml-auto size-4 shrink-0 text-ink-soft" />
                  </div>
                  <div className="text-[12px] text-ink-soft">{p.condition}</div>
                  <div className="font-display text-[20px] font-extrabold text-ink">
                    {formatShort(p.price)} FCFA
                  </div>
                  {p.priceNote && (
                    <div className="text-[12px] text-ink-soft">{p.priceNote}</div>
                  )}
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    {p.badges.map((b) => (
                      <Badge key={b.label} tone={b.tone}>
                        {b.label}
                      </Badge>
                    ))}
                  </div>
                  <div className="mt-1.5 flex items-center gap-1.5 text-[12px] text-ink-soft">
                    <Calendar className="size-3.5" />
                    {p.slot}
                  </div>
                </div>
              </div>
              <div className="mt-2.5 flex items-center gap-1.5 border-t border-line pt-2 text-[12px] text-ink-soft">
                <Info className="size-3.5 shrink-0" />
                Disponibilité confirmée par le vendeur
              </div>
              <Link
                href={`/offre/${p.offerId}`}
                className="mt-1 flex items-center justify-between py-2 text-[13px] font-bold text-forest"
              >
                Voir la proposition
                <ChevronRight className="size-4" />
              </Link>
            </div>
          ))}
        </div>

        <button
          onClick={() => router.push("/comparer")}
          className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-forest py-3.5 text-[15px] font-bold text-white transition active:scale-[0.99]"
        >
          Comparer les {proposals.length} propositions
          <ArrowRight className="size-4" />
        </button>
      </div>
    </main>
  );
}
