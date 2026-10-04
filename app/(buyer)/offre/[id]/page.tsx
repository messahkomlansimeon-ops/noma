"use client";

import { useParams } from "next/navigation";
import { ExternalLink } from "lucide-react";
import { TopBar } from "@/components/top-bar";
import { OfferPhoto } from "@/components/real-offer-card";
import { Thumb } from "@/components/thumb";
import { Badge, Btn, BtnOutline, KvRow } from "@/components/ui";
import { allOffers, formatShort } from "@/lib/data";
import { formatPublicPrice } from "@/lib/contracts";
import { useRealSearch } from "@/lib/real-search";

export default function OffreDetail() {
  const { id } = useParams<{ id: string }>();
  const offers = useRealSearch((s) => s.offers);
  const hydrate = useRealSearch((s) => s.hydrate);
  const hydrated = useRealSearch((s) => s.hydrated);
  const need = useRealSearch((s) => s.need);

  // hydratation sans relance : les résultats < 30 min restent consultables
  if (!hydrated) {
    hydrate();
  }

  const realOffer = offers.find((o) => o.id === id);
  const demoOffer = allOffers.find((o) => o.id === id);

  // écran de démo : conservé tel quel (catalogue fictif, hors recherche réelle)
  if (demoOffer) {
    return <DemoDetail offerId={demoOffer.id} />;
  }

  if (!realOffer) {
    return (
      <main>
        <TopBar back="/recherche" title="Détail de l'offre" />
        <div className="px-4">
          <div className="mt-3 rounded-2xl bg-wash p-4 text-[14px] font-semibold text-ink-soft">
            Cette offre n'est pas dans vos résultats. Les résultats d'une
            recherche restent disponibles 30 minutes — relancez une recherche
            pour retrouver les annonces.
          </div>
          <div className="mt-4">
            <BtnOutline href="/recherche">Retour aux résultats</BtnOutline>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main>
      <TopBar back="/recherche" title="Détail de l'offre" />

      <div className="px-4">
        <Badge tone="sky">Annonce externe</Badge>

        <div className="mt-3 flex flex-col items-center overflow-hidden rounded-2xl bg-sage py-6">
          <OfferPhoto
            offer={realOffer}
            className={realOffer.photo ? "h-44 w-full max-w-[280px]" : "size-36 bg-transparent"}
            iconClassName="size-20"
          />
          {realOffer.photo ? (
            <div className="mt-3 px-4 text-center text-[11px] text-ink-soft">
              Photo de l'annonce source
            </div>
          ) : (
            <div className="mt-3 text-[11px] text-ink-soft">
              Pas de photo · vignette neutre
            </div>
          )}
        </div>

        <h1 className="mt-4 font-display text-[24px] font-extrabold leading-tight text-ink">
          {realOffer.title}
        </h1>
        <div className="font-display text-[30px] font-extrabold leading-tight text-ink">
          {formatPublicPrice(realOffer)}
        </div>
        <div className="text-[13px] text-ink-soft">
          {realOffer.price === null
            ? "La source n'annonce pas de prix"
            : `Prix annoncé · devise ${realOffer.currency} — aucune conversion`}
        </div>

        <div className="mt-3">
          <Badge tone="carrot">
            {realOffer.aiStatus === "évalué par IA"
              ? "Pertinence vérifiée par IA"
              : "Pertinence non vérifiée par IA"}
          </Badge>
        </div>

        <div className="mt-4 divide-y divide-line rounded-2xl border border-line bg-white px-4 py-1">
          <KvRow
            label="Localisation"
            value={realOffer.location ?? "Non renseignée"}
          />
          <KvRow label="Source" value={realOffer.source} />
          {realOffer.confirmed.length > 0 ? (
            <KvRow label="Informations confirmées" value={realOffer.confirmed.join(" · ")} />
          ) : (
            <KvRow label="Informations confirmées" value="Aucune" />
          )}
        </div>

        <div className="mt-4 rounded-2xl bg-sage p-4">
          <div className="text-[14px] font-extrabold text-forest">
            Pourquoi cette offre ?
          </div>
          <p className="mt-1 text-[13px] leading-relaxed text-sage-ink">
            {realOffer.justification}
          </p>
        </div>

        <div className="mt-4 space-y-2.5">
          {realOffer.url ? (
            <a
              href={realOffer.url}
              target="_blank"
              rel="noopener noreferrer nofollow"
              className="flex w-full items-center justify-center gap-2 rounded-xl bg-forest px-4 py-3.5 text-[15px] font-bold text-white transition active:scale-[0.99]"
            >
              Voir l'annonce d'origine
              <ExternalLink className="size-4" />
            </a>
          ) : (
            <div className="rounded-xl border border-line bg-white p-3.5 text-center text-[13px] font-semibold text-ink-soft">
              Lien de l'annonce source indisponible.
            </div>
          )}
        </div>

        <p className="mt-4 text-center text-[12px] leading-relaxed text-ink-soft">
          Informations telles qu'annoncées par la source — ni état, ni
          garantie, ni livraison, ni disponibilité inventés.
          {need.mode === "service" ? " Prestation : contactez le prestataire via son annonce." : ""}
        </p>
      </div>
    </main>
  );
}

function DemoDetail({ offerId }: { offerId: string }) {
  const offer = allOffers.find((o) => o.id === offerId)!;
  return (
    <main>
      <TopBar
        back="/recherche"
        title="Détail de l'offre"
        right={
          <span className="rounded-full bg-wash px-2 py-1 text-[11px] font-bold text-ink-soft">
            Démo
          </span>
        }
      />

      <div className="px-4">
        <Badge tone={offer.source === "noma" ? "sage" : "sky"}>
          {offer.source === "noma" ? "Catalogue Noma" : "Annonce externe"}
        </Badge>

        <div className="mt-3 flex flex-col items-center rounded-2xl bg-sage py-10">
          <Thumb art={offer.art} className="size-36 bg-transparent" iconClassName="size-24" />
          <div className="mt-3 text-[11px] text-ink-soft">
            Illustration · annonce fictive
          </div>
        </div>

        <h1 className="mt-4 font-display text-[24px] font-extrabold text-ink">
          {offer.title}
        </h1>
        <div className="font-display text-[30px] font-extrabold leading-tight text-ink">
          {formatShort(offer.price)} FCFA
        </div>
        <div className="text-[13px] text-ink-soft">
          Prix annoncé · livraison {offer.delivery.toLowerCase()}
        </div>

        <div className="mt-3">
          <Badge tone="carrot">Disponibilité à confirmer</Badge>
        </div>

        <div className="mt-4 divide-y divide-line rounded-2xl border border-line bg-white px-4 py-1">
          <KvRow label="État" value={offer.condition} />
          <KvRow label="Localisation" value={`${offer.zone}, ${offer.city}`} />
          <KvRow label="Garantie" value={offer.warranty} />
          <KvRow
            label="Source"
            value={offer.source === "noma" ? "Catalogue Noma" : "Site marchand externe"}
          />
          <KvRow label="Annonce consultée" value={offer.freshness} />
        </div>

        <div className="mt-4 rounded-2xl bg-sage p-4">
          <div className="text-[14px] font-extrabold text-forest">
            Pourquoi cette offre ?
          </div>
          <p className="mt-1 text-[13px] leading-relaxed text-sage-ink">
            Le modèle, le prix annoncé et la localisation correspondent à votre
            recherche.
          </p>
        </div>

        <div className="mt-4 space-y-2.5">
          <Btn href="https://example.com" className="[&_svg]:size-4">
            Voir l'annonce d'origine
            <ExternalLink />
          </Btn>
          <BtnOutline href={`/offre/${offer.id}/inviter`}>
            Inviter le vendeur sur Noma
          </BtnOutline>
        </div>

        <p className="mt-4 text-center text-[12px] leading-relaxed text-ink-soft">
          Le vendeur doit s'inscrire pour poursuivre sur Noma.
          <br />
          Le paiement se fait directement auprès de lui.
        </p>
      </div>
    </main>
  );
}