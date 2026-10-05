import assert from "node:assert/strict";
import { test } from "node:test";
import { BOOST_DURATION_CODES, type BoostDurationCode } from "../../lib/server/boost/boost-config";
import {
  computeBoostPrice, computeCompetitionFactor, computeDemandFactor, computeDurationFactor, computeScarcityFactor,
  validatePricingSettings, type BoostPricingSettings,
} from "../../lib/server/boost/pricing";

const DEFAULTS: BoostPricingSettings = {
  key: "default", version: 1, currency: "XOF", baseAmount: 500, gridAmount: 100, minAmount: 500, maxAmount: 50_000,
  competitionStepMilli: 20, competitionMaxMilli: 1500, demandStepMilli: 100, demandMaxMilli: 3000, scarcityMaxMilli: 2000,
  duration24hMilli: 1000, duration3dMilli: 2500, duration7dMilli: 5000, quoteValiditySeconds: 900,
};
const settings = (extra: Partial<BoostPricingSettings>): BoostPricingSettings => ({ ...DEFAULTS, ...extra });
const price = (inputs: { s: number; d: number; used: number; total: number; code?: BoostDurationCode; settings?: BoostPricingSettings }) =>
  computeBoostPrice({ competingSellers: inputs.s, compatibleBuyers: inputs.d, slotsUsed: inputs.used, slotsTotal: inputs.total, durationCode: inputs.code ?? "24h", settings: inputs.settings ?? DEFAULTS });

// ───────────── oracle INDÉPENDANT : rationnels exacts (numérateur/dénominateur BigInt réduits), sans les formules du module ─────────────

type Fraction = { n: bigint; d: bigint };
const big = (value: number): bigint => BigInt(value);
const ZERO = big(0);
const gcd = (a: bigint, b: bigint): bigint => { while (b !== ZERO) { [a, b] = [b, a % b]; } return a; };
const fraction = (n: bigint, d: bigint): Fraction => { const g = gcd(n, d); return { n: n / g, d: d / g }; };
const times = (a: Fraction, b: Fraction): Fraction => fraction(a.n * b.n, a.d * b.d);
const lessThan = (a: Fraction, b: Fraction): boolean => a.n * b.d < b.n * a.d;
const minFraction = (a: Fraction, b: Fraction): Fraction => (lessThan(b, a) ? b : a);
const milli = (value: number): Fraction => fraction(big(value), big(1000));

/** floor(k) maximal avec k × total ≤ numerator, par recherche (aucune division). */
function largestMultiple(numerator: number, total: number): number {
  let k = 0;
  while ((k + 1) * total <= numerator) k += 1;
  return k;
}

function oracle(s: number, d: number, used: number, total: number, code: BoostDurationCode, cfg: BoostPricingSettings) {
  const competition = minFraction(milli(1000 + cfg.competitionStepMilli * s), milli(cfg.competitionMaxMilli));
  const demand = minFraction(milli(1000 + cfg.demandStepMilli * (d - 1)), milli(cfg.demandMaxMilli));
  const scarcityMilli = 1000 + largestMultiple((cfg.scarcityMaxMilli - 1000) * used, total);
  const durationMilli = { "24h": cfg.duration24hMilli, "3d": cfg.duration3dMilli, "7d": cfg.duration7dMilli }[code];
  const raw = times(times(times(times(fraction(big(cfg.baseAmount), big(1)), competition), demand), milli(scarcityMilli)), milli(durationMilli));
  // Décimal exact à 12 décimales : le dénominateur réduit divise toujours 10^12 (produit de quatre millièmes).
  const scale = big(1_000_000_000) * big(1000);
  assert.equal(scale % raw.d, ZERO, "dénominateur réduit qui divise 10^12");
  const scaled = (raw.n * scale) / raw.d;
  const digits = scaled.toString().padStart(13, "0");
  const rawText = `${digits.slice(0, -12)}.${digits.slice(-12)}`;
  // Arrondi à la grille, demi vers le haut : k = plancher(brut / grille) ; k + 1 si le reste atteint la moitié de la grille.
  const grid = big(cfg.gridAmount);
  let units = raw.n / (raw.d * grid);
  const remainder = raw.n - units * grid * raw.d;
  if (big(2) * remainder >= grid * raw.d) units += big(1);
  let amount = units * grid;
  if (amount < big(cfg.minAmount)) amount = big(cfg.minAmount);
  if (amount > big(cfg.maxAmount)) amount = big(cfg.maxAmount);
  return {
    amount: Number(amount), rawText,
    factors: { competitionMilli: Number((competition.n * big(1000)) / competition.d), demandMilli: Number((demand.n * big(1000)) / demand.d), scarcityMilli, durationMilli },
    numerator: scaled,
  };
}

