import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { Pool } from "pg";
import { createOffer, createUser } from "../../lib/server/catalog";
import { CatalogValidationError } from "../../lib/server/catalog/errors";
import type { OfferRecord } from "../../lib/server/catalog/types";
import { BOOST_EXPIRY_DEFAULT_LIMIT, BOOST_EXPIRY_MAX_LIMIT, BOOST_EXPIRY_OVERDUE_SECONDS } from "../../lib/server/boost/boost-config";
import { cancelOfferBoost, expireOfferBoosts, grantOfferBoost } from "../../lib/server/boost/boosts";
import { MatchingJobValidationError } from "../../lib/server/matching/jobs";
import { runMatchingCycle } from "../../lib/server/matching/runner";
import type { MatchingStatusReport } from "../../lib/server/matching/status";
import { runMigrations } from "../../lib/server/postgres/migrations";
import { runScript } from "./run-script";
import {
  createTemporarySchemaName, openVerifiedIsolatedPool, openVerifiedTestDatabase, quoteTemporarySchema, type DedicatedTestDatabase,
} from "./test-database";

const schema = createTemporarySchemaName();
const quoted = quoteTemporarySchema(schema);
let admin: Pool, pool: Pool;
let target: DedicatedTestDatabase;
const extraPools: Pool[] = [];

before(async () => {
  const opened = await openVerifiedTestDatabase(process.env.TEST_DATABASE_URL);
  admin = opened.pool;
  target = opened.target;
  await admin.query(`CREATE SCHEMA ${quoted}`);
  pool = await openVerifiedIsolatedPool(target, schema);
  assert.equal((await runMigrations(pool)).applied.length, 16);
});

after(async () => {
  for (const extra of extraPools) await extra.end().catch(() => {});
  if (pool) await pool.end();
  if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${quoted} CASCADE`); await admin.end(); }
});

// ───────────── données ─────────────

const reset = () => pool.query("TRUNCATE boost_quotes, offer_boosts, matching_evaluations, matching_jobs, matching_outbox_events, demands, offers, users CASCADE");

let counter = 0;
async function makeOffer(): Promise<OfferRecord> {
  counter += 1;
  const owner = await createUser({}, pool);
  return createOffer({
    ownerId: owner.id, rawText: `iPhone 13 n°${counter}`, category: "smartphones", brand: "Apple", model: "iPhone 13",
    price: { amount: 250_000 + counter, currency: "XOF" }, status: "published", availabilityStatus: "available",
  }, pool);
}

interface BoostSeed { status?: "active" | "cancelled" | "expired"; startsInSeconds: number; endsInSeconds: number }

/** Insère un boost directement (dates relatives à l'horloge de la base) : l'attribution réelle ne produit jamais un boost déjà échu. */
async function insertBoost(offer: OfferRecord, seed: BoostSeed): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO offer_boosts (id, offer_id, seller_id, scope_category, scope_brand, scope_model, status, duration_code, starts_at, ends_at, source, cancelled_at)
     VALUES ($1, $2, $3, 'smartphones', 'apple', 'iphone 13', $4::text, '24h',
             clock_timestamp() + ($5::int * interval '1 second'), clock_timestamp() + ($6::int * interval '1 second'), 'admin_grant',
             CASE WHEN $4::text = 'cancelled' THEN clock_timestamp() - interval '1 hour' END)`,
    [id, offer.id, offer.ownerId, seed.status ?? "active", seed.startsInSeconds, seed.endsInSeconds]);
  return id;
}

const boostRow = async (id: string) => (await pool.query("SELECT to_jsonb(b.*) AS row FROM offer_boosts b WHERE b.id = $1", [id])).rows[0].row as Record<string, unknown>;
const statusOf = async (id: string) => (await boostRow(id)).status as string;

// ═════════════ E1. expireOfferBoosts ═════════════

