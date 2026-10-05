import assert from "node:assert/strict";
import test from "node:test";
import {
  accountAgeBandOf, computeAvailabilityIndicator, computeConfidenceIndicator, computePriceIndicator, computeRelevance,
  type MarketReference, type RelevanceInput,
} from "../../lib/server/matching/indicators";
import { RELEVANCE_CONFIG } from "../../lib/server/matching/relevance-config";

const NOW = new Date("2026-10-05T12:00:00.000Z");
const HOUR = 3_600_000;
const DAY = 86_400_000;
const ago = (ms: number) => new Date(NOW.getTime() - ms);

// ═════════════ Configuration ═════════════

test("configuration : figée en profondeur, poids de somme 1, valeurs imposées", () => {
  const walk = (value: unknown, path: string) => {
    if (value === null || typeof value !== "object") return;
    assert.ok(Object.isFrozen(value), `${path} n'est pas figé`);
    for (const [key, nested] of Object.entries(value)) walk(nested, `${path}.${key}`);
  };
  walk(RELEVANCE_CONFIG, "RELEVANCE_CONFIG");
  const { weights } = RELEVANCE_CONFIG;
  assert.ok(Math.abs(weights.compatibility + weights.availability + weights.price + weights.confidence - 1) < 1e-12);
  assert.deepEqual({ ...weights }, { compatibility: 0.55, availability: 0.2, price: 0.15, confidence: 0.1 });
  assert.equal(RELEVANCE_CONFIG.price.minSampleSize, 5);
  assert.equal(RELEVANCE_CONFIG.relevance.window, 200);
  assert.throws(() => { (RELEVANCE_CONFIG as unknown as { weights: { price: number } }).weights.price = 1; }, TypeError);
});

// ═════════════ Disponibilité ═════════════

const availability = (overrides: Partial<Parameters<typeof computeAvailabilityIndicator>[0]> = {}) => computeAvailabilityIndicator({
  status: "available", confirmedAt: null, quantity: null, requestedQuantity: null, now: NOW, ...overrides,
});

test("disponibilité : seuils de confirmation (72 h et 14 jours), à la borne exacte et juste à côté", () => {
  const cases: Array<[string, number | null, string, number, number | null]> = [
    ["confirmée à l'instant", 0, "confirmed_recent", 100, 0],
    ["72 h pile", 72 * HOUR, "confirmed_recent", 100, 72],
    ["72 h + 1 ms", 72 * HOUR + 1, "confirmed", 70, 72],
    ["14 jours pile", 14 * DAY, "confirmed", 70, 336],
    ["14 jours + 1 ms", 14 * DAY + 1, "unconfirmed", 40, 336],
    ["jamais confirmée", null, "unconfirmed", 40, null],
    ["confirmée il y a 100 jours", 100 * DAY, "unconfirmed", 40, 2400],
  ];
  for (const [label, ageMs, level, score, hours] of cases) {
    const result = availability({ confirmedAt: ageMs === null ? null : ago(ageMs) });
    assert.deepEqual({ level: result.level, score: result.score, hours: result.confirmedAgeHours }, { level, score, hours }, label);
    assert.deepEqual(result.factors, []);
  }
  assert.equal(availability({ confirmedAt: ago(72 * HOUR - 1) }).level, "confirmed_recent");
  assert.equal(availability({ confirmedAt: ago(14 * DAY - 1) }).level, "confirmed");
});

test("disponibilité : reserved, statut inconnu, unavailable défensif, confirmation future", () => {
  assert.deepEqual(availability({ status: "reserved", confirmedAt: ago(HOUR) }), { level: "reserved", score: 20, confirmedAgeHours: 1, factors: [] });
  assert.deepEqual(availability({ status: null }), { level: "unknown", score: null, confirmedAgeHours: null, factors: [] });
  assert.equal(availability({ status: "unavailable" }).score, 0);
  const future = availability({ confirmedAt: new Date(NOW.getTime() + HOUR) });
  assert.deepEqual({ level: future.level, hours: future.confirmedAgeHours }, { level: "confirmed_recent", hours: 0 });
});

