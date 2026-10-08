/**
 * Présentation des missions d'achat en volume (lot MV1) : libellés et règles en fonctions PURES, sans React, testées isolément (tests/client/missions-view.test.ts).
 *
 * Une mission : « 20 iPhone 12 au plus à 170 000 FCFA l'unité, 3 200 000 FCFA au total ». noma propose une répartition entre plusieurs vendeurs ANONYMES ; l'acheteur écrit à
 * chacun (le message est pré-rempli, modifiable, et ne part que s'il l'envoie), puis déclare ses achats ligne par ligne. Rien n'est automatique et aucun paiement ne passe par noma.
 * Tout en mots simples ; jamais d'identifiant ni de code technique à l'écran.
 */

import {
  MISSION_CONDITIONS,
  MISSION_DEADLINE_DAYS_DEFAULT,
  MISSION_FIELD_PROBLEMS,
  MISSION_FIELDS,
  checkMissionInput,
  missionPhoneMessage,
  type MissionField,
  type MissionInput,
  type MissionStatus,
} from "../missions-rules";
import type { MissionOrder, MissionProposal, MissionSummary, ProposalEngaged, ProposalLine } from "./missions-api";
import { formatDateFr, formatFcfa } from "./wallet-view";

export { NO_PAYMENT_NOTICE } from "./orders-view";

export const MISSIONS_TITLE = "Mes missions";
export const MISSIONS_LOADING = "Chargement de vos missions…";
export const MISSIONS_EMPTY = "Aucune mission pour le moment.";
export const MISSIONS_EMPTY_HINT = "Une mission sert à acheter plusieurs exemplaires du même objet, chez plusieurs vendeurs, dans la limite d'un budget.";
export const MISSIONS_NEW_LABEL = "Nouvelle mission";
export const MISSION_LOADING = "Chargement de la mission…";
export const MISSION_NOT_FOUND = "Mission introuvable.";
export const PROPOSAL_TITLE = "Proposition de répartition";
export const PROPOSAL_NOTE = "noma propose une répartition entre plusieurs vendeurs, sans les nommer. C'est une proposition : vous choisissez, vendeur par vendeur, à qui écrire et quoi acheter.";
export const ENGAGED_TITLE = "Déjà acheté ou en attente";
export const ENGAGED_NOTE = "Ces achats sont déjà comptés : la proposition ci-dessous ne répartit que ce qu'il reste à acheter.";
export const LINES_TITLE = "À acheter";
export const MISSIONS_MORE_LABEL = "Voir plus de missions";
export const MISSIONS_MORE_LOADING = "Chargement…";
export const PROPOSAL_LOADING = "Recherche des annonces…";
export const PROPOSAL_INACTIVE = "Cette mission n'est plus en cours : plus de proposition.";
export const PROPOSAL_UNAVAILABLE = "La proposition n'est pas disponible pour le moment. Réessayez dans un instant.";
export const PROPOSAL_ALL_ENGAGED = "Toute la quantité est déjà achetée ou en attente de confirmation : il n'y a plus rien à proposer.";
export const PROPOSAL_EMPTY = "Aucune annonce ne correspond encore. Vous serez prévenu dès qu'une annonce arrive.";
export const WRITE_LABEL = "Écrire";
export const DECLARE_LABEL = "Déclarer l'achat";
export const DECLARE_CONFIRM_LABEL = "Déclarer cet achat";
export const SEE_LISTING_LABEL = "Voir l'annonce";
export const ORDERS_TITLE = "Vos achats pour cette mission";

export const MISSION_ACTION_LABELS = Object.freeze({
  activate: "Lancer la mission",
  pause: "Mettre en pause",
  resume: "Reprendre",
  cancel: "Annuler la mission",
}) satisfies Record<string, string>;
export const MISSION_ACTION_DONE = Object.freeze({
  activate: "Mission lancée.",
  pause: "Mission en pause.",
  resume: "Mission reprise.",
  cancel: "Mission annulée.",
}) satisfies Record<string, string>;
export const CANCEL_MISSION_WARNING = "Annuler la mission annule aussi les achats que les vendeurs n'ont pas encore confirmés. Appuyez encore pour confirmer.";

