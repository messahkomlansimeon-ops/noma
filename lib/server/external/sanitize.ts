import { createHmac } from "node:crypto";
import { canonicalUrl } from "../../../poc/lib/dedup";
import { UNSAFE_TEXT, looksLikePhoneNumber } from "../../phone-text";
import { LISTED_AT_FUTURE_TOLERANCE_MS, LISTED_AT_MIN_MS, MAX_LISTINGS_PER_SEARCH, MAX_RAW_ENTRIES_PER_SEARCH } from "./config";
import type { ConnectorAvailability } from "./types";

/**
 * Nettoyage d'une annonce renvoyée par un connecteur, AVANT tout stockage (lot EXT1). Module PUR.
 *
 * Le connecteur n'est jamais cru : sa réponse est revalidée champ par champ. Règle des numéros de téléphone (lib/phone-text.ts, la MÊME que pour les annonces internes) :
 * un champ de texte (titre, lieu) qui ressemble à un numéro est RETIRÉ (null) ; une URL qui en porte un fait rejeter l'annonce (sans lien, rien n'est montré) ; un identifiant externe qui
 * en porte un est remplacé par une empreinte HMAC-SHA256 À CLÉ SERVEUR (« h:… ») : le numéro n'est ni écrit ni journalisé, et l'empreinte ne se retrouve pas en essayant tous les
 * numéros possibles sans la clé ; SANS clé disponible, l'annonce est rejetée (`id_phone`). Aucune description, aucun vendeur, aucune photo : ils ne sont ni lus ni stockés.
 *
 * Bornes : les dates de publication hors de 2000-01-01 → demain sont ÉCARTÉES (le champ, pas l'annonce) ; une réponse n'est lue que sur ses 4 × 50 premières entrées, et un texte
 * est coupé avant d'être nettoyé : une réponse énorme ne bloque pas le processus.
 */

export const TITLE_MAX = 200;
export const LOCATION_MAX = 120;
export const EXTERNAL_ID_MAX = 200;
export const URL_MAX = 1_000;
/** Longueur lue d'un texte AVANT nettoyage : 4 fois sa limite (le nettoyage ne travaille jamais sur 20 Mo de texte). */
const RAW_TEXT_FACTOR = 4;
/** Clé d'empreinte trop courte : traitée comme absente. */
const MIN_PSEUDONYM_KEY_BYTES = 16;

export interface SanitizeOptions {
  /** Clé secrète du serveur (HMAC) pour l'identifiant externe qui ressemble à un numéro. Absente ou trop courte : une telle annonce est rejetée (`id_phone`). */
  pseudonymKey?: Uint8Array | null;
}

export interface SanitizedListing {
  externalId: string;
  title: string | null;
  priceAmount: number | null;
  priceCurrency: string | null;
  url: string;
  location: string | null;
  listedAt: Date | null;
  availability: ConnectorAvailability;
}

export type RejectReason = "not_an_object" | "invalid_id" | "invalid_url" | "url_phone" | "id_phone";

export type SanitizeResult =
  | { ok: true; listing: SanitizedListing; removedFields: Array<"title" | "location" | "external_id"> }
  | { ok: false; reason: RejectReason };

/** Caractères de contrôle, de direction et invisibles (catégories Cc, Cf, Zl, Zp) : jamais conservés. */
const CONTROL_ALL = new RegExp(UNSAFE_TEXT.source, "gu");
const CONTROL_ANY = UNSAFE_TEXT;

function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const text = (value.length > max * RAW_TEXT_FACTOR ? value.slice(0, max * RAW_TEXT_FACTOR) : value).replace(CONTROL_ALL, " ").replace(/\s+/g, " ").trim();
  if (text === "") return null;
  return text.length > max ? text.slice(0, max).trim() : text;
}

const CURRENCY_ALIASES: Readonly<Record<string, string>> = Object.freeze({ FCFA: "XOF", CFA: "XOF", "F CFA": "XOF", XOF: "XOF", FRANCS: "XOF" });

/** Devise ISO sur trois lettres ; FCFA, CFA et « F CFA » deviennent XOF ; sinon null (prix alors incomparable). */
export function normalizeCurrency(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const upper = value.trim().replace(/\s+/g, " ").toUpperCase();
  if (upper in CURRENCY_ALIASES) return CURRENCY_ALIASES[upper];
  return /^[A-Z]{3}$/.test(upper) ? upper : null;
}

function cleanPrice(amount: unknown, currency: unknown): { priceAmount: number | null; priceCurrency: string | null } {
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0 || amount > Number.MAX_SAFE_INTEGER) return { priceAmount: null, priceCurrency: null };
  const iso = normalizeCurrency(currency);
  if (iso === null) return { priceAmount: null, priceCurrency: null };
  return { priceAmount: Math.round(amount), priceCurrency: iso };
}

function urlLooksLikePhone(url: string): boolean {
  if (looksLikePhoneNumber(url)) return true;
  try {
    const decoded = decodeURIComponent(url);
    return decoded !== url && looksLikePhoneNumber(decoded);
  } catch {
    return false;
  }
}

/** URL http(s) sans identifiants, canonique (https, sans « www », sans paramètres de suivi), ou null. */
export function cleanUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (text === "" || text.length > URL_MAX || CONTROL_ANY.test(text)) return null;
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  if (parsed.username !== "" || parsed.password !== "" || parsed.hostname === "") return null;
  const canonical = canonicalUrl(parsed.toString());
  if (canonical === null || canonical.length > URL_MAX || !/^https:\/\//.test(canonical)) return null;
  return canonical;
}

