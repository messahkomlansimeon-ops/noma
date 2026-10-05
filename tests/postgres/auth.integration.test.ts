import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, describe, test } from "node:test";
import type { Pool } from "pg";
import {
  AuthConfigurationError,
  OtpDeliveryError,
  OtpRateLimitError,
  OtpResendDelayError,
  OtpVerificationError,
  requestOtp,
  resolveSession,
  revokeSession,
  verifyOtp,
  type SendOtpInput,
} from "../../lib/server/auth";
import { archiveUser, updateUser } from "../../lib/server/catalog";
import { runMigrations } from "../../lib/server/postgres/migrations";
import {
  createTemporarySchemaName,
  openVerifiedIsolatedPool,
  openVerifiedTestDatabase,
  quoteTemporarySchema,
  requireDedicatedTestDatabase,
  type DedicatedTestDatabase,
} from "./test-database";

class TestClock {
  constructor(private timestamp: number) {}

  readonly now = (): Date => new Date(this.timestamp);

  advance(milliseconds: number): void {
    this.timestamp += milliseconds;
  }
}

const SECRET = randomBytes(32);
const MINUTE = 60 * 1_000;
const DAY = 24 * 60 * MINUTE;
let phoneSequence = 0;

function uniquePhone(): string {
  phoneSequence += 1;
  return `+22501${phoneSequence.toString().padStart(8, "0")}`;
}

function wrongCode(code: string): string {
  return code === "000000" ? "999999" : "000000";
}

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  description: string,
): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (await predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail(`attente PostgreSQL non observee : ${description}`);
}

async function poolBackendPid(pool: Pool): Promise<number> {
  const result = await pool.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
  return result.rows[0].pid;
}

async function waitForRowLock(adminPool: Pool, pid: number): Promise<void> {
  await waitUntil(async () => {
    const result = await adminPool.query<{ wait_event_type: string | null }>(
      "SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1",
      [pid],
    );
    return result.rows[0]?.wait_event_type === "Lock";
  }, `verrou de ligne du backend ${pid}`);
}

async function issueOtp(
  pool: Pool,
  phone: string,
  requestIp: string,
  clock: TestClock,
): Promise<{ challengeId: string; code: string; sessionExpiry: Date }> {
  let captured: SendOtpInput | undefined;
  const result = await requestOtp(phone, {
    pool,
    requestIp,
    now: clock.now,
    authSecret: SECRET,
    sendOtp: async (input) => {
      captured = input;
    },
  });
  assert.ok(captured, "le faux transport de test doit capturer le code");
  assert.equal(result.challengeId, captured.challengeId);
  return {
    challengeId: result.challengeId,
    code: captured.code,
    sessionExpiry: captured.expiresAt,
  };
}

const configuredUrl = process.env.TEST_DATABASE_URL;
let configuredUrlError: unknown;
if (configuredUrl?.trim()) {
  try {
    requireDedicatedTestDatabase(configuredUrl);
  } catch (error) {
    configuredUrlError = error;
  }
}

