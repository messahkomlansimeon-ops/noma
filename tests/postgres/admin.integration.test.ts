import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";
import { createAdminHttpHandlers, type AdminHttpHandlers } from "../../lib/server/admin/http";
import { grantAdmin } from "../../lib/server/admin/grant";
import { createSocialHttpHandlers, type SocialHttpHandlers } from "../../lib/server/social/http";
import { recordWalletTransaction } from "../../lib/server/wallet/ledger";
import { makeBoost, makeDemand, makeMatch, makeOffer } from "./metrics-fixtures";
import { runScript } from "./run-script";
import { NOT_FOUND, count, login, makeMarket, openTestSchema, reply, request, resetSocial, type Login, type TestSchema } from "./social-fixtures";

/**
 * Administration (lot D2) : 404 indiscernable pour tout non-administrateur, origine vérifiée, rôle attribué seulement par `admin:grant` (et refus en production), tableau de
 * bord aux chiffres réels, vendeurs aux numéros masqués, suspension et réactivation journalisées par la voie existante (statut `users`, sweep de réactivation).
 */

let env: TestSchema;
let admin: AdminHttpHandlers;
let social: SocialHttpHandlers;
let boss: Login;
let ordinary: Login;
let sellerA: Login;
let sellerB: Login;

before(async () => {
  env = await openTestSchema();
  const common = { pool: env.pool, env: { NOMA_AUTH_ORIGIN: "https://noma.test" }, log: () => {} };
  admin = createAdminHttpHandlers(common);
  social = createSocialHttpHandlers(common);
  boss = await login(env.pool);
  ordinary = await login(env.pool);
  sellerA = await login(env.pool);
  sellerB = await login(env.pool);
  assert.equal((await grantAdmin({ pool: env.pool, phone: boss.phone })).granted, true);
});

after(async () => {
  await env.close();
});

beforeEach(async () => {
  await resetSocial(env.pool);
  await env.pool.query("UPDATE users SET status = 'active', archived_at = NULL WHERE status = 'suspended'");
  await env.pool.query("ALTER TABLE admin_actions DISABLE TRIGGER trg_admin_actions_immutable");
  await env.pool.query("DELETE FROM admin_actions WHERE action <> 'grant_admin'");
  await env.pool.query("ALTER TABLE admin_actions ENABLE TRIGGER trg_admin_actions_immutable");
});

type Json = Record<string, unknown>;
const get = (name: "summary" | "vendors" | "actions" | "settings", cookie: string | null, query = "") =>
  admin[name](request("GET", `/api/admin/${name}`, { cookie, query })).then(reply);
const act = (userId: string, action: string, cookie: string | null, origin?: string | null) =>
  admin.vendorAction(request("POST", `/api/admin/vendors/${userId}/${action}`, { cookie, origin, body: {} }), userId, action).then(reply);

test("TOUTES les routes d'administration : le même 404 pour un visiteur, un compte ordinaire, un administrateur suspendu ; aucune écriture", async () => {
  const unknown = await get("summary", null);
  assert.equal(unknown.status, 404);
  assert.deepEqual(unknown.json, NOT_FOUND);
  for (const cookie of [null, ordinary.cookie, sellerA.cookie]) {
    for (const name of ["summary", "vendors", "actions", "settings"] as const) {
      const answer = await get(name, cookie);
      assert.equal(answer.status, 404, `${name} ${cookie === null ? "sans session" : "compte ordinaire"}`);
      assert.equal(answer.text, unknown.text, "indiscernable");
    }
    for (const action of ["suspend", "reactivate"]) {
      const answer = await act(sellerB.userId, action, cookie);
      assert.equal(answer.status, 404);
      assert.equal(answer.text, unknown.text);
    }
  }
  assert.equal(await count(env.pool, "admin_actions", "action <> 'grant_admin'"), 0);
  assert.equal((await env.pool.query("SELECT status FROM users WHERE id = $1", [sellerB.userId])).rows[0].status, "active");
  // Un administrateur dont le compte est suspendu perd tout accès (la session ne se résout plus).
  const other = await login(env.pool);
  await grantAdmin({ pool: env.pool, phone: other.phone });
  assert.equal((await get("summary", other.cookie)).status, 200);
  await env.pool.query("UPDATE users SET status = 'suspended' WHERE id = $1", [other.userId]);
  assert.equal((await get("summary", other.cookie)).status, 404);
  await env.pool.query("UPDATE users SET status = 'active' WHERE id = $1", [other.userId]);
});

