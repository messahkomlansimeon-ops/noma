"use client";

import { TrendingUp } from "lucide-react";
import { AdminPage } from "@/components/admin/admin-page";
import { Notice, PageHeading } from "@/components/admin/admin-ui";
import { ArtSearch } from "@/components/illustrations";
import { Badge, EmptyState } from "@/components/ui";
import { market } from "@/lib/client/market-api";
import { ADMIN_MARKET_EMPTY, ADMIN_MARKET_NOTE, ADMIN_MARKET_TITLE, MARKET_INSUFFICIENT_TEXT, adminMarketRows, periodText, type ListingsView } from "@/lib/client/market-view";

const load = (signal: AbortSignal) => market.admin({ signal });

function ListingsCell({ view }: { view: ListingsView }) {
  return (
    <td data-testid="admin-market-listings" data-published={view.published ? "true" : "false"} className="px-3 py-3 align-top">
      {view.published ? (
        <>
          <div className="font-bold text-ink">{view.headline}</div>
          <div className="text-ink-soft">{view.countText}</div>
        </>
      ) : (
        <div className="text-ink-soft">{MARKET_INSUFFICIENT_TEXT}</div>
      )}
    </td>
  );
}

/**
 * Tableau « Marché » (lots H1, H1-bis et H1-ter) : les 20 produits les plus relevés sur 90 jours. Prix demandés avec les mêmes seuils et arrondis que pour les utilisateurs ; ventes confirmées :
 * un NOMBRE arrondi par produit, jamais un prix (les prix de vente ne sont pas publiés). Aucun identifiant n'y figure.
 */
export default function AdminMarche() {
  return (
    <AdminPage title={ADMIN_MARKET_TITLE} back="/admin" load={load}>
      {(data) => {
        const rows = adminMarketRows(data.rows);
        return (
          <div data-testid="admin-market" className="flex flex-col gap-4">
            <PageHeading icon={TrendingUp} tone="success">
              {ADMIN_MARKET_TITLE}
            </PageHeading>
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone="sky">{periodText(data.period.days)}</Badge>
            </div>
            <Notice>{ADMIN_MARKET_NOTE}</Notice>
            {rows.length === 0 ? (
              <div data-testid="admin-market-empty">
                <EmptyState art={<ArtSearch className="size-36" />} title={ADMIN_MARKET_EMPTY} />
              </div>
            ) : (
              <div className="animate-rise overflow-x-auto rounded-3xl border border-line bg-white">
                <table data-testid="admin-market-table" className="w-full text-left text-[14px]">
                  <thead>
                    <tr className="border-b border-line bg-mist/60 text-[12px] uppercase tracking-wide text-ink-soft">
                      <th className="px-3 py-3 font-bold">Produit</th>
                      <th className="px-3 py-3 font-bold">Prix demandés (médiane)</th>
                      <th className="px-3 py-3 font-bold">Ventes confirmées</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {rows.map((row) => (
                      <tr key={row.key} data-market-row>
                        <th scope="row" className="px-3 py-3 text-left align-top font-bold text-ink">
                          {row.label}
                        </th>
                        <ListingsCell view={row.listings} />
                        <td data-testid="admin-market-sales" className="px-3 py-3 align-top text-ink">
                          {row.salesText}
                          {row.historicalText ? (
                            <div data-testid="admin-market-historical" className="text-[12px] text-ink-soft">
                              {row.historicalText}
                            </div>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        );
      }}
    </AdminPage>
  );
}
