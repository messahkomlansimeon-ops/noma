import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { PHONE_IN_OFFER_MESSAGE, PHONE_MAX_GAP, PHONE_MIN_DIGITS, countDigits, looksLikePhoneNumber, publicFieldText } from "../../lib/phone-text";
import { mapStoredMatchItem } from "../../lib/server/matching/http-dto";
import type { StoredMatchItem } from "../../lib/server/matching/stored-matches";
import type { OfferRecord } from "../../lib/server/catalog/types";
import { requireNoPhoneInOfferFields } from "../../lib/server/catalog/validation";
import { CatalogAttributeKeyError, CatalogPhoneNumberError } from "../../lib/server/catalog/errors";
import { buildNotificationTitle } from "../../lib/server/notifications/content";
import { publicAttributes } from "../../lib/server/metrics/offer-detail";
import * as reexported from "../../lib/server/metrics/public-text";

/**
 * Lot D1, P0 : un numéro de téléphone caché dans une annonce (variante, marque, modèle, attributs) n'est jamais servi à un acheteur et refusé à la publication. La règle :
 * huit chiffres ou plus, séparés par au plus trois caractères non-chiffres (n'importe lesquels), après NFKC et avec les chiffres de tout système d'écriture.
 */

describe("détection d'un numéro de téléphone caché (lib/phone-text.ts)", () => {
  test("décisions : 8 chiffres, 3 caractères d'écart au plus, message clair", () => {
    assert.equal(PHONE_MIN_DIGITS, 8);
    assert.equal(PHONE_MAX_GAP, 3);
    assert.equal(PHONE_IN_OFFER_MESSAGE, "Pas de numéro de téléphone dans l'annonce : l'acheteur vous contactera par noma.");
  });

  test("FAUX NÉGATIFS écartés : tous ces textes sont des numéros (la barre « / » et les deux-points compris, dont l'audit a prouvé le passage)", () => {
    const numbers: Record<string, string> = {
      collé: "0708091011",
      "avec un mot": "WhatsApp 0708091011",
      espaces: "07 08 09 10 11",
      "indicatif": "+225 07 08 09 10 11",
      "indicatif collé": "+2250708091011",
      points: "07.08.09.10.11",
      tirets: "07-08-09-10-11",
      parenthèses: "(07) 08 09 10 11",
      "barre oblique": "07/08/09/10/11",
      "deux-points": "07:08:09:10:11",
      "underscore": "07_08_09_10_11",
      "virgules": "07,08,09,10,11",
      "séparateur de trois caractères": "07 - 08 - 09 - 10 - 11",
      "emoji": "07🙂08🙂09🙂10🙂11",
      "pleine chasse": "０７０８０９１０１１",
      "pleine chasse et espaces larges": "０７　０８　０９　１０　１１",
      "arabes-indiens": "٠٧٠٨٠٩١٠١١",
      "arabes-indiens orientaux avec barres": "۰۷/۰۸/۰۹/۱۰/۱۱",
      "dévanagari": "०७०८०९१०११",
      "exposants": "⁰⁷⁰⁸⁰⁹¹⁰¹¹",
      "mathématiques": "𝟎𝟕𝟎𝟖𝟎𝟗𝟏𝟎𝟏𝟏",
      "mélange de systèmes": "0७٠8０9１0١1",
      "huit chiffres seulement": "07 08 09 10",
      "dans une phrase": "iPhone 12 en parfait état, appelez le 07/08/09/10/11 vite",
      "numéro précédé d'un prix": "150000 FCFA 0708091011",
    };
    for (const [name, text] of Object.entries(numbers)) assert.equal(looksLikePhoneNumber(text), true, `${name} : « ${text} » doit être tenu pour un numéro`);
  });

  test("FAUX POSITIFS écartés : prix, capacités, années, modèles et dimensions ordinaires ne sont pas des numéros", () => {
    const fine = [
      "150 000", "150 000 FCFA", "150000", "1 250 000", "99 000 F", "12 500 000 FCFA".replace("12 ", "1 "),
      "256 Go", "128 Go", "iPhone 12 128 Go", "iPhone 12 128 Go 2024", "Galaxy S21 128 Go", "Galaxy A52 5G 128 Go", "Spark 10", "MacBook Air M1 8 Go 256 Go", "8 Go · 256 Go",
      "2024", "2015-2018", "2019 2021", "Toyota Corolla 2015-2018", "modèles 2019 2020 2021 2022", "année 2021",
      "43 pouces", "12000 BTU", "Split 1,5 CV", "Latitude 5420", "Smart TV 43", "8 kg", "300 L", "XPS 15 9520",
      "2026-10-06", "06/10/2026", "6 octobre 2026", "Pavilion 15", "RTX 3060", "Ryzen 5 5600", "1 To", "5000 mAh", "Noir", "", "Occasion", "Cocody",
    ];
    for (const text of fine) assert.equal(looksLikePhoneNumber(text), false, `« ${text} » ne doit pas être tenu pour un numéro`);
  });

  test("un numéro séparé par plus de trois caractères entre deux chiffres n'est PAS détecté (limite assumée) ; trois caractères le sont encore", () => {
    assert.equal(looksLikePhoneNumber("07 .... 08 .... 09 .... 10 .... 11"), false, "six caractères entre chaque paire : hors de la règle");
    assert.equal(looksLikePhoneNumber("07 .. 08 .. 09 .. 10 .. 11"), false, "quatre caractères (espace, deux points, espace) entre chaque paire : hors de la règle");
    assert.equal(looksLikePhoneNumber("07 . 08 . 09 . 10 . 11"), true, "trois caractères (espace, point, espace) : dans la règle");
  });

  test("une LETTRE seule entre deux groupes de 1 ou 2 chiffres sépare un groupe dans une suite d'au moins 4 groupes (« 07a08b09c10d11 » est refusé depuis le lot D3) ; des lettres dans des groupes longs ne sont pas des séparateurs", () => {
    assert.equal(looksLikePhoneNumber("07a08b09c10d11"), true, "lot D3 : cinq groupes de deux chiffres séparés par une lettre seule");
    assert.equal(looksLikePhoneNumber("i7-1165G7 16 Go"), false);
    assert.equal(looksLikePhoneNumber("appelez le 0708091011 merci"), true, "des lettres AUTOUR du numéro ne le protègent pas");
    assert.equal(looksLikePhoneNumber("tel:+225 07 08 09 10 11"), true);
    assert.equal(looksLikePhoneNumber("07#08#09#10#11"), true);
    assert.equal(looksLikePhoneNumber("07🙂08🙂09🙂10🙂11"), true);
    assert.equal(looksLikePhoneNumber("0708 091x0911"), false, "une lettre au milieu de groupes de 3 et 4 chiffres : pas un séparateur");
    assert.equal(looksLikePhoneNumber("07080910x11"), false, "limite assumée : huit chiffres d'affilée puis une lettre ne forment pas un numéro (la lettre ne sépare que des groupes de 1 ou 2 chiffres)");
  });

  test("les années, dates et références ne sont des numéros que si une des règles (a) à (d) les couvre ; un numéro glissé parmi elles est détecté", () => {
    assert.equal(looksLikePhoneNumber("2019 2021"), false);
    assert.equal(looksLikePhoneNumber("2019 2021 0708091011"), true);
    assert.equal(looksLikePhoneNumber("2019 2021 07 08"), false, "lot D3 : ni dix chiffres ivoiriens ni quatre groupes de deux chiffres");
    assert.equal(looksLikePhoneNumber("٢٠١٩ ٢٠٢١"), false, "des années en chiffres non ASCII sont des années comme les autres (chiffres ramenés à l'ASCII)");
    assert.equal(looksLikePhoneNumber("2026-10-06 0708091011"), true, "un numéro à côté d'une date est détecté");
    assert.equal(looksLikePhoneNumber("2026 10 06 07"), false, "trois groupes de deux chiffres seulement");
    assert.equal(looksLikePhoneNumber("1850 1851"), false, "huit chiffres sans structure de numéro");
  });

  test("comptage des chiffres : tous les systèmes d'écriture", () => {
    assert.equal(countDigits("07 08 09 10 11"), 10);
    assert.equal(countDigits("٠٧٠٨"), 4);
    assert.equal(countDigits("０７"), 2);
    assert.equal(countDigits("Noir"), 0);
  });

  test("publicFieldText : omet (null) un texte qui porte un numéro, laisse les autres et les valeurs absentes", () => {
    assert.equal(publicFieldText("WhatsApp 0708091011"), null);
    assert.equal(publicFieldText("128 Go"), "128 Go");
    assert.equal(publicFieldText(null), null);
    assert.equal(publicFieldText(undefined), null);
  });

  test("le module serveur historique reprend exactement la même règle", () => {
    assert.equal(reexported.looksLikePhoneNumber, looksLikePhoneNumber);
    assert.equal(reexported.countDigits, countDigits);
    assert.equal(reexported.PHONE_IN_OFFER_MESSAGE, PHONE_IN_OFFER_MESSAGE);
  });
});

