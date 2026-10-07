/**
 * Moteur de l'ADVERSAIRE contre une publication à comptes EXACTS ou MASQUÉS (lot M1-ter). Depuis le lot M1-quater la publication de production n'est plus ni exacte ni masquée
 * (elle est arrondie : metrics-adversary-rounded.ts) ; ce moteur ne sert plus qu'au TÉMOIN, la publication du lot M1-bis (copie figée), qu'il met toujours en échec par identités
 * linéaires exactes. Il garde aussi les types et fonctions de l'espace de mondes (`makeSpace`, `sumWorld`). AUCUN import de lib/server/metrics : la publication testée lui est passée en paramètre
 * (`PublicationAdapter`). Principe : l'adversaire connaît la réponse publiée EXACTE (masques compris) et cherche des mondes (multiensembles de profils
 * d'acheteurs, au plus `cap`) qui produisent la MÊME réponse. Pour chaque chiffre masqué il calcule l'ensemble des valeurs que prend ce chiffre dans ces mondes.
 *  - TÉMOINS : deux mondes qui donnent la même réponse avec deux valeurs différentes PROUVENT que le chiffre n'est pas déterminé (preuve constructive, exacte).
 *  - Recherche des témoins : on regroupe les profils en classes de même projection sur les chiffres publiés exacts, on énumère (ordre mélangé, relances) les
 *    compositions de classes qui gardent ces chiffres, et on tire des profils dans chaque classe ; seule la réponse COMPLÈTE (masques compris) décide. Un chiffre sans
 *    témoin dans le budget est « non résolu » et compte comme un ÉCHEC (jamais comme une preuve de sûreté).
 */
import { determinacy, modelRelations } from "./metrics-adversary-linear";
import { cellSpecs, cellVector, type CellKind, type CellSpec, type Profile, type Structure } from "./metrics-adversary-model";

export interface Counted { value: number | null; belowThreshold: boolean }

export interface PublicationAdapter {
  name: string;
  /** Statistiques BRUTES (entrée de la publication) d'après les chiffres sommés de tous les acheteurs du monde. */
  rawOf(y: ArrayLike<number>, needs: number, structure: Structure): unknown;
  /** La publication testée : brut → réponse (objet JSON). */
  publish(raw: unknown): unknown;
  /** Les chiffres publiés qui correspondent au chiffre `cell` du modèle (zéro, un ou plusieurs emplacements de la réponse). */
  locate(response: unknown, cell: string): Counted[];
  /** Le chiffre des besoins correspondants. */
  needsOf(response: unknown): Counted;
}

export interface Space {
  structure: Structure;
  profiles: Profile[];
  vectors: Int8Array[];
  specs: CellSpec[];
  dims: number;
  /** Paires emboîtées [A, B] du modèle : B ⊆ A pour tout profil (calculées sur les profils, indépendamment de la publication). */
  nested: Array<readonly [number, number]>;
  /** Relations entières du modèle (identités valables pour des mondes de toute taille). */
  relations: number[][];
  /** Chiffres du modèle nuls pour TOUT profil (structurellement vides : sans boost, aucune ouverture attribuée) : jamais protégés. */
  zeroCells: ReadonlySet<number>;
}

export function makeSpace(structure: Structure, profiles: Profile[], vectors: Int8Array[]): Space {
  const specs = cellSpecs(structure.boosts.length);
  const dims = specs.length;
  const nested: Array<readonly [number, number]> = [];
  for (let a = 0; a < dims; a++) {
    for (let b = 0; b < dims; b++) {
      if (a === b || specs[a].kind !== specs[b].kind) continue;
      let included = true;
      let strictly = false;
      for (const vector of vectors) {
        if (vector[b] > vector[a]) { included = false; break; }
        if (vector[b] < vector[a]) strictly = true;
      }
      if (included && strictly) nested.push([a, b]);
    }
  }
  const zeroCells = new Set<number>();
  for (let d = 0; d < dims; d++) if (vectors.every((vector) => vector[d] === 0)) zeroCells.add(d);
  return { structure, profiles, vectors, specs, dims, nested, relations: modelRelations(vectors, dims), zeroCells };
}

