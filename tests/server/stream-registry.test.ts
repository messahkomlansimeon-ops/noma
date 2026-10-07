import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { STREAM_HEARTBEAT_MS, STREAM_MAX_PER_USER } from "../../lib/server/social/config";
import type { MessageBus, MessageHandler } from "../../lib/server/social/message-bus";
import { createStreamRegistry, openMessageStream, type StreamHandle, type StreamRegistry } from "../../lib/server/social/stream";

/**
 * Lot D3, point 2 : une place n'est occupée que par un flux VIVANT. Avant toute éviction, le registre SONDE les flux de l'utilisateur (commentaire SSE) : un flux dont l'écriture échoue, dont
 * le contrôleur est fermé ou dont le signal est abandonné est libéré d'abord ; le plus ancien n'est évincé que si les 5 flux sont réellement vivants. Battement de 15 s.
 */

interface Fake {
  handle: StreamHandle;
  evicted: number;
  probes: number;
  alive: boolean;
  /** Le flux répond à la sonde (écriture réussie). */
  writable: boolean;
}

function fake(overrides: Partial<Pick<Fake, "alive" | "writable">> = {}): Fake {
  const state: Fake = {
    evicted: 0,
    probes: 0,
    alive: overrides.alive ?? true,
    writable: overrides.writable ?? true,
    handle: {
      evict: () => {
        state.evicted += 1;
      },
      isAlive: () => state.alive,
      probe: () => {
        state.probes += 1;
        return state.alive && state.writable;
      },
    },
  };
  return state;
}

function fill(registry: StreamRegistry, userId: string, streams: Fake[]) {
  return streams.map((stream) => registry.acquire(userId, stream.handle));
}

describe("registre des flux : sonde de vivacité avant toute éviction", () => {
  test("constantes : plafond de 5 flux par utilisateur, battement de 15 s", () => {
    assert.equal(STREAM_MAX_PER_USER, 5);
    assert.equal(STREAM_HEARTBEAT_MS, 15_000);
  });

  test("5 flux réellement vivants : le 6e évince le PLUS ANCIEN seulement, après avoir sondé les cinq", () => {
    const registry = createStreamRegistry(5);
    const streams = Array.from({ length: 5 }, () => fake());
    fill(registry, "u", streams);
    assert.deepEqual(streams.map((stream) => stream.probes), [0, 0, 0, 0, 0], "aucune sonde tant que le plafond n'est pas atteint");
    const sixth = fake();
    registry.acquire("u", sixth.handle);
    assert.deepEqual(streams.map((stream) => stream.probes), [1, 1, 1, 1, 1], "les cinq flux sont sondés avant l'éviction");
    assert.deepEqual(streams.map((stream) => stream.evicted), [1, 0, 0, 0, 0], "seul le plus ancien est évincé");
    assert.equal(registry.open("u"), 5);
  });

  test("4 flux vivants et 1 mort (écriture refusée) : le nouveau flux n'évince AUCUN flux vivant, le mort est libéré", () => {
    const registry = createStreamRegistry(5);
    const live = Array.from({ length: 4 }, () => fake());
    const dead = fake({ writable: false });
    fill(registry, "u", [live[0], dead, live[1], live[2], live[3]]);
    const fresh = fake();
    registry.acquire("u", fresh.handle);
    assert.deepEqual(live.map((stream) => stream.evicted), [0, 0, 0, 0], "aucun flux vivant évincé");
    assert.equal(dead.evicted, 1, "le flux mort est libéré (fermé)");
    assert.equal(registry.open("u"), 5, "4 vivants + le nouveau");
  });

  test("un flux dont la requête est abandonnée ou dont le contrôleur est fermé est libéré d'abord, sans écriture", () => {
    const registry = createStreamRegistry(5);
    const live = Array.from({ length: 3 }, () => fake());
    const aborted = fake({ alive: false });
    const closedController = fake({ alive: false });
    fill(registry, "u", [aborted, live[0], closedController, live[1], live[2]]);
    registry.acquire("u", fake().handle);
    assert.deepEqual(live.map((stream) => stream.evicted), [0, 0, 0]);
    assert.equal(aborted.evicted, 1);
    assert.equal(closedController.evicted, 1);
    assert.equal(aborted.probes, 0, "un flux déjà mort n'est pas sondé par écriture");
    assert.equal(registry.open("u"), 4, "3 vivants + le nouveau");
  });

  test("20 ouvertures-fermetures d'un 5e flux avec 4 flux vivants : aucun flux vivant n'est évincé, même si les places des flux fermés n'ont jamais été rendues", () => {
    const registry = createStreamRegistry(5);
    const live = Array.from({ length: 4 }, () => fake());
    fill(registry, "u", live);
    for (let round = 0; round < 20; round += 1) {
      // La requête est fermée brutalement, mais ni le signal ni l'annulation n'ont encore prévenu le registre : la place n'est pas rendue (aucun `release`).
      const fifth = fake();
      registry.acquire("u", fifth.handle);
      fifth.alive = false;
    }
    assert.deepEqual(live.map((stream) => stream.evicted), [0, 0, 0, 0], "les 4 flux vivants sont intacts");
    assert.equal(registry.open("u"), 4, "seuls les flux vivants comptent : les 20 fermés ne comptent plus");
  });

  test("la sonde ne touche que les flux de l'utilisateur qui prend une place ; un autre utilisateur n'est jamais sondé ni évincé", () => {
    const registry = createStreamRegistry(5);
    const mine = Array.from({ length: 5 }, () => fake());
    const theirs = Array.from({ length: 3 }, () => fake());
    fill(registry, "me", mine);
    fill(registry, "them", theirs);
    registry.acquire("me", fake().handle);
    assert.deepEqual(theirs.map((stream) => [stream.probes, stream.evicted]), [[0, 0], [0, 0], [0, 0]]);
    assert.equal(registry.open("them"), 3);
  });

  test("une sonde ou un contrôle de vivacité qui lève une exception compte comme un flux mort (jamais une erreur pour le nouveau flux)", () => {
    const registry = createStreamRegistry(2);
    const first = fake();
    first.handle.probe = () => {
      throw new Error("écriture impossible");
    };
    const second = fake();
    second.handle.isAlive = () => {
      throw new Error("état illisible");
    };
    fill(registry, "u", [first, second]);
    const fresh = fake();
    assert.doesNotThrow(() => registry.acquire("u", fresh.handle));
    assert.equal(first.evicted, 1);
    assert.equal(second.evicted, 1);
    assert.equal(registry.open("u"), 1);
  });

  test("la libération reste idempotente et rend la place une seule fois", () => {
    const registry = createStreamRegistry(5);
    const one = fake();
    const slot = registry.acquire("u", one.handle);
    slot.release();
    slot.release();
    assert.equal(registry.open("u"), 0);
    assert.equal(registry.total(), 0);
  });
});

