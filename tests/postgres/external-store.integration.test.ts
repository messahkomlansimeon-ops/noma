import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";
import { archiveDemand, createOffer, createUser } from "../../lib/server/catalog";
import { analyzeContent } from "../../lib/server/external/analysis";
import { runCollectStep, type CollectStepOptions } from "../../lib/server/external/collect";
import { GONE_AFTER_MISSED_COLLECTS } from "../../lib/server/external/config";
import { connectorFor, registerSource, setSourceEnabled, SourceNotAllowedError } from "../../lib/server/external/registry";
import { pseudonymOf, sanitizeBatch } from "../../lib/server/external/sanitize";
import { AllListingsRejectedError, isListingDataError, storeSearchResult } from "../../lib/server/external/store";
import { listExternalMatchesForDemand } from "../../lib/server/external/matching";
import { readPseudonymKey } from "../../lib/server/external/secret";
import type { SanitizedBatch, SanitizedListing } from "../../lib/server/external/sanitize";
import type { ExternalListingDraft, SourceConnector } from "../../lib/server/external/types";
import { BoostError, grantOfferBoost } from "../../lib/server/boost/boosts";
import { looksLikePhoneNumber } from "../../lib/phone-text";
import {
  TEST_PSEUDONYM_KEY, count, countingAnalyzer, fixedClock, installNetworkGuard, makeDemand, recordingSleep, resetDemands, resetExternal, selfTestNetworkGuard, type NetworkGuard,
} from "./external-fixtures";
import { openTestSchema, type TestSchema } from "./social-fixtures";

/**
 * Stockage des annonces externes (lot EXT1) : identité (source + identifiant, URL canonique), déduplication dans une source et entre sources, disponibilité (« gone » après
 * 3 absences, jamais sur une panne), contenu analysé une seule fois, numéros de téléphone jamais conservés, aucune écriture dans le catalogue interne.
 */

const BASE = new Date("2026-10-07T10:00:00.000Z");
let env: TestSchema;
let guard: NetworkGuard;
const clock = fixedClock(BASE);
const timer = recordingSleep();

before(async () => {
  env = await openTestSchema(10);
  guard = installNetworkGuard();
  await selfTestNetworkGuard(guard);
});

after(async () => {
  guard?.restore();
  await env?.close();
});

beforeEach(async () => {
  await resetDemands(env.pool);
  await resetExternal(env.pool);
  clock.set(BASE);
  timer.waits.length = 0;
});

interface Scripted extends SourceConnector {
  items: unknown[];
  failure: unknown;
  calls: number;
}

/** Connecteur fictif dont la réponse est exactement celle de l'essai. */
function scripted(code: string, items: unknown[] = []): Scripted {
  const connector: Scripted = {
    code,
    kind: "fake",
    items,
    failure: null,
    calls: 0,
    async search() {
      connector.calls += 1;
      if (connector.failure !== null) throw connector.failure;
      return connector.items as ExternalListingDraft[];
    },
  };
  return connector;
}

const draft = (host: string, id: string, title: string, price: number | null, over: Partial<ExternalListingDraft> = {}): ExternalListingDraft => ({
  externalId: id,
  title,
  price,
  currency: "XOF",
  url: `https://${host}.example/annonce/${id}`,
  location: "Cocody",
  listedAt: new Date(BASE.getTime() - 3_600_000),
  availability: "available",
  ...over,
});

const run = async (connectors: SourceConnector[], extra: Partial<CollectStepOptions> = {}) => {
  await env.pool.query("UPDATE market_watches SET next_run_at = $1, daily_request_budget = 100", [new Date(clock.now().getTime() - 1_000)]);
  const result = await runCollectStep({ pool: env.pool, connectors, now: clock.now, sleep: timer.sleep, ...extra });
  assert.deepEqual(result.errors, []);
  clock.advance(60_000);
  return result;
};

const listing = async (id: string) => (await env.pool.query("SELECT * FROM external_listings WHERE external_id = $1", [id])).rows[0];
const observation = async (id: string) => (await env.pool.query("SELECT o.* FROM source_observations o JOIN external_listings l ON l.id = o.listing_id WHERE l.external_id = $1", [id])).rows[0];

async function setup(): Promise<void> {
  await makeDemand(env.pool);
  await runCollectStep({ pool: env.pool, connectors: null, now: clock.now });
}

// ───────────── identité et déduplication ─────────────

test("une annonce connue est mise à jour, jamais dupliquée : doublons de la réponse, même identifiant, même URL sous un autre identifiant", async () => {
  await setup();
  const a = scripted("demo_a", [
    draft("annonces-demo-a", "a-1", "iPhone 12 128 Go noir", 150_000),
    draft("annonces-demo-a", "a-1", "iPhone 12 128 Go noir (doublon de la réponse)", 150_000, { url: "https://annonces-demo-a.example/annonce/a-1-bis" }),
    draft("annonces-demo-a", "a-2", "iPhone 12 128 Go blanc", 145_000, { url: "https://annonces-demo-a.example/annonce/a-1" }),
    draft("annonces-demo-a", "a-3", "iPhone 12 64 Go", 120_000),
  ]);
  const first = await run([a]);
  assert.equal(first.duplicatesInResponse, 2, "même identifiant, puis même URL");
  assert.equal(first.created, 2);
  assert.equal(await count(env.pool, "external_listings"), 2);
  const row = await listing("a-1");
  const firstSeen = row.first_seen_at;
  const second = await run([a]);
  assert.equal(second.created, 0);
  assert.equal(second.unchanged, 2, "aucune renormalisation");
  assert.equal(await count(env.pool, "external_listings"), 2);
  const again = await listing("a-1");
  assert.deepEqual(again.first_seen_at, firstSeen, "première observation conservée");
  assert.ok(again.last_seen_at > firstSeen);
  // L'annonce change d'identifiant chez la source mais garde son URL : c'est la même annonce (URL canonique en secours).
  a.items = [draft("annonces-demo-a", "a-1-renumbered", "iPhone 12 128 Go noir", 150_000, { url: "https://annonces-demo-a.example/annonce/a-1" }), a.items[3]];
  await run([a]);
  assert.equal(await count(env.pool, "external_listings"), 2);
  assert.equal(await listing("a-1-renumbered"), undefined);
  assert.equal((await listing("a-1")).canonical_url, "https://annonces-demo-a.example/annonce/a-1");
});

test("la base garantit l'unicité : (source, identifiant externe) et (source, URL canonique) — la même adresse chez une AUTRE source est permise", async () => {
  await setup();
  await run([scripted("demo_a", [draft("annonces-demo-a", "u-1", "iPhone 12 noir", 150_000)])]);
  const existing = await listing("u-1");
  const insert = (source: string, externalId: string, url: string) =>
    env.pool.query(
      `INSERT INTO external_listings (source_code, external_id, canonical_url, title, availability_status, content_hash, first_seen_at, last_seen_at, last_checked_at)
       VALUES ($1, $2, $3, 'x', 'available', $4, now(), now(), now())`,
      [source, externalId, url, existing.content_hash],
    );
  await assert.rejects(() => insert("demo_a", "u-1", "https://autre.example/1"), (error: { code?: string; constraint?: string }) => error.code === "23505" && error.constraint === "uq_external_listings_source_external");
  await assert.rejects(() => insert("demo_a", "u-9", existing.canonical_url), (error: { code?: string; constraint?: string }) => error.code === "23505" && error.constraint === "uq_external_listings_canonical_url");
  await insert("demo_b", "u-1", "https://autre.example/2"); // même identifiant chez une AUTRE source : permis
  await insert("demo_b", "u-9", existing.canonical_url); // même adresse chez une AUTRE source : permis (deux lignes)
  assert.equal(await count(env.pool, "external_listings"), 3);
  assert.equal(await count(env.pool, "external_listings", `canonical_url = '${existing.canonical_url}'`), 2);
});

