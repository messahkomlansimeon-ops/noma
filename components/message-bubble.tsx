import { formatDateTimeFr } from "@/lib/client/wallet-view";
import type { ConversationMessage } from "@/lib/client/social-api";

/**
 * Une bulle de message (lot D2). Le texte est TOUJOURS un enfant React (échappé) : un message qui ressemble à du HTML (`<img onerror=…>`, `<script>`) s'affiche tel quel, en
 * texte ; rien n'est jamais interprété (aucun `dangerouslySetInnerHTML` dans l'application : un essai le vérifie).
 */
export function MessageBubble({ message }: { message: ConversationMessage }) {
  return (
    <li data-testid="message-bubble" data-mine={message.mine ? "true" : "false"} className={`flex ${message.mine ? "justify-end" : "justify-start"}`}>
      <div className={`max-w-[82%] rounded-2xl px-3.5 py-2 ${message.mine ? "bg-forest text-white" : "border border-line bg-white text-ink"}`}>
        <p className="whitespace-pre-wrap break-words text-[14px] leading-snug">{message.body}</p>
        <p className={`mt-0.5 text-right text-[10px] ${message.mine ? "text-white/70" : "text-ink-soft"}`}>{formatDateTimeFr(message.createdAt)}</p>
      </div>
    </li>
  );
}
