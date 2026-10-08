import { createHmac, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * FAUSSE API Sublymus LOCALE (lot PAY1) : sert les essais et l'essai navigateur de noma. Il n'existe AUCUN bac à sable chez Sublymus : la création d'une session de paiement
 * ouvre une VRAIE session Wave. Tout essai passe donc par ce serveur (boucle locale uniquement) et par des webhooks synthétiques signés avec un secret de TEST inventé.
 * Aucune vraie clé n'est jamais lue ici. Contrat imité : `POST /v1/checkout/complex`, `GET /v1/intents?external_reference=` (recherche PARTIELLE : les références voisines sont
 * renvoyées avec la bonne), `GET /v1/wallets/main` et le solde ; réponses 401, 409, 422, 500 et délai dépassé à la demande.
 */

export interface FakeIntent {
  id: string;
  externalReference: string;
  payerId: string;
  amount: number;
  currency: string;
  sourceSystem: string;
  status: "WAVE_CREATED" | "COMPLETED" | "FAILED";
  waveCheckoutUrl: string;
  successUrl: string;
  errorUrl: string;
}

export type FakeMode = "ok" | "unauthorized" | "conflict" | "unprocessable" | "server_error" | "delay" | "bad_body";

export interface FakeRequestLog {
  method: string;
  path: string;
  authorization: string | null;
  managerId: string | null;
  body: unknown;
}

export interface FakeSublymusOptions {
  apiKey: string;
  managerId: string;
  walletId: string;
  /** Port d'écoute (0 : un port libre). */
  port?: number;
  /** Les adresses de retour doivent être en https (contrat). Faux pour l'essai navigateur, dont l'adresse publique est locale. */
  requireHttpsUrls?: boolean;
  /** Une reprise avec la même référence ET le même montant renvoie la même session (défaut vrai). Faux : une seconde session (cas dégradé). */
  reuseSession?: boolean;
  /** Début des liens de paiement renvoyés (défaut : https://pay.wave.example/c ; les essais de PRODUCTION mettent https://pay.wave.com/c, domaine Wave attendu). */
  checkoutLinkBase?: string;
}

export interface FakeSublymusApi {
  readonly url: string;
  readonly port: number;
  readonly intents: Map<string, FakeIntent>;
  readonly requests: FakeRequestLog[];
  /** Comportement des PROCHAINES routes /v1/* : `ok` par défaut ; `times` : nombre de réponses (défaut : toutes). */
  setMode(mode: FakeMode, options?: { times?: number; delayMs?: number }): void;
  /** Ajoute une intention d'un voisin (référence proche, sert à tester la recherche partielle). */
  seed(intent: Partial<FakeIntent> & { externalReference: string; amount: number }): FakeIntent;
  setStatus(id: string, status: FakeIntent["status"]): void;
  /** Corps JSON et en-têtes d'un webhook SIGNÉ avec `secret` pour l'intention (le corps est sérialisé UNE fois : la signature porte sur ces octets). */
  webhook(input: { intent: FakeIntent; event?: "payment.completed" | "payment.failed"; secret: string; managerId?: string; webhookId?: string; data?: Record<string, unknown>; status?: string }): { body: string; headers: Record<string, string> };
  close(): Promise<void>;
}

const sign = (secret: string, body: string): string => createHmac("sha256", secret).update(body).digest("hex");

