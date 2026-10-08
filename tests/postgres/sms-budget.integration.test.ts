import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, beforeEach, describe, test } from "node:test";
import type { Pool, PoolClient } from "pg";
import { OtpRateLimitError, requestOtp } from "../../lib/server/auth";
import { createAuthHttpHandlers, type AuthHttpHandlers } from "../../lib/server/auth/http";
import type { SendOtp } from "../../lib/server/auth/types";
import type { DemandRecord, OfferRecord } from "../../lib/server/catalog/types";
import { EXTERNAL_NOTICE, EXTERNAL_NOTICE_REAL } from "../../lib/server/notifications/config";
import { recordNewMatchNotification } from "../../lib/server/notifications/creation";
import { runNotificationStep } from "../../lib/server/notifications/deliveries";
import { createNotificationsHttpHandlers } from "../../lib/server/notifications/http";
import type { NotificationTransport } from "../../lib/server/notifications/transport";
import { createAdminSmsHttpHandlers } from "../../lib/server/sms/admin-http";
import { createUsageCache } from "../../lib/server/sms/admin";
import { grantAdmin } from "../../lib/server/admin/grant";
import { planBudgets, type SmsBudgetPlan } from "../../lib/server/sms/budget";
import { createMenoClient } from "../../lib/server/sms/meno";
import { SMOKE_MESSAGE } from "../../lib/server/sms/messages";
import { createMenoNotificationTransport } from "../../lib/server/sms/notification-transport";
import { createMenoOtpTransport } from "../../lib/server/sms/otp-transport";
import { createSmsSender, phoneHash, type SmsSender, type SmsSendRequest, type SmsSendResult } from "../../lib/server/sms/sender";
import { startFakeMeno, type FakeMeno } from "../server/fake-meno";
import { insertEvaluation, makeDemand, makeOffer, makePerson, type Person } from "./metrics-fixtures";
import { ORIGIN, login, openTestSchema, reply, request, type TestSchema } from "./social-fixtures";

const KEY = "fake_meno_key_for_tests_only_0001";
const AUTH_SECRET = randomBytes(32);
const PROXY_SECRET = "proxy-auth-test-secret-32-bytes-minimum";
const PUBLIC_URL = "https://noma.example.ci";
const OTP_CONTENT = "noma : votre code est 654321. Il expire dans 5 min. Ne le partagez pas.";
const NOTIFICATION_CONTENT = `noma : 1 nouvelle annonce pour vos besoins. ${PUBLIC_URL}/notifications`;
const DAY = 24 * 3_600_000;
const START = new Date(Date.UTC(2032, 5, 15, 12, 0, 0));

let env: TestSchema;
let pool: Pool;
let pool2: Pool;
let fake: FakeMeno;
let clock = START;

before(async () => {
  env = await openTestSchema(10);
  pool = env.pool;
  pool2 = env.extraPool(10);
  fake = await startFakeMeno({ apiKey: KEY });
});
after(async () => {
  await fake.close();
  await env.close();
});
beforeEach(async () => {
  fake.reset();
  clock = START;
  await pool.query("TRUNCATE notification_deliveries, notifications, notification_preferences, matching_evaluations, matching_jobs, matching_outbox_events, phone_identities, demands, offers, users, sms_sends, otp_challenges, otp_rate_limit_counters CASCADE");
});

/** Un plan explicite (les essais isolent chaque règle) ; les valeurs non citées sont larges. */
const plan = (overrides: Partial<SmsBudgetPlan> = {}): SmsBudgetPlan => ({ total: 1_000, notifications: 400, codes: 600, existingReserve: 300, newNumbers: 300, newNumbersPerHour: 300, ...overrides });

function makeSender(options: { budget?: SmsBudgetPlan; poolOf?: Pool; attemptTimeoutMs?: number } = {}): SmsSender {
  return createSmsSender({
    client: createMenoClient({ apiKey: KEY, baseUrl: fake.baseUrl, attemptTimeoutMs: options.attemptTimeoutMs ?? 300, sleep: async () => {} }),
    pool: () => options.poolOf ?? pool,
    phoneSecret: () => AUTH_SECRET,
    budget: options.budget ?? plan(),
    now: () => clock,
    log: () => {},
  });
}

type Audience = "existing" | "new" | null;
const phoneOf = (n: number) => `+22507${String(10_000_000 + n).padStart(8, "0")}`;
function sendRequest(purpose: "otp" | "notification" | "smoke", n: number, audience: Audience = "new"): SmsSendRequest {
  const prefix = purpose === "otp" ? "otp" : purpose === "notification" ? "notif" : "smoke";
  const key = `${prefix}-budget-${String(n).padStart(5, "0")}`;
  return {
    purpose,
    reference: key,
    idempotencyKey: key,
    to: phoneOf(n),
    content: purpose === "otp" ? OTP_CONTENT : purpose === "notification" ? NOTIFICATION_CONTENT : SMOKE_MESSAGE,
    audience: purpose === "otp" ? audience : null,
  };
}
const summary = (result: SmsSendResult) => `${result.status}:${result.errorCode ?? "-"}`;
const rows = async () => (await pool.query("SELECT * FROM sms_sends ORDER BY created_at, idempotency_key")).rows;
const count = async (where = "TRUE") => (await pool.query(`SELECT count(*)::int AS n FROM sms_sends WHERE ${where}`)).rows[0].n as number;

// ───────────── B1 : budgets séparés, réserve, lissage ─────────────

