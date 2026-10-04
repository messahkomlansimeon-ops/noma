"use client";

import Link from "next/link";
import { Check, Heart } from "lucide-react";
import { formatShort, type Offer } from "@/lib/data";
import { Badge } from "./ui";
import { Thumb } from "./thumb";

export function OfferCard({
  offer,
  selectable,
  selected,
  onToggle,
  heartActive,
  onHeart,
  removed,
  metaExtra,
}: {
  offer: Offer;
  selectable?: boolean;
  selected?: boolean;
  onToggle?: () => void;
  heartActive?: boolean;
  onHeart?: () => void;
  removed?: boolean;
  metaExtra?: string;
}) {
  return (
    <div
      className={`rounded-2xl border bg-white p-3 transition ${
        selected ? "border-carrot ring-2 ring-carrot" : "border-line"
      } ${removed ? "opacity-60" : ""}`}
    >
      <div className="flex gap-3">
        <Link href={`/offre/${offer.id}`} className="shrink-0">
          <Thumb art={offer.art} className="size-[72px]" iconClassName="size-9" />
        </Link>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <Link
              href={`/offre/${offer.id}`}
              className="truncate text-[15px] font-bold text-ink hover:underline"
            >
              {offer.title}
            </Link>
            {selectable ? (
              <button
                onClick={onToggle}
                aria-label="Sélectionner pour comparer"
                className={`flex size-6 shrink-0 items-center justify-center rounded-md border-2 transition ${
                  selected
                    ? "border-carrot bg-carrot text-white"
                    : "border-line bg-white"
                }`}
              >
                {selected && <Check className="size-4" strokeWidth={3} />}
              </button>
            ) : null}
            {onHeart ? (
              <button
                onClick={onHeart}
                aria-label="Favori"
                className="shrink-0"
              >
                <Heart
                  className={`size-5 transition ${
                    heartActive ? "fill-forest text-forest" : "text-ink-soft"
                  }`}
                />
              </button>
            ) : null}
          </div>
          <div className="font-display text-[18px] font-extrabold text-ink">
            {formatShort(offer.price)} FCFA
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
            <span className="text-[13px] text-ink-soft">
              {offer.condition} · {offer.zone}
            </span>
            {removed ? (
              <Badge tone="wash">Annonce supprimée</Badge>
            ) : offer.source === "noma" ? (
              <Badge tone="sage">Noma</Badge>
            ) : (
              <Badge tone="sky">Externe</Badge>
            )}
          </div>
        </div>
      </div>
      <div className="mt-2.5 space-y-0.5 border-t border-line pt-2 text-[12px] leading-snug text-ink-soft">
        <div>
          {offer.sourceName} · {offer.freshness}
          {metaExtra ? ` · ${metaExtra}` : ""}
        </div>
        <div>
          Prix annoncé ·{" "}
          {removed ? "annonce supprimée" : `livraison ${offer.delivery.toLowerCase()}`}
        </div>
      </div>
    </div>
  );
}
