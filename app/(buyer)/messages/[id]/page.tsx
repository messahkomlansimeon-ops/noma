"use client";

import { Suspense } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { ConversationScreen } from "@/components/conversation-screen";
import { SessionGate } from "@/components/session-gate";
import { ArtAlert } from "@/components/illustrations";
import { TopBar } from "@/components/top-bar";
import { EmptyState } from "@/components/ui";
import { isUuid } from "@/lib/client/api";
import { parseMissionHint } from "@/lib/client/missions-view";

/** Lot MV1 : depuis une ligne de mission, l'adresse porte la quantité et le prix visés (deux entiers) qui pré-remplissent le message. */
function ConversationWithHint({ id }: { id: string }) {
  const search = useSearchParams();
  const hint = parseMissionHint(search.get("quantite"), search.get("prix"));
  return <ConversationScreen conversationId={id} space="buyer" hint={hint} />;
}

export default function Conversation() {
  const params = useParams<{ id: string }>();
  const id = typeof params.id === "string" ? params.id : "";
  return (
    <SessionGate>
      {isUuid(id) ? (
        // useSearchParams exige une frontière Suspense pour que le reste de la page reste pré-rendu.
        <Suspense fallback={null}>
          <ConversationWithHint id={id} />
        </Suspense>
      ) : (
        <main>
          <TopBar back="/messages" title="Conversation" />
          <div role="alert">
            <EmptyState art={<ArtAlert className="size-32" />} title="Conversation introuvable." />
          </div>
        </main>
      )}
    </SessionGate>
  );
}
