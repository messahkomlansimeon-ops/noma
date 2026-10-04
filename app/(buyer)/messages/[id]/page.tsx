"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import {
  Calendar,
  Check,
  CheckCheck,
  ChevronRight,
  CircleCheck,
  Ellipsis,
  Plus,
  Send,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react";
import { TopBar } from "@/components/top-bar";
import { Thumb } from "@/components/thumb";
import { Badge } from "@/components/ui";
import { formatShort } from "@/lib/data";
import { useNoma } from "@/lib/store";

export default function EchangeVendeur() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const thread = useNoma((s) => s.threads.find((t) => t.id === id));
  const sendMessage = useNoma((s) => s.sendMessage);
  const acceptOffer = useNoma((s) => s.acceptOffer);
  const showToast = useNoma((s) => s.showToast);
  const [draft, setDraft] = useState("");

  useEffect(() => {
    if (!thread) router.replace("/messages");
  }, [thread, router]);

  if (!thread) return null;

  const offerMsg = thread.messages.find((m) => m.offer);

  const accept = () => {
    acceptOffer(thread.id);
    showToast("Commande NM-024 enregistrée");
    router.push("/commandes/NM-024");
  };

  return (
    <div className="flex min-h-dvh flex-col">
      <TopBar
        back="/messages"
        center={
          <span className="flex flex-col items-center leading-tight">
            <span className="text-[15px] font-bold text-ink">
              {thread.vendor}
            </span>
            {thread.verified && (
              <Badge tone="sage" className="mt-0.5">
                <ShieldCheck className="size-3" />
                Téléphone confirmé
              </Badge>
            )}
          </span>
        }
        right={
          <button className="flex size-9 items-center justify-center rounded-full text-ink transition hover:bg-wash">
            <Ellipsis className="size-5" />
          </button>
        }
      />

      <div className="flex-1 px-4 pb-40">
        <div className="sticky top-[57px] z-10 rounded-2xl border border-line bg-white p-3">
          <div className="flex items-center gap-3">
            <Thumb art={thread.art} className="size-11" iconClassName="size-5" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[14px] font-bold text-ink">
                {thread.product}
              </div>
              {offerMsg?.offer && (
                <div className="font-display text-[16px] font-extrabold text-ink">
                  {formatShort(offerMsg.offer.total)} FCFA
                </div>
              )}
            </div>
            <ChevronRight className="size-4 text-ink-soft" />
          </div>
        </div>

        <div className="mt-4 space-y-3">
          {thread.messages.map((m) => {
            if (m.offer) {
              return (
                <div key={m.id} className="max-w-[85%] overflow-hidden rounded-2xl border border-line bg-white">
                  <div className="flex items-center gap-2 bg-forest px-4 py-3 text-white">
                    <CircleCheck className="size-5" />
                    <span className="text-[14px] font-bold">
                      Offre confirmée par le vendeur
                    </span>
                  </div>
                  <div className="space-y-2.5 px-4 py-3 text-[13px]">
                    <div className="flex justify-between">
                      <span className="text-ink-soft">Total</span>
                      <span className="font-extrabold text-ink">
                        {formatShort(m.offer.total)} FCFA
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-ink-soft">Livraison</span>
                      <span className="font-semibold text-ink">
                        {m.offer.delivery}
                      </span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="flex items-center gap-1.5 text-ink-soft">
                        <Calendar className="size-4" />
                        Créneau
                      </span>
                      <span className="font-semibold text-ink">
                        {m.offer.slot}
                      </span>
                    </div>
                  </div>
                  {m.state === "awaiting" ? (
                    <>
                      <div className="flex items-center gap-2 bg-carrot-soft px-4 py-2.5 text-[13px] font-bold text-carrot-ink">
                        <TriangleAlert className="size-4" />
                        Votre accord attendu
                      </div>
                      <div className="p-3">
                        <button
                          onClick={accept}
                          className="flex w-full items-center justify-center rounded-xl bg-forest py-3 text-[14px] font-bold text-white transition active:scale-[0.99]"
                        >
                          Accepter l'offre
                        </button>
                      </div>
                    </>
                  ) : (
                    <div className="flex items-center gap-2 bg-sage px-4 py-2.5 text-[13px] font-bold text-sage-ink">
                      <Check className="size-4" />
                      Offre acceptée
                    </div>
                  )}
                </div>
              );
            }
            const mine = m.from === "buyer";
            return (
              <div key={m.id} className={mine ? "flex justify-end" : "flex justify-start"}>
                <div
                  className={`max-w-[80%] rounded-2xl px-3.5 py-2.5 text-[14px] leading-snug ${
                    mine
                      ? "rounded-br-md bg-sage text-ink"
                      : "rounded-bl-md border border-line bg-white text-ink"
                  }`}
                >
                  {m.text}
                  <span className="mt-1 flex items-center justify-end gap-1 text-[10px] text-ink-soft">
                    {m.time}
                    {mine && <CheckCheck className="size-3.5" />}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="fixed inset-x-0 bottom-0 z-20 mx-auto w-full max-w-[480px] bg-cream p-3">
        <div className="flex items-center gap-2">
          <button
            onClick={() => showToast("Prototype : pièces jointes simulées")}
            className="flex size-10 shrink-0 items-center justify-center rounded-full border border-line bg-white text-ink-soft"
            aria-label="Ajouter"
          >
            <Plus className="size-5" />
          </button>
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && draft.trim()) {
                sendMessage(thread.id, draft.trim());
                setDraft("");
              }
            }}
            placeholder="Votre message..."
            className="w-full rounded-full border border-line bg-white px-4 py-3 text-[14px] text-ink placeholder:text-ink-soft/60"
          />
          <button
            onClick={() => {
              if (draft.trim()) {
                sendMessage(thread.id, draft.trim());
                setDraft("");
              }
            }}
            className="flex size-10 shrink-0 items-center justify-center rounded-full bg-forest text-white"
            aria-label="Envoyer"
          >
            <Send className="size-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
