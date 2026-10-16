import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { createAdminHttpHandlers, type AdminHttpHandlers } from "../../lib/server/admin/http";
import { grantAdmin } from "../../lib/server/admin/grant";
import { createReportsHttpHandlers, type ReportsHttpHandlers } from "../../lib/server/reports/http";
import { REPORTS_DAILY_LIMIT } from "../../lib/reports-rules";
import { makeMatch, makeOffer } from "./metrics-fixtures";
import { NOT_FOUND, count, login, makeMarket, openTestSchema, reply, request, resetSocial, type Login, type Market, type TestSchema } from "./social-fixtures";

/**
 * Signalements et dossiers de modération (lot FIN3-C2) : accès à la cible (404 indiscernable), un seul dossier ouvert par auteur et par cible, limite quotidienne, texte sans numéro,
 * file de l'administrateur (numéros masqués), décision avec motif obligatoire, suspension par le chemin existant dans la MÊME transaction, dossier clos immuable.
 */

let env: TestSchema;
let reports: ReportsHttpHandlers;
let admin: AdminHttpHandlers;
let market: Market;
let boss: Login;
let stranger: Login;

before(async () => {
  env = await openTestSchema();
  const common = { pool: env.pool, env: { NOMA_AUTH_ORIGIN: "https://noma.test" }, log: () => {} };
  reports = createReportsHttpHandlers(common);
  admin = createAdminHttpHandlers(common);
  boss = await login(env.pool);
  stranger = await login(env.pool);
  assert.equal((await grantAdmin({ pool: env.pool, phone: boss.phone })).granted, true);
});

after(async () => {
  await env.close();
});

async function wipeAdminActions(): Promise<void> {
  await env.pool.query("ALTER TABLE admin_actions DISABLE TRIGGER trg_admin_actions_immutable");
  await env.pool.query("DELETE FROM admin_actions WHERE action <> 'grant_admin'");
  await env.pool.query("ALTER TABLE admin_actions ENABLE TRIGGER trg_admin_actions_immutable");
}

async function wipeReports(): Promise<void> {
  await env.pool.query("ALTER TABLE reports DISABLE TRIGGER trg_reports_guard");
  await env.pool.query("DELETE FROM reports");
  await env.pool.query("ALTER TABLE reports ENABLE TRIGGER trg_reports_guard");
}

beforeEach(async () => {
  await wipeReports();
  await resetSocial(env.pool);
  await env.pool.query("UPDATE users SET status = 'active', archived_at = NULL WHERE status = 'suspended'");
  await wipeAdminActions();
  market = await makeMarket(env.pool);
});

type Json = Record<string, unknown>;
const offerBody = (m: Market, extra: Json = {}) => ({ targetType: "offer", targetId: m.offer.id, demandId: m.demand.id, reason: "fraud", detail: "Le prix affiché n'est pas celui annoncé.", ...extra });
const send = (body: unknown, cookie: string | null, origin?: string | null) => reports.create(request("POST", "/api/reports", { cookie, origin, body })).then(reply);
const mine = (cookie: string | null) => reports.list(request("GET", "/api/reports", { cookie })).then(reply);
const queue = (cookie: string | null, query = "") => admin.reports(request("GET", "/api/admin/reports", { cookie, query })).then(reply);
const one = (id: string, cookie: string | null) => admin.report(request("GET", `/api/admin/reports/${id}`, { cookie }), id).then(reply);
const decide = (id: string, body: unknown, cookie: string | null, origin?: string | null) =>
  admin.reportDecision(request("POST", `/api/admin/reports/${id}/decision`, { cookie, origin, body }), id).then(reply);

async function makeOrder(m: Market): Promise<string> {
  const inserted = await env.pool.query<{ id: string }>(
    "INSERT INTO orders (demand_id, offer_id, buyer_id, seller_id, price_amount) VALUES ($1, $2, $3, $4, 250000) RETURNING id",
    [m.demand.id, m.offer.id, m.buyer.userId, m.seller.userId],
  );
  return inserted.rows[0].id;
}

