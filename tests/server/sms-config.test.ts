import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { register } from "../../instrumentation";
import { runStartupChecks } from "../../lib/server/startup-guard";
import { assertProductionConfig, loadConfig } from "../../lib/server/config";
import type { SendOtp } from "../../lib/server/auth/types";
import type { NotificationTransport } from "../../lib/server/notifications/transport";
import {
  MENO_DEFAULT_BASE_URL,
  SMS_DEFAULT_DAILY_CAP,
  assertSmsProductionConfig,
  isMenoActive,
  isValidSmsApiKey,
  menoInactiveReason,
  readSmsConfig,
} from "../../lib/server/sms/config";
import type { SmsSender, SmsSendRequest } from "../../lib/server/sms/sender";
import { SMOKE_MESSAGE } from "../../lib/server/sms/messages";
import { parseSmokeArguments, runSmoke, smokeEnvironmentRefusal } from "../../lib/server/sms/smoke";
import { createNotificationResolverWithMeno, createOtpTransportResolver } from "../../lib/server/sms/transports";

const KEY = "fake_meno_key_for_tests_only_0001";
const SECRET = Buffer.alloc(32, 7).toString("base64");
const PRODUCTION = {
  NODE_ENV: "production",
  NOMA_SMS_PROVIDER: "meno",
  NOMA_SMS_API_KEY: KEY,
  NOMA_PUBLIC_URL: "https://noma.example.ci",
  NOMA_AUTH_SECRET: SECRET,
};

test("défauts : fournisseur désactivé, base officielle, plafond 1000, aucune clé", () => {
  const config = readSmsConfig({});
  assert.equal(config.provider, "none");
  assert.equal(config.apiKey, null);
  assert.equal(config.baseUrl, MENO_DEFAULT_BASE_URL);
  assert.equal(config.dailyCap, SMS_DEFAULT_DAILY_CAP);
  assert.equal(isMenoActive(config), false);
  assert.equal(isMenoActive(readSmsConfig({ NOMA_SMS_PROVIDER: "" })), false);
});

const ACTIVE = { NODE_ENV: "production", NOMA_SMS_PROVIDER: "meno", NOMA_SMS_API_KEY: KEY };

test("activation : meno ET une clé valide (en production), jamais sans clé ni avec une clé invalide ni avec un autre fournisseur", () => {
  assert.equal(isMenoActive(readSmsConfig(ACTIVE)), true);
  assert.equal(isMenoActive(readSmsConfig({ ...ACTIVE, NOMA_SMS_PROVIDER: "meno", NOMA_SMS_API_KEY: undefined })), false, "meno sans clé");
  assert.equal(isMenoActive(readSmsConfig({ ...ACTIVE, NOMA_SMS_API_KEY: "   " })), false, "clé vide");
  assert.equal(isMenoActive(readSmsConfig({ ...ACTIVE, NOMA_SMS_API_KEY: "court" })), false, "clé de format invalide");
  for (const provider of ["none", "console", "", "Meno", "twilio"]) assert.equal(isMenoActive(readSmsConfig({ ...ACTIVE, NOMA_SMS_PROVIDER: provider })), false, provider);
  assert.equal(isMenoActive(readSmsConfig({ ...ACTIVE, NOMA_SMS_BASE_URL: "ftp://x" })), false, "base invalide");
  assert.equal(isMenoActive(readSmsConfig({ ...ACTIVE, NOMA_SMS_DAILY_CAP: "0" })), false, "plafond invalide");
  assert.equal(isMenoActive(readSmsConfig({ ...ACTIVE, NOMA_SMS_NOTIFICATION_SHARE_PERCENT: "0" })), false, "part des notifications invalide");
  assert.equal(isMenoActive(readSmsConfig({ ...ACTIVE, NOMA_SMS_EXISTING_RESERVE_PERCENT: "95" })), false, "réserve invalide");
  assert.match(menoInactiveReason(readSmsConfig({ ...ACTIVE, NOMA_SMS_API_KEY: undefined })) ?? "", /NOMA_SMS_API_KEY est absente/);
  assert.match(menoInactiveReason(readSmsConfig({ ...ACTIVE, NOMA_SMS_API_KEY: "court" })) ?? "", /format invalide/);
  assert.match(menoInactiveReason(readSmsConfig({ ...ACTIVE, NOMA_SMS_NOTIFICATION_SHARE_PERCENT: "0" })) ?? "", /NOMA_SMS_NOTIFICATION_SHARE_PERCENT/);
  assert.equal(menoInactiveReason(readSmsConfig(ACTIVE)), null);
});

