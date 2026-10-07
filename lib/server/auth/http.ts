import "server-only";

import { createHash, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import type { Pool } from "pg";
import {
  AuthConfigurationError,
  OtpDeliveryError,
  OtpRateLimitError,
  OtpRequestError,
  OtpResendDelayError,
  OtpVerificationError,
} from "./errors";
import { resolveDevOtpTransport } from "./dev-otp-transport";
import { requestOtp as requestOtpService, verifyOtp as verifyOtpService } from "./otp";
import { isUuid, requireCanonicalPhone } from "./primitives";
import { resolveSession, revokeSession } from "./sessions";
import type { AuthClock, AuthSecretInput, SendOtp } from "./types";
import {
  checkPostOrigin,
  NO_STORE_HEADERS,
  noStoreJsonResponse,
  readBodyCapped,
  readJsonBodyCapped,
  readSingleCookie,
} from "../http/protection";

export const AUTH_BODY_MAX_BYTES = 2_048;
export const AUTH_SESSION_COOKIE = "noma_auth";

type Environment = Record<string, string | undefined>;

export interface AuthHttpDependencies {
  pool?: Pool;
  now?: AuthClock;
  authSecret?: AuthSecretInput;
  /** Transport injecté (tests, futur adaptateur) : il prime toujours sur `resolveSendOtp`. */
  sendOtp?: SendOtp;
  /**
   * Résolveur appelé à chaque demande d'OTP, seulement si `sendOtp` n'est pas injecté. Il reçoit
   * l'environnement des gestionnaires. Sans lui et sans `sendOtp`, aucun transport n'est installé.
   */
  resolveSendOtp?: (env: Environment) => SendOtp | undefined;
  env?: Environment;
}

export interface AuthHttpHandlers {
  requestOtp(request: Request): Promise<Response>;
  verifyOtp(request: Request): Promise<Response>;
  session(request: Request): Promise<Response>;
  logout(request: Request): Promise<Response>;
}

function jsonResponse(status: number, body: unknown, extraHeaders?: HeadersInit): Response {
  return noStoreJsonResponse(status, body, extraHeaders);
}

function jsonError(status: number, code: string, message: string): Response {
  return jsonResponse(status, { error: { code, message } });
}

function serviceUnavailable(extraHeaders?: HeadersInit): Response {
  const response = jsonError(
    503,
    "auth_unavailable",
    "Le service d'authentification est temporairement indisponible.",
  );
  if (extraHeaders) {
    new Headers(extraHeaders).forEach((value, name) => response.headers.set(name, value));
  }
  return response;
}

function invalidRequest(): Response {
  return jsonError(400, "invalid_request", "Requête d'authentification invalide.");
}

function forbiddenOrigin(): Response {
  return jsonError(403, "invalid_origin", "Origine de la requête non autorisée.");
}

function unauthorized(): Response {
  return jsonError(401, "authentication_refused", "Authentification refusée.");
}

function secretsMatch(expected: string, supplied: string): boolean {
  const expectedHash = createHash("sha256").update(expected, "utf8").digest();
  const suppliedHash = createHash("sha256").update(supplied, "utf8").digest();
  return timingSafeEqual(expectedHash, suppliedHash);
}

function trustedClientIp(request: Request, env: Environment): string | null {
  const proxySecret = env.NOMA_AUTH_PROXY_SECRET?.trim();
  const suppliedSecret = request.headers.get("x-noma-proxy-secret") ?? "";
  if (!proxySecret || Buffer.byteLength(proxySecret, "utf8") < 32) return null;
  if (!suppliedSecret || !secretsMatch(proxySecret, suppliedSecret)) return null;

  const forwarded = request.headers.get("x-forwarded-for")?.trim() ?? "";
  // Le contrat auth exige une valeur unique réécrite par le proxy, pas une
  // chaîne arbitraire héritée de proxies inconnus.
  if (!forwarded || forwarded.includes(",")) return null;
  const normalized = forwarded.startsWith("::ffff:") ? forwarded.slice(7) : forwarded;
  return isIP(normalized) === 0 ? null : normalized;
}

async function readJsonBody(request: Request): Promise<
  | { ok: true; value: unknown }
  | { ok: false; response: Response }
> {
  const body = await readJsonBodyCapped(request, AUTH_BODY_MAX_BYTES);
  if (!body.ok) {
    return {
      ok: false,
      response: body.reason === "too_large"
        ? jsonError(413, "payload_too_large", "Requête trop volumineuse.")
        : invalidRequest(),
    };
  }
  return { ok: true, value: body.value };
}

function isExactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => actual.includes(key));
}

function parseRequestOtpBody(value: unknown): { phone: string } | null {
  if (!isExactObject(value, ["phone"]) || typeof value.phone !== "string") return null;
  try {
    return { phone: requireCanonicalPhone(value.phone) };
  } catch {
    return null;
  }
}

function parseVerifyOtpBody(value: unknown): { challengeId: string; code: string } | null {
  if (!isExactObject(value, ["challengeId", "code"])) return null;
  if (
    typeof value.challengeId !== "string" ||
    !isUuid(value.challengeId) ||
    typeof value.code !== "string" ||
    !/^[0-9]{6}$/.test(value.code)
  ) {
    return null;
  }
  return { challengeId: value.challengeId, code: value.code };
}

function sessionCookie(token: string, expires: Date, production: boolean): string {
  return `${AUTH_SESSION_COOKIE}=${token}; Path=/; Expires=${expires.toUTCString()}; HttpOnly; SameSite=Lax${
    production ? "; Secure" : ""
  }`;
}

