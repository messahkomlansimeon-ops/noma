import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";
import type { Pool } from "pg";
import { accentNormalize } from "../../poc/lib/need";
import { archiveOffer, createOffer, pauseOffer, publishOffer, updateOffer, type OfferRecord } from "../../lib/server/catalog";
import { MarketError, readAdminMarket, readListingObservations, readMarketStats } from "../../lib/server/market/reads";
import { computeMarketStats, type MarketObservation } from "../../lib/server/market/stats";
import { isMarketMigrationRegistered, observeListingsBatch, observeListingsForDay, runMarketStep } from "../../lib/server/market/observe";
import { runMatchingCycle } from "../../lib/server/matching/runner";
import { createSocialHttpHandlers, type SocialHttpHandlers } from "../../lib/server/social/http";
import { MARKET_NOW, MARKET_TODAY, dayBefore, insertObservation, makeActors, resetObservations } from "./market-fixtures";
import { makePerson } from "./metrics-fixtures";
import { count, makeMarket, openTestSchema, reply, request, resetSocial, type TestSchema } from "./social-fixtures";
import { createTemporarySchemaName, openVerifiedIsolatedPool, quoteTemporarySchema } from "./test-database";

/**
 * Historique des prix et statistiques de marché (lots H1, H1-bis et H1-ter), avec PostgreSQL : clé normalisée (la fonction de la base égale celle du matching), contraintes de la table, observation du
 * prix affiché (déclencheur : publication, changement de prix ; jamais un brouillon, une annonce en pause, indisponible, hors XOF…), vente observée à la CONFIRMATION seulement, relevé
 * quotidien (idempotent, rattrapage borné à 7 jours, jamais d'historique inventé, sans la migration 0023 : ignoré sans erreur, isolé des autres étapes), statistiques lues sur un jeu
 * connu, tableau d'administration. Voir HISTORIQUE-PRIX.md.
 */

let env: TestSchema;
let pool: Pool;

before(async () => {
  env = await openTestSchema();
  pool = env.pool;
});

after(async () => {
  await env.close();
});

beforeEach(async () => {
  await resetSocial(pool);
  await resetObservations(pool);
});

const dbToday = async (): Promise<string> => (await pool.query<{ d: string }>("SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS d")).rows[0].d;
const observationsOf = async (referenceId: string) =>
  (await pool.query<{ day: string; price: string; source: string; seller_id: string | null; buyer_id: string | null; category_key: string; brand_key: string; model_key: string; variant_key: string; condition_key: string; label: string }>(
    `SELECT to_char(observed_on, 'YYYY-MM-DD') AS day, price_xof::text AS price, source, seller_id, buyer_id, category_key, brand_key, model_key, variant_key, condition_key, label
       FROM price_observations WHERE reference_id = $1::uuid ORDER BY observed_on, source`,
    [referenceId],
  )).rows;

async function publishedOffer(ownerId: string, overrides: Partial<Parameters<typeof createOffer>[0]> = {}): Promise<OfferRecord> {
  return createOffer(
    {
      ownerId, rawText: "Annonce iPhone 12", category: "Téléphones", brand: "Apple", model: "iPhone 12", variant: "128 Go", condition: "Occasion",
      price: { amount: 160_000, currency: "XOF" }, status: "published", availabilityStatus: "available", ...overrides,
    },
    pool,
  );
}

// ═════════════ clé normalisée ═════════════

describe("clé produit normalisée", () => {
  test("price_key_part égale accentNormalize du matching sur des textes réels (accents, casse, espaces simples, insécables) ; idempotente ; NULL → texte vide", async () => {
    const corpus = [
      "Téléphones", "  iPhone   12 ", "MacBook Air M1", "Réfrigérateur 2 portes", "ÉLECTRONIQUE", "Maison et meubles", "Çà et là ÿ", "Machine à laver LG 8 kg", "Canapé 3 places",
      "a b c　d", "tab\tet\nretour", "ÀÂÄÉÈÊËÎÏÔÖÙÛÜŸÇ", "Reconditionné", "Climatiseur LG Split 1,5 CV", "8 Go · 256 Go", "",
    ];
    for (const text of corpus) {
      const key = (await pool.query<{ k: string }>("SELECT price_key_part($1) AS k", [text])).rows[0].k;
      assert.equal(key, accentNormalize(text), JSON.stringify(text));
      assert.equal((await pool.query<{ k: string }>("SELECT price_key_part(price_key_part($1)) AS k", [text])).rows[0].k, key, "idempotente");
    }
    assert.equal((await pool.query<{ k: string }>("SELECT price_key_part(NULL) AS k")).rows[0].k, "");
  });
});

// ═════════════ table ═════════════

