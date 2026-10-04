/**
 * Mesures & charge (revue « chiffres pour décider d'un proxy »).
 * Tests locaux : aucun réseau, sommeil injecté, cache dans un fichier temp.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { cached, cacheStats, cacheStatsBySource, ttlForKey, avecCache, SOURCE_TTL_MS, __resetCache, type CacheReadMeta } from "../lib/cache";
import { withRetry } from "../lib/retry";
import { bilanSources, summarizeSources } from "../lib/orchestrate";
import { safeFetch, SafeFetchError } from "../lib/fetch";
import { anonymiserBesoin, parseNeed } from "../lib/need";
import type { SourceResult } from "../sources/types";
import type { RawListing } from "../lib/normalize";

const annonce: RawListing = {
  id: "x", source: "coinafrique", title: "Annonce", price: 1000,
  currency: "FCFA", zone: "Abidjan", vendor: null, url: null, photo: null,
  date: null, description: null,
};

// ─── Confidentialité : la demande ne transporte jamais de coordonnées ──────
describe("anonymiserBesoin — téléphones et e-mails masqués, prix lisibles", () => {
  test("téléphones : paires, collés, +225", () => {
    assert.equal(anonymiserBesoin("appelle 07 58 96 75 41"), "appelle [téléphone]");
    assert.equal(anonymiserBesoin("WhatsApp 0705896741"), "WhatsApp [téléphone]");
    assert.equal(anonymiserBesoin("+225 07 58 96 75 41"), "+225 [téléphone]");
    assert.equal(anonymiserBesoin("+2250758967541"), "[téléphone]");
    assert.equal(anonymiserBesoin("2250758967541"), "[téléphone]");
    assert.equal(anonymiserBesoin("écris jean@yahoo.fr"), "écris [e-mail]");
  });

  test("P1 — espaces insécables dans les paires : masqués aussi", () => {
    assert.equal(
      anonymiserBesoin("appelle 07\u00a058\u00a096\u00a075\u00a041"),
      "appelle [téléphone]",
    );
    assert.equal(
      anonymiserBesoin("numéro 07\u202f58\u202f96\u202f75\u202f41"),
      "numéro [téléphone]",
    );
  });

  test("P2 — montants explicites préservés, même sur 8 chiffres", () => {
    assert.equal(
      anonymiserBesoin("voiture budget 15000000 FCFA"),
      "voiture budget 15000000 FCFA",
    );
    assert.equal(anonymiserBesoin("terrain 12500000"), "terrain 12500000");
    // les prix ne commencent jamais par 0 : un 0 initial reste un téléphone
    assert.equal(anonymiserBesoin("contact 0105896741"), "contact [téléphone]");
  });

  test("P1 — le modèle n'est pas absorbé par le numéro adjacent", () => {
    assert.equal(
      anonymiserBesoin("iphone 12 07 58 96 75 41"),
      "iphone 12 [téléphone]",
    );
    // la recherche ne part pas en « iphone 41 » : le modèle reste intact
    const n = parseNeed(anonymiserBesoin("iphone 12 07 58 96 75 41"));
    assert.equal(n.model, "iphone 12");
    assert.ok(n.product.includes("iphone 12"), n.product);
    assert.ok(!n.product.includes("41"), n.product);
  });

  test("les masques ne polluent pas la requête site (produit)", () => {
    const n = parseNeed(
      anonymiserBesoin("appelle le 07 58 96 75 41 pour un canapé à Cocody"),
    );
    assert.ok(!n.product.includes("téléphone"), n.product);
    assert.ok(!n.product.includes("[telephone]"), n.product);
  });

  test("les prix et mesures restent lisibles (groupes de 3)", () => {
    assert.equal(anonymiserBesoin("max 150 000 FCFA"), "max 150 000 FCFA");
    assert.equal(anonymiserBesoin("terrain 4,700,000 FCFA"), "terrain 4,700,000 FCFA");
    assert.equal(anonymiserBesoin("clim 12 000 BTU"), "clim 12 000 BTU");
    assert.equal(anonymiserBesoin("135 000 F"), "135 000 F");
    assert.equal(anonymiserBesoin("12 500 000 FCFA"), "12 500 000 FCFA");
  });
});

// ─── Cache : TTL par source, âge, lectures, jamais de blocage mémorisé ─────
describe("cache — TTL par source, lectures et écritures", () => {
  const tmp = mkdtempSync(join(tmpdir(), "noma-cache-"));
  const file = join(tmp, "cache.json");
  const base = (over: Partial<SourceResult>): SourceResult => ({
    source: "test",
    query: "q",
    capabilities: { search: true, location: false, pagination: false, itemCheck: false, services: false, unsupported: [] },
    warnings: [],
    listings: [],
    status: "ok",
    durationMs: 1,
    errors: [],
    ...over,
  });

  test("ttlForKey : source connue > source inconnue (défaut) > paramètre explicite", () => {
    assert.equal(ttlForKey("facebook:v3:u"), SOURCE_TTL_MS.facebook);
    assert.equal(ttlForKey("google:v3:u"), SOURCE_TTL_MS.google);
    assert.equal(ttlForKey("inconnue:v1:u"), 15 * 60 * 1000);
    assert.equal(ttlForKey("facebook:v3:u", 42_000), 42_000);
  });

  test("lecture réussie puis échec d'âge : expiré = miss, jamais réutilisé", async () => {
    __resetCache(file);
    let calls = 0;
    const fn = async () => { calls++; return "valeur"; };
    assert.equal(await cached("k1", fn, undefined, 20), "valeur");
    assert.equal(await cached("k1", fn, undefined, 20), "valeur");
    assert.equal(calls, 1, "le 2e appel doit venir du cache");
    assert.ok(cacheStats().hits === 1 && cacheStats().misses === 1 && cacheStats().writes === 1);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(await cached("k1", fn, undefined, 20), "valeur");
    assert.equal(calls, 2, "entrée expirée : la fonction est relancée");
  });

  test("un blocage n'est jamais mis en cache comme une recherche vide", async () => {
    __resetCache(file);
    let calls = 0;
    const blocked = () => base({ source: "a", status: "blocked", errors: ["mur anti-bot"] });
    const fn = async () => { calls++; return blocked(); };
    const r1 = await cached("k2", fn, (v) => v.status === "ok" || v.status === "empty");
    const r2 = await cached("k2", fn, (v) => v.status === "ok" || v.status === "empty");
    assert.equal(calls, 2, "le blocage ne doit pas être réutilisé");
    assert.equal(r1.status, "blocked");
    assert.equal(r2.status, "blocked");
    // 2 lectures en échec = 2 misses, 2 « skipped », 0 écriture
    assert.deepEqual(cacheStats(), { hits: 0, misses: 2, writes: 0, skipped: 2 });
  });
});

// ─── Charge : réessais bornés, espacés, annulables ─────────────────────────
describe("withRetry — espacement et bornes", () => {
  const logged: number[] = [];
  const noSleep = async (ms: number) => { logged.push(ms); };

  test("relance espacée après erreur, puis succès", async () => {
    logged.length = 0;
    let calls = 0;
    const out = await withRetry(
      async () => { calls++; if (calls < 2) throw new Error("réseau coupé"); return "ok"; },
      { attempts: 2, baseDelayMs: 100, sleep: noSleep },
    );
    assert.equal(out, "ok");
    assert.equal(calls, 2);
    assert.deepEqual(logged, [100]);
  });

  test("sans réessais infinis : au plus `attempts` appels, délai plafonné", async () => {
    logged.length = 0;
    let calls = 0;
    await assert.rejects(
      () =>
        withRetry(
          async () => { calls++; throw new Error("toujours ko"); },
          { attempts: 4, baseDelayMs: 100, maxDelayMs: 250, sleep: noSleep },
        ),
      /toujours ko/,
    );
    assert.equal(calls, 4, "borné : pas de boucle infinie");
    assert.deepEqual(logged, [100, 200, 250], "doublement plafonné");
  });

  test("erreur non transitoire : aucune relance (SSRF/blocage = définitif)", async () => {
    logged.length = 0;
    let calls = 0;
    await assert.rejects(
      () =>
        withRetry(
          async () => { calls++; throw new Error("blocked: refusé"); },
          { attempts: 3, baseDelayMs: 100, sleep: noSleep, shouldRetry: () => false },
        ),
      /blocked/,
    );
    assert.equal(calls, 1);
    assert.deepEqual(logged, [], "aucun délai : pas de relance");
  });

  test("annulation : arrêt entre les tentatives", async () => {
    logged.length = 0;
    let calls = 0;
    const controller = new AbortController();
    await assert.rejects(
      () =>
        withRetry(
          async () => {
            calls++;
            controller.abort();
            throw new Error("ko");
          },
          { attempts: 3, baseDelayMs: 100, sleep: noSleep, signal: controller.signal },
        ),
      /ko/,
    );
    assert.equal(calls, 1, "pas de relance après annulation");
    assert.deepEqual(logged, [], "aucun sommeil après annulation");
  });
});

// ─── Cache : méta de lecture (provenance, âge, réseau initial) + par source ─
describe("cache — méta de lecture et compteurs par source", () => {
  const tmp = mkdtempSync(join(tmpdir(), "noma-cache2-"));
  const file = join(tmp, "cache.json");

  test("fromCache / ageMs / netMs séparés ; avecCache marque le résultat", async () => {
    __resetCache(file);
    const meta1: CacheReadMeta = {};
    const meta2: CacheReadMeta = {};
    const fn = async () => {
      await new Promise((r) => setTimeout(r, 15)); // durée réseau simulée
      return { durationMs: 15000, warnings: [] as string[] };
    };
    await cached("facebook:v3:u", fn, undefined, undefined, meta1);
    assert.equal(meta1.fromCache, false);
    assert.ok((meta1.netMs ?? 0) >= 10, `netMs ${meta1.netMs}`);
    await new Promise((r) => setTimeout(r, 20));
    const hit = await cached("facebook:v3:u", fn, undefined, undefined, meta2);
    assert.equal(meta2.fromCache, true, "2e lecture = cache");
    assert.ok((meta2.ageMs ?? 0) >= 15, `ageMs ${meta2.ageMs}`);
    assert.equal(meta2.netMs, meta1.netMs, "durée réseau initiale préservée");
    const res = avecCache(hit, meta2, 12);
    assert.equal(res.durationMs, 12, "durée ACTUELLE, pas celle du réseau");
    assert.ok((res.networkMs ?? 0) >= 10);
    assert.ok(res.warnings.some((w) => w.includes("issu du cache")), res.warnings.join("|"));
    // compteur PAR SOURCE (pas seulement global)
    const bs = cacheStatsBySource();
    assert.deepEqual(bs["facebook"], { hits: 1, misses: 1, writes: 1, skipped: 0 });
  });
});

// ─── Refus d'accès ≠ erreurs transitoires : le 403 n'est jamais relancé ────
describe("classification HTTP — 403 bloqué, 503 transitoire", () => {
  const noSleep = async () => {};
  const fetchDeps = (status: number, calls: { n: number }) => ({
    deps: {
      resolve: async () => ["93.184.216.34"],
      load: async () => {
        calls.n++;
        return { status, headers: {}, body: "" };
      },
    },
    limits: { totalMs: 2000 },
  });

  test("403 → kind blocked, UNE seule requête (pas de relance)", async () => {
    const calls = { n: 0 };
    await assert.rejects(
      () =>
        withRetry(
          () =>
            safeFetch("https://exemple.ci/x", {
              deps: fetchDeps(403, calls).deps,
              limits: { totalMs: 2000 },
            }),
          {
            attempts: 3,
            baseDelayMs: 10,
            sleep: noSleep,
            shouldRetry: (e) => e instanceof SafeFetchError && e.kind === "network",
          },
        ),
      (e: SafeFetchError) => {
        assert.equal(e.kind, "blocked");
        assert.equal(e.status, 403);
        return true;
      },
    );
    assert.equal(calls.n, 1, "un refus d'accès ne doit pas être relancé");
  });

  test("503 → kind network, relancé une fois (2 appels)", async () => {
    const calls = { n: 0 };
    await assert.rejects(
      () =>
        withRetry(
          () => safeFetch("https://exemple.ci/x", {
            deps: fetchDeps(503, calls).deps,
            limits: { totalMs: 2000 },
          }),
          {
            attempts: 2,
            baseDelayMs: 10,
            sleep: noSleep,
            shouldRetry: (e) => e instanceof SafeFetchError && e.kind === "network",
          },
        ),
      (e: SafeFetchError) => {
        assert.equal(e.kind, "network");
        assert.equal(e.status, 503);
        return true;
      },
    );
    assert.equal(calls.n, 2, "erreur serveur transitoire : une relance");
  });
});

// ─── Bilan : provenance cache visible ──────────────────────────────────────
describe("bilanSources — cache distingué du réseau", () => {
  const base = (over: Partial<SourceResult>): SourceResult => ({
    source: "test",
    query: "q",
    capabilities: { search: true, location: false, pagination: false, itemCheck: false, services: false, unsupported: [] },
    warnings: [],
    listings: [],
    status: "ok",
    durationMs: 1,
    errors: [],
    ...over,
  });

  test("résultat en cache : lecture actuelle + réseau initial", () => {
    const [ligne] = bilanSources([
      base({ source: "facebook", status: "ok", listings: [annonce], durationMs: 120, fromCache: true, networkMs: 12340 }),
    ]);
    assert.ok(ligne.includes("cache"), ligne);
    assert.ok(ligne.includes("lecture 0.1 s"), ligne);
    assert.ok(ligne.includes("réseau initial 12.3 s"), ligne);
  });
});
describe("bilanSources — une ligne par source, avec motif", () => {
  const base = (over: Partial<SourceResult>): SourceResult => ({
    source: "test",
    query: "q",
    capabilities: { search: true, location: false, pagination: false, itemCheck: false, services: false, unsupported: [] },
    warnings: [],
    listings: [],
    status: "ok",
    durationMs: 1234,
    errors: [],
    ...over,
  });

  test("succès, vide, blocage, coupure et erreur sont lisibles et motivés", () => {
    const lignes = bilanSources([
      base({ source: "facebook", status: "ok", listings: [annonce], durationMs: 12340 }),
      base({ source: "coinafrique", status: "empty", durationMs: 900 }),
      base({ source: "locanto", status: "blocked", errors: ["mur anti-bot détecté"], durationMs: 4000 }),
      base({ source: "google", status: "timeout", errors: ["délai dépassé (60 000 ms) — coupure"], durationMs: 60000 }),
      base({ source: "autre", status: "error", errors: ["boom"], durationMs: 120 }),
    ]);
    assert.ok(lignes[0].startsWith("facebook : succès — 1 annonce · 12.3 s"), lignes[0]);
    assert.ok(lignes[1].includes("vide (source opérationnelle)"), lignes[1]);
    assert.ok(lignes[2].includes("bloquée") && lignes[2].includes("motif : mur anti-bot"), lignes[2]);
    assert.ok(lignes[3].includes("coupure") && lignes[3].includes("délai dépassé"), lignes[3]);
    assert.ok(lignes[4].includes("erreur") && lignes[4].includes("boom"), lignes[4]);
    // cohérence avec la synthèse
    const s = summarizeSources([
      base({ status: "ok", listings: [annonce] }),
      base({ status: "blocked" }),
    ]);
    assert.deepEqual(s, { ok: 1, empty: 0, indisponibles: 1, verdict: "résultats disponibles" });
  });
});
