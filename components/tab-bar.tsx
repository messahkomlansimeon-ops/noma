"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect } from "react";
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
import { MessagesBadge, messagesRefresher } from "@/components/messages-badge";
import { UnreadBadge, unreadRefresher } from "@/components/unread-badge";

interface TabItem {
  href: string;
  label: string;
  icon: LucideIcon;
  match: string[];
  /** Pastille de notifications non lues sur cet onglet (acheteur : « Alertes »). */
  unread?: boolean;
  /** Pastille de conversations non lues sur cet onglet (lot D2 : acheteur « Compte », vendeur « Messages »). */
  messages?: boolean;
}

/** Les adresses « / », « /vendeur » et « /admin » ne rendent l'onglet actif QUE sur elles-mêmes (sinon il le serait sur toutes les pages de leur espace). */
function TabBar({ items }: { items: TabItem[] }) {
  const pathname = usePathname();
  return (
    <nav className="fixed inset-x-0 bottom-0 z-30 mx-auto w-full max-w-[480px] border-t border-line bg-white/95 pb-[env(safe-area-inset-bottom)] backdrop-blur">
      <div className="grid grid-cols-4">
        {items.map((it) => {
          const active = it.match.some((m) =>
            m === "/" || m === "/vendeur" || m === "/admin" ? pathname === m : pathname.startsWith(m),
          );
          return (
            <Link
              key={it.href}
              href={it.href}
              className={`flex flex-col items-center gap-1 py-2.5 text-[11px] font-semibold transition ${
                active ? "text-forest" : "text-ink-soft"
              }`}
            >
              <span className="relative">
                <it.icon className="size-5" strokeWidth={active ? 2.3 : 1.8} />
                {it.unread ? <UnreadBadge className="absolute -right-2.5 -top-1.5" /> : null}
                {it.messages ? <MessagesBadge className="absolute -right-2.5 -top-1.5" /> : null}
              </span>
              {it.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}

/**
 * Navigation de l'acheteur : la pastille des notifications non lues est sur « Alertes ». Une fois le compteur connu (une page gardée l'a lu, donc la
 * session est confirmée), il est relu à l'arrivée sur chaque page et au retour au premier plan, JAMAIS plus d'une fois par minute.
 */
function useRefreshOnNavigation(pathname: string | null) {
  useEffect(() => {
    if (unreadRefresher.get() !== null) void unreadRefresher.refresh();
    if (messagesRefresher.get() !== null) void messagesRefresher.refresh();
  }, [pathname]);
  useEffect(() => {
    const onForeground = () => {
      if (document.visibilityState !== "visible") return;
      if (unreadRefresher.get() !== null) void unreadRefresher.refresh();
      if (messagesRefresher.get() !== null) void messagesRefresher.refresh();
    };
    document.addEventListener("visibilitychange", onForeground);
    return () => document.removeEventListener("visibilitychange", onForeground);
  }, []);
}

export function BuyerTabBar() {
  const pathname = usePathname();
  useRefreshOnNavigation(pathname);
  return (
    <TabBar
      items={[
        { href: "/", label: "Explorer", icon: Search, match: ["/", "/recherche", "/offre", "/comparer", "/partager"] },
        { href: "/favoris", label: "Favoris", icon: Heart, match: ["/favoris"] },
        { href: "/alertes", label: "Alertes", icon: Bell, match: ["/alertes", "/alerte", "/notifications"], unread: true },
        { href: "/compte", label: "Compte", icon: User, match: ["/compte", "/messages", "/commandes", "/missions", "/signaler", "/propositions", "/inviter"], messages: true },
      ]}
    />
  );
}

export function VendorTabBar() {
  const pathname = usePathname();
  useRefreshOnNavigation(pathname);
  return (
    <TabBar
      items={[
        { href: "/vendeur", label: "Accueil", icon: House, match: ["/vendeur", "/vendeur/commandes", "/vendeur/devis", "/vendeur/demandes"] },
        { href: "/vendeur/messages", label: "Messages", icon: MessageCircle, match: ["/vendeur/messages"], messages: true },
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
