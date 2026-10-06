import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { CatalogValidationError } from "../../lib/server/catalog/errors";
import { assertProductionConfig, loadConfig, PRODUCTION_FORBIDDEN_ENV } from "../../lib/server/config";
import {
  FAKE_SIGNATURE_HEADER, FAKE_SIGNATURE_TOLERANCE_SECONDS, FAKE_WEBHOOK_MAX_BODY_BYTES, TOPUP_EXPIRY_SECONDS, TOPUP_MAX_PENDING,
  TOPUP_MAX_XOF, TOPUP_MIN_XOF, TOPUP_STEP_XOF, WALLET_CONTRACT_VERSION, WALLET_MAX_SAFE_AMOUNT, WALLET_TOPUP_LOCK_NAMESPACE,
} from "../../lib/server/wallet/config";
import { WALLET_ERROR_MESSAGES, WalletError, type WalletErrorCode } from "../../lib/server/wallet/errors";
import {
  buildFakePaymentEventBody, FAKE_PAYMENT_ALLOWED_NODE_ENVS, FakeEventError, parseFakePaymentEvent, resolveFakePaymentConfig,
  signFakePaymentBody, verifyFakePaymentSignature,
} from "../../lib/server/wallet/fake-provider";
import {
  decodeWalletCursor, encodeWalletCursor, requireLedgerAmount, validateWalletTransactionInput,
} from "../../lib/server/wallet/ledger";
import { parseStrictJson, StrictJsonError, type StrictJsonReason } from "../../lib/server/wallet/strict-json";
import { decideProviderEventOutcome, requireIdempotencyKey, requireTopupAmount } from "../../lib/server/wallet/topups";

const SECRET = "s".repeat(40);
const NOW = new Date(Date.UTC(2032, 5, 1, 12, 0, 0));
const NOW_SECONDS = NOW.getTime() / 1000;
const big = (value: number | string): bigint => BigInt(value);
const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

function strictReason(text: string): StrictJsonReason | "ok" {
  try { parseStrictJson(text); return "ok"; } catch (error) {
    if (error instanceof StrictJsonError) return error.reason;
    throw error;
  }
}

function eventReason(body: string | Uint8Array, now: Date = NOW): string {
  try { parseFakePaymentEvent(typeof body === "string" ? bytes(body) : body, now); return "ok"; } catch (error) {
    if (error instanceof FakeEventError) return error.reason;
    throw error;
  }
}

const validEvent = (override: Record<string, unknown> = {}): string => JSON.stringify({
  id: "evt_00000001", type: "payment.succeeded", timestamp: NOW_SECONDS, providerReference: "fakepay_00000001", amountXof: 5000, ...override,
});

test("configuration de code : bornes de recharge, expiration, limite, tolérance, plafond du webhook, espace de verrou distinct", () => {
  assert.equal(TOPUP_MIN_XOF, 500);
  assert.equal(TOPUP_MAX_XOF, 500_000);
  assert.equal(TOPUP_STEP_XOF, 100);
  assert.equal(TOPUP_MAX_PENDING, 5);
  assert.equal(TOPUP_EXPIRY_SECONDS, 1_800);
  assert.equal(FAKE_SIGNATURE_TOLERANCE_SECONDS, 300);
  assert.equal(FAKE_WEBHOOK_MAX_BODY_BYTES, 8_192);
  assert.equal(FAKE_SIGNATURE_HEADER, "x-noma-fake-signature");
  assert.equal(WALLET_CONTRACT_VERSION, "wallet/v1");
  assert.equal(WALLET_MAX_SAFE_AMOUNT, big("9007199254740991"));
  assert.ok(![1_314_664_945, 1_314_664_946, 1_314_664_947, 1_314_664_948, 1_314_664_949].includes(WALLET_TOPUP_LOCK_NAMESPACE));
});

test("erreurs de domaine : un message fixe par code, sans donnée", () => {
  const codes = Object.keys(WALLET_ERROR_MESSAGES) as WalletErrorCode[];
  assert.deepEqual(codes.sort(), [
    "account_owner_not_found", "duplicate_reference", "idempotency_conflict", "insufficient_balance", "too_many_pending_topups", "unbalanced_transaction",
  ]);
  for (const code of codes) {
    const error = new WalletError(code);
    assert.equal(error.code, code);
    assert.equal(error.message, WALLET_ERROR_MESSAGES[code]);
    assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}/.test(error.message), "aucun identifiant dans le message");
  }
  assert.ok(Object.isFrozen(WALLET_ERROR_MESSAGES));
});

