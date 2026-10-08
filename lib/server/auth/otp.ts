import "server-only";

import { randomUUID } from "node:crypto";
import type { PoolClient, QueryResultRow } from "pg";
import { createUser } from "../catalog/users";
import { getPostgresPool, withPostgresTransaction } from "../postgres/client";
import {
  OTP_MAX_ATTEMPTS,
  OTP_RESEND_DELAY_MS,
  OTP_TRANSPORT_TIMEOUT_MS,
  OTP_TTL_MS,
  SESSION_TTL_MS,
  readNow,
  requireAuthSecret,
} from "./config";
import {
  AuthConfigurationError,
  OtpCapacityError,
  OtpDeliveryError,
  OtpDeliveryUncertainError,
  OtpRateLimitError,
  OtpResendDelayError,
  OtpVerificationError,
} from "./errors";
import { IP_ADDRESS_LIMIT_15M, IP_ADDRESS_LIMIT_DAY, ipAggregation } from "./ip-prefix";
import {
  generateOtpCode,
  generateSessionToken,
  isUuid,
  otpHmac,
  requireCanonicalPhone,
  safeOtpMatches,
  secretFingerprint,
  sessionTokenHash,
} from "./primitives";
import type {
  RequestOtpContext,
  RequestOtpResult,
  SendOtp,
  SendOtpInput,
  VerifyOtpContext,
  VerifyOtpResult,
} from "./types";

interface ChallengeRow extends QueryResultRow {
  id: string;
  phone_e164: string;
  otp_hmac: string;
  status: string;
  failed_attempts: number;
  expires_at: Date;
}

interface IdentityRow extends QueryResultRow {
  user_id: string;
  status: "active" | "suspended" | "archived";
}

const FIFTEEN_MINUTES_MS = 15 * 60 * 1_000;
const DAY_MS = 24 * 60 * 60 * 1_000;

/** Espace du verrou consultatif qui sérialise le comptage des défis non vérifiés d'une adresse ou d'un préfixe (lot SMS1-ter). Voir aussi SMS_BUDGET_LOCK_NAMESPACE (…977). */
export const OTP_ADDRESS_LOCK_NAMESPACE = 1_314_664_978;

function fixedWindowStart(now: Date, durationMs: number): Date {
  return new Date(Math.floor(now.getTime() / durationMs) * durationMs);
}

/** Compteur à fenêtres FIXES (numéro de téléphone seulement : 3 par quart d'heure civil, 10 par jour UTC). */
async function consumeQuota(
  client: PoolClient,
  fingerprint: string,
  windowKind: "15m" | "day",
  windowStart: Date,
  limit: number,
  now: Date,
): Promise<void> {
  const result = await client.query(
    `INSERT INTO otp_rate_limit_counters (
       dimension, subject_fingerprint, window_kind, window_start, request_count, updated_at
     ) VALUES ('phone', $1, $2, $3, 1, $4)
     ON CONFLICT (dimension, subject_fingerprint, window_kind, window_start)
     DO UPDATE SET
       request_count = otp_rate_limit_counters.request_count + 1,
       updated_at = EXCLUDED.updated_at
     WHERE otp_rate_limit_counters.request_count < $5
     RETURNING request_count`,
    [fingerprint, windowKind, windowStart, now, limit],
  );
  if (!result.rowCount) throw new OtpRateLimitError();
}

/**
 * Compteur par adresse ou par préfixe (lot SMS1-ter) : ne compte que les défis NON vérifiés (statut différent de `consumed`) créés dans les 15 dernières minutes et les 24 dernières
 * heures (fenêtres GLISSANTES : aucun blocage ne dure « jusqu'à minuit »). Un utilisateur qui vérifie son code libère sa place : derrière une adresse partagée (CGNAT), les
 * utilisateurs légitimes ne s'épuisent pas entre eux, seuls les demandeurs qui ne vérifient jamais atteignent la limite. Le comptage et l'insertion du défi sont sérialisés par un
 * verrou consultatif propre au sujet : la limite est EXACTE sous concurrence.
 */
