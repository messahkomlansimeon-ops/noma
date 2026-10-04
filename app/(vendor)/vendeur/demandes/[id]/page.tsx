"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  Calendar,
  ChevronRight,
  CirclePlus,
  TriangleAlert,
} from "lucide-react";
import { TopBar } from "@/components/top-bar";
import { Thumb } from "@/components/thumb";
import { Btn, FieldLabel, Input, Textarea } from "@/components/ui";
import { formatShort } from "@/lib/data";
import { useNoma } from "@/lib/store";

export default function FaireProposition() {
  const router = useRouter();
  const showToast = useNoma((s) => s.showToast);
  const [dispo, setDispo] = useState("En stock");
  const [livraison, setLivraison] = useState("Incluse");
  const [prix, setPrix] = useState(150000);

  return (
    <main>
      <TopBar
        back="/vendeur/demandes"
        title="Ma proposition"
        right={<span className="pr-2 text-[13px] font-extrabold text-ink-soft">D-104</span>}
      />

      <div className="px-4">
        <div className="rounded-2xl border border-line bg-white p-3.5">
          <div className="flex items-center gap-3">
            <Thumb art="phone" className="size-12" iconClassName="size-6" />
            <div>
              <div className="text-[15px] font-bold text-ink">
                iPhone 12 · 128 Go
              </div>
              <div className="text-[13px] text-ink-soft">
                Cocody · 150 000 F max
              </div>
            </div>
          </div>
        </div>

        <button
          onClick={() => showToast("Prototype : liaison à une annonce simulée")}
          className="mt-3 flex w-full items-center gap-3 rounded-xl border border-line bg-white p-3.5 text-left"
        >
          <CirclePlus className="size-5 text-forest" strokeWidth={1.8} />
          <span className="text-[14px] font-bold text-ink">
            Avec ou sans annonce existante
          </span>
          <ChevronRight className="ml-auto size-4 text-ink-soft" />
        </button>

        <div className="mt-5">
          <FieldLabel>Titre du produit</FieldLabel>
          <Input defaultValue="iPhone 12 · 128 Go" />
        </div>

        <div className="mt-4">
          <FieldLabel>Disponibilité</FieldLabel>
          <div className="flex gap-2">
            {["En stock", "Sur commande"].map((o) => (
              <button
                key={o}
                onClick={() => setDispo(o)}
                className={`flex-1 rounded-full border py-2.5 text-[13px] font-semibold transition ${
                  dispo === o
                    ? "border-transparent bg-sage text-sage-ink"
                    : "border-line bg-white text-ink"
                }`}
              >
                {o}
              </button>
            ))}
          </div>
        </div>

        <div className="mt-4">
          <FieldLabel>Prix proposé</FieldLabel>
          <div className="flex items-center gap-2">
            <Input
              value={prix ? formatShort(prix) : ""}
              onChange={(e) =>
                setPrix(Number(e.target.value.replace(/\D/g, "")) || 0)
              }
              inputMode="numeric"
            />
            <span className="rounded-xl bg-wash px-3 py-3 text-[13px] font-bold text-ink-soft">
              FCFA
            </span>
          </div>
        </div>

        <div className="mt-4">
          <FieldLabel>Livraison</FieldLabel>
          <div className="flex gap-2">
            {["Incluse", "En supplément", "Retrait"].map((o) => (
              <button
                key={o}
                onClick={() => setLivraison(o)}
                className={`rounded-full border px-3.5 py-2 text-[13px] font-semibold transition ${
                  livraison === o
                    ? "border-carrot/40 bg-carrot-soft text-carrot-ink"
                    : "border-line bg-white text-ink"
                }`}
              >
                {o}
              </button>
            ))}
          </div>
        </div>

        <div className="mt-4">
          <FieldLabel>Date et heure</FieldLabel>
          <button
            onClick={() => showToast("Prototype : calendrier simulé")}
            className="flex w-full items-center gap-2.5 rounded-xl border border-line bg-white px-3.5 py-3 text-left"
          >
            <Calendar className="size-4 text-ink-soft" />
            <span className="text-[15px] font-semibold text-ink">
              2 oct. · 14 h–17 h
            </span>
            <ChevronRight className="ml-auto size-4 text-ink-soft" />
          </button>
        </div>

        <div className="mt-4">
          <FieldLabel>Précision (optionnel)</FieldLabel>
          <Textarea defaultValue="Bon état, chargeur fourni." rows={3} />
          <div className="mt-1 text-right text-[12px] text-ink-soft">26/300</div>
        </div>

        <div className="mt-3 flex items-center justify-between rounded-2xl border border-line bg-white px-4 py-3.5">
          <span className="text-[14px] font-bold text-ink">Total proposé</span>
          <span className="font-display text-[20px] font-extrabold text-ink">
            {formatShort(prix)} FCFA
          </span>
        </div>

        <div className="mt-3 flex items-center gap-2 rounded-xl bg-carrot-soft px-3.5 py-3 text-[13px] font-bold text-carrot-ink">
          <TriangleAlert className="size-4 shrink-0" />
          Accord de l'acheteur requis
        </div>

        <Btn
          onClick={() => {
            showToast("Proposition envoyée (prototype)");
            router.push("/vendeur/demandes");
          }}
          className="mt-4 py-4"
        >
          Envoyer ma proposition
        </Btn>
      </div>
    </main>
  );
}
