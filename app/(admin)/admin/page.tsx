"use client";

import Link from "next/link";
import {
  ArrowRight,
  ChevronRight,
  Database,
  Flag,
  Globe,
  History,
  Info,
  Store,
  Unplug,
} from "lucide-react";
import { LogoMark } from "@/components/logo";
import { Avatar, Badge } from "@/components/ui";
import { useNoma } from "@/lib/store";

export default function PilotageAdmin() {
  const cases = useNoma((s) => s.cases);
  const open = cases.filter((c) => c.status === "open");

  return (
    <main>
      <div className="flex items-center justify-between px-4 py-3">
        <div className="flex items-center gap-2">
          <LogoMark />
          <Badge tone="sage">Admin</Badge>
        </div>
        <div className="relative">
          <Avatar initials="AD" className="size-8 text-[11px]" />
          <span className="absolute -right-0.5 -top-0.5 size-2.5 rounded-full bg-carrot ring-2 ring-cream" />
        </div>
      </div>

      <div className="px-4">
        <div className="flex items-center justify-between">
          <h1 className="font-display text-[26px] font-extrabold text-ink">
            Vue d'ensemble
          </h1>
          <span className="rounded-full border border-line bg-white px-3 py-1.5 text-[12px] font-bold text-ink">
            Aujourd'hui ▾
          </span>
        </div>

        <div className="mt-3 grid grid-cols-3 gap-2.5">
          <StatCard2
            icon={Flag}
            value={open.length}
            label="Signalements"
            tone="bg-carrot-soft"
            iconColor="text-carrot-ink"
          />
          <StatCard2
            icon={Store}
            value={2}
            label="Vendeurs à contrôler"
            tone="bg-sage"
            iconColor="text-forest"
          />
          <StatCard2
            icon={Unplug}
            value={1}
            label="Source indisponible"
            tone="bg-wash"
            iconColor="text-ink-soft"
          />
        </div>

        <div className="mt-5 text-[16px] font-extrabold text-ink">À examiner</div>

        <div className="mt-2.5 space-y-3">
          <div className="flex items-center gap-3 rounded-2xl border border-line bg-white p-3.5">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-carrot-soft text-carrot-ink">
              <Flag className="size-5" strokeWidth={1.9} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-[15px] font-extrabold text-ink">
                {open.length} dossiers ouverts
              </div>
              <div className="text-[12px] text-ink-soft">
                Prix, disponibilité, contact
              </div>
            </div>
            <Link
              href="/admin/dossiers"
              className="flex shrink-0 items-center gap-1.5 rounded-xl bg-forest px-3.5 py-2.5 text-[13px] font-bold text-white"
            >
              Ouvrir la file
              <ArrowRight className="size-4" />
            </Link>
          </div>

          <div className="flex items-center gap-3 rounded-2xl border border-line bg-white p-3.5">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-sage text-forest">
              <Store className="size-5" strokeWidth={1.9} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-[15px] font-extrabold text-ink">
                2 profils vendeurs
              </div>
              <div className="text-[12px] text-ink-soft">
                Contrôles à compléter
              </div>
            </div>
            <Link
              href="/admin/vendeurs"
              className="flex shrink-0 items-center gap-1.5 rounded-xl bg-forest px-3.5 py-2.5 text-[13px] font-bold text-white"
            >
              Vérifier
              <ArrowRight className="size-4" />
            </Link>
          </div>
        </div>

        <div className="mt-5 text-[16px] font-extrabold text-ink">Recherche</div>
        <div className="mt-2.5 divide-y divide-line rounded-2xl border border-line bg-white">
          <div className="flex items-center gap-3 px-4 py-3.5">
            <span className="flex size-9 items-center justify-center rounded-full bg-sage text-forest">
              <Database className="size-[18px]" strokeWidth={1.9} />
            </span>
            <span className="text-[14px] font-bold text-ink">
              Catalogue interne
            </span>
            <span className="ml-auto flex items-center gap-1.5 text-[13px] font-bold text-sage-ink">
              <span className="size-2 rounded-full bg-forest" />
              Actif
            </span>
          </div>
          <div className="flex items-center gap-3 px-4 py-3.5">
            <span className="flex size-9 items-center justify-center rounded-full bg-wash text-ink-soft">
              <Globe className="size-[18px]" strokeWidth={1.9} />
            </span>
            <span className="text-[14px] font-bold text-ink">Sources externes</span>
            <span className="ml-auto flex items-center gap-1.5 text-[13px] font-bold text-carrot-ink">
              <span className="size-2 rounded-full bg-carrot" />
              1 indisponible
            </span>
          </div>
          <div className="flex items-center gap-2.5 px-4 py-3 text-[12px] text-ink-soft">
            <Info className="size-4 shrink-0" />
            La recherche interne reste maintenue.
          </div>
        </div>

        <Link
          href="/admin/dossiers"
          className="mt-4 flex items-center gap-3 rounded-2xl border border-line bg-white px-4 py-3.5"
        >
          <span className="flex size-9 items-center justify-center rounded-full bg-wash text-ink-soft">
            <History className="size-[18px]" strokeWidth={1.9} />
          </span>
          <span className="text-[14px] font-bold text-ink">
            Historique des décisions
          </span>
          <ChevronRight className="ml-auto size-4 text-ink-soft" />
        </Link>
      </div>
    </main>
  );
}

function StatCard2({
  icon: Icon,
  value,
  label,
  tone,
  iconColor,
}: {
  icon: typeof Flag;
  value: number;
  label: string;
  tone: string;
  iconColor: string;
}) {
  return (
    <div className={`flex flex-col gap-1 rounded-2xl p-3.5 ${tone}`}>
      <Icon className={`size-5 ${iconColor}`} strokeWidth={1.9} />
      <div className="font-display text-[22px] font-extrabold leading-none text-ink">
        {value}
      </div>
      <div className="text-[11px] font-semibold leading-tight text-ink-soft">
        {label}
      </div>
    </div>
  );
}
