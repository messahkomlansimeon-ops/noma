/**
 * Contrats partagés recherche publique — client ET serveur.
 * AUCUN import serveur ici : ce fichier peut être importé par le bundle
 * navigateur (Lot 6) et par les route handlers (Lot 5) sans risque de fuite
 * de dépendances (Playwright, clés, ledger…).
 */

// ─── Demande de recherche ────────────────────────────────────────────────────

/** Location (« Louer ») temporairement désactivée : achat et service seuls. */
export type SearchMode = "achat" | "service";

export const SEARCH_TEXT_MAX = 1_000;
export const SEARCH_BODY_MAX_BYTES = 8 * 1024;

export interface SearchRequestInput {
  /** Besoin en texte libre (≤ SEARCH_TEXT_MAX caractères, validé à l'API). */
  text: string;
  mode: SearchMode;
  /** Localisation facultative — vide = valeur extraite du texte. */
  location?: string | null;
  /** Budget maximum en FCFA, facultatif — vide = valeur extraite du texte.
   *  AUCUN budget par défaut : absent ⇒ celui du texte, sinon null. */
  budgetFcfa?: number | null;
  /** Présenter aussi les alternatives hors budget. */
  alternatives?: boolean;
  /** Jeton anti-bot (Turnstile) — validé côté serveur uniquement. */
  turnstileToken?: string;
  /** Suite signée d'une clarification : évite un second défi Turnstile. */
  continuationToken?: string;
  clarification?: { id: string; answer: string };
}

/** Besoin extrait du texte par le moteur (sous-ensemble nécessaire à la
 *  fusion — les clés restent côté serveur). */
export interface ExtractedNeedFields {
  /** Budget annoncé dans le texte, telle quelle (devise d'origine JAMAIS
   *  convertie) ; null si absent du texte. */
  budget: { amount: number; currency: string } | null;
  /** Zone extraite du texte ; null si absente. */
  zone: string | null;
}

export interface MergedNeedFields {
  budget: { amount: number; currency: string } | null;
  zone: string | null;
}

/** Priorité des champs : une valeur explicitement renseignée prime ; une
 *  valeur vide (null/undefined/chaîne vide) laisse la valeur extraite du
 *  texte. Aucun budget par défaut n'est jamais injecté. */
export function mergeNeedFields(
  request: Pick<SearchRequestInput, "budgetFcfa" | "location">,
  extracted: ExtractedNeedFields,
): MergedNeedFields {
  const budget =
    typeof request.budgetFcfa === "number" &&
    Number.isFinite(request.budgetFcfa) &&
    request.budgetFcfa >= 0
      ? { amount: request.budgetFcfa, currency: "FCFA" }
      : extracted.budget;
  const location =
    typeof request.location === "string" && request.location.trim().length > 0
      ? request.location.trim()
      : extracted.zone;
  return { budget, zone: location };
}

// ─── Saisie du budget (formulaire) ───────────────────────────────────────────

export type BudgetParse =
  | { ok: true; value: number }
  | { ok: false; reason: string };

/** Normalise une saisie de budget ivoirien : « 150 000 FCFA », « 150k »,
 *  « 150.000 », « 150,000 » → 150 000. Devise retirée, JAMAIS interprétée
 *  comme un montant. Saisie ambiguë → erreur explicite : le plafond n'est
 *  jamais supprimé silencieusement. */
export function parseBudgetFcfa(input: string): BudgetParse {
  let s = input.trim().toLowerCase().replace(/[\u00a0\u202f]/g, " ");
  // devise : retirée avant tout traitement du montant
  s = s.replace(/f\.?\s*cfa|fcfa|frs|cfa/g, " ").replace(/\bf\b/g, " ").trim();
  if (s.length === 0) return { ok: false, reason: "Montant manquant." };
  let scale = 1;
  if (/k$/.test(s)) {
    scale = 1000;
    s = s.slice(0, -1).trim();
  }
  if (s.length === 0) return { ok: false, reason: "Montant manquant." };
  // séparateurs de milliers uniquement (groupes de 3) — un séparateur isolé
  // (ex. « 150.5 ») est refusé plutôt que déformé
  if (/^\d{1,3}( \d{3})+$/.test(s)) s = s.replace(/ /g, "");
  else if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, "");
  else if (/^\d{1,3}(,\d{3})+$/.test(s)) s = s.replace(/,/g, "");
  if (!/^\d+$/.test(s)) {
    return { ok: false, reason: `Budget « ${input.trim()} » non reconnu. Saisissez un montant en FCFA (ex. 150 000).` };
  }
  const value = Number(s) * scale;
  if (!Number.isSafeInteger(value) || value > 1e12) {
    return { ok: false, reason: "Montant trop grand." };
  }
  return { ok: true, value };
}

