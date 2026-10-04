/**
 * Flux de recherche (Lot 5) — séquence NDJSON, annulation, réconciliation,
 * erreur publique sans trace technique. Moteur injecté (hors ligne).
 */
import { test, describe } from "node:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

import { buildSearchStream } from "../../lib/server/search-stream";
import { parseSearchEvent, type SearchEvent } from "../../lib/contracts";
import { publicOfferId } from "../../lib/server/offer-mapping";
import { createContinuationToken, verifyContinuationToken } from "../../lib/server/continuation";
import type { RunSearchOptions, RunSearchResult } from "../../poc/lib/engine.js";
import type { ScoredListing } from "../../poc/lib/scoring.js";
import type { RawListing } from "../../poc/lib/normalize.js";

const listing = (id: string, over: Partial<RawListing> = {}): RawListing => ({
  id, source: "coinafrique", title: "iPhone 12 128 Go", price: 135000,
  currency: "FCFA", zone: "Cocody", vendor: null,
  url: `https://ci.coinafrique.com/${id}`, photo: null,
  date: "il y a 2 h", description: null, ...over,
});

const scored = (id: string, score: number): ScoredListing => ({
  evaluated: { listing: listing(id), priceNonComparable: false } as ScoredListing["evaluated"],
  baseScore: score,
  score,
  aiStatus: "non évalué par IA",
  criteria: [{ nom: "capacité", valeur: "128 Go", extrait: "128 Go" }],
  raison: "Modèle et capacité compatibles.",
  confirmedRatio: { known: 1, total: 1 },
});

const fakeResult = (over: Partial<RunSearchResult> = {}): RunSearchResult =>
  ({
    finalListings: [scored("a1", 0.9), scored("a2", 0.8)],
    sources: [
      { source: "coinafrique", status: "ok", listings: [], warnings: [], query: "q", capabilities: {}, errors: [], durationMs: 10 },
      { source: "facebook", status: "timeout", listings: [], warnings: [], query: "q", capabilities: {}, errors: [], durationMs: 10 },
    ],
    stats: { cout: { total: 0.004, known: true } },
    ...over,
  }) as unknown as RunSearchResult;

const delayedRun = (delayMs: number, result: RunSearchResult | Error, signal?: AbortSignal) =>
  async (): Promise<RunSearchResult> => {
    await new Promise((resolve) => {
      const t = setTimeout(resolve, delayMs);
      t.unref?.();
      signal?.addEventListener("abort", () => { clearTimeout(t); resolve(undefined); }, { once: true });
    });
    if (result instanceof Error) throw result;
    return result;
  };

const collectEvents = async (stream: ReadableStream<Uint8Array>): Promise<SearchEvent[]> => {
  const events: SearchEvent[] = [];
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const event = parseSearchEvent(line);
      if (event) events.push(event);
    }
  }
  return events;
};

describe("buildSearchStream — séquence NDJSON nominale", () => {
  test("started → results (finale) → completed ; réconciliation au coût connu", async () => {
    const completions: { totalCostKnown: boolean; costMicros: number }[] = [];
    const { stream } = buildSearchStream({
      searchId: "s-test",
      needText: "iPhone 12 à Abidjan",
      alternatives: false,
      aiEnabled: true,
      maxCostUsd: 0.05,
      signal: new AbortController().signal,
      runSearch: async () => fakeResult(),
      onComplete: (r) => completions.push(r),
    });
    const events = await collectEvents(stream);
    assert.deepEqual(events.map((e) => e.type), ["started", "results", "completed"]);
    const started = events[0] as Extract<SearchEvent, { type: "started" }>;
    assert.deepEqual(started, { type: "started", searchId: "s-test", aiEnabled: true });
    const results = events[1] as Extract<SearchEvent, { type: "results" }>;
    assert.equal(results.offers.length, 2);
    assert.equal(results.offers[0].id, publicOfferId(listing("a1")));
    const completed = events[2] as Extract<SearchEvent, { type: "completed" }>;
    assert.equal(completed.offersCount, 2);
    assert.deepEqual(completed.sources, [
      { source: "coinafrique", status: "ok" },
      { source: "facebook", status: "timeout" },
    ]);
    assert.deepEqual(completions, [{ totalCostKnown: true, costMicros: 4_000 }]);
  });
});

