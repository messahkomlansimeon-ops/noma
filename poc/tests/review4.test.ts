/**
 * Régressions — 4e revue du 02/10 (2 constats sur le scoring). Tests locaux.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseNeed } from "../lib/need";
import { evaluateListing } from "../lib/filter";
import { baseScore, scoreListings, parseFreshness } from "../lib/scoring";
import type { RawListing } from "../lib/normalize";

const listing = (over: Partial<RawListing>): RawListing => ({
  id: "x",
  source: "coinafrique",
  title: "iPhone 12 Pro - 128Gb",
  price: 135000,
  currency: "FCFA",
  zone: "Cocody",
  vendor: null,
  url: null,
  photo: null,
  date: "il y a 2 h",
  description: "en bon état",
  ...over,
});

const need = parseNeed(
  "iPhone 12 · 128 Go, bon état, à Abidjan, max 150 000 FCFA",
);

// ─── P2-1 : la fraîcheur comprend les formats des connecteurs ──────────────
describe("P2-1 — fraîcheur : unités reconnues et grading monotone", () => {
  test("parseFreshness : minutes normalisées", () => {
    for (const [date, minutes] of [
      ["il y a 39 minutes", 39],
      ["il y a 30 min", 30],
      ["il y a 1 heure", 60],
      ["il y a 2 h", 120],
      ["2 j", 2880],
      ["il y a 5 jours", 7200],
      ["il y a 2 semaines", 20160],
      ["il y a 1 mois", 43200],
      ["récente", 5],
      ["Hier", 1440],
    ] as [string, number][]) {
      assert.equal(parseFreshness(date), minutes, `« ${date} »`);
    }
    assert.equal(parseFreshness("date inconnue"), null);
    assert.equal(parseFreshness(null), null);
  });

  test("« il y a 1 heure » n'est plus pénalisé par rapport à « 2 j »", () => {
    const evHeure = evaluateListing(need, listing({ date: "il y a 1 heure" }));
    const evJours = evaluateListing(need, listing({ date: "2 j" }));
    assert.ok(
      baseScore(evHeure, need) >= baseScore(evJours, need),
      `heure ${baseScore(evHeure, need)} vs jours ${baseScore(evJours, need)}`,
    );
  });

  test("grading monotone : min > h > j > mois > absent", () => {
    const s = (date: string | null) => baseScore(evaluateListing(need, listing({ date })), need);
    const recent = s("il y a 39 minutes");
    const heures = s("il y a 2 h");
    const jours = s("il y a 5 jours");
    const mois = s("il y a 1 mois");
    const absent = s(null);
    assert.ok(recent > heures, `${recent} > ${heures}`);
    assert.ok(heures > jours, `${heures} > ${jours}`);
    assert.ok(jours > mois, `${jours} > ${mois}`);
    assert.ok(mois > absent, `${mois} > ${absent}`);
  });
});

// ─── P2-2 : le ratio ne masque pas le budget invérifiable ──────────────────
describe("P2-2 — dénominateur du ratio = critères DEMANDÉS", () => {
  test("prix absent : 4/5 (le budget reste au dénominateur)", () => {
    const ev = evaluateListing(need, listing({ price: null }));
    const [s] = scoreListings(need, [ev], null);
    assert.deepEqual(s.confirmedRatio, { known: 4, total: 5 }, JSON.stringify(s.confirmedRatio));
  });

  test("devise inconnue : 4/5 également", () => {
    const ev = evaluateListing(need, listing({ price: 135000, currency: "unknown" }));
    const [s] = scoreListings(need, [ev], null);
    assert.deepEqual(s.confirmedRatio, { known: 4, total: 5 }, JSON.stringify(s.confirmedRatio));
    assert.equal(s.evaluated.priceNonComparable, true);
  });

  test("tout confirmé : 5/5", () => {
    const ev = evaluateListing(need, listing({}));
    const [s] = scoreListings(need, [ev], null);
    assert.deepEqual(s.confirmedRatio, { known: 5, total: 5 });
  });

  test("sans budget demandé : le budget ne compte pas au dénominateur", () => {
    const needSansBudget = parseNeed("iPhone 12 · 128 Go, bon état, à Abidjan");
    const ev = evaluateListing(
      needSansBudget,
      listing({ title: "iPhone 12 simple", price: null }),
    );
    const [s] = scoreListings(needSansBudget, [ev], null);
    assert.deepEqual(s.confirmedRatio, { known: 3, total: 4 }, JSON.stringify(s.confirmedRatio));
  });
});