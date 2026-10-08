/**
 * Présentation des deux accueils (lot D1) : l'accueil « Explorer » de l'acheteur et le tableau de bord du vendeur. Fonctions PURES, sans React, testées isolément.
 *
 * Règles : tout en mots simples ; aucun identifiant, aucun code d'erreur ni aucun numéro à l'écran ; AUCUNE annonce d'autrui n'est listée (l'acheteur ne voit les annonces que par
 * les correspondances de ses besoins) ; côté vendeur, jamais un compte exact de besoins : « moins de 5 », « environ N » (même arrondi que les statistiques d'une annonce).
 */

import type { BuyerHome, BuyerHomeDemand, BuyerHomeNotification, VendorHome, VendorHomeOffer, VendorOfferStatus } from "./api";
import { OFFER_STATUS_VIEW, artForCategory, formatMoney, type ArtKey, type Tone } from "./catalog-view";
import { countText, frenchDate } from "./metrics-view";
import { summaryTitle } from "./notifications-view";

// ───────────── visiteur sans compte ─────────────

export const LANDING_TITLE = "Dites ce que vous cherchez. noma s'occupe du reste.";
export const LANDING_SUBTITLE = "Les vendeurs d'Abidjan viennent à vous, vous ne parcourez plus des centaines d'annonces.";
export const LANDING_STEPS: readonly { title: string; text: string }[] = Object.freeze([
  { title: "Décrivez votre besoin", text: "Un produit, un budget, un quartier : en une minute." },
  { title: "noma trouve les annonces qui correspondent", text: "Les annonces ne sont visibles que si elles répondent à votre besoin. Vous êtes prévenu des nouvelles." },
  { title: "Contactez le vendeur", text: "Un appel ou un message WhatsApp, directement depuis la fiche de l'annonce." },
]);
export const LOGIN_LABEL = "Se connecter";

// ───────────── acheteur connecté ─────────────

export const BUYER_HOME_TITLE = "Vos besoins";
export const DESCRIBE_NEED_LABEL = "Décrire un besoin";
export const NO_DEMAND_MESSAGE = "Vous n'avez pas encore de besoin actif.";
export const NO_DEMAND_HINT = "Décrivez ce que vous cherchez : les annonces qui correspondent apparaîtront ici.";
export const EXTERNAL_SEARCH_LABEL = "Recherche sur d'autres sites (démonstration)";
export const BUYER_HOME_LOADING = "Chargement de votre accueil…";

/** « Aucune annonce pour le moment », « 1 annonce correspond », « 9 annonces correspondent ». */
export function matchCountText(count: number): string {
  if (count <= 0) return "Aucune annonce pour le moment";
  return count === 1 ? "1 annonce correspond" : `${count} annonces correspondent`;
}

/** « 5 nouvelles notifications » ; « Aucune notification non lue ». */
export function unreadSummaryText(count: number): string {
  if (count <= 0) return "Aucune notification non lue";
  return count === 1 ? "1 notification non lue" : `${count} notifications non lues`;
}

export interface BuyerDemandView {
  id: string;
  title: string;
  art: ArtKey;
  /** « Abidjan · 200 000 FCFA max ». */
  subtitle: string | null;
  matchText: string;
  hasMatches: boolean;
  /** Page des résultats du besoin. */
  href: string;
}

export interface BuyerNotificationView {
  id: string;
  title: string;
  subtitle: string | null;
  unread: boolean;
  href: string;
}

export interface BuyerHomeView {
  demands: BuyerDemandView[];
  /** Besoins actifs qui ne sont pas montrés (au-delà de la liste courte) ; 0 s'ils le sont tous. */
  hiddenDemandCount: number;
  hasDemands: boolean;
  unreadText: string;
  hasUnread: boolean;
  notifications: BuyerNotificationView[];
}

function demandTitle(demand: BuyerHomeDemand): string {
  const product = [demand.brand, demand.model, demand.variant].filter((part): part is string => Boolean(part && part.trim())).join(" ");
  return demand.title.trim() !== "" ? demand.title : product || "Besoin";
}

export function demandView(demand: BuyerHomeDemand): BuyerDemandView {
  const budget = formatMoney(demand.budget);
  const subtitle = [demand.location, budget === null ? null : `${budget} max`].filter((part): part is string => Boolean(part && part.trim())).join(" · ");
  return {
    id: demand.id,
    title: demandTitle(demand),
    art: artForCategory(demand.category),
    subtitle: subtitle === "" ? null : subtitle,
    matchText: matchCountText(demand.matchCount),
    hasMatches: demand.matchCount > 0,
    href: `/besoins/${demand.id}`,
  };
}

export function notificationView(item: BuyerHomeNotification): BuyerNotificationView {
  return {
    id: item.id,
    title:
      item.kind === "new_matches_digest"
        ? summaryTitle(item.count ?? 0)
        : item.kind === "new_message"
          ? `Nouveau message : ${item.title ?? "annonce"}`
          : (item.title ?? "Nouvelle annonce"),
    subtitle: item.kind === "new_matches_digest" || item.kind === "new_message" ? null : formatMoney(item.price),
    unread: item.unread,
    href: item.link,
  };
}