// ═════════════ JSON strict ═════════════

test("JSON strict : accepte les documents valides, les objets n'ont pas de prototype", () => {
  const document = parseStrictJson('  {"a": 1, "b": [true, false, null, "x"], "c": {"d": -5}}\n');
  assert.deepEqual(JSON.parse(JSON.stringify(document)), { a: 1, b: [true, false, null, "x"], c: { d: -5 } });
  assert.equal(Object.getPrototypeOf((document as Record<string, unknown>).c), null, "à tout niveau");
  const parsed = parseStrictJson('{"k":0}') as Record<string, unknown>;
  assert.equal(Object.getPrototypeOf(parsed), null);
  assert.equal(parseStrictJson("0"), 0);
  assert.equal(parseStrictJson("9007199254740991"), 9_007_199_254_740_991);
  assert.equal(parseStrictJson('"\\u00e9\\n\\"\\\\\\/"'), 'é\n"\\/');
  // « constructor » et « prototype » sont de simples données : aucun effet sur un objet sans prototype.
  const odd = parseStrictJson('{"constructor":1,"prototype":2,"toString":3}') as Record<string, number>;
  assert.deepEqual({ ...odd }, { constructor: 1, prototype: 2, toString: 3 });
  assert.equal(({} as Record<string, unknown>).constructor === Object, true, "l'objet global n'est pas pollué");
});

test("JSON strict : clés en double (à tout niveau), __proto__ (même échappé), nombres non entiers ou non sûrs, syntaxe, profondeur", () => {
  const cases: Array<[string, StrictJsonReason]> = [
    ['{"a":1,"a":2}', "duplicate_key"],
    ['{"a":{"b":1,"b":1}}', "duplicate_key"],
    ['{"a":1,"\\u0061":2}', "duplicate_key"],
    ['{"__proto__":{}}', "forbidden_key"],
    ['{"x":1,"__proto__":null}', "forbidden_key"],
    ['{"\\u005f\\u005fproto__":1}', "forbidden_key"],
    ["1.5", "non_integer_number"],
    ["1.0", "non_integer_number"],
    ["1e3", "non_integer_number"],
    ["1E3", "non_integer_number"],
    ["-0", "non_integer_number"],
    ["9007199254740992", "unsafe_integer"],
    ["9007199254740993", "unsafe_integer"],
    ["99999999999999999999", "unsafe_integer"],
    ["-9007199254740992", "unsafe_integer"],
    ["01", "trailing_content"],
    ["+1", "syntax"],
    ["-", "syntax"],
    ["NaN", "syntax"],
    ["Infinity", "syntax"],
    ["", "syntax"],
    ["   ", "syntax"],
    ["{", "syntax"],
    ['{"a":1,}', "syntax"],
    ["[1,]", "syntax"],
    ["[1 2]", "syntax"],
    ["{'a':1}", "syntax"],
    ['{"a" 1}', "syntax"],
    ['{a:1}', "syntax"],
    ['"abc', "syntax"],
    ['"a\u0001b"', "syntax"],
    ['"\\x41"', "syntax"],
    ['"\\u00zz"', "syntax"],
    ["// c\n1", "syntax"],
    ["﻿1", "syntax"],
    ["tru", "syntax"],
    ["1 2", "trailing_content"],
    ["{} {}", "trailing_content"],
    ["[]]", "trailing_content"],
    ["[[[[[[[[[1]]]]]]]]]", "too_deep"],
    ['{"a":{"a":{"a":{"a":{"a":{"a":{"a":{"a":{"a":1}}}}}}}}}', "too_deep"],
  ];
  for (const [text, reason] of cases) assert.equal(strictReason(text), reason, `texte ${JSON.stringify(text)}`);
  assert.equal(strictReason("[[[[[[[[1]]]]]]]]"), "ok", "huit niveaux imbriqués au plus");
});

// ═════════════ signature et événement du prestataire fictif ═════════════

