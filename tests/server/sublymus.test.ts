import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { register } from "../../instrumentation";
import { catchupDelayMs, catchupEventId, judgeProviderIntent } from "../../lib/server/wallet/sublymus/catchup";
import { SublymusApiError, SublymusClient, type SublymusIntentSummary, buildCheckoutBody, isRealSublymusHost, parseCheckoutResponse, parseIntentList, readAmount } from "../../lib/server/wallet/sublymus/client";
import {
  CATCHUP_FIRST_DELAY_MS, CATCHUP_MAX_DELAY_MS, CATCHUP_PASS_BUDGET_MS, CATCHUP_WINDOW_MS, CHECKOUT_TEST_MAX_XOF, PaymentConfigError, SUBLYMUS_DEFAULT_BASE_URL, SUBLYMUS_LINK_DOMAINS,
  SUBLYMUS_SECRET_MIN_CHARS, SUBLYMUS_WEBHOOK_MAX_BODY_BYTES, assertPaymentConfiguration, isLoopbackUrl, isWaveLinkHost, normalizeHostname, resolvePaymentSelection,
} from "../../lib/server/wallet/sublymus/config";
import {
  type KnownIntent, type ParsedSublymusWebhook, deliveryIdOf, parseSublymusWebhook, paymentEventIdOf, processSublymusWebhook, readSublymusWebhook, safeEqualText, signSublymusBody, verifySublymusEvent,
  verifySublymusSignature,
} from "../../lib/server/wallet/sublymus/webhook";
import { maskPayer, maskPayerPartial } from "../../lib/server/wallet/sublymus/anomalies";
import { decideProviderEventOutcome, type PaymentEventType, type PaymentIntentStatus } from "../../lib/server/wallet/topups";

/**
 * Lot PAY1 (paiement Wave via Sublymus), essais SANS base de données : configuration et refus de démarrer, signature, ordre des vérifications, contrat du client, rattrapage (fonctions
 * pures), et garde-fous du code source (clé jamais côté navigateur, jamais journalisée). AUCUN appel réel : clé, secret et identifiants sont INVENTÉS ici.
 */

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const source = (path: string): string => readFileSync(join(ROOT, path), "utf8");
const SENTINEL_KEY = "sentinelle_cle_api_a_ne_jamais_voir_0001";
const SENTINEL_SECRET = "sentinelle_secret_webhook_0123456789abcdef";
const PRODUCTION = {
  NODE_ENV: "production", NOMA_PAYMENT_PROVIDER: "sublymus", WAVE_API_KEY: SENTINEL_KEY, NOMA_SUBLYMUS_MANAGER_ID: "mgr_prod_1", NOMA_SUBLYMUS_WALLET_ID: "wal_prod_1",
  SUBLYMUS_WEBHOOK_SECRET: SENTINEL_SECRET, NOMA_PUBLIC_URL: "https://noma.example",
};
const DEVELOPMENT = { ...PRODUCTION, NODE_ENV: "development", NOMA_PUBLIC_URL: "http://localhost:3212", NOMA_SUBLYMUS_BASE_URL: "http://127.0.0.1:4010" };

function refused(env: Record<string, string | undefined>): PaymentConfigError {
  try {
    resolvePaymentSelection(env);
  } catch (error) {
    assert.ok(error instanceof PaymentConfigError, "PaymentConfigError attendue");
    return error;
  }
  assert.fail("la configuration aurait dû être refusée");
}

// ───────────── configuration ─────────────

test("sélection : le prestataire fictif est le défaut (variable absente ou « fake ») ; une valeur inconnue est refusée", () => {
  assert.deepEqual(resolvePaymentSelection({ NODE_ENV: "development" }), { provider: "fake" });
  assert.deepEqual(resolvePaymentSelection({ NODE_ENV: "development", NOMA_PAYMENT_PROVIDER: "fake" }), { provider: "fake" });
  assert.deepEqual(resolvePaymentSelection({ NODE_ENV: "test", NOMA_PAYMENT_PROVIDER: "  " }), { provider: "fake" });
  assert.deepEqual(resolvePaymentSelection({ NODE_ENV: "production" }), { provider: "fake" }, "sans variable en production : fictif (déjà désactivé par sa propre règle) : jamais Sublymus par défaut");
  for (const value of ["Sublymus", "SUBLYMUS", "wave", "orange", "sublymus ", "true"]) {
    if (value === "sublymus ") continue;
    assert.match(refused({ NODE_ENV: "development", NOMA_PAYMENT_PROVIDER: value }).message, /fake ou sublymus/, value);
  }
});

test("prestataire fictif demandé EXPLICITEMENT en production : refus (il reste interdit en production)", () => {
  assert.match(refused({ NODE_ENV: "production", NOMA_PAYMENT_PROVIDER: "fake" }).message, /interdit en production/);
});

test("sublymus : la configuration complète est acceptée (production : https, adresse du vrai service par défaut)", () => {
  const selection = resolvePaymentSelection(PRODUCTION);
  assert.equal(selection.provider, "sublymus");
  if (selection.provider !== "sublymus") return;
  assert.deepEqual(selection.config, {
    apiKey: SENTINEL_KEY, managerId: "mgr_prod_1", walletId: "wal_prod_1", webhookSecret: SENTINEL_SECRET, publicUrl: "https://noma.example", baseUrl: SUBLYMUS_DEFAULT_BASE_URL, production: true,
  });
  assert.equal(SUBLYMUS_DEFAULT_BASE_URL, "https://wallet.sublymus.com");
  const developed = resolvePaymentSelection(DEVELOPMENT);
  assert.equal(developed.provider === "sublymus" && developed.config.baseUrl, "http://127.0.0.1:4010");
  assert.equal(developed.provider === "sublymus" && developed.config.production, false);
});

test("sublymus sans ses variables : refus clair qui NOMME chaque variable manquante, jamais une valeur", () => {
  for (const name of ["WAVE_API_KEY", "NOMA_SUBLYMUS_MANAGER_ID", "NOMA_SUBLYMUS_WALLET_ID", "SUBLYMUS_WEBHOOK_SECRET", "NOMA_PUBLIC_URL"] as const) {
    const env: Record<string, string | undefined> = { ...PRODUCTION };
    delete env[name];
    const error = refused(env);
    assert.ok(error.problems.some((problem) => problem.includes(name)), `${name} nommée : ${error.message}`);
    assert.ok(!error.message.includes(SENTINEL_KEY) && !error.message.includes(SENTINEL_SECRET), "aucune valeur dans le message");
    env[name] = "   ";
    assert.ok(refused(env).problems.some((problem) => problem.includes(name)), `${name} vide`);
  }
  const everything = refused({ NODE_ENV: "production", NOMA_PAYMENT_PROVIDER: "sublymus" });
  assert.equal(everything.problems.length, 5, "toutes les variables manquantes d'un coup");
  assert.match(everything.message, /^Configuration du paiement refusée/);
});

