"use client";

import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { useUnauthorizedRedirect } from "@/components/session-gate";
import { api, describeApiError, type OfferRecord, type OfferStats, type StatsPeriodCode } from "@/lib/client/api";
import { durationLabel } from "@/lib/client/boost-view";
import {
  FEW_STATS_YET,
  PERIOD_LABELS,
  boostStatsView,
  offerStatsView,
  type StatLine,
} from "@/lib/client/metrics-view";

const PERIODS: readonly StatsPeriodCode[] = ["7d", "30d", "all"];

function Lines({ lines, testId }: { lines: StatLine[]; testId: string }) {
  return (
    <dl className="mt-2 divide-y divide-line rounded-2xl border border-line bg-white px-3.5 py-0.5" data-testid={testId}>
      {lines.map((line) => (
        <div key={line.key} className="flex items-start justify-between gap-4 py-2 text-[13px]" data-stat={line.key}>
          <dt className="text-ink-soft">
            {line.label}
            {line.hint ? <span className="block text-[11px] text-ink-soft/80">{line.hint}</span> : null}
          </dt>
          <dd className="max-w-[55%] break-words text-right font-semibold text-ink" data-stat-value>
            {line.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * « Ce que produit votre annonce » : apparitions, ouvertures, contacts et taux sur 7 jours, 30 jours et depuis la publication,
 * puis par boost, avec la part attribuée au boost et la part organique. AUCUNE identité d'acheteur, AUCUN compte exact : « moins de 5 » de 0 à 4, sinon « environ 15 »
 * (le serveur n'envoie pas le nombre exact), et un pourcentage s'affiche « environ 70 % » (arrondi à la dizaine, calculé sur les nombres publiés).
 */
export function OfferStatsSection({ offer }: { offer: OfferRecord }) {
  const redirectIfUnauthorized = useUnauthorizedRedirect();
  const [stats, setStats] = useState<OfferStats | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [period, setPeriod] = useState<StatsPeriodCode>("7d");
  const [reloadKey, setReloadKey] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const offerId = offer.id;

  useEffect(() => {
    const controller = new AbortController();
    api.offers.stats(offerId, { signal: controller.signal }).then(
      (loaded) => {
        setStats(loaded);
        setLoadError(null);
        setRefreshing(false);
      },
      (failure) => {
        if (controller.signal.aborted || redirectIfUnauthorized(failure)) return;
        setLoadError(describeApiError(failure, "stats"));
        setRefreshing(false);
      },
    );
    return () => controller.abort();
  }, [offerId, reloadKey, redirectIfUnauthorized]);

  const refresh = () => {
    if (refreshing) return;
    setLoadError(null);
    setRefreshing(true);
    setReloadKey((key) => key + 1);
  };

  const view = stats ? offerStatsView(stats) : null;
  const selected = view?.periods.find((entry) => entry.period === period) ?? view?.periods[0] ?? null;
  return (
    <section aria-labelledby="stats-title" className="mt-5" data-testid="offer-stats">
      <div className="flex items-center justify-between gap-3">
        <h2 id="stats-title" className="text-[16px] font-extrabold text-ink">
          Ce que produit votre annonce
        </h2>
        <button
          onClick={refresh}
          disabled={refreshing}
          className="flex items-center gap-1.5 rounded-full border border-line bg-white px-3 py-1.5 text-[13px] font-semibold text-ink disabled:opacity-50"
        >
          <RefreshCw className={`size-3.5 ${refreshing ? "animate-spin" : ""}`} aria-hidden />
          Actualiser
        </button>
      </div>

      {loadError ? (
        <div role="alert" className="mt-3 rounded-2xl border border-line bg-white p-4 text-center">
          <p className="text-[14px] font-semibold text-ink">{loadError}</p>
          <button onClick={refresh} className="mt-3 rounded-xl bg-forest px-5 py-2.5 text-[14px] font-bold text-white">
            Réessayer
          </button>
        </div>
      ) : !view || !selected ? (
        <p className="mt-3 text-[14px] text-ink-soft" aria-busy="true">
          Chargement des mesures…
        </p>
      ) : (
        <>
          <p className="mt-1 text-[14px] font-bold text-ink" data-testid="stats-matching">
            {view.matchingNeedsText}
          </p>
          {view.fewActivity ? (
            <p className="mt-1 text-[12px] font-semibold text-ink-soft" data-testid="stats-few">
              {FEW_STATS_YET}
            </p>
          ) : null}
          {view.noBoostText ? (
            <p className="mt-1 text-[12px] font-semibold text-ink-soft" data-testid="stats-no-boost">
              {view.noBoostText}
            </p>
          ) : null}

          <div className="mt-3 flex flex-wrap gap-2" role="tablist" aria-label="Période">
            {PERIODS.map((code) => (
              <button
                key={code}
                role="tab"
                aria-selected={code === selected.period}
                data-testid={`stats-period-${code}`}
                onClick={() => setPeriod(code)}
                className={`rounded-full border px-3 py-1.5 text-[12px] font-semibold transition ${
                  code === selected.period ? "border-transparent bg-forest text-white" : "border-line bg-white text-ink"
                }`}
              >
                {PERIOD_LABELS[code]}
              </button>
            ))}
          </div>
          <Lines lines={selected.lines} testId={`stats-lines-${selected.period}`} />

          {stats && stats.boosts.length > 0 ? (
            <div className="mt-4" data-testid="stats-boosts">
              <h3 className="text-[14px] font-extrabold text-ink">Par boost</h3>
              {stats.boosts.map((boost) => {
                const boostView = boostStatsView(boost, durationLabel(boost.durationCode));
                return (
                  <div key={boostView.key} className="mt-2" data-testid="stats-boost">
                    <div className="text-[13px] font-bold text-ink">{boostView.title}</div>
                    {boostView.note ? (
                      <p className="mt-2 text-[12px] text-ink-soft" data-testid="stats-boost-note">
                        {boostView.note}
                      </p>
                    ) : (
                      <Lines lines={boostView.lines} testId="stats-boost-lines" />
                    )}
                  </div>
                );
              })}
            </div>
          ) : null}

          <ul className="mt-4 space-y-1.5" data-testid="stats-notes">
            {view.notes.map((note) => (
              <li key={note} className="text-[12px] leading-relaxed text-ink-soft">
                {note}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
