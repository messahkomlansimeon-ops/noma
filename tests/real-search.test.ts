/**
 * Comparaison et rechargement (essai réel 4A) — le rechargement réintroduisait
 * les 2 ids de démonstration de la seed, bloquant la sélection réelle
 * (compare.length >= 2). Hydrate d'une recherche réelle restaurée → la
 * comparaison repart à zéro. sessionStorage simulé (aucun navigateur).
 */
import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";

import { useRealSearch } from "../lib/real-search";
import { useNoma } from "../lib/store";

// sessionStorage simulé (node : aucune API disponible)
let storage: Map<string, string>;
const storageStub = {
  setItem: (k: string, v: string): void => void storage.set(k, v),
  getItem: (k: string): string | null => storage.get(k) ?? null,
  removeItem: (k: string): void => void storage.delete(k),
};
Object.defineProperty(globalThis, "sessionStorage", { value: storageStub, configurable: true });

const storedSearch = (offers: { id: string; title: string }[]) => ({
  offers,
  need: { text: "iPhone 12 à Abidjan", mode: "achat", location: "", budgetFcfa: "" },
  sources: [{ source: "coinafrique", status: "ok" }],
  aiEnabled: false,
  savedAt: Date.now(),
});

beforeEach(() => {
  storage = new Map();
  useRealSearch.setState(useRealSearch.getInitialState());
  useNoma.setState(useNoma.getInitialState());
});

describe("comparaison — rechargement (régression essai réel 4A)", () => {
  test("hydrate d'une recherche réelle : la seed de comparaison (ids de démo) est effacée", () => {
    storage.set(
      "noma-real-search",
      JSON.stringify(storedSearch([{ id: "o-reel-1", title: "iPhone 12 réel" }])),
    );
    // au rechargement, le store démo réintroduit 2 ids fictifs
    assert.deepEqual(useNoma.getState().compare, ["o-iphone-145", "o-iphone-150"]);
    useRealSearch.getState().hydrate();
    assert.equal(useRealSearch.getState().status, "done");
    assert.equal(useRealSearch.getState().offers.length, 1);
    assert.deepEqual(
      useNoma.getState().compare,
      [],
      "la sélection de démonstration ne doit pas bloquer la sélection réelle",
    );
  });

  test("sélection réelle après rechargement : acceptée (barre de comparaison atteignable)", () => {
    storage.set(
      "noma-real-search",
      JSON.stringify(storedSearch([{ id: "o-reel-1", title: "iPhone 12" }, { id: "o-reel-2", title: "TV 55" }])),
    );
    useRealSearch.getState().hydrate();
    const compare = useNoma.getState().compare;
    assert.equal(compare.length, 0);
    // les deux clics du testeur sont désormais acceptés (compare < 2)
    useNoma.getState().toggleCompare("o-reel-1");
    useNoma.getState().toggleCompare("o-reel-2");
    assert.deepEqual(useNoma.getState().compare, ["o-reel-1", "o-reel-2"]);
  });

  test("ids de démonstration jamais mélangés aux offres réelles", () => {
    storage.set(
      "noma-real-search",
      JSON.stringify(storedSearch([{ id: "o-reel-1", title: "iPhone 12" }])),
    );
    useRealSearch.getState().hydrate();
    // sans la correction : compare contiendrait encore 2 ids de démo
    assert.ok(
      useNoma.getState().compare.every((id) => !id.startsWith("o-iphone-14")),
      "aucun id de démonstration dans la comparaison",
    );
  });

  test("rechargement SANS recherche enregistrée : la seed de démo reste (écrans démo inchangés)", () => {
    useRealSearch.getState().hydrate();
    assert.equal(useRealSearch.getState().status, "idle");
    assert.deepEqual(
      useNoma.getState().compare,
      ["o-iphone-145", "o-iphone-150"],
      "les écrans de démonstration conservent leur seed",
    );
  });

  test("recherche enregistrée > 30 min : non restaurée, seed démo inchangée", () => {
    storage.set(
      "noma-real-search",
      JSON.stringify({ ...storedSearch([{ id: "o-reel-1", title: "iPhone 12" }]), savedAt: Date.now() - 31 * 60_000 }),
    );
    useRealSearch.getState().hydrate();
    assert.equal(useRealSearch.getState().status, "idle");
    assert.deepEqual(useNoma.getState().compare, ["o-iphone-145", "o-iphone-150"]);
  });
});

