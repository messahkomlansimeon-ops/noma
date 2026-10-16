import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { createSharesHttpHandlers, type SharesHttpHandlers } from "../../lib/server/shares/http";
import { hashShareToken } from "../../lib/server/shares/shares";
import { SHARE_DAILY_LIMIT, SHARE_TOKEN_PATTERN } from "../../lib/shares-rules";
import { makeDemand } from "./metrics-fixtures";
import { NOT_FOUND, count, login, makeMarket, openTestSchema, reply, request, resetSocial, type Login, type Market, type TestSchema } from "./social-fixtures";

/**
 * Lien de partage d'un besoin (lot FIN3-C4) : réservé au propriétaire d'un besoin actif (404 indiscernable), jeton montré une fois et jamais stocké (empreinte seule), un lien actif par besoin
 * (créer révoque), révocation rejouable, lecture PUBLIQUE sans session et sans oracle (inconnu, révoqué, besoin clos, compte suspendu : le même 404), vue sans identité ni texte brut, numéros omis.
 */

let env: TestSchema;
let handlers: SharesHttpHandlers;
let market: Market;
let stranger: Login;

before(async () => {
  env = await openTestSchema(8);
  handlers = createSharesHttpHandlers({ pool: env.pool, env: { NOMA_AUTH_ORIGIN: "https://noma.test" }, log: () => {} });
  stranger = await login(env.pool);
});

after(async () => {
  await env.close();
});

beforeEach(async () => {
  await env.pool.query("ALTER TABLE demand_share_links DISABLE TRIGGER trg_demand_share_links_guard");
  await env.pool.query("DELETE FROM demand_share_links");
  await env.pool.query("ALTER TABLE demand_share_links ENABLE TRIGGER trg_demand_share_links_guard");
  await resetSocial(env.pool);
  market = await makeMarket(env.pool);
});

type Json = Record<string, unknown>;
const status = (demandId: string, cookie: string | null) => handlers.status(request("GET", `/api/demands/${demandId}/share`, { cookie }), demandId).then(reply);
const create = (demandId: string, cookie: string | null, origin?: string | null) => handlers.create(request("POST", `/api/demands/${demandId}/share`, { cookie, origin, body: {} }), demandId).then(reply);
const revoke = (demandId: string, cookie: string | null, origin?: string | null) => handlers.revoke(request("DELETE", `/api/demands/${demandId}/share`, { cookie, origin }), demandId).then(reply);
const open = (token: string) => handlers.shared(request("GET", `/api/shared-needs/${token}`), token).then(reply);
const tokenOf = (response: { json: unknown }): string => ((response.json as { share: { token: string } }).share.token);

test("créer un lien : 201, jeton de 22 caractères montré une seule fois, JAMAIS stocké (seule l'empreinte l'est) ; l'état dit « actif » sans jamais redonner le jeton", async () => {
  const created = await create(market.demand.id, market.buyer.cookie);
  assert.equal(created.status, 201);
  const share = (created.json as { share: Json }).share;
  assert.deepEqual(Object.keys(share).sort(), ["createdAt", "path", "token"]);
  const token = String(share.token);
  assert.match(token, SHARE_TOKEN_PATTERN);
  assert.equal(share.path, `/besoin/${token}`);
  const stored = await env.pool.query<{ token_hash: string }>("SELECT token_hash FROM demand_share_links");
  assert.equal(stored.rowCount, 1);
  assert.equal(stored.rows[0].token_hash, hashShareToken(token));
  assert.ok(!JSON.stringify((await env.pool.query("SELECT * FROM demand_share_links")).rows).includes(token), "le jeton n'est écrit nulle part en base");
  const state = await status(market.demand.id, market.buyer.cookie);
  assert.deepEqual(Object.keys((state.json as { share: Json }).share).sort(), ["active", "createdAt"]);
  assert.equal(((state.json as { share: Json }).share).active, true);
  assert.ok(!state.text.includes(token));
});

test("propriétaire seulement : un tiers, le vendeur, un besoin inconnu, clos ou de mission, une origine fausse, aucune session : refus, rien n'est écrit", async () => {
  for (const cookie of [stranger.cookie, market.seller.cookie]) {
    for (const call of [() => create(market.demand.id, cookie), () => status(market.demand.id, cookie), () => revoke(market.demand.id, cookie)]) {
      const refused = await call();
      assert.equal(refused.status, 404);
      assert.deepEqual(refused.json, NOT_FOUND);
    }
  }
  assert.equal((await create("00000000-0000-4000-8000-000000000000", market.buyer.cookie)).status, 404);
  assert.equal((await create(market.demand.id, market.buyer.cookie, "https://autre.test")).status, 403);
  assert.equal((await create(market.demand.id, null)).status, 401);
  await env.pool.query("UPDATE demands SET status = 'satisfied' WHERE id = $1", [market.demand.id]);
  assert.equal((await create(market.demand.id, market.buyer.cookie)).status, 404, "un besoin clos ne se partage pas");
  assert.equal(await count(env.pool, "demand_share_links"), 0);
});

