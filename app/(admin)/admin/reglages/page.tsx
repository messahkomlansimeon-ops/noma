"use client";

import { AdminPage } from "@/components/admin/admin-page";
import { SETTINGS_NOTE, SETTINGS_TITLE, settingsRows } from "@/lib/client/admin-view";
import { social } from "@/lib/client/social-api";

const load = (signal: AbortSignal) => social.admin.settings({ signal });

/** Réglages du boost par catégorie (lot D2) : lecture seule. */
export default function AdminReglages() {
  return (
    <AdminPage title="Réglages" back="/admin" load={load}>
      {(settings) => (
        <div data-testid="admin-settings">
          <h1 className="font-display text-[22px] font-extrabold text-ink">{SETTINGS_TITLE}</h1>
          <p className="text-[12px] text-ink-soft">{SETTINGS_NOTE}</p>
          <div className="mt-3 space-y-2.5">
            {settingsRows(settings).map((row) => (
              <section key={row.key} data-settings-key={row.key} className="rounded-2xl border border-line bg-white p-4">
                <h2 className="text-[14px] font-extrabold text-ink">{row.title}</h2>
                <ul className="mt-1.5 space-y-0.5 text-[12px] text-ink-soft">
                  {row.lines.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        </div>
      )}
    </AdminPage>
  );
}
