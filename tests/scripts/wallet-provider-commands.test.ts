import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { parseCheckoutTestArgs, parseIntentCheckArgs, runCheckoutTest, runIntentCheck, runProviderCheck } from "../../lib/server/wallet/sublymus/commands";
import { CHECKOUT_TEST_MAX_XOF } from "../../lib/server/wallet/sublymus/config";
import type { FakeSublymusApi } from "../../scripts/sublymus-fake-api";
import { TEST_API_KEY, TEST_MANAGER_ID, TEST_PUBLIC_URL, TEST_WALLET_ID, startApi } from "../postgres/sublymus-fixtures";

/**
 * Lot PAY1 : commandes du FONDATEUR (`wallet:provider-check`, `wallet:provider-checkout-test`), essayées contre la FAUSSE API locale seulement. Aucune n'est jamais lancée contre le
 * vrai Sublymus ici : sous NODE_ENV=test, le vrai service est refusé avant tout appel.
 */

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
let api: FakeSublymusApi;

before(async () => {
  api = await startApi();
});

after(async () => {
  await api.close();
});

function io(env: Record<string, string | undefined>, now = new Date("2026-10-08T10:00:00.000Z")) {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { env: { NODE_ENV: "test", ...env }, out: (line: string) => out.push(line), err: (line: string) => err.push(line), now: () => now } };
}

const baseEnv = (): Record<string, string> => ({
  WAVE_API_KEY: TEST_API_KEY, NOMA_SUBLYMUS_MANAGER_ID: TEST_MANAGER_ID, NOMA_SUBLYMUS_WALLET_ID: TEST_WALLET_ID, NOMA_PUBLIC_URL: TEST_PUBLIC_URL, NOMA_SUBLYMUS_BASE_URL: api.url,
});

const posts = (): number => api.requests.filter((entry) => entry.method === "POST").length;

// ═════════════ wallet:provider-check ═════════════

test("provider-check : « clé valide, portefeuille X, solde Y », LECTURE SEULE (seulement des GET), sans jamais afficher la clé", async () => {
  const run = io(baseEnv());
  const before = api.requests.length;
  assert.equal(await runProviderCheck(run.io), 0);
  assert.deepEqual(run.out, [`clé valide, portefeuille ${TEST_WALLET_ID}, solde 12 345 XOF`]);
  assert.deepEqual(run.err, []);
  const calls = api.requests.slice(before);
  assert.ok(calls.length >= 1);
  assert.ok(calls.every((entry) => entry.method === "GET"), "aucune écriture chez Sublymus");
  assert.deepEqual([...new Set(calls.map((entry) => entry.path))], ["/v1/wallets/main"]);
  assert.equal(calls[0].authorization, `Bearer ${TEST_API_KEY}`);
  assert.equal(calls[0].managerId, TEST_MANAGER_ID);
  assert.ok(![...run.out, ...run.err].join("\n").includes(TEST_API_KEY));
  assert.equal(posts(), 0);
});

