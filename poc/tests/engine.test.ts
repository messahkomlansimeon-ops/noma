/**
 * Moteur réutilisable (étape 1 « multi-utilisateur ») : pipeline en fonction,
 * état isolé par run, artefacts optionnels, plafond IA. Tests hors ligne.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runSearch, type RunSearchOptions, type RunProgressSnapshot } from "../lib/engine";
import { cached, cacheKey, __resetCache } from "../lib/cache";
import { runWithCtx } from "../lib/log";
import { llmJson } from "../lib/llm";
import { z } from "zod";
import type { Runner } from "../lib/orchestrate";
import type { SourceResult } from "../sources/types";
import type { RawListing } from "../lib/normalize";

const annonce = (over: Partial<RawListing> = {}): RawListing => ({
  id: "x", source: "coinafrique", title: "iPhone 12 128 Go", price: 135000,
  currency: "FCFA", zone: "Cocody", vendor: null, url: null, photo: null,
  date: "il y a 2 h", description: "bon état", ...over,
});

const baseResult = (name: string, listings: RawListing[], status: SourceResult["status"] = "ok"): SourceResult => ({
  source: name,
  query: "q",
  capabilities: { search: true, location: false, pagination: false, itemCheck: false, services: false, unsupported: [] },
  warnings: [],
  listings,
  status,
  durationMs: 1000,
  errors: [],
});

const cachedRunner = (name: string, listings: RawListing[]): Runner => ({
  name,
  browser: false,
  run: () =>
    cached(
      cacheKey(name, "v1", "q"),
      async () => baseResult(name, listings),
      (r) => r.status === "ok" || r.status === "empty",
    ),
});

const blockerRunner = (name: string): Runner => ({
  name,
  browser: false,
  run: async () => baseResult(name, [], "blocked"),
});

const opts = (over: Partial<RunSearchOptions>): RunSearchOptions => ({
  needText: "iPhone 12 · 128 Go, à Abidjan, max 150 000 FCFA",
  ai: null, // hors ligne : IA désactivée (score déterministe conservé)
  log: () => {},
  ...over,
});

describe("runSearch — pipeline réutilisable, hors ligne", () => {
  const tmp = mkdtempSync(join(tmpdir(), "noma-engine-"));
  __resetCache(join(tmp, "cache.json"));

  test("résultat complet : sources, dédup, classification, score déterministe", async () => {
    const r = await runSearch(opts({
      runners: [
        cachedRunner("fakea", [annonce(), annonce({ id: "x2", title: "Coque iPhone 12" })]),
        blockerRunner("fakeb"),
      ],
    }));
    assert.equal(r.need.model, "iphone 12");
    assert.equal(r.brutes.length, 2);
    assert.equal(r.dedup.exactDuplicates, 0);
    assert.equal(r.classification.candidates.length, 1, "la coque est rejetée pour un besoin téléphone");
    assert.equal(r.classification.rejected.length, 1);
    assert.equal(r.finalListings.length, 1);
    assert.equal(r.stats.offresBrutes, 2);
    assert.equal(r.stats.appelsIA, 0, "IA désactivée (ai:null)");
    assert.ok(r.finalListings[0].score !== null);
    assert.equal(r.stats.syntheseSources.verdict, "résultats disponibles");
    assert.ok(r.stats.bilanSources[0].includes("fakea : succès"), r.stats.bilanSources[0]);
  });

  test("aucun fichier écrit sans artifactsDir", async () => {
    const r = await runSearch(opts({ runners: [cachedRunner("fakes", [annonce()])] }));
    assert.equal(r.artifactsDir, undefined);
  });

  test("artefacts écrits quand artifactsDir fourni (partiel inclus)", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "noma-art-")), "run");
    await runSearch(opts({ runners: [cachedRunner("fakea", [annonce()])], artifactsDir: dir }));
    for (const f of ["annonces.json", "brutes.json", "search-results.json", "ledger.json", "partiel-fakea.json"]) {
      assert.ok(existsSync(join(dir, f)), `${f} manquant`);
    }
    const sr = JSON.parse(readFileSync(join(dir, "search-results.json"), "utf-8"));
    assert.equal(sr.besoinParse.model, "iphone 12");
    assert.ok(sr.bilanSources.length > 0);
  });

  test("ambiguïté structurante : question avant tout connecteur", async () => {
    let runnerCalls = 0;
    const r = await runSearch(opts({
      needText: "Je cherche une console",
      runners: [{
        name: "jamais",
        browser: false,
        run: async () => {
          runnerCalls++;
          return baseResult("jamais", []);
        },
      }],
      understander: async () => ({
        canonicalProduct: "console",
        category: "ambigu",
        searchTerms: ["console"],
        requirements: [], preferences: [], exclusions: [], confidence: 0.5,
        clarification: {
          id: "product-intent",
          question: "Quel type de console cherchez-vous ?",
          options: ["Console de jeux", "Meuble console"],
        },
        source: "ai",
      }),
    }));
    assert.equal(runnerCalls, 0);
    assert.equal(r.clarification?.id, "product-intent");
    assert.equal(r.finalListings.length, 0);
  });

  test("une précision reste séparée : le budget final de la demande est conservé", async () => {
    const r = await runSearch(opts({
      needText: "console Abidjan 150 000",
      clarificationAnswer: "Console de jeux",
      runners: [{
        name: "fake-console",
        browser: false,
        run: async () => baseResult("fake-console", [annonce({
          title: "Console de jeux PS5",
          price: 250_000,
          zone: "Abidjan",
        })]),
      }],
    }));
    assert.equal(r.need.budget?.amount, 150_000);
    assert.equal(r.understanding.canonicalProduct, "Console de jeux");
    assert.equal(r.classification.candidates.length, 0);
    assert.equal(r.classification.alternatives.length, 1, "250 000 F reste hors du plafond de 150 000 F");
  });
});

describe("runSearch — isolation par run (multi-utilisateurs)", () => {
  const tmp = mkdtempSync(join(tmpdir(), "noma-engine2-"));
  __resetCache(join(tmp, "cache.json"));

  test("deux recherches simultanées : journaux et compteurs cache séparés", async () => {
    __resetCache(join(mkdtempSync(join(tmpdir(), "noma-cache3-")), "cache.json"));
    const logs: Record<string, string[]> = { a: [], b: [] };
    const [ra, rb] = await Promise.all([
      runSearch(opts({
        needText: "canapé à Cocody",
        runners: [cachedRunner("fakea", [annonce({ title: "Canapé 3 places" })])],
        log: (l) => logs.a.push(l),
      })),
      runSearch(opts({
        needText: "vélo électrique à Bouaké",
        runners: [cachedRunner("fakeb", [annonce({ title: "Vélo électrique" })])],
        log: (l) => logs.b.push(l),
      })),
    ]);
    // chaque run voit SES sources et son besoin
    assert.ok(ra.need.product.includes("canape"), ra.need.product);
    assert.ok(ra.sources.every((s) => s.source === "fakea"), ra.sources.map((s) => s.source).join(","));
    assert.ok(rb.sources.every((s) => s.source === "fakeb"));
    assert.ok(!logs.a.some((l) => l.includes("fakeb")), "journal a : aucune ligne de b");
    assert.ok(!logs.b.some((l) => l.includes("fakea")), "journal b : aucune ligne de a");
    // compteurs cache PAR RUN : chaque run = 1 lecture fraîche (1 miss + 1 écriture)
    assert.deepEqual(
      { hits: ra.stats.cache.hits, misses: ra.stats.cache.misses, writes: ra.stats.cache.writes },
      { hits: 0, misses: 1, writes: 1 },
    );
    assert.deepEqual(
      { hits: rb.stats.cache.hits, misses: rb.stats.cache.misses, writes: rb.stats.cache.writes },
      { hits: 0, misses: 1, writes: 1 },
    );
  });

  test("2e exécution du même besoin : le run voit le HIT dans SES compteurs", async () => {
    __resetCache(join(mkdtempSync(join(tmpdir(), "noma-cache4-")), "cache.json"));
    const runners = [cachedRunner("fakec", [annonce()])];
    await runSearch(opts({ runners })); // écriture du cache
    const r2 = await runSearch(opts({ runners })); // hit
    assert.equal(r2.stats.cache.hits, 1);
    assert.equal(r2.stats.cacheEtat, "chaud");
    assert.equal(r2.stats.cache.misses, 0);
    assert.equal(r2.stats.appelsIA, 0);
  });
});

describe("plafond de dépense IA (étape 3, préparé au niveau llmJson)", () => {
  test("au-delà du plafond : aucun appel réseau, erreur explicite", async () => {
    let fetchCalls = 0;
    await assert.rejects(
      () =>
        runWithCtx(
          {
            log: () => {},
            entries: [
              { task: "scoring", model: "m", cost: 0.5, promptTokens: 0, completionTokens: 0, ts: "" },
            ],
            maxCostUsd: 0.1,
            cache: { hits: 0, misses: 0, writes: 0, skipped: 0, bySource: {} },
          },
          () =>
            llmJson(z.object({ ok: z.boolean() }), {
              task: "t",
              system: "s",
              user: "u",
              fetchImpl: (() => {
                fetchCalls++;
                throw new Error("ne doit pas être appelé");
              }) as typeof fetch,
            }),
        ),
      /budget IA épuisé/,
    );
    assert.equal(fetchCalls, 0, "aucun crédit dépensé au-delà du plafond");
  });

  test("P1 — plafond 0 $ : strict, secours compris (0 appel fournisseur)", async () => {
    let fetchCalls = 0;
    await assert.rejects(
      () =>
        runWithCtx(
          {
            log: () => {},
            entries: [],
            maxCostUsd: 0,
            aiEnabled: true,
            cache: { hits: 0, misses: 0, writes: 0, skipped: 0, bySource: {} },
          },
          () =>
            llmJson(z.object({ ok: z.boolean() }), {
              task: "t", system: "s", user: "u",
              models: ["m1", "m2"],
              fetchImpl: (async () => {
                fetchCalls++;
                return { ok: true, json: async () => ({}) };
              }) as unknown as typeof fetch,
            }),
        ),
      /budget IA/,
    );
    assert.equal(fetchCalls, 0, "plafond 0 = strict, y compris modèles de secours");
  });

  test("P1 — borne > solde : appel refusé AVANT tout appel fournisseur", async () => {
    // reproduction utilisateur : plafond 0,005 $ (et 0,01 $) — la BORNE de
    // l'appel (entrée estimée + sortie max × prix plafonné) dépasse le solde
    let fetchCalls = 0;
    for (const cap of [0.005, 0.01]) {
      await assert.rejects(
        () =>
          runWithCtx(
            {
              log: () => {}, entries: [], maxCostUsd: cap, aiEnabled: true,
              reservedUsd: 0,
              cache: { hits: 0, misses: 0, writes: 0, skipped: 0, bySource: {} },
            },
            () =>
              llmJson(z.object({ ok: z.boolean() }), {
                task: "t", system: "s", user: "u",
                models: ["fournisseur-inconnu/x"],
                maxTokens: 2000,
                fetchImpl: (async () => { fetchCalls++; return { ok: true, json: async () => ({}) }; }) as unknown as typeof fetch,
              }),
          ),
        /borne de l'appel .* > solde/,
      );
    }
    assert.equal(fetchCalls, 0, "aucun appel au-delà du solde — plus de Math.min()");
  });

  test("P1 — réservation = borne : un appel simultané du même run ne franchit pas le plafond", async () => {
    const ctx = {
      log: () => {},
      entries: [] as { task: string; model: string; cost: number | null; promptTokens: number; completionTokens: number; ts: string }[],
      maxCostUsd: 0.005,
      aiEnabled: true,
      reservedUsd: 0,
      cache: { hits: 0, misses: 0, writes: 0, skipped: 0, bySource: {} },
    };
    let fetchCalls = 0;
    const slowFetch = (async () => {
      fetchCalls++;
      await new Promise((r) => setTimeout(r, 40));
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: '{"ok":true}' } }],
          usage: { cost: 0.001, prompt_tokens: 10, completion_tokens: 5 },
        }),
      };
    }) as unknown as typeof fetch;
    const schema = z.object({ ok: z.boolean() });
    // entrée volumineuse → borne gpt-4o-mini ≈ 0,0022 $ ; 2 appels
    // simultanés : le 1er réserve sa borne, le 2e n'a plus le solde
    const bigUser = "x".repeat(9000);
    const results = await Promise.allSettled(
      Array.from({ length: 2 }, () =>
        runWithCtx(ctx, () => llmJson(schema, { task: "t", system: "s", user: bigUser, fetchImpl: slowFetch })),
      ),
    );
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    assert.equal(fetchCalls, 1, "la borne réservée bloque le 2e appel simultané");
    assert.equal(fulfilled.length, 1);
    assert.ok(String((rejected[0] as PromiseRejectedResult).reason).includes("solde"));
    assert.equal(ctx.reservedUsd, 0, "borne relâchée après l'appel");
    assert.equal(ctx.entries.length, 1);
  });

  test("P1 — frais de recherche web inclus dans la borne (hors tokens)", async () => {
    let fetchCalls = 0;
    await assert.rejects(
      () =>
        runWithCtx(
          {
            log: () => {}, entries: [], maxCostUsd: 0.02, aiEnabled: true,
            reservedUsd: 0,
            cache: { hits: 0, misses: 0, writes: 0, skipped: 0, bySource: {} },
          },
          () =>
            llmJson(z.object({ ok: z.boolean() }), {
              task: "google-online", system: "s", user: "u",
              webSearch: true,
              fetchImpl: (async () => { fetchCalls++; return { ok: true, json: async () => ({}) }; }) as unknown as typeof fetch,
            }),
        ),
        /borne de l'appel .* > solde/,
    );
    assert.equal(fetchCalls, 0, "le plafond web (0,05 $) dépasse le budget : refusé");
  });

  test("P1 — interruption après envoi : réserve conservée, appels suivants bloqués", async () => {
    const ctx = {
      log: () => {},
      entries: [] as { task: string; model: string; cost: number | null; promptTokens: number; completionTokens: number; ts: string }[],
      maxCostUsd: 0.02,
      aiEnabled: true,
      reservedUsd: 0,
      cache: { hits: 0, misses: 0, writes: 0, skipped: 0, bySource: {} },
    };
    let fetchCalls = 0;
    const droppedFetch = (async () => {
      fetchCalls++;
      await new Promise((r) => setTimeout(r, 10));
      throw new Error("connexion réinitialisée après envoi");
    }) as unknown as typeof fetch;
    // 1er appel : envoi puis coupure → facturation INCERTE ; le modèle de
    // secours est bloqué par la garde (arrêt conservateur) avant tout appel
    await assert.rejects(
      () => runWithCtx(ctx, () => llmJson(z.object({ ok: z.boolean() }), {
        task: "scoring", system: "s", user: "u", fetchImpl: droppedFetch,
      })),
      /coût d'un appel inconnu/,
    );
    assert.equal(fetchCalls, 1);
    assert.ok((ctx.reservedUsd ?? 0) > 0, `réserve conservée (=${ctx.reservedUsd})`);
    assert.equal(ctx.entries.length, 1);
    assert.equal(ctx.entries[0].cost, null, "coût inconnu enregistré");
    // 2e appel : bloqué jusqu'à réconciliation (arrêt conservateur)
    let secondCalls = 0;
    await assert.rejects(
      () => runWithCtx(ctx, () => llmJson(z.object({ ok: z.boolean() }), {
        task: "scoring", system: "s", user: "u",
        fetchImpl: (async () => { secondCalls++; return { ok: true, json: async () => ({}) }; }) as unknown as typeof fetch,
      })),
      /coût d'un appel inconnu/,
    );
    assert.equal(secondCalls, 0, "aucun nouvel appel tant que la facturation n'est pas réconciliée");
  });

  test("estimation prévisionnelle : appel accepté quand la borne tient dans le solde", async () => {
    let fetchCalls = 0;
    const ctx = {
      log: () => {},
      entries: [] as { task: string; model: string; cost: number | null; promptTokens: number; completionTokens: number; ts: string }[],
      maxCostUsd: 0.02,
      aiEnabled: true,
      reservedUsd: 0,
      cache: { hits: 0, misses: 0, writes: 0, skipped: 0, bySource: {} },
    };
    const res = await runWithCtx(ctx, () =>
      llmJson(z.object({ ok: z.boolean() }), {
        task: "t", system: "s", user: "u",
        models: ["openai/gpt-4o-mini"],
        fetchImpl: (async () => {
          fetchCalls++;
          return {
            ok: true,
            json: async () => ({
              choices: [{ message: { content: '{"ok":true}' } }],
              usage: { cost: 0.001, prompt_tokens: 10, completion_tokens: 5 },
            }),
          };
        }) as unknown as typeof fetch,
      }),
    );
    assert.equal(res.data.ok, true);
    assert.equal(fetchCalls, 1);
    assert.equal(ctx.reservedUsd, 0);
    assert.equal(ctx.entries[0].cost, 0.001);
  });

  test("P1 — coût inconnu : conservateur, plafond considéré atteint", async () => {
    let fetchCalls = 0;
    await assert.rejects(
      () =>
        runWithCtx(
          {
            log: () => {},
            entries: [
              { task: "scoring", model: "m", cost: null, promptTokens: 0, completionTokens: 0, ts: "" },
            ],
            maxCostUsd: 5,
            aiEnabled: true,
            cache: { hits: 0, misses: 0, writes: 0, skipped: 0, bySource: {} },
          },
          () =>
            llmJson(z.object({ ok: z.boolean() }), {
              task: "t", system: "s", user: "u",
              fetchImpl: (() => { fetchCalls++; throw new Error("interdit"); }) as typeof fetch,
            }),
        ),
      /coût d'un appel inconnu/,
    );
    assert.equal(fetchCalls, 0);
  });

  test("P1 — ai:null désactive TOUS les chemins IA (llmJson = porte unique)", async () => {
    let fetchCalls = 0;
    await assert.rejects(
      () =>
        runWithCtx(
          {
            log: () => {},
            entries: [],
            aiEnabled: false,
            cache: { hits: 0, misses: 0, writes: 0, skipped: 0, bySource: {} },
          },
          () =>
            llmJson(z.object({ ok: z.boolean() }), {
              task: "t", system: "s", user: "u",
              fetchImpl: (() => { fetchCalls++; throw new Error("interdit"); }) as typeof fetch,
            }),
        ),
      /IA désactivée pour ce run/,
    );
    assert.equal(fetchCalls, 0, "extraction Google / secours SERP inclus");
  });

  test("P1 — annulation atteint le scoring : aucun lot traité après abort", async () => {
    const controller = new AbortController();
    controller.abort(); // annulé AVANT le scoring
    const r = await runSearch(opts({
      signal: controller.signal,
      ai: undefined, // chemin IA RÉEL — ne doit jamais être appelé
      runners: [cachedRunner("fakea", [annonce(), annonce({ id: "x2", title: "Canapé 2 places" })])],
    }));
    assert.equal(r.stats.appelsIA, 0, "le signal est passé jusqu'au scoring");
    assert.ok(r.finalListings.every((s) => s.aiStatus === "non évalué par IA"));
  });

  test("P2 — preuves navigateur : dossier par run si artefacts, sinon rien", async () => {
    const { evidenceDir } = await import("../lib/evidence");
    const dir = mkdtempSync(join(tmpdir(), "noma-ev-"));
    const inside = await runWithCtx(
      {
        log: () => {}, entries: [], aiEnabled: true,
        artifactsDir: dir,
        cache: { hits: 0, misses: 0, writes: 0, skipped: 0, bySource: {} },
      },
      async () => evidenceDir("facebook"),
    );
    assert.ok(inside === join(dir, "evidence-facebook"), inside ?? "null");
    assert.ok(existsSync(inside!));
    assert.equal(evidenceDir("facebook"), null, "hors run avec artefacts : aucune écriture");
  });
});

// ─── Lot 3 : émission progressive (onProgress, indépendant des artefacts) ───

describe("runSearch — progression (onProgress)", () => {
  __resetCache(join(mkdtempSync(join(tmpdir(), "noma-prog-")), "cache.json"));

  const instantRunner = (name: string, listings: RawListing[]): Runner => ({
    name,
    browser: false,
    run: async () => baseResult(name, listings),
  });

  const slowRunner = (
    name: string,
    listings: RawListing[],
    delayMs: number,
  ): Runner => ({
    name,
    browser: false,
    run: (signal) =>
      new Promise<SourceResult>((resolve) => {
        const t = setTimeout(() => resolve(baseResult(name, listings)), delayMs);
        t.unref?.();
        signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(t);
            resolve(baseResult(name, [], "timeout"));
          },
          { once: true },
        );
      }),
  });

  test("une source rapide publie AVANT une source lente ; instantané complet classé", async () => {
    const snapshots: RunProgressSnapshot[] = [];
    const r = await runSearch(opts({
      runners: [
        slowRunner("lente", [annonce({ id: "L1", title: "iPhone 12 128 Go", price: 149000 })], 150),
        instantRunner("rapide", [annonce({ id: "R1" }), annonce({ id: "R2", title: "Coque iPhone 12", price: 3000 })]),
      ],
      onProgress: (s) => snapshots.push(s),
    }));
    // 1er instantané = source rapide seule, reçu pendant que la lente tournait
    assert.equal(snapshots.length, 2);
    assert.equal(snapshots[0].arrivedFrom, "rapide");
    assert.equal(snapshots[0].counts.brutes, 2);
    assert.ok(
      snapshots[0].offers.some((o) => o.evaluated.listing.id === "R1"),
      "offre de la source rapide déjà publiée",
    );
    assert.ok(!snapshots[0].offers.some((o) => o.evaluated.listing.id === "L1"));
    // 2e instantané = complet (lente incluse), dédup + classification appliquées
    assert.equal(snapshots[1].arrivedFrom, "lente");
    assert.equal(snapshots[1].counts.brutes, 3);
    // la coque est rejetée pour un besoin téléphone — jamais dans les offres
    for (const s of snapshots) {
      assert.ok(s.offers.every((o) => o.evaluated.listing.title !== "Coque iPhone 12"));
      assert.ok(s.counts.rejets >= 1);
    }
    // classement déterministe : score décroissant strict
    const scores = snapshots[1].offers.map((o) => o.score ?? 0);
    for (let i = 1; i < scores.length; i++) assert.ok(scores[i - 1] >= scores[i]);
    // instantanés = score DÉTERMINISTE (aiStatus « non évalué par IA ») ;
    // le scoring IA reste dans le pipeline final (r.finalListings)
    for (const s of snapshots) {
      assert.ok(s.offers.every((o) => o.aiStatus === "non évalué par IA"));
    }
    // le résultat final est inchangé par la progression (1 candidate + coque rejetée)
    assert.equal(r.finalListings.length, 2, "L1 + R1 évaluées au final");
  });

  test("panne isolée : la source en erreur n'empêche pas la publication des autres", async () => {
    const snapshots: RunProgressSnapshot[] = [];
    await runSearch(opts({
      runners: [
        blockerRunner("cassée"),
        instantRunner("saine", [annonce({ id: "S1" })]),
      ],
      onProgress: (s) => snapshots.push(s),
    }));
    assert.equal(snapshots.length, 1);
    assert.equal(snapshots[0].arrivedFrom, "saine");
    assert.ok(snapshots[0].offers.some((o) => o.evaluated.listing.id === "S1"));
  });

  test("annulation : plus aucune publication après abort, résultats déjà émis préservés", async () => {
    const controller = new AbortController();
    const snapshots: RunProgressSnapshot[] = [];
    await runSearch(opts({
      signal: controller.signal,
      runners: [
        slowRunner("lente", [annonce({ id: "L1" })], 300),
        instantRunner("rapide", [annonce({ id: "R1" })]),
      ],
      onProgress: (s) => {
        snapshots.push(s);
        // annulation dès la 1re publication : la lente ne doit plus publier
        if (s.arrivedFrom === "rapide") controller.abort();
      },
    }));
    assert.equal(snapshots.length, 1, "aucun instantané après abort");
    assert.equal(snapshots[0].arrivedFrom, "rapide");
  });

  test("annulé avant le démarrage : aucun snapshot, aucun appel", async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    const snapshots: RunProgressSnapshot[] = [];
    await runSearch(opts({
      signal: controller.signal,
      runners: [{ name: "x", browser: false, run: async () => { calls++; return baseResult("x", [annonce()]); } }],
      onProgress: (s) => snapshots.push(s),
    }));
    assert.equal(calls, 0);
    assert.equal(snapshots.length, 0);
  });

  test("deux recherches simultanées : instantanés isolés par run", async () => {
    const snapsA: RunProgressSnapshot[] = [];
    const snapsB: RunProgressSnapshot[] = [];
    await Promise.all([
      runSearch(opts({
        needText: "canapé à Cocody",
        runners: [instantRunner("fakea", [annonce({ id: "A1", title: "Canapé 3 places", price: 185000 })])],
        onProgress: (s) => snapsA.push(s),
      })),
      runSearch(opts({
        needText: "vélo électrique à Bouaké",
        runners: [instantRunner("fakeb", [annonce({ id: "B1", title: "Vélo électrique", price: 90000 })])],
        onProgress: (s) => snapsB.push(s),
      })),
    ]);
    assert.equal(snapsA.length, 1);
    assert.equal(snapsB.length, 1);
    assert.ok(snapsA[0].offers.every((o) => o.evaluated.listing.id === "A1"), "A ne voit pas B");
    assert.ok(snapsB[0].offers.every((o) => o.evaluated.listing.id === "B1"), "B ne voit pas A");
  });
});

describe("runSearch — champs structurés du formulaire (Lot 2)", () => {
  __resetCache(join(mkdtempSync(join(tmpdir(), "noma-struct-")), "cache.json"));

  test("budget FCFA explicite prime ; vide = valeur du texte ; localisation prime", async () => {
    const r = await runSearch(opts({
      needText: "iPhone 12 à Cocody, max 150 000 FCFA",
      runners: [cachedRunner("fakea", [annonce()])],
      structured: { budgetFcfa: 100_000, location: "Bouaké" },
    }));
    assert.deepEqual(r.need.budget, { amount: 100_000, currency: "XOF", explicitCurrency: true });
    assert.equal(r.need.zone, "bouaké");
  });

  test("mode service explicite : prime sur le type extrait du texte", async () => {
    const r = await runSearch(opts({
      needText: "iPhone 12 à Abidjan", // texte produit
      runners: [cachedRunner("fakea", [annonce()])],
      structured: { mode: "service" },
    }));
    assert.equal(r.need.kind, "service");
    const r2 = await runSearch(opts({
      needText: "réparation climatiseur", // texte service
      runners: [cachedRunner("fakea", [annonce()])],
      structured: { mode: "achat" },
    }));
    assert.equal(r2.need.kind, "produit");
  });

  test("champs vides : budget et zone extraits du texte conservés (aucun défaut)", async () => {
    const r = await runSearch(opts({
      needText: "iPhone 12 à Cocody, max 150 000 FCFA",
      runners: [cachedRunner("fakea", [annonce()])],
      structured: { budgetFcfa: null, location: "" },
    }));
    assert.equal(r.need.budget?.amount, 150_000);
    assert.equal(r.need.zone, "cocody"); // extraction : zone en minuscules
    const r2 = await runSearch(opts({
      needText: "climatiseur 12000 BTU",
      runners: [cachedRunner("fakea", [annonce()])],
      structured: { budgetFcfa: null, location: null },
    }));
    assert.equal(r2.need.budget, null, "aucun budget par défaut injecté");
    assert.equal(r2.need.zone, null);
  });
});
