import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Pool } from "pg";
import { createDemand, createOffer } from "../../lib/server/catalog";
import type { DemandRecord, OfferRecord } from "../../lib/server/catalog/types";
import { createMarketClient, type MarketListings } from "../../lib/client/market-api";
import { marketQueryFromProduct } from "../../lib/client/market-view";
import { createMarketHttpHandlers } from "../../lib/server/market/http";
import { createMarketRateLimiter } from "../../lib/server/market/rate-limit";
import { RELEVANCE_CONFIG } from "../../lib/server/matching/relevance-config";
import { listStoredOfferMatchesForDemand, readStoredOfferForDemand } from "../../lib/server/matching/stored-matches";
import { dayBefore, insertObservation, makeActors } from "./market-fixtures";
import { insertEvaluation, makePerson } from "./metrics-fixtures";
import { login, openTestSchema, request, resetSocial, type Login, type TestSchema } from "./social-fixtures";

/**
 * Lot FIN1, cohérence ENTRE lots : l'indicateur « Prix » de la fiche et des résultats (lot matching) et l'encart « Prix demandés dans les annonces » (lot prix du marché) ne parlent
 * que d'UNE référence. L'encart est lu comme le fait le navigateur (client `market.stats` → route GET /api/market), l'indicateur comme la fiche le lit (`readStoredOfferForDemand`) ;
 * quand l'encart est publié pour la clé de l'annonce, la position et l'écart de l'indicateur sont CEUX de la médiane de l'encart (mêmes élargissements, même période, même effectif),
 * et l'indicateur n'est jamais « marché insuffisant » à côté d'un encart rempli. Sinon l'indicateur compare à un marché de clé variante + état.
 */

let env: TestSchema;
let pool: Pool;
let viewer: Login;
let today: string;
let buyerId: string;
let demand: DemandRecord;

before(async () => {
  env = await openTestSchema();
  pool = env.pool;
  viewer = await login(pool);
  today = (await pool.query<{ d: string }>("SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS d")).rows[0].d;
});

after(async () => {
  await env.close();
});

const IPHONE = { category: "Téléphones", brand: "Apple", model: "iPhone 12" } as const;
const S21 = { category: "Téléphones", brand: "Samsung", model: "Galaxy S21" } as const;
const MACBOOK = { category: "Ordinateurs", brand: "Apple", model: "MacBook Air M1" } as const;

type Product = { category: string; brand: string; model: string };

async function reset(): Promise<void> {
  await resetSocial(pool);
  await pool.query("TRUNCATE price_observations, matching_evaluations, demands, offers CASCADE");
  const buyer = await makePerson(pool, { phone: false });
  buyerId = buyer.id;
  demand = await createDemand({
    ownerId: buyerId, rawText: "Je cherche un téléphone", category: "Téléphones", brand: "Apple", model: "iPhone 12", condition: "Occasion", location: "Cocody",
    budget: { amount: 400_000, currency: "XOF" }, status: "active",
  }, pool);
}

/** Des relevés d'annonces (un vendeur par prix) : l'historique du marché, antérieur aux annonces évaluées. */
async function history(product: Product, variant: string | null, condition: string | null, prices: readonly number[]): Promise<void> {
  const { sellers } = await makeActors(pool, prices.length, 0);
  for (const [index, price] of prices.entries()) await insertObservation(pool, { ...product, variant, condition, day: dayBefore(1 + (index % 3), today), price, sellerId: sellers[index].id });
}

/** Une annonce publiée (relevée par le déclencheur) et sa correspondance confirmée avec le besoin de l'acheteur. */
async function listed(product: Product, variant: string | null, condition: string | null, price: number): Promise<OfferRecord> {
  const seller = await makePerson(pool, { phone: false });
  const offer = await createOffer({
    ownerId: seller.id, rawText: "Annonce", ...product, variant, condition, location: "Cocody", price: { amount: price, currency: "XOF" },
    status: "published", availabilityStatus: "available", availabilityConfirmedAt: new Date(),
  }, pool);
  await insertEvaluation(pool, { offer, demand, score: 90 });
  return offer;
}

