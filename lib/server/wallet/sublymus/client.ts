import "server-only";

import { parseStrictJson, StrictJsonError } from "../strict-json";
import { SUBLYMUS_REQUEST_TIMEOUT_MS, SUBLYMUS_RESPONSE_MAX_BYTES, SUBLYMUS_SOURCE_SYSTEM, isLoopbackUrl, isWaveLinkHost, normalizeHostname } from "./config";

/**
 * Client HTTP de l'API Sublymus (lot PAY1), selon le contrat du fournisseur. TOUTES les routes /v1/* portent `Authorization: Bearer <clé>` et `X-Manager-Id`.
 *
 * Garanties : la clé n'apparaît JAMAIS dans une erreur, un message ou un journal (les erreurs ne portent qu'un genre et un statut) ; les redirections ne sont pas suivies (la clé
 * ne part jamais ailleurs) ; chaque appel a un délai maximal et une taille de réponse bornée ; une réponse qui ne ressemble pas au contrat (montant, devise, référence, lien) est
 * REFUSÉE (`invalid_response`) : un lien de paiement n'est enregistré que s'il correspond exactement à la demande.
 */

export type SublymusErrorKind = "auth" | "conflict" | "validation" | "not_found" | "rate_limited" | "server" | "timeout" | "network" | "invalid_response" | "real_host_forbidden";

export class SublymusApiError extends Error {
  readonly kind: SublymusErrorKind;
  /** Statut HTTP, ou null (délai, réseau, réponse illisible). */
  readonly status: number | null;
  /** Code stable pour le journal serveur (forme `[A-Za-z0-9_]{1,40}`). */
  readonly code: string;

  constructor(kind: SublymusErrorKind, status: number | null = null) {
    super(`Sublymus : ${kind}${status === null ? "" : ` (${status})`}`);
    this.name = "SublymusApiError";
    this.kind = kind;
    this.status = status;
    this.code = `sublymus_${kind}`;
  }
}

export interface SublymusClientConfig {
  apiKey: string;
  managerId: string;
  walletId: string;
  baseUrl: string;
}

export interface SublymusClientOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
  /**
   * Autorise une adresse AUTRE QUE LA BOUCLE LOCALE (le vrai service wallet.sublymus.com). Faux par défaut : seuls le serveur de PRODUCTION (`config.production`, rattrapage
   * compris) et les commandes du fondateur (hors essais) le demandent. Sans lui, SEULE une adresse de boucle locale (la fausse API) est admise : un essai ou un développement qui
   * pointerait par erreur ailleurs, sur le vrai service ou sur un nom qui lui ressemble, est REFUSÉ avant tout appel (une session de paiement ouvrirait une vraie session Wave).
   */
  allowRealHost?: boolean;
}

/** Vrai pour le vrai service Sublymus, casse et point final normalisés (et pour toute adresse illisible, par prudence). */
export function isRealSublymusHost(baseUrl: string): boolean {
  try {
    const host = normalizeHostname(new URL(baseUrl).hostname);
    return host === "sublymus.com" || host.endsWith(".sublymus.com");
  } catch {
    return true;
  }
}

/**
 * Règle du lien de paiement : hors fausse API locale (adresse de l'API en boucle locale), le lien doit être un sous-domaine d'un domaine Wave de la liste du code
 * (SUBLYMUS_LINK_DOMAINS, par exemple pay.wave.com) ; un lien vers un autre domaine est refusé et jamais enregistré ni servi.
 */
export interface LinkPolicy {
  /** Vrai pour la fausse API locale des essais : tout lien https est admis. */
  anyHost: boolean;
}
export const STRICT_LINK_POLICY: LinkPolicy = Object.freeze({ anyHost: false });

export interface SublymusCheckoutInput {
  amountXof: bigint;
  externalReference: string;
  description: string;
  successUrl: string;
  errorUrl: string;
  label: string;
}

export interface SublymusCheckout {
  paymentIntentId: string;
  status: string;
  checkoutUrl: string;
  amountXof: bigint;
  currency: string;
  externalReference: string;
}

/** Une intention lue chez Sublymus (liste de recherche) : champs lus avec tolérance (camelCase ou snake_case). */
export interface SublymusIntentSummary {
  id: string;
  externalReference: string;
  amountXof: bigint | null;
  currency: string | null;
  status: string;
  payerId: string | null;
  sourceSystem: string | null;
  checkoutUrl: string | null;
}

export interface SublymusWallet {
  id: string;
  name: string | null;
  balanceXof: bigint | null;
}

type Json = Record<string, unknown>;

