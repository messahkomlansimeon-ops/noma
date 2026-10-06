import { BoostError } from "./boosts";

/**
 * Créneaux de calcul de portée (lot P3) : au plus `capacity` calculs lourds en même temps dans ce processus. Un calcul qui ne trouve pas de créneau
 * en `waitMs` est refusé (`quote_busy`, 503 côté HTTP) plutôt que d'attendre sans fin ; l'attente ne retient AUCUNE connexion ni verrou de base
 * (le créneau se prend AVANT d'ouvrir l'instantané). Équitable : premier arrivé, premier servi.
 */
export interface ReachGate {
  /** Prend un créneau (attend au plus `waitMs`) et renvoie la fonction qui le libère (idempotente). */
  acquire(waitMs: number): Promise<() => void>;
  /** Créneaux actuellement pris et demandes en attente (observation, tests). */
  stats(): { active: number; waiting: number };
}

export function createReachGate(capacity: number): ReachGate {
  if (!Number.isSafeInteger(capacity) || capacity < 1) throw new RangeError("capacité de créneaux invalide");
  let active = 0;
  const waiting: Array<{ grant: () => void }> = [];

  const makeRelease = (): (() => void) => {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = waiting.shift();
      if (next) next.grant();
      else active -= 1;
    };
  };

  return {
    acquire(waitMs: number): Promise<() => void> {
      if (active < capacity) {
        active += 1;
        return Promise.resolve(makeRelease());
      }
      return new Promise<() => void>((resolve, reject) => {
        const entry = {
          grant: () => {
            clearTimeout(timer);
            resolve(makeRelease());
          },
        };
        const timer = setTimeout(() => {
          const index = waiting.indexOf(entry);
          if (index >= 0) waiting.splice(index, 1);
          reject(new BoostError("quote_busy"));
        }, Math.max(0, waitMs));
        waiting.push(entry);
      });
    },
    stats: () => ({ active, waiting: waiting.length }),
  };
}