function offer(overrides: Partial<OfferRecord>): OfferRecord {
  return {
    id: "11111111-1111-4111-8111-111111111111", ownerId: "22222222-2222-4222-8222-222222222222", status: "published", rawText: "RAW_SECRET", category: "Téléphones", brand: "Apple", model: "iPhone 12",
    variant: "128 Go", attributes: null, condition: "Occasion", quantity: null, unit: null, location: "Cocody", deadlineAt: null, extractorVersion: null, extractionMetadata: null,
    extractedAt: null, contentVersion: 1, createdAt: new Date(), updatedAt: new Date(), archivedAt: null, price: { amount: 150_000, currency: "XOF" }, availabilityStatus: "available",
    availabilityConfirmedAt: null, ...overrides,
  } as OfferRecord;
}

function storedItem(candidate: OfferRecord): StoredMatchItem<OfferRecord> {
  return {
    candidateId: candidate.id, candidateContentVersion: 1, candidate, compatibilityStatus: "compatible", score: 90, coverage: 1,
    evaluationSummary: { matchedCount: 1, mismatchedCount: 0, unknownCount: 0, totalExploitableCriteria: 1 },
    scoringSummary: { totalApplicableWeight: 1, matchedWeight: 1, mismatchedWeight: 0, unknownWeight: 0, applicableCriteriaCount: 1, matchedCount: 1, mismatchedCount: 0, unknownCount: 0 },
    preferencesSummary: { preferenceScore: null, preferenceCoverage: null, totalPreferencesCount: 0, matchedCount: 0, mismatchedCount: 0, unknownCount: 0 },
    evaluatedAt: new Date(), indicators: { availability: null, price: null, confidence: { level: "medium", score: 50, accountAgeBand: "gte_30d", factors: [] } },
    relevance: 80, sponsored: false,
  } as unknown as StoredMatchItem<OfferRecord>;
}

