import "server-only";

import type { Pool } from "pg";
import { MENO_CHANNEL } from "../notifications/config";
import { NotificationBudgetError, NotificationUncertainError } from "../notifications/errors";
import type { NotificationMessage, NotificationTransport } from "../notifications/transport";
import { notificationMessage } from "./messages";
import { isBudgetErrorCode } from "./budget";
import type { SmsSender } from "./sender";
import { SmsDeliveryError } from "./otp-transport";

/**
 * Transport de notification « meno » (lot SMS1) : UN SMS regroupé par lot figé (nombre d'annonces et lien vers /notifications, rien d'autre). Toutes les règles de N1-bis restent
 * dans l'étape « notify » (fenêtre de collecte, 4 h entre deux messages, 3 par jour, heures calmes, lot figé, revérification) : ce transport n'est appelé qu'APRÈS elles.
 * Clé d'idempotence `notif-<clé du lot figé>` : la même à chaque reprise du même lot. Le numéro est lu dans `phone_identities` (jamais dans le message reçu), et n'est ni
 * journalisé ni stocké en clair.
 */

export const SMS_NOTIFICATION_DEADLINE_MS = 12_000;
export const SMS_NOTIFICATION_TRANSPORT_TIMEOUT_MS = 20_000;
const BATCH_KEY = /^[0-9a-f]{32}$/;

export interface MenoNotificationTransportOptions {
  sender: SmsSender;
  pool: () => Pool;
  /** Origine publique de l'application (NOMA_PUBLIC_URL), sans « / » final. */
  publicUrl: string;
  deadlineMs?: number;
}

export function createMenoNotificationTransport(options: MenoNotificationTransportOptions): NotificationTransport {
  const deadlineMs = options.deadlineMs ?? SMS_NOTIFICATION_DEADLINE_MS;
  return {
    channel: MENO_CHANNEL,
    timeoutMs: SMS_NOTIFICATION_TRANSPORT_TIMEOUT_MS,
    async send(message: NotificationMessage): Promise<void> {
      if (!BATCH_KEY.test(message.idempotencyKey)) throw new SmsDeliveryError("invalid_key");
      if (!Number.isSafeInteger(message.count) || message.count < 1) throw new SmsDeliveryError("invalid_count");
      if (typeof message.link !== "string" || !message.link.startsWith("/")) throw new SmsDeliveryError("invalid_link");
      const identity = await options.pool().query<{ phone_e164: string }>(
        "SELECT phone_e164 FROM phone_identities WHERE user_id = $1::uuid AND verified_at IS NOT NULL",
        [message.userId],
      );
      if (!identity.rowCount) throw new SmsDeliveryError("no_phone");
      const result = await options.sender.send({
        purpose: "notification",
        reference: message.idempotencyKey,
        idempotencyKey: `notif-${message.idempotencyKey}`,
        to: identity.rows[0].phone_e164,
        content: notificationMessage(message.count, `${options.publicUrl}${message.link}`),
        deadlineMs,
      });
      if (result.status === "accepted") return;
      if (result.status === "uncertain") throw new NotificationUncertainError();
      // Budget du jour atteint (aucun SMS parti, aucune ligne) : le lot est REPORTÉ par l'étape « notify », pas compté comme une tentative échouée.
      if (isBudgetErrorCode(result.errorCode)) throw new NotificationBudgetError();
      throw new SmsDeliveryError(result.errorCode ?? "unknown");
    },
  };
}
