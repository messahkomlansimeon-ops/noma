/**
 * Détection d'un numéro de téléphone caché dans un texte saisi par un vendeur (lots D1 puis D3). Module PUR, sans dépendance serveur : il sert aussi bien à
 * l'affichage (jamais servi à un acheteur) qu'à la publication (refusé à la source). Règle UNIQUE, partagée, bâtie autour des numéros IVOIRIENS et
 * internationaux EXPLICITES (le lot D1 comptait huit chiffres « à moins de quatre caractères les uns des autres » : elle refusait « 2400×1080 », « 12 500 000 FCFA »,
 * « Réf. 9300-1234 », un EAN ou un IMEI, et laissait passer « 07 O8 09 10 11 »).
 *
 * 1. NORMALISATION (avant tout contrôle) :
 *    - NFKC (pleine chasse, exposants, chiffres cerclés ou mathématiques ramenés à leur forme usuelle) ;
 *    - les caractères invisibles (formats, ignorables, marques combinantes : espace de largeur nulle, sélecteur de variante, cadre de touche d'emoji) sont ôtés ;
 *    - tout chiffre `\p{Nd}` de tout alphabet devient un chiffre ASCII (arabes-indiens, dévanagari, thaï…), les chiffres cerclés noirs aussi ;
 *    - SOSIES de chiffres (O, o, О, о, Ο, ο → 0 ; l, I, і, ı, | → 1) : convertis SEULEMENT dans un mot qui ne porte que des chiffres et des sosies (« O7 », « l0 »,
 *      « ll »), jamais dans « Olivier » ou « S21 » ; un mot de sosies sans chiffre (« ll ») n'est converti que collé à un tel mot (séparateur de groupe entre les deux).
 *      Le texte est contrôlé SOUS SES DEUX LECTURES (sosies lus comme lettres, puis comme chiffres) : une seule suffit.
 * 2. GROUPES : un groupe est une suite de chiffres. Deux groupes se suivent (appartiennent à la même suite) si ce qui les sépare est
 *    - un SÉPARATEUR : au plus `PHONE_MAX_GAP` (3) caractères qui ne sont NI chiffres NI lettres (espace, point, tiret, barre, deux-points, symbole, emoji…) ; ou
 *    - UNE LETTRE OU UNE SUITE DE LETTRES SEULE (« x », « o », « et », « puis »), de 8 lettres au plus, avec au plus une espace de chaque côté (jamais un symbole : « 08h-12h »), entre deux groupes de
 *      1 ou 2 chiffres, SI la suite compte au moins 4 groupes (« 07x08x09x10x11 », « 07 puis 08 et 09 puis 10 puis 11 »).
 * 3. EST UN NUMÉRO, dans une suite de groupes, à partir de n'importe quel groupe :
 *    (a) 10 chiffres formant un numéro ivoirien (premiers chiffres 01, 05, 07, 21, 25 ou 27), groupes et séparateurs quelconques ;
 *    (b) un indicatif « 00225 » ou « 225 » (en tête d'un groupe) suivi de 8 ou 10 chiffres ;
 *    (c) « + » suivi de 8 à 15 chiffres (international, « +225 », « +33 6 12… ») ;
 *    (d') (lot D3-bis) 4 groupes de 2 chiffres EXACTEMENT, séparés SEULEMENT par des symboles ou des espaces (jamais par une lettre ni un mot), dont le PREMIER commence par 0
 *        (« 07 08 09 10 », « 07-08-09-10-11 ») ; « 11 12 13 14 », « 32 40 43 50 », « 38 40 42 44 » ne sont pas des numéros. Les lettres et les mots ne séparent des groupes que pour (a), (b) et (c),
 *        qui exigent 10 chiffres avec un préfixe ivoirien ou un indicatif (« 07x08x09x10x11 » reste un numéro, « 07x08x09x10 » n'en est plus un).
 * 4. N'EST PAS UN NUMÉRO :
 *    - une quantité à milliers groupés par 3 (« 12 500 000 », « 12.500.000 ») : un premier groupe de 1 à 3 chiffres sans zéro initial, puis des groupes de 3 chiffres. Chaque quantité est
 *      NEUTRALISÉE comme un jeton AVANT les règles (a) à (d') : deux quantités ne se fusionnent jamais en un numéro (« 250 000 - 1 300 000 », « 1 250 000 - 1 300 000 FCFA ») ;
 *      exceptions (la quantité reste soumise aux règles) : précédée d'un « + », ou collée, avec un seul séparateur de milliers, à un groupe qui n'est pas une quantité (« 225 070 809 1011 », « 0 708 091 011 ») ;
 *    - une dimension A×B, A*B ou AxB à 2 ou 3 termes (« 2400×1080 », « 12,50x12,50x12,50 ») : chaque terme est contrôlé seul, le produit ne forme jamais un numéro ;
 *    - une référence, une année, une date ou une heure qui n'est couverte par aucune des règles (a) à (d') (« Réf. 9300-1234 », « S/N 12345678 », « Facture n° 00012345 »,
 *      « 2026-10-06 », « 06/10/2026 », « 14:30 ») ;
 *    - une suite de 11 à 14 chiffres qui ne commence pas par un indicatif (EAN-13, IMEI partiel).
 *
 * LIMITES ASSUMÉES (documentées dans DEMO.md et MESURES.md, testées) :
 *    - un numéro coupé entre plusieurs champs ou plusieurs attributs distincts (« a : 07 08 09 », « b : 10 11 »), ou entre les éléments d'une liste, n'est PAS détecté : les
 *      champs ne sont jamais concaténés, pour ne pas refuser des annonces honnêtes ;
 *    - un numéro écrit en toutes lettres (« zéro sept zéro huit… ») ou séparé par plus de trois symboles, ou par une lettre accolée à un symbole (« 07x-08 ») n'est pas détecté ;
 *    - ni un numéro coupé par des lettres dans des groupes de plus de deux chiffres (« 0708x091011 ») ;
 *    - un numéro de 8 chiffres écrit avec des lettres entre les groupes (« 07x08x09x10 ») ou de quatre groupes de deux chiffres dont le premier ne commence pas par 0 n'est pas détecté ;
 *    - un numéro de fixe 21, 25 ou 27 écrit en milliers sans lettre (« 2 712 345 678 ») est pris pour une quantité ;
 *    - quelques textes honnêtes restent refusés : quatre nombres de deux chiffres à la suite dont le premier commence par 0 (« remises 05 10 15 20 »).
 */

