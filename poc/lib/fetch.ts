/**
 * Téléchargement centralisé et contrôlé pour toute URL externe non fiable.
 *
 * Garanties (cahier des charges §6 + revue P1-1/P1-2) :
 * - HTTP/HTTPS uniquement, aucun identifiant intégré, ports 80/443 ;
 * - destinations vérifiées (IPv4/IPv6) : localhost, privé, link-local,
 *   unique-local, multicast, réservé, métadonnées → refusés (ipaddr.js) ;
 * - L'ADRESSE VALIDÉE EST IMPOSÉE À LA CONNEXION (lookup forcé sur l'IP
 *   validée) : une seconde résolution DNS ne peut pas contourner le contrôle
 *   (anti DNS-rebind) — revue P1-1 ;
 * - chaque redirection est re-résolue et re-validée ;
 * - transport via node:http/https : le corps arrive ENCORÉ et est
 *   décompressé UNE SEULE FOIS ici (fetch() auto-décompressait → double
 *   décompression « incorrect header check » — revue P1-2), avec plafond
 *   décompressé (maxOutputLength) et annulation réelle ;
 * - limites configurables : 15 s par téléchargement, 3 redirections,
 *   2 Mo décompressés ;
 * - transport injectable pour les tests (aucun réseau en tests locaux).
 */
import dns from "node:dns/promises";
import { BlockList } from "node:net";
import ipaddr from "ipaddr.js";
import { gunzipSync, inflateSync } from "node:zlib";
import http from "node:http";
import https from "node:https";

export interface FetchLimits {
  totalMs: number;
  maxRedirects: number;
  maxBytes: number;
}

export const DEFAULT_LIMITS: FetchLimits = {
  totalMs: 15_000,
  maxRedirects: 3,
  maxBytes: 2_000_000,
};

export type SafeFetchErrorKind =
  | "bad-url"
  | "blocked"
  | "http"
  | "timeout"
  | "too-large"
  | "too-many-redirects"
  | "network";

export class SafeFetchError extends Error {
  kind: SafeFetchErrorKind;
  /** Statut HTTP quand kind = "http" (refus 401/403/429 → "blocked") ou
   *  erreur serveur 5xx (→ "network", transitoire). */
  status?: number;
  url: string;
  constructor(
    kind: SafeFetchErrorKind,
    url: string,
    detail?: string,
    status?: number,
  ) {
    super(`${kind}: ${url}${detail ? ` — ${detail}` : ""}`);
    this.kind = kind;
    this.url = url;
    this.status = status;
  }
}

export interface TransportResponse {
  status: number;
  headers: Record<string, string>;
  /** Corps brut (encodé tel que servi). string | chunks | générateur. */
  body: string | Uint8Array[] | (() => AsyncIterable<Uint8Array>);
}

export interface TransportDeps {
  resolve?: (host: string) => Promise<string[]>;
  load?: (url: string, signal: AbortSignal) => Promise<TransportResponse>;
}

/** Adresse validée imposée à la connexion. */
export interface PinnedTarget {
  address: string;
  port: number;
  /** Famille imposée au lookup forcé (4 ou 6). */
  family?: 4 | 6;
}

// ─── Validation d'URL et d'adresses ────────────────────────────────────────

const blockList = new BlockList();
blockList.addSubnet("127.0.0.0", 8, "ipv4");
blockList.addSubnet("10.0.0.0", 8, "ipv4");
blockList.addSubnet("172.16.0.0", 12, "ipv4");
blockList.addSubnet("192.168.0.0", 16, "ipv4");
blockList.addSubnet("169.254.0.0", 16, "ipv4"); // link-local + métadonnées 169.254.169.254
blockList.addSubnet("0.0.0.0", 8, "ipv4");
blockList.addSubnet("100.64.0.0", 10, "ipv4"); // CGNAT
blockList.addSubnet("192.0.0.0", 24, "ipv4");
blockList.addSubnet("198.18.0.0", 15, "ipv4"); // benchmark
blockList.addSubnet("224.0.0.0", 4, "ipv4"); // multicast
blockList.addSubnet("240.0.0.0", 4, "ipv4"); // réservé

function isForbiddenIp(ip: string): boolean {
  try {
    const parsed = ipaddr.parse(ip);
    const kind = parsed.kind();
    if (kind === "ipv6") {
      const v6 = parsed as ipaddr.IPv6;
      if (v6.range() === "ipv4Mapped") {
        const v4 = (v6 as unknown as { toIPv4Address: () => ipaddr.IPv4 }).toIPv4Address();
        return isForbiddenIp(v4.toString());
      }
      const range = v6.range();
      return [
        "loopback", "linkLocal", "uniqueLocal", "multicast", "reserved",
        "unspecified", "discard",
      ].includes(range);
    }
    const range = (parsed as ipaddr.IPv4).range();
    if (["loopback", "private", "linkLocal", "multicast", "reserved", "unspecified"].includes(range)) {
      return true;
    }
    return blockList.check(ip, "ipv4");
  } catch {
    return true; // adresse non parsable = refusée
  }
}

