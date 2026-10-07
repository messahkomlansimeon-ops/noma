import "server-only";

import { Client } from "pg";
import { requireDatabaseUrl } from "../postgres/client";
import { MESSAGES_CHANNEL } from "./config";

/**
 * Bus des messages en direct (lot D2) : UNE connexion PostgreSQL `LISTEN noma_messages` PAR PROCESSUS, partagée par tous les flux ouverts (jamais une connexion par client).
 * La charge d'un NOTIFY ne contient que `{ c: conversation, m: id du message }`, JAMAIS le texte : le client relit les messages par l'API après chaque événement.
 *
 *  - la connexion est ouverte au premier abonné et FERMÉE quand le dernier se désabonne (aucune connexion, aucun écouteur ne reste : `listenerCount()` et
 *    `connectionCount()` le prouvent) ;
 *  - une connexion perdue est rétablie avec une attente croissante tant qu'il reste des abonnés ; à chaque (re)connexion les abonnés reçoivent un événement de
 *    resynchronisation (`messageId: null`) : les NOTIFY émis pendant la coupure sont perdus, le client relit alors « les messages après l'id X » ;
 *  - une charge illisible est ignorée (jamais une erreur, jamais une diffusion).
 */

export interface MessageEvent {
  conversationId: string;
  /** Id du message ; null : resynchronisation (la connexion a été rétablie, des événements ont pu être perdus). */
  messageId: number | null;
}

export type MessageHandler = (event: MessageEvent) => void;

export interface MessageSubscription {
  unsubscribe(): void;
  /** Se résout quand l'écoute est établie (ou abandonnée) : les messages écrits ensuite arriveront. */
  ready: Promise<void>;
}

export interface MessageBus {
  subscribe(conversationId: string, handler: MessageHandler): MessageSubscription;
  /** Nombre total d'abonnés (un par flux ouvert). */
  listenerCount(): number;
  /** Connexions PostgreSQL d'écoute ouvertes par ce bus : 0 ou 1. */
  connectionCount(): number;
  close(): Promise<void>;
}

export interface MessageBusOptions {
  /** Fabrique de la connexion d'écoute (défaut : DATABASE_URL). Réservée aux tests. */
  connect?: () => Client;
  /** Attentes successives entre deux tentatives de reconnexion (la dernière se répète). */
  retryDelaysMs?: readonly number[];
}

