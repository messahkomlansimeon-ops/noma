"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { ArrowRight, Bell, ChevronRight, Globe, MessageCircle, PenLine, Plus, RotateCw, ScanSearch } from "lucide-react";
import { LogoMark } from "@/components/logo";
import { Sheet } from "@/components/modal";
import { NeedForm } from "@/components/need-form";
import { Thumb } from "@/components/thumb";
import { ArtAlert, ArtBell, ArtSearch } from "@/components/illustrations";
import { Badge, Btn, EmptyState, IconTile, Skeleton } from "@/components/ui";
import { HeaderBtn } from "@/components/top-bar";
import { MessagesUnreadSync } from "@/components/messages-badge";
import { UnreadSync } from "@/components/unread-badge";
import { api, describeApiError, isUnauthorized, type BuyerHome } from "@/lib/client/api";
import {
  BUYER_HOME_LOADING,
  BUYER_HOME_TITLE,
  DESCRIBE_NEED_LABEL,
  EXTERNAL_SEARCH_LABEL,
  LANDING_STEPS,
  LANDING_TITLE,
  LOGIN_LABEL,
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
        aria-label={EXTERNAL_SEARCH_LABEL}
        className="press flex min-h-14 w-full items-center gap-3 rounded-3xl border-2 border-dashed border-line-strong bg-white px-4 text-left hover:border-brand"
      >
        <IconTile icon={Globe} tone="info" />
        <span className="flex-1 text-[15px] font-bold text-ink">{EXTERNAL_SEARCH_LABEL}</span>
        <ChevronRight className="size-5 text-ink-soft" aria-hidden />
      </button>
      <Sheet open={sheet} onClose={() => setSheet(false)} title={EXTERNAL_SEARCH_LABEL}>
        <NeedForm onDone={() => setSheet(false)} />
      </Sheet>
    </>
  );
}

const STEP_ICONS = [PenLine, ScanSearch, MessageCircle] as const;
const STEP_TONES = ["brand", "accent", "success"] as const;

function Landing() {
  return (
    <main className="flex flex-col gap-6 px-4 pb-6 pt-4">
      <div className="md:hidden">
        <LogoMark />
      </div>
      <section className="animate-rise flex flex-col items-center gap-4 rounded-[2rem] bg-brand-soft px-5 pb-6 pt-8 text-center">
        <ArtSearch className="size-44" />
        <h1 className="max-w-[18ch] text-[28px] font-extrabold leading-[1.1] tracking-tight text-ink">{LANDING_TITLE}</h1>
        <div className="w-full max-w-xs">
          <Btn href="/connexion">
            {LOGIN_LABEL}
            <ArrowRight className="size-5" aria-hidden />
          </Btn>
        </div>
      </section>

      <ol className="stagger grid grid-cols-3 gap-3">
        {LANDING_STEPS.map((step, index) => {
          const tone = STEP_TONES[index] ?? "brand";
          return (
            <li key={step.title} className="flex flex-col items-center gap-3 rounded-3xl border border-line bg-white p-3 text-center">
              <IconTile icon={STEP_ICONS[index] ?? PenLine} tone={tone} className="size-14" />
              <span className="text-[13px] font-bold leading-tight text-ink">{step.title}</span>
            </li>
          );
        })}
      </ol>

      <ExternalSearch />
    </main>
  );
}