test("C4 — NODE_ENV=test : jamais de vrai SMS, seulement vers un faux serveur de ce poste", () => {
  const base = { NODE_ENV: "test", NOMA_SMS_PROVIDER: "meno", NOMA_SMS_API_KEY: KEY };
  assert.equal(isMenoActive(readSmsConfig(base)), false, "base officielle en test : inactif");
  assert.equal(isMenoActive(readSmsConfig({ ...base, NOMA_SMS_BASE_URL: "https://meno.sublymus.com/api/external/sms" })), false);
  assert.equal(isMenoActive(readSmsConfig({ ...base, NOMA_SMS_BASE_URL: "http://127.0.0.1:4010" })), true);
  assert.equal(isMenoActive(readSmsConfig({ ...base, NOMA_SMS_BASE_URL: "http://localhost:4010/base" })), true);
  assert.equal(isMenoActive(readSmsConfig({ ...base, NOMA_SMS_BASE_URL: "http://127.0.0.1.evil.example/base" })), false);
  assert.match(menoInactiveReason(readSmsConfig(base)) ?? "", /hors production/);
});

test("C4 — le transport meno n'est installé que si NODE_ENV vaut exactement « production » OU si la base de l'API est locale (development, absent, staging, « Test »… : aucun transport)", () => {
  const credentials = { NOMA_SMS_PROVIDER: "meno", NOMA_SMS_API_KEY: KEY };
  const official = "https://meno.sublymus.com/api/external/sms";
  for (const nodeEnv of [undefined, "", "development", "staging", "recette", "test", "Test", "TEST", "Production", "PRODUCTION", " production", "production ", "prod"]) {
    const env = { ...credentials, NODE_ENV: nodeEnv };
    assert.equal(isMenoActive(readSmsConfig(env)), false, `NODE_ENV=${JSON.stringify(nodeEnv)}, base par défaut`);
    assert.equal(isMenoActive(readSmsConfig({ ...env, NOMA_SMS_BASE_URL: official })), false, `NODE_ENV=${JSON.stringify(nodeEnv)}, base officielle explicite`);
    assert.match(menoInactiveReason(readSmsConfig(env)) ?? "", /hors production/, `NODE_ENV=${JSON.stringify(nodeEnv)} : motif`);
    // Vers un faux serveur de ce poste (127.0.0.1, localhost, [::1] exacts) : permis, quel que soit NODE_ENV.
    for (const local of ["http://127.0.0.1:4010", "http://localhost:4010/base", "http://[::1]:4010"]) {
      assert.equal(isMenoActive(readSmsConfig({ ...env, NOMA_SMS_BASE_URL: local })), true, `NODE_ENV=${JSON.stringify(nodeEnv)}, ${local}`);
    }
    // Sosies et variantes : ce n'est PAS ce poste.
    for (const lookalike of ["http://127.0.0.1.evil.example/api", "http://localhost.evil.example/api", "http://127.0.0.2:4010", "http://0.0.0.0:4010", "http://10.0.0.5:4010", "http://evil.example/127.0.0.1", "http://user@127.0.0.1:4010"]) {
      assert.equal(isMenoActive(readSmsConfig({ ...env, NOMA_SMS_BASE_URL: lookalike })), false, `NODE_ENV=${JSON.stringify(nodeEnv)}, ${lookalike}`);
    }
  }
  // « production » exact : actif, base officielle comprise.
  assert.equal(isMenoActive(readSmsConfig({ ...credentials, NODE_ENV: "production" })), true);
  assert.equal(isMenoActive(readSmsConfig({ ...credentials, NODE_ENV: "production", NOMA_SMS_BASE_URL: official })), true);
});

