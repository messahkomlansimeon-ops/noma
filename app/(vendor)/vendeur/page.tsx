"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { ChevronRight, MessageCircle, Package, Plus, Wallet, Zap } from "lucide-react";
import { LogoMark } from "@/components/logo";
import { MessagesBadge, MessagesUnreadSync } from "@/components/messages-badge";
import { Sheet } from "@/components/modal";
import { SessionGate, useUnauthorizedRedirect } from "@/components/session-gate";
import { Thumb } from "@/components/thumb";
import { Badge } from "@/components/ui";
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
      <main className="flex min-h-[60dvh] items-center justify-center px-6 text-center text-[14px] text-ink-soft" aria-busy="true">
        {VENDOR_HOME_LOADING}
      </main>
    );
  }
  if (state.kind === "error") {
    return (
      <main className="flex min-h-[60dvh] flex-col items-center justify-center gap-3 px-6 text-center" role="alert">
        <p className="text-[14px] font-semibold text-ink">{state.message}</p>
        <button onClick={reload} className="rounded-xl bg-forest px-5 py-3 text-[14px] font-bold text-white transition active:scale-[0.99]">
          Réessayer
        </button>
      </main>
    );
  }

  const view = vendorHomeView(state.home);
  return (
    <main>
      <MessagesUnreadSync />
      <div className="flex items-center justify-between px-4 py-3">
        <LogoMark />
        <Link
          href={walletHref({ next: "/vendeur" })}
          className="flex items-center gap-1.5 rounded-full border border-line bg-white px-3 py-1.5 text-[13px] font-semibold text-ink"
        >
          <Wallet className="size-4" aria-hidden />
          {WALLET_LINK_LABEL}
        </Link>
      </div>

      <div className="px-4">
        <h1 className="font-display text-[26px] font-extrabold text-ink">{VENDOR_HOME_TITLE}</h1>

        <div className="mt-3 grid grid-cols-3 gap-2.5">
          {view.tiles.map((tile) => (
            <div key={tile.label} className="rounded-2xl border border-line bg-white p-3 text-center" data-tile={tile.label}>
              <div className="font-display text-[24px] font-extrabold text-ink">{tile.value}</div>
              <div className="text-[11px] font-semibold text-ink-soft">{tile.label}</div>
            </div>
          ))}
        </div>

        <div className="mt-3 rounded-2xl bg-sage p-4" data-vendor-needs>
          <div className="text-[14px] font-extrabold text-forest">{view.needsText}</div>
          <div className="mt-0.5 text-[12px] text-sage-ink">{VENDOR_NEEDS_NOTE}</div>
        </div>

        <div className="mt-3 grid grid-cols-2 gap-2.5">
          <Link href={walletHref({ next: "/vendeur" })} className="rounded-2xl border border-line bg-white p-3.5 transition hover:bg-wash/40">
            <div className="text-[12px] font-semibold text-ink-soft">Solde du porte-monnaie</div>
            <div className="font-display text-[20px] font-extrabold text-ink" data-wallet-balance>
              {view.walletText}
            </div>
          </Link>
          <div className="rounded-2xl border border-line bg-white p-3.5">
            <div className="flex items-center gap-1 text-[12px] font-semibold text-ink-soft">
              <Zap className="size-3.5" aria-hidden />
              Boosts actifs
            </div>
            {view.hasBoosts ? (
              <ul className="mt-1 space-y-0.5" data-active-boosts>
                {view.boosts.map((boost) => (
                  <li key={boost.offerId} className="text-[12px] leading-snug text-ink">
                    <span className="block truncate font-bold">{boost.title}</span>
                    <span className="text-ink-soft">{boost.text}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="mt-1 text-[12px] text-ink-soft">{NO_BOOST_MESSAGE}</div>
            )}
          </div>
        </div>

        <div className="mt-3 grid grid-cols-2 gap-2.5" data-vendor-links>
          <Link href="/vendeur/messages" data-testid="vendor-messages-link" className="flex items-center justify-between gap-2 rounded-2xl border border-line bg-white p-3.5 transition hover:bg-wash/40">
            <span className="flex items-center gap-2 text-[14px] font-bold text-ink">
              <MessageCircle className="size-4" aria-hidden />
              Messages
            </span>
            <MessagesBadge />
          </Link>
          <Link href="/vendeur/commandes" data-testid="vendor-orders-link" className="flex items-center gap-2 rounded-2xl border border-line bg-white p-3.5 text-[14px] font-bold text-ink transition hover:bg-wash/40">
            <Package className="size-4" aria-hidden />
            Commandes
          </Link>
        </div>

        <button
          onClick={() => setSheet(true)}
          className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-forest py-3.5 text-[15px] font-bold text-white transition active:scale-[0.99]"
        >
          <Plus className="size-4" aria-hidden />
          {PUBLISH_OFFER_LABEL}
        </button>

        <div className="mt-5 flex items-center justify-between">
          <span className="text-[16px] font-extrabold text-ink">Vos annonces</span>
          <Link href="/vendeur/annonces" className="text-[13px] font-bold text-forest">
            Tout gérer ›
          </Link>
        </div>

        {view.hasOffers ? (
          <div className="mt-3 space-y-3" data-vendor-offers>
            {view.offers.map((offer) => (
              <Link
                key={offer.id}
                href={offer.href}
                className="flex items-center gap-3 rounded-2xl border border-line bg-white p-3.5 transition hover:bg-wash/40"
              >
                <Thumb art={offer.art} className="size-12" iconClassName="size-6" photoId={offer.coverPhotoId} />
                <span className="min-w-0 flex-1">
                  <span className="line-clamp-2 text-[15px] font-bold text-ink">{offer.title}</span>
                  {offer.subtitle ? <span className="block truncate text-[12px] text-ink-soft">{offer.subtitle}</span> : null}
                  <span className="mt-1 flex flex-wrap items-center gap-1.5">
                    <Badge tone={offer.statusTone}>{offer.statusLabel}</Badge>
                    {offer.boostText ? <Badge tone="carrot">{offer.boostText}</Badge> : null}
                  </span>
                  {offer.needsText ? <span className="mt-1 block text-[12px] font-semibold text-forest">{offer.needsText}</span> : null}
                </span>
                <ChevronRight className="size-4 shrink-0 text-ink-soft" aria-hidden />
              </Link>
            ))}
          </div>
        ) : (
          <p className="mt-3 rounded-2xl border border-line bg-white p-4 text-center text-[14px] text-ink-soft">{NO_OFFER_MESSAGE}</p>
        )}
      </div>

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
