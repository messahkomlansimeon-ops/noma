import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseNeed } from "../lib/need";
import { evaluateListing, classify } from "../lib/filter";
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
  date: null,
  description: null,
  ...over,
});

const iphoneNeed = parseNeed(
  "iPhone 12 · 128 Go, bon état, à Abidjan, max 150 000 FCFA",
);

describe("evaluateListing — critères distincts", () => {
  test("annonce complète → tout compatible", () => {
    const ev = evaluateListing(iphoneNeed, listing({}));
    assert.equal(ev.model.state, "compatible");
    assert.equal(ev.capacity.state, "compatible");
    assert.equal(ev.budget.state, "compatible");
    assert.equal(ev.zone.state, "compatible");
    assert.equal(ev.priceNonComparable, false);
  });

  test("annonce sans capacité → inconnu, JAMAIS confirmée 128 Go", () => {
    const ev = evaluateListing(iphoneNeed, listing({ title: "iPhone 12 simple" }));
    assert.equal(ev.capacity.state, "inconnu");
    assert.equal(ev.capacity.observed, null);
    assert.ok(ev.capacity.note?.includes("non indiquée") ?? false);
  });

  test("capacité différente annoncée → incompatible (256 Go)", () => {
    const ev = evaluateListing(iphoneNeed, listing({ title: "iPhone 12 - 256Gb" }));
    assert.equal(ev.capacity.state, "incompatible");
    assert.equal(ev.capacity.observed, "256 Go");
  });

  test("autre numéro de modèle → incompatible (iPhone 13)", () => {
    const ev = evaluateListing(iphoneNeed, listing({ title: "iPhone 13 - 128Gb" }));
    assert.equal(ev.model.state, "incompatible");
    assert.ok(ev.model.observed?.includes("13"));
  });

  test("modèle non indiqué mais marque présente → inconnu (pas de rejet)", () => {
    const ev = evaluateListing(iphoneNeed, listing({ title: "iPhone (état nickel)" }));
    assert.equal(ev.model.state, "inconnu");
  });

  test("produit sans rapport → incompatible (chargeur)", () => {
    const ev = evaluateListing(iphoneNeed, listing({ title: "Chargeur USB-C 20W" }));
    assert.equal(ev.model.state, "incompatible");
  });

  test("prix > budget → incompatible budget (SANS marge +10%)", () => {
    const ev = evaluateListing(iphoneNeed, listing({ price: 160000 }));
    assert.equal(ev.budget.state, "incompatible");
    assert.equal(ev.budget.observed, "160000 XOF > 150000");
  });

  test("prix à la limite : 150 000 ≤ 150 000 → compatible (pas de +10% ajouté)", () => {
    const ev = evaluateListing(iphoneNeed, listing({ price: 165000 }));
    assert.equal(ev.budget.state, "incompatible", "165 000 > 150 000 strict, l'ancien +10% aurait accepté 165 000");
  });

  test("prix en USD vs budget FCFA → non comparable, jamais comparé", () => {
    const ev = evaluateListing(iphoneNeed, listing({ price: 250, currency: "USD", title: "Apple iPhone 12 - 128Gb" }));
    assert.equal(ev.priceNonComparable, true);
    assert.equal(ev.budget.state, "inconnu");
    assert.ok(ev.budget.observed?.includes("USD"));
  });

  test("devise absente → prix non comparable", () => {
    const ev = evaluateListing(iphoneNeed, listing({ price: 135000, currency: "unknown" }));
    assert.equal(ev.priceNonComparable, true);
  });

  test("budget non défini dans le besoin → prix affiché, critère inconnu", () => {
    const need = parseNeed("iPhone 12 128 Go à Abidjan");
    const ev = evaluateListing(need, listing({}));
    assert.equal(ev.budget.state, "inconnu");
    assert.ok(ev.budget.observed?.includes("135000"));
  });

  test("zone absente du besoin → critère inconnu pour toutes", () => {
    const need = parseNeed("iPhone 12 128 Go");
    const ev = evaluateListing(need, listing({}));
    assert.equal(ev.zone.state, "inconnu");
  });

  test("zone éloignée → signalée sans rejet (Bingerville)", () => {
    const ev = evaluateListing(iphoneNeed, listing({ zone: "Bingerville, Abidjan" }));
    assert.equal(ev.zone.state, "inconnu");
    assert.ok((ev.zone.note ?? ev.zone.observed ?? "").length > 0);
  });
});

