import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Pool, type PoolClient } from "pg";
import { satisfyDemand } from "../../lib/server/catalog";
import type { DemandRecord, OfferRecord } from "../../lib/server/catalog/types";
import { runMatchingCycle, runMatchingWorkerLoop } from "../../lib/server/matching/runner";
import {
  DELIVERY_MAX_AGE_MS, EXTERNAL_COLLECTION_WINDOW_MS, EXTERNAL_DAILY_CAP_PER_USER, EXTERNAL_MIN_INTERVAL_MS, NOTIFICATION_USER_LOCK_NAMESPACE, TRANSPORT_TIMEOUT_MS,
} from "../../lib/server/notifications/config";
import { recordNewMatchNotification } from "../../lib/server/notifications/creation";
import { cancelPendingDeliveriesForDemand, runNotificationStep, type NotifyHooks } from "../../lib/server/notifications/deliveries";
import type { NotificationMessage, NotificationTransport } from "../../lib/server/notifications/transport";
import { runMigrations } from "../../lib/server/postgres/migrations";
import { insertEvaluation, makeDemand, makeOffer, makePerson, type Person } from "./metrics-fixtures";
import {
  createTemporarySchemaName, openVerifiedIsolatedPool, openVerifiedTestDatabase, quoteTemporarySchema, type DedicatedTestDatabase,
} from "./test-database";

let admin: Pool, pool: Pool;
let target: DedicatedTestDatabase;
const schema = createTemporarySchemaName();
const quoted = quoteTemporarySchema(schema);
const wide = (config: ConstructorParameters<typeof Pool>[0]) => new Pool({ ...config, max: 8 });

before(async () => {
  const opened = await openVerifiedTestDatabase(process.env.TEST_DATABASE_URL);
  admin = opened.pool;
  target = opened.target;
  await admin.query(`CREATE SCHEMA ${quoted}`);
  pool = await openVerifiedIsolatedPool(target, schema, wide);
  assert.equal((await runMigrations(pool)).applied.length, 27);
});

