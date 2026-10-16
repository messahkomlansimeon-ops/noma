"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ChevronRight, MessageCircle, RotateCw } from "lucide-react";
import { messagesRefresher } from "@/components/messages-badge";
import { useUnauthorizedRedirect } from "@/components/session-gate";
import { ArtAlert, ArtChat } from "@/components/illustrations";
import { TopBar } from "@/components/top-bar";
import { Badge, Btn, EmptyState, IconTile, Skeleton } from "@/components/ui";
import {
  MESSAGES_EMPTY,
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
      {/* Lot FIN1 : titre dit une fois (le h1). */}
      <TopBar back={back} />
      <div className="px-4 pb-6">
        <h1 className="flex items-center gap-2.5 text-[24px] font-extrabold tracking-tight text-ink">
          <MessageCircle className="size-6 text-brand" aria-hidden />
          {MESSAGES_TITLE}
        </h1>
        {error ? (
          <div role="alert" className="animate-rise mt-4 flex flex-col items-center gap-4 rounded-3xl border border-line bg-white p-6 text-center">
            <ArtAlert className="size-24" />
            <p className="text-[16px] font-bold text-ink">{error}</p>
            <div className="w-full max-w-xs">
              <Btn
                onClick={() => {
                  setError(null);
                  setReloadKey((key) => key + 1);
                }}
              >
                <RotateCw className="size-5" aria-hidden />
                Réessayer
              </Btn>
            </div>
          </div>
        ) : items === null ? (
          <div className="mt-4 flex flex-col gap-3 md:grid md:grid-cols-2" aria-busy="true">
            <span className="sr-only">{MESSAGES_LOADING}</span>
            <Skeleton className="h-20 w-full rounded-3xl" />
            <Skeleton className="h-20 w-full rounded-3xl" />
            <Skeleton className="h-20 w-full rounded-3xl" />
          </div>
        ) : items.length === 0 ? (
          <div role="status" data-testid="messages-empty">
            <EmptyState art={<ArtChat className="size-36" />} title={MESSAGES_EMPTY} />
          </div>
        ) : (
          <ul aria-label="Vos conversations" className="stagger mt-4 flex flex-col gap-3 md:grid md:grid-cols-2" data-testid="conversation-list">
            {items.map((item) => {
              const row = conversationRow(item);
              return (
                <li key={row.id} data-testid="conversation-row" data-unread={row.unread ? "true" : "false"}>
                  <Link href={row.href} className="press flex min-h-20 items-center gap-3 rounded-3xl border border-line bg-white p-3.5 hover:border-brand">
                    <IconTile icon={MessageCircle} tone={row.unread ? "accent" : "brand"} className="size-12" />
                    <span className="min-w-0 flex-1">
                      <span className={`block truncate text-[16px] text-ink ${row.unread ? "font-extrabold" : "font-bold"}`}>
                        {row.unread ? <span className="sr-only">non lu : </span> : null}
                        {row.label}
                      </span>
                      {row.subtitle ? <span className="block truncate text-[13px] text-ink-soft">{row.subtitle}</span> : null}
                      <span className={`block truncate text-[14px] ${row.unread ? "font-bold text-ink" : "text-ink-soft"}`}>{row.preview}</span>
                      <span className="mt-1 flex flex-wrap items-center gap-1.5 text-[12px] text-ink-soft">
                        {row.dateText}
                        {row.available ? null : <Badge tone="wash">annonce plus disponible</Badge>}
                      </span>
                    </span>
                    {row.unread ? (
                      <span className="flex min-w-6 items-center justify-center rounded-full bg-accent px-1.5 text-[12px] font-extrabold leading-6 text-ink">{row.unreadCount}</span>
                    ) : null}
                    <ChevronRight className="size-5 shrink-0 text-ink-soft" aria-hidden />
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
