/**
 * Moteur de l'ADVERSAIRE contre une publication ARRONDIE (lot M1-quater). AUCUN import de lib/server/metrics : la publication testée lui est passée en paramètre
 * (`RoundedAdapter`). L'adversaire lit UNE réponse (la réponse JSON complète du monde vrai) et connaît tout ce que sait le vendeur (boosts, dates, règles
 * d'attribution, définition de chaque chiffre, règle d'arrondi). Il cherche des MONDES (multiensembles de profils d'acheteurs) qui publient EXACTEMENT la même réponse.
 *
 * Quantités PROTÉGÉES (valeur vraie de 1 à `PROTECTED_MAX`) : chaque chiffre du modèle (acheteurs ou événements, publié ou non), et chaque DIFFÉRENCE de deux chiffres
 * emboîtés (total moins part, période longue moins courte, total moins boost : B ⊆ A pour tout profil du modèle). Pour chacune, il faut au moins DEUX valeurs
 * possibles : deux mondes qui publient la même réponse et lui donnent deux valeurs différentes (des TÉMOINS, vérifiés en rejouant la publication) prouvent qu'elle
 * n'est pas déterminée par la réponse. Aucun compte publié n'étant exact, il n'y a pas d'identité linéaire exacte à chercher : seuls les témoins comptent.
 *
 * Recherche (« min-conflits ») : chaque chiffre publié borne la valeur exacte du chiffre à un INTERVALLE (« moins de 5 » : 0 à 4 ; « environ 10 » : 8 à 12). La violation
 * d'un monde est la somme des distances de ses chiffres à ces intervalles. Pour chaque quantité sans témoin, la recherche part d'un monde cohérent, remplace, ajoute ou
 * retire des acheteurs en minimisant la violation (avec une part de hasard), et seule la réponse COMPLÈTE rejouée (pourcentages compris) décide qu'un monde est cohérent.
 * Une quantité sans témoin dans le budget est « non résolue » et compte comme un ÉCHEC (jamais comme une preuve de sûreté).
 */
import type { Space, World } from "./metrics-adversary-engine";
import { sumWorld } from "./metrics-adversary-engine";
import type { Structure } from "./metrics-adversary-model";

/** Un compte publié, tel que l'adversaire le lit : « moins de `bound` » ou « environ `value` ». */
export type Published = { kind: "below"; bound: number } | { kind: "approx"; value: number };

export interface RoundedAdapter {
  name: string;
  /** Statistiques BRUTES (entrée de la publication) d'après les chiffres sommés de tous les acheteurs du monde. */
  rawOf(y: ArrayLike<number>, needs: number, structure: Structure): unknown;
  /** La publication testée : brut → réponse (objet JSON). */
  publish(raw: unknown): unknown;
  /** Les comptes publiés qui correspondent au chiffre `cell` du modèle (zéro, un ou plusieurs emplacements de la réponse). */
  locate(response: unknown, cell: string): Published[];
}

/** Valeur vraie maximale d'une quantité protégée : 4, le plus grand compte publié « moins de 5 ». */
export const PROTECTED_MAX = 4;
/** Valeur vraie minimale d'une quantité protégée : 1 (le critère (a)) ; une sonde peut descendre à 0 (zéros dérivés compris). */
export const PROTECTED_MIN = 1;

/** Intervalle des valeurs exactes compatibles avec un compte publié (la règle d'arrondi est connue de l'adversaire : « environ 5 » = 5 à 8, « environ 10 » = 9 à 12, « environ N » = N − 2 à N + 2). */
export function intervalOf(published: Published): [number, number] {
  if (published.kind === "below") return [0, published.bound - 1];
  if (published.value === 5) return [5, 8];
  return [published.value === 10 ? 9 : published.value - 2, published.value + 2];
}

export interface RoundedVerdict {
  status: "witnesses" | "unresolved";
  /** Quantités sans second témoin (valeur unique vue) : fuites, ou recherche insuffisante. */
  pinned: Array<{ what: string; value: number }>;
  consistentWorlds: number;
  evaluated: number;
  /** Nombre de quantités protégées de ce monde, dont celles qui sont des différences de deux chiffres emboîtés. */
  protectedCount: number;
  derivedCount: number;
}