// ─── traitement NDJSON RÉEL (fetch stub) — jamais une copie de la logique ──

const offer = (id: string) => ({
  id,
  title: "iPhone 12",
  price: 100000,
  currency: "FCFA",
  location: "Cocody",
  source: "CoinAfrique",
  url: "https://ci.coinafrique.com/x",
  photo: null,
  justification: "Modèle compatible.",
  confirmed: [],
  aiStatus: "non évalué par IA" as const,
});

// ─── traitement NDJSON RÉEL (fetch stub) — jamais une copie de la logique ──

const ndjsonResponse = (events: unknown[]): Response => {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const e of events) controller.enqueue(encoder.encode(`${JSON.stringify(e)}\n`));
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "application/x-ndjson; charset=utf-8" },
  });
};

describe("traitement NDJSON réel — retrait attesté par le serveur (4B)", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = originalFetch;
  });
  // beforeEach est appelé après chaque test par node:test — remettre le vrai
  // fetch en fin de suite :
  after(() => {
    globalThis.fetch = originalFetch;
  });

  test("completed.retired (preuve serveur) → offersRetired = count", async () => {
    globalThis.fetch = (async () =>
      ndjsonResponse([
        { type: "started", searchId: "s-1", aiEnabled: true },
        { type: "results", offers: [offer("o-1"), offer("o-2")] },
        { type: "results", offers: [] },
        {
          type: "completed",
          offersCount: 0,
          sources: [{ source: "coinafrique", status: "ok" }],
          retired: { count: 2, indeterminate: 1 },
        },
      ])) as unknown as typeof fetch;
    await useRealSearch.setState({ need: { ...useRealSearch.getState().need, text: "iPhone 12" } });
    await useRealSearch.getState().startSearch();
    const s = useRealSearch.getState();
    assert.equal(s.status, "done");
    assert.equal(s.offers.length, 0);
    assert.equal(s.offersRetired, 2, "le motif et le nombre viennent du SERVEUR");
  });

  test("completed SANS retired (cause non établie) → offersRetired = 0, message neutre", async () => {
    globalThis.fetch = (async () =>
      ndjsonResponse([
        { type: "started", searchId: "s-2", aiEnabled: true },
        { type: "results", offers: [offer("o-1")] },
        { type: "results", offers: [] },
        { type: "completed", offersCount: 0, sources: [{ source: "coinafrique", status: "ok" }] },
      ])) as unknown as typeof fetch;
    await useRealSearch.setState({ need: { ...useRealSearch.getState().need, text: "iPhone 12" } });
    await useRealSearch.getState().startSearch();
    const s = useRealSearch.getState();
    assert.equal(s.status, "done");
    assert.equal(s.offersRetired, 0, "une liste devenue vide ne prouve pas la cause");
  });

  test("retrait persisté au rechargement (payload = preuve serveur)", () => {
    storage.set(
      "noma-real-search",
      JSON.stringify({ ...storedSearch([]), offersRetired: 3 }),
    );
    useRealSearch.getState().hydrate();
    assert.equal(useRealSearch.getState().offersRetired, 3);
  });

  test("nouvelle recherche : le marqueur de retrait repart à zéro", () => {
    useRealSearch.setState({ offersRetired: 5 });
    useRealSearch.setState(useRealSearch.getInitialState());
    assert.equal(useRealSearch.getState().offersRetired, 0);
  });

  test("clarification NDJSON : un clic renvoie le choix signé puis lance la recherche", async () => {
    const bodies: Record<string, unknown>[] = [];
    let call = 0;
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      call++;
      if (call === 1) {
        return ndjsonResponse([
          { type: "started", searchId: "s-c1", aiEnabled: true },
          {
            type: "understanding",
            understanding: {
              product: "console", category: "ambigu", requirements: [],
              preferences: [], exclusions: [], confidence: 0.5, source: "ai",
            },
          },
          {
            type: "clarification",
            clarification: {
              id: "product-intent", question: "Quel type de console ?",
              options: ["Console de jeux", "Meuble console"],
              continuationToken: "token-signé",
            },
          },
        ]);
      }
      return ndjsonResponse([
        { type: "started", searchId: "s-c2", aiEnabled: true },
        { type: "results", offers: [offer("console-1")] },
        { type: "completed", offersCount: 1, sources: [{ source: "facebook", status: "ok" }] },
      ]);
    }) as unknown as typeof fetch;

    useRealSearch.setState({ need: { ...useRealSearch.getState().need, text: "Je cherche une console" } });
    await useRealSearch.getState().startSearch({ turnstileToken: "turnstile" });
    assert.equal(useRealSearch.getState().status, "clarification");
    assert.equal(useRealSearch.getState().clarification?.options.length, 2);

    await useRealSearch.getState().answerClarification("Console de jeux");
    assert.equal(useRealSearch.getState().status, "done");
    assert.equal(useRealSearch.getState().offers.length, 1);
    assert.equal(bodies[1].text, "Je cherche une console");
    assert.equal(bodies[1].continuationToken, "token-signé");
    assert.deepEqual(bodies[1].clarification, {
      id: "product-intent", answer: "Console de jeux",
    });
    assert.equal(useRealSearch.getState().need.text, "Je cherche une console");
  });

  test("échec 429 d'une continuation : la question et le jeton restent réutilisables", async () => {
    const bodies: Record<string, unknown>[] = [];
    let call = 0;
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      call++;
      if (call === 1) {
        return ndjsonResponse([
          { type: "started", searchId: "s-r1", aiEnabled: true },
          {
            type: "clarification",
            clarification: {
              id: "product-intent", question: "Quel type de console ?",
              options: ["Console de jeux", "Meuble console"],
              continuationToken: "token-retry",
            },
          },
        ]);
      }
      if (call === 2) {
        return new Response(JSON.stringify({ error: { message: "Trop de recherches." } }), {
          status: 429,
          headers: { "content-type": "application/json", "retry-after": "5" },
        });
      }
      return ndjsonResponse([
        { type: "started", searchId: "s-r3", aiEnabled: true },
        { type: "results", offers: [offer("console-retry")] },
        { type: "completed", offersCount: 1, sources: [{ source: "facebook", status: "ok" }] },
      ]);
    }) as unknown as typeof fetch;

    useRealSearch.setState({ need: { ...useRealSearch.getState().need, text: "console Abidjan 150 000" } });
    await useRealSearch.getState().startSearch({ turnstileToken: "turnstile" });
    await useRealSearch.getState().answerClarification("Console de jeux");
    assert.equal(useRealSearch.getState().status, "clarification");
    assert.equal(useRealSearch.getState().clarification?.continuationToken, "token-retry");
    assert.match(useRealSearch.getState().error ?? "", /Réessayez dans 5 s/);

    await useRealSearch.getState().answerClarification("Console de jeux");
    assert.equal(useRealSearch.getState().status, "done");
    assert.equal(useRealSearch.getState().need.text, "console Abidjan 150 000");
    for (const body of bodies.slice(1)) {
      assert.equal(body.text, "console Abidjan 150 000");
      assert.equal(body.continuationToken, "token-retry");
      assert.deepEqual(body.clarification, { id: "product-intent", answer: "Console de jeux" });
    }
  });
});
