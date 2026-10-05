import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BOOST_DURATION_CODES, BOOST_DURATION_SECONDS, BOOST_SCOPE_LOCK_NAMESPACE, BOOST_SOURCES,
} from "../../lib/server/boost/boost-config";
import { computeSellerLimit, computeSlots, type BoostSettings } from "../../lib/server/boost/boosts";
import { computeMaxPromoted, computePromotionStep, placeBoostedItems } from "../../lib/server/boost/placement";
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
  const placed = placeBoostedItems(labels(count), (_, index) => promotable.has(index), share);
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
  assert.deepEqual(placeBoostedItems([], () => true, 0.15), []);
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