describe("B1 — budgets séparés, réserve des numéros existants, lissage horaire", () => {
  test("a) les codes et les notifications ont chacun leur budget : l'épuisement de l'un ne touche jamais l'autre (dans les deux sens)", async () => {
    // Le total (20) est volontairement supérieur à la somme des deux budgets : on voit le motif propre à chaque budget, pas celui du total.
    const sender = makeSender({ budget: plan({ total: 20, notifications: 4, codes: 6, existingReserve: 3, newNumbers: 3, newNumbersPerHour: 6 }) });
    // Codes épuisés (6) → les notifications partent encore.
    for (let n = 1; n <= 6; n += 1) assert.equal(summary(await sender.send(sendRequest("otp", n, n <= 3 ? "existing" : "new"))), "accepted:-", `code ${n}`);
    const refusedCode = await sender.send(sendRequest("otp", 7, "existing"));
    assert.deepEqual({ status: refusedCode.status, code: refusedCode.errorCode, scope: refusedCode.budgetScope, attempts: refusedCode.attempts }, { status: "failed", code: "budget_codes", scope: "codes", attempts: 0 });
    for (let n = 1; n <= 4; n += 1) assert.equal(summary(await sender.send(sendRequest("notification", n))), "accepted:-", `notification ${n}`);
    assert.equal((await sender.send(sendRequest("notification", 5))).errorCode, "budget_notifications");
    assert.equal(fake.sendRequests().length, 10, "exactement 10 requêtes au fournisseur, pas une de plus");
    assert.equal(await count(), 10, "un refus pour budget ne laisse aucune ligne");
    // Le lendemain : notifications épuisées d'abord → les codes partent encore.
    clock = new Date(clock.getTime() + DAY);
    for (let n = 11; n <= 14; n += 1) assert.equal(summary(await sender.send(sendRequest("notification", n))), "accepted:-");
    assert.equal((await sender.send(sendRequest("notification", 15))).errorCode, "budget_notifications");
    for (let n = 21; n <= 26; n += 1) assert.equal(summary(await sender.send(sendRequest("otp", n, n <= 23 ? "existing" : "new"))), "accepted:-", `code ${n}`);
    assert.equal((await sender.send(sendRequest("otp", 27, "existing"))).errorCode, "budget_codes");
  });

  test("le plafond total s'applique à tous les usages ; l'essai du fondateur ne dépend que du total (jamais bloqué par un budget de codes épuisé)", async () => {
    const sender = makeSender({ budget: plan({ total: 3, notifications: 1, codes: 2, existingReserve: 0, newNumbers: 2, newNumbersPerHour: 2 }) });
    assert.equal(summary(await sender.send(sendRequest("otp", 1))), "accepted:-");
    assert.equal(summary(await sender.send(sendRequest("otp", 2))), "accepted:-");
    assert.equal((await sender.send(sendRequest("otp", 3))).errorCode, "budget_codes");
    assert.equal(summary(await sender.send(sendRequest("smoke", 4))), "accepted:-", "codes épuisés : l'essai part (total 2 sur 3)");
    assert.equal((await sender.send(sendRequest("notification", 5))).errorCode, "budget_total", "le total est atteint : même une notification dans son budget est refusée");
    assert.equal((await sender.send(sendRequest("smoke", 6))).errorCode, "budget_total");
  });

  test("b) réserve : un numéro INCONNU ne consomme que la part non réservée ; les numéros existants gardent l'accès au reste du budget des codes", async () => {
    const sender = makeSender({ budget: plan({ total: 20, notifications: 8, codes: 12, existingReserve: 6, newNumbers: 6, newNumbersPerHour: 12 }) });
    for (let n = 1; n <= 6; n += 1) assert.equal(summary(await sender.send(sendRequest("otp", n, "new"))), "accepted:-", `numéro neuf ${n}`);
    for (let n = 7; n <= 9; n += 1) {
      const refused = await sender.send(sendRequest("otp", n, "new"));
      assert.equal(refused.errorCode, "budget_new_numbers", `numéro neuf ${n}`);
    }
    assert.equal((await sender.send(sendRequest("otp", 10, null))).errorCode, "budget_new_numbers", "numéro dont l'existence n'est pas établie : traité comme inconnu");
    assert.equal(fake.sendRequests().length, 6, "aucun SMS pour les numéros neufs refusés");
    // Un attaquant a saturé la part des inconnus : les utilisateurs existants se connectent encore (jusqu'à épuisement du budget des codes).
    for (let n = 11; n <= 16; n += 1) assert.equal(summary(await sender.send(sendRequest("otp", n, "existing"))), "accepted:-", `utilisateur existant ${n}`);
    assert.equal((await sender.send(sendRequest("otp", 17, "existing"))).errorCode, "budget_codes");
    assert.equal(await count("audience = 'new'"), 6);
    assert.equal(await count("audience = 'existing'"), 6);
  });

  test("c) lissage horaire : au plus (part / 24) × 3 numéros inconnus par heure GLISSANTE, y compris au passage de minuit ; les numéros existants n'y sont pas soumis", async () => {
    const sender = makeSender({ budget: plan({ total: 100, notifications: 10, codes: 90, existingReserve: 10, newNumbers: 80, newNumbersPerHour: 2 }) });
    assert.equal(summary(await sender.send(sendRequest("otp", 1))), "accepted:-");
    assert.equal(summary(await sender.send(sendRequest("otp", 2))), "accepted:-");
    assert.equal((await sender.send(sendRequest("otp", 3))).errorCode, "budget_new_numbers_hour");
    // 30 minutes plus tard : toujours dans l'heure glissante.
    clock = new Date(clock.getTime() + 30 * 60_000);
    assert.equal((await sender.send(sendRequest("otp", 4))).errorCode, "budget_new_numbers_hour");
    assert.equal(summary(await sender.send(sendRequest("otp", 5, "existing"))), "accepted:-", "un numéro existant n'est pas soumis au lissage");
    // 59 min 59 s après le premier envoi : encore refusé ; une minute plus tard les deux premiers sont sortis de la fenêtre.
    clock = new Date(START.getTime() + 60 * 60_000 - 1_000);
    assert.equal((await sender.send(sendRequest("otp", 6))).errorCode, "budget_new_numbers_hour");
    clock = new Date(START.getTime() + 60 * 60_000 + 1_000);
    assert.equal(summary(await sender.send(sendRequest("otp", 7))), "accepted:-");
    assert.equal(summary(await sender.send(sendRequest("otp", 8))), "accepted:-");
    assert.equal((await sender.send(sendRequest("otp", 9))).errorCode, "budget_new_numbers_hour");
    // Avant minuit puis après minuit : le compteur du JOUR repart de zéro, pas la fenêtre glissante d'une heure.
    await pool.query("TRUNCATE sms_sends");
    clock = new Date(Date.UTC(2032, 5, 15, 23, 40, 0));
    assert.equal(summary(await sender.send(sendRequest("otp", 21))), "accepted:-");
    assert.equal(summary(await sender.send(sendRequest("otp", 22))), "accepted:-");
    clock = new Date(Date.UTC(2032, 5, 16, 0, 10, 0));
    assert.equal(await count("created_at >= '2032-06-16T00:00:00Z'"), 0, "le jour a changé : aucun envoi aujourd'hui");
    assert.equal((await sender.send(sendRequest("otp", 23))).errorCode, "budget_new_numbers_hour", "mais l'heure glissante contient encore les deux envois de 23 h 40");
    clock = new Date(Date.UTC(2032, 5, 16, 0, 41, 0));
    assert.equal(summary(await sender.send(sendRequest("otp", 24))), "accepted:-");
  });

  test("seuls pending, accepted et uncertain consomment un budget : un envoi failed ou rejected ne compte pas", async () => {
    const sender = makeSender({ budget: plan({ total: 2, notifications: 0, codes: 2, existingReserve: 0, newNumbers: 2, newNumbersPerHour: 2 }) });
    fake.queue({ kind: "status", status: 422 }, { kind: "status", status: 401 });
    assert.equal(summary(await sender.send(sendRequest("otp", 1))), "rejected:invalid_request");
    assert.equal(summary(await sender.send(sendRequest("otp", 2))), "rejected:unauthorized");
    fake.queue(...Array.from({ length: 4 }, () => ({ kind: "status" as const, status: 429, headers: { "retry-after": "1" } })));
    assert.equal(summary(await sender.send(sendRequest("otp", 3))), "failed:rate_limited");
    assert.equal(await count("status IN ('failed','rejected')"), 3);
    // Aucun des trois n'a consommé de budget : deux envois passent encore.
    assert.equal(summary(await sender.send(sendRequest("otp", 4))), "accepted:-");
    assert.equal(summary(await sender.send(sendRequest("otp", 5))), "accepted:-");
    assert.equal((await sender.send(sendRequest("otp", 6))).errorCode, "budget_total");
  });

  test("e) code de connexion refusé pour budget : réponse DISTINCTE (503 otp_capacity_reached), aucun SMS, défi send_failed ; un utilisateur existant se connecte encore", async () => {
    const sender = makeSender({ budget: plan({ total: 100, notifications: 40, codes: 60, existingReserve: 30, newNumbers: 2, newNumbersPerHour: 2 }) });
    const handlers = otpHandlers(sender);
    const existing = await login(pool);
    const post = (phone: string, ip: string) => handlers.requestOtp(otpPost("/api/auth/otp/request", { phone }, ip));
    assert.equal((await post(phoneOf(101), "100.64.1.1")).status, 202);
    assert.equal((await post(phoneOf(102), "100.64.2.1")).status, 202);
    const refused = await post(phoneOf(103), "100.64.3.1");
    const text = await refused.text();
    assert.equal(refused.status, 503);
    assert.deepEqual(JSON.parse(text), { error: { code: "otp_capacity_reached", message: "Le service d'envoi de codes est très sollicité. Réessayez plus tard." } });
    assert.notEqual(JSON.parse(text).error.code, "otp_delivery_failed", "réponse distincte du « envoi impossible » générique");
    for (const leak of ["budget", "300", "plafond", KEY, phoneOf(103), "Meno"]) assert.equal(text.includes(leak), false, leak);
    assert.equal(fake.messages.length, 2, "aucun SMS pour la demande refusée");
    assert.equal(await count(), 2, "aucune ligne de journal pour la demande refusée");
    const challenge = (await pool.query("SELECT status FROM otp_challenges WHERE phone_e164 = $1", [phoneOf(103)])).rows[0];
    assert.equal(challenge.status, "send_failed");
    // Le numéro existant, lui, reçoit son code (réserve).
    const existingAnswer = await post(existing.phone, "100.64.4.1");
    assert.equal(existingAnswer.status, 202);
    assert.equal(fake.messages.at(-1)?.to, existing.phone);
    assert.equal((await pool.query("SELECT audience FROM sms_sends WHERE phone_hash = $1", [phoneHash(AUTH_SECRET, existing.phone)])).rows[0].audience, "existing");
  });

  test("e) notification refusée pour budget : REPORTÉE au lendemain 7 h (jamais failed), aucune tentative consommée, aucun SMS, MÊME clé de lot le lendemain", async () => {
    const sender = makeSender({ budget: plan({ total: 100, notifications: 1, codes: 99, existingReserve: 0, newNumbers: 99, newNumbersPerHour: 99 }) });
    await scenario({ offers: 1 });
    await scenario({ offers: 1 });
    const transport = notificationTransport(sender);
    const result = await step(transport, START);
    assert.deepEqual({ users: result.users, messages: result.messages, delivered: result.delivered, deferred: result.deferred, failed: result.failed, retried: result.retried }, { users: 2, messages: 1, delivered: 1, deferred: 1, failed: 0, retried: 0 });
    assert.equal(fake.messages.length, 1, "un seul SMS : le budget des notifications est de 1");
    assert.equal(await count(), 1, "le refus ne laisse aucune ligne de journal");
    const waiting = (await deliveries()).filter((row) => row.status === "pending");
    assert.equal(waiting.length, 1, "la ligne du second utilisateur attend");
    const batch = waiting[0].batch_key as string;
    assert.match(batch, /^[0-9a-f]{32}$/, "lot figé conservé");
    for (const row of waiting) {
      assert.equal(row.attempts, 0, "aucune tentative consommée");
      assert.equal(row.last_error, "sms_budget");
      assert.equal(new Date(row.next_attempt_at).toISOString(), "2032-06-16T07:00:00.000Z", "lendemain 7 h UTC (hors heures calmes)");
    }
    // Le même jour, plus tard : rien ne part, rien ne change.
    const again = await step(transport, new Date(START.getTime() + 6 * 3_600_000));
    assert.deepEqual({ messages: again.messages, failed: again.failed, retried: again.retried }, { messages: 0, failed: 0, retried: 0 });
    // Le lendemain à 7 h 30 : le budget est neuf, le MÊME lot part avec la MÊME clé d'idempotence.
    const nextDay = new Date(Date.UTC(2032, 5, 16, 7, 30, 0));
    clock = nextDay;
    const later = await step(transport, nextDay);
    assert.equal(later.messages, 1);
    assert.equal(fake.messages.length, 2);
    assert.equal(fake.messages[1].key, `notif-${batch}`, "la clé du lot figé n'a jamais changé");
    assert.equal((await deliveries()).filter((row) => row.status === "failed").length, 0);
  });

  test("e) report pour budget et heures calmes : à chaque instant hors heures calmes (bords 7 h et 21 h 59, fin de mois, fin d'année), la ligne refusée est reportée au lendemain 7 h UTC, jamais à minuit ni avant", async () => {
    const cases: Array<[string, string]> = [
      ["2032-06-15T07:00:00.000Z", "2032-06-16T07:00:00.000Z"],
      ["2032-06-15T12:00:00.000Z", "2032-06-16T07:00:00.000Z"],
      ["2032-06-15T21:59:00.000Z", "2032-06-16T07:00:00.000Z"],
      ["2032-06-30T21:59:00.000Z", "2032-07-01T07:00:00.000Z"],
      ["2032-12-31T21:59:00.000Z", "2033-01-01T07:00:00.000Z"],
    ];
    for (const [instant, expected] of cases) {
      await pool.query("TRUNCATE notification_deliveries, notifications, notification_preferences, matching_evaluations, matching_jobs, matching_outbox_events, phone_identities, demands, offers, users, sms_sends CASCADE");
      fake.reset();
      const when = new Date(instant);
      clock = when;
      const sender = makeSender({ budget: plan({ total: 100, notifications: 1, codes: 99, existingReserve: 0, newNumbers: 99, newNumbersPerHour: 99 }) });
      await scenario({ offers: 1, at: when });
      await scenario({ offers: 1, at: when });
      const result = await step(notificationTransport(sender), when);
      assert.deepEqual({ messages: result.messages, delivered: result.delivered, deferred: result.deferred, failed: result.failed }, { messages: 1, delivered: 1, deferred: 1, failed: 0 }, instant);
      const waiting = (await deliveries()).filter((row) => row.status === "pending");
      assert.equal(waiting.length, 1, instant);
      assert.equal(waiting[0].attempts, 0, instant);
      assert.equal(waiting[0].last_error, "sms_budget", instant);
      assert.equal(new Date(waiting[0].next_attempt_at).toISOString(), expected, `report depuis ${instant}`);
    }
  });

  test("e) un épuisement du budget des CODES laisse partir les notifications (même pool, même journée)", async () => {
    const sender = makeSender({ budget: plan({ total: 10, notifications: 5, codes: 5, existingReserve: 0, newNumbers: 5, newNumbersPerHour: 5 }) });
    for (let n = 1; n <= 5; n += 1) assert.equal(summary(await sender.send(sendRequest("otp", n))), "accepted:-");
    assert.equal((await sender.send(sendRequest("otp", 6))).errorCode, "budget_codes");
    await scenario({ offers: 2 });
    const result = await step(notificationTransport(sender), START);
    assert.deepEqual({ messages: result.messages, deferred: result.deferred, failed: result.failed }, { messages: 1, deferred: 0, failed: 0 });
  });

  test("A1–A3 adaptés — saturation par des numéros NEUFS depuis des adresses variées : coût borné par heure et par jour, les utilisateurs existants se connectent encore, les notifications partent", async () => {
    const budget = planBudgets(100); // notifications 40, codes 60, réserve 30, inconnus 30, 4 par heure
    assert.deepEqual(budget, { total: 100, notifications: 40, codes: 60, existingReserve: 30, newNumbers: 30, newNumbersPerHour: 4 });
    const sender = makeSender({ budget });
    const handlers = otpHandlers(sender);
    const users = [await login(pool), await login(pool), await login(pool)];
    let attackerIp = 0;
    const attack = async (hours: number, attemptsPerHour: number) => {
      let accepted = 0;
      for (let hour = 0; hour < hours; hour += 1) {
        for (let attempt = 0; attempt < attemptsPerHour; attempt += 1) {
          attackerIp += 1;
          // Une adresse d'un /24 différent à chaque demande : ni les compteurs par adresse ni ceux par préfixe ne l'arrêtent.
          const answer = await handlers.requestOtp(otpPost("/api/auth/otp/request", { phone: phoneOf(1_000 + attackerIp) }, `100.${64 + Math.floor(attackerIp / 250)}.${attackerIp % 250}.9`));
          if (answer.status === 202) accepted += 1;
          else assert.equal(answer.status, 503);
        }
        clock = new Date(clock.getTime() + 3_600_000);
      }
      return accepted;
    };
    // Première heure : une rafale de 50 demandes n'obtient que 4 SMS (60 F pour 4 SMS à 15 F).
    const firstHour = await attack(1, 50);
    assert.equal(clock.toISOString(), "2032-06-15T13:00:00.000Z");
    assert.equal(firstHour, 4, "au plus newNumbersPerHour SMS pour des numéros inconnus en une heure");
    assert.equal(fake.messages.length, 4);
    // Le reste de la journée UTC (11 heures de plus, jusqu'à minuit) : jamais plus que la part des inconnus (30 SMS = 450 F), puis plus rien.
    const rest = await attack(11, 50);
    assert.equal(clock.toISOString(), "2032-06-16T00:00:00.000Z");
    assert.ok(firstHour + rest <= 30, `au plus 30 SMS pour numéros inconnus par jour, obtenu ${firstHour + rest}`);
    assert.equal(firstHour + rest, 30, "la part des inconnus est entièrement consommée");
    assert.equal(fake.messages.length, 30);
    // On se place en fin de journée (21 h 30, hors heures calmes), avant minuit : la part des inconnus est épuisée pour le jour courant.
    clock = new Date(Date.UTC(2032, 5, 15, 21, 30, 0));
    // Après saturation par numéros neufs : les utilisateurs EXISTANTS se connectent encore ; leur code arrive.
    for (const user of users) {
      const answer = await handlers.requestOtp(otpPost("/api/auth/otp/request", { phone: user.phone }, `100.200.${users.indexOf(user)}.1`));
      assert.equal(answer.status, 202, "un utilisateur existant se connecte malgré la saturation");
      assert.equal(fake.messages.at(-1)?.to, user.phone);
    }
    assert.equal(fake.messages.length, 33);
    // Et un numéro neuf, lui, est refusé (distinctement).
    const newcomer = await handlers.requestOtp(otpPost("/api/auth/otp/request", { phone: phoneOf(9_999) }, "100.210.1.1"));
    assert.equal(newcomer.status, 503);
    assert.equal(((await newcomer.json()) as { error: { code: string } }).error.code, "otp_capacity_reached");
    // Les notifications ont leur budget propre : elles partent encore.
    await scenario({ offers: 1, at: clock });
    const notify = await step(notificationTransport(sender), clock);
    assert.equal(notify.messages, 1);
    // Coût maximal observé : 30 SMS inconnus + 3 existants + 1 notification = 34 SMS, 510 F (≤ plafond total de 100 SMS = 1 500 F).
    assert.equal(await count("status = 'accepted'"), 34);
    assert.ok((await count("status = 'accepted'")) * 15 <= 100 * 15);
  });
});

