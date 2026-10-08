import "server-only";

import { assertSendable } from "./validation";

/**
 * Client HTTP du fournisseur SMS « Meno » (lot SMS1). Chaque SMS ACCEPTÉ coûte 15 F CFA : ce module ne renvoie « accepted » que sur une réponse explicite du
 * fournisseur, et ne relance JAMAIS un envoi dont le sort est incertain avec une nouvelle clé.
 *
 * API (https://meno.sublymus.com/api/external/sms, ou NOMA_SMS_BASE_URL) :
 *  - POST /send  (Authorization: Bearer <clé>, Idempotency-Key: <8 à 64 caractères A-Za-z0-9._->, JSON {"to":"+225XXXXXXXXXX","content":"…"}) ;
 *  - GET /usage  (consommation du mois UTC).
 *
 * Vérifications LOCALES avant tout appel : pays (+225 seulement), texte (UN segment : GSM-7 ≤ 160 septets, sinon UCS-2 ≤ 70 unités), format de la clé d'idempotence.
 *
 * Résultat d'un envoi :
 *  - 202/2xx avec status « accepted »            → accepted (accepté par l'opérateur : PAS une preuve de livraison) ; un rejeu (`replay: true`) ne renvoie rien ;
 *  - 2xx avec status « unknown » ou « reserved » → uncertain (le message est peut-être parti) : AUCUNE reprise, l'identifiant est gardé pour le rapprochement ;
 *  - 2xx avec un autre statut ou un corps illisible → uncertain (jamais accepted par défaut) ;
 *  - 503 (et toute autre erreur serveur 5xx hors 502) → uncertain, AUCUNE reprise automatique ;
 *  - 401, 409, 422, 502 (et tout autre refus 3xx/4xx) → rejected, échec définitif, jamais repris ;
 *  - 429 → reprise avec la MÊME clé après l'attente indiquée (Retry-After), au plus 3 fois, sans dépasser le délai global ; sinon failed (rate_limited) ;
 *  - erreur réseau AVANT toute réponse (connexion coupée, délai dépassé de 10 s) → reprise avec la MÊME clé, au plus 3 fois, attente croissante ; ensuite failed si aucune
 *    tentative n'a pu atteindre le fournisseur (connexion refusée, nom inconnu…), uncertain sinon.
 *  - (lot SMS1-bis, C1) dès qu'UNE tentative a pu atteindre le fournisseur sans réponse complète (`possiblySent`), TOUTE issue finale qui n'est pas une réponse 2xx explicite
 *    donne `uncertain` (jamais `failed` ni `rejected`) : le message est peut-être parti. Le code d'erreur et le statut HTTP de l'issue sont gardés pour le rapprochement.
 * Le client ne journalise rien et ne met jamais la clé, le texte ou le numéro dans une erreur.
 */

export type SmsFinalStatus = "accepted" | "uncertain" | "rejected" | "failed";

export interface MenoSendOutcome {
  status: SmsFinalStatus;
  /** Dernier statut HTTP reçu (null si aucune réponse). */
  httpStatus: number | null;
  /** Code stable (a-z0-9_), jamais un message du fournisseur. */
  errorCode: string | null;
  /** Identifiant du fournisseur, gardé pour le rapprochement (uncertain comprise). */
  providerId: string | null;
  /** Requêtes HTTP émises (reprises comprises). */
  attempts: number;
  replay: boolean;
}

export interface MenoUsage {
  accepted: number;
  uncertain: number;
  rejected: number;
  acceptedAmountXof: number;
  unitPriceXof: number;
  currency: string;
}

export class MenoUsageError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "MenoUsageError";
    this.code = code;
  }
}

export interface MenoClientOptions {
  apiKey: string;
  /** Base de l'API sans « / » final. */
  baseUrl: string;
  /** fetch injecté (tests) ; défaut : le fetch global. */
  fetchImpl?: typeof fetch;
  /** Délai réseau de CHAQUE requête (défaut 10 s). */
  attemptTimeoutMs?: number;
  /** Reprises après erreur réseau (même clé), défaut 3. */
  maxNetworkRetries?: number;
  /** Attentes (croissantes) avant chaque reprise réseau. */
  networkRetryWaitsMs?: readonly number[];
  /** Reprises après 429, défaut 3. */
  maxRateLimitRetries?: number;
  /** Attente maximale acceptée après 429 ; au-delà, abandon (failed). */
  maxRetryAfterMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface MenoSendRequest {
  to: string;
  content: string;
  idempotencyKey: string;
  /** Délai global (toutes tentatives et attentes) ; aucune nouvelle requête ne démarre après. Défaut : aucun délai global. */
  deadlineMs?: number;
}

export const MENO_ATTEMPT_TIMEOUT_MS = 10_000;
export const MENO_MAX_NETWORK_RETRIES = 3;
export const MENO_NETWORK_RETRY_WAITS_MS: readonly number[] = Object.freeze([500, 1_000, 2_000]);
export const MENO_MAX_RATE_LIMIT_RETRIES = 3;
export const MENO_MAX_RETRY_AFTER_MS = 10_000;
const MENO_DEFAULT_RETRY_AFTER_MS = 2_000;
const MENO_BODY_MAX_BYTES = 65_536;
const PROVIDER_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/** Codes d'erreur réseau qui prouvent que la requête n'a pas atteint le fournisseur (aucune donnée envoyée). */
const NOT_SENT_CODES: ReadonlySet<string> = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
  "ERR_INVALID_URL",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "CERT_HAS_EXPIRED",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
]);