test("secret de signature : 32 caractères au moins (31 refusé) ; clé à forme invalide refusée ; messages sans valeur", () => {
  assert.equal(SUBLYMUS_SECRET_MIN_CHARS, 32);
  assert.ok(refused({ ...PRODUCTION, SUBLYMUS_WEBHOOK_SECRET: "x".repeat(31) }).problems.some((problem) => problem.includes("SUBLYMUS_WEBHOOK_SECRET")));
  assert.equal(resolvePaymentSelection({ ...PRODUCTION, SUBLYMUS_WEBHOOK_SECRET: "x".repeat(32) }).provider, "sublymus");
  for (const key of ["avec espace", "sauté\nligne", "x".repeat(513)]) assert.ok(refused({ ...PRODUCTION, WAVE_API_KEY: key }).problems.some((problem) => problem.includes("WAVE_API_KEY")));
  assert.ok(refused({ ...PRODUCTION, NOMA_SUBLYMUS_MANAGER_ID: "a b" }).problems.some((problem) => problem.includes("NOMA_SUBLYMUS_MANAGER_ID")));
});

test("production : NOMA_PUBLIC_URL et NOMA_SUBLYMUS_BASE_URL exigent https, une simple origine, aucun identifiant", () => {
  for (const url of ["http://noma.example", "noma.example", "https://noma.example/chemin", "https://noma.example/?a=1", "https://user:mdp@noma.example", "ftp://noma.example", "http://localhost:3000"]) {
    assert.ok(refused({ ...PRODUCTION, NOMA_PUBLIC_URL: url }).problems.some((problem) => problem.includes("NOMA_PUBLIC_URL")), url);
  }
  for (const url of ["http://wallet.sublymus.com", "https://wallet.sublymus.com/v1", "https://u:p@wallet.sublymus.com", "http://127.0.0.1:4010"]) {
    assert.ok(refused({ ...PRODUCTION, NOMA_SUBLYMUS_BASE_URL: url }).problems.some((problem) => problem.includes("NOMA_SUBLYMUS_BASE_URL")), url);
  }
});

test("hors production : l'adresse de l'API DOIT être sur ce poste (jamais le vrai service) et obligatoire ; http n'est admis que pour localhost", () => {
  const withoutBase: Record<string, string | undefined> = { ...DEVELOPMENT };
  delete withoutBase.NOMA_SUBLYMUS_BASE_URL;
  assert.ok(refused(withoutBase).problems.some((problem) => problem.includes("NOMA_SUBLYMUS_BASE_URL") && problem.includes("poste")));
  for (const url of ["https://wallet.sublymus.com", "https://autre.exemple", "http://192.168.1.10:4010", "https://wallet.sublymus.com.evil.example"]) {
    assert.ok(refused({ ...DEVELOPMENT, NOMA_SUBLYMUS_BASE_URL: url }).problems.some((problem) => problem.includes("NOMA_SUBLYMUS_BASE_URL")), url);
  }
  for (const url of ["http://localhost:4010", "http://127.0.0.1:4010", "https://localhost:4010"]) assert.equal(resolvePaymentSelection({ ...DEVELOPMENT, NOMA_SUBLYMUS_BASE_URL: url }).provider, "sublymus", url);
  assert.ok(refused({ ...DEVELOPMENT, NOMA_PUBLIC_URL: "http://noma.example" }).problems.some((problem) => problem.includes("NOMA_PUBLIC_URL")));
  assert.equal(resolvePaymentSelection({ ...DEVELOPMENT, NOMA_PUBLIC_URL: "https://noma.example" }).provider, "sublymus");
});

test("démarrage : assertPaymentConfiguration refuse (message clair) ; le point d'entrée du serveur (instrumentation) refuse de démarrer avec Sublymus sans ses variables, et laisse démarrer sans Sublymus", async () => {
  assert.throws(() => assertPaymentConfiguration({ NODE_ENV: "production", NOMA_PAYMENT_PROVIDER: "sublymus", WAVE_API_KEY: SENTINEL_KEY }), (error: unknown) => {
    assert.ok(error instanceof PaymentConfigError);
    assert.match(error.message, /NOMA_SUBLYMUS_MANAGER_ID/);
    assert.match(error.message, /SUBLYMUS_WEBHOOK_SECRET/);
    assert.ok(!error.message.includes(SENTINEL_KEY));
    return true;
  });
  assert.equal(assertPaymentConfiguration(PRODUCTION).provider, "sublymus");
  const saved = { ...process.env };
  const restore = (): void => {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  };
  try {
    for (const key of ["WAVE_API_KEY", "NOMA_SUBLYMUS_MANAGER_ID", "NOMA_SUBLYMUS_WALLET_ID", "SUBLYMUS_WEBHOOK_SECRET", "NOMA_PUBLIC_URL", "NOMA_SUBLYMUS_BASE_URL"]) delete process.env[key];
    (process.env as Record<string, string>).NEXT_RUNTIME = "nodejs";
    (process.env as Record<string, string>).NOMA_PAYMENT_PROVIDER = "sublymus";
    await assert.rejects(register(), PaymentConfigError, "Sublymus sans variables : le serveur ne démarre pas");
    (process.env as Record<string, string>).NOMA_PAYMENT_PROVIDER = "fake";
    await register();
    delete process.env.NOMA_PAYMENT_PROVIDER;
    await register();
    (process.env as Record<string, string>).NEXT_RUNTIME = "edge";
    (process.env as Record<string, string>).NOMA_PAYMENT_PROVIDER = "sublymus";
    await register();
  } finally {
    restore();
  }
});

// ───────────── signature ─────────────

test("signature : HMAC-SHA256 hexadécimal du corps BRUT ; absente, non hexadécimale, de mauvaise longueur ou calculée sur un autre texte : refusée", () => {
  const secret = "secret_de_test_pour_les_signatures_0123456789";
  const body = '{"event":"payment.completed","data":{"id":"pi_1"}}';
  const bytes = new TextEncoder().encode(body);
  const good = signSublymusBody(secret, body);
  assert.match(good, /^[0-9a-f]{64}$/);
  assert.equal(verifySublymusSignature(secret, bytes, good), true);
  assert.equal(verifySublymusSignature(secret, bytes, good.toUpperCase()), true, "l'hexadécimal n'est pas sensible à la casse");
  for (const bad of [null, "", "zz".repeat(32), good.slice(1), `${good}0`, "0".repeat(64), good.replace(/^./, good[0] === "a" ? "b" : "a"), ` ${good}`]) {
    assert.equal(verifySublymusSignature(secret, bytes, bad), false, String(bad).slice(0, 10));
  }
  assert.equal(verifySublymusSignature("un_autre_secret_de_test_0123456789012", bytes, good), false);
  // Corps modifié, ou ré-sérialisé (JSON.stringify d'un JSON relu) : la signature ne correspond plus.
  assert.equal(verifySublymusSignature(secret, new TextEncoder().encode(`${body} `), good), false);
  assert.equal(verifySublymusSignature(secret, new TextEncoder().encode(JSON.stringify(JSON.parse(body), null, 1)), good), false);
  const reordered = JSON.stringify({ data: { id: "pi_1" }, event: "payment.completed" });
  assert.notEqual(reordered, body);
  assert.equal(verifySublymusSignature(secret, new TextEncoder().encode(reordered), good), false);
  // Octets et texte : la signature porte sur les octets (un caractère accentué compte pour deux octets).
  assert.equal(signSublymusBody(secret, "é"), signSublymusBody(secret, new TextEncoder().encode("é")));
});

