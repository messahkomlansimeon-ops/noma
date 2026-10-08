"use client";

import Link from "next/link";
import { AdminPage } from "@/components/admin/admin-page";
import { ADMIN_TITLE, summaryTiles, workerView } from "@/lib/client/admin-view";
import { formatDateTimeFr } from "@/lib/client/wallet-view";
import { social } from "@/lib/client/social-api";

const load = (signal: AbortSignal) => social.admin.summary({ signal });

/** Tableau de bord de l'administration (lot D2) : des chiffres réels, lus sur le serveur au moment de l'ouverture. */
export default function Admin() {
  return (
    <AdminPage title={ADMIN_TITLE} back="/" load={load}>
      {(summary) => {
        const worker = workerView(summary.worker);
        return (
          <div data-testid="admin-dashboard">
            <h1 className="font-display text-[22px] font-extrabold text-ink">{ADMIN_TITLE}</h1>
            <p className="text-[12px] text-ink-soft">Lu le {formatDateTimeFr(summary.readAt)}</p>
            <div className="mt-3 grid grid-cols-2 gap-2.5">
              {summaryTiles(summary).map((tile) => (
                <div key={tile.key} data-tile={tile.key} className="rounded-2xl border border-line bg-white p-3">
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-soft">{tile.label}</div>
                  <div className="font-display text-[22px] font-extrabold leading-tight text-ink" data-tile-value>
                    {tile.value}
                  </div>
                  {tile.detail ? <div className="text-[11px] leading-snug text-ink-soft">{tile.detail}</div> : null}
                </div>
              ))}
            </div>
            <section aria-labelledby="worker-title" data-testid="admin-worker" data-healthy={worker.healthy ? "true" : "false"} className="mt-3 rounded-2xl border border-line bg-white p-4">
              <h2 id="worker-title" className="text-[14px] font-extrabold text-ink">
                {worker.headline}
              </h2>
              <ul className="mt-1.5 space-y-0.5 text-[12px] text-ink-soft">
                {worker.lines.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </section>
            <div className="mt-4 grid gap-2.5">
              <Link href="/admin/vendeurs" className="rounded-xl border border-forest/30 bg-white px-4 py-3 text-center text-[14px] font-bold text-forest">
                Vendeurs et journal d&apos;administration ›
              </Link>
              <Link href="/admin/marche" data-testid="admin-market-link" className="rounded-xl border border-forest/30 bg-white px-4 py-3 text-center text-[14px] font-bold text-forest">
                Marché : prix observés ›
              </Link>
              <Link href="/admin/reglages" className="rounded-xl border border-forest/30 bg-white px-4 py-3 text-center text-[14px] font-bold text-forest">
                Réglages du boost (lecture seule) ›
              </Link>
              <Link href="/admin/offres" data-testid="admin-offers-link" className="rounded-xl border border-forest/30 bg-white px-4 py-3 text-center text-[14px] font-bold text-forest">
                Offres Pro : plans et abonnements ›
              </Link>
              <Link href="/admin/sms" className="rounded-xl border border-forest/30 bg-white px-4 py-3 text-center text-[14px] font-bold text-forest">
                SMS : consommation et envois à rapprocher ›
              </Link>
            </div>
          </div>
        );
      }}
    </AdminPage>
  );
}
