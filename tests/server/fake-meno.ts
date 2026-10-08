import { appendFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";

/**
 * FAUX serveur Meno, local (lot SMS1). Il tient la place du fournisseur dans TOUS les essais : aucun appel réel, aucune vraie clé. Il applique les règles documentées de l'API :
 *  - POST /send : Authorization: Bearer <clé attendue> (sinon 401), Idempotency-Key de 8 à 64 caractères [A-Za-z0-9._-] (sinon 422), corps {"to","content"} ;
 *  - première fois pour une clé : 202 {"id","status":"accepted"} ; même clé et même corps : {"id","status",replay:true} SANS nouvel envoi ; même clé avec un autre
 *    destinataire ou un autre texte : 409 ;
 *  - GET /usage : consommation du mois.
 * Les comportements anormaux se programment par `queue(...)` (consommés dans l'ordre, un par requête POST /send) : statut HTTP quelconque, 429 avec Retry-After, statut
 * `unknown`/`reserved`, coupure de la connexion avant réponse, silence (délai dépassé), réponse lente.
 * `captureFile` (essais navigateur) : une ligne JSON {at,to,content} par message ACCEPTÉ pour la première fois. Elle contient le texte (donc le code OTP) : fichier d'essai seulement.
 */

export type FakeMenoBehavior =
  | { kind: "accept" }
  | { kind: "status"; status: number; body?: unknown; headers?: Record<string, string>; rawBody?: string }
  | { kind: "reply-status"; reportedStatus: string; httpStatus?: number }
  | { kind: "drop" }
  | { kind: "hang" }
  | { kind: "delay"; ms: number; then?: FakeMenoBehavior };

export interface FakeMenoRequest {
  method: string;
  path: string;
  /** Copie des en-têtes reçus. Contient l'autorisation : n'est lue que par les essais (jamais écrite dans un fichier). */
  headers: Record<string, string | string[] | undefined>;
  body: string;
  receivedAt: number;
}

export interface FakeMenoOptions {
  apiKey: string;
  captureFile?: string;
  usage?: Record<string, unknown>;
}

interface StoredSend {
  id: string;
  to: string;
  content: string;
  status: string;
}

export interface FakeMeno {
  /** Base de l'API (sans « / » final) à donner à NOMA_SMS_BASE_URL. */
  readonly baseUrl: string;
  readonly requests: FakeMenoRequest[];
  /** Envois acceptés pour la première fois, dans l'ordre (le texte est lisible : essais seulement). */
  readonly messages: Array<{ key: string; id: string; to: string; content: string }>;
  queue(...behaviors: Array<FakeMenoBehavior | ((request: FakeMenoRequest) => FakeMenoBehavior)>): void;
  setUsage(usage: Record<string, unknown> | FakeMenoBehavior): void;
  sendRequests(): FakeMenoRequest[];
  usageRequests(): FakeMenoRequest[];
  reset(): void;
  close(): Promise<void>;
}

const KEY_FORMAT = /^[A-Za-z0-9._-]{8,64}$/;

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function json(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text), ...headers });
  response.end(text);
}

