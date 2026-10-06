import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BOOST_DURATION_CODES, BOOST_DURATION_SECONDS, BOOST_SCOPE_LOCK_NAMESPACE, BOOST_SOURCES,
} from "../../lib/server/boost/boost-config";
import { computeSellerLimit, computeSlots, type BoostSettings } from "../../lib/server/boost/boosts";
import {
  compareBoostAge, computeMaxPromoted, computePromotionStep, isPromotedByBoost, placeBoostedItems, rankBoostsByAge, type AgedBoost,
} from "../../lib/server/boost/placement";
import { createReachGate } from "../../lib/server/boost/gate";
import { CatalogValidationError } from "../../lib/server/catalog/errors";

const DEFAULTS: BoostSettings = {
  key: "default", slotRatio: 0.15, minSlots: 1, maxSlots: 50, maxActivePerSeller: 2, maxSellerSlotShare: 0.34, maxPromotedShare: 0.15, minRelevance: 60,
};
const settings = (extra: Partial<BoostSettings>): BoostSettings => ({ ...DEFAULTS, ...extra });

test("configuration de code : durées 24h, 3d, 7d, source admin_grant, espace de verrou distinct", () => {
  assert.deepEqual([...BOOST_DURATION_CODES], ["24h", "3d", "7d"]);
  assert.deepEqual({ ...BOOST_DURATION_SECONDS }, { "24h": 86_400, "3d": 259_200, "7d": 604_800 });
  assert.deepEqual([...BOOST_SOURCES], ["admin_grant"]);
  assert.ok(![1_314_664_945, 1_314_664_946, 1_314_664_947].includes(BOOST_SCOPE_LOCK_NAMESPACE));
  assert.ok(Object.isFrozen(BOOST_DURATION_SECONDS));
});

test("computeSlots : clamp(ceil(ratio × n), min, max) aux bornes et aux arrondis (réglages par défaut)", () => {
  const expected: Array<[number, number]> = [
    [0, 1],      // 0 offre : le plancher (min_slots = 1)
    [1, 1],      // 0,15 → 1
    [6, 1],      // 0,9 → 1
    [7, 2],      // 1,05 → 2 (arrondi par excès)
    [13, 2],     // 1,95 → 2
    [14, 3],     // 2,1 → 3
    [20, 3],     // 3,0 exactement → 3 (pas 4)
    [21, 4],     // 3,15 → 4
    [333, 50],   // 49,95 → 50 (plafond)
    [334, 50],   // 50,1 → 51 → plafonné à 50
    [100_000, 50],
  ];
  for (const [offers, slots] of expected) assert.equal(computeSlots(offers, DEFAULTS), slots, `n = ${offers}`);
});

test("computeSlots : planchers, plafonds, zéro place possible, et aucun arrondi flottant (0,07 × 100 vaut exactement 7)", () => {
  assert.equal(computeSlots(0, settings({ minSlots: 0 })), 0, "min 0 : un périmètre vide n'a aucune place");
  assert.equal(computeSlots(3, settings({ minSlots: 0 })), 1);
  assert.equal(computeSlots(10, settings({ minSlots: 4, maxSlots: 4 })), 4, "min = max : nombre fixe de places");
  assert.equal(computeSlots(1000, settings({ slotRatio: 0.5, maxSlots: 30 })), 30);
  assert.equal(computeSlots(5, settings({ slotRatio: 0.5, minSlots: 0, maxSlots: 10 })), 3, "2,5 → 3");
  // 0,07 × 100 = 7.000000000000001 en flottant : un ceil naïf donnerait 8.
  assert.ok(Math.ceil(0.07 * 100) === 8, "le piège flottant existe bien dans cet environnement");
  assert.equal(computeSlots(100, settings({ slotRatio: 0.07, minSlots: 0 })), 7);
  assert.equal(computeSlots(100, settings({ slotRatio: 0.5, minSlots: 0, maxSlots: 100 })), 50);
  for (const bad of [-1, 1.5, Number.NaN, Infinity, "3" as unknown as number]) {
    assert.throws(() => computeSlots(bad, DEFAULTS), CatalogValidationError, String(bad));
  }
});

