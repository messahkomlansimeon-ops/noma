import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";
import { Pool } from "pg";
import { getDemandById } from "../../lib/server/catalog";
import { runMatchingCycle } from "../../lib/server/matching/runner";
import { MISSIONS_WATCH_SQL, runMissionsStep } from "../../lib/server/missions/step";
import { createNotificationsHttpHandlers } from "../../lib/server/notifications/http";
import {
  ENV, addCandidate, ageClosedMission, ageCoverageNotifications, carrierStatus, count, createMissionCall, login, makeDue, makeHandlers, missionOf, openTestSchema, orderOf, readMissionCall, reply, request, resetSocial, settle,
  startMission, actMissionCall, type Handlers, type Login, type TestSchema,
} from "./missions-fixtures";
import { insertEvaluation } from "./boost-fixtures";
import { createTemporarySchemaName, openVerifiedTestDatabase, quoteTemporarySchema } from "./test-database";

/**
 * Étape « missions » du runner (lot MV1) : échéance (passe à « échue », idempotent), relecture de la couverture quand de nouvelles annonces correspondent, notification de hausse
 * (dans l'application, au plus une par jour et par mission, jamais pour ce que l'acheteur voit déjà), isolement dans le cycle, étape ignorée sans la migration 0027.
 */

let env: TestSchema;
let h: Handlers;
let buyer: Login;
let notifications: ReturnType<typeof createNotificationsHttpHandlers>;

before(async () => {
  env = await openTestSchema();
  h = makeHandlers(env.pool);
  notifications = createNotificationsHttpHandlers({ pool: env.pool, env: ENV, log: () => {} });
});

after(async () => {
  await env.close();
});

beforeEach(async () => {
  await resetSocial(env.pool);
  buyer = await login(env.pool);
});

const step = () => runMissionsStep({ pool: env.pool });
const row = async (id: string) =>
  (await env.pool.query<{ status: string; covered_quantity: number | null; notified_quantity: number | null; evaluated_at: Date | null; closed_at: Date | null }>(
    "SELECT status, covered_quantity, notified_quantity, evaluated_at, closed_at FROM missions WHERE id = $1", [id])).rows[0];
const coverageNotifications = (missionId: string) => count(env.pool, "notifications", `kind = 'mission_coverage' AND mission_id = '${missionId}'`);
/** Laisse l'évaluation lue comme « déjà vue » : plus aucune évaluation n'est plus récente que la dernière lecture. */
const agedEvaluations = (demandId: string) => env.pool.query("UPDATE matching_evaluations SET evaluated_at = evaluated_at - interval '1 hour' WHERE demand_id = $1", [demandId]);

