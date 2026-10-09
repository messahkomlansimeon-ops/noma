/**
 * Relais de DÉVELOPPEMENT (reverse proxy de confiance minimal) : `npm run dev:proxy` ou, plus simplement, `npm run dev:try`.
 *
 * Pourquoi : la demande de code OTP (POST /api/auth/otp/request) exige les en-têtes d'un reverse proxy de confiance
 * (X-Noma-Proxy-Secret et X-Forwarded-For, voir AUTH-SERVER.md) ; un navigateur qui parle directement à `next dev` reçoit
 * 503. Ce relais joue ce rôle en local : il écoute sur 127.0.0.1 seulement, SUPPRIME toujours les deux en-têtes reçus du
 * client (jamais crus), puis écrit les siens (le secret lu dans l'environnement, et l'adresse de la connexion cliente).
 *
 * Garde-fous : refuse de démarrer si NODE_ENV n'est pas absent, vide ou « development » (production sous toutes ses graphies,
 * « prod », « test »… ; règle partagée avec `dev:try`, `resolveDevProxyConfig` ET `createDevProxy`) ou si
 * NOMA_DEV_PROXY n'est pas « 1 » ; n'écoute JAMAIS que 127.0.0.1 (aucune option pour changer cela) ; n'accepte qu'une cible
 * HTTP sur le poste local (le secret ne doit jamais partir vers une autre machine) ; n'écrit jamais le secret dans ses
 * messages. Supprime aussi en entrée `Forwarded`, `X-Real-IP`, `X-Forwarded-Host` et `X-Forwarded-Proto`. Aucune
 * dépendance (node:http et node:net seulement). Le corps des requêtes et des réponses est relayé EN CONTINU (le NDJSON de
 * /api/search arrive au fil de l'eau) ; la coupure du client est propagée à la cible, sans rien journaliser (ce n'est pas
 * une panne de la cible).
 *
 * N'EXPOSEZ JAMAIS ce relais (tunnel loca.lt, ngrok, redirection de port…) : toute personne qui l'atteint devient un
 * client de confiance pour l'authentification.
 *
 * Variables : NOMA_DEV_PROXY=1 (obligatoire), NOMA_AUTH_PROXY_SECRET (au moins 32 octets, le même que celui du serveur ;
 * repli : NOMA_PROXY_SECRET), NOMA_DEV_PROXY_PORT (défaut 3212), NOMA_DEV_PROXY_TARGET (défaut http://127.0.0.1:3211),
 * NOMA_DEV_PROXY_PUBLIC_ORIGIN (origine que voit le navigateur, sert à réécrire les `Location` ; défaut http://localhost:<port>).
 */
