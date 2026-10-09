/**
 * Présentation de la RECHERCHE ACTIVE payante d'un besoin (lot RA1) : libellés et règles en fonctions PURES, sans React, testées isolément.
 *
 * Règles : tout en mots simples ; le prix est PROVISOIRE et l'écran le dit ; l'option se paie avec les crédits PAYÉS seulement ; aucun renouvellement automatique ; aucun remboursement
 * automatique. Un besoin « satisfait » SUSPEND l'option (la période continue de courir, la réactivation la reprend), un besoin archivé l'ARRÊTE sans remboursement : les deux sont DITS AVANT
 * l'achat. Jamais un identifiant ni un code à l'écran. Voir RECHERCHE-ACTIVE.md.
 */

import type { ActiveSearchBlockedReason, ActiveSearchPurchaseResult, ActiveSearchState } from "./active-search-api";
import { ApiError } from "./api";
import { formatDateFr, formatDateTimeFr, formatFcfa } from "./wallet-view";

/**
 * Lecture de l'état refusée par un 404 : le besoin n'est pas un besoin dont l'acheteur peut acheter l'option (en pratique le besoin PORTEUR d'une mission d'achat en volume, qu'il ne voit pas
 * dans « Mes besoins » : le serveur répond comme pour un besoin d'autrui). La carte ne s'affiche alors PAS (ni message d'erreur, ni bouton « Réessayer » : il n'y a rien à réessayer).
 */
export function hidesCardOnLoadFailure(failure: unknown): boolean {
  return failure instanceof ApiError && failure.status === 404;
}

export const ACTIVE_SEARCH_TITLE = "Recherche active";
export const ACTIVE_SEARCH_LOADING = "Chargement de la recherche active…";
export const ACTIVE_SEARCH_PRICE_NOTICE = "Prix provisoire, en attente d'une décision. Le prix que vous payez est conservé pour chaque achat.";
export const ACTIVE_SEARCH_INTRO = "Soyez prévenu plus vite quand une annonce d'un autre site correspond à ce besoin, et suivez-le plus longtemps.";

/** Ce que l'option apporte (listes fermées, textes fixes). */
export const ACTIVE_SEARCH_BENEFITS: readonly string[] = Object.freeze([
  "Vous êtes prévenu quand une NOUVELLE annonce d'un autre site correspond à votre besoin (les annonces déjà présentes à l'activation ne vous sont pas envoyées).",
  "Les autres sites sont consultés jusqu'à toutes les heures au lieu de toutes les 6 heures, selon la place disponible et dans la limite de ce que chaque site autorise. La surveillance de ce produit est partagée : les autres acheteurs du même produit en profitent aussi.",
  "Le suivi de ce besoin peut durer jusqu'à 180 jours au lieu de 90.",
]);

/** Les règles, dites AVANT l'achat. */
export const ACTIVE_SEARCH_RULES: readonly string[] = Object.freeze([
  "Elle se paie avec vos crédits, pas avec vos crédits promotionnels.",
  "Aucun renouvellement automatique : vous êtes prévenu 3 jours avant la fin, et vous pouvez la prolonger.",
  "Les places de consultation rapide sont limitées, et chaque compte peut suivre au plus deux produits différents. Si aucune place n'est libre, vous êtes quand même prévenu des nouvelles annonces, mais les autres sites restent consultés à leur rythme ordinaire : la consultation rapide démarre dès qu'une place se libère, sans remboursement.",
  "Si le besoin est marqué satisfait, l'option est suspendue : rien n'est notifié, mais la période continue de courir, sans prolongation ni remboursement, et elle reprend si vous réactivez le besoin.",
  "Si le besoin est archivé, l'option s'arrête sans remboursement.",
  "Aucun remboursement automatique.",
]);

export const EXTERNAL_NOTIFICATION_NOTE = "Les notifications des autres sites vous mènent à la page de votre besoin, jamais directement à l'annonce d'un autre site.";

export const ACTIVE_SEARCH_LABELS = Object.freeze({
  recharge: "Recharger mon porte-monnaie",
  confirm: "Confirmer l'achat",
  confirming: "Achat en cours…",
  cancel: "Annuler",
  working: "…",
});

export type PurchaseState =
  | { kind: "none" }
  | { kind: "blocked"; reason: ActiveSearchBlockedReason; text: string }
  | { kind: "insufficient"; balanceXof: number; missingXof: number; text: string; detail: string }
  | { kind: "ready"; priceXof: number; balanceXof: number; balanceAfterXof: number; endsAtText: string };

