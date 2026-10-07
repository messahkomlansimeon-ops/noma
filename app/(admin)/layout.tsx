import type { ReactNode } from "react";
import { RoleSwitcher } from "@/components/role-switcher";
import { AdminTabBar } from "@/components/tab-bar";
import { requireAdminSpace } from "@/lib/server/admin/space-guard";

/**
 * Espace d'administration : un compte connecté qui n'est pas administrateur obtient la page 404 standard de Next (lot D3), sans titre ni sélecteur d'espace ; un visiteur sans session
 * est renvoyé vers la connexion par la garde de session de chaque page. L'autorisation réelle reste celle des routes /api/admin/*.
 */
export default async function AdminLayout({ children }: { children: ReactNode }) {
  await requireAdminSpace();
  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-[480px] flex-col bg-cream sm:border-x sm:border-line">
      <RoleSwitcher />
      <div className="flex-1 pb-28">{children}</div>
      <AdminTabBar />
    </div>
  );
}
