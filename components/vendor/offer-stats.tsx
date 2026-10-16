"use client";

import { useEffect, useState } from "react";
import { BarChart3, RefreshCw, ShieldCheck, Zap } from "lucide-react";
import { useUnauthorizedRedirect } from "@/components/session-gate";
import { ErrorState, LINK_ACTION, LoadingBlock, Notice, SectionHeading } from "@/components/vendor/vendor-parts";
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
    <dl className="mt-3 grid grid-cols-2 gap-2.5 md:grid-cols-3" data-testid={testId}>
      {lines.map((line) => (
        <div key={line.key} className="animate-pop flex flex-col-reverse justify-end gap-1 rounded-3xl border border-line bg-white p-3.5" data-stat={line.key}>
          <dt className="text-[13px] font-semibold leading-tight text-ink-soft">
            {line.label}
            {line.hint ? <span className="block text-[12px] font-normal text-ink-soft/80">{line.hint}</span> : null}
          </dt>
          <dd className="break-words text-[20px] font-extrabold leading-tight text-ink" data-stat-value>
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
    <section aria-labelledby="stats-title" data-testid="offer-stats">
      <SectionHeading
        icon={BarChart3}
        id="stats-title"
        aside={
          <button onClick={refresh} disabled={refreshing} className={`${LINK_ACTION} border border-line bg-white`}>
            <RefreshCw className={`size-4 ${refreshing ? "animate-spin" : ""}`} aria-hidden />
            Actualiser
          </button>
        }
      >
        Ce que produit votre annonce
      </SectionHeading>

      {loadError ? (
        <ErrorState message={loadError} onRetry={refresh} />
      ) : !view || !selected ? (
        <LoadingBlock label="Chargement des mesures…" rows={2} rowClassName="h-24 w-full rounded-3xl" className="mt-3" />
      ) : (
        <>
          {view.fewActivity ? (
            <Notice tone="mist" className="mt-3" data-testid="stats-few">
              {FEW_STATS_YET}
            </Notice>
          ) : null}
          {view.noBoostText ? (
            <Notice tone="mist" icon={Zap} className="mt-3" data-testid="stats-no-boost">
              {view.noBoostText}
            </Notice>
          ) : null}

          <div className="mt-3 flex flex-wrap gap-2" role="tablist" aria-label="Période">
            {PERIODS.map((code) => (
              <button
                key={code}
                role="tab"
                aria-selected={code === selected.period}
                data-testid={`stats-period-${code}`}
                onClick={() => setPeriod(code)}
                className={`press min-h-11 rounded-full border-2 px-4 text-[14px] font-semibold ${
                  code === selected.period ? "border-transparent bg-brand text-white" : "border-line bg-white text-ink hover:border-line-strong"
                }`}
              >
                {PERIOD_LABELS[code]}
              </button>
            ))}
          </div>
          <Lines lines={selected.lines} testId={`stats-lines-${selected.period}`} />

          {stats && stats.boosts.length > 0 ? (
            <div className="mt-5" data-testid="stats-boosts">
              <SectionHeading icon={Zap} level={3}>
                Par boost
              </SectionHeading>
              {stats.boosts.map((boost) => {
                const boostView = boostStatsView(boost, durationLabel(boost.durationCode));
                return (
                  <div key={boostView.key} className="mt-3" data-testid="stats-boost">
                    <div data-testid="stats-boost-title" className="text-[15px] font-bold text-ink">{boostView.title}</div>
                    {boostView.note ? (
                      <Notice tone="mist" className="mt-2" data-testid="stats-boost-note">
                        {boostView.note}
                      </Notice>
                    ) : (
                      <Lines lines={boostView.lines} testId="stats-boost-lines" />
                    )}
                  </div>
                );
              })}
            </div>
          ) : null}

          <div className="mt-4 flex items-start gap-2.5 rounded-2xl bg-info-soft px-3.5 py-3 text-info-ink">
            <ShieldCheck className="mt-0.5 size-5 shrink-0" aria-hidden />
            <ul className="space-y-1.5" data-testid="stats-notes">
              {view.notes.map((note) => (
                <li key={note} className="text-[13px] leading-snug">
                  {note}
                </li>
              ))}
            </ul>
          </div>
        </>
      )}
    </section>
  );
}
