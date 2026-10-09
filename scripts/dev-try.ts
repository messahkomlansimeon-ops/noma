/**
 * `npm run dev:try` : UNE commande pour essayer l'application dans un vrai navigateur (voir ESSAYER.md).
 *
 * Lance `dev:full` (Next sur le port 3211 + worker du matching) ET le relais de développement (scripts/dev-proxy.ts) sur
 * le port 3212 : le navigateur ouvre http://localhost:3212, le relais ajoute les en-têtes du proxy de confiance exigés
 * par la connexion, et la sortie du serveur (où s'affiche le code de connexion) reste dans CE terminal.
 *
 * Réglages posés ici : NODE_ENV=development, NOMA_DEV_OTP_CONSOLE=1 (le code OTP s'écrit dans la sortie du serveur ;
 * aucun SMS), NOMA_DEV_PROXY=1, NOMA_AUTH_ORIGIN=http://localhost:3212, PORT=3211, et un montage ENTIÈREMENT SIMULÉ :
 * NOMA_FAKE_SOURCES=1, NOMA_AI_DISABLED=1, NOMA_TURNSTILE_DISABLED=1 (la recherche rapide montre des résultats d'exemple, sans
 * contacter de vrais sites, sans IA, sans captcha) et NOMA_FAKE_PAYMENTS=1 (prestataire de paiement FICTIF : la recharge du
 * porte-monnaie passe par la page « paiement simulé », aucun argent réel). Les secrets NOMA_AUTH_SECRET, NOMA_AUTH_PROXY_SECRET
 * et NOMA_FAKE_PAYMENT_SECRET sont lus dans l'environnement s'ils existent (le dernier : 32 octets au moins, sinon refus) ;
 * sinon ils sont générés au hasard à chaque démarrage (les sessions ne survivent alors pas à un redémarrage ; le secret du
 * prestataire fictif n'est jamais affiché).
 *
 * Garde-fous (refus clair, code de sortie 1, rien n'est démarré) :
 *  - DATABASE_URL est OBLIGATOIRE dans l'environnement de lancement (aucune valeur par défaut, aucun fichier .env* lu ici : un
 *    .env.local ne choisit jamais la base à votre place) et doit désigner une base de CE poste (127.0.0.1, localhost, ::1) ;
 *  - NODE_ENV, s'il est défini et non vide, doit valoir « development » (jamais de démarrage en production ni en test) ;
 *  - un autre `next dev` tient déjà le verrou de ce dossier ; un des ports est occupé.
 * Aucune migration n'est appliquée.
 *
 * Variables de mise au point (facultatives) : NOMA_DEV_TRY_PORT (relais, défaut 3212), NOMA_DEV_TRY_NEXT_PORT (Next, défaut
 * 3211). RÉSERVÉE AUX TESTS : NOMA_DEV_TRY_LOCK_DIR (dossier où chercher `.next/dev/lock`, défaut : la racine du projet) ;
 * NOMA_DEV_FULL_NEXT_SCRIPT est transmise à `dev:full` (faux Next).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import net from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isValidSmsApiKey, readSmsConfig } from "../lib/server/sms/config";
import { DEV_PROXY_MIN_SECRET_BYTES, checkDevelopmentNodeEnv, createDevProxy } from "./dev-proxy";

export const DEV_TRY_NEXT_PORT = 3211;
export const DEV_TRY_PROXY_PORT = 3212;
const READY_TIMEOUT_MS = 180_000;
const KILL_GRACE_MS = 20_000;
/** Taille minimale du secret du prestataire fictif (FAKE_SECRET_MIN_BYTES de lib/server/wallet/config.ts). */
const FAKE_PAYMENT_MIN_SECRET_BYTES = 32;
/** Hôtes de base de données acceptés : uniquement ce poste. */
const LOCAL_DATABASE_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

export type DevTryEnvironment = Record<string, string | undefined>;

