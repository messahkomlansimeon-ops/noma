/**
 * Présentation des correspondances (écrans « résultats d'un besoin » côté acheteur et « acheteurs intéressés » côté
 * vendeur) : libellés et règles en fonctions PURES, sans React, partagés par les écrans et testés isolément.
 *
 * Règles de présentation :
 *  - jamais d'identifiant, de téléphone ni de nom de l'autre partie : les lignes ne portent qu'une clé de liste (`key`)
 *    qui n'est pas un texte à afficher, et des textes bâtis à partir de la fiche produit épurée ;
 *  - les indicateurs (prix, disponibilité, confiance) sont expliqués en mots simples, jamais en codes bruts ni en scores internes ;
 *  - « Sponsorisé » n'apparaît que si `sponsored` est vrai, avec la mention fixe qui rappelle que la mise en avant ne joue
 *    que parmi des résultats déjà pertinents.
 */

import type { DemandStatus, MatchIndicators, MatchProduct, OfferStatus, StoredMatch } from "./api";
import { formatAmount, formatMoney } from "./catalog-view";

export type IndicatorTone = "good" | "neutral" | "warn" | "muted";

export interface IndicatorView {
  key: "price" | "availability" | "confidence";
  /** Phrase courte en mots simples. */
  label: string;
  /** Précision facultative (écart au marché, ancienneté de la confirmation…). */
  detail: string | null;
  tone: IndicatorTone;
}

export const SPONSORED_BADGE_LABEL = "Sponsorisé";
export const SPONSORED_NOTICE = "Mis en avant par le vendeur, parmi des résultats déjà pertinents";

export const PROCESSING_MESSAGE = "Recherche en cours…";
export const PROCESSING_HINT = "Nous comparons votre besoin aux annonces. Appuyez sur Actualiser dans quelques secondes.";
export const EMPTY_BUYER_MESSAGE = "Aucune offre ne correspond pour le moment.";
export const EMPTY_BUYER_HINT = "Revenez plus tard : de nouvelles annonces peuvent être publiées, ou précisez votre besoin.";
export const EMPTY_SELLER_MESSAGE = "Aucun besoin d'acheteur ne correspond pour le moment.";
export const EMPTY_SELLER_HINT = "Les besoins qui correspondent à votre annonce apparaîtront ici.";
/** La liste du vendeur compte des BESOINS : un même acheteur peut en avoir plusieurs (on ne surestime jamais le nombre d'acheteurs). */
export const NEEDS_NOTE = "Chaque ligne est un besoin : un même acheteur peut en avoir plusieurs, donc il y a peut-être moins d'acheteurs que de besoins.";
export const TRUNCATED_NOTE = "Plus de 200 correspondances existent : seules les meilleures sont affichées.";

/** « 2 h », « 5 jours » : ancienneté entière d'une confirmation, en heures (valeur du serveur). */
export function confirmationAgeText(hours: number | null): string | null {
  if (hours === null || !Number.isFinite(hours) || hours < 0) return null;
  if (hours < 1) return "moins d'une heure";
  if (hours < 48) return `${Math.floor(hours)} h`;
  return `${Math.floor(hours / 24)} jours`;
}

function deltaText(deltaPercent: number | null): string | null {
  if (deltaPercent === null || !Number.isFinite(deltaPercent)) return null;
  if (deltaPercent === 0) return "Pile au prix médian des annonces comparables";
  const direction = deltaPercent < 0 ? "en dessous" : "au-dessus";
  return `${Math.abs(Math.round(deltaPercent))} % ${direction} du prix médian des annonces comparables`;
}