test("déduplication entre sources : même clé, prix à 2 % près, titre proche → un groupe ; les deux annonces et leurs observations sont conservées", async () => {
  await setup();
  const a = scripted("demo_a", [
    draft("annonces-demo-a", "g-a1", "iPhone 12 128 Go noir, bon état", 100_000),
    draft("annonces-demo-a", "g-a2", "iPhone 12 128 Go bleu", 90_000),
  ]);
  const b = scripted("demo_b", [
    draft("annonces-demo-b", "g-b1", "Iphone 12 128Go noir (très bon état)", 102_000, { currency: "FCFA" }),
    draft("annonces-demo-b", "g-b2", "iPhone 12 128 Go bleu", 92_000),
    draft("annonces-demo-b", "g-b3", "iPhone 12 256 Go blanc", 100_000),
  ]);
  const result = await run([a, b]);
  assert.equal(result.created, 5);
  assert.equal(result.grouped, 2);
  // g-a1 (100 000) et g-b1 (102 000, exactement 2 % du plus bas) : doublons. g-a2 (90 000) et g-b2 (92 000, 2,2 %) : non. g-b3 : un autre produit.
  const groups = await env.pool.query("SELECT array_agg(l.external_id ORDER BY l.external_id) AS members FROM duplicate_groups g JOIN external_listings l ON l.duplicate_group_id = g.id GROUP BY g.id");
  assert.deepEqual(groups.rows.map((row) => row.members), [["g-a1", "g-b1"]]);
  for (const id of ["g-a2", "g-b2", "g-b3"]) assert.equal((await listing(id)).duplicate_group_id, null, `${id} n'est dans aucun groupe`);
  assert.equal(await count(env.pool, "external_listings"), 5, "aucune annonce supprimée ni fusionnée");
  assert.equal(await count(env.pool, "source_observations"), 5, "les observations d'origine sont conservées");
  assert.equal((await listing("g-a1")).source_code, "demo_a");
  assert.equal((await listing("g-b1")).source_code, "demo_b");
  // Rejeu : le groupe est stable (pas de nouveau groupe, pas de doublon).
  await run([a, b]);
  assert.equal(await count(env.pool, "duplicate_groups"), 1);
});

test("un groupe de doublons posé n'est jamais défait par une collecte ; la lecture présente à part un membre qui n'est plus un doublon", async () => {
  const demand = await makeDemand(env.pool, { budget: 300_000 });
  await runCollectStep({ pool: env.pool, connectors: null, now: clock.now });
  const a = scripted("demo_a", [draft("annonces-demo-a", "g-a", "iPhone 12 128 Go noir", 150_000)]);
  const b = scripted("demo_b", [draft("annonces-demo-b", "g-b", "iPhone 12 128 Go noir", 151_000)]);
  await run([a, b]);
  const grouped = await env.pool.query("SELECT external_id, duplicate_group_id FROM external_listings ORDER BY external_id");
  assert.notEqual(grouped.rows[0].duplicate_group_id, null);
  assert.equal(grouped.rows[0].duplicate_group_id, grouped.rows[1].duplicate_group_id);
  const before = await listExternalMatchesForDemand({ pool: env.pool, ownerId: demand.ownerId, demandId: demand.id, now: clock.now() });
  assert.equal(before.items.length, 1, "présentés une seule fois");
  // La source B augmente son prix de 45 % : ce n'est plus le même prix.
  b.items = [draft("annonces-demo-b", "g-b", "iPhone 12 128 Go noir", 220_000)];
  await run([a, b]);
  const after = await env.pool.query("SELECT external_id, duplicate_group_id FROM external_listings ORDER BY external_id");
  assert.equal(after.rows[0].duplicate_group_id, grouped.rows[0].duplicate_group_id, "le groupe posé n'est jamais défait");
  assert.equal(after.rows[1].duplicate_group_id, grouped.rows[1].duplicate_group_id);
  assert.equal(await count(env.pool, "duplicate_groups"), 1);
  const apart = await listExternalMatchesForDemand({ pool: env.pool, ownerId: demand.ownerId, demandId: demand.id, now: clock.now() });
  assert.deepEqual(apart.items.map((item) => item.price?.amount).sort(), [150_000, 220_000], "la lecture revérifie : deux annonces, chacune sans « aussi trouvée sur »");
  assert.ok(apart.items.every((item) => item.alsoOn.length === 0));
});

test("deux annonces identiques d'une MÊME source ne sont jamais regroupées par ressemblance", async () => {
  await setup();
  const a = scripted("demo_a", [
    draft("annonces-demo-a", "t-1", "iPhone 12 128 Go noir", 100_000),
    draft("annonces-demo-a", "t-2", "iPhone 12 128 Go noir", 100_000),
  ]);
  await run([a]);
  assert.equal(await count(env.pool, "external_listings"), 2);
  assert.equal(await count(env.pool, "duplicate_groups"), 0);
});

test("regroupement : l'écart de prix est borné à 2 % du plus bas, et une troisième source relie deux groupes (union)", async () => {
  await setup();
  await registerSource(env.pool, { code: "demo_c", name: "Annonces Démo C", type: "fake", enabled: true, minIntervalMs: 0 });
  const a = scripted("demo_a", [draft("annonces-demo-a", "m-a", "iPhone 12 128 Go noir", 100_000)]);
  const b = scripted("demo_b", [draft("annonces-demo-b", "m-b", "iPhone 12 128 Go noir", 103_000)]);
  await run([a, b]);
  assert.equal(await count(env.pool, "duplicate_groups"), 0, "3 % d'écart : pas des doublons");
  // Au plus 2 % du plus bas des deux prix : 102 000 est le plafond de 100 000, 102 001 le dépasse.
  b.items = [draft("annonces-demo-b", "m-b", "iPhone 12 128 Go noir", 102_001)];
  await run([a, b]);
  assert.equal(await count(env.pool, "duplicate_groups"), 0);
  b.items = [draft("annonces-demo-b", "m-b", "iPhone 12 128 Go noir", 103_000)];
  await run([a, b]);
  const c = scripted("demo_c", [draft("annonces-demo-c", "m-c", "iPhone 12 128 Go noir", 101_500)]);
  await run([a, b, c]);
  const groups = await env.pool.query("SELECT duplicate_group_id, count(*)::int AS n FROM external_listings GROUP BY duplicate_group_id");
  assert.deepEqual(groups.rows.map((row) => row.n), [3], "m-c est à moins de 2 % de m-a ET de m-b : les trois sont reliés dans un seul groupe");
  assert.equal(await count(env.pool, "duplicate_groups"), 1);
});

// ───────────── disponibilité ─────────────

test("« gone » après 3 collectes réussies sans l'annonce ; elle revient « available » si elle réapparaît ; une panne n'est jamais une absence", async () => {
  await setup();
  const items = [draft("annonces-demo-a", "d-1", "iPhone 12 noir", 150_000), draft("annonces-demo-a", "d-2", "iPhone 12 blanc", 140_000), draft("annonces-demo-a", "d-3", "iPhone 12 bleu", 130_000)];
  const a = scripted("demo_a", items);
  await run([a]);
  assert.equal((await listing("d-3")).availability_status, "available");
  assert.equal((await listing("d-3")).availability_origin, "source");
  a.items = items.slice(0, 2);
  for (let miss = 1; miss <= GONE_AFTER_MISSED_COLLECTS; miss++) {
    const result = await run([a]);
    assert.equal((await observation("d-3")).missed_collects, miss);
    assert.equal((await listing("d-3")).availability_status, miss < GONE_AFTER_MISSED_COLLECTS ? "available" : "gone", `après ${miss} absence(s)`);
    assert.equal(result.goneByAbsence, miss === GONE_AFTER_MISSED_COLLECTS ? 1 : 0);
  }
  const gone = await listing("d-3");
  assert.equal(gone.availability_origin, "absence", "l'origine de la confirmation est conservée");
  assert.ok(gone.availability_confirmed_at);
  assert.equal((await listing("d-1")).availability_status, "available");
  // Une panne de la source n'est pas une absence : aucun compteur ne bouge.
  const before = (await observation("d-1")).missed_collects;
  a.failure = new Error("panne");
  for (let attempt = 0; attempt < 5; attempt++) await run([a]);
  assert.equal((await observation("d-1")).missed_collects, before);
  assert.equal((await listing("d-1")).availability_status, "available");
  // L'annonce réapparaît.
  a.failure = null;
  await env.pool.query("UPDATE external_sources SET consecutive_failures = 0, breaker_open_until = NULL");
  a.items = items;
  const back = await run([a]);
  assert.equal(back.revived, 1);
  assert.equal((await listing("d-3")).availability_status, "available");
  assert.equal((await observation("d-3")).missed_collects, 0);
});