import http from "node:http";
import type { IncomingHttpHeaders, IncomingMessage, OutgoingHttpHeaders, ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const DEV_PROXY_HOST = "127.0.0.1";
export const DEV_PROXY_DEFAULT_PORT = 3212;
export const DEV_PROXY_DEFAULT_TARGET = "http://127.0.0.1:3211";
export const DEV_PROXY_MIN_SECRET_BYTES = 32;

/**
 * En-têtes reçus du client qui sont TOUJOURS supprimés. Le relais n'en réécrit que deux (`x-noma-proxy-secret` et
 * `x-forwarded-for`) ; les autres (Forwarded, X-Real-IP, X-Forwarded-Host, X-Forwarded-Proto) ne sont jamais crus ni relayés.
 */
const NEVER_FORWARDED = new Set([
  "x-noma-proxy-secret",
  "x-forwarded-for",
  "forwarded",
  "x-real-ip",
  "x-forwarded-host",
  "x-forwarded-proto",
]);
/** En-têtes « de saut » (RFC 9110 §7.6.1) : propres à chaque connexion, jamais relayés. */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const LOOPBACK_TARGET_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

export type DevProxyConfig =
  | { ok: true; port: number; target: string; secret: string; publicOrigin: string | undefined }
  | { ok: false; reason: string };

export type DevProxyEnvironment = Record<string, string | undefined>;

/**
 * Règle UNIQUE partagée par `dev:try` et le relais : NODE_ENV doit être absent, vide ou exactement « development » (après
 * suppression des espaces). Toute autre valeur (production sous toutes ses graphies, « prod », « test », « staging »…) est
 * refusée : rien de ce qui affiche un code de connexion ou fait confiance aux en-têtes ne démarre hors développement.
 * `received` est la valeur reçue (nettoyée, tronquée à 20 caractères) pour le message de refus.
 */
export function checkDevelopmentNodeEnv(value: string | undefined): { ok: true } | { ok: false; received: string } {
  const received = value?.trim();
  if (received === undefined || received === "" || received === "development") return { ok: true };
  return { ok: false, received: received.slice(0, 20) };
}

function nodeEnvRefusal(received: string): string {
  return `refus : NODE_ENV vaut « ${received} » : le relais de développement ne démarre que si NODE_ENV est absent, vide ou égal à « development ».`;
}

/** Contrôle l'environnement SANS rien démarrer ; les messages ne contiennent jamais le secret. */
export function resolveDevProxyConfig(env: DevProxyEnvironment): DevProxyConfig {
  const nodeEnv = checkDevelopmentNodeEnv(env.NODE_ENV);
  if (!nodeEnv.ok) return { ok: false, reason: nodeEnvRefusal(nodeEnv.received) };
  if (env.NOMA_DEV_PROXY !== "1") {
    return { ok: false, reason: "refus : NOMA_DEV_PROXY=1 est requis (ce relais est réservé au développement)." };
  }
  const secret = (env.NOMA_AUTH_PROXY_SECRET ?? env.NOMA_PROXY_SECRET ?? "").trim();
  if (Buffer.byteLength(secret, "utf8") < DEV_PROXY_MIN_SECRET_BYTES) {
    return {
      ok: false,
      reason: `refus : NOMA_AUTH_PROXY_SECRET doit contenir au moins ${DEV_PROXY_MIN_SECRET_BYTES} octets.`,
    };
  }
  const rawPort = env.NOMA_DEV_PROXY_PORT?.trim();
  const port = rawPort === undefined || rawPort === "" ? DEV_PROXY_DEFAULT_PORT : Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    return { ok: false, reason: "refus : NOMA_DEV_PROXY_PORT doit être un entier de 1 à 65535." };
  }
  const target = (env.NOMA_DEV_PROXY_TARGET?.trim() || DEV_PROXY_DEFAULT_TARGET).replace(/\/+$/, "");
  const checked = checkTarget(target);
  if (!checked.ok) return { ok: false, reason: checked.reason };
  const rawPublic = env.NOMA_DEV_PROXY_PUBLIC_ORIGIN?.trim();
  let publicOrigin: string | undefined;
  if (rawPublic) {
    const publicChecked = checkPublicOrigin(rawPublic);
    if (!publicChecked.ok) return { ok: false, reason: publicChecked.reason };
    publicOrigin = publicChecked.origin;
  }
  return { ok: true, port, target, secret, publicOrigin };
}

/** Origine publique du relais (celle du navigateur) : http:// de ce poste, sans identifiants, chemin ni paramètres. */
function checkPublicOrigin(value: string): { ok: true; origin: string } | { ok: false; reason: string } {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, reason: "refus : NOMA_DEV_PROXY_PUBLIC_ORIGIN n'est pas une adresse valide." };
  }
  if (
    url.protocol !== "http:" ||
    !LOOPBACK_TARGET_HOSTS.has(url.hostname) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    return {
      ok: false,
      reason: "refus : l'origine publique doit être une adresse http:// de ce poste (127.0.0.1 ou localhost), sans chemin ni paramètres.",
    };
  }
  return { ok: true, origin: url.origin };
}
function checkTarget(target: string): { ok: true; url: URL } | { ok: false; reason: string } {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return { ok: false, reason: "refus : NOMA_DEV_PROXY_TARGET n'est pas une adresse valide." };
  }
  if (url.protocol !== "http:" || !LOOPBACK_TARGET_HOSTS.has(url.hostname) || url.username || url.password) {
    return {
      ok: false,
      reason: "refus : la cible doit être une adresse http:// de ce poste (127.0.0.1 ou localhost) : le secret ne part jamais ailleurs.",
    };
  }
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    return { ok: false, reason: "refus : la cible ne doit contenir ni chemin ni paramètres." };
  }
  return { ok: true, url };
}

