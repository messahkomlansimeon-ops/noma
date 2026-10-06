import "server-only";

import type { Pool } from "pg";
import { AUTH_SESSION_COOKIE } from "../auth/http";
import { resolveSession as resolveStoredSession } from "../auth/sessions";
import type { AuthClock, ResolvedSession, SessionContext } from "../auth/types";
import { CatalogValidationError } from "../catalog/errors";
import { checkPostOrigin, noStoreJsonResponse, readBodyCapped, readSingleCookie } from "../http/protection";
import { getPostgresPool } from "../postgres/client";
import {
  FAKE_SIGNATURE_HEADER, FAKE_WEBHOOK_MAX_BODY_BYTES, WALLET_CONTRACT_VERSION, WALLET_HISTORY_DEFAULT_LIMIT,
  WALLET_HISTORY_MAX_LIMIT, WALLET_MAX_SAFE_AMOUNT,
} from "./config";
import { WalletError } from "./errors";
import {
  buildFakePaymentEventBody, processFakePaymentEvent, resolveFakePaymentConfig, signFakePaymentBody,
} from "./fake-provider";
import { readWalletOverview, type WalletHistoryItem } from "./ledger";
import { parseStrictJson, StrictJsonError } from "./strict-json";
import {
  createTopupIntent, readTopupIntent, type PaymentEventOutcome, type PaymentEventType, type PaymentIntent, type PaymentIntentStatus,
} from "./topups";

/**
 * Routes HTTP du portefeuille (lot P1a) : solde et historique, recharge par prestataire FICTIF, webhook signé et routes de
 * développement qui simulent le prestataire. Aucun achat de boost, remboursement, écran ni prestataire réel. Voir WALLET.md.
 *
 * Garanties : origine vérifiée AVANT la session sur les POST de l'utilisateur ; session obligatoire (le propriétaire vient
 * toujours de la session, jamais du corps ni de l'URL) ; DTO en liste blanche avec `contractVersion` ; montants en entiers JSON ;
 * erreurs à code et message fixes ; 404 indiscernables ; journal serveur limité à un code.
 */

/** Plafond du corps d'une requête utilisateur (JSON), en octets. */
export const WALLET_HTTP_BODY_MAX_BYTES = 2_048;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LOG_CODE = /^[A-Za-z0-9_]{1,40}$/;

type Environment = Record<string, string | undefined>;

export interface WalletHttpDependencies {
  pool?: Pool;
  /** Horloge de session ET de la fenêtre d'horodatage des événements (défaut : l'heure du système). */
  now?: AuthClock;
  env?: Environment;
  /** Résolution de session (défaut : `resolveSession` de lib/server/auth). */
  resolveSession?: (token: string, context: SessionContext) => Promise<ResolvedSession | null>;
  /** Journal serveur : ne reçoit QU'UN code. Un journal qui lève est ignoré. Défaut : console.error. */
  log?: (code: string) => void;
}

export interface WalletHttpHandlers {
  wallet: {
    /** GET /api/wallet : solde et historique de l'utilisateur de la session. */
    get(request: Request): Promise<Response>;
  };
  topups: {
    /** POST /api/wallet/topups : créer (ou retrouver) une intention de recharge. */
    create(request: Request): Promise<Response>;
    /** GET /api/wallet/topups/{id} : état d'une intention de l'utilisateur. */
    get(request: Request, id: string): Promise<Response>;
  };
  fakePayments: {
    /** POST /api/payments/fake/webhook : événement signé du prestataire fictif (aucune session, aucune origine). */
    webhook(request: Request): Promise<Response>;
    /** POST /api/dev/fake-payments/{id}/confirm : simule un paiement réussi de l'intention de l'utilisateur. */
    confirm(request: Request, id: string): Promise<Response>;
    /** POST /api/dev/fake-payments/{id}/fail : simule un paiement échoué. */
    fail(request: Request, id: string): Promise<Response>;
  };
}

// ───────────── réponses (textes fixes, jamais de donnée de la base) ─────────────

function walletError(status: number, code: string, message: string): Response {
  return noStoreJsonResponse(status, { error: { code, message } });
}

