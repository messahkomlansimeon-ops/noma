import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseNeed, parsePrice, listingCapacity } from "../lib/need";

describe("parseNeed — parsing du besoin v2", () => {
  test("téléphone : capacité avec unité, budget absent → null", () => {
    const n = parseNeed("iPhone 12 · 128 Go, bon état, à Abidjan");
    assert.equal(n.kind, "produit");
    assert.equal(n.model, "iphone 12");
    assert.deepEqual(n.capacity, { value: 128, unit: "Go" });
    assert.equal(n.budget, null, "aucun plafond implicite");
    assert.equal(n.zone, "abidjan");
    assert.ok(n.criteria.includes("bon etat"));
  });

  test("numéro de modèle jamais transformé en capacité (modèle 18)", () => {
    const n = parseNeed("iPhone 18 à Abidjan");
    assert.equal(n.model, "iphone 18");
    assert.equal(n.capacity, null, "pas d'unité → pas de capacité");
  });

  test("capacité gb → Go normalisée, accents gérés", () => {
    const n = parseNeed("clé 128 Gb à Cocody, très bon état");
    assert.deepEqual(n.capacity, { value: 128, unit: "Go" });
    assert.equal(n.zone, "cocody");
    assert.ok(n.criteria.includes("tres bon etat"), "accents normalisés");
  });

  test("budget avec devise explicite → XOF", () => {
    const n = parseNeed("canapé 3 places à Cocody, max 200 000 FCFA");
    assert.deepEqual(n.budget, { amount: 200000, currency: "XOF", explicitCurrency: true });
  });

  test("budget marqueur sans devise → currency null", () => {
    const n = parseNeed("téléviseur, jusqu'à 150 000");
    assert.deepEqual(n.budget, { amount: 150000, currency: null, explicitCurrency: false });
  });

  test("montant final groupé sans devise (exemple canapé)", () => {
    const n = parseNeed("canapé 3 places cocody 200 000");
    assert.deepEqual(n.budget, { amount: 200000, currency: null, explicitCurrency: false });
    assert.equal(n.zone, "cocody");
    assert.ok(n.product.includes("canape") || n.product.includes("canapé") === false, "produit sans montant");
    assert.ok(!n.product.includes("200"), "montant retiré du produit");
  });

  test("budget USD explicite", () => {
    const n = parseNeed("laptop gaming 800 $ à Abidjan");
    assert.deepEqual(n.budget, { amount: 800, currency: "USD", explicitCurrency: true });
  });

  test("service reconnu + autre ville", () => {
    const n = parseNeed("plombier à Bouaké");
    assert.equal(n.kind, "service");
    assert.equal(n.zone, "bouake");
    assert.equal(n.budget, null);
    assert.ok(n.product.includes("plombier"));
  });

  test("service avec budget explicite", () => {
    const n = parseNeed("réparation climatiseur, budget 25 000 FCFA");
    assert.equal(n.kind, "service");
    assert.deepEqual(n.budget, { amount: 25000, currency: "XOF", explicitCurrency: true });
  });

  test("zone et budget exclus des mots-clés produit", () => {
    const n = parseNeed("vélo électrique abidjan 100 000 fcfa");
    assert.ok(!n.keywords.includes("abidjan"));
    assert.ok(!n.keywords.includes("fcfa"));
  });

  test("formulations conversationnelles retirées du produit", () => {
    const n = parseNeed("Je voudrais une table 6 places vers Angré, moins de 100 mille francs");
    assert.equal(n.product, "table");
    assert.deepEqual(n.keywords, ["table"]);
  });
});

describe("parsePrice — prix et devises d'annonce", () => {
  test("FCFA explicite → XOF", () => {
    assert.deepEqual(parsePrice("iPhone 12 - 128Gb 135 000 FCFA"), {
      amount: 135000,
      currency: "XOF",
    });
  });

  test("CFA collé au titre (« 85 000 CFAiPhone »)", () => {
    const r = parsePrice("85 000 CFAiPhone 12 simple 128GB");
    assert.equal(r.amount, 85000);
    assert.equal(r.currency, "XOF");
  });

  test("devise absente → unknown (jamais supposée)", () => {
    const r = parsePrice("iPhone 12 135000");
    assert.equal(r.amount, 135000);
    assert.equal(r.currency, "unknown");
  });

  test("USD reconnu", () => {
    assert.deepEqual(parsePrice("299 $US"), { amount: 299, currency: "USD" });
  });

  test("prix inexistant → null/unknown", () => {
    assert.deepEqual(parsePrice("Prix sur demande — contactez le vendeur"), {
      amount: null,
      currency: "unknown",
    });
  });
});

describe("listingCapacity — capacité d'annonce", () => {
  test("128 Go détectée", () => {
    assert.deepEqual(listingCapacity("iPhone 12 - 128Gb"), { value: 128, unit: "Go" });
  });

  test("numéro de modèle seul = pas une capacité", () => {
    assert.equal(listingCapacity("iPhone 12 simple"), null);
  });

  test("1 To accepté", () => {
    assert.deepEqual(listingCapacity("Disque dur 1 To"), { value: 1, unit: "To" });
  });
});