// ───────────── M1 : plafond exact sous concurrence ─────────────

describe("M1 — le plafond est EXACT sous forte concurrence (verrou consultatif), sur deux pools", () => {
  test("80 envois simultanés sur deux pools, plafond total de 5 : exactement 5 lignes et 5 SMS", async () => {
    const senders = [makeSender({ budget: plan({ total: 5, notifications: 0, codes: 5, existingReserve: 0, newNumbers: 5, newNumbersPerHour: 5 }) }), makeSender({ poolOf: pool2, budget: plan({ total: 5, notifications: 0, codes: 5, existingReserve: 0, newNumbers: 5, newNumbersPerHour: 5 }) })];
    const results = await Promise.all(Array.from({ length: 80 }, (_, index) => senders[index % 2].send(sendRequest("otp", 200 + index))));
    assert.equal(results.filter((result) => result.status === "accepted").length, 5);
    assert.equal(results.filter((result) => result.errorCode === "budget_total").length, 75);
    assert.equal(await count(), 5, "exactement 5 lignes de journal");
    assert.equal(fake.sendRequests().length, 5, "exactement 5 requêtes au fournisseur");
    assert.equal(fake.messages.length, 5);
  });

  test("80 envois simultanés mélangés (codes pour numéros neufs et notifications) : chaque budget est exact", async () => {
    const budget = plan({ total: 12, notifications: 5, codes: 7, existingReserve: 4, newNumbers: 3, newNumbersPerHour: 3 });
    const senders = [makeSender({ budget }), makeSender({ poolOf: pool2, budget })];
    const results = await Promise.all(
      Array.from({ length: 80 }, (_, index) => senders[index % 2].send(index % 2 === 0 ? sendRequest("otp", 300 + index, "new") : sendRequest("notification", 300 + index))),
    );
    void results;
    assert.equal(await count("purpose = 'otp'"), 3, "numéros inconnus : exactement 3");
    assert.equal(await count("purpose = 'notification'"), 5, "notifications : exactement 5");
    assert.equal(fake.sendRequests().length, 8);
  });

  test("la REPRISE d'un envoi failed est elle aussi exacte et unique : 20 reprises simultanées de la même clé = UNE requête", async () => {
    const senders = [makeSender(), makeSender({ poolOf: pool2 })];
    fake.queue(...Array.from({ length: 4 }, () => ({ kind: "status" as const, status: 429, headers: { "retry-after": "1" } })));
    const request1 = sendRequest("otp", 400);
    assert.equal(summary(await senders[0].send(request1)), "failed:rate_limited");
    fake.reset();
    const results = await Promise.all(Array.from({ length: 20 }, (_, index) => senders[index % 2].send(request1)));
    assert.equal(fake.sendRequests().length, 1, "une seule reprise gagne");
    assert.equal(results.filter((result) => result.status === "accepted" && !result.skipped).length, 1);
    assert.ok(results.every((result) => result.status === "accepted" || result.errorCode === "in_flight"));
    assert.equal(await count(), 1);
  });
});