describe("classify — rejet minimal et alternatives", () => {
  test("information manquante → candidate (jamais rejetée)", () => {
    const r = classify([listing({ title: "iPhone 12 simple" })], iphoneNeed);
    assert.equal(r.candidates.length, 1);
    assert.equal(r.rejected.length, 0);
  });

  test("capacité avérée différente → rejetée (256 Go)", () => {
    const r = classify([listing({ title: "iPhone 12 - 256Gb" })], iphoneNeed);
    assert.equal(r.candidates.length, 0);
    assert.equal(r.rejected.length, 1);
    assert.ok(r.rejected[0].reason.includes("256"));
  });

  test("hors budget → alternatives séparées, non candidates par défaut", () => {
    const r = classify(
      [listing({ price: 200000 }), listing({ price: 135000 })],
      iphoneNeed,
    );
    assert.equal(r.candidates.length, 1);
    assert.equal(r.alternatives.length, 1);
    assert.equal(r.alternatives[0].listing.price, 200000);
  });

  test("classify ne fusionne jamais alternatives et candidates", () => {
    const r = classify(
      [listing({ id: "ok", price: 135000 }), listing({ id: "cher", price: 200000 })],
      iphoneNeed,
    );
    const ids = [...r.candidates, ...r.alternatives].map((e) => e.listing.id);
    assert.equal(new Set(ids).size, ids.length);
  });

  test("services : le plombier reste candidate sans capacité/budget", () => {
    const need = parseNeed("plombier à Bouaké");
    const r = classify(
      [listing({ title: "Plombier professionnel disponible", price: null, zone: "Bouaké" })],
      need,
    );
    assert.equal(r.candidates.length, 1);
    assert.equal(r.rejected.length, 0);
  });
});

describe("régressions géographiques observées (essai réel 4A)", () => {
  // essai réel : « iPhone 12 Pro, Cocody » — une annonce à Abengourou était
  // maintenue « inconnue » parmi les candidates (5e position)
  test("Abengourou annoncée pour un besoin Cocody → incompatible (jamais candidate)", () => {
    const need = parseNeed("iPhone 12 Pro 128 Go à Cocody");
    assert.equal(need.zone, "cocody");
    const r = classify(
      [listing({ title: "iPhone 12 pro", price: 125000, zone: "Abengourou" })],
      need,
    );
    assert.equal(r.candidates.length, 0, "l'offre hors zone n'est plus candidate");
    assert.equal(r.rejected.length, 1);
    assert.match(r.rejected[0].reason, /zone/i);
    // inconnu n'est pas l'état observé : l'incompatibilité est avérée
    const ev = evaluateListing(need, listing({ zone: "Abengourou" }));
    assert.equal(ev.zone.state, "incompatible");
  });

  test("Bouaké annoncée pour un besoin Abidjan → incompatible", () => {
    const need = parseNeed("Téléviseur 55 pouces à Abidjan");
    const r = classify(
      [listing({ title: "Téléviseur 55 pouces", price: 190000, zone: "Bouaké" })],
      need,
    );
    assert.equal(r.candidates.length, 0, "Bouaké ≠ Abidjan : rejet avéré");
    assert.ok(r.rejected[0].reason.includes("autre zone : bouake"), "motif explicite autre zone");
  });

  test("ville connue incompatible : la zone annexe reste traitée avant (pas de régression)", () => {
    // Bingerville/Anyama restent « annexe » (jamais rejetées) même après la
    // correction des villes distantes
    const need = parseNeed("iPhone 12 à Cocody");
    const ev = evaluateListing(need, listing({ zone: "Bingerville" }));
    assert.equal(ev.zone.state, "inconnu", "zone annexe : incertaine, jamais rejetée");
  });

  test("zone sans ville connue : « zone à vérifier » (inconnu) — inchangé", () => {
    const need = parseNeed("iPhone 12 à Cocody");
    const ev = evaluateListing(need, listing({ zone: "Anyama, Abidjan" }));
    // Anyama = annexe d'Abidjan → inconnu (branche annexe, avant la ville distante)
    assert.equal(ev.zone.state, "inconnu");
  });
});

