"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ChevronRight, Inbox } from "lucide-react";
import { IconTile } from "@/components/ui";
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
    <Link
      href="/propositions"
      data-testid="proposals-banner"
      className="press animate-pop mt-3 flex min-h-14 items-center gap-3 rounded-3xl bg-brand-soft px-3.5 py-2.5 text-[15px] font-bold text-brand-ink hover:bg-brand-soft/70"
    >
      <IconTile icon={Inbox} tone="accent" className="size-10" />
      <span className="flex-1">{text}</span>
      <ChevronRight className="size-5 shrink-0" aria-hidden />
    </Link>
  );
}
