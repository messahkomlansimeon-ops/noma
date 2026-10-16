"use client";

import { useEffect, useState } from "react";
import { ShieldCheck, ShoppingBag } from "lucide-react";
import { useUnauthorizedRedirect } from "@/components/session-gate";
import { ErrorState, LoadingBlock, Notice, SectionHeading } from "@/components/vendor/vendor-parts";
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
  const tile = "animate-pop flex flex-col-reverse justify-end gap-1 rounded-3xl border border-line bg-white p-3.5";
  return (
    <section aria-labelledby="sales-title" data-testid="offer-sales">
      <SectionHeading icon={ShoppingBag} id="sales-title">
        {SALES_TITLE}
      </SectionHeading>
      {error ? (
        <ErrorState message={error} />
      ) : view === null ? (
        <LoadingBlock label="Chargement…" rows={1} rowClassName="h-20 w-full rounded-3xl" className="mt-3" />
      ) : (
        <dl className="mt-3 grid grid-cols-2 gap-2.5 md:grid-cols-3">
          <div className={`${tile} col-span-2 md:col-span-1`} data-stat="sales-confirmed">
            <dt className="text-[13px] font-semibold leading-tight text-ink-soft">Ventes confirmées</dt>
            <dd className="text-[24px] font-extrabold leading-tight text-ink" data-stat-value>
              {view.total}
            </dd>
          </div>
          {view.split ? (
            <>
              <div className={tile} data-stat="sales-boost">
                <dt className="text-[13px] font-semibold leading-tight text-ink-soft">dont attribuées au boost</dt>
                <dd className="text-[20px] font-extrabold leading-tight text-ink" data-stat-value>
                  {view.split.boost}
                </dd>
              </div>
              <div className={tile} data-stat="sales-organic">
                <dt className="text-[13px] font-semibold leading-tight text-ink-soft">dont organiques</dt>
                <dd className="text-[20px] font-extrabold leading-tight text-ink" data-stat-value>
                  {view.split.organic}
                </dd>
              </div>
            </>
          ) : null}
        </dl>
      )}
      <Notice tone="info" icon={ShieldCheck} className="mt-3" small>
        {SALES_NOTE}
      </Notice>
    </section>
  );
}
