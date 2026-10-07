import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { after, before, test } from "node:test";
import type { MessageBus, MessageEvent, MessageHandler } from "../../lib/server/social/message-bus";
import { createStreamRegistry, openMessageStream } from "../../lib/server/social/stream";
import { createDevProxy, type DevProxy } from "../../scripts/dev-proxy";

/**
 * Le flux en direct (lot D2) à travers le relais de `dev:try` : le relais ne doit pas mettre le flux en tampon. Le serveur d'application est simulé par un serveur HTTP qui sert la
 * VRAIE réponse de `openMessageStream` (le même code que la route `GET /api/conversations/{id}/stream`), avec un bus en mémoire. Vérifie : l'en-tête et le premier événement
 * arrivent tout de suite (flux ouvert, réponse non terminée), un événement émis plus tard arrive en quelques dizaines de millisecondes, les battements continuent, les en-têtes
 * de flux passent, et la coupure du client se propage à la cible (aucun écouteur, aucune place ne reste).
 */

const SECRET = "secret-de-test-du-relais-0123456789abcdef";
const CONVERSATION = "0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b";
delete (process.env as Record<string, string | undefined>).NODE_ENV;

function memoryBus(): MessageBus & { emit(event: MessageEvent): void } {
  const handlers = new Set<MessageHandler>();
  return {
    subscribe(_conversationId, handler) {
      handlers.add(handler);
      return { ready: Promise.resolve(), unsubscribe: () => void handlers.delete(handler) };
    },
    listenerCount: () => handlers.size,
    connectionCount: () => (handlers.size > 0 ? 1 : 0),
    close: async () => {},
    emit(event) {
      for (const handler of [...handlers]) handler(event);
    },
  };
}

const bus = memoryBus();
const registry = createStreamRegistry();
let upstream: http.Server;
let proxy: DevProxy;
let proxyPort = 0;
let upstreamClosed = 0;
let userCounter = "utilisateur";

