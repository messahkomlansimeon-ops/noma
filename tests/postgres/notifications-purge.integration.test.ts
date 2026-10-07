import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { Pool } from "pg";
import { runMigrations } from "../../lib/server/postgres/migrations";
import {
  DELIVERIES_RETENTION_DAYS, NOTIFICATIONS_READ_RETENTION_DAYS, NOTIFICATIONS_RETENTION_DAYS,
} from "../../lib/server/notifications/config";
import { NOTIFICATIONS_PURGE_BATCH_SIZE, purgeNotifications } from "../../lib/server/notifications/purge";
import { makeDemand, makeOffer, makePerson } from "./metrics-fixtures";
import { runScript } from "./run-script";
import {
  createTemporarySchemaName, openVerifiedIsolatedPool, openVerifiedTestDatabase, quoteTemporarySchema, type DedicatedTestDatabase,
} from "./test-database";

const schema = createTemporarySchemaName();
const quoted = quoteTemporarySchema(schema);
let admin: Pool, pool: Pool;
let target: DedicatedTestDatabase;

before(async () => {
  const opened = await openVerifiedTestDatabase(process.env.TEST_DATABASE_URL);
  admin = opened.pool;
  target = opened.target;
  await admin.query(`CREATE SCHEMA ${quoted}`);
  pool = await openVerifiedIsolatedPool(target, schema);
  await runMigrations(pool);
});

after(async () => {
  if (pool) await pool.end();
  if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${quoted} CASCADE`); await admin.end(); }
});

const count = async (table: string): Promise<number> => (await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n;
const counts = async () => ({ notifications: await count("notifications"), notification_deliveries: await count("notification_deliveries") });
const NOW = new Date(Date.UTC(2032, 5, 15, 12, 0, 0));
const DAY = 86_400_000;
const ago = (days: number, extraMs = 0): Date => new Date(NOW.getTime() - days * DAY + extraMs);

interface Base { buyerId: string; demandId: string; sellerId: string }

async function base(): Promise<Base> {
  await pool.query("TRUNCATE notification_deliveries, notifications, notification_preferences, matching_evaluations, matching_jobs, matching_outbox_events, phone_identities, demands, offers, users CASCADE");
  const seller = await makePerson(pool);
  const buyer = await makePerson(pool);
  const demand = await makeDemand(pool, buyer.id);
  return { buyerId: buyer.id, demandId: demand.id, sellerId: seller.id };
}

async function notification(b: Base, input: { createdAt: Date; readAt?: Date | null }): Promise<string> {
  const offer = await makeOffer(pool, b.sellerId);
  const inserted = await pool.query<{ id: string }>(
    "INSERT INTO notifications (user_id, kind, demand_id, offer_id, title, created_at, read_at) VALUES ($1, 'new_match', $2, $3, 'Apple iPhone 13', $4, $5) RETURNING id",
    [b.buyerId, b.demandId, offer.id, input.createdAt, input.readAt ?? null],
  );
  return inserted.rows[0].id;
}

async function delivery(b: Base, input: { createdAt: Date; status?: "pending" | "sent" | "skipped"; notificationId?: string | null }): Promise<string> {
  const offer = await makeOffer(pool, b.sellerId);
  const status = input.status ?? "pending";
  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO notification_deliveries (user_id, notification_id, demand_id, offer_id, channel, status, attempts, next_attempt_at, idempotency_key, content, created_at, updated_at, sent_at, batch_key, reason)
     VALUES ($1, $2, $3, $4, 'sms_sim', $5, $6, $7, $8, '{}'::jsonb, $7, $7, $9, $10, $11) RETURNING id`,
    [
      b.buyerId, input.notificationId ?? null, b.demandId, offer.id, status, status === "sent" ? 1 : 0, input.createdAt, `cle-${offer.id}`,
      status === "sent" ? input.createdAt : null, status === "sent" ? "0123456789abcdef0123456789abcdef" : null, status === "skipped" ? "expired" : null,
    ],
  );
  return inserted.rows[0].id;
}

test("rétention : notifications lues depuis plus de 90 jours OU créées depuis plus de 180 jours ; envois créés depuis plus de 180 jours (constantes)", () => {
  assert.equal(NOTIFICATIONS_READ_RETENTION_DAYS, 90);
  assert.equal(NOTIFICATIONS_RETENTION_DAYS, 180);
  assert.equal(DELIVERIES_RETENTION_DAYS, 180);
});

