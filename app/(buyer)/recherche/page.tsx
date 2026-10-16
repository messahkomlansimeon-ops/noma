"use client";

import { useEffect } from "react";
import { LoaderCircle, OctagonAlert } from "lucide-react";
import { TopBar } from "@/components/top-bar";
import { RealOfferCard } from "@/components/real-offer-card";
import { parseBudgetFcfa } from "@/lib/contracts";
import { sourcesAllUnavailable, useRealSearch } from "@/lib/real-search";

export default function Recherche() {
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
              className="rounded-full px-2 py-1.5 text-[14px] font-bold text-accent-ink transition hover:bg-mist"
            >
              Arrêter
            </button>
          ) : status === "clarification" ? null : (
            <button
              onClick={() => void startSearch()}
              className="rounded-full px-2 py-1.5 text-[14px] font-bold text-brand transition hover:bg-mist"
            >
              Relancer
            </button>
          )
        }
      />

      <div className="px-4">
        <div className="text-[13px] font-extrabold uppercase tracking-wider text-brand-ink">
          Recherche sur d&apos;autres sites (démonstration)
        </div>
        <h1 className="text-[24px] font-extrabold text-ink">
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
          <div className="text-[14px] text-ink-soft">
            {[
              locationChip ?? "Localisation : celle de votre texte",
              budgetChip ?? "Budget : celui de votre texte",
              need.mode === "service" ? "Service" : "Achat",
            ].join(" · ")}
          </div>
        </div>

        {understanding ? (
          <div className="mt-3 border-l-4 border-brand bg-brand-soft px-4 py-3">
            <div className="text-[13px] font-semibold text-brand-ink">noma a compris</div>
            <div className="text-[15px] font-extrabold text-brand">{understanding.product}</div>
            {understanding.requirements.length > 0 ? (
              <div className="mt-1 text-[13px] text-brand-ink">
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
                  className="w-full rounded-xl border border-line bg-white px-4 py-3 text-left text-[15px] font-bold text-ink transition hover:border-brand hover:bg-brand-soft"
                >
                  {option}
                </button>
              ))}
            </div>
          </section>
        ) : null}

        {error ? (
          <div className="mt-3 flex items-start gap-2 rounded-2xl bg-accent-soft p-3.5 text-[14px] font-semibold text-accent-ink">
            <OctagonAlert className="mt-0.5 size-4 shrink-0" />
            <span>{error}</span>
          </div>
        ) : null}

        {!error && loading ? (
          <div className="mt-3 rounded-2xl bg-brand-soft p-3.5">
            <div className="flex items-center gap-2 text-[14px] font-extrabold text-brand">
              <LoaderCircle className="size-4 animate-spin" />
              {offers.length > 0
                ? `${offers.length} offre${offers.length > 1 ? "s" : ""} déjà trouvée${offers.length > 1 ? "s" : ""}`
                : "Premières pistes en cours…"}
            </div>
            <p className="mt-0.5 text-[13px] leading-snug text-brand-ink">
              Les résultats se complètent au fur et à mesure. Vous pouvez
              arrêter quand vous voulez : les offres déjà trouvées restent.
            </p>
          </div>
        ) : null}

        {status === "done" && sourcesAllUnavailable(sources) ? (
          <div className="mt-3 rounded-2xl bg-accent-soft p-3.5 text-[14px] font-semibold text-accent-ink">
            Les sources sont indisponibles pour le moment. Réessayez dans un
            instant.
          </div>
        ) : null}

        {hydrated && status === "done" && !error && offers.length === 0 && !sourcesAllUnavailable(sources) ? (
          offersRetired > 0 ? (
            <div className="mt-3 rounded-2xl bg-mist p-3.5 text-[14px] font-semibold text-ink-soft">
              {offersRetired} annonce{offersRetired > 1 ? "s" : ""} affichée
              {offersRetired > 1 ? "s" : ""} {offersRetired > 1 ? "ont été retirées" : "a été retirée"} après
              vérification d&apos;accessibilité (inaccessible — 404 confirmé).
              Aucune offre admissible ne reste : relancez ou précisez votre
              besoin.
            </div>
          ) : (
            <div className="mt-3 rounded-2xl bg-mist p-3.5 text-[14px] font-semibold text-ink-soft">
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
              showJustification
            />
          ))}
        </div>

        {loading && offers.length > 0 ? (
          <p className="mt-3 text-center text-[13px] text-ink-soft">
            La recherche continue — la liste se met à jour automatiquement.
          </p>
        ) : null}
      </div>

    </main>
  );
}
