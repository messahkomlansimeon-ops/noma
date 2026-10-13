import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Accès au serveur de dev depuis le LAN (téléphone) et via localtunnel.
  allowedDevOrigins: ["192.168.100.43", "*.loca.lt"],
  // Lot FIN1 : dans `dev:try` (le relais pose NOMA_DEV_PROXY=1), l'indicateur de développement de Next (la pastille « N » en bas à gauche) est masqué : il se superposait à la barre
  // d'onglets et interceptait les clics sur « Explorer ». Option documentée de Next 16 (`devIndicators: false`) ; les erreurs de compilation restent affichées. Inchangé hors dev:try.
  ...(process.env.NOMA_DEV_PROXY === "1" ? { devIndicators: false as const } : {}),
};

export default nextConfig;
