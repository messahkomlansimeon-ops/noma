import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Pool, type PoolClient } from "pg";
import {
  archiveDemand, createDemand, createOffer, createUser, satisfyDemand, updateDemand, updateOffer, updateUser,
} from "../../lib/server/catalog";
import type { DemandRecord, OfferRecord, UserRecord } from "../../lib/server/catalog/types";
import { runCatalogBootstrap } from "../../lib/server/matching/bootstrap";
import { projectOutboxBatch } from "../../lib/server/matching/projection";
import { runMatchingCycle } from "../../lib/server/matching/runner";
import { runMatchingWorkerOnce, type MatchingWorkerHooks } from "../../lib/server/matching/worker";
import { NEW_MATCH_DAILY_CAP_PER_DEMAND, NEW_MATCH_DAILY_CAP_PER_USER, NOTIFICATION_CAP_LOCK_NAMESPACE } from "../../lib/server/notifications/config";
import { recordNewMatchNotification, requireTransactionClient, type NewMatchOutcome } from "../../lib/server/notifications/creation";
import { TrackingNotActiveError, applyTrackingAction, readDemandTracking } from "../../lib/server/notifications/tracking";
import { runMigrations } from "../../lib/server/postgres/migrations";
import { PRODUCT, insertEvaluation, makeDemand, makeOffer, makePerson } from "./metrics-fixtures";
import {
  createTemporarySchemaName, openVerifiedIsolatedPool, openVerifiedTestDatabase, quoteTemporarySchema, type DedicatedTestDatabase,
} from "./test-database";

let admin: Pool, pool: Pool;
let target: DedicatedTestDatabase;
const schema = createTemporarySchemaName();
const quoted = quoteTemporarySchema(schema);
/** Plusieurs connexions : les crochets lisent la base PENDANT la transaction d'une évaluation (le pool d'essai par défaut n'en a qu'une). */
const wide = (config: ConstructorParameters<typeof Pool>[0]) => new Pool({ ...config, max: 6 });

before(async () => {
  const opened = await openVerifiedTestDatabase(process.env.TEST_DATABASE_URL);
  admin = opened.pool;
  target = opened.target;
  await admin.query(`CREATE SCHEMA ${quoted}`);
  pool = await openVerifiedIsolatedPool(target, schema, wide);
  assert.equal((await runMigrations(pool)).applied.length, 22);
});