async function assertUnverifiedWithinLimits(
  client: PoolClient,
  column: "request_ip_fingerprint" | "request_prefix_fingerprint",
  fingerprint: string,
  limits: { quarter: number; day: number },
  now: Date,
): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock($1::int, hashtext($2::text))", [OTP_ADDRESS_LOCK_NAMESPACE, `${column}:${fingerprint}`]);
  const counted = await client.query<{ quarter: number; day: number }>(
    `SELECT count(*) FILTER (WHERE created_at > $2::timestamptz)::int AS quarter, count(*)::int AS day
       FROM otp_challenges
      WHERE ${column} = $1 AND created_at > $3::timestamptz AND status <> 'consumed'`,
    [fingerprint, new Date(now.getTime() - FIFTEEN_MINUTES_MS), new Date(now.getTime() - DAY_MS)],
  );
  if (counted.rows[0].quarter >= limits.quarter || counted.rows[0].day >= limits.day) throw new OtpRateLimitError();
}

async function reserveRequest(
  client: PoolClient,
  input: {
    challengeId: string;
    phone: string;
    otpDigest: string;
    ipFingerprint: string;
    /** Empreinte du préfixe de l'adresse (/24 en IPv4, /64 en IPv6) : voir ip-prefix.ts. */
    ipPrefixFingerprint: string;
    ipPrefixLimits: { quarter: number; day: number };
    phoneFingerprint: string;
    now: Date;
    expiresAt: Date;
  },
): Promise<void> {
  const quarterHour = fixedWindowStart(input.now, FIFTEEN_MINUTES_MS);
  const day = fixedWindowStart(input.now, DAY_MS);

  // L'ordre est stable (numéro, puis adresse, puis préfixe : aucune attente circulaire possible). Le premier compteur téléphone sérialise aussi deux premières demandes
  // concurrentes, même si aucun challenge n'existe encore.
  await client.query("SET LOCAL lock_timeout = '5s'");
  await consumeQuota(client, input.phoneFingerprint, "15m", quarterHour, 3, input.now);
  await consumeQuota(client, input.phoneFingerprint, "day", day, 10, input.now);
  // Lot SMS1-ter : par adresse (60 par 15 minutes, 300 par jour) puis par préfixe (SMS1-bis, B1-d : changer d'adresse dans son bloc ne contourne pas les limites), défis non vérifiés seulement.
  await assertUnverifiedWithinLimits(client, "request_ip_fingerprint", input.ipFingerprint, { quarter: IP_ADDRESS_LIMIT_15M, day: IP_ADDRESS_LIMIT_DAY }, input.now);
  await assertUnverifiedWithinLimits(client, "request_prefix_fingerprint", input.ipPrefixFingerprint, input.ipPrefixLimits, input.now);

  const previous = await client.query<{ created_at: Date }>(
    `SELECT created_at
       FROM otp_challenges
      WHERE phone_e164 = $1
      ORDER BY created_at DESC
      LIMIT 1
      FOR UPDATE`,
    [input.phone],
  );
  if (
    previous.rowCount &&
    input.now.getTime() - previous.rows[0].created_at.getTime() < OTP_RESEND_DELAY_MS
  ) {
    throw new OtpResendDelayError();
  }

  await client.query(
    `UPDATE otp_challenges
        SET status = 'superseded', updated_at = $2
      WHERE phone_e164 = $1 AND status IN ('pending_send', 'sent')`,
    [input.phone, input.now],
  );
  await client.query(
    `INSERT INTO otp_challenges (
       id, phone_e164, otp_hmac, request_ip_fingerprint, request_prefix_fingerprint, status,
       expires_at, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, $5, 'pending_send', $6, $7, $7)`,
    [
      input.challengeId,
      input.phone,
      input.otpDigest,
      input.ipFingerprint,
      input.ipPrefixFingerprint,
      input.expiresAt,
      input.now,
    ],
  );
}

/** Délai de garde dépassé : le transport n'a pas rendu son résultat (il continue peut-être en arrière-plan). */
class OtpTransportTimeoutError extends Error {
  constructor() {
    super("OTP transport timeout");
    this.name = "OtpTransportTimeoutError";
  }
}

function sendWithTimeout(sendOtp: SendOtp, input: SendOtpInput, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new OtpTransportTimeoutError()), timeoutMs);
    Promise.resolve()
      .then(() => sendOtp(input))
      .then(resolve, reject)
      .finally(() => clearTimeout(timer));
  });
}