const BLOCKED_TEXT: Readonly<Record<ActiveSearchBlockedReason, string>> = Object.freeze({
  demand_not_active: "La recherche active n'est disponible que pour un besoin actif.",
  no_product_key: "Option indisponible pour ce besoin : il faut au moins une catégorie, une marque et un modèle.",
  unavailable: "La recherche active n'est pas encore disponible : aucune annonce d'un autre site n'est collectée pour le moment.",
  user_cap: "Vous suivez déjà deux produits différents en recherche active, c'est le maximum par compte : attendez la fin de l'une des deux options pour en démarrer ou prolonger une autre.",
  capacity: "La collecte accélérée est complète pour le moment : réessayez plus tard.",
  max_horizon: "La recherche active ne peut pas dépasser 180 jours à partir d'aujourd'hui : vous pourrez la prolonger plus tard.",
});

/** Option en vigueur sans place de consultation rapide (lot RA1-ter) : ce qui est garanti, et ce qui attend. */
export const ACCELERATION_PENDING_NOTE = "La consultation rapide de ce produit attend une place. Vous êtes prévenu des nouvelles annonces d'autres sites comme prévu ; les autres sites restent consultés à leur rythme ordinaire jusqu'à ce qu'une place se libère, puis la consultation rapide démarre toute seule.";

/** Durée en mots : « 30 jours ». */
function daysText(days: number): string {
  return days === 1 ? "1 jour" : `${days} jours`;
}

/** « 2 000 FCFA pour 30 jours ». */
export function activeSearchPriceText(state: Pick<ActiveSearchState, "priceXof" | "durationDays">): string {
  return `${formatFcfa(state.priceXof)} pour ${daysText(state.durationDays)}`;
}

/** L'achat est possible seulement si le besoin est actif, la limite de 180 jours n'est pas atteinte et le SOLDE DE CRÉDITS PAYÉS couvre le prix. */
export function purchaseState(state: ActiveSearchState | null): PurchaseState {
  if (state === null) return { kind: "none" };
  if (!state.canPurchase || state.blockedReason !== null || state.nextEndsAt === null) {
    const reason = state.blockedReason ?? "demand_not_active";
    return { kind: "blocked", reason, text: BLOCKED_TEXT[reason] };
  }
  if (!Number.isSafeInteger(state.priceXof) || state.priceXof <= 0 || !Number.isSafeInteger(state.balanceXof) || state.balanceXof < 0) return { kind: "none" };
  if (state.balanceXof < state.priceXof) {
    const missingXof = state.priceXof - state.balanceXof;
    return {
      kind: "insufficient",
      balanceXof: state.balanceXof,
      missingXof,
      // Pas le mot « Solde » : la page d'un besoin ne montre jamais le vocabulaire du porte-monnaie vendeur (« Solde », « Porte-monnaie », « Achat de boost ») ; l'acheteur lit ses CRÉDITS PAYÉS.
      text: `Crédits payés insuffisants (${formatFcfa(state.balanceXof)})`,
      detail: `Il vous manque ${formatFcfa(missingXof)}. Seuls vos crédits payés règlent la recherche active, pas les crédits promotionnels.`,
    };
  }
  return { kind: "ready", priceXof: state.priceXof, balanceXof: state.balanceXof, balanceAfterXof: state.balanceXof - state.priceXof, endsAtText: formatDateTimeFr(state.nextEndsAt) };
}

export function canPurchase(state: PurchaseState, pending: boolean): boolean {
  return state.kind === "ready" && !pending;
}

export interface ActiveSearchView {
  tone: "active" | "off" | "paused" | "closed" | "unavailable";
  /** « Recherche active jusqu'au 12/11/2026 » ou « Recherche active : désactivée ». */
  headline: string;
  /** Précision : jours restants, avis d'échéance ou ce que l'option apporte. */
  detail: string;
  /** Libellé du bouton : « Activer — 2 000 FCFA pour 30 jours » ou « Prolonger de 30 jours — 2 000 FCFA ». */
  buttonLabel: string;
  isExtension: boolean;
  /** Un besoin qui n'est plus actif, ou pour lequel l'option est indisponible, n'a pas d'achat à proposer. */
  applicable: boolean;
}

