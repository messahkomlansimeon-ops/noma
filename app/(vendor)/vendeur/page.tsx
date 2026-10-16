"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { ChevronRight, FileText, Inbox, MessageCircle, Package, Pause, Plus, Radio, Tag, Users, Wallet, Zap, type LucideIcon } from "lucide-react";
import { ArtStore } from "@/components/illustrations";
import { LogoMark } from "@/components/logo";
import { MessagesBadge, MessagesUnreadSync } from "@/components/messages-badge";
import { Sheet } from "@/components/modal";
import { SessionGate, useUnauthorizedRedirect } from "@/components/session-gate";
import { Thumb } from "@/components/thumb";
import { Badge, EmptyState, IconTile, StatCard } from "@/components/ui";
import { ErrorState, LoadingBlock, SectionHeading } from "@/components/vendor/vendor-parts";
import { NouvelleAnnonceForm } from "@/components/vendor/nouvelle-annonce-form";
import { api, describeApiError, type VendorHome } from "@/lib/client/api";
import {
  NO_BOOST_MESSAGE,
  NO_OFFER_MESSAGE,
  PUBLISH_OFFER_LABEL,
  VENDOR_HOME_LOADING,
  VENDOR_HOME_TITLE,
  VENDOR_NEEDS_NOTE,
  WALLET_LINK_LABEL,
  vendorHomeView,
} from "@/lib/client/home-view";
import { walletHref } from "@/lib/client/wallet-view";

const TILE_ICONS: Record<string, LucideIcon> = { "En ligne": Radio, "En pause": Pause, Brouillons: FileText };

type State = { kind: "loading" } | { kind: "ready"; home: VendorHome } | { kind: "error"; message: string };

