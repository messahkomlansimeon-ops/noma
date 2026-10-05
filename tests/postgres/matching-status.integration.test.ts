import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { Pool } from "pg";
import { createDemand, createOffer, createUser } from "../../lib/server/catalog";
import { readMatchingStatus, type MatchingStatusReport } from "../../lib/server/matching/status";
import { runMigrations } from "../../lib/server/postgres/migrations";
import { runScript } from "./run-script";
import {
  createTemporarySchemaName, openVerifiedIsolatedPool, openVerifiedTestDatabase, quoteTemporarySchema,
} from "./test-database";

let admin: Pool, pool: Pool;
const schema = createTemporarySchemaName();
const quoted = quoteTemporarySchema(schema);

before(async () => {
  const opened = await openVerifiedTestDatabase(process.env.TEST_DATABASE_URL);
  admin = opened.pool;
  await admin.query(`CREATE SCHEMA ${quoted}`);
  pool = await openVerifiedIsolatedPool(opened.target, schema);
  assert.equal((await runMigrations(pool)).applied.length, 10);
});

after(async () => {
  if (pool) await pool.end();
  if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${quoted} CASCADE`); await admin.end(); }
});

const reset = () => pool.query(
  "TRUNCATE matching_evaluations, matching_jobs, matching_outbox_events, demands, offers, users CASCADE");

const SNAPSHOT_TABLES = ["users", "offers", "demands", "matching_jobs", "matching_outbox_events", "matching_evaluations", "noma_schema_migrations"];
const snapshotAll = async () => {
  const out: Record<string, unknown[]> = {};
  for (const table of SNAPSHOT_TABLES) out[table] = (await pool.query(`SELECT to_jsonb(t.*) AS row FROM ${table} t ORDER BY 1::text`)).rows;
  return out;
};

const hex64 = () => randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", "");

function insertEvent(options: { type?: string; status?: "pending" | "projected" | "ignored"; ageSeconds?: number; errorMessage?: string | null }) {
  const status = options.status ?? "pending";
  return pool.query(
    `INSERT INTO matching_outbox_events (event_type, aggregate_type, aggregate_id, payload, occurred_at, dispatch_status, dispatched_at, error_message)
     VALUES ($1, 'system', gen_random_uuid(), '{"generation":1}', clock_timestamp() - ($2::int * interval '1 second'), $3::text,
             CASE WHEN $3::text <> 'pending' THEN clock_timestamp() END, $4)`,
    [options.type ?? "catalog.bootstrap_sync", options.ageSeconds ?? 5, status, options.errorMessage ?? null]);
}

function insertJob(options: { type?: string; status: string; lastError?: string | null; leaseExpiredSecondsAgo?: number }) {
  const running = options.status === "running";
  return pool.query(
    `INSERT INTO matching_jobs (job_identity, job_type, resource_id, resource_version, status, last_error,
                                locked_by, locked_at, lock_expires_at, claim_token, completed_at)
     VALUES ($1, $2, gen_random_uuid(), 1, $3::text, $4,
       CASE WHEN $5::boolean THEN 'status-test' END, CASE WHEN $5::boolean THEN clock_timestamp() END,
       CASE WHEN $5::boolean THEN clock_timestamp() - ($6::int * interval '1 second') END,
       CASE WHEN $5::boolean THEN gen_random_uuid() END,
       CASE WHEN $3::text IN ('completed', 'superseded', 'dead_letter') THEN clock_timestamp() END)`,
    [hex64(), options.type ?? "evaluate_offer_candidates", options.status, options.lastError ?? null, running, options.leaseExpiredSecondsAgo ?? 60]);
}

async function insertActiveEvaluation(expired: boolean): Promise<void> {
  const seller = await createUser({}, pool), buyer = await createUser({}, pool);
  const offer = await createOffer({ ownerId: seller.id, rawText: "iPhone 13", category: "smartphones", brand: "Apple", model: "iPhone 13",
    price: { amount: 250_000, currency: "XOF" }, status: "published" }, pool);
  const demand = await createDemand({ ownerId: buyer.id, rawText: "Cherche iPhone 13", category: "smartphones", brand: "Apple", model: "iPhone 13",
    budget: { amount: 300_000, currency: "XOF" }, status: "active" }, pool);
  await pool.query(
    `INSERT INTO matching_evaluations (idempotency_key, attempt_hash, offer_id, demand_id, offer_owner_id, demand_owner_id,
       offer_content_version, demand_content_version, scoring_config_hash, evaluated_at, expires_at, eligibility_status,
       compatibility_status, score, coverage, evaluation_summary, scoring_summary, preferences_summary, evaluation_details)
     VALUES ($1, 'h', $2, $3, $4, $5, $6, $7, $8, clock_timestamp() - interval '1 hour',
       CASE WHEN $9::boolean THEN clock_timestamp() - interval '1 second' ELSE clock_timestamp() + interval '1 hour' END,
       'eligible', 'compatible', 0.5, 0.5, '{}', '{}', '{}', '{}')`,
    [randomUUID(), offer.id, demand.id, seller.id, buyer.id, offer.contentVersion, demand.contentVersion, "b".repeat(64), expired]);
  // Les services catalogue enregistrent leurs propres événements : retirés pour ne garder que ceux du scénario.
  await pool.query("DELETE FROM matching_outbox_events WHERE aggregate_type IN ('offer', 'demand', 'user')");
}

const statusScript = (args: string[] = [], env: Record<string, string> = {}) => runScript("scripts/matching-status.ts", args, schema, env);
async function statusJson(): Promise<{ code: number | null; report: MatchingStatusReport; output: string }> {
  const result = await statusScript(["--json"]);
  return { code: result.code, report: JSON.parse(result.output) as MatchingStatusReport, output: result.output };
}
const warningCodes = (report: MatchingStatusReport) => report.warnings.map((warning) => warning.code);

// ═════════════ 1. Base saine ═════════════

test("base saine : code 0, aucun avertissement, compteurs exacts (sortie lisible et JSON)", async () => {
  await reset();
  await insertEvent({ ageSeconds: 10 });                      // pending récent : n'avertit pas
  await insertEvent({ status: "projected", ageSeconds: 30 });
  await insertJob({ status: "completed" });
  await insertJob({ status: "pending", type: "evaluate_demand_candidates" });
  await insertJob({ status: "running", leaseExpiredSecondsAgo: -3600 }); // bail valable encore une heure
  await insertActiveEvaluation(false);

  const human = await statusScript();
  assert.equal(human.code, 0, human.output);
  assert.match(human.output, /Schéma : prêt \(10 migration\(s\), dernière 0010_matching_job_leases\)/);
  assert.match(human.output, /Événements pending : catalog\.bootstrap_sync=1/);
  assert.match(human.output, /Événements projected : catalog\.bootstrap_sync=1/);
  assert.match(human.output, /Avertissements : aucun/);

  const { code, report } = await statusJson();
  assert.equal(code, 0);
  assert.equal(report.schemaReady, true);
  assert.deepEqual(report.migrations, { count: 10, latest: "0010_matching_job_leases" });
  assert.deepEqual(report.outbox.pendingByType, { "catalog.bootstrap_sync": 1 });
  assert.deepEqual(report.outbox.projectedByType, { "catalog.bootstrap_sync": 1 });
  assert.equal(report.outbox.oldestPending?.eventType, "catalog.bootstrap_sync");
  assert.ok(report.outbox.oldestPending!.ageSeconds >= 10 && report.outbox.oldestPending!.ageSeconds < 60);
  assert.deepEqual(report.outbox.ignoredByCode, {});
  assert.deepEqual(report.jobs.byTypeAndStatus, [
    { jobType: "evaluate_demand_candidates", status: "pending", count: 1 },
    { jobType: "evaluate_offer_candidates", status: "completed", count: 1 },
    { jobType: "evaluate_offer_candidates", status: "running", count: 1 },
  ]);
  assert.equal(report.jobs.runningWithExpiredLease, 0);
  assert.deepEqual(report.jobs.deadLetter, { count: 0, byErrorCode: {} });
  assert.ok(report.jobs.lastCompletedAt);
  assert.deepEqual(report.evaluations, { active: 1, activeExpired: 0 });
  assert.deepEqual(report.warnings, []);
  assert.ok(report.outbox.pendingByType["catalog.bootstrap_sync"] > 0);
});

test("base vide et saine : code 0, dernier job completed « aucun »", async () => {
  await reset();
  const result = await statusScript();
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /Dernier job completed : aucun/);
  assert.match(result.output, /Plus ancien pending : aucun/);
});

// ═════════════ 2. Chaque avertissement → code 2 et bon code ═════════════

test("dead_letter : code 2, nombre et codes (jamais de message brut)", async () => {
  await reset();
  await insertJob({ status: "dead_letter", lastError: "child_job_integrity_conflict" });
  await insertJob({ status: "dead_letter", lastError: "child_job_integrity_conflict" });
  await insertJob({ status: "dead_letter", lastError: "Tentatives maximales autorisées épuisées ou bail expiré." });
  await insertJob({ status: "dead_letter", lastError: "Message brut avec espaces, identifiant 123 et secret SECRET_MARKER" });
  await insertJob({ status: "dead_letter", lastError: null });
  const { code, report, output } = await statusJson();
  assert.equal(code, 2);
  assert.deepEqual(warningCodes(report), ["dead_letter_present"]);
  assert.deepEqual(report.jobs.deadLetter, {
    count: 5,
    byErrorCode: { child_job_integrity_conflict: 2, attempts_or_lease_exhausted: 1, other: 1, none: 1 },
  });
  assert.ok(!output.includes("SECRET_MARKER") && !output.includes("Message brut"));
  const human = await statusScript();
  assert.equal(human.code, 2);
  assert.match(human.output, /- dead_letter_present : /);
  assert.ok(!human.output.includes("SECRET_MARKER"));
});

test("quarantaine : code 2 (job_integrity_conflict), les autres codes ignored sont comptés sans avertir", async () => {
  await reset();
  await insertEvent({ status: "ignored", errorMessage: "unknown_event_type" });
  let result = await statusJson();
  assert.equal(result.code, 0, "un événement ignored d'un autre code n'avertit pas");
  assert.deepEqual(result.report.outbox.ignoredByCode, { unknown_event_type: 1 });
  await insertEvent({ status: "ignored", errorMessage: "job_integrity_conflict" });
  await insertEvent({ status: "ignored", errorMessage: "texte brut libre avec espaces" });
  result = await statusJson();
  assert.equal(result.code, 2);
  assert.deepEqual(warningCodes(result.report), ["integrity_quarantine_present"]);
  assert.deepEqual(result.report.outbox.ignoredByCode, { unknown_event_type: 1, job_integrity_conflict: 1, other: 1 });
  assert.ok(!result.output.includes("texte brut libre"));
});

test("événement pending trop ancien (> 300 s) : code 2 ; à 250 s : code 0", async () => {
  await reset();
  await insertEvent({ ageSeconds: 250 });
  assert.equal((await statusJson()).code, 0);
  await insertEvent({ ageSeconds: 400, type: "temporal.deadline_passed" });
  const { code, report } = await statusJson();
  assert.equal(code, 2);
  assert.deepEqual(warningCodes(report), ["oldest_pending_too_old"]);
  assert.equal(report.outbox.oldestPending?.eventType, "temporal.deadline_passed");
  assert.ok(report.outbox.oldestPending!.ageSeconds >= 400);
  assert.deepEqual(report.outbox.pendingByType, { "catalog.bootstrap_sync": 1, "temporal.deadline_passed": 1 });
});

test("bail expiré : code 2 (job running dont lock_expires_at est dépassé)", async () => {
  await reset();
  await insertJob({ status: "running", leaseExpiredSecondsAgo: -3600 });
  assert.equal((await statusJson()).code, 0, "bail encore valable");
  await insertJob({ status: "running", leaseExpiredSecondsAgo: 120 });
  const { code, report } = await statusJson();
  assert.equal(code, 2);
  assert.deepEqual(warningCodes(report), ["job_lease_expired"]);
  assert.equal(report.jobs.runningWithExpiredLease, 1);
});

test("évaluation active expirée : code 2 ; une évaluation expirée mais périmée n'est pas comptée", async () => {
  await reset();
  await insertActiveEvaluation(false);
  assert.equal((await statusJson()).code, 0);
  await insertActiveEvaluation(true);
  const { code, report } = await statusJson();
  assert.equal(code, 2);
  assert.deepEqual(warningCodes(report), ["active_evaluation_expired"]);
  assert.deepEqual(report.evaluations, { active: 2, activeExpired: 1 });
  await pool.query("UPDATE matching_evaluations SET is_stale = TRUE, stale_reason = 'temporal_expiry', staled_at = clock_timestamp() WHERE expires_at <= clock_timestamp()");
  const after = await statusJson();
  assert.equal(after.code, 0);
  assert.deepEqual(after.report.evaluations, { active: 1, activeExpired: 0 });
});

test("migration 0010 absente : code 2 (schema_not_ready), aucune lecture des tables de matching", async () => {
  await reset();
  const saved = (await pool.query("SELECT * FROM noma_schema_migrations WHERE version = '0010_matching_job_leases'")).rows[0];
  assert.ok(saved);
  await pool.query("DELETE FROM noma_schema_migrations WHERE version = '0010_matching_job_leases'");
  try {
    const { code, report } = await statusJson();
    assert.equal(code, 2);
    assert.equal(report.schemaReady, false);
    assert.deepEqual(warningCodes(report), ["schema_not_ready"]);
    const human = await statusScript();
    assert.equal(human.code, 2);
    assert.match(human.output, /Schéma : NON PRÊT/);
  } finally {
    await pool.query("INSERT INTO noma_schema_migrations (version, checksum) VALUES ($1, $2)", [saved.version, saved.checksum]);
  }
  await pool.query("ALTER TABLE noma_schema_migrations RENAME TO noma_schema_migrations_off");
  try {
    const { code, report } = await statusJson();
    assert.equal(code, 2, "table de migrations absente : même avertissement, pas d'erreur");
    assert.deepEqual(warningCodes(report), ["schema_not_ready"]);
  } finally {
    await pool.query("ALTER TABLE noma_schema_migrations_off RENAME TO noma_schema_migrations");
  }
  assert.equal((await statusJson()).code, 0);
});

test("plusieurs avertissements simultanés : tous rapportés, code 2", async () => {
  await reset();
  await insertJob({ status: "dead_letter", lastError: "x" });
  await insertEvent({ ageSeconds: 900 });
  await insertEvent({ status: "ignored", errorMessage: "job_integrity_conflict" });
  await insertJob({ status: "running", leaseExpiredSecondsAgo: 30 });
  await insertActiveEvaluation(true);
  const { code, report } = await statusJson();
  assert.equal(code, 2);
  assert.deepEqual(warningCodes(report).sort(), [
    "active_evaluation_expired", "dead_letter_present", "integrity_quarantine_present", "job_lease_expired", "oldest_pending_too_old"]);
});

// ═════════════ 3. Lecture seule ═════════════

test("aucune écriture : snapshot complet des tables identique avant et après (sain et avec avertissements)", async () => {
  await reset();
  await insertEvent({ ageSeconds: 900 });
  await insertEvent({ status: "ignored", errorMessage: "job_integrity_conflict" });
  await insertJob({ status: "dead_letter", lastError: "x" });
  await insertJob({ status: "running", leaseExpiredSecondsAgo: 30 });
  await insertJob({ status: "completed" });
  await insertActiveEvaluation(true);
  const before = await snapshotAll();
  for (const args of [[], ["--json"]]) assert.equal((await statusScript(args)).code, 2);
  assert.deepEqual(await snapshotAll(), before);
  const report = await readMatchingStatus({ pool });
  assert.ok(report.warnings.length > 0);
  assert.deepEqual(await snapshotAll(), before);
});

test("une écriture tentée dans la transaction échoue (READ ONLY) et n'écrit rien", async () => {
  await reset();
  const before = await snapshotAll();
  const attempts: Array<[string, string]> = [
    ["INSERT", "INSERT INTO matching_jobs (job_identity, job_type, resource_id, resource_version) VALUES ('" + "a".repeat(64) + "', 'evaluate_offer_candidates', gen_random_uuid(), 1)"],
    ["UPDATE", "UPDATE matching_jobs SET status = 'pending'"],
    ["DELETE", "DELETE FROM matching_outbox_events"],
    ["DDL", "CREATE TABLE status_probe (id int)"],
    ["TRUNCATE", "TRUNCATE matching_jobs"],
  ];
  const observedErrors: Record<string, string | undefined> = {};
  await readMatchingStatus({
    pool,
    hooks: {
      inSnapshot: async (client) => {
        for (const [label, sql] of attempts) {
          await client.query("SAVEPOINT attempt");
          try {
            await client.query(sql);
            observedErrors[label] = "AUCUNE ERREUR";
          } catch (error) {
            observedErrors[label] = (error as { code?: string }).code;
            await client.query("ROLLBACK TO SAVEPOINT attempt");
          }
        }
        assert.equal((await client.query("SHOW transaction_read_only")).rows[0].transaction_read_only, "on");
      },
    },
  });
  assert.deepEqual(observedErrors, { INSERT: "25006", UPDATE: "25006", DELETE: "25006", DDL: "25006", TRUNCATE: "25006" });
  assert.deepEqual(await snapshotAll(), before);
});

test("pool invalide refusé avant toute requête", async () => {
  await assert.rejects(readMatchingStatus({ pool: {} as never }), TypeError);
});

// ═════════════ 4. Erreurs : code 1, jamais de message brut ═════════════

test("DATABASE_URL absent, argument inconnu, base injoignable : code 1, aucun message brut ni secret", async () => {
  const missing = await statusScript([], { DATABASE_URL: "" });
  assert.equal(missing.code, 1);
  assert.match(missing.output, /DATABASE_URL est requis/);

  const unknown = await statusScript(["--bogus"]);
  assert.equal(unknown.code, 1);
  assert.match(unknown.output, /argument inconnu/);

  const unreachable = await statusScript([], { DATABASE_URL: "postgresql://utilisateur_secret:SECRET_PW_MARKER@127.0.0.1:1/base_secrete" });
  assert.equal(unreachable.code, 1);
  assert.match(unreachable.output, /Matching status : erreur [A-Za-z0-9_]+\./);
  for (const forbidden of ["SECRET_PW_MARKER", "utilisateur_secret", "base_secrete", "127.0.0.1"]) {
    assert.ok(!unreachable.output.includes(forbidden), `fuite : ${forbidden}`);
  }
});
