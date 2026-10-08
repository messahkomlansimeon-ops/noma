import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, beforeEach, describe, test } from "node:test";
import type { Pool } from "pg";
import { grantAdmin } from "../../lib/server/admin/grant";
import { createAdminSmsHttpHandlers } from "../../lib/server/sms/admin-http";
import { createUsageCache } from "../../lib/server/sms/admin";
import { planBudgets, type SmsBudgetPlan } from "../../lib/server/sms/budget";
import { finishSend, markInterrupted, reserveSend, utcDayStart } from "../../lib/server/sms/journal";
import { createMenoClient } from "../../lib/server/sms/meno";
import { createSmsSender, phoneHash, type SmsSender, type SmsSendRequest } from "../../lib/server/sms/sender";
import { startFakeMeno, type FakeMeno } from "../server/fake-meno";
import { NOT_FOUND, login, openTestSchema, reply, request, type TestSchema } from "./social-fixtures";

const KEY = "fake_meno_key_for_tests_only_0001";
const SECRET = randomBytes(32);
const TO = "+2250712345612";
const CONTENT = "noma : votre code est 654321. Il expire dans 5 min. Ne le partagez pas.";
const OTP_KEY = "otp-3f2504e0-4f89-41d3-9a0c-0305e82c3301";

let env: TestSchema;
let pool: Pool;
let fake: FakeMeno;
let clock = new Date();
const logs: string[] = [];
const waits: number[] = [];

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
  logs.length = 0;
  waits.length = 0;
  clock = new Date();
  await pool.query("TRUNCATE sms_sends");
});

function makeSender(options: { dailyCap?: number; budget?: SmsBudgetPlan; poolOf?: () => Pool; secret?: () => Uint8Array; staleAfterMs?: number } = {}): SmsSender {
  return createSmsSender({
    client: createMenoClient({ apiKey: KEY, baseUrl: fake.baseUrl, attemptTimeoutMs: 300, sleep: async (ms) => void waits.push(ms) }),
    pool: options.poolOf ?? (() => pool),
    phoneSecret: options.secret ?? (() => SECRET),
    dailyCap: options.dailyCap ?? 1_000,
    budget: options.budget,
    now: () => clock,
    log: (line) => void logs.push(line),
    staleAfterMs: options.staleAfterMs,
  });
}

const request1 = (overrides: Partial<SmsSendRequest> = {}): SmsSendRequest => ({ purpose: "otp", reference: OTP_KEY.slice(4), idempotencyKey: OTP_KEY, to: TO, content: CONTENT, ...overrides });
interface AdminBody {
  contractVersion: string;
  provider: { mode: string; active: boolean; unitPriceXof: number };
  usage: { accepted: number; acceptedAmountXof: number } | null;
  usageError: string | null;
  local: Record<string, unknown>;
  uncertain: Array<{ maskedPhone: string; status: string; providerId: string | null }>;
}
const rows = async () => (await pool.query("SELECT * FROM sms_sends ORDER BY created_at, id")).rows;

