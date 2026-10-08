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
import { PaymentConfigError, resolvePaymentProvider, type ResolvedProvider } from "./payment-provider";
import { parseStrictJson, StrictJsonError } from "./strict-json";
import { SublymusApiError } from "./sublymus/client";
import { readCheckoutUrl } from "./sublymus/checkouts";
import {
  SUBLYMUS_EVENT_HEADER, SUBLYMUS_MANAGER_HEADER, SUBLYMUS_SIGNATURE_HEADER, SUBLYMUS_WEBHOOK_ID_HEADER, SUBLYMUS_WEBHOOK_MAX_BODY_BYTES, resolvePaymentSelection,
} from "./sublymus/config";
import { processSublymusWebhook } from "./sublymus/webhook";
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
  /** Appels sortants vers Sublymus (défaut : fetch du système). Les essais le branchent sur la FAUSSE API locale. */
  fetch?: typeof fetch;
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
  sublymus: {
    /** POST /api/webhooks/sublymus : webhook signé de Sublymus (aucune session, aucune origine : l'authentification est la signature HMAC et le gestionnaire). */
    webhook(request: Request): Promise<Response>;
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
/** Webhook Sublymus non authentifié (signature fausse, absente, mal formée, ou autre gestionnaire) : 401 sans AUCUN détail, identique pour toutes les causes. */
const webhookUnauthorized = () => walletError(401, "unauthorized", "Non autorisé.");
const payloadTooLarge = () => walletError(413, "payload_too_large", "Corps trop volumineux.");
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
  /** Page de l'application : paiement simulé (prestataire fictif) ou retour de paiement (Sublymus). */
  checkoutPath: string;
  /** Prestataire de CETTE recharge (lot PAY1). */
  provider: PaymentIntent["provider"];
  /** Lien de paiement Wave (https) vers lequel rediriger le navigateur ; null : prestataire fictif, session non ouverte, ou recharge terminée. */
  checkoutUrl: string | null;
}

/** Jamais : owner_id, clé d'idempotence, référence du prestataire, statut enregistré, dates internes. Le lien de paiement n'est servi qu'au propriétaire de l'intention. */
function topupDto(intent: PaymentIntent, checkoutUrl: string | null = null): TopupDto {
  return {
    id: intent.id,
    amountXof: jsonInteger(intent.amountXof),
    status: intent.status,
    expiresAt: intent.expiresAt.toISOString(),
    checkoutPath: intent.provider === "sublymus" ? `/paiement-retour/${intent.id}` : `/paiement-simule/${intent.id}`,
    provider: intent.provider,
    checkoutUrl: intent.status === "pending" ? checkoutUrl : null,
  };
}

interface WalletTransactionDto {
  id: string;
  kind: WalletHistoryItem["kind"];
  /** Crédits PAYÉS, signé du côté de l'utilisateur. */
  amountXof: number;
  /** Crédits PROMOTIONNELS (lot PRO1), signé du côté de l'utilisateur ; 0 si l'opération n'y touche pas. */
  promoAmountXof: number;
  createdAt: string;
}

/** Jamais : identifiant de compte, référence, métadonnées, écritures de la contrepartie. */
function transactionDto(item: WalletHistoryItem): WalletTransactionDto {
  return {
    id: item.id,
    kind: item.kind,
    amountXof: jsonInteger(item.amount),
    promoAmountXof: jsonInteger(item.promoAmount),
    createdAt: item.createdAt.toISOString(),
  };
}

