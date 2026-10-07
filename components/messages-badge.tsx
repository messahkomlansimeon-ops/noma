"use client";

import { useEffect, useSyncExternalStore } from "react";
import { createUnreadRefresher, unreadBadgeLabel, type UnreadRefresher } from "@/lib/client/notifications-view";
import { messagesBadgeAccessibleLabel } from "@/lib/client/messages-view";
import { social } from "@/lib/client/social-api";

/**
 * Compteur de conversations non lues du navigateur (lot D2) : MÊME règle de relecture que les notifications (`createUnreadRefresher` : au plus UNE relecture par minute,
 * aucun sondage serré), relu à l'arrivée sur un écran dont la session est confirmée et au retour au premier plan ; un visiteur anonyme ne provoque jamais de requête 401.
 */
export const messagesRefresher: UnreadRefresher = createUnreadRefresher({
  fetchCount: () => social.conversations.unreadCount(),
});

export function useMessagesUnread(): number | null {
  return useSyncExternalStore(messagesRefresher.subscribe, messagesRefresher.get, () => null);
}

/** À placer dans une page DONT LA SESSION EST CONFIRMÉE. */
export function MessagesUnreadSync({ initial = true }: { initial?: boolean } = {}) {
  useEffect(() => {
    if (initial) void messagesRefresher.refresh();
    const onForeground = () => {
      if (document.visibilityState === "visible") void messagesRefresher.refresh();
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

/** Pastille ronde du nombre de conversations non lues (rien si zéro ou inconnu). */
export function MessagesBadge({ className = "" }: { className?: string }) {
  const count = useMessagesUnread();
  const label = unreadBadgeLabel(count);
  if (label === null) return null;
  return (
    <span
      data-testid="messages-badge"
      role="status"
      aria-label={messagesBadgeAccessibleLabel(count)}
      className={`flex min-w-5 items-center justify-center rounded-full bg-carrot px-1.5 text-[11px] font-extrabold leading-5 text-white ${className}`}
    >
      {label}
    </span>
  );
}
