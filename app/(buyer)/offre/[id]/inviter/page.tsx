"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { Copy, Link2, Lock, Share2, Store, X } from "lucide-react";
import { TopBar } from "@/components/top-bar";
import { Thumb } from "@/components/thumb";
import { Badge } from "@/components/ui";
import { allOffers, formatShort } from "@/lib/data";
import { useNoma } from "@/lib/store";

const steps = ["Partagez l'invitation", "Le vendeur s'inscrit", "Confirmez les conditions"];

export default function InviterVendeur() {
  const { id } = useParams<{ id: string }>();
  const offer = allOffers.find((o) => o.id === id) ?? allOffers[0];
  const showToast = useNoma((s) => s.showToast);

  const copy = () => {
    navigator.clipboard?.writeText("https://noma.ci/invitation/N-042").catch(() => {});
    showToast("Lien d'invitation copié");
  };

  return (
    <main>
      <TopBar
        back={`/offre/${id}`}
        title="Inviter le vendeur"
        right={
          <Link
            href={`/offre/${id}`}
            className="flex size-9 items-center justify-center rounded-full text-ink transition hover:bg-wash"
            aria-label="Fermer"
          >
            <X className="size-5" />
          </Link>
        }
      />

      <div className="px-4">
        <div className="rounded-2xl border border-line bg-white p-3.5">
          <div className="flex items-center gap-3">
            <Thumb art={offer.art} className="size-12" iconClassName="size-6" />
            <div>
              <div className="text-[15px] font-bold text-ink">{offer.title}</div>
              <div className="font-display text-[18px] font-extrabold text-ink">
                {formatShort(offer.price)} FCFA
              </div>
              <Badge tone="sky" className="mt-0.5">
                Annonce externe
              </Badge>
            </div>
          </div>
        </div>

        <div className="mt-3 flex items-center justify-center gap-4 rounded-2xl bg-sage py-8">
          <span className="flex size-20 items-center justify-center rounded-2xl bg-white text-forest">
            <Store className="size-10" strokeWidth={1.5} />
          </span>
          <span className="flex size-10 items-center justify-center rounded-full bg-forest text-white">
            <Link2 className="size-5" />
          </span>
        </div>

        <h1 className="mt-4 font-display text-[26px] font-extrabold text-ink">
          Poursuivez sur Noma
        </h1>
        <p className="mt-1 text-[14px] text-ink-soft">
          Le vendeur doit s'inscrire pour continuer ici.
        </p>

        <div className="mt-4 space-y-2.5">
          {steps.map((s, i) => (
            <div key={s} className="flex items-center gap-3">
              <span
                className={`flex size-7 shrink-0 items-center justify-center rounded-full text-[13px] font-extrabold ${
                  i === 0
                    ? "bg-carrot-soft text-carrot-ink"
                    : "bg-wash text-ink-soft"
                }`}
              >
                {i + 1}
              </span>
              <span className="text-[14px] font-semibold text-ink">{s}</span>
            </div>
          ))}
        </div>

        <div className="mt-4 flex items-center gap-3 rounded-2xl border border-line bg-white p-3.5">
          <span className="flex size-10 items-center justify-center rounded-full bg-sage text-forest">
            <Link2 className="size-5" />
          </span>
          <div className="flex-1">
            <div className="text-[15px] font-bold text-ink">Invitation N-042</div>
            <div className="text-[13px] text-ink-soft">Prête à partager</div>
          </div>
        </div>

        <button
          onClick={copy}
          className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-forest py-3.5 text-[15px] font-bold text-white transition active:scale-[0.99]"
        >
          <Copy className="size-4" />
          Copier le lien
        </button>
        <button
          onClick={() => showToast("Prototype : partage simulé")}
          className="mt-2.5 flex w-full items-center justify-center gap-2 rounded-xl border border-forest/30 bg-white py-3.5 text-[15px] font-bold text-forest"
        >
          <Share2 className="size-4" />
          Partager l'invitation
        </button>

        <button
          onClick={() => showToast("Suivi disponible après inscription du vendeur")}
          className="mt-4 flex w-full items-center gap-3 rounded-2xl border border-line bg-white px-4 py-3.5 text-left"
        >
          <Lock className="size-5 text-ink-soft" strokeWidth={1.8} />
          <span className="text-[14px] font-bold text-ink">Suivi sur Noma</span>
          <span className="ml-auto text-[13px] text-ink-soft">Inscription requise ›</span>
        </button>
      </div>
    </main>
  );
}
