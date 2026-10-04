/**
 * Régressions de la revue du 02/10 — un groupe par constat.
 * Chaque test a été écrit AVANT la correction et doit échouer sur l'ancien code.
 * Tests locaux uniquement : aucun réseau externe, aucun crédit IA.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { parseNeed } from "../lib/need";
import { coinAfriqueQuery, facebookQuery, serpQueries } from "../lib/query";
import { evaluateListing, classify } from "../lib/filter";
import { scoreListings } from "../lib/scoring";
import { pageCacheKey } from "../lib/gsearch";
import { runSources, type Runner } from "../lib/orchestrate";
import { scoreWithAi, rankAndSplit } from "../lib/pipeline";
import * as env from "../lib/env";
import type { RawListing } from "../lib/normalize";
import type { SourceResult } from "../sources/types";

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

// ─── P1-1 : téléchargements non fiables → toujours safeFetch ───────────────
describe("P1-1 — aucun téléchargement direct d'URL non fiable", () => {
  test("aucune source ne fait fetch(target…) ou fetch(url externe) hors safeFetch", () => {
    const files = [
      "search.ts",
      "lib/gsearch.ts",
      ...readdirSync("sources").filter((f) => f.endsWith(".ts")).map((f) => `sources/${f}`),
    ];
    for (const f of files) {
      const src = readFileSync(f, "utf-8");
      assert.ok(
        !/\bfetch\(\s*(target|url|link|u)\b/.test(src),
        `${f} télécharge une URL non fiable avec fetch() direct`,
      );
    }
  });
});

// ─── P1-3 : budgets avec marqueur ──────────────────────────────────────────
describe("P1-3 — budgets avec marqueur sans devise ne plantent plus", () => {
  const cases: [string, number][] = [
    ["iPhone 12 budget 150000", 150000],
    ["iPhone 12 max 150000", 150000],
    ["iPhone 12 moins de 150 000", 150000],
    ["iPhone 12 jusqu'à 150 000", 150000],
    ["iPhone 12 128 Go budget : 150.000", 150000],
  ];
  for (const [text, amount] of cases) {
    test(`« ${text} »`, () => {
      const n = parseNeed(text);
      assert.equal(n.budget?.amount, amount);
      assert.equal(n.budget?.currency, null);
    });
  }
});

// ─── P1-4 : requêtes qui gardent le produit ────────────────────────────────
describe("P1-4 — modèle et variante conservés dans les requêtes", () => {
  test("iPhone 12 Pro 128 Go ne devient pas « pro »", () => {
    const need = parseNeed("iPhone 12 Pro 128 Go à Abidjan");
    assert.equal(need.model, "iphone 12");
    assert.equal(need.variant, "pro");
    const q = coinAfriqueQuery(need);
    assert.equal(new URL(q.url).searchParams.get("keyword"), "iphone 12 pro");
    assert.ok(facebookQuery(need).query.includes("iphone 12 pro"));
  });

  test("iPhone 13 Pro Max garde la variante complète", () => {
    const q = coinAfriqueQuery(parseNeed("iPhone 13 Pro Max 256 Go"));
    assert.equal(new URL(q.url).searchParams.get("keyword"), "iphone 13 pro max");
  });

  test("les requêtes de secours dépendent du besoin (plus fixées sur l'iPhone 12)", () => {
    assert.ok(!("SERP_QUERIES" in env), "SERP_QUERIES codé en dur doit disparaître");
    const canape = serpQueries(parseNeed("canapé à Cocody"));
    const plombier = serpQueries(parseNeed("plombier à Bouaké"));
    assert.ok(canape.length > 0 && plombier.length > 0);
    assert.ok(canape.every((q) => !/iphone/i.test(q)), canape.join(" | "));
    assert.ok(canape.some((q) => /canape/i.test(q)));
    assert.ok(plombier.some((q) => /plombier/i.test(q) && /bouake/i.test(q)));
    assert.notDeepEqual(canape, plombier);
  });

  test("variante comptée au filtrage : Pro Max annoncé n'est pas un Pro", () => {
    const need = parseNeed("iPhone 12 Pro 128 Go");
    const ev = evaluateListing(need, listing({ title: "iPhone 12 Pro Max 128Gb" }));
    assert.equal(ev.model.state, "incompatible");
  });
});

// ─── P1-5 : affirmations IA et « correspondance exacte » ───────────────────
describe("P1-5 — l'IA ne peut plus afficher d'affirmations inventées", () => {
  const need = parseNeed("iPhone 12 · 128 Go, bon état, à Abidjan, max 150 000 FCFA");

  test("critère IA dont l'extrait est absent de l'annonce : non affiché", () => {
    const ev = evaluateListing(need, listing({ description: "Téléphone en bon état" }));
    const [s] = scoreListings(need, [ev], [
      {
        idx: 0,
        score: 0.9,
        criteres: [
          { nom: "garantie", valeur: "12 mois", extrait: "garantie constructeur 12 mois" },
        ],
      },
    ]);
    assert.ok(!/garantie/i.test(s.raison), s.raison);
    assert.equal(s.criteria.length, 0, "critère non vérifié écarté");
  });

  test("critère IA dont la valeur contredit l'extrait : non affiché", () => {
    const ev = evaluateListing(need, listing({ description: "batterie 85%" }));
    const [s] = scoreListings(need, [ev], [
      {
        idx: 0,
        score: 0.9,
        criteres: [{ nom: "batterie", valeur: "99%", extrait: "batterie 85%" }],
      },
    ]);
    assert.ok(!s.raison.includes("99"), s.raison);
  });

  test("critère IA vérifié (extrait réel, valeur cohérente) : affiché", () => {
    const ev = evaluateListing(need, listing({ description: "batterie 85%, écran sans rayure" }));
    const [s] = scoreListings(need, [ev], [
      { idx: 0, score: 0.9, criteres: [{ nom: "batterie", valeur: "85%", extrait: "batterie 85%" }] },
    ]);
    assert.ok(s.raison.includes("batterie : 85%"), s.raison);
  });

  test("« exacte » impossible si la zone demandée est inconnue", () => {
    const ev = evaluateListing(
      need,
      listing({ zone: null, description: "en bon état" }),
    );
    const [s] = scoreListings(need, [ev], null);
    assert.ok(!s.raison.startsWith("Correspondance exacte"), s.raison);
  });

  test("« exacte » impossible si l'état demandé n'est pas vérifié", () => {
    const ev = evaluateListing(need, listing({ description: null }));
    const [s] = scoreListings(need, [ev], null);
    assert.ok(!s.raison.startsWith("Correspondance exacte"), s.raison);
    assert.ok(/état.*(non vérifié|à confirmer)|bon etat.*(non vérifié|à confirmer)/i.test(s.raison), s.raison);
  });

  test("témoin : « exacte » reste possible quand tout est confirmé", () => {
    const ev = evaluateListing(need, listing({ description: "iPhone en bon état général" }));
    const [s] = scoreListings(need, [ev], null);
    assert.ok(s.raison.startsWith("Correspondance exacte"), s.raison);
  });
});

// ─── P1-6 : clé de cache des pages ─────────────────────────────────────────
describe("P1-6 — clé de cache des pages distincte par annonce", () => {
  test("annonce?id=1 ≠ annonce?id=2", () => {
    assert.notEqual(
      pageCacheKey("https://site.ci/annonce?id=1"),
      pageCacheKey("https://site.ci/annonce?id=2"),
    );
  });
  test("paramètres de suivi seuls ignorés", () => {
    assert.equal(
      pageCacheKey("https://site.ci/annonce?id=1&utm_source=wa"),
      pageCacheKey("https://site.ci/annonce?id=1"),
    );
  });
});

// ─── P2-7 : indices IA validés par lot ─────────────────────────────────────
describe("P2-7 — indice invalide d'un lot ne note pas le lot suivant", () => {
  test("idx 10 dans un lot de 10 est rejeté avant le décalage global", async () => {
    const need = parseNeed("iPhone 12 128 Go");
    const evs = Array.from({ length: 12 }, (_, i) =>
      evaluateListing(need, listing({ id: `l${i}`, title: `iPhone 12 - 128Gb #${i}` })),
    );
    const out = await scoreWithAi(need, evs, {
      batchSize: 10,
      ai: async (_n, chunk) =>
        chunk.length === 10
          ? [{ idx: 0, score: 0.5 }, { idx: 10, score: 0.99 }] // 10 = hors lot
          : [{ idx: 0, score: 0.4 }],
    });
    assert.ok(out.invalid.some((m) => m.includes("hors lot")), out.invalid.join(";"));
    assert.ok(
      !out.items.some((it) => it.idx === 10 && it.score === 0.99),
      "le score 0.99 ne doit être attribué à aucune annonce",
    );
    assert.equal(out.items.find((it) => it.idx === 10)?.score, 0.4, "l'annonce 10 garde son propre score");
  });
});

// ─── P2-8 : alternatives sans doublon ──────────────────────────────────────
describe("P2-8 — l'option alternatives ne duplique plus les offres", () => {
  const need = parseNeed("iPhone 12 · 128 Go à Abidjan, max 150 000 FCFA");
  const list = [
    listing({ id: "ok", price: 100000 }),
    listing({ id: "cher", price: 200000, url: "https://s.ci/a-cher" }),
  ];

  test("classify : candidates et alternatives disjointes", () => {
    const r = classify(list, need);
    const ids = [...r.candidates, ...r.alternatives].map((e) => e.listing.id);
    assert.equal(new Set(ids).size, ids.length, ids.join(","));
  });

  test("rankAndSplit : alternatives présentées séparément, chaque offre une seule fois", async () => {
    const r = classify(list, need);
    const res = await rankAndSplit(need, r, {
      includeAlternatives: true,
      ai: async () => null,
    });
    const ids = [...res.candidates, ...res.alternatives].map((s) => s.evaluated.listing.id);
    assert.equal(new Set(ids).size, ids.length, ids.join(","));
    assert.deepEqual(res.alternatives.map((s) => s.evaluated.listing.id), ["cher"]);
    assert.deepEqual(res.candidates.map((s) => s.evaluated.listing.id), ["ok"]);
  });

  test("sans l'option : alternatives non notées ni présentées", async () => {
    const r = classify(list, need);
    let scoredTitles: string[] = [];
    const res = await rankAndSplit(need, r, {
      includeAlternatives: false,
      batchSize: 10,
      ai: async (_n, chunk) => {
        scoredTitles = chunk.map((c) => c.listing.id);
        return chunk.map((_, i) => ({ idx: i, score: 0.8 }));
      },
    });
    assert.equal(res.alternatives.length, 0);
    assert.equal(res.scoredCount, 1);
    assert.deepEqual(scoredTitles, ["ok"], "l'IA ne doit voir que les candidates");
  });
});

// ─── P2-9 : émission progressive et délais bornés ──────────────────────────
describe("P2-9 — émission progressive et annulation bornée", () => {
  const ok = (source: string, n: number): SourceResult => ({
    source,
    query: "q",
    capabilities: { search: true, location: false, pagination: false, itemCheck: false, services: false, unsupported: [] },
    warnings: [],
    listings: Array.from({ length: n }, (_, i) => listing({ id: `${source}${i}`, source })),
    status: "ok",
    durationMs: 1,
    errors: [],
  });

  test("onResult reçoit chaque source dès sa terminaison, avant la plus lente", async () => {
    const seen: { source: string; at: number }[] = [];
    const t0 = Date.now();
    const runners: Runner[] = [
      { name: "rapide", browser: false, run: async () => ok("rapide", 2) },
      { name: "lente", browser: false, run: async () => { await new Promise((r) => setTimeout(r, 300)); return ok("lente", 1); } },
    ];
    await runSources(runners, {
      onResult: (r) => seen.push({ source: r.source, at: Date.now() - t0 }),
    });
    assert.equal(seen.length, 2);
    assert.equal(seen[0].source, "rapide");
    assert.ok(seen[0].at < 150, `rapide émis à ${seen[0].at} ms`);
    assert.ok(seen[1].at >= 280);
  });

  test("délai par source : la source trop lente est coupée, les autres restent", async () => {
    let aborted = false;
    const runners: Runner[] = [
      { name: "rapide", browser: false, run: async () => ok("rapide", 2) },
      {
        name: "bloquee",
        browser: false,
        run: (signal) =>
          new Promise<SourceResult>((resolve) => {
            signal?.addEventListener("abort", () => { aborted = true; });
            setTimeout(() => resolve(ok("bloquee", 9)), 2000); // ignore l'annulation
          }),
      },
    ];
    const t0 = Date.now();
    const { results } = await runSources(runners, { sourceTimeoutMs: 120 });
    assert.ok(Date.now() - t0 < 1000, `retour en ${Date.now() - t0} ms, sans attendre la source bloquée`);
    assert.equal(results.find((r) => r.source === "bloquee")?.status, "timeout");
    assert.equal(results.find((r) => r.source === "rapide")?.listings.length, 2);
    assert.ok(aborted, "le signal d'annulation a été envoyé");
  });
});