/**
 * Empreinte d'un identifiant externe qui ressemblait à un numéro : HMAC-SHA256 avec la clé du serveur. Deux identifiants égaux restent égaux (même clé), le numéro n'est pas conservé
 * et, sans la clé, l'empreinte ne se retrouve pas en parcourant les numéros possibles (un SHA-256 simple se casse en quelques minutes).
 */
export function pseudonymOf(value: string, key: Uint8Array): string {
  return `h:${createHmac("sha256", key).update(value, "utf8").digest("hex").slice(0, 24)}`;
}

/** Date de publication admise : valide, du 1er janvier 2000 à demain (heure de la recherche) ; sinon null (le champ est écarté, l'annonce est gardée). */
export function cleanListedAt(value: unknown, now: Date): Date | null {
  if (!(value instanceof Date)) return null;
  const time = value.getTime();
  if (!Number.isFinite(time) || time < LISTED_AT_MIN_MS || time > now.getTime() + LISTED_AT_FUTURE_TOLERANCE_MS) return null;
  return new Date(time);
}

export function sanitizeDraft(draft: unknown, now: Date = new Date(), options: SanitizeOptions = {}): SanitizeResult {
  if (typeof draft !== "object" || draft === null || Array.isArray(draft)) return { ok: false, reason: "not_an_object" };
  const raw = draft as Record<string, unknown>;
  const removedFields: Array<"title" | "location" | "external_id"> = [];

  let externalId = typeof raw.externalId === "string" || typeof raw.externalId === "number" ? String(raw.externalId).trim() : "";
  if (externalId === "" || externalId.length > EXTERNAL_ID_MAX || CONTROL_ANY.test(externalId)) return { ok: false, reason: "invalid_id" };
  if (looksLikePhoneNumber(externalId)) {
    const key = options.pseudonymKey;
    if (!key || key.byteLength < MIN_PSEUDONYM_KEY_BYTES) return { ok: false, reason: "id_phone" };
    externalId = pseudonymOf(externalId, key);
    removedFields.push("external_id");
  }

  const url = cleanUrl(raw.url);
  if (url === null) return { ok: false, reason: "invalid_url" };
  if (urlLooksLikePhone(url) || (typeof raw.url === "string" && urlLooksLikePhone(raw.url))) return { ok: false, reason: "url_phone" };

  let title = cleanText(raw.title, TITLE_MAX);
  if (title !== null && looksLikePhoneNumber(title)) {
    title = null;
    removedFields.push("title");
  }
  let location = cleanText(raw.location, LOCATION_MAX);
  if (location !== null && looksLikePhoneNumber(location)) {
    location = null;
    removedFields.push("location");
  }

  const { priceAmount, priceCurrency } = cleanPrice(raw.price, raw.currency);
  const listedAt = cleanListedAt(raw.listedAt, now);
  const availability: ConnectorAvailability = raw.availability === "available" || raw.availability === "unavailable" ? raw.availability : "unknown";

  return { ok: true, listing: { externalId, title, priceAmount, priceCurrency, url, location, listedAt, availability }, removedFields };
}

export interface SanitizedBatch {
  listings: SanitizedListing[];
  /** Annonces rejetées (forme, identifiant, URL) ou doublons d'identifiant dans la réponse. */
  rejected: number;
  /** Champs de texte retirés parce qu'ils ressemblaient à un numéro de téléphone. */
  phoneRemoved: number;
  /** Doublons dans la MÊME réponse (même identifiant ou même URL canonique) : la première occurrence est gardée. */
  duplicatesInResponse: number;
  /** Entrées au-delà des 4 × 50 premières (jamais lues) et annonces valides au-delà de la limite de 50 par recherche. */
  truncated: number;
}

/**
 * Nettoie toute la réponse d'un connecteur : la réponse est d'abord TRONQUÉE à ses 4 × 50 premières entrées (le reste n'est ni lu ni nettoyé : il est compté dans `truncated`), puis
 * les entrées invalides sont rejetées, les doublons d'identifiant ou d'URL de la réponse retirés et la limite de 50 annonces appliquée.
 */
export function sanitizeBatch(drafts: readonly unknown[], now: Date = new Date(), options: SanitizeOptions = {}): SanitizedBatch {
  const batch: SanitizedBatch = { listings: [], rejected: 0, phoneRemoved: 0, duplicatesInResponse: 0, truncated: 0 };
  const read = drafts.length > MAX_RAW_ENTRIES_PER_SEARCH ? drafts.slice(0, MAX_RAW_ENTRIES_PER_SEARCH) : drafts;
  batch.truncated += drafts.length - read.length;
  const ids = new Set<string>();
  const urls = new Set<string>();
  for (const draft of read) {
    const result = sanitizeDraft(draft, now, options);
    if (!result.ok) {
      batch.rejected += 1;
      continue;
    }
    batch.phoneRemoved += result.removedFields.length;
    const { listing } = result;
    if (ids.has(listing.externalId) || urls.has(listing.url)) {
      batch.duplicatesInResponse += 1;
      continue;
    }
    if (batch.listings.length >= MAX_LISTINGS_PER_SEARCH) {
      batch.truncated += 1;
      continue;
    }
    ids.add(listing.externalId);
    urls.add(listing.url);
    batch.listings.push(listing);
  }
  return batch;
}
