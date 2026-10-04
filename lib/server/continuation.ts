import "server-only";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

interface ContinuationPayload {
  v: 1;
  sid: string;
  iph: string;
  text: string;
  clarificationId: string;
  options: string[];
  exp: number;
}

interface ContinuationInput {
  sessionId: string;
  ipHash: string;
  text: string;
  clarificationId: string;
  options: string[];
  secret: string;
  now?: Date;
  ttlSeconds?: number;
}

const textHash = (text: string): string =>
  createHash("sha256").update(text.trim()).digest("base64url");

const sign = (encoded: string, secret: string): string =>
  createHmac("sha256", secret).update(encoded).digest("base64url");

export function createContinuationToken(input: ContinuationInput): string {
  const payload: ContinuationPayload = {
    v: 1,
    sid: input.sessionId,
    iph: input.ipHash,
    text: textHash(input.text),
    clarificationId: input.clarificationId,
    options: input.options,
    exp: Math.floor((input.now ?? new Date()).getTime() / 1000) + (input.ttlSeconds ?? 300),
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${encoded}.${sign(encoded, input.secret)}`;
}

export function verifyContinuationToken(
  token: string,
  input: Omit<ContinuationInput, "options" | "ttlSeconds"> & { answer: string },
): boolean {
  try {
    const [encoded, signature, extra] = token.split(".");
    if (!encoded || !signature || extra) return false;
    const expected = sign(encoded, input.secret);
    const givenBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expected);
    if (
      givenBuffer.length !== expectedBuffer.length ||
      !timingSafeEqual(givenBuffer, expectedBuffer)
    ) return false;

    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Partial<ContinuationPayload>;
    if (
      payload.v !== 1 || payload.sid !== input.sessionId || payload.iph !== input.ipHash ||
      payload.text !== textHash(input.text) || payload.clarificationId !== input.clarificationId ||
      !Array.isArray(payload.options) || !payload.options.every((v) => typeof v === "string") ||
      typeof payload.exp !== "number" ||
      payload.exp < Math.floor((input.now ?? new Date()).getTime() / 1000)
    ) return false;
    return payload.options.includes(input.answer);
  } catch {
    return false;
  }
}