describe("échéance", () => {
  test("les missions ouvertes échues passent à « échue » (active ou en pause), leur besoin porteur reste actif 24 h puis est archivé ; le reste n'est jamais touché ; idempotent", async () => {
    const active = await startMission(env.pool, h, buyer);
    const paused = await startMission(env.pool, h, buyer);
    await actMissionCall(h, buyer.cookie, paused.id, "pause");
    const notDue = await startMission(env.pool, h, buyer);
    const draft = missionOf(await createMissionCall(h, buyer.cookie)).id as string;
    const cancelled = await startMission(env.pool, h, buyer);
    await actMissionCall(h, buyer.cookie, cancelled.id, "cancel");
    await makeDue(env.pool, active.id);
    await makeDue(env.pool, paused.id);
    // Une mission annulée, même « échue » sur le papier, reste annulée.
    await env.pool.query("ALTER TABLE missions DISABLE TRIGGER trg_missions_transition");
    await env.pool.query("UPDATE missions SET deadline_at = clock_timestamp() - interval '2 hours' WHERE id = $1", [cancelled.id]);
    await env.pool.query("ALTER TABLE missions ENABLE TRIGGER trg_missions_transition");
    const first = await step();
    assert.equal(first.skipped, false);
    assert.equal(first.expired, 2);
    assert.deepEqual(first.errors, []);
    for (const live of [active, paused]) {
      const state = await row(live.id);
      assert.equal(state.status, "expired");
      assert.notEqual(state.closed_at, null);
      assert.equal((await getDemandById(buyer.userId, live.demandId, env.pool))?.status, "active", "le besoin porteur n'est archivé que 24 h après la fin de la mission");
    }
    assert.equal((await row(notDue.id)).status, "active");
    assert.equal((await getDemandById(buyer.userId, notDue.demandId, env.pool))?.status, "active");
    assert.equal((await row(draft)).status, "draft");
    assert.equal((await row(cancelled.id)).status, "cancelled");
    // Rejouée : rien ne bouge, aucune erreur ; 24 h plus tard, un seul archivage par besoin porteur.
    const second = await step();
    assert.deepEqual([second.expired, second.released, second.errors.length], [0, 0, 0]);
    assert.equal(await count(env.pool, "matching_outbox_events", `aggregate_id = '${active.demandId}' AND event_type = 'demand.archived'`), 0);
    for (const live of [active, paused]) await ageClosedMission(env.pool, live.id, 25);
    const third = await step();
    assert.deepEqual([third.released, third.errors.length], [2, 0]);
    assert.equal((await step()).released, 0);
    for (const live of [active, paused]) {
      assert.equal((await getDemandById(buyer.userId, live.demandId, env.pool))?.status, "archived");
      assert.equal(await count(env.pool, "matching_outbox_events", `aggregate_id = '${live.demandId}' AND event_type = 'demand.archived'`), 1);
    }
    // Une mission échue est définitive.
    assert.equal((await actMissionCall(h, buyer.cookie, active.id, "resume")).status, 409);
    assert.equal(missionOf(await readMissionCall(h, buyer.cookie, active.id)).status, "expired");
  });

  test("deux processus en même temps : chaque mission échoit une seule fois, sans erreur", async () => {
    const lives = [await startMission(env.pool, h, buyer), await startMission(env.pool, h, buyer), await startMission(env.pool, h, buyer)];
    for (const live of lives) await makeDue(env.pool, live.id);
    const results = await Promise.all([step(), step(), step()]);
    assert.equal(results.reduce((sum, result) => sum + result.expired, 0), 3);
    assert.deepEqual(results.flatMap((result) => result.errors), []);
    for (const live of lives) assert.equal((await row(live.id)).status, "expired");
  });

  test("les achats encore proposés d'une mission échue restent tels quels (le vendeur peut encore décider) ; une confirmation tardive ne rouvre pas la mission", async () => {
    const live = await startMission(env.pool, h, buyer, { quantity: 4 });
    const seller = await login(env.pool);
    const candidate = await addCandidate(env.pool, live, { quantity: 4, seller: { id: seller.userId, phone: seller.phone } });
    const order = orderOf(await reply(await h.social.orders.declare(request("POST", `/api/demands/${live.demandId}/offers/${candidate.offer.id}/orders`, { cookie: buyer.cookie, body: { priceXof: 150_000, quantity: 4 } }), live.demandId, candidate.offer.id)));
    await makeDue(env.pool, live.id);
    await step();
    assert.equal((await row(live.id)).status, "expired");
    assert.equal((await env.pool.query<{ status: string }>("SELECT status FROM orders WHERE id = $1", [order.id])).rows[0].status, "proposed");
    const late = await reply(await h.social.orders.act(request("POST", `/api/orders/${order.id}/confirm`, { cookie: seller.cookie, body: {} }), order.id as string, "confirm"));
    assert.equal(late.status, 200);
    assert.equal((await row(live.id)).status, "expired", "une mission échue reste échue");
  });

  test("dans le cycle du runner : le résultat porte l'étape, une mission échue n'est pas du repos, le cycle suivant l'est", async () => {
    const live = await startMission(env.pool, h, buyer);
    await makeDue(env.pool, live.id);
    // Le matching du besoin porteur est traité par les cycles ; on vide d'abord ce travail pour ne mesurer que l'étape.
    for (let index = 0; index < 20; index += 1) if ((await runMatchingCycle({ pool: env.pool, workerId: "mission-test", notificationTransport: null })).idle) break;
    assert.equal((await row(live.id)).status, "expired");
    const quiet = await runMatchingCycle({ pool: env.pool, workerId: "mission-test", notificationTransport: null });
    assert.deepEqual(quiet.errors, []);
    assert.equal(quiet.missions.skipped, false);
    assert.deepEqual([quiet.missions.expired, quiet.missions.changed, quiet.missions.notified], [0, 0, 0]);
    assert.equal(quiet.idle, true);
  });
});