const unauthorized = () => walletError(401, "authentication_required", "Authentification requise.");
const forbiddenOrigin = () => walletError(403, "invalid_origin", "Origine de la requête non autorisée.");
const invalidRequest = () => walletError(400, "invalid_request", "Requête invalide.");
/** Intention inexistante ET intention d'autrui : la MÊME réponse. Sert aussi aux routes fictives quand le prestataire est inactif. */
const resourceNotFound = () => walletError(404, "resource_not_found", "Ressource introuvable.");
const idempotencyConflict = () => walletError(409, "idempotency_conflict", "Cette clé d'idempotence a déjà servi pour un autre montant.");
const tooManyPendingTopups = () => walletError(409, "too_many_pending_topups", "Trop de recharges en attente.");
const paymentUnavailable = () => walletError(503, "payment_unavailable", "Le paiement est temporairement indisponible.");
const walletUnavailable = () => walletError(503, "wallet_unavailable", "Le portefeuille est temporairement indisponible.");
const invalidSignature = () => walletError(400, "invalid_signature", "Signature invalide.");
const invalidEvent = () => walletError(400, "invalid_event", "Événement invalide.");

// ───────────── DTO (liste blanche explicite : aucun champ n'est copié par défaut) ─────────────

function jsonInteger(value: bigint): number {
  if (value > WALLET_MAX_SAFE_AMOUNT || value < -WALLET_MAX_SAFE_AMOUNT) throw new RangeError("montant hors des entiers sûrs");
  return Number(value);
}

interface TopupDto {
  id: string;
  amountXof: number;
  status: PaymentIntentStatus;
  expiresAt: string;
  checkoutPath: string;
}

/** Jamais : owner_id, clé d'idempotence, référence du prestataire, statut enregistré, dates internes. */
function topupDto(intent: PaymentIntent): TopupDto {
  return {
    id: intent.id,
    amountXof: jsonInteger(intent.amountXof),
    status: intent.status,
    expiresAt: intent.expiresAt.toISOString(),
    // La page de paiement simulé viendra au lot P2 : le chemin est seulement renvoyé.
    checkoutPath: `/paiement-simule/${intent.id}`,
  };
}

interface WalletTransactionDto {
  id: string;
  kind: WalletHistoryItem["kind"];
  amountXof: number;
  createdAt: string;
}

/** Jamais : identifiant de compte, référence, métadonnées, écritures de la contrepartie. */
function transactionDto(item: WalletHistoryItem): WalletTransactionDto {
  return { id: item.id, kind: item.kind, amountXof: jsonInteger(item.amount), createdAt: item.createdAt.toISOString() };
}

// ───────────── lecture stricte des entrées ─────────────

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Corps JSON strict (voir strict-json.ts) : `Content-Type: application/json`, plafond d'octets, aucune clé en double. */
async function readStrictJsonBody(request: Request, maxBytes: number): Promise<{ ok: true; value: unknown } | { ok: false }> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") {
    void request.body?.cancel().catch(() => {});
    return { ok: false };
  }
  const body = await readBodyCapped(request, maxBytes);
  if (!body.ok) return { ok: false };
  try {
    return { ok: true, value: parseStrictJson(body.text) };
  } catch (error) {
    if (error instanceof StrictJsonError) return { ok: false };
    throw error;
  }
}

/** Exactement `{ "amountXof": entier, "idempotencyKey": uuid }` : aucune autre clé. Les bornes du montant sont celles du domaine. */
function parseTopupBody(value: unknown): { amountXof: bigint; idempotencyKey: string } {
  if (!isPlainObject(value)) throw new CatalogValidationError("Corps invalide.");
  const keys = Object.keys(value);
  if (keys.length !== 2 || !keys.includes("amountXof") || !keys.includes("idempotencyKey")) throw new CatalogValidationError("Corps invalide.");
  const { amountXof, idempotencyKey } = value;
  if (typeof amountXof !== "number" || !Number.isSafeInteger(amountXof)) throw new CatalogValidationError("amountXof doit être un entier.");
  if (typeof idempotencyKey !== "string") throw new CatalogValidationError("idempotencyKey doit être un UUID.");
  return { amountXof: BigInt(amountXof), idempotencyKey };
}

/** Seuls `limit` (entier de 1 à 50, défaut 20) et `cursor` sont admis, chacun au plus une fois. */
function parseWalletQuery(request: Request): { limit: number; cursor: string | null } {
  const parameters = new URL(request.url).searchParams;
  if ([...parameters.keys()].some((key) => key !== "limit" && key !== "cursor")) throw new CatalogValidationError("Paramètre non autorisé.");
  const limits = parameters.getAll("limit");
  const cursors = parameters.getAll("cursor");
  if (limits.length > 1 || cursors.length > 1) throw new CatalogValidationError("Paramètre dupliqué.");
  let limit = WALLET_HISTORY_DEFAULT_LIMIT;
  if (limits.length === 1) {
    if (!/^[0-9]+$/.test(limits[0])) throw new CatalogValidationError("limit doit être un entier.");
    limit = Number(limits[0]);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > WALLET_HISTORY_MAX_LIMIT) {
      throw new CatalogValidationError(`limit doit être compris entre 1 et ${WALLET_HISTORY_MAX_LIMIT}.`);
    }
  }
  return { limit, cursor: cursors.length === 1 ? cursors[0] : null };
}

