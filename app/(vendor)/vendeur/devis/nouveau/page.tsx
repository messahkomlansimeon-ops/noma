"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { Tag } from "lucide-react";
import { ArtCheck } from "@/components/illustrations";
import { InterestedBuyerCard } from "@/components/matches/match-parts";
import { ProposalForm } from "@/components/proposals/proposal-form";
import { SessionGate, useUnauthorizedRedirect } from "@/components/session-gate";
import { TopBar } from "@/components/top-bar";
import { IconTile } from "@/components/ui";
import { BTN_PRIMARY, ErrorState, LoadingBlock, Notice } from "@/components/vendor/vendor-parts";
import { describeProposalError, proposals, type SellerRequest } from "@/lib/client/proposals-api";
import { SENT_MESSAGE, canPropose, parseQuoteTarget } from "@/lib/client/proposals-view";

function QuoteScreen({ demandId, offerId }: { demandId: string; offerId: string }) {
  const redirectIfUnauthorized = useUnauthorizedRedirect();
  const [request, setRequest] = useState<SellerRequest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    proposals.request(demandId, { signal: controller.signal }).then(setRequest, (failure) => {
      if (controller.signal.aborted || redirectIfUnauthorized(failure)) return;
      setError(describeProposalError(failure, "list"));
    });
    return () => controller.abort();
  }, [demandId, redirectIfUnauthorized]);

  if (error) {
    return <ErrorState message={error} />;
  }
  if (request === null) {
    return <LoadingBlock label="Chargement…" className="pt-3" />;
  }
  const offer = request.offers.find((entry) => entry.offerId === offerId);
  if (!offer) {
    return <ErrorState message="Cette annonce ne correspond plus à ce besoin." />;
  }
  if (sent) {
    return (
      <div role="status" data-testid="proposal-sent" className="animate-rise mt-4 flex flex-col items-center gap-4 rounded-3xl bg-brand-soft p-6 text-center">
        <ArtCheck className="size-28" />
        <p className="text-[17px] font-bold text-brand-ink">{SENT_MESSAGE}</p>
        <div className="w-full max-w-xs">
          <Link href="/vendeur/demandes" className={BTN_PRIMARY}>
            Retour aux demandes
          </Link>
        </div>
      </div>
    );
  }
  return (
    <div data-testid="quote-screen" className="flex flex-col gap-4 pt-3">
      <ul>
        <InterestedBuyerCard item={request.need} />
      </ul>
      <div className="flex items-center gap-3 rounded-3xl border border-line bg-white p-3.5">
        <IconTile icon={Tag} tone="brand" />
        <p className="min-w-0 flex-1 text-[16px] font-bold leading-snug text-ink">{offer.title}</p>
      </div>
      {canPropose(offer) ? (
        <ProposalForm demandId={demandId} offerId={offerId} withLines onSent={() => setSent(true)} />
      ) : (
        <Notice tone="mist" role="status">
          Un devis ne peut pas être envoyé pour cette annonce : une proposition est déjà en attente, ou l'acheteur en a refusé une.
        </Notice>
      )}
    </div>
  );
}

function PageContent() {
  const search = useSearchParams();
  const target = parseQuoteTarget(search);
  return (
    <main>
      <TopBar back="/vendeur/demandes" title="Devis" />
      <div className="px-4 pb-8">
        {target ? (
          <QuoteScreen demandId={target.demandId} offerId={target.offerId} />
        ) : (
          <ErrorState message="Choisissez une demande, puis « Faire un devis »." />
        )}
      </div>
    </main>
  );
}

export default function DevisNouveau() {
  return (
    <SessionGate>
      <Suspense fallback={null}>
        <PageContent />
      </Suspense>
    </SessionGate>
  );
}
