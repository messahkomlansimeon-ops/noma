import "server-only";

/** Erreurs de domaine du portefeuille. Les erreurs de VALIDATION d'entrée sont des CatalogValidationError (comme le boost). */
export type WalletErrorCode =
  | "insufficient_balance"
  | "duplicate_reference"
  | "unbalanced_transaction"
  | "account_owner_not_found"
  | "idempotency_conflict"
  | "too_many_pending_topups";

/** Textes fixes : jamais de donnée de la base (ni identifiant, ni montant). */
export const WALLET_ERROR_MESSAGES: Readonly<Record<WalletErrorCode, string>> = Object.freeze({
  insufficient_balance: "Solde insuffisant.",
  duplicate_reference: "Cette opération du grand livre existe déjà (référence déjà utilisée).",
  unbalanced_transaction: "Transaction déséquilibrée : la somme des écritures doit valoir zéro.",
  account_owner_not_found: "Propriétaire du compte introuvable.",
  idempotency_conflict: "Cette clé d'idempotence a déjà servi pour un autre montant.",
  too_many_pending_topups: "Trop de recharges en attente.",
});

export class WalletError extends Error {
  readonly code: WalletErrorCode;

  constructor(code: WalletErrorCode) {
    super(WALLET_ERROR_MESSAGES[code]);
    this.name = "WalletError";
    this.code = code;
  }
}
