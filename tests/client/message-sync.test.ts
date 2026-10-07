import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { RECONNECT_DELAYS_MS, createMessageSync, type StreamHandlers, type SyncStatus } from "../../lib/client/message-sync";
import type { ConversationMessage } from "../../lib/client/social-api";

/**
 * Synchronisation d'une conversation (lot D2), sans navigateur ni réseau : flux injecté, lecture injectée, minuteur injecté. Rattrapage « messages après l'id X »,
 * reconnexion à attente croissante, aucun doublon, aucune lecture doublée, fermeture propre.
 */

const message = (id: number): ConversationMessage => ({ id, mine: false, body: `m${id}`, createdAt: "2026-10-06T10:00:00.000Z" });
const flush = async (): Promise<void> => {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
};

function harness(options: { pages?: Array<{ messages: ConversationMessage[]; hasMore: boolean }>; failFetch?: () => boolean } = {}) {
  const store: ConversationMessage[] = [];
  const calls: Array<number | null> = [];
  const announced: number[][] = [];
  const statuses: SyncStatus[] = [];
  const streams: Array<{ handlers: StreamHandlers; closed: boolean }> = [];
  const timers: Array<{ callback: () => void; ms: number; cleared: boolean }> = [];
  let fetchErrors = 0;
  const sync = createMessageSync({
    fetchMessages: async (afterId) => {
      calls.push(afterId);
      if (options.failFetch?.()) throw new Error("réseau");
      const rows = afterId === null ? store.slice(-50) : store.filter((entry) => entry.id > afterId);
      const limit = 2;
      return { messages: rows.slice(0, limit), hasMore: rows.length > limit };
    },
    openStream: (handlers) => {
      const stream = { handlers, closed: false };
      streams.push(stream);
      return () => { stream.closed = true; };
    },
    onMessages: (fresh) => announced.push(fresh.map((entry) => entry.id)),
    onStatus: (status) => statuses.push(status),
    onFetchError: () => { fetchErrors += 1; },
    setTimer: (callback, ms) => { const timer = { callback, ms, cleared: false }; timers.push(timer); return timer; },
    clearTimer: (handle) => { (handle as { cleared: boolean }).cleared = true; },
  });
  return { sync, store, calls, announced, statuses, streams, timers, fetchErrors: () => fetchErrors };
}

describe("lecture initiale et flux", () => {
  test("start : lecture des derniers messages, puis ouverture du flux ; « ready » passe en direct", async () => {
    const h = harness();
    h.store.push(message(1), message(2));
    h.sync.start();
    await flush();
    assert.deepEqual(h.calls, [null]);
    assert.deepEqual(h.announced, [[1, 2]]);
    assert.equal(h.streams.length, 1);
    assert.equal(h.sync.status(), "connecting");
    h.streams[0].handlers.onReady();
    await flush();
    assert.equal(h.sync.status(), "live");
    assert.deepEqual(h.statuses, ["connecting", "live"]);
    assert.equal(h.sync.lastId(), 2);
  });

  test("un événement du flux relit « après l'id X » (pages successives jusqu'à épuisement), sans doublon", async () => {
    const h = harness();
    h.store.push(message(1));
    h.sync.start();
    await flush();
    h.streams[0].handlers.onReady();
    await flush();
    h.store.push(message(2), message(3), message(4), message(5));
    h.streams[0].handlers.onWake();
    await flush();
    assert.deepEqual(h.announced, [[1], [2, 3], [4, 5]]);
    assert.deepEqual(h.calls, [null, 1, 1, 3], "lecture initiale, « ready », puis deux pages après l'id vu");
    assert.equal(h.sync.lastId(), 5);
    // Le même événement rejoué n'annonce rien de plus.
    h.streams[0].handlers.onWake();
    await flush();
    assert.deepEqual(h.announced.flat(), [1, 2, 3, 4, 5]);
  });

  test("une relecture demandée PENDANT une lecture n'est pas doublée : une seconde, à la suite", async () => {
    const h = harness();
    h.sync.start();
    await flush();
    const before = h.calls.length;
    h.streams[0].handlers.onWake();
    h.streams[0].handlers.onWake();
    h.streams[0].handlers.onWake();
    await flush();
    assert.ok(h.calls.length - before <= 2, `${h.calls.length - before} lecture(s) pour trois réveils simultanés`);
  });

  test("un message connu par ailleurs (écho de l'envoi) n'est jamais annoncé deux fois et n'avance pas le point de rattrapage", async () => {
    const h = harness();
    h.store.push(message(1));
    h.sync.start();
    await flush();
    h.sync.noteKnown(3);
    h.store.push(message(2), message(3));
    await h.sync.refresh();
    assert.deepEqual(h.announced.flat(), [1, 2], "le message 3 est déjà à l'écran : annoncé une seule fois par l'envoi, pas par le rattrapage");
    assert.equal(h.sync.lastId(), 3);
    h.sync.noteKnown(0);
    h.sync.noteKnown(Number.NaN);
    assert.equal(h.sync.lastId(), 3);
  });
});