describe("couverture et notification", () => {
  test("le matching du besoin porteur n'est pas terminé : rien n'est lu ; ensuite la première lecture pose la base SANS notification", async () => {
    const live = await startMission(env.pool, h, buyer, { quantity: 6 });
    await addCandidate(env.pool, live, { quantity: 2 });
    let result = await step();
    assert.deepEqual([result.evaluated, result.notified], [0, 0], "événement du besoin en attente : pas encore");
    assert.equal((await row(live.id)).covered_quantity, null);
    await settle(env.pool, live.demandId);
    result = await step();
    assert.deepEqual([result.evaluated, result.changed, result.notified], [1, 1, 0], "base de comparaison silencieuse");
    const state = await row(live.id);
    assert.deepEqual([state.covered_quantity, state.notified_quantity], [2, 2]);
    assert.equal(await coverageNotifications(live.id), 0, "l'acheteur voit déjà ces annonces : jamais de bruit à la création");
    // Une relecture sans nouvelle évaluation ne change rien.
    await agedEvaluations(live.demandId);
    assert.deepEqual([(await step()).evaluated, (await step()).notified], [0, 0]);
  });

  test("une hausse de couverture : UNE notification dans l'application (genre, titre, quantité, lien) ; une deuxième hausse le même jour n'en crée pas ; le lendemain, la hausse retenue part", async () => {
    const live = await startMission(env.pool, h, buyer, { quantity: 6 });
    await settle(env.pool, live.demandId);
    await step();
    assert.equal((await row(live.id)).covered_quantity, 0);
    await addCandidate(env.pool, live, { quantity: 2 });
    const first = await step();
    assert.deepEqual([first.evaluated, first.changed, first.notified], [1, 1, 1]);
    assert.equal(await coverageNotifications(live.id), 1);
    const stored = (await env.pool.query<{ user_id: string; kind: string; title: string; item_count: number; demand_id: string; offer_id: string | null; price_amount: string | null }>(
      "SELECT user_id, kind, title, item_count, demand_id, offer_id, price_amount FROM notifications WHERE mission_id = $1", [live.id])).rows[0];
    assert.equal(stored.user_id, buyer.userId);
    assert.equal(stored.title, "Apple iPhone 13 128 Go : 2 sur 6");
    assert.deepEqual([stored.item_count, stored.demand_id, stored.offer_id, stored.price_amount], [2, live.demandId, null, null]);
    // Lisible par l'acheteur par l'API des notifications, avec le lien vers la mission.
    const listed = await reply(await notifications.notifications.list(request("GET", "/api/notifications", { cookie: buyer.cookie })));
    const items = (listed.json as { unreadCount: number; items: Array<Record<string, unknown>> });
    assert.equal(items.unreadCount, 1);
    assert.deepEqual(items.items.map((item) => [item.kind, item.title, item.count, item.offerId, item.link]), [["mission_coverage", "Apple iPhone 13 128 Go : 2 sur 6", 2, null, `/missions/${live.id}`]]);
    assert.ok(!listed.text.includes("173456") && !listed.text.includes("1234567"), "jamais le budget dans une notification");
    // Deuxième hausse, le même jour : retenue (une notification par jour et par mission).
    await addCandidate(env.pool, live, { quantity: 1 });
    const second = await step();
    assert.deepEqual([second.evaluated, second.changed, second.notified], [1, 1, 0]);
    assert.equal(await coverageNotifications(live.id), 1);
    let state = await row(live.id);
    assert.deepEqual([state.covered_quantity, state.notified_quantity], [3, 2]);
    assert.equal((await step()).notified, 0, "toujours retenue ce jour-là");
    await assert.rejects(
      () => env.pool.query("INSERT INTO notifications (user_id, kind, demand_id, mission_id, digest_day, item_count, title) VALUES ($1, 'mission_coverage', $2, $3, (clock_timestamp() AT TIME ZONE 'UTC')::date, 3, 't')", [buyer.userId, live.demandId, live.id]),
      /uq_notifications_mission_coverage/,
    );
    // Le lendemain : la hausse retenue est signalée, une seule fois.
    await ageCoverageNotifications(env.pool, live.id);
    const next = await step();
    assert.equal(next.notified, 1);
    assert.equal(await coverageNotifications(live.id), 2);
    state = await row(live.id);
    assert.deepEqual([state.covered_quantity, state.notified_quantity], [3, 3]);
    assert.equal((await step()).notified, 0);
    // Aucun envoi externe ni message : seulement des notifications dans l'application.
    assert.equal(await count(env.pool, "notification_deliveries"), 0);
    assert.equal(await count(env.pool, "messages"), 0);
    assert.equal(await count(env.pool, "orders"), 0);
  });

  test("une baisse puis une remontée : la base de comparaison est le plus haut niveau vu, elle ne baisse pas ; seule une couverture qui le dépasse notifie", async () => {
    const live = await startMission(env.pool, h, buyer, { quantity: 6 });
    await settle(env.pool, live.demandId);
    const a = await addCandidate(env.pool, live, { quantity: 3 });
    await step();
    assert.deepEqual([(await row(live.id)).covered_quantity, (await row(live.id)).notified_quantity], [3, 3]);
    await env.pool.query("UPDATE offers SET status = 'paused' WHERE id = $1", [a.offer.id]);
    await env.pool.query("UPDATE matching_evaluations SET evaluated_at = clock_timestamp() WHERE demand_id = $1", [live.demandId]);
    const drop = await step();
    assert.deepEqual([drop.evaluated, drop.notified], [1, 0]);
    assert.deepEqual([(await row(live.id)).covered_quantity, (await row(live.id)).notified_quantity], [0, 3], "la couverture lue baisse, le plus haut niveau vu (3) reste");
    await addCandidate(env.pool, live, { quantity: 1 });
    const rise = await step();
    assert.deepEqual([rise.evaluated, rise.notified], [1, 0], "1 < 3 : déjà dépassé, rien à annoncer");
    assert.equal(await coverageNotifications(live.id), 0);
    await addCandidate(env.pool, live, { quantity: 3 });
    assert.equal((await step()).notified, 1, "4 > 3 : nouveau record");
    assert.equal(await coverageNotifications(live.id), 1);
  });

  test("mission en pause, terminée, annulée ou brouillon : aucune relecture, aucune notification", async () => {
    const paused = await startMission(env.pool, h, buyer, { quantity: 6 });
    await settle(env.pool, paused.demandId);
    await step();
    await addCandidate(env.pool, paused, { quantity: 2 });
    await actMissionCall(h, buyer.cookie, paused.id, "pause");
    const result = await step();
    assert.deepEqual([result.evaluated, result.notified], [0, 0]);
    assert.equal(await coverageNotifications(paused.id), 0);
    await actMissionCall(h, buyer.cookie, paused.id, "resume");
    assert.equal((await step()).notified, 1, "reprise : la hausse est signalée");
  });

  test("une hausse retenue (déjà notifié ce jour-là) ne part JAMAIS pendant une pause ; elle part à la reprise, le jour suivant", async () => {
    const live = await startMission(env.pool, h, buyer, { quantity: 6 });
    await settle(env.pool, live.demandId);
    await step();
    await addCandidate(env.pool, live, { quantity: 1 });
    assert.equal((await step()).notified, 1);
    await addCandidate(env.pool, live, { quantity: 1 });
    assert.equal((await step()).notified, 0, "retenue : déjà une notification ce jour-là");
    assert.deepEqual([(await row(live.id)).covered_quantity, (await row(live.id)).notified_quantity], [2, 1]);
    await actMissionCall(h, buyer.cookie, live.id, "pause");
    await ageCoverageNotifications(env.pool, live.id);
    assert.equal((await step()).notified, 0, "en pause : rien ne part, même un nouveau jour");
    assert.equal(await coverageNotifications(live.id), 1);
    await actMissionCall(h, buyer.cookie, live.id, "resume");
    assert.equal((await step()).notified, 1, "reprise : la hausse retenue est signalée");
    assert.equal(await coverageNotifications(live.id), 2);
  });

  test("un acheteur qui a 5 missions : chacune est lue et notifiée séparément", async () => {
    const lives = [];
    for (let index = 0; index < 3; index += 1) {
      const live = await startMission(env.pool, h, buyer, { quantity: 6 });
      await settle(env.pool, live.demandId);
      lives.push(live);
    }
    await step();
    for (const live of lives) await addCandidate(env.pool, live, { quantity: 1 });
    const result = await step();
    assert.deepEqual([result.evaluated, result.notified], [3, 3]);
    for (const live of lives) assert.equal(await coverageNotifications(live.id), 1);
  });
});

