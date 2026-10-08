import { DUPLICATE_PRICE_TOLERANCE, DUPLICATE_TITLE_SIMILARITY } from "./config";

/**
 * Critères de regroupement d'une annonce présente sur plusieurs sources (lot EXT1). Module PUR.
 *
 * Deux annonces de SOURCES DIFFÉRENTES sont regroupées quand elles ont la même clé produit (elles ont été trouvées par la même surveillance) ET :
 *  - ou bien la MÊME adresse canonique (même page chez deux sources : une même annonce) ;
 *  - ou bien un prix à 2 % près (de la devise commune, écart d'au plus 2 % du plus bas des deux prix), les MÊMES nombres dans les deux titres (« 64 Go » et « 128 Go », « 55 pouces »
 *    et « 65 pouces » sont des produits différents) et un titre proche (indice de Jaccard des mots significatifs d'au moins 0,6).
 * Le regroupement ne supprime rien : les deux annonces et leurs observations restent en base ; un groupe n'est présenté qu'une fois à l'acheteur. Deux annonces d'une même source ne
 * sont jamais regroupées par ressemblance : seule l'identité (source + identifiant, ou source + URL canonique) les confond.
 *
 * Pourquoi la règle des nombres : « iPhone 12 64 Go » et « iPhone 12 128 Go » ont un indice de Jaccard de 0,6 (4 mots sur 6 en commun), EXACTEMENT le seuil ; un prix voisin les
 * regrouperait. Le seuil de ressemblance ne peut pas distinguer deux capacités ou deux tailles d'écran : les nombres du titre le font.
 */

/** Mots sans valeur distinctive pour comparer deux titres. Les chiffres et « go » restent : « 64 Go » et « 128 Go » sont deux produits. */
const FILLER_TOKENS: ReadonlySet<string> = new Set([
  "a", "au", "aux", "avec", "bon", "bonne", "chez", "dans", "de", "des", "du", "en", "et", "etat", "la", "le", "les", "neuf", "occasion", "pas", "pour", "prix", "sans", "sur", "tbe", "tres", "un", "une",
  "annonce", "vente", "vend", "vends", "fcfa", "cfa", "xof",
]);

export interface DuplicateCandidate {
  sourceCode: string;
  priceAmount: number | null;
  priceCurrency: string | null;
  /** Mots du titre (analyse du contenu). */
  tokens: readonly string[];
  /** Adresse canonique de l'annonce chez sa source (facultative) : la même adresse chez deux sources désigne la même annonce. */
  url?: string | null;
}

function significantTokens(tokens: readonly string[]): Set<string> {
  return new Set(tokens.filter((token) => token.length > 0 && !FILLER_TOKENS.has(token)));
}

/** Indice de Jaccard des mots significatifs de deux titres (0 si l'un des deux n'en a aucun). */
export function titleSimilarity(a: readonly string[], b: readonly string[]): number {
  const left = significantTokens(a);
  const right = significantTokens(b);
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  return shared / (left.size + right.size - shared);
}

/** Les nombres d'un titre (mots faits uniquement de chiffres, sans doublon), triés : « 128 Go noir 2 mois » → « 128|2 ». */
export function titleNumbers(tokens: readonly string[]): string[] {
  return [...new Set(tokens.filter((token) => /^[0-9]+$/.test(token)).map((token) => String(Number(token))))].sort();
}

/** Les deux titres portent-ils exactement les mêmes nombres (capacité, taille d'écran, numéro de modèle…) ? */
export function sameTitleNumbers(a: readonly string[], b: readonly string[]): boolean {
  const left = titleNumbers(a);
  const right = titleNumbers(b);
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/** Prix à 2 % près : même devise, deux montants connus, écart d'au plus 2 % du plus bas des deux. */
export function pricesWithinTolerance(a: Pick<DuplicateCandidate, "priceAmount" | "priceCurrency">, b: Pick<DuplicateCandidate, "priceAmount" | "priceCurrency">): boolean {
  if (a.priceAmount === null || b.priceAmount === null || a.priceCurrency === null || a.priceCurrency !== b.priceCurrency) return false;
  const lower = Math.min(a.priceAmount, b.priceAmount);
  return Math.abs(a.priceAmount - b.priceAmount) <= DUPLICATE_PRICE_TOLERANCE * lower;
}

/** Les deux annonces (déjà trouvées par la même surveillance) sont-elles la même annonce vue chez deux sources ? */
export function isDuplicatePair(a: DuplicateCandidate, b: DuplicateCandidate): boolean {
  if (a.sourceCode === b.sourceCode) return false;
  if (typeof a.url === "string" && a.url !== "" && a.url === b.url) return true;
  if (!pricesWithinTolerance(a, b)) return false;
  if (!sameTitleNumbers(a.tokens, b.tokens)) return false;
  return titleSimilarity(a.tokens, b.tokens) >= DUPLICATE_TITLE_SIMILARITY;
}
