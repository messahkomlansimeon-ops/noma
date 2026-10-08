import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import type { Pool } from "pg";
import { createAdminHttpHandlers, type AdminHttpHandlers } from "../../lib/server/admin/http";
import { grantAdmin } from "../../lib/server/admin/grant";
import { createOffer } from "../../lib/server/catalog";
import { createMarketHttpHandlers, parseMarketQuery, type MarketHttpHandlers } from "../../lib/server/market/http";
import { createMarketRateLimiter } from "../../lib/server/market/rate-limit";
import { MarketError } from "../../lib/server/market/reads";
import { dayBefore, insertObservation, makeActors, resetObservations } from "./market-fixtures";
import { NOT_FOUND, login, openTestSchema, reply, request, resetSocial, type Login, type TestSchema } from "./social-fixtures";

/**
 * Route GET /api/market et tableau d'administration (lots H1, H1-bis et H1-ter) : connexion exigée, paramètres en LISTE BLANCHE, `no-store`, limite de 60 lectures par minute et par utilisateur,
 * forme exacte de la réponse (aucun identifiant de vendeur ni d'acheteur, aucun prix individuel), erreurs à texte fixe, administration réservée (404 indiscernable).
 */

let env: TestSchema;
let pool: Pool;
let viewer: Login;
let boss: Login;
let handlers: MarketHttpHandlers;
let admin: AdminHttpHandlers;
let today: string;
const logged: string[] = [];

before(async () => {
  env = await openTestSchema();
  pool = env.pool;
  const common = { pool, env: { NOMA_AUTH_ORIGIN: "https://noma.test" }, log: (code: string) => void logged.push(code) };
  handlers = createMarketHttpHandlers({ ...common, rateLimiter: createMarketRateLimiter() });
  admin = createAdminHttpHandlers(common);
  viewer = await login(pool);
  boss = await login(pool);
  assert.equal((await grantAdmin({ pool, phone: boss.phone })).granted, true);
  today = (await pool.query<{ d: string }>("SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS d")).rows[0].d;
});

after(async () => {
  await env.close();
});

beforeEach(async () => {
  await resetSocial(pool);
  await resetObservations(pool);
  logged.length = 0;
});

const QUERY = "?category=T%C3%A9l%C3%A9phones&brand=Apple&model=iPhone%2012&variant=128%20Go&condition=Occasion";
const market = (cookie: string | null, query = QUERY, handler: MarketHttpHandlers = handlers) => handler.stats(request("GET", "/api/market", { cookie, query })).then(reply);

const SALE_PRICES = [777_001, 777_002, 777_003, 777_004, 777_005, 777_006, 777_007];

async function knownWorld(): Promise<{ sellerIds: string[]; buyerIds: string[] }> {
  const { sellers, buyers } = await makeActors(pool, 7, 7);
  // Six annonces de six vendeurs, observées trois jours chacune : une valeur par vendeur (150 000 à 175 000), médiane 162 500.
  for (const [index, price] of [150_000, 155_000, 160_000, 165_000, 170_000, 175_000].entries()) {
    const referenceId = (await pool.query<{ id: string }>("SELECT gen_random_uuid() AS id")).rows[0].id;
    for (const offset of [0, 1, 2]) await insertObservation(pool, { referenceId, day: dayBefore(offset, today), price, sellerId: sellers[index].id });
  }
  // Sept ventes confirmées de la même clé, à des prix reconnaissables : AUCUN prix de vente ne doit jamais sortir.
  for (const [index, price] of SALE_PRICES.entries()) await insertObservation(pool, { source: "sale", day: dayBefore(index, today), price, sellerId: sellers[index].id, buyerId: buyers[index].id });
  return { sellerIds: sellers.map((seller) => seller.id), buyerIds: buyers.map((buyer) => buyer.id) };
}

type Json = Record<string, unknown>;