test("C4 — les résolveurs n'installent aucun transport hors production avec la base officielle, et n'écrivent JAMAIS la clé dans l'avertissement", () => {
  const sender = recordingSender().sender;
  const warnings: string[] = [];
  const otp = createOtpTransportResolver(() => undefined, { warn: (line) => warnings.push(line), resolveSender: () => sender });
  const notification = createNotificationResolverWithMeno(() => undefined, { warn: (line) => warnings.push(line), resolveSender: () => sender });
  for (const nodeEnv of ["development", undefined, "staging", "Test", "test"]) {
    const env = { NODE_ENV: nodeEnv, NOMA_SMS_PROVIDER: "meno", NOMA_SMS_API_KEY: KEY, NOMA_PUBLIC_URL: "https://noma.example.ci" };
    assert.equal(otp(env), undefined, `OTP, NODE_ENV=${String(nodeEnv)}`);
    assert.equal(notification(env), undefined, `notification, NODE_ENV=${String(nodeEnv)}`);
  }
  assert.ok(warnings.length >= 1, "un avertissement fixe est émis");
  for (const line of warnings) {
    assert.equal(line.includes(KEY), false, "la clé n'est jamais dans l'avertissement");
    assert.match(line, /aucun transport/);
  }
  // En production, ou vers un faux serveur local : le transport existe.
  const env = { NODE_ENV: "production", NOMA_SMS_PROVIDER: "meno", NOMA_SMS_API_KEY: KEY, NOMA_PUBLIC_URL: "https://noma.example.ci" };
  assert.ok(otp(env));
  assert.ok(notification(env));
  assert.ok(otp({ ...env, NODE_ENV: "development", NOMA_SMS_BASE_URL: "http://127.0.0.1:4010" }));
});

test("format de la clé : coquilles refusées (espaces, guillemets, valeur d'exemple, retour à la ligne, trop courte ou trop longue)", () => {
  for (const good of [KEY, "a".repeat(16), "A1b2C3d4E5f6G7h8", "cle_essai.abc-DEF_123456+/=", "x".repeat(256)]) assert.equal(isValidSmsApiKey(good), true, good);
  for (const bad of ["", "a".repeat(15), "x".repeat(257), "avec espace 0123456789", '"quoted_key_0123456789"', "<clé fournie par Meno>", "key\n0123456789abcdef", "clé_accentuée_0123456789", undefined, null, 12345678901234567]) {
    assert.equal(isValidSmsApiKey(bad), false, String(bad));
  }
  // Espaces autour : rognés par la lecture, pas par le contrôle.
  assert.equal(readSmsConfig({ NOMA_SMS_API_KEY: `  ${KEY}  ` }).apiKey, KEY);
});

test("URL de base : slash final retiré, identifiants ou requête refusés ; URL publique : origine seulement", () => {
  assert.equal(readSmsConfig({ NOMA_SMS_BASE_URL: "http://127.0.0.1:4010/api/" }).baseUrl, "http://127.0.0.1:4010/api");
  for (const bad of ["http://user:pass@host.example/api", "https://host.example/api?x=1", "https://host.example/api#f", "not a url", "file:///etc"]) {
    assert.equal(readSmsConfig({ NOMA_SMS_BASE_URL: bad }).baseUrlValid, false, bad);
  }
  assert.equal(readSmsConfig({ NOMA_PUBLIC_URL: "https://noma.example.ci/" }).publicUrl, "https://noma.example.ci");
  assert.equal(readSmsConfig({ NOMA_PUBLIC_URL: "http://localhost:3212" }).publicUrl, "http://localhost:3212");
  for (const bad of ["https://noma.example.ci/app", "https://noma.example.ci?x=1", "noma.example.ci", "javascript:alert(1)", "https://u:p@noma.example.ci"]) {
    assert.equal(readSmsConfig({ NOMA_PUBLIC_URL: bad }).publicUrl, null, bad);
  }
});

