"use client";

import { AdminPage } from "@/components/admin/admin-page";
import { market } from "@/lib/client/market-api";
import { ADMIN_MARKET_EMPTY, ADMIN_MARKET_NOTE, ADMIN_MARKET_TITLE, MARKET_INSUFFICIENT_TEXT, adminMarketRows, periodText, type ListingsView } from "@/lib/client/market-view";

const load = (signal: AbortSignal) => market.admin({ signal });

function ListingsCell({ view }: { view: ListingsView }) {
  return (
    <td data-testid="admin-market-listings" data-published={view.published ? "true" : "false"} className="px-2 py-2 align-top">
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
          <div data-testid="admin-market">
            <h1 className="font-display text-[22px] font-extrabold text-ink">{ADMIN_MARKET_TITLE}</h1>
            <p className="text-[12px] text-ink-soft">
              {periodText(data.period.days)}. {ADMIN_MARKET_NOTE}
            </p>
            {rows.length === 0 ? (
              <p data-testid="admin-market-empty" className="mt-4 text-center text-[14px] text-ink-soft">
                {ADMIN_MARKET_EMPTY}
              </p>
            ) : (
              <div className="mt-3 overflow-x-auto rounded-2xl border border-line bg-white">
                <table data-testid="admin-market-table" className="w-full text-left text-[12px]">
                  <thead>
                    <tr className="border-b border-line text-[11px] uppercase tracking-wide text-ink-soft">
                      <th className="px-2 py-2 font-semibold">Produit</th>
                      <th className="px-2 py-2 font-semibold">Prix demandés (médiane)</th>
                      <th className="px-2 py-2 font-semibold">Ventes confirmées</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {rows.map((row) => (
                      <tr key={row.key} data-market-row>
                        <th scope="row" className="px-2 py-2 text-left align-top font-semibold text-ink">
                          {row.label}
                        </th>
                        <ListingsCell view={row.listings} />
                        <td data-testid="admin-market-sales" className="px-2 py-2 align-top text-ink">
                          {row.salesText}
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