test("signaler une annonce de ses correspondances : 201, un dossier OUVERT, le compte signalé est le vendeur ; la liste de l'auteur ne montre ni décision ni motif", async () => {
  const created = await send(offerBody(market), market.buyer.cookie);
  assert.equal(created.status, 201);
  const report = (created.json as { report: Json }).report;
  assert.deepEqual(Object.keys(report).sort(), ["createdAt", "id", "status"]);
  assert.equal(report.status, "open");
  const row = (await env.pool.query("SELECT reporter_id, reported_user_id, target_type, offer_id, demand_id, reason, status FROM reports")).rows[0];
  assert.equal(row.reporter_id, market.buyer.userId);
  assert.equal(row.reported_user_id, market.seller.userId, "le compte signalé est figé : le vendeur de l'annonce");
  assert.equal(row.target_type, "offer");
  assert.equal(row.status, "open");
  const listed = await mine(market.buyer.cookie);
  assert.equal(listed.status, 200);
  const items = (listed.json as { reports: Json[] }).reports;
  assert.equal(items.length, 1);
  assert.deepEqual(Object.keys(items[0]).sort(), ["createdAt", "id", "reason", "status", "targetTitle", "targetType"]);
  assert.equal(items[0].targetTitle, "Apple iPhone 13 128 Go");
  assert.ok(!listed.text.includes(market.seller.userId), "jamais l'identifiant du compte signalé");
  assert.deepEqual(((await mine(stranger.cookie)).json as { reports: unknown[] }).reports, [], "chacun ne voit que les siens");
});

test("accès : un tiers, le vendeur, un besoin d'un autre, une annonce hors correspondance, une origine fausse, aucune session : refus identiques, rien n'est écrit", async () => {
  const other = await makeOffer(env.pool, market.seller.userId); // publiée mais SANS correspondance avec le besoin
  for (const [body, cookie] of [
    [offerBody(market), stranger.cookie],
    [offerBody(market), market.seller.cookie],
    [offerBody(market, { targetId: other.id }), market.buyer.cookie],
    [offerBody(market, { demandId: "00000000-0000-4000-8000-000000000000" }), market.buyer.cookie],
    [offerBody(market, { targetId: "00000000-0000-4000-8000-000000000000" }), market.buyer.cookie],
  ] as const) {
    const refused = await send(body, cookie);
    assert.equal(refused.status, 404, JSON.stringify(body));
    assert.deepEqual(refused.json, NOT_FOUND);
  }
  assert.equal((await send(offerBody(market), market.buyer.cookie, "https://autre.test")).status, 403);
  assert.equal((await send(offerBody(market), null)).status, 401);
  assert.equal(await count(env.pool, "reports"), 0);
});

test("annonce retirée depuis que l'acheteur l'avait parmi ses correspondances : toujours signalable ; une annonce jamais correspondante : 404", async () => {
  await env.pool.query("UPDATE offers SET status = 'paused' WHERE id = $1", [market.offer.id]);
  assert.equal((await send(offerBody(market, { reason: "unavailable" }), market.buyer.cookie)).status, 201);
});

test("un seul dossier OUVERT par auteur et par cible : 409 already_reported ; un nouveau signalement est possible une fois le dossier clos", async () => {
  assert.equal((await send(offerBody(market), market.buyer.cookie)).status, 201);
  const again = await send(offerBody(market, { reason: "other" }), market.buyer.cookie);
  assert.equal(again.status, 409);
  assert.equal((again.json as { error: { code: string } }).error.code, "already_reported");
  assert.equal(await count(env.pool, "reports"), 1);
  const id = (await env.pool.query<{ id: string }>("SELECT id FROM reports")).rows[0].id;
  assert.equal((await decide(id, { decision: "dismissed", note: "Aucun problème constaté." }, boss.cookie)).status, 200);
  assert.equal((await send(offerBody(market), market.buyer.cookie)).status, 201);
});

