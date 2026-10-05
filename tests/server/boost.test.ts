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

test("placeBoostedItems : promus aux positions 0, 7, 14, 21 ; les autres gardent leur ordre relatif ; aucun doublon", () => {
  const organic = labels(30);
  const promotable = new Set([5, 9, 12, 20, 25]);
  const placed = placeBoostedItems(organic, (_, index) => promotable.has(index), 0.15);
  assert.equal(placed.length, 30);
  assert.equal(computeMaxPromoted(30, 0.15), 4);
  // Quatre promus au plus : les quatre premiers promouvables dans l'ordre organique ; le cinquième (25) reste non promu.
  const promotedPositions = placed.map((entry, position) => (entry.promoted ? position : -1)).filter((position) => position >= 0);
  assert.deepEqual(promotedPositions, [0, 7, 14, 21]);
  assert.deepEqual(promotedPositions.map((position) => placed[position].item), ["item-5", "item-9", "item-12", "item-20"]);
  assert.equal(placed.find((entry) => entry.item === "item-25")!.promoted, false);
  // Permutation exacte.
  assert.deepEqual([...placed.map((entry) => entry.item)].sort(), [...organic].sort());
  assert.equal(new Set(placed.map((entry) => entry.item)).size, 30);
  // Ordre relatif des non-promus = ordre organique.
  assert.deepEqual(placed.filter((entry) => !entry.promoted).map((entry) => entry.item), organic.filter((_, index) => ![5, 9, 12, 20].includes(index)));
});

test("placeBoostedItems : aucun promouvable → ordre inchangé ; moins de 7 éléments → aucun promu ; liste vide", () => {
  const organic = labels(12);
  assert.deepEqual(placeBoostedItems(organic, () => false, 0.15).map((entry) => [entry.item, entry.promoted]), organic.map((item) => [item, false]));
  const six = labels(6);
  assert.equal(computeMaxPromoted(6, 0.15), 0);
  assert.ok(placeBoostedItems(six, () => true, 0.15).every((entry) => !entry.promoted));
  assert.deepEqual(placeBoostedItems(six, () => true, 0.15).map((entry) => entry.item), six);
  assert.deepEqual(placeBoostedItems([], () => true, 0.15), []);
  // 7 éléments : un promu, en position 0.
  const seven = labels(7);
  const placed = placeBoostedItems(seven, (_, index) => index === 4 || index === 6, 0.15);
  assert.deepEqual(placed.map((entry) => entry.item), ["item-4", "item-0", "item-1", "item-2", "item-3", "item-5", "item-6"]);
  assert.deepEqual(placed.map((entry) => entry.promoted), [true, false, false, false, false, false, false]);
});

test("placeBoostedItems : un promu déjà bien classé est promu aussi (même place), un promouvable au-delà du maximum ne l'est pas", () => {
  const organic = labels(20);
  const placed = placeBoostedItems(organic, (_, index) => index < 6, 0.15); // N = 20 → 3 promus, positions 0, 7, 14
  assert.deepEqual(placed.map((entry, position) => (entry.promoted ? position : -1)).filter((position) => position >= 0), [0, 7, 14]);
  assert.deepEqual([0, 7, 14].map((position) => placed[position].item), ["item-0", "item-1", "item-2"]);
  assert.deepEqual(placed.filter((entry) => !entry.promoted).map((entry) => entry.item), organic.filter((_, index) => index >= 3));
});

test("placeBoostedItems : les positions doivent tenir dans la liste (part 0,19 sur 100 éléments : 17 promus, pas 19)", () => {
  const organic = labels(100);
  assert.equal(computeMaxPromoted(100, 0.19), 19);
  assert.equal(computePromotionStep(0.19), 6);
  const placed = placeBoostedItems(organic, () => true, 0.19);
  const positions = placed.map((entry, position) => (entry.promoted ? position : -1)).filter((position) => position >= 0);
  assert.equal(positions.length, 17, "ceil(100 / 6) = 17 positions disponibles");
  assert.deepEqual(positions, Array.from({ length: 17 }, (_, rank) => rank * 6));
  assert.equal(new Set(placed.map((entry) => entry.item)).size, 100);
});

test("placeBoostedItems : propriétés sur 300 cas pseudo-aléatoires (permutation, plafond, positions, ordre relatif, déterminisme)", () => {
  let seed = 123_456_789;
  const next = () => { seed = (seed * 1_103_515_245 + 12_345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let run = 0; run < 300; run++) {
    const count = Math.floor(next() * 120);
    const share = [0.05, 0.1, 0.125, 0.15, 0.17, 0.2][Math.floor(next() * 6)];
    const organic = labels(count);
    const flags = organic.map(() => next() < 0.4);
    const placed = placeBoostedItems(organic, (_, index) => flags[index], share);
    const again = placeBoostedItems(organic, (_, index) => flags[index], share);
    assert.deepEqual(placed, again, "déterminisme");
    assert.equal(placed.length, count);
    assert.equal(new Set(placed.map((entry) => entry.item)).size, count, "aucun doublon");
    const promoted = placed.filter((entry) => entry.promoted);
    assert.ok(promoted.length <= computeMaxPromoted(count, share), `plafond (N=${count}, part=${share})`);
    const step = computePromotionStep(share);
    placed.forEach((entry, position) => { if (entry.promoted) assert.equal(position % step, 0, "positions k × pas"); });
    // Seuls les promouvables sont promus, et ce sont les premiers dans l'ordre organique.
    const promouvables = organic.filter((_, index) => flags[index]);
    assert.deepEqual(promoted.map((entry) => entry.item), promouvables.slice(0, promoted.length));
    const promotedSet = new Set(promoted.map((entry) => entry.item));
    assert.deepEqual(placed.filter((entry) => !entry.promoted).map((entry) => entry.item), organic.filter((item) => !promotedSet.has(item)));
    // Promus consécutifs : positions 0, step, 2 × step, … sans trou.
    const positions = placed.map((entry, position) => (entry.promoted ? position : -1)).filter((position) => position >= 0);
    assert.deepEqual(positions, positions.map((_, rank) => rank * step));
  }
});
