"use client";

import { useCallback, useRef, useState } from "react";
import { Ban, CircleCheck, ScrollText, Store, UserCheck } from "lucide-react";
import { AdminPage } from "@/components/admin/admin-page";
import { Pager, PageHeading, Panel, adminBtnOutline, adminBtnPrimary } from "@/components/admin/admin-ui";
import { ArtStore } from "@/components/illustrations";
import { Badge, EmptyState, IconTile } from "@/components/ui";
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
  const [confirming, setConfirming] = useState<{ id: string; action: "suspend" | "reactivate"; phone: string; ref: string } | null>(null);
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
    <div data-testid="admin-vendors" className="flex flex-col gap-4">
      <PageHeading icon={Store}>{VENDORS_TITLE}</PageHeading>
      {notice ? (
        <p role="status" data-testid="admin-notice" className="animate-pop flex items-center gap-2 rounded-2xl bg-success-soft px-3.5 py-2.5 text-[15px] font-semibold text-success-ink">
          <CircleCheck className="size-5 shrink-0" aria-hidden />
          {notice}
        </p>
      ) : null}
      {data.page.vendors.length === 0 ? (
        <EmptyState art={<ArtStore />} title={VENDORS_EMPTY} />
      ) : (
        <ul aria-label="Vendeurs" className="stagger flex flex-col gap-3 md:grid md:grid-cols-2">
          {data.page.vendors.map((vendor) => {
            const row = vendorRow(vendor);
            return (
              <li key={row.id} data-testid="vendor-row" data-status={vendor.status} className="flex flex-col gap-3 rounded-3xl border border-line bg-white p-4">
                <div className="flex items-center gap-3">
                  <IconTile icon={row.suspended ? Ban : UserCheck} tone={row.suspended ? "accent" : "success"} />
                  <span className="min-w-0 flex-1">
                    <span data-testid="vendor-phone" className="block text-[16px] font-bold tracking-wide text-ink tabular-nums">
                      {row.maskedPhone}
                    </span>
                    <span data-testid="vendor-ref" className="block text-[13px] tabular-nums text-ink-soft">
                      {row.refText}
                    </span>
                  </span>
                  <Badge tone={row.suspended ? "carrot" : "sage"}>{row.statusText}</Badge>
                </div>
                <div className="text-[13px] leading-snug text-ink-soft">
                  <div>{row.offersText}</div>
                  <div>{row.joinedText}</div>
                </div>
                {row.canSuspend || row.canReactivate ? (
                  <button
                    onClick={() => {
                      setNotice(null);
                      setError(null);
                      setConfirming({ id: row.id, action: row.canSuspend ? "suspend" : "reactivate", phone: row.maskedPhone, ref: row.refText });
                    }}
                    data-testid={row.canSuspend ? "vendor-suspend" : "vendor-reactivate"}
                    className={`${adminBtnOutline} self-start`}
                  >
                    {row.canSuspend ? <Ban className="size-4" aria-hidden /> : <UserCheck className="size-4" aria-hidden />}
                    {row.canSuspend ? SUSPEND_LABEL : REACTIVATE_LABEL}
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      <Pager
        rangeText={pageInfo.from === 0 ? "" : `${pageInfo.from} à ${pageInfo.to} sur ${data.page.total}`}
        hasPrevious={pageInfo.hasPrevious}
        hasNext={pageInfo.hasNext}
        onPrevious={() => setOffset(Math.max(0, offset - VENDORS_PAGE_SIZE))}
        onNext={() => setOffset(offset + VENDORS_PAGE_SIZE)}
        previousTestId="vendors-previous"
        nextTestId="vendors-next"
      />

      {confirming ? (
        <div role="alertdialog" aria-modal="false" aria-labelledby="confirm-title" data-testid="admin-confirm" className="animate-rise rounded-3xl border-2 border-accent bg-white p-4">
          <h2 id="confirm-title" className="text-[16px] font-extrabold text-ink">
            Confirmer
          </h2>
          <p className="mt-1 text-[14px] text-ink-soft">{confirmText(confirming.action, confirming.phone, confirming.ref)}</p>
          {error ? (
            <p role="alert" className="mt-2 text-[14px] font-semibold text-danger-ink">
              {error}
            </p>
          ) : null}
          <div className="mt-3 grid grid-cols-2 gap-3">
            <button onClick={() => setConfirming(null)} disabled={pending} className={adminBtnOutline}>
              Annuler
            </button>
            <button onClick={() => void apply()} disabled={pending} data-testid="admin-confirm-yes" className={adminBtnPrimary}>
              {confirming.action === "suspend" ? SUSPEND_LABEL : REACTIVATE_LABEL}
            </button>
          </div>
        </div>
      ) : null}

      <Panel icon={ScrollText} tone="info" title={JOURNAL_TITLE} titleId="journal-title" aria-labelledby="journal-title" data-testid="admin-journal">
        {data.journal.length === 0 ? (
          <p className="mt-3 text-[14px] text-ink-soft">{JOURNAL_EMPTY}</p>
        ) : (
          <ul className="mt-3 divide-y divide-line">
            {data.journal.map((entry) => {
              const line = journalRow(entry);
              return (
                <li key={line.id} data-testid="journal-row" className="py-2.5 text-[13px] first:pt-0 last:pb-0">
                  <div className="text-[14px] font-semibold text-ink">{line.text}</div>
                  <div className="text-ink-soft">{line.dateText}</div>
                </li>
              );
            })}
          </ul>
        )}
      </Panel>
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
