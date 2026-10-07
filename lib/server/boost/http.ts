import "server-only";

import type { Pool } from "pg";
import { AUTH_SESSION_COOKIE } from "../auth/http";
import { resolveSession as resolveStoredSession } from "../auth/sessions";
import type { AuthClock, ResolvedSession, SessionContext } from "../auth/types";
import { CATALOG_HTTP_BODY_MAX_BYTES } from "../catalog/http";
import { CatalogValidationError } from "../catalog/errors";
import { checkPostOrigin, noStoreJsonResponse, readJsonBodyCapped, readSingleCookie } from "../http/protection";
import { getPostgresPool } from "../postgres/client";
import { BOOST_DURATION_CODES, BOOST_QUOTE_RATE_WINDOW_SECONDS, BOOST_REACH_RETRY_AFTER_SECONDS, type BoostDurationCode } from "./boost-config";
import { roundCount, type StatCount } from "../metrics/privacy";
import { BoostError } from "./boosts";
import { listOfferBoostQuotes, quoteOfferBoost, type BoostQuote, type BoostQuoteHistoryItem } from "./quotes";

/**
 * Routes HTTP des cotations de boost (lot 2I3) : le vendeur demande une cotation pour SON offre et relit son historique. AUCUN
 * achat, paiement, crédit ni réservation de place. Voir BOOST-HTTP.md.
 */

/**
 * Version du contrat de réponse (champ `contractVersion`). v2 (lots M1 à M1-quater) : les comptes d'ACHETEURS uniques `inputs.compatibleBuyers` et `inputs.reachableBuyers`
 * sont arrondis : `{ kind: "below", bound: 5 }` de 0 à 4 acheteurs, sinon `{ kind: "approx", value }` (multiple de 5 le plus proche). Jamais le compte exact.
 */
export const BOOST_QUOTE_CONTRACT_VERSION = "boost-quote/v2";

/** Même plafond de corps que le catalogue. */
export const BOOST_HTTP_BODY_MAX_BYTES = CATALOG_HTTP_BODY_MAX_BYTES;