/** Prix de l'offre par rapport au marché observé. Absent dans le sens offre (le vendeur ne compare pas son propre prix). */
export function priceIndicatorView(price: MatchIndicators["price"]): IndicatorView | null {
  if (price === null) return null;
  switch (price.position) {
    case "below_market":
      return { key: "price", label: "Prix en dessous du marché", detail: deltaText(price.deltaPercent), tone: "good" };
    case "in_market":
      return { key: "price", label: "Prix dans la moyenne du marché", detail: deltaText(price.deltaPercent), tone: "neutral" };
    case "above_market":
      return { key: "price", label: "Prix au-dessus du marché", detail: deltaText(price.deltaPercent), tone: "warn" };
    default:
      if (price.factors.includes("price_missing")) {
        return { key: "price", label: "Prix non renseigné par le vendeur", detail: null, tone: "muted" };
      }
      return {
        key: "price",
        label: "Marché insuffisant pour comparer le prix",
        detail:
          price.sampleSize > 0
            ? `Seulement ${price.sampleSize} annonce${price.sampleSize > 1 ? "s" : ""} comparable${price.sampleSize > 1 ? "s" : ""}`
            : "Aucune annonce comparable",
        tone: "muted",
      };
  }
}

export function availabilityIndicatorView(availability: MatchIndicators["availability"]): IndicatorView | null {
  if (availability === null) return null;
  const age = confirmationAgeText(availability.confirmedAgeHours);
  const quantityShort = availability.factors.includes("insufficient_quantity")
    ? "Quantité proposée inférieure à celle demandée"
    : null;
  const confirmedDetail = age ? `Confirmée il y a ${age}` : null;
  const detail = (base: string | null) => [base, quantityShort].filter(Boolean).join(". ") || null;
  switch (availability.level) {
    case "confirmed_recent":
      return { key: "availability", label: "Disponibilité confirmée récemment", detail: detail(confirmedDetail), tone: "good" };
    case "confirmed":
      return { key: "availability", label: "Disponibilité confirmée", detail: detail(confirmedDetail), tone: "neutral" };
    case "unconfirmed":
      return {
        key: "availability",
        label: "Disponibilité à reconfirmer auprès du vendeur",
        detail: detail(age ? `Dernière confirmation il y a ${age}` : "Jamais confirmée"),
        tone: "warn",
      };
    case "reserved":
      return { key: "availability", label: "Offre réservée", detail: detail(null), tone: "warn" };
    case "unavailable":
      return { key: "availability", label: "Offre indisponible", detail: detail(null), tone: "warn" };
    default:
      return { key: "availability", label: "Disponibilité non renseignée", detail: detail(null), tone: "muted" };
  }
}

const ACCOUNT_AGE_TEXT = {
  lt_7d: "compte créé il y a moins de 7 jours",
  "7d_30d": "compte créé il y a 7 à 30 jours",
  gte_30d: "compte créé il y a plus de 30 jours",
} as const;

/** Confiance dans l'annonce et son auteur (ancienneté du compte par tranche, téléphone vérifié) : jamais une date ni un numéro. */
export function confidenceIndicatorView(confidence: MatchIndicators["confidence"]): IndicatorView {
  const phone = confidence.factors.includes("phone_verified")
    ? "téléphone vérifié"
    : confidence.factors.includes("phone_not_verified")
      ? "téléphone non vérifié"
      : null;
  const detail = [ACCOUNT_AGE_TEXT[confidence.accountAgeBand], phone].filter(Boolean).join(", ");
  const text = `${detail.charAt(0).toUpperCase()}${detail.slice(1)}`;
  switch (confidence.level) {
    case "high":
      return { key: "confidence", label: "Confiance élevée", detail: text, tone: "good" };
    case "medium":
      return { key: "confidence", label: "Confiance moyenne", detail: text, tone: "neutral" };
    default:
      return { key: "confidence", label: "Confiance faible", detail: text, tone: "warn" };
  }
}

/** Les indicateurs applicables dans l'ordre d'affichage : prix, disponibilité, confiance. */
export function indicatorViews(indicators: MatchIndicators): IndicatorView[] {
  return [
    priceIndicatorView(indicators.price),
    availabilityIndicatorView(indicators.availability),
    confidenceIndicatorView(indicators.confidence),
  ].filter((view): view is IndicatorView => view !== null);
}

