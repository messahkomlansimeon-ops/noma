import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  ACTION_LABELS, confirmText, journalRow, pageWindow, settingsRows, summaryTiles, vendorRow, workerView,
} from "../../lib/client/admin-view";
import { favoriteRow, isFavorite } from "../../lib/client/favorites-view";
import {
  NO_PAYMENT_NOTICE, ORDER_ACTION_DONE, orderPath, orderRow, parsePriceInput, pendingForSeller, priceProblem, salesView, statusLabel, statusTone,
} from "../../lib/client/orders-view";
import type { AdminActionEntry, AdminBoostSettings, AdminSummary, AdminVendor, FavoriteItem, OfferSales, OrderView } from "../../lib/client/social-api";

/** Favoris, commandes et administration (lot D2) : présentation en fonctions pures. */

const OFFER = "1a1a1a1a-2b2b-4c3c-8d4d-5e5e5e5e5e5e";
const DEMAND = "2a2a2a2a-2b2b-4c3c-8d4d-5e5e5e5e5e5e";
const NOW = "2026-10-06T10:00:00.000Z";

describe("favoris", () => {
  const item = (overrides: Partial<FavoriteItem> = {}): FavoriteItem => ({ offerId: OFFER, demandId: DEMAND, title: "Apple iPhone 12 128 Go", price: { amount: 150_000, currency: "XOF" }, available: true, openable: true, createdAt: NOW, ...overrides });

  test("titre, prix, statut, lien vers la fiche par le besoin d'origine", () => {
    const row = favoriteRow(item());
    assert.equal(row.title, "Apple iPhone 12 128 Go");
    assert.match(String(row.priceText), /150\s?000 FCFA/);
    assert.equal(row.statusText, "En ligne");
    assert.equal(row.href, `/besoins/${DEMAND}/offres/${OFFER}`);
  });

  test("annonce retirée : « n'est plus disponible », plus de lien ; correspondance perdue : plus de lien non plus", () => {
    const gone = favoriteRow(item({ available: false, openable: false }));
    assert.match(gone.statusText, /n'est plus disponible/);
    assert.equal(gone.href, null);
    assert.equal(favoriteRow(item({ available: true, openable: false })).href, null);
    assert.equal(favoriteRow(item({ price: null })).priceText, null);
  });

  test("lot D3 : une annonce qui n'est plus disponible n'affiche plus de prix, même si le serveur en envoyait un ; une annonce en ligne garde son prix", () => {
    assert.equal(favoriteRow(item({ available: false, openable: false, price: { amount: 150_000, currency: "XOF" } })).priceText, null);
    assert.equal(favoriteRow(item({ available: false, openable: true })).priceText, null);
    assert.match(String(favoriteRow(item({ available: true })).priceText), /150\s?000 FCFA/);
  });

  test("le cœur de la fiche : présent ou non dans la liste", () => {
    assert.equal(isFavorite([item()], OFFER), true);
    assert.equal(isFavorite([item()], DEMAND), false);
    assert.equal(isFavorite([], OFFER), false);
  });
});

describe("commandes", () => {
  const order = (overrides: Partial<OrderView> = {}): OrderView => ({
    id: OFFER, role: "buyer", status: "proposed", price: { amount: 150_000, currency: "XOF" }, quantity: 1, title: "Apple iPhone 12", offerId: OFFER, demandId: DEMAND, missionId: null, conversationId: null,
    createdAt: NOW, decidedAt: null, canConfirm: false, canDecline: false, canCancel: true, canMarkDemandSatisfied: false, ...overrides,
  });

  test("prix saisi : entier de 1 à 100 000 000, espaces et « FCFA » tolérés, jamais de décimale ni de signe", () => {
    assert.equal(parsePriceInput("150 000"), 150_000);
    assert.equal(parsePriceInput("150 000 FCFA"), 150_000);
    assert.equal(parsePriceInput("1"), 1);
    assert.equal(parsePriceInput("100000000"), 100_000_000);
    for (const input of ["", "0", "100000001", "1,5", "1.5", "-5", "abc", "12e3", "０１２", "9999999999"]) assert.equal(parsePriceInput(input), null, input);
    assert.equal(priceProblem(""), null);
    assert.match(String(priceProblem("0")), /1 à 100 000 000/);
    assert.equal(priceProblem("150 000"), null);
  });

  test("états dits du point de vue du participant ; tons ; liens dans l'espace du participant", () => {
    assert.equal(statusLabel("proposed", "buyer"), "En attente du vendeur");
    assert.equal(statusLabel("proposed", "seller"), "À confirmer");
    assert.equal(statusLabel("confirmed", "buyer"), "Confirmée");
    assert.equal(statusLabel("declined", "seller"), "Refusée");
    assert.equal(statusLabel("cancelled", "buyer"), "Annulée");
    assert.equal(statusTone("proposed"), "carrot");
    assert.equal(statusTone("confirmed"), "sage");
    assert.equal(orderPath("buyer", OFFER), `/commandes/${OFFER}`);
    assert.equal(orderPath("seller", OFFER), `/vendeur/commandes/${OFFER}`);
  });

  test("ligne de liste : prix en FCFA, autre partie sans identité, « à confirmer » pour le vendeur", () => {
    const buyer = orderRow(order());
    assert.match(buyer.priceText, /150\s?000 FCFA/);
    assert.equal(buyer.needsAction, false);
    const seller = orderRow(order({ role: "seller", demandId: null, canConfirm: true, canDecline: true, canCancel: false }));
    assert.equal(seller.counterpart, "Acheteur intéressé");
    assert.equal(seller.needsAction, true);
    assert.equal(seller.href, `/vendeur/commandes/${OFFER}`);
    assert.equal(pendingForSeller([order(), order({ role: "seller", canConfirm: true }), order({ role: "seller", canConfirm: false, status: "confirmed" })]), 1);
  });

  test("lot MV1 : un achat de plusieurs unités dit la quantité dans la liste ; une seule unité garde le prix seul", () => {
    assert.match(orderRow(order({ quantity: 3 })).priceText, /^3 × 150\s?000 FCFA$/);
    assert.match(orderRow(order({ quantity: 1 })).priceText, /^150\s?000 FCFA$/);
  });

  test("aucun paiement de l'objet ne passe par noma : c'est écrit ; messages d'action", () => {
    assert.match(NO_PAYMENT_NOTICE, /noma ne gère aucun paiement de l'objet/);
    assert.deepEqual(Object.keys(ORDER_ACTION_DONE).sort(), ["cancel", "confirm", "decline"]);
  });

  test("ventes confirmées : arrondies, répartition seulement si l'annonce a eu un boost", () => {
    const sales = (overrides: Partial<OfferSales> = {}): OfferSales => ({ confirmed: { kind: "below", bound: 5 }, attributedToBoost: null, organic: null, ...overrides });
    assert.deepEqual(salesView(sales()), { total: "moins de 5", split: null });
    assert.deepEqual(salesView(sales({ confirmed: { kind: "approx", value: 10 }, attributedToBoost: { kind: "approx", value: 5 }, organic: { kind: "below", bound: 5 } })), { total: "environ 10", split: { boost: "environ 5", organic: "moins de 5" } });
  });
});

describe("administration", () => {
  const summary: AdminSummary = {
    accounts: { total: 22, active: 21, suspended: 1 }, offers: { total: 31, byStatus: { published: 30, draft: 1 } }, activeDemands: 14, confirmedMatches: 120, activeBoosts: 1,
    credits: { circulationXof: 25_000, topupsTodayCount: 2, topupsTodayXof: 7_000 }, conversations: { total: 1, messagesToday: 3 }, orders: { confirmed: 0, proposed: 1 },
    worker: { schemaReady: true, healthy: true, pendingEvents: 0, pendingJobs: 0, runningJobs: 0, deadLetter: 0, warnings: [], lastCompletedAt: NOW }, readAt: NOW,
  };

  test("tableau de bord : huit chiffres réels, l'état du worker", () => {
    const tiles = summaryTiles(summary);
    assert.deepEqual(tiles.map((tile) => tile.key), ["accounts", "offers", "demands", "matches", "boosts", "credits", "conversations", "orders"]);
    assert.equal(tiles.find((tile) => tile.key === "accounts")?.value, "22");
    assert.match(String(tiles.find((tile) => tile.key === "accounts")?.detail), /21 actifs · 1 suspendus/);
    assert.match(String(tiles.find((tile) => tile.key === "credits")?.value), /25\s?000 FCFA/);
    assert.match(String(tiles.find((tile) => tile.key === "credits")?.detail), /Recharges du jour : 2/);
    assert.match(String(tiles.find((tile) => tile.key === "offers")?.detail), /30 en ligne · 1 brouillons/);
    assert.equal(workerView(summary.worker).healthy, true);
    assert.match(workerView(summary.worker).headline, /en bonne santé/);
    const sick = workerView({ ...summary.worker, healthy: false, deadLetter: 2, warnings: [{ code: "dead_letter", message: "Des tâches ont échoué." }] });
    assert.match(sick.headline, /à surveiller/);
    assert.ok(sick.lines.some((line) => /Des tâches ont échoué/.test(line)));
    assert.match(workerView({ ...summary.worker, schemaReady: false, healthy: false }).headline, /base non prête/);
  });

  test("vendeurs : numéro masqué tel que reçu, actions selon le statut, jamais d'action sur un administrateur", () => {
    const vendor = (overrides: Partial<AdminVendor> = {}): AdminVendor => ({ id: OFFER, maskedPhone: "+•••••••••••03", offerCount: 4, publishedCount: 4, createdAt: NOW, status: "active", isAdmin: false, ...overrides });
    const active = vendorRow(vendor());
    assert.equal(active.maskedPhone, "+•••••••••••03");
    assert.equal(active.canSuspend, true);
    assert.equal(active.canReactivate, false);
    assert.equal(active.statusText, "Actif");
    assert.equal(active.offersText, "4 annonce(s) dont 4 en ligne");
    const suspended = vendorRow(vendor({ status: "suspended" }));
    assert.equal(suspended.canReactivate, true);
    assert.equal(suspended.canSuspend, false);
    assert.equal(vendorRow(vendor({ isAdmin: true })).canSuspend, false);
    assert.equal(vendorRow(vendor({ maskedPhone: null })).maskedPhone, "numéro inconnu");
    assert.match(confirmText("suspend", "+•••03"), /Suspendre le vendeur \+•••03 \?/);
    assert.match(confirmText("reactivate", "+•••03"), /Réactiver le vendeur/);
  });

  test("pagination, journal et réglages en lecture seule", () => {
    assert.deepEqual(pageWindow(0, 0, 20), { from: 0, to: 0, hasPrevious: false, hasNext: false });
    assert.deepEqual(pageWindow(45, 20, 20), { from: 21, to: 40, hasPrevious: true, hasNext: true });
    assert.deepEqual(pageWindow(45, 40, 20), { from: 41, to: 45, hasPrevious: true, hasNext: false });
    const entry: AdminActionEntry = { id: OFFER, action: "suspend_user", source: "admin_ui", byMaskedPhone: "+•••03", targetMaskedPhone: "+•••12", createdAt: NOW };
    assert.match(journalRow(entry).text, /Suspension · \+•••12 · par \+•••03/);
    assert.match(journalRow({ ...entry, action: "grant_admin", source: "command", byMaskedPhone: null }).text, /par commande admin:grant/);
    assert.equal(ACTION_LABELS.reactivate_user, "Réactivation");
    const settings: AdminBoostSettings[] = [
      { key: "default", slotRatio: 0.15, minSlots: 1, maxSlots: 50, maxActivePerSeller: 2, maxSellerSlotShare: 0.34, maxPromotedShare: 0.15, minRelevance: 60, pricingVersion: 1, baseAmountXof: 500, minAmountXof: 500, maxAmountXof: 50_000, quoteValiditySeconds: 900 },
      { key: "smartphones", slotRatio: 0.2, minSlots: null, maxSlots: null, maxActivePerSeller: 3, maxSellerSlotShare: null, maxPromotedShare: null, minRelevance: null, pricingVersion: null, baseAmountXof: null, minAmountXof: null, maxAmountXof: null, quoteValiditySeconds: null },
    ];
    const rows = settingsRows(settings);
    assert.equal(rows[0].title, "Par défaut (toutes catégories)");
    assert.ok(rows[0].lines.some((line) => /15 %/.test(line)) && rows[0].lines.some((line) => /500 FCFA/.test(line)) && rows[0].lines.some((line) => /15 min/.test(line)));
    assert.equal(rows[1].title, "Catégorie « smartphones »");
    assert.ok(rows[1].lines.some((line) => /hérité de « default »/.test(line)));
  });
});