export interface RoundedOptions {
  /** Taille maximale d'un monde examiné (au plus). */
  cap: number;
  /** Nombre maximal de mondes candidats évalués (violation calculée) ; la réponse complète n'est rejouée que pour les mondes sans violation. */
  budget: number;
  random: () => number;
  /** Sortes de chiffres protégées : « buyers » (acheteurs uniques, le critère (a)) et « events » (comptes d'événements). Défaut : les deux. */
  kinds?: ReadonlyArray<"buyers" | "events">;
  /** Valeur vraie minimale protégée (défaut 1 ; 0 pour inclure les zéros dérivés). */
  minValue?: number;
  /** Profils « légers » (peu d'événements) : mondes proches des seuils. */
  light: readonly number[];
}

interface Item { what: string; truth: number; seen: Set<number>; value: (y: Int16Array) => number; contribution: (vector: Int8Array) => number }

/** Les quantités protégées du monde vrai : chiffres (hors chiffres structurellement nuls) et différences emboîtées, de valeur vraie PROTECTED_MIN à PROTECTED_MAX. */
function protectedItems(space: Space, trueY: Int16Array, kinds: ReadonlySet<string>, min: number): Item[] {
  const items: Item[] = [];
  for (let d = 0; d < space.dims; d++) {
    if (!kinds.has(space.specs[d].kind) || space.zeroCells.has(d) || trueY[d] > PROTECTED_MAX || trueY[d] < min) continue;
    items.push({ what: space.specs[d].name, truth: trueY[d], seen: new Set([trueY[d]]), value: (y) => y[d], contribution: (vector) => vector[d] });
  }
  for (const [a, b] of space.nested) {
    if (!kinds.has(space.specs[a].kind)) continue;
    const truth = trueY[a] - trueY[b];
    if (truth > PROTECTED_MAX || truth < min) continue;
    items.push({ what: `${space.specs[a].name} − ${space.specs[b].name}`, truth, seen: new Set([truth]), value: (y) => y[a] - y[b], contribution: (vector) => vector[a] - vector[b] });
  }
  return items;
}

const keyOf = (y: Int16Array, needs: number): string => `${Buffer.from(y.buffer, y.byteOffset, y.byteLength).toString("latin1")}|${needs}`;