export interface DevTryPlan {
  /** Environnement complet du processus `dev:full` (Next + worker). Contient des secrets : ne jamais l'afficher. */
  env: NodeJS.ProcessEnv;
  nextPort: number;
  proxyPort: number;
  /** Origine à ouvrir dans le navigateur (== NOMA_AUTH_ORIGIN). */
  publicOrigin: string;
  /** Avertissements fixes à afficher (jamais de valeur secrète). */
  warnings: string[];
  /** Transport du code de connexion : la console du serveur, ou un FAUX serveur SMS de ce poste (lot SMS1, jamais un vrai SMS). */
  smsMode: "console" | "meno-local";
}

export type DevTryPreparation = { ok: true; plan: DevTryPlan } | { ok: false; reason: string };

function validPort(raw: string | undefined, fallback: number): number | null {
  if (raw === undefined || raw.trim() === "") return fallback;
  const port = Number(raw.trim());
  return Number.isInteger(port) && port >= 1 && port <= 65_535 ? port : null;
}

/** Même règle que lib/server/auth/config.ts (requireAuthSecret) : base64 canonique d'au moins 32 octets. */
export function isValidAuthSecret(value: string): boolean {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) return false;
  const decoded = Buffer.from(value, "base64");
  return decoded.toString("base64") === value && decoded.byteLength >= 32;
}

/**
 * Vérifie que DATABASE_URL désigne une base de CE poste. Le motif de refus ne contient jamais la valeur (mot de passe).
 * Les paramètres `host` et `hostaddr` de l'adresse peuvent remplacer l'hôte (pg garde la DERNIÈRE occurrence) : TOUTES leurs
 * occurrences sont contrôlées, chacune doit être locale (un chemin de socket Unix, qui commence par « / », est local).
 */
export function checkLocalDatabaseUrl(databaseUrl: string): { ok: true } | { ok: false; reason: string } {
  const refusal = {
    ok: false as const,
    reason:
      "DATABASE_URL doit désigner une base de CE poste (127.0.0.1, localhost ou ::1) : dev:try n'envoie rien vers une base distante.",
  };
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    return refusal;
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") return refusal;
  const localHost = (value: string) => LOCAL_DATABASE_HOSTS.has(value.toLowerCase()) || value.startsWith("/");
  // TOUTES les occurrences comptent : pg-connection-string garde la DERNIÈRE (?host=127.0.0.1&host=db.example.com se connecte ailleurs).
  const overrides = [...url.searchParams.getAll("host"), ...url.searchParams.getAll("hostaddr")];
  if (url.hostname === "") {
    // Connexion par socket Unix : adresse sans hôte et paramètre `host` désignant un dossier.
    if (overrides.length === 0 || !overrides.every(localHost)) return refusal;
  } else if (!LOCAL_DATABASE_HOSTS.has(url.hostname.toLowerCase())) {
    return refusal;
  }
  if (!overrides.every(localHost)) return refusal;
  return { ok: true };
}

/**
 * Lot SMS1 : dev:try n'envoie JAMAIS de vrai SMS.
 *  - NOMA_SMS_PROVIDER absent ou différent de « meno » : le fournisseur et sa clé sont RETIRÉS de l'environnement du serveur (une clé présente dans votre terminal n'est jamais transmise) ;
 *  - NOMA_SMS_PROVIDER=meno : accepté UNIQUEMENT vers un faux serveur de ce poste (NOMA_SMS_BASE_URL sur 127.0.0.1, localhost ou ::1, et une clé de format valide) ; le transport
 *    console est alors retiré (le code part par SMS vers le faux serveur) et NOMA_PUBLIC_URL est l'origine du relais.
 */