describe("sans la migration 0027, et isolement", () => {
  test("base d'avant 0027 : l'étape est ignorée sans erreur, le cycle du runner aussi (missions.skipped), rien n'est lu ni écrit", async () => {
    const opened = await openVerifiedTestDatabase(process.env.TEST_DATABASE_URL);
    const schema = createTemporarySchemaName();
    await opened.pool.query(`CREATE SCHEMA ${quoteTemporarySchema(schema)}`);
    const pool = new Pool({ connectionString: opened.target.connectionString, max: 4, options: `-c search_path=${schema}` });
    try {
      const directory = join(import.meta.dirname, "../../database/migrations");
      const files = readdirSync(directory).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort();
      assert.ok(files.includes("0027_missions.sql"));
      await pool.query("CREATE TABLE noma_schema_migrations (version TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP)");
      for (const name of files.filter((file) => file < "0027")) {
        await pool.query(readFileSync(join(directory, name), "utf8"));
        await pool.query("INSERT INTO noma_schema_migrations (version, checksum) VALUES ($1, 'x')", [name.slice(0, -4)]);
      }
      assert.equal((await pool.query("SELECT to_regclass('missions') IS NULL AS absent")).rows[0].absent, true);
      assert.deepEqual(await runMissionsStep({ pool }), { skipped: true, expired: 0, evaluated: 0, changed: 0, notified: 0, released: 0, errors: [] });
      const cycle = await runMatchingCycle({ pool, workerId: "sans-0027", notificationTransport: null });
      assert.deepEqual(cycle.errors, []);
      assert.equal(cycle.missions.skipped, true);
      // Sans table de migrations du tout : toujours ignorée, sans erreur.
      await pool.query("DROP TABLE noma_schema_migrations");
      assert.equal((await runMissionsStep({ pool })).skipped, true);
    } finally {
      await pool.end();
      await opened.pool.query(`DROP SCHEMA IF EXISTS ${quoteTemporarySchema(schema)} CASCADE`);
      await opened.pool.end();
    }
  });

  test("une panne de l'étape (table des missions absente alors que la migration est enregistrée) ne change rien aux autres étapes : un code stable dans errors", async () => {
    const opened = await openVerifiedTestDatabase(process.env.TEST_DATABASE_URL);
    const schema = createTemporarySchemaName();
    await opened.pool.query(`CREATE SCHEMA ${quoteTemporarySchema(schema)}`);
    const pool = new Pool({ connectionString: opened.target.connectionString, max: 4, options: `-c search_path=${schema}` });
    try {
      const { runMigrations } = await import("../../lib/server/postgres/migrations");
      await runMigrations(pool);
      await pool.query("DROP TABLE missions CASCADE");
      const cycle = await runMatchingCycle({ pool, workerId: "panne", notificationTransport: null });
      assert.deepEqual(cycle.errors.length, 1);
      assert.match(cycle.errors[0], /^missions_error_[a-z0-9_]+$/);
      assert.ok(cycle.notify, "l'étape « notify » a tourné après l'étape en panne");
      assert.ok(cycle.temporal && cycle.boost && cycle.projected, "les étapes d'avant ont tourné");
    } finally {
      await pool.end();
      await opened.pool.query(`DROP SCHEMA IF EXISTS ${quoteTemporarySchema(schema)} CASCADE`);
      await opened.pool.end();
    }
  });

  test("le cycle du worker : une mission lancée est lue par le vrai cycle, sans erreur, et la notification naît avec la nouvelle annonce", async () => {
    const live = await startMission(env.pool, h, buyer, { quantity: 6 });
    for (let index = 0; index < 30; index += 1) if ((await runMatchingCycle({ pool: env.pool, workerId: "mission-cycle", notificationTransport: null })).idle) break;
    assert.deepEqual([(await row(live.id)).covered_quantity, (await row(live.id)).notified_quantity], [0, 0], "base posée après le matching du besoin porteur");
    await addCandidate(env.pool, live, { quantity: 2 });
    const cycle = await runMatchingCycle({ pool: env.pool, workerId: "mission-cycle", notificationTransport: null });
    assert.deepEqual(cycle.errors, []);
    assert.equal(cycle.missions.notified, 1);
    assert.equal(cycle.idle, false, "une notification née dans le cycle est du travail");
    assert.equal(await coverageNotifications(live.id), 1);
    // Aucune notification annonce par annonce (le suivi du besoin porteur est en pause) ni envoi externe.
    assert.equal(await count(env.pool, "notifications", "kind = 'new_match'"), 0);
    assert.equal(await count(env.pool, "notification_deliveries"), 0);
  });
});