test(`limite quotidienne : ${REPORTS_DAILY_LIMIT} signalements par jour UTC, exacte sous concurrence ; la suivante : 429 reports_daily_limit`, async () => {
  const offers = [];
  for (let index = 0; index < REPORTS_DAILY_LIMIT + 2; index += 1) offers.push(await makeOffer(env.pool, market.seller.userId));
  for (const offer of offers) await makeMatch(env.pool, offer, market.demand);
  const results = await Promise.all(offers.map((offer) => send(offerBody(market, { targetId: offer.id }), market.buyer.cookie)));
  const statuses = results.map((result) => result.status).sort();
  assert.equal(statuses.filter((status) => status === 201).length, REPORTS_DAILY_LIMIT);
  const refused = results.filter((result) => result.status === 429);
  assert.equal(refused.length, 2);
  assert.equal((refused[0].json as { error: { code: string } }).error.code, "reports_daily_limit");
  assert.equal(await count(env.pool, "reports"), REPORTS_DAILY_LIMIT);
});

test("signaler une commande : ses deux parties seulement ; le compte signalé est l'autre partie ; un tiers : 404", async () => {
  const orderId = await makeOrder(market);
  const body = { targetType: "order", targetId: orderId, reason: "abusive" };
  assert.equal((await send(body, stranger.cookie)).status, 404);
  assert.equal((await send(body, market.seller.cookie)).status, 201);
  const row = (await env.pool.query("SELECT reporter_id, reported_user_id, order_id, offer_id, demand_id FROM reports")).rows[0];
  assert.equal(row.reporter_id, market.seller.userId);
  assert.equal(row.reported_user_id, market.buyer.userId, "le vendeur signale l'acheteur");
  assert.equal(row.order_id, orderId);
  assert.equal(row.offer_id, null);
  assert.equal((await send(body, market.buyer.cookie)).status, 201, "l'acheteur peut aussi signaler la même commande (dossier distinct)");
});

test("texte libre : aucun numéro de téléphone (400 phone_number_in_report), pas de clé inconnue, motif connu, tailles bornées ; rien n'est écrit", async () => {
  for (const detail of ["appelez le 07 00 00 00 42", "whatsapp +225 07 11 22 33 44", "0700000042"]) {
    const refused = await send(offerBody(market, { detail }), market.buyer.cookie);
    assert.equal(refused.status, 400, detail);
    assert.equal((refused.json as { error: { code: string } }).error.code, "phone_number_in_report");
  }
  for (const bad of [{ reason: "nimporte" }, { extra: 1 }, { detail: "x".repeat(501) }, { detail: 12 }, { targetType: "user" }, { demandId: null }, { targetId: "pas-un-uuid" }, { detail: "a‮b" }]) {
    assert.equal((await send(offerBody(market, bad), market.buyer.cookie)).status, 400, JSON.stringify(bad));
  }
  assert.equal((await send("[]", market.buyer.cookie)).status, 400);
  assert.equal(await count(env.pool, "reports"), 0);
  assert.equal((await send(offerBody(market, { detail: null }), market.buyer.cookie)).status, 201, "le texte est facultatif");
});

test("administration : la file est réservée à l'administrateur (404 sinon), numéros masqués, ouverts du plus ancien ; le dossier montre les faits sans contact ni texte brut", async () => {
  await send(offerBody(market), market.buyer.cookie);
  for (const cookie of [null, market.buyer.cookie, stranger.cookie]) {
    const refused = await queue(cookie);
    assert.equal(refused.status, 404, String(cookie));
    assert.deepEqual(refused.json, NOT_FOUND);
  }
  const listed = await queue(boss.cookie);
  assert.equal(listed.status, 200);
  const body = listed.json as { total: number; reports: Json[] };
  assert.equal(body.total, 1);
  const row = body.reports[0];
  assert.equal(row.status, "open");
  assert.equal(row.reportedOpenCount, 1);
  assert.match(String(row.reportedMaskedPhone), /^\+•+\d{2}$/);
  assert.ok(!listed.text.includes(market.seller.phone) && !listed.text.includes(market.buyer.phone), "aucun numéro entier");
  assert.ok(!listed.text.includes(market.seller.userId) && !listed.text.includes(market.buyer.userId), "aucun identifiant de compte");
  const detail = await one(String(row.id), boss.cookie);
  assert.equal(detail.status, 200);
  const report = (detail.json as { report: Json }).report;
  assert.equal(report.detail, "Le prix affiché n'est pas celui annoncé.");
  assert.equal(report.reportedStatus, "active");
  assert.equal(report.reportedTotalCount, 1);
  assert.deepEqual(report.offer, { status: "published", availability: report.offer && (report.offer as Json).availability, priceAmount: 250000, priceCurrency: "XOF" });
  assert.equal(report.order, null);
  assert.ok(!detail.text.includes("RAW_SECRET_TEXT"));
  assert.equal((await queue(boss.cookie, "?status=closed")).status, 200);
  assert.equal((await queue(boss.cookie, "?status=autre")).status, 400);
  assert.equal((await queue(boss.cookie, "?limit=0")).status, 400);
});