test("disponibilité : quantité insuffisante plafonne à 30, jamais ne relève, ne s'applique que si les deux sont connues", () => {
  const recent = ago(HOUR);
  const capped = availability({ confirmedAt: recent, quantity: 2, requestedQuantity: 3 });
  assert.deepEqual({ score: capped.score, level: capped.level, factors: capped.factors }, { score: 30, level: "confirmed_recent", factors: ["insufficient_quantity"] });
  assert.equal(availability({ confirmedAt: recent, quantity: 3, requestedQuantity: 3 }).score, 100, "égale : suffisante");
  assert.equal(availability({ confirmedAt: recent, quantity: 5, requestedQuantity: 3 }).score, 100);
  assert.equal(availability({ confirmedAt: recent, quantity: null, requestedQuantity: 3 }).score, 100, "quantité de l'offre inconnue");
  assert.equal(availability({ confirmedAt: recent, quantity: 1, requestedQuantity: null }).score, 100, "quantité demandée inconnue");
  assert.equal(availability({ status: "reserved", quantity: 1, requestedQuantity: 9 }).score, 20, "le plafond ne relève pas un score plus bas");
  const unknown = availability({ status: null, quantity: 1, requestedQuantity: 9 });
  assert.deepEqual({ score: unknown.score, factors: unknown.factors }, { score: null, factors: ["insufficient_quantity"] });
  assert.equal(availability({ confirmedAt: ago(10 * DAY), quantity: 1, requestedQuantity: 2 }).score, 30, "70 → 30");
  assert.equal(availability({ quantity: 1, requestedQuantity: 2 }).score, 30, "40 → 30");
});

// ═════════════ Prix ═════════════

const market = (overrides: Partial<MarketReference> = {}): MarketReference => ({ sampleSize: 5, p25: 100, median: 150, p75: 200, ...overrides });

test("prix : positions aux bornes — strictement sous p25 = below ; p25 ≤ prix ≤ p75 = in ; au-dessus de p75 = above", () => {
  const at = (price: number) => computePriceIndicator({ price, market: market() });
  assert.deepEqual([at(99)].map((r) => [r.position, r.score]), [["below_market", 100]]);
  assert.deepEqual([at(100), at(101), at(200)].map((r) => [r.position, r.score]), [["in_market", 60], ["in_market", 60], ["in_market", 60]], "p25 inclus dans le marché, p75 inclus");
  assert.deepEqual([at(201)].map((r) => [r.position, r.score]), [["above_market", 20]]);
});

test("prix : marché dégénéré (p25 = médiane = p75) — le prix égal est dans le marché", () => {
  const flat = market({ p25: 100_000, median: 100_000, p75: 100_000 });
  const result = computePriceIndicator({ price: 100_000, market: flat });
  assert.deepEqual({ position: result.position, score: result.score, delta: result.deltaPercent, factors: result.factors }, { position: "in_market", score: 60, delta: 0, factors: [] });
  assert.equal(computePriceIndicator({ price: 99_999, market: flat }).position, "below_market");
  assert.equal(computePriceIndicator({ price: 100_001, market: flat }).position, "above_market");
});