test("computeSellerLimit : max(1, floor(part × places)), borné par max_active_per_seller", () => {
  const expected: Array<[number, Partial<BoostSettings>, number]> = [
    [0, {}, 1],                                  // le plancher de 1 s'applique même sans place (le total est contrôlé avant)
    [1, {}, 1],                                  // floor(0,34) = 0 → 1
    [5, {}, 1],                                  // floor(1,7) = 1
    [6, {}, 2],                                  // floor(2,04) = 2
    [10, {}, 2],                                 // floor(3,4) = 3 → borné à 2
    [50, {}, 2],
    [8, { maxSellerSlotShare: 1, maxActivePerSeller: 5 }, 5],   // 8 → borné à 5
    [8, { maxSellerSlotShare: 1, maxActivePerSeller: 50 }, 8],
    [3, { maxSellerSlotShare: 0.5, maxActivePerSeller: 50 }, 1], // floor(1,5) = 1
    [4, { maxSellerSlotShare: 0.5, maxActivePerSeller: 50 }, 2],
  ];
  for (const [slots, extra, limit] of expected) assert.equal(computeSellerLimit(slots, settings(extra)), limit, `places ${slots} ${JSON.stringify(extra)}`);
  // 0,29 × 100 = 28.999999999999996 en flottant : un floor naïf donnerait 28.
  assert.ok(Math.floor(0.29 * 100) === 28, "le piège flottant existe bien dans cet environnement");
  assert.equal(computeSellerLimit(100, settings({ maxSellerSlotShare: 0.29, maxActivePerSeller: 1000 })), 29);
  for (const bad of [-1, 2.5, Number.NaN]) assert.throws(() => computeSellerLimit(bad, DEFAULTS), CatalogValidationError, String(bad));
});

test("computeMaxPromoted et computePromotionStep : entiers exacts (part 0,15 → positions 0, 7, 14, …)", () => {
  const maxPromoted: Array<[number, number, number]> = [
    [0, 0.15, 0], [6, 0.15, 0], [7, 0.15, 1], [13, 0.15, 1], [14, 0.15, 2], [20, 0.15, 3], [100, 0.15, 15], [200, 0.15, 30],
    [5, 0.2, 1], [4, 0.2, 0], [10, 0.1, 1], [9, 0.1, 0],
    [100, 0.29, 29], [100, 0.57, 57], [200, 0.145, 29],
  ];
  for (const [count, share, expected] of maxPromoted) assert.equal(computeMaxPromoted(count, share), expected, `N=${count} part=${share}`);
  const steps: Array<[number, number]> = [[0.15, 7], [0.2, 5], [0.1, 10], [0.125, 8], [0.17, 6], [0.07, 15], [0.5, 2], [1, 1], [0.001, 1000]];
  for (const [share, step] of steps) assert.equal(computePromotionStep(share), step, `part=${share}`);
  for (const bad of [0, -0.1, 1.01, Number.NaN, Infinity, 0.0001]) {
    assert.throws(() => computePromotionStep(bad), RangeError, String(bad));
    assert.throws(() => computeMaxPromoted(10, bad), RangeError, String(bad));
  }
  for (const bad of [-1, 1.5, Number.NaN]) assert.throws(() => computeMaxPromoted(bad, 0.15), RangeError, String(bad));
});

const labels = (count: number): string[] => Array.from({ length: count }, (_, index) => `item-${index}`);
const indexOfLabel = (label: string) => Number(label.slice("item-".length));

/** Ordre final sous forme d'indices organiques, et ensemble des promus. */
function run(count: number, promotable: ReadonlySet<number>, share: number) {
  const placed = placeBoostedItems(labels(count), (_, index) => (promotable.has(index) ? index : null), share);
  return { order: placed.map((entry) => indexOfLabel(entry.item)), promoted: new Set(placed.filter((entry) => entry.promoted).map((entry) => indexOfLabel(entry.item))) };
}

test("placeBoostedItems : le cas de l'audit (promouvables 3, 5, 8 sur 30, part 0,15) — calculé à la main", () => {
  // maxPromus = floor(0,15 × 30) = 4, pas = 7.
  // p0 (promotion) : tête 0, premier promouvable 3 ≠ tête → 3 est placé en 0, promu. File : 0 1 2 4 5 6 7 8 9 …
  // p1 à p6 (hors promotion) : on place la tête → 0 1 2 4 5 6. Le 5 est donc placé en 5, sa position organique : AUCUN avantage, non promu.
  // p7 (promotion) : tête 7, premier promouvable restant 8 ≠ tête → 8 est placé en 7, promu (il gagne une place). File : 7 9 10 …
  // p14 et p21 (promotion) : plus aucun promouvable → la tête, non promu. Le reste suit l'ordre organique.
  const result = run(30, new Set([3, 5, 8]), 0.15);
  const expected = [3, 0, 1, 2, 4, 5, 6, 8, 7, ...Array.from({ length: 21 }, (_, index) => 9 + index)];
  assert.deepEqual(result.order, expected);
  assert.deepEqual([...result.promoted].sort((a, b) => a - b), [3, 8]);
  assert.equal(result.order.indexOf(3), 0);
  assert.equal(result.order.indexOf(5), 5, "5 reste à sa place organique (l'ancien placement le descendait en 7)");
  assert.equal(result.order.indexOf(8), 7, "8 monte de 8 à 7 (l'ancien placement le descendait en 14)");
});