test("disponibilité déclarée par la source : « unavailable » → gone aussitôt (origine source) ; « unknown » → jamais présentée comme disponible", async () => {
  await setup();
  const a = scripted("demo_a", [
    draft("annonces-demo-a", "s-1", "iPhone 12 noir", 150_000, { availability: "unavailable" }),
    draft("annonces-demo-a", "s-2", "iPhone 12 blanc", 140_000, { availability: "unknown" }),
    draft("annonces-demo-a", "s-3", "iPhone 12 bleu", 130_000),
  ]);
  const result = await run([a]);
  assert.equal(result.goneBySource, 1);
  const [one, two, three] = [await listing("s-1"), await listing("s-2"), await listing("s-3")];
  assert.equal(one.availability_status, "gone");
  assert.equal(one.availability_origin, "source");
  assert.equal(two.availability_status, "unknown");
  assert.equal(two.availability_confirmed_at, null);
  assert.equal(three.availability_status, "available");
});

test("une annonce vue par deux surveillances reste disponible tant qu'une surveillance ACTIVE la voit encore", async () => {
  await setup();
  const cocody = await makeDemand(env.pool, { location: "Cocody" });
  await runCollectStep({ pool: env.pool, connectors: null, now: clock.now });
  assert.equal(await count(env.pool, "market_watches"), 2);
  const a = scripted("demo_a", [draft("annonces-demo-a", "w-1", "iPhone 12 noir", 150_000)]);
  await run([a]); // les deux surveillances voient w-1
  assert.equal(await count(env.pool, "source_observations"), 2);
  const abidjan = (await env.pool.query("SELECT id FROM market_watches WHERE zone = 'abidjan'")).rows[0].id as string;
  const onlyAbidjan = async () => {
    await env.pool.query("UPDATE market_watches SET next_run_at = $1, daily_request_budget = 100 WHERE id = $2", [new Date(clock.now().getTime() - 1_000), abidjan]);
    const result = await runCollectStep({ pool: env.pool, connectors: [a], now: clock.now, sleep: timer.sleep, only: [abidjan] });
    clock.advance(60_000);
    return result;
  };
  // La surveillance « abidjan » ne voit plus l'annonce ; « cocody » (active, non relancée) la voit toujours : elle reste disponible.
  a.items = [];
  for (let attempt = 0; attempt < GONE_AFTER_MISSED_COLLECTS; attempt++) await onlyAbidjan();
  assert.equal((await env.pool.query("SELECT o.missed_collects FROM source_observations o JOIN market_watches w ON w.id = o.watch_id WHERE w.id = $1", [abidjan])).rows[0].missed_collects, GONE_AFTER_MISSED_COLLECTS);
  assert.equal((await listing("w-1")).availability_status, "available", "une autre surveillance active ne l'a pas vue absente");
  // « cocody » passe en pause (plus de besoin actif) : son observation ne compte plus, l'annonce est disparue.
  await archiveDemand(cocody.ownerId, cocody.id, cocody.contentVersion, env.pool);
  await runCollectStep({ pool: env.pool, connectors: null, now: clock.now });
  assert.equal((await env.pool.query("SELECT status FROM market_watches WHERE zone = 'cocody'")).rows[0].status, "paused");
  await onlyAbidjan();
  assert.equal((await listing("w-1")).availability_status, "gone");
});

// ───────────── contenu analysé une seule fois ─────────────

test("le même contenu n'est analysé qu'UNE fois : annonce inchangée non renormalisée, contenu identique de deux annonces, seuls les contenus modifiés sont réanalysés", async () => {
  await setup();
  const counter = countingAnalyzer();
  const same = { title: "iPhone 12 128 Go noir", price: 150_000 };
  const a = scripted("demo_a", [
    draft("annonces-demo-a", "c-1", same.title, same.price),
    draft("annonces-demo-a", "c-2", "iPhone 12 64 Go blanc", 120_000),
  ]);
  const b = scripted("demo_b", [draft("annonces-demo-b", "c-3", same.title, same.price)]); // CONTENU identique à c-1, chez une autre source
  const first = await run([a, b], { analyze: counter.analyze });
  assert.equal(first.created, 3);
  assert.equal(first.analyzed, 2, "3 annonces, 2 contenus distincts → 2 analyses");
  assert.equal(counter.calls.length, 2, "l'analyseur n'est appelé que 2 fois");
  assert.equal(first.analysisReused, 1);
  assert.equal(await count(env.pool, "external_analyses"), 2);
  assert.equal((await listing("c-1")).content_hash, (await listing("c-3")).content_hash);
  // Collecte suivante, rien n'a changé : aucune analyse.
  const second = await run([a, b], { analyze: counter.analyze });
  assert.equal(second.analyzed, 0);
  assert.equal(second.unchanged, 3);
  assert.equal(second.changed, 0);
  assert.equal(counter.calls.length, 2, "aucune renormalisation d'une annonce inchangée");
  // Un seul contenu change (le prix de c-2) ; un autre ne change que de casse (même empreinte).
  a.items = [draft("annonces-demo-a", "c-1", "IPHONE 12 128 GO NOIR", same.price), draft("annonces-demo-a", "c-2", "iPhone 12 64 Go blanc", 118_000)];
  const third = await run([a, b], { analyze: counter.analyze });
  assert.equal(third.analyzed, 1, "seul le contenu au prix modifié est analysé");
  assert.equal(third.changed, 1);
  assert.equal(counter.calls.length, 3);
  assert.equal((await listing("c-1")).title, "IPHONE 12 128 GO NOIR", "l'affichage suit la source, sans réanalyse");
  assert.equal(await count(env.pool, "external_analyses"), 3);
  assert.equal(counter.calls.length, await count(env.pool, "external_analyses"), "une analyse enregistrée par appel de l'analyseur");
});

test("deux exécuteurs qui rencontrent le même contenu neuf en même temps : une seule analyse", async () => {
  await setup();
  const watch = (await env.pool.query("SELECT id, product_key FROM market_watches")).rows[0];
  const counter = countingAnalyzer();
  const slow = (content: Parameters<typeof counter.analyze>[0]) => {
    const started = Date.now();
    while (Date.now() - started < 40) { /* analyse lente simulée */ }
    return counter.analyze(content);
  };
  const batch = sanitizeBatch([draft("annonces-demo-a", "r-1", "iPhone 12 noir", 150_000), draft("annonces-demo-a", "r-2", "iPhone 12 blanc", 140_000)], BASE);
  const other = env.extraPool(6);
  const [x, y] = await Promise.all([
    storeSearchResult(env.pool, { watch, sourceCode: "demo_a", batch, now: BASE, analyze: slow }),
    storeSearchResult(other, { watch, sourceCode: "demo_a", batch, now: BASE, analyze: slow }),
  ]);
  assert.equal(x.analyzed + y.analyzed, 2, "2 contenus distincts, 2 analyses au total");
  assert.equal(counter.calls.length, 2);
  assert.equal(await count(env.pool, "external_listings"), 2, "aucun doublon malgré la course");
  assert.equal(await count(env.pool, "source_observations"), 2);
});

// ───────────── confidentialité ─────────────

