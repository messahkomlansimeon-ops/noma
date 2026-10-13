/**
 * Présentation des commandes, ou ventes déclarées (lot D2) : libellés et règles en fonctions PURES, sans React, testées isolément.
 *
 * Règles : « Je l'ai acheté » avec un prix convenu (FCFA, entier de 1 à 100 000 000) ; la commande est « proposée » puis confirmée ou refusée par le vendeur, annulable par
 * l'acheteur tant qu'elle n'est pas confirmée ; aucun paiement de l'objet ne passe par noma (c'est écrit à l'écran) ; l'autre partie n'a jamais de nom ni de numéro.
 */

import type { OfferSales, OrderStatus, OrderView, ParticipantRole, SalesCount } from "./social-api";
import { formatFcfa, formatDateTimeFr } from "./wallet-view";

export const ORDER_MIN_PRICE = 1;
export const ORDER_MAX_PRICE = 100_000_000;

export const NO_PAYMENT_NOTICE = "noma ne gère aucun paiement de l'objet : l'acheteur règle directement le vendeur, après avoir vu l'objet. Cette déclaration ne sert qu'à garder une trace.";
export const DECLARE_ORDER_LABEL = "Je l'ai acheté";
export const DECLARE_ORDER_CONFIRM_LABEL = "Déclarer cet achat";
export const DECLARE_ORDER_ONGOING = "Envoi…";
export const PRICE_LABEL = "Prix convenu (FCFA)";
export const PRICE_PLACEHOLDER = "Ex. 150 000";
export const ORDERS_TITLE_BUYER = "Mes commandes";
export const ORDERS_TITLE_SELLER = "Commandes";
export const ORDERS_LOADING = "Chargement des commandes…";
export const ORDERS_EMPTY_BUYER = "Aucune commande pour le moment.";
export const ORDERS_EMPTY_BUYER_HINT = "Quand vous avez acheté un objet trouvé sur noma, déclarez-le depuis la fiche de l'annonce ou depuis la conversation.";
export const ORDERS_EMPTY_SELLER = "Aucune commande pour le moment.";
export const ORDERS_EMPTY_SELLER_HINT = "Quand un acheteur déclare avoir acheté l'un de vos objets, la commande apparaît ici : vous la confirmez ou la refusez.";
export const CONFIRM_LABEL = "Confirmer la vente";
export const DECLINE_LABEL = "Refuser";
export const CANCEL_LABEL = "Annuler ma commande";
export const MARK_SATISFIED_LABEL = "Marquer mon besoin comme satisfait";
export const MARK_SATISFIED_HINT = "La vente est confirmée : vous pouvez clore votre besoin. Rien n'est fait automatiquement.";
export const SATISFIED_DONE = "Votre besoin est marqué comme satisfait.";

export const ORDER_ACTION_DONE: Readonly<Record<"confirm" | "decline" | "cancel", string>> = Object.freeze({
  confirm: "Vente confirmée.",
  decline: "Commande refusée.",
  cancel: "Commande annulée.",
});

/** Étiquette d'état, dite du point de vue du participant. */
export function statusLabel(status: OrderStatus, role: ParticipantRole): string {
  switch (status) {
    case "proposed":
      return role === "seller" ? "À confirmer" : "En attente du vendeur";
    case "confirmed":
      return "Confirmée";
    case "declined":
      return "Refusée";
    case "cancelled":
      return "Annulée";
  }
}

export type StatusTone = "carrot" | "sage" | "wash";

export function statusTone(status: OrderStatus): StatusTone {
  return status === "proposed" ? "carrot" : status === "confirmed" ? "sage" : "wash";
}

/** Prix saisi → entier, ou null s'il est illisible ou hors bornes. Espaces (y compris insécables) et « FCFA » tolérés ; ni virgule, ni point, ni signe. */
export function parsePriceInput(input: string): number | null {
  const text = input.replace(/[\s  ]/gu, "").replace(/fcfa$/iu, "");
  if (!/^[0-9]{1,9}$/.test(text)) return null;
  const value = Number(text);
  return Number.isSafeInteger(value) && value >= ORDER_MIN_PRICE && value <= ORDER_MAX_PRICE ? value : null;
}

export function priceProblem(input: string): string | null {
  if (input.trim() === "") return null;
  return parsePriceInput(input) === null ? "Indiquez le prix convenu en nombre entier de FCFA, de 1 à 100 000 000." : null;
}