if (!configuredUrl?.trim()) {
  test("pré-requis PostgreSQL dédié pour l'authentification", () => {
    assert.fail(
      "TEST_DATABASE_URL requis : aucun test d'authentification PostgreSQL n'a été simulé.",
    );
  });
} else if (configuredUrlError) {
  test("pré-requis TEST_DATABASE_URL sûr pour l'authentification", () => {
    throw configuredUrlError;
  });
} else {
  describe("authentification téléphone et sessions persistantes", () => {
    const schema = createTemporarySchemaName();
    const quotedSchema = quoteTemporarySchema(schema);
    let target: DedicatedTestDatabase;
    let adminPool: Pool;
    let pool: Pool;
    let schemaCleaned = false;

    const extraPools = async (count: number): Promise<Pool[]> =>
      Promise.all(Array.from({ length: count }, () => openVerifiedIsolatedPool(target, schema)));

    before(async () => {
      const opened = await openVerifiedTestDatabase(configuredUrl);
      target = opened.target;
      adminPool = opened.pool;
      await adminPool.query(`CREATE SCHEMA ${quotedSchema}`);
      pool = await openVerifiedIsolatedPool(target, schema);
      const migrations = await runMigrations(pool);
      assert.deepEqual(migrations.applied, [
        "0001_users_offers_demands",
        "0002_phone_otp_sessions",
        "0003_catalog_extraction_proposals",
        "0004_catalog_extraction_proposal_json_constraints",
        "0005_catalog_extraction_applications",
        "0006_matching_evaluations",
        "0007_matching_outbox_events",
        "0008_matching_jobs",
        "0009_matching_projection",
        "0010_matching_job_leases",
        "0011_offer_boosts",
      ]);
    });

    after(async () => {
      if (pool) await pool.end();
      if (adminPool) {
        if (!schemaCleaned) {
          await adminPool.query(`DROP SCHEMA IF EXISTS ${quotedSchema} CASCADE`);
        }
        await adminPool.end();
      }
    });

    test("création puis reconnexion : même utilisateur, nouveau jeton, aucun secret brut", async () => {
      const phone = uniquePhone();
      const clock = new TestClock(Date.UTC(2030, 0, 1, 8));
      const first = await issueOtp(pool, phone, "198.51.100.1", clock);
      const firstLogin = await verifyOtp(first.challengeId, first.code, {
        pool,
        now: clock.now,
        authSecret: SECRET,
      });
      const resolved = await resolveSession(firstLogin.sessionToken, { pool, now: clock.now });
      assert.equal(resolved?.userId, firstLogin.userId);
      assert.equal(Object.hasOwn(resolved ?? {}, "role"), false);

      clock.advance(MINUTE + 1);
      const second = await issueOtp(pool, phone, "198.51.100.1", clock);
      const secondLogin = await verifyOtp(second.challengeId, second.code, {
        pool,
        now: clock.now,
        authSecret: SECRET,
      });
      assert.equal(secondLogin.userId, firstLogin.userId);
      assert.notEqual(secondLogin.sessionToken, firstLogin.sessionToken);

      const identities = await pool.query(
        "SELECT user_id FROM phone_identities WHERE phone_e164 = $1",
        [phone],
      );
      assert.equal(identities.rowCount, 1);
      const challenges = await pool.query<{ otp_hmac: string }>(
        "SELECT otp_hmac FROM otp_challenges WHERE id = ANY($1::uuid[]) ORDER BY id",
        [[first.challengeId, second.challengeId]],
      );
      assert.equal(challenges.rowCount, 2);
      assert.ok(challenges.rows.every((row) => /^[0-9a-f]{64}$/.test(row.otp_hmac)));
      assert.ok(challenges.rows.every((row) => row.otp_hmac !== first.code && row.otp_hmac !== second.code));
      const sessions = await pool.query<{ token_sha256: string }>(
        "SELECT token_sha256 FROM auth_sessions WHERE user_id = $1",
        [firstLogin.userId],
      );
      assert.equal(sessions.rowCount, 2);
      assert.ok(sessions.rows.every((row) => /^[0-9a-f]{64}$/.test(row.token_sha256)));
      assert.ok(
        sessions.rows.every(
          (row) => row.token_sha256 !== firstLogin.sessionToken &&
            row.token_sha256 !== secondLogin.sessionToken,
        ),
      );
    });

    test("mauvais codes persistés, cinq essais maximum et expiration", async () => {
      const clock = new TestClock(Date.UTC(2030, 0, 2, 8));
      const phone = uniquePhone();
      const challenge = await issueOtp(pool, phone, "198.51.100.2", clock);
      await assert.rejects(
        verifyOtp(challenge.challengeId, wrongCode(challenge.code), {
          pool,
          now: clock.now,
          authSecret: SECRET,
        }),
        OtpVerificationError,
      );
      await assert.rejects(
        verifyOtp(challenge.challengeId, wrongCode(challenge.code), {
          pool,
          now: clock.now,
          authSecret: SECRET,
        }),
        OtpVerificationError,
      );
      const attempts = await pool.query<{ failed_attempts: number }>(
        "SELECT failed_attempts FROM otp_challenges WHERE id = $1",
        [challenge.challengeId],
      );
      assert.equal(attempts.rows[0].failed_attempts, 2);
      await verifyOtp(challenge.challengeId, challenge.code, {
        pool,
        now: clock.now,
        authSecret: SECRET,
      });

      const usersBeforeExpiry = await pool.query("SELECT id FROM users");
      const expiringPhone = uniquePhone();
      const expiring = await issueOtp(pool, expiringPhone, "198.51.100.3", clock);
      clock.advance(5 * MINUTE + 1);
      await assert.rejects(
        verifyOtp(expiring.challengeId, expiring.code, {
          pool,
          now: clock.now,
          authSecret: SECRET,
        }),
        OtpVerificationError,
      );
      const expired = await pool.query<{ status: string }>(
        "SELECT status FROM otp_challenges WHERE id = $1",
        [expiring.challengeId],
      );
      assert.equal(expired.rows[0].status, "expired");
      assert.equal((await pool.query("SELECT id FROM users")).rowCount, usersBeforeExpiry.rowCount);

      const lockedPhone = uniquePhone();
      const locked = await issueOtp(pool, lockedPhone, "198.51.100.4", clock);
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await assert.rejects(
          verifyOtp(locked.challengeId, wrongCode(locked.code), {
            pool,
            now: clock.now,
            authSecret: SECRET,
          }),
          OtpVerificationError,
        );
      }
      const lockedRow = await pool.query<{ status: string; failed_attempts: number }>(
        "SELECT status, failed_attempts FROM otp_challenges WHERE id = $1",
        [locked.challengeId],
      );
      assert.deepEqual(lockedRow.rows[0], { status: "locked", failed_attempts: 5 });
      await assert.rejects(
        verifyOtp(locked.challengeId, locked.code, {
          pool,
          now: clock.now,
          authSecret: SECRET,
        }),
        OtpVerificationError,
      );
    });

    test("renvoi, demandes concurrentes et quotas atomiques", async () => {
      const clock = new TestClock(Date.UTC(2030, 0, 3, 9));
      const phone = uniquePhone();
      let sends = 0;
      const sendOtp = async (): Promise<void> => {
        sends += 1;
      };
      await requestOtp(phone, {
        pool,
        requestIp: "198.51.100.5",
        now: clock.now,
        authSecret: SECRET,
        sendOtp,
      });
      await assert.rejects(
        requestOtp(phone, {
          pool,
          requestIp: "198.51.100.5",
          now: clock.now,
          authSecret: SECRET,
          sendOtp,
        }),
        OtpResendDelayError,
      );
      clock.advance(MINUTE + 1);
      await requestOtp(phone, {
        pool,
        requestIp: "198.51.100.5",
        now: clock.now,
        authSecret: SECRET,
        sendOtp,
      });
      clock.advance(MINUTE + 1);
      await requestOtp(phone, {
        pool,
        requestIp: "198.51.100.5",
        now: clock.now,
        authSecret: SECRET,
        sendOtp,
      });
      clock.advance(MINUTE + 1);
      await assert.rejects(
        requestOtp(phone, {
          pool,
          requestIp: "198.51.100.5",
          now: clock.now,
          authSecret: SECRET,
          sendOtp,
        }),
        OtpRateLimitError,
      );
      assert.equal(sends, 3);

      const concurrentPools = await extraPools(5);
      try {
        const sharedIp = "198.51.100.200";
        const concurrentClock = new TestClock(Date.UTC(2030, 0, 4, 10));
        let concurrentSends = 0;
        const requests = Array.from({ length: 21 }, (_, index) =>
          requestOtp(uniquePhone(), {
            pool: concurrentPools[index % concurrentPools.length],
            requestIp: sharedIp,
            now: concurrentClock.now,
            authSecret: SECRET,
            sendOtp: async () => {
              concurrentSends += 1;
            },
          }),
        );
        const outcomes = await Promise.allSettled(requests);
        assert.equal(outcomes.filter((result) => result.status === "fulfilled").length, 20);
        assert.equal(
          outcomes.filter(
            (result) => result.status === "rejected" && result.reason instanceof OtpRateLimitError,
          ).length,
          1,
        );
        assert.equal(concurrentSends, 20);
        const counter = await pool.query<{ request_count: number }>(
          `SELECT request_count
             FROM otp_rate_limit_counters
            WHERE dimension = 'ip' AND window_kind = '15m'
            ORDER BY updated_at DESC
            LIMIT 1`,
        );
        assert.equal(counter.rows[0].request_count, 20);
      } finally {
        await Promise.all(concurrentPools.map((candidate) => candidate.end()));
      }

      const samePhonePools = await extraPools(2);
      try {
        const concurrentPhone = uniquePhone();
        const samePhoneClock = new TestClock(Date.UTC(2030, 0, 5, 10));
        const outcomes = await Promise.allSettled(
          samePhonePools.map((candidate) => requestOtp(concurrentPhone, {
            pool: candidate,
            requestIp: "198.51.100.201",
            now: samePhoneClock.now,
            authSecret: SECRET,
            sendOtp,
          })),
        );
        assert.equal(outcomes.filter((result) => result.status === "fulfilled").length, 1);
        assert.equal(
          outcomes.filter(
            (result) => result.status === "rejected" && result.reason instanceof OtpResendDelayError,
          ).length,
          1,
        );
      } finally {
        await Promise.all(samePhonePools.map((candidate) => candidate.end()));
      }

      const dailyClock = new TestClock(Date.UTC(2030, 0, 15, 1));
      const dailyPhone = uniquePhone();
      const dailyIp = "198.51.100.202";
      await requestOtp(dailyPhone, {
        pool,
        requestIp: dailyIp,
        now: dailyClock.now,
        authSecret: SECRET,
        sendOtp,
      });
      const phoneDay = await pool.query<{ subject_fingerprint: string; window_start: Date }>(
        `SELECT subject_fingerprint, window_start
           FROM otp_rate_limit_counters
          WHERE dimension = 'phone' AND window_kind = 'day'
          ORDER BY updated_at DESC
          LIMIT 1`,
      );
      await pool.query(
        `UPDATE otp_rate_limit_counters SET request_count = 10
          WHERE dimension = 'phone' AND subject_fingerprint = $1
            AND window_kind = 'day' AND window_start = $2`,
        [phoneDay.rows[0].subject_fingerprint, phoneDay.rows[0].window_start],
      );
      dailyClock.advance(MINUTE + 1);
      await assert.rejects(
        requestOtp(dailyPhone, {
          pool,
          requestIp: dailyIp,
          now: dailyClock.now,
          authSecret: SECRET,
          sendOtp,
        }),
        OtpRateLimitError,
      );

      const ipDay = await pool.query<{ subject_fingerprint: string; window_start: Date }>(
        `SELECT subject_fingerprint, window_start
           FROM otp_rate_limit_counters
          WHERE dimension = 'ip' AND window_kind = 'day'
          ORDER BY updated_at DESC
          LIMIT 1`,
      );
      await pool.query(
        `UPDATE otp_rate_limit_counters SET request_count = 100
          WHERE dimension = 'ip' AND subject_fingerprint = $1
            AND window_kind = 'day' AND window_start = $2`,
        [ipDay.rows[0].subject_fingerprint, ipDay.rows[0].window_start],
      );
      await assert.rejects(
        requestOtp(uniquePhone(), {
          pool,
          requestIp: dailyIp,
          now: dailyClock.now,
          authSecret: SECRET,
          sendOtp,
        }),
        OtpRateLimitError,
      );
    });

    test("panne, timeout et réponse tardive ne rendent aucun code vérifiable", async () => {
      const clock = new TestClock(Date.UTC(2030, 0, 6, 10));
      const failedPhone = uniquePhone();
      await assert.rejects(
        requestOtp(failedPhone, {
          pool,
          requestIp: "198.51.100.6",
          now: clock.now,
          authSecret: SECRET,
          sendOtp: async () => {
            throw new Error("panne fournisseur non exposée");
          },
        }),
        OtpDeliveryError,
      );
      assert.equal(
        (await pool.query<{ status: string }>(
          "SELECT status FROM otp_challenges WHERE phone_e164 = $1",
          [failedPhone],
        )).rows[0].status,
        "send_failed",
      );

      const timeoutPhone = uniquePhone();
      let releaseLate!: () => void;
      let lateCode = "";
      const lateTransport = new Promise<void>((resolve) => {
        releaseLate = resolve;
      });
      await assert.rejects(
        requestOtp(timeoutPhone, {
          pool,
          requestIp: "198.51.100.7",
          now: clock.now,
          authSecret: SECRET,
          transportTimeoutMs: 10,
          sendOtp: async (input) => {
            lateCode = input.code;
            await lateTransport;
          },
        }),
        OtpDeliveryError,
      );
      releaseLate();
      await new Promise<void>((resolve) => setImmediate(resolve));
      const timedOut = await pool.query<{ id: string; status: string }>(
        "SELECT id, status FROM otp_challenges WHERE phone_e164 = $1",
        [timeoutPhone],
      );
      assert.equal(timedOut.rows[0].status, "send_failed");
      await assert.rejects(
        verifyOtp(timedOut.rows[0].id, lateCode, {
          pool,
          now: clock.now,
          authSecret: SECRET,
        }),
        OtpVerificationError,
      );

      const replacedPhone = uniquePhone();
      let releaseFirst!: () => void;
      let firstStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        firstStarted = resolve;
      });
      const waiting = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      let firstMessage!: SendOtpInput;
      const firstRequest = requestOtp(replacedPhone, {
        pool,
        requestIp: "198.51.100.8",
        now: clock.now,
        authSecret: SECRET,
        transportTimeoutMs: 5_000,
        sendOtp: async (input) => {
          firstMessage = input;
          firstStarted();
          await waiting;
        },
      });
      await started;
      clock.advance(MINUTE + 1);
      const replacement = await issueOtp(pool, replacedPhone, "198.51.100.8", clock);
      releaseFirst();
      await assert.rejects(firstRequest, OtpDeliveryError);
      await assert.rejects(
        verifyOtp(firstMessage.challengeId, firstMessage.code, {
          pool,
          now: clock.now,
          authSecret: SECRET,
        }),
        OtpVerificationError,
      );
      await verifyOtp(replacement.challengeId, replacement.code, {
        pool,
        now: clock.now,
        authSecret: SECRET,
      });
    });

    test("rollback complet et consommation concurrente unique", async () => {
      const clock = new TestClock(Date.UTC(2030, 0, 7, 10));
      const rollbackPhone = uniquePhone();
      const challenge = await issueOtp(pool, rollbackPhone, "198.51.100.9", clock);
      await pool.query(`
        CREATE FUNCTION reject_auth_session_insert() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
          RAISE EXCEPTION 'échec session volontaire';
        END
        $$
      `);
      await pool.query(`
        CREATE TRIGGER reject_auth_session_insert
        BEFORE INSERT ON auth_sessions
        FOR EACH ROW EXECUTE FUNCTION reject_auth_session_insert()
      `);
      await assert.rejects(
        verifyOtp(challenge.challengeId, challenge.code, {
          pool,
          now: clock.now,
          authSecret: SECRET,
        }),
        /échec session volontaire/,
      );
      assert.equal(
        (await pool.query("SELECT user_id FROM phone_identities WHERE phone_e164 = $1", [rollbackPhone])).rowCount,
        0,
      );
      assert.deepEqual(
        (await pool.query<{ status: string; consumed_at: Date | null }>(
          "SELECT status, consumed_at FROM otp_challenges WHERE id = $1",
          [challenge.challengeId],
        )).rows[0],
        { status: "sent", consumed_at: null },
      );
      await pool.query("DROP TRIGGER reject_auth_session_insert ON auth_sessions");
      await pool.query("DROP FUNCTION reject_auth_session_insert()");
      await verifyOtp(challenge.challengeId, challenge.code, {
        pool,
        now: clock.now,
        authSecret: SECRET,
      });

      const concurrentPhone = uniquePhone();
      const concurrentChallenge = await issueOtp(
        pool,
        concurrentPhone,
        "198.51.100.10",
        clock,
      );
      const verificationPools = await extraPools(2);
      try {
        const outcomes = await Promise.allSettled(
          verificationPools.map((candidate) => verifyOtp(
            concurrentChallenge.challengeId,
            concurrentChallenge.code,
            { pool: candidate, now: clock.now, authSecret: SECRET },
          )),
        );
        assert.equal(outcomes.filter((result) => result.status === "fulfilled").length, 1);
        assert.equal(
          outcomes.filter(
            (result) => result.status === "rejected" && result.reason instanceof OtpVerificationError,
          ).length,
          1,
        );
        const identity = await pool.query<{ user_id: string }>(
          "SELECT user_id FROM phone_identities WHERE phone_e164 = $1",
          [concurrentPhone],
        );
        assert.equal(identity.rowCount, 1);
        assert.equal(
          (await pool.query("SELECT id FROM auth_sessions WHERE user_id = $1", [identity.rows[0].user_id])).rowCount,
          1,
        );
      } finally {
        await Promise.all(verificationPools.map((candidate) => candidate.end()));
      }
    });

    test("sessions inconnue, expirée, révoquée et comptes suspendu/archivé", async () => {
      const clock = new TestClock(Date.UTC(2030, 0, 8, 10));
      const phone = uniquePhone();
      const first = await issueOtp(pool, phone, "198.51.100.11", clock);
      const firstLogin = await verifyOtp(first.challengeId, first.code, {
        pool,
        now: clock.now,
        authSecret: SECRET,
      });
      assert.equal(
        await resolveSession(randomBytes(32).toString("base64url"), { pool, now: clock.now }),
        null,
      );

      clock.advance(MINUTE + 1);
      const second = await issueOtp(pool, phone, "198.51.100.11", clock);
      const secondLogin = await verifyOtp(second.challengeId, second.code, {
        pool,
        now: clock.now,
        authSecret: SECRET,
      });
      await revokeSession(secondLogin.sessionToken, { pool, now: clock.now });
      await revokeSession(secondLogin.sessionToken, { pool, now: clock.now });
      assert.equal(await resolveSession(secondLogin.sessionToken, { pool, now: clock.now }), null);

      clock.advance(7 * DAY);
      assert.equal(await resolveSession(firstLogin.sessionToken, { pool, now: clock.now }), null);

      const statusPhone = uniquePhone();
      const statusChallenge = await issueOtp(pool, statusPhone, "198.51.100.12", clock);
      const statusLogin = await verifyOtp(statusChallenge.challengeId, statusChallenge.code, {
        pool,
        now: clock.now,
        authSecret: SECRET,
      });
      const suspended = await updateUser(
        { id: statusLogin.userId, expectedVersion: 1, status: "suspended" },
        pool,
      );
      assert.equal(await resolveSession(statusLogin.sessionToken, { pool, now: clock.now }), null);
      const archived = await archiveUser(statusLogin.userId, suspended.version, pool);
      assert.equal(archived.status, "archived");
      assert.equal(await resolveSession(statusLogin.sessionToken, { pool, now: clock.now }), null);

      clock.advance(MINUTE + 1);
      const retry = await issueOtp(pool, statusPhone, "198.51.100.12", clock);
      const sessionsBefore = await pool.query(
        "SELECT id FROM auth_sessions WHERE user_id = $1",
        [statusLogin.userId],
      );
      await assert.rejects(
        verifyOtp(retry.challengeId, retry.code, {
          pool,
          now: clock.now,
          authSecret: SECRET,
        }),
        OtpVerificationError,
      );
      assert.equal(
        (await pool.query("SELECT id FROM auth_sessions WHERE user_id = $1", [statusLogin.userId])).rowCount,
        sessionsBefore.rowCount,
      );
      assert.equal(
        (await pool.query("SELECT user_id FROM phone_identities WHERE phone_e164 = $1", [statusPhone])).rowCount,
        1,
      );
    });

    test("expiration OTP réévaluée après le verrou du challenge", async () => {
      const clock = new TestClock(Date.UTC(2030, 0, 10, 10));
      const phone = uniquePhone();
      const challenge = await issueOtp(pool, phone, "198.51.100.16", clock);
      const countsBefore = await pool.query<{ users: string; sessions: string }>(`
        SELECT (SELECT count(*) FROM users)::text AS users,
               (SELECT count(*) FROM auth_sessions)::text AS sessions
      `);
      const [verificationPool, lockerPool] = await extraPools(2);
      let transactionOpen = false;
      try {
        const pid = await poolBackendPid(verificationPool);
        await lockerPool.query("BEGIN");
        transactionOpen = true;
        await lockerPool.query("SELECT id FROM otp_challenges WHERE id = $1 FOR UPDATE", [
          challenge.challengeId,
        ]);

        const verification = verifyOtp(challenge.challengeId, challenge.code, {
          pool: verificationPool,
          now: clock.now,
          authSecret: SECRET,
        });
        await waitForRowLock(adminPool, pid);
        clock.advance(5 * MINUTE + 1);
        await lockerPool.query("COMMIT");
        transactionOpen = false;

        await assert.rejects(verification, OtpVerificationError);
        assert.deepEqual(
          (await pool.query<{ status: string; failed_attempts: number }>(
            "SELECT status, failed_attempts FROM otp_challenges WHERE id = $1",
            [challenge.challengeId],
          )).rows[0],
          { status: "expired", failed_attempts: 0 },
        );
        assert.equal(
          (await pool.query("SELECT user_id FROM phone_identities WHERE phone_e164 = $1", [phone]))
            .rowCount,
          0,
        );
        const countsAfter = await pool.query<{ users: string; sessions: string }>(`
          SELECT (SELECT count(*) FROM users)::text AS users,
                 (SELECT count(*) FROM auth_sessions)::text AS sessions
        `);
        assert.deepEqual(countsAfter.rows[0], countsBefore.rows[0]);
      } finally {
        if (transactionOpen) await lockerPool.query("ROLLBACK");
        await Promise.all([verificationPool.end(), lockerPool.end()]);
      }
    });

    test("expiration OTP réévaluée après le verrou du compte", async () => {
      const clock = new TestClock(Date.UTC(2030, 0, 11, 10));
      const phone = uniquePhone();
      const first = await issueOtp(pool, phone, "198.51.100.17", clock);
      const login = await verifyOtp(first.challengeId, first.code, {
        pool,
        now: clock.now,
        authSecret: SECRET,
      });
      clock.advance(MINUTE + 1);
      const challenge = await issueOtp(pool, phone, "198.51.100.17", clock);
      const sessionsBefore = await pool.query(
        "SELECT id FROM auth_sessions WHERE user_id = $1",
        [login.userId],
      );
      const [verificationPool, lockerPool] = await extraPools(2);
      let transactionOpen = false;
      try {
        const pid = await poolBackendPid(verificationPool);
        await lockerPool.query("BEGIN");
        transactionOpen = true;
        await lockerPool.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [login.userId]);

        const verification = verifyOtp(challenge.challengeId, challenge.code, {
          pool: verificationPool,
          now: clock.now,
          authSecret: SECRET,
        });
        await waitForRowLock(adminPool, pid);
        clock.advance(5 * MINUTE + 1);
        await lockerPool.query("COMMIT");
        transactionOpen = false;

        await assert.rejects(verification, OtpVerificationError);
        assert.equal(
          (await pool.query<{ status: string }>(
            "SELECT status FROM otp_challenges WHERE id = $1",
            [challenge.challengeId],
          )).rows[0].status,
          "expired",
        );
        assert.equal(
          (await pool.query("SELECT id FROM auth_sessions WHERE user_id = $1", [login.userId]))
            .rowCount,
          sessionsBefore.rowCount,
        );
      } finally {
        if (transactionOpen) await lockerPool.query("ROLLBACK");
        await Promise.all([verificationPool.end(), lockerPool.end()]);
      }
    });

    test("attente du pool : horodatage de demande effectif et session réévaluée", async () => {
      const requestClock = new TestClock(Date.UTC(2030, 0, 12, 10));
      const requestPhone = uniquePhone();
      const [requestPool] = await extraPools(1);
      const heldRequestClient = await requestPool.connect();
      let requestClientHeld = true;
      let sent: SendOtpInput | undefined;
      try {
        const pendingRequest = requestOtp(requestPhone, {
          pool: requestPool,
          requestIp: "198.51.100.18",
          now: requestClock.now,
          authSecret: SECRET,
          sendOtp: async (input) => {
            sent = input;
          },
        });
        await waitUntil(() => requestPool.waitingCount === 1, "pool saturé pour requestOtp");
        requestClock.advance(5 * MINUTE + 1);
        heldRequestClient.release();
        requestClientHeld = false;
        const result = await pendingRequest;
        assert.ok(sent);
        assert.ok(sent.expiresAt.getTime() > requestClock.now().getTime());
        assert.equal(result.expiresAt.getTime(), sent.expiresAt.getTime());
        const persisted = await pool.query<{ created_at: Date; expires_at: Date }>(
          "SELECT created_at, expires_at FROM otp_challenges WHERE id = $1",
          [result.challengeId],
        );
        assert.equal(persisted.rows[0].created_at.getTime(), requestClock.now().getTime());
        assert.equal(
          persisted.rows[0].expires_at.getTime() - persisted.rows[0].created_at.getTime(),
          5 * MINUTE,
        );
      } finally {
        if (requestClientHeld) heldRequestClient.release();
        await requestPool.end();
      }

      const sessionClock = new TestClock(Date.UTC(2030, 0, 12, 12));
      const sessionChallenge = await issueOtp(
        pool,
        uniquePhone(),
        "198.51.100.19",
        sessionClock,
      );
      const login = await verifyOtp(sessionChallenge.challengeId, sessionChallenge.code, {
        pool,
        now: sessionClock.now,
        authSecret: SECRET,
      });
      sessionClock.advance(login.sessionExpiresAt.getTime() - sessionClock.now().getTime() - 1);
      const [sessionPool] = await extraPools(1);
      const heldSessionClient = await sessionPool.connect();
      let sessionClientHeld = true;
      try {
        const resolution = resolveSession(login.sessionToken, {
          pool: sessionPool,
          now: sessionClock.now,
        });
        await waitUntil(() => sessionPool.waitingCount === 1, "pool saturé pour resolveSession");
        sessionClock.advance(2);
        heldSessionClient.release();
        sessionClientHeld = false;
        assert.equal(await resolution, null);
      } finally {
        if (sessionClientHeld) heldSessionClient.release();
        await sessionPool.end();
      }
    });

    test("requestOtp ne transporte pas un challenge expiré pendant un verrou", async () => {
      const clock = new TestClock(Date.UTC(2030, 0, 13, 10));
      const phone = uniquePhone();
      const first = await issueOtp(pool, phone, "198.51.100.20", clock);
      clock.advance(MINUTE + 1);
      const [requestPool, lockerPool] = await extraPools(2);
      let transactionOpen = false;
      let sends = 0;
      try {
        const pid = await poolBackendPid(requestPool);
        await lockerPool.query("BEGIN");
        transactionOpen = true;
        await lockerPool.query("SELECT id FROM otp_challenges WHERE id = $1 FOR UPDATE", [
          first.challengeId,
        ]);
        const request = requestOtp(phone, {
          pool: requestPool,
          requestIp: "198.51.100.20",
          now: clock.now,
          authSecret: SECRET,
          sendOtp: async () => {
            sends += 1;
          },
        });
        await waitForRowLock(adminPool, pid);
        clock.advance(5 * MINUTE + 1);
        await lockerPool.query("COMMIT");
        transactionOpen = false;

        await assert.rejects(request, OtpDeliveryError);
        assert.equal(sends, 0);
        const latest = await pool.query<{ status: string }>(
          `SELECT status FROM otp_challenges
            WHERE phone_e164 = $1 ORDER BY created_at DESC LIMIT 1`,
          [phone],
        );
        assert.equal(latest.rows[0].status, "expired");
      } finally {
        if (transactionOpen) await lockerPool.query("ROLLBACK");
        await Promise.all([requestPool.end(), lockerPool.end()]);
      }
    });

    test("absence de fournisseur ou de secret : refus avant toute écriture", async () => {
      const clock = new TestClock(Date.UTC(2030, 0, 9, 10));
      const beforeCounts = await pool.query<{ challenges: string; counters: string }>(`
        SELECT (SELECT count(*) FROM otp_challenges)::text AS challenges,
               (SELECT count(*) FROM otp_rate_limit_counters)::text AS counters
      `);
      await assert.rejects(
        requestOtp(uniquePhone(), {
          pool,
          requestIp: "198.51.100.13",
          now: clock.now,
          authSecret: SECRET,
        }),
        AuthConfigurationError,
      );

      const previousSecret = process.env.NOMA_AUTH_SECRET;
      delete process.env.NOMA_AUTH_SECRET;
      try {
        await assert.rejects(
          requestOtp(uniquePhone(), {
            pool,
            requestIp: "198.51.100.14",
            now: clock.now,
            sendOtp: async () => {},
          }),
          AuthConfigurationError,
        );
      } finally {
        if (previousSecret === undefined) delete process.env.NOMA_AUTH_SECRET;
        else process.env.NOMA_AUTH_SECRET = previousSecret;
      }

      await assert.rejects(
        requestOtp("0700000000", {
          pool,
          requestIp: "198.51.100.15",
          now: clock.now,
          authSecret: SECRET,
          sendOtp: async () => {},
        }),
        /format international canonique/,
      );
      const afterCounts = await pool.query<{ challenges: string; counters: string }>(`
        SELECT (SELECT count(*) FROM otp_challenges)::text AS challenges,
               (SELECT count(*) FROM otp_rate_limit_counters)::text AS counters
      `);
      assert.deepEqual(afterCounts.rows[0], beforeCounts.rows[0]);
    });

    test("nettoyage limité au schéma temporaire", async () => {
      await adminPool.query(`DROP SCHEMA ${quotedSchema} CASCADE`);
      schemaCleaned = true;
      const remaining = await adminPool.query<{ name: string | null }>(
        "SELECT to_regnamespace($1)::text AS name",
        [schema],
      );
      assert.equal(remaining.rows[0].name, null);
    });
  });
}
