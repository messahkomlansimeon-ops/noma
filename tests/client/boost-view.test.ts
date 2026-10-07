import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { BoostQuote } from "../../lib/client/api";
import {
  BOOST_DURATIONS,
  UNAVAILABLE_FALLBACK_TEXT,
  UNAVAILABLE_REASON_TEXT,
  boostEligibility,
  durationLabel,
  explainFactors,
  factorEffectText,
  formatCountdown,
  formatQuoteTime,
  isBoostDuration,
  quoteAmountText,
  quoteHistoryRow,
  validityWindowMs,
  unavailableReasonText,
} from "../../lib/client/boost-view";
import { anchorQuote, anchoredQuoteValidity, anchoredRemainingMs, historyEntryExpired } from "../../lib/client/wallet-view";

const QUOTE_ID = "44444444-4444-4444-8444-444444444444";

/** Compte d'acheteurs tel que le serveur l'envoie (lots M1 à M1-quater) : `{ kind: "approx", value }` (multiple de 5) ou `{ kind: "below", bound: 5 }`. */
const about = (value: number) => ({ kind: "approx", value }) as const;
const BELOW = { kind: "below", bound: 5 } as const;

function availableQuote(overrides: Partial<BoostQuote> = {}): BoostQuote {
  return {
    id: QUOTE_ID,
    durationCode: "3d",
    currency: "XOF",
    status: "available",
    amount: 2300,
    unavailableReason: null,
    factors: { competitionMilli: 1060, demandMilli: 1500, scarcityMilli: 1333, durationMilli: 2500 },
    inputs: { competingSellers: 3, compatibleBuyers: about(15), reachableBuyers: about(10), reachTruncated: false, slotsTotal: 3, slotsUsed: 1 },
    computedAt: "2031-01-01T09:55:00.000Z",
    expiresAt: "2031-01-01T10:10:00.000Z",
    reused: false,
    expired: null,
    serverTime: null,
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
    assert.equal(unavailableReasonText("no_visible_effect"), "Pour le moment, un boost ne ferait monter votre annonce chez aucun acheteur : leurs listes sont trop courtes, ou la place mise en avant y est déjà occupée par un boost acheté plus tôt.");
    // Lot P3-bis (N2) : texte neutre : il couvre « listes trop courtes » ET « place prise par un boost acheté plus tôt » ; l'ancien texte (« pas assez d'annonces comparables ») est faux dans le second cas.
    const noEffect = unavailableReasonText("no_visible_effect");
    assert.match(noEffect, /trop courtes/);
    assert.match(noEffect, /déjà occupée par un boost acheté plus tôt/);
    assert.equal(noEffect.includes("comparables"), false);
    assert.equal(noEffect.includes("ordre des résultats"), false);
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
    assert.deepEqual(lines.map((line) => line.key), ["competition", "demand", "scarcity", "duration", "reach"]);
    assert.deepEqual(
      lines.map((line) => [line.title, line.text, line.effect]),
      [
        ["Concurrence", "3 autres vendeurs proposent ce produit.", "+6 % sur le prix"],
        ["Acheteurs compatibles", "Environ 15 acheteurs compatibles avec votre annonce.", "+50 % sur le prix"],
        ["Places disponibles", "1 place de mise en avant utilisée sur 3.", "+33,3 % sur le prix"],
        ["Durée", "Mise en avant pendant 3 jours.", "prix × 2,5 selon la durée"],
        ["Visibilité", "Mise en avant visible auprès d'environ 10 acheteurs.", "n'entre pas dans le prix"],
      ],
    );
    const text = JSON.stringify(lines);
    for (const raw of ["Milli", "milli", "1060", "1500", "1333", "2500"]) assert.equal(text.includes(raw), false, raw);
  });

  test("portée visible : « Mise en avant visible auprès d'environ X acheteurs » ou « de moins de 5 acheteurs », rien pour un devis non évalué ; jamais un code brut", () => {
    const reach = (reachableBuyers: typeof BELOW | ReturnType<typeof about> | null) =>
      explainFactors(availableQuote({ inputs: { competingSellers: 1, compatibleBuyers: about(5), reachableBuyers, reachTruncated: false, slotsTotal: 2, slotsUsed: 0 } })).filter((line) => line.key === "reach");
    assert.deepEqual(reach(BELOW).map((line) => line.text), ["Mise en avant visible auprès de moins de 5 acheteurs."]);
    assert.deepEqual(reach(about(5)).map((line) => line.text), ["Mise en avant visible auprès d'environ 5 acheteurs."]);
    assert.deepEqual(reach(about(15)).map((line) => line.text), ["Mise en avant visible auprès d'environ 15 acheteurs."]);
    assert.deepEqual(reach(null), [], "devis d'avant la migration 0016 : aucune ligne inventée");
    assert.equal(JSON.stringify(reach(about(15))).includes("reachable"), false);
  });

  test("portée estimée et bornée (lot P3) : « d'environ X acheteurs, ou plus » quand l'estimation est tronquée, jamais sinon ; « moins de 5 » ne dit jamais « ou plus »", () => {
    const reach = (reachableBuyers: typeof BELOW | ReturnType<typeof about> | null, reachTruncated: boolean) =>
      explainFactors(availableQuote({ inputs: { competingSellers: 1, compatibleBuyers: about(50), reachableBuyers, reachTruncated, slotsTotal: 2, slotsUsed: 0 } })).filter((line) => line.key === "reach");
    assert.deepEqual(reach(about(20), true).map((line) => line.text), ["Mise en avant visible auprès d'environ 20 acheteurs, ou plus."]);
    assert.deepEqual(reach(BELOW, true).map((line) => line.text), ["Mise en avant visible auprès de moins de 5 acheteurs."]);
    assert.deepEqual(reach(about(20), false).map((line) => line.text), ["Mise en avant visible auprès d'environ 20 acheteurs."]);
    assert.deepEqual(reach(null, true), [], "portée non évaluée : aucune ligne, même si le drapeau est vrai");
  });

  test("accords au singulier et cas sans concurrent", () => {
    const lines = explainFactors(
      availableQuote({
        durationCode: "24h",
        factors: { competitionMilli: 1000, demandMilli: 1000, scarcityMilli: 1000, durationMilli: 1000 },
        inputs: { competingSellers: 0, compatibleBuyers: BELOW, reachableBuyers: BELOW, reachTruncated: false, slotsTotal: 1, slotsUsed: 0 },
      }),
    );
    assert.equal(lines[0].text, "Aucun autre vendeur ne propose ce produit.");
    assert.equal(lines[1].text, "Moins de 5 acheteurs compatibles avec votre annonce.");
    assert.equal(lines[2].text, "0 place de mise en avant utilisée sur 1.");
    assert.equal(lines[3].effect, "durée de référence (prix de base)");
    assert.equal(lines[4].text, "Mise en avant visible auprès de moins de 5 acheteurs.");
    assert.equal(explainFactors(availableQuote({ inputs: { competingSellers: 1, compatibleBuyers: about(5), reachableBuyers: about(5), reachTruncated: false, slotsTotal: 3, slotsUsed: 2 } }))[0].text, "1 autre vendeur propose ce produit.");
  });

  test("arrondi (lots M1 à M1-quater) : 0 à 4 acheteurs s'affichent « moins de 5 », jamais le nombre ; 5 et plus « environ N » ; plus aucun « moins de 3 »", () => {
    const lines = (compatibleBuyers: typeof BELOW | ReturnType<typeof about>, reachableBuyers: typeof BELOW | ReturnType<typeof about> | null, reachTruncated = false) =>
      explainFactors(availableQuote({ inputs: { competingSellers: 1, compatibleBuyers, reachableBuyers, reachTruncated, slotsTotal: 2, slotsUsed: 0 } }));
    const masked = lines(BELOW, BELOW);
    assert.equal(masked[1].text, "Moins de 5 acheteurs compatibles avec votre annonce.");
    assert.equal(masked[4].text, "Mise en avant visible auprès de moins de 5 acheteurs.");
    assert.equal(lines(BELOW, BELOW, true)[4].text, "Mise en avant visible auprès de moins de 5 acheteurs.");
    for (const line of masked) assert.equal(/\b[0-4] acheteur|moins de 3/.test(line.text), false, line.text);
    assert.equal(lines(about(5), about(5))[1].text, "Environ 5 acheteurs compatibles avec votre annonce.");
    assert.equal(lines(about(120), about(95))[1].text, "Environ 120 acheteurs compatibles avec votre annonce.");
    assert.equal(lines(about(120), about(95))[4].text, "Mise en avant visible auprès d'environ 95 acheteurs.");
  });

  test("devis indisponible : aucune ligne de facteur", () => {
    assert.deepEqual(explainFactors(unavailableQuote("no_compatible_buyer")), []);
  });
});

