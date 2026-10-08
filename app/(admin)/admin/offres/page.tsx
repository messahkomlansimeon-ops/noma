"use client";

import { AdminPage } from "@/components/admin/admin-page";
import { OffersAdmin } from "@/components/admin/offers-admin";
import { proApi } from "@/lib/client/pro-api";

const load = (signal: AbortSignal) => proApi.adminPlans.overview({ signal });

/** Administration des offres Pro (lot PRO1) : versions des plans, abonnés arrondis, revenus du mois, nouvelle version. Un non-administrateur reçoit le 404 « Page introuvable. ». */
export default function AdminOffres() {
  return (
    <AdminPage title="Offres Pro" back="/admin" load={load}>
      {(overview, reload) => <OffersAdmin overview={overview} reload={reload} />}
    </AdminPage>
  );
}
