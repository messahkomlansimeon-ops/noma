/**
 * Régressions — 2e revue du 02/10 (5 constats). Tests locaux : aucun réseau
 * externe (signaux pré-abortés, serveur local pour deflate).
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { deflateSync } from "node:zlib";
import { parseNeed } from "../lib/need";
import { evaluateListing, classify } from "../lib/filter";
import { scoreListings } from "../lib/scoring";
import { fetchCoinAfrique } from "../sources/coinafrique";
import { fetchFacebook as fetchFb } from "../sources/facebook";
import { fetchLocanto as fetchLoc } from "../sources/locanto";
import { runGoogleSearch } from "../lib/gsearch";
import { safeFetch, httpTransport, readBodyLimited, DEFAULT_LIMITS, type TransportResponse } from "../lib/fetch";
import { llmJson } from "../lib/llm";
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

const need = parseNeed(
  "iPhone 12 · 128 Go, bon état, à Abidjan, max 150 000 FCFA",
);

// ─── P1-1 : le signal coupe réellement les connecteurs ─────────────────────
describe("P1-1 — annulation transmise aux connecteurs réels", () => {
  const aborted = () => AbortSignal.abort(new DOMException("coupé", "TimeoutError"));

  test("fetchCoinAfrique accepte un signal et rend la main immédiatement", async () => {
    const t0 = Date.now();
    const r = await fetchCoinAfrique(need, aborted());
    assert.ok(Date.now() - t0 < 1500, `durée ${Date.now() - t0} ms`);
    assert.ok(["timeout", "error", "blocked"].includes(r.status), r.status);
  });

  test("fetchFacebook n'ouvre pas de navigateur si déjà annulé", async () => {
    const t0 = Date.now();
    const r = await fetchFb(need, aborted());
    assert.ok(Date.now() - t0 < 1000, `durée ${Date.now() - t0} ms — le navigateur ne doit pas démarrer`);
    assert.ok(["timeout", "error"].includes(r.status), r.status);
  });

  test("fetchLocanto n'ouvre pas de navigateur si déjà annulé", async () => {
    const t0 = Date.now();
    const r = await fetchLoc(need, aborted());
    assert.ok(Date.now() - t0 < 1000, `durée ${Date.now() - t0} ms`);
    assert.ok(["timeout", "error"].includes(r.status), r.status);
  });

  test("runGoogleSearch rend la main immédiatement si annulé", async () => {
    const t0 = Date.now();
    const r = await runGoogleSearch(parseNeed(`besoin annulation test ${Date.now()}`), aborted());
    assert.ok(Date.now() - t0 < 1500, `durée ${Date.now() - t0} ms`);
    assert.ok(r.listings.length === 0);
  });

  test("llmJson n'appelle pas fetch si le signal est déjà annulé", async () => {
    let called = 0;
    await assert.rejects(
      () =>
        llmJson({ safeParse: () => ({ success: true, data: {} }) } as never, {
          task: "test",
          system: "s",
          user: "u",
          signal: aborted(),
          fetchImpl: (async () => {
            called++;
            throw new Error("ne doit pas être appelé");
          }) as never,
          timeoutMs: 1000,
        }),
      );
    assert.equal(called, 0);
  });
});

// ─── P1-2 : négations et valeurs complètes ─────────────────────────────────
describe("P1-2 — justifications fidèles à l'annonce", () => {
  test("« pas en bon état » ne valide pas « bon état »", () => {
    const ev = evaluateListing(
      need,
      listing({ description: "écran cassé, pas en bon état, à réparer" }),
    );
    const [s] = scoreListings(need, [ev], null);
    assert.ok(!s.raison.startsWith("Correspondance exacte"), s.raison);
    assert.ok(/bon etat.*(non vérifié|non confirmé)/.test(s.raison), s.raison);
  });

  test("« sans bon état » ne valide pas non plus", () => {
    const ev = evaluateListing(need, listing({ description: "vendu sans bon état de fonctionnement" }));
    const [s] = scoreListings(need, [ev], null);
    assert.ok(!s.raison.startsWith("Correspondance exacte"), s.raison);
  });

  test("témoin : « très bon état » valide toujours", () => {
    const ev = evaluateListing(need, listing({ description: "iPhone en très bon état, aucune rayure" }));
    const [s] = scoreListings(need, [ev], null);
    assert.ok(s.raison.startsWith("Correspondance exacte"), s.raison);
  });

  test("valeur IA « 5 % » rejetée avec la citation « batterie 85 % »", () => {
    const ev = evaluateListing(need, listing({ description: "batterie 85%" }));
    const [s] = scoreListings(need, [ev], [
      { idx: 0, score: 0.9, criteres: [{ nom: "batterie", valeur: "5%", extrait: "batterie 85%" }] },
    ]);
    assert.equal(s.criteria.length, 0, "valeur contredite par l'extrait → écartée");
    assert.ok(!s.raison.includes("5%"), s.raison);
  });

  test("valeur IA « 85 % » avec citation « batterie 85 % » : acceptée", () => {
    const ev = evaluateListing(need, listing({ description: "batterie 85%" }));
    const [s] = scoreListings(need, [ev], [
      { idx: 0, score: 0.9, criteres: [{ nom: "batterie", valeur: "85%", extrait: "batterie 85%" }] },
    ]);
    assert.equal(s.criteria.length, 1);
  });
});

// ─── P1-3 : accessoire ≠ produit vendu ─────────────────────────────────────
describe("P1-3 — l'accessoire n'est pas le téléphone", () => {
  test("coque annoncée avant la marque → incompatible, rejetée", () => {
    const ev = evaluateListing(need, listing({ title: "Coque iPhone 12 silicone", price: 1500 }));
    assert.equal(ev.model.state, "incompatible");
    assert.ok(ev.model.observed?.includes("accessoire"), ev.model.observed ?? "");
    const r = classify([listing({ title: "Coque iPhone 12 silicone", price: 1500 })], need);
    assert.equal(r.candidates.length, 0);
    assert.equal(r.rejected.length, 1);
  });

  test("verre trempé / chargeur / étui → même traitement", () => {
    for (const t of ["Verre trempé iPhone 12", "Chargeur iPhone 12 20W", "Étui cuir iPhone 12"]) {
      const ev = evaluateListing(need, listing({ title: t, price: 2000 }));
      assert.equal(ev.model.state, "incompatible", t);
    }
  });

  test("« iPhone 12 avec coque offerte » reste le téléphone", () => {
    const ev = evaluateListing(need, listing({ title: "iPhone 12 128Go avec coque offerte" }));
    assert.notEqual(ev.model.state, "incompatible");
  });
});

// ─── P2-4 : plafond deflate ────────────────────────────────────────────────
describe("P2-4 — réponse deflate de 3 Mo décompressés rejetée", () => {
  test("too-large, et pas les octets compressés en contenu", async () => {
    const big = Buffer.alloc(3_000_000, "a");
    const deflated = deflateSync(big);
    const server = createServer((req, res) => {
      res.setHeader("Content-Encoding", "deflate");
      res.end(deflated);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const port = (server.address() as { port: number }).port;
      const resp: TransportResponse = await httpTransport(
        `http://127.0.0.1:${port}/def`,
        new AbortController().signal,
        { pin: { address: "127.0.0.1", port }, limits: DEFAULT_LIMITS },
      );
      await assert.rejects(
        () => readBodyLimited(resp, "http://local/def", DEFAULT_LIMITS, Date.now() + 5000),
        (e: { kind?: string }) => e.kind === "too-large",
      );
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  test("deflate valide reste décompressé correctement", async () => {
    const payload = Buffer.from("<html>Annonce 135 000 FCFA</html>");
    const deflated = deflateSync(payload);
    const server = createServer((req, res) => {
      res.setHeader("Content-Encoding", "deflate");
      res.end(deflated);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const port = (server.address() as { port: number }).port;
      const resp: TransportResponse = await httpTransport(
        `http://127.0.0.1:${port}/def`,
        new AbortController().signal,
        { pin: { address: "127.0.0.1", port }, limits: DEFAULT_LIMITS },
      );
      const body = await readBodyLimited(resp, "http://local/def", DEFAULT_LIMITS, Date.now() + 5000);
      assert.ok(body.text.includes("135 000 FCFA"));
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

// ─── P2-5 : le délai couvre la résolution DNS ──────────────────────────────
describe("P2-5 — la limite totale inclut la résolution DNS", () => {
  test("DNS lent + limite 20 ms → coupure en ≈ 20 ms, pas 120", async () => {
    const d = {
      resolve: async () => {
        await new Promise((r) => setTimeout(r, 150));
        return ["93.184.216.34"];
      },
      load: async () => ({ status: 200, headers: {}, body: "ok" }),
    };
    const t0 = Date.now();
    await assert.rejects(
      () =>
        safeFetch("https://example.com/", {
          deps: d,
          limits: { totalMs: 20 },
        }),
      (e: { kind?: string; message?: string }) =>
        e.kind === "timeout" || /DNS > délai/.test(e.message ?? ""),
    );
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 100, `coupure en ${elapsed} ms — la résolution doit être bornée`);
  });

  test("DNS rapide → la requête passe normalement", async () => {
    const r = await safeFetch("https://example.com/", {
      deps: {
        resolve: async () => ["93.184.216.34"],
        load: async () => ({ status: 200, headers: {}, body: "ok" }),
      },
      limits: { totalMs: 3000 },
    });
    assert.equal(r.body, "ok");
  });
});