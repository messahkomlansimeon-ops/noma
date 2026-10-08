import type { MissionField } from "../../missions-rules";
import { missionPhoneMessage } from "../../missions-rules";

/**
 * Refus de domaine des missions d'achat en volume (lot MV1) : code stable et texte fixe, jamais une donnée de la base ni la valeur saisie.
 * Les refus qui touchent aussi la déclaration d'un achat (`mission_not_active`, `mission_quantity_exceeded`, `mission_price_over_budget`, `mission_budget_exceeded`,
 * `invalid_quantity`) sont traduits par les routes des commandes comme par celles des missions (`lib/server/missions/http-errors.ts`).
 */
export type MissionErrorCode =
  | "resource_not_found"
  | "invalid_mission"
  | "phone_number_in_mission"
  | "mission_not_draft"
  | "mission_state_conflict"
  | "mission_active_limit"
  | "mission_daily_limit"
  | "mission_not_active"
  | "mission_quantity_exceeded"
  | "mission_price_over_budget"
  | "mission_budget_exceeded"
  | "invalid_quantity";

export const MISSION_ERROR_MESSAGES: Readonly<Record<MissionErrorCode, string>> = Object.freeze({
  resource_not_found: "Ressource introuvable.",
  invalid_mission: "Cette mission n'est pas valide.",
  phone_number_in_mission: missionPhoneMessage(null),
  mission_not_draft: "Seul un brouillon se modifie.",
  mission_state_conflict: "Cette mission ne peut pas changer d'état de cette façon.",
  mission_active_limit: "Vous avez déjà 5 missions actives : terminez-en ou annulez-en une avant d'en lancer une autre.",
  mission_daily_limit: "Vous avez créé 20 missions aujourd'hui : réessayez demain.",
  mission_not_active: "Cette mission n'est plus active : aucun achat ne peut y être ajouté.",
  mission_quantity_exceeded: "Cette quantité dépasse ce qu'il reste à acheter pour la mission.",
  mission_price_over_budget: "Ce prix dépasse le budget par unité de la mission.",
  mission_budget_exceeded: "Cet achat dépasse le budget total de la mission.",
  invalid_quantity: "La quantité doit être un nombre entier de 1 à 10 000.",
});

export class MissionError extends Error {
  readonly code: MissionErrorCode;
  /** `mission_daily_limit` : secondes avant le prochain jour UTC. */
  readonly retryAfterSeconds: number | undefined;
  /** `invalid_mission` et `phone_number_in_mission` : le champ refusé (liste fermée de noms, jamais la valeur). */
  readonly field: MissionField | null;

  constructor(code: MissionErrorCode, options: { retryAfterSeconds?: number; field?: MissionField | null } = {}) {
    super(code === "phone_number_in_mission" ? missionPhoneMessage(options.field ?? null) : MISSION_ERROR_MESSAGES[code]);
    this.name = "MissionError";
    this.code = code;
    this.retryAfterSeconds = options.retryAfterSeconds;
    this.field = options.field ?? null;
  }
}
