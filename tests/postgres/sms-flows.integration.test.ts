import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, beforeEach, describe, test } from "node:test";
import type { Pool, PoolClient } from "pg";
import { createAuthHttpHandlers, defaultAuthHttpDependencies, type AuthHttpHandlers } from "../../lib/server/auth/http";
import type { DemandRecord, OfferRecord } from "../../lib/server/catalog/types";
import { EXTERNAL_NOTICE, EXTERNAL_NOTICE_REAL } from "../../lib/server/notifications/config";
import { recordNewMatchNotification } from "../../lib/server/notifications/creation";
import { runNotificationStep } from "../../lib/server/notifications/deliveries";
import { createNotificationsHttpHandlers } from "../../lib/server/notifications/http";
import type { NotificationTransport } from "../../lib/server/notifications/transport";
import { analyzeSms } from "../../lib/server/sms/gsm7";
import { createMenoClient } from "../../lib/server/sms/meno";
import { createMenoNotificationTransport } from "../../lib/server/sms/notification-transport";
import { createMenoOtpTransport } from "../../lib/server/sms/otp-transport";
import { createSmsSender, type SmsSender } from "../../lib/server/sms/sender";
import { createNotificationResolverWithMeno, createOtpTransportResolver } from "../../lib/server/sms/transports";
import { startFakeMeno, type FakeMeno } from "../server/fake-meno";
import { insertEvaluation, makeDemand, makeOffer, makePerson, type Person } from "./metrics-fixtures";
import { ORIGIN, login, openTestSchema, reply, request, type TestSchema } from "./social-fixtures";

const KEY = "fake_meno_key_for_tests_only_0001";
const AUTH_SECRET = randomBytes(32);
const PROXY_SECRET = "proxy-auth-test-secret-32-bytes-minimum";
const PUBLIC_URL = "https://noma.example.ci";

let env: TestSchema;
let pool: Pool;
let fake: FakeMeno;
let clock = new Date();
const waits: number[] = [];
let phoneSequence = 0;

before(async () => {
  env = await openTestSchema();
  pool = env.pool;
  fake = await startFakeMeno({ apiKey: KEY });
});
after(async () => {
  await fake.close();
  await env.close();
});
beforeEach(async () => {
  fake.reset();
  waits.length = 0;
  clock = new Date();
  await pool.query("TRUNCATE sms_sends, otp_challenges, otp_rate_limit_counters");
});

function makeSender(options: { attemptTimeoutMs?: number; dailyCap?: number } = {}): SmsSender {
  return createSmsSender({
    client: createMenoClient({ apiKey: KEY, baseUrl: fake.baseUrl, attemptTimeoutMs: options.attemptTimeoutMs ?? 300, sleep: async (ms) => void waits.push(ms) }),
    pool: () => pool,
    phoneSecret: () => AUTH_SECRET,
    dailyCap: options.dailyCap ?? 1_000,
    log: () => {},
  });
}

const MENO_ENV = { NODE_ENV: "test", NOMA_SMS_PROVIDER: "meno", NOMA_SMS_API_KEY: KEY };
const uniquePhone = () => `+22507${String(Date.now() % 1_000_000).padStart(6, "0")}${String((phoneSequence += 1)).padStart(2, "0")}`.slice(0, 14);

function otpPost(path: string, body: unknown, ip = "198.51.100.40"): Request {
  return new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { origin: ORIGIN, "content-type": "application/json", "x-noma-proxy-secret": PROXY_SECRET, "x-forwarded-for": ip },
    body: JSON.stringify(body),
  });
}

function otpHandlers(resolveSendOtp: (env: Record<string, string | undefined>) => ReturnType<typeof createMenoOtpTransport> | undefined, extraEnv: Record<string, string | undefined> = {}): AuthHttpHandlers {
  return createAuthHttpHandlers({
    pool,
    now: () => clock,
    authSecret: AUTH_SECRET,
    env: { NOMA_AUTH_ORIGIN: ORIGIN, NOMA_AUTH_PROXY_SECRET: PROXY_SECRET, ...MENO_ENV, NOMA_SMS_BASE_URL: fake.baseUrl, ...extraEnv },
    resolveSendOtp,
  });
}

