import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { runStartupChecks, STARTUP_REFUSED_EXIT_CODE } from "../../lib/server/startup-guard";

/** Code de sortie du refus de démarrer, écrit en dur ici : un changement de la constante doit faire échouer ce test (deploy/noma.service dépend de cette valeur). */
const REFUSED = 78;

/**
 * Correctif transversal (lot de reprise PAY1) : en production, un refus de configuration (SMS ou paiement) TERMINE le processus (code 78, EX_CONFIG) au lieu de le laisser vivant à répondre 500.
 * Cas unitaires avec sortie injectée, puis VRAIS processus (instrumentation.register appelée dans un processus enfant : code de sortie et sortie d'erreur observés).
 */

const ROOT = join(import.meta.dirname, "..", "..");
const SENTINEL_WAVE = "wave_SENTINEL_valeur_secrete_0123456789";
const SENTINEL_HOOK = "hook_SENTINEL_valeur_secrete_0123456789_abcdef";
const SENTINEL_BAD_SMS_KEY = "bad key SENTINEL_SMS";

const SMS_OK = {
  NODE_ENV: "production",
  NOMA_SMS_PROVIDER: "meno",
  NOMA_SMS_API_KEY: "fake_meno_key_for_tests_only_0001",
  NOMA_PUBLIC_URL: "https://noma.example.ci",
  NOMA_AUTH_SECRET: Buffer.alloc(32, 7).toString("base64"),
};
const PAY_OK = {
  NOMA_PAYMENT_PROVIDER: "sublymus",
  WAVE_API_KEY: SENTINEL_WAVE,
  NOMA_SUBLYMUS_MANAGER_ID: "manager_test_1",
  NOMA_SUBLYMUS_WALLET_ID: "wallet_test_1",
  SUBLYMUS_WEBHOOK_SECRET: SENTINEL_HOOK,
};

function attempt(env: Record<string, string | undefined>): { logs: string[]; exits: number[]; thrown: unknown } {
  const logs: string[] = [];
  const exits: number[] = [];
  let thrown: unknown = null;
  try {
    runStartupChecks(env, { log: (message) => logs.push(message), exit: (code) => { exits.push(code); } });
  } catch (error) {
    thrown = error;
  }
  return { logs, exits, thrown };
}

test("SMS1-ter — le code de sortie du refus de démarrer est le code dédié 78 (EX_CONFIG), distinct du code 1 d'une exception non rattrapée", () => {
  assert.equal(STARTUP_REFUSED_EXIT_CODE, 78);
  assert.equal(STARTUP_REFUSED_EXIT_CODE, REFUSED);
  const uncaught = spawnSync(process.execPath, ["-e", "throw new Error('x')"], { encoding: "utf8" });
  assert.equal(uncaught.status, 1, "une exception non rattrapée sort avec le code 1, relancé par Restart=on-failure");
  assert.notEqual(uncaught.status, REFUSED);
});

test("production : configuration SMS et paiement valides : ni journal, ni sortie", () => {
  const result = attempt({ ...SMS_OK, ...PAY_OK });
  assert.deepEqual(result, { logs: [], exits: [], thrown: null });
  assert.deepEqual(attempt({ NODE_ENV: "production" }), { logs: [], exits: [], thrown: null }, "ni SMS ni paiement configurés : rien à refuser");
});

