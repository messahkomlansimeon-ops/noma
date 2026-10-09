import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ActiveSearchState } from "../../lib/client/active-search-api";
import { ApiError } from "../../lib/client/api";
import {
  ACTIVE_SEARCH_BENEFITS, ACTIVE_SEARCH_PRICE_NOTICE, ACTIVE_SEARCH_RULES, EXPIRING_BADGE, EXTERNAL_MATCH_BADGE, EXTERNAL_NOTIFICATION_NOTE, activeSearchPriceText, activeSearchView, canPurchase,
  expiringTitle, externalMatchSubtitle, hidesCardOnLoadFailure, purchaseConfirmationText, purchaseDoneText, purchaseState, trackingMaximumText,
} from "../../lib/client/active-search-view";

/** Présentation de la recherche active (lot RA1) : fonctions pures, tout en mots simples, règles dites AVANT l'achat. */

const plain = (text: string): string => text.replace(/[  ]/g, " ");
const state = (overrides: Partial<ActiveSearchState> = {}): ActiveSearchState => ({
  priceProvisional: true, paidCreditsOnly: true, autoRenew: false, demandId: "22222222-2222-4222-8222-222222222222", demandStatus: "active", active: false, suspended: false, startsAt: null, endsAt: null,
  remainingDays: null, purchasedPeriods: 0, nextEndsAt: "2031-02-01T10:00:00.000Z", maxEndsAt: "2031-07-01T10:00:00.000Z", canPurchase: true, blockedReason: null, expiringSoon: false,
  priceXof: 2_000, durationDays: 30, balanceXof: 5_000, readAt: "2031-01-02T10:00:00.000Z", ...overrides,
});
const activeState = (overrides: Partial<ActiveSearchState> = {}): ActiveSearchState =>
  state({ active: true, startsAt: "2031-01-02T10:00:00.000Z", endsAt: "2031-02-01T10:00:00.000Z", remainingDays: 30, purchasedPeriods: 1, nextEndsAt: "2031-03-03T10:00:00.000Z", ...overrides });

