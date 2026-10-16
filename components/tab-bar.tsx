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
 * Une seule liste d'entrées, deux présentations : barre en bas sur téléphone (moins de 768 px), menu latéral fixe à partir de la tablette.
 * Le menu latéral est le premier élément de la grille du gabarit ; la barre du bas est fixe et sort du flot.
 */
function TabBar({ items }: { items: TabItem[] }) {
  const pathname = usePathname();
  return (
    <>
      <aside className="sticky top-0 hidden h-dvh flex-col gap-8 border-r border-line bg-white px-4 py-6 md:flex">
        <div className="px-2">
          <LogoMark size="lg" />
        </div>
        <nav aria-label="Navigation principale" className="stagger flex flex-col gap-1.5">
          {items.map((it) => {
            const active = isActive(pathname, it);
            return (
              <Link
                key={it.href}
                href={it.href}
                aria-current={active ? "page" : undefined}
                className={`press relative flex min-h-12 items-center gap-3 rounded-2xl px-3.5 text-[16px] font-bold ${
                  active ? "bg-brand-soft text-brand" : "text-ink-soft hover:bg-mist hover:text-ink"
                }`}
              >
                <span className="relative">
                  <it.icon className="size-6" strokeWidth={active ? 2.4 : 2} aria-hidden />
                  <Pastilles item={it} />
                </span>
                {it.label}
              </Link>
            );
          })}
        </nav>
      </aside>
      <nav
        aria-label="Navigation principale"
        className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-white/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden"
      >
        <div className="mx-auto grid max-w-xl grid-cols-4">
          {items.map((it) => {
            const active = isActive(pathname, it);
            return (
              <Link
                key={it.href}
                href={it.href}
                aria-current={active ? "page" : undefined}
                className={`press flex min-h-16 flex-col items-center justify-center gap-1 text-[12px] font-bold ${
                  active ? "text-brand" : "text-ink-soft"
                }`}
              >
                <span
                  className={`relative flex h-8 w-14 items-center justify-center rounded-full transition-all duration-300 ${
                    active ? "bg-brand-soft" : "bg-transparent"
                  }`}
                >
                  <it.icon
                    className={`size-6 transition-transform duration-300 ${active ? "scale-110" : ""}`}
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
    </>
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
