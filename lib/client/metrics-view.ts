/**
 * Présentation des mesures d'efficacité (lot M1) : libellés et règles en fonctions PURES, sans React, testées isolément. Deux écrans :
 *  - la fiche d'une annonce pour l'acheteur (titre, prix, indicateurs, « Sponsorisé », attributs publics, contact) ;
 *  - « Ce que produit votre annonce » pour le vendeur (apparitions, ouvertures, contacts, ratios, attribution au boost).
 *
 * Règles de présentation :
 *  - un compte s'affiche arrondi (lot M1-quater) : « moins de 5 » de 0 à 4, sinon « environ 15 » (le serveur envoie `{ kind: "below", bound: 5 }` ou
 *    `{ kind: "approx", value }`, jamais le compte exact) ; plus aucun « moins de 3 » ;
 *  - un pourcentage s'affiche « environ 70 % » (dizaine de pour cent, calculé sur les nombres publiés) ; non publié : « pas assez d'acheteurs pour un pourcentage » ;
 *  - « ouverture » = la page de l'annonce a été servie (pas une lecture prouvée) ; aucune vente n'est mesurée ;
 *  - jamais d'identité d'acheteur, jamais d'identifiant.
 */

import type {
  BoostStatsEntry,
  StatCount,
  StatRatio,
  OfferContact,
  OfferDetail,
  OfferPublicAttribute,
  OfferStats,
  PeriodStats,
  StatsPeriodCode,
} from "./api";
import { formatMoney } from "./catalog-view";
import { SPONSORED_BADGE_LABEL, SPONSORED_NOTICE, indicatorViews, productTitle, type IndicatorView } from "./match-view";

export const CONTACT_NOTICE = "Le vendeur verra que vous l'avez contacté via noma.";
export const CONTACT_BUTTON_LABEL = "Contacter le vendeur";
export const CONTACT_ONGOING_LABEL = "Contact en cours…";
export const CONTACT_HINT = "Le vendeur ne voit qu'un compteur : jamais votre nom ni votre numéro.";

// ───────────── comptes arrondis ─────────────

/** « moins de 5 » ou « environ 15 ». */
export function countText(count: StatCount): string {
  return count.kind === "below" ? `moins de ${count.bound}` : `environ ${count.value}`;
}

/** « moins de 5 acheteurs », « environ 15 acheteurs » (un compte publié vaut toujours 5 ou plus : le pluriel). */
export function buyersText(count: StatCount): string {
  return `${countText(count)} acheteurs`;
}

/** « moins de 5 ouvertures », « environ 15 ouvertures » : un nombre d'événements est arrondi comme un nombre d'acheteurs. */
export function eventsText(count: StatCount, plural: string): string {
  return `${countText(count)} ${plural}`;
}

/** « environ 70 % » ; non publié : « pas assez d'acheteurs pour un pourcentage ». */
export const RATIO_INSUFFICIENT_TEXT = "pas assez d'acheteurs pour un pourcentage";
export function ratioText(ratio: StatRatio): string {
  return ratio.kind === "percent" ? `environ ${ratio.value} %` : RATIO_INSUFFICIENT_TEXT;
}

// ───────────── fiche d'une annonce (acheteur) ─────────────

export interface OfferDetailView {
  title: string;
  subtitle: string | null;
  priceText: string;
  /** Texte de compatibilité (« Compatibilité 87 % »). */
  compatibility: string;
  compatibilityPercent: number | null;
  indicators: IndicatorView[];
  sponsored: boolean;
  sponsoredBadge: string | null;
  sponsoredNotice: string | null;
  /** « Annonce du 12 octobre 2026 » (date de création : le modèle ne conserve pas de date de mise en ligne distincte). */
  dateText: string | null;
  attributes: { label: string; value: string }[];
}

const MONTHS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];

