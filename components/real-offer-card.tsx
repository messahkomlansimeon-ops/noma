"use client";

import Link from "next/link";
import { Check } from "lucide-react";
import { formatPublicPrice, type PublicOffer } from "@/lib/contracts";
import { Badge } from "./ui";
import { Thumb } from "./thumb";

export function OfferPhoto({
  offer,
  className = "size-[72px]",
  iconClassName = "size-9",
}: {
  offer: Pick<PublicOffer, "photo" | "title">;
  className?: string;
  iconClassName?: string;
}) {
  if (offer.photo) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- photos de sources externes arbitraires (optimisation Next impossible)
      <img
        src={offer.photo}
        alt={offer.title}
        referrerPolicy="no-referrer"
        loading="lazy"
        className={`shrink-0 rounded-xl bg-sage object-cover ${className}`}
      />
    );
  }
  return (
    <Thumb
      art="box"
      className={`${className} bg-wash`}
      iconClassName={iconClassName}
    />
  );
}

export function RealOfferCard({
  offer,
  selectable,
  selected,
  onToggle,
  showJustification = false,
}: {
  offer: PublicOffer;
  selectable?: boolean;
  selected?: boolean;
  onToggle?: () => void;
  showJustification?: boolean;
}) {
  return (
    <div
      className={`rounded-2xl border bg-white p-3 transition ${
        selected ? "border-carrot ring-2 ring-carrot" : "border-line"
      }`}
    >
      <div className="flex gap-3">
        <Link href={`/offre/${offer.id}`} className="shrink-0">
          <OfferPhoto offer={offer} />
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
                  selected ? "border-carrot bg-carrot text-white" : "border-line bg-white"
                }`}
              >
                {selected && <Check className="size-4" strokeWidth={3} />}
              </button>
            ) : null}
          </div>
          <div className="font-display text-[18px] font-extrabold text-ink">
            {formatPublicPrice(offer)}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
            <span className="text-[13px] text-ink-soft">
              {offer.location ?? "Localisation non renseignée"}
            </span>
            <Badge tone="sky">Annonce externe</Badge>
          </div>
        </div>
      </div>
      <div className="mt-2.5 space-y-0.5 border-t border-line pt-2 text-[12px] leading-snug text-ink-soft">
        <div>{offer.source}</div>
        {showJustification ? (
          <div className="line-clamp-2">{offer.justification}</div>
        ) : null}
        <div>
          {offer.price === null
            ? "Prix non annoncé par la source"
            : `Prix annoncé · devise ${offer.currency}`}
        </div>
      </div>
    </div>
  );
}