"use client";

import Link from "next/link";
import { allOffers, favoritesSeed } from "@/lib/data";
import { useNoma } from "@/lib/store";
import { Avatar } from "@/components/ui";
import { LogoMark } from "@/components/logo";
import { OfferCard } from "@/components/offer-card";

const tabs = ["Tous", "Produits", "Services"];

export default function Favoris() {
  const favorites = useNoma((s) => s.favorites);
  const toggleFavorite = useNoma((s) => s.toggleFavorite);

  const items = favoritesSeed
    .filter((f) => favorites.includes(f.offerId))
    .map((f) => ({
      ...f,
      offer: allOffers.find((o) => o.id === f.offerId)!,
    }));

  return (
    <main>
      <div className="flex items-center justify-between px-4 py-3">
        <Link href="/" className="flex size-9 items-center">
          <LogoMark />
        </Link>
        <Link href="/compte">
          <Avatar initials="AO" />
        </Link>
      </div>

      <div className="px-4">
        <h1 className="flex items-center gap-2.5 font-display text-[26px] font-extrabold text-ink">
          Mes favoris
          {items.length > 0 && (
            <span className="flex size-6 items-center justify-center rounded-full bg-carrot text-[12px] font-extrabold text-white">
              {items.length}
            </span>
          )}
        </h1>

        <div className="mt-3 flex gap-2">
          {tabs.map((t, i) => (
            <span
              key={t}
              className={`rounded-full px-4 py-2 text-[13px] font-semibold ${
                i === 0
                  ? "bg-forest text-white"
                  : "border border-line bg-white text-ink-soft"
              }`}
            >
              {t}
            </span>
          ))}
        </div>

        <div className="mt-4 space-y-3">
          {items.map((f) => (
            <OfferCard
              key={f.offer.id}
              offer={f.offer}
              removed={f.removed}
              heartActive
              onHeart={() => toggleFavorite(f.offer.id)}
            />
          ))}
        </div>

        {items.length === 0 && (
          <div className="mt-6 rounded-2xl border border-line bg-white p-5 text-center text-[14px] text-ink-soft">
            Aucun favori pour l'instant.
            <br />
            Touchez le cœur sur une offre pour la garder.
          </div>
        )}

        <Link
          href="/"
          className="mt-4 flex items-center justify-center gap-2 rounded-xl border border-line bg-white py-3 text-[14px] font-bold text-forest"
        >
          Explorer les offres
        </Link>
      </div>
    </main>
  );
}
