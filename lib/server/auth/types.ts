import type { Pool } from "pg";

export type AuthSecretInput = string | Uint8Array;
export type AuthClock = () => Date;

export interface SendOtpInput {
  phone: string;
  code: string;
  challengeId: string;
  expiresAt: Date;
}

/**
 * Transport d'envoi du code. Il lève pour un échec (le défi passe à `send_failed`) ; `OtpDeliveryUncertainError` signale un résultat inconnu (le défi reste valable).
 * `timeoutMs` (facultatif, lot SMS1) : durée maximale propre au transport, plus longue que le défaut (10 s) pour un vrai fournisseur.
 * `timeoutIsUncertain` (facultatif, lot SMS1-bis) : vrai si un dépassement de ce délai ne prouve PAS que rien n'est parti (vrai fournisseur : l'envoi continue peut-être en arrière-plan) ;
 * le défi reste alors vérifiable, comme pour `OtpDeliveryUncertainError`. Absent ou faux : le dépassement est un échec (`send_failed`).
 */
export type SendOtp = ((input: SendOtpInput) => Promise<void>) & { readonly timeoutMs?: number; readonly timeoutIsUncertain?: boolean };

export interface AuthDatabaseContext {
  pool?: Pool;
  now?: AuthClock;
}

export interface AuthSecretContext extends AuthDatabaseContext {
  /** Injection de test ; en production, NOMA_AUTH_SECRET est lu à l'usage. */
  authSecret?: AuthSecretInput;
}

export interface RequestOtpContext extends AuthSecretContext {
  requestIp: string;
  /** Aucun transport n'est installé par défaut. */
  sendOtp?: SendOtp;
  transportTimeoutMs?: number;
}

export type VerifyOtpContext = AuthSecretContext;
export type SessionContext = AuthDatabaseContext;

export interface RequestOtpResult {
  challengeId: string;
  expiresAt: Date;
  resendAvailableAt: Date;
}

export interface VerifyOtpResult {
  userId: string;
  sessionToken: string;
  sessionExpiresAt: Date;
}

export interface ResolvedSession {
  userId: string;
  expiresAt: Date;
  /** Compte administrateur (lot D3) : un booléen, jamais un rôle ni une liste de droits. Absent = faux. L'autorisation réelle des routes d'administration relit la base. */
  isAdmin?: boolean;
}