describe("compréhension avant recherche", () => {
  test("ambiguïté : understanding puis clarification, sans résultats ni completed", async () => {
    const reconciliations: unknown[] = [];
    const { stream } = buildSearchStream({
      searchId: "s-clarify",
      needText: "Je cherche une console",
      alternatives: false,
      aiEnabled: true,
      signal: new AbortController().signal,
      makeContinuationToken: () => "jeton-signé",
      runSearch: async (opts) => {
        const understanding = {
          canonicalProduct: "console", category: "ambigu", searchTerms: ["console"],
          requirements: [], preferences: [], exclusions: [], confidence: 0.5,
          clarification: {
            id: "product-intent", question: "Quel type de console ?",
            options: ["Console de jeux", "Meuble console"],
          },
          source: "ai" as const,
        };
        opts.onUnderstanding?.(understanding);
        return fakeResult({ understanding, clarification: understanding.clarification, finalListings: [] });
      },
      onComplete: (value) => reconciliations.push(value),
    });
    const events = await collectEvents(stream);
    assert.deepEqual(events.map((event) => event.type), ["started", "understanding", "clarification"]);
    const clarification = events.at(-1) as Extract<SearchEvent, { type: "clarification" }>;
    assert.equal(clarification.clarification.continuationToken, "jeton-signé");
    assert.deepEqual(reconciliations, [{ totalCostKnown: true, costMicros: 4_000 }]);
  });

  test("jeton lié à la session, IP, texte, choix et expiration", () => {
    const now = new Date("2026-10-03T12:00:00Z");
    const common = {
      sessionId: "session-1", ipHash: "ip-1", text: "Je cherche une console",
      clarificationId: "product-intent", secret: "secret-de-test-suffisant", now,
    };
    const token = createContinuationToken({
      ...common, options: ["Console de jeux", "Meuble console"], ttlSeconds: 300,
    });
    assert.equal(verifyContinuationToken(token, { ...common, answer: "Console de jeux" }), true);
    assert.equal(verifyContinuationToken(token, { ...common, answer: "Téléphone" }), false);
    assert.equal(verifyContinuationToken(token, { ...common, text: "autre", answer: "Console de jeux" }), false);
    assert.equal(verifyContinuationToken(token, {
      ...common, now: new Date(now.getTime() + 301_000), answer: "Console de jeux",
    }), false);
  });
});

describe("buildSearchStream — annulation et déconnexion", () => {
  test("aucune publication après coupure ; les résultats déjà envoyés restent", async () => {
    const controller = new AbortController();
    const completions: unknown[] = [];
    const { stream } = buildSearchStream({
      searchId: "s-abort",
      needText: "iPhone 12",
      alternatives: false,
      aiEnabled: true,
      maxCostUsd: 0.05,
      signal: controller.signal,
      runSearch: delayedRun(80, fakeResult(), controller.signal),
      onComplete: (r) => completions.push(r),
    });
    // consomme un morceau puis coupe : started seulement, puis abort
    const reader = stream.getReader();
    const first = await reader.read();
    assert.equal(parseSearchEvent(new TextDecoder().decode(first.value))?.type, "started");
    controller.abort();
    const rest = await collectEvents(
      new ReadableStream<Uint8Array>({
        async pull(ctrl) {
          const chunk = await reader.read().catch(() => ({ done: true, value: undefined }));
          if (chunk.done) ctrl.close();
          else ctrl.enqueue(chunk.value);
        },
      }),
    );
    // après coupure : ni results ni completed (publication tardive interdite)
    assert.ok(rest.every((e) => e.type !== "results"), "aucune republication après abort");
    assert.ok(rest.every((e) => e.type !== "completed"));
    // la réconciliation (libération de la place, réservation) est quand même passée
    assert.equal(completions.length, 1);
  });

  test("démarré annulé : runSearch s'arrête vite, aucune relance automatique", async () => {
    const controller = new AbortController();
    controller.abort();
    let runCalls = 0;
    const { stream } = buildSearchStream({
      searchId: "s-dead",
      needText: "iPhone 12",
      alternatives: false,
      aiEnabled: false,
      signal: controller.signal,
      runSearch: async () => {
        runCalls++;
        return fakeResult();
      },
      onComplete: () => {},
    });
    await collectEvents(stream);
    assert.equal(runCalls, 1, "un seul appel — jamais de relance après coupure");
  });
});

