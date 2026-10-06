/**
 * Placement des éléments promus à l'intérieur d'un classement DÉJÀ pertinent (brief §15 : compatibles, puis
 * pertinence, puis boost à l'intérieur). Fonctions pures, entiers uniquement : la part promue a au plus trois
 * décimales (NUMERIC(4,3)) et est convertie en millièmes, aucun arrondi flottant ne peut décaler une position.
 * Règle du plancher : le boost ne peut qu'AMÉLIORER la position d'un élément promu. « Promu » signifie « a gagné des
 * places ». Priorité d'ANCIENNETÉ (lot P3) : quand plusieurs éléments boostés sont promouvables, la promotion va au boost le
 * plus ANCIEN (jamais selon l'ordre organique). Voir BOOST.md.
 */

/** Part en millièmes entiers ; refuse tout ce qui n'est pas une part valide (0 < part ≤ 1). */
function toMilli(share: number): number {
  if (!Number.isFinite(share) || share <= 0 || share > 1) throw new RangeError("part promue invalide (0 < part ≤ 1 attendu)");
  const milli = Math.round(share * 1000);
  if (milli < 1) throw new RangeError("part promue trop petite (millième minimal)");
  return milli;
}

/** floor(part × n), en entiers. */
export function computeMaxPromoted(itemCount: number, share: number): number {
  if (!Number.isSafeInteger(itemCount) || itemCount < 0) throw new RangeError("nombre d'éléments invalide");
  const product = toMilli(share) * itemCount;
  return (product - (product % 1000)) / 1000;
}

/** Écart entre deux positions promues : ceil(1 / part) (avec 0,15 : 7 → positions 0, 7, 14, …). */
export function computePromotionStep(share: number): number {
  const milli = toMilli(share);
  return Math.floor((1000 + milli - 1) / milli);
}

export interface PlacedItem<T> {
  item: T;
  /** Vrai UNIQUEMENT pour un élément qui a réellement gagné des places grâce au boost (position finale < position organique). */
  promoted: boolean;
}

/**
 * Rang d'ancienneté d'un boost promouvable : un ENTIER, le plus PETIT = le boost le plus ANCIEN = servi en premier. `null` : l'élément n'est
 * pas promouvable (pas de boost effectif, ou pertinence sous le seuil). Les rangs sont distincts d'un boost à l'autre (voir `rankBoostsByAge`) ;
 * à rang égal (cas de test), l'ordre organique départage.
 */
export type BoostPriority = number | null;

export interface AgedBoost {
  /** Identifiant de l'offre boostée (clé du rang). */
  key: string;
  /** Début du boost : ISO UTC à la microseconde (`YYYY-MM-DDTHH:MM:SS.ffffffZ`, même largeur partout : l'ordre du texte est l'ordre du temps). */
  startsAt: string;
  boostId: string;
}

/** Ordre d'ancienneté d'un boost : `starts_at` croissant, puis identifiant du boost (UUID en minuscules). */
export function compareBoostAge(a: Pick<AgedBoost, "startsAt" | "boostId">, b: Pick<AgedBoost, "startsAt" | "boostId">): number {
  if (a.startsAt !== b.startsAt) return a.startsAt < b.startsAt ? -1 : 1;
  return a.boostId < b.boostId ? -1 : a.boostId > b.boostId ? 1 : 0;
}

/**
 * Rang d'ancienneté de chaque boost (0 = le plus ancien). UNE seule définition de l'ordre, partagée par la lecture des résultats, le journal
 * d'exposition et la portée d'un boost (`reach.ts`) : aucune copie qui pourrait diverger.
 */
export function rankBoostsByAge(boosts: Iterable<AgedBoost>): Map<string, number> {
  const ranks = new Map<string, number>();
  [...boosts].sort(compareBoostAge).forEach((boost, rank) => ranks.set(boost.key, rank));
  return ranks;
}

/**
 * `organic` est le classement organique (pertinence décroissante, départage organique). On parcourt les positions
 * finales p = 0 .. N-1 avec la file `remaining` (ordre organique des éléments non encore placés) :
 * - à une position de promotion (p multiple de `computePromotionStep`) tant que `computeMaxPromoted` n'est pas atteint,
 *   soit x l'élément promouvable de `remaining` dont le boost est le plus ANCIEN (rang le plus petit ; jamais l'ordre organique). Si x
 *   MONTE strictement (sa position organique est > p) il est placé en p et marqué promu (le quota est consommé) ; sinon la tête de
 *   `remaining` est placée, non promue, sans consommer de quota (aucun avantage : x est déjà à sa place, ou aucun élément n'est promouvable).
 *   Un boost plus récent ne prend donc JAMAIS la position d'un boost plus ancien, même quand celui-ci n'a rien à gagner ;
 * - ailleurs, la tête est placée, non promue.
 * Conséquences : un promu ne descend jamais et monte strictement ; les non-promus gardent leur ordre relatif ; aucun élément n'est ajouté,
 * retiré ni dupliqué ; AJOUTER un boost promouvable plus récent que tous les autres ne change la décision (promu ou non) d'AUCUN autre élément.
 * Avec `priority = index organique`, c'est exactement l'ancien placement « premier promouvable dans l'ordre organique ».
 */
export function placeBoostedItems<T>(
  organic: readonly T[],
  priority: (item: T, organicIndex: number) => BoostPriority,
  maxPromotedShare: number,
): Array<PlacedItem<T>> {
  const count = organic.length;
  const step = computePromotionStep(maxPromotedShare);
  const maxPromoted = computeMaxPromoted(count, maxPromotedShare);
  const remaining: number[] = Array.from({ length: count }, (_, index) => index);
  const placed: Array<PlacedItem<T>> = [];
  let promotedCount = 0;
  for (let position = 0; position < count; position += 1) {
    let taken = 0;
    let promoted = false;
    if (position % step === 0 && promotedCount < maxPromoted) {
      // Le promouvable au boost le plus ancien ; à rang égal, le premier dans l'ordre organique (la file est triée par index organique).
      let best = -1;
      let bestRank = Number.POSITIVE_INFINITY;
      for (let slot = 0; slot < remaining.length; slot += 1) {
        const rank = priority(organic[remaining[slot]], remaining[slot]);
        if (rank !== null && rank < bestRank) {
          best = slot;
          bestRank = rank;
        }
      }
      if (best >= 0 && remaining[best] > position) {
        taken = best;
        promoted = true;
        promotedCount += 1;
      }
    }
    const [index] = remaining.splice(taken, 1);
    placed.push({ item: organic[index], promoted });
  }
  return placed;
}

/**
 * Vrai si, dans ce classement organique, `placeBoostedItems` ferait MONTER l'élément `targetIndex` (il est marqué promu : quota de
 * places promues non nul et non épuisé, élément promouvable, boost plus ancien que ceux qui le concurrencent, et pas déjà à la place cible).
 * C'est EXACTEMENT la décision de la lecture des résultats (une seule implémentation du placement : cette fonction l'appelle, elle ne la
 * recopie pas). Sert à savoir, avant un achat, si un boost aurait un effet visible dans la liste d'un acheteur (`reach.ts`).
 */
export function isPromotedByBoost<T>(
  organic: readonly T[],
  targetIndex: number,
  priority: (item: T, organicIndex: number) => BoostPriority,
  maxPromotedShare: number,
): boolean {
  if (!Number.isSafeInteger(targetIndex) || targetIndex < 0 || targetIndex >= organic.length) return false;
  const target = organic[targetIndex];
  return placeBoostedItems(organic, priority, maxPromotedShare).some((entry) => entry.item === target && entry.promoted);
}
