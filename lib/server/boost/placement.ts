/**
 * Placement des éléments promus à l'intérieur d'un classement DÉJÀ pertinent (brief §15 : compatibles, puis
 * pertinence, puis boost à l'intérieur). Fonctions pures, entiers uniquement : la part promue a au plus trois
 * décimales (NUMERIC(4,3)) et est convertie en millièmes, aucun arrondi flottant ne peut décaler une position.
 * Voir BOOST.md.
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
  /** Vrai UNIQUEMENT pour un élément promu. */
  promoted: boolean;
}

/**
 * `organic` est le classement organique (pertinence décroissante, départage organique). Sont promus, dans l'ordre
 * organique des éléments promouvables (donc par pertinence décroissante, puis ordre organique), au plus
 * `computeMaxPromoted` éléments, aux positions k × `computePromotionStep` (k = 0, 1, …) qui tiennent dans la liste. Les
 * autres éléments gardent leur ordre organique relatif. Aucun élément n'est ajouté, retiré ni dupliqué.
 */
export function placeBoostedItems<T>(
  organic: readonly T[],
  isPromotable: (item: T, organicIndex: number) => boolean,
  maxPromotedShare: number,
): Array<PlacedItem<T>> {
  const count = organic.length;
  const step = computePromotionStep(maxPromotedShare);
  const maxPromoted = computeMaxPromoted(count, maxPromotedShare);
  const positionsAvailable = Math.floor((count + step - 1) / step);

  const promotedIndexes: number[] = [];
  for (let index = 0; index < count && promotedIndexes.length < Math.min(maxPromoted, positionsAvailable); index += 1) {
    if (isPromotable(organic[index], index)) promotedIndexes.push(index);
  }

  const placed: Array<PlacedItem<T> | undefined> = new Array(count).fill(undefined);
  promotedIndexes.forEach((organicIndex, rank) => {
    placed[rank * step] = { item: organic[organicIndex], promoted: true };
  });
  const promoted = new Set(promotedIndexes);
  let cursor = 0;
  for (let index = 0; index < count; index += 1) {
    if (promoted.has(index)) continue;
    while (placed[cursor] !== undefined) cursor += 1;
    placed[cursor] = { item: organic[index], promoted: false };
  }
  return placed as Array<PlacedItem<T>>;
}
