/**
 * Règles des propositions de vendeur et des devis (lot FIN3-C3), PARTAGÉES par le serveur et le navigateur (aucun import serveur) : bornes, contrôle du contenu, libellés d'état.
 * Une proposition est une offre faite par un vendeur, depuis une de ses annonces en ligne, à un besoin d'acheteur qui y correspond encore ; un devis est une proposition AVEC des lignes
 * (son prix est la somme des lignes). Le prix est celui d'UNE unité : la commande créée à l'acceptation est de quantité 1. Aucun texte ne porte de numéro de téléphone : les échanges
 * passent par la messagerie de noma. Voir PROPOSITIONS.md.
 */

import { hasUnsafeCharacters, looksLikePhoneNumber, looksLikePhoneNumberAcross } from "./phone-text";

export const PROPOSALS_CONTRACT_VERSION = "proposals/v1";

export const PROPOSAL_STATUSES = ["sent", "accepted", "declined", "withdrawn", "expired"] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

export const PROPOSAL_STATUS_LABELS: Readonly<Record<ProposalStatus, string>> = Object.freeze({
  sent: "En attente de réponse",
  accepted: "Acceptée",
  declined: "Refusée",
  withdrawn: "Retirée par le vendeur",
  expired: "Expirée",
});

/** Mêmes bornes que les commandes (`ORDER_MIN_PRICE`, `ORDER_MAX_PRICE` : un test vérifie l'égalité) : l'acceptation ne peut donc jamais échouer sur le prix. */
export const PROPOSAL_PRICE_MIN = 1;
export const PROPOSAL_PRICE_MAX = 100_000_000;
export const PROPOSAL_SLOT_MAX = 120;
export const PROPOSAL_WARRANTY_MAX = 120;
export const PROPOSAL_NOTE_MAX = 300;
export const PROPOSAL_LABEL_MAX = 80;
export const PROPOSAL_LINES_MAX = 20;
export const PROPOSAL_VALID_DAYS_MIN = 1;
export const PROPOSAL_VALID_DAYS_MAX = 14;
export const PROPOSAL_VALID_DAYS_DEFAULT = 7;
/** Propositions qu'un vendeur peut envoyer par jour UTC. */
export const PROPOSALS_DAILY_LIMIT = 30;
/** Propositions EN ATTENTE qu'un même besoin peut recevoir : au-delà, le besoin ne reçoit plus de nouvelle proposition. */
export const PROPOSALS_NEED_OPEN_LIMIT = 20;

export const PHONE_IN_PROPOSAL_MESSAGE = "Pas de numéro de téléphone dans la proposition : l'acheteur vous répondra dans la messagerie de noma.";

export interface ProposalLineInput {
  label: string;
  amountXof: number;
}

export interface ProposalInput {
  offerId: string;
  /** Prix d'une unité, en XOF : celui de la proposition, ou la somme des lignes d'un devis. */
  priceXof: number;
  lines: ProposalLineInput[];
  slot: string | null;
  warranty: string | null;
  note: string | null;
  validDays: number;
}

export type ProposalInputCheck = { ok: true; value: ProposalInput } | { ok: false; reason: "invalid" | "phone" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ALLOWED = new Set(["offerId", "priceXof", "lines", "slot", "warranty", "note", "validDays"]);

function isInteger(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
}

type Text = { ok: true; value: string | null } | { ok: false; reason: "invalid" | "phone" };

function freeText(raw: unknown, max: number, optional: boolean): Text {
  if (raw === undefined || raw === null) return optional ? { ok: true, value: null } : { ok: false, reason: "invalid" };
  if (typeof raw !== "string") return { ok: false, reason: "invalid" };
  const value = raw.trim();
  if (value === "") return optional ? { ok: true, value: null } : { ok: false, reason: "invalid" };
  if (value.length > max || hasUnsafeCharacters(value)) return { ok: false, reason: "invalid" };
  if (looksLikePhoneNumber(value)) return { ok: false, reason: "phone" };
  return { ok: true, value };
}

/**
 * Contrôle d'une proposition (corps de la requête) : mêmes règles côté écran et côté serveur. Aucune clé inconnue.
 *  - sans ligne : `priceXof` obligatoire ; avec des lignes (devis) : `priceXof` absent, ou égal à leur somme ; la somme fait au moins 1 ;
 *  - tous les textes (créneau, garantie, note, libellés des lignes) sont contrôlés ENSEMBLE : un numéro coupé entre deux champs est refusé.
 */
export function checkProposalInput(raw: unknown): ProposalInputCheck {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ok: false, reason: "invalid" };
  const body = raw as Record<string, unknown>;
  if (Object.keys(body).some((key) => !ALLOWED.has(key))) return { ok: false, reason: "invalid" };
  if (typeof body.offerId !== "string" || !UUID.test(body.offerId)) return { ok: false, reason: "invalid" };
  const validDays = body.validDays === undefined ? PROPOSAL_VALID_DAYS_DEFAULT : body.validDays;
  if (!isInteger(validDays, PROPOSAL_VALID_DAYS_MIN, PROPOSAL_VALID_DAYS_MAX)) return { ok: false, reason: "invalid" };
  const slot = freeText(body.slot, PROPOSAL_SLOT_MAX, true);
  if (!slot.ok) return slot;
  const warranty = freeText(body.warranty, PROPOSAL_WARRANTY_MAX, true);
  if (!warranty.ok) return warranty;
  const note = freeText(body.note, PROPOSAL_NOTE_MAX, true);
  if (!note.ok) return note;

  const lines: ProposalLineInput[] = [];
  if (body.lines !== undefined) {
    if (!Array.isArray(body.lines) || body.lines.length > PROPOSAL_LINES_MAX) return { ok: false, reason: "invalid" };
    for (const entry of body.lines) {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return { ok: false, reason: "invalid" };
      const line = entry as Record<string, unknown>;
      if (Object.keys(line).some((key) => key !== "label" && key !== "amountXof")) return { ok: false, reason: "invalid" };
      const label = freeText(line.label, PROPOSAL_LABEL_MAX, false);
      if (!label.ok) return label;
      if (!isInteger(line.amountXof, 0, PROPOSAL_PRICE_MAX) || label.value === null) return { ok: false, reason: "invalid" };
      lines.push({ label: label.value, amountXof: line.amountXof });
    }
  }
  let priceXof: number;
  if (lines.length > 0) {
    priceXof = lines.reduce((sum, line) => sum + line.amountXof, 0);
    if (body.priceXof !== undefined && body.priceXof !== priceXof) return { ok: false, reason: "invalid" };
  } else if (isInteger(body.priceXof, PROPOSAL_PRICE_MIN, PROPOSAL_PRICE_MAX)) {
    priceXof = body.priceXof;
  } else {
    return { ok: false, reason: "invalid" };
  }
  if (!isInteger(priceXof, PROPOSAL_PRICE_MIN, PROPOSAL_PRICE_MAX)) return { ok: false, reason: "invalid" };
  // Un numéro réparti sur plusieurs champs (créneau + garantie + note + libellés) est refusé comme un numéro d'un seul tenant.
  if (looksLikePhoneNumberAcross([slot.value, warranty.value, note.value, ...lines.map((line) => line.label)])) return { ok: false, reason: "phone" };
  return { ok: true, value: { offerId: body.offerId.toLowerCase(), priceXof, lines, slot: slot.value, warranty: warranty.value, note: note.value, validDays } };
}

export const PROPOSAL_ACTIONS = ["accept", "decline", "withdraw"] as const;
export type ProposalAction = (typeof PROPOSAL_ACTIONS)[number];