describe("affichage : le texte du vendeur n'est jamais servi brut (résultats, fiche, notifications)", () => {
  const hidden = ["WhatsApp 0708091011", "０７０８０９１０１１", "٠٧٠٨٠٩١٠١١", "07/08/09/10/11", "07:08:09:10:11"];

  test("l'élément des résultats (mapStoredMatchItem) omet variante, marque, modèle, état, localisation et unité qui portent un numéro, sous toutes ses formes", () => {
    for (const text of hidden) {
      const dto = mapStoredMatchItem(storedItem(offer({ variant: text, brand: text, model: text, condition: text, location: text, unit: text, category: text })));
      const product = dto.candidate;
      assert.equal(product.variant, null, `variante « ${text} »`);
      assert.equal(product.brand, null, `marque « ${text} »`);
      assert.equal(product.model, null, `modèle « ${text} »`);
      assert.equal(product.condition, null);
      assert.equal(product.location, null);
      assert.equal(product.unit, null);
      assert.equal(product.category, null);
      assert.equal(JSON.stringify(dto).includes("0708"), false, "aucun fragment du numéro dans le DTO");
    }
  });

  test("un élément ordinaire est servi tel quel", () => {
    const product = mapStoredMatchItem(storedItem(offer({}))).candidate;
    assert.equal(product.variant, "128 Go");
    assert.equal(product.brand, "Apple");
    assert.equal(product.model, "iPhone 12");
    assert.equal(product.location, "Cocody");
    assert.equal(product.condition, "Occasion");
  });

  test("les attributs de la fiche omettent une valeur OU une clé qui porte un numéro (clé « w0708091011 » comprise)", () => {
    const attributes = publicAttributes({
      stockage: "128 Go", contact: "07/08/09/10/11", whatsapp: "WhatsApp 0708091011", w0708091011: "oui", prix_neuf: { value: "07", unit: "08 09 10 11" }, couleur: "Noir",
    });
    assert.deepEqual(attributes, [{ key: "couleur", value: "Noir" }, { key: "stockage", value: "128 Go" }]);
  });

  test("le titre d'une notification n'embarque jamais un numéro, même avec une barre oblique", () => {
    assert.equal(buildNotificationTitle({ brand: "Apple", model: "07/08/09/10/11", variant: "128 Go" }), "Apple 128 Go");
    assert.equal(buildNotificationTitle({ brand: "Apple", model: "iPhone 12", variant: "WhatsApp 0708091011" }), "Apple iPhone 12");
  });
});

