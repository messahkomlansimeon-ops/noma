/**
 * Tests du contrat partagé (lib/contracts.ts) : priorités des champs,
 * informations manquantes, URL publiques, devise sans conversion, parsing
 * NDJSON tolérant. Sans imports serveur — le contrat est aussi dans le
 * bundle navigateur.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SEARCH_TEXT_MAX,
  SEARCH_BODY_MAX_BYTES,
  formatPublicPrice,
  mergeNeedFields,
  parseBudgetFcfa,
  parseSearchEvent,
  sanitizePublicUrl,
} from "../lib/contracts";

test("limites publiques documentées", () => {
  assert.equal(SEARCH_TEXT_MAX, 1000);
  assert.equal(SEARCH_BODY_MAX_BYTES, 8 * 1024);
});

// ─── Fusion champs structurés ↔ besoin analysé ──────────────────────────────

test("fusion — un budget explicitement renseigné prime sur le texte", () => {
  const merged = mergeNeedFields(
    { budgetFcfa: 100_000, location: null },
    { budget: { amount: 150_000, currency: "FCFA" }, zone: "Abidjan" },
  );
  assert.deepEqual(merged.budget, { amount: 100_000, currency: "FCFA" });
});

test("fusion — budget vide = valeur extraite du texte, aucun budget par défaut", () => {
  const avecBudgetTexte = mergeNeedFields(
    { budgetFcfa: null, location: undefined },
    { budget: { amount: 150_000, currency: "FCFA" }, zone: "Cocody" },
  );
  assert.deepEqual(avecBudgetTexte.budget, { amount: 150_000, currency: "FCFA" });

  const sansBudgetTexte = mergeNeedFields(
    { budgetFcfa: undefined, location: undefined },
    { budget: null, zone: null },
  );
  // AUCUN budget par défaut : absent du texte ET du formulaire → null
  assert.equal(sansBudgetTexte.budget, null);
  assert.equal(sansBudgetTexte.zone, null);
});

test("fusion — zéro conversion implicite d'une devise étrangère en FCFA", () => {
  // Le texte annonce « 500 USD » : aucun champ structuré → reste USD tel quel
  const merged = mergeNeedFields(
    { budgetFcfa: null, location: null },
    { budget: { amount: 500, currency: "USD" }, zone: null },
  );
  assert.deepEqual(merged.budget, { amount: 500, currency: "USD" });
  // Une devise EUR extraite n'est jamais réécrite en FCFA non plus
  const eur = mergeNeedFields(
    { budgetFcfa: undefined, location: undefined },
    { budget: { amount: 300, currency: "EUR" }, zone: null },
  );
  assert.equal(eur.budget?.currency, "EUR");
});

test("fusion — une localisation renseignée prime, vide = zone extraite", () => {
  const explicite = mergeNeedFields(
    { budgetFcfa: null, location: "  Bouaké  " },
    { budget: null, zone: "Abidjan" },
  );
  assert.equal(explicite.zone, "Bouaké");

  const vide = mergeNeedFields(
    { budgetFcfa: null, location: "" },
    { budget: null, zone: "Cocody" },
  );
  assert.equal(vide.zone, "Cocody");
});

// ─── URL publiques ───────────────────────────────────────────────────────────

test("sanitizePublicUrl — http/https uniquement", () => {
  assert.equal(sanitizePublicUrl("https://ci.coinafrique.com/annonce/123"), "https://ci.coinafrique.com/annonce/123");
  assert.ok(sanitizePublicUrl("http://example.com/page")?.startsWith("http://example.com/page"));
  assert.equal(sanitizePublicUrl("javascript:alert(1)"), null);
  assert.equal(sanitizePublicUrl("data:image/png;base64,AAAA"), null);
  assert.equal(sanitizePublicUrl("/annonce/123"), null);
  assert.equal(sanitizePublicUrl(""), null);
  assert.equal(sanitizePublicUrl(null), null);
  assert.equal(sanitizePublicUrl(undefined), null);
});

// ─── Prix public : devise annoncée jamais convertie ─────────────────────────

test("formatPublicPrice — prix null = « sur demande », jamais de prix inventé", () => {
  assert.equal(formatPublicPrice({ price: null, currency: "FCFA" }), "sur demande");
});

test("formatPublicPrice — FCFA/XOF affichés FCFA, valeur inchangée", () => {
  assert.equal(formatPublicPrice({ price: 150000, currency: "FCFA" }), "150\u00A0000 FCFA");
  assert.equal(formatPublicPrice({ price: 150000, currency: "XOF" }), "150\u00A0000 FCFA");
});

test("formatPublicPrice — devise étrangère affichée telle quelle, jamais en FCFA", () => {
  assert.equal(formatPublicPrice({ price: 50, currency: "USD" }), "50 USD");
  assert.equal(formatPublicPrice({ price: 45, currency: "EUR" }), "45 EUR");
  // Devise inconnue : libellé brut conservé, pas de substitution FCFA
  assert.equal(formatPublicPrice({ price: 12, currency: "qqch" }), "12 QQCH");
});

// ─── Saisie du budget : normalisation sans déformation ───────────────────────

test("parseBudgetFcfa — formats ivoiriens courants normalisés", () => {
  assert.deepEqual(parseBudgetFcfa("150 000 FCFA"), { ok: true, value: 150_000 });
  assert.deepEqual(parseBudgetFcfa("150k"), { ok: true, value: 150_000 });
  assert.deepEqual(parseBudgetFcfa("150.000"), { ok: true, value: 150_000 });
  assert.deepEqual(parseBudgetFcfa("150,000"), { ok: true, value: 150_000 });
  assert.deepEqual(parseBudgetFcfa("150 000"), { ok: true, value: 150_000 });
  assert.deepEqual(parseBudgetFcfa("150\u00a0000 frs"), { ok: true, value: 150_000 });
  assert.deepEqual(parseBudgetFcfa("150"), { ok: true, value: 150 });
  assert.deepEqual(parseBudgetFcfa(" 150 000k "), { ok: true, value: 150_000_000 });
});

test("parseBudgetFcfa — saisie ambiguë : erreur explicite, jamais de plafond perdu", () => {
  for (const bad of ["abc", "150.5", "150,5", "1.2.3", "quatre-vingts", "0,5k", ""]) {
    const res = parseBudgetFcfa(bad);
    assert.equal(res.ok, false, `« ${bad} » devrait être refusé`);
    assert.ok(res.ok === false && res.reason.length > 0);
  }
  // « 150.000 » n'est pas 150 FCFA (défaut reproduit et corrigé)
  const res = parseBudgetFcfa("150.000");
  assert.ok(res.ok && res.value === 150_000, "150.000 = 150 000, pas 150");
});

// ─── Événements NDJSON ───────────────────────────────────────────────────────

test("parseSearchEvent — événements de recherche et compréhension reconnus", () => {
  const started = parseSearchEvent('{"type":"started","searchId":"s-1","aiEnabled":true}');
  assert.deepEqual(started, { type: "started", searchId: "s-1", aiEnabled: true });

  const understanding = parseSearchEvent(JSON.stringify({
    type: "understanding",
    understanding: {
      product: "réfrigérateur", category: "électroménager",
      requirements: ["Capacité : 300 litres"], preferences: [], exclusions: [],
      confidence: 0.96, source: "ai",
    },
  }));
  assert.equal(understanding?.type, "understanding");

  const clarification = parseSearchEvent(JSON.stringify({
    type: "clarification",
    clarification: {
      id: "product-intent", question: "Quel type ?",
      options: ["Console de jeux", "Meuble console"], continuationToken: "signé",
    },
  }));
  assert.equal(clarification?.type, "clarification");

  const source = parseSearchEvent('{"type":"source","source":"coinafrique","status":"ok"}');
  assert.deepEqual(source, { type: "source", source: "coinafrique", status: "ok" });

  const results = parseSearchEvent('{"type":"results","offers":[]}');
  assert.deepEqual(results, { type: "results", offers: [] });

  const completed = parseSearchEvent(
    '{"type":"completed","offersCount":2,"sources":[{"source":"google","status":"ok"}]}',
  );
  assert.deepEqual(completed, {
    type: "completed",
    offersCount: 2,
    sources: [{ source: "google", status: "ok" }],
  });

  // preuve serveur du retrait d'annonces (lot 4B) : facultative, validée
  const retired = parseSearchEvent(
    '{"type":"completed","offersCount":0,"sources":[],"retired":{"count":7,"indeterminate":0}}',
  );
  assert.deepEqual(retired, {
    type: "completed",
    offersCount: 0,
    sources: [],
    retired: { count: 7, indeterminate: 0 },
  });

  const err = parseSearchEvent(
    '{"type":"error","code":"rate_limited","message":"Trop de recherches","retryAfterSeconds":30}',
  );
  assert.deepEqual(err, {
    type: "error",
    code: "rate_limited",
    message: "Trop de recherches",
    retryAfterSeconds: 30,
  });
});

test("parseSearchEvent — compréhension et clarification mal formées refusées", () => {
  assert.equal(parseSearchEvent('{"type":"understanding","understanding":{"product":"TV"}}'), null);
  assert.equal(parseSearchEvent('{"type":"clarification","clarification":{"id":"x","question":"?","options":["une"],"continuationToken":"t"}}'), null);
});

test("parseSearchEvent — retired invalide → null (jamais accepté aveuglément)", () => {
  assert.equal(
    parseSearchEvent('{"type":"completed","offersCount":0,"sources":[],"retired":{"count":-1,"indeterminate":0}}'),
    null,
    "count négatif refusé",
  );
  assert.equal(
    parseSearchEvent('{"type":"completed","offersCount":0,"sources":[],"retired":{"count":1.5,"indeterminate":0}}'),
    null,
    "count non entier refusé",
  );
  assert.equal(
    parseSearchEvent('{"type":"completed","offersCount":0,"sources":[],"retired":{"count":1}}'),
    null,
    "indeterminate manquant refusé",
  );
  assert.equal(
    parseSearchEvent('{"type":"completed","offersCount":0,"sources":[],"retired":"7"}'),
    null,
    "retired non objet refusé",
  );
});

test("parseSearchEvent — ligne invalide ou type inconnu → null, jamais d'exception", () => {
  assert.equal(parseSearchEvent(""), null);
  assert.equal(parseSearchEvent("   "), null);
  assert.equal(parseSearchEvent("pas du json"), null);
  assert.equal(parseSearchEvent('{"type":"interne","trace":"stack…"}'), null);
  assert.equal(parseSearchEvent("[1,2,3]"), null);
  assert.equal(parseSearchEvent('{"type":"started","searchId":42}'), null);
  assert.equal(parseSearchEvent('{"type":"source","source":"x","status":"bizarre"}'), null);
  assert.equal(parseSearchEvent('{"type":"error","code":"x"}'), null);
});