export function activeSearchView(state: ActiveSearchState): ActiveSearchView {
  const price = activeSearchPriceText(state);
  if (state.suspended && state.endsAt !== null) {
    return {
      tone: "paused",
      headline: `Recherche active suspendue jusqu'au ${formatDateFr(state.endsAt)}`,
      detail: "Ce besoin est marqué satisfait : rien n'est notifié tant qu'il ne redevient pas actif. La période continue de courir ; si vous réactivez le besoin, la recherche active reprend.",
      buttonLabel: `Activer — ${price}`,
      isExtension: false,
      applicable: false,
    };
  }
  if (state.demandStatus !== "active") {
    return {
      tone: "closed",
      headline: "Recherche active arrêtée",
      detail: "La recherche active ne s'applique qu'à un besoin actif.",
      buttonLabel: `Activer — ${price}`,
      isExtension: false,
      applicable: false,
    };
  }
  if (state.active && state.endsAt !== null) {
    const base = state.accelerationPending ? `Vous êtes prévenu des nouvelles annonces d'autres sites. ${ACCELERATION_PENDING_NOTE}` : "Vous êtes prévenu des nouvelles annonces d'autres sites.";
    const tail = state.expiringSoon
      ? " Elle se termine bientôt : prolongez-la pour continuer à être prévenu."
      : state.remainingDays === null ? "" : ` Il reste ${daysText(state.remainingDays)}.`;
    return {
      tone: "active",
      headline: `Recherche active jusqu'au ${formatDateFr(state.endsAt)}`,
      detail: `${base}${tail}`,
      buttonLabel: `Prolonger de ${daysText(state.durationDays)} — ${formatFcfa(state.priceXof)}`,
      isExtension: true,
      applicable: true,
    };
  }
  // Aucune option en vigueur et l'achat est impossible parce que le besoin ou la collecte ne le permet pas (pas de produit identifié, aucune annonce externe collectée) : on le dit, sans bouton.
  if (state.blockedReason === "no_product_key" || state.blockedReason === "unavailable") {
    return {
      tone: "unavailable",
      headline: state.blockedReason === "no_product_key" ? "Option indisponible pour ce besoin" : "Recherche active : pas encore disponible",
      detail: BLOCKED_TEXT[state.blockedReason],
      buttonLabel: `Activer — ${price}`,
      isExtension: false,
      applicable: false,
    };
  }
  return {
    tone: "off",
    headline: "Recherche active : désactivée",
    detail: ACTIVE_SEARCH_INTRO,
    buttonLabel: `Activer — ${price}`,
    isExtension: false,
    applicable: true,
  };
}

/** Texte de confirmation, avant l'achat : le montant, la nouvelle fin et le solde après. */
export function purchaseConfirmationText(state: Extract<PurchaseState, { kind: "ready" }>, isExtension: boolean): string {
  return `${isExtension ? "Prolonger la recherche active" : "Activer la recherche active"} : ${formatFcfa(state.priceXof)} seront débités de vos crédits payés, jusqu'au ${state.endsAtText}. Il vous restera ${formatFcfa(state.balanceAfterXof)}.`;
}

/** Message après un achat réussi (ou un achat déjà enregistré : aucun second débit). */
export function purchaseDoneText(result: Pick<ActiveSearchPurchaseResult, "reused" | "kind" | "endsAt">): string {
  const until = formatDateFr(result.endsAt);
  if (result.reused) return `Cet achat était déjà enregistré : vous n'avez pas été débité une seconde fois. Recherche active jusqu'au ${until}.`;
  return result.kind === "extension" ? `Recherche active prolongée jusqu'au ${until}.` : `Recherche active activée jusqu'au ${until}.`;
}

// ───────────── notifications ─────────────

export const EXTERNAL_MATCH_BADGE = "Autre site";
export const EXPIRING_BADGE = "Recherche active";
export const EXPIRING_TITLE_PREFIX = "Votre recherche active se termine le";
export const EXPIRING_SUBTITLE = "Prolongez-la pour continuer à être prévenu des annonces d'autres sites.";

/** Sous-titre d'une annonce d'un autre site : le prix et le nom de la source (« 150 000 FCFA · Annonces Démo A, autre site »). */
export function externalMatchSubtitle(priceText: string | null, sourceName: string | undefined): string {
  const source = sourceName && sourceName.trim() !== "" ? `${sourceName.trim()}, ${EXTERNAL_MATCH_BADGE.toLowerCase()}` : EXTERNAL_MATCH_BADGE;
  return priceText === null ? source : `${priceText} · ${source}`;
}

export function expiringTitle(endsAt: string | undefined): string {
  return endsAt === undefined ? "Votre recherche active se termine bientôt" : `${EXPIRING_TITLE_PREFIX} ${formatDateFr(endsAt)}`;
}

// ───────────── suivi ─────────────

/** Texte « Déjà au maximum » du suivi : 90 jours, ou 180 jours PENDANT la recherche active (le plafond vient du serveur). */
export function trackingMaximumText(tracking: { maxUntil: string; readAt: string }): string {
  const days = Math.round((Date.parse(tracking.maxUntil) - Date.parse(tracking.readAt)) / 86_400_000);
  return `Déjà au maximum : ${Number.isFinite(days) && days > 0 ? days : 90} jours à partir d'aujourd'hui.`;
}

// ───────────── administration ─────────────

export const ADMIN_ACTIVE_SEARCH_TITLE = "Recherche active";
export const ADMIN_ACTIVE_SEARCH_NOTE = "Prix provisoire : 2 000 FCFA pour 30 jours. Les remboursements se font par la commande d'administration `active-search:refund`.";
