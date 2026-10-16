"use client";

import Link from "next/link";
import { useCallback, useState } from "react";
import { ChevronRight, Flag } from "lucide-react";
import { AdminPage } from "@/components/admin/admin-page";
import { PageHeading, Pager } from "@/components/admin/admin-ui";
import { ArtCheck } from "@/components/illustrations";
import { Badge, EmptyState, IconTile } from "@/components/ui";
import { pageWindow } from "@/lib/client/admin-view";
import { reports, type AdminReportsPage } from "@/lib/client/reports-api";
import { DOSSIERS_EMPTY_CLOSED, DOSSIERS_EMPTY_OPEN, DOSSIERS_PAGE_SIZE, DOSSIERS_TITLE, dossierRow } from "@/lib/client/reports-view";
import type { ReportStatus } from "@/lib/reports-rules";

function Dossiers({ page, status, setStatus, offset, setOffset }: { page: AdminReportsPage; status: ReportStatus; setStatus: (status: ReportStatus) => void; offset: number; setOffset: (offset: number) => void }) {
  const window = pageWindow(page.total, page.offset, page.limit);
  return (
    <div data-testid="admin-dossiers" className="flex flex-col gap-4">
      <PageHeading icon={Flag} tone="accent">
        {DOSSIERS_TITLE}
      </PageHeading>
      <div role="tablist" aria-label="Dossiers" className="grid grid-cols-2 gap-2 rounded-full bg-mist p-1 md:max-w-sm">
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
            className={`press min-h-11 rounded-full px-3 py-2 text-[15px] font-bold ${status === entry ? "bg-brand text-white" : "text-ink hover:bg-white"}`}
          >
            {entry === "open" ? "À traiter" : "Clos"}
          </button>
        ))}
      </div>
      {page.reports.length === 0 ? (
        <EmptyState art={<ArtCheck />} title={status === "open" ? DOSSIERS_EMPTY_OPEN : DOSSIERS_EMPTY_CLOSED} />
      ) : (
        <ul aria-label="Dossiers" className="stagger flex flex-col gap-3 md:grid md:grid-cols-2">
          {page.reports.map((report) => {
            const row = dossierRow(report);
            return (
              <li key={row.id} data-testid="dossier-row" data-status={report.status}>
                <Link href={`/admin/dossiers/${row.id}`} className="press flex h-full items-start gap-3 rounded-3xl border border-line bg-white p-4 hover:border-brand">
                  <IconTile icon={Flag} tone={row.open ? "accent" : "success"} />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-start justify-between gap-2">
                      <span className="text-[16px] font-bold leading-snug text-ink">{row.title}</span>
                      <Badge tone={row.open ? "carrot" : "sage"}>{row.decisionText ?? "À traiter"}</Badge>
                    </span>
                    <span className="mt-0.5 block text-[14px] text-ink">{row.reasonText}</span>
                    <span className="block text-[13px] tabular-nums text-ink-soft">{row.reportedText}</span>
                    <span className="block text-[13px] tabular-nums text-ink-soft">{row.reporterText}</span>
                    {row.alertText ? <span className="mt-1 block text-[13px] font-semibold text-accent-ink">{row.alertText}</span> : null}
                    <span className="block text-[13px] text-ink-soft">{row.dateText}</span>
                  </span>
                  <ChevronRight className="mt-1 size-5 shrink-0 text-ink-soft" aria-hidden />
                </Link>
              </li>
            );
          })}
        </ul>
      )}
      <Pager
        rangeText={window.from === 0 ? "" : `${window.from} à ${window.to} sur ${page.total}`}
        hasPrevious={window.hasPrevious}
        hasNext={window.hasNext}
        onPrevious={() => setOffset(Math.max(0, offset - DOSSIERS_PAGE_SIZE))}
        onNext={() => setOffset(offset + DOSSIERS_PAGE_SIZE)}
      />
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