test("simulation : compte ce qui serait supprimé et ne supprime RIEN ; bornes strictes (90 et 180 jours pile sont gardés)", async () => {
  const b = await base();
  const kept = [
    await notification(b, { createdAt: ago(95), readAt: ago(89) }),
    await notification(b, { createdAt: ago(95), readAt: ago(90) }),
    await notification(b, { createdAt: ago(179) }),
    await notification(b, { createdAt: ago(180) }),
    await notification(b, { createdAt: ago(1) }),
    await notification(b, { createdAt: ago(1), readAt: ago(0, -1000) }),
  ];
  const removed = [
    await notification(b, { createdAt: ago(95), readAt: ago(91) }),
    await notification(b, { createdAt: ago(300), readAt: ago(100) }),
    await notification(b, { createdAt: ago(181) }),
    await notification(b, { createdAt: ago(200), readAt: ago(10) }),
  ];
  await delivery(b, { createdAt: ago(179) });
  await delivery(b, { createdAt: ago(180), status: "sent" });
  await delivery(b, { createdAt: ago(181), status: "sent" });
  await delivery(b, { createdAt: ago(400) });
  await delivery(b, { createdAt: ago(1), status: "skipped" });
  const before = await counts();
  assert.deepEqual(before, { notifications: 10, notification_deliveries: 5 });
  const simulation = await purgeNotifications({ pool, apply: false, now: NOW });
  assert.equal(simulation.apply, false);
  assert.equal(simulation.reference, NOW.toISOString());
  assert.deepEqual(simulation.counts, { notifications: removed.length, notification_deliveries: 2 });
  assert.deepEqual(await counts(), before, "rien n'est supprimé en simulation");
  // Application : seules les lignes visées disparaissent, les autres restent intactes.
  const applied = await purgeNotifications({ pool, apply: true, now: NOW });
  assert.equal(applied.apply, true);
  assert.deepEqual(applied.counts, { notifications: removed.length, notification_deliveries: 2 });
  const remaining = (await pool.query<{ id: string }>("SELECT id FROM notifications")).rows.map((row) => row.id).sort();
  assert.deepEqual(remaining, [...kept].sort());
  assert.equal(await count("notification_deliveries"), 3);
  // Idempotent.
  assert.deepEqual((await purgeNotifications({ pool, apply: true, now: NOW })).counts, { notifications: 0, notification_deliveries: 0 });
  assert.deepEqual((await purgeNotifications({ pool, apply: false, now: NOW })).counts, { notifications: 0, notification_deliveries: 0 });
});

test("une notification purgée ne supprime pas son envoi récent (clé étrangère SET NULL) ; un envoi ancien est supprimé même sans notification", async () => {
  const b = await base();
  const old = await notification(b, { createdAt: ago(200), readAt: ago(190) });
  const recentDelivery = await delivery(b, { createdAt: ago(5), notificationId: old });
  const oldDelivery = await delivery(b, { createdAt: ago(190) });
  await purgeNotifications({ pool, apply: true, now: NOW });
  assert.equal(await count("notifications"), 0);
  const left = await pool.query<{ id: string; notification_id: string | null }>("SELECT id, notification_id FROM notification_deliveries");
  assert.deepEqual(left.rows.map((row) => row.id), [recentDelivery]);
  assert.equal(left.rows[0].notification_id, null);
  assert.equal(left.rows.some((row) => row.id === oldDelivery), false);
});

test(`application par lots (${NOTIFICATIONS_PURGE_BATCH_SIZE} lignes par instruction) : plus d'un lot de lignes anciennes est entièrement supprimé, la récente reste`, async () => {
  const b = await base();
  const total = NOTIFICATIONS_PURGE_BATCH_SIZE + 100;
  await pool.query(
    `INSERT INTO notifications (user_id, kind, demand_id, digest_day, item_count, created_at)
     SELECT $1, 'new_matches_digest', $2, DATE '2000-01-01' + g, 1, TIMESTAMPTZ '2000-01-01 00:00:00+00' FROM generate_series(1, $3::int) g`,
    [b.buyerId, b.demandId, total],
  );
  const recent = await notification(b, { createdAt: ago(1) });
  assert.equal(await count("notifications"), total + 1);
  const result = await purgeNotifications({ pool, apply: true, now: NOW });
  assert.equal(result.counts.notifications, total);
  assert.deepEqual((await pool.query<{ id: string }>("SELECT id FROM notifications")).rows.map((row) => row.id), [recent]);
});

// ═════════════ Commande `notifications:purge` (processus enfant) ═════════════

const script = "scripts/notifications-purge.ts";

async function seedForScript(): Promise<void> {
  const b = await base();
  // Âges relatifs à l'horloge RÉELLE de la base (la commande n'a pas d'instant de référence réglable).
  const offerA = await makeOffer(pool, b.sellerId);
  const offerB = await makeOffer(pool, b.sellerId);
  await pool.query(
    `INSERT INTO notifications (user_id, kind, demand_id, offer_id, title, created_at, read_at) VALUES
       ($1, 'new_match', $2, $3, 'Ancienne', clock_timestamp() - interval '200 days', NULL),
       ($1, 'new_match', $2, $4, 'Récente', clock_timestamp() - interval '2 days', NULL)`,
    [b.buyerId, b.demandId, offerA.id, offerB.id],
  );
  await pool.query(
    `INSERT INTO notification_deliveries (user_id, demand_id, offer_id, channel, next_attempt_at, idempotency_key, content, created_at)
     VALUES ($1, $2, $3, 'sms_sim', clock_timestamp(), 'cle-ancienne', '{}'::jsonb, clock_timestamp() - interval '200 days')`,
    [b.buyerId, b.demandId, offerA.id],
  );
}

