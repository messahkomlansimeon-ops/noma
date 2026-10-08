"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { Send, ShieldAlert } from "lucide-react";
import { MessageBubble } from "@/components/message-bubble";
import { messagesRefresher } from "@/components/messages-badge";
import { DeclareOrder } from "@/components/orders/declare-order";
import { useUnauthorizedRedirect } from "@/components/session-gate";
import { openBrowserStream } from "@/components/social/browser-stream";
import { TopBar } from "@/components/top-bar";
import { createMessageSync, type MessageSync, type SyncStatus } from "@/lib/client/message-sync";
import { missionDraftMessage, type MissionHint } from "@/lib/client/missions-view";
import {
  COMPOSER_PLACEHOLDER,
  NO_PAYMENT_THROUGH_NOMA,
  OFFER_GONE_NOTICE,
  SAFETY_DISMISS_LABEL,
  SAFETY_REMINDER,
  SEND_LABEL,
  THREAD_EMPTY_BUYER,
  THREAD_EMPTY_SELLER,
  composerState,
  conversationOfferPath,
  conversationPath,
  counterpartLabel,
  markSafetyReminderSeen,
  mergeMessages,
  shouldShowSafetyReminder,
  type SimpleStorage,
} from "@/lib/client/messages-view";
import { orderPath, statusLabel } from "@/lib/client/orders-view";
import { describeSocialError, social, type ConversationDetail, type ConversationMessage } from "@/lib/client/social-api";

/** Stockage du navigateur, ou null s'il est absent ou refusé (navigation privée, données bloquées). */
function browserStorage(): SimpleStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

const STATUS_TEXT: Record<SyncStatus, string> = {
  connecting: "Connexion…",
  live: "En direct",
  reconnecting: "Reconnexion…",
  stopped: "Hors ligne",
};

/**
 * Le fil d'une conversation (lot D2), pour l'acheteur (`space="buyer"`) comme pour le vendeur (`space="vendor"`) : lecture, envoi, réception EN DIRECT (flux SSE puis relecture
 * par « messages après l'id X »), rappel de sécurité la première fois, liens vers l'annonce et la commande. L'autre partie est désignée par son rôle, jamais par une identité.
 * Le texte d'un message est TOUJOURS affiché comme du texte React (jamais interprété comme du HTML).
 * Lot MV1 : ouverte depuis une ligne de la proposition d'une mission (`hint` : quantité et prix visés, deux entiers lus dans l'adresse), la zone de saisie est PRÉ-REMPLIE d'un message
 * que l'acheteur peut modifier ; rien ne part tant qu'il n'appuie pas sur « envoyer ».
 */
