import "server-only";

import { AuthConfigurationError } from "./errors";
import type { AuthClock, AuthSecretInput } from "./types";

export const OTP_TTL_MS = 5 * 60 * 1_000;
export const OTP_MAX_ATTEMPTS = 5;
export const OTP_RESEND_DELAY_MS = 60 * 1_000;
export const OTP_TRANSPORT_TIMEOUT_MS = 10 * 1_000;
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

export function requireAuthSecret(
  provided?: AuthSecretInput,
  env: Record<string, string | undefined> = process.env,
): Buffer {
  if (provided instanceof Uint8Array) {
    if (provided.byteLength < 32) {
      throw new AuthConfigurationError("NOMA_AUTH_SECRET doit contenir au moins 32 octets.");
    }
    return Buffer.from(provided);
  }

  const encoded = provided?.trim() || env.NOMA_AUTH_SECRET?.trim();
  if (!encoded) {
    throw new AuthConfigurationError("NOMA_AUTH_SECRET est requis pour utiliser l'authentification.");
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4 !== 0) {
    throw new AuthConfigurationError("NOMA_AUTH_SECRET doit être encodé en base64 valide.");
  }
  const decoded = Buffer.from(encoded, "base64");
  const canonical = decoded.toString("base64");
  if (canonical !== encoded || decoded.byteLength < 32) {
    throw new AuthConfigurationError(
      "NOMA_AUTH_SECRET doit décoder au moins 32 octets aléatoires.",
    );
  }
  return decoded;
}

export function readNow(clock: AuthClock | undefined): Date {
  const now = clock ? clock() : new Date();
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new AuthConfigurationError("L'horloge d'authentification est invalide.");
  }
  return new Date(now.getTime());
}
