import type { Metadata, Viewport } from "next";
import { Bricolage_Grotesque, Manrope } from "next/font/google";
import "./globals.css";
import { RoleSwitcher } from "@/components/role-switcher";
import { Toast } from "@/components/toast";

const bricolage = Bricolage_Grotesque({
  subsets: ["latin"],
  variable: "--font-bricolage",
});

const manrope = Manrope({
  subsets: ["latin"],
  variable: "--font-manrope",
});

export const metadata: Metadata = {
  title: {
    default: "noma · Votre recherche, simplifiée",
    template: "%s · noma",
  },
  description:
    "noma aide les acheteurs en Côte d'Ivoire à trouver, comparer et suivre les meilleures offres de produits et services.",
};

export const viewport: Viewport = {
  themeColor: "#faf8f1",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="fr"
      className={`${bricolage.variable} ${manrope.variable} h-full antialiased`}
    >
      <body className="min-h-dvh bg-cream font-sans text-ink">
        {children}
        <RoleSwitcher />
        <Toast />
      </body>
    </html>
  );
}
