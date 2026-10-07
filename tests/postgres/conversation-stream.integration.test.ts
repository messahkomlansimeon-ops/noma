import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { Client } from "pg";
import { STREAM_HEARTBEAT_MS, STREAM_MAX_PER_USER } from "../../lib/server/social/config";
import { createSocialHttpHandlers, type SocialHttpHandlers } from "../../lib/server/social/http";
import { createMessageBus, parseMessagePayload, type MessageBus } from "../../lib/server/social/message-bus";
import { createStreamRegistry, formatMessageEvent, type StreamRegistry } from "../../lib/server/social/stream";
import { NOT_FOUND, login, makeMarket, openTestSchema, reply, request, resetSocial, sleep, type Login, type Market, type TestSchema } from "./social-fixtures";

/**
 * Flux en direct (lot D2) : un message envoyé arrive sur le flux de l'autre participant en moins de 2 s, sans texte ; un tiers ne peut pas ouvrir le flux ;
 * la fermeture ne laisse AUCUN écouteur (compte des écouteurs, des connexions LISTEN, des places) ; plafond de 5 flux par utilisateur ; battement ; rattrapage
 * après reconnexion ; connexion d'écoute rétablie avec resynchronisation.
 */

const BUS_APPLICATION = "noma-test-bus";

let env: TestSchema;
let market: Market;
let stranger: Login;
let bus: MessageBus;
let registry: StreamRegistry;
let handlers: SocialHttpHandlers;
const controllers: AbortController[] = [];

function makeBus(retryDelaysMs: readonly number[] = [20]): MessageBus {
  return createMessageBus({
    retryDelaysMs,
    connect: () => new Client({ connectionString: env.target.connectionString, application_name: BUS_APPLICATION }),
  });
}

function makeHandlers(heartbeatMs = STREAM_HEARTBEAT_MS): SocialHttpHandlers {
  return createSocialHttpHandlers({ pool: env.pool, env: { NOMA_AUTH_ORIGIN: "https://noma.test" }, log: () => {}, bus, registry, heartbeatMs });
}

before(async () => {
  env = await openTestSchema();
  stranger = await login(env.pool);
});

after(async () => {
  await env.close();
});

beforeEach(async () => {
  await resetSocial(env.pool);
  market = await makeMarket(env.pool);
  bus = makeBus();
  registry = createStreamRegistry();
  handlers = makeHandlers();
});

async function cleanup(): Promise<void> {
  for (const controller of controllers.splice(0)) controller.abort();
  await bus.close();
}

/** Lecteur d'événements SSE : accumule les blocs reçus et attend un bloc précis. */
interface Sse {
  blocks: string[];
  waitFor(predicate: (block: string) => boolean, timeoutMs?: number): Promise<string>;
  closed(): boolean;
  cancel(): Promise<void>;
  raw(): string;
}

function readSse(response: Response): Sse {
  assert.ok(response.body, "le flux a un corps");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const blocks: string[] = [];
  let buffer = "";
  let all = "";
  let ended = false;
  void (async () => {
    for (;;) {
      const chunk = await reader.read().catch(() => ({ done: true as const, value: undefined }));
      if (chunk.done) {
        ended = true;
        return;
      }
      const text = decoder.decode(chunk.value, { stream: true });
      all += text;
      buffer += text;
      for (let index = buffer.indexOf("\n\n"); index >= 0; index = buffer.indexOf("\n\n")) {
        blocks.push(buffer.slice(0, index));
        buffer = buffer.slice(index + 2);
      }
    }
  })();
  return {
    blocks,
    closed: () => ended,
    raw: () => all,
    async cancel() {
      await reader.cancel().catch(() => {});
    },
    async waitFor(predicate, timeoutMs = 2_000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const found = blocks.find(predicate);
        if (found !== undefined) return found;
        if (Date.now() > deadline) throw new Error(`événement attendu absent après ${timeoutMs} ms ; reçu : ${JSON.stringify(blocks)}`);
        await sleep(10);
      }
    },
  };
}

async function openStream(m: Market, cookie: string | null, heartbeatHandlers = handlers): Promise<{ response: Response; controller: AbortController }> {
  const controller = new AbortController();
  controllers.push(controller);
  const id = await conversation(m);
  const response = await heartbeatHandlers.conversations.stream(request("GET", `/api/conversations/${id}/stream`, { cookie, signal: controller.signal }), id);
  return { response, controller };
}