// ═════════════ MV1-bis : échéance, reste à acheter, plus haut niveau notifié, libération des besoins porteurs, coût de la sélection ═════════════

describe("échéance : quantité sécurisée, achats et proposition refusés après l'échéance", () => {
  test("toute la quantité est sécurisée à l'échéance : la mission passe à « terminée », pas à « échue » ; sinon elle échoit", async () => {
    const full = await startMission(env.pool, h, buyer, { quantity: 4 });
    const part = await startMission(env.pool, h, buyer, { quantity: 4 });
    const sellers = [await login(env.pool), await login(env.pool)];
    const ids: string[] = [];
    for (const [live, quantity, seller] of [[full, 4, sellers[0]], [part, 2, sellers[1]]] as const) {
      const candidate = await addCandidate(env.pool, live, { quantity: 4, seller: { id: seller.userId, phone: seller.phone } });
      const order = orderOf(await reply(await h.social.orders.declare(request("POST", `/api/demands/${live.demandId}/offers/${candidate.offer.id}/orders`, { cookie: buyer.cookie, body: { priceXof: 150_000, quantity } }), live.demandId, candidate.offer.id)));
      ids.push(order.id as string);
    }
    // Les achats sont confirmés AVANT que la mission ne soit recomptée (course entre une confirmation et l'étape : la quantité est sécurisée sans que la mission soit terminée).
    await env.pool.query("UPDATE orders SET status = 'confirmed', decided_at = clock_timestamp() WHERE id = ANY($1::uuid[])", [ids]);
    assert.equal((await row(full.id)).status, "active");
    await makeDue(env.pool, full.id);
    await makeDue(env.pool, part.id);
    const result = await step();
    assert.deepEqual([result.expired, result.errors], [2, []]);
    assert.equal((await row(full.id)).status, "completed", "toute la quantité (4 sur 4) est confirmée à l'échéance");
    assert.equal((await row(part.id)).status, "expired", "2 sur 4 : échue");
  });

  test("après l'échéance, avant l'étape : proposition fermée, achat refusé, pause et reprise refusées ; la mission est encore « active » en base", async () => {
    const live = await startMission(env.pool, h, buyer, { quantity: 4 });
    const seller = await login(env.pool);
    const candidate = await addCandidate(env.pool, live, { quantity: 4, seller: { id: seller.userId, phone: seller.phone } });
    await makeDue(env.pool, live.id);
    assert.equal((await row(live.id)).status, "active");
    const proposal = (await reply(await h.missions.proposal(request("GET", `/api/missions/${live.id}/proposal`, { cookie: buyer.cookie }), live.id))).json as { proposal: { state: string; lines: unknown[]; engaged: unknown[] } };
    assert.equal(proposal.proposal.state, "inactive");
    assert.deepEqual([proposal.proposal.lines.length, proposal.proposal.engaged.length], [0, 0]);
    const declared = await reply(await h.social.orders.declare(request("POST", `/api/demands/${live.demandId}/offers/${candidate.offer.id}/orders`, { cookie: buyer.cookie, body: { priceXof: 150_000, quantity: 2 } }), live.demandId, candidate.offer.id));
    assert.equal(declared.status, 409);
    assert.equal((declared.json as { error: { code: string } }).error.code, "mission_not_active");
    assert.equal(await count(env.pool, "orders"), 0);
    assert.equal((await actMissionCall(h, buyer.cookie, live.id, "pause")).status, 409);
    await env.pool.query("ALTER TABLE missions DISABLE TRIGGER trg_missions_transition");
    await env.pool.query("UPDATE missions SET status = 'paused' WHERE id = $1", [live.id]);
    await env.pool.query("ALTER TABLE missions ENABLE TRIGGER trg_missions_transition");
    assert.equal((await actMissionCall(h, buyer.cookie, live.id, "resume")).status, 409);
    assert.equal((await step()).expired, 1);
    assert.equal((await row(live.id)).status, "expired");
  });
});

describe("la proposition répartit le RESTE ; la couverture lue par l'étape compte l'engagé", () => {
  test("couverture = engagé + proposé (jamais le double) : la quantité déjà commandée n'est pas reproposée", async () => {
    const live = await startMission(env.pool, h, buyer, { quantity: 4, unitBudgetXof: 100_000, totalBudgetXof: 400_000 });
    const [sa, sb, sc] = [await login(env.pool), await login(env.pool), await login(env.pool)];
    const a = await addCandidate(env.pool, live, { price: 100_000, quantity: 2, score: 99, seller: { id: sa.userId, phone: sa.phone } });
    await addCandidate(env.pool, live, { price: 100_000, quantity: 2, score: 95, seller: { id: sb.userId, phone: sb.phone } });
    await addCandidate(env.pool, live, { price: 100_000, quantity: 2, score: 90, seller: { id: sc.userId, phone: sc.phone } });
    await settle(env.pool, live.demandId);
    await step();
    assert.equal((await row(live.id)).covered_quantity, 4, "avant tout achat : 2 + 2");
    // Plus aucune évaluation plus récente que la lecture : seule une COMMANDE changée peut faire relire la couverture.
    await agedEvaluations(live.demandId);
    assert.equal((await step()).evaluated, 0, "rien n'a changé : pas de relecture");
    const order = orderOf(await reply(await h.social.orders.declare(request("POST", `/api/demands/${live.demandId}/offers/${a.offer.id}/orders`, { cookie: buyer.cookie, body: { priceXof: 100_000, quantity: 2 } }), live.demandId, a.offer.id)));
    const confirm = await reply(await h.social.orders.act(request("POST", `/api/orders/${order.id}/confirm`, { cookie: sa.cookie, body: {} }), order.id as string, "confirm"));
    assert.equal(confirm.status, 200);
    // L'annonce achetée est retirée (cas normal après une vente) : sans la soustraction de l'engagé, la couverture tomberait à 2 puis serait comptée deux fois.
    await env.pool.query("UPDATE offers SET availability_status = 'unavailable' WHERE id = $1", [a.offer.id]);
    const result = await step();
    assert.deepEqual([result.evaluated, result.errors], [1, []], "la commande a changé depuis la dernière lecture : la couverture est relue");
    assert.equal((await row(live.id)).covered_quantity, 4, "2 achetés + 2 proposés (jamais 4 proposés en plus des 2 achetés)");
  });
});

