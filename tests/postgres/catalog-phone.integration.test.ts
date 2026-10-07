import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import { Pool } from "pg";
import { requestOtp, verifyOtp, type SendOtpInput } from "../../lib/server/auth";
import { createDemand, createOffer, createUser, publishOffer, updateOffer } from "../../lib/server/catalog";
import { CatalogPhoneNumberError } from "../../lib/server/catalog/errors";
import { createCatalogHttpHandlers, type CatalogHttpHandlers } from "../../lib/server/catalog/http";
import { PHONE_IN_OFFER_MESSAGE } from "../../lib/phone-text";
import { runMigrations } from "../../lib/server/postgres/migrations";
import { createTemporarySchemaName, openVerifiedIsolatedPool, openVerifiedTestDatabase, quoteTemporarySchema } from "./test-database";

/**
 * Lot D1, P0 (b) : à la création, à la modification et à la mise en ligne d'une annonce, un numéro de téléphone caché (variante, marque, modèle, attribut…) est refusé avec
 * un message clair, par le service du catalogue ET par la route HTTP ; rien n'est écrit. Les besoins (demandes) ne sont pas concernés par ce refus.
 */

const SECRET = randomBytes(32);
const ORIGIN = "https://noma.test";
const schema = createTemporarySchemaName();
const quoted = quoteTemporarySchema(schema);
let admin: Pool, pool: Pool;
let handlers: CatalogHttpHandlers;
let cookie: string;
let ownerId: string;

before(async () => {
  const opened = await openVerifiedTestDatabase(process.env.TEST_DATABASE_URL);
  admin = opened.pool;
  await admin.query(`CREATE SCHEMA ${quoted}`);
  pool = await openVerifiedIsolatedPool(opened.target, schema, (config) => new Pool({ ...config, max: 4 }));
  await runMigrations(pool);
  handlers = createCatalogHttpHandlers({ pool, env: { NOMA_AUTH_ORIGIN: ORIGIN } });
  let delivery: SendOtpInput | undefined;
  const requested = await requestOtp("+2250799000001", { pool, authSecret: SECRET, requestIp: "198.51.100.77", sendOtp: async (input) => { delivery = input; } });
  assert.ok(delivery);
  const verified = await verifyOtp(requested.challengeId, delivery.code, { pool, authSecret: SECRET });
  ownerId = verified.userId;
  cookie = `noma_auth=${verified.sessionToken}`;
});

