/**
 * Budgets quotidiens des SMS (lot SMS1-bis). Module PUR (aucun accès réseau, base ou environnement) : il est lu par la configuration, le journal et les tests.
 *
 * NOMA_SMS_DAILY_CAP reste le plafond TOTAL du jour UTC. Il est découpé en deux budgets SÉPARÉS : un épuisement des codes de connexion ne touche jamais les notifications, et inversement.
 *   notifications = part configurable du total (défaut 40 %) ;
 *   codes         = le reste ; dans le budget codes, une RÉSERVE (défaut 50 % du budget codes) n'est accessible qu'aux numéros qui ont DÉJÀ un compte.
 * Une demande de code vers un numéro INCONNU ne peut donc consommer que la part non réservée (`newNumbers`), et au plus `newNumbersPerHour` par heure glissante : une rafale ne brûle
 * pas la journée en une heure. Un attaquant qui n'a que des numéros neufs ne peut plus bloquer la connexion des utilisateurs existants.
 * Lot SMS1-ter : la réserve n'est ouverte qu'au PREMIER code du jour UTC de chaque numéro existant (le journal classe `new` les codes suivants du même numéro, voir journal.ts) : pour vider
 * la réserve, il faut autant de numéros existants DIFFÉRENTS que la réserve a d'envois (300 avec les valeurs par défaut), et non quelques dizaines de numéros demandés en boucle.
 */

export const SMS_DEFAULT_NOTIFICATION_SHARE_PERCENT = 40;
export const SMS_MIN_NOTIFICATION_SHARE_PERCENT = 1;
export const SMS_MAX_NOTIFICATION_SHARE_PERCENT = 90;
export const SMS_DEFAULT_EXISTING_RESERVE_PERCENT = 50;
export const SMS_MIN_EXISTING_RESERVE_PERCENT = 0;
export const SMS_MAX_EXISTING_RESERVE_PERCENT = 90;
/** Lissage horaire : (part des numéros inconnus / 24) × 3 par heure glissante. */
export const SMS_NEW_NUMBERS_HOURLY_FACTOR = 3;

export interface SmsBudgetPlan {
  /** Plafond total du jour UTC (NOMA_SMS_DAILY_CAP) : tous usages, y compris l'essai du fondateur. */
  total: number;
  /** Budget des notifications. */
  notifications: number;
  /** Budget des codes de connexion (total − notifications). */
  codes: number;
  /** Part du budget codes réservée aux numéros qui ont déjà un compte. */
  existingReserve: number;
  /** Part du budget codes accessible aux numéros inconnus (codes − réserve). */
  newNumbers: number;
  /** Au plus ce nombre de demandes vers des numéros inconnus par heure glissante. */
  newNumbersPerHour: number;
}

export function isValidNotificationSharePercent(value: number): boolean {
  return Number.isSafeInteger(value) && value >= SMS_MIN_NOTIFICATION_SHARE_PERCENT && value <= SMS_MAX_NOTIFICATION_SHARE_PERCENT;
}

export function isValidExistingReservePercent(value: number): boolean {
  return Number.isSafeInteger(value) && value >= SMS_MIN_EXISTING_RESERVE_PERCENT && value <= SMS_MAX_EXISTING_RESERVE_PERCENT;
}

/** Découpe le plafond total en budgets. Arrondis vers le bas, mais une part non nulle garde au moins 1 envoi quand le plafond le permet. */
export function planBudgets(
  total: number,
  notificationSharePercent: number = SMS_DEFAULT_NOTIFICATION_SHARE_PERCENT,
  existingReservePercent: number = SMS_DEFAULT_EXISTING_RESERVE_PERCENT,
): SmsBudgetPlan {
  if (!Number.isSafeInteger(total) || total < 1) throw new RangeError("plafond total invalide");
  if (!isValidNotificationSharePercent(notificationSharePercent)) throw new RangeError("part des notifications invalide");
  if (!isValidExistingReservePercent(existingReservePercent)) throw new RangeError("réserve des numéros existants invalide");
  let notifications = Math.floor((total * notificationSharePercent) / 100);
  if (notifications === 0 && total >= 2) notifications = 1;
  const codes = total - notifications;
  let existingReserve = Math.floor((codes * existingReservePercent) / 100);
  if (existingReserve === 0 && existingReservePercent > 0 && codes >= 2) existingReserve = 1;
  const newNumbers = codes - existingReserve;
  const newNumbersPerHour = newNumbers === 0 ? 0 : Math.max(1, Math.ceil((newNumbers * SMS_NEW_NUMBERS_HOURLY_FACTOR) / 24));
  return { total, notifications, codes, existingReserve, newNumbers, newNumbersPerHour };
}

/** Motif d'un refus pour budget : stable (jamais une valeur de configuration). */
export type SmsBudgetScope = "total" | "codes" | "new_numbers" | "new_numbers_hour" | "notifications";

/** Code d'erreur stable d'un refus pour budget (ligne de journal, résultat de l'expéditeur). */
export function budgetErrorCode(scope: SmsBudgetScope): string {
  return `budget_${scope}`;
}

export const SMS_BUDGET_ERROR_CODES: readonly string[] = Object.freeze(
  (["total", "codes", "new_numbers", "new_numbers_hour", "notifications"] as const).map(budgetErrorCode),
);

export function isBudgetErrorCode(code: string | null | undefined): boolean {
  return typeof code === "string" && SMS_BUDGET_ERROR_CODES.includes(code);
}

/** Compteurs lus dans le journal (envois pending, accepted, uncertain du jour UTC, et de l'heure glissante pour `newNumbersHour`). */
export interface SmsBudgetCounts {
  total: number;
  codes: number;
  newNumbers: number;
  newNumbersHour: number;
  notifications: number;
}

export type SmsBudgetAudience = "existing" | "new";

/**
 * Décision pure : le prochain envoi tient-il dans les budgets ? Renvoie le motif du refus, ou null.
 *  - essai du fondateur (`smoke`) : seulement le plafond total ;
 *  - notification : total, puis budget des notifications ;
 *  - code de connexion : total, puis budget codes (tous numéros), puis, SEULEMENT pour un numéro inconnu (ou dont l'existence n'a pas pu être établie), la part non réservée
 *    et le lissage horaire.
 */
export function budgetVerdict(
  plan: SmsBudgetPlan,
  counts: SmsBudgetCounts,
  purpose: "otp" | "notification" | "smoke",
  audience: SmsBudgetAudience | null,
): SmsBudgetScope | null {
  if (counts.total >= plan.total) return "total";
  if (purpose === "smoke") return null;
  if (purpose === "notification") return counts.notifications >= plan.notifications ? "notifications" : null;
  if (counts.codes >= plan.codes) return "codes";
  if (audience === "existing") return null;
  if (counts.newNumbers >= plan.newNumbers) return "new_numbers";
  if (counts.newNumbersHour >= plan.newNumbersPerHour) return "new_numbers_hour";
  return null;
}