// ───────────── C2 : la reprise repasse par le budget ─────────────

describe("C2 — la reprise d'une ligne failed repasse par le contrôle de budget", () => {
  test("budget épuisé entre l'échec et la reprise : la reprise est REFUSÉE (aucun appel, la ligne reste failed), puis passe le lendemain avec la même clé", async () => {
    const sender = makeSender({ budget: plan({ total: 4, notifications: 0, codes: 4, existingReserve: 0, newNumbers: 4, newNumbersPerHour: 4 }) });
    fake.queue(...Array.from({ length: 4 }, () => ({ kind: "status" as const, status: 429, headers: { "retry-after": "1" } })));
    const original = sendRequest("otp", 500);
    const failed = await sender.send(original);
    assert.equal(summary(failed), "failed:rate_limited");
    const [before] = await rows();
    assert.equal(before.status, "failed");
    for (let n = 501; n <= 504; n += 1) assert.equal(summary(await sender.send(sendRequest("otp", n))), "accepted:-");
    const requestsBefore = fake.sendRequests().length;
    const retry = await sender.send(original);
    assert.deepEqual({ status: retry.status, code: retry.errorCode, scope: retry.budgetScope }, { status: "failed", code: "budget_total", scope: "total" });
    assert.equal(fake.sendRequests().length, requestsBefore, "la reprise refusée n'appelle PAS le fournisseur");
    const stillFailed = (await rows()).find((row) => row.idempotency_key === original.idempotencyKey);
    assert.deepEqual({ status: stillFailed.status, error: stillFailed.error_code, http: stillFailed.http_status, created: stillFailed.created_at.toISOString() }, { status: "failed", error: "rate_limited", http: 429, created: before.created_at.toISOString() });
    // Le lendemain : le budget est neuf, la MÊME ligne et la MÊME clé repartent ; le coût est daté du jour de l'envoi.
    clock = new Date(clock.getTime() + DAY);
    const resumed = await sender.send(original);
    assert.equal(summary(resumed), "accepted:-");
    const [after] = (await rows()).filter((row) => row.idempotency_key === original.idempotencyKey);
    assert.equal(after.id, before.id, "même ligne");
    assert.equal(after.created_at.toISOString(), clock.toISOString(), "datée de la reprise");
    assert.equal(after.attempts, 5, "requêtes cumulées");
    assert.equal(new Set(fake.sendRequests().map((r) => r.headers["idempotency-key"])).size, 5, "4 clés d'autres envois + celle-ci, la clé de CET envoi n'a jamais changé");
    assert.equal(await count("created_at >= '2032-06-16T00:00:00Z'"), 1, "le budget du nouveau jour compte la reprise");
  });

  test("la reprise respecte aussi les budgets par catégorie (numéros inconnus, lissage horaire, notifications)", async () => {
    const sender = makeSender({ budget: plan({ total: 100, notifications: 1, codes: 99, existingReserve: 50, newNumbers: 1, newNumbersPerHour: 1 }) });
    const failedOtp = sendRequest("otp", 600, "new");
    const failedNotification = sendRequest("notification", 601);
    fake.queue(...Array.from({ length: 8 }, () => ({ kind: "status" as const, status: 429, headers: { "retry-after": "1" } })));
    assert.equal(summary(await sender.send(failedOtp)), "failed:rate_limited");
    assert.equal(summary(await sender.send(failedNotification)), "failed:rate_limited");
    assert.equal(summary(await sender.send(sendRequest("otp", 602, "new"))), "accepted:-", "un autre numéro neuf prend la seule place des inconnus");
    assert.equal(summary(await sender.send(sendRequest("notification", 603))), "accepted:-", "un autre lot prend la seule place des notifications");
    const before = fake.sendRequests().length;
    assert.equal((await sender.send(failedOtp)).errorCode, "budget_new_numbers", "reprise d'un code pour numéro inconnu : refusée");
    assert.equal((await sender.send(failedNotification)).errorCode, "budget_notifications", "reprise d'une notification : refusée");
    assert.equal(fake.sendRequests().length, before);
    assert.equal(await count("status = 'failed'"), 2);
    // Un numéro EXISTANT garde la réserve : sa reprise passe.
    const failedExisting = sendRequest("otp", 604, "existing");
    fake.queue(...Array.from({ length: 4 }, () => ({ kind: "status" as const, status: 429, headers: { "retry-after": "1" } })));
    assert.equal(summary(await sender.send(failedExisting)), "failed:rate_limited");
    assert.equal(summary(await sender.send(failedExisting)), "accepted:-");
  });
});

