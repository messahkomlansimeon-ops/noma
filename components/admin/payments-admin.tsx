"use client";

import { useState } from "react";
import { describeSocialError } from "@/lib/client/social-api";
import { paymentsAdminApi, type PaymentsOverview } from "@/lib/client/payments-admin-api";
import { ANOMALY_EXPLANATION, PAYMENTS_TITLE, WAVE_ONLY_NOTE, anomalyRow, catchupText, intentRow, providerStateText, webhooksText } from "@/lib/client/payments-admin-view";
import { formatDateFr } from "@/lib/client/wallet-view";

/**
 * Administration des paiements (lot PAY1) : intentions récentes, anomalies de rapprochement à traiter (on les marque traitées après vérification chez Sublymus), état du
 * rattrapage et des webhooks. AUCUNE donnée personnelle : ni propriétaire, ni téléphone, ni identifiant de payeur.
 */
export function PaymentsAdmin({ overview, reload }: { overview: PaymentsOverview; reload: () => void }) {
  const [pending, setPending] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const catchup = catchupText(overview.catchup);

  const resolve = async (anomalyId: string) => {
    if (pending) return;
    setPending(anomalyId);
    setMessage(null);
    try {
      await paymentsAdminApi.adminPayments.resolveAnomaly(anomalyId);
      reload();
    } catch (failure) {
      setMessage(describeSocialError(failure, "admin"));
    } finally {
      setPending(null);
    }
  };

  const openAnomalies = overview.anomalies.filter((anomaly) => anomaly.resolvedAt === null);
  const closedAnomalies = overview.anomalies.filter((anomaly) => anomaly.resolvedAt !== null);
  return (
    <div data-testid="admin-payments">
      <h1 className="font-display text-[22px] font-extrabold text-ink">{PAYMENTS_TITLE}</h1>
      <p data-testid="admin-payments-provider" data-provider={overview.provider} className="mt-1 text-[13px] font-semibold text-ink">{providerStateText(overview.provider)}</p>
      <p className="mt-1 rounded-lg bg-sage px-3 py-2 text-[12px] font-semibold text-forest">{WAVE_ONLY_NOTE}</p>
      <p className="mt-1 text-[12px] text-ink-soft">Lu le {formatDateFr(overview.readAt)}</p>

      <section aria-labelledby="payments-anomalies" className="mt-4 rounded-2xl border border-line bg-white p-4">
        <h2 id="payments-anomalies" className="text-[15px] font-extrabold text-ink">
          Anomalies à traiter <span data-testid="admin-payments-open-count" className="font-display">({overview.openAnomalies})</span>
        </h2>
        <p className="mt-1 text-[12px] text-ink-soft">{ANOMALY_EXPLANATION}</p>
        {message ? <p role="alert" className="mt-2 rounded-lg bg-carrot-soft px-3 py-2 text-[12px] font-semibold text-carrot-ink">{message}</p> : null}
        {openAnomalies.length === 0 ? (
          <p data-testid="admin-payments-no-anomaly" className="mt-3 text-[13px] font-semibold text-forest">Aucune anomalie à traiter.</p>
        ) : (
          <ul className="mt-3 divide-y divide-line">
            {openAnomalies.map((anomaly) => {
              const row = anomalyRow(anomaly);
              return (
                <li key={anomaly.id} data-testid="admin-payments-anomaly" data-kind={anomaly.kind} className="py-2.5">
                  <div className="text-[13px] font-bold text-ink">{row.title}</div>
                  <div className="text-[12px] text-ink-soft">{row.detail}</div>
                  <button
                    data-testid="admin-payments-resolve"
                    onClick={() => void resolve(anomaly.id)}
                    disabled={pending !== null}
                    className="mt-1.5 rounded-lg border border-forest/30 bg-white px-3 py-1.5 text-[12px] font-bold text-forest disabled:opacity-50"
                  >
                    {pending === anomaly.id ? "Enregistrement…" : "Marquer comme traitée"}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {closedAnomalies.length > 0 ? (
          <details className="mt-3">
            <summary className="text-[12px] font-semibold text-ink-soft">{closedAnomalies.length} anomalie(s) déjà traitée(s)</summary>
            <ul className="mt-2 divide-y divide-line">
              {closedAnomalies.map((anomaly) => {
                const row = anomalyRow(anomaly);
                return (
                  <li key={anomaly.id} className="py-2 text-[12px] text-ink-soft">
                    <span className="font-bold">{row.title}</span> · {row.detail}
                  </li>
                );
              })}
            </ul>
          </details>
        ) : null}
      </section>

      <section aria-labelledby="payments-catchup" className="mt-4 rounded-2xl border border-line bg-white p-4">
        <h2 id="payments-catchup" className="text-[15px] font-extrabold text-ink">Rattrapage et webhooks</h2>
        <p data-testid="admin-payments-catchup" data-warn={catchup.warn ? "true" : "false"} className={`mt-1 text-[13px] ${catchup.warn ? "font-semibold text-carrot-ink" : "text-ink-soft"}`}>{catchup.text}</p>
        <p data-testid="admin-payments-webhooks" className="mt-1 text-[13px] text-ink-soft">{webhooksText(overview.webhooks)}</p>
      </section>

      <section aria-labelledby="payments-intents" className="mt-4 rounded-2xl border border-line bg-white p-4">
        <h2 id="payments-intents" className="text-[15px] font-extrabold text-ink">Recharges récentes</h2>
        {overview.intents.length === 0 ? (
          <p className="mt-2 text-[13px] text-ink-soft">Aucune recharge pour le moment.</p>
        ) : (
          <ul className="mt-2 divide-y divide-line">
            {overview.intents.map((intent) => {
              const row = intentRow(intent);
              return (
                <li key={intent.id} data-testid="admin-payments-intent" data-status={intent.status} className="py-2">
                  <div className="text-[14px] font-bold text-ink">{row.title}</div>
                  <div className="text-[12px] text-ink-soft">{row.detail}</div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
