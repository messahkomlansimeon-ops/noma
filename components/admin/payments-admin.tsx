"use client";

import { useState } from "react";
import { Check, CreditCard, Radar, TriangleAlert, Wallet } from "lucide-react";
import { ArtCheck, ArtWallet } from "@/components/illustrations";
import { Notice, PageHeading, Panel, adminBtnOutline } from "@/components/admin/admin-ui";
import { EmptyState, IconTile } from "@/components/ui";
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
    <div data-testid="admin-payments" className="flex flex-col gap-4">
      <PageHeading icon={CreditCard} tone="success">
        {PAYMENTS_TITLE}
      </PageHeading>
      <div className="flex flex-col gap-2">
        <p data-testid="admin-payments-provider" data-provider={overview.provider} className="flex items-center gap-2 text-[15px] font-bold text-ink">
          <Wallet className="size-5 text-brand" aria-hidden />
          {providerStateText(overview.provider)}
        </p>
        <Notice tone="brand">{WAVE_ONLY_NOTE}</Notice>
        <p className="text-[13px] text-ink-soft">Lu le {formatDateFr(overview.readAt)}</p>
      </div>

      <div className="flex flex-col gap-4 md:grid md:grid-cols-2 md:items-start">
        <Panel
          icon={TriangleAlert}
          tone="accent"
          title={
            <>
              Anomalies à traiter <span data-testid="admin-payments-open-count">({overview.openAnomalies})</span>
            </>
          }
          titleId="payments-anomalies"
          aria-labelledby="payments-anomalies"
          className="md:col-span-2"
        >
          <Notice tone="accent" className="mt-3">{ANOMALY_EXPLANATION}</Notice>
          {message ? <Notice tone="accent" role="alert" className="mt-2">{message}</Notice> : null}
          {openAnomalies.length === 0 ? (
            <div data-testid="admin-payments-no-anomaly">
              <EmptyState art={<ArtCheck />} title="Aucune anomalie à traiter." />
            </div>
          ) : (
            <ul className="stagger mt-3 grid gap-3 md:grid-cols-2">
              {openAnomalies.map((anomaly) => {
                const row = anomalyRow(anomaly);
                return (
                  <li key={anomaly.id} data-testid="admin-payments-anomaly" data-kind={anomaly.kind} className="flex flex-col gap-2 rounded-2xl border border-line p-3.5">
                    <div className="flex items-start gap-3">
                      <IconTile icon={TriangleAlert} tone="accent" className="size-10" />
                      <div className="min-w-0">
                        <div className="text-[15px] font-bold leading-snug text-ink">{row.title}</div>
                        <div className="text-[13px] text-ink-soft">{row.detail}</div>
                      </div>
                    </div>
                    <button data-testid="admin-payments-resolve" onClick={() => void resolve(anomaly.id)} disabled={pending !== null} className={`${adminBtnOutline} self-start`}>
                      <Check className="size-4" aria-hidden />
                      {pending === anomaly.id ? "Enregistrement…" : "Marquer comme traitée"}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {closedAnomalies.length > 0 ? (
            <details className="mt-3">
              <summary className="flex min-h-11 cursor-pointer list-none items-center [&::-webkit-details-marker]:hidden text-[14px] font-semibold text-ink-soft">{closedAnomalies.length} anomalie(s) déjà traitée(s)</summary>
              <ul className="mt-1 divide-y divide-line">
                {closedAnomalies.map((anomaly) => {
                  const row = anomalyRow(anomaly);
                  return (
                    <li key={anomaly.id} className="py-2 text-[13px] text-ink-soft">
                      <span className="font-bold">{row.title}</span> · {row.detail}
                    </li>
                  );
                })}
              </ul>
            </details>
          ) : null}
        </Panel>

        <Panel icon={Radar} tone="info" title="Rattrapage et webhooks" titleId="payments-catchup" aria-labelledby="payments-catchup">
          <p data-testid="admin-payments-catchup" data-warn={catchup.warn ? "true" : "false"} className={`mt-3 text-[14px] ${catchup.warn ? "font-semibold text-accent-ink" : "text-ink-soft"}`}>{catchup.text}</p>
          <p data-testid="admin-payments-webhooks" className="mt-1 text-[14px] text-ink-soft">{webhooksText(overview.webhooks)}</p>
        </Panel>

        <Panel icon={Wallet} tone="success" title="Recharges récentes" titleId="payments-intents" aria-labelledby="payments-intents">
          {overview.intents.length === 0 ? (
            <EmptyState art={<ArtWallet className="size-28" />} title="Aucune recharge pour le moment." />
          ) : (
            <ul className="mt-3 divide-y divide-line">
              {overview.intents.map((intent) => {
                const row = intentRow(intent);
                return (
                  <li key={intent.id} data-testid="admin-payments-intent" data-status={intent.status} className="py-2.5 first:pt-0 last:pb-0">
                    <div className="text-[15px] font-bold text-ink">{row.title}</div>
                    <div className="text-[13px] text-ink-soft">{row.detail}</div>
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>
      </div>
    </div>
  );
}