test("provider-check : le solde est lu sur la route du portefeuille s'il n'est pas dans sa description ; solde illisible dit « non lisible »", async () => {
  const calls: string[] = [];
  const stub = (async (url: string, init: RequestInit) => {
    calls.push(`${init.method} ${new URL(url).pathname}`);
    if (new URL(url).pathname === "/v1/wallets/main") return new Response(JSON.stringify({ data: { id: "wal_x", name: "Principal" } }), { status: 200 });
    if (new URL(url).pathname === "/v1/wallets/wal_x/balance") return new Response(JSON.stringify({ data: { balance: { available: 2500 } } }), { status: 200 });
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
  const run = io(baseEnv());
  assert.equal(await runProviderCheck({ ...run.io, fetch: stub }), 0);
  assert.deepEqual(run.out, ["clé valide, portefeuille wal_x, solde 2 500 XOF"]);
  assert.deepEqual(calls, ["GET /v1/wallets/main", "GET /v1/wallets/wal_x/balance"]);
  const unreadable = io(baseEnv());
  const noBalance = (async (url: string) => (new URL(url).pathname === "/v1/wallets/main" ? new Response(JSON.stringify({ data: { id: "wal_y" } }), { status: 200 }) : new Response("{}", { status: 404 }))) as unknown as typeof fetch;
  assert.equal(await runProviderCheck({ ...unreadable.io, fetch: noBalance }), 0);
  assert.deepEqual(unreadable.out, ["clé valide, portefeuille wal_y, solde non lisible"]);
});

test("provider-check : variables manquantes (usage, code 2, aucune requête) ; clé refusée (code 1, message sans la clé) ; adresse du vrai service refusée sous NODE_ENV=test", async () => {
  const before = api.requests.length;
  for (const name of ["WAVE_API_KEY", "NOMA_SUBLYMUS_MANAGER_ID"]) {
    const env = baseEnv();
    delete (env as Record<string, string | undefined>)[name];
    const run = io(env);
    assert.equal(await runProviderCheck(run.io), 2);
    assert.ok(run.err.some((line) => line.includes(name)), name);
    assert.deepEqual(run.out, []);
  }
  const real = io({ ...baseEnv(), NOMA_SUBLYMUS_BASE_URL: undefined });
  let realCalls = 0;
  assert.equal(await runProviderCheck({ ...real.io, fetch: (async () => { realCalls += 1; return new Response("{}"); }) as typeof fetch }), 2);
  assert.ok(real.err.some((line) => line.includes("fausse API locale")));
  assert.equal(realCalls, 0, "le vrai service n'est jamais contacté sous NODE_ENV=test");
  assert.equal(api.requests.length, before, "aucune requête pour un usage refusé");
  const wrong = io({ ...baseEnv(), WAVE_API_KEY: "mauvaise_cle_inventee" });
  assert.equal(await runProviderCheck(wrong.io), 1);
  assert.ok(wrong.err.some((line) => line.includes("clé est refusée")));
  assert.ok(![...wrong.out, ...wrong.err].join("\n").includes("mauvaise_cle_inventee"));
  for (const url of ["https://wallet.sublymus.com", "ftp://x.example", "http://remote.example", "https://u:p@wallet.example"]) {
    const bad = io({ ...baseEnv(), NOMA_SUBLYMUS_BASE_URL: url });
    assert.equal(await runProviderCheck(bad.io), 2, url);
  }
});

// ═════════════ wallet:provider-checkout-test ═════════════

test("checkout-test : arguments (montant par défaut 100, drapeau de confirmation, tout autre argument refusé)", () => {
  assert.deepEqual(parseCheckoutTestArgs([]), { ok: true, options: { amountXof: 100, confirmed: false } });
  assert.deepEqual(parseCheckoutTestArgs(["--amount", "250", "--confirm-real-checkout"]), { ok: true, options: { amountXof: 250, confirmed: true } });
  assert.deepEqual(parseCheckoutTestArgs(["--confirm-real-checkout"]), { ok: true, options: { amountXof: 100, confirmed: true } });
  for (const bad of [["--amount"], ["--amount", "abc"], ["--amount", "-5"], ["--amount", "1.5"], ["--amount", "1e3"], ["--amount", ""], ["--montant", "100"], ["--confirm"], ["100"], ["--amount", "12345678901"]]) {
    assert.equal(parseCheckoutTestArgs(bad).ok, false, bad.join(" "));
  }
});

test("checkout-test : REFUSE sans --confirm-real-checkout, avant tout appel ; plafond de 500 XOF ; montants invalides refusés ; aucune session ouverte dans ces cas", async () => {
  const before = api.requests.length;
  const noFlag = io(baseEnv());
  assert.equal(await runCheckoutTest(noFlag.io, ["--amount", "100"]), 2);
  assert.ok(noFlag.err.some((line) => line.includes("--confirm-real-checkout")));
  const noArgs = io(baseEnv());
  assert.equal(await runCheckoutTest(noArgs.io, []), 2);
  for (const amount of ["501", "1000", "500000", "0"]) {
    const run = io(baseEnv());
    assert.equal(await runCheckoutTest(run.io, ["--amount", amount, "--confirm-real-checkout"]), 2, amount);
    assert.ok(run.err.some((line) => line.includes(String(CHECKOUT_TEST_MAX_XOF)) || line.includes("de 1 à")), amount);
  }
  const unknown = io(baseEnv());
  assert.equal(await runCheckoutTest(unknown.io, ["--confirm-real-checkout", "--force"]), 2);
  assert.equal(api.requests.length, before, "aucune requête pour un usage refusé");
  assert.equal(CHECKOUT_TEST_MAX_XOF, 500);
});

test("checkout-test : avec le drapeau, UNE session de faible montant, référence noma-test-<horodatage>, splits = montant, lien affiché ; ne crédite rien et n'ouvre aucune base", async () => {
  const run = io(baseEnv(), new Date("2026-10-08T10:00:00.123Z"));
  const before = posts();
  assert.equal(await runCheckoutTest(run.io, ["--amount", "100", "--confirm-real-checkout"]), 0);
  assert.equal(posts(), before + 1, "une seule session");
  const sent = api.requests.filter((entry) => entry.method === "POST").at(-1)!;
  const body = sent.body as Record<string, unknown>;
  assert.equal(body.external_reference, `noma-test-${new Date("2026-10-08T10:00:00.123Z").getTime()}`);
  assert.equal(body.amount, 100);
  assert.deepEqual((body.splits as Array<Record<string, unknown>>).map((split) => [split.wallet_id, split.amount, split.category, split.release_delay_hours]), [[TEST_WALLET_ID, 100, "PAYMENT", 0]]);
  assert.equal(body.success_url, `${TEST_PUBLIC_URL}/compte/porte-monnaie?paiement=test`);
  assert.equal(sent.authorization, `Bearer ${TEST_API_KEY}`);
  const text = run.out.join("\n");
  assert.match(text, /Session RÉELLE créée : 100 XOF, référence noma-test-\d+\./);
  assert.match(text, /Lien de paiement Wave : https:\/\/pay\.wave\.example\/c\/pi_[0-9a-f]+/);
  assert.match(text, /Rien n'est crédité dans noma/);
  assert.match(text, /payerId reçu : mg\*\*\* \(identique à NOMA_SUBLYMUS_MANAGER_ID\)/);
  assert.ok(!text.includes(TEST_API_KEY) && !text.includes(TEST_MANAGER_ID));
  // Plafond atteint : 500 passe. Montant par défaut : 100.
  const edge = io(baseEnv(), new Date("2026-10-08T11:00:00.000Z"));
  assert.equal(await runCheckoutTest(edge.io, ["--amount", "500", "--confirm-real-checkout"]), 0);
  const defaulted = io(baseEnv(), new Date("2026-10-08T12:00:00.000Z"));
  assert.equal(await runCheckoutTest(defaulted.io, ["--confirm-real-checkout"]), 0);
  assert.equal((api.requests.filter((entry) => entry.method === "POST").at(-1)!.body as Record<string, unknown>).amount, 100);
  // Aucune base : le module n'importe rien du client PostgreSQL ni du grand livre.
  const code = readFileSync(`${ROOT}lib/server/wallet/sublymus/commands.ts`, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.equal(/postgres|from "pg"|ledger|topups|DATABASE_URL|getPostgresPool/.test(code), false, "les commandes du fondateur ne touchent jamais la base de noma");
});

test("checkout-test : erreurs de Sublymus (401, 422, 500, adresse du vrai service sous NODE_ENV=test) : code 1 ou 2, message sans la clé, aucune session créée", async () => {
  for (const [mode, expected] of [["unauthorized", "clé est refusée"], ["unprocessable", "a refusé la requête"], ["server_error", "erreur interne"]] as const) {
    api.setMode(mode, { times: 1 });
    const run = io(baseEnv());
    const sessions = api.intents.size;
    assert.equal(await runCheckoutTest(run.io, ["--amount", "100", "--confirm-real-checkout"]), 1, mode);
    assert.ok(run.err.some((line) => line.includes(expected)), `${mode} : ${run.err.join("|")}`);
    assert.ok(![...run.out, ...run.err].join("\n").includes(TEST_API_KEY));
    assert.equal(api.intents.size, sessions);
  }
  api.setMode("ok");
  const real = io({ ...baseEnv(), NOMA_SUBLYMUS_BASE_URL: undefined });
  let realCalls = 0;
  assert.equal(await runCheckoutTest({ ...real.io, fetch: (async () => { realCalls += 1; return new Response("{}"); }) as typeof fetch }, ["--amount", "100", "--confirm-real-checkout"]), 2);
  assert.equal(realCalls, 0);
  const missing = io({ WAVE_API_KEY: TEST_API_KEY });
  assert.equal(await runCheckoutTest(missing.io, ["--confirm-real-checkout"]), 2);
  assert.ok(missing.err.some((line) => line.includes("NOMA_SUBLYMUS_WALLET_ID")) && missing.err.some((line) => line.includes("NOMA_PUBLIC_URL")));
});

// ═════════════ garde du vrai service ═════════════

test("sous NODE_ENV=test, les trois commandes n'admettent QUE la boucle locale : vrai service, casse, point final, noms voisins et autres adresses sont refusés (code 2) sans aucun appel", async () => {
  const urls = ["https://wallet.sublymus.com", "https://wallet.sublymus.com.", "https://WALLET.SUBLYMUS.COM.", "https://wallet.sublymus.com.evil.example", "https://autre.exemple", "http://192.168.1.10:4010", "http://localhost.evil.example"];
  for (const url of urls) {
    let calls = 0;
    const counting = (async () => { calls += 1; return new Response("{}"); }) as unknown as typeof fetch;
    const check = io({ ...baseEnv(), NOMA_SUBLYMUS_BASE_URL: url });
    assert.equal(await runProviderCheck({ ...check.io, fetch: counting }), 2, url);
    const checkout = io({ ...baseEnv(), NOMA_SUBLYMUS_BASE_URL: url });
    assert.equal(await runCheckoutTest({ ...checkout.io, fetch: counting }, ["--amount", "100", "--confirm-real-checkout"]), 2, url);
    const intent = io({ ...baseEnv(), NOMA_SUBLYMUS_BASE_URL: url });
    assert.equal(await runIntentCheck({ ...intent.io, fetch: counting }, ["--reference", "noma-test-1"]), 2, url);
    assert.equal(calls, 0, `aucun appel pour ${url}`);
    for (const run of [check, checkout, intent]) assert.ok(run.err.length > 0 && run.out.length === 0, `${url} : ${run.err.join("|")}`);
    // En https, c'est la garde « NODE_ENV=test » qui refuse (le reste est déjà refusé comme origine non https).
    if (url.startsWith("https://")) assert.ok(check.err.some((line) => line.includes("NODE_ENV=test")), `${url} : ${check.err.join("|")}`);
  }
  // La boucle locale reste admise (la fausse API).
  const local = io(baseEnv());
  assert.equal(await runProviderCheck(local.io), 0);
});

test("sans NODE_ENV (le fondateur dans son terminal), l'adresse par défaut est le VRAI service : un fetch bouchon intercepte https://wallet.sublymus.com (aucun appel réel), la clé n'est envoyée qu'en en-tête", async () => {
  const seen: Array<{ method: string; url: string; auth: string | null }> = [];
  const stub = (async (url: string, init: RequestInit) => {
    const target = new URL(url);
    seen.push({ method: String(init.method), url: `${target.origin}${target.pathname}`, auth: (init.headers as Record<string, string>).Authorization ?? null });
    if (target.origin !== "https://wallet.sublymus.com") return new Response("{}", { status: 404 });
    if (target.pathname === "/v1/wallets/main") return new Response(JSON.stringify({ data: { id: "wal_reel", balance: 4200 } }), { status: 200 });
    if (target.pathname === "/v1/checkout/complex") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ data: { payment_intent_id: "pi_bouchon", status: "WAVE_CREATED", wave_checkout_url: "https://pay.wave.com/c/pi_bouchon", amount: body.amount, currency: "XOF", external_reference: body.external_reference } }), { status: 201 });
    }
    if (target.pathname === "/v1/intents") {
      const reference = target.searchParams.get("external_reference") ?? "";
      return new Response(JSON.stringify({ data: [{ id: "pi_bouchon", externalReference: reference, payerId: "gestionnaire_reel_77", amount: 100, currency: "XOF", sourceSystem: "NOMA", status: "COMPLETED" }] }), { status: 200 });
    }
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
  const env = { WAVE_API_KEY: TEST_API_KEY, NOMA_SUBLYMUS_MANAGER_ID: "gestionnaire_reel_77", NOMA_SUBLYMUS_WALLET_ID: TEST_WALLET_ID, NOMA_PUBLIC_URL: TEST_PUBLIC_URL, NODE_ENV: undefined };
  const check = io(env);
  assert.equal(await runProviderCheck({ ...check.io, fetch: stub }), 0, check.err.join("|"));
  assert.deepEqual(check.out, ["clé valide, portefeuille wal_reel, solde 4 200 XOF"]);
  const checkout = io(env, new Date("2026-10-08T10:00:00.000Z"));
  assert.equal(await runCheckoutTest({ ...checkout.io, fetch: stub }, ["--amount", "100", "--confirm-real-checkout"]), 0, checkout.err.join("|"));
  assert.match(checkout.out.join("\n"), /Lien de paiement Wave : https:\/\/pay\.wave\.com\/c\/pi_bouchon/);
  const intent = io(env);
  assert.equal(await runIntentCheck({ ...intent.io, fetch: stub }, ["--reference", `noma-test-${new Date("2026-10-08T10:00:00.000Z").getTime()}`]), 0, intent.err.join("|"));
  assert.ok(seen.length >= 4 && seen.every((entry) => entry.url.startsWith("https://wallet.sublymus.com/")), JSON.stringify(seen));
  assert.ok(seen.every((entry) => entry.auth === `Bearer ${TEST_API_KEY}`));
  for (const text of [...check.out, ...check.err, ...checkout.out, ...checkout.err, ...intent.out, ...intent.err]) assert.ok(!text.includes(TEST_API_KEY));
  // Le lien d'une session doit être sur un domaine Wave : un autre domaine est refusé, la commande échoue (code 1) et n'affiche aucun lien.
  const phishing = (async (url: string, init: RequestInit) => {
    const target = new URL(url);
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({ data: { payment_intent_id: "pi_x", status: "WAVE_CREATED", wave_checkout_url: `https://evil.example${target.pathname}`, amount: body.amount, currency: "XOF", external_reference: body.external_reference } }), { status: 201 });
  }) as unknown as typeof fetch;
  const refused = io(env);
  assert.equal(await runCheckoutTest({ ...refused.io, fetch: phishing }, ["--amount", "100", "--confirm-real-checkout"]), 1);
  assert.ok(!refused.out.join("\n").includes("evil.example"));
});

// ═════════════ wallet:provider-intent-check ═════════════

test("intent-check : arguments (--reference obligatoire, une seule référence lisible, tout autre argument refusé)", () => {
  assert.deepEqual(parseIntentCheckArgs(["--reference", "noma-test-1760000000000"]), { ok: true, reference: "noma-test-1760000000000" });
  for (const bad of [[], ["--reference"], ["--reference", ""], ["--reference", "avec espace"], ["--reference", "a", "--reference", "b"], ["--ref", "a"], ["noma-test-1"], ["--reference", "x".repeat(101)], ["--reference", "a", "--force"]]) {
    assert.equal(parseIntentCheckArgs(bad).ok, false, bad.join(" "));
  }
});

test("intent-check : relit la session APRÈS paiement (statut, montant, devise, source), payerId masqué en partie avec verdict sur le gestionnaire ; LECTURE SEULE, référence EXACTE seulement", async () => {
  const reference = "noma-test-1760000000001";
  const paid = api.seed({ externalReference: reference, amount: 100, status: "COMPLETED", payerId: TEST_MANAGER_ID });
  api.seed({ externalReference: `${reference}9`, amount: 999, status: "COMPLETED", payerId: "voisin_pas_le_bon" });
  const before = api.requests.length;
  const run = io(baseEnv());
  assert.equal(await runIntentCheck(run.io, ["--reference", reference]), 0, run.err.join("|"));
  const text = run.out.join("\n");
  assert.match(text, new RegExp(`session ${paid.id} : statut COMPLETED, montant 100 XOF, devise XOF, système source NOMA\\.`));
  assert.match(text, /payerId reçu : mg\*\*\*01 \(IDENTIQUE à NOMA_SUBLYMUS_MANAGER_ID\)/);
  assert.ok(!text.includes("voisin_pas_le_bon") && !text.includes("999"), "le voisin n'est jamais montré");
  assert.ok(!text.includes(TEST_MANAGER_ID), "le payerId n'est jamais entier");
  assert.match(text, /Lecture seule/);
  const calls = api.requests.slice(before);
  assert.deepEqual(calls.map((entry) => `${entry.method} ${entry.path}`), [`GET /v1/intents?external_reference=${reference}`]);
  // Payeur différent du gestionnaire, absent, session introuvable, doublon.
  const other = api.seed({ externalReference: "noma-test-1760000000002", amount: 100, status: "WAVE_CREATED", payerId: "quelqu_un_d_autre_42" });
  const different = io(baseEnv());
  assert.equal(await runIntentCheck(different.io, ["--reference", other.externalReference]), 0);
  assert.match(different.out.join("\n"), /statut WAVE_CREATED/);
  assert.match(different.out.join("\n"), /payerId reçu : qu\*\*\*42 \(DIFFÉRENT de NOMA_SUBLYMUS_MANAGER_ID\)/);
  assert.ok(!different.out.join("\n").includes("quelqu_un_d_autre_42"));
  const noPayer = io(baseEnv());
  const stub = (async () => new Response(JSON.stringify({ data: [{ id: "pi_np", externalReference: "noma-test-3", amount: "100.0", currency: "XOF", status: "COMPLETED" }] }), { status: 200 })) as unknown as typeof fetch;
  assert.equal(await runIntentCheck({ ...noPayer.io, fetch: stub }, ["--reference", "noma-test-3"]), 0);
  assert.match(noPayer.out.join("\n"), /payerId : absent de la réponse de Sublymus/);
  const missing = io(baseEnv());
  assert.equal(await runIntentCheck(missing.io, ["--reference", "noma-test-inexistant"]), 1);
  assert.ok(missing.err.some((line) => line.includes("Aucune session")));
  api.seed({ externalReference: "noma-test-1760000000003", amount: 100, status: "COMPLETED" });
  api.seed({ externalReference: "noma-test-1760000000003", amount: 100, status: "COMPLETED" });
  const twin = io(baseEnv());
  assert.equal(await runIntentCheck(twin.io, ["--reference", "noma-test-1760000000003"]), 0);
  assert.match(twin.out.join("\n"), /ATTENTION : 2 sessions portent cette référence/);
  // Erreurs de Sublymus : code 1, message sans la clé ; variables manquantes : code 2 sans requête.
  api.setMode("unauthorized", { times: 1 });
  const refused = io(baseEnv());
  assert.equal(await runIntentCheck(refused.io, ["--reference", reference]), 1);
  assert.ok(refused.err.some((line) => line.includes("clé est refusée")) && !refused.err.join("\n").includes(TEST_API_KEY));
  const none = api.requests.length;
  const noKey = io({ ...baseEnv(), WAVE_API_KEY: undefined });
  assert.equal(await runIntentCheck(noKey.io, ["--reference", reference]), 2);
  assert.equal(await runIntentCheck(io(baseEnv()).io, []), 2);
  assert.equal(api.requests.length, none);
  // Aucune base, aucune écriture : seulement des GET.
  assert.ok(api.requests.every((entry) => entry.method === "GET" || entry.path === "/v1/checkout/complex"));
});

// ═════════════ scripts (processus réels, fausse API) ═════════════

function runScript(script: string, args: string[], env: Record<string, string>): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", "./poc/node_modules/tsx/dist/loader.mjs", script, ...args], {
      cwd: ROOT,
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", NODE_OPTIONS: "--conditions=react-server", NODE_ENV: "test", ...env },
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk: Buffer) => { out += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { err += chunk.toString(); });
    child.on("close", (code) => resolve({ code, out, err }));
  });
}