// ─── Offre publique ──────────────────────────────────────────────────────────

export type AiStatus = "évalué par IA" | "non évalué par IA";

export interface PublicOffer {
  /** Identifiant stable dans le run et le sessionStorage (30 min). */
  id: string;
  title: string;
  /** null = prix non annoncé (« sur demande ») — jamais inventé. */
  price: number | null;
  /** Devise ANNONCÉE, transportée telle quelle — zéro conversion implicite. */
  currency: string;
  /** Localisation telle qu'annoncée ; null si inconnue. */
  location: string | null;
  /** Nom de la source d'affichage (ex. « CoinAfrique », « Facebook »). */
  source: string;
  /** URL de l'annonce source, validée http/https, null sinon. */
  url: string | null;
  /** Photo réelle, validée http/https, null sinon (vignette neutre côté UI). */
  photo: string | null;
  /** Justification factuelle de la pertinence (français). */
  justification: string;
  /** Informations confirmées (labels en clair), sans invention. */
  confirmed: string[];
  aiStatus: AiStatus;
}

/** N'accepte que les URL http/https absolues — toute autre forme (relative,
 *  javascript:, data:, vide…) devient null avant affichage. */
export function sanitizePublicUrl(url: string | null | undefined): string | null {
  if (typeof url !== "string" || url.trim().length === 0) return null;
  try {
    const parsed = new URL(url.trim());
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? parsed.toString()
      : null;
  } catch {
    return null;
  }
}

/** Format d'affichage du prix : devise annoncée conservée. XOF et FCFA sont
 *  la même monnaie (franc CFA) — libellé « FCFA » sans conversion de valeur.
 *  Toute autre devise reste affichée telle quelle (ex. « 50 USD »). */
export function formatPublicPrice(offer: Pick<PublicOffer, "price" | "currency">): string {
  if (offer.price === null) return "sur demande";
  const formatted = offer.price.toString().replace(/\B(?=(\d{3})+(?!\d))/g, "\u00A0");
  const currency = offer.currency.trim().toUpperCase();
  return currency === "" || currency === "FCFA" || currency === "XOF"
    ? `${formatted} FCFA`
    : `${formatted} ${currency}`;
}

// ─── Événements de progression (NDJSON) ──────────────────────────────────────

export type SourceEventStatus = "ok" | "empty" | "blocked" | "timeout" | "error";

export interface PublicUnderstanding {
  product: string;
  category: string;
  requirements: string[];
  preferences: string[];
  exclusions: string[];
  confidence: number;
  source: "ai" | "fallback";
}

export interface PublicClarification {
  id: string;
  question: string;
  options: string[];
  /** Signé, limité dans le temps et lié à la session + demande. */
  continuationToken: string;
}

export type SearchEvent =
  | { type: "started"; searchId: string; aiEnabled: boolean }
  | { type: "understanding"; understanding: PublicUnderstanding }
  | { type: "clarification"; clarification: PublicClarification }
  | { type: "source"; source: string; status: SourceEventStatus }
  | { type: "results"; offers: PublicOffer[] }
  | {
      type: "completed";
      offersCount: number;
      sources: { source: string; status: SourceEventStatus }[];
      /** Preuve serveur du retrait d'annonces inaccessibles : présent
       *  SEULEMENT si des exclusions ont eu lieu (absent = cause non
       *  établie → le client affiche un message neutre). */
      retired?: { count: number; indeterminate: number };
    }
  | {
      type: "error";
      /** Code public stable — jamais de trace technique brute. */
      code: string;
      message: string;
      retryAfterSeconds?: number;
    };