/** Caractères de contrôle, de direction de texte et invisibles : jamais affichés. */
export const UNSAFE_TEXT = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

/** Nombre de chiffres de la règle (d') : quatre groupes de deux chiffres. */
export const PHONE_MIN_DIGITS = 8;
/** Nombre maximal de caractères non-chiffres non-lettres entre deux groupes d'une même suite. */
export const PHONE_MAX_GAP = 3;
/** Un numéro ivoirien compte 10 chiffres, sans l'indicatif. */
export const IVORIAN_NUMBER_LENGTH = 10;
/** Premiers chiffres d'un numéro ivoirien (mobiles : 01 Moov, 05 MTN, 07 Orange ; fixes : 21, 25, 27). */
export const IVORIAN_PREFIXES: readonly string[] = Object.freeze(["01", "05", "07", "21", "25", "27"]);
/** Indicatif de la Côte d'Ivoire. */
export const IVORIAN_COUNTRY_CODE = "225";
/** Longueur maximale d'un numéro international (E.164), indicatif compris. */
export const INTERNATIONAL_MAX_DIGITS = 15;
/** Nombre de groupes à partir duquel une lettre peut servir de séparateur. */
export const LETTER_SEPARATOR_MIN_GROUPS = 4;
/** Longueur maximale (lettres) d'un mot qui sert de séparateur de groupe. */
export const LETTER_SEPARATOR_MAX_LETTERS = 8;

/** Champs textuels d'une annonce que l'acheteur voit (et que la règle contrôle). */
export type OfferTextField = "category" | "brand" | "model" | "variant" | "condition" | "unit" | "location" | "attributes";

