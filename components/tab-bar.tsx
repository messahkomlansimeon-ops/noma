"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Bell,
  FolderOpen,
  Heart,
  House,
  MessageCircle,
  Search,
  Settings,
  Store,
  Tag,
  User,
  type LucideIcon,
} from "lucide-react";

interface TabItem {
  href: string;
  label: string;
  icon: LucideIcon;
  match: string[];
}

function TabBar({ items }: { items: TabItem[] }) {
  const pathname = usePathname();
  return (
    <nav className="fixed inset-x-0 bottom-0 z-30 mx-auto w-full max-w-[480px] border-t border-line bg-white/95 pb-[env(safe-area-inset-bottom)] backdrop-blur">
      <div className="grid grid-cols-4">
        {items.map((it) => {
          const active = it.match.some((m) =>
            m === "/" ? pathname === "/" : pathname.startsWith(m),
          );
          return (
            <Link
              key={it.href}
              href={it.href}
              className={`flex flex-col items-center gap-1 py-2.5 text-[11px] font-semibold transition ${
                active ? "text-forest" : "text-ink-soft"
              }`}
            >
              <it.icon className="size-5" strokeWidth={active ? 2.3 : 1.8} />
              {it.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}

export function BuyerTabBar() {
  return (
    <TabBar
      items={[
        { href: "/", label: "Explorer", icon: Search, match: ["/", "/recherche", "/offre", "/comparer", "/partager"] },
        { href: "/favoris", label: "Favoris", icon: Heart, match: ["/favoris"] },
        { href: "/alertes", label: "Alertes", icon: Bell, match: ["/alertes", "/alerte"] },
        { href: "/compte", label: "Compte", icon: User, match: ["/compte", "/messages", "/commandes", "/signaler", "/propositions", "/inviter"] },
      ]}
    />
  );
}

export function VendorTabBar() {
  return (
    <TabBar
      items={[
        { href: "/vendeur", label: "Accueil", icon: House, match: ["/vendeur", "/vendeur/commandes", "/vendeur/devis"] },
        { href: "/vendeur/demandes", label: "Demandes", icon: MessageCircle, match: ["/vendeur/demandes"] },
        { href: "/vendeur/annonces", label: "Annonces", icon: Tag, match: ["/vendeur/annonces"] },
        { href: "/vendeur/profil", label: "Compte", icon: User, match: ["/vendeur/profil"] },
      ]}
    />
  );
}

export function AdminTabBar() {
  return (
    <TabBar
      items={[
        { href: "/admin", label: "Aperçu", icon: House, match: ["/admin"] },
        { href: "/admin/dossiers", label: "Dossiers", icon: FolderOpen, match: ["/admin/dossiers"] },
        { href: "/admin/vendeurs", label: "Vendeurs", icon: Store, match: ["/admin/vendeurs"] },
        { href: "/admin/reglages", label: "Réglages", icon: Settings, match: ["/admin/reglages"] },
      ]}
    />
  );
}