describe("règles dites avant l'achat", () => {
  test("crédits payés seulement, aucun renouvellement automatique, besoin satisfait = option SUSPENDUE (la période continue de courir, elle reprend à la réactivation), besoin archivé = arrêt sans remboursement, aucun remboursement automatique, avis 3 jours avant", () => {
    const rules = ACTIVE_SEARCH_RULES.join(" ");
    assert.match(rules, /pas avec vos crédits promotionnels/);
    assert.match(rules, /Aucun renouvellement automatique/);
    assert.match(rules, /prévenu 3 jours avant la fin/);
    assert.match(rules, /Si le besoin est marqué satisfait, l'option est suspendue : rien n'est notifié, mais la période continue de courir, sans prolongation ni remboursement, et elle reprend si vous réactivez le besoin\./);
    assert.match(rules, /Si le besoin est archivé, l'option s'arrête sans remboursement\./);
    assert.equal(/satisfait ou archivé/.test(rules), false, "plus de règle unique « satisfait ou archivé »");
    assert.match(rules, /Aucun remboursement automatique\./);
  });

  test("ce que l'option apporte : annonces NOUVELLES d'autres sites, collecte toutes les heures partagée, suivi jusqu'à 180 jours ; le prix est dit PROVISOIRE", () => {
    const benefits = ACTIVE_SEARCH_BENEFITS.join(" ");
    assert.match(benefits, /NOUVELLE annonce d'un autre site/);
    assert.match(benefits, /jusqu'à toutes les heures au lieu de toutes les 6 heures, dans la limite de ce que chaque site autorise/, "A5 : jamais une promesse ferme d'une collecte horaire");
    assert.equal(/(?<!jusqu'à )toutes les heures/.test(benefits), false, "« toutes les heures » n'apparaît que précédé de « jusqu'à »");
    assert.match(benefits, /partagée : les autres acheteurs du même produit en profitent aussi/);
    assert.match(benefits, /180 jours au lieu de 90/);
    assert.match(ACTIVE_SEARCH_PRICE_NOTICE, /^Prix provisoire/);
    assert.match(EXTERNAL_NOTIFICATION_NOTE, /jamais directement à l'annonce d'un autre site/);
  });

  test("aucun texte technique : ni code, ni identifiant", () => {
    for (const text of [...ACTIVE_SEARCH_RULES, ...ACTIVE_SEARCH_BENEFITS, ACTIVE_SEARCH_PRICE_NOTICE, EXTERNAL_NOTIFICATION_NOTE]) assert.equal(/[a-z]+_[a-z0-9_]+|undefined|NaN/.test(text), false, text);
  });
});

describe("prix et achat", () => {
  test("« 2 000 FCFA pour 30 jours »", () => {
    assert.equal(plain(activeSearchPriceText(state())), "2 000 FCFA pour 30 jours");
    assert.equal(plain(activeSearchPriceText(state({ durationDays: 1 }))), "2 000 FCFA pour 1 jour");
  });

  test("achat : prêt (solde suffisant), solde insuffisant (ce qu'il manque, crédits payés), bloqué (besoin inactif, 180 jours), illisible", () => {
    const ready = purchaseState(state({ balanceXof: 5_000 }));
    assert.equal(ready.kind, "ready");
    if (ready.kind !== "ready") return;
    assert.deepEqual([ready.priceXof, ready.balanceXof, ready.balanceAfterXof], [2_000, 5_000, 3_000]);
    assert.equal(purchaseState(state({ balanceXof: 2_000 })).kind, "ready", "exactement le prix : possible");
    const poor = purchaseState(state({ balanceXof: 1_500 }));
    assert.equal(poor.kind, "insufficient");
    if (poor.kind === "insufficient") {
      assert.equal(poor.missingXof, 500);
      assert.equal(poor.text.includes("Solde"), false, "pas le vocabulaire du porte-monnaie vendeur");
      assert.match(plain(poor.detail), /Il vous manque 500 FCFA\. Seuls vos crédits payés règlent la recherche active, pas les crédits promotionnels\./);
    }
    assert.deepEqual(purchaseState(state({ canPurchase: false, blockedReason: "max_horizon", nextEndsAt: null })), { kind: "blocked", reason: "max_horizon", text: "La recherche active ne peut pas dépasser 180 jours à partir d'aujourd'hui : vous pourrez la prolonger plus tard." });
    assert.equal(purchaseState(state({ canPurchase: false, blockedReason: "demand_not_active", nextEndsAt: null })).kind, "blocked");
    // B1 / A5 : les raisons d'indisponibilité ont leur texte fixe, sans bouton.
    assert.deepEqual(purchaseState(state({ canPurchase: false, blockedReason: "no_product_key", nextEndsAt: null })), { kind: "blocked", reason: "no_product_key", text: "Option indisponible pour ce besoin : il faut au moins une catégorie, une marque et un modèle." });
    assert.deepEqual(purchaseState(state({ canPurchase: false, blockedReason: "unavailable", nextEndsAt: null })), { kind: "blocked", reason: "unavailable", text: "La recherche active n'est pas encore disponible : aucune annonce d'un autre site n'est collectée pour le moment." });
    assert.deepEqual(purchaseState(state({ canPurchase: false, blockedReason: "capacity", nextEndsAt: null })), { kind: "blocked", reason: "capacity", text: "La collecte accélérée est complète pour le moment : réessayez plus tard." });
    assert.deepEqual(purchaseState(null), { kind: "none" });
    assert.equal(purchaseState(state({ balanceXof: -1 })).kind, "none");
    assert.equal(purchaseState(state({ priceXof: 0 })).kind, "none");
  });

  test("le bouton n'est actif que prêt et sans achat en cours (un double appui n'envoie rien de plus)", () => {
    const ready = purchaseState(state());
    assert.equal(canPurchase(ready, false), true);
    assert.equal(canPurchase(ready, true), false);
    assert.equal(canPurchase(purchaseState(state({ balanceXof: 0 })), false), false);
    assert.equal(canPurchase({ kind: "none" }, false), false);
  });

  test("confirmation : le montant, la nouvelle fin et le solde après ; message après achat (et après un achat déjà enregistré : pas de second débit)", () => {
    const ready = purchaseState(state({ balanceXof: 5_000 }));
    assert.equal(ready.kind, "ready");
    if (ready.kind !== "ready") return;
    const activation = plain(purchaseConfirmationText(ready, false));
    assert.match(activation, /^Activer la recherche active : 2 000 FCFA seront débités de vos crédits payés, jusqu'au \d{2}\/\d{2}\/\d{4} à \d{2}:\d{2}\. Il vous restera 3 000 FCFA\.$/);
    assert.match(purchaseConfirmationText(ready, true), /^Prolonger la recherche active/);
    assert.match(purchaseDoneText({ reused: false, kind: "activation", endsAt: "2031-02-01T10:00:00.000Z" }), /^Recherche active activée jusqu'au 01\/02\/2031\.$/);
    assert.match(purchaseDoneText({ reused: false, kind: "extension", endsAt: "2031-03-03T10:00:00.000Z" }), /^Recherche active prolongée jusqu'au 03\/03\/2031\.$/);
    assert.match(purchaseDoneText({ reused: true, kind: "activation", endsAt: "2031-02-01T10:00:00.000Z" }), /vous n'avez pas été débité une seconde fois/);
  });
});

describe("état de l'option", () => {
  test("désactivée : « Recherche active : désactivée » et « Activer — 2 000 FCFA pour 30 jours »", () => {
    const view = activeSearchView(state());
    assert.deepEqual([view.tone, view.headline, view.isExtension, view.applicable], ["off", "Recherche active : désactivée", false, true]);
    assert.equal(plain(view.buttonLabel), "Activer — 2 000 FCFA pour 30 jours");
  });

  test("en vigueur : la date de fin, les jours restants, « Prolonger de 30 jours — 2 000 FCFA » ; l'avis d'échéance dit qu'elle se termine bientôt", () => {
    const view = activeSearchView(activeState());
    assert.deepEqual([view.tone, view.headline, view.isExtension], ["active", "Recherche active jusqu'au 01/02/2031", true]);
    assert.match(view.detail, /Il reste 30 jours\./);
    assert.equal(plain(view.buttonLabel), "Prolonger de 30 jours — 2 000 FCFA");
    const soon = activeSearchView(activeState({ expiringSoon: true, remainingDays: 2 }));
    assert.match(soon.detail, /Elle se termine bientôt : prolongez-la pour continuer à être prévenu\./);
    assert.match(activeSearchView(activeState({ remainingDays: 1 })).detail, /Il reste 1 jour\./);
  });

  test("besoin qui n'est plus actif (archivé, brouillon) : rien à proposer", () => {
    const view = activeSearchView(state({ demandStatus: "archived" }));
    assert.deepEqual([view.tone, view.applicable, view.headline], ["closed", false, "Recherche active arrêtée"]);
  });

  test("A4 : besoin satisfait avec une période qui court → option SUSPENDUE : fin connue, rien n'est notifié, la période continue de courir, aucun achat proposé", () => {
    const view = activeSearchView(state({ demandStatus: "satisfied", suspended: true, endsAt: "2031-02-01T10:00:00.000Z", remainingDays: 30, canPurchase: false, blockedReason: "demand_not_active", nextEndsAt: null }));
    assert.deepEqual([view.tone, view.applicable, view.isExtension], ["paused", false, false]);
    assert.equal(view.headline, "Recherche active suspendue jusqu'au 01/02/2031");
    assert.match(view.detail, /marqué satisfait : rien n'est notifié tant qu'il ne redevient pas actif\. La période continue de courir ; si vous réactivez le besoin, la recherche active reprend\./);
  });

  test("B1 : sans clé produit → « Option indisponible pour ce besoin » ; collecte indisponible → « pas encore disponible » ; aucun achat proposé", () => {
    const noKey = activeSearchView(state({ canPurchase: false, blockedReason: "no_product_key", nextEndsAt: null }));
    assert.deepEqual([noKey.tone, noKey.applicable, noKey.headline], ["unavailable", false, "Option indisponible pour ce besoin"]);
    const unavailable = activeSearchView(state({ canPurchase: false, blockedReason: "unavailable", nextEndsAt: null }));
    assert.deepEqual([unavailable.tone, unavailable.applicable, unavailable.headline], ["unavailable", false, "Recherche active : pas encore disponible"]);
    assert.match(unavailable.detail, /aucune annonce d'un autre site n'est collectée pour le moment/);
    // Une option déjà EN VIGUEUR le reste, même si la collecte devient indisponible (seul un nouvel achat est refusé).
    const live = activeSearchView(activeState({ canPurchase: false, blockedReason: "unavailable", nextEndsAt: null }));
    assert.equal(live.tone, "active");
    // Capacité atteinte : l'option reste proposée comme « désactivée », l'achat bloqué par son texte.
    assert.equal(activeSearchView(state({ canPurchase: false, blockedReason: "capacity", nextEndsAt: null })).tone, "off");
  });
});

describe("notifications et suivi", () => {
  test("annonce d'un autre site : prix et source ; avis d'échéance avec la date ; pastilles", () => {
    assert.equal(plain(externalMatchSubtitle("150 000 FCFA", "Annonces Démo A")), "150 000 FCFA · Annonces Démo A, autre site");
    assert.equal(externalMatchSubtitle(null, "Annonces Démo A"), "Annonces Démo A, autre site");
    assert.equal(externalMatchSubtitle("150 000 FCFA", undefined), "150 000 FCFA · Autre site");
    assert.equal(externalMatchSubtitle(null, "  "), "Autre site");
    assert.equal(expiringTitle("2031-02-01T10:00:00.000Z"), "Votre recherche active se termine le 01/02/2031");
    assert.equal(expiringTitle(undefined), "Votre recherche active se termine bientôt");
    assert.deepEqual([EXTERNAL_MATCH_BADGE, EXPIRING_BADGE], ["Autre site", "Recherche active"]);
  });

  test("plafond du suivi : 90 jours sans l'option, 180 jours pendant l'option (le plafond vient du serveur)", () => {
    assert.equal(trackingMaximumText({ readAt: "2031-01-01T00:00:00.000Z", maxUntil: "2031-04-01T00:00:00.000Z" }), "Déjà au maximum : 90 jours à partir d'aujourd'hui.");
    assert.equal(trackingMaximumText({ readAt: "2031-01-01T00:00:00.000Z", maxUntil: "2031-06-30T00:00:00.000Z" }), "Déjà au maximum : 180 jours à partir d'aujourd'hui.");
    assert.equal(trackingMaximumText({ readAt: "illisible", maxUntil: "illisible" }), "Déjà au maximum : 90 jours à partir d'aujourd'hui.");
  });
});

describe("besoin porteur d'une mission (lot MV1) : la carte ne s'affiche pas", () => {
  test("un 404 à la lecture de l'état (le besoin porteur répond comme un besoin d'autrui) masque la carte ; toute autre panne garde le message et « Réessayer »", () => {
    assert.equal(hidesCardOnLoadFailure(new ApiError(404, "resource_not_found", "Ressource introuvable.")), true);
    for (const failure of [new ApiError(500, "unavailable", "x"), new ApiError(503, "active_search_unavailable", "x"), new ApiError(401, "unauthorized", "x"), new ApiError(409, "demand_not_active", "x"), new Error("réseau"), null, undefined, "404"]) {
      assert.equal(hidesCardOnLoadFailure(failure), false, String(failure));
    }
  });
});