after(async () => {
  if (pool) await pool.end();
  if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${quoted} CASCADE`); await admin.end(); }
});

const DAY = 86_400_000;
/** 12:00 UTC : hors des heures calmes. Les lignes de chaque essai sont recalées sur cette horloge (voir `align`). */
const NOW = new Date(Date.UTC(2032, 5, 15, 12, 0, 0));
const at = (hour: number, minute = 0, second = 0, base = NOW) => new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate(), hour, minute, second));

const resetAll = () => pool.query(
  "TRUNCATE notification_deliveries, notifications, notification_preferences, matching_evaluations, matching_jobs, matching_outbox_events, phone_identities, demands, offers, users CASCADE");

async function inTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/** Recale les envois EN ATTENTE et les suivis sur l'horloge de l'essai : créés il y a une heure, dus depuis une minute ; suivi valable 30 jours. */
async function align(clock: Date = NOW): Promise<void> {
  await pool.query(
    `UPDATE notification_deliveries SET created_at = $1::timestamptz - interval '1 hour', updated_at = $1::timestamptz - interval '1 hour',
            next_attempt_at = $1::timestamptz - interval '1 minute' WHERE status = 'pending' AND attempts = 0`,
    [clock],
  );
  await pool.query("UPDATE demands SET notify_until = $1::timestamptz + interval '30 days'", [clock]);
}

interface Scenario { seller: Person; buyer: Person; demand: DemandRecord; offers: OfferRecord[]; deliveryIds: string[] }

/** Un acheteur (envoi externe ACTIVÉ sauf `external: false`), un besoin, `offers` annonces et leurs correspondances fraîches : chaque notification naît par le VRAI chemin de création. */
async function scenario(options: { offers?: number; external?: boolean; buyer?: Person; seller?: Person; align?: boolean } = {}): Promise<Scenario> {
  const seller = options.seller ?? await makePerson(pool);
  const buyer = options.buyer ?? await makePerson(pool);
  if (options.external !== false) {
    await pool.query("INSERT INTO notification_preferences (user_id, external_enabled) VALUES ($1, TRUE) ON CONFLICT (user_id) DO UPDATE SET external_enabled = TRUE", [buyer.id]);
  }
  const demand = await makeDemand(pool, buyer.id);
  const offers: OfferRecord[] = [];
  const before = new Set((await pool.query<{ id: string }>("SELECT id FROM notification_deliveries")).rows.map((row) => row.id));
  for (let index = 0; index < (options.offers ?? 1); index += 1) {
    const offer = await makeOffer(pool, seller.id, { price: 200_000 + index + Math.floor(Math.random() * 1_000) });
    offers.push(offer);
    const evaluationId = await insertEvaluation(pool, { offer, demand });
    const outcome = await inTransaction((client) => recordNewMatchNotification(client, {
      evaluationId, offerId: offer.id, demandId: demand.id, offerOwnerId: offer.ownerId, demandOwnerId: demand.ownerId, isConfirmedMatch: true,
    }));
    assert.equal(outcome.kind, "created");
  }
  const deliveryIds = (await pool.query<{ id: string }>("SELECT id FROM notification_deliveries ORDER BY created_at, id")).rows.map((row) => row.id).filter((id) => !before.has(id));
  if (options.align !== false) await align();
  return { seller, buyer, demand, offers, deliveryIds };
}

interface Spy { transport: NotificationTransport; calls: NotificationMessage[] }
function spy(behavior: (call: number) => "ok" | "fail" = () => "ok"): Spy {
  const calls: NotificationMessage[] = [];
  return {
    calls,
    transport: {
      channel: "sms_sim",
      async send(message) {
        calls.push(message);
        if (behavior(calls.length) === "fail") throw new Error("panne du transport (secret)");
      },
    },
  };
}

const step = (transport: NotificationTransport | null | undefined, clock: Date = NOW, hooks?: NotifyHooks) =>
  runNotificationStep({ pool, transport, now: () => clock, hooks });
const deliveries = async () => (await pool.query("SELECT * FROM notification_deliveries ORDER BY created_at, id")).rows;
const byStatus = async () => {
  const counts: Record<string, number> = {};
  for (const row of await deliveries()) counts[row.status] = (counts[row.status] ?? 0) + 1;
  return counts;
};

// ───────────── regroupement, un message ─────────────

test("regroupement : les envois en attente d'un utilisateur partent en UN message (nombre d'annonces et lien /notifications seulement)", async () => {
  await resetAll();
  const { buyer, deliveryIds } = await scenario({ offers: 3 });
  const { transport, calls } = spy();
  const result = await step(transport);
  assert.equal(calls.length, 1, "un seul message");
  assert.deepEqual(Object.keys(calls[0]).sort(), ["count", "idempotencyKey", "link", "userId"]);
  assert.equal(calls[0].count, 3);
  assert.equal(calls[0].link, "/notifications");
  assert.equal(calls[0].userId, buyer.id);
  assert.match(calls[0].idempotencyKey, /^[0-9a-f]{32}$/);
  assert.deepEqual({ users: result.users, messages: result.messages, delivered: result.delivered }, { users: 1, messages: 1, delivered: 3 });
  const rows = await deliveries();
  assert.equal(rows.length, 3);
  for (const row of rows) {
    assert.equal(row.status, "sent");
    assert.equal(row.attempts, 1);
    assert.equal(row.batch_key, calls[0].idempotencyKey, "même clé de message pour tout le groupe");
    assert.equal(row.sent_at.getTime(), NOW.getTime());
    assert.equal(row.last_error, null);
  }
  assert.deepEqual(rows.map((row) => row.id).sort(), [...deliveryIds].sort());
  // Rejouer l'étape n'envoie rien de plus.
  const again = await step(transport);
  assert.equal(again.users, 0);
  assert.equal(calls.length, 1);
});

test("regroupement entre besoins : les envois de deux besoins d'un même acheteur partent dans UN message ; deux acheteurs, deux messages", async () => {
  await resetAll();
  const first = await scenario({ offers: 2 });
  await scenario({ offers: 1, buyer: first.buyer, seller: first.seller });
  const other = await scenario({ offers: 1 });
  const { transport, calls } = spy();
  const result = await step(transport);
  assert.equal(calls.length, 2);
  const byUser = new Map(calls.map((call) => [call.userId, call]));
  assert.equal(byUser.get(first.buyer.id)?.count, 3);
  assert.equal(byUser.get(other.buyer.id)?.count, 1);
  assert.notEqual(calls[0].idempotencyKey, calls[1].idempotencyKey);
  assert.deepEqual({ users: result.users, messages: result.messages, delivered: result.delivered }, { users: 2, messages: 2, delivered: 4 });
});

// ───────────── transport absent, verrou de production ─────────────

test("sans transport : aucun envoi externe, les envois restent en attente (puis expirent)", async () => {
  await resetAll();
  await scenario({ offers: 2 });
  for (const absent of [undefined, null]) {
    const result = await step(absent);
    assert.equal(result.noTransport, true);
    assert.equal(result.users, 0);
    assert.equal(result.messages, 0);
  }
  assert.deepEqual(await byStatus(), { pending: 2 });
});

test("verrou de production : le runner ne résout AUCUN transport hors NODE_ENV=development, même avec NOMA_DEV_NOTIFY_CONSOLE=1 ; en développement avec le drapeau, une ligne console fixe", async () => {
  await resetAll();
  const { buyer } = await scenario({ offers: 2 });
  const previous = { NODE_ENV: process.env.NODE_ENV, flag: process.env.NOMA_DEV_NOTIFY_CONSOLE };
  const lines: string[] = [];
  const warnings: string[] = [];
  const originalLog = console.log, originalWarn = console.warn;
  console.log = (...args: unknown[]) => { lines.push(args.join(" ")); };
  console.warn = (...args: unknown[]) => { warnings.push(args.join(" ")); };
  try {
    const environment = process.env as Record<string, string | undefined>;
    environment.NOMA_DEV_NOTIFY_CONSOLE = "1";
    for (const nodeEnv of ["production", "test"]) {
      environment.NODE_ENV = nodeEnv;
      const cycle = await runMatchingCycle({ pool, workerId: "n1-prod-lock", notificationNow: () => NOW });
      assert.equal(cycle.notify.noTransport, true, `NODE_ENV=${nodeEnv} : aucun transport`);
      assert.equal(cycle.notify.messages, 0);
      assert.deepEqual(cycle.errors, []);
    }
    assert.deepEqual(await byStatus(), { pending: 2 }, "rien n'est parti");
    assert.deepEqual(lines.filter((line) => line.startsWith("[notify:dev]")), []);
    environment.NODE_ENV = "development";
    const cycle = await runMatchingCycle({ pool, workerId: "n1-dev-console", notificationNow: () => NOW });
    assert.equal(cycle.notify.messages, 1);
    assert.deepEqual(cycle.errors, []);
    assert.equal(cycle.idle, false);
    const sent = lines.filter((line) => line.startsWith("[notify:dev]"));
    assert.deepEqual(sent, [`[notify:dev] envoi simulé à ${buyer.id.replace(/-/g, "").slice(0, 8)}… : 2 annonces, lien /notifications`]);
    assert.equal(sent[0].includes(buyer.id), false, "jamais l'identifiant entier");
    assert.equal(/\d{9,}/.test(sent[0]), false, "jamais de numéro");
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
    for (const [name, value] of [["NODE_ENV", previous.NODE_ENV], ["NOMA_DEV_NOTIFY_CONSOLE", previous.flag]] as const) {
      const environment = process.env as Record<string, string | undefined>;
      if (value === undefined) delete environment[name];
      else environment[name] = value;
    }
  }
  assert.ok(warnings.length <= 1, "au plus un avertissement fixe par processus");
});

// ───────────── revérification à l'envoi ─────────────

test("revérification : préférence retirée, compte inactif, besoin en pause ou expiré, annonce retirée ou plus correspondante → 'skipped' avec le motif ; rien n'est envoyé", async () => {
  const cases: Array<{ reason: string; arrange: (s: Scenario) => Promise<void> }> = [
    { reason: "preference_disabled", arrange: async (s) => { await pool.query("UPDATE notification_preferences SET external_enabled = FALSE WHERE user_id = $1", [s.buyer.id]); } },
    { reason: "user_inactive", arrange: async (s) => { await pool.query("UPDATE users SET status = 'suspended' WHERE id = $1", [s.buyer.id]); } },
    { reason: "demand_inactive", arrange: async (s) => { await pool.query("UPDATE demands SET status = 'draft' WHERE id = $1", [s.demand.id]); } },
    { reason: "tracking_paused", arrange: async (s) => { await pool.query("UPDATE demands SET notify_paused = TRUE WHERE id = $1", [s.demand.id]); } },
    { reason: "tracking_expired", arrange: async (s) => { await pool.query("UPDATE demands SET notify_until = created_at WHERE id = $1", [s.demand.id]); } },
    { reason: "offer_unavailable", arrange: async (s) => { await pool.query("UPDATE offers SET status = 'paused' WHERE id = $1", [s.offers[0].id]); } },
    { reason: "offer_unavailable", arrange: async (s) => { await pool.query("UPDATE offers SET availability_status = 'unavailable' WHERE id = $1", [s.offers[0].id]); } },
    { reason: "offer_unavailable", arrange: async (s) => { await pool.query("UPDATE offers SET status = 'archived', archived_at = clock_timestamp() WHERE id = $1", [s.offers[0].id]); } },
    {
      reason: "no_longer_matching",
      arrange: async (s) => { await pool.query("UPDATE matching_evaluations SET is_latest = FALSE, is_stale = TRUE, stale_reason = 'offer_updated', staled_at = clock_timestamp() WHERE offer_id = $1", [s.offers[0].id]); },
    },
    { reason: "no_longer_matching", arrange: async (s) => { await pool.query("UPDATE offers SET content_version = content_version + 1 WHERE id = $1", [s.offers[0].id]); } },
    { reason: "no_longer_matching", arrange: async (s) => { await pool.query("UPDATE matching_evaluations SET compatibility_status = 'incompatible' WHERE offer_id = $1", [s.offers[0].id]); } },
  ];
  for (const { reason, arrange } of cases) {
    await resetAll();
    const s = await scenario({ offers: 1 });
    await arrange(s);
    const { transport, calls } = spy();
    const result = await step(transport);
    assert.equal(calls.length, 0, `${reason} : rien n'est envoyé`);
    const [row] = await deliveries();
    assert.equal(row.status, "skipped", reason);
    assert.equal(row.reason, reason);
    assert.equal(row.attempts, 0);
    assert.equal(row.sent_at, null);
    assert.equal(result.skippedDeliveries, 1);
    assert.equal(result.messages, 0);
  }
});

test("revérification : parmi trois envois, celui dont l'annonce a été retirée est écarté ; les deux autres partent dans UN message de 2", async () => {
  await resetAll();
  const s = await scenario({ offers: 3 });
  await pool.query("UPDATE offers SET status = 'paused' WHERE id = $1", [s.offers[1].id]);
  const { transport, calls } = spy();
  const result = await step(transport);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].count, 2, "le message ne compte que les annonces encore valables");
  assert.deepEqual({ delivered: result.delivered, skipped: result.skippedDeliveries }, { delivered: 2, skipped: 1 });
  const rows = await deliveries();
  assert.equal(rows.filter((row) => row.status === "skipped" && row.reason === "offer_unavailable").length, 1);
  assert.equal(rows.filter((row) => row.status === "sent").length, 2);
});

test("besoin satisfait : les envois en attente sont ANNULÉS (même transaction que le changement de statut) et rien n'est envoyé", async () => {
  await resetAll();
  const s = await scenario({ offers: 2 });
  await satisfyDemand(s.buyer.id, s.demand.id, s.demand.contentVersion, pool);
  const { transport, calls } = spy();
  const result = await step(transport);
  assert.equal(calls.length, 0);
  assert.equal(result.users, 0, "rien à prendre : déjà annulés");
  const rows = await deliveries();
  assert.ok(rows.every((row) => row.status === "cancelled" && row.reason === "demand_satisfied"));
  assert.equal(await cancelPendingDeliveriesForDemand(pool, s.demand.id, "demand_archived"), 0, "idempotent : plus rien d'en attente");
});