/** L'encart, lu comme le navigateur le lit : le client de la fiche, la route GET /api/market, la clé construite depuis les champs publics de la correspondance. */
async function cardOf(offer: OfferRecord): Promise<MarketListings> {
  const handlers = createMarketHttpHandlers({ pool, env: { NOMA_AUTH_ORIGIN: "https://noma.test" }, log: () => {}, rateLimiter: createMarketRateLimiter() });
  const client = createMarketClient({
    fetch: async (path) => {
      const [pathname, query] = String(path).split("?");
      return handlers.stats(request("GET", pathname, { cookie: viewer.cookie, query: `?${query}` }));
    },
  });
  const detail = await readStoredOfferForDemand(buyerId, demand.id, offer.id, pool);
  assert.ok(detail, "la fiche est servie");
  const query = marketQueryFromProduct(detail.item.candidate);
  assert.ok(query, "la fiche a une clé produit");
  return (await client.stats(query)).listings;
}

/** Ce que la position et l'écart DOIVENT être quand ils se calculent par rapport à la médiane de l'encart (écrit ici à la main, sans réutiliser le code testé). */
function expectedFromCard(price: number, card: Extract<MarketListings, { status: "published" }>): { position: string; deltaPercent: number } {
  const deltaPercent = Math.round(((price - card.median) / card.median) * 100);
  const band = RELEVANCE_CONFIG.price.publishedBandPercent / 100;
  const below = card.range === null ? price < card.median * (1 - band) : price < card.range.q1;
  const above = card.range === null ? price > card.median * (1 + band) : price > card.range.q3;
  return { position: below ? "below_market" : above ? "above_market" : "in_market", deltaPercent };
}

async function indicatorOf(offer: OfferRecord) {
  const detail = await readStoredOfferForDemand(buyerId, demand.id, offer.id, pool);
  assert.ok(detail);
  const page = await listStoredOfferMatchesForDemand(buyerId, demand.id, { sort: "relevance", limit: 50 }, pool);
  const listedItem = page.items.find((item) => item.candidateId === offer.id);
  assert.ok(listedItem, "l'annonce figure dans les résultats");
  assert.deepEqual(listedItem.indicators.price, detail.item.indicators.price, "les résultats et la fiche servent le même indicateur de prix");
  return detail.item.indicators.price!;
}

const SPREAD_12 = Array.from({ length: 12 }, (_, index) => 150_000 + index * 5_000);

