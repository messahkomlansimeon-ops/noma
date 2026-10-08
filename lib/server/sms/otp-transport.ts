import "server-only";

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
 *  - budget du jour ou de l'heure atteint (aucun SMS parti) → `OtpCapacityError` : réponse DISTINCTE de l'échec générique (lot SMS1-bis) ;
 *  - tout autre résultat (rejected, failed) → échec définitif (`requestOtp` répond par un message générique, sans détail).
 * Clé d'idempotence `otp-<identifiant du défi>` : STABLE (jamais renouvelée lors d'une reprise). Le texte contient le code : jamais journalisé.
 * Lot SMS1-bis : le numéro est classé « existant » (il a déjà un compte actif) ou « nouveau » AVANT l'envoi : seuls les numéros existants accèdent à la réserve du budget des codes.
 * Un échec de cette lecture classe le numéro « nouveau » (jamais de réserve ouverte par erreur). Le délai de garde de `requestOtp` dépassé ne prouve pas que rien n'est parti :
 * `timeoutIsUncertain`.
 */

/** Délai global de l'envoi (toutes tentatives), puis délai de garde de `requestOtp` : plus long que le premier pour que le transport rende lui-même son résultat. */
export const SMS_OTP_DEADLINE_MS = 12_000;
export const SMS_OTP_TRANSPORT_TIMEOUT_MS = 20_000;

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

export function createMenoOtpTransport(sender: SmsSender, options: { deadlineMs?: number; pool?: () => Pool } = {}): SendOtp {
  const deadlineMs = options.deadlineMs ?? SMS_OTP_DEADLINE_MS;
  const send = async (input: Parameters<SendOtp>[0]): Promise<void> => {
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
    if (result.status === "accepted") return;
    if (result.status === "uncertain") throw new OtpDeliveryUncertainError();
    if (isBudgetErrorCode(result.errorCode)) throw new OtpCapacityError();
    throw new SmsDeliveryError(result.errorCode ?? "unknown");
  };
  return Object.assign(send, { timeoutMs: SMS_OTP_TRANSPORT_TIMEOUT_MS, timeoutIsUncertain: true });
}
