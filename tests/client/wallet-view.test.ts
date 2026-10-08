import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { BoostPurchaseHistoryItem, BoostQuote, WalletTopup, WalletTransaction } from "../../lib/client/api";
import { isUuid } from "../../lib/client/api";
import {
  NO_PROVIDER_NOTICE,
  RETURN_PENDING_TITLE,
  RETURN_POLL_INTERVAL_MS,
  RETURN_POLL_WINDOW_MS,
  SIMULATION_NOTICE,
  WAVE_LABEL,
  WAVE_NOTICE,
  externalCheckoutHref,
  parseReturnResult,
  rechargeNotice,
  returnView,
  BALANCE_UNKNOWN_TEXT,
  BOOST_SUCCESS_NOTE,
  BUY_LABELS,
  PURCHASE_NOT_RECORDED_TEXT,
  PURCHASE_RECHECK_DELAYS_MS,
  SERVER_DATE_RESOLUTION_MS,
  TOPUP_KEY_PREFIX,
  UNRESOLVED_PURCHASE_TEXT,
  CHECKOUT_MESSAGES,
  MAX_QUOTE_WINDOW_MS,
  SIMULATION_BANNER,
  TOPUP_AMOUNT_MESSAGES,
  TOPUP_MAX_XOF,
  TOPUP_MIN_XOF,
  TOPUP_PRESETS,
  TOPUP_STEP_XOF,
  TRANSACTION_LABELS,
  UNKNOWN_AMOUNT_TEXT,
  UNKNOWN_TRANSACTION_LABEL,
  WALLET_PATH,
  amountTone,
  anchorQuote,
  anchoredQuoteValidity,
  anchoredRemainingMs,
  boostActiveText,
  browserSessionStorage,
  buyState,
  canBuy,
  checkoutHref,
  checkoutAlreadyCreditedMessage,
  checkoutView,
  confirmButtonState,
  createIdempotencyKeys,
  createTopupKeys,
  createTopupWithFreshKey,
  formatDateFr,
  formatDateTimeFr,
  formatFcfa,
  formatSignedFcfa,
  historyEntryExpired,
  isCheckoutPath,
  isPurchaseOutcomeUnknown,
  isValidTopupAmount,
  mergeTransactionPages,
  newIdempotencyKey,
  parseTopupAmount,
  purchaseConfirmationText,
  purchaseFollowUp,
  purchaseHistoryRow,
  reanchorQuote,
  returnLinkLabel,
  returnTarget,
  schedulePurchaseRechecks,
  transactionLabel,
  walletHref,
  walletRow,
  type KeyStorage,
} from "../../lib/client/wallet-view";

const TOPUP_ID = "77777777-7777-4777-8777-777777777777";
const OFFER_ID = "11111111-1111-4111-8111-111111111111";
const NBSP = " ";
const NARROW_NBSP = " ";

function topup(overrides: Partial<WalletTopup> = {}): WalletTopup {
  return {
    id: TOPUP_ID,
    amountXof: 2_000,
    status: "pending",
    expiresAt: "2031-01-01T10:30:00.000Z",
    checkoutPath: `/paiement-simule/${TOPUP_ID}`,
    provider: "fake",
    checkoutUrl: null,
    ...overrides,
  };
}

function quote(overrides: Partial<BoostQuote> = {}): BoostQuote {
  return {
    id: "44444444-4444-4444-8444-444444444444",
    durationCode: "3d",
    currency: "XOF",
    status: "available",
    amount: 1_300,
    unavailableReason: null,
    factors: { competitionMilli: 1020, demandMilli: 1000, scarcityMilli: 1000, durationMilli: 2500 },
    inputs: { competingSellers: 1, compatibleBuyers: { kind: "below", bound: 5 }, reachableBuyers: { kind: "below", bound: 5 }, reachTruncated: false, slotsTotal: 2, slotsUsed: 0 },
    computedAt: "2031-01-01T10:00:00.000Z",
    expiresAt: "2031-01-01T10:15:00.000Z",
    reused: false,
    expired: null,
    serverTime: null,
    ...overrides,
  };
}

describe("montants en FCFA", () => {
  test("format : espaces entre les milliers, « FCFA » ; un montant illisible n'est jamais montré comme un nombre", () => {
    assert.match(formatFcfa(0), /^0 FCFA$/);
    assert.match(formatFcfa(2_000), /^2\s000 FCFA$/);
    assert.match(formatFcfa(500_000), /^500\s000 FCFA$/);
    assert.match(formatFcfa(1_234_567), /^1\s234\s567 FCFA$/);
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 1.5, 2 ** 53, Number.MAX_SAFE_INTEGER + 2]) {
      assert.equal(formatFcfa(bad), UNKNOWN_AMOUNT_TEXT, String(bad));
      assert.equal(formatSignedFcfa(bad), UNKNOWN_AMOUNT_TEXT, String(bad));
    }
  });

  test("montant signé : « + » pour un crédit, vrai signe moins « − » (U+2212) pour un débit", () => {
    assert.match(formatSignedFcfa(2_000), /^\+2\s000 FCFA$/);
    assert.match(formatSignedFcfa(-1_300), /^−1\s300 FCFA$/);
    assert.equal(formatSignedFcfa(-1_300).startsWith("−"), true);
    assert.match(formatSignedFcfa(0), /^0 FCFA$/);
    assert.equal(amountTone(1), "credit");
    assert.equal(amountTone(-1), "debit");
    assert.equal(amountTone(0), "neutral");
  });
});

describe("dates en français", () => {
  test("date et heure, date seule ; fuseau donné ; date illisible dite en clair", () => {
    assert.equal(formatDateTimeFr("2031-01-01T09:55:00.000Z", "UTC"), "01/01/2031 à 09:55");
    assert.equal(formatDateTimeFr("2031-12-31T23:05:00.000Z", "Africa/Abidjan"), "31/12/2031 à 23:05");
    assert.equal(formatDateTimeFr("2031-12-31T23:05:00.000Z", "Europe/Paris"), "01/01/2032 à 00:05");
    assert.equal(formatDateFr("2031-01-01T09:55:00.000Z", "UTC"), "01/01/2031");
    assert.equal(formatDateTimeFr("n'importe quoi"), "date inconnue");
    assert.equal(formatDateFr("n'importe quoi"), "date inconnue");
  });

  test("boost actif et achat : texte en clair", () => {
    assert.equal(boostActiveText("2031-01-04T17:01:00.000Z", "UTC"), "Boost actif jusqu'au 04/01/2031 à 17:01");
    const item: BoostPurchaseHistoryItem = {
      id: "55555555-5555-4555-8555-555555555555",
      quoteId: "44444444-4444-4444-8444-444444444444",
      durationCode: "3d",
      amountXof: 1_300,
      promoAmountXof: 0,
      startsAt: "2031-01-01T17:01:00.000Z",
      endsAt: "2031-01-04T17:01:00.000Z",
      createdAt: "2031-01-01T17:01:02.000Z",
      refundedAt: null,
    };
    const row = purchaseHistoryRow(item, "UTC");
    assert.match(row.title, /^3 jours · 1\s300 FCFA$/);
    assert.equal(row.detail, "Acheté le 01/01/2031 à 17:01 · jusqu'au 04/01/2031 à 17:01");
    assert.equal(row.refundedText, null);
    const refunded = purchaseHistoryRow({ ...item, refundedAt: "2031-01-02T08:30:00.000Z" }, "UTC");
    assert.equal(refunded.refundedText, "Remboursé le 02/01/2031 à 08:30");
    assert.equal(purchaseHistoryRow({ ...item, durationCode: "24h" }, "UTC").title.startsWith("24 h · "), true);
  });
});

