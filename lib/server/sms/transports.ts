import "server-only";

import type { Pool } from "pg";
import { getPostgresPool } from "../postgres/client";
import type { SendOtp } from "../auth/types";
import type { NotificationTransport } from "../notifications/transport";
import { createMenoNotificationTransport } from "./notification-transport";
import { createMenoOtpTransport } from "./otp-transport";
import { isMenoActive, menoInactiveReason, readSmsConfig, type Environment } from "./config";
import { resolveMenoSender, type SmsSender } from "./sender";

/**
 * Choix des transports SMS au runtime (lot SMS1). Les résolveurs sont appelés à CHAQUE demande (l'environnement est relu à l'usage) et décident entre :
 *  - le transport RÉEL « meno » : seulement si NOMA_SMS_PROVIDER=meno ET une clé valide est définie (voir config.ts, `isMenoActive`) ;
 *  - le transport de développement (console) : inchangé, verrouillé comme avant (NODE_ENV=development + drapeau « 1 »).
 * Règles de sûreté :
 *  - NOMA_SMS_PROVIDER=meno mais clé absente/invalide : AUCUN transport (jamais de repli sur la console, jamais d'appel) et UN avertissement fixe ;
 *  - NOMA_SMS_PROVIDER=meno ET drapeau de développement « 1 » : AUCUN transport (configuration ambiguë), UN avertissement fixe ;
 *  - notifications : NOMA_PUBLIC_URL (origine de l'application) est exigée pour composer le lien ; sans elle, aucun transport de notification.
 */

export interface TransportResolverOptions {
  /** Expéditeur injecté (tests) ; défaut : celui de l'environnement. */
  resolveSender?: (env: Environment) => SmsSender | undefined;
  /** Pool PostgreSQL du classement des numéros (compte existant ou non) et de la lecture du numéro des notifications ; défaut : le pool du serveur. */
  pool?: () => Pool;
  warn?: (line: string) => void;
}

const AMBIGUOUS_WARNING = (flag: string) => `[sms] NOMA_SMS_PROVIDER=meno et ${flag}=1 sont incompatibles : aucun transport n'est installé (retirez l'un des deux).`;
const INACTIVE_WARNING = (reason: string) => `[sms] NOMA_SMS_PROVIDER=meno ignoré : ${reason} ; aucun transport n'est installé.`;
const PUBLIC_URL_WARNING = "[sms] NOMA_PUBLIC_URL est requise pour les notifications par SMS : aucun transport de notification n'est installé.";

function onceWarner(warn: (line: string) => void): (line: string) => void {
  const seen = new Set<string>();
  return (line) => {
    if (seen.has(line)) return;
    seen.add(line);
    warn(line);
  };
}

/** Résolveur du transport OTP : le transport réel « meno » si configuré, sinon celui de `resolveDev` (transport de développement). */
export function createOtpTransportResolver(
  resolveDev: (env: Environment) => SendOtp | undefined,
  options: TransportResolverOptions = {},
): (env: Environment) => SendOtp | undefined {
  const resolveSender = options.resolveSender ?? resolveMenoSender;
  const warn = onceWarner(options.warn ?? ((line) => console.warn(line)));
  return (env) => {
    const config = readSmsConfig(env);
    if (config.provider !== "meno") return resolveDev(env);
    if (env.NOMA_DEV_OTP_CONSOLE === "1") {
      warn(AMBIGUOUS_WARNING("NOMA_DEV_OTP_CONSOLE"));
      return undefined;
    }
    const sender = isMenoActive(config) ? resolveSender(env) : undefined;
    if (!sender) {
      warn(INACTIVE_WARNING(menoInactiveReason(config) ?? "configuration inactive"));
      return undefined;
    }
    return createMenoOtpTransport(sender, { pool: options.pool ?? (() => getPostgresPool()) });
  };
}

/** Résolveur du transport de notification : « meno » si configuré (avec NOMA_PUBLIC_URL), sinon celui de `resolveDev`. */
export function createNotificationResolverWithMeno(
  resolveDev: (env: Environment) => NotificationTransport | undefined,
  options: TransportResolverOptions = {},
): (env: Environment) => NotificationTransport | undefined {
  const resolveSender = options.resolveSender ?? resolveMenoSender;
  const warn = onceWarner(options.warn ?? ((line) => console.warn(line)));
  return (env) => {
    const config = readSmsConfig(env);
    if (config.provider !== "meno") return resolveDev(env);
    if (env.NOMA_DEV_NOTIFY_CONSOLE === "1") {
      warn(AMBIGUOUS_WARNING("NOMA_DEV_NOTIFY_CONSOLE"));
      return undefined;
    }
    const sender = isMenoActive(config) ? resolveSender(env) : undefined;
    if (!sender) {
      warn(INACTIVE_WARNING(menoInactiveReason(config) ?? "configuration inactive"));
      return undefined;
    }
    if (config.publicUrl === null) {
      warn(PUBLIC_URL_WARNING);
      return undefined;
    }
    return createMenoNotificationTransport({ sender, pool: options.pool ?? (() => getPostgresPool()), publicUrl: config.publicUrl });
  };
}
