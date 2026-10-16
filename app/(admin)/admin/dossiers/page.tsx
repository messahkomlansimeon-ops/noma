"use client";

import Link from "next/link";
import { useCallback, useState } from "react";
import { AdminPage } from "@/components/admin/admin-page";
import { Badge } from "@/components/ui";
import { pageWindow } from "@/lib/client/admin-view";
import { reports, type AdminReportsPage } from "@/lib/client/reports-api";
import { DOSSIERS_EMPTY_CLOSED, DOSSIERS_EMPTY_OPEN, DOSSIERS_PAGE_SIZE, DOSSIERS_TITLE, dossierRow } from "@/lib/client/reports-view";
import type { ReportStatus } from "@/lib/reports-rules";

function Dossiers({ page, status, setStatus, offset, setOffset }: { page: AdminReportsPage; status: ReportStatus; setStatus: (status: ReportStatus) => void; offset: number; setOffset: (offset: number) => void }) {
  const window = pageWindow(page.total, page.offset, page.limit);
  return (
    <div data-testid="admin-dossiers">
      <h1 className="text-[22px] font-extrabold text-ink">{DOSSIERS_TITLE}</h1>
      <div role="tablist" aria-label="Dossiers" className="mt-3 grid grid-cols-2 gap-2">
        {(["open", "closed"] as const).map((entry) => (
          <button
            key={entry}
            role="tab"
            aria-selected={status === entry}
            data-testid={`dossiers-tab-${entry}`}
            onClick={() => {
              setOffset(0);
              setStatus(entry);
            }}
            className={`rounded-xl border px-3 py-2 text-[15px] font-bold ${status === entry ? "border-brand bg-brand text-white" : "border-line bg-white text-ink"}`}
          >
            {entry === "open" ? "À traiter" : "Clos"}
          </button>
        ))}
      </div>
      {page.reports.length === 0 ? (
        <p className="mt-4 rounded-2xl bg-mist p-4 text-center text-[15px] text-ink-soft">{status === "open" ? DOSSIERS_EMPTY_OPEN : DOSSIERS_EMPTY_CLOSED}</p>
      ) : (
        <ul aria-label="Dossiers" className="mt-3 space-y-2.5">
          {page.reports.map((report) => {
            const row = dossierRow(report);
            return (
              <li key={row.id} data-testid="dossier-row" data-status={report.status}>
                <Link href={`/admin/dossiers/${row.id}`} className="block rounded-2xl border border-line bg-white p-3.5">
                  <div className="flex items-start justify-between gap-2">
                    <span className="text-[15px] font-bold text-ink">{row.title}</span>
                    <Badge tone={row.open ? "carrot" : "sage"}>{row.decisionText ?? "À traiter"}</Badge>
                  </div>
                  <div className="mt-0.5 text-[13px] text-ink-soft">{row.reasonText}</div>
                  <div className="font-mono text-[13px] text-ink-soft">{row.reportedText}</div>
                  <div className="font-mono text-[13px] text-ink-soft">{row.reporterText}</div>
                  {row.alertText ? <div className="mt-1 text-[13px] font-semibold text-accent-ink">{row.alertText}</div> : null}
                  <div className="text-[13px] text-ink-soft">{row.dateText}</div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
      <div className="mt-3 flex items-center justify-between text-[13px] text-ink-soft">
        <span>{window.from === 0 ? "" : `${window.from} à ${window.to} sur ${page.total}`}</span>
        <span className="flex gap-2">
          <button disabled={!window.hasPrevious} onClick={() => setOffset(Math.max(0, offset - DOSSIERS_PAGE_SIZE))} className="rounded-lg border border-line bg-white px-3 py-1.5 font-bold text-ink disabled:opacity-40">
            Précédents
          </button>
          <button disabled={!window.hasNext} onClick={() => setOffset(offset + DOSSIERS_PAGE_SIZE)} className="rounded-lg border border-line bg-white px-3 py-1.5 font-bold text-ink disabled:opacity-40">
            Suivants
          </button>
        </span>
      </div>
    </div>
  );
}

export default function AdminDossiers() {
  const [status, setStatus] = useState<ReportStatus>("open");
  const [offset, setOffset] = useState(0);
  const load = useCallback((signal: AbortSignal) => reports.admin.list({ status, limit: DOSSIERS_PAGE_SIZE, offset }, { signal }), [status, offset]);
  return (
    <AdminPage title="Dossiers" back="/admin" load={load}>
      {(page) => <Dossiers page={page} status={status} setStatus={setStatus} offset={offset} setOffset={setOffset} />}
    </AdminPage>
  );
}
