"use client";

import { useParams, useRouter } from "next/navigation";
import { useState } from "react";
import {
  ChevronRight,
  Clock,
  Ellipsis,
  FileText,
  MessageCircle,
  Sparkles,
  User,
} from "lucide-react";
import { TopBar } from "@/components/top-bar";
import { Thumb } from "@/components/thumb";
import { Badge, Btn, OptionCard, Textarea } from "@/components/ui";
import { formatShort } from "@/lib/data";
import { useNoma } from "@/lib/store";

export default function ExamenDossier() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const kase = useNoma((s) => s.cases.find((c) => c.id === id));
  const decide = useNoma((s) => s.decide);
  const showToast = useNoma((s) => s.showToast);
  const [decision, setDecision] = useState("");
  const [motif, setMotif] = useState("");

  if (!kase) {
    return <main className="p-6 text-center text-ink-soft">Dossier introuvable.</main>;
  }

  const save = () => {
    decide(kase.id, decision, motif || "Examen effectué");
    showToast("Décision enregistrée");
    router.push("/admin/dossiers");
  };

  return (
    <main>
      <TopBar
        back="/admin/dossiers"
        title={`Dossier ${kase.id}`}
        right={
          <button className="flex size-9 items-center justify-center rounded-full text-ink transition hover:bg-wash">
            <Ellipsis className="size-5" />
          </button>
        }
      />

      <div className="px-4">
        <div className="text-center">
          <Badge tone="carrot">En examen</Badge>
        </div>

        <div className="mt-3 rounded-2xl border border-line bg-white p-3.5">
          <div className="flex items-center gap-3">
            <Thumb art={kase.art} className="size-14" iconClassName="size-7" />
            <div>
              <div className="text-[15px] font-bold text-ink">{kase.offer}</div>
              <div className="text-[13px] text-ink-soft">
                {kase.price ? `${formatShort(kase.price)} FCFA` : ""} ·{" "}
                {kase.meta.includes("externe") ? "Source externe" : "Noma"}
              </div>
            </div>
          </div>
        </div>

        <div className="mt-5 text-[16px] font-extrabold text-ink">
          Éléments disponibles
        </div>
        <div className="mt-2 divide-y divide-line rounded-2xl border border-line bg-white">
          <button
            onClick={() => showToast("Prototype : annonce originale simulée")}
            className="flex w-full items-center gap-3 px-4 py-3.5 text-left"
          >
            <span className="flex size-9 items-center justify-center rounded-full bg-wash text-ink-soft">
              <FileText className="size-[18px]" strokeWidth={1.9} />
            </span>
            <span className="text-[14px] font-semibold text-ink">
              Annonce consultée
            </span>
            <span className="ml-auto text-[13px] font-extrabold text-ink">
              {kase.price ? `${formatShort(kase.price)} F` : "—"}
            </span>
            <ChevronRight className="size-4 text-ink-soft" />
          </button>
          <button
            onClick={() => showToast("Prototype : déclaration simulée")}
            className="flex w-full items-center gap-3 px-4 py-3.5 text-left"
          >
            <span className="flex size-9 items-center justify-center rounded-full bg-wash text-ink-soft">
              <User className="size-[18px]" strokeWidth={1.9} />
            </span>
            <span className="text-[14px] font-semibold text-ink">
              Déclaration acheteur
            </span>
            <span className="ml-auto text-[13px] font-extrabold text-ink">
              {kase.declared ? `${formatShort(kase.declared)} F` : "—"}
            </span>
            <ChevronRight className="size-4 text-ink-soft" />
          </button>
        </div>

        {kase.synthesis && (
          <div className="mt-3 flex items-start gap-3 rounded-2xl bg-sage p-4">
            <Sparkles className="size-5 shrink-0 text-forest" strokeWidth={1.9} />
            <div>
              <div className="text-[14px] font-extrabold text-forest">
                Synthèse IA
              </div>
              <div className="text-[13px] text-sage-ink">{kase.synthesis}</div>
            </div>
          </div>
        )}

        <div className="mt-3 flex items-center gap-2.5 rounded-2xl border border-line bg-white px-4 py-3.5 text-[13px] text-ink-soft">
          <Clock className="size-4 shrink-0" />
          {kase.signal ?? `Signalé · ${kase.time}`}
        </div>

        <button
          onClick={() => showToast("Prototype : demande de précisions simulée")}
          className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl border border-forest/30 bg-white py-3 text-[14px] font-bold text-forest"
        >
          <MessageCircle className="size-4" />
          Demander des précisions
        </button>

        <div className="mt-5 text-[16px] font-extrabold text-ink">Décision</div>
        <div className="mt-2.5 space-y-2.5">
          <OptionCard
            selected={decision === "Conserver l'offre"}
            onClick={() => setDecision("Conserver l'offre")}
          >
            Conserver l'offre
          </OptionCard>
          <OptionCard
            selected={decision === "Masquer sur Noma"}
            onClick={() => setDecision("Masquer sur Noma")}
          >
            Masquer sur Noma
          </OptionCard>
        </div>

        <div className="mt-5 text-[16px] font-extrabold text-ink">
          Motif de la décision
        </div>
        <Textarea
          value={motif}
          onChange={(e) => setMotif(e.target.value)}
          rows={3}
          placeholder="Ajouter un motif…"
          className="mt-2"
        />

        <Btn onClick={save} disabled={!decision} className="mt-4 py-4">
          Enregistrer la décision
          <ChevronRight className="size-4" />
        </Btn>
      </div>
    </main>
  );
}
