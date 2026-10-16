/**
 * Présentation des propositions de vendeur et des devis (lot FIN3-C3) : fonctions PURES, sans React, partagées par les écrans et testées isolément. Jamais d'identité ni de numéro : le
 * vendeur et l'acheteur ne se voient pas dans une proposition, ils se parlent dans la messagerie une fois la commande créée. Voir PROPOSITIONS.md.
 */

import {
  PROPOSALS_DAILY_LIMIT,
  PROPOSAL_STATUS_LABELS,
  PROPOSAL_VALID_DAYS_DEFAULT,
  checkProposalInput,
  type ProposalInput,
  type ProposalLineInput,
  type ProposalStatus,
} from "../proposals-rules";
import type { Proposal, SellerRequest } from "./proposals-api";
import { interestedBuyerRow, type InterestedBuyerRow } from "./match-view";
import { formatDateTimeFr, formatFcfa } from "./wallet-view";

export const REQUESTS_TITLE = "Demandes";
export const REQUESTS_EMPTY = "Aucun besoin d'acheteur ne correspond à vos annonces en ligne pour le moment.";
export const REQUESTS_HINT = "Chaque ligne est le besoin d'un acheteur, sans son identité. Vous pouvez lui faire une proposition ou un devis ; il vous répond sans que vous échangiez de numéro.";
export const REQUESTS_TRUNCATED_NOTE = "Seules vos 20 annonces en ligne les plus récentes sont prises en compte.";
export const SENT_TITLE = "Mes propositions";
export const SENT_EMPTY = "Vous n'avez envoyé aucune proposition.";
export const BUYER_TITLE = "Propositions reçues";
export const BUYER_EMPTY = "Vous n'avez reçu aucune proposition pour le moment.";
export const BUYER_HINT = "Une proposition vient d'un vendeur dont l'annonce correspond à l'un de vos besoins. L'accepter crée une commande, que le vendeur confirme ensuite. Refuser est définitif pour cette annonce et ce besoin.";
export const FORM_NO_PHONE_NOTE = "N'écrivez aucun numéro de téléphone : l'acheteur vous répond dans la messagerie de noma.";
export const SENT_MESSAGE = "Proposition envoyée. L'acheteur la verra dans « Propositions reçues ».";
export const ACCEPTED_MESSAGE = "Proposition acceptée : une commande a été créée, le vendeur doit la confirmer.";
export const DECLINED_MESSAGE = "Proposition refusée.";
export const WITHDRAWN_MESSAGE = "Proposition retirée.";
export const LINES_TITLE = "Lignes du devis";
export const QUOTE_TOTAL_LABEL = "Total du devis";
export const QUOTE_NOTE = "Le prix de la proposition est la somme des lignes. Le prix est celui d'une unité.";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function requestPath(demandId: string): string | null {
  return UUID.test(demandId) ? `/vendeur/demandes/${demandId}` : null;
}

/** Formulaire de devis pour un besoin et une annonce de CE vendeur ; null si un identifiant n'est pas un UUID. */
export function quotePath(demandId: string, offerId: string): string | null {
  return UUID.test(demandId) && UUID.test(offerId) ? `/vendeur/devis/nouveau?besoin=${demandId}&annonce=${offerId}` : null;
}

export function parseQuoteTarget(params: { get(name: string): string | null }): { demandId: string; offerId: string } | null {
  const demandId = params.get("besoin");
  const offerId = params.get("annonce");
  return demandId !== null && offerId !== null && UUID.test(demandId) && UUID.test(offerId) ? { demandId: demandId.toLowerCase(), offerId: offerId.toLowerCase() } : null;
}

export interface RequestRowView {
  demandId: string;
  need: InterestedBuyerRow;
  offersText: string;
  proposedCount: number;
  allProposed: boolean;
}

/** Une ligne de « Demandes » : le besoin comme dans « Acheteurs intéressés », les annonces du vendeur qui y correspondent, et où il en est. */
export function requestRow(request: SellerRequest): RequestRowView {
  const proposed = request.offers.filter((offer) => offer.proposal !== null && (offer.proposal.status === "sent" || offer.proposal.status === "accepted"));
  const names = request.offers.map((offer) => offer.title);
  return {
    demandId: request.need.candidateId,
    need: interestedBuyerRow(request.need),
    offersText: names.length === 1 ? `Votre annonce : ${names[0]}` : `${names.length} de vos annonces : ${names.slice(0, 3).join(", ")}${names.length > 3 ? "…" : ""}`,
    proposedCount: proposed.length,
    allProposed: proposed.length === request.offers.length,
  };
}

/** Le texte d'état d'une annonce pour un besoin : ce qui est déjà fait, ou ce qui bloque. */
export function offerStateText(offer: SellerRequest["offers"][number]): string | null {
  if (offer.declined) return "Refusée par l'acheteur : plus de proposition possible pour cette annonce.";
  if (offer.proposal === null) return null;
  return PROPOSAL_STATUS_LABELS[offer.proposal.status];
}

