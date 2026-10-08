import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { grantAdmin } from "../../lib/server/admin/grant";
import { archiveDemand, createOffer, createUser, satisfyDemand } from "../../lib/server/catalog";
import { runCollectStep } from "../../lib/server/external/collect";
import { createExternalHttpHandlers, type ExternalHttpHandlers } from "../../lib/server/external/http";
import { listExternalMatchesForDemand } from "../../lib/server/external/matching";
import { createMatchingHttpHandlers, type MatchingHttpHandlers } from "../../lib/server/matching/http";
import { runMatchingCycle } from "../../lib/server/matching/runner";
import { looksLikePhoneNumber } from "../../lib/phone-text";
import {
  count, createFakeConnectors, fixedClock, installNetworkGuard, makeDemand, recordingSleep, resetDemands, resetExternal, selfTestNetworkGuard, type FakeConnector, type NetworkGuard,
} from "./external-fixtures";
import { NOT_FOUND, login, openTestSchema, reply, request, type Login, type TestSchema } from "./social-fixtures";

/**
 * Mise en relation et écrans serveur (lot EXT1) : les annonces d'autres sites passent par les MÊMES filtres de compatibilité, restent SÉPARÉES du classement interne, ne sont ni
 * boostées ni notifiées ; accès : session, propriétaire du besoin, administrateur (404 indiscernable pour les autres).
 */

const BASE = new Date();
let env: TestSchema;
let guard: NetworkGuard;
let external: ExternalHttpHandlers;
let matching: MatchingHttpHandlers;
let fakes: FakeConnector[];
let buyer: Login;
const clock = fixedClock(BASE);
const timer = recordingSleep();

before(async () => {
  env = await openTestSchema(10);
  guard = installNetworkGuard();
  await selfTestNetworkGuard(guard);
  const common = { pool: env.pool, env: { NOMA_AUTH_ORIGIN: "https://noma.test" }, log: () => {} };
  external = createExternalHttpHandlers({ ...common, now: clock.now });
  matching = createMatchingHttpHandlers({ pool: env.pool });
  buyer = await login(env.pool);
});

after(async () => {
  guard?.restore();
  await env?.close();
});

beforeEach(async () => {
  await resetDemands(env.pool);
  await resetExternal(env.pool);
  fakes = createFakeConnectors();
  clock.set(new Date());
  timer.waits.length = 0;
});

type Json = Record<string, unknown>;
interface Item { id: string; title: string; seenAt: string; price: { amount: number; currency: string } | null; location: string | null; source: { code: string; name: string }; alsoOn: Array<{ code: string; name: string }>; url: string; score: number }

const collect = async (connectors = fakes) => {
  await env.pool.query("UPDATE market_watches SET next_run_at = $1, daily_request_budget = 100", [new Date(clock.now().getTime() - 1_000)]);
  const result = await runCollectStep({ pool: env.pool, connectors, now: clock.now, sleep: timer.sleep });
  assert.deepEqual(result.errors, []);
  return result;
};
const list = (demandId: string, cookie: string | null = buyer.cookie, query = "") =>
  external.demandListings(request("GET", `/api/demands/${demandId}/external-listings`, { cookie, query }), demandId).then(reply);
const items = (answer: { json: unknown }): Item[] => (answer.json as { items: Item[] }).items;
const titles = (answer: { json: unknown }): string[] => items(answer).map((item) => item.title);

// ───────────── mêmes filtres ─────────────