export interface World { ids: number[]; needs: number }

export function sumWorld(space: Space, ids: readonly number[]): Int16Array {
  const y = new Int16Array(space.dims);
  for (const id of ids) {
    const vector = space.vectors[id];
    for (let d = 0; d < space.dims; d++) y[d] += vector[d];
  }
  return y;
}

export interface Observed {
  json: string;
  /** Chiffres exacts publiés : indice du chiffre du modèle → valeur. */
  exact: Map<number, number>;
  /** Chiffres du modèle publiés masqués (« moins de 3 »). */
  masked: number[];
  /** Chiffres publiés (tous les emplacements) dont la valeur est < 3 ou qui sont incohérents entre emplacements. */
  needs: Counted;
}

export function observe(space: Space, adapter: PublicationAdapter, y: ArrayLike<number>, needs: number): { response: unknown; observed: Observed } {
  const response = adapter.publish(adapter.rawOf(y, needs, space.structure));
  const exact = new Map<number, number>();
  const masked: number[] = [];
  space.specs.forEach((spec, index) => {
    const places = adapter.locate(response, spec.name);
    if (places.length === 0) return;
    const isMasked = places.every((place) => place.value === null);
    const isExact = places.every((place) => place.value !== null);
    if (!isMasked && !isExact) throw new Error(`emplacements incohérents pour ${spec.name}`);
    if (isMasked) masked.push(index);
    else {
      const values = new Set(places.map((place) => place.value));
      if (values.size !== 1) throw new Error(`valeurs différentes pour ${spec.name}`);
      exact.set(index, places[0].value as number);
    }
  });
  return { response, observed: { json: JSON.stringify(response), exact, masked, needs: adapter.needsOf(response) } };
}

export interface SearchOptions {
  cap: number;
  /** Plafond de mondes cohérents examinés (au-delà, on s'arrête : la couverture est déjà établie ou le cas est dit non résolu). */
  maxCandidates?: number;
  /** Générateur pour mélanger l'ordre des candidats (témoins variés d'abord). */
  random: () => number;
  /** Nombre de relances de l'énumération des classes (défaut 60). */
  samplingAttempts?: number;
  /** Tirages de l'étape 2a (défaut 1 500). */
  drawAttempts?: number;
  /** Nœuds visités par relance (défaut 20 000). */
  restartNodeBudget?: number;
}

export interface Verdict {
  /** Chiffres masqués ou groupes dérivés (1 ou 2) DÉTERMINÉS par les chiffres exacts publiés (identité linéaire exacte : preuve de fuite pour toute taille de monde). */
  linearLeaks: string[];
  /** Chiffres du modèle masqués (ou non publiés mais de valeur 0, 1 ou 2) dont l'ensemble de valeurs possibles est réduit à UNE valeur (fuite), avec cette valeur. */
  pinnedMasked: Array<{ cell: string; value: number }>;
  /** Groupes dérivés (différence de deux chiffres emboîtés) de valeur 1 ou 2 déterminés exactement. */
  pinnedDerived: Array<{ pair: string; value: number }>;
  /** Chiffres publiés de valeur < 3 (0, 1 ou 2 exacts publiés). */
  smallPublished: Array<{ cell: string; value: number }>;
  needsPinned: boolean;
  /** « witnesses » : tout est couvert par des témoins ; « leak-proven » : identité linéaire exacte ; « unresolved » : aucun témoin trouvé dans le budget (compté comme échec). */
  status: "witnesses" | "leak-proven" | "unresolved";
  consistentWorlds: number;
  detail: string[];
}

const hex = (bytes: ArrayBufferView): string => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("latin1");

