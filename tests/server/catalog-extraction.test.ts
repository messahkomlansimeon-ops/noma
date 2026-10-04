import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  AI_EXTRACTOR_VERSION,
  CATALOG_EXTRACTION_CONTRACT_VERSION,
  CatalogExtractionConfigurationError,
  CatalogExtractionValidationError,
  DETERMINISTIC_EXTRACTOR_VERSION,
  extractCatalogProposal,
  type CatalogAiExtractor,
  type CatalogExtractionInput,
  type CatalogExtractionProposal,
} from "../../lib/server/catalog-extraction";

function extract(
  type: "offer",
  rawText: string,
): Promise<Extract<CatalogExtractionProposal, { type: "offer" }>>;
function extract(
  type: "demand",
  rawText: string,
): Promise<Extract<CatalogExtractionProposal, { type: "demand" }>>;
async function extract(type: CatalogExtractionInput["type"], rawText: string) {
  return extractCatalogProposal({ type, rawText }) as Promise<CatalogExtractionProposal>;
}

describe("extraction catalogue déterministe hors ligne", () => {
  test("exemples iPhone offre et demande : proposition structurée avec preuves", async () => {
    const offerText = "iPhone 12 Pro 128 Go, très bon état, quantité 2, 150 000 FCFA à Cocody, avant le 31/12/2026";
    const offer = await extract("offer", offerText);
    assert.equal(offer.contractVersion, CATALOG_EXTRACTION_CONTRACT_VERSION);
    assert.equal(offer.extractorVersion, DETERMINISTIC_EXTRACTOR_VERSION);
    assert.equal(offer.provenance, "deterministic");
    assert.equal(offer.rawText, offerText);
    assert.equal(offer.fields.category, "phones");
    assert.equal(offer.fields.brand, "Apple");
    assert.equal(offer.fields.model, "iphone 12");
    assert.equal(offer.fields.variant, "pro");
    assert.equal(offer.fields.condition, "very_good");
    assert.equal(offer.fields.quantity, 2);
    assert.equal(offer.fields.location, "cocody");
    assert.equal(offer.fields.deadlineAt, "2026-12-31T00:00:00.000Z");
    assert.deepEqual(offer.fields.price, { amount: 150_000, currency: "XOF" });
    assert.deepEqual(offer.fields.attributes, [{
      key: "storage_capacity",
      value: 128,
      unit: "GB",
      sourceUnit: "Go",
    }]);
    for (const field of ["model", "variant", "condition", "quantity", "price", "location", "deadlineAt"]) {
      assert.ok(offer.evidence.some((item) => item.field === field), `preuve absente : ${field}`);
    }

    const demandText = "Je cherche un iPhone 12 Pro 128 Go en bon état à Cocody, budget maximum 150 000 FCFA, sans troc, de préférence avec chargeur";
    const demand = await extract("demand", demandText);
    assert.equal(demand.fields.model, "iphone 12");
    assert.equal(demand.fields.condition, "good");
    assert.deepEqual(demand.fields.budget, { amount: 150_000, currency: "XOF" });
    assert.deepEqual(demand.fields.requirements, [{
      key: "troc",
      operator: "excludes",
      value: "troc",
    }]);
    assert.deepEqual(demand.fields.preferences, [{
      key: "chargeur",
      operator: "includes",
      value: "chargeur",
    }]);
  });

  test("modèles proches, variantes, unités et négations restent distincts", async () => {
    const closeVariant = await extract("offer", "Apple iPhone 12 Pro Max 256 GB comme neuf");
    assert.equal(closeVariant.fields.model, "iphone 12");
    assert.equal(closeVariant.fields.variant, "pro max");
    assert.equal(closeVariant.fields.quantity, null);
    assert.deepEqual(closeVariant.fields.attributes?.[0], {
      key: "storage_capacity",
      value: 256,
      unit: "GB",
      sourceUnit: "GB",
    });

    const models = await extract("demand", "iPhone 12 ou iPhone 13 à Abidjan");
    assert.equal(models.fields.model, null);
    assert.equal(models.fields.variant, null);
    assert.ok(models.ambiguities.some((item) => item.code === "multiple_models"));

    const variants = await extract("demand", "iPhone 12 Pro ou iPhone 12 Pro Max");
    assert.equal(variants.fields.model, "iphone 12");
    assert.equal(variants.fields.variant, null);
    assert.ok(variants.ambiguities.some((item) => item.code === "multiple_variants"));

    const tv = await extract("offer", "Téléviseur 55 pouces à Abidjan");
    assert.equal(tv.fields.category, "televisions");
    assert.equal(tv.fields.price, null, "55 pouces ne devient pas un prix");
    assert.deepEqual(tv.fields.attributes?.[0], {
      key: "screen_size",
      value: 55,
      unit: "in",
      sourceUnit: "pouces",
    });

    const climate = await extract("offer", "Climatiseur 12 000 BTU, 1500 W à Marcory");
    assert.equal(climate.fields.price, null, "BTU et watts ne deviennent pas un prix");
    assert.deepEqual(climate.fields.attributes?.map((item) => [item.key, item.value, item.unit]), [
      ["cooling_capacity", 12_000, "BTU"],
      ["power", 1_500, "W"],
    ]);

    const negated = await extract("offer", "iPhone 12 pas neuf, sans chargeur");
    assert.equal(negated.fields.condition, null);
    assert.ok(negated.ambiguities.some((item) => item.code === "negated_value"));
    assert.deepEqual(negated.fields.attributes?.find((item) => item.key === "charger_included"), {
      key: "charger_included",
      value: false,
      unit: null,
      sourceUnit: null,
    });
    assert.equal("requirements" in negated.fields, false, "une offre ne crée pas de contrainte acheteur");
  });

  test("régressions : négations, alternatives et occurrence exacte des mesures", async () => {
    const warranty = await extract("offer", "iPhone 12 sans garantie");
    assert.deepEqual(warranty.fields.attributes?.find((item) => item.key === "warranty_mentioned"), {
      key: "warranty_mentioned",
      value: false,
      unit: null,
      sourceUnit: null,
    });
    assert.ok(warranty.evidence.some((item) =>
      item.field.startsWith("attributes.") && item.quote === "sans garantie"));

    const negatedModel = await extract("offer", "Samsung disponible, pas un iPhone 12");
    assert.equal(negatedModel.fields.brand, "Samsung");
    assert.equal(negatedModel.fields.model, null);
    assert.ok(!negatedModel.evidence.some((item) => item.quote === "iPhone 12"));

    for (const separator of ["et", "ou", ","] as const) {
      const models = await extract("offer", `iPhone 12 ${separator} iPhone 13`);
      assert.equal(models.fields.model, null);
      assert.ok(models.ambiguities.some((item) => item.code === "multiple_models"));
    }
    const compactModel = await extract("offer", "iPhone12 128 Go");
    assert.equal(compactModel.fields.model, "iphone 12");
    assert.equal(compactModel.fields.category, "phones");
    assert.equal(compactModel.fields.brand, "Apple");
    const negatedVariant = await extract("offer", "pas un iPhone 12 Pro, iPhone 12");
    assert.equal(negatedVariant.fields.model, "iphone 12");
    assert.equal(negatedVariant.fields.variant, null);
    assert.ok(!negatedVariant.ambiguities.some((item) => item.field === "variant"));

    const capacities = await extract("demand", "iPhone 12 128 Go ou 256 Go");
    assert.equal(capacities.fields.attributes, null);
    assert.deepEqual(
      capacities.ambiguities.find((item) => item.code === "multiple_capacities")?.evidence,
      ["128 Go", "256 Go"],
    );
    const absentCapacity = await extract("demand", "iPhone 12 sans capacité précisée");
    assert.equal(absentCapacity.fields.attributes, null);
    assert.ok(!absentCapacity.ambiguities.some((item) => item.code === "multiple_capacities"));

    const singleCapacity = await extract("offer", "stockage : 128 gigaoctets");
    assert.deepEqual(singleCapacity.fields.attributes, [{
      key: "storage_capacity",
      value: 128,
      unit: "GB",
      sourceUnit: "gigaoctets",
    }]);
    assert.equal(singleCapacity.evidence.find((item) => item.field === "attributes.0")?.quote, "128 gigaoctets");

    const terabyte = await extract("offer", "stockage : 1 téraoctet");
    assert.deepEqual(terabyte.fields.attributes, [{
      key: "storage_capacity",
      value: 1_024,
      unit: "GB",
      sourceUnit: "téraoctet",
    }]);

    const mileage = await extract("offer", "Voiture Toyota 120000 km");
    assert.equal(mileage.fields.price, null);
    assert.deepEqual(mileage.fields.attributes, [{
      key: "mileage",
      value: 120_000,
      unit: "km",
      sourceUnit: "km",
    }]);

    const volume = await extract("offer", "Réfrigérateur 350 litres");
    assert.deepEqual(volume.fields.attributes, [{
      key: "volume",
      value: 350,
      unit: "L",
      sourceUnit: "litres",
    }]);

    const priced = await extract("offer", "Voiture Toyota prix 120000 FCFA");
    assert.deepEqual(priced.fields.price, { amount: 120_000, currency: "XOF" });
  });

  test("frontières numériques et apostrophes conservent le sens et le nombre complet", async () => {
    for (const rawText of ["Pas d'iPhone 12", "Pas d’iPhone 12"]) {
      const negated = await extract("demand", rawText);
      assert.equal(negated.fields.category, null);
      assert.equal(negated.fields.brand, null);
      assert.equal(negated.fields.model, null);
      assert.equal(negated.evidence.length, 0);
    }

    const positiveModel = await extract("demand", "iPhone 12");
    assert.equal(positiveModel.fields.model, "iphone 12");

    for (const decimal of ["1,5", "1.5", "+1,5"] as const) {
      const storage = await extract("offer", `SSD ${decimal} To`);
      assert.deepEqual(storage.fields.attributes, [{
        key: "storage_capacity",
        value: 1_536,
        unit: "GB",
        sourceUnit: "To",
      }]);
      assert.equal(storage.evidence.find((item) => item.field === "attributes.0")?.quote, `${decimal} To`);
    }

    const oneTerabyte = await extract("offer", "SSD 1 To");
    assert.equal(oneTerabyte.fields.attributes?.[0]?.value, 1_024);
    const fiveGigabytes = await extract("offer", "5 Go");
    assert.equal(fiveGigabytes.fields.attributes?.[0]?.value, 5);

    for (const rawText of ["Mémoire -5 Go", "SSD -1,5 To", "SSD 1,2,3 To", "SSD 1 024 Go", "Mémoire --5 Go"]) {
      const invalid = await extract("offer", rawText);
      assert.equal(invalid.fields.attributes, null, rawText);
      assert.ok(invalid.ambiguities.some((item) => item.code === "invalid_numeric_measurement"), rawText);
    }

    const negatedBudget = await extract("demand", "Je ne paie pas 200000 FCFA");
    assert.equal(negatedBudget.fields.budget, null);
    assert.ok(!negatedBudget.evidence.some((item) => item.field === "budget"));
    const refusedBudget = await extract("demand", "Pas de budget 200000 FCFA");
    assert.equal(refusedBudget.fields.budget, null);
    const budget = await extract("demand", "budget 200000 FCFA");
    assert.deepEqual(budget.fields.budget, { amount: 200_000, currency: "XOF" });
    const signedBudget = await extract("demand", "budget -200000 FCFA");
    assert.equal(signedBudget.fields.budget, null);
    assert.ok(signedBudget.ambiguities.some((item) => item.code === "invalid_numeric_amount"));
    const decimalBudget = await extract("demand", "budget 1,5 FCFA");
    assert.equal(decimalBudget.fields.budget, null);
    assert.ok(decimalBudget.ambiguities.some((item) => item.code === "invalid_numeric_amount"));
  });

  test("prix et budgets absents, sans devise ou multiples restent inconnus/ambigus", async () => {
    const absent = await extract("offer", "iPhone 12 128 Go à Cocody");
    assert.equal(absent.fields.price, null);

    const currencyMissing = await extract("offer", "iPhone 12 prix 135000");
    assert.deepEqual(currencyMissing.fields.price, { amount: 135_000, currency: null });
    assert.ok(currencyMissing.ambiguities.some((item) => item.code === "currency_missing"));

    const explicitUsd = await extract("offer", "Laptop à 800 USD");
    assert.deepEqual(explicitUsd.fields.price, { amount: 800, currency: "USD" });

    const multiple = await extract("offer", "iPhone 12, 120 000 FCFA ou 135 000 FCFA");
    assert.equal(multiple.fields.price, null);
    assert.ok(multiple.ambiguities.some((item) => item.code === "multiple_amounts"));

    const demandAbsent = await extract("demand", "Je cherche un canapé à Cocody");
    assert.equal(demandAbsent.fields.budget, null);
    const demandMultiple = await extract("demand", "Canapé, budget 100 000 ou 150 000");
    assert.equal(demandMultiple.fields.budget, null);
    assert.ok(demandMultiple.ambiguities.some((item) => item.code === "multiple_amounts"));
  });

  test("quantité seulement explicite et catégories non téléphoniques", async () => {
    const explicit = await extract("demand", "Je cherche un lot de 3 chaises à Cocody");
    assert.equal(explicit.fields.quantity, 3);
    assert.equal(explicit.fields.category, "furniture");

    const unknown = await extract("offer", "iPhone 18 512 Go disponible");
    assert.equal(unknown.fields.quantity, null, "modèle et capacité ne deviennent pas une quantité");
    assert.equal(unknown.fields.model, "iphone 18");

    const vehicleYear = await extract("offer", "Voiture Toyota modèle 2024");
    assert.equal(vehicleYear.fields.category, "vehicles");
    assert.equal(vehicleYear.fields.price, null, "une année de modèle ne devient pas un prix");

    const shoes = await extract("demand", "Chaussures pointure 42 à Yopougon");
    assert.equal(shoes.fields.category, "fashion");
    assert.deepEqual(shoes.fields.attributes?.[0], {
      key: "shoe_size",
      value: 42,
      unit: null,
      sourceUnit: "pointure",
    });
  });

  test("les quantités utilisent le nombre complet signé et les bornes INTEGER", async () => {
    for (const rawText of [
      "quantité 2.5",
      "quantité 2,5",
      "Lot de 2,5 unités",
      "-5 unités",
      "- 5 unités",
      "quantité 2,5,7",
      "quantité 0",
      "2147483648 unités",
    ]) {
      const result = await extract("offer", rawText);
      assert.equal(result.fields.quantity, null, rawText);
      assert.ok(result.ambiguities.some((item) => item.code === "invalid_numeric_quantity"), rawText);
      assert.ok(!result.evidence.some((item) => item.field === "quantity"), rawText);
    }

    const prefixed = await extract("offer", "lot de 2");
    assert.equal(prefixed.fields.quantity, 2);
    assert.equal(prefixed.evidence.find((item) => item.field === "quantity")?.quote, "lot de 2");

    const suffixed = await extract("offer", "2 unités");
    assert.equal(suffixed.fields.quantity, 2);
    assert.equal(suffixed.evidence.find((item) => item.field === "quantity")?.quote, "2 unités");

    assert.equal((await extract("offer", "quantité 1")).fields.quantity, 1);
    assert.equal((await extract("offer", "2147483647 unités")).fields.quantity, 2_147_483_647);
  });

  test("les quantités valident le lexème entier avant toute sous-occurrence", async () => {
    const invalidLexemes = [
      "-5",
      "- 5",
      "--5",
      "-- 5",
      "- - 5",
      "++5",
      "++ 5",
      "+ + 5",
      "2.5",
      "2,5",
      "2..5",
      "2,,5",
      "2.,5",
      "2,.5",
      "2...5",
      "2,,,5",
      "2.5,7",
      "2,5.7",
      "0",
      "2147483648",
    ];
    const invalid = invalidLexemes.flatMap((lexeme) => [
      `quantité ${lexeme}`,
      `${lexeme} unités`,
    ]);
    for (const rawText of invalid) {
      const result = await extract("offer", rawText);
      assert.equal(result.fields.quantity, null, rawText);
      assert.ok(result.ambiguities.some((item) => item.code === "invalid_numeric_quantity"), rawText);
      assert.ok(!result.evidence.some((item) => item.field === "quantity"), rawText);
    }

    const validLexemes = [
      { lexeme: "+5", expected: 5 },
      { lexeme: "+ 5", expected: 5 },
      { lexeme: "1", expected: 1 },
      { lexeme: "2", expected: 2 },
      { lexeme: "2147483647", expected: 2_147_483_647 },
    ];
    const valid = validLexemes.flatMap(({ lexeme, expected }) => [
      { rawText: `quantité ${lexeme}`, expected },
      { rawText: `${lexeme} unités`, expected },
    ]).concat([
      { rawText: "quantité 2, produit disponible", expected: 2 },
      { rawText: "quantité 2.", expected: 2 },
      { rawText: "quantité 2; produit disponible", expected: 2 },
      { rawText: "2 unités.", expected: 2 },
      { rawText: "2 unités, disponibles", expected: 2 },
    ]);
    for (const { rawText, expected } of valid) {
      const result = await extract("offer", rawText);
      assert.equal(result.fields.quantity, expected, rawText);
      assert.ok(!result.ambiguities.some((item) => item.field === "quantity"), rawText);
    }
  });

  test("le mode déterministe n'appelle jamais l'interface IA", async () => {
    let calls = 0;
    const ai: CatalogAiExtractor = {
      async extract() {
        calls += 1;
        throw new Error("ne doit pas être appelée");
      },
    };
    const result = await extractCatalogProposal(
      { type: "offer", rawText: "Table 6 places" },
      { ai },
    );
    assert.equal(result.provenance, "deterministic");
    assert.equal(calls, 0);
  });
});

