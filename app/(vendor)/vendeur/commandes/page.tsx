"use client";

import Link from "next/link";
import { useState } from "react";
import { ChevronRight, Clock, MapPin, MessageCircle, Wallet } from "lucide-react";
import { LogoMark } from "@/components/logo";
import { Thumb } from "@/components/thumb";
import { Badge } from "@/components/ui";
import { formatShort } from "@/lib/data";
import { useNoma } from "@/lib/store";

export default function CommandesVendeur() {
  const showToast = useNoma((s) => s.showToast);
  const orders = useNoma((s) => s.vendorOrders);
  const [tab, setTab] = useState<"en-cours" | "terminees">("en-cours");
  const active = orders.filter((o) => o.status !== "done");

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
          Mes commandes
        </h1>
        <div className="text-[13px] text-ink-soft">Marcory Mobile</div>

        <div className="mt-3 flex gap-2">
          <button
            onClick={() => setTab("en-cours")}
            className={`rounded-full px-4 py-2 text-[13px] font-bold transition ${
              tab === "en-cours"
                ? "bg-forest text-white"
                : "border border-line bg-white text-ink-soft"
            }`}
          >
            En cours · {active.length}
          </button>
          <button
            onClick={() => setTab("terminees")}
            className={`rounded-full px-4 py-2 text-[13px] font-semibold transition ${
              tab === "terminees"
                ? "bg-forest text-white"
                : "border border-line bg-white text-ink-soft"
            }`}
          >
            Terminées
          </button>
        </div>

        <div className="mt-4 space-y-3">
          {tab === "en-cours" ? (
            active.map((o) => (
              <div key={o.id} className="rounded-2xl border border-line bg-white p-3.5">
                <div className="flex items-center gap-2">
                  <span className="text-[12px] font-extrabold text-ink-soft">
                    {o.id}
                  </span>
                  <Badge tone={o.status === "preparing" ? "sage" : "carrot"} className="ml-auto">
                    {o.status === "preparing" ? "En préparation" : "À confirmer"}
                  </Badge>
                </div>
                <div className="mt-2 flex gap-3">
                  <Thumb art={o.art} className="size-14" iconClassName="size-7" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[15px] font-bold text-ink">
                      {o.title}
                    </div>
                    <div className="font-display text-[18px] font-extrabold text-ink">
                      {formatShort(o.price)} FCFA
                    </div>
                    <div className="mt-0.5 flex items-center gap-3 text-[12px] text-ink-soft">
                      <span className="flex items-center gap-1">
                        <MapPin className="size-3.5" />
                        {o.zone}
                      </span>
                      <span className="flex items-center gap-1">
                        <Clock className="size-3.5" />
                        {o.slot}
                      </span>
                    </div>
                  </div>
                </div>
                <Link
                  href={`/vendeur/commandes/${o.id}`}
                  className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl bg-forest py-3 text-[14px] font-bold text-white transition active:scale-[0.99]"
                >
                  {o.status === "preparing" ? "Gérer la commande" : "Confirmer prix et délai"}
                  <ChevronRight className="size-4" />
                </Link>
              </div>
            ))
          ) : (
            <div className="rounded-2xl border border-line bg-white p-5 text-center text-[14px] text-ink-soft">
              Aucune commande terminée pour l'instant.
            </div>
          )}
        </div>

        <div className="mt-4 divide-y divide-line overflow-hidden rounded-2xl border border-line bg-white">
          <button
            onClick={() => showToast("Prototype : messages vendeur simulés")}
            className="flex w-full items-center gap-3 px-4 py-3.5 text-left"
          >
            <span className="flex size-9 items-center justify-center rounded-full bg-sage text-forest">
              <MessageCircle className="size-[18px]" strokeWidth={1.9} />
            </span>
            <span className="text-[14px] font-bold text-ink">Messages clients</span>
            <span className="flex size-5 items-center justify-center rounded-full bg-carrot text-[11px] font-extrabold text-white">
              2
            </span>
            <ChevronRight className="ml-auto size-4 text-ink-soft" />
          </button>
          <button
            onClick={() => showToast("Prototype : paiements déclarés simulés")}
            className="flex w-full items-center gap-3 px-4 py-3.5 text-left"
          >
            <span className="flex size-9 items-center justify-center rounded-full bg-sage text-forest">
              <Wallet className="size-[18px]" strokeWidth={1.9} />
            </span>
            <span className="text-[14px] font-bold text-ink">
              Paiements directs des clients
            </span>
            <ChevronRight className="ml-auto size-4 text-ink-soft" />
          </button>
        </div>
      </div>
    </main>
  );
}