test("comparaison à temps constant : timingSafeEqual sur des tampons de même longueur, jamais === sur la signature ni sur le gestionnaire", () => {
  const code = source("lib/server/wallet/sublymus/webhook.ts").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.match(code, /timingSafeEqual\(Buffer\.from\(signature, "hex"\), expected\)/);
  assert.equal(/signature\s*[!=]==(?!\s*null)|===\s*signature|expected\.toString\(|toString\("hex"\)\s*[!=]==/.test(code), false, "aucune comparaison directe de la signature");
  assert.match(code, /export function safeEqualText[\s\S]*timingSafeEqual\(createHash\("sha256"\)\.update\(left\)/);
  assert.equal(/managerId\s*[!=]==(?!\s*null)|[!=]==\s*input\.managerId/.test(code), false, "le gestionnaire se compare à temps constant");
  assert.equal(safeEqualText("mgr_1", "mgr_1"), true);
  assert.equal(safeEqualText("mgr_1", "mgr_2"), false);
  assert.equal(safeEqualText("mgr_1", "mgr_1 "), false);
  assert.equal(safeEqualText("", ""), true);
});

test("ordre : signature d'abord, gestionnaire ensuite, lecture du corps seulement après ; un refus précoce n'ouvre AUCUNE connexion", async () => {
  const secret = "secret_de_test_pour_les_signatures_0123456789";
  const noPool = () => { throw new Error("la base ne doit pas être ouverte"); };
  const garbage = "{ ceci n'est pas du json";
  const base = { pool: noPool as never, secret, managerId: "mgr_1" };
  const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
  const headers = (signature: string | null, managerId: string | null = "mgr_1") => ({ signature, event: "payment.completed", managerId, webhookId: "wh_1" });
  // Mauvaise signature + corps illisible : refus d'authentification, pas « événement invalide » (aucun parsing avant la signature).
  assert.deepEqual(await processSublymusWebhook({ ...base, body: bytes(garbage), headers: headers("0".repeat(64)) }), { status: "unauthorized" });
  assert.deepEqual(await processSublymusWebhook({ ...base, body: bytes(garbage), headers: headers(null) }), { status: "unauthorized" });
  // Bonne signature, autre gestionnaire : refus, toujours sans lecture du corps.
  assert.deepEqual(await processSublymusWebhook({ ...base, body: bytes(garbage), headers: headers(signSublymusBody(secret, garbage), "mgr_2") }), { status: "unauthorized" });
  assert.deepEqual(await processSublymusWebhook({ ...base, body: bytes(garbage), headers: headers(signSublymusBody(secret, garbage), null) }), { status: "unauthorized" });
  // Authentifié mais illisible : JAMAIS « 400 » ni refus d'authentification ; la base est ouverte (pour journaliser l'anomalie), ce que cette base interdite signale ici.
  await assert.rejects(processSublymusWebhook({ ...base, body: bytes(garbage), headers: headers(signSublymusBody(secret, garbage)) }), /la base ne doit pas être ouverte/);
  const code = source("lib/server/wallet/sublymus/webhook.ts");
  const body = code.slice(code.indexOf("export async function processSublymusWebhook("));
  assert.ok(body.indexOf("verifySublymusSignature(") < body.indexOf("safeEqualText(") && body.indexOf("safeEqualText(") < body.indexOf("readSublymusWebhook("), "signature, gestionnaire, puis lecture");
  assert.ok(body.indexOf("readSublymusWebhook(") < body.indexOf("input.pool"), "la base n'est résolue qu'après l'authentification et la lecture");
});

test("lecture du corps authentifié : forme du contrat exigée (événement, data.id, externalReference), champs lus avec tolérance, rien d'autre", () => {
  const parse = (value: unknown): ReturnType<typeof parseSublymusWebhook> => parseSublymusWebhook(new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value)));
  const ok = { event: "payment.completed", data: { id: "pi_1", externalReference: "noma-topup-x", amount: 5000, currency: "XOF", status: "COMPLETED", payerId: "mgr_1", sourceSystem: "NOMA" }, timestamp: "2026-01-01T00:00:00Z" };
  assert.deepEqual(parse(ok), { event: "payment.completed", dataId: "pi_1", externalReference: "noma-topup-x", amountXof: BigInt(5000), currency: "XOF", status: "COMPLETED", payerId: "mgr_1", sourceSystem: "NOMA" });
  assert.equal(parse({ ...ok, data: { ...ok.data, amount: "5000" } })!.amountXof, BigInt(5000), "montant en chaîne de chiffres accepté");
  assert.equal(parse({ ...ok, data: { ...ok.data, amount: "5000.0" } })!.amountXof, BigInt(5000), "fraction nulle acceptée");
  assert.equal(parse({ ...ok, data: { ...ok.data, amount: "5000.00" } })!.amountXof, BigInt(5000), "fraction nulle acceptée");
  assert.equal(parse({ ...ok, data: { ...ok.data, amount: "5000.5" } })!.amountXof, null, "toute autre fraction est une anomalie");
  assert.equal(parse({ ...ok, data: { ...ok.data, amount: "4999.99" } })!.amountXof, null);
  assert.equal(parse({ ...ok, data: { ...ok.data, amount: 50.5 } })!.amountXof, null, "un montant à virgule n'est jamais lu comme un montant");
  assert.equal(parse({ ...ok, data: { ...ok.data, amount: -5 } })!.amountXof, null);
  assert.equal(parse({ ...ok, data: { ...ok.data, amount: "1e3" } })!.amountXof, null);
  assert.equal(parse({ ...ok, data: { ...ok.data, amount: 9_007_199_254_740_993 } })!.amountXof, null, "au-delà de 2^53 − 1 : jamais lu comme un montant");
  // Charge d'un prestataire : un champ à virgule, à exposant ou très profond ne fait pas refuser le message ; seul le montant doit être exact.
  assert.equal(parse('{"event":"payment.completed","data":{"id":"pi_1","externalReference":"r","amount":100,"fee":0.5,"ratio":1e-3,"nested":{"a":{"b":{"c":{"d":{"e":{"f":{"g":1}}}}}}}},"timestamp":1700000000.123}')!.amountXof, BigInt(100));
  assert.equal(parse({ ...ok, data: { id: "pi_1", external_reference: "noma-topup-x", amount: 1 } })!.externalReference, "noma-topup-x", "snake_case toléré");
  for (const bad of [null, "[]", "{}", "pas du json", { ...ok, event: "payment.refunded" }, { ...ok, event: 3 }, { event: "payment.completed" }, { ...ok, data: null },
    { ...ok, data: { ...ok.data, id: "avec espace" } }, { ...ok, data: { ...ok.data, id: undefined } }, { ...ok, data: { ...ok.data, externalReference: "" } }, { ...ok, data: { ...ok.data, externalReference: "x".repeat(101) } },
    '{"event":"payment.completed","event":"payment.failed","data":{"id":"pi_1","externalReference":"r"}}']) {
    assert.equal(parse(bad), null, JSON.stringify(bad)?.slice(0, 50));
  }
  assert.equal(parseSublymusWebhook(Uint8Array.from([0xff, 0xfe, 0x7b])), null, "UTF-8 invalide");
});