test("placeBoostedItems : exemples calculés à la main (tête déjà promouvable, quota, petites listes)", () => {
  // Le premier promouvable est déjà en tête : rien à gagner, rien de promu, quota intact. p7 : tête 7, promouvable 9 → promu en 7.
  const headAlready = run(30, new Set([0, 9]), 0.15);
  assert.deepEqual(headAlready.order, [0, 1, 2, 3, 4, 5, 6, 9, 7, 8, ...Array.from({ length: 20 }, (_, index) => 10 + index)]);
  assert.deepEqual([...headAlready.promoted], [9]);
  // Tous promouvables : le premier promouvable est toujours la tête → personne n'est promu, ordre organique.
  const all = run(30, new Set(Array.from({ length: 30 }, (_, index) => index)), 0.15);
  assert.deepEqual(all.order, Array.from({ length: 30 }, (_, index) => index));
  assert.equal(all.promoted.size, 0);
  // N = 7 : maxPromus = 1, un seul créneau (p0).
  assert.deepEqual(run(7, new Set([6]), 0.15).order, [6, 0, 1, 2, 3, 4, 5]);
  // N = 6 : maxPromus = 0.
  assert.deepEqual(run(6, new Set([5]), 0.15).order, [0, 1, 2, 3, 4, 5]);
  // N = 20, promouvables 10 à 14 : maxPromus = 3. p0 : 10 promu ; p7 : 11 promu ; p12 et p13 prennent 12 et 13 (hors promotion) ;
  // p14 : le premier promouvable restant, 14, est la tête → pas de promotion, le quota (3) n'est pas consommé.
  const quota = run(20, new Set([10, 11, 12, 13, 14]), 0.15);
  assert.deepEqual(quota.order, [10, 0, 1, 2, 3, 4, 5, 11, 6, 7, 8, 9, 12, 13, 14, 15, 16, 17, 18, 19]);
  assert.deepEqual([...quota.promoted].sort((a, b) => a - b), [10, 11]);
  // Le quota n'est consommé QUE par une vraie montée : N = 13 → maxPromus = 1. p0 : le promouvable 0 est la tête, aucun avantage, quota intact ;
  // p7 : tête 7, promouvable 12 → 12 monte en 7 (avec un quota consommé à tort en p0, 12 resterait en 12).
  const quotaKept = run(13, new Set([0, 12]), 0.15);
  assert.deepEqual(quotaKept.order, [0, 1, 2, 3, 4, 5, 6, 12, 7, 8, 9, 10, 11]);
  assert.deepEqual([...quotaKept.promoted], [12]);
  // Aucun promouvable, liste vide.
  assert.deepEqual(run(12, new Set(), 0.15).order, Array.from({ length: 12 }, (_, index) => index));
  assert.deepEqual(placeBoostedItems([], () => 0, 0.15), []);
  // Plusieurs promus qui montent réellement : quota atteint (N = 30, maxPromus = 4, promouvables lointains).
  const far = run(30, new Set([25, 26, 27, 28, 29]), 0.15);
  assert.deepEqual(far.order.slice(0, 22), [25, 0, 1, 2, 3, 4, 5, 26, 6, 7, 8, 9, 10, 11, 27, 12, 13, 14, 15, 16, 17, 28]);
  assert.equal(far.order[21], 28);
  assert.deepEqual([...far.promoted].sort((a, b) => a - b), [25, 26, 27, 28]);
});

/** Pas et plafond recalculés SANS les fonctions du module (entiers, centièmes). */
const independent = (count: number, hundredths: number) => ({
  step: Math.ceil(100 / hundredths),
  maxPromoted: Math.floor((hundredths * count) / 100),
});

