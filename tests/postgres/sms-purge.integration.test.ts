import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { Pool } from "pg";
import { runMigrations } from "../../lib/server/postgres/migrations";
import { SMS_PURGE_PRODUCTION_VARIABLE, SMS_SENDS_RETENTION_DAYS } from "../../lib/server/sms/config";
import { SMS_PURGE_BATCH_SIZE, purgeSmsSends } from "../../lib/server/sms/purge";
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

type Status = "pending" | "accepted" | "uncertain" | "rejected" | "failed";
const NOW = new Date(Date.UTC(2032, 5, 15, 12, 0, 0));
const DAY = 86_400_000;
const ago = (days: number, extraMs = 0): Date => new Date(NOW.getTime() - days * DAY + extraMs);
const count = async (): Promise<number> => (await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM sms_sends")).rows[0].n;
let sequence = 0;

async function send(input: { createdAt: Date; status: Status }): Promise<string> {
  sequence += 1;
  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO sms_sends (purpose, reference, idempotency_key, status, http_status, phone_hash, phone_last2, created_at, updated_at)
     VALUES ('notification', $1, $2, $3, $4, repeat('a', 64), '42', $5, $5) RETURNING id`,
    [`ref-${sequence}`, `notif-cle-${sequence}-xxxx`, input.status, input.status === "accepted" ? 200 : null, input.createdAt],
  );
  return inserted.rows[0].id;
}

async function base(): Promise<void> {
  await pool.query("TRUNCATE sms_sends");
}

test("rétention : 62 jours (le mois en cours et le précédent) — la fenêtre de reprise des notifications est de 48 h, la rétention la couvre", () => {
  assert.equal(SMS_SENDS_RETENTION_DAYS, 62);
  assert.ok(SMS_SENDS_RETENTION_DAYS * 24 > 48);
});

test("simulation puis application : ancien accepté/refusé/échoué supprimé, incertain et en cours JAMAIS supprimés même très anciens, 61 et 62 jours pile gardés", async () => {
  await base();
  const kept = [
    await send({ createdAt: ago(61), status: "accepted" }),
    await send({ createdAt: ago(62), status: "accepted" }),
    await send({ createdAt: ago(1), status: "failed" }),
    await send({ createdAt: ago(400), status: "uncertain" }),
    await send({ createdAt: ago(400), status: "pending" }),
  ];
  await send({ createdAt: ago(63), status: "accepted" });
  await send({ createdAt: ago(200), status: "rejected" });
  await send({ createdAt: ago(500), status: "failed" });
  assert.equal(await count(), 8);
  const simulation = await purgeSmsSends({ pool, apply: false, now: NOW });
  assert.equal(simulation.apply, false);
  assert.equal(simulation.reference, NOW.toISOString());
  assert.equal(simulation.sms_sends, 3);
  assert.equal(await count(), 8, "rien n'est supprimé en simulation");
  const applied = await purgeSmsSends({ pool, apply: true, now: NOW });
  assert.equal(applied.apply, true);
  assert.equal(applied.sms_sends, 3);
  const remaining = (await pool.query<{ id: string }>("SELECT id FROM sms_sends")).rows.map((row) => row.id).sort();
  assert.deepEqual(remaining, [...kept].sort());
  assert.equal((await purgeSmsSends({ pool, apply: true, now: NOW })).sms_sends, 0);
  assert.equal((await purgeSmsSends({ pool, apply: false, now: NOW })).sms_sends, 0);
});

test(`application par lots (${SMS_PURGE_BATCH_SIZE} lignes par instruction) : plus d'un lot supprimé, le récent et l'incertain restent`, async () => {
  await base();
  const total = SMS_PURGE_BATCH_SIZE + 100;
  await pool.query(
    `INSERT INTO sms_sends (purpose, reference, idempotency_key, status, http_status, phone_hash, phone_last2, created_at, updated_at)
     SELECT 'notification', 'lot-' || g, 'lot-cle-' || g, 'accepted', 200, repeat('b', 64), '07',
            TIMESTAMPTZ '2000-01-01 00:00:00+00', TIMESTAMPTZ '2000-01-01 00:00:00+00' FROM generate_series(1, $1::int) g`,
    [total],
  );
  const recent = await send({ createdAt: ago(1), status: "accepted" });
  const uncertain = await send({ createdAt: ago(3000), status: "uncertain" });
  const result = await purgeSmsSends({ pool, apply: true, now: NOW });
  assert.equal(result.sms_sends, total);
  const left = (await pool.query<{ id: string }>("SELECT id FROM sms_sends")).rows.map((row) => row.id).sort();
  assert.deepEqual(left, [recent, uncertain].sort());
});

// ═════════════ Commande `sms:purge` (processus enfant) ═════════════

const script = "scripts/sms-purge.ts";

async function seedForScript(): Promise<void> {
  await base();
  // Âges relatifs à l'horloge RÉELLE de la base (la commande n'a pas d'instant de référence réglable).
  await pool.query(
    `INSERT INTO sms_sends (purpose, reference, idempotency_key, status, http_status, phone_hash, phone_last2, created_at, updated_at) VALUES
       ('notification', 'ancien', 'cle-ancienne-1', 'accepted', 200, repeat('c', 64), '11', clock_timestamp() - interval '100 days', clock_timestamp() - interval '100 days'),
       ('notification', 'incertain', 'cle-incertaine-1', 'uncertain', NULL, repeat('c', 64), '11', clock_timestamp() - interval '100 days', clock_timestamp() - interval '100 days'),
       ('notification', 'recent', 'cle-recente-1', 'accepted', 200, repeat('c', 64), '11', clock_timestamp() - interval '2 days', clock_timestamp() - interval '2 days')`,
  );
}

test("commande : sans argument = SIMULATION (rien n'est supprimé), --apply supprime ; texte clair", async () => {
  await seedForScript();
  const simulation = await runScript(script, [], schema);
  assert.equal(simulation.code, 0, simulation.output);
  assert.match(simulation.output, /SMS : simulation, 1 envoi\(s\) de SMS créés depuis plus de 62 jours \(hors incertains et en cours\) seraient supprimé\(s\)\. Rien n'a été supprimé : relancez avec --apply pour supprimer\./);
  assert.equal(await count(), 3);
  const applied = await runScript(script, ["--apply"], schema);
  assert.equal(applied.code, 0, applied.output);
  assert.match(applied.output, /SMS : 1 envoi\(s\) de SMS créés depuis plus de 62 jours \(hors incertains et en cours\) supprimé\(s\)\./);
  assert.equal(await count(), 2);
});

test("commande : argument inconnu, répété ou mal placé → code 1 et RIEN n'est supprimé", async () => {
  await seedForScript();
  for (const args of [["--apply", "--apply"], ["apply"], ["--force"], ["--apply=1"], ["--dry-run"], ["--APPLY"], ["-a"]]) {
    const result = await runScript(script, args, schema);
    assert.equal(result.code, 1, `${args.join(" ")} : ${result.output}`);
    assert.match(result.output, /Usage : npm run sms:purge \[-- --apply\]/);
  }
  assert.equal(await count(), 3);
});

test(`commande : refus en production sans ${SMS_PURGE_PRODUCTION_VARIABLE}=1 (simulation comprise), les variables des autres purges n'autorisent pas, NODE_ENV exact`, async () => {
  await seedForScript();
  for (const args of [[], ["--apply"]]) {
    const refused = await runScript(script, args, schema, { NODE_ENV: "production" });
    assert.equal(refused.code, 1, refused.output);
    assert.match(refused.output, /refus en production : définissez NOMA_SMS_PURGE_PRODUCTION=1/);
    assert.equal(await count(), 3, `${args.join(" ") || "simulation"} : rien supprimé`);
  }
  for (const other of ["NOMA_NOTIFICATIONS_PURGE_PRODUCTION", "NOMA_METRICS_PURGE_PRODUCTION"]) {
    const result = await runScript(script, ["--apply"], schema, { NODE_ENV: "production", [other]: "1" });
    assert.equal(result.code, 1, result.output);
    assert.equal(await count(), 3);
  }
  const wrongCase = await runScript(script, ["--apply"], schema, { NODE_ENV: "Production", [SMS_PURGE_PRODUCTION_VARIABLE]: "1" });
  assert.equal(wrongCase.code, 1, wrongCase.output);
  assert.equal(await count(), 3);
  const allowed = await runScript(script, ["--apply"], schema, { NODE_ENV: "production", [SMS_PURGE_PRODUCTION_VARIABLE]: "1" });
  assert.equal(allowed.code, 0, allowed.output);
  assert.equal(await count(), 2);
});
