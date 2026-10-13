"use client";

import { useRouter } from "next/navigation";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { MessageCircle } from "lucide-react";
import { DeclareOrder } from "@/components/orders/declare-order";
import { useUnauthorizedRedirect } from "@/components/session-gate";
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
    <section aria-labelledby="actions-title" className="mt-4 rounded-2xl border border-line bg-white p-4" data-testid="offer-actions">
      <h2 id="actions-title" className="text-[15px] font-extrabold text-ink">
        Discuter ou conclure
      </h2>
      <button
        onClick={() => void write()}
        disabled={pending}
        data-testid="write-to-seller"
        className="mt-2 flex w-full items-center justify-center gap-2 rounded-xl bg-forest px-4 py-3 text-[14px] font-bold text-white transition active:scale-[0.99] disabled:opacity-50"
      >
        <MessageCircle className="size-4" aria-hidden />
        {pending ? WRITE_TO_SELLER_ONGOING : WRITE_TO_SELLER_LABEL}
      </button>
      {error ? (
        <p role="alert" data-testid="write-error" className="mt-2 text-[13px] font-semibold text-carrot-ink">
          {error}
        </p>
      ) : null}
      {banner ? (
        <div data-testid="offer-order-banner" data-kind={banner.kind} className="mt-2 rounded-xl border border-forest/30 bg-sage px-3.5 py-3">
          <div data-testid="offer-order-label" className="text-[14px] font-bold text-forest">
            {banner.label}
          </div>
          <div className="text-[12px] text-sage-ink">{banner.hint}</div>
          <Link href={banner.href} className="mt-1 inline-block text-[12px] font-bold text-forest underline">
            Voir la commande
          </Link>
        </div>
      ) : (
        <DeclareOrder demandId={demandId} offerId={offerId} />
      )}
      <p className="mt-2 text-[11px] leading-relaxed text-ink-soft">{NO_PAYMENT_NOTICE}</p>
    </section>
  );
}