const challengeStatus = async (challengeId: string) => (await pool.query("SELECT status FROM otp_challenges WHERE id = $1", [challengeId])).rows[0]?.status as string | undefined;
const codeFrom = (content: string) => /votre code est ([0-9]{6})\./.exec(content)?.[1] ?? assert.fail("aucun code dans le SMS");

describe("code de connexion (OTP) par SMS réel : faux serveur Meno", () => {
  test("succès : un SMS GSM-7 d'un seul segment, le code qu'il porte ouvre la session, journal sans texte ni numéro", async () => {
    const sender = makeSender();
    const handlers = otpHandlers(createOtpTransportResolver(() => undefined, { resolveSender: () => sender, warn: () => {} }));
    const phone = uniquePhone();
    const requested = await handlers.requestOtp(otpPost("/api/auth/otp/request", { phone }));
    assert.equal(requested.status, 202);
    const { challengeId } = (await requested.json()) as { challengeId: string };
    assert.equal(fake.messages.length, 1);
    const [message] = fake.messages;
    assert.equal(message.to, phone);
    assert.match(message.content, /^noma : votre code est [0-9]{6}\. Il expire dans 5 min\. Ne le partagez pas\.$/);
    assert.equal(analyzeSms(message.content).encoding, "gsm7");
    assert.equal(analyzeSms(message.content).singleSegment, true);
    assert.equal(message.key, `otp-${challengeId}`, "clé d'idempotence = otp-<identifiant du défi>");
    const row = (await pool.query("SELECT * FROM sms_sends")).rows[0];
    assert.deepEqual({ purpose: row.purpose, reference: row.reference, key: row.idempotency_key, status: row.status, http: row.http_status }, { purpose: "otp", reference: challengeId, key: `otp-${challengeId}`, status: "accepted", http: 202 });
    assert.equal(JSON.stringify(row).includes(codeFrom(message.content)), false, "le code n'est pas dans le journal");
    assert.equal(JSON.stringify(row).includes(phone), false);
    const verified = await handlers.verifyOtp(otpPost("/api/auth/otp/verify", { challengeId, code: codeFrom(message.content) }));
    assert.equal(verified.status, 200);
    assert.match(verified.headers.get("set-cookie") ?? "", /^noma_auth=[A-Za-z0-9_-]{43}/);
  });

  test("TOUTES les limites d'envoi d'OTP restent : délai de 60 s et 3 demandes par 15 min, sans SMS pour les demandes refusées", async () => {
    const sender = makeSender();
    const handlers = otpHandlers(createOtpTransportResolver(() => undefined, { resolveSender: () => sender, warn: () => {} }));
    const phone = uniquePhone();
    // Horloge fixée au début d'une fenêtre de 15 minutes (les compteurs sont à fenêtre fixe).
    clock = new Date(Date.UTC(2032, 5, 15, 10, 0, 1));
    const post = () => handlers.requestOtp(otpPost("/api/auth/otp/request", { phone }));
    assert.equal((await post()).status, 202);
    clock = new Date(clock.getTime() + 30_000);
    const tooSoon = await post();
    assert.equal(tooSoon.status, 429, "moins de 60 s");
    assert.equal(fake.messages.length, 1, "aucun SMS pour une demande refusée");
    clock = new Date(clock.getTime() + 31_000);
    assert.equal((await post()).status, 202);
    clock = new Date(clock.getTime() + 61_000);
    assert.equal((await post()).status, 202);
    clock = new Date(clock.getTime() + 61_000);
    const fourth = await post();
    assert.equal(fourth.status, 429, "au plus 3 demandes par 15 minutes pour un numéro");
    assert.equal(fake.messages.length, 3, "trois SMS, pas un de plus");
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM sms_sends")).rows[0].n, 3);
  });

  test("limite par adresse IP conservée (SMS1-ter : 60 défis non vérifiés par 15 min glissantes) : le SMS n'est jamais envoyé au-delà", async () => {
    const sender = makeSender({ dailyCap: 5_000 }); // plafond large : on isole ici la limite par adresse (le lissage horaire des numéros inconnus est de 38 par heure au plafond par défaut)
    const handlers = otpHandlers(createOtpTransportResolver(() => undefined, { resolveSender: () => sender, warn: () => {} }));
    let accepted = 0;
    let limited = 0;
    clock = new Date(Date.UTC(2032, 5, 15, 10, 0, 1));
    for (let index = 0; index < 62; index += 1) {
      const response = await handlers.requestOtp(otpPost("/api/auth/otp/request", { phone: `+2250799${String(100_000 + index)}`.slice(0, 14) }, "198.51.100.99"));
      if (response.status === 202) accepted += 1;
      else if (response.status === 429) limited += 1;
    }
    assert.deepEqual({ accepted, limited }, { accepted: 60, limited: 2 });
    assert.equal(fake.messages.length, 60);
  });

  test("échec DÉFINITIF (422, 401, 502, 409) : réponse générique « Envoi du code impossible pour le moment », sans détail, défi en send_failed", async () => {
    for (const status of [422, 401, 502, 409]) {
      fake.reset();
      await pool.query("TRUNCATE otp_challenges, otp_rate_limit_counters, sms_sends");
      const handlers = otpHandlers(createOtpTransportResolver(() => undefined, { resolveSender: () => makeSender(), warn: () => {} }));
      fake.queue({ kind: "status", status, body: { error: "détail du fournisseur", id: "msg_secret" } });
      const phone = uniquePhone();
      const answer = await handlers.requestOtp(otpPost("/api/auth/otp/request", { phone }));
      const text = await answer.text();
      assert.equal(answer.status, 503, String(status));
      assert.deepEqual(JSON.parse(text), { error: { code: "otp_delivery_failed", message: "Envoi du code impossible pour le moment." } });
      for (const leak of ["détail", "msg_secret", String(status), phone, KEY, "fournisseur", "Meno"]) assert.equal(text.includes(leak), false, leak);
      const challenge = (await pool.query("SELECT status FROM otp_challenges")).rows[0];
      assert.equal(challenge.status, "send_failed");
      assert.equal((await pool.query("SELECT status FROM sms_sends")).rows[0].status, "rejected");
      assert.equal(fake.sendRequests().length, 1, "jamais de reprise sur un échec définitif");
    }
  });

  test("provider inactif ou clé absente : aucun transport, 503 générique, aucun défi créé, aucun appel réseau", async () => {
    for (const change of [{ NOMA_SMS_API_KEY: undefined }, { NOMA_SMS_API_KEY: "court" }, { NOMA_SMS_API_KEY: "" }]) {
      const warnings: string[] = [];
      const handlers = otpHandlers(createOtpTransportResolver(() => undefined, { warn: (line) => warnings.push(line) }), change);
      const answer = await handlers.requestOtp(otpPost("/api/auth/otp/request", { phone: uniquePhone() }));
      assert.equal(answer.status, 503, JSON.stringify(change));
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM otp_challenges")).rows[0].n, 0);
      assert.equal(fake.requests.length, 0);
      assert.ok(warnings.length <= 1);
    }
  });

  test("NODE_ENV=test avec la base officielle : le transport meno n'existe pas, aucun appel réseau possible même avec une clé", async () => {
    const handlers = otpHandlers(createOtpTransportResolver(() => undefined, { warn: () => {} }), { NOMA_SMS_BASE_URL: undefined });
    const answer = await handlers.requestOtp(otpPost("/api/auth/otp/request", { phone: uniquePhone() }));
    assert.equal(answer.status, 503);
    assert.equal(fake.requests.length, 0);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM sms_sends")).rows[0].n, 0);
  });

  test("résultat INCERTAIN (503) : le défi reste valable, aucun SMS renvoyé automatiquement, journal incertain", async () => {
    const handlers = otpHandlers(createOtpTransportResolver(() => undefined, { resolveSender: () => makeSender(), warn: () => {} }));
    fake.queue({ kind: "status", status: 503, body: { id: "msg_unsure_77", status: "unknown" } });
    const phone = uniquePhone();
    const answer = await handlers.requestOtp(otpPost("/api/auth/otp/request", { phone }));
    assert.equal(answer.status, 202, "le défi est annoncé : le code est peut-être arrivé");
    const { challengeId } = (await answer.json()) as { challengeId: string };
    assert.equal(await challengeStatus(challengeId), "sent", "défi valable");
    const row = (await pool.query("SELECT status, provider_id, http_status FROM sms_sends")).rows[0];
    assert.deepEqual({ status: row.status, providerId: row.provider_id, http: row.http_status }, { status: "uncertain", providerId: "msg_unsure_77", http: 503 });
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(fake.sendRequests().length, 1, "aucun renvoi automatique");
    assert.deepEqual(waits, []);
  });

  test("statut « unknown » : le défi reste valable et le code éventuellement reçu fonctionne", async () => {
    const handlers = otpHandlers(createOtpTransportResolver(() => undefined, { resolveSender: () => makeSender(), warn: () => {} }));
    fake.queue({ kind: "reply-status", reportedStatus: "unknown" });
    const answer = await handlers.requestOtp(otpPost("/api/auth/otp/request", { phone: uniquePhone() }));
    assert.equal(answer.status, 202);
    const { challengeId } = (await answer.json()) as { challengeId: string };
    assert.equal((await pool.query("SELECT status FROM sms_sends")).rows[0].status, "uncertain");
    const verified = await handlers.verifyOtp(otpPost("/api/auth/otp/verify", { challengeId, code: codeFrom(fake.messages[0].content) }));
    assert.equal(verified.status, 200, "le défi incertain est vérifiable");
  });

  test("silence du fournisseur (délai dépassé) : incertain, défi valable, la requête rend la main rapidement", async () => {
    const sender = makeSender({ attemptTimeoutMs: 100 });
    const handlers = otpHandlers(() => createMenoOtpTransport(sender, { deadlineMs: 400 }));
    fake.queue({ kind: "hang" }, { kind: "hang" }, { kind: "hang" }, { kind: "hang" });
    const started = Date.now();
    const answer = await handlers.requestOtp(otpPost("/api/auth/otp/request", { phone: uniquePhone() }));
    assert.ok(Date.now() - started < 3_000, "le délai réseau borne l'attente");
    assert.equal(answer.status, 202);
    const { challengeId } = (await answer.json()) as { challengeId: string };
    assert.equal(await challengeStatus(challengeId), "sent");
    assert.equal((await pool.query("SELECT status FROM sms_sends")).rows[0].status, "uncertain");
  });

  test("coupure puis reprise : même clé, un seul SMS, le code fonctionne", async () => {
    const handlers = otpHandlers(createOtpTransportResolver(() => undefined, { resolveSender: () => makeSender(), warn: () => {} }));
    fake.queue({ kind: "drop" });
    const answer = await handlers.requestOtp(otpPost("/api/auth/otp/request", { phone: uniquePhone() }));
    assert.equal(answer.status, 202);
    const { challengeId } = (await answer.json()) as { challengeId: string };
    assert.equal(fake.messages.length, 1);
    assert.deepEqual([...new Set(fake.sendRequests().map((r) => r.headers["idempotency-key"]))], [`otp-${challengeId}`]);
    assert.equal((await handlers.verifyOtp(otpPost("/api/auth/otp/verify", { challengeId, code: codeFrom(fake.messages[0].content) }))).status, 200);
  });

  test("câblage par défaut : meno configuré installe le transport réel (délai propre), le transport de développement reste celui d'avant", () => {
    const resolve = defaultAuthHttpDependencies.resolveSendOtp;
    assert.ok(resolve);
    const real = resolve({ ...MENO_ENV, NOMA_SMS_BASE_URL: fake.baseUrl });
    assert.ok(real);
    assert.ok((real.timeoutMs ?? 0) > 10_000);
    assert.equal(resolve({ ...MENO_ENV, NOMA_SMS_BASE_URL: fake.baseUrl, NOMA_SMS_API_KEY: undefined }), undefined, "meno sans clé : aucun transport");
    assert.equal(resolve({}), undefined);
    const dev = resolve({ NODE_ENV: "development", NOMA_DEV_OTP_CONSOLE: "1" });
    assert.ok(dev);
    assert.equal(dev.timeoutMs, undefined, "le transport console est inchangé");
    assert.equal(resolve({ NODE_ENV: "production", NOMA_DEV_OTP_CONSOLE: "1" }), undefined, "console toujours refusée hors développement");
  });
});