test("mêmes filtres que le matching interne : budget, lieu, modèle (extensions), accessoires, lieu absent ou numéro dans le titre écartés ; tri par prix", async () => {
  const demand = await makeDemand(env.pool, { ownerId: buyer.userId, budget: 200_000 });
  await collect();
  const answer = await list(demand.id);
  assert.equal(answer.status, 200);
  const body = answer.json as Json;
  assert.equal(body.contractVersion, "external-listings/v1");
  assert.deepEqual(titles(answer), ["iPhone 12 blanc, utilisé avec soin", "iPhone 12 gris, garantie 1 mois", "iPhone 12 noir, bon état", "iPhone 12 très propre"], "du moins cher au plus cher");
  assert.ok(items(answer).every((item) => item.price !== null && item.price.amount <= 200_000 && item.price.currency === "XOF"), "le budget est appliqué");
  assert.ok(items(answer).every((item) => item.score === 100));
  const all = JSON.stringify(body);
  for (const excluded of ["sous blister", "Coque", "Pro Max", "vert, très bon état", "appelez"]) assert.ok(!all.includes(excluded), `« ${excluded} » est écartée`);
  // Le doublon (même annonce chez la source B, +1 %) n'est présenté qu'une fois : la moins chère, avec l'autre source.
  const noir = items(answer).find((item) => item.title === "iPhone 12 noir, bon état") as Item;
  assert.equal(noir.source.code, "demo_a");
  assert.deepEqual(noir.alsoOn, [{ code: "demo_b", name: "Annonces Démo B" }]);
  assert.equal(items(answer).filter((item) => item.title.includes("noir")).length, 1);

  // Budget relevé : l'annonce « sous blister » (285 000) devient compatible → le filtre de budget est réel.
  await env.pool.query("UPDATE demands SET budget_amount = 400000, content_version = content_version + 1 WHERE id = $1", [demand.id]);
  const richer = await list(demand.id);
  assert.ok(titles(richer).includes("iPhone 12 sous blister, jamais ouvert"));
  // Sans budget : plus de filtre de prix, mais jamais l'annonce sans lieu, l'accessoire ni l'autre modèle.
  await env.pool.query("UPDATE demands SET budget_amount = NULL, budget_currency = NULL WHERE id = $1", [demand.id]);
  const open = await list(demand.id);
  assert.equal(items(open).length, 5);
  assert.ok(!JSON.stringify(open.json).includes("vert, très bon état"), "annonce sans lieu : lieu inconnu, jamais confirmé");
});

test("lieu, marque et modèle : mauvaise ville, autre modèle ou autre marque ne sont jamais présentés", async () => {
  const demand = await makeDemand(env.pool, { ownerId: buyer.userId, budget: 500_000 });
  const [a, b] = fakes;
  const wrong = (id: string, title: string, location: string | null) => ({
    externalId: id, title, price: 100_000, currency: "XOF", url: `https://annonces-demo-a.example/annonce/${id}`, location, listedAt: BASE, availability: "available" as const,
  });
  a.controls.extra = [
    wrong("x-yam", "iPhone 12 128 Go à Yamoussoukro", "Yamoussoukro"),
    wrong("x-bou", "iPhone 12 128 Go à Bouaké", "Bouaké"),
    wrong("x-cocody", "iPhone 12 64 Go Cocody extra", "Cocody"),
    wrong("x-s21", "Samsung Galaxy S21 128 Go", "Cocody"),
    wrong("x-13", "iPhone 13 128 Go", "Cocody"),
    wrong("x-mini", "iPhone 12 mini 64 Go", "Cocody"),
  ];
  await collect([a, b]);
  const answer = await list(demand.id, buyer.cookie, "?limit=30");
  const shown = titles(answer);
  assert.ok(shown.includes("iPhone 12 64 Go Cocody extra"), "une commune d'Abidjan convient à un besoin « Abidjan »");
  for (const refused of ["Yamoussoukro", "Bouaké", "Galaxy S21", "iPhone 13", "iPhone 12 mini"]) assert.ok(!shown.some((title) => title.includes(refused)), `« ${refused} » refusée`);
});

test("variante demandée : seules les annonces dont le titre porte la variante sont confirmées", async () => {
  const demand = await makeDemand(env.pool, { ownerId: buyer.userId, variant: "128 Go", budget: 500_000 });
  const a = fakes[0];
  a.controls.extra = [
    { externalId: "v-64", title: "iPhone 12 64 Go noir", price: 100_000, currency: "XOF", url: "https://annonces-demo-a.example/annonce/v-64", location: "Cocody", listedAt: BASE, availability: "available" },
    { externalId: "v-128", title: "iPhone 12 128Go blanc", price: 110_000, currency: "XOF", url: "https://annonces-demo-a.example/annonce/v-128", location: "Cocody", listedAt: BASE, availability: "available" },
  ];
  await collect();
  const shown = titles(await list(demand.id, buyer.cookie, "?limit=30"));
  assert.ok(shown.includes("iPhone 12 128Go blanc"));
  assert.ok(!shown.includes("iPhone 12 64 Go noir"));
  assert.ok(shown.length > 1 && shown.every((title) => /128/.test(title)), shown.join(" | "));
});

// ───────────── séparation du classement interne ─────────────