test("décision d'un événement : un paiement réussi après un échec n'est appliqué que si le prestataire le demande (Sublymus) ; le prestataire fictif garde « rejeté »", () => {
  const input = (status: PaymentIntentStatus, type: PaymentEventType, extra: { allowSuccessAfterFailure?: boolean } = {}) =>
    decideProviderEventOutcome({ intent: { amountXof: BigInt(5000), status }, type, amountXof: BigInt(5000), ...extra });
  assert.equal(input("failed", "payment.succeeded"), "rejected_state");
  assert.equal(input("failed", "payment.succeeded", { allowSuccessAfterFailure: false }), "rejected_state");
  assert.equal(input("failed", "payment.succeeded", { allowSuccessAfterFailure: true }), "applied");
  assert.equal(input("expired", "payment.succeeded"), "applied", "paiement tardif sur une recharge échue : toujours appliqué");
  assert.equal(input("succeeded", "payment.succeeded", { allowSuccessAfterFailure: true }), "duplicate", "jamais un second crédit");
  assert.equal(input("succeeded", "payment.failed", { allowSuccessAfterFailure: true }), "rejected_state", "un échec tardif ne défait pas un crédit");
  assert.equal(input("failed", "payment.failed", { allowSuccessAfterFailure: true }), "duplicate");
  assert.equal(decideProviderEventOutcome({ intent: { amountXof: BigInt(5000), status: "failed" }, type: "payment.succeeded", amountXof: BigInt(4999), allowSuccessAfterFailure: true }), "rejected_amount");
});

test("événement authentifié mais illisible ou inconnu : jamais de crédit, une raison précise (illisible, inconnu), jamais d'exception", () => {
  const read = (value: unknown) => readSublymusWebhook(new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value)));
  const data = { id: "pi_1", externalReference: "noma-topup-x", amount: 5000, currency: "XOF", status: "COMPLETED" };
  const ok = { event: "payment.completed", data };
  assert.equal(read(ok).ok, true);
  // Événement inconnu : on garde son nom et la référence lisible.
  assert.deepEqual(read({ event: "payment.refunded", data }), { ok: false, reason: "unknown_event", eventName: "payment.refunded", externalReference: "noma-topup-x" });
  assert.deepEqual(read({ event: "payment.refunded" }), { ok: false, reason: "unknown_event", eventName: "payment.refunded", externalReference: null });
  // Illisible : octets invalides, BOM, JSON faux, nombre absurde, forme fausse, data.id invalide, référence absente.
  const unreadable = [
    Uint8Array.from([0xff, 0xfe, 0x7b]),
    new TextEncoder().encode(`\uFEFF${JSON.stringify(ok)}`),
    '{ ceci n\'est pas du json',
    '{"event":"payment.completed","data":{"id":"pi_1","externalReference":"r","amount":1e400}}',
    '{"event":"payment.completed","data":{"id":"pi_1","externalReference":"r"},"event":"payment.failed"}',
    "[]", "null", "42", '"payment.completed"', {}, { event: 3 }, { event: "payment.completed" }, { event: "payment.completed", data: null },
    { event: "payment.completed", data: { ...data, id: "avec/barre" } }, { event: "payment.completed", data: { ...data, id: undefined } },
    { event: "payment.completed", data: { ...data, externalReference: undefined } }, { event: "payment.completed", data: { ...data, externalReference: "x".repeat(101) } },
  ];
  for (const bad of unreadable) {
    const answer = bad instanceof Uint8Array ? readSublymusWebhook(bad) : read(bad);
    assert.equal(answer.ok, false, String(bad).slice(0, 40));
    if (!answer.ok) assert.equal(answer.reason, "unreadable", String(bad).slice(0, 40));
  }
  // La référence lisible d'un événement mal formé est conservée pour rattacher l'anomalie.
  const partial = read({ event: "payment.completed", data: { ...data, id: "avec/barre" } });
  assert.deepEqual(partial, { ok: false, reason: "unreadable", eventName: "payment.completed", externalReference: "noma-topup-x" });
  assert.equal(parseSublymusWebhook(new TextEncoder().encode(JSON.stringify({ event: "payment.refunded", data }))), null, "l'ancienne lecture reste nulle pour un événement inconnu");
});

test("vérification de l'événement : référence connue, événement, identifiant, montant, devise, statut, payeur, système source ; chaque écart a son genre", () => {
  const parsed: ParsedSublymusWebhook = { event: "payment.completed", dataId: "pi_1", externalReference: "noma-topup-x", amountXof: BigInt(5000), currency: "XOF", status: "COMPLETED", payerId: null, sourceSystem: null };
  const intent: KnownIntent = { id: "i1", amountXof: BigInt(5000), sublymusIntentId: null };
  const check = (changes: Partial<ParsedSublymusWebhook> = {}, known: KnownIntent | null = intent, header: string | null = "payment.completed") =>
    verifySublymusEvent({ parsed: { ...parsed, ...changes }, headerEvent: header, intent: known, managerId: "mgr_1" });
  assert.deepEqual(check(), []);
  assert.deepEqual(check({}, null), ["unknown_reference"]);
  assert.deepEqual(check({}, intent, "payment.failed"), ["event_mismatch"]);
  assert.deepEqual(check({}, intent, null), ["event_mismatch"]);
  assert.deepEqual(check({}, { ...intent, sublymusIntentId: "pi_autre" }), ["intent_id_mismatch"]);
  assert.deepEqual(check({}, { ...intent, sublymusIntentId: "pi_1" }), []);
  assert.deepEqual(check({ amountXof: BigInt(4999) }), ["amount_mismatch"]);
  assert.deepEqual(check({ amountXof: BigInt(5001) }), ["amount_mismatch"]);
  assert.deepEqual(check({ amountXof: null }), ["invalid_amount"]);
  assert.deepEqual(check({ currency: "USD" }), ["currency_mismatch"]);
  assert.deepEqual(check({ currency: null }), ["currency_mismatch"]);
  assert.deepEqual(check({ currency: "xof" }), ["currency_mismatch"]);
  assert.deepEqual(check({ status: "WAVE_CREATED" }), ["status_mismatch"]);
  assert.deepEqual(check({ status: "completed" }), ["status_mismatch"]);
  assert.deepEqual(check({ status: null }), ["status_mismatch"]);
  assert.deepEqual(check({ event: "payment.failed", status: "FAILED" }, intent, "payment.failed"), []);
  assert.deepEqual(check({ event: "payment.failed", status: "COMPLETED" }, intent, "payment.failed"), ["status_mismatch"]);
  assert.deepEqual(check({ payerId: "mgr_1" }), []);
  assert.deepEqual(check({ payerId: "quelqu_un" }), ["payer_mismatch"]);
  assert.deepEqual(check({ sourceSystem: "NOMA" }), []);
  assert.deepEqual(check({ sourceSystem: "AUTRE" }), ["source_mismatch"]);
  assert.deepEqual(check({ amountXof: BigInt(1), currency: "USD", status: "FAILED" }), ["amount_mismatch", "currency_mismatch", "status_mismatch"]);
});

