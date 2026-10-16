"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { InterestedBuyerCard } from "@/components/matches/match-parts";
import { ProposalForm } from "@/components/proposals/proposal-form";
import { SessionGate, useUnauthorizedRedirect } from "@/components/session-gate";
import { TopBar } from "@/components/top-bar";
import { Badge } from "@/components/ui";
import { isUuid } from "@/lib/client/api";
import { describeProposalError, proposals, type SellerRequest } from "@/lib/client/proposals-api";
import { SENT_MESSAGE, canPropose, offerStateText, quotePath } from "@/lib/client/proposals-view";

function Detail({ demandId }: { demandId: string }) {
  const redirectIfUnauthorized = useUnauthorizedRedirect();
  const [request, setRequest] = useState<SellerRequest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    proposals.request(demandId, { signal: controller.signal }).then(
      (found) => {
        setRequest(found);
        setError(null);
      },
      (failure) => {
        if (controller.signal.aborted || redirectIfUnauthorized(failure)) return;
        setError(describeProposalError(failure, "list"));
      },
    );
    return () => controller.abort();
  }, [demandId, reloadKey, redirectIfUnauthorized]);

  if (error) {
    return (
      <p role="alert" className="mt-6 text-center text-[14px] font-semibold text-ink">
        {error}
      </p>
    );
  }
  if (request === null) {
    return (
      <p aria-busy="true" className="mt-6 text-center text-[14px] text-ink-soft">
        Chargement…
      </p>
    );
  }
  return (
    <div data-testid="vendor-request-detail">
      <ul className="mt-3">
        <InterestedBuyerCard item={request.need} />
      </ul>
      {sent ? (
        <p role="status" data-testid="proposal-sent" className="mt-3 rounded-xl bg-sage px-3 py-2 text-[13px] font-semibold text-forest">
          {SENT_MESSAGE}
        </p>
      ) : null}
      <h2 className="mt-5 text-[16px] font-extrabold text-ink">Vos annonces qui correspondent</h2>
      <ul className="mt-2 space-y-3">
        {request.offers.map((offer) => {
          const state = offerStateText(offer);
          const quote = quotePath(demandId, offer.offerId);
          return (
            <li key={offer.offerId} data-testid="request-offer" className="rounded-2xl border border-line bg-white p-3.5">
              <div className="flex items-start justify-between gap-2">
                <span className="text-[14px] font-bold text-ink">{offer.title}</span>
                {state ? <Badge tone={offer.proposal?.status === "sent" || offer.proposal?.status === "accepted" ? "sage" : "wash"}>{state}</Badge> : null}
              </div>
              {canPropose(offer) ? (
                open === offer.offerId ? (
                  <ProposalForm
                    demandId={demandId}
                    offerId={offer.offerId}
                    withLines={false}
                    onSent={() => {
                      setOpen(null);
                      setSent(true);
                      setReloadKey((key) => key + 1);
                    }}
                  />
                ) : (
                  <div className="mt-2 grid grid-cols-2 gap-2">
                    <button onClick={() => { setSent(false); setOpen(offer.offerId); }} data-testid="proposal-open" className="rounded-xl bg-forest px-3 py-2.5 text-[14px] font-bold text-white">
                      Faire une proposition
                    </button>
                    {quote ? (
                      <Link href={quote} data-testid="quote-open" className="flex items-center justify-center rounded-xl border border-forest/30 bg-white px-3 py-2.5 text-[14px] font-bold text-forest">
                        Faire un devis
                      </Link>
                    ) : null}
                  </div>
                )
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export default function DemandeDetail() {
  const params = useParams<{ id: string }>();
  const id = typeof params.id === "string" ? params.id : "";
  return (
    <SessionGate>
      <main>
        <TopBar back="/vendeur/demandes" title="Demande" />
        <div className="px-4 pb-8">
          {isUuid(id) ? (
            <Detail demandId={id} />
          ) : (
            <p role="alert" className="mt-6 text-center text-[14px] font-semibold text-ink">
              Demande introuvable.
            </p>
          )}
        </div>
      </main>
    </SessionGate>
  );
}