test("les cas de l'audit : la fiche et l'encart donnent la MÊME référence (position et écart de la médiane de l'encart), jamais « marché insuffisant » à côté d'un encart rempli", async () => {
  await reset();
  // iPhone 12 128 Go d'occasion : 12 vendeurs (150 000 à 205 000) → clé exacte publiée avec fourchette.
  await history(IPHONE, "128 Go", "Occasion", SPREAD_12);
  // iPhone 12 64 Go d'occasion : 3 vendeurs seulement → la comparaison s'élargit (toutes variantes, même état).
  await history(IPHONE, "64 Go", "Occasion", [120_000, 125_000, 130_000]);
  // iPhone 12 128 Go reconditionné : 3 vendeurs → élargissement jusqu'à « toutes variantes et tous états confondus ».
  await history(IPHONE, "128 Go", "Reconditionné", [180_000, 182_000, 184_000]);
  // Galaxy S21 d'occasion : 5 vendeurs d'historique, puis trois annonces évaluées (135 000, 130 000 et 140 000) → 8 vendeurs : médiane sans fourchette.
  await history(S21, "128 Go", "Occasion", [125_000, 132_000, 138_000, 142_000, 150_000]);
  // MacBook Air M1 : 15 vendeurs d'historique ; une seule annonce évaluée (le marché des offres de la base n'aurait que cette annonce).
  await history(MACBOOK, "8 Go · 256 Go", "Occasion", Array.from({ length: 15 }, (_, index) => 400_000 + index * 10_000));

  const cases: Array<{ name: string; product: Product; variant: string; condition: string; price: number; scope: string }> = [
    { name: "iPhone 12 128 Go 165 000", product: IPHONE, variant: "128 Go", condition: "Occasion", price: 165_000, scope: "exact" },
    { name: "Galaxy S21 135 000", product: S21, variant: "128 Go", condition: "Occasion", price: 135_000, scope: "exact" },
    { name: "Galaxy S21 130 000", product: S21, variant: "128 Go", condition: "Occasion", price: 130_000, scope: "exact" },
    { name: "Galaxy S21 140 000", product: S21, variant: "128 Go", condition: "Occasion", price: 140_000, scope: "exact" },
    { name: "iPhone 12 128 Go reconditionné 185 000", product: IPHONE, variant: "128 Go", condition: "Reconditionné", price: 185_000, scope: "any_variant_and_condition" },
    { name: "iPhone 12 64 Go 128 000", product: IPHONE, variant: "64 Go", condition: "Occasion", price: 128_000, scope: "any_variant" },
    { name: "MacBook Air M1 480 000", product: MACBOOK, variant: "8 Go · 256 Go", condition: "Occasion", price: 480_000, scope: "exact" },
  ];
  const offers: OfferRecord[] = [];
  for (const entry of cases) offers.push(await listed(entry.product, entry.variant, entry.condition, entry.price));

  for (const [index, entry] of cases.entries()) {
    const card = await cardOf(offers[index]);
    assert.equal(card.status, "published", `${entry.name} : l'encart est publié`);
    if (card.status !== "published") continue;
    assert.equal(card.comparedTo.scope, entry.scope, `${entry.name} : élargissement de l'encart`);
    const price = await indicatorOf(offers[index]);
    assert.notEqual(price.position, "insufficient_data", `${entry.name} : jamais « marché insuffisant » à côté d'un encart rempli`);
    const expected = expectedFromCard(entry.price, card);
    assert.deepEqual({ position: price.position, deltaPercent: price.deltaPercent }, expected, `${entry.name} : position et écart de la médiane de l'encart (${card.median})`);
    assert.deepEqual(price.factors, []);
    assert.equal(price.sampleSize, card.count.kind === "approx" ? card.count.value : card.count.bound, `${entry.name} : le même effectif arrondi que l'encart`);
  }
});

test("le défaut de l'audit : une annonce sous la médiane de l'encart n'est plus « au-dessus du marché » ; une annonce proche de la médiane n'est pas hors du marché", async () => {
  await reset();
  // Médiane de l'encart environ 136 500 (8 vendeurs, dont l'annonce évaluée) ; un marché d'offres de la base (3 annonces) la placerait « au-dessus ».
  await history(S21, "128 Go", "Occasion", [125_000, 132_000, 138_000, 142_000, 150_000]);
  const mine = await listed(S21, "128 Go", "Occasion", 135_000);
  await listed(S21, "128 Go", "Occasion", 130_000);
  await listed(S21, "128 Go", "Occasion", 140_000);
  const card = await cardOf(mine);
  assert.equal(card.status, "published");
  if (card.status !== "published") return;
  assert.ok(135_000 < card.median, `135 000 est sous la médiane de l'encart (${card.median})`);
  const price = await indicatorOf(mine);
  assert.ok(price.deltaPercent !== null && price.deltaPercent < 0, `écart négatif (${price.deltaPercent})`);
  assert.equal(price.position, "in_market");
});

test("sous les seuils de l'encart : repli sur le marché des offres de la base, avec une clé qui INCLUT la variante et l'état (jamais le modèle tout entier)", async () => {
  await reset();
  // UN seul vendeur : l'encart n'est jamais publié (5 vendeurs distincts au moins). Six annonces 64 Go à 100 000 et six annonces 256 Go à 300 000.
  const seller = await makePerson(pool, { phone: false });
  const make = (variant: string, condition: string, price: number) => createOffer({
    ownerId: seller.id, rawText: "Annonce", ...S21, variant, condition, location: "Cocody", price: { amount: price, currency: "XOF" },
    status: "published", availabilityStatus: "available", availabilityConfirmedAt: new Date(),
  }, pool);
  const mine = await make("64 Go", "Occasion", 100_000);
  for (let index = 0; index < 5; index += 1) await make("64 Go", "Occasion", 100_000);
  for (let index = 0; index < 6; index += 1) await make("256 Go", "Occasion", 300_000);
  for (let index = 0; index < 6; index += 1) await make("64 Go", "Neuf", 500_000);
  await insertEvaluation(pool, { offer: mine, demand, score: 90 });

  assert.deepEqual(await cardOf(mine), { status: "insufficient" }, "un seul vendeur : pas d'encart");
  const price = await indicatorOf(mine);
  // Clé variante + état : les cinq autres annonces « 64 Go, Occasion » à 100 000 → dans le marché, écart nul (le modèle tout entier donnerait une médiane de 300 000 : « sous le marché »).
  assert.deepEqual({ position: price.position, deltaPercent: price.deltaPercent, sampleSize: price.sampleSize, factors: price.factors }, { position: "in_market", deltaPercent: 0, sampleSize: 5, factors: [] });
});

