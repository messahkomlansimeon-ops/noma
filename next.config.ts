import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Accès au serveur de dev depuis le LAN (téléphone) et via localtunnel.
  allowedDevOrigins: ["192.168.100.43", "*.loca.lt"],
};

export default nextConfig;