// ───────────── heures calmes ─────────────

test("heures calmes 22 h – 7 h (horloge injectable) : rien n'est envoyé, l'envoi est REPORTÉ à 7 h ; à 7 h il part", async () => {
  for (const [hour, minute, expectedDay, label] of [[22, 0, 1, "22 h 00"], [23, 30, 1, "23 h 30"], [0, 0, 0, "minuit"], [3, 15, 0, "3 h 15"], [6, 59, 0, "6 h 59"]] as const) {
    await resetAll();
    await scenario({ offers: 2 });
    const quiet = at(hour, minute);
    await align(quiet);
    const { transport, calls } = spy();
    const result = await step(transport, quiet);
    assert.equal(calls.length, 0, `${label} : aucun envoi`);
    assert.equal(result.deferred, 2, label);
    assert.equal(result.messages, 0);
    const rows = await deliveries();
    const expected = at(7, 0, 0, new Date(quiet.getTime() + expectedDay * DAY));
    for (const row of rows) {
      assert.equal(row.status, "pending", label);
      assert.equal(row.attempts, 0, `${label} : un report n'est pas une tentative`);
      assert.equal(row.next_attempt_at.getTime(), expected.getTime(), `${label} : reporté à 7 h`);
    }
    // Avant 7 h : toujours rien (les lignes ne sont pas encore dues) ; à 7 h : l'envoi part.
    assert.equal((await step(transport, new Date(expected.getTime() - 1))).users, 0);
    assert.equal(calls.length, 0);
    const morning = await step(transport, expected);
    assert.equal(calls.length, 1, `${label} : à 7 h l'envoi part`);
    assert.equal(calls[0].count, 2);
    assert.equal(morning.delivered, 2);
  }
  // 21 h 59 : encore permis ; 7 h 00 : permis.
  await resetAll();
  await scenario({ offers: 1 });
  const evening = at(21, 59, 59);
  await align(evening);
  const { transport, calls } = spy();
  await step(transport, evening);
  assert.equal(calls.length, 1, "21 h 59 : hors heures calmes");
});

// ───────────── rythme : fenêtre de collecte, intervalle de 4 h, plafond de 3 messages par jour ─────────────

const HOUR = 3_600_000;
const sentMessages = async (): Promise<Array<{ batchKey: string; sentAt: Date; count: number }>> =>
  (await pool.query<{ batch_key: string; sent_at: Date; n: number }>(
    "SELECT batch_key, min(sent_at) AS sent_at, count(*)::int AS n FROM notification_deliveries WHERE status = 'sent' GROUP BY batch_key ORDER BY min(sent_at), batch_key",
  )).rows.map((row) => ({ batchKey: row.batch_key, sentAt: row.sent_at, count: row.n }));

/** Un acheteur (envoi externe activé), un besoin, une annonce correspondante, SANS aucune ligne d'envoi : les annonces « arrivent » ensuite (`arrive`), à l'heure voulue. */
async function stream(): Promise<Scenario> {
  const base = await scenario({ offers: 1, align: false });
  await pool.query("DELETE FROM notification_deliveries");
  await pool.query("UPDATE demands SET notify_until = $1::timestamptz + interval '30 days'", [NOW]);
  return base;
}

/** Fait arriver une annonce aux instants donnés : ligne d'envoi créée à cet instant, envoyable après la fenêtre de collecte (la formule de la création est testée à part). */
async function arrive(s: Scenario, times: readonly Date[]): Promise<void> {
  await pool.query(
    `INSERT INTO notification_deliveries (user_id, notification_id, demand_id, offer_id, channel, created_at, updated_at, next_attempt_at, idempotency_key, content)
     SELECT $1::uuid, NULL, $2::uuid, $3::uuid, 'sms_sim', t, t, t + ($5::bigint * interval '1 millisecond'), 'test:' || gen_random_uuid()::text,
            '{"title":"Annonce","price":null,"link":"/besoins/x/offres/y"}'::jsonb
       FROM unnest($4::timestamptz[]) AS t`,
    [s.buyer.id, s.demand.id, s.offers[0].id, [...times], EXTERNAL_COLLECTION_WINDOW_MS],
  );
}

/** Horloge simulée : une annonce toutes les `everyMs` jusqu'à `arrivalsUntil`, le worker passe toutes les `stepMs` de `from` à `until`. Renvoie le nombre d'annonces arrivées. */
async function simulate(s: Scenario, transport: NotificationTransport, window: { from: Date; until: Date; stepMs: number; everyMs: number; arrivalsUntil: Date }): Promise<number> {
  let next = window.from.getTime();
  let arrived = 0;
  for (let t = window.from.getTime(); t <= window.until.getTime(); t += window.stepMs) {
    const batch: Date[] = [];
    while (next <= t && next <= window.arrivalsUntil.getTime()) { batch.push(new Date(next)); next += window.everyMs; }
    if (batch.length > 0) { await arrive(s, batch); arrived += batch.length; }
    await step(transport, new Date(t));
  }
  return arrived;
}

/**
 * Instants d'ARRIVÉE de l'essai de la fenêtre de collecte (jour de `NOW`, UTC). Jamais l'heure réelle : un jeu FIXE qui couvre le jour, chaque bord des heures calmes
 * (22 h – 7 h) et le passage de minuit. L'horloge de l'essai est injectable : `NOMA_TEST_CLOCK` (« HH:MM » UTC le jour de `NOW`, ou un instant ISO complet) la remplace
 * par UN seul instant, pour prouver que l'essai est vrai à n'importe quelle heure (aucune dépendance à l'heure réelle).
 */
function collectionArrivals(): Date[] {
  const forced = process.env.NOMA_TEST_CLOCK?.trim();
  if (forced) {
    const hhmm = /^(\d{1,2}):(\d{2})$/.exec(forced);
    const instant = hhmm ? at(Number(hhmm[1]), Number(hhmm[2])) : new Date(forced);
    assert.ok(!Number.isNaN(instant.getTime()), `NOMA_TEST_CLOCK illisible : ${forced}`);
    return [instant];
  }
  return [at(0, 30), at(6, 44), at(6, 45), at(6, 59), at(7, 0), at(12, 0), at(21, 43), at(21, 44), at(21, 45), at(21, 46), at(23, 59)];
}

/** Heures calmes, calculées ici à part de la production (22 h inclus – 7 h exclu, UTC) : le jour et l'heure de fin attendus d'un instant calme. */
const isQuiet = (instant: Date): boolean => instant.getUTCHours() >= 22 || instant.getUTCHours() < 7;
const quietEnd = (instant: Date): Date => at(7, 0, 0, new Date(instant.getTime() + (instant.getUTCHours() >= 22 ? DAY : 0)));

