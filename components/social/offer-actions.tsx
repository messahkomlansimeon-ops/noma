"use client";

import { useRouter } from "next/navigation";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { ChevronRight, MessageCircle, PackageCheck, ShieldCheck, TriangleAlert } from "lucide-react";
import { DeclareOrder } from "@/components/orders/declare-order";
import { useUnauthorizedRedirect } from "@/components/session-gate";
import { IconTile } from "@/components/ui";
import { WRITE_TO_SELLER_LABEL, WRITE_TO_SELLER_ONGOING, conversationPath } from "@/lib/client/messages-view";
import { NO_PAYMENT_NOTICE, offerOrderBanner, type OfferOrderBanner } from "@/lib/client/orders-view";
import { describeSocialError, social } from "@/lib/client/social-api";

/**
 * Messagerie et commande depuis la fiche d'une annonce (lot D2) : « Écrire au vendeur » ouvre (ou retrouve) la conversation, aux mêmes conditions que le contact (correspondance
 * confirmée, annonce en ligne) ; « Je l'ai acheté » déclare une vente avec un prix convenu. Aucun paiement de l'objet ne passe par noma.
 */
export function OfferActions({ demandId, offerId }: { demandId: string; offerId: string }) {
  const router = useRouter();
  const redirectIfUnauthorized = useUnauthorizedRedirect();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  // Lot FIN1 : une commande déjà confirmée (ou déclarée) pour cette annonce dans ce besoin remplace « Je l'ai acheté » (une deuxième déclaration serait refusée).
  const [banner, setBanner] = useState<OfferOrderBanner | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    social.orders.list("buyer", { signal: controller.signal }).then(
      (orders) => setBanner(offerOrderBanner(orders, demandId, offerId)),
      () => {
        // Sans la liste, le bouton reste : le serveur refuse de toute façon une deuxième déclaration, avec un message exact.
      },
    );
    return () => controller.abort();
  }, [demandId, offerId]);

  const write = async () => {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setError(null);
    try {
      const opened = await social.conversations.open(demandId, offerId);
      router.push(conversationPath("buyer", opened.conversationId));
    } catch (failure) {
      if (redirectIfUnauthorized(failure)) return;
      setError(describeSocialError(failure, "conversation"));
      setPending(false);
    } finally {
      busy.current = false;
    }
  };

  return (
    <section aria-labelledby="actions-title" className="mt-4 flex flex-col gap-3 rounded-3xl border border-line bg-white p-4" data-testid="offer-actions">
      <h2 id="actions-title" className="sr-only">
        Discuter ou conclure
      </h2>
      <button
        onClick={() => void write()}
        disabled={pending}
        data-testid="write-to-seller"
        className="press flex min-h-12 w-full items-center justify-center gap-2 rounded-2xl bg-brand px-5 py-3 text-[16px] font-bold text-white shadow-md shadow-brand/30 hover:bg-brand-deep disabled:cursor-not-allowed disabled:opacity-50"
      >
        <MessageCircle className="size-5" aria-hidden />
        {pending ? WRITE_TO_SELLER_ONGOING : WRITE_TO_SELLER_LABEL}
      </button>
      {error ? (
        <p role="alert" data-testid="write-error" className="flex items-start gap-2 rounded-2xl bg-accent-soft px-3.5 py-3 text-[14px] font-semibold text-accent-ink">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          {error}
        </p>
      ) : null}
      {banner ? (
        <div data-testid="offer-order-banner" data-kind={banner.kind} className="flex items-center gap-3 rounded-2xl bg-success-soft px-3.5 py-3">
          <IconTile icon={PackageCheck} tone="success" className="size-10" />
          <div className="min-w-0 flex-1">
            <div data-testid="offer-order-label" className="text-[15px] font-bold text-success-ink">
              {banner.label}
            </div>
            <div className="text-[13px] text-success-ink">{banner.hint}</div>
          </div>
          <Link href={banner.href} className="press flex min-h-11 shrink-0 items-center gap-1 text-[14px] font-bold text-success-ink underline">
            Voir la commande
            <ChevronRight className="size-4" aria-hidden />
          </Link>
        </div>
      ) : (
        <DeclareOrder demandId={demandId} offerId={offerId} />
      )}
      <p className="flex items-start gap-2 text-[13px] leading-relaxed text-ink-soft">
        <ShieldCheck className="mt-0.5 size-4 shrink-0 text-ink-soft" aria-hidden />
        {NO_PAYMENT_NOTICE}
      </p>
    </section>
  );
}