function prepareSmsEnvironment(
  env: DevTryEnvironment,
  publicOrigin: string,
): { ok: true; set: Record<string, string>; unset: string[]; mode: "console" | "meno-local" } | { ok: false; reason: string } {
  const provider = (env.NOMA_SMS_PROVIDER ?? "").trim();
  if (provider !== "meno") {
    return { ok: true, set: {}, unset: ["NOMA_SMS_PROVIDER", "NOMA_SMS_API_KEY", "NOMA_SMS_BASE_URL"], mode: "console" };
  }
  const config = readSmsConfig(env);
  if ((env.NOMA_SMS_BASE_URL ?? "").trim() === "" || !config.baseUrlValid || !config.baseUrlLocal || !isValidSmsApiKey(config.apiKey)) {
    return {
      ok: false,
      reason:
        "dev:try n'envoie jamais de vrai SMS : avec NOMA_SMS_PROVIDER=meno, NOMA_SMS_BASE_URL doit désigner un faux serveur de CE poste (127.0.0.1, localhost ou ::1) " +
        "et NOMA_SMS_API_KEY une clé d'essai de format valide.",
    };
  }
  return {
    ok: true,
    set: { NOMA_SMS_PROVIDER: "meno", NOMA_SMS_API_KEY: config.apiKey as string, NOMA_SMS_BASE_URL: config.baseUrl, NOMA_PUBLIC_URL: publicOrigin },
    unset: ["NOMA_DEV_OTP_CONSOLE", "NOMA_DEV_NOTIFY_CONSOLE"],
    mode: "meno-local",
  };
}

/**
 * Prépare l'environnement de `dev:full` à partir de l'environnement de lancement (AUCUN fichier .env* n'est lu ici).
 * `random` est injectable (tests). Refus (reason en français, sans valeur secrète) : NODE_ENV défini et différent de
 * « development », DATABASE_URL absent ou distant, secret fourni mais invalide, port invalide.
 */