export interface OrderRowView {
  id: string;
  title: string;
  priceText: string;
  statusText: string;
  tone: StatusTone;
  dateText: string;
  /** Page de la commande dans l'espace du participant. */
  href: string;
  /** Acheteur : rien (c'est lui) ; vendeur : « Acheteur intéressé ». */
  counterpart: string;
  needsAction: boolean;
}

export function orderPath(role: ParticipantRole, id: string): string {
  return role === "buyer" ? `/commandes/${id}` : `/vendeur/commandes/${id}`;
}

export function orderRow(order: OrderView): OrderRowView {
  return {
    id: order.id,
    title: order.title,
    // Lot MV1 : un achat de plusieurs unités dit la quantité (« 3 × 158 000 FCFA »).
    priceText: order.quantity > 1 ? `${order.quantity} × ${formatFcfa(order.price.amount)}` : formatFcfa(order.price.amount),
    statusText: statusLabel(order.status, order.role),
    tone: statusTone(order.status),
    dateText: formatDateTimeFr(order.createdAt),
    href: orderPath(order.role, order.id),
    counterpart: order.role === "seller" ? "Acheteur intéressé" : "Vendeur de l'annonce",
    needsAction: order.role === "seller" && order.canConfirm,
  };
}

export const OFFER_ORDER_CONFIRMED_LABEL = "Achat confirmé";
export const OFFER_ORDER_CONFIRMED_HINT = "Le vendeur a confirmé votre achat de cette annonce : il n'y a rien à déclarer de plus.";
export const OFFER_ORDER_PROPOSED_LABEL = "Achat déclaré";
export const OFFER_ORDER_PROPOSED_HINT = "En attente de la confirmation du vendeur.";

export interface OfferOrderBanner {
  kind: "confirmed" | "proposed";
  label: string;
  hint: string;
  href: string;
}

/**
 * Ce que la fiche dit d'une commande DÉJÀ passée pour cette annonce dans CE besoin (lot FIN1) : « Achat confirmé » (le bouton « Je l'ai acheté » disparaît : une deuxième déclaration serait
 * refusée) ou « Achat déclaré, en attente du vendeur ». `null` : aucune commande active, le bouton reste. Une commande refusée ou annulée ne compte pas (une nouvelle est permise).
 */
export function offerOrderBanner(orders: readonly OrderView[], demandId: string, offerId: string): OfferOrderBanner | null {
  const mine = orders.filter((order) => order.role === "buyer" && order.demandId === demandId && order.offerId === offerId);
  const confirmed = mine.find((order) => order.status === "confirmed");
  if (confirmed) return { kind: "confirmed", label: OFFER_ORDER_CONFIRMED_LABEL, hint: OFFER_ORDER_CONFIRMED_HINT, href: orderPath("buyer", confirmed.id) };
  const proposed = mine.find((order) => order.status === "proposed");
  if (proposed) return { kind: "proposed", label: OFFER_ORDER_PROPOSED_LABEL, hint: OFFER_ORDER_PROPOSED_HINT, href: orderPath("buyer", proposed.id) };
  return null;
}

/** Nombre de commandes à confirmer parmi celles du vendeur. */
export function pendingForSeller(orders: readonly OrderView[]): number {
  return orders.filter((order) => order.role === "seller" && order.canConfirm).length;
}

// ───────────── statistiques de ventes (vendeur) ─────────────

export const SALES_TITLE = "Ventes déclarées et confirmées";
export const SALES_NOTE = "Seules les ventes que vous avez confirmées comptent. Les nombres sont arrondis (moins de 5, ou environ N) pour protéger les acheteurs.";

export function salesCountText(count: SalesCount): string {
  return count.kind === "below" ? `moins de ${count.bound}` : `environ ${count.value}`;
}

export interface SalesView {
  total: string;
  /** Répartition boost / organique, seulement si l'annonce a eu un boost. */
  split: { boost: string; organic: string } | null;
}

export function salesView(sales: OfferSales): SalesView {
  return {
    total: salesCountText(sales.confirmed),
    split: sales.attributedToBoost === null || sales.organic === null ? null : { boost: salesCountText(sales.attributedToBoost), organic: salesCountText(sales.organic) },
  };
}