describe("historique du porte-monnaie en mots simples", () => {
  test("chaque type a son libellé ; un type inconnu ne s'affiche jamais tel quel", () => {
    assert.equal(transactionLabel("topup"), "Recharge");
    assert.equal(transactionLabel("boost_purchase"), "Achat de boost");
    assert.equal(transactionLabel("boost_refund"), "Remboursement de boost");
    assert.equal(transactionLabel("adjustment"), "Ajustement");
    for (const [kind, label] of Object.entries(TRANSACTION_LABELS)) {
      assert.notEqual(label, kind);
      assert.equal(label.includes("_"), false);
    }
    for (const unknown of ["futur_type", "", "__proto__", "constructor", "toString", "hasOwnProperty"]) {
      assert.equal(transactionLabel(unknown), UNKNOWN_TRANSACTION_LABEL, unknown);
    }
  });

  test("ligne : libellé, montant signé et teinte, date ; aucun code brut", () => {
    const credit: WalletTransaction = { id: "a1111111-1111-4111-8111-111111111111", kind: "topup", amountXof: 2_000, promoAmountXof: 0, createdAt: "2031-01-01T10:00:00.000Z" };
    const debit: WalletTransaction = { id: "b2222222-2222-4222-8222-222222222222", kind: "boost_purchase", amountXof: -1_300, promoAmountXof: 0, createdAt: "2031-01-01T11:00:00.000Z" };
    const row = walletRow(credit, "UTC");
    assert.equal(row.key, credit.id);
    assert.equal(row.label, "Recharge");
    assert.match(row.amountText, /^\+2\s000 FCFA$/);
    assert.equal(row.tone, "credit");
    assert.equal(row.dateText, "01/01/2031 à 10:00");
    const debitRow = walletRow(debit, "UTC");
    assert.equal(debitRow.label, "Achat de boost");
    assert.match(debitRow.amountText, /^−1\s300 FCFA$/);
    assert.equal(debitRow.tone, "debit");
    for (const text of [JSON.stringify(row), JSON.stringify(debitRow)]) assert.equal(/topup|boost_purchase/.test(text), false);
  });

  test("pages fusionnées sans doublon, ordre du serveur conservé", () => {
    const tx = (id: string): WalletTransaction => ({ id, kind: "topup", amountXof: 500, promoAmountXof: 0, createdAt: "2031-01-01T10:00:00.000Z" });
    const merged = mergeTransactionPages([tx("a"), tx("b")], [tx("b"), tx("c"), tx("c"), tx("d")]);
    assert.deepEqual(merged.map((entry) => entry.id), ["a", "b", "c", "d"]);
    assert.deepEqual(mergeTransactionPages([], []), []);
  });
});

describe("montant d'une recharge : bornes du serveur (500 à 500 000, multiple de 100)", () => {
  test("constantes identiques à celles du serveur ; les montants proposés sont tous valides", () => {
    assert.equal(TOPUP_MIN_XOF, 500);
    assert.equal(TOPUP_MAX_XOF, 500_000);
    assert.equal(TOPUP_STEP_XOF, 100);
    assert.deepEqual([...TOPUP_PRESETS], [1_000, 2_000, 5_000, 10_000]);
    for (const preset of TOPUP_PRESETS) assert.equal(isValidTopupAmount(preset), true, String(preset));
  });

  test("montants acceptés, espaces de milliers (y compris insécables) tolérés", () => {
    for (const [input, expected] of [
      ["500", 500],
      ["600", 600],
      ["1000", 1_000],
      ["2 000", 2_000],
      [`2${NBSP}500`, 2_500],
      [`10${NARROW_NBSP}000`, 10_000],
      ["  5000  ", 5_000],
      ["499 900", 499_900],
      ["500000", 500_000],
      ["500 000", 500_000],
    ] as const) {
      assert.deepEqual(parseTopupAmount(input), { ok: true, amountXof: expected }, JSON.stringify(input));
    }
  });

  test("montants refusés : un message clair pour chaque cause, aux bornes exactes", () => {
    const refused = (input: unknown) => {
      const result = parseTopupAmount(input);
      assert.equal(result.ok, false, JSON.stringify(input));
      return (result as { message: string }).message;
    };
    assert.equal(refused(""), TOPUP_AMOUNT_MESSAGES.empty);
    assert.equal(refused("   "), TOPUP_AMOUNT_MESSAGES.empty);
    assert.equal(refused(undefined), TOPUP_AMOUNT_MESSAGES.empty);
    assert.equal(refused(2000), TOPUP_AMOUNT_MESSAGES.empty, "un nombre n'est pas une saisie");
    assert.equal(refused("499"), TOPUP_AMOUNT_MESSAGES.tooLow);
    assert.equal(refused("400"), TOPUP_AMOUNT_MESSAGES.tooLow);
    assert.equal(refused("0"), TOPUP_AMOUNT_MESSAGES.tooLow);
    assert.equal(refused("100"), TOPUP_AMOUNT_MESSAGES.tooLow);
    assert.equal(refused("500001"), TOPUP_AMOUNT_MESSAGES.tooHigh);
    assert.equal(refused("500100"), TOPUP_AMOUNT_MESSAGES.tooHigh);
    assert.equal(refused("999999999999"), TOPUP_AMOUNT_MESSAGES.tooHigh);
    assert.equal(refused("99999999999999999999"), TOPUP_AMOUNT_MESSAGES.tooHigh);
    assert.equal(refused("550"), TOPUP_AMOUNT_MESSAGES.notMultiple);
    assert.equal(refused("2 550"), TOPUP_AMOUNT_MESSAGES.notMultiple);
    assert.equal(refused("501"), TOPUP_AMOUNT_MESSAGES.notMultiple);
    for (const input of ["12,5", "2.5", "2 500,00", "-1000", "+1000", "1e3", "abc", "1000 FCFA", "0x10", "٢٠٠٠", "２０００", "2_000"]) {
      assert.equal(refused(input), TOPUP_AMOUNT_MESSAGES.notInteger, input);
    }
    assert.match(TOPUP_AMOUNT_MESSAGES.tooLow, /500 FCFA/);
    assert.match(TOPUP_AMOUNT_MESSAGES.tooHigh, /500\s000 FCFA/);
    assert.match(TOPUP_AMOUNT_MESSAGES.notMultiple, /multiple de 100 FCFA/);
  });

  test("isValidTopupAmount : entiers sûrs aux bornes seulement", () => {
    for (const ok of [500, 600, 2_500, 499_900, 500_000]) assert.equal(isValidTopupAmount(ok), true, String(ok));
    for (const bad of [499, 400, 0, -500, 550, 500_100, 500_001, 2_500.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53, "2000", null, undefined, BigInt(2000)]) {
      assert.equal(isValidTopupAmount(bad), false, String(bad));
    }
  });
});

describe("clés d'idempotence : créées une fois par tentative, réutilisées à chaque essai", () => {
  test("même portée : la MÊME clé à chaque appel ; autre portée : une autre clé ; après oubli : une nouvelle", () => {
    let counter = 0;
    const keys = createIdempotencyKeys(() => `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`);
    const first = keys.keyFor("2000");
    assert.equal(keys.keyFor("2000"), first);
    assert.equal(keys.keyFor("2000"), first);
    assert.equal(counter, 1, "un seul tirage pour trois appels");
    const other = keys.keyFor("5000");
    assert.notEqual(other, first);
    assert.equal(keys.keyFor("5000"), other);
    assert.equal(keys.keyFor("2000"), first, "revenir à un montant déjà tenté retrouve sa clé");
    keys.forget("2000");
    const renewed = keys.keyFor("2000");
    assert.notEqual(renewed, first);
    assert.equal(keys.keyFor("2000"), renewed);
    assert.equal(keys.keyFor("5000"), other, "oublier une portée ne touche pas les autres");
  });

  test("UUID v4 valide pour le serveur : par randomUUID, par getRandomValues (repli), et avec le crypto global", () => {
    const fromUuid = newIdempotencyKey({ randomUUID: () => "123e4567-e89b-42d3-a456-426614174000" });
    assert.equal(fromUuid, "123e4567-e89b-42d3-a456-426614174000");
    // Repli : octets fixés, bits de version et de variante imposés.
    const fromBytes = newIdempotencyKey({ getRandomValues: ((array: Uint8Array) => (array.fill(0xff), array)) as never });
    assert.equal(fromBytes, "ffffffff-ffff-4fff-bfff-ffffffffffff");
    assert.equal(isUuid(fromBytes), true);
    const zeros = newIdempotencyKey({ getRandomValues: ((array: Uint8Array) => (array.fill(0), array)) as never });
    assert.equal(zeros, "00000000-0000-4000-8000-000000000000");
    // randomUUID qui ne renvoie pas un v4 : repli sur getRandomValues.
    const odd = newIdempotencyKey({ randomUUID: () => "pas-un-uuid", getRandomValues: ((array: Uint8Array) => (array.fill(1), array)) as never });
    assert.equal(isUuid(odd), true);
    // Crypto global de Node : deux tirages distincts, valides.
    const [a, b] = [newIdempotencyKey(), newIdempotencyKey()];
    assert.notEqual(a, b);
    assert.equal(isUuid(a) && isUuid(b), true);
    assert.throws(() => newIdempotencyKey({}), /aucune source aléatoire/);
  });
});

