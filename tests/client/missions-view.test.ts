import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { checkMessageBody } from "../../lib/messages-text";
import type { MissionOrder, MissionProposal, MissionSummary, ProposalEngaged, ProposalLine } from "../../lib/client/missions-api";
import {
  EMPTY_MISSION_FORM,
  MISSION_ACTION_LABELS,
  STATUS_LABELS,
  formValuesOf,
  lineConversationPath,
  missionDraftMessage,
  missionPath,
  missionRow,
  orderLine,
  parseMissionForm,
  parseMissionHint,
  parseWholeNumber,
  percentOf,
  engagedLineView,
  proposalLineView,
  proposalSummary,
  statusLabel,
  statusTone,
} from "../../lib/client/missions-view";
import { MISSION_STATUSES } from "../../lib/missions-rules";

/** Présentation des missions (lot MV1) : modules purs, sans navigateur. */

const ID = "11111111-1111-4111-8111-111111111111";
const OFFER = "22222222-2222-4222-8222-222222222222";

const mission = (overrides: Partial<MissionSummary> = {}): MissionSummary => ({
  id: ID, status: "active", title: "20 × Apple iPhone 12", category: "Téléphones", brand: "Apple", model: "iPhone 12", variant: null, condition: "Occasion", quantity: 20, unit: "pièce",
  securedQuantity: 5, pendingQuantity: 2, unitBudgetXof: 170_000, totalBudgetXof: 3_200_000, committedXof: 700_000, location: "Abidjan", deadlineDays: 30, deadlineAt: "2031-02-01T10:00:00.000Z",
  demandId: OFFER, coveredQuantity: 7, evaluatedAt: "2031-01-02T10:00:00.000Z", activatedAt: "2031-01-02T10:00:00.000Z", closedAt: null, createdAt: "2031-01-02T10:00:00.000Z", updatedAt: "2031-01-02T10:00:00.000Z",
  canEdit: false, canActivate: false, canPause: true, canResume: false, canCancel: true, ...overrides,
});

const line = (overrides: Partial<ProposalLine> = {}): ProposalLine => ({ offerId: OFFER, vendor: "Vendeur 1", title: "Apple iPhone 12 128 Go", location: "Cocody", quantity: 2, unitPriceXof: 158_000, subtotalXof: 316_000, stock: 2, ...overrides });
const engaged = (overrides: Partial<ProposalEngaged> = {}): ProposalEngaged => ({ orderId: ID, status: "proposed", vendor: "Vendeur 2", offerId: OFFER, title: "Apple iPhone 12 128 Go", location: "Cocody", quantity: 2, unitPriceXof: 165_000, subtotalXof: 330_000, ...overrides });

describe("états", () => {
  test("un libellé et un ton pour chaque état, en mots simples", () => {
    for (const status of MISSION_STATUSES) {
      assert.ok(statusLabel(status).length > 3, status);
      assert.ok(["carrot", "sage", "wash", "sky"].includes(statusTone(status)), status);
    }
    assert.equal(statusLabel("draft"), "Brouillon");
    assert.equal(statusLabel("active"), "En cours");
    assert.equal(statusLabel("expired"), "Échue");
    assert.equal(statusLabel("__proto__" as never), "Mission");
    assert.deepEqual(Object.keys(STATUS_LABELS).sort(), [...MISSION_STATUSES].sort());
    assert.equal(MISSION_ACTION_LABELS.cancel, "Annuler la mission");
  });

  test("chemins et pourcentages (entier vers le bas, 100 % seulement si tout est atteint)", () => {
    assert.equal(missionPath(ID), `/missions/${ID}`);
    assert.equal(percentOf(7, 20), 35);
    assert.equal(percentOf(19, 20), 95);
    assert.equal(percentOf(199, 200), 99);
    assert.equal(percentOf(20, 20), 100);
    assert.equal(percentOf(30, 20), 100);
    assert.equal(percentOf(0, 20), 0);
    assert.equal(percentOf(5, 0), 0);
    assert.equal(percentOf(Number.NaN, 20), 0);
  });
});

