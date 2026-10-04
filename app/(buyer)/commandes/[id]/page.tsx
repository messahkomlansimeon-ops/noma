"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import {
  CreditCard,
  Ellipsis,
  MapPin,
  MessageCircle,
  Truck,
} from "lucide-react";
import { TopBar } from "@/components/top-bar";
import { Thumb } from "@/components/thumb";
import { Timeline } from "@/components/timeline";
import { Badge } from "@/components/ui";
import { formatShort } from "@/lib/data";
import { useNoma } from "@/lib/store";

export default function SuiviCommande() {
  const { id } = useParams<{ id: string }>();
  const order = useNoma((s) => s.orders.find((o) => o.id === id));

  if (!order) {
    return <main className="p-6 text-center text-ink-soft">Commande introuvable.</main>;
  }

  const statusTone =
    order.status === "preparing"
      ? "sage"
      : order.status === "done"
        ? "sage"
        : "carrot";
  const statusLabel =
    order.status === "preparing"
      ? "En préparation"
      : order.status === "done"
        ? "Terminée"
        : order.status === "quote"
          ? "Devis à valider"
          : "Demande envoyée";

  return (
    <main>
      <TopBar
        back="/commandes"
        title="Commande"
        right={
          <button className="flex size-9 items-center justify-center rounded-full text-ink transition hover:bg-wash">
            <Ellipsis className="size-5" />
          </button>
        }
      />

      <div className="px-4">
        <div className="flex items-center justify-between">
          <span className="text-[13px] font-extrabold text-ink">{order.id}</span>
          <Badge tone={statusTone}>{statusLabel}</Badge>
        </div>

        <div className="mt-3 rounded-2xl border border-line bg-white p-3.5">
          <div className="flex items-center gap-3">
            <Thumb art={order.art} className="size-14" iconClassName="size-7" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[15px] font-bold text-ink">
                {order.title}
              </div>
              <div className="text-[13px] text-ink-soft">{order.vendor}</div>
              <div className="font-display text-[18px] font-extrabold text-ink">
                {formatShort(order.price)} FCFA
              </div>
            </div>
          </div>
        </div>

        {order.status === "preparing" && (
          <>
            <div className="mt-5">
              <Timeline
                steps={order.steps}
                stepTimes={order.stepTimes}
                step={order.step}
              />
            </div>

            <div className="rounded-2xl bg-sage p-4">
              <div className="flex items-center gap-2 text-[12px] font-semibold text-sage-ink">
                <Truck className="size-4" />
                Livraison prévue
              </div>
              <div className="mt-1 font-display text-[18px] font-extrabold text-forest">
                {order.delivery}
              </div>
              <div className="mt-0.5 flex items-center gap-1.5 text-[13px] text-sage-ink">
                <MapPin className="size-4" />
                {order.zone}
              </div>
            </div>

            <div className="mt-3 flex items-center gap-3 rounded-2xl border border-line bg-white px-4 py-3.5">
              <CreditCard className="size-5 text-ink-soft" strokeWidth={1.8} />
              <span className="text-[14px] font-semibold text-ink">Paiement</span>
              <span className="ml-auto text-[13px] font-semibold text-ink-soft">
                {order.payment}
              </span>
            </div>

            <Link
              href="/messages/t-marcory"
              className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-forest py-3.5 text-[15px] font-bold text-white transition active:scale-[0.99]"
            >
              <MessageCircle className="size-4" />
              Contacter le vendeur
            </Link>
            <div className="mt-3 text-center">
              <Link
                href={`/signaler?commande=${order.id}`}
                className="text-[13px] font-bold text-forest hover:underline"
              >
                Signaler un problème
              </Link>
            </div>
          </>
        )}

        {order.status !== "preparing" && (
          <div className="mt-5 rounded-2xl border border-line bg-white p-4">
            <div className="text-[14px] font-bold text-ink">{order.note}</div>
            <p className="mt-1 text-[13px] leading-relaxed text-ink-soft">
              {order.status === "quote"
                ? "Le vendeur a envoyé un devis. Consultez-le et validez pour lancer l'intervention."
                : "Votre demande a été transmise au vendeur. Il vous répondra sous peu."}
            </p>
            <div className="mt-3 flex items-center gap-2 rounded-xl bg-sage px-3.5 py-2.5 text-[13px] font-bold text-sage-ink">
              <MessageCircle className="size-4" />
              Échange en cours avec {order.vendor}
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