test("production : refus de démarrer sans clé, avec une clé invalide, ou avec une configuration incohérente", () => {
  assert.doesNotThrow(() => assertSmsProductionConfig(PRODUCTION));
  assert.doesNotThrow(() => assertSmsProductionConfig({ NODE_ENV: "production" }), "pas de fournisseur : démarrage permis");
  assert.doesNotThrow(() => assertSmsProductionConfig({ NODE_ENV: "production", NOMA_SMS_PROVIDER: "none" }));
  const refusals: Array<[Record<string, string | undefined>, RegExp]> = [
    [{ NOMA_SMS_API_KEY: undefined }, /^Error: NOMA_SMS_API_KEY requis en production avec NOMA_SMS_PROVIDER=meno$/],
    [{ NOMA_SMS_API_KEY: "" }, /NOMA_SMS_API_KEY requis/],
    [{ NOMA_SMS_API_KEY: "   " }, /NOMA_SMS_API_KEY requis/],
    [{ NOMA_SMS_API_KEY: "court" }, /^Error: NOMA_SMS_API_KEY invalide \(format\)$/],
    [{ NOMA_SMS_API_KEY: '"quoted_key_0123456789"' }, /invalide \(format\)/],
    [{ NOMA_SMS_BASE_URL: "http://meno.example/api" }, /NOMA_SMS_BASE_URL invalide en production \(https exigé\)/],
    [{ NOMA_SMS_BASE_URL: "n'importe quoi" }, /NOMA_SMS_BASE_URL invalide/],
    [{ NOMA_PUBLIC_URL: undefined }, /NOMA_PUBLIC_URL requis/],
    [{ NOMA_PUBLIC_URL: "http://noma.example.ci" }, /NOMA_PUBLIC_URL requis/],
    [{ NOMA_PUBLIC_URL: "https://noma.example.ci/app" }, /NOMA_PUBLIC_URL requis/],
    [{ NOMA_SMS_DAILY_CAP: "0" }, /NOMA_SMS_DAILY_CAP invalide/],
    [{ NOMA_SMS_DAILY_CAP: "abc" }, /NOMA_SMS_DAILY_CAP invalide/],
    [{ NOMA_SMS_DAILY_CAP: "100001" }, /NOMA_SMS_DAILY_CAP invalide/],
    [{ NOMA_AUTH_SECRET: undefined }, /NOMA_AUTH_SECRET requis/],
    [{ NOMA_AUTH_SECRET: "trop-court" }, /NOMA_AUTH_SECRET requis/],
    [{ NOMA_SMS_PROVIDER: "console" }, /NOMA_SMS_PROVIDER=console interdit en production/],
    [{ NOMA_SMS_PROVIDER: "twilio" }, /NOMA_SMS_PROVIDER invalide en production/],
    [{ NOMA_SMS_PROVIDER: "Meno" }, /NOMA_SMS_PROVIDER invalide en production/],
  ];
  for (const [change, pattern] of refusals) {
    const env = { ...PRODUCTION, ...change };
    assert.throws(() => assertSmsProductionConfig(env), pattern, JSON.stringify(change));
    // Le message nomme la variable, jamais sa valeur.
    try {
      assertSmsProductionConfig(env);
    } catch (error) {
      assert.equal(String((error as Error).message).includes(KEY), false);
      assert.equal(String((error as Error).message).includes(SECRET), false);
    }
  }
  // Hors production : aucune vérification.
  for (const nodeEnv of ["development", "test", undefined, "staging"]) {
    assert.doesNotThrow(() => assertSmsProductionConfig({ NODE_ENV: nodeEnv, NOMA_SMS_PROVIDER: "meno" }), String(nodeEnv));
    assert.doesNotThrow(() => assertSmsProductionConfig({ NODE_ENV: nodeEnv, NOMA_SMS_PROVIDER: "console" }), String(nodeEnv));
  }
});

test("assertProductionConfig (protection de recherche) applique aussi la règle SMS", () => {
  const env = { ...PRODUCTION, NOMA_TURNSTILE_SECRET: "t", NOMA_IP_SECRET: "i" };
  assert.doesNotThrow(() => assertProductionConfig(loadConfig(env), env));
  const broken = { ...env, NOMA_SMS_API_KEY: undefined };
  assert.throws(() => assertProductionConfig(loadConfig(broken), broken), /NOMA_SMS_API_KEY requis en production/);
});