describe("notification : le plus haut niveau déjà annoncé", () => {
  test("une baisse passagère (annonces retirées puis revenues) ne notifie jamais ce qui a déjà été annoncé (6 → 0 → 6)", async () => {
    const live = await startMission(env.pool, h, buyer, { quantity: 6 });
    const candidates = [];
    for (let index = 0; index < 3; index += 1) candidates.push(await addCandidate(env.pool, live, { price: 150_000, quantity: 2 }));
    await settle(env.pool, live.demandId);
    await step();
    assert.deepEqual([(await row(live.id)).covered_quantity, (await row(live.id)).notified_quantity], [6, 6], "première lecture : base silencieuse");
    const ids = candidates.map((entry) => entry.offer.id);
    await env.pool.query("UPDATE offers SET status = 'paused' WHERE id = ANY($1::uuid[])", [ids]);
    await env.pool.query("UPDATE matching_evaluations SET evaluated_at = clock_timestamp() WHERE demand_id = $1", [live.demandId]);
    const drop = await step();
    assert.deepEqual([drop.evaluated, drop.notified], [1, 0]);
    assert.deepEqual([(await row(live.id)).covered_quantity, (await row(live.id)).notified_quantity], [0, 6], "la couverture lue baisse, le plus haut niveau annoncé reste");
    await env.pool.query("UPDATE offers SET status = 'published' WHERE id = ANY($1::uuid[])", [ids]);
    await env.pool.query("UPDATE matching_evaluations SET evaluated_at = clock_timestamp() WHERE demand_id = $1", [live.demandId]);
    const back = await step();
    assert.deepEqual([back.evaluated, back.notified], [1, 0], "le retour à 6 n'est pas une nouveauté");
    assert.equal(await coverageNotifications(live.id), 0);
    assert.deepEqual([(await row(live.id)).covered_quantity, (await row(live.id)).notified_quantity], [6, 6]);
  });

  test("seul un niveau SUPÉRIEUR au plus haut déjà annoncé notifie", async () => {
    const live = await startMission(env.pool, h, buyer, { quantity: 8 });
    const first = await addCandidate(env.pool, live, { quantity: 3 });
    await settle(env.pool, live.demandId);
    await step();
    await env.pool.query("UPDATE offers SET status = 'paused' WHERE id = $1", [first.offer.id]);
    await env.pool.query("UPDATE matching_evaluations SET evaluated_at = clock_timestamp() WHERE demand_id = $1", [live.demandId]);
    await step();
    assert.equal((await row(live.id)).covered_quantity, 0);
    await addCandidate(env.pool, live, { quantity: 2 });
    assert.equal((await step()).notified, 0, "2 < 3 : déjà dépassé");
    await addCandidate(env.pool, live, { quantity: 2 });
    assert.equal((await step()).notified, 1, "4 > 3");
    assert.equal(await coverageNotifications(live.id), 1);
    assert.deepEqual([(await row(live.id)).covered_quantity, (await row(live.id)).notified_quantity], [4, 4]);
  });

  test("tant qu'une évaluation du besoin porteur est périmée et attend son recalcul, la couverture n'est pas relue (elle ne chute pas) ; le recalcul levé, la lecture reprend ; après 10 minutes elle reprend aussi", async () => {
    const live = await startMission(env.pool, h, buyer, { quantity: 6 });
    const a = await addCandidate(env.pool, live, { quantity: 3 });
    await addCandidate(env.pool, live, { quantity: 3 });
    await settle(env.pool, live.demandId);
    await step();
    assert.equal((await row(live.id)).covered_quantity, 6);
    // L'annonce est modifiée : son évaluation devient périmée (comme `markOfferEvaluationsStale`) et sera recalculée par un job.
    await env.pool.query("UPDATE matching_evaluations SET is_latest = FALSE, is_stale = TRUE, stale_reason = 'offer_updated', staled_at = clock_timestamp() WHERE demand_id = $1 AND offer_id = $2", [live.demandId, a.offer.id]);
    await env.pool.query("UPDATE missions SET evaluated_at = clock_timestamp() - interval '11 minutes' WHERE id = $1", [live.id]);
    const waiting = await step();
    assert.deepEqual([waiting.evaluated, waiting.notified], [0, 0], "recalcul en attente : rien n'est lu");
    assert.equal((await row(live.id)).covered_quantity, 6, "la couverture ne chute pas pendant le recalcul");
    // Le recalcul est fait : une évaluation fraîche remplace la périmée.
    await insertEvaluation(env.pool, { offer: a.offer, demand: live.carrier, score: 90 });
    const done = await step();
    assert.equal(done.evaluated, 1);
    assert.equal((await row(live.id)).covered_quantity, 6);
    // Une évaluation périmée depuis plus de 10 minutes sans remplaçante (annonce définitivement partie) ne bloque plus : la baisse est appliquée.
    await env.pool.query("UPDATE matching_evaluations SET is_latest = FALSE, is_stale = TRUE, stale_reason = 'offer_updated', staled_at = clock_timestamp() - interval '11 minutes' WHERE demand_id = $1 AND offer_id = $2", [live.demandId, a.offer.id]);
    await env.pool.query("UPDATE missions SET evaluated_at = clock_timestamp() - interval '11 minutes' WHERE id = $1", [live.id]);
    assert.equal((await step()).evaluated, 1);
    assert.equal((await row(live.id)).covered_quantity, 3);
  });
});