test("signature : HMAC-SHA256 hexadécimal du corps brut, vérification stricte (forme, secret, corps)", () => {
  const body = bytes(validEvent());
  const signature = signFakePaymentBody(SECRET, body);
  assert.match(signature, /^[0-9a-f]{64}$/);
  assert.equal(signature, createHmac("sha256", SECRET).update(Buffer.from(body)).digest("hex"));
  assert.equal(signFakePaymentBody(SECRET, validEvent()), signature, "chaîne et octets : même signature");
  assert.equal(verifyFakePaymentSignature(SECRET, body, signature), true);
  assert.equal(verifyFakePaymentSignature("t".repeat(40), body, signature), false, "autre secret");
  assert.equal(verifyFakePaymentSignature(SECRET, bytes(`${validEvent()} `), signature), false, "un octet de plus");
  assert.equal(verifyFakePaymentSignature(SECRET, body, null), false, "en-tête absent");
  assert.equal(verifyFakePaymentSignature(SECRET, body, ""), false);
  assert.equal(verifyFakePaymentSignature(SECRET, body, signature.toUpperCase()), false, "majuscules refusées");
  assert.equal(verifyFakePaymentSignature(SECRET, body, `${signature}0`), false, "65 caractères");
  assert.equal(verifyFakePaymentSignature(SECRET, body, signature.slice(0, 62)), false, "62 caractères");
  assert.equal(verifyFakePaymentSignature(SECRET, body, `sha256=${signature}`), false, "préfixe refusé");
  assert.equal(verifyFakePaymentSignature(SECRET, body, "z".repeat(64)), false, "non hexadécimal");
  const flipped = `${signature.slice(0, 63)}${signature[63] === "0" ? "1" : "0"}`;
  assert.equal(verifyFakePaymentSignature(SECRET, body, flipped), false, "un seul caractère différent");
});

test("signature : comparée à temps constant (timingSafeEqual) et jamais avec ===, vérifié sur la source", () => {
  const source = readFileSync("lib/server/wallet/fake-provider.ts", "utf8");
  assert.match(source, /import \{[^}]*timingSafeEqual[^}]*\} from "node:crypto"/);
  assert.match(source, /timingSafeEqual\(Buffer\.from\(signature, "hex"\), expected\)/);
  const verify = /export function verifyFakePaymentSignature[\s\S]*?\n\}/.exec(source)?.[0] ?? "";
  assert.ok(verify.length > 0);
  assert.ok(!/[!=]==?\s*(signature|expected)|(signature|expected)\s*[!=]==?/.test(verify.replace(/signature === null/g, "")), "aucune comparaison directe de signature");
});

test("événement : forme exacte, types stricts, identifiants contrôlés, montant entier sûr positif", () => {
  assert.equal(eventReason(validEvent()), "ok");
  const parsed = parseFakePaymentEvent(bytes(validEvent({ type: "payment.failed" })), NOW);
  assert.deepEqual(parsed, {
    eventId: "evt_00000001", type: "payment.failed", timestamp: NOW_SECONDS, providerReference: "fakepay_00000001", amountXof: big(5000),
  });
  const bad: Array<[string, string]> = [
    ["invalid_shape", "[]"],
    ["invalid_shape", "null"],
    ["invalid_shape", '"texte"'],
    ["invalid_shape", "{}"],
    ["invalid_shape", JSON.stringify({ id: "evt_00000001", type: "payment.succeeded", timestamp: NOW_SECONDS, providerReference: "fakepay_00000001" })],
    ["invalid_shape", validEvent({ extra: 1 })],
    ["invalid_shape", validEvent({ data: { amountXof: 5000 } })],
    ["invalid_json", '{"id":"evt_00000001","id":"evt_00000002","type":"payment.succeeded","timestamp":1,"providerReference":"fakepay_00000001","amountXof":5000}'],
    ["invalid_json", '{"__proto__":{"admin":true},"id":"evt_00000001","type":"payment.succeeded","timestamp":1,"providerReference":"fakepay_00000001","amountXof":5000}'],
    ["invalid_json", validEvent().replace("5000", "5000.5")],
    ["invalid_json", validEvent().replace("5000", "5e3")],
    ["invalid_json", validEvent().replace("5000", "9007199254740993")],
    ["invalid_json", validEvent().replace("5000", "-0")],
    ["invalid_json", "{oops"],
    ["invalid_json", ""],
    ["invalid_json", `${validEvent()} {}`],
    ["invalid_field", validEvent({ amountXof: "5000" })],
    ["invalid_field", validEvent({ amountXof: 0 })],
    ["invalid_field", validEvent({ amountXof: -5000 })],
    ["invalid_field", validEvent({ amountXof: null })],
    ["invalid_field", validEvent({ amountXof: true })],
    ["invalid_field", validEvent({ amountXof: [5000] })],
    ["invalid_field", validEvent({ id: 12345678 })],
    ["invalid_field", validEvent({ id: "court" })],
    ["invalid_field", validEvent({ id: "a".repeat(65) })],
    ["invalid_field", validEvent({ id: "evt 0000001" })],
    ["invalid_field", validEvent({ id: "é".repeat(8) })],
    ["invalid_field", validEvent({ type: "payment.refunded" })],
    ["invalid_field", validEvent({ type: "PAYMENT.SUCCEEDED" })],
    ["invalid_field", validEvent({ type: 1 })],
    ["invalid_field", validEvent({ providerReference: "x" })],
    ["invalid_field", validEvent({ providerReference: null })],
    ["invalid_field", validEvent({ timestamp: "1790000000" })],
    ["invalid_field", validEvent({ timestamp: -1 })],
    ["invalid_field", validEvent({ timestamp: null })],
  ];
  for (const [reason, text] of bad) assert.equal(eventReason(text), reason, `corps ${text.slice(0, 90)}`);
  assert.equal(eventReason(new Uint8Array([0x7b, 0xff, 0xfe, 0x7d])), "invalid_encoding", "UTF-8 invalide");
  assert.equal(eventReason(new Uint8Array([0xef, 0xbb, 0xbf, ...bytes(validEvent())])), "invalid_json", "BOM refusé");
});

