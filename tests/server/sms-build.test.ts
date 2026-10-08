import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { after, before, test } from "node:test";

/**
 * C3 (lot SMS1-bis) — le build de production ne reçoit AUCUN secret et ne laisse ni cache ni fichier lisible par tous. Le script réel (scripts/build-production.sh) est copié dans un
 * dossier jetable ; la commande de build y est remplacée (option `--`) par de petites commandes de contrôle. Le vrai `next build` hors ligne est joué séparément (voir SMS.md).
 */

const ROOT = join(import.meta.dirname, "..", "..");
const SCRIPT = join(ROOT, "scripts", "build-production.sh");
const SECRETS = {
  NOMA_SMS_API_KEY: "SECRETKEY_c3_0123456789abcdef_unique",
  NOMA_AUTH_SECRET: "SECRETAUTH_c3_0123456789abcdef_unique",
  NOMA_IP_SECRET: "SECRETIP_c3_0123456789abcdef_unique",
  NOMA_PROXY_SECRET: "SECRETPROXY_c3_0123456789abcdef_unique",
  NOMA_TURNSTILE_SECRET: "SECRETTURN_c3_0123456789abcdef_unique",
  DATABASE_URL: "postgresql://noma:SECRETDB_c3_unique@127.0.0.1:5432/noma",
  UN_NOUVEAU_SECRET_AJOUTE_PLUS_TARD: "SECRETNEW_c3_0123456789abcdef_unique",
};
const PUBLIC = { NEXT_PUBLIC_TURNSTILE_SITE_KEY: "0x4AAAAAAA_public_site_key_c3" };

let sandbox: string;
let script: string;

before(() => {
  sandbox = mkdtempSync(join(tmpdir(), "noma-build-test-"));
  mkdirSync(join(sandbox, "scripts"));
  script = join(sandbox, "scripts", "build-production.sh");
  copyFileSync(SCRIPT, script);
  chmodSync(script, 0o755);
});
after(() => rmSync(sandbox, { recursive: true, force: true }));

function run(command: string[], extraEnv: Record<string, string> = {}, args: string[] = ["--"]) {
  rmSync(join(sandbox, ".next"), { recursive: true, force: true });
  const env = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? sandbox, ...SECRETS, ...PUBLIC, ...extraEnv } as unknown as NodeJS.ProcessEnv;
  return spawnSync("bash", [script, ...args, ...command], { cwd: sandbox, env, encoding: "utf8", timeout: 60_000 });
}

function listAll(directory: string, into: string[] = []): string[] {
  if (!existsSync(directory)) return into;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    into.push(path);
    if (entry.isDirectory()) listAll(path, into);
  }
  return into;
}

test("le build reçoit les variables NEXT_PUBLIC_* et le strict nécessaire, JAMAIS un secret (ni la clé Meno, ni NOMA_AUTH_SECRET, ni un secret ajouté plus tard)", () => {
  const result = run(["sh", "-c", "env > build-env.txt"]);
  assert.equal(result.status, 0, result.stderr);
  const seen = readFileSync(join(sandbox, "build-env.txt"), "utf8");
  for (const [name, value] of Object.entries(SECRETS)) {
    assert.equal(seen.includes(name), false, `${name} transmise au build`);
    assert.equal(seen.includes(value), false, `la valeur de ${name} est transmise au build`);
  }
  assert.match(seen, /^NEXT_PUBLIC_TURNSTILE_SITE_KEY=0x4AAAAAAA_public_site_key_c3$/m, "la clé publique est inlinée au build");
  assert.match(seen, /^PATH=/m);
  assert.match(seen, /^NODE_ENV=production$/m);
  assert.match(seen, /^NEXT_TELEMETRY_DISABLED=1$/m);
  const names = seen.split("\n").filter(Boolean).map((line) => line.split("=")[0]);
  const allowed = new Set(["PATH", "HOME", "SHELL", "NODE_ENV", "NEXT_TELEMETRY_DISABLED", "NEXT_PUBLIC_TURNSTILE_SITE_KEY", "PWD", "SHLVL", "_", "OLDPWD", "LANG", "LC_ALL", "TZ", "TMPDIR"]);
  for (const name of names) assert.ok(allowed.has(name), `variable inattendue transmise au build : ${name}`);
});