test("E1 : seuls les boosts actifs échus passent en expired, limit et ordre (ends_at, id) respectés, idempotent", async () => {
  await reset();
  const offers: OfferRecord[] = [];
  for (let index = 0; index < 7; index++) offers.push(await makeOffer());
  const [o1, o2, o3, oValid, oFuture, oCancelled, oExpired] = offers;
  const a3 = await insertBoost(o3, { startsInSeconds: -7200, endsInSeconds: -600 });
  const a1 = await insertBoost(o1, { startsInSeconds: -7200, endsInSeconds: -3600 });
  const a2 = await insertBoost(o2, { startsInSeconds: -7200, endsInSeconds: -1800 });
  const valid = await insertBoost(oValid, { startsInSeconds: -3600, endsInSeconds: 3600 });
  const future = await insertBoost(oFuture, { startsInSeconds: 3600, endsInSeconds: 7200 });
  const cancelled = await insertBoost(oCancelled, { status: "cancelled", startsInSeconds: -7200, endsInSeconds: -3600 });
  const alreadyExpired = await insertBoost(oExpired, { status: "expired", startsInSeconds: -7200, endsInSeconds: -3600 });
  const untouched = [valid, future, cancelled, alreadyExpired];
  const before = new Map<string, Record<string, unknown>>();
  for (const id of untouched) before.set(id, await boostRow(id));

  // Limite 2 : les deux échéances les plus anciennes (ordre ends_at, id), pas a3.
  assert.deepEqual(await expireOfferBoosts({ pool, limit: 2 }), { expired: 2 });
  assert.equal(await statusOf(a1), "expired");
  assert.equal(await statusOf(a2), "expired");
  assert.equal(await statusOf(a3), "active", "la plus récente échéance attend le balayage suivant");
  // Balayage suivant (limite par défaut) : le dernier échu, rien d'autre.
  assert.deepEqual(await expireOfferBoosts({ pool }), { expired: 1 });
  assert.equal(await statusOf(a3), "expired");
  // Idempotent.
  assert.deepEqual(await expireOfferBoosts({ pool }), { expired: 0 });
  assert.deepEqual(await expireOfferBoosts({ pool, limit: BOOST_EXPIRY_MAX_LIMIT }), { expired: 0 });
  // Rien d'autre n'a bougé, ni le statut ni cancelled_at (ligne identique octet pour octet) ; un expiré n'a pas de cancelled_at.
  for (const id of untouched) assert.deepEqual(await boostRow(id), before.get(id), `boost ${id} inchangé`);
  assert.equal((await boostRow(cancelled)).status, "cancelled");
  assert.notEqual((await boostRow(cancelled)).cancelled_at, null);
  for (const id of [a1, a2, a3]) assert.equal((await boostRow(id)).cancelled_at, null, "expirer ne pose jamais cancelled_at");
  assert.equal(await statusOf(valid), "active");
  assert.equal(await statusOf(future), "active");
});

test("E1 : limit validée AVANT tout SQL (entier de 1 à 1000, défaut 200), pool exigé", async () => {
  const queries: unknown[][] = [];
  const spy = {
    connect: async () => { throw new Error("connexion interdite"); },
    query: async (_text: string, values?: unknown[]) => { queries.push(values ?? []); return { rowCount: 0, rows: [] }; },
  } as unknown as Pool;
  for (const bad of [0, -1, 1.5, 1001, Number.NaN, Number.POSITIVE_INFINITY, "5" as unknown as number, null as unknown as number]) {
    await assert.rejects(expireOfferBoosts({ pool: spy, limit: bad }), CatalogValidationError, `limit=${String(bad)}`);
  }
  await assert.rejects(expireOfferBoosts({ pool: undefined as unknown as Pool }), CatalogValidationError);
  assert.equal(queries.length, 0, "aucune requête pour une entrée invalide");
  assert.deepEqual(await expireOfferBoosts({ pool: spy }), { expired: 0 });
  assert.deepEqual(await expireOfferBoosts({ pool: spy, limit: 1 }), { expired: 0 });
  assert.deepEqual(await expireOfferBoosts({ pool: spy, limit: 1000 }), { expired: 0 });
  assert.deepEqual(queries, [[BOOST_EXPIRY_DEFAULT_LIMIT], [1], [1000]]);
  assert.equal(BOOST_EXPIRY_DEFAULT_LIMIT, 200);
  assert.equal(BOOST_EXPIRY_MAX_LIMIT, 1000);
});