function clearedSessionCookie(production: boolean): string {
  return `${AUTH_SESSION_COOKIE}=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0; HttpOnly; SameSite=Lax${
    production ? "; Secure" : ""
  }`;
}

function requirePostOrigin(request: Request, env: Environment): Response | null {
  const origin = checkPostOrigin(request, env.NOMA_AUTH_ORIGIN);
  if (origin === "unconfigured") return serviceUnavailable();
  return origin === "forbidden" ? forbiddenOrigin() : null;
}

export function createAuthHttpHandlers(
  dependencies: AuthHttpDependencies = {},
): AuthHttpHandlers {
  const environment = (): Environment => dependencies.env ?? process.env;

  return {
    async requestOtp(request) {
      const env = environment();
      const originFailure = requirePostOrigin(request, env);
      if (originFailure) return originFailure;

      const parsed = await readJsonBody(request);
      if (!parsed.ok) return parsed.response;
      const body = parseRequestOtpBody(parsed.value);
      if (!body) return invalidRequest();

      const requestIp = trustedClientIp(request, env);
      if (!requestIp) return serviceUnavailable();

      try {
        const result = await requestOtpService(body.phone, {
          pool: dependencies.pool,
          now: dependencies.now,
          authSecret: dependencies.authSecret,
          sendOtp: dependencies.sendOtp ?? dependencies.resolveSendOtp?.(env),
          requestIp,
        });
        return jsonResponse(202, {
          challengeId: result.challengeId,
          expiresAt: result.expiresAt.toISOString(),
          resendAvailableAt: result.resendAvailableAt.toISOString(),
        });
      } catch (error) {
        if (error instanceof OtpRateLimitError || error instanceof OtpResendDelayError) {
          return jsonError(429, "otp_request_limited", "Demande OTP temporairement refusée.");
        }
        if (error instanceof OtpRequestError && !(error instanceof OtpDeliveryError)) {
          return invalidRequest();
        }
        if (error instanceof AuthConfigurationError || error instanceof OtpDeliveryError) {
          return serviceUnavailable();
        }
        return serviceUnavailable();
      }
    },

    async verifyOtp(request) {
      const env = environment();
      const originFailure = requirePostOrigin(request, env);
      if (originFailure) return originFailure;

      const parsed = await readJsonBody(request);
      if (!parsed.ok) return parsed.response;
      const body = parseVerifyOtpBody(parsed.value);
      if (!body) return invalidRequest();

      try {
        const result = await verifyOtpService(body.challengeId, body.code, {
          pool: dependencies.pool,
          now: dependencies.now,
          authSecret: dependencies.authSecret,
        });
        return jsonResponse(
          200,
          { userId: result.userId },
          {
            "Set-Cookie": sessionCookie(
              result.sessionToken,
              result.sessionExpiresAt,
              env.NODE_ENV === "production",
            ),
          },
        );
      } catch (error) {
        if (error instanceof OtpVerificationError) return unauthorized();
        if (error instanceof AuthConfigurationError) return serviceUnavailable();
        return serviceUnavailable();
      }
    },

    /**
     * Lecture de la session (lot D3) : TOUJOURS 200 quand la base répond. `{ authenticated: false }` sans session valide (le visiteur anonyme ne provoque plus de 401 dans la console du
     * navigateur) ; `{ authenticated: true, userId, isAdmin }` sinon, `isAdmin` étant un booléen seulement (le sélecteur d'espace n'affiche l'onglet Admin qu'aux administrateurs ;
     * l'autorisation réelle reste celle des routes /api/admin/*, qui relisent la base).
     */
    async session(request) {
      const token = readSingleCookie(request, AUTH_SESSION_COOKIE);
      if (!token) return jsonResponse(200, { authenticated: false });
      try {
        const result = await resolveSession(token, {
          pool: dependencies.pool,
          now: dependencies.now,
        });
        return result
          ? jsonResponse(200, { authenticated: true, userId: result.userId, isAdmin: result.isAdmin === true })
          : jsonResponse(200, { authenticated: false });
      } catch {
        return serviceUnavailable();
      }
    },

    async logout(request) {
      const env = environment();
      const originFailure = requirePostOrigin(request, env);
      if (originFailure) return originFailure;

      const body = await readBodyCapped(request, AUTH_BODY_MAX_BYTES);
      if (!body.ok) {
        return body.reason === "too_large"
          ? jsonError(413, "payload_too_large", "Requête trop volumineuse.")
          : invalidRequest();
      }
      if (body.text.trim().length > 0) return invalidRequest();

      const clearCookie = clearedSessionCookie(env.NODE_ENV === "production");
      const token = readSingleCookie(request, AUTH_SESSION_COOKIE);
      try {
        if (token) {
          await revokeSession(token, { pool: dependencies.pool, now: dependencies.now });
        }
        return new Response(null, {
          status: 204,
          headers: { ...NO_STORE_HEADERS, "Set-Cookie": clearCookie },
        });
      } catch {
        return serviceUnavailable();
      }
    },
  };
}

/**
 * Dépendances par défaut des routes HTTP. Seul point où le transport OTP de développement est branché :
 * il n'existe que si NODE_ENV=development ET NOMA_DEV_OTP_CONSOLE=1 (voir dev-otp-transport.ts). L'objet est gelé :
 * les gestionnaires lisent ces dépendances à chaque requête, une mutation (transport injecté) serait donc effective.
 */
export const defaultAuthHttpDependencies: AuthHttpDependencies = Object.freeze({
  resolveSendOtp: resolveDevOtpTransport,
});

export const defaultAuthHttpHandlers = createAuthHttpHandlers(defaultAuthHttpDependencies);
