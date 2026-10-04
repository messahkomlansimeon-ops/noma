"use client";

import Link from "next/link";
import { ChevronRight, Clock, CreditCard, FileText, Truck } from "lucide-react";
import { TopBar } from "@/components/top-bar";
import { Thumb } from "@/components/thumb";
import { Badge } from "@/components/ui";
import { formatShort } from "@/lib/data";
import { useNoma } from "@/lib/store";

const statusMap = {
  preparing: { tone: "sage" as const, label: "En préparation" },
  quote: { tone: "carrot" as const, label: "Devis à valider" },
  sent: { tone: "carrot" as const, label: "Demande envoyée" },
  done: { tone: "sage" as const, label: "Terminée" },
};

export default function MesCommandes() {
  const orders = useNoma((s) => s.orders);
  const active = orders.filter((o) => o.status !== "done");

  return (
    <main>
      <TopBar
        back="/compte"
        center={
          <span className="font-display text-[20px] font-extrabold text-forest">
            noma
          </span>
        }
        avatar="AO"
      />

      <div className="px-4">
        <h1 className="font-display text-[26px] font-extrabold text-ink">
          Mes commandes
        </h1>

        <div className="mt-3 flex gap-2">
          <span className="rounded-full bg-forest px-4 py-2 text-[13px] font-bold text-white">
            En cours · {active.length}
          </span>
          <span className="rounded-full border border-line bg-white px-4 py-2 text-[13px] font-semibold text-ink-soft">
            Terminées
          </span>
        </div>

        <div className="mt-4 space-y-3">
          {orders.map((o) => {
            const st = statusMap[o.status];
            return (
              <Link
                key={o.id}
                href={`/commandes/${o.id}`}
                className="block rounded-2xl border border-line bg-white p-3.5 transition hover:bg-wash/40"
              >
                <div className="flex items-center gap-3">
                  <Thumb art={o.art} className="size-14" iconClassName="size-7" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-[12px] font-extrabold text-ink-soft">
                        {o.id}
                      </span>
                      <Badge tone={st.tone} className="ml-auto">
                        {st.label}
                      </Badge>
                    </div>
                    <div className="truncate text-[15px] font-bold text-ink">
                      {o.title}
                    </div>
                    <div className="truncate text-[13px] text-ink-soft">
                      {o.vendor}
                    </div>
                    <div className="font-display text-[18px] font-extrabold text-ink">
                      {formatShort(o.price)} FCFA
                    </div>
                  </div>
                </div>
                <div className="mt-2 flex items-center gap-1.5 border-t border-line pt-2 text-[12px] text-ink-soft">
                  {o.status === "preparing" && (
                    <>
                      <Truck className="size-3.5" />
                      {o.delivery}
                    </>
                  )}
                  {o.status === "quote" && (
                    <>
                      <FileText className="size-3.5" />
                      <span className="font-bold text-forest">Voir le devis</span>
                    </>
                  )}
                  {o.status === "sent" && (
                    <>
                      <Clock className="size-3.5" />
                      Confirmation attendue
                    </>
                  )}
                  <ChevronRight className="ml-auto size-4" />
                </div>
              </Link>
            );
          })}
        </div>

        <div className="mt-4 flex items-center gap-3 rounded-2xl border border-line bg-white px-4 py-3.5">
          <CreditCard className="size-5 text-ink-soft" strokeWidth={1.8} />
          <span className="text-[14px] font-semibold text-ink">
            Paiement direct au vendeur
          </span>
          <ChevronRight className="ml-auto size-4 text-ink-soft" />
        </div>
      </div>
    </main>
  );
}