test("identifiants : livraison (en-tête, sinon empreinte du corps), événement du journal lié au corps ; payeur masqué", () => {
  const sha = "a".repeat(64);
  assert.equal(deliveryIdOf("wh_abc-123", sha), "wh_abc-123");
  assert.equal(deliveryIdOf(null, sha), `body-${sha.slice(0, 48)}`);
  assert.equal(deliveryIdOf("avec espace", sha), `body-${sha.slice(0, 48)}`);
  assert.equal(deliveryIdOf("x".repeat(129), sha), `body-${sha.slice(0, 48)}`);
  assert.match(paymentEventIdOf("wh_1", sha), /^wh_[0-9a-f]{40}$/);
  assert.notEqual(paymentEventIdOf("wh_1", sha), paymentEventIdOf("wh_1", "b".repeat(64)), "un autre corps, un autre événement");
  assert.notEqual(paymentEventIdOf("wh_1", sha), paymentEventIdOf("wh_2", sha));
  assert.equal(maskPayer("payeur_prive_123"), "pa***");
  assert.equal(maskPayer(null), null);
  assert.equal(maskPayer(""), null);
  assert.ok(!maskPayer("1234567890")!.includes("567"));
  // Masque partiel du fondateur : deux premiers et deux derniers caractères, jamais l'identifiant entier ; un identifiant court n'en montre aucun.
  assert.equal(maskPayerPartial("payeur_prive_123"), "pa***23");
  assert.equal(maskPayerPartial("abcdef"), "***");
  assert.equal(maskPayerPartial(null), null);
  assert.equal(maskPayerPartial(""), null);
  assert.ok(!maskPayerPartial("1234567890")!.includes("34567"));
});

// ───────────── client Sublymus ─────────────

test("création : les splits sont obligatoires et leur somme vaut EXACTEMENT le montant ; corps aux clés exactes ; monnaie XOF, système source NOMA", () => {
  const input = { amountXof: BigInt(7500), externalReference: "noma-topup-x", description: "Recharge", successUrl: "https://noma.example/ok", errorUrl: "https://noma.example/ko", label: "Recharge noma" };
  const body = buildCheckoutBody({ walletId: "wal_1" }, input) as Record<string, unknown>;
  assert.deepEqual(Object.keys(body).sort(), ["amount", "currency", "description", "error_url", "external_reference", "source_system", "splits", "success_url"]);
  assert.equal(body.amount, 7500);
  assert.equal(body.currency, "XOF");
  assert.equal(body.source_system, "NOMA");
  const splits = body.splits as Array<Record<string, unknown>>;
  assert.ok(splits.length >= 1);
  assert.equal(splits.reduce((sum, split) => sum + Number(split.amount), 0), 7500);
  assert.deepEqual(splits[0], { wallet_id: "wal_1", amount: 7500, category: "PAYMENT", label: "Recharge noma", release_delay_hours: 0 });
  for (const amount of [BigInt(0), BigInt(-1), BigInt(Number.MAX_SAFE_INTEGER) + BigInt(1)]) assert.throws(() => buildCheckoutBody({ walletId: "wal_1" }, { ...input, amountXof: amount }), RangeError);
  for (const amount of [1, 100, 999_999, 123_456_789]) {
    const sum = ((buildCheckoutBody({ walletId: "w" }, { ...input, amountXof: BigInt(amount) }).splits as Array<{ amount: number }>)).reduce((total, split) => total + split.amount, 0);
    assert.equal(sum, amount);
  }
});

test("réponse de création : un lien n'est accepté que s'il reprend exactement montant, devise, référence, statut WAVE_CREATED et lien https sans identifiant", () => {
  const input = { amountXof: BigInt(5000), externalReference: "noma-topup-x" };
  const good = { data: { payment_intent_id: "pi_1", status: "WAVE_CREATED", wave_checkout_url: "https://pay.wave.example/c/1", amount: 5000, currency: "XOF", external_reference: "noma-topup-x" } };
  const local = { anyHost: true };
  assert.deepEqual(parseCheckoutResponse(good, input, local), { paymentIntentId: "pi_1", status: "WAVE_CREATED", checkoutUrl: "https://pay.wave.example/c/1", amountXof: BigInt(5000), currency: "XOF", externalReference: "noma-topup-x" });
  // Hors fausse API locale, le lien doit être sur un sous-domaine Wave : pay.wave.com accepté, tout le reste refusé (jamais enregistré ni servi).
  const waveGood = { data: { ...good.data, wave_checkout_url: "https://pay.wave.com/c/1" } };
  assert.equal(parseCheckoutResponse(waveGood, input).checkoutUrl, "https://pay.wave.com/c/1", "politique stricte par défaut : pay.wave.com admis");
  assert.equal(parseCheckoutResponse({ data: { ...good.data, wave_checkout_url: "https://checkout.WAVE.com./x" } }, input).checkoutUrl, "https://checkout.WAVE.com./x", "casse et point final normalisés");
  for (const link of ["https://pay.wave.example/c/1", "https://evil.example/phish", "https://pay.wave.com.evil.example/c", "https://wave.com/c", "https://notwave.com/c", "https://pay-wave.com/c", "https://evilwave.com/c", "https://pay.wave.com@evil.example/c"]) {
    assert.throws(() => parseCheckoutResponse({ data: { ...good.data, wave_checkout_url: link } }, input), (error: unknown) => error instanceof SublymusApiError && error.kind === "invalid_response", link);
  }
  const bad = (changes: Record<string, unknown>) => ({ data: { ...good.data, ...changes } });
  for (const response of [null, {}, { data: null }, bad({ amount: 4999 }), bad({ amount: "5000x" }), bad({ currency: "USD" }), bad({ external_reference: "noma-topup-y" }), bad({ status: "COMPLETED" }),
    bad({ wave_checkout_url: "http://pay.wave.example/c/1" }), bad({ wave_checkout_url: "javascript:alert(1)" }), bad({ wave_checkout_url: "https://u:p@pay.wave.example/c" }), bad({ wave_checkout_url: "https://pay.wave.example/c 1" }),
    bad({ wave_checkout_url: `https://pay.wave.example/${"a".repeat(2000)}` }), bad({ payment_intent_id: "avec espace" }), bad({ payment_intent_id: undefined })]) {
    assert.throws(() => parseCheckoutResponse(response, input, local), (error: unknown) => error instanceof SublymusApiError && error.kind === "invalid_response", JSON.stringify(response)?.slice(0, 60));
  }
});