export function prepareDevTry(
  env: DevTryEnvironment,
  random: (bytes: number) => Buffer = randomBytes,
): DevTryPreparation {
  // Même règle que le relais (fonction partagée) : NODE_ENV absent, vide ou exactement « development ».
  const nodeEnv = checkDevelopmentNodeEnv(env.NODE_ENV);
  if (!nodeEnv.ok) {
    return {
      ok: false,
      reason:
        `NODE_ENV vaut « ${nodeEnv.received} » : dev:try ne démarre jamais hors développement (le code de connexion ` +
        "s'afficherait dans le terminal). Retirez NODE_ENV de l'environnement ou mettez NODE_ENV=development.",
    };
  }
  const databaseUrl = env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    return {
      ok: false,
      reason:
        "DATABASE_URL est obligatoire dans l'environnement de lancement : indiquez la base de données à utiliser (aucune valeur " +
        "par défaut, et les fichiers .env* ne sont pas lus pour la choisir à votre place). Voir ESSAYER.md.",
    };
  }
  const localDatabase = checkLocalDatabaseUrl(databaseUrl);
  if (!localDatabase.ok) return { ok: false, reason: localDatabase.reason };
  const proxyPort = validPort(env.NOMA_DEV_TRY_PORT, DEV_TRY_PROXY_PORT);
  const nextPort = validPort(env.NOMA_DEV_TRY_NEXT_PORT, DEV_TRY_NEXT_PORT);
  if (proxyPort === null || nextPort === null) {
    return { ok: false, reason: "NOMA_DEV_TRY_PORT et NOMA_DEV_TRY_NEXT_PORT doivent être des entiers de 1 à 65535." };
  }
  if (proxyPort === nextPort) return { ok: false, reason: "Le relais et Next ne peuvent pas utiliser le même port." };

  const warnings: string[] = [];
  const givenAuthSecret = env.NOMA_AUTH_SECRET?.trim();
  let authSecret: string;
  if (givenAuthSecret) {
    if (!isValidAuthSecret(givenAuthSecret)) {
      return { ok: false, reason: "NOMA_AUTH_SECRET doit être un secret base64 valide d'au moins 32 octets (openssl rand -base64 32)." };
    }
    authSecret = givenAuthSecret;
  } else {
    authSecret = random(32).toString("base64");
    warnings.push(
      "NOMA_AUTH_SECRET n'est pas défini : un secret temporaire est généré. Les sessions ne survivent pas à un redémarrage.",
    );
  }

  const givenProxySecret = (env.NOMA_AUTH_PROXY_SECRET ?? env.NOMA_PROXY_SECRET)?.trim();
  let proxySecret: string;
  if (givenProxySecret) {
    if (Buffer.byteLength(givenProxySecret, "utf8") < DEV_PROXY_MIN_SECRET_BYTES) {
      return { ok: false, reason: `NOMA_AUTH_PROXY_SECRET doit contenir au moins ${DEV_PROXY_MIN_SECRET_BYTES} octets.` };
    }
    proxySecret = givenProxySecret;
  } else {
    proxySecret = random(32).toString("base64url");
    warnings.push("NOMA_AUTH_PROXY_SECRET n'est pas défini : un secret temporaire est généré pour cette session.");
  }

  // Prestataire de paiement FICTIF (lot P2) : le secret signe les événements simulés ; ≥ 32 octets (la règle de
  // lib/server/wallet/fake-provider.ts), jamais affiché, ni dans un avertissement ni dans un refus.
  const givenFakePaymentSecret = env.NOMA_FAKE_PAYMENT_SECRET?.trim();
  let fakePaymentSecret: string;
  if (givenFakePaymentSecret) {
    if (Buffer.byteLength(givenFakePaymentSecret, "utf8") < FAKE_PAYMENT_MIN_SECRET_BYTES) {
      return {
        ok: false,
        reason: `NOMA_FAKE_PAYMENT_SECRET doit contenir au moins ${FAKE_PAYMENT_MIN_SECRET_BYTES} octets (ou être retiré : un secret temporaire est alors généré).`,
      };
    }
    fakePaymentSecret = givenFakePaymentSecret;
  } else {
    fakePaymentSecret = random(32).toString("base64url");
  }

  const publicOrigin = `http://localhost:${proxyPort}`;
  const sms = prepareSmsEnvironment(env, publicOrigin);
  if (!sms.ok) return { ok: false, reason: sms.reason };
  const planEnv: NodeJS.ProcessEnv = {
    ...env,
    NODE_ENV: "development",
    NOMA_DEV_OTP_CONSOLE: "1",
    NOMA_DEV_PROXY: "1",
    // Montage entièrement simulé : la recherche rapide ne contacte jamais de vrai site (le route n'active les fausses
    // sources que si le captcha est désactivé hors production), n'appelle aucune IA et n'exige aucun captcha.
    NOMA_FAKE_SOURCES: "1",
    NOMA_AI_DISABLED: "1",
    NOMA_TURNSTILE_DISABLED: "1",
    // Recharge par le prestataire fictif (page « paiement simulé ») : toujours actif ici, quoi que dise l'environnement.
    NOMA_FAKE_PAYMENTS: "1",
    NOMA_FAKE_PAYMENT_SECRET: fakePaymentSecret,
    // Collecte d'annonces d'autres sites par les connecteurs FICTIFS (aucun réseau sortant, développement seulement) : toujours active ici, comme les fausses sources et les faux paiements.
    // Sans elle, la recherche active payante (lot RA1) est « pas encore disponible » (aucune annonce externe n'est collectée) et le montage d'essai ne pourrait pas la montrer.
    NOMA_EXTERNAL_FAKE: "1",
    NOMA_AUTH_ORIGIN: publicOrigin,
    NOMA_AUTH_SECRET: authSecret,
    NOMA_AUTH_PROXY_SECRET: proxySecret,
    // La recherche anonyme (POST /api/search) lit le même secret sous un autre nom : une seule valeur pour le relais.
    NOMA_PROXY_SECRET: proxySecret,
    PORT: String(nextPort),
  };
  // Lot SMS1 : fournisseur SMS retiré (aucun vrai SMS), ou faux serveur local ; dans ce cas le transport console est retiré.
  for (const name of sms.unset) delete planEnv[name];
  Object.assign(planEnv, sms.set);
  if (sms.mode === "meno-local") {
    warnings.push("NOMA_SMS_PROVIDER=meno vers un faux serveur de ce poste : le code de connexion part par SMS simulé, il n'apparaît pas dans ce terminal.");
  }
  return {
    ok: true,
    plan: {
      env: planEnv,
      nextPort,
      proxyPort,
      publicOrigin,
      warnings,
      smsMode: sms.mode,
    },
  };
}

