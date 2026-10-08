import assert from "node:assert/strict";
import { test } from "node:test";
import { prepareDevTry } from "../../scripts/dev-try";

const KEY = "fake_meno_key_for_tests_only_0001";
const BASE = { DATABASE_URL: "postgresql://noma_local:x@127.0.0.1:55432/noma_e2e" };
const random = (bytes: number) => Buffer.alloc(bytes, 9);

function plan(env: Record<string, string | undefined>) {
  const prepared = prepareDevTry({ ...BASE, ...env }, random);
  assert.equal(prepared.ok, true, prepared.ok ? "" : prepared.reason);
  return prepared.ok ? prepared.plan : assert.fail("refus inattendu");
}

test("dev:try n'envoie jamais de vrai SMS : le fournisseur et sa clé de votre terminal ne sont PAS transmis au serveur", () => {
  for (const env of [{ NOMA_SMS_PROVIDER: "none", NOMA_SMS_API_KEY: KEY }, { NOMA_SMS_API_KEY: KEY, NOMA_SMS_BASE_URL: "https://meno.sublymus.com/api/external/sms" }, { NOMA_SMS_PROVIDER: "console", NOMA_SMS_API_KEY: KEY }, {}]) {
    const result = plan(env);
    assert.equal(result.smsMode, "console");
    assert.equal(result.env.NOMA_DEV_OTP_CONSOLE, "1");
    for (const name of ["NOMA_SMS_PROVIDER", "NOMA_SMS_API_KEY", "NOMA_SMS_BASE_URL"]) assert.equal(name in result.env, false, `${name} retirée`);
  }
});

test("meno : refusé vers une base qui n'est pas de ce poste, sans base, ou avec une clé invalide ; le refus ne montre jamais la clé", () => {
  const refusals = [
    { NOMA_SMS_PROVIDER: "meno", NOMA_SMS_API_KEY: KEY },
    { NOMA_SMS_PROVIDER: "meno", NOMA_SMS_API_KEY: KEY, NOMA_SMS_BASE_URL: "https://meno.sublymus.com/api/external/sms" },
    { NOMA_SMS_PROVIDER: "meno", NOMA_SMS_API_KEY: KEY, NOMA_SMS_BASE_URL: "http://127.0.0.1.evil.example:4010" },
    { NOMA_SMS_PROVIDER: "meno", NOMA_SMS_API_KEY: "court", NOMA_SMS_BASE_URL: "http://127.0.0.1:4010" },
    { NOMA_SMS_PROVIDER: "meno", NOMA_SMS_BASE_URL: "http://127.0.0.1:4010" },
  ];
  for (const env of refusals) {
    const prepared = prepareDevTry({ ...BASE, ...env }, random);
    assert.equal(prepared.ok, false, JSON.stringify(env));
    if (!prepared.ok) {
      assert.match(prepared.reason, /n'envoie jamais de vrai SMS/);
      assert.equal(prepared.reason.includes(KEY), false);
    }
  }
});

test("meno vers un faux serveur local : transport console retiré, clé et base transmises, URL publique = origine du relais", () => {
  const result = plan({ NOMA_SMS_PROVIDER: "meno", NOMA_SMS_API_KEY: KEY, NOMA_SMS_BASE_URL: "http://127.0.0.1:4010/", NOMA_DEV_NOTIFY_CONSOLE: "1", NOMA_DEV_TRY_PORT: "3222", NOMA_DEV_TRY_NEXT_PORT: "3221" });
  assert.equal(result.smsMode, "meno-local");
  assert.equal(result.env.NOMA_SMS_PROVIDER, "meno");
  assert.equal(result.env.NOMA_SMS_API_KEY, KEY);
  assert.equal(result.env.NOMA_SMS_BASE_URL, "http://127.0.0.1:4010");
  assert.equal(result.env.NOMA_PUBLIC_URL, "http://localhost:3222");
  assert.equal(result.env.NOMA_PUBLIC_URL, result.publicOrigin);
  assert.equal("NOMA_DEV_OTP_CONSOLE" in result.env, false);
  assert.equal("NOMA_DEV_NOTIFY_CONSOLE" in result.env, false);
  assert.equal(result.env.NODE_ENV, "development");
  assert.ok(result.warnings.some((line) => /faux serveur de ce poste/.test(line)));
  assert.equal(result.warnings.some((line) => line.includes(KEY)), false);
  assert.equal(plan({ NOMA_SMS_PROVIDER: "meno", NOMA_SMS_API_KEY: KEY, NOMA_SMS_BASE_URL: "http://localhost:4010" }).smsMode, "meno-local");
});
