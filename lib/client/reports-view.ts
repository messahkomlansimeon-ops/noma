/**
 * Présentation des signalements et des dossiers de modération (lot FIN3-C2) : fonctions PURES, sans React, partagées par les écrans et testées isolément. Jamais d'identifiant
 * ni de numéro entier : l'administrateur ne voit que des numéros masqués (premier signe, points, deux derniers chiffres). Voir SIGNALEMENTS.md.
 */

import { REPORT_DECISION_LABELS, REPORT_REASON_LABELS, type ReportDecision, type ReportReason, type ReportStatus, type ReportTargetType } from "../reports-rules";
import type { AdminReportDetail, AdminReportRow, MyReport } from "./reports-api";
import { formatDateTimeFr, formatFcfa } from "./wallet-view";

export const REPORT_PAGE_TITLE = "Signaler";
export const MY_REPORTS_TITLE = "Mes signalements";
export const MY_REPORTS_EMPTY = "Vous n'avez fait aucun signalement.";
export const MY_REPORTS_HINT =
  "Pour signaler une annonce, ouvrez-la depuis les résultats d'un de vos besoins, puis appuyez sur « Signaler cette annonce ». Pour signaler une commande, ouvrez-la depuis « Mes commandes ».";
export const REPORT_FORM_INTRO = "Dites-nous ce qui ne va pas. L'équipe noma examine le signalement ; la personne signalée n'en est pas informée.";
export const REPORT_NO_PHONE_NOTE = "N'écrivez aucun numéro de téléphone : le signalement est traité sans contacter personne.";
export const REPORT_SENT_MESSAGE = "Signalement envoyé. Merci : l'équipe noma va l'examiner.";
export const REPORT_INVALID_TARGET = "Choisissez l'annonce ou la commande à signaler depuis son écran.";
export const DOSSIERS_TITLE = "Dossiers de modération";
export const DOSSIERS_EMPTY_OPEN = "Aucun dossier à traiter.";
export const DOSSIERS_EMPTY_CLOSED = "Aucun dossier clos.";
export const DOSSIERS_PAGE_SIZE = 20;
export const AI_SUMMARY_NOTE = "Synthèse automatique : non disponible. Les faits ci-dessous viennent directement de la base.";
export const DECISION_NOTE_LABEL = "Motif de la décision (obligatoire)";
export const DECISION_NOTE_HINT = "Ce motif est conservé avec le dossier. L'auteur du signalement ne le voit pas.";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type ReportTarget = { type: "offer"; offerId: string; demandId: string } | { type: "order"; orderId: string };

/** Adresse du formulaire pour une annonce vue dans le contexte d'un besoin ; null si un identifiant n'est pas un UUID. */
export function reportOfferPath(demandId: string, offerId: string): string | null {
  return UUID.test(demandId) && UUID.test(offerId) ? `/signaler?besoin=${demandId}&annonce=${offerId}` : null;
}

export function reportOrderPath(orderId: string): string | null {
  return UUID.test(orderId) ? `/signaler?commande=${orderId}` : null;
}

/** La cible lue dans l'adresse : une annonce ET son besoin, ou une commande ; jamais les deux, jamais un identifiant qui n'est pas un UUID. */
export function parseReportTarget(params: { get(name: string): string | null }): ReportTarget | null {
  const offerId = params.get("annonce");
  const demandId = params.get("besoin");
  const orderId = params.get("commande");
  if (orderId !== null) return offerId === null && demandId === null && UUID.test(orderId) ? { type: "order", orderId: orderId.toLowerCase() } : null;
  if (offerId !== null && demandId !== null && UUID.test(offerId) && UUID.test(demandId)) return { type: "offer", offerId: offerId.toLowerCase(), demandId: demandId.toLowerCase() };
  return null;
}

export function reasonText(reason: ReportReason): string {
  return REPORT_REASON_LABELS[reason];
}

export function targetTypeText(type: ReportTargetType): string {
  return type === "offer" ? "Annonce" : "Commande";
}

export const STATUS_TEXT: Readonly<Record<ReportStatus, string>> = Object.freeze({ open: "En cours d'examen", closed: "Traité" });