before(async () => {
  upstream = http.createServer((req, res) => {
    const controller = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) {
        upstreamClosed += 1;
        controller.abort();
      }
    });
    const response = openMessageStream({ bus, registry, userId: userCounter, conversationId: CONVERSATION, signal: controller.signal, heartbeatMs: 60 });
    res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
    res.flushHeaders();
    Readable.fromWeb(response.body as never).pipe(res);
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  proxy = createDevProxy({ target: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`, secret: SECRET, port: 0 });
  proxyPort = (await proxy.listen()).port;
});

after(async () => {
  await proxy?.close().catch(() => {});
  await new Promise<void>((resolve) => { upstream.closeAllConnections(); upstream.close(() => resolve()); });
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface Client {
  response: http.IncomingMessage;
  text(): string;
  waitFor(pattern: RegExp, timeoutMs: number): Promise<number>;
  destroy(): void;
  ended(): boolean;
}

function connect(): Promise<Client> {
  return new Promise((resolve, reject) => {
    const request = http.get({ host: "127.0.0.1", port: proxyPort, path: `/api/conversations/${CONVERSATION}/stream`, agent: false }, (response) => {
      let body = "";
      let ended = false;
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => { body += chunk; });
      response.on("end", () => { ended = true; });
      response.on("close", () => { ended = true; });
      resolve({
        response,
        text: () => body,
        ended: () => ended,
        destroy: () => request.destroy(),
        async waitFor(pattern, timeoutMs) {
          const started = Date.now();
          while (!pattern.test(body)) {
            if (Date.now() - started > timeoutMs) throw new Error(`motif ${pattern} absent après ${timeoutMs} ms ; reçu : ${JSON.stringify(body)}`);
            await sleep(5);
          }
          return Date.now() - started;
        },
      });
    });
    request.on("error", reject);
  });
}

test("à travers le relais : l'en-tête et le premier événement arrivent tout de suite, la réponse reste ouverte, les en-têtes de flux passent", async () => {
  const client = await connect();
  try {
    assert.equal(client.response.statusCode, 200);
    assert.match(String(client.response.headers["content-type"]), /^text\/event-stream/);
    assert.equal(client.response.headers["cache-control"], "no-store, no-transform");
    assert.equal(client.response.headers["x-accel-buffering"], "no");
    await client.waitFor(/retry: 3000/, 500);
    await client.waitFor(/event: ready/, 500);
    assert.equal(client.ended(), false, "le flux reste ouvert : il n'est pas mis en tampon jusqu'à sa fin");
  } finally {
    client.destroy();
  }
  await sleep(100);
});

test("à travers le relais : un événement émis plus tard arrive en moins de 300 ms ; les battements continuent ; la charge ne contient que l'id", async () => {
  const client = await connect();
  try {
    await client.waitFor(/event: ready/, 500);
    bus.emit({ conversationId: CONVERSATION, messageId: 41 });
    const elapsed = await client.waitFor(/event: message\ndata: \{"id":41\}\n\n/, 300);
    assert.ok(elapsed < 300, `reçu en ${elapsed} ms`);
    await client.waitFor(/(: ping\n\n[\s\S]*){3}/, 1_000);
    bus.emit({ conversationId: CONVERSATION, messageId: null });
    await client.waitFor(/event: resync\ndata: \{\}\n\n/, 300);
    assert.ok(!/texte|body/.test(client.text()));
  } finally {
    client.destroy();
  }
  await sleep(100);
});

test("la coupure du client est propagée à la cible à travers le relais : aucun écouteur ni place ne reste", async () => {
  const before = upstreamClosed;
  const client = await connect();
  await client.waitFor(/event: ready/, 500);
  assert.equal(bus.listenerCount(), 1);
  assert.equal(registry.total(), 1);
  client.destroy();
  const deadline = Date.now() + 2_000;
  while ((bus.listenerCount() !== 0 || registry.total() !== 0 || upstreamClosed === before) && Date.now() < deadline) await sleep(10);
  assert.equal(bus.listenerCount(), 0);
  assert.equal(registry.total(), 0);
  assert.equal(upstreamClosed, before + 1);
});

test("à travers le relais : 20 ouvertures abandonnées brutalement, puis 5 ouvertures acceptées tout de suite ; aucune place ni écouteur ne reste", async () => {
  for (let round = 0; round < 20; round += 1) {
    const client = await connect();
    if (round % 2 === 0) await client.waitFor(/retry: 3000/, 500);
    client.destroy();
  }
  const deadline = Date.now() + 2_000;
  while ((registry.total() !== 0 || bus.listenerCount() !== 0) && Date.now() < deadline) await sleep(10);
  assert.equal(registry.total(), 0, "places rendues dès l'abandon, sans attendre le battement");
  assert.equal(bus.listenerCount(), 0);
  const started = Date.now();
  const fresh: Client[] = [];
  for (let index = 0; index < 5; index += 1) {
    const client = await connect();
    assert.equal(client.response.statusCode, 200);
    await client.waitFor(/event: ready/, 500);
    fresh.push(client);
  }
  assert.ok(Date.now() - started < 2_000);
  assert.equal(registry.total(), 5);
  for (const client of fresh) client.destroy();
  const end = Date.now() + 2_000;
  while ((registry.total() !== 0 || bus.listenerCount() !== 0) && Date.now() < end) await sleep(10);
  assert.equal(registry.total(), 0);
  assert.equal(bus.listenerCount(), 0);
});

test("à travers le relais : la sixième ouverture ferme le PLUS ANCIEN flux du même utilisateur au lieu d'être refusée", async () => {
  userCounter = "utilisateur-plafond";
  const clients: Client[] = [];
  for (let index = 0; index < 5; index += 1) {
    const client = await connect();
    await client.waitFor(/event: ready/, 500);
    clients.push(client);
  }
  const sixth = await connect();
  assert.equal(sixth.response.statusCode, 200, "acceptée");
  await sixth.waitFor(/event: ready/, 500);
  const deadline = Date.now() + 2_000;
  while (!clients[0].ended() && Date.now() < deadline) await sleep(10);
  assert.equal(clients[0].ended(), true, "le plus ancien flux est fermé, jusqu'au client");
  assert.equal(clients.slice(1).every((client) => !client.ended()), true);
  assert.equal(registry.total(), 5);
  for (const client of [...clients, sixth]) client.destroy();
  const end = Date.now() + 2_000;
  while ((registry.total() !== 0 || bus.listenerCount() !== 0) && Date.now() < end) await sleep(10);
  assert.equal(registry.total(), 0);
  assert.equal(bus.listenerCount(), 0);
  userCounter = "utilisateur";
});
