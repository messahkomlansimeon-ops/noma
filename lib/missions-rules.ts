/**
 * Règles des missions d'achat en volume (lot MV1). Module PUR partagé par le serveur, le formulaire et les écrans : aucune dépendance serveur, aucun accès à la base.
 *
 * Une mission : « 20 iPhone 12, 170 000 FCFA l'unité au plus, 3 200 000 FCFA au total au plus, à Abidjan, sous 30 jours ». Champs, dans cet ordre :
 *  - clé produit : catégorie, marque, modèle, variante (facultative), état ;
 *  - quantité totale (entier de 2 à 10 000) et unité ;
 *  - budget unitaire maximal et budget total maximal (FCFA entiers ; le total est au moins égal à l'unité) ;
 *  - lieu (facultatif) et durée (de 1 à 90 jours).
 * Tout champ texte est contrôlé par la MÊME règle des numéros que les annonces (`lib/phone-text.ts`, lots D1 et D3) : un champ qui ressemble à un numéro de téléphone est
 * refusé, champ par champ ; puis TOUS les champs libres (catégorie, marque, modèle, variante, état, unité, lieu) sont contrôlés ENSEMBLE (`looksLikePhoneNumberAcross` : leur
 * concatenation et leur squelette numérique, un numéro coupé entre deux champs est refusé) ; le titre ASSEMBLÉ (marque, modèle, variante) compte au plus 8 chiffres au total.
 * Chaque champ porte au moins une lettre ou un chiffre ; sont refusés les caractères de contrôle, de direction de texte et invisibles (dont tout caractère ignorable par défaut
 * d'Unicode, le cadratin braille vide et les remplisseurs Hangul) et les marques combinantes isolées.
 * Voir MISSIONS.md.
 */

import { countDigits, hasUnsafeCharacters, looksLikePhoneNumber, looksLikePhoneNumberAcross, normalizePublicText } from "./phone-text";

export const MISSIONS_CONTRACT_VERSION = "missions/v1" as const;

export const MISSION_QUANTITY_MIN = 2;
export const MISSION_QUANTITY_MAX = 10_000;
export const MISSION_UNIT_BUDGET_MAX = 100_000_000;
export const MISSION_TOTAL_BUDGET_MAX = 1_000_000_000_000;
export const MISSION_DEADLINE_DAYS_MIN = 1;
export const MISSION_DEADLINE_DAYS_MAX = 90;
export const MISSION_DEADLINE_DAYS_DEFAULT = 30;
/** Au plus 5 missions ACTIVES par acheteur ; au plus 20 créations de mission par jour UTC. */
export const MISSION_ACTIVE_LIMIT = 5;
export const MISSION_CREATIONS_PER_DAY = 20;
/** Une proposition de répartition n'implique jamais plus de 10 vendeurs. */
export const MISSION_SELLERS_MAX = 10;
/** Longueurs maximales (caractères) : un morceau du titre (3 × 50 + 2 espaces + « 10000 × » ≤ 160), l'unité, le lieu. */
export const MISSION_PART_MAX = 50;
export const MISSION_UNIT_MAX = 20;
export const MISSION_LOCATION_MAX = 80;
/** Chiffres au plus dans le titre assemblé (marque, modèle, variante) : comme le titre d'une notification. */
export const MISSION_TITLE_MAX_DIGITS = 8;
/** Quantité d'une commande (déclaration d'achat) : de 1 à 10 000. */
export const ORDER_QUANTITY_MIN = 1;
export const ORDER_QUANTITY_MAX = 10_000;

export type MissionStatus = "draft" | "active" | "paused" | "completed" | "cancelled" | "expired";
export const MISSION_STATUSES: readonly MissionStatus[] = Object.freeze(["draft", "active", "paused", "completed", "cancelled", "expired"]);
export type MissionAction = "activate" | "pause" | "resume" | "cancel";
export const MISSION_ACTIONS: readonly MissionAction[] = Object.freeze(["activate", "pause", "resume", "cancel"]);

/** Les états proposés dans le formulaire (le serveur accepte tout texte propre : ces mots sont ceux que le matching sait comparer ou qui disent la même chose que l'annonce). */
export const MISSION_CONDITIONS: readonly string[] = Object.freeze(["Neuf", "Comme neuf", "Très bon état", "Bon état", "État correct", "Occasion", "Reconditionné"]);

