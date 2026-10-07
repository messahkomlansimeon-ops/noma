"use client";

import { useCallback, useRef, useState } from "react";
import { AdminPage } from "@/components/admin/admin-page";
import { Badge } from "@/components/ui";
import { useUnauthorizedRedirect } from "@/components/session-gate";
import {
  JOURNAL_EMPTY,
  JOURNAL_TITLE,
  REACTIVATE_LABEL,
  SUSPEND_LABEL,
  VENDORS_EMPTY,
  VENDORS_PAGE_SIZE,
  VENDORS_TITLE,
  confirmText,
  journalRow,
  pageWindow,
  vendorRow,
} from "@/lib/client/admin-view";
import { describeSocialError, social, type AdminActionEntry, type AdminVendorsPage } from "@/lib/client/social-api";

interface Data {
  page: AdminVendorsPage;
  journal: AdminActionEntry[];
}

/** Vendeurs (lot D2) : liste paginée aux numéros MASQUÉS (sauf les deux derniers chiffres), suspension et réactivation avec confirmation à l'écran, journal d'administration. */
function Vendors({ data, offset, reload, setOffset }: { data: Data; offset: number; reload: () => void; setOffset: (offset: number) => void }) {
  const redirectIfUnauthorized = useUnauthorizedRedirect();
  const [confirming, setConfirming] = useState<{ id: string; action: "suspend" | "reactivate"; phone: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const busy = useRef(false);

  const apply = useCallback(async () => {
    if (confirming === null || busy.current) return;
    busy.current = true;
    setPending(true);
    setError(null);
    try {
      await social.admin.setStatus(confirming.id, confirming.action);
      setNotice(confirming.action === "suspend" ? "Vendeur suspendu." : "Vendeur réactivé.");
      setConfirming(null);
      reload();
    } catch (failure) {
      if (redirectIfUnauthorized(failure)) return;
      setError(describeSocialError(failure, "admin"));
    } finally {
      busy.current = false;
      setPending(false);
    }
  }, [confirming, reload, redirectIfUnauthorized]);

  const pageInfo = pageWindow(data.page.total, data.page.offset, data.page.limit);
  return (
    <div data-testid="admin-vendors">
      <h1 className="font-display text-[22px] font-extrabold text-ink">{VENDORS_TITLE}</h1>
      {notice ? (
        <p role="status" data-testid="admin-notice" className="mt-2 rounded-xl bg-sage px-3 py-2 text-[13px] font-semibold text-forest">
          {notice}
        </p>
      ) : null}
      {data.page.vendors.length === 0 ? (
        <p className="mt-4 rounded-2xl bg-wash p-4 text-center text-[14px] text-ink-soft">{VENDORS_EMPTY}</p>
      ) : (
        <ul aria-label="Vendeurs" className="mt-3 space-y-2.5">
          {data.page.vendors.map((vendor) => {
            const row = vendorRow(vendor);
            return (
              <li key={row.id} data-testid="vendor-row" data-status={vendor.status} className="rounded-2xl border border-line bg-white p-3.5">
                <div className="flex items-center justify-between gap-2">
                  <span data-testid="vendor-phone" className="font-mono text-[15px] font-bold tracking-wide text-ink">
                    {row.maskedPhone}
                  </span>
                  <Badge tone={row.suspended ? "carrot" : "sage"}>{row.statusText}</Badge>
                </div>
                <div className="mt-0.5 text-[12px] text-ink-soft">{row.offersText}</div>
                <div className="text-[12px] text-ink-soft">{row.joinedText}</div>
                {row.canSuspend || row.canReactivate ? (
                  <button
                    onClick={() => {
                      setNotice(null);
                      setError(null);
                      setConfirming({ id: row.id, action: row.canSuspend ? "suspend" : "reactivate", phone: row.maskedPhone });
                    }}
                    data-testid={row.canSuspend ? "vendor-suspend" : "vendor-reactivate"}
                    className="mt-2 rounded-xl border border-line bg-white px-3.5 py-2 text-[13px] font-bold text-ink"
                  >
                    {row.canSuspend ? SUSPEND_LABEL : REACTIVATE_LABEL}
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      <div className="mt-3 flex items-center justify-between text-[12px] text-ink-soft">
        <span>
          {pageInfo.from === 0 ? "" : `${pageInfo.from} à ${pageInfo.to} sur ${data.page.total}`}
        </span>
        <span className="flex gap-2">
          <button disabled={!pageInfo.hasPrevious} onClick={() => setOffset(Math.max(0, offset - VENDORS_PAGE_SIZE))} data-testid="vendors-previous" className="rounded-lg border border-line bg-white px-3 py-1.5 font-bold text-ink disabled:opacity-40">
            Précédents
          </button>
          <button disabled={!pageInfo.hasNext} onClick={() => setOffset(offset + VENDORS_PAGE_SIZE)} data-testid="vendors-next" className="rounded-lg border border-line bg-white px-3 py-1.5 font-bold text-ink disabled:opacity-40">
            Suivants
          </button>
        </span>
      </div>

      {confirming ? (
        <div role="alertdialog" aria-modal="false" aria-labelledby="confirm-title" data-testid="admin-confirm" className="mt-4 rounded-2xl border-2 border-carrot bg-white p-4">
          <h2 id="confirm-title" className="text-[14px] font-extrabold text-ink">
            Confirmer
          </h2>
          <p className="mt-1 text-[13px] text-ink-soft">{confirmText(confirming.action, confirming.phone)}</p>
          {error ? (
            <p role="alert" className="mt-2 text-[13px] font-semibold text-carrot-ink">
              {error}
            </p>
          ) : null}
          <div className="mt-3 grid grid-cols-2 gap-2.5">
            <button onClick={() => setConfirming(null)} disabled={pending} className="rounded-xl border border-line bg-white px-3 py-2.5 text-[14px] font-bold text-ink disabled:opacity-50">
              Annuler
            </button>
            <button onClick={() => void apply()} disabled={pending} data-testid="admin-confirm-yes" className="rounded-xl bg-forest px-3 py-2.5 text-[14px] font-bold text-white disabled:opacity-50">
              {confirming.action === "suspend" ? SUSPEND_LABEL : REACTIVATE_LABEL}
            </button>
          </div>
        </div>
      ) : null}

      <section aria-labelledby="journal-title" className="mt-6" data-testid="admin-journal">
        <h2 id="journal-title" className="text-[16px] font-extrabold text-ink">
          {JOURNAL_TITLE}
        </h2>
        {data.journal.length === 0 ? (
          <p className="mt-2 text-[13px] text-ink-soft">{JOURNAL_EMPTY}</p>
        ) : (
          <ul className="mt-2 space-y-1.5">
            {data.journal.map((entry) => {
              const line = journalRow(entry);
              return (
                <li key={line.id} data-testid="journal-row" className="rounded-xl border border-line bg-white px-3 py-2 text-[12px]">
                  <div className="font-semibold text-ink">{line.text}</div>
                  <div className="text-ink-soft">{line.dateText}</div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}

export default function AdminVendeurs() {
  const [offset, setOffset] = useState(0);
  const load = useCallback(
    async (signal: AbortSignal): Promise<Data> => {
      const [page, journal] = await Promise.all([social.admin.vendors({ limit: VENDORS_PAGE_SIZE, offset }, { signal }), social.admin.actions({ signal })]);
      return { page, journal };
    },
    [offset],
  );
  return (
    <AdminPage title="Vendeurs" back="/admin" load={load}>
      {(data, reload) => <Vendors data={data} offset={offset} reload={reload} setOffset={setOffset} />}
    </AdminPage>
  );
}