function worldKey(ids: readonly number[], needs: number): string {
  return `${needs}|${ids.join(",")}`;
}

/** Recherche de l'adversaire pour le monde `truth` (dont la réponse est `observed`). */
export function adversary(space: Space, adapter: PublicationAdapter, truth: World, options: SearchOptions): Verdict {
  const trueY = sumWorld(space, truth.ids);
  const { observed } = observe(space, adapter, trueY, truth.needs);
  const exactIdx = [...observed.exact.keys()];
  const exactTarget = exactIdx.map((index) => observed.exact.get(index) as number);
  const smallPublished: Verdict["smallPublished"] = [];
  for (const [index, value] of observed.exact) if (value < 3) smallPublished.push({ cell: space.specs[index].name, value });
  if (observed.needs.value !== null && observed.needs.value < 3) smallPublished.push({ cell: "besoins correspondants", value: observed.needs.value });

  // Valeurs vues par chiffre masqué et par groupe dérivé (de valeur vraie 1 ou 2), pour chaque monde cohérent.
  // 0. Détermination linéaire exacte (preuve de fuite pour toute taille de monde).
  const det = determinacy(space.relations, space.dims, new Set(exactIdx));
  const linearLeaks: string[] = [];
  const located = new Set<number>([...observed.exact.keys(), ...observed.masked]);
  // Chiffres protégés : les chiffres publiés masqués, et les chiffres du modèle NON publiés dont la valeur vraie est 0, 1 ou 2 (hors chiffres structurellement vides).
  const protectedCells = [...observed.masked];
  for (let d = 0; d < space.dims; d++) if (!located.has(d) && !space.zeroCells.has(d) && trueY[d] <= 2) protectedCells.push(d);
  for (const index of protectedCells) if (det.determined([[index, 1]])) linearLeaks.push(`${space.specs[index].name} = ${trueY[index]}`);
  for (const [a, b] of space.nested) {
    const value = trueY[a] - trueY[b];
    if (value >= 1 && value <= 2 && det.determined([[a, 1], [b, -1]])) linearLeaks.push(`${space.specs[a].name} − ${space.specs[b].name} = ${value}`);
  }
  if (linearLeaks.length > 0) {
    return { linearLeaks, pinnedMasked: [], pinnedDerived: [], smallPublished, needsPinned: false, status: "leak-proven", consistentWorlds: 1, detail: [] };
  }

  const maskedSeen = new Map<number, Set<number>>(protectedCells.map((index) => [index, new Set([trueY[index]])]));
  const derivedTrue: Array<{ a: number; b: number; value: number; seen: Set<number> }> = [];
  for (const [a, b] of space.nested) {
    const value = trueY[a] - trueY[b];
    if (value >= 1 && value <= 2) derivedTrue.push({ a, b, value, seen: new Set([value]) });
  }
  const needsSeen = new Set<number>([truth.needs]);
  const needsMasked = observed.needs.value === null;

  const covered = (): boolean => {
    for (const seen of maskedSeen.values()) if (seen.size < 2) return false;
    for (const group of derivedTrue) if (group.seen.size < 2) return false;
    if (needsMasked && needsSeen.size < 2) return false;
    return true;
  };

  const shuffle = <T,>(items: T[]): T[] => {
    for (let i = items.length - 1; i > 0; i--) {
      const j = Math.floor(options.random() * (i + 1));
      [items[i], items[j]] = [items[j], items[i]];
    }
    return items;
  };
  const stop = (): boolean => covered() || candidatesTried >= maxCandidates;
  const tried = new Set<string>([worldKey(truth.ids, truth.needs)]);
  const cache = new Map<string, string>();
  let consistent = 1;
  let candidatesTried = 0;
  const maxCandidates = options.maxCandidates ?? Number.POSITIVE_INFINITY;

  /** Évalue un monde candidat : cohérent s'il publie EXACTEMENT la même réponse ; alors il apporte ses valeurs. */
  const evaluate = (ids: number[], y: Int16Array, needs: number): boolean => {
    candidatesTried++;
    const key = hex(new Uint8Array(y.buffer, y.byteOffset, y.byteLength)) + "|" + needs;
    let json = cache.get(key);
    if (json === undefined) {
      json = JSON.stringify(adapter.publish(adapter.rawOf(y, needs, space.structure)));
      cache.set(key, json);
    }
    if (json !== observed.json) return false;
    consistent++;
    for (const [index, seen] of maskedSeen) seen.add(y[index]);
    for (const group of derivedTrue) group.seen.add(y[group.a] - y[group.b]);
    needsSeen.add(needs);
    return true;
  };

  const consider = (ids: number[], needs: number): boolean => {
    ids.sort((p, q) => p - q);
    const key = worldKey(ids, needs);
    if (tried.has(key)) return false;
    tried.add(key);
    return evaluate(ids, sumWorld(space, ids), needs);
  };

  // 1. besoins : autre valeur de besoins, mêmes acheteurs.
  for (let needs = 0; needs <= 8; needs++) if (needs !== truth.needs) consider([...truth.ids], needs);

  // 2. mondes qui gardent les chiffres exacts publiés. Les profils sont regroupés en CLASSES de même projection sur ces chiffres ; on énumère (dénombrement
  //    des compositions, ordre mélangé, plusieurs relances) les multiensembles de classes dont la somme vaut exactement les chiffres publiés, puis on tire des
  //    profils au hasard dans chaque classe. Seule la réponse COMPLÈTE (masques compris) décide si le monde est cohérent.
  const dimsOfExact = exactIdx.length;
  const randomInt = (max: number): number => Math.floor(options.random() * (max + 1));
  const classes = new Map<string, { projection: Int8Array; ids: number[] }>();
  space.vectors.forEach((vector, id) => {
    const projection = new Int8Array(dimsOfExact);
    for (let k = 0; k < dimsOfExact; k++) {
      projection[k] = vector[exactIdx[k]];
      if (projection[k] > exactTarget[k]) return;
    }
    const key = hex(projection);
    const found = classes.get(key);
    if (found) found.ids.push(id);
    else classes.set(key, { projection, ids: [id] });
  });
  const classList = [...classes.values()];
  // 2a. tirages : n − 2 acheteurs au hasard (un sous-ensemble du monde vrai une fois sur deux), les deux derniers complétés exactement par la projection restante.
  const flat = classList.flatMap((entry) => entry.ids);
  const projectionOf = new Map<number, Int8Array>();
  for (const entry of classList) for (const id of entry.ids) projectionOf.set(id, entry.projection);
  const maxProjection = new Int8Array(dimsOfExact);
  for (const entry of classList) for (let k = 0; k < dimsOfExact; k++) if (entry.projection[k] > maxProjection[k]) maxProjection[k] = entry.projection[k];
  const keyAfter = (remaining: Int16Array, minus?: Int8Array): string | null => {
    const bytes = new Int8Array(dimsOfExact);
    for (let k = 0; k < dimsOfExact; k++) {
      const value = remaining[k] - (minus ? minus[k] : 0);
      if (value < 0 || value > 127) return null;
      bytes[k] = value;
    }
    return hex(bytes);
  };
  const zeroKey = hex(new Int8Array(dimsOfExact));
  const draws = options.drawAttempts ?? 1500;
  for (let attempt = 0; attempt < draws && !stop() && flat.length > 0; attempt++) {
    const size = options.random() < 0.5 ? Math.min(options.cap, Math.max(1, truth.ids.length + randomInt(2) - 1)) : 1 + randomInt(options.cap - 1);
    const prefixLength = Math.max(0, size - 2);
    const prefix: number[] = [];
    const remaining = Int16Array.from(exactTarget);
    if (options.random() < 0.5 && truth.ids.length > 0) {
      const pool = shuffle([...truth.ids]);
      for (const id of pool.slice(0, Math.min(prefixLength, pool.length))) {
        prefix.push(id);
        const projection = projectionOf.get(id);
        if (projection) for (let k = 0; k < dimsOfExact; k++) remaining[k] -= projection[k];
        else { prefix.pop(); }
      }
    }
    let ok = true;
    while (prefix.length < prefixLength && ok) {
      ok = false;
      const left = size - prefix.length - 1;
      for (let tries = 0; tries < 60 && !ok; tries++) {
        const id = flat[randomInt(flat.length - 1)];
        const projection = projectionOf.get(id) as Int8Array;
        let fits = true;
        for (let k = 0; k < dimsOfExact; k++) {
          const after = remaining[k] - projection[k];
          if (after < 0 || after > left * maxProjection[k]) { fits = false; break; }
        }
        if (!fits) continue;
        prefix.push(id);
        for (let k = 0; k < dimsOfExact; k++) remaining[k] -= projection[k];
        ok = true;
      }
    }
    if (!ok || remaining.some((value) => value < 0)) continue;
    const slots = size - prefix.length;
    if (slots === 0) {
      if (keyAfter(remaining) === zeroKey) consider([...prefix], truth.needs);
    } else if (slots === 1) {
      const list = classes.get(keyAfter(remaining) ?? "")?.ids ?? [];
      for (let tries = 0; tries < 6 && list.length > 0; tries++) consider([...prefix, list[randomInt(list.length - 1)]], truth.needs);
    } else {
      for (let tries = 0; tries < 30 && !stop(); tries++) {
        const first = flat[randomInt(flat.length - 1)];
        const key = keyAfter(remaining, projectionOf.get(first));
        if (key === null) continue;
        const list = classes.get(key)?.ids;
        if (!list) continue;
        consider([...prefix, first, list[randomInt(list.length - 1)]], truth.needs);
      }
    }
  }
  // 2b. énumération des classes (utile quand peu de chiffres exacts rendent les classes peu nombreuses).
  const restarts = options.samplingAttempts ?? 60;
  const nodeBudget = options.restartNodeBudget ?? 20_000;
  const weights = space.profiles.map((profile) => profile.serves.length + profile.views.length + (profile.contact ? 1 : 0));
  let solutionCount = 0;
  const sizeHistogram: Record<number, number> = {};
  /** Cellules protégées encore sans témoin (valeur unique vue jusqu'ici). */
  const uncovered = (): number[] => {
    const out: number[] = [];
    for (const [index, seen] of maskedSeen) if (seen.size < 2) out.push(index);
    return out;
  };
  /**
   * Pour une composition de classes : deux tirages au hasard dans chaque classe, puis, pour chaque chiffre protégé sans témoin, la version « au plus bas » et
   * « au plus haut » de ce chiffre (profil extrême de chaque classe) et le remplacement d'un seul acheteur par un profil de sa classe qui change ce chiffre.
   */
  const assign = (picked: readonly number[]): void => {
    solutionCount++;
    sizeHistogram[picked.length] = (sizeHistogram[picked.length] ?? 0) + 1;
    // Les mondes les plus simples (peu d'événements) sont ceux qui gardent le plus souvent la même réponse : on les tire plus souvent.
    const random = (c: number): number => {
      const ids = classList[c].ids;
      if (options.random() < 0.5) return ids[randomInt(ids.length - 1)];
      let lightest = ids[0];
      for (const id of ids) if (weights[id] < weights[lightest] || (weights[id] === weights[lightest] && options.random() < 0.5)) lightest = id;
      return lightest;
    };
    const base = picked.map(random);
    consider([...base], truth.needs);
    consider(picked.map(random), truth.needs);
    for (const cell of shuffle(uncovered()).slice(0, 4)) {
      if (stop()) return;
      for (const direction of [-1, 1]) {
        const extreme = picked.map((c) => {
          let best = classList[c].ids[0];
          for (const id of classList[c].ids) {
            const gain = direction * (space.vectors[id][cell] - space.vectors[best][cell]);
            if (gain > 0 || (gain === 0 && (weights[id] < weights[best] || (weights[id] === weights[best] && options.random() < 0.5)))) best = id;
          }
          return best;
        });
        consider(extreme, truth.needs);
      }
      picked.forEach((c, slot) => {
        const differing = classList[c].ids.filter((id) => space.vectors[id][cell] !== space.vectors[base[slot]][cell]);
        if (differing.length === 0) return;
        for (let draw = 0; draw < 2; draw++) {
          const ids = [...base];
          ids[slot] = differing[randomInt(differing.length - 1)];
          consider(ids, truth.needs);
        }
      });
    }
  };
  for (let restart = 0; restart < restarts && !stop() && classList.length > 0; restart++) {
    const order = shuffle([...classList.keys()]);
    const projections = order.map((c) => classList[c].projection);
    const suffixMax: Int8Array[] = new Array(order.length + 1);
    suffixMax[order.length] = new Int8Array(dimsOfExact);
    for (let c = order.length - 1; c >= 0; c--) {
      const row = Int8Array.from(suffixMax[c + 1]);
      for (let k = 0; k < dimsOfExact; k++) if (projections[c][k] > row[k]) row[k] = projections[c][k];
      suffixMax[c] = row;
    }
    const remaining = Int16Array.from(exactTarget);
    const picked: number[] = [];
    const cap = 1 + randomInt(options.cap - 1);
    let nodes = 0;
    const walk = (from: number, left: number): void => {
      if (stop() || ++nodes > nodeBudget) return;
      const done = remaining.every((value) => value === 0);
      if (done) assign(picked.map((at) => order[at]));
      if (left === 0 || done && picked.length >= cap) return;
      const best = suffixMax[from];
      for (let k = 0; k < dimsOfExact; k++) {
        if (remaining[k] > 0 && (best[k] === 0 || Math.ceil(remaining[k] / best[k]) > left)) return;
      }
      for (let c = from; c < order.length; c++) {
        const projection = projections[c];
        let fits = true;
        for (let k = 0; k < dimsOfExact; k++) if (projection[k] > remaining[k]) { fits = false; break; }
        if (!fits) continue;
        if (done && !projection.every((value) => value === 0)) continue;
        for (let k = 0; k < dimsOfExact; k++) remaining[k] -= projection[k];
        picked.push(c);
        walk(c, left - 1);
        picked.pop();
        for (let k = 0; k < dimsOfExact; k++) remaining[k] += projection[k];
        if (stop() || nodes > nodeBudget) return;
      }
    };
    walk(0, cap);
  }

  let status: Verdict["status"] = "witnesses";
  const detail: string[] = [];
  if (!covered()) detail.push(`classes ${classList.length}, compositions ${solutionCount} ${JSON.stringify(sizeHistogram)}, mondes évalués ${candidatesTried}`);
  if (!covered()) status = "unresolved";

  const pinnedMasked: Verdict["pinnedMasked"] = [];
  if (status !== "witnesses") {
    for (const [index, seen] of maskedSeen) if (seen.size < 2) pinnedMasked.push({ cell: space.specs[index].name, value: [...seen][0] });
  }
  const pinnedDerived: Verdict["pinnedDerived"] = [];
  if (status !== "witnesses") {
    for (const group of derivedTrue) if (group.seen.size < 2) pinnedDerived.push({ pair: `${space.specs[group.a].name} − ${space.specs[group.b].name}`, value: group.value });
  }
  const needsPinned = status !== "witnesses" && needsMasked && needsSeen.size < 2;
  return { linearLeaks, pinnedMasked, pinnedDerived, smallPublished, needsPinned, status, consistentWorlds: consistent, detail };
}

export function kindOf(space: Space, index: number): CellKind {
  return space.specs[index].kind;
}

export { cellVector };
