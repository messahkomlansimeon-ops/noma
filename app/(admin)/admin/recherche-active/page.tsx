"use client";

import { AdminPage } from "@/components/admin/admin-page";
import { ActiveSearchAdmin } from "@/components/admin/active-search-admin";
import { activeSearchApi } from "@/lib/client/active-search-api";

const load = (signal: AbortSignal) => activeSearchApi.adminOverview.read({ signal });

/** Administration de la recherche active payante (lot RA1) : options en vigueur arrondies à 5 près, revenus du mois. Un non-administrateur reçoit le 404 « Page introuvable. ». */
export default function AdminRechercheActive() {
  return (
    <AdminPage title="Recherche active" back="/admin" load={load}>
      {(overview) => <ActiveSearchAdmin overview={overview} />}
    </AdminPage>
  );
}
