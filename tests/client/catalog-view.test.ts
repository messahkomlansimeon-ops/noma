import assert from "node:assert/strict";
import { describe, test } from "node:test";
import * as catalogView from "../../lib/client/catalog-view";
import type { DemandRecord, OfferRecord, OfferStatus } from "../../lib/client/api";
import {
  CATEGORY_OPTIONS,
  DEMAND_FILTERS,
  DEMAND_STATUS_VIEW,
  OFFER_FILTERS,
  OFFER_STATUS_VIEW,
  artForCategory,
  buildDemandInput,
  buildOfferInput,
  countOffers,
  deadlineToIso,
  demandActions,
  demandSummary,
  filterDemands,
  filterOffers,
  formatAmount,
  formatMoney,
  newestFirst,
  offerActions,
  offerSummary,
  recordTitle,
  replaceRecord,
} from "../../lib/client/catalog-view";

function offer(id: string, status: OfferStatus, createdAt = "2031-01-01T10:00:00.000Z"): OfferRecord {
  return {
    id,
    status,
    rawText: "iPhone 12",
    category: "Téléphones",
    brand: "Apple",
    model: "iPhone 12",
    variant: "128 Go",
    attributes: null,
    condition: "Occasion",
    quantity: null,
    unit: null,
    location: "Abidjan",
    deadlineAt: null,
    contentVersion: 1,
    createdAt,
    updatedAt: createdAt,
    archivedAt: null,
    price: { amount: 150000, currency: "XOF" },
    availabilityStatus: "available",
  };
}

describe("formats", () => {
  test("formatAmount groupe les milliers par espace insécable", () => {
    assert.equal(formatAmount(0), "0");
    assert.equal(formatAmount(999), "999");
    assert.equal(formatAmount(150000), "150 000");
    assert.equal(formatAmount(1234567), "1 234 567");
  });

  test("formatMoney : XOF s'affiche FCFA, autre devise inchangée, null → null", () => {
    assert.equal(formatMoney({ amount: 150000, currency: "XOF" }), "150 000 FCFA");
    assert.equal(formatMoney({ amount: 20, currency: "EUR" }), "20 EUR");
    assert.equal(formatMoney(null), null);
  });

  test("recordTitle : première ligne non vide, sinon marque et modèle, tronquée à 80", () => {
    const base = { rawText: "", brand: null, model: null, variant: null };
    assert.equal(recordTitle({ ...base, rawText: "\n  iPhone 12 128 Go  \n\nBon état" }), "iPhone 12 128 Go");
    assert.equal(recordTitle({ ...base, rawText: "   ", brand: "Apple", model: "iPhone 12" }), "Apple iPhone 12");
    assert.equal(recordTitle(base), "Sans titre");
    const long = recordTitle({ ...base, rawText: "x".repeat(200) });
    assert.equal(long.length, 80);
    assert.ok(long.endsWith("…"));
  });

  test("artForCategory ignore casse et accents, repli sur box", () => {
    assert.equal(artForCategory("Téléphones"), "phone");
    assert.equal(artForCategory("telephones"), "phone");
    assert.equal(artForCategory("VÉHICULES"), "car");
    assert.equal(artForCategory("Inconnue"), "box");
    assert.equal(artForCategory(null), "box");
    assert.ok(CATEGORY_OPTIONS.length >= 6);
  });
});

