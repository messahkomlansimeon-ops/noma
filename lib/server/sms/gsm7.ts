/**
 * Découpage des SMS (lot SMS1) : un message ne doit jamais dépasser UN segment, sous peine de payer plusieurs SMS (15 F CFA chacun) ou d'un refus du fournisseur.
 *
 * Règle du fournisseur (Meno) :
 *  - si TOUS les caractères appartiennent à l'alphabet par défaut GSM 03.38 (7 bits) : au plus 160 septets, les caractères de la table d'extension
 *    (^ { } \ [ ] ~ | € et le saut de page) comptant 2 septets chacun ;
 *  - sinon, le message part en UCS-2 : au plus 70 unités UTF-16 (un emoji vaut 2 unités).
 *
 * La table ci-dessous est celle de l'ETSI TS 123 038 (alphabet par défaut). Points qui piègent :
 *  - « ç » minuscule N'EST PAS dans la table : la position 0x09 est « Ç » (majuscule). Un texte avec « ç » part donc en UCS-2 (70 unités) ;
 *  - « é è ù ì ò à ä ö ñ ü » et « É Ç Ä Ö Ñ Ü » sont dans la table ; « â ê î ô û » et « œ » n'y sont pas (UCS-2) ;
 *  - le caractère d'échappement (0x1B) n'est pas un caractère de texte.
 * Le contrôle est volontairement STRICT : en cas de doute le texte est compté comme UCS-2 (limite plus basse), jamais comme GSM-7.
 */

/** Table de base : l'index est le code GSM. L'échappement (0x1B) est un marqueur, absent du jeu de caractères valides. */
export const GSM7_BASIC_TABLE: readonly string[] = Array.from(
  "@£$¥èéùìòÇ\nØø\rÅå" +
    "Δ_ΦΓΛΩΠΨΣΘΞ\u001bÆæßÉ" +
    " !\"#¤%&'()*+,-./" +
    "0123456789:;<=>?" +
    "¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§" +
    "¿abcdefghijklmnopqrstuvwxyzäöñüà",
);

/** Table d'extension (précédée de l'échappement) : chaque caractère compte 2 septets. */
export const GSM7_EXTENSION_CHARACTERS: readonly string[] = Object.freeze(["\f", "^", "{", "}", "\\", "[", "~", "]", "|", "€"]);

const BASIC_SET: ReadonlySet<string> = new Set(GSM7_BASIC_TABLE.filter((character) => character !== "\u001b"));
const EXTENSION_SET: ReadonlySet<string> = new Set(GSM7_EXTENSION_CHARACTERS);

export const SMS_GSM7_LIMIT = 160;
export const SMS_UCS2_LIMIT = 70;

export type SmsEncoding = "gsm7" | "ucs2";

export interface SmsAnalysis {
  encoding: SmsEncoding;
  /** Septets (GSM-7, extension comptée 2) ou unités UTF-16 (UCS-2). */
  units: number;
  /** Limite d'UN segment pour cet encodage. */
  limit: number;
  /** Vrai si le texte tient dans un seul segment (et n'est pas vide). */
  singleSegment: boolean;
}

/** Septets du texte s'il est entièrement GSM-7, sinon null. */
export function gsm7Length(content: string): number | null {
  let septets = 0;
  for (const character of content) {
    if (BASIC_SET.has(character)) septets += 1;
    else if (EXTENSION_SET.has(character)) septets += 2;
    else return null;
  }
  return septets;
}

export function analyzeSms(content: string): SmsAnalysis {
  const septets = gsm7Length(content);
  if (septets !== null) {
    return { encoding: "gsm7", units: septets, limit: SMS_GSM7_LIMIT, singleSegment: septets >= 1 && septets <= SMS_GSM7_LIMIT };
  }
  // Unités UTF-16 : `length` compte les unités (un emoji vaut 2), exactement la règle du fournisseur.
  const units = content.length;
  return { encoding: "ucs2", units, limit: SMS_UCS2_LIMIT, singleSegment: units >= 1 && units <= SMS_UCS2_LIMIT };
}

/** Texte acceptable : une chaîne non vide, sans caractère nul, d'un seul segment. */
export function isSingleSegmentSms(content: unknown): content is string {
  return typeof content === "string" && !content.includes("\u0000") && analyzeSms(content).singleSegment;
}