test("commande : sans argument = SIMULATION (rien n'est supprimé), --apply supprime ; texte clair", async () => {
  await seedForScript();
  const simulation = await runScript(script, [], schema);
  assert.equal(simulation.code, 0, simulation.output);
  assert.match(simulation.output, /Notifications : simulation, 1 notification\(s\) \(lues depuis plus de 90 jours ou créées depuis plus de 180 jours\) et 1 envoi\(s\) externe\(s\) de plus de 180 jours seraient supprimé\(s\)\. Rien n'a été supprimé : relancez avec --apply pour supprimer\./);
  assert.deepEqual(await counts(), { notifications: 2, notification_deliveries: 1 });
  const applied = await runScript(script, ["--apply"], schema);
  assert.equal(applied.code, 0, applied.output);
  assert.match(applied.output, /Notifications : 1 notification\(s\) .* et 1 envoi\(s\) externe\(s\) de plus de 180 jours supprimé\(s\)\./);
  assert.deepEqual(await counts(), { notifications: 1, notification_deliveries: 0 });
  assert.equal(applied.output.includes("password"), false);
});

test("commande : argument inconnu, répété ou mal placé → code 1 et RIEN n'est supprimé", async () => {
  await seedForScript();
  for (const args of [["--apply", "--apply"], ["apply"], ["--force"], ["--apply=1"], ["--dry-run"], ["--APPLY"], ["-a"]]) {
    const result = await runScript(script, args, schema);
    assert.equal(result.code, 1, `${args.join(" ")} : ${result.output}`);
    assert.match(result.output, /Usage : npm run notifications:purge \[-- --apply\]/);
  }
  assert.deepEqual(await counts(), { notifications: 2, notification_deliveries: 1 });
});

test("commande : même garde que metrics:purge — refus en production sans NOMA_NOTIFICATIONS_PURGE_PRODUCTION=1 (simulation comprise), la variable des mesures n'autorise pas, NODE_ENV exact, DATABASE_URL obligatoire", async () => {
  await seedForScript();
  for (const args of [[], ["--apply"]]) {
    const refused = await runScript(script, args, schema, { NODE_ENV: "production" });
    assert.equal(refused.code, 1, refused.output);
    assert.match(refused.output, /refus en production : définissez NOMA_NOTIFICATIONS_PURGE_PRODUCTION=1/);
    assert.deepEqual(await counts(), { notifications: 2, notification_deliveries: 1 }, `${args.join(" ") || "simulation"} : rien supprimé`);
  }
  const metricsVariable = await runScript(script, ["--apply"], schema, { NODE_ENV: "production", NOMA_METRICS_PURGE_PRODUCTION: "1" });
  assert.equal(metricsVariable.code, 1, "la variable de metrics:purge n'autorise pas cette commande");
  const wrongValue = await runScript(script, ["--apply"], schema, { NODE_ENV: "production", NOMA_NOTIFICATIONS_PURGE_PRODUCTION: "oui" });
  assert.equal(wrongValue.code, 1);
  assert.deepEqual(await counts(), { notifications: 2, notification_deliveries: 1 });
  for (const value of ["Production", "PRODUCTION", "prod", "staging", "", "Test", "DEVELOPMENT"]) {
    for (const args of [[], ["--apply"]]) {
      const refused = await runScript(script, args, schema, { NODE_ENV: value });
      assert.equal(refused.code, 1, `NODE_ENV=${JSON.stringify(value)} ${args.join(" ")} : ${refused.output}`);
      assert.match(refused.output, /refus : NODE_ENV doit être absent, « development » ou « test »/);
    }
    const withVariable = await runScript(script, ["--apply"], schema, { NODE_ENV: value, NOMA_NOTIFICATIONS_PURGE_PRODUCTION: "1" });
    assert.equal(withVariable.code, 1, `NODE_ENV=${JSON.stringify(value)} + variable : ${withVariable.output}`);
  }
  assert.deepEqual(await counts(), { notifications: 2, notification_deliveries: 1 });
  const allowedSimulation = await runScript(script, [], schema, { NODE_ENV: "production", NOMA_NOTIFICATIONS_PURGE_PRODUCTION: "1" });
  assert.equal(allowedSimulation.code, 0, allowedSimulation.output);
  assert.deepEqual(await counts(), { notifications: 2, notification_deliveries: 1 });
  for (const value of ["development", "test"]) {
    assert.equal((await runScript(script, [], schema, { NODE_ENV: value })).code, 0, `NODE_ENV=${value}`);
  }
  const allowed = await runScript(script, ["--apply"], schema, { NODE_ENV: "production", NOMA_NOTIFICATIONS_PURGE_PRODUCTION: "1" });
  assert.equal(allowed.code, 0, allowed.output);
  assert.deepEqual(await counts(), { notifications: 1, notification_deliveries: 0 });
  const noDatabase = await runScript(script, [], schema, { DATABASE_URL: "" });
  assert.equal(noDatabase.code, 1);
  assert.match(noDatabase.output, /DATABASE_URL est requis/);
});
