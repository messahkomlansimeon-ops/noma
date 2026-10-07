"use client";

import { useEffect, useState } from "react";
import { useUnauthorizedRedirect } from "@/components/session-gate";
import { SALES_NOTE, SALES_TITLE, salesView } from "@/lib/client/orders-view";
import { describeSocialError, social, type OfferSales } from "@/lib/client/social-api";

/**
 * « Ventes déclarées et confirmées » (lot D2) : les ventes que le vendeur a confirmées pour CETTE annonce, arrondies comme toutes les mesures (« moins de 5 », « environ N »),
 * avec la part attribuée au boost et la part organique quand l'annonce a eu un boost. Jamais d'identité d'acheteur, jamais de compte exact.
 */
export function OfferSalesSection({ offerId }: { offerId: string }) {
  const redirectIfUnauthorized = useUnauthorizedRedirect();
  const [sales, setSales] = useState<OfferSales | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    social.orders.sales(offerId, { signal: controller.signal }).then(
      (loaded) => {
        setSales(loaded);
        setError(null);
      },
      (failure) => {
        if (controller.signal.aborted || redirectIfUnauthorized(failure)) return;
        setError(describeSocialError(failure, "order"));
      },
    );
    return () => controller.abort();
  }, [offerId, redirectIfUnauthorized]);

  const view = sales === null ? null : salesView(sales);
  return (
    <section aria-labelledby="sales-title" className="mt-5" data-testid="offer-sales">
      <h2 id="sales-title" className="text-[16px] font-extrabold text-ink">
        {SALES_TITLE}
      </h2>
      {error ? (
        <p role="alert" className="mt-2 text-[13px] font-semibold text-carrot-ink">
          {error}
        </p>
      ) : view === null ? (
        <p className="mt-2 text-[13px] text-ink-soft" aria-busy="true">
          Chargement…
        </p>
      ) : (
        <dl className="mt-2 divide-y divide-line rounded-2xl border border-line bg-white px-3.5 py-0.5">
          <div className="flex items-start justify-between gap-4 py-2 text-[13px]" data-stat="sales-confirmed">
            <dt className="text-ink-soft">Ventes confirmées</dt>
            <dd className="text-right font-semibold text-ink" data-stat-value>
              {view.total}
            </dd>
          </div>
          {view.split ? (
            <>
              <div className="flex items-start justify-between gap-4 py-2 text-[13px]" data-stat="sales-boost">
                <dt className="text-ink-soft">dont attribuées au boost</dt>
                <dd className="text-right font-semibold text-ink" data-stat-value>
                  {view.split.boost}
                </dd>
              </div>
              <div className="flex items-start justify-between gap-4 py-2 text-[13px]" data-stat="sales-organic">
                <dt className="text-ink-soft">dont organiques</dt>
                <dd className="text-right font-semibold text-ink" data-stat-value>
                  {view.split.organic}
                </dd>
              </div>
            </>
          ) : null}
        </dl>
      )}
      <p className="mt-1.5 text-[11px] leading-relaxed text-ink-soft">{SALES_NOTE}</p>
    </section>
  );
}