test("décision « classé sans suite » : le dossier est clos avec décision, motif et auteur ; rien ne change pour le compte signalé ; l'auteur voit « clos » sans le motif", async () => {
  await send(offerBody(market), market.buyer.cookie);
  const id = (await env.pool.query<{ id: string }>("SELECT id FROM reports")).rows[0].id;
  const result = await decide(id, { decision: "dismissed", note: "Annonce conforme après vérification." }, boss.cookie);
  assert.equal(result.status, 200);
  assert.deepEqual(result.json, { contractVersion: "reports/v1", status: "closed", decision: "dismissed", suspended: false });
  const row = (await env.pool.query("SELECT status, decision, decision_note, decided_by FROM reports")).rows[0];
  assert.deepEqual([row.status, row.decision, row.decision_note, row.decided_by], ["closed", "dismissed", "Annonce conforme après vérification.", boss.userId]);
  assert.equal((await env.pool.query("SELECT status FROM users WHERE id = $1", [market.seller.userId])).rows[0].status, "active");
  assert.equal(await count(env.pool, "admin_actions", "action <> 'grant_admin'"), 0);
  const listed = await mine(market.buyer.cookie);
  assert.equal(((listed.json as { reports: Json[] }).reports)[0].status, "closed");
  assert.ok(!listed.text.includes("conforme"), "l'auteur ne lit jamais le motif de l'administrateur");
  const again = await decide(id, { decision: "dismissed", note: "Encore." }, boss.cookie);
  assert.equal(again.status, 409);
  assert.equal((again.json as { error: { code: string } }).error.code, "report_closed");
});

test("décision « compte suspendu » : le vendeur est suspendu par le chemin existant, UNE ligne du journal « qui, quoi, quand », dossier clos dans la même transaction ; sa session est refusée", async () => {
  await send(offerBody(market), market.buyer.cookie);
  const id = (await env.pool.query<{ id: string }>("SELECT id FROM reports")).rows[0].id;
  const result = await decide(id, { decision: "seller_suspended", note: "Prix trompeur confirmé." }, boss.cookie);
  assert.equal(result.status, 200);
  assert.deepEqual(result.json, { contractVersion: "reports/v1", status: "closed", decision: "seller_suspended", suspended: true });
  assert.equal((await env.pool.query("SELECT status FROM users WHERE id = $1", [market.seller.userId])).rows[0].status, "suspended");
  const journal = await env.pool.query("SELECT action, admin_id, target_user_id, source FROM admin_actions WHERE action <> 'grant_admin'");
  assert.equal(journal.rowCount, 1);
  assert.deepEqual([journal.rows[0].action, journal.rows[0].admin_id, journal.rows[0].target_user_id, journal.rows[0].source], ["suspend_user", boss.userId, market.seller.userId, "admin_ui"]);
  const session = await reports.list(request("GET", "/api/reports", { cookie: market.seller.cookie }));
  assert.equal(session.status, 401, "la session d'un compte suspendu est refusée");
});

