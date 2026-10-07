/**
 * Algèbre linéaire EXACTE de l'adversaire (lot M1-ter). Tous les chiffres du modèle sont des fonctions linéaires du nombre d'acheteurs de chaque profil. Une
 * RELATION est un vecteur ρ (sur les chiffres) tel que ρ·v = 0 pour le vecteur v de CHAQUE profil : une identité du modèle valable pour des mondes de n'importe
 * quelle taille (ex. organiques = ouvreurs − attribués ; boost unique = part attribuée de tout l'historique). Un chiffre est DÉTERMINÉ par les chiffres publiés
 * exacts E quand e_c ∈ vect(e_i, i ∈ E) + relations : alors il vaut la même valeur dans TOUT monde qui publie les mêmes chiffres exacts. C'est une preuve de
 * fuite indépendante de la taille des mondes (le masque, lui, ne peut qu'ajouter des contraintes).
 */

class Fraction {
  constructor(readonly n: number, readonly d: number = 1) {
    if (!Number.isSafeInteger(n) || !Number.isSafeInteger(d) || d === 0) throw new RangeError("fraction hors des entiers sûrs");
  }
  static of(value: number): Fraction { return new Fraction(value, 1); }
  private static norm(n: number, d: number): Fraction {
    if (d < 0) { n = -n; d = -d; }
    const g = gcd(Math.abs(n), d);
    return g > 1 ? new Fraction(n / g, d / g) : new Fraction(n, d);
  }
  get isZero(): boolean { return this.n === 0; }
  sub(o: Fraction): Fraction { return Fraction.norm(this.n * o.d - o.n * this.d, this.d * o.d); }
  mul(o: Fraction): Fraction { return Fraction.norm(this.n * o.n, this.d * o.d); }
  div(o: Fraction): Fraction { return Fraction.norm(this.n * o.d, this.d * o.n); }
  neg(): Fraction { return new Fraction(-this.n, this.d); }
}
function gcd(a: number, b: number): number { while (b !== 0) [a, b] = [b, a % b]; return a; }
function lcm(a: number, b: number): number { return (a / gcd(a, b)) * b; }

/** Forme échelonnée réduite (rationnelle, exacte) ; renvoie les colonnes pivots. */
function rref(matrix: Fraction[][], columns: number): number[] {
  const pivots: number[] = [];
  let row = 0;
  for (let col = 0; col < columns && row < matrix.length; col++) {
    let pivot = -1;
    for (let r = row; r < matrix.length; r++) if (!matrix[r][col].isZero) { pivot = r; break; }
    if (pivot < 0) continue;
    [matrix[row], matrix[pivot]] = [matrix[pivot], matrix[row]];
    const inverse = matrix[row][col];
    for (let c = 0; c < columns; c++) matrix[row][c] = matrix[row][c].div(inverse);
    for (let r = 0; r < matrix.length; r++) {
      if (r === row || matrix[r][col].isZero) continue;
      const factor = matrix[r][col];
      for (let c = 0; c < columns; c++) matrix[r][c] = matrix[r][c].sub(factor.mul(matrix[row][c]));
    }
    pivots.push(col);
    row++;
  }
  return pivots;
}