export type MissionField =
  | "category"
  | "brand"
  | "model"
  | "variant"
  | "condition"
  | "quantity"
  | "unit"
  | "unitBudgetXof"
  | "totalBudgetXof"
  | "location"
  | "deadlineDays";

/** Les champs acceptés, dans l'ordre de contrôle. */
export const MISSION_FIELDS: readonly MissionField[] = Object.freeze([
  "category",
  "brand",
  "model",
  "variant",
  "condition",
  "quantity",
  "unit",
  "unitBudgetXof",
  "totalBudgetXof",
  "location",
  "deadlineDays",
]);

export const MISSION_FIELD_LABELS: Readonly<Record<MissionField, string>> = Object.freeze({
  category: "catégorie",
  brand: "marque",
  model: "modèle",
  variant: "variante",
  condition: "état",
  quantity: "quantité",
  unit: "unité",
  unitBudgetXof: "budget par unité",
  totalBudgetXof: "budget total",
  location: "lieu",
  deadlineDays: "durée",
});

/** Message d'un champ refusé (texte fixe, jamais la valeur saisie). */
export const MISSION_FIELD_PROBLEMS: Readonly<Record<MissionField, string>> = Object.freeze({
  category: "Indiquez la catégorie (50 caractères au plus).",
  brand: "Indiquez la marque (50 caractères au plus).",
  model: "Indiquez le modèle (50 caractères au plus).",
  variant: "La variante n'est pas valide (50 caractères au plus).",
  condition: "Indiquez l'état voulu (50 caractères au plus).",
  quantity: `La quantité doit être un nombre entier de ${MISSION_QUANTITY_MIN} à 10 000.`,
  unit: "Indiquez l'unité, par exemple « pièce » (20 caractères au plus).",
  unitBudgetXof: "Le budget par unité doit être un nombre entier de FCFA, de 1 à 100 000 000.",
  totalBudgetXof: "Le budget total doit être un nombre entier de FCFA, au moins égal au budget par unité.",
  location: "Le lieu n'est pas valide (80 caractères au plus).",
  deadlineDays: `La durée doit être un nombre entier de jours, de ${MISSION_DEADLINE_DAYS_MIN} à ${MISSION_DEADLINE_DAYS_MAX}.`,
});

export function missionPhoneMessage(field: MissionField | null): string {
  return field === null
    ? "Pas de numéro de téléphone dans la mission : les vendeurs vous répondront dans la messagerie de noma."
    : `Pas de numéro de téléphone dans la mission (champ : ${MISSION_FIELD_LABELS[field]}) : les vendeurs vous répondront dans la messagerie de noma.`;
}

export interface MissionInput {
  category: string;
  brand: string;
  model: string;
  variant: string | null;
  condition: string;
  quantity: number;
  unit: string;
  unitBudgetXof: number;
  totalBudgetXof: number;
  location: string | null;
  deadlineDays: number;
}

export type MissionFailure = {
  ok: false;
  code: "invalid_mission" | "phone_number_in_mission";
  /** Le premier champ refusé (null : le titre assemblé, ou une requête mal formée). */
  field: MissionField | null;
};
export type MissionCheck = { ok: true; value: MissionInput } | MissionFailure;
export type MissionPatchCheck = { ok: true; patch: Partial<MissionInput> } | MissionFailure;

const invalid = (field: MissionField | null): MissionFailure => ({ ok: false, code: "invalid_mission", field });
const phone = (field: MissionField | null): MissionFailure => ({ ok: false, code: "phone_number_in_mission", field });

/**
 * Caractères invisibles refusés dans un champ : tout caractère IGNORABLE PAR DÉFAUT d'Unicode (soft hyphen, joint de graphème U+034F, marque de lettre arabe, remplisseurs Hangul
 * U+115F U+1160 U+3164 U+FFA0, voyelles khmères inhérentes, sélecteurs de variante, étiquettes…) et le cadratin braille vide U+2800 (nommés ici pour mémoire : les quatre premiers sont déjà
 * ignorables par défaut).
 */
