import "server-only";

import type { Pool } from "pg";
import { noStoreJsonResponse } from "../http/protection";
import { hasUnsafeCharacters, looksLikePhoneNumber } from "../metrics/public-text";
import type { StatCount } from "../metrics/privacy";
import {
  createSocialContext,
  failure,
  hasUnexpectedQuery,
  invalidRequest,
  logCodeOf,
  type SocialHttpDependencies,
} from "../social/http-common";
import { MARKET_ADMIN_CONTRACT_VERSION, MARKET_CONTRACT_VERSION, MARKET_DEFAULT_PERIOD, MARKET_PARAM_MAX_LENGTH, MARKET_PERIODS, MARKET_PRICE_ROUNDING_XOF, type MarketPeriod } from "./config";
import { processMarketRateLimiter, type MarketRateLimiter } from "./rate-limit";
import { MarketError, readMarketStats, type AdminMarketRow, type MarketQueryInput } from "./reads";
import type { ListingsOutcome, MarketStats } from "./stats";

/**
 * Route HTTP des prix demandés dans les annonces (lots H1, H1-bis et H1-ter) : GET /api/market?category&brand&model[&variant][&condition][&period=30|90|365].
 * Utilisateurs CONNECTÉS seulement (401 sinon) ; paramètres en LISTE BLANCHE (un autre paramètre, un paramètre répété, une valeur vide, trop longue, non sûre ou qui
 * ressemble à un numéro de téléphone : 400) ; 60 lectures par minute et par utilisateur au plus (429 avec `retry-after`) ; réponse `no-store`, textes fixes. La réponse ne porte
 * AUCUN prix de vente (les ventes ne sont pas publiées), aucun identifiant de vendeur ni d'acheteur, aucun prix individuel, aucun minimum ni maximum : voir `stats.ts` et HISTORIQUE-PRIX.md.
 */

export interface MarketHttpDependencies extends SocialHttpDependencies {
  /** Limite de débit (défaut : celle du processus). Réservé aux tests. */
  rateLimiter?: MarketRateLimiter;
  /** Lecture des statistiques (défaut : `readMarketStats`). Réservé aux tests. */
  readStats?: (pool: Pool, query: MarketQueryInput) => Promise<MarketStats>;
}

export interface MarketHttpHandlers {
  stats(request: Request): Promise<Response>;
}

/** Les seuls paramètres admis. */
export const MARKET_QUERY_PARAMETERS = ["category", "brand", "model", "variant", "condition", "period"] as const;

/** Texte d'un paramètre de clé : espaces réduits, 1 à 80 caractères, sans caractère de contrôle ni numéro de téléphone ; `null` si refusé. */
function cleanParameter(value: string): string | null {
  const text = value.replace(/\s+/g, " ").trim();
  if (text === "" || text.length > MARKET_PARAM_MAX_LENGTH) return null;
  if (hasUnsafeCharacters(text) || looksLikePhoneNumber(text)) return null;
  return text;
}

/** Lit la requête en liste blanche ; `null` si elle est refusée. */
export function parseMarketQuery(request: Request): MarketQueryInput | null {
  if (hasUnexpectedQuery(request, MARKET_QUERY_PARAMETERS)) return null;
  const parameters = new URL(request.url).searchParams;
  const required: Record<"category" | "brand" | "model", string> = { category: "", brand: "", model: "" };
  for (const name of ["category", "brand", "model"] as const) {
    const raw = parameters.get(name);
    const text = raw === null ? null : cleanParameter(raw);
    if (text === null) return null;
    required[name] = text;
  }
  const optional: Record<"variant" | "condition", string | null> = { variant: null, condition: null };
  for (const name of ["variant", "condition"] as const) {
    const raw = parameters.get(name);
    if (raw === null) continue;
    const text = cleanParameter(raw);
    if (text === null) return null;
    optional[name] = text;
  }
  let periodDays: MarketPeriod = MARKET_DEFAULT_PERIOD;
  const period = parameters.get("period");
  if (period !== null) {
    const match = MARKET_PERIODS.find((candidate) => String(candidate) === period);
    if (match === undefined) return null;
    periodDays = match;
  }
  return { ...required, variant: optional.variant, condition: optional.condition, periodDays };
}

const countDto = (count: StatCount) => (count.kind === "below" ? { kind: "below" as const, bound: count.bound } : { kind: "approx" as const, value: count.value });

/** Les prix demandés, copiés champ par champ (liste blanche) : médiane, fourchette relative (à partir de 10 vendeurs), effectifs arrondis (annonces, vendeurs). Jamais un prix de vente. */
function listingsDto(outcome: ListingsOutcome) {
  if (outcome.status === "insufficient") return { status: "insufficient" as const };
  return {
    status: "published" as const,
    comparedTo: { scope: outcome.comparedTo.scope, text: outcome.comparedTo.text },
    count: countDto(outcome.count),
    sellers: countDto(outcome.sellers),
    excluded: outcome.excluded === null ? null : countDto(outcome.excluded),
    median: outcome.median,
    range: outcome.range === null ? null : { q1: outcome.range.q1, q3: outcome.range.q3 },
    trend: outcome.trend.map((point) => ({ from: point.from, median: point.median })),
  };
}

/**
 * Tableau « Marché » de l'administration : les prix demandés (mêmes seuils) et, par produit, le NOMBRE arrondi de ventes confirmées (jamais un prix de vente) ;
 * le libellé est le seul texte (aucun identifiant).
 */
export function marketAdminDto(result: { period: MarketStats["period"]; rows: AdminMarketRow[] }) {
  return {
    contractVersion: MARKET_ADMIN_CONTRACT_VERSION,
    currency: "XOF" as const,
    roundingXof: MARKET_PRICE_ROUNDING_XOF,
    period: { days: result.period.days, from: result.period.from, to: result.period.to },
    rows: result.rows.map((row) => ({ label: row.label, listings: listingsDto(row.listings), confirmedSales: countDto(row.confirmedSales) })),
  };
}

export function marketStatsDto(stats: MarketStats) {
  return {
    contractVersion: MARKET_CONTRACT_VERSION,
    currency: "XOF" as const,
    roundingXof: MARKET_PRICE_ROUNDING_XOF,
    period: { days: stats.period.days, from: stats.period.from, to: stats.period.to },
    listings: listingsDto(stats.listings),
  };
}

export function createMarketHttpHandlers(dependencies: MarketHttpDependencies = {}): MarketHttpHandlers {
  const context = createSocialContext(dependencies, "market-http");
  const limiter = dependencies.rateLimiter ?? processMarketRateLimiter;
  const readStats = dependencies.readStats ?? ((pool: Pool, query: MarketQueryInput) => readMarketStats(pool, query));

  return {
    async stats(request) {
      const authenticated = await context.authenticate(request);
      if (!authenticated.ok) return authenticated.response;
      // La limite précède tout travail : une requête refusée ne coûte ni lecture ni calcul.
      const allowed = limiter.tryAcquire(authenticated.userId);
      if (!allowed.ok) {
        return failure(429, "rate_limited", "Trop de demandes de prix du marché en peu de temps : réessayez dans une minute.", { "retry-after": String(allowed.retryAfterSeconds) });
      }
      const query = parseMarketQuery(request);
      if (query === null) return invalidRequest();
      try {
        return noStoreJsonResponse(200, marketStatsDto(await readStats(context.poolOf(), query)));
      } catch (error) {
        if (error instanceof MarketError && error.code === "invalid_query") return invalidRequest();
        return context.unavailable(logCodeOf(error), "market");
      }
    },
  };
}

export const defaultMarketHttpHandlers = createMarketHttpHandlers();