describe("validité et compte à rebours (horloge ancrée, voir aussi wallet-view.test.ts)", () => {
  test("format du compte à rebours : arrondi par excès, minutes et secondes", () => {
    assert.equal(formatCountdown(899_000), "14 min 59 s");
    assert.equal(formatCountdown(900_000), "15 min 0 s");
    assert.equal(formatCountdown(45_000), "45 s");
    assert.equal(formatCountdown(100), "1 s");
    assert.equal(formatCountdown(0), "0 s");
    assert.equal(formatCountdown(-5), "0 s");
  });

  test("fenêtre de validité : expiresAt − computedAt ; dates illisibles ou inversées = aucune fenêtre", () => {
    const quote = availableQuote(); // calculé à 09:55:00, expire à 10:10:00 : 900 s de validité
    assert.equal(validityWindowMs(quote), 900_000);
    assert.equal(validityWindowMs({ computedAt: "n'importe quoi", expiresAt: quote.expiresAt }), null);
    assert.equal(validityWindowMs({ computedAt: quote.expiresAt, expiresAt: quote.computedAt }), null);
  });

  test("jamais au-delà de la durée de validité, quel que soit le temps de lecture : « Prix valable encore 15 min 0 s » au plus", () => {
    const quote = availableQuote();
    const clock = anchorQuote(quote, 5_000);
    // Lecture faite AVANT la réception (aucune horloge ne peut rallonger un devis) ou à la réception : 900 s au plus.
    assert.equal(anchoredQuoteValidity(quote, clock, 0).text, "Prix valable encore 15 min 0 s");
    assert.equal(anchoredQuoteValidity(quote, clock, 5_000).text, "Prix valable encore 15 min 0 s");
    assert.equal(anchoredQuoteValidity(quote, clock, 6_000).text, "Prix valable encore 14 min 59 s");
    // Devis indisponible (60 s) : « 1 min 31 s » pour 60 s de validité serait faux.
    const short = unavailableQuote("no_slot_available", { computedAt: "2031-01-01T10:00:00.000Z", expiresAt: "2031-01-01T10:01:00.000Z" });
    const shortClock = anchorQuote(short, 10_000);
    assert.equal(anchoredQuoteValidity(short, shortClock, 10_000).text, "Résultat valable encore 1 min 0 s");
    assert.equal(anchoredQuoteValidity(short, shortClock, 40_000).text, "Résultat valable encore 30 s");
  });

  test("validité : « Prix valable encore … » puis « Ce devis a expiré… »", () => {
    const quote = availableQuote();
    const clock = anchorQuote(quote, 1_000);
    assert.deepEqual(anchoredQuoteValidity(quote, clock, 1_000), { expired: false, text: "Prix valable encore 15 min 0 s" });
    assert.deepEqual(anchoredQuoteValidity(quote, clock, 1_000 + 900_000), { expired: true, text: "Ce devis a expiré. Demandez-en un nouveau." });
    assert.deepEqual(anchoredQuoteValidity(quote, clock, 1_000 + 1_000_000), { expired: true, text: "Ce devis a expiré. Demandez-en un nouveau." });
    const short = unavailableQuote("no_slot_available", { computedAt: "2031-01-01T10:00:00.000Z", expiresAt: "2031-01-01T10:00:30.000Z" });
    assert.equal(anchoredQuoteValidity(short, anchorQuote(short, 0), 0).text, "Résultat valable encore 30 s");
    assert.equal(anchoredRemainingMs(anchorQuote(short, 0), 29_999), 1);
  });
});

