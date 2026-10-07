"use client";

import { ConversationsList } from "@/components/conversations-list";
import { MessagesUnreadSync } from "@/components/messages-badge";
import { SessionGate } from "@/components/session-gate";

export default function Messages() {
  return (
    <SessionGate>
      <MessagesUnreadSync initial={false} />
      <ConversationsList space="buyer" />
    </SessionGate>
  );
}