describe("journal des envois (sms_sends)", () => {
  test("succès : une ligne accepted, ni texte ni numéro en clair, empreinte HMAC et deux derniers chiffres", async () => {
    const result = await makeSender().send(request1());
    assert.deepEqual(result, { status: "accepted", errorCode: null, httpStatus: 202, providerId: "msg_000001", attempts: 1, skipped: false });
    const [row] = await rows();
    assert.equal(row.purpose, "otp");
    assert.equal(row.reference, request1().reference);
    assert.equal(row.idempotency_key, OTP_KEY);
    assert.equal(row.status, "accepted");
    assert.equal(row.http_status, 202);
    assert.equal(row.error_code, null);
    assert.equal(row.provider_id, "msg_000001");
    assert.equal(row.attempts, 1);
    assert.equal(row.phone_last2, "12");
    assert.equal(row.phone_hash, phoneHash(SECRET, TO));
    assert.match(row.phone_hash, /^[0-9a-f]{64}$/);
    assert.notEqual(phoneHash(SECRET, TO), phoneHash(randomBytes(32), TO), "l'empreinte dépend du secret");
    const dump = JSON.stringify(row);
    for (const secret of [TO, TO.slice(1), "0712345612", CONTENT, "654321", "votre code", KEY]) assert.equal(dump.includes(secret), false, `la ligne contient « ${secret} »`);
    // Aucune colonne ne peut porter le texte ou le numéro : le schéma n'en a pas.
    const columns = (await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'sms_sends' AND table_schema = current_schema() ORDER BY column_name")).rows.map((r) => r.column_name);
    assert.deepEqual(columns, ["attempts", "audience", "created_at", "error_code", "http_status", "id", "idempotency_key", "phone_hash", "phone_last2", "provider_id", "purpose", "reference", "status", "updated_at"]);
  });

  test("la clé d'idempotence est UNIQUE et les contraintes de la table tiennent", async () => {
    await makeSender().send(request1());
    await assert.rejects(pool.query("INSERT INTO sms_sends (purpose, reference, idempotency_key, phone_hash, phone_last2) VALUES ('otp','x',$1,$2,'12')", [OTP_KEY, "a".repeat(64)]), /uq_sms_sends_idempotency/);
    const insert = (purpose: string, key: string, hash: string, last2: string, status = "pending") =>
      pool.query("INSERT INTO sms_sends (purpose, reference, idempotency_key, phone_hash, phone_last2, status) VALUES ($1,'ref',$2,$3,$4,$5)", [purpose, key, hash, last2, status]);
    await assert.rejects(insert("autre", "key-valide-0001", "a".repeat(64), "12"), /sms_sends_purpose_check/);
    await assert.rejects(insert("otp", "court", "a".repeat(64), "12"), /sms_sends_idempotency_key_check/);
    await assert.rejects(insert("otp", "key-valide-0002", "zz", "12"), /sms_sends_phone_hash_check/);
    await assert.rejects(insert("otp", "key-valide-0003", "a".repeat(64), "123"), /sms_sends_phone_last2_check/);
    await assert.rejects(insert("otp", "key-valide-0004", "a".repeat(64), "12", "delivered"), /sms_sends_status_check/);
    await assert.rejects(insert("otp", "key-valide-0005", "a".repeat(64), "12", "accepted"), /chk_sms_sends_accepted_http/);
  });

  test("même clé rejouée : AUCUN nouvel appel, le résultat connu est rendu", async () => {
    const sender = makeSender();
    await sender.send(request1());
    const again = await sender.send(request1());
    assert.equal(again.status, "accepted");
    assert.equal(again.skipped, true);
    assert.equal(again.providerId, "msg_000001");
    assert.equal(fake.sendRequests().length, 1);
    assert.equal((await rows()).length, 1);
  });

  test("503 : incertain, jamais renvoyé automatiquement même en rappelant avec la même clé ; une seule requête au fournisseur", async () => {
    fake.queue({ kind: "status", status: 503, body: { id: "msg_unsure", status: "unknown" } });
    const sender = makeSender();
    const first = await sender.send(request1());
    assert.deepEqual({ status: first.status, errorCode: first.errorCode, httpStatus: first.httpStatus, providerId: first.providerId }, { status: "uncertain", errorCode: "provider_unavailable", httpStatus: 503, providerId: "msg_unsure" });
    for (let call = 0; call < 3; call += 1) {
      const again = await sender.send(request1());
      assert.equal(again.status, "uncertain");
      assert.equal(again.skipped, true);
      assert.equal(again.providerId, "msg_unsure");
    }
    assert.equal(fake.sendRequests().length, 1, "aucune reprise automatique");
    const [row] = await rows();
    assert.equal(row.status, "uncertain", "jamais marqué accepté");
    assert.equal(row.provider_id, "msg_unsure");
    assert.deepEqual(waits, []);
  });

  test("statuts unknown et reserved : incertains avec identifiant gardé, jamais acceptés", async () => {
    for (const [index, reported] of ["unknown", "reserved"].entries()) {
      fake.queue({ kind: "reply-status", reportedStatus: reported });
      const key = `otp-status-${reported}-000${index}`;
      const result = await makeSender().send(request1({ idempotencyKey: key, reference: key }));
      assert.equal(result.status, "uncertain", reported);
      assert.equal(result.errorCode, `provider_${reported}`);
      assert.equal((await pool.query("SELECT status, provider_id FROM sms_sends WHERE idempotency_key = $1", [key])).rows[0].status, "uncertain");
    }
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM sms_sends WHERE status = 'accepted'")).rows[0].n, 0);
  });

  test("401, 409, 422, 502 : rejected, définitifs, jamais rappelés avec la même clé", async () => {
    for (const status of [401, 409, 422, 502]) {
      fake.reset();
      fake.queue({ kind: "status", status });
      const key = `otp-reject-${status}-0001`;
      const sender = makeSender();
      assert.equal((await sender.send(request1({ idempotencyKey: key, reference: key }))).status, "rejected", String(status));
      const again = await sender.send(request1({ idempotencyKey: key, reference: key }));
      assert.equal(again.status, "rejected");
      assert.equal(again.skipped, true);
      assert.equal(fake.sendRequests().length, 1, `${status} : une requête, jamais de boucle`);
      assert.equal((await pool.query("SELECT status, http_status FROM sms_sends WHERE idempotency_key = $1", [key])).rows[0].http_status, status);
    }
  });

  test("échec « failed » (429 épuisé) : la même clé peut être réessayée, sans second message", async () => {
    fake.queue(...Array.from({ length: 4 }, () => ({ kind: "status" as const, status: 429, headers: { "retry-after": "1" } })));
    const sender = makeSender();
    const first = await sender.send(request1());
    assert.deepEqual({ status: first.status, errorCode: first.errorCode, attempts: first.attempts }, { status: "failed", errorCode: "rate_limited", attempts: 4 });
    assert.equal((await rows())[0].status, "failed");
    const retry = await sender.send(request1());
    assert.equal(retry.status, "accepted");
    assert.equal(retry.skipped, false);
    const [row] = await rows();
    assert.equal(row.status, "accepted");
    assert.equal(row.attempts, 5, "requêtes cumulées");
    assert.equal(row.idempotency_key, OTP_KEY, "la clé n'a jamais changé");
    assert.equal(new Set(fake.sendRequests().map((r) => r.headers["idempotency-key"])).size, 1);
    assert.equal(fake.messages.length, 1);
  });

  test("coupure puis reprise dans l'envoi : même clé à chaque requête, un seul message, attempts compté", async () => {
    fake.queue({ kind: "drop" }, { kind: "drop" });
    const result = await makeSender().send(request1());
    assert.equal(result.status, "accepted");
    assert.equal(result.attempts, 3);
    assert.equal(fake.messages.length, 1);
    assert.deepEqual([...new Set(fake.sendRequests().map((r) => r.headers["idempotency-key"]))], [OTP_KEY]);
    assert.equal((await rows())[0].attempts, 3);
  });

  test("envoi interrompu (ligne pending ancienne) : devient incertain, sans appel ; pending récent : en cours, sans appel", async () => {
    const sender = makeSender();
    const base = { purpose: "otp" as const, reference: "ref", idempotencyKey: OTP_KEY, phoneHash: phoneHash(SECRET, TO), phoneLast2: "12", budget: planBudgets(100) };
    const t0 = new Date(clock.getTime() - 10 * 60_000);
    await reserveSend(pool, { ...base, now: t0, dayStart: utcDayStart(t0) });
    const stale = await sender.send(request1());
    assert.deepEqual({ status: stale.status, errorCode: stale.errorCode, skipped: stale.skipped }, { status: "uncertain", errorCode: "interrupted", skipped: true });
    assert.equal((await rows())[0].status, "uncertain");
    await pool.query("TRUNCATE sms_sends");
    await reserveSend(pool, { ...base, now: clock, dayStart: utcDayStart(clock) });
    const fresh = await sender.send(request1());
    assert.deepEqual({ status: fresh.status, errorCode: fresh.errorCode, skipped: fresh.skipped }, { status: "uncertain", errorCode: "in_flight", skipped: true });
    assert.equal((await rows())[0].status, "pending", "une ligne récente n'est pas touchée");
    assert.equal(fake.requests.length, 0);
  });

  test("journal : seules les lignes failed se reprennent (par reserveSend, sous contrôle de budget) ; un statut final n'est jamais écrasé ; seules les lignes pending anciennes deviennent incertaines", async () => {
    const reserve = (key: string, now: Date = clock) => reserveSend(pool, { purpose: "otp", reference: "ref", idempotencyKey: key, phoneHash: phoneHash(SECRET, TO), phoneLast2: "12", now, budget: planBudgets(100), dayStart: utcDayStart(now) });
    const status = async (key: string) => (await pool.query("SELECT status FROM sms_sends WHERE idempotency_key = $1", [key])).rows[0].status as string;
    const outcome = (state: "accepted" | "uncertain" | "rejected" | "failed") => ({ status: state, httpStatus: state === "accepted" ? 202 : null, errorCode: null, providerId: null, attempts: 1 });
    for (const final of ["uncertain", "accepted", "rejected"] as const) {
      const key = `otp-journal-${final}-001`;
      const reservation = await reserve(key);
      assert.equal(reservation.kind, "new");
      const id = (reservation as { id: string }).id;
      assert.equal(await finishSend(pool, id, outcome(final), clock), true);
      const again = await reserve(key);
      assert.equal(again.kind, "existing", `${final} ne se reprend jamais`);
      assert.equal((again as { row: { status: string } }).row.status, final);
      assert.equal(await finishSend(pool, id, outcome("failed"), clock), false, `${final} n'est pas écrasé`);
      assert.equal(await markInterrupted(pool, id, new Date(clock.getTime() + 3_600_000), clock), false, `${final} n'est pas touché par l'interruption`);
      assert.equal(await status(key), final);
    }
    const reservation = await reserve("otp-journal-failed-001");
    const id = (reservation as { id: string }).id;
    await finishSend(pool, id, { ...outcome("failed"), errorCode: "rate_limited", httpStatus: 429 }, clock);
    const resumed = await reserve("otp-journal-failed-001");
    assert.deepEqual(resumed, { kind: "new", id }, "failed se reprend : même ligne");
    assert.equal(await status("otp-journal-failed-001"), "pending");
    const row = (await rows()).find((r) => r.id === id);
    assert.deepEqual({ error_code: row.error_code, http_status: row.http_status }, { error_code: null, http_status: null }, "la reprise efface l'échec précédent");
    assert.equal((await reserve("otp-journal-failed-001")).kind, "existing", "une seule reprise gagne : la ligne est maintenant en cours");
  });

  test("même clé pour un autre destinataire : refusé chez nous (idempotency_conflict), aucune requête", async () => {
    const sender = makeSender();
    await sender.send(request1());
    fake.requests.length = 0;
    const clash = await sender.send(request1({ to: "+2250799999999" }));
    assert.deepEqual({ status: clash.status, errorCode: clash.errorCode, skipped: clash.skipped }, { status: "rejected", errorCode: "idempotency_conflict", skipped: true });
    assert.equal(fake.requests.length, 0);
    assert.equal((await rows())[0].status, "accepted", "la ligne d'origine n'est pas modifiée");
  });

  test("contrôles locaux : pays, segment, clé → failed sans ligne ni requête", async () => {
    const sender = makeSender();
    for (const [change, code] of [
      [{ to: "+33612345678" }, "invalid_recipient"],
      [{ content: "a".repeat(161) }, "invalid_content"],
      [{ content: "â".repeat(71) }, "invalid_content"],
      [{ idempotencyKey: "court" }, "invalid_key"],
    ] as Array<[Partial<SmsSendRequest>, string]>) {
      const result = await sender.send(request1(change));
      assert.deepEqual({ status: result.status, errorCode: result.errorCode, attempts: result.attempts }, { status: "failed", errorCode: code, attempts: 0 });
    }
    assert.equal(fake.requests.length, 0);
    assert.equal((await rows()).length, 0, "un refus local ne laisse aucune ligne");
  });

  test("plafond total du jour : au-delà, failed budget_total sans requête ni ligne ; une clé déjà connue reste rejouable ; le lendemain le compteur repart de zéro", async () => {
    const sender = makeSender({ budget: { total: 2, notifications: 0, codes: 2, existingReserve: 0, newNumbers: 2, newNumbersPerHour: 2 } });
    for (const n of [1, 2]) assert.equal((await sender.send(request1({ idempotencyKey: `otp-cap-000${n}`, reference: `cap${n}` }))).status, "accepted");
    fake.requests.length = 0;
    const third = await sender.send(request1({ idempotencyKey: "otp-cap-0003", reference: "cap3" }));
    assert.deepEqual({ status: third.status, errorCode: third.errorCode, attempts: third.attempts, scope: third.budgetScope }, { status: "failed", errorCode: "budget_total", attempts: 0, scope: "total" });
    assert.equal(fake.requests.length, 0);
    assert.equal((await rows()).length, 2);
    const replay = await sender.send(request1({ idempotencyKey: "otp-cap-0001", reference: "cap1" }));
    assert.equal(replay.status, "accepted");
    assert.equal(replay.skipped, true);
    // Le lendemain (jour UTC suivant), le compteur repart de zéro.
    clock = new Date(clock.getTime() + 24 * 3_600_000);
    assert.equal((await sender.send(request1({ idempotencyKey: "otp-cap-0003", reference: "cap3" }))).status, "accepted");
  });

  test("journal indisponible ou secret absent : AUCUN appel au fournisseur", async () => {
    const broken = { query: async () => { throw new Error("base hors service"); } } as unknown as Pool;
    const result = await makeSender({ poolOf: () => broken }).send(request1());
    assert.deepEqual({ status: result.status, errorCode: result.errorCode }, { status: "failed", errorCode: "journal_unavailable" });
    const noSecret = await makeSender({ secret: () => { throw new Error("secret absent"); } }).send(request1({ idempotencyKey: "otp-nosecret-1" }));
    assert.equal(noSecret.errorCode, "journal_unavailable");
    assert.equal(fake.requests.length, 0);
    assert.equal((await rows()).length, 0);
  });

  test("exception inattendue du client : incertain (jamais accepté, jamais rejoué avec une autre clé)", async () => {
    const sender = createSmsSender({ client: { send: async () => { throw new Error("défaut interne"); } }, pool: () => pool, phoneSecret: () => SECRET, dailyCap: 10, log: () => {} });
    const result = await sender.send(request1());
    assert.deepEqual({ status: result.status, errorCode: result.errorCode }, { status: "uncertain", errorCode: "client_error" });
    assert.equal((await rows())[0].status, "uncertain");
  });

  test("rien de secret dans les journaux ni dans la console : ni clé du fournisseur, ni texte, ni code, ni numéro entier, ni clé d'idempotence", async () => {
    const captured: string[] = [];
    const originals = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug };
    for (const name of Object.keys(originals) as Array<keyof typeof originals>) console[name] = (...args: unknown[]) => void captured.push(args.map(String).join(" "));
    try {
      const sender = createSmsSender({
        client: createMenoClient({ apiKey: KEY, baseUrl: fake.baseUrl, attemptTimeoutMs: 300, sleep: async () => {} }),
        pool: () => pool,
        phoneSecret: () => SECRET,
        dailyCap: 100,
      });
      fake.queue({ kind: "status", status: 503, body: { error: `${CONTENT} ${TO} ${KEY}` } });
      await sender.send(request1({ idempotencyKey: "otp-leak-test-01", reference: "leak1" }));
      await sender.send(request1({ idempotencyKey: "otp-leak-test-02", reference: "leak2" }));
      fake.queue({ kind: "status", status: 422 });
      await sender.send(request1({ idempotencyKey: "otp-leak-test-03", reference: "leak3" }));
      await sender.send(request1({ to: "+33612345678", idempotencyKey: "otp-leak-test-04" }));
    } finally {
      Object.assign(console, originals);
    }
    const everything = [...captured, ...logs].join("\n");
    assert.ok(captured.length >= 4, "le journal par défaut écrit bien une ligne par envoi");
    for (const secret of [KEY, CONTENT, "654321", "votre code", TO, TO.slice(1), "0712345612", "2250712345612", "otp-leak-test", "33612345678"]) {
      assert.equal(everything.includes(secret), false, `fuite de « ${secret} »`);
    }
    assert.match(captured.join("\n"), /\+\*+12/, "seuls les deux derniers chiffres");
  });
});

