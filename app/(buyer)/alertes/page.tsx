"use client";

import Link from "next/link";
import { Bell, Pause, Plus } from "lucide-react";
import { Thumb } from "@/components/thumb";
import { Avatar, Badge, BtnOutline, WhatsAppIcon } from "@/components/ui";
import { useNoma } from "@/lib/store";

export default function RecherchesSuivies() {
  const alerts = useNoma((s) => s.alerts);

  return (
    <main>
      <div className="flex items-center justify-between px-4 py-3">
        <Link href="/" className="flex size-9 items-center">
          <span className="font-display text-[20px] font-extrabold text-forest">
            noma
          </span>
        </Link>
        <Avatar initials="AO" />
      </div>

      <div className="px-4">
        <h1 className="font-display text-[26px] font-extrabold text-ink">
          Mes recherches
        </h1>

        <div className="mt-3 flex gap-2">
          <span className="rounded-full bg-forest px-4 py-2 text-[13px] font-bold text-white">
            Actives · {alerts.filter((a) => a.news >= 0).length}
          </span>
          <span className="rounded-full border border-line bg-white px-4 py-2 text-[13px] font-semibold text-ink-soft">
            Terminées
          </span>
        </div>

        <div className="mt-4 space-y-3">
          {alerts.map((a) => (
            <div key={a.id} className="rounded-2xl border border-line bg-white p-3.5">
              <div className="flex items-center gap-3">
                <Thumb art="phone" className="size-12" iconClassName="size-6" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[15px] font-bold text-ink">
                    {a.title}
                  </div>
                  <div className="text-[12px] text-ink-soft">
                    {a.zone} · {a.budget}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button className="flex size-8 items-center justify-center rounded-full border border-line text-ink-soft" aria-label="Pause">
                    <Pause className="size-4" />
                  </button>
                </div>
              </div>
              <div className="mt-2">
                {a.news > 0 ? (
                  <Badge tone="carrot">
                    <Bell className="size-3" />
                    {a.news} nouvelles offres
                  </Badge>
                ) : (
                  <Badge tone="wash">Aucune nouveauté</Badge>
                )}
              </div>
              <div className="mt-2.5 flex items-center gap-2 border-t border-line pt-2.5 text-[12px] text-ink-soft">
                <span className="flex items-center gap-1.5 font-semibold">
                  <WhatsAppIcon className="size-4 text-forest" />
                  {a.freq === "daily" ? "Quotidien" : "Immédiat"} · Jusqu'au {a.until}
                </span>
                <Link
                  href="/recherche"
                  className="ml-auto font-bold text-forest hover:underline"
                >
                  Voir les offres →
                </Link>
              </div>
            </div>
          ))}
        </div>

        <BtnOutline href="/alerte/nouvelle" className="mt-4">
          <Plus className="size-4" />
          Nouvelle recherche
        </BtnOutline>
      </div>
    </main>
  );
}