export function buyerHomeView(home: BuyerHome): BuyerHomeView {
  return {
    demands: home.demands.map(demandView),
    hiddenDemandCount: Math.max(0, home.activeDemandCount - home.demands.length),
    hasDemands: home.demands.length > 0,
    unreadText: unreadSummaryText(home.unreadNotifications),
    hasUnread: home.unreadNotifications > 0,
    notifications: home.notifications.map(notificationView),
  };
}

// ───────────── vendeur ─────────────

export const VENDOR_HOME_TITLE = "Votre activité";
export const VENDOR_HOME_LOADING = "Chargement de votre tableau de bord…";
export const PUBLISH_OFFER_LABEL = "Publier une annonce";
export const NO_OFFER_MESSAGE = "Vous n'avez pas encore d'annonce.";
export const NO_BOOST_MESSAGE = "Aucun boost actif.";
export const VENDOR_NEEDS_NOTE = "Pour protéger les acheteurs, les chiffres sont arrondis à 5 près.";
export const WALLET_LINK_LABEL = "Porte-monnaie";

/** « moins de 5 besoins », « environ 10 besoins » : un compte publié vaut toujours 5 ou plus (le pluriel). */
export function needsText(count: VendorHome["needs"]): string {
  return `${countText(count)} besoins`;
}

export interface VendorOfferRow {
  id: string;
  title: string;
  art: ArtKey;
  statusLabel: string;
  statusTone: Tone;
  /** « Apple · iPhone 12 · 128 Go · 165 000 FCFA ». */
  subtitle: string | null;
  /** « environ 10 besoins correspondent » ; vide pour une annonce hors ligne (rien n'est servi). */
  needsText: string | null;
  boostText: string | null;
  /** Page de l'annonce : acheteurs intéressés, statistiques, boost. */
  href: string;
  /** Lot PH1 : photo de couverture de l'annonce ; absente quand elle n'a pas de photo (l'icône reste). */
  coverPhotoId?: string;
}

export interface VendorHomeView {
  tiles: { label: string; value: string; tone: Tone }[];
  needsText: string;
  walletText: string;
  boosts: { offerId: string; title: string; text: string }[];
  hasBoosts: boolean;
  offers: VendorOfferRow[];
  hasOffers: boolean;
}

export const BOOST_UNTIL_PREFIX = "Boost actif jusqu'au ";

function boostUntil(iso: string): string {
  const date = frenchDate(iso);
  return date === null ? "Boost actif" : `${BOOST_UNTIL_PREFIX}${date}`;
}

export function vendorOfferRow(offer: VendorHomeOffer): VendorOfferRow {
  const status = OFFER_STATUS_VIEW[offer.status as VendorOfferStatus];
  const price = formatMoney(offer.price);
  const subtitle = [offer.brand, offer.model, offer.variant, price].filter((part): part is string => Boolean(part && part.trim())).join(" · ");
  return {
    id: offer.id,
    title: offer.title,
    art: artForCategory(offer.category),
    statusLabel: status.label,
    statusTone: status.tone,
    subtitle: subtitle === "" ? null : subtitle,
    needsText: offer.status === "published" ? `${needsText(offer.needs)} correspondent` : null,
    boostText: offer.boostEndsAt === null ? null : boostUntil(offer.boostEndsAt),
    href: `/vendeur/annonces/${offer.id}`,
    ...(offer.coverPhotoId === undefined ? {} : { coverPhotoId: offer.coverPhotoId }),
  };
}

export function vendorHomeView(home: VendorHome): VendorHomeView {
  const titles = new Map(home.offers.map((offer) => [offer.id, offer.title]));
  return {
    tiles: [
      { label: "En ligne", value: String(home.counts.published), tone: "sage" },
      { label: "En pause", value: String(home.counts.paused), tone: "carrot" },
      { label: "Brouillons", value: String(home.counts.draft), tone: "wash" },
    ],
    needsText: `${needsText(home.needs)} d'acheteurs correspondent à vos annonces en ligne`,
    walletText: formatMoney({ amount: home.balance, currency: "XOF" }) ?? "0 FCFA",
    boosts: home.activeBoosts.map((boost) => ({ offerId: boost.offerId, title: titles.get(boost.offerId) ?? "Annonce", text: boostUntil(boost.endsAt) })),
    hasBoosts: home.activeBoosts.length > 0,
    // Les annonces boostées d'abord (l'ordre des autres, du plus récent au plus ancien, est conservé).
    offers: [...home.offers].sort((a, b) => Number(b.boostEndsAt !== null) - Number(a.boostEndsAt !== null)).map(vendorOfferRow),
    hasOffers: home.offers.length > 0,
  };
}
