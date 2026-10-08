import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { allocateMission, type AllocationCandidate, type AllocationInput, type AllocationResult } from "../../lib/server/missions/allocation";
import { MISSION_SELLERS_MAX, SHORTFALL_REASONS } from "../../lib/missions-rules";

/**
 * Répartition d'une mission d'achat en volume (lot MV1) : exemples écrits à la main, puis ESSAIS DE PROPRIÉTÉS sur des milliers de jeux aléatoires (générateur à graine fixe : un
 * échec se rejoue à l'identique). Les contraintes ne sont JAMAIS violées, aucune quantité n'est prise au-delà du stock, au plus 10 vendeurs. L'heuristique gloutonne n'est PAS
 * optimale (documentée dans allocation.ts) : un essai le montre par un contre-exemple, un autre prouve sa maximalité.
 */

const candidate = (offerId: string, overrides: Partial<AllocationCandidate> = {}): AllocationCandidate => ({
  offerId,
  sellerKey: `seller-${offerId}`,
  relevance: 80,
  unitPrice: 100_000,
  stock: 1,
  ...overrides,
});

const base = (overrides: Partial<AllocationInput> = {}): AllocationInput => ({ quantity: 5, unitBudget: 150_000, totalBudget: 1_000_000, candidates: [], ...overrides });