// ───────────── C1 : issue finale non 2xx après un envoi possible = uncertain ─────────────

describe("C1 — un SMS peut-être parti n'est jamais enregistré failed ni rejected", () => {
  const dropThen = (...behaviors: Array<{ kind: "status"; status: number; headers?: Record<string, string> }>) => fake.queue({ kind: "drop" }, ...behaviors);

  test("coupure puis 429 épuisé / 401 / 409 / 422 / 502 / 400 : uncertain (code et statut HTTP conservés), jamais renvoyé automatiquement", async () => {
    const cases: Array<[string, Array<{ kind: "status"; status: number; headers?: Record<string, string> }>, number, string]> = [
      ["429 épuisé", Array.from({ length: 4 }, () => ({ kind: "status" as const, status: 429, headers: { "retry-after": "1" } })), 429, "rate_limited"],
      ["401", [{ kind: "status", status: 401 }], 401, "unauthorized"],
      ["409", [{ kind: "status", status: 409 }], 409, "idempotency_conflict"],
      ["422", [{ kind: "status", status: 422 }], 422, "invalid_request"],
      ["502", [{ kind: "status", status: 502 }], 502, "provider_refused"],
      ["400", [{ kind: "status", status: 400 }], 400, "http_400"],
    ];
    for (const [index, [label, queue, http, code]] of cases.entries()) {
      fake.reset();
      const sender = makeSender();
      const sendIt = sendRequest("otp", 700 + index);
      dropThen(...queue);
      const result = await sender.send(sendIt);
      assert.deepEqual({ status: result.status, code: result.errorCode, http: result.httpStatus }, { status: "uncertain", code, http }, `coupure puis ${label}`);
      const row = (await rows()).find((r) => r.idempotency_key === sendIt.idempotencyKey);
      assert.deepEqual({ status: row.status, error: row.error_code, http: row.http_status }, { status: "uncertain", error: code, http });
      const requests = fake.sendRequests().length;
      for (let again = 0; again < 3; again += 1) {
        const rerun = await sender.send(sendIt);
        assert.deepEqual({ status: rerun.status, skipped: rerun.skipped }, { status: "uncertain", skipped: true }, `${label} : jamais renvoyé`);
      }
      assert.equal(fake.sendRequests().length, requests, `${label} : aucune requête de plus`);
    }
  });

  test("sans envoi possible, les issues restent inchangées : 429 épuisé = failed (reprenable), 401 = rejected", async () => {
    fake.queue(...Array.from({ length: 4 }, () => ({ kind: "status" as const, status: 429, headers: { "retry-after": "1" } })));
    assert.equal(summary(await makeSender().send(sendRequest("otp", 710))), "failed:rate_limited");
    fake.queue({ kind: "status", status: 401 });
    assert.equal(summary(await makeSender().send(sendRequest("otp", 711))), "rejected:unauthorized");
  });

  test("code de connexion : un défi dont l'envoi est uncertain (coupure puis refus) reste VÉRIFIABLE — le code éventuellement reçu fonctionne", async () => {
    const captured: SmsSendRequest[] = [];
    const base = makeSender();
    const sender: SmsSender = { send: (sendIt) => (captured.push(sendIt), base.send(sendIt)) };
    const handlers = otpHandlers(sender);
    dropThen({ kind: "status", status: 401 });
    const phone = phoneOf(720);
    const answer = await handlers.requestOtp(otpPost("/api/auth/otp/request", { phone }, "100.64.20.1"));
    assert.equal(answer.status, 202, "le défi est annoncé : le code est peut-être arrivé");
    const { challengeId } = (await answer.json()) as { challengeId: string };
    assert.equal((await pool.query("SELECT status FROM otp_challenges WHERE id = $1", [challengeId])).rows[0].status, "sent");
    assert.equal((await pool.query("SELECT status, error_code FROM sms_sends")).rows[0].status, "uncertain");
    const code = /votre code est ([0-9]{6})\./.exec(captured[0].content)?.[1] ?? assert.fail("code");
    const verified = await handlers.verifyOtp(otpPost("/api/auth/otp/verify", { challengeId, code }, "100.64.20.1"));
    assert.equal(verified.status, 200, "le code reçu marche");
    // Contrôle : un échec définitif SANS envoi possible reste un échec (défi send_failed, réponse générique).
    fake.queue({ kind: "status", status: 401 });
    const failed = await handlers.requestOtp(otpPost("/api/auth/otp/request", { phone: phoneOf(721) }, "100.64.21.1"));
    assert.equal(failed.status, 503);
    assert.equal(((await failed.json()) as { error: { code: string } }).error.code, "otp_delivery_failed");
  });

  test("notification : un lot uncertain (coupure puis 429 épuisé) compte dans le rythme 4 h / 3 par jour et n'est JAMAIS renvoyé", async () => {
    const { buyer, seller } = await scenario({ offers: 2 });
    const sender = makeSender();
    dropThen(...Array.from({ length: 4 }, () => ({ kind: "status" as const, status: 429, headers: { "retry-after": "1" } })));
    const result = await step(notificationTransport(sender), START);
    assert.deepEqual({ messages: result.messages, delivered: result.delivered, failed: result.failed, retried: result.retried }, { messages: 1, delivered: 2, failed: 0, retried: 0 });
    const sent = await deliveries();
    assert.ok(sent.every((row) => row.status === "sent" && row.last_error === "sms_uncertain" && row.attempts === 1), "lignes comptées envoyées avec le code sms_uncertain");
    assert.equal((await pool.query("SELECT status, error_code FROM sms_sends")).rows[0].status, "uncertain");
    const requests = fake.sendRequests().length;
    const rerun = await step(notificationTransport(sender), new Date(START.getTime() + 20 * 60_000));
    assert.equal(rerun.messages, 0);
    assert.equal(fake.sendRequests().length, requests, "jamais renvoyé");
    // Rythme : une annonce arrivée 30 minutes plus tard attend les 4 heures qui suivent le lot incertain.
    await scenario({ offers: 1, buyer, seller, at: new Date(START.getTime() + 30 * 60_000) });
    const early = await step(notificationTransport(sender), new Date(START.getTime() + 31 * 60_000));
    assert.deepEqual({ messages: early.messages, deferred: early.deferred }, { messages: 0, deferred: 1 });
    const later = await step(notificationTransport(sender), new Date(START.getTime() + 4 * 3_600_000 + 60_000));
    assert.equal(later.messages, 1);
  });

  test("S-b notification : délai de garde dépassé pendant que l'expéditeur travaille encore → reprise du même lot SANS second SMS", async () => {
    await scenario({ offers: 1 });
    const sender = makeSender({ attemptTimeoutMs: 3_000 });
    fake.queue({ kind: "delay", ms: 500, then: { kind: "accept" } });
    const slowGuard = (inner: NotificationTransport): NotificationTransport => ({ channel: inner.channel, timeoutMs: 100, send: (message) => inner.send(message) });
    const first = await step(slowGuard(notificationTransport(sender)), START);
    assert.deepEqual({ messages: first.messages, retried: first.retried, failed: first.failed }, { messages: 0, retried: 1, failed: 0 });
    await new Promise((resolve) => setTimeout(resolve, 900));
    assert.equal(fake.messages.length, 1, "le SMS est bien parti malgré le délai de garde");
    const second = await step(notificationTransport(sender), new Date(START.getTime() + 6 * 60_000));
    assert.equal(second.messages, 1, "le lot est compté envoyé (résultat connu du journal)");
    assert.equal(fake.sendRequests().length, 1, "aucun second SMS");
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM sms_sends")).rows[0].n, 1);
  });

  test("S-b code de connexion : délai de garde de requestOtp dépassé pendant l'envoi → le défi ne devient PAS send_failed, le code reçu ensuite fonctionne", async () => {
    const captured: SmsSendRequest[] = [];
    const base = makeSender({ attemptTimeoutMs: 3_000 });
    const sender: SmsSender = { send: (sendIt) => (captured.push(sendIt), base.send(sendIt)) };
    const real = createMenoOtpTransport(sender, { pool: () => pool });
    assert.equal(real.timeoutIsUncertain, true, "le transport réel déclare qu'un dépassement ne prouve rien");
    const guarded = Object.assign((input: Parameters<SendOtp>[0]) => real(input), { timeoutMs: 120, timeoutIsUncertain: real.timeoutIsUncertain });
    const handlers = otpHandlersWith(() => guarded);
    fake.queue({ kind: "delay", ms: 600, then: { kind: "accept" } });
    const answer = await handlers.requestOtp(otpPost("/api/auth/otp/request", { phone: phoneOf(730) }, "100.64.30.1"));
    assert.equal(answer.status, 202, "ni échec ni 503 : le SMS est peut-être parti");
    const { challengeId } = (await answer.json()) as { challengeId: string };
    assert.equal((await pool.query("SELECT status FROM otp_challenges WHERE id = $1", [challengeId])).rows[0].status, "sent");
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    assert.equal(fake.messages.length, 1);
    const code = /votre code est ([0-9]{6})\./.exec(fake.messages[0].content)?.[1] ?? assert.fail("code");
    assert.equal((await handlers.verifyOtp(otpPost("/api/auth/otp/verify", { challengeId, code }, "100.64.30.1"))).status, 200, "le code reçu après le délai de garde fonctionne");
    assert.equal((await pool.query("SELECT status FROM sms_sends")).rows[0].status, "accepted");
    // Contrôle : un transport qui ne déclare pas `timeoutIsUncertain` garde le comportement d'avant (échec et défi send_failed).
    const legacy = Object.assign(async () => { await new Promise((resolve) => setTimeout(resolve, 400)); }, { timeoutMs: 100 });
    const legacyAnswer = await otpHandlersWith(() => legacy).requestOtp(otpPost("/api/auth/otp/request", { phone: phoneOf(731) }, "100.64.31.1"));
    assert.equal(legacyAnswer.status, 503);
    assert.equal((await pool.query("SELECT status FROM otp_challenges WHERE phone_e164 = $1", [phoneOf(731)])).rows[0].status, "send_failed");
  });
});