test("recherche : la liste de Sublymus est relue champ par champ (camelCase ou snake_case) ; les entrées illisibles sont ignorées", () => {
  const list = parseIntentList({ data: [
    { id: "pi_1", externalReference: "r1", payerId: "m", amount: 100, currency: "XOF", sourceSystem: "NOMA", status: "COMPLETED", waveCheckoutUrl: "https://pay.wave.example/1" },
    { id: "pi_2", external_reference: "r2", payer_id: "m", amount: "200", currency: "XOF", source_system: "NOMA", status: "WAVE_CREATED" },
    { id: "pi 3", externalReference: "r3", status: "COMPLETED" }, { id: "pi_4", status: "COMPLETED" }, { id: "pi_5", externalReference: "r5" }, "texte", null,
  ] }, { anyHost: true });
  assert.deepEqual(list.map((entry) => [entry.id, entry.externalReference, entry.amountXof, entry.status, entry.checkoutUrl]), [["pi_1", "r1", BigInt(100), "COMPLETED", "https://pay.wave.example/1"], ["pi_2", "r2", BigInt(200), "WAVE_CREATED", null]]);
  // Politique stricte : le lien d'une entrée n'est gardé que sur un domaine Wave.
  const strict = parseIntentList({ data: [
    { id: "pi_1", externalReference: "r1", status: "WAVE_CREATED", waveCheckoutUrl: "https://pay.wave.com/c/1" },
    { id: "pi_2", externalReference: "r2", status: "WAVE_CREATED", waveCheckoutUrl: "https://evil.example/c/2" },
  ] });
  assert.deepEqual(strict.map((entry) => entry.checkoutUrl), ["https://pay.wave.com/c/1", null]);
  assert.deepEqual(parseIntentList({ data: { items: [] } }), []);
  for (const bad of [null, {}, { data: "x" }, { data: 5 }]) assert.throws(() => parseIntentList(bad), SublymusApiError);
  assert.equal(readAmount(12), BigInt(12));
  assert.equal(readAmount("12"), BigInt(12));
  for (const good of ["1200.0", "1200.00", "1200.000000", "0.0"]) assert.equal(readAmount(good), BigInt(good.split(".")[0]), good);
  assert.equal(readAmount(1200.0), BigInt(1200));
  for (const bad of [-1, 1.5, "1.5", "-3", "abc", null, undefined, Number.MAX_SAFE_INTEGER + 1, "99999999999999999", "1200.5", "1200.01", "1200.", ".5", "1200.0000001", " 1200", "1200 ", "1,200", "1e3", "+5", "1200.0.0"]) {
    assert.equal(readAmount(bad), null, String(bad));
  }
});

test("le vrai service est refusé dans un essai ou un développement : sans autorisation explicite, SEULE la boucle locale est admise (casse, point final, noms voisins compris)", () => {
  const config = { apiKey: SENTINEL_KEY, managerId: "m", walletId: "w" };
  const real = ["https://wallet.sublymus.com", "https://api.wallet.sublymus.com", "https://sublymus.com", "HTTPS://WALLET.SUBLYMUS.COM", "https://wallet.sublymus.com.", "https://WALLET.Sublymus.COM...", "pas une adresse"];
  for (const baseUrl of real) {
    assert.throws(() => new SublymusClient({ ...config, baseUrl }), (error: unknown) => error instanceof SublymusApiError && error.kind === "real_host_forbidden", baseUrl);
    assert.equal(isRealSublymusHost(baseUrl), true, baseUrl);
  }
  // Toute adresse qui n'est PAS la boucle locale est refusée sans autorisation (noms voisins, autres domaines, réseau local), même si ce n'est pas le vrai service.
  for (const baseUrl of ["https://wallet.sublymus.com.evil.example", "https://autre.exemple", "http://192.168.1.10:4010", "https://notsublymus.com", "http://127.0.0.1.evil.example", "http://localhost.evil.example:4010"]) {
    assert.throws(() => new SublymusClient({ ...config, baseUrl }), (error: unknown) => error instanceof SublymusApiError && error.kind === "real_host_forbidden", baseUrl);
    assert.equal(isLoopbackUrl(baseUrl), false, baseUrl);
  }
  assert.equal(isRealSublymusHost("https://notsublymus.com"), false);
  assert.equal(isRealSublymusHost("https://wallet.sublymus.com.evil.example"), false);
  for (const baseUrl of ["http://127.0.0.1:4010", "http://localhost:4010", "http://[::1]:4010"]) {
    assert.doesNotThrow(() => new SublymusClient({ ...config, baseUrl }), baseUrl);
    assert.equal(isLoopbackUrl(baseUrl), true);
  }
  // Autorisation explicite (production, commande du fondateur hors essais) : le vrai service est admis.
  assert.doesNotThrow(() => new SublymusClient({ ...config, baseUrl: "https://wallet.sublymus.com" }, { allowRealHost: true }));
  assert.equal(normalizeHostname("WALLET.Sublymus.COM.."), "wallet.sublymus.com");
  // Aucune requête n'est émise par la construction refusée.
  let calls = 0;
  assert.throws(() => new SublymusClient({ ...config, baseUrl: "https://wallet.sublymus.com." }, { fetch: (async () => { calls += 1; return new Response("{}"); }) as typeof fetch }));
  assert.equal(calls, 0);
});

test("domaines du lien de paiement : sous-domaines de wave.com seulement (liste dans le code), casse et point final normalisés", () => {
  assert.deepEqual([...SUBLYMUS_LINK_DOMAINS], ["wave.com"]);
  for (const host of ["pay.wave.com", "checkout.wave.com", "PAY.WAVE.COM", "pay.wave.com.", "a.b.wave.com"]) assert.equal(isWaveLinkHost(host), true, host);
  for (const host of ["wave.com", "pay.wave.com.evil.example", "evilwave.com", "pay-wave.com", "wave.com.evil.example", "pay.wave.example", "", "com"]) assert.equal(isWaveLinkHost(host), false, host);
});

