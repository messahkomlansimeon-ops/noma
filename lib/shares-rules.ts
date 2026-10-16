/**
 * Lien de partage d'un besoin (lot FIN3-C4), règles PARTAGÉES par le serveur et le navigateur (aucun import serveur) : forme du jeton, bornes, et la VUE PUBLIQUE d'un besoin.
 * Ce que voit quiconque ouvre le lien : le produit, l'état, la zone, la quantité et le budget : JAMAIS le texte brut du besoin (il peut contenir un nom ou un numéro : la règle des numéros ne
 * s'applique pas au texte d'un besoin), JAMAIS l'identité, la date ni le moindre identifiant. Un champ qui ressemble à un numéro de téléphone est OMIS ; si un numéro est réparti sur plusieurs
 * champs, tous les textes libres sont omis. Voir PARTAGE.md.
 */

import { hasUnsafeCharacters, looksLikePhoneNumberAcross, publicFieldText } from "./phone-text";

export const SHARES_CONTRACT_VERSION = "shares/v1";

/** 128 bits aléatoires en base64url : 22 caractères. */
export const SHARE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{22}$/;
/** Liens qu'un compte peut créer par jour UTC (créer un lien révoque le précédent) : borne contre l'usage abusif. */
export const SHARE_DAILY_LIMIT = 10;
export const SHARE_PATH_PREFIX = "/besoin/";

export function sharePath(token: string): string | null {
  return SHARE_TOKEN_PATTERN.test(token) ? `${SHARE_PATH_PREFIX}${token}` : null;
}

export interface PublicNeed {
  /** « Apple iPhone 13 128 Go », ou la catégorie, ou « Un produit ». */
  title: string;
  category: string | null;
  condition: string | null;
  location: string | null;
  quantity: number | null;
  unit: string | null;
  budget: { amount: number; currency: string } | null;
}

export interface PublicNeedSource {
  category: string | null;
  brand: string | null;
  model: string | null;
  variant: string | null;
  condition_text: string | null;
  quantity: number | null;
  unit: string | null;
  location_text: string | null;
  budget_amount: number | null;
  budget_currency: string | null;
}

const TEXT_MAX = 80;

function clean(value: string | null): string | null {
  const text = publicFieldText(value);
  if (text === null) return null;
  const trimmed = text.trim();
  if (trimmed === "" || trimmed.length > TEXT_MAX || hasUnsafeCharacters(trimmed)) return null;
  return trimmed;
}

/** La vue publique d'un besoin : champs structurés seulement, texte libre filtré (numéro isolé ou réparti : omis). */
export function publicNeedView(source: PublicNeedSource): PublicNeed {
  // 1) un champ qui est à lui seul un numéro est omis ; 2) si ce qui reste, mis bout à bout, forme encore un numéro, TOUS les textes libres sont omis.
  const parts = [source.category, source.brand, source.model, source.variant, source.condition_text, source.location_text, source.unit].map(clean);
  const split = looksLikePhoneNumberAcross(parts);
  const field = (value: string | null): string | null => (split ? null : clean(value));
  const brand = field(source.brand);
  const model = field(source.model);
  const variant = field(source.variant);
  const category = field(source.category);
  const product = [brand, model, variant].filter((part): part is string => part !== null).join(" ");
  const budgetOk = source.budget_amount !== null && Number.isSafeInteger(source.budget_amount) && source.budget_amount >= 0 && source.budget_currency === "XOF";
  return {
    title: product !== "" ? product : (category ?? "Un produit"),
    category,
    condition: field(source.condition_text),
    location: field(source.location_text),
    quantity: source.quantity !== null && Number.isSafeInteger(source.quantity) && source.quantity > 0 ? source.quantity : null,
    unit: field(source.unit),
    budget: budgetOk ? { amount: source.budget_amount as number, currency: "XOF" } : null,
  };
}
