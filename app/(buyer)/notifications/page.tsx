"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Bell, Briefcase, CheckCheck, ChevronRight, Clock, Globe, Layers, MessageCircle, RotateCw, Sparkles, type LucideIcon } from "lucide-react";
import { ArtAlert, ArtBell } from "@/components/illustrations";
import { SessionGate, useUnauthorizedRedirect } from "@/components/session-gate";
import { TopBar } from "@/components/top-bar";
import { Btn, EmptyState, IconTile, Skeleton } from "@/components/ui";
import { UnreadSync, unreadRefresher } from "@/components/unread-badge";
import { api, describeApiError, type NotificationItem } from "@/lib/client/api";
import {
  EMPTY_NOTIFICATIONS_MESSAGE,
  LOAD_MORE_LABEL,
  MARK_ALL_READ_DONE,
  MARK_ALL_READ_LABEL,
  MARK_SHOWN_READ_DONE,
  NOTIFICATIONS_LOADING,
  NOTIFICATIONS_PAGE_TITLE,
  UNREAD_SR_LABEL,
  markReadLocally,
  mergeNotificationPages,
  newestCreatedAt,
  notificationRow,
  notificationsListState,
  unreadInList,
} from "@/lib/client/notifications-view";
import { useNoma } from "@/lib/store";

const KIND_ICONS: Record<NotificationItem["kind"], LucideIcon> = {
  new_match: Sparkles,
  new_matches_digest: Layers,
  new_message: MessageCircle,
  mission_coverage: Briefcase,
  new_external_match: Globe,
  active_search_expiring: Clock,
};

/**
 * Page « Notifications » (lot N1) : les nouvelles annonces qui correspondent à vos besoins, les non-lues en gras, « Tout marquer comme lu », et pour chacune le lien
 * vers la fiche de l'annonce dans le contexte du besoin. Ouvrir une annonce la marque comme lue.
 */