test("création : une ligne d'envoi n'est envoyable qu'après la fenêtre de collecte de 15 minutes (next_attempt_at = created_at + 15 min exactement), à toute heure d'arrivée", async () => {
  for (const arrival of collectionArrivals()) {
    const label = arrival.toISOString().slice(0, 16);
    await resetAll();
    await scenario({ offers: 3, align: false });
    // 1. La formule, sur les lignes réellement créées (horloge de la base) : exacte, quelle que soit l'heure.
    const created = await deliveries();
    assert.equal(created.length, 3);
    for (const row of created) assert.equal(row.next_attempt_at.getTime() - row.created_at.getTime(), EXTERNAL_COLLECTION_WINDOW_MS, `${label} : created_at + 15 minutes`);
    // 2. Les lignes sont recalées sur l'instant d'arrivée de l'essai (une par seconde, la formule conservée) : le comportement de l'envoi ne dépend plus de l'heure réelle.
    await pool.query(
      `UPDATE notification_deliveries d SET created_at = x.t, updated_at = x.t, next_attempt_at = x.t + ($2::bigint * interval '1 millisecond')
         FROM (SELECT id, $1::timestamptz + ((row_number() OVER (ORDER BY created_at, id)) - 1) * interval '1 second' AS t FROM notification_deliveries) x WHERE d.id = x.id`,
      [arrival, EXTERNAL_COLLECTION_WINDOW_MS],
    );
    await pool.query("UPDATE demands SET notify_until = $1::timestamptz + interval '30 days'", [arrival]);
    const rows = await deliveries();
    for (const row of rows) assert.equal(row.next_attempt_at.getTime() - row.created_at.getTime(), EXTERNAL_COLLECTION_WINDOW_MS, `${label} : recalage fidèle`);
    const { transport, calls } = spy();
    const last = Math.max(...rows.map((row) => row.created_at.getTime()));
    const early = await step(transport, new Date(Math.min(...rows.map((row) => row.next_attempt_at.getTime())) - 1));
    assert.equal(early.users, 0, label);
    assert.equal(calls.length, 0, `${label} : avant la fin de la fenêtre de la première ligne : rien`);
    const windowEnd = new Date(last + EXTERNAL_COLLECTION_WINDOW_MS);
    const due = await step(transport, windowEnd);
    if (!isQuiet(windowEnd)) {
      assert.equal(due.messages, 1, `${label} : fin de fenêtre ${windowEnd.toISOString()} hors heures calmes : le message part`);
      assert.equal(calls[0].count, 3, `${label} : le message emporte TOUT ce qui est en attente`);
    } else {
      // La fenêtre se termine dans les heures calmes : rien ne part, l'envoi est reporté à 7 h (et part alors, en un seul message).
      const morning = quietEnd(windowEnd);
      assert.equal(due.messages, 0, `${label} : fin de fenêtre ${windowEnd.toISOString()} dans les heures calmes : rien ne part`);
      assert.equal(due.deferred, 3, label);
      assert.equal(calls.length, 0, label);
      for (const row of await deliveries()) assert.equal(row.next_attempt_at.getTime(), morning.getTime(), `${label} : reporté à 7 h`);
      assert.equal((await step(transport, new Date(morning.getTime() - 1))).users, 0, label);
      assert.equal((await step(transport, morning)).messages, 1, `${label} : à 7 h le message part`);
      assert.equal(calls[0].count, 3, label);
    }
    assert.equal(calls.length, 1, label);
    assert.deepEqual(await byStatus(), { sent: 3 }, label);
  }
});

test("rafale : 12 annonces en 1 seconde → UN message de 12, 15 minutes après la première (rien avant)", async () => {
  await resetAll();
  const s = await stream();
  const T0 = at(8);
  await arrive(s, Array.from({ length: 12 }, (_, index) => new Date(T0.getTime() + index * 80)));
  const { transport, calls } = spy();
  for (const offset of [0, 1_000, 60_000, 10 * 60_000, EXTERNAL_COLLECTION_WINDOW_MS - 1]) {
    const early = await step(transport, new Date(T0.getTime() + offset));
    assert.equal(early.users, 0, `à +${offset} ms la fenêtre n'est pas close`);
  }
  assert.equal(calls.length, 0);
  const result = await step(transport, new Date(T0.getTime() + EXTERNAL_COLLECTION_WINDOW_MS));
  assert.equal(result.messages, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].count, 12, "la rafale entière dans UN message");
  assert.deepEqual(await byStatus(), { sent: 12 });
  assert.equal((await step(transport, new Date(T0.getTime() + HOUR))).users, 0);
  assert.equal(calls.length, 1);
});

test("flux d'une annonce toutes les 7 s pendant 1 h : au plus 1 message par 4 h, rien d'écarté, le compte de chaque message est exact", async () => {
  await resetAll();
  const s = await stream();
  const T0 = at(8);
  const { transport, calls } = spy();
  const arrived = await simulate(s, transport, { from: T0, until: new Date(T0.getTime() + 6 * HOUR), stepMs: 60_000, everyMs: 7_000, arrivalsUntil: new Date(T0.getTime() + HOUR) });
  assert.ok(arrived >= 514, `${arrived} annonces`);
  const messages = await sentMessages();
  assert.equal(messages.length, 2, "un message à 15 min, un autre 4 h plus tard : pas un par cycle");
  assert.equal(messages[0].sentAt.getTime(), T0.getTime() + EXTERNAL_COLLECTION_WINDOW_MS, "le premier message part à la fin de la fenêtre de collecte");
  assert.equal(messages[1].sentAt.getTime() - messages[0].sentAt.getTime(), EXTERNAL_MIN_INTERVAL_MS, "le second part dès que 4 h se sont écoulées");
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((call) => call.count), messages.map((message) => message.count), "le compte du message est le nombre de lignes marquées");
  assert.equal(calls[0].count + calls[1].count, arrived, "COMPTE EXACT : toutes les annonces, aucune perdue ni écartée");
  assert.deepEqual(await byStatus(), { sent: arrived });
  assert.equal((await pool.query("SELECT 1 FROM notification_deliveries WHERE reason IS NOT NULL")).rowCount, 0, "rien n'est écarté, pas même pour cause de plafond");
});

test("plafond de 3 messages par jour UTC : le 4e est REPORTÉ au lendemain (jamais écarté), rien n'est perdu", async () => {
  await resetAll();
  const s = await stream();
  const day1 = at(7);
  const { transport, calls } = spy();
  const arrived = await simulate(s, transport, {
    from: day1, until: new Date(day1.getTime() + 25 * HOUR), stepMs: 5 * 60_000, everyMs: 30 * 60_000, arrivalsUntil: new Date(day1.getTime() + 16.5 * HOUR),
  });
  const messages = await sentMessages();
  const perDay = new Map<string, number>();
  for (const message of messages) perDay.set(message.sentAt.toISOString().slice(0, 10), (perDay.get(message.sentAt.toISOString().slice(0, 10)) ?? 0) + 1);
  assert.ok([...perDay.values()].every((n) => n <= EXTERNAL_DAILY_CAP_PER_USER), `au plus ${EXTERNAL_DAILY_CAP_PER_USER} messages par jour : ${JSON.stringify([...perDay])}`);
  assert.deepEqual(messages.map((message) => message.sentAt.toISOString().slice(11, 16)), ["07:15", "11:15", "15:15", "07:00"], "trois messages le jour, le quatrième à 7 h le lendemain (jamais la nuit)");
  assert.equal(messages[3].sentAt.getUTCDate(), day1.getUTCDate() + 1);
  assert.equal(calls.reduce((sum, call) => sum + call.count, 0), arrived, "toutes les annonces sont parties : le plafond reporte, il n'écarte pas");
  assert.deepEqual(await byStatus(), { sent: arrived });
  assert.equal((await pool.query("SELECT 1 FROM notification_deliveries WHERE reason = 'daily_cap'")).rowCount, 0);
});

test("report par-delà les heures calmes : un envoi retenu par l'intervalle de 4 h jusqu'à 23 h part à 7 h le lendemain (jamais dans la nuit)", async () => {
  await resetAll();
  const s = await stream();
  const { transport, calls } = spy();
  await arrive(s, [at(18, 50)]);
  const first = await step(transport, at(19, 5));
  assert.equal(first.messages, 1, "premier message à 19 h 05");
  await arrive(s, [at(19, 30)]);
  const held = await step(transport, at(19, 45));
  assert.equal(held.messages, 0);
  assert.equal(held.deferred, 1, "retenu par l'intervalle de 4 h (23 h 05)");
  const [pending] = (await deliveries()).filter((row) => row.status === "pending");
  assert.equal(pending.next_attempt_at.getTime(), at(7, 0, 0, new Date(at(0).getTime() + DAY)).getTime(), "23 h 05 tombe dans les heures calmes : reporté à 7 h, pas à 23 h 05");
  assert.equal((await step(transport, at(23, 5))).users, 0, "rien à 23 h 05");
  assert.equal((await step(transport, new Date(at(6, 59, 59).getTime() + DAY))).users, 0);
  assert.equal(calls.length, 1);
  const morning = await step(transport, new Date(at(7, 0).getTime() + DAY));
  assert.equal(morning.messages, 1);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].count, 1);
});