export interface DevProxyOptions {
  /** Origine de la cible (http://127.0.0.1:3211). */
  target: string;
  /** Secret écrit dans X-Noma-Proxy-Secret (au moins 32 octets). */
  secret: string;
  /** Port d'écoute (0 = choisi par le système, pour les tests). Le port seul se choisit : jamais l'adresse. */
  port?: number;
  /** Journal ; ne reçoit JAMAIS le secret. Défaut : console.log préfixé. */
  log?: (line: string) => void;
  /**
   * Origine que voit le navigateur (http://localhost:3212) : sert UNIQUEMENT à réécrire les `Location` qui désignent la cible.
   * Jamais déduite de l'en-tête Host fourni par le client. Défaut : http://localhost:<port d'écoute>.
   */
  publicOrigin?: string;
}

export interface DevProxy {
  readonly server: http.Server;
  listen(): Promise<AddressInfo>;
  close(): Promise<void>;
}

function clientAddress(socket: Socket): string {
  const raw = socket.remoteAddress ?? "";
  return raw.startsWith("::ffff:") ? raw.slice(7) : raw;
}

/** Jetons d'un en-tête Connection : chacun désigne un en-tête de saut supplémentaire. */
function connectionTokens(headers: IncomingHttpHeaders): Set<string> {
  const value = headers.connection;
  const text = Array.isArray(value) ? value.join(",") : (value ?? "");
  return new Set(text.split(",").map((token) => token.trim().toLowerCase()).filter(Boolean));
}

function safeErrorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[A-Z0-9_]{1,40}$/.test(code) ? code : "erreur";
}