export const OFFER_TEXT_FIELDS: readonly OfferTextField[] = Object.freeze(["category", "brand", "model", "variant", "condition", "unit", "location", "attributes"]);

/** Nom français du champ, tel qu'il s'écrit dans le message de refus. */
export const OFFER_FIELD_LABELS: Readonly<Record<OfferTextField, string>> = Object.freeze({
  category: "catégorie",
  brand: "marque",
  model: "modèle",
  variant: "variante",
  condition: "état",
  unit: "unité",
  location: "localisation",
  attributes: "attributs",
});

/** Message de refus sans champ (champ inconnu) : une annonce porte un numéro de téléphone. */
export const PHONE_IN_OFFER_MESSAGE = "Pas de numéro de téléphone dans l'annonce : l'acheteur vous contactera par noma.";

/** Message de refus avec le champ concerné : « Pas de numéro de téléphone dans l'annonce (champ : variante) : l'acheteur vous contactera par noma. » */
export function phoneInOfferMessage(field?: OfferTextField | null): string {
  if (field === undefined || field === null || !OFFER_TEXT_FIELDS.includes(field)) return PHONE_IN_OFFER_MESSAGE;
  return `Pas de numéro de téléphone dans l'annonce (champ : ${OFFER_FIELD_LABELS[field]}) : l'acheteur vous contactera par noma.`;
}

/** Message de refus d'un nom d'attribut hors de [a-z_] (jamais le nom saisi : seul le rappel de la règle). */
export const ATTRIBUTE_KEY_MESSAGE = "Nom d'attribut invalide (champ : attributs) : seules les lettres minuscules sans accent et le tiret bas sont acceptés.";

/** Nom d'attribut accepté à la publication : lettres minuscules sans accent et tiret bas SEULEMENT (aucun chiffre, aucune majuscule, aucun séparateur). */
const ATTRIBUTE_KEY = /^[a-z_]+$/;
/** Clé d'un objet IMBRIQUÉ dans un attribut (« value », « unit », « sourceUnit » de l'extraction) : lettres et tiret bas, jamais un chiffre (rien n'en est affiché sauf « value » et « unit »). */
const NESTED_ATTRIBUTE_KEY = /^[A-Za-z_]+$/;

/** Nom d'un attribut de l'annonce (niveau supérieur de `attributes`) : [a-z_] seulement. */
export function isValidOfferAttributeKey(key: string): boolean {
  return ATTRIBUTE_KEY.test(key);
}

/** Clé d'un objet imbriqué dans un attribut : lettres (majuscules admises : `sourceUnit`) et tiret bas, sans chiffre. */
export function isValidNestedAttributeKey(key: string): boolean {
  return NESTED_ATTRIBUTE_KEY.test(key);
}

const ND = /^\p{Nd}$/u;
const LETTER = /\p{L}/u;
const DIGITS_GLOBAL = /\p{Nd}/gu;
/** Caractères invisibles ôtés avant tout contrôle : formats (largeur nulle, direction…), ignorables, marques combinantes (sélecteur de variante, cadre de touche d'emoji). */
const INVISIBLE = /[\p{Cf}\p{Default_Ignorable_Code_Point}\p{Mn}\p{Me}]/gu;

/** Chiffres cerclés « noirs » et dingbats (❶ à ❿, ➀ à ➉, ➊ à ➓, ⓿) que NFKC ne ramène pas : code de départ → valeur du premier. */
const DINGBAT_DIGIT_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x2776, 0x277f],
  [0x2780, 0x2789],
  [0x278a, 0x2793],
];

const digitValueCache = new Map<number, number>();

/**
 * Valeur (0 à 9) d'un chiffre `\p{Nd}` non ASCII. Unicode garantit que les chiffres décimaux viennent par séries consécutives de dix, de 0 à 9 : la valeur est la
 * position dans la série, modulo dix (des séries voisines forment un bloc dont chaque série commence à zéro).
 */
