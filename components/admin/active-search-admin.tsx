"use client";

import { Radar, Wallet } from "lucide-react";
import { Notice, PageHeading, StatTile } from "@/components/admin/admin-ui";
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
    <div data-testid="admin-active-search" className="flex flex-col gap-4">
      <PageHeading icon={Radar}>{ADMIN_ACTIVE_SEARCH_TITLE}</PageHeading>
      <Notice tone="accent" data-testid="admin-active-search-provisional">
        {ADMIN_ACTIVE_SEARCH_NOTE}
      </Notice>
      <p className="-mt-2 text-[13px] text-ink-soft">Lu le {formatDateFr(overview.readAt)}</p>
      <div className="stagger grid grid-cols-2 gap-3">
        <StatTile tile="active" icon={Radar} tone="brand" label="Options en vigueur" value={approximateText(overview.activeApproximate)} detail="Besoins concernés, arrondi à 5 près." />
        <StatTile tile="revenue" icon={Wallet} tone="success" label="Revenus du mois" value={formatFcfa(overview.revenueXof)} detail="Nets des remboursements." />
      </div>
    </div>
  );
}