/** Validation d'une URL de destination (protocole, identifiants, port). */
export function validateTarget(urlStr: string): URL {
  let url: URL;
  try {
    url = new URL(urlStr);
  } catch {
    throw new SafeFetchError("bad-url", urlStr, "URL non parsable");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new SafeFetchError("blocked", urlStr, `protocole ${url.protocol} refusé`);
  }
  if (url.username || url.password) {
    throw new SafeFetchError("blocked", urlStr, "identifiants dans l'URL refusés");
  }
  if (url.port && url.port !== "80" && url.port !== "443") {
    throw new SafeFetchError("blocked", urlStr, `port ${url.port} refusé`);
  }
  if (!url.hostname) {
    throw new SafeFetchError("bad-url", urlStr, "hôte manquant");
  }
  return url;
}

async function assertPublicHost(
  host: string,
  deps: TransportDeps,
  urlStr: string,
  deadline: number,
): Promise<string[]> {
  const resolve =
    deps.resolve ??
    (async (h: string) => {
      const res = await dns.lookup(h, { all: true, verbatim: true });
      return res.map((r) => r.address);
    });
  const remaining = Math.max(1, deadline - Date.now());
  let timer: NodeJS.Timeout | undefined;
  const timeoutP = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new SafeFetchError("timeout", urlStr, "résolution DNS > délai total")),
      remaining,
    );
    timer.unref?.();
  });
  let ips: string[];
  try {
    // la résolution est BORNÉE par le délai total (revue 2 P2-5)
    ips = await Promise.race([resolve(host), timeoutP]);
  } catch (e) {
    if (e instanceof SafeFetchError) throw e;
    throw new SafeFetchError("network", urlStr, `DNS: ${(e as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
  for (const ip of ips) {
    if (isForbiddenIp(ip)) {
      throw new SafeFetchError("blocked", urlStr, `adresse non publique refusée (${ip})`);
    }
  }
  return ips;
}

// ─── Transport maîtrisé (node:http/https) ──────────────────────────────────

export interface TransportOptions {
  pin: PinnedTarget;
  limits: FetchLimits;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

/**
 * Transport HTTP avec adresse imposée : la connexion utilise l'IP validée
 * (lookup forcé) — pas de nouvelle résolution au moment de la connexion.
 * Le corps est rendu BRUT (encodé) : la décompression n'arrive qu'une fois,
 * dans readBodyLimited.
 */
export function httpTransport(
  urlStr: string,
  signal: AbortSignal,
  opts: TransportOptions,
): Promise<TransportResponse> {
  return new Promise((resolve, reject) => {
    let url: URL;
    try {
      url = new URL(urlStr);
    } catch {
      reject(new SafeFetchError("bad-url", urlStr, "URL non parsable"));
      return;
    }
    // NOTE : la validation (protocole/ports/identifiants/SSRF) est du ressort
    // de safeFetch ; httpTransport accepte des ports locaux pour les tests.
    const isHttps = url.protocol === "https:";
    const mod = isHttps ? https : http;
    const rawChunks: Uint8Array[] = [];
    let rawSize = 0;
    let settled = false;

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(abortTimer);
      signal.removeEventListener("abort", onAbort);
      fn();
    };
    // déjà annulé à l'entrée : aucune requête envoyée (revue 3 P2)
    if (signal.aborted) {
      settled = true;
      reject(new SafeFetchError("timeout", urlStr, "annulé avant la connexion"));
      return;
    }
    const onAbort = () => {
      settle(() => {
        req.destroy(new DOMException("aborted", "AbortError"));
        reject(new SafeFetchError("timeout", urlStr, "annulé"));
      });
    };
    signal.addEventListener("abort", onAbort, { once: true });
    // Deadline PROPRE au transport : un corps qui n'arrive jamais est coupé
    // même si le signal n'est jamais déclenché (revue P2-9).
    const abortTimer = setTimeout(() => {
      settle(() => {
        req.destroy(new DOMException("timeout", "TimeoutError"));
        reject(new SafeFetchError("timeout", urlStr, `> ${opts.limits.totalMs} ms`));
      });
    }, opts.limits.totalMs);
    abortTimer.unref?.();

    const req = mod.request(
      {
        // ANTI DNS-REBIND : connexion DIRECTE à l'adresse validée (une IP
        // littérale n'est jamais re-résolue par DNS) ; SNI + en-tête Host
        // conservent le vrai domaine pour TLS et le serveur.
        host: opts.pin.address,
        port: opts.pin.port,
        path: `${url.pathname}${url.search}`,
        method: "GET",
        agent: false, // pas de keep-alive : connexion fermée à chaque réponse
        servername: isHttps ? url.hostname : undefined,
        headers: {
          Host: `${url.hostname}${url.port && url.port !== "443" && url.port !== "80" ? `:${url.port}` : ""}`,
          "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) Chrome/131.0 Safari/537.36 noma-poc",
          "Accept-Language": "fr-FR,fr;q=0.9",
          Connection: "close",
          ...(opts.headers ?? {}),
        },
      },
      (res) => {
        res.on("data", (chunk: Buffer) => {
          rawSize += chunk.length;
          if (rawSize > opts.limits.maxBytes * 4) {
            settled = true;
            req.destroy();
            reject(new SafeFetchError("too-large", urlStr, `corps brut > ${rawSize} o`));
            return;
          }
          rawChunks.push(new Uint8Array(chunk));
        });
        res.on("end", () => {
          settle(() =>
            resolve({
              status: res.statusCode ?? 0,
              headers: Object.fromEntries(
                Object.entries(res.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(", ") : (v ?? "")]),
              ),
              body: () =>
                (async function* () {
                  for (const c of rawChunks) yield c;
                })(),
            }),
          );
        });
        res.on("error", (e) => {
          settle(() => reject(new SafeFetchError("network", urlStr, e.message)));
        });
      },
    );
    req.on("error", (e) => {
      const msg = e.message.includes("aborted") ? "annulé" : e.message;
      settle(() =>
        reject(
          e.name === "AbortError" || msg === "annulé"
            ? new SafeFetchError("timeout", urlStr, "annulé")
            : new SafeFetchError("network", urlStr, msg),
        ),
      );
    });
    req.end();
  });
}

// ─── Lecture du corps : décompression UNIQUE, plafonds réels ───────────────

export async function readBodyLimited(
  resp: TransportResponse,
  urlStr: string,
  limits: FetchLimits,
  deadline: number,
): Promise<{ bytes: number; text: string }> {
  const encoding = (resp.headers["content-encoding"] ?? "").toLowerCase();
  const raw: Uint8Array[] = [];

  if (typeof resp.body === "string") {
    raw.push(new TextEncoder().encode(resp.body));
  } else if (Array.isArray(resp.body)) {
    raw.push(...resp.body);
  } else {
    let rawSize = 0;
    for await (const chunk of resp.body()) {
      rawSize += chunk.length;
      if (rawSize > limits.maxBytes * 4) {
        throw new SafeFetchError("too-large", urlStr, `corps brut > ${rawSize} o`);
      }
      raw.push(chunk);
    }
  }

  const data = Buffer.concat(raw);

  let decoded: Buffer;
  if (encoding.includes("gzip")) {
    try {
      decoded = gunzipSync(data, { maxOutputLength: limits.maxBytes });
    } catch (e) {
      if ((e as Error).message?.includes("output length") || (e as RangeError).name === "RangeError") {
        throw new SafeFetchError("too-large", urlStr, "décompressé > plafond");
      }
      if ((e as { code?: string }).code === "Z_DATA_ERROR") {
        // serveur qui annonce gzip sans l'être : corps traité tel quel
        decoded = data;
      } else {
        throw new SafeFetchError("network", urlStr, `décompression: ${(e as Error).message}`);
      }
    }
  } else if (encoding.includes("deflate")) {
    try {
      decoded = inflateSync(data, { maxOutputLength: limits.maxBytes });
    } catch (e) {
      if ((e as Error).message?.includes("output length") || (e as RangeError).name === "RangeError") {
        throw new SafeFetchError("too-large", urlStr, "décompressé > plafond");
      }
      if ((e as { code?: string }).code === "Z_DATA_ERROR") {
        decoded = data;
      } else {
        throw new SafeFetchError("network", urlStr, `décompression: ${(e as Error).message}`);
      }
    }
  } else {
    decoded = data;
  }

  if (decoded.length > limits.maxBytes) {
    throw new SafeFetchError("too-large", urlStr, `${decoded.length} o décompressés > ${limits.maxBytes}`);
  }
  if (Date.now() > deadline) {
    throw new SafeFetchError("timeout", urlStr);
  }
  return { bytes: decoded.length, text: decoded.toString("utf-8") };
}

// ─── safeFetch ─────────────────────────────────────────────────────────────

export async function safeFetch(
  urlStr: string,
  opts: {
    limits?: Partial<FetchLimits>;
    deps?: TransportDeps;
    headers?: Record<string, string>;
    signal?: AbortSignal;
  } = {},
): Promise<SafeFetchResult> {
  const limits: FetchLimits = { ...DEFAULT_LIMITS, ...opts.limits };
  const deps = opts.deps ?? {};
  const deadline = Date.now() + limits.totalMs;
  const externalSignal = opts.signal;
  let current = urlStr;

  if (externalSignal?.aborted) {
    throw new SafeFetchError("timeout", urlStr, "annulé avant l'appel");
  }

  for (let hop = 0; hop <= limits.maxRedirects; hop++) {
    const url = validateTarget(current);
    // une seule résolution : elle est validée puis IMPOSÉE à la connexion
    const ips = await assertPublicHost(url.hostname, deps, current, deadline);
    if (Date.now() > deadline) throw new SafeFetchError("timeout", current);

    const remaining = deadline - Date.now();
    const inner = new AbortController();
    const timer = setTimeout(() => inner.abort(), Math.max(1, remaining));
    const merged = externalSignal
      ? AbortSignal.any([inner.signal, externalSignal])
      : inner.signal;
    // une annulation survenue PENDANT la résolution DNS doit empêcher
    // l'ouverture de la connexion (revue 3 P2)
    if (merged.aborted) {
      throw new SafeFetchError("timeout", current, "annulé pendant la résolution");
    }

    try {
      let resp: TransportResponse;
      if (deps.load) {
        resp = await deps.load(current, merged);
        if (Date.now() > deadline) throw new SafeFetchError("timeout", current);
      } else {
        // pinning : adresse IPv4 validée de préférence (lookup forcé family 4),
        // sinon la première IPv6 validée (family 6)
        const v4 = ips.find((ip) => {
          try { return ipaddr.parse(ip).kind() === "ipv4"; } catch { return false; }
        });
        const chosen = v4 ?? ips[0];
        const family = (() => {
          try { return ipaddr.parse(chosen).kind() === "ipv4" ? 4 : 6; } catch { return 4; }
        })();
        resp = await httpTransport(current, merged, {
          pin: { address: chosen, port: url.port ? Number(url.port) : isHttps(url) ? 443 : 80, family },
          // le délai TOTAL inclut la résolution DNS : le transport reçoit le
          // temps restant (revue 2 P2-5)
          limits: { ...limits, totalMs: Math.max(1, deadline - Date.now()) },
          headers: opts.headers,
        });
      }

      if (resp.status >= 300 && resp.status < 400) {
        const loc = resp.headers["location"];
        if (!loc) throw new SafeFetchError("network", current, "redirection sans Location");
        if (hop === limits.maxRedirects) {
          throw new SafeFetchError("too-many-redirects", current);
        }
        current = new URL(loc, current).toString();
        continue;
      }

      if (resp.status >= 400) {
        // revue « mesures » : distinguer refus d'accès (401/403/429 →
        // "blocked", JAMAIS relancé) des erreurs transitoires (5xx/408 →
        // "network", relançables) ; les autres 4xx sont définitifs ("http")
        const s = resp.status;
        const kind: SafeFetchErrorKind =
          s === 401 || s === 403 || s === 429
            ? "blocked"
            : s >= 500 || s === 408
              ? "network"
              : "http";
        throw new SafeFetchError(kind, current, `HTTP ${s}`, s);
      }

      const { bytes, text } = await readBodyLimited(resp, current, limits, deadline);
      return { status: resp.status, body: text, finalUrl: current, bytes };
    } catch (e) {
      if (e instanceof SafeFetchError) throw e;
      if ((e as Error).name === "AbortError" || (e as Error).name === "TimeoutError") {
        throw new SafeFetchError("timeout", current);
      }
      throw new SafeFetchError("network", current, (e as Error).message);
    } finally {
      clearTimeout(timer);
    }
  }
  throw new SafeFetchError("too-many-redirects", urlStr);
}

const isHttps = (url: URL) => url.protocol === "https:";

export interface SafeFetchResult {
  status: number;
  body: string;
  finalUrl: string;
  bytes: number;
}

// ─── Concurrence globale des téléchargements (3 max) ───────────────────────

let active = 0;
const queue: (() => void)[] = [];

/** Semaphore simple : max 3 téléchargements safeFetch simultanés. */
export async function withDownloadSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= 3) {
    await new Promise<void>((r) => queue.push(r));
  }
  active++;
  try {
    return await fn();
  } finally {
    active--;
    queue.shift()?.();
  }
}