after(async () => {
  if (pool) await pool.end();
  if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${quoted} CASCADE`); await admin.end(); }
});

// ───────────── données réelles du catalogue, évaluations par le VRAI worker ─────────────

const resetAll = () => pool.query(
  "TRUNCATE notification_deliveries, notifications, notification_preferences, matching_evaluations, matching_jobs, matching_outbox_events, phone_identities, demands, offers, users CASCADE");

const offerInput = (ownerId: string, extra: Record<string, unknown> = {}) => ({
  ownerId, rawText: "iPhone 13 128Go avec chargeur", category: "smartphones", brand: "Apple", model: "iPhone 13", variant: "128 Go",
  attributes: { charger_included: true }, price: { amount: 250_000, currency: "XOF" }, status: "published" as const, ...extra,
});

const demandInput = (ownerId: string, extra: Record<string, unknown> = {}) => ({
  ownerId, rawText: "Cherche iPhone 13", category: "smartphones", brand: "Apple", model: "iPhone 13",
  requirements: [{ key: "chargeur", operator: "includes", value: "chargeur" }],
  budget: { amount: 300_000, currency: "XOF" }, status: "active" as const, ...extra,
});

/** Un vendeur, un acheteur, et leurs ressources (rien n'est encore évalué : les événements attendent la projection). */
async function people(): Promise<{ seller: UserRecord; buyer: UserRecord }> {
  return { seller: await createUser({}, pool), buyer: await createUser({}, pool) };
}

let workerSequence = 0;
/** Projette l'outbox puis exécute TOUS les jobs d'évaluation (un par un) jusqu'à épuisement : l'état final après les évaluations du worker. */
async function drain(db: Pool = pool): Promise<number> {
  let jobs = 0;
  for (let round = 0; round < 6; round += 1) {
    const projected = await projectOutboxBatch({ pool: db, limit: 100 });
    for (let index = 0; index < 100; index += 1) {
      workerSequence += 1;
      const results = await runMatchingWorkerOnce({ pool: db, workerId: `n1-worker-${workerSequence}`, limit: 1 });
      if (results.length === 0) break;
      for (const result of results) assert.equal(result.outcome, "completed", `job terminé : ${result.outcome} ${result.errorCode ?? ""}`);
      jobs += results.length;
    }
    if (projected.selected === 0) break;
  }
  return jobs;
}

/** Ne laisse réservable que le job du pivot demandé (les autres jobs créés par le catalogue sont écartés). */
async function isolate(resourceId: string): Promise<void> {
  await pool.query("UPDATE matching_jobs SET status = 'superseded', completed_at = clock_timestamp() WHERE resource_id <> $1 AND status = 'pending'", [resourceId]);
}

async function runOnly(resourceId: string, hooks?: MatchingWorkerHooks) {
  await isolate(resourceId);
  workerSequence += 1;
  const results = await runMatchingWorkerOnce({ pool, workerId: `n1-only-${workerSequence}`, limit: 1, hooks });
  assert.equal(results.length, 1);
  return results[0];
}

const notificationRows = async () => (await pool.query("SELECT * FROM notifications ORDER BY created_at, id")).rows;
const matchRows = async () => (await pool.query("SELECT * FROM notifications WHERE kind = 'new_match' ORDER BY created_at, id")).rows;
const digestRows = async () => (await pool.query("SELECT * FROM notifications WHERE kind = 'new_matches_digest' ORDER BY created_at, id")).rows;
const deliveryRows = async () => (await pool.query("SELECT * FROM notification_deliveries ORDER BY created_at, id")).rows;
const evaluationRows = async () => (await pool.query("SELECT * FROM matching_evaluations ORDER BY evaluated_at, id")).rows;
const count = async (table: string): Promise<number> => (await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n;

async function enableExternal(userId: string): Promise<void> {
  await pool.query("INSERT INTO notification_preferences (user_id, external_enabled) VALUES ($1, TRUE) ON CONFLICT (user_id) DO UPDATE SET external_enabled = TRUE", [userId]);
}

/** Exécute `work` dans UNE transaction PostgreSQL sur un client réservé (comme la transaction d'une évaluation), puis valide ou annule. */
async function inTransaction<T>(work: (client: PoolClient) => Promise<T>, finish: "commit" | "rollback" = "commit"): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query(finish === "commit" ? "COMMIT" : "ROLLBACK");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

const FRESH = (evaluationId: string, offer: OfferRecord, demand: DemandRecord, extra: Partial<Parameters<typeof recordNewMatchNotification>[1]> = {}) => ({
  evaluationId, offerId: offer.id, demandId: demand.id, offerOwnerId: offer.ownerId, demandOwnerId: demand.ownerId, isConfirmedMatch: true, ...extra,
});

async function directOutcome(offer: OfferRecord, demand: DemandRecord, evaluationId: string, extra: Partial<Parameters<typeof recordNewMatchNotification>[1]> = {}): Promise<NewMatchOutcome> {
  return inTransaction((client) => recordNewMatchNotification(client, FRESH(evaluationId, offer, demand, extra)));
}

// ───────────── 1. première correspondance ─────────────

test("première correspondance : UNE notification, pour l'acheteur seulement, titre / prix / lien en liste blanche ; deux évaluations du même couple, une seule notification", async () => {
  await resetAll();
  const { seller, buyer } = await people();
  const demand = await createDemand(demandInput(buyer.id), pool);
  const offer = await createOffer(offerInput(seller.id), pool);
  // Deux jobs évaluent le MÊME couple (job de l'offre et job du besoin) : deux évaluations, une seule notification.
  assert.equal(await drain(), 2);
  const evaluations = await evaluationRows();
  assert.equal(evaluations.length, 2, "le couple est évalué par les deux jobs");
  assert.equal(evaluations.filter((row) => row.is_latest).length, 1);
  assert.ok(evaluations.every((row) => row.is_confirmed_match));
  const rows = await notificationRows();
  assert.equal(rows.length, 1);
  const [row] = rows;
  assert.equal(row.user_id, buyer.id, "la notification est pour l'ACHETEUR");
  assert.equal(row.kind, "new_match");
  assert.equal(row.demand_id, demand.id);
  assert.equal(row.offer_id, offer.id);
  assert.equal(row.title, "Apple iPhone 13 128 Go");
  assert.equal(Number(row.price_amount), 250_000);
  assert.equal(row.price_currency, "XOF");
  assert.equal(row.read_at, null);
  assert.equal(row.digest_day, null);
  assert.equal(row.item_count, null);
  assert.equal((await pool.query("SELECT 1 FROM notifications WHERE user_id = $1", [seller.id])).rowCount, 0, "le vendeur n'est jamais notifié");
  assert.equal(await count("notification_deliveries"), 0, "envoi externe désactivé par défaut : aucune ligne d'outbox");
});

test("deux workers concurrents sur le même couple : toujours UNE notification", async () => {
  await resetAll();
  const { seller, buyer } = await people();
  await createDemand(demandInput(buyer.id), pool);
  await createOffer(offerInput(seller.id), pool);
  await projectOutboxBatch({ pool, limit: 100 });
  const [a, b] = await Promise.all([
    runMatchingWorkerOnce({ pool, workerId: "n1-concurrent-a", limit: 1 }),
    runMatchingWorkerOnce({ pool, workerId: "n1-concurrent-b", limit: 1 }),
  ]);
  assert.equal(a.length + b.length, 2);
  assert.equal((await matchRows()).length, 1);
  assert.equal(await count("matching_evaluations"), 2);
});

// ───────────── 2. aucun doublon : rejeu, panne, mort du processus ─────────────

test("mort du processus JUSTE APRÈS l'écriture de l'évaluation : la notification existe déjà (même transaction) et le rejeu n'en crée pas d'autre", async () => {
  await resetAll();
  const { seller, buyer } = await people();
  await createDemand(demandInput(buyer.id), pool);
  const offer = await createOffer(offerInput(seller.id), pool);
  await projectOutboxBatch({ pool, limit: 100 });
  const first = await runOnly(offer.id, { afterPersist: () => "abandon" });
  assert.equal(first.outcome, "abandoned");
  assert.equal(first.persisted, 0, "le job est mort avant d'acquitter le candidat");
  assert.equal(await count("matching_evaluations"), 1, "l'évaluation est écrite");
  assert.equal((await matchRows()).length, 1, "la notification est écrite avec elle : une mort à cet instant n'en fait perdre aucune");
  await pool.query("UPDATE matching_jobs SET lock_expires_at = clock_timestamp() - interval '1 second' WHERE status = 'running'");
  const second = await runOnly(offer.id);
  assert.equal(second.outcome, "completed");
  assert.equal(second.replayed, 1, "rejeu de la même tentative : aucune nouvelle écriture");
  assert.equal(await count("matching_evaluations"), 1);
  assert.equal((await matchRows()).length, 1, "aucun doublon");
});

test("panne AU MILIEU de la transaction (après l'écriture de la notification, avant le COMMIT) : ni évaluation ni notification, puis la relance écrit les deux, une seule fois", async () => {
  await resetAll();
  const { seller, buyer } = await people();
  await createDemand(demandInput(buyer.id), pool);
  const offer = await createOffer(offerInput(seller.id), pool);
  await projectOutboxBatch({ pool, limit: 100 });
  let seenInside = 0;
  const failed = await runOnly(offer.id, {
    insideTransaction: async (stage) => {
      if (stage !== "after_notification") return;
      seenInside = (await pool.query("SELECT count(*)::int AS n FROM notifications")).rows[0].n;
      throw new Error("panne simulée au milieu de la transaction");
    },
  });
  assert.equal(failed.outcome, "failed");
  assert.equal(failed.errorCode, "worker_exception");
  assert.equal(seenInside, 0, "hors transaction, la notification n'est pas encore visible");
  assert.equal(await count("matching_evaluations"), 0, "l'évaluation est annulée");
  assert.equal(await count("notifications"), 0, "la notification est annulée avec elle");
  await pool.query("UPDATE matching_jobs SET scheduled_at = clock_timestamp() - interval '1 second' WHERE status = 'failed'");
  const retried = await runOnly(offer.id);
  assert.equal(retried.outcome, "completed");
  assert.equal(await count("matching_evaluations"), 1);
  assert.equal((await matchRows()).length, 1, "exactement une notification après la panne et la relance");
});

test("mort du processus DANS la transaction, avant l'écriture de la notification (« abandon ») : rien n'est écrit, le bail expire, la reprise écrit les deux une fois", async () => {
  await resetAll();
  const { seller, buyer } = await people();
  await createDemand(demandInput(buyer.id), pool);
  const offer = await createOffer(offerInput(seller.id), pool);
  await projectOutboxBatch({ pool, limit: 100 });
  const dead = await runOnly(offer.id, { insideTransaction: (stage) => (stage === "before_notification" ? "abandon" : undefined) });
  assert.equal(dead.outcome, "abandoned");
  assert.equal(await count("matching_evaluations"), 0);
  assert.equal(await count("notifications"), 0);
  await pool.query("UPDATE matching_jobs SET lock_expires_at = clock_timestamp() - interval '1 second' WHERE status = 'running'");
  assert.equal((await runOnly(offer.id)).outcome, "completed");
  assert.equal(await count("matching_evaluations"), 1);
  assert.equal((await matchRows()).length, 1);
});

test("réévaluation d'un couple déjà notifié (annonce modifiée) : aucune seconde notification, lue ou non", async () => {
  await resetAll();
  const { seller, buyer } = await people();
  await createDemand(demandInput(buyer.id), pool);
  const offer = await createOffer(offerInput(seller.id), pool);
  await drain();
  assert.equal((await matchRows()).length, 1);
  await pool.query("UPDATE notifications SET read_at = clock_timestamp()");
  await updateOffer({ id: offer.id, ownerId: seller.id, expectedContentVersion: offer.contentVersion, changes: { price: { amount: 240_000, currency: "XOF" } } }, pool);
  await drain();
  const evaluations = await evaluationRows();
  assert.ok(evaluations.length >= 3, "le couple a été réévalué");
  assert.equal(evaluations.filter((row) => row.is_latest && row.is_confirmed_match && !row.is_stale).length, 1);
  const rows = await matchRows();
  assert.equal(rows.length, 1, "aucune seconde notification");
  assert.notEqual(rows[0].read_at, null, "la notification lue reste lue");
});

test("anciens couples : un couple qui était déjà une correspondance confirmée avant le service ne notifie jamais, même sans aucune notification existante", async () => {
  await resetAll();
  const { seller, buyer } = await people();
  await createDemand(demandInput(buyer.id), pool);
  const offer = await createOffer(offerInput(seller.id), pool);
  await drain();
  // Comme avant le service : le couple était confirmé (historique), aucune notification n'existe.
  await pool.query("DELETE FROM notifications");
  await updateOffer({ id: offer.id, ownerId: seller.id, expectedContentVersion: offer.contentVersion, changes: { price: { amount: 245_000, currency: "XOF" } } }, pool);
  await drain();
  assert.equal(await count("notifications"), 0, "le couple était déjà une correspondance : aucune notification");
  assert.ok((await evaluationRows()).some((row) => row.is_latest && row.is_confirmed_match));
});

test("un couple qui devient correspondance pour la PREMIÈRE fois après une modification notifie (prix passé sous le budget)", async () => {
  await resetAll();
  const { seller, buyer } = await people();
  await createDemand(demandInput(buyer.id), pool);
  const offer = await createOffer(offerInput(seller.id, { price: { amount: 900_000, currency: "XOF" } }), pool);
  await drain();
  assert.equal(await count("notifications"), 0, "hors budget : pas une correspondance confirmée");
  await updateOffer({ id: offer.id, ownerId: seller.id, expectedContentVersion: offer.contentVersion, changes: { price: { amount: 250_000, currency: "XOF" } } }, pool);
  await drain();
  const rows = await matchRows();
  assert.equal(rows.length, 1, "nouvellement correspondant : notifié");
  assert.equal(Number(rows[0].price_amount), 250_000, "le prix figé est celui de l'annonce au moment de la correspondance");
});

// ───────────── 3. recalcul en masse : aucune rafale, plafond de 20, résumé ─────────────

test("plafond de 20 notifications par besoin et par jour, puis UN résumé qui compte le reste ; un recalcul en masse ne notifie plus ; le lendemain le plafond repart", async () => {
  await resetAll();
  const { seller, buyer } = await people();
  const demand = await createDemand(demandInput(buyer.id), pool);
  const offers: OfferRecord[] = [];
  for (let index = 0; index < 25; index += 1) offers.push(await createOffer(offerInput(seller.id, { rawText: `iPhone 13 n°${index}` }), pool));
  await drain();
  assert.equal((await matchRows()).length, NEW_MATCH_DAILY_CAP_PER_DEMAND, "20 notifications au plus");
  let digests = await digestRows();
  assert.equal(digests.length, 1, "un seul résumé");
  assert.equal(digests[0].item_count, 5, "le résumé compte les 5 annonces au-delà du plafond");
  assert.equal(digests[0].user_id, buyer.id);
  assert.equal(digests[0].demand_id, demand.id);
  assert.equal(digests[0].offer_id, null);
  assert.equal(digests[0].title, null);
  assert.equal(digests[0].price_amount, null);

  // Recalcul en masse (changement de contenu de toutes les annonces) : les couples étaient déjà des correspondances.
  for (const offer of offers) {
    await updateOffer({ id: offer.id, ownerId: seller.id, expectedContentVersion: offer.contentVersion, changes: { price: { amount: 240_000, currency: "XOF" } } }, pool);
  }
  await drain();
  assert.equal((await matchRows()).length, NEW_MATCH_DAILY_CAP_PER_DEMAND, "aucune rafale au recalcul");
  digests = await digestRows();
  assert.equal(digests.length, 1);
  assert.equal(digests[0].item_count, 5, "le résumé n'est pas recompté");

  // De nouvelles annonces le même jour : le résumé grandit, jamais une 21e notification.
  for (let index = 0; index < 3; index += 1) await createOffer(offerInput(seller.id, { rawText: `iPhone 13 supplémentaire ${index}` }), pool);
  await drain();
  assert.equal((await matchRows()).length, NEW_MATCH_DAILY_CAP_PER_DEMAND);
  digests = await digestRows();
  assert.equal(digests.length, 1, "un seul résumé par besoin et par jour");
  assert.equal(digests[0].item_count, 8);

  // Le lendemain (jour UTC suivant) : le plafond repart de zéro et le résumé est celui d'un autre jour.
  await pool.query("UPDATE notifications SET created_at = created_at - interval '1 day', digest_day = digest_day - 1 WHERE kind = 'new_matches_digest'");
  await pool.query("UPDATE notifications SET created_at = created_at - interval '1 day' WHERE kind = 'new_match'");
  await createOffer(offerInput(seller.id, { rawText: "iPhone 13 du lendemain" }), pool);
  await drain();
  assert.equal((await matchRows()).length, NEW_MATCH_DAILY_CAP_PER_DEMAND + 1, "le plafond du jour est repris à zéro");
  assert.equal((await digestRows()).length, 1);
});

test("deux besoins d'un même acheteur ont chacun leur plafond de 20 et leur résumé", async () => {
  await resetAll();
  const { seller, buyer } = await people();
  const first = await createDemand(demandInput(buyer.id), pool);
  const second = await createDemand(demandInput(buyer.id, { rawText: "Cherche iPhone 13 (bis)" }), pool);
  for (let index = 0; index < 22; index += 1) await createOffer(offerInput(seller.id, { rawText: `iPhone 13 n°${index}` }), pool);
  await drain();
  for (const demand of [first, second]) {
    assert.equal((await pool.query("SELECT 1 FROM notifications WHERE demand_id = $1 AND kind = 'new_match'", [demand.id])).rowCount, 20);
    assert.equal((await pool.query("SELECT item_count FROM notifications WHERE demand_id = $1 AND kind = 'new_matches_digest'", [demand.id])).rows[0].item_count, 2);
  }
});

test("le plafond est EXACT sous concurrence : le verrou par utilisateur et par jour est pris AVANT de compter", async () => {
  await resetAll();
  const seller = await makePerson(pool);
  const buyer = await makePerson(pool);
  const demand = await makeDemand(pool, buyer.id);
  const offer = await makeOffer(pool, seller.id);
  const evaluationId = await insertEvaluation(pool, { offer, demand });
  const day = (await pool.query<{ day: string }>("SELECT (clock_timestamp() AT TIME ZONE 'UTC')::date::text AS day")).rows[0].day;
  const holder = await pool.connect();
  try {
    await holder.query("BEGIN");
    await holder.query("SELECT pg_advisory_xact_lock($1, hashtext($2))", [NOTIFICATION_CAP_LOCK_NAMESPACE, `${buyer.id}:${day}`]);
    const blocked = await inTransaction(async (client) => {
      await client.query("SET LOCAL lock_timeout = '400ms'");
      return recordNewMatchNotification(client, FRESH(evaluationId, offer, demand)).then(() => "passé", (error: { code?: string }) => error.code);
    }, "rollback").catch((error: { code?: string }) => error.code);
    assert.equal(blocked, "55P03", "le calcul attend le verrou de l'utilisateur et du jour : sans lui les plafonds ne seraient pas exacts");
  } finally {
    await holder.query("ROLLBACK");
    holder.release();
  }
  assert.equal((await directOutcome(offer, demand, evaluationId)).kind, "created", "le verrou libéré, la notification naît");
});

test("rafale simultanée : 30 évaluations concurrentes du même besoin donnent exactement 20 notifications et un résumé de 10", async () => {
  await resetAll();
  const seller = await makePerson(pool);
  const buyer = await makePerson(pool);
  const demand = await makeDemand(pool, buyer.id);
  const pairs: Array<{ offer: OfferRecord; evaluationId: string }> = [];
  for (let index = 0; index < 30; index += 1) {
    const offer = await makeOffer(pool, seller.id, { price: 200_000 + index });
    pairs.push({ offer, evaluationId: await insertEvaluation(pool, { offer, demand }) });
  }
  const outcomes = await Promise.all(pairs.map((pair) => directOutcome(pair.offer, demand, pair.evaluationId)));
  assert.equal(outcomes.filter((outcome) => outcome.kind === "created").length, 20);
  assert.equal(outcomes.filter((outcome) => outcome.kind === "digested").length, 10);
  assert.equal((await matchRows()).length, 20);
  assert.equal((await digestRows())[0].item_count, 10);
});

// ───────────── 4. suivi : pause, expiration, satisfait, archivé ─────────────

test("besoin en pause : le matching continue (l'évaluation est écrite) mais AUCUNE notification ; à la reprise, la suivante notifie", async () => {
  await resetAll();
  const { seller, buyer } = await people();
  const demand = await createDemand(demandInput(buyer.id), pool);
  await createOffer(offerInput(seller.id, { rawText: "première annonce" }), pool);
  await drain();
  assert.equal((await matchRows()).length, 1);
  const paused = await applyTrackingAction({ pool, ownerId: buyer.id, demandId: demand.id, action: "pause" });
  assert.equal(paused.paused, true);
  assert.equal(paused.active, false);
  const second = await createOffer(offerInput(seller.id, { rawText: "annonce pendant la pause" }), pool);
  await drain();
  const evaluations = (await evaluationRows()).filter((row) => row.offer_id === second.id);
  assert.equal(evaluations.length, 1, "le matching continue pendant la pause");
  assert.ok(evaluations[0].is_confirmed_match && evaluations[0].is_latest, "le résultat est visible (correspondance confirmée et fraîche)");
  assert.equal((await matchRows()).length, 1, "aucune notification pendant la pause");
  await applyTrackingAction({ pool, ownerId: buyer.id, demandId: demand.id, action: "resume" });
  await createOffer(offerInput(seller.id, { rawText: "annonce après la reprise" }), pool);
  await drain();
  assert.equal((await matchRows()).length, 2, "après la reprise, une nouvelle annonce notifie");
  assert.equal((await pool.query("SELECT 1 FROM notifications WHERE offer_id = $1", [second.id])).rowCount, 0, "l'annonce de la pause n'est pas notifiée après coup");
});

test("suivi expiré : le matching continue, aucune notification ; prolonger la rétablit", async () => {
  await resetAll();
  const { seller, buyer } = await people();
  const demand = await createDemand(demandInput(buyer.id), pool);
  await pool.query("UPDATE demands SET notify_until = created_at WHERE id = $1", [demand.id]);
  const offer = await createOffer(offerInput(seller.id), pool);
  await drain();
  assert.equal(await count("notifications"), 0, "suivi expiré : aucune notification");
  assert.ok((await evaluationRows()).some((row) => row.offer_id === offer.id && row.is_confirmed_match && row.is_latest), "le matching continue après l'expiration");
  const tracking = await readDemandTracking({ pool, ownerId: buyer.id, demandId: demand.id });
  assert.equal(tracking?.active, false);
  const extended = await applyTrackingAction({ pool, ownerId: buyer.id, demandId: demand.id, action: "extend" });
  assert.equal(extended.active, true);
  await createOffer(offerInput(seller.id, { rawText: "annonce après la prolongation" }), pool);
  await drain();
  assert.equal((await matchRows()).length, 1);
});

test("besoin satisfait ou archivé : les envois EN ATTENTE passent à 'cancelled' dans la MÊME transaction que le changement de statut", async () => {
  await resetAll();
  const { seller, buyer } = await people();
  await enableExternal(buyer.id);
  const make = async (): Promise<DemandRecord> => {
    const demand = await createDemand(demandInput(buyer.id, { rawText: `besoin ${Math.random()}` }), pool);
    await createOffer(offerInput(seller.id, { rawText: `annonce ${Math.random()}` }), pool);
    return demand;
  };
  const satisfied = await make();
  const archived = await make();
  const drafted = await make();
  await drain();
  const pendingFor = async (demandId: string) => (await pool.query("SELECT status, reason FROM notification_deliveries WHERE demand_id = $1", [demandId])).rows;
  for (const demand of [satisfied, archived, drafted]) {
    const rows = await pendingFor(demand.id);
    assert.ok(rows.length >= 1 && rows.every((row) => row.status === "pending"), "des envois en attente existent");
  }
  await satisfyDemand(buyer.id, satisfied.id, satisfied.contentVersion, pool);
  assert.ok((await pendingFor(satisfied.id)).every((row) => row.status === "cancelled" && row.reason === "demand_satisfied"));
  await archiveDemand(buyer.id, archived.id, archived.contentVersion, pool);
  assert.ok((await pendingFor(archived.id)).every((row) => row.status === "cancelled" && row.reason === "demand_archived"));
  await updateDemand({ id: drafted.id, ownerId: buyer.id, expectedContentVersion: drafted.contentVersion, changes: { status: "draft" } }, pool);
  assert.ok((await pendingFor(drafted.id)).every((row) => row.status === "cancelled" && row.reason === "demand_inactive"));
  // Les envois des AUTRES besoins ne sont pas touchés : un quatrième besoin garde les siens en attente.
  const other = await make();
  await drain();
  const otherRows = await pendingFor(other.id);
  assert.ok(otherRows.length >= 1 && otherRows.every((row) => row.status === "pending"), "un autre besoin garde ses envois en attente");
});

test("l'annulation est ATOMIQUE avec le changement de statut : si la transaction échoue, les envois restent en attente et le besoin reste actif", async () => {
  await resetAll();
  const { seller, buyer } = await people();
  await enableExternal(buyer.id);
  const demand = await createDemand(demandInput(buyer.id), pool);
  await createOffer(offerInput(seller.id), pool);
  await drain();
  assert.equal((await deliveryRows()).filter((row) => row.status === "pending").length, 1);
  await pool.query(`CREATE FUNCTION fail_demand_outbox() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.event_type = 'demand.satisfied' THEN RAISE EXCEPTION 'panne injectée'; END IF; RETURN NEW; END $$`);
  await pool.query("CREATE TRIGGER trg_fail_demand_outbox BEFORE INSERT ON matching_outbox_events FOR EACH ROW EXECUTE FUNCTION fail_demand_outbox()");
  try {
    await assert.rejects(() => satisfyDemand(buyer.id, demand.id, demand.contentVersion, pool), /panne injectée/);
  } finally {
    await pool.query("DROP TRIGGER trg_fail_demand_outbox ON matching_outbox_events");
    await pool.query("DROP FUNCTION fail_demand_outbox()");
  }
  assert.equal((await deliveryRows()).filter((row) => row.status === "pending").length, 1, "annulation défaite avec le changement de statut");
  assert.equal((await pool.query("SELECT status FROM demands WHERE id = $1", [demand.id])).rows[0].status, "active");
});

// ───────────── 5. motifs de non-notification (appel direct, transaction réelle) ─────────────

test("aucune notification, avec son motif : évaluation non confirmée, vendeur = acheteur, annonce non publiée ou indisponible, évaluation périmée, configuration autre, évaluation expirée", async () => {
  await resetAll();
  const seller = await makePerson(pool);
  const buyer = await makePerson(pool);
  const demand = await makeDemand(pool, buyer.id);
  const offer = await makeOffer(pool, seller.id);
  const evaluationId = await insertEvaluation(pool, { offer, demand });

  assert.deepEqual(await directOutcome(offer, demand, evaluationId, { isConfirmedMatch: false }), { kind: "not_confirmed" });
  assert.deepEqual(await directOutcome(offer, { ...demand, ownerId: seller.id } as DemandRecord, evaluationId), { kind: "own_offer" });

  // annonce en pause, indisponible : la correspondance n'est plus fraîche (même prédicat que la lecture)
  await pool.query("UPDATE offers SET status = 'paused' WHERE id = $1", [offer.id]);
  assert.deepEqual(await directOutcome(offer, demand, evaluationId), { kind: "not_fresh" });
  await pool.query("UPDATE offers SET status = 'published', availability_status = 'unavailable' WHERE id = $1", [offer.id]);
  assert.deepEqual(await directOutcome(offer, demand, evaluationId), { kind: "not_fresh" });
  await pool.query("UPDATE offers SET availability_status = 'available' WHERE id = $1", [offer.id]);

  // évaluation périmée, d'une autre configuration, expirée
  await pool.query("UPDATE matching_evaluations SET is_latest = FALSE, is_stale = TRUE, stale_reason = 'offer_updated', staled_at = clock_timestamp() WHERE id = $1", [evaluationId]);
  assert.deepEqual(await directOutcome(offer, demand, evaluationId), { kind: "not_fresh" });
  const other = await insertEvaluation(pool, { offer: await makeOffer(pool, seller.id, { model: "iPhone 14" }), demand });
  await pool.query("UPDATE matching_evaluations SET scoring_config_hash = $2 WHERE id = $1", [other, "f".repeat(64)]);
  const otherOffer = (await pool.query<{ offer_id: string }>("SELECT offer_id FROM matching_evaluations WHERE id = $1", [other])).rows[0].offer_id;
  assert.deepEqual(await directOutcome({ ...offer, id: otherOffer } as OfferRecord, demand, other), { kind: "not_fresh" }, "configuration de scoring qui n'est pas celle de la lecture");
  const expired = await insertEvaluation(pool, { offer: await makeOffer(pool, seller.id, { model: "iPhone 15" }), demand });
  await pool.query("UPDATE matching_evaluations SET expires_at = clock_timestamp() - interval '1 second' WHERE id = $1", [expired]);
  const expiredOffer = (await pool.query<{ offer_id: string }>("SELECT offer_id FROM matching_evaluations WHERE id = $1", [expired])).rows[0].offer_id;
  assert.deepEqual(await directOutcome({ ...offer, id: expiredOffer } as OfferRecord, demand, expired), { kind: "not_fresh" });
  assert.equal(await count("notifications"), 0);
});

test("besoin satisfait, archivé ou remis en brouillon : aucune notification (la correspondance n'est plus fraîche pour un besoin non actif)", async () => {
  await resetAll();
  const seller = await makePerson(pool);
  const buyer = await makePerson(pool);
  const offer = await makeOffer(pool, seller.id);
  for (const change of [
    "status = 'satisfied'",
    "status = 'archived', archived_at = clock_timestamp()",
    "status = 'draft'",
  ]) {
    const demand = await makeDemand(pool, buyer.id);
    const evaluationId = await insertEvaluation(pool, { offer, demand });
    await pool.query(`UPDATE demands SET ${change} WHERE id = $1`, [demand.id]);
    assert.deepEqual(await directOutcome(offer, demand, evaluationId), { kind: "not_fresh" }, change);
  }
  assert.equal(await count("notifications"), 0);
});

test("besoin non actif, en pause ou expiré : motifs distincts (appel direct)", async () => {
  await resetAll();
  const seller = await makePerson(pool);
  const buyer = await makePerson(pool);
  const demand = await makeDemand(pool, buyer.id);
  const offer = await makeOffer(pool, seller.id);
  const evaluationId = await insertEvaluation(pool, { offer, demand });
  await pool.query("UPDATE demands SET notify_paused = TRUE WHERE id = $1", [demand.id]);
  assert.deepEqual(await directOutcome(offer, demand, evaluationId), { kind: "tracking_paused" });
  await pool.query("UPDATE demands SET notify_paused = FALSE, notify_until = created_at WHERE id = $1", [demand.id]);
  assert.deepEqual(await directOutcome(offer, demand, evaluationId), { kind: "tracking_expired" });
  await pool.query("UPDATE demands SET notify_until = created_at + interval '30 days' WHERE id = $1", [demand.id]);
  const outcome = await directOutcome(offer, demand, evaluationId);
  assert.equal(outcome.kind, "created");
  // Une seconde demande du même appel : déjà notifiée.
  assert.deepEqual(await directOutcome(offer, demand, evaluationId), { kind: "already_notified" });
  assert.equal((await matchRows()).length, 1);
});

test("une notification existante n'est jamais recréée (clé unique) ; ON CONFLICT DO NOTHING : pas d'erreur, pas de doublon", async () => {
  await resetAll();
  const seller = await makePerson(pool);
  const buyer = await makePerson(pool);
  const demand = await makeDemand(pool, buyer.id);
  const offer = await makeOffer(pool, seller.id);
  const evaluationId = await insertEvaluation(pool, { offer, demand });
  assert.equal((await directOutcome(offer, demand, evaluationId)).kind, "created");
  // Une SECONDE évaluation confirmée du même couple, dans la MÊME transaction de lecture : l'historique l'exclut déjà ; la clé unique est la dernière barrière.
  await assert.rejects(
    () => pool.query(
      "INSERT INTO notifications (user_id, kind, demand_id, offer_id, title) VALUES ($1, 'new_match', $2, $3, 'doublon')",
      [buyer.id, demand.id, offer.id],
    ),
    (error: { code?: string }) => error.code === "23505",
    "la base refuse un doublon (utilisateur, besoin, annonce)",
  );
  const insertOnConflict = await pool.query(
    "INSERT INTO notifications (user_id, kind, demand_id, offer_id, title) VALUES ($1, 'new_match', $2, $3, 'doublon') ON CONFLICT (user_id, kind, demand_id, offer_id) WHERE kind = 'new_match' DO NOTHING",
    [buyer.id, demand.id, offer.id],
  );
  assert.equal(insertOnConflict.rowCount, 0);
  assert.equal((await matchRows()).length, 1);
});

test("deux appels simultanés pour la MÊME évaluation (crochet rejoué) : une notification, l'autre voit « déjà notifiée » sans erreur (ON CONFLICT DO NOTHING)", async () => {
  await resetAll();
  const seller = await makePerson(pool);
  const buyer = await makePerson(pool);
  const demand = await makeDemand(pool, buyer.id);
  const offer = await makeOffer(pool, seller.id);
  const evaluationId = await insertEvaluation(pool, { offer, demand });
  const outcomes = await Promise.all([directOutcome(offer, demand, evaluationId), directOutcome(offer, demand, evaluationId)]);
  assert.deepEqual(outcomes.map((outcome) => outcome.kind).sort(), ["already_notified", "created"]);
  assert.equal((await matchRows()).length, 1);
});

test("clé d'idempotence de l'envoi : une notification recréée après la perte de la sienne ne duplique pas l'envoi (ON CONFLICT DO NOTHING)", async () => {
  await resetAll();
  const seller = await makePerson(pool);
  const buyer = await makePerson(pool);
  await enableExternal(buyer.id);
  const demand = await makeDemand(pool, buyer.id);
  const offer = await makeOffer(pool, seller.id);
  const evaluationId = await insertEvaluation(pool, { offer, demand });
  const first = await directOutcome(offer, demand, evaluationId);
  assert.deepEqual({ kind: first.kind, delivery: first.kind === "created" ? first.deliveryCreated : null }, { kind: "created", delivery: true });
  // La notification disparaît (purge de rétention) ; l'envoi, lui, reste : la clé d'idempotence l'empêche d'être dupliqué.
  await pool.query("DELETE FROM notifications");
  assert.equal((await deliveryRows()).length, 1);
  const again = await directOutcome(offer, demand, evaluationId);
  assert.deepEqual({ kind: again.kind, delivery: again.kind === "created" ? again.deliveryCreated : null }, { kind: "created", delivery: false });
  assert.equal((await deliveryRows()).length, 1, "un seul envoi pour ce couple");
});

test("une base pas encore migrée (0019) n'est jamais une erreur : l'évaluation s'écrit sans notification", async () => {
  await resetAll();
  const seller = await makePerson(pool);
  const buyer = await makePerson(pool);
  const demand = await makeDemand(pool, buyer.id);
  const offer = await makeOffer(pool, seller.id);
  const evaluationId = await insertEvaluation(pool, { offer, demand });
  const outcome = await inTransaction(async (client) => {
    await client.query("ALTER TABLE notifications RENAME TO notifications_renamed");
    return recordNewMatchNotification(client, FRESH(evaluationId, offer, demand));
  }, "rollback");
  assert.deepEqual(outcome, { kind: "schema_absent" });
  assert.equal(await count("notifications"), 0);
  // Sans la table des préférences non plus.
  const outcomePreferences = await inTransaction(async (client) => {
    await client.query("ALTER TABLE notification_preferences RENAME TO notification_preferences_renamed");
    return recordNewMatchNotification(client, FRESH(evaluationId, offer, demand));
  }, "rollback");
  assert.deepEqual(outcomePreferences, { kind: "schema_absent" });
});

test("une transaction est exigée : un pool ou une connexion hors transaction sont refusés avant SQL", async () => {
  await assert.rejects(() => recordNewMatchNotification(pool as unknown as PoolClient, { evaluationId: "x", offerId: "x", demandId: "x", offerOwnerId: "a", demandOwnerId: "b", isConfirmedMatch: true }), /transaction active/);
  const client = await pool.connect();
  try {
    assert.throws(() => requireTransactionClient(client), /transaction active/);
    await client.query("BEGIN");
    assert.equal(requireTransactionClient(client), client);
    await client.query("ROLLBACK");
  } finally {
    client.release();
  }
});

// ───────────── 6. bootstrap : aucune rafale ─────────────

test("bootstrap du catalogue existant : les jobs créés par le bootstrap n'écrivent AUCUNE notification (les couples existaient avant le service)", async () => {
  await resetAll();
  const { seller, buyer } = await people();
  for (let index = 0; index < 3; index += 1) await createOffer(offerInput(seller.id, { rawText: `iPhone 13 n°${index}` }), pool);
  await createDemand(demandInput(buyer.id), pool);
  // Catalogue « antérieur à l'outbox » : événements et jobs supprimés ; le bootstrap recrée les jobs.
  await pool.query("DELETE FROM matching_jobs");
  await pool.query("DELETE FROM matching_outbox_events");
  const bootstrap = await runCatalogBootstrap({ pool });
  assert.ok(bootstrap.jobsInserted >= 2);
  const jobs = (await pool.query<{ source_event_id: string }>("SELECT source_event_id FROM matching_jobs")).rows;
  assert.ok(jobs.length >= 2 && jobs.every((job) => job.source_event_id === bootstrap.eventId));
  await drain();
  assert.ok((await evaluationRows()).filter((row) => row.is_confirmed_match).length >= 3, "les évaluations sont écrites");
  assert.equal(await count("notifications"), 0, "aucune notification issue du bootstrap");
  // Un événement ordinaire notifie bien ensuite (le silence ne vaut que pour le bootstrap).
  await createOffer(offerInput(seller.id, { rawText: "iPhone 13 après le bootstrap" }), pool);
  await drain();
  assert.equal((await matchRows()).length, 1);
});

// ───────────── 7. liste blanche du contenu ─────────────

test("contenu : jamais le téléphone du vendeur, son identifiant ni le texte libre de l'annonce, dans la notification ni dans l'envoi figé", async () => {
  await resetAll();
  const seller = await makePerson(pool);
  const buyer = await makePerson(pool);
  await enableExternal(buyer.id);
  const demand = await makeDemand(pool, buyer.id);
  // Lot D1 : le catalogue refuse désormais une variante ou un attribut qui ressemble à un numéro : l'annonce est créée sans, puis la variante et l'attribut sont écrits
  // directement en base (une annonce plus ancienne que la règle) ; ce que l'essai vérifie, c'est que la notification ne les reprend jamais.
  const created = await createOffer({
    ownerId: seller.id, rawText: "RAW_SECRET_TEXT appelez le 07 07 07 07 07", category: PRODUCT.category, brand: PRODUCT.brand, model: PRODUCT.model,
    price: { amount: 250_000, currency: "XOF" }, status: "published", availabilityStatus: "available",
  }, pool);
  const legacyAttributes = { note: "RAW_SECRET_ATTRIBUTE 0707070707" };
  await pool.query("UPDATE offers SET variant = '0707070707', attributes = $2::jsonb WHERE id = $1", [created.id, JSON.stringify(legacyAttributes)]);
  const offer = { ...created, variant: "0707070707", attributes: legacyAttributes };
  const evaluationId = await insertEvaluation(pool, { offer, demand });
  assert.equal((await directOutcome(offer, demand, evaluationId)).kind, "created");
  const stored = JSON.stringify({ notifications: await notificationRows(), deliveries: await deliveryRows() });
  for (const forbidden of [seller.phone as string, (seller.phone as string).slice(1), "RAW_SECRET", "0707070707", seller.id, "appelez"]) {
    assert.equal(stored.includes(forbidden), false, `contenu sans « ${forbidden} »`);
  }
  const [row] = await matchRows();
  assert.equal(row.title, "Apple iPhone 13", "la variante qui ressemble à un numéro est écartée");
  const [delivery] = await deliveryRows();
  assert.deepEqual(Object.keys(delivery.content).sort(), ["link", "price", "title"]);
  assert.equal(delivery.content.link, `/besoins/${demand.id}/offres/${offer.id}`);
  assert.equal(delivery.idempotency_key, `sms_sim:new_match:${demand.id}:${offer.id}`);
  assert.equal(delivery.status, "pending");
  assert.equal(delivery.notification_id, row.id);
});

test("envoi externe : une ligne d'outbox SEULEMENT pour l'utilisateur qui l'a demandé (désactivé par défaut)", async () => {
  await resetAll();
  const { seller, buyer } = await people();
  const quiet = await createUser({}, pool);
  const demand = await createDemand(demandInput(buyer.id), pool);
  const quietDemand = await createDemand(demandInput(quiet.id), pool);
  await createOffer(offerInput(seller.id), pool);
  await drain();
  assert.equal((await matchRows()).length, 2, "les deux acheteurs sont notifiés dans l'application");
  assert.equal(await count("notification_deliveries"), 0, "désactivé par défaut");
  await enableExternal(buyer.id);
  await createOffer(offerInput(seller.id, { rawText: "annonce suivante" }), pool);
  await drain();
  const deliveries = await deliveryRows();
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].user_id, buyer.id);
  assert.equal(deliveries[0].demand_id, demand.id);
  assert.notEqual(deliveries[0].demand_id, quietDemand.id);
  assert.equal(deliveries[0].channel, "sms_sim");
  assert.equal(deliveries[0].attempts, 0);
  assert.equal(deliveries[0].sent_at, null);
});

// ───────────── 8. suivi : colonnes, défaut, rattrapage, actions ─────────────

test("suivi : une nouvelle demande reçoit notify_until = created_at + 30 jours (déclencheur) ; les actions ne touchent ni content_version ni l'outbox", async () => {
  await resetAll();
  const buyer = await makePerson(pool);
  const demand = await makeDemand(pool, buyer.id);
  const row = (await pool.query<{ created_at: Date; notify_until: Date; notify_paused: boolean; content_version: number }>(
    "SELECT created_at, notify_until, notify_paused, content_version FROM demands WHERE id = $1", [demand.id])).rows[0];
  assert.equal(row.notify_until.getTime() - row.created_at.getTime(), 30 * 86_400_000);
  assert.equal(row.notify_paused, false);
  const events = await count("matching_outbox_events");
  const NOW = new Date(row.created_at.getTime() + 3_600_000);
  for (const action of ["pause", "pause", "resume", "resume", "extend"] as const) {
    await applyTrackingAction({ pool, ownerId: buyer.id, demandId: demand.id, action, now: NOW });
  }
  const after = (await pool.query<{ content_version: number; updated_at: Date }>("SELECT content_version, updated_at FROM demands WHERE id = $1", [demand.id])).rows[0];
  assert.equal(after.content_version, row.content_version, "le suivi n'est pas du contenu");
  assert.equal(await count("matching_outbox_events"), events, "aucun événement de matching");
  // Un INSERT à created_at choisi : le défaut suit created_at, pas l'horloge.
  const old = await pool.query<{ notify_until: Date; created_at: Date }>(
    `INSERT INTO demands (id, owner_id, status, raw_text, created_at, updated_at) VALUES (gen_random_uuid(), $1, 'draft', 'ancien', TIMESTAMPTZ '2030-01-01 00:00:00+00', TIMESTAMPTZ '2030-01-01 00:00:00+00')
     RETURNING created_at, notify_until`, [buyer.id]);
  assert.equal(old.rows[0].notify_until.toISOString(), "2030-01-31T00:00:00.000Z");
});

test("prolonger : +30 jours à partir de l'échéance (de maintenant si elle est passée), plafonné à maintenant + 90 jours, jamais réduit", async () => {
  await resetAll();
  const buyer = await makePerson(pool);
  const demand = await makeDemand(pool, buyer.id);
  const createdAt = (await pool.query<{ created_at: Date }>("SELECT created_at FROM demands WHERE id = $1", [demand.id])).rows[0].created_at;
  const NOW = new Date(createdAt.getTime() + 60_000);
  const day = 86_400_000;
  const first = await applyTrackingAction({ pool, ownerId: buyer.id, demandId: demand.id, action: "extend", now: NOW });
  assert.equal(first.until.getTime(), createdAt.getTime() + 60 * day, "échéance + 30 jours");
  const second = await applyTrackingAction({ pool, ownerId: buyer.id, demandId: demand.id, action: "extend", now: NOW });
  assert.equal(second.until.getTime(), createdAt.getTime() + 90 * day, "échéance + 30 jours, encore sous le plafond (maintenant + 90 jours)");
  const third = await applyTrackingAction({ pool, ownerId: buyer.id, demandId: demand.id, action: "extend", now: NOW });
  assert.equal(third.until.getTime(), NOW.getTime() + 90 * day, "échéance + 30 jours dépasserait : plafonné à maintenant + 90 jours");
  const fourth = await applyTrackingAction({ pool, ownerId: buyer.id, demandId: demand.id, action: "extend", now: NOW });
  assert.equal(fourth.until.getTime(), NOW.getTime() + 90 * day, "déjà au plafond : sans effet");
  assert.equal(fourth.maxUntil.getTime(), NOW.getTime() + 90 * day);
  for (let index = 0; index < 5; index += 1) {
    const again = await applyTrackingAction({ pool, ownerId: buyer.id, demandId: demand.id, action: "extend", now: NOW });
    assert.ok(again.until.getTime() <= NOW.getTime() + 90 * day, "jamais au-delà de 90 jours");
  }
  // Un jour plus tard, le plafond avance avec « maintenant ».
  const later = await applyTrackingAction({ pool, ownerId: buyer.id, demandId: demand.id, action: "extend", now: new Date(NOW.getTime() + day) });
  assert.equal(later.until.getTime(), NOW.getTime() + 91 * day);
  // Échéance passée : on repart de maintenant.
  await pool.query("UPDATE demands SET notify_until = created_at WHERE id = $1", [demand.id]);
  const revived = await applyTrackingAction({ pool, ownerId: buyer.id, demandId: demand.id, action: "extend", now: NOW });
  assert.equal(revived.until.getTime(), NOW.getTime() + 30 * day);
  assert.equal(revived.active, true);
});

test("actions de suivi : propriétaire seulement (inconnu = d'autrui), besoin actif seulement, pause et reprise idempotentes", async () => {
  await resetAll();
  const owner = await makePerson(pool);
  const stranger = await makePerson(pool);
  const demand = await makeDemand(pool, owner.id);
  await assert.rejects(() => applyTrackingAction({ pool, ownerId: stranger.id, demandId: demand.id, action: "pause" }), /introuvable/);
  await assert.rejects(() => applyTrackingAction({ pool, ownerId: owner.id, demandId: "00000000-0000-4000-8000-000000000000", action: "pause" }), /introuvable/);
  assert.equal(await readDemandTracking({ pool, ownerId: stranger.id, demandId: demand.id }), null);
  assert.equal((await pool.query("SELECT notify_paused FROM demands WHERE id = $1", [demand.id])).rows[0].notify_paused, false, "l'accès d'autrui n'a rien changé");
  const paused = await applyTrackingAction({ pool, ownerId: owner.id, demandId: demand.id, action: "pause" });
  const pausedAgain = await applyTrackingAction({ pool, ownerId: owner.id, demandId: demand.id, action: "pause" });
  assert.equal(paused.paused && pausedAgain.paused, true);
  const resumed = await applyTrackingAction({ pool, ownerId: owner.id, demandId: demand.id, action: "resume" });
  assert.equal(resumed.paused, false);
  assert.equal(resumed.active, true);
  await assert.rejects(() => applyTrackingAction({ pool, ownerId: owner.id, demandId: demand.id, action: "bad" as never }), /invalide/);
  await satisfyDemand(owner.id, demand.id, demand.contentVersion, pool);
  await assert.rejects(() => applyTrackingAction({ pool, ownerId: owner.id, demandId: demand.id, action: "extend" }), TrackingNotActiveError);
  const state = await readDemandTracking({ pool, ownerId: owner.id, demandId: demand.id });
  assert.equal(state?.demandStatus, "satisfied");
  assert.equal(state?.active, false);
});

test("migration 0019 appliquée à une base déjà peuplée : les besoins existants reçoivent maintenant + 30 jours, les nouveaux created_at + 30 jours", async () => {
  const lateSchema = createTemporarySchemaName();
  const lateQuoted = quoteTemporarySchema(lateSchema);
  await admin.query(`CREATE SCHEMA ${lateQuoted}`);
  const late = await openVerifiedIsolatedPool(target, lateSchema);
  try {
    const directory = join(process.cwd(), "database", "migrations");
    const all = readdirSync(directory).filter((name) => /^\d{4}_.*\.sql$/.test(name)).sort();
    assert.ok(all.includes("0019_notifications.sql"), "la migration 0019 existe");
    // La base « d'avant » reçoit les migrations ANTÉRIEURES à la 0019 (la 0020 et les suivantes en dépendent), choisies par leur numéro.
    const files = all.filter((name) => name < "0019_");
    assert.equal(files.length, 18);
    assert.ok(files.every((name) => name < "0019_"));
    for (const name of files) await late.query(readFileSync(join(directory, name), "utf8"));
    const owner = await createUser({}, late);
    const demand = await createDemand(demandInput(owner.id, { status: "draft" }), late);
    assert.equal((await late.query("SELECT 1 FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'demands' AND column_name = 'notify_until'", [lateSchema])).rowCount, 0);
    await late.query("UPDATE demands SET created_at = created_at - interval '400 days', updated_at = updated_at - interval '400 days' WHERE id = $1", [demand.id]);
    const before = (await late.query<{ now: Date }>("SELECT clock_timestamp() AS now")).rows[0].now;
    await late.query(readFileSync(join(directory, "0019_notifications.sql"), "utf8"));
    const row = (await late.query<{ notify_until: Date; notify_paused: boolean }>("SELECT notify_until, notify_paused FROM demands WHERE id = $1", [demand.id])).rows[0];
    const span = row.notify_until.getTime() - before.getTime();
    assert.ok(span > 29.99 * 86_400_000 && span < 30.01 * 86_400_000, `maintenant + 30 jours (${span / 86_400_000} jours)`);
    assert.equal(row.notify_paused, false);
    const fresh = await createDemand(demandInput(owner.id, { status: "draft" }), late);
    const created = (await late.query<{ created_at: Date; notify_until: Date }>("SELECT created_at, notify_until FROM demands WHERE id = $1", [fresh.id])).rows[0];
    assert.equal(created.notify_until.getTime() - created.created_at.getTime(), 30 * 86_400_000);
    // NOT NULL et CHECK.
    await assert.rejects(() => late.query("UPDATE demands SET notify_until = NULL WHERE id = $1", [fresh.id]), (error: { code?: string }) => error.code === "23502");
    await assert.rejects(() => late.query("UPDATE demands SET notify_until = created_at - interval '1 second' WHERE id = $1", [fresh.id]), (error: { code?: string }) => error.code === "23514");
  } finally {
    await late.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${lateQuoted} CASCADE`);
  }
});