test("production : refus du paiement (variables manquantes, prestataire fictif explicite, valeur inconnue) : message fixe journalisé, code 78, aucune valeur dans le journal", () => {
  const missing = attempt({ ...SMS_OK, NOMA_PAYMENT_PROVIDER: "sublymus", WAVE_API_KEY: SENTINEL_WAVE });
  assert.deepEqual(missing.exits, [REFUSED]);
  assert.equal(missing.logs.length, 1);
  assert.match(missing.logs[0], /Démarrage refusé : configuration paiement invalide en production/);
  assert.match(missing.logs[0], /NOMA_SUBLYMUS_MANAGER_ID/);
  assert.match(missing.logs[0], /SUBLYMUS_WEBHOOK_SECRET/);
  assert.ok(!missing.logs[0].includes(SENTINEL_WAVE), "la clé n'est jamais journalisée");
  assert.ok(missing.thrown instanceof Error, "le démarrage n'est jamais réputé réussi, même si la sortie revenait");

  const fake = attempt({ ...SMS_OK, NOMA_PAYMENT_PROVIDER: "fake" });
  assert.deepEqual(fake.exits, [REFUSED]);
  assert.match(fake.logs[0], /interdit en production/);

  const unknown = attempt({ ...SMS_OK, NOMA_PAYMENT_PROVIDER: "autre" });
  assert.deepEqual(unknown.exits, [REFUSED]);
  assert.match(unknown.logs[0], /doit valoir fake ou sublymus/);

  const insecureBase = attempt({ ...SMS_OK, ...PAY_OK, NOMA_SUBLYMUS_BASE_URL: "http://wallet.example" });
  assert.deepEqual(insecureBase.exits, [REFUSED]);
  assert.match(insecureBase.logs[0], /NOMA_SUBLYMUS_BASE_URL doit être en https en production/);
  for (const value of [SENTINEL_WAVE, SENTINEL_HOOK, "http://wallet.example"]) assert.ok(!insecureBase.logs[0].includes(value), "aucune valeur dans le journal");
});

test("production : refus du SMS (journal SMS, jamais la valeur de la clé), évalué AVANT le paiement : une seule sortie", () => {
  const result = attempt({ ...SMS_OK, ...PAY_OK, NOMA_SMS_API_KEY: SENTINEL_BAD_SMS_KEY, NOMA_SUBLYMUS_MANAGER_ID: undefined });
  assert.deepEqual(result.exits, [REFUSED], "une seule sortie : le premier refus arrête le démarrage");
  assert.equal(result.logs.length, 1);
  assert.match(result.logs[0], /Démarrage refusé : configuration SMS invalide en production/);
  assert.match(result.logs[0], /invalide \(format\)/);
  assert.ok(!result.logs[0].includes(SENTINEL_BAD_SMS_KEY));
  assert.ok(!/MANAGER_ID/.test(result.logs[0]), "le contrôle du paiement n'a pas été joué");
  assert.deepEqual(attempt({ ...SMS_OK, NOMA_SMS_API_KEY: undefined }).exits, [REFUSED]);
});

test("hors production : l'exception est relancée telle quelle, sans journal ni sortie (next dev l'affiche)", () => {
  for (const nodeEnv of ["development", "test", undefined, "Production", "production "]) {
    const env = { NODE_ENV: nodeEnv, NOMA_PAYMENT_PROVIDER: "sublymus", WAVE_API_KEY: SENTINEL_WAVE };
    const result = attempt(env);
    assert.deepEqual(result.exits, [], `NODE_ENV=${String(nodeEnv)} : le processus n'est pas terminé`);
    assert.deepEqual(result.logs, []);
    assert.ok(result.thrown instanceof Error && /NOMA_SUBLYMUS_MANAGER_ID/.test(result.thrown.message));
  }
});