describe("adresses et retours : jamais une URL fournie par l'adresse", () => {
  test("chemin de paiement : seulement /paiement-simule/<uuid>", () => {
    assert.equal(isCheckoutPath(`/paiement-simule/${TOPUP_ID}`), true);
    for (const bad of [
      "/paiement-simule/",
      "/paiement-simule/abc",
      `/paiement-simule/${TOPUP_ID}/x`,
      `/paiement-simule/${TOPUP_ID}?next=/x`,
      `//evil.example/paiement-simule/${TOPUP_ID}`,
      `https://evil.example/paiement-simule/${TOPUP_ID}`,
      `/autre/${TOPUP_ID}`,
      "",
      null,
      undefined,
      42,
    ]) {
      assert.equal(isCheckoutPath(bad), false, String(bad));
    }
  });

  test("returnTarget : chemin interne conservé, tout le reste ramené au porte-monnaie", () => {
    assert.equal(returnTarget("/vendeur/annonces/abc"), "/vendeur/annonces/abc");
    assert.equal(returnTarget("/vendeur/annonces/abc?x=1#y"), "/vendeur/annonces/abc?x=1#y");
    for (const hostile of [
      "https://evil.example/x",
      "http://evil.example",
      "//evil.example/x",
      "/\\evil.example",
      "javascript:alert(1)",
      "/connexion",
      "/verification",
      "",
      null,
      undefined,
      42,
      "/a\nb",
    ]) {
      assert.equal(returnTarget(hostile), WALLET_PATH, String(hostile));
    }
    assert.equal(returnTarget("https://evil.example", "/compte"), "/compte");
  });

  test("walletHref : recharge ouverte et retour nettoyé", () => {
    assert.equal(walletHref(), WALLET_PATH);
    assert.equal(walletHref({ recharge: true }), `${WALLET_PATH}?recharger=1`);
    assert.equal(walletHref({ next: `/vendeur/annonces/${OFFER_ID}`, recharge: true }), `${WALLET_PATH}?recharger=1&next=%2Fvendeur%2Fannonces%2F${OFFER_ID}`);
    assert.equal(walletHref({ next: "https://evil.example/x" }), WALLET_PATH, "next hostile ignoré");
    assert.equal(walletHref({ next: "//evil.example", recharge: true }), `${WALLET_PATH}?recharger=1`);
    assert.equal(walletHref({ next: "/" }), WALLET_PATH);
    assert.equal(walletHref({ next: null }), WALLET_PATH);
  });

  test("checkoutHref : chemin du serveur vérifié, retour nettoyé ; jamais d'adresse construite sur une valeur douteuse", () => {
    assert.equal(checkoutHref(`/paiement-simule/${TOPUP_ID}`), `/paiement-simule/${TOPUP_ID}`);
    assert.equal(
      checkoutHref(`/paiement-simule/${TOPUP_ID}`, `/vendeur/annonces/${OFFER_ID}`),
      `/paiement-simule/${TOPUP_ID}?next=${encodeURIComponent(`/vendeur/annonces/${OFFER_ID}`)}`,
    );
    assert.equal(checkoutHref(`/paiement-simule/${TOPUP_ID}`, "https://evil.example/x"), `/paiement-simule/${TOPUP_ID}`);
    assert.equal(checkoutHref(`/paiement-simule/${TOPUP_ID}`, "//evil.example"), `/paiement-simule/${TOPUP_ID}`);
    assert.equal(checkoutHref("https://evil.example/paiement-simule/" + TOPUP_ID, "/x"), null);
    assert.equal(checkoutHref("/autre-page", "/x"), null);
    assert.equal(checkoutHref(undefined), null);
  });

  test("libellé du lien de retour selon la destination", () => {
    assert.equal(returnLinkLabel(WALLET_PATH), "Voir mon porte-monnaie");
    assert.equal(returnLinkLabel(`/vendeur/annonces/${OFFER_ID}`), "Retour à mon annonce");
    assert.equal(returnLinkLabel(`/vendeur/annonces/${OFFER_ID}?x=1`), "Retour à mon annonce");
    assert.equal(returnLinkLabel("/alertes"), "Continuer");
    assert.equal(returnLinkLabel("/vendeur/annonces"), "Continuer");
  });
});

describe("page de paiement simulé : états", () => {
  test("bandeau : « SIMULATION — aucun argent réel »", () => {
    assert.equal(SIMULATION_BANNER, "SIMULATION — aucun argent réel");
  });

  test("état lu : en attente, réussi, échoué, expiré", () => {
    assert.deepEqual(checkoutView({ topup: null, failure: null }), { kind: "loading" });
    const pending = checkoutView({ topup: topup(), failure: null });
    assert.equal(pending.kind, "pending");
    assert.match((pending as { amountText: string }).amountText, /^2\s000 FCFA$/);
    const done = checkoutView({ topup: topup({ status: "succeeded", amountXof: 5_000 }), failure: null });
    assert.equal(done.kind, "succeeded");
    assert.match((done as { message: string }).message, /^Votre porte-monnaie a été crédité de 5\s000 FCFA\.$/);
    const failed = checkoutView({ topup: topup({ status: "failed" }), failure: null });
    assert.deepEqual([failed.kind, (failed as { message: string }).message], ["failed", CHECKOUT_MESSAGES.failed]);
    const expired = checkoutView({ topup: topup({ status: "expired" }), failure: null });
    assert.deepEqual([expired.kind, (expired as { message: string }).message], ["expired", CHECKOUT_MESSAGES.expired]);
    for (const text of [CHECKOUT_MESSAGES.failed, CHECKOUT_MESSAGES.expired]) assert.match(text, /pas été crédité/);
  });

  test("recharge déjà terminée avant la visite (paidHere faux) : réussie → « déjà été créditée… une seule fois » (jamais « a été crédité de », réservé au paiement fait sur cette page) ; échouée ou expirée → « terminée sans paiement » (lots P3 et P3-bis)", () => {
    const done = topup({ status: "succeeded", amountXof: 5_000 });
    const alreadyDone = checkoutView({ topup: done, failure: null, paidHere: false });
    assert.equal(alreadyDone.kind, "succeeded");
    const credited = (alreadyDone as { message: string }).message;
    assert.equal(credited, checkoutAlreadyCreditedMessage(formatFcfa(5_000)));
    assert.match(credited, /^Cette recharge a déjà été créditée sur votre porte-monnaie \(5\s000 FCFA, une seule fois\)\.$/);
    assert.equal(credited.includes("a été crédité de"), false, "jamais la phrase du paiement immédiat");
    assert.equal(credited.includes("n'a rien ajouté"), false, "plus de message alarmant (lot P3-bis)");
    assert.equal(credited.includes("avant cette visite"), false);
    assert.match((checkoutView({ topup: done, failure: null, paidHere: true }) as { message: string }).message, /^Votre porte-monnaie a été crédité de 5\s000 FCFA\.$/);
    assert.match((checkoutView({ topup: done, failure: null }) as { message: string }).message, /a été crédité de/);
    // Échouée ou expirée déjà terminée : « terminée sans paiement », même type d'écran ; vue de la page qui l'a payée (ou absente) : messages d'origine.
    for (const status of ["failed", "expired"] as const) {
      const view = checkoutView({ topup: topup({ status }), failure: null, paidHere: false }) as { kind: string; message: string };
      assert.equal(view.kind, status);
      assert.equal(view.message, "Cette recharge est terminée sans paiement : aucun montant n'a été crédité.");
      assert.equal(view.message, CHECKOUT_MESSAGES.alreadyEndedUnpaid);
      const here = checkoutView({ topup: topup({ status }), failure: null, paidHere: true }) as { message: string };
      assert.equal(here.message, status === "failed" ? CHECKOUT_MESSAGES.failed : CHECKOUT_MESSAGES.expired);
      assert.deepEqual(checkoutView({ topup: topup({ status }), failure: null }), checkoutView({ topup: topup({ status }), failure: null, paidHere: true }));
    }
    // En attente : inchangé quel que soit paidHere.
    assert.deepEqual(checkoutView({ topup: topup(), failure: null, paidHere: false }), checkoutView({ topup: topup(), failure: null, paidHere: true }));
  });

  test("lecture en échec : 404 introuvable, 503 indisponible (fictif inactif), le reste = erreur à réessayer", () => {
    assert.deepEqual(checkoutView({ topup: null, failure: { status: 404, code: "resource_not_found" } }), { kind: "not_found", message: CHECKOUT_MESSAGES.notFound });
    assert.deepEqual(checkoutView({ topup: null, failure: { status: 503, code: "payment_unavailable" } }), { kind: "unavailable", message: CHECKOUT_MESSAGES.unavailable });
    assert.deepEqual(checkoutView({ topup: null, failure: { status: 0, code: "network_error" } }), { kind: "error", message: CHECKOUT_MESSAGES.error });
    assert.deepEqual(checkoutView({ topup: null, failure: { status: 500, code: "x" } }), { kind: "error", message: CHECKOUT_MESSAGES.error });
    // Une recharge lue l'emporte sur une ancienne erreur.
    assert.equal(checkoutView({ topup: topup(), failure: { status: 503, code: "payment_unavailable" } }).kind, "pending");
    for (const text of Object.values(CHECKOUT_MESSAGES)) assert.equal(/[a-z]+_[a-z]+/.test(text), false, text);
  });
});

