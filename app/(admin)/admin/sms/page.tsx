"use client";

import { CircleCheck, Gauge, MessageSquareWarning, Send, Smartphone, TriangleAlert } from "lucide-react";
import { AdminPage } from "@/components/admin/admin-page";
import { HelpNote, Notice, PageHeading, Panel } from "@/components/admin/admin-ui";
import { ArtCheck } from "@/components/illustrations";
import { EmptyState } from "@/components/ui";
import { SMS_FAILED_EMPTY, SMS_FAILED_NOTE, SMS_NOTE, SMS_TITLE, SMS_UNCERTAIN_EMPTY, budgetLines, failedRows, loadSmsAdmin, localLines, providerLine, uncertainRows, unsentCodeLines, usageErrorMessage, usageLines } from "@/lib/client/sms-admin";

const load = (signal: AbortSignal) => loadSmsAdmin({ signal });

/** SMS (lot SMS1) : consommation du mois chez le fournisseur, journal local et envois incertains à rapprocher. Lecture seule, aucun renvoi. */
export default function AdminSms() {
  return (
    <AdminPage title={SMS_TITLE} back="/admin" load={load}>
      {(overview) => {
        const rows = uncertainRows(overview.uncertain);
        const failed = failedRows(overview.recentFailed);
        return (
          <div data-testid="admin-sms" className="flex flex-col gap-4">
            <PageHeading icon={Smartphone} tone="info">
              {SMS_TITLE}
            </PageHeading>
            <Notice tone="accent">{SMS_NOTE}</Notice>
            <div className="stagger flex flex-col gap-4 md:grid md:grid-cols-2 md:items-start">
              <Panel icon={Send} tone="brand" title={providerLine(overview.provider)} titleId="sms-usage-title" aria-labelledby="sms-usage-title" data-testid="admin-sms-usage">
                <ul className="mt-3 space-y-1 text-[14px] leading-snug text-ink-soft">
                  {overview.usage ? usageLines(overview.usage).map((line) => <li key={line}>{line}</li>) : <li>{usageErrorMessage(overview.usageError ?? "")}</li>}
                  {localLines(overview.local).map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              </Panel>
              <Panel icon={Gauge} tone="success" title="Budgets du jour" titleId="sms-budget-title" aria-labelledby="sms-budget-title" data-testid="admin-sms-budget">
                <ul className="mt-3 space-y-1 text-[14px] leading-snug text-ink-soft">
                  {budgetLines(overview.budget).map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                  {unsentCodeLines(overview.unsentCodes).map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              </Panel>
              <Panel icon={TriangleAlert} tone="accent" title="Envois incertains à rapprocher" titleId="sms-uncertain-title" aria-labelledby="sms-uncertain-title" data-testid="admin-sms-uncertain">
                {rows.length === 0 ? (
                  <div className="flex items-center gap-3 pt-3 text-[15px] font-semibold text-ink-soft">
                    <CircleCheck className="size-6 shrink-0 text-success" aria-hidden />
                    <p>{SMS_UNCERTAIN_EMPTY}</p>
                  </div>
                ) : (
                  <ul className="mt-3 divide-y divide-line text-[13px] text-ink-soft">
                    {rows.map((row) => (
                      <li key={row.id} data-sms-id={row.id} className="py-2.5 first:pt-0 last:pb-0">
                        <div className="text-[14px] font-semibold text-ink">{row.title}</div>
                        <div>{row.detail}</div>
                      </li>
                    ))}
                  </ul>
                )}
              </Panel>
              <Panel icon={MessageSquareWarning} tone="danger" title="Envois échoués (24 h)" titleId="sms-failed-title" aria-labelledby="sms-failed-title" data-testid="admin-sms-failed">
                <HelpNote label="Comment lire les envois échoués">{SMS_FAILED_NOTE}</HelpNote>
                {failed.length === 0 ? (
                  <EmptyState art={<ArtCheck className="size-24" />} title={SMS_FAILED_EMPTY} />
                ) : (
                  <ul className="mt-2 divide-y divide-line text-[13px] text-ink-soft">
                    {failed.map((row) => (
                      <li key={row.id} data-sms-id={row.id} className="py-2.5 first:pt-0 last:pb-0">
                        <div className="text-[14px] font-semibold text-ink">{row.title}</div>
                        <div>{row.detail}</div>
                      </li>
                    ))}
                  </ul>
                )}
              </Panel>
            </div>
          </div>
        );
      }}
    </AdminPage>
  );
}