test("aucun numéro de téléphone n'est conservé : champ fautif retiré, URL fautive rejetée, identifiant pseudonymisé, rien en base", async () => {
  await setup();
  const phone = "07 08 09 10 11";
  const a = scripted("demo_a", [
    draft("annonces-demo-a", "p-1", `iPhone 12 noir, appelez le ${phone}`, 150_000),
    draft("annonces-demo-a", "p-2", "iPhone 12 blanc", 140_000, { location: "Cocody — 0102030405" }),
    draft("annonces-demo-a", "p-3", "iPhone 12 bleu", 130_000, { url: "https://annonces-demo-a.example/annonce/0708091011" }),
    draft("annonces-demo-a", "0708091011", "iPhone 12 vert", 120_000, { url: "https://annonces-demo-a.example/annonce/p-4" }),
    draft("annonces-demo-a", "p-5", "iPhone 12 rouge ٠٧ ٠٨ ٠٩ ١٠ ١١", 110_000, { url: "https://annonces-demo-a.example/annonce/p-5?tel=%2B2250708091011" }),
    draft("annonces-demo-a", "p-6", "iPhone 12 gris 128 Go, 2400×1080, 12 500 000 FCFA neuf", 100_000),
  ]);
  const result = await run([a], { pseudonymKey: TEST_PSEUDONYM_KEY });
  assert.equal(result.rejected, 2, "l'URL fautive (chiffres) et l'URL à numéro encodé sont rejetées");
  assert.equal(result.phoneRemoved, 3, "titre p-1, lieu p-2, identifiant de l'annonce n° 4");
  assert.equal((await listing("p-1")).title, null, "le champ fautif est retiré");
  assert.equal((await listing("p-2")).location_text, null);
  assert.equal(await listing("p-3"), undefined);
  assert.equal(await listing("p-5"), undefined);
  const pseudonym = (await env.pool.query("SELECT external_id FROM external_listings WHERE canonical_url LIKE '%p-4'")).rows[0].external_id as string;
  assert.match(pseudonym, /^h:[0-9a-f]{24}$/);
  assert.equal(pseudonym, pseudonymOf("0708091011", TEST_PSEUDONYM_KEY), "empreinte HMAC à clé serveur");
  assert.ok((await listing("p-6")).title.includes("12 500 000 FCFA"), "une quantité ou une dimension n'est pas un numéro");
  // Aucune colonne de TEXTE des tables de la collecte ne ressemble à un numéro, et le numéro n'y figure sous aucune forme (les dates et les nombres ne sont pas du texte).
  const textColumns = await env.pool.query<{ table_name: string; column_name: string }>(
    `SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND data_type = 'text'
        AND table_name IN ('external_listings', 'external_analyses', 'source_observations', 'external_collect_runs', 'duplicate_groups', 'market_watches', 'external_sources')`,
  );
  assert.ok(textColumns.rows.length >= 20);
  for (const { table_name: table, column_name: column } of textColumns.rows) {
    const values = await env.pool.query<{ value: string | null }>(`SELECT "${column}" AS value FROM ${table}`);
    for (const { value } of values.rows) {
      if (value === null) continue;
      assert.ok(!/0708091011|07 08 09 10 11|0102030405|\+2250708091011/.test(value), `${table}.${column} : numéro conservé`);
      assert.equal(looksLikePhoneNumber(value), false, `${table}.${column} : ${value}`);
    }
  }
  const tokens = await env.pool.query<{ token: string }>("SELECT jsonb_array_elements_text(analysis -> 'tokens') AS token FROM external_analyses");
  assert.ok(tokens.rows.length > 0);
  for (const { token } of tokens.rows) assert.equal(looksLikePhoneNumber(token), false, `mot analysé : ${token}`);
  assert.ok(!(await env.pool.query("SELECT 1 FROM external_analyses WHERE analysis::text ~ '(0708091011|0102030405)'")).rowCount);
});

test("réponse d'une source assainie : schémas dangereux rejetés, URL canonique, devise FCFA → XOF, prix négatif et date future écartés", async () => {
  await setup();
  const a = scripted("demo_a", [
    draft("annonces-demo-a", "z-1", "iPhone 12 noir", 150_000, { url: "javascript:alert(1)" }),
    draft("annonces-demo-a", "z-2", "iPhone 12 noir", 150_000, { url: "ftp://annonces-demo-a.example/z-2" }),
    draft("annonces-demo-a", "z-3", "iPhone 12 noir", 150_000, { url: "https://user:secret@annonces-demo-a.example/z-3" }),
    draft("annonces-demo-a", "z-4", "iPhone 12 noir", 150_000, { url: "http://www.annonces-demo-a.example/annonce/z-4?utm_source=x&id=7#frag" }),
    draft("annonces-demo-a", "z-5", "iPhone 12 blanc", -5, { currency: "FCFA", listedAt: new Date(BASE.getTime() + 10 * 86_400_000) }),
    draft("annonces-demo-a", "z-6", "iPhone 12 gris", 99_999.6, { currency: "FCFA" }),
    { externalId: "z-7", title: "sans url" },
    null,
  ]);
  const result = await run([a]);
  assert.equal(result.rejected, 5);
  assert.equal(await count(env.pool, "external_listings"), 3);
  const four = await listing("z-4");
  assert.equal(four.canonical_url, "https://annonces-demo-a.example/annonce/z-4?id=7", "https, sans www, sans suivi, sans ancre");
  const five = await listing("z-5");
  assert.equal(five.price_amount, null);
  assert.equal(five.price_currency, null);
  assert.equal(five.listed_at, null, "date dans le futur : écartée");
  const six = await listing("z-6");
  assert.equal(Number(six.price_amount), 100_000);
  assert.equal(six.price_currency, "XOF");
});

// ───────────── isolation du catalogue interne ─────────────

test("la collecte n'écrit ni annonce interne, ni événement, ni évaluation, ni boost, ni notification ; une annonce externe ne peut pas être boostée", async () => {
  await setup();
  const owner = await createUser({}, env.pool);
  await createOffer({ ownerId: owner.id, rawText: "iPhone 12 interne", category: "Téléphones", brand: "Apple", model: "iPhone 12", price: { amount: 150_000, currency: "XOF" }, location: "Cocody", status: "published" }, env.pool);
  const tables = ["offers", "matching_outbox_events", "matching_evaluations", "matching_jobs", "offer_boosts", "boost_exposures", "notifications", "notification_deliveries", "wallet_transactions", "favorites", "conversations", "orders"];
  const before = new Map<string, number>();
  for (const table of tables) before.set(table, await count(env.pool, table));
  const a = scripted("demo_a", [draft("annonces-demo-a", "i-1", "iPhone 12 noir", 150_000)]);
  const result = await run([a]);
  assert.equal(result.created, 1);
  for (const table of tables) assert.equal(await count(env.pool, table), before.get(table), `${table} inchangée par la collecte`);
  const externalId = (await listing("i-1")).id as string;
  await assert.rejects(() => grantOfferBoost({ pool: env.pool, offerId: externalId, ownerId: owner.id, durationCode: "7d", source: "admin_grant" }), BoostError);
  assert.equal(await count(env.pool, "offer_boosts"), before.get("offer_boosts"));
  assert.equal(await count(env.pool, "offers", `id = '${externalId}'`), 0, "l'annonce externe n'est pas une annonce interne");
});

// ───────────── registre : aucune source réelle ─────────────

