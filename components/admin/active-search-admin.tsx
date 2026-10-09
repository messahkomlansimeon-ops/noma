"use client";

import type { AdminActiveSearchOverview } from "@/lib/client/active-search-api";
import { ADMIN_ACTIVE_SEARCH_NOTE, ADMIN_ACTIVE_SEARCH_TITLE } from "@/lib/client/active-search-view";
import { approximateText } from "@/lib/client/pro-view";
import { formatDateFr, formatFcfa } from "@/lib/client/wallet-view";

/**
 * Administration de la recherche active (lot RA1), en LECTURE SEULE : nombre de besoins avec une option en vigueur (ARRONDI à 5 près, jamais un compte exact) et revenus du mois lus dans
 * le grand livre (nets des remboursements). Le prix est PROVISOIRE ; le remboursement d'un achat est une commande d'administration, pas un écran.
 */
export function ActiveSearchAdmin({ overview }: { overview: AdminActiveSearchOverview }) {
  return (
    <div data-testid="admin-active-search">
      <h1 className="font-display text-[22px] font-extrabold text-ink">{ADMIN_ACTIVE_SEARCH_TITLE}</h1>
      <p data-testid="admin-active-search-provisional" className="mt-1 rounded-lg bg-carrot-soft px-3 py-2 text-[12px] font-semibold text-carrot-ink">{ADMIN_ACTIVE_SEARCH_NOTE}</p>
      <p className="mt-1 text-[12px] text-ink-soft">Lu le {formatDateFr(overview.readAt)}</p>
      <div className="mt-3 grid grid-cols-2 gap-2.5">
        <div data-tile="active" className="rounded-2xl border border-line bg-white p-3">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-soft">Options en vigueur</div>
          <div data-tile-value className="font-display text-[22px] font-extrabold leading-tight text-ink">{approximateText(overview.activeApproximate)}</div>
          <div className="text-[11px] leading-snug text-ink-soft">Besoins concernés, arrondi à 5 près.</div>
        </div>
        <div data-tile="revenue" className="rounded-2xl border border-line bg-white p-3">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-soft">Revenus du mois</div>
          <div data-tile-value className="font-display text-[22px] font-extrabold leading-tight text-ink">{formatFcfa(overview.revenueXof)}</div>
          <div className="text-[11px] leading-snug text-ink-soft">Nets des remboursements.</div>
        </div>
      </div>
    </div>
  );
}