export interface MyReportRowView {
  key: string;
  title: string;
  reasonText: string;
  statusText: string;
  open: boolean;
  dateText: string;
}

export function myReportRow(report: MyReport): MyReportRowView {
  return {
    key: report.id,
    title: `${targetTypeText(report.targetType)} : ${report.targetTitle}`,
    reasonText: reasonText(report.reason),
    statusText: STATUS_TEXT[report.status],
    open: report.status === "open",
    dateText: formatDateTimeFr(report.createdAt),
  };
}

export interface DossierRowView {
  id: string;
  title: string;
  reasonText: string;
  reportedText: string;
  reporterText: string;
  alertText: string | null;
  decisionText: string | null;
  dateText: string;
  open: boolean;
}

/** « 2 dossiers ouverts visent ce compte » : un compte visé plusieurs fois est le premier à examiner. */
export function openCountText(count: number): string | null {
  return count >= 2 ? `${count} dossiers ouverts visent ce compte` : null;
}

export function dossierRow(report: AdminReportRow): DossierRowView {
  return {
    id: report.id,
    title: `${targetTypeText(report.targetType)} : ${report.targetTitle}`,
    reasonText: reasonText(report.reason),
    reportedText: `Compte signalé : ${report.reportedMaskedPhone ?? "numéro non vérifié"}`,
    reporterText: `Signalé par : ${report.reporterMaskedPhone ?? "numéro non vérifié"}`,
    alertText: report.status === "open" ? openCountText(report.reportedOpenCount) : null,
    decisionText: report.decision === null ? null : REPORT_DECISION_LABELS[report.decision],
    dateText: formatDateTimeFr(report.createdAt),
    open: report.status === "open",
  };
}

const OFFER_STATUS: Readonly<Record<string, string>> = Object.freeze({ draft: "brouillon", published: "en ligne", paused: "en pause", archived: "archivée" });
const ORDER_STATUS: Readonly<Record<string, string>> = Object.freeze({ proposed: "proposée", confirmed: "confirmée", declined: "refusée", cancelled: "annulée" });
const AVAILABILITY: Readonly<Record<string, string>> = Object.freeze({ available: "disponible", reserved: "réservée", unavailable: "indisponible" });
const ACCOUNT_STATUS: Readonly<Record<AdminReportDetail["reportedStatus"], string>> = Object.freeze({ active: "actif", suspended: "suspendu", archived: "archivé" });

/** Les faits du dossier, ligne par ligne, tels que la base les donne (aucune interprétation, aucune synthèse). */
export function dossierFacts(report: AdminReportDetail): string[] {
  const lines: string[] = [];
  if (report.offer) {
    const price = report.offer.priceAmount === null ? "prix non renseigné" : formatFcfa(report.offer.priceAmount);
    const availability = report.offer.availability === null ? null : (AVAILABILITY[report.offer.availability] ?? report.offer.availability);
    lines.push(`Annonce ${OFFER_STATUS[report.offer.status] ?? report.offer.status}${availability ? `, ${availability}` : ""} · ${price}`);
  }
  if (report.order) lines.push(`Commande ${ORDER_STATUS[report.order.status] ?? report.order.status} · ${formatFcfa(report.order.priceAmount)}`);
  lines.push(`Compte signalé : ${ACCOUNT_STATUS[report.reportedStatus]}`);
  lines.push(`Dossiers visant ce compte : ${report.reportedOpenCount} ouvert${report.reportedOpenCount > 1 ? "s" : ""} sur ${report.reportedTotalCount} au total`);
  return lines;
}

export function decisionOutcomeText(decision: ReportDecision, suspended: boolean): string {
  return decision === "seller_suspended" ? (suspended ? "Dossier clos : compte suspendu." : "Dossier clos.") : "Dossier clos sans suite.";
}

export function decisionConfirmText(decision: ReportDecision, reportedPhone: string | null): string {
  return decision === "seller_suspended"
    ? `Le compte ${reportedPhone ?? "signalé"} sera suspendu : ses annonces ne sont plus servies et sa session est refusée. L'action est inscrite au journal d'administration.`
    : "Le dossier sera clos sans suite. Le compte signalé n'est pas modifié.";
}