test("SMS1-ter — budget des notifications nul (NOMA_SMS_DAILY_CAP=1) : refus en production (journal fixe, code 78), simple avertissement ailleurs (démarrage poursuivi)", () => {
  const refused = attempt({ ...SMS_OK, NOMA_SMS_DAILY_CAP: "1" });
  assert.deepEqual(refused.exits, [REFUSED]);
  assert.match(refused.logs[0], /Démarrage refusé : configuration SMS invalide en production : NOMA_SMS_DAILY_CAP trop bas : le budget des notifications serait nul/);
  assert.ok(refused.thrown instanceof Error);
  const warnings: string[] = [];
  for (const NODE_ENV of ["development", "test", undefined]) {
    const logs: string[] = [];
    const exits: number[] = [];
    runStartupChecks({ ...SMS_OK, NODE_ENV, NOMA_SMS_DAILY_CAP: "1" }, { log: (m) => logs.push(m), exit: (c) => { exits.push(c); }, warn: (m) => warnings.push(m) });
    assert.deepEqual({ logs, exits }, { logs: [], exits: [] }, `NODE_ENV=${String(NODE_ENV)} : pas de refus`);
  }
  assert.equal(warnings.length, 3, "un avertissement par démarrage");
  assert.match(warnings[0], /\[sms\] NOMA_SMS_DAILY_CAP est trop bas : le budget des notifications est nul/);
  // Plafond suffisant ou fournisseur non demandé : aucun avertissement.
  const quiet: string[] = [];
  runStartupChecks({ ...SMS_OK, NODE_ENV: "development", NOMA_SMS_DAILY_CAP: "2" }, { log: () => {}, exit: () => {}, warn: (m) => quiet.push(m) });
  runStartupChecks({ NODE_ENV: "development", NOMA_SMS_DAILY_CAP: "1" }, { log: () => {}, exit: () => {}, warn: (m) => quiet.push(m) });
  assert.deepEqual(quiet, []);
});

// ───────────── VRAIS processus ─────────────

const LOADER = join(ROOT, "poc", "node_modules", "tsx", "dist", "loader.mjs");
// register() est attendue ; une exception est CAPTURÉE (le processus n'est alors terminé que si register() l'a terminé elle-même : comme `next start`, qui reste vivant sur une exception).
const SCRIPT = "import { register } from './instrumentation.ts'; await register().then(() => console.log('register-resolved'), () => console.log('register-rejected'));";

function realRegister(env: Record<string, string>): { status: number | null; stdout: string; stderr: string } {
  const child = spawnSync(process.execPath, ["--import", LOADER, "--input-type=module", "-e", SCRIPT], {
    cwd: ROOT,
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "/tmp", NODE_OPTIONS: "--conditions=react-server", NEXT_RUNTIME: "nodejs", ...env } as unknown as NodeJS.ProcessEnv,
    encoding: "utf8",
    timeout: 60_000,
  });
  return { status: child.status, stdout: child.stdout, stderr: child.stderr };
}

test("vrai processus : register() en production avec une configuration SMS invalide TERMINE le processus (code 78), message fixe sur la sortie d'erreur, aucune valeur", () => {
  const child = realRegister({ ...SMS_OK, NOMA_SMS_API_KEY: SENTINEL_BAD_SMS_KEY });
  assert.equal(child.status, REFUSED, `${child.stdout}${child.stderr}`);
  assert.match(child.stderr, /Démarrage refusé : configuration SMS invalide en production/);
  assert.ok(!child.stdout.includes("register-resolved") && !child.stdout.includes("register-rejected"), "register() n'a pas rendu la main : le processus a été terminé par elle");
  assert.ok(!`${child.stdout}${child.stderr}`.includes(SENTINEL_BAD_SMS_KEY));
});

test("vrai processus : register() en production avec une configuration de paiement invalide TERMINE le processus (code 78), sans aucune valeur", () => {
  const child = realRegister({ ...SMS_OK, NOMA_PAYMENT_PROVIDER: "sublymus", WAVE_API_KEY: SENTINEL_WAVE });
  assert.equal(child.status, REFUSED, `${child.stdout}${child.stderr}`);
  assert.match(child.stderr, /Démarrage refusé : configuration paiement invalide en production/);
  assert.match(child.stderr, /NOMA_SUBLYMUS_MANAGER_ID/);
  assert.ok(!child.stdout.includes("register-resolved") && !child.stdout.includes("register-rejected"), "le processus a été terminé par register()");
  assert.ok(!`${child.stdout}${child.stderr}`.includes(SENTINEL_WAVE));
  const fake = realRegister({ ...SMS_OK, NOMA_PAYMENT_PROVIDER: "fake" });
  assert.equal(fake.status, REFUSED, "le prestataire fictif explicite est refusé en production");
});