test("événement : horodatage accepté à ±300 s inclus, refusé au-delà (passé comme futur), à l'heure du serveur fournie", () => {
  for (const delta of [0, 1, -1, 299, -299, 300, -300]) {
    assert.equal(eventReason(validEvent({ timestamp: NOW_SECONDS + delta })), "ok", `delta ${delta}`);
  }
  for (const delta of [301, -301, 3600, -3600, 86_400 * 365]) {
    assert.equal(eventReason(validEvent({ timestamp: NOW_SECONDS + delta })), "timestamp_out_of_window", `delta ${delta}`);
  }
  assert.equal(eventReason(validEvent({ timestamp: NOW_SECONDS }), new Date(NOW.getTime() + 300_000)), "ok", "exactement 300 s d'écart");
  assert.equal(eventReason(validEvent({ timestamp: NOW_SECONDS }), new Date(NOW.getTime() + 300_001)), "timestamp_out_of_window", "300,001 s d'écart");
  assert.equal(eventReason(validEvent({ timestamp: 0 }), NOW), "timestamp_out_of_window");
});

test("événement : le corps fabriqué se relit à l'identique, identifiant aléatoire, montant hors limites refusé", () => {
  const built = buildFakePaymentEventBody({ type: "payment.succeeded", providerReference: "fakepay_abcdef12", amountXof: big(7500), now: NOW });
  const parsed = parseFakePaymentEvent(bytes(built), NOW);
  assert.equal(parsed.amountXof, big(7500));
  assert.equal(parsed.providerReference, "fakepay_abcdef12");
  assert.equal(parsed.timestamp, NOW_SECONDS);
  assert.match(parsed.eventId, /^evt_[0-9a-f]{32}$/);
  const other = buildFakePaymentEventBody({ type: "payment.succeeded", providerReference: "fakepay_abcdef12", amountXof: big(7500), now: NOW });
  assert.notEqual(JSON.parse(other).id, JSON.parse(built).id, "chaque événement a son identifiant");
  assert.equal(JSON.parse(buildFakePaymentEventBody({ type: "payment.failed", providerReference: "fakepay_abcdef12", amountXof: big(1), now: NOW, eventId: "evt_fixed001" })).id, "evt_fixed001");
  for (const amount of [big(0), big(-1), big("9007199254740992")]) {
    assert.throws(() => buildFakePaymentEventBody({ type: "payment.failed", providerReference: "fakepay_abcdef12", amountXof: amount, now: NOW }), RangeError);
  }
});