describe("compte à rebours ancré : fenêtre − temps écoulé sur l'horloge monotone", () => {
  test("fenêtre = expiresAt − computedAt ; décompte depuis la réception", () => {
    const clock = anchorQuote(quote(), 5_000);
    assert.deepEqual(clock, { windowMs: 900_000, receivedAtMs: 5_000 });
    assert.equal(anchoredRemainingMs(clock, 5_000), 900_000);
    assert.equal(anchoredRemainingMs(clock, 6_000), 899_000);
    assert.equal(anchoredRemainingMs(clock, 5_000 + 450_000), 450_000);
    assert.equal(anchoredRemainingMs(clock, 5_000 + 899_999), 1);
    assert.equal(anchoredRemainingMs(clock, 5_000 + 900_000), 0);
    assert.equal(anchoredRemainingMs(clock, 5_000 + 5_000_000), 0);
  });

  test("jamais au-delà de la fenêtre ni négatif, même si la lecture précède la réception", () => {
    const clock = anchorQuote(quote(), 5_000);
    assert.equal(anchoredRemainingMs(clock, 0), 900_000);
    assert.equal(anchoredRemainingMs(clock, -1_000_000), 900_000);
    assert.equal(anchoredRemainingMs(clock, Number.NaN), 0);
    assert.equal(anchoredRemainingMs(clock, Number.POSITIVE_INFINITY), 0);
  });

  test("l'horloge murale décalée de +1 h ou de −1 h est SANS effet", () => {
    const clock = anchorQuote(quote(), 5_000);
    const q = quote();
    const readings = [5_000, 6_000, 300_000, 905_000, 1_000_000];
    const baseline = readings.map((now) => [anchoredRemainingMs(clock, now), anchoredQuoteValidity(q, clock, now)]);
    const realNow = Date.now;
    const RealDate = Date;
    try {
      for (const skew of [3_600_000, -3_600_000, 86_400_000, -86_400_000]) {
        Date.now = () => realNow() + skew;
        const skewed = readings.map((now) => [anchoredRemainingMs(clock, now), anchoredQuoteValidity(q, clock, now)]);
        assert.deepEqual(skewed, baseline, `décalage de ${skew} ms`);
        assert.deepEqual(
          historyEntryExpired(quote({ expired: false }), 2_000, 2_000 + 899_000),
          false,
          `historique, décalage de ${skew} ms`,
        );
      }
      // Une horloge murale figée n'y change rien non plus.
      Date.now = () => 0;
      assert.equal(anchoredRemainingMs(clock, 6_000), 899_000);
    } finally {
      Date.now = realNow;
    }
    assert.equal(Date, RealDate);
  });

  test("fenêtre bornée à 1 h ; dates illisibles ou inversées : le devis est tenu pour expiré, jamais pour valable", () => {
    const long = anchorQuote(quote({ computedAt: "2031-01-01T10:00:00.000Z", expiresAt: "2031-01-01T15:00:00.000Z" }), 0);
    assert.equal(long?.windowMs, MAX_QUOTE_WINDOW_MS);
    assert.equal(MAX_QUOTE_WINDOW_MS, 3_600_000);
    assert.equal(anchoredRemainingMs(long, 0), 3_600_000);
    for (const bad of [
      { computedAt: "n'importe quoi", expiresAt: "2031-01-01T10:15:00.000Z" },
      { computedAt: "2031-01-01T10:00:00.000Z", expiresAt: "n'importe quoi" },
      { computedAt: "2031-01-01T10:15:00.000Z", expiresAt: "2031-01-01T10:00:00.000Z" },
      { computedAt: "2031-01-01T10:00:00.000Z", expiresAt: "2031-01-01T10:00:00.000Z" },
    ]) {
      const clock = anchorQuote(bad, 0);
      assert.equal(clock, null);
      assert.equal(anchoredRemainingMs(clock, 0), 0);
      assert.deepEqual(anchoredQuoteValidity({ status: "available" }, clock, 0), { expired: true, text: "Ce devis a expiré. Demandez-en un nouveau." });
    }
    assert.equal(anchorQuote(quote(), Number.NaN), null);
  });

  test("texte : « Prix valable encore … » (devis disponible), « Résultat valable encore … » (indisponible), puis « expiré »", () => {
    const clock = anchorQuote(quote(), 0);
    assert.deepEqual(anchoredQuoteValidity({ status: "available" }, clock, 0), { expired: false, text: "Prix valable encore 15 min 0 s" });
    assert.deepEqual(anchoredQuoteValidity({ status: "available" }, clock, 1_500), { expired: false, text: "Prix valable encore 14 min 59 s" });
    assert.deepEqual(anchoredQuoteValidity({ status: "unavailable" }, clock, 840_000), { expired: false, text: "Résultat valable encore 1 min 0 s" });
    assert.equal(anchoredQuoteValidity({ status: "available" }, clock, 900_000).expired, true);
  });

  test("historique : expiré si le serveur l'a dit, ou une fenêtre entière après la lecture", () => {
    assert.equal(historyEntryExpired(quote({ expired: true }), 0, 0), true);
    assert.equal(historyEntryExpired(quote({ expired: false }), 0, 899_999), false);
    assert.equal(historyEntryExpired(quote({ expired: false }), 0, 900_000), true);
    assert.equal(historyEntryExpired(quote({ expired: false, computedAt: "n'importe quoi" }), 0, 0), true);
  });
});

