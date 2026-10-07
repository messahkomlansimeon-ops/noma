/**
 * Détection d'un numéro de téléphone caché dans un texte saisi par un vendeur (lot D1). Module PUR, sans dépendance serveur : il sert aussi bien à l'affichage
 * (jamais servi à un acheteur) qu'à la publication (refusé à la source). Règle UNIQUE, partagée :
 *  - le texte est normalisé en NFKC avant tout contrôle (chiffres pleine chasse, exposants, chiffres cerclés ou mathématiques ramenés à leur forme usuelle) ;
 *  - les chiffres se comptent avec `\p{Nd}` (tous les systèmes d'écriture : arabes-indiens, dévanagari…), jamais avec `\d` ;
 *  - tout caractère qui n'est NI un chiffre NI une lettre sert de séparateur (espace, point, tiret, barre « / », deux-points, symbole, emoji…) : un texte qui porte
 *    HUIT chiffres ou plus, avec au plus TROIS séparateurs entre deux chiffres consécutifs, est tenu pour un numéro de téléphone. Une LETTRE entre deux chiffres
 *    casse la suite : « i7-1165G7 16 Go », « 1920x1080 » ne sont pas des numéros.
 * Ce que la règle ne prétend pas : deviner un numéro écrit en toutes lettres (« zéro sept zéro huit… »), coupé par plus de trois séparateurs entre deux
 * chiffres (« 07 ...... 08 ») ou par des lettres (« 07a08b09c10d11 » PASSE : limite assumée, le prix à payer pour ne pas refuser de vraies références techniques). Elle ne touche ni un prix (« 150 000 »), ni une capacité (« 256 Go »), ni une année (« 2024 ») : ces nombres restent
 * sous huit chiffres ou sont séparés par plus de trois caractères (« 128 Go 2024 »).
 */

/** Caractères de contrôle, de direction de texte et invisibles : jamais affichés. */
export const UNSAFE_TEXT = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

/** Nombre de chiffres à partir duquel un texte tient pour un numéro de téléphone (si les chiffres se suivent à moins de quatre caractères les uns des autres). */
export const PHONE_MIN_DIGITS = 8;
/** Nombre maximal de caractères non-chiffres entre deux chiffres consécutifs d'un même numéro. */
export const PHONE_MAX_GAP = 3;

const DIGIT = /\p{Nd}/u;
const LETTER = /\p{L}/u;
const DIGITS_GLOBAL = /\p{Nd}/gu;

/** Message affiché au vendeur dont l'annonce porte un numéro. */
export const PHONE_IN_OFFER_MESSAGE = "Pas de numéro de téléphone dans l'annonce : l'acheteur vous contactera par noma.";

/** Forme normalisée (NFKC) sur laquelle tous les contrôles portent. */
export function normalizePublicText(value: string): string {
  return value.normalize("NFKC");
}

/** Nombre de chiffres (tous systèmes d'écriture) du texte, après normalisation. */
export function countDigits(value: string): number {
  return (normalizePublicText(value).match(DIGITS_GLOBAL) ?? []).length;
}

/** Contient un caractère de contrôle, de direction ou invisible, avant OU après normalisation. */
export function hasUnsafeCharacters(value: string): boolean {
  return UNSAFE_TEXT.test(value) || UNSAFE_TEXT.test(normalizePublicText(value));
}

/** Groupe de chiffres ASCII qui est une année plausible (1900 à 2099) : « 2015 », « 2021 ». */
const YEAR_GROUP = /^(?:19|20)[0-9]{2}$/;

/**
 * Une suite de trois groupes qui est une DATE (« 2026-10-06 » : année, mois, jour ; « 06/10/2026 » : jour, mois, année) n'est pas un numéro : huit chiffres, mais ni un numéro
 * ivoirien (dix chiffres, groupes de deux) ni un format de numéro courant.
 */
function isDateGroups(groups: readonly string[]): boolean {
  if (groups.length !== 3 || !groups.every((group) => /^[0-9]+$/.test(group))) return false;
  const [first, second, third] = groups;
  const month = (text: string) => /^(0[1-9]|1[0-2])$/.test(text);
  const day = (text: string) => /^(0[1-9]|[12][0-9]|3[01])$/.test(text);
  return (YEAR_GROUP.test(first) && month(second) && day(third)) || (day(first) && month(second) && YEAR_GROUP.test(third));
}

/**
 * Ressemble à un numéro de téléphone : `PHONE_MIN_DIGITS` chiffres ou plus dans le même champ, deux chiffres consécutifs étant séparés par au plus
 * `PHONE_MAX_GAP` caractères non-chiffres, après normalisation NFKC. Une seule exception, pour ne pas casser les années : une suite dont TOUS les groupes de chiffres sont
 * des années à quatre chiffres (« 2015-2018 », « 2019 2021 ») n'est pas un numéro (un numéro ivoirien commence par 0 et se compose de groupes de deux chiffres) ; une date complète (« 2026-10-06 », « 06/10/2026 ») non plus.
 */
export function looksLikePhoneNumber(value: string): boolean {
  let digits = 0;
  let gap = 0;
  let groups: string[] = [];
  let group = "";
  const close = (): boolean => {
    if (group !== "") groups.push(group);
    group = "";
    const phone = digits >= PHONE_MIN_DIGITS && !groups.every((candidate) => YEAR_GROUP.test(candidate)) && !isDateGroups(groups);
    digits = 0;
    gap = 0;
    groups = [];
    return phone;
  };
  for (const character of normalizePublicText(value)) {
    if (DIGIT.test(character)) {
      digits += 1;
      gap = 0;
      group += character;
    } else if (digits > 0 && LETTER.test(character)) {
      // Une LETTRE entre deux chiffres casse la suite (« i7-1165G7 16 Go », « 1920x1080 » ne sont pas des numéros) ; ce qui précède est évalué.
      if (close()) return true;
    } else if (digits > 0) {
      gap += 1;
      if (group !== "") {
        groups.push(group);
        group = "";
      }
      if (gap > PHONE_MAX_GAP && close()) return true;
    }
  }
  return digits > 0 && close();
}

/**
 * Texte vendeur servi à un acheteur : `null` s'il porte un numéro de téléphone (le champ est alors omis de l'affichage), le texte inchangé sinon.
 * Les valeurs absentes restent absentes.
 */
export function publicFieldText<T extends string | null | undefined>(value: T): T | null {
  if (typeof value !== "string") return value ?? null;
  return looksLikePhoneNumber(value) ? null : value;
}

/** Vrai si l'un des textes porte un numéro de téléphone caché. */
export function anyLooksLikePhoneNumber(values: ReadonlyArray<string | null | undefined>): boolean {
  return values.some((value) => typeof value === "string" && looksLikePhoneNumber(value));
}
