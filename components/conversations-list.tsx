"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ChevronRight, MessageCircle } from "lucide-react";
import { messagesRefresher } from "@/components/messages-badge";
import { useUnauthorizedRedirect } from "@/components/session-gate";
import { TopBar } from "@/components/top-bar";
import {
  MESSAGES_EMPTY,
  MESSAGES_EMPTY_BUYER_HINT,
  MESSAGES_EMPTY_SELLER_HINT,
  MESSAGES_LOADING,
  MESSAGES_TITLE,
  conversationRow,
} from "@/lib/client/messages-view";
import { describeSocialError, social, type ConversationSummary } from "@/lib/client/social-api";

/** Liste des conversations (lot D2) : les non lues en gras ; l'autre partie est désignée SANS identité (« Vendeur de l'annonce … », « Acheteur intéressé »). */
export function ConversationsList({ space }: { space: "buyer" | "vendor" }) {
  const redirectIfUnauthorized = useUnauthorizedRedirect();
  const [items, setItems] = useState<ConversationSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    social.conversations.list({ signal: controller.signal }).then(
      (page) => {
        setItems(page.items);
        setError(null);
        messagesRefresher.set(page.unreadCount);
      },
      (failure) => {
        if (controller.signal.aborted || redirectIfUnauthorized(failure)) return;
        setError(describeSocialError(failure, "conversation"));
      },
    );
    return () => controller.abort();
  }, [reloadKey, redirectIfUnauthorized]);

  useEffect(() => {
    const onForeground = () => {
      if (document.visibilityState === "visible") setReloadKey((key) => key + 1);
    };
    document.addEventListener("visibilitychange", onForeground);
    return () => document.removeEventListener("visibilitychange", onForeground);
  }, []);

  const back = space === "buyer" ? "/compte" : "/vendeur";
  return (
    <main>
      <TopBar back={back} title={MESSAGES_TITLE} />
      <div className="px-4 pb-6">
        <h1 className="font-display text-[22px] font-extrabold text-ink">{MESSAGES_TITLE}</h1>
        {error ? (
          <div role="alert" className="mt-4 rounded-2xl border border-line bg-white p-4 text-center">
            <p className="text-[14px] font-semibold text-ink">{error}</p>
            <button
              onClick={() => {
                setError(null);
                setReloadKey((key) => key + 1);
              }}
              className="mt-3 rounded-xl bg-forest px-5 py-2.5 text-[14px] font-bold text-white"
            >
              Réessayer
            </button>
          </div>
        ) : items === null ? (
          <p className="mt-6 text-center text-[14px] text-ink-soft" aria-busy="true">
            {MESSAGES_LOADING}
          </p>
        ) : items.length === 0 ? (
          <div role="status" data-testid="messages-empty" className="mt-6 rounded-2xl bg-wash p-5 text-center">
            <MessageCircle className="mx-auto size-7 text-ink-soft" aria-hidden />
            <p className="mt-2 text-[14px] font-bold text-ink">{MESSAGES_EMPTY}</p>
            <p className="mt-1 text-[13px] text-ink-soft">{space === "buyer" ? MESSAGES_EMPTY_BUYER_HINT : MESSAGES_EMPTY_SELLER_HINT}</p>
          </div>
        ) : (
          <ul aria-label="Vos conversations" className="mt-3 space-y-2.5" data-testid="conversation-list">
            {items.map((item) => {
              const row = conversationRow(item);
              return (
                <li key={row.id} data-testid="conversation-row" data-unread={row.unread ? "true" : "false"}>
                  <Link href={row.href} className="flex items-start gap-3 rounded-2xl border border-line bg-white p-3.5">
                    <span aria-hidden className={`mt-1.5 size-2.5 shrink-0 rounded-full ${row.unread ? "bg-carrot" : "bg-transparent"}`} />
                    <span className="min-w-0 flex-1">
                      <span className={`block text-[15px] text-ink ${row.unread ? "font-extrabold" : "font-semibold"}`}>
                        {row.unread ? <span className="sr-only">non lu : </span> : null}
                        {row.label}
                      </span>
                      {row.subtitle ? <span className="block truncate text-[12px] text-ink-soft">{row.subtitle}</span> : null}
                      <span className={`mt-0.5 block truncate text-[13px] ${row.unread ? "font-bold text-ink" : "text-ink-soft"}`}>{row.preview}</span>
                      <span className="mt-0.5 block text-[11px] text-ink-soft">
                        {row.dateText}
                        {row.available ? "" : " · annonce plus disponible"}
                      </span>
                    </span>
                    {row.unread ? (
                      <span className="mt-1 flex min-w-5 items-center justify-center rounded-full bg-carrot px-1.5 text-[11px] font-extrabold leading-5 text-white">{row.unreadCount}</span>
                    ) : null}
                    <ChevronRight className="mt-1 size-4 shrink-0 text-ink-soft" aria-hidden />
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </main>
  );
}