test("activation du prestataire fictif : liste d'AUTORISATION (NODE_ENV exactement « development » ou « test », sans espace ni changement de casse) ET drapeau « 1 » ET secret de 32 octets au moins", () => {
  const ok = { NODE_ENV: "development", NOMA_FAKE_PAYMENTS: "1", NOMA_FAKE_PAYMENT_SECRET: SECRET };
  assert.deepEqual([...FAKE_PAYMENT_ALLOWED_NODE_ENVS], ["development", "test"]);
  assert.ok(Object.isFrozen(FAKE_PAYMENT_ALLOWED_NODE_ENVS));
  assert.deepEqual(resolveFakePaymentConfig(ok), { enabled: true, secret: SECRET });
  assert.deepEqual(resolveFakePaymentConfig({ ...ok, NODE_ENV: "test" }), { enabled: true, secret: SECRET });
  // Toute autre valeur DÉSACTIVE le prestataire : « production » sous toutes ses formes, noms d'environnements voisins, vide, espaces, absent.
  const refused: Array<string | undefined> = [
    "production", " production", "production ", "\tproduction", "production\n", "Production", "PRODUCTION", "pRoDuCtIoN", "prod", "Prod", "prd",
    "staging", "preprod", "pre-production", "qa", "uat", "local", "dev", "Development", "DEVELOPMENT", " development", "development ", "development\n",
    "Test", "TEST", " test", "test ", "testing", "tests", "", " ", "undefined", "null", "0", "1", "true", undefined,
  ];
  for (const nodeEnv of refused) {
    assert.deepEqual(resolveFakePaymentConfig({ ...ok, NODE_ENV: nodeEnv }), { enabled: false, reason: "environment" }, `NODE_ENV=${JSON.stringify(nodeEnv)}`);
  }
  assert.deepEqual(resolveFakePaymentConfig({ NOMA_FAKE_PAYMENTS: "1", NOMA_FAKE_PAYMENT_SECRET: SECRET }), { enabled: false, reason: "environment" }, "NODE_ENV absent : désactivé");
  assert.deepEqual(resolveFakePaymentConfig({ ...ok, NODE_ENV: 12 as unknown as string }), { enabled: false, reason: "environment" }, "valeur non textuelle");
  // L'environnement a priorité sur tout : drapeau et secret valides ne suffisent jamais.
  assert.equal(resolveFakePaymentConfig({ NODE_ENV: "production", NOMA_FAKE_PAYMENTS: "1", NOMA_FAKE_PAYMENT_SECRET: SECRET }).enabled, false);
  for (const flag of [undefined, "", "0", "true", "yes", "11", " 1", "1 "]) {
    assert.deepEqual(resolveFakePaymentConfig({ ...ok, NOMA_FAKE_PAYMENTS: flag }), { enabled: false, reason: "flag_absent" }, `drapeau ${JSON.stringify(flag)}`);
  }
  for (const secret of [undefined, "", "   ", "x".repeat(31), "é".repeat(15)]) {
    assert.deepEqual(resolveFakePaymentConfig({ ...ok, NOMA_FAKE_PAYMENT_SECRET: secret }), { enabled: false, reason: "secret_invalid" }, `secret ${JSON.stringify(secret)}`);
  }
  assert.deepEqual(resolveFakePaymentConfig({ ...ok, NOMA_FAKE_PAYMENT_SECRET: "x".repeat(32) }), { enabled: true, secret: "x".repeat(32) });
  assert.deepEqual(resolveFakePaymentConfig({ ...ok, NOMA_FAKE_PAYMENT_SECRET: "é".repeat(16) }), { enabled: true, secret: "é".repeat(16) }, "32 octets UTF-8");
});

// ═════════════ défense de déploiement : variables interdites en production ═════════════

const FORBIDDEN = ["NOMA_FAKE_PAYMENTS", "NOMA_FAKE_PAYMENT_SECRET", "NOMA_DEV_OTP_CONSOLE", "NOMA_DEV_PROXY", "NOMA_FAKE_SOURCES", "NOMA_TURNSTILE_DISABLED"];
const productionEnv = { NODE_ENV: "production", NOMA_TURNSTILE_SECRET: "turnstile-secret-test", NOMA_IP_SECRET: "ip-secret-test" };

test("validation de production : la liste des variables interdites est exactement celle attendue", () => {
  assert.deepEqual([...PRODUCTION_FORBIDDEN_ENV].sort(), [...FORBIDDEN].sort());
  assert.ok(Object.isFrozen(PRODUCTION_FORBIDDEN_ENV));
});

test("validation de production : toute variable de développement définie et NON VIDE est refusée (fail closed, message fixe qui ne contient jamais la valeur) ; vide ou absente passe", () => {
  const cfg = loadConfig(productionEnv);
  assert.doesNotThrow(() => assertProductionConfig(cfg, productionEnv), "production saine");
  const secretLooking = "valeur-secrete-qui-ne-doit-jamais-sortir-9f3a";
  for (const name of PRODUCTION_FORBIDDEN_ENV) {
    for (const value of ["1", "0", "true", "false", "x", " ", "  1  ", secretLooking]) {
      assert.throws(
        () => assertProductionConfig(cfg, { ...productionEnv, [name]: value }),
        (error: unknown) => error instanceof Error && error.message === `${name} interdit en production` && !error.message.includes(value.trim() || "\u0000"),
        `${name}=${JSON.stringify(value)}`,
      );
    }
    for (const value of ["", undefined]) assert.doesNotThrow(() => assertProductionConfig(cfg, { ...productionEnv, [name]: value }), `${name}=${JSON.stringify(value)}`);
  }
  // Plusieurs variables : refus à la première de la liste.
  assert.throws(() => assertProductionConfig(cfg, { ...productionEnv, NOMA_TURNSTILE_DISABLED: "1", NOMA_FAKE_PAYMENTS: "1" }), /^Error: NOMA_FAKE_PAYMENTS interdit en production$/);
});

