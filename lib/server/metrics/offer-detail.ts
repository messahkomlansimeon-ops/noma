import "server-only";

import type { JsonObject, JsonValue } from "../catalog/types";
import { mapStoredMatchItem, type StoredMatchItemDto } from "../matching/http-dto";
import type { StoredOfferDetail } from "../matching/stored-matches";

/**
 * Fiche d'une annonce pour l'acheteur (lot M1) : DTO en LISTE BLANCHE. Elle reprend l'élément de correspondance tel que la liste des résultats le sert
 * (fiche produit épurée, compatibilité, indicateurs, pertinence, `sponsored`) et y ajoute la date de l'annonce et ses attributs publics. JAMAIS :
 * identifiant ou téléphone du vendeur, texte brut de l'annonce, métadonnées d'extraction, identifiant de boost, offre ou besoin d'un tiers.
 */

export const OFFER_DETAIL_CONTRACT_VERSION = "demand-offer/v1" as const;

export const PUBLIC_ATTRIBUTE_LIMIT = 12;
const ATTRIBUTE_KEY = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
const ATTRIBUTE_VALUE_MAX = 80;
/** Caractères de contrôle, de direction de texte et invisibles : jamais affichés. */
const UNSAFE_TEXT = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
/** Neuf chiffres ou plus (séparateurs compris) : ressemble à un numéro de téléphone, jamais publié (le numéro ne se révèle que par le contact). */
const PHONE_LIKE = /(?:\d[\s.\-()+]*){9,}/;

export interface PublicAttribute {
  key: string;
  value: string;
}

function attributeText(value: JsonValue | undefined): string | null {
  if (typeof value === "boolean") return value ? "oui" : "non";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : null;
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (text === "" || text.length > ATTRIBUTE_VALUE_MAX || UNSAFE_TEXT.test(text) || PHONE_LIKE.test(text)) return null;
  return text;
}

/**
 * Attributs publics : clés simples, valeurs scalaires (texte court, nombre, booléen) ou `{ value, unit? }` du catalogue, jamais un objet quelconque ni un texte qui
 * ressemble à un numéro de téléphone ; 12 au plus, dans l'ordre alphabétique des clés (sortie déterministe).
 */
export function publicAttributes(attributes: JsonObject | null): PublicAttribute[] {
  if (attributes === null || typeof attributes !== "object" || Array.isArray(attributes)) return [];
  const result: PublicAttribute[] = [];
  for (const key of Object.keys(attributes).sort()) {
    if (!ATTRIBUTE_KEY.test(key)) continue;
    const raw = attributes[key];
    let text: string | null;
    if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
      const inner = attributeText(raw.value);
      const unit = raw.unit === undefined || raw.unit === null ? null : attributeText(raw.unit);
      text = inner === null || (raw.unit !== undefined && raw.unit !== null && unit === null) ? null : unit === null ? inner : `${inner} ${unit}`;
      if (text !== null && text.length > ATTRIBUTE_VALUE_MAX) text = null;
    } else {
      text = attributeText(raw);
    }
    if (text !== null) result.push({ key, value: text });
    if (result.length >= PUBLIC_ATTRIBUTE_LIMIT) break;
  }
  return result;
}

export interface OfferDetailDto {
  contractVersion: typeof OFFER_DETAIL_CONTRACT_VERSION;
  item: StoredMatchItemDto;
  details: {
    /** Date de CRÉATION de l'annonce (le modèle ne conserve pas de date de mise en ligne distincte). */
    createdAt: string;
    attributes: PublicAttribute[];
  };
  readAt: string;
}

export function mapOfferDetailToDto(detail: StoredOfferDetail): OfferDetailDto {
  return {
    contractVersion: OFFER_DETAIL_CONTRACT_VERSION,
    item: mapStoredMatchItem(detail.item),
    details: { createdAt: detail.offer.createdAt.toISOString(), attributes: publicAttributes(detail.offer.attributes) },
    readAt: detail.readAt.toISOString(),
  };
}