// ───────────── M5 : « SMS réel » seulement si le transport est réellement disponible ─────────────

describe("M5 — la mention « SMS réel » des préférences ne s'affiche que si le transport de notification est réellement disponible", () => {
  test("clé valide mais NOMA_PUBLIC_URL absente, drapeau ambigu, hors production avec la base officielle : pas de mention ; transport réel disponible : mention", async () => {
    const user = await login(pool);
    const preferences = async (extra: Record<string, string | undefined>) => {
      const handlers = createNotificationsHttpHandlers({ pool, env: { NOMA_AUTH_ORIGIN: ORIGIN, ...extra } });
      return (await handlers.preferences.get(request("GET", "/api/notifications/preferences", { cookie: user.cookie })).then(reply)).json as { external: { available: boolean; notice: string; real?: boolean } };
    };
    const meno = { NODE_ENV: "test", NOMA_SMS_PROVIDER: "meno", NOMA_SMS_API_KEY: KEY, NOMA_SMS_BASE_URL: fake.baseUrl };
    // Réel et disponible.
    assert.deepEqual((await preferences({ ...meno, NOMA_PUBLIC_URL: PUBLIC_URL })).external, { available: true, notice: EXTERNAL_NOTICE_REAL, real: true });
    // Clé valide mais pas d'URL publique : aucun transport de notification → pas de promesse de SMS réel.
    assert.deepEqual((await preferences(meno)).external, { available: false, notice: EXTERNAL_NOTICE });
    // Configuration ambiguë (meno + drapeau de développement) : aucun transport.
    assert.deepEqual((await preferences({ ...meno, NODE_ENV: "development", NOMA_PUBLIC_URL: PUBLIC_URL, NOMA_DEV_NOTIFY_CONSOLE: "1" })).external, { available: false, notice: EXTERNAL_NOTICE });
    // Hors production avec la base officielle (C4) : meno est inactif.
    assert.deepEqual((await preferences({ ...meno, NODE_ENV: "staging", NOMA_SMS_BASE_URL: undefined, NOMA_PUBLIC_URL: PUBLIC_URL })).external, { available: false, notice: EXTERNAL_NOTICE });
    // Clé invalide.
    assert.deepEqual((await preferences({ ...meno, NOMA_SMS_API_KEY: "court", NOMA_PUBLIC_URL: PUBLIC_URL })).external, { available: false, notice: EXTERNAL_NOTICE });
    // Production avec tout ce qu'il faut : réel.
    assert.deepEqual((await preferences({ NODE_ENV: "production", NOMA_SMS_PROVIDER: "meno", NOMA_SMS_API_KEY: KEY, NOMA_PUBLIC_URL: PUBLIC_URL })).external, { available: true, notice: EXTERNAL_NOTICE_REAL, real: true });
    // Simulé en développement seulement (pas de meno) : disponible mais PAS réel, texte « simulé ».
    assert.deepEqual((await preferences({ NODE_ENV: "development", NOMA_DEV_NOTIFY_CONSOLE: "1" })).external, { available: true, notice: EXTERNAL_NOTICE });
    // Rien du tout.
    assert.deepEqual((await preferences({})).external, { available: false, notice: EXTERNAL_NOTICE });
  });
});

