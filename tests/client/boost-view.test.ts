import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { BoostQuote } from "../../lib/client/api";
import {
  BOOST_DURATIONS,
  BUY_BUTTON,
  UNAVAILABLE_FALLBACK_TEXT,
  UNAVAILABLE_REASON_TEXT,
  boostEligibility,
  buyButtonState,
  durationLabel,
  explainFactors,
  factorEffectText,
  formatCountdown,
  formatQuoteTime,
  isBoostDuration,
  quoteAmountText,
  quoteHistoryRow,
  quoteValidity,
  remainingMs,
  remainingValidityMs,
  validityWindowMs,
  unavailableReasonText,
} from "../../lib/client/boost-view";

const QUOTE_ID = "44444444-4444-4444-8444-444444444444";
const NOW = Date.parse("2031-01-01T10:00:00.000Z");

function availableQuote(overrides: Partial<BoostQuote> = {}): BoostQuote {
  return {
    id: QUOTE_ID,
    durationCode: "3d",
    currency: "XOF",
    status: "available",
    amount: 2300,
    unavailableReason: null,
    factors: { competitionMilli: 1060, demandMilli: 1300, scarcityMilli: 1333, durationMilli: 2500 },
    inputs: { competingSellers: 3, compatibleBuyers: 4, slotsTotal: 3, slotsUsed: 1 },
    computedAt: "2031-01-01T09:55:00.000Z",
    expiresAt: "2031-01-01T10:10:00.000Z",
    reused: false,
    expired: null,
    ...overrides,
  };
}

function unavailableQuote(reason: string | null, overrides: Partial<BoostQuote> = {}): BoostQuote {
  return availableQuote({ status: "unavailable", amount: null, factors: null, unavailableReason: reason, ...overrides });
}

describe("durées", () => {
  test("24 h, 3 jours, 7 jours", () => {
    assert.deepEqual(BOOST_DURATIONS.map((entry) => [entry.code, entry.label]), [["24h", "24 h"], ["3d", "3 jours"], ["7d", "7 jours"]]);
    assert.equal(durationLabel("3d"), "3 jours");
    assert.equal(isBoostDuration("7d"), true);
    assert.equal(isBoostDuration("1h"), false);
    assert.equal(isBoostDuration(undefined), false);
  });
});