describe("table price_observations : contraintes", () => {
  const bad = (text: string, values: unknown[], code: string) =>
    assert.rejects(() => pool.query(text, values), (error: { code?: string }) => error.code === code, text.slice(0, 90));
  const base = `INSERT INTO price_observations (source, reference_id, observed_on, category_key, brand_key, model_key, variant_key, condition_key, label, price_xof, seller_id, buyer_id)`;

  test("source, clés normalisées, libellé, prix de 1 à 100 000 000, pas d'acheteur sur une annonce, unicité (source, référence, jour)", async () => {
    const [seller] = (await makeActors(pool, 1, 0)).sellers;
    const reference = "11111111-1111-4111-8111-111111111111";
    const ok = [reference, seller.id];
    await pool.query(`${base} VALUES ('listing', $1, DATE '2030-06-15', 'telephones', 'apple', 'iphone 12', '', '', 'Apple iPhone 12', 150000, $2, NULL)`, ok);
    await bad(`${base} VALUES ('listing', $1, DATE '2030-06-15', 'telephones', 'apple', 'iphone 12', '', '', 'x', 150000, $2, NULL)`, ok, "23505"); // même (source, annonce, jour)
    await pool.query(`${base} VALUES ('listing', $1, DATE '2030-06-16', 'telephones', 'apple', 'iphone 12', '', '', 'x', 150000, $2, NULL)`, ok); // un autre jour
    await pool.query(`${base} VALUES ('sale', $1, DATE '2030-06-15', 'telephones', 'apple', 'iphone 12', '', '', 'x', 150000, $2, $2)`, ok); // une autre source
    const other = "22222222-2222-4222-8222-222222222222";
    await bad(`${base} VALUES ('auction', $1, DATE '2030-06-15', 'telephones', 'apple', 'iphone 12', '', '', 'x', 1, $2, NULL)`, [other, seller.id], "23514");
    await bad(`${base} VALUES ('listing', $1, DATE '2030-06-15', 'Telephones', 'apple', 'iphone 12', '', '', 'x', 1, $2, NULL)`, [other, seller.id], "23514"); // clé non normalisée
    await bad(`${base} VALUES ('listing', $1, DATE '2030-06-15', 'telephones', 'apple ', 'iphone 12', '', '', 'x', 1, $2, NULL)`, [other, seller.id], "23514");
    await bad(`${base} VALUES ('listing', $1, DATE '2030-06-15', '', 'apple', 'iphone 12', '', '', 'x', 1, $2, NULL)`, [other, seller.id], "23514"); // catégorie vide
    await bad(`${base} VALUES ('listing', $1, DATE '2030-06-15', 'telephones', '', 'iphone 12', '', '', 'x', 1, $2, NULL)`, [other, seller.id], "23514");
    await bad(`${base} VALUES ('listing', $1, DATE '2030-06-15', 'telephones', 'apple', '', '', '', 'x', 1, $2, NULL)`, [other, seller.id], "23514");
    await bad(`${base} VALUES ('listing', $1, DATE '2030-06-15', 'telephones', 'apple', 'iphone 12', 'Go', '', 'x', 1, $2, NULL)`, [other, seller.id], "23514");
    await bad(`${base} VALUES ('listing', $1, DATE '2030-06-15', 'telephones', 'apple', 'iphone 12', '', '', '', 1, $2, NULL)`, [other, seller.id], "23514"); // libellé vide
    await bad(`${base} VALUES ('listing', $1, DATE '2030-06-15', 'telephones', 'apple', 'iphone 12', '', '', $3, 1, $2, NULL)`, [other, seller.id, "x".repeat(201)], "23514");
    await bad(`${base} VALUES ('listing', $1, DATE '2030-06-15', 'telephones', 'apple', 'iphone 12', '', '', 'x', 0, $2, NULL)`, [other, seller.id], "23514");
    await bad(`${base} VALUES ('listing', $1, DATE '2030-06-15', 'telephones', 'apple', 'iphone 12', '', '', 'x', 100000001, $2, NULL)`, [other, seller.id], "23514");
    await pool.query(`${base} VALUES ('listing', $1, DATE '2030-06-15', 'telephones', 'apple', 'iphone 12', '', '', 'x', 100000000, $2, NULL)`, [other, seller.id]);
    await bad(`${base} VALUES ('listing', $1, DATE '2030-06-14', 'telephones', 'apple', 'iphone 12', '', '', 'x', 5, $2, $2)`, [other, seller.id], "23514"); // un acheteur sur une annonce
    await bad(`${base} VALUES ('listing', $1, DATE '2030-06-14', 'telephones', 'apple', 'iphone 12', '', '', 'x', 5, $2, NULL)`, ["pas-un-uuid", seller.id], "22P02");
  });

  test("un compte supprimé : le prix reste, le lien avec le compte aussi disparaît (SET NULL) ; aucune clé étrangère sur la référence (un relevé survit à la ligne qui l'a produit)", async () => {
    const [seller] = (await makeActors(pool, 1, 0)).sellers;
    const reference = await insertObservation(pool, { day: 0, price: 150_000, sellerId: seller.id });
    await pool.query("DELETE FROM users WHERE id = $1", [seller.id]);
    const [row] = await observationsOf(reference);
    assert.equal(row.seller_id, null);
    assert.equal(row.price, "150000");
    const foreignKeys = (await pool.query<{ column_name: string }>(
      `SELECT a.attname AS column_name FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
        WHERE c.contype = 'f' AND c.conrelid = 'price_observations'::regclass ORDER BY 1`,
    )).rows.map((entry) => entry.column_name);
    assert.deepEqual(foreignKeys, ["buyer_id", "seller_id"]);
  });
});

// ═════════════ observation du prix affiché ═════════════

