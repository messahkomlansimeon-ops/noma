"use client";

import { Info, TrendingUp } from "lucide-react";
import { useEffect, useState } from "react";
import { IconTile, Skeleton } from "@/components/ui";
import { useUnauthorizedRedirect } from "@/components/session-gate";
import { Sparkline } from "@/components/market/sparkline";
import { describeMarketError, market, type MarketPeriodDays, type MarketQuery, type MarketStats } from "@/lib/client/market-api";
import {
  MARKET_CARD_TITLE,
  MARKET_INSUFFICIENT_TEXT,
  MARKET_LOADING_TEXT,
  MARKET_PERIOD_CHOICES,
  marketCardView,
  type ListingsView,
} from "@/lib/client/market-view";

function ListingsBlock({ view }: { view: ListingsView }) {
  return (
    <div data-testid="market-listings" data-published={view.published ? "true" : "false"} className="rounded-2xl bg-mist px-4 py-3">
      <div className="text-[13px] font-semibold uppercase tracking-wide text-ink-soft">{view.title}</div>
      {view.published ? (
        <>
          <div className="mt-0.5 flex items-baseline gap-1.5 text-[24px] font-extrabold leading-tight text-ink">
            <span className="text-[13px] font-semibold text-ink-soft">Médiane </span>
            <span data-testid="market-listings-median">{view.headline}</span>
          </div>
          {view.range ? (
            <div data-testid="market-listings-range" className="text-[14px] font-semibold text-ink">
              {view.range}
            </div>
          ) : (
            <div data-testid="market-listings-range-note" className="text-[13px] text-ink-soft">
              {view.rangeNote}
            </div>
          )}
          <div data-testid="market-listings-count" className="text-[13px] text-ink-soft">
            {view.countText}
          </div>
          {view.excludedText ? (
            <div data-testid="market-listings-excluded" className="text-[13px] text-ink-soft">
              {view.excludedText}
            </div>
          ) : null}
          <div data-testid="market-listings-compared" data-widened={view.widened ? "true" : "false"} className={`text-[13px] ${view.widened ? "font-semibold text-accent-ink" : "text-ink-soft"}`}>
            {view.comparedTo}
          </div>
          {view.trendSummary ? <Sparkline trend={view.trend} label={view.trendSummary} testId="market-listings-trend" /> : null}
          {view.trendSummary ? <div className="mt-1 text-[12px] text-ink-soft">{view.trendSummary}</div> : null}
        </>
      ) : (
        <div data-testid="market-listings-insufficient" className="mt-1 flex items-center gap-2 text-[14px] text-ink-soft">
          <Info className="size-4 shrink-0" aria-hidden />
          {MARKET_INSUFFICIENT_TEXT}
        </div>
      )}
    </div>
  );
}

/**
 * Encart « Prix demandés dans les annonces » (lots H1, H1-bis et H1-ter) : la médiane des prix DEMANDÉS dans les annonces en ligne pour CE produit, la fourchette (à partir de 10 vendeurs), l'effectif
 * arrondi, les annonces aux prix atypiques écartées, la période, la comparabilité (dite) et une mini-courbe. Lecture de GET /api/market ; aucun prix de vente (les ventes ne sont pas
 * publiées), aucun prix individuel, aucun minimum ni maximum. Une erreur du serveur ne casse jamais la fiche : l'encart est simplement absent.
 */
export function MarketCard({ query }: { query: MarketQuery }) {
  const redirectIfUnauthorized = useUnauthorizedRedirect();
  const [days, setDays] = useState<MarketPeriodDays>(90);
  const [stats, setStats] = useState<MarketStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { category, brand, model, variant, condition } = query;

  useEffect(() => {
    const controller = new AbortController();
    market.stats({ category, brand, model, variant, condition, periodDays: days }, { signal: controller.signal }).then(
      (loaded) => {
        setStats(loaded);
        setError(null);
      },
      (failure) => {
        if (controller.signal.aborted || redirectIfUnauthorized(failure)) return;
        setError(describeMarketError(failure));
      },
    );
    return () => controller.abort();
  }, [category, brand, model, variant, condition, days, redirectIfUnauthorized]);

  if (error !== null && stats === null) return null;
  const view = stats === null ? null : marketCardView(stats);
  return (
    <section aria-labelledby="market-title" data-testid="market-card" data-state={view === null ? "loading" : view.empty ? "empty" : "ready"} className="animate-rise mt-5 rounded-3xl border border-line bg-white p-4">
      <div className="flex items-center gap-3">
        <IconTile icon={TrendingUp} tone="info" />
        <h2 id="market-title" className="text-[16px] font-extrabold leading-snug text-ink">
          {MARKET_CARD_TITLE}
        </h2>
      </div>
      <div role="group" aria-label="Période" className="mt-3 flex flex-wrap gap-2">
        {MARKET_PERIOD_CHOICES.map((choice) => (
          <button
            key={choice.days}
            type="button"
            onClick={() => setDays(choice.days)}
            aria-pressed={days === choice.days}
            data-testid={`market-period-${choice.days}`}
            className={`press min-h-11 rounded-full border-2 px-4 text-[14px] font-semibold ${days === choice.days ? "border-transparent bg-brand text-white" : "border-line bg-white text-ink hover:border-line-strong"}`}
          >
            {choice.label}
          </button>
        ))}
      </div>
      {view === null ? (
        <div className="mt-3" aria-busy="true">
          <span className="sr-only">{MARKET_LOADING_TEXT}</span>
          <Skeleton className="h-28 w-full rounded-2xl" />
        </div>
      ) : (
        <>
          <p data-testid="market-period" className="mt-3 text-[13px] font-semibold text-ink-soft">
            {view.periodText}
          </p>
          <div className="mt-2 grid gap-2.5">
            <ListingsBlock view={view.listings} />
          </div>
          <p data-testid="market-asking-note" className="mt-3 text-[13px] font-semibold text-ink">
            {view.askingNote}
          </p>
          <p data-testid="market-note" className="mt-1 text-[13px] leading-relaxed text-ink-soft">
            {view.note}
          </p>
        </>
      )}
    </section>
  );
}