describe("« Acheter » : actif seulement si le devis est valable et le solde suffit", () => {
  const ok = { quote: quote(), expired: false, balanceXof: 2_000 };

  test("devis disponible, valable, solde suffisant : prêt, solde après achat", () => {
    assert.deepEqual(buyState(ok), { kind: "ready", amountXof: 1_300, balanceXof: 2_000, balanceAfterXof: 700 });
    assert.equal(canBuy(buyState(ok), false), true);
  });

  test("solde exactement égal au prix : prêt (solde après achat 0) ; un franc de moins : insuffisant", () => {
    assert.deepEqual(buyState({ ...ok, balanceXof: 1_300 }), { kind: "ready", amountXof: 1_300, balanceXof: 1_300, balanceAfterXof: 0 });
    const short = buyState({ ...ok, balanceXof: 1_299 });
    assert.equal(short.kind, "insufficient");
    assert.equal(canBuy(short, false), false);
  });

  test("solde insuffisant : « Solde insuffisant (X FCFA) » avec le solde actuel, et ce qu'il manque", () => {
    const state = buyState({ ...ok, balanceXof: 0 });
    assert.equal(state.kind, "insufficient");
    const insufficient = state as Extract<typeof state, { kind: "insufficient" }>;
    assert.equal(insufficient.text, "Solde insuffisant (0 FCFA)");
    assert.equal(insufficient.balanceXof, 0);
    assert.equal(insufficient.missingXof, 1_300);
    assert.match(insufficient.detail, /^Il vous manque 1\s300 FCFA pour ce boost\.$/);
    assert.match((buyState({ ...ok, balanceXof: 700 }) as { text: string }).text, /^Solde insuffisant \(700 FCFA\)$/);
    assert.equal(BUY_LABELS.recharge, "Recharger");
  });

  test("devis expiré à l'écran : jamais actif, même avec un solde suffisant ; expiré prime sur solde insuffisant", () => {
    assert.deepEqual(buyState({ ...ok, expired: true }), { kind: "expired" });
    assert.deepEqual(buyState({ ...ok, expired: true, balanceXof: 0 }), { kind: "expired" });
    assert.equal(canBuy({ kind: "expired" }, false), false);
  });

  test("solde inconnu ou illisible : l'achat n'est jamais actif à l'aveugle", () => {
    for (const balance of [null, -1, 1.5, Number.NaN, 2 ** 53]) {
      assert.deepEqual(buyState({ ...ok, balanceXof: balance }), { kind: "balance_unknown" }, String(balance));
    }
    assert.match(BALANCE_UNKNOWN_TEXT, /solde n'a pas pu être lu/);
  });

  test("devis indisponible, absent, d'une autre devise ou sans prix entier positif : rien à acheter", () => {
    const none = { kind: "none" } as const;
    assert.deepEqual(buyState({ ...ok, quote: null }), none);
    assert.deepEqual(buyState({ ...ok, quote: quote({ status: "unavailable", amount: null }) }), none);
    assert.deepEqual(buyState({ ...ok, quote: quote({ status: "unavailable", amount: 1_300 }) }), none);
    assert.deepEqual(buyState({ ...ok, quote: quote({ currency: "EUR" }) }), none);
    for (const amount of [null, 0, -100, 1_300.5, Number.NaN, 2 ** 53]) {
      assert.deepEqual(buyState({ ...ok, quote: quote({ amount }) }), none, String(amount));
    }
    assert.deepEqual(buyState({ ...ok, quote: quote({ status: "unavailable", amount: null }), expired: true }), none);
  });

  test("canBuy : jamais pendant une requête en cours", () => {
    const ready = buyState(ok);
    assert.equal(canBuy(ready, true), false);
    assert.equal(canBuy(ready, false), true);
    for (const state of [buyState({ ...ok, balanceXof: 0 }), buyState({ ...ok, expired: true }), buyState({ ...ok, balanceXof: null })]) {
      assert.equal(canBuy(state, false), false);
    }
  });
});

describe("confirmation et suites d'un refus", () => {
  test("texte de confirmation : prix, durée, solde après achat", () => {
    assert.equal(
      purchaseConfirmationText({ amountXof: 1_300, durationCode: "3d", balanceXof: 2_000 }).replace(/\s/g, " "),
      "Vous allez payer 1 300 FCFA pour un boost de 3 jours. Solde après achat : 700 FCFA.",
    );
    assert.equal(
      purchaseConfirmationText({ amountXof: 500, durationCode: "24h", balanceXof: 500 }).replace(/\s/g, " "),
      "Vous allez payer 500 FCFA pour un boost de 24 h. Solde après achat : 0 FCFA.",
    );
    assert.equal(
      purchaseConfirmationText({ amountXof: 2_600, durationCode: "7d", balanceXof: 12_600 }).replace(/\s/g, " "),
      "Vous allez payer 2 600 FCFA pour un boost de 7 jours. Solde après achat : 10 000 FCFA.",
    );
  });

  test("bouton de confirmation : DÉSACTIVÉ pendant la requête (un double clic ne déclenche rien de plus)", () => {
    assert.deepEqual(confirmButtonState(false), { label: "Confirmer l'achat", disabled: false });
    assert.deepEqual(confirmButtonState(true), { label: "Achat en cours…", disabled: true });
  });

  test("après un refus : nouveau devis, solde relu, annonce rechargée, ou rien (réessai avec la MÊME clé)", () => {
    const quoteRefresh = { refreshQuote: true, refreshBalance: false, reloadOffer: false, closeConfirmation: true };
    for (const code of ["quote_expired", "quote_already_used", "quote_unavailable", "offer_already_boosted", "no_slot_available", "seller_boost_limit_reached", "idempotency_conflict"]) {
      assert.deepEqual(purchaseFollowUp({ status: 409, code }), quoteRefresh, code);
    }
    assert.deepEqual(purchaseFollowUp({ status: 409, code: "insufficient_balance" }), {
      refreshQuote: false,
      refreshBalance: true,
      reloadOffer: false,
      closeConfirmation: true,
    });
    for (const failure of [
      { status: 404, code: "resource_not_found" },
      { status: 409, code: "offer_not_eligible" },
    ]) {
      assert.deepEqual(purchaseFollowUp(failure), { refreshQuote: false, refreshBalance: false, reloadOffer: true, closeConfirmation: true });
    }
    // Panne réseau, 503, réponse inattendue, 400 : la confirmation reste ouverte.
    const nothing = { refreshQuote: false, refreshBalance: false, reloadOffer: false, closeConfirmation: false };
    for (const failure of [
      { status: 0, code: "network_error" },
      { status: 503, code: "boost_purchase_unavailable" },
      { status: 503, code: "reach_check_unavailable" },
      { status: 200, code: "invalid_response" },
      { status: 400, code: "invalid_request" },
      { status: 409, code: "code_inconnu" },
    ]) {
      assert.deepEqual(purchaseFollowUp(failure), nothing, JSON.stringify(failure));
    }
  });
});

// ─── Lot P2-bis ─────────────────────────────────────────────────────────────────────────────────

describe("compte à rebours d'un devis RÉUTILISÉ : ancré sur l'heure du serveur (en-tête Date), jamais sur l'âge perdu du devis", () => {
  const computedAt = Date.parse("2031-01-01T10:00:00.000Z");
  const reused = (ageMs: number, extra: Partial<BoostQuote> = {}) => quote({ serverTime: computedAt + ageMs, ...extra });

  test("un devis déjà vieux à la réception compte sa validité RÉELLE (fenêtre − âge − 1 s de résolution), pas la fenêtre entière", () => {
    // Prouvé avant correctif : 100 s plus tard l'écran disait 15 min 0 s pour ~800 s réels.
    for (const ageSeconds of [0, 1, 50, 100, 450, 800, 899]) {
      const clock = anchorQuote(reused(ageSeconds * 1000), 5_000);
      const expected = Math.max(0, Math.min(900_000, 900_000 - ageSeconds * 1000 - SERVER_DATE_RESOLUTION_MS));
      assert.equal(clock?.windowMs, expected, `âge ${ageSeconds} s`);
      assert.equal(anchoredRemainingMs(clock, 5_000), expected);
    }
    assert.equal(anchorQuote(reused(100_000), 0)?.windowMs, 799_000, "100 s d'âge : 799 s (800 s moins la résolution de l'en-tête)");
    assert.equal(anchoredQuoteValidity({ status: "available" }, anchorQuote(reused(100_000), 0), 0).text, "Prix valable encore 13 min 19 s");
  });

  test("jamais plus que le temps réel : le restant affiché ≤ le restant réel (à la seconde d'en-tête près), à chaque instant du décompte", () => {
    for (const ageMs of [0, 400, 999, 1_000, 1_500, 123_456, 600_000, 898_999]) {
      for (const subMs of [0, 250, 999]) {
        // Heure réelle du serveur dans la seconde de l'en-tête : Date = plancher à la seconde.
        const real = computedAt + ageMs + subMs;
        const header = Math.floor(real / 1000) * 1000;
        if (header < computedAt - SERVER_DATE_RESOLUTION_MS) continue;
        const clock = anchorQuote(quote({ serverTime: header }), 0);
        const realRemaining = computedAt + 900_000 - real;
        assert.ok(anchoredRemainingMs(clock, 0) <= Math.max(0, realRemaining), `âge ${ageMs}+${subMs} ms : ${anchoredRemainingMs(clock, 0)} ≤ ${realRemaining}`);
        // Le décompte ne dépasse jamais la validité réelle qui s'écoule ensuite.
        assert.ok(anchoredRemainingMs(clock, 60_000) <= Math.max(0, realRemaining - 60_000));
      }
    }
  });

  test("heure du serveur absente, nulle, illisible ou incohérente avec le devis : comportement d'avant (fenêtre entière), jamais d'exception", () => {
    const whole = 900_000;
    assert.equal(anchorQuote(quote(), 0)?.windowMs, whole, "serverTime null");
    assert.equal(anchorQuote({ computedAt: quote().computedAt, expiresAt: quote().expiresAt }, 0)?.windowMs, whole, "serverTime absent");
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, computedAt - 5_000, computedAt - 3_600_000, computedAt + 900_000 + 5_000, computedAt + 86_400_000, 0]) {
      assert.equal(anchorQuote(quote({ serverTime: bad }), 0)?.windowMs, whole, `heure incohérente ${String(bad)}`);
    }
  });

  test("bornes : en-tête de la seconde qui précède le calcul accepté ; à l'échéance (ou 1 s avant) : expiré", () => {
    assert.equal(anchorQuote(quote({ serverTime: computedAt - 600 }), 0)?.windowMs, 899_600, "−600 ms : plancher de la seconde d'en-tête, valide (bornée par la fenêtre moins la résolution)");
    assert.equal(anchorQuote(quote({ serverTime: computedAt + 899_000 }), 0)?.windowMs, 0, "1 s avant l'échéance : on ne promet plus rien");
    assert.equal(anchorQuote(quote({ serverTime: computedAt + 900_000 }), 0)?.windowMs, 0);
    assert.equal(anchorQuote(quote({ serverTime: computedAt + 900_500 }), 0)?.windowMs, 0, "tolérance d'une seconde après l'échéance : expiré");
    assert.deepEqual(anchoredQuoteValidity({ status: "available" }, anchorQuote(quote({ serverTime: computedAt + 900_000 }), 0), 0), { expired: true, text: "Ce devis a expiré. Demandez-en un nouveau." });
  });

  test("l'horloge murale décalée de ±1 h reste SANS effet avec l'heure du serveur (l'heure du serveur n'est pas celle de l'appareil)", () => {
    const clock = anchorQuote(reused(100_000), 5_000);
    const baseline = [5_000, 60_000, 800_000].map((now) => anchoredRemainingMs(clock, now));
    const realNow = Date.now;
    try {
      for (const skew of [3_600_000, -3_600_000]) {
        Date.now = () => realNow() + skew;
        assert.deepEqual([5_000, 60_000, 800_000].map((now) => anchoredRemainingMs(clock, now)), baseline);
        assert.equal(anchorQuote(reused(100_000), 5_000)?.windowMs, clock?.windowMs);
      }
    } finally {
      Date.now = realNow;
    }
  });

  test("historique : l'expiration s'appuie aussi sur l'heure du serveur de la relecture", () => {
    assert.equal(historyEntryExpired(quote({ expired: false, serverTime: computedAt + 899_500 }), 0, 0), true, "à moins d'une seconde de l'échéance");
    assert.equal(historyEntryExpired(quote({ expired: false, serverTime: computedAt + 100_000 }), 0, 700_000), false);
    assert.equal(historyEntryExpired(quote({ expired: false, serverTime: computedAt + 100_000 }), 0, 799_000), true, "799 s de restant à la lecture, écoulées");
  });

  test("re-ancrage d'un devis affiché après une relecture : repart de la validité réelle ; expiré à la lecture = expiré à l'écran ; absent = inchangé", () => {
    const shown = { quote: quote(), clock: anchorQuote(quote(), 1_000) };
    const reread = (extra: Partial<BoostQuote>) => [quote({ expired: false, ...extra })];
    // Le décompte local avait avancé à 780 s ; la relecture (heure du serveur) dit qu'il reste 600 s (veille de l'appareil).
    const slept = reanchorQuote(shown, reread({ serverTime: computedAt + 300_000 }), 9_000);
    assert.equal(slept.clock?.windowMs, 599_000);
    assert.equal(slept.clock?.receivedAtMs, 9_000);
    assert.equal(slept.quote, shown.quote, "le devis affiché est conservé (aucun prix glissé en silence)");
    // Expiré côté serveur à la lecture : expiré à l'écran, quel que soit le décompte local.
    const expired = reanchorQuote(shown, reread({ expired: true }), 9_000);
    assert.equal(anchoredRemainingMs(expired.clock, 9_000), 0);
    assert.equal(anchoredQuoteValidity({ status: "available" }, expired.clock, 9_000).expired, true);
    // Devis absent de la relecture : inchangé (même objet).
    assert.equal(reanchorQuote(shown, [quote({ id: "99999999-9999-4999-8999-999999999990" })], 9_000), shown);
    assert.equal(reanchorQuote(shown, [], 9_000), shown);
  });
});

