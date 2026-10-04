import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";
import type { Pool } from "pg";
import { POST as runtimeRequestOtp } from "../../app/api/auth/otp/request/route";
import {
  AUTH_BODY_MAX_BYTES,
  AUTH_SESSION_COOKIE,
  createAuthHttpHandlers,
  type AuthHttpHandlers,
} from "../../lib/server/auth/http";
import type { SendOtpInput } from "../../lib/server/auth";
import { updateUser } from "../../lib/server/catalog";
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
const ORIGIN = "https://noma.test";
const PROXY_SECRET = "proxy-auth-test-secret-32-bytes-minimum";
const DAY = 24 * 60 * 60 * 1_000;
const HTTP_ENV = {
  NODE_ENV: "production",
  NOMA_AUTH_ORIGIN: ORIGIN,
  NOMA_AUTH_PROXY_SECRET: PROXY_SECRET,
};
let phoneSequence = 0;

function uniquePhone(): string {
  phoneSequence += 1;
  return `+22502${phoneSequence.toString().padStart(8, "0")}`;
}

function postRequest(
  path: string,
  body: BodyInit | undefined,
  headers: Record<string, string> = {},
): Request {
  return new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: {
      origin: ORIGIN,
      "x-noma-proxy-secret": PROXY_SECRET,
      "x-forwarded-for": "198.51.100.40",
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    ...(body !== undefined ? { body } : {}),
  });
}

function jsonPost(path: string, body: unknown, headers?: Record<string, string>): Request {
  return postRequest(path, JSON.stringify(body), headers);
}

function sessionRequest(cookie?: string): Request {
  return new Request(`${ORIGIN}/api/auth/session`, {
    headers: cookie ? { cookie } : undefined,
  });
}

function cookiePair(response: Response): string {
  const setCookie = response.headers.get("set-cookie");
  assert.ok(setCookie, "le cookie de session doit être posé");
  return setCookie.split(";", 1)[0];
}

function cookieToken(cookie: string): string {
  const prefix = `${AUTH_SESSION_COOKIE}=`;
  assert.ok(cookie.startsWith(prefix));
  return cookie.slice(prefix.length);
}

function assertNoStore(response: Response): void {
  assert.equal(response.headers.get("cache-control"), "no-store");
}

