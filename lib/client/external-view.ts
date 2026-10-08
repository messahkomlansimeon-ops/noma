/**
 * Présentation de la collecte d'annonces externes (lot EXT1) : fonctions PURES. Section « Sur d'autres sites » des résultats d'un besoin et page /admin/collecte.
 *
 * Les annonces d'autres sites sont toujours présentées À PART, avec la mention « Annonce trouvée sur <source> : noma ne garantit ni le prix ni la disponibilité ; vous serez redirigé
 * vers le site. », un lien sortant en nouvel onglet (`rel="noopener noreferrer nofollow"`) et jamais de bouton de contact, de favori ou de commande : elles ne sont pas des annonces
 * de noma. Aucun numéro de téléphone n'existe dans ces données.
 */

import { formatMoney } from "./catalog-view";
import { formatDateFr, formatDateTimeFr } from "./wallet-view";
import type { AdminCollection, AdminCollectionSource, BreakerState, ExternalListing } from "./external-api";
import { isSafeExternalUrl } from "./external-api";

export const EXTERNAL_SECTION_TITLE = "Sur d'autres sites";
export const EXTERNAL_SECTION_INTRO = "Ces annonces ne sont pas des annonces noma : elles sont présentées à part, sans classement ni mise en avant.";
export const EXTERNAL_MORE_LABEL = "Voir plus";
export const EXTERNAL_LOADING = "Recherche sur d'autres sites…";
export const EXTERNAL_UNAVAILABLE = "Les annonces d'autres sites sont momentanément indisponibles. Vos résultats noma ne sont pas concernés.";
export const EXTERNAL_LINK_LABEL = "Voir sur le site";
export const EXTERNAL_LINK_TARGET = "_blank";
export const EXTERNAL_LINK_REL = "noopener noreferrer nofollow";

/** La mention OBLIGATOIRE de chaque annonce externe. */
export function externalMention(sourceName: string): string {
  return `Annonce trouvée sur ${sourceName} : noma ne garantit ni le prix ni la disponibilité ; vous serez redirigé vers le site.`;
}

export interface ExternalLinkProps {
  href: string;
  target: typeof EXTERNAL_LINK_TARGET;
  rel: typeof EXTERNAL_LINK_REL;
}

/** Attributs du lien sortant ; null si l'adresse n'est pas une adresse http(s) sûre (aucun lien n'est alors affiché). */
export function externalLinkProps(url: string): ExternalLinkProps | null {
  return isSafeExternalUrl(url) ? { href: url, target: EXTERNAL_LINK_TARGET, rel: EXTERNAL_LINK_REL } : null;
}

export interface ExternalCardRow {
  key: string;
  title: string;
  priceText: string;
  locationText: string | null;
  sourceName: string;
  mention: string;
  alsoOnText: string | null;
  compatibilityText: string;
  seenText: string;
  link: ExternalLinkProps | null;
}

