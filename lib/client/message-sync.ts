/**
 * Synchronisation d'une conversation (lot D2) : flux en direct + rattrapage, en module PUR (le flux et la lecture sont injectés : testé sans navigateur ni réseau).
 *
 *  - `start()` lit la conversation puis ouvre le flux ; à chaque événement (`ready`, `message`, `resync`) le client RELIT « les messages après l'id X » par l'API : le flux ne
 *    transporte jamais de texte, il réveille seulement ;
 *  - si le flux tombe (erreur, coupure, 404, 429), le client se reconnecte avec une attente CROISSANTE (1 s, 2 s, 4 s, 8 s, puis 15 s) ; à chaque tentative il rattrape d'abord par
 *    « messages après l'id X » (même si le flux reste inutilisable : les messages arrivent alors par ce repli), puis rouvre le flux ;
 *  - une lecture en cours n'est jamais doublée (une demande arrivée pendant la lecture en déclenche UNE seconde, à la suite) ;
 *  - un message reçu deux fois (écho de l'envoi, rattrapage) n'est annoncé qu'une fois ; `stop()` ferme tout (flux, attente, lecture en cours ignorée).
 */

import type { ConversationMessage } from "./social-api";

export type SyncStatus = "connecting" | "live" | "reconnecting" | "stopped";

export const RECONNECT_DELAYS_MS: readonly number[] = Object.freeze([1_000, 2_000, 4_000, 8_000, 15_000]);

export interface StreamHandlers {
  /** Le flux est ouvert et l'écoute établie. */
  onReady(): void;
  /** Un message existe (id) ou la connexion d'écoute a été rétablie (null) : il faut relire. */
  onWake(): void;
  /** Le flux est tombé. */
  onError(): void;
}

export interface MessageSyncOptions {
  /** Lit les messages (sans `afterId` : les derniers ; avec : ceux dont l'id est supérieur). */
  fetchMessages(afterId: number | null): Promise<{ messages: ConversationMessage[]; hasMore: boolean }>;
  /** Ouvre le flux et renvoie sa fermeture. */
  openStream(handlers: StreamHandlers): () => void;
  /** Messages NOUVEAUX (jamais déjà annoncés), du plus ancien au plus récent. */
  onMessages(messages: ConversationMessage[]): void;
  onStatus?(status: SyncStatus): void;
  /** La première lecture est terminée (réussie ou non) : l'écran sort de « chargement ». */
  onLoaded?(): void;
  /** Une lecture a échoué (le repli réessaiera) : le dernier échec est gardé par l'appelant pour l'affichage. */
  onFetchError?(): void;
  delaysMs?: readonly number[];
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface MessageSync {
  start(): void;
  stop(): void;
  /** Relit maintenant (après un envoi, au retour au premier plan). */
  refresh(): Promise<void>;
  /** Signale un message connu par ailleurs (réponse de l'envoi) : il ne sera pas annoncé une seconde fois, mais n'avance PAS le point de rattrapage. */
  noteKnown(messageId: number): void;
  lastId(): number | null;
  status(): SyncStatus;
}

export function createMessageSync(options: MessageSyncOptions): MessageSync {
  const delays = options.delaysMs ?? RECONNECT_DELAYS_MS;
  const setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const announced = new Set<number>();
  let last: number | null = null;
  let status: SyncStatus = "stopped";
  let closeStream: (() => void) | null = null;
  let timer: unknown = null;
  let attempt = 0;
  let running = false;
  let again = false;
  let generation = 0;

  const isStopped = (): boolean => status === "stopped";
  const setStatus = (next: SyncStatus): void => {
    if (status === next) return;
    status = next;
    options.onStatus?.(next);
  };

  async function catchUp(): Promise<boolean> {
    if (running) {
      again = true;
      return true;
    }
    running = true;
    const mine = generation;
    try {
      do {
        again = false;
        let more = true;
        while (more) {
          const page = await options.fetchMessages(last);
          if (mine !== generation) return true;
          const fresh = page.messages.filter((message) => !announced.has(message.id));
          for (const message of fresh) announced.add(message.id);
          for (const message of page.messages) if (last === null || message.id > last) last = message.id;
          if (fresh.length > 0) options.onMessages(fresh);
          more = page.hasMore && page.messages.length > 0;
        }
      } while (again && mine === generation);
      return true;
    } catch {
      if (mine === generation) options.onFetchError?.();
      return false;
    } finally {
      running = false;
    }
  }

  function dropStream(): void {
    const close = closeStream;
    closeStream = null;
    close?.();
  }

  function scheduleReconnect(): void {
    if (isStopped() || timer !== null) return;
    setStatus("reconnecting");
    const delay = delays[Math.min(attempt, delays.length - 1)] ?? 15_000;
    attempt += 1;
    timer = setTimer(() => {
      timer = null;
      void reconnect();
    }, delay);
  }

  async function reconnect(): Promise<void> {
    if (isStopped()) return;
    const mine = generation;
    // Repli : rattrapage d'abord (les messages arrivent même si le flux reste inutilisable), puis nouvelle ouverture.
    await catchUp();
    if (mine !== generation || isStopped()) return;
    open();
  }

  function open(): void {
    dropStream();
    const mine = generation;
    closeStream = options.openStream({
      onReady() {
        if (mine !== generation) return;
        attempt = 0;
        setStatus("live");
        void catchUp();
      },
      onWake() {
        if (mine !== generation) return;
        void catchUp();
      },
      onError() {
        if (mine !== generation) return;
        dropStream();
        scheduleReconnect();
      },
    });
  }

  return {
    start() {
      if (!isStopped()) return;
      generation += 1;
      attempt = 0;
      setStatus("connecting");
      void catchUp().then(() => {
        if (isStopped()) return;
        options.onLoaded?.();
        open();
      });
    },
    stop() {
      generation += 1;
      if (timer !== null) clearTimer(timer);
      timer = null;
      dropStream();
      running = false;
      again = false;
      setStatus("stopped");
    },
    refresh: async () => {
      await catchUp();
    },
    noteKnown(messageId) {
      // Jamais d'avance de `last` : un message de l'autre participant d'id inférieur n'a peut-être pas encore été lu ; la relecture suivante (après `last`) le trouvera.
      if (Number.isSafeInteger(messageId) && messageId > 0) announced.add(messageId);
    },
    lastId: () => last,
    status: () => status,
  };
}