export const STATUS_LABELS: Readonly<Record<MissionStatus, string>> = Object.freeze({
  draft: "Brouillon",
  active: "En cours",
  paused: "En pause",
  completed: "Terminée",
  cancelled: "Annulée",
  expired: "Échue",
});

export type StatusTone = "carrot" | "sage" | "wash" | "sky";

export function statusTone(status: MissionStatus): StatusTone {
  switch (status) {
    case "active":
      return "sage";
    case "completed":
      return "sky";
    case "draft":
    case "paused":
      return "carrot";
    default:
      return "wash";
  }
}

export function statusLabel(status: MissionStatus): string {
  return Object.prototype.hasOwnProperty.call(STATUS_LABELS, status) ? STATUS_LABELS[status] : "Mission";
}

// ───────────── chemins ─────────────

export function missionPath(id: string): string {
  return `/missions/${id}`;
}

export function missionEditPath(id: string): string {
  return `/missions/${id}/modifier`;
}

/** Page d'une conversation ouverte depuis une ligne de la proposition : quantité et prix visés (deux entiers, jamais un texte) pour pré-remplir le message. */
export function lineConversationPath(conversationId: string, line: Pick<ProposalLine, "quantity" | "unitPriceXof">): string {
  return `/messages/${conversationId}?quantite=${line.quantity}&prix=${line.unitPriceXof}`;
}

export interface MissionHint {
  quantity: number;
  priceXof: number;
}

/** Quantité et prix visés lus dans l'adresse de la conversation : deux entiers positifs en chiffres seulement, sinon aucun pré-remplissage. */
export function parseMissionHint(quantity: string | null, price: string | null): MissionHint | null {
  if (quantity === null || price === null || !/^[0-9]{1,5}$/.test(quantity) || !/^[0-9]{1,9}$/.test(price)) return null;
  const q = Number(quantity);
  const p = Number(price);
  return q >= 1 && q <= 10_000 && p >= 1 && p <= 100_000_000 ? { quantity: q, priceXof: p } : null;
}

/**
 * Le message pré-rempli (MODIFIABLE : il ne part que si l'acheteur appuie sur « envoyer »). Il dit la quantité et le prix visés, rien d'autre : jamais le budget de la mission,
 * ni le nombre total voulu, ni les autres vendeurs.
 */
export function missionDraftMessage(input: { title: string; quantity: number; unitPriceXof: number }): string {
  const unit = input.quantity === 1 ? "unité" : "unités";
  return `Bonjour, je souhaite acheter ${input.quantity} ${unit} de « ${input.title} » à ${formatFcfa(input.unitPriceXof)} l'unité. Est-elle toujours disponible ?`;
}

// ───────────── progression et lignes ─────────────

/** Part de la quantité totale, en pourcentage entier arrondi vers le bas (100 % seulement si tout est atteint). */
export function percentOf(part: number, total: number): number {
  if (!Number.isFinite(part) || !Number.isFinite(total) || total <= 0 || part <= 0) return 0;
  return Math.min(100, Math.floor((part * 100) / total));
}

export interface MissionRowView {
  id: string;
  href: string;
  title: string;
  statusText: string;
  tone: StatusTone;
  /** « 3 sur 20 achetés » ; null pour un brouillon. */
  securedText: string | null;
  securedPercent: number;
  /** « La proposition couvre 7 sur 20 » ; null tant que la couverture n'est pas connue. */
  coverageText: string | null;
  coveragePercent: number | null;
  budgetText: string;
  deadlineText: string | null;
  isOpen: boolean;
}

export function missionRow(mission: MissionSummary): MissionRowView {
  const open = mission.status === "active" || mission.status === "paused";
  const known = mission.coveredQuantity !== null && open;
  return {
    id: mission.id,
    href: missionPath(mission.id),
    title: mission.title,
    statusText: statusLabel(mission.status),
    tone: statusTone(mission.status),
    securedText: mission.status === "draft" ? null : `${mission.securedQuantity} sur ${mission.quantity} achetés`,
    securedPercent: percentOf(mission.securedQuantity, mission.quantity),
    coverageText: known ? `La proposition couvre ${mission.coveredQuantity} sur ${mission.quantity}` : open ? "Recherche des annonces en cours…" : null,
    coveragePercent: known ? percentOf(mission.coveredQuantity as number, mission.quantity) : null,
    budgetText: `${formatFcfa(mission.unitBudgetXof)} l'unité · ${formatFcfa(mission.totalBudgetXof)} au total`,
    deadlineText: mission.deadlineAt === null ? `${mission.deadlineDays} jours après le lancement` : `Jusqu'au ${formatDateFr(mission.deadlineAt)}`,
    isOpen: open,
  };
}

