"use client";

import { Activity, CircleCheck, Globe, Link2, OctagonAlert, Radar } from "lucide-react";
import { AdminPage } from "@/components/admin/admin-page";
import { Notice, PageHeading, Panel } from "@/components/admin/admin-ui";
import { Badge, IconTile } from "@/components/ui";
import {
  ADMIN_COLLECTION_NOTE,
  ADMIN_COLLECTION_NOT_READY,
  ADMIN_COLLECTION_NO_ERRORS,
  ADMIN_COLLECTION_TITLE,
  adminErrorRows,
  adminSourceRow,
  adminWatchSummary,
} from "@/lib/client/external-view";
import { external } from "@/lib/client/external-api";

const load = (signal: AbortSignal) => external.adminCollection({ signal });

/** Collecte externe (lot EXT1) : sources fictives (état, disjoncteur, quota consommé), surveillances (nombre, dues, en pause), dernières erreurs. Lecture seule : aucune activation. */
export default function AdminCollecte() {
  return (
    <AdminPage title={ADMIN_COLLECTION_TITLE} back="/admin" load={load}>
      {(collection) => {
        const summary = adminWatchSummary(collection);
        const errors = adminErrorRows(collection.errors);
        return (
          <div data-testid="admin-collection" className="flex flex-col gap-4">
            <PageHeading icon={Globe} tone="info">
              {ADMIN_COLLECTION_TITLE}
            </PageHeading>
            <Notice data-testid="admin-collection-note">{ADMIN_COLLECTION_NOTE}</Notice>
            {!collection.schemaReady ? (
              <p role="status" className="animate-rise flex items-center gap-3 rounded-3xl bg-mist p-4 text-[15px] font-semibold text-ink-soft">
                <OctagonAlert className="size-6 shrink-0" aria-hidden />
                {ADMIN_COLLECTION_NOT_READY}
              </p>
            ) : (
              <>
                <section aria-labelledby="sources-title" className="flex flex-col gap-3">
                  <h2 id="sources-title" className="flex items-center gap-2 text-[18px] font-extrabold tracking-tight text-ink">
                    <Link2 className="size-5 text-brand" aria-hidden />
                    Sources
                  </h2>
                  <ul className="stagger flex flex-col gap-3 md:grid md:grid-cols-2" aria-label="Sources">
                    {collection.sources.map((source) => {
                      const row = adminSourceRow(source);
                      return (
                        <li key={row.code} data-testid="collection-source" data-state={row.state} data-source={row.code} className="rounded-3xl border border-line bg-white p-4">
                          <div className="flex items-center gap-3">
                            <IconTile icon={Globe} tone={row.state === "closed" ? "success" : row.state === "disabled" ? "mist" : "accent"} />
                            <span className="min-w-0 flex-1 text-[16px] font-bold leading-snug text-ink">{row.name}</span>
                            <Badge tone={row.state === "closed" ? "sage" : row.state === "disabled" ? "wash" : "carrot"}>{row.stateText}</Badge>
                          </div>
                          <div className="mt-3 space-y-0.5">
                            <div className="text-[13px] text-ink-soft">Source {row.typeText.toLowerCase()}</div>
                            <div data-testid="collection-quota" className="text-[13px] text-ink-soft">
                              {row.quotaText}
                            </div>
                            <div className="text-[13px] text-ink-soft">{row.failuresText}</div>
                            {row.pauseText ? <div className="text-[13px] font-semibold text-accent-ink">{row.pauseText}</div> : null}
                            {row.lastErrorText ? <div className="text-[13px] text-ink-soft">Dernière erreur : {row.lastErrorText}</div> : null}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </section>
                <Panel icon={Radar} tone="brand" title="Surveillances et annonces" titleId="watches-title" aria-labelledby="watches-title" data-testid="collection-watches">
                  <ul className="mt-3 space-y-1 text-[14px] leading-snug text-ink-soft">
                    {summary.lines.map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                </Panel>
                <section aria-labelledby="errors-title" data-testid="collection-errors" className="flex flex-col gap-3">
                  <h2 id="errors-title" className="flex items-center gap-2 text-[18px] font-extrabold tracking-tight text-ink">
                    <Activity className="size-5 text-brand" aria-hidden />
                    Dernières erreurs
                  </h2>
                  {errors.length === 0 ? (
                    <p className="flex items-center gap-3 rounded-3xl border border-line bg-white p-4 text-[15px] font-semibold text-ink-soft">
                      <CircleCheck className="size-6 shrink-0 text-success" aria-hidden />
                      {ADMIN_COLLECTION_NO_ERRORS}
                    </p>
                  ) : (
                    <ul className="stagger flex flex-col gap-2 md:grid md:grid-cols-2">
                      {errors.map((entry) => (
                        <li key={entry.key} data-testid="collection-error" className="rounded-2xl border border-line bg-white px-4 py-3 text-[13px]">
                          <div className="text-[14px] font-semibold text-ink">{entry.text}</div>
                          <div className="text-ink-soft">{entry.dateText}</div>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              </>
            )}
          </div>
        );
      }}
    </AdminPage>
  );
}