test("aucune source réelle ne peut être enregistrée ni activée : garde applicative ET contrainte de la base", async () => {
  await assert.rejects(() => registerSource(env.pool, { code: "reelle", name: "Site réel", type: "licensed", enabled: true }), SourceNotAllowedError);
  await assert.rejects(() => registerSource(env.pool, { code: "reelle", name: "Site réel", type: "http", enabled: false }), SourceNotAllowedError);
  await assert.rejects(
    () => env.pool.query("INSERT INTO external_sources (code, name, type, enabled) VALUES ('reelle', 'Site réel', 'licensed', TRUE)"),
    (error: { code?: string; constraint?: string }) => error.code === "23514" && /external_sources_type_check/.test(String(error.constraint)),
  );
  await assert.rejects(() => env.pool.query("UPDATE external_sources SET type = 'http' WHERE code = 'demo_a'"), (error: { code?: string }) => error.code === "23514");
  assert.equal(await count(env.pool, "external_sources", "code = 'reelle'"), 0);
  assert.deepEqual((await env.pool.query("SELECT code, type FROM external_sources ORDER BY code")).rows.map((row) => `${row.code}:${row.type}`), ["demo_a:fake", "demo_b:fake"]);
  // Activer / désactiver une source fictive reste possible.
  assert.equal(await setSourceEnabled(env.pool, "demo_a", false), true);
  assert.equal((await env.pool.query("SELECT enabled FROM external_sources WHERE code = 'demo_a'")).rows[0].enabled, false);
  assert.equal(await setSourceEnabled(env.pool, "demo_a", true), true);
  assert.equal(await setSourceEnabled(env.pool, "inconnue", true), false);
  // Un connecteur n'est relié qu'à une source fictive de son propre code.
  const row = {
    code: "demo_a", name: "A", type: "licensed", enabled: true, daily_quota: 1, min_interval_ms: 0, consecutive_failures: 0, breaker_open_until: null, breaker_trial_until: null, last_request_at: null,
    last_success_at: null, last_failure_at: null, last_error_code: null,
  };
  const connectors = new Map<string, SourceConnector>([["demo_a", scripted("demo_a")]]);
  assert.equal(connectorFor(row, connectors), null, "type non autorisé : aucun connecteur");
  assert.notEqual(connectorFor({ ...row, type: "fake" }, connectors), null);
  assert.equal(connectorFor({ ...row, type: "fake", code: "demo_b" }, connectors), null);
});

test("une source désactivée n'est pas interrogée", async () => {
  await setup();
  await env.pool.query("UPDATE external_sources SET enabled = FALSE WHERE code = 'demo_a'");
  const a = scripted("demo_a", [draft("annonces-demo-a", "o-1", "iPhone 12", 1)]);
  const b = scripted("demo_b", [draft("annonces-demo-b", "o-2", "iPhone 12", 1)]);
  const result = await run([a, b]);
  assert.equal(a.calls, 0);
  assert.equal(b.calls, 1);
  assert.equal(result.inactiveSources, 1);
});

test("analyse déterministe : l'analyseur par défaut n'appelle rien d'externe", () => {
  const analysis = analyzeContent({ title: "iPhone 12 128 Go", priceAmount: 1, priceCurrency: "XOF", location: null });
  assert.deepEqual(analysis.tokens, ["iphone", "12", "128", "go"]);
});


// ───────────── EXT1-bis : dates absurdes, erreurs de donnée, verrous, adresses, horloges ─────────────

/** Une annonce déjà nettoyée (appel direct de `storeSearchResult`, sans passer par le nettoyage : défense en profondeur). */
const clean = (id: string, over: Partial<SanitizedListing> = {}): SanitizedListing => ({
  externalId: id, title: `iPhone 12 ${id}`, priceAmount: 100_000, priceCurrency: "XOF", url: `https://annonces-demo-a.example/annonce/${id}`, location: "Cocody", listedAt: null, availability: "available", ...over,
});
const batchOf = (listings: SanitizedListing[]): SanitizedBatch => ({ listings, rejected: 0, phoneRemoved: 0, duplicatesInResponse: 0, truncated: 0 });
const ABSURD_DATE = new Date("-005000-01-01T00:00:00Z");

const source = async (code: string) => (await env.pool.query("SELECT * FROM external_sources WHERE code = $1", [code])).rows[0];

test("date de publication absurde (audit EXT1) : le champ est écarté, l'annonce gardée, la collecte réussit et ne retombe pas en boucle ; les annonces saines du lot sont stockées", async () => {
  await setup();
  const a = scripted("demo_a", [
    draft("annonces-demo-a", "d-ok-1", "iPhone 12 noir", 150_000),
    draft("annonces-demo-a", "d-bad-1", "iPhone 12 ancien", 140_000, { listedAt: ABSURD_DATE }),
    draft("annonces-demo-a", "d-bad-2", "iPhone 12 lointain", 130_000, { listedAt: new Date("+275000-01-01T00:00:00Z") }),
    draft("annonces-demo-a", "d-bad-3", "iPhone 12 de 1969", 120_000, { listedAt: new Date("1969-07-20T00:00:00Z") }),
    draft("annonces-demo-a", "d-ok-2", "iPhone 12 blanc", 110_000),
  ]);
  for (let round = 1; round <= 3; round++) {
    const result = await run([a]); // `run` exige errors = []
    assert.equal(result.sourceFailures, 0, `collecte n°${round}`);
    assert.equal(result.watchesProcessed, 1);
    assert.equal(result.stored, 5);
  }
  assert.equal(await count(env.pool, "external_listings"), 5);
  for (const id of ["d-bad-1", "d-bad-2", "d-bad-3"]) assert.equal((await listing(id)).listed_at, null, `${id} : date écartée`);
  assert.ok((await listing("d-ok-1")).listed_at, "une date plausible est conservée");
  assert.equal((await source("demo_a")).consecutive_failures, 0);
  assert.equal(await count(env.pool, "external_collect_runs", "status = 'error'"), 0);
  assert.equal(await count(env.pool, "external_collect_runs", "status = 'ok' AND source_code = 'demo_a'"), 3, "le journal est écrit à chaque collecte");
});

test("une annonce que la base refuse (erreur de donnée) est rejetée SEULE : les saines du même lot sont stockées, elle n'est pas comptée absente ; si toutes sont refusées, rien n'est écrit", async () => {
  await setup();
  const watch = (await env.pool.query("SELECT id, product_key FROM market_watches")).rows[0];
  const store = (listings: SanitizedListing[]) => storeSearchResult(env.pool, { watch, sourceCode: "demo_a", batch: batchOf(listings), now: clock.now() });
  const first = await store([clean("k-1"), clean("k-2")]);
  assert.equal(first.created, 2);
  clock.advance(60_000);
  // k-1 arrive avec une date que PostgreSQL refuse (22008) : refusée seule ; z-bad (nouvelle) aussi ; k-2 et c-3 sont écrites.
  const second = await store([clean("k-1", { listedAt: ABSURD_DATE }), clean("k-2", { title: "iPhone 12 k-2 reconditionné" }), clean("z-bad", { listedAt: ABSURD_DATE }), clean("c-3")]);
  assert.equal(second.stored, 2);
  assert.equal(second.created, 1, "c-3");
  assert.equal(second.changed, 1, "k-2");
  assert.equal(second.rejected, 2, "k-1 et z-bad refusées par la base");
  assert.equal(await listing("z-bad"), undefined);
  assert.equal(await count(env.pool, "external_listings"), 3);
  assert.equal((await observation("k-1")).missed_collects, 0, "une annonce refusée par la base n'est pas une absence");
  assert.equal((await listing("k-1")).availability_status, "available");
  assert.equal((await observation("c-3")).missed_collects, 0);
  // Toutes refusées : AllListingsRejectedError, rien n'est écrit (ni annonce, ni observation, ni absence).
  const observationsBefore = await count(env.pool, "source_observations");
  const absencesBefore = (await env.pool.query("SELECT coalesce(sum(missed_collects), 0)::int AS n FROM source_observations")).rows[0].n;
  await assert.rejects(
    () => store([clean("y-1", { listedAt: ABSURD_DATE }), clean("y-2", { listedAt: ABSURD_DATE })]),
    (error: unknown) => error instanceof AllListingsRejectedError && isListingDataError(error),
  );
  assert.equal(await count(env.pool, "external_listings"), 3);
  assert.equal(await count(env.pool, "source_observations"), observationsBefore);
  assert.equal((await env.pool.query("SELECT coalesce(sum(missed_collects), 0)::int AS n FROM source_observations")).rows[0].n, absencesBefore, "aucune absence comptée");
  // Une réponse vide n'est pas « toutes refusées » : les absences comptent.
  const empty = await store([]);
  assert.equal(empty.stored, 0);
  assert.equal((await observation("k-1")).missed_collects, 1);
});

