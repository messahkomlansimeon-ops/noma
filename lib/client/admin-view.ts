/**
 * Présentation de l'administration (lot D2) : fonctions PURES. Tableau de bord (chiffres réels), liste des vendeurs (numéros masqués sauf les deux derniers chiffres),
 * suspension et réactivation avec confirmation, journal, réglages du boost en lecture seule.
 */

import { formatFcfa, formatDateTimeFr } from "./wallet-view";
import type { AdminActionEntry, AdminBoostSettings, AdminSummary, AdminVendor } from "./social-api";

export const ADMIN_TITLE = "Administration";
export const ADMIN_LOADING = "Chargement du tableau de bord…";
export const ADMIN_NOT_FOUND = "Page introuvable.";
export const VENDORS_TITLE = "Vendeurs";
export const VENDORS_EMPTY = "Aucun vendeur pour le moment.";
export const JOURNAL_TITLE = "Journal d'administration";
export const JOURNAL_EMPTY = "Aucune action pour le moment.";
export const SETTINGS_TITLE = "Réglages du boost";
export const SETTINGS_NOTE = "Lecture seule : ces réglages ne se modifient pas depuis cet écran.";
export const SUSPEND_LABEL = "Suspendre";
export const REACTIVATE_LABEL = "Réactiver";
export const VENDORS_PAGE_SIZE = 20;

export const STATUS_LABELS: Readonly<Record<AdminVendor["status"], string>> = Object.freeze({ active: "Actif", suspended: "Suspendu", archived: "Archivé" });

export const OFFER_STATUS_LABELS: Readonly<Record<string, string>> = Object.freeze({ draft: "Brouillons", published: "En ligne", paused: "En pause", archived: "Archivées" });

export interface AdminTile {
  key: string;
  label: string;
  value: string;
  detail: string | null;
}

export function summaryTiles(summary: AdminSummary): AdminTile[] {
  const offers = Object.entries(summary.offers.byStatus)
    .map(([status, count]) => `${count} ${(OFFER_STATUS_LABELS[status] ?? status).toLowerCase()}`)
    .join(" · ");
  return [
    { key: "accounts", label: "Comptes", value: String(summary.accounts.total), detail: `${summary.accounts.active} actifs · ${summary.accounts.suspended} suspendus` },
    { key: "offers", label: "Annonces", value: String(summary.offers.total), detail: offers === "" ? null : offers },
    { key: "demands", label: "Besoins actifs", value: String(summary.activeDemands), detail: null },
    { key: "matches", label: "Correspondances confirmées", value: String(summary.confirmedMatches), detail: null },
    { key: "boosts", label: "Boosts actifs", value: String(summary.activeBoosts), detail: null },
    { key: "credits", label: "Crédits en circulation", value: formatFcfa(summary.credits.circulationXof), detail: `Recharges du jour : ${summary.credits.topupsTodayCount} (${formatFcfa(summary.credits.topupsTodayXof)})` },
    { key: "conversations", label: "Conversations", value: String(summary.conversations.total), detail: `${summary.conversations.messagesToday} message(s) aujourd'hui` },
    { key: "orders", label: "Commandes confirmées", value: String(summary.orders.confirmed), detail: `${summary.orders.proposed} en attente du vendeur` },
  ];
}

export interface WorkerView {
  healthy: boolean;
  headline: string;
  lines: string[];
}

export function workerView(worker: AdminSummary["worker"]): WorkerView {
  if (!worker.schemaReady) return { healthy: false, headline: "Calcul des correspondances : base non prête", lines: worker.warnings.map((warning) => warning.message) };
  const lines = [
    `${worker.pendingEvents} événement(s) en attente · ${worker.pendingJobs} tâche(s) en attente · ${worker.runningJobs} en cours`,
    `Tâches en échec définitif : ${worker.deadLetter}`,
    worker.lastCompletedAt === null ? "Aucune tâche terminée pour le moment." : `Dernière tâche terminée le ${formatDateTimeFr(worker.lastCompletedAt)}`,
    ...worker.warnings.map((warning) => warning.message),
  ];
  return { healthy: worker.healthy, headline: worker.healthy ? "Calcul des correspondances : en bonne santé" : "Calcul des correspondances : à surveiller", lines };
}