describe("accès", () => {
  test("sans session ou avec une session invalide : 401 à texte fixe ; ces refus ne consomment pas la limite de débit", async () => {
    const limited = createMarketHttpHandlers({ pool, env: { NOMA_AUTH_ORIGIN: "https://noma.test" }, log: () => {}, rateLimiter: createMarketRateLimiter() });
    for (let index = 0; index < 80; index += 1) {
      const answer = await market(index % 2 === 0 ? null : "noma_auth=n-importe-quoi", QUERY, limited);
      assert.equal(answer.status, 401);
      assert.deepEqual(answer.json, { error: { code: "authentication_required", message: "Authentification requise." } });
    }
    assert.equal((await market(viewer.cookie, QUERY, limited)).status, 200, "la limite est intacte pour l'utilisateur connecté");
  });
});

describe("réponse", () => {
  test("forme exacte (liste blanche) : annonces seulement, médiane, effectifs arrondis, comparabilité dite, no-store ; AUCUN prix de vente, aucun identifiant, aucun minimum ni maximum", async () => {
    const { sellerIds, buyerIds } = await knownWorld();
    const answer = await market(viewer.cookie);
    assert.equal(answer.status, 200);
    const body = answer.json as Json;
    assert.deepEqual(Object.keys(body).sort(), ["contractVersion", "currency", "listings", "period", "roundingXof"], "aucune clé « sales »");
    assert.equal(body.contractVersion, "market/v3");
    assert.equal(body.currency, "XOF");
    assert.equal(body.roundingXof, 500);
    assert.deepEqual(body.period, { days: 90, from: dayBefore(89, today), to: today });
    const listings = body.listings as Json;
    assert.deepEqual(Object.keys(listings).sort(), ["comparedTo", "count", "excluded", "median", "range", "sellers", "status", "trend"]);
    assert.equal(listings.status, "published");
    assert.equal(listings.median, 162_500);
    assert.equal(listings.range, null, "six vendeurs : la médiane seule");
    assert.equal(listings.excluded, null);
    assert.deepEqual(listings.count, { kind: "approx", value: 5 });
    assert.deepEqual(listings.sellers, { kind: "approx", value: 5 }, "six vendeurs → environ 5");
    assert.deepEqual(listings.comparedTo, { scope: "exact", text: "Comparé à : iPhone 12 128 Go, Occasion" });
    for (const secret of [...sellerIds, ...buyerIds, ...SALE_PRICES.map(String), "reference", '"seller"', "sellerId", "seller_id", "buyer", "sales", "vente"]) assert.equal(answer.text.includes(secret), false, secret);
    const trend = listings.trend as Array<{ from: string; median: number | null }>;
    assert.equal(trend.length, 12);
    assert.ok(trend.every((point) => Object.keys(point).sort().join() === "from,median" && point.median === null), "moins de 15 vendeurs par semaine : aucun point");
  });

  test("les ventes ne sont jamais publiées : un marché qui n'a que des ventes confirmées n'a « pas assez de données », et aucun prix de vente n'est dans la réponse", async () => {
    const { sellers, buyers } = await makeActors(pool, 7, 7);
    for (const [index, price] of SALE_PRICES.entries()) await insertObservation(pool, { source: "sale", day: dayBefore(index, today), price, sellerId: sellers[index].id, buyerId: buyers[index].id });
    const answer = await market(viewer.cookie);
    assert.deepEqual((answer.json as Json).listings, { status: "insufficient" });
    assert.deepEqual(Object.keys(answer.json as Json).sort(), ["contractVersion", "currency", "listings", "period", "roundingXof"]);
    for (const price of SALE_PRICES) assert.equal(answer.text.includes(String(price)), false);
  });

  test("la période se choisit (30, 90, 365 ; 90 par défaut) ; variante et état sont facultatifs et élargissent la comparaison (dite)", async () => {
    const { sellers } = await makeActors(pool, 7, 0);
    for (let index = 0; index < 3; index += 1) await insertObservation(pool, { day: dayBefore(1, today), price: 150_000, sellerId: sellers[index].id });
    for (let index = 3; index < 7; index += 1) await insertObservation(pool, { day: dayBefore(1, today), price: 200_000, sellerId: sellers[index].id, variant: "256 Go" });
    for (const [period, days] of [["", 90], ["&period=30", 30], ["&period=90", 90], ["&period=365", 365]] as const) {
      const body = (await market(viewer.cookie, `${QUERY}${period}`)).json as { period: { days: number } };
      assert.equal(body.period.days, days, period);
    }
    const widened = ((await market(viewer.cookie)).json as { listings: { comparedTo: { scope: string; text: string } } }).listings.comparedTo;
    assert.deepEqual(widened, { scope: "any_variant", text: "Comparé à : iPhone 12, Occasion, toutes variantes confondues" });
    const bare = (await market(viewer.cookie, "?category=T%C3%A9l%C3%A9phones&brand=Apple&model=iPhone%2012")).json as { listings: { comparedTo: { scope: string; text: string }; status: string } };
    assert.equal(bare.listings.status, "published");
    assert.deepEqual(bare.listings.comparedTo, { scope: "exact", text: "Comparé à : iPhone 12, toutes variantes et tous états confondus" });
  });

  test("pas assez de données : « insufficient » sans aucun chiffre", async () => {
    const answer = await market(viewer.cookie);
    assert.deepEqual((answer.json as Json).listings, { status: "insufficient" });
  });

  test("de bout en bout : cinq annonces publiées par cinq vendeurs (déclencheur) donnent un prix de marché publié ; cinq annonces de trois vendeurs, non", async () => {
    const { sellers } = await makeActors(pool, 5, 0);
    for (const [index, price] of [150_000, 152_300, 160_249, 165_000, 170_000].entries()) {
      await createOffer({
        ownerId: sellers[index].id, rawText: "Annonce iPhone 12", category: "Téléphones", brand: "Apple", model: "iPhone 12", variant: "128 Go", condition: "Occasion",
        price: { amount: price, currency: "XOF" }, status: "published", availabilityStatus: "available",
      }, pool);
    }
    const listings = ((await market(viewer.cookie)).json as { listings: { status: string; median: number; range: unknown; count: unknown; excluded: unknown } }).listings;
    // prix arrondis : 150 000, 152 500, 160 000, 165 000, 170 000 → médiane 160 000 ; cinq vendeurs : pas de fourchette ; aucun vendeur aux prix atypiques.
    assert.deepEqual([listings.status, listings.median, listings.range, listings.excluded], ["published", 160_000, null, null]);
    assert.deepEqual(listings.count, { kind: "approx", value: 5 });
    // Les mêmes prix publiés par TROIS vendeurs (ou par un seul, quarante annonces) ne donnent plus rien : l'unité est le vendeur.
    await resetObservations(pool);
    const few = await makeActors(pool, 3, 0);
    for (const [index, price] of [150_000, 152_300, 160_249, 165_000, 170_000].entries()) {
      await createOffer({
        ownerId: few.sellers[index % 3].id, rawText: "Annonce iPhone 12", category: "Téléphones", brand: "Apple", model: "iPhone 12", variant: "128 Go", condition: "Occasion",
        price: { amount: price, currency: "XOF" }, status: "published", availabilityStatus: "available",
      }, pool);
    }
    assert.deepEqual(((await market(viewer.cookie)).json as Json).listings, { status: "insufficient" }, "cinq annonces de trois vendeurs");
    for (let index = 0; index < 40; index += 1) {
      await createOffer({
        ownerId: few.sellers[0].id, rawText: "Annonce iPhone 12", category: "Téléphones", brand: "Apple", model: "iPhone 12", variant: "128 Go", condition: "Occasion",
        price: { amount: 120_000 + index * 500, currency: "XOF" }, status: "published", availabilityStatus: "available",
      }, pool);
    }
    assert.deepEqual(((await market(viewer.cookie)).json as Json).listings, { status: "insufficient" }, "quarante annonces de plus d'un seul vendeur ne font toujours que trois vendeurs");
  });
});

