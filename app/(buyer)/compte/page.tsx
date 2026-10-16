"use client";

import Link from "next/link";
import {
  ArrowRight,
  Bell,
  CircleHelp,
  CircleUser,
  Handshake,
  Heart,
  Layers,
  LogOut,
  MessageCircle,
  Package,
  Search,
  Settings,
  ShieldCheck,
  Store,
  Wallet,
} from "lucide-react";
import { NotificationPreferencesCard } from "@/components/notification-preferences-card";
import { useLogout } from "@/components/session-gate";
import { useMessagesUnread } from "@/components/messages-badge";
import { useUnreadCount } from "@/components/unread-badge";
import { HeaderBtn } from "@/components/top-bar";
import { Badge, Card, IconTile, MenuRow } from "@/components/ui";
import { useNoma } from "@/lib/store";

export default function MonCompte() {
  const showToast = useNoma((s) => s.showToast);
  const { logout, pending: loggingOut } = useLogout();
  const unread = useUnreadCount();
  const messagesUnread = useMessagesUnread();

  const soon = () => showToast("Bientôt disponible");

  return (
    <main className="flex flex-col gap-5 px-4 pb-6 pt-3">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-[26px] font-extrabold tracking-tight text-ink">Mon compte</h1>
        <HeaderBtn icon={Settings} onClick={soon} label="Réglages" />
      </div>

      <Card className="animate-rise flex items-center gap-4">
        <span className="flex size-16 shrink-0 items-center justify-center rounded-full bg-brand-soft text-brand">
          <CircleUser className="size-9" strokeWidth={1.8} aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[18px] font-extrabold text-ink">Votre compte noma</div>
          <Badge tone="sage" className="mt-1.5">
            <ShieldCheck className="size-3.5" aria-hidden />
            Téléphone confirmé
          </Badge>
        </div>
      </Card>

      <ul className="stagger divide-y divide-line overflow-hidden rounded-3xl border border-line bg-white md:grid md:grid-cols-2 md:gap-3 md:divide-y-0 md:overflow-visible md:rounded-none md:border-0 md:bg-transparent">
        {[
          <MenuRow key="messages" icon={MessageCircle} label="Messages" badge={messagesUnread !== null && messagesUnread > 0 ? messagesUnread : undefined} href="/messages" />,
          <MenuRow key="commandes" icon={Package} label="Mes commandes" href="/commandes" />,
          <MenuRow key="missions" icon={Layers} label="Mes missions" href="/missions" />,
          <MenuRow key="porte-monnaie" icon={Wallet} label="Mon porte-monnaie" href="/compte/porte-monnaie" />,
          <MenuRow key="alertes" icon={Search} label="Mes recherches suivies" href="/alertes" />,
          <MenuRow key="favoris" icon={Heart} label="Mes favoris" href="/favoris" />,
          <MenuRow key="infos" icon={CircleUser} label="Informations personnelles" onClick={soon} />,
          <MenuRow key="notifications" icon={Bell} label="Notifications" badge={unread !== null && unread > 0 ? unread : undefined} href="/notifications" />,
          <MenuRow key="propositions" icon={Handshake} label="Propositions reçues" href="/propositions" />,
          <MenuRow key="signaler" icon={CircleHelp} label="Mes signalements" href="/signaler" />,
        ].map((row) => (
          <li key={row.key} className="md:overflow-hidden md:rounded-3xl md:border md:border-line md:bg-white">
            {row}
          </li>
        ))}
      </ul>

      <div className="[&>*]:mt-0">
        <NotificationPreferencesCard />
      </div>

      <Link
        href="/vendeur"
        className="press animate-rise flex min-h-16 items-center gap-3 rounded-3xl bg-brand-soft p-4 hover:bg-brand-soft/70"
      >
        <IconTile icon={Store} tone="accent" className="size-12" />
        <span className="flex-1 text-[16px] font-extrabold text-ink">Aller à mon espace vendeur</span>
        <ArrowRight className="size-5 shrink-0 text-brand" aria-hidden />
      </Link>

      <button
        onClick={() => void logout()}
        disabled={loggingOut}
        className="press flex min-h-12 w-full items-center justify-center gap-2 rounded-2xl text-[15px] font-bold text-ink-soft hover:bg-mist hover:text-ink disabled:opacity-40"
      >
        <LogOut className="size-5" aria-hidden />
        {loggingOut ? "Déconnexion…" : "Se déconnecter"}
      </button>
    </main>
  );
}