function Dashboard() {
  const redirectIfUnauthorized = useUnauthorizedRedirect();
  const [state, setState] = useState<State>({ kind: "loading" });
  const [reloadKey, setReloadKey] = useState(0);
  const [sheet, setSheet] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    api.home.vendor({ signal: controller.signal }).then(
      (home) => setState({ kind: "ready", home }),
      (failure) => {
        if (controller.signal.aborted || redirectIfUnauthorized(failure)) return;
        setState({ kind: "error", message: describeApiError(failure) });
      },
    );
    return () => controller.abort();
  }, [reloadKey, redirectIfUnauthorized]);

  const reload = useCallback(() => {
    setState({ kind: "loading" });
    setReloadKey((key) => key + 1);
  }, []);

  if (state.kind === "loading") {
    return (
      <main className="flex flex-col gap-4 px-4 pt-6">
        <LoadingBlock label={VENDOR_HOME_LOADING} rows={1} rowClassName="h-24 w-full rounded-[2rem]" />
        <LoadingBlock label="" rows={2} rowClassName="h-20 w-full rounded-3xl" />
      </main>
    );
  }
  if (state.kind === "error") {
    return (
      <main className="flex min-h-[60dvh] items-center justify-center px-6">
        <ErrorState message={state.message} onRetry={reload} />
      </main>
    );
  }

  const view = vendorHomeView(state.home);
  const cardLink = "press flex min-h-16 items-center gap-3 rounded-3xl border border-line bg-white p-3.5 hover:border-brand";
  return (
    <main className="flex flex-col gap-6 px-4 pb-6 pt-3">
      <MessagesUnreadSync />
      <div className="flex items-center justify-between gap-3">
        <span className="md:hidden">
          <LogoMark />
        </span>
        <h1 className="hidden text-[26px] font-extrabold tracking-tight text-ink md:block">{VENDOR_HOME_TITLE}</h1>
        <Link
          href={walletHref({ next: "/vendeur" })}
          className="press flex min-h-11 items-center gap-2 rounded-full border border-line-strong bg-white px-4 text-[14px] font-bold text-ink hover:border-brand"
        >
          <Wallet className="size-5 text-brand" aria-hidden />
          {WALLET_LINK_LABEL}
        </Link>
      </div>

      <button
        onClick={() => setSheet(true)}
        className="press animate-rise relative flex min-h-24 w-full items-center gap-4 overflow-hidden rounded-[2rem] bg-brand px-5 py-4 text-left text-white shadow-[0_14px_30px_-14px_rgb(43_63_214/0.9)]"
      >
        <span className="flex size-14 shrink-0 items-center justify-center rounded-2xl bg-accent text-ink">
          <Plus className="size-8" strokeWidth={2.6} aria-hidden />
        </span>
        <span className="text-[22px] font-extrabold leading-tight">{PUBLISH_OFFER_LABEL}</span>
        <span aria-hidden className="absolute -right-6 -top-6 size-28 rounded-full bg-white/10" />
        <span aria-hidden className="absolute -bottom-8 right-10 size-20 rounded-full bg-white/10" />
      </button>

      <section className="flex flex-col gap-3">
        <h1 className="text-[20px] font-extrabold tracking-tight text-ink md:hidden">{VENDOR_HOME_TITLE}</h1>
        <div className="stagger grid grid-cols-3 gap-2.5">
          {view.tiles.map((tile) => (
            <div key={tile.label} className="min-w-0" data-tile={tile.label}>
              <StatCard icon={TILE_ICONS[tile.label] ?? Radio} value={Number(tile.value)} label={tile.label} tone={tile.tone === "sage" || tile.tone === "carrot" ? tile.tone : "wash"} />
            </div>
          ))}
        </div>

        <div className="animate-rise flex items-center gap-3 rounded-3xl bg-brand-soft p-4" data-vendor-needs>
          <span className="flex size-12 shrink-0 items-center justify-center rounded-2xl bg-white text-brand">
            <Users className="size-6" aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-[16px] font-extrabold leading-snug text-brand-ink">{view.needsText}</div>
            <div className="mt-0.5 text-[13px] leading-snug text-brand-ink">{VENDOR_NEEDS_NOTE}</div>
          </div>
        </div>
      </section>

      <section className="stagger flex flex-col gap-3 md:grid md:grid-cols-2">
        <Link href={walletHref({ next: "/vendeur" })} className="press flex min-h-20 items-center gap-3 rounded-3xl border border-line bg-white p-4 hover:border-brand">
          <IconTile icon={Wallet} tone="success" className="size-12" />
          <span className="min-w-0 flex-1">
            <span className="block text-[13px] font-semibold text-ink-soft">Solde du porte-monnaie</span>
            <span className="block text-[22px] font-extrabold leading-tight text-ink" data-wallet-balance>
              {view.walletText}
            </span>
          </span>
          <ChevronRight className="size-5 shrink-0 text-ink-soft" aria-hidden />
        </Link>
        <div className="flex items-start gap-3 rounded-3xl border border-line bg-white p-4">
          <IconTile icon={Zap} tone="accent" className="size-12" />
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-semibold text-ink-soft">Boosts actifs</div>
            {view.hasBoosts ? (
              <ul className="mt-1 space-y-1" data-active-boosts>
                {view.boosts.map((boost) => (
                  <li key={boost.offerId} className="text-[13px] leading-snug text-ink">
                    <span className="block truncate font-bold">{boost.title}</span>
                    <span className="text-ink-soft">{boost.text}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="mt-0.5 text-[15px] font-bold text-ink">{NO_BOOST_MESSAGE}</div>
            )}
          </div>
        </div>
      </section>

      <section className="stagger grid grid-cols-2 gap-3 md:grid-cols-3" data-vendor-links>
        <Link href="/vendeur/messages" data-testid="vendor-messages-link" className={cardLink}>
          <IconTile icon={MessageCircle} tone="brand" />
          <span className="flex min-w-0 flex-1 items-center justify-between gap-2 text-[15px] font-bold text-ink">
            Messages
            <MessagesBadge />
          </span>
        </Link>
        <Link href="/vendeur/commandes" data-testid="vendor-orders-link" className={cardLink}>
          <IconTile icon={Package} tone="success" />
          <span className="text-[15px] font-bold text-ink">Commandes</span>
        </Link>
        <Link href="/vendeur/demandes" data-testid="vendor-requests-link" aria-label="Demandes d'acheteurs et propositions" className={`${cardLink} col-span-2 md:col-span-1`}>
          <IconTile icon={Inbox} tone="info" />
          <span className="text-[15px] font-bold text-ink">Demandes</span>
        </Link>
      </section>

      <section className="flex flex-col gap-3">
        <SectionHeading
          icon={Tag}
          aside={
            <Link href="/vendeur/annonces" className="press flex min-h-11 items-center gap-1 rounded-full px-3 text-[14px] font-bold text-brand hover:bg-brand-soft">
              Tout gérer
              <ChevronRight className="size-4" aria-hidden />
            </Link>
          }
        >
          Vos annonces
        </SectionHeading>

        {view.hasOffers ? (
          <div className="stagger flex flex-col gap-3 md:grid md:grid-cols-2" data-vendor-offers>
            {view.offers.map((offer) => (
              <Link key={offer.id} href={offer.href} className="press flex items-center gap-3 rounded-3xl border border-line bg-white p-3.5 hover:border-brand">
                <Thumb art={offer.art} className="size-16" iconClassName="size-8" photoId={offer.coverPhotoId} />
                <span className="min-w-0 flex-1">
                  <span className="line-clamp-2 text-[16px] font-bold leading-snug text-ink">{offer.title}</span>
                  {offer.subtitle ? <span className="block truncate text-[13px] text-ink-soft">{offer.subtitle}</span> : null}
                  <span className="mt-1.5 flex flex-wrap items-center gap-1.5">
                    <Badge tone={offer.statusTone}>{offer.statusLabel}</Badge>
                    {offer.boostText ? (
                      <Badge tone="carrot">
                        <Zap className="size-3" aria-hidden />
                        {offer.boostText}
                      </Badge>
                    ) : null}
                  </span>
                  {offer.needsText ? (
                    <span className="mt-1.5 flex items-center gap-1.5 text-[13px] font-semibold text-brand">
                      <Users className="size-4 shrink-0" aria-hidden />
                      {offer.needsText}
                    </span>
                  ) : null}
                </span>
                <ChevronRight className="size-5 shrink-0 text-ink-soft" aria-hidden />
              </Link>
            ))}
          </div>
        ) : (
          <EmptyState art={<ArtStore className="size-36" />} title={NO_OFFER_MESSAGE} />
        )}
      </section>

      <Sheet open={sheet} onClose={() => setSheet(false)} title="Nouvelle annonce">
        <NouvelleAnnonceForm embedded onDone={() => setSheet(false)} onSaved={reload} />
      </Sheet>
    </main>
  );
}

export default function DashboardVendeur() {
  return (
    <SessionGate>
      <Dashboard />
    </SessionGate>
  );
}