// ───────────── administration : budgets et échecs récents ─────────────

describe("administration — budgets du jour et envois échoués récents", () => {
  test("/api/admin/sms expose le plan et la consommation du jour, et les envois failed des dernières 24 h (numéro masqué), sans rien d'autre", async () => {
    clock = new Date(); // heure réelle : la session du compte administrateur est créée avec l'heure réelle
    const boss = await login(pool);
    await grantAdmin({ pool, phone: boss.phone });
    const sender = makeSender({ budget: planBudgets(1_000) });
    fake.queue(...Array.from({ length: 4 }, () => ({ kind: "status" as const, status: 429, headers: { "retry-after": "1" } })));
    await sender.send(sendRequest("otp", 800, "new"));
    await sender.send(sendRequest("otp", 801, "existing"));
    await sender.send(sendRequest("notification", 802));
    const handlers = createAdminSmsHttpHandlers({ pool, env: { NODE_ENV: "test", NOMA_SMS_PROVIDER: "meno", NOMA_SMS_API_KEY: KEY, NOMA_SMS_BASE_URL: fake.baseUrl }, log: () => {}, usageCache: createUsageCache({ fetchUsage: null }), now: () => clock });
    const answer = await handlers.overview(request("GET", "/api/admin/sms", { cookie: boss.cookie })).then(reply);
    assert.equal(answer.status, 200);
    const body = answer.json as {
      budget: { day: string; plan: SmsBudgetPlan; used: Record<string, number> };
      recentFailed: Array<{ maskedPhone: string; purpose: string; errorCode: string | null; httpStatus: number | null }>;
      local: Record<string, number | string>;
    };
    assert.deepEqual(body.budget.plan, planBudgets(1_000));
    assert.equal(body.budget.day, clock.toISOString().slice(0, 10));
    assert.deepEqual(body.budget.used, { total: 2, codes: 1, newNumbers: 0, newNumbersHour: 0, notifications: 1 });
    assert.equal(body.recentFailed.length, 1);
    const { id: failedId, ...failedRest } = body.recentFailed[0] as typeof body.recentFailed[0] & { id: string };
    assert.match(failedId, /^[0-9a-f-]{36}$/);
    assert.deepEqual(failedRest, { purpose: "otp", maskedPhone: `+${"•".repeat(11)}00`, createdAt: clock.toISOString(), httpStatus: 429, errorCode: "rate_limited", attempts: 4 });
    assert.equal(body.local.failed, 1);
    for (const leak of [phoneOf(800).slice(1), "0710000800", KEY, OTP_CONTENT]) assert.equal(answer.text.includes(leak), false, leak);
    // Plus de 24 h plus tard : l'échec sort de la liste (il reste compté dans le mois).
    const later = createAdminSmsHttpHandlers({ pool, env: {}, log: () => {}, usageCache: createUsageCache({ fetchUsage: null }), now: () => new Date(clock.getTime() + 25 * 3_600_000) });
    const laterBody = (await later.overview(request("GET", "/api/admin/sms", { cookie: boss.cookie })).then(reply)).json as typeof body;
    assert.equal(laterBody.recentFailed.length, 0);
  });
});

