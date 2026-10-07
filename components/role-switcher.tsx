"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { readSharedSession } from "@/lib/client/session-shared";

export type DemoRole = "buyer" | "vendor" | "admin";

const defs: { role: DemoRole; label: string; href: string }[] = [
  { role: "buyer", label: "Acheteur", href: "/" },
  { role: "vendor", label: "Vendeur", href: "/vendeur" },
  { role: "admin", label: "Admin", href: "/admin" },
];

/** Onglets du sélecteur : l'onglet Admin n'existe QUE pour un administrateur (lot D3) ; les comptes ordinaires et les visiteurs ne le voient jamais. */
export function roleTabs(isAdmin: boolean): readonly { role: DemoRole; label: string; href: string }[] {
  return isAdmin ? defs : defs.filter((definition) => definition.role !== "admin");
}

/** Rôle montré d'après l'adresse de la page : les trois espaces ont chacun leur préfixe (aucun état à synchroniser). */
export function roleOfPath(pathname: string | null): DemoRole {
  if (pathname === "/vendeur" || pathname?.startsWith("/vendeur/")) return "vendor";
  if (pathname === "/admin" || pathname?.startsWith("/admin/")) return "admin";
  return "buyer";
}

/**
 * Sélecteur d'espace (lot D1) : une barre fine EN HAUT de la page, dans le flot du document (jamais superposée aux titres ni aux boutons, même à 390 px de large).
 * Liens ordinaires : Acheteur, Vendeur et, SEULEMENT pour un administrateur, Admin ; l'espace courant est marqué. L'information vient de la lecture de session (`isAdmin`, un booléen) ; tant
 * qu'elle n'est pas connue (et sans session, ou en cas de panne), l'onglet Admin n'est pas affiché. L'autorisation réelle reste celle du serveur (404 pour tout autre compte).
 */
export function RoleSwitcher() {
  const role = roleOfPath(usePathname());
  const [isAdmin, setIsAdmin] = useState(false);
  useEffect(() => {
    let current = true;
    readSharedSession().then(
      (outcome) => {
        if (current) setIsAdmin(outcome.kind === "authenticated" && outcome.isAdmin === true);
      },
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, []);
  return (
    <nav aria-label="Changer d'espace" className="flex items-center justify-center gap-1.5 border-b border-line bg-white px-3 py-1.5" data-role-switcher>
      <span className="mr-1 text-[10px] font-extrabold uppercase tracking-wider text-ink-soft">Démo</span>
      {roleTabs(isAdmin).map((d) => (
        <Link
          key={d.role}
          href={d.href}
          aria-current={d.role === role ? "page" : undefined}
          className={`rounded-full px-3 py-1 text-[11px] font-extrabold uppercase tracking-wide transition ${
            d.role === role ? "bg-ink text-white" : "border border-line bg-white text-ink hover:bg-wash"
          }`}
        >
          {d.label}
        </Link>
      ))}
    </nav>
  );
}