async function conversation(m: Market): Promise<string> {
  const existing = await env.pool.query<{ id: string }>("SELECT id FROM conversations WHERE demand_id = $1 AND offer_id = $2", [m.demand.id, m.offer.id]);
  if (existing.rows[0]) return existing.rows[0].id;
  const answer = await reply(await handlers.conversations.open(request("POST", `/api/demands/${m.demand.id}/offers/${m.offer.id}/conversation`, { cookie: m.buyer.cookie }), m.demand.id, m.offer.id));
  return (answer.json as { conversation: { id: string } }).conversation.id;
}

async function sendAs(cookie: string, id: string, body: string): Promise<{ id: number }> {
  const answer = await reply(await handlers.conversations.send(request("POST", `/api/conversations/${id}/messages`, { cookie, body: { body } }), id));
  assert.equal(answer.status, 201);
  return (answer.json as { message: { id: number } }).message;
}

const busConnections = async (): Promise<number> =>
  (await env.admin.query<{ n: number }>("SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = $1", [BUS_APPLICATION])).rows[0].n;

async function until(label: string, check: () => boolean | Promise<boolean>, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`${label} : délai de ${timeoutMs} ms dépassé`);
    await sleep(10);
  }
}

const isReady = (block: string): boolean => block.startsWith("event: ready");
const isMessage = (block: string): boolean => block.startsWith("event: message");

test("un message envoyé arrive sur le flux de l'autre participant en moins de 2 s, avec l'id seulement (jamais le texte)", async () => {
  try {
    const id = await conversation(market);
    await sendAs(market.buyer.cookie, id, "premier message");
    const { response } = await openStream(market, market.seller.cookie);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /^text\/event-stream/);
    assert.equal(response.headers.get("cache-control"), "no-store, no-transform");
    assert.equal(response.headers.get("x-accel-buffering"), "no");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    const sse = readSse(response);
    await sse.waitFor(isReady);
    const started = Date.now();
    const sent = await sendAs(market.buyer.cookie, id, "TEXTE-CONFIDENTIEL-DU-MESSAGE");
    const block = await sse.waitFor(isMessage, 2_000);
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 2_000, `reçu en ${elapsed} ms`);
    assert.equal(block, `event: message\ndata: ${JSON.stringify({ id: sent.id })}`);
    assert.ok(!sse.raw().includes("CONFIDENTIEL"), "le flux ne transporte jamais le texte");
    // Dans l'autre sens : la réponse du vendeur arrive chez l'acheteur.
    const buyerStream = readSse((await openStream(market, market.buyer.cookie)).response);
    await buyerStream.waitFor(isReady);
    const reply2 = await sendAs(market.seller.cookie, id, "réponse");
    assert.equal(await buyerStream.waitFor(isMessage, 2_000), `event: message\ndata: ${JSON.stringify({ id: reply2.id })}`);
    // Le message d'une AUTRE conversation n'arrive pas sur ce flux.
    const other = await makeMarket(env.pool);
    const otherId = await conversation(other);
    await sendAs(other.buyer.cookie, otherId, "autre conversation");
    await sleep(200);
    assert.equal(buyerStream.blocks.filter(isMessage).length, 1);
    assert.equal(sse.blocks.filter(isMessage).length, 2, "le vendeur voit le message de l'acheteur et sa propre réponse (écho : le client dédoublonne par id), jamais l'autre conversation");
  } finally {
    await cleanup();
  }
});

