import "server-only";

import { PHOTO_BODY_READ_TIMEOUT_MS } from "./config";

export type BinaryBodyRead =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; reason: "invalid" | "too_large" | "empty" | "timeout" };

/**
 * Corps binaire d'une requête (la photo : les octets du fichier, sans enveloppe) lu avec un plafond d'octets. Le poids annoncé (`Content-Length`) est refusé AVANT toute
 * lecture ; sinon (ou s'il manque, ou ment) le flux est compté et coupé au premier octet de trop. Le Content-Type n'est jamais lu : le type vient des octets.
 * La lecture a un délai TOTAL (`timeoutMs`, 30 s par défaut) : un corps qui arrive goutte à goutte (un octet toutes les deux secondes) est coupé (`timeout`) au lieu de retenir la connexion.
 */
export async function readBinaryBodyCapped(request: Request, maxBytes: number, timeoutMs: number = PHOTO_BODY_READ_TIMEOUT_MS): Promise<BinaryBodyRead> {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    if (!/^[0-9]+$/.test(declared)) {
      void request.body?.cancel().catch(() => {});
      return { ok: false, reason: "invalid" };
    }
    if (BigInt(declared) > BigInt(maxBytes)) {
      void request.body?.cancel().catch(() => {});
      return { ok: false, reason: "too_large" };
    }
  }
  if (!request.body) return { ok: false, reason: "empty" };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  try {
    for (;;) {
      const next = await Promise.race([reader.read(), expired]);
      if (next === "timeout") {
        void reader.cancel().catch(() => {});
        return { ok: false, reason: "timeout" };
      }
      const { done, value } = next;
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        return { ok: false, reason: "too_large" };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, reason: "invalid" };
  } finally {
    clearTimeout(timer);
  }
  if (total === 0) return { ok: false, reason: "empty" };
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes };
}
