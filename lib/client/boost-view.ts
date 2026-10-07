/**
 * Présentation du devis de boost (écran « Booster cette annonce », côté vendeur) : libellés et règles en fonctions
 * PURES, sans React, testées isolément.
 *
 * Règles de présentation :
 *  - le montant est affiché en FCFA, les facteurs du prix sont expliqués en clair (concurrence, acheteurs compatibles, rareté
 *    des places, durée), jamais en millièmes ni en codes ;
 *  - un devis INDISPONIBLE affiche son motif en clair ; un motif inconnu donne un texte générique, jamais le code brut ;
 *  - un devis est valable un court moment (compte à rebours) ; il n'engage à rien et ne réserve aucune place ;
 *  - depuis le lot P2 l'achat existe : sa logique (« Acheter » actif ou non, confirmation, clé d'idempotence) et le compte à
 *    rebours ANCRÉ sur une horloge monotone (aucune horloge murale) sont dans `wallet-view.ts`.
 */

import { BOOST_DURATION_CODES, type BoostDurationCode, type BoostQuote, type StatCount, type OfferRecord } from "./api";
import { formatAmount } from "./catalog-view";
import { countText } from "./metrics-view";

export const BOOST_DURATIONS: readonly { code: BoostDurationCode; label: string }[] = [
  { code: "24h", label: "24 h" },
  { code: "3d", label: "3 jours" },
  { code: "7d", label: "7 jours" },
];

export const BOOST_INTRO =
  "Un boost fait monter votre annonce dans les résultats des acheteurs, parmi des offres déjà pertinentes. " +
  "Ce n'est pas une garantie de vente et le prix ci-dessous n'engage à rien tant que vous n'achetez pas.";

export function durationLabel(code: BoostDurationCode): string {
  return BOOST_DURATIONS.find((duration) => duration.code === code)?.label ?? "Durée inconnue";
}

/** Vrai pour un code de durée que le serveur accepte. */
export function isBoostDuration(value: unknown): value is BoostDurationCode {
  return typeof value === "string" && (BOOST_DURATION_CODES as readonly string[]).includes(value);
}

export type BoostEligibility = { eligible: true } | { eligible: false; message: string };

/**
 * Le devis n'est proposé que pour une annonce en ligne, disponible, avec catégorie, marque et modèle (les mêmes règles que le
 * serveur, qui reste l'autorité : 409 `offer_not_eligible` / `offer_not_boostable`).
 */
export function boostEligibility(
  offer: Pick<OfferRecord, "status" | "availabilityStatus" | "category" | "brand" | "model">,
): BoostEligibility {
  if (offer.status !== "published") {
    const hint =
      offer.status === "draft"
        ? "Publiez-la d'abord."
        : offer.status === "paused"
          ? "Remettez-la en ligne d'abord."
          : "Une annonce archivée ne peut plus être boostée.";
    return { eligible: false, message: `Le devis n'est proposé que pour une annonce en ligne. ${hint}` };
  }
  if (offer.availabilityStatus === "unavailable") {
    return { eligible: false, message: "Une annonce marquée indisponible ne peut pas être boostée." };
  }
  const missing = [offer.category, offer.brand, offer.model].some((part) => !part || part.trim().length === 0);
  if (missing) {
    return { eligible: false, message: "Pour booster cette annonce, indiquez sa catégorie, sa marque et son modèle." };
  }
  return { eligible: true };
}

export const UNAVAILABLE_REASON_TEXT: Readonly<Record<string, string>> = Object.freeze({
  offer_already_boosted: "Cette annonce est déjà boostée.",
  no_slot_available: "Il n'y a plus de place disponible pour ce produit pour le moment.",
  seller_boost_limit_reached: "Vous avez atteint votre plafond de boosts pour ce produit.",
  no_compatible_buyer: "Aucun acheteur compatible pour le moment : un boost ne serait pas utile.",
  no_visible_effect:
    "Pour le moment, un boost ne ferait monter votre annonce chez aucun acheteur : leurs listes sont trop courtes, ou la place mise en avant y est déjà occupée par un boost acheté plus tôt.",
});