test("prix : données insuffisantes — price_missing (le vendeur n'a pas donné de prix) ou insufficient_market", () => {
  const compute = (input: Parameters<typeof computePriceIndicator>[0]) => computePriceIndicator(input);
  assert.deepEqual(compute({ price: 100, market: market({ sampleSize: 4 }) }), { position: "insufficient_data", score: null, deltaPercent: null, sampleSize: 4, factors: ["insufficient_market"] });
  const five = compute({ price: 100, market: market({ sampleSize: 5 }) });
  assert.deepEqual({ position: five.position, factors: five.factors }, { position: "in_market", factors: [] }, "5 suffit (100 = p25 : dans le marché)");
  assert.deepEqual(compute({ price: null, market: market() }), { position: "insufficient_data", score: null, deltaPercent: null, sampleSize: 5, factors: ["price_missing"] });
  assert.deepEqual(compute({ price: null, market: null }), { position: "insufficient_data", score: null, deltaPercent: null, sampleSize: 0, factors: ["price_missing"] }, "prix absent prioritaire sur le marché");
  assert.deepEqual(compute({ price: 100, market: null }), { position: "insufficient_data", score: null, deltaPercent: null, sampleSize: 0, factors: ["insufficient_market"] });
  assert.deepEqual(compute({ price: 100, market: market({ median: 0, p25: 0, p75: 0 }) }).factors, ["insufficient_market"]);
  assert.deepEqual(compute({ price: 100, market: market({ median: null }) }).factors, ["insufficient_market"]);
});

test("prix : deltaPercent = arrondi entier de (prix − médiane) / médiane × 100", () => {
  const delta = (price: number, median: number) => computePriceIndicator({ price, market: { sampleSize: 9, p25: 0, median, p75: 1e12 } }).deltaPercent;
  assert.equal(delta(150, 150), 0);
  assert.equal(delta(125, 100), 25);
  assert.equal(delta(87, 100), -13);
  assert.equal(delta(1, 3), -67);
  assert.equal(delta(4, 3), 33);
  assert.equal(delta(300, 100), 200);
});

// ═════════════ Confiance ═════════════

const FULL_OFFER_FIELDS = { category: "phones", brand: "Apple", model: "iPhone 13", condition: "good", price: 250_000, location: "Cocody" };
const FULL_DEMAND_FIELDS = { category: "phones", brand: "Apple", model: "iPhone 13", condition: "good", location: "Cocody" };
const confidence = (overrides: Partial<Parameters<typeof computeConfidenceIndicator>[0]> = {}) => computeConfidenceIndicator({
  kind: "offer", phoneVerified: false, accountCreatedAt: ago(DAY), fields: {}, availabilityEverConfirmed: false, now: NOW, ...overrides,
});

test("confiance : ancienneté exposée par tranche, aux bornes exactes (7 j et 30 j)", () => {
  assert.equal(accountAgeBandOf(ago(7 * DAY - 1), NOW), "lt_7d");
  assert.equal(accountAgeBandOf(ago(7 * DAY), NOW), "7d_30d");
  assert.equal(accountAgeBandOf(ago(30 * DAY - 1), NOW), "7d_30d");
  assert.equal(accountAgeBandOf(ago(30 * DAY), NOW), "gte_30d");
  assert.equal(accountAgeBandOf(ago(0), NOW), "lt_7d");
  const bands: Array<[number, string, number]> = [[7 * DAY - 1, "lt_7d", 0], [7 * DAY, "7d_30d", 10], [30 * DAY - 1, "7d_30d", 10], [30 * DAY, "gte_30d", 20]];
  for (const [ageMs, band, points] of bands) {
    const result = confidence({ accountCreatedAt: ago(ageMs) });
    assert.equal(result.accountAgeBand, band);
    assert.equal(result.score, points, `points d'ancienneté (${band})`);
    assert.ok(result.factors.includes(`account_age_${band}`));
  }
});

