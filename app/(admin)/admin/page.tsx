"use client";

import Link from "next/link";
import {
  Activity,
  ChevronRight,
  CircleCheck,
  CreditCard,
  Crown,
  Globe,
  Handshake,
  MessageCircle,
  Radar,
  Rocket,
  Search,
  ShoppingBag,
  SlidersHorizontal,
  Smartphone,
  Store,
  Tag,
  TrendingUp,
  TriangleAlert,
  Users,
  Wallet,
  type LucideIcon,
} from "lucide-react";
import { AdminPage } from "@/components/admin/admin-page";
import { PageHeading, Panel, StatTile } from "@/components/admin/admin-ui";
import { IconTile, type TileTone } from "@/components/ui";
import { ADMIN_TITLE, summaryTiles, workerView } from "@/lib/client/admin-view";
import { formatDateTimeFr } from "@/lib/client/wallet-view";
import { social } from "@/lib/client/social-api";

const load = (signal: AbortSignal) => social.admin.summary({ signal });

const TILE_LOOK: Record<string, { icon: LucideIcon; tone: TileTone }> = {
  accounts: { icon: Users, tone: "brand" },
  offers: { icon: Tag, tone: "accent" },
  demands: { icon: Search, tone: "info" },
  matches: { icon: Handshake, tone: "success" },
  boosts: { icon: Rocket, tone: "accent" },
  credits: { icon: Wallet, tone: "brand" },
  conversations: { icon: MessageCircle, tone: "info" },
  orders: { icon: ShoppingBag, tone: "success" },
};

const SECTION_LINK = "press flex min-h-16 items-center gap-3 rounded-3xl border border-line bg-white px-4 py-3 hover:border-brand";

function SectionRow({ icon, tone, label }: { icon: LucideIcon; tone: TileTone; label: string }) {
  return (
    <>
      <IconTile icon={icon} tone={tone} className="size-11" />
      <span className="flex-1 text-[16px] font-bold text-ink">{label}</span>
      <ChevronRight className="size-5 shrink-0 text-ink-soft" aria-hidden />
    </>
  );
}

/** Tableau de bord de l'administration (lot D2) : des chiffres réels, lus sur le serveur au moment de l'ouverture. */
export default function Admin() {
  return (
    <AdminPage title={ADMIN_TITLE} back="/" load={load}>
      {(summary) => {
        const worker = workerView(summary.worker);
        return (
          <div data-testid="admin-dashboard" className="flex flex-col gap-4">
            <PageHeading icon={Activity}>{ADMIN_TITLE}</PageHeading>
            <p className="-mt-2 text-[13px] text-ink-soft">Lu le {formatDateTimeFr(summary.readAt)}</p>

            <div className="stagger grid grid-cols-2 gap-3 md:grid-cols-4">
              {summaryTiles(summary).map((tile) => {
                const look = TILE_LOOK[tile.key] ?? { icon: Activity, tone: "brand" as TileTone };
                return <StatTile key={tile.key} tile={tile.key} icon={look.icon} tone={look.tone} label={tile.label} value={tile.value} detail={tile.detail} />;
              })}
            </div>

            <Panel
              icon={worker.healthy ? CircleCheck : TriangleAlert}
              tone={worker.healthy ? "success" : "accent"}
              title={worker.headline}
              titleId="worker-title"
              aria-labelledby="worker-title"
              data-testid="admin-worker"
              data-healthy={worker.healthy ? "true" : "false"}
            >
              <ul className="mt-3 space-y-1 text-[13px] leading-snug text-ink-soft">
                {worker.lines.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </Panel>

            <nav aria-label="Sections" className="stagger grid grid-cols-1 gap-3 md:grid-cols-2">
              <Link href="/admin/vendeurs" className={SECTION_LINK}>
                <SectionRow icon={Store} tone="brand" label="Vendeurs" />
              </Link>
              <Link href="/admin/marche" data-testid="admin-market-link" className={SECTION_LINK}>
                <SectionRow icon={TrendingUp} tone="success" label="Marché" />
              </Link>
              <Link href="/admin/reglages" className={SECTION_LINK}>
                <SectionRow icon={SlidersHorizontal} tone="mist" label="Réglages" />
              </Link>
              <Link href="/admin/offres" data-testid="admin-offers-link" className={SECTION_LINK}>
                <SectionRow icon={Crown} tone="accent" label="Offres Pro" />
              </Link>
              <Link href="/admin/sms" className={SECTION_LINK}>
                <SectionRow icon={Smartphone} tone="info" label="SMS" />
              </Link>
              <Link href="/admin/recherche-active" data-testid="admin-active-search-link" className={SECTION_LINK}>
                <SectionRow icon={Radar} tone="brand" label="Recherche active" />
              </Link>
              <Link href="/admin/collecte" className={SECTION_LINK}>
                <SectionRow icon={Globe} tone="info" label="Collecte externe" />
              </Link>
              <Link href="/admin/paiements" data-testid="admin-payments-link" className={SECTION_LINK}>
                <SectionRow icon={CreditCard} tone="success" label="Paiements" />
              </Link>
            </nav>
          </div>
        );
      }}
    </AdminPage>
  );
}