function digitValue(codePoint: number): number {
  const known = digitValueCache.get(codePoint);
  if (known !== undefined) return known;
  let start = codePoint;
  while (start > 0 && ND.test(String.fromCodePoint(start - 1))) start -= 1;
  const value = (codePoint - start) % 10;
  digitValueCache.set(codePoint, value);
  return value;
}

/** Forme normalisée (NFKC) sur laquelle tous les contrôles d'affichage portent. */
export function normalizePublicText(value: string): string {
  return value.normalize("NFKC");
}

/** Nombre de chiffres (tous systèmes d'écriture) du texte, après normalisation. */
export function countDigits(value: string): number {
  return (analysisText(value).match(DIGITS_GLOBAL) ?? []).length;
}

/** Contient un caractère de contrôle, de direction ou invisible, avant OU après normalisation. */
export function hasUnsafeCharacters(value: string): boolean {
  return UNSAFE_TEXT.test(value) || UNSAFE_TEXT.test(normalizePublicText(value));
}

/** Texte d'analyse : NFKC, invisibles ôtés, plus du dingbat « + » ramené à « + ». Les chiffres restent dans leur alphabet (voir `asciiDigits`). */
function analysisText(value: string): string {
  return value.normalize("NFKC").replace(INVISIBLE, "");
}

/** Tout chiffre de tout alphabet devient un chiffre ASCII ; les dingbats numérotés (❶…) et le plus gras (➕) aussi. */
function asciiDigits(text: string): string {
  let out = "";
  for (const character of text) {
    const codePoint = character.codePointAt(0) as number;
    if (codePoint < 0x80) {
      out += character;
      continue;
    }
    if (codePoint === 0x24ff) {
      out += "0";
      continue;
    }
    if (codePoint === 0x2795) {
      out += "+";
      continue;
    }
    const dingbat = DINGBAT_DIGIT_RANGES.find(([first, last]) => codePoint >= first && codePoint <= last);
    if (dingbat) {
      out += String(codePoint - dingbat[0] + 1);
      continue;
    }
    out += ND.test(character) ? String(digitValue(codePoint)) : character;
  }
  return out;
}

/** Sosies de zéro et de un (après NFKC, qui ramène déjà « º », « Ⅰ », « ℓ », « 0 » pleine chasse à leur forme usuelle). */
const ZERO_LOOKALIKES: ReadonlySet<string> = new Set(["O", "o", "Ο", "ο", "О", "о", "Օ", "〇"]);
const ONE_LOOKALIKES: ReadonlySet<string> = new Set(["l", "I", "і", "ı", "Ι", "І", "ӏ", "ǀ"]);
const PIPE = "|";

type WordKind = "seed" | "weak" | "other";

interface Word {
  start: number;
  end: number;
  kind: WordKind;
}

const isAsciiDigit = (character: string): boolean => character >= "0" && character <= "9";
const isLookalike = (character: string): boolean => ZERO_LOOKALIKES.has(character) || ONE_LOOKALIKES.has(character);
const isWordCharacter = (character: string): boolean => isAsciiDigit(character) || isLookalike(character) || character === PIPE || LETTER.test(character);

/**
 * Seconde lecture du texte : les sosies de chiffres sont lus comme des chiffres, mais SEULEMENT dans un mot qui ne porte que des chiffres et des sosies (un « mot » est une suite
 * de lettres, de chiffres et de barres verticales ; ce qui l'entoure sert de séparateur de groupe). Un mot de sosies sans aucun chiffre (« ll ») n'est converti que s'il touche
 * (séparateur de groupe entre les deux) un mot converti. Une barre verticale seule reste un séparateur. Renvoie null si rien ne change.
 */
