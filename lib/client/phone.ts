/** Téléphone saisi par l'utilisateur → format canonique E.164 attendu par le serveur (`+` puis 8 à 15 chiffres). */

export const COUNTRY_PREFIX = "+225";
const CANONICAL_PHONE = /^[+][1-9][0-9]{1,14}$/;

/**
 * Numéro ivoirien saisi sans l'indicatif : 10 chiffres (0700000042, avec le 0 initial conservé depuis la réforme
 * de 2021) ou 8 chiffres (ancien format). Espaces, points, tirets et parenthèses sont tolérés ; l'indicatif
 * (+225, 00225 ou 225 devant un numéro complet) est accepté ; un « + » doit être suivi de 225. Toute autre saisie donne `null` : jamais de
 * correction silencieuse.
 */
export function toCanonicalPhone(input: string): string | null {
  const text = input.trim();
  if (!/^\+?[0-9\s.()-]+$/.test(text)) return null;
  let digits = text.replace(/[^0-9]/g, "");
  if (text.startsWith("+")) {
    // Un « + » annonce un numéro international : seul l'indicatif 225 est accepté, un autre (+33, +49, +1…) ou
    // un « + » devant un numéro local n'est jamais réécrit en +225.
    if (!digits.startsWith("225")) return null;
    digits = digits.slice(3);
  } else if (digits.startsWith("00225") && (digits.length === 13 || digits.length === 15)) digits = digits.slice(5);
  else if (digits.startsWith("225") && (digits.length === 11 || digits.length === 13)) digits = digits.slice(3);
  if (digits.length !== 8 && digits.length !== 10) return null;
  const phone = `${COUNTRY_PREFIX}${digits}`;
  return CANONICAL_PHONE.test(phone) ? phone : null;
}

export function isCanonicalPhone(value: unknown): value is string {
  return typeof value === "string" && CANONICAL_PHONE.test(value);
}

/** Affichage masqué pour l'écran de vérification : « +225 07 •• •• •• 42 ». */
export function maskPhoneForDisplay(phone: string): string {
  const local = /^\+225([0-9]{10})$/.exec(phone);
  if (local) {
    const digits = local[1];
    return `${COUNTRY_PREFIX} ${digits.slice(0, 2)} •• •• •• ${digits.slice(-2)}`;
  }
  const digits = phone.replace(/[^0-9]/g, "");
  if (digits.length <= 2) return "•".repeat(digits.length);
  return `+${"•".repeat(digits.length - 2)}${digits.slice(-2)}`;
}