test("origine vérifiée sur les écritures AVANT le rôle : 403 pour tous (le 404 ne trahit rien), puis rien n'est écrit", async () => {
  for (const cookie of [boss.cookie, ordinary.cookie, null]) {
    for (const origin of [null, "https://evil.example"]) {
      const answer = await act(sellerA.userId, "suspend", cookie, origin);
      assert.equal(answer.status, 403);
    }
  }
  assert.equal((await env.pool.query("SELECT status FROM users WHERE id = $1", [sellerA.userId])).rows[0].status, "active");
  assert.equal(await count(env.pool, "admin_actions", "action <> 'grant_admin'"), 0);
});

test("le rôle ne s'attribue QUE par admin:grant : tout UPDATE ou INSERT direct est refusé par la base ; l'attribution est journalisée et idempotente", async () => {
  const candidate = await login(env.pool);
  await assert.rejects(() => env.pool.query("UPDATE users SET is_admin = TRUE WHERE id = $1", [candidate.userId]), (error: { message?: string; code?: string }) => /admin_grant_forbidden/.test(String(error.message)) && error.code === "23001");
  await assert.rejects(() => env.pool.query("INSERT INTO users (id, is_admin) VALUES ($1, TRUE)", [randomUUID()]), (error: { message?: string }) => /admin_grant_forbidden/.test(String(error.message)));
  // Même dans une transaction : un réglage « off » ne suffit pas.
  const client = await env.pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL noma.admin_grant = 'off'");
    await assert.rejects(() => client.query("UPDATE users SET is_admin = TRUE WHERE id = $1", [candidate.userId]), (error: { message?: string }) => /admin_grant_forbidden/.test(String(error.message)));
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    client.release();
  }
  assert.equal((await env.pool.query("SELECT is_admin FROM users WHERE id = $1", [candidate.userId])).rows[0].is_admin, false);
  assert.equal((await get("summary", candidate.cookie)).status, 404);
  const granted = await grantAdmin({ pool: env.pool, phone: candidate.phone });
  assert.deepEqual(granted, { userId: candidate.userId, granted: true });
  assert.equal((await get("summary", candidate.cookie)).status, 200);
  assert.equal((await grantAdmin({ pool: env.pool, phone: candidate.phone })).granted, false, "déjà administrateur : rien n'est écrit");
  const journal = await env.pool.query("SELECT admin_id, source, action FROM admin_actions WHERE target_user_id = $1", [candidate.userId]);
  assert.deepEqual(journal.rows, [{ admin_id: null, source: "command", action: "grant_admin" }]);
  // Saisie libre (07 xx xx xx xx) normalisée ; numéro inconnu ou invalide refusé.
  const local = `0${candidate.phone.slice(5)}`;
  assert.equal((await grantAdmin({ pool: env.pool, phone: local.replace(/(\d{2})(?=\d)/g, "$1 ") })).granted, false);
  await assert.rejects(() => grantAdmin({ pool: env.pool, phone: "+2250799999999" }), (error: { code?: string }) => error.code === "grant_no_account");
  await assert.rejects(() => grantAdmin({ pool: env.pool, phone: "pas un numéro" }), (error: { code?: string }) => error.code === "grant_invalid_phone");
});