function collectErrorCodes(error: unknown, depth = 0, into: string[] = []): string[] {
  if (depth > 4 || typeof error !== "object" || error === null) return into;
  const record = error as { code?: unknown; cause?: unknown; errors?: unknown; message?: unknown };
  if (typeof record.code === "string") into.push(record.code);
  // fetch refuse une adresse dont le port est interdit avant toute connexion (« bad port ») : rien n'est parti.
  else if (record.message === "bad port") into.push("ERR_INVALID_URL");
  collectErrorCodes(record.cause, depth + 1, into);
  if (Array.isArray(record.errors)) for (const inner of record.errors) collectErrorCodes(inner, depth + 1, into);
  return into;
}

/** Vrai seulement si TOUS les codes d'erreur connus prouvent que rien n'est parti. Un délai dépassé ou une coupure : jamais prouvé. */
export function provesNotSent(error: unknown): boolean {
  const codes = collectErrorCodes(error);
  return codes.length > 0 && codes.every((code) => NOT_SENT_CODES.has(code));
}

type RawResponse = { status: number; retryAfterHeader: string | null; text: string; truncated: boolean };

async function readCapped(response: Response): Promise<{ text: string; truncated: boolean }> {
  if (!response.body) return { text: "", truncated: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MENO_BODY_MAX_BYTES) {
      await reader.cancel().catch(() => {});
      return { text: "", truncated: true };
    }
    chunks.push(value);
  }
  return { text: Buffer.concat(chunks).toString("utf8"), truncated: false };
}

function parseObject(text: string): Record<string, unknown> | null {
  if (text === "") return null;
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function providerIdOf(body: Record<string, unknown> | null): string | null {
  const id = body?.id;
  return typeof id === "string" && PROVIDER_ID.test(id) ? id : null;
}

function retryAfterMs(header: string | null, body: Record<string, unknown> | null, now: number): number {
  const fromBody = body?.retry_after ?? body?.retryAfter;
  if (typeof fromBody === "number" && Number.isFinite(fromBody) && fromBody >= 0 && fromBody <= 3_600) return Math.ceil(fromBody * 1_000);
  if (header !== null) {
    const text = header.trim();
    if (/^[0-9]{1,5}$/.test(text)) return Number(text) * 1_000;
    const date = Date.parse(text);
    if (Number.isFinite(date)) return Math.max(date - now, 0);
  }
  return MENO_DEFAULT_RETRY_AFTER_MS;
}

export interface MenoClient {
  send(request: MenoSendRequest): Promise<MenoSendOutcome>;
  usage(): Promise<MenoUsage>;
}

function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && Number.isSafeInteger(value) ? value : null;
}

/** Relecture en liste blanche de GET /usage (aucun autre champ n'est conservé). */
export function parseUsage(body: Record<string, unknown> | null): MenoUsage | null {
  if (!body) return null;
  const nested = [body.usage, body.data].find((value) => typeof value === "object" && value !== null && !Array.isArray(value)) as Record<string, unknown> | undefined;
  const source = typeof body.accepted === "number" || !nested ? body : nested;
  const accepted = number(source.accepted);
  const uncertain = number(source.uncertain);
  const rejected = number(source.rejected);
  const amount = number(source.accepted_amount_xof);
  const unit = number(source.unit_price_xof);
  const currency = source.currency;
  if (accepted === null || uncertain === null || rejected === null || amount === null || unit === null) return null;
  if (typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency)) return null;
  return { accepted, uncertain, rejected, acceptedAmountXof: amount, unitPriceXof: unit, currency };
}

