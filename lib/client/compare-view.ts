/**
 * Comparaison de deux offres d'UN besoin (lot FIN3-C1) : fonctions PURES, sans React, partagées par la page `/besoins/[id]/comparer` et testées isolément.
 *
 * Règles :
 *  - la comparaison ne vaut QUE dans le contexte d'un besoin : les deux offres viennent des correspondances de ce besoin (réservées à son propriétaire, 404 indiscernable
 *    sinon), jamais d'une offre prise par son seul identifiant ;
 *  - la sélection est dans l'adresse (`?offres=<id>,<id>`), pas dans un état du navigateur : un lien rechargé ou partagé à soi-même garde la sélection ;
 *  - on ne compare que ce que noma sait : prix, état et lieu, compatibilité, prix par rapport au marché, disponibilité, confiance, badge « Vendeur Pro ». Livraison, garantie et
 *    total ne sont pas des champs d'une annonce : ils ne sont pas inventés ;
 *  - jamais d'identité, de nom ni de numéro (comme les résultats).
 */

import type { StoredMatch } from "./api";
import { buyerMatchRow } from "./match-view";

/** Nombre d'offres comparées : exactement deux. */
export const COMPARE_COUNT = 2;
export const COMPARE_LIMIT_MESSAGE = "Comparez jusqu'à 2 offres";
export const COMPARE_MISSING_MESSAGE = "Une des offres n'apparaît plus dans les résultats de ce besoin.";
export const COMPARE_INVALID_MESSAGE = "Choisissez deux offres dans les résultats pour les comparer.";
export const COMPARE_NOTE =
  "Informations telles qu'annoncées par les vendeurs. La disponibilité et l'état ne sont pas garantis : confirmez-les avec le vendeur. Livraison et garantie ne font pas partie des annonces.";
export const NOT_PROVIDED = "Non renseigné";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Page de comparaison : les trois identifiants viennent du serveur (UUID) ; sinon aucun lien. */
export function comparePath(demandId: string, offerIds: readonly string[]): string | null {
  if (!UUID.test(demandId) || offerIds.length !== COMPARE_COUNT || new Set(offerIds).size !== COMPARE_COUNT || !offerIds.every((id) => UUID.test(id))) return null;
  return `/besoins/${demandId}/comparer?offres=${offerIds.join(",")}`;
}

/** Sélection lue dans l'adresse : exactement deux UUID DISTINCTS, sinon null (aucune offre n'est devinée). */
export function parseCompareSelection(raw: string | null): [string, string] | null {
  if (raw === null) return null;
  const parts = raw.split(",");
  if (parts.length !== COMPARE_COUNT || parts[0] === parts[1] || !parts.every((part) => UUID.test(part))) return null;
  return [parts[0], parts[1]];
}

/** Coche ou décoche une offre ; une troisième est refusée (`refused`), la sélection reste inchangée. */
export function toggleSelection(selected: readonly string[], id: string): { selected: string[]; refused: boolean } {
  if (selected.includes(id)) return { selected: selected.filter((entry) => entry !== id), refused: false };
  if (selected.length >= COMPARE_COUNT) return { selected: [...selected], refused: true };
  return { selected: [...selected, id], refused: false };
}

/** Garde la sélection à ce que la liste contient encore (après « Actualiser », une offre peut avoir disparu). */
export function pruneSelection(selected: readonly string[], items: readonly Pick<StoredMatch, "candidateId">[]): string[] {
  const present = new Set(items.map((item) => item.candidateId));
  return selected.filter((id) => present.has(id));
}

export type CompareSide = "a" | "b";

export interface CompareRow {
  key: "price" | "condition" | "compatibility" | "market" | "availability" | "confidence" | "pro";
  label: string;
  a: string;
  b: string;
  /** Côté le plus avantageux pour l'acheteur, ou null quand la ligne n'a pas de « meilleur » ou que les deux se valent. */
  better: CompareSide | null;
}

function lowerIsBetter(a: number | null, b: number | null): CompareSide | null {
  if (a === null || b === null || a === b) return null;
  return a < b ? "a" : "b";
}

function higherIsBetter(a: number | null, b: number | null): CompareSide | null {
  if (a === null || b === null || a === b) return null;
  return a > b ? "a" : "b";
}

function indicatorText(item: StoredMatch, key: "price" | "availability" | "confidence"): string {
  const indicator = buyerMatchRow(item).indicators.find((entry) => entry.key === key);
  if (!indicator) return NOT_PROVIDED;
  return indicator.detail ? `${indicator.label}. ${indicator.detail}` : indicator.label;
}

/** Les lignes du tableau, dans l'ordre affiché. Aucune donnée n'est inventée : un champ absent s'écrit « Non renseigné ». */
export function compareRows(first: StoredMatch, second: StoredMatch): CompareRow[] {
  const a = buyerMatchRow(first);
  const b = buyerMatchRow(second);
  const priceA = first.candidate.price?.amount ?? null;
  const priceB = second.candidate.price?.amount ?? null;
  return [
    { key: "price", label: "Prix", a: a.priceText, b: b.priceText, better: lowerIsBetter(priceA, priceB) },
    { key: "condition", label: "État et lieu", a: a.subtitle ?? NOT_PROVIDED, b: b.subtitle ?? NOT_PROVIDED, better: null },
    { key: "compatibility", label: "Compatibilité avec votre besoin", a: a.compatibility, b: b.compatibility, better: higherIsBetter(first.score, second.score) },
    { key: "market", label: "Prix par rapport au marché", a: indicatorText(first, "price"), b: indicatorText(second, "price"), better: null },
    { key: "availability", label: "Disponibilité", a: indicatorText(first, "availability"), b: indicatorText(second, "availability"), better: null },
    { key: "confidence", label: "Confiance", a: indicatorText(first, "confidence"), b: indicatorText(second, "confidence"), better: null },
    { key: "pro", label: "Vendeur Pro", a: a.proBadge ? "Oui" : "Non", b: b.proBadge ? "Oui" : "Non", better: null },
  ];
}

/** Retrouve les deux offres choisies parmi les correspondances ; null si l'une manque (la page l'explique, sans rien deviner). */
export function pickCompared(items: readonly StoredMatch[], selection: readonly [string, string]): [StoredMatch, StoredMatch] | null {
  const first = items.find((item) => item.candidateId === selection[0]);
  const second = items.find((item) => item.candidateId === selection[1]);
  return first && second ? [first, second] : null;
}