/** Corps brut en octets (la signature porte sur les octets exacts, pas sur un texte re-encodé), plafonné. */
async function readRawBodyCapped(request: Request, maxBytes: number): Promise<{ ok: true; bytes: Uint8Array } | { ok: false }> {
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^[0-9]+$/.test(declared) || BigInt(declared) > BigInt(maxBytes))) {
    void request.body?.cancel().catch(() => {});
    return { ok: false };
  }
  if (!request.body) return { ok: true, bytes: new Uint8Array(0) };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        return { ok: false };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false };
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes };
}

// ───────────── gestionnaires ─────────────

/** Code de journal d'une erreur : celui du domaine ou SQLSTATE/réseau s'il a la forme d'un code, jamais le message. */
function logCodeOf(error: unknown): string {
  if (error instanceof WalletError) return error.code;
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" && LOG_CODE.test(code) ? code : "unexpected_error";
}

export function createWalletHttpHandlers(dependencies: WalletHttpDependencies = {}): WalletHttpHandlers {
  const environment = (): Environment => dependencies.env ?? process.env;
  const readSession = dependencies.resolveSession ?? resolveStoredSession;
  const clock = (): Date => (dependencies.now ?? (() => new Date()))();
  const pool = (): Pool => dependencies.pool ?? getPostgresPool();

  function journal(code: string): void {
    try {
      if (dependencies.log) dependencies.log(code);
      else console.error(`[wallet-http] ${code}`);
    } catch {
      // Un journal défaillant ne doit jamais changer la réponse.
    }
  }

  function unavailable(code: string, response: () => Response = paymentUnavailable): Response {
    journal(code);
    return response();
  }

  /** Domaine → HTTP. Tout ce qui n'est pas explicitement connu devient 503, sans le message de l'erreur. */
  function mapError(error: unknown, response: () => Response = paymentUnavailable): Response {
    if (error instanceof CatalogValidationError) return invalidRequest();
    if (error instanceof WalletError) {
      if (error.code === "idempotency_conflict") return idempotencyConflict();
      if (error.code === "too_many_pending_topups") return tooManyPendingTopups();
    }
    return unavailable(logCodeOf(error), response);
  }

  async function authenticate(request: Request, response: () => Response = paymentUnavailable): Promise<{ ok: true; ownerId: string } | { ok: false; response: Response }> {
    const token = readSingleCookie(request, AUTH_SESSION_COOKIE);
    if (!token) return { ok: false, response: unauthorized() };
    try {
      const session = await readSession(token, { pool: dependencies.pool, now: dependencies.now });
      return session ? { ok: true, ownerId: session.userId } : { ok: false, response: unauthorized() };
    } catch (error) {
      return { ok: false, response: unavailable(logCodeOf(error), response) };
    }
  }

  /** Origine AVANT la session : une requête d'origine douteuse n'atteint ni la résolution de session ni la base. */
  function originRefusal(request: Request): Response | null {
    const origin = checkPostOrigin(request, environment().NOMA_AUTH_ORIGIN);
    if (origin === "unconfigured") return unavailable("origin_unconfigured");
    return origin === "forbidden" ? forbiddenOrigin() : null;
  }

  /** Simule un événement du prestataire pour l'intention de l'utilisateur, par le MÊME chemin que le webhook. */
  async function simulateEvent(request: Request, id: string, type: PaymentEventType): Promise<Response> {
    const config = resolveFakePaymentConfig(environment());
    if (!config.enabled) return resourceNotFound();
    const refused = originRefusal(request);
    if (refused) return refused;
    const authenticated = await authenticate(request);
    if (!authenticated.ok) return authenticated.response;
    if (!UUID.test(id)) return invalidRequest();
    const body = await readBodyCapped(request, 64);
    if (!body.ok || body.text.trim().length > 0) return invalidRequest();
    try {
      const intent = await readTopupIntent({ pool: pool(), ownerId: authenticated.ownerId, intentId: id });
      if (!intent) return resourceNotFound();
      const now = clock();
      const bytes = new TextEncoder().encode(buildFakePaymentEventBody({
        type, providerReference: intent.providerReference, amountXof: intent.amountXof, now,
      }));
      const processed = await processFakePaymentEvent({
        pool: pool(), secret: config.secret, body: bytes, signature: signFakePaymentBody(config.secret, bytes), now,
      });
      if (processed.status !== "processed") return unavailable(`simulated_event_${processed.status}`);
      const fresh = await readTopupIntent({ pool: pool(), ownerId: authenticated.ownerId, intentId: id });
      if (!fresh) return resourceNotFound();
      const outcome: PaymentEventOutcome | "replayed" = processed.result.outcome;
      return noStoreJsonResponse(200, { contractVersion: WALLET_CONTRACT_VERSION, outcome, topup: topupDto(fresh) });
    } catch (error) {
      return mapError(error);
    }
  }

  return {
    wallet: {
      async get(request) {
        const authenticated = await authenticate(request, walletUnavailable);
        if (!authenticated.ok) return authenticated.response;
        try {
          const { limit, cursor } = parseWalletQuery(request);
          const overview = await readWalletOverview({ pool: pool(), ownerId: authenticated.ownerId, limit, cursor });
          return noStoreJsonResponse(200, {
            contractVersion: WALLET_CONTRACT_VERSION,
            balanceXof: jsonInteger(overview.balance),
            transactions: overview.items.map(transactionDto),
            nextCursor: overview.nextCursor,
          });
        } catch (error) {
          return mapError(error, walletUnavailable);
        }
      },
    },

    topups: {
      async create(request) {
        const refused = originRefusal(request);
        if (refused) return refused;
        const authenticated = await authenticate(request);
        if (!authenticated.ok) return authenticated.response;
        if (!resolveFakePaymentConfig(environment()).enabled) return unavailable("provider_inactive");
        const body = await readStrictJsonBody(request, WALLET_HTTP_BODY_MAX_BYTES);
        if (!body.ok) return invalidRequest();
        try {
          const { amountXof, idempotencyKey } = parseTopupBody(body.value);
          const created = await createTopupIntent({ pool: pool(), ownerId: authenticated.ownerId, amountXof, idempotencyKey });
          return noStoreJsonResponse(created.reused ? 200 : 201, {
            contractVersion: WALLET_CONTRACT_VERSION,
            topup: topupDto(created.intent),
          });
        } catch (error) {
          return mapError(error);
        }
      },

      async get(request, id) {
        const authenticated = await authenticate(request);
        if (!authenticated.ok) return authenticated.response;
        if (!resolveFakePaymentConfig(environment()).enabled) return unavailable("provider_inactive");
        if (!UUID.test(id)) return invalidRequest();
        try {
          const intent = await readTopupIntent({ pool: pool(), ownerId: authenticated.ownerId, intentId: id });
          if (!intent) return resourceNotFound();
          return noStoreJsonResponse(200, { contractVersion: WALLET_CONTRACT_VERSION, topup: topupDto(intent) });
        } catch (error) {
          return mapError(error);
        }
      },
    },

    fakePayments: {
      async webhook(request) {
        // Prestataire inactif : la route n'existe pas (404), avant toute lecture du corps.
        const config = resolveFakePaymentConfig(environment());
        if (!config.enabled) return resourceNotFound();
        const signature = request.headers.get(FAKE_SIGNATURE_HEADER);
        const raw = await readRawBodyCapped(request, FAKE_WEBHOOK_MAX_BODY_BYTES);
        if (!raw.ok) {
          journal("webhook_invalid_event");
          return invalidEvent();
        }
        try {
          const processed = await processFakePaymentEvent({ pool: pool, secret: config.secret, body: raw.bytes, signature, now: clock() });
          if (processed.status === "invalid_signature") {
            // Compté, jamais stocké : le journal applicatif ne reçoit qu'un code.
            journal("webhook_invalid_signature");
            return invalidSignature();
          }
          if (processed.status === "invalid_event") {
            journal("webhook_invalid_event");
            return invalidEvent();
          }
          if (processed.result.outcome === "replayed" && !processed.result.payloadMatches) journal("webhook_event_id_reused");
          // « Reçu », pas « appliqué » : la réponse ne révèle jamais l'issue (appliqué, doublon, refusé) ; elle est dans le journal.
          return noStoreJsonResponse(200, { received: true });
        } catch (error) {
          // 503 : le prestataire pourra rejouer l'événement (idempotent).
          return unavailable(logCodeOf(error));
        }
      },

      confirm: (request, id) => simulateEvent(request, id, "payment.succeeded"),
      fail: (request, id) => simulateEvent(request, id, "payment.failed"),
    },
  };
}

export const defaultWalletHttpHandlers = createWalletHttpHandlers();