function checkInvariants(count: number, promotable: ReadonlySet<number>, hundredths: number): void {
  const share = hundredths / 100;
  const { order, promoted } = run(count, promotable, share);
  const context = `N=${count} part=${share} promouvables=${[...promotable].join(",")}`;
  const { step, maxPromoted } = independent(count, hundredths);
  // (f) permutation exacte : aucun doublon, aucun ajout, aucun retrait.
  assert.equal(order.length, count, context);
  assert.deepEqual([...order].sort((a, b) => a - b), Array.from({ length: count }, (_, index) => index), context);
  const finalOf = new Map(order.map((organicIndex, position) => [organicIndex, position]));
  // (a) un promu monte strictement ; (b) promu ⇔ position finale < position organique.
  for (let organicIndex = 0; organicIndex < count; organicIndex += 1) {
    const final = finalOf.get(organicIndex)!;
    if (promoted.has(organicIndex)) assert.ok(final < organicIndex, `(a) ${organicIndex} → ${final} ; ${context}`);
    assert.equal(promoted.has(organicIndex), final < organicIndex, `(b) ${organicIndex} → ${final} ; ${context}`);
    if (promoted.has(organicIndex)) assert.ok(promotable.has(organicIndex), `promu non promouvable ; ${context}`);
  }
  // (c) plafond, positions k × pas.
  assert.ok(promoted.size <= maxPromoted, `(c) ${promoted.size} > ${maxPromoted} ; ${context}`);
  for (const organicIndex of promoted) assert.equal(finalOf.get(organicIndex)! % step, 0, `(c) position ; ${context}`);
  // (d) ordre relatif des non-promus = ordre organique.
  const others = order.filter((organicIndex) => !promoted.has(organicIndex));
  assert.deepEqual(others, [...others].sort((a, b) => a - b), `(d) ; ${context}`);
  // (e) chaque non-promu descend d'au plus le nombre de promus placés devant lui.
  const promotedPositions = [...promoted].map((organicIndex) => finalOf.get(organicIndex)!);
  for (const organicIndex of others) {
    const final = finalOf.get(organicIndex)!;
    const ahead = promotedPositions.filter((position) => position < final).length;
    assert.ok(final - organicIndex <= ahead, `(e) ${organicIndex} → ${final}, ${ahead} promus devant ; ${context}`);
  }
  // Déterminisme.
  assert.deepEqual(run(count, promotable, share).order, order, context);
}

test("placeBoostedItems : invariants (a) à (f) sur la grille exhaustive des parts 0,05 à 0,20 et N de 0 à 60 (≥ 5 000 cas reproductibles)", () => {
  let seed = 20_261_005;
  const random = () => { seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0; return seed / 0x1_0000_0000; };
  let cases = 0;
  for (let hundredths = 5; hundredths <= 20; hundredths += 1) {
    for (let count = 0; count <= 60; count += 1) {
      const sets: Array<Set<number>> = [new Set(), new Set(Array.from({ length: count }, (_, index) => index)), new Set(Array.from({ length: count }, (_, index) => index).filter((index) => index >= count - 5))];
      for (const density of [0.1, 0.3, 0.5, 0.8]) sets.push(new Set(Array.from({ length: count }, (_, index) => index).filter(() => random() < density)));
      for (let extra = 0; extra < 2; extra += 1) sets.push(new Set(Array.from({ length: count }, (_, index) => index).filter(() => random() < 0.2)));
      for (const promotable of sets) { checkInvariants(count, promotable, hundredths); cases += 1; }
    }
  }
  assert.ok(cases >= 5_000, `${cases} cas`);
});

test("placeBoostedItems : au moins un promu monte réellement quand c'est possible (le boost n'est pas inerte)", () => {
  // Part 0,15, N = 30, un promouvable lointain : il passe en tête.
  assert.equal(run(30, new Set([20]), 0.15).order[0], 20);
  // Part 0,2 : promus aux positions 0 et 5 (promouvables lointains).
  const result = run(20, new Set([15, 16]), 0.2);
  assert.equal(result.order[0], 15);
  assert.equal(result.order[5], 16);
  assert.equal(result.promoted.size, 2);
});

