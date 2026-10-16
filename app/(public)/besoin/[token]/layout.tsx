import type { Metadata } from "next";
import type { ReactNode } from "react";

/**
 * Page PUBLIQUE d'un besoin partagé (lot FIN3-C4) : hors des espaces acheteur, vendeur et administration (aucune barre d'onglets, aucune garde de session), jamais indexée, et sans en-tête
 * Referer : le jeton est dans l'adresse, il ne doit fuir vers aucun site tiers.
 */
export const metadata: Metadata = {
  title: "Un besoin partagé",
  robots: { index: false, follow: false, nocache: true },
  referrer: "no-referrer",
};

export default function PublicNeedLayout({ children }: { children: ReactNode }) {
  return <div className="mx-auto flex min-h-dvh w-full max-w-2xl flex-col">{children}</div>;
}
