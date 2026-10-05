import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, describe, mock, test } from "node:test";
import type { Pool } from "pg";
import { POST as runtimeRequestOtp } from "../../app/api/auth/otp/request/route";
import { POST as runtimeVerifyOtp } from "../../app/api/auth/otp/verify/route";
import { GET as runtimeSession } from "../../app/api/auth/session/route";
import { createAuthHttpHandlers } from "../../lib/server/auth/http";
import {
  DEV_OTP_REFUSED_WARNING,
  createDevOtpResolver,
} from "../../lib/server/auth/dev-otp-transport";
import { closePostgresPool } from "../../lib/server/postgres/client";
import { runMigrations } from "../../lib/server/postgres/migrations";
import {
  createTemporarySchemaName,
  openVerifiedIsolatedPool,
  openVerifiedTestDatabase,
  quoteTemporarySchema,
  requireDedicatedTestDatabase,
  type DedicatedTestDatabase,
} from "./test-database";

const SECRET = randomBytes(32);
const ORIGIN = "http://localhost:3211";
const PROXY_SECRET = "proxy-auth-test-secret-32-bytes-minimum";
const CODE_LINE = /^\[auth:dev\] code OTP pour \+\*+([0-9]{2}) : ([0-9]{6}) \(expire à [0-9]{2}:[0-9]{2}:[0-9]{2} UTC\)$/;
let phoneSequence = 0;

function uniquePhone(): string {
  phoneSequence += 1;
  return `+22507${(Date.now() % 100_000).toString().padStart(5, "0")}${phoneSequence.toString().padStart(3, "0")}`;
}

function jsonPost(path: string, body: unknown, ip = "198.51.100.77"): Request {
  return new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: {
      origin: ORIGIN,
      "content-type": "application/json",
      "x-noma-proxy-secret": PROXY_SECRET,
      "x-forwarded-for": ip,
    },
    body: JSON.stringify(body),
  });
}