test("instrumentation.register : en production, le contrôle SMS journalise le message fixe puis TERMINE le processus (code 78) ; l'edge et le développement ne vérifient rien", async () => {
  // Le processus réel est terminé par `register` (vérifié par un vrai processus dans tests/server/startup-guard.test.ts) : ici, la sortie est injectée.
  const refuse = (env: Record<string, string | undefined>): { logs: string[]; exits: number[]; thrown: unknown } => {
    const logs: string[] = [];
    const exits: number[] = [];
    let thrown: unknown = null;
    try {
      runStartupChecks(env, { log: (message) => logs.push(message), exit: (code) => { exits.push(code); } });
    } catch (error) {
      thrown = error;
    }
    return { logs, exits, thrown };
  };
  const withoutKey = refuse({ ...PRODUCTION, NOMA_SMS_API_KEY: undefined });
  assert.deepEqual(withoutKey.exits, [78]);
  assert.equal(withoutKey.logs.length, 1);
  assert.match(withoutKey.logs[0], /NOMA_SMS_API_KEY requis en production/);
  assert.match(String(withoutKey.thrown), /NOMA_SMS_API_KEY requis en production/, "le démarrage n'est jamais réputé réussi, même si la sortie revenait");
  const shortKey = refuse({ ...PRODUCTION, NOMA_SMS_API_KEY: "court" });
  assert.deepEqual(shortKey.exits, [78]);
  assert.match(shortKey.logs[0], /invalide \(format\)/);
  const valid = refuse({ ...PRODUCTION });
  assert.deepEqual(valid.exits, []);
  assert.deepEqual(valid.logs, []);
  assert.equal(valid.thrown, null);

  const environment = process.env as Record<string, string | undefined>;
  const names = ["NEXT_RUNTIME", "NODE_ENV", "NOMA_SMS_PROVIDER", "NOMA_SMS_API_KEY", "NOMA_PUBLIC_URL", "NOMA_AUTH_SECRET", "NOMA_SMS_BASE_URL", "NOMA_SMS_DAILY_CAP"];
  const saved = Object.fromEntries(names.map((name) => [name, environment[name]]));
  const apply = (values: Record<string, string | undefined>) => {
    for (const name of names) {
      const value = name in values ? values[name] : undefined;
      if (value === undefined) delete environment[name];
      else environment[name] = value;
    }
  };
  try {
    apply({ ...PRODUCTION, NEXT_RUNTIME: "nodejs" });
    await register();
    apply({ ...PRODUCTION, NEXT_RUNTIME: "edge", NOMA_SMS_API_KEY: undefined });
    await register();
    apply({ ...PRODUCTION, NEXT_RUNTIME: "nodejs", NODE_ENV: "development", NOMA_SMS_API_KEY: undefined });
    await register();
  } finally {
    apply(saved);
  }
});

// ───────────── commande sms:smoke ─────────────

const SMOKE_ENV = { NODE_ENV: "production", NOMA_SMS_PROVIDER: "meno", NOMA_SMS_API_KEY: KEY, DATABASE_URL: "postgresql://x:y@127.0.0.1:5432/db" };

function recordingSender(status: "accepted" | "uncertain" | "failed" = "accepted"): { sender: SmsSender; calls: SmsSendRequest[] } {
  const calls: SmsSendRequest[] = [];
  return {
    calls,
    sender: {
      async send(request) {
        calls.push(request);
        return { status, errorCode: status === "accepted" ? null : "x", httpStatus: status === "accepted" ? 202 : 503, providerId: "msg_000001", attempts: 1, skipped: false };
      },
    },
  };
}