describe("annonces : le déclencheur observe le prix affiché", () => {
  test("une annonce créée PUBLIÉE est observée aujourd'hui (clés normalisées, libellé du vendeur, vendeur, jamais d'acheteur) ; un brouillon, non", async () => {
    const seller = await makePerson(pool);
    const draft = await publishedOffer(seller.id, { status: "draft" });
    assert.deepEqual(await observationsOf(draft.id), []);
    const offer = await publishedOffer(seller.id, { category: "Téléphones", brand: " Apple ", model: "iPhone  12", variant: "128 Go", condition: "Occasion" });
    const today = await dbToday();
    assert.deepEqual(await observationsOf(offer.id), [
      {
        day: today, price: "160000", source: "listing", seller_id: seller.id, buyer_id: null, category_key: "telephones", brand_key: "apple", model_key: "iphone 12",
        variant_key: "128 go", condition_key: "occasion", label: "Apple iPhone  12 · 128 Go · Occasion",
      },
    ]);
  });

  test("la publication d'un brouillon, la remise en ligne d'une annonce en pause : une observation ; la mise en pause : aucune nouvelle ligne", async () => {
    const seller = await makePerson(pool);
    const offer = await publishedOffer(seller.id, { status: "draft" });
    const published = await publishOffer(seller.id, offer.id, offer.contentVersion, pool);
    assert.equal((await observationsOf(offer.id)).length, 1, "publication");
    const paused = await pauseOffer(seller.id, offer.id, published.contentVersion, pool);
    assert.equal((await observationsOf(offer.id)).length, 1, "la pause n'écrit rien");
    await pool.query("UPDATE price_observations SET observed_on = observed_on - 2 WHERE reference_id = $1", [offer.id]);
    await publishOffer(seller.id, offer.id, paused.contentVersion, pool);
    const rows = await observationsOf(offer.id);
    assert.equal(rows.length, 2, "remise en ligne : la ligne du jour s'ajoute");
    assert.equal(rows[1].day, await dbToday());
  });

  test("changement de prix : la ligne du JOUR prend le dernier prix (une seule ligne par jour) ; un autre jour, une nouvelle ligne ; l'historique garde chaque prix", async () => {
    const seller = await makePerson(pool);
    const offer = await publishedOffer(seller.id);
    const first = await updateOffer({ id: offer.id, ownerId: seller.id, expectedContentVersion: offer.contentVersion, changes: { price: { amount: 150_000, currency: "XOF" } } }, pool);
    assert.deepEqual((await observationsOf(offer.id)).map((row) => row.price), ["150000"], "même jour : remplacée, pas dupliquée");
    await pool.query("UPDATE price_observations SET observed_on = observed_on - 1 WHERE reference_id = $1", [offer.id]);
    await updateOffer({ id: offer.id, ownerId: seller.id, expectedContentVersion: first.contentVersion, changes: { price: { amount: 140_000, currency: "XOF" } } }, pool);
    const rows = await observationsOf(offer.id);
    assert.deepEqual(rows.map((row) => row.price), ["150000", "140000"], "hier 150 000, aujourd'hui 140 000");
    assert.notEqual(rows[0].day, rows[1].day);
  });

  test("une modification qui ne touche ni le prix, ni l'état de publication, ni la clé produit n'écrit rien (description, localisation)", async () => {
    const seller = await makePerson(pool);
    const offer = await publishedOffer(seller.id);
    const before = await pool.query("SELECT id, created_at FROM price_observations WHERE reference_id = $1", [offer.id]);
    await updateOffer({ id: offer.id, ownerId: seller.id, expectedContentVersion: offer.contentVersion, changes: { rawText: "Nouvelle description", location: "Cocody" } }, pool);
    const after = await pool.query("SELECT id, created_at FROM price_observations WHERE reference_id = $1", [offer.id]);
    assert.deepEqual(after.rows, before.rows, "la ligne n'a pas bougé");
  });

  test("un changement d'état ou de variante réécrit la clé de la ligne du jour (même jour, même annonce)", async () => {
    const seller = await makePerson(pool);
    const offer = await publishedOffer(seller.id);
    await updateOffer({ id: offer.id, ownerId: seller.id, expectedContentVersion: offer.contentVersion, changes: { condition: "Neuf", variant: "256 Go" } }, pool);
    const [row] = await observationsOf(offer.id);
    assert.deepEqual([row.variant_key, row.condition_key, row.label], ["256 go", "neuf", "Apple iPhone 12 · 256 Go · Neuf"]);
  });

  test("jamais observée : indisponible, hors XOF, prix nul ou supérieur à 100 000 000, sans catégorie, marque ou modèle, propriétaire suspendu, annonce archivée", async () => {
    const seller = await makePerson(pool);
    const cases: Array<[string, Partial<Parameters<typeof createOffer>[0]>]> = [
      ["indisponible", { availabilityStatus: "unavailable" }],
      ["en euros", { price: { amount: 1_500, currency: "EUR" } }],
      ["prix nul", { price: { amount: 0, currency: "XOF" } }],
      ["trop cher", { price: { amount: 100_000_001, currency: "XOF" } }],
      ["sans prix", { price: null }],
      ["sans catégorie", { category: null }],
      ["sans marque", { brand: null }],
      ["sans modèle", { model: "   " as never }],
    ];
    for (const [name, overrides] of cases) {
      const offer = await publishedOffer(seller.id, overrides);
      assert.deepEqual(await observationsOf(offer.id), [], name);
    }
    const suspended = await makePerson(pool);
    await pool.query("UPDATE users SET status = 'suspended' WHERE id = $1", [suspended.id]);
    assert.deepEqual(await observationsOf((await publishedOffer(suspended.id)).id), [], "propriétaire suspendu");
    const toArchive = await publishedOffer(seller.id);
    await pool.query("DELETE FROM price_observations WHERE reference_id = $1", [toArchive.id]);
    await archiveOffer(seller.id, toArchive.id, toArchive.contentVersion, pool);
    assert.deepEqual(await observationsOf(toArchive.id), [], "annonce archivée");
    assert.equal(await count(pool, "price_observations"), 0);
  });
});

// ═════════════ ventes ═════════════