/** Bus factice : aucun PostgreSQL, un abonné se compte. */
function fakeBus(): MessageBus & { handlers: Set<MessageHandler> } {
  const handlers = new Set<MessageHandler>();
  return {
    handlers,
    subscribe(_conversationId, handler) {
      handlers.add(handler);
      return { ready: Promise.resolve(), unsubscribe: () => void handlers.delete(handler) };
    },
    listenerCount: () => handlers.size,
    connectionCount: () => (handlers.size > 0 ? 1 : 0),
    close: async () => handlers.clear(),
  };
}

describe("flux réels (ReadableStream) : la sonde écrit un commentaire SSE et reconnaît un flux mort", () => {
  const CONVERSATION = "11111111-1111-4111-8111-111111111111";

  async function readText(response: Response, count = 3): Promise<string> {
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let text = "";
    for (let index = 0; index < count; index += 1) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value);
    }
    reader.releaseLock();
    return text;
  }

  /** Lit le flux jusqu'à ce que le texte lu contienne `needle` (ou que le flux se termine) ; rend le texte lu. */
  async function readUntil(response: Response, needle: string): Promise<string> {
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let text = "";
    while (!text.includes(needle)) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value);
    }
    reader.releaseLock();
    return text;
  }

  test("avec 5 flux vivants, l'ouverture du 6e écrit « : probe » sur chacun, évince le plus ancien seulement ; les autres restent ouverts", async () => {
    const registry = createStreamRegistry(5);
    const bus = fakeBus();
    const controllers = Array.from({ length: 5 }, () => new AbortController());
    const responses = controllers.map((controller) => openMessageStream({ bus, registry, userId: "u", conversationId: CONVERSATION, signal: controller.signal }));
    assert.equal(registry.open("u"), 5);
    const sixth = openMessageStream({ bus, registry, userId: "u", conversationId: CONVERSATION, signal: new AbortController().signal });
    assert.equal(registry.open("u"), 5, "jamais plus de 5 flux comptés");
    assert.equal(bus.listenerCount(), 5, "le plus ancien a rendu son écouteur");
    // Le plus ancien est fermé (fin du flux) ; les quatre autres ont reçu la sonde après « retry: ».
    const oldest = await readText(responses[0], 3);
    assert.equal(oldest.includes("retry: "), true);
    const second = await readText(responses[1], 3);
    assert.equal(second.includes(": probe\n\n"), true, `commentaire de sonde reçu : ${JSON.stringify(second)}`);
    void sixth;
    for (const controller of controllers) controller.abort();
  });

  /** Signal dont l'abandon n'est JAMAIS notifié (aucun écouteur ne sera appelé) : la requête est fermée mais personne n'a prévenu le flux. */
  function silentSignal(): { signal: AbortSignal; abandon: () => void } {
    const state = { aborted: false };
    const signal = { get aborted() { return state.aborted; }, addEventListener: () => undefined, removeEventListener: () => undefined } as unknown as AbortSignal;
    return { signal, abandon: () => { state.aborted = true; } };
  }

  test("un flux dont la requête est abandonnée SANS notification n'occupe plus de place : 4 flux vivants + 20 flux abandonnés, aucun flux vivant évincé, aucun écouteur ne reste", async () => {
    const registry = createStreamRegistry(5);
    const bus = fakeBus();
    const live = Array.from({ length: 4 }, () => new AbortController());
    const liveResponses = live.map((controller) => openMessageStream({ bus, registry, userId: "u", conversationId: CONVERSATION, signal: controller.signal }));
    for (let round = 0; round < 20; round += 1) {
      const silent = silentSignal();
      openMessageStream({ bus, registry, userId: "u", conversationId: CONVERSATION, signal: silent.signal });
      silent.abandon();
    }
    assert.equal(registry.open("u"), 4, "seuls les 4 flux vivants comptent (le 5e abandonné est libéré à l'ouverture du suivant)");
    assert.equal(bus.listenerCount(), 4, "les flux abandonnés ont rendu leur écouteur");
    // Les 4 flux vivants reçoivent encore les événements.
    for (const handler of [...bus.handlers]) handler({ conversationId: CONVERSATION, messageId: 7 });
    for (const response of liveResponses) assert.equal((await readUntil(response, '"id":7')).includes('"id":7'), true, "le message est reçu par les 4 flux vivants");
    for (const controller of live) controller.abort();
    assert.equal(registry.total(), 0);
    assert.equal(bus.listenerCount(), 0);
  });

  test("abandon notifié (signal ou annulation du lecteur) : la place est rendue tout de suite, 20 tours sans aucune éviction", async () => {
    const registry = createStreamRegistry(5);
    const bus = fakeBus();
    const live = Array.from({ length: 4 }, () => new AbortController());
    for (const controller of live) openMessageStream({ bus, registry, userId: "u", conversationId: CONVERSATION, signal: controller.signal });
    for (let round = 0; round < 20; round += 1) {
      const fifth = new AbortController();
      const response = openMessageStream({ bus, registry, userId: "u", conversationId: CONVERSATION, signal: fifth.signal });
      if (round % 2 === 0) fifth.abort();
      else await (response.body as ReadableStream<Uint8Array>).cancel();
      assert.equal(registry.open("u"), 4, `tour ${round + 1} : la place est déjà rendue`);
    }
    assert.equal(bus.listenerCount(), 4);
    for (const controller of live) controller.abort();
  });

  test("un flux annulé par le lecteur rend sa place, son écouteur et son battement ; le battement d'un flux est de 15 s par défaut", async () => {
    const registry = createStreamRegistry(5);
    const bus = fakeBus();
    const response = openMessageStream({ bus, registry, userId: "u", conversationId: CONVERSATION, signal: new AbortController().signal });
    await (response.body as ReadableStream<Uint8Array>).cancel();
    assert.equal(registry.open("u"), 0);
    assert.equal(bus.listenerCount(), 0);
    assert.equal(STREAM_HEARTBEAT_MS, 15_000);
  });
});