function json(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  response.end(text);
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

export async function startFakeSublymusApi(options: FakeSublymusOptions): Promise<FakeSublymusApi> {
  const intents = new Map<string, FakeIntent>();
  const requests: FakeRequestLog[] = [];
  const requireHttps = options.requireHttpsUrls !== false;
  const reuse = options.reuseSession !== false;
  const linkBase = options.checkoutLinkBase ?? "https://pay.wave.example/c";
  let mode: FakeMode = "ok";
  let remaining = Number.POSITIVE_INFINITY;
  let delayMs = 0;

  const isHttps = (value: unknown): boolean => {
    if (typeof value !== "string") return false;
    try {
      const url = new URL(value);
      return url.protocol === "https:" || (!requireHttps && url.protocol === "http:");
    } catch {
      return false;
    }
  };

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const raw = request.method === "POST" ? await readBody(request) : "";
    let body: unknown = null;
    try {
      body = raw === "" ? null : JSON.parse(raw);
    } catch {
      body = "(illisible)";
    }
    requests.push({
      method: request.method ?? "?", path: `${url.pathname}${url.search}`, authorization: request.headers.authorization ?? null,
      managerId: typeof request.headers["x-manager-id"] === "string" ? request.headers["x-manager-id"] : null, body,
    });
    if (!url.pathname.startsWith("/v1/")) return json(response, 404, { error: "not_found" });
    const authorized = request.headers.authorization === `Bearer ${options.apiKey}` && request.headers["x-manager-id"] === options.managerId;
    if (!authorized) return json(response, 401, { error: "unauthorized" });

    let effective: FakeMode = "ok";
    if (mode !== "ok" && remaining > 0) {
      effective = mode;
      remaining -= 1;
    }
    if (effective === "unauthorized") return json(response, 401, { error: "unauthorized" });
    if (effective === "conflict") return json(response, 409, { error: "conflict" });
    if (effective === "unprocessable") return json(response, 422, { error: "unprocessable" });
    if (effective === "server_error") return json(response, 500, { error: "server_error" });
    if (effective === "delay") await new Promise((resolve) => setTimeout(resolve, delayMs));
    if (effective === "bad_body") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{ ceci n'est pas du json");
      return;
    }

    if (request.method === "POST" && url.pathname === "/v1/checkout/complex") {
      const input = body as Record<string, unknown> | null;
      const splits = input && Array.isArray(input.splits) ? (input.splits as Array<Record<string, unknown>>) : null;
      const valid =
        input !== null && typeof input === "object" && Number.isSafeInteger(input.amount) && (input.amount as number) >= 1 && input.currency === "XOF" &&
        typeof input.external_reference === "string" && input.external_reference.length > 0 && input.source_system === "NOMA" && typeof input.description === "string" &&
        isHttps(input.success_url) && isHttps(input.error_url) && splits !== null && splits.length >= 1 &&
        splits.every((split) => split.wallet_id === options.walletId && Number.isSafeInteger(split.amount) && split.category === "PAYMENT" && typeof split.label === "string" && split.release_delay_hours === 0) &&
        splits.reduce((sum, split) => sum + (split.amount as number), 0) === input.amount;
      if (!valid || input === null) return json(response, 422, { error: "invalid_checkout" });
      const reference = input.external_reference as string;
      const existing = [...intents.values()].find((entry) => entry.externalReference === reference);
      if (existing && existing.amount !== input.amount) return json(response, 409, { error: "reference_reused_with_another_amount" });
      if (existing && reuse) {
        return json(response, 201, { data: { payment_intent_id: existing.id, status: "WAVE_CREATED", wave_checkout_url: existing.waveCheckoutUrl, amount: existing.amount, currency: "XOF", external_reference: reference } });
      }
      const id = `pi_${randomBytes(8).toString("hex")}`;
      const intent: FakeIntent = {
        id, externalReference: reference, payerId: options.managerId, amount: input.amount as number, currency: "XOF", sourceSystem: "NOMA", status: "WAVE_CREATED",
        waveCheckoutUrl: `${linkBase}/${id}`, successUrl: input.success_url as string, errorUrl: input.error_url as string,
      };
      intents.set(id, intent);
      return json(response, 201, { data: { payment_intent_id: id, status: "WAVE_CREATED", wave_checkout_url: intent.waveCheckoutUrl, amount: intent.amount, currency: "XOF", external_reference: reference } });
    }
    if (request.method === "GET" && url.pathname === "/v1/intents") {
      const query = url.searchParams.get("external_reference") ?? "";
      // Recherche PARTIELLE : toute référence qui CONTIENT la valeur (les voisines reviennent avec la bonne).
      const found = [...intents.values()].filter((entry) => entry.externalReference.includes(query));
      return json(response, 200, {
        data: found.map((entry) => ({
          id: entry.id, externalReference: entry.externalReference, payerId: entry.payerId, amount: entry.amount, currency: entry.currency, sourceSystem: entry.sourceSystem,
          status: entry.status, waveCheckoutUrl: entry.waveCheckoutUrl,
        })),
      });
    }
    if (request.method === "GET" && url.pathname === "/v1/wallets/main") return json(response, 200, { data: { id: options.walletId, name: "Portefeuille de test", balance: 12345 } });
    if (request.method === "GET" && url.pathname === `/v1/wallets/${options.walletId}/balance`) return json(response, 200, { data: { balance: 12345 } });
    return json(response, 404, { error: "not_found" });
  }

  const server: Server = createServer((request, response) => {
    void handle(request, response).catch(() => {
      if (!response.headersSent) json(response, 500, { error: "fake_api_failure" });
      else response.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", resolve);
  });
  const port = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    intents,
    requests,
    setMode(next, modeOptions = {}) {
      mode = next;
      remaining = modeOptions.times ?? Number.POSITIVE_INFINITY;
      delayMs = modeOptions.delayMs ?? 0;
    },
    seed(partial) {
      const id = partial.id ?? `pi_${randomBytes(8).toString("hex")}`;
      const intent: FakeIntent = {
        id, externalReference: partial.externalReference, payerId: partial.payerId ?? options.managerId, amount: partial.amount, currency: partial.currency ?? "XOF",
        sourceSystem: partial.sourceSystem ?? "NOMA", status: partial.status ?? "WAVE_CREATED", waveCheckoutUrl: partial.waveCheckoutUrl ?? `${linkBase}/${id}`,
        successUrl: partial.successUrl ?? "https://noma.test/ok", errorUrl: partial.errorUrl ?? "https://noma.test/ko",
      };
      intents.set(id, intent);
      return intent;
    },
    setStatus(id, status) {
      const intent = intents.get(id);
      if (!intent) throw new Error("intention inconnue");
      intent.status = status;
    },
    webhook({ intent, event = "payment.completed", secret, managerId = options.managerId, webhookId, data = {}, status }) {
      const body = JSON.stringify({
        event,
        data: {
          id: intent.id, externalReference: intent.externalReference, payerId: intent.payerId, amount: intent.amount, currency: intent.currency, sourceSystem: intent.sourceSystem,
          status: status ?? (event === "payment.completed" ? "COMPLETED" : "FAILED"), ...data,
        },
        timestamp: new Date().toISOString(),
      });
      return {
        body,
        headers: {
          "content-type": "application/json",
          "x-wave-signature": sign(secret, body),
          "x-wave-event": event,
          "x-manager-id": managerId,
          "x-webhook-id": webhookId ?? `wh_${randomBytes(8).toString("hex")}`,
        },
      };
    },
    close: () => new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    }),
  };
}