/** Pourcentage de compatibilité entier (0 à 100), ou null si le score est inconnu. */
export function compatibilityPercent(score: number | null): number | null {
  if (score === null || !Number.isFinite(score)) return null;
  return Math.min(100, Math.max(0, Math.round(score)));
}

export function compatibilityText(score: number | null): string {
  const percent = compatibilityPercent(score);
  return percent === null ? "Compatibilité à confirmer" : `Compatibilité ${percent} %`;
}

/** Titre d'un produit de correspondance : marque, modèle, variante ; à défaut la catégorie. */
export function productTitle(product: Pick<MatchProduct, "brand" | "model" | "variant" | "category">, fallback: string): string {
  const named = [product.brand, product.model, product.variant].filter((part): part is string => Boolean(part && part.trim()));
  if (named.length > 0) return named.join(" ");
  return product.category?.trim() || fallback;
}

function subtitleOf(product: Pick<MatchProduct, "condition" | "location">): string | null {
  return [product.condition, product.location].filter((part): part is string => Boolean(part && part.trim())).join(" · ") || null;
}

/** Ligne d'une offre dans les résultats d'un besoin (côté acheteur). */
export interface BuyerMatchRow {
  /** Clé de liste React : jamais affichée. */
  key: string;
  title: string;
  subtitle: string | null;
  priceText: string;
  compatibility: string;
  compatibilityPercent: number | null;
  indicators: IndicatorView[];
  sponsored: boolean;
  /** « Sponsorisé » si et seulement si l'élément est sponsorisé. */
  sponsoredBadge: string | null;
  sponsoredNotice: string | null;
}

export function buyerMatchRow(item: StoredMatch): BuyerMatchRow {
  return {
    key: item.candidateId,
    title: productTitle(item.candidate, "Offre"),
    subtitle: subtitleOf(item.candidate),
    priceText: formatMoney(item.candidate.price) ?? "Prix non renseigné",
    compatibility: compatibilityText(item.score),
    compatibilityPercent: compatibilityPercent(item.score),
    indicators: indicatorViews(item.indicators),
    sponsored: item.sponsored === true,
    sponsoredBadge: item.sponsored === true ? SPONSORED_BADGE_LABEL : null,
    sponsoredNotice: item.sponsored === true ? SPONSORED_NOTICE : null,
  };
}

/** Ligne d'un besoin dans « Acheteurs intéressés » (côté vendeur) : AUCUNE identité d'acheteur, ni téléphone, ni compte. */
export interface InterestedBuyerRow {
  /** Clé de liste React : jamais affichée. */
  key: string;
  title: string;
  subtitle: string | null;
  budgetText: string;
  compatibility: string;
  compatibilityPercent: number | null;
  confidence: IndicatorView;
}

export function interestedBuyerRow(item: StoredMatch): InterestedBuyerRow {
  const budget = item.candidate.budget;
  return {
    key: item.candidateId,
    title: productTitle(item.candidate, "Besoin"),
    subtitle: subtitleOf(item.candidate),
    budgetText: budget ? `Budget : jusqu'à ${formatAmount(budget.amount)} ${budget.currency === "XOF" ? "FCFA" : budget.currency}` : "Budget non précisé",
    compatibility: compatibilityText(item.score),
    compatibilityPercent: compatibilityPercent(item.score),
    confidence: confidenceIndicatorView(item.indicators.confidence),
  };
}

/** Ajoute une page de résultats à la liste affichée, sans doublon (clé : candidateId) ; l'ordre reçu est conservé. */
export function mergeMatchPages(current: readonly StoredMatch[], next: readonly StoredMatch[]): StoredMatch[] {
  const seen = new Set(current.map((item) => item.candidateId));
  const merged = [...current];
  for (const item of next) {
    if (seen.has(item.candidateId)) continue;
    seen.add(item.candidateId);
    merged.push(item);
  }
  return merged;
}