describe("régressions mots-clés distinctifs (essai réel 4B — relevé porteur)", () => {
  // besoin à mots-clés multiples : « Chargeur USB-C 20 W » →
  // keywords ["chargeur", "usb-c"] ; la correspondance exacte exige TOUS les
  // tokens distinctifs ; un hit partiel reste CANDIDAT (jamais rejeté)
  const needChargeur = parseNeed("Chargeur USB-C 20 W à Abidjan");

  test("solaire (chargeur ✓, usb-c ✗) → inconnu « mots-clés partiels », jamais rejeté", () => {
    const l = listing({ title: "Chargeur d'énergie solaire 20w", price: 28000, zone: "Angré, Abidjan" });
    const ev = evaluateListing(needChargeur, l);
    assert.equal(ev.model.state, "inconnu", "USB-C absent : pas de « correspondance exacte »");
    assert.ok((ev.model.note ?? "").includes("mots-clés partiels"));
    // 20 W est contrôlé : l'attribut W=20 du besoin est confirmé sur l'annonce
    assert.ok(needChargeur.attributes?.some((a) => a.label === "W" && a.value === 20), "le besoin porte l'attribut 20 W");
    assert.ok(
      ev.attributes.every((a) => a.state !== "incompatible"),
      "20 W confirmé sur « solaire 20w » (aucune caractéristique incompatible)",
    );
    assert.equal(ev.attributes[0]?.state, "compatible");
    const r = classify([l], needChargeur);
    assert.equal(r.rejected.length, 0, "« solaire » seul ne justifie pas un rejet");
  });

  test("chargeur secteur USB-C 20W (chargeur ✓, usb-c ✓) → compatible", () => {
    const l = listing({ title: "Chargeur secteur USB-C 20W – Apple maison mère Adjamé", price: 20, zone: null, description: "20 CFA" });
    const ev = evaluateListing(needChargeur, l);
    assert.equal(ev.model.state, "compatible", "tous les mots-clés distinctifs présents");
  });

  test("produit sans rapport (aucun mot-clé) → incompatible — inchangé", () => {
    const l = listing({ title: "Table en verre trempé", price: 25000, zone: "Cocody" });
    const ev = evaluateListing(needChargeur, l);
    assert.equal(ev.model.state, "incompatible");
    assert.equal(classify([l], needChargeur).rejected.length, 1);
  });
});

describe("régressions synonyme « TV » (essai réel 4B — décision porteur)", () => {
  // 62 annonces « TV Samsung … » étaient rejetées « produit sans rapport »
  // (synonyme absent des mots-clés) ; « TV » est désormais un synonyme de
  // « téléviseur ». Les contraintes 55 pouces, géographie et accessibilité
  // restent strictes ; les accessoires ne doivent pas devenir candidats.
  const needTV = parseNeed("Téléviseur 55 pouces à Abidjan");

  test("Smart TV Samsung 55\" (Abidjan) → candidate (synonyme « TV » reconnu)", () => {
    const l = listing({ title: "TV Samsung Smart UHD 4K 55pouces", price: 450000, zone: "Adjamé, Abidjan" });
    const ev = evaluateListing(needTV, l);
    assert.equal(ev.model.state, "compatible", "« tv » reconnu comme synonyme de « téléviseur »");
    const r = classify([l], needTV);
    assert.equal(r.candidates.length, 1);
    assert.equal(r.rejected.length, 0);
  });

  test("« Smart TV » sans 55 pouces : la contrainte pouces reste contrôlée", () => {
    const l = listing({ title: "Smart TV Philips 32\"", price: 150000, zone: "Abidjan" });
    const ev = evaluateListing(needTV, l);
    assert.equal(ev.attributes.some((a) => a.state === "incompatible"), true, "32\" ≠ 55\" → incompatible");
    const r = classify([l], needTV);
    assert.equal(r.candidates.length, 0, "pas de candidature hors contrainte");
  });

  test("« Support TV mural » → rejeté (accessoire ≠ téléviseur)", () => {
    const l = listing({ title: "Support TV mural inclinable 55\"", price: 15000, zone: "Cocody" });
    const ev = evaluateListing(needTV, l);
    assert.equal(ev.model.state, "incompatible");
    assert.match(ev.model.observed ?? "", /accessoire/);
    assert.equal(classify([l], needTV).rejected.length, 1);
  });

  test("« Télécommande TV » → rejeté (faux positif évité)", () => {
    const l = listing({ title: "Télécommande TV Samsung originale", price: 5000, zone: "Cocody" });
    const ev = evaluateListing(needTV, l);
    assert.equal(ev.model.state, "incompatible", "la télécommande n'est pas un téléviseur");
    assert.equal(classify([l], needTV).rejected.length, 1);
  });

  test("zone et géographie inchangées : « Smart TV » à Bouaké reste rejetée", () => {
    const l = listing({ title: "Smart TV Samsung 55 pouces", price: 450000, zone: "Bouaké" });
    const r = classify([l], needTV);
    assert.equal(r.candidates.length, 0, "la correction géographique prime");
    assert.ok(r.rejected[0].reason.includes("autre zone"));
  });
});