export interface NextDevLock {
  pid: number | null;
  port: number | null;
}

/** Contenu de `.next/dev/lock` (écrit par `next dev`), ou null s'il est absent ou illisible. */
export function readNextDevLock(dir: string): NextDevLock | null {
  const path = join(dir, ".next", "dev", "lock");
  if (!existsSync(path)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    const record = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
    const pid = typeof record.pid === "number" && Number.isInteger(record.pid) && record.pid > 0 ? record.pid : null;
    const port = typeof record.port === "number" && Number.isInteger(record.port) ? record.port : null;
    return { pid, port };
  } catch {
    return { pid: null, port: null };
  }
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM : le processus existe mais n'est pas à nous ; ESRCH : il n'existe plus.
    return (error as { code?: string }).code === "EPERM";
  }
}

/** Message de refus si un AUTRE `next dev` tient le verrou de ce dossier ; null sinon (verrou absent ou périmé). */
export function devLockMessage(
  lock: NextDevLock | null,
  alive: (pid: number) => boolean = isProcessAlive,
): string | null {
  if (!lock) return null;
  // Verrou illisible : par prudence on refuse ; verrou d'un processus disparu : périmé, Next le reprend.
  if (lock.pid !== null && !alive(lock.pid)) return null;
  const where = lock.port === null ? "" : ` (port ${lock.port})`;
  return `Un serveur next dev tourne déjà dans ce dossier${where} : arrêtez-le ou utilisez une copie.`;
}

/** Vrai si personne n'écoute le port sur la boucle locale (IPv4 et IPv6). */
export async function isPortFree(port: number): Promise<boolean> {
  const tryListen = (host: string) =>
    new Promise<boolean>((resolveTry) => {
      const server = net.createServer();
      server.once("error", (error: NodeJS.ErrnoException) => {
        // EADDRNOTAVAIL : pas d'IPv6 sur ce poste, rien à vérifier de ce côté.
        resolveTry(error.code === "EADDRNOTAVAIL");
      });
      server.listen(port, host, () => server.close(() => resolveTry(true)));
    });
  return (await tryListen("127.0.0.1")) && (await tryListen("::1"));
}

async function waitForServer(port: number, stopped: () => boolean): Promise<boolean> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline && !stopped()) {
    const ready = await new Promise<boolean>((resolveProbe) => {
      const socket = net.connect({ host: "127.0.0.1", port }, () => {
        socket.destroy();
        resolveProbe(true);
      });
      socket.once("error", () => resolveProbe(false));
    });
    if (ready) return true;
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  }
  return false;
}

const log = (line: string) => console.log(`[dev:try] ${line}`);
const fail = (line: string): void => {
  console.error(`[dev:try] ${line}`);
  process.exitCode = 1;
};

/** Racine du projet : le dossier qui contient `scripts/` (`npm run dev:try` s'y exécute toujours). */
export function projectRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

