"use client";

import { useRouter } from "next/navigation";
import {
  Calendar,
  CirclePlus,
  EllipsisVertical,
  Plus,
  TriangleAlert,
  Wallet,
} from "lucide-react";
import { TopBar } from "@/components/top-bar";
import { Thumb } from "@/components/thumb";
import { FieldLabel, Input } from "@/components/ui";
import { formatShort, quoteSeed } from "@/lib/data";
import { useNoma } from "@/lib/store";

export default function NouveauDevis() {
  const router = useRouter();
  const quoteLines = useNoma((s) => s.quoteLines);
  const addQuoteLine = useNoma((s) => s.addQuoteLine);
  const showToast = useNoma((s) => s.showToast);

  const total = quoteLines.reduce((sum, l) => sum + l.amount, 0);

  return (
    <main>
      <TopBar
        back="/vendeur"
        title="Nouveau devis"
        right={<span className="pr-2 text-[12px] font-semibold text-ink-soft">Brouillon</span>}
      />

      <div className="px-4">
        <div className="rounded-2xl border border-line bg-white p-3.5">
          <div className="flex items-center gap-3">
            <Thumb art="ac" className="size-12" iconClassName="size-6" />
            <div>
              <div className="text-[15px] font-bold text-ink">
                {quoteSeed.service}
              </div>
              <div className="text-[13px] text-ink-soft">
                {quoteSeed.provider}
              </div>
            </div>
          </div>
        </div>

        <div className="mt-4">
          <FieldLabel>Intervention</FieldLabel>
          <Input defaultValue={quoteSeed.intervention} />
        </div>

        <div className="mt-5 text-[16px] font-extrabold text-ink">
          Détail du devis
        </div>
        <div className="mt-2 divide-y divide-line rounded-2xl border border-line bg-white">
          {quoteLines.map((l, i) => (
            <div key={`${l.label}-${i}`} className="flex items-center gap-3 px-4 py-3">
              <span className="flex-1 text-[14px] font-semibold text-ink">
                {l.label}
              </span>
              <span className="text-[14px] font-extrabold text-ink">
                {formatShort(l.amount)} F
              </span>
              <EllipsisVertical className="size-4 text-ink-soft" />
            </div>
          ))}
          <button
            onClick={addQuoteLine}
            className="flex w-full items-center gap-2 px-4 py-3 text-[14px] font-bold text-forest"
          >
            <CirclePlus className="size-5" strokeWidth={1.8} />
            Ajouter une ligne
          </button>
        </div>

        <div className="mt-3 flex items-center justify-between rounded-2xl bg-sage px-4 py-3.5">
          <span className="text-[14px] font-bold text-sage-ink">
            Total du devis
          </span>
          <span className="font-display text-[20px] font-extrabold text-forest">
            {formatShort(total)} FCFA
          </span>
        </div>

        <div className="mt-4 divide-y divide-line rounded-2xl border border-line bg-white">
          <button
            onClick={() => showToast("Prototype : date simulée")}
            className="flex w-full items-center gap-3 px-4 py-3.5 text-left"
          >
            <Calendar className="size-5 text-ink-soft" strokeWidth={1.8} />
            <span className="flex-1 text-[14px] font-semibold text-ink">
              Intervention prévue
            </span>
            <span className="text-[13px] font-bold text-ink">{quoteSeed.slot}</span>
          </button>
          <button
            onClick={() => showToast("Prototype : validité simulée")}
            className="flex w-full items-center gap-3 px-4 py-3.5 text-left"
          >
            <Calendar className="size-5 text-ink-soft" strokeWidth={1.8} />
            <span className="flex-1 text-[14px] font-semibold text-ink">
              Devis valable jusqu'au
            </span>
            <span className="text-[13px] font-bold text-ink">{quoteSeed.valid}</span>
          </button>
          <button
            onClick={() => showToast("Prototype : règlement simulé")}
            className="flex w-full items-center gap-3 px-4 py-3.5 text-left"
          >
            <Wallet className="size-5 text-ink-soft" strokeWidth={1.8} />
            <span className="flex-1 text-[14px] font-semibold text-ink">
              Règlement
            </span>
            <span className="text-[13px] font-bold text-ink">{quoteSeed.rule}</span>
          </button>
        </div>

        <div className="mt-3 flex items-center gap-2 rounded-xl bg-carrot-soft px-3.5 py-3 text-[13px] font-bold text-carrot-ink">
          <TriangleAlert className="size-4 shrink-0" />
          Accord du client requis
        </div>

        <button
          onClick={() => {
            showToast("Devis envoyé (prototype)");
            router.push("/vendeur/commandes");
          }}
          className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-forest py-3.5 text-[15px] font-bold text-white transition active:scale-[0.99]"
        >
          Envoyer le devis
          <span aria-hidden>›</span>
        </button>

        <div className="flex items-center justify-center gap-2 py-4 text-[12px] text-ink-soft">
          <Plus className="size-4" />
          Le devis est joint à votre proposition.
        </div>
      </div>
    </main>
  );
}