describe("ligne de la liste « Mes missions »", () => {
  test("mission en cours : achats confirmés, couverture de la proposition, budgets, échéance", () => {
    const row = missionRow(mission());
    assert.equal(row.securedText, "5 sur 20 achetés");
    assert.equal(row.securedPercent, 25);
    assert.equal(row.coverageText, "La proposition couvre 7 sur 20");
    assert.equal(row.coveragePercent, 35);
    assert.match(row.budgetText, /170\s000\sFCFA l'unité · 3\s200\s000\sFCFA au total/);
    assert.match(row.deadlineText ?? "", /^Jusqu'au \d{2}\/\d{2}\/\d{4}$/);
    assert.equal(row.statusText, "En cours");
    assert.equal(row.isOpen, true);
  });

  test("couverture inconnue : « recherche en cours » ; brouillon : ni achats ni couverture ; terminée : pas de couverture", () => {
    assert.equal(missionRow(mission({ coveredQuantity: null })).coverageText, "Recherche des annonces en cours…");
    const draft = missionRow(mission({ status: "draft", deadlineAt: null, coveredQuantity: null, securedQuantity: 0 }));
    assert.equal(draft.securedText, null);
    assert.equal(draft.coverageText, null);
    assert.equal(draft.deadlineText, "30 jours après le lancement");
    assert.equal(missionRow(mission({ status: "completed" })).coverageText, null);
    assert.equal(missionRow(mission({ status: "paused" })).isOpen, true);
  });
});

describe("formulaire", () => {
  const filled = { ...EMPTY_MISSION_FORM, category: "Téléphones", brand: "Apple", model: "iPhone 12", quantity: "20", unitBudget: "170 000", totalBudget: "3 200 000 FCFA", location: "Abidjan" };

  test("nombres saisis : chiffres, espaces et « FCFA » tolérés ; ni virgule, ni point, ni signe", () => {
    assert.equal(parseWholeNumber("170 000"), 170_000);
    assert.equal(parseWholeNumber("170 000 fcfa"), 170_000);
    for (const bad of ["", "12,5", "12.5", "-3", "+3", "1e3", "abc", "1 2 x", "9999999999999999"]) assert.equal(parseWholeNumber(bad), null, bad);
  });

  test("un formulaire complet donne la mission ; variante et lieu vides valent « non renseigné »", () => {
    const parsed = parseMissionForm(filled);
    assert.equal(parsed.ok, true);
    assert.deepEqual(parsed.ok && parsed.input, {
      category: "Téléphones", brand: "Apple", model: "iPhone 12", variant: null, condition: "Occasion", quantity: 20, unit: "pièce", unitBudgetXof: 170_000, totalBudgetXof: 3_200_000, location: "Abidjan", deadlineDays: 30,
    });
    const minimal = parseMissionForm({ ...filled, location: "  ", variant: "" });
    assert.deepEqual(minimal.ok && [minimal.input.variant, minimal.input.location], [null, null]);
  });

  test("tous les problèmes sont rendus d'un coup, un texte fixe par champ, jamais la valeur saisie", () => {
    const parsed = parseMissionForm({ ...EMPTY_MISSION_FORM, quantity: "1", unitBudget: "0", totalBudget: "abc", deadlineDays: "120", unit: "" });
    assert.equal(parsed.ok, false);
    if (parsed.ok) return;
    assert.deepEqual(Object.keys(parsed.problems).sort(), ["brand", "category", "deadlineDays", "model", "quantity", "totalBudgetXof", "unit", "unitBudgetXof"].sort());
    assert.match(parsed.problems.quantity ?? "", /nombre entier de 2 à 10 000/);
    assert.match(parsed.problems.deadlineDays ?? "", /de 1 à 90/);
    assert.ok(Object.values(parsed.problems).every((text) => !/abc|120/.test(text)));
  });

  test("budget total sous le budget par unité : problème sur le budget total ; un numéro dans un champ texte : message dédié", () => {
    const under = parseMissionForm({ ...filled, totalBudget: "100 000" });
    assert.equal(under.ok, false);
    assert.match(under.ok ? "" : under.problems.totalBudgetXof ?? "", /au moins égal au budget par unité/);
    const phone = parseMissionForm({ ...filled, model: "0708091011" });
    assert.equal(phone.ok, false);
    assert.match(phone.ok ? "" : phone.problems.model ?? "", /Pas de numéro de téléphone dans la mission \(champ : modèle\)/);
    const split = parseMissionForm({ ...filled, brand: "07 08", model: "09 10", variant: "11" });
    assert.equal(split.ok, false);
    assert.ok(!split.ok && Object.values(split.problems).some((text) => /Pas de numéro de téléphone/.test(text)));
  });

  test("les valeurs d'un brouillon reviennent dans le formulaire", () => {
    const values = formValuesOf(mission({ variant: "128 Go", location: null }));
    assert.deepEqual([values.variant, values.location, values.quantity, values.unitBudget, values.totalBudget, values.deadlineDays], ["128 Go", "", "20", "170000", "3200000", "30"]);
    const again = parseMissionForm(values);
    assert.equal(again.ok, true);
  });
});

describe("message pré-rempli et adresse de la conversation", () => {
  test("le message dit la quantité et le prix visés, rien d'autre ; il est un message valide pour la messagerie", () => {
    const text = missionDraftMessage({ title: "Apple iPhone 12 128 Go", quantity: 3, unitPriceXof: 158_000 });
    assert.match(text, /^Bonjour, je souhaite acheter 3 unités de « Apple iPhone 12 128 Go » à 158\s000 FCFA l'unité\./);
    assert.match(missionDraftMessage({ title: "Apple iPhone 12", quantity: 1, unitPriceXof: 100_000 }), /acheter 1 unité de/);
    assert.equal(checkMessageBody(text).ok, true);
    assert.ok(!/budget|mission|vendeur 2|total/i.test(text));
  });

  test("l'adresse porte deux entiers et rien d'autre ; tout le reste ne pré-remplit rien", () => {
    assert.equal(lineConversationPath(ID, { quantity: 3, unitPriceXof: 158_000 }), `/messages/${ID}?quantite=3&prix=158000`);
    assert.deepEqual(parseMissionHint("3", "158000"), { quantity: 3, priceXof: 158_000 });
    for (const [quantity, price] of [[null, "1"], ["1", null], ["0", "100"], ["10001", "100"], ["3", "0"], ["3", "100000001"], ["3.5", "100"], ["-3", "100"], ["3", "1e5"], ["<b>", "100"], [" 3", "100"], ["3", "100 000"], ["", "100"]] as const) {
      assert.equal(parseMissionHint(quantity, price), null, `${quantity} / ${price}`);
    }
  });
});

describe("proposition", () => {
  test("une ligne : calcul, sous-total, stock annoncé ; actions seulement si la mission est ouverte", () => {
    const free = proposalLineView(line(), true);
    assert.match(free.calculText, /^2 × 158\s000 FCFA$/);
    assert.match(free.subtotalText, /^316\s000 FCFA$/);
    assert.equal(free.stockText, "2 exemplaires annoncés");
    assert.equal(proposalLineView(line({ stock: 1 }), true).stockText, "1 exemplaire annoncé");
    assert.equal(free.canAct, true);
    assert.equal(proposalLineView(line(), false).canAct, false);
  });

  test("un achat déjà engagé est affiché à part : étiquette du vendeur, calcul, sous-total, état (en attente ou confirmé)", () => {
    const pending = engagedLineView(engaged());
    assert.deepEqual([pending.vendor, pending.title, pending.location, pending.confirmed, pending.statusText], ["Vendeur 2", "Apple iPhone 12 128 Go", "Cocody", false, "Achat déclaré : 2, en attente du vendeur"]);
    assert.match(pending.calculText, /^2 × 165\s000 FCFA$/);
    assert.match(pending.subtotalText, /^330\s000 FCFA$/);
    const confirmed = engagedLineView(engaged({ status: "confirmed", quantity: 3, subtotalXof: 495_000 }));
    assert.deepEqual([confirmed.confirmed, confirmed.statusText], [true, "Achat confirmé : 3"]);
    assert.equal(confirmed.orderId, ID);
  });

  test("résumé : couverture, budget utilisé, budget restant, vendeurs", () => {
    const proposal: MissionProposal = {
      state: "ready", lines: [line()], engaged: [engaged()], requestedQuantity: 20, committedQuantity: 2, committedXof: 330_000, remainingQuantity: 18, coveredQuantity: 7, coveragePercent: 35, budgetUsedXof: 1_000_000, budgetRemainingXof: 2_200_000, totalBudgetXof: 3_200_000, unitBudgetXof: 170_000,
      sellerCount: 7, candidateCount: 9, reasons: ["not_enough_offers"], readAt: "2031-01-02T10:00:00.000Z",
    };
    const summary = proposalSummary(proposal);
    assert.equal(summary.coverageText, "La proposition couvre 7 sur 20");
    assert.equal(summary.committedText, "2 déjà achetés ou en attente, 18 à acheter");
    assert.equal(proposalSummary({ ...proposal, committedQuantity: 1, remainingQuantity: 19 }).committedText, "1 déjà acheté ou en attente, 19 à acheter");
    assert.equal(proposalSummary({ ...proposal, committedQuantity: 0, remainingQuantity: 20, engaged: [] }).committedText, null, "rien d'engagé : rien à dire");
    assert.equal(summary.sellersText, "7 vendeurs");
    assert.equal(proposalSummary({ ...proposal, sellerCount: 1 }).sellersText, "1 vendeur");
    assert.equal(summary.complete, false);
    assert.equal(proposalSummary({ ...proposal, coveredQuantity: 20, coveragePercent: 100 }).complete, true);
    assert.match(summary.remainingText, /Il resterait 2\s200\s000 FCFA/);
  });

  test("achats de la mission : quantité, total, état", () => {
    const order: MissionOrder = { id: ID, status: "confirmed", quantity: 3, unitPriceXof: 150_000, offerId: OFFER, title: "Apple iPhone 12", createdAt: "2031-01-02T10:00:00.000Z" };
    const view = orderLine(order);
    assert.match(view.text, /^3 × 150\s000 FCFA = 450\s000 FCFA$/);
    assert.equal(view.statusText, "Confirmé");
    assert.equal(orderLine({ ...order, status: "proposed" }).statusText, "En attente du vendeur");
    assert.equal(orderLine({ ...order, status: "declined" }).statusText, "Refusé");
    assert.equal(orderLine({ ...order, status: "cancelled" }).statusText, "Annulé");
  });
});
