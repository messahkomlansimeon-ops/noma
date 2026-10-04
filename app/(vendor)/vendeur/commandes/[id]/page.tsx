"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import {
  Calendar,
  ChevronRight,
  CircleCheck,
  Ellipsis,
  MapPin,
  MessageCircle,
  Pencil,
  Truck,
  Wallet,
} from "lucide-react";
import { TopBar } from "@/components/top-bar";
import { Thumb } from "@/components/thumb";
import { StepBar } from "@/components/timeline";
import { Avatar, Badge, KvRow, Switch } from "@/components/ui";
import { formatShort } from "@/lib/data";
import { useNoma } from "@/lib/store";

const vendorSteps = ["À préparer", "En préparation", "Remis"];

export default function GererCommande() {
  const { id } = useParams<{ id: string }>();
  const order = useNoma((s) => s.vendorOrders.find((o) => o.id === id));
  const advance = useNoma((s) => s.advanceVendorOrder);
  const declarePayment = useNoma((s) => s.declarePayment);
  const showToast = useNoma((s) => s.showToast);
  const [, force] = useState(0);

  if (!order) {
    return <main className="p-6 text-center text-ink-soft">Commande introuvable.</main>;
  }

  const step = order.step ?? 0;

  return (
    <main>
      <TopBar
        back="/vendeur/commandes"
        title={`Commande ${order.id}`}
        right={
          <button className="flex size-9 items-center justify-center rounded-full text-ink transition hover:bg-wash">
            <Ellipsis className="size-5" />
          </button>
        }
      />

      <div className="px-4">
        <div className="rounded-2xl border border-line bg-white p-3.5">
          <div className="flex items-center gap-3">
            <Thumb art={order.art} className="size-14" iconClassName="size-7" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[15px] font-bold text-ink">
                {order.title}
              </div>
              <div className="font-display text-[18px] font-extrabold text-ink">
                {formatShort(order.price)} FCFA
              </div>
            </div>
          </div>
          {order.accepted && (
            <div className="mt-2.5">
              <Badge tone="sage">
                <CircleCheck className="size-3" />
                Accord client reçu
              </Badge>
            </div>
          )}
        </div>

        {order.status === "preparing" ? (
          <>
            <div className="mt-5 text-[16px] font-extrabold text-ink">
              Avancement
            </div>
            <div className="mt-3">
              <StepBar steps={vendorSteps} step={step} />
            </div>

            <div className="mt-4 flex items-center gap-3 rounded-2xl border border-line bg-white p-4">
              <span className="flex size-10 items-center justify-center rounded-full bg-sage text-forest">
                <Truck className="size-5" strokeWidth={1.9} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-[12px] text-ink-soft">Livraison prévue</div>
                <div className="text-[15px] font-extrabold text-ink">
                  {order.delivery}
                </div>
                <div className="mt-0.5 flex items-center gap-1 text-[12px] text-ink-soft">
                  <MapPin className="size-3.5" />
                  {order.place}
                </div>
              </div>
              <button
                onClick={() => showToast("Prototype : créneau modifiable")}
                className="flex size-8 items-center justify-center rounded-full text-ink-soft transition hover:bg-wash"
                aria-label="Modifier"
              >
                <Pencil className="size-4" />
              </button>
            </div>

            <div className="mt-3 flex items-center gap-3 rounded-2xl border border-line bg-white p-3.5">
              <Avatar initials="AO" className="size-10 text-[13px]" />
              <div className="flex-1">
                <div className="text-[12px] text-ink-soft">Client</div>
                <div className="text-[15px] font-bold text-ink">
                  {order.client}
                </div>
              </div>
              <button
                onClick={() =>
                  showToast("Prototype : message au client simulé")
                }
                className="flex items-center gap-1.5 rounded-full border border-forest/30 bg-white px-3.5 py-2 text-[13px] font-bold text-forest"
              >
                <MessageCircle className="size-4" />
                Écrire
              </button>
            </div>

            <div className="mt-3 divide-y divide-line rounded-2xl border border-line bg-white px-4 py-1">
              <KvRow label="Produit" value={`${formatShort(order.price)} F`} />
              <KvRow label="Livraison" value={order.deliveryIncluded} />
              <div className="flex items-center justify-between py-2.5">
                <span className="text-[14px] font-bold text-ink">
                  Total convenu
                </span>
                <span className="font-display text-[18px] font-extrabold text-ink">
                  {formatShort(order.total ?? 0)} FCFA
                </span>
              </div>
            </div>

            <div className="mt-3 flex items-center gap-3 rounded-2xl border border-line bg-white px-4 py-3.5">
              <Wallet className="size-5 text-ink-soft" strokeWidth={1.8} />
              <div className="flex-1">
                <div className="text-[14px] font-bold text-ink">
                  Paiement reçu
                </div>
                <div className="text-[12px] text-ink-soft">
                  {order.payment ? "Déclaré" : "À déclarer"}
                </div>
              </div>
              <Switch
                checked={!!order.payment}
                onChange={(v) => {
                  declarePayment(order.id, v);
                  showToast(v ? "Paiement déclaré" : "Déclaration retirée");
                  force((x) => x + 1);
                }}
              />
            </div>

            <button
              onClick={() => {
                advance(order.id);
                showToast(
                  step === 0
                    ? "Commande en préparation"
                    : "Commande remise · Terminée",
                );
              }}
              className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-forest py-3.5 text-[15px] font-bold text-white transition active:scale-[0.99]"
            >
              Mettre à jour le statut
              <ChevronRight className="size-4" />
            </button>
            <div className="mt-3 text-center">
              <Link
                href="/signaler?commande=NM-024"
                className="text-[13px] font-bold text-forest hover:underline"
              >
                Signaler un problème
              </Link>
            </div>
          </>
        ) : (
          <div className="mt-5 rounded-2xl border border-line bg-white p-4">
            <div className="text-[15px] font-extrabold text-ink">
              À confirmer
            </div>
            <p className="mt-1 text-[13px] leading-relaxed text-ink-soft">
              Confirmez le prix et le délai pour que le client puisse accepter
              la commande.
            </p>
            <div className="mt-3 divide-y divide-line rounded-xl border border-line">
              <KvRow
                label="Zone"
                value={
                  <span className="flex items-center gap-1.5">
                    <MapPin className="size-3.5 text-ink-soft" />
                    {order.zone}
                  </span>
                }
              />
              <KvRow
                label="Délai"
                value={
                  <span className="flex items-center gap-1.5">
                    <Calendar className="size-3.5 text-ink-soft" />
                    {order.slot}
                  </span>
                }
              />
            </div>
            <button
              onClick={() => showToast("Prototype : confirmation simulée")}
              className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-forest py-3.5 text-[15px] font-bold text-white transition active:scale-[0.99]"
            >
              Confirmer prix et délai
              <ChevronRight className="size-4" />
            </button>
          </div>
        )}
      </div>
    </main>
  );
}