/** Déclencheur d'essai : une annonce dont le titre porte « poison-<SQLSTATE> » est refusée par la base avec ce code (simule une donnée que la base n'accepte pas). */
async function withPoisonTrigger(body: () => Promise<void>): Promise<void> {
  // Une séquence n'est pas transactionnelle : elle compte les refus même quand la transaction fautive est annulée (nombre de tentatives).
  await env.pool.query("CREATE SEQUENCE external_test_refusals");
  await env.pool.query(`CREATE FUNCTION external_test_poison() RETURNS trigger LANGUAGE plpgsql AS $fn$
    BEGIN
      IF NEW.title ~ 'poison-[0-9A-Z]{5}' THEN
        PERFORM nextval('external_test_refusals');
        RAISE EXCEPTION 'donnée refusée par la base' USING ERRCODE = substring(NEW.title from 'poison-([0-9A-Z]{5})');
      END IF;
      RETURN NEW;
    END $fn$`);
  await env.pool.query("CREATE TRIGGER external_test_poison BEFORE INSERT OR UPDATE ON external_listings FOR EACH ROW EXECUTE FUNCTION external_test_poison()");
  try {
    await body();
  } finally {
    await env.pool.query("DROP TRIGGER IF EXISTS external_test_poison ON external_listings");
    await env.pool.query("DROP FUNCTION IF EXISTS external_test_poison()");
    await env.pool.query("DROP SEQUENCE IF EXISTS external_test_refusals");
  }
}

const refusals = async (): Promise<number> => Number((await env.pool.query("SELECT last_value, is_called FROM external_test_refusals")).rows.map((row) => (row.is_called ? Number(row.last_value) : 0))[0]);

test("erreur de donnée de la base à l'écriture (22xxx, 23514, 23505) : une annonce refusée est rejetée seule ; si toutes le sont, ÉCHEC DE LA SOURCE `invalid_response` (journal écrit, disjoncteur nourri), jamais une erreur d'infrastructure", async () => {
  await setup();
  await withPoisonTrigger(async () => {
    const partial = scripted("demo_a", [
      draft("annonces-demo-a", "p-ok-1", "iPhone 12 noir", 150_000),
      draft("annonces-demo-a", "p-bad", "iPhone 12 poison-22023", 140_000),
      draft("annonces-demo-a", "p-ok-2", "iPhone 12 blanc", 130_000),
    ]);
    const result = await run([partial]);
    assert.equal(result.sourceFailures, 0, "une annonce refusée n'est pas un échec de la source");
    assert.equal(result.stored, 2);
    assert.equal(result.rejected, 1);
    assert.equal(await listing("p-bad"), undefined);
    assert.ok(await listing("p-ok-1"));
    assert.equal((await source("demo_a")).consecutive_failures, 0);

    for (const code of ["22023", "22003", "23514", "23505"]) {
      await env.pool.query("DELETE FROM external_listings WHERE source_code = 'demo_a'");
      await env.pool.query("UPDATE external_sources SET consecutive_failures = 0, breaker_open_until = NULL, last_error_code = NULL");
      const before = await count(env.pool, "external_collect_runs", "status = 'error'");
      const all = scripted("demo_a", [draft("annonces-demo-a", `all-${code}-1`, `iPhone 12 poison-${code}`, 150_000), draft("annonces-demo-a", `all-${code}-2`, `iPhone 12 poison-${code} bis`, 140_000)]);
      const failed = await run([all]);
      assert.equal(failed.sourceFailures, 1, code);
      assert.equal(failed.stored, 0);
      assert.equal(failed.watchesProcessed, 1, "la surveillance est close normalement");
      const row = await source("demo_a");
      assert.equal(row.consecutive_failures, 1, `${code} : le disjoncteur est nourri`);
      assert.equal(row.last_error_code, "invalid_response");
      assert.equal(await count(env.pool, "external_collect_runs", "status = 'error' AND error_code = 'invalid_response'"), before + 1, `${code} : journal écrit`);
      assert.equal(await count(env.pool, "external_listings", "source_code = 'demo_a'"), 0, "rien n'est écrit");
    }
    // Trois collectes de suite en échec : le disjoncteur s'ouvre (comme pour toute source en échec).
    await env.pool.query("UPDATE external_sources SET consecutive_failures = 0, breaker_open_until = NULL");
    let opened = 0;
    for (let round = 0; round < 3; round++) opened += (await run([scripted("demo_a", [draft("annonces-demo-a", `loop-${round}`, "iPhone 12 poison-23514", 150_000)])])).breakerOpened;
    assert.equal(opened, 1);
    assert.notEqual((await source("demo_a")).breaker_open_until, null);
  });
});

test("interblocage persistant à l'écriture (40P01) : retenté une fois puis ÉCHEC DE LA SOURCE `store_conflict` ; une autre erreur de la base reste une erreur d'infrastructure", async () => {
  await setup();
  await withPoisonTrigger(async () => {
    const dead = scripted("demo_a", [draft("annonces-demo-a", "dl-1", "iPhone 12 poison-40P01", 150_000)]);
    const started = Date.now();
    const result = await run([dead]);
    assert.equal(await refusals(), 2, "l'écriture a été tentée deux fois : l'essai initial et UNE reprise");
    assert.equal(result.sourceFailures, 1);
    assert.deepEqual(result.errors, []);
    assert.equal((await source("demo_a")).last_error_code, "store_conflict");
    assert.equal(await count(env.pool, "external_collect_runs", "status = 'error' AND error_code = 'store_conflict'"), 1);
    assert.equal((await source("demo_a")).consecutive_failures, 1);
    assert.equal(result.storeRetries, 1, "une seule reprise");
    assert.ok(Date.now() - started < 5_000);

    // Une panne d'infrastructure (ici 53200, mémoire insuffisante) n'est PAS classée en échec de source.
    const broken = scripted("demo_a", [draft("annonces-demo-a", "infra-1", "iPhone 12 poison-53200", 150_000)]);
    await env.pool.query("UPDATE market_watches SET next_run_at = $1, daily_request_budget = 100", [new Date(clock.now().getTime() - 1_000)]);
    const raw = await runCollectStep({ pool: env.pool, connectors: [broken], now: clock.now, sleep: timer.sleep });
    assert.deepEqual(raw.errors, ["53200"]);
    assert.equal(raw.sourceFailures, 0);
  });
});

test("deux surveillances qui partagent des annonces, collectées en même temps : aucun interblocage (toutes les annonces concernées sont verrouillées d'emblée, dans l'ordre des identifiants)", async () => {
  await makeDemand(env.pool, { location: "Abidjan" });
  await makeDemand(env.pool, { location: "Cocody" });
  await env.pool.query("UPDATE external_sources SET enabled = FALSE WHERE code = 'demo_b'");
  await runCollectStep({ pool: env.pool, connectors: null, now: clock.now });
  const other = env.extraPool(6);
  const L1 = draft("annonces-demo-a", "shared-1", "iPhone 12 noir", 150_000);
  const L2 = draft("annonces-demo-a", "shared-2", "iPhone 12 blanc", 140_000);
  let round = 1;
  const a: SourceConnector = { code: "demo_a", kind: "fake", search: async (key) => (round === 1 ? [L1, L2] : key.zone === "abidjan" ? [L1] : [L2]) as ExternalListingDraft[] };
  const first = await run([a]);
  assert.equal(first.watchesProcessed, 2);
  const ids = Object.fromEntries((await env.pool.query("SELECT zone, id FROM market_watches")).rows.map((row) => [row.zone, row.id as string]));
  const lid = Object.fromEntries((await env.pool.query("SELECT external_id, id FROM external_listings")).rows.map((row) => [row.external_id, row.id as string]));
  assert.equal(await count(env.pool, "source_observations"), 4);

  // Chaque surveillance ne voit plus qu'UNE des deux annonces : elle met à jour l'une (vue) et compte l'autre absente (NON vue). Avant la correction, les annonces vues puis les
  // absentes étaient verrouillées dans deux ordres croisés : 40P01. Un tiers retient deux observations pour aligner les deux transactions.
  round = 2;
  clock.advance(6 * 3_600_000 + 1_000);
  await env.pool.query("UPDATE market_watches SET daily_request_budget = 100");
  const holder = await env.pool.connect();
  try {
    await holder.query("BEGIN");
    const holderPid = (await holder.query("SELECT pg_backend_pid() AS pid")).rows[0].pid as number;
    await holder.query("SELECT 1 FROM source_observations WHERE (watch_id, listing_id) IN (($1::uuid, $2::uuid), ($3::uuid, $4::uuid)) FOR UPDATE", [ids.abidjan, lid["shared-2"], ids.cocody, lid["shared-1"]]);
    const x = runCollectStep({ pool: env.pool, connectors: [a], now: clock.now, sleep: timer.sleep, only: [ids.abidjan] });
    const y = runCollectStep({ pool: other, connectors: [a], now: clock.now, sleep: timer.sleep, only: [ids.cocody] });
    let blocked = 0;
    for (let attempt = 0; attempt < 100 && blocked < 1; attempt++) {
      blocked = (await env.admin.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))", [holderPid])).rows[0].n;
      if (blocked < 1) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(blocked >= 1, "au moins une transaction attend la barrière");
    await new Promise((resolve) => setTimeout(resolve, 400)); // l'autre atteint son attente
    await holder.query("ROLLBACK");
    const [rx, ry] = await Promise.all([x, y]);
    assert.deepEqual([...rx.errors, ...ry.errors], [], "aucun interblocage (40p01)");
    assert.equal(rx.watchesProcessed, 1);
    assert.equal(ry.watchesProcessed, 1);
    assert.equal(rx.sourceFailures + ry.sourceFailures, 0);
    // Aucun interblocage n'a même eu lieu (sans verrouillage d'emblée, l'un des deux serait la victime de la base puis retenté avec succès : `storeRetries` le révèle).
    assert.equal(rx.storeRetries + ry.storeRetries, 0, "aucune écriture reprise après un interblocage");
    assert.equal((await env.pool.query("SELECT sum(missed_collects)::int AS n FROM source_observations")).rows[0].n, 2, "chaque surveillance a compté UNE absence");
  } finally {
    await holder.query("ROLLBACK").catch(() => undefined);
    holder.release();
  }
});