test("commande admin:grant : refusée en production sans variable explicite (rien n'est attribué) ; permise en test ; avec la variable en production", async () => {
  const target = await login(env.pool);
  const refused = await runScript("scripts/admin-grant.ts", [target.phone], env.schema, { NODE_ENV: "production" });
  assert.equal(refused.code, 1);
  assert.match(refused.output, /refus en production : définissez NOMA_ADMIN_GRANT_PRODUCTION=1/);
  assert.equal((await env.pool.query("SELECT is_admin FROM users WHERE id = $1", [target.userId])).rows[0].is_admin, false);
  const odd = await runScript("scripts/admin-grant.ts", [target.phone], env.schema, { NODE_ENV: "staging" });
  assert.equal(odd.code, 1);
  assert.equal((await env.pool.query("SELECT is_admin FROM users WHERE id = $1", [target.userId])).rows[0].is_admin, false);
  const usage = await runScript("scripts/admin-grant.ts", [], env.schema);
  assert.equal(usage.code, 1);
  assert.match(usage.output, /Usage : npm run admin:grant -- <numéro de téléphone>/);
  const unknown = await runScript("scripts/admin-grant.ts", ["+2250799999998"], env.schema);
  assert.equal(unknown.code, 1);
  assert.match(unknown.output, /Aucun compte vérifié ne correspond à ce numéro/);
  const ok = await runScript("scripts/admin-grant.ts", [target.phone], env.schema);
  assert.equal(ok.code, 0, ok.output);
  assert.match(ok.output, /rôle admin attribué/);
  assert.equal((await env.pool.query("SELECT is_admin FROM users WHERE id = $1", [target.userId])).rows[0].is_admin, true);
  const second = await login(env.pool);
  const production = await runScript("scripts/admin-grant.ts", [second.phone], env.schema, { NODE_ENV: "production", NOMA_ADMIN_GRANT_PRODUCTION: "1" });
  assert.equal(production.code, 0, production.output);
  assert.equal((await env.pool.query("SELECT is_admin FROM users WHERE id = $1", [second.userId])).rows[0].is_admin, true);
});

