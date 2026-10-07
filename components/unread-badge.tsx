"use client";

import { useEffect, useSyncExternalStore } from "react";
import { api } from "@/lib/client/api";
import {
  createUnreadRefresher,
  unreadBadgeAccessibleLabel,
  unreadBadgeLabel,
  type UnreadRefresher,
} from "@/lib/client/notifications-view";

/**
 * Compteur de notifications non lues du navigateur (lot N1) : UN seul compteur pour toute l'application, relu au plus UNE fois par minute (aucun
 * sondage serré, voir `createUnreadRefresher`). Il n'est relu QUE depuis un écran dont la session est confirmée (`UnreadSync`, placé dans les pages
 * gardées) : un visiteur anonyme ne provoque jamais de requête 401.
 */
export const unreadRefresher: UnreadRefresher = createUnreadRefresher({
  fetchCount: async () => (await api.notifications.list({ limit: 1 })).unreadCount,
});

export function useUnreadCount(): number | null {
  return useSyncExternalStore(unreadRefresher.subscribe, unreadRefresher.get, () => null);
}

/**
 * À placer dans une page DONT LA SESSION EST CONFIRMÉE : relit le compteur à l'arrivée sur la page et au retour au premier plan (onglet de nouveau visible,
 * page restaurée). La relecture est limitée à une par minute par le compteur lui-même.
 */
export function UnreadSync({ initial = true }: { initial?: boolean } = {}) {
  useEffect(() => {
    // `initial` faux : la page lit déjà le compteur elle-même à son arrivée (elle ne fait alors qu'écouter le retour au premier plan).
    if (initial) void unreadRefresher.refresh();
    const onForeground = () => {
      if (document.visibilityState === "visible") void unreadRefresher.refresh();
    };
    document.addEventListener("visibilitychange", onForeground);
    window.addEventListener("pageshow", onForeground);
    return () => {
      document.removeEventListener("visibilitychange", onForeground);
      window.removeEventListener("pageshow", onForeground);
    };
  }, [initial]);
  return null;
}

/** Pastille ronde du nombre de non-lues (rien si zéro ou inconnu). */
export function UnreadBadge({ className = "" }: { className?: string }) {
  const count = useUnreadCount();
  const label = unreadBadgeLabel(count);
  if (label === null) return null;
  return (
    <span
      data-testid="unread-badge"
      role="status"
      aria-label={unreadBadgeAccessibleLabel(count)}
      className={`flex min-w-5 items-center justify-center rounded-full bg-carrot px-1.5 text-[11px] font-extrabold leading-5 text-white ${className}`}
    >
      {label}
    </span>
  );
}