test("un tiers ne peut pas ouvrir le flux (même 404 qu'une conversation inconnue), aucune place ni écouteur pris ; sans session : 401 ; origine sans objet (lecture)", async () => {
  try {
    const id = await conversation(market);
    const foreignResponse = await handlers.conversations.stream(request("GET", `/api/conversations/${id}/stream`, { cookie: stranger.cookie }), id);
    if (foreignResponse.status === 200) {
      await foreignResponse.body?.cancel();
      assert.fail("un tiers a obtenu un flux ouvert");
    }
    const foreign = await reply(foreignResponse);
    const unknown = await reply(await handlers.conversations.stream(request("GET", "/api/conversations/0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b/stream", { cookie: stranger.cookie }), "0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b"));
    assert.equal(foreign.status, 404);
    assert.deepEqual(foreign.json, NOT_FOUND);
    assert.equal(foreign.text, unknown.text);
    assert.equal((await reply(await handlers.conversations.stream(request("GET", `/api/conversations/${id}/stream`, { cookie: null }), id))).status, 401);
    assert.equal((await reply(await handlers.conversations.stream(request("GET", "/api/conversations/x/stream", { cookie: market.buyer.cookie }), "x"))).status, 400);
    assert.equal(registry.total(), 0);
    assert.equal(bus.listenerCount(), 0);
    assert.equal(bus.connectionCount(), 0);
    assert.equal(await busConnections(), 0);
  } finally {
    await cleanup();
  }
});

test("fermeture : AUCUN écouteur ne reste (déconnexion du client, annulation du lecteur) ; UNE seule connexion LISTEN pour tous les flux, fermée avec le dernier", async () => {
  try {
    assert.equal(await busConnections(), 0, "aucune connexion avant le premier flux");
    const first = await openStream(market, market.buyer.cookie);
    const second = await openStream(market, market.seller.cookie);
    const third = await openStream(market, market.buyer.cookie);
    const readers = [readSse(first.response), readSse(second.response), readSse(third.response)];
    for (const sse of readers) await sse.waitFor(isReady);
    assert.equal(bus.listenerCount(), 3);
    assert.equal(registry.total(), 3);
    assert.equal(registry.open(market.buyer.userId), 2);
    assert.equal(await busConnections(), 1, "une connexion LISTEN partagée, jamais une par client");
    first.controller.abort();
    await until("premier flux fermé", () => bus.listenerCount() === 2);
    assert.equal(registry.open(market.buyer.userId), 1);
    await readers[1].cancel();
    await until("deuxième flux annulé", () => bus.listenerCount() === 1);
    assert.equal(await busConnections(), 1, "la connexion reste tant qu'un flux est ouvert");
    const lastClosedAt = Date.now();
    third.controller.abort();
    // Lot D3 : la connexion d'écoute se ferme au plus 5 s après le dernier abonné (ici : tout de suite, sans délai de grâce).
    await until("dernier flux fermé", () => bus.listenerCount() === 0 && bus.connectionCount() === 0, 5_000);
    assert.equal(registry.total(), 0);
    await until("connexion LISTEN fermée côté serveur", async () => (await busConnections()) === 0, 5_000);
    assert.ok(Date.now() - lastClosedAt <= 5_000, `connexion d'écoute fermée en ${Date.now() - lastClosedAt} ms (au plus 5 s après le dernier abonné)`);
    await until("lecteur terminé", () => readers[0].closed() && readers[2].closed());
    // Un message envoyé ensuite ne rouvre rien.
    await sendAs(market.buyer.cookie, await conversation(market), "personne n'écoute");
    await sleep(100);
    assert.equal(bus.connectionCount(), 0);
    assert.equal(await busConnections(), 0);
  } finally {
    await cleanup();
  }
});

