"use client";

import Link from "next/link";
import { useState } from "react";
import { ArrowRight, Box, Car, MapPin, Search, Wrench } from "lucide-react";
import { LogoMark } from "@/components/logo";
import { Sheet } from "@/components/modal";
import { NeedForm } from "@/components/need-form";
import { Badge } from "@/components/ui";
import { Thumb } from "@/components/thumb";
import { featuredOffers, formatShort } from "@/lib/data";

const categories = [
  { label: "Produits", icon: Box, sub: "Téléphones, maison, auto…" },
  { label: "Locations", icon: Car, sub: "Voitures, matériel, salles…" },
  { label: "Services", icon: Wrench, sub: "Réparation, plomberie…" },
];

export default function Accueil() {
  const [sheet, setSheet] = useState(false);

  return (
    <main className="px-4">
      <div className="flex items-center justify-between py-3">
        <LogoMark />
        <span className="flex items-center gap-1 text-[14px] font-bold text-ink">
          <MapPin className="size-4 text-forest" />
          Abidjan
        </span>
      </div>

      <div className="mt-1 inline-flex items-center rounded-full bg-sage px-3 py-1.5 text-[11px] font-extrabold uppercase tracking-wider text-sage-ink">
        Votre recherche, simplifiée
      </div>

      <h1 className="mt-3 font-display text-[32px] font-extrabold leading-[1.08] text-ink">
        Votre besoin.
        <br />
        Les bonnes pistes.
      </h1>
      <p className="mt-2.5 text-[14px] leading-relaxed text-ink-soft">
        Dites-nous ce que vous cherchez.
        <br />
        Nous vous aidons à comparer.
      </p>

      <button
        onClick={() => setSheet(true)}
        className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-forest py-4 text-[15px] font-bold text-white transition active:scale-[0.99]"
      >
        <Search className="size-4" />
        Que recherchez-vous ?
      </button>
      <div className="mt-2 text-center text-[12px] text-ink-soft">
        Première recherche sans compte.
      </div>

      <div className="mt-6 text-[16px] font-extrabold text-ink">Ou explorez</div>
      <div className="mt-2.5 grid grid-cols-3 gap-2.5">
        {categories.map((c) => (
          <Link
            key={c.label}
            href="/recherche"
            className="flex flex-col gap-2 rounded-2xl border border-line bg-white p-3.5 transition hover:bg-wash/60"
          >
            <span className="flex size-9 items-center justify-center rounded-full bg-sage text-forest">
              <c.icon className="size-[18px]" strokeWidth={1.9} />
            </span>
            <span>
              <span className="block text-[13px] font-extrabold text-ink">
                {c.label}
              </span>
              <span className="block text-[10px] leading-tight text-ink-soft">
                {c.sub}
              </span>
            </span>
          </Link>
        ))}
      </div>

      <div className="mt-6 flex items-center justify-between">
        <span className="text-[16px] font-extrabold text-ink">
          Produits phares
        </span>
        <Link href="/recherche" className="text-[13px] font-bold text-forest">
          Tout voir
        </Link>
      </div>
      <div className="no-scrollbar -mx-4 mt-2.5 flex gap-3 overflow-x-auto px-4 pb-1">
        {featuredOffers.map((offer) => (
          <Link
            key={offer.id}
            href={`/offre/${offer.id}`}
            className="w-44 shrink-0 rounded-2xl border border-line bg-white p-3 transition hover:bg-wash/40"
          >
            <Thumb art={offer.art} className="h-28 w-full" iconClassName="size-12" />
            <div className="mt-2 truncate text-[13px] font-bold text-ink">
              {offer.title}
            </div>
            <div className="font-display text-[16px] font-extrabold text-ink">
              {formatShort(offer.price)} F
            </div>
            <div className="mt-1 flex items-center gap-1.5">
              <span className="truncate text-[11px] text-ink-soft">
                {offer.zone}
              </span>
              <Badge tone={offer.source === "noma" ? "sage" : "sky"}>
                {offer.source === "noma" ? "Noma" : "Externe"}
              </Badge>
            </div>
          </Link>
        ))}
      </div>

      <div className="mt-5 rounded-2xl bg-sage p-4">
        <div className="font-display text-[17px] font-extrabold text-forest">
          Plusieurs pistes, un seul endroit.
        </div>
        <p className="mt-1 text-[13px] leading-relaxed text-sage-ink">
          Annonces accessibles, catalogue interne et propositions de vendeurs
          avec votre accord.
        </p>
      </div>

      <div className="mt-4 text-center">
        <Link
          href="/alertes"
          className="inline-flex items-center gap-2 text-[13px] font-bold text-forest"
        >
          Mes recherches suivies
          <ArrowRight className="size-3.5" />
        </Link>
      </div>

      <Sheet
        open={sheet}
        onClose={() => setSheet(false)}
        title="Que recherchez-vous ?"
      >
        <NeedForm onDone={() => setSheet(false)} />
      </Sheet>
    </main>
  );
}