function setEnv(values: Record<string, string | undefined>): () => void {
  const environment = process.env as Record<string, string | undefined>;
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, environment[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete environment[key];
    else environment[key] = value;
  }
  return () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete environment[key];
      else environment[key] = value;
    }
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
  test("pré-requis PostgreSQL dédié pour le transport OTP de développement", () => {
    assert.fail("TEST_DATABASE_URL requis : aucun test PostgreSQL n'a été simulé.");
  });
} else if (configuredUrlError) {
  test("pré-requis TEST_DATABASE_URL sûr pour le transport OTP de développement", () => {
    throw configuredUrlError;
  });
} else {
  describe("transport OTP de développement branché sur les gestionnaires HTTP d'authentification", () => {
    const schema = createTemporarySchemaName();
    const quotedSchema = quoteTemporarySchema(schema);
    let target: DedicatedTestDatabase;
    let adminPool: Pool;
    let pool: Pool;

    before(async () => {
      const opened = await openVerifiedTestDatabase(configuredUrl);
      target = opened.target;
      adminPool = opened.pool;
      await adminPool.query(`CREATE SCHEMA ${quotedSchema}`);
      pool = await openVerifiedIsolatedPool(target, schema);
      await runMigrations(pool);
    });

    after(async () => {
      await closePostgresPool();
      if (pool) await pool.end();
      if (adminPool) {
        await adminPool.query(`DROP SCHEMA IF EXISTS ${quotedSchema} CASCADE`);
        await adminPool.end();
      }
    });

    async function counts(): Promise<{ challenges: string; counters: string }> {
      const result = await pool.query<{ challenges: string; counters: string }>(`
        SELECT (SELECT count(*) FROM otp_challenges)::text AS challenges,
               (SELECT count(*) FROM otp_rate_limit_counters)::text AS counters
      `);
      return result.rows[0];
    }

    function handlersFor(env: Record<string, string | undefined>, lines: string[], warnings: string[] = []) {
      return createAuthHttpHandlers({
        pool,
        authSecret: SECRET,
        env: { NOMA_AUTH_ORIGIN: ORIGIN, NOMA_AUTH_PROXY_SECRET: PROXY_SECRET, ...env },
        resolveSendOtp: createDevOtpResolver({
          write: (line) => lines.push(line),
          warn: (line) => warnings.push(line),
        }),
      });
    }

    test("le code journalisé permet verifyOtp : cookie, session, et une seule ligne sans autre donnée", async () => {
      const lines: string[] = [];
      const handlers = handlersFor({ NODE_ENV: "development", NOMA_DEV_OTP_CONSOLE: "1" }, lines);
      const phone = uniquePhone();

      const requested = await handlers.requestOtp(jsonPost("/api/auth/otp/request", { phone }));
      assert.equal(requested.status, 202);
      const requestBody = (await requested.json()) as { challengeId: string };

      assert.equal(lines.length, 1);
      const match = CODE_LINE.exec(lines[0]);
      assert.ok(match, `ligne inattendue : ${lines[0]}`);
      assert.equal(match[1], phone.slice(-2));
      assert.equal(lines[0].includes(phone), false);
      assert.equal(lines[0].includes(phone.slice(1, -2)), false);
      assert.equal(lines[0].includes(requestBody.challengeId), false);
      assert.equal(lines[0].includes("198.51.100.77"), false);
      assert.equal(lines[0].includes(PROXY_SECRET), false);

      const wrong = await handlers.verifyOtp(jsonPost("/api/auth/otp/verify", {
        challengeId: requestBody.challengeId,
        code: match[2] === "000000" ? "000001" : "000000",
      }));
      assert.equal(wrong.status, 401);

      const verified = await handlers.verifyOtp(jsonPost("/api/auth/otp/verify", {
        challengeId: requestBody.challengeId,
        code: match[2],
      }));
      assert.equal(verified.status, 200);
      const cookie = (verified.headers.get("set-cookie") ?? "").split(";", 1)[0];
      assert.match(cookie, /^noma_auth=[A-Za-z0-9_-]{43}$/);
      const verifiedBody = (await verified.json()) as { userId: string };

      const session = await handlers.session(new Request(`${ORIGIN}/api/auth/session`, { headers: { cookie } }));
      assert.equal(session.status, 200);
      assert.deepEqual(await session.json(), { userId: verifiedBody.userId });
      assert.equal(lines.length, 1, "aucune autre ligne écrite par le parcours complet");
    });

    test("production + drapeau : demande refusée (503), aucune ligne, aucune écriture, un seul avertissement", async () => {
      const lines: string[] = [];
      const warnings: string[] = [];
      const handlers = handlersFor({ NODE_ENV: "production", NOMA_DEV_OTP_CONSOLE: "1" }, lines, warnings);
      const before = await counts();
      const phone = uniquePhone();
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const response = await handlers.requestOtp(jsonPost("/api/auth/otp/request", { phone }));
        assert.equal(response.status, 503);
        assert.equal((await response.text()).includes(phone), false);
      }
      assert.deepEqual(lines, []);
      assert.deepEqual(warnings, [DEV_OTP_REFUSED_WARNING]);
      assert.deepEqual(await counts(), before);
    });

    test("NODE_ENV=test + drapeau : refusé comme la production", async () => {
      const lines: string[] = [];
      const warnings: string[] = [];
      const handlers = handlersFor({ NODE_ENV: "test", NOMA_DEV_OTP_CONSOLE: "1" }, lines, warnings);
      const before = await counts();
      const response = await handlers.requestOtp(jsonPost("/api/auth/otp/request", { phone: uniquePhone() }));
      assert.equal(response.status, 503);
      assert.deepEqual(lines, []);
      assert.deepEqual(warnings, [DEV_OTP_REFUSED_WARNING]);
      assert.deepEqual(await counts(), before);
    });

    test("développement sans le drapeau : refus comme aujourd'hui, aucun message", async () => {
      const lines: string[] = [];
      const warnings: string[] = [];
      for (const flag of [undefined, "0", "true"]) {
        const handlers = handlersFor({ NODE_ENV: "development", NOMA_DEV_OTP_CONSOLE: flag }, lines, warnings);
        const before = await counts();
        const response = await handlers.requestOtp(jsonPost("/api/auth/otp/request", { phone: uniquePhone() }));
        assert.equal(response.status, 503, `drapeau ${String(flag)}`);
        assert.deepEqual(await counts(), before);
      }
      assert.deepEqual(lines, []);
      assert.deepEqual(warnings, []);
    });

    test("un transport injecté prime toujours sur le résolveur de développement", async () => {
      const lines: string[] = [];
      const injected: string[] = [];
      const handlers = createAuthHttpHandlers({
        pool,
        authSecret: SECRET,
        env: {
          NODE_ENV: "development",
          NOMA_DEV_OTP_CONSOLE: "1",
          NOMA_AUTH_ORIGIN: ORIGIN,
          NOMA_AUTH_PROXY_SECRET: PROXY_SECRET,
        },
        sendOtp: async (input) => {
          injected.push(input.code);
        },
        resolveSendOtp: createDevOtpResolver({ write: (line) => lines.push(line) }),
      });
      const response = await handlers.requestOtp(jsonPost("/api/auth/otp/request", { phone: uniquePhone() }));
      assert.equal(response.status, 202);
      assert.equal(injected.length, 1);
      assert.deepEqual(lines, []);
    });

    test("routes HTTP réelles (dépendances par défaut) : parcours complet en développement avec le drapeau", async () => {
      await closePostgresPool();
      const restore = setEnv({
        NODE_ENV: "development",
        NOMA_DEV_OTP_CONSOLE: "1",
        NOMA_AUTH_ORIGIN: ORIGIN,
        NOMA_AUTH_PROXY_SECRET: PROXY_SECRET,
        NOMA_AUTH_SECRET: SECRET.toString("base64"),
        DATABASE_URL: target.connectionString,
        PGOPTIONS: `-c search_path=${schema}`,
      });
      const log = mock.method(console, "log", () => {});
      const warn = mock.method(console, "warn", () => {});
      try {
        const phone = uniquePhone();
        const requested = await runtimeRequestOtp(jsonPost("/api/auth/otp/request", { phone }));
        assert.equal(requested.status, 202);
        const { challengeId } = (await requested.json()) as { challengeId: string };

        const written = log.mock.calls.map((call) => String(call.arguments[0]));
        assert.equal(written.length, 1);
        const match = CODE_LINE.exec(written[0]);
        assert.ok(match, `ligne inattendue : ${written[0]}`);
        assert.equal(written[0].includes(phone), false);
        assert.equal(written[0].includes(challengeId), false);
        assert.equal(warn.mock.calls.length, 0);

        const verified = await runtimeVerifyOtp(jsonPost("/api/auth/otp/verify", { challengeId, code: match[2] }));
        assert.equal(verified.status, 200);
        const cookie = (verified.headers.get("set-cookie") ?? "").split(";", 1)[0];
        assert.match(cookie, /^noma_auth=/);
        const session = await runtimeSession(new Request(`${ORIGIN}/api/auth/session`, { headers: { cookie } }));
        assert.equal(session.status, 200);
      } finally {
        log.mock.restore();
        warn.mock.restore();
        await closePostgresPool();
        restore();
      }
    });

    test("routes HTTP réelles : en production le drapeau n'installe aucun transport (503, aucune ligne de code)", async () => {
      await closePostgresPool();
      const restore = setEnv({
        NODE_ENV: "production",
        NOMA_DEV_OTP_CONSOLE: "1",
        NOMA_AUTH_ORIGIN: ORIGIN,
        NOMA_AUTH_PROXY_SECRET: PROXY_SECRET,
        NOMA_AUTH_SECRET: SECRET.toString("base64"),
        DATABASE_URL: target.connectionString,
        PGOPTIONS: `-c search_path=${schema}`,
      });
      const log = mock.method(console, "log", () => {});
      const warn = mock.method(console, "warn", () => {});
      try {
        const before = await counts();
        const response = await runtimeRequestOtp(jsonPost("/api/auth/otp/request", { phone: uniquePhone() }));
        assert.equal(response.status, 503);
        assert.equal(log.mock.calls.length, 0);
        assert.equal(warn.mock.calls.length, 1, "exactement un avertissement (production + drapeau)");
        assert.equal(warn.mock.calls[0].arguments[0], DEV_OTP_REFUSED_WARNING);
        assert.deepEqual(await counts(), before);
      } finally {
        log.mock.restore();
        warn.mock.restore();
        await closePostgresPool();
        restore();
      }
    });

    test("unicité : deux numéros distincts reçoivent chacun leur propre ligne", async () => {
      const lines: string[] = [];
      const handlers = handlersFor({ NODE_ENV: "development", NOMA_DEV_OTP_CONSOLE: "1" }, lines);
      for (const ip of ["198.51.100.78", "198.51.100.79"]) {
        const response = await handlers.requestOtp(jsonPost("/api/auth/otp/request", { phone: uniquePhone() }, ip));
        assert.equal(response.status, 202);
      }
      assert.equal(lines.length, 2);
      assert.notEqual(lines[0], lines[1]);
    });
  });
}
