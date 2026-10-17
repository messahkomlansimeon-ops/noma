import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { ApiError } from "../../lib/client/api";
import { createExtractionClient, type ExtractionProposal } from "../../lib/client/extraction-api";
import {
  appliedMessage, describeExtractionError, extractionRows, initialChecked, needsNewAnalysis, selectionCount, selectionFor, selectionScope, type ExtractionCurrent,
} from "../../lib/client/extraction-view";

const OFFER = "11111111-1111-4111-8111-111111111111";
const PROPOSAL = "22222222-2222-4222-8222-222222222222";
const ROOT = join(import.meta.dirname, "..", "..");
const read = (path: string): string => readFileSync(join(ROOT, path), "utf8");

const EMPTY: ExtractionCurrent = { category: null, brand: null, model: null, variant: null, condition: null, quantity: null, location: null, deadlineAt: null, attributes: null, price: null };

/** Une proposition telle que le serveur la renvoie (offre « iPhone 12 128 Go noir, très bon état, 165 000 FCFA à Cocody »). */
const wire = (overrides: Record<string, unknown> = {}, fields: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: PROPOSAL,
  resourceType: "offer",
  resourceId: OFFER,
  sourceContentVersion: 3,
  sourceRawText: "iPhone 12 128 Go noir, très bon état, 165 000 FCFA à Cocody",
  sourceTextSha256: "x",
  contractVersion: "catalog-extraction/v1",
  extractorVersion: "noma-deterministic/v1",
  provenance: "deterministic",
  proposal: {
    type: "offer",
    contractVersion: "catalog-extraction/v1",
    fields: {
      category: "phones", brand: "Apple", model: "iphone 12", variant: null,
      attributes: [{ key: "storage_capacity", value: 128, unit: "GB", sourceUnit: "Go" }],
      condition: "very_good", quantity: null, location: "cocody", deadlineAt: null, price: { amount: 165000, currency: "XOF" },
      ...fields,
    },
  },
  evidence: [{ field: "model", quote: "iPhone 12" }, { field: "price", quote: "165 000 FCFA" }, { field: "attributes.0", quote: "128 Go" }],
  ambiguities: [],
  createdAt: "2026-10-17T10:00:00.000Z",
  isStale: false,
  ...overrides,
});