test("migration 0019 : contraintes des tables (statuts, compteurs, formes, unicités) et index attendus", async () => {
  await resetAll();
  const seller = await makePerson(pool);
  const buyer = await makePerson(pool);
  const demand = await makeDemand(pool, buyer.id);
  const offer = await makeOffer(pool, seller.id);
  const bad = async (text: string, values: unknown[], code: string) => assert.rejects(() => pool.query(text, values), (error: { code?: string }) => error.code === code, text.slice(0, 80));
  await bad("INSERT INTO notifications (user_id, kind, demand_id, offer_id, title) VALUES ($1, 'autre', $2, $3, 't')", [buyer.id, demand.id, offer.id], "23514");
  await bad("INSERT INTO notifications (user_id, kind, demand_id, title) VALUES ($1, 'new_match', $2, 't')", [buyer.id, demand.id], "23514");
  await bad("INSERT INTO notifications (user_id, kind, demand_id, offer_id) VALUES ($1, 'new_match', $2, $3)", [buyer.id, demand.id, offer.id], "23514");
  await bad("INSERT INTO notifications (user_id, kind, demand_id, digest_day, item_count) VALUES ($1, 'new_matches_digest', $2, CURRENT_DATE, 0)", [buyer.id, demand.id], "23514");
  await bad("INSERT INTO notifications (user_id, kind, demand_id, offer_id, title, price_amount) VALUES ($1, 'new_match', $2, $3, 't', 5)", [buyer.id, demand.id, offer.id], "23514");
  await bad("INSERT INTO notifications (user_id, kind, demand_id, offer_id, title, read_at) VALUES ($1, 'new_match', $2, $3, 't', TIMESTAMPTZ '2000-01-01')", [buyer.id, demand.id, offer.id], "23514");
  await pool.query("INSERT INTO notifications (user_id, kind, demand_id, digest_day, item_count) VALUES ($1, 'new_matches_digest', $2, DATE '2032-01-01', 3)", [buyer.id, demand.id]);
  await bad("INSERT INTO notifications (user_id, kind, demand_id, digest_day, item_count) VALUES ($1, 'new_matches_digest', $2, DATE '2032-01-01', 4)", [buyer.id, demand.id], "23505");

  const failedDelivery = `INSERT INTO notification_deliveries (user_id, demand_id, offer_id, channel, status, attempts, next_attempt_at, idempotency_key, content)
     VALUES ($1, $2, $3, 'sms_sim', 'failed', 3, now(), $4, '{}'::jsonb)`;
  await bad("INSERT INTO notification_deliveries (user_id, demand_id, offer_id, channel, next_attempt_at, idempotency_key, content) VALUES ($1, $2, $3, 'email', now(), 'k', '{}'::jsonb)", [buyer.id, demand.id, offer.id], "23514");
  await bad("INSERT INTO notification_deliveries (user_id, demand_id, offer_id, channel, status, next_attempt_at, idempotency_key, content) VALUES ($1, $2, $3, 'sms_sim', 'lost', now(), 'k', '{}'::jsonb)", [buyer.id, demand.id, offer.id], "23514");
  await bad("INSERT INTO notification_deliveries (user_id, demand_id, offer_id, channel, attempts, next_attempt_at, idempotency_key, content) VALUES ($1, $2, $3, 'sms_sim', 4, now(), 'k', '{}'::jsonb)", [buyer.id, demand.id, offer.id], "23514");
  await bad("INSERT INTO notification_deliveries (user_id, demand_id, offer_id, channel, attempts, next_attempt_at, idempotency_key, content) VALUES ($1, $2, $3, 'sms_sim', 3, now(), 'k', '{}'::jsonb)", [buyer.id, demand.id, offer.id], "23514");
  await bad("INSERT INTO notification_deliveries (user_id, demand_id, offer_id, channel, status, attempts, next_attempt_at, idempotency_key, content) VALUES ($1, $2, $3, 'sms_sim', 'sent', 1, now(), 'k', '{}'::jsonb)", [buyer.id, demand.id, offer.id], "23514");
  await bad("INSERT INTO notification_deliveries (user_id, demand_id, offer_id, channel, status, next_attempt_at, idempotency_key, content) VALUES ($1, $2, $3, 'sms_sim', 'skipped', now(), 'k', '{}'::jsonb)", [buyer.id, demand.id, offer.id], "23514");
  await bad("INSERT INTO notification_deliveries (user_id, demand_id, offer_id, channel, next_attempt_at, idempotency_key, content) VALUES ($1, $2, $3, 'sms_sim', now(), 'k', '[]'::jsonb)", [buyer.id, demand.id, offer.id], "23514");
  await bad("INSERT INTO notification_deliveries (user_id, demand_id, offer_id, channel, next_attempt_at, idempotency_key, content, last_error) VALUES ($1, $2, $3, 'sms_sim', now(), 'k', '{}'::jsonb, 'Message brut avec espaces')", [buyer.id, demand.id, offer.id], "23514");
  await pool.query(failedDelivery, [buyer.id, demand.id, offer.id, "cle-unique"]);
  await bad(failedDelivery, [buyer.id, demand.id, offer.id, "cle-unique"], "23505");

  const indexes = (await pool.query<{ indexname: string }>("SELECT indexname FROM pg_indexes WHERE schemaname = current_schema() AND (tablename LIKE 'notification%' OR indexname = 'idx_matching_eval_pair_confirmed')")).rows.map((row) => row.indexname);
  for (const expected of [
    "uq_notifications_new_match", "uq_notifications_digest", "idx_notifications_user_created", "idx_notifications_user_unread", "idx_notifications_demand_created",
    "idx_notifications_read_at", "idx_notifications_created_at", "idx_notification_deliveries_due", "idx_notification_deliveries_user_pending",
    "idx_notification_deliveries_demand_pending", "idx_notification_deliveries_user_sent", "idx_notification_deliveries_created_at", "idx_matching_eval_pair_confirmed",
    "uq_notification_deliveries_idempotency", "idx_notification_deliveries_user_frozen",
  ]) assert.ok(indexes.includes(expected), `index ${expected}`);
  // Relancer les migrations n'applique rien.
  const rerun = await runMigrations(pool);
  assert.deepEqual(rerun.applied, []);
  assert.equal(rerun.skipped.length, 22);
  assert.equal(rerun.skipped.at(-1), "0022_offer_photos");
});