describe("sorties IA injectées et non fiables", () => {
  test("une suggestion prouvée enrichit seulement un champ inconnu", async () => {
    const ai: CatalogAiExtractor = {
      async extract() {
        return {
          fields: { category: "cosmetique" },
          evidence: [{ field: "category", quote: "cosmetique" }],
          ambiguities: [],
        };
      },
    };
    const result = await extractCatalogProposal(
      { type: "offer", rawText: "cosmetique naturel" },
      { mode: "ai", ai },
    );
    assert.equal(result.provenance, "ai");
    assert.equal(result.extractorVersion, AI_EXTRACTOR_VERSION);
    assert.equal(result.fields.category, "cosmetique");
  });

  test("champs techniques, contradiction et absence de preuve sont refusés", async () => {
    const cases: unknown[] = [
      {
        fields: { ownerId: "00000000-0000-4000-8000-000000000000" },
        evidence: [],
      },
      {
        fields: { category: "telephone" },
        evidence: [{ field: "category", quote: "telephone" }],
      },
      {
        fields: { brand: "Apple" },
        evidence: [{ field: "brand", quote: "telephone" }],
      },
      {
        fields: { status: "published" },
        evidence: [],
      },
      {
        fields: {},
        evidence: [{ field: "ownerId", quote: "telephone" }],
      },
      {
        fields: { quantity: 12 },
        evidence: [{ field: "quantity", quote: "iPhone 12" }],
      },
      {
        fields: { price: { amount: 128, currency: null } },
        evidence: [{ field: "price", quote: "128 Go" }],
      },
      {
        fields: {
          attributes: [{
            key: "storage_capacity",
            value: 12,
            unit: "GB",
            sourceUnit: null,
          }],
        },
        evidence: [{ field: "attributes.0", quote: "iPhone 12" }],
      },
    ];
    for (const raw of cases) {
      await assert.rejects(
        extractCatalogProposal(
          { type: "offer", rawText: "telephone iPhone 12 128 Go" },
          { mode: "ai", ai: { async extract() { return raw; } } },
        ),
        CatalogExtractionValidationError,
      );
    }
  });

  test("valeurs niées, tailles excessives et fournisseur absent sont refusés", async () => {
    await assert.rejects(
      extractCatalogProposal(
        { type: "demand", rawText: "Je cherche un frigo sans congélateur" },
        {
          mode: "ai",
          ai: {
            async extract() {
              return {
                fields: {
                  requirements: [{ key: "congelateur", operator: "includes", value: "congélateur" }],
                },
                evidence: [{ field: "requirements.0", quote: "sans congélateur" }],
              };
            },
          },
        },
      ),
      CatalogExtractionValidationError,
    );
    await assert.rejects(
      extractCatalogProposal(
        { type: "offer", rawText: "objet artisanal" },
        {
          mode: "ai",
          ai: {
            async extract() {
              return {
                fields: { brand: "x".repeat(121) },
                evidence: [{ field: "brand", quote: "objet" }],
              };
            },
          },
        },
      ),
      CatalogExtractionValidationError,
    );
    await assert.rejects(
      extractCatalogProposal(
        { type: "offer", rawText: "objet" },
        { mode: "ai" },
      ),
      CatalogExtractionConfigurationError,
    );
  });

  test("les preuves IA lient nombre complet, unité, conversion et contexte original", async () => {
    const rejected: Array<{ type: "offer" | "demand"; rawText: string; suggestion: unknown }> = [
      {
        type: "offer",
        rawText: "stockage : 128",
        suggestion: {
          fields: { attributes: [{ key: "storage_capacity", value: 28, unit: null, sourceUnit: null }] },
          evidence: [{ field: "attributes.0", quote: "stockage : 128" }],
        },
      },
      {
        type: "offer",
        rawText: "stockage : 128 gigaoctets",
        suggestion: {
          fields: { attributes: [{ key: "storage_capacity", value: 128, unit: "TB", sourceUnit: "gigaoctets" }] },
          evidence: [{ field: "attributes.0", quote: "stockage : 128 gigaoctets" }],
        },
      },
      {
        type: "offer",
        rawText: "stockage : 128 Go",
        suggestion: {
          fields: { attributes: [{ key: "storage_capacity", value: 128, unit: "GB", sourceUnit: "go" }] },
          evidence: [{ field: "attributes.0", quote: "stockage : 128 Go" }],
        },
      },
      {
        type: "offer",
        rawText: "stockage : pas 128 Go",
        suggestion: {
          fields: { attributes: [{ key: "storage_capacity", value: 128, unit: "GB", sourceUnit: "Go" }] },
          evidence: [{ field: "attributes.0", quote: "128 Go" }],
        },
      },
      {
        type: "demand",
        rawText: "Je cherche un frigo sans congélateur",
        suggestion: {
          fields: { requirements: [{ key: "congelateur", operator: "includes", value: "congélateur" }] },
          evidence: [{ field: "requirements.0", quote: "congélateur" }],
        },
      },
      {
        type: "offer",
        rawText: "iPhone sans garantie",
        suggestion: {
          fields: { attributes: [{ key: "warranty_mentioned", value: true, unit: null, sourceUnit: null }] },
          evidence: [{ field: "attributes.0", quote: "garantie" }],
        },
      },
      {
        type: "offer",
        rawText: "volume 128 litres, référence 28",
        suggestion: {
          fields: { attributes: [{ key: "volume", value: 28, unit: "L", sourceUnit: "litres" }] },
          evidence: [{ field: "attributes.0", quote: "volume 128 litres" }],
        },
      },
    ];
    for (const item of rejected) {
      await assert.rejects(
        extractCatalogProposal(
          { type: item.type, rawText: item.rawText },
          { mode: "ai", ai: { async extract() { return item.suggestion; } } },
        ),
        CatalogExtractionValidationError,
      );
    }

    const exact = await extractCatalogProposal(
      { type: "offer", rawText: "stockage : 128 gigaoctets" },
      {
        mode: "ai",
        ai: {
          async extract() {
            return {
              fields: { attributes: [{ key: "storage_capacity", value: 128, unit: "GB", sourceUnit: "gigaoctets" }] },
              evidence: [{ field: "attributes.0", quote: "128 gigaoctets" }],
            };
          },
        },
      },
    );
    assert.equal(exact.fields.attributes?.[0]?.value, 128);

    const converted = await extractCatalogProposal(
      { type: "offer", rawText: "stockage : 1 téraoctet" },
      {
        mode: "ai",
        ai: {
          async extract() {
            return {
              fields: { attributes: [{ key: "storage_capacity", value: 1_024, unit: "GB", sourceUnit: "téraoctet" }] },
              evidence: [{ field: "attributes.0", quote: "1 téraoctet" }],
            };
          },
        },
      },
    );
    assert.equal(converted.fields.attributes?.[0]?.value, 1_024);

    const exclusion = await extractCatalogProposal(
      { type: "demand", rawText: "Je cherche un frigo sans congélateur" },
      {
        mode: "ai",
        ai: {
          async extract() {
            return {
              fields: { requirements: [{ key: "congelateur", operator: "excludes", value: "congélateur" }] },
              evidence: [{ field: "requirements.0", quote: "congélateur" }],
            };
          },
        },
      },
    );
    assert.equal(exclusion.type, "demand");
    if (exclusion.type !== "demand") assert.fail("une demande doit rester une demande");
    assert.equal(exclusion.fields.requirements?.[0]?.operator, "excludes");
  });

  test("l'IA ne tranche pas une ambiguïté déterministe", async () => {
    const cases = [
      {
        rawText: "iPhone 12 ou iPhone 13",
        fields: { model: "iphone 12" },
        evidence: [{ field: "model", quote: "iPhone 12" }],
      },
      {
        rawText: "iPhone 12 128 Go ou 256 Go",
        fields: { attributes: [{ key: "storage_capacity", value: 128, unit: "GB", sourceUnit: "Go" }] },
        evidence: [{ field: "attributes.0", quote: "128 Go" }],
      },
    ];
    for (const item of cases) {
      await assert.rejects(
        extractCatalogProposal(
          { type: "demand", rawText: item.rawText },
          { mode: "ai", ai: { async extract() { return item; } } },
        ),
        CatalogExtractionValidationError,
      );
    }
  });

  test("l'IA ne rétablit ni négation tronquée ni nombre partiel", async () => {
    const rejected: Array<{ type: "offer" | "demand"; rawText: string; suggestion: unknown }> = [
      ...["Pas d'iPhone 12", "Pas d’iPhone 12"].map((rawText) => ({
        type: "demand" as const,
        rawText,
        suggestion: {
          fields: { model: "iphone 12" },
          evidence: [{ field: "model", quote: "iPhone 12" }],
        },
      })),
      {
        type: "demand",
        rawText: "Je ne paie pas 200000 FCFA",
        suggestion: {
          fields: { budget: { amount: 200_000, currency: "XOF" } },
          evidence: [{ field: "budget", quote: "200000 FCFA" }],
        },
      },
      {
        type: "offer",
        rawText: "SSD 1,5 To",
        suggestion: {
          fields: { attributes: [{ key: "storage_capacity", value: 5_120, unit: "GB", sourceUnit: "To" }] },
          evidence: [{ field: "attributes.0", quote: "5 To" }],
        },
      },
      {
        type: "offer",
        rawText: "Mémoire -5 Go",
        suggestion: {
          fields: { attributes: [{ key: "storage_capacity", value: 5, unit: "GB", sourceUnit: "Go" }] },
          evidence: [{ field: "attributes.0", quote: "5 Go" }],
        },
      },
      {
        type: "demand",
        rawText: "budget 1,5 FCFA",
        suggestion: {
          fields: { budget: { amount: 5, currency: "XOF" } },
          evidence: [{ field: "budget", quote: "5 FCFA" }],
        },
      },
    ];
    for (const item of rejected) {
      await assert.rejects(
        extractCatalogProposal(
          { type: item.type, rawText: item.rawText },
          { mode: "ai", ai: { async extract() { return item.suggestion; } } },
        ),
        CatalogExtractionValidationError,
      );
    }

    const decimal = await extractCatalogProposal(
      { type: "offer", rawText: "SSD 1.5 To" },
      {
        mode: "ai",
        ai: {
          async extract() {
            return {
              fields: { attributes: [{ key: "storage_capacity", value: 1_536, unit: "GB", sourceUnit: "To" }] },
              evidence: [{ field: "attributes.0", quote: "1.5 To" }],
            };
          },
        },
      },
    );
    assert.equal(decimal.fields.attributes?.[0]?.value, 1_536);

    const budget = await extractCatalogProposal(
      { type: "demand", rawText: "budget 200000 FCFA" },
      {
        mode: "ai",
        ai: {
          async extract() {
            return {
              fields: { budget: { amount: 200_000, currency: "XOF" } },
              evidence: [{ field: "budget", quote: "200000 FCFA" }],
            };
          },
        },
      },
    );
    assert.equal(budget.type, "demand");
    if (budget.type !== "demand") assert.fail("une demande doit rester une demande");
    assert.equal(budget.fields.budget?.amount, 200_000);
  });

  test("les preuves IA de quantité restent liées au nombre original complet", async () => {
    const rejected = [
      { rawText: "quantité 2.5", quantity: 2, quote: "quantité 2" },
      { rawText: "quantité 2,5", quantity: 2, quote: "quantité 2" },
      { rawText: "-5 unités", quantity: 5, quote: "5 unités" },
      { rawText: "- 5 unités", quantity: 5, quote: "5 unités" },
      { rawText: "quantité 2..5", quantity: 2, quote: "quantité 2" },
      { rawText: "quantité 2,,5", quantity: 2, quote: "quantité 2" },
      { rawText: "quantité 2.,5", quantity: 5, quote: "5" },
      { rawText: "2..5 unités", quantity: 5, quote: "5 unités" },
      { rawText: "2,.5 unités", quantity: 5, quote: "5 unités" },
      { rawText: "--5 unités", quantity: 5, quote: "5 unités" },
      { rawText: "-- 5 unités", quantity: 5, quote: "5 unités" },
      { rawText: "- - 5 unités", quantity: 5, quote: "5 unités" },
      { rawText: "2147483648 unités", quantity: 147_483_648, quote: "147483648 unités" },
    ];
    for (const item of rejected) {
      await assert.rejects(
        extractCatalogProposal(
          { type: "offer", rawText: item.rawText },
          {
            mode: "ai",
            ai: {
              async extract() {
                return {
                  fields: { quantity: item.quantity },
                  evidence: [{ field: "quantity", quote: item.quote }],
                };
              },
            },
          },
        ),
        CatalogExtractionValidationError,
      );
    }

    for (const item of [
      { rawText: "lot de 2", quantity: 2, quote: "lot de 2" },
      { rawText: "2 unités", quantity: 2, quote: "2 unités" },
      { rawText: "2147483647 unités", quantity: 2_147_483_647, quote: "2147483647 unités" },
    ]) {
      const result = await extractCatalogProposal(
        { type: "offer", rawText: item.rawText },
        {
          mode: "ai",
          ai: {
            async extract() {
              return {
                fields: { quantity: item.quantity },
                evidence: [{ field: "quantity", quote: item.quote }],
              };
            },
          },
        },
      );
      assert.equal(result.fields.quantity, item.quantity);
    }
  });

  test("l'entrée brute est bornée sans altérer le texte valide", async () => {
    await assert.rejects(
      extractCatalogProposal({ type: "offer", rawText: "é".repeat(16_385) }),
      CatalogExtractionValidationError,
    );
    const rawText = "  Table en bois  ";
    const result = await extractCatalogProposal({ type: "offer", rawText });
    assert.equal(result.rawText, rawText);
  });
});