describe("ventes : observées à la CONFIRMATION, jamais avant", () => {
  let handlers: SocialHttpHandlers;
  before(() => {
    handlers = createSocialHttpHandlers({ pool, env: { NOMA_AUTH_ORIGIN: "https://noma.test" }, log: () => {} });
  });
  const declare = async (m: Awaited<ReturnType<typeof makeMarket>>, price: number) =>
    reply(await handlers.orders.declare(request("POST", `/api/demands/${m.demand.id}/offers/${m.offer.id}/orders`, { cookie: m.buyer.cookie, body: { priceXof: price } }), m.demand.id, m.offer.id));
  const act = async (orderId: string, action: string, cookie: string) => reply(await handlers.orders.act(request("POST", `/api/orders/${orderId}/${action}`, { cookie, body: {} }), orderId, action));
  const salesCount = async (): Promise<number> => count(pool, "price_observations", "source = 'sale'");

  test("déclarée : aucune vente ; confirmée : UNE vente (prix convenu, jour UTC de la décision, vendeur, acheteur, clés de l'annonce) ; une seconde confirmation est refusée et n'ajoute rien", async () => {
    const m = await makeMarket(pool);
    const declared = await declare(m, 230_000);
    assert.equal(declared.status, 201);
    const orderId = (declared.json as { order: { id: string } }).order.id;
    assert.equal(await salesCount(), 0, "proposée : rien");
    const confirmed = await act(orderId, "confirm", m.seller.cookie);
    assert.equal(confirmed.status, 200);
    const [sale] = await observationsOf(orderId);
    const decided = (await pool.query<{ day: string }>("SELECT to_char(decided_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day FROM orders WHERE id = $1", [orderId])).rows[0].day;
    assert.deepEqual(sale, {
      day: decided, price: "230000", source: "sale", seller_id: m.seller.userId, buyer_id: m.buyer.userId, category_key: "smartphones", brand_key: "apple", model_key: "iphone 13",
      variant_key: "128 go", condition_key: "good", label: "Apple iPhone 13 · 128 Go · good",
    });
    assert.equal((await act(orderId, "confirm", m.seller.cookie)).status, 409);
    assert.equal(await salesCount(), 1, "toujours une seule vente");
  });

  test("refusée ou annulée : aucune vente ; la commande suivante confirmée en écrit une, avec son propre prix", async () => {
    const m = await makeMarket(pool);
    const first = (await declare(m, 200_000)).json as { order: { id: string } };
    assert.equal((await act(first.order.id, "decline", m.seller.cookie)).status, 200);
    const second = (await declare(m, 210_000)).json as { order: { id: string } };
    assert.equal((await act(second.order.id, "cancel", m.buyer.cookie)).status, 200);
    assert.equal(await salesCount(), 0);
    const third = (await declare(m, 220_000)).json as { order: { id: string } };
    assert.equal(await salesCount(), 0, "proposée");
    assert.equal((await act(third.order.id, "confirm", m.seller.cookie)).status, 200);
    assert.deepEqual((await observationsOf(third.order.id)).map((row) => row.price), ["220000"]);
    assert.equal(await salesCount(), 1);
  });

  test("la vente est écrite DANS la transaction de la confirmation : une confirmation annulée n'en laisse aucune", async () => {
    const m = await makeMarket(pool);
    const orderId = ((await declare(m, 230_000)).json as { order: { id: string } }).order.id;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("UPDATE orders SET status = 'confirmed', decided_at = clock_timestamp(), updated_at = clock_timestamp() WHERE id = $1", [orderId]);
      assert.equal((await client.query("SELECT 1 FROM price_observations WHERE source = 'sale'")).rowCount, 1, "visible dans la transaction");
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
    assert.equal(await salesCount(), 0, "annulée avec la transaction");
    assert.equal((await pool.query("SELECT status FROM orders WHERE id = $1", [orderId])).rows[0].status, "proposed");
  });
});

// ═════════════ relevé quotidien ═════════════