/**
 * Génération d'un chargement : « Actualiser » ouvre une nouvelle génération, et toute réponse d'une génération antérieure
 * (un « Voir plus » parti avant) est ignorée : la page 2 d'un instant T0 n'est jamais fusionnée avec la page 1 de T1.
 */
export interface GenerationGuard {
  /** Ouvre une nouvelle génération et renvoie son jeton (les jetons précédents ne sont plus à jour). */
  begin(): number;
  isCurrent(token: number): boolean;
}

export function createGenerationGuard(): GenerationGuard {
  let generation = 0;
  return {
    begin: () => {
      generation += 1;
      return generation;
    },
    isCurrent: (token) => token === generation,
  };
}

/** Fusionne la page suivante SEULEMENT si le jeton est encore celui de la génération courante ; sinon `null` (réponse périmée ignorée). */
export function mergeIfCurrent(
  guard: GenerationGuard,
  token: number,
  current: readonly StoredMatch[],
  next: readonly StoredMatch[],
): StoredMatch[] | null {
  return guard.isCurrent(token) ? mergeMatchPages(current, next) : null;
}

export type ResultsState = "loading" | "processing" | "empty" | "results";

/** État affiché : chargement, « Recherche en cours… » (rien à montrer encore), vide, ou liste (avec bandeau si le traitement continue). */
export function resultsState(input: { loaded: boolean; itemCount: number; processing: boolean }): ResultsState {
  if (!input.loaded) return "loading";
  if (input.itemCount > 0) return "results";
  return input.processing ? "processing" : "empty";
}

/** Texte de remplacement quand le besoin n'est pas actif (le serveur ne sert des résultats que pour un besoin actif). */
export function demandNotActiveMessage(status: DemandStatus): string | null {
  switch (status) {
    case "active":
      return null;
    case "draft":
      return "Ce besoin est un brouillon. Activez-le pour voir les offres qui correspondent.";
    case "satisfied":
      return "Ce besoin est marqué satisfait. Réactivez-le pour revoir les offres.";
    default:
      return "Ce besoin est archivé : il n'y a plus de résultats.";
  }
}

/** Texte de remplacement quand l'annonce n'est pas en ligne (les acheteurs intéressés ne sont servis que pour une offre publiée). */
export function offerNotPublishedMessage(status: OfferStatus): string | null {
  switch (status) {
    case "published":
      return null;
    case "draft":
      return "Cette annonce est un brouillon. Publiez-la pour voir les acheteurs intéressés.";
    case "paused":
      return "Cette annonce est en pause. Remettez-la en ligne pour voir les acheteurs intéressés.";
    default:
      return "Cette annonce est archivée : il n'y a plus d'acheteurs à afficher.";
  }
}

/**
 * Nombre de BESOINS d'acheteurs qui correspondent à l'annonce (jamais un nombre d'acheteurs : un acheteur peut avoir plusieurs
 * besoins et l'écran sert à vendre un boost payant : on ne surestime pas). « Au moins … » tant qu'il reste des pages.
 */
export function matchingNeedsLabel(count: number, hasMore: boolean): string {
  if (count === 0) return "Aucun besoin d'acheteur ne correspond pour le moment";
  const base = count === 1 ? "1 besoin d'acheteur correspond à votre annonce" : `${count} besoins d'acheteurs correspondent à votre annonce`;
  return hasMore ? `Au moins ${base}` : base;
}

/** « 4 offres correspondent à votre besoin » ; « Au moins … » tant qu'il reste des pages. */
export function buyerResultsLabel(count: number, hasMore: boolean): string {
  if (count === 0) return "Aucune offre pour le moment";
  const base = `${count} offre${count > 1 ? "s" : ""} correspond${count > 1 ? "ent" : ""} à votre besoin`;
  return hasMore ? `Au moins ${base}` : base;
}