test("tableau de bord : chiffres réels (comptes, annonces par statut, besoins actifs, correspondances, boosts, crédits, recharges du jour, conversations, commandes, worker)", async () => {
  const market = await makeMarket(env.pool);
  await makeOffer(env.pool, market.seller.userId, { status: "draft" });
  await makeOffer(env.pool, market.seller.userId, { status: "paused" });
  await makeBoost(env.pool, market.offer);
  await recordWalletTransaction(env.pool, {
    kind: "adjustment",
    reference: `adjustment:test-${randomUUID()}`,
    metadata: { reasonCode: "demo_seed" },
    entries: [{ account: { kind: "boost_revenue" }, amount: BigInt(-12_000) }, { account: { kind: "user", ownerId: market.buyer.userId }, amount: BigInt(12_000) }],
  });
  // Une recharge réussie du jour, écrite directement (la garde d'état initial des intentions est levée le temps de l'insertion).
  await env.pool.query("ALTER TABLE payment_intents DISABLE TRIGGER trg_payment_intents_guard");
  await env.pool.query(
    `INSERT INTO payment_intents (id, owner_id, amount_xof, provider, status, idempotency_key, provider_reference, created_at, expires_at, completed_at)
     VALUES (gen_random_uuid(), $1, 5000, 'fake', 'succeeded', gen_random_uuid(), 'ref_abcdefgh1', clock_timestamp() - interval '2 seconds', clock_timestamp() + interval '1 hour', clock_timestamp())`,
    [market.buyer.userId],
  );
  await env.pool.query("ALTER TABLE payment_intents ENABLE TRIGGER trg_payment_intents_guard");
  const opened = await reply(await social.conversations.open(request("POST", `/api/demands/${market.demand.id}/offers/${market.offer.id}/conversation`, { cookie: market.buyer.cookie }), market.demand.id, market.offer.id));
  const conversationId = (opened.json as { conversation: { id: string } }).conversation.id;
  await social.conversations.send(request("POST", `/api/conversations/${conversationId}/messages`, { cookie: market.buyer.cookie, body: { body: "bonjour" } }), conversationId);
  const order = await reply(await social.orders.declare(request("POST", `/api/demands/${market.demand.id}/offers/${market.offer.id}/orders`, { cookie: market.buyer.cookie, body: { priceXof: 240_000 } }), market.demand.id, market.offer.id));
  await reply(await social.orders.act(request("POST", `/api/orders/${(order.json as { order: { id: string } }).order.id}/confirm`, { cookie: market.seller.cookie, body: {} }), (order.json as { order: { id: string } }).order.id, "confirm"));

  const answer = await get("summary", boss.cookie);
  assert.equal(answer.status, 200);
  const summary = (answer.json as { summary: Json }).summary as Json & { accounts: Json; offers: { total: number; byStatus: Record<string, number> }; credits: Json; conversations: Json; orders: Json; worker: Json };
  assert.equal(summary.accounts.total, await count(env.pool, "users"));
  assert.equal(summary.accounts.active, await count(env.pool, "users", "status = 'active'"));
  assert.equal(summary.accounts.suspended, 0);
  assert.deepEqual(summary.offers.byStatus, { draft: 1, paused: 1, published: 1 });
  assert.equal(summary.offers.total, 3);
  assert.equal(summary.activeDemands, 1);
  assert.equal(summary.confirmedMatches, 1);
  assert.equal(summary.activeBoosts, 1);
  assert.deepEqual(summary.credits, { circulationXof: 12_000, topupsTodayCount: 1, topupsTodayXof: 5_000 });
  assert.deepEqual(summary.conversations, { total: 1, messagesToday: 1 });
  assert.deepEqual(summary.orders, { confirmed: 1, proposed: 0 });
  assert.equal(summary.worker.schemaReady, true);
  assert.equal(typeof summary.worker.healthy, "boolean");
  for (const key of ["pendingEvents", "pendingJobs", "runningJobs", "deadLetter"]) assert.equal(typeof summary.worker[key], "number", key);
  assert.ok(Array.isArray(summary.worker.warnings));
  assert.ok(!answer.text.includes(market.buyer.phone) && !answer.text.includes(market.seller.phone));
  assert.equal((await get("summary", boss.cookie, "?x=1")).status, 400);
});

test("vendeurs : seuls les comptes avec annonce, numéros MASQUÉS sauf les deux derniers chiffres, pagination, jamais le numéro complet", async () => {
  await makeOffer(env.pool, sellerA.userId);
  await makeOffer(env.pool, sellerA.userId, { status: "draft" });
  await makeOffer(env.pool, sellerB.userId);
  const answer = await get("vendors", boss.cookie);
  assert.equal(answer.status, 200);
  const page = answer.json as { total: number; vendors: Array<{ id: string; maskedPhone: string; offerCount: number; publishedCount: number; status: string; createdAt: string; isAdmin: boolean }> };
  assert.equal(page.total, 2);
  assert.deepEqual(page.vendors.map((vendor) => vendor.id).sort(), [sellerA.userId, sellerB.userId].sort());
  const byId = new Map(page.vendors.map((vendor) => [vendor.id, vendor]));
  assert.equal(byId.get(sellerA.userId)?.offerCount, 2);
  assert.equal(byId.get(sellerA.userId)?.publishedCount, 1);
  for (const seller of [sellerA, sellerB]) {
    const masked = byId.get(seller.userId)?.maskedPhone ?? "";
    assert.match(masked, /^\+•+[0-9]{2}$/, masked);
    assert.equal(masked.endsWith(seller.phone.slice(-2)), true);
    assert.equal(masked.length, seller.phone.length, "même longueur : un « + », des points, deux chiffres");
    assert.ok(!answer.text.includes(seller.phone), "numéro complet absent");
    assert.ok(!answer.text.includes(seller.phone.slice(-8)), "aucune suite de huit chiffres du numéro");
    assert.ok(!answer.text.includes(seller.phone.slice(-4)), "au plus les deux derniers chiffres");
  }
  // Pagination.
  const first = (await get("vendors", boss.cookie, "?limit=1&offset=0")).json as { total: number; vendors: unknown[] };
  const second = (await get("vendors", boss.cookie, "?limit=1&offset=1")).json as { total: number; vendors: Array<{ id: string }> };
  assert.equal(first.vendors.length, 1);
  assert.equal(second.vendors.length, 1);
  assert.equal(first.total, 2);
  assert.notEqual((first.vendors[0] as { id: string }).id, second.vendors[0].id);
  assert.deepEqual(((await get("vendors", boss.cookie, "?limit=1&offset=5")).json as { vendors: unknown[] }).vendors, []);
  for (const query of ["?limit=0", "?limit=51", "?limit=x", "?offset=-1", "?zzz=1", "?limit=1&limit=2"]) assert.equal((await get("vendors", boss.cookie, query)).status, 400, query);
});

