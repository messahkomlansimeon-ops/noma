"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { InterestedBuyerCard } from "@/components/matches/match-parts";
import { SessionGate, useUnauthorizedRedirect } from "@/components/session-gate";
import { TopBar } from "@/components/top-bar";
import { Badge } from "@/components/ui";
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
    return (
      <p role="alert" className="mt-6 text-center text-[15px] font-semibold text-ink">
        {error}
      </p>
    );
  }
  if (loaded === null) {
    return (
      <p aria-busy="true" className="mt-6 text-center text-[15px] text-ink-soft">
        Chargement…
      </p>
    );
  }
  const { requests, sent } = loaded;
  return (
    <div data-testid="vendor-requests">
      <p className="mt-3 text-[14px] text-ink-soft">{REQUESTS_HINT}</p>
      {notice ? (
        <p role="status" className="mt-2 rounded-xl bg-brand-soft px-3 py-2 text-[14px] font-semibold text-brand">
          {notice}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="mt-2 text-[14px] font-semibold text-accent-ink">
          {error}
        </p>
      ) : null}
      {requests.requests.length === 0 ? (
        <p className="mt-4 rounded-2xl bg-mist p-4 text-center text-[15px] text-ink-soft">{REQUESTS_EMPTY}</p>
      ) : (
        <ul aria-label={REQUESTS_TITLE} className="mt-3 space-y-3">
          {requests.requests.map((request) => {
            const row = requestRow(request);
            const href = requestPath(row.demandId);
            return (
              <li key={row.demandId} data-testid="vendor-request" className="rounded-2xl border border-line bg-white p-1">
                <ul>
                  <InterestedBuyerCard item={request.need} />
                </ul>
                <div className="px-3.5 pb-3">
                  <p className="text-[13px] text-ink-soft">{row.offersText}</p>
                  {row.proposedCount > 0 ? <p className="mt-0.5 text-[13px] font-semibold text-brand">{row.allProposed ? "Proposition envoyée" : `${row.proposedCount} proposition(s) envoyée(s)`}</p> : null}
                  {href ? (
                    <Link href={href} data-testid="vendor-request-open" className="mt-2 flex w-full items-center justify-center rounded-xl border border-brand/30 bg-white py-2.5 text-[15px] font-bold text-brand">
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
        <p role="status" className="mt-3 text-[13px] font-semibold text-ink-soft">
          {REQUESTS_TRUNCATED_NOTE}
        </p>
      ) : null}

      <h2 className="mt-6 text-[18px] font-extrabold text-ink">{SENT_TITLE}</h2>
      {sent.length === 0 ? (
        <p className="mt-2 text-[14px] text-ink-soft">{SENT_EMPTY}</p>
      ) : (
        <ul className="mt-2 space-y-2.5" aria-label={SENT_TITLE}>
          {sent.map((proposal) => {
            const row = proposalRow(proposal, "seller");
            return (
              <li key={row.id} data-testid="sent-proposal" data-status={row.status} className="rounded-2xl border border-line bg-white p-3.5">
                <div className="flex items-start justify-between gap-2">
                  <span className="text-[15px] font-bold text-ink">{row.title}</span>
                  <Badge tone={row.status === "sent" ? "carrot" : row.status === "accepted" ? "sage" : "wash"}>{row.statusText}</Badge>
                </div>
                <div className="mt-0.5 text-[15px] font-extrabold text-ink">{row.priceText}</div>
                <div className="text-[13px] text-ink-soft">{row.validText}</div>
                {canAnswer(proposal) ? (
                  <button
                    onClick={() => void withdraw(proposal.id)}
                    disabled={pendingId === proposal.id}
                    data-testid="proposal-withdraw"
                    className="mt-2 rounded-xl border border-line bg-white px-3.5 py-2 text-[14px] font-bold text-ink disabled:opacity-50"
                  >
                    Retirer
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
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