test("sans assez d'annonces comparables nulle part : « marché insuffisant », cohérent avec l'encart « pas assez de données »", async () => {
  await reset();
  await history(MACBOOK, "8 Go · 256 Go", "Occasion", [450_000, 460_000]);
  const mine = await listed(MACBOOK, "8 Go · 256 Go", "Occasion", 480_000);
  assert.deepEqual(await cardOf(mine), { status: "insufficient" });
  const price = await indicatorOf(mine);
  assert.deepEqual({ position: price.position, score: price.score, deltaPercent: price.deltaPercent, factors: price.factors }, { position: "insufficient_data", score: null, deltaPercent: null, factors: ["insufficient_market"] });
});

test("la fourchette de l'encart : bornes multiples de 500 FCFA, jamais égales à la médiane ; la position suit ces bornes", async () => {
  await reset();
  await history(IPHONE, "128 Go", "Occasion", SPREAD_12);
  const inside = await listed(IPHONE, "128 Go", "Occasion", 165_000);
  const card = await cardOf(inside);
  assert.equal(card.status, "published");
  if (card.status !== "published") return;
  assert.ok(card.range, "13 vendeurs : une fourchette");
  assert.equal(card.range.q1 % 500, 0);
  assert.equal(card.range.q3 % 500, 0);
  assert.ok(card.range.q1 < card.median && card.median < card.range.q3);
  const above = await listed(IPHONE, "128 Go", "Occasion", card.range.q3 + 40_000);
  const below = await listed(IPHONE, "128 Go", "Occasion", card.range.q1 - 40_000);
  const cardNow = await cardOf(inside);
  assert.equal(cardNow.status, "published");
  if (cardNow.status !== "published") return;
  for (const offer of [inside, above, below]) {
    const price = await indicatorOf(offer);
    assert.deepEqual({ position: price.position, deltaPercent: price.deltaPercent }, expectedFromCard(offer.price!.amount, cardNow));
  }
  assert.equal((await indicatorOf(above)).position, "above_market");
  assert.equal((await indicatorOf(below)).position, "below_market");
});

test("base d'avant la migration 0023 (ni relevés de prix ni price_key_part) : la lecture des résultats ne casse pas, l'indicateur se rabat sur le marché des offres de la base", async () => {
  await reset();
  const seller = await makePerson(pool, { phone: false });
  const make = (price: number) => createOffer({
    ownerId: seller.id, rawText: "Annonce", ...S21, variant: "128 Go", condition: "Occasion", location: "Cocody", price: { amount: price, currency: "XOF" },
    status: "published", availabilityStatus: "available", availabilityConfirmedAt: new Date(),
  }, pool);
  const mine = await make(100_000);
  for (let index = 0; index < 5; index += 1) await make(100_000);
  await insertEvaluation(pool, { offer: mine, demand, score: 90 });
  // On retire de CE schéma d'essai ce que la migration 0023 a créé (le déclencheur d'abord : sans lui, les écritures suivantes n'appellent plus rien).
  await pool.query("DROP TRIGGER IF EXISTS trg_offers_observe_price ON offers");
  await pool.query("DROP TABLE price_observations CASCADE");
  await pool.query("DROP FUNCTION IF EXISTS price_key_part(text) CASCADE");
  const price = await indicatorOf(mine);
  assert.deepEqual({ position: price.position, deltaPercent: price.deltaPercent, sampleSize: price.sampleSize }, { position: "in_market", deltaPercent: 0, sampleSize: 5 });
});