// ───────────── notifications ─────────────

const NOW = new Date(Date.UTC(2032, 5, 15, 12, 0, 0));
const at = (hour: number, minute = 0, base = NOW) => new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate(), hour, minute, 0));

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

async function align(clock: Date): Promise<void> {
  await pool.query(
    `UPDATE notification_deliveries SET created_at = $1::timestamptz - interval '1 hour', updated_at = $1::timestamptz - interval '1 hour',
            next_attempt_at = $1::timestamptz - interval '1 minute' WHERE status = 'pending' AND attempts = 0`,
    [clock],
  );
  await pool.query("UPDATE demands SET notify_until = $1::timestamptz + interval '30 days'", [clock]);
}

async function scenario(options: { offers?: number; buyer?: Person; seller?: Person; at?: Date } = {}): Promise<{ buyer: Person; seller: Person; demand: DemandRecord; offers: OfferRecord[] }> {
  const seller = options.seller ?? (await makePerson(pool));
  const buyer = options.buyer ?? (await makePerson(pool));
  await pool.query("INSERT INTO notification_preferences (user_id, external_enabled) VALUES ($1, TRUE) ON CONFLICT (user_id) DO UPDATE SET external_enabled = TRUE", [buyer.id]);
  const demand = await makeDemand(pool, buyer.id);
  const offers: OfferRecord[] = [];
  for (let index = 0; index < (options.offers ?? 1); index += 1) {
    const offer = await makeOffer(pool, seller.id, { price: 200_000 + index + Math.floor(Math.random() * 1_000) });
    offers.push(offer);
    const evaluationId = await insertEvaluation(pool, { offer, demand });
    const outcome = await inTransaction((client) => recordNewMatchNotification(client, {
      evaluationId, offerId: offer.id, demandId: demand.id, offerOwnerId: offer.ownerId, demandOwnerId: demand.ownerId, isConfirmedMatch: true,
    }));
    assert.equal(outcome.kind, "created");
  }
  await align(options.at ?? NOW);
  return { buyer, seller, demand, offers };
}