function lookalikeReading(text: string): string | null {
  const characters = [...text];
  const words: Word[] = [];
  let index = 0;
  while (index < characters.length) {
    if (!isWordCharacter(characters[index])) {
      index += 1;
      continue;
    }
    const start = index;
    let hasDigit = false;
    let hasLookalike = false;
    let hasOther = false;
    while (index < characters.length && isWordCharacter(characters[index])) {
      const character = characters[index];
      if (isAsciiDigit(character)) hasDigit = true;
      else if (isLookalike(character)) hasLookalike = true;
      else if (character !== PIPE) hasOther = true;
      index += 1;
    }
    let kind: WordKind = "other";
    if (!hasOther) {
      if (hasDigit) kind = "seed";
      else if (hasLookalike) kind = "weak";
    }
    words.push({ start, end: index, kind });
  }
  if (!words.some((word) => word.kind !== "other")) return null;
  const converted = words.map((word) => word.kind === "seed");
  const near = (left: Word, right: Word): boolean => right.start - left.end <= PHONE_MAX_GAP;
  for (let at = 1; at < words.length; at += 1) {
    if (words[at].kind === "weak" && converted[at - 1] && near(words[at - 1], words[at])) converted[at] = true;
  }
  for (let at = words.length - 2; at >= 0; at -= 1) {
    if (words[at].kind === "weak" && converted[at + 1] && near(words[at], words[at + 1])) converted[at] = true;
  }
  let changed = false;
  words.forEach((word, at) => {
    if (!converted[at]) return;
    for (let position = word.start; position < word.end; position += 1) {
      const character = characters[position];
      if (ZERO_LOOKALIKES.has(character)) {
        characters[position] = "0";
        changed = true;
      } else if (ONE_LOOKALIKES.has(character) || character === PIPE) {
        characters[position] = "1";
        changed = true;
      }
    }
  });
  return changed ? characters.join("") : null;
}

/** Groupe de chiffres et ce qui le précède (le texte entre le groupe précédent, ou le début du texte, et lui). */
interface Run {
  digits: string;
  gap: string;
}

function runsOf(text: string): Run[] {
  const runs: Run[] = [];
  let digits = "";
  let gap = "";
  for (const character of text) {
    if (isAsciiDigit(character)) {
      digits += character;
      continue;
    }
    if (digits !== "") {
      runs.push({ digits, gap });
      digits = "";
      gap = "";
    }
    gap += character;
  }
  if (digits !== "") runs.push({ digits, gap });
  return runs;
}

interface Link {
  kind: "symbol" | "letter";
  /** Signe de produit entre deux termes d'une dimension (« × », « * », « x »). */
  product: boolean;
}

const PRODUCT_SIGNS: ReadonlySet<string> = new Set(["×", "*", "✕", "✖", "⨯", "x", "X", "х", "Х"]);
const LETTER_SEPARATOR = new RegExp(`^ ?\\p{L}{1,${LETTER_SEPARATOR_MAX_LETTERS}} ?$`, "u");

/** Lien entre deux groupes consécutifs, ou null s'ils ne se suivent pas. */
function linkBetween(left: Run, right: Run): Link | null {
  const gap = right.gap;
  if (!LETTER.test(gap)) {
    return [...gap].length <= PHONE_MAX_GAP ? { kind: "symbol", product: PRODUCT_SIGNS.has(gap.trim()) } : null;
  }
  if (left.digits.length > 2 || right.digits.length > 2) return null;
  if (!LETTER_SEPARATOR.test(gap)) return null;
  return { kind: "letter", product: PRODUCT_SIGNS.has(gap.trim()) };
}

interface Chain {
  runs: Run[];
  /** links[k] relie runs[k] à runs[k + 1]. */
  links: Link[];
}

function chainsOf(runs: Run[]): Chain[] {
  const chains: Chain[] = [];
  let current: Chain | null = null;
  for (let index = 0; index < runs.length; index += 1) {
    const link: Link | null = index === 0 ? null : linkBetween(runs[index - 1], runs[index]);
    if (current === null || link === null) {
      current = { runs: [runs[index]], links: [] };
      chains.push(current);
    } else {
      current.runs.push(runs[index]);
      current.links.push(link);
    }
  }
  return chains;
}