describe("paramètres : liste blanche", () => {
  const refused: Array<[string, string]> = [
    ["catégorie absente", "?brand=Apple&model=iPhone%2012"],
    ["marque absente", "?category=T%C3%A9l%C3%A9phones&model=iPhone%2012"],
    ["modèle absent", "?category=T%C3%A9l%C3%A9phones&brand=Apple"],
    ["aucun paramètre", ""],
    ["valeur vide", "?category=&brand=Apple&model=iPhone%2012"],
    ["valeur d'espaces", "?category=T%C3%A9l%C3%A9phones&brand=%20%20&model=iPhone%2012"],
    ["variante vide", `${QUERY}&variant=`],
    ["paramètre inconnu", `${QUERY}&seller=1`],
    ["paramètre de débogage", `${QUERY}&debug=1`],
    ["clé en majuscules", `${QUERY}&PERIOD=30`],
    ["paramètre répété", `${QUERY}&model=iPhone%2013`],
    ["période répétée", `${QUERY}&period=30&period=90`],
    ["période 7", `${QUERY}&period=7`],
    ["période 0", `${QUERY}&period=0`],
    ["période zéro devant", `${QUERY}&period=090`],
    ["période texte", `${QUERY}&period=abc`],
    ["période décimale", `${QUERY}&period=30.0`],
    ["période vide", `${QUERY}&period=`],
    ["valeur de 81 caractères", `?category=T%C3%A9l%C3%A9phones&brand=Apple&model=${"a".repeat(81)}`],
    ["caractère de contrôle", "?category=T%C3%A9l%C3%A9phones&brand=Apple&model=iPhone%0712"],
    ["caractère de direction de texte", "?category=T%C3%A9l%C3%A9phones&brand=Apple&model=iPhone%E2%80%AE12"],
    ["numéro de téléphone dans le modèle", "?category=T%C3%A9l%C3%A9phones&brand=Apple&model=07%2007%2000%2000%2001%2001"],
    ["numéro de téléphone dans la variante", `${QUERY.replace("128%20Go", "0707070707")}`],
  ];
  for (const [name, query] of refused) {
    test(`refusé (400, rien n'est lu) : ${name}`, async () => {
      let reads = 0;
      const counting = createMarketHttpHandlers({ pool, env: { NOMA_AUTH_ORIGIN: "https://noma.test" }, log: () => {}, rateLimiter: createMarketRateLimiter(), readStats: async () => { reads += 1; throw new Error("ne doit pas être lu"); } });
      const answer = await market(viewer.cookie, query, counting);
      assert.equal(answer.status, 400);
      assert.deepEqual(answer.json, { error: { code: "invalid_request", message: "Requête invalide." } });
      assert.equal(reads, 0);
    });
  }

  test("acceptés : 80 caractères exactement, espaces réduits, accents ; l'analyse rend la requête normalisée", () => {
    const parsed = parseMarketQuery(new Request(`https://noma.test/api/market?category=T%C3%A9l%C3%A9phones&brand=%20Apple%20&model=${"a".repeat(80)}&variant=128%20%20Go&period=365`));
    assert.deepEqual(parsed, { category: "Téléphones", brand: "Apple", model: "a".repeat(80), variant: "128 Go", condition: null, periodDays: 365 });
    assert.equal(parseMarketQuery(new Request("https://noma.test/api/market?category=a&brand=b&model=c"))?.periodDays, 90);
  });
});

