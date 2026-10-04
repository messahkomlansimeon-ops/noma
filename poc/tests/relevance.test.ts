/**
 * Régressions — élargissement de pertinence (caractéristiques variées).
 * Tests locaux : aucun réseau.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseNeed, parsePrice } from "../lib/need";
import { evaluateListing, classify } from "../lib/filter";
import { scoreListings } from "../lib/scoring";
import { summarizeSources } from "../lib/orchestrate";
import type { SourceResult } from "../sources/types";
import type { RawListing } from "../lib/normalize";

const listing = (over: Partial<RawListing>): RawListing => ({
  id: "x",
  source: "coinafrique",
  title: "Annonce",
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

// ─── Parsing des caractéristiques ───────────────────────────────────────────
describe("parsing — caractéristiques chiffrées", () => {
  test("pointure", () => {
    const n = parseNeed("chaussures de sport pointure 42 à Abidjan");
    assert.deepEqual(n.attributes, [{ label: "pointure", value: 42 }]);
    assert.ok(n.product.includes("chaussures"), n.product);
    assert.ok(!n.product.includes("42"), n.product);
  });

  test("pouces (téléviseur)", () => {
    const n = parseNeed("téléviseur 55 pouces à Abidjan");
    assert.deepEqual(n.attributes, [{ label: "pouces", value: 55 }]);
    assert.ok(n.product.includes("televiseur") || n.product.includes("téléviseur"), n.product);
  });

  test("BTU (climatiseur)", () => {
    const n = parseNeed("climatiseur 12000 BTU à Abidjan");
    assert.deepEqual(n.attributes, [{ label: "BTU", value: 12000 }]);
    assert.ok(n.product.includes("climatiseur"), n.product);
  });

  test("places (table)", () => {
    const n = parseNeed("table à manger 6 places à Cocody");
    assert.deepEqual(n.attributes, [{ label: "places", value: 6 }]);
    assert.ok(n.product.includes("table"), n.product);
  });

  test("les attributs partent dans la requête site", async () => {
    const n = parseNeed("téléviseur 55 pouces à Abidjan");
    const { coinAfriqueQuery } = await import("../lib/query");
    const q = coinAfriqueQuery(n);
    assert.ok(new URL(q.url).searchParams.get("keyword")?.includes("55"), q.url);
    assert.ok(new URL(q.url).searchParams.get("keyword")?.includes("pouces"), q.url);
  });
});

// ─── Correspondance des caractéristiques ────────────────────────────────────
describe("filtrage — caractéristiques respectées", () => {
  test("pointure 42 : la bonne pointure est candidate", () => {
    const need = parseNeed("chaussures de sport pointure 42 à Abidjan");
    const ev = evaluateListing(need, listing({ title: "Nike chaussures de sport taille 42" }));
    assert.equal(ev.attributes[0].state, "compatible");
    const r = classify([listing({ title: "Nike chaussures de sport taille 42", price: 15000 })], need);
    assert.equal(r.candidates.length, 1);
  });

  test("pointure 45 ≠ 42 → rejetée", () => {
    const need = parseNeed("chaussures de sport pointure 42 à Abidjan");
    const ev = evaluateListing(need, listing({ title: "Chaussures de sport pointure 45" }));
    assert.equal(ev.attributes[0].state, "incompatible");
    const r = classify([listing({ title: "Chaussures de sport pointure 45", price: 15000 })], need);
    assert.equal(r.candidates.length, 0);
    assert.equal(r.rejected.length, 1);
  });

  test("pointure absente → candidate (information manquante)", () => {
    const need = parseNeed("chaussures de sport pointure 42 à Abidjan");
    const r = classify([listing({ title: "Chaussures de sport Nike", price: 15000 })], need);
    assert.equal(r.candidates.length, 1);
    assert.equal(r.rejected.length, 0);
  });

  test("55 pouces confirmé / 65 pouces rejeté", () => {
    const need = parseNeed("téléviseur 55 pouces à Abidjan");
    const ok = evaluateListing(need, listing({ title: "Smart TV Samsung 55 pouces" }));
    assert.equal(ok.attributes[0].state, "compatible");
    const ko = evaluateListing(need, listing({ title: "Smart TV Samsung 65 pouces" }));
    assert.equal(ko.attributes[0].state, "incompatible");
    const r = classify([listing({ title: "Smart TV 65 pouces", price: 250000 })], need);
    assert.equal(r.candidates.length, 0);
  });

  test("12000 BTU confirmé / 9000 BTU rejeté", () => {
    const need = parseNeed("climatiseur 12000 BTU à Abidjan");
    const ok = evaluateListing(need, listing({ title: "Climatiseur split 12000 BTU" }));
    assert.equal(ok.attributes[0].state, "compatible");
    const ko = evaluateListing(need, listing({ title: "Climatiseur split 9000 BTU" }));
    assert.equal(ko.attributes[0].state, "incompatible");
  });

  test("6 places confirmé / 4 places rejeté (table)", () => {
    const need = parseNeed("table à manger 6 places à Cocody");
    const ok = evaluateListing(need, listing({ title: "Table à manger 6 places en bois" }));
    assert.equal(ok.attributes[0].state, "compatible");
    const ko = evaluateListing(need, listing({ title: "Table à manger 4 places" }));
    assert.equal(ko.attributes[0].state, "incompatible");
  });

  test("le scoring reflète la caractéristique (raison affichée)", () => {
    const need = parseNeed("téléviseur 55 pouces à Abidjan");
    const ev = evaluateListing(need, listing({ title: "Smart TV 65 pouces" }));
    const [s] = scoreListings(need, [ev], null);
    assert.ok(s.raison.includes("pouces"), s.raison);
    assert.ok(s.raison.includes("65 pouces (≠ 55)"), s.raison);
  });
});

// ─── Non-régressions — 4 reproductions (revue 5, 02/10) ────────────────────
describe("revue 5 — chaque valeur liée à son unité, chaque check à son attribut", () => {
  // P1-1 : « TV 65 pouces, consommation 55 W » ne confirme pas « 55 pouces »
  test("P1-1 — le « 55 » d'une autre unité ne confirme pas les pouces", () => {
    const need = parseNeed("téléviseur 55 pouces à Abidjan");
    const ev = evaluateListing(
      need,
      listing({ title: "Smart TV 65 pouces, consommation 55 W" }),
    );
    assert.equal(ev.attributes[0].state, "incompatible");
    assert.ok((ev.attributes[0].observed ?? "").includes("65 pouces"), ev.attributes[0].observed ?? "");
    const r = classify(
      [listing({ title: "Smart TV 65 pouces, consommation 55 W", price: 250000 })],
      need,
    );
    assert.equal(r.candidates.length, 0);
    assert.equal(r.rejected.length, 1);
    const [s] = scoreListings(need, [evaluateListing(need, listing({ title: "Smart TV 65 pouces, consommation 55 W" }))], null);
    assert.ok(!s.raison.includes("pouces : 55 confirmé"), s.raison);
    assert.ok(s.raison.includes("65 pouces"), s.raison);
  });

  // P1-2 : décimales et séparateurs de milliers
  test("P1-2 — « 1,5 CV » ≠ 5 CV ; « 12 000 BTU » garde sa contrainte", () => {
    const cv = parseNeed("climatiseur 1,5 CV à Abidjan");
    assert.deepEqual(cv.attributes, [{ label: "CV", value: 1.5 }]);
    const btu = parseNeed("climatiseur 12 000 BTU à Abidjan");
    assert.deepEqual(btu.attributes, [{ label: "BTU", value: 12000 }]);
    const evOk = evaluateListing(btu, listing({ title: "Climatiseur split 12 000 BTU" }));
    assert.equal(evOk.attributes[0].state, "compatible");
    const evKo = evaluateListing(btu, listing({ title: "Climatiseur split 9000 BTU" }));
    assert.equal(evKo.attributes[0].state, "incompatible");
    // la forme décimale côté annonce aussi (« 1.5CV », « 1,5 Chevaux »)
    const evCv = evaluateListing(cv, listing({ title: "Climatiseur 1,5 Chevaux split" }));
    assert.equal(evCv.attributes[0].state, "compatible");
    const evWrongCv = evaluateListing(cv, listing({ title: "Climatiseur 2 CV split" }));
    assert.equal(evWrongCv.attributes[0].state, "incompatible");
  });

  // P2-3 : une caractéristique confirmée ne valide pas les autres
  test("P2-3 — « 200 litres » seul ne confirme pas les 100 W", () => {
    const need = parseNeed("réfrigérateur 200 litres, 100 W à Abidjan");
    assert.equal(need.attributes.length, 2, JSON.stringify(need.attributes));
    const ev = evaluateListing(need, listing({ title: "Réfrigérateur 200 litres" }));
    const [s] = scoreListings(need, [ev], null);
    assert.ok(s.confirmedRatio.known < s.confirmedRatio.total, s.raison);
    assert.ok(s.baseScore < 1, `score ${s.baseScore} ne doit pas valoir 1,00`);
    assert.ok(s.raison.includes("W 100 non confirmé"), s.raison);
    assert.ok(!s.raison.startsWith("Correspondance exacte"), s.raison);
  });

  // P2-4 : « Correspondance exacte » exige les attributs confirmés
  test("P2-4 — TV sans taille indiquée : pas de « Correspondance exacte »", () => {
    const need = parseNeed("téléviseur 55 pouces à Abidjan");
    const [s] = scoreListings(
      need,
      [evaluateListing(need, listing({ title: "Smart TV Samsung" }))],
      null,
    );
    assert.ok(!s.raison.startsWith("Correspondance exacte"), s.raison);
    assert.ok(s.raison.includes("pouces 55 non confirmé"), s.raison);
  });
});

// ─── Aucun résultat ≠ source indisponible ──────────────────────────────────
describe("revue 8 — quartier demandé et petits montants", () => {
  // P2-1 : « Cocody » annoncée pour un besoin « Angré » = incertaine, pas rejetée
  test("P2-1 — quartier demandé + commune annoncée → candidat (non précisé)", () => {
    const need = parseNeed("meuble à Angré");
    assert.equal(need.zone, "angre");
    const r = classify([listing({ title: "Meuble bois", zone: "Cocody" })], need);
    assert.equal(r.candidates.length, 1, JSON.stringify(r.rejected));
    assert.equal(r.candidates[0].zone.state, "inconnu");
    assert.ok((r.candidates[0].zone.note ?? "").includes("non précisé"));
    // « Abidjan » sans commune : pareil
    const ev = evaluateListing(need, listing({ title: "Meuble bois", zone: "Abidjan" }));
    assert.equal(ev.zone.state, "inconnu");
    // autre commune : rejet avéré (Yopougon ne peut pas être Angré)
    const r2 = classify([listing({ title: "Meuble bois", zone: "Yopougon, Abidjan" })], need);
    assert.equal(r2.candidates.length, 0);
    // autre quartier de la même commune : rejet avéré (Riviera ≠ Angré)
    const r3 = classify([listing({ title: "Meuble bois", zone: "Riviera Palmeraie" })], need);
    assert.equal(r3.candidates.length, 0);
    // le quartier lui-même : compatible (régression)
    const evOk = evaluateListing(need, listing({ title: "Meuble bois", zone: "Angré 7ème tranche" }));
    assert.equal(evOk.zone.state, "compatible");
    // commune demandée + « Abidjan » sans commune : toujours inconnu (régression)
    const evC = evaluateListing(
      parseNeed("meuble à Cocody"),
      listing({ title: "Meuble bois", zone: "Abidjan" }),
    );
    assert.equal(evC.zone.state, "inconnu");
  });

  // P2-2 : « 5k FCFA » = 5 000 (devise explicite → pas de garde ≥ 50)
  test("P2-2 — petits montants abrégés avec devise", () => {
    const n = parseNeed("chargeur 5k FCFA à Abidjan");
    assert.deepEqual(n.budget, { amount: 5000, currency: "XOF", explicitCurrency: true });
    assert.equal(n.product, "chargeur");
    const p = parsePrice("Chargeur rapide 5k FCFA");
    assert.deepEqual(p, { amount: 5000, currency: "XOF" });
    // garde conservée SANS devise : « cocody 5k » n'est pas un budget,
    // « téléviseur 4k » non plus
    assert.equal(parseNeed("téléviseur 4k à Cocody").budget, null);
    assert.equal(parseNeed("canapé cocody 5k").budget, null);
  });
});
describe("revue 7 — budgets et géographie ivoiriens", () => {
  // P1 : budgets jamais tronqués
  test("P1 — « 150k » = 150 000, « 4,700,000 FCFA » = 4 700 000", () => {
    assert.deepEqual(parseNeed("canapé budget 150k à Cocody").budget, {
      amount: 150000, currency: null, explicitCurrency: false,
    });
    const m = parseNeed("terrain 4,700,000 FCFA à Yamoussoukro").budget;
    assert.deepEqual(m, { amount: 4700000, currency: "XOF", explicitCurrency: true });
    // côté annonce aussi
    const p = parsePrice("Terrain 4,700,000 FCFA");
    assert.equal(p.amount, 4700000);
    assert.equal(p.currency, "XOF");
  });

  test("P1 — formulations locales « mille » et « million »", () => {
    assert.deepEqual(parseNeed("table 6 places moins de 100 mille francs à Angré").budget, {
      amount: 100000, currency: "XOF", explicitCurrency: true,
    });
    assert.deepEqual(parseNeed("voiture budget 1,5 million FCFA à Cocody").budget, {
      amount: 1500000, currency: "XOF", explicitCurrency: true,
    });
    assert.deepEqual(parseNeed("canapé à Yop 120 mille").budget, {
      amount: 120000, currency: null, explicitCurrency: false,
    });
    assert.deepEqual(parsePrice("Toyota Corolla 3 millions FCFA"), {
      amount: 3000000, currency: "XOF",
    });
  });

  test("P2 — abréviations monétaires : F, frs, F.CFA", () => {
    for (const texte of [
      "téléviseur 150 000 F à Cocody",
      "téléviseur 150 000 frs à Cocody",
      "téléviseur 150 000 F.CFA à Cocody",
    ]) {
      const b = parseNeed(texte).budget;
      assert.deepEqual(b, { amount: 150000, currency: "XOF", explicitCurrency: true }, texte);
    }
    const p = parsePrice("Réfrigérateur 150 000 F");
    assert.equal(p.currency, "XOF");
    assert.equal(p.amount, 150000);
  });

  test("P2 — « jusqu'à 150 000 » conserve son plafond (2 apostrophes)", () => {
    for (const apos of ["'", "\u2019"]) {
      const b = parseNeed(`jusqu${apos}à 150 000 à Cocody`).budget;
      assert.deepEqual(b, { amount: 150000, currency: null, explicitCurrency: false }, apos);
    }
  });

  test("P2 — localités : San Pedro, Port Bouët, Yop", () => {
    assert.equal(parseNeed("climatiseur à San Pedro").zone, "san-pedro");
    assert.equal(parseNeed("appartement Port Bouët").zone, "port-bouet");
    assert.equal(parseNeed("appartement Port-Bouët").zone, "port-bouet");
    assert.equal(parseNeed("meuble à Yop").zone, "yopougon");
    // la localité sort du produit (requête propre)
    assert.ok(!parseNeed("climatiseur à San Pedro").product.includes("pedro"));
    // besoin « cocody abidjan » : la commune spécifique gagne
    assert.equal(parseNeed("canapé cocody abidjan").zone, "cocody");
  });

  test("P2 — géographie précise : Yopougon ≠ Cocody, Bingerville demandé = compatible", () => {
    // demande Cocody + offre Yopougon → rejet avéré
    const r = classify(
      [listing({ title: "Table à manger", zone: "Yopougon, Abidjan" })],
      parseNeed("table à manger à Cocody"),
    );
    assert.equal(r.candidates.length, 0);
    assert.equal(r.rejected.length, 1);
    assert.ok(r.rejected[0].reason.includes("autre commune"), r.rejected[0].reason);
    // demande Cocody + offre « Abidjan » sans commune → inconnu, PAS confirmé
    const ev = evaluateListing(
      parseNeed("table à manger à Cocody"),
      listing({ title: "Table à manger", zone: "Abidjan" }),
    );
    assert.equal(ev.zone.state, "inconnu");
    assert.ok((ev.zone.note ?? "").includes("commune non précisée"));
    // demande Bingerville + offre Bingerville → compatible (fini l'incertain)
    const evB = evaluateListing(
      parseNeed("terrain à Bingerville"),
      listing({ title: "Terrain", zone: "Bingerville, Abidjan" }),
    );
    assert.equal(evB.zone.state, "compatible");
    // quartier : Riviera/Angré ⊂ Cocody → compatible
    const evQ = evaluateListing(
      parseNeed("table à manger à Cocody"),
      listing({ title: "Table à manger", zone: "Riviera Palmeraie" }),
    );
    assert.equal(evQ.zone.state, "compatible");
    // demande Abidjan + commune d'Abidjan → toujours compatible
    const evA = evaluateListing(
      parseNeed("table à manger à Abidjan"),
      listing({ title: "Table à manger", zone: "Yopougon" }),
    );
    assert.equal(evA.zone.state, "compatible");
  });
});
describe("revue 6 — valeurs multiples et virgule-milliers", () => {
  // P2-1 : « pointure 42/43 » pour une demande 43 — les DEUX valeurs comptent
  test("P2-1 — pointure multiple : 42/43 est candidate pour un besoin 43", () => {
    const need = parseNeed("chaussures de sport pointure 43 à Abidjan");
    const r = classify(
      [listing({ title: "Chaussures Nike pointure 42/43", price: 15000 })],
      need,
    );
    assert.equal(r.candidates.length, 1, JSON.stringify(r.rejected));
    assert.ok(r.candidates[0].attributes[0].state === "compatible");
    // la liste complète est extraite (3 tailles)
    const ev3 = evaluateListing(need, listing({ title: "Baskets pointure 40-41-42" }));
    assert.equal(ev3.attributes[0].state, "incompatible"); // 43 absent de la liste
    const ev42 = evaluateListing(
      parseNeed("chaussures de sport pointure 42 à Abidjan"),
      listing({ title: "Baskets pointure 40-41-42" }),
    );
    assert.equal(ev42.attributes[0].state, "compatible");
  });

  test("P2-1 — garde : un prix après le tiret n'est pas une pointure", () => {
    const need = parseNeed("téléviseur 65 pouces à Abidjan");
    const ev = evaluateListing(need, listing({ title: "TV 43 pouces - 65 000 F" }));
    // « 65 000 » (prix) ne doit PAS devenir une paire {pouces:65}
    assert.equal(ev.attributes[0].observed, "43 pouces (≠ 65)");
  });

  // P2-2 : « 12,000 BTU » = 12000 (virgule-milliers, plus « 12 BTU »)
  test("P2-2 — virgule de milliers conservée côté besoin et côté annonce", () => {
    const need = parseNeed("climatiseur 12,000 BTU à Abidjan");
    assert.deepEqual(need.attributes, [{ label: "BTU", value: 12000 }]);
    const evOk = evaluateListing(need, listing({ title: "Climatiseur split 12,000 BTU" }));
    assert.equal(evOk.attributes[0].state, "compatible");
    const evDot = evaluateListing(need, listing({ title: "Climatiseur split 12.000 BTU" }));
    assert.equal(evDot.attributes[0].state, "compatible");
    const evKo = evaluateListing(need, listing({ title: "Climatiseur split 9000 BTU" }));
    assert.equal(evKo.attributes[0].state, "incompatible");
  });
});
describe("summarizeSources — empty ≠ indisponible", () => {
  const base = (over: Partial<SourceResult>): SourceResult => ({
    source: "test",
    query: "q",
    capabilities: { search: true, location: false, pagination: false, itemCheck: false, services: false, unsupported: [] },
    warnings: [],
    listings: [],
    status: "ok",
    durationMs: 1,
    errors: [],
    ...over,
  });

  test("sources ok mais 0 annonce → « aucune offre trouvée (sources opérationnelles) »", () => {
    const s = summarizeSources([
      base({ source: "a", status: "empty" }),
      base({ source: "b", status: "empty" }),
    ]);
    assert.deepEqual(s, { ok: 0, empty: 2, indisponibles: 0, verdict: "aucune offre trouvée (sources opérationnelles)" });
  });

  test("au moins une source avec annonces → « résultats disponibles »", () => {
    const s = summarizeSources([
      base({ source: "a", status: "ok", listings: [listing({})] }),
      base({ source: "b", status: "blocked", errors: ["mur"] }),
    ]);
    assert.equal(s.verdict, "résultats disponibles");
    assert.equal(s.indisponibles, 1);
  });

  test("toutes sources bloquées/plantées → « sources indisponibles »", () => {
    const s = summarizeSources([
      base({ source: "a", status: "blocked" }),
      base({ source: "b", status: "error", errors: ["boom"] }),
      base({ source: "c", status: "timeout" }),
    ]);
    assert.deepEqual(s, { ok: 0, empty: 0, indisponibles: 3, verdict: "sources indisponibles" });
  });
});