/** Découpe une suite à chaque lien qui satisfait `cut` ; les groupes gardent ce qui les précède (donc un « + » reste visible). */
function splitAt(chain: Chain, cut: (link: Link) => boolean): Chain[] {
  const parts: Chain[] = [];
  let current: Chain = { runs: [chain.runs[0]], links: [] };
  parts.push(current);
  chain.links.forEach((link, index) => {
    if (cut(link)) {
      current = { runs: [chain.runs[index + 1]], links: [] };
      parts.push(current);
    } else {
      current.runs.push(chain.runs[index + 1]);
      current.links.push(link);
    }
  });
  return parts;
}

/** Séparateurs d'un groupe de milliers : un seul caractère, jamais une lettre. */
const THOUSANDS_SEPARATORS: ReadonlySet<string> = new Set([" ", ".", ",", "'", "’"]);

/**
 * Quantité à milliers groupés par 3 : « 12 500 000 », « 12.500.000 », « 25 000 ». Un premier groupe de 1 à 3 chiffres SANS zéro initial, puis des groupes de 3 chiffres,
 * chacun relié au précédent par un seul séparateur de milliers. Renvoie l'indice du dernier groupe de la quantité qui commence en `from`, ou -1 si ce n'en est pas une.
 */
function thousandsQuantityEnd(chain: Chain, from: number): number {
  if (!/^[1-9][0-9]{0,2}$/.test(chain.runs[from].digits)) return -1;
  let end = from;
  while (end + 1 < chain.runs.length) {
    const link = chain.links[end];
    const next = chain.runs[end + 1];
    if (link.kind !== "symbol" || next.digits.length !== 3 || !THOUSANDS_SEPARATORS.has(next.gap)) break;
    end += 1;
  }
  return end > from ? end : -1;
}

