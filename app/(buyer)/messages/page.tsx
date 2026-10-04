"use client";

import Link from "next/link";
import { ChevronRight, Package, Search } from "lucide-react";
import { TopBar } from "@/components/top-bar";
import { Thumb } from "@/components/thumb";
import { Chip } from "@/components/ui";
import { useNoma } from "@/lib/store";

const tones = {
  sage: "bg-sage text-forest",
  carrot: "bg-carrot-soft text-carrot-ink",
  sky: "bg-sky text-sky-ink",
} as const;

export default function Messages() {
  const threads = useNoma((s) => s.threads);

  return (
    <main>
      <TopBar back="/compte" center={<span />} avatar="AO" />

      <div className="px-4">
        <h1 className="flex items-center gap-2.5 font-display text-[26px] font-extrabold text-ink">
          Messages
          <span className="flex size-6 items-center justify-center rounded-full bg-carrot text-[12px] font-extrabold text-white">
            2
          </span>
        </h1>

        <div className="mt-3 flex items-center gap-2.5 rounded-xl border border-line bg-white px-3.5 py-3">
          <Search className="size-4 text-ink-soft" />
          <input
            placeholder="Rechercher un échange"
            className="w-full bg-transparent text-[14px] text-ink placeholder:text-ink-soft/60"
          />
        </div>

        <div className="mt-3 flex gap-2">
          <Chip active>Tous</Chip>
          <Chip>Non lus</Chip>
        </div>

        <div className="mt-3 divide-y divide-line overflow-hidden rounded-2xl border border-line bg-white">
          {threads.map((t) => (
            <Link
              key={t.id}
              href={`/messages/${t.id}`}
              className="flex items-center gap-3 px-4 py-3 transition hover:bg-wash/60"
            >
              <span
                className={`flex size-11 shrink-0 items-center justify-center rounded-full text-[13px] font-extrabold ${tones[t.tone]}`}
              >
                {t.initials}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-[15px] font-bold text-ink">
                    {t.vendor}
                  </span>
                  <span className="ml-auto shrink-0 text-[12px] text-ink-soft">
                    {t.time}
                  </span>
                </div>
                <div className="truncate text-[13px] text-ink-soft">
                  {t.snippet}
                </div>
                <div className="truncate text-[12px] font-semibold text-ink-soft/80">
                  {t.product}
                </div>
              </div>
              <Thumb art={t.art} className="size-11" iconClassName="size-5" />
              {t.unread > 0 && (
                <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-carrot text-[11px] font-extrabold text-white">
                  {t.unread}
                </span>
              )}
            </Link>
          ))}
        </div>

        <Link
          href="/commandes"
          className="mt-3 flex items-center gap-3 rounded-2xl border border-line bg-white px-4 py-3.5"
        >
          <span className="flex size-9 items-center justify-center rounded-full bg-sage text-forest">
            <Package className="size-[18px]" strokeWidth={1.9} />
          </span>
          <span className="text-[14px] font-bold text-ink">Mes commandes</span>
          <ChevronRight className="ml-auto size-4 text-ink-soft" />
        </Link>
      </div>
    </main>
  );
}