test("isPromotedByBoost (portée visible, lot P2-bis) : sous 7 éléments aucun boost ne monte ; dès 7 l'élément monte sauf s'il est déjà premier ; un autre promouvable mieux classé prend le quota", () => {
  const list = (count: number) => Array.from({ length: count }, (_, index) => index);
  for (let count = 1; count <= 6; count += 1) {
    assert.equal(computeMaxPromoted(count, 0.15), 0, `quota nul pour ${count} élément(s)`);
    for (let target = 0; target < count; target += 1) assert.equal(isPromotedByBoost(list(count), target, (item) => (item === target ? item : null), 0.15), false, `N=${count}, cible ${target}`);
  }
  for (const count of [7, 8, 13]) {
    assert.equal(isPromotedByBoost(list(count), 0, (item) => (item === 0 ? item : null), 0.15), false, `N=${count} : déjà premier, rien ne monte`);
    for (let target = 1; target < count; target += 1) assert.equal(isPromotedByBoost(list(count), target, (item) => (item === target ? item : null), 0.15), true, `N=${count}, cible ${target}`);
  }
  // Non promouvable (pertinence sous le seuil) : jamais.
  assert.equal(isPromotedByBoost(list(10), 5, () => null, 0.15), false);
  // Quota 1 (N = 7 à 13) pris par un autre élément promouvable classé avant la cible : la cible ne monte pas ; quota 2 (N = 14, positions 0 et 7) : elle monte (à condition de gagner des places).
  assert.equal(isPromotedByBoost(list(7), 5, (item) => (item === 5 || item === 2 ? item : null), 0.15), false);
  assert.equal(isPromotedByBoost(list(14), 12, (item) => (item === 12 || item === 2 ? item : null), 0.15), true);
  // Un autre promouvable DÉJÀ premier ne consomme pas le quota, mais la position 0 est passée : la cible attend la position suivante (7).
  assert.equal(isPromotedByBoost(list(7), 5, (item) => (item === 5 || item === 0 ? item : null), 0.15), false);
  assert.equal(isPromotedByBoost(list(14), 12, (item) => (item === 12 || item === 0 ? item : null), 0.15), true);
  // Indices invalides : faux, jamais d'exception.
  for (const target of [-1, 10, 1.5, Number.NaN]) assert.equal(isPromotedByBoost(list(10), target, () => 0, 0.15), false, String(target));
  assert.throws(() => isPromotedByBoost(list(10), 3, () => 0, 0), RangeError);
});

test("isPromotedByBoost : identique, pour chaque élément de chaque liste, à la décision de placeBoostedItems (une seule implémentation du placement)", () => {
  let cases = 0;
  for (const share of [0.15, 0.2, 0.5, 1, 0.07]) {
    for (let count = 1; count <= 40; count += 1) {
      const items = Array.from({ length: count }, (_, index) => index);
      for (const promotable of [new Set<number>(), new Set([count - 1]), new Set([0, count - 1]), new Set(items), new Set(items.filter((item) => item % 3 === 0))]) {
        const placed = placeBoostedItems(items, (item) => (promotable.has(item) ? item : null), share);
        for (let target = 0; target < count; target += 1) {
          const expected = placed.some((entry) => entry.item === target && entry.promoted);
          assert.equal(isPromotedByBoost(items, target, (item) => (promotable.has(item) ? item : null), share), expected, `part ${share}, N=${count}, cible ${target}`);
          cases += 1;
        }
      }
    }
  }
  assert.ok(cases > 10_000, `${cases} cas`);
});

// ═════════════ Priorité d'ANCIENNETÉ (lot P3) ═════════════

/** Rangs d'ancienneté d'un ensemble de promouvables : `order` liste les indices organiques du boost le plus ANCIEN au plus récent. */
const ranksOf = (order: readonly number[]): ReadonlyMap<number, number> => new Map(order.map((organicIndex, rank) => [organicIndex, rank]));

function runAged(count: number, order: readonly number[], share: number) {
  const ranks = ranksOf(order);
  const placed = placeBoostedItems(labels(count), (_, index) => ranks.get(index) ?? null, share);
  return { order: placed.map((entry) => indexOfLabel(entry.item)), promoted: new Set(placed.filter((entry) => entry.promoted).map((entry) => indexOfLabel(entry.item))) };
}

