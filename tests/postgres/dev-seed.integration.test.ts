import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { Pool } from "pg";
import { createOffer, createUser, publishOffer } from "../../lib/server/catalog";
import { runMigrations } from "../../lib/server/postgres/migrations";
import { FAKE_PHONE_PREFIX, SEED_MARKER, fakeSellerId, fakeSellerPhone, isFakeSellerPhone } from "../../scripts/dev-seed-plan";
import { runScript } from "./run-script";
import {
  createTemporarySchemaName, openVerifiedIsolatedPool, openVerifiedTestDatabase, quoteTemporarySchema,
} from "./test-database";

/**
 * `npm run dev:seed` sur un schéma temporaire de la base de test (TEST_DATABASE_URL, jamais noma_dev) : vrais services du catalogue (outbox),
 * vendeurs fictifs du bloc réservé, rejouable sans doublon, refus sans écriture. Le script est lancé en processus enfant avec NODE_ENV=development
 * (le script refuse tout autre NODE_ENV) ; DATABASE_URL = TEST_DATABASE_URL (nom « noma_test » : accepté par la règle « noma_… sauf noma_dev »).
 */

const schema = createTemporarySchemaName();
const emptySchema = createTemporarySchemaName();
let admin: Pool, pool: Pool;

before(async () => {
  const opened = await openVerifiedTestDatabase(process.env.TEST_DATABASE_URL);
  admin = opened.pool;
  await admin.query(`CREATE SCHEMA ${quoteTemporarySchema(schema)}`);
  await admin.query(`CREATE SCHEMA ${quoteTemporarySchema(emptySchema)}`);
  pool = await openVerifiedIsolatedPool(opened.target, schema);
  assert.equal((await runMigrations(pool)).applied.length, 16);
});

after(async () => {
  if (pool) await pool.end();
  if (admin) {
    for (const name of [schema, emptySchema]) await admin.query(`DROP SCHEMA IF EXISTS ${quoteTemporarySchema(name)} CASCADE`);
    await admin.end();
  }
});

const seed = (args: string[], env: Record<string, string> = {}, targetSchema = schema) =>
  runScript("scripts/dev-seed.ts", args, targetSchema, { NODE_ENV: "development", ...env });

const PHONE = ["--category", "phones", "--brand", "apple", "--model", "iphone 12"];

interface OfferSnapshot {
  id: string;
  owner_id: string;
  status: string;
  content_version: number;
  price_amount: string;
  category: string;
  brand: string;
  model: string;
  raw_text: string;
}

async function seededOffers(model = "iphone 12"): Promise<OfferSnapshot[]> {
  return (await pool.query<OfferSnapshot>(
    `SELECT id, owner_id, status, content_version, price_amount::text, category, brand, model, raw_text FROM offers
      WHERE position($1 in raw_text) > 0 AND lower(model) = lower($2) ORDER BY price_amount ASC, id ASC`,
    [SEED_MARKER, model],
  )).rows;
}

