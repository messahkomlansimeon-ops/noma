import "server-only";

import type { Pool } from "pg";
import { AUTH_SESSION_COOKIE } from "../auth/http";
import { resolveSession as resolveStoredSession } from "../auth/sessions";
import type { AuthClock, ResolvedSession, SessionContext } from "../auth/types";
import { CatalogValidationError } from "../catalog/errors";
import { checkPostOrigin, noStoreJsonResponse, readSingleCookie } from "../http/protection";
import { getPostgresPool } from "../postgres/client";
import { WALLET_MAX_SAFE_AMOUNT } from "../wallet/config";
import { WalletError } from "../wallet/errors";
import { readStrictJsonBody } from "../wallet/http";
import { BoostError, type BoostErrorCode } from "./boosts";
import { BOOST_REACH_RETRY_AFTER_SECONDS, type BoostDurationCode } from "./boost-config";
import { listOfferBoostPurchases, purchaseOfferBoost, type BoostPurchaseHistoryItem, type BoostPurchaseResult } from "./purchase";

/**
 * Routes HTTP de l'achat de boost (lot P1b) : le vendeur achète le boost d'une de SES cotations avec les crédits de son portefeuille,
 * et relit l'historique des achats de SON offre. Aucune route de remboursement (opération d'administration). Voir BOOST-PURCHASE.md.
 *
 * Garanties (mêmes que boost/http.ts et wallet/http.ts) : origine vérifiée AVANT la session sur le POST ; session obligatoire (le
 * vendeur vient toujours de la session) ; propriétaire seulement ; 404 indiscernables (offre inconnue, offre d'autrui, cotation
 * inconnue ou d'une autre offre ou d'un autre vendeur) ; DTO en liste blanche avec `contractVersion` ; montants en entiers JSON ;
 * messages fixes ; corps en JSON STRICT (lib/server/wallet/strict-json.ts) ; journal serveur limité à un code.
 */

export const BOOST_PURCHASE_CONTRACT_VERSION = "boost-purchase/v1";

/** Plafond du corps du POST, en octets (comme les corps utilisateur du portefeuille). */
export const BOOST_PURCHASE_HTTP_BODY_MAX_BYTES = 2_048;

export const BOOST_PURCHASE_HISTORY_DEFAULT_LIMIT = 20;
export const BOOST_PURCHASE_HISTORY_MAX_LIMIT = 50;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LOG_CODE = /^[A-Za-z0-9_]{1,40}$/;

type Environment = Record<string, string | undefined>;

export interface BoostPurchaseHttpDependencies {
  pool?: Pool;
  now?: AuthClock;
  env?: Environment;
  /** Résolution de session (défaut : `resolveSession` de lib/server/auth). */
  resolveSession?: (token: string, context: SessionContext) => Promise<ResolvedSession | null>;
  /** Journal serveur : ne reçoit QU'UN code (jamais de message brut, de requête ni d'identifiant). Un journal qui lève est ignoré. */
  log?: (code: string) => void;
}

export interface BoostPurchaseHttpHandlers {
  purchases: {
    /** POST /api/offers/{id}/boost-purchases : acheter le boost d'une cotation du vendeur. */
    create(request: Request, id: string): Promise<Response>;
    /** GET /api/offers/{id}/boost-purchases : historique des achats du vendeur pour son offre. */
    list(request: Request, id: string): Promise<Response>;
  };
}

// ───────────── réponses (textes fixes, jamais de donnée de la base) ─────────────

function purchaseError(status: number, code: string, message: string): Response {
  return noStoreJsonResponse(status, { error: { code, message } });
}

const unauthorized = () => purchaseError(401, "authentication_required", "Authentification requise.");
const forbiddenOrigin = () => purchaseError(403, "invalid_origin", "Origine de la requête non autorisée.");
const invalidRequest = () => purchaseError(400, "invalid_request", "Requête invalide.");
/** Offre ou cotation inexistantes, offre d'autrui, cotation d'une autre offre ou d'un autre vendeur : la MÊME réponse. */
const resourceNotFound = () => purchaseError(404, "resource_not_found", "Ressource introuvable.");
const purchaseUnavailable = () => purchaseError(503, "boost_purchase_unavailable", "L'achat de boost est temporairement indisponible.");

/** Vérification de la portée non terminée à temps (lot P3-bis) : 503 retriable (même clé d'idempotence), texte fixe, `Retry-After` court ; rien n'est écrit. */
const reachCheckUnavailable = () => noStoreJsonResponse(
  503,
  { error: { code: "reach_check_unavailable", message: "Vérification impossible pour le moment, réessayez dans un instant." } },
  { "retry-after": String(BOOST_REACH_RETRY_AFTER_SECONDS) },
);