test("confiance (offre) : téléphone 40, ancienneté 20/10, complétude 30 au prorata, confirmation 10 ; niveaux 70 et 40", () => {
  assert.equal(confidence({ phoneVerified: true }).score, 40);
  assert.equal(confidence({ fields: FULL_OFFER_FIELDS }).score, 30);
  assert.equal(confidence({ fields: { category: "phones", brand: "Apple", model: "x" } }).score, 15, "3 champs sur 6");
  assert.equal(confidence({ availabilityEverConfirmed: true }).score, 10);
  const max = confidence({ phoneVerified: true, accountCreatedAt: ago(40 * DAY), fields: FULL_OFFER_FIELDS, availabilityEverConfirmed: true });
  assert.deepEqual({ score: max.score, level: max.level }, { score: 100, level: "high" });
  assert.deepEqual(max.factors, ["phone_verified", "account_age_gte_30d", "structured_fields_complete", "availability_confirmed"]);

  // Niveaux : 70 (high, borne exacte) / 65 (medium) ; 40 (medium, borne exacte) / 35 (low).
  const exact70 = confidence({ phoneVerified: true, accountCreatedAt: ago(40 * DAY), availabilityEverConfirmed: true });
  assert.deepEqual({ score: exact70.score, level: exact70.level }, { score: 70, level: "high" });
  const score65 = confidence({ phoneVerified: true, accountCreatedAt: ago(40 * DAY), fields: { category: "phones" } });
  assert.deepEqual({ score: score65.score, level: score65.level }, { score: 65, level: "medium" });
  const exact40 = confidence({ phoneVerified: true });
  assert.deepEqual({ score: exact40.score, level: exact40.level }, { score: 40, level: "medium" });
  const score35 = confidence({ accountCreatedAt: ago(40 * DAY), fields: { category: "phones", brand: "Apple", model: "x" } });
  assert.deepEqual({ score: score35.score, level: score35.level }, { score: 35, level: "low" });
  assert.deepEqual(confidence().factors, ["phone_not_verified", "account_age_lt_7d", "structured_fields_none"]);
});

test("confiance : champs vides ou blancs non comptés ; seuls les champs applicables au type comptent", () => {
  const blank = confidence({ fields: { category: "  ", brand: "", model: null, condition: undefined, price: null, location: "Cocody" } });
  assert.equal(blank.score, 5, "1 champ sur 6");
  assert.ok(blank.factors.includes("structured_fields_partial"));
  // `price` n'est pas un champ de demande : ignoré pour une demande.
  const demand = confidence({ kind: "demand", fields: { ...FULL_DEMAND_FIELDS, price: null } });
  assert.ok(demand.factors.includes("structured_fields_complete"));
});

test("confiance (demande) : le facteur « disponibilité confirmée » ne s'applique pas, total renormalisé sur 90", () => {
  const maxDemand = confidence({ kind: "demand", phoneVerified: true, accountCreatedAt: ago(40 * DAY), fields: FULL_DEMAND_FIELDS });
  assert.deepEqual({ score: maxDemand.score, level: maxDemand.level }, { score: 100, level: "high" });
  const ignored = confidence({ kind: "demand", phoneVerified: true, accountCreatedAt: ago(40 * DAY), fields: FULL_DEMAND_FIELDS, availabilityEverConfirmed: true });
  assert.deepEqual(ignored, maxDemand, "availabilityEverConfirmed est ignoré pour une demande");
  assert.ok(!maxDemand.factors.includes("availability_confirmed"));
  assert.equal(confidence({ kind: "demand", phoneVerified: true }).score, 44.44, "40 / 90");
  assert.equal(confidence({ kind: "demand", fields: FULL_DEMAND_FIELDS }).score, 33.33, "30 / 90");
});

// ═════════════ Pertinence ═════════════

const relevance = (overrides: Partial<RelevanceInput> = {}) => computeRelevance({
  confirmed: true, sense: "demand_source", compatibility: 80, availability: 100, price: 60, confidence: 50, ...overrides,
});

test("pertinence : poids 0.55 / 0.20 / 0.15 / 0.10, arrondi à 2 décimales", () => {
  assert.equal(relevance(), 78); // 44 + 20 + 9 + 5
  assert.equal(relevance({ compatibility: 100, availability: 100, price: 100, confidence: 100 }), 100);
  assert.equal(relevance({ compatibility: 0, availability: 0, price: 0, confidence: 0 }), 0);
  assert.equal(relevance({ compatibility: 60, availability: 40, price: 20, confidence: 30 }), 47, "33 + 8 + 3 + 3");
});