after(async () => {
  if (pool) await pool.end();
  if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${quoted} CASCADE`); await admin.end(); }
});

const offerCount = async (): Promise<number> => (await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM offers WHERE owner_id = $1", [ownerId])).rows[0].n;

const send = (method: "POST" | "PATCH", path: string, body: unknown): Request =>
  new Request(`${ORIGIN}${path}`, { method, headers: { cookie, origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify(body) });

const BASE = { rawText: "iPhone 12 128 Go", category: "Téléphones", brand: "Apple", model: "iPhone 12", variant: "128 Go", price: { amount: 150_000, currency: "XOF" } };

test("service : une annonce avec un numéro caché est refusée à la création (rien d'écrit), les formes « / » et « : » comprises ; une annonce ordinaire passe", async () => {
  const before = await offerCount();
  for (const variant of ["WhatsApp 0708091011", "07/08/09/10/11", "07:08:09:10:11", "０７０８０９１０１１", "٠٧٠٨٠٩١٠١١"]) {
    await assert.rejects(createOffer({ ownerId, ...BASE, variant }, pool), (error: unknown) => error instanceof CatalogPhoneNumberError && error.message === PHONE_IN_OFFER_MESSAGE, variant);
  }
  await assert.rejects(createOffer({ ownerId, ...BASE, attributes: { contact: "07 08 09 10 11" } }, pool), CatalogPhoneNumberError);
  await assert.rejects(createOffer({ ownerId, ...BASE, brand: "Apple 0708091011" }, pool), CatalogPhoneNumberError);
  await assert.rejects(createOffer({ ownerId, ...BASE, model: "07/08/09/10/11" }, pool), CatalogPhoneNumberError);
  assert.equal(await offerCount(), before, "aucune ligne écrite par un refus");
  const ok = await createOffer({ ownerId, ...BASE, variant: "128 Go · 2024", attributes: { stockage: { value: 128, unit: "Go" }, annee: "2015-2018" } }, pool);
  assert.equal(ok.variant, "128 Go · 2024");
});

test("service : la modification est refusée (version et contenu inchangés) ; la mise en ligne d'un brouillon ancien qui porte un numéro l'est aussi", async () => {
  const offer = await createOffer({ ownerId, ...BASE, status: "draft" }, pool);
  await assert.rejects(updateOffer({ id: offer.id, ownerId, expectedContentVersion: offer.contentVersion, changes: { variant: "WhatsApp 0708091011" } }, pool), CatalogPhoneNumberError);
  await assert.rejects(updateOffer({ id: offer.id, ownerId, expectedContentVersion: offer.contentVersion, changes: { attributes: { tel: "07/08/09/10/11" } } }, pool), CatalogPhoneNumberError);
  const unchanged = await pool.query<{ variant: string; content_version: number }>("SELECT variant, content_version FROM offers WHERE id = $1", [offer.id]);
  assert.deepEqual(unchanged.rows[0], { variant: "128 Go", content_version: offer.contentVersion });
  const updated = await updateOffer({ id: offer.id, ownerId, expectedContentVersion: offer.contentVersion, changes: { variant: "256 Go" } }, pool);
  assert.equal(updated.variant, "256 Go");

  // Brouillon enregistré avant la règle (ou par un chemin qui ne la contrôlait pas) : inséré directement, jamais publiable.
  const legacy = await pool.query<{ id: string; content_version: number }>(
    "INSERT INTO offers (id, owner_id, status, raw_text, category, brand, model, variant) VALUES (gen_random_uuid(), $1, 'draft', 'ancien', 'Téléphones', 'Apple', 'iPhone 12', 'WhatsApp 0708091011') RETURNING id, content_version",
    [ownerId],
  );
  await assert.rejects(publishOffer(ownerId, legacy.rows[0].id, legacy.rows[0].content_version, pool), CatalogPhoneNumberError);
  const stillDraft = await pool.query<{ status: string }>("SELECT status FROM offers WHERE id = $1", [legacy.rows[0].id]);
  assert.equal(stillDraft.rows[0].status, "draft");
  // Une fois la variante corrigée, la publication passe.
  await pool.query("UPDATE offers SET variant = '128 Go' WHERE id = $1", [legacy.rows[0].id]);
  assert.equal((await publishOffer(ownerId, legacy.rows[0].id, legacy.rows[0].content_version, pool)).status, "published");
});

test("HTTP : création, modification et mise en ligne refusées en 400 `phone_number_in_offer` avec le message clair ; création ordinaire en 201", async () => {
  const before = await offerCount();
  const created = await handlers.offers.create(send("POST", "/api/offers", { ...BASE, variant: "WhatsApp 0708091011" }));
  assert.equal(created.status, 400);
  assert.deepEqual(await created.json(), { error: { code: "phone_number_in_offer", message: "Pas de numéro de téléphone dans l'annonce : l'acheteur vous contactera par noma." } });
  assert.equal(created.headers.get("cache-control"), "no-store");
  const slash = await handlers.offers.create(send("POST", "/api/offers", { ...BASE, attributes: { contact: "07/08/09/10/11" } }));
  assert.equal(slash.status, 400);
  assert.equal((await slash.json()).error.code, "phone_number_in_offer");
  assert.equal(await offerCount(), before);

  const okResponse = await handlers.offers.create(send("POST", "/api/offers", BASE));
  assert.equal(okResponse.status, 201);
  const offer = (await okResponse.json()).offer;
  const patched = await handlers.offers.update(send("PATCH", `/api/offers/${offer.id}`, { expectedContentVersion: offer.contentVersion, variant: "07:08:09:10:11" }), offer.id);
  assert.equal(patched.status, 400);
  assert.equal((await patched.json()).error.message, PHONE_IN_OFFER_MESSAGE);
  const patchedOk = await handlers.offers.update(send("PATCH", `/api/offers/${offer.id}`, { expectedContentVersion: offer.contentVersion, variant: "512 Go" }), offer.id);
  assert.equal(patchedOk.status, 200);

  const legacy = await pool.query<{ id: string; content_version: number }>(
    "INSERT INTO offers (id, owner_id, status, raw_text, category, brand, model, variant) VALUES (gen_random_uuid(), $1, 'draft', 'ancien', 'Téléphones', 'Apple', 'iPhone 12', '07/08/09/10/11') RETURNING id, content_version",
    [ownerId],
  );
  const published = await handlers.offers.publish(send("POST", `/api/offers/${legacy.rows[0].id}/publish`, { expectedContentVersion: legacy.rows[0].content_version }), legacy.rows[0].id);
  assert.equal(published.status, 400);
  assert.equal((await published.json()).error.code, "phone_number_in_offer");
});

test("les besoins ne sont pas concernés : un acheteur garde la liberté de son texte (l'affichage, lui, omet un numéro servi à un vendeur)", async () => {
  const buyer = (await createUser({}, pool)).id;
  const demand = await createDemand({ ownerId: buyer, rawText: "iPhone", category: "Téléphones", brand: "Apple", model: "iPhone 12", variant: "128 Go", status: "draft" }, pool);
  assert.equal(demand.variant, "128 Go");
});
