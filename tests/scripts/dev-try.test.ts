import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, test } from "node:test";
import { checkDevelopmentNodeEnv } from "../../scripts/dev-proxy";
import {
  DEV_TRY_NEXT_PORT,
  DEV_TRY_PROXY_PORT,
  checkLocalDatabaseUrl,
  devLockMessage,
  isPortFree,
  isValidAuthSecret,
  prepareDevTry,
  readNextDevLock,
} from "../../scripts/dev-try";

/**
 * `npm run dev:try` : préparation de l'environnement, refus (hors développement, base distante, DATABASE_URL absent), verrou
 * de `next dev`, ports, arrêt si Next échoue au démarrage. AUCUN vrai Next ni worker n'est lancé ici : les essais en
 * processus enfant tournent dans un dossier temporaire vide (chemins absolus vers le script et le chargeur), et le seul qui
 * va jusqu'à `dev:full` utilise un FAUX Next (NOMA_DEV_FULL_NEXT_SCRIPT) qui sort aussitôt.
 */

const DATABASE_URL = "postgresql://noma_local:noma_local_only@127.0.0.1:55432/noma_essai";
const GOOD_AUTH_SECRET = Buffer.alloc(32, 7).toString("base64");
const GOOD_PROXY_SECRET = "p".repeat(40);
const SCRIPT = fileURLToPath(new URL("../../scripts/dev-try.ts", import.meta.url));
const LOADER = fileURLToPath(new URL("../../poc/node_modules/tsx/dist/loader.mjs", import.meta.url));

const temporaryDirectories: string[] = [];
/** Processus lancés par les tests (chacun dans son groupe) : tués à la fin même si une assertion a échoué avant leur arrêt normal. */
const spawned: ChildProcess[] = [];
function killGroup(child: ChildProcess): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    // groupe déjà terminé
  }
}
after(() => {
  for (const child of spawned) killGroup(child);
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
});

function fixedRandom(byte: number) {
  return (size: number) => Buffer.alloc(size, byte);
}

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