function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} et ${names[names.length - 1]}`;
}

export function externalCardRow(item: ExternalListing): ExternalCardRow {
  const percent = Math.max(0, Math.min(100, Math.round(item.score)));
  return {
    key: item.id,
    title: item.title,
    priceText: formatMoney(item.price) ?? "Prix non indiqué",
    locationText: item.location,
    sourceName: item.source.name,
    mention: externalMention(item.source.name),
    alsoOnText: item.alsoOn.length === 0 ? null : `Aussi trouvée sur ${joinNames(item.alsoOn.map((source) => source.name))}`,
    compatibilityText: `Compatibilité ${percent} %`,
    seenText: `Vue le ${formatDateFr(item.seenAt)}`,
    link: externalLinkProps(item.url),
  };
}

/** Fusion d'une page suivante : aucun doublon (identifiant), ordre conservé. */
export function mergeExternalItems(current: readonly ExternalListing[], next: readonly ExternalListing[]): ExternalListing[] {
  const seen = new Set(current.map((item) => item.id));
  return [...current, ...next.filter((item) => !seen.has(item.id))];
}

// ───────────── administration ─────────────

export const ADMIN_COLLECTION_TITLE = "Collecte externe";
export const ADMIN_COLLECTION_LOADING = "Chargement de la collecte…";
export const ADMIN_COLLECTION_NOTE =
  "Lecture seule. Seules des sources FICTIVES existent : aucune collecte réelle n'a lieu tant que les sites autorisés n'ont pas été validés (droit, conditions d'utilisation, robots.txt, quotas, consentement).";
export const ADMIN_COLLECTION_NOT_READY = "La collecte externe n'est pas installée sur cette base (migration 0025 absente).";
export const ADMIN_COLLECTION_NO_ERRORS = "Aucune erreur récente.";

export const BREAKER_LABELS: Readonly<Record<BreakerState, string>> = Object.freeze({
  disabled: "Désactivée",
  closed: "Active",
  open: "En pause (disjoncteur ouvert)",
  half_open: "Pause écoulée : prochain essai décisif",
});

export const SOURCE_TYPE_LABELS: Readonly<Record<string, string>> = Object.freeze({ fake: "Fictive" });

/** Codes d'erreur d'une source, en mots simples ; un code inconnu ne s'affiche jamais tel quel. */
export const ERROR_CODE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  timeout: "Délai dépassé",
  connector_error: "Panne de la source",
  invalid_response: "Réponse invalide",
  store_conflict: "Conflit d'écriture",
});
export const UNKNOWN_ERROR_LABEL = "Erreur de la source";

export function errorLabel(code: string): string {
  return Object.prototype.hasOwnProperty.call(ERROR_CODE_LABELS, code) ? ERROR_CODE_LABELS[code] : UNKNOWN_ERROR_LABEL;
}

export interface AdminSourceRow {
  code: string;
  name: string;
  typeText: string;
  stateText: string;
  state: BreakerState;
  quotaText: string;
  failuresText: string;
  pauseText: string | null;
  lastErrorText: string | null;
}

export function adminSourceRow(source: AdminCollectionSource): AdminSourceRow {
  return {
    code: source.code,
    name: source.name,
    typeText: Object.prototype.hasOwnProperty.call(SOURCE_TYPE_LABELS, source.type) ? SOURCE_TYPE_LABELS[source.type] : "Autre",
    stateText: BREAKER_LABELS[source.state],
    state: source.state,
    quotaText: `${source.usedToday} / ${source.dailyQuota} requêtes aujourd'hui`,
    failuresText: source.consecutiveFailures === 0 ? "Aucun échec de suite" : `${source.consecutiveFailures} échec(s) de suite`,
    pauseText: source.state === "open" && source.breakerOpenUntil !== null ? `En pause jusqu'au ${formatDateTimeFr(source.breakerOpenUntil)}` : null,
    lastErrorText: source.lastErrorCode === null ? null : errorLabel(source.lastErrorCode),
  };
}

export interface AdminWatchSummary {
  lines: string[];
}

export function adminWatchSummary(collection: Pick<AdminCollection, "watches" | "listings">): AdminWatchSummary {
  const { watches, listings } = collection;
  return {
    lines: [
      `${watches.total} surveillance(s) : ${watches.active} active(s), ${watches.paused} en pause, ${watches.due} due(s) maintenant`,
      `${listings.available} annonce(s) disponible(s), ${listings.gone} disparue(s), ${listings.unknown} non confirmée(s), ${listings.groups} groupe(s) de doublons`,
    ],
  };
}

export interface AdminErrorRow {
  key: string;
  text: string;
  dateText: string;
}

export function adminErrorRows(errors: AdminCollection["errors"]): AdminErrorRow[] {
  return errors.map((entry, index) => ({ key: `${entry.at}-${entry.sourceCode}-${index}`, text: `${entry.sourceName} · ${errorLabel(entry.code)}`, dateText: formatDateTimeFr(entry.at) }));
}
