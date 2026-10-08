/**
 * Présentation de l'administration des paiements (lot PAY1) : libellés en français, jamais un code brut, aucune donnée personnelle. Logique pure (testée sans navigateur).
 * Les montants s'écrivent en FCFA ; un rattrapage est dit en mots (« en attente », « payé », « abandonné après 24 h »).
 */

import type { AnomalyKind, PaymentsOverview, PaymentsOverviewAnomaly, PaymentsOverviewIntent } from "./payments-admin-api";
import { formatDateTimeFr, formatFcfa } from "./wallet-view";

export const PAYMENTS_TITLE = "Paiements";
export const WAVE_ONLY_NOTE = "Paiement par Wave seulement : pas d'Orange Money ni de MTN à cette adresse.";
export const ANOMALY_EXPLANATION =
  "Une anomalie est un événement de Sublymus qui ne correspond pas à notre recharge (montant, devise, statut, référence inconnue, événement illisible ou inconnu…). Rien n'a été crédité, sauf pour « Paiement reçu sur une recharge déjà échouée » où la recharge a été créditée car l'argent a été pris. Vérifiez chez Sublymus, corrigez à la main si besoin, puis marquez l'anomalie comme traitée.";

export const ANOMALY_LABELS: Readonly<Record<AnomalyKind, string>> = Object.freeze({
  amount_mismatch: "Montant différent de la recharge",
  currency_mismatch: "Devise différente de XOF",
  status_mismatch: "Statut inattendu",
  unknown_reference: "Référence inconnue",
  payer_mismatch: "Payeur différent du gestionnaire",
  source_mismatch: "Système source différent",
  intent_id_mismatch: "Identifiant Sublymus différent",
  event_mismatch: "Événement incohérent avec l'en-tête",
  state_conflict: "Paiement reçu sur une recharge déjà échouée (crédité : à vérifier)",
  invalid_amount: "Montant illisible",
  duplicate_provider_intents: "Plusieurs intentions chez Sublymus pour la même référence",
  unreadable_event: "Événement de Sublymus illisible",
  unknown_event: "Événement de Sublymus inconnu",
});

export function providerStateText(provider: PaymentsOverview["provider"]): string {
  if (provider === "sublymus") return "Prestataire actif : Wave via Sublymus";
  if (provider === "fake") return "Prestataire actif : paiement simulé (développement)";
  return "Configuration du paiement refusée : le serveur ne peut pas recharger (voir PAIEMENT-WAVE.md)";
}

export function anomalyRow(anomaly: PaymentsOverviewAnomaly, timeZone?: string): { title: string; detail: string; open: boolean } {
  const parts: string[] = [`Le ${formatDateTimeFr(anomaly.createdAt, timeZone)}`, anomaly.origin === "webhook" ? "webhook" : "rattrapage"];
  if (anomaly.expectedAmountXof !== null) parts.push(`attendu ${formatFcfa(anomaly.expectedAmountXof)}`);
  if (anomaly.receivedAmountXof !== null) parts.push(`reçu ${formatFcfa(anomaly.receivedAmountXof)}`);
  if (anomaly.receivedCurrency !== null) parts.push(`devise ${anomaly.receivedCurrency}`);
  if (anomaly.receivedStatus !== null) parts.push(`statut ${anomaly.receivedStatus}`);
  return { title: ANOMALY_LABELS[anomaly.kind], detail: parts.join(" · "), open: anomaly.resolvedAt === null };
}

const INTENT_STATUS_LABELS = { pending: "En attente", succeeded: "Payée", failed: "Échouée", expired: "Expirée" } as const;
const CATCHUP_OUTCOME_LABELS: Readonly<Record<string, string>> = Object.freeze({
  waiting: "paiement en attente chez Wave", not_found: "introuvable chez Sublymus", completed: "payé", failed: "échoué", anomaly: "anomalie", error: "Sublymus injoignable", window_closed: "abandonné après 24 h",
});

export function intentRow(intent: PaymentsOverviewIntent, timeZone?: string): { title: string; detail: string } {
  const providerText = intent.provider === "sublymus" ? "Wave" : "simulé";
  const parts: string[] = [`${INTENT_STATUS_LABELS[intent.status]} · ${providerText}`, `créée le ${formatDateTimeFr(intent.createdAt, timeZone)}`];
  if (intent.provider === "sublymus") {
    parts.push(intent.checkoutOpened ? "session Wave ouverte" : "session Wave non ouverte");
    if (intent.catchupAttempts !== null && intent.catchupAttempts > 0) parts.push(`rattrapage : ${intent.catchupAttempts} tentative(s)${intent.lastCatchupOutcome ? `, ${CATCHUP_OUTCOME_LABELS[intent.lastCatchupOutcome] ?? "issue inconnue"}` : ""}`);
    if (intent.catchupDone === false && intent.nextCatchupAt !== null) parts.push(`prochain rattrapage le ${formatDateTimeFr(intent.nextCatchupAt, timeZone)}`);
  }
  return { title: formatFcfa(intent.amountXof), detail: parts.join(" · ") };
}

/** État du rattrapage en une phrase ; avertit quand des rattrapages sont échus (le worker ne tourne peut-être pas). */
export function catchupText(catchup: PaymentsOverview["catchup"], timeZone?: string): { text: string; warn: boolean } {
  const last = catchup.lastRunAt === null ? "aucun passage encore" : `dernier passage le ${formatDateTimeFr(catchup.lastRunAt, timeZone)}`;
  const base = `Rattrapage : ${catchup.waiting} en attente, ${catchup.done} terminé(s), ${last}.`;
  return catchup.overdue > 0
    ? { text: `${base} ${catchup.overdue} rattrapage(s) échu(s) depuis plus de 15 minutes : le worker ne tourne peut-être pas.`, warn: true }
    : { text: base, warn: false };
}

export function webhooksText(webhooks: PaymentsOverview["webhooks"], timeZone?: string): string {
  return webhooks.lastReceivedAt === null
    ? "Webhooks Sublymus : aucun reçu."
    : `Webhooks Sublymus : ${webhooks.last24h} reçu(s) ces dernières 24 h, dernier le ${formatDateTimeFr(webhooks.lastReceivedAt, timeZone)}.`;
}