const IDENTIFIER = /^[A-Za-z0-9._:-]{1,100}$/;
const STATUS = /^[A-Za-z_]{1,32}$/;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Montant entier de XOF : nombre entier sûr, ou chaîne de chiffres. */
export function readAmount(value: unknown): bigint | null {
  if (typeof value === "number") return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;
  // Chaîne de chiffres, avec ou sans partie fractionnaire NULLE (« 1200 », « 1200.0 », « 1200.00 ») ; toute autre fraction (« 1200.5 ») n'est pas un montant en XOF.
  const match = typeof value === "string" ? /^([0-9]{1,16})(?:\.0{1,6})?$/.exec(value) : null;
  if (match) {
    const parsed = BigInt(match[1]);
    return parsed <= BigInt(Number.MAX_SAFE_INTEGER) ? parsed : null;
  }
  return null;
}

function pick(record: Json, ...names: string[]): unknown {
  for (const name of names) if (Object.hasOwn(record, name)) return record[name];
  return undefined;
}

function text(value: unknown, pattern: RegExp): string | null {
  return typeof value === "string" && pattern.test(value) ? value : null;
}

/** Corps de la création d'une session : `splits` obligatoires, leur somme vaut EXACTEMENT le montant. */
export function buildCheckoutBody(config: Pick<SublymusClientConfig, "walletId">, input: SublymusCheckoutInput): Json {
  if (input.amountXof < BigInt(1) || input.amountXof > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError("amountXof hors limites");
  const amount = Number(input.amountXof);
  const splits = [{ wallet_id: config.walletId, amount, category: "PAYMENT", label: input.label, release_delay_hours: 0 }];
  if (splits.reduce((sum, split) => sum + split.amount, 0) !== amount) throw new RangeError("la somme des splits doit valoir exactement le montant");
  return {
    amount,
    currency: "XOF",
    external_reference: input.externalReference,
    source_system: SUBLYMUS_SOURCE_SYSTEM,
    description: input.description,
    success_url: input.successUrl,
    error_url: input.errorUrl,
    splits,
  };
}

function httpsUrl(value: unknown, policy: LinkPolicy = STRICT_LINK_POLICY): string | null {
  if (typeof value !== "string" || value.length > 2000 || /\s/.test(value)) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username !== "" || url.password !== "") return null;
    return policy.anyHost || isWaveLinkHost(url.hostname) ? value : null;
  } catch {
    return null;
  }
}

/** Réponse 201 de la création : doit reprendre EXACTEMENT le montant, la devise et la référence demandés. */
export function parseCheckoutResponse(body: unknown, input: Pick<SublymusCheckoutInput, "amountXof" | "externalReference">, policy: LinkPolicy = STRICT_LINK_POLICY): SublymusCheckout {
  const data = isObject(body) && isObject(body.data) ? body.data : null;
  if (!data) throw new SublymusApiError("invalid_response");
  const id = text(pick(data, "payment_intent_id", "paymentIntentId"), IDENTIFIER);
  const status = text(data.status, STATUS);
  const url = httpsUrl(pick(data, "wave_checkout_url", "waveCheckoutUrl"), policy);
  const amount = readAmount(data.amount);
  const currency = typeof data.currency === "string" ? data.currency : null;
  const reference = pick(data, "external_reference", "externalReference");
  if (id === null || status !== "WAVE_CREATED" || url === null || amount === null || currency !== "XOF" || reference !== input.externalReference || amount !== input.amountXof) {
    throw new SublymusApiError("invalid_response");
  }
  return { paymentIntentId: id, status, checkoutUrl: url, amountXof: amount, currency, externalReference: reference };
}

function intentList(body: unknown): unknown[] | null {
  if (!isObject(body)) return null;
  const data = body.data;
  if (Array.isArray(data)) return data;
  if (isObject(data)) {
    for (const name of ["items", "intents", "results", "data"]) {
      const value = data[name];
      if (Array.isArray(value)) return value;
    }
  }
  return null;
}

/** Liste de recherche : les entrées illisibles sont ignorées (jamais créditées), le reste est normalisé. */
export function parseIntentList(body: unknown, policy: LinkPolicy = STRICT_LINK_POLICY): SublymusIntentSummary[] {
  const list = intentList(body);
  if (list === null) throw new SublymusApiError("invalid_response");
  const out: SublymusIntentSummary[] = [];
  for (const entry of list) {
    if (!isObject(entry)) continue;
    const id = text(entry.id, IDENTIFIER);
    const reference = pick(entry, "externalReference", "external_reference");
    const status = text(entry.status, STATUS);
    if (id === null || typeof reference !== "string" || status === null) continue;
    const payer = pick(entry, "payerId", "payer_id");
    const source = pick(entry, "sourceSystem", "source_system");
    out.push({
      id,
      externalReference: reference,
      amountXof: readAmount(entry.amount),
      currency: typeof entry.currency === "string" ? entry.currency : null,
      status,
      payerId: typeof payer === "string" ? payer : null,
      sourceSystem: typeof source === "string" ? source : null,
      checkoutUrl: httpsUrl(pick(entry, "waveCheckoutUrl", "wave_checkout_url"), policy),
    });
  }
  return out;
}

export class SublymusClient {
  private readonly config: SublymusClientConfig;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly linkPolicy: LinkPolicy;