test("rythme : le message du plafond compte pour UN (un lot de 4 annonces), et l'intervalle de 4 h sépare toujours deux messages", async () => {
  await resetAll();
  const s = await scenario({ offers: 4 });
  const { transport, calls } = spy();
  await step(transport, NOW);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].count, 4);
  await scenario({ offers: 1, buyer: s.buyer, seller: s.seller });
  const tooSoon = await step(transport, new Date(NOW.getTime() + EXTERNAL_MIN_INTERVAL_MS - 1));
  assert.equal(tooSoon.messages, 0);
  assert.equal(tooSoon.deferred, 1, "reporté, pas écarté");
  assert.equal(calls.length, 1);
  const ok = await step(transport, new Date(NOW.getTime() + EXTERNAL_MIN_INTERVAL_MS));
  assert.equal(ok.messages, 1);
  assert.equal(calls[1].count, 1);
});

test("un résumé a ses annonces dans le message : le compte inclut TOUTES les annonces, celles au-delà du plafond de 20 comprises", async () => {
  await resetAll();
  const seller = await makePerson(pool);
  const buyer = await makePerson(pool);
  await pool.query("INSERT INTO notification_preferences (user_id, external_enabled) VALUES ($1, TRUE)", [buyer.id]);
  const demand = await makeDemand(pool, buyer.id);
  const kinds: string[] = [];
  for (let index = 0; index < 23; index += 1) {
    const offer = await makeOffer(pool, seller.id, { price: 300_000 + index });
    const evaluationId = await insertEvaluation(pool, { offer, demand });
    const outcome = await inTransaction((client) => recordNewMatchNotification(client, {
      evaluationId, offerId: offer.id, demandId: demand.id, offerOwnerId: offer.ownerId, demandOwnerId: demand.ownerId, isConfirmedMatch: true,
    }));
    kinds.push(outcome.kind);
    assert.equal(outcome.kind === "created" || outcome.kind === "digested" ? outcome.deliveryCreated : false, true, `l'annonce ${index + 1} a sa ligne d'envoi`);
  }
  assert.equal(kinds.filter((kind) => kind === "created").length, 20);
  assert.equal(kinds.filter((kind) => kind === "digested").length, 3);
  await align();
  const { transport, calls } = spy();
  await step(transport);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].count, 23, "20 annonces + 3 du résumé");
});

// ───────────── lot figé : nouvelle tentative = même lot, même clé ─────────────

test("lot figé : une nouvelle tentative envoie le MÊME lot avec la MÊME clé, même si d'autres lignes sont arrivées entre-temps (elles iront dans le message suivant)", async () => {
  await resetAll();
  const first = await scenario({ offers: 2 });
  const { transport, calls } = spy((call) => (call === 1 ? "fail" : "ok"));
  await step(transport, NOW);
  let rows = await deliveries();
  const key = rows[0].batch_key;
  assert.match(key, /^[0-9a-f]{32}$/, "la clé est posée AVANT l'envoi et conservée après l'échec");
  assert.ok(rows.every((row) => row.batch_key === key && row.status === "pending" && row.attempts === 1));
  // Une annonce arrive entre-temps.
  await scenario({ offers: 1, buyer: first.buyer, seller: first.seller });
  assert.equal((await step(transport, new Date(NOW.getTime() + 4 * 60_000))).users, 0, "le lot figé attend SA prochaine tentative : les lignes plus récentes ne le font pas partir plus tôt");
  const retry = await step(transport, new Date(NOW.getTime() + 5 * 60_000));
  assert.equal(retry.messages, 1);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].idempotencyKey, calls[0].idempotencyKey, "même clé d'idempotence");
  assert.equal(calls[1].idempotencyKey, key);
  assert.equal(calls[1].count, 2, "même composition : la ligne arrivée entre-temps n'y est pas");
  rows = await deliveries();
  assert.equal(rows.filter((row) => row.status === "sent" && row.batch_key === key).length, 2);
  const late = rows.filter((row) => row.status === "pending");
  assert.equal(late.length, 1);
  assert.equal(late[0].batch_key, null, "la ligne arrivée entre-temps n'appartient à aucun lot");
  // Elle part dans le message SUIVANT, 4 h après.
  await step(transport, new Date(NOW.getTime() + 5 * 60_000 + 1_000));
  assert.equal(calls.length, 2, "retenue par l'intervalle de 4 h");
  const next = await step(transport, new Date(NOW.getTime() + 5 * 60_000 + EXTERNAL_MIN_INTERVAL_MS));
  assert.equal(next.messages, 1);
  assert.equal(calls[2].count, 1);
  assert.notEqual(calls[2].idempotencyKey, key);
});

test("lot figé : un second processus muni d'une liste d'utilisateurs PÉRIMÉE ne relance pas le lot avant son échéance (le contrôle d'échéance est refait sous le verrou, sur le lot figé)", async () => {
  await resetAll();
  const first = await scenario({ offers: 2 });
  const { transport, calls } = spy((call) => (call === 1 ? "fail" : "ok"));
  let nested: Awaited<ReturnType<typeof step>> | null = null;
  // Le processus B a lu sa liste d'utilisateurs ; avant qu'il la traite, le processus A envoie (échec : lot figé, prochaine tentative dans 5 minutes) et une annonce arrive.
  const staleStep = await step(transport, NOW, {
    afterDue: async () => {
      nested = await step(transport, NOW);
      await scenario({ offers: 1, buyer: first.buyer, seller: first.seller });
    },
  });
  assert.ok(nested, "le processus A est passé");
  assert.equal((nested as Awaited<ReturnType<typeof step>>).retried, 2, "A : un envoi, échoué, le lot est figé");
  assert.equal(calls.length, 1, "B ne renvoie PAS : le lot figé attend son échéance, malgré la ligne plus récente déjà due");
  assert.equal(staleStep.messages, 0);
  assert.ok((await deliveries()).filter((row) => row.attempts === 1).length === 2, "une seule tentative pour le lot figé");
});

test("lot figé : une panne juste après le figeage garde la composition et la clé (le message suivant est le même lot, avec la même clé)", async () => {
  await resetAll();
  const first = await scenario({ offers: 3 });
  const { transport, calls } = spy();
  let frozenKey = "";
  const died = await step(transport, NOW, { afterFreeze: (_userId, batchKey) => { frozenKey = batchKey; throw new Error("mort simulée après le figeage"); } });
  assert.equal(calls.length, 0, "rien n'est parti");
  assert.deepEqual(died.errors, ["user_unknown"]);
  const rows = await deliveries();
  assert.ok(rows.every((row) => row.batch_key === frozenKey && row.status === "pending"), "le lot est durable (validé avant l'envoi)");
  await scenario({ offers: 2, buyer: first.buyer, seller: first.seller });
  const resumed = await step(transport, new Date(NOW.getTime() + 5 * 60_000));
  assert.equal(resumed.messages, 1);
  assert.equal(calls[0].idempotencyKey, frozenKey);
  assert.equal(calls[0].count, 3, "les deux lignes arrivées après le figeage restent pour le message suivant");
  assert.equal((await deliveries()).filter((row) => row.status === "pending").length, 2);
});

// ───────────── tentatives, attente croissante, échec ─────────────

