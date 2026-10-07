"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Bell, ChevronRight, Plus, Search } from "lucide-react";
import { LogoMark } from "@/components/logo";
import { Sheet } from "@/components/modal";
import { NeedForm } from "@/components/need-form";
import { Thumb } from "@/components/thumb";
import { Badge } from "@/components/ui";
import { MessagesUnreadSync } from "@/components/messages-badge";
import { UnreadSync } from "@/components/unread-badge";
import { api, describeApiError, isUnauthorized, type BuyerHome } from "@/lib/client/api";
import {
  BUYER_HOME_LOADING,
  BUYER_HOME_TITLE,
  DESCRIBE_NEED_LABEL,
  EXTERNAL_SEARCH_LABEL,
  LANDING_STEPS,
  LANDING_SUBTITLE,
  LANDING_TITLE,
  LOGIN_LABEL,
  NO_DEMAND_HINT,
  NO_DEMAND_MESSAGE,
  buyerHomeView,
} from "@/lib/client/home-view";

type HomeState =
  | { kind: "checking" }
  | { kind: "anonymous" }
  | { kind: "ready"; home: BuyerHome }
  | { kind: "error"; message: string };

function ExternalSearch() {
  const [sheet, setSheet] = useState(false);
  return (
    <>
      <button
        onClick={() => setSheet(true)}
        className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl border border-line bg-white py-3 text-[13px] font-bold text-ink transition hover:bg-wash/60"
      >
        <Search className="size-4" aria-hidden />
        {EXTERNAL_SEARCH_LABEL}
      </button>
      <Sheet open={sheet} onClose={() => setSheet(false)} title={EXTERNAL_SEARCH_LABEL}>
        <NeedForm onDone={() => setSheet(false)} />
      </Sheet>
    </>
  );
}

function Landing() {
  return (
    <main className="px-4">
      <div className="py-3">
        <LogoMark />
      </div>
      <div className="mt-1 inline-flex items-center rounded-full bg-sage px-3 py-1.5 text-[11px] font-extrabold uppercase tracking-wider text-sage-ink">
        Votre recherche, simplifiée
      </div>
      <h1 className="mt-3 font-display text-[30px] font-extrabold leading-[1.1] text-ink">{LANDING_TITLE}</h1>
      <p className="mt-2.5 text-[14px] leading-relaxed text-ink-soft">{LANDING_SUBTITLE}</p>

      <ol className="mt-5 space-y-3">
        {LANDING_STEPS.map((step, index) => (
          <li key={step.title} className="flex gap-3 rounded-2xl border border-line bg-white p-3.5">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-forest text-[14px] font-extrabold text-white" aria-hidden>
              {index + 1}
            </span>
            <span>
              <span className="block text-[15px] font-extrabold text-ink">{step.title}</span>
              <span className="block text-[13px] leading-snug text-ink-soft">{step.text}</span>
            </span>
          </li>
        ))}
      </ol>

      <Link
        href="/connexion"
        className="mt-5 flex w-full items-center justify-center gap-2 rounded-xl bg-forest py-4 text-[15px] font-bold text-white transition active:scale-[0.99]"
      >
        {LOGIN_LABEL}
      </Link>
      <ExternalSearch />
    </main>
  );
}