test("section SÉPARÉE : jamais dans les correspondances internes, ni dans leur classement ; aucune annonce interne créée ; aucun champ de boost", async () => {
  const seller = await createUser({}, env.pool);
  await createOffer({ ownerId: seller.id, rawText: "iPhone 12 128 Go interne", category: "Téléphones", brand: "Apple", model: "iPhone 12", price: { amount: 160_000, currency: "XOF" }, location: "Cocody", status: "published" }, env.pool);
  const demand = await makeDemand(env.pool, { ownerId: buyer.userId, budget: 200_000 });
  const offersBefore = await count(env.pool, "offers");
  for (let cycle = 0; cycle < 10; cycle++) {
    const result = await runMatchingCycle({ pool: env.pool, workerId: "ext-http", notificationTransport: null, collect: { connectors: fakes, now: clock.now, sleep: timer.sleep } });
    assert.deepEqual(result.errors, []);
    if (result.idle) break;
  }
  assert.equal(await count(env.pool, "offers"), offersBefore, "la collecte n'a créé aucune annonce interne");
  const internal = await matching.demands.storedMatches(request("GET", `/api/demands/${demand.id}/stored-matches`, { cookie: buyer.cookie, query: "?sort=relevance" }), demand.id).then(reply);
  assert.equal(internal.status, 200);
  const internalItems = (internal.json as { items: Array<{ candidateId: string; candidate: Json; sponsored: boolean }> }).items;
  assert.equal(internalItems.length, 1, "une seule annonce interne");
  const externalAnswer = await list(demand.id);
  assert.ok(items(externalAnswer).length >= 4);
  const internalText = JSON.stringify(internal.json);
  for (const item of items(externalAnswer)) {
    assert.ok(!internalText.includes(item.id), "aucune annonce externe dans le classement interne");
    assert.ok(!internalText.includes(item.title));
    assert.equal(internalItems.some((entry) => entry.candidateId === item.id), false);
  }
  assert.ok(!internalText.includes("Annonces Démo"), "aucune source externe dans les résultats internes");
  // Aucune de ces annonces n'est une annonce interne : on ne peut ni les ouvrir comme une fiche, ni les boosts.
  for (const item of items(externalAnswer)) assert.equal(await count(env.pool, "offers", `id = '${item.id}'`), 0);
  // Contrat externe : liste blanche, aucun champ interne ni de boost.
  for (const item of items(externalAnswer)) {
    assert.deepEqual(Object.keys(item).sort(), ["alsoOn", "confirmedAt", "id", "listedAt", "location", "price", "score", "seenAt", "source", "title", "url"]);
    assert.ok(!("sponsored" in item) && !("candidateId" in item) && !("indicators" in item) && !("boost" in item));
  }
  // Aucune information sur la surveillance partagée (ni `watching`, ni `lastCollectedAt`) : elle dirait à un acheteur ce que d'autres ont cherché.
  assert.deepEqual(Object.keys(externalAnswer.json as Json).sort(), ["contractVersion", "hasMore", "items", "nextCursor"]);
});

test("aucune notification, externe ou interne, n'est créée pour une annonce d'un autre site", async () => {
  await makeDemand(env.pool, { ownerId: buyer.userId, budget: 200_000 });
  const before = { notifications: await count(env.pool, "notifications"), deliveries: await count(env.pool, "notification_deliveries") };
  await collect();
  await collect();
  assert.deepEqual({ notifications: await count(env.pool, "notifications"), deliveries: await count(env.pool, "notification_deliveries") }, before);
  assert.ok(await count(env.pool, "external_listings") > 0);
});

// ───────────── accès ─────────────

test("accès : session exigée (401), besoin d'autrui = besoin inexistant (404 identique), besoin inactif (400), paramètres stricts (400)", async () => {
  const demand = await makeDemand(env.pool, { ownerId: buyer.userId, budget: 200_000 });
  await collect();
  const stranger = await login(env.pool);
  const anonymous = await list(demand.id, null);
  assert.equal(anonymous.status, 401);
  const others = await list(demand.id, stranger.cookie);
  const unknown = await list("00000000-0000-4000-8000-0000000000aa");
  assert.equal(others.status, 404);
  assert.equal(unknown.status, 404);
  assert.equal(others.text, unknown.text, "indiscernable");
  assert.deepEqual(others.json, NOT_FOUND);
  for (const bad of ["not-a-uuid", "123"]) assert.equal((await list(bad)).status, 400);
  for (const query of ["?limit=0", "?limit=31", "?limit=abc", "?limit=1&limit=2", "?cursor=!!!", "?foo=1", "?cursor=" + "a".repeat(400), `?cursor=${Buffer.from('{"s":1}').toString("base64url")}`]) {
    assert.equal((await list(demand.id, buyer.cookie, query)).status, 400, query);
  }
  await satisfyDemand(demand.ownerId, demand.id, demand.contentVersion, env.pool);
  assert.equal((await list(demand.id)).status, 400, "besoin satisfait : pas de résultats");
});