describe("devis proposé seulement pour une annonce en ligne", () => {
  const base = { status: "published", availabilityStatus: "available", category: "Téléphones", brand: "Apple", model: "iPhone 12" } as const;

  test("annonce en ligne, disponible, complète : devis possible", () => {
    assert.deepEqual(boostEligibility(base), { eligible: true });
    assert.deepEqual(boostEligibility({ ...base, availabilityStatus: null }), { eligible: true });
    assert.deepEqual(boostEligibility({ ...base, availabilityStatus: "reserved" }), { eligible: true });
  });

  test("brouillon, pause, archivée : message clair, jamais de devis", () => {
    for (const [status, hint] of [["draft", /Publiez-la/], ["paused", /Remettez-la en ligne/], ["archived", /archivée/]] as const) {
      const result = boostEligibility({ ...base, status });
      assert.equal(result.eligible, false, status);
      assert.match((result as { message: string }).message, /Le devis n'est proposé que pour une annonce en ligne|archivée/);
      assert.match((result as { message: string }).message, hint);
    }
  });

  test("annonce indisponible ou sans catégorie, marque ou modèle : message clair", () => {
    assert.match((boostEligibility({ ...base, availabilityStatus: "unavailable" }) as { message: string }).message, /indisponible/);
    for (const missing of ["category", "brand", "model"] as const) {
      for (const empty of [null, "", "  "]) {
        const result = boostEligibility({ ...base, [missing]: empty });
        assert.equal(result.eligible, false, `${missing}=${String(empty)}`);
        assert.match((result as { message: string }).message, /catégorie, sa marque et son modèle/);
      }
    }
  });
});

describe("motifs d'indisponibilité en clair", () => {
  test("chaque motif connu a un texte en français, jamais le code brut", () => {
    assert.equal(unavailableReasonText("offer_already_boosted"), "Cette annonce est déjà boostée.");
    assert.equal(unavailableReasonText("no_slot_available"), "Il n'y a plus de place disponible pour ce produit pour le moment.");
    assert.equal(unavailableReasonText("seller_boost_limit_reached"), "Vous avez atteint votre plafond de boosts pour ce produit.");
    assert.equal(unavailableReasonText("no_compatible_buyer"), "Aucun acheteur compatible pour le moment : un boost ne serait pas utile.");
    for (const [code, text] of Object.entries(UNAVAILABLE_REASON_TEXT)) {
      assert.notEqual(text, code);
      assert.equal(text.includes("_"), false, `« ${text} » contient un code brut`);
    }
  });

  test("motif inconnu ou absent : texte générique, jamais le code reçu", () => {
    for (const code of ["motif_futur_inconnu", "", null, "__proto__", "constructor", "toString"]) {
      const text = unavailableReasonText(code);
      assert.equal(text, UNAVAILABLE_FALLBACK_TEXT, String(code));
      assert.equal(code !== null && code !== "" && text.includes(code), false);
    }
  });
});

describe("montant et explication des facteurs", () => {
  test("montant en FCFA (espace insécable) ; null si indisponible", () => {
    assert.match(quoteAmountText(availableQuote()) ?? "", /^2\s300 FCFA$/);
    assert.match(quoteAmountText(availableQuote({ amount: 50000 })) ?? "", /^50\s000 FCFA$/);
    assert.equal(quoteAmountText(unavailableQuote("no_slot_available")), null);
    assert.match(quoteAmountText(availableQuote({ currency: "EUR" })) ?? "", /^2\s300 EUR$/);
  });

  test("effet d'un facteur en pourcentage clair", () => {
    assert.equal(factorEffectText(1000), "sans effet sur le prix");
    assert.equal(factorEffectText(1060), "+6 % sur le prix");
    assert.equal(factorEffectText(1333), "+33,3 % sur le prix");
    assert.equal(factorEffectText(950), "−5 % sur le prix");
  });

  test("les quatre facteurs expliqués en clair : concurrence, acheteurs compatibles, places, durée", () => {
    const lines = explainFactors(availableQuote());
    assert.deepEqual(lines.map((line) => line.key), ["competition", "demand", "scarcity", "duration"]);
    assert.deepEqual(
      lines.map((line) => [line.title, line.text, line.effect]),
      [
        ["Concurrence", "3 autres vendeurs proposent ce produit.", "+6 % sur le prix"],
        ["Acheteurs compatibles", "4 acheteurs compatibles avec votre annonce.", "+30 % sur le prix"],
        ["Places disponibles", "1 place de mise en avant utilisée sur 3.", "+33,3 % sur le prix"],
        ["Durée", "Mise en avant pendant 3 jours.", "prix × 2,5 selon la durée"],
      ],
    );
    const text = JSON.stringify(lines);
    for (const raw of ["Milli", "milli", "1060", "1300", "1333", "2500"]) assert.equal(text.includes(raw), false, raw);
  });

  test("accords au singulier et cas sans concurrent", () => {
    const lines = explainFactors(
      availableQuote({
        durationCode: "24h",
        factors: { competitionMilli: 1000, demandMilli: 1000, scarcityMilli: 1000, durationMilli: 1000 },
        inputs: { competingSellers: 0, compatibleBuyers: 1, slotsTotal: 1, slotsUsed: 0 },
      }),
    );
    assert.equal(lines[0].text, "Aucun autre vendeur ne propose ce produit.");
    assert.equal(lines[1].text, "1 acheteur compatible avec votre annonce.");
    assert.equal(lines[2].text, "0 place de mise en avant utilisée sur 1.");
    assert.equal(lines[3].effect, "durée de référence (prix de base)");
    assert.equal(explainFactors(availableQuote({ inputs: { competingSellers: 1, compatibleBuyers: 2, slotsTotal: 3, slotsUsed: 2 } }))[0].text, "1 autre vendeur propose ce produit.");
  });

  test("devis indisponible : aucune ligne de facteur", () => {
    assert.deepEqual(explainFactors(unavailableQuote("no_compatible_buyer")), []);
  });
});

describe("validité et compte à rebours", () => {
  test("temps restant, jamais négatif ; date illisible = expiré", () => {
    assert.equal(remainingMs("2031-01-01T10:10:00.000Z", NOW), 600_000);
    assert.equal(remainingMs("2031-01-01T09:00:00.000Z", NOW), 0);
    assert.equal(remainingMs("pas une date", NOW), 0);
  });

  test("format du compte à rebours : arrondi par excès, minutes et secondes", () => {
    assert.equal(formatCountdown(899_000), "14 min 59 s");
    assert.equal(formatCountdown(900_000), "15 min 0 s");
    assert.equal(formatCountdown(45_000), "45 s");
    assert.equal(formatCountdown(100), "1 s");
    assert.equal(formatCountdown(0), "0 s");
    assert.equal(formatCountdown(-5), "0 s");
  });

  test("jamais au-delà de la durée de validité : une horloge d'écran en retard ne rallonge pas le devis", () => {
    const quote = availableQuote(); // calculé à 09:55:00, expire à 10:10:00 : 900 s de validité
    assert.equal(validityWindowMs(quote), 900_000);
    const computed = Date.parse(quote.computedAt);
    // Écran resté sur une heure plus ancienne (page ouverte depuis 30 s ou appareil en retard) : 15 min 30 s serait faux.
    assert.equal(remainingValidityMs(quote, computed - 30_000), 900_000);
    assert.equal(quoteValidity(quote, computed - 30_000).text, "Prix valable encore 15 min 0 s");
    assert.equal(quoteValidity(quote, computed - 3_600_000).text, "Prix valable encore 15 min 0 s");
    assert.equal(quoteValidity(quote, computed).text, "Prix valable encore 15 min 0 s");
    assert.equal(quoteValidity(quote, computed + 1_000).text, "Prix valable encore 14 min 59 s");
    // Devis indisponible (60 s) : « 1 min 31 s » pour 60 s de validité serait faux.
    const short = unavailableQuote("no_slot_available", { computedAt: "2031-01-01T10:00:00.000Z", expiresAt: "2031-01-01T10:01:00.000Z" });
    assert.equal(quoteValidity(short, Date.parse("2031-01-01T09:59:29.000Z")).text, "Résultat valable encore 1 min 0 s");
    assert.equal(quoteValidity(short, Date.parse("2031-01-01T10:00:30.000Z")).text, "Résultat valable encore 30 s");
    // Dates illisibles : on retombe sur l'échéance seule (sans borne), jamais d'exception.
    assert.equal(validityWindowMs({ computedAt: "n'importe quoi", expiresAt: quote.expiresAt }), null);
    assert.equal(validityWindowMs({ computedAt: quote.expiresAt, expiresAt: quote.computedAt }), null);
    assert.equal(remainingValidityMs({ computedAt: "n'importe quoi", expiresAt: quote.expiresAt }, NOW), 600_000);
  });

  test("validité : « Prix valable encore … » puis « Ce devis a expiré… »", () => {
    const quote = availableQuote();
    assert.deepEqual(quoteValidity(quote, NOW), { expired: false, text: "Prix valable encore 10 min 0 s" });
    assert.deepEqual(quoteValidity(quote, NOW + 600_000), { expired: true, text: "Ce devis a expiré. Demandez-en un nouveau." });
    assert.deepEqual(quoteValidity(quote, NOW + 700_000), { expired: true, text: "Ce devis a expiré. Demandez-en un nouveau." });
    assert.equal(quoteValidity(unavailableQuote("no_slot_available", { expiresAt: "2031-01-01T10:00:30.000Z" }), NOW).text, "Résultat valable encore 30 s");
  });
});

describe("bouton « Acheter » : jamais actif", () => {
  test("désactivé, avec la mention « Paiement bientôt disponible », quelles que soient les entrées", () => {
    assert.equal(BUY_BUTTON.disabled, true);
    assert.equal(BUY_BUTTON.label, "Acheter");
    assert.equal(BUY_BUTTON.note, "Paiement bientôt disponible");
    assert.deepEqual(buyButtonState(), { label: "Acheter", disabled: true, note: "Paiement bientôt disponible" });
    assert.equal(Object.isFrozen(BUY_BUTTON), true);
  });
});

describe("historique des devis", () => {
  test("devis valable, expiré, indisponible : titre, état en clair, date", () => {
    const valid = quoteHistoryRow(availableQuote({ reused: null, expired: false }), NOW, "UTC");
    assert.equal(valid.key, QUOTE_ID);
    assert.match(valid.title, /^3 jours · 2\s300 FCFA$/);
    assert.equal(valid.status, "En cours de validité");
    assert.equal(valid.tone, "good");
    assert.equal(valid.detail, "Demandé le 01/01 09:55");

    const expired = quoteHistoryRow(availableQuote({ reused: null, expired: true }), NOW, "UTC");
    assert.equal(expired.status, "Expiré");
    assert.equal(expired.tone, "neutral");
    const lapsed = quoteHistoryRow(availableQuote({ reused: null, expired: false }), NOW + 3_600_000, "UTC");
    assert.equal(lapsed.status, "Expiré", "expiré même si la lecture date d'avant l'échéance");

    const unavailable = quoteHistoryRow(unavailableQuote("offer_already_boosted", { reused: null, expired: false }), NOW, "UTC");
    assert.equal(unavailable.title, "3 jours · indisponible");
    assert.equal(unavailable.status, "Cette annonce est déjà boostée.");
    assert.equal(unavailable.tone, "warn");
    assert.equal(JSON.stringify(unavailable).includes("offer_already_boosted"), false);
  });

  test("date courte, fuseau donné ; date illisible dite en clair", () => {
    assert.equal(formatQuoteTime("2031-01-01T09:55:00.000Z", "UTC"), "01/01 09:55");
    assert.equal(formatQuoteTime("2031-12-31T23:05:00.000Z", "Africa/Abidjan"), "31/12 23:05");
    assert.equal(formatQuoteTime("n'importe quoi"), "date inconnue");
  });
});