test("suspendre puis réactiver : statut `users` existant, session refusée dès la requête suivante, sweep de réactivation demandé (outbox), journal « qui, quoi, quand » ; idempotent", async () => {
  await makeOffer(env.pool, sellerA.userId);
  const suspended = await act(sellerA.userId, "suspend", boss.cookie);
  assert.equal(suspended.status, 200);
  assert.deepEqual(suspended.json, { contractVersion: "admin/v1", status: "suspended", changed: true });
  assert.equal((await env.pool.query("SELECT status FROM users WHERE id = $1", [sellerA.userId])).rows[0].status, "suspended");
  // Sa session ne se résout plus : toute route authentifiée le refuse.
  assert.equal((await reply(await social.favorites.list(request("GET", "/api/favorites", { cookie: sellerA.cookie })))).status, 401);
  assert.equal((await env.pool.query("SELECT 1 FROM matching_outbox_events WHERE event_type = 'user.suspended' AND aggregate_id = $1", [sellerA.userId])).rowCount, 1);
  // Idempotent : une deuxième suspension ne change rien et ne journalise rien de plus.
  const again = await act(sellerA.userId, "suspend", boss.cookie);
  assert.deepEqual(again.json, { contractVersion: "admin/v1", status: "suspended", changed: false });
  assert.equal(await count(env.pool, "admin_actions", "action = 'suspend_user'"), 1);
  // Réactivation : le statut revient, l'événement `user.reactivated` déclenche le balayage de réactivation du worker.
  const reactivated = await act(sellerA.userId, "reactivate", boss.cookie);
  assert.deepEqual(reactivated.json, { contractVersion: "admin/v1", status: "active", changed: true });
  assert.equal((await reply(await social.favorites.list(request("GET", "/api/favorites", { cookie: sellerA.cookie })))).status, 200, "la session de nouveau valide");
  assert.equal((await env.pool.query("SELECT 1 FROM matching_outbox_events WHERE event_type = 'user.reactivated' AND aggregate_id = $1", [sellerA.userId])).rowCount, 1);
  // Journal.
  const rows = (await env.pool.query("SELECT admin_id, source, action, target_user_id FROM admin_actions WHERE action <> 'grant_admin' ORDER BY created_at")).rows;
  assert.deepEqual(rows, [
    { admin_id: boss.userId, source: "admin_ui", action: "suspend_user", target_user_id: sellerA.userId },
    { admin_id: boss.userId, source: "admin_ui", action: "reactivate_user", target_user_id: sellerA.userId },
  ]);
  const shown = (await get("actions", boss.cookie)).json as { actions: Array<{ action: string; source: string; byMaskedPhone: string | null; targetMaskedPhone: string | null; createdAt: string }> };
  const suspendEntry = shown.actions.find((entry) => entry.action === "suspend_user");
  assert.ok(suspendEntry);
  assert.match(String(suspendEntry.byMaskedPhone), /^\+•+[0-9]{2}$/);
  assert.match(String(suspendEntry.targetMaskedPhone), /^\+•+[0-9]{2}$/);
  assert.ok(!JSON.stringify(shown).includes(boss.phone) && !JSON.stringify(shown).includes(sellerA.phone));
  assert.ok(shown.actions.some((entry) => entry.action === "grant_admin" && entry.source === "command" && entry.byMaskedPhone === null), "l'attribution du rôle est au journal");
  // Le journal ne se modifie pas.
  await assert.rejects(() => env.pool.query("DELETE FROM admin_actions"), (error: { message?: string }) => /admin_actions_immutable/.test(String(error.message)));
  await assert.rejects(() => env.pool.query("UPDATE admin_actions SET action = 'suspend_user'"), (error: { message?: string }) => /admin_actions_immutable/.test(String(error.message)));
});