describe("buildSearchStream — erreur moteur", () => {
  test("erreur publique structurée, sans trace technique, réserve conservée", async () => {
    const completions: { totalCostKnown: boolean; costMicros: number }[] = [];
    const { stream } = buildSearchStream({
      searchId: "s-err",
      needText: "iPhone 12",
      alternatives: false,
      aiEnabled: true,
      maxCostUsd: 0.05,
      signal: new AbortController().signal,
      runSearch: async () => {
        throw new Error("stack technique secrète : ECONNRESET …");
      },
      onComplete: (r) => completions.push(r),
    });
    const events = await collectEvents(stream);
    assert.deepEqual(events.map((e) => e.type), ["started", "error"]);
    const err = events[1] as Extract<SearchEvent, { type: "error" }>;
    assert.equal(err.code, "search_failed");
    assert.ok(!JSON.stringify(err).includes("ECONNRESET"), "aucune trace technique brute");
    assert.deepEqual(completions, [{ totalCostKnown: false, costMicros: 0 }]);
  });
});

describe("buildSearchStream — transmission des champs du formulaire au moteur", () => {
  test("budget, localisation et mode service transmis jusqu'au moteur", async () => {
    const cap: { opts: RunSearchOptions | null } = { opts: null };
    const { stream } = buildSearchStream({
      searchId: "s-struct",
      needText: "dépannage plomberie",
      clarificationAnswer: "Plombier à domicile",
      alternatives: false,
      aiEnabled: true,
      maxCostUsd: 0.05,
      structured: { budgetFcfa: 25_000, location: "Cocody", mode: "service" },
      signal: new AbortController().signal,
      runSearch: async (opts: RunSearchOptions) => {
        cap.opts = opts;
        return fakeResult();
      },
      onComplete: () => {},
    });
    await collectEvents(stream);
    const captured = cap.opts;
    assert.ok(captured);
    assert.deepEqual(captured.structured, { budgetFcfa: 25_000, location: "Cocody", mode: "service" });
    assert.equal(captured.needText, "dépannage plomberie");
    assert.equal(captured.clarificationAnswer, "Plombier à domicile");
    assert.equal(captured.maxCostUsd, 0.05, "plafond IA imposé côté serveur");
  });

  test("sans IA : ai:null (tous les chemins IA muets) et aucun plafond", async () => {
    const cap: { opts: RunSearchOptions | null } = { opts: null };
    const { stream } = buildSearchStream({
      searchId: "s-sans-ia",
      needText: "iPhone 12",
      alternatives: false,
      aiEnabled: false,
      maxCostUsd: 0.05, // ignoré quand aiEnabled=false
      structured: { budgetFcfa: null, location: null, mode: "achat" },
      signal: new AbortController().signal,
      runSearch: async (opts: RunSearchOptions) => {
        cap.opts = opts;
        return fakeResult();
      },
      onComplete: () => {},
    });
    await collectEvents(stream);
    const captured = cap.opts!;
    assert.equal(captured.ai, null);
    assert.equal(captured.maxCostUsd, undefined, "aucun plafond : aucune dépense possible");
  });
});

describe("buildSearchStream — progression via onProgress du moteur", () => {
  test("les instantanés progressifs sont publiés, puis remplacés par la finale", async () => {
    const { stream } = buildSearchStream({
      searchId: "s-prog",
      needText: "iPhone 12",
      alternatives: false,
      aiEnabled: false,
      signal: new AbortController().signal,
      runSearch: async (opts: RunSearchOptions) => {
        opts.onProgress?.({ arrivedFrom: "demo", offers: [scored("p1", 0.5)], counts: { brutes: 1, apresDedup: 1, candidates: 1, alternatives: 0, rejets: 0 } });
        return fakeResult();
      },
      onComplete: () => {},
    });
    const events = await collectEvents(stream);
    const types = events.map((e) => e.type);
    assert.deepEqual(types, ["started", "results", "results", "completed"]);
    const progressive = events[1] as Extract<SearchEvent, { type: "results" }>;
    assert.equal(progressive.offers.length, 1);
    const final = events[2] as Extract<SearchEvent, { type: "results" }>;
    assert.equal(final.offers.length, 2, "la finale remplace l'instantané");
  });
});

