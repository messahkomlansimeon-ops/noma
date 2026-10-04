"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  Calendar,
  CheckCheck,
  Pencil,
} from "lucide-react";
import { TopBar } from "@/components/top-bar";
import { Thumb } from "@/components/thumb";
import {
  Btn,
  Chip,
  OptionCard,
  Switch,
  WhatsAppIcon,
} from "@/components/ui";
import { useNoma } from "@/lib/store";

export default function NouvelleAlerte() {
  const router = useRouter();
  const addAlert = useNoma((s) => s.addAlert);
  const showToast = useNoma((s) => s.showToast);
  const [freq, setFreq] = useState("Résumé quotidien");
  const [wa, setWa] = useState(true);

  const activate = () => {
    addAlert({
      title: "iPhone 12 · 128 Go",
      zone: "Abidjan",
      budget: "150 000 F max",
      condition: "Occasion",
      freq: freq === "Immédiate" ? "immediate" : "daily",
      until: "15 oct.",
    });
    showToast("Alerte activée");
    router.push("/alertes");
  };

  return (
    <main>
      <TopBar back="/recherche" title="Nouvelle alerte" avatar="AO" />

      <div className="px-4">
        <div className="rounded-2xl border border-line bg-white p-3.5">
          <div className="flex items-center gap-3">
            <Thumb art="phone" className="size-12" iconClassName="size-6" />
            <span className="text-[15px] font-bold text-ink">
              iPhone 12 · 128 Go
            </span>
            <Pencil className="ml-auto size-4 text-ink-soft" />
          </div>
          <div className="mt-2.5 flex flex-wrap gap-2">
            <Chip soft>Abidjan</Chip>
            <Chip soft>150 000 F max</Chip>
            <Chip soft>Occasion</Chip>
          </div>
        </div>

        <div className="mt-5 text-[16px] font-extrabold text-ink">Fréquence</div>
        <div className="mt-2.5 space-y-2.5">
          <OptionCard selected={freq === "Immédiate"} onClick={() => setFreq("Immédiate")}>
            <span className="flex flex-col">
              Immédiate
              <span className="text-[12px] font-medium text-ink-soft">
                Être prévenu dès qu'une offre correspond
              </span>
            </span>
          </OptionCard>
          <OptionCard selected={freq === "Résumé quotidien"} onClick={() => setFreq("Résumé quotidien")}>
            <span className="flex flex-col">
              Résumé quotidien
              <span className="text-[12px] font-medium text-ink-soft">
                Recevoir un récapitulatif chaque jour
              </span>
            </span>
          </OptionCard>
        </div>

        <div className="mt-5 text-[16px] font-extrabold text-ink">Date de fin</div>
        <button className="mt-2 flex w-full items-center gap-3 rounded-xl border border-line bg-white p-3.5 text-left">
          <Calendar className="size-5 text-ink-soft" strokeWidth={1.8} />
          <span className="text-[14px] font-semibold text-ink">15 octobre 2026</span>
          <span className="ml-auto text-ink-soft">›</span>
        </button>

        <div className="mt-5 text-[16px] font-extrabold text-ink">Notifications</div>
        <div className="mt-2 flex items-center gap-3 rounded-xl border border-line bg-white p-3.5">
          <span className="flex size-10 items-center justify-center rounded-full bg-sage text-forest">
            <WhatsAppIcon className="size-5" />
          </span>
          <span className="flex flex-col">
            <span className="text-[14px] font-bold text-ink">WhatsApp</span>
            <span className="text-[12px] text-ink-soft">+225 07 •• •••• 42</span>
          </span>
          <span className="ml-auto">
            <Switch checked={wa} onChange={setWa} />
          </span>
        </div>

        <div className="mt-3 flex items-center gap-2 text-[13px] font-semibold text-forest">
          <CheckCheck className="size-4" />
          Arrêt possible à tout moment.
        </div>

        <Btn onClick={activate} className="mt-5 py-4">
          Activer l'alerte
        </Btn>
      </div>
    </main>
  );
}