test("pagination par curseur : pages complètes sans doublon ni trou, ordre stable", async () => {
  const demand = await makeDemand(env.pool, { ownerId: buyer.userId, budget: 900_000 });
  const a = fakes[0];
  a.controls.extra = Array.from({ length: 12 }, (_, index) => ({
    externalId: `p-${index}`, title: `iPhone 12 128 Go lot ${index}`, price: 100_000 + index * 1_000, currency: "XOF", url: `https://annonces-demo-a.example/annonce/p-${index}`,
    location: "Marcory", listedAt: BASE, availability: "available" as const,
  }));
  await collect();
  const everything = await list(demand.id, buyer.cookie, "?limit=30");
  const total = items(everything).length;
  assert.ok(total >= 14, `${total} annonces`);
  const seen: string[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const page = await list(demand.id, buyer.cookie, `?limit=5${cursor ? `&cursor=${cursor}` : ""}`);
    assert.equal(page.status, 200);
    seen.push(...items(page).map((item) => item.id));
    const body = page.json as { hasMore: boolean; nextCursor: string | null };
    assert.equal(body.hasMore, body.nextCursor !== null);
    cursor = body.nextCursor;
    pages += 1;
  } while (cursor && pages < 20);
  assert.equal(new Set(seen).size, seen.length, "aucun doublon");
  assert.deepEqual(seen, items(everything).map((item) => item.id), "même ordre que la liste entière");
  assert.ok(pages >= 3);
});

test("annonces masquées : disparue, périmée (48 h), source désactivée, absente 3 fois pour CETTE surveillance", async () => {
  const demand = await makeDemand(env.pool, { ownerId: buyer.userId, budget: 900_000 });
  await collect();
  const full = items(await list(demand.id, buyer.cookie, "?limit=30"));
  assert.ok(full.length >= 4);
  const bySource = (code: string) => full.filter((item) => item.source.code === code);
  // Disparue.
  await env.pool.query("UPDATE external_listings SET availability_status = 'gone' WHERE id = $1", [full[0].id]);
  assert.ok(!items(await list(demand.id, buyer.cookie, "?limit=30")).some((item) => item.id === full[0].id));
  // Périmée : aucune collecte réussie ne l'a VUE depuis plus de 48 h.
  await env.pool.query("UPDATE external_listings SET first_seen_at = LEAST(first_seen_at, $2), last_seen_at = $2 WHERE id = $1", [full[1].id, new Date(Date.now() - 49 * 3_600_000)]);
  assert.ok(!items(await list(demand.id, buyer.cookie, "?limit=30")).some((item) => item.id === full[1].id));
  // Absente 3 fois pour cette surveillance (même si l'annonce reste « available » ailleurs).
  await env.pool.query("UPDATE source_observations SET missed_collects = 3 WHERE listing_id = $1", [full[2].id]);
  assert.ok(!items(await list(demand.id, buyer.cookie, "?limit=30")).some((item) => item.id === full[2].id));
  // Source désactivée.
  await env.pool.query("UPDATE external_sources SET enabled = FALSE WHERE code = 'demo_b'");
  const withoutB = items(await list(demand.id, buyer.cookie, "?limit=30"));
  assert.ok(withoutB.every((item) => item.source.code !== "demo_b"));
  assert.ok(bySource("demo_b").length > 0);
});

