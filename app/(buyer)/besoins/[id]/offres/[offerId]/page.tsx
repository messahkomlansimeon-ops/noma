"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { Phone } from "lucide-react";
import { IndicatorLine, SponsoredNotice } from "@/components/matches/match-parts";
import { SessionGate, useUnauthorizedRedirect } from "@/components/session-gate";
import { Thumb } from "@/components/thumb";
import { TopBar } from "@/components/top-bar";
import { WhatsAppIcon } from "@/components/ui";
import {
  api,
  describeApiError,
  isUuid,
  type OfferContact,
  type OfferDetail,
} from "@/lib/client/api";
import { artForCategory } from "@/lib/client/catalog-view";
import {
  CONTACT_BUTTON_LABEL,
  CONTACT_HINT,
  CONTACT_NOTICE,
  CONTACT_ONGOING_LABEL,
  contactLinks,
  formatContactPhone,
  offerDetailView,
} from "@/lib/client/metrics-view";

type ContactState =
  | { kind: "idle" }
  | { kind: "pending" }
  | { kind: "done"; contact: OfferContact }
  | { kind: "failed"; message: string };

/**
 * Fiche d'une annonce pour l'acheteur, dans le contexte d'un de SES besoins : titre, prix, état, localisation, indicateurs en clair, « Sponsorisé » (relu par le
 * serveur), attributs publics et date de l'annonce. Jamais d'identifiant ni de téléphone du vendeur avant le contact. « Contacter le vendeur » révèle son numéro
 * vérifié et le compte comme un contact : le numéro n'est gardé qu'en mémoire de la page (jamais dans le navigateur).
 */