function meetingPoint(size: number, timeoutMs: number): () => Promise<void> {
  let arrived = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  return async () => {
    arrived += 1;
    if (arrived >= size) release();
    await Promise.race([gate, new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))]);
  };
}

test("E1 concurrence : deux balayages simultanés (pools distincts, point de rencontre) → chaque boost expiré une seule fois, total exact", async () => {
  await reset();
  const COUNT = 40;
  const ids: string[] = [];
  for (let index = 0; index < COUNT; index++) ids.push(await insertBoost(await makeOffer(), { startsInSeconds: -7200, endsInSeconds: -60 - index }));
  const meet = meetingPoint(2, 2_000);
  const sweepers: Pool[] = [];
  for (let index = 0; index < 2; index++) {
    const extra = await openVerifiedIsolatedPool(target, schema);
    extraPools.push(extra);
    // La requête du balayage n'est lancée qu'une fois les DEUX arrivées : exécution réellement simultanée.
    sweepers.push(new Proxy(extra, {
      get: (real, property) => (property === "query"
        ? async (...args: unknown[]) => { await meet(); return (real.query as (...a: unknown[]) => Promise<unknown>).apply(real, args); }
        : Reflect.get(real, property)),
    }));
  }
  const results = await Promise.all(sweepers.map((db) => expireOfferBoosts({ pool: db, limit: BOOST_EXPIRY_MAX_LIMIT })));
  assert.equal(results[0].expired + results[1].expired, COUNT, "total exact : aucun boost compté deux fois, aucun oublié");
  const statuses = (await pool.query<{ status: string; n: number }>("SELECT status, count(*)::int AS n FROM offer_boosts GROUP BY status")).rows;
  assert.deepEqual(statuses, [{ status: "expired", n: COUNT }]);
  assert.deepEqual(await expireOfferBoosts({ pool }), { expired: 0 });
  assert.equal(ids.length, COUNT);
});

test("E1 : un boost verrouillé par une opération en cours (annulation, attribution) n'est ni attendu ni touché par le balayage ; il est expiré au balayage suivant", async () => {
  await reset();
  const [locked, free] = [await makeOffer(), await makeOffer()];
  const lockedBoost = await insertBoost(locked, { startsInSeconds: -7200, endsInSeconds: -120 });
  const freeBoost = await insertBoost(free, { startsInSeconds: -7200, endsInSeconds: -60 });
  const holder = await openVerifiedIsolatedPool(target, schema);
  extraPools.push(holder);
  const client = await holder.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT 1 FROM offer_boosts WHERE id = $1 FOR UPDATE", [lockedBoost]);   // comme une annulation ou une attribution en cours
    // Le balayage ne doit PAS attendre la ligne verrouillée (SKIP LOCKED) : il répond vite, avec l'autre boost seulement.
    const outcome = await Promise.race([
      expireOfferBoosts({ pool }),
      new Promise<"attente">((resolve) => setTimeout(() => resolve("attente"), 4_000)),
    ]);
    assert.notEqual(outcome, "attente", "le balayage ne doit pas attendre un boost verrouillé");
    assert.deepEqual(outcome, { expired: 1 });
    assert.equal(await statusOf(freeBoost), "expired");
    assert.equal(await statusOf(lockedBoost), "active", "le boost verrouillé n'a pas été touché");
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    client.release();
  }
  assert.deepEqual(await expireOfferBoosts({ pool }), { expired: 1 }, "verrou relâché : le boost est expiré au balayage suivant");
  assert.equal(await statusOf(lockedBoost), "expired");
});