test("pertinence : une valeur INCONNUE est remplacée par sa valeur de substitution, jamais retirée (aucune renormalisation)", () => {
  assert.equal(relevance({ price: null }), 76.5, "prix inconnu (marché insuffisant par défaut) → 50 : 44 + 20 + 7,5 + 5");
  assert.equal(relevance({ price: null, priceFactor: "insufficient_market" }), 76.5);
  assert.equal(relevance({ price: null, priceFactor: "price_missing" }), 72, "prix absent → 20 : 44 + 20 + 3 + 5");
  assert.equal(relevance({ availability: null }), 64, "disponibilité inconnue → 30 : 44 + 6 + 9 + 5");
  assert.equal(relevance({ compatibility: null }), 61.5, "compatibilité nulle → 50 : 27,5 + 20 + 9 + 5");
  assert.equal(relevance({ availability: null, price: null, priceFactor: "price_missing" }), 58, "44 + 6 + 3 + 5");
  assert.equal(relevance({ compatibility: null, availability: null, price: null, priceFactor: "price_missing" }), 41.5, "27,5 + 6 + 3 + 5");
  // Les poids ne sont pas renormalisés dans le sens demande : somme 1 → la pertinence reste dans l'échelle des composantes.
  assert.equal(relevance({ compatibility: 100, availability: null, price: 100, confidence: 100 }), 86, "55 + 6 + 15 + 10 : l'inconnu coûte 14 points (20 − 6) au lieu de les redistribuer");
});

test("pertinence : déclarer ne fait jamais perdre (grille exhaustive, sens demande)", () => {
  const values = [0, 20, 40, 60, 80, 100];
  const nullable = [null, ...values];
  const AVAILABLE = [40, 70, 100]; // available non confirmée, confirmée, récente
  const DECLARED_PRICE = [20, 60, 100]; // au-dessus, dans, sous le marché (marché suffisant)
  let checked = 0;
  for (const compatibility of nullable) for (const confidence of values) {
    for (const price of [...DECLARED_PRICE, null] as Array<number | null>) {
      const unknown = relevance({ compatibility, confidence, availability: null, price });
      for (const declared of AVAILABLE) {
        assert.ok(relevance({ compatibility, confidence, availability: declared, price })! >= unknown!, `disponibilité ${declared} ≥ inconnue (compat ${compatibility}, conf ${confidence}, prix ${price})`);
        checked++;
      }
      // « reserved » (20) reste STRICTEMENT sous l'inconnu : c'est un état réellement moins bon.
      assert.ok(relevance({ compatibility, confidence, availability: 20, price })! < unknown!, "reserved < inconnu");
      checked++;
    }
    for (const availability of [...AVAILABLE, 20, null] as Array<number | null>) {
      const missing = relevance({ compatibility, confidence, availability, price: null, priceFactor: "price_missing" });
      for (const declared of DECLARED_PRICE) {
        assert.ok(relevance({ compatibility, confidence, availability, price: declared })! >= missing!, `prix ${declared} ≥ prix absent (compat ${compatibility}, conf ${confidence}, dispo ${availability})`);
        checked++;
      }
      // Marché insuffisant (50, pas un choix du vendeur) est entre « au-dessus » (20) et « dans le marché » (60).
      const insufficient = relevance({ compatibility, confidence, availability, price: null, priceFactor: "insufficient_market" })!;
      assert.ok(insufficient >= missing! && insufficient <= relevance({ compatibility, confidence, availability, price: 60 })!, "absent ≤ marché insuffisant ≤ in_market");
      checked++;
    }
  }
  assert.ok(checked > 1_000);
});