test("le client n'envoie la clé et le gestionnaire que dans les en-têtes, ne suit aucune redirection, borne délai et réponse ; une erreur ne contient jamais la clé", async () => {
  const seen: Array<{ url: string; init: RequestInit }> = [];
  const fetchStub = (async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  const client = new SublymusClient({ apiKey: SENTINEL_KEY, managerId: "mgr_1", walletId: "wal_1", baseUrl: "http://127.0.0.1:4010" }, { fetch: fetchStub });
  await client.findIntents("noma-topup-a b&c=d");
  assert.equal(seen[0].url, "http://127.0.0.1:4010/v1/intents?external_reference=noma-topup-a%20b%26c%3Dd", "référence encodée");
  const headers = seen[0].init.headers as Record<string, string>;
  assert.equal(headers.Authorization, `Bearer ${SENTINEL_KEY}`);
  assert.equal(headers["X-Manager-Id"], "mgr_1");
  assert.equal(seen[0].init.redirect, "error");
  assert.ok(seen[0].init.signal instanceof AbortSignal);
  assert.equal(seen[0].init.method, "GET");
  assert.equal(seen[0].init.body, undefined);
  for (const status of [401, 403, 404, 409, 422, 429, 500, 503]) {
    const failing = new SublymusClient({ apiKey: SENTINEL_KEY, managerId: "mgr_1", walletId: "wal_1", baseUrl: "http://127.0.0.1:4010" }, { fetch: (async () => new Response(`{"echo":"${SENTINEL_KEY}"}`, { status })) as unknown as typeof fetch });
    await assert.rejects(failing.findIntents("r"), (error: unknown) => {
      assert.ok(error instanceof SublymusApiError);
      assert.equal(error.status, status);
      assert.ok(!`${error.message} ${error.stack ?? ""} ${error.code}`.includes(SENTINEL_KEY));
      assert.match(error.code, /^sublymus_[a-z_]+$/);
      return true;
    });
  }
  const network = new SublymusClient({ apiKey: SENTINEL_KEY, managerId: "m", walletId: "w", baseUrl: "http://127.0.0.1:4010" }, { fetch: (async () => { throw new Error(`échec avec ${SENTINEL_KEY}`); }) as unknown as typeof fetch });
  await assert.rejects(network.findIntents("r"), (error: unknown) => error instanceof SublymusApiError && error.kind === "network" && !String(error.message).includes(SENTINEL_KEY));
  const huge = new SublymusClient({ apiKey: SENTINEL_KEY, managerId: "m", walletId: "w", baseUrl: "http://127.0.0.1:4010" }, { fetch: (async () => new Response("x".repeat(300_000), { status: 200 })) as unknown as typeof fetch });
  await assert.rejects(huge.findIntents("r"), (error: unknown) => error instanceof SublymusApiError && error.kind === "invalid_response");
});

// ───────────── rattrapage (fonctions pures) ─────────────

test("rattrapage : attente 2 min × 2^n plafonnée à 1 heure, fenêtre de 24 h ; identifiant d'événement déterministe ; décision sur l'entrée de Sublymus", () => {
  assert.equal(CATCHUP_FIRST_DELAY_MS, 2 * 60_000);
  assert.equal(CATCHUP_MAX_DELAY_MS, 3_600_000);
  assert.equal(CATCHUP_WINDOW_MS, 24 * 3_600_000);
  assert.equal(CATCHUP_PASS_BUDGET_MS, 20_000, "budget de temps d'un passage : environ 20 s");
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 40].map((attempts) => catchupDelayMs(attempts)), [120_000, 240_000, 480_000, 960_000, 1_920_000, 3_600_000, 3_600_000, 3_600_000]);
  assert.equal(catchupEventId("123e4567-e89b-12d3-a456-426614174000", "payment.succeeded"), "sublymus_poll_123e4567e89b12d3a456426614174000_c");
  assert.equal(catchupEventId("123e4567-e89b-12d3-a456-426614174000", "payment.failed"), "sublymus_poll_123e4567e89b12d3a456426614174000_f");
  const entry: SublymusIntentSummary = { id: "pi_1", externalReference: "r", amountXof: BigInt(5000), currency: "XOF", status: "COMPLETED", payerId: null, sourceSystem: null, checkoutUrl: null };
  const judge = (changes: Partial<SublymusIntentSummary> = {}, stored: string | null = null) => judgeProviderIntent({ entry: { ...entry, ...changes }, expectedAmountXof: BigInt(5000), storedSublymusIntentId: stored, managerId: "mgr_1" });
  assert.deepEqual(judge(), { action: "apply", type: "payment.succeeded" });
  assert.deepEqual(judge({ status: "FAILED" }), { action: "apply", type: "payment.failed" });
  assert.deepEqual(judge({ status: "WAVE_CREATED" }), { action: "wait" });
  assert.deepEqual(judge({ status: "WEIRD" }), { action: "anomaly", kinds: ["status_mismatch"] });
  assert.deepEqual(judge({ amountXof: BigInt(4999) }), { action: "anomaly", kinds: ["amount_mismatch"] });
  assert.deepEqual(judge({ amountXof: null }), { action: "anomaly", kinds: ["invalid_amount"] });
  assert.deepEqual(judge({ currency: "USD" }), { action: "anomaly", kinds: ["currency_mismatch"] });
  assert.deepEqual(judge({ payerId: "autre" }), { action: "anomaly", kinds: ["payer_mismatch"] });
  assert.deepEqual(judge({ payerId: "mgr_1", sourceSystem: "NOMA" }), { action: "apply", type: "payment.succeeded" });
  assert.deepEqual(judge({ sourceSystem: "X" }), { action: "anomaly", kinds: ["source_mismatch"] });
  assert.deepEqual(judge({}, "pi_autre"), { action: "anomaly", kinds: ["intent_id_mismatch"] });
  assert.deepEqual(judge({ status: "COMPLETED", amountXof: BigInt(1) }), { action: "anomaly", kinds: ["amount_mismatch"] }, "un écart prime sur le statut : jamais de crédit avec un écart");
});

// ───────────── garde-fous du code source ─────────────

function filesUnder(directory: string, extensions: readonly string[]): string[] {
  const out: string[] = [];
  for (const name of readdirSync(join(ROOT, directory))) {
    const relative = `${directory}/${name}`;
    const stats = statSync(join(ROOT, relative));
    if (stats.isDirectory()) out.push(...filesUnder(relative, extensions));
    else if (extensions.some((extension) => name.endsWith(extension))) out.push(relative);
  }
  return out;
}