test("E1 interactions : attribution après balayage, annulation d'un boost balayé (état renvoyé, rien modifié), échu non balayé aussi", async () => {
  await reset();
  const offer = await makeOffer();
  const lapsed = await insertBoost(offer, { startsInSeconds: -7200, endsInSeconds: -60 });
  assert.deepEqual(await expireOfferBoosts({ pool }), { expired: 1 });
  const swept = await boostRow(lapsed);
  // Annuler un boost balayé : état courant, cancelled faux, ligne identique.
  const cancel = await cancelOfferBoost({ pool, boostId: lapsed, ownerId: offer.ownerId });
  assert.equal(cancel.cancelled, false);
  assert.equal(cancel.boost.status, "expired");
  assert.equal(cancel.boost.cancelledAt, null);
  assert.deepEqual(await boostRow(lapsed), swept);
  // Attribution après balayage : fonctionne (le boost expiré ne bloque ni l'offre ni la place).
  const granted = await grantOfferBoost({ pool, offerId: offer.id, ownerId: offer.ownerId, durationCode: "24h", source: "admin_grant" });
  assert.equal(granted.boost.status, "active");
  assert.notEqual(granted.boost.id, lapsed);
  assert.deepEqual(await boostRow(lapsed), swept, "l'ancien boost reste tel qu'il a été balayé");
  // Un boost neuf et valable n'est jamais balayé.
  assert.deepEqual(await expireOfferBoosts({ pool }), { expired: 0 });
  assert.equal(await statusOf(granted.boost.id), "active");
  // Attribution sur un boost échu NON balayé : comportement de 2I1 inchangé (le boost échu passe expired, l'attribution réussit).
  await pool.query("DELETE FROM offer_boosts WHERE offer_id = $1", [offer.id]);
  const lapsedAgain = await insertBoost(offer, { startsInSeconds: -7200, endsInSeconds: -30 });
  const regrant = await grantOfferBoost({ pool, offerId: offer.id, ownerId: offer.ownerId, durationCode: "3d", source: "admin_grant" });
  assert.equal(await statusOf(lapsedAgain), "expired");
  assert.equal(regrant.boost.status, "active");
});

// ═════════════ E2. Étape boost du worker ═════════════

/** Cycles jusqu'à l'inactivité (hors boost) : outbox projetée, jobs exécutés. */
async function drain(db: Pool = pool): Promise<void> {
  for (let index = 0; index < 30; index++) {
    const result = await runMatchingCycle({ pool: db, workerId: "expiry-a" });
    assert.deepEqual(result.errors, []);
    if (result.idle) return;
  }
  assert.fail("le matching ne devient pas inactif");
}

test("E2 : l'étape boost est exécutée après l'étape temporelle ; idle faux tant qu'un boost expire ; boostLimit borné", async () => {
  await reset();
  const [o1, o2] = [await makeOffer(), await makeOffer()];
  await drain();
  const idle = await runMatchingCycle({ pool, workerId: "expiry-a" });
  assert.deepEqual(idle.boost, { expired: 0, skipped: false });
  assert.equal(idle.idle, true);

  const b1 = await insertBoost(o1, { startsInSeconds: -7200, endsInSeconds: -120 });
  const b2 = await insertBoost(o2, { startsInSeconds: -7200, endsInSeconds: -60 });
  const limited = await runMatchingCycle({ pool, workerId: "expiry-a", boostLimit: 1 });
  assert.deepEqual(limited.boost, { expired: 1, skipped: false });
  assert.equal(limited.idle, false, "idle faux : un boost vient d'expirer");
  assert.deepEqual(limited.errors, []);
  assert.equal(await statusOf(b1), "expired");
  assert.equal(await statusOf(b2), "active");
  const rest = await runMatchingCycle({ pool, workerId: "expiry-a" });
  assert.deepEqual(rest.boost, { expired: 1, skipped: false });
  assert.equal(rest.idle, false);
  const after = await runMatchingCycle({ pool, workerId: "expiry-a" });
  assert.deepEqual(after.boost, { expired: 0, skipped: false });
  assert.equal(after.idle, true, "plus rien : le cycle redevient inactif");

  for (const bad of [0, 1001, 1.5, "5" as unknown as number]) {
    await assert.rejects(runMatchingCycle({ pool, workerId: "expiry-a", boostLimit: bad }), MatchingJobValidationError, `boostLimit=${String(bad)}`);
  }
});