describe("exemples", () => {
  test("remplit dans l'ordre : pertinence décroissante, puis prix croissant, puis identifiant", () => {
    const result = allocateMission(
      base({
        quantity: 4,
        candidates: [
          candidate("c", { relevance: 70, unitPrice: 90_000, stock: 5 }),
          candidate("b", { relevance: 80, unitPrice: 120_000, stock: 1 }),
          candidate("a", { relevance: 80, unitPrice: 110_000, stock: 1 }),
          candidate("d", { relevance: 80, unitPrice: 110_000, stock: 1 }),
        ],
      }),
    );
    assert.deepEqual(result.lines.map((line) => [line.offerId, line.quantity]), [["a", 1], ["d", 1], ["b", 1], ["c", 1]]);
    assert.equal(result.coveredQuantity, 4);
    assert.equal(result.coverage, 1);
    assert.deepEqual(result.reasons, []);
    assert.equal(result.budgetUsed, 110_000 + 110_000 + 120_000 + 90_000);
    assert.equal(result.budgetRemaining, 1_000_000 - result.budgetUsed);
  });

  test("une annonce sans quantité compte pour 1 ; une quantité annoncée plafonne la ligne", () => {
    const result = allocateMission(base({ quantity: 10, candidates: [candidate("a", { stock: null }), candidate("b", { stock: 3, unitPrice: 100_001 })] }));
    assert.deepEqual(result.lines.map((line) => [line.offerId, line.quantity, line.stock]), [["a", 1, 1], ["b", 3, 3]]);
    assert.equal(result.coveredQuantity, 4);
    assert.deepEqual(result.reasons, ["not_enough_offers"]);
  });

  test("budget par unité : une annonce plus chère est écartée et la raison est dite", () => {
    const result = allocateMission(base({ quantity: 2, unitBudget: 100_000, candidates: [candidate("a", { unitPrice: 100_000 }), candidate("b", { unitPrice: 100_001 })] }));
    assert.deepEqual(result.lines.map((line) => line.offerId), ["a"]);
    assert.equal(result.ignored.overUnitBudget, 1);
    assert.deepEqual(result.reasons, ["not_enough_offers", "unit_budget_too_low"]);
  });

  test("budget total : la dernière ligne est réduite à ce que le budget permet, puis la raison est dite", () => {
    const result = allocateMission(base({ quantity: 10, totalBudget: 350_000, candidates: [candidate("a", { stock: 10, unitPrice: 100_000 })] }));
    assert.deepEqual(result.lines.map((line) => [line.quantity, line.subtotal]), [[3, 300_000]]);
    assert.equal(result.budgetUsed, 300_000);
    assert.equal(result.budgetRemaining, 50_000);
    assert.deepEqual(result.reasons, ["total_budget_too_low"]);
  });

  test("au plus 10 vendeurs : le onzième n'est pas admis, plusieurs annonces du même vendeur comptent pour un", () => {
    const candidates = Array.from({ length: 12 }, (_, index) => candidate(`o${String(index).padStart(2, "0")}`, { relevance: 100 - index }));
    const result = allocateMission(base({ quantity: 12, totalBudget: 5_000_000, candidates }));
    assert.equal(result.sellerCount, MISSION_SELLERS_MAX);
    assert.equal(result.lines.length, 10);
    assert.deepEqual(result.reasons, ["seller_limit"]);
    const sameSeller = allocateMission(base({ quantity: 6, candidates: Array.from({ length: 6 }, (_, index) => candidate(`s${index}`, { sellerKey: "one", relevance: 90 - index })) }));
    assert.equal(sameSeller.sellerCount, 1);
    assert.equal(sameSeller.coveredQuantity, 6);
    assert.deepEqual(sameSeller.lines.map((line) => line.sellerIndex), [1, 1, 1, 1, 1, 1]);
  });

  test("aucune annonce : couverture nulle et « pas assez d'annonces »", () => {
    const result = allocateMission(base());
    assert.deepEqual([result.lines.length, result.coveredQuantity, result.coverage, result.budgetUsed], [0, 0, 0, 0]);
    assert.deepEqual(result.reasons, ["not_enough_offers"]);
  });

  test("prix absent ou illisible, quantité illisible : annonce écartée ; une même annonce donnée deux fois n'est prise qu'une fois", () => {
    const result = allocateMission(
      base({
        quantity: 3,
        candidates: [
          candidate("a", { unitPrice: null }),
          candidate("b", { unitPrice: 0 }),
          candidate("c", { unitPrice: 1.5 }),
          candidate("d", { stock: 0 }),
          candidate("e", { stock: 2 }),
          candidate("e", { stock: 2 }),
        ],
      }),
    );
    assert.deepEqual(result.ignored, { noPrice: 3, overUnitBudget: 0, invalid: 1 });
    assert.deepEqual(result.lines.map((line) => [line.offerId, line.quantity]), [["e", 2]]);
  });

  test("entrées invalides : quantité ou budgets non entiers refusés", () => {
    assert.throws(() => allocateMission(base({ quantity: 0 })), RangeError);
    assert.throws(() => allocateMission(base({ quantity: 1.5 })), RangeError);
    assert.throws(() => allocateMission(base({ unitBudget: -1 })), RangeError);
    assert.throws(() => allocateMission(base({ totalBudget: Number.NaN })), RangeError);
  });

  test("HEURISTIQUE, pas un optimum : une annonce pertinente mais chère passe avant une moins pertinente et bien moins chère (le même budget couvrirait plus)", () => {
    const input = base({
      quantity: 10,
      totalBudget: 1_000_000,
      candidates: [candidate("cher", { relevance: 95, unitPrice: 150_000, stock: 5 }), candidate("pas-cher", { relevance: 60, unitPrice: 50_000, stock: 10 })],
    });
    const greedy = allocateMission(input);
    // Glouton : 5 × 150 000 = 750 000, puis 5 × 50 000 = 250 000 (total 1 000 000) : couvre 10 ; avec un budget plus serré, la pertinence d'abord coûte de la couverture.
    assert.equal(greedy.coveredQuantity, 10);
    const tight = allocateMission({ ...input, totalBudget: 800_000 });
    assert.equal(tight.coveredQuantity, 5 + Math.floor(50_000 / 50_000), "5 chères (750 000) puis 1 pas chère ; l'optimum en couvrirait 10 en prenant les pas chères d'abord (500 000)");
    assert.ok(tight.coveredQuantity < 10);
  });
});

// ───────────── propriétés ─────────────

/** Générateur déterministe (mulberry32). */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

interface Case {
  input: AllocationInput;
  seed: number;
}