describe("relevé quotidien des prix affichés", () => {
  test("une annonce observable sans relevé du jour reçoit UNE ligne ; rejouer ne change rien (idempotent) ; les annonces non observables sont ignorées", async () => {
    const seller = await makePerson(pool);
    const [a, b] = [await publishedOffer(seller.id), await publishedOffer(seller.id, { price: { amount: 170_000, currency: "XOF" } })];
    const ignored = [await publishedOffer(seller.id, { status: "draft" }), await publishedOffer(seller.id, { availabilityStatus: "unavailable" })];
    await resetObservations(pool);
    const today = await dbToday();
    assert.deepEqual(await observeListingsForDay(pool, { day: today }), { observed: 2 });
    assert.deepEqual(await observeListingsForDay(pool, { day: today }), { observed: 0 }, "rejouer : rien");
    assert.deepEqual((await observationsOf(a.id)).map((row) => row.price), ["160000"]);
    assert.deepEqual((await observationsOf(b.id)).map((row) => row.price), ["170000"]);
    for (const offer of ignored) assert.deepEqual(await observationsOf(offer.id), []);
    assert.equal(await count(pool, "price_observations"), 2);
  });

  test("deux relevés SIMULTANÉS du même jour : le second attend le premier puis n'écrit rien (une seule ligne par annonce et par jour, jamais une erreur d'unicité)", async () => {
    const seller = await makePerson(pool);
    const offer = await publishedOffer(seller.id);
    await resetObservations(pool);
    const today = await dbToday();
    const first = await pool.connect();
    const second = await pool.connect();
    try {
      await first.query("BEGIN");
      const written = await observeListingsBatch(first, { day: today });
      assert.equal(written.observed, 1, "le premier relevé écrit (pas encore validé)");
      // Le second relevé lit la base AVANT la validation du premier : il tente les mêmes lignes et doit attendre, puis se résigner.
      const pending = observeListingsBatch(second, { day: today });
      await new Promise((resolve) => setTimeout(resolve, 400));
      await first.query("COMMIT");
      const lost = await pending;
      assert.equal(lost.observed, 0, "le second relevé n'ajoute rien");
    } finally {
      await first.query("ROLLBACK").catch(() => {});
      first.release();
      second.release();
    }
    assert.equal((await observationsOf(offer.id)).length, 1);
  });

  test("pagination : des lots de 2 couvrent toutes les annonces, une fois chacune", async () => {
    const seller = await makePerson(pool);
    const offers: OfferRecord[] = [];
    for (let index = 0; index < 7; index += 1) offers.push(await publishedOffer(seller.id, { price: { amount: 100_000 + index * 1000, currency: "XOF" } }));
    await resetObservations(pool);
    const today = await dbToday();
    assert.deepEqual(await observeListingsForDay(pool, { day: today, batchSize: 2 }), { observed: 7 });
    for (const offer of offers) assert.equal((await observationsOf(offer.id)).length, 1);
    let afterId: string | undefined;
    let scanned = 0;
    for (;;) {
      const batch = await observeListingsBatch(pool, { day: today, afterId, batchSize: 3 });
      scanned += batch.scanned;
      if (batch.scanned < 3 || batch.lastId === null) break;
      afterId = batch.lastId;
    }
    assert.equal(scanned, 7, "chaque annonce publiée lue une fois");
  });

  test("AUCUN rattrapage : un trou dans l'historique reste un trou ; le relevé n'écrit que le jour courant, jamais un jour fantôme (annonce suspendue puis remise en ligne comprise)", async () => {
    const seller = await makePerson(pool);
    const offer = await publishedOffer(seller.id);
    const today = await dbToday();
    // Dernière observation il y a 5 jours : aujourd'hui seulement s'ajoute, les quatre jours entre les deux restent un trou.
    await pool.query("UPDATE price_observations SET observed_on = observed_on - 5 WHERE reference_id = $1", [offer.id]);
    assert.deepEqual(await observeListingsForDay(pool, { day: today }), { observed: 1 });
    assert.deepEqual((await observationsOf(offer.id)).map((row) => row.day), [dayBefore(5, today), today]);
    // Une annonce jamais observée : seulement aujourd'hui.
    await pool.query("DELETE FROM price_observations WHERE reference_id = $1", [offer.id]);
    assert.deepEqual(await observeListingsForDay(pool, { day: today }), { observed: 1 });
    assert.deepEqual((await observationsOf(offer.id)).map((row) => row.day), [today]);
    // Suspendue puis remise en ligne : pendant la suspension, aucun relevé ; à la remise en ligne, le déclencheur écrit LE JOUR de la remise en ligne, pas ceux d'avant.
    await pool.query("UPDATE price_observations SET observed_on = observed_on - 10 WHERE reference_id = $1", [offer.id]);
    const current = (await pool.query<{ content_version: number }>("SELECT content_version FROM offers WHERE id = $1", [offer.id])).rows[0].content_version;
    const paused = await pauseOffer(seller.id, offer.id, current, pool);
    await publishOffer(seller.id, offer.id, paused.contentVersion, pool);
    assert.deepEqual((await observationsOf(offer.id)).map((row) => row.day), [dayBefore(10, today), today], "aucun jour fantôme entre les deux");
  });

  test("runMarketStep : écrit le jour, le consigne, ne recommence pas ; un autre jour (horloge réglée) n'écrit que CE jour, sans jours intermédiaires", async () => {
    const seller = await makePerson(pool);
    const offer = await publishedOffer(seller.id);
    await resetObservations(pool);
    const today = await dbToday();
    const first = await runMarketStep({ pool });
    assert.deepEqual(first, { observed: 1, skipped: false, alreadyDone: false });
    assert.equal((await pool.query("SELECT observed FROM price_observation_runs WHERE day = $1::date", [today])).rows[0].observed, 1);
    assert.deepEqual(await runMarketStep({ pool }), { observed: 0, skipped: false, alreadyDone: true });
    const later = new Date(Date.parse(`${today}T10:00:00Z`) + 3 * 86_400_000);
    assert.deepEqual(await runMarketStep({ pool, now: later }), { observed: 1, skipped: false, alreadyDone: false });
    assert.deepEqual((await observationsOf(offer.id)).map((row) => row.day), [today, dayBefore(-3, today)], "les deux jours intermédiaires restent un trou");
    assert.ok((await observationsOf(offer.id)).every((row) => row.price === "160000"));
  });

  test("sans la migration 0023 enregistrée : ignoré sans erreur (isMarketMigrationRegistered faux), le cycle du worker n'en est pas gêné", async () => {
    const row = (await pool.query("SELECT * FROM noma_schema_migrations WHERE version = '0023_price_observations'")).rows[0];
    await pool.query("DELETE FROM noma_schema_migrations WHERE version = '0023_price_observations'");
    try {
      assert.equal(await isMarketMigrationRegistered(pool), false);
      assert.deepEqual(await runMarketStep({ pool }), { observed: 0, skipped: true, alreadyDone: false });
      const cycle = await runMatchingCycle({ pool, workerId: "market-test", notificationTransport: null });
      assert.equal(cycle.market.skipped, true);
      assert.deepEqual(cycle.errors, []);
    } finally {
      await pool.query("INSERT INTO noma_schema_migrations (version, checksum, applied_at) VALUES ($1, $2, $3)", [row.version, row.checksum, row.applied_at]);
    }
    assert.equal(await isMarketMigrationRegistered(pool), true);
  });

  test("une base d'AVANT la 0023 (migrations 0001 à 0022 seulement, table absente) : le cycle du worker n'a aucune erreur et l'étape est ignorée", async () => {
    const schema = createTemporarySchemaName();
    const quoted = quoteTemporarySchema(schema);
    await env.admin.query(`CREATE SCHEMA ${quoted}`);
    const old = await openVerifiedIsolatedPool(env.target, schema);
    try {
      const directory = join(process.cwd(), "database", "migrations");
      const files = readdirSync(directory).filter((name) => /^\d{4}_.*\.sql$/.test(name) && name < "0023_").sort();
      assert.equal(files.length, 22);
      await old.query("CREATE TABLE noma_schema_migrations (version TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP)");
      for (const name of files) {
        await old.query(readFileSync(join(directory, name), "utf8"));
        await old.query("INSERT INTO noma_schema_migrations (version, checksum) VALUES ($1, 'x')", [name.slice(0, -4)]);
      }
      assert.equal((await old.query("SELECT to_regclass('price_observations') AS t")).rows[0].t, null);
      const cycle = await runMatchingCycle({ pool: old, workerId: "market-old", notificationTransport: null });
      assert.equal(cycle.market.skipped, true);
      assert.deepEqual(cycle.errors, []);
      assert.equal(cycle.idle, true);
    } finally {
      await old.end();
      await env.admin.query(`DROP SCHEMA IF EXISTS ${quoted} CASCADE`);
    }
  });

  test("le cycle du worker écrit le relevé (marketNow réglable) et il ne compte jamais dans « au repos » ; une étape en échec est rapportée sans empêcher les autres", async () => {
    const seller = await makePerson(pool);
    await publishedOffer(seller.id);
    // Le worker vide d'abord le travail de rapprochement né de la publication (hors sujet ici) : le relevé, lui, ne doit jamais empêcher le repos.
    for (let index = 0; index < 10; index += 1) if ((await runMatchingCycle({ pool, workerId: "market-cycle", notificationTransport: null })).idle) break;
    await resetObservations(pool);
    const cycle = await runMatchingCycle({ pool, workerId: "market-cycle", notificationTransport: null });
    assert.equal(cycle.market.observed, 1);
    assert.equal(cycle.market.skipped, false);
    assert.deepEqual(cycle.errors, []);
    assert.equal(cycle.idle, true, "un relevé quotidien n'est pas du travail qui relance la boucle");
    await pool.query("ALTER TABLE price_observation_runs RENAME TO price_observation_runs_off");
    try {
      const broken = await runMatchingCycle({ pool, workerId: "market-cycle", notificationTransport: null, marketNow: () => new Date(Date.now() + 86_400_000) });
      assert.deepEqual(broken.errors, ["market_error_42p01"], "code stable, rien d'autre en échec");
      assert.equal(broken.temporal.expired, 0);
    } finally {
      await pool.query("ALTER TABLE price_observation_runs_off RENAME TO price_observation_runs");
    }
  });
});

