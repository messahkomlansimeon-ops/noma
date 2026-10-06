import "server-only";

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Pool } from "pg";
import {
  FAKE_PROVIDER, FAKE_SECRET_MIN_BYTES, FAKE_SIGNATURE_TOLERANCE_SECONDS, WALLET_MAX_SAFE_AMOUNT,
} from "./config";
import { StrictJsonError, parseStrictJson } from "./strict-json";
import { applyProviderEvent, PAYMENT_EVENT_TYPES, type PaymentEventType, type ProviderEventResult } from "./topups";

/**
 * Prestataire de paiement FICTIF (lot P1a) : aucun appel réseau, aucun argent. Il n'existe que si NODE_ENV vaut EXACTEMENT
 * « development » ou « test » (liste d'AUTORISATION : ni espace, ni casse, ni « staging », ni valeur vide ou absente) ET
 * NOMA_FAKE_PAYMENTS vaut « 1 » ET NOMA_FAKE_PAYMENT_SECRET (32 octets au moins) est défini. Les événements
 * sont signés (HMAC-SHA256 du corps brut) : le chemin de traitement est le même pour le webhook et pour les routes de
 * développement, qui signent leur propre événement et le font passer par `processFakePaymentEvent`. Voir WALLET.md.
 */

type Environment = Record<string, string | undefined>;

export type FakePaymentConfig =
  | { enabled: true; secret: string }
  | { enabled: false; reason: "environment" | "flag_absent" | "secret_invalid" };

/** Seules valeurs de NODE_ENV (telles quelles, sans suppression d'espaces ni changement de casse) qui autorisent le prestataire fictif. */
export const FAKE_PAYMENT_ALLOWED_NODE_ENVS: readonly string[] = Object.freeze(["development", "test"]);

/** Activation. L'environnement est relu à chaque requête par les gestionnaires HTTP. */
export function resolveFakePaymentConfig(env: Environment): FakePaymentConfig {
  // Liste d'AUTORISATION : tout ce qui n'est pas exactement « development » ou « test » (« production », « Production »,
  // « PRODUCTION », « prod », « staging », valeur vide ou absente, espaces) désactive le prestataire fictif.
  if (typeof env.NODE_ENV !== "string" || !FAKE_PAYMENT_ALLOWED_NODE_ENVS.includes(env.NODE_ENV)) {
    return { enabled: false, reason: "environment" };
  }
  if (env.NOMA_FAKE_PAYMENTS !== "1") return { enabled: false, reason: "flag_absent" };
  const secret = env.NOMA_FAKE_PAYMENT_SECRET?.trim();
  if (!secret || Buffer.byteLength(secret, "utf8") < FAKE_SECRET_MIN_BYTES) return { enabled: false, reason: "secret_invalid" };
  return { enabled: true, secret };
}

// ───────────── signature ─────────────