// ───────────── contrôle et exemples calculés à la main ─────────────

test("exemple de contrôle : S = 3, D = 4, used = 1 sur 3, durée 3d, réglages par défaut → 1060 / 1300 / 1333 / 2500, brut 2 296,0925, 2 300 XOF", () => {
  const result = price({ s: 3, d: 4, used: 1, total: 3, code: "3d" });
  assert.deepEqual(result.factors, { competitionMilli: 1060, demandMilli: 1300, scarcityMilli: 1333, durationMilli: 2500 });
  // 500 × 1,060 × 1,300 × 1,333 × 2,500 = 2 296,0925 (calcul à la main : 500 × 1,378 = 689 ; × 1,333 = 918,437 ; × 2,5 = 2 296,0925).
  assert.equal(result.rawAmount, "2296.092500000000");
  assert.equal(result.amount, 2300, "2 296,0925 arrondi à la grille de 100 → 2 300");
});

test("exemples calculés à la main : clamp au minimum, clamp au maximum, brut pile à mi-grille, rareté avec used = total − 1", () => {
  // Minimum : base 450, tous les facteurs à 1000 → brut 450 ; arrondi 500 (4,5 → 5) ; le minimum 1000 l'emporte.
  const atMin = price({ s: 0, d: 1, used: 0, total: 5, settings: settings({ baseAmount: 450, minAmount: 1000 }) });
  assert.equal(atMin.rawAmount, "450.000000000000");
  assert.equal(atMin.amount, 1000);
  // Minimum par défaut : brut 500 → 500.
  assert.equal(price({ s: 0, d: 1, used: 0, total: 5 }).amount, 500);
  // Maximum : base 10 000 ; concurrence 1500, demande 3000, rareté 1000 + floor(1000 × 2 / 3) = 1666, durée 7d = 5000.
  // 10 000 × 1,5 × 3 × 1,666 × 5 = 374 850 → arrondi 374 900 → plafonné à 50 000.
  const atMax = price({ s: 100, d: 100, used: 2, total: 3, code: "7d", settings: settings({ baseAmount: 10_000 }) });
  assert.deepEqual(atMax.factors, { competitionMilli: 1500, demandMilli: 3000, scarcityMilli: 1666, durationMilli: 5000 });
  assert.equal(atMax.rawAmount, "374850.000000000000");
  assert.equal(atMax.amount, 50_000);
  // Pile à mi-grille : base 1500, pas de concurrence 500 (max 1500), S = 1 → 1500 × 1,5 = 2 250 → demi-haut → 2 300.
  const tie = settings({ baseAmount: 1500, competitionStepMilli: 500 });
  assert.equal(price({ s: 1, d: 1, used: 0, total: 5, settings: tie }).rawAmount, "2250.000000000000");
  assert.equal(price({ s: 1, d: 1, used: 0, total: 5, settings: tie }).amount, 2300, "2 250 : demi-haut");
  // Juste sous la mi-grille : pas 499 → 1500 × 1,499 = 2 248,5 → 2 200.
  assert.equal(price({ s: 1, d: 1, used: 0, total: 5, settings: settings({ baseAmount: 1500, competitionStepMilli: 499 }) }).amount, 2200);
  // Rareté : used = total − 1 → 1000 + floor(1000 × (total − 1) / total).
  assert.equal(computeScarcityFactor(2, 3, DEFAULTS), 1666);
  assert.equal(computeScarcityFactor(6, 7, DEFAULTS), 1857);
  assert.equal(computeScarcityFactor(0, 3, DEFAULTS), 1000);
  assert.equal(computeScarcityFactor(0, 1, DEFAULTS), 1000, "une seule place libre : aucune rareté");
  assert.equal(computeScarcityFactor(49, 50, DEFAULTS), 1980);
  // Facteurs : plafonds et durées.
  assert.equal(computeCompetitionFactor(0, DEFAULTS), 1000);
  assert.equal(computeCompetitionFactor(25, DEFAULTS), 1500);
  assert.equal(computeCompetitionFactor(26, DEFAULTS), 1500, "plafonné");
  assert.equal(computeDemandFactor(1, DEFAULTS), 1000);
  assert.equal(computeDemandFactor(21, DEFAULTS), 3000);
  assert.equal(computeDemandFactor(1000, DEFAULTS), 3000, "plafonné");
  assert.deepEqual(BOOST_DURATION_CODES.map((code) => computeDurationFactor(code, DEFAULTS)), [1000, 2500, 5000]);
});