const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function client(respond: (path: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: { path: string; init: RequestInit }[] = [];
  const fetcher = (async (path: string, init: RequestInit) => {
    calls.push({ path, init });
    return respond(path, init);
  }) as unknown as typeof fetch;
  return { api: createExtractionClient({ fetch: fetcher }), calls };
}

async function parsed(overrides: Record<string, unknown> = {}, fields: Record<string, unknown> = {}): Promise<ExtractionProposal> {
  const { api } = client(() => json(200, { extractionProposal: wire(overrides, fields) }));
  return api.propose("offers", OFFER);
}

describe("client des propositions d'extraction", () => {
  test("propose : POST sans corps métier sur la bonne route, réponse relue champ par champ", async () => {
    const { api, calls } = client(() => json(200, { extractionProposal: wire() }));
    const proposal = await api.propose("offers", OFFER);
    assert.equal(calls[0].path, `/api/offers/${OFFER}/extraction-proposals`);
    assert.equal(calls[0].init.method, "POST");
    assert.equal(calls[0].init.body, "{}", "aucun champ métier n'est envoyé : le serveur lit le texte dans la base");
    assert.equal(proposal.id, PROPOSAL);
    assert.equal(proposal.sourceContentVersion, 3);
    assert.equal(proposal.fields.model, "iphone 12");
    assert.deepEqual(proposal.fields.price, { amount: 165000, currency: "XOF" });
    assert.equal(Object.hasOwn(proposal, "sourceRawText"), false, "le texte brut n'est pas gardé par le client");
  });

  test("un besoin passe par /api/demands et porte budget, exigences, préférences", async () => {
    const demand = wire(
      { resourceType: "demand", resourceId: OFFER },
      { price: undefined, budget: { amount: 150000, currency: "XOF" }, requirements: null, preferences: [{ key: "color", operator: "includes", value: "noir" }] },
    );
    const { api, calls } = client(() => json(200, { extractionProposal: demand }));
    const proposal = await api.propose("demands", OFFER);
    assert.equal(calls[0].path, `/api/demands/${OFFER}/extraction-proposals`);
    assert.deepEqual(proposal.fields.budget, { amount: 150000, currency: "XOF" });
    assert.deepEqual(proposal.fields.preferences, [{ key: "color", operator: "includes", value: "noir" }]);
  });

  test("réponses refusées : mauvaise version de contrat, autre fiche, autre type, champ mal formé, devise invalide", async () => {
    const bad = async (overrides: Record<string, unknown>, fields: Record<string, unknown> = {}) =>
      assert.rejects(parsed(overrides, fields), (error: unknown) => error instanceof ApiError && error.code === "invalid_response");
    await bad({ contractVersion: "catalog-extraction/v2" });
    await bad({ resourceId: "33333333-3333-4333-8333-333333333333" });
    await bad({ resourceType: "demand" });
    await bad({ sourceContentVersion: 0 });
    await bad({ isStale: "non" });
    await bad({}, { price: { amount: 1.5, currency: "XOF" } });
    await bad({}, { price: { amount: 10, currency: "xof" } });
    await bad({}, { quantity: 0 });
    await bad({}, { attributes: [{ key: "", value: 1, unit: null, sourceUnit: null }] });
    await bad({ ambiguities: [{ field: "price", code: "x", message: "m", evidence: [1] }] });
  });

  test("un montant sans devise est accepté tel quel (currency null) : c'est l'écran qui le rend non applicable", async () => {
    const proposal = await parsed({}, { price: { amount: 200000, currency: null } });
    assert.deepEqual(proposal.fields.price, { amount: 200000, currency: null });
  });

  test("apply : version attendue = version de la proposition, noms de champs seulement, clé d'idempotence, jamais de valeur", async () => {
    const { api, calls } = client(() =>
      json(200, { applicationReceipt: { id: OFFER, idempotencyKey: "k", ownerId: OFFER, resourceType: "offer", resourceId: OFFER, proposalId: PROPOSAL, expectedContentVersion: 3, versionBefore: 3, versionAfter: 4, selectedFields: {}, changes: { model: "iphone 12", brand: "Apple" }, appliedAt: "2026-10-17T10:00:00.000Z" } }),
    );
    const receipt = await api.apply("offers", OFFER, { id: PROPOSAL, sourceContentVersion: 3 }, { fields: ["model", "brand"], attributeKeys: [] }, "clé-1");
    assert.equal(calls[0].path, `/api/offers/${OFFER}/extraction-proposals/${PROPOSAL}/apply`);
    assert.deepEqual(JSON.parse(String(calls[0].init.body)), { expectedContentVersion: 3, selection: { fields: ["model", "brand"] }, idempotencyKey: "clé-1" });
    assert.deepEqual(receipt, { proposalId: PROPOSAL, versionBefore: 3, versionAfter: 4, changedFields: ["model", "brand"] });
  });

  test("apply : un reçu pour une autre proposition est refusé ; les erreurs gardent leur code et jamais le message du serveur", async () => {
    const other = client(() => json(200, { applicationReceipt: { proposalId: OFFER, versionBefore: 1, versionAfter: 2, changes: {} } }));
    await assert.rejects(other.api.apply("offers", OFFER, { id: PROPOSAL, sourceContentVersion: 1 }, { fields: ["model"], attributeKeys: [] }, "k"), (e: unknown) => e instanceof ApiError && e.code === "invalid_response");
    const stale = client(() => json(409, { error: { code: "stale_proposal", message: "Détail interne <b>secret</b>" } }));
    await assert.rejects(stale.api.apply("offers", OFFER, { id: PROPOSAL, sourceContentVersion: 1 }, { fields: ["model"], attributeKeys: [] }, "k"), (e: unknown) => {
      assert.ok(e instanceof ApiError);
      assert.equal(e.status, 409);
      assert.equal(e.code, "stale_proposal");
      assert.equal(e.message.includes("secret"), false);
      return true;
    });
  });

  test("identifiants invalides refusés avant tout appel ; réseau coupé = code fixe", async () => {
    const { api, calls } = client(() => json(200, {}));
    await assert.rejects(api.propose("offers", "pas-un-uuid"), (e: unknown) => e instanceof ApiError && e.code === "invalid_id");
    assert.equal(calls.length, 0);
    const down = createExtractionClient({ fetch: (async () => { throw new TypeError("boom"); }) as unknown as typeof fetch });
    await assert.rejects(down.list("offers", OFFER), (e: unknown) => e instanceof ApiError && e.code === "network_error");
  });
});

describe("lignes proposées", () => {
  test("fiche vide : tout ce que le texte donne est proposé et coché d'avance, avec l'extrait du texte", async () => {
    const rows = extractionRows(await parsed(), EMPTY);
    assert.deepEqual(rows.map((row) => row.id), ["field:category", "field:brand", "field:model", "field:condition", "field:location", "field:price", "attr:storage_capacity"]);
    const byId = Object.fromEntries(rows.map((row) => [row.id, row]));
    assert.equal(byId["field:category"].value, "Téléphones");
    assert.equal(byId["field:condition"].value, "Très bon état");
    assert.equal(byId["field:price"].value, "165\u00a0000 FCFA");
    assert.equal(byId["field:price"].quote, "165 000 FCFA");
    assert.equal(byId["attr:storage_capacity"].label, "Stockage");
    assert.equal(byId["attr:storage_capacity"].value, "128 Go");
    // Catégorie et état : montrés mais non applicables (le serveur écrit des codes que le reste de noma ne comprend pas).
    assert.deepEqual(rows.filter((row) => row.blocked !== null).map((row) => row.id), ["field:category", "field:condition"]);
    assert.match(byId["field:category"].blocked ?? "", /formulaire de la fiche/);
    assert.ok(rows.filter((row) => row.blocked === null).every((row) => row.preselected));
    assert.equal(initialChecked(rows).size, rows.length - 2);
    const everything = selectionFor(rows, new Set(rows.map((row) => row.id)));
    assert.deepEqual([everything.fields.includes("category"), everything.fields.includes("condition")], [false, false], "jamais envoyés, même cochés de force");
    assert.deepEqual(everything.fields, ["brand", "model", "location", "price"]);
  });

  test("une valeur DÉJÀ saisie n'est jamais cochée d'avance et la valeur actuelle est montrée ; une valeur identique n'est pas proposée", async () => {
    const proposal = await parsed();
    const rows = extractionRows(proposal, { ...EMPTY, brand: "Samsung", model: "IPHONE 12", price: { amount: 150000, currency: "XOF" }, attributes: { storage_capacity: { value: 64, unit: "GB", sourceUnit: "Go" } } });
    const byId = Object.fromEntries(rows.map((row) => [row.id, row]));
    assert.equal(Object.hasOwn(byId, "field:model"), false, "même modèle (casse différente) : rien à proposer");
    assert.equal(byId["field:brand"].current, "Samsung");
    assert.equal(byId["field:brand"].preselected, false);
    assert.equal(byId["field:price"].current, "150\u00a0000 FCFA");
    assert.equal(byId["field:price"].preselected, false);
    assert.equal(byId["attr:storage_capacity"].current, "64 Go");
    assert.equal(byId["attr:storage_capacity"].preselected, false);
    assert.equal(byId["field:brand"].preselected, false);
    assert.equal(byId["field:location"].preselected, true, "champ vide : coché");
  });

  test("devise inconnue et ambiguïté : la ligne est montrée mais ne peut pas être cochée ni envoyée", async () => {
    const proposal = await parsed(
      { ambiguities: [{ field: "price", code: "currency_missing", message: "Le montant est explicite mais sa devise est inconnue.", evidence: ["200000"] }, { field: "attributes.0", code: "multiple_capacities", message: "Deux capacités différentes.", evidence: ["64 Go", "128 Go"] }] },
      { price: { amount: 200000, currency: null } },
    );
    const rows = extractionRows(proposal, EMPTY);
    const price = rows.find((row) => row.id === "field:price");
    const storage = rows.find((row) => row.id === "attr:storage_capacity");
    assert.ok(price?.blocked && storage?.blocked);
    assert.equal(price.preselected, false);
    assert.match(price.value, /devise inconnue/);
    const everything = new Set(rows.map((row) => row.id));
    const selection = selectionFor(rows, everything);
    assert.equal(selection.fields.includes("price"), false);
    assert.deepEqual(selection.attributeKeys, []);
    assert.ok(selection.fields.includes("brand"));
  });

  test("devise absente sans ambiguïté signalée : bloquée quand même (aucune devise supposée)", async () => {
    const rows = extractionRows(await parsed({}, { price: { amount: 5000, currency: null } }), EMPTY);
    assert.ok(rows.find((row) => row.id === "field:price")?.blocked);
  });

  test("un besoin : budget, exigences et préférences ; le prix d'offre n'existe pas", async () => {
    const demand = wire({ resourceType: "demand" }, { price: undefined, budget: { amount: 150000, currency: "XOF" }, requirements: [{ key: "color", operator: "excludes", value: "rouge" }], preferences: null });
    const { api } = client(() => json(200, { extractionProposal: demand }));
    const proposal = await api.propose("demands", OFFER);
    const rows = extractionRows(proposal, { ...EMPTY, budget: null, requirements: null, preferences: null });
    const ids = rows.map((row) => row.id);
    assert.ok(ids.includes("field:budget") && ids.includes("field:requirements"));
    assert.equal(ids.includes("field:price"), false);
    assert.equal(rows.find((row) => row.id === "field:requirements")?.value, "sans color rouge");
  });

  test("sélection : champs et clés d'attributs séparés, comptage, portée de la clé d'idempotence indépendante de l'ordre", async () => {
    const rows = extractionRows(await parsed(), EMPTY);
    const selection = selectionFor(rows, new Set(["field:model", "field:brand", "attr:storage_capacity", "field:inconnu"]));
    assert.deepEqual(selection, { fields: ["brand", "model"].sort((a, b) => rows.findIndex((r) => r.key === a) - rows.findIndex((r) => r.key === b)), attributeKeys: ["storage_capacity"] });
    assert.equal(selectionCount(selection), 3);
    assert.equal(selectionScope(PROPOSAL, { fields: ["model", "brand"], attributeKeys: [] }), selectionScope(PROPOSAL, { fields: ["brand", "model"], attributeKeys: [] }));
    assert.notEqual(selectionScope(PROPOSAL, { fields: ["brand"], attributeKeys: [] }), selectionScope(PROPOSAL, { fields: ["brand", "model"], attributeKeys: [] }));
  });
});

describe("messages", () => {
  test("messages fixes par statut et code, jamais le texte du serveur", () => {
    const err = (status: number, code: string) => new ApiError(status, code, "texte du serveur à ne jamais afficher");
    for (const [status, code] of [[409, "stale_proposal"], [409, "stale_version"], [409, "conflict"], [409, "resource_archived"], [400, "invalid_request"], [404, "resource_not_found"], [401, "authentication_required"], [403, "invalid_origin"], [503, "catalog_extraction_unavailable"], [413, "payload_too_large"], [400, "extraction_validation_error"], [500, "x"]] as const) {
      const text = describeExtractionError(err(status, code));
      assert.ok(text.length > 10 && !text.includes("serveur à ne jamais"), `${status} ${code}`);
    }
    assert.match(describeExtractionError(err(409, "resource_archived")), /archivée/);
    assert.match(describeExtractionError(err(409, "stale_proposal")), /Analysez-la à nouveau/);
    assert.equal(describeExtractionError(new Error("boom")), "Une erreur est survenue. Réessayez dans un instant.");
  });

  test("après un refus de fraîcheur ou d'idempotence il faut une nouvelle analyse ; pas après une panne réseau", () => {
    assert.equal(needsNewAnalysis(new ApiError(409, "stale_proposal", "")), true);
    assert.equal(needsNewAnalysis(new ApiError(409, "conflict", "")), true);
    assert.equal(needsNewAnalysis(new ApiError(0, "network_error", "")), false);
    assert.equal(needsNewAnalysis(new ApiError(503, "catalog_extraction_unavailable", "")), false);
  });

  test("reçu : pluriel, et « rien à modifier » quand la version n'a pas bougé", () => {
    assert.equal(appliedMessage({ versionBefore: 1, versionAfter: 2, changedFields: ["model"] }), "Fiche mise à jour : 1 information reportée.");
    assert.equal(appliedMessage({ versionBefore: 1, versionAfter: 2, changedFields: ["model", "brand"] }), "Fiche mise à jour : 2 informations reportées.");
    assert.match(appliedMessage({ versionBefore: 2, versionAfter: 2, changedFields: [] }), /Rien à modifier/);
  });
});

describe("câblage", () => {
  test("la carte est branchée sur la page d'une annonce (offres) et sur la page d'un besoin (demandes), sans besoin porteur d'une mission", () => {
    assert.match(read("app/(vendor)/vendeur/annonces/[id]/page.tsx"), /<ExtractionCard kind="offers" record=\{offer\}/);
    const need = read("app/(buyer)/besoins/[id]/page.tsx");
    assert.match(need, /carrier === null \? <ExtractionCard kind="demands" record=\{demand\}/);
  });

  test("la carte n'envoie que des noms de champs : aucune valeur n'est lue dans les lignes pour la requête", () => {
    const card = read("components/extraction/extraction-card.tsx");
    assert.match(card, /extraction\.apply\(kind, record\.id, proposal, selection, keys\.current\.keyFor\(scope\)\)/);
    assert.match(card, /archivedAt !== null\) return null/, "une fiche archivée n'affiche pas la carte");
  });
});
