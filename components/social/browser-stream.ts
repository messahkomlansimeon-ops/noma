import type { StreamHandlers } from "@/lib/client/message-sync";

/**
 * Ouvre le flux en direct d'une conversation (Server-Sent Events, même origine) et renvoie sa fermeture. Le flux ne transporte jamais de texte : chaque événement réveille
 * seulement la relecture (`onWake`). Une erreur ferme la source (aucune reconnexion automatique du navigateur : l'attente croissante est gérée par `createMessageSync`).
 */
export function openBrowserStream(url: string, handlers: StreamHandlers): () => void {
  const source = new EventSource(url, { withCredentials: false });
  let closed = false;
  source.addEventListener("ready", () => {
    if (!closed) handlers.onReady();
  });
  source.addEventListener("message", () => {
    if (!closed) handlers.onWake();
  });
  source.addEventListener("resync", () => {
    if (!closed) handlers.onWake();
  });
  source.addEventListener("error", () => {
    if (closed) return;
    closed = true;
    source.close();
    handlers.onError();
  });
  return () => {
    closed = true;
    source.close();
  };
}
