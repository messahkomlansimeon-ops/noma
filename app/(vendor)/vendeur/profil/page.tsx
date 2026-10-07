"use client";

import { LogOut, Phone, Store, Wallet } from "lucide-react";
import { SessionGate, useLogout } from "@/components/session-gate";
import { TopBar } from "@/components/top-bar";
import { Badge, MenuRow } from "@/components/ui";
import { walletHref } from "@/lib/client/wallet-view";

function ProfilVendeur() {
  const { logout, pending: loggingOut } = useLogout();
  return (
    <main>
      <TopBar back="/vendeur" />

      <div className="px-4">
        <h1 className="font-display text-[26px] font-extrabold text-ink">Compte vendeur</h1>

        <div className="mt-3 flex items-center gap-3.5 rounded-2xl border border-line bg-white p-4">
          <span className="flex size-14 shrink-0 items-center justify-center rounded-full bg-sage text-forest">
            <Store className="size-7" strokeWidth={1.7} aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-[16px] font-extrabold text-ink">Votre espace vendeur</div>
            <div className="text-[13px] text-ink-soft">Les acheteurs vous joignent par le numéro de ce compte.</div>
            <Badge tone="sage" className="mt-1">
              <Phone className="size-3" />
              Téléphone confirmé
            </Badge>
          </div>
        </div>

        <p className="mt-3 rounded-2xl bg-wash p-3.5 text-[13px] text-ink-soft">
          Le profil public (nom de boutique, logo, zones desservies) est bientôt disponible.
        </p>

        <div className="mt-4 overflow-hidden rounded-2xl border border-line bg-white">
          <MenuRow icon={Wallet} label="Mon porte-monnaie" href={walletHref({ next: "/vendeur/profil" })} />
        </div>

        <button
          onClick={() => void logout()}
          disabled={loggingOut}
          className="mt-2 flex w-full items-center justify-center gap-2 py-2 text-[14px] font-bold text-ink-soft transition hover:text-ink disabled:opacity-40"
        >
          <LogOut className="size-4" />
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