const INVISIBLE_FIELD_CHARACTER = /[\p{Default_Ignorable_Code_Point}\u2800\u3164\uFFA0\u115F\u1160]/u;
/** Une marque combinante au début du texte ou après un caractère qui n'est ni lettre ni chiffre : elle ne s'appuie sur rien. */
const ISOLATED_COMBINING_MARK = /(?:^|[^\p{L}\p{N}])\p{M}/u;
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

/**
 * NFKC, toute suite d'espaces (tabulation et saut de ligne compris) devient UN espace, texte rogné. Aucun caractère de contrôle, de direction ou invisible (formats, ignorables par
 * défaut d'Unicode, U+2800, remplisseurs Hangul), aucune marque combinante isolée, au moins une lettre ou un chiffre : contrôlé sur le texte avec ses espaces ramenés à un, avant comme
 * après normalisation.
 */
export function cleanMissionText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  // Les caractères invisibles sont contrôlés sur le texte BRUT : certains (U+FEFF) comptent comme des espaces pour \s et disparaîtraient à la normalisation des espaces.
  if (INVISIBLE_FIELD_CHARACTER.test(value)) return null;
  const collapsed = value.replace(/\s+/gu, " ");
  if (hasUnsafeCharacters(collapsed) || INVISIBLE_FIELD_CHARACTER.test(collapsed)) return null;
  const text = normalizePublicText(collapsed).replace(/\s+/gu, " ").trim();
  if (text === "" || [...text].length > max || hasUnsafeCharacters(text) || INVISIBLE_FIELD_CHARACTER.test(text)) return null;
  if (ISOLATED_COMBINING_MARK.test(` ${collapsed}`) || ISOLATED_COMBINING_MARK.test(` ${text}`) || !LETTER_OR_DIGIT.test(text)) return null;
  return text;
}

function safeInteger(value: unknown, min: number, max: number): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max ? value : null;
}

const TEXT_LIMITS: Readonly<Record<"category" | "brand" | "model" | "variant" | "condition" | "unit" | "location", number>> = Object.freeze({
  category: MISSION_PART_MAX,
  brand: MISSION_PART_MAX,
  model: MISSION_PART_MAX,
  variant: MISSION_PART_MAX,
  condition: MISSION_PART_MAX,
  unit: MISSION_UNIT_MAX,
  location: MISSION_LOCATION_MAX,
});
const OPTIONAL_TEXT: ReadonlySet<MissionField> = new Set<MissionField>(["variant", "location"]);

/** Un seul champ : sa valeur propre (`undefined` : absent) ou l'échec. Le contrôle des numéros est fait ici, champ par champ. */
function checkField(field: MissionField, raw: unknown): { ok: true; value: MissionInput[MissionField] } | MissionFailure {
  switch (field) {
    case "quantity": {
      const value = safeInteger(raw, MISSION_QUANTITY_MIN, MISSION_QUANTITY_MAX);
      return value === null ? invalid(field) : { ok: true, value };
    }
    case "unitBudgetXof": {
      const value = safeInteger(raw, 1, MISSION_UNIT_BUDGET_MAX);
      return value === null ? invalid(field) : { ok: true, value };
    }
    case "totalBudgetXof": {
      const value = safeInteger(raw, 1, MISSION_TOTAL_BUDGET_MAX);
      return value === null ? invalid(field) : { ok: true, value };
    }
    case "deadlineDays": {
      const value = safeInteger(raw, MISSION_DEADLINE_DAYS_MIN, MISSION_DEADLINE_DAYS_MAX);
      return value === null ? invalid(field) : { ok: true, value };
    }
    default: {
      if (OPTIONAL_TEXT.has(field) && raw === null) return { ok: true, value: null };
      const value = cleanMissionText(raw, TEXT_LIMITS[field]);
      if (value === null) return invalid(field);
      if (looksLikePhoneNumber(value)) return phone(field);
      return { ok: true, value };
    }
  }
}

/**
 * Le titre assemblé (marque, modèle, variante) ne ressemble pas à un numéro et ne porte pas plus de 8 chiffres ; et TOUS les champs libres, contrôlés ensemble (concaténation et
 * squelette numérique), ne forment pas un numéro (un numéro coupé entre le modèle et le lieu, entre la catégorie et l'état…).
 */