export const UNAVAILABLE_FALLBACK_TEXT = "Le boost n'est pas disponible pour cette annonce pour le moment.";

/** Motif d'indisponibilité en clair ; un code inconnu (ou absent) ne s'affiche jamais tel quel. */
export function unavailableReasonText(code: string | null): string {
  if (code !== null && Object.prototype.hasOwnProperty.call(UNAVAILABLE_REASON_TEXT, code)) return UNAVAILABLE_REASON_TEXT[code];
  return UNAVAILABLE_FALLBACK_TEXT;
}

/** « 2 300 FCFA », ou null pour un devis indisponible. */
export function quoteAmountText(quote: Pick<BoostQuote, "amount" | "currency">): string | null {
  if (quote.amount === null) return null;
  return `${formatAmount(quote.amount)} ${quote.currency === "XOF" ? "FCFA" : quote.currency}`;
}

/** 1,06 → « 1,06 » : virgule décimale, sans zéros inutiles. */
function frenchNumber(value: number): string {
  return String(Math.round(value * 1000) / 1000).replace(".", ",");
}

/** Effet d'un facteur en millièmes sur le prix : « +6 % », « sans effet », « −5 % ». */
export function factorEffectText(milli: number): string {
  if (milli === 1000) return "sans effet sur le prix";
  const percent = (milli - 1000) / 10;
  return percent > 0 ? `+${frenchNumber(percent)} % sur le prix` : `−${frenchNumber(Math.abs(percent))} % sur le prix`;
}

export interface FactorLine {
  key: "competition" | "demand" | "scarcity" | "duration" | "reach";
  title: string;
  text: string;
  effect: string;
}

const plural = (count: number, singular: string, pluralForm: string) => (count > 1 ? pluralForm : singular);

/**
 * « environ 15 acheteurs compatibles », « moins de 5 acheteurs compatibles » : un compte d'acheteurs d'un devis n'est jamais publié exact (lot M1-quater) ; le serveur
 * envoie `{ kind: "below", bound: 5 }` ou `{ kind: "approx", value }`.
 */
function buyersPhrase(count: StatCount, adjective: string): string {
  return `${countText(count)} acheteurs ${adjective}s`;
}

/** Explication du prix en clair : une ligne par facteur ; vide si le devis est indisponible. */
export function explainFactors(quote: Pick<BoostQuote, "factors" | "inputs" | "durationCode">): FactorLine[] {
  if (quote.factors === null) return [];
  const { competingSellers, compatibleBuyers, slotsTotal, slotsUsed } = quote.inputs;
  const durationEffect =
    quote.factors.durationMilli === 1000
      ? "durée de référence (prix de base)"
      : `prix × ${frenchNumber(quote.factors.durationMilli / 1000)} selon la durée`;
  return [
    {
      key: "competition",
      title: "Concurrence",
      text:
        competingSellers === 0
          ? "Aucun autre vendeur ne propose ce produit."
          : `${competingSellers} autre${plural(competingSellers, "", "s")} vendeur${plural(competingSellers, "", "s")} ${plural(competingSellers, "propose", "proposent")} ce produit.`,
      effect: factorEffectText(quote.factors.competitionMilli),
    },
    {
      key: "demand",
      title: "Acheteurs compatibles",
      text: `${upperFirst(buyersPhrase(compatibleBuyers, "compatible"))} avec votre annonce.`,
      effect: factorEffectText(quote.factors.demandMilli),
    },
    {
      key: "scarcity",
      title: "Places disponibles",
      text: `${slotsUsed} place${plural(slotsUsed, "", "s")} de mise en avant utilisée${plural(slotsUsed, "", "s")} sur ${slotsTotal}.`,
      effect: factorEffectText(quote.factors.scarcityMilli),
    },
    {
      key: "duration",
      title: "Durée",
      text: `Mise en avant pendant ${durationLabel(quote.durationCode)}.`,
      effect: durationEffect,
    },
    ...reachLines(quote.inputs.reachableBuyers, quote.inputs.reachTruncated),
  ];
}

