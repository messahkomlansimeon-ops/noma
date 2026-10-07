"use client";

import { ConversationsList } from "@/components/conversations-list";
import { MessagesUnreadSync } from "@/components/messages-badge";
import { SessionGate } from "@/components/session-gate";

export default function MessagesVendeur() {
  return (
    <SessionGate>
      <MessagesUnreadSync initial={false} />
      <ConversationsList space="vendor" />
    </SessionGate>
  );
}