const menoTransport = (sender = makeSender()) => createMenoNotificationTransport({ sender, pool: () => pool, publicUrl: PUBLIC_URL });
const step = (transport: NotificationTransport | undefined, when: Date = NOW) => runNotificationStep({ pool, transport, now: () => when });
const deliveries = async () => (await pool.query("SELECT * FROM notification_deliveries ORDER BY created_at, id")).rows;
const reset = () => pool.query("TRUNCATE notification_deliveries, notifications, notification_preferences, matching_evaluations, matching_jobs, matching_outbox_events, phone_identities, demands, offers, users, sms_sends CASCADE");

describe("notifications par SMS réel : faux serveur Meno", () => {
  beforeEach(reset);

  test("un lot figé = UN SMS : texte, destinataire, clé notif-<lot>, journal ; les lignes sont marquées envoyées", async () => {
    const { buyer } = await scenario({ offers: 3 });
    const result = await step(menoTransport());
    assert.deepEqual({ users: result.users, messages: result.messages, delivered: result.delivered }, { users: 1, messages: 1, delivered: 3 });
    assert.equal(fake.messages.length, 1);
    const [message] = fake.messages;
    assert.equal(message.content, `noma : 3 nouvelles annonces pour vos besoins. ${PUBLIC_URL}/notifications`);
    assert.equal(message.to, buyer.phone);
    assert.equal(analyzeSms(message.content).singleSegment, true);
    const rows = await deliveries();
    const batch = rows[0].batch_key as string;
    assert.match(batch, /^[0-9a-f]{32}$/);
    assert.equal(message.key, `notif-${batch}`);
    for (const row of rows) assert.deepEqual({ status: row.status, last_error: row.last_error, batch: row.batch_key }, { status: "sent", last_error: null, batch });
    const journal = (await pool.query("SELECT * FROM sms_sends")).rows[0];
    assert.deepEqual({ purpose: journal.purpose, reference: journal.reference, key: journal.idempotency_key, status: journal.status }, { purpose: "notification", reference: batch, key: `notif-${batch}`, status: "accepted" });
    for (const leak of [buyer.phone as string, message.content, "nouvelles annonces"]) assert.equal(JSON.stringify(journal).includes(leak), false);
    // Rejouer l'étape n'envoie rien.
    await step(menoTransport());
    assert.equal(fake.sendRequests().length, 1);
  });

  test("singulier : « 1 nouvelle annonce »", async () => {
    await scenario({ offers: 1 });
    await step(menoTransport());
    assert.equal(fake.messages[0].content, `noma : 1 nouvelle annonce pour vos besoins. ${PUBLIC_URL}/notifications`);
  });

  test("échec puis reprise du MÊME lot : même clé d'idempotence, un seul SMS chez le fournisseur", async () => {
    await scenario({ offers: 2 });
    fake.queue(...Array.from({ length: 4 }, () => ({ kind: "status" as const, status: 429, headers: { "retry-after": "1" } })));
    const first = await step(menoTransport());
    assert.deepEqual({ messages: first.messages, retried: first.retried }, { messages: 0, retried: 2 });
    const pending = await deliveries();
    assert.ok(pending.every((row) => row.status === "pending" && row.attempts === 1 && row.batch_key !== null), "lot figé conservé");
    const batch = pending[0].batch_key as string;
    // Entre-temps une nouvelle annonce arrive : elle ne change pas le lot figé.
    const second = await step(menoTransport(), new Date(NOW.getTime() + 6 * 60_000));
    assert.equal(second.messages, 1);
    assert.equal(fake.messages.length, 1);
    const keys = new Set(fake.sendRequests().map((r) => r.headers["idempotency-key"]));
    assert.deepEqual([...keys], [`notif-${batch}`], "la clé du lot ne change jamais");
    assert.equal(fake.messages[0].content.startsWith("noma : 2 nouvelles annonces"), true);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM sms_sends")).rows[0].n, 1, "une seule ligne de journal pour le lot");
  });

  test("résultat INCERTAIN : jamais renvoyé, lignes comptées envoyées (code sms_uncertain), journal incertain, rythme de 4 h respecté", async () => {
    const { buyer, seller } = await scenario({ offers: 2 });
    fake.queue({ kind: "status", status: 503, body: { id: "msg_unsure_5", status: "unknown" } });
    const result = await step(menoTransport());
    assert.deepEqual({ messages: result.messages, delivered: result.delivered, failed: result.failed, retried: result.retried }, { messages: 1, delivered: 2, failed: 0, retried: 0 });
    const rows = await deliveries();
    assert.ok(rows.every((row) => row.status === "sent" && row.last_error === "sms_uncertain" && row.attempts === 1));
    assert.equal((await pool.query("SELECT status, provider_id FROM sms_sends")).rows[0].status, "uncertain");
    await step(menoTransport(), at(12, 20));
    assert.equal(fake.sendRequests().length, 1, "aucun renvoi");
    // Une nouvelle annonce arrive : elle attend les 4 heures qui suivent le message incertain.
    await scenario({ offers: 1, buyer, seller, at: at(12, 30) });
    const early = await step(menoTransport(), at(12, 31));
    assert.equal(early.messages, 0);
    assert.equal(early.deferred, 1);
    assert.equal(fake.sendRequests().length, 1);
    const later = await step(menoTransport(), at(16, 5));
    assert.equal(later.messages, 1);
    assert.equal(fake.sendRequests().length, 2);
  });

  test("règles de N1-bis inchangées : heures calmes, 4 h entre deux messages, 3 messages par jour — le fournisseur n'est appelé qu'après elles", async () => {
    const { buyer, seller } = await scenario({ offers: 1, at: at(23, 0) });
    const quiet = await step(menoTransport(), at(23, 0));
    assert.deepEqual({ messages: quiet.messages, deferred: quiet.deferred }, { messages: 0, deferred: 1 });
    assert.equal(fake.requests.length, 0, "heures calmes : aucun appel");
    await align(at(7, 30, new Date(NOW.getTime() + 86_400_000)));
    const sent: number[] = [];
    const nextDay = new Date(NOW.getTime() + 86_400_000);
    for (const [index, when] of [at(7, 30, nextDay), at(12, 0, nextDay), at(16, 30, nextDay), at(21, 0, nextDay)].entries()) {
      if (index > 0) await scenario({ offers: 1, buyer, seller, at: when });
      const result = await step(menoTransport(), when);
      sent.push(result.messages);
      if (index === 1) {
        await scenario({ offers: 1, buyer, seller, at: at(12, 10, nextDay) });
        const tooSoon = await step(menoTransport(), at(12, 11, nextDay));
        assert.equal(tooSoon.messages, 0, "moins de 4 h après le dernier message");
      }
    }
    assert.deepEqual(sent, [1, 1, 1, 0], "au plus 3 messages par jour : le quatrième est reporté");
    assert.equal(fake.sendRequests().length, 3, "exactement trois appels au fournisseur ce jour-là");
  });

  test("transport d'un utilisateur sans numéro vérifié : échec de tentative, aucun appel", async () => {
    const buyer = await makePerson(pool, { phone: false });
    await scenario({ offers: 1, buyer });
    const result = await step(menoTransport());
    assert.deepEqual({ messages: result.messages, retried: result.retried }, { messages: 0, retried: 1 });
    assert.equal(fake.requests.length, 0);
    assert.equal((await deliveries())[0].last_error, "transport_error");
  });

  test("le délai propre du transport (timeoutMs) remplace celui de 5 s", async () => {
    await scenario({ offers: 1 });
    const slow: NotificationTransport = { channel: "sms_meno", timeoutMs: 60, send: () => new Promise<void>((resolve) => setTimeout(resolve, 600)) };
    const result = await step(slow);
    assert.deepEqual({ messages: result.messages, retried: result.retried }, { messages: 0, retried: 1 });
    assert.equal((await deliveries())[0].last_error, "transport_timeout");
    await reset();
    await scenario({ offers: 1 });
    const patient: NotificationTransport = { channel: "sms_meno", timeoutMs: 3_000, send: () => new Promise<void>((resolve) => setTimeout(resolve, 100)) };
    assert.equal((await step(patient)).messages, 1);
  });

  test("résolveur : le transport réel est installé seulement avec la clé ET l'URL publique ; les préférences l'annoncent", async () => {
    const resolve = createNotificationResolverWithMeno(() => undefined, { warn: () => {}, resolveSender: () => makeSender() });
    assert.ok(resolve({ ...MENO_ENV, NOMA_SMS_BASE_URL: fake.baseUrl, NOMA_PUBLIC_URL: PUBLIC_URL }));
    assert.equal(resolve({ ...MENO_ENV, NOMA_SMS_BASE_URL: fake.baseUrl }), undefined, "URL publique absente");
    assert.equal(resolve({ ...MENO_ENV, NOMA_PUBLIC_URL: PUBLIC_URL }), undefined, "NODE_ENV=test : base officielle refusée");
    const user = await login(pool);
    const preferences = async (extra: Record<string, string | undefined>) => {
      const handlers = createNotificationsHttpHandlers({ pool, env: { NOMA_AUTH_ORIGIN: ORIGIN, ...extra } });
      return (await handlers.preferences.get(request("GET", "/api/notifications/preferences", { cookie: user.cookie })).then(reply)).json as { external: { available: boolean; notice: string } };
    };
    const inactive = await preferences({});
    assert.deepEqual(inactive.external, { available: false, notice: EXTERNAL_NOTICE });
    const active = await preferences({ ...MENO_ENV, NOMA_SMS_BASE_URL: fake.baseUrl, NOMA_PUBLIC_URL: PUBLIC_URL });
    assert.deepEqual(active.external, { available: true, notice: EXTERNAL_NOTICE_REAL, real: true });
  });
});
