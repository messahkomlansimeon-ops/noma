"use client";

import { useRouter } from "next/navigation";
import {
  Bell,
  CircleHelp,
  CircleUser,
  Heart,
  LogOut,
  MessageCircle,
  Package,
  Pencil,
  Search,
  Settings,
  ShieldCheck,
  Store,
  Wallet,
} from "lucide-react";
import { LogoMark } from "@/components/logo";
import { useLogout } from "@/components/session-gate";
import {
  Avatar,
  Badge,
  MenuRow,
} from "@/components/ui";
import { useNoma } from "@/lib/store";

export default function MonCompte() {
  const router = useRouter();
  const setRole = useNoma((s) => s.setRole);
  const showToast = useNoma((s) => s.showToast);
  const { logout, pending: loggingOut } = useLogout();

  const soon = () => showToast("Prototype : écran non maquetté");

  return (
    <main>
      <div className="flex items-center justify-between px-4 py-3">
        <LogoMark />
        <button
          onClick={soon}
          className="flex size-9 items-center justify-center rounded-full text-ink transition hover:bg-wash"
          aria-label="Réglages"
        >
          <Settings className="size-5" strokeWidth={1.8} />
        </button>
      </div>

      <div className="px-4">
        <h1 className="font-display text-[26px] font-extrabold text-ink">
          Mon compte
        </h1>

        <div className="mt-3 flex items-center gap-3.5 rounded-2xl border border-line bg-white p-4">
          <Avatar initials="AO" className="size-14 text-[16px]" />
          <div className="min-w-0 flex-1">
            <div className="text-[16px] font-extrabold text-ink">Alex O.</div>
            <div className="text-[13px] text-ink-soft">+225 07 •• •••• 42</div>
            <Badge tone="sage" className="mt-1">
              <ShieldCheck className="size-3" />
              Téléphone confirmé
            </Badge>
          </div>
          <button
            onClick={soon}
            className="flex size-8 items-center justify-center rounded-full text-ink-soft transition hover:bg-wash"
            aria-label="Modifier"
          >
            <Pencil className="size-4" />
          </button>
        </div>

        <div className="mt-4 divide-y divide-line overflow-hidden rounded-2xl border border-line bg-white">
          <MenuRow icon={MessageCircle} label="Messages" badge={2} href="/messages" />
          <MenuRow icon={Package} label="Mes commandes" badge={3} href="/commandes" />
          <MenuRow icon={Wallet} label="Mon porte-monnaie" href="/compte/porte-monnaie" />
          <MenuRow icon={Search} label="Mes recherches suivies" href="/alertes" />
          <MenuRow icon={Heart} label="Mes favoris" href="/favoris" />
          <MenuRow icon={CircleUser} label="Informations personnelles" onClick={soon} />
          <MenuRow icon={Bell} label="Notifications" onClick={soon} />
          <MenuRow icon={CircleHelp} label="Aide et signalements" onClick={soon} />
        </div>

        <div className="mt-4 rounded-2xl bg-sage p-4">
          <div className="flex items-center gap-2.5">
            <span className="flex size-10 items-center justify-center rounded-full bg-white text-forest">
              <Store className="size-5" strokeWidth={1.9} />
            </span>
            <div>
              <div className="text-[14px] font-extrabold text-ink">
                Vous vendez ?
              </div>
              <div className="text-[12px] text-sage-ink">
                Rejoignez les vendeurs Noma.
              </div>
            </div>
          </div>
          <button
            onClick={() => {
              setRole("vendor");
              router.push("/vendeur");
            }}
            className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl bg-forest py-3 text-[14px] font-bold text-white transition active:scale-[0.99]"
          >
            Devenir vendeur
            <span aria-hidden>›</span>
          </button>
        </div>

        <button
          onClick={() => void logout()}
          disabled={loggingOut}
          className="mt-4 flex w-full items-center justify-center gap-2 py-2 text-[14px] font-bold text-ink-soft transition hover:text-ink disabled:opacity-40"
        >
          <LogOut className="size-4" />
          {loggingOut ? "Déconnexion…" : "Se déconnecter"}
        </button>
      </div>
    </main>
  );
}
