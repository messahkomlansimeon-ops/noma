"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { SessionGate, useUnauthorizedRedirect } from "@/components/session-gate";
import { TopBar } from "@/components/top-bar";
import { Badge } from "@/components/ui";
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
      <p role="alert" className="mt-6 text-center text-[14px] font-semibold text-ink">
        {error}
      </p>
    );
  }
  if (items === null) {
    return (
      <p aria-busy="true" className="mt-6 text-center text-[14px] text-ink-soft">
        Chargement…
      </p>
    );
  }
  const pendingLine = pendingText(pending);
  return (
    <div data-testid="buyer-proposals">
      <p className="mt-3 text-[13px] text-ink-soft">{BUYER_HINT}</p>
      {pendingLine ? (
        <p data-testid="proposals-pending" className="mt-2 text-[13px] font-bold text-forest">
          {pendingLine}
        </p>
      ) : null}
      {notice ? (
        <p role="status" data-testid="proposal-notice" className="mt-2 rounded-xl bg-sage px-3 py-2 text-[13px] font-semibold text-forest">
          {notice.text}{" "}
          {notice.orderId ? (
            <Link href={`/commandes/${notice.orderId}`} className="underline">
              Voir la commande
            </Link>
          ) : null}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="mt-2 text-[13px] font-semibold text-carrot-ink">
          {error}
        </p>
      ) : null}
      {items.length === 0 ? (
        <p className="mt-4 rounded-2xl bg-wash p-4 text-center text-[14px] text-ink-soft">{BUYER_EMPTY}</p>
      ) : (
        <ul className="mt-3 space-y-3" aria-label={BUYER_TITLE}>
          {items.map((proposal) => {
            const row = proposalRow(proposal, "buyer");
            return (
              <li key={row.id} data-testid="buyer-proposal" data-status={row.status} className="rounded-2xl border border-line bg-white p-3.5">
                <div className="flex items-start justify-between gap-2">
                  <span className="text-[14px] font-bold text-ink">{row.title}</span>
                  <Badge tone={row.status === "sent" ? "carrot" : row.status === "accepted" ? "sage" : "wash"}>{row.statusText}</Badge>
                </div>
                <div data-testid="proposal-price" className="mt-0.5 font-display text-[18px] font-extrabold text-ink">
                  {row.priceText}
                </div>
                {row.lines.length > 0 ? (
                  <ul className="mt-1.5 space-y-0.5 text-[13px] text-ink" aria-label="Lignes du devis">
                    {row.lines.map((line, index) => (
                      <li key={index} className="flex justify-between gap-3">
                        <span>{line.label}</span>
                        <span className="font-semibold">{line.amountText}</span>
                      </li>
                    ))}
                  </ul>
                ) : null}
                {row.details.map((detail) => (
                  <div key={detail} className="mt-0.5 text-[13px] text-ink-soft">
                    {detail}
                  </div>
                ))}
                <div className="mt-1 text-[12px] text-ink-soft">{row.validText}</div>
                {canAnswer(proposal) ? (
                  <div className="mt-3 grid grid-cols-2 gap-2.5">
                    <button onClick={() => void answer(proposal.id, "decline")} disabled={busyId === proposal.id} data-testid="proposal-decline" className="rounded-xl border border-line bg-white px-3 py-2.5 text-[14px] font-bold text-ink disabled:opacity-50">
                      Refuser
                    </button>
                    <button onClick={() => void answer(proposal.id, "accept")} disabled={busyId === proposal.id} data-testid="proposal-accept" className="rounded-xl bg-forest px-3 py-2.5 text-[14px] font-bold text-white disabled:opacity-50">
                      Accepter
                    </button>
                  </div>
                ) : proposal.orderId ? (
                  <Link href={`/commandes/${proposal.orderId}`} className="mt-2 inline-block text-[13px] font-bold text-forest">
                    Voir la commande ›
                  </Link>
                ) : null}
              </li>
            );
          })}
        </ul>
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
