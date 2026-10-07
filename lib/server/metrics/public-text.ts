import "server-only";

/**
 * Texte saisi par un vendeur et montré à un acheteur (attributs de la fiche d'annonce M1, titre d'une notification N1) : UNE seule règle partagée.
 *  - le texte est normalisé en NFKC avant tout contrôle (chiffres pleine chasse, « ０７０８… », exposants, chiffres cerclés, mathématiques : ramenés à leur forme usuelle) ;
 *  - les chiffres se comptent avec `\p{Nd}` (tous les systèmes d'écriture : arabes-indiens « ٠٧٠٨… », dévanagari « ०७०८… », etc.), jamais avec `\d` (ASCII seulement) ;
 *  - neuf chiffres ou plus (séparateurs compris) ressemblent à un numéro de téléphone : le texte n'est jamais publié (le numéro ne se révèle que par le contact).
 * Fonctions pures. Voir NOTIFICATIONS.md et MESURES.md.
 */

/** Caractères de contrôle, de direction de texte et invisibles : jamais affichés. */
export const UNSAFE_TEXT = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

/** Neuf chiffres ou plus d'affilée (séparateurs compris), tous systèmes d'écriture. */
const PHONE_LIKE = /(?:\p{Nd}[\s.\-()+]*){9,}/u;
const DIGIT = /\p{Nd}/gu;

/** Forme normalisée (NFKC) sur laquelle tous les contrôles portent. */
export function normalizePublicText(value: string): string {
  return value.normalize("NFKC");
}

/** Nombre de chiffres (tous systèmes d'écriture) du texte, après normalisation. */
export function countDigits(value: string): number {
  return (normalizePublicText(value).match(DIGIT) ?? []).length;
}

/** Contient un caractère de contrôle, de direction ou invisible, avant OU après normalisation. */
export function hasUnsafeCharacters(value: string): boolean {
  return UNSAFE_TEXT.test(value) || UNSAFE_TEXT.test(normalizePublicText(value));
}

/** Ressemble à un numéro de téléphone : neuf chiffres ou plus d'affilée, séparateurs compris, après normalisation. */
export function looksLikePhoneNumber(value: string): boolean {
  return PHONE_LIKE.test(normalizePublicText(value));
}
