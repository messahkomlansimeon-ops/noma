"use client";

import Link from "next/link";
import { useEffect } from "react";
import { ChevronDown, LoaderCircle, OctagonAlert, SlidersHorizontal } from "lucide-react";
import { TopBar } from "@/components/top-bar";
import { RealOfferCard } from "@/components/real-offer-card";
import { Chip } from "@/components/ui";
import { parseBudgetFcfa } from "@/lib/contracts";
import { useNoma } from "@/lib/store";
import { sourcesAllUnavailable, useRealSearch } from "@/lib/real-search";

export default function Recherche() {
  const compare = useNoma((s) => s.compare);
  const toggleCompare = useNoma((s) => s.toggleCompare);
  const offers = useRealSearch((s) => s.offers);
  const need = useRealSearch((s) => s.need);
  const status = useRealSearch((s) => s.status);
  const error = useRealSearch((s) => s.error);
  const sources = useRealSearch((s) => s.sources);
  const offersRetired = useRealSearch((s) => s.offersRetired);
  const hydrated = useRealSearch((s) => s.hydrated);
  const hydrate = useRealSearch((s) => s.hydrate);
  const cancelSearch = useRealSearch((s) => s.cancelSearch);
  const startSearch = useRealSearch((s) => s.startSearch);
  const understanding = useRealSearch((s) => s.understanding);
  const clarification = useRealSearch((s) => s.clarification);
  const answerClarification = useRealSearch((s) => s.answerClarification);

  // restauration des résultats (< 30 min) sans relance automatique
  useEffect(() => {
    hydrate();
  }, [hydrate]);

  const loading = status === "loading";
  // la comparaison ne porte que sur des offres réellement affichées (jamais
  // les offres fictives de démonstration)
  const selectedIds = compare.filter((id) => offers.some((o) => o.id === id));
  // chip budget : montant normalisé (« 150 000 FCFA » → « 150 000 F max »)
  const budgetParsed = parseBudgetFcfa(need.budgetFcfa);
  const budgetChip =
    need.budgetFcfa.trim().length > 0
      ? budgetParsed.ok
        ? `${new Intl.NumberFormat("fr-FR").format(budgetParsed.value)} F max`
        : need.budgetFcfa.trim()
      : null;
  const locationChip = need.location.trim() || null;

  return (
    <main>
      <TopBar
        back="/"
        title="Votre recherche"
        right={
          loading ? (
            <button
              onClick={cancelSearch}
              className="rounded-full px-2 py-1.5 text-[13px] font-bold text-carrot-ink transition hover:bg-wash"
            >
              Arrêter
            </button>
          ) : status === "clarification" ? null : (
            <button
              onClick={() => void startSearch()}
              className="rounded-full px-2 py-1.5 text-[13px] font-bold text-forest transition hover:bg-wash"
            >
              Relancer
            </button>
          )
        }
      />

      <div className="px-4">
        <h1 className="font-display text-[24px] font-extrabold text-ink">
          {status === "loading"
            ? "Recherche en cours…"
            : status === "clarification"
              ? "Une précision suffit."
              : "Des pistes pour vous."}
        </h1>

        <div className="mt-3 rounded-2xl border border-line bg-white p-4">
          <div className="text-[16px] font-bold text-ink">
            {need.text.trim() || "Votre besoin"}
          </div>
          <div className="text-[13px] text-ink-soft">
            {[
              locationChip ?? "Localisation : celle de votre texte",
              budgetChip ?? "Budget : celui de votre texte",
              need.mode === "service" ? "Service" : "Achat",
            ].join(" · ")}
          </div>
        </div>

        {understanding ? (
          <div className="mt-3 border-l-4 border-forest bg-sage px-4 py-3">
            <div className="text-[12px] font-semibold text-sage-ink">Noma a compris</div>
            <div className="text-[15px] font-extrabold text-forest">{understanding.product}</div>
            {understanding.requirements.length > 0 ? (
              <div className="mt-1 text-[12px] text-sage-ink">
                Obligatoire : {understanding.requirements.join(" · ")}
              </div>
            ) : null}
          </div>
        ) : null}

        {status === "clarification" && clarification ? (
          <section className="mt-3 border-y border-line bg-white py-4">
            <h2 className="text-[16px] font-extrabold text-ink">{clarification.question}</h2>
            <div className="mt-3 grid gap-2">
              {clarification.options.map((option) => (
                <button
                  key={option}
                  onClick={() => void answerClarification(option)}
                  className="w-full rounded-xl border border-line bg-white px-4 py-3 text-left text-[14px] font-bold text-ink transition hover:border-forest hover:bg-sage"
                >
                  {option}
                </button>
              ))}
            </div>
          </section>
        ) : null}

        <div className="mt-3 flex items-center gap-2">
          <Chip active>
            Pertinence
            <ChevronDown className="size-3.5 opacity-70" />
          </Chip>
          <Chip className="cursor-pointer">
            <SlidersHorizontal className="size-3.5" />
            Filtres
          </Chip>
        </div>

        {error ? (
          <div className="mt-3 flex items-start gap-2 rounded-2xl bg-carrot-soft p-3.5 text-[13px] font-semibold text-carrot-ink">
            <OctagonAlert className="mt-0.5 size-4 shrink-0" />
            <span>{error}</span>
          </div>
        ) : null}

        {!error && loading ? (
          <div className="mt-3 rounded-2xl bg-sage p-3.5">
            <div className="flex items-center gap-2 text-[13px] font-extrabold text-forest">
              <LoaderCircle className="size-4 animate-spin" />
              {offers.length > 0
                ? `${offers.length} offre${offers.length > 1 ? "s" : ""} déjà trouvée${offers.length > 1 ? "s" : ""}`
                : "Premières pistes en cours…"}
            </div>
            <p className="mt-0.5 text-[12px] leading-snug text-sage-ink">
              Les résultats se complètent au fur et à mesure. Vous pouvez
              arrêter quand vous voulez : les offres déjà trouvées restent.
            </p>
          </div>
        ) : null}

        {status === "done" && sourcesAllUnavailable(sources) ? (
          <div className="mt-3 rounded-2xl bg-carrot-soft p-3.5 text-[13px] font-semibold text-carrot-ink">
            Les sources sont indisponibles pour le moment. Réessayez dans un
            instant.
          </div>
        ) : null}

        {hydrated && status === "done" && !error && offers.length === 0 && !sourcesAllUnavailable(sources) ? (
          offersRetired > 0 ? (
            <div className="mt-3 rounded-2xl bg-wash p-3.5 text-[13px] font-semibold text-ink-soft">
              {offersRetired} annonce{offersRetired > 1 ? "s" : ""} affichée
              {offersRetired > 1 ? "s" : ""} {offersRetired > 1 ? "ont été retirées" : "a été retirée"} après
              vérification d&apos;accessibilité (inaccessible — 404 confirmé).
              Aucune offre admissible ne reste : relancez ou précisez votre
              besoin.
            </div>
          ) : (
            <div className="mt-3 rounded-2xl bg-wash p-3.5 text-[13px] font-semibold text-ink-soft">
              Aucune offre trouvée pour ce besoin. Précisez le produit, la
              localisation ou le budget, puis relancez.
            </div>
          )
        ) : null}

        <div className="mt-3 space-y-3">
          {offers.map((offer) => (
            <RealOfferCard
              key={offer.id}
              offer={offer}
              selectable
              selected={selectedIds.includes(offer.id)}
              onToggle={() => toggleCompare(offer.id)}
              showJustification
            />
          ))}
        </div>

        {loading && offers.length > 0 ? (
          <p className="mt-3 text-center text-[12px] text-ink-soft">
            La recherche continue — la liste se met à jour automatiquement.
          </p>
        ) : null}
      </div>

      {selectedIds.length > 0 && (
        <div className="fixed inset-x-0 bottom-[57px] z-20 mx-auto w-full max-w-[480px] border-t border-line bg-white/95 p-3 backdrop-blur">
          <Link
            href="/comparer"
            className="flex w-full items-center justify-center gap-2 rounded-xl bg-forest py-3 text-[15px] font-bold text-white transition active:scale-[0.99]"
          >
            Comparer les {selectedIds.length} offre{selectedIds.length > 1 ? "s" : ""}
            <span className="flex size-5 items-center justify-center rounded-full bg-white/20 text-[11px] font-extrabold">
              {selectedIds.length}
            </span>
          </Link>
        </div>
      )}
    </main>
  );
}
