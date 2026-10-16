"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { Calculator, CircleCheck, HandCoins, Tag } from "lucide-react";
import { InterestedBuyerCard } from "@/components/matches/match-parts";
import { ProposalForm } from "@/components/proposals/proposal-form";
import { SessionGate, useUnauthorizedRedirect } from "@/components/session-gate";
import { TopBar } from "@/components/top-bar";
import { Badge, IconTile } from "@/components/ui";
import { BTN_OUTLINE, BTN_PRIMARY, ErrorState, LoadingBlock, Notice, SectionHeading } from "@/components/vendor/vendor-parts";
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
    return <ErrorState message={error} />;
  }
  if (request === null) {
    return <LoadingBlock label="Chargement…" className="pt-3" />;
  }
  return (
    <div data-testid="vendor-request-detail" className="flex flex-col gap-4 pt-3">
      <ul>
        <InterestedBuyerCard item={request.need} />
      </ul>
      {sent ? (
        <Notice tone="brand" icon={CircleCheck} role="status" data-testid="proposal-sent" className="animate-pop">
          {SENT_MESSAGE}
        </Notice>
      ) : null}
      <SectionHeading icon={Tag}>Vos annonces qui correspondent</SectionHeading>
      <ul className="stagger flex flex-col gap-3 md:grid md:grid-cols-2 md:items-start">
        {request.offers.map((offer) => {
          const state = offerStateText(offer);
          const quote = quotePath(demandId, offer.offerId);
          return (
            <li key={offer.offerId} data-testid="request-offer" className="rounded-3xl border border-line bg-white p-4">
              <div className="flex items-start gap-3">
                <IconTile icon={Tag} tone="brand" />
                <span className="min-w-0 flex-1 pt-0.5 text-[16px] font-bold leading-snug text-ink">{offer.title}</span>
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
                  <div className="mt-3 flex flex-col gap-2">
                    <button onClick={() => { setSent(false); setOpen(offer.offerId); }} data-testid="proposal-open" className={BTN_PRIMARY}>
                      <HandCoins className="size-5" aria-hidden />
                      Faire une proposition
                    </button>
                    {quote ? (
                      <Link href={quote} data-testid="quote-open" className={BTN_OUTLINE}>
                        <Calculator className="size-5" aria-hidden />
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
            <ErrorState message="Demande introuvable." />
          )}
        </div>
      </main>
    </SessionGate>
  );
}