test("E2 : migration 0011 non enregistrée → étape ignorée (skipped: true), aucune erreur, aucun boost touché", async () => {
  await reset();
  const offer = await makeOffer();
  await drain();
  const lapsed = await insertBoost(offer, { startsInSeconds: -7200, endsInSeconds: -60 });
  const migration = (await pool.query("SELECT * FROM noma_schema_migrations WHERE version = '0011_offer_boosts'")).rows[0];
  assert.ok(migration);
  await pool.query("DELETE FROM noma_schema_migrations WHERE version = '0011_offer_boosts'");
  try {
    const result = await runMatchingCycle({ pool, workerId: "expiry-a" });
    assert.deepEqual(result.boost, { expired: 0, skipped: true });
    assert.deepEqual(result.errors, [], "jamais une erreur à cause de l'étape boost");
    assert.equal(result.idle, true);
    assert.equal(await statusOf(lapsed), "active", "l'étape n'a pas été exécutée");
  } finally {
    await pool.query("INSERT INTO noma_schema_migrations (version, checksum, applied_at) VALUES ($1, $2, $3)", [migration.version, migration.checksum, migration.applied_at]);
  }
  const resumed = await runMatchingCycle({ pool, workerId: "expiry-a" });
  assert.deepEqual(resumed.boost, { expired: 1, skipped: false });
  assert.equal(await statusOf(lapsed), "expired");
});

test("E2 : table des boosts absente → boost_error_42p01, les étapes suivantes (projection, jobs) s'exécutent quand même", async () => {
  await reset();
  await makeOffer();           // événements d'outbox à projeter, puis jobs à exécuter, APRÈS l'étape boost
  await pool.query("ALTER TABLE offer_boosts RENAME TO offer_boosts_absente");
  try {
    const result = await runMatchingCycle({ pool, workerId: "expiry-a" });
    assert.deepEqual(result.errors, ["boost_error_42p01"], "code stable en minuscules, comme temporal_error_<code>");
    assert.deepEqual(result.boost, { expired: 0, skipped: false });
    assert.ok(result.projected.selected >= 1, "la projection a bien été exécutée après l'échec de l'étape boost");
    assert.ok(result.projected.projected >= 1);
    assert.equal(result.idle, false);
    assert.ok(!result.errors.some((code) => code.startsWith("projection_") || code.startsWith("job_") || code.startsWith("temporal_")));
  } finally {
    await pool.query("ALTER TABLE offer_boosts_absente RENAME TO offer_boosts");
  }
  await drain();
});

test("E2 : matching:worker --once marque les boosts échus (ligne supplémentaire seulement s'il y en a), code 0, texte existant inchangé", async () => {
  await reset();
  const offer = await makeOffer();
  await drain();
  const lapsed = await insertBoost(offer, { startsInSeconds: -7200, endsInSeconds: -60 });
  const first = await runScript("scripts/matching-worker.ts", ["--once"], schema);
  assert.equal(first.code, 0, first.output);
  assert.match(first.output, /^Matching worker : un cycle, 0 évaluation\(s\) périmée\(s\), 0 événement\(s\) lu\(s\), 0 job\(s\) en dead_letter, 0 job\(s\) exécuté\(s\)\.$/m);
  assert.match(first.output, /^Matching worker : 1 boost\(s\) échu\(s\) marqué\(s\) expiré\(s\)\.$/m);
  assert.equal(await statusOf(lapsed), "expired");
  const second = await runScript("scripts/matching-worker.ts", ["--once"], schema);
  assert.equal(second.code, 0, second.output);
  assert.ok(!second.output.includes("boost(s)"), "aucune ligne boost quand rien n'expire");
});

// ═════════════ E3. Statut ═════════════