test("confidentialité : aucun numéro de téléphone dans les réponses, aucun identifiant chez la source, aucune URL non http(s)", async () => {
  const demand = await makeDemand(env.pool, { ownerId: buyer.userId, budget: 900_000 });
  fakes[1].controls.extra = [{ externalId: "tel-1", title: "iPhone 12 noir, WhatsApp 0708091011", price: 100_000, currency: "XOF", url: "https://annonces-demo-b.example/annonce/tel-1", location: "Cocody", listedAt: BASE, availability: "available" }];
  await collect();
  const answer = await list(demand.id, buyer.cookie, "?limit=30");
  assert.ok(!answer.text.includes("0708091011"));
  assert.ok(!answer.text.includes("WhatsApp"), "le titre fautif est retiré : l'annonce n'est plus confirmée");
  for (const item of items(answer)) {
    assert.match(item.url, /^https:\/\/annonces-demo-[ab]\.example\/annonce\//);
    for (const value of [item.title, item.location ?? "", item.source.name]) assert.equal(looksLikePhoneNumber(value), false, value);
  }
});

// ───────────── administration ─────────────

test("/api/admin/collection : le MÊME 404 pour un visiteur, un compte ordinaire et un administrateur suspendu ; 200 pour l'administrateur", async () => {
  const ordinary = await login(env.pool);
  const boss = await login(env.pool);
  await grantAdmin({ pool: env.pool, phone: boss.phone });
  await makeDemand(env.pool, { ownerId: buyer.userId, budget: 200_000 });
  fakes[0].controls.failure = new Error("panne");
  await collect();
  const get = (cookie: string | null) => external.adminCollection(request("GET", "/api/admin/collection", { cookie })).then(reply);
  const visitor = await get(null);
  assert.equal(visitor.status, 404);
  assert.deepEqual(visitor.json, NOT_FOUND);
  for (const cookie of [ordinary.cookie, buyer.cookie]) {
    const refused = await get(cookie);
    assert.equal(refused.status, 404);
    assert.equal(refused.text, visitor.text, "indiscernable");
  }
  const granted = await get(boss.cookie);
  assert.equal(granted.status, 200);
  const body = granted.json as { contractVersion: string; schemaReady: boolean; sources: Array<Json>; watches: Json; listings: Json; errors: Array<Json> };
  assert.equal(body.contractVersion, "admin-collection/v1");
  assert.equal(body.schemaReady, true);
  assert.deepEqual(body.sources.map((source) => source.code), ["demo_a", "demo_b"]);
  assert.ok(body.sources.every((source) => source.type === "fake"), "aucune source réelle");
  const sourceA = body.sources[0];
  assert.equal(sourceA.state, "closed");
  assert.equal(sourceA.consecutiveFailures, 1);
  assert.equal(sourceA.usedToday, 1);
  assert.equal(body.sources[1].usedToday, 1);
  assert.deepEqual(body.watches, { total: 1, active: 1, paused: 0, due: 0 });
  assert.ok((body.listings.available as number) > 0);
  assert.equal(body.errors.length, 1);
  assert.equal(body.errors[0].code, "connector_error");
  assert.ok(!JSON.stringify(body).includes("panne"), "jamais le message d'une source");
  // Disjoncteur ouvert : visible.
  for (let attempt = 0; attempt < 2; attempt++) {
    clock.advance(1_000);
    await collect();
  }
  const open = (await get(boss.cookie)).json as typeof body;
  assert.equal(open.sources[0].state, "open");
  assert.ok(open.sources[0].breakerOpenUntil);
  // Une requête avec paramètre ou une écriture n'existe pas.
  assert.equal((await external.adminCollection(request("GET", "/api/admin/collection", { cookie: boss.cookie, query: "?x=1" })).then(reply)).status, 400);
  // Compte administrateur suspendu : perd tout accès, 404 indiscernable.
  await env.pool.query("UPDATE users SET status = 'suspended' WHERE id = $1", [boss.userId]);
  assert.equal((await get(boss.cookie)).status, 404);
  await env.pool.query("UPDATE users SET status = 'active' WHERE id = $1", [boss.userId]);
});


// ───────────── EXT1-bis : fraîcheur, surveillance partagée non exposée ─────────────

test("fraîcheur (audit EXT1) : n'est montrée qu'une annonce VUE il y a moins de 48 h ; « Vue le » est la date de la dernière VUE, jamais celle d'une collecte où l'annonce était absente", async () => {
  const demand = await makeDemand(env.pool, { ownerId: buyer.userId, budget: 900_000 });
  const [a] = fakes;
  await env.pool.query("UPDATE external_sources SET enabled = (code = 'demo_a')");
  const wide = (id: string, title: string, price: number) => ({ externalId: id, title, price, currency: "XOF", url: `https://annonces-demo-a.example/annonce/${id}`, location: "Cocody", listedAt: BASE, availability: "available" as const });
  a.controls.extra = [wide("x-keep", "iPhone 12 blanc fraîchement vu", 110_000), wide("x-30h", "iPhone 12 noir vu il y a 30 h", 120_000), wide("x-72h", "iPhone 12 gris vu il y a 72 h", 130_000)];
  const t0 = clock.now();
  await collect();
  const fresh = items(await list(demand.id, buyer.cookie, "?limit=30"));
  for (const title of ["iPhone 12 blanc fraîchement vu", "iPhone 12 noir vu il y a 30 h", "iPhone 12 gris vu il y a 72 h"]) assert.ok(fresh.some((item) => item.title === title), title);

  // 30 h plus tard : x-30h et x-72h ne sont plus dans la réponse de la source (collecte RÉUSSIE sans elles = absence, qui met `last_checked_at` à jour).
  clock.advance(30 * 3_600_000);
  a.controls.extra = [wide("x-keep", "iPhone 12 blanc fraîchement vu", 110_000)];
  await collect();
  const after30 = items(await list(demand.id, buyer.cookie, "?limit=30"));
  const thirty = after30.find((item) => item.title === "iPhone 12 noir vu il y a 30 h");
  assert.ok(thirty, "vue il y a 30 h : encore montrée");
  assert.equal(thirty.seenAt, t0.toISOString(), "« Vue le » = la dernière VUE (30 h plus tôt), pas la collecte où elle était absente");
  const keep30 = after30.find((item) => item.title === "iPhone 12 blanc fraîchement vu") as Item;
  assert.equal(keep30.seenAt, clock.now().toISOString(), "une annonce encore présente : vue à la dernière collecte");

  // 72 h après la première collecte (42 h de plus) : x-30h et x-72h, vues pour la dernière fois il y a 72 h, ne sont PLUS montrées, bien que la collecte qui vient d'avoir lieu les ait « examinées ».
  clock.advance(42 * 3_600_000);
  await collect();
  const row = (await env.pool.query("SELECT last_seen_at, last_checked_at FROM external_listings WHERE external_id = 'x-72h'")).rows[0];
  assert.equal(new Date(row.last_seen_at).toISOString(), t0.toISOString());
  assert.equal(new Date(row.last_checked_at).toISOString(), clock.now().toISOString(), "last_checked_at suit les absences : il ne doit jamais décider de l'affichage");
  const after72 = items(await list(demand.id, buyer.cookie, "?limit=30"));
  assert.equal(after72.some((item) => item.title === "iPhone 12 gris vu il y a 72 h"), false, "vue pour la dernière fois il y a 72 h : masquée");
  assert.equal(after72.some((item) => item.title === "iPhone 12 noir vu il y a 30 h"), false, "vue pour la dernière fois il y a 72 h : masquée");
  assert.ok(after72.some((item) => item.title === "iPhone 12 blanc fraîchement vu"));
  // Aucune annonce montrée n'a une date de vue de plus de 48 h.
  for (const item of after72) assert.ok(clock.now().getTime() - new Date(item.seenAt).getTime() <= 48 * 3_600_000, `${item.title} : vue le ${item.seenAt}`);
  // Borne : vue il y a 47 h 59 : montrée ; il y a plus de 48 h : masquée.
  const target = (await env.pool.query("SELECT id FROM external_listings WHERE external_id = 'x-keep'")).rows[0].id as string;
  await env.pool.query("UPDATE external_listings SET last_seen_at = $2 WHERE id = $1", [target, new Date(clock.now().getTime() - 48 * 3_600_000 + 60_000)]);
  assert.ok(items(await list(demand.id, buyer.cookie, "?limit=30")).some((item) => item.id === target));
  await env.pool.query("UPDATE external_listings SET last_seen_at = $2 WHERE id = $1", [target, new Date(clock.now().getTime() - 48 * 3_600_000 - 60_000)]);
  assert.equal(items(await list(demand.id, buyer.cookie, "?limit=30")).some((item) => item.id === target), false);
});

test("lecture : au plus 300 candidats évalués (les plus récemment vus d'abord), 6 annonces par page par défaut", async () => {
  const demand = await makeDemand(env.pool, { ownerId: buyer.userId, budget: 900_000 });
  await runCollectStep({ pool: env.pool, connectors: [], now: clock.now, sleep: timer.sleep }); // crée la surveillance
  const watchId = (await env.pool.query("SELECT id FROM market_watches")).rows[0].id as string;
  const hash = "b".repeat(64);
  await env.pool.query("INSERT INTO external_analyses (content_hash, analysis, analyzer_version) VALUES ($1, $2::jsonb, 'ext-analysis/v1')", [hash, JSON.stringify({ version: "ext-analysis/v1", tokens: ["iphone", "12", "128", "go", "lot"], notTheProduct: false })]);
  await env.pool.query(
    `INSERT INTO external_listings (source_code, external_id, canonical_url, title, price_amount, price_currency, location_text, availability_status, availability_confirmed_at, availability_origin, content_hash,
                                    first_seen_at, last_seen_at, last_checked_at)
     SELECT 'demo_a', 'bulk-' || i, 'https://annonces-demo-a.example/annonce/bulk-' || i, 'iPhone 12 128 Go lot ' || i, 100000 + i, 'XOF', 'Cocody', 'available', $2::timestamptz, 'source', $1,
            $2::timestamptz - (i * interval '1 minute') - interval '1 hour', $2::timestamptz - (i * interval '1 minute'), $2::timestamptz - (i * interval '1 minute')
       FROM generate_series(0, 319) AS i`,
    [hash, clock.now()],
  );
  await env.pool.query("INSERT INTO source_observations (watch_id, listing_id, first_seen_at, last_seen_at, missed_collects) SELECT $1::uuid, id, first_seen_at, last_seen_at, 0 FROM external_listings", [watchId]);
  const byDefault = await list(demand.id);
  assert.equal(items(byDefault).length, 6, "6 annonces par page par défaut");
  assert.equal((byDefault.json as { hasMore: boolean }).hasMore, true);
  const seen: string[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const page = await list(demand.id, buyer.cookie, `?limit=30${cursor ? `&cursor=${cursor}` : ""}`);
    assert.equal(page.status, 200);
    seen.push(...titles(page));
    cursor = (page.json as { nextCursor: string | null }).nextCursor;
    pages += 1;
  } while (cursor && pages < 30);
  assert.equal(seen.length, 300, "320 annonces compatibles, 300 candidats évalués");
  assert.ok(seen.includes("iPhone 12 128 Go lot 299"));
  for (const excluded of [300, 310, 319]) assert.equal(seen.includes(`iPhone 12 128 Go lot ${excluded}`), false, `lot ${excluded} : vue le moins récemment, au-delà des 300`);
});

test("la surveillance partagée n'est jamais exposée : un acheteur dont le besoin a la même clé qu'un besoin clos d'un autre n'apprend ni qu'elle existe ni quand elle a été collectée", async () => {
  const neighbour = await login(env.pool);
  const closed = await makeDemand(env.pool, { ownerId: neighbour.userId, variant: "128 Go", location: "Yopougon" });
  await collect();
  await archiveDemand(closed.ownerId, closed.id, closed.contentVersion, env.pool);
  await runCollectStep({ pool: env.pool, connectors: [], now: clock.now, sleep: timer.sleep }); // synchronisation : la surveillance passe en pause
  clock.advance(5 * 24 * 3_600_000);
  const mine = await makeDemand(env.pool, { ownerId: buyer.userId, variant: "128 Go", location: "Yopougon" });
  const answer = await list(mine.id);
  assert.equal(answer.status, 200);
  assert.deepEqual(Object.keys(answer.json as Json).sort(), ["contractVersion", "hasMore", "items", "nextCursor"]);
  assert.ok(!answer.text.includes("watching") && !answer.text.includes("lastCollectedAt"));
  const direct = await listExternalMatchesForDemand({ pool: env.pool, ownerId: buyer.userId, demandId: mine.id, now: clock.now() });
  assert.deepEqual(Object.keys(direct).sort(), ["hasMore", "items", "nextCursor"]);
  // « 128 Go », « 128Go » et « 128 GB » : une seule surveillance, une seule clé.
  const watchesBefore = await count(env.pool, "market_watches");
  await makeDemand(env.pool, { ownerId: buyer.userId, variant: "128Go", location: "Yopougon" });
  await makeDemand(env.pool, { ownerId: buyer.userId, variant: "128 GB", location: "Yopougon" });
  await runCollectStep({ pool: env.pool, connectors: [], now: clock.now, sleep: timer.sleep });
  assert.equal(await count(env.pool, "market_watches"), watchesBefore, "trois écritures de la même variante : une seule surveillance");
});

test("aucun appel réseau sortant pendant toute la suite", () => {
  assert.deepEqual(guard.attempts, []);
});
