/**
 * État du parcours OTP entre /connexion et /verification, conservé dans sessionStorage (onglet courant seulement).
 * Il contient le numéro canonique (nécessaire pour demander un nouveau code), l'identifiant du challenge, ses
 * échéances et la destination de retour. Il ne contient jamais le code. Effacé à la réussite ou au changement de
 * numéro. Toute lecture est revalidée : une valeur altérée est ignorée.
 */

import { isCanonicalPhone } from "./phone";
import { safeNextPath } from "./session";

export interface OtpFlow {
  phone: string;
  challengeId: string;
  expiresAt: string;
  resendAvailableAt: string;
  next: string;
}

const STORAGE_KEY = "noma:otp-flow";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function defaultStorage(): StorageLike | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

/**
 * Écrit le parcours ; renvoie `true` seulement s'il est réellement enregistré. `false` si le stockage est absent
 * ou refuse l'écriture (navigation privée, quota, stockage bloqué) : l'appelant ne doit alors pas poursuivre.
 */
export function saveOtpFlow(flow: OtpFlow, storage: StorageLike | null = defaultStorage()): boolean {
  let saved = false;
  try {
    if (storage) {
      // Champs nommés un à un : rien d'autre (ni code, ni jeton) ne peut être écrit par inadvertance.
      storage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          phone: flow.phone,
          challengeId: flow.challengeId,
          expiresAt: flow.expiresAt,
          resendAvailableAt: flow.resendAvailableAt,
          next: safeNextPath(flow.next),
        }),
      );
      saved = true;
    }
  } catch {
    // Stockage indisponible : signalé par la valeur de retour, jamais d'exception.
  }
  notify();
  return saved;
}

const PROBE_KEY = "noma:otp-flow-probe";

/** Vrai si une écriture dans le stockage de l'onglet réussit (sonde effacée aussitôt) : à tester AVANT d'envoyer un code. */
export function isOtpFlowStorageAvailable(storage: StorageLike | null = defaultStorage()): boolean {
  if (!storage) return false;
  try {
    storage.setItem(PROBE_KEY, "1");
    storage.removeItem(PROBE_KEY);
    return true;
  } catch {
    return false;
  }
}

/** Valide et nettoie un contenu brut de sessionStorage ; `null` s'il est absent, altéré ou incomplet. */
export function parseOtpFlow(raw: string | null | undefined): OtpFlow | null {
  try {
    if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return null;
    const flow = value as Record<string, unknown>;
    if (
      !isCanonicalPhone(flow.phone) ||
      typeof flow.challengeId !== "string" ||
      !UUID.test(flow.challengeId) ||
      !isIsoDate(flow.expiresAt) ||
      !isIsoDate(flow.resendAvailableAt)
    ) {
      return null;
    }
    return {
      phone: flow.phone,
      challengeId: flow.challengeId,
      expiresAt: flow.expiresAt,
      resendAvailableAt: flow.resendAvailableAt,
      next: safeNextPath(flow.next),
    };
  } catch {
    return null;
  }
}

/** Contenu brut (chaîne) du parcours dans l'onglet courant, `null` sans parcours ou sans stockage. */
export function readOtpFlowRaw(storage: StorageLike | null = defaultStorage()): string | null {
  try {
    return storage?.getItem(STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
}

export function readOtpFlow(storage: StorageLike | null = defaultStorage()): OtpFlow | null {
  return parseOtpFlow(readOtpFlowRaw(storage));
}

const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

/** Abonnement aux changements du parcours (écritures de ce module et événements `storage` des autres onglets). */
export function subscribeOtpFlow(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === STORAGE_KEY) listener();
  };
  if (typeof window !== "undefined") window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    if (typeof window !== "undefined") window.removeEventListener("storage", onStorage);
  };
}

export function clearOtpFlow(storage: StorageLike | null = defaultStorage()): void {
  try {
    storage?.removeItem(STORAGE_KEY);
  } catch {
    // Rien à effacer.
  }
  notify();
}