function BuyerHomeScreen({ home }: { home: BuyerHome }) {
  const view = buyerHomeView(home);
  return (
    <main className="px-4">
      <UnreadSync />
      <MessagesUnreadSync />
      <div className="flex items-center justify-between py-3">
        <LogoMark />
        <Link
          href="/notifications"
          className="flex items-center gap-1.5 rounded-full border border-line bg-white px-3 py-1.5 text-[13px] font-semibold text-ink"
        >
          <Bell className="size-4" aria-hidden />
          Notifications
        </Link>
      </div>

      <Link
        href="/alerte/nouvelle"
        className="flex w-full items-center justify-center gap-2 rounded-2xl bg-forest py-5 text-[17px] font-extrabold text-white transition active:scale-[0.99]"
      >
        <Plus className="size-5" aria-hidden />
        {DESCRIBE_NEED_LABEL}
      </Link>

      <h1 className="mt-6 font-display text-[24px] font-extrabold text-ink">{BUYER_HOME_TITLE}</h1>
      {view.hasDemands ? (
        <div className="mt-3 space-y-3" data-buyer-demands>
          {view.demands.map((demand) => (
            <Link
              key={demand.id}
              href={demand.href}
              className="flex items-center gap-3 rounded-2xl border border-line bg-white p-3.5 transition hover:bg-wash/40"
            >
              <Thumb art={demand.art} className="size-12" iconClassName="size-6" />
              <span className="min-w-0 flex-1">
                <span className="line-clamp-2 text-[15px] font-bold text-ink">{demand.title}</span>
                {demand.subtitle ? <span className="block text-[12px] text-ink-soft">{demand.subtitle}</span> : null}
                <Badge tone={demand.hasMatches ? "sage" : "wash"} className="mt-1">
                  {demand.matchText}
                </Badge>
              </span>
              <ChevronRight className="size-4 shrink-0 text-ink-soft" aria-hidden />
            </Link>
          ))}
          {view.hiddenDemandCount > 0 ? (
            <Link href="/alertes" className="block text-center text-[13px] font-bold text-forest">
              Voir mes {view.hiddenDemandCount + view.demands.length} besoins
            </Link>
          ) : (
            <Link href="/alertes" className="block text-center text-[13px] font-bold text-forest">
              Gérer mes besoins
            </Link>
          )}
        </div>
      ) : (
        <div className="mt-3 rounded-2xl border border-line bg-white p-4 text-center">
          <p className="text-[14px] font-semibold text-ink">{NO_DEMAND_MESSAGE}</p>
          <p className="mt-1 text-[13px] text-ink-soft">{NO_DEMAND_HINT}</p>
        </div>
      )}

      <div className="mt-6 flex items-center justify-between">
        <h2 className="text-[16px] font-extrabold text-ink">Notifications</h2>
        <span className={`text-[12px] font-bold ${view.hasUnread ? "text-carrot-ink" : "text-ink-soft"}`} data-unread-summary>
          {view.unreadText}
        </span>
      </div>
      {view.notifications.length > 0 ? (
        <div className="mt-2.5 divide-y divide-line overflow-hidden rounded-2xl border border-line bg-white">
          {view.notifications.map((notification) => (
            <Link key={notification.id} href={notification.href} className="flex items-center gap-3 px-4 py-3 transition hover:bg-wash/60">
              <span className={`size-2 shrink-0 rounded-full ${notification.unread ? "bg-carrot" : "bg-transparent"}`} aria-hidden />
              <span className="min-w-0 flex-1">
                <span className={`block truncate text-[14px] text-ink ${notification.unread ? "font-extrabold" : "font-semibold"}`}>{notification.title}</span>
                {notification.subtitle ? <span className="block text-[12px] text-ink-soft">{notification.subtitle}</span> : null}
              </span>
              <ChevronRight className="size-4 shrink-0 text-ink-soft" aria-hidden />
            </Link>
          ))}
          <Link href="/notifications" className="block px-4 py-3 text-center text-[13px] font-bold text-forest">
            Toutes les notifications
          </Link>
        </div>
      ) : (
        <p className="mt-2.5 text-[13px] text-ink-soft">Quand une nouvelle annonce correspond à l&apos;un de vos besoins, elle apparaît ici.</p>
      )}

      <ExternalSearch />
    </main>
  );
}

export default function Accueil() {
  const [state, setState] = useState<HomeState>({ kind: "checking" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      try {
        const session = await api.auth.sessionOutcome({ signal: controller.signal });
        if (session.kind === "anonymous") return setState({ kind: "anonymous" });
        if (session.kind !== "authenticated") return setState({ kind: "error", message: "Le service est temporairement indisponible." });
        const home = await api.home.buyer({ signal: controller.signal });
        setState({ kind: "ready", home });
      } catch (failure) {
        if (controller.signal.aborted) return;
        setState(isUnauthorized(failure) ? { kind: "anonymous" } : { kind: "error", message: describeApiError(failure) });
      }
    })();
    return () => controller.abort();
  }, [attempt]);

  const retry = useCallback(() => {
    setState({ kind: "checking" });
    setAttempt((value) => value + 1);
  }, []);

  if (state.kind === "anonymous") return <Landing />;
  if (state.kind === "ready") return <BuyerHomeScreen home={state.home} />;
  if (state.kind === "error") {
    return (
      <main className="flex min-h-[60dvh] flex-col items-center justify-center gap-3 px-6 text-center" role="alert">
        <p className="text-[14px] font-semibold text-ink">{state.message}</p>
        <button onClick={retry} className="rounded-xl bg-forest px-5 py-3 text-[14px] font-bold text-white transition active:scale-[0.99]">
          Réessayer
        </button>
      </main>
    );
  }
  return (
    <main className="flex min-h-[60dvh] items-center justify-center px-6 text-center text-[14px] text-ink-soft" aria-busy="true">
      {BUYER_HOME_LOADING}
    </main>
  );
}