test("vrai processus : configuration valide (valeurs témoins) : register() rend la main, code 0 ; hors production, une configuration invalide lève (pas de sortie forcée)", () => {
  const valid = realRegister({ ...SMS_OK, ...PAY_OK });
  assert.equal(valid.status, 0, `${valid.stdout}${valid.stderr}`);
  assert.match(valid.stdout, /register-resolved/);
  assert.ok(!valid.stderr.includes("Démarrage refusé"));
  const dev = realRegister({ NODE_ENV: "development", NOMA_PAYMENT_PROVIDER: "sublymus", WAVE_API_KEY: SENTINEL_WAVE });
  assert.equal(dev.status, 0, "hors production, le processus n'est pas terminé par le garde");
  assert.match(dev.stdout, /register-rejected/, "l'exception remonte à l'appelant (next dev l'affiche)");
  assert.ok(!dev.stdout.includes("register-resolved"));
  assert.ok(!/Démarrage refusé/.test(dev.stderr), "hors production, rien n'est journalisé par le garde");
});

test("SMS1-ter — vrai processus : budget des notifications nul : avertissement sur la sortie d'erreur hors production, refus (code 78) en production", () => {
  const dev = realRegister({ ...SMS_OK, NODE_ENV: "development", NOMA_SMS_DAILY_CAP: "1" });
  assert.equal(dev.status, 0, `${dev.stdout}${dev.stderr}`);
  assert.match(dev.stdout, /register-resolved/);
  assert.match(dev.stderr, /\[sms\] NOMA_SMS_DAILY_CAP est trop bas : le budget des notifications est nul/);
  const prod = realRegister({ ...SMS_OK, NOMA_SMS_DAILY_CAP: "1" });
  assert.equal(prod.status, REFUSED, `${prod.stdout}${prod.stderr}`);
  assert.match(prod.stderr, /NOMA_SMS_DAILY_CAP trop bas/);
  assert.ok(!prod.stdout.includes("register-resolved") && !prod.stdout.includes("register-rejected"));
});

// ───────────── modèle d'environnement, build et documentation ─────────────

const PAYMENT_VARIABLES = ["NOMA_PAYMENT_PROVIDER", "WAVE_API_KEY", "NOMA_SUBLYMUS_MANAGER_ID", "NOMA_SUBLYMUS_WALLET_ID", "SUBLYMUS_WEBHOOK_SECRET", "NOMA_SUBLYMUS_BASE_URL"];

test("deploy/env.production.example : les variables du paiement y figurent, VIDES (aucune clé versionnée) ; deploy/selftest.sh les contrôle", () => {
  const example = readFileSync(join(ROOT, "deploy", "env.production.example"), "utf8");
  for (const name of PAYMENT_VARIABLES) {
    assert.equal(example.split("\n").filter((line) => line === `${name}=`).length, 1, `${name} présente, vide`);
    assert.equal(new RegExp(`^${name}=.`, "m").test(example), false, `${name} sans valeur`);
  }
  assert.match(readFileSync(join(ROOT, "deploy", "selftest.sh"), "utf8"), /WAVE_API_KEY NOMA_SUBLYMUS_MANAGER_ID/, "la vérification de déploiement contrôle les variables du paiement");
});

test("build:production : aucune variable du paiement dans la liste blanche du build, les deux secrets sont surveillés par le contrôle final", () => {
  const script = readFileSync(join(ROOT, "scripts", "build-production.sh"), "utf8");
  const allowed = /ALLOWED=\(([\s\S]*?)\)\n/.exec(script)?.[1] ?? "";
  assert.ok(allowed.length > 50, "liste blanche trouvée");
  for (const name of PAYMENT_VARIABLES) assert.equal(allowed.includes(name), false, `${name} ne doit pas passer au build`);
  const secretNames = /SECRET_NAMES=\(([^)]*)\)/.exec(script)?.[1] ?? "";
  for (const name of ["WAVE_API_KEY", "SUBLYMUS_WEBHOOK_SECRET"]) assert.ok(secretNames.includes(name), `${name} surveillée dans .next`);
});