describe("statuts et actions : exactement les transitions du serveur", () => {
  test("annonce : brouillon → publier ; en ligne → pause ; en pause → remettre en ligne ; archivée → rien", () => {
    assert.deepEqual(offerActions("draft").map((a) => a.action), ["publish", "archive"]);
    assert.deepEqual(offerActions("published").map((a) => a.action), ["pause", "archive"]);
    assert.deepEqual(offerActions("paused").map((a) => a.action), ["publish", "archive"]);
    assert.deepEqual(offerActions("archived"), []);
    assert.equal(offerActions("paused")[0].label, "Remettre en ligne");
  });

  test("besoin : brouillon → activer ; actif → satisfait ; satisfait → réactiver ; archivé → rien", () => {
    assert.deepEqual(demandActions("draft").map((a) => a.action), ["activate", "archive"]);
    assert.deepEqual(demandActions("active").map((a) => a.action), ["satisfy", "archive"]);
    assert.deepEqual(demandActions("satisfied").map((a) => a.action), ["activate", "archive"]);
    assert.deepEqual(demandActions("archived"), []);
    assert.equal(demandActions("satisfied")[0].label, "Réactiver");
  });

  test("libellés de statut en français pour les quatre statuts", () => {
    assert.deepEqual(
      (["draft", "published", "paused", "archived"] as const).map((s) => OFFER_STATUS_VIEW[s].label),
      ["Brouillon", "En ligne", "En pause", "Archivée"],
    );
    assert.deepEqual(
      (["draft", "active", "satisfied", "archived"] as const).map((s) => DEMAND_STATUS_VIEW[s].label),
      ["Brouillon", "Active", "Satisfait", "Archivé"],
    );
  });

  test("filtres : « Actives » exclut les archivées, chaque filtre ne garde que son statut", () => {
    const offers = [
      offer("a", "draft"),
      offer("b", "published"),
      offer("c", "published"),
      offer("d", "paused"),
      offer("e", "archived"),
    ];
    assert.deepEqual(filterOffers(offers, "all").map((o) => o.id), ["a", "b", "c", "d"]);
    assert.deepEqual(filterOffers(offers, "published").map((o) => o.id), ["b", "c"]);
    assert.deepEqual(filterOffers(offers, "paused").map((o) => o.id), ["d"]);
    assert.deepEqual(filterOffers(offers, "draft").map((o) => o.id), ["a"]);
    assert.deepEqual(filterOffers(offers, "archived").map((o) => o.id), ["e"]);
    assert.deepEqual(OFFER_FILTERS.map((f) => countOffers(offers, f.id)), [4, 2, 1, 1, 1]);
  });

  test("filtres de besoins : « Actifs » exclut les archivés, chaque filtre ne garde que son statut", () => {
    const demand = (id: string, status: DemandRecord["status"]): DemandRecord => ({
      ...offer(id, "draft"),
      status,
      budget: null,
      requirements: null,
      preferences: null,
    } as unknown as DemandRecord);
    const demands = [
      demand("a", "draft"),
      demand("b", "active"),
      demand("c", "satisfied"),
      demand("d", "archived"),
      demand("e", "active"),
    ];
    assert.deepEqual(filterDemands(demands, "all").map((d) => d.id), ["a", "b", "c", "e"]);
    assert.deepEqual(filterDemands(demands, "active").map((d) => d.id), ["b", "e"]);
    assert.deepEqual(filterDemands(demands, "draft").map((d) => d.id), ["a"]);
    assert.deepEqual(filterDemands(demands, "satisfied").map((d) => d.id), ["c"]);
    assert.deepEqual(filterDemands(demands, "archived").map((d) => d.id), ["d"]);
    assert.deepEqual(DEMAND_FILTERS.map((f) => filterDemands(demands, f.id).length), [4, 2, 1, 1, 1]);
  });

  test("newestFirst et replaceRecord", () => {
    const list = [
      offer("a", "draft", "2031-01-01T10:00:00.000Z"),
      offer("b", "draft", "2031-01-03T10:00:00.000Z"),
      offer("c", "draft", "2031-01-02T10:00:00.000Z"),
    ];
    assert.deepEqual(newestFirst(list).map((o) => o.id), ["b", "c", "a"]);
    assert.deepEqual(list.map((o) => o.id), ["a", "b", "c"], "ne modifie pas la liste d'origine");
    const updated = { ...list[1], status: "published" as const, contentVersion: 2 };
    const replaced = replaceRecord(list, updated);
    assert.equal(replaced[1].status, "published");
    assert.equal(replaced[1].contentVersion, 2);
    assert.equal(replaced[0], list[0]);
  });

  test("résumés de liste", () => {
    assert.equal(offerSummary(offer("a", "draft")), "Apple · iPhone 12 · 128 Go · Occasion · Abidjan");
    const demand = {
      location: "Abidjan",
      condition: "Occasion",
      budget: { amount: 200000, currency: "XOF" },
    } as Pick<DemandRecord, "location" | "budget" | "condition">;
    assert.equal(demandSummary(demand), "Abidjan · Occasion · 200 000 FCFA max");
    assert.equal(demandSummary({ location: null, condition: null, budget: null }), "");
  });
});