test("au plus 3 tentatives avec attente croissante (5 min puis 30 min), puis 'failed' ; jamais de message brut conservé", async () => {
  await resetAll();
  await scenario({ offers: 2 });
  const { transport, calls } = spy(() => "fail");
  const first = await step(transport, NOW);
  assert.equal(calls.length, 1);
  assert.deepEqual({ retried: first.retried, failed: first.failed, messages: first.messages }, { retried: 2, failed: 0, messages: 0 });
  let rows = await deliveries();
  for (const row of rows) {
    assert.equal(row.status, "pending");
    assert.equal(row.attempts, 1);
    assert.equal(row.last_error, "transport_error");
    assert.equal(row.next_attempt_at.getTime(), NOW.getTime() + 5 * 60_000, "première attente : 5 minutes");
    assert.equal(row.sent_at, null);
    assert.match(row.batch_key, /^[0-9a-f]{32}$/, "le lot reste figé entre les tentatives");
  }
  // Avant l'échéance : aucune nouvelle tentative.
  await step(transport, new Date(NOW.getTime() + 4 * 60_000));
  assert.equal(calls.length, 1);
  const second = await step(transport, new Date(NOW.getTime() + 5 * 60_000));
  assert.equal(calls.length, 2);
  assert.equal(second.retried, 2);
  rows = await deliveries();
  for (const row of rows) {
    assert.equal(row.attempts, 2);
    assert.equal(row.next_attempt_at.getTime(), NOW.getTime() + 5 * 60_000 + 30 * 60_000, "seconde attente : 30 minutes, plus longue que la première");
  }
  const third = await step(transport, new Date(NOW.getTime() + 35 * 60_000));
  assert.equal(calls.length, 3);
  assert.deepEqual({ failed: third.failed, retried: third.retried }, { failed: 2, retried: 0 });
  rows = await deliveries();
  for (const row of rows) {
    assert.equal(row.status, "failed");
    assert.equal(row.attempts, 3);
    assert.equal(row.last_error, "transport_error");
    assert.equal(JSON.stringify(row).includes("secret"), false, "le message de l'exception n'est jamais conservé");
  }
  // Terminal : plus aucune tentative, jamais.
  await step(transport, new Date(NOW.getTime() + 3 * DAY / 24));
  assert.equal(calls.length, 3);
});

test("un transport qui échoue puis réussit : l'envoi part à la deuxième tentative (attempts = 2)", async () => {
  await resetAll();
  await scenario({ offers: 1 });
  const { transport, calls } = spy((call) => (call === 1 ? "fail" : "ok"));
  await step(transport, NOW);
  await step(transport, new Date(NOW.getTime() + 5 * 60_000));
  assert.equal(calls.length, 2);
  const [row] = await deliveries();
  assert.equal(row.status, "sent");
  assert.equal(row.attempts, 2);
  assert.equal(row.last_error, null);
  assert.equal(row.sent_at.getTime(), NOW.getTime() + 5 * 60_000);
});

test("un transport qui ne répond pas est coupé au bout du délai fixé (code transport_timeout)", async () => {
  await resetAll();
  await scenario({ offers: 1 });
  const hanging: NotificationTransport = { channel: "sms_sim", send: () => new Promise<void>(() => {}) };
  const started = Date.now();
  const result = await step(hanging);
  assert.ok(Date.now() - started >= TRANSPORT_TIMEOUT_MS - 200 && Date.now() - started < TRANSPORT_TIMEOUT_MS + 3_000);
  assert.equal(result.retried, 1);
  const [row] = await deliveries();
  assert.equal(row.last_error, "transport_timeout");
  assert.equal(row.attempts, 1);
});

// ───────────── concurrence et reprise après panne ─────────────

test("deux workers concurrents : UN seul envoi (verrou de l'utilisateur) ; le second laisse l'utilisateur au premier", async () => {
  await resetAll();
  await scenario({ offers: 3 });
  const { transport, calls } = spy();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let entered!: () => void;
  const inside = new Promise<void>((resolve) => { entered = resolve; });
  const first = step(transport, NOW, { afterLock: async () => { entered(); await gate; } });
  try {
    await inside;
    const second = await step(transport, NOW);
    assert.equal(second.busy, 1, "le second worker voit l'utilisateur pris");
    assert.equal(second.messages, 0);
    assert.equal(calls.length, 0, "rien n'est parti pendant que le premier tient l'utilisateur");
  } finally {
    // Même si une assertion échoue, le premier worker est relâché : jamais de transaction laissée ouverte (le pool ne pourrait plus se fermer).
    release();
  }
  const done = await first;
  assert.equal(done.messages, 1);
  assert.equal(calls.length, 1, "UN seul envoi au total");
  assert.equal(calls[0].count, 3);
  assert.deepEqual(await byStatus(), { sent: 3 });
});

test("verrou consultatif de l'utilisateur : tenu par une autre session, l'utilisateur est laissé (aucun envoi, aucune ligne touchée)", async () => {
  await resetAll();
  const s = await scenario({ offers: 2 });
  const holder = await pool.connect();
  try {
    await holder.query("BEGIN");
    await holder.query("SELECT pg_advisory_xact_lock($1, hashtext($2))", [NOTIFICATION_USER_LOCK_NAMESPACE, s.buyer.id]);
    const { transport, calls } = spy();
    const result = await step(transport);
    assert.equal(result.busy, 1);
    assert.equal(calls.length, 0);
    assert.deepEqual(await byStatus(), { pending: 2 });
  } finally {
    await holder.query("ROLLBACK");
    holder.release();
  }
});

test("SKIP LOCKED : une ligne tenue par une autre transaction est laissée SANS attente ; le reste part ; elle part au passage suivant", async () => {
  await resetAll();
  const s = await scenario({ offers: 3 });
  const locker = await pool.connect();
  try {
    await locker.query("BEGIN");
    await locker.query("SELECT id FROM notification_deliveries WHERE id = $1 FOR UPDATE", [s.deliveryIds[1]]);
    const { transport, calls } = spy();
    const started = Date.now();
    const result = await step(transport);
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 2_000, `aucune attente de la ligne tenue (${elapsed} ms ; sans SKIP LOCKED l'étape attendrait le délai de verrou de 3 s)`);
    assert.deepEqual(result.errors, []);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].count, 2, "les deux lignes libres partent ensemble");
    const rows = await pool.query<{ id: string; status: string }>("SELECT id, status FROM notification_deliveries ORDER BY id");
    assert.equal(rows.rows.find((row) => row.id === s.deliveryIds[1])?.status, "pending", "la ligne tenue est intacte");
    await locker.query("ROLLBACK");
    const later = await step(transport);
    assert.equal(later.messages, 0, "un message vient de partir : la ligne libérée est retenue par l'intervalle de 4 h (reportée, pas écartée)");
    assert.equal(later.deferred, 1);
    const afterInterval = await step(transport, new Date(NOW.getTime() + EXTERNAL_MIN_INTERVAL_MS));
    assert.equal(afterInterval.messages, 1);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].count, 1);
    assert.deepEqual(await byStatus(), { sent: 3 });
  } finally {
    await locker.query("ROLLBACK").catch(() => {});
    locker.release();
  }
});

test("une ligne annulée pendant la prise (besoin satisfait) n'est jamais envoyée : la transaction qui annule attend, puis l'envoi est déjà parti", async () => {
  await resetAll();
  const s = await scenario({ offers: 2 });
  const { transport, calls } = spy();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let entered!: () => void;
  const inside = new Promise<void>((resolve) => { entered = resolve; });
  // Le crochet tient la transaction d'ENVOI (lignes prises en FOR UPDATE, juste avant l'appel au transport) : l'annulation attend, l'envoi part, puis le besoin est satisfait.
  const running = step(transport, NOW, { beforeSend: async () => { entered(); await gate; } });
  let satisfying: Promise<unknown> = Promise.resolve();
  try {
    // Si l'étape se termine sans jamais atteindre l'envoi, l'essai échoue au lieu d'attendre indéfiniment.
    const reached = await Promise.race([inside.then(() => "atteint"), running.then(() => "terminée")]);
    assert.equal(reached, "atteint", "l'étape doit atteindre l'envoi");
    satisfying = satisfyDemand(s.buyer.id, s.demand.id, s.demand.contentVersion, pool);
    await new Promise((resolve) => setTimeout(resolve, 300));
  } finally {
    release();
  }
  await Promise.all([running, satisfying]);
  assert.equal(calls.length, 1, "l'envoi tenait les lignes : il part, puis le besoin est satisfait");
  assert.deepEqual(await byStatus(), { sent: 2 }, "les lignes déjà envoyées ne sont pas réécrites par l'annulation");
});