test("documentation : le processus se termine (code 78) sur un refus de configuration en production, dit dans DEPLOIEMENT.md, SMS.md et PAIEMENT-WAVE.md ; l'ancien « reste vivant » a disparu", () => {
  const deploy = readFileSync(join(ROOT, "DEPLOIEMENT.md"), "utf8");
  assert.match(deploy, /### Démarrage refusé : le processus se TERMINE \(SMS et paiement\)/);
  assert.match(deploy, /process\.exit\(78\)/);
  assert.match(deploy, /lib\/server\/startup-guard\.ts/);
  for (const file of ["SMS.md", "PAIEMENT-WAVE.md"]) {
    const text = readFileSync(join(ROOT, file), "utf8").replace(/\s+/g, " ");
    assert.match(text, /code (dédié )?78/, `${file} : code de sortie 78`);
    assert.match(text, /process\.exit\(78\)/, `${file} : process.exit(78)`);
  }
  const sms = readFileSync(join(ROOT, "SMS.md"), "utf8");
  assert.equal(/il ne se termine pas de lui-même/.test(sms), false, "SMS.md ne décrit plus un processus vivant qui répond 500");
  assert.match(readFileSync(join(ROOT, "instrumentation.ts"), "utf8"), /runStartupChecks\(process\.env\)/);
});

// ───────────── le worker applique les MÊMES contrôles (processus réels) ─────────────

function realWorker(env: Record<string, string>): { status: number | null; output: string } {
  const child = spawnSync(process.execPath, ["--import", LOADER, "scripts/matching-worker.ts", "--once"], {
    cwd: ROOT,
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "/tmp", NODE_OPTIONS: "--conditions=react-server", ...env } as unknown as NodeJS.ProcessEnv,
    encoding: "utf8",
    timeout: 60_000,
  });
  return { status: child.status, output: `${child.stdout}${child.stderr}` };
}

test("worker (vrai processus) : un contrôle SMS refusé en production empêche le démarrage (code 78, avant toute connexion), sans aucune valeur", () => {
  const refused = realWorker({ ...SMS_OK, NOMA_SMS_API_KEY: SENTINEL_BAD_SMS_KEY });
  assert.equal(refused.status, REFUSED, refused.output);
  assert.match(refused.output, /Matching worker : refus de démarrer : NOMA_SMS_API_KEY invalide \(format\)/);
  assert.ok(!refused.output.includes(SENTINEL_BAD_SMS_KEY));
});

test("worker (vrai processus) : un contrôle du paiement refusé empêche le démarrage (code 78, avant toute connexion à la base), le message nomme les variables sans valeur", () => {
  const databaseUrl = "postgresql://noma:motdepasse_SENTINEL@127.0.0.1:1/jamais_joignable";
  const refused = realWorker({ ...SMS_OK, DATABASE_URL: databaseUrl, NOMA_PAYMENT_PROVIDER: "sublymus", WAVE_API_KEY: SENTINEL_WAVE });
  assert.equal(refused.status, REFUSED, refused.output);
  assert.match(refused.output, /Matching worker : Configuration du paiement refusée/);
  assert.match(refused.output, /NOMA_SUBLYMUS_MANAGER_ID/);
  assert.ok(!refused.output.includes(SENTINEL_WAVE) && !refused.output.includes("motdepasse_SENTINEL"));
  const fake = realWorker({ ...SMS_OK, DATABASE_URL: databaseUrl, NOMA_PAYMENT_PROVIDER: "fake" });
  assert.equal(fake.status, REFUSED, fake.output);
  assert.match(fake.output, /interdit en production/);
});