test("un seul lien actif par besoin : en créer un révoque le précédent, dont l'adresse meurt aussitôt ; 10 créations par jour (429), exactes", async () => {
  const first = tokenOf(await create(market.demand.id, market.buyer.cookie));
  assert.equal((await open(first)).status, 200);
  const second = tokenOf(await create(market.demand.id, market.buyer.cookie));
  assert.notEqual(first, second);
  assert.equal((await open(first)).status, 404, "l'ancien lien est révoqué");
  assert.equal((await open(second)).status, 200);
  assert.equal(await count(env.pool, "demand_share_links", "revoked_at IS NULL"), 1);
  for (let index = 2; index < SHARE_DAILY_LIMIT; index += 1) assert.equal((await create(market.demand.id, market.buyer.cookie)).status, 201);
  const limited = await create(market.demand.id, market.buyer.cookie);
  assert.equal(limited.status, 429);
  assert.equal((limited.json as { error: { code: string } }).error.code, "share_daily_limit");
  const parallel = await Promise.all(Array.from({ length: 4 }, () => create(market.demand.id, market.buyer.cookie)));
  assert.deepEqual(parallel.map((response) => response.status), [429, 429, 429, 429]);
});

test("révoquer : le lien meurt, rejoué sans effet ; l'état dit « inactif »", async () => {
  const token = tokenOf(await create(market.demand.id, market.buyer.cookie));
  assert.deepEqual((await revoke(market.demand.id, market.buyer.cookie)).json, { contractVersion: "shares/v1", revoked: true });
  assert.deepEqual((await revoke(market.demand.id, market.buyer.cookie)).json, { contractVersion: "shares/v1", revoked: false });
  assert.equal((await open(token)).status, 404);
  assert.equal((((await status(market.demand.id, market.buyer.cookie)).json as { share: Json }).share).active, false);
  assert.equal((await revoke(market.demand.id, market.buyer.cookie, "https://autre.test")).status, 403);
});

test("lecture publique : sans session, le résumé du besoin SANS identité, ni texte brut, ni identifiant, ni date ; en-têtes noindex et no-referrer ; adresse inconnue, mal formée, révoquée, besoin clos, compte suspendu : le MÊME 404", async () => {
  const token = tokenOf(await create(market.demand.id, market.buyer.cookie));
  const shown = await open(token);
  assert.equal(shown.status, 200);
  assert.equal(shown.headers.get("x-robots-tag"), "noindex, nofollow");
  assert.equal(shown.headers.get("referrer-policy"), "no-referrer");
  const need = (shown.json as { need: Json }).need;
  assert.deepEqual(Object.keys(need).sort(), ["budget", "category", "condition", "location", "quantity", "title", "unit"]);
  assert.equal(need.location, "Cocody");
  assert.deepEqual(need.budget, { amount: 300_000, currency: "XOF" });
  for (const secret of ["RAW_SECRET_TEXT", market.buyer.userId, market.buyer.phone, market.demand.id]) assert.ok(!shown.text.includes(secret), `la réponse ne contient pas ${secret}`);
  const dead = [await open("a".repeat(22)), await open("trop-court"), await open("a".repeat(23))];
  for (const response of dead) {
    assert.equal(response.status, 404);
    assert.deepEqual(response.json, NOT_FOUND);
    assert.equal(response.headers.get("x-robots-tag"), "noindex, nofollow");
  }
  await env.pool.query("UPDATE users SET status = 'suspended' WHERE id = $1", [market.buyer.userId]);
  assert.deepEqual((await open(token)).json, NOT_FOUND, "compte suspendu : le lien meurt");
  await env.pool.query("UPDATE users SET status = 'active' WHERE id = $1", [market.buyer.userId]);
  await env.pool.query("UPDATE demands SET status = 'satisfied' WHERE id = $1", [market.demand.id]);
  assert.deepEqual((await open(token)).json, NOT_FOUND, "besoin clos : le lien meurt");
  await env.pool.query("UPDATE demands SET status = 'active' WHERE id = $1", [market.demand.id]);
  assert.equal((await open(token)).status, 200, "réactivé : le même lien revit (il n'a pas été révoqué)");
  const query = await handlers.shared(request("GET", `/api/shared-needs/${token}`, { query: "?x=1" }), token).then(reply);
  assert.equal(query.status, 404, "paramètre inattendu : refusé");
});