describe("libération des besoins porteurs : 24 h après la fin de la mission, jamais à l'instant de la fin", () => {
  test("une mission annulée, terminée ou échue garde son besoin porteur actif 24 h ; ensuite l'étape l'archive, une seule fois", async () => {
    const cancelled = await startMission(env.pool, h, buyer);
    const expired = await startMission(env.pool, h, buyer);
    const completed = await startMission(env.pool, h, buyer, { quantity: 2 });
    await actMissionCall(h, buyer.cookie, cancelled.id, "cancel");
    await makeDue(env.pool, expired.id);
    const seller = await login(env.pool);
    const candidate = await addCandidate(env.pool, completed, { quantity: 2, seller: { id: seller.userId, phone: seller.phone } });
    const order = orderOf(await reply(await h.social.orders.declare(request("POST", `/api/demands/${completed.demandId}/offers/${candidate.offer.id}/orders`, { cookie: buyer.cookie, body: { priceXof: 150_000, quantity: 2 } }), completed.demandId, candidate.offer.id)));
    assert.equal((await reply(await h.social.orders.act(request("POST", `/api/orders/${order.id}/confirm`, { cookie: seller.cookie, body: {} }), order.id as string, "confirm"))).status, 200);
    assert.equal((await step()).expired, 1);
    const lives = [cancelled, expired, completed];
    assert.deepEqual([(await row(cancelled.id)).status, (await row(expired.id)).status, (await row(completed.id)).status], ["cancelled", "expired", "completed"]);
    for (const live of lives) assert.equal(await carrierStatus(env.pool, live.demandId), "active", "le besoin porteur n'est pas archivé à la fin de la mission");
    for (const live of lives) assert.equal(await count(env.pool, "matching_outbox_events", `aggregate_id = '${live.demandId}' AND event_type = 'demand.archived'`), 0);
    // 23 h après la fin : toujours rien.
    for (const live of lives) await ageClosedMission(env.pool, live.id, 23);
    assert.equal((await step()).released, 0);
    for (const live of lives) assert.equal(await carrierStatus(env.pool, live.demandId), "active");
    // La base ne permet QUE la libération : poser la date de libération en changeant autre chose dans le même ordre est refusé.
    await assert.rejects(() => env.pool.query("UPDATE missions SET carrier_released_at = clock_timestamp(), covered_quantity = 9 WHERE id = $1", [cancelled.id]), /mission_final/);
    await assert.rejects(() => env.pool.query("UPDATE missions SET carrier_released_at = clock_timestamp(), status = 'active' WHERE id = $1", [cancelled.id]), /mission_final/);
    // 25 h après la fin : archivés.
    for (const live of lives) await ageClosedMission(env.pool, live.id, 25);
    const released = await step();
    assert.deepEqual([released.released, released.errors], [3, []]);
    for (const live of lives) {
      assert.equal(await carrierStatus(env.pool, live.demandId), "archived");
      assert.equal(await count(env.pool, "matching_outbox_events", `aggregate_id = '${live.demandId}' AND event_type = 'demand.archived'`), 1);
      assert.notEqual((await env.pool.query("SELECT carrier_released_at FROM missions WHERE id = $1", [live.id])).rows[0].carrier_released_at, null);
    }
    // Rejoué : rien ne bouge ; une mission close reste close (seule la libération est permise par la base, une fois).
    assert.deepEqual([(await step()).released, (await step()).errors.length], [0, 0]);
    await assert.rejects(() => env.pool.query("UPDATE missions SET carrier_released_at = clock_timestamp() WHERE id = $1", [cancelled.id]), /mission_final/);
    await assert.rejects(() => env.pool.query("UPDATE missions SET covered_quantity = 1 WHERE id = $1", [cancelled.id]), /mission_final/);
  });

  test("deux processus en même temps : chaque besoin porteur est archivé une seule fois, sans erreur", async () => {
    const lives = [await startMission(env.pool, h, buyer), await startMission(env.pool, h, buyer), await startMission(env.pool, h, buyer)];
    for (const live of lives) await actMissionCall(h, buyer.cookie, live.id, "cancel");
    for (const live of lives) await ageClosedMission(env.pool, live.id, 30);
    const results = await Promise.all([step(), step(), step()]);
    assert.equal(results.reduce((sum, result) => sum + result.released, 0), 3);
    assert.deepEqual(results.flatMap((result) => result.errors), []);
    for (const live of lives) assert.equal(await count(env.pool, "matching_outbox_events", `aggregate_id = '${live.demandId}' AND event_type = 'demand.archived'`), 1);
  });

  test("la libération d'un besoin porteur est du travail pour la boucle du worker : le cycle qui libère n'est pas au repos (missions.released), les suivants le redeviennent", async () => {
    const live = await startMission(env.pool, h, buyer);
    await actMissionCall(h, buyer.cookie, live.id, "cancel");
    const cycle = () => runMatchingCycle({ pool: env.pool, workerId: "liberation", notificationTransport: null });
    for (let index = 0; index < 30; index += 1) if ((await cycle()).idle) break;
    assert.equal((await cycle()).idle, true, "avant les 24 h : au repos");
    await ageClosedMission(env.pool, live.id, 25);
    const releasing = await cycle();
    assert.deepEqual([releasing.missions.released, releasing.errors], [1, []]);
    assert.equal(releasing.idle, false, "libérer un besoin porteur n'est pas du repos");
    for (let index = 0; index < 30; index += 1) if ((await cycle()).idle) break;
    assert.equal((await cycle()).idle, true);
    assert.equal(await carrierStatus(env.pool, live.demandId), "archived");
  });

  test("un besoin porteur déjà archivé par ailleurs : la libération le constate et ne fait pas d'erreur", async () => {
    const live = await startMission(env.pool, h, buyer);
    await actMissionCall(h, buyer.cookie, live.id, "cancel");
    await ageClosedMission(env.pool, live.id, 30);
    const demand = await env.pool.query<{ content_version: number }>("SELECT content_version FROM demands WHERE id = $1", [live.demandId]);
    await env.pool.query("UPDATE demands SET status = 'archived', archived_at = clock_timestamp(), content_version = $2 WHERE id = $1", [live.demandId, demand.rows[0].content_version + 1]);
    const result = await step();
    assert.deepEqual([result.released, result.errors], [1, []]);
  });
});

