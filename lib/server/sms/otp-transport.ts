import "server-only";

import { randomInt } from "node:crypto";
import type { Pool } from "pg";
import { OtpCapacityError, OtpDeliveryUncertainError } from "../auth/errors";
import type { SendOtp } from "../auth/types";
import { isBudgetErrorCode, type SmsBudgetAudience } from "./budget";
import { otpMessage } from "./messages";
import type { SmsSender } from "./sender";

/**
 * Transport OTP « meno » (lot SMS1) : envoie le code par SMS réel, par l'expéditeur journalisé. Il ne fait que traduire le résultat :
 *  - accepted  → succès (accepté par l'opérateur : pas une preuve de livraison) ;
 *  - uncertain → `OtpDeliveryUncertainError` : le défi reste valable (le code reçu doit marcher), aucun renvoi automatique ;
 *  - budget du jour ou de l'heure atteint (aucun SMS parti) → `OtpCapacityError` (lot SMS1-bis). Lot SMS1-ter : `requestOtp` répond alors EXACTEMENT comme pour un succès (aucun oracle
 *    d'énumération) ; pour que le TEMPS de réponse ne trahisse pas non plus le refus (un vrai envoi dure l'aller-retour vers le fournisseur, un refus local presque rien), le transport
 *    ATTEND avant de lever l'erreur une durée tirée parmi celles des derniers envois réels de ce processus (`LatencyMirror`) ;
 *  - tout autre résultat (rejected, failed) → échec définitif (`requestOtp` répond par un message générique, sans détail).
 * Clé d'idempotence `otp-<identifiant du défi>` : STABLE (jamais renouvelée lors d'une reprise). Le texte contient le code : jamais journalisé.
 * Lot SMS1-bis : le numéro est classé « existant » (il a déjà un compte actif) ou « nouveau » AVANT l'envoi : seuls les numéros existants accèdent à la réserve du budget des codes.
 * Un échec de cette lecture classe le numéro « nouveau » (jamais de réserve ouverte par erreur). Le délai de garde de `requestOtp` dépassé ne prouve pas que rien n'est parti :
 * `timeoutIsUncertain`.
 */

/** Délai global de l'envoi (toutes tentatives), puis délai de garde de `requestOtp` : plus long que le premier pour que le transport rende lui-même son résultat. */
export const SMS_OTP_DEADLINE_MS = 12_000;
export const SMS_OTP_TRANSPORT_TIMEOUT_MS = 20_000;

/** Durée d'attente d'un refus pour capacité quand aucun envoi réel n'a encore été mesuré (ms, bornes incluses) : l'ordre de grandeur d'un aller-retour vers le fournisseur. */
export const SMS_CAPACITY_DEFAULT_DELAY_MIN_MS = 300;
export const SMS_CAPACITY_DEFAULT_DELAY_MAX_MS = 1_200;
/** Une attente de refus ne dépasse jamais cette durée (le délai de garde de `requestOtp` est de 20 s). */
export const SMS_CAPACITY_DELAY_CAP_MS = 8_000;
const LATENCY_SAMPLES = 64;

/**
 * Miroir de latence (lot SMS1-ter) : retient la durée des derniers envois qui ont VRAIMENT atteint le fournisseur (appel réseau fait) et en restitue une, tirée au hasard, pour
 * l'attente d'un refus pour capacité. Mémoire du processus seulement ; aucune donnée personnelle.
 */
export interface LatencyMirror {
  observe(milliseconds: number): void;
  /** Attente à imposer à un refus : une durée observée au hasard, sinon une valeur par défaut tirée entre 300 et 1200 ms ; toujours dans [0, 8000]. */
  sample(): number;
}