// ───────────── 9. lot N1-bis : seules les annonces NOUVELLES pour le besoin notifient ─────────────

const silentRows = async () => (await pool.query("SELECT * FROM notification_silent_evaluations ORDER BY created_at, evaluation_id")).rows;

test("besoin créé alors que 30 annonces correspondent : AUCUNE notification, aucun envoi ; budget relevé : toujours aucune ; nouvelle annonce ensuite : UNE ; annonce ancienne modifiée : UNE, première fois seulement", async () => {
  await resetAll();
  const { seller, buyer } = await people();
  await enableExternal(buyer.id);
  const offers: OfferRecord[] = [];
  for (let index = 0; index < 30; index += 1) offers.push(await createOffer(offerInput(seller.id, { rawText: `iPhone 13 en ligne n°${index}` }), pool));
  await drain();
  assert.equal(await count("matching_evaluations"), 0, "aucun besoin : rien n'est encore évalué");

  // 1. Le besoin est créé : 30 résultats sous les yeux de l'acheteur, ZÉRO notification et ZÉRO envoi.
  const demand = await createDemand(demandInput(buyer.id), pool);
  await drain();
  const confirmed = (await evaluationRows()).filter((row) => row.is_latest && row.is_confirmed_match && !row.is_stale);
  assert.equal(confirmed.length, 30, "le matching a bien évalué les 30 annonces (les résultats sont visibles)");
  assert.equal(await count("notifications"), 0, "créer un besoin ne notifie jamais");
  assert.equal(await count("notification_deliveries"), 0, "ni envoi externe");
  assert.equal((await silentRows()).length, 30, "les évaluations du besoin sont notées « sans notification possible »");

  // 2. Le budget est relevé : le besoin est réévalué, toujours rien.
  await updateDemand({ id: demand.id, ownerId: buyer.id, expectedContentVersion: demand.contentVersion, changes: { budget: { amount: 400_000, currency: "XOF" } } }, pool);
  await drain();
  assert.equal(await count("notifications"), 0, "relever un budget ne notifie jamais");
  assert.equal(await count("notification_deliveries"), 0);

  // 3. Une annonce publiée ENSUITE est nouvelle pour le besoin : UNE notification (et UNE ligne d'envoi).
  const fresh = await createOffer(offerInput(seller.id, { rawText: "iPhone 13 publié après" }), pool);
  await drain();
  let rows = await matchRows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].offer_id, fresh.id);
  assert.equal(await count("notification_deliveries"), 1);

  // 4. Une annonce ANCIENNE modifiée après l'activation du besoin devient une annonce nouvelle : UNE notification, la première fois seulement.
  const old = offers[7];
  await updateOffer({ id: old.id, ownerId: seller.id, expectedContentVersion: old.contentVersion, changes: { price: { amount: 240_000, currency: "XOF" } } }, pool);
  await drain();
  rows = await matchRows();
  assert.equal(rows.length, 2, "l'annonce ancienne modifiée notifie");
  assert.ok(rows.some((row) => row.offer_id === old.id));
  const current = (await pool.query<{ content_version: number }>("SELECT content_version FROM offers WHERE id = $1", [old.id])).rows[0].content_version;
  await updateOffer({ id: old.id, ownerId: seller.id, expectedContentVersion: current, changes: { price: { amount: 235_000, currency: "XOF" } } }, pool);
  await drain();
  assert.equal((await matchRows()).length, 2, "une seconde modification ne notifie plus : première fois seulement");

  // 5. Le besoin est modifié à nouveau : les annonces d'avant ne sont plus nouvelles ; rien de plus.
  const latest = (await pool.query<{ content_version: number }>("SELECT content_version FROM demands WHERE id = $1", [demand.id])).rows[0].content_version;
  await updateDemand({ id: demand.id, ownerId: buyer.id, expectedContentVersion: latest, changes: { budget: { amount: 500_000, currency: "XOF" } } }, pool);
  await drain();
  assert.equal((await matchRows()).length, 2);
  assert.equal(await count("notification_deliveries"), 2);
});

