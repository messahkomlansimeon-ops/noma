"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ChevronRight, Plus, Search } from "lucide-react";
import { TopBar } from "@/components/top-bar";
import { Sheet } from "@/components/modal";
import { SessionGate, useUnauthorizedRedirect } from "@/components/session-gate";
import { NouvelleAnnonceForm } from "@/components/vendor/nouvelle-annonce-form";
import { Thumb } from "@/components/thumb";
import { Badge } from "@/components/ui";
import { ApiError, api, describeApiError, type OfferRecord } from "@/lib/client/api";
import {
  LIST_TRUNCATED_MESSAGE,
  OFFER_FILTERS,
  OFFER_STATUS_VIEW,
  artForCategory,
  countOffers,
  countSuffix,
  filterOffers,
  formatMoney,
  newestFirst,
  offerActions,
  offerSummary,
  recordTitle,
  replaceRecord,
  type OfferAction,
  type OfferFilter,
} from "@/lib/client/catalog-view";
import { useNoma } from "@/lib/store";

const ACTION_DONE: Record<OfferAction, string> = {
  publish: "Annonce en ligne",
  pause: "Annonce mise en pause",
  archive: "Annonce archivée",
};

function MesAnnonces() {
  const showToast = useNoma((s) => s.showToast);
  const redirectIfUnauthorized = useUnauthorizedRedirect();
  const [offers, setOffers] = useState<OfferRecord[] | null>(null);
  // Plafond de pages atteint : la liste est incomplète et les compteurs ne sont pas exacts.
  const [truncated, setTruncated] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [filter, setFilter] = useState<OfferFilter>("all");
  const [query, setQuery] = useState("");
  const [sheet, setSheet] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  // Archiver est définitif : un premier appui arme l'action, le second la confirme.
  const [armed, setArmed] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    api.offers.listAll({ signal: controller.signal }).then(
      (result) => {
        setOffers(newestFirst(result.items));
        setTruncated(result.truncated);
        setLoadError(null);
      },
      (failure) => {
        if (controller.signal.aborted || redirectIfUnauthorized(failure)) return;
        setLoadError(describeApiError(failure, "catalog"));
      },
    );
    return () => controller.abort();
  }, [reloadKey, redirectIfUnauthorized]);

  const reload = () => setReloadKey((key) => key + 1);

  const upsert = (saved: OfferRecord) =>
    setOffers((current) => {
      const list = current ?? [];
      return list.some((offer) => offer.id === saved.id)
        ? replaceRecord(list, saved)
        : newestFirst([...list, saved]);
    });

  const run = async (offer: OfferRecord, action: OfferAction) => {
    if (busyId) return;
    if (action === "archive" && armed !== `${offer.id}:archive`) {
      setArmed(`${offer.id}:archive`);
      return;
    }
    setArmed(null);
    setBusyId(offer.id);
    try {
      const updated =
        action === "publish"
          ? await api.offers.publish(offer.id, offer.contentVersion)
          : action === "pause"
            ? await api.offers.pause(offer.id, offer.contentVersion)
            : await api.offers.archive(offer.id, offer.contentVersion);
      upsert(updated);
      showToast(ACTION_DONE[action]);
    } catch (failure) {
      if (redirectIfUnauthorized(failure)) return;
      showToast(describeApiError(failure, "catalog"));
      // Version obsolète, statut changé ou annonce disparue : la liste affichée n'est plus fiable.
      if (failure instanceof ApiError && (failure.status === 404 || failure.status === 409)) reload();
    } finally {
      setBusyId(null);
    }
  };

  const needle = query.trim().toLowerCase();
  const visible = filterOffers(offers ?? [], filter).filter(
    (offer) =>
      needle.length === 0 ||
      `${recordTitle(offer)} ${offerSummary(offer)}`.toLowerCase().includes(needle),
  );

  return (
    <main>
      <TopBar
        back="/vendeur"
        title="Mes annonces"
        right={
          <button
            onClick={() => setSheet(true)}
            className="flex size-9 items-center justify-center rounded-full bg-forest text-white"
            aria-label="Nouvelle annonce"
          >
            <Plus className="size-5" />
          </button>
        }
      />

      <div className="px-4">
        <div className="flex items-center gap-2.5 rounded-xl border border-line bg-white px-3.5 py-3">
          <Search className="size-4 text-ink-soft" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Rechercher une annonce"
            aria-label="Rechercher une annonce"
            className="w-full bg-transparent text-[14px] text-ink placeholder:text-ink-soft/60"
          />
        </div>

        <div className="mt-3 flex flex-wrap gap-2">
          {OFFER_FILTERS.map((f) => (
            <button
              key={f.id}
              onClick={() => {
                setFilter(f.id);
                setArmed(null);
              }}
              className={`rounded-full px-3.5 py-1.5 text-[13px] font-semibold transition ${
                filter === f.id
                  ? "bg-forest text-white"
                  : "border border-line bg-white text-ink"
              }`}
            >
              {f.label}
              {offers ? countSuffix(countOffers(offers, f.id), truncated) : ""}
            </button>
          ))}
        </div>

        {truncated && !loadError ? (
          <p role="status" className="mt-3 text-[13px] font-semibold text-carrot-ink">
            {LIST_TRUNCATED_MESSAGE}
          </p>
        ) : null}

        {loadError ? (
          <div role="alert" className="mt-4 rounded-2xl border border-line bg-white p-4 text-center">
            <p className="text-[14px] font-semibold text-ink">{loadError}</p>
            <button
              onClick={() => {
                setLoadError(null);
                reload();
              }}
              className="mt-3 rounded-xl bg-forest px-5 py-2.5 text-[14px] font-bold text-white"
            >
              Réessayer
            </button>
          </div>
        ) : offers === null ? (
          <p className="mt-6 text-center text-[14px] text-ink-soft" aria-busy="true">
            Chargement de vos annonces…
          </p>
        ) : visible.length === 0 ? (
          <p className="mt-6 text-center text-[14px] text-ink-soft">
            {offers.length === 0
              ? "Vous n'avez pas encore d'annonce."
              : "Aucune annonce ne correspond à ce filtre."}
          </p>
        ) : (
          <div className="mt-4 space-y-3">
            {visible.map((offer) => {
              const status = OFFER_STATUS_VIEW[offer.status];
              const price = formatMoney(offer.price);
              const summary = offerSummary(offer);
              const busy = busyId === offer.id;
              return (
                <div key={offer.id} className="rounded-2xl border border-line bg-white p-3.5">
                  <div className="flex items-center gap-3">
                    <Thumb art={artForCategory(offer.category)} className="size-14" iconClassName="size-7" photoId={offer.coverPhotoId} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[15px] font-bold text-ink">
                        {recordTitle(offer)}
                      </div>
                      {price ? (
                        <div className="font-display text-[18px] font-extrabold text-ink">{price}</div>
                      ) : (
                        <div className="text-[13px] text-ink-soft">Prix à compléter</div>
                      )}
                      <div className="mt-1 flex flex-wrap items-center gap-1.5">
                        <Badge tone={status.tone}>{status.label}</Badge>
                        {offer.availabilityStatus === "unavailable" && (
                          <Badge tone="carrot">Indisponible</Badge>
                        )}
                        {offer.availabilityStatus === "reserved" && <Badge tone="sky">Réservée</Badge>}
                      </div>
                    </div>
                  </div>
                  {summary && <div className="mt-1.5 text-[12px] text-ink-soft">{summary}</div>}
                  <Link
                    href={`/vendeur/annonces/${offer.id}`}
                    aria-label={`Acheteurs intéressés et boost : ${recordTitle(offer)}`}
                    className="mt-2 flex items-center justify-between border-t border-line pt-2.5 text-[13px] font-bold text-forest"
                  >
                    Acheteurs intéressés et boost
                    <ChevronRight className="size-4" aria-hidden />
                  </Link>
                  {offerActions(offer.status).length > 0 && (
                    <div className="mt-2.5 flex border-t border-line pt-2.5">
                      {offerActions(offer.status).map((a, index) => (
                        <button
                          key={a.action}
                          onClick={() => void run(offer, a.action)}
                          disabled={busyId !== null}
                          className={`flex flex-1 items-center justify-center gap-1.5 text-[13px] font-bold disabled:opacity-40 ${
                            a.action === "archive" && armed === `${offer.id}:archive`
                              ? "text-carrot-ink"
                              : "text-ink"
                          } ${index > 0 ? "border-l border-line" : ""}`}
                        >
                          {busy
                            ? "…"
                            : a.action === "archive" && armed === `${offer.id}:archive`
                              ? "Confirmer l'archivage"
                              : a.label}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        <button
          onClick={() => setSheet(true)}
          className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-forest py-3.5 text-[15px] font-bold text-white transition active:scale-[0.99]"
        >
          <Plus className="size-4" />
          Nouvelle annonce
        </button>
      </div>

      <Sheet open={sheet} onClose={() => setSheet(false)} title="Nouvelle annonce">
        <NouvelleAnnonceForm embedded onDone={() => setSheet(false)} onSaved={upsert} />
      </Sheet>
    </main>
  );
}

export default function MesAnnoncesPage() {
  return (
    <SessionGate>
      <MesAnnonces />
    </SessionGate>
  );
}