describe("administration des SMS (/api/admin/sms)", () => {
  test("un non-administrateur obtient la MÊME réponse 404 « Ressource introuvable » (corps et en-têtes identiques) : visiteur, compte ordinaire, session invalide ; un administrateur suspendu perd l'accès", async () => {
    const boss = await login(pool);
    const ordinary = await login(pool);
    await grantAdmin({ pool, phone: boss.phone });
    const handlers = createAdminSmsHttpHandlers({ pool, env: {}, log: () => {}, usageCache: createUsageCache({ fetchUsage: null }) });
    const get = (cookie: string | null) => handlers.overview(request("GET", "/api/admin/sms", { cookie })).then(reply);
    const refused = [await get(null), await get(ordinary.cookie), await get("noma_auth=invalide")];
    for (const answer of refused) {
      assert.equal(answer.status, 404);
      assert.deepEqual(answer.json, NOT_FOUND);
      assert.equal(answer.text, refused[0].text);
    }
    assert.equal((await get(boss.cookie)).status, 200);
    await pool.query("UPDATE users SET status = 'suspended' WHERE id = $1", [boss.userId]);
    assert.equal((await get(boss.cookie)).status, 404, "un administrateur suspendu perd l'accès");
    await pool.query("UPDATE users SET status = 'active' WHERE id = $1", [boss.userId]);
  });

  test("lecture : consommation du fournisseur (cache 60 s), décompte local, envois incertains avec deux derniers chiffres seulement", async () => {
    const boss = await login(pool);
    await grantAdmin({ pool, phone: boss.phone });
    const sender = makeSender();
    fake.queue({ kind: "status", status: 503, body: { id: "msg_unsure_9", status: "unknown" } });
    await sender.send(request1({ idempotencyKey: "otp-admin-0001", reference: "a1", to: "+2250711111177" }));
    await sender.send(request1({ idempotencyKey: "otp-admin-0002", reference: "a2", to: "+2250722222288" }));
    fake.queue({ kind: "status", status: 422 });
    await sender.send(request1({ idempotencyKey: "otp-admin-0003", reference: "a3", to: "+2250733333399" }));
    // Un envoi resté « pending » depuis longtemps apparaît aussi (processus mort pendant l'appel).
    const old = new Date(clock.getTime() - 10 * 60_000);
    await pool.query(
      "INSERT INTO sms_sends (purpose, reference, idempotency_key, phone_hash, phone_last2, status, created_at, updated_at) VALUES ('notification','n1','notif-admin-0001',$1,'55','pending',$2,$2)",
      [phoneHash(SECRET, "+2250744444455"), old],
    );
    const env2 = { NOMA_SMS_PROVIDER: "meno", NOMA_SMS_API_KEY: KEY, NOMA_SMS_BASE_URL: fake.baseUrl, NODE_ENV: "test" };
    const client = createMenoClient({ apiKey: KEY, baseUrl: fake.baseUrl, attemptTimeoutMs: 300 });
    const usageCache = createUsageCache({ fetchUsage: () => client.usage() });
    const handlers = createAdminSmsHttpHandlers({ pool, env: env2, log: () => {}, usageCache, now: () => clock });
    const first = await handlers.overview(request("GET", "/api/admin/sms", { cookie: boss.cookie })).then(reply);
    await handlers.overview(request("GET", "/api/admin/sms", { cookie: boss.cookie }));
    assert.equal(first.status, 200);
    assert.equal(first.headers.get("cache-control"), "no-store");
    const body = first.json as AdminBody;
    assert.equal(body.contractVersion, "admin-sms/v1");
    assert.deepEqual(body.provider, { mode: "meno", active: true, unitPriceXof: 15 });
    assert.equal(body.usage?.accepted, 12);
    assert.equal(body.usage?.acceptedAmountXof, 180);
    assert.equal(body.usageError, null);
    assert.equal(fake.usageRequests().length, 1, "deux lectures de la page, une requête au fournisseur (cache de 60 s)");
    assert.deepEqual(body.local, { month: `${clock.getUTCFullYear()}-${String(clock.getUTCMonth() + 1).padStart(2, "0")}`, accepted: 1, uncertain: 1, rejected: 1, failed: 0, pending: 1 });
    const uncertain = body.uncertain;
    assert.equal(uncertain.length, 2, "un incertain et un envoi interrompu ; ni l'accepté ni le refusé");
    assert.deepEqual(uncertain.map((row) => row.maskedPhone).sort(), [`+${"•".repeat(11)}55`, `+${"•".repeat(11)}77`]);
    assert.deepEqual(uncertain.map((row) => row.status).sort(), ["pending", "uncertain"]);
    assert.equal(uncertain.find((row) => row.status === "uncertain")?.providerId, "msg_unsure_9");
    const text = first.text;
    for (const secret of ["0711111177", "2250711111177", "0722222288", "0744444455", KEY, CONTENT, "654321", "otp-admin-0001"]) assert.equal(text.includes(secret), false, secret);
  });

  test("route en lecture seule : aucune écriture, paramètre inattendu refusé ; fournisseur inactif ou en panne : code stable, jamais le détail", async () => {
    const boss = await login(pool);
    await grantAdmin({ pool, phone: boss.phone });
    const before = (await pool.query("SELECT count(*)::int AS n FROM sms_sends")).rows[0].n;
    const down = createAdminSmsHttpHandlers({ pool, env: {}, log: () => {}, usageCache: createUsageCache({ fetchUsage: async () => { throw new Error(`détail secret ${KEY}`); } }) });
    const answer = await down.overview(request("GET", "/api/admin/sms", { cookie: boss.cookie })).then(reply);
    assert.equal(answer.status, 200);
    assert.deepEqual({ usage: (answer.json as AdminBody).usage, usageError: (answer.json as AdminBody).usageError }, { usage: null, usageError: "usage_unreachable" });
    assert.equal(answer.text.includes("détail secret"), false);
    assert.equal(answer.text.includes(KEY), false);
    const inactive = createAdminSmsHttpHandlers({ pool, env: {}, log: () => {}, usageCache: createUsageCache({ fetchUsage: null }) });
    const idle = await inactive.overview(request("GET", "/api/admin/sms", { cookie: boss.cookie })).then(reply);
    assert.deepEqual((idle.json as AdminBody).provider, { mode: "none", active: false, unitPriceXof: 15 });
    assert.equal((idle.json as AdminBody).usageError, "provider_inactive");
    assert.equal((await inactive.overview(request("GET", "/api/admin/sms", { cookie: boss.cookie, query: "?debug=1" })).then(reply)).status, 400);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM sms_sends")).rows[0].n, before);
  });
});
