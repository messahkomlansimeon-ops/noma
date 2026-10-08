/**
 * Couche cliente des prix demandés dans les annonces (lots H1 et H1-bis) : module partagé navigateur (aucun import serveur), mêmes règles que `api.ts` et `social-api.ts` : fetch même origine,
 * JSON, toute erreur devient une `ApiError { status, code }` construite UNIQUEMENT depuis le corps `{ error: { code, message } }` du serveur (ou un code fixe), réponse relue
 * champ par champ (liste blanche : un champ ajouté un jour par le serveur n'atteint jamais l'écran). Contrats : lib/server/market/http.ts (`market/v1`, `market-admin/v1`).
 * Voir HISTORIQUE-PRIX.md.
 */

import { API_ABORTED, API_INVALID_RESPONSE, API_NETWORK_ERROR, ApiError, type RequestOptions } from "./api";

export const MARKET_CONTRACT_VERSION = "market/v3";
export const MARKET_ADMIN_CONTRACT_VERSION = "market-admin/v3";
/** La fourchette est arrondie en multiples de 5 % de la médiane (médiane / 20). */
export const MARKET_RANGE_STEPS_PER_MEDIAN = 20;

export const MARKET_PERIOD_DAYS = [30, 90, 365] as const;
export type MarketPeriodDays = (typeof MARKET_PERIOD_DAYS)[number];
export const MARKET_PRICE_STEP = 500;
export const MARKET_PARAM_MAX = 80;

export type MarketCount = { kind: "below"; bound: number } | { kind: "approx"; value: number };
export type ComparisonScope = "exact" | "any_variant" | "any_condition" | "any_variant_and_condition";
export const COMPARISON_SCOPES: readonly ComparisonScope[] = ["exact", "any_variant", "any_condition", "any_variant_and_condition"];

export interface MarketTrendPoint {
  /** Premier jour (AAAA-MM-JJ) du bloc de 7 jours. */
  from: string;
  /** Médiane du bloc (multiple de 500 FCFA) ; `null` : pas assez de données pour ce bloc. */
  median: number | null;
}

/**
 * Les prix DEMANDÉS dans les annonces : jamais un prix de vente (les ventes ne sont pas publiées). `range` (Q1, Q3 arrondis en relatif, toujours > 0) n'existe qu'à partir de 10 vendeurs
 * retenus ; `sellers` : vendeurs retenus (une valeur chacun) ; `excluded` : annonces des vendeurs aux prix atypiques écartés (`null` : aucun).
 */
export type MarketListings =
  | { status: "insufficient" }
  | {
      status: "published";
      comparedTo: { scope: ComparisonScope; text: string };
      count: MarketCount;
      sellers: MarketCount;
      excluded: MarketCount | null;
      median: number;
      range: { q1: number; q3: number } | null;
      trend: MarketTrendPoint[];
    };

export interface MarketPeriodInfo {
  days: MarketPeriodDays;
  from: string;
  to: string;
}

export interface MarketStats {
  period: MarketPeriodInfo;
  listings: MarketListings;
}

export interface AdminMarketRow {
  label: string;
  listings: MarketListings;
  /** Ventes confirmées du produit sur 90 jours : un NOMBRE arrondi, jamais un prix. */
  confirmedSales: MarketCount;
}

export interface AdminMarket {
  period: MarketPeriodInfo;
  rows: AdminMarketRow[];
}

export interface MarketQuery {
  category: string;
  brand: string;
  model: string;
  variant?: string | null;
  condition?: string | null;
  periodDays?: MarketPeriodDays;
}

// ───────────── relecture des réponses (liste blanche) ─────────────

const FIXED_MESSAGES: Record<string, string> = {
  [API_NETWORK_ERROR]: "Connexion au serveur impossible.",
  [API_INVALID_RESPONSE]: "Réponse du serveur inattendue.",
  [API_ABORTED]: "Requête interrompue.",
  invalid_argument: "Paramètre invalide.",
};

function fixedError(status: number, code: string): ApiError {
  return new ApiError(status, code, FIXED_MESSAGES[code] ?? FIXED_MESSAGES[API_INVALID_RESPONSE]);
}