export async function startFakeMeno(options: FakeMenoOptions): Promise<FakeMeno> {
  const requests: FakeMenoRequest[] = [];
  const messages: FakeMeno["messages"] = [];
  const stored = new Map<string, StoredSend>();
  const queued: Array<FakeMenoBehavior | ((request: FakeMenoRequest) => FakeMenoBehavior)> = [];
  const sockets = new Set<Socket>();
  const hanging = new Set<ServerResponse>();
  let usageBehavior: Record<string, unknown> | FakeMenoBehavior = options.usage ?? {
    accepted: 12,
    uncertain: 1,
    rejected: 2,
    accepted_amount_xof: 180,
    unit_price_xof: 15,
    currency: "XOF",
  };
  let sequence = 0;

  function acceptDefault(request: FakeMenoRequest, response: ServerResponse): void {
    const key = String(request.headers["idempotency-key"] ?? "");
    let parsed: { to?: unknown; content?: unknown };
    try {
      parsed = JSON.parse(request.body) as { to?: unknown; content?: unknown };
    } catch {
      json(response, 422, { error: "invalid_body" });
      return;
    }
    if (typeof parsed.to !== "string" || typeof parsed.content !== "string" || !/^\+225[0-9]{10}$/.test(parsed.to)) {
      json(response, 422, { error: "invalid_recipient_or_content" });
      return;
    }
    const known = stored.get(key);
    if (known) {
      if (known.to !== parsed.to || known.content !== parsed.content) {
        json(response, 409, { error: "idempotency_key_reused" });
        return;
      }
      json(response, 202, { id: known.id, status: known.status, replay: true });
      return;
    }
    sequence += 1;
    const entry: StoredSend = { id: `msg_${String(sequence).padStart(6, "0")}`, to: parsed.to, content: parsed.content, status: "accepted" };
    stored.set(key, entry);
    messages.push({ key, id: entry.id, to: entry.to, content: entry.content });
    if (options.captureFile) appendFileSync(options.captureFile, `${JSON.stringify({ at: new Date().toISOString(), to: entry.to, content: entry.content })}\n`);
    json(response, 202, { id: entry.id, status: "accepted" });
  }

  function perform(behavior: FakeMenoBehavior, request: FakeMenoRequest, incoming: IncomingMessage, response: ServerResponse): void {
    switch (behavior.kind) {
      case "accept":
        acceptDefault(request, response);
        return;
      case "status":
        if (behavior.rawBody !== undefined) {
          response.writeHead(behavior.status, { "content-type": "application/json", ...behavior.headers });
          response.end(behavior.rawBody);
        } else {
          json(response, behavior.status, behavior.body ?? {}, behavior.headers);
        }
        return;
      case "reply-status": {
        const key = String(request.headers["idempotency-key"] ?? "");
        let parsed: { to?: string; content?: string } = {};
        try {
          parsed = JSON.parse(request.body) as { to?: string; content?: string };
        } catch {
          // corps illisible : réponse programmée quand même
        }
        sequence += 1;
        const id = `msg_${String(sequence).padStart(6, "0")}`;
        stored.set(key, { id, to: parsed.to ?? "", content: parsed.content ?? "", status: behavior.reportedStatus });
        // Le message est peut-être parti : l'essai peut lire son texte (le code OTP) pour montrer que le défi reste valable.
        messages.push({ key, id, to: parsed.to ?? "", content: parsed.content ?? "" });
        json(response, behavior.httpStatus ?? 202, { id, status: behavior.reportedStatus });
        return;
      }
      case "drop":
        incoming.socket.destroy();
        return;
      case "hang":
        hanging.add(response);
        return;
      case "delay":
        setTimeout(() => perform(behavior.then ?? { kind: "accept" }, request, incoming, response), behavior.ms);
        return;
    }
  }

  const server: Server = createServer((incoming, response) => {
    void (async () => {
      const body = await readBody(incoming);
      const request: FakeMenoRequest = {
        method: incoming.method ?? "",
        path: (incoming.url ?? "").split("?")[0],
        headers: { ...incoming.headers },
        body,
        receivedAt: Date.now(),
      };
      requests.push(request);
      if (incoming.headers.authorization !== `Bearer ${options.apiKey}`) {
        json(response, 401, { error: "invalid_api_key" });
        return;
      }
      if (request.method === "GET" && request.path === "/usage") {
        if ("kind" in usageBehavior) perform(usageBehavior as FakeMenoBehavior, request, incoming, response);
        else json(response, 200, usageBehavior);
        return;
      }
      if (request.method !== "POST" || request.path !== "/send") {
        json(response, 404, { error: "not_found" });
        return;
      }
      if (!KEY_FORMAT.test(String(incoming.headers["idempotency-key"] ?? ""))) {
        json(response, 422, { error: "invalid_idempotency_key" });
        return;
      }
      const next = queued.shift();
      const behavior = typeof next === "function" ? next(request) : (next ?? { kind: "accept" as const });
      perform(behavior, request, incoming, response);
    })();
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    messages,
    queue: (...behaviors) => {
      queued.push(...behaviors);
    },
    setUsage: (usage) => {
      usageBehavior = usage;
    },
    sendRequests: () => requests.filter((request) => request.method === "POST" && request.path === "/send"),
    usageRequests: () => requests.filter((request) => request.method === "GET" && request.path === "/usage"),
    reset: () => {
      requests.length = 0;
      messages.length = 0;
      stored.clear();
      queued.length = 0;
      sequence = 0;
    },
    close: async () => {
      for (const response of hanging) response.destroy();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
