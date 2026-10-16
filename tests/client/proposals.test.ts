import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { ApiError, type StoredMatch } from "../../lib/client/api";
import { createProposalsClient, describeProposalError, type Proposal, type SellerRequest } from "../../lib/client/proposals-api";
import {
  buildProposal,
  canAnswer,
  canPropose,
  emptyForm,
  linesTotal,
  offerStateText,
  parseQuoteTarget,
  pendingText,
  proposalRow,
  quotePath,
  requestPath,
  requestRow,
} from "../../lib/client/proposals-view";
import { formatFcfa } from "../../lib/client/wallet-view";
import { checkProposalInput, PROPOSAL_LINES_MAX } from "../../lib/proposals-rules";

const DEMAND = "11111111-1111-4111-8111-111111111111";
const OFFER = "33333333-3333-4333-8333-333333333333";
const OFFER_2 = "44444444-4444-4444-8444-444444444444";
const PROPOSAL = "55555555-5555-4555-8555-555555555555";
const ROOT = join(import.meta.dirname, "..", "..");
const params = (query: string) => new URLSearchParams(query);

const need = (): StoredMatch => ({
  candidateId: DEMAND,
  candidate: { category: "Téléphones", brand: "Apple", model: "iPhone 13", variant: null, condition: "Occasion", quantity: null, unit: null, location: "Abidjan", deadlineAt: null, price: null, budget: { amount: 200000, currency: "XOF" }, availabilityStatus: null },
  compatibilityStatus: "compatible", score: 90, coverage: 1, evaluatedAt: "2031-01-01T10:00:00.000Z",
  indicators: { availability: null, price: null, confidence: { level: "high", score: 90, accountAgeBand: "gte_30d", factors: ["phone_verified"] } },
  relevance: 80, sponsored: false, proBadge: false,
});

const proposal = (overrides: Partial<Proposal> = {}): Proposal => ({
  id: PROPOSAL, demandId: DEMAND, offerId: OFFER, offerTitle: "Apple iPhone 13", needTitle: "Apple iPhone 13", priceXof: 240000, lines: [], slot: "Samedi matin", warranty: "3 mois", note: "Livraison possible.",
  validUntil: "2031-02-01T10:00:00.000Z", status: "sent", orderId: null, createdAt: "2031-01-01T10:00:00.000Z", decidedAt: null, ...overrides,
});

describe("règles partagées", () => {
  test("une proposition : prix OU lignes, jamais les deux sans accord ; clés inconnues, bornes, validité par défaut 7 jours", () => {
    assert.deepEqual(checkProposalInput({ offerId: OFFER, priceXof: 240000 }), { ok: true, value: { offerId: OFFER, priceXof: 240000, lines: [], slot: null, warranty: null, note: null, validDays: 7 } });
    const quote = checkProposalInput({ offerId: OFFER, lines: [{ label: " Pièces ", amountXof: 5000 }, { label: "Main d'oeuvre", amountXof: 20000 }], validDays: 3 });
    assert.equal(quote.ok && quote.value.priceXof, 25000);
    assert.equal(quote.ok && quote.value.lines[0].label, "Pièces");
    assert.equal(checkProposalInput({ offerId: OFFER, lines: [{ label: "a", amountXof: 5000 }], priceXof: 5000 }).ok, true, "prix égal à la somme : accepté");
    for (const bad of [
      null, [], { offerId: OFFER }, { offerId: "x", priceXof: 5 }, { offerId: OFFER, priceXof: 0 }, { offerId: OFFER, priceXof: 100_000_001 }, { offerId: OFFER, priceXof: 12.5 }, { offerId: OFFER, priceXof: 5, extra: 1 },
      { offerId: OFFER, priceXof: 5, validDays: 0 }, { offerId: OFFER, priceXof: 5, validDays: 15 }, { offerId: OFFER, priceXof: 5, slot: "x".repeat(121) }, { offerId: OFFER, priceXof: 5, note: "x".repeat(301) },
      { offerId: OFFER, lines: [{ label: "a", amountXof: 5000 }], priceXof: 4999 }, { offerId: OFFER, lines: [{ label: "a", amountXof: 0 }] }, { offerId: OFFER, lines: [{ label: "", amountXof: 5 }] },
      { offerId: OFFER, lines: [{ label: "a", amountXof: 5, extra: 1 }] }, { offerId: OFFER, lines: Array.from({ length: PROPOSAL_LINES_MAX + 1 }, () => ({ label: "a", amountXof: 1 })) },
      { offerId: OFFER, lines: [{ label: "a", amountXof: 60_000_000 }, { label: "b", amountXof: 60_000_000 }] },
    ]) assert.equal(checkProposalInput(bad).ok, false, JSON.stringify(bad)?.slice(0, 90));
  });

  test("aucun numéro de téléphone : d'un seul tenant ou coupé entre le créneau, la garantie, la note et les libellés", () => {
    for (const bad of [
      { offerId: OFFER, priceXof: 5, note: "appelez le 07 00 00 00 42" },
      { offerId: OFFER, priceXof: 5, slot: "07 00 00", warranty: "00 42 11", note: "22" },
      { offerId: OFFER, lines: [{ label: "0700000042", amountXof: 1000 }] },
      { offerId: OFFER, lines: [{ label: "07 00 00", amountXof: 1000 }, { label: "00 42 11 22", amountXof: 1000 }] },
    ]) assert.deepEqual(checkProposalInput(bad), { ok: false, reason: "phone" }, JSON.stringify(bad));
  });
});