export const BOOST_HISTORY_DEFAULT_LIMIT = 20;
export const BOOST_HISTORY_MAX_LIMIT = 50;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** Un code de journal : lettres, chiffres et tiret bas, 40 caractères au plus (même règle que l'étape boost du classement). */
const LOG_CODE = /^[A-Za-z0-9_]{1,40}$/;

type Environment = Record<string, string | undefined>;

export interface BoostHttpDependencies {
  pool?: Pool;
  now?: AuthClock;
  env?: Environment;
  /** Résolution de session (défaut : `resolveSession` de lib/server/auth). */
  resolveSession?: (token: string, context: SessionContext) => Promise<ResolvedSession | null>;
  /**
   * Journal serveur : ne reçoit QU'UN code (jamais de message brut, de requête ni d'identifiant). Un journal qui lève est ignoré.
   * Défaut : console.error.
   */
  log?: (code: string) => void;
}

export interface BoostHttpHandlers {
  quotes: {
    /** POST /api/offers/{id}/boost-quotes : demander une cotation. */
    create(request: Request, id: string): Promise<Response>;
    /** GET /api/offers/{id}/boost-quotes : historique du vendeur pour son offre. */
    list(request: Request, id: string): Promise<Response>;
  };
}

// ───────────── réponses (textes fixes, jamais de donnée de la base) ─────────────

function boostError(status: number, code: string, message: string): Response {
  return noStoreJsonResponse(status, { error: { code, message } });
}

const unauthorized = () => boostError(401, "authentication_required", "Authentification requise.");
const forbiddenOrigin = () => boostError(403, "invalid_origin", "Origine de la requête non autorisée.");
const invalidRequest = () => boostError(400, "invalid_request", "Requête invalide.");
/** Offre inexistante ET offre d'autrui : la MÊME réponse, on ne révèle jamais l'existence de l'offre d'un autre. */
const resourceNotFound = () => boostError(404, "resource_not_found", "Ressource introuvable.");
const offerNotEligible = () => boostError(409, "offer_not_eligible", "Cette offre n'est pas éligible au boost.");
const offerNotBoostable = () => boostError(409, "offer_not_boostable", "Cette offre n'est pas boostable : catégorie, marque et modèle requis.");
const boostUnavailable = () => boostError(503, "boost_unavailable", "Le service de boost est temporairement indisponible.");
/** Limite de débit des devis (lot P3) : 429, texte fixe, `Retry-After` en secondes. */
const rateLimited = () => noStoreJsonResponse(
  429,
  { error: { code: "rate_limited", message: "Trop de devis demandés en peu de temps : réessayez dans une minute." } },
  { "retry-after": String(BOOST_QUOTE_RATE_WINDOW_SECONDS) },
);

/** Vérification de la portée non terminée à temps (lot P3-bis) : 503 retriable, texte fixe, `Retry-After` court ; aucun devis n'a été écrit. */
const reachCheckUnavailable = () => noStoreJsonResponse(
  503,
  { error: { code: "reach_check_unavailable", message: "Vérification impossible pour le moment, réessayez dans un instant." } },
  { "retry-after": String(BOOST_REACH_RETRY_AFTER_SECONDS) },
);

// ───────────── DTO (liste blanche explicite : aucun champ n'est copié par défaut) ─────────────

interface BoostQuoteDto {
  id: string;
  durationCode: BoostDurationCode;
  currency: "XOF";
  status: "available" | "unavailable";
  amount: number | null;
  unavailableReason: BoostQuote["unavailableReason"];
  factors: { competitionMilli: number; demandMilli: number; scarcityMilli: number; durationMilli: number } | null;
  inputs: {
    competingSellers: number;
    /** Acheteurs uniques compatibles : « moins de 5 » de 0 à 4, sinon « environ N » (arrondi à 5 près). */
    compatibleBuyers: StatCount;
    /** Acheteurs uniques chez qui le boost ferait monter l'annonce (même arrondi) ; `null` : non évalué. */
    reachableBuyers: StatCount | null;
    reachTruncated: boolean;
    slotsTotal: number;
    slotsUsed: number;
  };
  computedAt: string;
  expiresAt: string;
}

/** Jamais : rawAmount, pricing (clé, version), offerId, sellerId, périmètre, identité d'un acheteur ou d'un vendeur concurrent. */
function quoteDto(quote: BoostQuote | BoostQuoteHistoryItem): BoostQuoteDto {
  return {
    id: quote.id,
    durationCode: quote.durationCode,
    currency: quote.currency,
    status: quote.status,
    amount: quote.amount,
    unavailableReason: quote.unavailableReason,
    factors: quote.factors === null ? null : {
      competitionMilli: quote.factors.competitionMilli,
      demandMilli: quote.factors.demandMilli,
      scarcityMilli: quote.factors.scarcityMilli,
      durationMilli: quote.factors.durationMilli,
    },
    inputs: {
      competingSellers: quote.inputs.competingSellers,
      compatibleBuyers: roundCount(quote.inputs.compatibleBuyers),
      reachableBuyers: quote.inputs.reachableBuyers === null ? null : roundCount(quote.inputs.reachableBuyers),
      reachTruncated: quote.inputs.reachTruncated,
      slotsTotal: quote.inputs.slotsTotal,
      slotsUsed: quote.inputs.slotsUsed,
    },
    computedAt: quote.computedAt.toISOString(),
    expiresAt: quote.expiresAt.toISOString(),
  };
}

// ───────────── lecture stricte des entrées ─────────────

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Exactement `{ "durationCode": "24h" | "3d" | "7d" }` : objet, clé obligatoire, aucune autre clé. */
function parseQuoteBody(value: unknown): BoostDurationCode {
  if (!isPlainObject(value)) throw new CatalogValidationError("Corps invalide.");
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== "durationCode") throw new CatalogValidationError("Corps invalide.");
  const code = value.durationCode;
  if (typeof code !== "string" || !(BOOST_DURATION_CODES as readonly string[]).includes(code)) {
    throw new CatalogValidationError("durationCode doit valoir 24h, 3d ou 7d.");
  }
  return code as BoostDurationCode;
}

/** Seul `limit` est admis : entier de 1 à 50, défaut 20, ni dupliqué ni mal formé. */
function parseHistoryLimit(request: Request): number {
  const parameters = new URL(request.url).searchParams;
  if ([...parameters.keys()].some((key) => key !== "limit")) throw new CatalogValidationError("Paramètre non autorisé.");
  const supplied = parameters.getAll("limit");
  if (supplied.length > 1) throw new CatalogValidationError("Paramètre « limit » dupliqué.");
  if (supplied.length === 0) return BOOST_HISTORY_DEFAULT_LIMIT;
  if (!/^[0-9]+$/.test(supplied[0])) throw new CatalogValidationError("limit doit être un entier.");
  const limit = Number(supplied[0]);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > BOOST_HISTORY_MAX_LIMIT) {
    throw new CatalogValidationError(`limit doit être compris entre 1 et ${BOOST_HISTORY_MAX_LIMIT}.`);
  }
  return limit;
}