const ERROR_CODE = /^[a-z][a-z0-9_]{0,63}$/;
type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const isDay = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`));
const isPrice = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value % MARKET_PRICE_STEP === 0;

function bad(status: number): never {
  throw fixedError(status, API_INVALID_RESPONSE);
}

function need(status: number, condition: boolean): void {
  if (!condition) bad(status);
}

function parseCount(status: number, value: unknown): MarketCount {
  need(status, isObject(value) && Object.keys(value).length === 2);
  const count = value as Json;
  if (count.kind === "below") {
    need(status, count.bound === 5);
    return { kind: "below", bound: 5 };
  }
  need(status, count.kind === "approx" && typeof count.value === "number" && Number.isSafeInteger(count.value) && count.value >= 5 && count.value % 5 === 0);
  return { kind: "approx", value: count.value as number };
}

const sameKeys = (value: Json, keys: readonly string[]): boolean => {
  const found = Object.keys(value).sort();
  return found.length === keys.length && [...keys].sort().every((key, index) => key === found[index]);
};

const isAmount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

function parseListings(status: number, value: unknown): MarketListings {
  need(status, isObject(value));
  const source = value as Json;
  if (source.status === "insufficient") {
    need(status, sameKeys(source, ["status"]));
    return { status: "insufficient" };
  }
  // Liste blanche stricte : tout champ en trop (un prix de vente, un identifiant…) fait refuser la réponse.
  need(status, source.status === "published" && sameKeys(source, ["status", "comparedTo", "count", "sellers", "excluded", "median", "range", "trend"]));
  need(status, isObject(source.comparedTo) && sameKeys(source.comparedTo as Json, ["scope", "text"]) && Array.isArray(source.trend) && source.trend.length <= 60);
  const compared = source.comparedTo as Json;
  need(status, (COMPARISON_SCOPES as readonly unknown[]).includes(compared.scope) && typeof compared.text === "string" && compared.text.length >= 1 && compared.text.length <= 400);
  need(status, isPrice(source.median));
  const median = source.median as number;
  let range: { q1: number; q3: number } | null = null;
  if (source.range !== null) {
    need(status, isObject(source.range) && sameKeys(source.range as Json, ["q1", "q3"]) && isAmount((source.range as Json).q1) && isAmount((source.range as Json).q3));
    const q1 = (source.range as Json).q1 as number;
    const q3 = (source.range as Json).q3 as number;
    // La fourchette est un multiple de 5 % de la médiane de part et d'autre d'elle (jamais un quartile exact).
    const step = median / MARKET_RANGE_STEPS_PER_MEDIAN;
    need(status, Number.isInteger(step) && step > 0 && q1 > 0 && q1 <= median && median <= q3 && (median - q1) % step === 0 && (q3 - median) % step === 0);
    range = { q1, q3 };
  }
  const trend = (source.trend as unknown[]).map((entry): MarketTrendPoint => {
    need(status, isObject(entry) && sameKeys(entry as Json, ["from", "median"]) && isDay((entry as Json).from) && ((entry as Json).median === null || isPrice((entry as Json).median)));
    return { from: (entry as Json).from as string, median: (entry as Json).median as number | null };
  });
  return {
    status: "published",
    comparedTo: { scope: compared.scope as ComparisonScope, text: compared.text as string },
    count: parseCount(status, source.count),
    sellers: parseCount(status, source.sellers),
    excluded: source.excluded === null ? null : parseCount(status, source.excluded),
    median,
    range,
    trend,
  };
}

function parsePeriod(status: number, value: unknown): MarketPeriodInfo {
  need(status, isObject(value) && (MARKET_PERIOD_DAYS as readonly unknown[]).includes(value.days) && isDay(value.from) && isDay(value.to));
  const period = value as Json;
  return { days: period.days as MarketPeriodDays, from: period.from as string, to: period.to as string };
}

function contract(status: number, json: unknown, version: string): Json {
  if (!isObject(json) || json.contractVersion !== version || json.currency !== "XOF" || json.roundingXof !== MARKET_PRICE_STEP) bad(status);
  return json as Json;
}

/** Texte d'un paramètre : espaces réduits, 1 à 80 caractères ; `null` si refusé (rien n'est alors envoyé). */
export function cleanMarketParameter(value: string | null | undefined): string | null {
  const text = (value ?? "").replace(/\s+/g, " ").trim();
  return text === "" || text.length > MARKET_PARAM_MAX ? null : text;
}

// ───────────── client ─────────────

export interface MarketClientOptions {
  /** fetch injecté (tests) ; par défaut le fetch global, résolu à chaque appel. */
  fetch?: typeof fetch;
}

export function createMarketClient(options: MarketClientOptions = {}) {
  async function get(path: string, requestOptions: RequestOptions = {}): Promise<{ status: number; json: unknown }> {
    const init: RequestInit = { method: "GET", headers: { Accept: "application/json" }, credentials: "same-origin", cache: "no-store", signal: requestOptions.signal };
    let response: Response;
    try {
      response = await (options.fetch ?? fetch)(path, init);
    } catch {
      throw fixedError(0, requestOptions.signal?.aborted ? API_ABORTED : API_NETWORK_ERROR);
    }
    let json: unknown = undefined;
    try {
      json = await response.json();
    } catch {
      json = undefined;
    }
    if (!response.ok) {
      if (isObject(json) && isObject(json.error) && typeof json.error.code === "string" && ERROR_CODE.test(json.error.code) && typeof json.error.message === "string" && json.error.message.length <= 500) {
        throw new ApiError(response.status, json.error.code, json.error.message);
      }
      throw fixedError(response.status, API_INVALID_RESPONSE);
    }
    return { status: response.status, json };
  }

  return {
    /**
     * GET /api/market : les prix demandés dans les annonces pour un produit (jamais un prix de vente). Les paramètres sont contrôlés AVANT la requête (catégorie, marque et modèle obligatoires, 80 caractères au plus) ;
     * un paramètre refusé : `invalid_argument`, rien n'est envoyé.
     */
    async stats(query: MarketQuery, requestOptions?: RequestOptions): Promise<MarketStats> {
      const params = new URLSearchParams();
      for (const name of ["category", "brand", "model"] as const) {
        const text = cleanMarketParameter(query[name]);
        if (text === null) throw fixedError(0, "invalid_argument");
        params.set(name, text);
      }
      for (const name of ["variant", "condition"] as const) {
        const raw = query[name];
        if (raw === undefined || raw === null || raw.trim() === "") continue;
        const text = cleanMarketParameter(raw);
        if (text === null) throw fixedError(0, "invalid_argument");
        params.set(name, text);
      }
      if (query.periodDays !== undefined) {
        if (!(MARKET_PERIOD_DAYS as readonly number[]).includes(query.periodDays)) throw fixedError(0, "invalid_argument");
        params.set("period", String(query.periodDays));
      }
      const { status, json } = await get(`/api/market?${params.toString()}`, requestOptions);
      const body = contract(status, json, MARKET_CONTRACT_VERSION);
      // Aucun prix de vente n'est publié : un champ en trop (`sales` en tête) fait refuser la réponse.
      need(status, sameKeys(body, ["contractVersion", "currency", "roundingXof", "period", "listings"]));
      return { period: parsePeriod(status, body.period), listings: parseListings(status, body.listings) };
    },

    /** GET /api/admin/market : les clés produit les plus relevées (administrateur seulement ; 404 pour tout autre). */
    async admin(requestOptions?: RequestOptions): Promise<AdminMarket> {
      const { status, json } = await get("/api/admin/market", requestOptions);
      const body = contract(status, json, MARKET_ADMIN_CONTRACT_VERSION);
      need(status, sameKeys(body, ["contractVersion", "currency", "roundingXof", "period", "rows"]) && Array.isArray(body.rows) && body.rows.length <= 20);
      return {
        period: parsePeriod(status, body.period),
        rows: (body.rows as unknown[]).map((entry): AdminMarketRow => {
          need(status, isObject(entry) && sameKeys(entry as Json, ["label", "listings", "confirmedSales"]) && typeof entry.label === "string" && entry.label.length >= 1 && entry.label.length <= 200);
          const row = entry as Json;
          return { label: row.label as string, listings: parseListings(status, row.listings), confirmedSales: parseCount(status, row.confirmedSales) };
        }),
      };
    },
  };
}

export type MarketClient = ReturnType<typeof createMarketClient>;

/** Client du navigateur : fetch global, même origine. */
export const market: MarketClient = createMarketClient();

/** Message FIXE pour l'utilisateur (jamais le texte d'une exception ni celui du serveur). */
export function describeMarketError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 429) return "Trop de demandes de prix. Réessayez dans une minute.";
    if (error.status === 401) return "Votre session a expiré. Reconnectez-vous pour continuer.";
  }
  return "Les prix demandés ne sont pas disponibles pour le moment.";
}
