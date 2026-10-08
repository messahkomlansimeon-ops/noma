"use client";

import { AdminPage } from "@/components/admin/admin-page";
import { PaymentsAdmin } from "@/components/admin/payments-admin";
import { paymentsAdminApi } from "@/lib/client/payments-admin-api";

const load = (signal: AbortSignal) => paymentsAdminApi.adminPayments.overview({ signal });

/** Administration des paiements (lot PAY1) : intentions récentes, anomalies de rapprochement, état du rattrapage. Sous le gabarit gardé de l'espace d'administration (page 404 standard pour un non-administrateur). */
export default function AdminPaiements() {
  return (
    <AdminPage title="Paiements" back="/admin" load={load}>
      {(overview, reload) => <PaymentsAdmin overview={overview} reload={reload} />}
    </AdminPage>
  );
}
