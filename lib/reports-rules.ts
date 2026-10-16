/**
 * Règles des signalements (lot FIN3-C2), PARTAGÉES par le serveur et le navigateur (aucun import serveur) : motifs, décisions, bornes et contrôle du texte libre.
 * Un texte libre ne porte jamais de numéro de téléphone (même règle que les missions : les échanges passent par la messagerie de noma) ni de caractère invisible ou de contrôle.
 */

import { hasUnsafeCharacters, looksLikePhoneNumber } from "./phone-text";

export const REPORTS_CONTRACT_VERSION = "reports/v1";

export const REPORT_TARGET_TYPES = ["offer", "order"] as const;
export type ReportTargetType = (typeof REPORT_TARGET_TYPES)[number];

export const REPORT_REASONS = ["fraud", "unavailable", "wrong_info", "abusive", "other"] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];

export const REPORT_REASON_LABELS: Readonly<Record<ReportReason, string>> = Object.freeze({
  fraud: "Arnaque ou fraude",
  unavailable: "Annonce ou article indisponible",
  wrong_info: "Informations fausses ou trompeuses",
  abusive: "Comportement abusif",
  other: "Autre motif",
});

export const REPORT_STATUSES = ["open", "closed"] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];

export const REPORT_DECISIONS = ["dismissed", "seller_suspended"] as const;
export type ReportDecision = (typeof REPORT_DECISIONS)[number];

export const REPORT_DECISION_LABELS: Readonly<Record<ReportDecision, string>> = Object.freeze({
  dismissed: "Classé sans suite",
  seller_suspended: "Compte signalé suspendu",
});

export const REPORT_DETAIL_MAX = 500;
export const REPORT_NOTE_MAX = 500;
/** Signalements qu'un compte peut écrire par jour UTC : borne contre l'usage abusif de la file de modération. */
export const REPORTS_DAILY_LIMIT = 10;

export const PHONE_IN_REPORT_MESSAGE = "Pas de numéro de téléphone dans le texte : l'équipe noma traite le signalement sans contacter personne.";

export type TextCheck = { ok: true; value: string | null } | { ok: false; reason: "invalid" | "phone" };

/** Texte libre facultatif : espaces de bord retirés, vide = absent, borné, sans caractère de contrôle ni numéro de téléphone. */
export function checkReportText(raw: unknown, max: number, optional: boolean): TextCheck {
  if (raw === undefined || raw === null) return optional ? { ok: true, value: null } : { ok: false, reason: "invalid" };
  if (typeof raw !== "string") return { ok: false, reason: "invalid" };
  const value = raw.trim();
  if (value === "") return optional ? { ok: true, value: null } : { ok: false, reason: "invalid" };
  if (value.length > max || hasUnsafeCharacters(value)) return { ok: false, reason: "invalid" };
  if (looksLikePhoneNumber(value)) return { ok: false, reason: "phone" };
  return { ok: true, value };
}

export interface ReportInput {
  targetType: ReportTargetType;
  targetId: string;
  /** Besoin dans le contexte duquel l'annonce est signalée (obligatoire pour une annonce, absent pour une commande). */
  demandId: string | null;
  reason: ReportReason;
  detail: string | null;
}

export type ReportInputCheck = { ok: true; value: ReportInput } | { ok: false; reason: "invalid" | "phone" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Contrôle d'un signalement (corps de la requête) : mêmes règles côté écran et côté serveur. Aucune clé inconnue. */
export function checkReportInput(raw: unknown): ReportInputCheck {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ok: false, reason: "invalid" };
  const body = raw as Record<string, unknown>;
  const allowed = new Set(["targetType", "targetId", "demandId", "reason", "detail"]);
  if (Object.keys(body).some((key) => !allowed.has(key))) return { ok: false, reason: "invalid" };
  const targetType = body.targetType;
  if (!(REPORT_TARGET_TYPES as readonly unknown[]).includes(targetType)) return { ok: false, reason: "invalid" };
  if (typeof body.targetId !== "string" || !UUID.test(body.targetId)) return { ok: false, reason: "invalid" };
  const demandId = body.demandId;
  if (targetType === "offer") {
    if (typeof demandId !== "string" || !UUID.test(demandId)) return { ok: false, reason: "invalid" };
  } else if (demandId !== undefined && demandId !== null) {
    return { ok: false, reason: "invalid" };
  }
  if (!(REPORT_REASONS as readonly unknown[]).includes(body.reason)) return { ok: false, reason: "invalid" };
  const detail = checkReportText(body.detail, REPORT_DETAIL_MAX, true);
  if (!detail.ok) return detail;
  return {
    ok: true,
    value: {
      targetType: targetType as ReportTargetType,
      targetId: body.targetId.toLowerCase(),
      demandId: typeof demandId === "string" ? demandId.toLowerCase() : null,
      reason: body.reason as ReportReason,
      detail: detail.value,
    },
  };
}

export type DecisionInput = { decision: ReportDecision; note: string };
export type DecisionCheck = { ok: true; value: DecisionInput } | { ok: false; reason: "invalid" | "phone" };

/** Décision d'un administrateur : une décision connue et un motif OBLIGATOIRE. */
export function checkDecisionInput(raw: unknown): DecisionCheck {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ok: false, reason: "invalid" };
  const body = raw as Record<string, unknown>;
  if (Object.keys(body).some((key) => key !== "decision" && key !== "note")) return { ok: false, reason: "invalid" };
  if (!(REPORT_DECISIONS as readonly unknown[]).includes(body.decision)) return { ok: false, reason: "invalid" };
  const note = checkReportText(body.note, REPORT_NOTE_MAX, false);
  if (!note.ok || note.value === null) return { ok: false, reason: note.ok ? "invalid" : note.reason };
  return { ok: true, value: { decision: body.decision as ReportDecision, note: note.value } };
}