function randomCase(seed: number): Case {
  const next = random(seed);
  const int = (min: number, max: number): number => min + Math.floor(next() * (max - min + 1));
  // Régime « large » (un quart des jeux) : beaucoup de petits vendeurs, de quoi dépasser 10 vendeurs ; sinon un marché quelconque.
  const wide = next() < 0.25;
  const sellers = wide ? int(11, 20) : int(1, 16);
  const candidates: AllocationCandidate[] = Array.from({ length: wide ? int(12, 40) : int(0, 40) }, (_, index) => ({
    offerId: `offer-${String(index).padStart(3, "0")}`,
    sellerKey: `seller-${int(1, sellers)}`,
    relevance: int(0, 100) + (next() < 0.2 ? 0.5 : 0),
    unitPrice: next() < 0.08 ? null : next() < 0.05 ? 0 : int(1, 400) * 1_000,
    stock: next() < 0.2 ? null : next() < 0.04 ? 0 : wide ? int(1, 3) : int(1, 12),
  }));
  const unitBudget = wide ? 400_000 : int(0, 300) * 1_000;
  const quantity = wide ? int(15, 60) : int(1, 120);
  // Trois régimes de budget total : serré (souvent insuffisant), moyen, généreux (seuls le stock et la limite de vendeurs limitent).
  const regime = next();
  const totalBudget = wide || regime >= 0.65 ? 1_000_000_000 : regime < 0.15 ? int(0, 300_000) : int(0, 20_000) * 1_000;
  return { seed, input: { quantity, unitBudget, totalBudget, candidates } };
}

function checkInvariants(input: AllocationInput, result: AllocationResult, label: string): void {
  const stockOf = new Map<string, number>();
  const priceOf = new Map<string, number>();
  // Les données de chaque annonce (la meilleure version si elle est donnée plusieurs fois : celle que l'algorithme a pu retenir).
  for (const entry of input.candidates) {
    if (entry.unitPrice === null || !Number.isSafeInteger(entry.unitPrice) || entry.unitPrice < 1) continue;
    const stock = entry.stock === null ? 1 : entry.stock;
    if (!Number.isSafeInteger(stock) || stock < 1) continue;
    stockOf.set(entry.offerId, Math.max(stockOf.get(entry.offerId) ?? 0, stock));
    priceOf.set(entry.offerId, entry.unitPrice);
  }
  const seenOffers = new Set<string>();
  const sellers = new Set<string>();
  let covered = 0;
  let used = 0;
  for (const line of result.lines) {
    assert.ok(!seenOffers.has(line.offerId), `${label} : annonce ${line.offerId} prise deux fois`);
    seenOffers.add(line.offerId);
    sellers.add(line.sellerKey);
    assert.ok(Number.isSafeInteger(line.quantity) && line.quantity >= 1, `${label} : quantité entière ≥ 1`);
    assert.ok(line.unitPrice <= input.unitBudget, `${label} : prix unitaire ${line.unitPrice} > budget par unité ${input.unitBudget}`);
    assert.ok(line.quantity <= (stockOf.get(line.offerId) ?? 0), `${label} : quantité ${line.quantity} au-delà du stock de ${line.offerId}`);
    assert.ok(line.quantity <= line.stock, `${label} : quantité au-delà du stock annoncé de la ligne`);
    assert.equal(line.subtotal, line.quantity * line.unitPrice, `${label} : sous-total`);
    covered += line.quantity;
    used += line.subtotal;
  }
  assert.ok(sellers.size <= MISSION_SELLERS_MAX, `${label} : ${sellers.size} vendeurs`);
  assert.equal(result.sellerCount, sellers.size, `${label} : nombre de vendeurs annoncé`);
  assert.ok(used <= input.totalBudget, `${label} : budget total dépassé (${used} > ${input.totalBudget})`);
  assert.equal(result.budgetUsed, used, `${label} : budget utilisé`);
  assert.equal(result.budgetRemaining, input.totalBudget - used, `${label} : budget restant`);
  assert.equal(result.coveredQuantity, covered, `${label} : quantité couverte`);
  assert.ok(covered <= input.quantity, `${label} : couverture au-delà de la quantité voulue`);
  assert.ok(result.coverage >= 0 && result.coverage <= 1, `${label} : couverture dans [0, 1]`);
  assert.equal(result.requestedQuantity, input.quantity);
  assert.deepEqual([...new Set(result.lines.map((line) => line.sellerIndex))].sort((a, b) => a - b), [...Array(sellers.size)].map((_, index) => index + 1), `${label} : rangs de vendeurs 1..n`);
  if (covered < input.quantity) assert.ok(result.reasons.length >= 1, `${label} : une quantité non couverte a toujours une raison`);
  else assert.deepEqual(result.reasons, [], `${label} : couverte, aucune raison`);
  for (const reason of result.reasons) assert.ok((SHORTFALL_REASONS as readonly string[]).includes(reason), `${label} : raison connue`);
  // MAXIMALITÉ : si la quantité n'est pas couverte, aucune annonce ne pouvait fournir une unité de plus (stock, budget total ou limite de vendeurs).
  if (covered < input.quantity) {
    const taken = new Map(result.lines.map((line) => [line.offerId, line.quantity]));
    const remainingBudget = input.totalBudget - used;
    for (const [offerId, stock] of stockOf) {
      const price = priceOf.get(offerId) as number;
      if (price > input.unitBudget) continue;
      const took = taken.get(offerId) ?? 0;
      if (took >= stock) continue;
      const blockedByBudget = remainingBudget < price;
      const owner = input.candidates.find((entry) => entry.offerId === offerId)?.sellerKey as string;
      const blockedBySellers = !taken.has(offerId) && !sellers.has(owner) && sellers.size >= MISSION_SELLERS_MAX;
      assert.ok(blockedByBudget || blockedBySellers, `${label} : ${offerId} aurait pu fournir une unité de plus`);
    }
  }
}

