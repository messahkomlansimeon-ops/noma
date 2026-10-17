"use client";

import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { ExtractionCard } from "@/components/extraction/extraction-card";
import { PhotoManager } from "@/components/photos/photo-manager";
import { SessionGate, useUnauthorizedRedirect } from "@/components/session-gate";
import { Thumb } from "@/components/thumb";
import { TopBar } from "@/components/top-bar";
import { Badge } from "@/components/ui";
import { ErrorState, LoadingBlock } from "@/components/vendor/vendor-parts";
import { BoostSection } from "@/components/vendor/boost-section";
import { InterestedBuyers } from "@/components/vendor/interested-buyers";
import { OfferSalesSection } from "@/components/vendor/offer-sales";
import { OfferStatsSection } from "@/components/vendor/offer-stats";
import { ApiError, api, describeApiError, isUuid, type OfferRecord } from "@/lib/client/api";
import type { OfferPhoto } from "@/lib/client/photos-api";
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
  const [coverId, setCoverId] = useState<string | null>(null);
  const onPhotosChanged = useCallback((photos: OfferPhoto[]) => setCoverId(photos.find((photo) => photo.position === 0)?.id ?? null), []);

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
      <ErrorState
        message={loadError}
        onRetry={() => {
          setLoadError(null);
          setReloadKey((key) => key + 1);
        }}
      />
    );
  }
  if (!offer) {
    return <LoadingBlock label="Chargement de l'annonce…" className="pt-2" />;
  }

  const status = OFFER_STATUS_VIEW[offer.status];
  const price = formatMoney(offer.price);
  const summary = offerSummary(offer);
  return (
    <div className="stagger flex flex-col gap-6 pt-2">
      <div className="rounded-3xl border border-line bg-white p-4">
        <div className="flex items-center gap-3.5">
          <Thumb art={artForCategory(offer.category)} className="size-20" iconClassName="size-10" photoId={coverId} />
          <div className="min-w-0 flex-1">
            <div className="text-[17px] font-bold leading-snug text-ink">{recordTitle(offer)}</div>
            {price ? (
              <div className="text-[24px] font-extrabold leading-tight text-ink">{price}</div>
            ) : (
              <div className="text-[14px] font-semibold text-accent-ink">Prix à compléter</div>
            )}
            <div className="mt-1.5">
              <Badge tone={status.tone}>{status.label}</Badge>
            </div>
          </div>
        </div>
        {summary ? <div className="mt-2 text-[13px] text-ink-soft">{summary}</div> : null}
      </div>

      <PhotoManager offerId={offer.id} readOnly={offer.status === "archived"} onChange={onPhotosChanged} />
      <ExtractionCard kind="offers" record={offer} onChanged={() => setReloadKey((key) => key + 1)} />
      <InterestedBuyers offer={offer} />
      <OfferStatsSection offer={offer} />
      <OfferSalesSection offerId={offer.id} />
      <BoostSection offer={offer} onOfferChanged={() => setReloadKey((key) => key + 1)} />
    </div>
  );
}

function PageContent() {
  const params = useParams<{ id: string }>();
  const offerId = typeof params.id === "string" ? params.id : "";
  return (
    <main>
      <TopBar back="/vendeur/annonces" title="Mon annonce" />
      <div className="px-4 pb-6">
        {isUuid(offerId) ? <Annonce offerId={offerId} /> : <ErrorState message="Annonce introuvable." />}
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