export interface VendorRowView {
  id: string;
  maskedPhone: string;
  offersText: string;
  joinedText: string;
  statusText: string;
  suspended: boolean;
  canSuspend: boolean;
  canReactivate: boolean;
}

export function vendorRow(vendor: AdminVendor): VendorRowView {
  return {
    id: vendor.id,
    maskedPhone: vendor.maskedPhone ?? "numéro inconnu",
    offersText: `${vendor.offerCount} annonce(s) dont ${vendor.publishedCount} en ligne`,
    joinedText: `Inscrit le ${formatDateTimeFr(vendor.createdAt).split(" à ")[0]}`,
    statusText: STATUS_LABELS[vendor.status],
    suspended: vendor.status === "suspended",
    canSuspend: vendor.status === "active" && !vendor.isAdmin,
    canReactivate: vendor.status === "suspended",
  };
}

export function confirmText(action: "suspend" | "reactivate", maskedPhone: string): string {
  return action === "suspend"
    ? `Suspendre le vendeur ${maskedPhone} ? Il ne pourra plus se connecter et ses annonces ne seront plus proposées.`
    : `Réactiver le vendeur ${maskedPhone} ? Ses annonces reviennent dans les correspondances.`;
}

export const ACTION_LABELS: Readonly<Record<AdminActionEntry["action"], string>> = Object.freeze({
  suspend_user: "Suspension",
  reactivate_user: "Réactivation",
  grant_admin: "Rôle administrateur attribué",
});

export function journalRow(entry: AdminActionEntry): { id: string; text: string; dateText: string } {
  const by = entry.source === "command" ? "commande admin:grant" : (entry.byMaskedPhone ?? "administrateur");
  return { id: entry.id, text: `${ACTION_LABELS[entry.action]} · ${entry.targetMaskedPhone ?? "compte"} · par ${by}`, dateText: formatDateTimeFr(entry.createdAt) };
}

/** Page suivante / précédente d'une liste paginée. */
export function pageWindow(total: number, offset: number, limit: number): { from: number; to: number; hasPrevious: boolean; hasNext: boolean } {
  if (total === 0) return { from: 0, to: 0, hasPrevious: false, hasNext: false };
  return { from: offset + 1, to: Math.min(total, offset + limit), hasPrevious: offset > 0, hasNext: offset + limit < total };
}

export function settingsRows(settings: readonly AdminBoostSettings[]): Array<{ key: string; title: string; lines: string[] }> {
  const percent = (value: number | null): string => (value === null ? "hérité de « default »" : `${Math.round(value * 100)} %`);
  const number = (value: number | null): string => (value === null ? "hérité de « default »" : String(value));
  const money = (value: number | null): string => (value === null ? "hérité de « default »" : formatFcfa(value));
  return settings.map((row) => ({
    key: row.key,
    title: row.key === "default" ? "Par défaut (toutes catégories)" : `Catégorie « ${row.key} »`,
    lines: [
      `Part de places promues : ${percent(row.slotRatio)} (de ${number(row.minSlots)} à ${number(row.maxSlots)} places)`,
      `Part maximale d'annonces promues : ${percent(row.maxPromotedShare)}`,
      `Boosts actifs par vendeur : ${number(row.maxActivePerSeller)} · part de places d'un vendeur : ${percent(row.maxSellerSlotShare)}`,
      `Pertinence minimale : ${number(row.minRelevance)} / 100`,
      `Prix de base : ${money(row.baseAmountXof)} (de ${money(row.minAmountXof)} à ${money(row.maxAmountXof)})`,
      `Validité d'un devis : ${row.quoteValiditySeconds === null ? "hérité de « default »" : `${Math.round(row.quoteValiditySeconds / 60)} min`}`,
    ],
  }));
}