// ───────────── B1-d : compteurs agrégés par préfixe d'adresse ─────────────

describe("B1-d — compteurs agrégés par préfixe d'adresse (/24 en IPv4, /64 en IPv6), en plus des compteurs par adresse", () => {
  let phones = 0;
  const WINDOW = new Date(Date.UTC(2032, 5, 15, 10, 0, 1)); // début d'une fenêtre fixe de 15 minutes
  const ask = (ip: string, at: Date = WINDOW) =>
    requestOtp(phoneOf(50_000 + (phones += 1)), { pool, authSecret: AUTH_SECRET, requestIp: ip, now: () => at, sendOtp: async () => {} });
  const refused = (ip: string, at: Date = WINDOW) => ask(ip, at).then(() => false, (error: unknown) => error instanceof OtpRateLimitError || Promise.reject(error));

  test("IPv4 : 100 adresses différentes d'un même /24 passent en 15 min (chacune bien en dessous de sa limite), la 101e est refusée ; un autre /24 n'est pas touché", async () => {
    for (let host = 1; host <= 100; host += 1) await ask(`203.0.113.${host}`);
    assert.equal(await refused("203.0.113.101"), true, "101e demande du même /24");
    assert.equal(await refused("203.0.113.200"), true);
    await ask("203.0.114.1"); // autre /24
    await ask("198.51.100.1");
    // La même adresse n'a pas dépassé sa limite propre (1 sur 20) : c'est bien le compteur de préfixe qui a refusé.
    const perAddress = await pool.query("SELECT max(request_count)::int AS n FROM otp_rate_limit_counters WHERE dimension = 'ip' AND window_kind = '15m'");
    assert.equal(perAddress.rows[0].n, 100, "le compteur le plus haut est celui du préfixe (100), les adresses sont à 1");
    // Quinze minutes plus tard (nouvelle fenêtre), le /24 repart.
    await ask("203.0.113.101", new Date(WINDOW.getTime() + 15 * 60_000));
  });

  test("IPv4 : au plus 500 demandes par jour pour un /24, même réparties sur des fenêtres de 15 minutes différentes", async () => {
    let accepted = 0;
    for (let slot = 0; slot < 6; slot += 1) {
      const at = new Date(WINDOW.getTime() + slot * 16 * 60_000);
      for (let host = 1; host <= 100; host += 1) {
        const ok = await ask(`192.0.2.${host + slot}`, at).then(() => true, (error: unknown) => (error instanceof OtpRateLimitError ? false : Promise.reject(error)));
        if (ok) accepted += 1;
      }
    }
    assert.equal(accepted, 500, "500 par jour pour un /24");
    assert.equal(await refused("192.0.2.250", new Date(WINDOW.getTime() + 6 * 16 * 60_000)), true);
    assert.equal(await refused("192.0.2.251", new Date(WINDOW.getTime() + 7 * 16 * 60_000)), true);
  });

  test("IPv6 : 20 demandes par 15 min pour un /64 quelle que soit l'adresse dans le bloc (écritures différentes comprises) ; un autre /64 n'est pas touché", async () => {
    for (let index = 1; index <= 20; index += 1) await ask(`2001:db8:1:2:${index.toString(16)}::1`);
    assert.equal(await refused("2001:db8:1:2:ffff:ffff:ffff:ffff"), true, "21e demande du même /64");
    assert.equal(await refused("2001:0db8:0001:0002:0000:0000:0000:0042"), true, "autre écriture du même /64");
    await ask("2001:db8:1:3::1"); // autre /64
    await ask("2001:db8:2:2::1");
  });

  test("IPv6 qui encapsule une IPv4 : compté dans le /24 de l'IPv4", async () => {
    for (let host = 1; host <= 100; host += 1) await ask(`203.0.115.${host}`);
    assert.equal(await refused("::ffff:203.0.115.200"), true);
    assert.equal(await refused("::ffff:cb00:73c9"), true);
  });

  test("les compteurs existants restent : une même adresse est limitée à 20 par 15 min", async () => {
    for (let index = 1; index <= 20; index += 1) await ask("203.0.116.7");
    assert.equal(await refused("203.0.116.7"), true);
    await ask("203.0.116.8");
  });
});

// ───────────── aides ─────────────

function otpPost(path: string, body: unknown, ip: string): Request {
  return new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { origin: ORIGIN, "content-type": "application/json", "x-noma-proxy-secret": PROXY_SECRET, "x-forwarded-for": ip },
    body: JSON.stringify(body),
  });
}

function otpHandlersWith(resolveSendOtp: (env: Record<string, string | undefined>) => SendOtp | undefined): AuthHttpHandlers {
  return createAuthHttpHandlers({
    pool,
    now: () => clock,
    authSecret: AUTH_SECRET,
    env: { NOMA_AUTH_ORIGIN: ORIGIN, NOMA_AUTH_PROXY_SECRET: PROXY_SECRET },
    resolveSendOtp,
  });
}

function otpHandlers(sender: SmsSender): AuthHttpHandlers {
  return otpHandlersWith(() => createMenoOtpTransport(sender, { pool: () => pool }));
}

function notificationTransport(sender: SmsSender): NotificationTransport {
  return createMenoNotificationTransport({ sender, pool: () => pool, publicUrl: PUBLIC_URL });
}

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

async function align(at: Date): Promise<void> {
  await pool.query(
    `UPDATE notification_deliveries SET created_at = $1::timestamptz - interval '1 hour', updated_at = $1::timestamptz - interval '1 hour',
            next_attempt_at = $1::timestamptz - interval '1 minute' WHERE status = 'pending' AND attempts = 0 AND batch_key IS NULL`,
    [at],
  );
  await pool.query("UPDATE demands SET notify_until = $1::timestamptz + interval '30 days'", [at]);
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
  await align(options.at ?? START);
  return { buyer, seller, demand, offers };
}

const step = (transport: NotificationTransport | undefined, when: Date) => runNotificationStep({ pool, transport, now: () => when });
const deliveries = async () => (await pool.query("SELECT * FROM notification_deliveries ORDER BY created_at, id")).rows;