export function createLatencyMirror(random: (maximumExclusive: number) => number = (maximum) => randomInt(maximum)): LatencyMirror {
  const durations: number[] = [];
  let cursor = 0;
  return {
    observe(milliseconds) {
      if (!Number.isFinite(milliseconds) || milliseconds < 0) return;
      const value = Math.min(Math.round(milliseconds), SMS_CAPACITY_DELAY_CAP_MS);
      if (durations.length < LATENCY_SAMPLES) durations.push(value);
      else durations[cursor] = value;
      cursor = (cursor + 1) % LATENCY_SAMPLES;
    },
    sample() {
      if (durations.length === 0) return SMS_CAPACITY_DEFAULT_DELAY_MIN_MS + random(SMS_CAPACITY_DEFAULT_DELAY_MAX_MS - SMS_CAPACITY_DEFAULT_DELAY_MIN_MS + 1);
      return durations[random(durations.length)];
    },
  };
}

/** Miroir du processus : partagé par tous les transports OTP créés à chaque demande (le résolveur en crée un nouveau à chaque appel). */
const processLatencyMirror: LatencyMirror = createLatencyMirror();

export class SmsDeliveryError extends Error {
  readonly code: string;

  constructor(code: string) {
    super("L'envoi du SMS a échoué.");
    this.name = "SmsDeliveryError";
    this.code = /^[a-z0-9_]{1,60}$/.test(code) ? code : "unknown";
  }
}

/** Le numéro a-t-il déjà un compte actif ? Toute erreur de lecture : « new » (la réserve des numéros existants n'est jamais ouverte par erreur). */
export async function classifyOtpRecipient(poolOf: () => Pool, phone: string): Promise<SmsBudgetAudience> {
  try {
    const found = await poolOf().query(
      `SELECT 1 FROM phone_identities AS identity JOIN users AS account ON account.id = identity.user_id
        WHERE identity.phone_e164 = $1 AND identity.verified_at IS NOT NULL AND account.status = 'active' AND account.archived_at IS NULL
        LIMIT 1`,
      [phone],
    );
    return found.rowCount ? "existing" : "new";
  } catch {
    return "new";
  }
}

export interface MenoOtpTransportOptions {
  deadlineMs?: number;
  pool?: () => Pool;
  /** Miroir de latence (défaut : celui du processus). */
  latency?: LatencyMirror;
  /** Attente d'un refus pour capacité (défaut : `setTimeout`). Réservé aux essais. */
  sleep?: (milliseconds: number) => Promise<void>;
  /** Horloge monotone en millisecondes (défaut : `performance.now`). Réservé aux essais. */
  clock?: () => number;
}

const defaultSleep = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));

export function createMenoOtpTransport(sender: SmsSender, options: MenoOtpTransportOptions = {}): SendOtp {
  const deadlineMs = options.deadlineMs ?? SMS_OTP_DEADLINE_MS;
  const latency = options.latency ?? processLatencyMirror;
  const sleep = options.sleep ?? defaultSleep;
  const clock = options.clock ?? (() => performance.now());
  const send = async (input: Parameters<SendOtp>[0]): Promise<void> => {
    const startedAt = clock();
    const audience: SmsBudgetAudience = options.pool ? await classifyOtpRecipient(options.pool, input.phone) : "new";
    const result = await sender.send({
      purpose: "otp",
      reference: input.challengeId,
      idempotencyKey: `otp-${input.challengeId}`,
      to: input.phone,
      content: otpMessage(input.code),
      deadlineMs,
      audience,
    });
    // Un envoi qui a vraiment atteint le fournisseur : sa durée alimente le miroir (ni un refus local, ni un résultat rejoué sans appel).
    if (!result.skipped && result.attempts > 0) latency.observe(clock() - startedAt);
    if (result.status === "accepted") return;
    if (result.status === "uncertain") throw new OtpDeliveryUncertainError();
    if (isBudgetErrorCode(result.errorCode)) {
      // On attend ce qui manque pour atteindre une durée d'envoi réelle (le classement du numéro et la réservation ont déjà pris leur temps).
      await sleep(Math.min(Math.max(0, latency.sample() - (clock() - startedAt)), SMS_CAPACITY_DELAY_CAP_MS));
      throw new OtpCapacityError(result.errorCode ?? undefined);
    }
    throw new SmsDeliveryError(result.errorCode ?? "unknown");
  };
  return Object.assign(send, { timeoutMs: SMS_OTP_TRANSPORT_TIMEOUT_MS, timeoutIsUncertain: true });
}
