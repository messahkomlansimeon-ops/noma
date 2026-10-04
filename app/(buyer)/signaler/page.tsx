"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { CircleAlert, Paperclip, X } from "lucide-react";
import { TopBar } from "@/components/top-bar";
import { Thumb } from "@/components/thumb";
import { Btn, OptionCard, Textarea } from "@/components/ui";
import { useNoma } from "@/lib/store";

const motifs = [
  "Produit déjà vendu",
  "Prix incorrect",
  "Vendeur injoignable",
  "Suspicion de fraude",
];

function SignalerForm() {
  const router = useRouter();
  const params = useSearchParams();
  const commande = params.get("commande");
  const addReport = useNoma((s) => s.addReport);
  const showToast = useNoma((s) => s.showToast);
  const [motif, setMotif] = useState("Prix incorrect");
  const [detail, setDetail] = useState("Le vendeur demande 170 000 F.");

  const send = () => {
    addReport({ motif, offer: "iPhone 12 · 128 Go", detail });
    showToast("Signalement envoyé · Il sera examiné");
    router.push(commande ? `/commandes/${commande}` : "/recherche");
  };

  return (
    <main>
      <TopBar
        back="/recherche"
        title="Signaler"
        right={
          <button
            onClick={() => router.back()}
            className="flex size-9 items-center justify-center rounded-full text-ink transition hover:bg-wash"
            aria-label="Fermer"
          >
            <X className="size-5" />
          </button>
        }
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
                145 000 FCFA · Annonce externe
              </div>
            </div>
          </div>
        </div>

        <div className="mt-5 text-[16px] font-extrabold text-ink">
          Quel est le problème ?
        </div>
        <div className="mt-2.5 space-y-2.5">
          {motifs.map((m) => (
            <OptionCard key={m} selected={motif === m} onClick={() => setMotif(m)}>
              {m}
            </OptionCard>
          ))}
        </div>

        <div className="mt-5 text-[16px] font-extrabold text-ink">Précisions</div>
        <Textarea
          value={detail}
          onChange={(e) => setDetail(e.target.value)}
          rows={3}
          className="mt-2"
        />

        <button
          onClick={() => showToast("Prototype : téléversement simulé")}
          className="mt-3 flex w-full items-center gap-3 rounded-xl border border-line bg-white p-3.5 text-left"
        >
          <Paperclip className="size-5 text-ink-soft" strokeWidth={1.8} />
          <span className="flex flex-col">
            <span className="text-[14px] font-bold text-ink">
              Ajouter une preuve
            </span>
            <span className="text-[12px] text-ink-soft">Photo ou capture</span>
          </span>
        </button>

        <div className="mt-3 flex items-center gap-2 text-[12px] text-ink-soft">
          <CircleAlert className="size-4 shrink-0" />
          Votre signalement sera examiné par l'équipe Noma.
        </div>

        <Btn onClick={send} className="mt-5 py-4">
          Envoyer le signalement
        </Btn>
        <button
          onClick={() => router.back()}
          className="mt-3 w-full py-2 text-[14px] font-bold text-ink-soft"
        >
          Annuler
        </button>
      </div>
    </main>
  );
}

export default function Signaler() {
  return (
    <Suspense fallback={<main className="p-6 text-center text-ink-soft">…</main>}>
      <SignalerForm />
    </Suspense>
  );
}