test("décision refusée : motif absent, vide, avec numéro ou décision inconnue : 400 ; origine fausse : 403 ; non-administrateur : 404 ; dossier inconnu : 404 ; le dossier reste ouvert", async () => {
  await send(offerBody(market), market.buyer.cookie);
  const id = (await env.pool.query<{ id: string }>("SELECT id FROM reports")).rows[0].id;
  for (const body of [{ decision: "dismissed" }, { decision: "dismissed", note: "   " }, { decision: "dismissed", note: "appelez le 0700000042" }, { decision: "bannir", note: "x" }, { decision: "dismissed", note: "x", extra: true }, { decision: "dismissed", note: "x".repeat(501) }]) {
    assert.equal((await decide(id, body, boss.cookie)).status, 400, JSON.stringify(body));
  }
  assert.equal((await decide(id, { decision: "dismissed", note: "ok" }, boss.cookie, "https://autre.test")).status, 403);
  assert.equal((await decide(id, { decision: "dismissed", note: "ok" }, market.buyer.cookie)).status, 404);
  assert.equal((await decide(id, { decision: "dismissed", note: "ok" }, null)).status, 404);
  assert.equal((await decide("00000000-0000-4000-8000-000000000000", { decision: "dismissed", note: "ok" }, boss.cookie)).status, 404);
  assert.equal((await env.pool.query("SELECT status FROM reports")).rows[0].status, "open");
});

test("suspension impossible (compte signalé administrateur) : refus 409, le dossier RESTE OUVERT et rien n'est écrit ; il peut alors être classé sans suite", async () => {
  const adminSeller = await login(env.pool);
  assert.equal((await grantAdmin({ pool: env.pool, phone: adminSeller.phone })).granted, true);
  const m = await makeMarket(env.pool);
  await env.pool.query("UPDATE offers SET owner_id = $1 WHERE id = $2", [adminSeller.userId, m.offer.id]);
  // Le besoin n'a pas bougé : l'annonce déplacée chez l'administrateur reste une correspondance confirmée du besoin de l'acheteur.
  await env.pool.query("INSERT INTO reports (reporter_id, reported_user_id, target_type, offer_id, demand_id, reason) VALUES ($1, $2, 'offer', $3, $4, 'fraud')", [m.buyer.userId, adminSeller.userId, m.offer.id, m.demand.id]);
  const id = (await env.pool.query<{ id: string }>("SELECT id FROM reports WHERE offer_id = $1", [m.offer.id])).rows[0].id;
  const refused = await decide(id, { decision: "seller_suspended", note: "Test." }, boss.cookie);
  assert.equal(refused.status, 409);
  assert.equal((refused.json as { error: { code: string } }).error.code, "target_protected");
  assert.equal((await env.pool.query("SELECT status FROM reports WHERE id = $1", [id])).rows[0].status, "open");
  assert.equal(await count(env.pool, "admin_actions", "action <> 'grant_admin'"), 0);
  assert.equal((await decide(id, { decision: "dismissed", note: "Compte administrateur : classé." }, boss.cookie)).status, 200);
});

test("base : un dossier clos ne se modifie ni ne se supprime, les éléments d'un signalement ne changent jamais, la clôture exige décision, motif et auteur", async () => {
  await send(offerBody(market), market.buyer.cookie);
  const id = (await env.pool.query<{ id: string }>("SELECT id FROM reports")).rows[0].id;
  for (const sql of ["UPDATE reports SET reason = 'other'", "UPDATE reports SET detail = 'autre'", "UPDATE reports SET reporter_id = reported_user_id", "UPDATE reports SET created_at = created_at - interval '1 day'"]) {
    await assert.rejects(() => env.pool.query(sql), /reports_immutable|chk_reports_not_self/, sql);
  }
  await assert.rejects(() => env.pool.query("UPDATE reports SET status = 'closed'"), /chk_reports_decision/);
  await assert.rejects(() => env.pool.query("DELETE FROM reports"), /reports_immutable/);
  await decide(id, { decision: "dismissed", note: "Classé." }, boss.cookie);
  await assert.rejects(() => env.pool.query("UPDATE reports SET decision_note = 'autre'"), /reports_closed/);
  await assert.rejects(() => env.pool.query("DELETE FROM reports"), /reports_immutable/);
  await assert.rejects(
    () => env.pool.query("INSERT INTO reports (reporter_id, reported_user_id, target_type, order_id, reason) VALUES ($1, $1, 'order', gen_random_uuid(), 'other')", [stranger.userId]),
    /chk_reports_not_self|violates/,
  );
});
