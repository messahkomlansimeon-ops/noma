"use client";

import { AdminPage } from "@/components/admin/admin-page";
import { Badge } from "@/components/ui";
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
          <div data-testid="admin-collection">
            <h1 className="font-display text-[22px] font-extrabold text-ink">{ADMIN_COLLECTION_TITLE}</h1>
            <p data-testid="admin-collection-note" className="mt-1 rounded-xl bg-wash px-3 py-2 text-[12px] font-semibold text-ink-soft">
              {ADMIN_COLLECTION_NOTE}
            </p>
            {!collection.schemaReady ? (
              <p role="status" className="mt-4 rounded-2xl bg-wash p-4 text-center text-[14px] text-ink-soft">
                {ADMIN_COLLECTION_NOT_READY}
              </p>
            ) : (
              <>
                <section aria-labelledby="sources-title" className="mt-4">
                  <h2 id="sources-title" className="text-[16px] font-extrabold text-ink">
                    Sources
                  </h2>
                  <ul className="mt-2 space-y-2.5" aria-label="Sources">
                    {collection.sources.map((source) => {
                      const row = adminSourceRow(source);
                      return (
                        <li key={row.code} data-testid="collection-source" data-state={row.state} data-source={row.code} className="rounded-2xl border border-line bg-white p-3.5">
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-[15px] font-bold text-ink">{row.name}</span>
                            <Badge tone={row.state === "closed" ? "sage" : row.state === "disabled" ? "wash" : "carrot"}>{row.stateText}</Badge>
                          </div>
                          <div className="text-[12px] text-ink-soft">Source {row.typeText.toLowerCase()}</div>
                          <div data-testid="collection-quota" className="text-[12px] text-ink-soft">
                            {row.quotaText}
                          </div>
                          <div className="text-[12px] text-ink-soft">{row.failuresText}</div>
                          {row.pauseText ? <div className="text-[12px] font-semibold text-carrot-ink">{row.pauseText}</div> : null}
                          {row.lastErrorText ? <div className="text-[12px] text-ink-soft">Dernière erreur : {row.lastErrorText}</div> : null}
                        </li>
                      );
                    })}
                  </ul>
                </section>
                <section aria-labelledby="watches-title" data-testid="collection-watches" className="mt-4 rounded-2xl border border-line bg-white p-4">
                  <h2 id="watches-title" className="text-[14px] font-extrabold text-ink">
                    Surveillances et annonces
                  </h2>
                  <ul className="mt-1.5 space-y-0.5 text-[12px] text-ink-soft">
                    {summary.lines.map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                </section>
                <section aria-labelledby="errors-title" data-testid="collection-errors" className="mt-4">
                  <h2 id="errors-title" className="text-[16px] font-extrabold text-ink">
                    Dernières erreurs
                  </h2>
                  {errors.length === 0 ? (
                    <p className="mt-2 text-[13px] text-ink-soft">{ADMIN_COLLECTION_NO_ERRORS}</p>
                  ) : (
                    <ul className="mt-2 space-y-1.5">
                      {errors.map((entry) => (
                        <li key={entry.key} data-testid="collection-error" className="rounded-xl border border-line bg-white px-3 py-2 text-[12px]">
                          <div className="font-semibold text-ink">{entry.text}</div>
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
