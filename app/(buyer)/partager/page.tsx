"use client";

import { useRouter } from "next/navigation";
import {
  ArrowRight,
  Calendar,
  Lock,
  MapPin,
  Pencil,
  Smartphone,
  Store,
} from "lucide-react";
import { TopBar } from "@/components/top-bar";
import { Thumb } from "@/components/thumb";
import { Chip } from "@/components/ui";
import { useNoma } from "@/lib/store";

const shared = [
  { icon: Smartphone, label: "Le produit recherché" },
  { icon: MapPin, label: "Votre budget et votre zone" },
  { icon: Calendar, label: "Votre délai" },
];

export default function PartagerDemande() {
  const router = useRouter();
  const showToast = useNoma((s) => s.showToast);

  return (
    <main>
      <TopBar back="/recherche" avatar="AO" />

      <div className="px-4">
        <h1 className="font-display text-[26px] font-extrabold text-ink">
          Recevoir des propositions
        </h1>

        <div className="mt-4 rounded-2xl border border-line bg-white p-3.5">
          <div className="flex items-center gap-3">
            <Thumb art="phone" className="size-12" iconClassName="size-6" />
            <div className="flex-1">
              <div className="text-[15px] font-bold text-ink">
                iPhone 12 · 128 Go
              </div>
              <div className="text-[13px] text-ink-soft">Bon état</div>
            </div>
            <button
              onClick={() => router.push("/")}
              className="text-ink-soft"
              aria-label="Modifier"
            >
              <Pencil className="size-4" />
            </button>
          </div>
          <div className="mt-2.5 flex flex-wrap gap-2">
            <Chip soft>
              <MapPin className="size-3.5" />
              Cocody
            </Chip>
            <Chip soft>150 000 F max</Chip>
            <Chip soft>
              <Calendar className="size-3.5" />
              2 octobre
            </Chip>
          </div>
        </div>

        <div className="mt-5 text-[16px] font-extrabold text-ink">
          Qui recevra votre demande ?
        </div>
        <button
          onClick={() => showToast("Prototype : choix des vendeurs simulé")}
          className="mt-2.5 flex w-full items-center gap-3 rounded-xl bg-sage p-3.5 text-left"
        >
          <span className="flex size-10 items-center justify-center rounded-full bg-white text-forest">
            <Store className="size-5" strokeWidth={1.9} />
          </span>
          <span className="text-[14px] font-bold text-ink">
            Vendeurs de téléphones à Abidjan
          </span>
          <span className="ml-auto text-ink-soft">›</span>
        </button>

        <div className="mt-5 text-[16px] font-extrabold text-ink">
          Informations partagées
        </div>
        <div className="mt-2.5 divide-y divide-line overflow-hidden rounded-2xl border border-line bg-white">
          {shared.map((s) => (
            <div key={s.label} className="flex items-center gap-3 px-4 py-3.5">
              <s.icon className="size-5 text-ink-soft" strokeWidth={1.8} />
              <span className="text-[14px] font-semibold text-ink">
                {s.label}
              </span>
              <span className="ml-auto text-ink-soft">›</span>
            </div>
          ))}
        </div>

        <div className="mt-3 flex items-center gap-3 rounded-xl bg-sage p-3.5">
          <Lock className="size-5 shrink-0 text-forest" strokeWidth={1.9} />
          <span className="text-[13px] font-bold text-sage-ink">
            Vos coordonnées restent privées.
          </span>
        </div>

        <button
          onClick={() => {
            showToast("Demande partagée avec les vendeurs");
            router.push("/propositions");
          }}
          className="mt-5 flex w-full items-center justify-center gap-2 rounded-xl bg-forest py-3.5 text-[15px] font-bold text-white transition active:scale-[0.99]"
        >
          Partager ma demande
          <ArrowRight className="size-4" />
        </button>
        <button
          onClick={() => router.push("/recherche")}
          className="mt-3 w-full py-2 text-[14px] font-bold text-ink-soft"
        >
          Pas maintenant
        </button>
      </div>
    </main>
  );
}