/** « 12 octobre 2026 » d'une date ISO, en UTC (jamais le fuseau de l'appareil : même texte pour tous) ; null si illisible. */
export function frenchDate(iso: string): string | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

/** « etat_batterie » → « Etat batterie ». */
export function attributeLabel(key: string): string {
  const text = key.replace(/_/g, " ").trim();
  return text.length === 0 ? key : `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

export function offerDetailView(detail: OfferDetail): OfferDetailView {
  const { item } = detail;
  const percent = item.score === null || !Number.isFinite(item.score) ? null : Math.min(100, Math.max(0, Math.round(item.score)));
  const product = item.candidate;
  const subtitle = [product.condition, product.location].filter((part): part is string => Boolean(part && part.trim())).join(" · ");
  const date = frenchDate(detail.details.createdAt);
  return {
    title: productTitle(product, "Annonce"),
    subtitle: subtitle || null,
    priceText: formatMoney(product.price) ?? "Prix non renseigné",
    compatibility: percent === null ? "Compatibilité à confirmer" : `Compatibilité ${percent} %`,
    compatibilityPercent: percent,
    indicators: indicatorViews(item.indicators),
    sponsored: item.sponsored === true,
    sponsoredBadge: item.sponsored === true ? SPONSORED_BADGE_LABEL : null,
    sponsoredNotice: item.sponsored === true ? SPONSORED_NOTICE : null,
    dateText: date === null ? null : `Annonce du ${date}`,
    attributes: detail.details.attributes.map((attribute: OfferPublicAttribute) => ({ label: attributeLabel(attribute.key), value: attribute.value })),
  };
}

/** Lien vers la fiche, depuis la liste des résultats : les deux identifiants viennent du serveur (UUID) ; sinon aucun lien. */
export function offerDetailPath(demandId: string, offerId: string): string | null {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuid.test(demandId) && uuid.test(offerId) ? `/besoins/${demandId}/offres/${offerId}` : null;
}

/** Numéro affiché lisiblement : « +225 07 00 00 00 42 » pour la Côte d'Ivoire (10 chiffres locaux), sinon le numéro E.164 tel quel. */
export function formatContactPhone(phone: string): string {
  const ivory = /^\+225(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(phone);
  return ivory ? `+225 ${ivory[1]} ${ivory[2]} ${ivory[3]} ${ivory[4]} ${ivory[5]}` : phone;
}

/** Les deux liens du contact sont reconstruits depuis le numéro : un lien venu d'ailleurs n'est jamais suivi. */
export function contactLinks(contact: Pick<OfferContact, "phone">): { tel: string; whatsapp: string } {
  return { tel: `tel:${contact.phone}`, whatsapp: `https://wa.me/${contact.phone.replace(/^\+/, "")}` };
}

// ───────────── « Ce que produit votre annonce » (vendeur) ─────────────

export const ATTRIBUTION_SENTENCE =
  "Les ouvertures et les contacts sont attribués au boost seulement si l'acheteur avait vu votre annonce sponsorisée dans les 7 jours qui précèdent ; sinon ils sont comptés comme organiques.";
export const EXPOSURE_SENTENCE = "Les apparitions dans les résultats ne sont comptées que pendant un boost : sans boost, l'écran ne peut pas dire combien de fois votre annonce a été servie.";
export const OPEN_SENTENCE = "Une ouverture veut dire que la page de votre annonce a été servie à un acheteur : ce n'est pas la preuve qu'il l'a lue. Aucune vente n'est mesurée.";
export const PRIVACY_SENTENCE = "Pour protéger les acheteurs, les chiffres sont arrondis à 5 près et les petits nombres ne sont pas détaillés.";
export const FEW_STATS_YET = "Encore peu d'activité : les petits nombres ne sont pas détaillés.";
/** Annonce sans boost : aucune ligne « pendant un boost » ni « attribué au boost » ; une seule phrase. */
export const NO_BOOST_SENTENCE = "Aucun boost sur cette annonce : tout est organique.";
/** Boost qui n'a pas encore commencé : aucune apparition ni aucune ouverture attribuée n'est possible. */
export const BOOST_NOT_STARTED_SENTENCE = "Ce boost n'a pas encore commencé : rien à mesurer pour le moment.";