/** Un « + » (suivi d'au plus deux espaces ou parenthèses) précède-t-il le groupe ? */
const PLUS_BEFORE = /\+[ (]{0,2}$/;

/**
 * NEUTRALISE chaque quantité à milliers groupés comme un JETON avant les règles (a) à (d) (lot D3-bis) : une quantité n'est plus une suite de groupes de chiffres, elle ne prend donc part
 * à aucun numéro, et deux quantités ne se fusionnent jamais en un numéro (« 250 000 - 1 300 000 », « 1 250 000 - 1 300 000 FCFA » : le préfixe 25 ne fait pas un numéro de fixe). La suite est
 * découpée aux quantités ; les groupes qui restent gardent leurs liens. Une quantité n'est PAS neutralisée (elle reste soumise aux règles) quand
 *  - un « + » la précède (« +33 612 345 678 », « +1 234 567 8901 » sont des numéros internationaux qui ressemblent à des milliers) ;
 *  - elle est suivie ou précédée, avec un seul séparateur de milliers, d'un groupe qui n'est pas une quantité (« 225 070 809 1011 », « 27 123 456 78 », « 0 708 091 011 » : des numéros
 *    écrits en trois chiffres).
 */
function withoutQuantities(chain: Chain): Chain[] {
  const count = chain.runs.length;
  const kept = chain.runs.map(() => true);
  let at = 0;
  while (at < count) {
    const end = thousandsQuantityEnd(chain, at);
    if (end < 0) {
      at += 1;
      continue;
    }
    const follower = end + 1 < count ? end + 1 : -1;
    const attachedLoneGroup = follower >= 0 && chain.links[end].kind === "symbol" && THOUSANDS_SEPARATORS.has(chain.runs[follower].gap) && thousandsQuantityEnd(chain, follower) < 0;
    // Collée, par un seul séparateur de milliers, à un groupe qui n'est pas une quantité (« 0 708 091 011 ») : ce n'est pas le début d'une quantité.
    const attachedToLoneGroup = at > 0 && kept[at - 1] && chain.links[at - 1].kind === "symbol" && THOUSANDS_SEPARATORS.has(chain.runs[at].gap);
    if (!PLUS_BEFORE.test(chain.runs[at].gap) && !attachedLoneGroup && !attachedToLoneGroup) for (let index = at; index <= end; index += 1) kept[index] = false;
    at = end + 1;
  }
  if (kept.every(Boolean)) return [chain];
  const pieces: Chain[] = [];
  let start = -1;
  for (let index = 0; index <= count; index += 1) {
    if (index < count && kept[index]) {
      if (start < 0) start = index;
      continue;
    }
    if (start >= 0) pieces.push({ runs: chain.runs.slice(start, index), links: chain.links.slice(start, index - 1) });
    start = -1;
  }
  return pieces;
}

/** Règles (a) à (d') sur UNE suite de groupes (quantités neutralisées, termes d'une dimension séparés, lettres déjà validées). */
function matchesPhoneRules(chain: Chain): boolean {
  const { runs } = chain;
  // (d') quatre groupes de DEUX chiffres exactement, séparés SEULEMENT par des symboles ou des espaces (jamais par une lettre ni un mot), le PREMIER commençant par 0
  // (« 07 08 09 10 ») : « 11 12 13 14 », « 32 40 43 50 », « 38 40 42 44 » ne sont pas des numéros.
  for (let from = 0; from + 3 < runs.length; from += 1) {
    if (runs[from].digits.length !== 2 || runs[from].digits[0] !== "0") continue;
    let sequence = true;
    for (let step = 0; step < 3 && sequence; step += 1) sequence = runs[from + step + 1].digits.length === 2 && chain.links[from + step].kind === "symbol";
    if (sequence) return true;
  }
  for (let from = 0; from < runs.length; from += 1) {
    let digits = "";
    for (let to = from; to < runs.length; to += 1) {
      digits += runs[to].digits;
      if (digits.length > INTERNATIONAL_MAX_DIGITS) break;
      const length = digits.length;
      let candidate = false;
      // (a) 10 chiffres d'un numéro ivoirien.
      if (length === IVORIAN_NUMBER_LENGTH && IVORIAN_PREFIXES.includes(digits.slice(0, 2))) candidate = true;
      // (c) « + » suivi de 8 à 15 chiffres.
      if (!candidate && length >= 8 && PLUS_BEFORE.test(runs[from].gap)) candidate = true;
      // (b) indicatif « 00225 » ou « 225 » (en tête de groupe) suivi de 8 ou 10 chiffres.
      if (!candidate) {
        const code = digits.startsWith(`00${IVORIAN_COUNTRY_CODE}`) ? 5 : runs[from].digits.startsWith(IVORIAN_COUNTRY_CODE) ? 3 : 0;
        if (code > 0 && (length - code === 8 || length - code === 10)) candidate = true;
      }
      if (candidate) return true;
    }
  }
  return false;
}

/** Suite de groupes SANS quantité : les lettres ne séparent que dans une suite d'au moins 4 groupes ; une dimension A×B à 2 ou 3 termes est contrôlée terme par terme. */
function analyzeNeutralized(chain: Chain): boolean {
  if (chain.links.some((link) => link.kind === "letter") && chain.runs.length < LETTER_SEPARATOR_MIN_GROUPS) {
    return splitAt(chain, (link) => link.kind === "letter").some(analyzeNeutralized);
  }
  const products = chain.links.filter((link) => link.product).length;
  if (products === 1 || products === 2) return splitAt(chain, (link) => link.product).some(analyzeNeutralized);
  return matchesPhoneRules(chain);
}

/** Suite de groupes : les quantités à milliers sont neutralisées d'abord, puis chaque morceau est contrôlé. */
function analyzeChain(chain: Chain): boolean {
  return withoutQuantities(chain).some(analyzeNeutralized);
}

function readingLooksLikePhoneNumber(text: string): boolean {
  return chainsOf(runsOf(text)).some(analyzeChain);
}

/**
 * Ressemble à un numéro de téléphone (règle complète en tête de ce fichier) : numéro ivoirien de 10 chiffres sous toute mise en forme, indicatif +225 / 00225 / 225,
 * « + » et 8 à 15 chiffres, ou quatre groupes de deux chiffres à la suite ; texte normalisé NFKC, chiffres de tout alphabet, sosies de chiffres lus sous leurs deux formes.
 * Ni une quantité à milliers groupés, ni une dimension, ni une référence, un EAN, une année ou une date ne sont des numéros.
 */
export function looksLikePhoneNumber(value: string): boolean {
  if (typeof value !== "string" || value === "") return false;
  const reading = asciiDigits(analysisText(value));
  if (readingLooksLikePhoneNumber(reading)) return true;
  const alternative = lookalikeReading(reading);
  return alternative !== null && readingLooksLikePhoneNumber(alternative);
}

/**
 * Nombres AUTONOMES d'un texte (tout alphabet ramené à ASCII), sous ses deux lectures (sosies lus comme lettres, puis comme chiffres) : une suite de chiffres qui ne touche aucune lettre
 * ni aucun autre chiffre (« 0708 » dans « iPhone 0708 », « 128 » dans « 128 Go » ; pas « 21 » de « S21 », ni « 5 » de « 5G »). Un chiffre collé à un mot de lettres appartient à un nom de
 * produit (S21, 5G, A52s), pas à un numéro écrit : ils ne forment pas le squelette numérique.
 */
const STANDALONE_NUMBER = /(?<![\p{L}\p{N}])[0-9]+(?![\p{L}\p{N}])/gu;

function digitGroupsOf(value: string): { plain: string[]; lookalike: string[] } {
  const reading = asciiDigits(analysisText(value));
  const plain = reading.match(STANDALONE_NUMBER) ?? [];
  const alternative = lookalikeReading(reading);
  return { plain, lookalike: alternative === null ? plain : (alternative.match(STANDALONE_NUMBER) ?? []) };
}

/**
 * La règle des numéros appliquée à PLUSIEURS champs libres ENSEMBLE (lot MV1-bis, missions d'achat en volume) : un numéro coupé entre deux champs n'échappe pas au contrôle. Un des
 * trois contrôles suffit à refuser :
 *  1. chaque texte seul (`looksLikePhoneNumber`) ;
 *  2. leur CONCATÉNATION, séparés par une espace (« Tél 07 08 » puis « 09 10 11 » : champs voisins) ;
 *  3. leur SQUELETTE NUMÉRIQUE : seuls les nombres AUTONOMES de chaque texte (une suite de chiffres qui ne touche aucune lettre), dans l'ordre des champs, lettres ôtées (« iPhone 0708 »
 *     puis « Cocody 091011 » : « 0708 091011 »). Les chiffres collés à un nom (S21, 5G) n'y sont pas : « Galaxy S21 », « 128 Go 5G », « 2023 » ne forment pas un numéro.
 * Limites assumées : un numéro écrit en toutes lettres, ou dont des morceaux sont dans des champs différents sous forme de lettres et de chiffres mêlés (« zéro sept » + « 08 »), ou
 * collés à un mot (« iPhone0708 »), n'est pas détecté ; deux champs ou plus qui portent chacun d'autres nombres autonomes entre les morceaux d'un numéro (« 0708 », puis « 12 », « 128 »,
 * puis « 091011 ») peuvent le masquer (les nombres de ces champs s'intercalent dans le squelette) ; un texte honnête dont les nombres autonomes, mis bout à bout, forment un numéro
 * (quatre nombres de deux chiffres dont le premier commence par 0, ou 10 chiffres d'un préfixe ivoirien) est refusé.
 */
export function looksLikePhoneNumberAcross(values: ReadonlyArray<string | null | undefined>): boolean {
  const texts = values.filter((value): value is string => typeof value === "string" && value !== "");
  if (texts.some((text) => looksLikePhoneNumber(text))) return true;
  if (texts.length < 2) return false;
  if (looksLikePhoneNumber(texts.join(" "))) return true;
  const groups = texts.map(digitGroupsOf);
  const skeleton = (pick: (entry: { plain: string[]; lookalike: string[] }) => string[]): string => groups.flatMap(pick).join(" ");
  const plain = skeleton((entry) => entry.plain);
  const lookalike = skeleton((entry) => entry.lookalike);
  return (plain !== "" && looksLikePhoneNumber(plain)) || (lookalike !== plain && lookalike !== "" && looksLikePhoneNumber(lookalike));
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
