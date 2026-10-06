"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui";
import { useUnauthorizedRedirect } from "@/components/session-gate";
import {
  ApiError,
  api,
  describeApiError,
  type BoostDurationCode,
  type BoostQuote,
  type OfferRecord,
} from "@/lib/client/api";
import {
  BOOST_DURATIONS,
  BOOST_INTRO,
  boostEligibility,
  buyButtonState,
  durationLabel,
  explainFactors,
  quoteAmountText,
  quoteHistoryRow,
  quoteValidity,
  unavailableReasonText,
} from "@/lib/client/boost-view";

const HISTORY_LIMIT = 10;

/**
 * « Booster cette annonce » : choix de la durée → devis de prix (POST boost-quotes), explication des facteurs, validité
 * (compte à rebours) et historique. AUCUN paiement : le bouton « Acheter » est désactivé, aucun appel de paiement n'existe.
 */
export function BoostSection({ offer, onOfferChanged }: { offer: OfferRecord; onOfferChanged: () => void }) {
  const redirectIfUnauthorized = useUnauthorizedRedirect();
  const eligibility = boostEligibility(offer);
  const offerId = offer.id;
  const [quote, setQuote] = useState<BoostQuote | null>(null);
  const [pending, setPending] = useState<BoostDurationCode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<BoostQuote[] | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyKey, setHistoryKey] = useState(0);
  // Horloge de l'écran (compte à rebours) : remise à l'heure à la réception de chaque devis ou historique (jamais l'heure
  // d'il y a plusieurs secondes), puis une mise à jour par seconde tant qu'un devis est affiché.
  const [now, setNow] = useState(() => Date.now());
  const ticking = quote !== null || (history?.length ?? 0) > 0;
  const eligible = eligibility.eligible;

  useEffect(() => {
    if (!ticking) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [ticking]);

  useEffect(() => {
    if (!eligible) return;
    const controller = new AbortController();
    api.boostQuotes.list(offerId, { limit: HISTORY_LIMIT }, { signal: controller.signal }).then(
      (quotes) => {
        setNow(Date.now());
        setHistory(quotes);
        setHistoryError(null);
      },
      (failure) => {
        if (controller.signal.aborted || redirectIfUnauthorized(failure)) return;
        setHistoryError(describeApiError(failure, "boost"));
      },
    );
    return () => controller.abort();
  }, [offerId, eligible, historyKey, redirectIfUnauthorized]);

  const request = useCallback(
    async (durationCode: BoostDurationCode) => {
      if (pending) return;
      setPending(durationCode);
      setError(null);
      try {
        const created = await api.boostQuotes.create(offerId, durationCode);
        setNow(Date.now());
        setQuote(created);
        setHistoryKey((key) => key + 1);
      } catch (failure) {
        if (redirectIfUnauthorized(failure)) return;
        setError(describeApiError(failure, "boost"));
        // Annonce disparue ou plus éligible : l'écran affichait un état périmé.
        if (failure instanceof ApiError && (failure.status === 404 || failure.status === 409)) onOfferChanged();
      } finally {
        setPending(null);
      }
    },
    [offerId, pending, onOfferChanged, redirectIfUnauthorized],
  );

  const buy = buyButtonState();

  return (
    <section aria-labelledby="boost-title" className="mt-6">
      <h2 id="boost-title" className="text-[16px] font-extrabold text-ink">
        Booster cette annonce
      </h2>

      {!eligibility.eligible ? (
        <p role="status" data-testid="boost-not-eligible" className="mt-3 rounded-2xl bg-wash p-4 text-[14px] font-semibold text-ink-soft">
          {eligibility.message}
        </p>
      ) : (
        <>
          <p className="mt-1 text-[13px] text-ink-soft">{BOOST_INTRO}</p>

          <div className="mt-3 flex gap-2" role="group" aria-label="Durée du boost">
            {BOOST_DURATIONS.map((duration) => {
              const selected = quote?.durationCode === duration.code;
              return (
                <button
                  key={duration.code}
                  onClick={() => void request(duration.code)}
                  disabled={pending !== null}
                  aria-pressed={selected}
                  className={`flex-1 rounded-xl border px-3 py-2.5 text-[14px] font-bold transition disabled:opacity-50 ${
                    selected ? "border-transparent bg-forest text-white" : "border-line bg-white text-ink"
                  }`}
                >
                  {pending === duration.code ? "…" : duration.label}
                </button>
              );
            })}
          </div>

          {error ? (
            <p role="alert" className="mt-3 text-[13px] font-semibold text-carrot-ink">
              {error}
            </p>
          ) : null}

          {quote ? <QuoteCard quote={quote} now={now} busy={pending !== null} onRefresh={() => void request(quote.durationCode)} buy={buy} /> : null}

          {historyError ? (
            <p role="alert" className="mt-4 text-[13px] font-semibold text-carrot-ink">
              {historyError}
            </p>
          ) : null}
          {history && history.length > 0 ? (
            <div className="mt-5" data-testid="boost-history">
              <h3 className="text-[14px] font-extrabold text-ink">Historique des devis</h3>
              <ul className="mt-2 divide-y divide-line rounded-2xl border border-line bg-white">
                {history.map((entry) => {
                  const row = quoteHistoryRow(entry, now);
                  return (
                    <li key={row.key} className="flex items-start justify-between gap-3 px-3.5 py-2.5">
                      <div>
                        <div className="text-[14px] font-bold text-ink">{row.title}</div>
                        <div className="text-[12px] text-ink-soft">{row.detail}</div>
                      </div>
                      <Badge tone={row.tone === "good" ? "sage" : row.tone === "warn" ? "carrot" : "wash"}>{row.status}</Badge>
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}

function QuoteCard({
  quote,
  now,
  busy,
  onRefresh,
  buy,
}: {
  quote: BoostQuote;
  now: number;
  busy: boolean;
  onRefresh: () => void;
  buy: ReturnType<typeof buyButtonState>;
}) {
  const validity = quoteValidity(quote, now);
  const amount = quoteAmountText(quote);
  return (
    <div data-testid="boost-quote" data-status={quote.status} className="mt-4 rounded-2xl border border-line bg-white p-4">
      {quote.status === "available" && amount ? (
        <>
          <div className="text-[13px] font-semibold text-ink-soft">Boost de {durationLabel(quote.durationCode)}</div>
          <div data-testid="boost-amount" className="font-display text-[30px] font-extrabold leading-tight text-ink">
            {amount}
          </div>
          <ul className="mt-3 space-y-2" aria-label="Comment ce prix est calculé">
            {explainFactors(quote).map((line) => (
              <li key={line.key} className="text-[13px]">
                <span className="font-bold text-ink">{line.title}</span>
                <span className="text-ink-soft"> : {line.text} </span>
                <span className="font-semibold text-forest">({line.effect})</span>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <>
          <div className="text-[13px] font-semibold text-ink-soft">Boost de {durationLabel(quote.durationCode)}</div>
          <p data-testid="boost-unavailable" className="mt-1 rounded-xl bg-carrot-soft p-3 text-[14px] font-semibold text-carrot-ink">
            {unavailableReasonText(quote.unavailableReason)}
          </p>
        </>
      )}

      <p data-testid="boost-validity" className={`mt-3 text-[13px] font-semibold ${validity.expired ? "text-carrot-ink" : "text-ink"}`}>
        {validity.text}
      </p>
      {validity.expired ? (
        <button
          onClick={onRefresh}
          disabled={busy}
          className="mt-2 rounded-xl border border-forest/30 bg-white px-4 py-2 text-[13px] font-bold text-forest disabled:opacity-50"
        >
          Demander un nouveau devis
        </button>
      ) : null}

      {quote.status === "available" ? (
        <div className="mt-4">
          <button
            disabled={buy.disabled}
            aria-disabled={buy.disabled}
            className="flex w-full cursor-not-allowed items-center justify-center rounded-xl bg-forest px-4 py-3.5 text-[15px] font-bold text-white opacity-40"
          >
            {buy.label}
          </button>
          <p data-testid="boost-buy-note" className="mt-1.5 text-center text-[12px] font-semibold text-ink-soft">
            {buy.note}
          </p>
        </div>
      ) : null}
    </div>
  );
}