export interface ProposalLineView {
  offerId: string;
  vendor: string;
  title: string;
  location: string | null;
  calculText: string;
  subtotalText: string;
  stockText: string;
  canAct: boolean;
}

export function proposalLineView(line: ProposalLine, missionOpen: boolean): ProposalLineView {
  return {
    offerId: line.offerId,
    vendor: line.vendor,
    title: line.title,
    location: line.location,
    calculText: `${line.quantity} × ${formatFcfa(line.unitPriceXof)}`,
    subtotalText: formatFcfa(line.subtotalXof),
    stockText: line.stock === 1 ? "1 exemplaire annoncé" : `${line.stock} exemplaires annoncés`,
    canAct: missionOpen,
  };
}

export interface EngagedLineView {
  orderId: string;
  offerId: string;
  vendor: string;
  title: string;
  location: string | null;
  calculText: string;
  subtotalText: string;
  /** « Achat confirmé : 2 » ou « Achat déclaré : 2, en attente du vendeur ». */
  statusText: string;
  confirmed: boolean;
}

/** Un achat déjà engagé, affiché à part : jamais proposé une seconde fois. */
export function engagedLineView(order: ProposalEngaged): EngagedLineView {
  return {
    orderId: order.orderId,
    offerId: order.offerId,
    vendor: order.vendor,
    title: order.title,
    location: order.location,
    calculText: `${order.quantity} × ${formatFcfa(order.unitPriceXof)}`,
    subtotalText: formatFcfa(order.subtotalXof),
    statusText: order.status === "confirmed" ? `Achat confirmé : ${order.quantity}` : `Achat déclaré : ${order.quantity}, en attente du vendeur`,
    confirmed: order.status === "confirmed",
  };
}

export interface ProposalSummaryView {
  coverageText: string;
  coveragePercent: number;
  /** « 2 déjà achetés ou en attente, 6 à acheter » ; null tant que rien n'est engagé. */
  committedText: string | null;
  budgetText: string;
  remainingText: string;
  sellersText: string;
  complete: boolean;
}

export function proposalSummary(proposal: MissionProposal): ProposalSummaryView {
  return {
    coverageText: `La proposition couvre ${proposal.coveredQuantity} sur ${proposal.requestedQuantity}`,
    coveragePercent: proposal.coveragePercent,
    committedText:
      proposal.committedQuantity > 0
        ? `${proposal.committedQuantity} ${proposal.committedQuantity === 1 ? "déjà acheté ou en attente" : "déjà achetés ou en attente"}, ${proposal.remainingQuantity} à acheter`
        : null,
    budgetText: `${formatFcfa(proposal.budgetUsedXof)} sur ${formatFcfa(proposal.totalBudgetXof)}`,
    remainingText: `Il resterait ${formatFcfa(proposal.budgetRemainingXof)} de votre budget total.`,
    sellersText: proposal.sellerCount === 1 ? "1 vendeur" : `${proposal.sellerCount} vendeurs`,
    complete: proposal.coveredQuantity >= proposal.requestedQuantity,
  };
}

export function orderLine(order: MissionOrder): { title: string; text: string; statusText: string } {
  const statusText = order.status === "confirmed" ? "Confirmé" : order.status === "proposed" ? "En attente du vendeur" : order.status === "declined" ? "Refusé" : "Annulé";
  return { title: order.title, text: `${order.quantity} × ${formatFcfa(order.unitPriceXof)} = ${formatFcfa(order.quantity * order.unitPriceXof)}`, statusText };
}

// ───────────── formulaire ─────────────

export interface MissionFormValues {
  category: string;
  brand: string;
  model: string;
  variant: string;
  condition: string;
  quantity: string;
  unit: string;
  unitBudget: string;
  totalBudget: string;
  location: string;
  deadlineDays: string;
}

