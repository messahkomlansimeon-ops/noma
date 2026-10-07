import { sumWorld, type Space, type World } from "./metrics-adversary-engine";
import { EVENT_GROUP_METRIC } from "./metrics-adversary-model";

/** Mulberry32 (graine fixe : les mondes sont reproductibles). */
export function mulberry(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Nombre d'événements d'un profil (apparitions + ouvertures + contact) : les profils « légers » forment des mondes proches des seuils. */
export function profileWeight(space: Space, id: number): number {
  const profile = space.profiles[id];
  return profile.serves.length + profile.views.length + (profile.contact ? 1 : 0);
}

/**
 * Monde vrai tiré au hasard : 1 à `maxBuyers` acheteurs répartis sur 1 à 4 profils distincts (multiplicités quelconques), pour obtenir des comptes proches du
 * seuil (1, 2, 3, 4 acheteurs d'un même profil) et des recoupements entre groupes. Deux familles : profils légers (au plus 4 événements) et profils quelconques.
 */
export function randomWorld(space: Space, random: () => number, maxBuyers: number, light: readonly number[]): World {
  const int = (max: number): number => Math.floor(random() * (max + 1));
  const buyers = 1 + int(maxBuyers - 1);
  const palette = 1 + int(Math.min(4, buyers) - 1);
  const pool = random() < 0.7 ? light : [...space.vectors.keys()];
  const chosen: number[] = [];
  for (let i = 0; i < palette; i++) chosen.push(pool[int(pool.length - 1)]);
  const ids: number[] = [];
  for (let i = 0; i < buyers; i++) ids.push(i < palette ? chosen[i] : chosen[int(palette - 1)]);
  ids.sort((a, b) => a - b);
  return { ids, needs: int(8) };
}

/**
 * Monde vrai de `minBuyers` à `maxBuyers` acheteurs (lot M1-quater : les arrondis se jouent autour de 5, 8, 13, 18… acheteurs) : 1 à 6 profils distincts, multiplicités
 * tirées au hasard (somme = nombre d'acheteurs), profils légers ou quelconques.
 */
export function randomLargeWorld(space: Space, random: () => number, minBuyers: number, maxBuyers: number, light: readonly number[]): World {
  const int = (max: number): number => Math.floor(random() * (max + 1));
  const buyers = minBuyers + int(maxBuyers - minBuyers);
  const palette = 1 + int(Math.min(6, buyers) - 1);
  const pool = random() < 0.6 ? light : [...space.vectors.keys()];
  const chosen: number[] = [];
  for (let i = 0; i < palette; i++) chosen.push(pool[int(pool.length - 1)]);
  const counts = new Array<number>(palette).fill(1);
  if (palette > 1 && random() < 0.5) {
    // Un grand groupe et de petits groupes de 1 à 4 acheteurs : des chiffres vrais de 1 à 4 (les valeurs protégées) à côté de chiffres arrondis à 10, 15…
    let rest = buyers;
    for (let i = 1; i < palette; i++) { counts[i] = 1 + int(3); rest -= counts[i]; }
    if (rest >= 1) counts[0] = rest;
    else { counts.fill(1); for (let i = palette; i < buyers; i++) counts[int(palette - 1)]++; }
  } else {
    for (let i = palette; i < buyers; i++) counts[int(palette - 1)]++;
  }
  const ids: number[] = [];
  chosen.forEach((id, at) => { for (let copy = 0; copy < counts[at]; copy++) ids.push(id); });
  ids.sort((a, b) => a - b);
  return { ids, needs: int(40) };
}

/**
 * Un monde est SATURÉ quand les événements d'un groupe approchent le maximum que le modèle autorise par acheteur (au plus une ouverture par jour, deux
 * révélations, deux apparitions par jour et par boost) : la borne du modèle donnerait alors une information que l'adversaire réel n'a pas (« chaque acheteur a
 * ouvert tous les jours »). Les mondes vrais testés sont tirés loin de ces bornes ; l'adversaire, lui, garde le modèle entier.
 */
export function maxPerBuyer(space: Space): Int16Array {
  const out = new Int16Array(space.dims);
  for (const vector of space.vectors) for (let d = 0; d < space.dims; d++) if (vector[d] > out[d]) out[d] = vector[d];
  return out;
}

/** Pour chaque paire emboîtée de comptes d'ÉVÉNEMENTS (a ⊇ b), le maximum par acheteur de la différence a − b : la borne du modèle sur la zone « a sans b ». */
const DERIVED_LIMITS = new WeakMap<Space, Array<{ a: number; b: number; limit: number; group: number; innerGroup: number | undefined }>>();

function derivedLimits(space: Space): Array<{ a: number; b: number; limit: number; group: number; innerGroup: number | undefined }> {
  let found = DERIVED_LIMITS.get(space);
  if (!found) {
    const index = new Map(space.specs.map((spec, at) => [spec.name, at] as const));
    found = [];
    for (const [a, b] of space.nested) {
      const spec = space.specs[a];
      if (spec.kind !== "events") continue;
      const group = index.get(`${spec.scope}.${EVENT_GROUP_METRIC[spec.metric]}`);
      if (group === undefined) continue;
      const inner = space.specs[b];
      const innerGroup = index.get(`${inner.scope}.${EVENT_GROUP_METRIC[inner.metric]}`);
      let limit = 0;
      for (const vector of space.vectors) limit = Math.max(limit, vector[a] - vector[b]);
      found.push({ a, b, limit, group, innerGroup });
    }
    DERIVED_LIMITS.set(space, found);
  }
  return found;
}

const SPEC_INDEX = new WeakMap<Space, Map<string, number>>();

export function isSaturated(space: Space, limits: Int16Array, y: ArrayLike<number>): boolean {
  let index = SPEC_INDEX.get(space);
  if (!index) {
    index = new Map(space.specs.map((spec, at) => [spec.name, at] as const));
    SPEC_INDEX.set(space, index);
  }
  for (let d = 0; d < space.dims; d++) {
    const spec = space.specs[d];
    if (spec.kind !== "events" || y[d] === 0) continue;
    const group = EVENT_GROUP_METRIC[spec.metric];
    const g = index.get(`${spec.scope}.${group}`);
    if (g === undefined || y[g] === 0) continue;
    if (4 * y[d] > 3 * limits[d] * y[g]) return true;
  }
  // Zones « a sans b » : les événements d'une zone (ex. période longue moins période courte) ne doivent pas approcher la borne du modèle non plus (un jour d'ouverture
  // possible, une seule ouverture par acheteur et par jour : un monde où chaque acheteur a ouvert ce jour-là donnerait à l'adversaire une borne que l'adversaire réel n'a pas).
  // Les acheteurs de la zone sont ceux du groupe de a qui ne sont pas dans le groupe de b (différence des deux comptes d'acheteurs, quand b a le sien) : 3 contacts en tout et 9 en 30 jours
  // font 3 acheteurs dans la zone « plus de 30 jours », et leurs 6 révélations sont alors les deux révélations que le modèle autorise à chacun.
  for (const { a, b, limit, group, innerGroup } of derivedLimits(space)) {
    const difference = y[a] - y[b];
    const zoneBuyers = innerGroup === undefined ? y[group] : Math.max(1, y[group] - y[innerGroup]);
    if (difference <= 0 || limit === 0 || zoneBuyers === 0) continue;
    // Saturée quand on ne peut plus retirer un acheteur de la zone sans passer sous ses événements (au plus `limit` chacun).
    if (difference > limit * Math.max(1, zoneBuyers - 1)) return true;
  }
  return false;
}

/** Monde vrai non saturé de `minBuyers` à `maxBuyers` acheteurs (jusqu'à 50 000 tirages, sinon une erreur : jamais un monde saturé). */
export function randomUnsaturatedLargeWorld(space: Space, random: () => number, minBuyers: number, maxBuyers: number, light: readonly number[], limits: Int16Array): World {
  let world = randomLargeWorld(space, random, minBuyers, maxBuyers, light);
  for (let attempt = 0; attempt < 50_000 && isSaturated(space, limits, sumWorld(space, world.ids)); attempt++) world = randomLargeWorld(space, random, minBuyers, maxBuyers, light);
  if (isSaturated(space, limits, sumWorld(space, world.ids))) throw new Error("aucun monde non saturé trouvé en 50 000 tirages");
  return world;
}

/** Monde vrai non saturé (jusqu'à 50 000 tirages, sinon une erreur : jamais un monde saturé). */
export function randomUnsaturatedWorld(space: Space, random: () => number, maxBuyers: number, light: readonly number[], limits: Int16Array): World {
  let world = randomWorld(space, random, maxBuyers, light);
  for (let attempt = 0; attempt < 50_000 && isSaturated(space, limits, sumWorld(space, world.ids)); attempt++) world = randomWorld(space, random, maxBuyers, light);
  if (isSaturated(space, limits, sumWorld(space, world.ids))) throw new Error("aucun monde non saturé trouvé en 50 000 tirages");
  return world;
}
