/** Refus de domaine de l'administration (lot D2) : code stable et texte fixe. */
export type AdminErrorCode = "target_not_found" | "target_protected" | "target_archived" | "grant_no_account" | "grant_invalid_phone";

export const ADMIN_ERROR_MESSAGES: Readonly<Record<AdminErrorCode, string>> = Object.freeze({
  target_not_found: "Compte introuvable.",
  target_protected: "Un compte administrateur ne peut pas être suspendu.",
  target_archived: "Ce compte est archivé : il ne peut plus changer de statut.",
  grant_no_account: "Aucun compte vérifié ne correspond à ce numéro.",
  grant_invalid_phone: "Numéro invalide : saisissez un numéro ivoirien (07 00 00 00 00) ou au format +225…",
});

export class AdminError extends Error {
  readonly code: AdminErrorCode;

  constructor(code: AdminErrorCode) {
    super(ADMIN_ERROR_MESSAGES[code]);
    this.name = "AdminError";
    this.code = code;
  }
}