test("umask 077 : tout ce que le build écrit est privé (fichiers 0600, dossiers 0700), aucun droit pour le groupe ni les autres", () => {
  const result = run(["sh", "-c", 'umask > umask.txt; mkdir -p .next/server .next/cache/turbopack; echo page > .next/server/page.js; echo cache > .next/cache/turbopack/00000001.sst']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(readFileSync(join(sandbox, "umask.txt"), "utf8").trim(), /^0*77$/, "umask 077");
  for (const path of listAll(join(sandbox, ".next"))) {
    assert.equal(statSync(path).mode & 0o077, 0, `${relative(sandbox, path)} est lisible par un autre compte`);
  }
  assert.equal(statSync(join(sandbox, ".next", "server", "page.js")).mode & 0o777, 0o600);
});

test("même ce que l'outil de build crée avec ses propres droits (umask 000, comme le fait Turbopack pour certains fichiers) est rendu privé à la fin", () => {
  const result = run(["sh", "-c", "umask 000; mkdir -p .next/server/app .next/static; echo page > .next/server/app/page.js; echo chunk > .next/static/chunk.js"]);
  assert.equal(result.status, 0, result.stderr);
  for (const path of listAll(join(sandbox, ".next"))) {
    assert.equal(statSync(path).mode & 0o077, 0, `${relative(sandbox, path)} reste lisible par un autre compte`);
  }
  assert.equal(statSync(join(sandbox, ".next", "server", "app")).mode & 0o777, 0o700);
  assert.equal(statSync(join(sandbox, ".next", "static", "chunk.js")).mode & 0o777, 0o600);
});

test("le cache du build (.next/cache, où Turbopack retenait l'environnement) est supprimé après le build, le reste est conservé", () => {
  const result = run(["sh", "-c", "mkdir -p .next/server .next/cache/turbopack && echo x > .next/cache/turbopack/00000001.sst && echo page > .next/server/page.js"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(join(sandbox, ".next", "cache")), false);
  assert.equal(readFileSync(join(sandbox, ".next", "server", "page.js"), "utf8").trim(), "page");
  // Un build en échec : le code de sortie est conservé et le cache supprimé aussi.
  const failed = run(["sh", "-c", "mkdir -p .next/cache && echo x > .next/cache/a && exit 7"]);
  assert.equal(failed.status, 7);
  assert.equal(existsSync(join(sandbox, ".next", "cache")), false);
});

test("contrôle final : si une valeur secrète de l'appelant se retrouve dans .next, le build est EFFACÉ, le script échoue et la valeur n'est jamais affichée", () => {
  // La commande reçoit la valeur par son argument (simule un build qui l'aurait inlinée malgré tout).
  for (const [name, value] of Object.entries(SECRETS)) {
    const result = run(["sh", "-c", 'mkdir -p .next/static && echo "$0" > .next/static/chunk.js', value]);
    assert.equal(result.status, 1, `${name} dans .next : le script doit échouer`);
    assert.equal(existsSync(join(sandbox, ".next")), false, `${name} : .next effacé`);
    assert.equal(`${result.stdout}${result.stderr}`.includes(value), false, `${name} : la valeur est affichée`);
    assert.match(result.stderr, /valeur secrète/);
  }
  // Une valeur publique ou sans rapport dans .next ne fait pas échouer le build.
  const clean = run(["sh", "-c", 'mkdir -p .next/static && echo "$0" > .next/static/chunk.js', PUBLIC.NEXT_PUBLIC_TURNSTILE_SITE_KEY]);
  assert.equal(clean.status, 0, clean.stderr);
});

test("le script n'affiche ni nom ni valeur de secret, et refuse un usage incorrect", () => {
  const ok = run(["sh", "-c", "true"]);
  assert.equal(ok.status, 0);
  const output = `${ok.stdout}${ok.stderr}`;
  for (const value of Object.values(SECRETS)) assert.equal(output.includes(value), false);
  assert.match(output, /Aucun secret transmis au build/);
  assert.equal(run([], {}, ["--"]).status, 2, "commande manquante après --");
  assert.equal(run([], {}, ["--inconnue"]).status, 2, "argument inconnu");
});

test("variables d'environnement vides ou courtes : ignorées par le contrôle final (aucun faux positif sur une chaîne vide)", () => {
  const result = run(["sh", "-c", "mkdir -p .next && echo contenu > .next/a"], { NOMA_SMS_API_KEY: "", NOMA_AUTH_SECRET: "court", DATABASE_URL: "" });
  assert.equal(result.status, 0, result.stderr);
});

test("package.json expose build:production, le script est exécutable, et la séquence de déploiement l'utilise", () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> };
  assert.equal(manifest.scripts["build:production"], "bash scripts/build-production.sh");
  assert.equal(statSync(SCRIPT).mode & 0o111, 0o111, "exécutable");
  const deploiement = readFileSync(join(ROOT, "DEPLOIEMENT.md"), "utf8");
  assert.match(deploiement, /npm run build:production/);
  assert.doesNotMatch(deploiement, /set \+a; npm run build'/, "plus de build lancé directement après le chargement du fichier d'environnement");
  const sms = readFileSync(join(ROOT, "SMS.md"), "utf8");
  assert.match(sms, /build:production/);
});

test("la clé du fournisseur n'est lue qu'à l'EXÉCUTION : jamais d'accès littéral process.env.NOMA_SMS_API_KEY, jamais de lecture au chargement du module, jamais de NEXT_PUBLIC", () => {
  const directories = [join(ROOT, "lib", "server", "sms"), join(ROOT, "lib", "server", "auth"), join(ROOT, "lib", "server", "notifications")];
  const files = [...directories.flatMap((directory) => readdirSync(directory).filter((name) => name.endsWith(".ts")).map((name) => join(directory, name))), join(ROOT, "instrumentation.ts"), join(ROOT, "scripts", "sms-smoke.ts")];
  assert.ok(files.length > 20);
  for (const file of files) {
    const code = readFileSync(file, "utf8").replaceAll(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    assert.equal(/process\.env\s*(\.|\[)\s*["']?NOMA_SMS_API_KEY/.test(code), false, `${relative(ROOT, file)} : accès littéral à la clé (inlinable par un bundler)`);
    assert.equal(/NEXT_PUBLIC_[A-Z_]*(SMS|KEY_SECRET|AUTH)/.test(code), false, `${relative(ROOT, file)} : variable publique pour un secret`);
    for (const line of code.split("\n")) {
      if (!line.includes("process.env")) continue;
      // Chaque lecture de process.env est un paramètre par défaut, un argument ou une expression DANS une fonction : jamais une constante de module.
      assert.equal(/^(export\s+)?(const|let|var)\s/.test(line) && !/=>|function/.test(line), false, `${relative(ROOT, file)} : lecture de process.env au chargement du module : ${line.trim()}`);
    }
  }
});
