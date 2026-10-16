"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { CircleAlert, ShieldCheck, ShoppingBag } from "lucide-react";
import { useUnauthorizedRedirect } from "@/components/session-gate";
import { Input } from "@/components/ui";
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
        className="press mt-2 flex min-h-12 w-full items-center justify-center gap-2 rounded-2xl border-2 border-brand bg-white px-5 py-3 text-[16px] font-bold text-brand hover:bg-brand-soft"
      >
        <ShoppingBag className="size-5" aria-hidden />
        {DECLARE_ORDER_LABEL}
      </button>
    );
  }
  return (
    <div className="animate-rise mt-2 rounded-3xl border border-line bg-white p-4" data-testid="declare-order-form">
      {withQuantity ? (
        <div className="mb-3">
          <label htmlFor="order-quantity" className="mb-1.5 block text-[14px] font-bold text-ink">
            Quantité achetée
          </label>
          <Input id="order-quantity" inputMode="numeric" autoComplete="off" value={quantity} onChange={(event) => setQuantity(event.target.value)} data-testid="order-quantity" />
        </div>
      ) : null}
      <label htmlFor="order-price" className="mb-1.5 block text-[14px] font-bold text-ink">
        {withQuantity ? "Prix convenu par unité (FCFA)" : PRICE_LABEL}
      </label>
      <Input
        id="order-price"
        inputMode="numeric"
        autoComplete="off"
        value={price}
        onChange={(event) => setPrice(event.target.value)}
        placeholder={PRICE_PLACEHOLDER}
        data-testid="order-price"
      />
      {problem ? (
        <p role="alert" className="mt-2 flex items-center gap-2 text-[14px] font-semibold text-danger-ink">
          <CircleAlert className="size-4 shrink-0" aria-hidden />
          {problem}
        </p>
      ) : null}
      <p data-testid="no-payment-notice" className="mt-3 flex items-start gap-2.5 rounded-2xl bg-mist p-3 text-[13px] leading-relaxed text-ink-soft">
        <ShieldCheck className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />
        {NO_PAYMENT_NOTICE}
      </p>
      {error ? (
        <p role="alert" data-testid="declare-order-error" className="mt-3 flex items-center gap-2 rounded-2xl bg-danger-soft px-4 py-3 text-[14px] font-semibold text-danger-ink">
          <CircleAlert className="size-5 shrink-0" aria-hidden />
          {error}
        </p>
      ) : null}
      <div className="mt-4 grid grid-cols-2 gap-3">
        <button
          onClick={() => setOpen(false)}
          disabled={pending}
          className="press flex min-h-12 items-center justify-center rounded-2xl border-2 border-line-strong bg-white px-3 py-3 text-[16px] font-bold text-ink hover:border-brand hover:text-brand disabled:cursor-not-allowed disabled:opacity-40"
        >
          Annuler
        </button>
        <button
          onClick={() => void submit()}
          disabled={pending || parsed === null || !quantityOk}
          data-testid="declare-order-submit"
          className="press flex min-h-12 items-center justify-center rounded-2xl bg-brand px-3 py-3 text-[16px] font-bold text-white hover:bg-brand-deep disabled:cursor-not-allowed disabled:opacity-40"
        >
          {pending ? DECLARE_ORDER_ONGOING : DECLARE_ORDER_CONFIRM_LABEL}
        </button>
      </div>
    </div>
  );
}