test("la clé de l'API et le secret de signature ne sont JAMAIS côté navigateur : aucune référence dans les pages, composants et modules clients, aucun import du code serveur du paiement", () => {
  const clientFiles = [...filesUnder("app", [".tsx", ".ts"]).filter((path) => !path.startsWith("app/api/")), ...filesUnder("components", [".tsx", ".ts"]), ...filesUnder("lib/client", [".ts", ".tsx"])];
  assert.ok(clientFiles.length > 50, `fichiers examinés : ${clientFiles.length}`);
  const forbidden = /WAVE_API_KEY|SUBLYMUS_WEBHOOK_SECRET|NOMA_SUBLYMUS_|NOMA_PAYMENT_PROVIDER|process\.env|wallet\/sublymus|wallet\/payment-provider|sublymus-fake-api|Authorization/;
  // Seule exception : la variable publique NEXT_PUBLIC_* du captcha (écrite pour le navigateur par Next.js, sans rapport avec le paiement).
  const offenders = clientFiles.filter((path) => forbidden.test(source(path).replace(/process\.env\.NEXT_PUBLIC_[A-Z0-9_]+/g, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1")));
  assert.deepEqual(offenders, [], `références interdites côté navigateur : ${offenders.join(", ")}`);
  // Les fichiers « use client » n'importent rien de lib/server.
  for (const path of clientFiles) {
    const text = source(path);
    if (/^["']use client["']/.test(text.trimStart())) assert.equal(/from ["']@\/lib\/server\//.test(text), false, `${path} importe du code serveur`);
  }
});

test("journal : le code Sublymus n'écrit jamais dans la console, ne journalise ni en-têtes, ni clé, ni secret, ni corps ; les erreurs du serveur sont des codes", () => {
  const directory = "lib/server/wallet/sublymus";
  for (const path of filesUnder(directory, [".ts"])) {
    const code = source(path).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    assert.equal(/console\.|process\.stdout|process\.stderr|JSON\.stringify\(\s*(config|headers|init)/.test(code), false, `${path} écrit dans la console ou sérialise ses réglages`);
  }
  const http = source("lib/server/wallet/http.ts");
  const journalCalls = [...http.matchAll(/journal\(([^)]*)\)/g)].map((match) => match[1]).concat([...http.matchAll(/unavailable\(([^),]*)/g)].map((match) => match[1]));
  for (const call of journalCalls) assert.equal(/apiKey|secret|header|body|payer|signature\)?\s*$/i.test(call) && !/"[a-z_]+"/.test(call), false, `journal suspect : ${call}`);
  assert.equal(/logCodeOf\(error\)/.test(http), true);
  const catchup = source("lib/server/wallet/sublymus/catchup.ts");
  assert.match(catchup, /catchup_error_\$\{code\}/, "codes stables");
});

test("la page de retour du navigateur ne crédite rien : elle ne fait que LIRE la recharge ; aucun appel qui confirme, simule ou crée un paiement", () => {
  const page = source("app/paiement-retour/[id]/page.tsx").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.match(page, /api\.wallet\.topup\(/);
  assert.equal(/createTopup|devPayments|\.confirm\(|\.fail\(|fakePayment|method:\s*["']POST/.test(page), false, "aucune écriture depuis la page de retour");
  assert.equal(/resultat/.test(page) && /status\s*[:=]+\s*["']succeeded["']/.test(page), false, "le paramètre de l'adresse ne décide jamais du statut");
  const view = source("lib/client/wallet-view.ts");
  const returnView = view.slice(view.indexOf("export function returnView("));
  assert.match(returnView, /case "succeeded":/);
  assert.equal(/input\.resultat\s*===\s*["']succes["']/.test(returnView), false, "« succes » dans l'adresse ne produit jamais « Paiement confirmé »");
  // La route du webhook n'accepte que POST et passe par le chemin unique ; aucune route GET de crédit.
  assert.deepEqual(readdirSync(join(ROOT, "app/api/webhooks/sublymus")), ["route.ts"]);
  assert.equal(/export async function GET/.test(source("app/api/webhooks/sublymus/route.ts")), false);
});

test("le crédit d'une recharge passe par la MÊME écriture que le prestataire fictif ; un seul appel d'écriture au grand livre pour les deux", () => {
  const topups = source("lib/server/wallet/topups.ts");
  assert.equal([...topups.matchAll(/kind: "topup"/g)].length, 1, "une seule écriture de recharge dans tout le code");
  for (const path of ["lib/server/wallet/sublymus/webhook.ts", "lib/server/wallet/sublymus/catchup.ts"]) {
    const code = source(path).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    assert.match(code, /applyProviderEventInTransaction\(/, `${path} passe par le chemin partagé`);
    assert.equal(/postWalletTransaction|recordWalletTransaction|UPDATE payment_intents|INSERT INTO wallet_/.test(code), false, `${path} n'écrit jamais lui-même au grand livre ni sur l'intention`);
  }
  assert.match(source("lib/server/wallet/fake-provider.ts"), /applyProviderEvent\(/);
});

test("documentation du fondateur : ordre des commandes, appel réel dès que la clé est présente, construction de production, API d'administration alignée", () => {
  const guide = source("PAIEMENT-WAVE.md");
  assert.match(guide, /`provider-check`, puis `checkout-test` à 100 F, payer, puis `intent-check`/, "l'ordre des commandes est expliqué");
  assert.match(guide, /appelle le VRAI service Sublymus dès que\s+`WAVE_API_KEY` est dans l'environnement/, "provider-check appelle le vrai service");
  assert.match(guide, /npm run build:production/);
  assert.match(guide, /jamais\*\* avec un build lancé\s+dans l'environnement du serveur/);
  assert.match(guide, /wallet:provider-intent-check -- --reference/);
  assert.match(guide, /expose\s+\*\*l'identifiant de la recharge\*\*/, "l'identifiant de la recharge est exposé par l'administration");
  assert.match(source("ADMIN.md"), /expose l'\*\*identifiant de la recharge\*\*/);
  // Le script de construction de production (lot SMS1-bis) est celui de la branche principale : ce lot ne le recrée pas, il le cite.
  const scripts = (JSON.parse(source("package.json")) as { scripts: Record<string, string> }).scripts;
  assert.equal(scripts["build:production"], "bash scripts/build-production.sh");
  assert.equal(typeof scripts["wallet:provider-intent-check"], "string");
});

test("constantes : corps de webhook 64 Kio, test du fondateur plafonné à 500 XOF, étape du rattrapage isolée dans le worker", () => {
  assert.equal(SUBLYMUS_WEBHOOK_MAX_BODY_BYTES, 64 * 1024);
  assert.equal(CHECKOUT_TEST_MAX_XOF, 500);
  const runner = source("lib/server/matching/runner.ts");
  const start = runner.indexOf("// Étape « paymentCatchup » (lot PAY1)");
  const step = runner.slice(start, runner.indexOf("// Étape « market » (lot H1)"));
  assert.ok(start > 0 && step.length > 0, "étape présente, AVANT « market »");
  assert.ok(start < runner.indexOf("// Étape « collect » (lot EXT1)"), "le rattrapage des paiements précède la collecte externe");
  assert.match(step, /try \{[\s\S]*runSublymusCatchupStep[\s\S]*\} catch \(error\) \{[\s\S]*catchup_error_/, "isolée par un try/catch");
  assert.match(source("scripts/matching-worker.ts"), /assertPaymentConfiguration\(process\.env\)/);
  assert.match(source("instrumentation.ts"), /runStartupChecks\(process\.env\)/);
  assert.match(source("lib/server/startup-guard.ts"), /\["paiement", assertPaymentConfiguration\]/);
});

test("/admin/paiements passe par la garde de l'espace d'administration (lot D3) et ses routes par le rôle administrateur vérifié en base ; aucune donnée personnelle dans la vue", () => {
  const layout = source("app/(admin)/layout.tsx");
  assert.match(layout, /await requireAdminSpace\(\);/);
  assert.ok(layout.indexOf("await requireAdminSpace()") < layout.indexOf("{children}"), "la garde précède la page");
  const home = source("app/(admin)/admin/page.tsx");
  for (const href of ["/admin/vendeurs", "/admin/marche", "/admin/reglages", "/admin/offres", "/admin/sms", "/admin/collecte", "/admin/paiements"]) {
    assert.match(home, new RegExp(`<Link href="${href}"[^>]*>`), `le tableau de bord d'administration lie ${href}`);
  }
  assert.match(home, /data-testid="admin-payments-link"/);
  const page = source("app/(admin)/admin/paiements/page.tsx");
  assert.match(page, /<AdminPage title="Paiements"/);
  assert.equal(/requireAdminSpace|notFound\(|redirect\(/.test(page), false, "la page n'a pas de garde propre : celle du gabarit s'applique");
  const routes = source("lib/server/admin/payments-http.ts");
  assert.match(routes, /is_admin = TRUE AND status = 'active'/);
  assert.match(routes, /if \(!admin\.rowCount\) return resourceNotFound\(\);/);
  assert.match(routes, /context\.originGuard\(request\)/, "origine vérifiée sur l'écriture");
  const overview = source("lib/server/wallet/sublymus/overview.ts").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.equal(/owner_id|payer_hint|external_reference|provider_reference|idempotency|phone|webhook_id/.test(overview.slice(overview.indexOf("export async function readPaymentsOverview"), overview.indexOf("export async function resolveAnomaly"))), false, "la vue ne lit ni propriétaire, ni référence, ni payeur, ni téléphone");
});

