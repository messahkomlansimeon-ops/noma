"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { useUnauthorizedRedirect } from "@/components/session-gate";
import {
  DECLARE_ORDER_CONFIRM_LABEL,
  DECLARE_ORDER_LABEL,
  DECLARE_ORDER_ONGOING,
  NO_PAYMENT_NOTICE,
  PRICE_LABEL,
  PRICE_PLACEHOLDER,
  orderPath,
  parsePriceInput,
  priceProblem,
} from "@/lib/client/orders-view";
import { parseWholeNumber } from "@/lib/client/missions-view";
import { describeSocialError, social } from "@/lib/client/social-api";

/**
 * « Je l'ai acheté » (lot D2) : l'acheteur déclare une vente avec un prix convenu (FCFA entier, 1 à 100 000 000). La commande passe à « proposée » : le vendeur la confirme
 * ou la refuse. Aucun paiement ne passe par noma : c'est écrit à l'écran, avant le bouton.
 * Lot MV1 : depuis une ligne de mission, le prix (par unité) et la quantité visés sont proposés d'avance ; le champ « quantité » n'apparaît que dans ce cas.
 */
export function DeclareOrder({ demandId, offerId, initialPrice, initialQuantity }: { demandId: string; offerId: string; initialPrice?: number; initialQuantity?: number }) {
  const router = useRouter();
  const redirectIfUnauthorized = useUnauthorizedRedirect();
  const [open, setOpen] = useState(false);
  const [price, setPrice] = useState(initialPrice === undefined ? "" : String(initialPrice));
  const [quantity, setQuantity] = useState(initialQuantity === undefined ? "" : String(initialQuantity));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  const parsed = parsePriceInput(price);
  const problem = priceProblem(price);
  const withQuantity = initialQuantity !== undefined;
  const parsedQuantity = withQuantity ? parseWholeNumber(quantity) : 1;
  const quantityOk = parsedQuantity !== null && parsedQuantity >= 1 && parsedQuantity <= 10_000;

  const submit = async () => {
    if (busy.current || parsed === null || !quantityOk) return;
    busy.current = true;
    setPending(true);
    setError(null);
    try {
      const order = await social.orders.declare(demandId, offerId, parsed, undefined, withQuantity ? (parsedQuantity as number) : undefined);
      router.push(orderPath("buyer", order.id));
    } catch (failure) {
      if (redirectIfUnauthorized(failure)) return;
      setError(describeSocialError(failure, "order"));
      setPending(false);
    } finally {
      busy.current = false;
    }
  };

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        data-testid="declare-order-open"
        className="mt-2 flex w-full items-center justify-center rounded-xl border border-forest/30 bg-white px-4 py-3 text-[14px] font-bold text-forest transition active:scale-[0.99]"
      >
        {DECLARE_ORDER_LABEL}
      </button>
    );
  }
  return (
    <div className="mt-2 rounded-xl border border-line bg-white p-3.5" data-testid="declare-order-form">
      {withQuantity ? (
        <>
          <label htmlFor="order-quantity" className="text-[13px] font-bold text-ink">
            Quantité achetée
          </label>
          <input
            id="order-quantity"
            inputMode="numeric"
            autoComplete="off"
            value={quantity}
            onChange={(event) => setQuantity(event.target.value)}
            data-testid="order-quantity"
            className="mb-2.5 mt-1.5 w-full rounded-xl border border-line bg-white px-3.5 py-3 text-[15px] text-ink placeholder:text-ink-soft/50"
          />
        </>
      ) : null}
      <label htmlFor="order-price" className="text-[13px] font-bold text-ink">
        {withQuantity ? "Prix convenu par unité (FCFA)" : PRICE_LABEL}
      </label>
      <input
        id="order-price"
        inputMode="numeric"
        autoComplete="off"
        value={price}
        onChange={(event) => setPrice(event.target.value)}
        placeholder={PRICE_PLACEHOLDER}
        data-testid="order-price"
        className="mt-1.5 w-full rounded-xl border border-line bg-white px-3.5 py-3 text-[15px] text-ink placeholder:text-ink-soft/50"
      />
      {problem ? (
        <p role="alert" className="mt-1.5 text-[12px] font-semibold text-carrot-ink">
          {problem}
        </p>
      ) : null}
      <p data-testid="no-payment-notice" className="mt-2 text-[12px] leading-relaxed text-ink-soft">
        {NO_PAYMENT_NOTICE}
      </p>
      {error ? (
        <p role="alert" data-testid="declare-order-error" className="mt-2 text-[13px] font-semibold text-carrot-ink">
          {error}
        </p>
      ) : null}
      <div className="mt-3 grid grid-cols-2 gap-2.5">
        <button onClick={() => setOpen(false)} disabled={pending} className="rounded-xl border border-line bg-white px-3 py-2.5 text-[14px] font-bold text-ink disabled:opacity-50">
          Annuler
        </button>
        <button
          onClick={() => void submit()}
          disabled={pending || parsed === null || !quantityOk}
          data-testid="declare-order-submit"
          className="rounded-xl bg-forest px-3 py-2.5 text-[14px] font-bold text-white transition active:scale-[0.99] disabled:opacity-50"
        >
          {pending ? DECLARE_ORDER_ONGOING : DECLARE_ORDER_CONFIRM_LABEL}
        </button>
      </div>
    </div>
  );
}