test("un compte administrateur ne se suspend pas (ni lui-même) ; compte inconnu, identifiant invalide, action inconnue : 404 ; archivé : 409", async () => {
  const self = await act(boss.userId, "suspend", boss.cookie);
  assert.equal(self.status, 409);
  assert.deepEqual(self.json, { error: { code: "target_protected", message: "Un compte administrateur ne peut pas être suspendu." } });
  assert.equal((await env.pool.query("SELECT status FROM users WHERE id = $1", [boss.userId])).rows[0].status, "active");
  for (const [target, action] of [[randomUUID(), "suspend"], ["pas-un-uuid", "suspend"], [sellerB.userId, "supprimer"]] as const) {
    const answer = await act(target, action, boss.cookie);
    assert.equal(answer.status, 404, `${target} ${action}`);
    assert.deepEqual(answer.json, NOT_FOUND);
  }
  const archived = await login(env.pool);
  await env.pool.query("UPDATE users SET status = 'archived', archived_at = clock_timestamp() WHERE id = $1", [archived.userId]);
  const answer = await act(archived.userId, "reactivate", boss.cookie);
  assert.equal(answer.status, 409);
  assert.equal(await count(env.pool, "admin_actions", "action <> 'grant_admin'"), 0);
});

test("réglages du boost par catégorie : lecture seule (ligne « default » d'abord, surcharges ensuite) ; aucune route d'écriture", async () => {
  await env.pool.query(
    `INSERT INTO boost_settings (key, slot_ratio, min_slots, max_slots, max_active_per_seller, max_seller_slot_share, max_promoted_share, min_relevance)
     VALUES ('smartphones', 0.2, 2, 30, 3, 0.5, 0.1, 70)`,
  );
  try {
    const answer = await get("settings", boss.cookie);
    assert.equal(answer.status, 200);
    const settings = (answer.json as { settings: Array<Record<string, number | string | null>> }).settings;
    assert.equal(settings[0].key, "default");
    assert.equal(settings[0].slotRatio, 0.15);
    assert.equal(settings[0].maxPromotedShare, 0.15);
    assert.equal(settings[0].minRelevance, 60);
    assert.equal(settings[0].baseAmountXof, 500);
    assert.equal(settings[0].minAmountXof, 500);
    assert.equal(settings[0].maxAmountXof, 50_000);
    const phones = settings.find((row) => row.key === "smartphones");
    assert.ok(phones);
    assert.equal(phones.slotRatio, 0.2);
    assert.equal(phones.maxActivePerSeller, 3);
    assert.equal(phones.baseAmountXof, null, "pas de surcharge tarifaire : hérite de « default »");
    // Lecture seule : POST et PUT n'existent pas.
    assert.equal(typeof (admin as unknown as Record<string, unknown>).updateSettings, "undefined");
  } finally {
    await env.pool.query("DELETE FROM boost_settings WHERE key = 'smartphones'");
  }
});

test("un acheteur ordinaire avec besoin et correspondance ne gagne aucun droit d'administration", async () => {
  const demand = await makeDemand(env.pool, ordinary.userId);
  const offer = await makeOffer(env.pool, sellerB.userId);
  await makeMatch(env.pool, offer, demand);
  for (const name of ["summary", "vendors", "actions", "settings"] as const) assert.equal((await get(name, ordinary.cookie)).status, 404, name);
});