test("sms:smoke : les DEUX options sont exigées, rien n'est envoyé sans --confirm-real-send", async () => {
  assert.deepEqual(parseSmokeArguments(["--to", "+2250700000012", "--confirm-real-send"]), { ok: true, to: "+2250700000012" });
  assert.deepEqual(parseSmokeArguments(["--confirm-real-send", "--to=+2250700000012"]), { ok: true, to: "+2250700000012" });
  for (const argv of [[], ["--to", "+2250700000012"], ["--confirm-real-send"], ["--to", "+33612345678", "--confirm-real-send"], ["--to", "--confirm-real-send"], ["--to", "+2250700000012", "--confirm-real-send", "--force"], ["+2250700000012", "--confirm-real-send"]]) {
    assert.equal(parseSmokeArguments(argv).ok, false, argv.join(" "));
  }
  const { sender, calls } = recordingSender();
  const lines: string[] = [];
  assert.equal(await runSmoke(["--to", "+2250700000012"], SMOKE_ENV, { sender, write: (line) => lines.push(line) }), 2);
  assert.equal(await runSmoke(["--confirm-real-send"], SMOKE_ENV, { sender, write: (line) => lines.push(line) }), 2);
  assert.equal(calls.length, 0, "aucun envoi sans les deux options");
  assert.match(lines[0], /--confirm-real-send/);
});

test("sms:smoke : refus si NODE_ENV=test, clé absente ou invalide, fournisseur autre que meno, DATABASE_URL absente", async () => {
  const refusals: Array<Record<string, string | undefined>> = [
    { NODE_ENV: "test" },
    // Lot SMS1-bis (C4) : hors production, la base officielle est refusée (le fichier d'environnement du serveur fixe NODE_ENV=production).
    { NODE_ENV: "development" },
    { NODE_ENV: undefined },
    { NODE_ENV: "staging" },
    // Même vers un faux serveur de ce poste (où le transport serait actif), la commande d'envoi RÉEL refuse NODE_ENV=test.
    { NODE_ENV: "test", NOMA_SMS_BASE_URL: "http://127.0.0.1:4010" },
    { NOMA_SMS_API_KEY: undefined },
    { NOMA_SMS_API_KEY: "court" },
    { NOMA_SMS_PROVIDER: "console" },
    { NOMA_SMS_PROVIDER: undefined },
    { DATABASE_URL: undefined },
    { DATABASE_URL: "  " },
  ];
  for (const change of refusals) {
    const env = { ...SMOKE_ENV, ...change };
    assert.notEqual(smokeEnvironmentRefusal(env), null, JSON.stringify(change));
    const { sender, calls } = recordingSender();
    assert.equal(await runSmoke(["--to", "+2250700000012", "--confirm-real-send"], env, { sender, write: () => {} }), 2);
    assert.equal(calls.length, 0, JSON.stringify(change));
  }
  assert.equal(smokeEnvironmentRefusal(SMOKE_ENV), null);
});

test("sms:smoke : un envoi journalisé, clé neuve à chaque lancement, aucune clé ni numéro entier affichés", async () => {
  const { sender, calls } = recordingSender();
  const lines: string[] = [];
  assert.equal(await runSmoke(["--to", "+2250700000012", "--confirm-real-send"], SMOKE_ENV, { sender, write: (line) => lines.push(line) }), 0);
  assert.equal(await runSmoke(["--to", "+2250700000012", "--confirm-real-send"], SMOKE_ENV, { sender, write: (line) => lines.push(line) }), 0);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].purpose, "smoke");
  assert.equal(calls[0].content, SMOKE_MESSAGE);
  assert.equal(calls[0].to, "+2250700000012");
  assert.match(calls[0].idempotencyKey, /^smoke-[0-9]{14}-[0-9a-f]{8}$/);
  assert.notEqual(calls[0].idempotencyKey, calls[1].idempotencyKey);
  const output = lines.join("\n");
  assert.equal(output.includes(KEY), false);
  assert.equal(output.includes("2250700000012"), false);
  assert.equal(output.includes("0700000012"), false);
  assert.match(output, /PAS une preuve de livraison/);
  assert.equal(await runSmoke(["--to", "+2250700000012", "--confirm-real-send"], SMOKE_ENV, { sender: recordingSender("uncertain").sender, write: (line) => lines.push(line) }), 1);
  assert.match(lines.at(-1) ?? "", /Ne relancez pas|rapprochez/);
  assert.equal(await runSmoke(["--to", "+2250700000012", "--confirm-real-send"], SMOKE_ENV, { sender: recordingSender("failed").sender, write: () => {} }), 1);
});