describe("historique des devis", () => {
  test("devis valable, expiré, indisponible : titre, état en clair, date", () => {
    const valid = quoteHistoryRow(availableQuote({ reused: null, expired: false }), false, "UTC");
    assert.equal(valid.key, QUOTE_ID);
    assert.match(valid.title, /^3 jours · 2\s300 FCFA$/);
    assert.equal(valid.status, "En cours de validité");
    assert.equal(valid.tone, "good");
    assert.equal(valid.detail, "Demandé le 01/01 09:55");

    const expired = quoteHistoryRow(availableQuote({ reused: null, expired: true }), true, "UTC");
    assert.equal(expired.status, "Expiré");
    assert.equal(expired.tone, "neutral");
    // L'état « expiré » est décidé sur l'horloge ancrée : dit par le serveur à la lecture, ou fenêtre entière écoulée depuis.
    const readAt = 2_000;
    assert.equal(historyEntryExpired(availableQuote({ reused: null, expired: true }), readAt, readAt), true);
    assert.equal(historyEntryExpired(availableQuote({ reused: null, expired: false }), readAt, readAt + 899_000), false);
    assert.equal(historyEntryExpired(availableQuote({ reused: null, expired: false }), readAt, readAt + 900_000), true);
    assert.equal(quoteHistoryRow(availableQuote({ reused: null, expired: false }), true, "UTC").status, "Expiré");

    // Un devis ACHETÉ est consommé : « Acheté », même s'il n'a pas expiré, jamais « En cours de validité » ni « Expiré ».
    for (const expiredNow of [false, true]) {
      const bought = quoteHistoryRow(availableQuote({ reused: null, expired: expiredNow }), expiredNow, "UTC", true);
      assert.equal(bought.status, "Acheté");
      assert.equal(bought.tone, "good");
      assert.match(bought.title, /^3 jours · 2\s300 FCFA$/);
    }
    assert.equal(quoteHistoryRow(availableQuote({ reused: null, expired: false }), false, "UTC", false).status, "En cours de validité");
    assert.equal(quoteHistoryRow(availableQuote({ reused: null, expired: false }), false, "UTC").status, "En cours de validité");

    const unavailable = quoteHistoryRow(unavailableQuote("offer_already_boosted", { reused: null, expired: false }), false, "UTC");
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
