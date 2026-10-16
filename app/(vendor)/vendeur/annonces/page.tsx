"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Archive, ChevronRight, Pause, Plus, Rocket, Search, Users, Zap, type LucideIcon } from "lucide-react";
import { ArtSearch, ArtStore } from "@/components/illustrations";
import { TopBar } from "@/components/top-bar";
import { Sheet } from "@/components/modal";
import { SessionGate, useUnauthorizedRedirect } from "@/components/session-gate";
import { NouvelleAnnonceForm } from "@/components/vendor/nouvelle-annonce-form";
import { ErrorState, LoadingBlock, Notice } from "@/components/vendor/vendor-parts";
import { Thumb } from "@/components/thumb";
import { Badge, Btn, Chip, EmptyState } from "@/components/ui";
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

const ACTION_ICONS: Record<OfferAction, LucideIcon> = { publish: Rocket, pause: Pause, archive: Archive };

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
            className="press flex size-11 items-center justify-center rounded-full bg-brand text-white shadow-[0_6px_16px_-8px_rgb(43_63_214/0.8)]"
            aria-label="Nouvelle annonce"
          >
            <Plus className="size-6" aria-hidden />
          </button>
        }
      />

      <div className="flex flex-col gap-4 px-4 pb-6 pt-2">
        <div className="flex min-h-12 items-center gap-2.5 rounded-2xl border-2 border-line bg-white px-4 hover:border-line-strong">
          <Search className="size-5 shrink-0 text-ink-soft" aria-hidden />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Rechercher une annonce"
            aria-label="Rechercher une annonce"
            className="min-h-11 w-full bg-transparent text-[16px] text-ink placeholder:text-ink-soft/60"
          />
        </div>

        <div className="flex flex-wrap gap-2">
          {OFFER_FILTERS.map((f) => (
            <Chip
              key={f.id}
              className="min-h-11"
              active={filter === f.id}
              onClick={() => {
                setFilter(f.id);
                setArmed(null);
              }}
            >
              {f.label}
              {offers ? countSuffix(countOffers(offers, f.id), truncated) : ""}
            </Chip>
          ))}
        </div>

        {truncated && !loadError ? (
          <Notice tone="accent" role="status">
            {LIST_TRUNCATED_MESSAGE}
          </Notice>
        ) : null}

        {loadError ? (
          <ErrorState
            message={loadError}
            onRetry={() => {
              setLoadError(null);
              reload();
            }}
          />
        ) : offers === null ? (
          <LoadingBlock label="Chargement de vos annonces…" />
        ) : visible.length === 0 ? (
          offers.length === 0 ? (
            <EmptyState
              art={<ArtStore className="size-36" />}
              title="Vous n'avez pas encore d'annonce."
              action={
                <Btn onClick={() => setSheet(true)}>
                  <Plus className="size-5" aria-hidden />
                  Nouvelle annonce
                </Btn>
              }
            />
          ) : (
            <EmptyState art={<ArtSearch className="size-32" />} title="Aucune annonce ne correspond à ce filtre." />
          )
        ) : (
          <div className="stagger flex flex-col gap-3 md:grid md:grid-cols-2 md:items-start">
            {visible.map((offer) => {
              const status = OFFER_STATUS_VIEW[offer.status];
              const price = formatMoney(offer.price);
              const summary = offerSummary(offer);
              const busy = busyId === offer.id;
              const actions = offerActions(offer.status);
              return (
                <div key={offer.id} className="rounded-3xl border border-line bg-white p-4">
                  <div className="flex items-center gap-3">
                    <Thumb art={artForCategory(offer.category)} className="size-16" iconClassName="size-8" photoId={offer.coverPhotoId} />
                    <div className="min-w-0 flex-1">
                      <div className="line-clamp-2 text-[16px] font-bold leading-snug text-ink">
                        {recordTitle(offer)}
                      </div>
                      {price ? (
                        <div className="text-[20px] font-extrabold leading-tight text-ink">{price}</div>
                      ) : (
                        <div className="text-[14px] font-semibold text-accent-ink">Prix à compléter</div>
                      )}
                      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                        <Badge tone={status.tone}>{status.label}</Badge>
                        {offer.availabilityStatus === "unavailable" && (
                          <Badge tone="carrot">Indisponible</Badge>
                        )}
                        {offer.availabilityStatus === "reserved" && <Badge tone="sky">Réservée</Badge>}
                      </div>
                    </div>
                  </div>
                  {summary && <div className="mt-2 line-clamp-2 text-[13px] text-ink-soft">{summary}</div>}
                  <Link
                    href={`/vendeur/annonces/${offer.id}`}
                    aria-label={`Acheteurs intéressés et boost : ${recordTitle(offer)}`}
                    className="press mt-3 flex min-h-12 items-center gap-2.5 rounded-2xl bg-brand-soft px-3.5 text-[14px] font-bold text-brand-ink hover:bg-brand-soft/70"
                  >
                    <Users className="size-5 shrink-0" aria-hidden />
                    <span className="flex-1">Acheteurs intéressés et boost</span>
                    <Zap className="size-4 shrink-0" aria-hidden />
                    <ChevronRight className="size-5 shrink-0" aria-hidden />
                  </Link>
                  {actions.length > 0 && (
                    <div className="mt-3 flex gap-2">
                      {actions.map((a) => {
                        const Icon = ACTION_ICONS[a.action];
                        const confirm = a.action === "archive" && armed === `${offer.id}:archive`;
                        return (
                          <button
                            key={a.action}
                            onClick={() => void run(offer, a.action)}
                            disabled={busyId !== null}
                            className={`press flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-2xl border-2 px-3 text-[14px] font-bold disabled:opacity-40 ${
                              confirm ? "border-accent bg-accent text-ink" : "border-line-strong bg-white text-ink hover:border-brand hover:text-brand"
                            }`}
                          >
                            <Icon className="size-4 shrink-0" aria-hidden />
                            {busy ? "…" : confirm ? "Confirmer l'archivage" : a.label}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
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
