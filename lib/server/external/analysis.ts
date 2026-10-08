import { createHash } from "node:crypto";
import { accentNormalize } from "../../../poc/lib/need";
import type { ProductKey } from "./types";

/**
 * Analyse du CONTENU d'une annonce externe (lot EXT1). Module PUR, déterministe, sans IA.
 *
 * Le contenu (titre, prix, devise, lieu normalisés) a une empreinte, `content_hash` : c'est la CLÉ de l'analyse. Un contenu déjà analysé ne l'est plus jamais, quelle que soit l'annonce
 * qui le porte (annonce relue sans changement, même annonce vue par deux surveillances, même contenu chez deux sources). Changer le moteur d'analyse change `ANALYZER_VERSION`, donc toutes
 * les empreintes.
 *
 * L'analyse produit la liste ordonnée des mots du titre et un drapeau « n'est pas le produit » (accessoire, pièces, annonce d'un acheteur). La confrontation à une clé produit
 * (`confirmsKey`) ne dépend que de cette analyse : modèle présent en mots consécutifs, non suivi d'une extension (« Pro », « Max », « Mini », « Ultra », « FE »…), variante présente.
 */

export const ANALYZER_VERSION = "ext-analysis/v1";
export const MAX_TOKENS = 60;

export interface AnalyzableContent {
  title: string | null;
  priceAmount: number | null;
  priceCurrency: string | null;
  location: string | null;
}

export interface ListingAnalysis {
  version: typeof ANALYZER_VERSION;
  /** Mots du titre, dans l'ordre (minuscules, sans accents, chiffres et lettres séparés, « gb » ramené à « go », « + » lu « plus »). */
  tokens: string[];
  /** Vrai : l'annonce n'est pas le produit lui-même (coque, film, pièces, annonce d'acheteur). */
  notTheProduct: boolean;
}

/** Mots qui disent « ce n'est pas le produit » : accessoires, pièces, annonces d'acheteurs. Heuristique (voir les limites dans COLLECTE-EXTERNE.md). */
export const NOT_THE_PRODUCT_TOKENS: ReadonlySet<string> = new Set([
  "coque", "coques", "housse", "housses", "etui", "etuis", "pochette", "pochettes", "film", "films", "vitre", "verre", "protege", "protection",
  "support", "adaptateur", "cable", "pieces", "piece", "reparation", "cherche", "recherche", "achete", "achat",
]);

/** Mots qui prolongent un nom de modèle et désignent un AUTRE produit (« iPhone 12 Pro », « Galaxy S21 Ultra ») sauf s'ils font partie de la clé. */
export const MODEL_EXTENSION_TOKENS: ReadonlySet<string> = new Set([
  "pro", "max", "mini", "plus", "ultra", "lite", "fe", "se", "neo", "promax", "xl", "edge",
]);

/** Mots du texte : minuscules sans accents, lettres et chiffres séparés (« 128Go » → « 128 », « go »), « gb » → « go », « + » → « plus ». */
export function tokenize(text: string | null | undefined): string[] {
  if (typeof text !== "string") return [];
  const spaced = accentNormalize(text.normalize("NFKC"))
    .replace(/\+/g, " plus ")
    .replace(/(\d)([a-z])/g, "$1 $2")
    .replace(/([a-z])(\d)/g, "$1 $2")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  if (spaced === "") return [];
  return spaced.split(" ").map((token) => (token === "gb" ? "go" : token === "tb" ? "to" : token)).slice(0, MAX_TOKENS);
}

/** Empreinte du contenu analysable (hexadécimal sur 64 caractères). Titre et lieu sont normalisés : une différence de casse ou d'accent ne change pas l'empreinte. */
export function contentHashOf(content: AnalyzableContent): string {
  const canonical = JSON.stringify([
    ANALYZER_VERSION,
    content.title === null ? null : accentNormalize(content.title),
    content.priceAmount,
    content.priceCurrency,
    content.location === null ? null : accentNormalize(content.location),
  ]);
  return createHash("sha256").update(canonical).digest("hex");
}

export function analyzeContent(content: AnalyzableContent): ListingAnalysis {
  const tokens = tokenize(content.title);
  return { version: ANALYZER_VERSION, tokens, notTheProduct: tokens.some((token) => NOT_THE_PRODUCT_TOKENS.has(token)) };
}

/** Relecture d'une analyse stockée : forme vérifiée, sinon null (une analyse illisible ne confirme rien). */
export function parseAnalysis(value: unknown): ListingAnalysis | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (record.version !== ANALYZER_VERSION || typeof record.notTheProduct !== "boolean" || !Array.isArray(record.tokens)) return null;
  if (!record.tokens.every((token) => typeof token === "string") || record.tokens.length > MAX_TOKENS) return null;
  return { version: ANALYZER_VERSION, tokens: record.tokens as string[], notTheProduct: record.notTheProduct };
}

function findPhrase(tokens: readonly string[], phrase: readonly string[]): number {
  if (phrase.length === 0) return -1;
  for (let start = 0; start + phrase.length <= tokens.length; start++) {
    if (phrase.every((word, offset) => tokens[start + offset] === word)) return start;
  }
  return -1;
}

/**
 * Le titre confirme-t-il le produit de la clé ? Faux pour un accessoire, un modèle absent, un modèle prolongé par une extension qui n'est pas dans la clé, une variante absente.
 * La marque n'est pas exigée dans le titre (« iPhone 12 » implique Apple) : c'est le modèle, en mots consécutifs, qui fait foi.
 */
export function confirmsKey(analysis: ListingAnalysis, key: Pick<ProductKey, "model" | "variant">): boolean {
  if (analysis.notTheProduct) return false;
  const model = tokenize(key.model);
  const start = findPhrase(analysis.tokens, model);
  if (start < 0) return false;
  const keyWords = new Set([...model, ...tokenize(key.variant)]);
  const next = analysis.tokens[start + model.length];
  if (next !== undefined && MODEL_EXTENSION_TOKENS.has(next) && !keyWords.has(next)) return false;
  const variant = tokenize(key.variant);
  if (variant.length > 0 && !variant.every((word) => analysis.tokens.includes(word))) return false;
  return true;
}
