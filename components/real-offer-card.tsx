"use client";

import { Globe, MapPin } from "lucide-react";
import { formatPublicPrice, type PublicOffer } from "@/lib/contracts";
import { Badge } from "./ui";
import { Thumb } from "./thumb";

export function OfferPhoto({
  offer,
  className = "size-18",
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
        className={`shrink-0 rounded-2xl bg-brand-soft object-cover ${className}`}
      />
    );
  }
  return (
    <Thumb
      art="box"
      className={`${className} bg-mist`}
      iconClassName={iconClassName}
    />
  );
}

/**
 * Carte d'une offre de la recherche sur d'autres sites (démonstration). Aucun lien vers une fiche interne (la fiche d'une annonce n'existe que dans le contexte d'un
 * besoin, par les correspondances) et aucune sélection pour comparer (la comparaison n'existe que sur les résultats d'un besoin).
 */
export function RealOfferCard({
  offer,
  showJustification = false,
}: {
  offer: PublicOffer;
  showJustification?: boolean;
}) {
  return (
    <div className="rounded-3xl border border-line bg-white p-3.5">
      <div className="flex gap-3">
        <div className="shrink-0">
          <OfferPhoto offer={offer} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="line-clamp-2 text-[16px] font-bold leading-snug text-ink">{offer.title}</div>
          <div data-testid="offer-price" className="text-[19px] font-extrabold leading-tight text-ink">
            {formatPublicPrice(offer)}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="flex items-center gap-1 text-[14px] text-ink-soft">
              <MapPin className="size-4 shrink-0" aria-hidden />
              {offer.location ?? "Localisation non renseignée"}
            </span>
            <Badge tone="sky">Annonce externe</Badge>
          </div>
        </div>
      </div>
      <div className="mt-3 flex flex-col gap-1 border-t border-line pt-2.5 text-[13px] leading-snug text-ink-soft">
        <div className="flex items-center gap-1.5 font-semibold">
          <Globe className="size-4 shrink-0" aria-hidden />
          {offer.source}
        </div>
        {showJustification ? (
          <div className="line-clamp-2">{offer.justification}</div>
        ) : null}
        {offer.price === null ? <div>Prix non annoncé par la source</div> : null}
      </div>
    </div>
  );
}
