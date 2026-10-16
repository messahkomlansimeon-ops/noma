import type { ReactNode } from "react";
import { ArtAlert } from "@/components/illustrations";
import { RoleSwitcher } from "@/components/role-switcher";
import { AdminTabBar } from "@/components/tab-bar";
import { requireAdminSpace } from "@/lib/server/admin/space-guard";

/**
 * Espace d'administration : un compte connecté qui n'est pas administrateur obtient la page 404 standard de Next (lot D3), sans titre ni sélecteur d'espace ; un visiteur sans session
 * est renvoyé vers la connexion par la garde de session de chaque page. L'autorisation réelle reste celle des routes /api/admin/*.
 */
export default async function AdminLayout({ children }: { children: ReactNode }) {
  if ((await requireAdminSpace()) === "unavailable") {
    // Session illisible (base indisponible) : même texte que la garde de session des pages, sans page d'erreur de Next.
    return (
      <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col items-center justify-center gap-4 px-6 text-center" role="alert">
        <ArtAlert />
        <p className="text-[17px] font-bold text-ink">Le service est temporairement indisponible.</p>
      </main>
    );
  }
  return (
    <div className="min-h-dvh md:grid md:grid-cols-[17rem_minmax(0,1fr)]">
      <AdminTabBar />
      <div className="flex min-w-0 flex-col">
        <RoleSwitcher />
        <div className="mx-auto w-full max-w-5xl flex-1 pb-28 md:pb-12">{children}</div>
      </div>
    </div>
  );
}