describe("limite de débit : 60 lectures par minute et par utilisateur", () => {
  test("la 61e lecture est refusée (429, retry-after, texte fixe, no-store) ; un autre utilisateur n'est pas touché ; les lectures invalides comptent aussi", async () => {
    const limited = createMarketHttpHandlers({ pool, env: { NOMA_AUTH_ORIGIN: "https://noma.test" }, log: () => {}, rateLimiter: createMarketRateLimiter() });
    for (let index = 0; index < 60; index += 1) {
      const answer = await market(viewer.cookie, index % 2 === 0 ? QUERY : "?unknown=1", limited);
      assert.equal(answer.status, index % 2 === 0 ? 200 : 400, `lecture ${index + 1}`);
    }
    const refused = await market(viewer.cookie, QUERY, limited);
    assert.equal(refused.status, 429);
    assert.deepEqual(refused.json, { error: { code: "rate_limited", message: "Trop de demandes de prix du marché en peu de temps : réessayez dans une minute." } });
    const retry = Number(refused.headers.get("retry-after"));
    assert.ok(Number.isInteger(retry) && retry >= 1 && retry <= 60, `retry-after ${retry}`);
    assert.equal((await market(boss.cookie, QUERY, limited)).status, 200, "un autre utilisateur");
  });

  test("le gestionnaire par défaut (sans limiteur injecté) applique aussi la limite du processus", async () => {
    const standalone = createMarketHttpHandlers({ pool, env: { NOMA_AUTH_ORIGIN: "https://noma.test" }, log: () => {} });
    const fresh = await login(pool);
    for (let index = 0; index < 60; index += 1) assert.equal((await market(fresh.cookie, QUERY, standalone)).status, 200, `lecture ${index + 1}`);
    assert.equal((await market(fresh.cookie, QUERY, standalone)).status, 429);
  });
});

