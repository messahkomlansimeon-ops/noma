"use client";

import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { SessionGate, useUnauthorizedRedirect } from "@/components/session-gate";
import { Thumb } from "@/components/thumb";
import { TopBar } from "@/components/top-bar";
import { Badge } from "@/components/ui";
import { BoostSection } from "@/components/vendor/boost-section";
import { InterestedBuyers } from "@/components/vendor/interested-buyers";
import { OfferStatsSection } from "@/components/vendor/offer-stats";
import { ApiError, api, describeApiError, isUuid, type OfferRecord } from "@/lib/client/api";
import {
  OFFER_STATUS_VIEW,
  artForCategory,
  formatMoney,
  offerSummary,
  recordTitle,
} from "@/lib/client/catalog-view";

/** Une annonce du vendeur : acheteurs intéressés (sans identité) et devis de boost (sans paiement). */
function Annonce({ offerId }: { offerId: string }) {
  const redirectIfUnauthorized = useUnauthorizedRedirect();
  const [offer, setOffer] = useState<OfferRecord | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    api.offers.get(offerId, { signal: controller.signal }).then(
      (loaded) => {
        setOffer(loaded);
        setLoadError(null);
      },
      (failure) => {
        if (controller.signal.aborted || redirectIfUnauthorized(failure)) return;
        setLoadError(
          failure instanceof ApiError && failure.status === 404
            ? "Annonce introuvable : elle n'existe pas ou n'est pas à vous."
            : describeApiError(failure, "catalog"),
        );
      },
    );
    return () => controller.abort();
  }, [offerId, reloadKey, redirectIfUnauthorized]);

  if (loadError) {
    return (
      <div role="alert" className="mt-4 rounded-2xl border border-line bg-white p-4 text-center">
        <p className="text-[14px] font-semibold text-ink">{loadError}</p>
        <button
          onClick={() => {
            setLoadError(null);
            setReloadKey((key) => key + 1);
          }}
          className="mt-3 rounded-xl bg-forest px-5 py-2.5 text-[14px] font-bold text-white"
        >
          Réessayer
        </button>
      </div>
    );
  }
  if (!offer) {
    return (
      <p className="mt-6 text-center text-[14px] text-ink-soft" aria-busy="true">
        Chargement de l'annonce…
      </p>
    );
  }

  const status = OFFER_STATUS_VIEW[offer.status];
  const price = formatMoney(offer.price);
  const summary = offerSummary(offer);
  return (
    <>
      <div className="rounded-2xl border border-line bg-white p-3.5">
        <div className="flex items-center gap-3">
          <Thumb art={artForCategory(offer.category)} className="size-14" iconClassName="size-7" />
          <div className="min-w-0 flex-1">
            <div className="text-[15px] font-bold text-ink">{recordTitle(offer)}</div>
            {price ? (
              <div className="font-display text-[18px] font-extrabold text-ink">{price}</div>
            ) : (
              <div className="text-[13px] text-ink-soft">Prix à compléter</div>
            )}
            <div className="mt-1">
              <Badge tone={status.tone}>{status.label}</Badge>
            </div>
          </div>
        </div>
        {summary ? <div className="mt-1.5 text-[12px] text-ink-soft">{summary}</div> : null}
      </div>

      <InterestedBuyers offer={offer} />
      <OfferStatsSection offer={offer} />
      <BoostSection offer={offer} onOfferChanged={() => setReloadKey((key) => key + 1)} />
    </>
  );
}

function PageContent() {
  const params = useParams<{ id: string }>();
  const offerId = typeof params.id === "string" ? params.id : "";
  return (
    <main>
      <TopBar back="/vendeur/annonces" title="Mon annonce" />
      <div className="px-4 pb-6">
        {isUuid(offerId) ? (
          <Annonce offerId={offerId} />
        ) : (
          <p role="alert" className="mt-6 text-center text-[14px] font-semibold text-ink">
            Annonce introuvable.
          </p>
        )}
      </div>
    </main>
  );
}

export default function AnnonceDetailPage() {
  return (
    <SessionGate>
      <PageContent />
    </SessionGate>
  );
}
