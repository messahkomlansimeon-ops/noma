import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import type { MatchIndicators, StoredMatch } from "../../lib/client/api";
import {
  COMPARE_COUNT,
  NOT_PROVIDED,
  comparePath,
  compareRows,
  parseCompareSelection,
  pickCompared,
  pruneSelection,
  toggleSelection,
} from "../../lib/client/compare-view";

const DEMAND = "11111111-1111-4111-8111-111111111111";
const A = "33333333-3333-4333-8333-333333333333";
const B = "44444444-4444-4444-8444-444444444444";
const C = "55555555-5555-4555-8555-555555555555";
const ROOT = join(import.meta.dirname, "..", "..");

const indicators = (priceDelta = 3): MatchIndicators => ({
  availability: { level: "confirmed_recent", score: 100, confirmedAgeHours: 5, factors: [] },
  price: { position: "in_market", score: 60, deltaPercent: priceDelta, sampleSize: 8, factors: [] },
  confidence: { level: "high", score: 91, accountAgeBand: "gte_30d", factors: ["phone_verified", "account_age_gte_30d"] },
});

function match(id: string, price: number | null, score: number | null, overrides: Partial<StoredMatch> = {}): StoredMatch {
  return {
    candidateId: id,
    candidate: {
      category: "Téléphones", brand: "Apple", model: "iPhone 12", variant: "128 Go", condition: "Occasion", quantity: null, unit: null, location: "Abidjan",
      deadlineAt: null, price: price === null ? null : { amount: price, currency: "XOF" }, budget: null, availabilityStatus: "available",
    },
    compatibilityStatus: "compatible", score, coverage: 1, evaluatedAt: "2031-01-01T10:00:00.000Z", indicators: indicators(), relevance: 80, sponsored: false, proBadge: false,
    ...overrides,
  };
}

describe("comparaison de deux offres d'un besoin", () => {
  test("adresse : exactement deux UUID distincts, jamais devinés ; le lien exige le besoin ET les deux offres", () => {
    assert.equal(COMPARE_COUNT, 2);
    assert.equal(comparePath(DEMAND, [A, B]), `/besoins/${DEMAND}/comparer?offres=${A},${B}`);
    for (const ids of [[A], [A, A], [A, B, C], [A, "pas-un-uuid"], []]) assert.equal(comparePath(DEMAND, ids), null, JSON.stringify(ids));
    assert.equal(comparePath("pas-un-uuid", [A, B]), null);
    assert.deepEqual(parseCompareSelection(`${A},${B}`), [A, B]);
    for (const raw of [null, "", A, `${A},${A}`, `${A},${B},${C}`, `${A},x`, `${A};${B}`, ` ${A},${B}`]) assert.equal(parseCompareSelection(raw), null, String(raw));
  });

  test("sélection : on coche et décoche ; une troisième offre est refusée sans rien changer ; la liste actualisée écarte les offres disparues", () => {
    assert.deepEqual(toggleSelection([], A), { selected: [A], refused: false });
    assert.deepEqual(toggleSelection([A], B), { selected: [A, B], refused: false });
    assert.deepEqual(toggleSelection([A, B], A), { selected: [B], refused: false });
    assert.deepEqual(toggleSelection([A, B], C), { selected: [A, B], refused: true });
    assert.deepEqual(pruneSelection([A, B], [{ candidateId: B }, { candidateId: C }]), [B]);
    assert.deepEqual(pruneSelection([], [{ candidateId: B }]), []);
  });

  test("lignes : le prix le plus bas et la meilleure compatibilité sont signalés ; égalité ou donnée absente : aucun « plus avantageux »", () => {
    const rows = compareRows(match(A, 150_000, 90), match(B, 120_000, 95));
    const byKey = Object.fromEntries(rows.map((row) => [row.key, row]));
    assert.deepEqual(rows.map((row) => row.key), ["price", "condition", "compatibility", "market", "availability", "confidence", "pro"]);
    assert.equal(byKey.price.better, "b");
    assert.match(byKey.price.a, /150/);
    assert.equal(byKey.compatibility.better, "b");
    const equal = compareRows(match(A, 100_000, 90), match(B, 100_000, 90));
    assert.equal(equal.find((row) => row.key === "price")?.better, null);
    assert.equal(equal.find((row) => row.key === "compatibility")?.better, null);
    const missing = compareRows(match(A, null, null), match(B, 100_000, 90));
    assert.equal(missing.find((row) => row.key === "price")?.better, null, "un prix absent ne désigne personne");
    assert.equal(missing.find((row) => row.key === "price")?.a, "Prix non renseigné");
    assert.equal(missing.find((row) => row.key === "compatibility")?.better, null);
  });

  test("lignes : aucun champ inventé (« Non renseigné »), « Vendeur Pro » oui/non, jamais d'identifiant, de numéro ni de nom du vendeur", () => {
    const bare = match(A, 100_000, 90, { candidate: { ...match(A, 1, 1).candidate, condition: null, location: null } });
    const row = compareRows(bare, match(B, 90_000, 80, { proBadge: true })).find((entry) => entry.key === "condition");
    assert.equal(row?.a, NOT_PROVIDED);
    const pro = compareRows(bare, match(B, 90_000, 80, { proBadge: true })).find((entry) => entry.key === "pro");
    assert.deepEqual([pro?.a, pro?.b], ["Non", "Oui"]);
    const text = JSON.stringify(compareRows(match(A, 1, 1), match(B, 2, 2)));
    assert.equal(text.includes(A) || text.includes(B), false, "les identifiants ne sont pas affichés");
    assert.equal(/\+225|\b07\d{8}\b/.test(text), false);
    assert.equal(/livraison|garantie/i.test(text), false, "livraison et garantie ne sont pas des champs d'une annonce : pas inventés");
  });

  test("retrouve les deux offres choisies parmi les correspondances du besoin ; si l'une manque, rien n'est deviné", () => {
    const items = [match(C, 1, 1), match(A, 1, 1), match(B, 1, 1)];
    const pair = pickCompared(items, [A, B]);
    assert.deepEqual(pair?.map((item) => item.candidateId), [A, B]);
    assert.equal(pickCompared(items, [A, "66666666-6666-4666-8666-666666666666"]), null);
    assert.equal(pickCompared([], [A, B]), null);
  });
});

describe("câblage : la comparaison n'existe que dans le contexte d'un besoin", () => {
  const read = (path: string): string => readFileSync(join(ROOT, path), "utf8");

  test("la page est sous /besoins/[id]/comparer, lit les correspondances du besoin (jamais une offre par son seul identifiant) ; les anciennes pages et la sélection du navigateur ont disparu", () => {
    const page = read("app/(buyer)/besoins/[id]/comparer/page.tsx");
    assert.match(page, /api\.demands\.storedMatches\(demandId/);
    assert.doesNotMatch(page, /api\.offers\.get|\/api\/offers\//);
    for (const gone of ["app/(buyer)/comparer/page.tsx", "app/(buyer)/offre/[id]/page.tsx", "app/(buyer)/offre/[id]/inviter/page.tsx", "lib/data.ts"]) {
      assert.throws(() => readFileSync(join(ROOT, gone)), /ENOENT/, gone);
    }
    assert.doesNotMatch(read("lib/store.ts"), /toggleCompare|clearCompare|compare:/);
    assert.match(read("app/(buyer)/besoins/[id]/page.tsx"), /comparePath\(demandId, chosen\)/);
  });
});