describe("buildOfferInput : valeurs du formulaire → corps de POST /api/offers", () => {
  const values = {
    title: "iPhone 12 · 128 Go",
    description: "Écran impeccable.",
    category: "Téléphones",
    brand: " Apple ",
    model: "iPhone 12",
    variant: "128 Go",
    condition: "Occasion",
    location: "Marcory, Abidjan",
    price: "150 000",
    available: true,
  };

  test("cas nominal : texte, structure, prix XOF entier, disponibilité", () => {
    const result = buildOfferInput(values);
    assert.ok(result.ok);
    assert.deepEqual(result.input, {
      rawText: "iPhone 12 · 128 Go\n\nÉcran impeccable.",
      category: "Téléphones",
      brand: "Apple",
      model: "iPhone 12",
      variant: "128 Go",
      condition: "Occasion",
      location: "Marcory, Abidjan",
      price: { amount: 150000, currency: "XOF" },
      availabilityStatus: "available",
    });
  });

  test("champs optionnels vides → null ; prix vide → null ; indisponible → unavailable", () => {
    const result = buildOfferInput({
      ...values,
      description: "  ",
      category: null,
      brand: "",
      model: " ",
      variant: "",
      condition: null,
      location: "",
      price: "",
      available: false,
    });
    assert.ok(result.ok);
    assert.equal(result.input.rawText, "iPhone 12 · 128 Go");
    assert.equal(result.input.category, null);
    assert.equal(result.input.brand, null);
    assert.equal(result.input.model, null);
    assert.equal(result.input.price, null);
    assert.equal(result.input.availabilityStatus, "unavailable");
  });

  test("titre requis, prix illisible refusé avec un message, jamais corrigé en silence", () => {
    const noTitle = buildOfferInput({ ...values, title: "   " });
    assert.ok(!noTitle.ok);
    assert.equal(noTitle.errors.title, "Le titre est requis.");

    const badPrice = buildOfferInput({ ...values, price: "150.5" });
    assert.ok(!badPrice.ok);
    assert.equal(badPrice.errors.price, "Prix « 150.5 » non reconnu. Saisissez un montant en FCFA (ex. 150 000).");

    const both = buildOfferInput({ ...values, title: "", price: "abc" });
    assert.ok(!both.ok);
    assert.deepEqual(Object.keys(both.errors).sort(), ["price", "title"]);
  });

  test("message d'erreur du prix : texte propre au prix, jamais le mot « Budget »", () => {
    for (const text of ["abc", "150.5", "12 34", "beaucoup"]) {
      const result = buildOfferInput({ ...values, price: text });
      assert.ok(!result.ok, text);
      assert.equal(
        result.errors.price,
        `Prix « ${text} » non reconnu. Saisissez un montant en FCFA (ex. 150 000).`,
        text,
      );
      assert.equal(/budget/i.test(result.errors.price), false, text);
    }
    const tooBig = buildOfferInput({ ...values, price: "9999999999999" });
    assert.ok(!tooBig.ok);
    assert.equal(/budget/i.test(tooBig.errors.price), false);
  });

  test("un prix de 0 est refusé par le formulaire (le serveur n'est pas modifié)", () => {
    for (const text of ["0", "0 FCFA", "000", "0k"]) {
      const result = buildOfferInput({ ...values, price: text });
      assert.ok(!result.ok, text);
      assert.equal(result.errors.price, "Le prix doit être supérieur à 0.", text);
    }
    const blank = buildOfferInput({ ...values, price: "   " });
    assert.ok(blank.ok);
    assert.equal(blank.input.price, null);
  });

  test("libellés des filtres : « Actives » / « Actifs » (ils excluent les archivés), uniques", () => {
    assert.equal(OFFER_FILTERS[0].id, "all");
    assert.equal(OFFER_FILTERS[0].label, "Actives");
    assert.equal(DEMAND_FILTERS[0].id, "all");
    assert.equal(DEMAND_FILTERS[0].label, "Actifs");
    for (const filters of [OFFER_FILTERS, DEMAND_FILTERS]) {
      const labels = filters.map((f) => f.label);
      assert.equal(new Set(labels).size, labels.length, labels.join(" / "));
      assert.equal(labels.some((label) => label === "Toutes" || label === "Tous"), false);
    }
  });

  test("liste tronquée : message fixe et compteurs de filtres non affichés", () => {
    const view = catalogView as unknown as {
      LIST_TRUNCATED_MESSAGE?: string;
      countSuffix?: (count: number, truncated: boolean) => string;
    };
    assert.equal(view.LIST_TRUNCATED_MESSAGE, "Liste incomplète : trop d'éléments à afficher.");
    assert.equal(view.countSuffix?.(7, false), " · 7");
    assert.equal(view.countSuffix?.(7, true), "");
  });

  test("prix : formats usuels FCFA acceptés", () => {
    for (const [text, amount] of [["150000", 150000], ["150 000 FCFA", 150000], ["150.000", 150000], ["1", 1]] as const) {
      const result = buildOfferInput({ ...values, price: text });
      assert.ok(result.ok, text);
      assert.equal(result.input.price?.amount, amount, text);
    }
  });
});