test("priorité d'ancienneté : le scénario B de l'audit (liste de 8, quota 1) — D acheté en premier garde sa place, A (mieux classé, acheté après) ne la prend pas", () => {
  // N = 8, part 0,15 → quota 1 (position 0). A est classé 2e (indice 2), D 6e (indice 5). Ancien ordre (organique) : A prenait le quota, D payait pour rien.
  const organicFirst = run(8, new Set([2, 5]), 0.15);
  assert.deepEqual([...organicFirst.promoted], [2], "ancien placement : A promu, D évincé");
  // Priorité d'ancienneté : D (rang 0, le plus ancien) est promu, A (rang 1) n'a plus de place.
  const aged = runAged(8, [5, 2], 0.15);
  assert.deepEqual(aged.order, [5, 0, 1, 2, 3, 4, 6, 7]);
  assert.deepEqual([...aged.promoted], [5], "D promu en tête (5 → 0)");
  assert.ok(!aged.promoted.has(2), "A n'est pas promu : le quota est épuisé par le boost plus ancien");
  // Si A est le plus ancien, c'est lui qui est promu.
  assert.deepEqual([...runAged(8, [2, 5], 0.15).promoted], [2]);
});

test("priorité d'ancienneté : exemples calculés à la main (deux positions de promotion, boost ancien non montant, boost ancien déjà en tête)", () => {
  // N = 20 → quota 3, pas 7. Promouvables 10 (le plus ancien), 6, 15 (le plus récent).
  // p0 : le plus ancien promouvable est 10 (10 > 0) → promu en 0. p1 à p6 : têtes 0 1 2 3 4 5. p7 : restants 6 7 8 9 11 … ; le plus ancien promouvable restant est 6, la
  // tête : sa position organique (6) n'est pas > 7, il n'a RIEN à gagner → la tête est placée, le quota n'est pas consommé, et 15 (plus récent) ne prend PAS p7.
  // p8 à p13 : 7 8 9 11 12 13. p14 : tête 14, le seul promouvable restant est 15 (15 > 14) → promu en 14 (quota consommé : 2 sur 3).
  const result = runAged(20, [10, 6, 15], 0.15);
  assert.deepEqual(result.order.slice(0, 16), [10, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 13, 15, 14]);
  assert.deepEqual([...result.promoted].sort((a, b) => a - b), [10, 15]);
  assert.equal(result.order.indexOf(6), 7, "le boost ancien qui n'a rien à gagner garde sa place (6 → 7, descendu d'un seul cran par le promu 10)");
  assert.equal(result.order.indexOf(15), 14, "15 est promu à la position de promotion suivante (14), pas avant");
  // Même liste, ordre d'ancienneté inversé (le plus récent d'abord) : 15 est servi en premier, 10 à la position suivante.
  const reversed = runAged(20, [15, 6, 10], 0.15);
  assert.equal(reversed.order[0], 15);
  assert.ok(reversed.promoted.has(15));
  // Boost ancien en tête de file : il n'est pas promu (rien à gagner), le plus récent attend la position suivante.
  const head = runAged(14, [0, 9], 0.15);
  assert.deepEqual([...head.promoted], [9]);
  assert.equal(head.order.indexOf(9), 7);
});

test("compareBoostAge et rankBoostsByAge : starts_at croissant à la microseconde, puis identifiant du boost ; rang 0 = le plus ancien", () => {
  const boost = (key: string, startsAt: string, boostId: string): AgedBoost => ({ key, startsAt, boostId });
  const a = boost("a", "2026-10-06T10:00:00.000002Z", "00000000-0000-4000-8000-000000000002");
  const b = boost("b", "2026-10-06T10:00:00.000001Z", "00000000-0000-4000-8000-000000000009"); // plus ancien d'une microseconde malgré l'identifiant plus grand
  const c = boost("c", "2026-10-06T10:00:00.000002Z", "00000000-0000-4000-8000-000000000001"); // même instant que a, identifiant plus petit
  assert.equal(compareBoostAge(b, a), -1);
  assert.equal(compareBoostAge(a, b), 1);
  assert.equal(compareBoostAge(c, a), -1, "à l'instant égal, l'identifiant du boost départage");
  assert.equal(compareBoostAge(a, a), 0);
  assert.deepEqual([...rankBoostsByAge([a, b, c])], [["b", 0], ["c", 1], ["a", 2]]);
  assert.deepEqual([...rankBoostsByAge([c, a, b])], [["b", 0], ["c", 1], ["a", 2]], "indépendant de l'ordre d'entrée");
  assert.deepEqual([...rankBoostsByAge([])], []);
  // Un jour plus tard ou une année plus tard : l'ordre du texte est l'ordre du temps (largeur fixe).
  assert.equal(compareBoostAge(boost("x", "2026-10-06T23:59:59.999999Z", "f"), boost("y", "2026-10-07T00:00:00.000000Z", "0")), -1);
});