/** Recherche de l'adversaire pour le monde `truth`. */
export function roundedAdversary(space: Space, adapter: RoundedAdapter, truth: World, options: RoundedOptions): RoundedVerdict {
  const trueY = sumWorld(space, truth.ids);
  const trueResponse = adapter.publish(adapter.rawOf(trueY, truth.needs, space.structure));
  const target = JSON.stringify(trueResponse);
  const publishJson = (y: Int16Array): string => JSON.stringify(adapter.publish(adapter.rawOf(y, truth.needs, space.structure)));
  // Intervalles des chiffres publiés (plusieurs emplacements d'un même chiffre : l'intersection).
  const boxes: Array<{ cell: number; lo: number; hi: number }> = [];
  space.specs.forEach((spec, cell) => {
    const places = adapter.locate(trueResponse, spec.name);
    if (places.length === 0) return;
    let lo = 0;
    let hi = Number.POSITIVE_INFINITY;
    for (const place of places) {
      const [pl, ph] = intervalOf(place);
      lo = Math.max(lo, pl);
      hi = Math.min(hi, ph);
    }
    boxes.push({ cell, lo, hi });
  });
  const violation = (y: Int16Array): number => {
    let total = 0;
    for (const { cell, lo, hi } of boxes) total += y[cell] < lo ? lo - y[cell] : y[cell] > hi ? y[cell] - hi : 0;
    return total;
  };

  const items = protectedItems(space, trueY, new Set(options.kinds ?? ["buyers", "events"]), options.minValue ?? PROTECTED_MIN);
  const cache = new Map<string, boolean>([[keyOf(trueY, truth.needs), true]]);
  const frontier: number[][] = [[...truth.ids].sort((p, q) => p - q)];
  const known = new Set<string>([frontier[0].join(",")]);
  const randomInt = (max: number): number => Math.floor(options.random() * (max + 1));
  const profileCount = space.vectors.length;
  const truthPool = [...new Set(truth.ids)];
  let consistent = 1;
  let evaluated = 0;

  const sample = (): number => {
    const roll = options.random();
    if (roll < 0.45 && options.light.length > 0) return options.light[randomInt(options.light.length - 1)];
    if (roll < 0.7 && truthPool.length > 0) return truthPool[randomInt(truthPool.length - 1)];
    return randomInt(profileCount - 1);
  };

  /** Monde cohérent : même réponse complète. Enregistre les valeurs de toutes les quantités protégées. */
  const confirm = (ids: number[], y: Int16Array): boolean => {
    const key = keyOf(y, truth.needs);
    let same = cache.get(key);
    if (same === undefined) {
      same = publishJson(y) === target;
      cache.set(key, same);
    }
    if (!same) return false;
    const worldKey = ids.join(",");
    if (!known.has(worldKey)) {
      known.add(worldKey);
      consistent++;
      for (const item of items) item.seen.add(item.value(y));
      if (frontier.length < 600) frontier.push(ids);
      else frontier[randomInt(frontier.length - 1)] = ids;
    }
    return true;
  };

  const addProfile = (y: Int16Array, id: number, sign: 1 | -1): void => {
    const vector = space.vectors[id];
    for (let d = 0; d < space.dims; d++) y[d] += sign * vector[d];
  };

  /** Une marche de min-conflits qui part d'un monde cohérent et cherche à changer la valeur de `item` (ou, sans cible, à explorer). */
  const walk = (start: number[], item: Item | null, steps: number): void => {
    let ids = [...start];
    const y = sumWorld(space, ids);
    for (let step = 0; step < steps && evaluated < options.budget; step++) {
      // Candidats : remplacements (dirigés vers la cible ou au hasard), ajouts, retraits ; le meilleur selon la violation, avec une part de hasard.
      let best: { ids: number[]; score: number } | null = null;
      const candidates = 14;
      for (let c = 0; c < candidates; c++) {
        const roll = options.random();
        const next = [...ids];
        const yNext = Int16Array.from(y);
        if (roll < 0.62 && next.length > 0) {
          const slot = randomInt(next.length - 1);
          let id = sample();
          if (item !== null && options.random() < 0.7) {
            const base = item.contribution(space.vectors[next[slot]]);
            for (let attempt = 0; attempt < 25; attempt++) {
              const pick = sample();
              if (item.contribution(space.vectors[pick]) !== base) { id = pick; break; }
            }
          }
          addProfile(yNext, next[slot], -1);
          addProfile(yNext, id, 1);
          next[slot] = id;
        } else if (roll < 0.82 && next.length < options.cap) {
          const id = sample();
          addProfile(yNext, id, 1);
          next.push(id);
        } else if (next.length > 1) {
          const slot = randomInt(next.length - 1);
          addProfile(yNext, next[slot], -1);
          next.splice(slot, 1);
        } else continue;
        evaluated++;
        let score = violation(yNext) + options.random() * 0.8;
        if (item !== null && item.seen.has(item.value(yNext))) score += 0.6;
        if (best === null || score < best.score) best = { ids: next, score };
      }
      if (best === null) return;
      ids = best.ids;
      ids.sort((p, q) => p - q);
      const yBest = sumWorld(space, ids);
      y.set(yBest);
      if (violation(yBest) === 0 && confirm(ids, yBest)) {
        // monde cohérent : on continue la marche à partir de lui
      } else if (violation(yBest) > 6) {
        // trop loin de tout monde cohérent : on revient à un monde cohérent
        ids = [...frontier[randomInt(frontier.length - 1)]];
        y.set(sumWorld(space, ids));
      }
    }
  };

  const covered = (): boolean => items.every((item) => item.seen.size >= 2);
  let rounds = 0;
  while (!covered() && evaluated < options.budget && rounds < 100_000) {
    rounds++;
    const open = items.filter((item) => item.seen.size < 2);
    const item = open[randomInt(open.length - 1)];
    const start = options.random() < 0.3 ? frontier[0] : frontier[Math.max(0, frontier.length - 1 - randomInt(Math.min(frontier.length - 1, 80)))];
    walk(start, item, 12);
  }
  const pinned = items.filter((item) => item.seen.size < 2).map((item) => ({ what: item.what, value: item.truth }));
  return { status: pinned.length === 0 ? "witnesses" : "unresolved", pinned, consistentWorlds: consistent, evaluated, protectedCount: items.length, derivedCount: items.filter((item) => item.what.includes(" − ")).length };
}
