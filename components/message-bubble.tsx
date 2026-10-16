import { formatDateTimeFr } from "@/lib/client/wallet-view";
import type { ConversationMessage } from "@/lib/client/social-api";

/**
 * Une bulle de message (lot D2). Le texte est TOUJOURS un enfant React (échappé) : un message qui ressemble à du HTML (`<img onerror=…>`, `<script>`) s'affiche tel quel, en
 * texte ; rien n'est jamais interprété (aucun `dangerouslySetInnerHTML` dans l'application : un essai le vérifie).
 */
export function MessageBubble({ message }: { message: ConversationMessage }) {
  return (
    <li data-testid="message-bubble" data-mine={message.mine ? "true" : "false"} className={`animate-rise flex ${message.mine ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[82%] px-4 py-2.5 md:max-w-[70%] ${
          message.mine ? "rounded-3xl rounded-br-lg bg-brand text-white" : "rounded-3xl rounded-bl-lg border border-line bg-white text-ink"
        }`}
      >
        <p className="whitespace-pre-wrap break-words text-[16px] leading-snug">{message.body}</p>
        <p className={`mt-1 text-right text-[12px] ${message.mine ? "text-white/80" : "text-ink-soft"}`}>{formatDateTimeFr(message.createdAt)}</p>
      </div>
    </li>
  );
}