test("un montant arrondi APRÈS un clamp dépasserait les bornes : ici l'arrondi précède le clamp et le résultat reste dans [min, max] sur la grille", () => {
  // Bornes 700 et 1 300, grille 100 : un brut de 649,99 s'arrondit à 600 puis est relevé à 700 ; un brut de 1 349,99 à 1 300 ; un brut de 1 350 à 1 400 puis ramené à 1 300.
  const cfg = settings({ minAmount: 700, maxAmount: 1300, baseAmount: 650, scarcityMaxMilli: 1000 });
  const below = computeBoostPrice({ competingSellers: 0, compatibleBuyers: 1, slotsUsed: 0, slotsTotal: 3, durationCode: "24h", settings: settings({ ...cfg, baseAmount: 649 }) });
  assert.equal(below.amount, 700);
  const high = computeBoostPrice({ competingSellers: 0, compatibleBuyers: 1, slotsUsed: 0, slotsTotal: 3, durationCode: "3d", settings: settings({ ...cfg, baseAmount: 540 }) });
  assert.equal(high.rawAmount, "1350.000000000000");
  assert.equal(high.amount, 1300, "1 350 → arrondi 1 400 → borné à 1 300 (jamais 1 400)");
});

// ───────────── grille exhaustive reproductible contre l'oracle ─────────────

function generator(seed: number) {
  let state = seed >>> 0;
  const next = () => { state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0; return state / 0x1_0000_0000; };
  return { int: (min: number, max: number) => min + Math.floor(next() * (max - min + 1)), pick: <T,>(items: readonly T[]): T => items[Math.floor(next() * items.length)], next };
}

function randomSettings(random: ReturnType<typeof generator>, extreme: boolean): BoostPricingSettings {
  const grid = random.pick([1, 5, 10, 50, 100, 250, 500, 1000]);
  const min = grid * random.int(1, 20);
  const max = min + grid * random.int(0, extreme ? 2_000_000 : 2000);
  const durations = [random.int(1000, 20_000), random.int(1000, 20_000), random.int(1000, 20_000)].sort((a, b) => a - b);
  return {
    key: "default", version: random.int(1, 9), currency: "XOF",
    baseAmount: extreme ? random.int(5_000_000, 10_000_000) : random.int(1, 100_000), gridAmount: grid, minAmount: min, maxAmount: Math.min(max, 2_000_000_000 - (2_000_000_000 % grid)),
    competitionStepMilli: random.int(0, 1000), competitionMaxMilli: random.int(1000, 5000), demandStepMilli: random.int(0, 1000), demandMaxMilli: random.int(1000, 5000),
    scarcityMaxMilli: random.int(1000, 5000), duration24hMilli: durations[0], duration3dMilli: durations[1], duration7dMilli: durations[2],
    quoteValiditySeconds: random.int(60, 3600),
  };
}