export function createDevProxy(options: DevProxyOptions): DevProxy {
  // Défense en profondeur : même appelé directement (sans passer par resolveDevProxyConfig), la même règle s'applique.
  const nodeEnv = checkDevelopmentNodeEnv(process.env.NODE_ENV);
  if (!nodeEnv.ok) throw new Error(nodeEnvRefusal(nodeEnv.received));
  const checked = checkTarget(options.target.replace(/\/+$/, ""));
  if (!checked.ok) throw new Error(checked.reason);
  if (Buffer.byteLength(options.secret, "utf8") < DEV_PROXY_MIN_SECRET_BYTES) {
    throw new Error(`le secret doit contenir au moins ${DEV_PROXY_MIN_SECRET_BYTES} octets.`);
  }
  let publicOrigin: string | null = null;
  if (options.publicOrigin !== undefined) {
    const publicChecked = checkPublicOrigin(options.publicOrigin);
    if (!publicChecked.ok) throw new Error(publicChecked.reason);
    publicOrigin = publicChecked.origin;
  }
  const target = checked.url;
  const secret = options.secret;
  const log = options.log ?? ((line: string) => console.log(`[dev-proxy] ${line}`));
  const agent = new http.Agent({ keepAlive: false });
  const targetHost = target.host;
  const targetPort = Number(target.port || 80);
  const targetHostname = target.hostname.replace(/^\[|\]$/g, "");
  const sockets = new Set<Socket>();
  /** Formes sous lesquelles la cible peut s'écrire elle-même dans un `Location` (Next écrit volontiers « localhost »). */
  const targetOrigins = [
    ...new Set([target.origin, `http://localhost:${targetPort}`, `http://127.0.0.1:${targetPort}`, `http://[::1]:${targetPort}`]),
  ];

  /** En-têtes à envoyer à la cible : ceux du client, sans les deux en-têtes de confiance, puis les nôtres. */
  function requestHeaders(req: IncomingMessage, keepUpgrade: boolean): OutgoingHttpHeaders {
    const extraHopByHop = connectionTokens(req.headers);
    const headers: OutgoingHttpHeaders = {};
    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined) continue;
      if (NEVER_FORWARDED.has(name) || name === "host" || name === "expect") continue;
      // Mise à niveau (WebSocket) : Connection et Upgrade sont gardés, les autres en-têtes de saut sont retirés.
      const keptForUpgrade = keepUpgrade && (name === "connection" || name === "upgrade");
      if (!keptForUpgrade && (HOP_BY_HOP.has(name) || extraHopByHop.has(name))) continue;
      headers[name] = value;
    }
    headers.host = targetHost;
    headers["x-noma-proxy-secret"] = secret;
    headers["x-forwarded-for"] = clientAddress(req.socket);
    return headers;
  }

  function sendBadGateway(res: ServerResponse): void {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    const body = JSON.stringify({
      error: {
        code: "dev_proxy_unreachable",
        message: "Le serveur de l'application ne répond pas (relais de développement).",
      },
    });
    res.writeHead(502, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(body),
      "cache-control": "no-store",
    });
    res.end(body);
  }

  /**
   * Un `Location` qui désigne la cible elle-même (origine exacte suivie de « / », « ? », « # » ou de rien) revient vers l'origine
   * PUBLIQUE configurée du relais ; tout autre (relatif, autre hôte, autre port) est laissé tel quel.
   */
  function rewriteLocation(value: string): string {
    if (publicOrigin === null) return value;
    for (const origin of targetOrigins) {
      if (value === origin) return publicOrigin;
      if (value.startsWith(origin) && "/?#".includes(value.charAt(origin.length))) return `${publicOrigin}${value.slice(origin.length)}`;
    }
    return value;
  }

  /** Liste plate [nom, valeur, …] des en-têtes de la réponse, sans les en-têtes de saut ; Location vers la cible → vers le relais. */
  function responseHeaders(upstream: IncomingMessage): string[] {
    const list = relayedResponseHeaders(upstream);
    // Lot T3 : après une 408 (corps de requête lu trop lentement, donc ni lu en entier ni vidé), la connexion du CLIENT est fermée aussi : « Connection » est un en-tête de saut, le relais le pose lui-même.
    if (upstream.statusCode === 408) list.push("Connection", "close");
    return list;
  }

  function relayedResponseHeaders(upstream: IncomingMessage): string[] {
    const extraHopByHop = connectionTokens(upstream.headers);
    const list: string[] = [];
    for (let index = 0; index + 1 < upstream.rawHeaders.length; index += 2) {
      const name = upstream.rawHeaders[index];
      let value = upstream.rawHeaders[index + 1];
      const lower = name.toLowerCase();
      if (HOP_BY_HOP.has(lower) || extraHopByHop.has(lower)) continue;
      if (lower === "location") value = rewriteLocation(value);
      list.push(name, value);
    }
    return list;
  }

  const server = http.createServer((req, res) => {
    const proxyReq = http.request({
      host: targetHostname,
      port: targetPort,
      method: req.method,
      path: req.url,
      headers: requestHeaders(req, false),
      agent,
    });
    let upstream: IncomingMessage | undefined;
    // Le client a abandonné : couper la cible provoque une erreur de CETTE requête (ECONNRESET), qui n'est pas une panne de la cible.
    let clientGone = false;
    const abortUpstream = () => {
      clientGone = true;
      proxyReq.destroy();
      upstream?.destroy();
    };
    // Le client s'en va avant la fin de la réponse (onglet fermé, connexion coupée) : la cible est coupée aussi.
    res.on("close", () => {
      if (!res.writableFinished) abortUpstream();
    });
    req.on("error", abortUpstream);

    proxyReq.on("response", (proxyRes) => {
      upstream = proxyRes;
      res.writeHead(proxyRes.statusCode ?? 502, proxyRes.statusMessage, responseHeaders(proxyRes));
      res.flushHeaders();
      proxyRes.pipe(res);
      proxyRes.on("error", () => res.destroy());
      // La cible coupe avant la fin de sa réponse : le client doit le voir (pas de réponse tronquée présentée comme complète).
      proxyRes.on("close", () => {
        if (!proxyRes.complete) res.destroy();
      });
    });
    proxyReq.on("error", (error) => {
      // Abandon du client : rien à journaliser ni à répondre (la connexion cliente est déjà fermée).
      if (clientGone) return;
      if (!res.headersSent) log(`cible injoignable (${safeErrorCode(error)}).`);
      sendBadGateway(res);
    });
    req.pipe(proxyReq);
  });

  // Les connexions WebSocket (rechargement à chaud de next dev) passent par la même politique d'en-têtes.
  server.on("upgrade", (req: IncomingMessage, socket: Socket, head: Buffer) => {
    const proxyReq = http.request({
      host: targetHostname,
      port: targetPort,
      method: req.method,
      path: req.url,
      headers: requestHeaders(req, true),
      agent,
    });
    const closeBoth = (other?: Socket) => {
      socket.destroy();
      other?.destroy();
    };
    proxyReq.on("upgrade", (proxyRes, proxySocket, proxyHead) => {
      const lines = [`HTTP/1.1 ${proxyRes.statusCode ?? 101} ${proxyRes.statusMessage ?? "Switching Protocols"}`];
      for (let index = 0; index + 1 < proxyRes.rawHeaders.length; index += 2) {
        lines.push(`${proxyRes.rawHeaders[index]}: ${proxyRes.rawHeaders[index + 1]}`);
      }
      socket.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (proxyHead.length > 0) socket.write(proxyHead);
      if (head.length > 0) proxySocket.write(head);
      proxySocket.pipe(socket);
      socket.pipe(proxySocket);
      socket.on("error", () => closeBoth(proxySocket));
      proxySocket.on("error", () => closeBoth(proxySocket));
      socket.on("close", () => proxySocket.destroy());
      proxySocket.on("close", () => socket.destroy());
    });
    proxyReq.on("response", (proxyRes) => {
      // La cible refuse la mise à niveau : réponse ordinaire, sans corps relayé.
      socket.end(`HTTP/1.1 ${proxyRes.statusCode ?? 502} ${proxyRes.statusMessage ?? ""}\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`);
      proxyRes.resume();
    });
    proxyReq.on("error", () => closeBoth());
    socket.on("error", () => proxyReq.destroy());
    socket.on("close", () => proxyReq.destroy());
    proxyReq.end();
  });

  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.on("clientError", (_error, socket) => {
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nconnection: close\r\ncontent-length: 0\r\n\r\n");
    else socket.destroy();
  });

  return {
    server,
    listen() {
      return new Promise<AddressInfo>((resolveListen, rejectListen) => {
        server.once("error", rejectListen);
        // Adresse figée : le relais ne peut écouter que sur la boucle locale IPv4.
        server.listen(options.port ?? DEV_PROXY_DEFAULT_PORT, DEV_PROXY_HOST, () => {
          server.off("error", rejectListen);
          const address = server.address() as AddressInfo;
          publicOrigin ??= `http://localhost:${address.port}`;
          resolveListen(address);
        });
      });
    },
    close() {
      return new Promise<void>((resolveClose) => {
        server.close(() => {
          agent.destroy();
          resolveClose();
        });
        for (const socket of sockets) socket.destroy();
      });
    },
  };
}

async function main(): Promise<void> {
  const config = resolveDevProxyConfig(process.env);
  if (!config.ok) {
    console.error(`[dev-proxy] ${config.reason}`);
    process.exitCode = 1;
    return;
  }
  const proxy = createDevProxy({
    target: config.target,
    secret: config.secret,
    port: config.port,
    ...(config.publicOrigin ? { publicOrigin: config.publicOrigin } : {}),
  });
  let address: AddressInfo;
  try {
    address = await proxy.listen();
  } catch (error) {
    console.error(`[dev-proxy] impossible d'écouter sur le port ${config.port} (${safeErrorCode(error)}).`);
    process.exitCode = 1;
    return;
  }
  console.log(`[dev-proxy] écoute sur http://${address.address}:${address.port} et relaie vers ${config.target}.`);
  const stop = () => {
    void proxy.close().then(() => process.exit(0));
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

// Exécution directe seulement (les tests importent ce module sans rien démarrer).
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main();
}