export function ConversationScreen({ conversationId, space, hint = null }: { conversationId: string; space: "buyer" | "vendor"; hint?: MissionHint | null }) {
  const router = useRouter();
  const redirectIfUnauthorized = useUnauthorizedRedirect();
  const [detail, setDetail] = useState<ConversationDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [loadedMessages, setLoadedMessages] = useState(false);
  const [status, setStatus] = useState<SyncStatus>("connecting");
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [reminder, setReminder] = useState(() => shouldShowSafetyReminder(browserStorage()));
  const [reloadKey, setReloadKey] = useState(0);
  const syncRef = useRef<MessageSync | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const sendingRef = useRef(false);
  const draftApplied = useRef(false);
  const hintQuantity = hint?.quantity ?? null;
  const hintPrice = hint?.priceXof ?? null;

  // Fiche de la conversation ; un participant dans l'autre espace est ramené dans le sien.
  useEffect(() => {
    const controller = new AbortController();
    social.conversations.detail(conversationId, { signal: controller.signal }).then(
      (loaded) => {
        const home = space === "buyer" ? "buyer" : "seller";
        if (loaded.role !== home) {
          router.replace(conversationPath(loaded.role, loaded.id));
          return;
        }
        setDetail(loaded);
        setLoadError(null);
        // Message pré-rempli (lot MV1 ; une seule fois, et seulement dans une zone de saisie vide) : modifiable, jamais envoyé automatiquement.
        if (hintQuantity !== null && hintPrice !== null && loaded.role === "buyer" && !draftApplied.current) {
          draftApplied.current = true;
          setText((current) => (current === "" ? missionDraftMessage({ title: loaded.title, quantity: hintQuantity, unitPriceXof: hintPrice }) : current));
        }
      },
      (failure) => {
        if (controller.signal.aborted || redirectIfUnauthorized(failure)) return;
        setLoadError(describeSocialError(failure, "conversation"));
      },
    );
    return () => controller.abort();
  }, [conversationId, space, reloadKey, hintQuantity, hintPrice, redirectIfUnauthorized, router]);

  const markRead = useCallback(
    (upToId?: number) => {
      social.conversations.markRead(conversationId, upToId).then(
        (result) => messagesRefresher.set(result.unreadCount),
        () => {
          // Au mieux : un échec de « lu » ne gêne jamais la lecture.
        },
      );
    },
    [conversationId],
  );

  // Synchronisation : lecture initiale, flux en direct, rattrapage, reconnexion à attente croissante.
  const ready = detail !== null;
  useEffect(() => {
    if (!ready) return;
    const sync = createMessageSync({
      fetchMessages: async (afterId) => {
        try {
          return await social.conversations.messages(conversationId, { afterId });
        } catch (failure) {
          redirectIfUnauthorized(failure);
          throw failure;
        }
      },
      openStream: (handlers) => openBrowserStream(social.conversations.streamUrl(conversationId), handlers),
      onLoaded: () => setLoadedMessages(true),
      onMessages: (fresh) => {
        setMessages((current) => mergeMessages(current, fresh));
        if (fresh.some((message) => !message.mine) && document.visibilityState === "visible") markRead(Math.max(...fresh.map((message) => message.id)));
      },
      onStatus: setStatus,
    });
    syncRef.current = sync;
    sync.start();
    const onForeground = () => {
      if (document.visibilityState !== "visible") return;
      void sync.refresh();
      markRead();
    };
    document.addEventListener("visibilitychange", onForeground);
    markRead();
    return () => {
      document.removeEventListener("visibilitychange", onForeground);
      sync.stop();
      syncRef.current = null;
    };
  }, [ready, conversationId, markRead, redirectIfUnauthorized]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView?.({ block: "end" });
  }, [messages.length]);

  const send = async () => {
    if (sendingRef.current) return;
    const state = composerState(text, false);
    if (!state.canSend) return;
    sendingRef.current = true;
    setSending(true);
    setSendError(null);
    try {
      const message = await social.conversations.send(conversationId, text);
      syncRef.current?.noteKnown(message.id);
      setMessages((current) => mergeMessages(current, [message]));
      setText("");
      void syncRef.current?.refresh();
      if (reminder) {
        markSafetyReminderSeen(browserStorage());
        setReminder(false);
      }
    } catch (failure) {
      if (redirectIfUnauthorized(failure)) return;
      setSendError(describeSocialError(failure, "message"));
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  };

  const back = space === "buyer" ? "/messages" : "/vendeur/messages";
  if (loadError) {
    return (
      <main>
        <TopBar back={back} title="Conversation" />
        <div role="alert" data-testid="conversation-error" className="mx-4 mt-4 rounded-2xl border border-line bg-white p-4 text-center">
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
      </main>
    );
  }
  if (detail === null) {
    return (
      <main>
        <TopBar back={back} title="Conversation" />
        <p className="mt-6 text-center text-[14px] text-ink-soft" aria-busy="true">
          Chargement de la conversation…
        </p>
      </main>
    );
  }

  const label = counterpartLabel(detail.role, detail.title);
  const offerHref = conversationOfferPath(detail);
  const composer = composerState(text, sending);
  return (
    <main className="flex min-h-[calc(100dvh-8rem)] flex-col">
      <TopBar back={back} title="Conversation" border />
      <div className="px-4 pb-2 pt-2">
        <h1 data-testid="conversation-title" className="font-display text-[18px] font-extrabold leading-tight text-ink">
          {label}
        </h1>
        <div className="mt-0.5 flex items-center justify-between gap-2 text-[12px] text-ink-soft">
          <span data-testid="live-status" data-status={status}>
            {STATUS_TEXT[status]}
          </span>
          {offerHref ? (
            <Link href={offerHref} className="font-bold text-forest">
              {detail.role === "seller" ? "Voir mon annonce" : "Voir l'annonce"}
            </Link>
          ) : null}
        </div>
        {!detail.available ? (
          <p data-testid="offer-gone" className="mt-2 rounded-xl bg-wash px-3 py-2 text-[12px] font-semibold text-ink-soft">
            {OFFER_GONE_NOTICE}
          </p>
        ) : null}
        {reminder ? (
          <div data-testid="safety-reminder" role="note" className="mt-2 flex items-start gap-2 rounded-xl bg-carrot-soft px-3 py-2 text-[12px] text-carrot-ink">
            <ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
            <span className="flex-1">{SAFETY_REMINDER}</span>
            <button
              onClick={() => {
                markSafetyReminderSeen(browserStorage());
                setReminder(false);
              }}
              className="shrink-0 font-bold underline"
            >
              {SAFETY_DISMISS_LABEL}
            </button>
          </div>
        ) : null}
        {detail.order ? (
          <Link
            href={orderPath(detail.role, detail.order.id)}
            data-testid="conversation-order"
            className="mt-2 flex items-center justify-between rounded-xl border border-line bg-white px-3 py-2 text-[13px] font-semibold text-ink"
          >
            <span>Commande : {statusLabel(detail.order.status, detail.role)}</span>
            <span className="text-forest">Voir ›</span>
          </Link>
        ) : null}
        {detail.canDeclareOrder ? <DeclareOrder demandId={detail.demandId as string} offerId={detail.offerId} initialPrice={hint?.priceXof} initialQuantity={hint?.quantity} /> : null}
        {detail.role === "buyer" ? <p className="mt-2 text-[11px] leading-relaxed text-ink-soft">{NO_PAYMENT_THROUGH_NOMA}</p> : null}
      </div>

      <ul aria-label="Messages" aria-live="polite" data-testid="message-list" className="flex-1 space-y-2 px-4 pb-3 pt-1">
        {loadedMessages && messages.length === 0 ? (
          <li className="py-6 text-center text-[13px] text-ink-soft">{detail.role === "buyer" ? THREAD_EMPTY_BUYER : THREAD_EMPTY_SELLER}</li>
        ) : null}
        {messages.map((message) => (
          <MessageBubble key={message.id} message={message} />
        ))}
        <div ref={bottomRef} />
      </ul>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
        className="sticky bottom-[4.25rem] border-t border-line bg-cream/95 px-3 py-2 backdrop-blur"
      >
        {sendError ? (
          <p role="alert" data-testid="send-error" className="mb-1.5 text-[12px] font-semibold text-carrot-ink">
            {sendError}
          </p>
        ) : null}
        {composer.problem ? (
          <p role="alert" className="mb-1.5 text-[12px] font-semibold text-carrot-ink">
            {composer.problem}
          </p>
        ) : null}
        <div className="flex items-end gap-2">
          <textarea
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void send();
              }
            }}
            rows={text.length > 70 ? 3 : 1}
            placeholder={COMPOSER_PLACEHOLDER}
            aria-label="Votre message"
            data-testid="message-input"
            className="max-h-32 min-h-11 flex-1 resize-none rounded-2xl border border-line bg-white px-3.5 py-2.5 text-[15px] text-ink placeholder:text-ink-soft/50"
          />
          <button
            type="submit"
            disabled={!composer.canSend}
            data-testid="message-send"
            aria-label={SEND_LABEL}
            className="flex size-11 shrink-0 items-center justify-center rounded-full bg-forest text-white transition active:scale-95 disabled:opacity-40"
          >
            <Send className="size-5" aria-hidden />
          </button>
        </div>
        <div className="mt-1 text-right text-[10px] text-ink-soft">{composer.counter}</div>
      </form>
    </main>
  );
}
