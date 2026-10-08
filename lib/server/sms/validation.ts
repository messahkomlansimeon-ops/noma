import { analyzeSms, isSingleSegmentSms } from "./gsm7";

/**
 * Contrôles LOCAUX d'un envoi SMS (lot SMS1), exécutés AVANT tout appel au fournisseur : un SMS accepté coûte 15 F CFA, un refus local ne coûte rien.
 * Module pur (aucun accès réseau, base ou environnement).
 */

/** Seul pays ouvert au lancement : la Côte d'Ivoire (+225, 10 chiffres). Tout autre pays est refusé CHEZ NOUS, sans appel. */
export const SMS_ALLOWED_RECIPIENT = /^\+225[0-9]{10}$/;

/** Clé d'idempotence du fournisseur : 8 à 64 caractères parmi A-Z a-z 0-9 . _ - */
export const IDEMPOTENCY_KEY_FORMAT = /^[A-Za-z0-9._-]{8,64}$/;

export type SmsLocalRefusal = "invalid_recipient" | "invalid_content" | "invalid_key";

export class SmsLocalValidationError extends Error {
  readonly code: SmsLocalRefusal;

  constructor(code: SmsLocalRefusal) {
    super(code);
    this.name = "SmsLocalValidationError";
    this.code = code;
  }
}

export function isAllowedRecipient(value: unknown): value is string {
  return typeof value === "string" && SMS_ALLOWED_RECIPIENT.test(value);
}

export function isValidIdempotencyKey(value: unknown): value is string {
  return typeof value === "string" && IDEMPOTENCY_KEY_FORMAT.test(value);
}

/** Premier refus local d'un envoi (destinataire, texte, clé), ou null si l'envoi peut partir. Ne répète jamais la valeur refusée. */
export function localRefusal(input: { to: unknown; content: unknown; idempotencyKey: unknown }): SmsLocalRefusal | null {
  if (!isAllowedRecipient(input.to)) return "invalid_recipient";
  if (!isSingleSegmentSms(input.content)) return "invalid_content";
  if (!isValidIdempotencyKey(input.idempotencyKey)) return "invalid_key";
  return null;
}

export function assertSendable(input: { to: unknown; content: unknown; idempotencyKey: unknown }): void {
  const refusal = localRefusal(input);
  if (refusal) throw new SmsLocalValidationError(refusal);
}

/** Deux derniers chiffres d'un numéro (seule partie jamais masquée dans les journaux et les écrans). */
export function lastTwoDigits(phone: string): string {
  const digits = String(phone).replace(/[^0-9]/g, "");
  return digits.slice(-2).padStart(2, "0");
}

/** Numéro masqué pour un journal : « +*********12 ». */
export function maskRecipient(phone: string): string {
  const digits = String(phone).replace(/[^0-9]/g, "");
  return `+${"*".repeat(Math.max(digits.length - 2, 0))}${lastTwoDigits(phone)}`;
}

export { analyzeSms };