test("validation de production : les contrôles existants sont inchangés ; hors production (développement, test, absent) rien n'est refusé, même avec toutes les variables de développement", () => {
  const allForbidden = Object.fromEntries(FORBIDDEN.map((name) => [name, "1"]));
  assert.throws(() => assertProductionConfig(loadConfig({ NODE_ENV: "production", NOMA_IP_SECRET: "i" }), { NODE_ENV: "production", NOMA_IP_SECRET: "i" }), /NOMA_TURNSTILE_SECRET requis en production/);
  assert.throws(() => assertProductionConfig(loadConfig({ NODE_ENV: "production", NOMA_TURNSTILE_SECRET: "t" }), { NODE_ENV: "production", NOMA_TURNSTILE_SECRET: "t" }), /NOMA_IP_SECRET requis en production/);
  for (const nodeEnv of ["development", "test", undefined, "staging", "Production", " production"]) {
    const env = { ...allForbidden, NODE_ENV: nodeEnv };
    assert.doesNotThrow(() => assertProductionConfig(loadConfig(env), env), `NODE_ENV=${String(nodeEnv)}`);
  }
  // Compatibilité : l'appel historique à un seul argument lit process.env (NODE_ENV=test dans les suites) et ne refuse rien.
  assert.doesNotThrow(() => assertProductionConfig(loadConfig({ NODE_ENV: "test" })));
});

test("deploy/env.production.example : la liste « INTERDIT en production » contient TOUTES les variables interdites, et aucune n'est définie dans le fichier", () => {
  const lines = readFileSync("deploy/env.production.example", "utf8").split("\n");
  const start = lines.findIndex((line) => line.startsWith("# INTERDIT en production"));
  assert.ok(start >= 0, "section « INTERDIT en production » présente");
  const block: string[] = [];
  for (let index = start; index < lines.length && lines[index].startsWith("#"); index++) block.push(lines[index]);
  const listed = [...new Set(block.join("\n").match(/\bNOMA_[A-Z0-9_]+\b/g) ?? [])].sort();
  assert.deepEqual(listed, [...FORBIDDEN].sort(), `variables listées : ${listed.join(", ")}`);
  for (const name of FORBIDDEN) {
    assert.ok(!lines.some((line) => new RegExp(`^\\s*${name}\\s*=`).test(line)), `${name} ne doit pas être défini dans le modèle de production`);
  }
  // Les secrets réels restent des valeurs d'exemple : le fichier ne définit aucune variable du portefeuille fictif.
  assert.ok(!lines.some((line) => /^\s*NOMA_FAKE_/.test(line)));
});

// ═════════════ décisions et validations ═════════════

test("décision d'un événement : table complète état × type, ordre intention inconnue > montant > état", () => {
  const states = ["pending", "expired", "failed", "succeeded"] as const;
  const expected = {
    "payment.succeeded": { pending: "applied", expired: "applied", failed: "rejected_state", succeeded: "duplicate" },
    "payment.failed": { pending: "applied", expired: "rejected_state", failed: "duplicate", succeeded: "rejected_state" },
  } as const;
  for (const type of ["payment.succeeded", "payment.failed"] as const) {
    for (const status of states) {
      assert.equal(decideProviderEventOutcome({ intent: { amountXof: big(1000), status }, type, amountXof: big(1000) }), expected[type][status], `${type} sur ${status}`);
      assert.equal(decideProviderEventOutcome({ intent: { amountXof: big(1000), status }, type, amountXof: big(1100) }), "rejected_amount", `${type} sur ${status}, montant différent`);
    }
    assert.equal(decideProviderEventOutcome({ intent: null, type, amountXof: big(1000) }), "rejected_unknown_intent");
  }
});