test("une annonce publiée en même temps qu'un besoin, avec le job du besoin passé AVANT celui de l'annonce : la notification de l'annonce n'est pas perdue", async () => {
  await resetAll();
  const { seller, buyer } = await people();
  const demand = await createDemand(demandInput(buyer.id), pool);
  const offer = await createOffer(offerInput(seller.id), pool);
  await projectOutboxBatch({ pool, limit: 100 });
  // Le job du besoin passe en premier : il évalue déjà la nouvelle annonce (silencieusement), puis celui de l'annonce.
  const jobs = (await pool.query<{ id: string; resource_id: string }>("SELECT id, resource_id FROM matching_jobs WHERE status = 'pending'")).rows;
  const demandJob = jobs.find((job) => job.resource_id === demand.id);
  const offerJob = jobs.find((job) => job.resource_id === offer.id);
  assert.ok(demandJob && offerJob, "un job de chaque côté");
  await pool.query("UPDATE matching_jobs SET scheduled_at = clock_timestamp() - interval '1 hour' WHERE id = $1", [demandJob.id]);
  await pool.query("UPDATE matching_jobs SET scheduled_at = clock_timestamp() WHERE id = $1", [offerJob.id]);
  const first = await runMatchingWorkerOnce({ pool, workerId: "n1bis-order-1", limit: 1 });
  assert.equal(first.length, 1);
  assert.equal((await matchRows()).length, 0, "le job du besoin ne notifie jamais");
  assert.equal((await silentRows()).length, 1);
  await runMatchingWorkerOnce({ pool, workerId: "n1bis-order-2", limit: 1 });
  const rows = await matchRows();
  assert.equal(rows.length, 1, "le job de l'annonce notifie : l'évaluation silencieuse du besoin ne compte pas comme « déjà une correspondance »");
  assert.equal(rows[0].offer_id, offer.id);
});

