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
import { LogoMark } from "@/components/logo";
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
function isActive(pathname: string | null, item: TabItem): boolean {
  return item.match.some((m) =>
    m === "/" || m === "/vendeur" || m === "/admin" ? pathname === m : (pathname ?? "").startsWith(m),
  );
}

function Pastilles({ item }: { item: TabItem }) {
  return (
    <>
      {item.unread ? <UnreadBadge className="absolute -right-3 -top-2" /> : null}
      {item.messages ? <MessagesBadge className="absolute -right-3 -top-2" /> : null}
    </>
  );
}

/**
 * Une seule liste d'entrées, UN SEUL élément `<nav>` (donc chaque pastille et chaque repère n'existent qu'une fois) : barre fixe en bas sur téléphone, menu latéral collant à gauche
 * à partir de 768 px. Sur grand écran, le menu est le premier élément de la grille du gabarit.
 */
function TabBar({ items }: { items: TabItem[] }) {
  const pathname = usePathname();
  return (
    <nav
      aria-label="Navigation principale"
      className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-white/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:sticky md:inset-x-auto md:bottom-auto md:top-0 md:flex md:h-dvh md:flex-col md:gap-8 md:border-r md:border-t-0 md:bg-white md:px-4 md:py-6 md:pb-6"
    >
      <div className="hidden px-2 md:block">
        <LogoMark size="lg" />
      </div>
      <div className="mx-auto grid w-full max-w-xl grid-cols-4 md:mx-0 md:flex md:max-w-none md:flex-col md:gap-1.5">
        {items.map((it) => {
          const active = isActive(pathname, it);
          return (
            <Link
              key={it.href}
              href={it.href}
              aria-current={active ? "page" : undefined}
              className={`press flex min-h-16 flex-col items-center justify-center gap-1 text-[12px] font-bold md:min-h-12 md:flex-row md:justify-start md:gap-3 md:rounded-2xl md:px-3.5 md:text-[16px] ${
                active ? "text-brand md:bg-brand-soft" : "text-ink-soft md:hover:bg-mist md:hover:text-ink"
              }`}
            >
              <span
                className={`relative flex h-8 w-14 items-center justify-center rounded-full transition-all duration-300 md:h-auto md:w-auto md:bg-transparent ${
                  active ? "bg-brand-soft" : "bg-transparent"
                }`}
              >
                <it.icon
                  className={`size-6 transition-transform duration-300 ${active ? "scale-110 md:scale-100" : ""}`}
                  strokeWidth={active ? 2.4 : 2}
                  aria-hidden
                />
                <Pastilles item={it} />
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
        { href: "/", label: "Explorer", icon: Search, match: ["/", "/recherche"] },
        { href: "/favoris", label: "Favoris", icon: Heart, match: ["/favoris"] },
        { href: "/alertes", label: "Alertes", icon: Bell, match: ["/alertes", "/alerte", "/notifications"], unread: true },
        { href: "/compte", label: "Compte", icon: User, match: ["/compte", "/messages", "/commandes", "/missions", "/signaler", "/propositions"], messages: true },
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
        { href: "/vendeur/profil", label: "Compte", icon: User, match: ["/vendeur/profil", "/vendeur/porte-monnaie"] },
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
