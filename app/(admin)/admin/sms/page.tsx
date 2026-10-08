"use client";

import { AdminPage } from "@/components/admin/admin-page";
import { SMS_FAILED_EMPTY, SMS_FAILED_NOTE, SMS_NOTE, SMS_TITLE, SMS_UNCERTAIN_EMPTY, budgetLines, failedRows, loadSmsAdmin, localLines, providerLine, uncertainRows, usageErrorMessage, usageLines } from "@/lib/client/sms-admin";

const load = (signal: AbortSignal) => loadSmsAdmin({ signal });

/** SMS (lot SMS1) : consommation du mois chez le fournisseur, journal local et envois incertains à rapprocher. Lecture seule, aucun renvoi. */
export default function AdminSms() {
  return (
    <AdminPage title={SMS_TITLE} back="/admin" load={load}>
      {(overview) => {
        const rows = uncertainRows(overview.uncertain);
        const failed = failedRows(overview.recentFailed);
        return (
          <div data-testid="admin-sms">
            <h1 className="font-display text-[22px] font-extrabold text-ink">{SMS_TITLE}</h1>
            <p className="text-[12px] text-ink-soft">{SMS_NOTE}</p>
            <section aria-labelledby="sms-usage-title" className="mt-3 rounded-2xl border border-line bg-white p-4" data-testid="admin-sms-usage">
              <h2 id="sms-usage-title" className="text-[14px] font-extrabold text-ink">
                {providerLine(overview.provider)}
              </h2>
              <ul className="mt-1.5 space-y-0.5 text-[12px] text-ink-soft">
                {overview.usage ? usageLines(overview.usage).map((line) => <li key={line}>{line}</li>) : <li>{usageErrorMessage(overview.usageError ?? "")}</li>}
                {localLines(overview.local).map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </section>
            <section aria-labelledby="sms-budget-title" className="mt-3 rounded-2xl border border-line bg-white p-4" data-testid="admin-sms-budget">
              <h2 id="sms-budget-title" className="text-[14px] font-extrabold text-ink">
                Budgets du jour
              </h2>
              <ul className="mt-1.5 space-y-0.5 text-[12px] text-ink-soft">
                {budgetLines(overview.budget).map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </section>
            <section aria-labelledby="sms-uncertain-title" className="mt-3 rounded-2xl border border-line bg-white p-4" data-testid="admin-sms-uncertain">
              <h2 id="sms-uncertain-title" className="text-[14px] font-extrabold text-ink">
                Envois incertains à rapprocher
              </h2>
              {rows.length === 0 ? (
                <p className="mt-1.5 text-[12px] text-ink-soft">{SMS_UNCERTAIN_EMPTY}</p>
              ) : (
                <ul className="mt-1.5 space-y-2 text-[12px] text-ink-soft">
                  {rows.map((row) => (
                    <li key={row.id} data-sms-id={row.id}>
                      <div className="font-semibold text-ink">{row.title}</div>
                      <div>{row.detail}</div>
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <section aria-labelledby="sms-failed-title" className="mt-3 rounded-2xl border border-line bg-white p-4" data-testid="admin-sms-failed">
              <h2 id="sms-failed-title" className="text-[14px] font-extrabold text-ink">
                Envois échoués (24 h)
              </h2>
              <p className="mt-1 text-[12px] text-ink-soft">{SMS_FAILED_NOTE}</p>
              {failed.length === 0 ? (
                <p className="mt-1.5 text-[12px] text-ink-soft">{SMS_FAILED_EMPTY}</p>
              ) : (
                <ul className="mt-1.5 space-y-2 text-[12px] text-ink-soft">
                  {failed.map((row) => (
                    <li key={row.id} data-sms-id={row.id}>
                      <div className="font-semibold text-ink">{row.title}</div>
                      <div>{row.detail}</div>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        );
      }}
    </AdminPage>
  );
}
