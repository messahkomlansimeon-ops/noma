"use client";

import { useEffect, useState } from "react";
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
    <div data-testid="market-listings" data-published={view.published ? "true" : "false"} className="rounded-xl bg-wash px-3 py-2.5">
      <div className="text-[12px] font-semibold uppercase tracking-wide text-ink-soft">{view.title}</div>
      {view.published ? (
        <>
          <div className="font-display text-[20px] font-extrabold leading-tight text-ink">
            <span className="text-[12px] font-semibold text-ink-soft">Médiane </span>
            <span data-testid="market-listings-median">{view.headline}</span>
          </div>
          {view.range ? (
            <div data-testid="market-listings-range" className="text-[12px] text-ink">
              {view.range}
            </div>
          ) : (
            <div data-testid="market-listings-range-note" className="text-[12px] text-ink-soft">
              {view.rangeNote}
            </div>
          )}
          <div data-testid="market-listings-count" className="text-[12px] text-ink-soft">
            {view.countText}
          </div>
          {view.excludedText ? (
            <div data-testid="market-listings-excluded" className="text-[12px] text-ink-soft">
              {view.excludedText}
            </div>
          ) : null}
          <div data-testid="market-listings-compared" data-widened={view.widened ? "true" : "false"} className={`text-[12px] ${view.widened ? "font-semibold text-carrot-ink" : "text-ink-soft"}`}>
            {view.comparedTo}
          </div>
          {view.trendSummary ? <Sparkline trend={view.trend} label={view.trendSummary} testId="market-listings-trend" /> : null}
          {view.trendSummary ? <div className="text-[11px] text-ink-soft">{view.trendSummary}</div> : null}
        </>
      ) : (
        <div data-testid="market-listings-insufficient" className="text-[13px] text-ink-soft">
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
    <section aria-labelledby="market-title" data-testid="market-card" data-state={view === null ? "loading" : view.empty ? "empty" : "ready"} className="mt-5 rounded-2xl border border-line bg-white p-4">
      <h2 id="market-title" className="text-[15px] font-extrabold text-ink">
        {MARKET_CARD_TITLE}
      </h2>
      <div role="group" aria-label="Période" className="mt-2 flex gap-2">
        {MARKET_PERIOD_CHOICES.map((choice) => (
          <button
            key={choice.days}
            type="button"
            onClick={() => setDays(choice.days)}
            aria-pressed={days === choice.days}
            data-testid={`market-period-${choice.days}`}
            className={`rounded-full border px-3 py-1 text-[12px] font-semibold ${days === choice.days ? "border-transparent bg-forest text-white" : "border-line bg-white text-ink"}`}
          >
            {choice.label}
          </button>
        ))}
      </div>
      {view === null ? (
        <p className="mt-3 text-[13px] text-ink-soft" aria-busy="true">
          {MARKET_LOADING_TEXT}
        </p>
      ) : (
        <>
          <p data-testid="market-period" className="mt-3 text-[12px] font-semibold text-ink-soft">
            {view.periodText}
          </p>
          <div className="mt-2 grid gap-2.5">
            <ListingsBlock view={view.listings} />
          </div>
          <p data-testid="market-asking-note" className="mt-2 text-[12px] font-semibold text-ink">
            {view.askingNote}
          </p>
          <p data-testid="market-note" className="mt-1 text-[11px] leading-relaxed text-ink-soft">
            {view.note}
          </p>
        </>
      )}
    </section>
  );
}
