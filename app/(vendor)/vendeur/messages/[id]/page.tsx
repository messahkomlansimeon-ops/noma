"use client";

import { useParams } from "next/navigation";
import { ConversationScreen } from "@/components/conversation-screen";
import { SessionGate } from "@/components/session-gate";
import { TopBar } from "@/components/top-bar";
import { isUuid } from "@/lib/client/api";

export default function ConversationVendeur() {
  const params = useParams<{ id: string }>();
  const id = typeof params.id === "string" ? params.id : "";
  return (
    <SessionGate>
      {isUuid(id) ? (
        <ConversationScreen conversationId={id} space="vendor" />
      ) : (
        <main>
          <TopBar back="/vendeur/messages" title="Conversation" />
          <p role="alert" className="mt-6 text-center text-[14px] font-semibold text-ink">
            Conversation introuvable.
          </p>
        </main>
      )}
    </SessionGate>
  );
}