// ───────────── résolveurs de transport ─────────────

const devOtp: SendOtp = async () => {};
const devNotification: NotificationTransport = { channel: "sms_sim", async send() {} };
const fakeSender: SmsSender = recordingSender().sender;

test("OTP : sans meno le transport de développement reste celui du résolveur de développement, inchangé", () => {
  const warnings: string[] = [];
  const resolve = createOtpTransportResolver(() => devOtp, { warn: (line) => warnings.push(line), resolveSender: () => fakeSender });
  assert.equal(resolve({}), devOtp);
  assert.equal(resolve({ NOMA_SMS_PROVIDER: "none" }), devOtp);
  assert.equal(resolve({ NOMA_SMS_PROVIDER: "console", NOMA_SMS_API_KEY: KEY }), devOtp);
  assert.deepEqual(warnings, []);
});

test("OTP : meno actif → transport réel ; meno sans clé ou clé invalide → AUCUN transport (jamais de repli sur la console)", () => {
  const warnings: string[] = [];
  const resolve = createOtpTransportResolver(() => devOtp, { warn: (line) => warnings.push(line), resolveSender: () => fakeSender });
  const active = resolve(ACTIVE);
  assert.ok(active && active !== devOtp);
  assert.equal(typeof active.timeoutMs, "number");
  assert.ok((active.timeoutMs ?? 0) > 10_000, "délai de garde plus long que le défaut de 10 s");
  assert.equal(resolve({ NODE_ENV: "production", NOMA_SMS_PROVIDER: "meno" }), undefined);
  assert.equal(resolve({ NODE_ENV: "production", NOMA_SMS_PROVIDER: "meno", NOMA_SMS_API_KEY: "court" }), undefined);
  assert.equal(resolve({ NOMA_SMS_PROVIDER: "meno", NOMA_DEV_OTP_CONSOLE: "1", NODE_ENV: "development" }), undefined, "pas de repli sur la console de développement");
  assert.equal(warnings.length, 3, "un avertissement par motif (clé absente, format invalide, drapeau ambigu)");
  assert.equal(warnings.some((line) => line.includes(KEY)), false);
  // Sans expéditeur (résolution réelle indisponible) : aucun transport.
  const noSender = createOtpTransportResolver(() => devOtp, { warn: () => {}, resolveSender: () => undefined });
  assert.equal(noSender(ACTIVE), undefined);
});

test("OTP : meno ET drapeau de développement = ambigu, aucun transport", () => {
  const warnings: string[] = [];
  const resolve = createOtpTransportResolver(() => devOtp, { warn: (line) => warnings.push(line), resolveSender: () => fakeSender });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    assert.equal(resolve({ NOMA_SMS_PROVIDER: "meno", NOMA_SMS_API_KEY: KEY, NOMA_DEV_OTP_CONSOLE: "1", NODE_ENV: "development" }), undefined);
  }
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /incompatibles/);
});

test("notifications : transport réel seulement avec la clé ET NOMA_PUBLIC_URL ; sinon aucun (pas de repli sur la console)", () => {
  const warnings: string[] = [];
  const resolve = createNotificationResolverWithMeno(() => devNotification, { warn: (line) => warnings.push(line), resolveSender: () => fakeSender });
  assert.equal(resolve({}), devNotification);
  assert.equal(resolve({ NOMA_SMS_PROVIDER: "none" }), devNotification);
  const active = resolve({ ...ACTIVE, NOMA_PUBLIC_URL: "https://noma.example.ci" });
  assert.ok(active);
  assert.equal(active.channel, "sms_meno");
  assert.ok((active.timeoutMs ?? 0) > 5_000);
  assert.equal(resolve(ACTIVE), undefined, "NOMA_PUBLIC_URL manquante");
  assert.equal(resolve({ NODE_ENV: "production", NOMA_SMS_PROVIDER: "meno", NOMA_PUBLIC_URL: "https://noma.example.ci" }), undefined, "clé manquante");
  assert.equal(resolve({ NOMA_SMS_PROVIDER: "meno", NOMA_SMS_API_KEY: KEY, NOMA_PUBLIC_URL: "https://noma.example.ci", NOMA_DEV_NOTIFY_CONSOLE: "1", NODE_ENV: "development" }), undefined);
  assert.equal(warnings.some((line) => line.includes(KEY)), false);
});

