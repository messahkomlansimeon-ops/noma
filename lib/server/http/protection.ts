import "server-only";

export const NO_STORE_HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};

export type BodyRead =
  | { ok: true; text: string }
  | { ok: false; reason: "invalid" | "too_large" };

export type JsonBodyRead =
  | { ok: true; value: unknown }
  | { ok: false; reason: "invalid" | "too_large" };

export function noStoreJsonResponse(
  status: number,
  body: unknown,
  extraHeaders?: HeadersInit,
): Response {
  const headers = new Headers(extraHeaders);
  for (const [name, value] of Object.entries(NO_STORE_HEADERS)) headers.set(name, value);
  return Response.json(body, { status, headers });
}

export async function readBodyCapped(request: Request, maxBytes: number): Promise<BodyRead> {
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
  if (!request.body) return { ok: true, text: "" };

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
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
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return { ok: true, text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
  } catch {
    return { ok: false, reason: "invalid" };
  }
}

export async function readJsonBodyCapped(
  request: Request,
  maxBytes: number,
): Promise<JsonBodyRead> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") {
    void request.body?.cancel().catch(() => {});
    return { ok: false, reason: "invalid" };
  }
  const body = await readBodyCapped(request, maxBytes);
  if (!body.ok) return body;
  try {
    return { ok: true, value: JSON.parse(body.text) };
  } catch {
    return { ok: false, reason: "invalid" };
  }
}

export function readSingleCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  const prefix = `${name}=`;
  const values = header
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(prefix))
    .map((part) => part.slice(prefix.length));
  return values.length === 1 && values[0].length > 0 ? values[0] : null;
}

function normalizeConfiguredOrigin(value: string | undefined): string | null {
  const configured = value?.trim();
  if (!configured) return null;
  try {
    const url = new URL(configured);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username ||
      url.password ||
      (url.pathname !== "" && url.pathname !== "/") ||
      url.search ||
      url.hash
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

export function checkPostOrigin(
  request: Request,
  configuredOrigin: string | undefined,
): "allowed" | "forbidden" | "unconfigured" {
  const allowed = normalizeConfiguredOrigin(configuredOrigin);
  if (!allowed) return "unconfigured";
  const supplied = request.headers.get("origin");
  if (!supplied) return "forbidden";
  try {
    const parsed = new URL(supplied);
    return supplied === parsed.origin && parsed.origin === allowed ? "allowed" : "forbidden";
  } catch {
    return "forbidden";
  }
}
