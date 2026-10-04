import type { Pool } from "pg";

export type AuthSecretInput = string | Uint8Array;
export type AuthClock = () => Date;

export interface SendOtpInput {
  phone: string;
  code: string;
  challengeId: string;
  expiresAt: Date;
}

export type SendOtp = (input: SendOtpInput) => Promise<void>;

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
}
