/**
 * Placement des éléments promus à l'intérieur d'un classement DÉJÀ pertinent (brief §15 : compatibles, puis
 * pertinence, puis boost à l'intérieur). Fonctions pures, entiers uniquement : la part promue a au plus trois
 * décimales (NUMERIC(4,3)) et est convertie en millièmes, aucun arrondi flottant ne peut décaler une position.
 * Règle du plancher : le boost ne peut qu'AMÉLIORER la position d'un élément promu. « Promu » signifie « a gagné des
 * places ». Voir BOOST.md.
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
 * `organic` est le classement organique (pertinence décroissante, départage organique). On parcourt les positions
 * finales p = 0 .. N-1 avec la file `remaining` (ordre organique des éléments non encore placés) :
 * - à une position de promotion (p multiple de `computePromotionStep`) tant que `computeMaxPromoted` n'est pas atteint,
 *   soit h la tête de `remaining` et x le premier élément promouvable de `remaining`. Si x existe ET x ≠ h, x est placé
 *   en p et marqué promu (il monte strictement, le quota est consommé) ; sinon h est placé, non promu, sans consommer
 *   de quota (aucun avantage : x est déjà en tête, ou aucun élément n'est promouvable) ;
 * - ailleurs, h est placé, non promu.
 * Conséquences : un promu ne descend jamais ; les non-promus gardent leur ordre relatif ; aucun élément n'est ajouté,
 * retiré ni dupliqué.
 */
export function placeBoostedItems<T>(
  organic: readonly T[],
  isPromotable: (item: T, organicIndex: number) => boolean,
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
      const found = remaining.findIndex((index) => isPromotable(organic[index], index));
      if (found > 0) {
        taken = found;
        promoted = true;
        promotedCount += 1;
      }
    }
    const [index] = remaining.splice(taken, 1);
    placed.push({ item: organic[index], promoted });
  }
  return placed;
}