describe("journal diagnostic (tap) — fin réellement publiée, jamais une fin non émise", () => {
  const tapFile = () => join(mkdtempSync(join(tmpdir(), "noma-tap-")), "events.ndjson");
  const readTap = (path: string): { lines: Record<string, unknown>[]; end?: { reason: string } } => {
    const lines = readFileSync(path, "utf-8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as Record<string, unknown>);
    const end = lines.find((l) => l.tap === "end") as { reason: string } | undefined;
    return { lines: lines.filter((l) => l.tap !== "end"), end };
  };

  test("fin normale : journal = événements publiés + raison « completed »", async () => {
    const path = tapFile();
    process.env.NOMA_DEBUG_EVENT_LOG = path;
    try {
      const { stream } = buildSearchStream({
        searchId: "s-tap-ok",
        needText: "iPhone 12",
        alternatives: false,
        aiEnabled: false,
        signal: new AbortController().signal,
        runSearch: async () => fakeResult(),
        onComplete: () => {},
      });
      await collectEvents(stream);
      const { lines, end } = readTap(path);
      assert.deepEqual(lines.map((l) => l.type), ["started", "results", "completed"]);
      assert.equal(end?.reason, "completed", "fin RÉELLEMENT publiée");
    } finally {
      delete process.env.NOMA_DEBUG_EVENT_LOG;
    }
  });

  test("annulation après started : JAMAIS de completed dans le journal (P1 corrigé)", async () => {
    const path = tapFile();
    process.env.NOMA_DEBUG_EVENT_LOG = path;
    try {
      const controller = new AbortController();
      const { stream } = buildSearchStream({
        searchId: "s-tap-abort",
        needText: "iPhone 12",
        alternatives: false,
        aiEnabled: true,
        signal: controller.signal,
        runSearch: delayedRun(80, fakeResult(), controller.signal),
        onComplete: () => {},
      });
      const reader = stream.getReader();
      await reader.read(); // started publié
      controller.abort();
      await reader.read().catch(() => ({ done: true, value: undefined }));
      // laisser le finally écrire le tap
      await new Promise((r) => setTimeout(r, 200));
      const { lines, end } = readTap(path);
      assert.deepEqual(lines.map((l) => l.type), ["started"], "aucune fin non publiée dans le journal");
      assert.equal(end?.reason, "annulé-sans-publication", "annulation distinguée d'une fin moteur");
      assert.equal((end as unknown as { moteurTerminé?: boolean })?.moteurTerminé, true, "le moteur a terminé (prouvé) sans publication");
    } finally {
      delete process.env.NOMA_DEBUG_EVENT_LOG;
    }
  });

  test("erreur moteur : journal = started + error publié, raison « error »", async () => {
    const path = tapFile();
    process.env.NOMA_DEBUG_EVENT_LOG = path;
    try {
      const { stream } = buildSearchStream({
        searchId: "s-tap-err",
        needText: "iPhone 12",
        alternatives: false,
        aiEnabled: true,
        signal: new AbortController().signal,
        runSearch: async () => {
          throw new Error("échec simulé");
        },
        onComplete: () => {},
      });
      await collectEvents(stream);
      const { lines, end } = readTap(path);
      assert.deepEqual(lines.map((l) => l.type), ["started", "error"]);
      assert.equal(end?.reason, "error");
    } finally {
      delete process.env.NOMA_DEBUG_EVENT_LOG;
    }
  });

  test("completed avec preuve serveur du retrait (retired transmis)", async () => {
    const { stream } = buildSearchStream({
      searchId: "s-tap-retired",
      needText: "iPhone 12",
      alternatives: false,
      aiEnabled: false,
      signal: new AbortController().signal,
runSearch: async () =>
        fakeResult({
          finalListings: [],
          stats: { cout: { total: 0, known: true }, annoncesInaccessiblesExclues: 7, accessibiliteIndeterminee: 1 } as unknown as RunSearchResult["stats"],
        }) as unknown as RunSearchResult,
      onComplete: () => {},
    });
    const events = await collectEvents(stream);
    const completed = events.at(-1) as Extract<SearchEvent, { type: "completed" }>;
    assert.equal(completed.type, "completed");
    assert.deepEqual(completed.retired, { count: 7, indeterminate: 1 }, "preuve serveur transmise au client");
    assert.deepEqual(completed.retired, { count: 7, indeterminate: 1 }, "preuve serveur transmise au client");
  });

  test("aucune exclusion → PAS de champ retired (cause non établie côté client)", async () => {
    const { stream } = buildSearchStream({
      searchId: "s-tap-sans",
      needText: "iPhone 12",
      alternatives: false,
      aiEnabled: false,
      signal: new AbortController().signal,
      runSearch: async () => fakeResult({ finalListings: [] }) as unknown as RunSearchResult,
      onComplete: () => {},
    });
    const events = await collectEvents(stream);
    const completed = events.at(-1) as Extract<SearchEvent, { type: "completed" }>;
    assert.equal(completed.type, "completed");
    assert.equal(completed.retired, undefined, "absent = le client affiche un message neutre");
  });
});