export const PERIOD_LABELS: Readonly<Record<StatsPeriodCode, string>> = Object.freeze({
  "7d": "7 derniers jours",
  "30d": "30 derniers jours",
  all: "Depuis la publication",
});

export interface StatLine {
  /** Clé de liste React : jamais affichée. */
  key: string;
  label: string;
  value: string;
  /** Précision (définition en mots simples). */
  hint: string | null;
}

export interface PeriodView {
  period: StatsPeriodCode;
  title: string;
  lines: StatLine[];
}

/**
 * Lignes d'une période, en mots simples. Une ligne n'existe que si elle peut avoir une valeur : sans boost (ou sans boost qui touche la période), pas de ligne
 * « pendant un boost » ni « attribué au boost » (le serveur envoie alors `null`) ; tout est organique. Les deux taux (ouverture parmi les acheteurs servis, contact
 * parmi les ouvreurs) sont calculés sur les nombres publiés : « environ 70 % », ou « pas assez d'acheteurs pour un pourcentage ».
 */
export function periodView(period: PeriodStats): PeriodView {
  const lines: StatLine[] = [];
  if (period.exposure) {
    lines.push(
      { key: "served", label: "Apparitions dans les résultats (pendant un boost)", value: eventsText(period.exposure.servings, "apparitions"), hint: null },
      { key: "exposed", label: "Acheteurs à qui votre annonce a été montrée (pendant un boost)", value: buyersText(period.exposure.buyersExposed), hint: null },
    );
  }
  lines.push(
    { key: "opens", label: "Ouvertures de votre annonce", value: eventsText(period.opens.total, "ouvertures"), hint: null },
    { key: "openers", label: "Acheteurs qui ont ouvert votre annonce", value: buyersText(period.opens.uniqueBuyers), hint: null },
  );
  if (period.opens.attributedToBoost && period.opens.organic) {
    lines.push(
      { key: "openers-boost", label: "dont après avoir vu votre annonce sponsorisée", value: buyersText(period.opens.attributedToBoost.uniqueBuyers), hint: "attribuées au boost" },
      { key: "openers-organic", label: "dont sans l'avoir vue sponsorisée", value: buyersText(period.opens.organic.uniqueBuyers), hint: "organiques" },
    );
  }
  lines.push({ key: "contacts", label: "Acheteurs qui vous ont contacté", value: buyersText(period.contacts.uniqueBuyers), hint: null });
  if (period.contacts.attributedToBoost && period.contacts.organic) {
    lines.push(
      { key: "contacts-boost", label: "dont après avoir vu votre annonce sponsorisée", value: buyersText(period.contacts.attributedToBoost.uniqueBuyers), hint: "attribués au boost" },
      { key: "contacts-organic", label: "dont sans l'avoir vue sponsorisée", value: buyersText(period.contacts.organic.uniqueBuyers), hint: "organiques" },
    );
  }
  if (period.ratios.openRate) {
    lines.push({ key: "open-rate", label: "Part des acheteurs à qui l'annonce a été montrée qui l'ont ouverte", value: ratioText(period.ratios.openRate), hint: "acheteurs qui ont ouvert parmi les acheteurs servis / acheteurs servis" });
  }
  lines.push({ key: "contact-rate", label: "Part des acheteurs qui ont ouvert qui vous ont contacté", value: ratioText(period.ratios.contactRate), hint: "acheteurs qui ont contacté parmi ceux qui ont ouvert / acheteurs qui ont ouvert" });
  return { period: period.period, title: PERIOD_LABELS[period.period], lines };
}