describe("propriétés (jeux aléatoires, graine fixe)", () => {
  test("3000 jeux : budget par unité, budget total, stock, 10 vendeurs, sous-totaux, rangs, raisons et maximalité ne sont jamais violés", () => {
    let withLines = 0;
    let capped = 0;
    for (let seed = 1; seed <= 3000; seed += 1) {
      const { input } = randomCase(seed);
      const result = allocateMission(input);
      checkInvariants(input, result, `graine ${seed}`);
      if (result.lines.length > 0) withLines += 1;
      if (result.sellerCount === MISSION_SELLERS_MAX) capped += 1;
    }
    assert.ok(withLines > 1500, `jeux avec au moins une ligne : ${withLines}`);
    assert.ok(capped > 50, `jeux qui atteignent 10 vendeurs : ${capped}`);
  });

  test("le résultat ne dépend pas de l'ordre d'arrivée des annonces", () => {
    for (let seed = 5001; seed <= 5400; seed += 1) {
      const { input } = randomCase(seed);
      const shuffled = [...input.candidates];
      const next = random(seed + 77);
      for (let index = shuffled.length - 1; index > 0; index -= 1) {
        const other = Math.floor(next() * (index + 1));
        [shuffled[index], shuffled[other]] = [shuffled[other], shuffled[index]];
      }
      const keep = (result: AllocationResult) => result.lines.map((line) => [line.offerId, line.quantity, line.unitPrice]);
      assert.deepEqual(keep(allocateMission({ ...input, candidates: shuffled })), keep(allocateMission(input)), `graine ${seed}`);
    }
  });

  test("CONSÉQUENCE DE L'HEURISTIQUE : un budget total plus grand peut couvrir MOINS (la pertinence d'abord vide le budget sur l'annonce la plus pertinente)", () => {
    const candidates = [candidate("pertinente", { relevance: 90, unitPrice: 60_000, stock: 10 }), candidate("economique", { relevance: 50, unitPrice: 10_000, stock: 10 })];
    const small = allocateMission(base({ quantity: 10, totalBudget: 100_000, candidates }));
    const larger = allocateMission(base({ quantity: 10, totalBudget: 120_000, candidates }));
    assert.equal(small.coveredQuantity, 1 + 4);
    assert.equal(larger.coveredQuantity, 2);
    assert.ok(larger.coveredQuantity < small.coveredQuantity, "documenté : la couverture n'est pas monotone en budget");
  });

  test("les contraintes tiennent aussi aux bornes : budget nul, budget par unité nul, quantité 1, stock géant, prix 1", () => {
    const edge = (overrides: Partial<AllocationInput>) => {
      const input = base({ candidates: [candidate("a", { unitPrice: 1, stock: 10_000 }), candidate("b", { unitPrice: 2, stock: null })], ...overrides });
      const result = allocateMission(input);
      checkInvariants(input, result, JSON.stringify(overrides));
      return result;
    };
    assert.equal(edge({ totalBudget: 0 }).coveredQuantity, 0);
    assert.equal(edge({ unitBudget: 0 }).coveredQuantity, 0);
    assert.equal(edge({ quantity: 1 }).coveredQuantity, 1);
    assert.equal(edge({ quantity: 10_000, totalBudget: 10_000 }).coveredQuantity, 10_000);
    assert.equal(edge({ quantity: 10_000, totalBudget: 9_999 }).coveredQuantity, 9_999);
  });
});
