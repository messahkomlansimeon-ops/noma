import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseNeed } from "../lib/need";
import { evaluateListing } from "../lib/filter";
import { scoreListings, validateAiBatch, buildRaison, baseScore, type AiScoreItem } from "../lib/scoring";
import type { RawListing } from "../lib/normalize";

const listing = (over: Partial<RawListing>): RawListing => ({
  id: "x",
  source: "coinafrique",
  title: "iPhone 12 - 128Gb",
  price: 135000,
  currency: "FCFA",
  zone: "Cocody",
  vendor: null,
  url: null,
  photo: null,
  date: "il y a 2 h",
  description: null,
  ...over,
});

const need = parseNeed(
  "iPhone 12 · 128 Go, bon état, à Abidjan, max 150 000 FCFA",
);

describe("validateAiBatch — identifiants IA validés", () => {
  test("idx étranger au lot rejeté", () => {
    const { valid, invalid } = validateAiBatch(
      [{ idx: 0, score: 0.9 }, { idx: 7, score: 0.5 }],
      2,
    );
    assert.equal(valid.length, 1);
    assert.equal(invalid.length, 1);
    assert.ok(invalid[0].includes("hors lot"));
  });

  test("idx dupliqué rejeté", () => {
    const { valid, invalid } = validateAiBatch(
      [{ idx: 0, score: 0.9 }, { idx: 0, score: 0.4 }],
      3,
    );
    assert.equal(valid.length, 1);
    assert.ok(invalid[0].includes("dupliqué"));
  });

  test("aucune omission silencieuse : les idx manquants restent « non évalués »", () => {
    const evs = [listing({}), listing({ id: "y" })].map((l) => evaluateListing(need, l));
    const scored = scoreListings(need, evs, [{ idx: 0, score: 0.9 }]);
    assert.equal(scored[0].aiStatus, "évalué par IA");
    assert.equal(scored[1].aiStatus, "non évalué par IA");
    assert.equal(scored[1].score, scored[1].baseScore, "score déterministe conservé");
  });
});

describe("scoreListings — statuts et scores", () => {
  test("échec IA complet → tout « non évalué par IA », offres conservées", () => {
    const evs = [listing({}), listing({ id: "y", price: null })].map((l) => evaluateListing(need, l));
    const scored = scoreListings(need, evs, null);
    assert.equal(scored.length, 2, "aucune offre supprimée");
    for (const s of scored) {
      assert.equal(s.aiStatus, "non évalué par IA");
      assert.equal(s.score, s.baseScore);
      assert.ok(s.raison.length > 0);
    }
  });

  test("IA fiable → moyenne déterministe + IA", () => {
    const evs = [listing({ description: "batterie 85%, écran sans rayure" })].map((l) =>
      evaluateListing(need, l),
    );
    const ai: AiScoreItem[] = [
      { idx: 0, score: 1.0, criteres: [{ nom: "batterie", valeur: "85%", extrait: "batterie 85%" }] },
    ];
    const scored = scoreListings(need, evs, ai);
    assert.equal(scored[0].aiStatus, "évalué par IA");
    assert.equal(scored[0].score, Math.round(((baseScore(scored[0].evaluated, need) + 1) / 2) * 100) / 100);
    assert.equal(scored[0].criteria[0].nom, "batterie");
  });

  test("score IA hors bornes ignoré (score = base)", () => {
    const evs = [listing({})].map((l) => evaluateListing(need, l));
    const scored = scoreListings(need, evs, [{ idx: 0, score: 4.2 }]);
    assert.equal(scored[0].score, scored[0].baseScore);
  });
});

describe("buildRaison — « correspondance exacte » encadrée", () => {
  test("interdit si la capacité est inconnue → « Correspondance partielle »", () => {
    const ev = evaluateListing(need, listing({ title: "iPhone 12 simple", price: 100000 }));
    const raison = buildRaison(need, ev, [], null);
    assert.ok(raison.startsWith("Correspondance partielle"), raison);
    assert.ok(!raison.includes("exacte"), raison);
    assert.ok(raison.includes("capacité inconnue"), raison);
  });

  test("autorisée si modèle + capacité + budget tous compatibles", () => {
    const ev = evaluateListing(need, listing({ description: "iPhone en bon état général" }));
    const raison = buildRaison(need, ev, [], 0.95);
    assert.ok(raison.startsWith("Correspondance exacte"), raison);
  });

  test("prix non comparable → jamais jugé dans le budget", () => {
    const ev = evaluateListing(need, listing({ price: 250, currency: "USD" }));
    const raison = buildRaison(need, ev, [], null);
    assert.ok(raison.startsWith("Prix non comparable"), raison);
    assert.ok(!raison.includes("dans le budget"), raison);
  });

  test("prix sur demande → mention explicite", () => {
    const ev = evaluateListing(need, listing({ price: null }));
    const raison = buildRaison(need, ev, [], null);
    assert.ok(raison.includes("prix sur demande"), raison);
  });

  test("extraits IA avec valeur observée", () => {
    const ev = evaluateListing(need, listing({ description: "écran rayé léger, batterie 89%" }));
    const raison = buildRaison(
      need,
      ev,
      [{ nom: "état", valeur: "batterie 89%", extrait: "batterie 89%" }],
      0.8,
    );
    assert.ok(raison.includes("état : batterie 89%"), raison);
    assert.ok(raison.includes("« batterie 89% »"), raison);
  });
});