test("pertinence : les valeurs de substitution viennent de la configuration et s'ordonnent comme documenté", () => {
  const { substitutes } = RELEVANCE_CONFIG.relevance;
  assert.deepEqual({ ...substitutes }, { availabilityUnknown: 30, priceMissing: 20, priceInsufficientMarket: 50, compatibilityNull: 50 });
  const scores = RELEVANCE_CONFIG.availability.scores;
  assert.ok(scores.reserved < substitutes.availabilityUnknown && substitutes.availabilityUnknown < scores.unconfirmed, "reserved 20 < inconnu 30 < unconfirmed 40");
  assert.ok(substitutes.priceMissing <= RELEVANCE_CONFIG.price.scores.aboveMarket, "prix absent : pas mieux qu'au-dessus du marché");
  assert.ok(substitutes.priceInsufficientMarket < RELEVANCE_CONFIG.price.scores.inMarket && substitutes.priceInsufficientMarket > substitutes.priceMissing);
  assert.deepEqual({ ...RELEVANCE_CONFIG.relevance.cursorAt }, { maxFutureSkewMs: 5_000, maxAgeMs: 3_600_000 });
});

test("pertinence : sens offre (vendeur) = compatibilité et confiance de l'acheteur seulement", () => {
  const base: Partial<RelevanceInput> = { sense: "offer_source" };
  assert.equal(relevance({ ...base }), 75.38, "(0.55 × 80 + 0.10 × 50) / 0.65");
  for (const [availability, price] of [[0, 0], [100, 100], [null, null], [20, 100]] as const) {
    assert.equal(relevance({ ...base, availability, price }), 75.38, "disponibilité et prix de l'offre source : sans effet");
  }
  assert.equal(relevance({ ...base, compatibility: null }), 50);
  assert.notEqual(relevance({ sense: "demand_source" }), relevance({ ...base }));
});

test("pertinence : monotone — améliorer une seule composante ne la fait jamais baisser", () => {
  const values = [0, 20, 40, 60, 80, 100];
  const keys = ["compatibility", "availability", "price", "confidence"] as const;
  let checked = 0;
  for (const sense of ["demand_source", "offer_source"] as const) {
    for (const a of values) for (const b of values) for (const c of values) for (const d of values) {
      const base = { compatibility: a, availability: b, price: c, confidence: d };
      const before = relevance({ sense, ...base })!;
      for (const key of keys) for (const better of values.filter((value) => value > base[key])) {
        const after = relevance({ sense, ...base, [key]: better })!;
        assert.ok(after >= before, `${sense} ${key} ${base[key]}→${better} : ${before} → ${after}`);
        checked++;
      }
    }
  }
  assert.ok(checked > 10_000);
});

test("pertinence : déterministe, entrée non modifiée", () => {
  const input: RelevanceInput = { confirmed: true, sense: "demand_source", compatibility: 71.3, availability: 70, price: 100, confidence: 62.5 };
  const snapshot = JSON.stringify(input);
  const first = computeRelevance(input);
  for (let i = 0; i < 50; i++) assert.equal(computeRelevance({ ...input }), first);
  assert.equal(JSON.stringify(input), snapshot);
  const a = computeAvailabilityIndicator({ status: "available", confirmedAt: ago(5 * HOUR), quantity: 1, requestedQuantity: 1, now: NOW });
  assert.deepEqual(computeAvailabilityIndicator({ status: "available", confirmedAt: ago(5 * HOUR), quantity: 1, requestedQuantity: 1, now: NOW }), a);
});

test("pertinence : aucune pertinence pour une ligne non confirmée, quel que soit le sens ou les indicateurs", () => {
  for (const sense of ["demand_source", "offer_source"] as const) {
    assert.equal(relevance({ sense, confirmed: false }), null);
    assert.equal(relevance({ sense, confirmed: false, compatibility: 100, availability: 100, price: 100, confidence: 100 }), null);
  }
});