/** Parse une ligne NDJSON toléramment : ligne invalide ou événement inconnu
 *  → null (le client ne lève jamais sur une ligne inattendue). */
export function parseSearchEvent(line: string): SearchEvent | null {
  if (line.trim().length === 0) return null;
  try {
    const value: unknown = JSON.parse(line);
    if (typeof value !== "object" || value === null) return null;
    const type = (value as { type?: unknown }).type;
    switch (type) {
      case "started": {
        const searchId = (value as { searchId?: unknown }).searchId;
        const aiEnabled = (value as { aiEnabled?: unknown }).aiEnabled;
        if (typeof searchId !== "string" || typeof aiEnabled !== "boolean") return null;
        return { type: "started", searchId, aiEnabled };
      }
      case "source": {
        const source = (value as { source?: unknown }).source;
        const status = (value as { status?: unknown }).status;
        if (typeof source !== "string" || typeof status !== "string") return null;
        if (!["ok", "empty", "blocked", "timeout", "error"].includes(status)) return null;
        return { type: "source", source, status: status as SourceEventStatus };
      }
      case "understanding": {
        const u = (value as { understanding?: unknown }).understanding;
        if (typeof u !== "object" || u === null) return null;
        const v = u as Record<string, unknown>;
        const stringArray = (input: unknown): input is string[] =>
          Array.isArray(input) && input.every((item) => typeof item === "string");
        if (
          typeof v.product !== "string" || typeof v.category !== "string" ||
          !stringArray(v.requirements) || !stringArray(v.preferences) ||
          !stringArray(v.exclusions) || typeof v.confidence !== "number" ||
          v.confidence < 0 || v.confidence > 1 ||
          (v.source !== "ai" && v.source !== "fallback")
        ) return null;
        return { type: "understanding", understanding: v as unknown as PublicUnderstanding };
      }
      case "clarification": {
        const c = (value as { clarification?: unknown }).clarification;
        if (typeof c !== "object" || c === null) return null;
        const v = c as Record<string, unknown>;
        if (
          typeof v.id !== "string" || typeof v.question !== "string" ||
          !Array.isArray(v.options) || v.options.length < 2 ||
          !v.options.every((item) => typeof item === "string") ||
          typeof v.continuationToken !== "string" || v.continuationToken.length === 0
        ) return null;
        return { type: "clarification", clarification: v as unknown as PublicClarification };
      }
      case "results": {
        const offers = (value as { offers?: unknown }).offers;
        if (!Array.isArray(offers)) return null;
        return { type: "results", offers: offers as PublicOffer[] };
      }
      case "completed": {
        const offersCount = (value as { offersCount?: unknown }).offersCount;
        const sources = (value as { sources?: unknown }).sources;
        if (typeof offersCount !== "number" || !Array.isArray(sources)) return null;
        // preuve serveur du retrait (facultatif) : nombres entiers ≥ 0
        const retiredRaw = (value as { retired?: unknown }).retired;
        let retired:
          | { count: number; indeterminate: number }
          | undefined;
        if (retiredRaw !== undefined) {
          if (typeof retiredRaw !== "object" || retiredRaw === null) return null;
          const count = (retiredRaw as { count?: unknown }).count;
          const indeterminate = (retiredRaw as { indeterminate?: unknown }).indeterminate;
          if (
            typeof count !== "number" || !Number.isInteger(count) || count < 0 ||
            typeof indeterminate !== "number" || !Number.isInteger(indeterminate) || indeterminate < 0
          ) {
            return null;
          }
          retired = { count, indeterminate };
        }
        return {
          type: "completed",
          offersCount,
          sources: sources as { source: string; status: SourceEventStatus }[],
          ...(retired !== undefined ? { retired } : {}),
        };
      }
      case "error": {
        const code = (value as { code?: unknown }).code;
        const message = (value as { message?: unknown }).message;
        if (typeof code !== "string" || typeof message !== "string") return null;
        const retryAfterSeconds = (value as { retryAfterSeconds?: unknown })
          .retryAfterSeconds;
        return {
          type: "error",
          code,
          message,
          ...(typeof retryAfterSeconds === "number"
            ? { retryAfterSeconds }
            : {}),
        };
      }
      default:
        return null;
    }
  } catch {
    return null;
  }
}