/** Ancien placement (organique d'abord), recopié ICI comme modèle de référence indépendant, en entiers (centièmes). */
function referenceOrganicFirst(count: number, promotable: ReadonlySet<number>, hundredths: number) {
  const step = Math.ceil(100 / hundredths);
  const maxPromoted = Math.floor((hundredths * count) / 100);
  const queue = Array.from({ length: count }, (_, index) => index);
  const order: number[] = [];
  const promoted = new Set<number>();
  for (let position = 0; position < count; position += 1) {
    let pick = queue[0];
    if (position % step === 0 && promoted.size < maxPromoted) {
      const candidate = queue.find((index) => promotable.has(index));
      if (candidate !== undefined && candidate !== queue[0]) { pick = candidate; promoted.add(candidate); }
    }
    queue.splice(queue.indexOf(pick), 1);
    order.push(pick);
  }
  return { order, promoted };
}

function permutations(items: readonly number[]): number[][] {
  if (items.length <= 1) return [[...items]];
  return items.flatMap((item, index) => permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [item, ...rest]));
}

test("placement par ancienneté : propriétés exhaustives (listes de 0 à 9 éléments, 6 parts, tous les ensembles de promouvables et leurs ordres d'ancienneté ≤ 4 boosts, échantillon au-delà)", () => {
  let seed = 7_061_026;
  const random = () => { seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0; return seed / 0x1_0000_0000; };
  let cases = 0;
  let noEvictionChecks = 0;
  for (const hundredths of [5, 15, 20, 34, 50, 100]) {
    const share = hundredths / 100;
    const step = Math.ceil(100 / hundredths);
    for (let count = 0; count <= 9; count += 1) {
      const maxPromoted = Math.floor((hundredths * count) / 100);
      for (let mask = 0; mask < 1 << count; mask += 1) {
        const promotable = Array.from({ length: count }, (_, index) => index).filter((index) => (mask >> index) & 1);
        const orders = promotable.length <= 4
          ? permutations(promotable)
          : Array.from({ length: 6 }, () => [...promotable].sort(() => random() - 0.5));
        for (const order of orders) {
          const context = `part ${share}, N=${count}, ancienneté ${order.join(">")}`;
          const result = runAged(count, order, share);
          // Permutation exacte : aucun doublon, ajout ni retrait.
          assert.deepEqual([...result.order].sort((x, y) => x - y), Array.from({ length: count }, (_, index) => index), context);
          const finalOf = new Map(result.order.map((organicIndex, position) => [organicIndex, position]));
          // Un promu est promouvable, MONTE strictement ; promu ⇔ position finale < position organique ; au plus floor(part × N) ; positions k × pas.
          for (let index = 0; index < count; index += 1) {
            const final = finalOf.get(index)!;
            assert.equal(result.promoted.has(index), final < index, `promu ⇔ montée ; ${index} → ${final} ; ${context}`);
            if (result.promoted.has(index)) {
              assert.ok(order.includes(index), `promu non promouvable ; ${context}`);
              assert.equal(final % step, 0, `position de promotion ; ${context}`);
            }
          }
          assert.ok(result.promoted.size <= maxPromoted, `quota ; ${context}`);
          // Les non-promus gardent leur ordre relatif.
          const others = result.order.filter((index) => !result.promoted.has(index));
          assert.deepEqual(others, [...others].sort((x, y) => x - y), `ordre des non-promus ; ${context}`);
          // Les promus se suivent du boost le plus ANCIEN au plus récent (jamais selon l'ordre organique).
          const promotedByPosition = [...result.promoted].sort((x, y) => finalOf.get(x)! - finalOf.get(y)!);
          const ranks = ranksOf(order);
          for (let i = 1; i < promotedByPosition.length; i += 1) {
            assert.ok(ranks.get(promotedByPosition[i - 1])! < ranks.get(promotedByPosition[i])!, `ancienneté croissante des promus ; ${context}`);
          }
          // Avec priorité = indice organique, c'est EXACTEMENT l'ancien placement (modèle de référence indépendant).
          if (order.every((organicIndex, position) => position === 0 || order[position - 1] < organicIndex)) {
            const reference = referenceOrganicFirst(count, new Set(promotable), hundredths);
            assert.deepEqual(result.order, reference.order, `équivalence avec l'ancien placement ; ${context}`);
            assert.deepEqual([...result.promoted].sort((x, y) => x - y), [...reference.promoted].sort((x, y) => x - y), context);
          }
          // AUCUNE ÉVICTION : ajouter un promouvable PLUS RÉCENT que tous les autres ne change la décision (promu ou non) d'aucun autre élément.
          for (let extra = 0; extra < count; extra += 1) {
            if (order.includes(extra)) continue;
            const withExtra = runAged(count, [...order, extra], share);
            for (const other of order) {
              assert.equal(withExtra.promoted.has(other), result.promoted.has(other), `éviction de ${other} par ${extra} ; ${context}`);
            }
            for (let index = 0; index < count; index += 1) {
              if (index !== extra && !order.includes(index)) assert.ok(!withExtra.promoted.has(index), `non promouvable promu ; ${context}`);
            }
            noEvictionChecks += 1;
          }
          cases += 1;
        }
      }
    }
  }
  assert.ok(cases > 20_000, `${cases} cas`);
  assert.ok(noEvictionChecks > 20_000, `${noEvictionChecks} vérifications d'absence d'éviction`);
});

