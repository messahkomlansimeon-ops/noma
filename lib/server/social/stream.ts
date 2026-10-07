import "server-only";

import { STREAM_HEARTBEAT_MS, STREAM_MAX_PER_USER, STREAM_RETRY_MS } from "./config";
import type { MessageBus, MessageEvent } from "./message-bus";

/**
 * Flux en direct d'UNE conversation (lot D2), en Server-Sent Events (`text/event-stream`) :
 *  - le flux n'est ouvert qu'APRÈS le contrôle d'accès (participant, voir `conversations-http`) ; au plus `STREAM_MAX_PER_USER` flux ouverts par utilisateur (par
 *    processus) : le suivant FERME LE PLUS ANCIEN de cet utilisateur au lieu d'être refusé ;
 *  - il ne transporte JAMAIS de texte de message : seulement `event: message` + `{ "id": <id du message> }` (ou `event: resync` quand la connexion d'écoute a été rétablie) ;
 *    le client relit alors « les messages après l'id X » par l'API ;
 *  - un battement `: ping` toutes les `STREAM_HEARTBEAT_MS` (15 s) garde la connexion ouverte à travers les relais ;
 *  - (lot D3) une place n'est occupée que par un flux VIVANT : AVANT toute éviction, le registre SONDE les flux de l'utilisateur (un commentaire `: probe` est écrit) ; un flux
 *    dont l'écriture échoue, dont le contrôleur est fermé (`desiredSize` nul) ou dont le signal de la requête est abandonné est libéré d'abord ; on n'évince le plus ancien que
 *    si les 5 flux sont réellement vivants ;
 *  - la fermeture est PROPRE dans tous les cas (déconnexion du client : signal d'abandon de la requête ET `cancel()` du flux ; éviction ; erreur d'écriture, notamment au
 *    battement) : le battement s'arrête, l'abonnement au bus est retiré (donc, au dernier flux, la connexion LISTEN est fermée) et la place est rendue, UNE seule fois.
 *    Aucun écouteur ne fuit.
 */

export interface StreamSlot {
  /** Rend la place (idempotent : une seule fois, quel que soit le nombre d'appels). */
  release(): void;
}

/** Ce que le registre sait d'UN flux ouvert : le fermer, savoir s'il vit, le sonder. */
export interface StreamHandle {
  /** Ferme le flux (éviction). */
  evict(): void;
  /** Le flux vit-il (sans rien écrire) ? Faux s'il est fermé, si sa requête est abandonnée ou si son contrôleur est fermé. */
  isAlive(): boolean;
  /** Sonde le flux : écrit un commentaire SSE ; faux si l'écriture échoue ou si le flux est mort. */
  probe(): boolean;
}

export interface StreamRegistry {
  /**
   * Prend une place pour l'utilisateur. Jamais de refus : si l'utilisateur a déjà `maxPerUser` flux, les flux de cet utilisateur sont d'abord SONDÉS (un flux mort est libéré), puis,
   * seulement si tous sont réellement vivants, le PLUS ANCIEN est fermé (`evict`) pour faire de la place : un utilisateur n'est jamais bloqué par ses propres onglets fermés ou abandonnés.
   */
  acquire(userId: string, handle: StreamHandle): StreamSlot;
  /** Flux VIVANTS de l'utilisateur (un flux mort n'occupe aucune place). */
  open(userId: string): number;
  /** Flux vivants, tous utilisateurs confondus. */
  total(): number;
}

export function createStreamRegistry(maxPerUser: number = STREAM_MAX_PER_USER): StreamRegistry {
  interface Entry { handle: StreamHandle; released: boolean }
  const slots = new Map<string, Entry[]>();
  const remove = (userId: string, entry: Entry): void => {
    const list = slots.get(userId);
    if (!list) return;
    const index = list.indexOf(entry);
    if (index >= 0) list.splice(index, 1);
    if (list.length === 0) slots.delete(userId);
  };
  const safely = (action: () => boolean): boolean => {
    try {
      return action();
    } catch {
      return false;
    }
  };
  /** Libère d'abord les flux morts de la liste : un flux fermé, abandonné ou au contrôleur fermé n'occupe plus de place. */
  const dropDead = (userId: string, list: Entry[], alive: (handle: StreamHandle) => boolean): void => {
    for (const entry of [...list]) {
      if (alive(entry.handle)) continue;
      entry.released = true;
      remove(userId, entry);
      try {
        entry.handle.evict();
      } catch {
        // Un flux déjà mort : rien à fermer.
      }
    }
  };
  return {
    acquire(userId, handle) {
      let list = slots.get(userId);
      if (!list) {
        list = [];
        slots.set(userId, list);
      }
      if (list.length >= maxPerUser) {
        // Plafond atteint : SONDER tous les flux de l'utilisateur (écriture d'un commentaire) et libérer les morts AVANT d'évincer qui que ce soit.
        dropDead(userId, list, (candidate) => safely(() => candidate.isAlive()) && safely(() => candidate.probe()));
        list = slots.get(userId) ?? [];
        slots.set(userId, list);
      }
      // Éviction du plus ancien SEULEMENT si les flux restants sont tous vivants et que le plafond est encore atteint.
      while (list.length >= maxPerUser) {
        const oldest = list[0];
        try {
          oldest.handle.evict();
        } catch {
          // Une fermeture qui échoue ne doit pas bloquer le nouveau flux.
        }
        if (list[0] === oldest) list.shift();
      }
      const entry: Entry = { handle, released: false };
      list.push(entry);
      return {
        release() {
          if (entry.released) return;
          entry.released = true;
          remove(userId, entry);
        },
      };
    },
    open(userId) {
      const list = slots.get(userId);
      if (!list) return 0;
      dropDead(userId, list, (candidate) => safely(() => candidate.isAlive()));
      return slots.get(userId)?.length ?? 0;
    },
    total() {
      for (const [userId, list] of [...slots]) dropDead(userId, list, (candidate) => safely(() => candidate.isAlive()));
      return [...slots.values()].reduce((sum, list) => sum + list.length, 0);
    },
  };
}