describe("achat : suites d'un échec dont le résultat est inconnu, bouton pendant un nouveau devis, clés persistées, zéros de tête", () => {
  test("résultat inconnu (réseau, réponse illisible, 5xx) ≠ refus explicite : seul l'inconnu propose « Vérifier / réessayer »", () => {
    for (const failure of [
      { status: 0, code: "network_error" },
      { status: 200, code: "invalid_response" },
      { status: 201, code: "invalid_response" },
      { status: 500, code: "x" },
      { status: 503, code: "boost_purchase_unavailable" },
      { status: 502, code: "invalid_response" },
    ]) assert.equal(isPurchaseOutcomeUnknown(failure), true, JSON.stringify(failure));
    for (const failure of [
      { status: 400, code: "invalid_request" },
      { status: 401, code: "authentication_required" },
      { status: 403, code: "invalid_origin" },
      { status: 404, code: "resource_not_found" },
      { status: 409, code: "quote_expired" },
      { status: 409, code: "insufficient_balance" },
      { status: 429, code: "rate_limited" },
      { status: 0, code: "aborted" },
      { status: 0, code: "invalid_argument" },
      // Lot P3-bis : vérification de la portée non terminée = réponse EXPLICITE du serveur (transaction annulée, rien de débité) : ce n'est pas un résultat inconnu.
      { status: 503, code: "reach_check_unavailable" },
    ]) assert.equal(isPurchaseOutcomeUnknown(failure), false, JSON.stringify(failure));
    // Mais ce même code derrière un autre statut (proxy, 502) ne prouve rien : inconnu.
    assert.equal(isPurchaseOutcomeUnknown({ status: 502, code: "reach_check_unavailable" }), true);
    assert.match(UNRESOLVED_PURCHASE_TEXT, /Vérifier \/ réessayer/);
    // Lot P3 : la relecture n'a pas trouvé l'achat, mais il peut encore aboutir : jamais « aucun débit » (faux : le débit peut arriver ensuite).
    assert.match(PURCHASE_NOT_RECORDED_TEXT, /Pas encore enregistré : l'achat peut encore aboutir\./);
    assert.equal(PURCHASE_NOT_RECORDED_TEXT.includes("aucun débit"), false);
    assert.equal(UNRESOLVED_PURCHASE_TEXT.includes("aucun débit"), false);
    assert.equal(BUY_LABELS.verify, "Vérifier / réessayer");
    assert.equal(BUY_LABELS.refreshBalance, "Relire mon solde");
  });

  test("« Confirmer l'achat » est désactivé dès qu'un devis est demandé (et pendant la requête), actif sinon", () => {
    assert.deepEqual(confirmButtonState(false, false), { label: "Confirmer l'achat", disabled: false });
    assert.deepEqual(confirmButtonState(false), { label: "Confirmer l'achat", disabled: false });
    assert.deepEqual(confirmButtonState(false, true), { label: "Mise à jour du prix…", disabled: true });
    assert.deepEqual(confirmButtonState(true, false), { label: "Achat en cours…", disabled: true });
    assert.deepEqual(confirmButtonState(true, true), { label: "Achat en cours…", disabled: true });
  });

  test("« Acheter » reste désactivé pendant une demande de devis (canBuy)", () => {
    const ready = buyState({ quote: quote(), expired: false, balanceXof: 5_000 });
    assert.equal(canBuy(ready, false), true);
    assert.equal(canBuy(ready, true), false);
  });

  test("texte de succès : exact, sans promesse de position ni de vente", () => {
    assert.match(BOOST_SUCCESS_NOTE, /^Votre boost est actif : votre annonce peut monter dans les résultats des acheteurs concernés, avec le badge « Sponsorisé », parmi des offres déjà pertinentes\./);
    assert.match(BOOST_SUCCESS_NOTE, /Ce n'est pas une garantie de position ni de vente\.$/);
    assert.equal(/est mise en avant/.test(BOOST_SUCCESS_NOTE), false);
  });

  test("clés d'idempotence persistées (sessionStorage) : survivent au changement de page, oubliées sur demande, valeur douteuse ou stockage en panne ignorés", () => {
    const store = new Map<string, string>();
    const storage: KeyStorage = { getItem: (key) => store.get(key) ?? null, setItem: (key, value) => void store.set(key, value), removeItem: (key) => void store.delete(key) };
    let counter = 0;
    const generate = () => `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`;
    const first = createIdempotencyKeys(generate, storage, "t:");
    const key = first.keyFor("2000");
    assert.equal(store.get("t:2000"), key, "écrite dans le stockage");
    // « Autre page » : une nouvelle instance retrouve la MÊME clé (aucune seconde intention créée).
    const second = createIdempotencyKeys(generate, storage, "t:");
    assert.equal(second.keyFor("2000"), key);
    assert.equal(counter, 1, "un seul tirage pour deux pages");
    assert.notEqual(second.keyFor("5000"), key);
    second.forget("2000");
    assert.equal(store.has("t:2000"), false, "effacée du stockage");
    assert.notEqual(createIdempotencyKeys(generate, storage, "t:").keyFor("2000"), key, "recharge terminée : clé neuve");
    // Valeur stockée qui n'est pas un UUID v4 : ignorée et remplacée.
    store.set("t:300", "pas-un-uuid");
    const replaced = createIdempotencyKeys(generate, storage, "t:").keyFor("300");
    assert.match(replaced, /^[0-9a-f-]{36}$/);
    assert.equal(store.get("t:300"), replaced);
    // Stockage qui lève (navigation privée, quota) : la clé reste en mémoire, mêmes appels = même clé, aucune exception.
    const broken: KeyStorage = {
      getItem: () => { throw new Error("SecurityError"); },
      setItem: () => { throw new Error("QuotaExceededError"); },
      removeItem: () => { throw new Error("SecurityError"); },
    };
    const inMemory = createIdempotencyKeys(generate, broken);
    const memoryKey = inMemory.keyFor("2000");
    assert.equal(inMemory.keyFor("2000"), memoryKey);
    assert.doesNotThrow(() => inMemory.forget("2000"));
    assert.notEqual(inMemory.keyFor("2000"), memoryKey);
    // Sans stockage : comportement d'avant.
    const plain = createIdempotencyKeys(generate);
    assert.equal(plain.keyFor("a"), plain.keyFor("a"));
  });

  test("clés de recharge : préfixe dédié, par montant ; sans sessionStorage : mémoire seulement", () => {
    assert.equal(TOPUP_KEY_PREFIX, "noma:topup-key:");
    // Selon la version de Node, un sessionStorage global existe ou non : dans les deux cas, jamais d'exception.
    const available = browserSessionStorage();
    assert.ok(available === undefined || (typeof available.getItem === "function" && typeof available.setItem === "function" && typeof available.removeItem === "function"));
    const store = new Map<string, string>();
    const storage: KeyStorage = { getItem: (key) => store.get(key) ?? null, setItem: (key, value) => void store.set(key, value), removeItem: (key) => void store.delete(key) };
    const keys = createTopupKeys(storage);
    const key = keys.keyFor("2000");
    assert.equal(store.get("noma:topup-key:2000"), key);
    assert.equal(createTopupKeys(storage).keyFor("2000"), key);
    createTopupKeys(storage).forget("2000");
    assert.equal(store.size, 0);
    assert.equal(isUuid(createTopupKeys(undefined).keyFor("2000")), true);
  });

  test("montant de recharge : zéros de tête ignorés (« 000000000500 » = 500), jamais « maximum 500 000 » pour un petit montant", () => {
    for (const [input, expected] of [["000000000500", 500], ["0000000000000000500", 500], ["0 000 000 000 600", 600], ["0001000", 1_000], ["00500000", 500_000]] as const) {
      assert.deepEqual(parseTopupAmount(input), { ok: true, amountXof: expected }, input);
    }
    for (const [input, message] of [
      ["0", TOPUP_AMOUNT_MESSAGES.tooLow],
      ["00", TOPUP_AMOUNT_MESSAGES.tooLow],
      ["0000000000", TOPUP_AMOUNT_MESSAGES.tooLow],
      ["000000000499", TOPUP_AMOUNT_MESSAGES.tooLow],
      ["000000000550", TOPUP_AMOUNT_MESSAGES.notMultiple],
      ["1000000000", TOPUP_AMOUNT_MESSAGES.tooHigh],
      ["0001000000000", TOPUP_AMOUNT_MESSAGES.tooHigh],
      ["000000500100", TOPUP_AMOUNT_MESSAGES.tooHigh],
    ] as const) {
      const result = parseTopupAmount(input);
      assert.equal(result.ok, false, input);
      assert.equal((result as { message: string }).message, message, input);
    }
  });

  test("type de transaction inconnu : « Opération » avec son montant signé, jamais le code brut", () => {
    const row = walletRow({ id: "c3333333-3333-4333-8333-333333333333", kind: "unknown", amountXof: -750, promoAmountXof: 0, createdAt: "2031-01-01T10:00:00.000Z" }, "UTC");
    assert.equal(row.label, "Opération");
    assert.match(row.amountText, /^−750 FCFA$/);
    assert.equal(row.tone, "debit");
  });
});

describe("relectures automatiques d'un achat au résultat inconnu (lot P3)", () => {
  test("délais exacts : 2 s, 5 s, 10 s depuis l'incident", () => {
    assert.deepEqual([...PURCHASE_RECHECK_DELAYS_MS], [2_000, 5_000, 10_000]);
    assert.ok(Object.isFrozen(PURCHASE_RECHECK_DELAYS_MS));
  });

  test("schedulePurchaseRechecks : trois minuteries aux bons délais, rang 0, 1, 2 ; l'annulation les efface toutes", () => {
    const timers: Array<{ id: number; ms: number; callback: () => void; cleared: boolean }> = [];
    const fake = {
      set: (callback: () => void, ms: number) => { const entry = { id: timers.length, ms, callback, cleared: false }; timers.push(entry); return entry.id; },
      clear: (handle: unknown) => { timers[handle as number].cleared = true; },
    };
    const ticks: number[] = [];
    const cancel = schedulePurchaseRechecks((attempt) => ticks.push(attempt), fake);
    assert.deepEqual(timers.map((timer) => timer.ms), [2_000, 5_000, 10_000]);
    timers[0].callback();
    timers[2].callback();
    assert.deepEqual(ticks, [0, 2]);
    cancel();
    assert.deepEqual(timers.map((timer) => timer.cleared), [true, true, true]);
  });

  test("avec les vraies minuteries : annulée avant le premier délai, aucune relecture ne part", async () => {
    const ticks: number[] = [];
    const cancel = schedulePurchaseRechecks((attempt) => ticks.push(attempt));
    cancel();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(ticks, []);
  });
});

describe("recharge : clé d'idempotence d'une intention déjà terminée (lot P3)", () => {
  const memoryKeys = () => {
    let counter = 0;
    return createIdempotencyKeys(() => `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`);
  };
  const reply = (status: "pending" | "succeeded" | "failed" | "expired", reused: boolean) => ({ topup: { status, checkoutPath: "/paiement-simule/x" }, reused });

  test("intention réutilisée déjà TERMINÉE (réussie, échouée, expirée) : clé oubliée, clé neuve, recréée UNE seule fois", async () => {
    for (const status of ["succeeded", "failed", "expired"] as const) {
      const keys = memoryKeys();
      const sent: string[] = [];
      const result = await createTopupWithFreshKey({
        keys, scope: "5000", amountXof: 5_000,
        create: async (request) => {
          sent.push(request.idempotencyKey);
          return sent.length === 1 ? reply(status, true) : reply("pending", false);
        },
      });
      assert.equal(sent.length, 2, `${status} : deux envois exactement`);
      assert.notEqual(sent[0], sent[1], `${status} : clé neuve`);
      assert.equal(result.topup.status, "pending");
      assert.equal(keys.keyFor("5000"), sent[1], "la clé neuve est celle qui reste pour ce montant");
    }
  });

  test("intention en attente réutilisée, ou créée : un seul envoi, la clé reste", async () => {
    for (const [status, reused] of [["pending", true], ["pending", false], ["succeeded", false]] as const) {
      const keys = memoryKeys();
      let sends = 0;
      const first = keys.keyFor("2000");
      const result = await createTopupWithFreshKey({ keys, scope: "2000", amountXof: 2_000, create: async () => { sends += 1; return reply(status, reused); } });
      assert.equal(sends, 1, `${status}/${reused}`);
      assert.equal(result.topup.status, status);
      assert.equal(keys.keyFor("2000"), first);
    }
  });

  test("si la seconde création est elle aussi terminée, elle est rendue telle quelle : jamais plus de deux envois (pas de boucle)", async () => {
    const keys = memoryKeys();
    let sends = 0;
    const result = await createTopupWithFreshKey({ keys, scope: "1000", amountXof: 1_000, create: async () => { sends += 1; return reply("succeeded", true); } });
    assert.equal(sends, 2);
    assert.equal(result.topup.status, "succeeded");
  });

  test("une erreur du premier envoi est relancée (pas de seconde tentative cachée)", async () => {
    const keys = memoryKeys();
    let sends = 0;
    await assert.rejects(createTopupWithFreshKey({ keys, scope: "1000", amountXof: 1_000, create: async () => { sends += 1; throw new Error("réseau"); } }), /réseau/);
    assert.equal(sends, 1);
  });
});

describe("paiement par Wave (lot PAY1)", () => {
  const sublymusTopup = (overrides: Partial<WalletTopup> = {}): WalletTopup => topup({ provider: "sublymus", checkoutPath: `/paiement-retour/${TOPUP_ID}`, checkoutUrl: "https://pay.wave.example/c/pi_1", ...overrides });

  test("l'écran dit « Paiement par Wave », Wave seulement, et ne parle plus de simulation quand le prestataire actif est Sublymus", () => {
    assert.equal(WAVE_LABEL, "Paiement par Wave");
    assert.equal(rechargeNotice("sublymus"), WAVE_NOTICE);
    assert.match(WAVE_NOTICE, /^Paiement par Wave : vous êtes redirigé vers Wave/);
    assert.match(WAVE_NOTICE, /Wave seulement : pas d'Orange Money ni de MTN/);
    assert.match(WAVE_NOTICE, /crédité dès que Wave confirme/);
    assert.equal(/simul/i.test(WAVE_NOTICE), false);
    assert.equal(rechargeNotice("fake"), SIMULATION_NOTICE);
    assert.equal(rechargeNotice("none"), NO_PROVIDER_NOTICE);
  });

  test("lien de paiement : seulement https, sans identifiant, avant toute navigation", () => {
    assert.equal(externalCheckoutHref("https://pay.wave.example/c/pi_1"), "https://pay.wave.example/c/pi_1");
    for (const bad of ["http://pay.wave.example", "javascript:alert(1)", "data:text/html,x", "https://u:p@pay.wave.example", "https://pay.wave.example/a b", "", null, undefined, 42]) assert.equal(externalCheckoutHref(bad), null, String(bad));
  });

  test("retour du navigateur : « Paiement en cours de confirmation » tant que le serveur n'a rien confirmé, quoi que dise l'adresse de retour ; crédité seulement si le serveur le dit", () => {
    assert.deepEqual(returnView({ topup: null, failure: null, resultat: "succes" }), { kind: "loading" });
    for (const resultat of ["succes", "echec", null] as const) {
      const view = returnView({ topup: sublymusTopup({ status: "pending" }), failure: null, resultat });
      assert.equal(view.kind, "pending", `résultat ${resultat}`);
      if (view.kind === "pending") assert.equal(view.title, RETURN_PENDING_TITLE);
      assert.equal(RETURN_PENDING_TITLE, "Paiement en cours de confirmation");
    }
    const failedUrl = returnView({ topup: sublymusTopup({ status: "pending" }), failure: null, resultat: "echec" });
    assert.ok(failedUrl.kind === "pending" && /ne semble pas avoir abouti/.test(failedUrl.detail) && /sera alors crédité/.test(failedUrl.detail));
    const waited = returnView({ topup: sublymusTopup({ status: "pending" }), failure: null, resultat: "succes", waitedTooLong: true });
    assert.ok(waited.kind === "pending" && /quelques minutes/.test(waited.detail));
    const succeeded = returnView({ topup: sublymusTopup({ status: "succeeded" }), failure: null, resultat: "echec" });
    assert.ok(succeeded.kind === "succeeded" && /crédité de 2\s000\sFCFA, une seule fois/.test(succeeded.detail), "le statut du serveur prime sur l'adresse");
    assert.equal(returnView({ topup: sublymusTopup({ status: "failed" }), failure: null, resultat: "succes" }).kind, "failed");
    assert.equal(returnView({ topup: sublymusTopup({ status: "expired" }), failure: null, resultat: "succes" }).kind, "expired");
    assert.equal(returnView({ topup: null, failure: { status: 404, code: "resource_not_found" }, resultat: null }).kind, "not_found");
    assert.equal(returnView({ topup: null, failure: { status: 503, code: "payment_unavailable" }, resultat: null }).kind, "error");
    assert.equal(parseReturnResult("succes"), "succes");
    assert.equal(parseReturnResult("echec"), "echec");
    for (const bad of ["success", "SUCCES", "", null, undefined, 1]) assert.equal(parseReturnResult(bad), null);
    assert.equal(RETURN_POLL_INTERVAL_MS, 3_000);
    assert.equal(RETURN_POLL_WINDOW_MS, 120_000);
  });
});