  constructor(config: SublymusClientConfig, options: SublymusClientOptions = {}) {
    // Sans autorisation explicite : boucle locale SEULEMENT (la fausse API). Le vrai service, un nom qui lui ressemble ou toute autre adresse sont refusés avant tout appel.
    if (options.allowRealHost !== true && !isLoopbackUrl(config.baseUrl)) throw new SublymusApiError("real_host_forbidden");
    this.linkPolicy = { anyHost: isLoopbackUrl(config.baseUrl) };
    this.config = config;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? SUBLYMUS_REQUEST_TIMEOUT_MS;
  }

  /** Un appel : en-têtes d'authentification, délai, pas de redirection, réponse bornée et JSON strict. */
  private async call(method: "GET" | "POST", path: string, body?: Json): Promise<{ status: number; json: unknown }> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.config.apiKey}`,
      "X-Manager-Id": this.config.managerId,
      Accept: "application/json",
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.config.baseUrl}${path}`, {
        method,
        headers,
        redirect: "error",
        signal: AbortSignal.timeout(this.timeoutMs),
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (error) {
      const name = typeof error === "object" && error !== null ? (error as { name?: unknown }).name : undefined;
      throw new SublymusApiError(name === "TimeoutError" || name === "AbortError" ? "timeout" : "network");
    }
    const raw = await readBounded(response);
    const status = response.status;
    if (status === 401 || status === 403) throw new SublymusApiError("auth", status);
    if (status === 404) throw new SublymusApiError("not_found", status);
    if (status === 409) throw new SublymusApiError("conflict", status);
    if (status === 429) throw new SublymusApiError("rate_limited", status);
    if (status === 400 || status === 422) throw new SublymusApiError("validation", status);
    if (status >= 500) throw new SublymusApiError("server", status);
    if (status < 200 || status >= 300) throw new SublymusApiError("validation", status);
    let json: unknown;
    try {
      json = raw === "" ? null : parseStrictJson(raw, { providerPayload: true });
    } catch (error) {
      if (error instanceof StrictJsonError) throw new SublymusApiError("invalid_response", status);
      throw error;
    }
    return { status, json };
  }

  /** POST /v1/checkout/complex : ouvre une VRAIE session Wave (jamais appelé par un essai sur la vraie adresse). */
  async createCheckout(input: SublymusCheckoutInput): Promise<SublymusCheckout> {
    const { json } = await this.call("POST", "/v1/checkout/complex", buildCheckoutBody(this.config, input));
    return parseCheckoutResponse(json, input, this.linkPolicy);
  }

  /** GET /v1/intents?external_reference=… : recherche PARTIELLE chez Sublymus ; l'appelant filtre la référence EXACTE. */
  async findIntents(externalReference: string): Promise<SublymusIntentSummary[]> {
    const { json } = await this.call("GET", `/v1/intents?external_reference=${encodeURIComponent(externalReference)}`);
    return parseIntentList(json, this.linkPolicy);
  }

  /** GET /v1/wallets/main (lecture seule), puis, si le solde n'y figure pas, GET /v1/wallets/{id}/balance. */
  async getMainWallet(): Promise<SublymusWallet> {
    const { json } = await this.call("GET", "/v1/wallets/main");
    const data = isObject(json) && isObject(json.data) ? json.data : null;
    const id = data ? text(data.id, IDENTIFIER) : null;
    if (data === null || id === null) throw new SublymusApiError("invalid_response");
    let balance = readBalance(data);
    if (balance === null) {
      try {
        const second = await this.call("GET", `/v1/wallets/${encodeURIComponent(id)}/balance`);
        const secondData = isObject(second.json) ? (isObject(second.json.data) ? second.json.data : second.json) : null;
        balance = secondData ? readBalance(secondData) : null;
      } catch (error) {
        if (!(error instanceof SublymusApiError) || error.kind === "auth") throw error;
      }
    }
    const name = typeof data.name === "string" && data.name.length <= 100 ? data.name : null;
    return { id, name, balanceXof: balance };
  }
}

function readBalance(record: Json): bigint | null {
  for (const name of ["balance", "available_balance", "availableBalance", "available"]) {
    const value = record[name];
    const direct = readAmount(value);
    if (direct !== null) return direct;
    if (isObject(value)) {
      const nested = readAmount(pick(value, "available", "amount", "xof", "XOF"));
      if (nested !== null) return nested;
    }
  }
  return null;
}

async function readBounded(response: Response): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared !== null && /^[0-9]+$/.test(declared) && Number(declared) > SUBLYMUS_RESPONSE_MAX_BYTES) {
    void response.body?.cancel().catch(() => {});
    throw new SublymusApiError("invalid_response", response.status);
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > SUBLYMUS_RESPONSE_MAX_BYTES) {
        await reader.cancel().catch(() => {});
        throw new SublymusApiError("invalid_response", response.status);
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof SublymusApiError) throw error;
    throw new SublymusApiError("network", response.status);
  }
  return new TextDecoder("utf-8").decode(Buffer.concat(chunks));
}
