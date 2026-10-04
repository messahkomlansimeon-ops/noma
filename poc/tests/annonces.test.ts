/**
 * Annonces inaccessibles (essai réel 4A) — le classement PRINCIPAL exclut
 * les 404 confirmées ; 403/429/timeout/5xx/réseau = indéterminé : l'annonce
 * est CONSERVÉE, jamais assimilée à « vendue ». Vérifications hors ligne :
 * transport HTTP simulé (aucun réseau), borné au top 10, annulation honorée.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { runSearch, type RunSearchOptions } from "../lib/engine";
import type { RawListing } from "../lib/normalize";
import type { TransportDeps } from "../lib/fetch";

const listing = (id: string, over: Partial<RawListing> = {}): RawListing => ({
  id,
  source: "coinafrique",
  title: `iPhone 12 — annonce ${id}`,
  price: 100000,
  currency: "FCFA",
  zone: "Cocody",
  vendor: null,
  url: `https://www.exemple.test/annonce/${id}`,
  photo: null,
  date: null,
  description: null,
  ...over,
});

/** HTTP simulé : chaque URL porte son statut (`/annonce/xx-<code>`).
 *  L'IP de résolution est publique NON réservée (le contrôle SSRF refuse
 *  les plages documentées type 203.0.113.0/24). */
const simulatedHttp = (): TransportDeps => ({
  resolve: async () => ["93.184.216.34"],
  load: async (url) => {
    const m = /annonce\/[a-z]+-(\d+)/.exec(url);
    const status = m ? Number(m[1]) : 200;
    if (status === 503) throw new Error("serveur indisponible simulé");
    return { status, headers: { "content-type": "text/html" }, body: "<html>annonce</html>" };
  },
});

const opts = (over: Partial<RunSearchOptions>): RunSearchOptions => ({
  needText: "iPhone 12 · 128 Go, à Abidjan, max 150 000 FCFA",
  ai: null, // hors ligne : aucun appel IA
  log: () => {},
  itemCheckTransport: simulatedHttp(),
  ...over,
});

