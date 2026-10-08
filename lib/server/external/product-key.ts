import { accentNormalize } from "../../../poc/lib/need";
import { tokenize } from "./analysis";
import type { ProductKey } from "./types";

/**
 * Clé produit normalisée d'une surveillance de marché (lot EXT1). Module PUR.
 *
 * Normalisation : `accentNormalize` du moteur (minuscules, sans accents, espaces simples), caractères de contrôle remplacés par une espace, 80 caractères au plus par composant.
 * Un besoin n'a de clé que s'il porte une catégorie, une marque ET un modèle (comme le marché de `matching/market.ts`). La variante est facultative et FAIT partie de la clé
 * (« iPhone 12 » et « iPhone 12 128 Go » sont deux surveillances) ; la zone aussi (vide quand le besoin n'en précise pas).
 *
 * La VARIANTE est de plus normalisée comme l'analyseur lit un titre (`tokenize` : lettres et chiffres séparés, « gb » lu « go ») : « 128 Go », « 128Go », « 128 GB » et « 128 go »
 * donnent UNE seule clé, donc une seule surveillance (sinon trois besoins équivalents coûteraient trois collectes). Le modèle, la marque, la catégorie et la zone restent en texte
 * normalisé simple.
 */

export const KEY_PART_MAX = 80;
/** Séparateur de la clé textuelle : un caractère de contrôle que la normalisation retire de tout composant. */
export const KEY_SEPARATOR = "\u001f";

/** Composant normalisé ; chaîne vide si rien d'exploitable. */
export function normalizeKeyPart(value: string | null | undefined): string {
  if (typeof value !== "string") return "";
  const printable = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
  return accentNormalize(printable).slice(0, KEY_PART_MAX).trim();
}

export interface KeySource {
  category: string | null | undefined;
  brand: string | null | undefined;
  model: string | null | undefined;
  variant?: string | null | undefined;
  location?: string | null | undefined;
}

/** Variante normalisée comme un titre d'annonce (mots de l'analyseur) ; chaîne vide si rien d'exploitable. 80 caractères au plus APRÈS normalisation (colonne `variant`). */
export function normalizeVariant(value: string | null | undefined): string {
  const words = tokenize(normalizeKeyPart(value)).join(" ");
  return words.slice(0, KEY_PART_MAX).trim();
}

/** Clé produit d'un besoin ; `null` si la catégorie, la marque ou le modèle manque. */
export function productKeyOf(source: KeySource): ProductKey | null {
  const category = normalizeKeyPart(source.category);
  const brand = normalizeKeyPart(source.brand);
  const model = normalizeKeyPart(source.model);
  if (category === "" || brand === "" || model === "") return null;
  const variant = normalizeVariant(source.variant);
  return { category, brand, model, variant: variant === "" ? null : variant, zone: normalizeKeyPart(source.location) };
}

/** Clé textuelle unique (colonne `product_key`). */
export function productKeyString(key: ProductKey): string {
  return [key.category, key.brand, key.model, key.variant ?? "", key.zone].join(KEY_SEPARATOR);
}

/** Texte lisible d'une clé (marque, modèle, variante), pour la recherche d'un connecteur fictif et les écrans de l'administration. */
export function describeProductKey(key: ProductKey): string {
  return [key.brand, key.model, key.variant].filter((part): part is string => typeof part === "string" && part !== "").join(" ");
}