function freeTextIsClean(input: Pick<MissionInput, "category" | "brand" | "model" | "variant" | "condition" | "unit" | "location">): boolean {
  const title = [input.brand, input.model, input.variant].filter((part): part is string => part !== null).join(" ");
  if (looksLikePhoneNumber(title) || countDigits(title) > MISSION_TITLE_MAX_DIGITS) return false;
  return !looksLikePhoneNumberAcross([input.category, input.brand, input.model, input.variant, input.condition, input.unit, input.location]);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Une mission complète : exactement les champs de `MISSION_FIELDS` (`variant` et `location` peuvent valoir null ; tous les autres sont obligatoires), aucun autre ; nombres
 * ENTIERS (jamais un texte, un décimal ou un nombre hors bornes) ; budget total au moins égal au budget par unité. Premier champ refusé dans l'ordre de `MISSION_FIELDS`.
 */
export function checkMissionInput(raw: unknown): MissionCheck {
  if (!isPlainObject(raw)) return invalid(null);
  if (Object.keys(raw).some((key) => !(MISSION_FIELDS as readonly string[]).includes(key))) return invalid(null);
  const value: Record<string, unknown> = {};
  for (const field of MISSION_FIELDS) {
    // Une variante ou un lieu absent vaut « non renseigné » ; tout le reste est obligatoire.
    if (raw[field] === undefined && OPTIONAL_TEXT.has(field)) {
      value[field] = null;
      continue;
    }
    const checked = checkField(field, raw[field]);
    if (!checked.ok) return checked;
    value[field] = checked.value;
  }
  const input = value as unknown as MissionInput;
  if (input.totalBudgetXof < input.unitBudgetXof) return invalid("totalBudgetXof");
  if (!freeTextIsClean(input)) return phone(null);
  return { ok: true, value: input };
}

/** Modification d'un brouillon : au moins un champ de la liste, chacun valide seul ; la mission fusionnée est ensuite recontrôlée en entier (`checkMissionInput`). */
export function checkMissionPatch(raw: unknown): MissionPatchCheck {
  if (!isPlainObject(raw)) return invalid(null);
  const keys = Object.keys(raw);
  if (keys.length === 0 || keys.some((key) => !(MISSION_FIELDS as readonly string[]).includes(key))) return invalid(null);
  const patch: Record<string, unknown> = {};
  for (const field of MISSION_FIELDS) {
    if (!Object.hasOwn(raw, field)) continue;
    const checked = checkField(field, raw[field]);
    if (!checked.ok) return checked;
    patch[field] = checked.value;
  }
  return { ok: true, patch: patch as Partial<MissionInput> };
}

/** Quantité d'une commande : entier de 1 à 10 000, sinon null. */
export function checkOrderQuantity(value: unknown): number | null {
  return safeInteger(value, ORDER_QUANTITY_MIN, ORDER_QUANTITY_MAX);
}

/** « Apple iPhone 12 128 Go » : marque, modèle et variante déjà contrôlés. */
export function missionProductLabel(input: { brand: string; model: string; variant: string | null }): string {
  return [input.brand, input.model, input.variant].filter((part): part is string => part !== null && part !== "").join(" ");
}

/** « 20 × Apple iPhone 12 128 Go ». */
export function missionTitle(input: { quantity: number; brand: string; model: string; variant: string | null }): string {
  return `${input.quantity} × ${missionProductLabel(input)}`;
}

// ───────────── raisons d'une couverture incomplète (mots simples) ─────────────

export type ShortfallReason = "not_enough_offers" | "unit_budget_too_low" | "total_budget_too_low" | "seller_limit";
export const SHORTFALL_REASONS: readonly ShortfallReason[] = Object.freeze(["not_enough_offers", "unit_budget_too_low", "total_budget_too_low", "seller_limit"]);

export const SHORTFALL_TEXT: Readonly<Record<ShortfallReason, string>> = Object.freeze({
  not_enough_offers: "Il n'y a pas encore assez d'annonces pour couvrir toute la quantité.",
  unit_budget_too_low: "Certaines annonces dépassent votre budget par unité : elles ne sont pas retenues.",
  total_budget_too_low: "Votre budget total ne suffit pas pour acheter toute la quantité à ces prix.",
  seller_limit: `La proposition est limitée à ${MISSION_SELLERS_MAX} vendeurs : d'autres annonces auraient pu compléter.`,
});
