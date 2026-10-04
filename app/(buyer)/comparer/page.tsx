"use client";

import Link from "next/link";
import { ArrowRight, Info } from "lucide-react";
import { TopBar } from "@/components/top-bar";
import { OfferPhoto } from "@/components/real-offer-card";
import { Thumb } from "@/components/thumb";
import { Badge, Chip } from "@/components/ui";
import { allOffers, formatShort } from "@/lib/data";
import { formatPublicPrice, parseBudgetFcfa } from "@/lib/contracts";
import { useRealSearch } from "@/lib/real-search";
import { useNoma } from "@/lib/store";

const rows = [
  { key: "condition", label: "État" },
  { key: "delivery", label: "Livraison" },
  { key: "warranty", label: "Garantie" },
  { key: "availability", label: "Disponibilité" },
] as const;

function valueOf(offer: (typeof allOffers)[number], key: string) {
  if (key === "availability") {
    return offer.availability === "confirmed"
      ? "Confirmée"
      : "À confirmer";
  }
  const raw = offer[key as "delivery" | "warranty" | "condition"];
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

function isGood(key: string, v: string) {
  if (key === "availability") return v === "Confirmée";
  return !/non renseignée|inconnue|à préciser|à confirmer|retrait/i.test(v);
}

export default function Comparer() {
  const compare = useNoma((s) => s.compare);
  const realOffers = useRealSearch((s) => s.offers);
  const realNeed = useRealSearch((s) => s.need);

  const pickedReal = realOffers.filter((o) => compare.includes(o.id));
  const pickedDemo = allOffers.filter((o) => compare.includes(o.id));
  // jamais de mélange : si des offres réelles correspondent à la sélection,
  // la comparaison porte sur elles seules
  const useReal = pickedReal.length > 0;

  return (
    <main>
      <TopBar
        back="/recherche"
        title="Comparer"
        right={
          <Link
            href="/recherche"
            className="rounded-full px-2 py-1.5 text-[14px] font-bold text-forest transition hover:bg-wash"
          >
            Modifier
          </Link>
        }
      />

      <div className="px-4">
        <div className="flex items-center gap-2.5 rounded-xl border border-line bg-white px-3.5 py-2.5">
          <span className="truncate text-[14px] font-semibold text-ink-soft">
            {useReal
              ? realNeed.text.trim() || "Votre besoin"
              : "iPhone 12 · 128 Go"}
          </span>
        </div>

        <div className="mt-3 flex flex-wrap gap-2">
          {useReal ? (
            <>
              <Chip soft>{realNeed.location.trim() || "Localisation du texte"}</Chip>
              <Chip soft>
                {(() => {
                  const parsed = parseBudgetFcfa(realNeed.budgetFcfa);
                  return realNeed.budgetFcfa.trim().length === 0
                    ? "Budget du texte"
                    : parsed.ok
                      ? `${new Intl.NumberFormat("fr-FR").format(parsed.value)} F max`
                      : realNeed.budgetFcfa.trim();
                })()}
              </Chip>
            </>
          ) : (
            <>
              <Chip soft>Abidjan</Chip>
              <Chip soft>150 000 F max</Chip>
              <Chip soft>Occasion</Chip>
            </>
          )}
        </div>

        {!useReal && pickedDemo.length === 0 ? (
          <div className="mt-4 rounded-2xl bg-wash p-4 text-[14px] font-semibold text-ink-soft">
            Aucune offre sélectionnée. Sélectionnez jusqu'à 2 offres dans vos
            résultats pour les comparer.
          </div>
        ) : (
          <div className="mt-4 grid grid-cols-2 gap-3">
            {(useReal
              ? pickedReal.map((o) => ({ kind: "real" as const, offer: o }))
              : pickedDemo.map((o) => ({ kind: "demo" as const, offer: o }))
            ).map(({ kind, offer }) => (
              <div
                key={offer.id}
                className="overflow-hidden rounded-2xl border border-line bg-white"
              >
                <Link href={`/offre/${offer.id}`} className="block">
                  {kind === "real" ? (
                    <OfferPhoto
                      offer={offer}
                      className="h-28 w-full rounded-none"
                      iconClassName="size-12"
                    />
                  ) : (
                    <Thumb
                      art={offer.art}
                      className="h-28 w-full rounded-none"
                      iconClassName="size-12"
                    />
                  )}
                </Link>
                <div className="p-3">
                  <div className="font-display text-[20px] font-extrabold text-ink">
                    {kind === "real" ? formatPublicPrice(offer) : `${formatShort(offer.price)} F`}
                  </div>
                  <div className="mt-0.5 flex items-center gap-1.5 text-[12px] text-ink-soft">
                    <span className="truncate">
                      {kind === "real"
                        ? offer.location ?? "Zone non renseignée"
                        : offer.zone}
                    </span>
                    <Badge tone={kind === "real" ? "sky" : offer.source === "noma" ? "sage" : "sky"}>
                      {kind === "real" ? "Externe" : offer.source === "noma" ? "Noma" : "Externe"}
                    </Badge>
                  </div>
                  {kind === "real" ? (
                    <div className="mt-2.5 space-y-0 border-t border-line">
                      <Row label="Source" value={offer.source} good />
                      <Row
                        label="Pertinence"
                        value={
                          offer.aiStatus === "évalué par IA"
                            ? "Vérifiée par IA"
                            : "Non évaluée"
                        }
                        good={offer.aiStatus === "évalué par IA"}
                      />
                      <Row
                        label="Prix"
                        value={
                          offer.price === null ? "Sur demande" : "Annoncé"
                        }
                        good={offer.price !== null}
                      />
                    </div>
                  ) : (
                    <div className="mt-2.5 space-y-0 border-t border-line">
                      {rows.map((r) => {
                        const v = valueOf(offer, r.key);
                        const good = isGood(r.key, v);
                        return (
                          <Row key={r.key} label={r.label} value={v} good={good} />
                        );
                      })}
                      <Row
                        label="Total annoncé"
                        value={
                          offer.delivery === "Incluse"
                            ? `${formatShort(offer.price)} F`
                            : "À préciser"
                        }
                        good={offer.delivery === "Incluse"}
                      />
                    </div>
                  )}
                </div>
                <Link
                  href={`/offre/${offer.id}`}
                  className="mx-3 mb-3 flex items-center justify-center gap-2 rounded-xl bg-forest py-2.5 text-[13px] font-bold text-white"
                >
                  Voir l'offre <ArrowRight className="size-4" />
                </Link>
              </div>
            ))}
          </div>
        )}

        <div className="mt-3 flex items-center gap-2 text-[12px] text-ink-soft">
          <Info className="size-4 shrink-0" />
          {useReal
            ? "Seules les informations annoncées par les sources sont affichées."
            : "Informations telles qu'annoncées par les sources. (Écran de démonstration)"}
        </div>
      </div>
    </main>
  );
}

function Row({
  label,
  value,
  good,
}: {
  label: string;
  value: string;
  good: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-1 border-b border-line py-1.5 text-[11px] last:border-0">
      <span className="shrink-0 text-ink-soft">{label}</span>
      <span
        className={`truncate text-right font-bold ${
          good ? "text-forest" : "text-carrot-ink"
        }`}
      >
        {value}
      </span>
    </div>
  );
}