describe("présentation", () => {
  test("adresses et formulaire : UUID seulement, texte du formulaire contrôlé par la règle partagée, total des lignes affiché pendant la saisie", () => {
    assert.equal(requestPath(DEMAND), `/vendeur/demandes/${DEMAND}`);
    assert.equal(requestPath("x"), null);
    assert.equal(quotePath(DEMAND, OFFER), `/vendeur/devis/nouveau?besoin=${DEMAND}&annonce=${OFFER}`);
    assert.equal(quotePath(DEMAND, "x"), null);
    assert.deepEqual(parseQuoteTarget(params(`besoin=${DEMAND}&annonce=${OFFER}`)), { demandId: DEMAND, offerId: OFFER });
    for (const query of ["", `besoin=${DEMAND}`, `annonce=${OFFER}`, `besoin=x&annonce=${OFFER}`]) assert.equal(parseQuoteTarget(params(query)), null, query);
    const form = { ...emptyForm(OFFER, true), lines: [{ label: "Pièces", amount: "5000" }, { label: "Main d'oeuvre", amount: "20 000" }, { label: "", amount: "" }] };
    assert.equal(linesTotal(form.lines), 5000, "un montant mal formé ne compte pas");
    const built = buildProposal({ ...form, lines: [{ label: "Pièces", amount: "5000" }, { label: "Main d'oeuvre", amount: "20000" }, { label: "", amount: "" }] });
    assert.equal(built.ok && built.value.priceXof, 25000);
    assert.equal(buildProposal({ ...emptyForm(OFFER, false), price: "abc" }).ok, false);
    assert.equal(buildProposal({ ...emptyForm(OFFER, false), price: "240000", note: "appelez le 0700000042" }).ok, false);
    const simple = buildProposal({ ...emptyForm(OFFER, false), price: "240000", slot: "Samedi" });
    assert.equal(simple.ok && simple.value.slot, "Samedi");
  });

  test("demandes du vendeur : le besoin est celui d'« Acheteurs intéressés » (sans identité), état par annonce, une annonce peut proposer sauf en attente, acceptée ou refusée", () => {
    const request: SellerRequest = {
      need: need(),
      offers: [
        { offerId: OFFER, title: "Apple iPhone 13", proposal: null, declined: false },
        { offerId: OFFER_2, title: "Apple iPhone 13 Pro", proposal: { id: PROPOSAL, status: "sent" }, declined: false },
      ],
    };
    const row = requestRow(request);
    assert.equal(row.demandId, DEMAND);
    assert.equal(row.need.title, "Apple iPhone 13");
    assert.match(row.need.budgetText, /^Budget : jusqu'à/);
    assert.equal(row.offersText, "2 de vos annonces : Apple iPhone 13, Apple iPhone 13 Pro");
    assert.deepEqual([row.proposedCount, row.allProposed], [1, false]);
    assert.equal(canPropose(request.offers[0]), true);
    assert.equal(canPropose(request.offers[1]), false);
    assert.equal(canPropose({ offerId: OFFER, title: "x", proposal: { id: PROPOSAL, status: "withdrawn" }, declined: false }), true);
    assert.equal(canPropose({ offerId: OFFER, title: "x", proposal: { id: PROPOSAL, status: "expired" }, declined: false }), true);
    assert.equal(canPropose({ offerId: OFFER, title: "x", proposal: { id: PROPOSAL, status: "accepted" }, declined: false }), false);
    assert.equal(canPropose({ offerId: OFFER, title: "x", proposal: { id: PROPOSAL, status: "declined" }, declined: true }), false);
    assert.equal(offerStateText(request.offers[0]), null);
    assert.equal(offerStateText(request.offers[1]), "En attente de réponse");
    assert.match(String(offerStateText({ offerId: OFFER, title: "x", proposal: { id: PROPOSAL, status: "declined" }, declined: true })), /plus de proposition possible/);
    assert.equal(JSON.stringify(row).includes(DEMAND) && /\+225|\b07\d{8}\b/.test(JSON.stringify(row)), false);
  });

  test("une proposition : prix en clair, lignes d'un devis, créneau et garantie, validité ; l'acheteur peut répondre seulement quand elle est en attente", () => {
    const quote = proposalRow(proposal({ lines: [{ label: "Pièces", amountXof: 5000 }, { label: "Main d'oeuvre", amountXof: 20000 }], priceXof: 25000 }), "buyer");
    assert.equal(quote.priceText, formatFcfa(25000));
    assert.deepEqual(quote.lines, [{ label: "Pièces", amountText: formatFcfa(5000) }, { label: "Main d'oeuvre", amountText: formatFcfa(20000) }]);
    assert.deepEqual(quote.details, ["Créneau : Samedi matin", "Garantie : 3 mois", "Livraison possible."]);
    assert.match(quote.validText, /^Valable jusqu'au /);
    assert.equal(quote.statusText, "En attente de réponse");
    assert.match(quote.title, /pour votre besoin/);
    assert.match(proposalRow(proposal(), "seller").title, /besoin « Apple iPhone 13 »/);
    assert.match(proposalRow(proposal({ status: "accepted" }), "buyer").validText, /^Envoyée le /);
    assert.equal(canAnswer(proposal()), true);
    for (const status of ["accepted", "declined", "withdrawn", "expired"] as const) assert.equal(canAnswer(proposal({ status })), false, status);
    assert.equal(pendingText(0), null);
    assert.equal(pendingText(1), "1 proposition en attente de votre réponse");
    assert.equal(pendingText(3), "3 propositions en attente de votre réponse");
  });
});

describe("client HTTP", () => {
  const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const wire = (overrides: Json = {}): Json => ({ ...proposal(), ...overrides });
  type Json = Record<string, unknown>;

  test("envoi : contrôlé AVANT la requête (un texte refusé ne part pas), corps minimal (prix OU lignes), réponse relue champ par champ", async () => {
    const calls: Array<{ path: string; init: RequestInit }> = [];
    const client = createProposalsClient({ fetch: async (path, init) => { calls.push({ path: String(path), init: init ?? {} }); return json(201, { contractVersion: "proposals/v1", proposal: wire({ extra: "ignoré" }) }); } });
    await assert.rejects(() => client.propose(DEMAND, { offerId: OFFER, priceXof: 5, lines: [], slot: null, warranty: null, note: "appelez le 0700000042", validDays: 7 }), (error: unknown) => error instanceof ApiError && error.code === "phone_number_in_proposal");
    assert.equal(calls.length, 0);
    const created = await client.propose(DEMAND, { offerId: OFFER, priceXof: 240000, lines: [], slot: "Samedi matin", warranty: null, note: null, validDays: 7 });
    assert.equal("extra" in created, false);
    assert.equal(calls[0].path, `/api/requests/${DEMAND}/proposals`);
    assert.deepEqual(JSON.parse(String(calls[0].init.body)), { offerId: OFFER, validDays: 7, priceXof: 240000, slot: "Samedi matin" });
    await client.propose(DEMAND, { offerId: OFFER, priceXof: 25000, lines: [{ label: "Pièces", amountXof: 25000 }], slot: null, warranty: null, note: null, validDays: 3 });
    assert.deepEqual(JSON.parse(String(calls[1].init.body)), { offerId: OFFER, validDays: 3, lines: [{ label: "Pièces", amountXof: 25000 }] }, "avec des lignes, le prix n'est pas envoyé");
  });

  test("listes et réponses : propositions relues strictement, besoin relu par l'analyseur de « Acheteurs intéressés », actions connues seulement", async () => {
    const seen: string[] = [];
    const client = createProposalsClient({
      fetch: async (path, init) => {
        seen.push(`${init?.method} ${String(path)}`);
        if (String(path) === "/api/requests") return json(200, { contractVersion: "proposals/v1", requests: [{ need: need(), offers: [{ offerId: OFFER, title: "iPhone", proposal: null, declined: false }] }], offersTruncated: true });
        if (String(path).startsWith("/api/proposals?")) return json(200, { contractVersion: "proposals/v1", proposals: [wire()], pendingCount: 1 });
        return json(200, { contractVersion: "proposals/v1", proposal: wire({ status: "accepted", orderId: PROPOSAL }), orderId: PROPOSAL, replayed: false });
      },
    });
    const requests = await client.requests();
    assert.equal(requests.offersTruncated, true);
    assert.equal(requests.requests[0].need.candidateId, DEMAND);
    assert.deepEqual(await client.list("buyer").then((list) => [list.proposals.length, list.pendingCount]), [1, 1]);
    const answered = await client.act(PROPOSAL, "accept");
    assert.equal(answered.orderId, PROPOSAL);
    assert.equal(answered.proposal.status, "accepted");
    await assert.rejects(() => client.act(PROPOSAL, "supprimer" as never), (error: unknown) => error instanceof ApiError && error.code === "invalid_argument");
    await assert.rejects(() => client.act("pas-un-uuid", "accept"), (error: unknown) => error instanceof ApiError && error.code === "invalid_id");
    assert.deepEqual(seen, ["GET /api/requests", "GET /api/proposals?as=buyer", `POST /api/proposals/${PROPOSAL}/accept`]);
    const wrong = createProposalsClient({ fetch: async () => json(200, { contractVersion: "autre/v9", proposals: [] }) });
    await assert.rejects(() => wrong.list("seller"), (error: unknown) => error instanceof ApiError && error.code === "invalid_response");
    const bad = createProposalsClient({ fetch: async () => json(200, { contractVersion: "proposals/v1", proposals: [wire({ status: "inconnu" })], pendingCount: null }) });
    await assert.rejects(() => bad.list("seller"), (error: unknown) => error instanceof ApiError && error.code === "invalid_response");
  });

  test("messages d'erreur : fixes, en français, jamais le texte du serveur", () => {
    assert.match(describeProposalError(new ApiError(409, "proposal_declined", "x"), "send"), /plus lui en envoyer/);
    assert.match(describeProposalError(new ApiError(409, "proposal_active_exists", "x"), "send"), /déjà en attente/);
    assert.match(describeProposalError(new ApiError(429, "proposals_daily_limit", "x"), "send"), /Réessayez demain/);
    assert.match(describeProposalError(new ApiError(409, "order_active_exists", "x"), "answer"), /déjà en attente de confirmation/);
    assert.match(describeProposalError(new ApiError(409, "proposal_expired", "x"), "answer"), /a expiré/);
    assert.equal(describeProposalError(new ApiError(404, "resource_not_found", "x"), "send"), "Ce besoin ne correspond plus à cette annonce.");
    assert.equal(describeProposalError(new Error("fuite"), "send"), "Une erreur est survenue. Réessayez dans un instant.");
  });
});

describe("câblage", () => {
  const read = (path: string): string => readFileSync(join(ROOT, path), "utf8");

  test("les quatre pages sont branchées sur le serveur (plus « Bientôt disponible ») ; les entrées existent : accueil vendeur, compte, résultats d'un besoin", () => {
    for (const page of ["app/(vendor)/vendeur/demandes/page.tsx", "app/(vendor)/vendeur/demandes/[id]/page.tsx", "app/(vendor)/vendeur/devis/nouveau/page.tsx", "app/(buyer)/propositions/page.tsx"]) {
      assert.doesNotMatch(read(page), /ComingSoon/, page);
      assert.match(read(page), /proposals\./, page);
    }
    assert.match(read("app/(vendor)/vendeur/page.tsx"), /href="\/vendeur\/demandes"/);
    assert.match(read("app/(buyer)/compte/page.tsx"), /href="\/propositions"/);
    assert.match(read("app/(buyer)/besoins/[id]/page.tsx"), /<ProposalsBanner demandId=\{demandId\}/);
  });

  test("l'acceptation crée la commande par le circuit existant dans la même transaction (aucune commande écrite à part)", () => {
    const source = read("lib/server/proposals/proposals.ts");
    assert.match(source, /declareOrderInTransaction\(client,/);
    assert.doesNotMatch(source, /INSERT INTO orders/);
    assert.match(read("lib/server/social/orders.ts"), /export async function declareOrderInTransaction/);
  });
});