export async function requestOtp(
  phoneValue: string,
  context: RequestOtpContext,
): Promise<RequestOtpResult> {
  if (!context.sendOtp) {
    throw new AuthConfigurationError("Aucun transport OTP n'est configuré.");
  }
  const secret = requireAuthSecret(context.authSecret);
  const phone = requireCanonicalPhone(phoneValue);
  const requestIp = context.requestIp;
  if (typeof requestIp !== "string" || requestIp.length === 0 || requestIp.length > 255) {
    throw new AuthConfigurationError("L'empreinte IP source ne peut pas être calculée.");
  }
  const timeoutMs = context.transportTimeoutMs ?? context.sendOtp.timeoutMs ?? OTP_TRANSPORT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new AuthConfigurationError("Le délai du transport OTP est invalide.");
  }

  const challengeId = randomUUID();
  const code = generateOtpCode();
  const pool = context.pool ?? getPostgresPool();
  const aggregation = ipAggregation(requestIp);
  const reservation = await withPostgresTransaction(async (client) => {
    // Cette lecture a lieu apres l'attente eventuelle de pool et BEGIN.
    const reservedAt = readNow(context.now);
    const expiresAt = new Date(reservedAt.getTime() + OTP_TTL_MS);
    await reserveRequest(client, {
      challengeId,
      phone,
      otpDigest: otpHmac(secret, challengeId, phone, code).toString("hex"),
      ipFingerprint: secretFingerprint(secret, "ip", requestIp),
      ipPrefixFingerprint: secretFingerprint(secret, "ip-prefix", aggregation.key),
      ipPrefixLimits: { quarter: aggregation.limitPer15Minutes, day: aggregation.limitPerDay },
      phoneFingerprint: secretFingerprint(secret, "phone", phone),
      now: reservedAt,
      expiresAt,
    });
    return { reservedAt, expiresAt };
  }, pool);

  // reserveRequest peut elle-meme avoir attendu des verrous. Ne jamais remettre
  // au transport un code dont la duree de vie est deja terminee.
  const transportStartedAt = readNow(context.now);
  if (reservation.expiresAt.getTime() <= transportStartedAt.getTime()) {
    await pool.query(
      `UPDATE otp_challenges
          SET status = 'expired', updated_at = $2
        WHERE id = $1 AND status = 'pending_send'`,
      [challengeId, transportStartedAt],
    );
    throw new OtpDeliveryError();
  }

  try {
    await sendWithTimeout(
      context.sendOtp,
      { phone, code, challengeId, expiresAt: reservation.expiresAt },
      timeoutMs,
    );
  } catch (error) {
    // Résultat inconnu (lot SMS1) : le SMS est peut-être parti. Le défi reste valable (confirmé ci-dessous) et aucun code n'est renvoyé automatiquement.
    // Lot SMS1-bis (S-b) : il en va de même quand le délai de GARDE est dépassé pour un transport dont le dépassement ne prouve rien (`timeoutIsUncertain`) : l'envoi continue
    // peut-être en arrière-plan, le code reçu doit marcher.
    const uncertain = error instanceof OtpDeliveryUncertainError || (error instanceof OtpTransportTimeoutError && context.sendOtp.timeoutIsUncertain === true);
    if (!uncertain) {
      const failedAt = readNow(context.now);
      // Budget d'envoi atteint (aucun SMS parti) : lot SMS1-ter, AUCUN oracle d'énumération. Le défi est créé mais ne peut jamais être vérifié (statut `send_failed`) et la réponse est
      // EXACTEMENT celle d'un succès (même forme, même délai de renvoi) : un refus pour capacité ne dit pas si le numéro a un compte. Le motif est gardé pour l'administration.
      if (error instanceof OtpCapacityError) {
        await pool.query(
          `UPDATE otp_challenges
              SET status = 'send_failed', send_failure_code = $3, updated_at = $2
            WHERE id = $1 AND status = 'pending_send'`,
          [challengeId, failedAt, error.code],
        );
        return {
          challengeId,
          expiresAt: reservation.expiresAt,
          resendAvailableAt: new Date(reservation.reservedAt.getTime() + OTP_RESEND_DELAY_MS),
        };
      }
      await pool.query(
        `UPDATE otp_challenges
            SET status = 'send_failed', updated_at = $2
          WHERE id = $1 AND status = 'pending_send'`,
        [challengeId, failedAt],
      );
      throw new OtpDeliveryError();
    }
  }

  const confirmedAt = readNow(context.now);
  const confirmed = await pool.query(
    `UPDATE otp_challenges
        SET status = 'sent', sent_at = $2, updated_at = $2
      WHERE id = $1 AND status = 'pending_send' AND expires_at > $2
      RETURNING id`,
    [challengeId, confirmedAt],
  );
  if (!confirmed.rowCount) {
    await pool.query(
      `UPDATE otp_challenges
          SET status = 'expired', updated_at = $2
        WHERE id = $1 AND status = 'pending_send'`,
      [challengeId, confirmedAt],
    );
    throw new OtpDeliveryError();
  }

  return {
    challengeId,
    expiresAt: reservation.expiresAt,
    resendAvailableAt: new Date(reservation.reservedAt.getTime() + OTP_RESEND_DELAY_MS),
  };
}