test("montant de recharge : bigint de 500 à 500 000 inclus, multiple de 100 ; nombre, flottant, borne ±1 et > 2^53 refusés", () => {
  for (const ok of [500, 600, 1000, 99_900, 499_900, 500_000]) assert.equal(requireTopupAmount(big(ok)), big(ok));
  for (const refused of [0, -100, -500, 100, 400, 499, 501, 550, 599, 1050, 500_001, 500_100, 1_000_000]) {
    assert.throws(() => requireTopupAmount(big(refused)), CatalogValidationError, `montant ${refused}`);
  }
  for (const wrongType of [1000, 1000.5, "1000", null, undefined, true, [1000], { amount: 1000 }, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => requireTopupAmount(wrongType), CatalogValidationError, `type ${String(wrongType)}`);
  }
  for (const huge of [big("9007199254740991"), big("9007199254740992"), big("9007199254740993"), big("100000000000000000000"), big("-9007199254740993")]) {
    assert.throws(() => requireTopupAmount(huge), CatalogValidationError, `énorme ${huge}`);
  }
});

test("clé d'idempotence : UUID seulement, ramené en minuscules", () => {
  assert.equal(requireIdempotencyKey("3F2504E0-4F89-41D3-9A0C-0305E82C3301"), "3f2504e0-4f89-41d3-9a0c-0305e82c3301");
  for (const refused of ["", "abc", "3f2504e04f8941d39a0c0305e82c3301", "3f2504e0-4f89-41d3-9a0c-0305e82c33011", 12, null, undefined, {}]) {
    assert.throws(() => requireIdempotencyKey(refused), CatalogValidationError, `clé ${JSON.stringify(refused)}`);
  }
});

test("montant du grand livre : bigint non nul, borné à ±(2^53 - 1) ; aucun flottant", () => {
  for (const ok of [big(1), big(-1), big("9007199254740991"), big("-9007199254740991")]) assert.equal(requireLedgerAmount(ok), ok);
  for (const refused of [big(0), big("9007199254740992"), big("-9007199254740992"), big("1000000000000000000000")]) {
    assert.throws(() => requireLedgerAmount(refused), CatalogValidationError);
  }
  for (const wrongType of [1, 1.5, "1", null, undefined, 0, true, Number.NaN]) assert.throws(() => requireLedgerAmount(wrongType), CatalogValidationError);
});

