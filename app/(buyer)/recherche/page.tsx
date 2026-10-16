"use client";

import { useEffect } from "react";
import { ChevronRight, Globe, Info, LoaderCircle, MapPin, OctagonAlert, RotateCw, Search, Sparkles, Square, Wallet } from "lucide-react";
import { ArtEmpty } from "@/components/illustrations";
import { TopBar } from "@/components/top-bar";
import { Badge, EmptyState, IconTile, Skeleton } from "@/components/ui";
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
              className="press flex min-h-11 items-center gap-1.5 rounded-full px-3 text-[14px] font-bold text-accent-ink hover:bg-mist"
            >
              <Square className="size-4" aria-hidden />
              Arrêter
            </button>
          ) : status === "clarification" ? null : (
            <button
              onClick={() => void startSearch()}
              className="press flex min-h-11 items-center gap-1.5 rounded-full px-3 text-[14px] font-bold text-brand hover:bg-mist"
            >
              <RotateCw className="size-4" aria-hidden />
              Relancer
            </button>
          )
        }
      />

      <div className="flex flex-col gap-4 px-4 pb-6 pt-1">
        <div className="flex flex-col items-start gap-2">
          <Badge tone="sky">
            <Globe className="size-3.5" aria-hidden />
            Recherche sur d&apos;autres sites (démonstration)
          </Badge>
          <h1 className="text-[24px] font-extrabold tracking-tight text-ink">
            {status === "loading"
              ? "Recherche en cours…"
              : status === "clarification"
                ? "Une précision suffit."
                : "Des pistes pour vous."}
          </h1>
        </div>

        <div className="animate-rise flex items-start gap-3 rounded-3xl border border-line bg-white p-4">
          <IconTile icon={Search} tone="brand" />
          <div className="min-w-0 flex-1">
            <div className="text-[16px] font-bold leading-snug text-ink">
              {need.text.trim() || "Votre besoin"}
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              <Badge tone="wash">
                <MapPin className="size-3.5" aria-hidden />
                {locationChip ?? "Localisation : celle de votre texte"}
              </Badge>
              <Badge tone="wash">
                <Wallet className="size-3.5" aria-hidden />
                {budgetChip ?? "Budget : celui de votre texte"}
              </Badge>
              <Badge tone="wash">{need.mode === "service" ? "Service" : "Achat"}</Badge>
            </div>
          </div>
        </div>

        {understanding ? (
          <div className="animate-rise flex items-start gap-3 rounded-3xl bg-brand-soft p-4">
            <IconTile icon={Sparkles} tone="brand" className="size-10" />
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-semibold text-brand-ink">noma a compris</div>
              <div className="text-[16px] font-extrabold text-brand-ink">{understanding.product}</div>
              {understanding.requirements.length > 0 ? (
                <div className="mt-1 text-[13px] text-brand-ink">
                  Obligatoire : {understanding.requirements.join(" · ")}
                </div>
              ) : null}
            </div>
          </div>
        ) : null}

        {status === "clarification" && clarification ? (
          <section className="animate-rise rounded-3xl border border-line bg-white p-4">
            <h2 className="text-[17px] font-extrabold text-ink">{clarification.question}</h2>
            <div className="mt-3 grid gap-2 md:grid-cols-2">
              {clarification.options.map((option) => (
                <button
                  key={option}
                  onClick={() => void answerClarification(option)}
                  className="press flex min-h-12 w-full items-center justify-between gap-2 rounded-2xl border-2 border-line bg-white px-4 py-3 text-left text-[15px] font-bold text-ink hover:border-brand hover:bg-brand-soft"
                >
                  {option}
                  <ChevronRight className="size-5 shrink-0 text-ink-soft" aria-hidden />
                </button>
              ))}
            </div>
          </section>
        ) : null}

        {error ? (
          <div className="flex items-start gap-2 rounded-2xl bg-accent-soft p-3.5 text-[14px] font-semibold text-accent-ink">
            <OctagonAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
            <span>{error}</span>
          </div>
        ) : null}

        {!error && loading ? (
          <div className="flex items-center gap-2 rounded-2xl bg-brand-soft p-3.5 text-[14px] font-extrabold text-brand-ink" role="status">
            <LoaderCircle className="size-5 animate-spin" aria-hidden />
            {offers.length > 0
              ? `${offers.length} offre${offers.length > 1 ? "s" : ""} déjà trouvée${offers.length > 1 ? "s" : ""}`
              : "Premières pistes en cours…"}
          </div>
        ) : null}

        {!error && loading && offers.length === 0 ? (
          <div className="flex flex-col gap-3 md:grid md:grid-cols-2" aria-hidden>
            <Skeleton className="h-32 w-full rounded-3xl" />
            <Skeleton className="h-32 w-full rounded-3xl" />
          </div>
        ) : null}

        {status === "done" && sourcesAllUnavailable(sources) ? (
          <div className="flex items-start gap-2 rounded-2xl bg-accent-soft p-3.5 text-[14px] font-semibold text-accent-ink">
            <OctagonAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
            Les sources sont indisponibles pour le moment. Réessayez dans un
            instant.
          </div>
        ) : null}

        {hydrated && status === "done" && !error && offers.length === 0 && !sourcesAllUnavailable(sources) ? (
          offersRetired > 0 ? (
            <div className="flex items-start gap-2 rounded-2xl bg-mist p-3.5 text-[14px] font-semibold text-ink-soft">
              <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
              <span>
                {offersRetired} annonce{offersRetired > 1 ? "s" : ""} affichée
                {offersRetired > 1 ? "s" : ""} {offersRetired > 1 ? "ont été retirées" : "a été retirée"} après
                vérification d&apos;accessibilité (inaccessible — 404 confirmé).
                Aucune offre admissible ne reste : relancez ou précisez votre
                besoin.
              </span>
            </div>
          ) : (
            <EmptyState art={<ArtEmpty className="size-36" />} title="Aucune offre trouvée pour ce besoin." />
          )
        ) : null}

        <div className="stagger flex flex-col gap-3 md:grid md:grid-cols-2">
          {offers.map((offer) => (
            <RealOfferCard
              key={offer.id}
              offer={offer}
              showJustification
            />
          ))}
        </div>
      </div>

    </main>
  );
}
