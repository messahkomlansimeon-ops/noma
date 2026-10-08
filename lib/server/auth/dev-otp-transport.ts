import "server-only";

import { createOtpTransportResolver } from "../sms/transports";
import type { SendOtp, SendOtpInput } from "./types";

type Environment = Record<string, string | undefined>;

/** Variable d'environnement qui demande le transport OTP de développement (valeur exacte « 1 »). */
export const DEV_OTP_FLAG = "NOMA_DEV_OTP_CONSOLE";

/** Avertissement fixe (une seule fois par résolveur) quand le drapeau est présent hors développement. */
export const DEV_OTP_REFUSED_WARNING =
  "[auth:dev] NOMA_DEV_OTP_CONSOLE=1 ignoré : le transport OTP de développement exige NODE_ENV=development ; aucun transport OTP n'est installé.";

/**
 * Téléphone masqué pour le journal : seuls les deux derniers chiffres restent lisibles.
 * Aucun autre caractère du numéro d'origine n'est repris.
 */
export function maskPhoneForLog(phone: string): string {
  const digits = String(phone).replace(/[^0-9]/g, "");
  const visible = digits.length > 2 ? 2 : 0;
  return `+${"*".repeat(digits.length - visible)}${digits.slice(digits.length - visible)}`;
}

/** Le transport de développement n'existe que dans la combinaison exacte NODE_ENV=development + drapeau « 1 ». */
export function isDevOtpConsoleEnabled(env: Environment): boolean {
  return env.NODE_ENV === "development" && env[DEV_OTP_FLAG] === "1";
}

/**
 * Transport qui écrit le code sur la sortie du serveur, rien d'autre :
 * téléphone masqué, code, échéance. Ni identifiant de challenge, ni IP, ni numéro complet.
 */
export function createDevOtpTransport(write: (line: string) => void): SendOtp {
  return async (input: SendOtpInput): Promise<void> => {
    const expires = input.expiresAt.toISOString().slice(11, 19);
    write(`[auth:dev] code OTP pour ${maskPhoneForLog(input.phone)} : ${input.code} (expire à ${expires} UTC)`);
  };
}

export interface DevOtpResolverOptions {
  /** Sortie de la ligne de code (défaut : console.log). */
  write?: (line: string) => void;
  /** Sortie de l'avertissement (défaut : console.warn). */
  warn?: (line: string) => void;
}

/**
 * Résolveur appelé à chaque demande d'OTP (l'environnement est relu à l'usage) :
 * - drapeau « 1 » avec NODE_ENV=development : le transport de développement ;
 * - drapeau « 1 » avec toute autre valeur de NODE_ENV (production comprise) : aucun transport, et un
 *   avertissement fixe journalisé UNE seule fois par résolveur ;
 * - sinon : aucun transport, aucun message.
 */
export function createDevOtpResolver(
  options: DevOtpResolverOptions = {},
): (env: Environment) => SendOtp | undefined {
  const write = options.write ?? ((line: string) => console.log(line));
  const warn = options.warn ?? ((line: string) => console.warn(line));
  let warned = false;
  let transport: SendOtp | undefined;

  return (env) => {
    if (env[DEV_OTP_FLAG] !== "1") return undefined;
    if (!isDevOtpConsoleEnabled(env)) {
      if (!warned) {
        warned = true;
        warn(DEV_OTP_REFUSED_WARNING);
      }
      return undefined;
    }
    transport ??= createDevOtpTransport(write);
    return transport;
  };
}

/**
 * Résolveur du runtime : branché uniquement dans les dépendances par défaut des gestionnaires HTTP d'authentification. Lot SMS1 : le nom est conservé, mais le résolveur choisit d'abord le
 * transport SMS réel « meno » (NOMA_SMS_PROVIDER=meno et clé valide, voir lib/server/sms/transports.ts) ; sans cela il délègue au résolveur de développement ci-dessus, inchangé.
 */
export const resolveDevOtpTransport = createOtpTransportResolver(createDevOtpResolver());
