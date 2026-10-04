"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  ArrowLeftRight,
  ChevronRight,
  MessageCircle,
  Package,
  Plus,
  Store,
  Tag,
} from "lucide-react";
import { LogoMark } from "@/components/logo";
import { Sheet } from "@/components/modal";
import { NouvelleAnnonceForm } from "@/components/vendor/nouvelle-annonce-form";
import { Thumb } from "@/components/thumb";
import { Badge } from "@/components/ui";
import { useNoma } from "@/lib/store";

export default function DashboardVendeur() {
  const router = useRouter();
  const setRole = useNoma((s) => s.setRole);
  const showToast = useNoma((s) => s.showToast);
  const [sheet, setSheet] = useState(false);

  return (
    <main>
      <div className="flex items-center justify-between px-4 py-3">
        <LogoMark />
        <div className="flex items-center gap-2">
          <button
            onClick={() => showToast("Changement de rôle : sélecteur en haut à droite")}
            className="flex items-center gap-1.5 rounded-full border border-line bg-white px-3 py-1.5 text-[13px] font-bold text-ink"
          >
            Vendeur
            <ChevronRight className="size-3.5 rotate-90 text-ink-soft" />
          </button>
          <button
            onClick={() => router.push("/vendeur/demandes")}
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
          Marcory Mobile
        </h1>
        <div className="text-[13px] text-ink-soft">Votre activité</div>

        <div className="mt-3 grid grid-cols-3 gap-2.5">
          <Stat icon={Tag} value={2} label="Annonces en ligne" tone="sage" />
          <Stat icon={MessageCircle} value={3} label="Demandes reçues" tone="carrot" />
          <Stat icon={Package} value={1} label="Commande en cours" tone="wash" />
        </div>

        <button
          onClick={() => setSheet(true)}
          className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-forest py-3.5 text-[15px] font-bold text-white transition active:scale-[0.99]"
        >
          <Plus className="size-4" />
          Publier une annonce
        </button>

        <div className="mt-5 flex items-center gap-2">
          <span className="text-[16px] font-extrabold text-ink">À traiter</span>
          <span className="flex size-5 items-center justify-center rounded-full bg-carrot text-[11px] font-extrabold text-white">
            2
          </span>
          <Link
            href="/vendeur/demandes"
            className="ml-auto text-[13px] font-bold text-forest"
          >
            Tout voir ›
          </Link>
        </div>

        <div className="mt-3 space-y-3">
          <div className="rounded-2xl border border-line bg-white p-3.5">
            <div className="flex items-center gap-3">
              <Thumb art="phone" className="size-12" iconClassName="size-6" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-[12px] text-ink-soft">
                    Nouvelle demande
                  </span>
                  <Badge tone="carrot" className="ml-auto">
                    Nouveau
                  </Badge>
                </div>
                <div className="truncate text-[15px] font-bold text-ink">
                  iPhone 12 · 128 Go
                </div>
                <div className="text-[12px] text-ink-soft">
                  Cocody · 150 000 F max
                </div>
              </div>
            </div>
            <Link
              href="/vendeur/demandes/D-104"
              className="mt-2 flex items-center justify-between py-1.5 text-[13px] font-bold text-forest"
            >
              Répondre
              <ChevronRight className="size-4" />
            </Link>
          </div>

          <div className="rounded-2xl border border-line bg-white p-3.5">
            <div className="flex items-center gap-3">
              <span className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-sage text-forest">
                <Package className="size-6" strokeWidth={1.6} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-[12px] text-ink-soft">
                    Commande NM-024
                  </span>
                  <Badge tone="sage" className="ml-auto">
                    En préparation
                  </Badge>
                </div>
                <div className="truncate text-[15px] font-bold text-ink">
                  iPhone 12 · 128 Go
                </div>
                <div className="text-[12px] text-ink-soft">
                  2 oct. · 14 h–17 h
                </div>
              </div>
            </div>
            <Link
              href="/vendeur/commandes/NM-024"
              className="mt-2 flex items-center justify-between py-1.5 text-[13px] font-bold text-forest"
            >
              Voir la commande
              <ChevronRight className="size-4" />
            </Link>
          </div>
        </div>

        <Link
          href="/vendeur/demandes"
          className="mt-4 flex items-center gap-3 rounded-2xl border border-line bg-white px-4 py-3.5"
        >
          <span className="flex size-9 items-center justify-center rounded-full bg-sage text-forest">
            <MessageCircle className="size-[18px]" strokeWidth={1.9} />
          </span>
          <span className="text-[14px] font-bold text-ink">
            Voir toutes les demandes
          </span>
          <ChevronRight className="ml-auto size-4 text-ink-soft" />
        </Link>

        <button
          onClick={() => {
            setRole("buyer");
            router.push("/");
          }}
          className="mt-3 flex w-full items-center gap-3 rounded-2xl border border-line bg-white px-4 py-3.5 text-left"
        >
          <span className="flex size-9 items-center justify-center rounded-full bg-wash text-ink-soft">
            <ArrowLeftRight className="size-4" />
          </span>
          <span className="text-[14px] font-bold text-ink">
            Passer en mode acheteur
          </span>
          <ChevronRight className="ml-auto size-4 text-ink-soft" />
        </button>

        <div className="mt-4 flex items-center justify-center gap-2 pb-2 text-[12px] text-ink-soft">
          <Store className="size-4" />
          Espace vendeur · Marcory Mobile
        </div>
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

function Stat({
  icon: Icon,
  value,
  label,
  tone,
}: {
  icon: typeof Tag;
  value: number;
  label: string;
  tone: "sage" | "carrot" | "wash";
}) {
  const tones = { sage: "bg-sage", carrot: "bg-carrot-soft", wash: "bg-wash" };
  return (
    <div className={`flex flex-col gap-1 rounded-2xl p-3.5 ${tones[tone]}`}>
      <Icon className="size-5 text-forest" strokeWidth={1.9} />
      <div className="font-display text-[22px] font-extrabold leading-none text-ink">
        {value}
      </div>
      <div className="text-[11px] font-semibold leading-tight text-ink-soft">
        {label}
      </div>
    </div>
  );
}