// ───────────── lecture stricte des entrées ─────────────

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Corps JSON strict (voir strict-json.ts) : `Content-Type: application/json`, plafond d'octets, aucune clé en double. Partagé avec l'achat de boost (P1b). */
export async function readStrictJsonBody(request: Request, maxBytes: number): Promise<{ ok: true; value: unknown } | { ok: false }> {
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
export async function readRawBodyCapped(request: Request, maxBytes: number): Promise<{ ok: true; bytes: Uint8Array } | { ok: false }> {
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

  function paymentProviderState(): "fake" | "sublymus" | "none" {
    try {
      const resolved = resolvePaymentProvider(environment(), { fetch: dependencies.fetch });
      return resolved.active ? resolved.provider.kind : "none";
    } catch {
      return "none";
    }
  }

  /** Prestataire ACTIF (relu à chaque requête) : refus clair si aucun, ou si sa configuration est refusée (code seulement dans le journal : jamais une valeur). */
  function activeProvider(): { ok: true; resolved: Extract<ResolvedProvider, { active: true }> } | { ok: false; response: Response } {
    try {
      const resolved = resolvePaymentProvider(environment(), { fetch: dependencies.fetch });
      return resolved.active ? { ok: true, resolved } : { ok: false, response: unavailable("provider_inactive") };
    } catch (error) {
      return { ok: false, response: unavailable(error instanceof PaymentConfigError ? "provider_misconfigured" : logCodeOf(error)) };
    }
  }

  /** Domaine → HTTP. Tout ce qui n'est pas explicitement connu devient 503, sans le message de l'erreur. */
  function mapError(error: unknown, response: () => Response = paymentUnavailable): Response {
    if (error instanceof CatalogValidationError) return invalidRequest();
    // Sublymus injoignable, clé refusée, réponse incohérente : l'utilisateur ne peut rien y faire, le journal garde le code (jamais la clé ni la réponse).
    if (error instanceof SublymusApiError) return unavailable(error.code, response);
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
      if (!intent || intent.provider !== "fake") return resourceNotFound();
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
            // Prestataire de paiement ACTIF (lot PAY1) : l'écran dit « Paiement par Wave » ou « simulé » d'après le serveur.
            paymentMode: paymentProviderState(),
            balanceXof: jsonInteger(overview.balance),
            promoBalanceXof: jsonInteger(overview.promoBalance),
            promoExpiresAt: overview.promoExpiresAt === null ? null : overview.promoExpiresAt.toISOString(),
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
        const active = activeProvider();
        if (!active.ok) return active.response;
        const body = await readStrictJsonBody(request, WALLET_HTTP_BODY_MAX_BYTES);
        if (!body.ok) return invalidRequest();
        try {
          const { amountXof, idempotencyKey } = parseTopupBody(body.value);
          // La limite de recharges en attente (limite de débit) s'applique ICI, avant tout appel au prestataire.
          const created = await createTopupIntent({ pool: pool(), ownerId: authenticated.ownerId, amountXof, idempotencyKey, provider: active.resolved.provider });
          // Session de paiement chez le prestataire de CETTE recharge (hors de toute transaction) : en cas d'échec, l'intention reste en attente et la même clé réessaiera.
          const prepared = created.intent.provider === active.resolved.provider.kind
            ? await active.resolved.provider.prepareCheckout({ pool: pool(), intent: created.intent })
            : { checkoutUrl: null };
          // Un webhook a pu terminer la recharge pendant l'ouverture de la session : l'état servi (et donc le droit au lien) est RELU, jamais celui de la création.
          const effective = prepared.checkoutUrl === null ? created.intent : ((await readTopupIntent({ pool: pool(), ownerId: authenticated.ownerId, intentId: created.intent.id })) ?? created.intent);
          return noStoreJsonResponse(created.reused ? 200 : 201, {
            contractVersion: WALLET_CONTRACT_VERSION,
            topup: topupDto(effective, prepared.checkoutUrl),
          });
        } catch (error) {
          return mapError(error);
        }
      },

      async get(request, id) {
        const authenticated = await authenticate(request);
        if (!authenticated.ok) return authenticated.response;
        const active = activeProvider();
        if (!active.ok) return active.response;
        if (!UUID.test(id)) return invalidRequest();
        try {
          const intent = await readTopupIntent({ pool: pool(), ownerId: authenticated.ownerId, intentId: id });
          if (!intent) return resourceNotFound();
          const checkoutUrl = intent.provider === "sublymus" && intent.status === "pending" ? await readCheckoutUrl(pool(), intent.id) : null;
          return noStoreJsonResponse(200, { contractVersion: WALLET_CONTRACT_VERSION, topup: topupDto(intent, checkoutUrl) });
        } catch (error) {
          return mapError(error);
        }
      },
    },

    sublymus: {
      async webhook(request) {
        // Prestataire Sublymus inactif : la route n'existe pas (404), avant toute lecture du corps. Configuration refusée : 503 (Sublymus rejouera).
        let selection: ReturnType<typeof resolvePaymentSelection>;
        try {
          selection = resolvePaymentSelection(environment());
        } catch {
          return unavailable("provider_misconfigured");
        }
        if (selection.provider !== "sublymus") return resourceNotFound();
        const raw = await readRawBodyCapped(request, SUBLYMUS_WEBHOOK_MAX_BODY_BYTES);
        if (!raw.ok) {
          journal("webhook_payload_rejected");
          return payloadTooLarge();
        }
        try {
          const processed = await processSublymusWebhook({
            pool,
            secret: selection.config.webhookSecret,
            managerId: selection.config.managerId,
            body: raw.bytes,
            headers: {
              signature: request.headers.get(SUBLYMUS_SIGNATURE_HEADER),
              event: request.headers.get(SUBLYMUS_EVENT_HEADER),
              managerId: request.headers.get(SUBLYMUS_MANAGER_HEADER),
              webhookId: request.headers.get(SUBLYMUS_WEBHOOK_ID_HEADER),
            },
          });
          if (processed.status === "unauthorized") {
            journal("webhook_unauthorized");
            return webhookUnauthorized();
          }
          // Un écart de rapprochement, un événement illisible ou inconnu : l'anomalie est dans la table, on répond 2xx pour que Sublymus ne rejoue pas en boucle un écart qui ne se
          // corrigera pas (seule une signature invalide donne 401 ; jamais 400 pour un événement authentifié).
          if (processed.anomalies.includes("unreadable_event")) journal("webhook_unreadable");
          else if (processed.anomalies.includes("unknown_event")) journal("webhook_unknown_event");
          else if (processed.anomalies.length > 0 || processed.outcome === "anomaly") journal("webhook_anomaly");
          return noStoreJsonResponse(200, { received: true });
        } catch (error) {
          // 503 : Sublymus rejouera la livraison (traitement idempotent).
          return unavailable(logCodeOf(error));
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