describe("dev:try : préparation de l'environnement", () => {
  test("DATABASE_URL est obligatoire dans l'environnement de lancement : aucune valeur par défaut", () => {
    for (const value of [undefined, "", "   "]) {
      const prepared = prepareDevTry({ DATABASE_URL: value });
      assert.equal(prepared.ok, false);
      assert.match((prepared as { reason: string }).reason, /DATABASE_URL est obligatoire dans l'environnement de lancement/);
      assert.match((prepared as { reason: string }).reason, /\.env\* ne sont pas lus/);
    }
  });

  test("réglages posés : développement, code OTP en console, drapeau du relais, origine 3212, Next sur 3211", () => {
    const prepared = prepareDevTry({ DATABASE_URL, PATH: "/usr/bin" }, fixedRandom(1));
    assert.ok(prepared.ok);
    const { env, nextPort, proxyPort, publicOrigin } = prepared.plan;
    assert.equal(DEV_TRY_NEXT_PORT, 3211);
    assert.equal(DEV_TRY_PROXY_PORT, 3212);
    assert.equal(nextPort, 3211);
    assert.equal(proxyPort, 3212);
    assert.equal(publicOrigin, "http://localhost:3212");
    assert.equal(env.NODE_ENV, "development");
    assert.equal(env.NOMA_DEV_OTP_CONSOLE, "1");
    assert.equal(env.NOMA_DEV_PROXY, "1");
    assert.equal(env.NOMA_AUTH_ORIGIN, "http://localhost:3212");
    assert.equal(env.PORT, "3211");
    assert.equal(env.DATABASE_URL, DATABASE_URL);
    assert.equal(env.PATH, "/usr/bin");
  });

  test("hors développement : REFUS (production, test, autre valeur), jamais d'écrasement silencieux de NODE_ENV", () => {
    for (const value of ["production", " production", "Production", "PRODUCTION", "production\t", "prod", "test", "staging", "Development", "DEVELOPMENT", "dev"]) {
      const prepared = prepareDevTry({ DATABASE_URL, NODE_ENV: value });
      assert.equal(prepared.ok, false, `NODE_ENV=${JSON.stringify(value)} doit être refusé`);
      const reason = (prepared as { reason: string }).reason;
      assert.match(reason, /ne démarre jamais hors développement/);
      assert.ok(reason.includes(value.trim()), "le message dit quelle valeur a été reçue");
      assert.equal(reason.includes(DATABASE_URL), false);
    }
    // Absent, vide ou « development » (espaces autour ignorés) : accepté ; NODE_ENV est alors posé à « development ».
    for (const value of [undefined, "", "   ", "development", " development "]) {
      const prepared = prepareDevTry({ DATABASE_URL, NODE_ENV: value });
      assert.ok(prepared.ok, `NODE_ENV=${String(value)} doit être accepté`);
      assert.equal(prepared.plan.env.NODE_ENV, "development");
    }
  });

  test("règle NODE_ENV partagée avec le relais : absent, vide ou exactement « development » après nettoyage, rien d'autre", () => {
    for (const value of [undefined, "", " ", "\t", "development", "  development\n"]) {
      assert.deepEqual(checkDevelopmentNodeEnv(value), { ok: true }, JSON.stringify(value));
    }
    for (const value of ["production", " production", "Production", "PRODUCTION", "prod", "test", "staging", "Development", "developmentx", "dev elopment"]) {
      const checked = checkDevelopmentNodeEnv(value);
      assert.equal(checked.ok, false, JSON.stringify(value));
      assert.equal((checked as { received: string }).received, value.trim());
    }
    // La valeur reçue est tronquée dans le message (jamais un texte arbitrairement long).
    assert.equal((checkDevelopmentNodeEnv("x".repeat(100)) as { received: string }).received.length, 20);
  });

  test("montage entièrement simulé : fausses sources, IA et captcha désactivés, quoi que dise l'environnement", () => {
    const prepared = prepareDevTry({ DATABASE_URL, NOMA_FAKE_SOURCES: "0", NOMA_AI_DISABLED: "0", NOMA_TURNSTILE_DISABLED: "0" });
    assert.ok(prepared.ok);
    assert.equal(prepared.plan.env.NOMA_FAKE_SOURCES, "1");
    assert.equal(prepared.plan.env.NOMA_AI_DISABLED, "1");
    assert.equal(prepared.plan.env.NOMA_TURNSTILE_DISABLED, "1");
    const bare = prepareDevTry({ DATABASE_URL });
    assert.ok(bare.ok);
    assert.equal(bare.plan.env.NOMA_FAKE_SOURCES, "1");
    assert.equal(bare.plan.env.NOMA_AI_DISABLED, "1");
    assert.equal(bare.plan.env.NOMA_TURNSTILE_DISABLED, "1");
  });

  test("notifications simulées (lot N1) : NOMA_DEV_NOTIFY_CONSOLE est transmise telle quelle au worker, jamais posée à votre place, et n'autorise pas un NODE_ENV hors développement", () => {
    const bare = prepareDevTry({ DATABASE_URL });
    assert.ok(bare.ok);
    assert.equal(bare.plan.env.NOMA_DEV_NOTIFY_CONSOLE, undefined, "jamais posée par défaut : aucun envoi simulé sans demande explicite");
    const asked = prepareDevTry({ DATABASE_URL, NOMA_DEV_NOTIFY_CONSOLE: "1" });
    assert.ok(asked.ok);
    assert.equal(asked.plan.env.NOMA_DEV_NOTIFY_CONSOLE, "1", "transmise au worker (dev:full lui passe l'environnement)");
    assert.equal(asked.plan.env.NODE_ENV, "development", "le verrou du transport exige NODE_ENV=development : dev:try le pose toujours");
    for (const nodeEnv of ["production", "test", "Production"]) {
      assert.equal(prepareDevTry({ DATABASE_URL, NODE_ENV: nodeEnv, NOMA_DEV_NOTIFY_CONSOLE: "1" }).ok, false, `NODE_ENV=${nodeEnv} : dev:try refuse de démarrer`);
    }
  });

  test("paiement simulé : NOMA_FAKE_PAYMENTS=1 toujours posé, secret généré (32 octets au moins) sans jamais être affiché", () => {
    const bare = prepareDevTry({ DATABASE_URL }, fixedRandom(5));
    assert.ok(bare.ok);
    assert.equal(bare.plan.env.NOMA_FAKE_PAYMENTS, "1");
    const secret = bare.plan.env.NOMA_FAKE_PAYMENT_SECRET as string;
    assert.ok(Buffer.byteLength(secret, "utf8") >= 32, "32 octets au moins (la règle de lib/server/wallet/fake-provider.ts)");
    // Quoi que dise l'environnement : le drapeau vaut « 1 » (comme les autres drapeaux de simulation).
    for (const flag of ["0", "", "true", "yes"]) {
      const forced = prepareDevTry({ DATABASE_URL, NOMA_FAKE_PAYMENTS: flag }, fixedRandom(5));
      assert.ok(forced.ok);
      assert.equal(forced.plan.env.NOMA_FAKE_PAYMENTS, "1", flag);
    }
    // Le secret n'apparaît dans aucun avertissement ni refus ; deux démarrages n'en partagent pas.
    assert.equal(JSON.stringify(bare.plan.warnings).includes(secret), false);
    const other = prepareDevTry({ DATABASE_URL });
    const another = prepareDevTry({ DATABASE_URL });
    assert.ok(other.ok && another.ok);
    assert.notEqual(other.plan.env.NOMA_FAKE_PAYMENT_SECRET, another.plan.env.NOMA_FAKE_PAYMENT_SECRET);
    // Il est tiré À PART des secrets d'authentification et de proxy (chaque secret a son propre tirage).
    let draw = 0;
    const sequential = prepareDevTry({ DATABASE_URL }, (size) => Buffer.alloc(size, (draw += 1)));
    assert.ok(sequential.ok);
    assert.equal(draw, 3, "trois tirages : authentification, proxy, prestataire fictif");
    const fake = sequential.plan.env.NOMA_FAKE_PAYMENT_SECRET;
    assert.notEqual(fake, sequential.plan.env.NOMA_AUTH_SECRET);
    assert.notEqual(fake, sequential.plan.env.NOMA_AUTH_PROXY_SECRET);
    // Les messages fixes d'avertissement n'ont pas changé (aucun avertissement de plus).
    assert.equal(bare.plan.warnings.length, 2);
  });

  test("paiement simulé : un secret fourni est conservé (espaces autour retirés) ; trop court : refus sans afficher la valeur", () => {
    const given = "q".repeat(40);
    const kept = prepareDevTry({ DATABASE_URL, NOMA_FAKE_PAYMENT_SECRET: `  ${given}  ` });
    assert.ok(kept.ok);
    assert.equal(kept.plan.env.NOMA_FAKE_PAYMENT_SECRET, given);
    assert.equal(kept.plan.env.NOMA_FAKE_PAYMENTS, "1");
    assert.equal(prepareDevTry({ DATABASE_URL, NOMA_FAKE_PAYMENT_SECRET: "q".repeat(32) }).ok, true, "32 octets : accepté");
    for (const short of ["trop-court", "q".repeat(31)]) {
      const refused = prepareDevTry({ DATABASE_URL, NOMA_FAKE_PAYMENT_SECRET: short });
      assert.equal(refused.ok, false, short);
      assert.match((refused as { reason: string }).reason, /NOMA_FAKE_PAYMENT_SECRET doit contenir au moins 32 octets/);
      assert.equal(JSON.stringify(refused).includes(short), false, "la valeur n'est jamais affichée");
    }
    // Vide ou espaces seulement : comme absent, un secret est généré.
    const blank = prepareDevTry({ DATABASE_URL, NOMA_FAKE_PAYMENT_SECRET: "   " }, fixedRandom(3));
    assert.ok(blank.ok);
    assert.ok(Buffer.byteLength(blank.plan.env.NOMA_FAKE_PAYMENT_SECRET as string, "utf8") >= 32);
  });

  test("le prestataire fictif reste soumis à la liste d'autorisation du serveur : hors développement, dev:try refuse de démarrer", () => {
    for (const nodeEnv of ["production", "test", "staging"]) {
      assert.equal(prepareDevTry({ DATABASE_URL, NODE_ENV: nodeEnv, NOMA_FAKE_PAYMENTS: "1" }).ok, false, nodeEnv);
    }
  });

  test("base de données : seulement CE poste (127.0.0.1, localhost, ::1), y compris par le paramètre host", () => {
    const accepted = [
      DATABASE_URL,
      "postgresql://u:p@localhost:5432/noma_essai",
      "postgres://u:p@LOCALHOST/noma_essai",
      "postgresql://u:p@[::1]:5432/noma_essai",
      "postgresql:///noma_essai?host=/var/run/postgresql",
      "postgresql://u:p@127.0.0.1/noma_essai?host=localhost",
      "postgresql://u:p@127.0.0.1/noma_essai?sslmode=disable",
      // Plusieurs occurrences, toutes locales.
      "postgresql://u:p@127.0.0.1/noma_essai?host=127.0.0.1&host=localhost",
      "postgresql://u:p@localhost/noma_essai?host=/var/run/postgresql&host=127.0.0.1&hostaddr=127.0.0.1&hostaddr=::1",
    ];
    for (const url of accepted) assert.deepEqual(checkLocalDatabaseUrl(url), { ok: true }, url);
    const refused = [
      "postgresql://u:secret-pw@db.example.com:5432/noma",
      "postgresql://u:secret-pw@192.168.1.20:5432/noma",
      "postgresql://u:secret-pw@10.0.0.2/noma",
      "postgresql://u:secret-pw@127.0.0.1.evil.example/noma",
      "postgresql://u:secret-pw@127.0.0.1/noma?host=db.example.com",
      "postgresql://u:secret-pw@localhost/noma?hostaddr=8.8.8.8",
      "postgresql:///noma?host=db.example.com",
      "postgresql:///noma",
      // pg-connection-string garde la DERNIÈRE occurrence : toutes doivent être locales (une seule distante suffit à refuser).
      "postgresql://u:secret-pw@127.0.0.1:55432/db?host=127.0.0.1&host=db.example.com",
      "postgresql://u:secret-pw@127.0.0.1:55432/db?host=db.example.com&host=127.0.0.1",
      "postgresql:///db?host=/var/run/postgresql&host=db.example.com",
      "postgresql://u:secret-pw@127.0.0.1/db?hostaddr=127.0.0.1&hostaddr=8.8.8.8",
      "postgresql://u:secret-pw@127.0.0.1/db?hostaddr=8.8.8.8&hostaddr=127.0.0.1",
      "postgresql://u:secret-pw@127.0.0.1/db?host=localhost&hostaddr=127.0.0.1&hostaddr=8.8.8.8",
      "postgresql://u:secret-pw@127.0.0.1/db?host=",
      "postgresql://u:secret-pw@127.0.0.1/db?host=127.0.0.1&host=",
      "postgresql://u:secret-pw@127.0.0.1:5432,db.example.com:5432/noma",
      "mysql://u:secret-pw@127.0.0.1/noma",
      "http://127.0.0.1/noma",
      "pas une adresse",
    ];
    for (const url of refused) {
      const checked = checkLocalDatabaseUrl(url);
      assert.equal(checked.ok, false, url);
      assert.equal(JSON.stringify(checked).includes("secret-pw"), false, "le mot de passe n'apparaît jamais dans le refus");
      const prepared = prepareDevTry({ DATABASE_URL: url });
      assert.equal(prepared.ok, false, url);
      assert.match((prepared as { reason: string }).reason, /base de CE poste/);
      assert.equal(JSON.stringify(prepared).includes("secret-pw"), false);
    }
  });

  test("secrets absents : générés au hasard (valides), avertissements sans valeur secrète ; les deux noms du secret de proxy sont égaux", () => {
    const prepared = prepareDevTry({ DATABASE_URL }, fixedRandom(9));
    assert.ok(prepared.ok);
    const { env, warnings } = prepared.plan;
    assert.ok(isValidAuthSecret(env.NOMA_AUTH_SECRET as string));
    assert.ok(Buffer.byteLength(env.NOMA_AUTH_PROXY_SECRET as string, "utf8") >= 32);
    assert.equal(env.NOMA_PROXY_SECRET, env.NOMA_AUTH_PROXY_SECRET);
    assert.equal(warnings.length, 2);
    assert.match(warnings.join(" "), /sessions ne survivent pas à un redémarrage/);
    for (const warning of warnings) {
      assert.equal(warning.includes(env.NOMA_AUTH_SECRET as string), false);
      assert.equal(warning.includes(env.NOMA_AUTH_PROXY_SECRET as string), false);
    }
    // Deux démarrages indépendants ne partagent pas de secret.
    const other = prepareDevTry({ DATABASE_URL });
    const another = prepareDevTry({ DATABASE_URL });
    assert.ok(other.ok && another.ok);
    assert.notEqual(other.plan.env.NOMA_AUTH_SECRET, another.plan.env.NOMA_AUTH_SECRET);
    assert.notEqual(other.plan.env.NOMA_AUTH_PROXY_SECRET, another.plan.env.NOMA_AUTH_PROXY_SECRET);
  });

  test("collecte d'annonces externes (lots EXT1 et RA1-bis) : le montage d'essai FORCE les connecteurs fictifs (comme les faux paiements), en développement seulement, avec le secret dont dérive la clé d'empreinte des identifiants", () => {
    // Sans variable : activée. Avec une valeur quelconque (« 0 », vide) : toujours « 1 », comme NOMA_FAKE_PAYMENTS. Le mode est « development » : les connecteurs n'existent jamais en production
    // (resolveConnectors), quoi que dise l'environnement.
    for (const given of [undefined, "1", "0", "", "true"]) {
      const prepared = prepareDevTry(given === undefined ? { DATABASE_URL } : { DATABASE_URL, NOMA_EXTERNAL_FAKE: given });
      assert.ok(prepared.ok);
      assert.equal(prepared.plan.env.NOMA_EXTERNAL_FAKE, "1", `valeur donnée : ${String(given)}`);
      assert.equal(prepared.plan.env.NODE_ENV, "development");
      assert.ok(isValidAuthSecret(prepared.plan.env.NOMA_AUTH_SECRET as string), "un secret d'au moins 32 octets est toujours présent pour le worker");
    }
  });

  test("secrets fournis : conservés tels quels, sans avertissement", () => {
    const prepared = prepareDevTry({ DATABASE_URL, NOMA_AUTH_SECRET: GOOD_AUTH_SECRET, NOMA_AUTH_PROXY_SECRET: GOOD_PROXY_SECRET });
    assert.ok(prepared.ok);
    assert.equal(prepared.plan.env.NOMA_AUTH_SECRET, GOOD_AUTH_SECRET);
    assert.equal(prepared.plan.env.NOMA_AUTH_PROXY_SECRET, GOOD_PROXY_SECRET);
    assert.equal(prepared.plan.env.NOMA_PROXY_SECRET, GOOD_PROXY_SECRET);
    assert.deepEqual(prepared.plan.warnings, []);
  });

  test("secrets fournis mais invalides : refus sans afficher la valeur", () => {
    for (const secret of ["pas-du-base64!", Buffer.alloc(16, 1).toString("base64"), "QUJD"]) {
      const prepared = prepareDevTry({ DATABASE_URL, NOMA_AUTH_SECRET: secret });
      assert.equal(prepared.ok, false, secret);
      assert.equal(JSON.stringify(prepared).includes(secret), false);
    }
    const shortProxy = prepareDevTry({ DATABASE_URL, NOMA_AUTH_PROXY_SECRET: "trop-court" });
    assert.equal(shortProxy.ok, false);
    assert.equal(JSON.stringify(shortProxy).includes("trop-court"), false);
  });

  test("ports : réglables pour la mise au point, jamais identiques ni invalides ; l'origine publique suit le port du relais", () => {
    const custom = prepareDevTry({ DATABASE_URL, NOMA_DEV_TRY_PORT: "4012", NOMA_DEV_TRY_NEXT_PORT: "4011" });
    assert.ok(custom.ok);
    assert.equal(custom.plan.publicOrigin, "http://localhost:4012");
    assert.equal(custom.plan.env.NOMA_AUTH_ORIGIN, "http://localhost:4012");
    assert.equal(custom.plan.env.PORT, "4011");
    assert.equal(prepareDevTry({ DATABASE_URL, NOMA_DEV_TRY_PORT: "3211" }).ok, false, "même port que Next");
    assert.equal(prepareDevTry({ DATABASE_URL, NOMA_DEV_TRY_PORT: "abc" }).ok, false);
    assert.equal(prepareDevTry({ DATABASE_URL, NOMA_DEV_TRY_NEXT_PORT: "70000" }).ok, false);
  });
});

describe("dev:try : verrou d'un autre next dev", () => {
  function projectWithLock(content: string | null): string {
    const directory = temporaryDirectory("noma-dev-try-lock-");
    if (content !== null) {
      mkdirSync(join(directory, ".next", "dev"), { recursive: true });
      writeFileSync(join(directory, ".next", "dev", "lock"), content);
    }
    return directory;
  }

  test("pas de verrou : on peut démarrer", () => {
    assert.equal(readNextDevLock(projectWithLock(null)), null);
    assert.equal(devLockMessage(null), null);
  });

  test("verrou d'un processus vivant : message clair en français avec le port, et on refuse", () => {
    const directory = projectWithLock(JSON.stringify({ pid: process.pid, port: 3210, hostname: "localhost" }));
    const lock = readNextDevLock(directory);
    assert.deepEqual(lock, { pid: process.pid, port: 3210 });
    assert.equal(
      devLockMessage(lock),
      "Un serveur next dev tourne déjà dans ce dossier (port 3210) : arrêtez-le ou utilisez une copie.",
    );
  });

  test("verrou d'un processus disparu : périmé, on peut démarrer ; verrou illisible : par prudence, on refuse", () => {
    assert.equal(devLockMessage({ pid: 4_000_000, port: 3210 }, () => false), null);
    const unreadable = readNextDevLock(projectWithLock("{pas du json"));
    assert.deepEqual(unreadable, { pid: null, port: null });
    assert.equal(
      devLockMessage(unreadable),
      "Un serveur next dev tourne déjà dans ce dossier : arrêtez-le ou utilisez une copie.",
    );
  });
});

interface Outcome {
  code: number | null;
  output: string;
  elapsedMs: number;
  timedOut: boolean;
}

/**
 * Lance `scripts/dev-try.ts` en processus enfant : cwd = dossier temporaire VIDE, chemins absolus vers le script et le chargeur,
 * environnement minimal, groupe de processus à part (tué en fin de test, même en cas d'échec) et délai maximal.
 */
function runDevTry(options: { cwd: string; env: Record<string, string | undefined>; maxMs: number }): Promise<Outcome> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn(process.execPath, ["--import", LOADER, SCRIPT], {
      cwd: options.cwd,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, ...options.env } as unknown as NodeJS.ProcessEnv,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    spawned.push(child);
    let output = "";
    let timedOut = false;
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child);
    }, options.maxMs);
    child.on("exit", (code) => {
      clearTimeout(timer);
      killGroup(child);
      resolve({ code, output, elapsedMs: Date.now() - startedAt, timedOut });
    });
  });
}

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