function Fiche({ demandId, offerId }: { demandId: string; offerId: string }) {
  const redirectIfUnauthorized = useUnauthorizedRedirect();
  const [detail, setDetail] = useState<OfferDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [contact, setContact] = useState<ContactState>({ kind: "idle" });
  // Verrou synchrone : un double clic n'envoie qu'UNE demande de contact à la fois.
  const contacting = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    api.demands.offer(demandId, offerId, { signal: controller.signal }).then(
      (loaded) => {
        setDetail(loaded);
        setLoadError(null);
      },
      (failure) => {
        if (controller.signal.aborted || redirectIfUnauthorized(failure)) return;
        setLoadError(describeApiError(failure, "offer"));
      },
    );
    return () => controller.abort();
  }, [demandId, offerId, reloadKey, redirectIfUnauthorized]);

  const reveal = useCallback(async () => {
    if (contacting.current) return;
    contacting.current = true;
    setContact({ kind: "pending" });
    try {
      const revealed = await api.demands.contactOffer(demandId, offerId);
      setContact({ kind: "done", contact: revealed });
    } catch (failure) {
      if (redirectIfUnauthorized(failure)) return;
      setContact({ kind: "failed", message: describeApiError(failure, "contact") });
    } finally {
      contacting.current = false;
    }
  }, [demandId, offerId, redirectIfUnauthorized]);

  if (loadError) {
    return (
      <div role="alert" data-testid="offer-load-error" className="mt-4 rounded-2xl border border-line bg-white p-4 text-center">
        <p className="text-[14px] font-semibold text-ink">{loadError}</p>
        <div className="mt-3 flex flex-col items-center gap-2">
          <button
            onClick={() => {
              setLoadError(null);
              setReloadKey((key) => key + 1);
            }}
            className="rounded-xl bg-forest px-5 py-2.5 text-[14px] font-bold text-white"
          >
            Réessayer
          </button>
          <Link href={`/besoins/${demandId}`} className="text-[13px] font-semibold text-forest underline">
            Retour aux résultats de mon besoin
          </Link>
        </div>
      </div>
    );
  }
  if (!detail) {
    return (
      <p className="mt-6 text-center text-[14px] text-ink-soft" aria-busy="true">
        Chargement de l'annonce…
      </p>
    );
  }

  const view = offerDetailView(detail);
  const links = contact.kind === "done" ? contactLinks(contact.contact) : null;
  return (
    <article data-testid="offer-detail" data-sponsored={view.sponsored ? "true" : "false"}>
      {view.sponsoredBadge ? <SponsoredNotice badge={view.sponsoredBadge} notice={view.sponsoredNotice} /> : null}
      <div className="flex items-center gap-3">
        <Thumb art={artForCategory(detail.item.candidate.category)} className="size-20" iconClassName="size-10" />
        <div className="min-w-0 flex-1">
          <h1 data-testid="offer-title" className="font-display text-[22px] font-extrabold leading-tight text-ink">
            {view.title}
          </h1>
          <div data-testid="offer-price" className="font-display text-[26px] font-extrabold leading-tight text-ink">
            {view.priceText}
          </div>
          {view.subtitle ? <div className="text-[13px] text-ink-soft">{view.subtitle}</div> : null}
          {view.dateText ? <div className="text-[12px] text-ink-soft">{view.dateText}</div> : null}
        </div>
      </div>

      <div className="mt-3 text-[13px] font-bold text-ink">{view.compatibility}</div>
      {view.compatibilityPercent !== null ? (
        <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-wash" aria-hidden>
          <div className="h-full rounded-full bg-forest" style={{ width: `${view.compatibilityPercent}%` }} />
        </div>
      ) : null}

      {view.indicators.length > 0 ? (
        <ul className="mt-3 space-y-1.5" aria-label="Indicateurs de l'annonce">
          {view.indicators.map((indicator) => (
            <IndicatorLine key={indicator.key} indicator={indicator} />
          ))}
        </ul>
      ) : null}

      {view.attributes.length > 0 ? (
        <dl data-testid="offer-attributes" className="mt-4 divide-y divide-line rounded-2xl border border-line bg-white px-4 py-1">
          {view.attributes.map((attribute) => (
            <div key={attribute.label} className="flex items-center justify-between gap-4 py-2.5 text-[13px]">
              <dt className="shrink-0 text-ink-soft">{attribute.label}</dt>
              <dd className="text-right font-semibold text-ink">{attribute.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}

      <section aria-labelledby="contact-title" className="mt-5 rounded-2xl bg-sage p-4">
        <h2 id="contact-title" className="text-[15px] font-extrabold text-forest">
          Cette annonce vous intéresse ?
        </h2>
        {contact.kind === "done" && links ? (
          <div data-testid="contact-result" className="mt-2">
            <div className="text-[13px] text-sage-ink">Numéro vérifié du vendeur</div>
            <div data-testid="contact-phone" className="font-display text-[24px] font-extrabold text-ink">
              {formatContactPhone(contact.contact.phone)}
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2.5">
              <a
                href={links.tel}
                data-testid="contact-tel"
                className="flex items-center justify-center gap-2 rounded-xl bg-forest px-3 py-3 text-[14px] font-bold text-white"
              >
                <Phone className="size-4" aria-hidden />
                Appeler
              </a>
              <a
                href={links.whatsapp}
                target="_blank"
                rel="noopener noreferrer"
                data-testid="contact-whatsapp"
                className="flex items-center justify-center gap-2 rounded-xl border border-forest/30 bg-white px-3 py-3 text-[14px] font-bold text-forest"
              >
                <WhatsAppIcon />
                WhatsApp
              </a>
            </div>
          </div>
        ) : (
          <>
            <button
              onClick={() => void reveal()}
              disabled={contact.kind === "pending"}
              data-testid="contact-button"
              className="mt-2 flex w-full items-center justify-center rounded-xl bg-forest px-4 py-3.5 text-[15px] font-bold text-white transition active:scale-[0.99] disabled:opacity-50"
            >
              {contact.kind === "pending" ? CONTACT_ONGOING_LABEL : CONTACT_BUTTON_LABEL}
            </button>
            {contact.kind === "failed" ? (
              <p role="alert" data-testid="contact-error" className="mt-2 text-[13px] font-semibold text-carrot-ink">
                {contact.message}
              </p>
            ) : null}
          </>
        )}
        <p data-testid="contact-notice" className="mt-3 text-[12px] leading-relaxed text-sage-ink">
          {CONTACT_NOTICE} {CONTACT_HINT}
        </p>
      </section>

      <p className="mt-4 text-center text-[12px] leading-relaxed text-ink-soft">
        Informations telles qu'annoncées par le vendeur. Ni l'état, ni la disponibilité ne sont garantis : confirmez-les avec lui.
      </p>
    </article>
  );
}

function PageContent() {
  const params = useParams<{ id: string; offerId: string }>();
  const demandId = typeof params.id === "string" ? params.id : "";
  const offerId = typeof params.offerId === "string" ? params.offerId : "";
  const valid = isUuid(demandId) && isUuid(offerId);
  return (
    <main>
      <TopBar back={isUuid(demandId) ? `/besoins/${demandId}` : "/alertes"} title="Annonce" />
      <div className="px-4 pb-6">
        {valid ? (
          <Fiche demandId={demandId} offerId={offerId} />
        ) : (
          <p role="alert" className="mt-6 text-center text-[14px] font-semibold text-ink">
            Annonce introuvable.
          </p>
        )}
      </div>
    </main>
  );
}

export default function FicheAnnoncePage() {
  return (
    <SessionGate>
      <PageContent />
    </SessionGate>
  );
}
