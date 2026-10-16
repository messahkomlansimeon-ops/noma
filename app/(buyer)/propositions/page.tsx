"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Bell, ChevronRight, CircleAlert, CircleCheck, CircleX, Handshake, Info } from "lucide-react";
import { SessionGate, useUnauthorizedRedirect } from "@/components/session-gate";
import { ArtAlert, ArtTag } from "@/components/illustrations";
import { TopBar } from "@/components/top-bar";
import { Badge, EmptyState, IconTile, Skeleton } from "@/components/ui";
import { describeProposalError, proposals, type Proposal } from "@/lib/client/proposals-api";
import { BUYER_EMPTY, BUYER_HINT, BUYER_TITLE, canAnswer, outcomeText, pendingText, proposalRow } from "@/lib/client/proposals-view";

function Content() {
  const redirectIfUnauthorized = useUnauthorizedRedirect();
  const [items, setItems] = useState<Proposal[] | null>(null);
  const [pending, setPending] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; orderId: string | null } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const busy = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    proposals.list("buyer", { signal: controller.signal }).then(
      (list) => {
        setItems(list.proposals);
        setPending(list.pendingCount ?? 0);
      },
      (failure) => {
        if (controller.signal.aborted || redirectIfUnauthorized(failure)) return;
        setError(describeProposalError(failure, "list"));
      },
    );
    return () => controller.abort();
  }, [reloadKey, redirectIfUnauthorized]);

  const answer = useCallback(
    async (id: string, action: "accept" | "decline") => {
      if (busy.current) return;
      busy.current = true;
      setBusyId(id);
      setNotice(null);
      setError(null);
      try {
        const result = await proposals.act(id, action);
        setNotice({ text: outcomeText(action), orderId: result.orderId });
      } catch (failure) {
        if (redirectIfUnauthorized(failure)) return;
        setError(describeProposalError(failure, "answer"));
      } finally {
        busy.current = false;
        setBusyId(null);
        setReloadKey((key) => key + 1);
      }
    },
    [redirectIfUnauthorized],
  );

  if (error && items === null) {
    return (
      <div role="alert">
        <EmptyState art={<ArtAlert className="size-32" />} title={error} />
      </div>
    );
  }
  if (items === null) {
    return (
      <div className="mt-4 flex flex-col gap-3 md:grid md:grid-cols-2" aria-busy="true">
        <span className="sr-only">Chargement…</span>
        <Skeleton className="h-36 w-full rounded-3xl" />
        <Skeleton className="h-36 w-full rounded-3xl" />
      </div>
    );
  }
  const pendingLine = pendingText(pending);
  return (
    <div data-testid="buyer-proposals" className="mt-3 flex flex-col gap-3">
      {pendingLine ? (
        <p data-testid="proposals-pending" className="animate-pop flex items-center gap-2.5 rounded-2xl bg-accent-soft px-4 py-3 text-[15px] font-bold text-accent-ink">
          <Bell className="size-5 shrink-0" aria-hidden />
          {pendingLine}
        </p>
      ) : null}
      {notice ? (
        <p role="status" data-testid="proposal-notice" className="animate-pop flex items-center gap-2.5 rounded-2xl bg-success-soft px-4 py-3 text-[15px] font-semibold text-success-ink">
          <CircleCheck className="size-5 shrink-0" aria-hidden />
          <span>
            {notice.text}{" "}
            {notice.orderId ? (
              <Link href={`/commandes/${notice.orderId}`} className="font-bold underline">
                Voir la commande
              </Link>
            ) : null}
          </span>
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="animate-pop flex items-center gap-2.5 rounded-2xl bg-danger-soft px-4 py-3 text-[15px] font-semibold text-danger-ink">
          <CircleAlert className="size-5 shrink-0" aria-hidden />
          {error}
        </p>
      ) : null}
      {items.length === 0 ? (
        <EmptyState art={<ArtTag className="size-36" />} title={BUYER_EMPTY} />
      ) : (
        <>
          <ul className="stagger flex flex-col gap-3 md:grid md:grid-cols-2" aria-label={BUYER_TITLE}>
            {items.map((proposal) => {
              const row = proposalRow(proposal, "buyer");
              return (
                <li key={row.id} data-testid="buyer-proposal" data-status={row.status} className="flex flex-col rounded-3xl border border-line bg-white p-4">
                  <div className="flex items-start gap-3">
                    <IconTile icon={Handshake} tone={row.status === "sent" ? "accent" : row.status === "accepted" ? "success" : "mist"} className="size-11" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-start justify-between gap-2">
                        <span className="text-[16px] font-bold leading-snug text-ink">{row.title}</span>
                        <Badge tone={row.status === "sent" ? "carrot" : row.status === "accepted" ? "sage" : "wash"}>{row.statusText}</Badge>
                      </div>
                      <div data-testid="proposal-price" className="mt-0.5 text-[22px] font-extrabold leading-tight text-ink">
                        {row.priceText}
                      </div>
                    </div>
                  </div>
                  {row.lines.length > 0 ? (
                    <ul className="mt-2 space-y-0.5 text-[14px] text-ink" aria-label="Lignes du devis">
                      {row.lines.map((line, index) => (
                        <li key={index} className="flex justify-between gap-3">
                          <span>{line.label}</span>
                          <span className="font-semibold">{line.amountText}</span>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {row.details.map((detail) => (
                    <div key={detail} className="mt-0.5 text-[14px] text-ink-soft">
                      {detail}
                    </div>
                  ))}
                  <div className="mt-1 text-[13px] text-ink-soft">{row.validText}</div>
                  {canAnswer(proposal) ? (
                    <div className="mt-3 grid grid-cols-2 gap-3">
                      <button
                        onClick={() => void answer(proposal.id, "decline")}
                        disabled={busyId === proposal.id}
                        data-testid="proposal-decline"
                        className="press flex min-h-12 items-center justify-center gap-2 rounded-2xl border-2 border-line-strong bg-white px-3 py-3 text-[15px] font-bold text-ink hover:border-brand hover:text-brand disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        <CircleX className="size-5" aria-hidden />
                        Refuser
                      </button>
                      <button
                        onClick={() => void answer(proposal.id, "accept")}
                        disabled={busyId === proposal.id}
                        data-testid="proposal-accept"
                        className="press flex min-h-12 items-center justify-center gap-2 rounded-2xl bg-brand px-3 py-3 text-[15px] font-bold text-white hover:bg-brand-deep disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        <CircleCheck className="size-5" aria-hidden />
                        Accepter
                      </button>
                    </div>
                  ) : proposal.orderId ? (
                    <Link href={`/commandes/${proposal.orderId}`} className="press mt-2 inline-flex min-h-11 items-center gap-1 text-[14px] font-bold text-brand">
                      Voir la commande
                      <ChevronRight className="size-4" aria-hidden />
                    </Link>
                  ) : null}
                </li>
              );
            })}
          </ul>
          {items.some((proposal) => canAnswer(proposal)) ? (
            <p className="flex items-start gap-2.5 rounded-2xl bg-mist p-3.5 text-[13px] leading-relaxed text-ink-soft">
              <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
              {BUYER_HINT}
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}

export default function Propositions() {
  return (
    <SessionGate>
      <main>
        <TopBar back="/compte" title={BUYER_TITLE} />
        <div className="px-4 pb-8">
          <Content />
        </div>
      </main>
    </SessionGate>
  );
}