test("grille de 24 000 cas reproductibles (réglages, S, D, places, durées aléatoires dont des montants extrêmes) = oracle rationnel indépendant ; sur la grille et dans [min, max]", () => {
  const random = generator(20_261_005);
  let cases = 0;
  let beyondFloat = 0;
  for (let run = 0; run < 24_000; run++) {
    const extreme = run % 4 === 0;
    const cfg = randomSettings(random, extreme);
    validatePricingSettings(cfg);
    const total = random.int(1, 80);
    const used = random.int(0, total - 1);
    const s = random.pick([0, 1, 2, 5, 20, 50, 500, random.int(0, 3000)]);
    const d = random.pick([1, 2, 3, 10, 30, 1000, random.int(1, 3000)]);
    const code = random.pick(BOOST_DURATION_CODES);
    const actual = computeBoostPrice({ competingSellers: s, compatibleBuyers: d, slotsUsed: used, slotsTotal: total, durationCode: code, settings: cfg });
    const expected = oracle(s, d, used, total, code, cfg);
    const context = JSON.stringify({ s, d, used, total, code, cfg });
    assert.equal(actual.amount, expected.amount, context);
    assert.equal(actual.rawAmount, expected.rawText, context);
    assert.deepEqual(actual.factors, expected.factors, context);
    assert.ok(actual.amount % cfg.gridAmount === 0, `sur la grille ; ${context}`);
    assert.ok(actual.amount >= cfg.minAmount && actual.amount <= cfg.maxAmount, `dans [min, max] ; ${context}`);
    if (expected.numerator > big(Number.MAX_SAFE_INTEGER)) beyondFloat += 1;
    cases += 1;
  }
  assert.equal(cases, 24_000);
  assert.ok(beyondFloat > 3000, `${beyondFloat} cas dont le produit exact dépasse 2^53 : un calcul flottant ne serait pas exact`);
});

test("monotonie : le montant ne décroît jamais quand S, D, les places utilisées ou la durée augmentent (200 configurations)", () => {
  const random = generator(77_001);
  for (let run = 0; run < 200; run++) {
    const cfg = randomSettings(random, run % 3 === 0);
    const total = random.int(2, 40);
    const used = random.int(0, total - 1);
    const s = random.int(0, 30);
    const d = random.int(1, 30);
    const code = random.pick(BOOST_DURATION_CODES);
    const at = (overrides: Partial<{ s: number; d: number; used: number; code: BoostDurationCode }>) =>
      computeBoostPrice({ competingSellers: overrides.s ?? s, compatibleBuyers: overrides.d ?? d, slotsUsed: overrides.used ?? used, slotsTotal: total, durationCode: overrides.code ?? code, settings: cfg }).amount;
    for (let step = 0; step < 60; step++) assert.ok(at({ s: step + 1 }) >= at({ s: step }), `S ${step} → ${step + 1}`);
    for (let step = 1; step < 60; step++) assert.ok(at({ d: step + 1 }) >= at({ d: step }), `D ${step} → ${step + 1}`);
    for (let step = 0; step < total - 1; step++) assert.ok(at({ used: step + 1 }) >= at({ used: step }), `used ${step} → ${step + 1}`);
    assert.ok(at({ code: "3d" }) >= at({ code: "24h" }) && at({ code: "7d" }) >= at({ code: "3d" }), "durée");
  }
});

// ───────────── configurations et entrées invalides ─────────────

