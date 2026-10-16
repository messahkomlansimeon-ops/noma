"use client";

import { BadgeCheck } from "lucide-react";
import { PRO_BADGE_LABEL, PRO_BADGE_NOTICE } from "@/lib/client/pro-view";

/**
 * Badge « Vendeur Pro » (lot PRO1) : présent seulement quand le SERVEUR dit que le vendeur a un abonnement Pro en vigueur (`proBadge`). Il ne change ni la pertinence, ni le
 * classement, et ne promet rien : le texte honnête est au survol (`title`) et, sur la fiche (`withNotice`), écrit en dessous.
 */
export function ProBadge({ withNotice = false }: { withNotice?: boolean }) {
  return (
    <span data-testid="pro-badge" className="inline-flex flex-col items-start gap-1">
      <span
        title={PRO_BADGE_NOTICE}
        className="inline-flex items-center gap-1 rounded-full bg-brand-soft px-2.5 py-1 text-[12px] font-extrabold leading-tight text-brand-ink"
      >
        <BadgeCheck className="size-3.5" aria-hidden />
        {PRO_BADGE_LABEL}
      </span>
      {withNotice ? (
        <span data-testid="pro-badge-notice" className="text-[13px] text-ink-soft">
          {PRO_BADGE_NOTICE}
        </span>
      ) : null}
    </span>
  );
}