function BuyerHomeScreen({ home }: { home: BuyerHome }) {
  const view = buyerHomeView(home);
  return (
    <main className="flex flex-col gap-6 px-4 pb-6 pt-3">
      <UnreadSync />
      <MessagesUnreadSync />
      <div className="flex items-center justify-between">
        <span className="md:hidden">
          <LogoMark />
        </span>
        <span className="hidden md:block" />
        <HeaderBtn icon={Bell} href="/notifications" dot={view.hasUnread} label="Notifications" />
      </div>

      <Link
        href="/alerte/nouvelle"
        className="press animate-rise relative flex min-h-24 w-full items-center gap-4 overflow-hidden rounded-[2rem] bg-brand px-5 py-4 text-white shadow-[0_14px_30px_-14px_rgb(43_63_214/0.9)]"
      >
        <span className="flex size-14 shrink-0 items-center justify-center rounded-2xl bg-accent text-ink">
          <Plus className="size-8" strokeWidth={2.6} aria-hidden />
        </span>
        <span className="text-[22px] font-extrabold leading-tight">{DESCRIBE_NEED_LABEL}</span>
        <span aria-hidden className="absolute -right-6 -top-6 size-28 rounded-full bg-white/10" />
        <span aria-hidden className="absolute -bottom-8 right-10 size-20 rounded-full bg-white/10" />
      </Link>

      <section className="flex flex-col gap-3">
        <h1 className="text-[22px] font-extrabold tracking-tight text-ink">{BUYER_HOME_TITLE}</h1>
        {view.hasDemands ? (
          <div className="stagger flex flex-col gap-3" data-buyer-demands>
            {view.demands.map((demand) => (
              <Link
                key={demand.id}
                href={demand.href}
                className="press flex items-center gap-3 rounded-3xl border border-line bg-white p-3.5 hover:border-brand"
              >
                <Thumb art={demand.art} className="size-14" iconClassName="size-7" />
                <span className="min-w-0 flex-1">
                  <span className="line-clamp-2 text-[16px] font-bold leading-snug text-ink">{demand.title}</span>
                  {demand.subtitle ? <span className="mt-0.5 block text-[14px] text-ink-soft">{demand.subtitle}</span> : null}
                  <Badge tone={demand.hasMatches ? "sage" : "wash"} className="mt-1.5">
                    {demand.matchText}
                  </Badge>
                </span>
                <ChevronRight className="size-5 shrink-0 text-ink-soft" aria-hidden />
              </Link>
            ))}
            <Link href="/alertes" className="press flex min-h-12 items-center justify-center gap-1.5 text-[15px] font-bold text-brand">
              {view.hiddenDemandCount > 0 ? `Voir mes ${view.hiddenDemandCount + view.demands.length} besoins` : "Gérer mes besoins"}
              <ArrowRight className="size-4" aria-hidden />
            </Link>
          </div>
        ) : (
          <EmptyState art={<ArtSearch className="size-36" />} title={NO_DEMAND_MESSAGE} />
        )}
      </section>

      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-[18px] font-extrabold tracking-tight text-ink">
            <Bell className="size-5 text-brand" aria-hidden />
            Notifications
          </h2>
          <span className={`text-[14px] font-bold ${view.hasUnread ? "text-accent-ink" : "text-ink-soft"}`} data-unread-summary>
            {view.unreadText}
          </span>
        </div>
        {view.notifications.length > 0 ? (
          <div className="divide-y divide-line overflow-hidden rounded-3xl border border-line bg-white">
            {view.notifications.map((notification) => (
              <Link key={notification.id} href={notification.href} className="press flex min-h-14 items-center gap-3 px-4 py-3 hover:bg-mist/60">
                <span className={`size-2.5 shrink-0 rounded-full ${notification.unread ? "bg-accent" : "bg-transparent"}`} aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className={`block truncate text-[15px] text-ink ${notification.unread ? "font-extrabold" : "font-semibold"}`}>{notification.title}</span>
                  {notification.subtitle ? <span className="block text-[13px] text-ink-soft">{notification.subtitle}</span> : null}
                </span>
                <ChevronRight className="size-5 shrink-0 text-ink-soft" aria-hidden />
              </Link>
            ))}
            <Link href="/notifications" className="press flex min-h-12 items-center justify-center gap-1.5 px-4 text-[15px] font-bold text-brand">
              Toutes les notifications
              <ArrowRight className="size-4" aria-hidden />
            </Link>
          </div>
        ) : (
          <EmptyState art={<ArtBell className="size-28" />} title={view.unreadText} />
        )}
      </section>

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
      <main className="flex min-h-[60dvh] flex-col items-center justify-center gap-4 px-6 text-center" role="alert">
        <ArtAlert />
        <p className="text-[17px] font-bold text-ink">{state.message}</p>
        <div className="w-full max-w-xs">
          <Btn onClick={retry}>
            <RotateCw className="size-5" aria-hidden />
            Réessayer
          </Btn>
        </div>
      </main>
    );
  }
  return (
    <main className="flex flex-col gap-4 px-4 pt-6" aria-busy="true">
      <span className="sr-only">{BUYER_HOME_LOADING}</span>
      <Skeleton className="h-24 w-full rounded-[2rem]" />
      <Skeleton className="h-20 w-full rounded-3xl" />
      <Skeleton className="h-20 w-full rounded-3xl" />
    </main>
  );
}