describe("annonces inaccessibles — exclusion 404, indéterminé jamais « vendu »", () => {
  test("P1 — identifiants identiques entre sources : l'annonce ACCESSIBLE reste, la 404 part", async () => {
    // deux sources, MÊME id (« dup-1 »), URLs distinctes : l'une répond 200,
    // l'autre 404. Le défaut initial retirait l'annonce accessible (par id
    // seul) et laissait la 404 — l'exclusion utilise désormais l'identité
    // complète de l'annonce.
    const urlOk = "https://www.exemple.test/annonce/aa-200";
    const urlDead = "https://www.exemple.test/annonce/bb-404";
    const r = await runSearch(opts({
      runners: [
        {
          name: "simule-1",
          browser: false,
          run: async () => ({
            source: "simule-1",
            query: "q",
            capabilities: { search: true, location: false, pagination: false, itemCheck: true, services: false, unsupported: [] },
            warnings: [],
            listings: [listing("dup-1", { url: urlOk })],
            status: "ok",
            durationMs: 10,
            errors: [],
          }),
        } as never,
        {
          name: "simule-2",
          browser: false,
          run: async () => ({
            source: "simule-2",
            query: "q",
            capabilities: { search: true, location: false, pagination: false, itemCheck: true, services: false, unsupported: [] },
            warnings: [],
            listings: [listing("dup-1", { url: urlDead })],
            status: "ok",
            durationMs: 10,
            errors: [],
          }),
        } as never,
      ],
    }));
    assert.equal(r.finalListings.length, 1, "une seule annonce (l'accessible) dans le classement");
    assert.equal(r.finalListings[0].evaluated.listing.url, urlOk, "l'annonce ACCESSIBLE est conservée");
    assert.equal(r.stats.annoncesInaccessiblesExclues, 1, "la 404 est exclue");
  });

  test("P2 — mode simulé (runners injectés, sans transport) : zéro DNS/HTTP réel", async () => {
    // la vérification ne s'exécute JAMAIS en mode simulé sans transport
    // injecté : aucune résolution DNS, aucun appel réseau (garde : dns.lookup
    // saboté pour faire échouer toute tentative réelle)
    const dnsPromises = (await import("node:dns/promises")).default;
    const originalLookup = dnsPromises.lookup;
    let dnsAttempts = 0;
    try {
      dnsPromises.lookup = ((() => {
        dnsAttempts++;
        throw new Error("DNS interdit en mode simulé");
      })) as never;
      const r = await runSearch({
        needText: "iPhone 12 · 128 Go, à Abidjan, max 150 000 FCFA",
        ai: null,
        log: () => {},
        // AUCUN itemCheckTransport : runners injectés = mode simulé
        runners: [
          {
            name: "simule",
            browser: false,
            run: async () => ({
              source: "simule",
              query: "q",
              capabilities: { search: true, location: false, pagination: false, itemCheck: true, services: false, unsupported: [] },
              warnings: [],
              listings: [listing("sim-200"), listing("sim-404")],
              status: "ok",
              durationMs: 10,
              errors: [],
            }),
          } as never,
        ],
      });
      assert.equal(r.finalListings.length, 2, "mode simulé : toutes les annonces conservées");
      assert.equal(r.stats.annoncesInaccessiblesExclues, 0, "aucune vérification → aucune exclusion");
      assert.equal(r.stats.accessibiliteIndeterminee, 0, "aucune vérification → aucun indéterminé");
      assert.equal(dnsAttempts, 0, "zéro résolution DNS réelle en mode simulé");
    } finally {
      dnsPromises.lookup = originalLookup;
    }
  });

  test("404 confirmée → exclue du classement principal ; 200 et 403 conservées", async () => {
    const r = await runSearch(opts({
      runners: [
        {
          name: "simule",
          browser: false,
          run: async () => ({
            source: "simule",
            query: "q",
            capabilities: { search: true, location: false, pagination: false, itemCheck: true, services: false, unsupported: [] },
            warnings: [],
            listings: [
              listing("a-200"),
              listing("b-404"),
              listing("c-403"),
            ],
            status: "ok",
            durationMs: 10,
            errors: [],
          }),
        } as never,
      ],
    }));
    const urls = r.finalListings.map((f) => f.evaluated.listing.id);
    assert.ok(!urls.includes("b-404"), "404 exclue du classement principal");
    assert.ok(urls.includes("a-200"), "page accessible → conservée");
    assert.ok(urls.includes("c-403"), "403 → conservée (jamais assimilée à vendue)");
    assert.equal(r.stats.annoncesInaccessiblesExclues, 1);
    assert.equal(r.stats.accessibiliteIndeterminee, 1, "403 indéterminé (conservé)");
  });

  test("403, timeout simulé et 503 → indéterminé : conservées, jamais « vendues »", async () => {
    const r = await runSearch(opts({
      runners: [
        {
          name: "simule",
          browser: false,
          run: async () => ({
            source: "simule",
            query: "q",
            capabilities: { search: true, location: false, pagination: false, itemCheck: true, services: false, unsupported: [] },
            warnings: [],
            listings: [
              listing("a-403"),
              listing("b-403"),
              listing("c-503"),
              listing("d-200"),
            ],
            status: "ok",
            durationMs: 10,
            errors: [],
          }),
        } as never,
      ],
    }));
    assert.equal(r.finalListings.length, 4, "toutes conservées : indéterminé ≠ retiré");
    assert.equal(r.stats.annoncesInaccessiblesExclues, 0);
    assert.equal(r.stats.accessibiliteIndeterminee, 3, "403 ×2 + 503 (réseau simulé) indéterminés");
  });

  test("borné au top 10 : au-delà, aucune vérification, aucune exclusion", async () => {
    const listings = Array.from({ length: 11 }, (_, i) => listing(`a-${i + 1}`));
    const r = await runSearch(opts({
      runners: [
        {
          name: "simule",
          browser: false,
          run: async () => ({
            source: "simule",
            query: "q",
            capabilities: { search: true, location: false, pagination: false, itemCheck: true, services: false, unsupported: [] },
            warnings: [],
            listings,
            status: "ok",
            durationMs: 10,
            errors: [],
          }),
        } as never,
      ],
    }));
    assert.equal(r.finalListings.length, 11);
    assert.equal(r.stats.annoncesInaccessiblesExclues, 0);
  });

  test("annulation avant vérification : rien n'est exclu ni demandé", async () => {
    const controller = new AbortController();
    controller.abort();
    const r = await runSearch(opts({
      signal: controller.signal,
      runners: [
        {
          name: "simule",
          browser: false,
          run: async () => ({
            source: "simule",
            query: "q",
            capabilities: { search: true, location: false, pagination: false, itemCheck: true, services: false, unsupported: [] },
            warnings: [],
            listings: [listing("a-200"), listing("b-404")],
            status: "ok",
            durationMs: 10,
            errors: [],
          }),
        } as never,
      ],
    }));
    // signal annulé avant la vérification : le moteur court-circuite et la
    // vérification d'accessibilité ne s'exécute jamais → rien d'exclu
    assert.equal(r.stats.annoncesInaccessiblesExclues, 0);
    assert.equal(r.stats.accessibiliteIndeterminee, 0);
  });
});