test(`plafond de ${STREAM_MAX_PER_USER} flux par utilisateur : le suivant est ACCEPTÉ et FERME LE PLUS ANCIEN (jamais de refus) ; l'autre participant n'est pas touché`, async () => {
  try {
    const opened: Array<{ response: Response; controller: AbortController; sse: Sse }> = [];
    for (let index = 0; index < STREAM_MAX_PER_USER; index += 1) {
      const stream = await openStream(market, market.buyer.cookie);
      assert.equal(stream.response.status, 200, `flux ${index + 1}`);
      opened.push({ ...stream, sse: readSse(stream.response) });
    }
    for (const entry of opened) await entry.sse.waitFor(isReady);
    assert.equal(bus.listenerCount(), STREAM_MAX_PER_USER);
    const sellerStream = await openStream(market, market.seller.cookie);
    assert.equal(sellerStream.response.status, 200, "le plafond est PAR utilisateur");
    const sixth = await openStream(market, market.buyer.cookie);
    assert.equal(sixth.response.status, 200, "le sixième flux est accepté");
    const sixthSse = readSse(sixth.response);
    await sixthSse.waitFor(isReady);
    await until("le plus ancien est fermé", () => opened[0].sse.closed());
    assert.equal(opened.slice(1).every((entry) => !entry.sse.closed()), true, "les autres flux restent ouverts");
    assert.equal(registry.open(market.buyer.userId), STREAM_MAX_PER_USER, "jamais plus de 5 flux comptés");
    assert.equal(registry.open(market.seller.userId), 1);
    assert.equal(bus.listenerCount(), STREAM_MAX_PER_USER + 1, "5 de l'acheteur (dont le nouveau) et 1 du vendeur");
    // Le flux évincé a rendu son écouteur ; le nouveau reçoit bien le direct.
    const id = await conversation(market);
    const sent = await sendAs(market.seller.cookie, id, "après éviction");
    assert.equal(await sixthSse.waitFor((block) => isMessage(block) && block.includes(`"id":${sent.id}`)), `event: message\ndata: ${JSON.stringify({ id: sent.id })}`);
    assert.equal(opened[0].sse.blocks.filter(isMessage).length, 0, "le flux évincé ne reçoit plus rien");
  } finally {
    await cleanup();
  }
});

test("la place est rendue DÈS la déconnexion : 20 ouvertures puis abandons brutaux, puis 5 ouvertures acceptées tout de suite ; aucun écouteur ni connexion à la fin", async () => {
  try {
    for (let round = 0; round < 20; round += 1) {
      const stream = await openStream(market, market.buyer.cookie);
      assert.equal(stream.response.status, 200, `ouverture ${round + 1}`);
      const sse = readSse(stream.response);
      if (round % 2 === 0) await sse.waitFor((block) => block.startsWith("retry: "));
      // Abandon brutal : signal de la requête (onglet fermé, page rechargée) ou annulation du lecteur, sans attendre le moindre battement.
      if (round % 3 === 0) await sse.cancel();
      else stream.controller.abort();
    }
    await until("toutes les places rendues sans attendre le battement", () => registry.open(market.buyer.userId) === 0 && bus.listenerCount() === 0, 2_000);
    const started = Date.now();
    const fresh: Array<{ controller: AbortController }> = [];
    for (let index = 0; index < STREAM_MAX_PER_USER; index += 1) {
      const stream = await openStream(market, market.buyer.cookie);
      assert.equal(stream.response.status, 200);
      await readSse(stream.response).waitFor(isReady);
      fresh.push(stream);
    }
    assert.ok(Date.now() - started < 2_000, `5 ouvertures en ${Date.now() - started} ms`);
    assert.equal(registry.open(market.buyer.userId), STREAM_MAX_PER_USER);
    for (const stream of fresh) stream.controller.abort();
    await until("écouteurs et connexions à zéro", async () => bus.listenerCount() === 0 && bus.connectionCount() === 0 && registry.total() === 0 && (await busConnections()) === 0);
  } finally {
    await cleanup();
  }
});

test("battement : un commentaire « : ping » arrive à intervalle régulier (15 s par défaut, réduit ici) ; le flux annonce sa reprise (retry)", async () => {
  assert.equal(STREAM_HEARTBEAT_MS, 15_000, "lot D3 : battement abaissé de 25 s à 15 s");
  try {
    const quick = makeHandlers(40);
    const { response } = await openStream(market, market.buyer.cookie, quick);
    const sse = readSse(response);
    await sse.waitFor((block) => block.startsWith("retry: "));
    await sse.waitFor(isReady);
    await until("deux battements", () => sse.blocks.filter((block) => block === ": ping").length >= 2, 2_000);
  } finally {
    await cleanup();
  }
});