/** HMAC-SHA256 du corps brut, en hexadécimal minuscule (64 caractères) : valeur de l'en-tête x-noma-fake-signature. */
export function signFakePaymentBody(secret: string, body: Uint8Array | string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

const SIGNATURE_HEX = /^[0-9a-f]{64}$/;

/** Comparaison à temps constant. Un en-tête absent ou mal formé est refusé sans comparaison. */
export function verifyFakePaymentSignature(secret: string, body: Uint8Array, signature: string | null): boolean {
  if (signature === null || !SIGNATURE_HEX.test(signature)) return false;
  const expected = createHmac("sha256", secret).update(body).digest();
  return timingSafeEqual(Buffer.from(signature, "hex"), expected);
}

// ───────────── événement ─────────────

export type FakeEventErrorReason = "invalid_encoding" | "invalid_json" | "invalid_shape" | "invalid_field" | "timestamp_out_of_window";

export class FakeEventError extends Error {
  readonly reason: FakeEventErrorReason;

  constructor(reason: FakeEventErrorReason) {
    super(`Événement refusé : ${reason}`);
    this.name = "FakeEventError";
    this.reason = reason;
  }
}

export interface FakePaymentEvent {
  eventId: string;
  type: PaymentEventType;
  /** Horodatage en secondes depuis l'époque Unix. */
  timestamp: number;
  providerReference: string;
  amountXof: bigint;
}

const IDENTIFIER = /^[A-Za-z0-9_-]{8,64}$/;
const EVENT_KEYS = ["id", "type", "timestamp", "providerReference", "amountXof"] as const;

/**
 * Lit un corps SIGNÉ (la signature est vérifiée avant). Forme exacte, sans clé en plus ni en moins :
 * `{ "id", "type", "timestamp", "providerReference", "amountXof" }`. Refuse : UTF-8 invalide, JSON piégé (clé en double,
 * `__proto__`, nombre non entier ou non sûr), types faux, horodatage à plus de FAKE_SIGNATURE_TOLERANCE_SECONDS de `now`.
 */
export function parseFakePaymentEvent(body: Uint8Array, now: Date): FakePaymentEvent {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(body);
  } catch {
    throw new FakeEventError("invalid_encoding");
  }
  let value: unknown;
  try {
    value = parseStrictJson(text);
  } catch (error) {
    if (error instanceof StrictJsonError) throw new FakeEventError("invalid_json");
    throw error;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new FakeEventError("invalid_shape");
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== EVENT_KEYS.length || !EVENT_KEYS.every((key) => keys.includes(key))) throw new FakeEventError("invalid_shape");

  const { id, type, timestamp, providerReference, amountXof } = record;
  if (typeof id !== "string" || !IDENTIFIER.test(id)) throw new FakeEventError("invalid_field");
  if (typeof type !== "string" || !(PAYMENT_EVENT_TYPES as readonly string[]).includes(type)) throw new FakeEventError("invalid_field");
  if (typeof providerReference !== "string" || !IDENTIFIER.test(providerReference)) throw new FakeEventError("invalid_field");
  if (typeof timestamp !== "number" || !Number.isSafeInteger(timestamp) || timestamp < 0) throw new FakeEventError("invalid_field");
  if (typeof amountXof !== "number" || !Number.isSafeInteger(amountXof) || amountXof < 1) throw new FakeEventError("invalid_field");
  if (BigInt(amountXof) > WALLET_MAX_SAFE_AMOUNT) throw new FakeEventError("invalid_field");
  if (Math.abs(now.getTime() - timestamp * 1000) > FAKE_SIGNATURE_TOLERANCE_SECONDS * 1000) {
    throw new FakeEventError("timestamp_out_of_window");
  }
  return { eventId: id, type: type as PaymentEventType, timestamp, providerReference, amountXof: BigInt(amountXof) };
}

/** Corps JSON d'un événement fictif (clés dans l'ordre canonique). L'identifiant d'événement est aléatoire sauf s'il est fourni. */
export function buildFakePaymentEventBody(input: {
  type: PaymentEventType;
  providerReference: string;
  amountXof: bigint;
  now: Date;
  eventId?: string;
}): string {
  if (input.amountXof < BigInt(1) || input.amountXof > WALLET_MAX_SAFE_AMOUNT) throw new RangeError("amountXof hors limites");
  return JSON.stringify({
    id: input.eventId ?? `evt_${randomBytes(16).toString("hex")}`,
    type: input.type,
    timestamp: Math.floor(input.now.getTime() / 1000),
    providerReference: input.providerReference,
    amountXof: Number(input.amountXof),
  });
}

// ───────────── traitement ─────────────

export type FakePaymentProcessResult =
  | { status: "invalid_signature" }
  | { status: "invalid_event"; reason: FakeEventErrorReason }
  | { status: "processed"; result: ProviderEventResult };

/**
 * CHEMIN UNIQUE de traitement d'un événement fictif (webhook ET routes de développement) : signature (aucune requête SQL si elle
 * est invalide), lecture stricte du corps, puis application en base. Un événement à signature invalide ou de forme invalide
 * n'écrit RIEN.
 */
export async function processFakePaymentEvent(input: {
  /** Le pool n'est résolu qu'APRÈS la vérification de signature et la lecture de l'événement : un refus précoce n'ouvre aucune connexion. */
  pool: Pool | (() => Pool);
  secret: string;
  body: Uint8Array;
  signature: string | null;
  now: Date;
}): Promise<FakePaymentProcessResult> {
  if (!verifyFakePaymentSignature(input.secret, input.body, input.signature)) return { status: "invalid_signature" };
  let event: FakePaymentEvent;
  try {
    event = parseFakePaymentEvent(input.body, input.now);
  } catch (error) {
    if (error instanceof FakeEventError) return { status: "invalid_event", reason: error.reason };
    throw error;
  }
  const result = await applyProviderEvent({
    pool: typeof input.pool === "function" ? input.pool() : input.pool,
    event: {
      provider: FAKE_PROVIDER,
      eventId: event.eventId,
      type: event.type,
      providerReference: event.providerReference,
      amountXof: event.amountXof,
      payloadSha256: createHash("sha256").update(input.body).digest("hex"),
    },
  });
  return { status: "processed", result };
}
