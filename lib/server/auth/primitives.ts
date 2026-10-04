import "server-only";

import {
  createHash,
  createHmac,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from "node:crypto";
import { OtpRequestError } from "./errors";

const CANONICAL_PHONE = /^[+][1-9][0-9]{1,14}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SESSION_TOKEN = /^[A-Za-z0-9_-]{43}$/;

export function requireCanonicalPhone(phone: string): string {
  if (typeof phone !== "string" || !CANONICAL_PHONE.test(phone)) {
    throw new OtpRequestError(
      "Le téléphone doit être au format international canonique + suivi de chiffres.",
    );
  }
  return phone;
}

export function isUuid(value: string): boolean {
  return typeof value === "string" && UUID.test(value);
}

export function generateOtpCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, "0");
}

export function otpHmac(
  secret: Uint8Array,
  challengeId: string,
  phone: string,
  code: string,
): Buffer {
  return createHmac("sha256", secret)
    .update("noma:otp:v1\0", "utf8")
    .update(challengeId, "utf8")
    .update("\0", "utf8")
    .update(phone, "utf8")
    .update("\0", "utf8")
    .update(code, "utf8")
    .digest();
}

export function secretFingerprint(
  secret: Uint8Array,
  domain: "phone" | "ip",
  value: string,
): string {
  return createHmac("sha256", secret)
    .update(`noma:auth:${domain}:v1\0`, "utf8")
    .update(value, "utf8")
    .digest("hex");
}

export function safeOtpMatches(storedHex: string, calculated: Buffer): boolean {
  if (!/^[0-9a-f]{64}$/.test(storedHex)) return false;
  const stored = Buffer.from(storedHex, "hex");
  return stored.length === calculated.length && timingSafeEqual(stored, calculated);
}

export function generateSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

export function sessionTokenHash(token: string): string | null {
  if (typeof token !== "string" || !SESSION_TOKEN.test(token)) return null;
  const decoded = Buffer.from(token, "base64url");
  if (decoded.byteLength !== 32 || decoded.toString("base64url") !== token) return null;
  return createHash("sha256").update(decoded).digest("hex");
}
