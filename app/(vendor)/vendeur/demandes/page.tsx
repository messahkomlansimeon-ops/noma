"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { CircleCheck, Send, ShieldCheck, Undo2 } from "lucide-react";
import { ArtChat, ArtEmpty } from "@/components/illustrations";
import { InterestedBuyerCard } from "@/components/matches/match-parts";
import { SessionGate, useUnauthorizedRedirect } from "@/components/session-gate";
import { TopBar } from "@/components/top-bar";
import { Badge, EmptyState, IconTile } from "@/components/ui";
import { BTN_PRIMARY, BTN_SMALL, ErrorState, LoadingBlock, Notice, SectionHeading } from "@/components/vendor/vendor-parts";
import { describeProposalError, proposals, type Proposal, type SellerRequests } from "@/lib/client/proposals-api";
import {
  REQUESTS_EMPTY,
  REQUESTS_HINT,
  REQUESTS_TITLE,
  REQUESTS_TRUNCATED_NOTE,
  SENT_EMPTY,
  SENT_TITLE,
  WITHDRAWN_MESSAGE,
  canAnswer,
  proposalRow,
  requestPath,
  requestRow,
} from "@/lib/client/proposals-view";

interface Loaded {
  requests: SellerRequests;
  sent: Proposal[];
}

function Content() {
  const redirectIfUnauthorized = useUnauthorizedRedirect();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const busy = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    Promise.all([proposals.requests({ signal: controller.signal }), proposals.list("seller", { signal: controller.signal })]).then(
      ([requests, sent]) => {
        setLoaded({ requests, sent: sent.proposals });
        setError(null);
      },
      (failure) => {
        if (controller.signal.aborted || redirectIfUnauthorized(failure)) return;
        setError(describeProposalError(failure, "list"));
      },
    );
    return () => controller.abort();
  }, [reloadKey, redirectIfUnauthorized]);

  const withdraw = useCallback(
    async (id: string) => {
      if (busy.current) return;
      busy.current = true;
      setPendingId(id);
      setNotice(null);
      try {
        await proposals.act(id, "withdraw");
        setNotice(WITHDRAWN_MESSAGE);
        setReloadKey((key) => key + 1);
      } catch (failure) {
        if (redirectIfUnauthorized(failure)) return;
        setError(describeProposalError(failure, "answer"));
        setReloadKey((key) => key + 1);
      } finally {
        busy.current = false;
        setPendingId(null);
      }
    },
    [redirectIfUnauthorized],
  );

  if (error && loaded === null) {
    return <ErrorState message={error} />;
  }
  if (loaded === null) {
    return <LoadingBlock label="Chargement…" className="pt-3" />;
  }
  const { requests, sent } = loaded;
  return (
    <div data-testid="vendor-requests" className="flex flex-col gap-4 pt-3">
      <Notice tone="info" icon={ShieldCheck} small>
        {REQUESTS_HINT}
      </Notice>
      {notice ? (
        <Notice tone="brand" icon={CircleCheck} role="status">
          {notice}
        </Notice>
      ) : null}
      {error ? (
        <Notice tone="danger" role="alert">
          {error}
        </Notice>
      ) : null}
      {requests.requests.length === 0 ? (
        <EmptyState art={<ArtChat className="size-36" />} title={REQUESTS_EMPTY} />
      ) : (
        <ul aria-label={REQUESTS_TITLE} className="stagger flex flex-col gap-3 md:grid md:grid-cols-2 md:items-start">
          {requests.requests.map((request) => {
            const row = requestRow(request);
            const href = requestPath(row.demandId);
            return (
              <li key={row.demandId} data-testid="vendor-request" className="rounded-3xl border border-line bg-white p-1.5">
                <ul>
                  <InterestedBuyerCard item={request.need} />
                </ul>
                <div className="flex flex-col gap-2.5 px-2.5 pb-2.5 pt-1">
                  <p className="text-[13px] text-ink-soft">{row.offersText}</p>
                  {row.proposedCount > 0 ? (
                    <div>
                      <Badge tone="sage">
                        <CircleCheck className="size-3.5" aria-hidden />
                        {row.allProposed ? "Proposition envoyée" : `${row.proposedCount} proposition(s) envoyée(s)`}
                      </Badge>
                    </div>
                  ) : null}
                  {href ? (
                    <Link href={href} data-testid="vendor-request-open" className={BTN_PRIMARY}>
                      <Send className="size-5" aria-hidden />
                      Répondre
                    </Link>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {requests.offersTruncated ? (
        <Notice tone="mist" role="status" small>
          {REQUESTS_TRUNCATED_NOTE}
        </Notice>
      ) : null}

      <div className="mt-2 flex flex-col gap-3">
        <SectionHeading icon={Send}>{SENT_TITLE}</SectionHeading>
        {sent.length === 0 ? (
          <EmptyState art={<ArtEmpty className="size-28" />} title={SENT_EMPTY} />
        ) : (
          <ul className="stagger flex flex-col gap-3 md:grid md:grid-cols-2 md:items-start" aria-label={SENT_TITLE}>
            {sent.map((proposal) => {
              const row = proposalRow(proposal, "seller");
              return (
                <li key={row.id} data-testid="sent-proposal" data-status={row.status} className="rounded-3xl border border-line bg-white p-4">
                  <div className="flex items-start gap-3">
                    <IconTile icon={Send} tone="brand" />
                    <span className="min-w-0 flex-1 pt-0.5 text-[16px] font-bold leading-snug text-ink">{row.title}</span>
                    <Badge tone={row.status === "sent" ? "carrot" : row.status === "accepted" ? "sage" : "wash"}>{row.statusText}</Badge>
                  </div>
                  <div className="mt-1 text-[20px] font-extrabold text-ink">{row.priceText}</div>
                  <div className="text-[13px] text-ink-soft">{row.validText}</div>
                  {canAnswer(proposal) ? (
                    <button
                      onClick={() => void withdraw(proposal.id)}
                      disabled={pendingId === proposal.id}
                      data-testid="proposal-withdraw"
                      className={`${BTN_SMALL} mt-3`}
                    >
                      <Undo2 className="size-4" aria-hidden />
                      Retirer
                    </button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

export default function VendeurDemandes() {
  return (
    <SessionGate>
      <main>
        <TopBar back="/vendeur" title={REQUESTS_TITLE} />
        <div className="px-4 pb-8">
          <Content />
        </div>
      </main>
    </SessionGate>
  );
}