describe("sélection des missions à relire : échéance", () => {
  test("une mission dont l'échéance est passée n'est jamais sélectionnée pour une relecture (même si l'étape ne l'a pas encore marquée échue)", async () => {
    const due = await startMission(env.pool, h, buyer, { quantity: 3 });
    const open = await startMission(env.pool, h, buyer, { quantity: 3 });
    await settle(env.pool, due.demandId);
    await settle(env.pool, open.demandId);
    await makeDue(env.pool, due.id);
    const selected = (await env.pool.query<{ id: string }>(MISSIONS_WATCH_SQL, [20])).rows.map((entry) => entry.id);
    assert.deepEqual(selected, [open.id]);
  });
});

describe("coût de la sélection des missions à relire (historique volumineux d'évaluations périmées)", () => {
  test("la sélection ne parcourt pas toute la table des évaluations : plan sans parcours séquentiel, même avec un gros historique", async () => {
    const lives = [];
    for (let index = 0; index < 6; index += 1) {
      const live = await startMission(env.pool, h, await login(env.pool), { quantity: 3 + index });
      await addCandidate(env.pool, live, { quantity: 2 });
      await settle(env.pool, live.demandId);
      lives.push(live);
    }
    assert.equal((await runMissionsStep({ pool: env.pool, evaluationBatch: 50 })).evaluated, 6);
    // Historique réaliste : 120 000 évaluations remplacées (non « latest », périmées par réévaluation) réparties sur les paires existantes.
    await env.pool.query(
      `INSERT INTO matching_evaluations (idempotency_key, attempt_hash, offer_id, demand_id, offer_owner_id, demand_owner_id, offer_content_version, demand_content_version,
          scoring_config_hash, evaluated_at, eligibility_status, compatibility_status, score, evaluation_summary, scoring_summary, preferences_summary, evaluation_details,
          is_latest, is_stale, stale_reason, staled_at)
       SELECT gen_random_uuid(), 'H' || g, e.offer_id, e.demand_id, e.offer_owner_id, e.demand_owner_id, e.offer_content_version, e.demand_content_version,
              e.scoring_config_hash, clock_timestamp() - interval '2 days', 'eligible', 'compatible', 50, '{}', '{}', '{}', '{}', FALSE, TRUE, 'superseded_by_reevaluation', clock_timestamp() - interval '2 days'
         FROM generate_series(1, 120000) g JOIN (SELECT row_number() OVER (ORDER BY id) AS rn, * FROM matching_evaluations WHERE is_latest) e ON e.rn = (g % 6) + 1`,
    );
    await env.pool.query("ANALYZE matching_evaluations");
    assert.ok((await env.pool.query<{ n: number }>("SELECT count(*)::int AS n FROM matching_evaluations")).rows[0].n > 100_000);
    const plan = (await env.pool.query<{ "QUERY PLAN": string }>(`EXPLAIN ${MISSIONS_WATCH_SQL.replace("$1::int", "20")}`)).rows.map((line) => line["QUERY PLAN"]).join("\n");
    assert.ok(!/Seq Scan on matching_evaluations/.test(plan), `parcours séquentiel de matching_evaluations dans le plan :\n${plan}`);
    assert.ok(/idx_matching_eval_demand_confirmed|idx_matching_eval_demand_awaiting|uq_matching_evaluations_latest/.test(plan), `aucun index d'évaluations dans le plan :\n${plan}`);
    // Au repos (rien à relire), l'étape reste brève malgré l'historique.
    await runMissionsStep({ pool: env.pool });
    await agedEvaluations(lives[0].demandId);
    const times: number[] = [];
    for (let index = 0; index < 3; index += 1) {
      const started = Date.now();
      await runMissionsStep({ pool: env.pool });
      times.push(Date.now() - started);
    }
    assert.ok(Math.min(...times) < 1_000, `étape au repos : ${times.join(", ")} ms`);
  });
});
