import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { after, before, test } from "node:test";
import { Pool } from "pg";
import { createOffer, createUser } from "../../lib/server/catalog";
import { runMigrations } from "../../lib/server/postgres/migrations";
import { spawnScript, type RunningScript } from "./run-script";
import {
  createTemporarySchemaName, openVerifiedIsolatedPool, openVerifiedTestDatabase, quoteTemporarySchema,
} from "./test-database";

const FAKE_NEXT = resolve(process.cwd(), "tests/postgres/fake-next.mjs");
const schema = createTemporarySchemaName();
const emptySchema = createTemporarySchemaName();
let admin: Pool, pool: Pool;
const spawned = new Set<number>();

before(async () => {
  const opened = await openVerifiedTestDatabase(process.env.TEST_DATABASE_URL);
  admin = opened.pool;
  await admin.query(`CREATE SCHEMA ${quoteTemporarySchema(schema)}`);
  await admin.query(`CREATE SCHEMA ${quoteTemporarySchema(emptySchema)}`);
  pool = await openVerifiedIsolatedPool(opened.target, schema);
  assert.equal((await runMigrations(pool)).applied.length, 12);
});

after(async () => {
  // Filet de sécurité : aucun processus de test ne doit survivre.
  for (const pid of spawned) if (alive(pid)) { try { process.kill(pid, "SIGKILL"); } catch { /* déjà mort */ } }
  if (pool) await pool.end();
  if (admin) {
    for (const name of [schema, emptySchema]) await admin.query(`DROP SCHEMA IF EXISTS ${quoteTemporarySchema(name)} CASCADE`);
    await admin.end();
  }
});

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function waitDead(pid: number, timeoutMs = 10_000): Promise<boolean> {
  const started = Date.now();
  while (alive(pid)) {
    if (Date.now() - started > timeoutMs) return false;
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  return true;
}

/** Enfants directs d'un processus : [{ pid, args }], hors service esbuild que le chargeur tsx lance lui-même. */
function childrenOf(pid: number): Array<{ pid: number; args: string }> {
  let out = "";
  try { out = execFileSync("ps", ["-o", "pid=,args=", "--ppid", String(pid)], { encoding: "utf8" }); } catch { return []; }
  return out.split("\n").map((line) => line.trim()).filter(Boolean).map((line) => {
    const [first, ...rest] = line.split(/\s+/);
    return { pid: Number(first), args: rest.join(" ") };
  }).filter((child) => !child.args.includes("/esbuild"));
}

function pidsOf(run: RunningScript): { next?: number; worker?: number } {
  const text = run.output();
  const next = /\[dev:full\] next démarré \(pid (\d+)\)/.exec(text);
  const worker = /\[dev:full\] worker matching démarré \(pid (\d+)\)/.exec(text);
  const pids = { next: next ? Number(next[1]) : undefined, worker: worker ? Number(worker[1]) : undefined };
  for (const pid of [run.child.pid, pids.next, pids.worker]) if (pid) spawned.add(pid);
  return pids;
}

/** Nettoyage d'un test (réussi ou non) : les enfants d'abord (relevés avant la mort du parent), puis `dev:full` lui-même. */
function reap(run: RunningScript): void {
  const pids = pidsOf(run);
  const victims = new Set<number>([...(pids.next ? [pids.next] : []), ...(pids.worker ? [pids.worker] : []),
    ...(run.child.pid ? childrenOf(run.child.pid).map((child) => child.pid) : [])]);
  for (const pid of victims) { try { process.kill(pid, "SIGKILL"); } catch { /* déjà mort */ } }
  run.child.kill("SIGKILL");
}

const devFull = (targetSchema: string, env: Record<string, string> = {}) =>
  spawnScript("scripts/dev-full.ts", [], targetSchema, { NOMA_DEV_FULL_NEXT_SCRIPT: FAKE_NEXT, ...env });

/** Borne l'attente d'une fin de processus : un arrêt non relayé ou un enfant non détecté fait échouer le test au lieu de l'attendre. */
const within = <T>(promise: Promise<T>, timeoutMs = 12_000): Promise<T> => Promise.race([
  promise,
  new Promise<never>((_, reject) => { setTimeout(() => reject(new Error("délai dépassé : le processus ne s'est pas arrêté")), timeoutMs).unref(); }),
]);

async function stop(run: RunningScript, signal: NodeJS.Signals = "SIGTERM") {
  run.child.kill(signal);
  return within(run.exited);
}

async function assertNoSurvivor(run: RunningScript, pids: { next?: number; worker?: number }) {
  for (const pid of [run.child.pid, pids.next, pids.worker]) {
    if (pid) assert.ok(await waitDead(pid), `processus ${pid} encore vivant`);
  }
}

// ═════════════ a) sans DATABASE_URL ═════════════

test("sans DATABASE_URL : seul next démarre, avec le message ; SIGTERM l'arrête (code 0, aucun PID vivant)", async () => {
  const run = devFull(schema, { DATABASE_URL: "" });
  try {
    await run.waitForOutput(/\[fake-next\] prêt/);
    await run.waitForOutput(/Worker matching NON lancé : DATABASE_URL n'est pas défini/);
    const pids = pidsOf(run);
    assert.ok(pids.next && !pids.worker);
    assert.ok(!/\[matching\]/.test(run.output()));
    assert.ok(!/worker matching démarré/.test(run.output()));
    const children = childrenOf(run.child.pid!);
    assert.equal(children.length, 1, JSON.stringify(children));
    assert.ok(children[0].args.includes("fake-next.mjs"));
    const result = await stop(run);
    assert.equal(result.code, 0, run.output());
    await assertNoSurvivor(run, pids);
  } finally { reap(run); }
});

// ═════════════ b) schéma non prêt ═════════════

test("schéma non prêt (0010 retirée, ou base sans migration) : seul next démarre, aucune migration appliquée", async () => {
  const saved = (await pool.query("SELECT * FROM noma_schema_migrations WHERE version = '0010_matching_job_leases'")).rows[0];
  assert.ok(saved);
  await pool.query("DELETE FROM noma_schema_migrations WHERE version = '0010_matching_job_leases'");
  try {
    const before = (await pool.query("SELECT version FROM noma_schema_migrations ORDER BY version")).rows;
    const run = devFull(schema);
    try {
      await run.waitForOutput(/Worker matching NON lancé : le schéma n'est pas prêt/);
      const pids = pidsOf(run);
      assert.ok(pids.next && !pids.worker);
      assert.equal(childrenOf(run.child.pid!).length, 1);
      assert.equal((await stop(run)).code, 0, run.output());
      await assertNoSurvivor(run, pids);
    } finally { reap(run); }
    assert.deepEqual((await pool.query("SELECT version FROM noma_schema_migrations ORDER BY version")).rows, before, "aucune migration appliquée");
  } finally {
    await pool.query("INSERT INTO noma_schema_migrations (version, checksum) VALUES ($1, $2)", [saved.version, saved.checksum]);
  }

  // Schéma vide (aucune table) : même comportement, et le script ne crée rien.
  const run = devFull(emptySchema);
  try {
    await run.waitForOutput(/Worker matching NON lancé : le schéma n'est pas prêt/);
    const pids = pidsOf(run);
    assert.ok(pids.next && !pids.worker);
    assert.equal((await stop(run)).code, 0, run.output());
    await assertNoSurvivor(run, pids);
  } finally { reap(run); }
  const tables = await admin.query("SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = $1", [emptySchema]);
  assert.equal(tables.rows[0].n, 0, "le schéma vide n'a reçu aucune table (aucune migration)");
});

// ═════════════ c) schéma prêt ═════════════

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  test(`schéma prêt : les deux démarrent, un événement créé est traité par le worker conjoint, ${signal} arrête tout (code 0, aucun PID vivant)`, async () => {
    const run = devFull(schema);
    try {
      await run.waitForOutput(/\[fake-next\] prêt/);
      await run.waitForOutput(/\[matching\] Matching worker démarré\./);
      const pids = pidsOf(run);
      assert.ok(pids.next && pids.worker);
      const children = childrenOf(run.child.pid!);
      assert.deepEqual(children.map((child) => child.pid).sort(), [pids.next, pids.worker].sort());
      assert.ok(children.some((child) => child.args.includes("matching-worker.ts")));
      assert.ok(!/react-server/.test(/\[fake-next\] prêt[^\n]*/.exec(run.output())![0]), "Next n'hérite pas de la condition react-server");
      assert.ok(!/worker matching NON lancé/.test(run.output()));

      // Un événement créé par un service du catalogue est projeté en job puis exécuté par le worker conjoint.
      await pool.query("TRUNCATE matching_evaluations, matching_jobs, matching_outbox_events, demands, offers, users CASCADE");
      const owner = await createUser({}, pool);
      await createOffer({ ownerId: owner.id, rawText: "iPhone 13", category: "smartphones", brand: "Apple", model: "iPhone 13",
        price: { amount: 250_000, currency: "XOF" }, status: "published" }, pool);
      const started = Date.now();
      let done = false;
      while (Date.now() - started < 30_000 && !done) {
        const pending = (await pool.query("SELECT count(*)::int AS n FROM matching_outbox_events WHERE dispatch_status = 'pending'")).rows[0].n;
        const completed = (await pool.query("SELECT count(*)::int AS n FROM matching_jobs WHERE status = 'completed'")).rows[0].n;
        done = pending === 0 && completed >= 1;
        if (!done) await new Promise((resolveWait) => setTimeout(resolveWait, 200));
      }
      assert.ok(done, `événement non traité par le worker conjoint. Sortie :\n${run.output()}`);

      const result = await stop(run, signal);
      assert.equal(result.code, 0, run.output());
      assert.match(run.output(), /\[matching\] Matching worker arrêté/);
      await assertNoSurvivor(run, pids);
    } finally { reap(run); }
  });
}

// ═════════════ d) le worker meurt ═════════════

test("le worker meurt : next est arrêté et le code de sortie est non nul (aucun PID vivant)", async () => {
  const run = devFull(schema);
  try {
    await run.waitForOutput(/\[matching\] Matching worker démarré\./);
    const pids = pidsOf(run);
    assert.ok(pids.next && pids.worker);
    process.kill(pids.worker, "SIGKILL");
    const result = await within(run.exited);
    assert.notEqual(result.code, 0, run.output());
    assert.notEqual(result.code, null);
    assert.match(run.output(), /worker matching s'est arrêté de façon inattendue/);
    assert.match(run.output(), /\[fake-next\] signal SIGTERM/, "next a reçu l'ordre d'arrêt");
    await assertNoSurvivor(run, pids);
  } finally { reap(run); }
});

// ═════════════ e) next meurt ═════════════

test("next s'arrête de lui-même : le worker est arrêté proprement et le code de sortie est non nul", async () => {
  const run = devFull(schema, { FAKE_NEXT_EXIT_AFTER_MS: "4000" });
  try {
    await run.waitForOutput(/\[matching\] Matching worker démarré\./);
    const pids = pidsOf(run);
    assert.ok(pids.next && pids.worker);
    const result = await within(run.exited);
    assert.equal(result.code, 3, run.output());
    assert.match(run.output(), /next s'est arrêté de façon inattendue/);
    assert.match(run.output(), /\[matching\] Matching worker arrêté/, "le worker a reçu SIGTERM et s'est arrêté proprement");
    await assertNoSurvivor(run, pids);
  } finally { reap(run); }
});

// ═════════════ f) le script dev reste inchangé ═════════════

test("le script npm dev reste strictement « next dev » ; dev:full est un script distinct", () => {
  const scripts = JSON.parse(readFileSync("package.json", "utf8")).scripts as Record<string, string>;
  assert.equal(scripts.dev, "next dev");
  assert.match(scripts["dev:full"], /scripts\/dev-full\.ts$/);
});