/** Une annonce peut proposer tant qu'aucune proposition n'est en attente ou acceptée et que l'acheteur n'a pas refusé. */
export function canPropose(offer: SellerRequest["offers"][number]): boolean {
  if (offer.declined) return false;
  return offer.proposal === null || offer.proposal.status === "withdrawn" || offer.proposal.status === "expired";
}

export interface ProposalRowView {
  id: string;
  title: string;
  priceText: string;
  statusText: string;
  status: ProposalStatus;
  details: string[];
  validText: string;
  lines: Array<{ label: string; amountText: string }>;
  dateText: string;
}

export function proposalRow(proposal: Proposal, side: "buyer" | "seller"): ProposalRowView {
  const details: string[] = [];
  if (proposal.slot) details.push(`Créneau : ${proposal.slot}`);
  if (proposal.warranty) details.push(`Garantie : ${proposal.warranty}`);
  if (proposal.note) details.push(proposal.note);
  return {
    id: proposal.id,
    title: side === "buyer" ? `${proposal.offerTitle} (pour votre besoin « ${proposal.needTitle} »)` : `${proposal.offerTitle} (besoin « ${proposal.needTitle} »)`,
    priceText: formatFcfa(proposal.priceXof),
    statusText: PROPOSAL_STATUS_LABELS[proposal.status],
    status: proposal.status,
    details,
    validText: proposal.status === "sent" ? `Valable jusqu'au ${formatDateTimeFr(proposal.validUntil)}` : `Envoyée le ${formatDateTimeFr(proposal.createdAt)}`,
    lines: proposal.lines.map((line) => ({ label: line.label, amountText: formatFcfa(line.amountXof) })),
    dateText: formatDateTimeFr(proposal.createdAt),
  };
}

export const canAnswer = (proposal: Proposal): boolean => proposal.status === "sent";

export function pendingText(count: number): string | null {
  if (count <= 0) return null;
  return count === 1 ? "1 proposition en attente de votre réponse" : `${count} propositions en attente de votre réponse`;
}

export function outcomeText(action: "accept" | "decline" | "withdraw"): string {
  return action === "accept" ? ACCEPTED_MESSAGE : action === "decline" ? DECLINED_MESSAGE : WITHDRAWN_MESSAGE;
}

// ───────────── formulaire ─────────────

export interface ProposalFormState {
  offerId: string;
  price: string;
  slot: string;
  warranty: string;
  note: string;
  validDays: string;
  lines: Array<{ label: string; amount: string }>;
}

export function emptyForm(offerId: string, withLines: boolean): ProposalFormState {
  return { offerId, price: "", slot: "", warranty: "", note: "", validDays: String(PROPOSAL_VALID_DAYS_DEFAULT), lines: withLines ? [{ label: "", amount: "" }] : [] };
}

const digitsOnly = (text: string): number | null => (/^[0-9]{1,9}$/.test(text.trim()) ? Number(text.trim()) : null);

/** Somme des lignes valides (montant entier) : le total affiché pendant la saisie. */
export function linesTotal(lines: ProposalFormState["lines"]): number {
  return lines.reduce((sum, line) => sum + (digitsOnly(line.amount) ?? 0), 0);
}

export type FormCheck = { ok: true; value: ProposalInput } | { ok: false; reason: "invalid" | "phone" };

/** Le formulaire devient une proposition contrôlée par la règle partagée (celle du serveur) : aucune règle n'est dupliquée ici. */
export function buildProposal(form: ProposalFormState): FormCheck {
  const lines: ProposalLineInput[] = [];
  for (const line of form.lines) {
    if (line.label.trim() === "" && line.amount.trim() === "") continue;
    const amount = digitsOnly(line.amount);
    if (amount === null) return { ok: false, reason: "invalid" };
    lines.push({ label: line.label, amountXof: amount });
  }
  const wire: Record<string, unknown> = { offerId: form.offerId };
  const days = digitsOnly(form.validDays);
  if (days === null) return { ok: false, reason: "invalid" };
  wire.validDays = days;
  if (lines.length > 0) wire.lines = lines;
  else {
    const price = digitsOnly(form.price);
    if (price === null) return { ok: false, reason: "invalid" };
    wire.priceXof = price;
  }
  for (const [key, value] of [["slot", form.slot], ["warranty", form.warranty], ["note", form.note]] as const) if (value.trim() !== "") wire[key] = value;
  const checked = checkProposalInput(wire);
  return checked.ok ? { ok: true, value: checked.value } : checked;
}

export const DAILY_LIMIT_TEXT = `${PROPOSALS_DAILY_LIMIT} propositions par jour au plus.`;
