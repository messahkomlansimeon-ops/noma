"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { ShieldCheck, ShoppingBag, Store, type LucideIcon } from "lucide-react";
import { readSharedSession } from "@/lib/client/session-shared";

export type DemoRole = "buyer" | "vendor" | "admin";

const defs: { role: DemoRole; label: string; href: string }[] = [
  { role: "buyer", label: "Acheteur", href: "/" },
  { role: "vendor", label: "Vendeur", href: "/vendeur" },
  { role: "admin", label: "Admin", href: "/admin" },
];

const roleIcons: Record<DemoRole, LucideIcon> = { buyer: ShoppingBag, vendor: Store, admin: ShieldCheck };

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
    <nav aria-label="Changer d'espace" className="flex items-center justify-center border-b border-line bg-white px-3 py-2" data-role-switcher>
      <div className="flex gap-1 rounded-full bg-mist p-1">
        {roleTabs(isAdmin).map((d) => {
          const Icon = roleIcons[d.role];
          const current = d.role === role;
          return (
            <Link
              key={d.role}
              href={d.href}
              aria-current={current ? "page" : undefined}
              className={`press flex min-h-9 items-center gap-1.5 rounded-full px-3.5 text-[13px] font-bold transition-colors ${
                current ? "bg-brand text-white shadow-sm" : "text-ink-soft hover:text-ink"
              }`}
            >
              <Icon className="size-4" strokeWidth={2.2} aria-hidden />
              {d.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