/**
 * Portée visible : « Mise en avant visible auprès d'environ X acheteurs » ; « d'environ X acheteurs, ou plus » quand l'estimation a été bornée (des acheteurs n'ont pas
 * été examinés : le nombre est un minimum) ; rien pour un devis ancien (non évalué). Elle n'entre pas dans le prix.
 */
function reachLines(reachableBuyers: StatCount | null, truncated: boolean): FactorLine[] {
  if (reachableBuyers === null) return [];
  // « moins de 5 » : même tronquée, la portée ne dit pas « ou plus » (le compte n'est pas détaillé) ; « environ N » : « ou plus » quand des acheteurs n'ont pas été examinés.
  const text = reachableBuyers.kind === "below"
    ? `Mise en avant visible auprès de ${countText(reachableBuyers)} acheteurs.`
    : truncated
      ? `Mise en avant visible auprès d'${countText(reachableBuyers)} acheteurs, ou plus.`
      : `Mise en avant visible auprès d'${countText(reachableBuyers)} acheteurs.`;
  return [{ key: "reach", title: "Visibilité", text, effect: "n'entre pas dans le prix" }];
}

function upperFirst(text: string): string {
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

/** Durée de validité totale d'un devis (expiresAt − computedAt, en ms), ou null si les dates sont illisibles. */
export function validityWindowMs(quote: Pick<BoostQuote, "computedAt" | "expiresAt">): number | null {
  const start = Date.parse(quote.computedAt);
  const end = Date.parse(quote.expiresAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  return end - start;
}

/** « 14 min 59 s », « 45 s » ; « 0 s » à l'échéance. Arrondi par excès : on ne dit jamais « 0 s » avant l'expiration. */
export function formatCountdown(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return minutes > 0 ? `${minutes} min ${rest} s` : `${rest} s`;
}

/** Date courte d'un devis de l'historique : « 05/10 17:01 » (fuseau local, ou celui qu'on lui donne en test). */
export function formatQuoteTime(iso: string, timeZone?: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "date inconnue";
  const parts = new Intl.DateTimeFormat("fr-FR", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone,
  }).formatToParts(date);
  const part = (type: string) => parts.find((entry) => entry.type === type)?.value ?? "";
  return `${part("day")}/${part("month")} ${part("hour")}:${part("minute")}`;
}

export interface QuoteHistoryRow {
  key: string;
  /** « 3 jours · 2 300 FCFA » ou « 3 jours · indisponible ». */
  title: string;
  /** Motif en clair pour un devis indisponible, « Acheté », « En cours de validité » ou « Expiré ». */
  status: string;
  detail: string;
  tone: "good" | "neutral" | "warn";
}

/**
 * Une ligne de l'historique. `expired` est décidé par l'appelant sur l'horloge ANCRÉE (`historyEntryExpired`, wallet-view.ts) :
 * l'horloge murale de l'appareil n'intervient jamais. `purchased` : le devis a été acheté (un achat de l'annonce porte son
 * identifiant) ; il est alors CONSOMMÉ (« Acheté »), jamais « En cours de validité ».
 */
export function quoteHistoryRow(quote: BoostQuote, expired: boolean, timeZone?: string, purchased = false): QuoteHistoryRow {
  const amount = quoteAmountText(quote);
  const base = {
    key: quote.id,
    title: `${durationLabel(quote.durationCode)} · ${amount ?? "indisponible"}`,
    detail: `Demandé le ${formatQuoteTime(quote.computedAt, timeZone)}`,
  };
  if (purchased) return { ...base, status: "Acheté", tone: "good" };
  if (quote.status === "unavailable") {
    return { ...base, status: unavailableReasonText(quote.unavailableReason), tone: "warn" };
  }
  return expired
    ? { ...base, status: "Expiré", tone: "neutral" }
    : { ...base, status: "En cours de validité", tone: "good" };
}
