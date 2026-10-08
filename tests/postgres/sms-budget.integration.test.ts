import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, beforeEach, describe, test } from "node:test";
import type { Pool, PoolClient } from "pg";
import { OtpRateLimitError, requestOtp, verifyOtp } from "../../lib/server/auth";
import { ipAggregation } from "../../lib/server/auth/ip-prefix";
import { secretFingerprint } from "../../lib/server/auth/primitives";
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
import { createLatencyMirror, createMenoOtpTransport } from "../../lib/server/sms/otp-transport";
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

  test("f) SMS1-ter — la réserve des numéros existants n'est ouverte qu'au PREMIER code du jour UTC de chaque numéro : les codes suivants du même numéro comptent dans la part des inconnus", async () => {
    const sender = makeSender({ budget: plan({ total: 20, notifications: 8, codes: 12, existingReserve: 6, newNumbers: 6, newNumbersPerHour: 12 }) });
    const again = (phoneN: number, keyN: number): SmsSendRequest => ({ ...sendRequest("otp", phoneN, "existing"), idempotencyKey: `otp-again-${String(keyN).padStart(5, "0")}`, reference: `again-${keyN}` });
    // Le numéro 1 (existant) demande 7 codes dans la journée : le premier puise dans la réserve, les 6 suivants dans la part des inconnus.
    for (let k = 1; k <= 7; k += 1) assert.equal(summary(await sender.send(again(1, k))), "accepted:-", `code ${k} du même numéro`);
    assert.deepEqual((await rows()).map((row) => row.audience), ["existing", "new", "new", "new", "new", "new", "new"]);
    assert.equal((await sender.send(again(1, 8))).errorCode, "budget_new_numbers", "la part des inconnus est épuisée par ce seul numéro : le 8e code est refusé");
    // La réserve est INTACTE : cinq autres numéros existants obtiennent leur premier code du jour.
    for (let n = 2; n <= 6; n += 1) assert.equal(summary(await sender.send(sendRequest("otp", n, "existing"))), "accepted:-", `premier code du numéro existant ${n}`);
    assert.equal(await count("audience = 'existing'"), 6, "1 + 5 premiers codes : la réserve (6) est entièrement disponible pour des numéros DIFFÉRENTS");
    assert.equal((await sender.send(sendRequest("otp", 7, "existing"))).errorCode, "budget_codes", "le budget des codes (12) est atteint");
    // Le lendemain, le numéro 1 retrouve son premier code de la réserve.
    clock = new Date(clock.getTime() + DAY);
    assert.equal(summary(await sender.send(again(1, 9))), "accepted:-");
    assert.equal((await rows()).at(-1).audience, "existing");
  });

  test("f) SMS1-ter — bloquer la connexion des numéros existants demande autant de numéros existants DIFFÉRENTS que la réserve a de places : quelques numéros demandés en boucle ne la vident pas (plafond 100 : codes 60, inconnus 30, réserve 30)", async () => {
    const budget = planBudgets(100);
    assert.deepEqual(budget, { total: 100, notifications: 40, codes: 60, existingReserve: 30, newNumbers: 30, newNumbersPerHour: 4 });
    const sender = makeSender({ budget });
    const loop = (phoneN: number, k: number): SmsSendRequest => ({ ...sendRequest("otp", phoneN, "existing"), idempotencyKey: `otp-loop-${phoneN}-${String(k).padStart(3, "0")}`, reference: `loop-${phoneN}-${k}` });
    // Cinq numéros existants (connus de l'attaquant) demandés en boucle pendant la journée, au rythme maximal (20 demandes par heure).
    for (let hour = 0; hour < 12; hour += 1) {
      for (let k = 0; k < 4; k += 1) for (let phoneN = 1; phoneN <= 5; phoneN += 1) await sender.send(loop(phoneN, hour * 4 + k));
      clock = new Date(clock.getTime() + 3_600_000);
    }
    assert.equal(clock.toISOString(), "2032-06-16T00:00:00.000Z");
    clock = new Date(Date.UTC(2032, 5, 15, 21, 30, 0)); // fin du 15 juin, hors heures calmes
    assert.equal(await count("created_at >= '2032-06-15T00:00:00Z' AND created_at < '2032-06-16T00:00:00Z' AND audience = 'existing'"), 5, "seuls les cinq PREMIERS codes ont puisé dans la réserve");
    assert.equal(await count("audience = 'new'"), 30, "tous les autres sont dans la part des inconnus (30), épuisée");
    // Les vrais utilisateurs existants (numéros différents) obtiennent encore leur premier code : 60 − 35 = 25 places.
    for (let phoneN = 6; phoneN <= 30; phoneN += 1) assert.equal(summary(await sender.send(sendRequest("otp", phoneN, "existing"))), "accepted:-", `premier code du numéro existant ${phoneN}`);
    assert.equal((await sender.send(sendRequest("otp", 31, "existing"))).errorCode, "budget_codes", "il aura fallu 30 numéros existants DIFFÉRENTS (5 + 25) en plus des 30 inconnus pour atteindre le budget des codes");
    assert.equal(await count("audience = 'existing'"), 30);
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

  test("e) SMS1-ter — code de connexion refusé pour budget : réponse IDENTIQUE à un succès (202, même corps, mêmes en-têtes), aucun SMS, défi send_failed non vérifiable, motif conservé ; un utilisateur existant reçoit son code", async () => {
    const sender = makeSender({ budget: plan({ total: 100, notifications: 40, codes: 60, existingReserve: 30, newNumbers: 2, newNumbersPerHour: 2 }) });
    const handlers = otpHandlers(sender);
    const existing = await login(pool);
    const post = (phone: string, ip: string) => handlers.requestOtp(otpPost("/api/auth/otp/request", { phone }, ip));
    const first = await post(phoneOf(101), "100.64.1.1");
    assert.equal(first.status, 202);
    assert.equal((await post(phoneOf(102), "100.64.2.1")).status, 202);
    const refused = await post(phoneOf(103), "100.64.3.1");
    const text = await refused.text();
    assert.equal(refused.status, 202, "le refus de capacité répond EXACTEMENT comme un succès");
    const refusedBody = JSON.parse(text) as { challengeId: string; expiresAt: string; resendAvailableAt: string };
    const firstBody = (await first.json()) as typeof refusedBody;
    assert.deepEqual(Object.keys(refusedBody).sort(), Object.keys(firstBody).sort(), "même forme de corps");
    assert.equal(refusedBody.expiresAt, firstBody.expiresAt, "même durée de vie annoncée");
    assert.equal(refusedBody.resendAvailableAt, firstBody.resendAvailableAt, "même délai de renvoi annoncé");
    assert.deepEqual([...refused.headers.keys()].sort(), [...first.headers.keys()].sort(), "mêmes en-têtes");
    assert.equal(refused.headers.get("content-type"), first.headers.get("content-type"));
    for (const leak of ["budget", "capacity", "capacité", "sollicité", "300", "plafond", KEY, phoneOf(103), "Meno"]) assert.equal(text.includes(leak), false, leak);
    assert.equal(fake.messages.length, 2, "aucun SMS pour la demande refusée");
    assert.equal(await count(), 2, "aucune ligne de journal pour la demande refusée");
    const challenge = (await pool.query("SELECT id, status, send_failure_code FROM otp_challenges WHERE phone_e164 = $1", [phoneOf(103)])).rows[0];
    assert.equal(challenge.status, "send_failed", "le défi est créé mais ne peut jamais être vérifié");
    assert.equal(challenge.send_failure_code, "budget_new_numbers", "le motif reste dans le défi (administration)");
    assert.equal(challenge.id, refusedBody.challengeId);
    // Aucun code ne vérifie ce défi : pas même un code plausible (le code n'existe chez personne).
    for (const code of ["000000", "123456", "654321"]) {
      assert.equal((await handlers.verifyOtp(otpPost("/api/auth/otp/verify", { challengeId: refusedBody.challengeId, code }, "100.64.3.1"))).status, 401);
    }
    // Le numéro existant, lui, reçoit son code (réserve).
    const existingAnswer = await post(existing.phone, "100.64.4.1");
    assert.equal(existingAnswer.status, 202);
    assert.equal(fake.messages.at(-1)?.to, existing.phone);
    assert.equal((await pool.query("SELECT audience FROM sms_sends WHERE phone_hash = $1", [phoneHash(AUTH_SECRET, existing.phone)])).rows[0].audience, "existing");
    // Un second refus pour le même numéro dans la minute : même réponse qu'un renvoi trop rapide d'un numéro qui a reçu son code (429 dans les deux cas).
    const again = await post(phoneOf(103), "100.64.3.1");
    const againAfterSuccess = await post(phoneOf(101), "100.64.1.1");
    assert.equal(again.status, 429);
    assert.equal(againAfterSuccess.status, 429);
    assert.equal(await again.text(), await againAfterSuccess.text());
  });

  test("e) SMS1-ter — le TEMPS d'un refus de capacité imite celui d'un vrai envoi : le transport attend une durée tirée parmi celles des envois réels", async () => {
    const sender = makeSender({ budget: plan({ total: 100, notifications: 40, codes: 60, existingReserve: 30, newNumbers: 1, newNumbersPerHour: 1 }) });
    const waits: number[] = [];
    let now = 0;
    const latency = { observed: [] as number[], observe(ms: number) { this.observed.push(ms); }, sample() { return 750; } };
    const transport = createMenoOtpTransport(sender, { pool: () => pool, latency, sleep: async (ms) => { waits.push(ms); }, clock: () => now });
    const input = (n: number) => ({ phone: phoneOf(n), code: "654321", challengeId: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`, expiresAt: new Date(clock.getTime() + 300_000) });
    await transport(input(1)); // part de l'unique place des inconnus : envoi réel
    assert.equal(latency.observed.length, 1, "la durée d'un vrai envoi alimente le miroir");
    assert.deepEqual([...waits], [], "un envoi réussi n'attend pas");
    await assert.rejects(transport(input(2)), (error: unknown) => error instanceof Error && error.name === "OtpCapacityError" && (error as { code?: string }).code === "budget_new_numbers");
    assert.deepEqual([...waits], [750], "le refus attend la durée échantillonnée (le temps déjà écoulé est déduit)");
    assert.equal(latency.observed.length, 1, "un refus local n'alimente pas le miroir");
    now = 0;
    // Le temps déjà écoulé dans le transport est déduit de l'attente.
    const slowClock = [0, 200, 200, 200, 200];
    let tick = 0;
    const transport2 = createMenoOtpTransport(sender, { pool: () => pool, latency, sleep: async (ms) => { waits.push(ms); }, clock: () => slowClock[Math.min(tick++, slowClock.length - 1)] });
    await assert.rejects(transport2(input(3)));
    assert.deepEqual([...waits], [750, 550], "750 ms visés, 200 ms déjà écoulés : on attend 550 ms");
  });

  test("e) SMS1-ter — mesure réelle : un fournisseur qui met ~250 ms à répondre ; la demande refusée pour capacité met autant de temps qu'une demande réussie, non quelques millisecondes", async () => {
    const sender = makeSender({ budget: plan({ total: 100, notifications: 40, codes: 60, existingReserve: 30, newNumbers: 3, newNumbersPerHour: 3 }) });
    const handlers = otpHandlersWith(() => createMenoOtpTransport(sender, { pool: () => pool, latency: createLatencyMirror() }));
    fake.queue(...Array.from({ length: 3 }, () => ({ kind: "delay" as const, ms: 250 })));
    const timed = async (n: number) => {
      const started = performance.now();
      const answer = await handlers.requestOtp(otpPost("/api/auth/otp/request", { phone: phoneOf(n) }, `100.65.${n % 250}.1`));
      return { status: answer.status, ms: performance.now() - started };
    };
    const succeeded = [await timed(201), await timed(202), await timed(203)];
    const refused = await timed(204);
    assert.deepEqual(succeeded.map((entry) => entry.status), [202, 202, 202]);
    assert.equal(refused.status, 202);
    assert.equal(fake.messages.length, 3, "le quatrième numéro n'a reçu aucun SMS");
    for (const entry of succeeded) assert.ok(entry.ms >= 240, `un vrai envoi dure ~250 ms (${Math.round(entry.ms)} ms)`);
    assert.ok(refused.ms >= 200, `le refus de capacité attend comme un vrai envoi : ${Math.round(refused.ms)} ms`);
    assert.ok(refused.ms < 1_500, `mais pas davantage : ${Math.round(refused.ms)} ms`);
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
      // SMS1-ter : toutes les réponses sont 202 (aucun oracle) ; ce qui est borné, c'est le nombre de SMS RÉELLEMENT envoyés.
      const sentBefore = fake.messages.length;
      for (let hour = 0; hour < hours; hour += 1) {
        for (let attempt = 0; attempt < attemptsPerHour; attempt += 1) {
          attackerIp += 1;
          // Une adresse d'un /24 différent à chaque demande : ni les compteurs par adresse ni ceux par préfixe ne l'arrêtent.
          const answer = await handlers.requestOtp(otpPost("/api/auth/otp/request", { phone: phoneOf(1_000 + attackerIp) }, `100.${64 + Math.floor(attackerIp / 250)}.${attackerIp % 250}.9`));
          assert.equal(answer.status, 202, "même réponse qu'un succès, SMS envoyé ou non");
        }
        clock = new Date(clock.getTime() + 3_600_000);
      }
      return fake.messages.length - sentBefore;
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
    // Et un numéro neuf ne reçoit rien, mais la réponse est la MÊME que pour un succès (aucun oracle d'énumération).
    const newcomer = await handlers.requestOtp(otpPost("/api/auth/otp/request", { phone: phoneOf(9_999) }, "100.210.1.1"));
    assert.equal(newcomer.status, 202);
    assert.equal(fake.messages.length, 33, "aucun SMS pour le numéro neuf");
    assert.equal((await pool.query("SELECT send_failure_code FROM otp_challenges WHERE phone_e164 = $1", [phoneOf(9_999)])).rows[0].send_failure_code, "budget_new_numbers");
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

describe("administration — codes de connexion non envoyés faute de capacité (SMS1-ter)", () => {
  test("/api/admin/sms compte, par motif et sans numéro, les demandes de code refusées pour capacité (24 h) alors que le visiteur a reçu un 202 identique à un succès", async () => {
    clock = new Date(); // heure réelle : la session du compte administrateur est créée avec l'heure réelle
    const boss = await login(pool);
    await grantAdmin({ pool, phone: boss.phone });
    const sender = makeSender({ budget: plan({ total: 100, notifications: 40, codes: 60, existingReserve: 30, newNumbers: 1, newNumbersPerHour: 1 }) });
    const handlers = otpHandlers(sender);
    for (const [index, ip] of ["100.66.1.1", "100.66.2.1", "100.66.3.1", "100.66.4.1"].entries()) {
      assert.equal((await handlers.requestOtp(otpPost("/api/auth/otp/request", { phone: phoneOf(900 + index) }, ip))).status, 202);
    }
    assert.equal(fake.messages.length, 1, "un seul SMS : la place des numéros inconnus est de 1");
    const admin = createAdminSmsHttpHandlers({ pool, env: { NODE_ENV: "test", NOMA_SMS_PROVIDER: "meno", NOMA_SMS_API_KEY: KEY, NOMA_SMS_BASE_URL: fake.baseUrl }, log: () => {}, usageCache: createUsageCache({ fetchUsage: null }), now: () => clock });
    const answer = await admin.overview(request("GET", "/api/admin/sms", { cookie: boss.cookie })).then(reply);
    assert.equal(answer.status, 200);
    const body = answer.json as { unsentCodes: { windowHours: number; total: number; byCode: Array<{ code: string; count: number }> } };
    assert.deepEqual(body.unsentCodes, { windowHours: 24, total: 3, byCode: [{ code: "budget_new_numbers", count: 3 }] });
    for (const leak of [phoneOf(901).slice(1), phoneOf(902).slice(1), KEY]) assert.equal(answer.text.includes(leak), false, leak);
    // Plus de 24 h plus tard : la trace sort de la fenêtre.
    const later = createAdminSmsHttpHandlers({ pool, env: {}, log: () => {}, usageCache: createUsageCache({ fetchUsage: null }), now: () => new Date(clock.getTime() + 25 * 3_600_000) });
    assert.deepEqual(((await later.overview(request("GET", "/api/admin/sms", { cookie: boss.cookie })).then(reply)).json as typeof body).unsentCodes, { windowHours: 24, total: 0, byCode: [] });
  });
});

// ───────────── B1-d (SMS1-ter) : compteurs par adresse et par préfixe, défis NON vérifiés, fenêtres glissantes ─────────────

describe("B1-d / SMS1-ter — compteurs par adresse et par préfixe d'adresse (/24 en IPv4, /64 en IPv6) : défis non vérifiés, fenêtres glissantes de 15 minutes et de 24 heures", () => {
  let phones = 0;
  const WINDOW = new Date(Date.UTC(2032, 5, 15, 10, 0, 1));
  const ask = (ip: string, at: Date = WINDOW) =>
    requestOtp(phoneOf(50_000 + (phones += 1)), { pool, authSecret: AUTH_SECRET, requestIp: ip, now: () => at, sendOtp: async () => {} });
  const isRefused = (ip: string, at: Date = WINDOW) => ask(ip, at).then(() => false, (error: unknown) => (error instanceof OtpRateLimitError ? true : Promise.reject(error)));
  /** Défis non vérifiés déjà présents (hors de la fenêtre de 15 minutes si `ageMs` est grand), sans passer par 300 demandes réelles. */
  async function seed(column: "request_ip_fingerprint" | "request_prefix_fingerprint", fingerprint: string, count: number, createdAt: Date, status = "expired"): Promise<void> {
    await pool.query(
      `INSERT INTO otp_challenges (id, phone_e164, otp_hmac, request_ip_fingerprint, request_prefix_fingerprint, status, expires_at, created_at, updated_at)
       SELECT gen_random_uuid(), '+2250708' || lpad((g + $5::int)::text, 6, '0'), repeat('a', 64),
              CASE WHEN $1 = 'request_ip_fingerprint' THEN $2 ELSE repeat('b', 64) END,
              CASE WHEN $1 = 'request_prefix_fingerprint' THEN $2 ELSE NULL END,
              $3, $4::timestamptz + interval '5 minutes', $4::timestamptz, $4::timestamptz
         FROM generate_series(1, $6::int) AS g`,
      [column, fingerprint, status, createdAt.toISOString(), (phones += 1) * 1_000, count],
    );
  }
  const ipFingerprint = (ip: string) => secretFingerprint(AUTH_SECRET, "ip", ip);
  const prefixFingerprint = (ip: string) => secretFingerprint(AUTH_SECRET, "ip-prefix", ipAggregation(ip).key);

  test("IPv4 : 300 adresses différentes d'un même /24 passent en 15 min (chacune bien en dessous de sa limite), la 301e est refusée ; un autre /24 n'est pas touché ; 15 minutes plus tard le /24 repart (fenêtre glissante, pas minuit)", async () => {
    for (let host = 1; host <= 300; host += 1) await ask(`203.0.113.${(host % 250) + 1}`);
    assert.equal(await isRefused("203.0.113.251"), true, "301e demande du même /24");
    assert.equal(await isRefused("203.0.113.252"), true);
    await ask("203.0.114.1"); // autre /24
    await ask("198.51.100.1");
    // C'est bien le compteur de préfixe qui a refusé : l'adresse refusée n'a aucun défi à son nom.
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM otp_challenges WHERE request_ip_fingerprint = $1", [ipFingerprint("203.0.113.251")])).rows[0].n, 0);
    // 15 minutes plus tard (même jour UTC) : les 300 défis sortent de la fenêtre glissante, le /24 repart sans attendre minuit.
    await ask("203.0.113.251", new Date(WINDOW.getTime() + 15 * 60_000 + 1_000));
  });

  test("IPv4 : au plus 1500 défis non vérifiés par jour glissant pour un /24, même répartis sur des quarts d'heure différents ; la limite se libère 24 h après, pas à minuit", async () => {
    const prefix = prefixFingerprint("192.0.2.7");
    await seed("request_prefix_fingerprint", prefix, 1_499, new Date(WINDOW.getTime() - 3 * 3_600_000));
    await ask("192.0.2.10"); // le 1500e
    assert.equal(await isRefused("192.0.2.11"), true, "1500 par jour pour un /24");
    assert.equal(await isRefused("192.0.2.12", new Date(WINDOW.getTime() + 6 * 3_600_000)), true, "6 h plus tard : toujours dans les 24 h glissantes");
    // Les 1499 défis ont été créés 3 h avant WINDOW : ils sortent de la fenêtre 24 h + 3 h après (donc après minuit UTC, mais ce n'est pas minuit qui libère).
    assert.equal(await isRefused("192.0.2.13", new Date(WINDOW.getTime() + 20 * 3_600_000 + 59 * 60_000)), true, "à 20 h 59 : encore refusé");
    await ask("192.0.2.14", new Date(WINDOW.getTime() + 21 * 3_600_000 + 1_000));
  });

  test("IPv6 : 60 demandes par 15 min pour un /64 quelle que soit l'adresse dans le bloc (écritures différentes comprises) ; un autre /64 n'est pas touché", async () => {
    for (let index = 1; index <= 60; index += 1) await ask(`2001:db8:1:2:${index.toString(16)}::1`);
    assert.equal(await isRefused("2001:db8:1:2:ffff:ffff:ffff:ffff"), true, "61e demande du même /64");
    assert.equal(await isRefused("2001:0db8:0001:0002:0000:0000:0000:0042"), true, "autre écriture du même /64");
    await ask("2001:db8:1:3::1"); // autre /64
    await ask("2001:db8:2:2::1");
  });

  test("IPv6 qui encapsule une IPv4 : compté dans le /24 de l'IPv4", async () => {
    await seed("request_prefix_fingerprint", prefixFingerprint("203.0.115.1"), 300, new Date(WINDOW.getTime() - 60_000));
    assert.equal(await isRefused("::ffff:203.0.115.200"), true);
    assert.equal(await isRefused("::ffff:cb00:73c9"), true);
    assert.equal(await isRefused("203.0.115.201"), true);
    await ask("203.0.116.1");
  });

  test("une même adresse est limitée à 60 défis non vérifiés par 15 min glissantes (le reste du /24 n'est pas touché) et à 300 par 24 h glissantes", async () => {
    for (let index = 1; index <= 60; index += 1) await ask("203.0.116.7");
    assert.equal(await isRefused("203.0.116.7"), true);
    await ask("203.0.116.8");
    await ask("203.0.116.7", new Date(WINDOW.getTime() + 15 * 60_000 + 1_000)); // 15 min plus tard : libérée
    await seed("request_ip_fingerprint", ipFingerprint("203.0.117.7"), 299, new Date(WINDOW.getTime() - 2 * 3_600_000));
    await ask("203.0.117.7");
    assert.equal(await isRefused("203.0.117.7"), true, "300 par jour pour une adresse");
    await ask("203.0.117.7", new Date(WINDOW.getTime() + 22 * 3_600_000 + 1_000));
  });

  test("CGNAT : 150 utilisateurs légitimes derrière UNE adresse partagée, qui vérifient leur code, passent tous (le défi vérifié libère sa place) ; un demandeur qui ne vérifie jamais est arrêté à 60", async () => {
    const codes = new Map<string, string>();
    let clockMs = WINDOW.getTime();
    let refusedLegit = 0;
    for (let user = 0; user < 150; user += 1) {
      clockMs += 5_000; // 150 utilisateurs en 12 minutes et demie, sous une même adresse publique
      const phone = phoneOf(70_000 + user);
      let challengeId: string;
      try {
        ({ challengeId } = await requestOtp(phone, { pool, authSecret: AUTH_SECRET, requestIp: "41.66.10.77", now: () => new Date(clockMs), sendOtp: async (input) => { codes.set(input.challengeId, input.code); } }));
      } catch (error) {
        if (error instanceof OtpRateLimitError) { refusedLegit += 1; continue; }
        throw error;
      }
      await verifyOtp(challengeId, codes.get(challengeId)!, { pool, authSecret: AUTH_SECRET, now: () => new Date(clockMs + 1_000) });
    }
    assert.equal(refusedLegit, 0, "aucun utilisateur légitime refusé derrière l'adresse partagée");
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM otp_challenges WHERE request_ip_fingerprint = $1 AND status = 'consumed'", [ipFingerprint("41.66.10.77")])).rows[0].n, 150);
    // Le demandeur qui ne vérifie jamais (même adresse) : arrêté à 60 défis non vérifiés.
    let attackerAccepted = 0;
    for (let index = 0; index < 70; index += 1) {
      const ok = await requestOtp(phoneOf(80_000 + index), { pool, authSecret: AUTH_SECRET, requestIp: "41.66.10.77", now: () => new Date(clockMs), sendOtp: async () => {} }).then(() => true, (error: unknown) => (error instanceof OtpRateLimitError ? false : Promise.reject(error)));
      if (ok) attackerAccepted += 1;
    }
    assert.equal(attackerAccepted, 60, "60 défis non vérifiés par adresse, les 150 vérifiés ne comptent pas");
  });

  test("CGNAT : 320 utilisateurs légitimes répartis sur un /24 (5 adresses) qui vérifient leur code passent tous, au-delà de la limite de 300 du /24", async () => {
    const codes = new Map<string, string>();
    let clockMs = WINDOW.getTime();
    for (let user = 0; user < 320; user += 1) {
      clockMs += 2_000;
      const ip = `41.66.11.${1 + (user % 5)}`;
      const { challengeId } = await requestOtp(phoneOf(90_000 + user), { pool, authSecret: AUTH_SECRET, requestIp: ip, now: () => new Date(clockMs), sendOtp: async (input) => { codes.set(input.challengeId, input.code); } });
      await verifyOtp(challengeId, codes.get(challengeId)!, { pool, authSecret: AUTH_SECRET, now: () => new Date(clockMs + 500) });
    }
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM otp_challenges WHERE request_prefix_fingerprint = $1 AND status = 'consumed'", [prefixFingerprint("41.66.11.1")])).rows[0].n, 320);
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
  return otpHandlersWith(() => createMenoOtpTransport(sender, { pool: () => pool, sleep: async () => {} }));
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
