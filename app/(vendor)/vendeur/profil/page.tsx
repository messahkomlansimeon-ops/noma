"use client";

import { useState } from "react";
import { Check, CircleCheck, CirclePlus, Phone, Plus, Store, X } from "lucide-react";
import { TopBar } from "@/components/top-bar";
import { FieldLabel, Input, Switch } from "@/components/ui";
import { useNoma } from "@/lib/store";

export default function ProfilVendeur() {
  const showToast = useNoma((s) => s.showToast);
  const [profil, setProfil] = useState("Professionnel");
  const [accept, setAccept] = useState(true);
  const categories = ["Téléphones", "Accessoires"];
  const zones = ["Marcory", "Cocody", "Yopougon"];

  return (
    <main>
      <TopBar back="/vendeur" />

      <div className="px-4">
        <h1 className="font-display text-[26px] font-extrabold text-ink">
          Profil vendeur
        </h1>

        <div className="mt-3 rounded-2xl border border-line bg-white p-4">
          <div className="flex items-center gap-3.5">
            <span className="relative flex size-16 items-center justify-center rounded-full bg-sage text-forest">
              <Store className="size-7" strokeWidth={1.7} />
              <span className="absolute -bottom-0.5 -right-0.5 flex size-6 items-center justify-center rounded-full border-2 border-white bg-carrot text-white">
                <Plus className="size-3.5" strokeWidth={3} />
              </span>
            </span>
            <span className="text-[14px] font-bold text-forest">
              Ajouter un logo
            </span>
          </div>

          <div className="mt-4">
            <FieldLabel>Nom public</FieldLabel>
            <Input defaultValue="Marcory Mobile" />
          </div>

          <div className="mt-4">
            <FieldLabel>Profil</FieldLabel>
            <div className="flex gap-2">
              {["Particulier", "Professionnel"].map((p) => (
                <button
                  key={p}
                  onClick={() => setProfil(p)}
                  className={`flex-1 rounded-full border py-2.5 text-[13px] font-semibold transition ${
                    profil === p
                      ? "border-carrot/40 bg-carrot-soft text-carrot-ink"
                      : "border-line bg-white text-ink"
                  }`}
                >
                  {p}
                </button>
              ))}
            </div>
          </div>

          <div className="mt-4">
            <FieldLabel>Catégories</FieldLabel>
            <div className="flex flex-wrap gap-2">
              {categories.map((c) => (
                <span
                  key={c}
                  className="flex items-center gap-1.5 rounded-full bg-sage px-3 py-1.5 text-[13px] font-bold text-sage-ink"
                >
                  {c}
                  <X className="size-3.5" />
                </span>
              ))}
              <button
                onClick={() => showToast("Prototype : ajout simulé")}
                className="flex size-8 items-center justify-center rounded-full border border-line bg-white text-ink-soft"
                aria-label="Ajouter une catégorie"
              >
                <CirclePlus className="size-5" strokeWidth={1.8} />
              </button>
            </div>
          </div>

          <div className="mt-4">
            <FieldLabel>Zones desservies</FieldLabel>
            <div className="flex flex-wrap gap-2">
              {zones.map((z) => (
                <span
                  key={z}
                  className="flex items-center gap-1.5 rounded-full bg-sage px-3 py-1.5 text-[13px] font-bold text-sage-ink"
                >
                  {z}
                  <X className="size-3.5" />
                </span>
              ))}
              <button
                onClick={() => showToast("Prototype : ajout simulé")}
                className="flex size-8 items-center justify-center rounded-full border border-line bg-white text-ink-soft"
                aria-label="Ajouter une zone"
              >
                <CirclePlus className="size-5" strokeWidth={1.8} />
              </button>
            </div>
          </div>

          <div className="mt-4">
            <FieldLabel>Localisation</FieldLabel>
            <Input defaultValue="Marcory, Abidjan" />
          </div>

          <div className="mt-4 flex items-center gap-3 rounded-xl bg-sage p-3.5">
            <Phone className="size-5 text-forest" strokeWidth={1.9} />
            <div className="flex-1">
              <div className="text-[14px] font-extrabold text-forest">
                Téléphone confirmé
              </div>
              <div className="text-[13px] text-sage-ink">+225 07 •• •••• 42</div>
            </div>
            <CircleCheck className="size-5 text-forest" />
          </div>

          <div className="mt-3 flex items-center gap-3 rounded-xl border border-line px-3.5 py-3">
            <button
              onClick={() => setAccept(!accept)}
              className={`flex size-5 items-center justify-center rounded-md ${
                accept ? "bg-forest text-white" : "border-2 border-line bg-white"
              }`}
            >
              {accept && <Check className="size-3.5" strokeWidth={3} />}
            </button>
            <span className="flex-1 text-[14px] font-semibold text-ink">
              J'accepte les règles vendeurs
            </span>
            <span className="text-ink-soft">›</span>
          </div>
        </div>

        <button
          onClick={() => showToast("Espace vendeur prêt (prototype)")}
          className="mt-4 w-full rounded-xl bg-forest py-3.5 text-[15px] font-bold text-white transition active:scale-[0.99]"
        >
          Créer mon espace vendeur
        </button>

        <div className="flex items-center justify-center gap-2 py-4 text-[12px] text-ink-soft">
          <Switch checked onChange={() => {}} />
          Vendeur vérifié par téléphone
        </div>
      </div>
    </main>
  );
}