// ───────────── gestionnaires ─────────────

/** Code de journal d'une erreur : celui du domaine ou SQLSTATE/réseau s'il a la forme d'un code, jamais le message. */
function logCodeOf(error: unknown): string {
  if (error instanceof BoostError) return error.code;
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" && LOG_CODE.test(code) ? code : "unexpected_error";
}

export function createBoostHttpHandlers(dependencies: BoostHttpDependencies = {}): BoostHttpHandlers {
  const environment = (): Environment => dependencies.env ?? process.env;
  const readSession = dependencies.resolveSession ?? resolveStoredSession;

  function journal(code: string): void {
    try {
      if (dependencies.log) dependencies.log(code);
      else console.error(`[boost-http] ${code}`);
    } catch {
      // Un journal défaillant ne doit jamais changer la réponse.
    }
  }

  function unavailable(code: string): Response {
    journal(code);
    return boostUnavailable();
  }

  /** Domaine → HTTP. Tout ce qui n'est pas explicitement connu devient 503 `boost_unavailable`, sans le message de l'erreur. */
  function mapError(error: unknown): Response {
    if (error instanceof CatalogValidationError) return invalidRequest();
    if (error instanceof BoostError) {
      if (error.code === "offer_not_found" || error.code === "offer_not_owned") return resourceNotFound();
      if (error.code === "offer_not_eligible") return offerNotEligible();
      if (error.code === "offer_not_boostable") return offerNotBoostable();
      if (error.code === "rate_limited") return rateLimited();
      if (error.code === "reach_check_unavailable") {
        journal(error.code);
        return reachCheckUnavailable();
      }
    }
    return unavailable(logCodeOf(error));
  }

  async function authenticate(request: Request): Promise<{ ok: true; ownerId: string } | { ok: false; response: Response }> {
    const token = readSingleCookie(request, AUTH_SESSION_COOKIE);
    if (!token) return { ok: false, response: unauthorized() };
    try {
      const session = await readSession(token, { pool: dependencies.pool, now: dependencies.now });
      return session ? { ok: true, ownerId: session.userId } : { ok: false, response: unauthorized() };
    } catch (error) {
      return { ok: false, response: unavailable(logCodeOf(error)) };
    }
  }

  return {
    quotes: {
      async create(request, id) {
        // Origine AVANT la session : une requête d'origine douteuse n'atteint ni la base ni la résolution de session.
        const origin = checkPostOrigin(request, environment().NOMA_AUTH_ORIGIN);
        if (origin === "unconfigured") return unavailable("origin_unconfigured");
        if (origin === "forbidden") return forbiddenOrigin();

        const authenticated = await authenticate(request);
        if (!authenticated.ok) return authenticated.response;
        if (!UUID.test(id)) return invalidRequest();

        const body = await readJsonBodyCapped(request, BOOST_HTTP_BODY_MAX_BYTES);
        if (!body.ok) return invalidRequest();
        try {
          const durationCode = parseQuoteBody(body.value);
          const quote = await quoteOfferBoost({
            pool: dependencies.pool ?? getPostgresPool(),
            ownerId: authenticated.ownerId,
            offerId: id,
            durationCode,
          });
          return noStoreJsonResponse(quote.reused ? 200 : 201, {
            contractVersion: BOOST_QUOTE_CONTRACT_VERSION,
            quote: { ...quoteDto(quote), reused: quote.reused },
          });
        } catch (error) {
          return mapError(error);
        }
      },

      async list(request, id) {
        const authenticated = await authenticate(request);
        if (!authenticated.ok) return authenticated.response;
        if (!UUID.test(id)) return invalidRequest();
        try {
          const limit = parseHistoryLimit(request);
          const quotes = await listOfferBoostQuotes({
            pool: dependencies.pool ?? getPostgresPool(),
            ownerId: authenticated.ownerId,
            offerId: id,
            limit,
          });
          return noStoreJsonResponse(200, {
            contractVersion: BOOST_QUOTE_CONTRACT_VERSION,
            quotes: quotes.map((quote) => ({ ...quoteDto(quote), expired: quote.expired })),
          });
        } catch (error) {
          return mapError(error);
        }
      },
    },
  };
}

export const defaultBoostHttpHandlers = createBoostHttpHandlers();