// ═════════════ statistiques lues ═════════════

describe("statistiques lues sur un jeu connu (annonces seulement)", () => {
  const query = { category: "Téléphones", brand: "Apple", model: "iPhone 12", variant: "128 Go", condition: "Occasion", now: MARKET_NOW } as const;

  async function knownWorld() {
    const { sellers, buyers } = await makeActors(pool, 7, 7);
    const listingPrices = [150_000, 155_000, 160_000, 165_000, 170_000, 175_000];
    for (const [index, price] of listingPrices.entries()) {
      const referenceId = (await pool.query<{ id: string }>("SELECT gen_random_uuid() AS id")).rows[0].id;
      for (const day of [0, 1, 2]) await insertObservation(pool, { referenceId, day, price, sellerId: sellers[index].id });
    }
    // Une annonce d'un septième vendeur dont le prix a changé : 300 000 il y a 5 jours, 158 000 hier (son dernier prix compte, l'ancien non).
    const moving = (await pool.query<{ id: string }>("SELECT gen_random_uuid() AS id")).rows[0].id;
    await insertObservation(pool, { referenceId: moving, day: 5, price: 300_000, sellerId: sellers[6].id });
    await insertObservation(pool, { referenceId: moving, day: 1, price: 158_000, sellerId: sellers[6].id });
    // Du bruit qui ne doit JAMAIS compter : un autre modèle, une autre catégorie, une autre marque, une autre variante, et des VENTES (aucun prix de vente n'est publié).
    for (let index = 0; index < 8; index += 1) {
      await insertObservation(pool, { day: 1, price: 900_000, sellerId: sellers[index % 7].id, model: "iPhone 13" });
      await insertObservation(pool, { day: 1, price: 800_000, sellerId: sellers[index % 7].id, category: "Électronique" });
      await insertObservation(pool, { day: 1, price: 700_000, sellerId: sellers[index % 7].id, brand: "Samsung" });
      await insertObservation(pool, { day: 1, price: 600_000, sellerId: sellers[index % 7].id, variant: "256 Go" });
      await insertObservation(pool, { source: "sale", day: index, price: 20_000 + index * 1_000, sellerId: sellers[index % 7].id, buyerId: buyers[index % 7].id });
    }
    return { sellers, buyers };
  }

  test("sept annonces de sept vendeurs (dont une dont le prix a changé) : médiane 160 000 (une valeur par vendeur, dernier prix), effectifs « environ 5 », aucune fourchette (moins de 10 vendeurs), aucune tendance (moins de 15 vendeurs par semaine) ; casse, accents et espaces de la requête sans effet", async () => {
    await knownWorld();
    for (const variant of [query, { ...query, category: "TÉLÉPHONES", brand: "  apple ", model: "IPHONE   12", variant: "128 go", condition: "occasion" }]) {
      const stats = await readMarketStats(pool, { ...variant, periodDays: 30 });
      assert.deepEqual(stats.period, { days: 30, from: dayBefore(29), to: MARKET_TODAY });
      assert.equal(stats.listings.status, "published");
      if (stats.listings.status !== "published") throw new Error("non publié");
      assert.equal(stats.listings.median, 160_000);
      assert.deepEqual(stats.listings.count, { kind: "approx", value: 5 }, "7 annonces");
      assert.deepEqual(stats.listings.sellers, { kind: "approx", value: 5 }, "7 vendeurs");
      assert.equal(stats.listings.excluded, null);
      assert.equal(stats.listings.range, null);
      assert.ok(stats.listings.trend.every((point) => point.median === null));
      // La phrase reprend le texte de la requête tel qu'il a été écrit (jamais celui de la base).
      assert.deepEqual(stats.listings.comparedTo, { scope: "exact", text: `Comparé à : ${variant.model.replace(/\s+/g, " ")} ${variant.variant}, ${variant.condition}` });
    }
  });

  test("les ventes ne comptent JAMAIS et ne sortent jamais : un marché qui n'a que des ventes n'a « pas assez de données » ; la lecture ne mentionne aucune vente ni aucun acteur", async () => {
    const { sellers, buyers } = await makeActors(pool, 7, 7);
    for (let index = 0; index < 8; index += 1) await insertObservation(pool, { source: "sale", day: index, price: 150_000 + index * 1_000, sellerId: sellers[index % 7].id, buyerId: buyers[index % 7].id });
    const onlySales = await readMarketStats(pool, { ...query, periodDays: 90 });
    assert.deepEqual(onlySales.listings, { status: "insufficient" });
    assert.deepEqual(Object.keys(onlySales).sort(), ["listings", "period"]);
    await resetObservations(pool);
    const world = await knownWorld();
    const text = JSON.stringify(await readMarketStats(pool, { ...query, periodDays: 90 }));
    for (const actor of [...world.sellers, ...world.buyers]) assert.equal(text.includes(actor.id), false, actor.id);
    assert.ok(!/sellerId|seller_id|"seller"|buyer|reference|sale|vente/i.test(text), "aucun acteur, aucune vente (la clé « sellers » est un effectif arrondi)");
  });

  test("période : une annonce à −89 jours compte pour 90 jours mais pas pour 30 ; à −90 jours : ni l'un ni l'autre, mais 365 jours", async () => {
    const { sellers } = await makeActors(pool, 5, 0);
    for (let index = 0; index < 5; index += 1) await insertObservation(pool, { day: 89, price: 150_000 + index * 1_000, sellerId: sellers[index].id });
    for (let index = 0; index < 5; index += 1) await insertObservation(pool, { day: 90, price: 250_000 + index * 1_000, sellerId: sellers[index].id });
    assert.equal((await readMarketStats(pool, { ...query, periodDays: 30 })).listings.status, "insufficient");
    const ninety = await readMarketStats(pool, { ...query, periodDays: 90 });
    assert.equal(ninety.listings.status === "published" ? ninety.listings.median : null, 152_000, "les annonces de −89 jours seulement");
    const year = await readMarketStats(pool, { ...query, periodDays: 365 });
    assert.equal(year.listings.status === "published" ? year.listings.median : null, 202_000, "cinq vendeurs de deux annonces : chaque vendeur vaut la moyenne de ses deux prix (200 000 à 204 000), médiane 202 000");
  });

  test("élargissement lu en base : la variante demandée manque de données → sans la variante, et la phrase le dit", async () => {
    const { sellers } = await makeActors(pool, 7, 0);
    for (let index = 0; index < 3; index += 1) await insertObservation(pool, { day: 1, price: 150_000, sellerId: sellers[index].id });
    for (let index = 3; index < 7; index += 1) await insertObservation(pool, { day: 1, price: 200_000, sellerId: sellers[index].id, variant: "256 Go" });
    const stats = await readMarketStats(pool, { ...query, periodDays: 30 });
    assert.equal(stats.listings.status, "published");
    if (stats.listings.status !== "published") return;
    assert.deepEqual(stats.listings.comparedTo, { scope: "any_variant", text: "Comparé à : iPhone 12, Occasion, toutes variantes confondues" });
    assert.equal(stats.listings.median, 200_000, "médiane des 7 vendeurs : 4 à 200 000 et 3 à 150 000 → 200 000");
  });

  test("état non choisi : « tous états confondus » est dit, quelle que soit la portée", async () => {
    const { sellers } = await makeActors(pool, 5, 0);
    for (let index = 0; index < 5; index += 1) await insertObservation(pool, { day: 1, price: 150_000 + index * 1_000, sellerId: sellers[index].id });
    const stats = await readMarketStats(pool, { category: "Téléphones", brand: "Apple", model: "iPhone 12", variant: "128 Go", periodDays: 30, now: MARKET_NOW });
    assert.equal(stats.listings.status === "published" ? stats.listings.comparedTo.text : "", "Comparé à : iPhone 12 128 Go, tous états confondus");
  });

  test("catégorie, marque ou modèle absent ou vide : pas de marché (aucune lecture de relevé)", async () => {
    await knownWorld();
    for (const empty of [{ category: "  " }, { brand: "" }, { model: " " }]) {
      const stats = await readMarketStats(pool, { ...query, ...empty, periodDays: 30 });
      assert.deepEqual(stats.listings, { status: "insufficient" });
    }
  });

  test("période hors liste : refusée", async () => {
    await assert.rejects(() => readMarketStats(pool, { ...query, periodDays: 45 as never }), (error) => error instanceof MarketError && error.code === "invalid_query");
  });

  test("la base RÉDUIT les relevés : au plus (1 + blocs) lignes par annonce, jamais un par jour observé ; le résultat est EXACTEMENT celui du calcul sur tous les relevés bruts (30, 90 et 365 jours)", async () => {
    const { sellers } = await makeActors(pool, 6, 0);
    const refs: string[] = [];
    // 12 annonces observées chaque jour sur 120 jours, dont le prix change deux fois ; une annonce de plus qui n'a qu'un relevé.
    for (let listing = 0; listing < 12; listing += 1) {
      const referenceId = (await pool.query<{ id: string }>("SELECT gen_random_uuid() AS id")).rows[0].id;
      refs.push(referenceId);
      await pool.query(
        `INSERT INTO price_observations (source, reference_id, observed_on, category_key, brand_key, model_key, variant_key, condition_key, label, price_xof, seller_id)
         SELECT 'listing', $1::uuid, $2::date - d, 'telephones', 'apple', 'iphone 12', '128 go', 'occasion', 'x',
                $3::bigint + 1000 * (CASE WHEN d > 80 THEN 3 WHEN d > 30 THEN 1 ELSE 0 END) + 500 * ($4::int % 5), $5::uuid
           FROM generate_series(0, 119) AS d`,
        [referenceId, MARKET_TODAY, 140_000 + listing * 1_500, listing, sellers[listing % 6].id],
      );
    }
    const total = await count(pool, "price_observations");
    assert.equal(total, 12 * 120);
    const read = await readListingObservations(pool, { category: "telephones", brand: "apple", model: "iphone 12" }, { from: dayBefore(364), to: MARKET_TODAY, days: 365 });
    assert.ok(read.length <= 12 * (1 + 52), `${read.length} lignes lues au plus pour 12 annonces`);
    assert.ok(read.length < total / 2, `${read.length} lignes lues au lieu de ${total}`);
    for (const periodDays of [30, 90, 365] as const) {
      const raw = (await pool.query<{ reference_id: string; seller_id: string; day: string; price_xof: string }>(
        `SELECT reference_id::text, seller_id::text, to_char(observed_on, 'YYYY-MM-DD') AS day, price_xof::text FROM price_observations WHERE source = 'listing'`,
      )).rows.map((row): MarketObservation => ({ referenceId: row.reference_id, sellerId: row.seller_id, day: row.day, priceXof: Number(row.price_xof), variantKey: "128 go", conditionKey: "occasion" }));
      const expected = computeMarketStats(raw, { periodDays, today: MARKET_TODAY, variantKey: "128 go", conditionKey: "occasion", display: { model: "iPhone 12", variant: "128 Go", condition: "Occasion" } });
      const actual = await readMarketStats(pool, { ...query, periodDays });
      assert.deepEqual(actual, expected, `${periodDays} jours`);
      assert.equal(actual.listings.status, "published");
    }
  });

  test("un grand marché n'est JAMAIS refusé ni tronqué : 300 annonces de 40 vendeurs observées chaque jour pendant un an (109 500 relevés, au-delà de l'ancienne limite de 100 000) → statistiques publiées, au plus 300 × 53 lignes lues", async () => {
    const { sellers } = await makeActors(pool, 40, 0);
    await pool.query(
      `INSERT INTO price_observations (source, reference_id, observed_on, category_key, brand_key, model_key, variant_key, condition_key, label, price_xof, seller_id)
       SELECT 'listing', ids.id, $2::date - d, 'telephones', 'apple', 'iphone 12', '128 go', 'occasion', 'x', 140000 + (ids.n % 40) * 1000, ($1::uuid[])[1 + (ids.n % 40)]
         FROM (SELECT gen_random_uuid() AS id, n FROM generate_series(1, 300) AS n) ids CROSS JOIN generate_series(0, 364) AS d`,
      [sellers.map((seller) => seller.id), MARKET_TODAY],
    );
    assert.equal(await count(pool, "price_observations"), 300 * 365);
    const started = Date.now();
    const stats = await readMarketStats(pool, { ...query, periodDays: 365 });
    const elapsed = Date.now() - started;
    assert.equal(stats.listings.status, "published");
    if (stats.listings.status !== "published") return;
    assert.deepEqual(stats.listings.count, { kind: "approx", value: 300 });
    assert.deepEqual(stats.listings.sellers, { kind: "approx", value: 40 });
    assert.equal(stats.listings.trend.length, 52);
    assert.ok(stats.listings.trend.every((point) => point.median !== null), "40 vendeurs par semaine : toutes les semaines publiées");
    const read = await readListingObservations(pool, { category: "telephones", brand: "apple", model: "iphone 12" }, { from: dayBefore(364), to: MARKET_TODAY, days: 365 });
    assert.ok(read.length <= 300 * 53, `${read.length} lignes lues`);
    assert.ok(elapsed < 20_000, `lecture de la vue « 1 an » : ${elapsed} ms`);
  });
});