const DEFAULT_RETRY_DELAYS_MS: readonly number[] = Object.freeze([500, 1_000, 2_000, 5_000, 10_000]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Charge d'un NOTIFY → événement, ou null si elle n'a pas la forme exacte `{ c, m }`. */
export function parseMessagePayload(payload: string | undefined): MessageEvent | null {
  if (typeof payload !== "string" || payload.length > 200) return null;
  let value: unknown;
  try {
    value = JSON.parse(payload);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== "c,m") return null;
  if (typeof record.c !== "string" || !UUID.test(record.c) || typeof record.m !== "number" || !Number.isSafeInteger(record.m) || record.m < 1) return null;
  return { conversationId: record.c, messageId: record.m };
}

export function createMessageBus(options: MessageBusOptions = {}): MessageBus {
  const retryDelays = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const subscribers = new Map<string, Set<MessageHandler>>();
  let total = 0;
  let client: Client | null = null;
  let connecting = false;
  let everConnected = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let retryIndex = 0;
  let waiting: Array<() => void> = [];
  let generation = 0;

  const settleReady = (): void => {
    const resolvers = waiting;
    waiting = [];
    for (const resolve of resolvers) resolve();
  };

  function dispatch(event: MessageEvent, target?: Set<MessageHandler>): void {
    const handlers = target ?? subscribers.get(event.conversationId);
    if (!handlers) return;
    for (const handler of [...handlers]) {
      try {
        handler(event);
      } catch {
        // Un abonné défaillant ne doit jamais empêcher les autres de recevoir l'événement.
      }
    }
  }

  function resyncAll(): void {
    for (const [conversationId, handlers] of [...subscribers]) dispatch({ conversationId, messageId: null }, handlers);
  }

  function clearRetry(): void {
    if (retryTimer !== null) clearTimeout(retryTimer);
    retryTimer = null;
  }

  async function dispose(connection: Client): Promise<void> {
    connection.removeAllListeners("notification");
    connection.removeAllListeners("error");
    connection.removeAllListeners("end");
    // Les erreurs d'une connexion qu'on referme ne sont jamais fatales.
    connection.on("error", () => {});
    try {
      await connection.end();
    } catch {
      // Déjà fermée.
    }
  }

  function scheduleRetry(): void {
    if (total === 0 || retryTimer !== null || connecting) return;
    const delay = retryDelays[Math.min(retryIndex, retryDelays.length - 1)] ?? 1_000;
    retryIndex += 1;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void connect();
    }, delay);
    retryTimer.unref?.();
  }

  async function connect(): Promise<void> {
    if (client !== null || connecting || total === 0) return;
    connecting = true;
    const mine = (generation += 1);
    const connection = options.connect ? options.connect() : new Client({ connectionString: requireDatabaseUrl(), keepAlive: true });
    const lost = (): void => {
      if (client !== connection) return;
      client = null;
      void dispose(connection);
      scheduleRetry();
    };
    connection.on("notification", (message) => {
      if (message.channel !== MESSAGES_CHANNEL) return;
      const event = parseMessagePayload(message.payload);
      if (event) dispatch(event);
    });
    connection.on("error", lost);
    connection.on("end", lost);
    try {
      await connection.connect();
      await connection.query(`LISTEN ${MESSAGES_CHANNEL}`);
    } catch {
      connecting = false;
      await dispose(connection);
      settleReady();
      scheduleRetry();
      return;
    }
    connecting = false;
    if (total === 0 || mine !== generation) {
      await dispose(connection);
      settleReady();
      return;
    }
    client = connection;
    retryIndex = 0;
    const reconnection = everConnected;
    everConnected = true;
    settleReady();
    // Des NOTIFY ont pu se perdre avant l'écoute ou pendant une coupure : tous les abonnés relisent.
    if (reconnection || total > 0) resyncAll();
  }

  async function disconnect(): Promise<void> {
    clearRetry();
    generation += 1;
    const connection = client;
    client = null;
    everConnected = false;
    retryIndex = 0;
    settleReady();
    if (connection) await dispose(connection);
  }

  return {
    subscribe(conversationId, handler) {
      let handlers = subscribers.get(conversationId);
      if (!handlers) {
        handlers = new Set();
        subscribers.set(conversationId, handlers);
      }
      handlers.add(handler);
      total += 1;
      const ready = new Promise<void>((resolve) => {
        if (client !== null) resolve();
        else waiting.push(resolve);
      });
      if (client === null) void connect();
      let active = true;
      return {
        ready,
        unsubscribe() {
          if (!active) return;
          active = false;
          const set = subscribers.get(conversationId);
          if (set?.delete(handler)) total -= 1;
          if (set && set.size === 0) subscribers.delete(conversationId);
          if (total === 0) void disconnect();
        },
      };
    },
    listenerCount: () => total,
    connectionCount: () => (client !== null || connecting ? 1 : 0),
    async close() {
      subscribers.clear();
      total = 0;
      await disconnect();
    },
  };
}

const SHARED_KEY = Symbol.for("noma.messageBus");

/** Le bus du processus (un seul, même si le module est chargé plusieurs fois par le rechargement à chaud de `next dev`). */
export function getMessageBus(): MessageBus {
  const holder = globalThis as unknown as Record<symbol, MessageBus | undefined>;
  let bus = holder[SHARED_KEY];
  if (!bus) {
    bus = createMessageBus();
    holder[SHARED_KEY] = bus;
  }
  return bus;
}