// ───────────── la clé reste côté serveur ─────────────

function listFiles(directory: string, into: string[] = []): string[] {
  for (const entry of readdirSync(directory)) {
    if (entry === "node_modules" || entry === ".next" || entry.startsWith(".")) continue;
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) listFiles(path, into);
    else if (/\.(ts|tsx|js|jsx|mjs)$/.test(entry)) into.push(path);
  }
  return into;
}

test("la clé du fournisseur n'est lue que par le serveur : aucun fichier client ne la nomme ni n'importe le module SMS", () => {
  const root = join(import.meta.dirname, "..", "..");
  const clientFiles = [...listFiles(join(root, "components")), ...listFiles(join(root, "lib", "client")), ...listFiles(join(root, "app"))].filter((path) => {
    const relativePath = relative(root, path);
    if (relativePath.startsWith(join("app", "api"))) return false;
    if (relativePath.endsWith("route.ts") || relativePath.endsWith("layout.tsx")) return false;
    return true;
  });
  assert.ok(clientFiles.length > 50, "les fichiers du navigateur ont bien été trouvés");
  for (const path of clientFiles) {
    const text = readFileSync(path, "utf8");
    assert.equal(text.includes("NOMA_SMS_API_KEY"), false, `${relative(root, path)} nomme la clé`);
    assert.equal(/from\s+["'][^"']*\/sms\/[^"']*["']/.test(text), false, `${relative(root, path)} importe le module SMS serveur`);
    if (text.includes('"use client"')) assert.equal(/lib\/server/.test(text.replaceAll(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "")), false, `${relative(root, path)} (client) importe du code serveur`);
  }
  // Aucune variable NEXT_PUBLIC_ pour le SMS (elle serait copiée dans le bundle du navigateur).
  for (const path of listFiles(root).filter((file) => !file.includes(`${join("tests", "server", "sms-config.test.ts")}`))) {
    assert.equal(/NEXT_PUBLIC_[A-Z_]*SMS/.test(readFileSync(path, "utf8")), false, relative(root, path));
  }
});

test("config.ts reste PUR : il n'importe que des modules purs (dev:try et le démarrage le lisent hors du contexte « server-only »)", () => {
  const root = join(import.meta.dirname, "..", "..", "lib", "server", "sms");
  const pure = new Set(["config.ts", "budget.ts", "gsm7.ts", "notification-text.ts"]);
  for (const name of pure) {
    const code = readFileSync(join(root, name), "utf8").replaceAll(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    assert.equal(/["']server-only["']/.test(code), false, `${name} importe server-only`);
    for (const match of code.matchAll(/from\s+["']([^"']+)["']/g)) {
      const target = match[1];
      assert.ok(target.startsWith("./") && pure.has(`${target.slice(2)}.ts`), `${name} importe ${target}, qui n'est pas dans l'ensemble pur`);
    }
  }
});

test("deploy/env.production.example : les variables SMS y figurent, VIDES (aucune clé versionnée)", () => {
  const root = join(import.meta.dirname, "..", "..");
  const example = readFileSync(join(root, "deploy", "env.production.example"), "utf8");
  for (const name of ["NOMA_SMS_PROVIDER", "NOMA_SMS_API_KEY", "NOMA_SMS_BASE_URL", "NOMA_PUBLIC_URL", "NOMA_SMS_DAILY_CAP", "NOMA_SMS_NOTIFICATION_SHARE_PERCENT", "NOMA_SMS_EXISTING_RESERVE_PERCENT"]) {
    assert.equal(example.split("\n").filter((line) => line === `${name}=`).length, 1, `${name} présente, vide`);
    assert.equal(new RegExp(`^${name}=.`, "m").test(example), false, `${name} sans valeur`);
  }
  const selftest = readFileSync(join(root, "deploy", "selftest.sh"), "utf8");
  assert.match(selftest, /NOMA_SMS_API_KEY/, "la vérification de déploiement contrôle les variables SMS");
});