export function createMenoClient(options: MenoClientOptions): MenoClient {
  const attemptTimeoutMs = options.attemptTimeoutMs ?? MENO_ATTEMPT_TIMEOUT_MS;
  const maxNetworkRetries = options.maxNetworkRetries ?? MENO_MAX_NETWORK_RETRIES;
  const waits = options.networkRetryWaitsMs ?? MENO_NETWORK_RETRY_WAITS_MS;
  const maxRateLimitRetries = options.maxRateLimitRetries ?? MENO_MAX_RATE_LIMIT_RETRIES;
  const maxRetryAfterMs = options.maxRetryAfterMs ?? MENO_MAX_RETRY_AFTER_MS;
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  if (!Number.isSafeInteger(attemptTimeoutMs) || attemptTimeoutMs < 1) throw new RangeError("attemptTimeoutMs invalide");

  /** UNE requête HTTP bornée dans le temps (en-têtes ET corps). Toute erreur (réseau, délai, lecture du corps) est levée telle quelle. */
  async function request(method: "GET" | "POST", path: string, headers: Record<string, string>, body: string | undefined, timeoutMs: number): Promise<RawResponse> {
    const fetchImpl = options.fetchImpl ?? globalThis.fetch;
    const response = await fetchImpl(`${options.baseUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${options.apiKey}`, Accept: "application/json", ...headers },
      body,
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const read = await readCapped(response);
    return { status: response.status, retryAfterHeader: response.headers.get("retry-after"), text: read.text, truncated: read.truncated };
  }

  async function send(input: MenoSendRequest): Promise<MenoSendOutcome> {
    assertSendable(input);
    const payload = JSON.stringify({ to: input.to, content: input.content });
    const headers = { "Idempotency-Key": input.idempotencyKey, "Content-Type": "application/json" };
    const startedAt = now();
    const deadline = input.deadlineMs === undefined ? Number.POSITIVE_INFINITY : startedAt + input.deadlineMs;

    let attempts = 0;
    let networkRetries = 0;
    let rateLimitRetries = 0;
    let possiblySent = false;

    const outcome = (status: SmsFinalStatus, httpStatus: number | null, errorCode: string | null, providerId: string | null = null, replay = false): MenoSendOutcome => ({
      status,
      httpStatus,
      errorCode,
      providerId,
      attempts,
      replay,
    });
    /** Issue finale SANS réponse 2xx : si une tentative précédente a pu partir (`possiblySent`), le sort du message est inconnu → uncertain, quel que soit le statut proposé. */
    const failure = (status: "failed" | "rejected" | "uncertain", httpStatus: number | null, errorCode: string, providerId: string | null = null): MenoSendOutcome =>
      outcome(possiblySent ? "uncertain" : status, httpStatus, errorCode, providerId);

    for (;;) {
      attempts += 1;
      const remaining = deadline - now();
      const timeoutMs = Math.max(1, Math.min(attemptTimeoutMs, Number.isFinite(remaining) ? Math.floor(remaining) : attemptTimeoutMs));
      let raw: RawResponse;
      try {
        raw = await request("POST", "/send", headers, payload, timeoutMs);
      } catch (error) {
        // Erreur réseau AVANT toute réponse complète : reprise avec la MÊME clé (le rejeu ne renvoie jamais un second SMS).
        if (!provesNotSent(error)) possiblySent = true;
        const wait = waits[Math.min(networkRetries, waits.length - 1)] ?? 0;
        if (networkRetries >= maxNetworkRetries || now() + wait >= deadline) {
          return possiblySent ? failure("uncertain", null, "network_uncertain") : failure("failed", null, "network_unreachable");
        }
        networkRetries += 1;
        await sleep(wait);
        continue;
      }

      const body = parseObject(raw.text);
      const providerId = providerIdOf(body);
      const { status } = raw;

      if (status >= 200 && status < 300) {
        const replay = body?.replay === true;
        const reported = typeof body?.status === "string" ? body.status : null;
        if (reported === "accepted") return outcome("accepted", status, null, providerId, replay);
        if (reported === "unknown" || reported === "reserved") return outcome("uncertain", status, `provider_${reported}`, providerId, replay);
        // Corps illisible, trop gros ou statut inconnu : jamais « accepted » par défaut, jamais rejoué avec une autre clé.
        return outcome("uncertain", status, raw.truncated || body === null ? "invalid_response" : "unexpected_status", providerId, replay);
      }

      if (status === 429) {
        const wait = retryAfterMs(raw.retryAfterHeader, body, now());
        if (rateLimitRetries >= maxRateLimitRetries || wait > maxRetryAfterMs || now() + wait >= deadline) return failure("failed", status, "rate_limited");
        rateLimitRetries += 1;
        await sleep(wait);
        continue;
      }

      if (status === 503) return failure("uncertain", status, "provider_unavailable", providerId);
      if (status === 401) return failure("rejected", status, "unauthorized");
      if (status === 409) return failure("rejected", status, "idempotency_conflict");
      if (status === 422) return failure("rejected", status, "invalid_request");
      if (status === 502) return failure("rejected", status, "provider_refused");
      // Autres erreurs serveur (500, 504…) : le résultat est inconnu. Autres refus (3xx, 4xx) : définitifs (sauf si une tentative précédente a pu partir : `failure`).
      if (status >= 500) return failure("uncertain", status, `http_${status}`, providerId);
      return failure("rejected", status, `http_${status}`);
    }
  }

  async function usage(): Promise<MenoUsage> {
    let raw: RawResponse;
    try {
      raw = await request("GET", "/usage", {}, undefined, attemptTimeoutMs);
    } catch {
      throw new MenoUsageError("usage_unreachable");
    }
    if (raw.status === 401) throw new MenoUsageError("usage_unauthorized");
    if (raw.status < 200 || raw.status >= 300) throw new MenoUsageError("usage_http_error");
    const parsed = parseUsage(parseObject(raw.text));
    if (!parsed) throw new MenoUsageError("usage_invalid_response");
    return parsed;
  }

  return { send, usage };
}