test("rattrapage après reconnexion : les messages écrits pendant la coupure sont relus par « messages après l'id X », dans l'ordre et sans trou", async () => {
  try {
    const id = await conversation(market);
    const first = await openStream(market, market.seller.cookie);
    const sse = readSse(first.response);
    await sse.waitFor(isReady);
    const seen = await sendAs(market.buyer.cookie, id, "vu en direct");
    await sse.waitFor(isMessage);
    first.controller.abort();
    await until("flux fermé", () => bus.listenerCount() === 0);
    // Pendant la coupure : deux messages (un de chaque côté).
    const missed1 = await sendAs(market.buyer.cookie, id, "manqué un");
    const missed2 = await sendAs(market.seller.cookie, id, "manqué deux");
    // Reconnexion : le client relit après le dernier id vu.
    const second = await openStream(market, market.seller.cookie);
    const again = readSse(second.response);
    await again.waitFor(isReady);
    const caught = await reply(await handlers.conversations.messages(request("GET", `/api/conversations/${id}/messages`, { cookie: market.seller.cookie, query: `?after=${seen.id}` }), id));
    const rows = (caught.json as { messages: Array<{ id: number; body: string }> }).messages;
    assert.deepEqual(rows.map((row) => row.id), [missed1.id, missed2.id]);
    assert.deepEqual(rows.map((row) => row.body), ["manqué un", "manqué deux"]);
    // Et le direct reprend.
    const live = await sendAs(market.buyer.cookie, id, "de nouveau en direct");
    assert.equal(await again.waitFor((block) => isMessage(block) && block.includes(`"id":${live.id}`)), `event: message\ndata: ${JSON.stringify({ id: live.id })}`);
  } finally {
    await cleanup();
  }
});

test("connexion d'écoute perdue : elle est rétablie avec attente, les flux reçoivent « resync » (relecture) puis les messages suivants arrivent", async () => {
  try {
    const id = await conversation(market);
    const { response } = await openStream(market, market.seller.cookie);
    const sse = readSse(response);
    await sse.waitFor(isReady);
    const before = await busConnections();
    assert.equal(before, 1);
    await env.admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = $1", [BUS_APPLICATION]);
    await sse.waitFor((block) => block.startsWith("event: resync"), 3_000);
    await until("connexion rétablie", async () => (await busConnections()) === 1 && bus.connectionCount() === 1);
    assert.equal(bus.listenerCount(), 1, "le flux n'a pas été perdu");
    const sent = await sendAs(market.buyer.cookie, id, "après la coupure");
    assert.equal(await sse.waitFor((block) => isMessage(block) && block.includes(`"id":${sent.id}`), 2_000), `event: message\ndata: ${JSON.stringify({ id: sent.id })}`);
  } finally {
    await cleanup();
  }
});

test("bus : une connexion qui échoue n'ouvre rien de durable (retour sans exception) et se désabonner arrête toute reprise", async () => {
  let attempts = 0;
  const failing = createMessageBus({
    retryDelaysMs: [10],
    connect: () => {
      attempts += 1;
      return { on() {}, removeAllListeners() {}, connect: () => Promise.reject(new Error("refus")), query: () => Promise.resolve(), end: () => Promise.resolve() } as unknown as Client;
    },
  });
  const subscription = failing.subscribe("0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b", () => {});
  await subscription.ready;
  await until("reprises", () => attempts >= 3, 2_000);
  subscription.unsubscribe();
  assert.equal(failing.listenerCount(), 0);
  const settled = attempts;
  await sleep(100);
  assert.equal(attempts, settled, "plus aucune reprise après le dernier désabonnement");
  assert.equal(failing.connectionCount(), 0);
  await failing.close();
});

test("charge du NOTIFY : seules les formes exactes { c, m } sont acceptées ; un texte, une clé en trop, un identifiant invalide sont ignorés", () => {
  const conversationId = "0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b";
  assert.deepEqual(parseMessagePayload(JSON.stringify({ c: conversationId, m: 12 })), { conversationId, messageId: 12 });
  for (const payload of [
    JSON.stringify({ c: conversationId, m: 12, b: "texte" }),
    JSON.stringify({ c: conversationId }),
    JSON.stringify({ c: "pas-un-uuid", m: 1 }),
    JSON.stringify({ c: conversationId, m: 0 }),
    JSON.stringify({ c: conversationId, m: "12" }),
    JSON.stringify([conversationId, 12]),
    "pas du json",
    "x".repeat(300),
    undefined,
  ]) {
    assert.equal(parseMessagePayload(payload), null, String(payload).slice(0, 40));
  }
  assert.equal(formatMessageEvent({ conversationId, messageId: 7 }), 'event: message\ndata: {"id":7}\n\n');
  assert.equal(formatMessageEvent({ conversationId, messageId: null }), "event: resync\ndata: {}\n\n");
});
