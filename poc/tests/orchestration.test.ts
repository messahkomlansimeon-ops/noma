import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { runSources, type Runner } from "../lib/orchestrate";
import type { SourceResult } from "../sources/types";

const okResult = (source: string, listings: number): SourceResult => ({
  source,
  query: "https://test/" + source,
  capabilities: {
    search: true,
    location: false,
    pagination: false,
    itemCheck: false,
    services: false,
    unsupported: [],
  },
  warnings: [],
  listings: Array.from({ length: listings }, (_, i) => ({
    id: `${source}-${i}`,
    source,
    title: `Annonce ${source} ${i}`,
    price: 10000,
    currency: "FCFA",
    zone: "Abidjan",
    vendor: null,
    url: null,
    photo: null,
    date: null,
    description: null,
  })),
  status: "ok",
  durationMs: 10,
  errors: [],
});

describe("runSources — isolation des pannes (§7)", () => {
  test("une source bloquée, une qui plante, une lente : les autres restent exploitables", async () => {
    const runners: Runner[] = [
      { name: "ok", browser: false, run: async () => okResult("ok", 5) },
      {
        name: "bloquee",
        browser: false,
        run: async () => ({
          ...okResult("bloquee", 0),
          status: "blocked" as const,
          errors: ["mur de connexion"],
          listings: [],
        }),
      },
      {
        name: "plante",
        browser: false,
        run: async () => {
          throw new Error("crash simulé");
        },
      },
      {
        name: "lente",
        browser: false,
        run: async () => {
          await new Promise((r) => setTimeout(r, 250));
          return okResult("lente", 3);
        },
      },
    ];

    const { results, firstResultMs, totalMs } = await runSources(runners);

    assert.equal(results.length, 4, "tous les connecteurs rendent un résultat");
    const ok = results.find((r) => r.source === "ok");
    assert.equal(ok?.status, "ok");
    assert.equal(ok?.listings.length, 5);

    const blocked = results.find((r) => r.source === "bloquee");
    assert.equal(blocked?.status, "blocked");
    assert.equal(blocked?.listings.length, 0);

    const crashed = results.find((r) => r.source === "plante");
    assert.equal(crashed?.status, "error", "le crash est isolé dans le résultat");
    assert.ok(crashed?.errors[0].includes("crash simulé"));

    const slow = results.find((r) => r.source === "lente");
    assert.equal(slow?.listings.length, 3);

    assert.ok(
      firstResultMs < totalMs,
      `1er résultat (${firstResultMs}ms) avant la fin totale (${totalMs}ms)`,
    );
  });

  test("concurrence navigateurs : 2 max en parallèle", async () => {
    let concurrent = 0;
    let peak = 0;
    const runners: Runner[] = Array.from({ length: 4 }, (_, i) => ({
      name: `nav${i}`,
      browser: true,
      run: async () => {
        concurrent++;
        peak = Math.max(peak, concurrent);
        await new Promise((r) => setTimeout(r, 50));
        concurrent--;
        return okResult(`nav${i}`, 1);
      },
    }));
    await runSources(runners, { browserLimit: 2 });
    assert.ok(peak <= 2, `pic de concurrence ${peak} > 2`);
  });

  test("statuts distincts : succès vide ≠ blocage ≠ panne", () => {
    const statuses: SourceResult["status"][] = ["ok", "empty", "blocked", "timeout", "error"];
    assert.equal(new Set(statuses).size, 5);
  });
});
describe("runSources — limite GLOBALE des navigateurs (Lot 4)", () => {
  test("deux recherches simultanées : jamais plus de 2 Chromium au total", async () => {
    const { setGlobalBrowserLimit } = await import("../lib/orchestrate");
    setGlobalBrowserLimit(2);
    let concurrent = 0;
    let peak = 0;
    const browserRunner = (name: string): Runner => ({
      name,
      browser: true,
      run: async () => {
        concurrent++;
        peak = Math.max(peak, concurrent);
        await new Promise((r) => setTimeout(r, 40));
        concurrent--;
        return okResult(name, 1);
      },
    });
    const runA = runSources([browserRunner("a1"), browserRunner("a2")]);
    const runB = runSources([browserRunner("b1"), browserRunner("b2")]);
    await Promise.all([runA, runB]);
    assert.ok(peak <= 2, `pic global ${peak} > 2 navigateurs`);
  });
});
