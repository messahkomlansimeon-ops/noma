import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { parseNeed } from "../lib/need";
import { applyUnderstanding, normalizeUnderstanding } from "../lib/understanding";
import { classify } from "../lib/filter";
import { serpQueries } from "../lib/query";
import { buildRaison, confirmedRatio } from "../lib/scoring";
import type { RawListing } from "../lib/normalize";

const raw = (title: string, zone = "Abidjan"): RawListing => ({
  id: title,
  source: "test",
  title,
  price: 120_000,
  currency: "FCFA",
  zone,
  vendor: null,
  url: null,
  photo: null,
  date: null,
  description: null,
});

describe("compréhension sémantique", () => {
  test("retire toute contrainte IA sans preuve mot pour mot", () => {
    const need = parseNeed("Je cherche un frigo 300 litres classe A+ à Abidjan");
    const result = normalizeUnderstanding(need, {
      canonicalProduct: "réfrigérateur",
      category: "électroménager",
      searchTerms: ["frigo"],
      requirements: [
        { label: "Capacité", value: "300 litres", evidence: "300 litres" },
        { label: "Classe énergétique", value: "A+", evidence: "classe A+" },
        { label: "État", value: "neuf", evidence: "neuf" },
      ],
      preferences: [],
      exclusions: [],
      confidence: 0.95,
      clarification: null,
    });
    assert.deepEqual(result.requirements.map((c) => c.label), ["Classe énergétique"]);
  });

  test("retire une valeur contredite par sa propre preuve", () => {
    const need = parseNeed("Je cherche un frigo 300 litres à Abidjan");
    const result = normalizeUnderstanding(need, {
      canonicalProduct: "réfrigérateur",
      category: "électroménager",
      requirements: [
        { label: "Capacité", value: "500 litres", evidence: "300 litres" },
      ],
      confidence: 0.95,
      clarification: null,
    });
    assert.deepEqual(result.requirements, []);
  });

  test("normalise une exclusion négative vers la chose à exclure", () => {
    const need = parseNeed("Je cherche un frigo sans congélateur");
    const result = normalizeUnderstanding(need, {
      canonicalProduct: "réfrigérateur",
      category: "électroménager",
      exclusions: [
        { label: "Compartiment", value: "sans congélateur", evidence: "sans congélateur" },
      ],
      confidence: 0.95,
      clarification: null,
    });
    assert.equal(result.exclusions[0]?.value, "congélateur");
  });

  test("déplace en exclusion une exigence dont la preuve est négative", () => {
    const need = parseNeed("Je cherche un frigo sans congélateur");
    const result = normalizeUnderstanding(need, {
      canonicalProduct: "réfrigérateur",
      category: "électroménager",
      requirements: [
        { label: "Sans compartiment", value: "congélateur", evidence: "sans congélateur" },
      ],
      confidence: 0.9,
      clarification: null,
    });
    assert.deepEqual(result.requirements, []);
    assert.equal(result.exclusions[0]?.value, "congélateur");
  });

  test("une ambiguïté connue déclenche une question même si l'IA devine", () => {
    const need = parseNeed("Je cherche une console à Abidjan 150 000");
    const result = normalizeUnderstanding(need, {
      canonicalProduct: "console de jeux",
      category: "gaming",
      confidence: 0.95,
      clarification: null,
    });
    assert.deepEqual(result.clarification?.options, ["Console de jeux", "Meuble console"]);
  });

  test("ne recompte pas budget, zone et attributs comme exigences sémantiques", () => {
    const need = parseNeed("table solide 6 places à Cocody budget 100 000 FCFA");
    const result = normalizeUnderstanding(need, {
      canonicalProduct: "table",
      category: "meuble",
      requirements: [
        { label: "Budget", value: "100 000", evidence: "budget 100 000 FCFA" },
        { label: "Location", value: "Cocody", evidence: "à Cocody" },
        { label: "Nombre de places", value: "6 places", evidence: "6 places" },
        { label: "Solidité", value: "solide", evidence: "solide" },
      ],
      confidence: 0.9,
      clarification: null,
    });
    assert.deepEqual(result.requirements.map((item) => item.value), ["solide"]);
  });

  test("ne pose une question que si la confiance est faible", () => {
    const need = parseNeed("Je cherche une console");
    const low = normalizeUnderstanding(need, {
      canonicalProduct: "console",
      category: "électronique",
      confidence: 0.55,
      clarification: { question: "Quel type de console ?", options: ["Console de jeux", "Meuble console"] },
    });
    assert.equal(low.clarification?.options.length, 2);
    const highNeed = parseNeed("Je cherche un iPhone 12");
    const high = normalizeUnderstanding(highNeed, {
      canonicalProduct: "iPhone 12",
      category: "électronique",
      confidence: 0.9,
      clarification: { question: "Quel téléphone ?", options: ["iPhone 12", "iPhone 13"] },
    });
    assert.equal(high.clarification, null);
  });

  test("un synonyme sémantique élargit le produit sans relâcher litres ni zone", () => {
    const need = parseNeed("réfrigérateur 300 litres à Abidjan");
    applyUnderstanding(need, {
      canonicalProduct: "réfrigérateur",
      category: "électroménager",
      searchTerms: ["frigo", "réfrigérateur"],
      requirements: [], preferences: [], exclusions: [],
      confidence: 0.98, clarification: null, source: "ai",
    });
    const result = classify([
      raw("Frigo LG 300 litres"),
      raw("Frigo LG 200 litres"),
      raw("Frigo LG 300 litres", "Bouaké"),
    ], need);
    assert.equal(result.candidates.length, 1);
    assert.equal(result.rejected.length, 2);
    assert.ok(serpQueries(need).some((q) => q.toLowerCase().includes("frigo")));
  });

  test("un synonyme large ne confirme pas une exigence USB-C absente", () => {
    const need = parseNeed("chargeur USB-C 20W à Abidjan");
    applyUnderstanding(need, {
      canonicalProduct: "chargeur USB-C",
      category: "accessoire téléphone",
      searchTerms: ["chargeur rapide", "chargeur USB-C"],
      requirements: [
        { label: "Connectique", value: "USB-C", evidence: "USB-C" },
      ],
      preferences: [], exclusions: [], confidence: 0.98,
      clarification: null, source: "ai",
    });
    const result = classify([raw("Chargeur rapide solaire 20W")], need);
    assert.equal(result.candidates.length, 1, "information absente = candidate, jamais rejet automatique");
    const ev = result.candidates[0];
    assert.equal(ev.model.state, "inconnu");
    assert.equal(ev.semanticRequirements[0].state, "inconnu");
    assert.ok(!buildRaison(need, ev, [], null).startsWith("Correspondance exacte"));
    assert.ok(confirmedRatio(ev, need).known < confirmedRatio(ev, need).total);
  });

  test("une exclusion comprise est appliquée au filtrage", () => {
    const need = parseNeed("réfrigérateur sans congélateur à Abidjan");
    applyUnderstanding(need, {
      canonicalProduct: "réfrigérateur",
      category: "électroménager",
      searchTerms: ["frigo", "réfrigérateur"],
      requirements: [], preferences: [],
      exclusions: [
        { label: "Sans compartiment", value: "congélateur", evidence: "sans congélateur" },
      ],
      confidence: 0.98, clarification: null, source: "ai",
    });
    const result = classify([
      raw("Frigo avec congélateur"),
      raw("Frigo sans congélateur"),
    ], need);
    assert.equal(result.rejected.length, 1);
    assert.match(result.rejected[0].reason, /exclusion contredite/);
    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0].semanticExclusions[0].state, "compatible");
  });
});