describe("publication : refus d'une annonce qui porte un numéro (requireNoPhoneInOfferFields)", () => {
  const refused = (fields: Parameters<typeof requireNoPhoneInOfferFields>[0]): boolean => {
    try {
      requireNoPhoneInOfferFields(fields);
      return false;
    } catch (error) {
      assert.ok(error instanceof CatalogPhoneNumberError || error instanceof CatalogAttributeKeyError);
      if (error instanceof CatalogPhoneNumberError) assert.ok(error.message.startsWith("Pas de numéro de téléphone dans l'annonce (champ : "), error.message);
      return true;
    }
  };

  test("refusé : variante, marque, modèle, catégorie, état, unité, localisation, attribut (valeur, clé, objet imbriqué, nombre)", () => {
    for (const text of ["WhatsApp 0708091011", "07/08/09/10/11", "07:08:09:10:11", "０７０８０９１０１１", "٠٧٠٨٠٩١٠١١"]) {
      for (const field of ["variant", "brand", "model", "category", "condition", "unit", "location"] as const) {
        assert.equal(refused({ [field]: text }), true, `${field} : « ${text} »`);
      }
      assert.equal(refused({ attributes: { contact: text } }), true, `attribut : « ${text} »`);
    }
    assert.equal(refused({ attributes: { w0708091011: "oui" } }), true, "clé d'attribut (refusée : un chiffre dans un nom d'attribut)");
    assert.equal(refused({ attributes: { garantie: { value: "3 mois", unit: "0708091011" } } }), true, "objet imbriqué");
    assert.equal(refused({ attributes: { liste: ["a", { b: "07 08 09 10 11" }] } }), true, "tableau imbriqué");
    assert.equal(refused({ attributes: { numero: 2250708091011 } }), true, "nombre : indicatif 225 suivi de dix chiffres");
    assert.equal(refused({ attributes: { numero: 707080910 } }), false, "un nombre de neuf chiffres n'est pas un numéro (aucune règle ne le couvre)");
  });

  test("accepté : une annonce ordinaire, prix, capacités et années compris ; le texte brut n'est pas contrôlé (il n'est jamais servi)", () => {
    assert.equal(refused({
      category: "Téléphones", brand: "Apple", model: "iPhone 12", variant: "128 Go · 2024", condition: "Occasion", unit: "pièce", location: "Cocody",
      attributes: { stockage: { value: 128, unit: "Go" }, annee: "2015-2018", prix_neuf: "1 250 000 FCFA", chargeur_inclus: true, note: null },
    }), false);
    assert.equal(refused({}), false);
  });
});
