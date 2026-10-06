import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { randomBytes } from "node:crypto";
import { Pool } from "pg";
import { createOffer, createUser, publishOffer } from "../../lib/server/catalog";
import { runMigrations } from "../../lib/server/postgres/migrations";
import { FAKE_PHONE_PREFIX, SEED_LOCK_NAMESPACE, SEED_MARKER, fakeSellerId, fakeSellerPhone, isFakeSellerPhone, parseSeedArguments } from "../../scripts/dev-seed-plan";
import { runScript } from "./run-script";
import { seedExampleOffers } from "../../scripts/dev-seed";
import { openVerifiedTestDatabase } from "./test-database";

/**
 * `npm run dev:seed` sur une base jetable `noma_essai_*` créée à côté de la base de test (TEST_DATABASE_URL, jamais noma_dev) : vrais services du
 * catalogue (outbox), vendeurs fictifs du bloc réservé, rejouable sans doublon, refus sans écriture. Le script est lancé en processus enfant avec
 * NODE_ENV=development (le script refuse tout autre NODE_ENV).
 */

/**
 * Lot P3 : `dev:seed` ne peuple plus que `noma_essai`, `noma_e2e` et les bases jetables `noma_essai_*` (liste blanche) ; ce fichier n'utilise donc PLUS
 * un schéma de `noma_test` pour le script : il crée une base JETABLE `noma_essai_<hex>` (puis une seconde, vide, et une troisième pour les lancements
 * simultanés) avec la connexion de test, et la supprime à la fin. Aucune autre base n'est touchée.
 */
const suffix = `${process.pid}_${randomBytes(4).toString("hex")}`;
const mainDb = `noma_essai_${suffix}`;
const emptyDb = `noma_essai_${suffix}_vide`;
const raceDb = `noma_essai_${suffix}_course`;
let admin: Pool, pool: Pool, emptyPool: Pool, racePool: Pool;
let baseUrl: string;
const urlFor = (database: string): string => {
  const url = new URL(baseUrl);
  url.pathname = `/${database}`;
  return url.toString();
};

before(async () => {
  const opened = await openVerifiedTestDatabase(process.env.TEST_DATABASE_URL);
  admin = opened.pool;
  baseUrl = opened.target.connectionString;
  for (const name of [mainDb, emptyDb, raceDb]) await admin.query(`CREATE DATABASE "${name}"`);
  pool = new Pool({ connectionString: urlFor(mainDb), max: 4 });
  emptyPool = new Pool({ connectionString: urlFor(emptyDb), max: 1 });
  racePool = new Pool({ connectionString: urlFor(raceDb), max: 6 });
  assert.equal((await runMigrations(pool)).applied.length, 17);
  assert.equal((await runMigrations(racePool)).applied.length, 17);
});

after(async () => {
  for (const each of [pool, emptyPool, racePool]) if (each) await each.end().catch(() => {});
  if (admin) {
    for (const name of [mainDb, emptyDb, raceDb]) await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch(() => {});
    await admin.end();
  }
});

/** Le script réel, en processus enfant, sur une base jetable `noma_essai_*` (jamais noma_test : refusée par la liste blanche). */
const seed = (args: string[], env: Record<string, string> = {}, database = mainDb) =>
  runScript("scripts/dev-seed.ts", args, "public", { NODE_ENV: "development", DATABASE_URL: urlFor(database), ...env });

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
  assert.match(result.output, new RegExp(`base « ${mainDb} », produit « Téléphones · apple iphone 12 » : 8 annonce\\(s\\) d'exemple publiée\\(s\\), 0 déjà présente\\(s\\) ; 8 vendeur\\(s\\) fictif\\(s\\) créé\\(s\\), 0 déjà présent\\(s\\)`));
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
  const result = await seed(PHONE, {}, emptyDb);
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /la base d'essai n'est pas migrée \(lancez d'abord `npm run db:migrate` avec cette DATABASE_URL\)/);
  const tables = await emptyPool.query("SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public'");
  assert.equal(tables.rows[0].n, 0, "la base vide n'a reçu aucune table");
});

