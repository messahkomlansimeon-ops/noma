"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { BellRing, ChevronRight, CheckCheck } from "lucide-react";
import { SessionGate, useUnauthorizedRedirect } from "@/components/session-gate";
import { TopBar } from "@/components/top-bar";
import { UnreadSync, unreadRefresher } from "@/components/unread-badge";
import { api, describeApiError, type NotificationItem } from "@/lib/client/api";
import {
  EMPTY_NOTIFICATIONS_HINT,
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
      <div className="px-4 pb-6">
        {loadError ? (
          <div role="alert" className="mt-4 rounded-2xl border border-line bg-white p-4 text-center">
            <p className="text-[14px] font-semibold text-ink">{loadError}</p>
            <button
              onClick={() => {
                setLoadError(null);
                setReloadKey((key) => key + 1);
              }}
              className="mt-3 rounded-xl bg-forest px-5 py-2.5 text-[14px] font-bold text-white"
            >
              Réessayer
            </button>
          </div>
        ) : state === "loading" ? (
          <p className="mt-6 text-center text-[14px] text-ink-soft" aria-busy="true">
            {NOTIFICATIONS_LOADING}
          </p>
        ) : state === "empty" ? (
          <div role="status" className="mt-6 rounded-2xl bg-wash p-5 text-center">
            <BellRing className="mx-auto size-7 text-ink-soft" aria-hidden />
            <p className="mt-2 text-[14px] font-bold text-ink">{EMPTY_NOTIFICATIONS_MESSAGE}</p>
            <p className="mt-1 text-[13px] text-ink-soft">{EMPTY_NOTIFICATIONS_HINT}</p>
          </div>
        ) : (
          <>
            <div className="mt-3">
              <h1 className="font-display text-[22px] font-extrabold text-ink" data-testid="notifications-heading">
                {unreadTotal > 0 ? `${unreadTotal} non lue${unreadTotal > 1 ? "s" : ""}` : "Tout est lu"}
              </h1>
              {/* Sous le titre : le bouton a toute la largeur utile à 390 px. */}
              <button
                onClick={() => void markAll()}
                disabled={marking || unreadTotal === 0}
                className="mt-2 flex items-center gap-1.5 rounded-full border border-line bg-white px-3 py-1.5 text-[13px] font-semibold text-ink disabled:opacity-50"
              >
                <CheckCheck className="size-3.5" aria-hidden />
                {MARK_ALL_READ_LABEL}
              </button>
            </div>
            <ul className="mt-3 space-y-2.5" aria-label="Vos notifications" data-unread-shown={unreadShown}>
              {(items ?? []).map((item) => {
                const row = notificationRow(item);
                const inner = (
                  <>
                    <span
                      aria-hidden
                      className={`mt-1.5 size-2.5 shrink-0 rounded-full ${row.unread ? "bg-carrot" : "bg-transparent"}`}
                    />
                    <span className="min-w-0 flex-1">
                      <span className={`block text-[15px] text-ink ${row.unread ? "font-extrabold" : "font-medium"}`}>
                        {row.unread ? <span className="sr-only">{UNREAD_SR_LABEL} : </span> : null}
                        {row.badge ? (
                          <span data-testid="notification-badge" className="mr-1.5 rounded-full bg-wash px-2 py-0.5 align-middle text-[11px] font-bold text-ink-soft">{row.badge}</span>
                        ) : null}
                        {row.title}
                      </span>
                      {row.subtitle ? <span className="block text-[13px] text-ink-soft">{row.subtitle}</span> : null}
                      <span className="mt-0.5 block text-[12px] text-ink-soft">{row.dateText}</span>
                      {row.href ? <span className="mt-1 block text-[13px] font-bold text-forest">{row.linkLabel}</span> : null}
                    </span>
                    {row.href ? <ChevronRight className="mt-1 size-4 shrink-0 text-ink-soft" aria-hidden /> : null}
                  </>
                );
                const className = "flex items-start gap-3 rounded-2xl border border-line bg-white p-3.5";
                return (
                  <li key={row.id} data-testid="notification-row" data-unread={row.unread ? "true" : "false"} data-kind={row.kind}>
                    {row.href ? (
                      <Link href={row.href} onClick={() => markOne(item)} className={className}>
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
              <p role="alert" className="mt-3 text-center text-[13px] font-semibold text-carrot-ink">
                {moreError}
              </p>
            ) : null}
            {nextCursor ? (
              <button
                onClick={() => void loadMore()}
                disabled={loadingMore}
                className="mt-4 flex w-full items-center justify-center rounded-xl border border-forest/30 bg-white py-3 text-[14px] font-bold text-forest disabled:opacity-50"
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
