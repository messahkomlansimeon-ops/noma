"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { InterestedBuyerCard } from "@/components/matches/match-parts";
import { ProposalForm } from "@/components/proposals/proposal-form";
import { SessionGate, useUnauthorizedRedirect } from "@/components/session-gate";
import { TopBar } from "@/components/top-bar";
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
    return (
      <p role="alert" className="mt-6 text-center text-[15px] font-semibold text-ink">
        {error}
      </p>
    );
  }
  if (request === null) {
    return (
      <p aria-busy="true" className="mt-6 text-center text-[15px] text-ink-soft">
        Chargement…
      </p>
    );
  }
  const offer = request.offers.find((entry) => entry.offerId === offerId);
  if (!offer) {
    return (
      <p role="alert" className="mt-6 text-center text-[15px] font-semibold text-ink">
        Cette annonce ne correspond plus à ce besoin.
      </p>
    );
  }
  if (sent) {
    return (
      <div role="status" data-testid="proposal-sent" className="mt-4 rounded-2xl bg-brand-soft p-4 text-center">
        <p className="text-[15px] font-bold text-brand">{SENT_MESSAGE}</p>
        <Link href="/vendeur/demandes" className="mt-3 inline-flex rounded-xl bg-brand px-5 py-2.5 text-[15px] font-bold text-white">
          Retour aux demandes
        </Link>
      </div>
    );
  }
  return (
    <div data-testid="quote-screen">
      <ul className="mt-3">
        <InterestedBuyerCard item={request.need} />
      </ul>
      <p className="mt-3 text-[14px] font-semibold text-ink">Annonce : {offer.title}</p>
      {canPropose(offer) ? (
        <ProposalForm demandId={demandId} offerId={offerId} withLines onSent={() => setSent(true)} />
      ) : (
        <p role="status" className="mt-3 rounded-xl bg-mist px-3 py-2 text-[14px] text-ink-soft">
          Un devis ne peut pas être envoyé pour cette annonce : une proposition est déjà en attente, ou l'acheteur en a refusé une.
        </p>
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
          <p role="alert" className="mt-6 text-center text-[15px] font-semibold text-ink">
            Choisissez une demande, puis « Faire un devis ».
          </p>
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