describe("erreurs : texte fixe, jamais la cause", () => {
  test("une lecture qui échoue : 503 `market_unavailable`, seul un code est journalisé ; une période refusée par la lecture : 400", async () => {
    const failing = (error: Error) => createMarketHttpHandlers({ pool, env: { NOMA_AUTH_ORIGIN: "https://noma.test" }, log: (code) => void logged.push(code), rateLimiter: createMarketRateLimiter(), readStats: async () => { throw error; } });
    const secret = new Error("password=hunter2 host=10.0.0.5");
    const answer = await market(viewer.cookie, QUERY, failing(secret));
    assert.equal(answer.status, 503);
    assert.deepEqual(answer.json, { error: { code: "market_unavailable", message: "Le service est temporairement indisponible." } });
    assert.ok(!answer.text.includes("hunter2") && !answer.text.includes("10.0.0.5"));
    assert.deepEqual(logged, ["unexpected_error"]);
    const invalid = await market(viewer.cookie, QUERY, failing(new MarketError("invalid_query", "période invalide.")));
    assert.equal(invalid.status, 400);
    assert.deepEqual(invalid.json, { error: { code: "invalid_request", message: "Requête invalide." } });
  });
});

describe("administration : tableau « Marché »", () => {
  const get = (cookie: string | null, query = "") => admin.market(request("GET", "/api/admin/market", { cookie, query })).then(reply);

  test("le même 404 pour un visiteur et un compte ordinaire ; l'administrateur lit le tableau : prix demandés (mêmes seuils) et NOMBRE arrondi de ventes confirmées, jamais un prix de vente, aucun identifiant", async () => {
    const { sellerIds, buyerIds } = await knownWorld();
    const unknown = await get(null);
    assert.equal(unknown.status, 404);
    assert.deepEqual(unknown.json, NOT_FOUND);
    assert.equal((await get(viewer.cookie)).text, unknown.text, "indiscernable d'un compte ordinaire");
    const answer = await get(boss.cookie);
    assert.equal(answer.status, 200);
    const body = answer.json as { contractVersion: string; currency: string; roundingXof: number; period: Json; rows: Array<Json> };
    assert.deepEqual(Object.keys(body).sort(), ["contractVersion", "currency", "period", "roundingXof", "rows"]);
    assert.equal(body.contractVersion, "market-admin/v3");
    assert.ok(body.rows.length >= 1);
    for (const row of body.rows) assert.deepEqual(Object.keys(row).sort(), ["confirmedSales", "label", "listings"]);
    const top = body.rows.find((row) => row.label === "Apple iPhone 12");
    assert.ok(top, "le produit de référence figure au tableau");
    assert.equal((top?.listings as Json).status, "published");
    assert.deepEqual(top?.confirmedSales, { kind: "approx", value: 5 }, "7 ventes confirmées → environ 5");
    for (const secret of [...sellerIds, ...buyerIds, ...SALE_PRICES.map(String)]) assert.equal(answer.text.includes(secret), false, secret);
    assert.equal((await get(boss.cookie, "?x=1")).status, 400, "aucun paramètre admis");
  });

  test("un administrateur suspendu et un compte ordinaire ne lisent JAMAIS les ventes confirmées : le même 404", async () => {
    await knownWorld();
    const ordinary = await get(viewer.cookie);
    assert.equal(ordinary.status, 404);
    assert.ok(!ordinary.text.includes("confirmedSales"));
    await pool.query("UPDATE users SET status = 'suspended' WHERE id = $1", [boss.userId]);
    try {
      const suspended = await get(boss.cookie);
      assert.equal(suspended.status, 404);
      assert.equal(suspended.text, ordinary.text);
    } finally {
      await pool.query("UPDATE users SET status = 'active' WHERE id = $1", [boss.userId]);
    }
  });
});