const statusScript = (args: string[] = []) => runScript("scripts/matching-status.ts", args, schema);
async function statusJson(): Promise<{ code: number | null; report: MatchingStatusReport }> {
  const result = await statusScript(["--json"]);
  return { code: result.code, report: JSON.parse(result.output) as MatchingStatusReport };
}
const warningCodes = (report: MatchingStatusReport) => report.warnings.map((warning) => warning.code);

test("E3 : boost_expiry_overdue (code 2, texte fixe) au-delà de 10 minutes de retard ; rien en dessous ; effectifs comptés ; retour à 0 après balayage", async () => {
  await reset();
  const [overdue, recent, effective, future] = [await makeOffer(), await makeOffer(), await makeOffer(), await makeOffer()];
  await drain();
  assert.equal(BOOST_EXPIRY_OVERDUE_SECONDS, 600);
  await insertBoost(recent, { startsInSeconds: -7200, endsInSeconds: -(BOOST_EXPIRY_OVERDUE_SECONDS - 60) });   // échu depuis 9 minutes : pas encore en retard
  await insertBoost(effective, { startsInSeconds: -3600, endsInSeconds: 3600 });
  await insertBoost(future, { startsInSeconds: 3600, endsInSeconds: 7200 });
  const healthy = await statusJson();
  assert.equal(healthy.code, 0);
  assert.deepEqual(healthy.report.warnings, []);
  assert.deepEqual(healthy.report.boosts, { effective: 1, overdue: 0 });

  const lapsed = await insertBoost(overdue, { startsInSeconds: -7200, endsInSeconds: -(BOOST_EXPIRY_OVERDUE_SECONDS + 60) });   // 11 minutes de retard
  const late = await statusJson();
  assert.equal(late.code, 2);
  assert.deepEqual(warningCodes(late.report), ["boost_expiry_overdue"]);
  assert.equal(late.report.warnings[0].message, "Des boosts échus depuis plus de 10 minutes sont encore actifs en base : le worker ne tourne probablement pas (ils n'ont aucun effet, mais ne sont pas marqués expirés).");
  assert.deepEqual(late.report.boosts, { effective: 1, overdue: 1 });
  const human = await statusScript();
  assert.equal(human.code, 2);
  assert.match(human.output, /Boosts : 1 effectif\(s\), 1 en retard d'expiration/);
  assert.match(human.output, /boost_expiry_overdue : Des boosts échus depuis plus de 10 minutes/);

  // Un boost annulé ou déjà expiré, même ancien, n'est pas « en retard ».
  await pool.query("UPDATE offer_boosts SET status = 'cancelled', cancelled_at = clock_timestamp() WHERE id = $1", [lapsed]);
  assert.deepEqual((await statusJson()).report.boosts, { effective: 1, overdue: 0 });
  await pool.query("UPDATE offer_boosts SET status = 'active', cancelled_at = NULL WHERE id = $1", [lapsed]);

  // Migration 0011 non enregistrée : aucune lecture des boosts, aucun avertissement, compteurs à zéro.
  const migration = (await pool.query("SELECT * FROM noma_schema_migrations WHERE version = '0011_offer_boosts'")).rows[0];
  await pool.query("DELETE FROM noma_schema_migrations WHERE version = '0011_offer_boosts'");
  try {
    const bare = await statusJson();
    assert.equal(bare.code, 0);
    assert.deepEqual(bare.report.warnings, []);
    assert.deepEqual(bare.report.boosts, { effective: 0, overdue: 0 });
  } finally {
    await pool.query("INSERT INTO noma_schema_migrations (version, checksum, applied_at) VALUES ($1, $2, $3)", [migration.version, migration.checksum, migration.applied_at]);
  }

  // Balayage : le retard disparaît (le boost de 9 minutes expire aussi), retour au code 0.
  const swept = await expireOfferBoosts({ pool });
  assert.equal(swept.expired, 2);
  const back = await statusJson();
  assert.equal(back.code, 0);
  assert.deepEqual(back.report.warnings, []);
  assert.deepEqual(back.report.boosts, { effective: 1, overdue: 0 });
  assert.equal(await statusOf(lapsed), "expired");
});
