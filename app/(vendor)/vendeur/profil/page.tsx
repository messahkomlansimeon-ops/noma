"use client";

import { BadgeCheck, LogOut, MessageCircle, Package, Phone, Store, Upload, Wallet } from "lucide-react";
import { SessionGate, useLogout } from "@/components/session-gate";
import { TopBar } from "@/components/top-bar";
import { Badge, MenuRow } from "@/components/ui";
import { BTN_OUTLINE } from "@/components/vendor/vendor-parts";
import { IMPORT_PAGE_PATH, PRO_PAGE_PATH, PRO_PAGE_TITLE } from "@/lib/client/pro-view";
import { walletHref } from "@/lib/client/wallet-view";

function ProfilVendeur() {
  const { logout, pending: loggingOut } = useLogout();
  return (
    <main>
      <TopBar back="/vendeur" />

      <div className="flex flex-col gap-5 px-4 pb-6 pt-2">
        <div className="animate-rise flex items-center gap-4 rounded-[2rem] bg-brand-soft p-5">
          <span className="flex size-16 shrink-0 items-center justify-center rounded-full bg-white text-brand">
            <Store className="size-8" strokeWidth={1.8} aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <h1 className="text-[24px] font-extrabold leading-tight tracking-tight text-ink">Compte vendeur</h1>
            <Badge tone="sage" className="mt-2">
              <Phone className="size-3.5" aria-hidden />
              Téléphone confirmé
            </Badge>
          </div>
        </div>

        <div className="divide-y divide-line overflow-hidden rounded-3xl border border-line bg-white">
          <MenuRow icon={MessageCircle} label="Messages" href="/vendeur/messages" />
          <MenuRow icon={Package} label="Commandes" href="/vendeur/commandes" />
          <MenuRow icon={Wallet} label="Mon porte-monnaie" href={walletHref({ next: "/vendeur/profil" })} />
          <MenuRow icon={BadgeCheck} label={PRO_PAGE_TITLE} href={PRO_PAGE_PATH} />
          <MenuRow icon={Upload} label="Importer un catalogue" href={IMPORT_PAGE_PATH} />
        </div>

        <button onClick={() => void logout()} disabled={loggingOut} className={BTN_OUTLINE}>
          <LogOut className="size-5" aria-hidden />
          {loggingOut ? "Déconnexion…" : "Se déconnecter"}
        </button>
      </div>
    </main>
  );
}

export default function ProfilVendeurPage() {
  return (
    <SessionGate>
      <ProfilVendeur />
    </SessionGate>
  );
}