test("la même adresse chez deux sources = DEUX lignes (aucune ne réécrit l'autre), regroupées comme doublons ; l'indisponibilité de l'une ne fait pas disparaître l'autre", async () => {
  await setup();
  const demand = await makeDemand(env.pool, { budget: 300_000 });
  const shared = "https://agregateur.example/annonce/42";
  let bAvailability: "available" | "unavailable" = "available";
  const a = scripted("demo_a", [draft("annonces-demo-a", "a-42", "iPhone 12 noir", 150_000, { url: shared })]);
  const b = scripted("demo_b", []);
  b.search = async () => {
    b.calls += 1;
    return [draft("annonces-demo-b", "b-777", "iPhone 12 noir garantie", 95_000, { url: `${shared}?utm_source=b`, availability: bAvailability })];
  };
  await run([a]); // la source A d'abord, SEULE : sa ligne existe (validée) quand la source B arrive avec la même adresse
  await run([a, b]);
  const rows = (await env.pool.query("SELECT source_code, external_id, canonical_url, title, price_amount::int AS price, availability_status, duplicate_group_id FROM external_listings ORDER BY source_code")).rows;
  assert.equal(rows.length, 2, "deux lignes, une par source");
  assert.deepEqual(rows.map((row) => `${row.source_code}:${row.external_id}`), ["demo_a:a-42", "demo_b:b-777"]);
  assert.equal(rows[0].canonical_url, shared);
  assert.equal(rows[1].canonical_url, shared, "la même adresse canonique, sous deux sources");
  assert.equal(rows[0].title, "iPhone 12 noir", "la ligne de la source A n'est pas réécrite par la source B");
  assert.equal(rows[0].price, 150_000);
  assert.notEqual(rows[0].duplicate_group_id, null, "regroupées comme doublons (même adresse), malgré un prix et un titre différents");
  assert.equal(rows[0].duplicate_group_id, rows[1].duplicate_group_id);
  assert.equal(await count(env.pool, "duplicate_groups"), 1);
  // L'acheteur voit UNE annonce (la moins chère), avec l'autre source.
  const seen = await listExternalMatchesForDemand({ pool: env.pool, ownerId: demand.ownerId, demandId: demand.id, now: clock.now() });
  assert.equal(seen.items.length, 1);
  assert.deepEqual(seen.items[0].alsoOn.map((ref) => ref.code), seen.items[0].source.code === "demo_b" ? ["demo_a"] : ["demo_b"]);
  // B déclare SON annonce indisponible : la ligne de A reste disponible.
  bAvailability = "unavailable";
  await run([a, b]);
  const after = (await env.pool.query("SELECT source_code, availability_status FROM external_listings ORDER BY source_code")).rows;
  assert.deepEqual(after.map((row) => `${row.source_code}:${row.availability_status}`), ["demo_a:available", "demo_b:gone"]);
  const still = await listExternalMatchesForDemand({ pool: env.pool, ownerId: demand.ownerId, demandId: demand.id, now: clock.now() });
  assert.deepEqual(still.items.map((item) => item.source.code), ["demo_a"]);
});

test("l'adresse d'une annonce suit sa source ; deux transactions qui prennent la même adresse en même temps : la base en refuse une (23505), l'adresse précédente est conservée sans perdre l'annonce", async () => {
  await setup();
  const watch = (await env.pool.query("SELECT id, product_key FROM market_watches")).rows[0];
  const store = (listings: SanitizedListing[]) => storeSearchResult(env.pool, { watch, sourceCode: "demo_a", batch: batchOf(listings), now: clock.now() });
  await store([clean("m-1")]);
  clock.advance(60_000);
  // La page change d'adresse (aucune autre annonce ne la porte) : suivie.
  await store([clean("m-1", { url: "https://annonces-demo-a.example/annonce/m-1-nouvelle-adresse" })]);
  assert.equal((await listing("m-1")).canonical_url, "https://annonces-demo-a.example/annonce/m-1-nouvelle-adresse");
  // Course : une autre transaction (non validée) a déjà pris l'adresse visée par m-1.
  const target = "https://annonces-demo-a.example/annonce/convoitee";
  const holder = await env.pool.connect();
  try {
    await holder.query("BEGIN");
    await holder.query(
      `INSERT INTO external_listings (source_code, external_id, canonical_url, title, availability_status, content_hash, first_seen_at, last_seen_at, last_checked_at)
       VALUES ('demo_a', 'rival', $1, 'iPhone 12 rival', 'available', (SELECT content_hash FROM external_listings WHERE external_id = 'm-1'), now(), now(), now())`,
      [target],
    );
    clock.advance(60_000);
    const racing = store([clean("m-1", { url: target, title: "iPhone 12 m-1 prix baissé" })]);
    const holderPid = (await holder.query("SELECT pg_backend_pid() AS pid")).rows[0].pid as number;
    let blocked = 0;
    for (let attempt = 0; attempt < 100 && blocked < 1; attempt++) {
      blocked = (await env.admin.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))", [holderPid])).rows[0].n;
      if (blocked < 1) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(blocked >= 1, "la mise à jour de l'adresse attend la transaction concurrente");
    await holder.query("COMMIT");
    const outcome = await racing;
    assert.equal(outcome.stored, 1, "l'annonce est écrite malgré le conflit d'adresse");
    assert.equal(outcome.rejected, 0);
  } finally {
    await holder.query("ROLLBACK").catch(() => undefined);
    holder.release();
  }
  const kept = await listing("m-1");
  assert.equal(kept.canonical_url, "https://annonces-demo-a.example/annonce/m-1-nouvelle-adresse", "l'adresse précédente est conservée");
  assert.equal(kept.title, "iPhone 12 m-1 prix baissé", "le reste de la mise à jour est appliqué");
  assert.equal((await listing("rival")).canonical_url, target);
});