test("isPromotedByBoost avec priorité d'ancienneté : le candidat AJOUTÉ comme boost le plus récent n'est atteignable que s'il est promu sans évincer personne", () => {
  const list = Array.from({ length: 8 }, (_, index) => index);
  // Liste de 8 (quota 1) ; D (indice 5) est déjà boosté : A (indice 2), ajouté comme le plus récent, n'est pas atteignable.
  const ranks = new Map<number, number>([[5, 0]]);
  const candidate = 2;
  const priority = (item: number) => (item === candidate ? ranks.size : ranks.get(item) ?? null);
  assert.equal(isPromotedByBoost(list, candidate, priority, 0.15), false);
  assert.equal(isPromotedByBoost(list, 5, priority, 0.15), true, "D garde sa place promue, même quand A est candidat");
  // Sans boost existant, A (indice 2) est atteignable (promu en tête).
  assert.equal(isPromotedByBoost(list, candidate, (item) => (item === candidate ? 0 : null), 0.15), true);
  // Liste de 14 (quota 2 : positions 0 et 7) : D (indice 5) promu en 0, A (indice 9, candidat le plus récent) promu en 7 : deux places, aucune éviction.
  const list14 = Array.from({ length: 14 }, (_, index) => index);
  assert.equal(isPromotedByBoost(list14, 9, (item) => (item === 9 ? 1 : item === 5 ? 0 : null), 0.15), true);
  assert.equal(isPromotedByBoost(list14, 5, (item) => (item === 9 ? 1 : item === 5 ? 0 : null), 0.15), true, "D reste promu");
  // Un candidat déjà proche de la tête (indice 2) n'atteint pas la position 7 : rien à gagner.
  assert.equal(isPromotedByBoost(list14, 2, (item) => (item === 2 ? 1 : item === 5 ? 0 : null), 0.15), false);
});

test("créneaux de calcul (createReachGate) : au plus `capacité` simultanés, file équitable, attente bornée → quote_busy, libération idempotente", async () => {
  assert.throws(() => createReachGate(0), RangeError);
  assert.throws(() => createReachGate(1.5), RangeError);
  const gate = createReachGate(2);
  const releaseA = await gate.acquire(50);
  const releaseB = await gate.acquire(50);
  assert.deepEqual(gate.stats(), { active: 2, waiting: 0 });
  const order: string[] = [];
  const waitingC = gate.acquire(1_000).then((release) => { order.push("C"); return release; });
  const waitingD = gate.acquire(1_000).then((release) => { order.push("D"); return release; });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(gate.stats(), { active: 2, waiting: 2 }, "deux attendent");
  assert.deepEqual(order, []);
  releaseA();
  releaseA(); // idempotent : un second appel ne libère pas un second créneau
  const releaseC = await waitingC;
  assert.deepEqual(order, ["C"], "premier arrivé, premier servi");
  assert.deepEqual(gate.stats(), { active: 2, waiting: 1 });
  // Attente bornée : un troisième arrivant sans créneau est refusé après son délai.
  const refused = await gate.acquire(30).then(() => "accepté", (error: unknown) => (error as { code?: string }).code);
  assert.equal(refused, "quote_busy");
  assert.deepEqual(gate.stats(), { active: 2, waiting: 1 }, "la demande refusée n'est plus en file");
  releaseB();
  const releaseD = await waitingD;
  assert.deepEqual(order, ["C", "D"]);
  releaseC();
  releaseD();
  assert.deepEqual(gate.stats(), { active: 0, waiting: 0 });
});