test("lot P3 : liste blanche des bases — noma_test (et toute autre base noma_*) est refusée AVANT toute écriture, par le script réel", async () => {
  const before = await counts();
  for (const database of ["noma_test", "noma_prod", "noma_dev2"]) {
    const refused = await runScript("scripts/dev-seed.ts", PHONE, "public", { NODE_ENV: "development", DATABASE_URL: urlFor(database) });
    assert.equal(refused.code, 1, `${database} : ${refused.output}`);
    assert.match(refused.output, /dev:seed : refus — dev:seed ne peuple que les bases d'essai noma_essai, noma_e2e et noma_essai_\*/, database);
    assert.ok(!/ECONNREFUSED|n'est pas migrée|erreur/i.test(refused.output), `aucune connexion tentée pour ${database} : ${refused.output}`);
  }
  assert.deepEqual(await counts(), before, "rien n'a été écrit");
});

test("lot P3 : --brand et --model avec un caractère de direction de texte (U+202E) ou de contrôle → refus avant toute connexion, rien d'écrit", async () => {
  const before = await counts();
  for (const model of ["iphone\u202E 12", "iphone\u2066 12", "iphone\u200F", "iphone\u0007"]) {
    const refused = await seed(["--category", "phones", "--brand", "apple", "--model", model]);
    assert.equal(refused.code, 1, refused.output);
    assert.match(refused.output, /--model doit être un texte de 1 à 60 caractères sans caractère de contrôle ni de direction de texte/);
  }
  const brand = await seed(["--category", "phones", "--brand", "ap\u202Eple", "--model", "iphone 12"]);
  assert.equal(brand.code, 1, brand.output);
  assert.match(brand.output, /--brand doit être un texte/);
  assert.deepEqual(await counts(), before);
  assert.throws(() => parseSeedArguments(["--category", "phones", "--brand", "apple", "--model", "x\u202Ey"]));
});

test("lot P3-bis (N6) : --category, --brand et --model avec un caractère invisible (U+200B, U+200C, U+200D, U+2060, U+FEFF) → refus par le script réel, avant toute connexion, rien d'écrit", async () => {
  const before = await counts();
  for (const invisible of ["\u200B", "\u200C", "\u200D", "\u2060", "\uFEFF"]) {
    const model = await seed(["--category", "phones", "--brand", "apple", "--model", `iphone${invisible}12`]);
    assert.equal(model.code, 1, model.output);
    assert.match(model.output, /--model doit être un texte de 1 à 60 caractères sans caractère de contrôle ni de direction de texte, ni caractère invisible/);
    const brand = await seed(["--category", "phones", "--brand", `ap${invisible}ple`, "--model", "iphone 12"]);
    assert.equal(brand.code, 1, brand.output);
    assert.match(brand.output, /--brand doit être un texte/);
    const category = await seed(["--category", `pho${invisible}nes`, "--brand", "apple", "--model", "iphone 12"]);
    assert.equal(category.code, 1, category.output);
    assert.match(category.output, /--category doit être un texte/);
    assert.equal(category.output.includes(invisible), false, "la valeur saisie n'est jamais reprise dans le message");
  }
  assert.deepEqual(await counts(), before, "rien n'a été écrit");
});

test("lot P3 : verrou de seed — tant qu'un verrou consultatif du seed est tenu, un second seed ATTEND sans rien écrire ; libéré, il s'exécute (sérialisation de deux dev:seed)", async () => {
  const options = parseSeedArguments(["--category", "phones", "--brand", "lock", "--model", "attente", "--offers", "3"]);
  const holder = await pool.connect();
  let pending: Promise<unknown> | null = null;
  let finished = false;
  try {
    await holder.query("SELECT pg_advisory_lock($1::int, 1)", [SEED_LOCK_NAMESPACE]);
    const before = await counts();
    pending = seedExampleOffers(pool, options).then((report) => { finished = true; return report; });
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(finished, false, "le seed attend le verrou");
    assert.deepEqual(await counts(), before, "aucune écriture pendant l'attente");
    const waiting = await admin.query("SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted AND classid = $1::oid", [SEED_LOCK_NAMESPACE]);
    assert.equal(waiting.rows[0].n, 1, "une session attend le verrou du seed");
  } finally {
    await holder.query("SELECT pg_advisory_unlock($1::int, 1)", [SEED_LOCK_NAMESPACE]);
    holder.release();
  }
  const report = (await pending) as { offersCreated: number };
  assert.equal(report.offersCreated, 3);
  const held = await admin.query("SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND classid = $1::oid", [SEED_LOCK_NAMESPACE]);
  assert.equal(held.rows[0].n, 0, "le verrou est libéré à la fin");
});

test("lot P3 : trois dev:seed LANCÉS EN MÊME TEMPS sur une base neuve → tous réussissent (code 0, jamais « erreur inattendue »), 8 annonces, 8 vendeurs, aucun doublon", async () => {
  const results = await Promise.all([seed(PHONE, {}, raceDb), seed(PHONE, {}, raceDb), seed(PHONE, {}, raceDb)]);
  for (const result of results) {
    assert.equal(result.code, 0, result.output);
    assert.ok(!/erreur inattendue|erreur 23505/.test(result.output), result.output);
  }
  const created = results.map((result) => Number(/: (\d+) annonce\(s\) d'exemple publiée\(s\)/.exec(result.output)![1]));
  assert.equal(created.reduce((sum, value) => sum + value, 0), 8, `annonces créées par les trois lancements : ${created.join(", ")}`);
  const read = async (table: string) => Number((await racePool.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table}`)).rows[0].n);
  assert.deepEqual([await read("users"), await read("phone_identities"), await read("offers")], [8, 8, 8]);
  // Même chose au niveau de la fonction : deux appels simultanés sur des pools distincts (la seconde base est déjà peuplée : rien de plus).
  const other = new Pool({ connectionString: urlFor(raceDb), max: 4 });
  try {
    const [first, second] = await Promise.all([seedExampleOffers(racePool, parseSeedArguments(["--category", "phones", "--brand", "apple", "--model", "iphone 13"])), seedExampleOffers(other, parseSeedArguments(["--category", "phones", "--brand", "apple", "--model", "iphone 13"]))]);
    assert.equal(first.offersCreated + second.offersCreated, 8, "deux appels simultanés : 8 annonces au total, jamais 16");
    assert.equal(await read("users"), 8, "les mêmes vendeurs fictifs servent les deux produits");
  } finally {
    await other.end();
  }
});

test("refus d'arguments : code 1, usage affiché, aucune écriture", async () => {
  const before = await counts();
  const result = await seed(["--category", "phones", "--brand", "apple"]);
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /--model est obligatoire/);
  assert.match(result.output, /Usage : npm run dev:seed/);
  assert.deepEqual(await counts(), before);
});
