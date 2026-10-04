"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  Box,
  ChevronRight,
  CirclePlus,
  FileText,
  Plus,
  Smartphone,
  Tag,
  Truck,
  Wrench,
} from "lucide-react";
import { TopBar } from "@/components/top-bar";
import { Thumb } from "@/components/thumb";
import { FieldLabel, Input, Switch } from "@/components/ui";
import { useNoma } from "@/lib/store";

const types = [
  { label: "Produit", icon: Box },
  { label: "Service", icon: Wrench },
  { label: "Location", icon: Tag },
];

export function NouvelleAnnonceForm({
  embedded,
  onDone,
}: {
  embedded?: boolean;
  onDone?: () => void;
}) {
  const router = useRouter();
  const showToast = useNoma((s) => s.showToast);
  const [type, setType] = useState("Produit");
  const [etat, setEtat] = useState("Occasion");
  const [dispo, setDispo] = useState(true);

  const publish = () => {
    showToast("Annonce publiée (prototype)");
    if (embedded) {
      onDone?.();
    } else {
      router.push("/vendeur/annonces");
    }
  };

  return (
    <>
      {!embedded && (
        <TopBar
          back="/vendeur/annonces"
          right={
            <span className="pr-2 text-[12px] font-semibold text-ink-soft">
              Brouillon
            </span>
          }
        />
      )}

      <div className={embedded ? "" : "px-4"}>
        {!embedded && (
          <h1 className="font-display text-[26px] font-extrabold text-ink">
            Nouvelle annonce
          </h1>
        )}

        <div className="mt-3 grid grid-cols-3 gap-2">
          {types.map((t) => (
            <button
              key={t.label}
              onClick={() => setType(t.label)}
              className={`flex min-w-0 items-center justify-center gap-1.5 rounded-xl border px-1 py-2.5 text-[13px] font-bold transition ${
                type === t.label
                  ? "border-transparent bg-forest text-white"
                  : "border-line bg-white text-ink"
              }`}
            >
              <t.icon className="size-4 shrink-0" strokeWidth={1.9} />
              <span className="truncate">{t.label}</span>
            </button>
          ))}
        </div>

        <div className="mt-4 flex gap-2.5">
          <Thumb art="phone" className="size-20" iconClassName="size-9" />
          <Thumb art="phone" className="size-20" iconClassName="size-9" />
          <button
            onClick={() => showToast("Prototype : ajout de photos simulé")}
            className="flex size-20 flex-col items-center justify-center gap-1 rounded-xl border-2 border-dashed border-line bg-white text-ink-soft"
          >
            <Plus className="size-5" />
            <span className="text-[11px] font-bold">Photos</span>
          </button>
        </div>

        <div className="mt-5 space-y-4">
          <div>
            <FieldLabel>Titre</FieldLabel>
            <Input defaultValue="iPhone 13 · 128 Go" />
          </div>

          <div>
            <FieldLabel>Catégorie</FieldLabel>
            <button
              onClick={() => showToast("Prototype : sélection de catégorie")}
              className="flex w-full items-center gap-2.5 rounded-xl border border-line bg-white px-3.5 py-3 text-left"
            >
              <Tag className="size-4 text-ink-soft" />
              <span className="text-[15px] font-semibold text-ink">Téléphones</span>
              <ChevronRight className="ml-auto size-4 text-ink-soft" />
            </button>
          </div>

          <div>
            <FieldLabel>Prix</FieldLabel>
            <div className="flex items-center gap-2">
              <Input defaultValue="190 000" inputMode="numeric" />
              <span className="rounded-xl bg-wash px-3 py-3 text-[13px] font-bold text-ink-soft">
                FCFA
              </span>
            </div>
          </div>

          <div>
            <FieldLabel>État</FieldLabel>
            <div className="flex gap-2">
              {["Neuf", "Occasion", "Reconditionné"].map((e) => (
                <button
                  key={e}
                  onClick={() => setEtat(e)}
                  className={`flex-1 rounded-full border py-2.5 text-[13px] font-semibold transition ${
                    etat === e
                      ? "border-carrot/40 bg-carrot-soft text-carrot-ink"
                      : "border-line bg-white text-ink"
                  }`}
                >
                  {e}
                </button>
              ))}
            </div>
          </div>

          <div>
            <FieldLabel>Localisation</FieldLabel>
            <Input defaultValue="Marcory, Abidjan" />
          </div>

          <div className="flex items-center justify-between rounded-xl border border-line bg-white px-3.5 py-3">
            <span className="text-[14px] font-semibold text-ink">Disponible</span>
            <Switch checked={dispo} onChange={setDispo} />
          </div>

          <button
            onClick={() => showToast("Prototype : description simulée")}
            className="flex w-full items-center gap-3 rounded-xl border border-line bg-white px-3.5 py-3 text-left"
          >
            <FileText className="size-5 text-ink-soft" strokeWidth={1.8} />
            <span className="text-[14px] font-semibold text-ink">
              Description et caractéristiques
            </span>
            <ChevronRight className="ml-auto size-4 text-ink-soft" />
          </button>

          <button
            onClick={() => showToast("Prototype : livraison et garantie simulées")}
            className="flex w-full items-center gap-3 rounded-xl border border-line bg-white px-3.5 py-3 text-left"
          >
            <Truck className="size-5 text-ink-soft" strokeWidth={1.8} />
            <span className="text-[14px] font-semibold text-ink">
              Livraison et garantie
            </span>
            <ChevronRight className="ml-auto size-4 text-ink-soft" />
          </button>
        </div>

        <button
          onClick={publish}
          className="mt-5 w-full rounded-xl bg-forest py-3.5 text-[15px] font-bold text-white transition active:scale-[0.99]"
        >
          Publier l'annonce
        </button>

        <div className="flex items-center justify-center gap-2 py-4 text-[12px] text-ink-soft">
          <CirclePlus className="size-4" />
          <Smartphone className="size-4" />
          Vos photos restent visibles sur Noma uniquement.
        </div>
      </div>
    </>
  );
}