/** Refus de règle métier : 409, code et message fixes. */
const CONFLICTS: Readonly<Record<string, string>> = Object.freeze({
  quote_expired: "Cette cotation a expiré : demandez-en une nouvelle.",
  quote_unavailable: "Cette cotation est indisponible : aucun prix n'a été établi.",
  quote_already_used: "Cette cotation a déjà été achetée.",
  offer_not_eligible: "Cette offre n'est pas éligible au boost.",
  offer_already_boosted: "Cette offre a déjà un boost actif.",
  no_slot_available: "Aucune place de boost disponible dans ce périmètre.",
  seller_boost_limit_reached: "Le plafond de boosts de ce vendeur dans ce périmètre est atteint.",
  no_visible_effect: "Ce boost ne ferait monter votre annonce chez aucun acheteur : rien n'a été acheté.",
  insufficient_balance: "Solde insuffisant.",
  idempotency_conflict: "Cette clé d'idempotence a déjà servi pour un autre achat.",
});

const conflict = (code: string) => purchaseError(409, code, CONFLICTS[code]);

// ───────────── DTO (liste blanche explicite : aucun champ n'est copié par défaut) ─────────────

function jsonInteger(value: bigint): number {
  if (value > WALLET_MAX_SAFE_AMOUNT || value < -WALLET_MAX_SAFE_AMOUNT) throw new RangeError("montant hors des entiers sûrs");
  return Number(value);
}

interface PurchaseDto {
  id: string;
  quoteId: string;
  durationCode: BoostDurationCode;
  amountXof: number;
  startsAt: string;
  endsAt: string;
}

/** Jamais : identifiant de boost, de transaction, de vendeur ni d'offre, clé d'idempotence. */
function purchaseDto(result: BoostPurchaseResult): PurchaseDto {
  return {
    id: result.purchase.id,
    quoteId: result.purchase.quoteId,
    durationCode: result.purchase.durationCode,
    amountXof: jsonInteger(result.purchase.amount),
    startsAt: result.boost.startsAt.toISOString(),
    endsAt: result.boost.endsAt.toISOString(),
  };
}

/** Jamais : identifiant de boost, de transaction, de vendeur ni d'offre, clé d'idempotence, état du boost. */
function historyDto(item: BoostPurchaseHistoryItem) {
  return {
    id: item.id,
    quoteId: item.quoteId,
    durationCode: item.durationCode,
    amountXof: jsonInteger(item.amount),
    startsAt: item.startsAt.toISOString(),
    endsAt: item.endsAt.toISOString(),
    createdAt: item.createdAt.toISOString(),
    refundedAt: item.refundedAt === null ? null : item.refundedAt.toISOString(),
  };
}

// ───────────── lecture stricte des entrées ─────────────

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Exactement `{ "quoteId": uuid, "idempotencyKey": uuid }` : objet, deux clés obligatoires, aucune autre. */
function parsePurchaseBody(value: unknown): { quoteId: string; idempotencyKey: string } {
  if (!isPlainObject(value)) throw new CatalogValidationError("Corps invalide.");
  const keys = Object.keys(value);
  if (keys.length !== 2 || !keys.includes("quoteId") || !keys.includes("idempotencyKey")) throw new CatalogValidationError("Corps invalide.");
  const { quoteId, idempotencyKey } = value;
  if (typeof quoteId !== "string" || !UUID.test(quoteId)) throw new CatalogValidationError("quoteId doit être un UUID.");
  if (typeof idempotencyKey !== "string" || !UUID.test(idempotencyKey)) throw new CatalogValidationError("idempotencyKey doit être un UUID.");
  return { quoteId, idempotencyKey };
}

/** Seul `limit` est admis : entier de 1 à 50, défaut 20, ni dupliqué ni mal formé. */
function parseHistoryLimit(request: Request): number {
  const parameters = new URL(request.url).searchParams;
  if ([...parameters.keys()].some((key) => key !== "limit")) throw new CatalogValidationError("Paramètre non autorisé.");
  const supplied = parameters.getAll("limit");
  if (supplied.length > 1) throw new CatalogValidationError("Paramètre « limit » dupliqué.");
  if (supplied.length === 0) return BOOST_PURCHASE_HISTORY_DEFAULT_LIMIT;
  if (!/^[0-9]+$/.test(supplied[0])) throw new CatalogValidationError("limit doit être un entier.");
  const limit = Number(supplied[0]);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > BOOST_PURCHASE_HISTORY_MAX_LIMIT) {
    throw new CatalogValidationError(`limit doit être compris entre 1 et ${BOOST_PURCHASE_HISTORY_MAX_LIMIT}.`);
  }
  return limit;
}