test("règle « annonce nouvelle pour le besoin » (appel direct, avec le type de job) : jobs du besoin, annonce antérieure, postérieure, sans événement, balayage de réactivation d'un vendeur", async () => {
  await resetAll();
  const seller = await makePerson(pool);
  const buyer = await makePerson(pool);
  const demand = await makeDemand(pool, buyer.id);
  await pool.query("DELETE FROM matching_outbox_events");
  const event = async (type: string, aggregate: "offer" | "demand" | "user", id: string, occurredAt: string): Promise<string> =>
    (await pool.query<{ id: string }>(
      `INSERT INTO matching_outbox_events (event_type, aggregate_type, aggregate_id, aggregate_version, occurred_at)
       VALUES ($1, $2, $3, (SELECT coalesce(max(aggregate_version), 0) + 1 FROM matching_outbox_events WHERE aggregate_type = $2 AND aggregate_id = $3), $4::timestamptz)
       RETURNING id`,
      [type, aggregate, id, occurredAt],
    )).rows[0].id;
  const fresh = async (offer: OfferRecord): Promise<string> => {
    await pool.query("DELETE FROM notifications"); // chaque cas est indépendant (notifications, évaluations du couple et leurs notes « sans notification »)
    await pool.query("DELETE FROM matching_evaluations WHERE offer_id = $1 AND demand_id = $2", [offer.id, demand.id]);
    return insertEvaluation(pool, { offer, demand });
  };
  const OFFER_JOB = { jobType: "evaluate_offer_candidates" };
  await event("demand.activated", "demand", demand.id, "2032-01-10T12:00:00Z");

  // Annonce publiée AVANT l'activation du besoin : jamais nouvelle.
  const before = await makeOffer(pool, seller.id, { price: 200_001 });
  await event("offer.published", "offer", before.id, "2032-01-10T11:59:59Z");
  assert.deepEqual(await directOutcome(before, demand, await fresh(before), OFFER_JOB), { kind: "not_new_for_demand" });
  assert.equal((await silentRows()).length, 1, "notée « sans notification possible »");
  // Annonce publiée APRÈS : nouvelle.
  const after = await makeOffer(pool, seller.id, { price: 200_002 });
  await event("offer.published", "offer", after.id, "2032-01-10T12:00:01Z");
  assert.equal((await directOutcome(after, demand, await fresh(after), OFFER_JOB)).kind, "created");
  // À l'instant exact de l'activation : pas postérieure.
  const same = await makeOffer(pool, seller.id, { price: 200_003 });
  await event("offer.created", "offer", same.id, "2032-01-10T12:00:00Z");
  assert.deepEqual(await directOutcome(same, demand, await fresh(same), OFFER_JOB), { kind: "not_new_for_demand" });
  // Aucun événement de publication connu (annonce d'avant le service) : pas nouvelle.
  const unknown = await makeOffer(pool, seller.id, { price: 200_004 });
  await pool.query("DELETE FROM matching_outbox_events WHERE aggregate_id = $1", [unknown.id]);
  assert.deepEqual(await directOutcome(unknown, demand, await fresh(unknown), OFFER_JOB), { kind: "not_new_for_demand" });
  // Dernière version publiée : une annonce ancienne modifiée après l'activation est nouvelle ; une annonce publiée avant, puis seulement mise en pause, ne l'est pas.
  const edited = await makeOffer(pool, seller.id, { price: 200_005 });
  await event("offer.published", "offer", edited.id, "2032-01-10T09:00:00Z");
  await event("offer.updated", "offer", edited.id, "2032-01-10T13:00:00Z");
  assert.equal((await directOutcome(edited, demand, await fresh(edited), OFFER_JOB)).kind, "created");
  const paused = await makeOffer(pool, seller.id, { price: 200_006 });
  await event("offer.published", "offer", paused.id, "2032-01-10T09:00:00Z");
  await event("offer.paused", "offer", paused.id, "2032-01-10T13:00:00Z");
  assert.deepEqual(await directOutcome(paused, demand, await fresh(paused), OFFER_JOB), { kind: "not_new_for_demand" }, "une mise en pause n'est pas une publication");

  // Job côté BESOIN : jamais, quelle que soit l'annonce ; événements du besoin (création, activation, modification) : jamais.
  assert.deepEqual(await directOutcome(after, demand, await fresh(after), { jobType: "evaluate_demand_candidates" }), { kind: "demand_side" });
  for (const type of ["demand.created", "demand.activated", "demand.updated"]) {
    const sourceEventId = await event(type, "demand", demand.id, "2032-01-10T14:00:00Z");
    assert.deepEqual(await directOutcome(after, demand, await fresh(after), { jobType: "evaluate_offer_candidates", sourceEventId }), { kind: "demand_side" }, type);
  }
  // Une modification du besoin repousse la référence : l'annonce publiée avant n'est plus nouvelle.
  await event("demand.updated", "demand", demand.id, "2032-01-10T12:30:00Z");
  assert.deepEqual(await directOutcome(after, demand, await fresh(after), OFFER_JOB), { kind: "not_new_for_demand" });
  await pool.query("DELETE FROM matching_outbox_events WHERE aggregate_type = 'demand' AND event_type <> 'demand.activated'");

  // Balayage de réactivation d'un VENDEUR : garde la règle de N1 (aucun contrôle de nouveauté), sauf côté besoin.
  const reactivation = await event("user.reactivated", "user", seller.id, "2032-01-10T15:00:00Z");
  assert.equal((await directOutcome(before, demand, await fresh(before), { jobType: "evaluate_offer_candidates", sourceEventId: reactivation })).kind, "created", "annonce ancienne, vendeur réactivé");
  assert.deepEqual(await directOutcome(before, demand, await fresh(before), { jobType: "evaluate_demand_candidates", sourceEventId: reactivation }), { kind: "demand_side" }, "acheteur réactivé : jamais");
  // Appel direct sans type de job (outils, essais) : la règle n'est pas appliquée.
  assert.equal((await directOutcome(before, demand, await fresh(before))).kind, "created");
});