function Notifications() {
  const showToast = useNoma((s) => s.showToast);
  const redirectIfUnauthorized = useUnauthorizedRedirect();
  const [items, setItems] = useState<NotificationItem[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [unreadTotal, setUnreadTotal] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [moreError, setMoreError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [marking, setMarking] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  // Une réponse « Voir plus » partie avant un rechargement est ignorée.
  const generation = useRef(0);

  useEffect(() => {
    const controller = new AbortController();
    generation.current += 1;
    const token = generation.current;
    api.notifications.list({ limit: 20 }, { signal: controller.signal }).then(
      (page) => {
        if (generation.current !== token) return;
        setItems(page.items);
        setNextCursor(page.nextCursor);
        setUnreadTotal(page.unreadCount);
        setLoadError(null);
        unreadRefresher.set(page.unreadCount);
      },
      (failure) => {
        if (controller.signal.aborted || generation.current !== token || redirectIfUnauthorized(failure)) return;
        setLoadError(describeApiError(failure, "notifications"));
      },
    );
    return () => controller.abort();
  }, [reloadKey, redirectIfUnauthorized]);

  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMore) return;
    const token = generation.current;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const page = await api.notifications.list({ limit: 20, cursor: nextCursor });
      if (generation.current !== token) return;
      setItems((current) => mergeNotificationPages(current ?? [], page.items));
      setNextCursor(page.nextCursor);
      setUnreadTotal(page.unreadCount);
      unreadRefresher.set(page.unreadCount);
    } catch (failure) {
      if (redirectIfUnauthorized(failure)) return;
      setMoreError(describeApiError(failure, "notifications"));
    } finally {
      setLoadingMore(false);
    }
  }, [nextCursor, loadingMore, redirectIfUnauthorized]);

  const markAll = async () => {
    if (marking) return;
    // « Tout » = tout ce qui est AFFICHÉ : la date de la plus récente notification chargée. Une notification arrivée après le chargement de l'écran reste non lue.
    const upTo = items ? newestCreatedAt(items) : null;
    if (upTo === null) return;
    setMarking(true);
    try {
      const result = await api.notifications.markAllRead(upTo);
      setItems((current) => (current ? markReadLocally(current, { upTo }, new Date().toISOString()) : current));
      setUnreadTotal(result.unreadCount);
      unreadRefresher.set(result.unreadCount);
      showToast(result.unreadCount > 0 ? MARK_SHOWN_READ_DONE : MARK_ALL_READ_DONE);
    } catch (failure) {
      if (redirectIfUnauthorized(failure)) return;
      showToast(describeApiError(failure, "notifications"));
    } finally {
      setMarking(false);
    }
  };

  /** Ouvrir une annonce la marque comme lue (au mieux : un échec n'empêche jamais d'ouvrir la fiche). */
  const markOne = (item: NotificationItem) => {
    if (item.readAt !== null) return;
    setItems((current) => (current ? markReadLocally(current, [item.id], new Date().toISOString()) : current));
    api.notifications.markRead([item.id]).then(
      (result) => {
        setUnreadTotal(result.unreadCount);
        unreadRefresher.set(result.unreadCount);
      },
      () => setReloadKey((key) => key + 1),
    );
  };

  const state = notificationsListState({ loaded: items !== null, itemCount: items?.length ?? 0 });
  const unreadShown = items ? unreadInList(items) : 0;

  return (
    <main>
      <TopBar back="/alertes" title={NOTIFICATIONS_PAGE_TITLE} />
      <div className="flex flex-col gap-4 px-4 pb-6 pt-1">
        {loadError ? (
          <div role="alert" className="animate-rise flex flex-col items-center gap-4 px-6 py-8 text-center">
            <ArtAlert className="size-28" />
            <p className="text-[16px] font-bold text-ink">{loadError}</p>
            <div className="w-full max-w-xs">
              <Btn
                onClick={() => {
                  setLoadError(null);
                  setReloadKey((key) => key + 1);
                }}
              >
                <RotateCw className="size-5" aria-hidden />
                Réessayer
              </Btn>
            </div>
          </div>
        ) : state === "loading" ? (
          <div className="flex flex-col gap-3" aria-busy="true">
            <span className="sr-only">{NOTIFICATIONS_LOADING}</span>
            <Skeleton className="h-20 w-full rounded-3xl" />
            <Skeleton className="h-20 w-full rounded-3xl" />
            <Skeleton className="h-20 w-full rounded-3xl" />
          </div>
        ) : state === "empty" ? (
          <div role="status">
            <EmptyState art={<ArtBell className="size-36" />} title={EMPTY_NOTIFICATIONS_MESSAGE} />
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between gap-3">
              <h1 className="text-[22px] font-extrabold tracking-tight text-ink" data-testid="notifications-heading">
                {unreadTotal > 0 ? `${unreadTotal} non lue${unreadTotal > 1 ? "s" : ""}` : "Tout est lu"}
              </h1>
              <button
                onClick={() => void markAll()}
                disabled={marking || unreadTotal === 0}
                className="press inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-full border-2 border-line-strong bg-white px-4 text-[14px] font-bold text-ink hover:border-brand disabled:opacity-50"
              >
                <CheckCheck className="size-4" aria-hidden />
                {MARK_ALL_READ_LABEL}
              </button>
            </div>
            <ul className="stagger flex flex-col gap-2.5 md:grid md:grid-cols-2" aria-label="Vos notifications" data-unread-shown={unreadShown}>
              {(items ?? []).map((item) => {
                const row = notificationRow(item);
                const KindIcon = KIND_ICONS[row.kind] ?? Bell;
                const inner = (
                  <>
                    <IconTile icon={KindIcon} tone={row.unread ? "accent" : "mist"} />
                    <span className="min-w-0 flex-1">
                      <span className={`block text-[15px] leading-snug text-ink ${row.unread ? "font-extrabold" : "font-medium"}`}>
                        {row.unread ? <span className="sr-only">{UNREAD_SR_LABEL} : </span> : null}
                        {row.badge ? (
                          <span data-testid="notification-badge" className="mr-1.5 inline-flex rounded-full bg-mist px-2.5 py-0.5 align-middle text-[12px] font-bold text-ink-soft">{row.badge}</span>
                        ) : null}
                        {row.title}
                      </span>
                      {row.subtitle && row.kind !== "new_matches_digest" ? <span className="block text-[14px] text-ink-soft">{row.subtitle}</span> : null}
                      <span className="mt-0.5 block text-[13px] text-ink-soft">{row.dateText}</span>
                      {row.href ? <span className="mt-1 block text-[14px] font-bold text-brand">{row.linkLabel}</span> : null}
                    </span>
                    {row.unread ? <span aria-hidden className="size-2.5 shrink-0 rounded-full bg-accent" /> : null}
                    {row.href ? <ChevronRight className="size-5 shrink-0 text-ink-soft" aria-hidden /> : null}
                  </>
                );
                const className = `press flex min-h-14 items-center gap-3 rounded-3xl border p-3.5 ${row.unread ? "border-accent/40 bg-white" : "border-line bg-white"}`;
                return (
                  <li key={row.id} data-testid="notification-row" data-unread={row.unread ? "true" : "false"} data-kind={row.kind}>
                    {row.href ? (
                      <Link href={row.href} onClick={() => markOne(item)} className={`${className} hover:border-brand`}>
                        {inner}
                      </Link>
                    ) : (
                      <div className={className}>{inner}</div>
                    )}
                  </li>
                );
              })}
            </ul>
            {moreError ? (
              <p role="alert" className="text-center text-[14px] font-semibold text-accent-ink">
                {moreError}
              </p>
            ) : null}
            {nextCursor ? (
              <button
                onClick={() => void loadMore()}
                disabled={loadingMore}
                className="press flex min-h-12 w-full items-center justify-center gap-2 rounded-2xl border-2 border-line-strong bg-white px-5 py-3 text-[16px] font-bold text-ink hover:border-brand hover:text-brand disabled:cursor-not-allowed disabled:opacity-50"
              >
                {loadingMore ? "Chargement…" : LOAD_MORE_LABEL}
              </button>
            ) : null}
          </>
        )}
      </div>
    </main>
  );
}

export default function NotificationsPage() {
  return (
    <SessionGate>
      <UnreadSync initial={false} />
      <Notifications />
    </SessionGate>
  );
}