test("erreur AVANT l'envoi (le crochet lève après la prise) : rien n'est parti, les lignes comptent UNE tentative (attente de 5 min), la reprise envoie UNE fois", async () => {
  await resetAll();
  await scenario({ offers: 2 });
  const { transport, calls } = spy();
  const failed = await step(transport, NOW, { afterLock: () => { throw Object.assign(new Error("mort simulée"), { code: "57P01" }); } });
  assert.deepEqual(failed.errors, ["user_57p01"], "code stable, jamais le message");
  assert.equal(calls.length, 0);
  assert.deepEqual(await byStatus(), { pending: 2 });
  const rows = await deliveries();
  assert.ok(rows.every((row) => row.attempts === 1 && row.last_error === "user_57p01" && row.next_attempt_at.getTime() === NOW.getTime() + 5 * 60_000), "une tentative de plus, attente de 5 minutes");
  assert.equal((await step(transport, new Date(NOW.getTime() + 4 * 60_000))).users, 0, "l'utilisateur en erreur n'est pas relu avant son échéance");
  const resumed = await step(transport, new Date(NOW.getTime() + 5 * 60_000));
  assert.equal(resumed.messages, 1);
  assert.equal(calls.length, 1);
  assert.deepEqual(await byStatus(), { sent: 2 });
});

test("erreur APRÈS l'envoi, avant le COMMIT : les lignes restent en attente et le message est renvoyé avec la MÊME clé d'idempotence (au moins une fois, dédoublonnable)", async () => {
  await resetAll();
  await scenario({ offers: 2 });
  const { transport, calls } = spy();
  const died = await step(transport, NOW, { afterSend: () => { throw new Error("mort simulée après l'envoi"); } });
  assert.equal(calls.length, 1);
  assert.deepEqual(died.errors, ["user_unknown"]);
  assert.deepEqual(await byStatus(), { pending: 2 }, "rien n'est marqué : la transaction est annulée");
  const resumed = await step(transport, new Date(NOW.getTime() + 5 * 60_000));
  assert.equal(calls.length, 2);
  assert.equal(calls[1].idempotencyKey, calls[0].idempotencyKey, "même clé : un fournisseur peut dédoublonner");
  assert.equal(calls[1].count, calls[0].count);
  assert.deepEqual(await byStatus(), { sent: 2 });
  assert.equal(resumed.messages, 1);
});

test("erreur de l'étape pour un utilisateur : tentatives incrémentées, attente croissante (5 min puis 30 min), 'failed' après 3 ; un autre utilisateur est servi ; une ligne de journal par erreur", async () => {
  await resetAll();
  const a = await scenario({ offers: 2 });
  const b = await scenario({ offers: 1 });
  const { transport, calls } = spy();
  const hook: NotifyHooks = { afterLock: (userId) => { if (userId === a.buyer.id) throw Object.assign(new Error("panne déterministe (secret)"), { code: "XX000" }); } };
  const first = await step(transport, NOW, hook);
  assert.deepEqual(first.errors, ["user_xx000"]);
  assert.equal(first.messages, 1, "l'autre utilisateur est servi");
  assert.equal(calls[0].userId, b.buyer.id);
  const rowsOf = async () => (await deliveries()).filter((row) => row.user_id === a.buyer.id);
  let rows = await rowsOf();
  assert.ok(rows.every((row) => row.status === "pending" && row.attempts === 1 && row.last_error === "user_xx000" && row.next_attempt_at.getTime() === NOW.getTime() + 5 * 60_000));
  const second = await step(transport, new Date(NOW.getTime() + 5 * 60_000), hook);
  assert.deepEqual(second.errors, ["user_xx000"], "UNE erreur par tentative");
  rows = await rowsOf();
  assert.ok(rows.every((row) => row.attempts === 2 && row.next_attempt_at.getTime() === NOW.getTime() + 5 * 60_000 + 30 * 60_000), "seconde attente : 30 minutes");
  assert.deepEqual((await step(transport, new Date(NOW.getTime() + 20 * 60_000), hook)).errors, [], "pas de nouvelle tentative avant l'échéance : aucune erreur, aucune ligne de journal");
  const third = await step(transport, new Date(NOW.getTime() + 35 * 60_000), hook);
  assert.deepEqual(third.errors, ["user_xx000"]);
  rows = await rowsOf();
  assert.ok(rows.every((row) => row.status === "failed" && row.attempts === 3 && row.last_error === "user_xx000"), "failed après 3 tentatives");
  assert.deepEqual((await step(transport, new Date(NOW.getTime() + 3 * DAY / 24), hook)).errors, [], "terminal : plus jamais relu");
  assert.equal(JSON.stringify(rows).includes("secret"), false);
});

// ───────────── expiration ─────────────

test("un envoi en attente depuis plus de 48 h sort du canal externe : 'skipped' (expired), avec ou sans transport ; la notification reste dans l'application", async () => {
  await resetAll();
  await scenario({ offers: 3 });
  const rows = await deliveries();
  await pool.query("UPDATE notification_deliveries SET created_at = $2::timestamptz, next_attempt_at = $3::timestamptz WHERE id = $1", [rows[0].id, new Date(NOW.getTime() - DELIVERY_MAX_AGE_MS - HOUR), new Date(NOW.getTime() + HOUR)]);
  await pool.query("UPDATE notification_deliveries SET created_at = $2::timestamptz, next_attempt_at = $3::timestamptz WHERE id = $1", [rows[1].id, new Date(NOW.getTime() - DELIVERY_MAX_AGE_MS + HOUR), new Date(NOW.getTime() + HOUR)]);
  const none = await step(null);
  assert.equal(none.expired, 1, "l'expiration ne dépend pas du transport");
  assert.equal(none.noTransport, true);
  const after = await deliveries();
  assert.equal(after.find((row) => row.id === rows[0].id)?.status, "skipped");
  assert.equal(after.find((row) => row.id === rows[0].id)?.reason, "expired");
  assert.equal(after.find((row) => row.id === rows[1].id)?.status, "pending", "47 h : pas encore expiré (48 h, pas 24 h)");
  assert.equal((await pool.query("SELECT 1 FROM notifications WHERE read_at IS NULL")).rowCount, 3, "les trois notifications restent dans l'application, non lues");
  const { transport, calls } = spy();
  await step(transport);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].count, 2, "l'envoi expiré n'est pas compté");
});

// ───────────── runner : étape isolée ─────────────

test("runner : l'étape notify rapporte ses compteurs, un utilisateur en échec n'empêche pas les autres (code stable), idle reste vrai sans rien à faire", async () => {
  await resetAll();
  const idle = await runMatchingCycle({ pool, workerId: "n1-runner-idle", notificationTransport: null, notificationNow: () => NOW });
  assert.equal(idle.idle, true);
  assert.equal(idle.notify.skipped, false);
  assert.equal(idle.notify.noTransport, true);
  assert.deepEqual(idle.errors, []);

  const a = await scenario({ offers: 2 });
  const b = await scenario({ offers: 1 });
  const { transport, calls } = spy();
  let failedOnce = false;
  const cycle = await runMatchingCycle({
    pool, workerId: "n1-runner-notify", notificationTransport: transport, notificationNow: () => NOW,
    notificationHooks: { afterLock: (userId) => { if (!failedOnce && userId === a.buyer.id) { failedOnce = true; throw Object.assign(new Error("secret"), { code: "40001" }); } } },
  });
  assert.deepEqual(cycle.errors, ["notify_error_user_40001"], "cloisonné : un code stable, jamais le message");
  assert.equal(calls.length, 1, "l'autre utilisateur est servi");
  assert.equal(calls[0].userId, b.buyer.id);
  assert.equal(cycle.notify.messages, 1);
  assert.equal(cycle.idle, false, "l'autre utilisateur a été servi : le cycle a travaillé");
  const retryAt = new Date(NOW.getTime() + 5 * 60_000);
  const second = await runMatchingCycle({ pool, workerId: "n1-runner-notify", notificationTransport: transport, notificationNow: () => retryAt });
  assert.equal(second.notify.messages, 1, "l'utilisateur en erreur est relu à son échéance (5 minutes)");
  assert.equal(calls.length, 2);
  assert.deepEqual(second.errors, []);
  const third = await runMatchingCycle({ pool, workerId: "n1-runner-notify", notificationTransport: transport, notificationNow: () => retryAt });
  assert.equal(third.idle, true, "plus rien à envoyer");
});