const SHARED_REGISTRY_KEY = Symbol.for("noma.streamRegistry");

/** Le registre du processus (partagé même si le module est rechargé à chaud). */
export function getStreamRegistry(): StreamRegistry {
  const holder = globalThis as unknown as Record<symbol, StreamRegistry | undefined>;
  let registry = holder[SHARED_REGISTRY_KEY];
  if (!registry) {
    registry = createStreamRegistry();
    holder[SHARED_REGISTRY_KEY] = registry;
  }
  return registry;
}

export const STREAM_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-store, no-transform",
  "X-Content-Type-Options": "nosniff",
  // Un relais ne doit jamais mettre le flux en tampon.
  "X-Accel-Buffering": "no",
});

/** Texte d'un événement SSE. Le seul contenu : l'id du message (nombre) ou null. */
export function formatMessageEvent(event: MessageEvent): string {
  return event.messageId === null ? "event: resync\ndata: {}\n\n" : `event: message\ndata: ${JSON.stringify({ id: event.messageId })}\n\n`;
}

export interface MessageStreamInput {
  bus: MessageBus;
  registry: StreamRegistry;
  userId: string;
  conversationId: string;
  /** Signal de la requête : sa fermeture (déconnexion du client) ferme le flux. */
  signal: AbortSignal;
  heartbeatMs?: number;
  /** Attente maximale de l'établissement de l'écoute avant d'annoncer « prêt » (millisecondes). */
  readyTimeoutMs?: number;
}

/**
 * Ouvre le flux et prend sa place dans le registre (le plus ancien flux du même utilisateur est fermé si le plafond est atteint) ; elle est rendue à la fermeture.
 */
export function openMessageStream(input: MessageStreamInput): Response {
  const encoder = new TextEncoder();
  const heartbeatMs = input.heartbeatMs ?? STREAM_HEARTBEAT_MS;
  let cleanup: () => void = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const send = (text: string): void => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          cleanup();
        }
      };
      const slot = input.registry.acquire(input.userId, {
        evict: () => cleanup(),
        // Vivant : pas fermé, requête non abandonnée, contrôleur ouvert (`desiredSize` nul = fermé ou en erreur).
        isAlive: () => !closed && !input.signal.aborted && controller.desiredSize !== null,
        // Sonde : un commentaire SSE (ignoré par le navigateur). Une écriture qui échoue ferme le flux (donc rend sa place).
        probe: () => {
          if (closed || input.signal.aborted || controller.desiredSize === null) return false;
          try {
            controller.enqueue(encoder.encode(": probe\n\n"));
            return true;
          } catch {
            return false;
          }
        },
      });
      const subscription = input.bus.subscribe(input.conversationId, (event) => send(formatMessageEvent(event)));
      const timer = setInterval(() => send(": ping\n\n"), heartbeatMs);
      timer.unref?.();
      const readyTimer = setTimeout(() => send("event: ready\ndata: {}\n\n"), input.readyTimeoutMs ?? 5_000);
      readyTimer.unref?.();
      cleanup = () => {
        if (closed) return;
        closed = true;
        slot.release();
        clearInterval(timer);
        clearTimeout(readyTimer);
        subscription.unsubscribe();
        input.signal.removeEventListener("abort", cleanup);
        try {
          controller.close();
        } catch {
          // Déjà fermé par le lecteur.
        }
      };
      if (input.signal.aborted) {
        cleanup();
        return;
      }
      input.signal.addEventListener("abort", cleanup, { once: true });
      send(`retry: ${STREAM_RETRY_MS}\n\n`);
      void subscription.ready.then(() => {
        clearTimeout(readyTimer);
        send("event: ready\ndata: {}\n\n");
      });
    },
    cancel() {
      cleanup();
    },
  });
  return new Response(stream, { status: 200, headers: STREAM_HEADERS });
}