test("validatePricingSettings : RangeError sur chaque configuration incohérente (et acceptation des bornes)", () => {
  assert.deepEqual(validatePricingSettings(DEFAULTS), DEFAULTS);
  const bad: Array<[string, Partial<BoostPricingSettings>]> = [
    ["clé en majuscules", { key: "Smartphones" }], ["clé vide", { key: "" }], ["clé avec espace", { key: " a" }],
    ["version 0", { version: 0 }], ["version fractionnaire", { version: 1.5 }], ["devise", { currency: "EUR" as "XOF" }],
    ["base 0", { baseAmount: 0 }], ["base trop haute", { baseAmount: 10_000_001 }], ["grille 0", { gridAmount: 0 }], ["grille négative", { gridAmount: -100 }],
    ["min 0", { minAmount: 0 }], ["max < min", { maxAmount: 400 }], ["min hors grille", { minAmount: 550 }], ["max hors grille", { maxAmount: 50_050 }],
    ["pas de concurrence négatif", { competitionStepMilli: -1 }], ["pas de concurrence > 1000", { competitionStepMilli: 1001 }],
    ["plafond de concurrence < 1000", { competitionMaxMilli: 999 }], ["plafond de concurrence > 5000", { competitionMaxMilli: 5001 }],
    ["pas de demande > 1000", { demandStepMilli: 1001 }], ["plafond de demande < 1000", { demandMaxMilli: 999 }], ["plafond de demande > 5000", { demandMaxMilli: 5001 }],
    ["rareté < 1000", { scarcityMaxMilli: 999 }], ["rareté > 5000", { scarcityMaxMilli: 5001 }],
    ["durée 24h < 1000", { duration24hMilli: 999 }], ["durée 7d > 20000", { duration7dMilli: 20_001 }],
    ["durées décroissantes (24h > 3d)", { duration24hMilli: 3000, duration3dMilli: 2500 }], ["durées décroissantes (3d > 7d)", { duration3dMilli: 6000 }],
    ["validité 59 s", { quoteValiditySeconds: 59 }], ["validité 3601 s", { quoteValiditySeconds: 3601 }],
    ["NaN", { baseAmount: Number.NaN }], ["chaîne", { baseAmount: "500" as unknown as number }],
  ];
  for (const [label, extra] of bad) {
    assert.throws(() => validatePricingSettings(settings(extra)), RangeError, label);
    assert.throws(() => price({ s: 1, d: 1, used: 0, total: 3, settings: settings(extra) }), RangeError, `computeBoostPrice : ${label}`);
  }
  assert.throws(() => validatePricingSettings(null as unknown as BoostPricingSettings), RangeError);
  // Bornes acceptées.
  for (const extra of [
    { baseAmount: 1 }, { baseAmount: 10_000_000 }, { competitionStepMilli: 0 }, { competitionStepMilli: 1000 }, { competitionMaxMilli: 1000 }, { competitionMaxMilli: 5000 },
    { scarcityMaxMilli: 1000 }, { scarcityMaxMilli: 5000 }, { duration24hMilli: 1000, duration3dMilli: 1000, duration7dMilli: 1000 }, { duration7dMilli: 20_000 },
    { quoteValiditySeconds: 60 }, { quoteValiditySeconds: 3600 }, { minAmount: 500, maxAmount: 500 }, { gridAmount: 1, minAmount: 1, maxAmount: 1 },
  ] as Array<Partial<BoostPricingSettings>>) validatePricingSettings(settings(extra));
});

test("entrées invalides : RangeError (S négatif, D = 0, used ≥ total, total = 0, durée inconnue, non-entiers)", () => {
  const rejects = (override: Partial<Parameters<typeof computeBoostPrice>[0]>, label: string) =>
    assert.throws(() => computeBoostPrice({ competingSellers: 1, compatibleBuyers: 1, slotsUsed: 0, slotsTotal: 3, durationCode: "24h", settings: DEFAULTS, ...override }), RangeError, label);
  rejects({ competingSellers: -1 }, "S négatif");
  rejects({ competingSellers: 1.5 }, "S fractionnaire");
  rejects({ compatibleBuyers: 0 }, "D = 0 : pas de cotation sans acheteur");
  rejects({ slotsUsed: 3 }, "used = total : aucune place, pas de prix infini");
  rejects({ slotsUsed: 4 }, "used > total");
  rejects({ slotsUsed: -1 }, "used négatif");
  rejects({ slotsTotal: 0, slotsUsed: 0 }, "total = 0");
  rejects({ durationCode: "30d" as BoostDurationCode }, "durée inconnue");
  rejects({ competingSellers: Number.NaN }, "NaN");
  assert.throws(() => computeDemandFactor(0, DEFAULTS), RangeError);
  assert.throws(() => computeScarcityFactor(1, 1, DEFAULTS), RangeError);
});