describe("repli : reconnexion à attente croissante et rattrapage", () => {
  test("le flux tombe : attentes de 1 s, 2 s, 4 s, 8 s, puis 15 s ; chaque tentative rattrape d'abord, puis rouvre le flux ; « ready » remet l'attente à zéro", async () => {
    assert.deepEqual([...RECONNECT_DELAYS_MS], [1_000, 2_000, 4_000, 8_000, 15_000]);
    const h = harness();
    h.store.push(message(1));
    h.sync.start();
    await flush();
    h.streams[0].handlers.onReady();
    await flush();
    const waits: number[] = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const stream = h.streams[h.streams.length - 1];
      stream.handlers.onError();
      assert.equal(stream.closed, true, "le flux en erreur est fermé");
      assert.equal(h.sync.status(), "reconnecting");
      const timer = h.timers[h.timers.length - 1];
      waits.push(timer.ms);
      h.store.push(message(10 + attempt));
      timer.callback();
      await flush();
      assert.ok(h.announced.flat().includes(10 + attempt), "rattrapé même si le flux reste inutilisable");
    }
    assert.deepEqual(waits, [1_000, 2_000, 4_000, 8_000, 15_000, 15_000]);
    // Le flux enfin prêt : l'attente repart de 1 s.
    h.streams[h.streams.length - 1].handlers.onReady();
    await flush();
    assert.equal(h.sync.status(), "live");
    h.streams[h.streams.length - 1].handlers.onError();
    assert.equal(h.timers[h.timers.length - 1].ms, 1_000);
  });

  test("une lecture qui échoue est signalée sans casser la synchronisation ; la tentative suivante reprend", async () => {
    let failing = true;
    const h = harness({ failFetch: () => failing });
    h.store.push(message(1));
    h.sync.start();
    await flush();
    assert.equal(h.fetchErrors(), 1);
    assert.equal(h.streams.length, 1, "le flux est ouvert malgré l'échec de la première lecture");
    failing = false;
    h.streams[0].handlers.onReady();
    await flush();
    assert.deepEqual(h.announced.flat(), [1]);
  });
});

describe("fermeture", () => {
  test("stop : le flux est fermé, l'attente annulée, plus aucune lecture ni annonce ; start peut recommencer", async () => {
    const h = harness();
    h.sync.start();
    await flush();
    h.streams[0].handlers.onError();
    const timer = h.timers[h.timers.length - 1];
    h.sync.stop();
    assert.equal(timer.cleared, true);
    assert.equal(h.sync.status(), "stopped");
    const calls = h.calls.length;
    h.store.push(message(1));
    timer.callback();
    h.streams[0].handlers.onWake();
    h.streams[0].handlers.onReady();
    await flush();
    assert.equal(h.calls.length, calls, "aucune lecture après stop");
    assert.deepEqual(h.announced, []);
    assert.equal(h.streams.every((stream) => stream.closed), true);
    h.sync.start();
    await flush();
    assert.equal(h.sync.status(), "connecting");
    assert.deepEqual(h.announced.flat(), [1]);
  });

  test("stop pendant une lecture en cours : le résultat tardif est ignoré", async () => {
    let release: (() => void) | null = null;
    const announced: number[] = [];
    const sync = createMessageSync({
      fetchMessages: () => new Promise((resolve) => { release = () => resolve({ messages: [message(1)], hasMore: false }); }),
      openStream: () => () => {},
      onMessages: (fresh) => announced.push(...fresh.map((entry) => entry.id)),
    });
    sync.start();
    await flush();
    sync.stop();
    (release as unknown as () => void)();
    await flush();
    assert.deepEqual(announced, []);
  });
});
