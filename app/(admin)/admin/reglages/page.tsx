"use client";

import { Rocket, SlidersHorizontal } from "lucide-react";
import { AdminPage } from "@/components/admin/admin-page";
import { Notice, PageHeading, Panel } from "@/components/admin/admin-ui";
import { SETTINGS_NOTE, SETTINGS_TITLE, settingsRows } from "@/lib/client/admin-view";
import { social } from "@/lib/client/social-api";

const load = (signal: AbortSignal) => social.admin.settings({ signal });

/** Réglages du boost par catégorie (lot D2) : lecture seule. */
export default function AdminReglages() {
  return (
    <AdminPage title="Réglages" back="/admin" load={load}>
      {(settings) => (
        <div data-testid="admin-settings" className="flex flex-col gap-4">
          <PageHeading icon={SlidersHorizontal} tone="mist">
            {SETTINGS_TITLE}
          </PageHeading>
          <Notice>{SETTINGS_NOTE}</Notice>
          <div className="stagger flex flex-col gap-3 md:grid md:grid-cols-2 md:items-start">
            {settingsRows(settings).map((row) => (
              <Panel key={row.key} icon={Rocket} tone="accent" title={row.title} data-settings-key={row.key}>
                <ul className="mt-3 space-y-1 text-[14px] leading-snug text-ink-soft">
                  {row.lines.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              </Panel>
            ))}
          </div>
        </div>
      )}
    </AdminPage>
  );
}