describe("buildDemandInput : valeurs du formulaire → corps de POST /api/demands", () => {
  const values = {
    text: "Un iPhone 12 en bon état",
    category: "Téléphones",
    brand: "Apple",
    model: "iPhone 12",
    variant: "",
    condition: "Occasion",
    location: "Abidjan",
    budget: "200 000",
    deadline: "2031-02-15",
  };

  test("cas nominal", () => {
    const result = buildDemandInput(values, "2031-01-01");
    assert.ok(result.ok);
    assert.deepEqual(result.input, {
      rawText: "Un iPhone 12 en bon état",
      category: "Téléphones",
      brand: "Apple",
      model: "iPhone 12",
      variant: null,
      condition: "Occasion",
      location: "Abidjan",
      budget: { amount: 200000, currency: "XOF" },
      deadlineAt: "2031-02-15T23:59:59Z",
    });
  });

  test("texte requis, budget illisible refusé, échéance passée ou invalide refusée", () => {
    const empty = buildDemandInput({ ...values, text: " " }, "2031-01-01");
    assert.ok(!empty.ok);
    assert.equal(empty.errors.text, "Décrivez ce que vous cherchez.");

    const badBudget = buildDemandInput({ ...values, budget: "beaucoup" }, "2031-01-01");
    assert.ok(!badBudget.ok);
    assert.match(badBudget.errors.budget, /^Budget : /);

    const past = buildDemandInput({ ...values, deadline: "2030-12-31" }, "2031-01-01");
    assert.ok(!past.ok);
    assert.equal(past.errors.deadline, "La date doit être aujourd'hui ou plus tard.");

    const invalid = buildDemandInput({ ...values, deadline: "2031-02-30" }, "2031-01-01");
    assert.ok(!invalid.ok);
    assert.equal(invalid.errors.deadline, "Date invalide.");

    const today = buildDemandInput({ ...values, deadline: "2031-01-01" }, "2031-01-01");
    assert.ok(today.ok);
  });

  test("budget et échéance facultatifs", () => {
    const result = buildDemandInput({ ...values, budget: "", deadline: "" }, "2031-01-01");
    assert.ok(result.ok);
    assert.equal(result.input.budget, null);
    assert.equal(result.input.deadlineAt, null);
  });

  test("deadlineToIso : calendrier réel et format ISO strict du serveur", () => {
    assert.equal(deadlineToIso("2031-02-15"), "2031-02-15T23:59:59Z");
    assert.equal(deadlineToIso("2032-02-29"), "2032-02-29T23:59:59Z");
    for (const bad of ["2031-02-29", "2031-13-01", "2031-00-10", "15/02/2031", "2031-2-5", "", "2031-02-15T10:00:00Z"]) {
      assert.equal(deadlineToIso(bad), null, bad);
    }
    assert.match(deadlineToIso("2031-02-15")!, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });
});