describe("dev:try lancé comme programme : refus clairs, rien n'est démarré", () => {
  const NOTHING_STARTED = (output: string) => {
    assert.equal(output.includes("Démarrage de Next"), false, "aucun démarrage");
    assert.equal(output.includes("noma est prêt"), false);
    assert.equal(output.includes("[auth:dev]"), false);
    assert.equal(output.includes("[dev:full]"), false);
  };

  test("DATABASE_URL absent → code 1, message en français", async () => {
    const result = await runDevTry({ cwd: temporaryDirectory("noma-dev-try-cwd-"), env: {}, maxMs: 40_000 });
    assert.equal(result.timedOut, false, "doit se terminer seul");
    assert.equal(result.code, 1);
    assert.match(result.output, /DATABASE_URL est obligatoire/);
    NOTHING_STARTED(result.output);
  });

  test("un .env.local (et un .env) avec DATABASE_URL dans le dossier courant NE SUFFIT PAS : refus, rien n'est démarré", async () => {
    const cwd = temporaryDirectory("noma-dev-try-envfile-");
    const fileContent = "DATABASE_URL=postgresql://noma_local:noma_local_only@127.0.0.1:1/noma_fichier\n";
    writeFileSync(join(cwd, ".env.local"), fileContent);
    writeFileSync(join(cwd, ".env"), fileContent);
    writeFileSync(join(cwd, ".env.development.local"), fileContent);
    const result = await runDevTry({ cwd, env: {}, maxMs: 40_000 });
    assert.equal(result.timedOut, false, "ne doit ni démarrer Next ni rester bloqué");
    assert.equal(result.code, 1);
    assert.match(result.output, /DATABASE_URL est obligatoire dans l'environnement de lancement/);
    NOTHING_STARTED(result.output);
  });

  test("NODE_ENV=production (ou test) avec une bonne base locale → refus, rien n'est démarré", async () => {
    for (const value of ["production", "test"]) {
      const result = await runDevTry({ cwd: temporaryDirectory("noma-dev-try-prod-"), env: { DATABASE_URL, NODE_ENV: value }, maxMs: 40_000 });
      assert.equal(result.timedOut, false, value);
      assert.equal(result.code, 1, value);
      assert.match(result.output, /ne démarre jamais hors développement/);
      NOTHING_STARTED(result.output);
    }
  });

  test("base de données distante → refus, rien n'est démarré, le mot de passe n'est pas affiché", async () => {
    const result = await runDevTry({
      cwd: temporaryDirectory("noma-dev-try-remote-"),
      env: { DATABASE_URL: "postgresql://noma:secret-pw@db.example.com:5432/noma_essai" },
      maxMs: 40_000,
    });
    assert.equal(result.timedOut, false);
    assert.equal(result.code, 1);
    assert.match(result.output, /base de CE poste/);
    assert.equal(result.output.includes("secret-pw"), false);
    NOTHING_STARTED(result.output);
  });
});

describe("dev:try : arrêt immédiat si dev:full se termine pendant le démarrage", () => {
  async function withFakeNext(source: string): Promise<Record<string, string>> {
    const directory = temporaryDirectory("noma-dev-try-fake-");
    const script = join(directory, "faux-next.js");
    writeFileSync(script, source);
    return {
      DATABASE_URL: "postgresql://noma_local:noma_local_only@127.0.0.1:1/noma_essai",
      // Faux Next (réservé aux tests, voir dev-full.ts) ; aucun verrou à contrôler dans ce dossier ; ports libres choisis.
      NOMA_DEV_FULL_NEXT_SCRIPT: script,
      NOMA_DEV_TRY_LOCK_DIR: directory,
      NOMA_DEV_TRY_NEXT_PORT: String(await freePort()),
      NOMA_DEV_TRY_PORT: String(await freePort()),
    };
  }

  test("un faux Next qui sort en code 1 : tout s'arrête en moins de 10 s, code 1, message clair (pas d'attente de 180 s)", async () => {
    const env = await withFakeNext('console.log("faux next : échec au démarrage"); process.exit(1);');
    const result = await runDevTry({ cwd: temporaryDirectory("noma-dev-try-cwd-"), env, maxMs: 60_000 });
    assert.equal(result.timedOut, false, "le processus doit se terminer seul");
    assert.equal(result.code, 1);
    assert.ok(result.elapsedMs < 10_000, `sortie en ${result.elapsedMs} ms (attendu < 10 s)`);
    assert.match(result.output, /Le serveur s'est arrêté de façon inattendue \(code 1\)/);
    assert.match(result.output, /Tout a été arrêté/);
    assert.equal(result.output.includes("noma est prêt"), false);
  });

  test("un faux Next qui sort en code 0 sans qu'on le demande : c'est aussi un échec (code 1), arrêt immédiat", async () => {
    const env = await withFakeNext("process.exit(0);");
    const result = await runDevTry({ cwd: temporaryDirectory("noma-dev-try-cwd-"), env, maxMs: 60_000 });
    assert.equal(result.timedOut, false);
    assert.equal(result.code, 1);
    assert.ok(result.elapsedMs < 10_000, `sortie en ${result.elapsedMs} ms (attendu < 10 s)`);
    assert.match(result.output, /s'est arrêté de façon inattendue/);
  });
});

describe("dev:try : ports", () => {
  test("isPortFree : vrai pour un port libre, faux pour un port occupé en IPv4", async () => {
    const holder = net.createServer();
    await new Promise<void>((resolve) => holder.listen(0, "127.0.0.1", resolve));
    const { port } = holder.address() as net.AddressInfo;
    assert.equal(await isPortFree(port), false);
    await new Promise<void>((resolve) => holder.close(() => resolve()));
    assert.equal(await isPortFree(port), true);
  });

  test("isPortFree : un port occupé en IPv6 SEULEMENT (::1) est aussi refusé", async (t) => {
    const holder = net.createServer();
    const listening = await new Promise<boolean>((resolve) => {
      holder.once("error", () => resolve(false));
      holder.listen({ port: 0, host: "::1", ipv6Only: true }, () => resolve(true));
    });
    if (!listening) {
      t.skip("IPv6 indisponible sur ce poste");
      return;
    }
    try {
      const { port } = holder.address() as net.AddressInfo;
      // Côté IPv4 le port est libre : seul le contrôle IPv6 peut le voir occupé.
      const ipv4Free = await new Promise<boolean>((resolve) => {
        const probe = net.createServer();
        probe.once("error", () => resolve(false));
        probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
      });
      assert.equal(ipv4Free, true, "précondition : le port est libre en IPv4");
      assert.equal(await isPortFree(port), false);
    } finally {
      await new Promise<void>((resolve) => holder.close(() => resolve()));
    }
  });
});

describe("ESSAYER.md reste cohérent avec les garde-fous de dev:try", () => {
  const guide = readFileSync(fileURLToPath(new URL("../../ESSAYER.md", import.meta.url)), "utf8");
  const normalized = guide.replace(/\s+/g, " ");

  test("le guide dit (lots P2, P2-bis, P3, M1, N1, D2, PRO1, PH1, H1, SMS1, EXT1, PAY1, MV1 et RA1) : base à 28 migrations, recharge simulée, achat de boost, « aucun argent réel », « Sponsorisé »", () => {
    for (const expected of [
      "28 migrations",
      "0028",
      "0027",
      "0026",
      "0025",
      "0024",
      "0023",
      "0022",
      "0021",
      "0020",
      "0019",
      "0018",
      "0017",
      "0016",
      "0015",
      "noma_schema_migrations",
      "Mon porte-monnaie",
      "Recharger",
      "paiement simulé",
      "SIMULATION — aucun argent réel",
      "Confirmer le paiement",
      "Faire échouer le paiement",
      "Solde insuffisant",
      "Acheter",
      "Confirmer l'achat",
      "Boost actif jusqu'au",
      "Sponsorisé",
      "Pas encore enregistré : l'achat peut encore aboutir.",
      "`noma_essai`, `noma_e2e` ou `noma_essai_…`",
      "aucun argent réel n'est utilisé",
      "NOMA_FAKE_PAYMENTS=1",
      "NOMA_FAKE_PAYMENT_SECRET",
      "ne définissez jamais ces variables en production",
    ]) {
      assert.ok(normalized.includes(expected), `ESSAYER.md doit contenir « ${expected} »`);
    }
    // Lot P2-bis (S1) : le badge n'est promis qu'avec assez d'offres comparables, et le guide explique comment les obtenir (dev:seed).
    for (const expected of [
      "npm run dev:seed -- --category phones --brand apple --model \"iphone 12\" --offers 8",
      "au moins **7 offres**",
      "Pour le moment, un boost ne ferait monter votre annonce chez aucun acheteur : leurs listes sont trop courtes, ou la place mise en avant y est déjà occupée par un boost acheté plus tôt.",
      "Mise en avant visible auprès de X acheteur(s)",
      "vendeurs fictifs",
      "+225 07 99 99 99 01",
      "Vérifier / réessayer",
      "Un boost n'est ni une garantie de position, ni une garantie de vente.",
    ]) {
      assert.ok(normalized.includes(expected), `ESSAYER.md doit contenir « ${expected} »`);
    }
    const seedStep = normalized.indexOf("npm run dev:seed");
    const quoteStep = normalized.indexOf("Booster cette annonce");
    assert.ok(seedStep !== -1 && quoteStep !== -1 && seedStep < quoteStep, "l'étape des annonces d'exemple vient AVANT l'essai du boost");
    assert.equal(/15 migrations/.test(normalized), false, "plus de trace de l'ancien compteur de migrations");
    assert.equal(/\b17 migrations/.test(normalized), false, "plus de trace de l'ancien compteur de migrations (17)");
    assert.equal(/l'annonce boostée est en tête avec le badge/.test(normalized), false, "le badge n'est plus promis sans condition");
    // Le guide ne dit plus que l'achat est éteint ou que le paiement n'existe pas.
    assert.equal(/le paiement n'existe pas encore/.test(normalized), false);
    assert.equal(/aucun paiement n'est possible/.test(normalized), false);
    assert.equal(/Paiement bientôt disponible/.test(normalized), false);
  });

  test("le guide dit (lot M1) : fiche d'annonce, contact, numéro jamais montré avant le contact, « moins de 5 » et « environ N », cinq acheteurs, limite de 20 vendeurs, rétention", () => {
    for (const expected of [
      "Voir l'annonce",
      "Contacter le vendeur",
      "sans jamais montrer le numéro du vendeur",
      "Le vendeur verra que vous l'avez contacté via noma.",
      "Appeler",
      "WhatsApp",
      "propres correspondances",
      "20 vendeurs différents par jour",
      "Ce que produit votre annonce",
      "moins de 5",
      "environ 10",
      "arrondis à 5 près",
      "cinq comptes acheteurs",
      "pas qu'elle a été lue",
      "aucune vente n'est mesurée",
      "MESURES.md",
      "npm run metrics:purge",
      "400 jours",
    ]) {
      assert.ok(normalized.includes(expected), `ESSAYER.md doit contenir « ${expected} »`);
    }
    const contactStep = normalized.indexOf("Contacter le vendeur");
    const boostPurchase = normalized.indexOf("acheter un boost");
    assert.ok(contactStep !== -1 && boostPurchase !== -1 && boostPurchase < contactStep, "le parcours de contact vient après l'achat du boost");
  });

  test("le guide dit (lot N1) : notifications, pastille, suivi du besoin, SMS simulé verrouillé (NOMA_DEV_NOTIFY_CONSOLE=1), jamais la nuit, 3 par jour, annulation, purge", () => {
    for (const expected of [
      "voir une notification",
      "pastille",
      "Tout marquer comme lu",
      "Voir l'annonce",
      "au plus **20 notifications par besoin et par jour**",
      "N nouvelles annonces pour ce besoin",
      "Suivi actif jusqu'au",
      "Prolonger de 30 jours",
      "Mettre en pause",
      "Reprendre",
      "les résultats restent à jour : seules les notifications s'arrêtent",
      "Notifications par SMS",
      "Me prévenir par SMS (simulé)",
      "désactivé par défaut",
      "Les envois par SMS ne sont pas encore disponibles : ils sont simulés en développement.",
      "Aucun vrai SMS n'existe",
      "NOMA_DEV_NOTIFY_CONSOLE=1",
      "dev:try",
      "[notify:dev] envoi simulé à",
      "identifiant tronqué",
      "un seul message",
      "jamais entre 22 h et 7 h",
      "3 messages par jour au plus",
      "quinze minutes",
      "4 heures au moins",
      "Créer ou modifier un besoin ne notifie jamais",
      "annonce nouvelle pour votre besoin",
      "ne marque que les notifications affichées",
      "tout est revérifié au moment d'envoyer",
      "annule les envois en attente",
      "aucun envoi n'a lieu",
      "npm run notifications:purge",
      "NOTIFICATIONS.md",
      "NODE_ENV=development",
    ]) {
      assert.ok(normalized.includes(expected), `ESSAYER.md doit contenir « ${expected} »`);
    }
    const seedStep = normalized.indexOf("npm run dev:seed");
    const notificationStep = normalized.indexOf("voir une notification");
    const smsStep = normalized.indexOf("activer l'envoi par SMS simulé");
    assert.ok(seedStep !== -1 && notificationStep > seedStep && smsStep > notificationStep, "les notifications viennent après les annonces d'exemple, l'envoi simulé après les notifications");
    assert.equal(/28 migrations/.test(normalized), true);
    assert.equal(/\b26 migrations/.test(normalized), false, "plus de trace de l'ancien compteur de migrations (26)");
    assert.equal(/\b25 migrations/.test(normalized), false, "plus de trace de l'ancien compteur de migrations (25)");
    assert.equal(/\b24 migrations/.test(normalized), false, "plus de trace de l'ancien compteur de migrations (24)");
    assert.equal(/\b23 migrations/.test(normalized), false, "plus de trace de l'ancien compteur de migrations (23)");
    assert.equal(/\b22 migrations/.test(normalized), false, "plus de trace de l'ancien compteur de migrations (22)");
    assert.equal(/\b21 migrations/.test(normalized), false, "plus de trace de l'ancien compteur de migrations (21)");
    assert.equal(/\b20 migrations/.test(normalized), false, "plus de trace de l'ancien compteur de migrations (20)");
    assert.equal(/\b19 migrations/.test(normalized), false, "plus de trace de l'ancien compteur de migrations (19)");
  });

  test("le guide dit : base indiquée dans la commande, base de CE poste, NODE_ENV, recherche simulée, besoins, port jamais exposé", () => {
    for (const expected of [
      "DATABASE_URL=…",
      "ne lit aucun fichier `.env`",
      "votre ordinateur",
      "NODE_ENV",
      "development",
      "jamais en production",
      "résultats d'exemple",
      "aucun vrai site n'est contacté",
      "n'exposez jamais le port 3212 par un tunnel",
      "loca.lt",
      "ngrok",
      "besoins",
      "un même acheteur peut avoir plusieurs besoins",
    ]) {
      assert.ok(normalized.includes(expected), `ESSAYER.md doit contenir « ${expected} »`);
    }
    // Le guide ne promet plus un « nombre d'acheteurs ».
    assert.equal(/combien d'acheteurs sont intéressés/.test(normalized), false);
  });
});
