"use client";

import { WalletPage } from "@/components/wallet/wallet-screen";

/** Lot FIN1 : le porte-monnaie du vendeur dans l'espace vendeur (même écran que celui de l'acheteur, barre d'onglets vendeur). */
export default function PorteMonnaieVendeurPage() {
  return <WalletPage space="vendor" />;
}