test("balayage de réactivation d'un vendeur (VRAI worker) : ses annonces anciennes, déjà évaluées sans notification, notifient une fois", async () => {
  await resetAll();
  const { seller, buyer } = await people();
  await createOffer(offerInput(seller.id), pool);
  const demand = await createDemand(demandInput(buyer.id), pool);
  await drain();
  assert.equal(await count("notifications"), 0, "annonce publiée avant le besoin : aucune notification");
  assert.ok((await evaluationRows()).some((row) => row.is_confirmed_match));
  const suspended = await updateUser({ id: seller.id, expectedVersion: seller.version, status: "suspended" }, pool);
  await updateUser({ id: seller.id, expectedVersion: suspended.version, status: "active" }, pool);
  for (let round = 0; round < 8; round += 1) {
    const cycle = await runMatchingCycle({ pool, workerId: `n1bis-sweep-${round}`, notificationTransport: null });
    assert.deepEqual(cycle.errors, []);
    if (cycle.idle) break;
  }
  const rows = await matchRows();
  assert.equal(rows.length, 1, "le balayage de réactivation du vendeur garde la règle de N1 : une notification");
  assert.equal(rows[0].demand_id, demand.id);
});

// ───────────── 10. résumé relu, plafond par utilisateur ─────────────

test("un résumé déjà lu redevient NON LU quand une annonce de plus y est ajoutée (item_count augmente, read_at remis à NULL)", async () => {
  await resetAll();
  const seller = await makePerson(pool);
  const buyer = await makePerson(pool);
  const demand = await makeDemand(pool, buyer.id);
  const pairs: Array<{ offer: OfferRecord; evaluationId: string }> = [];
  for (let index = 0; index < 24; index += 1) {
    const offer = await makeOffer(pool, seller.id, { price: 210_000 + index });
    pairs.push({ offer, evaluationId: await insertEvaluation(pool, { offer, demand }) });
  }
  for (const pair of pairs.slice(0, 22)) await directOutcome(pair.offer, demand, pair.evaluationId);
  let [digest] = await digestRows();
  assert.equal(digest.item_count, 2);
  assert.equal(digest.read_at, null);
  await pool.query("UPDATE notifications SET read_at = clock_timestamp() WHERE id = $1", [digest.id]);
  assert.notEqual((await digestRows())[0].read_at, null, "le résumé est lu");
  const unreadBefore = (await pool.query("SELECT count(*)::int AS n FROM notifications WHERE read_at IS NULL")).rows[0].n;
  const outcome = await directOutcome(pairs[22].offer, demand, pairs[22].evaluationId);
  assert.deepEqual({ kind: outcome.kind, itemCount: outcome.kind === "digested" ? outcome.itemCount : -1 }, { kind: "digested", itemCount: 3 });
  [digest] = await digestRows();
  assert.equal(digest.item_count, 3);
  assert.equal(digest.read_at, null, "une annonce de plus : le résumé redevient non lu");
  const unreadAfter = (await pool.query("SELECT count(*)::int AS n FROM notifications WHERE read_at IS NULL")).rows[0].n;
  assert.equal(unreadAfter, unreadBefore + 1, "la pastille remonte");
  assert.equal((await digestRows()).length, 1, "toujours UN résumé par besoin et par jour");
  // Les annonces nominatives déjà lues, elles, ne sont pas touchées.
  await pool.query("UPDATE notifications SET read_at = clock_timestamp()");
  await directOutcome(pairs[23].offer, demand, pairs[23].evaluationId);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM notifications WHERE read_at IS NULL AND kind = 'new_match'")).rows[0].n, 0);
  assert.equal((await digestRows())[0].read_at, null);
});