async function main(): Promise<void> {
  const root = projectRoot();
  // DATABASE_URL (et NODE_ENV) sont contrôlés AVANT toute autre lecture : aucun fichier .env* ne choisit la base à votre place.
  const prepared = prepareDevTry(process.env);
  if (!prepared.ok) return fail(prepared.reason);
  const { plan } = prepared;

  const lockMessage = devLockMessage(readNextDevLock(process.env.NOMA_DEV_TRY_LOCK_DIR?.trim() || root));
  if (lockMessage) return fail(lockMessage);
  for (const port of [plan.nextPort, plan.proxyPort]) {
    if (!(await isPortFree(port))) {
      return fail(`Le port ${port} est déjà utilisé : arrêtez le programme qui l'occupe, puis relancez.`);
    }
  }
  for (const warning of plan.warnings) log(`Attention : ${warning}`);

  const proxy = createDevProxy({
    target: `http://127.0.0.1:${plan.nextPort}`,
    secret: plan.env.NOMA_AUTH_PROXY_SECRET as string,
    port: plan.proxyPort,
    publicOrigin: plan.publicOrigin,
    log: (line) => log(`relais : ${line}`),
  });
  try {
    await proxy.listen();
  } catch {
    return fail(`Impossible d'ouvrir le port ${plan.proxyPort} : relancez après avoir libéré ce port.`);
  }

  let shuttingDown = false;
  let ending = false;
  let unexpected = false;
  const children: ChildProcess[] = [];
  let killTimer: NodeJS.Timeout | undefined;
  const stop = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    log("Arrêt en cours…");
    for (const child of children) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
    }
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  // Le relais s'arrête ou échoue en cours de route : tout s'arrête aussitôt (pas de serveur sans relais).
  const relayLost = () => {
    if (ending || shuttingDown) return;
    unexpected = true;
    console.error("[dev:try] Le relais s'est arrêté de façon inattendue : arrêt de tout.");
    stop();
  };
  proxy.server.on("close", relayLost);
  proxy.server.on("error", relayLost);

  log("Démarrage de Next (port " + plan.nextPort + ") et du worker de matching…");
  const devFull = spawn(
    process.execPath,
    ["--import", "./poc/node_modules/tsx/dist/loader.mjs", "scripts/dev-full.ts"],
    { cwd: root, env: plan.env, stdio: "inherit" },
  );
  children.push(devFull);
  let devFullDone = false;
  const exited = new Promise<number>((resolveExit) => {
    devFull.on("exit", (code, signal) => {
      devFullDone = true;
      resolveExit(signal ? 0 : (code ?? 1));
    });
    devFull.on("error", () => {
      devFullDone = true;
      resolveExit(1);
    });
  });

  // L'attente de Next s'arrête dès que dev:full se termine (démarrage raté) ou qu'on arrête tout : jamais 180 s pour rien.
  void waitForServer(plan.nextPort, () => shuttingDown || devFullDone).then((ready) => {
    if (shuttingDown || devFullDone) return;
    if (!ready) {
      log("Le serveur met du temps à démarrer : surveillez les messages ci-dessus.");
      return;
    }
    console.log("");
    console.log("══════════════════════════════════════════════════════════════");
    console.log(" noma est prêt. Ouvrez cette adresse dans votre navigateur :");
    console.log("");
    console.log(`     ${plan.publicOrigin}`);
    console.log("");
    console.log(` (Utilisez bien le port ${plan.proxyPort}, et non le port ${plan.nextPort}.)`);
    if (plan.smsMode === "meno-local") {
      console.log(" Le code de connexion part par SMS vers le FAUX serveur SMS de ce poste (aucun vrai SMS).");
    } else {
      console.log(" Le code de connexion à 6 chiffres s'affichera dans CE terminal,");
      console.log(" sur une ligne « [auth:dev] code OTP pour … » (aucun SMS n'est envoyé).");
    }
    console.log(" La recherche rapide montre des résultats d'exemple (aucun vrai site n'est contacté).");
    console.log(" La recharge du porte-monnaie est SIMULÉE : aucun argent réel, aucun paiement.");
    console.log(" Pour tout arrêter : Ctrl+C.");
    console.log("══════════════════════════════════════════════════════════════");
    console.log("");
  });

  const code = await exited;
  if (killTimer) clearTimeout(killTimer);
  const stoppedOnPurpose = shuttingDown && !unexpected;
  if (!stoppedOnPurpose) {
    // dev:full (Next ou worker) s'est arrêté sans qu'on le demande : on ne laisse rien tourner et on le dit clairement.
    shuttingDown = true;
    console.error(
      `[dev:try] Le serveur s'est arrêté de façon inattendue (code ${code}) : voir les messages ci-dessus. Tout a été arrêté.`,
    );
  }
  ending = true;
  await proxy.close();
  process.exitCode = stoppedOnPurpose ? 0 : 1;
}

// Exécution directe seulement (les tests importent ce module sans rien démarrer).
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    console.error("[dev:try] erreur inattendue.");
    process.exitCode = 1;
  });
}