// ═════════════ administration ═════════════

describe("tableau « Marché » de l'administration", () => {
  test("les 20 clés les plus relevées sur 90 jours, dans l'ordre des relevés ; prix demandés avec les mêmes seuils (clé exacte) ; ventes confirmées : un NOMBRE arrondi, jamais un prix ; aucun identifiant", async () => {
    const { sellers, buyers } = await makeActors(pool, 8, 4);
    // 24 produits : le produit n° i a (30 − i) annonces (un relevé chacune) de 8 vendeurs au plus ; tous ont au moins 7 annonces de 7 vendeurs, donc passent le seuil de 5 vendeurs.
    for (let product = 0; product < 24; product += 1) {
      for (let index = 0; index < 30 - product; index += 1) {
        await insertObservation(pool, { day: index % 60, price: 100_000 + product * 1_000 + index * 100, sellerId: sellers[index % 8].id, model: `Modèle ${String(product).padStart(2, "0")}`, variant: null, condition: null });
      }
    }
    // Des ventes confirmées : 7 pour le produit n° 0 (prix reconnaissables), 2 pour le n° 1, aucune pour les autres.
    for (let index = 0; index < 7; index += 1) await insertObservation(pool, { source: "sale", day: index, price: 777_000 + index, sellerId: sellers[index % 4].id, buyerId: buyers[index % 4].id, model: "Modèle 00", variant: null, condition: null });
    for (let index = 0; index < 2; index += 1) await insertObservation(pool, { source: "sale", day: index, price: 666_000 + index, sellerId: sellers[index].id, buyerId: buyers[index].id, model: "Modèle 01", variant: null, condition: null });
    // Un relevé trop ancien (hors des 90 jours) ne compte pas.
    await insertObservation(pool, { day: 200, price: 100_000, sellerId: sellers[0].id, model: "Modèle 99", variant: null, condition: null });
    const result = await readAdminMarket(pool, { now: MARKET_NOW });
    assert.deepEqual(result.period, { days: 90, from: dayBefore(89), to: MARKET_TODAY });
    assert.equal(result.rows.length, 20);
    assert.deepEqual(result.rows.map((row) => row.label).slice(0, 3), ["Apple Modèle 00", "Apple Modèle 01", "Apple Modèle 02"]);
    assert.equal(result.rows[19].label, "Apple Modèle 19");
    assert.ok(!result.rows.some((row) => row.label.includes("99") || row.label.includes("20")));
    assert.equal(result.rows[0].listings.status, "published");
    assert.deepEqual(result.rows[0].confirmedSales, { kind: "approx", value: 5 }, "7 ventes → environ 5");
    assert.deepEqual(result.rows[1].confirmedSales, { kind: "below", bound: 5 }, "2 ventes → moins de 5");
    assert.deepEqual(result.rows[2].confirmedSales, { kind: "below", bound: 5 }, "aucune vente → moins de 5");
    assert.deepEqual(Object.keys(result.rows[0]).sort(), ["confirmedSales", "label", "listings"]);
    const text = JSON.stringify(result);
    for (const actor of [...sellers, ...buyers]) assert.equal(text.includes(actor.id), false);
    for (const price of ["777000", "777006", "666000", "666001"]) assert.equal(text.includes(price), false, `aucun prix de vente (${price})`);
  });

  test("sans relevé : aucune ligne", async () => {
    assert.deepEqual((await readAdminMarket(pool, { now: MARKET_NOW })).rows, []);
  });
});