const BOOST_STATUS_LABEL: Readonly<Record<BoostStatsEntry["status"], string>> = Object.freeze({
  effective: "en cours",
  expired: "terminé",
  cancelled: "annulé",
  scheduled: "programmé",
});

export interface BoostStatsView {
  key: string;
  title: string;
  lines: StatLine[];
  /** Phrase à la place des lignes pour un boost qui n'a pas encore commencé. */
  note: string | null;
}

/** « 3 jours · terminé » ; lignes en mots simples. Un boost qui n'a pas commencé n'a aucune ligne (rien n'est mesurable). */
export function boostStatsView(boost: BoostStatsEntry, durationText: string): BoostStatsView {
  const lines: StatLine[] = [];
  if (boost.exposure) {
    lines.push(
      { key: "exposed", label: "Acheteurs à qui l'annonce a été montrée", value: buyersText(boost.exposure.buyersExposed), hint: null },
      { key: "sponsored", label: "dont montrée sponsorisée", value: buyersText(boost.exposure.buyersSponsored), hint: null },
      { key: "served", label: "Apparitions dans les résultats", value: eventsText(boost.exposure.servings, "apparitions"), hint: null },
    );
  }
  if (boost.attributed) {
    lines.push(
      { key: "opens", label: "Acheteurs qui ont ouvert l'annonce après l'avoir vue sponsorisée", value: buyersText(boost.attributed.uniqueOpeners), hint: "ouvertures attribuées à ce boost" },
      { key: "contacts", label: "Acheteurs qui vous ont contacté après l'avoir vue sponsorisée", value: buyersText(boost.attributed.uniqueContacts), hint: "contacts attribués à ce boost" },
    );
  }
  if (boost.ratios.openRate) {
    lines.push({ key: "open-rate", label: "Part des acheteurs servis sponsorisés qui ont ouvert", value: ratioText(boost.ratios.openRate), hint: "acheteurs qui ont ouvert (attribué à ce boost) / acheteurs servis sponsorisés" });
  }
  if (boost.ratios.contactRate) {
    lines.push({ key: "contact-rate", label: "Part des acheteurs servis sponsorisés qui vous ont contacté", value: ratioText(boost.ratios.contactRate), hint: "acheteurs qui ont contacté (attribué à ce boost) / acheteurs servis sponsorisés" });
  }
  return {
    key: boost.boostId,
    title: `Boost de ${durationText} · ${BOOST_STATUS_LABEL[boost.status]}`,
    lines,
    note: lines.length === 0 ? BOOST_NOT_STARTED_SENTENCE : null,
  };
}

export interface OfferStatsView {
  periods: PeriodView[];
  /** Vrai quand les ouvertures, les contacts et les apparitions de tout l'historique sont tous « moins de 5 » (zéro compris : on ne sait pas dire « rien »). */
  fewActivity: boolean;
  /** Vrai quand l'annonce n'a aucun boost : aucune section « Par boost » ; une phrase dit que tout est organique. */
  noBoost: boolean;
  noBoostText: string | null;
  notes: string[];
}

export function offerStatsView(stats: OfferStats): OfferStatsView {
  const all = stats.periods.find((period) => period.period === "all");
  const below = (count: StatCount) => count.kind === "below";
  const noBoost = stats.boosts.length === 0;
  const fewActivity = all !== undefined && below(all.opens.total) && below(all.contacts.uniqueBuyers) && (all.exposure === null || below(all.exposure.servings));
  return {
    periods: stats.periods.map((period) => periodView(period)),
    fewActivity,
    noBoost,
    noBoostText: noBoost ? NO_BOOST_SENTENCE : null,
    // Sans boost, ni attribution ni exposition à expliquer.
    notes: noBoost ? [OPEN_SENTENCE, PRIVACY_SENTENCE] : [ATTRIBUTION_SENTENCE, EXPOSURE_SENTENCE, OPEN_SENTENCE, PRIVACY_SENTENCE],
  };
}