test("plafond par UTILISATEUR : au plus 50 new_match par jour UTC, tous besoins confondus ; au-delà, les annonces vont dans le résumé de leur besoin", async () => {
  await resetAll();
  const seller = await makePerson(pool);
  const buyer = await makePerson(pool);
  const demands = [await makeDemand(pool, buyer.id), await makeDemand(pool, buyer.id), await makeDemand(pool, buyer.id)];
  const offers: OfferRecord[] = [];
  for (let index = 0; index < 20; index += 1) offers.push(await makeOffer(pool, seller.id, { price: 220_000 + index }));
  const outcomes: string[] = [];
  for (const demand of demands) {
    for (const offer of offers) outcomes.push((await directOutcome(offer, demand, await insertEvaluation(pool, { offer, demand }))).kind);
  }
  assert.equal(outcomes.filter((kind) => kind === "created").length, NEW_MATCH_DAILY_CAP_PER_USER, "50 notifications nominatives, pas 60");
  assert.equal(outcomes.filter((kind) => kind === "digested").length, 10);
  assert.equal((await matchRows()).length, NEW_MATCH_DAILY_CAP_PER_USER);
  const digests = await digestRows();
  assert.equal(digests.length, 1, "un résumé, celui du troisième besoin (les deux premiers n'ont pas atteint leur plafond de 20 ni dépassé celui de l'utilisateur)");
  assert.equal(digests[0].demand_id, demands[2].id);
  assert.equal(digests[0].item_count, 10);
  assert.equal((await pool.query("SELECT 1 FROM notifications WHERE demand_id = $1 AND kind = 'new_match'", [demands[2].id])).rowCount, 10);
  // Le plafond est par UTILISATEUR : un autre acheteur n'est pas touché.
  const other = await makePerson(pool);
  const otherDemand = await makeDemand(pool, other.id);
  assert.equal((await directOutcome(offers[0], otherDemand, await insertEvaluation(pool, { offer: offers[0], demand: otherDemand }))).kind, "created");
  // Le lendemain (jour UTC suivant) : le plafond repart de zéro.
  await pool.query("UPDATE notifications SET created_at = created_at - interval '1 day' WHERE kind = 'new_match' AND user_id = $1", [buyer.id]);
  await pool.query("UPDATE notifications SET created_at = created_at - interval '1 day', digest_day = digest_day - 1 WHERE kind = 'new_matches_digest'");
  const extra = await makeOffer(pool, seller.id, { price: 229_999 });
  assert.equal((await directOutcome(extra, demands[0], await insertEvaluation(pool, { offer: extra, demand: demands[0] }))).kind, "created");
});