test("scripts : npm run wallet:provider-check et wallet:provider-checkout-test (processus réels) : lecture seule, refus sans drapeau, session de test avec drapeau ; la clé n'apparaît nulle part", async () => {
  const before = api.requests.length;
  const check = await runScript("scripts/wallet-provider-check.ts", [], baseEnv());
  assert.equal(check.code, 0, check.err);
  assert.equal(check.out.trim(), `clé valide, portefeuille ${TEST_WALLET_ID}, solde 12 345 XOF`);
  const refused = await runScript("scripts/wallet-provider-checkout-test.ts", ["--amount", "100"], baseEnv());
  assert.equal(refused.code, 2);
  assert.match(refused.err, /--confirm-real-checkout/);
  const capped = await runScript("scripts/wallet-provider-checkout-test.ts", ["--amount", "900", "--confirm-real-checkout"], baseEnv());
  assert.equal(capped.code, 2);
  const created = await runScript("scripts/wallet-provider-checkout-test.ts", ["--amount", "100", "--confirm-real-checkout"], baseEnv());
  assert.equal(created.code, 0, created.err);
  assert.match(created.out, /Lien de paiement Wave : https:\/\/pay\.wave\.example\/c\/pi_/);
  for (const text of [check.out, check.err, refused.out, refused.err, capped.err, created.out, created.err]) assert.ok(!text.includes(TEST_API_KEY));
  const newCalls = api.requests.slice(before);
  assert.equal(newCalls.filter((entry) => entry.method === "POST").length, 1, "une seule session créée par l'ensemble");
  const reference = String((api.requests.filter((entry) => entry.method === "POST").at(-1)!.body as Record<string, unknown>).external_reference);
  const intentCheck = await runScript("scripts/wallet-provider-intent-check.ts", ["--reference", reference], baseEnv());
  assert.equal(intentCheck.code, 0, intentCheck.err);
  assert.match(intentCheck.out, /statut WAVE_CREATED, montant 100 XOF/);
  assert.ok(!intentCheck.out.includes(TEST_API_KEY) && !intentCheck.err.includes(TEST_API_KEY));
  assert.equal((await runScript("scripts/wallet-provider-intent-check.ts", [], baseEnv())).code, 2);
  const pkg = JSON.parse(readFileSync(`${ROOT}package.json`, "utf8")) as { scripts: Record<string, string> };
  assert.match(pkg.scripts["wallet:provider-intent-check"], /scripts\/wallet-provider-intent-check\.ts$/);
  assert.match(pkg.scripts["wallet:provider-check"], /scripts\/wallet-provider-check\.ts$/);
  assert.match(pkg.scripts["wallet:provider-checkout-test"], /scripts\/wallet-provider-checkout-test\.ts$/);
});

test("démarrage du worker : Sublymus choisi sans ses variables = refus de démarrer (code 1, message nommant les variables, jamais les valeurs), avant toute connexion", async () => {
  const run = await runScript("scripts/matching-worker.ts", ["--once"], {
    DATABASE_URL: "postgresql://noma_local:noma_local_only@127.0.0.1:1/noma_inexistante", NOMA_PAYMENT_PROVIDER: "sublymus", WAVE_API_KEY: "cle_inventee_du_worker_0001", NODE_ENV: "production",
  });
  assert.equal(run.code, 1);
  assert.match(run.err, /Configuration du paiement refusée/);
  assert.match(run.err, /NOMA_SUBLYMUS_MANAGER_ID/);
  assert.match(run.err, /SUBLYMUS_WEBHOOK_SECRET/);
  assert.ok(!run.err.includes("cle_inventee_du_worker_0001"));
  assert.ok(!/ECONNREFUSED|connect/i.test(run.err), "refus avant toute connexion à la base");
});