/** Relations entières (base) du modèle : vecteurs ρ avec ρ·v = 0 pour tous les profils `vectors`. Exact (vérifié sur tous les profils). */
export function modelRelations(vectors: readonly ArrayLike<number>[], dims: number): number[][] {
  // 1. sous-ensemble générateur par élimination en flottants (découverte seulement) ; 2. relations exactes de ce sous-ensemble ; 3. vérification sur tout.
  const generators: number[] = [];
  const basis: Array<{ row: Float64Array; pivot: number }> = [];
  const reduceFloat = (vector: ArrayLike<number>): { residual: Float64Array; pivot: number } => {
    const w = Float64Array.from(vector as ArrayLike<number> as number[]);
    for (const b of basis) {
      const f = w[b.pivot];
      if (f !== 0) for (let k = 0; k < dims; k++) w[k] -= f * b.row[k];
    }
    let pivot = 0;
    for (let k = 1; k < dims; k++) if (Math.abs(w[k]) > Math.abs(w[pivot])) pivot = k;
    return { residual: w, pivot };
  };
  const addGenerator = (index: number, vector: ArrayLike<number>): boolean => {
    const { residual, pivot } = reduceFloat(vector);
    if (Math.abs(residual[pivot]) <= 1e-7) return false;
    const scale = residual[pivot];
    for (let k = 0; k < dims; k++) residual[k] /= scale;
    basis.push({ row: residual, pivot });
    generators.push(index);
    return true;
  };
  vectors.forEach((vector, index) => { addGenerator(index, vector); });

  for (;;) {
    const matrix = generators.map((index) => Array.from(vectors[index], (value) => Fraction.of(value)));
    const pivots = rref(matrix, dims);
    const pivotSet = new Set(pivots);
    const relations: number[][] = [];
    for (let free = 0; free < dims; free++) {
      if (pivotSet.has(free)) continue;
      const rational: Fraction[] = new Array(dims).fill(null).map(() => Fraction.of(0));
      rational[free] = Fraction.of(1);
      pivots.forEach((pivotCol, r) => { rational[pivotCol] = matrix[r][free].neg(); });
      let common = 1;
      for (const f of rational) common = lcm(common, f.d);
      const integers = rational.map((f) => f.n * (common / f.d));
      let divisor = 0;
      for (const v of integers) divisor = gcd(divisor, Math.abs(v));
      relations.push(integers.map((v) => (divisor === 0 ? v : v / divisor)));
    }
    let violating = -1;
    outer: for (let index = 0; index < vectors.length; index++) {
      for (const relation of relations) {
        let dot = 0;
        for (let k = 0; k < dims; k++) dot += relation[k] * vectors[index][k];
        if (dot !== 0) { violating = index; break outer; }
      }
    }
    if (violating < 0) return relations;
    // Le flottant avait manqué une direction : on ajoute ce profil de force, sans seuil.
    generators.push(violating);
    const { residual, pivot } = reduceFloat(vectors[violating]);
    const scale = residual[pivot] === 0 ? 1 : residual[pivot];
    for (let k = 0; k < dims; k++) residual[k] /= scale;
    basis.push({ row: residual, pivot });
  }
}

export interface Determinacy {
  /** Vrai si le chiffre fonctionnel `f` (vecteur sur les chiffres) est déterminé par les chiffres exacts publiés. */
  determined(f: ReadonlyArray<[number, number]>): boolean;
}

/** Détermination exacte : f ∈ vect(e_i, i ∈ exact) + relations. */
export function determinacy(relations: readonly number[][], dims: number, exact: ReadonlySet<number>): Determinacy {
  const free: number[] = [];
  for (let d = 0; d < dims; d++) if (!exact.has(d)) free.push(d);
  const position = new Map(free.map((d, k) => [d, k] as const));
  // Les relations restreintes aux coordonnées non publiées engendrent tout ce qui est déductible des chiffres publiés.
  const matrix = relations.map((relation) => free.map((d) => Fraction.of(relation[d])));
  const pivots = rref(matrix, free.length);
  const reduced = matrix.slice(0, pivots.length);
  return {
    determined(f) {
      const vector: Fraction[] = free.map(() => Fraction.of(0));
      for (const [d, coefficient] of f) {
        const at = position.get(d);
        if (at !== undefined) vector[at] = vector[at].sub(Fraction.of(-coefficient));
      }
      pivots.forEach((col, r) => {
        const factor = vector[col];
        if (factor.isZero) return;
        for (let c = 0; c < free.length; c++) vector[c] = vector[c].sub(factor.mul(reduced[r][c]));
      });
      return vector.every((value) => value.isZero);
    },
  };
}
