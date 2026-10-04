/**
 * Régressions — 3e revue du 02/10 (3 constats). Tests locaux uniquement.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { parseNeed } from "../lib/need";
import { evaluateListing, classify } from "../lib/filter";
import { baseScore, scoreListings } from "../lib/scoring";
import { safeFetch, httpTransport, DEFAULT_LIMITS } from "../lib/fetch";
import type { RawListing } from "../lib/normalize";

const listing = (over: Partial<RawListing>): RawListing => ({
  id: "x",
  source: "coinafrique",
  title: "iPhone 12 - 128Gb",
  price: 135000,
  currency: "FCFA",
  zone: "Cocody",
  vendor: null,
  url: null,
  photo: null,
  date: "il y a 2 h",
  description: null,
  ...over,
});

// ─── P1 : le filtre interdit des achats légitimes ──────────────────────────
describe("P1 — un besoin accessoire reste recherchable", () => {
  const cases: { besoin: string; annonce: string; prix: number }[] = [
    { besoin: "chargeur USB-C 20W à Abidjan", annonce: "Chargeur USB-C 20W original", prix: 5000 },
    { besoin: "coque iPhone 12", annonce: "Coque iPhone 12 silicone", prix: 1500 },
    { besoin: "AirPods Pro à Cocody", annonce: "AirPods Pro 2 sealed", prix: 45000 },
    { besoin: "table en verre à Cocody", annonce: "Table en verre 6 places", prix: 45000 },
  ];
  for (const c of cases) {
    test(`« ${c.besoin} » → l'annonce correspondante est candidate`, () => {
      const need = parseNeed(c.besoin);
      const r = classify([listing({ title: c.annonce, price: c.prix })], need);
      assert.ok(r.candidates.length > 0, `rejets : ${r.rejected.map((x) => x.reason).join("; ") || "aucun"}`);
    });
  }

  test("le téléphone reste protégé : « Coque iPhone 12 » n'est pas un iPhone 12", () => {
    const need = parseNeed("iPhone 12 · 128 Go à Abidjan");
    const r = classify([listing({ title: "Coque iPhone 12 silicone", price: 1500 })], need);
    assert.equal(r.candidates.length, 0);
    assert.equal(r.rejected.length, 1);
  });

  test("« iPhone 12 avec chargeur » : le listing « Chargeur iPhone 12 » reste rejeté", () => {
    const need = parseNeed("iPhone 12 128 Go avec chargeur");
    const r = classify([listing({ title: "Chargeur iPhone 12 20W", price: 3000 })], need);
    assert.equal(r.candidates.length, 0);
  });
});

// ─── P2 : annulation pendant le DNS ────────────────────────────────────────
describe("P2 — annulation pendant la résolution : aucune connexion", () => {
  test("httpTransport avec signal déjà annulé : 0 requête envoyée", async () => {
    let hits = 0;
    const server = createServer(() => {
      hits++;
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const port = (server.address() as { port: number }).port;
      const controller = new AbortController();
      controller.abort();
      await assert.rejects(
        () =>
          httpTransport(`http://127.0.0.1:${port}/x`, controller.signal, {
            pin: { address: "127.0.0.1", port },
            limits: DEFAULT_LIMITS,
          }),
        (e: { kind?: string }) => e.kind === "timeout",
      );
      assert.equal(hits, 0, "une requête HTTP a été envoyée malgré l'annulation");
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  test("annulation PENDANT la résolution : le chargement n'est jamais appelé", async () => {
    const controller = new AbortController();
    let loads = 0;
    await assert.rejects(
      () =>
        safeFetch("https://example.com/x", {
          deps: {
            resolve: async () => {
              controller.abort(); // annulation pendant le DNS
              await new Promise((r) => setTimeout(r, 20));
              return ["93.184.216.34"];
            },
            load: async () => {
              loads++;
              return { status: 200, headers: {}, body: "ok" };
            },
          },
          signal: controller.signal,
          limits: { totalMs: 2000 },
        }),
      (e: { kind?: string }) => e.kind === "timeout",
    );
    assert.equal(loads, 0, "le chargement a eu lieu après l'annulation");
  });
});

// ─── P2 : score déterministe honnête ───────────────────────────────────────
describe("P2 — le score déterministe intègre capacité, état et fraîcheur", () => {
  const need = parseNeed(
    "iPhone 12 · 128 Go, bon état, à Abidjan, max 150 000 FCFA",
  );

  test("capacité inconnue + état non vérifié + date ancienne ≠ 1,00", () => {
    const ev = evaluateListing(
      need,
      listing({ title: "iPhone 12", date: "il y a 1 mois" }),
    );
    const s = baseScore(ev, need);
    assert.ok(s < 0.9, `score ${s} ne doit pas atteindre 1,00`);
  });

  test("annonce complète et récente → 1,00", () => {
    const ev = evaluateListing(
      need,
      listing({ description: "en bon état", date: "il y a 30 min" }),
    );
    assert.equal(baseScore(ev, need), 1);
  });

  test("le ratio d'informations confirmées est exposé et affiché", () => {
    const ev = evaluateListing(
      need,
      listing({ title: "iPhone 12", date: "il y a 1 mois" }),
    );
    const [s] = scoreListings(need, [ev], null);
    assert.ok(
      s.confirmedRatio.known < s.confirmedRatio.total,
      `confirmedRatio ${JSON.stringify(s.confirmedRatio)}`,
    );
    assert.ok(s.raison.includes("informations confirmées"), s.raison);
    assert.ok(!s.raison.startsWith("Correspondance exacte"), s.raison);
  });

  test("date absente ne vaut pas une date récente", () => {
    const evRecent = evaluateListing(need, listing({ description: "en bon état", date: "il y a 30 min" }));
    const evSansDate = evaluateListing(need, listing({ description: "en bon état", date: null }));
    assert.ok(baseScore(evSansDate, need) < baseScore(evRecent, need));
  });
});
