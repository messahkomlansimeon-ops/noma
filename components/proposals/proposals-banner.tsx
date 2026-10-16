"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { proposals } from "@/lib/client/proposals-api";
import { pendingText } from "@/lib/client/proposals-view";

/** « n propositions en attente » pour CE besoin, avec le lien vers « Propositions reçues » (pas de notification : la bannière et le compte sont les seules annonces d'une proposition). Silencieuse en cas d'erreur. */
export function ProposalsBanner({ demandId }: { demandId: string }) {
  const [count, setCount] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    proposals.list("buyer", { signal: controller.signal }).then(
      (list) => setCount(list.proposals.filter((proposal) => proposal.demandId === demandId && proposal.status === "sent").length),
      () => undefined,
    );
    return () => controller.abort();
  }, [demandId]);
  const text = pendingText(count);
  if (text === null) return null;
  return (
    <Link href="/propositions" data-testid="proposals-banner" className="mt-3 flex items-center justify-between rounded-2xl border border-forest/30 bg-sage px-3.5 py-3 text-[14px] font-bold text-forest">
      <span>{text}</span>
      <span aria-hidden>›</span>
    </Link>
  );
}