interface LoginResult {
  userId: string;
  cookie: string;
  setCookie: string;
  code: string;
  phone: string;
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
  test("pré-requis PostgreSQL dédié pour les handlers auth", () => {
    assert.fail("TEST_DATABASE_URL requis : aucun test HTTP PostgreSQL n'a été simulé.");
  });
} else if (configuredUrlError) {
  test("pré-requis TEST_DATABASE_URL sûr pour les handlers auth", () => {
    throw configuredUrlError;
  });
} else {
  describe("handlers HTTP d'authentification", () => {
    const schema = createTemporarySchemaName();
    const quotedSchema = quoteTemporarySchema(schema);
    const clock = new TestClock(Date.UTC(2031, 0, 1, 10));
    const messages = new Map<string, SendOtpInput>();
    let target: DedicatedTestDatabase;
    let adminPool: Pool;
    let pool: Pool;
    let handlers: AuthHttpHandlers;
    let schemaCleaned = false;

    before(async () => {
      const opened = await openVerifiedTestDatabase(configuredUrl);
      target = opened.target;
      adminPool = opened.pool;
      await adminPool.query(`CREATE SCHEMA ${quotedSchema}`);
      pool = await openVerifiedIsolatedPool(target, schema);
      await runMigrations(pool);
      handlers = createAuthHttpHandlers({
        pool,
        now: clock.now,
        authSecret: SECRET,
        env: HTTP_ENV,
        sendOtp: async (input) => {
          messages.set(input.challengeId, input);
        },
      });
    });

    after(async () => {
      if (pool) await pool.end();
      if (adminPool) {
        if (!schemaCleaned) await adminPool.query(`DROP SCHEMA IF EXISTS ${quotedSchema} CASCADE`);
        await adminPool.end();
      }
    });

    async function login(phone: string, ip: string): Promise<LoginResult> {
      const requested = await handlers.requestOtp(jsonPost(
        "/api/auth/otp/request",
        { phone },
        { "x-forwarded-for": ip },
      ));
      assert.equal(requested.status, 202);
      assertNoStore(requested);
      const requestText = await requested.text();
      const requestBody = JSON.parse(requestText) as {
        challengeId: string;
        expiresAt: string;
        resendAvailableAt: string;
      };
      const message = messages.get(requestBody.challengeId);
      assert.ok(message);
      assert.deepEqual(Object.keys(requestBody).sort(), [
        "challengeId",
        "expiresAt",
        "resendAvailableAt",
      ]);

      const verified = await handlers.verifyOtp(jsonPost("/api/auth/otp/verify", {
        challengeId: message.challengeId,
        code: message.code,
      }));
      assert.equal(verified.status, 200);
      assertNoStore(verified);
      const responseText = await verified.text();
      const responseBody = JSON.parse(responseText) as { userId: string };
      const setCookie = verified.headers.get("set-cookie");
      assert.ok(setCookie);
      const cookie = cookiePair(verified);
      const token = cookieToken(cookie);
      assert.deepEqual(Object.keys(responseBody), ["userId"]);
      assert.equal(responseText.includes(token), false);
      assert.equal(responseText.includes(phone), false);
      return { userId: responseBody.userId, cookie, setCookie, code: message.code, phone };
    }

    test("parcours cookie, session et logout persistant idempotent", async () => {
      const loginResult = await login(uniquePhone(), "198.51.100.41");
      const token = cookieToken(loginResult.cookie);
      assert.match(loginResult.cookie, /^noma_auth=[A-Za-z0-9_-]{43}$/);
      assert.match(loginResult.setCookie, /Path=\//);
      assert.match(loginResult.setCookie, /HttpOnly/);
      assert.match(loginResult.setCookie, /SameSite=Lax/);
      assert.match(loginResult.setCookie, /Secure/);
      assert.doesNotMatch(loginResult.setCookie, /Domain=/i);

      const session = await handlers.session(sessionRequest(loginResult.cookie));
      assert.equal(session.status, 200);
      assertNoStore(session);
      assert.deepEqual(await session.json(), { userId: loginResult.userId });
      assert.equal(
        (await handlers.session(sessionRequest(`noma_sid=${randomUUID()}`))).status,
        401,
      );

      const databaseSession = await pool.query<{ token_sha256: string; expires_at: Date }>(
        "SELECT token_sha256, expires_at FROM auth_sessions WHERE user_id = $1",
        [loginResult.userId],
      );
      assert.equal(databaseSession.rowCount, 1);
      assert.notEqual(databaseSession.rows[0].token_sha256, token);
      assert.ok(
        loginResult.setCookie.includes(
          `Expires=${databaseSession.rows[0].expires_at.toUTCString()}`,
        ),
      );

      const logout = await handlers.logout(postRequest(
        "/api/auth/logout",
        undefined,
        { cookie: loginResult.cookie },
      ));
      assert.equal(logout.status, 204);
      assertNoStore(logout);
      const cleared = logout.headers.get("set-cookie") ?? "";
      assert.match(cleared, /^noma_auth=;/);
      assert.match(cleared, /Path=\//);
      assert.match(cleared, /HttpOnly/);
      assert.match(cleared, /SameSite=Lax/);
      assert.match(cleared, /Secure/);
      assert.doesNotMatch(cleared, /Domain=/i);
      assert.equal(await logout.text(), "");

      const repeated = await handlers.logout(postRequest(
        "/api/auth/logout",
        undefined,
        { cookie: loginResult.cookie },
      ));
      assert.equal(repeated.status, 204);
      assert.equal((await handlers.session(sessionRequest(loginResult.cookie))).status, 401);
      const revoked = await pool.query<{ revoked_at: Date | null }>(
        "SELECT revoked_at FROM auth_sessions WHERE user_id = $1",
        [loginResult.userId],
      );
      assert.ok(revoked.rows[0].revoked_at);
    });

    test("cookie sécurisé, expiration et compte suspendu", async () => {
      const expiring = await login(uniquePhone(), "198.51.100.44");
      clock.advance(7 * DAY + 1);
      const expired = await handlers.session(sessionRequest(expiring.cookie));
      assert.equal(expired.status, 401);
      assertNoStore(expired);

      const suspended = await login(uniquePhone(), "198.51.100.46");
      await updateUser(
        { id: suspended.userId, expectedVersion: 1, status: "suspended" },
        pool,
      );
      const denied = await handlers.session(sessionRequest(suspended.cookie));
      assert.equal(denied.status, 401);
      assert.deepEqual(await denied.json(), {
        error: { code: "authentication_refused", message: "Authentification refusée." },
      });
    });

    test("origines absentes ou intersites refusées avant les services", async () => {
      const before = await pool.query<{ challenges: string }>(
        "SELECT count(*)::text AS challenges FROM otp_challenges",
      );
      const sendsBefore = messages.size;
      const phone = uniquePhone();

      const absentOrigin = await handlers.requestOtp(new Request(
        `${ORIGIN}/api/auth/otp/request`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-noma-proxy-secret": PROXY_SECRET,
            "x-forwarded-for": "198.51.100.49",
          },
          body: JSON.stringify({ phone }),
        },
      ));
      assert.equal(absentOrigin.status, 403);
      assertNoStore(absentOrigin);

      const foreignVerify = await handlers.verifyOtp(jsonPost(
        "/api/auth/otp/verify",
        { challengeId: randomUUID(), code: "123456" },
        { origin: "https://evil.test" },
      ));
      assert.equal(foreignVerify.status, 403);

      const foreignLogout = await handlers.logout(postRequest(
        "/api/auth/logout",
        undefined,
        { origin: "https://evil.test" },
      ));
      assert.equal(foreignLogout.status, 403);
      assert.equal(foreignLogout.headers.get("access-control-allow-origin"), null);
      assert.equal(messages.size, sendsBefore);
      assert.deepEqual(
        (await pool.query<{ challenges: string }>(
          "SELECT count(*)::text AS challenges FROM otp_challenges",
        )).rows[0],
        before.rows[0],
      );
    });

    test("corps invalides, champs privilégiés et dépassement sans Content-Length", async () => {
      const malformed = await handlers.requestOtp(postRequest(
        "/api/auth/otp/request",
        "{",
      ));
      assert.equal(malformed.status, 400);
      assertNoStore(malformed);

      const national = await handlers.requestOtp(jsonPost(
        "/api/auth/otp/request",
        { phone: "0700000000" },
      ));
      assert.equal(national.status, 400);

      const privileged = await handlers.requestOtp(jsonPost(
        "/api/auth/otp/request",
        { phone: uniquePhone(), role: "admin" },
      ));
      assert.equal(privileged.status, 400);
      const clientIp = await handlers.requestOtp(jsonPost(
        "/api/auth/otp/request",
        { phone: uniquePhone(), requestIp: "198.51.100.250" },
      ));
      assert.equal(clientIp.status, 400);
      const owner = await handlers.verifyOtp(jsonPost(
        "/api/auth/otp/verify",
        { challengeId: randomUUID(), code: "123456", ownerId: randomUUID() },
      ));
      assert.equal(owner.status, 400);

      const chunks = Array.from(
        { length: 4 },
        () => new TextEncoder().encode("é".repeat(AUTH_BODY_MAX_BYTES / 2)),
      );
      const streamState = { pulls: 0, cancelled: false };
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          streamState.pulls += 1;
          const chunk = chunks.shift();
          if (chunk) controller.enqueue(chunk);
          else controller.close();
        },
        cancel() {
          streamState.cancelled = true;
        },
      });
      const oversized = new Request(`${ORIGIN}/api/auth/otp/request`, {
        method: "POST",
        headers: {
          origin: ORIGIN,
          "content-type": "application/json",
          "x-noma-proxy-secret": PROXY_SECRET,
          "x-forwarded-for": "198.51.100.47",
        },
        body: stream,
        duplex: "half",
      } as RequestInit & { duplex: "half" });
      const tooLarge = await handlers.requestOtp(oversized);
      assert.equal(tooLarge.status, 413);
      assertNoStore(tooLarge);
      assert.equal(streamState.cancelled, true);
      assert.ok(streamState.pulls < 4);
    });

    test("quotas HTTP et vérification refusée restent génériques", async () => {
      const phone = uniquePhone();
      const first = await handlers.requestOtp(jsonPost(
        "/api/auth/otp/request",
        { phone },
        { "x-forwarded-for": "198.51.100.48" },
      ));
      assert.equal(first.status, 202);
      const firstBody = await first.json() as { challengeId: string };
      const message = messages.get(firstBody.challengeId);
      assert.ok(message);

      const repeated = await handlers.requestOtp(jsonPost(
        "/api/auth/otp/request",
        { phone },
        { "x-forwarded-for": "198.51.100.48" },
      ));
      assert.equal(repeated.status, 429);
      assert.deepEqual(await repeated.json(), {
        error: { code: "otp_request_limited", message: "Demande OTP temporairement refusée." },
      });

      const refused = await handlers.verifyOtp(jsonPost("/api/auth/otp/verify", {
        challengeId: message.challengeId,
        code: message.code === "000000" ? "999999" : "000000",
      }));
      assert.equal(refused.status, 401);
      const refusedText = await refused.text();
      assert.equal(refusedText.includes(message.code), false);
      assert.equal(refusedText.includes(phone), false);
    });

    test("configuration fiable absente : 503 sans écriture ni faux succès", async () => {
      const before = await pool.query<{ challenges: string; counters: string }>(`
        SELECT (SELECT count(*) FROM otp_challenges)::text AS challenges,
               (SELECT count(*) FROM otp_rate_limit_counters)::text AS counters
      `);
      const phone = uniquePhone();

      const withoutTransport = createAuthHttpHandlers({
        pool,
        now: clock.now,
        authSecret: SECRET,
        env: HTTP_ENV,
      });
      const transportMissing = await withoutTransport.requestOtp(jsonPost(
        "/api/auth/otp/request",
        { phone },
      ));
      assert.equal(transportMissing.status, 503);
      assertNoStore(transportMissing);

      const withoutProxy = createAuthHttpHandlers({
        pool,
        now: clock.now,
        authSecret: SECRET,
        sendOtp: async () => assert.fail("transport interdit sans IP fiable"),
        env: { NODE_ENV: "production", NOMA_AUTH_ORIGIN: ORIGIN },
      });
      assert.equal((await withoutProxy.requestOtp(jsonPost(
        "/api/auth/otp/request",
        { phone },
      ))).status, 503);

      const withoutOrigin = createAuthHttpHandlers({
        pool,
        now: clock.now,
        authSecret: SECRET,
        sendOtp: async () => assert.fail("transport interdit sans origine configurée"),
        env: { NODE_ENV: "production", NOMA_AUTH_PROXY_SECRET: PROXY_SECRET },
      });
      assert.equal((await withoutOrigin.requestOtp(jsonPost(
        "/api/auth/otp/request",
        { phone },
      ))).status, 503);

      const previousOrigin = process.env.NOMA_AUTH_ORIGIN;
      const previousProxySecret = process.env.NOMA_AUTH_PROXY_SECRET;
      process.env.NOMA_AUTH_ORIGIN = ORIGIN;
      process.env.NOMA_AUTH_PROXY_SECRET = PROXY_SECRET;
      try {
        const runtimeResponse = await runtimeRequestOtp(jsonPost(
          "/api/auth/otp/request",
          { phone },
        ));
        assert.equal(runtimeResponse.status, 503);
        assertNoStore(runtimeResponse);
      } finally {
        if (previousOrigin === undefined) delete process.env.NOMA_AUTH_ORIGIN;
        else process.env.NOMA_AUTH_ORIGIN = previousOrigin;
        if (previousProxySecret === undefined) delete process.env.NOMA_AUTH_PROXY_SECRET;
        else process.env.NOMA_AUTH_PROXY_SECRET = previousProxySecret;
      }

      const afterCounts = await pool.query<{ challenges: string; counters: string }>(`
        SELECT (SELECT count(*) FROM otp_challenges)::text AS challenges,
               (SELECT count(*) FROM otp_rate_limit_counters)::text AS counters
      `);
      assert.deepEqual(afterCounts.rows[0], before.rows[0]);
      const responseText = await transportMissing.text();
      assert.equal(responseText.includes(phone), false);
      assert.equal(responseText.includes(SECRET.toString("base64")), false);
    });

    test("échec temporaire du logout conserve le cookie pour une nouvelle tentative", async () => {
      const loginResult = await login(uniquePhone(), "198.51.100.50");
      await pool.query(`
        CREATE FUNCTION reject_http_logout_revocation() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
          RAISE EXCEPTION 'refus temporaire de révocation';
        END
        $$
      `);
      await pool.query(`
        CREATE TRIGGER reject_http_logout_revocation
        BEFORE UPDATE ON auth_sessions
        FOR EACH ROW EXECUTE FUNCTION reject_http_logout_revocation()
      `);
      let triggerInstalled = true;
      try {
        const failed = await handlers.logout(postRequest(
          "/api/auth/logout",
          undefined,
          { cookie: loginResult.cookie },
        ));
        assert.equal(failed.status, 503);
        assertNoStore(failed);
        assert.equal(failed.headers.get("set-cookie"), null);
        const failureText = await failed.text();
        assert.equal(failureText.includes("refus temporaire"), false);
        assert.deepEqual(JSON.parse(failureText), {
          error: {
            code: "auth_unavailable",
            message: "Le service d'authentification est temporairement indisponible.",
          },
        });
        assert.equal(
          (await pool.query<{ revoked_at: Date | null }>(
            "SELECT revoked_at FROM auth_sessions WHERE user_id = $1",
            [loginResult.userId],
          )).rows[0].revoked_at,
          null,
        );
      } finally {
        if (triggerInstalled) {
          await pool.query("DROP TRIGGER reject_http_logout_revocation ON auth_sessions");
          triggerInstalled = false;
        }
      }

      const retry = await handlers.logout(postRequest(
        "/api/auth/logout",
        undefined,
        { cookie: loginResult.cookie },
      ));
      assert.equal(retry.status, 204);
      assert.match(retry.headers.get("set-cookie") ?? "", /Max-Age=0/);
      assert.ok(
        (await pool.query<{ revoked_at: Date | null }>(
          "SELECT revoked_at FROM auth_sessions WHERE user_id = $1",
          [loginResult.userId],
        )).rows[0].revoked_at,
      );
      assert.equal((await handlers.session(sessionRequest(loginResult.cookie))).status, 401);

      const repeated = await handlers.logout(postRequest(
        "/api/auth/logout",
        undefined,
        { cookie: loginResult.cookie },
      ));
      assert.equal(repeated.status, 204);
      assert.match(repeated.headers.get("set-cookie") ?? "", /Max-Age=0/);

      const withoutCookie = await handlers.logout(postRequest("/api/auth/logout", undefined));
      assert.equal(withoutCookie.status, 204);
      assert.match(withoutCookie.headers.get("set-cookie") ?? "", /Max-Age=0/);
      await pool.query("DROP FUNCTION reject_http_logout_revocation()");
    });

    test("nettoyage limité au schéma temporaire", async () => {
      await adminPool.query(`DROP SCHEMA ${quotedSchema} CASCADE`);
      schemaCleaned = true;
      assert.equal(
        (await adminPool.query<{ name: string | null }>(
          "SELECT to_regnamespace($1)::text AS name",
          [schema],
        )).rows[0].name,
        null,
      );
    });
  });
}