test("transaction du grand livre : validation complète avant tout SQL (type, référence, métadonnées, écritures, équilibre)", () => {
  const owner = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
  const other = "3f2504e0-4f89-41d3-9a0c-0305e82c3302";
  const intent = "3f2504e0-4f89-41d3-9a0c-0305e82c3303";
  const entries = (amount: number) => [
    { account: { kind: "provider_clearing" as const }, amount: big(-amount) },
    { account: { kind: "user" as const, ownerId: owner }, amount: big(amount) },
  ];
  const good = { kind: "topup" as const, reference: `topup:${intent}`, metadata: { paymentIntentId: intent, provider: "fake" }, entries: entries(1000) };
  const validated = validateWalletTransactionInput(good);
  assert.equal(validated.reference, `topup:${intent}`);
  assert.deepEqual(validated.metadata, { paymentIntentId: intent, provider: "fake" });
  assert.equal(validateWalletTransactionInput({ ...good, entries: [{ ...good.entries[0] }, { account: { kind: "user", ownerId: owner.toUpperCase() }, amount: big(1000) }] }).entries[1].account.kind, "user");
  assert.equal(validateWalletTransactionInput({ kind: "adjustment", reference: "adjustment:fix-1", metadata: { reasonCode: "manual_fix" }, entries: entries(5) }).kind, "adjustment");
  assert.deepEqual(validateWalletTransactionInput({ kind: "adjustment", reference: "adjustment:fix-1", entries: entries(5) }).metadata, {}, "métadonnées facultatives");

  const refused: Array<[string, unknown]> = [
    ["null", null],
    ["tableau", []],
    ["type inconnu", { ...good, kind: "refund" }],
    ["boost_purchase pas encore", { ...good, kind: "boost_purchase" }],
    ["référence sans le type", { ...good, reference: intent }],
    ["référence d'un autre type", { ...good, reference: `adjustment:${intent}` }],
    ["référence vide après le type", { ...good, reference: "topup:" }],
    ["référence avec espace", { kind: "adjustment", reference: "adjustment:a b", entries: entries(5) }],
    ["référence trop longue", { kind: "adjustment", reference: `adjustment:${"a".repeat(101)}`, entries: entries(5) }],
    ["recharge sans paymentIntentId", { ...good, metadata: {} }],
    ["recharge dont la référence ne dérive pas de l'intention", { ...good, reference: `topup:${other}` }],
    ["métadonnée inconnue (donnée personnelle possible)", { ...good, metadata: { ...good.metadata, phone: "+2250700000000" } }],
    ["métadonnée imbriquée", { ...good, metadata: { ...good.metadata, provider: { name: "fake" } } }],
    ["métadonnée non textuelle", { ...good, metadata: { ...good.metadata, provider: 1 } }],
    ["paymentIntentId mal formé", { ...good, metadata: { paymentIntentId: "pas-un-uuid" } }],
    ["reasonCode avec espace", { kind: "adjustment", reference: "adjustment:fix-1", metadata: { reasonCode: "a b" }, entries: entries(5) }],
    ["une seule écriture", { ...good, entries: [good.entries[1]] }],
    ["aucune écriture", { ...good, entries: [] }],
    ["écritures non tableau", { ...good, entries: {} }],
    ["onze écritures", { ...good, entries: Array.from({ length: 11 }, (_, index) => ({ account: { kind: "user", ownerId: `3f2504e0-4f89-41d3-9a0c-0305e82c33${(10 + index).toString()}` }, amount: big(index % 2 === 0 ? 1 : -1) })) }],
    ["déséquilibrée", { ...good, entries: [good.entries[0], { account: { kind: "user", ownerId: owner }, amount: big(999) }] }],
    ["écriture nulle", { ...good, entries: [good.entries[0], { account: { kind: "user", ownerId: owner }, amount: big(0) }] }],
    ["montant flottant", { ...good, entries: [good.entries[0], { account: { kind: "user", ownerId: owner }, amount: 1000 }] }],
    ["montant au-delà de 2^53", { ...good, entries: [{ account: { kind: "provider_clearing" }, amount: -big("9007199254740992") }, { account: { kind: "user", ownerId: owner }, amount: big("9007199254740992") }] }],
    ["même compte deux fois", { ...good, entries: [good.entries[1], { account: { kind: "user", ownerId: owner }, amount: big(-1000) }] }],
    ["même compte système deux fois", { ...good, entries: [good.entries[0], { account: { kind: "provider_clearing" }, amount: big(1000) }] }],
    ["compte utilisateur sans propriétaire valide", { ...good, entries: [good.entries[0], { account: { kind: "user", ownerId: "x" }, amount: big(1000) }] }],
    ["compte système avec propriétaire", { ...good, entries: [{ account: { kind: "provider_clearing", ownerId: owner }, amount: big(-1000) }, good.entries[1]] }],
    ["type de compte inconnu", { ...good, entries: [{ account: { kind: "bank" }, amount: big(-1000) }, good.entries[1]] }],
    ["écriture avec clé en plus", { ...good, entries: [{ ...good.entries[0], note: "x" }, good.entries[1]] }],
  ];
  for (const [label, input] of refused) assert.throws(() => validateWalletTransactionInput(input), CatalogValidationError, label);
});

test("curseur d'historique : aller-retour exact, toute autre forme refusée", () => {
  const id = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
  const at = "2032-06-01T12:00:00.123456Z";
  const cursor = encodeWalletCursor(at, id);
  assert.match(cursor, /^[A-Za-z0-9_-]+$/);
  assert.deepEqual(decodeWalletCursor(cursor), { createdAt: at, transactionId: id });
  const forged = (text: string) => Buffer.from(text, "utf8").toString("base64url");
  for (const refused of [
    "", "abc", "!!!", `${cursor}=`, `${cursor}x`, forged("n'importe quoi"), forged(`${at}|`), forged(`|${id}`), forged(`${at}|${id}|x`),
    forged(`2032-06-01T12:00:00Z|${id}`), forged(`2032-06-01T12:00:00.123Z|${id}`), forged(`${at}|pas-un-uuid`), forged(`2032-13-45T99:00:00.123456Z|${id}`),
    forged(`${at}|${id.toUpperCase()}`), 12, null, undefined, {}, "a".repeat(121),
  ]) {
    assert.throws(() => decodeWalletCursor(refused), CatalogValidationError, `curseur ${JSON.stringify(refused)}`);
  }
});

test("le module HTTP n'applique jamais un événement directement : les routes de développement passent par processFakePaymentEvent (même chemin que le webhook)", () => {
  const http = readFileSync("lib/server/wallet/http.ts", "utf8");
  assert.ok(!/applyProviderEvent/.test(http), "http.ts ne référence pas applyProviderEvent");
  assert.equal((http.match(/processFakePaymentEvent\(/g) ?? []).length, 2, "un appel pour le webhook, un pour la simulation");
  assert.match(http, /signFakePaymentBody\(config\.secret, bytes\)/, "la simulation SIGNE son événement");
});