test("une erreur de l'étape notify compte comme « au repos » : l'utilisateur en erreur seul ne rend pas le cycle actif (sinon le worker tournerait sans pause)", async () => {
  await resetAll();
  const a = await scenario({ offers: 1 });
  const { transport } = spy();
  // Les événements des fixtures sont projetés et leurs jobs exécutés par les premiers cycles : on attend le repos AVANT de provoquer la panne.
  for (let drain = 0; drain < 6; drain += 1) {
    if ((await runMatchingCycle({ pool, workerId: "n1-runner-drain", notificationTransport: null })).idle) break;
  }
  const cycle = await runMatchingCycle({
    pool, workerId: "n1-runner-rest", notificationTransport: transport, notificationNow: () => NOW,
    notificationHooks: { afterLock: () => { throw Object.assign(new Error("panne"), { code: "XX000" }); } },
  });
  assert.deepEqual(cycle.errors, ["notify_error_user_xx000"]);
  assert.equal(cycle.notify.users, 1);
  assert.equal(cycle.idle, true, "un échec permanent d'un utilisateur ne doit pas empêcher la boucle de se reposer");
  assert.equal((await deliveries()).filter((row) => row.user_id === a.buyer.id).every((row) => row.attempts === 1), true);
});

test("boucle du worker : une panne déterministe d'un utilisateur ne fait pas tourner la boucle sans pause (cycles bornés par l'intervalle normal), ses lignes finissent 'failed', les autres sont servis", async () => {
  await resetAll();
  const a = await scenario({ offers: 2 });
  const b = await scenario({ offers: 1 });
  const { transport, calls } = spy();
  let clock = NOW.getTime();
  const controller = new AbortController();
  const logs: string[] = [];
  let sleeps = 0, cycles = 0, hookCalls = 0;
  const idleDelays: number[] = [];
  await runMatchingWorkerLoop({
    pool, workerId: "n1-loop-rest", signal: controller.signal, idleDelayMs: 1_000, maxIdleDelayMs: 4_000,
    notification: {
      notificationTransport: transport, notificationNow: () => new Date(clock),
      notificationHooks: { afterLock: (userId) => { if (userId === a.buyer.id) { hookCalls += 1; throw Object.assign(new Error("panne"), { code: "XX000" }); } } },
    },
    log: (line) => { logs.push(line); },
    onCycle: () => { cycles += 1; if (cycles > 60) controller.abort(); },
    sleep: async (ms) => { sleeps += 1; idleDelays.push(ms); clock += 10 * 60_000; if (sleeps >= 6) controller.abort(); },
  });
  assert.ok(cycles <= 12, `cycles bornés par l'intervalle normal du worker (${cycles})`);
  assert.ok(sleeps >= 6, "la boucle se repose entre les cycles : elle ne tourne pas sans pause");
  assert.equal(hookCalls, 3, "trois tentatives, pas une par cycle");
  assert.equal(logs.filter((line) => line.includes("notify_error_user_xx000")).length, 3, "une ligne de journal par erreur et par tentative, pas par cycle");
  assert.deepEqual(idleDelays.slice(0, 3), [1_000, 2_000, 4_000], "attente doublée jusqu'au maximum");
  // Les lignes du scénario seulement : le VRAI worker de la boucle évalue aussi les annonces de l'autre vendeur pour le besoin de A (annonces nouvelles : lignes supplémentaires, légitimes).
  const rowsA = (await deliveries()).filter((row) => a.deliveryIds.includes(row.id));
  assert.ok(rowsA.length === 2 && rowsA.every((row) => row.status === "failed" && row.attempts === 3), `les lignes de l'utilisateur en panne finissent 'failed' : ${JSON.stringify(rowsA.map((row) => [row.status, row.attempts, row.last_error, row.reason]))} (cycles ${cycles}, attentes ${sleeps}, appels du crochet ${hookCalls})`);
  assert.equal(calls.filter((call) => call.userId === b.buyer.id).length, 1, "les autres utilisateurs sont servis");
  assert.equal((await deliveries()).filter((row) => b.deliveryIds.includes(row.id)).every((row) => row.status === "sent"), true);
});

test("boucle du worker : même quand l'écriture de la tentative échoue aussi (déclencheur qui refuse toute mise à jour), la boucle se repose entre les cycles", async () => {
  await resetAll();
  const a = await scenario({ offers: 1 });
  const { transport } = spy();
  await pool.query(`CREATE OR REPLACE FUNCTION n1bis_poison() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'poison' USING ERRCODE = 'P0001'; END $$`);
  await pool.query(`CREATE TRIGGER trg_n1bis_poison BEFORE UPDATE ON notification_deliveries FOR EACH ROW WHEN (OLD.user_id = '${a.buyer.id}'::uuid) EXECUTE FUNCTION n1bis_poison()`);
  try {
    const controller = new AbortController();
    const logs: string[] = [];
    let sleeps = 0, cycles = 0;
    await runMatchingWorkerLoop({
      pool, workerId: "n1-loop-poison", signal: controller.signal, idleDelayMs: 1_000, maxIdleDelayMs: 4_000,
      notification: { notificationTransport: transport, notificationNow: () => NOW },
      log: (line) => { logs.push(line); },
      onCycle: () => { cycles += 1; if (cycles > 60) controller.abort(); },
      sleep: async () => { sleeps += 1; if (sleeps >= 5) controller.abort(); },
    });
    assert.ok(cycles <= 8, `la boucle se repose : ${cycles} cycles pour 5 attentes, jamais une rafale`);
    assert.ok(sleeps >= 5);
    assert.equal(logs.length, cycles, "une ligne de journal par cycle en erreur, au rythme de l'attente normale");
    assert.ok(logs.every((line) => line.includes("notify_error_user_p0001")));
  } finally {
    await pool.query("DROP TRIGGER IF EXISTS trg_n1bis_poison ON notification_deliveries");
    await pool.query("DROP FUNCTION IF EXISTS n1bis_poison()");
  }
});

test("étape ignorée sans erreur quand la migration 0019 n'est pas appliquée (base de 18 migrations)", async () => {
  const oldSchema = createTemporarySchemaName();
  const oldQuoted = quoteTemporarySchema(oldSchema);
  await admin.query(`CREATE SCHEMA ${oldQuoted}`);
  const old = await openVerifiedIsolatedPool(target, oldSchema);
  try {
    const directory = join(process.cwd(), "database", "migrations");
    const files = readdirSync(directory).filter((name) => /^\d{4}_.*\.sql$/.test(name) && name < "0019_").sort();
    assert.equal(files.length, 18, "les 18 migrations d'avant le lot N1 (antérieures à la 0019 : la 0020 en dépend)");
    assert.equal(readdirSync(directory).filter((name) => name.startsWith("0019_")).length, 1);
    await old.query("CREATE TABLE noma_schema_migrations (version TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP)");
    for (const name of files) {
      await old.query(readFileSync(join(directory, name), "utf8"));
      await old.query("INSERT INTO noma_schema_migrations (version, checksum) VALUES ($1, 'x')", [name.slice(0, -4)]);
    }
    const cycle = await runMatchingCycle({ pool: old, workerId: "n1-old-schema", notificationTransport: spy().transport });
    assert.equal(cycle.notify.skipped, true);
    assert.equal(cycle.notify.users, 0);
    assert.deepEqual(cycle.errors, []);
    assert.equal(cycle.idle, true);
    // Le changement d'un besoin ne casse pas non plus sans la table (annulation sans effet).
    assert.equal(await cancelPendingDeliveriesForDemand(old, "00000000-0000-4000-8000-000000000000", "demand_archived"), 0);
  } finally {
    await old.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${oldQuoted} CASCADE`);
  }
});