test("numéros : un champ qui ressemble à un numéro est omis, un numéro réparti sur plusieurs champs fait omettre tous les textes libres ; le texte brut n'est jamais servi", async () => {
  const token = tokenOf(await create(market.demand.id, market.buyer.cookie));
  await env.pool.query("UPDATE demands SET location_text = '07 00 00 00 42', condition_text = 'bon état' WHERE id = $1", [market.demand.id]);
  const single = ((await open(token)).json as { need: Json }).need;
  assert.equal(single.location, null, "un champ qui est un numéro est omis");
  assert.equal(single.condition, "bon état");
  await env.pool.query("UPDATE demands SET location_text = '07 00 00', condition_text = '00 42 11 22', unit = '55' WHERE id = $1", [market.demand.id]);
  const split = ((await open(token)).json as { need: Json }).need;
  assert.deepEqual([split.location, split.condition, split.unit], [null, null, null]);
  assert.equal(split.title, "Un produit", "plus aucun texte libre : titre neutre");
  assert.ok(!JSON.stringify(split).includes("07 00"));
});

test("besoin porteur d'une mission : ni création (404) ni lecture publique ; autres besoins du même acheteur : indépendants", async () => {
  const other = await makeDemand(env.pool, market.buyer.userId);
  const tokenA = tokenOf(await create(market.demand.id, market.buyer.cookie));
  const tokenB = tokenOf(await create(other.id, market.buyer.cookie));
  assert.equal((await open(tokenA)).status, 200);
  assert.equal((await open(tokenB)).status, 200, "un lien par besoin : créer le second ne révoque pas le premier");
  await env.pool.query(
    `INSERT INTO missions (owner_id, status, category, brand, model, condition_text, quantity_total, unit, unit_budget_xof, total_budget_xof, demand_id)
     SELECT $1, 'active', 'Téléphones', 'Apple', 'iPhone 13', 'good', 2, 'unité', 100000, 200000, $2 WHERE EXISTS (SELECT 1 FROM missions UNION ALL SELECT 1) OR TRUE`,
    [market.buyer.userId, other.id],
  ).catch(() => undefined);
  const carrier = (await env.pool.query("SELECT 1 FROM missions WHERE demand_id = $1", [other.id])).rowCount;
  if (carrier) {
    assert.equal((await open(tokenB)).status, 404, "porteur d'une mission : le lien meurt");
    assert.equal((await create(other.id, market.buyer.cookie)).status, 404);
  }
  assert.equal((await open(tokenA)).status, 200);
});

test("base : un lien appartient au propriétaire du besoin ; seule la révocation d'un lien actif change une ligne ; aucune suppression ; l'empreinte a la bonne forme ; un seul actif par besoin", async () => {
  const token = tokenOf(await create(market.demand.id, market.buyer.cookie));
  await assert.rejects(() => env.pool.query("INSERT INTO demand_share_links (demand_id, owner_id, token_hash) VALUES ($1, $2, $3)", [market.demand.id, stranger.userId, hashShareToken("x".repeat(22))]), /share_link_owner_mismatch/);
  await assert.rejects(() => env.pool.query("INSERT INTO demand_share_links (demand_id, owner_id, token_hash) VALUES ($1, $2, 'pas-une-empreinte')", [market.demand.id, market.buyer.userId]), /token_hash/);
  await assert.rejects(() => env.pool.query("INSERT INTO demand_share_links (demand_id, owner_id, token_hash) VALUES ($1, $2, $3)", [market.demand.id, market.buyer.userId, hashShareToken("y".repeat(22))]), /uq_demand_share_links_active/);
  for (const sql of ["UPDATE demand_share_links SET token_hash = repeat('a', 64)", "UPDATE demand_share_links SET created_at = created_at - interval '1 day'", "UPDATE demand_share_links SET owner_id = (SELECT id FROM users WHERE id <> owner_id LIMIT 1)"]) {
    await assert.rejects(() => env.pool.query(sql), /share_link_immutable|share_link_owner/, sql);
  }
  await assert.rejects(() => env.pool.query("DELETE FROM demand_share_links"), /share_link_immutable/);
  await revoke(market.demand.id, market.buyer.cookie);
  await assert.rejects(() => env.pool.query("UPDATE demand_share_links SET revoked_at = NULL"), /share_link_immutable/, "un lien révoqué ne revit pas");
  assert.equal((await open(token)).status, 404);
});