// ───────────── gestionnaires ─────────────

/** Code de journal d'une erreur : celui du domaine ou SQLSTATE/réseau s'il a la forme d'un code, jamais le message. */
function logCodeOf(error: unknown): string {
  if (error instanceof BoostError || error instanceof WalletError) return error.code;
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" && LOG_CODE.test(code) ? code : "unexpected_error";
}

const NOT_FOUND_CODES: ReadonlySet<BoostErrorCode> = new Set(["offer_not_found", "offer_not_owned", "quote_not_found"]);
const CONFLICT_CODES: ReadonlySet<BoostErrorCode> = new Set([
  "quote_expired", "quote_unavailable", "quote_already_used", "offer_not_eligible", "offer_already_boosted", "no_slot_available",
  "seller_boost_limit_reached", "idempotency_conflict", "no_visible_effect",
]);

export function createBoostPurchaseHttpHandlers(dependencies: BoostPurchaseHttpDependencies = {}): BoostPurchaseHttpHandlers {
  const environment = (): Environment => dependencies.env ?? process.env;
  const readSession = dependencies.resolveSession ?? resolveStoredSession;

  function journal(code: string): void {
    try {
      if (dependencies.log) dependencies.log(code);
      else console.error(`[boost-purchase-http] ${code}`);
    } catch {
      // Un journal défaillant ne doit jamais changer la réponse.
    }
  }

  function unavailable(code: string): Response {
    journal(code);
    return purchaseUnavailable();
  }

  /** Domaine → HTTP. Tout ce qui n'est pas explicitement connu devient 503, sans le message de l'erreur. */
  function mapError(error: unknown): Response {
    if (error instanceof CatalogValidationError) return invalidRequest();
    if (error instanceof BoostError) {
      if (NOT_FOUND_CODES.has(error.code)) return resourceNotFound();
      // Une offre qui a perdu sa clé produit n'est plus éligible au boost.
      if (error.code === "offer_not_boostable") return conflict("offer_not_eligible");
      if (CONFLICT_CODES.has(error.code)) return conflict(error.code);
      if (error.code === "reach_check_unavailable") {
        journal(error.code);
        return reachCheckUnavailable();
      }
    }
    if (error instanceof WalletError && error.code === "insufficient_balance") return conflict("insufficient_balance");
    return unavailable(logCodeOf(error));
  }

  async function authenticate(request: Request): Promise<{ ok: true; sellerId: string } | { ok: false; response: Response }> {
    const token = readSingleCookie(request, AUTH_SESSION_COOKIE);
    if (!token) return { ok: false, response: unauthorized() };
    try {
      const session = await readSession(token, { pool: dependencies.pool, now: dependencies.now });
      return session ? { ok: true, sellerId: session.userId } : { ok: false, response: unauthorized() };
    } catch (error) {
      return { ok: false, response: unavailable(logCodeOf(error)) };
    }
  }

  return {
    purchases: {
      async create(request, id) {
        // Origine AVANT la session : une requête d'origine douteuse n'atteint ni la base ni la résolution de session.
        const origin = checkPostOrigin(request, environment().NOMA_AUTH_ORIGIN);
        if (origin === "unconfigured") return unavailable("origin_unconfigured");
        if (origin === "forbidden") return forbiddenOrigin();

        const authenticated = await authenticate(request);
        if (!authenticated.ok) return authenticated.response;
        if (!UUID.test(id)) return invalidRequest();

        const body = await readStrictJsonBody(request, BOOST_PURCHASE_HTTP_BODY_MAX_BYTES);
        if (!body.ok) return invalidRequest();
        try {
          const { quoteId, idempotencyKey } = parsePurchaseBody(body.value);
          const result = await purchaseOfferBoost({
            pool: dependencies.pool ?? getPostgresPool(),
            sellerId: authenticated.sellerId,
            offerId: id,
            quoteId,
            idempotencyKey,
          });
          return noStoreJsonResponse(result.reused ? 200 : 201, {
            contractVersion: BOOST_PURCHASE_CONTRACT_VERSION,
            purchase: { ...purchaseDto(result), reused: result.reused },
            balanceXof: jsonInteger(result.balance),
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
          const purchases = await listOfferBoostPurchases({
            pool: dependencies.pool ?? getPostgresPool(),
            sellerId: authenticated.sellerId,
            offerId: id,
            limit,
          });
          return noStoreJsonResponse(200, {
            contractVersion: BOOST_PURCHASE_CONTRACT_VERSION,
            purchases: purchases.map(historyDto),
          });
        } catch (error) {
          return mapError(error);
        }
      },
    },
  };
}

export const defaultBoostPurchaseHttpHandlers = createBoostPurchaseHttpHandlers();