test("écart d'horloge entre deux exécuteurs (2 s) : `first_seen_at` ne fait que reculer, `last_seen_at` que avancer — aucune violation de la contrainte, aucune collecte perdue", async () => {
  await makeDemand(env.pool, { location: "Abidjan" });
  await makeDemand(env.pool, { location: "Cocody" });
  await env.pool.query("UPDATE external_sources SET enabled = FALSE WHERE code = 'demo_b'");
  await runCollectStep({ pool: env.pool, connectors: null, now: clock.now });
  const ids = Object.fromEntries((await env.pool.query("SELECT zone, id FROM market_watches")).rows.map((row) => [row.zone, row.id as string]));
  const shared = draft("annonces-demo-a", "shared-1", "iPhone 12 noir", 150_000);
  const a = scripted("demo_a", [shared, draft("annonces-demo-a", "other-1", "iPhone 12 blanc", 140_000)]);
  await env.pool.query("UPDATE market_watches SET daily_request_budget = 100");
  const ahead = fixedClock(new Date(BASE.getTime() + 2_000));
  const behind = fixedClock(BASE);
  const r1 = await runCollectStep({ pool: env.pool, connectors: [a], now: ahead.now, sleep: timer.sleep, only: [ids.abidjan] });
  const r2 = await runCollectStep({ pool: env.pool, connectors: [a], now: behind.now, sleep: timer.sleep, only: [ids.cocody] });
  assert.deepEqual([...r1.errors, ...r2.errors], [], "aucune erreur 23514");
  assert.equal(r2.sourceFailures, 0);
  assert.equal(r2.stored, 2);
  const row = await listing("shared-1");
  assert.equal(new Date(row.first_seen_at).getTime(), BASE.getTime(), "première observation : la plus ancienne des deux horloges");
  assert.equal(new Date(row.last_seen_at).getTime(), BASE.getTime() + 2_000, "dernière observation : la plus récente");
  assert.ok(new Date(row.last_seen_at).getTime() >= new Date(row.first_seen_at).getTime());
  assert.ok(new Date(row.last_checked_at).getTime() >= BASE.getTime() + 2_000);
  assert.equal(await count(env.pool, "source_observations"), 4, "les deux surveillances ont leurs observations");
  const obs = (await env.pool.query("SELECT o.first_seen_at, o.last_seen_at FROM source_observations o JOIN external_listings l ON l.id = o.listing_id WHERE l.external_id = 'shared-1' AND o.watch_id = $1", [ids.cocody])).rows[0];
  assert.equal(new Date(obs.last_seen_at).getTime(), BASE.getTime());
});

test("« gone » puis revue SANS disponibilité (unknown) : l'origine et la date de la confirmation sont remises à zéro ; available → unknown conserve la dernière confirmation", async () => {
  await setup();
  const a = scripted("demo_a", [draft("annonces-demo-a", "r-1", "iPhone 12 noir", 150_000), draft("annonces-demo-a", "r-2", "iPhone 12 blanc", 140_000)]);
  await run([a]);
  assert.equal((await listing("r-1")).availability_origin, "source");
  // r-1 : la source la déclare indisponible → gone (origine source) ; r-2 : disparue de la réponse trois fois → gone (origine absence).
  a.items = [draft("annonces-demo-a", "r-1", "iPhone 12 noir", 150_000, { availability: "unavailable" })];
  for (let miss = 0; miss < GONE_AFTER_MISSED_COLLECTS; miss++) await run([a]);
  const goneBySource = await listing("r-1");
  const goneByAbsence = await listing("r-2");
  assert.deepEqual([goneBySource.availability_status, goneBySource.availability_origin], ["gone", "source"]);
  assert.deepEqual([goneByAbsence.availability_status, goneByAbsence.availability_origin], ["gone", "absence"]);
  assert.ok(goneBySource.availability_confirmed_at && goneByAbsence.availability_confirmed_at);
  // Les deux reviennent SANS préciser leur disponibilité.
  a.items = [draft("annonces-demo-a", "r-1", "iPhone 12 noir", 150_000, { availability: "unknown" }), draft("annonces-demo-a", "r-2", "iPhone 12 blanc", 140_000, { availability: "unknown" })];
  await run([a]);
  for (const id of ["r-1", "r-2"]) {
    const row = await listing(id);
    assert.equal(row.availability_status, "unknown", id);
    assert.equal(row.availability_origin, null, `${id} : origine remise à zéro`);
    assert.equal(row.availability_confirmed_at, null, `${id} : date de confirmation remise à zéro`);
    assert.equal((await observation(id)).missed_collects, 0);
  }
  // Une annonce disponible (confirmée) qui devient « unknown » garde sa dernière confirmation (elle a bien été confirmée disponible à cette date).
  a.items = [draft("annonces-demo-a", "r-3", "iPhone 12 vert", 130_000)];
  await run([a]);
  const confirmedAt = (await listing("r-3")).availability_confirmed_at;
  assert.ok(confirmedAt);
  a.items = [draft("annonces-demo-a", "r-3", "iPhone 12 vert", 130_000, { availability: "unknown" })];
  await run([a]);
  const unknownNow = await listing("r-3");
  assert.equal(unknownNow.availability_status, "unknown");
  assert.deepEqual(unknownNow.availability_confirmed_at, confirmedAt);
  assert.equal(unknownNow.availability_origin, "source");
  // Revue disponible après un « unknown » : confirmation neuve, origine « source ».
  a.items = [draft("annonces-demo-a", "r-1", "iPhone 12 noir", 150_000)];
  const revived = await run([a]);
  assert.equal(revived.revived, 0, "r-1 était « unknown », pas « gone »");
  assert.equal((await listing("r-1")).availability_status, "available");
  assert.equal((await listing("r-1")).availability_origin, "source");
});

test("identifiant externe qui ressemble à un numéro : empreinte HMAC avec la clé du serveur (dérivée de NOMA_AUTH_SECRET par défaut) ; sans clé, l'annonce est rejetée", async () => {
  await setup();
  const items = [draft("annonces-demo-a", "0708091011", "iPhone 12 vert", 120_000, { url: "https://annonces-demo-a.example/annonce/v-1" }), draft("annonces-demo-a", "ok-1", "iPhone 12 noir", 150_000)];
  const a = scripted("demo_a", items);
  const without = await run([a], { pseudonymKey: null });
  assert.equal(without.rejected, 1);
  assert.equal(without.stored, 1);
  assert.equal(await count(env.pool, "external_listings", "canonical_url LIKE '%v-1'"), 0, "rejetée : aucun identifiant fabriqué sans clé");
  // Clé par défaut : dérivée de NOMA_AUTH_SECRET.
  const previous = process.env.NOMA_AUTH_SECRET;
  process.env.NOMA_AUTH_SECRET = randomBytes(32).toString("base64");
  try {
    const derived = readPseudonymKey(process.env);
    assert.ok(derived);
    const withDefault = await run([a]);
    assert.equal(withDefault.rejected, 0);
    const stored = (await env.pool.query("SELECT external_id FROM external_listings WHERE canonical_url LIKE '%v-1'")).rows[0].external_id as string;
    assert.equal(stored, pseudonymOf("0708091011", derived as Buffer));
  } finally {
    if (previous === undefined) delete process.env.NOMA_AUTH_SECRET;
    else process.env.NOMA_AUTH_SECRET = previous;
  }
});

test("une réponse énorme est tronquée AVANT nettoyage : seules les 200 premières entrées sont lues, le reste n'est pas nettoyé", async () => {
  await setup();
  let touched = 0;
  const hostile = new Proxy({}, { get() { touched += 1; throw new Error("lue"); }, has() { touched += 1; return false; }, ownKeys() { touched += 1; return []; } });
  const items: unknown[] = Array.from({ length: 200 }, (_, index) => draft("annonces-demo-a", `bulk-${index}`, `iPhone 12 lot ${index}`, 100_000 + index));
  for (let index = 0; index < 3_000; index++) items.push(hostile);
  const a = scripted("demo_a", items);
  const result = await run([a]);
  assert.equal(touched, 0, "aucune entrée au-delà de la 200e n'a été lue");
  assert.equal(result.stored, 50);
  assert.equal(result.truncated, 3_000 + 150);
  assert.equal(result.sourceFailures, 0);
});

test("aucun appel réseau sortant pendant toute la suite", () => {
  assert.deepEqual(guard.attempts, []);
});