export async function verifyOtp(
  challengeId: string,
  code: string,
  context: VerifyOtpContext,
): Promise<VerifyOtpResult> {
  const secret = requireAuthSecret(context.authSecret);
  if (!isUuid(challengeId) || typeof code !== "string") {
    throw new OtpVerificationError();
  }
  const pool = context.pool ?? getPostgresPool();
  const outcome = await withPostgresTransaction(async (client) => {
    const challengeResult = await client.query<ChallengeRow>(
      `SELECT id, phone_e164, otp_hmac, status, failed_attempts, expires_at
         FROM otp_challenges
        WHERE id = $1
        FOR UPDATE`,
      [challengeId],
    );
    if (!challengeResult.rowCount) return null;
    const challenge = challengeResult.rows[0];
    // FOR UPDATE peut avoir attendu : l'instant lu avant la requete serait obsolete.
    const challengeLockedAt = readNow(context.now);
    if (challenge.status !== "sent") return null;
    if (challenge.expires_at.getTime() <= challengeLockedAt.getTime()) {
      await client.query(
        `UPDATE otp_challenges SET status = 'expired', updated_at = $2 WHERE id = $1`,
        [challengeId, challengeLockedAt],
      );
      return null;
    }

    const matches = safeOtpMatches(
      challenge.otp_hmac,
      otpHmac(
        secret,
        challenge.id,
        challenge.phone_e164,
        /^[0-9]{6}$/.test(code) ? code : "invalid-otp-format",
      ),
    );
    if (!matches) {
      const attempts = Math.min(OTP_MAX_ATTEMPTS, challenge.failed_attempts + 1);
      await client.query(
        `UPDATE otp_challenges
            SET failed_attempts = $2::integer,
                status = CASE WHEN $2::integer >= $3::integer THEN 'locked' ELSE status END,
                updated_at = $4
          WHERE id = $1`,
        [challengeId, attempts, OTP_MAX_ATTEMPTS, challengeLockedAt],
      );
      return null;
    }

    const identity = await client.query<IdentityRow>(
      `SELECT identity.user_id, account.status
         FROM phone_identities AS identity
         JOIN users AS account ON account.id = identity.user_id
        WHERE identity.phone_e164 = $1
        FOR UPDATE OF identity, account`,
      [challenge.phone_e164],
    );

    // Le verrou de l'identite ou du compte peut aussi avoir attendu. Cet instant
    // est la decision de consommation et ne depend pas du debut de transaction.
    const consumedAt = readNow(context.now);
    if (challenge.expires_at.getTime() <= consumedAt.getTime()) {
      await client.query(
        `UPDATE otp_challenges SET status = 'expired', updated_at = $2 WHERE id = $1`,
        [challengeId, consumedAt],
      );
      return null;
    }

    let userId: string;
    if (identity.rowCount) {
      if (identity.rows[0].status !== "active") {
        await client.query(
          `UPDATE otp_challenges
            SET status = 'consumed', consumed_at = $2, updated_at = $2
            WHERE id = $1`,
          [challengeId, consumedAt],
        );
        return null;
      }
      userId = identity.rows[0].user_id;
    } else {
      const user = await createUser({}, client);
      userId = user.id;
      await client.query(
        `INSERT INTO phone_identities (phone_e164, user_id, verified_at, created_at)
         VALUES ($1, $2, $3, $3)`,
        [challenge.phone_e164, userId, consumedAt],
      );
    }

    const sessionToken = generateSessionToken();
    const sessionExpiresAt = new Date(consumedAt.getTime() + SESSION_TTL_MS);
    await client.query(
      `INSERT INTO auth_sessions (
         id, user_id, token_sha256, created_at, expires_at
       ) VALUES ($1, $2, $3, $4, $5)`,
      [randomUUID(), userId, sessionTokenHash(sessionToken), consumedAt, sessionExpiresAt],
    );
    await client.query(
      `UPDATE otp_challenges
          SET status = 'consumed', consumed_at = $2, updated_at = $2
        WHERE id = $1`,
      [challengeId, consumedAt],
    );
    return { userId, sessionToken, sessionExpiresAt };
  }, pool);

  if (!outcome) throw new OtpVerificationError();
  return outcome;
}