export const EMPTY_MISSION_FORM: MissionFormValues = Object.freeze({
  category: "",
  brand: "",
  model: "",
  variant: "",
  condition: MISSION_CONDITIONS[5],
  quantity: "",
  unit: "pièce",
  unitBudget: "",
  totalBudget: "",
  location: "",
  deadlineDays: String(MISSION_DEADLINE_DAYS_DEFAULT),
});

/** Un nombre saisi : chiffres seulement (espaces, espaces insécables et « FCFA » tolérés) ; ni virgule, ni point, ni signe. Null s'il est illisible. */
export function parseWholeNumber(input: string): number | null {
  const text = input.replace(/[\s  ]/gu, "").replace(/fcfa$/iu, "");
  if (!/^[0-9]{1,13}$/.test(text)) return null;
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : null;
}

export type MissionFormResult = { ok: true; input: MissionInput } | { ok: false; problems: Partial<Record<MissionField, string>> };

/**
 * Lit le formulaire : chaque champ est contrôlé par la MÊME règle que le serveur (`checkMissionInput`) ; tous les problèmes sont rendus d'un coup, avec un texte fixe par
 * champ (jamais la valeur saisie).
 */
export function parseMissionForm(values: MissionFormValues): MissionFormResult {
  const problems: Partial<Record<MissionField, string>> = {};
  const quantity = parseWholeNumber(values.quantity);
  const unitBudget = parseWholeNumber(values.unitBudget);
  const totalBudget = parseWholeNumber(values.totalBudget);
  const deadlineDays = parseWholeNumber(values.deadlineDays);
  const candidate = {
    category: values.category,
    brand: values.brand,
    model: values.model,
    variant: values.variant.trim() === "" ? null : values.variant,
    condition: values.condition,
    quantity,
    unit: values.unit,
    unitBudgetXof: unitBudget,
    totalBudgetXof: totalBudget,
    location: values.location.trim() === "" ? null : values.location,
    deadlineDays,
  };
  // Un champ à la fois : un contrôle de toute la mission ne dit que le premier problème.
  for (const field of MISSION_FIELDS) {
    const single = checkMissionInput({ ...fillerFor(field), [field]: candidate[field] });
    if (!single.ok && single.field === field) problems[field] = single.code === "phone_number_in_mission" ? missionPhoneMessage(field) : MISSION_FIELD_PROBLEMS[field];
  }
  if (Object.keys(problems).length === 0) {
    const whole = checkMissionInput(candidate);
    if (whole.ok) return { ok: true, input: whole.value };
    if (whole.field === null) {
      problems.model = missionPhoneMessage(null);
    } else {
      problems[whole.field] = whole.code === "phone_number_in_mission" ? missionPhoneMessage(whole.field) : MISSION_FIELD_PROBLEMS[whole.field];
    }
  }
  return { ok: false, problems };
}

/** Une mission valide quelconque, dont on remplace UN champ pour le contrôler seul. */
function fillerFor(field: MissionField): MissionInput {
  const base: MissionInput = {
    category: "Téléphones",
    brand: "Marque",
    model: "Modèle",
    variant: null,
    condition: "Occasion",
    quantity: 2,
    unit: "pièce",
    unitBudgetXof: 1_000,
    totalBudgetXof: 1_000_000,
    location: null,
    deadlineDays: 30,
  };
  // Pour le budget total, le budget par unité du remplissage reste au plus égal au total saisi : on le ramène à 1.
  return field === "totalBudgetXof" ? { ...base, unitBudgetXof: 1 } : base;
}

/** Les valeurs du formulaire d'une mission existante (modification d'un brouillon). */
export function formValuesOf(mission: MissionSummary): MissionFormValues {
  return {
    category: mission.category,
    brand: mission.brand,
    model: mission.model,
    variant: mission.variant ?? "",
    condition: mission.condition,
    quantity: String(mission.quantity),
    unit: mission.unit,
    unitBudget: String(mission.unitBudgetXof),
    totalBudget: String(mission.totalBudgetXof),
    location: mission.location ?? "",
    deadlineDays: String(mission.deadlineDays),
  };
}