async function counts() {
  const read = async (table: string) => Number((await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table}`)).rows[0].n);
  return {
    users: await read("users"), identities: await read("phone_identities"), offers: await read("offers"),
    outbox: await read("matching_outbox_events"),
  };
}

test("premier passage : 8 vendeurs fictifs du bloc réservé, 8 annonces publiées par les vrais services (outbox émis), prix étalés", async () => {
  const before = await counts();
  assert.deepEqual(before, { users: 0, identities: 0, offers: 0, outbox: 0 });
  const result = await seed(PHONE);
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /base « noma_test », produit « Téléphones · apple iphone 12 » : 8 annonce\(s\) d'exemple publiée\(s\), 0 déjà présente\(s\) ; 8 vendeur\(s\) fictif\(s\) créé\(s\), 0 déjà présent\(s\)/);
  assert.match(result.output, /Publiez ensuite VOTRE annonce et créez VOTRE besoin/);

  const offers = await seededOffers();
  assert.equal(offers.length, 8);
  assert.equal(new Set(offers.map((offer) => offer.owner_id)).size, 8, "un vendeur fictif par annonce");
  for (const offer of offers) {
    assert.equal(offer.status, "published");
    assert.equal(offer.category, "Téléphones", "même clé que les annonces créées dans l'application");
    assert.equal(offer.brand, "Apple");
    assert.equal(offer.model, "iphone 12");
    assert.ok(offer.raw_text.includes(SEED_MARKER));
    assert.ok(Number(offer.price_amount) >= 1_000);
  }
  const prices = offers.map((offer) => Number(offer.price_amount));
  assert.equal(prices[0], 105_000);
  assert.equal(prices[7], 158_000);
  assert.equal(new Set(prices).size, 8, "prix tous distincts à 8 annonces autour de 150 000");

  const identities = (await pool.query<{ phone_e164: string; user_id: string; verified_at: Date | null }>("SELECT phone_e164, user_id, verified_at FROM phone_identities ORDER BY phone_e164")).rows;
  assert.equal(identities.length, 8);
  assert.deepEqual(identities.map((identity) => identity.phone_e164), Array.from({ length: 8 }, (_, index) => fakeSellerPhone(index + 1)));
  for (const identity of identities) {
    assert.ok(isFakeSellerPhone(identity.phone_e164) && identity.phone_e164.startsWith(FAKE_PHONE_PREFIX));
    assert.equal(identity.user_id, fakeSellerId(identity.phone_e164), "identifiant stable dérivé du numéro");
    assert.notEqual(identity.verified_at, null);
  }
  const users = (await pool.query<{ id: string; status: string }>("SELECT id, status FROM users")).rows;
  assert.equal(users.length, 8);
  assert.ok(users.every((user) => user.status === "active"));

  // Vrais services : l'outbox a reçu un événement de publication par annonce (le worker du matching les évaluera comme n'importe quelle annonce).
  const events = (await pool.query<{ event_type: string; n: string }>(
    "SELECT event_type, count(*)::text AS n FROM matching_outbox_events WHERE aggregate_type = 'offer' GROUP BY event_type",
  )).rows;
  const byType = Object.fromEntries(events.map((row) => [row.event_type, Number(row.n)]));
  assert.equal(byType["offer.published"], 8, JSON.stringify(byType));
});

test("rejeu à l'identique : aucun doublon, aucune annonce modifiée, rien de nouveau dans l'outbox", async () => {
  const offersBefore = await seededOffers();
  const countsBefore = await counts();
  const result = await seed(PHONE);
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /0 annonce\(s\) d'exemple publiée\(s\), 8 déjà présente\(s\) ; 0 vendeur\(s\) fictif\(s\) créé\(s\), 8 déjà présent\(s\)/);
  assert.deepEqual(await counts(), countsBefore);
  assert.deepEqual(await seededOffers(), offersBefore, "les annonces existantes ne sont pas touchées (identifiant, version, prix)");
});

test("--offers 10 après 8 : ajoute exactement 2 annonces (vendeurs 09 et 10), les 8 premières ne bougent pas", async () => {
  const offersBefore = await seededOffers();
  const ids = new Set(offersBefore.map((offer) => offer.id));
  const result = await seed([...PHONE, "--offers", "10"]);
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /2 annonce\(s\) d'exemple publiée\(s\), 8 déjà présente\(s\) ; 2 vendeur\(s\) fictif\(s\) créé\(s\), 8 déjà présent\(s\)/);
  const offersAfter = await seededOffers();
  assert.equal(offersAfter.length, 10);
  for (const offer of offersBefore) {
    const same = offersAfter.find((candidate) => candidate.id === offer.id);
    assert.deepEqual(same, offer, "annonce d'origine inchangée");
  }
  const added = offersAfter.filter((offer) => !ids.has(offer.id));
  assert.equal(added.length, 2);
  assert.deepEqual(
    (await pool.query<{ phone_e164: string }>("SELECT phone_e164 FROM phone_identities WHERE user_id = ANY($1::uuid[]) ORDER BY phone_e164", [added.map((offer) => offer.owner_id)])).rows.map((row) => row.phone_e164),
    [fakeSellerPhone(9), fakeSellerPhone(10)],
  );
  assert.equal((await counts()).users, 10);
});

test("autre produit : 8 nouvelles annonces par les MÊMES vendeurs fictifs (aucun nouveau compte)", async () => {
  const usersBefore = (await counts()).users;
  const result = await seed(["--category", "Électronique", "--brand", "samsung", "--model", "galaxy s21", "--offers", "8", "--price", "120000"]);
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /8 annonce\(s\) d'exemple publiée\(s\), 0 déjà présente\(s\) ; 0 vendeur\(s\) fictif\(s\) créé\(s\), 8 déjà présent\(s\)/);
  assert.equal((await counts()).users, usersBefore);
  const second = await seededOffers("galaxy s21");
  assert.equal(second.length, 8);
  assert.ok(second.every((offer) => offer.category === "Électronique" && offer.brand === "Samsung"));
  assert.equal((await seededOffers()).length, 10, "le premier produit n'a pas bougé");
});

test("une vraie annonce du même produit n'est ni comptée comme un exemple ni modifiée ; une annonce d'exemple restée en brouillon est publiée sans doublon", async () => {
  const realOwner = await createUser({}, pool);
  const real = await createOffer({
    ownerId: realOwner.id, rawText: "iPhone 12 de Marie", category: "Téléphones", brand: "Apple", model: "iphone 12", condition: "Occasion",
    location: "Abidjan", price: { amount: 140_000, currency: "XOF" }, availabilityStatus: "available", status: "draft",
  }, pool);
  const realPublished = await publishOffer(realOwner.id, real.id, real.contentVersion, pool);

  // Reprise après interruption : la 3e annonce d'exemple repasse en brouillon (exécution coupée entre la création et la publication).
  const [, , third] = await seededOffers();
  await pool.query("UPDATE offers SET status = 'draft' WHERE id = $1::uuid", [third.id]);
  const offersBefore = (await seededOffers()).length;
  const result = await seed(PHONE.concat(["--offers", "10"]));
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /0 annonce\(s\) d'exemple publiée\(s\), 10 déjà présente\(s\)/);
  assert.equal((await seededOffers()).length, offersBefore, "aucun doublon");
  const resumed = (await pool.query<{ status: string }>("SELECT status FROM offers WHERE id = $1::uuid", [third.id])).rows[0];
  assert.equal(resumed.status, "published", "l'annonce restée en brouillon est publiée");

  const untouched = (await pool.query<{ status: string; content_version: number; raw_text: string }>("SELECT status, content_version, raw_text FROM offers WHERE id = $1::uuid", [real.id])).rows[0];
  assert.equal(untouched.status, "published");
  assert.equal(untouched.content_version, realPublished.contentVersion);
  assert.equal(untouched.raw_text, "iPhone 12 de Marie");
});

test("refus : NODE_ENV=test (ou production), aucune écriture d'aucune sorte", async () => {
  const snapshot = async () => ({
    counts: await counts(),
    users: (await pool.query("SELECT id, version FROM users ORDER BY id")).rows,
    offers: (await pool.query("SELECT id, content_version, status FROM offers ORDER BY id")).rows,
  });
  const before = await snapshot();
  for (const nodeEnv of ["test", "production"]) {
    const result = await seed(["--category", "phones", "--brand", "nokia", "--model", "3310"], { NODE_ENV: nodeEnv });
    assert.equal(result.code, 1, result.output);
    assert.match(result.output, new RegExp(`refus — NODE_ENV vaut « ${nodeEnv} »`));
  }
  assert.deepEqual(await snapshot(), before);
});

test("base non migrée : code 1, message clair, aucune table créée ni ligne écrite", async () => {
  const result = await seed(PHONE, {}, emptySchema);
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /la base d'essai n'est pas migrée \(lancez d'abord `npm run db:migrate` avec cette DATABASE_URL\)/);
  const tables = await admin.query("SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = $1", [emptySchema]);
  assert.equal(tables.rows[0].n, 0, "le schéma vide n'a reçu aucune table");
});

test("refus d'arguments : code 1, usage affiché, aucune écriture", async () => {
  const before = await counts();
  const result = await seed(["--category", "phones", "--brand", "apple"]);
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /--model est obligatoire/);
  assert.match(result.output, /Usage : npm run dev:seed/);
  assert.deepEqual(await counts(), before);
});
